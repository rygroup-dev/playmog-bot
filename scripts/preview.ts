import { env, ownerIdsFromEnv } from "../src/config.js";
import { Store } from "../src/db.js"; import { loadAccount } from "../src/util/wallet.js"; import { MogApi } from "../src/mog/api.js";
import { AbstractOps } from "../src/chain/abstract.js"; import { Autopilot } from "../src/services/autopilot.js"; import { createBot } from "../src/telegram/bot.js"; import { ClaimsService } from "../src/services/claims.js"; import { MarketMaker } from "../src/services/market.js";
const store = new Store(env.DB_PATH); const acct = loadAccount(); const api = new MogApi(acct); const abs = new AbstractOps(acct);
const ap = new Autopilot(api, abs, store, () => {}, () => {});
const tg = createBot({ token: env.TELEGRAM_BOT_TOKEN, store, api, abs, account: acct, autopilot: ap, claims: new ClaimsService(api, abs, acct), market: new MarketMaker(api, store, () => {}, () => {}), envOwners: ownerIdsFromEnv, log: () => {} });
const strip = (t: string) => t.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
for (const name of (process.argv[2] ?? "menu,dash,run,wallet,keys,claims,hist,lb,set,help").split(",")) {
  const v = await (tg.views as any)[name]();
  const t = strip(v.text); const maxLine = Math.max(...t.split("\n").map((l) => [...l].length));
  console.log(`\n=================== ${name}  (${v.text.length} chars, widest line ${maxLine})`);
  console.log(t);
  console.log("[buttons] " + v.kb.inline_keyboard.map((r: any[]) => r.map((b) => b.text).join(" | ")).join("  //  "));
}
process.exit(0);
