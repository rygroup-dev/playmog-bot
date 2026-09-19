// Arm the one-shot market top-up: next time >= USD new USDC.e lands, deposit it to VALOR and raise market capital.
// usage: npx tsx scripts/fund-plan.ts <marketUsd> <targetCapitalValor> [maxAssets]
import { env } from "../src/config.js";
import { Store } from "../src/db.js";
import { loadAccount } from "../src/util/wallet.js";
import { AbstractOps } from "../src/chain/abstract.js";
const [usd = "15", cap = "3000", maxAssets = "3"] = process.argv.slice(2);
const store = new Store(env.DB_PATH);
const b = await new AbstractOps(loadAccount(env.WALLET_PATH)).balances();
const p = { marketUsd: Number(usd), targetCapitalValor: Number(cap), targetMaxAssets: Number(maxAssets), baselineUsdc: Number(b.usdc) / 1e6, createdAt: Date.now() };
store.set("fund.plan", p);
console.log("fund plan armed", p, "eth", b.ethFmt);
