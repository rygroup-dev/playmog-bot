// Presentation helpers for a consistent "premium" Telegram look (HTML parse mode).
export const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const num = (n: number | undefined | null, d = 0) => Number(n ?? 0).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
export const usd = (n: number | undefined | null, d = 2) => `$${num(n, d)}`;

export const LINE = "━━━━━━━━━━━━━━━━━━━━";
export const header = (icon: string, title: string, sub?: string) => `${icon} <b>${esc(title)}</b>${sub ? `  <i>${esc(sub)}</i>` : ""}\n${LINE}`;
export const section = (title: string) => `\n<b>▸ ${esc(title)}</b>`;
export const row = (label: string, value: string) => `  ◦ ${label}: ${value}`;
export const on = (b: boolean) => (b ? "🟢 ON" : "⚫️ OFF");
export const check = (b: boolean) => (b ? "✅" : "▫️");

/** ▰▰▰▱▱ style bar; ratio clamped to [0,1] */
export function bar(value: number, max: number, width = 10) {
  const r = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(r * width);
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}
export function ago(ts?: number | null) {
  if (!ts) return "-";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s} dtk lalu` : s < 3600 ? `${Math.round(s / 60)} mnt lalu` : s < 86400 ? `${Math.round(s / 3600)} jam lalu` : `${Math.round(s / 86400)} hari lalu`;
}
export function until(t?: string | number | null) {
  if (!t) return "-";
  const ms = new Date(t).getTime() - Date.now();
  if (ms <= 0) return "sekarang";
  const m = Math.floor(ms / 60e3), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d > 0 ? `${d} hari ${h % 24} jam` : h > 0 ? `${h} jam ${m % 60} mnt` : `${m} mnt`;
}
export const utcNow = () => new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const pre = (lines: string[]) => `<pre>${esc(lines.join("\n"))}</pre>`;
export const footer = (s: string) => `\n<i>${esc(s)}</i>`;
