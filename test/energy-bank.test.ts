import { describe, it, expect } from "vitest";
import { decide, newMemory } from "../src/game/policy.js";
import { ENTRY_RESERVE } from "../src/game/value.js";

/**
 * Measured over the 45 run logs in data/runs (scripts/analyze-runs.mjs):
 *  - runs end at energy ~1, i.e. they starve rather than get beaten;
 *  - energy orbs returned 9,732 energy for 763 energy of walking, while treasure/amber/marble/corn
 *    returned ZERO for 1,699 — so a short bank must not be spent on them;
 *  - completed runs entered floor 5 with 92 energy and floor 10 with 85; runs that died entered with 58 and 31.
 */
function state(rows: string[], extra: Partial<any> = {}, player: Partial<any> = {}) {
  const map: number[][] = [], interactive: any[] = []; let px = 0, py = 0;
  rows.forEach((r, y) => { map.push([...r].map((ch, x) => {
    if (ch === "@") { px = x; py = y; }
    if (ch === "S") interactive.push({ id: "stairs_exit", type: "stairs", x, y });
    if (ch === "p") interactive.push({ id: `pot_${x}_${y}`, type: "pot", x, y });
    return ch === "#" ? 1 : 0; })); });
  return { runId: "t", turnNumber: 10, currentFloor: 4, status: "IN_PROGRESS", mapData: map, fogMask: map.map((r) => r.map(() => 2)),
    tileData: map, wallTileData: map, interactive, enemies: [], pickups: [], pendingUpgradeOptions: [],
    v2CurrentRoomType: null, v2UpgradeRoomPrompt: null,
    player: { x: px, y: py, energy: 40, maxEnergy: 100, attackPower: 12, level: 3, talents: [], items: { slots: [] },
      treasure: 100, pendingTalentRolls: [], ...player }, ...extra };
}
const orb = (x: number, y: number) => ({ id: `orb_${x}_${y}`, type: "large_energy_orb", x, y, value: 17 });
const gold = (x: number, y: number) => ({ id: `tr_${x}_${y}`, type: "treasure", x, y, value: 20 });
const room = ["##########", "#@.......#", "#........#", "#........#", "#.......S#", "##########"];

describe("energy bank before descending", () => {
  it("floor 5 and floor 10 carry the highest entry reserves", () => {
    expect(ENTRY_RESERVE[5]).toBeGreaterThan(ENTRY_RESERVE[6]);
    expect(ENTRY_RESERVE[10]).toBeGreaterThan(ENTRY_RESERVE[9]);
  });

  it("farms a reachable orb instead of taking the stairs while the bank is short", () => {
    // floor 4 -> next floor 5 needs 85; we hold 40, and an orb is reachable
    const g = state(room, { pickups: [orb(4, 2)] }, { energy: 40 });
    expect(decide(g).reason).not.toContain("stairs");
  });

  it("descends anyway once the floor has no energy left to farm", () => {
    const g = state(room, { pickups: [gold(4, 2)] }, { energy: 40 });
    expect(decide(g).reason).toContain("stairs");
  });

  it("descends once the bank is full even with an orb still lying around", () => {
    const g = state(room, { pickups: [orb(4, 2)] }, { energy: 95 });
    const why = decide(g).reason;
    expect(why.includes("stairs") || why.includes("orb")).toBe(true);
    expect(why).not.toContain("tunda");
  });

  it("ignores far treasure while the bank is short but still takes it on the way", () => {
    const far = state(room, { pickups: [gold(7, 3)] }, { energy: 40 });
    expect(decide(far).reason).not.toContain("treasure");
    const near = state(room, { pickups: [gold(2, 1)] }, { energy: 40 });
    expect(decide(near).reason).toContain("treasure");
  });
});

/**
 * Two brakes added after the first live runs under the bank rule. Farming a floor stops paying:
 * 176 turns on floor 6 burned 119 energy of walking to collect 92 of orbs, and 136 turns on floor 4
 * burned 90 to collect 79 — both net losses, while completed runs average ~110 turns per floor.
 */
describe("the energy-bank hold has to stop", () => {
  const wide = ["############", "#@.........#", "#..........#", "#..........#", "#.........S#", "############"];
  const small = { id: "s", type: "small_energy_orb", x: 6, y: 1, value: 8 };   // 5 steps away: nets only +3
  const fresh = (pickups: any[]) => decide(state(wide, { pickups }, { energy: 40 })).reason;
  const spent = (pickups: any[]) =>
    decide({ ...state(wide, { pickups }, { energy: 40 }), turnNumber: 200 },
      undefined, { ...newMemory(), floorSince: { floor: 4, turn: 0 } }).reason;

  it("walks past a marginal drop once the floor is spent", () => {
    // 176 turns on floor 6 burned 119 energy of walking for 92 of orbs: chasing +2 across a room is the leak
    expect(fresh([small])).toContain("orb");
    expect(spent([small])).toContain("stairs");
  });

  it("still takes a rich drop on a spent floor", () => {
    expect(spent([{ id: "l", type: "large_energy_orb", x: 3, y: 1, value: 17 }])).toContain("orb");
  });

  it("reports why it left", () => {
    expect(spent([small])).toContain("habis digarap");
  });
});

/**
 * Completed runs cleared floors far more thoroughly than runs that died — same floor, same measurement:
 *   floor 4: 10.5 objects broken vs 4.9, and 138 orb energy vs 50
 *   floor 7:  9.5 vs 4.0, and 108 vs 29
 * Breaking costs no energy, so an unbroken pot is energy the floor still owes us.
 */
describe("unbroken pots count as energy left on the floor", () => {
  const withPot = ["##########", "#@..p....#", "#........#", "#........#", "#.......S#", "##########"];

  it("holds the descent for a reachable pot, not just a loose orb", () => {
    const g = state(withPot, {}, { energy: 40 });   // floor 4 -> floor 5 wants 85 banked
    expect(decide(g).reason).not.toContain("stairs");
  });

  it("still leaves when the floor has neither pots nor orbs", () => {
    const bare = ["##########", "#@.......#", "#........#", "#........#", "#.......S#", "##########"];
    expect(decide(state(bare, {}, { energy: 40 })).reason).toContain("stairs");
  });
});
