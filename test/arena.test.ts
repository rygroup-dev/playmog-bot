import { describe, it, expect } from "vitest";
import { decide } from "../src/game/policy.js";
import { Board, dangerMap, key } from "../src/game/model.js";

// 9×9 open arena; Jackalot anchor at (4,5) → footprint x3..5, y2..5
function arena(player: [number, number], boss: any = {}, extra: any = {}) {
  const map = Array.from({ length: 9 }, (_, y) => Array.from({ length: 9 }, (_, x) => (x === 0 || y === 0 || x === 8 || y === 8 ? 1 : 0)));
  return { runId: "t", turnNumber: 5, currentFloor: 7, status: "IN_PROGRESS", mapData: map, fogMask: map.map((r) => r.map(() => 2)),
    interactive: [], pickups: [], pendingUpgradeOptions: [], v2CurrentRoomType: "jackalot", v2UpgradeRoomPrompt: null,
    enemies: [{ id: "v2_jackalot", x: 4, y: 5, hp: 120, maxHp: 120, damage: 12, spriteType: "v2_jackalot", v2AttackPhase: "idle", ...boss }],
    player: { x: player[0], y: player[1], energy: 60, maxEnergy: 100, attackPower: 14, level: 6, talents: [], items: { slots: [] }, treasure: 300, pendingTalentRolls: [] }, ...extra };
}

describe("bounty arena (Sir Jackalot 3×4 footprint)", () => {
  it("footprint tiles block and belong to the boss", () => {
    const b = new Board(arena([1, 1]));
    for (const [x, y] of [[3, 2], [5, 2], [3, 5], [5, 5], [4, 3]]) expect(b.enemyAt.get(key(x, y))?.id).toBe("v2_jackalot");
    expect(b.enemyAt.has(key(6, 3))).toBe(false);
  });
  it("attacks the boss from beside any body tile", () => {
    const d = decide(arena([6, 3])); // right of footprint column x=5
    expect(d.action).toMatchObject({ type: "attack", direction: "left", targetEnemyId: "v2_jackalot" });
  });
  it("a downward strike covers all 3 lanes below the body until the wall", () => {
    const D = dangerMap(new Board(arena([1, 1], { v2AttackPhase: "preattack", v2AttackDir: "down" })));
    for (const x of [3, 4, 5]) { expect(D.has(key(x, 6))).toBe(true); expect(D.has(key(x, 7))).toBe(true); }
    expect(D.has(key(2, 6))).toBe(false);
  });
  it("steps out of the strike lane when one step is enough (moving is free in the arena)", () => {
    const d = decide(arena([5, 6], { v2AttackPhase: "preattack", v2AttackDir: "down" })); // edge lane → (6,6) is safe
    expect(d.action).toMatchObject({ type: "move", direction: "right", targetX: 6 });
  });
  it("in the middle lane no single step escapes, so it keeps hitting instead of wasting the turn", () => {
    const d = decide(arena([4, 6], { v2AttackPhase: "preattack", v2AttackDir: "down" }));
    expect(d.action).toMatchObject({ type: "attack", targetEnemyId: "v2_jackalot" });
  });
  it("leaves the slam ring around the body", () => {
    const D = dangerMap(new Board(arena([1, 1], { v2AttackPhase: "leap_slam" })));
    expect(D.has(key(2, 3))).toBe(true); expect(D.has(key(6, 6))).toBe(true); expect(D.has(key(1, 1))).toBe(false);
    const d = decide(arena([6, 4], { v2AttackPhase: "leap_slam" }));
    expect(d.action).toMatchObject({ type: "move", direction: "right" });
  });
  it("treats the arena gate as a wall", () => {
    const g = arena([1, 1], {}, { interactive: [{ id: "gate_1", type: "gate", x: 2, y: 1, v2IsGate: true }] });
    expect(new Board(g).walkable(2, 1)).toBe(false);
  });
});
