import type { Action, RunAction } from "./room.js";
import { Board, DIRS, dangerMap, dirTo, enemyConfig, footprint, key, manhattan, step, type P } from "./model.js";
import { chooseItem, ITEM_VALUE } from "./items.js";
import { breakValue, killCost, killValue, pickupValue, weatherHitCost, type Ctx } from "./value.js";
import talentTable from "./talents.json" with { type: "json" };

/** Run-scoped memory the runner keeps between turns (anti-loop). */
export interface PolicyMemory {
  blacklist: Map<string, number>;   // enemyId -> turn until which it is ignored
  dodges: Map<string, number>;      // enemyId -> dodges since we last damaged it
  traps: Map<number, Set<string>>;  // floor -> spike tiles that hit us (they re-fire every 2 turns while we stand there)
  rerollTried?: number;             // talent level we already tried to reroll at
  noGoal?: number;                  // consecutive turns with nothing reachable (then any room/stairs will do)
  blockedTiles?: Map<number, Set<string>>; // floor -> tiles the server refused to let us walk onto
  badGoals?: Map<number, Set<string>>;     // floor -> goal tiles we never got closer to (unreachable behind a gate, …)
  goalTrack?: { k: string; best: number; tries: number };
  teleported?: boolean;             // the game's teleport escape was already used this run
  arrows: Map<number, Set<string>>; // floor -> tiles an arrow trap hit us on (fires on entering its lane: avoid, never "step off" into it)
}
export const newMemory = (): PolicyMemory => ({ blacklist: new Map(), dodges: new Map(), traps: new Map(), arrows: new Map() });
function arrowTiles(g: any, mem: PolicyMemory) {
  const out = new Set(mem.arrows?.get(g.currentFloor ?? 0) ?? []);
  for (const t of g.arrowTraps ?? []) if (typeof t?.x === "number" && typeof t?.y === "number") out.add(key(t.x, t.y)); // revealed launchers
  return out;
}
/** Known trap tiles on the current floor: the ones that already hit us + any the server reveals (trap sight). */
export function trapTiles(g: any, mem: PolicyMemory): Set<string> {
  const out = new Set(mem.traps.get(g.currentFloor ?? 0) ?? []);
  for (const t of g.traps ?? []) if (typeof t?.x === "number" && typeof t?.y === "number") out.add(key(t.x, t.y));
  return out;
}

export interface PolicyConfig {
  gambleRingRace?: boolean;   // stake in the Ringjak Derby room (house keeps 12.5%)
  gamblePortalGambit?: boolean; // stake in Portal Gambit
  gambleWagerPct?: number;    // share of treasure/worldseeds to stake, capped at the game's own 10% limit
  energyReserve: number;      // keep this much energy beyond the path to the stairs
  exploreSlack: number;       // extra energy needed before chasing optional loot/exploration
  maxLootDetour: number;      // max path length to go for a breakable/pickup
  acceptRooms?: string[];     // special stairs rooms to enter (shrine, armory, jackalot, ...)
}
export const DEFAULT_POLICY: PolicyConfig = { energyReserve: 6, exploreSlack: 12, maxLootDetour: 14, acceptRooms: ["shrine", "armory", "jackalot"] };

export interface Decision { action?: Action; runAction?: RunAction; reason: string; danger: string[]; stuck?: boolean }

