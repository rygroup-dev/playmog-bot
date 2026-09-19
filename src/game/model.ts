// Pure game model helpers. Every rule here is taken from the official client code
// (isWalkable, isMovementBlockingInteractive, isBreakableInteractive, isEnemyInvincible,
// updateTelegraph, applyCues) or the V2_ENEMY_CONFIGS table — documented in the README.
import enemyCfg from "./enemies.json" with { type: "json" };

export type Dir = "up" | "down" | "left" | "right";
export interface P { x: number; y: number }
export const DIRS: Dir[] = ["up", "down", "left", "right"];
export const step = (p: P, d: Dir): P =>
  d === "up" ? { x: p.x, y: p.y - 1 } : d === "down" ? { x: p.x, y: p.y + 1 } : d === "left" ? { x: p.x - 1, y: p.y } : { x: p.x + 1, y: p.y };
export const key = (x: number, y: number) => `${x},${y}`;
export const manhattan = (a: P, b: P) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
export const dirTo = (a: P, b: P): Dir | null =>
  b.x === a.x && b.y === a.y - 1 ? "up" : b.x === a.x && b.y === a.y + 1 ? "down" : b.y === a.y && b.x === a.x - 1 ? "left" : b.y === a.y && b.x === a.x + 1 ? "right" : null;

export interface EnemyCfg { hp: number; damage: number; damageMax?: number; attackRange: number; chargeTurns: number; restTurns: number;
  randomMove?: boolean; aggroRange?: number; attackKind?: string; moveEveryNTurns?: number; fleeFromPlayer?: boolean }
export const ENEMIES = enemyCfg as Record<string, EnemyCfg>;
export const enemyConfig = (e: any): EnemyCfg | undefined => ENEMIES[e.spriteType];

export const isBlockingInteractive = (i: any) => ["pot", "crate", "chest", "rock"].includes(i.type);
export const isBreakable = (i: any) => i.type === "pot" || i.type === "crate";
export const isInvincible = (e: any) => (e.maxHp ?? 0) <= 0;

export class Board {
  readonly h: number; readonly w: number;
  readonly blocked = new Set<string>();
  readonly enemyAt = new Map<string, any>();
  readonly breakableAt = new Map<string, any>();
  readonly pickupAt = new Map<string, any>();
  readonly stairs: any[] = [];
  constructor(readonly g: any) {
    this.h = g.mapData.length; this.w = g.mapData[0]?.length ?? 0;
    for (const i of g.interactive ?? []) {
      if (isBlockingInteractive(i)) this.blocked.add(key(i.x, i.y));
      if (isBreakable(i)) this.breakableAt.set(key(i.x, i.y), i);
      if (i.type === "stairs") this.stairs.push(i);
    }
    for (const e of g.enemies ?? []) {
      if (isInvincible(e)) this.blocked.add(key(e.x, e.y)); else this.enemyAt.set(key(e.x, e.y), e);
    }
    for (const p of g.pickups ?? []) this.pickupAt.set(key(p.x, p.y), p);
  }
  inBounds(x: number, y: number) { return y >= 0 && y < this.h && x >= 0 && x < this.w; }
  /** tile is floor (mapData==0) — ignoring entities */
  floor(x: number, y: number) { return this.inBounds(x, y) && this.g.mapData[y][x] === 0; }
  /** exactly the client's isWalkable() */
  walkable(x: number, y: number) { return this.floor(x, y) && !this.blocked.has(key(x, y)); }
  known(x: number, y: number) { return this.inBounds(x, y) && (this.g.fogMask?.[y]?.[x] ?? 0) > 0; }

