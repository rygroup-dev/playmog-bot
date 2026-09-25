// Cloudflare Turnstile solver + MoG game-verification gate.
//
// Live-verified 2026-09-25 from the site bundle (chunk 3h19ek6wyoar0.js):
//   GET  /api/game-verification            -> { mode: "off"|"observe"|"enforce", siteKey: string|null, expiresAt: number|null }
//   POST /api/game-verification {token}     -> same shape; marks the SIWE session verified until `expiresAt`
//   Turnstile widget renders with { sitekey, action: "gameplay" } on https://playmog.xyz
// When a gated call ("/api/runs/create", "/api/runs/{id}/colyseus-token", world-eve actions...) is blocked it
// answers 403 GAME_VERIFICATION_REQUIRED; the client re-verifies then retries. We do the same, solving the
// Turnstile via 2captcha instead of a human.
import type { MogApi } from "./api.js";

const IN = "https://2captcha.com/in.php";
const RES = "https://2captcha.com/res.php";

export class TwoCaptchaError extends Error {}

/** Minimal 2captcha client for Cloudflare Turnstile (classic in.php/res.php API). */
export class TwoCaptcha {
  constructor(private key: string, private opts: { softId?: string; log?: (m: string) => void } = {}) {}

  /** Submit a Turnstile job and poll until the token is ready (or timeout). Returns the cf-turnstile-response token. */
  async solveTurnstile(p: { sitekey: string; pageurl: string; action?: string; timeoutMs?: number }): Promise<string> {
    const body = new URLSearchParams({ key: this.key, method: "turnstile", sitekey: p.sitekey, pageurl: p.pageurl, json: "1" });
    if (p.action) body.set("action", p.action);
    if (this.opts.softId) body.set("soft_id", this.opts.softId);
    const sub: any = await this.postForm(IN, body);
    if (String(sub.status) !== "1") throw new TwoCaptchaError(`2captcha submit rejected: ${sub.request ?? JSON.stringify(sub)}`);
    const id = String(sub.request);
    this.opts.log?.(`2captcha: turnstile job ${id} submitted`);

    const deadline = Date.now() + (p.timeoutMs ?? 150_000);
    await sleep(8_000); // Turnstile is rarely ready before this
    while (Date.now() < deadline) {
      const q = new URLSearchParams({ key: this.key, action: "get", id, json: "1" });
      const r: any = await this.getJson(`${RES}?${q}`);
      if (String(r.status) === "1") { this.opts.log?.(`2captcha: job ${id} solved`); return String(r.request); }
      if (r.request !== "CAPCHA_NOT_READY") throw new TwoCaptchaError(`2captcha error for job ${id}: ${r.request}`);
      await sleep(5_000);
    }
    throw new TwoCaptchaError(`2captcha: job ${id} timed out`);
  }

  private async postForm(url: string, body: URLSearchParams): Promise<unknown> {
    const r = await fetch(url, { method: "POST", body, signal: AbortSignal.timeout(30_000) });
    return r.json();
  }
  private async getJson(url: string): Promise<unknown> {
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    return r.json();
  }
}

export interface VerifyConfig { mode: "off" | "observe" | "enforce"; siteKey: string | null; expiresAt: number | null }

/**
 * Drives /api/game-verification for an authenticated MogApi. `ensure()` is called reactively when a gated
 * endpoint answers GAME_VERIFICATION_REQUIRED: it reads the live siteKey, solves the Turnstile, and posts the
 * token so the retry of the original request goes through. In-flight solves are de-duplicated so parallel
 * gated calls (create + colyseus-token) share one Turnstile solve.
 */
export class GameVerifier {
  private inFlight: Promise<void> | null = null;
  constructor(
    private api: MogApi,
    private solver: TwoCaptcha,
    private opts: { pageurl?: string; action?: string; log?: (m: string) => void } = {},
  ) {}

  ensure(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async run(): Promise<void> {
    const cfg = await this.getConfig();
    if (cfg.mode === "off") { this.opts.log?.("mog: verification mode=off, nothing to solve"); return; }
    if (!cfg.siteKey) throw new TwoCaptchaError(`game-verification returned no siteKey (mode=${cfg.mode})`);
    const pageurl = this.opts.pageurl ?? "https://playmog.xyz";
    this.opts.log?.(`mog: solving Turnstile (mode=${cfg.mode}, sitekey=${cfg.siteKey.slice(0, 12)}…)`);
    const token = await this.solver.solveTurnstile({ sitekey: cfg.siteKey, pageurl, action: this.opts.action ?? "gameplay" });
    const after = await this.postToken(token);
    this.opts.log?.(`mog: verification accepted (mode=${after.mode}, expiresAt=${after.expiresAt ?? "?"})`);
  }

  private async getConfig(): Promise<VerifyConfig> {
    const r = await this.api.raw("/api/game-verification");
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new TwoCaptchaError(`GET /api/game-verification failed: ${r.status}`);
    return j as VerifyConfig;
  }
  private async postToken(token: string): Promise<VerifyConfig> {
    const r = await this.api.raw("/api/game-verification", { method: "POST", body: JSON.stringify({ token }) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new TwoCaptchaError(`POST /api/game-verification rejected: ${r.status} ${JSON.stringify(j)?.slice(0, 160)}`);
    return j as VerifyConfig;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
