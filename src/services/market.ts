// Market-making pilot on the MoG marketplace (VALOR-denominated, off-chain order book).
// API mirrors the official client: /api/mog/marketplace/{assets/summary,book,trades,orders,orders/mine,activity,fee-config}
// Fees (live fee-config): listing 1% (min 1 VALOR) charged when a SELL is placed, success 4% on the sale.
import { randomUUID } from "node:crypto";
import { MogApi } from "../mog/api.js";
import { Store } from "../db.js";

const B = "/api/mog/marketplace";
export interface MMConfig {
  enabled: boolean; assets: string[]; capitalValor: number; maxUnitsPerAsset: number;
  minEdgeValor: number; minEdgePct: number; stopLossPct: number; maxLossValor: number; sellRepriceMinutes: number;
  autoSelect: boolean; maxAssets: number; minUnitsPerDay: number;
}
export const DEFAULT_MM: MMConfig = {
  enabled: false, assets: ["gacha.gold", "energy.large"], capitalValor: 1500, maxUnitsPerAsset: 1,
  minEdgeValor: 20, minEdgePct: 0.05, stopLossPct: 0.10, maxLossValor: 300, sellRepriceMinutes: 30,
  autoSelect: true, maxAssets: 2, minUnitsPerDay: 50,
};
export interface AssetScore { key: string; name: string; bid: number; ask: number; edge: number; edgePct: number; unitsPerDay: number; usdPerDay: number;
  buyers: number; volatility: number; trendPct: number; score: number; reason: string }
const LISTING = 0.01, SUCCESS = 0.04;
const netOfSale = (price: number) => price - Math.max(1, Math.floor(price * LISTING)) - Math.floor(price * SUCCESS);

interface Pos { qty: number; cost: number; since: number } // cost = VALOR paid per unit (avg)
interface MMState { pos: Record<string, Pos>; realized: number; fills: number; pausedUntil: Record<string, number>; lastSellPlaced: Record<string, number>;
  seenActivity: string[]; halted: string | null; startedAt: number; selected: string[]; selectedAt: number; scores: AssetScore[];
  tracked: Record<string, { id: string; side: "BUY" | "SELL"; key: string; price: number; qty: number; name: string; loot?: boolean }>;
  lootListedAt: Record<string, number>; serverPausedUntil?: number;
  outbids: Record<string, number[]>; wars?: Record<string, number[]> }

export class MarketMaker {
  busy = false; lastRunAt = 0; lastError: string | null = null;
  constructor(private api: MogApi, private store: Store, private notify: (t: string) => Promise<void> | void, private log: (m: string) => void) {}

  cfg(): MMConfig { return { ...DEFAULT_MM, ...this.store.get<Partial<MMConfig>>("mm.config", {}) }; }
  setCfg(p: Partial<MMConfig>) { const c = { ...this.cfg(), ...p }; this.store.set("mm.config", c); return c; }
  state(): MMState { return { pos: {}, realized: 0, fills: 0, pausedUntil: {}, lastSellPlaced: {}, seenActivity: [], halted: null, startedAt: Date.now(), selected: [], selectedAt: 0, scores: [], tracked: {}, outbids: {}, lootListedAt: {}, ...this.store.get<Partial<MMState>>("mm.state", {}) }; }

