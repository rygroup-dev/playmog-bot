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
export interface GambleEvent { game: "ringrace" | "portalgambit"; phase: "bet" | "result"; wager: number; unit: "treasure" | "worldseed";
  outcome?: unknown; walletBefore?: number; walletAfter?: number; floor: number }
/** Bounty (jackpot_minor/major/mega) and Throne wins — the two big prize events a run can produce. */
export interface PrizeEvent { kind: string; floor: number; raw: any }
export interface RunnerHooks { onTurn?: (t: { turn: number; reason: string; g: any; events: any[] }) => void; shouldStop?: () => boolean;
  onGamble?: (e: GambleEvent) => void; onPrize?: (e: PrizeEvent) => void; log?: (m: string) => void }

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
  const seenRooms = new Set<string>();
  // gambling: remember the stake and the balance at bet time so the result can be reported with a real delta
  const bets = new Map<string, { wager: number; wallet: number }>();
  const purse = (st: any) => (runType === "WORLD" ? st.player?.amber ?? 0 : st.player?.treasure ?? 0);
  const unit = runType === "WORLD" ? "worldseed" as const : "treasure" as const;
  const noDmg = new Map<string, number>(); // consecutive attacks on a target that did no damage
  let lastProgressTurn = g.turnNumber ?? 0, lastEnergy = g.player?.energy ?? 0, lastTreasure = g.player?.treasure ?? 0, lastFloor = g.currentFloor ?? 0;

  /**
   * One line per floor listing everything the server says is on it. Without this the run log only carries
   * enemies, so "what did this floor actually hold" could only be guessed at from what the bot happened to
   * walk into — which is exactly the question when tuning how thoroughly a floor gets cleared.
   */
  const KNOWN_INTERACTIVE = new Set(["pot", "crate", "stairs", "shrine", "armory", "jackalot"]);
  const tally = (xs: any[], f: (x: any) => string) => {
    const out: Record<string, number> = {};
    for (const x of xs ?? []) { const k = f(x) || "?"; out[k] = (out[k] ?? 0) + 1; }
    return out;
  };
  const snapshotFloor = (st: any, when: "masuk" | "keluar") => {
    const w = st.v2Weather;
    appendFileSync(file, JSON.stringify({ t: Date.now(), turn: st.turnNumber, floor: st.currentFloor, when, floorContents: {
      room: st.v2CurrentRoomType ?? null,
      weather: typeof w === "string" ? w : w?.type ?? null,
      enemies: tally(st.enemies, (e) => String(e.spriteType ?? e.id).replace(/^v2_/, "")),
      interactive: tally(st.interactive, (i) => String(i.v2NpcType ?? i.type)),
      pickups: tally(st.pickups, (p) => String(p.type)),
      traps: (st.traps ?? []).length, arrowTraps: (st.arrowTraps ?? []).length, portals: (st.portals ?? []).length,
      // One full sample of every interactive type the policy has no handling for. Floor snapshots turned up
      // fountains on 6 of 9 floors and four chests on floor 9, and nothing in the code, the client bundle or
      // the older captures says what either of them does — so record the object itself and find out.
      unknown: (st.interactive ?? []).filter((i: any) => !KNOWN_INTERACTIVE.has(String(i.v2NpcType ?? i.type)))
        .filter((i: any, n: number, all: any[]) => all.findIndex((o) => (o.v2NpcType ?? o.type) === (i.v2NpcType ?? i.type)) === n),
      energyOnFloor: (st.pickups ?? []).reduce((t: number, p: any) => t + (/energy_orb/.test(p.type ?? "") ? Number(p.value ?? 0) : 0), 0),
    } }) + "\n");
  };
  snapshotFloor(g, "masuk");
  let lastOnFloor = g;   // most recent state seen on the floor we are still on, dumped when we leave it

  for (let i = 0; i < 3000; i++) {
    if (hooks.shouldStop?.()) { endReason = "stopped_by_operator"; break; }
    if (g.status && g.status !== "IN_PROGRESS") { endReason = `status_${g.status}`; break; }
    // global watchdog: 60 turns with no energy/treasure/floor change = something we do not understand -> stop, keep run open
    if (g.player.energy !== lastEnergy || g.player.treasure !== lastTreasure || g.currentFloor !== lastFloor) {
      // On arrival almost nothing is revealed yet and energy orbs do not exist at all — they are dropped by
      // kills and breaks (pickup ids are enemy_loot_*, pot_*, item_crate_*). So the picture that matters is
      // the one on the way out, once the floor has been uncovered and fought through.
      if (g.currentFloor !== lastFloor) { snapshotFloor(lastOnFloor, "keluar"); snapshotFloor(g, "masuk"); }
      lastProgressTurn = g.turnNumber; lastEnergy = g.player.energy; lastTreasure = g.player.treasure; lastFloor = g.currentFloor;
    } else if (g.turnNumber - lastProgressTurn > (g.v2CurrentRoomType ? 150 : 60)) { // rooms have free movement
      endReason = "watchdog: no progress (run left open)"; break;
    }
    lastOnFloor = g;
    // The first fountain attempt never fired even though the bot stood beside one five times with the right
    // energy and no earlier branch returned. The floor snapshot says used:false, so record the object exactly
    // as it looks at that moment instead of guessing why the check missed.
    for (const o of g.interactive ?? []) {
      if (o.type !== "fountain" && o.type !== "chest") continue;
      if (Math.abs(o.x - g.player.x) + Math.abs(o.y - g.player.y) > 1) continue;
      appendFileSync(file, JSON.stringify({ t: Date.now(), turn: g.turnNumber, floor: g.currentFloor,
        adjacentObject: { raw: o, keys: Object.keys(o), used: o.used, usedType: typeof o.used,
          state: o.state, pos: [g.player.x, g.player.y], energy: g.player.energy } }) + "\n");
    }
    const dec = decide(g, cfg, mem);
    const rt = g.v2CurrentRoomType ?? null;
    if ((rt === "armory" || rt === "shrine") && !seenRooms.has(rt)) {   // record what the pedestals actually offer
      seenRooms.add(rt);
      appendFileSync(file, JSON.stringify({ t: Date.now(), turn: g.turnNumber, roomSample: { room: rt,
        wallet: rt === "shrine" ? g.player?.treasure : g.player?.treasure, energy: g.player?.energy, shrineUses: g.player?.v2ShrineUseCount,
        pedestals: (g.interactive ?? []).filter((i: any) => i.v2ArmoryItemId || i.v2NpcType)
          .map((i: any) => ({ id: i.id, npc: i.v2NpcType, item: i.v2ArmoryItemId, cost: i.v2ArmoryCost, x: i.x, y: i.y })) } }) + "\n");
      log(`room sample recorded: ${rt}`);
    }
    if ((rt === "portalgambit" || rt === "ringrace") && !seenRooms.has(rt)) { // first sight: record the real shape
      seenRooms.add(rt);
      appendFileSync(file, JSON.stringify({ t: Date.now(), turn: g.turnNumber, roomSample: { room: rt, pos: [g.player.x, g.player.y],
        portals: g.portals ?? [], wager: g.v2PortalGambitWager ?? g.v2RingRaceWager ?? null, row: g.v2PortalGambitRow ?? null,
        pick: g.v2RingRacePick ?? null, interactive: (g.interactive ?? []).map((i: any) => [i.id, i.type, i.x, i.y]) } }) + "\n");
      log(`room sample recorded: ${rt}`);
    }
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
        const betGame = dec.runAction.type === "ring_race_bet" ? "ringrace" as const : dec.runAction.type === "portal_gambit_bet" ? "portalgambit" as const : null;
        const betWager = betGame ? Number((dec.runAction as any).wager ?? 0) : 0;
        const ack = await room.runAction(dec.runAction);
        if (betGame && betWager > 0) {
          bets.set(betGame, { wager: betWager, wallet: purse(before) });
          hooks.onGamble?.({ game: betGame, phase: "bet", wager: betWager, unit, floor: before.currentFloor ?? 0, walletBefore: purse(before) });
        }
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
        if (/^(jackpot_(minor|major|mega)|throne_win|jackpot_claim)$/.test(ev.type)) {
          log(`PRIZE: ${ev.type} ${JSON.stringify(ev).slice(0, 200)}`);
          hooks.onPrize?.({ kind: ev.type, floor: g.currentFloor ?? 0, raw: ev });
        }
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
      // research hook (off unless STORM_PROBE=1): dumps the raw state during storms. The lightning telegraph
      // (v2Weather.strikes) was found this way; keeping it off keeps the logs small.
      if (process.env.STORM_PROBE === "1" && String((before.v2Weather as any)?.type ?? before.v2Weather ?? "").includes("storm")) {
        try { mkdirSync("data/storm", { recursive: true }); appendFileSync(`data/storm/${runId}.jsonl`, JSON.stringify({ turn: before.turnNumber, pos: [before.player.x, before.player.y], state: before }) + "\n"); } catch { /* probe only */ }
      }
      appendFileSync(file, JSON.stringify({ t: Date.now(), turn: before.turnNumber, floor: before.currentFloor, pos: [before.player.x, before.player.y], energy: before.player.energy,
        action: dec.action, reason: dec.reason, danger: dec.danger, events: r.events, rtt: Math.round(r.rttMs), sp: r.serverProcessMs,
        talents: before.player.pendingTalentRolls?.length ? before.player.pendingTalentRolls : undefined, prompt: before.v2UpgradeRoomPrompt ?? undefined,
        upgrades: before.pendingUpgradeOptions?.length ? before.pendingUpgradeOptions : undefined,
        enemies: before.enemies?.map((e: any) => [e.id, e.x, e.y, e.hp, e.v2AttackPhase, e.v2AttackTurns, e.v2AttackDir, e.v2AttackTargetX, e.v2AttackTargetY]) }) + "\n");
      // a finished bet: the server fills in the outcome field, so report it once with the balance change
      for (const [game, info] of [...bets]) {
        const outcome = game === "ringrace" ? g.v2RingRaceOutcome : g.v2PortalGambitOutcome;
        if (outcome == null) continue;
        bets.delete(game);
        hooks.onGamble?.({ game: game as any, phase: "result", wager: info.wager, unit, outcome, walletBefore: info.wallet, walletAfter: purse(g), floor: g.currentFloor ?? 0 });
      }
      hooks.onTurn?.({ turn: g.turnNumber, reason: dec.reason, g, events: r.events });
      if (r.isGameOver) {
        // The server ends BOTH a win and a death with a game_over event; only its `reason` tells them apart
        // ("completed" = full clear of floor 10). Reading just isGameOver recorded every win as a loss.
        const go = r.events.find((e: any) => e.type === "game_over");
        endReason = go?.reason === "completed" ? "completed" : go?.reason ? `game_over:${go.reason}` : "game_over";
        log(`run ended: ${endReason} floor ${g.currentFloor ?? "?"}`);
        break;
      }
    } catch (e: any) {
      errStreak++;
      appendFileSync(file, JSON.stringify({ t: Date.now(), error: String(e?.message ?? e), code: e?.code, action: dec.action }) + "\n");
      log(`turn error (${errStreak}): ${e?.message ?? e}`);
      // the server refused an attack or a break: that target is unusable right now (stale id, wrong direction,
      // shielded) -> ignore it for a while instead of hammering the same action until the run aborts
      if (e instanceof MoveRejected && (dec.action?.type === "attack" || dec.action?.type === "break")) {
        const tid = (dec.action as any).targetEnemyId ?? (dec.action as any).targetId;
        if (tid) {
          mem.blacklist.set(String(tid), (g.turnNumber ?? 0) + 20);
          log(`server refused ${dec.action.type} on ${tid} — ignoring it for 20 turns`);
          errStreak = Math.max(0, errStreak - 1); // a handled rejection must not count toward the abort limit
        }
      }
      // The server refused this move: the tile is not walkable for it, so remember it and route around.
      // Transient refusals say nothing about the tile — marking it would permanently cut a route off
      // (observed live: a RATE_LIMITED reply banned tile 13,10 on floor 3 for the rest of the run).
      const transient = /RATE_LIMITED|TIMEOUT|TEMPORAR/i.test(String((e as any)?.code ?? ""));
      if (!transient && e instanceof MoveRejected && dec.action?.type === "move" && typeof dec.action.targetX === "number") {
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
        errStreak = Math.max(0, errStreak - 1); // handled: routing around it is progress, not a failure
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
