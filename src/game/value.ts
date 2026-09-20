// Value model for goal selection. All rates are MEASURED from our own run logs (461 kills, 265 breakables,
// 13 runs, 2026-09-19) — see scripts/analyze.py. Units: "energy-equivalent" (EE): energy + treasure/TPE.
import { enemyConfig } from "./model.js";

/** Treasure-per-energy exchange rate: what one energy is worth in treasure when reinvested (measured ~3.7-4). */
export const TPE = 4;

/**
 * Energy the run must hold before descending to floor f. Measured over 45 logged runs (scripts/analyze-runs.mjs):
 * floors 5 and 10 are the two spikes. Completed runs entered f5 with 92 energy and f10 with 85; runs that died
 * entered with 58 and 31. Floor 10 alone burns ~137 energy while its own drops only refund ~22.
 * Only enforced while there is still energy worth farming on the current floor, so an exhausted floor never strands.
 */
export const ENTRY_RESERVE: Record<number, number> = { 5: 85, 6: 55, 7: 55, 8: 60, 9: 60, 10: 110 };

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

export interface Ctx { floor: number; level: number; treasureMult: number; atk: number; energy: number; weatherHit?: number }

/** Extra energy each enemy hit costs under the current weather (client weather panel, verified text):
 *  miasma = poison 1/turn × 5, heatwave = burn 1/turn × 3, blizzard = frostbite: our attacks cost 2 for 5 turns. */
export function weatherHitCost(g: any): number {
  const w = g?.v2Weather; const kind = typeof w === "string" ? w : w?.type ?? w?.kind ?? w?.weather ?? null;
  return kind === "miasma" ? 4 : kind === "heatwave" ? 3 : kind === "blizzard" ? 4 : 0;
}

/**
 * Expected energy lost (damage + dodge steps) to kill enemy `e`, from its telegraph cycle.
 * `approach` is how far we still have to walk to reach it, which only matters for attackers that can hit
 * us on the way in.
 */
export function killCost(e: any, c: Ctx, approach = 0) {
  const cfg = enemyConfig(e);
  const hp = Math.max(1, e.hp ?? cfg?.hp ?? 20);
  const hits = Math.ceil(hp / Math.max(1, c.atk * 1.05));             // ~5% crit baseline
  const charge = Math.max(1, cfg?.chargeTurns ?? 1), rest = cfg?.restTurns ?? 1;
  const dmg = ((e.damage ?? cfg?.damage ?? 5) + (e.v2DamageMax ?? cfg?.damageMax ?? e.damage ?? 5)) / 2;
  let cost: number;
  if (hits <= charge) cost = 0;                                          // dies before it ever fires
  else if (charge >= 2) cost = 2 * Math.ceil((hits - charge) / charge);  // dodge + return per extra cycle
  else cost = (dmg + (c.weatherHit ?? 0)) * Math.ceil((hits - 1) / (1 + rest)); // chargeTurns 1: tank one hit per cycle
  const kind = cfg?.attackKind;
  if (kind === "dash" || kind === "projectile" || kind === "reach") cost *= 1.3; // hits from range
  if (kind === "aoe" || kind === "explode") cost *= 1.2;
  if (kind === "spawner") cost += 6;
  // Approach exposure. "Dies before it ever fires" only holds for a melee enemy we are already standing next
  // to; a ranged attacker keeps shooting while we close the gap. Measured over the run logs this was the
  // single worst mispricing in the model: skelearcher (projectile, 12-15 damage, dies in 2 hits so the fight
  // itself scored 0) actually cost 9.4 energy per kill and 302 energy across 32 kills for 96 of orbs.
  const reach = cfg?.attackRange ?? 1;
  if (approach > reach && (kind === "projectile" || kind === "dash" || kind === "reach"))
    cost += (dmg + (c.weatherHit ?? 0)) * Math.max(1, Math.floor((approach - reach) / (charge + rest)));
  return cost;
}

/**
 * How much a unit of treasure is worth right now. Treasure only pays out when the run ENDS, and 43 of 45
 * logged runs ended at energy ~1 — so while energy is short, loot must not be allowed to subsidise a fight
 * that costs energy. Measured example: a mediumslime returns 2.8 orb-energy per kill and costs 4.9 damage
 * (net -2.1), yet TPE alone scored it +2.8 because treasure covered the difference. 520 of those kills cost
 * 2,530 energy across the logs. Full weight from 60 energy up, nothing at 0.
 */
export const lootWeight = (energy: number) => Math.max(0, Math.min(1, energy / 60));

/** Expected value (EE) of killing enemy e: treasure + orbs + xp→energy + marbles (tiny). */
export function killValue(e: any, c: Ctx) {
  if (e.id === "v2_jackalot" || e.spriteType === "v2_jackalot") return 200; // bounty roll + full energy restore
  const xp = e.spriteType === "v2_frogspawn" ? 60 : 15;
  const energy = 0.21 * smallOrb(c.floor) + 0.09 * largeOrb(c.floor) + xp * energyPerXp(c.level);
  const treasure = 0.66 * treasurePerDrop(c.floor) * c.treasureMult;
  return energy + (treasure / TPE) * lootWeight(c.energy) + 0.28 * 0.5;  // marbles ≈ small bonus
}

export function breakValue(c: Ctx) {
  const energy = 0.16 * smallOrb(c.floor) + 0.07 * largeOrb(c.floor) + 0.09 * 25 * energyPerXp(c.level);
  const treasure = 0.48 * treasurePerDrop(c.floor) * c.treasureMult;
  return energy + (treasure / TPE) * lootWeight(c.energy) + 0.23 * 0.3 - 0.05 * 4; // corn bonus, 5% mimic risk
}

export function pickupValue(p: any, c: Ctx) {
  const v = Number(p.value ?? 0);
  switch (p.type) {
    case "small_energy_orb": case "large_energy_orb": return v || (p.type === "small_energy_orb" ? smallOrb(c.floor) : largeOrb(c.floor));
    case "treasure": return ((v || treasurePerDrop(c.floor)) / TPE) * lootWeight(c.energy);
    case "amber": return (((v || treasurePerDrop(c.floor) / 10) * 10) / TPE) * lootWeight(c.energy); // worldseeds drop at 1/10 of treasure
    case "raffle_ticket": return 12;
    case "v2_xp_orb": return (v || 25) * energyPerXp(c.level);
    case "marble": return 1.5;
    case "golden_corn": return 0.8;
    case "item": return 6;
    case "arcade_key": case "gem": return 50;
    default: return v ? v / TPE : 2;
  }
}
