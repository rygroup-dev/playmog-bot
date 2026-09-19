// Dry run of GameWatch.scanClient against the live site: prints version + enemy-rule diff vs the bundled table.
import { GameWatch, diffEnemies } from "../src/services/watch.js";
import enemies from "../src/game/enemies.json" with { type: "json" };
const fake: any = { get: (_k: string, d: unknown) => d, set: () => {}, event: () => {} };
const c = await new GameWatch(fake, () => {}, console.log).scanClient();
console.log({ appVersion: c.appVersion, rulesHash: c.rulesHash, chunks: c.chunkCount, enemies: Object.keys(c.enemies ?? {}).length });
console.log(diffEnemies(enemies as any, c.enemies ?? {}));
