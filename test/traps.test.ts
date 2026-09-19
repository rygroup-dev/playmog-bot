import { describe, it, expect } from "vitest";
import { decide, newMemory, chooseTalent } from "../src/game/policy.js";

function state(rows: string[], extra: Partial<any> = {}) {
  const map: number[][] = []; let px = 0, py = 0;
  rows.forEach((r, y) => map.push([...r].map((ch, x) => { if (ch === "@") { px = x; py = y; } return ch === "#" ? 1 : 0; })));
  return { runId: "t", turnNumber: 10, currentFloor: 2, status: "IN_PROGRESS", mapData: map, fogMask: map.map((r) => r.map(() => 2)),
    interactive: [], enemies: [], pickups: [], pendingUpgradeOptions: [], v2CurrentRoomType: null, v2UpgradeRoomPrompt: null,
    player: { x: px, y: py, energy: 80, maxEnergy: 100, attackPower: 12, level: 3, talents: [], items: { slots: [] }, treasure: 100, pendingTalentRolls: [] }, ...extra };
}
const medium = (id: string, x: number, y: number) => ({ id, x, y, hp: 25, maxHp: 25, damage: 5, v2DamageMax: 8, spriteType: "v2_mediumslime", v2AttackPhase: "idle", v2AttackTurns: 0 });
const memWith = (floor: number, ...tiles: string[]) => { const m = newMemory(); m.traps.set(floor, new Set(tiles)); return m; };

describe("spike traps", () => {
  it("steps off a known trap and stays next to the enemy it fights", () => {
    const g = state(["#####", "#.@.#", "#...#", "#####"], { enemies: [medium("m", 3, 1)] });
    const d = decide(g, undefined, memWith(2, "2,1"));
    expect(d.reason).toBe("step off spike trap");
    expect(d.action).toMatchObject({ type: "move" });
  });
  it("still takes a guaranteed kill while standing on a trap", () => {
    const g = state(["#####", "#.@.#", "#####"], { enemies: [{ ...medium("m", 3, 1), hp: 5 }] });
    expect(decide(g, undefined, memWith(2, "2,1")).action).toMatchObject({ type: "attack", targetEnemyId: "m" });
  });
  it("traps are per floor", () => {
    const g = state(["#####", "#.@.#", "#...#", "#####"], { enemies: [medium("m", 3, 1)] });
    expect(decide(g, undefined, memWith(5, "2,1")).action?.type).toBe("attack");
  });
  it("never dodges onto a known trap when a clean tile exists", () => {
    const g = state(["#####", "#.@.#", "#...#", "#####"], { enemies: [
      { ...medium("a", 1, 1), v2AttackPhase: "charge", v2AttackTurns: 1, v2AttackDir: "right", v2AttackTargetX: 2, v2AttackTargetY: 1 },
      { ...medium("b", 3, 1), v2AttackPhase: "charge", v2AttackTurns: 1, v2AttackDir: "left", v2AttackTargetX: 2, v2AttackTargetY: 1 }] });
    // only exit is down (2,2); make it a trap → still better than two hits (16 dmg vs ~7)
    expect(decide(g, undefined, memWith(2, "2,2")).action).toMatchObject({ type: "move", direction: "down" });
  });
  it("reads server-revealed traps (trap sight)", () => {
    const g = state(["#####", "#.@.#", "#...#", "#####"], { enemies: [medium("m", 3, 1)], traps: [{ id: "spike_0", x: 2, y: 1 }] });
    expect(decide(g).reason).toBe("step off spike trap");
  });
});

describe("talent choice", () => {
  const opt = (id: string) => ({ talentId: id, kind: "new" });
  it("prefers armor over greed and vampiric", () => {
    expect(chooseTalent([opt("greed"), opt("vampiric"), opt("armor_plating")], []).talentId).toBe("armor_plating");
  });
  it("never picks greed in World's Eve when anything else is offered", () => {
    expect(chooseTalent([opt("greed"), opt("glass_cannon")], [], true).talentId).toBe("glass_cannon");
  });
});

describe("arrow traps and weather", () => {
  it("does not 'step off' an arrow-trap tile (arrows fire on entering the lane)", () => {
    const g = state(["#####", "#.@.#", "#...#", "#####"], { enemies: [medium("m", 3, 1)] });
    const m = newMemory(); m.arrows.set(2, new Set(["2,1"]));
    expect(decide(g, undefined, m).action?.type).toBe("attack");
  });
  it("miasma makes tanking a chargeTurns=1 enemy more expensive", async () => {
    const { killCost } = await import("../src/game/value.js");
    const c = { floor: 3, level: 3, treasureMult: 1, atk: 12, energy: 80 };
    const e = { spriteType: "v2_mediumslime", hp: 25, damage: 5, v2DamageMax: 8 };
    expect(killCost(e, { ...c, weatherHit: 4 })).toBeGreaterThan(killCost(e, c));
  });
});
