import pino from "pino";
import { env, ownerIdsFromEnv } from "./config.js";
import { Store } from "./db.js";
import { loadAccount } from "./util/wallet.js";
import { MogApi } from "./mog/api.js";
import { AbstractOps } from "./chain/abstract.js";
import { Autopilot } from "./services/autopilot.js";
import { ClaimsService } from "./services/claims.js";
import { MarketMaker } from "./services/market.js";
import { createBot } from "./telegram/bot.js";

const logger = pino({ level: env.LOG_LEVEL, redact: ["privateKey", "token", "*.privateKey"] });
const log = (m: string) => logger.info(m);

const store = new Store(env.DB_PATH);
const account = loadAccount(env.WALLET_PATH);
const api = new MogApi(account, { log });
const abs = new AbstractOps(account, log);

let notify: (t: string, level?: string) => Promise<void> = async () => {};
const claims = new ClaimsService(api, abs, account, log);
const market = new MarketMaker(api, store, (t) => notify(t), log);
const autopilot = new Autopilot(api, abs, store, (t, l) => notify(t, l), log, claims, market);
const tg = createBot({ token: env.TELEGRAM_BOT_TOKEN, store, api, abs, account, autopilot, claims, market, envOwners: ownerIdsFromEnv, log });
notify = async (t) => { await tg.notifyAll(t); };

tg.ensureClaimCode();
await tg.setupProfile().catch((e) => log(`setupProfile: ${e.message}`));
void tg.bot.start({ drop_pending_updates: true, onStart: (i) => log(`telegram @${i.username} online`) });
autopilot.start(60_000);
log(`playmog-bot started, wallet ${account.address}`);

const shutdown = async (sig: string) => {
  log(`${sig}: stopping (current run left open; it resumes on next start)`);
  autopilot.stop();
  await tg.bot.stop().catch(() => {});
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (e: any) => { logger.error({ err: String(e?.message ?? e) }, "unhandledRejection"); store.event("error", `unhandledRejection: ${e?.message ?? e}`); });
