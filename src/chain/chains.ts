import { createPublicClient, createWalletClient, http, fallback, type Chain } from "viem";
import { abstract, arbitrum, robinhood } from "viem/chains";
import type { PrivateKeyAccount } from "viem/accounts";

export const CHAINS: Record<number, { chain: Chain; rpcs: string[] }> = {
  [abstract.id]: { chain: abstract, rpcs: ["https://api.mainnet.abs.xyz", "https://abstract.drpc.org"] },
  [arbitrum.id]: { chain: arbitrum, rpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum.drpc.org", "https://arbitrum-one-rpc.publicnode.com"] },
  [robinhood.id]: { chain: robinhood, rpcs: ["https://robinhood-rpc.publicnode.com"] },
};

export const NATIVE = "0x0000000000000000000000000000000000000000" as const;
export const ABS = {
  chainId: abstract.id,
  usdce: "0x84a71ccd554cc1b02749b35d22f684cc8ec987e1",
  keyPurchase: "0x3ef14148603202C0225eDFFcFdCcF3E68E5F5E03",
  claimVault: "0x40018Cbb1926dae72DCb315E89AAB7320A191D02",
  upvote: "0x3B50dE27506f0a8C1f4122A1e6F470009a76ce2A",
  mogAppId: 213n,
} as const;

const transport = (id: number) => fallback(CHAINS[id].rpcs.map((u) => http(u, { timeout: 15_000, retryCount: 2 })), { rank: false });

const pubCache = new Map<number, ReturnType<typeof createPublicClient>>();
export function publicClient(chainId: number) {
  if (!CHAINS[chainId]) throw new Error(`unsupported chain ${chainId}`);
  let c = pubCache.get(chainId);
  if (!c) { c = createPublicClient({ chain: CHAINS[chainId].chain, transport: transport(chainId) }); pubCache.set(chainId, c); }
  return c;
}
export function walletClient(chainId: number, account: PrivateKeyAccount) {
  if (!CHAINS[chainId]) throw new Error(`unsupported chain ${chainId}`);
  return createWalletClient({ chain: CHAINS[chainId].chain, transport: transport(chainId), account });
}
