import { describe, it, expect } from "vitest";
import { ClaimsService } from "../src/services/claims.js";

/**
 * Two live-verified rules of /api/shop/valor/request-withdrawal:
 *  - valorAmount must be a STRING; a number returns 400 VALIDATION_ERROR (this silently broke auto-withdraw).
 *  - there is no cancel endpoint, so a quote whose on-chain tx never landed (initiatedAt: null) holds the VALOR
 *    in escrow forever unless we resume it instead of asking for a second quote.
 */
const svc = (api: any) => {
  const c = Object.create(ClaimsService.prototype) as any;
  c.api = api;
  c.write = async () => "0xdeadbeef";
  return c as ClaimsService;
};
const quote = { netUsdc: "5000000", grossUsdc: "5000000", deadline: "2105266979", signature: "0xsig" };

describe("initiateWithdrawal", () => {
  it("sends valorAmount as a string", async () => {
    const posts: any[] = [];
    const c = svc({
      get: async () => ({ pending: null }),
      post: async (p: string, b: any) => { posts.push([p, b]); return p.includes("request-withdrawal") ? quote : {}; },
    });
    await c.initiateWithdrawal(500);
    expect(posts[0]).toEqual(["/api/shop/valor/request-withdrawal", { valorAmount: "500" }]);
  });

  it("resumes an un-initiated pending quote instead of requesting a second one", async () => {
    const posts: any[] = [];
    const c = svc({
      get: async () => ({ pending: { ...quote, status: "PENDING", initiatedAt: null, valorAmount: "500" } }),
      post: async (p: string, b: any) => { posts.push([p, b]); return {}; },
    });
    const r = await c.initiateWithdrawal(500);
    expect(posts.map((p) => p[0])).toEqual(["/api/shop/valor/confirm-initiation"]);
    expect(r.netUsdc).toBe(5);
  });

  it("refuses when a withdrawal is already on chain", async () => {
    const c = svc({
      get: async () => ({ pending: { ...quote, status: "INITIATED", initiatedAt: "2026-09-20T00:00:00Z" } }),
      post: async () => ({}),
    });
    await expect(c.initiateWithdrawal(500)).rejects.toThrow(/already in progress/);
  });

  it("keeps the 500 VALOR minimum", async () => {
    await expect(svc({}).initiateWithdrawal(499)).rejects.toThrow(/minimum/);
  });
});