export function decide(g: any, cfg: PolicyConfig = DEFAULT_POLICY, mem: PolicyMemory = newMemory()): Decision {
  const b = new Board(g); curCfg = cfg;
  for (const t of mem.blockedTiles?.get(g.currentFloor ?? 0) ?? []) b.blocked.add(t); // tiles the server rejected
  // Enemies we must not attack right now: spawners shielded by live spawn (server replies v2_shield_blocked)
  // and anything the runner blacklisted after repeated no-damage hits. They stay obstacles for pathing.
  const liveSpawn = (g.enemies ?? []).some((e: any) => String(e.id).startsWith("v2_spawned_") && e.hp > 0);
  for (const e of g.enemies ?? []) {
    const shielded = enemyConfig(e)?.attackKind === "spawner" && liveSpawn;
    const bl = (mem.blacklist.get(e.id) ?? -1) >= g.turnNumber;
    if (shielded || bl) { const k = key(e.x, e.y); if (b.enemyAt.get(k) === e) { b.enemyAt.delete(k); b.blocked.add(k); } }
  }
  const me: P = { x: g.player.x, y: g.player.y };
  const atk = g.player.attackPower ?? 10;
  const energy = g.player.energy;
  const D = dangerMap(b);
  const dangerList = [...D.keys()];
  const mk = (action: Action, reason: string): Decision => ({ action, reason, danger: dangerList });

  // 0a. talent roll pending: the official client blocks all input until one is picked (canProcessInput)
  const roll = g.player.pendingTalentRolls?.[0];
  if (roll) {
    const options: any[] = roll.options ?? roll;
    const pick = chooseTalent(options, g.player.talents ?? [], isWorld(g));
    // all three offers are weak (greed / glass cannon / heavy hitter / berserker…): pay for one reroll per level.
    // Client rules: allowed once per level (v2TalentRerollUsedLevel != rolledAtLevel); cost 25, 50, 75, 125… treasure
    // (fib by v2TalentRerollCount), /10 (min 1) in World's Eve. 25 treasure ≈ 6 energy vs ~30 energy for a good talent.
    const n = g.player.v2TalentRerollCount ?? 0; const fib = n <= 0 ? 25 : n === 1 ? 50 : (() => { let t = 25, a = 50; for (let r = 2; r <= n; r++) { const x = t + a; t = a; a = x; } return a; })();
    const cost = isWorld(g) ? Math.max(1, Math.floor(fib / 10)) : fib;
    const best = talentScore(pick, isWorld(g));
    if (best < 50 && roll.rolledAtLevel !== undefined && g.player.v2TalentRerollUsedLevel !== roll.rolledAtLevel && cost <= 50 && wallet(g) >= cost * 2
        && mem.rerollTried !== roll.rolledAtLevel) { // one attempt per level even if the server rejects it
      mem.rerollTried = roll.rolledAtLevel;
      return mk({ type: "reroll_talent" }, `reroll talents (${options.map((o: any) => o.talentId ?? o.id).join("/")}) for ${cost}${isWorld(g) ? " seeds" : "T"}`);
    }
    return mk({ type: "select_talent", talentId: pick.talentId ?? pick.id }, `talent ${pick.talentId ?? pick.id}${pick.kind === "enhance" ? "+" : ""} (${options.map((o: any) => (o.talentId ?? o.id) + (o.kind === "enhance" ? "+" : "")).join("/")})`);
  }
  // 0b. upgrade choice (upgrade rooms)
  const opts = g.pendingUpgradeOptions ?? [];
  if (opts.length) {
    const pick = chooseUpgrade(opts);
    return mk({ type: "upgrade_selected", upgradeId: pick.id ?? pick.upgradeId ?? pick.key }, `upgrade ${pick.id ?? pick.name}`);
  }
  // 0c. standing on stairs -> server shows v2UpgradeRoomPrompt; "Confirm" = run_action enter_upgrade_room
  const prompt = g.v2UpgradeRoomPrompt;
  if (prompt && (wantsRoom(prompt, g, cfg) || (mem.noGoal ?? 0) >= 2)) // nothing left on this floor: descend even through a room we would normally decline
    return { runAction: { type: "enter_upgrade_room" }, reason: `enter ${prompt.roomType ?? "next floor"} via ${prompt.stairsId}${wantsRoom(prompt, g, cfg) ? "" : " (nothing left here)"}`, danger: dangerList };

  // gambling rooms: the bet is a run action. Both games favour the house (Derby 4 lanes: 3x win / 0.5x place = 87.5%
  // return; Portal Gambit: five rows, one wrong portal each, 3x if all cleared), so betting is off unless the owner
  // switches it on. Wager 0 keeps walking through the room without staking anything.
  {
    const rt = g.v2CurrentRoomType ?? null;
    const wallet0 = wallet(g);
    if (rt === "ringrace" && g.v2RingRaceWager == null) {
      const want = cfg.gambleRingRace ? Math.max(1, Math.floor(wallet0 * Math.min(cfg.gambleWagerPct ?? 0.05, 0.1))) : 0;
      return { runAction: { type: "ring_race_bet", lane: Math.floor(Math.random() * 4), wager: want }, reason: want ? `ring race bet ${want}` : "ring race: no bet (pass through)", danger: dangerList };
    }
    if (rt === "portalgambit" && g.v2PortalGambitWager == null) {
      const want = cfg.gamblePortalGambit ? Math.max(1, Math.floor(wallet0 * Math.min(cfg.gambleWagerPct ?? 0.05, 0.1))) : 0;
      return { runAction: { type: "portal_gambit_bet", wager: want }, reason: want ? `portal gambit bet ${want}` : "portal gambit: no bet (pass through)", danger: dangerList };
    }
  }

  // special rooms: shrine / armory interactions are "break" on chest NPCs (client eJ()); first hit inspects, second confirms
  const room = g.v2CurrentRoomType ?? null;
  if (room === "shrine" || room === "armory") {
    const p = g.player;
    const targets = (g.interactive ?? []).filter((i: any) => room === "shrine"
      ? i.v2NpcType === "shrine" && p.energy <= p.maxEnergy - 20 && wallet(g) >= scaled(g, shrineCost(p.v2ShrineUseCount ?? 0)) && shrineCost(p.v2ShrineUseCount ?? 0) <= 50
      : typeof i.v2ArmoryItemId === "string" && scaled(g, i.v2ArmoryCost ?? 0) <= Math.max(scaled(g, 10), wallet(g) * 0.15) && wallet(g) >= scaled(g, i.v2ArmoryCost ?? 0)
        && (ITEM_VALUE[i.v2ArmoryItemId] ?? 0) >= 6 && (p.items?.slots ?? []).filter((x: any) => x?.state === "unused").length < 2);
    for (const t of targets) {
      const d = dirTo(me, t);
      if (d) return mk({ type: "break", direction: d, targetId: t.id }, room === "shrine" ? `pray shrine (-${shrineCost(p.v2ShrineUseCount ?? 0)}T +20E)` : `buy ${t.v2ArmoryItemId} ${t.v2ArmoryCost}T`);
    }
    if (targets.length) {
      const { prev } = b.bfs(me);
      for (const t of targets) for (const dd of DIRS) {
        const n = step(t, dd); const first = Board.firstStep(prev, me, key(n.x, n.y));
        if (first) return mk({ type: "move", direction: dirTo(me, first)!, targetX: first.x, targetY: first.y }, `walk to ${room}`);
      }
    }
  }

  const here = D.get(key(me.x, me.y));
  const traps = trapTiles(g, mem); const arrows = arrowTiles(g, mem);
  const adj = DIRS.map((d) => ({ d, p: step(me, d) })).map((o) => ({ ...o, e: b.enemyAt.get(key(o.p.x, o.p.y)) })).filter((o) => o.e);

  // 1. an adjacent enemy that dies to this hit is always the best move (removes its threat, free energy)
  const killable = adj.filter((o) => o.e.hp <= atk).sort((a, b2) => threatRank(b2.e) - threatRank(a.e));
  if (killable.length) return mk({ type: "attack", direction: killable[0].d, targetEnemyId: killable[0].e.id }, `kill ${short(killable[0].e)}`);

  // 2. standing where an attack fires after this action -> step out if cheaper than the hit
  //    (a step costs 1 energy now + ~1 to come back; a hit costs its damage in energy)
  // Server-verified cycle: charge(n) -> attack -> rest -> charge(n) again as soon as we are adjacent.
  // With chargeTurns>=2 a dodge + return still yields n free hits per cycle; with chargeTurns==1 an adjacent
  // enemy re-charges the moment we return, so dodging never lands a hit (energy drain loop) -> fight through.
  const adjIds = new Set(DIRS.map((d) => b.enemyAt.get(key(step(me, d).x, step(me, d).y))?.id).filter(Boolean));
  const dodgeWorth = here ? here.ids.some((id) => {
    const e = (g.enemies ?? []).find((x: any) => x.id === id);
    if (!e) return false;
    if (!adjIds.has(id)) return true;                                   // ranged / dash from afar: nothing to hit back
    if ((mem.dodges.get(id) ?? 0) >= 3) return false;                   // loop guard
    return (enemyConfig(e)?.chargeTurns ?? 1) >= 2;
  }) : false;
  const inArena = (g.v2CurrentRoomType ?? null) === "jackalot"; // movement costs no energy in the bounty arena
  if (here && (inArena ? here.dmg > 0 : here.dmg > 2 && (dodgeWorth || here.dmg >= 10))) { // several attackers firing together: always step out
    const safe = DIRS.map((d) => ({ d, p: step(me, d) }))
      .filter(({ p }) => b.walkable(p.x, p.y) && !b.enemyAt.has(key(p.x, p.y)))
      .map((o) => ({ ...o, risk: (D.get(key(o.p.x, o.p.y))?.dmg ?? 0) + (traps.has(key(o.p.x, o.p.y)) || arrows.has(key(o.p.x, o.p.y)) ? TRAP_DMG : 0) }))
      .sort((a, c) => a.risk - c.risk);
    if (safe.length && safe[0].risk < here.dmg)
    {
      for (const id of here.ids) mem.dodges.set(id, (mem.dodges.get(id) ?? 0) + 1);
      return mk({ type: "move", direction: safe[0].d, targetX: safe[0].p.x, targetY: safe[0].p.y }, `dodge ${here.dmg}dmg from ${here.ids.map((x) => x.split("_").slice(-3).join("_")).join("/")}`);
    }
  }

  // 2-chest. Bounty chest (v2Chest): 3 hits from beside its 3x3 block. Opening it drops amber/marbles/tickets and,
  // in the bounty arena, it is what opens the exit gates (verified live 2026-09-20).
  for (const chest of b.chests) {
    const nextTo = Math.abs(chest.x - me.x) <= 2 && Math.abs(chest.y - me.y) <= 2
      && (Math.abs(chest.x - me.x) + Math.abs(chest.y - me.y)) <= 3;
    if (!nextTo) continue;
    const d = Math.abs(chest.x - me.x) > Math.abs(chest.y - me.y) ? (chest.x > me.x ? "right" : "left") : (chest.y > me.y ? "down" : "up");
    const target = step(me, d as any);
    if (Math.abs(chest.x - target.x) <= 1 && Math.abs(chest.y - target.y) <= 1)
      return mk({ type: "break", direction: d as any, targetId: chest.id }, `hit bounty chest (${chest.v2ChestHitsRemaining ?? "?"} left)`);
  }

  // 2-arena. Bounty arena with the boss dead: the exit gate (type "rock", v2IsGate) still blocks the stairs.
  // Try to break it when adjacent — the server tells us whether that is allowed, and the run logs the answer.
  if ((g.v2CurrentRoomType ?? null) === "jackalot" && !(g.enemies ?? []).some((e: any) => (e.hp ?? 0) > 0)) {
    const refused = mem.blockedTiles?.get(g.currentFloor ?? 0) ?? new Set<string>();
    const gates = (g.interactive ?? []).filter((i: any) => i.v2IsGate && !refused.has(key(i.x, i.y)));
    for (const d of DIRS) { // adjacent: try to step through (gates may open once the boss is down)
      const n = step(me, d);
      const gate = gates.find((i: any) => i.x === n.x && i.y === n.y);
      if (gate) return mk({ type: "move", direction: d, targetX: n.x, targetY: n.y }, `walk into arena gate ${gate.id}`);
    }
    if (gates.length) { // otherwise walk to the tile just below a gate first
      const { prev: gp } = b.bfs(me, { throughEnemies: true });
      for (const gate of gates) {
        const spot = { x: gate.x, y: gate.y + 1 };
        if (!b.walkable(spot.x, spot.y)) continue;
        const first = Board.firstStep(gp, me, key(spot.x, spot.y));
        if (first) return mk({ type: "move", direction: dirTo(me, first)!, targetX: first.x, targetY: first.y }, `go to arena gate ${gate.id}`);
      }
    }
  }

  // 2a. standing on a known spike trap: it re-fires every 2 turns (5-9 dmg) -> step off (1 energy), ideally staying
  //     next to the enemy we are fighting. Measured: 74 energy lost to traps in 15 runs, mostly by standing still on one.
  if (traps.has(key(me.x, me.y)) && !inArena) {
    const off = DIRS.map((d) => ({ d, p: step(me, d) }))
      .filter(({ p }) => b.walkable(p.x, p.y) && !b.enemyAt.has(key(p.x, p.y)) && !traps.has(key(p.x, p.y)) && !arrows.has(key(p.x, p.y)) && !(D.get(key(p.x, p.y))?.dmg))
      .map((o) => ({ ...o, fight: DIRS.some((d) => b.enemyAt.has(key(step(o.p, d).x, step(o.p, d).y))) ? 1 : 0 }))
      .sort((a, c) => c.fight - a.fight);
    if (off.length) return mk({ type: "move", direction: off[0].d, targetX: off[0].p.x, targetY: off[0].p.y }, "step off spike trap");
  }

  // 2b. active items (shots, sticky bomb, midas, magnet, gas pedal, shock grenade, talisman)
  const itemDec = chooseItem(g, b, { imminentHere: here?.dmg ?? 0, stairsDist: null });
  if (itemDec) return mk(itemDec.action, `item: ${itemDec.reason}`);

  // 3. fight adjacent enemies (attacking costs no energy); focus the one closest to firing / lowest hp
  if (adj.length) {
    const t = adj.sort((a, c) => threatRank(c.e) - threatRank(a.e) || a.e.hp - c.e.hp)[0];
    return mk({ type: "attack", direction: t.d, targetEnemyId: t.e.id }, `hit ${short(t.e)}`);
  }

  // 4. navigation: choose a goal
  const avoid = new Set([...D.keys(), ...traps, ...arrows]);
  // don't path through tiles touching 2+ live enemies (walking into a cluster = several telegraphs at once)
  for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
    if (!b.walkable(x, y)) continue;
    let n = 0; for (const d of DIRS) { const q = step({ x, y }, d); if (b.enemyAt.has(key(q.x, q.y))) n++; }
    if (n >= 2) avoid.add(key(x, y));
  }
  const { dist, prev } = b.bfs(me, { avoid });
  const { dist: distAll, prev: prevAll } = b.bfs(me);
  const stairsDist = nearestStairs(b, distAll, me);
  // ---- value model (src/game/value.ts): net = value(EE) - cost(energy); highest net wins ----
  const ctx: Ctx = { floor: g.currentFloor ?? 1, level: g.player.level ?? 0, atk, energy, weatherHit: weatherHitCost(g),
    treasureMult: (g.player.talents ?? []).some((t: any) => (t.id ?? t.talentId ?? t) === "greed") ? 1.2 : 1 };
  const maxE = g.player.maxEnergy ?? 100;
  // energy is also HP: the lower it is, the less damage we accept for a given reward
  const riskAversion = energy < 20 ? 3 : energy < 35 ? 1.8 : energy < 55 ? 1.2 : 1;
  const goals: { k: string; score: number; why: string; adjTarget?: any }[] = [];
  const reachAdj = (t: P) => {
    let best: { k: string; d: number } | null = null;
    for (const d of DIRS) { const n = step(t, d); const k = key(n.x, n.y); const dd = dist.get(k); if (dd !== undefined && (!best || dd < best.d)) best = { k, d: dd }; }
    return best;
  };
  const affordable = (cost: number) => energy - cost - (stairsDist?.d ?? 0) > cfg.energyReserve;
  const slotsFull = (g.player.items?.slots ?? []).filter((x: any) => x?.state === "unused").length >= 2;
  for (const [k, p] of b.pickupAt) {
    if (p.type === "item" && slotsFull) continue;
    const d = dist.get(k); if (d === undefined) continue;
    const ttl = p.v2TurnsUntilDespawn; if (typeof ttl === "number" && d > ttl) continue; // would expire first
    const net = pickupValue(p, ctx) - d;
    if (net > 0 || (p.type?.includes("energy_orb") && pickupValue(p, ctx) > d)) goals.push({ k, score: net, why: `pickup ${p.type}${p.itemId ? " " + p.itemId : ""} (+${net.toFixed(1)})` });
  }
  for (const e of g.enemies ?? []) {
    if (b.enemyAt.get(key(e.x, e.y)) !== e) continue;
    // big bosses: any tile touching the footprint is a valid attack position
    const f = footprint(e); let a: { k: string; d: number } | null = null;
    for (let y = f.top; y <= f.bottom; y++) for (let x = f.left; x <= f.right; x++) { const c = reachAdj({ x, y }); if (c && (!a || c.d < a.d)) a = c; }
    if (!a) continue;
    const cost = a.d + killCost(e, ctx) * riskAversion;
    if (!affordable(cost)) continue;
    const bonus = String(e.id).startsWith("v2_spawned_") ? 4 : 0;       // kill spawn to drop the spawner's shield
    const net = killValue(e, ctx) + bonus - cost;
    if (net > 0) goals.push({ k: a.k, score: net, why: `engage ${short(e)} (+${net.toFixed(1)})` });
  }
  const bv = breakValue(ctx);
  for (const [, i] of b.breakableAt) {
    const a = reachAdj(i); if (!a) continue;
    const net = bv - a.d;
    if (net > 0 && affordable(a.d)) goals.push({ k: a.k, score: net, why: `goto ${i.type} (+${net.toFixed(1)})`, adjTarget: i });
  }
  // unexplored map holds more value; worth a few steps while energy is healthy
  const fr = frontier(b, dist);
  if (fr && energy > 45 && affordable(fr.d)) goals.push({ k: fr.k, score: 2.5 - fr.d * 0.25, why: "explore" });
  // walk up to a bounty chest: its 3x3 block is not walkable, so aim at a tile beside it
  for (const chest of b.chests) {
    for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2], [-2, -1], [-2, 1], [2, -1], [2, 1], [-1, -2], [1, -2], [-1, 2], [1, 2]]) {
      const t = { x: chest.x + dx, y: chest.y + dy };
      if (!b.walkable(t.x, t.y)) continue;
      const k = key(t.x, t.y); const d = dist.get(k) ?? distAll.get(k);
      if (d === undefined || d >= energy) continue;
      goals.push({ k, score: 60 - d * 2, why: `bounty chest ${chest.v2ChestKind ?? ""}`.trim() });
      break;
    }
  }

  // adjacent breakable -> break it now (breaking costs no energy)
  for (const d of DIRS) {
    const n = step(me, d); const i = b.breakableAt.get(key(n.x, n.y));
    if (i && !here && bv > 0) return mk({ type: "break", direction: d, targetId: i.id }, `break ${i.type}`);
  }
  // descend when nothing on this floor pays for itself (deeper floors drop ~+3 treasure per drop per floor)
  if (stairsDist && stairsDist.k !== key(me.x, me.y) && energy > stairsDist.d) goals.push({ k: stairsDist.k, score: goals.length ? -1 : 1, why: `stairs ${stairsDist.id}` });
  // energy can't be banked: if stairs are out of reach, spend what is left on the best nearby value
  if (!goals.length) {
    for (const [k, p] of b.pickupAt) { const d = distAll.get(k); if (d !== undefined && d < energy) goals.push({ k, score: 50 - d * 4, why: `last-energy pickup ${p.type}` }); }
    for (const [, i] of b.breakableAt) { const a = reachAdj(i); if (a && a.d < energy) goals.push({ k: a.k, score: 40 - a.d * 4, why: `last-energy ${i.type}` }); }
    const fr2 = frontier(b, distAll); if (fr2 && fr2.d < energy) goals.push({ k: fr2.k, score: 10 - fr2.d, why: "last-energy explore" });
    // every stairs, including rooms we normally decline: a declined gambling room must not strand the run
    for (const st of b.stairs) {
      const k = key(st.x, st.y); const d = distAll.get(k);
      if (d !== undefined && k !== key(me.x, me.y)) goals.push({ k, score: 5 - d * 0.1, why: `stairs ${st.id} (any room)` });
    }
    // last resort: an enemy may be standing in the only corridor — push through it instead of stranding the run
    if (!goals.length) {
      const through = b.bfs(me, { throughEnemies: true });
      for (const st of b.stairs) {
        const k = key(st.x, st.y); const d = through.dist.get(k);
        if (d !== undefined && k !== key(me.x, me.y)) goals.push({ k, score: 4 - d * 0.1, why: `stairs ${st.id} (through enemies)` });
      }
      const fr3 = frontier(b, through.dist);
      if (fr3 && fr3.d < energy) goals.push({ k: fr3.k, score: 3 - fr3.d * 0.1, why: "explore (through enemies)" });
      if (goals.length) { prevAll.clear(); for (const [k, v] of through.prev) prevAll.set(k, v); for (const [k, v] of through.dist) distAll.set(k, v); }
    }
  }

  goals.sort((a, c) => c.score - a.score);
  if (goals.length) mem.noGoal = 0;
  const floorNo = g.currentFloor ?? 0;
  const bad = mem.badGoals?.get(floorNo) ?? new Set<string>();
  for (const goal of goals) {
    if (goal.k === key(me.x, me.y) || bad.has(goal.k)) continue;
    const useAll = !dist.has(goal.k);
    const first = Board.firstStep(useAll ? prevAll : prev, me, goal.k);
    if (!first) continue;
    // loop guard: a goal we never get closer to (e.g. loot behind the arena gate) is dropped for this floor.
    // Inside rooms movement is free, so without this the bot can circle forever without losing energy.
    const gd = (useAll ? distAll : dist).get(goal.k) ?? Infinity;
    const t = mem.goalTrack;
    if (t && t.k === goal.k) {
      if (gd < t.best) { t.best = gd; t.tries = 0; } else if (++t.tries > 8) {
        mem.badGoals ??= new Map();
        if (!mem.badGoals.has(floorNo)) mem.badGoals.set(floorNo, new Set());
        mem.badGoals.get(floorNo)!.add(goal.k);
        mem.goalTrack = undefined;
        continue;
      }
    } else mem.goalTrack = { k: goal.k, best: gd, tries: 0 };
    const d = dirTo(me, first)!;
    return mk({ type: "move", direction: d, targetX: first.x, targetY: first.y }, `${goal.why}${useAll ? " (through danger)" : ""}`);
  }
  // standing on stairs whose prompt we declined, or nothing reachable: pass costs 1 energy -> flag stuck
  mem.noGoal = (mem.noGoal ?? 0) + 1;
  // truly nothing reachable (e.g. sealed bounty arena after the boss died): the game's own teleport is the way out
  if ((mem.noGoal ?? 0) >= 2 && !mem.teleported) {
    mem.teleported = true;
    return { runAction: { type: "teleport" }, reason: "teleport out (nothing reachable)", danger: dangerList };
  }
  return { ...mk({ type: "pass" }, "no reachable goal"), stuck: energy > 5 };
}

