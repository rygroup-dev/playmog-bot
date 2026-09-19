import { erc20Abi, formatEther, parseAbi, type Hex, type PrivateKeyAccount } from "viem";
import { ABS, publicClient, walletClient } from "./chains.js";

export const VALOR_VAULT = "0x2DDF2129a55cF132E580cc5d69faD1dE3d213BbA" as const;
const vaultAbi = parseAbi([
  "function deposit(uint256 amount)", "function paused() view returns (bool)",
  "function initiateWithdrawal(uint256 grossUsdc, uint256 deadline, uint256 minNetUsdc, bytes signature)",
  "function finalizeWithdrawal()", "function canFinalizeWithdrawal(address) view returns (bool)",
]);
const keyAbi = parseAbi(["function buyKeys(uint256 quantity)", "function keyPrice() view returns (uint256)", "function paused() view returns (bool)"]);
const upvoteAbi = parseAbi(["function voteForApp(uint256 appId)"]);

export class AbstractOps {
  readonly pc = publicClient(ABS.chainId);
  readonly wc;
  constructor(private account: PrivateKeyAccount, private log: (m: string) => void = () => {}) {
    this.wc = walletClient(ABS.chainId, account);
  }
  async balances() {
    const [eth, usdc] = await Promise.all([
      this.pc.getBalance({ address: this.account.address }),
      this.pc.readContract({ address: ABS.usdce, abi: erc20Abi, functionName: "balanceOf", args: [this.account.address] }),
    ]);
    return { eth, usdc, ethFmt: formatEther(eth), usdcFmt: (Number(usdc) / 1e6).toFixed(2) };
  }
  private async send(label: string, req: Parameters<typeof this.wc.writeContract>[0]): Promise<Hex> {
    await this.pc.simulateContract({ ...(req as any), account: this.account }); // revert -> throws before spending gas
    const hash = await this.wc.writeContract(req as any);
    this.log(`${label}: ${hash}`);
    const rc = await this.pc.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (rc.status !== "success") throw new Error(`${label} reverted: ${hash}`);
    return hash;
  }
  async ensureAllowance(spender: `0x${string}`, amount: bigint) {
    const cur = await this.pc.readContract({ address: ABS.usdce, abi: erc20Abi, functionName: "allowance", args: [this.account.address, spender] });
    if (cur >= amount) return null;
    return this.send("approve", { address: ABS.usdce, abi: erc20Abi, functionName: "approve", args: [spender, amount] } as any);
  }
  /** USDC.e -> VALOR vault deposit (raw 6dp). Caller must confirm with MoG API. */
  async depositValor(rawUsdc: bigint) {
    if (await this.pc.readContract({ address: VALOR_VAULT, abi: vaultAbi, functionName: "paused" })) throw new Error("ValorVault paused");
    await this.ensureAllowance(VALOR_VAULT, rawUsdc);
    return this.send("valor deposit", { address: VALOR_VAULT, abi: vaultAbi, functionName: "deposit", args: [rawUsdc] } as any);
  }
  async buyKeys(qty: bigint) {
    const [price, paused] = await Promise.all([
      this.pc.readContract({ address: ABS.keyPurchase, abi: keyAbi, functionName: "keyPrice" }),
      this.pc.readContract({ address: ABS.keyPurchase, abi: keyAbi, functionName: "paused" }),
    ]);
    if (paused) throw new Error("KeyPurchase paused");
    await this.ensureAllowance(ABS.keyPurchase, price * qty);
    return { hash: await this.send(`buyKeys x${qty}`, { address: ABS.keyPurchase, abi: keyAbi, functionName: "buyKeys", args: [qty] } as any), price };
  }
  upvote() {
    return this.send("voteForApp", { address: ABS.upvote, abi: upvoteAbi, functionName: "voteForApp", args: [ABS.mogAppId] } as any);
  }
}
