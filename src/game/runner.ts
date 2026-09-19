// Plays one run to completion over the authoritative room, with reconnects and a per-turn JSONL log.
import { appendFileSync, mkdirSync } from "node:fs";
import { MogApi, MogApiError, sleep } from "../mog/api.js";
import { GameRoom, MoveRejected } from "./room.js";
import { decide, newMemory, DEFAULT_POLICY, type PolicyConfig } from "./policy.js";

export type RunType = "NORMAL" | "EXPEDITION" | "WORLD";
export interface RunSummary {
  runId: string; runType: RunType; keysUsed: number; turns: number; floor: number; status: string;
  treasure: number; marbles: number; arcadeKeys: number; amber: number; raffleTickets: number; kills: number; energyLeft: number; level: number;
  damageTaken: number; unpredictedHits: number; avgRttMs: number; endReason: string; lootEvents: Record<string, number>;
}
export interface RunnerHooks { onTurn?: (t: { turn: number; reason: string; g: any; events: any[] }) => void; shouldStop?: () => boolean; log?: (m: string) => void }

export async function playRun(api: MogApi, runId: string, runType: RunType, hooks: RunnerHooks = {}, cfg: PolicyConfig = DEFAULT_POLICY): Promise<RunSummary> {
  const log = hooks.log ?? (() => {});
  mkdirSync("data/runs", { recursive: true });
  const file = `data/runs/${runId}.jsonl`;
  const room = new GameRoom(api, runId, (m) => log(`[room] ${m}`));
  let g = await connectWithRetry(room, log);
  const loot: Record<string, number> = {};
  let damageTaken = 0, unpredicted = 0, rttSum = 0, rttN = 0, endReason = "game_over", errStreak = 0, stuckStreak = 0;
  const mem = newMemory();
  const loggedFloors = new Set<number>();
  const noDmg = new Map<string, number>(); // consecutive attacks on a target that did no damage
  let lastProgressTurn = g.turnNumber ?? 0, lastEnergy = g.player?.energy ?? 0, lastTreasure = g.player?.treasure ?? 0, lastFloor = g.currentFloor ?? 0;

  for (let i = 0; i < 3000; i++) {
    if (hooks.shouldStop?.()) { endReason = "stopped_by_operator"; break; }
    if (g.status && g.status !== "IN_PROGRESS") { endReason = `status_${g.status}`; break; }
    // global watchdog: 60 turns with no energy/treasure/floor change = something we do not understand -> stop, keep run open
    if (g.player.energy !== lastEnergy || g.player.treasure !== lastTreasure || g.currentFloor !== lastFloor) {
      lastProgressTurn = g.turnNumber; lastEnergy = g.player.energy; lastTreasure = g.player.treasure; lastFloor = g.currentFloor;
    } else if (g.turnNumber - lastProgressTurn > (g.v2CurrentRoomType ? 150 : 60)) { // rooms have free movement
      endReason = "watchdog: no progress (run left open)"; break;
    }
    const dec = decide(g, cfg, mem);
    const before = g;
    stuckStreak = dec.stuck ? stuckStreak + 1 : 0;
    if (stuckStreak > 2) { endReason = "stuck: no safe action (run left open, not drained)"; break; }
    try {
      if (dec.runAction) {
        const ack = await room.runAction(dec.runAction);
        appendFileSync(file, JSON.stringify({ t: Date.now(), turn: before.turnNumber, floor: before.currentFloor, runAction: dec.runAction, reason: dec.reason, ack: { ...ack, gameState: undefined }, prompt: before.v2UpgradeRoomPrompt }) + "\n");
        g = room.state; errStreak = 0;
        hooks.onTurn?.({ turn: g.turnNumber, reason: dec.reason, g, events: ack?.events ?? [] });
        continue;
      }
      const r = await room.act(dec.action!);
      errStreak = 0; rttSum += r.rttMs; rttN++;
      g = r.gameState;
      if (dec.action?.type === "attack") {
        const tid = dec.action.targetEnemyId;
        const hurt = r.events.some((ev: any) => (ev.type === "enemy_damaged" || ev.type === "enemy_killed") && ev.enemyId === tid);
        const n = hurt ? 0 : (noDmg.get(tid) ?? 0) + 1; noDmg.set(tid, n);
        if (hurt) mem.dodges.set(tid, 0);
        if (n >= 3) { mem.blacklist.set(tid, g.turnNumber + 15); noDmg.set(tid, 0); log(`blacklist ${tid} for 15 turns (no damage x3)`); }
      }
      for (const ev of r.events) {
        if (ev.type === "player_damaged") {
          const amt = Number(ev.amount ?? ev.damage ?? 0); damageTaken += amt;
          if (!dec.danger.includes(`${g.player.x},${g.player.y}`)) unpredicted++;
        }
        if (["pickup_collected", "item_collected", "treasure", "marble", "arcade_key", "gem", "jackpot", "raffle_ticket", "amber"].includes(ev.type)) {
          const k = ev.pickupType ?? ev.itemType ?? ev.type; loot[k] = (loot[k] ?? 0) + Number(ev.amount ?? ev.value ?? 1);
        }
      }
      appendFileSync(file, JSON.stringify({ t: Date.now(), turn: before.turnNumber, floor: before.currentFloor, pos: [before.player.x, before.player.y], energy: before.player.energy,
        action: dec.action, reason: dec.reason, danger: dec.danger, events: r.events, rtt: Math.round(r.rttMs), sp: r.serverProcessMs,
        talents: before.player.pendingTalentRolls?.length ? before.player.pendingTalentRolls : undefined, prompt: before.v2UpgradeRoomPrompt ?? undefined,
        upgrades: before.pendingUpgradeOptions?.length ? before.pendingUpgradeOptions : undefined,
        enemies: before.enemies?.map((e: any) => [e.id, e.x, e.y, e.hp, e.v2AttackPhase, e.v2AttackTurns, e.v2AttackDir, e.v2AttackTargetX, e.v2AttackTargetY]) }) + "\n");
      hooks.onTurn?.({ turn: g.turnNumber, reason: dec.reason, g, events: r.events });
      if (r.isGameOver) { endReason = "game_over"; break; }
    } catch (e: any) {
      errStreak++;
      appendFileSync(file, JSON.stringify({ t: Date.now(), error: String(e?.message ?? e), code: e?.code, action: dec.action }) + "\n");
      log(`turn error (${errStreak}): ${e?.message ?? e}`);
      if (errStreak >= 8) { endReason = `aborted: ${e?.message ?? e}`; break; }
      if (e instanceof MoveRejected && /GAME_OVER|RUN_NOT_ACTIVE|RUN_COMPLETED/i.test(e.code)) { endReason = e.code; break; }
      // resync: reconnect gives a fresh authoritative state (fixes turn mismatch / dropped socket)
      await sleep(Math.min(8000, 500 * 2 ** errStreak));
      await room.leave();
      g = await connectWithRetry(room, log);
    }
  }
  await room.leave();
  const p = g.player;
  return { runId, runType, keysUsed: g.keysUsed, turns: g.turnNumber, floor: g.currentFloor, status: g.status, treasure: p.treasure, marbles: p.marbles,
    arcadeKeys: p.arcadeKeys, amber: p.amber ?? 0, raffleTickets: p.raffleTickets ?? 0, kills: p.totalEnemiesKilled, energyLeft: p.energy, level: p.level, damageTaken, unpredictedHits: unpredicted,
    avgRttMs: rttN ? Math.round(rttSum / rttN) : 0, endReason, lootEvents: loot };
}

async function connectWithRetry(room: GameRoom, log: (m: string) => void) {
  for (let i = 0; ; i++) {
    try { return await room.connect(); }
    catch (e: any) {
      if (e instanceof MogApiError && e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 401) throw e;
      if (i >= 6) throw e;
      log(`room connect failed (${i + 1}): ${e?.message ?? e}`); await sleep(1000 * 2 ** i);
    }
  }
}