  /**
   * Smart selection: score every tradable asset from live data — net edge after fees at best bid+1 / ask-1,
   * real throughput (units/day from the last 100 trades), distinct buyers, price volatility and trend.
   * Falling prices (trend < -8%) and thin or unaffordable books are rejected.
   */
  async scoreAssets(cfg: MMConfig): Promise<AssetScore[]> {
    const assets: any[] = (await this.api.get(`${B}/assets/summary`)).assets ?? [];
    const out: AssetScore[] = [];
    for (const a of assets) {
      if (!a.tradable || !a.highestBid || !a.lowestAsk) continue;
      const bid = Number(a.highestBid), ask = Number(a.lowestAsk);
      const edge = netOfSale(ask - 1) - (bid + 1), edgePct = edge / (bid + 1);
      const t: any = await this.api.get(`${B}/trades?assetKey=${a.assetKey}&assetType=${a.assetType}&limit=100`).catch(() => ({ trades: [] }));
      const tr: any[] = t.trades ?? [];
      if (tr.length < 5) { out.push({ key: a.assetKey, name: a.displayName, bid, ask, edge, edgePct, unitsPerDay: 0, usdPerDay: 0, buyers: 0, volatility: 0, trendPct: 0, score: 0, reason: "terlalu sepi" }); continue; }
      const hrs = Math.max(1, (new Date(tr[0].createdAt).getTime() - new Date(tr.at(-1).createdAt).getTime()) / 3600e3);
      const units = tr.reduce((s2, x) => s2 + Number(x.quantity), 0), unitsPerDay = units / (hrs / 24);
      const usdPerDay = tr.reduce((s2, x) => s2 + Number(x.totalValor), 0) / 100 / (hrs / 24);
      const prices = tr.map((x) => Number(x.price)); const mean = prices.reduce((s2, x) => s2 + x, 0) / prices.length;
      const volatility = Math.sqrt(prices.reduce((s2, x) => s2 + (x - mean) ** 2, 0) / prices.length) / mean;
      const n = Math.max(3, Math.floor(prices.length / 4));
      const recent = prices.slice(0, n).reduce((s2, x) => s2 + x, 0) / n, older = prices.slice(-n).reduce((s2, x) => s2 + x, 0) / n;
      const trendPct = (recent - older) / older;
      const buyers = new Set(tr.map((x) => x.buyerUsername)).size;
      let reason = "ok";
      if (bid + 1 > cfg.capitalValor * 0.7) reason = "harga > modal";
      else if (edge < Math.max(cfg.minEdgeValor, (bid + 1) * cfg.minEdgePct)) reason = "spread tipis";
      else if (unitsPerDay < cfg.minUnitsPerDay) reason = "kurang laku";
      else if (trendPct < -0.08) reason = "harga turun";
      else if (volatility > 0.25) reason = "terlalu volatil";
      else if (buyers < 8) reason = "pembeli sedikit";
      // expected profit/day if we win a small slice of the flow, penalised by risk
      const score = reason === "ok" ? edge * Math.min(unitsPerDay, 400) ** 0.5 * (1 - volatility) * (1 + Math.min(0, trendPct)) : 0;
      out.push({ key: a.assetKey, name: a.displayName, bid, ask, edge, edgePct, unitsPerDay, usdPerDay, buyers, volatility, trendPct, score, reason });
    }
    return out.sort((x, y) => y.score - x.score);
  }
  private save(s: MMState) { s.seenActivity = s.seenActivity.slice(-300); this.store.set("mm.state", s); }

  async summary() {
    const assets: any[] = (await this.api.get(`${B}/assets/summary`)).assets ?? [];
    return new Map(assets.map((a) => [a.assetKey, a]));
  }
  async myOrders(): Promise<any[]> {
    const r = await this.api.get(`${B}/orders/mine?status=ALL_OPEN&limit=50`);
    return r.orders ?? [];
  }
  private async place(side: "BUY" | "SELL", a: any, price: number, quantity = 1) {
    const r = await this.api.post(`${B}/orders`, { side, timeInForce: "GTC", assetKey: a.assetKey, assetType: a.assetType, assetId: a.assetId ?? null, price, quantity, idempotencyKey: randomUUID() });
    this.store.event("info", `mm ${side} ${a.assetKey} @${price} → fills ${JSON.stringify(r.fills?.length ?? 0)}`);
    await this.setStatus("gtc", true);
    const id = r.order?.id ?? r.id ?? r.orderId;
    if (id && this.cur) this.cur.tracked[id] = { id, side, key: a.assetKey, price, qty: quantity, name: a.displayName };
    return r;
  }
  private cur: MMState | null = null;
  /** Orders placed to BUY FOR USE (Eve Keys, probes): never adopted or booked as market-making fills. */
  private ownUse = new Set<string>();

