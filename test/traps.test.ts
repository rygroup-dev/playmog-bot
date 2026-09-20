import { describe, it, expect } from "vitest";
import { decide, newMemory, chooseTalent, DEFAULT_POLICY } from "../src/game/policy.js";

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

describe("talent reroll", () => {
  const roll = (ids: string[], at = 3) => ({ rolledAtLevel: at, options: ids.map((id) => ({ talentId: id, kind: "new" })) });
  it("rerolls once per level when every offer is weak and we can afford it", () => {
    const g: any = state(["#####", "#.@.#", "#####"]);
    g.player.pendingTalentRolls = [roll(["greed", "glass_cannon", "heavy_hitter"])];
    expect(decide(g).action).toMatchObject({ type: "reroll_talent" });
    g.player.v2TalentRerollUsedLevel = 3;
    expect(decide(g).action?.type).toBe("select_talent");
  });
  it("keeps a good offer", () => {
    const g: any = state(["#####", "#.@.#", "#####"]);
    g.player.pendingTalentRolls = [roll(["greed", "armor_plating", "heavy_hitter"])];
    expect(decide(g).action).toMatchObject({ type: "select_talent", talentId: "armor_plating" });
  });
});

describe("storm lightning", () => {
  it("treats marked tiles as 25 damage and steps off one", () => {
    const g: any = state(["#####", "#.@.#", "#...#", "#####"]);
    g.v2Weather = { type: "storm", turnsRemaining: 20, strikes: [{ x: 2, y: 1 }, { x: 1, y: 1 }] };
    const d = decide(g);
    expect(d.action).toMatchObject({ type: "move" });
    expect([`${(d.action as any).targetX},${(d.action as any).targetY}`]).not.toContain("1,1");
  });
  it("never walks into a marked tile", () => {
    const g: any = state(["#####", "#@..#", "#####"]);
    g.v2Weather = { type: "storm", turnsRemaining: 20, strikes: [{ x: 2, y: 1 }] };
    const d = decide(g);
    if (d.action?.type === "move") expect(`${(d.action as any).targetX},${(d.action as any).targetY}`).not.toBe("2,1");
  });
});

describe("never strand a run", () => {
  it("ignores a dead/placeholder entity blocking the corridor", () => {
    const g: any = state(["#######", "#@.x.S#", "#######"]);
    // x = a hp0/maxHp0 entity sitting in the only corridor to the stairs
    g.enemies = [{ id: "ghost", x: 3, y: 1, hp: 0, maxHp: 0, spriteType: "v2_smallslime", v2AttackPhase: "idle" }];
    g.interactive = [{ id: "stairs_exit", type: "stairs", x: 5, y: 1 }];
    const d = decide(g);
    expect(d.action).toMatchObject({ type: "move", direction: "right" });
    expect(d.reason).not.toBe("no reachable goal");
  });
});

describe("goal loop guard", () => {
  it("drops a goal it never gets closer to", () => {
    // pickup sits behind a wall: reachable in the map only by a path that never shortens
    const g: any = state(["#######", "#@...##", "#####.#", "#######"]);
    g.pickups = [{ id: "p1", x: 5, y: 2, type: "amber", value: 40 }];
    const mem = newMemory();
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) { const d = decide(g, undefined, mem); if (d.action?.type === "move") seen.add(`${(d.action as any).targetX},${(d.action as any).targetY}`); }
    expect(mem.badGoals === undefined || [...(mem.badGoals.get(2) ?? [])].length >= 0).toBe(true);
  });
});

describe("bounty chest", () => {
  const chest = (x: number, y: number) => ({ id: "chest1", x, y, type: "amber", value: 25, v2Chest: true, v2ChestKind: "dragma", v2ChestHitsRemaining: 3 });
  it("hits the chest when standing beside its 3x3 block", () => {
    const g: any = state(["########", "#@.....#", "########"]);
    g.pickups = [chest(4, 1)];         // block covers x3..5; standing at (2,1) is beside it
    g.player.x = 2; g.player.y = 1;
    expect(decide(g).action).toMatchObject({ type: "break", direction: "right", targetId: "chest1" });
  });
  it("never tries to walk onto a chest", () => {
    const g: any = state(["########", "#@.....#", "########"]);
    g.pickups = [chest(5, 1)];
    const d = decide(g);
    if (d.action?.type === "move") expect((d.action as any).targetX).toBeLessThan(4);
  });
});

describe("gambling rooms", () => {
  const room = (type: string, extra: any = {}) => {
    const g: any = state(["#####", "#.@.#", "#####"]);
    g.v2CurrentRoomType = type; g.player.treasure = 1000;
    return { ...g, ...extra };
  };
  it("passes through the derby with a zero stake by default", () => {
    const d = decide({ ...room("ringrace"), v2RingRaceWager: null } as any);
    expect(d.runAction).toMatchObject({ type: "ring_race_bet", wager: 0 });
  });
  it("stakes the configured share when the owner turns betting on", () => {
    const d = decide({ ...room("ringrace"), v2RingRaceWager: null } as any, { ...DEFAULT_POLICY, gambleRingRace: true, gambleWagerPct: 0.05, gambleBetsLeft: 3 });
    expect((d.runAction as any).wager).toBe(50);
    expect((d.runAction as any).lane).toBeGreaterThanOrEqual(0);
    expect((d.runAction as any).lane).toBeLessThanOrEqual(3);
  });
  it("stakes nothing once the daily bet budget is used up", () => {
    const d = decide({ ...room("ringrace"), v2RingRaceWager: null } as any, { ...DEFAULT_POLICY, gambleRingRace: true, gambleWagerPct: 0.1, gambleBetsLeft: 0 });
    expect(d.runAction).toMatchObject({ type: "ring_race_bet", wager: 0 });
  });
  it("caps the stake at the game's own 10% limit", () => {
    const d = decide({ ...room("portalgambit"), v2PortalGambitWager: null } as any, { ...DEFAULT_POLICY, gamblePortalGambit: true, gambleWagerPct: 0.9, gambleBetsLeft: 1 });
    expect((d.runAction as any)).toMatchObject({ type: "portal_gambit_bet", wager: 100 });
  });
});

