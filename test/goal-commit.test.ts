import { describe, it, expect } from "vitest";
import { decide, newMemory } from "../src/game/policy.js";

/**
 * Measured over the run logs (scripts/analyze-runs.mjs): 13% of real moves in runs that died were a step
 * back onto the tile two moves earlier, against 7% in runs that completed, and the commonest wasteful
 * pattern was "pickup large_energy_orb | pickup large_energy_orb | pickup large_energy_orb" (145x) —
 * the bot walking to orb A, changing its mind to orb B behind it, then back to A.
 */
function state(rows: string[], extra: Partial<any> = {}, player: Partial<any> = {}) {
  const map: number[][] = [], interactive: any[] = []; let px = 0, py = 0;
  rows.forEach((r, y) => { map.push([...r].map((ch, x) => {
    if (ch === "@") { px = x; py = y; }
    if (ch === "S") interactive.push({ id: "stairs_exit", type: "stairs", x, y });
    return ch === "#" ? 1 : 0; })); });
  return { runId: "t", turnNumber: 10, currentFloor: 3, status: "IN_PROGRESS", mapData: map, fogMask: map.map((r) => r.map(() => 2)),
    tileData: map, wallTileData: map, interactive, enemies: [], pickups: [], pendingUpgradeOptions: [],
    v2CurrentRoomType: null, v2UpgradeRoomPrompt: null,
    player: { x: px, y: py, energy: 70, maxEnergy: 100, attackPower: 12, level: 3, talents: [], items: { slots: [] },
      treasure: 100, pendingTalentRolls: [], ...player }, ...extra };
}
// player in the middle, one orb to each side
const room = ["#############", "#...........#", "#.....@.....#", "#...........#", "#..........S#", "#############"];
const orb = (id: string, x: number, y: number, value: number) => ({ id, type: "large_energy_orb", x, y, value });

describe("the bot finishes the walk it started", () => {
  it("keeps its goal when the rival is only slightly better", () => {
    const mem = newMemory();
    const left = orb("L", 2, 2, 17), right = orb("R", 10, 2, 17);
    const first = decide(state(room, { pickups: [left, right] }), undefined, mem);
    expect(first.action?.type).toBe("move");
    const dir = first.action!.direction;
    // next turn the other orb is worth a little more — not enough to justify turning around
    const better = dir === "left" ? [left, orb("R", 10, 2, 19)] : [orb("L", 2, 2, 19), right];
    const second = decide(state(room, { pickups: better }), undefined, mem);
    expect(second.action?.direction).toBe(dir);
  });

  it("does turn around for a clearly better goal", () => {
    const mem = newMemory();
    const left = orb("L", 2, 2, 17), right = orb("R", 10, 2, 17);
    const first = decide(state(room, { pickups: [left, right] }), undefined, mem);
    const dir = first.action!.direction;
    // the other side is now worth far more: switching is correct
    const muchBetter = dir === "left" ? [left, orb("R", 7, 2, 40)] : [orb("L", 5, 2, 40), right];
    const second = decide(state(room, { pickups: muchBetter }), undefined, mem);
    expect(second.action?.direction).not.toBe(dir);
  });
});

/**
 * Energy orbs returned 9,732 energy for 763 of walking across the run logs, and completed runs covered
 * about twice the unique tiles per floor. A flat "only explore above 45 energy" gate meant that below it
 * the bot stopped looking, so it stopped finding, so energy only fell further. affordable() is the real
 * guard: it already reserves the walk back to the stairs.
 */
describe("exploration does not switch off when energy dips", () => {
  const dark = ["#############", "#@..........#", "#...........#", "#..........S#", "#############"];
  const fogged = (energy: number) => {
    const g: any = state(dark, {}, { energy });
    g.fogMask = g.mapData.map((row: number[], y: number) => row.map((_: number, x: number) => (x <= 4 ? 2 : 0)));
    return decide(g, undefined, newMemory()).reason;
  };

  it("still explores at 30 energy, where the old gate had already given up", () => {
    expect(fogged(30)).toBe("explore");
  });

  it("falls back to the last-energy path once the reserve is gone", () => {
    // not the ordinary explore goal any more: this is the deliberate spend-what-is-left branch
    expect(fogged(8)).toBe("last-energy explore");
  });
});
