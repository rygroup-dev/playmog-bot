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
import type { FundWatch, GameWatch } from "../services/watch.js";
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
  { command: "inv", description: "🎒 Inventory: item, worldseed, key, harga jual" },
  { command: "gamble", description: "🎲 Judi & gacha: peluang, biaya, dan saklar taruhan" },
  { command: "link", description: "🔗 Link wallet pribadi sebagai penerima hadiah" },
  { command: "swap", description: "⇄ Swap jumlah bebas: /swap eth 12 atau /swap usdc 7" },
  { command: "valor", description: "💵 USDC.e → VALOR jumlah bebas: /valor 12" },
  { command: "withdraw", description: "🏦 VALOR → USDC.e jumlah bebas: /withdraw 800" },
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

export function createBot(opts: { token: string; store: Store; api: MogApi; abs: AbstractOps; account: PrivateKeyAccount; autopilot: Autopilot; claims: ClaimsService; market: MarketMaker; gameWatch?: GameWatch; fundWatch?: FundWatch; envOwners: number[]; log: (m: string) => void }) {
  const { store, api, abs, account, autopilot, claims, market, gameWatch, fundWatch, log } = opts;
  // every Telegram call is bounded: a stalled request must never block the bot (it once hung startup forever).
  // 60s stays above grammY's 30s long-poll so getUpdates is never aborted mid-poll.
  const bot = new Bot(opts.token, { client: { timeoutSeconds: 60 } });
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
  function gameLine() {
    if (!gameWatch) return "";
    const g = gameWatch.state();
    return `🛠 Game v${g.appVersion} · deploy <code>${(g.rev ?? "?").slice(0, 7)}</code>${g.paused ? " · ⏸ server pause" : ""} · update terakhir ${g.changedAt ? ago(g.changedAt) : "-"} · dicek ${g.checkedAt ? ago(g.checkedAt) : "-"}`;
  }
  async function vMenu(): Promise<View> {
    const st = store.settings(); const r = autopilot.running; const s = await snap(60_000).catch(() => null);
    const lines = [
      header("🧭", "MoG AUTOPILOT", utcNow()),
      `${st.paused ? "⏸ <b>PAUSED</b> — autopilot berhenti" : "🟢 <b>AKTIF</b>"} · tick ${ago(autopilot.lastTickAt)}`,
      `👛 <code>${shortAddr(account.address)}</code> · 🎫 ${s?.pass?.isActive ? `<b>${s.pass.tier}</b> (${until(s.pass.expiresAt)})` : "tanpa pass"}`,
      s ? `💵 ${s.wallet?.usdc ?? "?"} USDC.e · ⛽ ${s.wallet?.eth ?? "?"} ETH · 🗝 ${s.keys ?? 0} arcade / ${s.expKeys ?? 0} expedition` : "",
      section("Run"),
      r ? `  🎮 ${r.runType} · floor <b>${r.floor ?? "?"}</b> · 💎 ${num(r.treasure)}\n  ⚡ ${bar(r.energy ?? 0, 100)} ${r.energy ?? "?"}` : "  💤 Tidak ada run berjalan",
      gameLine(),
      autopilot.lastError ? `\n⚠️ <i>${esc(autopilot.lastError).slice(0, 180)}</i>` : "",
    ];
    const kb = new InlineKeyboard()
      .text("📊 Dashboard", "v:dash").text("🎮 Run", "v:run").row()
      .text("💰 Wallet & Swap", "v:wallet").text("🗝 Keys", "v:keys").row()
      .text("🎁 Klaim", "v:claims").text("📜 Riwayat", "v:hist").row()
      .text("🏆 Leaderboard", "v:lb").text("🎫 Pass", "v:pass").row()
      .text("📈 Market", "v:market").text("🎒 Inventory", "v:inv").row()
      .text("🎲 Judi & Gacha", "v:gamble").row()
      .text("⚙️ Setting", "v:set").text("❓ Bantuan", "v:help").row()
      .text(st.paused ? "▶️ RESUME AUTOPILOT" : "⏸ PAUSE (kill-switch)", "a:togglePause").text("🔄", "v:menu");
    return { text: lines.filter(Boolean).join("\n"), kb };
  }

  async function vDash(): Promise<View> {
    const s = await snap(8_000); const st = store.settings();
    const mm = await market.report().catch(() => null);
    const dashLink = (await claims.linkStatus().catch(() => null))?.linked ?? null;
    const amber = await api.get("/api/items/amber").then((r) => Number(r.balance ?? 0)).catch(() => 0);
    const mmLine = {
      enabled: mm?.cfg.enabled ?? false, halted: mm?.state.halted ?? null, pnl: Math.round(mm?.state.realized ?? 0), fills: mm?.state.fills ?? 0,
      capital: mm?.cfg.capitalValor ?? 0, amber,
      buys: mm?.open.filter((o: any) => o.side === "BUY").length ?? 0,
      sells: mm?.open.filter((o: any) => o.side === "SELL").length ?? 0,
      sellNames: (mm?.open.filter((o: any) => o.side === "SELL").map((o: any) => o.name).join(", ") ?? "").slice(0, 60),
      locked: Math.round(mm?.open.filter((o: any) => o.side === "BUY").reduce((t: number, o: any) => t + o.price * o.qty, 0) ?? 0),
    };
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
      ...extraItems.map(([k, v]) => row(esc(FRIENDLY[k] ?? prettyKey(k)), num(v))),
      row("Upvote", s.upvote?.claimed ? `✅ epoch ${s.upvote.epoch}` : `⏳ +${s.upvote?.reward ?? "?"} key tersedia`) + ` · reset ${until(s.upvote?.epochEndsAtIso)}`,
      section(`📈 Minggu ${cw?.weekNumber ?? "?"} · reset ${until(cw?.weekEnd)}`),
      row("Treasure / Marbles", `${num(cw?.userTreasure)} / ${num(cw?.userMarbles)}`),
      row("Proyeksi payout", `${num(Number(cw?.projectedPayout ?? 0))} VALOR`),
      s.pool ? row("Pool", `${usd(s.pool.poolValor / 100, 0)} ÷ ${num(s.pool.totalTreasure)} treasure`) : "",
      s.pool ? row("EV Arcade (bot kita)", `<b>${usd(ev)}</b> / $1 key  ${bar(ev, 1.2, 8)} ${ev >= st.minPoolEvPerKey ? "🟢" : "🔴 di bawah ambang"}`) : "",
      s.pool ? row("EV pemain top", `${usd(s.pool.usdPerKeyTop)} · bot kita ${s.pool.ownTreasurePerKey ? num(s.pool.ownTreasurePerKey) : "?"} treasure/key`) : "",
      row("Earnings total", `${num(Number(s.earnings?.totalValor ?? 0))} VALOR`)
        + ` <i>(share ${num(Number(s.earnings?.breakdown?.treasureShare ?? 0))} · bounty ${num(Number(s.earnings?.breakdown?.bounties ?? 0))} · throne ${num(Number(s.earnings?.breakdown?.throne ?? 0))})</i>`,
      s.expRun ? row("Expedition best", `💎 ${num(s.expRun.treasure)} · rank <b>#${s.expRun.rank}</b>`) : "",
      row("Wallet penerima", dashLink === null ? "wallet bot (belum ada linked wallet)" : `<code>${shortAddr(dashLink)}</code>`),
      section("📈 Market-making"),
      row("Status", mmLine.enabled ? (mmLine.halted ? `🛑 ${esc(mmLine.halted)}` : "🟢 aktif") : "⚫️ mati"),
      row("Profit", `<b>${mmLine.pnl >= 0 ? "+" : ""}${num(mmLine.pnl)} VALOR</b> (${usd(mmLine.pnl / 100)}) · ${mmLine.fills} transaksi`),
      row("Order", `${mmLine.buys} beli · ${mmLine.sells} jual${mmLine.sellNames ? ` (${esc(mmLine.sellNames)})` : ""}`),
      row("Modal", `${num(mmLine.capital)} VALOR · terkunci ${num(mmLine.locked)}`),
      section("🌍 World's Eve"),
      row("Worldseed", `<b>${num(mmLine.amber)}</b> · cache berikutnya ${num(Math.max(0, 500 - (mmLine.amber % 500)))} lagi`),
      row("Auto", `${on(st.autoWorld)} · maks ${st.worldBuysPerDay}×/hari @≤${num(st.worldKeyMaxPrice)} VALOR`),
      section("👑 Hadiah besar (floor 10)"),
      s.prizes ? row("Bounty pool", `<b>${num(s.prizes.bountyValor)}</b> VALOR (${usd(s.prizes.bountyValor / 100, 0)}) · sudah dibayar ${usd(s.prizes.bountyPaidValor / 100, 0)}`) : "",
      s.prizes ? row("Throne pool", `${s.prizes.throneEnabled ? "🟢" : "⚫️"} <b>${num(s.prizes.throneValor)}</b> VALOR (${usd(s.prizes.throneValor / 100, 0)}) · 80% ke 1 pemenang`) : "",
      s.prizes?.boostValor ? row("Boost throne", `+${num(s.prizes.boostValor)} VALOR · sisa ${s.prizes.boostsLeft}×`) : "",
      "  <i>Bounty = bunuh Bounty Boss langka; Throne = tamatkan run. Bot otomatis lapor kalau kena.</i>",
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
    const link = await claims.linkStatus().catch(() => null);
    const lines = [header("💰", "WALLET & SWAP"),
      `Alamat (sama di semua chain EVM):\n<code>${account.address}</code>`,
      section("Saldo"),
      row("Abstract", `<b>${s.wallet?.usdc}</b> USDC.e · <b>${s.wallet?.eth}</b> ETH`),
      row("Arbitrum", `${s.wallet?.arbEth ?? "-"} ETH`), row("Robinhood", `${s.wallet?.rhEth ?? "-"} ETH`),
      row("VALOR (in-game)", `${num(s.valor)} ≈ ${usd((s.valor ?? 0) / 100)}`),
      "  <i>Jumlah bebas: <code>/swap eth 12</code>, <code>/swap usdc 7</code>, <code>/valor 12</code>, <code>/withdraw 800</code>.</i>",
      "  <i>Swap hanya menukar ETH ↔ USDC.e on-chain. USDC.e → VALOR adalah setoran terpisah ke game (1 USDC.e = 100 VALOR, tanpa fee).</i>",
      section("🔗 Wallet penerima hadiah"),
      row("Akun game", `<code>${shortAddr(account.address)}</code> (wallet biasa, bukan AGW)`),
      row("Linked wallet", link?.linked ? `<code>${shortAddr(link.linked)}</code>` : "tidak ada (tidak diperlukan)"),
      row("Hadiah masuk ke", `<code>${shortAddr(account.address)}</code> — wallet bot`),
      "  <i>Fitur link wallet hanya untuk akun Abstract Global Wallet (server: LINK_WALLET_NOT_AGW).",
      "  Akun ini wallet biasa, jadi hadiah seperti WL Yield Fields langsung ke alamat di atas.</i>",
      section("Cara isi dana"),
      "  1. Kirim ETH ke alamat di atas",
      "     (Arbitrum / Robinhood / Abstract)",
      "  2. Tekan tombol 🌉 bridge di bawah",
      "  3. Cek quote → tekan ✅ Eksekusi",
      footer("Quote berlaku 45 detik. Tidak ada transaksi tanpa konfirmasi.")];
    const kb = new InlineKeyboard()
      .text("⇄ ETH→USDC.e $5", "q:abs_eth_usdc:5").text("⇄ ETH→USDC.e $10", "q:abs_eth_usdc:10").row()
      .text("⇄ USDC.e→ETH $3", "q:abs_usdc_eth:3").text("⇄ USDC.e→ETH $5", "q:abs_usdc_eth:5").row()
      .text("⇄ ETH→USDC.e $25", "q:abs_eth_usdc:25").text("⇄ USDC.e→ETH $10", "q:abs_usdc_eth:10").row()
      .text("💵 USDC.e→VALOR $5", "c:valor:5").text("💵 $10", "c:valor:10").text("💵 $25", "c:valor:25").row()
      .text("🌉 Arbitrum → Abstract (semua)", "q:arb_in:all").row()
      .text("🌉 Robinhood → Abstract (semua)", "q:rh_in:all").row()
      .text(link?.linked ? "🔓 Lepas linked wallet" : "🔗 Info link wallet", link?.linked ? "c:unlink" : "a:linkhow")
      .text("🔑 Export private key", "c:exportpk");
    return { text: lines.join("\n"), kb: nav(kb, "v:wallet") };
  }

  const FRIENDLY: Record<string, string> = { "item.golden_corn": "Golden Corn", "ticket.raffle": "Tiket undian", "cache.worlds_eve": "World's Eve Cache",
    "cache.worlds_eve_premium": "World's Eve Cache Premium", "key.expedition": "Expedition Key", "key.world": "Eve Key", "pass.adventurer_mint": "Adventurer Mint Pass" };
  const prettyKey = (k: string) => k.replace(/^[a-z_]+\./, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  /** Everything the account holds, with live market prices and what the loot seller does with it. */
  async function vInv(): Promise<View> {
    const st = store.settings();
    const [inv, amber, eve, exp, arc, tickets, boxes, book] = await Promise.all([
      api.get("/api/items/balances").then((r) => r.balances ?? {}).catch(() => ({})),
      api.get("/api/items/amber").then((r) => Number(r.balance ?? 0)).catch(() => 0),
      api.get("/api/items/world-keys").then((r) => Number(r.balance ?? 0)).catch(() => 0),
      api.get("/api/items/expedition-keys").then((r) => Number(r.balance ?? 0)).catch(() => 0),
      api.get("/api/keys/balance").then((r) => Number(r.balance ?? 0)).catch(() => 0),
      api.get("/api/items/raffle-tickets").then((r) => Number(r.balance ?? 0)).catch(() => 0),
      api.get("/api/items/skinboxes").then((r) => r.balances ?? {}).catch(() => ({})),
      market.summary().catch(() => new Map()),
    ]);
    const skins = await claims.skins().catch(() => ({ ownedSkins: [] as number[], equippedSkin: 0 }));
    const keep = new Set(["key.expedition", "pass.adventurer_mint", "item.golden_corn", ...(st.autoWorld ? ["key.world"] : [])]);
    const rows: string[] = []; let sellValue = 0;
    for (const [k, v] of Object.entries<any>(inv)) {
      const qty = Number(v.balance ?? 0); if (qty <= 0) continue;
      const a: any = (book as Map<string, any>).get(k);
      const bid = Number(a?.lowestAsk ?? 0) ? Number(a.lowestAsk) - 1 : Number(a?.highestBid ?? 0);
      const sellable = !!a?.tradable && !v.soulbound && !keep.has(k);
      if (sellable) sellValue += bid * qty;
      rows.push(`  ◦ <b>${esc(a?.displayName ?? FRIENDLY[k] ?? prettyKey(k))}</b> ×${num(qty)}\n     ${!a?.tradable ? (k.startsWith("skin") ? "kosmetik, tidak bisa dijual" : k === "ticket.raffle" ? "otomatis masuk undian" : k === "item.golden_corn" ? "disimpan untuk undian WL" : "tidak bisa dijual di market") : v.soulbound ? "soulbound" : keep.has(k) ? `disimpan (${k === "item.golden_corn" ? "undian WL" : k === "key.world" ? "main World's Eve" : "dipakai bot"})` : `jual ≈ ${num(bid)} VALOR (${usd((bid * qty) / 100)})`}`);
    }
    const nBoxes = Object.values<any>(boxes).reduce((t, b) => t + Number(b?.balance ?? b ?? 0), 0);
    const lines = [header("🎒", "INVENTORY"),
      section("Mata uang & key"),
      row("Worldseed", `<b>${num(amber)}</b> · cache berikutnya butuh ${num(Math.max(0, 500 - (amber % 500)))} lagi`),
      row("Eve Key", `${eve} · harga pasar ${(book as Map<string, any>).get("key.world")?.lowestAsk ?? "-"} VALOR`),
      row("Expedition key", `${exp}`), row("Arcade key", `${arc}`), row("Tiket undian", `${tickets}`),
      row("Skin box", `${nBoxes}`),
      row("Skin dimiliki", `${skins.ownedSkins.length}${skins.equippedSkin ? ` · dipakai #${skins.equippedSkin}` : ""}`
        + ` — <i>kosmetik murni, tidak bisa dijual di market MoG maupun OpenSea/Magic Eden (bukan NFT). Satu-satunya guna: daur ulang 5 → 1 roll baru.</i>`),
      section("Item"),
      ...(rows.length ? rows : ["  (kosong)"]),
      section("Nilai jual"),
      row("Bisa dijual sekarang", `<b>${num(Math.round(sellValue))} VALOR</b> (${usd(sellValue / 100)})`),
      footer("Bot menjual loot otomatis tiap 30 menit di harga ask−1. Golden Corn & Mint Pass disimpan.")];
    const kb = new InlineKeyboard()
      .text("💸 Jual loot sekarang", "a:sellLoot").text("🎁 Tukar worldseed", "a:redeem").row();
    if (skins.ownedSkins.length >= 5) kb.text(`♻️ Daur ulang 5 skin (${skins.ownedSkins.length})`, "c:recycle").row();
    kb.text("📈 Market", "v:market").text("💰 Wallet", "v:wallet");
    return { text: lines.join("\n"), kb: nav(kb, "v:inv") };
  }

  /** Every game of chance MoG offers, with the numbers taken from the game client itself. */
  async function vGamble(): Promise<View> {
    const st = store.settings();
    const dayStart = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").getTime();
    const rows = store.ledgerSince(Date.now() - 7 * 864e5).filter((l: any) => String(l.kind).startsWith("gamble"));
    const betStats = {
      today: rows.filter((l: any) => l.kind === "gamble_bet" && l.ts >= dayStart).length,
      bets: rows.filter((l: any) => l.kind === "gamble_bet").length,
      wins: rows.filter((l: any) => l.kind === "gamble_win").length,
      losses: rows.filter((l: any) => l.kind === "gamble_loss").length,
      last: rows.filter((l: any) => l.kind !== "gamble_bet").slice(0, 3).map((l: any) => `${l.kind === "gamble_win" ? "🟢" : "🔴"} ${l.detail}`),
    };
    const book = await market.summary().catch(() => new Map());
    const px = (k: string) => { const a: any = (book as Map<string, any>).get(k); return a?.lowestAsk ? `${num(Number(a.lowestAsk))} VALOR` : "-"; };
    const lines = [header("🎲", "JUDI & GACHA"),
      "  <i>Semua angka di bawah diambil dari kode game, bukan perkiraan.</i>",
      section("🏁 Ringjak Derby (ruangan dalam run)"),
      row("Cara main", "pilih 1 dari 4 pelari, semua peluangnya sama (25%)"),
      row("Bayaran", "juara 1 = <b>3×</b> taruhan · juara 2 = <b>0,5×</b>"),
      row("Batas taruhan", "10% treasure (World's Eve: worldseed)"),
      row("Hasil rata-rata", "<b>87,5%</b> dari taruhan → bandar ambil 12,5%"),
      section("🌀 Portal Gambit (ruangan dalam run)"),
      row("Cara main", "5 baris portal, tiap baris ada 1 portal salah"),
      row("Bayaran", "lolos kelima baris = <b>3×</b> taruhan"),
      row("Catatan", "jumlah portal per baris belum terukur; bot mencatatnya saat pertama masuk"),
      section("🎰 Fortune's Gambit & Treasure Map (Emporium)"),
      row("Fortune's Gambit", "taruh worldseed, dua kali lipat atau habis"),
      row("Treasure Map", "cari World's Eve Box yang terkubur"),
      row("Status", "🔴 dimatikan untuk semua pemain (<code>fortunesGambit/treasureMap/emporium=false</code>)"),
      section("🐎 Ringjak Racing (lobi, pakai VALOR)"),
      row("Taruhan", "10–100 VALOR, kelipatan 5"),
      row("Bayaran", "juara 1 = 3× · juara 2 = 0,8× · hasil rata-rata <b>95%</b>"),
      row("Status", "🔴 dimatikan server (<code>lobbyDerby=false</code> di config game, POST balas 404)"),
      row("Kalau dibuka", "tombol balap di bawah langsung bisa dipakai"),
      section("🎟 Gacha token (dijual, tidak dipakai di MoG)"),
      row("Bronze / Silver", `${px("gacha.bronze")} / ${px("gacha.silver")}`),
      row("Gold / Rainbow", `${px("gacha.gold")} / ${px("gacha.rainbow")}`),
      row("Catatan", "token gacha hanya bisa di-roll di game Onchain Heroes, jadi bot menjualnya"),
      section("📊 Riwayat taruhan bot"),
      row("Hari ini", `${betStats.today} taruhan · sisa jatah ${Math.max(0, (st.gambleMaxPerDay ?? 3) - betStats.today)}`),
      row("Total", `${betStats.bets} taruhan · <b>${betStats.wins} menang</b> / ${betStats.losses} kalah`),
      ...(betStats.last.length ? betStats.last.map((l: string) => `     · ${esc(l)}`) : ["     · belum ada taruhan"]),
      section("Saklar taruhan bot"),
      row("Ringjak Derby", on(st.gambleRingRace)), row("Portal Gambit", on(st.gamblePortalGambit)),
      row("Besar taruhan", `${Math.round((st.gambleWagerPct ?? 0.05) * 100)}% dari treasure/worldseed (batas game 10%)`),
      row("Maks per hari", `${st.gambleMaxPerDay ?? 3} taruhan`),
      footer("Semua permainan ini rugi dalam jangka panjang. Kalau saklar mati, bot tetap masuk ruangannya tapi bertaruh 0 supaya bisa lewat.")];
    const kb = new InlineKeyboard()
      .text(`${check(st.gambleRingRace)} Derby`, "s:gambleRingRace").text(`${check(st.gamblePortalGambit)} Portal Gambit`, "s:gamblePortalGambit").row()
      .text("➖", "n:gambleWagerPct:-0.01").text(`Taruhan ${Math.round((st.gambleWagerPct ?? 0.05) * 100)}%`, "noop").text("➕", "n:gambleWagerPct:0.01").row()
      .text("➖", "n:gambleMaxPerDay:-1").text(`Maks ${st.gambleMaxPerDay ?? 3}×/hari`, "noop").text("➕", "n:gambleMaxPerDay:1").row()
      .text("🐎 Balap 10", "c:derby:10").text("🐎 25", "c:derby:25").text("🐎 50", "c:derby:50").row()
      .text("🎒 Inventory", "v:inv").text("📈 Market", "v:market");
    return { text: lines.join("\n"), kb: nav(kb, "v:gamble") };
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
      section("Update game"),
      gameLine() ? "  " + gameLine() : "  -",
      ...(gameWatch?.state().history ?? []).slice(0, 3).map((h) => `  ◦ ${ago(h.at)} · <code>${(h.rev ?? "?").slice(0, 7)}</code> · ${h.changes.length ? esc(h.changes[0].replace(/<[^>]+>/g, "").split("\n")[0]).slice(0, 80) : "tanpa perubahan aturan"}`),
      footer("Arcade hanya jalan bila EV live ≥ ambang DAN belanja 24 jam < cap. Update game dicek tiap 5 menit.")];
    const kb = new InlineKeyboard()
      .text(`${check(st.autoDaily)} Harian`, "s:autoDaily").text(`${check(st.autoUpvote)} Upvote`, "s:autoUpvote").row()
      .text(`${check(st.autoExpedition)} Expedition`, "s:autoExpedition").text(`${check(st.autoArcade)} Arcade`, "s:autoArcade").row()
      .text("➖", "n:arcadeDailyUsdCap:-1").text(`Cap ${usd(st.arcadeDailyUsdCap, 0)}/hari`, "noop").text("➕", "n:arcadeDailyUsdCap:1").row()
      .text("➖", "n:arcadeKeysPerRun:-1").text(`${st.arcadeKeysPerRun} key/run`, "noop").text("➕", "n:arcadeKeysPerRun:1").row()
      .text("➖", "n:minPoolEvPerKey:-0.05").text(`EV ≥ ${usd(st.minPoolEvPerKey)}`, "noop").text("➕", "n:minPoolEvPerKey:0.05").row()
      .text(`${check(st.autoWorld)} World's Eve`, "s:autoWorld").text(`${check(st.autoRedeemCaches)} Tukar cache`, "s:autoRedeemCaches").row()
      .text(`${check(st.autoSellLoot)} Jual loot`, "s:autoSellLoot").text(`${check(st.playOwnedArcadeKeys)} Arcade gratis`, "s:playOwnedArcadeKeys").row()
      .text("➖", "n:worldBuysPerDay:-1").text(`Eve Key ${st.worldBuysPerDay}×/hari`, "noop").text("➕", "n:worldBuysPerDay:1").row()
      .text(`${check(st.autoWithdraw)} Tarik VALOR auto`, "s:autoWithdraw").text(`${check(st.notifyEveryRun)} Notif run`, "s:notifyEveryRun").row()
      .text("🔄 Cek update game sekarang", "a:gameCheck");
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
      (() => { const m = market.status(); const l = (v: boolean | null) => v === false ? "🔴 tutup" : v ? "🟢 buka" : "⚪️ ?";
        return row("Server market", `order limit ${l(m.gtc)} · beli instan ${l(m.fok)}`); })(),
      row("Modal", c.capitalValor > 0 ? `${num(c.capitalValor)} VALOR (${usd(c.capitalValor / 100, 0)}) · saldo VALOR ${num(valor)}`
        : `tanpa batas — dibatasi ${c.maxAssets} aset × ${c.maxUnitsPerAsset} unit · saldo VALOR ${num(valor)}`),
      row("Profit terealisasi", `<b>${pnl >= 0 ? "+" : ""}${num(pnl)} VALOR</b> (${pnl >= 0 ? "+" : ""}${usd(pnl / 100)})`),
      row("Belum terealisasi", `${r.unrealized >= 0 ? "+" : ""}${num(r.unrealized)} VALOR`),
      row("Transaksi", `${st.fills} fill · ${days.toFixed(1)} hari · ≈${usd(pnl / 100 / days)}/hari`),
      row("Modal terpakai", `${num(r.open.filter((o: any) => o.side === "BUY").reduce((t: number, o: any) => t + o.price * o.qty, 0))} VALOR terkunci di order beli`),
      section("🔴 Barang dijual"),
      ...(() => { const sells = r.open.filter((o: any) => o.side === "SELL");
        return sells.length ? sells.map((o: any) => `  ◦ <b>${esc(o.name)}</b> ×${o.qty} @ <b>${num(o.price)}</b>${o.best ? " 🥇" : ` (ask ${num(o.ask)})`}\n     bersih ${num(Math.round(o.net))} VALOR${o.loot ? " · loot run" : o.profit ? ` · untung ${o.profit >= 0 ? "+" : ""}${num(o.profit)}` : ""} · ${o.ageMin} menit`)
          : ["  (belum ada barang yang dijual — muncul otomatis begitu ada yang terbeli)"]; })(),
      section("🟢 Order beli"),
      ...(() => { const buys = r.open.filter((o: any) => o.side === "BUY");
        return buys.length ? buys.map((o: any) => `  ◦ <b>${esc(o.name)}</b> @ <b>${num(o.price)}</b>${o.best ? " 🥇 tertinggi" : ` (kalah dari ${num(o.bid)})`}\n     target jual ${num(Math.max(0, o.ask - 1))} · ${o.ageMin} menit`)
          : ["  (tidak ada order beli aktif)"]; })(),
      section("📦 Stok & pasar"),
      ...(r.lines.length ? r.lines.map((l) => `  ◦ <b>${esc(l.name)}</b>${l.paused ? " ⏸ jeda" : ""} · pasar ${num(l.bid)}/${num(l.ask)} · stok ${l.qty}${l.qty ? ` @${num(l.cost)}` : ""}`) : ["  -"]),
      section(`Scan item (${st.selectedAt ? ago(st.selectedAt) : "belum"})`),
      pre(["ITEM            EDGE   %  UNIT/HARI  STATUS", ...(st.scores ?? []).slice(0, 9).map((x) => `${shortName(x.name).padEnd(15)}${String(Math.round(x.edge)).padStart(5)} ${String(Math.round(x.edgePct * 100)).padStart(3)} ${String(Math.round(x.unitsPerDay)).padStart(9)}  ${st.selected.includes(x.key) ? "✓ DIPILIH" : x.reason}`)]),
      ...(() => { const p = fundWatch?.plan(); if (!p) return [];
        return [row("Top-up terjadwal", p.doneAt ? `✅ selesai ${ago(p.doneAt)} (+${p.marketUsd} USD)` : `⏳ menunggu USDC.e baru ≥ $${p.marketUsd} → modal ${num(p.targetCapitalValor)} VALOR`)]; })(),
      row("Aturan", `max ${c.maxAssets} item · ${c.maxUnitsPerAsset} unit/item · stop-loss ${Math.round(c.stopLossPct * 100)}% · batas rugi ${usd(c.maxLossValor / 100, 0)}`),
      c.capitalValor > 0 && valor < c.capitalValor ? `  ⚠️ <i>Modal disetel ${num(c.capitalValor)} VALOR tapi saldo cuma ${num(valor)} — bot hanya memakai yang ada.</i>` : "",
      footer("Notifikasi: order beli, terbeli, listing jual, terjual + profit.")];
    const kb = new InlineKeyboard()
      .text(c.enabled ? "⏸ Matikan market" : "▶️ Nyalakan market", "a:mmToggle").text("🧠 Scan ulang", "a:mmScan").row()
      .text("➖500", "m:capitalValor:-500").text(`Modal ${num(c.capitalValor)}`, "noop").text("➕500", "m:capitalValor:500").row()
      .text("➖", "m:maxAssets:-1").text(`${c.maxAssets} item`, "noop").text("➕", "m:maxAssets:1")
      .text("➖", "m:maxUnitsPerAsset:-1").text(`${c.maxUnitsPerAsset} unit`, "noop").text("➕", "m:maxUnitsPerAsset:1").row()
      .text("➖", "m:maxLossValor:-100").text(`Batas rugi ${usd(c.maxLossValor / 100, 0)}`, "noop").text("➕", "m:maxLossValor:100").row()
      .text("💵 Setor $5", "c:valor:5").text("$10", "c:valor:10").text("$25", "c:valor:25").row()
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
    market: vMarket, inv: vInv, gamble: vGamble, menu: vMenu, dash: vDash, run: vRun, wallet: vWallet, keys: vKeys, claims: vClaims, hist: vHist, lb: vLb, set: vSettings, help: vHelp, pass: vPass,
  };
  const loading: Record<string, string> = { gamble: "Memuat…", inv: "Membaca inventory…", dash: "Memuat dashboard…", wallet: "Cek saldo…", lb: "Memuat leaderboard…", claims: "Memuat…", keys: "Memuat…" };

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
  const cmdMap: Record<string, string> = { gamble: "gamble", judi: "gamble", inv: "inv", inventory: "inv", market: "market", pass: "pass", menu: "menu", m: "menu", dash: "dash", d: "dash", run: "run", wallet: "wallet", keys: "keys", claims: "claims", history: "hist", lb: "lb", settings: "set", help: "help" };
  for (const [cmd, view] of Object.entries(cmdMap)) bot.command(cmd, async (ctx) => { try { await send(ctx, await views[view](), view); } catch (e: any) { await ctx.reply(`❌ ${esc(e.message)}`, { parse_mode: "HTML" }); } });
  for (const [view, label] of Object.entries(MENU_BUTTONS)) bot.hears(label, async (ctx) => { try { await send(ctx, await views[view]()); } catch (e: any) { await ctx.reply(`❌ ${esc(e.message)}`, { parse_mode: "HTML" }); } });
  const askNumber = (usage: string) => `✏️ Format: <code>${usage}</code>`;
  bot.command("swap", async (ctx) => {
    const [dir, amtS] = (ctx.match ?? "").trim().split(/\s+/);
    const amt = Math.floor(Number(amtS));
    if (!["eth", "usdc"].includes((dir ?? "").toLowerCase()) || !Number.isFinite(amt) || amt < 1)
      return ctx.reply(askNumber("/swap eth 12") + "\n<i>eth = tukar ETH senilai $12 jadi USDC.e · usdc = tukar $12 USDC.e jadi ETH</i>", { parse_mode: "HTML" });
    const route = dir.toLowerCase() === "eth" ? "abs_eth_usdc" : "abs_usdc_eth";
    await ctx.reply(`${header("⇄", "SWAP MANUAL")}\n${row("Jumlah", `<b>$${amt}</b> ${dir.toLowerCase() === "eth" ? "ETH → USDC.e" : "USDC.e → ETH"}`)}\n${footer("Tekan untuk ambil quote; eksekusi tetap minta konfirmasi.")}`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text(`📝 Ambil quote $${amt}`, `q:${route}:${amt}`).text("❌ Batal", "v:wallet") });
  });
  bot.command("valor", async (ctx) => {
    const amt = Math.floor(Number((ctx.match ?? "").trim()));
    if (!Number.isFinite(amt) || amt < 1) return ctx.reply(askNumber("/valor 12") + "\n<i>Setor 12 USDC.e → 1.200 VALOR</i>", { parse_mode: "HTML" });
    await ctx.reply(`${header("💵", "SETOR USDC.e → VALOR")}\n${row("Jumlah", `<b>${amt} USDC.e → ${num(amt * 100)} VALOR</b>`)}`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text(`✅ Setor $${amt}`, `c:valor:${amt}`).text("❌ Batal", "v:wallet") });
  });
  bot.command("withdraw", async (ctx) => {
    const amt = Math.floor(Number((ctx.match ?? "").trim()));
    if (!Number.isFinite(amt) || amt < 500) return ctx.reply(askNumber("/withdraw 800") + "\n<i>Minimal 500 VALOR, fee 5%, cair 24 jam</i>", { parse_mode: "HTML" });
    const id = String(randomInt(1e9)); pendingWithdraw.set(id, { valor: amt, expires: Date.now() + 60_000 });
    await ctx.reply(`${header("⚠️", "KONFIRMASI PENARIKAN")}\n${row("Jumlah", `<b>${num(amt)} VALOR</b> ≈ ${usd(amt / 100)}`)}\n${row("Fee", "5%")}\n${row("Diterima", `≈ <b>${usd((amt / 100) * 0.95)}</b> USDC.e`)}\n${row("Waktu", "cair otomatis setelah 24 jam")}`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✅ Tarik", `x:withdraw:${id}`).text("❌ Batal", "v:claims") });
  });

  bot.command("pause", async (ctx) => { const ns = togglePause(); await ctx.reply(ns ? "⏸ Autopilot di-PAUSE. Run berjalan dihentikan." : "▶️ Autopilot AKTIF lagi."); });

  // settings mutations
  bot.callbackQuery(/^s:(\w+)$/, async (ctx) => {
    const k = ctx.match[1] as keyof Settings; const st = store.settings();
    if (typeof st[k] !== "boolean") return ctx.answerCallbackQuery();
    const ns = store.patchSettings({ [k]: !st[k] } as Partial<Settings>);
    store.event("info", `setting ${k} -> ${ns[k]}`);
    await ctx.answerCallbackQuery({ text: `${k}: ${ns[k] ? "ON" : "OFF"}` });
    const back = k.startsWith("gamble") ? await vGamble() : vSettings();
    await edit(ctx, back, k.startsWith("gamble") ? "gamble" : "set");
  });
  bot.callbackQuery(/^n:(\w+):(-?[\d.]+)$/, async (ctx) => {
    const k = ctx.match[1] as keyof Settings; const d = Number(ctx.match[2]); const st = store.settings();
    const limits: Record<string, [number, number]> = { arcadeDailyUsdCap: [0, 100], arcadeKeysPerRun: [1, 100], minPoolEvPerKey: [0.5, 2], worldBuysPerDay: [0, 10], gambleWagerPct: [0.01, 0.1], gambleMaxPerDay: [0, 20] };
    if (!(k in limits)) return ctx.answerCallbackQuery();
    const [lo, hi] = limits[k]; const v = Math.min(hi, Math.max(lo, Math.round(((st[k] as number) + d) * 100) / 100));
    store.patchSettings({ [k]: v } as Partial<Settings>);
    store.event("info", `setting ${k} -> ${v}`);
    await ctx.answerCallbackQuery({ text: `${k} = ${v}` });
    const back2 = k.startsWith("gamble") ? await vGamble() : vSettings();
    await edit(ctx, back2, k.startsWith("gamble") ? "gamble" : "set");
  });
  // market-making knobs (modal, jumlah item, unit, batas rugi)
  bot.callbackQuery(/^m:(\w+):(-?\d+)$/, async (ctx) => {
    const k = ctx.match[1] as keyof ReturnType<typeof market.cfg>; const d = Number(ctx.match[2]);
    const limits: Record<string, [number, number]> = { capitalValor: [0, 50_000], maxAssets: [1, 6], maxUnitsPerAsset: [1, 5], maxLossValor: [100, 10_000] };
    if (!(k in limits)) return ctx.answerCallbackQuery();
    const cur = market.cfg(); const [lo, hi] = limits[k];
    const v = Math.min(hi, Math.max(lo, (cur[k] as number) + d));
    market.setCfg({ [k]: v } as any);
    store.event("info", `mm setting ${k} -> ${v}`);
    await ctx.answerCallbackQuery({ text: `${k} = ${v}` });
    try { await edit(ctx, await vMarket(), "market"); } catch { /* unchanged */ }
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
  bot.callbackQuery("a:gameCheck", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Mengecek versi game…" });
    try { await gameWatch?.check(true); } catch (e: any) { await ctx.reply(`❌ ${esc(e.message)}`, { parse_mode: "HTML" }); }
    await edit(ctx, vSettings());
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
    const n = await market.cancelAll(); // bookkeeping-aware: cancelled orders must not be booked as fills
    market.setCfg({ enabled: false });
    await ctx.reply(resultCard("Order dibatalkan", `  ${n} order dibatalkan · market dimatikan\n  Modal tetap ${num(market.cfg().capitalValor)} VALOR — nyalakan lagi lewat ▶️ di menu 📈 Market`), { parse_mode: "HTML" });
  });
  const pendingDerby = new Map<string, { stake: number; exp: number }>();
  bot.callbackQuery(/^c:derby:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery(); const stake = Number(ctx.match[1]); const id = String(randomInt(1e9));
    pendingDerby.set(id, { stake, exp: Date.now() + 60_000 });
    await edit(ctx, { text: `${header("🐎", "RINGJAK RACING")}\n${row("Taruhan", `<b>${stake} VALOR</b> · lajur dipilih acak`)}\n${row("Bayaran", `juara 1 = <b>${stake * 3}</b> · juara 2 = <b>${Math.floor(stake * 0.8)}</b>`)}\n${row("Peluang", "25% juara 1 · 25% juara 2")}\n${footer("Rata-rata balik 95% — jangka panjang tetap rugi.")}`,
      kb: new InlineKeyboard().text(`✅ Balap ${stake}`, `x:derby:${id}`).text("❌ Batal", "v:gamble") });
  });
  bot.callbackQuery(/^x:derby:(\d+)$/, async (ctx) => {
    const p = pendingDerby.get(ctx.match[1]); pendingDerby.delete(ctx.match[1]);
    if (!p || p.exp < Date.now()) return ctx.answerCallbackQuery({ text: "Kedaluwarsa, ulangi.", show_alert: true });
    await ctx.answerCallbackQuery({ text: "Balapan…" });
    try {
      const r = await claims.lobbyDerby(p.stake);
      const won = r.delta > 0, label = r.outcome === "win" ? "🥇 Juara 1" : r.outcome === "place" ? "🥈 Juara 2" : "❌ Kalah";
      store.ledger("gamble_bet", 0, `lobby derby wager ${p.stake} VALOR`);
      store.ledger(won ? "gamble_win" : "gamble_loss", r.delta / 100, `lobby derby ${r.outcome} ${r.delta >= 0 ? "+" : ""}${r.delta} VALOR`);
      await ctx.reply(resultCard("Hasil balapan", `${row("Lajur", esc(r.lanes[r.lane]))}\n${row("Hasil", label)}\n${row("Perubahan", `<b>${r.delta >= 0 ? "+" : ""}${num(r.delta)} VALOR</b>`)}\n${row("Saldo VALOR", num(r.valor))}`), { parse_mode: "HTML" });
      cachedSnap = null;
    } catch (e: any) {
      const off = /404/.test(String(e.message));
      await ctx.reply(off ? "🔴 Ringjak Racing lobi sedang dimatikan server game (<code>lobbyDerby=false</code>). Taruhan tidak jadi, VALOR tidak terpotong." : `❌ ${esc(e.message)}`, { parse_mode: "HTML" });
    }
  });

  // link a personal wallet as the reward address: the game refuses a self-link, so the other wallet must sign
  const pendingLink = new Map<number, { address: string; message: string; exp: number }>();
  bot.callbackQuery("a:linkhow", async (ctx) => {
    await ctx.answerCallbackQuery();
    await edit(ctx, { text: `${header("🔗", "LINK WALLET — TIDAK DIPERLUKAN")}\n${row("Hasil tes server", "<code>403 LINK_WALLET_NOT_AGW</code>")}\n${row("Artinya", "link wallet hanya untuk akun Abstract Global Wallet (AGW)")}\n${row("Akun ini", "wallet biasa (EOA), jadi hadiah langsung ke wallet bot")}\n\n<i>Banner \"link a non-AGW wallet\" di web game ditujukan untuk pemain AGW: Deed WL mint di Robinhood chain yang tidak didukung AGW. Akun kita tidak terkena masalah itu.</i>\n${footer("Kalau nanti kamu pakai akun AGW: /link 0x… lalu /linksig 0x…")}`,
      kb: nav(new InlineKeyboard(), "v:wallet") });
  });
  bot.command("link", async (ctx) => {
    const addr = (ctx.match ?? "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return ctx.reply("✏️ Format: <code>/link 0xAlamatWalletKamu</code>", { parse_mode: "HTML" });
    if (addr.toLowerCase() === account.address.toLowerCase()) return ctx.reply("❌ Tidak bisa link wallet bot ke dirinya sendiri (server menolak: LINK_WALLET_SELF).", { parse_mode: "HTML" });
    try {
      const message = await claims.linkMessageFor(addr);
      pendingLink.set(ctx.chat!.id, { address: addr, message, exp: Date.now() + 10 * 60_000 });
      await ctx.reply(`${header("🔗", "TANDA TANGANI PESAN INI")}\n<pre>${esc(message)}</pre>\n${footer("Lalu kirim: /linksig 0x... (berlaku 10 menit)")}`, { parse_mode: "HTML" });
    } catch (e: any) { await ctx.reply(`❌ ${esc(e.message)}`, { parse_mode: "HTML" }); }
  });
  bot.command("linksig", async (ctx) => {
    const sig = (ctx.match ?? "").trim();
    const p = pendingLink.get(ctx.chat!.id);
    if (!p || p.exp < Date.now()) return ctx.reply("ℹ️ Belum ada permintaan link yang aktif. Mulai dengan <code>/link 0x...</code>", { parse_mode: "HTML" });
    if (!/^0x[0-9a-fA-F]{100,}$/.test(sig)) return ctx.reply("✏️ Format: <code>/linksig 0x...</code> (tanda tangan hasil Sign Message)", { parse_mode: "HTML" });
    try {
      const r = await claims.submitLink(p.address, p.message, sig);
      pendingLink.delete(ctx.chat!.id); cachedSnap = null;
      await ctx.reply(resultCard("Wallet ditautkan", row("Alamat", `<code>${esc(r.address)}</code>`)), { parse_mode: "HTML" });
    } catch (e: any) {
      const m = /LINK_WALLET_NOT_AGW/.test(String(e.message)) ? "ℹ️ Server hanya mengizinkan akun Abstract Global Wallet untuk menautkan wallet. Akun ini wallet biasa, jadi hadiah langsung masuk ke wallet bot."
        : /LINK_WALLET_SELF/.test(String(e.message)) ? "ℹ️ Tidak bisa menautkan wallet ke dirinya sendiri."
        : `❌ ${esc(e.message)}`;
      await ctx.reply(m, { parse_mode: "HTML" });
    }
  });
  bot.callbackQuery("c:unlink", async (ctx) => {
    await ctx.answerCallbackQuery();
    await edit(ctx, { text: `${header("⚠️", "LEPAS LINKED WALLET?")}\n${footer("Hadiah kembali diarahkan ke wallet bot.")}`,
      kb: new InlineKeyboard().text("✅ Lepas", "x:unlink").text("❌ Batal", "v:wallet") });
  });
  bot.callbackQuery("x:unlink", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Melepas…" });
    try { await claims.unlinkWallet(); cachedSnap = null; await edit(ctx, await vWallet(), "wallet"); }
    catch (e: any) { await ctx.reply(`❌ ${esc(e.message)}`, { parse_mode: "HTML" }); }
  });

  // private key export: owner-only, double confirmation, and the message deletes itself
  bot.callbackQuery("c:exportpk", async (ctx) => {
    await ctx.answerCallbackQuery();
    await edit(ctx, { text: `${header("⚠️", "EXPORT PRIVATE KEY")}\n${row("Risiko", "siapa pun yang punya kunci ini bisa menguras wallet")}\n${row("Telegram", "pesan tersimpan di server Telegram & semua perangkat yang login")}\n${row("Pengaman", "pesan otomatis dihapus 60 detik setelah dikirim")}\n${footer("Simpan offline (kertas/password manager), jangan di chat.")}`,
      kb: new InlineKeyboard().text("🔑 Tampilkan 60 detik", "x:exportpk").text("❌ Batal", "v:wallet") });
  });
  bot.callbackQuery("x:exportpk", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Mengambil kunci…" });
    try {
      const { readFileSync } = await import("node:fs");
      const w = JSON.parse(readFileSync(process.env.WALLET_PATH ?? "secrets/wallet.json", "utf8"));
      const m = await ctx.reply(`${header("🔑", "PRIVATE KEY")}\n${row("Alamat", `<code>${esc(w.address)}</code>`)}\n<code>${esc(w.privateKey)}</code>\n\n<i>Pesan ini terhapus dalam 60 detik.</i>`, { parse_mode: "HTML" });
      store.event("warn", "private key exported to Telegram");
      setTimeout(() => { ctx.api.deleteMessage(m.chat.id, m.message_id).catch(() => {}); }, 60_000).unref?.();
    } catch (e: any) { await ctx.reply(`❌ ${esc(e.message)}`, { parse_mode: "HTML" }); }
  });

  const pendingValor = new Map<string, { usd: number; exp: number }>();
  bot.callbackQuery(/^c:valor:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery(); const usdAmt = Number(ctx.match[1]); const id = String(randomInt(1e9));
    pendingValor.set(id, { usd: usdAmt, exp: Date.now() + 60_000 });
    await edit(ctx, { text: `${header("⚠️", "SETOR USDC.e → VALOR")}\n${row("Jumlah", `<b>${usdAmt} USDC.e → ${num(usdAmt * 100)} VALOR</b>`)}\n${row("Saldo wallet", `${(await abs.balances().catch(() => null))?.usdcFmt ?? "?"} USDC.e`)}\n${row("Biaya", "gas saja, tanpa fee")}\n${footer("Modal market diatur lewat tombol ± di 📈 Market. Tarik balik: min 500 VALOR, fee 5%, cair 24 jam.")}`,
      kb: new InlineKeyboard().text("✅ Setor", `x:valor:${id}`).text("❌ Batal", "v:wallet") });
  });
  bot.callbackQuery(/^x:valor:(\d+)$/, async (ctx) => {
    const p = pendingValor.get(ctx.match[1]); pendingValor.delete(ctx.match[1]);
    if (!p || p.exp < Date.now()) return ctx.answerCallbackQuery({ text: "Kedaluwarsa, ulangi.", show_alert: true });
    await ctx.answerCallbackQuery({ text: "Menyetor…" });
    try {
      const r = await claims.depositValorUsd(p.usd); store.ledger("valor_topup", p.usd, "manual deposit", r.hash); cachedSnap = null;
      await ctx.reply(resultCard("VALOR masuk", `${row("Saldo VALOR", `<b>${num(r.valor)}</b>`)}\n${row("Tx", `<code>${r.hash}</code>`)}`), { parse_mode: "HTML" });
    } catch (e: any) { await ctx.reply(`❌ ${esc(e.shortMessage ?? e.message)}`, { parse_mode: "HTML" }); }
  });

  bot.callbackQuery("a:sellLoot", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Melisting loot…" });
    const keep = ["key.expedition", "pass.adventurer_mint", "item.golden_corn", ...(store.settings().autoWorld ? ["key.world"] : [])];
    try { await market.sellLoot(keep); await edit(ctx, await vInv(), "inv"); }
    catch (e: any) { await ctx.reply(`❌ ${esc(e.message)}`, { parse_mode: "HTML" }); }
  });
  bot.callbackQuery("a:redeem", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Menukar worldseed…" });
    try {
      const r = await claims.redeemCaches(false);
      const o = await claims.openCaches(false);            // a cache is only worth something once it is opened
      const sb = await claims.openSkinBoxes().catch(() => null);
      if (!r && !o) return void ctx.reply("ℹ️ Worldseed belum cukup (butuh 500 per cache) dan tidak ada cache yang belum dibuka.", { parse_mode: "HTML" });
      await ctx.reply(resultCard("Cache", [
        r ? row("Ditukar", `${r.count} World's Eve Cache · sisa worldseed ${num(r.amber ?? 0)}`) : "",
        o ? row("Dibuka", `${o.opened} cache`) : "",
        ...(o?.rewards ?? []).map((x: any) => `     ◦ ${x.qty}× ${esc(x.name)}`),
        sb ? row("Kotak skin", sb.map((x: any) => `${x.opened}× ${esc(x.boxType)} → ${x.skins} skin`).join(", ")) : "",
      ].filter(Boolean).join("\n")), { parse_mode: "HTML" });
      if (store.settings().autoSellLoot) await market.sellLoot(["key.expedition", "pass.adventurer_mint", "item.golden_corn", ...(store.settings().autoWorld ? ["key.world"] : [])]).catch(() => {});
    } catch (e: any) { await ctx.reply(`❌ ${esc(e.message)}`, { parse_mode: "HTML" }); }
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
      // Always pay in VALOR (100/key, no gas); USDC.e only covers the shortfall. A manual purchase from here is
      // the owner's own decision, so it is not held back by the market-capital or withdraw reserves the way the
      // autopilot's buying is — those exist to stop automation quietly draining the float.
      const st = store.settings();
      const v = await claims.buyArcadeKeys(p.qty, { reserveValor: 0, keepUsdc: st.worldUsdcReserve });
      store.ledger("buy_keys", v.valorSpent / 100, `${p.qty} arcade keys (VALOR${v.depositedUsd ? ` + $${v.depositedUsd} top-up` : ""}, manual)`, v.depositTx);
      cachedSnap = null;
      await ctx.reply(resultCard("Pembelian key", `${row("Dibeli", `${p.qty} key`)}\n${row("Bayar", `${num(v.valorSpent)} VALOR${v.depositedUsd ? ` (tambal $${v.depositedUsd} dari USDC.e)` : " · tanpa gas"}`)}\n${row("Saldo Arcade key", `<b>${v.keys}</b>`)}\n${row("Sisa VALOR", num(v.valor))}`), { parse_mode: "HTML" });
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
  // Recycling burns 5 skins for one new roll. It cannot be undone and skins have no resale value anywhere,
  // so it stays manual — the autopilot never touches it.
  bot.callbackQuery("c:recycle", async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = await claims.skins();
    await edit(ctx, { text: `${header("⚠️", "DAUR ULANG SKIN")}\n${row("Dibakar", `<b>5 skin</b> dari ${s.ownedSkins.length} yang dimiliki`)}\n${row("Dapat", "1 roll skin baru (acak)")}\n${footer("Permanen, tidak bisa dibatalkan. Skin tidak bisa dijual di mana pun.")}`,
      kb: new InlineKeyboard().text("✅ Daur ulang", "x:recycle").text("❌ Batal", "v:inv") });
  });
  bot.callbackQuery("x:recycle", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "♻️ Mendaur ulang…" });
    try {
      const r = await claims.recycleSkins();
      if (!r) return ctx.reply("ℹ️ Skin kurang dari 5, tidak bisa didaur ulang.");
      store.event("info", `recycled skins ${r.used}: ${JSON.stringify(r.reward).slice(0, 200)}`);
      await ctx.reply(resultCard("Daur ulang skin", [row("Dibakar", `${r.used} skin`), row("Hasil", `<code>${esc(JSON.stringify(r.reward).slice(0, 200))}</code>`)].join("\n")), { parse_mode: "HTML" });
    } catch (e: any) { await ctx.reply(`❌ Gagal: ${esc(e.shortMessage ?? e.message)}`, { parse_mode: "HTML" }); }
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
