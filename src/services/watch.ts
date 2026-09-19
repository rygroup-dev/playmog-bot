// Background watchers that must not wait for a long run to finish (the autopilot tick is busy while a run plays):
//  - GameWatch: detects new game deploys (/api/status), client APP_VERSION bumps and enemy-rule changes in the
//    live client bundle, follows them automatically and notifies the owner with exactly what changed.
//  - FundWatch: notices new funds on Abstract and executes the owner's pre-approved market top-up plan once.
import { createHash } from "node:crypto";
import { MOG_BASE, UA, APP_VERSION, setAppVersion } from "../mog/api.js";
import { ENEMIES, type EnemyCfg } from "../game/model.js";
import type { AbstractOps } from "../chain/abstract.js";
import type { ClaimsService } from "./claims.js";
import type { MarketMaker } from "./market.js";
import type { Store } from "../db.js";

type Notify = (t: string, level?: string) => Promise<void> | void;
const get = async (url: string) => {
  const r = await fetch(url, { headers: { "user-agent": UA, "cache-control": "no-cache" }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r;
};
const short = (s?: string | null) => (s ? s.slice(0, 7) : "?");

/** Parse `v2_x:{spriteType:"v2_x",hp:15,…,randomMove:!0}` entries of the client's V2_ENEMY_CONFIGS. */
export function parseEnemyConfigs(js: string): Record<string, EnemyCfg> {
  const out: Record<string, any> = {};
  for (const m of js.matchAll(/(v2_\w+):\{spriteType:"\1",([^{}]*)\}/g)) {
    const cfg: any = { spriteType: m[1] };
    for (const f of m[2].matchAll(/(\w+):("[^"]*"|!0|!1|-?[\d.]+)/g)) {
      const v = f[2];
      cfg[f[1]] = v === "!0" ? true : v === "!1" ? false : v.startsWith('"') ? v.slice(1, -1) : Number(v);
    }
    out[m[1]] = cfg;
  }
  return out;
}

/** Human-readable diff of enemy rules (only the fields our AI uses). */
export function diffEnemies(oldCfg: Record<string, any>, newCfg: Record<string, any>): string[] {
  const fields = ["hp", "damage", "damageMax", "attackRange", "chargeTurns", "restTurns", "attackKind", "aggroRange", "moveEveryNTurns", "fleeFromPlayer", "randomMove"];
  const lines: string[] = [];
  for (const [id, n] of Object.entries(newCfg)) {
    const o = oldCfg[id];
    if (!o) { lines.push(`➕ ${id} (musuh baru)`); continue; }
    const ch = fields.filter((f) => o[f] !== n[f]).map((f) => `${f} ${o[f] ?? "-"}→${n[f] ?? "-"}`);
    if (ch.length) lines.push(`✏️ ${id}: ${ch.join(", ")}`);
  }
  for (const id of Object.keys(oldCfg)) if (!newCfg[id]) lines.push(`➖ ${id} (dihapus)`);
  return lines;
}

interface GameState { rev: string | null; deploy: string | null; appVersion: string; rulesHash: string | null; paused: boolean;
  checkedAt: number; changedAt: number; history: { at: number; rev: string | null; appVersion: string; changes: string[] }[] }

export class GameWatch {
  lastError: string | null = null;
  constructor(private store: Store, private notify: Notify, private log: (m: string) => void, private market?: MarketMaker) {
    // re-apply rule changes learned from the live client before the first game action
    Object.assign(ENEMIES, this.store.get<Record<string, EnemyCfg>>("game.enemyOverrides", {}));
    const s = this.state(); if (s.appVersion && s.appVersion !== APP_VERSION && Number(s.appVersion) > Number(APP_VERSION)) setAppVersion(s.appVersion);
  }
  state(): GameState {
    return { rev: null, deploy: null, appVersion: APP_VERSION, rulesHash: null, paused: false, checkedAt: 0, changedAt: 0, history: [], ...this.store.get<Partial<GameState>>("game.watch", {}) };
  }

  /** Scan the live client bundle: APP_VERSION + enemy rules. */
  async scanClient() {
    const html = await (await get(MOG_BASE + "/")).text();
    const chunks = [...new Set(html.match(/\/_next\/static\/[A-Za-z0-9_/.-]+\.js/g) ?? [])];
    let appVersion: string | null = null, enemies: Record<string, EnemyCfg> | null = null, rulesHash: string | null = null;
    for (const c of chunks) {
      if (appVersion && enemies) break;
      const js = await (await get(MOG_BASE + c)).text().catch(() => "");
      const v = js.match(/APP_VERSION",0,(\d+)/); if (v) appVersion = v[1];
      if (!enemies && js.includes("V2_ENEMY")) {
        const parsed = parseEnemyConfigs(js);
        if (Object.keys(parsed).length >= 5) { enemies = parsed; rulesHash = createHash("sha256").update(JSON.stringify(parsed)).digest("hex").slice(0, 12); }
      }
    }
    return { appVersion, enemies, rulesHash, chunkCount: chunks.length };
  }

  async check(force = false) {
    const st = await (await get(MOG_BASE + "/api/status")).json() as { paused?: boolean; sourceRevision?: string; vercelDeploymentId?: string };
    const s = this.state(); const now = Date.now();
    const deployed = st.sourceRevision !== s.rev || st.vercelDeploymentId !== s.deploy;
    const changes: string[] = [];

    if (!!st.paused !== s.paused) {
      changes.push(st.paused ? "⏸ Server game sedang PAUSE (maintenance)" : "▶️ Server game aktif lagi");
      await this.notify(st.paused ? "⏸ <b>Server game PAUSE</b> — kemungkinan maintenance/update. Bot menunggu, lalu lanjut sendiri." : "▶️ <b>Server game aktif lagi</b>.", "warn");
    }
    if (deployed || force || !s.rulesHash) {
      const c = await this.scanClient();
      const first = !s.rev;
      if (c.appVersion && c.appVersion !== APP_VERSION) {
        changes.push(`Versi client ${APP_VERSION} → <b>${c.appVersion}</b> (bot sudah ikut)`);
        this.log(`game: client version ${APP_VERSION} -> ${c.appVersion}`); setAppVersion(c.appVersion);
      }
      if (c.enemies && c.rulesHash !== s.rulesHash) {
        const diff = diffEnemies(ENEMIES, c.enemies);
        if (diff.length) {
          changes.push(`Aturan musuh berubah (${diff.length}), AI sudah pakai angka baru:\n${diff.slice(0, 12).map((l) => "   " + l).join("\n")}${diff.length > 12 ? `\n   …+${diff.length - 12} lagi` : ""}`);
          Object.assign(ENEMIES, c.enemies);
          this.store.set("game.enemyOverrides", c.enemies);
          this.store.event("warn", `enemy rules changed: ${diff.join("; ")}`);
        }
      } else if (!c.enemies) changes.push("⚠️ Tabel musuh tidak ditemukan di client baru — struktur game mungkin berubah, perlu dicek manual");

      const next: GameState = { ...s, rev: st.sourceRevision ?? null, deploy: st.vercelDeploymentId ?? null, appVersion: APP_VERSION, rulesHash: c.rulesHash ?? s.rulesHash, paused: !!st.paused, checkedAt: now, changedAt: deployed && !first ? now : s.changedAt };
      if (deployed && !first) {
        next.history = [{ at: now, rev: next.rev, appVersion: APP_VERSION, changes }, ...s.history].slice(0, 10);
        this.store.event("info", `game deploy ${short(s.rev)} → ${short(next.rev)}${changes.length ? ": " + changes.join(" | ").replace(/<[^>]+>/g, "") : ""}`);
        const ms = this.market?.status(); const lbl = (v: boolean | null | undefined) => v === false ? "🔴 tutup" : v ? "🟢 buka" : "?";
        const mkt = ms ? `order limit ${lbl(ms.gtc)} · beli instan ${lbl(ms.fok)}` : "-";
        await this.notify([
          "🆕 <b>UPDATE GAME TERDETEKSI</b>",
          `Deploy <code>${short(s.rev)}</code> → <code>${short(next.rev)}</code>`,
          `Versi client: <b>${APP_VERSION}</b>`,
          changes.length ? changes.map((l) => "• " + l).join("\n") : "• Tidak ada perubahan versi client / aturan musuh — bot jalan seperti biasa",
          `Market: ${mkt}`,
          "Kalau game menambah fitur baru, kabari saya untuk dicek & ditambahkan ke bot.",
        ].join("\n"), "warn");
      }
      this.store.set("game.watch", next);
    } else {
      this.store.set("game.watch", { ...s, paused: !!st.paused, checkedAt: now });
    }
    this.lastError = null;
    return this.state();
  }
}

/** Owner-approved one-shot plan: when new USDC.e lands, move `marketUsd` into VALOR and raise market capital. */
export interface FundPlan { marketUsd: number; targetCapitalValor: number; targetMaxAssets: number; baselineUsdc: number; createdAt: number; doneAt?: number; tx?: string }

export class FundWatch {
  private last: { eth: bigint; usdc: bigint } | null = null;
  constructor(private store: Store, private abs: AbstractOps, private claims: ClaimsService, private market: MarketMaker, private notify: Notify, private log: (m: string) => void) {}

  plan() { return this.store.get<FundPlan | null>("fund.plan", null); }
  async setPlan(marketUsd: number, targetCapitalValor: number, targetMaxAssets = 3) {
    const b = await this.abs.balances();
    const p: FundPlan = { marketUsd, targetCapitalValor, targetMaxAssets, baselineUsdc: Number(b.usdc) / 1e6, createdAt: Date.now() };
    this.store.set("fund.plan", p); return p;
  }

  async check() {
    const b = await this.abs.balances();
    if (this.last) {
      const dUsdc = Number(b.usdc - this.last.usdc) / 1e6, dEth = Number(b.eth - this.last.eth) / 1e18;
      if (dUsdc >= 1) await this.notify(`💵 <b>Dana masuk</b>: +${dUsdc.toFixed(2)} USDC.e di Abstract · saldo ${b.usdcFmt}`);
      if (dEth >= 0.0005) await this.notify(`💵 <b>Dana masuk</b>: +${dEth.toFixed(5)} ETH di Abstract · swap ke USDC.e lewat 👛 Wallet bila perlu`);
    }
    this.last = { eth: b.eth, usdc: b.usdc };

    const p = this.plan();
    if (!p || p.doneAt) return;
    const usdc = Number(b.usdc) / 1e6;
    if (usdc - p.baselineUsdc < p.marketUsd || usdc < p.marketUsd) return; // wait for the new deposit
    this.store.set("fund.plan", { ...p, doneAt: Date.now() });                 // mark first: never deposit twice
    try {
      const r = await this.claims.depositValorUsd(p.marketUsd);
      const cfg = this.market.cfg();
      this.market.setCfg({ capitalValor: Math.max(cfg.capitalValor, p.targetCapitalValor), maxAssets: Math.max(cfg.maxAssets, p.targetMaxAssets) });
      this.store.ledger("mm_capital", p.marketUsd, "market capital top-up (plan)", r.hash);
      this.store.set("fund.plan", { ...p, doneAt: Date.now(), tx: r.hash });
      await this.notify([
        "🏪 <b>Modal market ditambah</b>",
        `Setor ${p.marketUsd} USDC.e → ${p.marketUsd * 100} VALOR · saldo VALOR ${r.valor}`,
        `Modal market sekarang <b>${p.targetCapitalValor} VALOR (≈$${p.targetCapitalValor / 100})</b> · maks ${Math.max(cfg.maxAssets, p.targetMaxAssets)} item`,
        `Sisa USDC.e ${(usdc - p.marketUsd).toFixed(2)} tetap di wallet.`,
        `<code>${r.hash}</code>`,
      ].join("\n"));
    } catch (e: any) {
      this.log(`fund plan deposit failed: ${e.message}`);
      await this.notify(`❌ <b>Top-up modal market gagal</b>: ${e.shortMessage ?? e.message}\nCek saldo sebelum mencoba lagi (jangan setor dua kali).`, "error");
    }
  }
}

export function startWatchers(w: { game: GameWatch; fund: FundWatch; market?: MarketMaker }, log: (m: string) => void) {
  const run = (name: string, fn: () => Promise<unknown>) => fn().catch((e) => log(`${name}: ${e?.message ?? e}`));
  void run("game-watch", () => w.game.check());
  void run("fund-watch", () => w.fund.check());
  const t1 = setInterval(() => void run("game-watch", () => w.game.check()), 5 * 60_000);
  const t2 = setInterval(() => void run("fund-watch", () => w.fund.check()), 2 * 60_000);
  const probe = () => w.market ? run("market-probe", () => w.market!.probeStatus()) : Promise.resolve();
  void probe(); const t3 = setInterval(() => void probe(), 5 * 60_000); // market open/closed detection
  return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3); };
}