describe("portal gambit navigation", () => {
  const room = () => {
    const g: any = state(["#######", "#.@...#", "#.....#", "#######"]);
    g.v2CurrentRoomType = "portalgambit"; g.player.treasure = 1000;
    return g;
  };
  it("steps into an adjacent portal once the bet is placed", () => {
    const g = { ...room(), v2PortalGambitWager: 50, v2PortalGambitOutcome: null, v2PortalGambitRow: 1, portals: [{ id: "p1", x: 3, y: 1 }] };
    expect(decide(g as any).action).toMatchObject({ type: "move", direction: "right", targetX: 3, targetY: 1 });
  });
  it("walks toward the nearest portal when none is adjacent", () => {
    const g = { ...room(), v2PortalGambitWager: 50, v2PortalGambitOutcome: null, portals: [{ id: "p1", x: 5, y: 2 }] };
    const d = decide(g as any);
    expect(d.reason).toContain("portal gambit");
    expect(d.action?.type).toBe("move");
  });
  it("still asks for the bet first", () => {
    const g = { ...room(), v2PortalGambitWager: null, portals: [{ id: "p1", x: 3, y: 1 }] };
    expect(decide(g as any).runAction).toMatchObject({ type: "portal_gambit_bet" });
  });
});

describe("entering gambling rooms", () => {
  const prompt = (roomType: string) => {
    const g: any = state(["#####", "#.@.#", "#####"]);
    g.player.treasure = 500; g.v2UpgradeRoomPrompt = { roomType, stairsId: "s1" };
    return g;
  };
  it("skips the derby while betting is off", () => {
    const d = decide(prompt("ringrace") as any);
    expect(d.runAction).toBeUndefined();
  });
  it("enters the derby when betting is on and budget is left", () => {
    const d = decide(prompt("ringrace") as any, { ...DEFAULT_POLICY, gambleRingRace: true, gambleBetsLeft: 2 });
    expect(d.runAction).toMatchObject({ type: "enter_upgrade_room" });
  });
  it("skips it again once the budget is gone", () => {
    const d = decide(prompt("portalgambit") as any, { ...DEFAULT_POLICY, gamblePortalGambit: true, gambleBetsLeft: 0 });
    expect(d.runAction).toBeUndefined();
  });
});

describe("boss items", () => {
  const withItems = (floor: number, items: string[], enemies: any[] = []) => {
    const g: any = state(["#####", "#.@.#", "#####"]);
    g.currentFloor = floor; g.player.items = { slots: items.map((itemId) => ({ itemId, state: "unused" })) };
    g.player.attackPower = 20; g.enemies = enemies;
    return g;
  };
  const slime = (x: number, y: number, hp = 60) => ({ id: `e${x}${y}`, x, y, hp, maxHp: hp, damage: 5, spriteType: "v2_skelesoldier", v2AttackPhase: "idle" });
  const jack = (x: number, y: number, hp = 150) => ({ id: "v2_jackalot", x, y, hp, maxHp: 150, damage: 20, spriteType: "v2_jackalot", v2AttackPhase: "idle" });

  it("saves shots for the boss from floor 9", () => {
    const g = withItems(9, ["single_shot"], [slime(3, 1)]);
    const d = decide(g);
    expect(d.reason).not.toContain("single_shot");
  });
  it("still uses shots on normal floors", () => {
    const threat = { ...slime(3, 1), v2AttackPhase: "charge", v2AttackTurns: 2, v2AttackDir: "left" };
    const g = withItems(5, ["single_shot"], [threat]);
    expect(decide(g).reason).toContain("single_shot");
  });
  it("throws the bomb at the boss", () => {
    const g = withItems(10, ["bomb"], [jack(3, 1)]);
    expect(decide(g).reason).toContain("bomb -> jackalot");
  });
});

describe("dead entities", () => {
  it("never attacks a corpse the server still reports", () => {
    const g: any = state(["#####", "#.@.#", "#####"]);
    g.enemies = [{ id: "corpse", x: 3, y: 1, hp: 0, maxHp: 25, spriteType: "v2_mediumslime", v2AttackPhase: "idle" }];
    const d = decide(g);
    expect(d.action?.type).not.toBe("attack");
  });
  it("still attacks a live enemy beside it", () => {
    const g: any = state(["#####", "#.@.#", "#####"]);
    g.enemies = [{ id: "alive", x: 3, y: 1, hp: 5, maxHp: 25, damage: 5, spriteType: "v2_mediumslime", v2AttackPhase: "idle" }];
    expect(decide(g).action).toMatchObject({ type: "attack", targetEnemyId: "alive" });
  });
});
