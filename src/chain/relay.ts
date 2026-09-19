// Relay (relay.link) bridge + swap. Same provider the MoG site uses.
import type { Hex, PrivateKeyAccount } from "viem";
import { publicClient, walletClient } from "./chains.js";

const API = "https://api.relay.link";

export interface QuoteParams {
  user: string; originChainId: number; destinationChainId: number;
  originCurrency: string; destinationCurrency: string; amount: string;
  tradeType: "EXACT_INPUT" | "EXACT_OUTPUT"; recipient?: string; slippageTolerance?: string;
}
export interface Quote {
  steps: { id: string; kind: string; requestId?: string; items: { status: string; data: any; check?: { endpoint: string } }[] }[];
  details: { currencyIn: { amount: string; amountFormatted: string; amountUsd: string; currency: { symbol: string; chainId: number } };
             currencyOut: { amount: string; amountFormatted: string; amountUsd: string; currency: { symbol: string; chainId: number } };
             timeEstimate?: number };
  fees: Record<string, { amountUsd: string }>;
}

async function api<T>(path: string, init?: RequestInit, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(API + path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
      const t = await r.text();
      if (r.status >= 500 || r.status === 429) throw new Error(`relay ${r.status}: ${t.slice(0, 200)}`);
      const j = JSON.parse(t);
      if (!r.ok) throw Object.assign(new Error(`relay ${r.status}: ${j.message ?? t.slice(0, 200)}`), { fatal: true });
      return j as T;
    } catch (e: any) { last = e; if (e?.fatal) throw e; await new Promise((s) => setTimeout(s, 500 * 2 ** i)); }
  }
  throw last;
}

export const getQuote = (p: QuoteParams) =>
  api<Quote>("/quote", { method: "POST", body: JSON.stringify({ recipient: p.user, ...p }) });

export function describeQuote(q: Quote) {
  const d = q.details;
  const feeUsd = Object.values(q.fees ?? {}).reduce((s, f) => s + Number(f?.amountUsd ?? 0), 0);
  return `${d.currencyIn.amountFormatted} ${d.currencyIn.currency.symbol} ($${Number(d.currencyIn.amountUsd).toFixed(2)}) -> ` +
    `${d.currencyOut.amountFormatted} ${d.currencyOut.currency.symbol} ($${Number(d.currencyOut.amountUsd).toFixed(2)}) | fees ~$${feeUsd.toFixed(3)}`;
}

/** Executes every transaction step of a quote in order and waits for Relay to report success. */
export async function executeQuote(q: Quote, account: PrivateKeyAccount, log: (m: string) => void = () => {}) {
  const hashes: Hex[] = [];
  for (const step of q.steps) {
    if (step.kind !== "transaction") throw new Error(`unsupported relay step kind ${step.kind} (${step.id})`);
    for (const item of step.items) {
      if (item.status === "complete") continue;
      const d = item.data;
      if (d.from && d.from.toLowerCase() !== account.address.toLowerCase()) throw new Error("relay tx from-address mismatch");
      const wc = walletClient(d.chainId, account);
      const hash = await wc.sendTransaction({
        to: d.to, data: d.data, value: BigInt(d.value ?? 0),
        ...(d.gas ? { gas: (BigInt(d.gas) * 12n) / 10n } : {}),
        ...(d.maxFeePerGas ? { maxFeePerGas: BigInt(d.maxFeePerGas), maxPriorityFeePerGas: BigInt(d.maxPriorityFeePerGas ?? 0) } : {}),
      } as any);
      log(`${step.id} tx ${hash} (chain ${d.chainId})`);
      const rc = await publicClient(d.chainId).waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (rc.status !== "success") throw new Error(`relay ${step.id} tx reverted ${hash}`);
      hashes.push(hash);
      if (item.check?.endpoint) await waitStatus(item.check.endpoint, log);
    }
  }
  return hashes;
}

async function waitStatus(endpoint: string, log: (m: string) => void) {
  const deadline = Date.now() + 10 * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    const s: { status: string; details?: string } = await api<{ status: string; details?: string }>(endpoint).catch(() => ({ status: "unknown" }));
    if (s.status !== last) { log(`relay status: ${s.status}`); last = s.status; }
    if (s.status === "success") return;
    if (["failure", "refund", "refunded"].includes(s.status)) throw new Error(`relay intent ${s.status}: ${s.details ?? ""}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("relay status timeout (funds are not lost; check relay.link explorer)");
}
