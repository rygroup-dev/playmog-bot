// Autopilot: free-value tasks (daily keys, upvote, quests) + Expedition autoplay + EV-gated Arcade.
import { MogApi, MogApiError, sleep } from "../mog/api.js";
import { AbstractOps } from "../chain/abstract.js";
import { Store } from "../db.js";
import { playRun, type RunSummary, type RunType } from "../game/runner.js";
import { DEFAULT_POLICY } from "../game/policy.js";
import { ClaimsService } from "./claims.js";
import { MarketMaker } from "./market.js";

export interface Notifier { (text: string, level?: "info" | "warn" | "error"): Promise<void> | void }

export class Autopilot {
  running: { runId: string; runType: RunType; startedAt: number; last?: string; floor?: number; energy?: number; treasure?: number } | null = null;
  private stopRequested = false;
  private tickBusy = false;
  private timer: NodeJS.Timeout | null = null;
  lastTickAt = 0; lastError: string | null = null;

  private lastSlowTick = 0;
  constructor(private api: MogApi, private abs: AbstractOps, private store: Store, private notify: Notifier, private log: (m: string) => void, readonly claims?: ClaimsService, readonly market?: MarketMaker) {}

  start(intervalMs = 60_000) { this.timer = setInterval(() => void this.tick(), intervalMs); void this.tick(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.requestStopRun(); }
  requestStopRun() { this.stopRequested = true; }

  async tick() {
    if (this.tickBusy) return;
    this.tickBusy = true; this.lastTickAt = Date.now();
    try {
      const st = this.store.settings();
      if (st.paused) return;
      if (st.autoDaily) await this.safe("daily-claim", () => this.claimDaily());
      if (st.autoUpvote) await this.safe("upvote", () => this.upvote());
      await this.safe("quests", () => this.claimQuests());
      if (this.market) await this.safe("market", () => this.market!.tick());
      if (Date.now() - this.lastSlowTick > 30 * 60_000) { // money claims + reminders every 30 min
        this.lastSlowTick = Date.now();
        await this.safe("weekly-claim", () => this.autoClaims());
        await this.safe("pass-reminder", () => this.passReminder());
        await this.safe("daily-report", () => this.dailyReport());
        await this.safe("corn-raffle", () => this.autoRaffle());
      }
      // resume any run left open (crash/restart) before starting new ones
      for (const t of ["EXPEDITION", "NORMAL"] as RunType[]) {
        const a = await this.api.get(`/api/runs/active?runType=${t}`);
        if (a.activeRun) { await this.play(a.activeRun.id, t, true); return; }
      }
      if (st.autoExpedition) {
        const exp = (await this.api.get("/api/items/expedition-keys")).balance ?? 0;
        if (exp > st.expeditionReserveKeys) { await this.createAndPlay("EXPEDITION", 1); return; }
      }
      if (st.autoArcade) await this.safe("arcade", () => this.maybeArcade());
      this.lastError = null;
    } catch (e: any) {
      this.lastError = String(e?.message ?? e);
      this.store.event("error", `tick: ${this.lastError}`);
      this.log(`tick error: ${this.lastError}`);
    } finally { this.tickBusy = false; }
  }

  private async safe(name: string, fn: () => Promise<unknown>) {
    try { await fn(); } catch (e: any) { const m = `${name}: ${e?.shortMessage ?? e?.message ?? e}`; this.store.event("warn", m); this.log(m); }
  }

  /** Free money only costs gas: weekly pool payout, jackpot, finished VALOR withdrawals. */
  async autoClaims() {
    if (!this.claims) return;
    const w = await this.claims.claimWeekly();
    if (w) { this.store.event("info", `weekly claim ${w.weeks.join(",")} tx ${w.hash}`); await this.notify(`💸 <b>Payout mingguan diklaim</b>\nMinggu ${w.weeks.join(", ")} · ${w.total} · <code>${w.hash}</code>`); }
    const j = await this.claims.claimJackpot();
    if (j) { this.store.event("info", `jackpot claim tx ${j.hash}`); await this.notify(`🎰 <b>Jackpot diklaim</b> ${j.totalAmount} · <code>${j.hash}</code>`); }
    // auto-withdraw VALOR above the reserve (reserve = next pass, so the 5% fee is not paid twice)
    const st = this.store.settings();
    if (st.autoWithdraw) {
      const valor = Number((await this.api.get("/api/shop/valor/balance")).valorBalance);
      const pend = await this.api.get("/api/shop/valor/pending");
      const mm = this.market?.cfg();
      const amount = valor - st.withdrawReserveValor - (mm?.enabled ? mm.capitalValor : 0); // never withdraw market capital
      if (!pend?.pending && amount >= 500) {
        const r = await this.claims.initiateWithdrawal(amount);
        this.store.ledger("withdraw", -r.netUsdc, `auto ${amount} VALOR`, r.hash);
        await this.notify(`🏦 <b>Tarik VALOR otomatis</b>: ${amount} VALOR → ≈$${r.netUsdc.toFixed(2)} USDC.e\nCair otomatis dalam 24 jam.`);
      }
    }
    const f = await this.claims.finalizeWithdrawalIfReady();
    if (f) { this.store.ledger("withdraw", 0, "VALOR withdrawal finalized", f.hash); await this.notify(`🏦 <b>Penarikan VALOR selesai</b> — USDC.e masuk wallet\n<code>${f.hash}</code>`); }
  }

  /**
   * Golden Corn has one sensible use for us: the Yield Fields WL raffle (the Silo leaderboard needs ~44k corn).
   * Tickets are entered in the last 3h before entry closes so every corn farmed until then counts.
   */
  async autoRaffle() {
    if (!this.claims) return;
    for (const pool of ["goldenCorn", "eveKeys"] as const) {
      const r = await this.claims.raffleStatus(pool);
      const left = new Date(r.entryCloseTime).getTime() - Date.now();
      if (r.ticketBalance > 0 && left > 0 && left < 3 * 3600e3) {
        await this.claims.enterRaffle(pool, r.ticketBalance);
        const after = await this.claims.raffleStatus(pool);
        this.store.event("info", `raffle ${pool}: entered ${r.ticketBalance}`);
        await this.notify(`🎟 <b>Undian ${pool === "goldenCorn" ? "Golden Corn" : "Eve Key"} (WL Yield Fields)</b>\nMasuk ${r.ticketBalance} tiket · total tiket kita ${after.userEntries} · peluang ≥1 WL ≈ ${(after.chanceAtLeastOne * 100).toFixed(1)}%\nDiundi ${new Date(r.drawTime).toISOString().slice(0, 16).replace("T", " ")} UTC`);
      }
    }
  }

  /** One summary per UTC day (sent on the first slow tick after 00:00 UTC). */
  async dailyReport() {
    const day = new Date().toISOString().slice(0, 10);
    if (this.store.get("lastDailyReport", "") === day) return;
    this.store.set("lastDailyReport", day);
    const since = Date.now() - 24 * 3600e3;
    const runs = this.store.runStatsSince(since);
    const lines = [`📰 <b>LAPORAN HARIAN</b> · ${day}`, "━━━━━━━━━━━━━━━━━━━━",
      ...(runs.length ? runs.map((r: any) => `  ◦ ${r.run_type}: ${r.n} run · 💎${r.treasure} · 🔮${r.marbles} · best ${r.best} (f${r.best_floor})`) : ["  ◦ belum ada run 24 jam terakhir"])];
    if (this.market) {
      const m = await this.market.report();
      const days = Math.max(0.01, (Date.now() - m.state.startedAt) / 864e5);
      lines.push(`\n<b>📈 Market</b> ${m.cfg.enabled ? "aktif" : "mati"}${m.state.halted ? " (HALTED)" : ""}`,
        `  ◦ Profit terealisasi: <b>${Math.round(m.state.realized)} VALOR</b> ($${(m.state.realized / 100).toFixed(2)}) · ${m.state.fills} fill · ${days.toFixed(1)} hari`,
        `  ◦ Belum terealisasi: ${m.unrealized} VALOR`,
        ...m.lines.map((l: any) => `  ◦ ${l.name}: stok ${l.qty}${l.qty ? ` @${l.cost}` : ""} · ${l.orders.join(", ") || "tanpa order"}`));
    }
    lines.push(`\n<i>Belanja 24 jam: $${this.store.spentSince(since, ["buy_keys", "pass", "swap_fee"]).toFixed(2)}</i>`);
    await this.notify(lines.join("\n"));
  }

  /** Pass expiry reminders at 48h / 24h / 6h (each sent once per pass period). */
  async passReminder() {
    const pass = await this.api.get("/api/shop/pass");
    if (!pass?.isActive || !pass.expiresAt) return;
    const left = new Date(pass.expiresAt).getTime() - Date.now();
    const sent = this.store.get<Record<string, boolean>>("passReminders", {});
    for (const h of [48, 24, 6]) {
      const k = `${pass.expiresAt}:${h}`;
      if (left <= h * 3600e3 && left > 0 && !sent[k]) {
        sent[k] = true; this.store.set("passReminders", sent);
        await this.notify(`⏰ <b>Expedition Pass ${pass.tier} habis dalam ${Math.max(1, Math.round(left / 3600e3))} jam</b>\nPerpanjang lewat menu 🎫 Pass agar key harian & loot Expedition tidak terputus.`, "warn");
        break;
      }
    }
  }

  async claimDaily() {
    const pass = await this.api.get("/api/shop/pass");
    if (!pass.isActive || !(pass.dailyClaimable > pass.dailyClaimedToday)) return null;
    const r = await this.api.post("/api/shop/pass/daily-claim");
    this.store.event("info", `daily claim +${r.claimed} expedition keys`);
    await this.notify(`🎁 Klaim harian: +${r.claimed} Expedition key`);
    return r;
  }

  async upvote() {
    const up = await this.api.get("/api/upvote/record");
    if (up.claimed) return null;
    const bal = await this.abs.balances();
    if (bal.eth < 20_000_000_000_000n) { await this.notify("⚠️ ETH di Abstract kurang untuk gas upvote (<0.00002).", "warn"); return null; }
    let tx: string | null = null;
    try { tx = await this.abs.upvote(); }
    catch (e: any) { this.log(`vote tx failed (may already be voted on-chain this epoch): ${e?.shortMessage ?? e?.message}`); }
    const r = await this.api.post("/api/upvote/record");
    this.store.event("info", `upvote epoch ${up.epoch} -> +${r.reward} keys ${tx ?? ""}`);
    await this.notify(`🗳 Upvote epoch ${up.epoch}: +${r.reward} Expedition key`);
    return r;
  }

  async claimQuests() {
    const board = await this.api.get("/api/quests/board");
    const all = [...(board.daily?.quests ?? []), ...(board.weekly?.quests ?? []), ...(board.event?.quests ?? [])];
    for (const q of all) {
      const done = q.claimable ?? (q.completed && !q.claimed) ?? (q.progress >= (q.target ?? q.goal ?? Infinity) && !q.claimed);
      if (!done || q.claimed || q.locked) continue;
      try { await this.api.post("/api/quests/claim", { questKey: q.questKey ?? q.key }); await this.notify(`✅ Quest diklaim: ${q.title ?? q.questKey ?? q.key}`); }
      catch (e: any) { this.log(`quest claim ${q.questKey ?? q.key}: ${e.message}`); }
    }
  }

  /** Arcade only when the live pool pays >= minPoolEvPerKey per 1 USDC key and within the daily cap. */
  async maybeArcade() {
    const st = this.store.settings();
    const cw = (await this.api.get("/api/claims")).currentWeek;
    const vpt = Number(cw.pool) / Math.max(1, Number(cw.totalTreasure));
    // EV must use OUR bot's measured treasure per key (last Arcade runs), not the top players' ~3200.
    // Without 3+ measured runs we assume a conservative 500 → effectively never buys.
    const own = this.store.arcadeTreasurePerKey();
    const evPerKey = (vpt * (own?.perKey ?? 500)) / 100;
    if (evPerKey < st.minPoolEvPerKey) return;
    const dayStart = Date.now() - 24 * 3600_000;
    const spent = this.store.spentSince(dayStart, ["buy_keys"]);
    const qty = st.arcadeKeysPerRun;
    if (spent + qty > st.arcadeDailyUsdCap) return;
    const have = (await this.api.get("/api/keys/balance")).balance ?? 0;
    if (have < qty) {
      const need = BigInt(qty - have);
      const { hash, price } = await this.abs.buyKeys(need);
      this.store.ledger("buy_keys", Number(price * need) / 1e6, `${need} arcade keys`, hash);
      for (let i = 0; i < 10; i++) { // backend credits purchases by tx
        try { await this.api.post("/api/keys/process-purchase", { txHash: hash }); break; } catch { await sleep(3000); }
      }
    }
    await this.createAndPlay("NORMAL", qty);
  }

  async createAndPlay(runType: RunType, keys: number) {
    const c = await this.api.post("/api/runs/create", { keysAmount: keys, runType });
    this.store.event("info", `created ${runType} run ${c.runId} keys=${keys}`);
    await this.play(c.runId, runType, false);
  }

  private async play(runId: string, runType: RunType, resumed: boolean) {
    if (this.running) return;
    this.stopRequested = false;
    const startedAt = Date.now();
    this.running = { runId, runType, startedAt };
    if (resumed) await this.notify(`♻️ Melanjutkan run ${runType} ${runId.slice(-6)}`);
    let summary: RunSummary | null = null;
    try {
      summary = await playRun(this.api, runId, runType, {
        log: this.log, shouldStop: () => this.stopRequested,
        onTurn: ({ g, reason }) => { if (this.running) Object.assign(this.running, { last: reason, floor: g.currentFloor, energy: g.player.energy, treasure: g.player.treasure }); },
      }, { ...DEFAULT_POLICY, acceptRooms: this.store.settings().acceptRooms });
      this.store.saveRun(summary, startedAt);
      if (this.store.settings().notifyEveryRun || summary.endReason !== "game_over") await this.notify(formatRun(summary));
    } catch (e: any) {
      const m = e instanceof MogApiError ? `${e.status} ${e.code}` : String(e?.message ?? e);
      this.store.event("error", `run ${runId}: ${m}`);
      await this.notify(`❌ Run ${runType} ${runId.slice(-6)} error: ${m}`, "error");
    } finally { this.running = null; }
    return summary;
  }
}

export function formatRun(s: RunSummary) {
  const loot = Object.entries(s.lootEvents).filter(([k]) => !/orb/.test(k));
  const name: Record<string, string> = { treasure: "💎 Treasure", marble: "🔮 Marble", golden_corn: "🌽 Golden Corn", arcade_key: "🗝 Arcade key", raffle_ticket: "🎟 Raffle", gem: "💠 Gem", jackpot: "🎰 Jackpot" };
  const ok = s.endReason === "game_over";
  return [
    `${ok ? "🏁" : "⚠️"} <b>RUN ${s.runType} SELESAI</b>  <code>${s.runId.slice(-8)}</code>`,
    "━━━━━━━━━━━━━━━━━━━━",
    `  ◦ Floor: <b>${s.floor}</b> · Level ${s.level} · ${s.turns} turn`,
    `  ◦ Treasure: <b>${s.treasure.toLocaleString("en-US")}</b>`,
    `  ◦ Marbles: <b>${s.marbles}</b> · Arcade key: <b>${s.arcadeKeys}</b>`,
    `  ◦ Kill: ${s.kills} · Damage diterima: ${s.damageTaken}`,
    loot.length ? `  ◦ Loot: ${loot.map(([k, v]) => `${name[k] ?? k} ${v}`).join(" · ")}` : "",
    `  ◦ Latensi rata-rata: ${s.avgRttMs} ms`,
    ok ? "" : `\n<i>Alasan berhenti: ${s.endReason.replace(/[<>&]/g, "")}</i>`,
  ].filter(Boolean).join("\n");
}
