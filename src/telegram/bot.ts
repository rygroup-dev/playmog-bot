import { Bot, InlineKeyboard, Keyboard, type Context } from "grammy";
import { randomInt } from "node:crypto";
import { formatUnits, parseEther } from "viem";
import { arbitrum, robinhood } from "viem/chains";
import type { PrivateKeyAccount } from "viem/accounts";
import { Store, type Settings } from "../db.js";
import { MogApi } from "../mog/api.js";
import { AbstractOps } from "../chain/abstract.js";
import { ABS, NATIVE, publicClient } from "../chain/chains.js";
import { getQuote, executeQuote, type Quote } from "../chain/relay.js";
import { snapshot, type Snapshot } from "../services/account.js";
import { Autopilot } from "../services/autopilot.js";
import { ClaimsService } from "../services/claims.js";
import { MarketMaker } from "../services/market.js";
import { esc, num, usd, header, section, row, on, check, bar, ago, until, utcNow, shortAddr, pre, footer } from "./ui.js";

type View = { text: string; kb: InlineKeyboard };
const MODE_LABEL: Record<string, string> = { EXPEDITION: "EXP", NORMAL: "ARC", WORLD: "WLD" };

/** Bottom (reply) keyboard — always visible, the "menu button" the owner asked for. */
const MENU_BUTTONS = {
  dash: "📊 Dashboard", run: "🎮 Run", wallet: "💰 Wallet", keys: "🗝 Keys",
  claims: "🎁 Klaim", hist: "📜 Riwayat", lb: "🏆 Leaderboard", set: "⚙️ Setting", menu: "🧭 Menu", help: "❓ Bantuan",
} as const;
const replyKb = () => new Keyboard()
  .text(MENU_BUTTONS.dash).text(MENU_BUTTONS.run).row()
  .text(MENU_BUTTONS.wallet).text(MENU_BUTTONS.keys).row()
  .text(MENU_BUTTONS.claims).text(MENU_BUTTONS.hist).row()
  .text(MENU_BUTTONS.lb).text(MENU_BUTTONS.set).row()
  .text(MENU_BUTTONS.menu).text(MENU_BUTTONS.help)
  .resized().persistent().placeholder("Pilih menu…");

export const BOT_COMMANDS = [
  { command: "menu", description: "🧭 Menu utama" },
  { command: "dash", description: "📊 Dashboard lengkap" },
  { command: "run", description: "🎮 Status run live" },
  { command: "wallet", description: "💰 Wallet, swap & bridge" },
  { command: "keys", description: "🗝 Arcade & Expedition key" },
  { command: "claims", description: "🎁 Klaim harian, payout, jackpot, tarik VALOR" },
  { command: "pass", description: "🎫 Expedition Pass & perpanjang" },
  { command: "market", description: "📈 Market-making: P&L, order, item terpilih" },
  { command: "history", description: "📜 Riwayat run & transaksi" },
  { command: "lb", description: "🏆 Leaderboard" },
  { command: "settings", description: "⚙️ Pengaturan autopilot" },
  { command: "pause", description: "⏸ Kill-switch (pause/resume)" },
  { command: "help", description: "❓ Panduan" },
];
export const BOT_SHORT_DESCRIPTION = "🧭 Autopilot Maze of Gains (playmog.xyz) — main otomatis, klaim harian, swap, dashboard live.";
export const BOT_DESCRIPTION = [
  "🧭 MoG Autopilot — bot privat untuk Maze of Gains (Onchain Heroes, Abstract chain).",
  "",
  "🎮 Main Expedition/Arcade otomatis, baca telegraph musuh langsung dari server",
  "🎁 Klaim key harian pass + upvote mingguan otomatis",
  "📊 Dashboard live: wallet, VALOR, pool mingguan, EV Arcade, leaderboard",
  "💱 Swap ETH↔USDC.e & bridge Arbitrum/Robinhood → Abstract",
  "🛡 Hanya pemilik; setiap belanja wajib konfirmasi; kill-switch 1 tombol",
].join("\n");

