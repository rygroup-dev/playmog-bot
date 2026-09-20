import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { referralCodeFor, markReferralUsed, DEFAULT_REFERRAL_CODE } from "../src/services/referral.js";

const ME = "0x1111111111111111111111111111111111111111";
function fakeApi(o: { own?: string; referredBy?: string | null; valid?: boolean } = {}) {
  return {
    address: ME,
    get: async (p: string) => p.includes("pass-code") ? { code: o.own ?? "OWNCODE1" } : { referredByCode: o.referredBy ?? null },
    post: async () => ({ valid: o.valid ?? true }),
  } as any;
}
let marker = "";
beforeEach(() => { marker = join(mkdtempSync(join(tmpdir(), "ref-")), "referral-account"); process.env.REFERRAL_MARKER = marker; delete process.env.REFERRAL_CODE; });

describe("referral rules", () => {
  it("uses the default code for a fresh, unreferred account", async () => { expect(await referralCodeFor(fakeApi())).toBe(DEFAULT_REFERRAL_CODE); });
  it("never refers itself", async () => { expect(await referralCodeFor(fakeApi({ own: DEFAULT_REFERRAL_CODE }))).toBeNull(); });
  it("keeps a referrer the server already recorded", async () => { expect(await referralCodeFor(fakeApi({ referredBy: "SOMEONE1" }))).toBeNull(); });
  it("skips invalid codes", async () => { expect(await referralCodeFor(fakeApi({ valid: false }))).toBeNull(); });
  it("keeps the default when REFERRAL_CODE is empty", async () => { process.env.REFERRAL_CODE = ""; expect(await referralCodeFor(fakeApi())).toBe(DEFAULT_REFERRAL_CODE); });
  it("is disabled with REFERRAL_CODE=none", async () => { process.env.REFERRAL_CODE = "none"; expect(await referralCodeFor(fakeApi())).toBeNull(); });
  it("is disabled with REFERRAL_CODE=off", async () => { process.env.REFERRAL_CODE = "off"; expect(await referralCodeFor(fakeApi())).toBeNull(); });
  it("honours a custom REFERRAL_CODE", async () => { process.env.REFERRAL_CODE = "friend99"; expect(await referralCodeFor(fakeApi())).toBe("FRIEND99"); });
  it("only the first account on a machine is referred", async () => {
    markReferralUsed("0x2222222222222222222222222222222222222222");
    expect(await referralCodeFor(fakeApi())).toBeNull();
  });
  it("the same account can still use it (e.g. renewals before the server records it)", async () => {
    markReferralUsed(ME); expect(await referralCodeFor(fakeApi())).toBe(DEFAULT_REFERRAL_CODE);
  });
  it("marker is written once and never overwritten", () => {
    markReferralUsed(ME); markReferralUsed("0x3333333333333333333333333333333333333333");
    expect(existsSync(marker)).toBe(true); expect(readFileSync(marker, "utf8").trim()).toBe(ME);
  });
});
