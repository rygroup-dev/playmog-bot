import { describe, it, expect } from "vitest";
import { killCost, killValue, breakValue, pickupValue, lootWeight } from "../src/game/value.js";

/**
 * Treasure is only paid out when a run ends, and 43 of 45 logged runs ended at energy ~1, so loot must not
 * be allowed to pay for energy the run cannot spare. Measured per enemy type over data/runs:
 *   mediumslime  520 kills · 2,530 damage taken · 1,471 orb energy → net -1,059   (chargeTurns 1, tanked)
 *   smallslime   476 kills ·    14 damage taken · 1,167 orb energy → net +1,153   (chargeTurns 2, dodged)
 *   skelechump   131 kills ·    96 damage taken ·   411 orb energy → net   +315   (chargeTurns 2, dodged)
 */
const ctx = (energy: number) => ({ floor: 5, level: 5, treasureMult: 1, atk: 12, energy });
const mediumslime = { id: "m", spriteType: "v2_mediumslime", hp: 25, damage: 5, v2DamageMax: 8 };
const smallslime = { id: "s", spriteType: "v2_smallslime", hp: 15, damage: 3, v2DamageMax: 5 };
const net = (e: any, energy: number) => killValue(e, ctx(energy)) - killCost(e, ctx(energy));

describe("loot is worth nothing to a run that is about to starve", () => {
  it("scales from nothing at 0 energy to full weight at 60", () => {
    expect(lootWeight(0)).toBe(0);
    expect(lootWeight(30)).toBeCloseTo(0.5);
    expect(lootWeight(60)).toBe(1);
    expect(lootWeight(200)).toBe(1);   // never above full
  });

  it("stops paying for a mediumslime with damage the run cannot afford", () => {
    expect(net(mediumslime, 20)).toBeLessThan(0);    // starving: its 4.9 dmg/kill is not worth the loot
    expect(net(mediumslime, 90)).toBeGreaterThan(0); // comfortable: treasure counts again
  });

  it("still fights the enemies that are measurably free", () => {
    // smallslime is dodged (chargeTurns 2) and cost 14 energy across 476 kills — always worth it
    expect(net(smallslime, 20)).toBeGreaterThan(0);
    expect(net(smallslime, 90)).toBeGreaterThan(0);
  });

  it("devalues treasure and amber pickups the same way, but never energy orbs", () => {
    const orb = { type: "large_energy_orb", value: 17 };
    expect(pickupValue(orb, ctx(10))).toBe(pickupValue(orb, ctx(90)));
    expect(pickupValue({ type: "treasure", value: 20 }, ctx(10)))
      .toBeLessThan(pickupValue({ type: "treasure", value: 20 }, ctx(90)));
    expect(pickupValue({ type: "amber", value: 2 }, ctx(10)))
      .toBeLessThan(pickupValue({ type: "amber", value: 2 }, ctx(90)));
  });

  it("applies to breakables too", () => {
    expect(breakValue(ctx(10))).toBeLessThan(breakValue(ctx(90)));
  });
});
