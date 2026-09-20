#!/usr/bin/env node
// Mines data/runs/*.jsonl (one line per turn, written by src/game/runner.ts) and prints the numbers the
// policy is tuned against. Every constant in src/game/value.ts that cites a measurement comes from here.
//
//   node scripts/analyze-runs.mjs [dir]
//
// The four questions it answers:
//   1. win rate and where runs end        — is the bot dying, and on which floor?
//   2. energy in vs out per mode          — runs end at energy ~1, so this is the actual survival metric
//   3. net energy per pickup type chased  — which drops pay for the walk and which are pure loss
//   4. energy banked entering each floor  — what separates a completed run from a dead one
import { readFileSync, readdirSync } from "node:fs";

const dir = process.argv[2] ?? "data/runs";
const runs = [];
for (const f of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
  const turns = [];
  let over = null, runType = "?";
  for (const line of readFileSync(`${dir}/${f}`, "utf8").trim().split("\n")) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    turns.push(r);
    for (const e of r.events ?? []) if (e.type === "game_over") { over = e; runType = e.finalStats?.runType ?? runType; }
  }
  if (turns.length) runs.push({ file: f, turns, over, runType, won: over?.reason === "completed" });
}
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : "0.0") + "%";
const sum = (a) => a.reduce((x, y) => x + y, 0);
const avg = (a) => (a.length ? sum(a) / a.length : 0);
const energyOrb = (t) => /energy_orb/.test(t ?? "");

console.log(`\n=== 1. hasil run (${runs.length} log di ${dir}) ===`);
const byMode = {};
for (const r of runs) {
  const m = (byMode[r.runType] ??= { n: 0, won: 0, ends: {} });
  m.n++; if (r.won) m.won++;
  const floor = r.turns[r.turns.length - 1]?.floor ?? 0;
  if (!r.won) m.ends[floor] = (m.ends[floor] ?? 0) + 1;
}
for (const [mode, m] of Object.entries(byMode).sort()) {
  const worst = Object.entries(m.ends).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f, n]) => `f${f}:${n}`).join(" ");
  console.log(`  ${mode.padEnd(11)} ${String(m.n).padStart(3)} run · menang ${m.won} (${pct(m.won, m.n)}) · mati terbanyak di ${worst || "-"}`);
}

console.log("\n=== 2. ekonomi energy per mode (garis hidup-mati ada di rasio 1.0) ===");
const eco = {};
for (const r of runs) {
  const k = `${r.runType} ${r.won ? "MENANG" : "mati"}`;
  const e = (eco[k] ??= { runs: 0, out: 0, in: 0 });
  e.runs++;
  for (const t of r.turns) for (const ev of t.events ?? []) {
    if (ev.energyCost > 0) e.out += ev.energyCost;
    if (ev.type === "pickup_collected" && energyOrb(ev.pickupType)) e.in += ev.value ?? 0;
  }
}
for (const [k, e] of Object.entries(eco).sort())
  console.log(`  ${k.padEnd(20)} ${String(e.runs).padStart(3)} run · keluar ${String(e.out).padStart(5)} · masuk ${String(e.in).padStart(5)} · rasio ${(e.in / (e.out || 1)).toFixed(2)}`);

console.log("\n=== 3. net energy per jenis drop yang dikejar ===");
const chase = {};
for (const r of runs) {
  let walked = 0;
  for (const t of r.turns) {
    const isChase = /pickup|orb|loot|grab|drop/i.test(t.reason ?? "");
    const cost = sum((t.events ?? []).map((e) => e.energyCost ?? 0));
    walked = isChase ? walked + cost : 0;
    const got = (t.events ?? []).filter((e) => e.type === "pickup_collected");
    for (const g of got) {
      const c = (chase[g.pickupType] ??= { n: 0, gained: 0, steps: 0 });
      c.n++;
      c.gained += energyOrb(g.pickupType) ? g.value ?? 0 : 0;
      c.steps += walked / got.length;
    }
    if (got.length) walked = 0;
  }
}
console.log("  jenis                  jml   didapat   jalan     NET");
for (const [t, c] of Object.entries(chase).sort((a, b) => b[1].steps - a[1].steps)) {
  const net = Math.round(c.gained - c.steps);
  console.log(`  ${t.padEnd(20)} ${String(c.n).padStart(5)} ${String(Math.round(c.gained)).padStart(9)} ${String(Math.round(c.steps)).padStart(7)} ${(net >= 0 ? "+" : "") + net}`);
}

console.log("\n=== 4. energy saat MASUK floor (sumber ENTRY_RESERVE di value.ts) ===");
const entry = { won: {}, lost: {} };
for (const r of runs) {
  const tgt = r.won ? entry.won : entry.lost;
  let cur = 0;
  for (const t of r.turns) if (t.floor && t.floor !== cur) { cur = t.floor; (tgt[cur] ??= []).push(t.energy ?? 0); }
}
const show = (a) => (a?.length ? `${Math.round(avg(a))} (min ${Math.min(...a)}, n=${a.length})` : "-");
for (let f = 1; f <= 10; f++)
  console.log(`  f${String(f).padStart(2)}  MENANG ${show(entry.won[f]).padEnd(24)} MATI ${show(entry.lost[f])}`);
console.log();
