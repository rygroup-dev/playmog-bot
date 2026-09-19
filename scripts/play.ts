// Manual run helper: plays (or creates with --create) one run in the foreground, printing every turn.
//   npx tsx scripts/play.ts EXPEDITION [maxTurns] [--create]
import { loadAccount } from "../src/util/wallet.js";
import { MogApi } from "../src/mog/api.js";
import { playRun, type RunType } from "../src/game/runner.js";

const RT = (process.argv[2] ?? "EXPEDITION") as RunType;
const MAXTURNS = Number(process.argv[3] ?? 1e9);
const api = new MogApi(loadAccount(), { log: console.log });
let a = await api.get(`/api/runs/active?runType=${RT}&includeState=1`);
if (!a.activeRun && process.argv.includes("--create")) {
  const c = await api.post("/api/runs/create", { keysAmount: 1, runType: RT });
  console.log("created run", c.runId); a = { activeRun: { id: c.runId } };
}
if (!a.activeRun) { console.log("no active run (use --create to start one)"); process.exit(1); }
let n = 0;
const s = await playRun(api, a.activeRun.id, RT, {
  log: (m) => console.log(m), shouldStop: () => n >= MAXTURNS,
  onTurn: ({ turn, reason, g, events }) => { n++; const p = g.player;
    console.log(`t${turn} f${g.currentFloor} @${p.x},${p.y} E${p.energy} T${p.treasure} M${p.marbles} L${p.level} | ${reason} | ${events.map((e: any) => e.type).join(",")}`); },
});
console.log("SUMMARY", JSON.stringify(s));
process.exit(0);
