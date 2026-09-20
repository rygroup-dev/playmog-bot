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
    if (dec.stuck && stuckStreak === 1) { // one-off snapshot so a stranded floor can be diagnosed afterwards
      const stairs = (g.interactive ?? []).filter((i: any) => i.type === "stairs").map((i: any) => ({ id: i.id, x: i.x, y: i.y, room: i.v2RoomType, gate: !!i.v2IsGate }));
      appendFileSync(file, JSON.stringify({ t: Date.now(), turn: g.turnNumber, floor: g.currentFloor, stuckDump: {
        pos: [g.player.x, g.player.y], energy: g.player.energy, room: g.v2CurrentRoomType, prompt: g.v2UpgradeRoomPrompt ?? null,
        arena: { roomType: g.v2CurrentRoomType, liveEnemies: (g.enemies ?? []).filter((e: any) => (e.hp ?? 0) > 0).map((e: any) => [e.id, e.x, e.y, e.hp]),
                 refusedTiles: [...(mem.blockedTiles?.get(g.currentFloor ?? 0) ?? [])], bountyPending: g.v2BountyEntryPending, decoy: g.v2Decoy,
                 pickups: (g.pickups ?? []).map((p: any) => [p.type, p.x, p.y]) },
        kills: g.v2FloorKills, killTarget: g.v2FloorKillTarget, stairs,
        gates: (g.interactive ?? []).filter((i: any) => i.v2IsGate),
        interactive: (g.interactive ?? []).map((i: any) => ({ id: i.id, t: i.type, x: i.x, y: i.y, hp: i.hp, maxHp: i.maxHp, npc: i.v2NpcType, armory: i.v2ArmoryItemId, gate: i.v2IsGate })),
        enemies: (g.enemies ?? []).map((e: any) => [e.id, e.x, e.y, e.hp, e.maxHp]), pickups: (g.pickups ?? []).length,
        breakables: (g.interactive ?? []).filter((i: any) => i.type === "pot" || i.type === "crate").length,
        portals: (g.portals ?? []).map((p: any) => [p.id, p.x, p.y]), unknownTiles: (g.fogMask ?? []).flat().filter((v: number) => !v).length,
        // ascii map around us: # wall, . floor, ' ' void, @ us, S stairs, G gate, o interactive
        map: (() => {
          const out: string[] = []; const px = g.player.x, py = g.player.y;
          for (let y = py - 8; y <= py + 8; y++) {
            let line = "";
            for (let x = px - 12; x <= px + 12; x++) {
              const m = g.mapData?.[y]?.[x];
              const i = (g.interactive ?? []).find((q: any) => q.x === x && q.y === y);
              line += (x === px && y === py) ? "@" : i?.type === "stairs" ? "S" : i?.v2IsGate ? "G" : i ? "o" : m === 0 ? "." : m === 1 ? "#" : " ";
            }
            out.push(`${String(y).padStart(3)}|${line}`);
          }
          return out;
        })() } }) + "\n");
    }
    if (stuckStreak === 2 && !mem.teleported) { // the game's own escape hatch before giving up (sealed room, blocked corridor)
      mem.teleported = true;
      try {
        const ack = await room.runAction({ type: "teleport" });
        appendFileSync(file, JSON.stringify({ t: Date.now(), turn: g.turnNumber, runAction: { type: "teleport" }, reason: "escape: nothing reachable", ack: { ...ack, gameState: undefined } }) + "\n");
        log("teleport escape used"); g = room.state; stuckStreak = 0; continue;
      } catch (e: any) { log(`teleport escape failed: ${e?.message ?? e}`); }
    }
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
        if ((ev.type === "trap_triggered" || (ev.type === "arrow_trap_triggered" && ev.playerHit)) && g.player) {
          const m = ev.type === "trap_triggered" ? mem.traps : mem.arrows; const f = g.currentFloor ?? 0;
          if (!m.has(f)) m.set(f, new Set());
          m.get(f)!.add(`${g.player.x},${g.player.y}`); // the tile we stand on after the action is where it hit
          // an arrow lane runs along our movement axis (walking along it gets hit on every tile): avoid ±4 tiles of it
          const d = dec.action?.type === "move" ? dec.action.direction : null;
          if (m === mem.arrows && d) for (let k = -4; k <= 4; k++) {
            const x = g.player.x + (d === "left" || d === "right" ? k : 0), y = g.player.y + (d === "up" || d === "down" ? k : 0);
            m.get(f)!.add(`${x},${y}`);
          }
        }
        if (ev.type === "player_damaged") {
          const amt = Number(ev.amount ?? ev.damage ?? 0); damageTaken += amt;
          if (!dec.danger.includes(`${g.player.x},${g.player.y}`)) unpredicted++;
        }
        if (["pickup_collected", "item_collected", "treasure", "marble", "arcade_key", "gem", "jackpot", "raffle_ticket", "amber"].includes(ev.type)) {
          const k = ev.pickupType ?? ev.itemType ?? ev.type; loot[k] = (loot[k] ?? 0) + Number(ev.amount ?? ev.value ?? 1);
        }
      }
      // storm weather costs 25 energy per lightning strike; dump the raw server state so we can find how the
      // incoming strike is telegraphed (the field is not in any client chunk we can download)
      if (String(before.v2Weather ?? "").includes("storm") || String((before.v2Weather as any)?.type ?? "").includes("storm")) {
        try { mkdirSync("data/storm", { recursive: true }); appendFileSync(`data/storm/${runId}.jsonl`, JSON.stringify({ turn: before.turnNumber, pos: [before.player.x, before.player.y], state: before }) + "\n"); } catch { /* probe only */ }
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
      // the server refused this move: the tile is not walkable for it, so remember it and route around
      if (e instanceof MoveRejected && dec.action?.type === "move" && typeof dec.action.targetX === "number") {
        const f = g.currentFloor ?? 0;
        mem.blockedTiles ??= new Map();
        if (!mem.blockedTiles.has(f)) mem.blockedTiles.set(f, new Set());
        mem.blockedTiles.get(f)!.add(`${dec.action.targetX},${dec.action.targetY}`);
        const tx = dec.action.targetX, ty = dec.action.targetY;
        appendFileSync(file, JSON.stringify({ t: Date.now(), refused: [tx, ty], floor: f, why: {
          map: g.mapData?.[ty]?.[tx], fog: g.fogMask?.[ty]?.[tx],
          interactive: (g.interactive ?? []).filter((i: any) => i.x === tx && i.y === ty),
          enemy: (g.enemies ?? []).filter((e: any) => e.x === tx && e.y === ty).map((e: any) => [e.id, e.hp, e.maxHp, e.spriteType]),
          pickup: (g.pickups ?? []).filter((p: any) => p.x === tx && p.y === ty).map((p: any) => p.type),
          player: [g.player?.x, g.player?.y], room: g.v2CurrentRoomType } }) + "\n");
        log(`server refused ${tx},${ty} on floor ${f} — marked unwalkable`);
      }
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