/** Which stairs prompts to accept. Default descend always; special rooms by rule (see roomPlan). */
function wantsRoom(prompt: any, g: any, cfg: PolicyConfig) {
  const rt = prompt.roomType ?? null;
  if (rt === null) return true;
  if (!(cfg.acceptRooms ?? []).includes(rt)) return false;
  const p = g.player;
  if (rt === "shrine") return p.energy <= p.maxEnergy - 20 && wallet(g) >= scaled(g, shrineCost(p.v2ShrineUseCount ?? 0));
  if (rt === "armory") return wallet(g) >= scaled(g, 60) && (p.items?.slots ?? []).filter((x: any) => x?.state === "unused").length < 2;
  return true; // jackalot etc.: movement is free inside
}
/** WORLD runs pay shrine/armory in amber (worldseeds) at 1/10 of the price (client fns eS / ex). */
export const isWorld = (g: any) => g?.runType === "WORLD";
export const wallet = (g: any) => (isWorld(g) ? g.player.amber ?? 0 : g.player.treasure ?? 0);
export const scaled = (g: any, cost: number) => (cost === 0 ? 0 : isWorld(g) ? Math.max(1, Math.floor(cost / 10)) : cost);

/** Shrine price per use (client fn eE): 10, 20, 30, 50, 80, 130 ... ; heal is always +20 energy. */
export function shrineCost(uses: number) {
  if (uses <= 0) return 10; if (uses === 1) return 20;
  let a = 10, b = 20; for (let i = 2; i <= uses; i++) { const n = a + b; a = b; b = n; } return b;
}


