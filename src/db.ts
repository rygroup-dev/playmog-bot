import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Settings = {
  autoDaily: boolean; autoUpvote: boolean; autoExpedition: boolean; autoArcade: boolean;
  arcadeKeysPerRun: number; arcadeDailyUsdCap: number; minPoolEvPerKey: number;
  expeditionReserveKeys: number; notifyEveryRun: boolean; paused: boolean; acceptRooms: string[];
  autoWithdraw: boolean; withdrawReserveValor: number;
};
export const DEFAULT_SETTINGS: Settings = {
  autoDaily: true, autoUpvote: true, autoExpedition: true, autoArcade: false,
  arcadeKeysPerRun: 1, arcadeDailyUsdCap: 5, minPoolEvPerKey: 1.0,
  expeditionReserveKeys: 0, notifyEveryRun: true, paused: false, acceptRooms: ["shrine", "armory", "jackalot"],
  autoWithdraw: true, withdrawReserveValor: 1000,
};

export class Store {
  db: Database.Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, run_type TEXT, keys_used INT, started_at INT, ended_at INT,
        floor INT, treasure INT, marbles INT, arcade_keys INT, kills INT, level INT, turns INT, damage INT, end_reason TEXT, loot TEXT);
      CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INT, kind TEXT, usd REAL, detail TEXT, tx TEXT);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INT, level TEXT, msg TEXT);`);
  }
  get<T>(k: string, def: T): T { const r = this.db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined; return r ? JSON.parse(r.v) : def; }
  set(k: string, v: unknown) { this.db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, JSON.stringify(v)); }
  settings(): Settings { return { ...DEFAULT_SETTINGS, ...this.get<Partial<Settings>>("settings", {}) }; }
  patchSettings(p: Partial<Settings>) { const s = { ...this.settings(), ...p }; this.set("settings", s); return s; }
  owners(): number[] { return this.get<number[]>("owners", []); }
  addOwner(id: number) { const o = new Set(this.owners()); o.add(id); this.set("owners", [...o]); }
  saveRun(r: any, startedAt: number) {
    this.db.prepare(`INSERT OR REPLACE INTO runs VALUES (@run_id,@run_type,@keys_used,@started_at,@ended_at,@floor,@treasure,@marbles,@arcade_keys,@kills,@level,@turns,@damage,@end_reason,@loot)`).run({
      run_id: r.runId, run_type: r.runType, keys_used: r.keysUsed, started_at: startedAt, ended_at: Date.now(), floor: r.floor, treasure: r.treasure,
      marbles: r.marbles, arcade_keys: r.arcadeKeys, kills: r.kills, level: r.level, turns: r.turns, damage: r.damageTaken, end_reason: r.endReason, loot: JSON.stringify(r.lootEvents) });
  }
  recentRuns(n = 10) { return this.db.prepare("SELECT * FROM runs ORDER BY ended_at DESC LIMIT ?").all(n) as any[]; }
  runStatsSince(ts: number) {
    return this.db.prepare(`SELECT run_type, COUNT(*) n, SUM(keys_used) keys, SUM(treasure) treasure, SUM(marbles) marbles, SUM(arcade_keys) ak, MAX(treasure) best, MAX(floor) best_floor
      FROM runs WHERE ended_at >= ? GROUP BY run_type`).all(ts) as any[];
  }
  ledger(kind: string, usd: number, detail: string, tx?: string) { this.db.prepare("INSERT INTO ledger(ts,kind,usd,detail,tx) VALUES(?,?,?,?,?)").run(Date.now(), kind, usd, detail, tx ?? null); }
  spentSince(ts: number, kinds: string[]) {
    const r = this.db.prepare(`SELECT COALESCE(SUM(usd),0) s FROM ledger WHERE ts >= ? AND kind IN (${kinds.map(() => "?").join(",")})`).get(ts, ...kinds) as { s: number };
    return r.s;
  }
  /** Our own measured Arcade treasure per key over the last N arcade runs (null if too few runs). */
  arcadeTreasurePerKey(n = 10): { perKey: number; runs: number } | null {
    const rows = this.db.prepare("SELECT treasure, keys_used FROM runs WHERE run_type='NORMAL' AND end_reason='game_over' ORDER BY ended_at DESC LIMIT ?").all(n) as any[];
    if (rows.length < 3) return null;
    const t = rows.reduce((a, r) => a + r.treasure, 0), k = rows.reduce((a, r) => a + Math.max(1, r.keys_used), 0);
    return { perKey: t / k, runs: rows.length };
  }
  recentLedger(n = 10) { return this.db.prepare("SELECT * FROM ledger ORDER BY id DESC LIMIT ?").all(n) as any[]; }
  event(level: string, msg: string) { this.db.prepare("INSERT INTO events(ts,level,msg) VALUES(?,?,?)").run(Date.now(), level, msg.slice(0, 2000)); }
  recentEvents(n = 15) { return this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(n) as any[]; }
}
