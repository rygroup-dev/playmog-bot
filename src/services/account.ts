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
  prizes?: { bountyValor: number; bountyPaidValor: number; throneValor: number; throneEnabled: boolean; boostValor: number; boostsLeft: number };
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
    // The two big prizes a run can hit, both on the floor-10 boss: the Bounty pool (30% of every key sale,
    // won by killing the rare Bounty Boss) and the Throne pool (80% to one winner who clears the run).
    task("prizes", async () => {
      const [j, t] = await Promise.all([api.get("/api/jackpot/pool"), api.get("/api/throne/campaign")]);
      s.prizes = { bountyValor: Number(j.poolValor ?? 0), bountyPaidValor: Number(j.totalPaidValor ?? 0),
        throneValor: Number(t.thronePoolValor ?? 0), throneEnabled: !!t.throneEnabled,
        boostValor: t.boostEnabled ? Number(t.boostAmountValor ?? 0) : 0, boostsLeft: Number(t.boostsRemaining ?? 0) };
    }),
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
