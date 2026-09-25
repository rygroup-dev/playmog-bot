// Weekly pool claims, jackpot claims, VALOR -> USDC withdrawals and pass purchases.
// Every flow mirrors the official web client; on-chain calls are simulated before sending.
import { randomUUID } from "node:crypto";
import { parseAbi, type Hex, type PrivateKeyAccount } from "viem";
import { MogApi, sleep } from "../mog/api.js";
import { AbstractOps, VALOR_VAULT } from "../chain/abstract.js";
import { ABS, publicClient, walletClient } from "../chain/chains.js";
import { markReferralUsed, referralCodeFor } from "./referral.js";

const claimVaultAbi = parseAbi([
  "function claimWeekly((uint256 week, uint256 amount, bytes signature)[] claims)",
  "function claimJackpot((uint256 nonce, uint256 amount, bytes signature)[] claims)",
]);
const valorVaultAbi = parseAbi([
  "function initiateWithdrawal(uint256 grossUsdc, uint256 deadline, uint256 minNetUsdc, bytes signature)",
  "function finalizeWithdrawal()", "function canFinalizeWithdrawal(address) view returns (bool)",
]);

/** Reject rather than hang forever: a chain read with no deadline can freeze the whole autopilot tick. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms).unref())]);
}

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

  /** VALOR -> USDC: step 1 (min 500 VALOR, then a 24h delay). */
  async initiateWithdrawal(valorAmount: number) {
    if (valorAmount < 500) throw new Error("minimum withdrawal is 500 VALOR");
    const pend = await this.api.get("/api/shop/valor/pending");
    // A row with no initiatedAt is a quote whose on-chain tx never happened (e.g. the bot stopped in between).
    // Its VALOR is already escrowed and there is no cancel endpoint, so resume it instead of stranding the balance.
    const p = pend?.pending;
    if (p?.initiatedAt) throw new Error(`a withdrawal is already in progress (${p.status})`);
    // the API validates valorAmount as a string — sending a number fails with VALIDATION_ERROR
    const q = p ?? await this.api.post("/api/shop/valor/request-withdrawal", { valorAmount: String(valorAmount) });
    const minNet = (BigInt(q.netUsdc) * 99n) / 100n; // same 1% guard as the client
    const hash = await this.write("initiateWithdrawal", { address: VALOR_VAULT, abi: valorVaultAbi, functionName: "initiateWithdrawal", args: [BigInt(q.grossUsdc), BigInt(q.deadline), minNet, q.signature] });
    await this.api.post("/api/shop/valor/confirm-initiation", { txHash: hash }, { retry: true });
    return { hash, grossUsdc: Number(q.grossUsdc) / 1e6, netUsdc: Number(q.netUsdc) / 1e6 };
  }
  /** Step 2 once the delay has passed. Returns null when nothing is claimable. */
  async finalizeWithdrawalIfReady() {
    // viem's readContract has no timeout of its own, and this one sits on the autopilot's critical path: on
    // 2026-09-25 the tick went silent for seven minutes here, so a run the owner had started by hand was never
    // picked up. A stalled RPC must cost us one tick, not the loop.
    const ready = await withTimeout(this.pc.readContract({ address: VALOR_VAULT, abi: valorVaultAbi, functionName: "canFinalizeWithdrawal", args: [this.account.address] }), 20_000, "canFinalizeWithdrawal");
    if (!ready) return null;
    const hash = await this.write("finalizeWithdrawal", { address: VALOR_VAULT, abi: valorVaultAbi, functionName: "finalizeWithdrawal", args: [] });
    await this.api.post("/api/shop/valor/confirm-finalization", { txHash: hash }, { retry: true });
    return { hash };
  }

  /** Yield Fields WL raffle: every Golden Corn (or Eve Key) entered = 1 ticket; 175 corn spots / 100 eve-key spots per draw. */
  async raffleStatus(pool: "goldenCorn" | "eveKeys" | "genesis" = "goldenCorn") {
    const r = await this.api.get(pool === "genesis" ? "/api/raffle/status" : `/api/raffle/status?pool=${pool}`); // default pool = weekly Genesis Hero raffle
    r.slotPool ??= 5;
    const expectedWins = r.globalEntries > 0 ? (r.slotPool * (r.userEntries + r.ticketBalance)) / (r.globalEntries + r.ticketBalance) : 0;
    return { ...r, expectedWins, chanceAtLeastOne: 1 - Math.exp(-expectedWins) };
  }
  async enterRaffle(pool: "goldenCorn" | "eveKeys" | "genesis", ticketCount: number) {
    if (ticketCount <= 0) return null;
    return this.api.post("/api/raffle/enter", pool === "genesis" ? { ticketCount } : { ticketCount, pool });
  }

  /** Redeem worldseeds (amber) into World's Eve caches; contents land in the item inventory. */
  async redeemCaches(premium = false) {
    const cost = premium ? 2000 : 500;
    const amber = Number((await this.api.get("/api/items/amber")).balance ?? 0);
    const count = Math.floor(amber / cost);
    if (count < 1) return null;
    const r = await this.api.post("/api/quests/worldseve-redeem", { cacheType: premium ? "worldseve_cache_premium" : "worldseve_cache", count, operationId: randomUUID() });
    return { count: r.redeemedCount ?? count, amber: r.amberBalance, raw: r };
  }

  /** Open World's Eve caches (they arrive as inventory items and must be opened to get the rewards). */
  async openCaches(premium = false) {
    const boxType = premium ? "worldseve_cache_premium" : "worldseve_cache";
    const key = premium ? "cache.worlds_eve_premium" : "cache.worlds_eve";
    const held = Number(((await this.api.get("/api/items/balances")).balances ?? {})[key]?.balance ?? 0);
    if (held < 1) return null;
    const r = await this.api.post("/api/skins/open-box", { count: held, boxType, operationId: randomUUID() });
    // server shape (verified live 2026-09-20): { revealedRewards: [{rewardType, assetKey?, nameKey, amount, boxTypeReward?}], revealedSkins: [] }
    const rewards: { name: string; qty: number }[] = [];
    for (const g of r.revealedRewards ?? r.rewards ?? []) {
      const name = g.assetKey ?? (g.rewardType === "skin_box" ? `skin_box.${g.boxTypeReward ?? "?"}` : g.rewardType ?? g.nameKey ?? "?");
      const qty = Number(g.amount ?? g.quantity ?? 1);
      const hit = rewards.find((x) => x.name === name);
      if (hit) hit.qty += qty; else rewards.push({ name: String(name), qty });
    }
    for (const sk of r.revealedSkins ?? []) rewards.push({ name: `skin #${sk.skinId ?? sk.id ?? "?"}`, qty: 1 });
    return { opened: held, rewards, raw: r };
  }

  /** Open any skin boxes we hold (free; 5 duplicate skins can be recycled later). */
  async openSkinBoxes() {
    const boxes = (await this.api.get("/api/items/skinboxes")).balances ?? {};
    const out: { boxType: string; opened: number; skins: number }[] = [];
    for (const [boxType, bal] of Object.entries<any>(boxes)) {
      const count = Number(bal?.balance ?? bal ?? 0); if (count < 1) continue;
      const r = await this.api.post("/api/skins/open-box", { count, boxType, operationId: randomUUID() });
      out.push({ boxType, opened: count, skins: (r.revealedSkins ?? []).length });
    }
    return out.length ? out : null;
  }

  /**
   * Lobby "Ringjak Racing": stake VALOR on one of four lanes. 10-100 VALOR in steps of 5, 1st pays 3x, 2nd pays 0.8x,
   * so the house keeps 5% on average — the best odds MoG offers, and still a loss over time.
   * POST /api/lobby/derby {betId, stake, lane} -> {ticks, ranking, outcome: win|place|lose, valorBalance}
   */
  async lobbyDerby(stake: number, lane = Math.floor(Math.random() * 4)) {
    if (stake < 10 || stake > 100 || stake % 5 !== 0) throw new Error("stake must be 10-100 VALOR in steps of 5");
    if (lane < 0 || lane > 3) throw new Error("lane must be 0-3");
    const before = Number((await this.api.get("/api/shop/valor/balance")).valorBalance);
    const r = await this.api.post("/api/lobby/derby", { betId: randomUUID(), stake, lane });
    const after = Number(r.valorBalance ?? before);
    const outcome = String(r.outcome ?? "lose");
    return { stake, lane, outcome, payout: after - (before - stake), delta: after - before, valor: after,
      lanes: ["Merah", "Biru", "Hijau", "Kuning"], raw: r };
  }

  /**
   * Link this wallet to the game account so claim-style rewards (e.g. the Yield Fields whitelist deed, which mints
   * on Robinhood chain) have an address to go to. Same SIWE shape the web client uses:
   * POST /api/wallet/link {address, message, signature}.
   */
  async linkStatus() {
    const r = await this.api.get("/api/wallet/link").catch(() => null);
    return { account: (r?.accountAddress ?? this.account.address) as string, linked: (r?.linkedWalletAddress ?? null) as string | null, at: r?.linkedWalletAt ?? null };
  }

  /** The exact SIWE text the other wallet has to sign (the game refuses a self-link, verified live). */
  async linkMessageFor(address: string) {
    const account = this.account.address;
    const nonce = (await this.api.raw("/api/auth/nonce").then((r) => r.text())).trim();
    const now = new Date(), exp = new Date(Date.now() + 10 * 60_000);
    return `playmog.xyz wants you to sign in with your Ethereum account:\n${address}\n\n` +
      `Link this wallet to Maze of Gains account ${account.toLowerCase()}. It attaches an address to that account for claiming; it does not merge accounts and cannot spend from this wallet.\n\n` +
      `URI: https://playmog.xyz\nVersion: 1\nChain ID: 2741\nNonce: ${nonce}\nIssued At: ${now.toISOString()}\nExpiration Time: ${exp.toISOString()}`;
  }
  async submitLink(address: string, message: string, signature: string) {
    const r = await this.api.post("/api/wallet/link", { address, message, signature });
    return { address: (r.linkedWalletAddress ?? address) as string, raw: r };
  }
  async unlinkWallet() { return this.api.request("/api/wallet/link", { method: "DELETE" }); }

  async linkWallet() {
    const cur = await this.api.get("/api/wallet/link").catch(() => null);
    if (cur?.linkedWalletAddress) return { already: true, address: cur.linkedWalletAddress as string };
    const account = this.account.address;
    const nonce = (await this.api.raw("/api/auth/nonce").then((r) => r.text())).trim();
    const now = new Date(), exp = new Date(Date.now() + 10 * 60_000);
    const message = `playmog.xyz wants you to sign in with your Ethereum account:\n${account}\n\n` +
      `Link this wallet to Maze of Gains account ${account.toLowerCase()}. It attaches an address to that account for claiming; it does not merge accounts and cannot spend from this wallet.\n\n` +
      `URI: https://playmog.xyz\nVersion: 1\nChain ID: 2741\nNonce: ${nonce}\nIssued At: ${now.toISOString()}\nExpiration Time: ${exp.toISOString()}`;
    const signature = await this.account.signMessage({ message });
    const r = await this.api.post("/api/wallet/link", { address: account, message, signature });
    return { already: false, address: (r.linkedWalletAddress ?? account) as string, raw: r };
  }

  /**
   * Make sure `needValor` is available in-game, topping up from wallet USDC.e when it is not.
   * `reserveValor` is VALOR that must stay untouched (market capital, pass reserve); `keepUsdc` is the wallet floor.
   */
  async ensureValor(needValor: number, { reserveValor = 0, keepUsdc = 0 } = {}) {
    const valor = Number((await this.api.get("/api/shop/valor/balance")).valorBalance);
    const free = Math.max(0, valor - reserveValor);
    if (free >= needValor) return { valor, deposited: 0 };
    const usd = Math.ceil((needValor - free) / 100);
    const wallet = Number((await this.abs.balances()).usdc) / 1e6;
    if (wallet - usd < keepUsdc) {
      throw new Error(`butuh ${needValor} VALOR, tersedia ${free} (di luar cadangan ${reserveValor}); USDC.e ${wallet.toFixed(2)} kurang untuk menambal $${usd}`);
    }
    const r = await this.depositValorUsd(usd);
    return { valor: r.valor, deposited: usd, hash: r.hash };
  }

  /** Arcade keys, always via VALOR (100 each, no gas), topping up from USDC.e when VALOR is short. */
  async buyArcadeKeys(qty: number, opts: { reserveValor?: number; keepUsdc?: number } = {}) {
    const top = await this.ensureValor(qty * 100, opts);
    const r = await this.buyKeysWithValor(qty);
    return { ...r, depositedUsd: top.deposited, depositTx: top.hash };
  }

  /** Buy Arcade keys with in-game VALOR (100 VALOR per key): no gas, no on-chain step. */
  async buyKeysWithValor(quantity: number) {
    const before = Number((await this.api.get("/api/shop/valor/balance")).valorBalance);
    const r = await this.api.post("/api/keys/purchase-with-valor", { purchaseId: randomUUID(), quantity });
    const after = Number(r.newValorBalance ?? (await this.api.get("/api/shop/valor/balance")).valorBalance);
    return { quantity, keys: Number(r.newKeysBalance ?? 0), valorSpent: before - after, valor: after, raw: r };
  }

  /**
   * Five skins burn into one new roll (REQUIRED_SKINS_FOR_RECYCLE in the client). Destructive and irreversible,
   * and skins are not tradeable anywhere, so this is only ever triggered by hand from Telegram — never by autopilot.
   */
  async recycleSkins(skinIds?: number[]) {
    const owned: number[] = (await this.api.get("/api/skins")).ownedSkins ?? [];
    const ids = skinIds ?? owned.slice(0, 5);
    if (ids.length < 5) return null;
    const r = await this.api.post("/api/skins/recycle", { skinIds: ids });
    return { used: ids.length, reward: r, owned };
  }
  async skins(): Promise<{ ownedSkins: number[]; equippedSkin: number }> {
    const r = await this.api.get("/api/skins");
    return { ownedSkins: r.ownedSkins ?? [], equippedSkin: Number(r.equippedSkin ?? 0) };
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
    const referralCode = await referralCodeFor(this.api, this.log);
    for (let i = 0; ; i++) {
      try {
        const r = await this.api.post("/api/shop/purchase", { purchaseId, itemId, ...(referralCode ? { referralCode } : {}) });
        if (referralCode) markReferralUsed(this.account.address);
        return { ...r, sku, depositTx, priceUsd: Number(price) / 1e6, referralCode };
      }
      catch (e: any) { if (!["INSUFFICIENT_VALOR", "LOCK_CONFLICT"].includes(e.code) || i >= 3) throw e; await sleep(2000); }
    }
  }
}