  /** Live marketplace availability, detected separately for limit orders (GTC) and instant buys (FOK). */
  status() { return { gtc: null as boolean | null, fok: null as boolean | null, gtcAt: 0, fokAt: 0, ...this.store.get<any>("market.status", {}) }; }
  async setStatus(kind: "gtc" | "fok", open: boolean) {
    const st = this.status(); if (st[kind] === open) return;
    const known = st[kind] !== null;
    this.store.set("market.status", { ...st, [kind]: open, [kind + "At"]: Date.now() });
    this.store.event(open ? "info" : "warn", `market ${kind} ${open ? "OPEN" : "CLOSED"} (server)`);
    if (!known && open) return; // first observation of a normal state: nothing to report
    const what = kind === "gtc" ? "Order limit (market-making, jual loot)" : "Beli instan (FOK)";
    await this.notify(open
      ? `🟢 <b>MARKET DIBUKA</b> — ${what} aktif lagi di server.${kind === "gtc" ? "\nMarket-making & jual loot lanjut otomatis." : "\nBeli Eve Key kembali pakai beli instan."}`
      : `🔴 <b>MARKET DITUTUP</b> — ${what} dimatikan server game (FEATURE_DISABLED).${kind === "gtc" ? "\nOrder lama tetap di buku; bot cek ulang tiap 5 menit." : "\nBeli Eve Key otomatis pindah ke order limit di harga ask."}`);
  }
  /** Zero-cost probes: FOK buy at 1 VALOR can never fill nor rest; a GTC probe (1 VALOR, cancelled at once) runs only while GTC is believed closed. */
  async probeStatus() {
    const a = (await this.summary()).get("key.world"); if (!a) return this.status();
    const body = (tif: string) => ({ side: "BUY", timeInForce: tif, assetKey: a.assetKey, assetType: a.assetType, assetId: a.assetId ?? null, price: 1, quantity: 1, idempotencyKey: randomUUID() });
    try { await this.api.post(`${B}/orders`, body("FOK")); await this.setStatus("fok", true); }
    catch (e: any) { if (e?.code === "FEATURE_DISABLED") await this.setStatus("fok", false); else throw e; }
    const s = this.status();
    if (s.gtc === false || (this.state().serverPausedUntil ?? 0) > Date.now()) {
      try {
        const r = await this.api.post(`${B}/orders`, body("GTC")); const id = r.order?.id ?? r.id ?? r.orderId;
        if (id) { this.ownUse.add(id); await this.api.request(`${B}/orders/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {}); }
        const st = this.state(); if (st.serverPausedUntil) { st.serverPausedUntil = 0; this.save(st); }
        await this.setStatus("gtc", true);
      } catch (e: any) { if (e?.code === "FEATURE_DISABLED") await this.setStatus("gtc", false); else throw e; }
    }
    return this.status();
  }
  private async cancel(id: string) {
    const r = await this.api.request(`${B}/orders/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (this.cur) delete this.cur.tracked[id]; // we cancelled it: not a fill
    return r;
  }

  /** Primary fill detection: a tracked order that left the open list without us cancelling it was filled. */
  private async syncTracked(s: MMState, open: any[]) {
    const openIds = new Set(open.map((o) => o.id));
    // adopt open orders we did not track yet (e.g. placed before a restart) — this wallet only trades via the bot
    for (const o of open) if (!s.tracked[o.id] && !this.ownUse.has(o.id)) s.tracked[o.id] = { id: o.id, side: o.side, key: o.assetKey, price: Number(o.price), qty: Number(o.quantity) - Number(o.filledQty ?? 0), name: o.asset?.displayName ?? o.assetKey, loot: o.side === "SELL" && !(s.pos[o.assetKey]?.qty > 0) };
    for (const t of Object.values(s.tracked)) {
      if (this.ownUse.has(t.id)) { delete s.tracked[t.id]; continue; }
      if (openIds.has(t.id)) continue;
      delete s.tracked[t.id];
      if (t.loot) { // our own run loot: separate books, no effect on market-making P&L
        const net = t.price * t.qty - Math.floor(t.price * t.qty * SUCCESS);
        this.store.ledger("loot_sell", net / 100, `${t.qty} ${t.key} @${t.price}`);
        await this.notify(`💰 <b>Loot terjual</b> ${t.qty} × ${t.name} @ ${t.price} VALOR → bersih <b>${net} VALOR</b> ($${(net / 100).toFixed(2)})`);
        continue;
      }
      const p = (s.pos[t.key] ??= { qty: 0, cost: 0, since: Date.now() });
      if (t.side === "BUY") {
        p.cost = (p.cost * p.qty + t.price * t.qty) / (p.qty + t.qty); p.qty += t.qty; p.since = Date.now(); s.fills++;
        this.store.ledger("mm_buy", (t.price * t.qty) / 100, `${t.qty} ${t.key} @${t.price}`);
        await this.notify(`🟢 <b>Market: TERBELI</b> ${t.qty} × ${t.name} @ ${t.price} VALOR — segera di-listing jual`);
      } else {
        const gross = t.price * t.qty, fee = Math.floor(gross * SUCCESS), net = gross - fee;
        const pnl = net - p.cost * t.qty; // listing fee was already booked when the SELL was placed
        s.realized += pnl; p.qty = Math.max(0, p.qty - t.qty); if (!p.qty) p.cost = 0; s.fills++;
        this.store.ledger("mm_sell", net / 100, `${t.qty} ${t.key} @${t.price} pnl ${Math.round(pnl)}`);
        await this.notify(`💰 <b>Market: TERJUAL</b> ${t.qty} × ${t.name} @ ${t.price} VALOR\nProfit trade: <b>${pnl >= 0 ? "+" : ""}${Math.round(pnl)} VALOR</b> (${pnl >= 0 ? "+" : ""}$${(pnl / 100).toFixed(2)}) · total realized <b>${Math.round(s.realized)} VALOR</b>`);
      }
    }
  }

  /** Apply fills from the activity feed to positions / realized PnL (idempotent via activity ids). */
  private async syncFills(s: MMState, cfg: MMConfig) {
    const r = await this.api.get(`${B}/activity?limit=50`);
    const acts: any[] = (r.activities ?? []).slice().reverse();
    if (acts.length) try { (await import("node:fs")).appendFileSync("data/mm_activity_raw.jsonl", acts.filter((a) => !s.seenActivity.includes(String(a.id))).map((a) => JSON.stringify(a)).join("\n") + "\n"); } catch { /* debug only */ }
    for (const a of acts) {
      const id = String(a.id ?? `${a.type}:${a.createdAt}`);
      if (s.seenActivity.includes(id)) continue;
      s.seenActivity.push(id);
      continue; // fills are booked by syncTracked (order tracking); activity kept as raw audit log only
      const m = a.metadata ?? a;
      const key = m.assetKey ?? a.assetKey; if (!key || !cfg.assets.includes(key)) continue;
      const qty = Number(m.quantity ?? 1), total = Number(m.totalValor ?? 0), fee = Number(m.feeValor ?? 0);
      const p = (s.pos[key] ??= { qty: 0, cost: 0, since: Date.now() });
      if (a.type === "ITEM_PURCHASED") {
        p.cost = (p.cost * p.qty + total) / Math.max(1, p.qty + qty); p.qty += qty; p.since = Date.now(); s.fills++;
        this.store.ledger("mm_buy", total / 100, `${qty} ${key} @${Math.round(total / qty)}`);
        await this.notify(`🟢 <b>Market: TERBELI</b> ${qty} × ${key} @ ${Math.round(total / qty)} VALOR — segera di-listing jual`);
      } else if (a.type === "ITEM_SOLD") {
        const net = total - fee; const pnl = net - p.cost * qty;
        s.realized += pnl; p.qty = Math.max(0, p.qty - qty); s.fills++;
        if (p.qty === 0) p.cost = 0;
        this.store.ledger("mm_sell", net / 100, `${qty} ${key} @${Math.round(total / qty)} pnl ${Math.round(pnl)}`);
        await this.notify(`💰 <b>Market: TERJUAL</b> ${qty} × ${key} @ ${Math.round(total / qty)} VALOR\nProfit trade: <b>${pnl >= 0 ? "+" : ""}${Math.round(pnl)} VALOR</b> (${pnl >= 0 ? "+" : ""}$${(pnl / 100).toFixed(2)}) · total realized <b>${Math.round(s.realized)} VALOR</b>`);
      }
    }
  }

  async tick() {
    const cfg = this.cfg();
    if (!cfg.enabled || this.busy) return;
    this.busy = true; this.lastRunAt = Date.now();
    const s = this.state(); this.cur = s;
    try {
      if (s.halted) return;
      if ((s.serverPausedUntil ?? 0) > Date.now()) return;
      if (s.serverPausedUntil) s.serverPausedUntil = 0; // re-opened: probeStatus / next successful order reports it
      await this.syncFills(s, cfg);
      await this.syncTracked(s, await this.myOrders());
      if (s.realized <= -cfg.maxLossValor) {
        s.halted = `loss limit hit (${Math.round(s.realized)} VALOR)`;
        for (const o of await this.myOrders()) if (o.side === "BUY") await this.cancel(o.id).catch(() => {});
        await this.notify(`🛑 <b>Market pilot dihentikan</b>: rugi mencapai batas (${Math.round(s.realized)} VALOR). Order beli dibatalkan.`);
        return;
      }
      if (cfg.autoSelect && Date.now() - s.selectedAt > 30 * 60e3) {
        s.scores = await this.scoreAssets(cfg); s.selectedAt = Date.now();
        const parked = (k: string) => (s.pausedUntil[k] ?? 0) - Date.now() > 60 * 60e3; // stop-loss / bid-war parking
        const pick = s.scores.filter((x) => x.score > 0 && !parked(x.key)).slice(0, cfg.maxAssets).map((x) => x.key);
        if (pick.join() !== s.selected.join()) {
          s.selected = pick;
          await this.notify(`🧠 <b>Market: pilihan item diperbarui</b>\n${s.scores.filter((x) => pick.includes(x.key)).map((x) => `◦ ${x.name}: edge ${Math.round(x.edge)} VALOR (${(x.edgePct * 100).toFixed(0)}%) · ${Math.round(x.unitsPerDay)} unit/hari`).join("\n") || "◦ tidak ada item yang layak saat ini — menunggu"}`);
        }
      }
      const active = cfg.autoSelect ? s.selected : cfg.assets;
      const book = await this.summary();
      const orders0 = await this.myOrders();
      // include assets that still hold our orders, so buys on deselected assets get cancelled (no orphaned capital)
      const managed = [...new Set([...active, ...Object.entries(s.pos).filter(([, p]) => p.qty > 0).map(([k]) => k), ...orders0.map((o) => o.assetKey)])];
      const orders = orders0;
      const inv = (await this.api.get("/api/items/balances")).balances ?? {};
      let valor = Number((await this.api.get("/api/shop/valor/balance")).valorBalance);
      // capital already committed = open BUY orders + inventory at cost
      const committed = () => orders.filter((o) => o.side === "BUY").reduce((t, o) => t + Number(o.price) * Number(o.quantity ?? 1), 0)
        + Object.values(s.pos).reduce((t, p) => t + p.cost * p.qty, 0);

      for (const key of managed) {
        const a = book.get(key); if (!a || !a.tradable) continue;
        if (!active.includes(key) && !(s.pos[key]?.qty > 0) && orders.filter((o) => o.assetKey === key).every((o) => s.tracked[o.id]?.loot)) continue; // loot-only asset
        const buyAllowed = active.includes(key);
        const bid = Number(a.highestBid ?? 0), ask = Number(a.lowestAsk ?? 0);
        const mine = orders.filter((o) => o.assetKey === key);
        const myBuy = mine.find((o) => o.side === "BUY"); const mySell = mine.find((o) => o.side === "SELL" && !s.tracked[o.id]?.loot);
        const held = Number(inv[key]?.balance ?? 0);
        const pos = (s.pos[key] ??= { qty: 0, cost: 0, since: Date.now() });
        if (held > pos.qty && pos.qty === 0 && !s.pos[key].cost) { /* pre-existing items not bought by us: ignore */ }

        // ---- SELL side: list what we hold, never below break-even unless stop-loss ----
        if (pos.qty > 0 && pos.cost > 0) {
          const floorPrice = Math.ceil((pos.cost + 1) / (1 - LISTING - SUCCESS));
          const stop = bid > 0 && bid < pos.cost * (1 - cfg.stopLossPct);
          // `ask` includes our own listing: if we already are the lowest ask, stay put (never undercut ourselves)
          const weAreBest = !!mySell && Number(mySell.price) <= ask;
          const target = stop ? Math.max(1, bid + 1) : Math.max(ask > 0 ? ask - 1 : floorPrice, floorPrice);
          if (weAreBest && !stop) { /* keep listing */ }
          else if (!mySell || Date.now() - (s.lastSellPlaced[key] ?? 0) > cfg.sellRepriceMinutes * 60e3) {
            if (mySell) { await this.cancel(mySell.id); const i = orders.indexOf(mySell); if (i >= 0) orders.splice(i, 1); }
            const qty = Math.min(pos.qty, held || pos.qty);
            if (qty > 0) {
              await this.place("SELL", a, target, qty); s.lastSellPlaced[key] = Date.now();
              const net = netOfSale(target) * qty;
              await this.notify(`🏷 <b>Market: LISTING JUAL</b> ${qty} × ${a.displayName} @ ${target} VALOR\nModal ${Math.round(pos.cost)} → bersih jika laku ${net} VALOR (<b>${net - Math.round(pos.cost * qty) >= 0 ? "+" : ""}${net - Math.round(pos.cost * qty)}</b>)`);
              s.realized -= Math.max(1, Math.floor(target * qty * LISTING)); // listing fee is charged at placement
            }
            if (stop) { s.pausedUntil[key] = Date.now() + 24 * 3600e3; await this.notify(`⚠️ Market stop-loss ${key}: harga turun >${cfg.stopLossPct * 100}% → dijual @${target}, jeda 24 jam`); }
          }
          continue; // one unit at a time: don't buy more while holding
        }

        // ---- BUY side ----
        if (!buyAllowed || (s.pausedUntil[key] ?? 0) > Date.now()) { if (myBuy) await this.cancel(myBuy.id); continue; }
        if (!(bid > 0 && ask > 0)) continue;
        const buyAt = bid + 1; const sellAt = ask - 1;
        const edge = netOfSale(sellAt) - buyAt;
        const edgeOk = edge >= Math.max(cfg.minEdgeValor, buyAt * cfg.minEdgePct);
        if (myBuy) {
          const stillBest = Number(myBuy.price) >= bid;
          const drop = () => { const i = orders.indexOf(myBuy); if (i >= 0) orders.splice(i, 1); }; // keep capital math current
          if (!edgeOk) { await this.cancel(myBuy.id); drop(); continue; }
          if (!stillBest) {
            // bid war with another bot (outbid +1 every tick): after 3 outbids in 10 min, step back for 20 min
            const hist = (s.outbids[key] ?? []).filter((t) => Date.now() - t < 10 * 60e3); hist.push(Date.now()); s.outbids[key] = hist;
            await this.cancel(myBuy.id); drop(); valor += Number(myBuy.price);
            if (hist.length >= 3) {
              // repeated wars on the same item never fill (the other bot always tops us by +1 and we only push the price up):
              // the 3rd war within 3 h parks the item for 3 h and hands its capital to the next-best item
              s.wars ??= {}; const wars = (s.wars[key] ?? []).filter((t) => Date.now() - t < 3 * 3600e3); wars.push(Date.now()); s.wars[key] = wars;
              const long = wars.length >= 3;
              s.pausedUntil[key] = Date.now() + (long ? 3 * 3600e3 : 20 * 60e3); s.outbids[key] = [];
              if (long) { s.wars[key] = []; s.selectedAt = 0; }
              this.store.event("info", `mm ${key}: bid war detected, backing off ${long ? "3 h (rotating to the next item)" : "20 min"}`);
              if (long) await this.notify(`⚔️ <b>Market: perang harga ${myBuy.asset?.displayName ?? key}</b> — bot lain selalu +1 di atas kita. Item diistirahatkan 3 jam, modalnya dipakai ke item lain.`);
              continue;
            }
            this.store.event("info", `mm reprice ${key}: outbid at ${myBuy.price}, bid now ${bid}`);
          }
          else continue;
        }
        if (!edgeOk) continue;
        if (committed() + buyAt > cfg.capitalValor || valor < buyAt) continue;
        const r = await this.place("BUY", a, buyAt, 1);
        valor -= buyAt;
        if (!myBuy) await this.notify(`📝 <b>Market: pasang order beli</b> (belum terbeli) 1 × ${a.displayName} @ ${buyAt} VALOR (target jual ~${sellAt}, edge +${Math.round(edge)})`);
        void r;
      }
      this.lastError = null;
    } catch (e: any) {
      this.lastError = String(e?.message ?? e); this.log(`mm error: ${this.lastError}`);
      if (e?.code === "FEATURE_DISABLED") {
        const first = !s.serverPausedUntil || s.serverPausedUntil < Date.now();
        s.serverPausedUntil = Date.now() + 15 * 60e3;
        void first; await this.setStatus("gtc", false);
      } else this.store.event("warn", `mm: ${this.lastError}`);
    } finally { this.save(s); this.busy = false; }
  }

  /** Instant buy (fill-or-kill) at the lowest ask if it is within maxPrice. Returns units filled. */
  /** Cancel every open order through our own bookkeeping, so cancelled orders are never mistaken for fills. */
  async cancelAll(): Promise<number> {
    const s = this.state(); this.cur = s;
    let n = 0;
    try {
      for (const o of await this.myOrders()) { try { await this.cancel(o.id); n++; } catch { /* keep going */ } }
      await this.syncTracked(s, await this.myOrders());
    } finally { this.save(s); this.cur = null; }
    return n;
  }

  /** Set when neither instant nor limit buys are accepted; in-memory so it never races the tick's saved state. */
  instantPausedUntil = 0;
  /**
   * Buy for USE (not market-making) at the lowest ask if within maxPrice. Instant (FOK) when the server allows it,
   * otherwise a GTC order at the ask (fills against it immediately; any unfilled rest is cancelled after 3 s).
   */
  async instantBuy(assetKey: string, maxPrice: number, quantity = 1): Promise<{ filled: number; price: number | null; paused?: boolean; via?: string }> {
    if (this.instantPausedUntil > Date.now() || (this.state().serverPausedUntil ?? 0) > Date.now()) return { filled: 0, price: null, paused: true };
    const a = (await this.summary()).get(assetKey);
    if (!a?.lowestAsk || Number(a.lowestAsk) > maxPrice) return { filled: 0, price: a?.lowestAsk ? Number(a.lowestAsk) : null };
    const price = Number(a.lowestAsk);
    const order = (tif: string) => this.api.post(`${B}/orders`, { side: "BUY", timeInForce: tif, assetKey, assetType: a.assetType, assetId: a.assetId ?? null, price, quantity, idempotencyKey: randomUUID() });
    const book = (filled: number, via: string) => { if (filled) this.store.ledger("buy_item", (price * filled) / 100, `${filled} ${assetKey} @${price} (${via})`); return { filled, price, via }; };
    if (this.status().fok !== false) {
      try { const r = await order("FOK"); await this.setStatus("fok", true); return book((r.fills ?? []).reduce((t: number, f: any) => t + Number(f.quantity), 0), "instant"); }
      catch (e: any) { if (e?.code !== "FEATURE_DISABLED") throw e; await this.setStatus("fok", false); }
    }
    let r: any;
    try { r = await order("GTC"); await this.setStatus("gtc", true); }
    catch (e: any) {
      if (e?.code !== "FEATURE_DISABLED") throw e;
      this.instantPausedUntil = Date.now() + 5 * 60e3; await this.setStatus("gtc", false);
      return { filled: 0, price, paused: true };
    }
    const id = r.order?.id ?? r.id ?? r.orderId; if (id) this.ownUse.add(id);
    let filled = (r.fills ?? []).reduce((t: number, f: any) => t + Number(f.quantity), 0);
    if (filled < quantity && id) {
      await new Promise((res) => setTimeout(res, 3000));
      const o = (await this.myOrders()).find((x) => x.id === id);
      if (o) { await this.api.request(`${B}/orders/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {}); filled = Number(o.filledQty ?? filled); }
      else filled = quantity; // left the book without our cancel → filled
    }
    return book(filled, "limit");
  }

  /**
   * List our own run loot (Eve cache contents etc.) at best ask - 1, never below best bid + 1.
   * Skips assets the market-maker currently trades, keys we play with, and items kept on purpose.
   */
  async sellLoot(keep: string[] = ["key.world", "key.expedition", "pass.adventurer_mint", "item.golden_corn"]) {
    if ((this.state().serverPausedUntil ?? 0) > Date.now()) return;
    const s = this.state(); this.cur = s;
    try {
      const book = await this.summary(); const open = await this.myOrders();
      await this.syncTracked(s, open);
      const inv = (await this.api.get("/api/items/balances")).balances ?? {};
      const mmKeys = new Set([...(s.selected ?? []), ...Object.entries(s.pos).filter(([, p]) => p.qty > 0).map(([k]) => k)]);
      for (const [key, v] of Object.entries<any>(inv)) {
        const a = book.get(key); const held = Number(v.balance ?? 0);
        if (!a?.tradable || held <= 0 || keep.includes(key) || mmKeys.has(key) || v.soulbound) continue;
        const listing = open.find((o) => o.assetKey === key && o.side === "SELL");
        const bid = Number(a.highestBid ?? 0), ask = Number(a.lowestAsk ?? 0);
        const target = Math.max(ask ? ask - 1 : bid + 1, bid + 1);
        if (listing) {
          if (Number(listing.price) <= ask || Date.now() - (s.lootListedAt[key] ?? 0) < 2 * 3600e3) continue; // still best / reprice at most every 2h
          await this.cancel(listing.id);
        }
        if (target <= 1) continue;
        const r = await this.place("SELL", a, target, held);
        const id = r.order?.id ?? r.id ?? r.orderId; if (id && s.tracked[id]) s.tracked[id].loot = true;
        s.lootListedAt[key] = Date.now();
        await this.notify(`🏷 <b>Loot di-listing</b> ${held} × ${a.displayName} @ ${target} VALOR (≈$${((target * held) / 100).toFixed(2)})`);
      }
    } finally { this.save(s); }
  }

  /** Snapshot for dashboards. */
  async report() {
    const cfg = this.cfg(); const s = this.state();
    const [book, orders] = await Promise.all([this.summary(), this.myOrders().catch(() => [])]);
    let unreal = 0;
    const keys = [...new Set([...(cfg.autoSelect ? s.selected : cfg.assets), ...Object.entries(s.pos).filter(([, p]) => p.qty > 0).map(([k]) => k)])];
    const lines = keys.map((k) => {
      const a = book.get(k); const p = s.pos[k] ?? { qty: 0, cost: 0 };
      if (p.qty && a?.highestBid) unreal += (netOfSale(Number(a.lowestAsk ?? a.highestBid) - 1) - p.cost) * p.qty;
      return { key: k, name: a?.displayName ?? k, bid: a?.highestBid, ask: a?.lowestAsk, qty: p.qty, cost: Math.round(p.cost), orders: orders.filter((o) => o.assetKey === k).map((o) => `${o.side}@${o.price}`), paused: (s.pausedUntil[k] ?? 0) > Date.now() };
    });
    // every open order, including loot listings for assets we do not market-make, so the UI can show what is on sale
    const open = orders.map((o: any) => {
      const a = book.get(o.assetKey); const price = Number(o.price); const qty = Number(o.quantity) - Number(o.filledQty ?? 0);
      const cost = s.pos[o.assetKey]?.cost ?? 0;
      return { id: o.id, side: o.side as "BUY" | "SELL", key: o.assetKey, name: a?.displayName ?? o.assetKey, price, qty,
        bid: Number(a?.highestBid ?? 0), ask: Number(a?.lowestAsk ?? 0), ageMin: Math.round((Date.now() - Date.parse(o.createdAt)) / 60000),
        best: o.side === "BUY" ? price >= Number(a?.highestBid ?? 0) : price <= Number(a?.lowestAsk ?? 0),
        net: o.side === "SELL" ? netOfSale(price) * qty : 0, profit: o.side === "SELL" ? Math.round((netOfSale(price) - cost) * qty) : 0,
        loot: !!s.tracked[o.id]?.loot };
    });
    return { cfg, state: s, lines, open, unrealized: Math.round(unreal) };
  }
}
