// Value model for goal selection. All rates are MEASURED from our own run logs (461 kills, 265 breakables,
// 13 runs, 2026-09-19) — see scripts/analyze.py. Units: "energy-equivalent" (EE): energy + treasure/TPE.
import { enemyConfig } from "./model.js";

/** Treasure-per-energy exchange rate: what one energy is worth in treasure when reinvested (measured ~3.7-4). */
export const TPE = 4;

// cumulative XP needed to reach level n (from level_up events)
const XP_CUM = [0, 60, 125, 215, 325, 450, 595, 745, 905, 1080, 1315, 1560, 1830, 2120, 2440, 2790];
/** energy gained per XP right now (+10 energy per level-up, level cap 15). */
export function energyPerXp(level: number) {
  if (level >= 15) return 0;
  const need = (XP_CUM[level + 1] ?? XP_CUM[level] + 300) - (XP_CUM[level] ?? 0);
  return 10 / Math.max(1, need);
}
const treasurePerDrop = (floor: number) => 12 + 3.2 * floor;           // 16 @f1 … ~40 @f8
const smallOrb = (floor: number) => 6 + 0.55 * floor;                   // 6.4 @f1 … 10.5 @f8
const largeOrb = (floor: number) => 12.8 + 0.8 * floor;                 // 13.5 @f1 … 20 @f8

export interface Ctx { floor: number; level: number; treasureMult: number; atk: number; energy: number }

/** Expected energy lost (damage + dodge steps) to kill enemy `e`, from its telegraph cycle. */
export function killCost(e: any, c: Ctx) {
  const cfg = enemyConfig(e);
  const hp = Math.max(1, e.hp ?? cfg?.hp ?? 20);
  const hits = Math.ceil(hp / Math.max(1, c.atk * 1.05));             // ~5% crit baseline
  const charge = Math.max(1, cfg?.chargeTurns ?? 1), rest = cfg?.restTurns ?? 1;
  const dmg = ((e.damage ?? cfg?.damage ?? 5) + (e.v2DamageMax ?? cfg?.damageMax ?? e.damage ?? 5)) / 2;
  let cost: number;
  if (hits <= charge) cost = 0;                                          // dies before it ever fires
  else if (charge >= 2) cost = 2 * Math.ceil((hits - charge) / charge);  // dodge + return per extra cycle
  else cost = dmg * Math.ceil((hits - 1) / (1 + rest));                  // chargeTurns 1: tank one hit per cycle
  const kind = cfg?.attackKind;
  if (kind === "dash" || kind === "projectile" || kind === "reach") cost *= 1.3; // hits from range
  if (kind === "aoe" || kind === "explode") cost *= 1.2;
  if (kind === "spawner") cost += 6;
  return cost;
}

/** Expected value (EE) of killing enemy e: treasure + orbs + xp→energy + marbles (tiny). */
export function killValue(e: any, c: Ctx) {
  if (e.id === "v2_jackalot" || e.spriteType === "v2_jackalot") return 200; // bounty roll + full energy restore
  const xp = e.spriteType === "v2_frogspawn" ? 60 : 15;
  const energy = 0.21 * smallOrb(c.floor) + 0.09 * largeOrb(c.floor) + xp * energyPerXp(c.level);
  const treasure = 0.66 * treasurePerDrop(c.floor) * c.treasureMult;
  return energy + treasure / TPE + 0.28 * 0.5;                          // marbles ≈ small bonus
}

export function breakValue(c: Ctx) {
  const energy = 0.16 * smallOrb(c.floor) + 0.07 * largeOrb(c.floor) + 0.09 * 25 * energyPerXp(c.level);
  const treasure = 0.48 * treasurePerDrop(c.floor) * c.treasureMult;
  return energy + treasure / TPE + 0.23 * 0.3 - 0.05 * 4;              // corn bonus, 5% mimic risk
}

export function pickupValue(p: any, c: Ctx) {
  const v = Number(p.value ?? 0);
  switch (p.type) {
    case "small_energy_orb": case "large_energy_orb": return v || (p.type === "small_energy_orb" ? smallOrb(c.floor) : largeOrb(c.floor));
    case "treasure": return (v || treasurePerDrop(c.floor)) / TPE;
    case "amber": return ((v || treasurePerDrop(c.floor) / 10) * 10) / TPE;   // worldseeds drop at 1/10 of treasure
    case "raffle_ticket": return 12;
    case "v2_xp_orb": return (v || 25) * energyPerXp(c.level);
    case "marble": return 1.5;
    case "golden_corn": return 0.8;
    case "item": return 6;
    case "arcade_key": case "gem": return 50;
    default: return v ? v / TPE : 2;
  }
}
