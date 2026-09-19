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
  tracked: Record<string, { id: string; side: "BUY" | "SELL"; key: string; price: number; qty: number; name: string }> }

export class MarketMaker {
  busy = false; lastRunAt = 0; lastError: string | null = null;
  constructor(private api: MogApi, private store: Store, private notify: (t: string) => Promise<void> | void, private log: (m: string) => void) {}

  cfg(): MMConfig { return { ...DEFAULT_MM, ...this.store.get<Partial<MMConfig>>("mm.config", {}) }; }
  setCfg(p: Partial<MMConfig>) { const c = { ...this.cfg(), ...p }; this.store.set("mm.config", c); return c; }
  state(): MMState { return { pos: {}, realized: 0, fills: 0, pausedUntil: {}, lastSellPlaced: {}, seenActivity: [], halted: null, startedAt: Date.now(), selected: [], selectedAt: 0, scores: [], tracked: {}, ...this.store.get<Partial<MMState>>("mm.state", {}) }; }

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
    const id = r.order?.id ?? r.id ?? r.orderId;
    if (id && this.cur) this.cur.tracked[id] = { id, side, key: a.assetKey, price, qty: quantity, name: a.displayName };
    return r;
  }
  private cur: MMState | null = null;
  private async cancel(id: string) {
    const r = await this.api.request(`${B}/orders/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (this.cur) delete this.cur.tracked[id]; // we cancelled it: not a fill
    return r;
  }

  /** Primary fill detection: a tracked order that left the open list without us cancelling it was filled. */
  private async syncTracked(s: MMState, open: any[]) {
    const openIds = new Set(open.map((o) => o.id));
    // adopt open orders we did not track yet (e.g. placed before a restart) — this wallet only trades via the bot
    for (const o of open) if (!s.tracked[o.id]) s.tracked[o.id] = { id: o.id, side: o.side, key: o.assetKey, price: Number(o.price), qty: Number(o.quantity) - Number(o.filledQty ?? 0), name: o.asset?.displayName ?? o.assetKey };
    for (const t of Object.values(s.tracked)) {
      if (openIds.has(t.id)) continue;
      delete s.tracked[t.id];
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
        const pick = s.scores.filter((x) => x.score > 0).slice(0, cfg.maxAssets).map((x) => x.key);
        if (pick.join() !== s.selected.join()) {
          s.selected = pick;
          await this.notify(`🧠 <b>Market: pilihan item diperbarui</b>\n${s.scores.filter((x) => x.score > 0).slice(0, cfg.maxAssets).map((x) => `◦ ${x.name}: edge ${Math.round(x.edge)} VALOR (${(x.edgePct * 100).toFixed(0)}%) · ${Math.round(x.unitsPerDay)} unit/hari`).join("\n") || "◦ tidak ada item yang layak saat ini — menunggu"}`);
        }
      }
      const active = cfg.autoSelect ? s.selected : cfg.assets;
      const managed = [...new Set([...active, ...Object.entries(s.pos).filter(([, p]) => p.qty > 0).map(([k]) => k)])];
      const book = await this.summary();
      const orders = await this.myOrders();
      const inv = (await this.api.get("/api/items/balances")).balances ?? {};
      let valor = Number((await this.api.get("/api/shop/valor/balance")).valorBalance);
      // capital already committed = open BUY orders + inventory at cost
      const committed = () => orders.filter((o) => o.side === "BUY").reduce((t, o) => t + Number(o.price) * Number(o.quantity ?? 1), 0)
        + Object.values(s.pos).reduce((t, p) => t + p.cost * p.qty, 0);

      for (const key of managed) {
        const a = book.get(key); if (!a || !a.tradable) continue;
        const buyAllowed = active.includes(key);
        const bid = Number(a.highestBid ?? 0), ask = Number(a.lowestAsk ?? 0);
        const mine = orders.filter((o) => o.assetKey === key);
        const myBuy = mine.find((o) => o.side === "BUY"); const mySell = mine.find((o) => o.side === "SELL");
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
          if (!stillBest) { await this.cancel(myBuy.id); drop(); valor += Number(myBuy.price); this.store.event("info", `mm reprice ${key}: outbid at ${myBuy.price}, bid now ${bid}`); }
          else continue;
        }
        if (!edgeOk) continue;
        if (committed() + buyAt > cfg.capitalValor || valor < buyAt) continue;
        const r = await this.place("BUY", a, buyAt, 1);
        valor -= buyAt;
        if (!myBuy) await this.notify(`📝 <b>Market: ORDER BELI</b> 1 × ${a.displayName} @ ${buyAt} VALOR (target jual ~${sellAt}, edge +${Math.round(edge)})`);
        void r;
      }
      this.lastError = null;
    } catch (e: any) {
      this.lastError = String(e?.message ?? e); this.log(`mm error: ${this.lastError}`); this.store.event("warn", `mm: ${this.lastError}`);
    } finally { this.save(s); this.busy = false; }
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
    return { cfg, state: s, lines, unrealized: Math.round(unreal) };
  }
}
