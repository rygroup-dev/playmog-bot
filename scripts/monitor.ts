// 60-minute production monitor: samples every 2 min, writes data/monitor/*.jsonl and a final report.
import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { env } from "../src/config.js";
import { loadAccount } from "../src/util/wallet.js";
import { MogApi } from "../src/mog/api.js";
import { AbstractOps } from "../src/chain/abstract.js";

const DURATION_MS = Number(process.env.MON_MINUTES ?? 60) * 60_000;
const EVERY_MS = 120_000;
const t0 = Date.now();
const since = new Date(t0).toISOString().replace("T", " ").slice(0, 19);
mkdirSync("data/monitor", { recursive: true });
const file = `data/monitor/${t0}.jsonl`;
const acct = loadAccount(); const api = new MogApi(acct); const abs = new AbstractOps(acct);
const db = new Database(env.DB_PATH, { readonly: true });
const sh = (c: string) => { try { return execSync(c, { encoding: "utf8", timeout: 20_000 }).trim(); } catch (e: any) { return `ERR ${e.message.slice(0, 120)}`; } };

const samples: any[] = [];
const runFileSize = new Map<string, number>();
let stuckFlags: string[] = [];

async function sample() {
  const s: any = { at: new Date().toISOString() };
  s.service = sh("systemctl is-active playmog-bot");
  s.restarts = Number(sh("systemctl show -p NRestarts --value playmog-bot")) || 0;
  const pid = sh("systemctl show -p MainPID --value playmog-bot");
  s.rssMb = Number(sh(`ps -o rss= -p ${pid} 2>/dev/null || echo 0`)) / 1024;
  const log = sh(`journalctl -u playmog-bot --since "${since}" --no-pager -o cat | grep -v "room msg"`);
  const count = (re: RegExp) => log.split("\n").filter((l) => re.test(l)).length;
  s.log = { tickErr: count(/tick error/), turnErr: count(/turn error/), tgErr: count(/telegram error/), unhandled: count(/unhandledRejection/),
    watchdog: count(/watchdog/), blacklist: count(/blacklist /), stuck: count(/stuck/), connectFail: count(/room connect failed/), started: count(/playmog-bot started/) };
  s.dbEvents = db.prepare("SELECT level, COUNT(*) n FROM events WHERE ts >= ? GROUP BY level").all(t0);
  s.dbErrors = db.prepare("SELECT msg FROM events WHERE ts >= ? AND level IN ('error','warn') ORDER BY id DESC LIMIT 5").all(t0);
  s.runsDone = db.prepare("SELECT run_type, floor, treasure, marbles, arcade_keys, kills, end_reason FROM runs WHERE ended_at >= ? ORDER BY ended_at").all(t0);
  try {
    const [status, exp, pass, valor, act] = await Promise.all([
      api.get("/api/status"), api.get("/api/items/expedition-keys"), api.get("/api/shop/pass"), api.get("/api/shop/valor/balance"),
      api.get("/api/runs/active?runType=EXPEDITION")]);
    s.game = { paused: status.paused, expKeys: exp.balance, pass: pass.isActive ? pass.tier : null, daily: `${pass.dailyClaimedToday}/${pass.dailyClaimedToday + pass.dailyClaimable}`,
      valor: valor.valorBalance, activeRun: act.activeRun ? { id: act.activeRun.id, floor: act.activeRun.currentFloor, energy: act.activeRun.playerEnergy } : null };
  } catch (e: any) { s.game = { error: e.message }; }
  try { const b = await abs.balances(); s.wallet = { eth: b.ethFmt, usdc: b.usdcFmt }; } catch (e: any) { s.wallet = { error: e.message }; }
  try { const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`); s.telegram = (await r.json()).ok ? "ok" : "fail"; } catch { s.telegram = "fail"; }
  // stuck detection: active run whose jsonl stopped growing for 2 samples (4 min)
  if (s.game?.activeRun) {
    const f = `data/runs/${s.game.activeRun.id}.jsonl`;
    let size = 0; try { size = statSync(f).size; } catch {}
    const prev = runFileSize.get(f);
    s.runLogBytes = size;
    s.runGrowing = prev === undefined ? null : size > prev;
    const prevSample = samples.at(-1);
    if (s.runGrowing === false && prevSample?.runGrowing === false) stuckFlags.push(`${s.at} run ${s.game.activeRun.id} not progressing`);
    runFileSize.set(f, size);
  }
  samples.push(s);
  appendFileSync(file, JSON.stringify(s) + "\n");
  console.log(`[${s.at.slice(11, 19)}] svc=${s.service} rst=${s.restarts} rss=${s.rssMb.toFixed(0)}MB errs=${s.log.tickErr + s.log.turnErr + s.log.tgErr + s.log.unhandled} runs=${s.runsDone.length} exp=${s.game?.expKeys} active=${s.game?.activeRun ? `f${s.game.activeRun.floor} E${s.game.activeRun.energy}` : "-"} tg=${s.telegram}`);
}

while (Date.now() - t0 < DURATION_MS) {
  await sample().catch((e) => console.log("sample failed", e.message));
  await new Promise((r) => setTimeout(r, EVERY_MS));
}
await sample();

const last = samples.at(-1); const first = samples[0];
const L = last.log;
const report = [
  `# Monitoring report — ${new Date(t0).toISOString()} → ${new Date().toISOString()}`,
  `samples: ${samples.length}`,
  `service: ${samples.every((s) => s.service === "active") ? "active the whole time" : "NOT always active: " + samples.filter((s) => s.service !== "active").map((s) => s.at).join(", ")}`,
  `restarts during window: ${last.restarts - first.restarts} · memory ${Math.min(...samples.map((s) => s.rssMb)).toFixed(0)}–${Math.max(...samples.map((s) => s.rssMb)).toFixed(0)} MB`,
  `log: tickErr ${L.tickErr} · turnErr ${L.turnErr} · telegramErr ${L.tgErr} · unhandled ${L.unhandled} · roomConnectFail ${L.connectFail} · watchdog ${L.watchdog} · blacklist ${L.blacklist} · stuck ${L.stuck}`,
  `db events: ${JSON.stringify(last.dbEvents)}`,
  `recent warnings/errors: ${JSON.stringify(last.dbErrors)}`,
  `stuck detector: ${stuckFlags.length ? stuckFlags.join(" | ") : "none"}`,
  `telegram: ${samples.filter((s) => s.telegram !== "ok").length} failed checks`,
  `game: paused=${last.game?.paused} · expKeys ${first.game?.expKeys} → ${last.game?.expKeys} · daily ${last.game?.daily} · pass ${last.game?.pass} · VALOR ${last.game?.valor}`,
  `wallet: ${first.wallet?.eth} ETH / ${first.wallet?.usdc} USDC.e → ${last.wallet?.eth} ETH / ${last.wallet?.usdc} USDC.e`,
  `runs completed: ${last.runsDone.length}`,
  ...last.runsDone.map((r: any) => `  - ${r.run_type} floor ${r.floor} treasure ${r.treasure} marbles ${r.marbles} AK ${r.arcade_keys} kills ${r.kills} (${r.end_reason})`),
].join("\n");
writeFileSync("data/monitor/report.md", report);
console.log("\n" + report);
process.exit(0);
