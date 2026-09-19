// Creates a fresh bot wallet (EOA) at WALLET_PATH (default secrets/wallet.json) with 0600 permissions.
// Prints ONLY the public address. Never commit the generated file.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const path = process.env.WALLET_PATH ?? "secrets/wallet.json";
if (existsSync(path)) { console.error(`${path} already exists — refusing to overwrite it.`); process.exit(1); }
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const privateKey = generatePrivateKey();
const { address } = privateKeyToAccount(privateKey);
writeFileSync(path, JSON.stringify({ address, privateKey, createdAt: new Date().toISOString() }), { mode: 0o600 });
console.log(`New bot wallet: ${address}\nSaved to ${path} (mode 600). Fund it on Abstract (ETH for gas, USDC.e for spending).`);
