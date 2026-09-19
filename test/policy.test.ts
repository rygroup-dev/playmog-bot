import { describe, it, expect } from "vitest";
import { decide, newMemory, chooseTalent, shrineCost } from "../src/game/policy.js";
import { killCost, killValue, energyPerXp } from "../src/game/value.js";

/** Build a minimal gameState: '#' wall, '.' floor, '@' player, 'S' stairs_exit, 'p' pot. */
function state(rows: string[], extra: Partial<any> = {}, player: Partial<any> = {}) {
  const map: number[][] = [], interactive: any[] = []; let px = 0, py = 0;
  rows.forEach((r, y) => { map.push([...r].map((ch, x) => {
    if (ch === "@") { px = x; py = y; } if (ch === "S") interactive.push({ id: "stairs_exit", type: "stairs", x, y });
    if (ch === "p") interactive.push({ id: `pot_${x}_${y}`, type: "pot", x, y });
    return ch === "#" ? 1 : 0; })); });
  return { runId: "t", turnNumber: 10, currentFloor: 2, status: "IN_PROGRESS", mapData: map, fogMask: map.map((r) => r.map(() => 2)),
    tileData: map, wallTileData: map, interactive, enemies: [], pickups: [], pendingUpgradeOptions: [], v2CurrentRoomType: null, v2UpgradeRoomPrompt: null,
    player: { x: px, y: py, energy: 80, maxEnergy: 100, attackPower: 12, level: 3, talents: [], items: { slots: [] }, treasure: 100, pendingTalentRolls: [], ...player }, ...extra };
}
const slime = (id: string, x: number, y: number, o: any = {}) => ({ id, x, y, hp: 15, maxHp: 15, damage: 3, v2DamageMax: 5, spriteType: "v2_smallslime", v2AttackPhase: "idle", v2AttackTurns: 0, ...o });
const medium = (id: string, x: number, y: number, o: any = {}) => ({ id, x, y, hp: 25, maxHp: 25, damage: 5, v2DamageMax: 8, spriteType: "v2_mediumslime", v2AttackPhase: "idle", v2AttackTurns: 0, ...o });

describe("combat micro (server-verified rules)", () => {
  it("kills an adjacent enemy that dies to one hit", () => {
    const g = state(["#####", "#@..#", "#####"], { enemies: [slime("e1", 2, 1, { hp: 5 })] });
    expect(decide(g).action).toMatchObject({ type: "attack", direction: "right", targetEnemyId: "e1" });
  });
  it("fights through a chargeTurns=1 enemy instead of dodge-looping", () => {
    const g = state(["#####", "#.@.#", "#...#", "#####"], { enemies: [medium("m", 3, 1, { v2AttackPhase: "charge", v2AttackTurns: 1, v2AttackDir: "left", v2AttackTargetX: 2, v2AttackTargetY: 1 })] });
    expect(decide(g).action).toMatchObject({ type: "attack", targetEnemyId: "m" });
  });
  it("dodges when two attackers fire on our tile together", () => {
    const g = state(["#####", "#.@.#", "#...#", "#####"], { enemies: [
      medium("a", 1, 1, { v2AttackPhase: "charge", v2AttackTurns: 1, v2AttackDir: "right", v2AttackTargetX: 2, v2AttackTargetY: 1 }),
      medium("b", 3, 1, { v2AttackPhase: "charge", v2AttackTurns: 1, v2AttackDir: "left", v2AttackTargetX: 2, v2AttackTargetY: 1 })] });
    expect(decide(g).action).toMatchObject({ type: "move", direction: "down" });
  });
  it("does not attack a spawner shielded by live spawn, hunts the spawn", () => {
    const g = state(["######", "#@...#", "#....#", "######"], { enemies: [
      { id: "v2_enemy_1_2_1", x: 2, y: 1, hp: 80, maxHp: 80, damage: 0, spriteType: "v2_frogspawn", v2AttackPhase: "charge", v2AttackTurns: 4 },
      { id: "v2_spawned_frogglet_1", x: 4, y: 2, hp: 2, maxHp: 40, damage: 8, v2DamageMax: 12, spriteType: "v2_frogglet", v2AttackPhase: "idle", v2AttackTurns: 0 }] });
    const d = decide(g);
    expect(d.action?.type).not.toBe("attack");
    expect(d.reason).toContain("frogglet");
  });
  it("respects the runner blacklist", () => {
    const mem = newMemory(); mem.blacklist.set("e1", 99);
    const g = state(["#####", "#@..#", "#####"], { enemies: [slime("e1", 2, 1)] });
    expect(decide(g, undefined, mem).action?.type).not.toBe("attack");
  });
});

describe("flow", () => {
  it("answers a pending talent roll before anything else", () => {
    const g = state(["###", "#@#", "###"], {}, { pendingTalentRolls: [{ options: [{ kind: "new", talentId: "glass_cannon" }, { kind: "new", talentId: "swift_steps" }] }] });
    expect(decide(g).action).toEqual({ type: "select_talent", talentId: "swift_steps" });
  });
  it("confirms a default descend prompt", () => {
    const g = state(["###", "#@#", "###"], { v2UpgradeRoomPrompt: { stairsId: "stairs_exit", roomType: null } });
    expect(decide(g).runAction).toEqual({ type: "enter_upgrade_room" });
  });
  it("declines a gambling room", () => {
    const g = state(["###", "#@#", "###"], { v2UpgradeRoomPrompt: { stairsId: "x", roomType: "portalgambit" } });
    expect(decide(g).runAction).toBeUndefined();
  });
  it("walks to the stairs when the floor has nothing left", () => {
    const g = state(["#######", "#@...S#", "#######"]);
    expect(decide(g).action).toMatchObject({ type: "move", direction: "right" });
  });
  it("breaks an adjacent pot", () => {
    const g = state(["#####", "#@p.#", "#####"]);
    expect(decide(g).action).toMatchObject({ type: "break", direction: "right" });
  });
  it("skips a pickup that despawns before we can reach it", () => {
    const g = state(["##########", "#@......S#", "##########"], { pickups: [{ id: "t", type: "treasure", value: 40, x: 7, y: 1, v2TurnsUntilDespawn: 2 }] });
    expect(decide(g).reason).not.toContain("pickup");
  });
});

describe("value model", () => {
  it("small slime at ATK 12 dies before it fires (0 cost)", () => { expect(killCost(slime("s", 0, 0), { floor: 2, level: 2, treasureMult: 1, atk: 12, energy: 80 })).toBe(0); });
  it("medium slime costs one hit of damage", () => { expect(killCost(medium("m", 0, 0), { floor: 2, level: 2, treasureMult: 1, atk: 12, energy: 80 })).toBeCloseTo(6.5); });
  it("a kill is worth a few energy-equivalents", () => { const v = killValue(slime("s", 0, 0), { floor: 2, level: 2, treasureMult: 1, atk: 12, energy: 80 }); expect(v).toBeGreaterThan(4); expect(v).toBeLessThan(12); });
  it("xp stops paying at level cap", () => { expect(energyPerXp(15)).toBe(0); expect(energyPerXp(1)).toBeGreaterThan(0.1); });
  it("shrine prices follow the client sequence", () => { expect([0, 1, 2, 3, 4, 5].map(shrineCost)).toEqual([10, 20, 30, 50, 80, 130]); });
  it("talent priority avoids glass cannon", () => { expect(chooseTalent([{ talentId: "glass_cannon" }, { talentId: "renewal" }], []).talentId).toBe("renewal"); });
});