export function createBot(opts: { token: string; store: Store; api: MogApi; abs: AbstractOps; account: PrivateKeyAccount; autopilot: Autopilot; claims: ClaimsService; market: MarketMaker; envOwners: number[]; log: (m: string) => void }) {
  const { store, api, abs, account, autopilot, claims, market, log } = opts;
  const bot = new Bot(opts.token);
  let claimCode: string | null = null;
  const pendingQuotes = new Map<string, { quote: Quote; label: string; expires: number }>();
  const pendingKeyBuys = new Map<string, { qty: number; expires: number }>();
  let cachedSnap: Snapshot | null = null;

  const isOwner = (id?: number) => !!id && (opts.envOwners.includes(id) || store.owners().includes(id));
  const ensureClaimCode = () => {
    if (store.owners().length || opts.envOwners.length) return null;
    if (!claimCode) { claimCode = String(randomInt(100000, 999999)); log(`OWNER CLAIM CODE: ${claimCode}  (send /claim ${claimCode} to the bot)`); }
    return claimCode;
  };
  async function snap(maxAgeMs = 15_000) {
    if (cachedSnap && Date.now() - cachedSnap.at < maxAgeMs) return cachedSnap;
    cachedSnap = await snapshot(api, abs, store.arcadeTreasurePerKey()?.perKey ?? null); return cachedSnap;
  }
  const nav = (kb: InlineKeyboard, refresh?: string) => {
    const rows = kb.inline_keyboard; if (rows.length && rows[rows.length - 1].length) kb.row(); // never emit empty rows
    if (refresh) kb.text("🔄 Refresh", refresh);
    return kb.text("🧭 Menu", "v:menu");
  };
  const dailyLine = (p: any) => `${p.dailyClaimedToday}/${p.dailyClaimedToday + p.dailyClaimable} diklaim hari ini${p.dailyClaimable > 0 ? ` · <b>${p.dailyClaimable} siap</b>` : ""} · drop berikut ${until(p.dailyNextDropAt)}`;

  bot.catch((err) => { log(`telegram error: ${err.error instanceof Error ? err.error.message : String(err.error)}`); });

  // ---------------- auth ----------------
  bot.command("start", async (ctx) => {
    if (isOwner(ctx.from?.id)) {
      await ctx.reply(`👋 Selamat datang kembali, <b>${esc(ctx.from?.first_name ?? "Boss")}</b>.\nBuka menu kapan saja lewat tombol <b>Menu</b> di samping kolom chat.`, { parse_mode: "HTML", reply_markup: { remove_keyboard: true } });
      return send(ctx, await vMenu(), "menu");
    }
    ensureClaimCode();
    await ctx.reply(`${header("🔒", "Bot Privat")}\nChat ID kamu: <code>${ctx.from?.id}</code>\nKalau kamu pemiliknya, kirim <code>/claim KODE</code> (kode ada di log server).`, { parse_mode: "HTML" });
  });
  bot.command("claim", async (ctx) => {
    const code = ctx.match?.trim();
    if (!ctx.from || !claimCode || code !== claimCode) { await ctx.reply("❌ Kode salah / tidak berlaku."); return; }
    store.addOwner(ctx.from.id); claimCode = null;
    store.event("info", `owner claimed: ${ctx.from.id}`);
    await ctx.reply("✅ Kamu sekarang pemilik bot ini.", { reply_markup: { remove_keyboard: true } });
    await send(ctx, await vMenu());
  });
  bot.use(async (ctx, next) => {
    if (!isOwner(ctx.from?.id)) { if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Tidak diizinkan" }); return; }
    await next();
  });

  // ---------------- rendering ----------------
  async function send(ctx: Context, v: View, view?: string) {
    const liveOn = !!view && LIVE_VIEWS.has(view);
    const out = liveOn ? decorate(v, true, view!) : v;
    const m = await ctx.reply(out.text, { parse_mode: "HTML", reply_markup: out.kb, link_preview_options: { is_disabled: true } });
    if (liveOn && ctx.chat) startLive(ctx.chat.id, m.message_id, view!); else if (ctx.chat) stopLive(ctx.chat.id);
  }
  async function edit(ctx: Context, v: View, view?: string) {
    const liveOn = !!view && LIVE_VIEWS.has(view);
    const out = liveOn ? decorate(v, true, view!) : v;
    const msg = ctx.callbackQuery?.message;
    if (msg) {
      try { await ctx.editMessageText(out.text, { parse_mode: "HTML", reply_markup: out.kb, link_preview_options: { is_disabled: true } }); }
      catch (e: any) { if (!/not modified/.test(e?.message ?? "")) { await send(ctx, v, view); return; } }
      if (ctx.chat) { if (liveOn) startLive(ctx.chat.id, msg.message_id, view!); else stopLive(ctx.chat.id); }
      return;
    }
    await send(ctx, v, view);
  }

  // ---------------- live auto-refresh ----------------
  // One live message per chat: re-rendered every LIVE_MS while fresh, edited only when content changed.
  const LIVE_MS = 10_000, LIVE_WINDOW_MS = 15 * 60_000;
  const LIVE_VIEWS = new Set(["menu", "dash", "run", "market", "claims", "wallet", "keys"]);
  const live = new Map<number, { messageId: number; view: string; until: number; last: string; timer: NodeJS.Timeout; busy: boolean }>();
  const stopLive = (chatId: number) => { const l = live.get(chatId); if (l) { clearInterval(l.timer); live.delete(chatId); } };
  const liveBadge = (on: boolean) => on ? `🔴 <b>LIVE</b> · update tiap ${LIVE_MS / 1000} dtk · ${new Date().toISOString().slice(11, 19)} UTC` : "⏸ <i>Live dijeda — tekan ▶️ Live untuk lanjut</i>";
  function decorate(v: View, liveOn: boolean, view: string): View {
    const kb = new InlineKeyboard(v.kb.inline_keyboard.map((r) => [...r]));
    kb.row().text(liveOn ? "⏹ Stop live" : "▶️ Live", liveOn ? "live:stop" : `live:start:${view}`);
    return { text: `${v.text}\n\n${liveBadge(liveOn)}`, kb };
  }
  function startLive(chatId: number, messageId: number, view: string) {
    stopLive(chatId);
    if (!LIVE_VIEWS.has(view)) return;
    const session = { messageId, view, until: Date.now() + LIVE_WINDOW_MS, last: "", busy: false, timer: setInterval(async () => {
      const l = live.get(chatId); if (!l || l.busy) return;
      l.busy = true;
      try {
        const on = Date.now() < l.until;
        const v = decorate(await views[l.view](), on, l.view);
        const body = v.text.replace(/\d{2}:\d{2}:\d{2} UTC/, ""); // ignore the clock when checking for changes
        if (body !== l.last || !on) {
          l.last = body;
          await bot.api.editMessageText(chatId, l.messageId, v.text, { parse_mode: "HTML", reply_markup: v.kb, link_preview_options: { is_disabled: true } });
        }
        if (!on) stopLive(chatId);
      } catch (e: any) {
        const m = String(e?.description ?? e?.message ?? e);
        if (/not modified/.test(m)) { /* same content */ }
        else if (/retry after (\d+)/i.test(m)) { const sec = Number(m.match(/retry after (\d+)/i)![1]); l.busy = true; setTimeout(() => { l.busy = false; }, sec * 1000); return; }
        else if (/message to edit not found|message can't be edited|chat not found|blocked/i.test(m)) stopLive(chatId);
        else log(`live refresh: ${m}`);
      } finally { const l2 = live.get(chatId); if (l2) l2.busy = false; }
    }, LIVE_MS) };
    live.set(chatId, session);
  }

  // ---------------- views ----------------
  async function vMenu(): Promise<View> {
    const st = store.settings(); const r = autopilot.running; const s = await snap(60_000).catch(() => null);
    const lines = [
      header("🧭", "MoG AUTOPILOT", utcNow()),
      `${st.paused ? "⏸ <b>PAUSED</b> — autopilot berhenti" : "🟢 <b>AKTIF</b>"} · tick ${ago(autopilot.lastTickAt)}`,
      `👛 <code>${shortAddr(account.address)}</code> · 🎫 ${s?.pass?.isActive ? `<b>${s.pass.tier}</b> (${until(s.pass.expiresAt)})` : "tanpa pass"}`,
      s ? `💵 ${s.wallet?.usdc ?? "?"} USDC.e · ⛽ ${s.wallet?.eth ?? "?"} ETH · 🗝 ${s.keys ?? 0} arcade / ${s.expKeys ?? 0} expedition` : "",
      section("Run"),
      r ? `  🎮 ${r.runType} · floor <b>${r.floor ?? "?"}</b> · 💎 ${num(r.treasure)}\n  ⚡ ${bar(r.energy ?? 0, 100)} ${r.energy ?? "?"}` : "  💤 Tidak ada run berjalan",
      autopilot.lastError ? `\n⚠️ <i>${esc(autopilot.lastError).slice(0, 180)}</i>` : "",
    ];
    const kb = new InlineKeyboard()
      .text("📊 Dashboard", "v:dash").text("🎮 Run", "v:run").row()
      .text("💰 Wallet & Swap", "v:wallet").text("🗝 Keys", "v:keys").row()
      .text("🎁 Klaim", "v:claims").text("📜 Riwayat", "v:hist").row()
      .text("🏆 Leaderboard", "v:lb").text("🎫 Pass", "v:pass").row()
      .text("📈 Market", "v:market").row()
      .text("⚙️ Setting", "v:set").text("❓ Bantuan", "v:help").row()
      .text(st.paused ? "▶️ RESUME AUTOPILOT" : "⏸ PAUSE (kill-switch)", "a:togglePause").text("🔄", "v:menu");
    return { text: lines.filter(Boolean).join("\n"), kb };
  }

  async function vDash(): Promise<View> {
    const s = await snap(8_000); const st = store.settings();
    const pass = s.pass; const cw = s.claims?.currentWeek; const it = s.items ?? {};
    const since = Date.now() - 24 * 3600e3;
    const day = store.runStatsSince(since);
    const spent24 = store.spentSince(since, ["buy_keys", "pass", "swap_fee"]);
    const passTotal = pass?.startsAt && pass?.expiresAt ? new Date(pass.expiresAt).getTime() - new Date(pass.startsAt).getTime() : 0;
    const passLeft = pass?.expiresAt ? new Date(pass.expiresAt).getTime() - Date.now() : 0;
    const ev = s.pool?.usdPerKeyEst ?? 0;
    const extraItems = Object.entries(it).filter(([k]) => !["key.expedition", "item.golden_corn"].includes(k));
    const lines = [
      header("📊", "DASHBOARD", utcNow()),
      section("💰 Wallet"),
      row("Abstract", `<b>${s.wallet?.usdc ?? "?"}</b> USDC.e · <b>${s.wallet?.eth ?? "?"}</b> ETH`),
      row("VALOR", `<b>${num(s.valor)}</b> (≈${usd((s.valor ?? 0) / 100)})`),
      row("Arbitrum / Robinhood", `${s.wallet?.arbEth ?? "-"} / ${s.wallet?.rhEth ?? "-"} ETH`),
      section("🎫 Expedition Pass"),
      pass?.isActive
        ? `  ${bar(passLeft, passTotal)} <b>${pass.tier}</b> · sisa ${until(pass.expiresAt)}\n` + row("Key harian", dailyLine(pass))
        : `  ⚫️ Tidak aktif${pass?.lastTier ? ` (terakhir ${pass.lastTier})` : ""}`,
      section("🗝 Inventory"),
      row("Arcade key", `<b>${s.keys ?? "?"}</b>`), row("Expedition key", `<b>${s.expKeys ?? "?"}</b>`), row("Golden Corn", `<b>${num(it["item.golden_corn"])}</b>`),
      ...extraItems.map(([k, v]) => row(esc(k), num(v))),
      row("Upvote", s.upvote?.claimed ? `✅ epoch ${s.upvote.epoch}` : `⏳ +${s.upvote?.reward ?? "?"} key tersedia`) + ` · reset ${until(s.upvote?.epochEndsAtIso)}`,
      section(`📈 Minggu ${cw?.weekNumber ?? "?"} · reset ${until(cw?.weekEnd)}`),
      row("Treasure / Marbles", `${num(cw?.userTreasure)} / ${num(cw?.userMarbles)}`),
      row("Proyeksi payout", `${num(Number(cw?.projectedPayout ?? 0))} VALOR`),
      s.pool ? row("Pool", `${usd(s.pool.poolValor / 100, 0)} ÷ ${num(s.pool.totalTreasure)} treasure`) : "",
      s.pool ? row("EV Arcade (bot kita)", `<b>${usd(ev)}</b> / $1 key  ${bar(ev, 1.2, 8)} ${ev >= st.minPoolEvPerKey ? "🟢" : "🔴 di bawah ambang"}`) : "",
      s.pool ? row("EV pemain top", `${usd(s.pool.usdPerKeyTop)} · bot kita ${s.pool.ownTreasurePerKey ? num(s.pool.ownTreasurePerKey) : "?"} treasure/key`) : "",
      row("Earnings total", `${num(Number(s.earnings?.totalValor ?? 0))} VALOR`),
      s.expRun ? row("Expedition best", `💎 ${num(s.expRun.treasure)} · rank <b>#${s.expRun.rank}</b>`) : "",
      section("🤖 Autopilot 24 jam"),
      day.length ? pre(["MODE        RUN  TREASURE  MARBLE  BEST", ...day.map((r) => `${String(r.run_type).padEnd(10)} ${String(r.n).padStart(4)} ${String(r.treasure ?? 0).padStart(9)} ${String(r.marbles ?? 0).padStart(7)}  ${r.best} f${r.best_floor}`)]) : "  belum ada run",
      row("Belanja 24j", `${usd(spent24)} (cap Arcade ${usd(st.arcadeDailyUsdCap, 0)})`),
      row("Auto", `harian ${check(st.autoDaily)} upvote ${check(st.autoUpvote)} expedition ${check(st.autoExpedition)} arcade ${check(st.autoArcade)}`),
      s.errors.length ? `\n⚠️ <i>${esc(s.errors.join(" | ")).slice(0, 300)}</i>` : "",
    ];
    return { text: lines.filter((l) => l !== "").join("\n"), kb: nav(new InlineKeyboard().text("🎮 Run", "v:run").text("🎁 Klaim", "v:claims"), "v:dash") };
  }

  async function vRun(): Promise<View> {
    const r = autopilot.running; const s = await snap(30_000);
    const recent = store.recentRuns(1)[0];
    const lines = [header("🎮", "RUN", r ? "LIVE" : "idle")];
    if (r) {
      lines.push(
        row("Mode", `<b>${r.runType}</b> · <code>${r.runId.slice(-8)}</code>`), row("Mulai", ago(r.startedAt)),
        row("Floor", `<b>${r.floor ?? "?"}</b>`), row("Energy", `${bar(r.energy ?? 0, 100)} <b>${r.energy ?? "?"}</b>`),
        row("Treasure", `💎 <b>${num(r.treasure)}</b>`), row("Aksi terakhir", `<i>${esc(r.last ?? "-")}</i>`));
    } else lines.push("  💤 Tidak ada run berjalan.");
    const eve = s.items?.["key.world"] ?? 0;
    lines.push(section("Key"), row("Expedition", `<b>${s.expKeys ?? "?"}</b> (gratis)`), row("Arcade", `<b>${s.keys ?? "?"}</b> ($1/key)`), row("Eve Key", `<b>${eve}</b> (World's Eve)`));
    if (recent) lines.push(section("Run terakhir"), `  ${recent.run_type} · floor ${recent.floor} · 💎${num(recent.treasure)} · 🔮${recent.marbles} · 🗝${recent.arcade_keys} · ${ago(recent.ended_at)}`);
    const kb = new InlineKeyboard();
    if (r) kb.text("🛑 Stop run", "a:stopRun");
    else kb.text("▶️ Main Expedition", "a:playExp").text("🎰 Main Arcade (1 key)", "c:arcade1").row().text("🌍 Main World's Eve (1 Eve Key)", "c:world1");
    return { text: lines.join("\n"), kb: nav(kb, "v:run") };
  }

  async function vWallet(): Promise<View> {
    const s = await snap(8_000);
    const lines = [header("💰", "WALLET & SWAP"),
      `Alamat (sama di semua chain EVM):\n<code>${account.address}</code>`,
      section("Saldo"),
      row("Abstract", `<b>${s.wallet?.usdc}</b> USDC.e · <b>${s.wallet?.eth}</b> ETH`),
      row("Arbitrum", `${s.wallet?.arbEth ?? "-"} ETH`), row("Robinhood", `${s.wallet?.rhEth ?? "-"} ETH`),
      row("VALOR (in-game)", `${num(s.valor)} ≈ ${usd((s.valor ?? 0) / 100)}`),
      section("Cara isi dana"),
      "  1. Kirim ETH ke alamat di atas",
      "     (Arbitrum / Robinhood / Abstract)",
      "  2. Tekan tombol 🌉 bridge di bawah",
      "  3. Cek quote → tekan ✅ Eksekusi",
      footer("Quote berlaku 45 detik. Tidak ada transaksi tanpa konfirmasi.")];
    const kb = new InlineKeyboard()
      .text("⇄ ETH→USDC.e $5", "q:abs_eth_usdc:5").text("⇄ ETH→USDC.e $10", "q:abs_eth_usdc:10").row()
      .text("⇄ USDC.e→ETH $3", "q:abs_usdc_eth:3").text("⇄ USDC.e→ETH $5", "q:abs_usdc_eth:5").row()
      .text("🌉 Arbitrum → Abstract (semua)", "q:arb_in:all").row()
      .text("🌉 Robinhood → Abstract (semua)", "q:rh_in:all");
    return { text: lines.join("\n"), kb: nav(kb, "v:wallet") };
  }

  async function vKeys(): Promise<View> {
    const s = await snap(8_000); const st = store.settings(); const ev = s.pool?.usdPerKeyEst ?? 0;
    const lines = [header("🗝", "KEYS"),
      row("Arcade key", `<b>${s.keys}</b> · harga 1 USDC.e (fee 7% ke tim)`),
      row("Expedition key", `<b>${s.expKeys}</b> · gratis (pass harian + upvote)`),
      section("EV Arcade live"),
      `  ${bar(ev, 1.2)} <b>${usd(ev)}</b> kembali per $1 key (hasil bot kita)`,
      row("Pemain top", `${usd(s.pool?.usdPerKeyTop ?? 0)} per $1 key (~3.200 treasure/key)`),
      row("Bot kita", `${s.pool?.ownTreasurePerKey ? num(s.pool.ownTreasurePerKey) : "belum cukup data"} treasure/key`),
      row("Ambang auto", `${usd(st.minPoolEvPerKey)} ${ev >= st.minPoolEvPerKey ? "🟢 terpenuhi" : "🔴 belum"}`),
      footer("Auto-beli hanya jika EV ≥ ambang & belanja < cap harian.")];
    return { text: lines.join("\n"), kb: nav(new InlineKeyboard().text("🛒 1 key", "c:buy:1").text("🛒 3 key", "c:buy:3").text("🛒 5 key", "c:buy:5"), "v:keys") };
  }

  async function vClaims(): Promise<View> {
    const s = await snap(8_000);
    const [jackWei, pendW, corn] = await Promise.all([claims.pendingJackpotWei().catch(() => 0n), api.get("/api/shop/valor/pending").catch(() => null), claims.raffleStatus("goldenCorn").catch(() => null)]);
    const past = (s.claims?.pastWeeks ?? []).filter((w: any) => Number(w.amount) > 0 && !w.claimed);
    const quests = [...(s.quests?.daily?.quests ?? []), ...(s.quests?.weekly?.quests ?? [])];
    const lines = [header("🎁", "KLAIM & REWARD"),
      row("Key harian pass", s.pass?.isActive ? dailyLine(s.pass) : "pass tidak aktif"),
      row("Upvote mingguan", s.upvote?.claimed ? `✅ sudah (epoch ${s.upvote.epoch})` : `⏳ +${s.upvote?.reward} key`),
      row("Quest aktif", `${quests.length}`),
      ...quests.slice(0, 6).map((q: any) => `     · ${esc(q.title ?? q.questKey ?? q.key)} ${q.progress ?? ""}${q.target ? `/${q.target}` : ""}`),
      row("Payout mingguan tertunda", past.length ? past.map((w: any) => `w${w.weekNumber}: ${num(Number(w.amount))}`).join(", ") : "tidak ada"),
      section("🌽 Golden Corn → undian WL Yield Fields"),
      corn ? row("Tiket", `${num(corn.ticketBalance)} siap · ${num(corn.userEntries)} sudah masuk · ${num(corn.globalEntries)} total global`) : row("Golden Corn", num(s.items?.["item.golden_corn"])),
      corn ? row("Peluang ≥1 WL", `≈ <b>${(corn.chanceAtLeastOne * 100).toFixed(1)}%</b> (${corn.slotPool} slot) · tutup ${until(corn.entryCloseTime)}`) : "",
      corn ? "     <i>Otomatis dimasukkan 3 jam sebelum tutup</i>" : "",
      section("🌍 World's Eve"),
      row("Worldseed", `${num(s.items?.["currency.amber"] ?? (await api.get("/api/items/amber").catch(() => ({ balance: 0 }))).balance)} · 500 = 1 cache, 2000 = premium`),
      section("💸 Uang"),
      row("Jackpot tertunda", jackWei > 0n ? `<b>${jackWei}</b>` : "tidak ada"),
      row("Saldo VALOR", `${num(s.valor)} ≈ ${usd((s.valor ?? 0) / 100)}`),
      row("Penarikan berjalan", pendW?.pending ? `${esc(pendW.pending.status)} · ${usd(Number(pendW.pending.netUsdc ?? 0) / 1e6)} · klaim ${until(pendW.pending.claimableAt)}` : "tidak ada"),
      footer("Semua klaim berjalan otomatis. Tarik VALOR: min 500, fee 5%, cair 24 jam.")];
    const kb = new InlineKeyboard().text("🎁 Klaim harian", "a:daily").text("🗳 Upvote", "a:upvote").row()
      .text("✅ Quest", "a:quests").text("🎟 Undian corn", "c:corn").row()
      .text("💸 Klaim payout+jackpot", "a:money").row()
      .text("🏦 Tarik semua VALOR → USDC", "c:withdraw").row()
      .text("🎁 Tukar worldseed → cache", "a:redeem");
    return { text: lines.join("\n"), kb: nav(kb, "v:claims") };
  }

  function vHist(): View {
    const runs = store.recentRuns(12); const led = store.recentLedger(6); const ev = store.recentEvents(8);
    const d = (ts: number) => new Date(ts).toISOString().slice(5, 16).replace("T", " ");
    const lines = [header("📜", "RIWAYAT"),
      section("Run terakhir"),
      runs.length ? pre(["WAKTU UTC    MODE FL TREASURE MB AK", ...runs.map((r) => `${d(r.ended_at)} ${(MODE_LABEL[r.run_type] ?? String(r.run_type)).padEnd(4)} ${String(r.floor).padStart(2)} ${String(r.treasure).padStart(8)} ${String(r.marbles).padStart(2)} ${String(r.arcade_keys).padStart(2)}`)]) : "  -",
      section("Transaksi"),
      led.length ? pre(["WAKTU UTC    JENIS       USD  DETAIL", ...led.map((l) => `${d(l.ts)} ${String(l.kind).padEnd(9)} ${l.usd.toFixed(2).padStart(6)}  ${String(l.detail).slice(0, 22)}`)]) : "  -",
      section("Log sistem"),
      ...ev.map((e) => `  ${e.level === "error" ? "❌" : e.level === "warn" ? "⚠️" : "•"} <i>${esc(e.msg).slice(0, 80)}</i>`)];
    return { text: lines.join("\n"), kb: nav(new InlineKeyboard(), "v:hist") };
  }

  async function vLb(): Promise<View> {
    const addr = account.address.toLowerCase();
    const [w, e] = await Promise.all([api.get(`/api/runs?mode=weekly&address=${addr}`), api.get(`/api/runs?variant=ABSTRACT&mode=expedition&sortBy=treasure&address=${addr}`)]);
    const medal = (i: number) => ["🥇", "🥈", "🥉"][i] ?? ` ${i + 1}.`;
    const lines = [header("🏆", "LEADERBOARD"),
      section("Arcade mingguan (pool USDC)"),
      ...(w.leaderboard ?? []).slice(0, 5).map((x: any, i: number) => `  ${medal(i)} ${esc(x.username ?? shortAddr(x.address))} · 💎${num(x.treasure)} · ${x.totalKeysSpent} key`),
      `  ➤ Kamu: <b>#${w.userStats?.rank ?? "-"}</b> · 💎${num(w.userStats?.treasure)}`,
      section("Expedition best run (hadiah Arcade key)"),
      ...(e.leaderboard ?? []).slice(0, 5).map((x: any, i: number) => `  ${medal(i)} ${esc(x.username ?? shortAddr(x.address))} · 💎${num(x.treasure)}`),
      `  ➤ Kamu: <b>#${e.userRun?.rank ?? "-"}</b> / ${num(e.total)} · 💎${num(e.userRun?.treasure)}`];
    return { text: lines.join("\n"), kb: nav(new InlineKeyboard(), "v:lb") };
  }

  function vSettings(): View {
    const st = store.settings();
    const lines = [header("⚙️", "PENGATURAN AUTOPILOT"),
      row("Klaim key harian", on(st.autoDaily)), row("Upvote mingguan", on(st.autoUpvote)),
      row("Main Expedition otomatis", `${on(st.autoExpedition)} (sisakan ${st.expeditionReserveKeys} key)`),
      row("Arcade berbayar otomatis", on(st.autoArcade)),
      `     · ${st.arcadeKeysPerRun} key/run · cap ${usd(st.arcadeDailyUsdCap, 0)}/hari · EV min ${usd(st.minPoolEvPerKey)}`,
      row("Ruang spesial", st.acceptRooms.length ? st.acceptRooms.join(", ") : "tidak (langsung turun floor)"),
      row("World's Eve otomatis", `${on(st.autoWorld)} · beli Eve Key maks ${st.worldBuysPerDay}×/hari @≤${num(st.worldKeyMaxPrice)} VALOR`),
      row("Main Arcade key gratis", `${on(st.playOwnedArcadeKeys)} (key hasil cache, tanpa beli)`),
      row("Tukar worldseed → cache", on(st.autoRedeemCaches)), row("Jual loot otomatis", `${on(st.autoSellLoot)} (Eve Key & Mint Pass disimpan)`),
      row("Tarik VALOR otomatis", `${on(st.autoWithdraw)} (sisakan ${num(st.withdrawReserveValor)} VALOR untuk pass)`),
      row("Notif tiap run", on(st.notifyEveryRun)),
      footer("Arcade hanya jalan bila EV live ≥ ambang DAN belanja 24 jam < cap.")];
    const kb = new InlineKeyboard()
      .text(`${check(st.autoDaily)} Harian`, "s:autoDaily").text(`${check(st.autoUpvote)} Upvote`, "s:autoUpvote").row()
      .text(`${check(st.autoExpedition)} Expedition`, "s:autoExpedition").text(`${check(st.autoArcade)} Arcade`, "s:autoArcade").row()
      .text("➖", "n:arcadeDailyUsdCap:-1").text(`Cap ${usd(st.arcadeDailyUsdCap, 0)}/hari`, "noop").text("➕", "n:arcadeDailyUsdCap:1").row()
      .text("➖", "n:arcadeKeysPerRun:-1").text(`${st.arcadeKeysPerRun} key/run`, "noop").text("➕", "n:arcadeKeysPerRun:1").row()
      .text("➖", "n:minPoolEvPerKey:-0.05").text(`EV ≥ ${usd(st.minPoolEvPerKey)}`, "noop").text("➕", "n:minPoolEvPerKey:0.05").row()
      .text(`${check(st.autoWorld)} World's Eve`, "s:autoWorld").text(`${check(st.autoRedeemCaches)} Tukar cache`, "s:autoRedeemCaches").row()
      .text(`${check(st.autoSellLoot)} Jual loot`, "s:autoSellLoot").text(`${check(st.playOwnedArcadeKeys)} Arcade gratis`, "s:playOwnedArcadeKeys").row()
      .text("➖", "n:worldBuysPerDay:-1").text(`Eve Key ${st.worldBuysPerDay}×/hari`, "noop").text("➕", "n:worldBuysPerDay:1").row()
      .text(`${check(st.autoWithdraw)} Tarik VALOR auto`, "s:autoWithdraw").text(`${check(st.notifyEveryRun)} Notif run`, "s:notifyEveryRun");
    return { text: lines.join("\n"), kb: nav(kb) };
  }

  async function vPass(): Promise<View> {
    const s = await snap(8_000); const p = s.pass;
    const skus: any[] = await api.get("/api/shop/skus").catch(() => []);
    const [code, ref] = await Promise.all([api.get("/api/shop/pass-code").catch(() => null), api.get("/api/shop/referral-stats").catch(() => null)]);
    const total = p?.startsAt && p?.expiresAt ? new Date(p.expiresAt).getTime() - new Date(p.startsAt).getTime() : 0;
    const left = p?.expiresAt ? new Date(p.expiresAt).getTime() - Date.now() : 0;
    const lines = [header("🎫", "EXPEDITION PASS"),
      p?.isActive ? `  ${bar(left, total)} <b>${p.tier}</b> · sisa <b>${until(p.expiresAt)}</b>` : "  ⚫️ Tidak aktif",
      row("Key harian", p?.isActive ? `${p.dailyClaimedToday}/${p.dailyClaimedToday + p.dailyClaimable}` : "-"),
      section("Manfaat"),
      "  ◦ Loot Expedition tersimpan (tanpa pass = hangus)",
      "  ◦ Key Expedition harian + upvote 5 (Basic) / 8 (VIP)",
      "  ◦ VIP: +20% marbles Arcade, semua quest, drop Arcade key lebih tinggi",
      section("Referral"),
      row("Kode kamu", code?.code ? `<code>${esc(code.code)}</code> (bagikan ke teman saat beli pass)` : "-"),
      row("Hasil", `${num(ref?.totalReferrals)} referral (${num(ref?.basicCount)} Basic · ${num(ref?.plusCount)} VIP) · ${num(Number(ref?.lifetimeValor ?? 0))} VALOR`),
      "     <i>Komisi hanya masuk selama pass kamu aktif</i>",
      section("Harga"),
      ...skus.map((k) => `  ◦ ${k.tier} ${k.weeks} minggu: <b>${usd(Number(k.salePrice ?? k.listPrice) / 1e6, 0)}</b>${k.salePrice && k.salePrice !== k.listPrice ? ` <s>${usd(Number(k.listPrice) / 1e6, 0)}</s>` : ""}`),
      footer("Dibayar dari saldo VALOR; kekurangan otomatis di-top-up dari USDC.e. Wajib konfirmasi.")];
    const kb = new InlineKeyboard();
    for (const k of skus.filter((k) => k.tier === "VIP" || k.weeks === 1)) kb.text(`${k.tier} ${k.weeks}mg ${usd(Number(k.salePrice ?? k.listPrice) / 1e6, 0)}`, `c:pass:${k.itemId}`).row();
    return { text: lines.join("\n"), kb: nav(kb, "v:pass") };
  }

  const shortName = (n: string) => n.replace(" Token", "").replace("Adventurer Mint Pass", "Mint Pass").replace(" Jackalot Helmet", " Helmet").slice(0, 15);
  async function vMarket(): Promise<View> {
    const r = await market.report(); const c = r.cfg; const st = r.state;
    const valor = Number((await api.get("/api/shop/valor/balance")).valorBalance);
    const pnl = Math.round(st.realized);
    const days = Math.max(0.01, (Date.now() - st.startedAt) / 864e5);
    const lines = [header("📈", "MARKET-MAKING PILOT", c.enabled ? (st.halted ? "HALTED" : "AKTIF") : "OFF"),
      row("Status", c.enabled ? (st.halted ? `🛑 ${esc(st.halted)}` : "🟢 berjalan tiap menit") : "⚫️ mati"),
      row("Modal", `${num(c.capitalValor)} VALOR (${usd(c.capitalValor / 100, 0)}) · saldo VALOR ${num(valor)}`),
      row("Profit terealisasi", `<b>${pnl >= 0 ? "+" : ""}${num(pnl)} VALOR</b> (${pnl >= 0 ? "+" : ""}${usd(pnl / 100)})`),
      row("Belum terealisasi", `${r.unrealized >= 0 ? "+" : ""}${num(r.unrealized)} VALOR`),
      row("Transaksi", `${st.fills} fill · ${days.toFixed(1)} hari · ≈${usd(pnl / 100 / days)}/hari`),
      section("Posisi & order"),
      ...(r.lines.length ? r.lines.flatMap((l) => [`  ◦ <b>${esc(l.name)}</b>${l.paused ? " · ⏸ jeda" : ""}`,
        `     pasar ${num(l.bid)} / ${num(l.ask)} · stok ${l.qty}${l.qty ? ` @${num(l.cost)}` : ""} · order: ${l.orders.length ? esc(l.orders.map((o: string) => o.replace("BUY@", "beli ").replace("SELL@", "jual ")).join(", ")) : "menunggu"}`]) : ["  -"]),
      section(`Scan item (${st.selectedAt ? ago(st.selectedAt) : "belum"})`),
      pre(["ITEM            EDGE   %  UNIT/HARI  STATUS", ...(st.scores ?? []).slice(0, 9).map((x) => `${shortName(x.name).padEnd(15)}${String(Math.round(x.edge)).padStart(5)} ${String(Math.round(x.edgePct * 100)).padStart(3)} ${String(Math.round(x.unitsPerDay)).padStart(9)}  ${st.selected.includes(x.key) ? "✓ DIPILIH" : x.reason}`)]),
      row("Aturan", `max ${c.maxAssets} item · 1 unit/item · stop-loss ${c.stopLossPct * 100}% · batas rugi ${usd(c.maxLossValor / 100, 0)}`),
      footer("Notifikasi: order beli, terbeli, listing jual, terjual + profit.")];
    const kb = new InlineKeyboard()
      .text(c.enabled ? "⏸ Matikan market" : "▶️ Nyalakan market", "a:mmToggle").text("🧠 Scan ulang", "a:mmScan").row()
      .text("💵 Setor modal $15 → VALOR", "c:mmFund").row()
      .text("🛑 Batalkan semua order", "c:mmCancel");
    return { text: lines.join("\n"), kb: nav(kb, "v:market") };
  }

  function vHelp(): View {
    const lines = [header("❓", "PANDUAN"),
      section("Menu"),
      "  📊 <b>Dashboard</b> — semua angka penting dalam satu layar",
      "  🎮 <b>Run</b> — status run live, mulai/stop run",
      "  💰 <b>Wallet</b> — saldo 3 chain, swap & bridge via Relay",
      "  🗝 <b>Keys</b> — beli Arcade key (wajib konfirmasi) + EV live",
      "  🎁 <b>Klaim</b> — key harian, upvote, payout, jackpot, tarik VALOR",
      "  🎫 <b>Pass</b> — status & perpanjang Expedition Pass",
      "  📈 <b>Market</b> — market-making otomatis, P&L & item terpilih",
      "  📜 <b>Riwayat</b> — hasil run, transaksi, log sistem",
      "  🏆 <b>Leaderboard</b> — Arcade mingguan & Expedition",
      "  ⚙️ <b>Setting</b> — atur autopilot, cap belanja, ambang EV",
      section("Cara kerja"),
      "  • Expedition key (gratis) dipakai otomatis untuk farming marbles, corn & Arcade key.",
      "  • Arcade (berbayar) hanya bila EV pool ≥ ambang dan di bawah cap harian.",
      "  • Setiap belanja/swap butuh tombol konfirmasi; quote kedaluwarsa 45 dtk.",
      "  • ⏸ PAUSE menghentikan semua otomatisasi seketika.",
      section("Perintah"),
      "  /menu /dash /run /wallet /keys /claims /pass /market",
      "  /history /lb /settings /pause /help"];
    return { text: lines.join("\n"), kb: nav(new InlineKeyboard()) };
  }

  const views: Record<string, () => Promise<View> | View> = {
    market: vMarket, menu: vMenu, dash: vDash, run: vRun, wallet: vWallet, keys: vKeys, claims: vClaims, hist: vHist, lb: vLb, set: vSettings, help: vHelp, pass: vPass,
  };
  const loading: Record<string, string> = { dash: "Memuat dashboard…", wallet: "Cek saldo…", lb: "Memuat leaderboard…", claims: "Memuat…", keys: "Memuat…" };

  // inline navigation
  bot.callbackQuery(/^v:(\w+)$/, async (ctx) => {
    const v = views[ctx.match[1]]; if (!v) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery({ text: loading[ctx.match[1]] });
    try { await edit(ctx, await v(), ctx.match[1]); } catch (e: any) { await ctx.reply(`❌ ${esc(e.message)}`, { parse_mode: "HTML" }); }
  });
  bot.callbackQuery("live:stop", async (ctx) => {
    const view = ctx.chat ? live.get(ctx.chat.id)?.view ?? "menu" : "menu";
    if (ctx.chat) stopLive(ctx.chat.id);
    await ctx.answerCallbackQuery({ text: "⏹ Live dihentikan" });
    const v = decorate(await views[view](), false, view);
    try { await ctx.editMessageText(v.text, { parse_mode: "HTML", reply_markup: v.kb, link_preview_options: { is_disabled: true } }); } catch { /* not modified */ }
  });
  bot.callbackQuery(/^live:start:(\w+)$/, async (ctx) => {
    const view = ctx.match[1]; const v = views[view]; if (!v) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery({ text: "🔴 Live aktif 15 menit" });
    await edit(ctx, await v(), view);
  });
  // slash commands + bottom keyboard buttons -> new message
  const cmdMap: Record<string, string> = { market: "market", pass: "pass", menu: "menu", m: "menu", dash: "dash", d: "dash", run: "run", wallet: "wallet", keys: "keys", claims: "claims", history: "hist", lb: "lb", settings: "set", help: "help" };
  for (const [cmd, view] of Object.entries(cmdMap)) bot.command(cmd, async (ctx) => { try { await send(ctx, await views[view](), view); } catch (e: any) { await ctx.reply(`❌ ${esc(e.message)}`, { parse_mode: "HTML" }); } });
  for (const [view, label] of Object.entries(MENU_BUTTONS)) bot.hears(label, async (ctx) => { try { await send(ctx, await views[view]()); } catch (e: any) { await ctx.reply(`❌ ${esc(e.message)}`, { parse_mode: "HTML" }); } });
  bot.command("pause", async (ctx) => { const ns = togglePause(); await ctx.reply(ns ? "⏸ Autopilot di-PAUSE. Run berjalan dihentikan." : "▶️ Autopilot AKTIF lagi."); });

  // settings mutations
  bot.callbackQuery(/^s:(\w+)$/, async (ctx) => {
    const k = ctx.match[1] as keyof Settings; const st = store.settings();
    if (typeof st[k] !== "boolean") return ctx.answerCallbackQuery();
    const ns = store.patchSettings({ [k]: !st[k] } as Partial<Settings>);
    store.event("info", `setting ${k} -> ${ns[k]}`);
    await ctx.answerCallbackQuery({ text: `${k}: ${ns[k] ? "ON" : "OFF"}` });
    await edit(ctx, vSettings());
  });
  bot.callbackQuery(/^n:(\w+):(-?[\d.]+)$/, async (ctx) => {
    const k = ctx.match[1] as keyof Settings; const d = Number(ctx.match[2]); const st = store.settings();
    const limits: Record<string, [number, number]> = { arcadeDailyUsdCap: [0, 100], arcadeKeysPerRun: [1, 100], minPoolEvPerKey: [0.5, 2], worldBuysPerDay: [0, 10] };
    if (!(k in limits)) return ctx.answerCallbackQuery();
    const [lo, hi] = limits[k]; const v = Math.min(hi, Math.max(lo, Math.round(((st[k] as number) + d) * 100) / 100));
    store.patchSettings({ [k]: v } as Partial<Settings>);
    store.event("info", `setting ${k} -> ${v}`);
    await ctx.answerCallbackQuery({ text: `${k} = ${v}` });
    await edit(ctx, vSettings());
  });
  bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());

  // ---------------- actions ----------------
  function togglePause() {
    const ns = store.patchSettings({ paused: !store.settings().paused });
    if (ns.paused) autopilot.requestStopRun();
    store.event("warn", `autopilot ${ns.paused ? "PAUSED" : "resumed"} by owner`);
    return ns.paused;
  }
  bot.callbackQuery("a:togglePause", async (ctx) => {
    const paused = togglePause();
    await ctx.answerCallbackQuery({ text: paused ? "⏸ Autopilot di-pause" : "▶️ Autopilot aktif" });
    await edit(ctx, await vMenu());
  });
  bot.callbackQuery("a:stopRun", async (ctx) => { autopilot.requestStopRun(); await ctx.answerCallbackQuery({ text: "Run berhenti setelah aksi berikut (run tetap bisa dilanjut)", show_alert: true }); });
  bot.callbackQuery("a:playExp", async (ctx) => {
    if (autopilot.running) return ctx.answerCallbackQuery({ text: "Sudah ada run berjalan", show_alert: true });
    await ctx.answerCallbackQuery({ text: "▶️ Memulai Expedition…" });
    void autopilot.createAndPlay("EXPEDITION", 1).catch((e) => notifyAll(`❌ ${esc(e.message)}`));
  });
  const resultCard = (title: string, body: string) => `${header("✅", title)}\n${body}`;
  bot.callbackQuery("a:daily", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Klaim…" });
    try { const r = await autopilot.claimDaily(); await ctx.reply(r ? resultCard("Klaim harian", `  +<b>${r.claimed}</b> Expedition key`) : "ℹ️ Tidak ada key harian yang bisa diklaim sekarang.", { parse_mode: "HTML" }); }
    catch (e: any) { await ctx.reply(`❌ ${esc(e.message)}`, { parse_mode: "HTML" }); }
  });
  bot.callbackQuery("a:upvote", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Upvote…" });
    try { const r = await autopilot.upvote(); await ctx.reply(r ? resultCard("Upvote", `  +<b>${r.reward}</b> Expedition key`) : "ℹ️ Upvote epoch ini sudah diklaim.", { parse_mode: "HTML" }); }
    catch (e: any) { await ctx.reply(`❌ ${esc(e.message)}`, { parse_mode: "HTML" }); }
  });
  bot.callbackQuery("a:quests", async (ctx) => { await ctx.answerCallbackQuery({ text: "Mengecek quest…" }); await autopilot.claimQuests().catch((e) => ctx.reply(`❌ ${esc(e.message)}`)); });

  bot.callbackQuery("a:money", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Cek payout & jackpot…" });
    try {
      const w = await claims.claimWeekly(); const j = await claims.claimJackpot(); cachedSnap = null;
      await ctx.reply(w || j ? resultCard("Klaim uang", [w ? row("Payout mingguan", `minggu ${w.weeks.join(", ")} · <code>${w.hash.slice(0, 14)}…</code>`) : "", j ? row("Jackpot", `${j.totalAmount} · <code>${j.hash.slice(0, 14)}…</code>`) : ""].filter(Boolean).join("\n")) : "ℹ️ Belum ada payout / jackpot yang bisa diklaim.", { parse_mode: "HTML" });
    } catch (e: any) { await ctx.reply(`❌ ${esc(e.shortMessage ?? e.message)}`, { parse_mode: "HTML" }); }
  });
  const pendingWithdraw = new Map<string, { valor: number; expires: number }>();
  bot.callbackQuery("c:withdraw", async (ctx) => {
    const v = Number((await api.get("/api/shop/valor/balance")).valorBalance);
    await ctx.answerCallbackQuery();
    if (v < 500) return edit(ctx, { text: `ℹ️ Saldo VALOR ${num(v)} — minimal tarik 500 VALOR ($5).`, kb: nav(new InlineKeyboard(), "v:claims") });
    const id = String(randomInt(1e9)); pendingWithdraw.set(id, { valor: v, expires: Date.now() + 60_000 });
    await edit(ctx, { text: `${header("⚠️", "KONFIRMASI PENARIKAN")}\n${row("Jumlah", `<b>${num(v)} VALOR</b> ≈ ${usd(v / 100)}`)}\n${row("Fee", "5%")}\n${row("Diterima", `≈ <b>${usd((v / 100) * 0.95)}</b> USDC.e`)}\n${row("Waktu", "klaim otomatis setelah 24 jam")}`,
      kb: new InlineKeyboard().text("✅ Tarik", `x:withdraw:${id}`).text("❌ Batal", "v:claims") });
  });
  bot.callbackQuery(/^x:withdraw:(\d+)$/, async (ctx) => {
    const p = pendingWithdraw.get(ctx.match[1]); pendingWithdraw.delete(ctx.match[1]);
    if (!p || p.expires < Date.now()) return ctx.answerCallbackQuery({ text: "Kedaluwarsa, ulangi.", show_alert: true });
    await ctx.answerCallbackQuery({ text: "Memproses…" });
    try { const r = await claims.initiateWithdrawal(p.valor); store.ledger("withdraw", -r.netUsdc, `init ${p.valor} VALOR`, r.hash); cachedSnap = null;
      await ctx.reply(resultCard("Penarikan dimulai", `${row("Bruto", usd(r.grossUsdc))}\n${row("Bersih", `<b>${usd(r.netUsdc)}</b>`)}\n${row("Status", "bot klaim otomatis setelah 24 jam")}`), { parse_mode: "HTML" }); }
    catch (e: any) { await ctx.reply(`❌ ${esc(e.shortMessage ?? e.message)}`, { parse_mode: "HTML" }); }
  });
  const pendingPass = new Map<string, { itemId: number; expires: number }>();
  bot.callbackQuery(/^c:pass:(\d+)$/, async (ctx) => {
    const itemId = Number(ctx.match[1]); const skus: any[] = await api.get("/api/shop/skus"); const k = skus.find((x) => Number(x.itemId) === itemId);
    await ctx.answerCallbackQuery();
    if (!k) return;
    const id = String(randomInt(1e9)); pendingPass.set(id, { itemId, expires: Date.now() + 60_000 });
    await edit(ctx, { text: `${header("⚠️", "KONFIRMASI PASS")}\n${row("Paket", `<b>${k.tier} ${k.weeks} minggu</b>`)}\n${row("Harga", `<b>${usd(Number(k.salePrice ?? k.listPrice) / 1e6)}</b> (dari VALOR / top-up USDC.e)`)}\n${footer("Pass aktif diperpanjang; tidak bisa downgrade VIP → Basic.")}`,
      kb: new InlineKeyboard().text("✅ Beli", `x:pass:${id}`).text("❌ Batal", "v:pass") });
  });
  bot.callbackQuery(/^x:pass:(\d+)$/, async (ctx) => {
    const p = pendingPass.get(ctx.match[1]); pendingPass.delete(ctx.match[1]);
    if (!p || p.expires < Date.now()) return ctx.answerCallbackQuery({ text: "Kedaluwarsa, ulangi.", show_alert: true });
    await ctx.answerCallbackQuery({ text: "Memproses pembelian pass…" });
    try { const mm = market.cfg(); const r: any = await claims.buyPass(p.itemId, mm.enabled ? mm.capitalValor : 0); store.ledger("pass", r.priceUsd, `${r.sku.tier} ${r.sku.weeks}w`, r.depositTx ?? undefined); cachedSnap = null;
      await ctx.reply(resultCard("Pass aktif", `${row("Tier", `<b>${esc(r.pass?.tier)}</b>`)}\n${row("Berlaku sampai", esc(String(r.pass?.expiresAt ?? "").slice(0, 16).replace("T", " ")) + " UTC")}`), { parse_mode: "HTML" }); }
    catch (e: any) { await ctx.reply(`❌ ${esc(e.shortMessage ?? e.message)}`, { parse_mode: "HTML" }); }
  });

  bot.callbackQuery("a:mmToggle", async (ctx) => {
    const c = market.setCfg({ enabled: !market.cfg().enabled });
    store.event("warn", `market ${c.enabled ? "ENABLED" : "disabled"} by owner`);
    await ctx.answerCallbackQuery({ text: c.enabled ? "Market aktif" : "Market mati" });
    if (c.enabled) void market.tick();
    await edit(ctx, await vMarket());
  });
  bot.callbackQuery("a:mmScan", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Scan semua item…" });
    const st = market.state(); st.selectedAt = 0; store.set("mm.state", st);
    if (market.cfg().enabled) await market.tick(); else { const sc = await market.scoreAssets(market.cfg()); const s2 = market.state(); s2.scores = sc; s2.selectedAt = Date.now(); s2.selected = sc.filter((x) => x.score > 0).slice(0, market.cfg().maxAssets).map((x) => x.key); store.set("mm.state", s2); }
    await edit(ctx, await vMarket());
  });
  bot.callbackQuery("c:mmCancel", async (ctx) => {
    await ctx.answerCallbackQuery();
    await edit(ctx, { text: `${header("⚠️", "BATALKAN SEMUA ORDER MARKET?")}\n${footer("Order beli & listing jual dibatalkan; stok tetap di inventory.")}`, kb: new InlineKeyboard().text("✅ Batalkan", "x:mmCancel").text("❌ Tidak", "v:market") });
  });
  bot.callbackQuery("x:mmCancel", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Membatalkan…" });
    const orders = await market.myOrders(); let n = 0;
    for (const o of orders) { try { await api.request(`/api/mog/marketplace/orders/${encodeURIComponent(o.id)}`, { method: "DELETE" }); n++; } catch { /* keep going */ } }
    market.setCfg({ enabled: false });
    await ctx.reply(resultCard("Order dibatalkan", `  ${n} order dibatalkan · market dimatikan`), { parse_mode: "HTML" });
  });
  const pendingFund = new Map<string, number>();
  bot.callbackQuery("c:mmFund", async (ctx) => {
    await ctx.answerCallbackQuery(); const id = String(randomInt(1e9)); pendingFund.set(id, Date.now() + 60_000);
    await edit(ctx, { text: `${header("⚠️", "SETOR MODAL MARKET")}\n${row("Jumlah", "<b>15 USDC.e → 1.500 VALOR</b>")}\n${row("Biaya", "gas saja (deposit VALOR tanpa fee)")}\n${footer("Tarik kembali ke USDC.e: fee 5% + tunggu 24 jam.")}`, kb: new InlineKeyboard().text("✅ Setor", `x:mmFund:${id}`).text("❌ Batal", "v:market") });
  });
  bot.callbackQuery(/^x:mmFund:(\d+)$/, async (ctx) => {
    const exp = pendingFund.get(ctx.match[1]); pendingFund.delete(ctx.match[1]);
    if (!exp || exp < Date.now()) return ctx.answerCallbackQuery({ text: "Kedaluwarsa, ulangi.", show_alert: true });
    await ctx.answerCallbackQuery({ text: "Deposit…" });
    try { const r = await claims.depositValorUsd(15); store.ledger("mm_capital", 15, "market capital deposit", r.hash); cachedSnap = null;
      await ctx.reply(resultCard("Modal market masuk", `${row("VALOR sekarang", `<b>${num(r.valor)}</b>`)}\n${row("Tx", `<code>${r.hash}</code>`)}`), { parse_mode: "HTML" }); }
    catch (e: any) { await ctx.reply(`❌ ${esc(e.shortMessage ?? e.message)}`, { parse_mode: "HTML" }); }
  });

  bot.callbackQuery("a:redeem", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Menukar worldseed…" });
    try { const r = await claims.redeemCaches(false); await ctx.reply(r ? resultCard("Cache ditukar", `${row("Jumlah", `${r.count} World's Eve Cache`)}\n${row("Sisa worldseed", num(r.amber))}`) : "ℹ️ Worldseed belum cukup (butuh 500 per cache).", { parse_mode: "HTML" }); }
    catch (e: any) { await ctx.reply(`❌ ${esc(e.message)}`, { parse_mode: "HTML" }); }
  });
  bot.callbackQuery("c:world1", async (ctx) => {
    await ctx.answerCallbackQuery();
    const eve = (await api.get("/api/items/world-keys")).balance ?? 0;
    const a = (await market.summary()).get("key.world");
    if (eve > 0) return edit(ctx, { text: `${header("🌍", "WORLD'S EVE")}\n${row("Biaya", "<b>1 Eve Key</b> (punya " + eve + ")")}\n${row("Hasil", "worldseed → cache, tiket raffle, marbles")}`, kb: new InlineKeyboard().text("✅ Main", "x:world1").text("❌ Batal", "v:run") });
    await edit(ctx, { text: `${header("🌍", "BELI EVE KEY")}\n${row("Eve Key kamu", "0")}\n${row("Harga market", a?.lowestAsk ? `<b>${num(Number(a.lowestAsk))} VALOR</b> (≈${usd(Number(a.lowestAsk) / 100)})` : "tidak ada penjual")}\n${footer("Dibayar dari saldo VALOR (modal market tidak dipakai jika saldo kurang).")}`,
      kb: a?.lowestAsk ? new InlineKeyboard().text("✅ Beli 1 & main", "x:buyEve").text("❌ Batal", "v:run") : nav(new InlineKeyboard(), "v:run") });
  });
  bot.callbackQuery("x:buyEve", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Membeli Eve Key…" });
    try {
      const a = (await market.summary()).get("key.world"); const price = Number(a?.lowestAsk ?? 0);
      const valor = Number((await api.get("/api/shop/valor/balance")).valorBalance);
      if (!price || valor < price) { await ctx.reply(`ℹ️ Saldo VALOR ${num(valor)} kurang untuk harga ${num(price)}.`); return; }
      const r = await market.instantBuy("key.world", price, 1);
      if (!r.filled) { await ctx.reply("ℹ️ Harga berubah, belum terbeli. Coba lagi."); return; }
      await ctx.reply(resultCard("Eve Key dibeli", row("Harga", `${num(r.price)} VALOR`)), { parse_mode: "HTML" });
      if (!autopilot.running) void autopilot.createAndPlay("WORLD", 1).catch((e) => notifyAll(`❌ ${esc(e.message)}`));
    } catch (e: any) { await ctx.reply(`❌ ${esc(e.message)}`, { parse_mode: "HTML" }); }
  });
  bot.callbackQuery("x:world1", async (ctx) => {
    if (autopilot.running) return ctx.answerCallbackQuery({ text: "Sudah ada run berjalan", show_alert: true });
    await ctx.answerCallbackQuery({ text: "🌍 Memulai World's Eve…" });
    void autopilot.createAndPlay("WORLD", 1).catch((e) => notifyAll(`❌ ${esc(e.message)}`));
  });

  // spending: always confirm
  bot.callbackQuery(/^c:buy:(\d+)$/, async (ctx) => {
    const qty = Number(ctx.match[1]); const id = String(randomInt(1e9));
    pendingKeyBuys.set(id, { qty, expires: Date.now() + 60_000 });
    await ctx.answerCallbackQuery();
    await edit(ctx, { text: `${header("⚠️", "KONFIRMASI PEMBELIAN")}\n${row("Item", `${qty} Arcade key`)}\n${row("Biaya", `<b>${qty} USDC.e</b> + gas`)}\n${footer("Rata-rata pool hanya mengembalikan ~$0.8–0.9 per key. Berlaku 60 detik.")}`,
      kb: new InlineKeyboard().text("✅ Ya, beli", `x:buy:${id}`).text("❌ Batal", "v:keys") });
  });
  bot.callbackQuery(/^x:buy:(\d+)$/, async (ctx) => {
    const p = pendingKeyBuys.get(ctx.match[1]); pendingKeyBuys.delete(ctx.match[1]);
    if (!p || p.expires < Date.now()) return ctx.answerCallbackQuery({ text: "Kedaluwarsa, ulangi.", show_alert: true });
    await ctx.answerCallbackQuery({ text: "Mengirim transaksi…" });
    try {
      const { hash, price } = await abs.buyKeys(BigInt(p.qty));
      store.ledger("buy_keys", Number(price * BigInt(p.qty)) / 1e6, `${p.qty} arcade keys (manual)`, hash);
      let credited = false;
      for (let i = 0; i < 10 && !credited; i++) { try { await api.post("/api/keys/process-purchase", { txHash: hash }); credited = true; } catch { await new Promise((r) => setTimeout(r, 3000)); } }
      const bal = (await api.get("/api/keys/balance")).balance;
      await ctx.reply(resultCard("Pembelian key", `${row("Dibeli", `${p.qty} key`)}\n${row("Saldo Arcade key", `<b>${bal}</b>${credited ? "" : " (menunggu backend)"}`)}\n${row("Tx", `<a href="https://abscan.org/tx/${hash}">${hash.slice(0, 12)}…</a>`)}`), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    } catch (e: any) { await ctx.reply(`❌ Gagal: ${esc(e.shortMessage ?? e.message)}`, { parse_mode: "HTML" }); }
  });
  bot.callbackQuery("c:arcade1", async (ctx) => {
    await ctx.answerCallbackQuery();
    await edit(ctx, { text: `${header("⚠️", "KONFIRMASI ARCADE")}\n${row("Biaya", "<b>1 Arcade key</b> ($1)")}\n${footer("Treasure masuk pool mingguan USDC.")}`, kb: new InlineKeyboard().text("✅ Main", "x:arcade1").text("❌ Batal", "v:run") });
  });
  bot.callbackQuery("x:arcade1", async (ctx) => {
    if (autopilot.running) return ctx.answerCallbackQuery({ text: "Sudah ada run berjalan", show_alert: true });
    const have = (await api.get("/api/keys/balance")).balance;
    if (have < 1) return ctx.answerCallbackQuery({ text: "Arcade key 0 — beli dulu di menu Keys", show_alert: true });
    await ctx.answerCallbackQuery({ text: "🎰 Memulai Arcade…" });
    void autopilot.createAndPlay("NORMAL", 1).catch((e) => notifyAll(`❌ ${esc(e.message)}`));
  });
  bot.callbackQuery("c:corn", async (ctx) => {
    await ctx.answerCallbackQuery();
    const r = await claims.raffleStatus("goldenCorn");
    if (!r.ticketBalance) return edit(ctx, { text: "ℹ️ Tidak ada Golden Corn yang bisa dimasukkan.", kb: nav(new InlineKeyboard(), "v:claims") });
    await edit(ctx, { text: `${header("🎟", "UNDIAN GOLDEN CORN")}\n${row("Tiket", `<b>${num(r.ticketBalance)}</b> corn = ${num(r.ticketBalance)} tiket`)}\n${row("Hadiah", `${r.slotPool} slot WL Yield Fields (bisa menang >1)`)}\n${row("Diundi", new Date(r.drawTime).toISOString().slice(0, 16).replace("T", " ") + " UTC")}\n${footer("Corn yang dimasukkan hangus untuk undian ini. Bot otomatis memasukkan 3 jam sebelum tutup; masukkan sekarang hanya jika perlu.")}`,
      kb: new InlineKeyboard().text("✅ Masukkan sekarang", "x:corn").text("❌ Batal", "v:claims") });
  });
  bot.callbackQuery("x:corn", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Memasukkan tiket…" });
    try {
      const r = await claims.raffleStatus("goldenCorn"); await claims.enterRaffle("goldenCorn", r.ticketBalance);
      const a = await claims.raffleStatus("goldenCorn"); cachedSnap = null;
      await ctx.reply(resultCard("Tiket undian masuk", `${row("Masuk", `${num(r.ticketBalance)} tiket`)}\n${row("Total tiket kita", num(a.userEntries))}\n${row("Peluang ≥1 WL", `≈ ${(a.chanceAtLeastOne * 100).toFixed(1)}%`)}`), { parse_mode: "HTML" });
    } catch (e: any) { await ctx.reply(`❌ ${esc(e.message)}`, { parse_mode: "HTML" }); }
  });

  // Relay quotes -> confirm -> execute
  bot.callbackQuery(/^q:(\w+):(\w+)$/, async (ctx) => {
    const [, route, amtS] = ctx.match;
    await ctx.answerCallbackQuery({ text: "Minta quote…" });
    try {
      const base = { user: account.address, tradeType: "EXACT_INPUT" as const };
      let q: Quote; let label: string;
      if (route === "abs_eth_usdc") {
        const probe = await getQuote({ ...base, originChainId: ABS.chainId, destinationChainId: ABS.chainId, originCurrency: NATIVE, destinationCurrency: ABS.usdce, amount: parseEther("0.001").toString() });
        const px = Number(probe.details.currencyIn.amountUsd) / 0.001;
        q = await getQuote({ ...base, originChainId: ABS.chainId, destinationChainId: ABS.chainId, originCurrency: NATIVE, destinationCurrency: ABS.usdce, amount: parseEther((Number(amtS) / px).toFixed(8)).toString() });
        label = "Swap ETH → USDC.e (Abstract)";
      } else if (route === "abs_usdc_eth") {
        q = await getQuote({ ...base, originChainId: ABS.chainId, destinationChainId: ABS.chainId, originCurrency: ABS.usdce, destinationCurrency: NATIVE, amount: String(Number(amtS) * 1e6) });
        label = "Swap USDC.e → ETH (Abstract)";
      } else if (route === "arb_in" || route === "rh_in") {
        const chain = route === "arb_in" ? arbitrum : robinhood;
        const bal = await publicClient(chain.id).getBalance({ address: account.address });
        const amt = bal - parseEther("0.00003");
        if (amt <= parseEther("0.0003")) { await ctx.reply(`ℹ️ Saldo ETH di ${chain.name} terlalu kecil (${formatUnits(bal, 18)}).`); return; }
        q = await getQuote({ ...base, originChainId: chain.id, destinationChainId: ABS.chainId, originCurrency: NATIVE, destinationCurrency: ABS.usdce, amount: amt.toString() });
        label = `Bridge ${chain.name} ETH → Abstract USDC.e`;
      } else return;
      const id = String(randomInt(1e9));
      pendingQuotes.set(id, { quote: q, label, expires: Date.now() + 45_000 });
      const d = q.details; const fee = Object.values(q.fees ?? {}).reduce((s, f: any) => s + Number(f?.amountUsd ?? 0), 0);
      await edit(ctx, { text: [header("🔁", "KONFIRMASI SWAP"), row("Rute", esc(label)),
        row("Kirim", `<b>${num(Number(d.currencyIn.amountFormatted), 6)} ${esc(d.currencyIn.currency.symbol)}</b> (${usd(Number(d.currencyIn.amountUsd))})`),
        row("Terima", `<b>${num(Number(d.currencyOut.amountFormatted), 6)} ${esc(d.currencyOut.currency.symbol)}</b> (${usd(Number(d.currencyOut.amountUsd))})`),
        row("Fee", `~${usd(fee, 3)}`), row("Estimasi", `${d.timeEstimate ?? "?"} dtk`), footer("Quote berlaku 45 detik.")].join("\n"),
        kb: new InlineKeyboard().text("✅ Eksekusi", `x:q:${id}`).text("❌ Batal", "v:wallet") });
    } catch (e: any) { await ctx.reply(`❌ Quote gagal: ${esc(e.message)}`, { parse_mode: "HTML" }); }
  });
  bot.callbackQuery(/^x:q:(\d+)$/, async (ctx) => {
    const p = pendingQuotes.get(ctx.match[1]); pendingQuotes.delete(ctx.match[1]);
    if (!p || p.expires < Date.now()) return ctx.answerCallbackQuery({ text: "Quote kedaluwarsa, minta ulang.", show_alert: true });
    await ctx.answerCallbackQuery({ text: "Mengeksekusi…" });
    try {
      const hashes = await executeQuote(p.quote, account, (m) => log(`relay: ${m}`));
      const fees = Object.values(p.quote.fees ?? {}).reduce((s, f: any) => s + Number(f?.amountUsd ?? 0), 0);
      store.ledger("swap_fee", fees, p.label, hashes.at(-1)); cachedSnap = null;
      await ctx.reply(resultCard(p.label, hashes.map((h) => `  ◦ <code>${h}</code>`).join("\n")), { parse_mode: "HTML" });
    } catch (e: any) { await ctx.reply(`❌ ${esc(p.label)} gagal: ${esc(e.shortMessage ?? e.message)}`, { parse_mode: "HTML" }); }
  });

  async function notifyAll(text: string) {
    for (const id of [...new Set([...opts.envOwners, ...store.owners()])]) {
      try { await bot.api.sendMessage(id, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }); } catch (e: any) { log(`notify ${id} failed: ${e.message}`); }
    }
  }

  /** Profile description, command list and the chat "Menu" button. */
  async function setupProfile() {
    await bot.api.setMyCommands(BOT_COMMANDS);
    await bot.api.setMyShortDescription(BOT_SHORT_DESCRIPTION).catch((e) => log(`shortDescription: ${e.message}`));
    await bot.api.setMyDescription(BOT_DESCRIPTION).catch((e) => log(`description: ${e.message}`));
    await bot.api.setChatMenuButton({ menu_button: { type: "commands" } }).catch((e) => log(`menuButton: ${e.message}`));
  }

  return { bot, notifyAll, ensureClaimCode, setupProfile, replyKb, views };
}
