// Expedition Pass referral handling.
// The default code belongs to the project maintainer (disclosed in the README). Override it with REFERRAL_CODE,
// or set REFERRAL_CODE= (empty) to disable. Rules, all enforced here:
//   * never refer yourself, never replace a referral the server already recorded for the account
//   * only the FIRST game account running on a machine uses the code (marker file in ~/.config/playmog-bot),
//     so one person running several accounts refers at most one of them
//   * the code must pass the game's own validation endpoint
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MogApi } from "../mog/api.js";

export const DEFAULT_REFERRAL_CODE = "TMZA47S8";
const markerPath = () => process.env.REFERRAL_MARKER ?? join(homedir(), ".config", "playmog-bot", "referral-account");

export async function referralCodeFor(api: MogApi, log: (m: string) => void = () => {}): Promise<string | null> {
  const code = (process.env.REFERRAL_CODE ?? DEFAULT_REFERRAL_CODE).trim().toUpperCase();
  if (!code) return null;
  const me = api.address.toLowerCase();
  const marker = markerPath();
  if (existsSync(marker)) {
    const owner = readFileSync(marker, "utf8").trim().toLowerCase();
    if (owner && owner !== me) { log(`referral: skipped — ${owner.slice(0, 10)}… already used it on this machine`); return null; }
  }
  const own = await api.get("/api/shop/pass-code").catch(() => null);
  if (own?.code?.toUpperCase() === code) return null;                       // no self-referral
  const pass = await api.get("/api/shop/pass").catch(() => null);
  if (pass?.referredByCode) return null;                                    // server already has a referrer
  const v = await api.post("/api/shop/validate-referral-code", { code }).catch(() => null);
  if (!v?.valid) { log(`referral: code ${code} not valid right now (referrer needs an active pass)`); return null; }
  return code;
}

/** Call after a purchase that used the code, so other accounts on this machine won't use it. */
export function markReferralUsed(address: string) {
  const marker = markerPath();
  if (existsSync(marker)) return;
  mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
  writeFileSync(marker, address.toLowerCase() + "\n", { mode: 0o600 });
}
