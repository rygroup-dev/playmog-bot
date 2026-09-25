// Authenticated HTTP client for playmog.xyz. SIWE login -> `siwe-session` cookie (7d).
import type { PrivateKeyAccount } from "viem/accounts";

export const MOG_BASE = "https://playmog.xyz";
export let APP_VERSION = process.env.MOG_APP_VERSION ?? "24";
/** Follow the live client version (GameWatch / CLIENT_OUTDATED self-heal). */
export function setAppVersion(v: string) { APP_VERSION = v; }

/** Read the live client's APP_VERSION from the site bundle (used when the server says CLIENT_OUTDATED). */
export async function detectAppVersion(): Promise<string | null> {
  try {
    const html = await (await fetch(MOG_BASE + "/", { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20_000) })).text();
    const chunks = [...new Set(html.match(/\/_next\/static\/immutable\/chunks\/[A-Za-z0-9_-]+\.js/g) ?? [])];
    for (const c of chunks) {
      const js = await (await fetch(MOG_BASE + c, { signal: AbortSignal.timeout(20_000) })).text().catch(() => "");
      const m = js.match(/APP_VERSION",0,(\d+)/); if (m) return m[1];
    }
  } catch { /* offline */ }
  return null;
}
export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

export class MogApiError extends Error {
  constructor(public status: number, public code: string | null, message: string, public body?: unknown) { super(message); this.name = "MogApiError"; }
}

export class MogApi {
  private cookies = new Map<string, string>();
  private loginInFlight: Promise<void> | null = null;
  private versionRefreshed = false;
  private verifier: (() => Promise<void>) | null = null;
  constructor(private account: PrivateKeyAccount, private opts: { timeoutMs?: number; log?: (m: string) => void } = {}) {}

  get address() { return this.account.address; }
  hasSession() { return this.cookies.has("siwe-session"); }

  /** Register the game-verification solver (2captcha Turnstile). Called with the token-solving routine that
   *  runs when a gated endpoint answers 403 GAME_VERIFICATION_REQUIRED; the request is retried after it resolves. */
  setVerifier(fn: (() => Promise<void>) | null) { this.verifier = fn; }

  /** Unauthenticated fetch against the game host (used for the login nonce and the wallet-link nonce). */
  async raw(path: string, init: RequestInit = {}) {
    const h = new Headers(init.headers);
    h.set("user-agent", UA); h.set("origin", MOG_BASE); h.set("referer", MOG_BASE + "/");
    h.set("X-App-Version", APP_VERSION); h.set("x-mog-version", "v2"); h.set("X-Client-Send-Time", String(Date.now()));
    if (init.body && !h.has("content-type")) h.set("content-type", "application/json");
    if (this.cookies.size) h.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const r = await fetch(MOG_BASE + path, { ...init, headers: h, redirect: "manual", signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000) });
    for (const c of r.headers.getSetCookie()) {
      const kv = c.split(";")[0]; const i = kv.indexOf("=");
      const v = kv.slice(i + 1);
      if (!v || /max-age=0/i.test(c)) this.cookies.delete(kv.slice(0, i)); else this.cookies.set(kv.slice(0, i), v);
    }
    return r;
  }

  async login() {
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = (async () => {
      this.cookies.clear();
      const nr = await this.raw("/api/auth/nonce");
      const nonce = (await nr.text()).trim();
      if (!nr.ok || !/^[0-9a-f]{16,}$/i.test(nonce)) throw new MogApiError(nr.status, null, `nonce failed: ${nonce.slice(0, 120)}`);
      const now = new Date(); const exp = new Date(now.getTime() + 7 * 864e5);
      const message = `playmog.xyz wants you to sign in with your Ethereum account:\n${this.account.address}\n\nSign in with Ethereum to the app.\n\nURI: https://playmog.xyz\nVersion: 1\nChain ID: 2741\nNonce: ${nonce}\nIssued At: ${now.toISOString()}\nExpiration Time: ${exp.toISOString()}`;
      const signature = await this.account.signMessage({ message });
      const vr = await this.raw("/api/auth/verify", { method: "POST", body: JSON.stringify({ message, signature, walletKind: "EXTERNAL" }) });
      const vj = await vr.json().catch(() => null);
      if (!vr.ok || !vj?.ok) throw new MogApiError(vr.status, vj?.error?.code ?? null, `SIWE verify failed: ${JSON.stringify(vj)}`);
      this.opts.log?.("mog: logged in");
      // first login: the game requires a username before any other endpoint works
      const me = await (await this.raw("/api/auth/user")).json().catch(() => null);
      if (me?.requiresUsername) {
        const username = process.env.MOG_USERNAME;
        if (!username) this.opts.log?.("mog: account has no username yet — set MOG_USERNAME in .env (3-20 chars) and restart");
        else {
          const r = await this.raw("/api/profile/username", { method: "PUT", body: JSON.stringify({ username }) });
          this.opts.log?.(r.ok ? `mog: username set to ${username}` : `mog: username rejected (${r.status}) — pick another MOG_USERNAME`);
        }
      }
    })().finally(() => { this.loginInFlight = null; });
    return this.loginInFlight;
  }

  /** JSON request with auto-login, 401 re-login and retry on network/5xx/429 for idempotent calls. */
  async request<T = any>(path: string, init: RequestInit & { retry?: boolean } = {}): Promise<T> {
    if (!this.hasSession()) await this.login();
    const method = (init.method ?? "GET").toUpperCase();
    const retries = (init.retry ?? method === "GET") ? 3 : 0;
    let relogged = false;
    let reverified = false;
    for (let attempt = 0; ; attempt++) {
      let r: Response;
      try { r = await this.raw(path, init); }
      catch (e) { if (attempt < retries) { await sleep(400 * 2 ** attempt); continue; } throw e; }
      if (r.status === 401 && !relogged) { relogged = true; await this.login(); attempt--; continue; }
      if ((r.status >= 500 || r.status === 429) && attempt < retries) { await sleep((r.status === 429 ? 2000 : 400) * 2 ** attempt); continue; }
      const text = await r.text();
      let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      if (!r.ok) {
        const code = body?.error?.code ?? (typeof body?.error === "string" ? body.error : null);
        // The game gates create-run / room-join / world-eve actions behind a Cloudflare Turnstile human check.
        // When set, solve it via 2captcha and retry the original request once (mirrors the site client's re-verify).
        if (code === "GAME_VERIFICATION_REQUIRED" && this.verifier && !reverified) {
          reverified = true;
          try { await this.verifier(); attempt--; continue; }
          catch (ve: any) { this.opts.log?.(`mog: game verification failed: ${ve?.message ?? ve}`); }
        }
        if (code === "CLIENT_OUTDATED" && !this.versionRefreshed) {
          this.versionRefreshed = true;
          const v = await detectAppVersion();
          if (v && v !== APP_VERSION) { this.opts.log?.(`mog: client version ${APP_VERSION} -> ${v}`); APP_VERSION = v; attempt--; continue; }
        }
        throw new MogApiError(r.status, code, `${method} ${path} -> ${r.status} ${code ?? ""} ${body?.error?.message ?? (typeof body === "string" ? body.slice(0, 200) : "")}`.trim(), body);
      }
      return body as T;
    }
  }
  get<T = any>(path: string) { return this.request<T>(path); }
  post<T = any>(path: string, body?: unknown, opts: { retry?: boolean } = {}) {
    return this.request<T>(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...opts });
  }
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
