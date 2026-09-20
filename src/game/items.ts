// In-run item usage. Targeting rules mirror the official client's useItem():
//  - arrow items (single/chain/piercing shot, chain_hook): target = the ADJACENT tile in the firing direction
//  - tile items: shock_grenade r4, decoy r3, pogo_stick r3, switcher/sticky_bomb/talisman r10 (must be an enemy tile)
//  - bomb: one of the 8 neighbouring tiles; the rest need no target.
import type { Action } from "./room.js";
import { Board, DIRS, key, manhattan, step, type P, enemyConfig } from "./model.js";

// v2 damage per the item tooltips (idleV2)
const SHOT_DMG: Record<string, number> = { single_shot: 25, piercing_shot: 25, chain_shot: 35 };

export interface ItemDecision { action: Action; reason: string }

function lineEnemies(b: Board, from: P, dir: (typeof DIRS)[number], max = 12) {
  const out: any[] = []; let p = from;
  for (let i = 0; i < max; i++) {
    p = step(p, dir);
    if (!b.floor(p.x, p.y)) break;               // walls stop projectiles
    const e = b.enemyAt.get(key(p.x, p.y));
    if (e) out.push(e);
  }
  return out;
}

const isBoss = (e: any) => /jackalot|dragma|boss/.test(String(e?.spriteType ?? e?.id ?? ""));

