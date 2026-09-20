import { describe, it, expect } from "vitest";
import { killCost, killValue } from "../src/game/value.js";

/**
 * Measured net energy per kill over the run logs (scripts/analyze-runs.mjs), by enemy type:
 *   skelearcher   32 kills · 302 damage taken ·   96 orb energy → -6.4 each   (projectile, 12-15 dmg)
 *   mediumslime  520 kills · 2530 damage taken · 1471 orb energy → -2.1 each
 *   bat          228 kills ·  941 damage taken ·  715 orb energy → -1.0 each  (dash, range 4)
 *   skelechump   131 kills ·   96 damage taken ·  411 orb energy → +2.4 each
 *   smallslime   476 kills ·   14 damage taken · 1167 orb energy → +2.4 each
 *
 * The model used to price a skelearcher at +9.7: it dies in two hits and telegraphs for two turns, so
 * "dies before it ever fires" zeroed the fight — ignoring that an archer shoots us all the way in.
 */
const ctx = (energy = 87) => ({ floor: 6, level: 8, treasureMult: 1, atk: 16, energy });
const e = (spriteType: string, hp: number, damage: number, v2DamageMax: number) => ({ id: spriteType, spriteType, hp, damage, v2DamageMax });
const skelearcher = e("v2_skelearcher", 20, 12, 15);
const smallslime = e("v2_smallslime", 15, 3, 5);
const skelechump = e("v2_skelechump", 45, 10, 12);
/** what the policy actually computes: walk there, then fight it */
const net = (x: any, d: number) => killValue(x, ctx()) - (d + killCost(x, ctx(), d));

describe("a ranged enemy is not free just because it dies in two hits", () => {
  it("prices an archer we have to walk up to as a loss", () => {
    expect(net(skelearcher, 6)).toBeLessThan(0);
  });

  it("charges nothing extra once we are already next to it", () => {
    // standing adjacent, the approach is over — only the fight itself counts
    expect(killCost(skelearcher, ctx(), 1)).toBe(killCost(skelearcher, ctx(), 0));
  });

  it("scales with the distance we have to cross under fire", () => {
    expect(killCost(skelearcher, ctx(), 12)).toBeGreaterThan(killCost(skelearcher, ctx(), 4));
  });

  it("leaves melee enemies alone", () => {
    expect(killCost(smallslime, ctx(), 8)).toBe(killCost(smallslime, ctx(), 0));
    expect(killCost(skelechump, ctx(), 8)).toBe(killCost(skelechump, ctx(), 0));
  });

  it("still fights the enemies that measured positive", () => {
    expect(net(smallslime, 6)).toBeGreaterThan(0);
    expect(net(skelechump, 6)).toBeGreaterThan(0);
  });
});