// Priority tuned for v2: energy is both HP and movement, score = treasure. Higher = better.
// Ranked by measured energy impact over a typical 6-floor run (15 run logs, 2026-09-19): damage taken ≈ 250 E,
// ≈ 60 kills, ≈ 30 breakables. Armor/shield (-15% of ~250) and per-floor +5 (swift/renewal) are worth ~30-37 E;
// vampiric only heals 1 E per proc (≈ 20 E/run); greed's +40% damage taken costs ≈ 100 E for +20% treasure — a
// net loss, and worthless in World's Eve (paid in worldseeds). Apex guard rarely applies: slimes hit us after
// our first strike, so they are no longer at full HP.
const TALENT_PRIORITY: Record<string, number> = {
  armor_plating: 95, divine_shield: 94, swift_steps: 93, renewal: 90, salvage: 86, last_stand: 82, sharp_blade: 80,
  momentum: 76, vampiric: 70, cleave: 66, scavenger: 60, prospector: 60, critical_strike: 56, merciless: 54,
  frenzy: 52, thorns: 52, poison_blade: 50, scout: 48, disrupt: 46, corruption: 46, survival_instinct: 45, reach: 44,
  menace: 40, apex_guard: 35, apex_hunter: 35, berserker: 25, greed: 8, heavy_hitter: 5, glass_cannon: 3,
};
const TRAP_DMG = 7; // measured spike damage 5-9
const TALENTS = new Map((talentTable as any[]).map((t) => [t.id, t]));
export function talentScore(o: any, world = false) {
  const id = o.talentId ?? o.id;
  const base = world && id === "greed" ? 0 : TALENT_PRIORITY[id] ?? 40;
  return base + (o.kind === "enhance" ? 3 : 0); // enhancing a top talent beats a mediocre new one
}
export function chooseTalent(options: any[], owned: any[], world = false): any {
  const score = (o: any) => talentScore(o, world);
  return [...options].sort((a, c) => score(c) - score(a))[0];
}
export const talentInfo = (id: string) => TALENTS.get(id);