export function chooseItem(g: any, b: Board, opts: { imminentHere: number; stairsDist: number | null }): ItemDecision | null {
  const slots: any[] = g.player.items?.slots ?? [];
  const me: P = { x: g.player.x, y: g.player.y };
  const atk = g.player.attackPower ?? 10;
  // Floor 10 ends with Sir Jackalot (150 hp). Damage items are worth far more there than on a slime, so from
  // floor 9 they are saved for the boss — unless we are about to be hit hard anyway.
  const boss = (g.enemies ?? []).find((e: any) => isBoss(e) && (e.hp ?? 0) > 0);
  const saveForBoss = !boss && (g.currentFloor ?? 1) >= 9 && opts.imminentHere < 12;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (!s || s.state !== "unused") continue;
    const id: string = s.itemId;

    if (id in SHOT_DMG) {
      const dmg = SHOT_DMG[id];
      let best: { d: (typeof DIRS)[number]; score: number; why: string } | null = null;
      for (const d of DIRS) {
        const line = lineEnemies(b, me, d);
        if (!line.length) continue;
        const targets = id === "piercing_shot" ? line.slice(0, 3) : line.slice(0, 1);
        let score = 0;
        for (const e of targets) {
          const kills = e.hp <= dmg;
          const threat = e.v2AttackPhase === "charge" || e.v2AttackPhase === "preattack";
          const meleeHits = Math.ceil(e.hp / Math.max(1, atk));
          score += (kills ? 3 : 1) + (threat ? 2 : 0) + (meleeHits >= 3 ? 2 : 0);
        }
        if (saveForBoss && !targets.some(isBoss)) continue;          // keep the damage for the final boss
        if (boss && !targets.some(isBoss)) continue;                   // boss is up: never waste a shot elsewhere
        // only worth a slot when it saves real work: kill a threat, hit 2+, or chunk a tank
        if (score >= 4 && (!best || score > best.score)) best = { d, score, why: `${id} ${d} -> ${targets.map((e) => e.spriteType.replace("v2_", "")).join("+")}` };
      }
      if (best) { const t = step(me, best.d); return { action: { type: "use_item", slotIndex: i, targetX: t.x, targetY: t.y }, reason: best.why }; }
    }
    if (id === "sticky_bomb") {
      const pool = (g.enemies ?? []).filter((e: any) => e.hp >= 40 && (e.maxHp ?? 0) > 0 && manhattan(me, e) <= 10 && b.known(e.x, e.y));
      const tgt = boss && pool.some(isBoss) ? pool.find(isBoss) : saveForBoss ? undefined : pool.sort((a: any, c: any) => c.hp - a.hp)[0];
      if (tgt) return { action: { type: "use_item", slotIndex: i, targetX: tgt.x, targetY: tgt.y }, reason: `sticky_bomb -> ${tgt.spriteType} hp${tgt.hp}` };
    }
    if (id === "bomb") { // 8-neighbour blast; unused until now, and it is free damage on the boss
      const near = DIRS.map((d) => step(me, d)).concat([{ x: me.x + 1, y: me.y + 1 }, { x: me.x - 1, y: me.y + 1 }, { x: me.x + 1, y: me.y - 1 }, { x: me.x - 1, y: me.y - 1 }])
        .map((p) => ({ p, e: b.enemyAt.get(key(p.x, p.y)) })).filter((o) => o.e && (o.e.maxHp ?? 0) > 0);
      const onBoss = near.find((o) => isBoss(o.e));
      const pick = onBoss ?? (saveForBoss ? undefined : near.find((o) => o.e.hp >= 25) ?? (near.length >= 2 ? near[0] : undefined));
      if (pick) return { action: { type: "use_item", slotIndex: i, targetX: pick.p.x, targetY: pick.p.y }, reason: `bomb -> ${pick.e.spriteType.replace("v2_", "")} hp${pick.e.hp}` };
    }
    if (id === "midas_touch") {
      const adj = DIRS.map((d) => b.enemyAt.get(key(step(me, d).x, step(me, d).y))).find((e) => e && e.hp >= 25 && !/jackalot|dragma|boss/.test(e.spriteType));
      if (adj) return { action: { type: "use_item", slotIndex: i }, reason: `midas_touch before hitting ${adj.spriteType}` };
    }
    if (id === "magnet") {
      const near = [...b.pickupAt.values()].filter((p) => Math.abs(p.x - me.x) <= 3 && Math.abs(p.y - me.y) <= 3 && manhattan(me, p) > 1);
      if (near.length >= 3) return { action: { type: "use_item", slotIndex: i }, reason: `magnet (${near.length} drops)` };
    }
    if (id === "gas_pedal" && opts.stairsDist !== null && opts.stairsDist >= 12) {
      return { action: { type: "use_item", slotIndex: i }, reason: `gas_pedal (stairs ${opts.stairsDist} away)` };
    }
    if (id === "shock_grenade") {
      const threats = (g.enemies ?? []).filter((e: any) => (e.v2AttackPhase === "charge" || e.v2AttackPhase === "preattack") && manhattan(me, e) <= 4);
      if (threats.length >= 2 || (threats.length && opts.imminentHere > 8)) {
        const cx = Math.round(threats.reduce((s: number, e: any) => s + e.x, 0) / threats.length);
        const cy = Math.round(threats.reduce((s: number, e: any) => s + e.y, 0) / threats.length);
        return { action: { type: "use_item", slotIndex: i, targetX: cx, targetY: cy }, reason: `shock_grenade on ${threats.length} threats` };
      }
    }
    if (id === "talisman") {
      const ghost = (g.enemies ?? []).find((e: any) => e.spriteType.includes("ghost") && manhattan(me, e) <= 10 && b.known(e.x, e.y));
      if (ghost) return { action: { type: "use_item", slotIndex: i, targetX: ghost.x, targetY: ghost.y }, reason: "talisman -> ghost" };
    }
  }
  return null;
}

/** Relative value used when the slots are full and a new item is offered. */
export const ITEM_VALUE: Record<string, number> = {
  sticky_bomb: 9, chain_shot: 8, piercing_shot: 8, single_shot: 7, midas_touch: 7, shock_grenade: 6, magnet: 6, gas_pedal: 6,
  talisman: 4, decoy: 3, chain_hook: 3, switcher: 2, pogo_stick: 2, pocket_portal: 2, escape_rope: 1, bomb: 5,
};
export const isThreat = (e: any) => { const c = enemyConfig(e); return !!c && (e.v2AttackPhase === "charge" || e.v2AttackPhase === "preattack"); };
