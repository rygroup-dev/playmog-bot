import { describe, expect, it } from "vitest";
import { diffEnemies, parseEnemyConfigs } from "../src/services/watch.js";

const js = `e=>{"use strict";let r={v2_smallslime:{spriteType:"v2_smallslime",hp:15,damage:3,damageMax:5,attackRange:1,chargeTurns:2,restTurns:1,randomMove:!0},v2_bat:{spriteType:"v2_bat",hp:30,damage:7,damageMax:10,attackRange:4,chargeTurns:1,restTurns:1,randomMove:!1,attackKind:"dash"}};e.s(["V2_ENEMY_CONFIGS",0,r])}`;

describe("game watch", () => {
  it("parses the client's enemy table", () => {
    const c = parseEnemyConfigs(js);
    expect(Object.keys(c)).toEqual(["v2_smallslime", "v2_bat"]);
    expect(c.v2_bat).toMatchObject({ hp: 30, chargeTurns: 1, randomMove: false, attackKind: "dash" });
    expect(c.v2_smallslime.randomMove).toBe(true);
  });
  it("reports changed, added and removed enemies", () => {
    const old = parseEnemyConfigs(js);
    const next = { ...old, v2_bat: { ...old.v2_bat, hp: 35 }, v2_new: { spriteType: "v2_new", hp: 1 } } as any;
    delete next.v2_smallslime;
    const d = diffEnemies(old, next);
    expect(d).toContain("✏️ v2_bat: hp 30→35");
    expect(d).toContain("➕ v2_new (musuh baru)");
    expect(d).toContain("➖ v2_smallslime (dihapus)");
    expect(diffEnemies(old, old)).toEqual([]);
  });
});
