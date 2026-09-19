// Weekly pool claims, jackpot claims, VALOR -> USDC withdrawals and pass purchases.
// Every flow mirrors the official web client; on-chain calls are simulated before sending.
import { randomUUID } from "node:crypto";
import { parseAbi, type Hex, type PrivateKeyAccount } from "viem";
import { MogApi, sleep } from "../mog/api.js";
import { AbstractOps, VALOR_VAULT } from "../chain/abstract.js";
import { ABS, publicClient, walletClient } from "../chain/chains.js";

const claimVaultAbi = parseAbi([
  "function claimWeekly((uint256 week, uint256 amount, bytes signature)[] claims)",
  "function claimJackpot((uint256 nonce, uint256 amount, bytes signature)[] claims)",
]);
const valorVaultAbi = parseAbi([
  "function initiateWithdrawal(uint256 grossUsdc, uint256 deadline, uint256 minNetUsdc, bytes signature)",
  "function finalizeWithdrawal()", "function canFinalizeWithdrawal(address) view returns (bool)",
]);

export class ClaimsService {
  private pc = publicClient(ABS.chainId);
  private wc;
  constructor(private api: MogApi, private abs: AbstractOps, private account: PrivateKeyAccount, private log: (m: string) => void = () => {}) {
    this.wc = walletClient(ABS.chainId, account);
  }