let curCfg: PolicyConfig = DEFAULT_POLICY;
function nearestStairs(b: Board, dist: Map<string, number>, me: P) {
  let best: { k: string; d: number; id: string } | null = null;
  for (const s of b.stairs) {
    const k = key(s.x, s.y); const d = k === key(me.x, me.y) ? 0 : dist.get(k);
    if (d === undefined) continue;
    if (s.v2RoomType && !wantsRoom({ roomType: s.v2RoomType }, b.g, curCfg)) continue;
    const pref = s.v2RoomType ? -4 : 0; // a wanted special room is worth a small detour
    if (!best || d + pref < best.d) best = { k, d: d + pref, id: s.id };
  }
  return best;
}

function frontier(b: Board, dist: Map<string, number>) {
  let best: { k: string; d: number } | null = null;
  for (const [k, d] of dist) {
    const [x, y] = k.split(",").map(Number);
    const open = DIRS.some((dd) => { const n = step({ x, y }, dd); return b.inBounds(n.x, n.y) && !b.known(n.x, n.y); });
    if (open && d > 0 && (!best || d < best.d)) best = { k, d };
  }
  return best;
}

function threatRank(e: any) {
  const ph = e.v2AttackPhase ?? "idle";
  return ph === "preattack" ? 3 : ph === "charge" ? 2 : ph === "attack" ? 1 : 0;
}
const short = (e: any) => `${e.spriteType?.replace("v2_", "")}#${e.id.split("_").slice(-3).join("_")} hp${e.hp}`;

export function chooseUpgrade(opts: any[]): any {
  const rank: Record<string, number> = { legendary: 4, epic: 3, rare: 2, uncommon: 1, common: 0 };
  return [...opts].sort((a, c) => (rank[String(c.rarity ?? "").toLowerCase()] ?? 0) - (rank[String(a.rarity ?? "").toLowerCase()] ?? 0))[0];
}
export { manhattan };
