import { MogApi } from "../mog/api.js";
import { AbstractOps } from "../chain/abstract.js";
import { publicClient } from "../chain/chains.js";
import { arbitrum, robinhood } from "viem/chains";
import { formatEther } from "viem";

export interface Snapshot {
  at: number; address: string;
  wallet?: { eth: string; usdc: string; arbEth?: string; rhEth?: string };
  valor?: number; pass?: any; keys?: number; expKeys?: number; items?: Record<string, number>;
  upvote?: any; claims?: any; earnings?: any; weekly?: any; expRun?: any; quests?: any;
  pool?: { poolValor: number; totalTreasure: number; valorPerTreasure: number; usdPerKeyEst: number; usdPerKeyTop: number; ownTreasurePerKey: number | null };
  activeRuns?: Record<string, any>; errors: string[];
}

const TREASURE_PER_KEY_EST = 3200; // measured on the top-100 board 2026-09-18/19 (3.0k-3.4k)

export async function snapshot(api: MogApi, abs: AbstractOps, ownTreasurePerKey: number | null = null): Promise<Snapshot> {
  const s: Snapshot = { at: Date.now(), address: api.address, errors: [] };
  const addr = api.address.toLowerCase();
  const task = async (name: string, fn: () => Promise<void>) => { try { await fn(); } catch (e: any) { s.errors.push(`${name}: ${e?.shortMessage ?? e?.message ?? e}`.slice(0, 160)); } };
  await Promise.all([
    task("wallet", async () => {
      const b = await abs.balances();
      s.wallet = { eth: Number(b.ethFmt).toFixed(5), usdc: b.usdcFmt };
      const [a, r] = await Promise.allSettled([publicClient(arbitrum.id).getBalance({ address: api.address }), publicClient(robinhood.id).getBalance({ address: api.address })]);
      if (a.status === "fulfilled") s.wallet.arbEth = Number(formatEther(a.value)).toFixed(5);
      if (r.status === "fulfilled") s.wallet.rhEth = Number(formatEther(r.value)).toFixed(5);
    }),
    task("valor", async () => { s.valor = Number((await api.get("/api/shop/valor/balance")).valorBalance); }),
    task("pass", async () => { s.pass = await api.get("/api/shop/pass"); }),
    task("keys", async () => { s.keys = (await api.get("/api/keys/balance")).balance; }),
    task("items", async () => {
      const b = (await api.get("/api/items/balances")).balances ?? {};
      const items: Record<string, number> = Object.fromEntries(Object.entries(b).map(([k, v]: any) => [k, v.balance]));
      s.items = items; s.expKeys = items["key.expedition"] ?? 0;
    }),
    task("upvote", async () => { s.upvote = await api.get("/api/upvote/record"); }),
    task("claims", async () => {
      s.claims = await api.get("/api/claims");
      const cw = s.claims.currentWeek;
      const poolValor = Number(cw.pool), totalTreasure = Number(cw.totalTreasure);
      if (totalTreasure > 0) {
        const vpt = poolValor / totalTreasure;
        s.pool = { poolValor, totalTreasure, valorPerTreasure: vpt, usdPerKeyEst: (vpt * (ownTreasurePerKey ?? 500)) / 100, usdPerKeyTop: (vpt * TREASURE_PER_KEY_EST) / 100, ownTreasurePerKey };
      }
    }),
    task("earnings", async () => { s.earnings = await api.get("/api/claims/earnings"); }),
    task("weekly", async () => { s.weekly = (await api.get(`/api/runs?mode=weekly&address=${addr}`)).userStats; }),
    task("expRun", async () => { s.expRun = (await api.get(`/api/runs?variant=ABSTRACT&mode=expedition&sortBy=treasure&address=${addr}`)).userRun; }),
    task("quests", async () => { s.quests = await api.get("/api/quests/board"); }),
    task("active", async () => {
      s.activeRuns = {};
      for (const t of ["NORMAL", "EXPEDITION", "WORLD"]) { const a = await api.get(`/api/runs/active?runType=${t}`); if (a.activeRun) s.activeRuns[t] = a.activeRun; }
    }),
  ]);
  return s;
}
