import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";

// minimal .env loader (no dependency); real env vars win
if (existsSync(".env")) for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const Env = z.object({
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[\w-]{30,}$/, "invalid TELEGRAM_BOT_TOKEN"),
  TELEGRAM_OWNER_IDS: z.string().default(""),
  WALLET_PATH: z.string().default("secrets/wallet.json"),
  DB_PATH: z.string().default("data/bot.db"),
  MOG_APP_VERSION: z.string().default("24"),
  LOG_LEVEL: z.string().default("info"),
  // 2captcha Turnstile solver for the game's human-check gate (create run / join room / world-eve).
  TWOCAPTCHA_API_KEY: z.string().default(""),
  TWOCAPTCHA_SOFT_ID: z.string().default(""),
  MOG_VERIFY_PAGEURL: z.string().default("https://playmog.xyz"),
});
export const env = Env.parse(process.env);
export const ownerIdsFromEnv = env.TELEGRAM_OWNER_IDS.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
