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

export function chooseItem(g: any, b: Board, opts: { imminentHere: number; stairsDist: number | null }): ItemDecision | null {
  const slots: any[] = g.player.items?.slots ?? [];
  const me: P = { x: g.player.x, y: g.player.y };
  const atk = g.player.attackPower ?? 10;
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
        // only worth a slot when it saves real work: kill a threat, hit 2+, or chunk a tank
        if (score >= 4 && (!best || score > best.score)) best = { d, score, why: `${id} ${d} -> ${targets.map((e) => e.spriteType.replace("v2_", "")).join("+")}` };
      }
      if (best) { const t = step(me, best.d); return { action: { type: "use_item", slotIndex: i, targetX: t.x, targetY: t.y }, reason: best.why }; }
    }
    if (id === "sticky_bomb") {
      const tgt = (g.enemies ?? []).filter((e: any) => e.hp >= 40 && (e.maxHp ?? 0) > 0 && manhattan(me, e) <= 10 && b.known(e.x, e.y)).sort((a: any, c: any) => c.hp - a.hp)[0];
      if (tgt) return { action: { type: "use_item", slotIndex: i, targetX: tgt.x, targetY: tgt.y }, reason: `sticky_bomb -> ${tgt.spriteType} hp${tgt.hp}` };
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
  talisman: 4, decoy: 3, chain_hook: 3, switcher: 2, pogo_stick: 2, pocket_portal: 2, escape_rope: 1, bomb: 1,
};
export const isThreat = (e: any) => { const c = enemyConfig(e); return !!c && (e.v2AttackPhase === "charge" || e.v2AttackPhase === "preattack"); };
