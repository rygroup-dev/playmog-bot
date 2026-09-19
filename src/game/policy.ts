import type { Action, RunAction } from "./room.js";
import { Board, DIRS, dangerMap, dirTo, enemyConfig, key, manhattan, step, type P } from "./model.js";
import { chooseItem, ITEM_VALUE } from "./items.js";
import { breakValue, killCost, killValue, pickupValue, type Ctx } from "./value.js";
import talentTable from "./talents.json" with { type: "json" };

/** Run-scoped memory the runner keeps between turns (anti-loop). */
export interface PolicyMemory {
  blacklist: Map<string, number>;   // enemyId -> turn until which it is ignored
  dodges: Map<string, number>;      // enemyId -> dodges since we last damaged it
}
export const newMemory = (): PolicyMemory => ({ blacklist: new Map(), dodges: new Map() });

export interface PolicyConfig {
  energyReserve: number;      // keep this much energy beyond the path to the stairs
  exploreSlack: number;       // extra energy needed before chasing optional loot/exploration
  maxLootDetour: number;      // max path length to go for a breakable/pickup
  acceptRooms?: string[];     // special stairs rooms to enter (shrine, armory, jackalot, ...)
}
export const DEFAULT_POLICY: PolicyConfig = { energyReserve: 6, exploreSlack: 12, maxLootDetour: 14, acceptRooms: ["shrine", "armory", "jackalot"] };

export interface Decision { action?: Action; runAction?: RunAction; reason: string; danger: string[]; stuck?: boolean }

export function decide(g: any, cfg: PolicyConfig = DEFAULT_POLICY, mem: PolicyMemory = newMemory()): Decision {
  const b = new Board(g); curCfg = cfg;
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
    const pick = chooseTalent(options, g.player.talents ?? []);
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
  if (prompt && wantsRoom(prompt, g, cfg)) return { runAction: { type: "enter_upgrade_room" }, reason: `enter ${prompt.roomType ?? "next floor"} via ${prompt.stairsId}`, danger: dangerList };

  // special rooms: shrine / armory interactions are "break" on chest NPCs (client eJ()); first hit inspects, second confirms
  const room = g.v2CurrentRoomType ?? null;
  if (room === "shrine" || room === "armory") {
    const p = g.player;
    const targets = (g.interactive ?? []).filter((i: any) => room === "shrine"
      ? i.v2NpcType === "shrine" && p.energy <= p.maxEnergy - 20 && p.treasure >= shrineCost(p.v2ShrineUseCount ?? 0) && shrineCost(p.v2ShrineUseCount ?? 0) <= 50
      : typeof i.v2ArmoryItemId === "string" && (i.v2ArmoryCost ?? 0) <= Math.max(10, p.treasure * 0.15) && p.treasure >= (i.v2ArmoryCost ?? 0)
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
  if (here && here.dmg > 2 && (dodgeWorth || here.dmg >= 10)) { // several attackers firing together: always step out
    const safe = DIRS.map((d) => ({ d, p: step(me, d) }))
      .filter(({ p }) => b.walkable(p.x, p.y) && !b.enemyAt.has(key(p.x, p.y)))
      .map((o) => ({ ...o, risk: D.get(key(o.p.x, o.p.y))?.dmg ?? 0 }))
      .sort((a, c) => a.risk - c.risk);
    if (safe.length && safe[0].risk < here.dmg)
    {
      for (const id of here.ids) mem.dodges.set(id, (mem.dodges.get(id) ?? 0) + 1);
      return mk({ type: "move", direction: safe[0].d, targetX: safe[0].p.x, targetY: safe[0].p.y }, `dodge ${here.dmg}dmg from ${here.ids.map((x) => x.split("_").slice(-3).join("_")).join("/")}`);
    }
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
  const avoid = new Set(D.keys());
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
  const ctx: Ctx = { floor: g.currentFloor ?? 1, level: g.player.level ?? 0, atk, energy,
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
    const a = reachAdj(e); if (!a) continue;
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
  }

  goals.sort((a, c) => c.score - a.score);
  for (const goal of goals) {
    if (goal.k === key(me.x, me.y)) continue;
    const useAll = !dist.has(goal.k);
    const first = Board.firstStep(useAll ? prevAll : prev, me, goal.k);
    if (!first) continue;
    const d = dirTo(me, first)!;
    return mk({ type: "move", direction: d, targetX: first.x, targetY: first.y }, `${goal.why}${useAll ? " (through danger)" : ""}`);
  }
  // standing on stairs whose prompt we declined, or nothing reachable: pass costs 1 energy -> flag stuck
  return { ...mk({ type: "pass" }, "no reachable goal"), stuck: energy > 5 };
}

/** Which stairs prompts to accept. Default descend always; special rooms by rule (see roomPlan). */
function wantsRoom(prompt: any, g: any, cfg: PolicyConfig) {
  const rt = prompt.roomType ?? null;
  if (rt === null) return true;
  if (!(cfg.acceptRooms ?? []).includes(rt)) return false;
  const p = g.player;
  if (rt === "shrine") return p.energy <= p.maxEnergy - 20 && p.treasure >= shrineCost(p.v2ShrineUseCount ?? 0);
  if (rt === "armory") return p.treasure >= 60 && (p.items?.slots ?? []).filter((x: any) => x?.state === "unused").length < 2;
  return true; // jackalot etc.: movement is free inside
}
/** Shrine price per use (client fn eE): 10, 20, 30, 50, 80, 130 ... ; heal is always +20 energy. */
export function shrineCost(uses: number) {
  if (uses <= 0) return 10; if (uses === 1) return 20;
  let a = 10, b = 20; for (let i = 2; i <= uses; i++) { const n = a + b; a = b; b = n; } return b;
}


// Priority tuned for v2: energy is both HP and movement, score = treasure. Higher = better.
const TALENT_PRIORITY: Record<string, number> = {
  last_stand: 100, swift_steps: 95, vampiric: 92, greed: 90, renewal: 88, armor_plating: 85, divine_shield: 84, sharp_blade: 82,
  momentum: 80, apex_guard: 78, salvage: 76, cleave: 74, survival_instinct: 72, scavenger: 70, prospector: 68, critical_strike: 66,
  merciless: 64, frenzy: 62, poison_blade: 60, thorns: 58, scout: 56, disrupt: 54, corruption: 52, menace: 50, reach: 48,
  apex_hunter: 46, berserker: 30, heavy_hitter: 10, glass_cannon: 5,
};
const TALENTS = new Map((talentTable as any[]).map((t) => [t.id, t]));
export function chooseTalent(options: any[], owned: any[]): any {
  const score = (o: any) => {
    const id = o.talentId ?? o.id;
    const base = TALENT_PRIORITY[id] ?? 40;
    return base + (o.kind === "enhance" ? 3 : 0); // enhancing a top talent beats a mediocre new one
  };
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
