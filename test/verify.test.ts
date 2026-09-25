import { describe, it, expect, vi } from "vitest";
import { TwoCaptcha, GameVerifier } from "../src/mog/verify.js";

/**
 * Turnstile game-verification gate (live-verified 2026-09-25):
 *   GET  /api/game-verification -> { mode, siteKey, expiresAt }
 *   POST /api/game-verification {token} -> same shape
 * The verifier reads the live siteKey, solves via 2captcha, and posts the token so the gated call can retry.
 */

// TwoCaptcha with instant polling (no real network / no real waits).
const fastSolver = (token: string, submit = { status: 1, request: "job-1" }) => {
  const c = new TwoCaptcha("k", {});
  (c as any).postForm = async () => submit;
  (c as any).getJson = async () => ({ status: 1, request: token });
  return c;
};

describe("TwoCaptcha.solveTurnstile", () => {
  it("returns the token when 2captcha resolves the job", async () => {
    vi.useFakeTimers();
    const c = fastSolver("TS_TOKEN");
    const p = c.solveTurnstile({ sitekey: "0x4AAA", pageurl: "https://playmog.xyz", action: "gameplay" });
    await vi.runAllTimersAsync();
    expect(await p).toBe("TS_TOKEN");
    vi.useRealTimers();
  });

  it("throws when submission is rejected", async () => {
    const c = fastSolver("x", { status: 0, request: "ERROR_WRONG_USER_KEY" } as any);
    await expect(c.solveTurnstile({ sitekey: "s", pageurl: "u" })).rejects.toThrow(/ERROR_WRONG_USER_KEY/);
  });
});

describe("GameVerifier.ensure", () => {
  it("solves and posts the live siteKey with action=gameplay, then no-ops on mode=off", async () => {
    const posted: any[] = [];
    const api: any = {
      raw: async (path: string, init: any = {}) => {
        if (init.method === "POST") { posted.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ mode: "enforce", siteKey: "0x4AAA_live", expiresAt: Date.now() + 6e5 }) }; }
        return { ok: true, json: async () => ({ mode: "enforce", siteKey: "0x4AAA_live", expiresAt: null }) };
      },
    };
    const solver: any = { solveTurnstile: vi.fn(async (p: any) => { expect(p.sitekey).toBe("0x4AAA_live"); expect(p.action).toBe("gameplay"); return "SOLVED"; }) };
    const v = new GameVerifier(api, solver, { pageurl: "https://playmog.xyz", action: "gameplay" });
    await v.ensure();
    expect(solver.solveTurnstile).toHaveBeenCalledOnce();
    expect(posted).toEqual([{ token: "SOLVED" }]);
  });

  it("does nothing when mode=off", async () => {
    const solver: any = { solveTurnstile: vi.fn() };
    const api: any = { raw: async () => ({ ok: true, json: async () => ({ mode: "off", siteKey: null, expiresAt: null }) }) };
    await new GameVerifier(api, solver).ensure();
    expect(solver.solveTurnstile).not.toHaveBeenCalled();
  });

  it("de-duplicates concurrent solves into one Turnstile job", async () => {
    let solves = 0;
    const solver: any = { solveTurnstile: async () => { solves++; await new Promise((r) => setTimeout(r, 5)); return "T"; } };
    const api: any = { raw: async (_p: string, init: any = {}) => ({ ok: true, json: async () => (init.method === "POST" ? { mode: "enforce", siteKey: "s", expiresAt: 1 } : { mode: "enforce", siteKey: "s", expiresAt: null }) }) };
    const v = new GameVerifier(api, solver);
    await Promise.all([v.ensure(), v.ensure(), v.ensure()]);
    expect(solves).toBe(1);
  });
});
