import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/** Every inline button must have a handler: a dead button is silent and easy to ship by accident. */
describe("telegram buttons", () => {
  it("every callback_data is handled", () => {
    const s = readFileSync("src/telegram/bot.ts", "utf8");
    const used = new Set<string>();
    for (const m of s.matchAll(/\.text\(\s*(?:`[^`]*`|"[^"]*")\s*,\s*(?:`([^`]*)`|"([^"]*)")\s*\)/g))
      used.add((m[1] ?? m[2]).replace(/\$\{[^}]+\}/g, "1"));
    const literals = new Set([...s.matchAll(/bot\.callbackQuery\("([^"]+)"/g)].map((m) => m[1]));
    const regexes = [...s.matchAll(/bot\.callbackQuery\(\/(\^.*?\$)\//g)].map((m) => new RegExp(m[1]));
    const missing = [...used].filter((d) => !literals.has(d) && !regexes.some((r) => r.test(d)));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(50);
  });
});