  /** BFS from `from` over walkable tiles; enemies are obstacles unless `throughEnemies`. */
  bfs(from: P, opts: { throughEnemies?: boolean; avoid?: Set<string> } = {}) {
    const dist = new Map<string, number>(); const prev = new Map<string, string>();
    const q: P[] = [from]; dist.set(key(from.x, from.y), 0);
    while (q.length) {
      const c = q.shift()!; const dc = dist.get(key(c.x, c.y))!;
      for (const d of DIRS) {
        const n = step(c, d); const k = key(n.x, n.y);
        if (dist.has(k) || !this.walkable(n.x, n.y)) continue;
        if (!opts.throughEnemies && this.enemyAt.has(k)) continue;
        if (opts.avoid?.has(k)) continue;
        dist.set(k, dc + 1); prev.set(k, key(c.x, c.y)); q.push(n);
      }
    }
    return { dist, prev };
  }
  /** first step of the shortest path to `to` (to may be a non-walkable target we stand next to) */
  static firstStep(prev: Map<string, string>, from: P, toKey: string): P | null {
    let cur = toKey; const fk = key(from.x, from.y);
    if (!prev.has(cur)) return null;
    while (prev.get(cur) !== fk) { const p = prev.get(cur); if (!p) return null; cur = p; }
    const [x, y] = cur.split(",").map(Number); return { x, y };
  }
}

/**
 * Tiles an enemy will hit when its telegraphed attack fires.
 * Mirrors updateTelegraph/applyCues: directional attacks hit the line of floor tiles leaving the
 * enemy's footprint in v2AttackDir; aoe/explode hit orthogonal neighbours (explode: full 3x3 ring).
 * Range is clipped to attackRange (reach/dash) since the client line walks until a wall.
 */
export function threatTiles(b: Board, e: any): Set<string> {
  const out = new Set<string>();
  const cfg = enemyConfig(e); const phase = e.v2AttackPhase ?? "idle";
  // "attack" = already fired this enemy phase (then "rest"); only a pending telegraph threatens us.
  if (!(phase === "charge" || phase === "preattack")) return out;
  const kind = cfg?.attackKind;
  if (kind === "aoe") { for (const d of DIRS) { const n = step(e, d); out.add(key(n.x, n.y)); } return out; }
  if (kind === "explode") { for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (dx || dy) out.add(key(e.x + dx, e.y + dy)); return out; }
  if (typeof e.v2AttackTargetX === "number" && typeof e.v2AttackTargetY === "number") out.add(key(e.v2AttackTargetX, e.v2AttackTargetY));
  const dir: Dir | undefined = e.v2AttackDir;
  if (dir) {
    const range = Math.max(1, cfg?.attackRange ?? 1);
    let p: P = { x: e.x, y: e.y };
    for (let i = 0; i < range; i++) { p = step(p, dir); if (!b.floor(p.x, p.y)) break; out.add(key(p.x, p.y)); }
  }
  return out;
}

/**
 * Telegraphed danger per tile. Server timing (verified live 2026-09-19): an enemy in `charge` with
 * v2AttackTurns=n fires in the enemy phase right after our n-th action from now, so only n<=1
 * (or `preattack`) is `imminent` for the action we are about to take.
 * `exclude` = enemy ids our action will kill (they never fire).
 */
export function dangerMap(b: Board, exclude: Set<string> = new Set()) {
  const all = new Map<string, { dmg: number; imminent: boolean; ids: string[] }>();
  for (const e of b.g.enemies ?? []) {
    if (exclude.has(e.id)) continue;
    const tiles = threatTiles(b, e);
    if (!tiles.size) continue;
    const imminent = e.v2AttackPhase === "preattack" || (e.v2AttackPhase === "charge" && (e.v2AttackTurns ?? 0) <= 1);
    if (!imminent) continue;
    const dmg = expectedDamage(e);
    for (const t of tiles) {
      const cur = all.get(t) ?? { dmg: 0, imminent: false, ids: [] };
      cur.dmg += dmg; cur.imminent ||= imminent; cur.ids.push(e.id); all.set(t, cur);
    }
  }
  return all;
}
export function expectedDamage(e: any) {
  const cfg = enemyConfig(e);
  const lo = e.damage ?? cfg?.damage ?? 5; const hi = e.v2DamageMax ?? cfg?.damageMax ?? lo;
  return (lo + hi) / 2;
}
