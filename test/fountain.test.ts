import { describe, it, expect } from "vitest";
import { decide, newMemory } from "../src/game/policy.js";

/**
 * The per-floor snapshots turned up two object types the policy had never touched, on a run that reached
 * floor 10: {"id":"fountain_0","type":"fountain","used":false} on six of nine floors, and
 * {"id":"chest_4","type":"chest","state":"closed"}. Both carry a state flag, so both are meant to be used.
 * Nothing in the client bundle or any capture we hold says how, so the bot tries the shrine's interaction
 * and the server's answer lands in the run log.
 */
function state(rows: string[], interactiveExtra: any[] = [], player: Partial<any> = {}) {
  const map: number[][] = [], interactive: any[] = [...interactiveExtra]; let px = 0, py = 0;
  rows.forEach((r, y) => { map.push([...r].map((ch, x) => {
    if (ch === "@") { px = x; py = y; }
    if (ch === "S") interactive.push({ id: "stairs_exit", type: "stairs", x, y });
    return ch === "#" ? 1 : 0; })); });
  return { runId: "t", turnNumber: 10, currentFloor: 3, status: "IN_PROGRESS", mapData: map, fogMask: map.map((r) => r.map(() => 2)),
    tileData: map, wallTileData: map, interactive, enemies: [], pickups: [], pendingUpgradeOptions: [],
    v2CurrentRoomType: null, v2UpgradeRoomPrompt: null,
    player: { x: px, y: py, energy: 50, maxEnergy: 100, attackPower: 12, level: 3, talents: [], items: { slots: [] },
      treasure: 100, pendingTalentRolls: [], ...player } };
}
const room = ["##########", "#@.......#", "#........#", "#.......S#", "##########"];
const fountain = (x: number, y: number, used = false) => ({ id: "fountain_0", type: "fountain", x, y, used });
const chest = (x: number, y: number, st = "closed") => ({ id: "chest_4", type: "chest", x, y, state: st });

describe("fountains and chests", () => {
  it("tries the fountain when standing next to an unused one", () => {
    const d = decide(state(room, [fountain(2, 1)]) as any);
    expect(d.action).toMatchObject({ type: "break", targetId: "fountain_0" });
  });

  it("leaves a fountain alone once it has been used", () => {
    expect(decide(state(room, [fountain(2, 1, true)]) as any).reason).not.toContain("fountain");
  });

  it("tries a closed chest it is standing next to", () => {
    const d = decide(state(room, [chest(2, 1)]) as any);
    expect(d.action).toMatchObject({ type: "break", targetId: "chest_4" });
  });

  it("walks to a fountain while short of energy", () => {
    expect(decide(state(room, [fountain(6, 2)]) as any).reason).toContain("fountain");
  });

  it("does not detour to one on full energy", () => {
    expect(decide(state(room, [fountain(6, 2)], { energy: 100 }) as any).reason).not.toContain("fountain");
  });

  it("stops trying once the server has refused it", () => {
    const mem = newMemory(); mem.blacklist.set("fountain_0", 99);
    expect(decide(state(room, [fountain(2, 1)]) as any, undefined, mem).reason).not.toContain("fountain");
  });
});
