import { describe, it, expect } from "vitest";
import { MarketMaker, DEFAULT_MM } from "../src/services/market.js";

/**
 * capitalValor 0 means "no cap", because the real limit is maxAssets x maxUnitsPerAsset at the going bid.
 * It cannot be left to fall through as a plain number: the three places that use it are all upper bounds,
 * so a literal 0 would read as "nothing is affordable" and the market maker would stop buying entirely.
 */
const cap = (cfg: any) => (MarketMaker.prototype as any).cap.call(null, cfg);

describe("market capital cap", () => {
  it("treats 0 as unlimited rather than as zero budget", () => {
    expect(cap({ ...DEFAULT_MM, capitalValor: 0 })).toBe(Infinity);
  });

  it("still honours a real cap when one is set", () => {
    expect(cap({ ...DEFAULT_MM, capitalValor: 3000 })).toBe(3000);
  });

  it("leaves an asset affordable when uncapped", () => {
    // the "harga > modal" guard is bid+1 > cap*0.7; uncapped, no bid can trip it
    expect(4849 > cap({ ...DEFAULT_MM, capitalValor: 0 }) * 0.7).toBe(false);
    expect(4849 > cap({ ...DEFAULT_MM, capitalValor: 3000 }) * 0.7).toBe(true);
  });
});
