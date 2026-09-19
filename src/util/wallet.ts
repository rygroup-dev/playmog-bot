import { readFileSync, statSync } from "node:fs";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export const WALLET_PATH = process.env.WALLET_PATH ?? "secrets/wallet.json";

export function loadAccount(path = WALLET_PATH): PrivateKeyAccount {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`wallet file ${path} has unsafe permissions ${mode.toString(8)} (need 600)`);
  const { privateKey } = JSON.parse(readFileSync(path, "utf8"));
  return privateKeyToAccount(privateKey);
}