  private async write(label: string, req: any): Promise<Hex> {
    await this.pc.simulateContract({ ...req, account: this.account });
    const hash = await this.wc.writeContract(req);
    const rc = await this.pc.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (rc.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    this.log(`${label}: ${hash}`);
    return hash;
  }
  /** Client helper M(): POST {txHash}; 202 / {pending} = still finalizing. */
  private async report(path: string, txHash: string) {
    for (let i = 1; i <= 3; i++) {
      try { const r = await this.api.post(path, { txHash }, { retry: true }); return r?.pending ? "finalizing" : "confirmed"; }
      catch (e: any) { if (i === 3) { this.log(`${path}: ${e.message}`); return "finalizing"; } await sleep(1000 * i); }
    }
    return "finalizing";
  }

  /** Unclaimed weekly pool payouts (amount > 0, not claimed). */
  async pendingWeekly() {
    const c = await this.api.get("/api/claims");
    return (c.pastWeeks ?? []).filter((w: any) => !w.claimed && w.amount && BigInt(w.amount) > 0n);
  }
  async claimWeekly() {
    let weeks = await this.pendingWeekly();
    if (!weeks.length) return null;
    if (weeks.some((w: any) => !w.signature)) { await this.api.post("/api/claims/generate-signatures"); weeks = await this.pendingWeekly(); }
    const signed = weeks.filter((w: any) => w.signature);
    if (!signed.length) throw new Error("weekly claims have no signatures yet");
    const args = signed.map((w: any) => ({ week: BigInt(w.weekNumber), amount: BigInt(w.amount), signature: w.signature as Hex }));
    const hash = await this.write("claimWeekly", { address: ABS.claimVault, abi: claimVaultAbi, functionName: "claimWeekly", args: [args] });
    const status = await this.report("/api/claims/process-claim", hash);
    return { hash, status, weeks: signed.map((w: any) => w.weekNumber), total: args.reduce((s: bigint, a: any) => s + a.amount, 0n) };
  }

  async pendingJackpotWei() { return BigInt((await this.api.get("/api/jackpot/balance")).pendingJackpotWei ?? "0"); }
  async claimJackpot() {
    if ((await this.pendingJackpotWei()) <= 0n) return null;
    const { claims, totalAmount } = await this.api.post("/api/jackpot/claim");
    if (!claims?.length) return null;
    const args = claims.map((c: any) => ({ nonce: BigInt(c.nonce), amount: BigInt(c.amount), signature: c.signature as Hex }));
    const hash = await this.write("claimJackpot", { address: ABS.claimVault, abi: claimVaultAbi, functionName: "claimJackpot", args: [args] });
    const status = await this.report("/api/jackpot/process-claim", hash);
    return { hash, status, totalAmount };
  }

  /** VALOR -> USDC: step 1 (min 500 VALOR, 5% fee, then 24h delay). */
  async initiateWithdrawal(valorAmount: number) {
    if (valorAmount < 500) throw new Error("minimum withdrawal is 500 VALOR");
    const pend = await this.api.get("/api/shop/valor/pending");
    if (pend?.pending) throw new Error(`a withdrawal is already pending (${pend.pending.status})`);
    const q = await this.api.post("/api/shop/valor/request-withdrawal", { valorAmount });
    const minNet = (BigInt(q.netUsdc) * 99n) / 100n; // same 1% guard as the client
    const hash = await this.write("initiateWithdrawal", { address: VALOR_VAULT, abi: valorVaultAbi, functionName: "initiateWithdrawal", args: [BigInt(q.grossUsdc), BigInt(q.deadline), minNet, q.signature] });
    await this.api.post("/api/shop/valor/confirm-initiation", { txHash: hash }, { retry: true });
    return { hash, grossUsdc: Number(q.grossUsdc) / 1e6, netUsdc: Number(q.netUsdc) / 1e6 };
  }
  /** Step 2 once the delay has passed. Returns null when nothing is claimable. */
  async finalizeWithdrawalIfReady() {
    const ready = await this.pc.readContract({ address: VALOR_VAULT, abi: valorVaultAbi, functionName: "canFinalizeWithdrawal", args: [this.account.address] });
    if (!ready) return null;
    const hash = await this.write("finalizeWithdrawal", { address: VALOR_VAULT, abi: valorVaultAbi, functionName: "finalizeWithdrawal", args: [] });
    await this.api.post("/api/shop/valor/confirm-finalization", { txHash: hash }, { retry: true });
    return { hash };
  }

  /** Deposit USDC.e into VALOR (100 VALOR = 1 USD, no fee) and confirm with the backend. */
  async depositValorUsd(usd: number) {
    const raw = BigInt(Math.round(usd * 1e6));
    const hash = await this.abs.depositValor(raw);
    for (let i = 0; i < 8; i++) {
      try { const r = await this.api.post("/api/shop/valor/confirm-deposit", { txHash: hash }); return { hash, valor: Number(r.valorBalance ?? r.newBalance ?? 0) }; }
      catch { await sleep(3000); }
    }
    throw new Error(`deposit ${hash} sent but not yet confirmed by backend — do NOT redeposit`);
  }

  /** Expedition Pass purchase: top up VALOR from USDC.e if short, then POST /api/shop/purchase. */
  async buyPass(itemId: number, reserveValor = 0) {
    const skus: any[] = await this.api.get("/api/shop/skus");
    const sku = skus.find((s) => Number(s.itemId) === itemId);
    if (!sku) throw new Error(`sku ${itemId} not found`);
    const price = BigInt(sku.salePrice ?? sku.listPrice);
    const bal = BigInt((await this.api.get("/api/shop/valor/balance")).valorBalance);
    const have = (bal > BigInt(reserveValor) ? bal - BigInt(reserveValor) : 0n) * 10_000n; // never spend market capital
    let depositTx: string | null = null;
    if (price > have) {
      depositTx = await this.abs.depositValor(price - have);
      let ok = false;
      for (let i = 0; i < 6 && !ok; i++) { try { await this.api.post("/api/shop/valor/confirm-deposit", { txHash: depositTx }); ok = true; } catch { await sleep(3000); } }
      if (!ok) throw new Error(`deposit ${depositTx} not confirmed yet — do NOT redeposit`);
    }
    const purchaseId = randomUUID();
    for (let i = 0; ; i++) {
      try { const r = await this.api.post("/api/shop/purchase", { purchaseId, itemId }); return { ...r, sku, depositTx, priceUsd: Number(price) / 1e6 }; }
      catch (e: any) { if (!["INSUFFICIENT_VALOR", "LOCK_CONFLICT"].includes(e.code) || i >= 3) throw e; await sleep(2000); }
    }
  }
}
