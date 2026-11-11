import { describe, expect, it } from "vitest";
import { downloadCandles, fromCsv, gapStats, parseRow, toCsv } from "./download.mjs";
import {
  MIN, adx, aggregate, bootstrapLower, chanceControl, ema, evaluate, findCrosses, makeTrendLookup, maxDrawdown, mulberry32, netPercent,
  planTrades, positiveSlices, profitFactor, runPlan, walkTrade,
} from "./engine.mjs";
import { GRID, buildVersions, runAll, splitRange } from "./run.mjs";

const bar = (i, o, h, l, c) => ({ t: i * MIN, o, h, l, c });
const flat = (i, p) => bar(i, p, p, p, p);

describe("aggregate", () => {
  it("builds 5 minute bars from 1 minute bars and drops incomplete ones", () => {
    const ones = [];
    for (let i = 0; i < 10; i++) ones.push(bar(i, 100 + i, 101 + i, 99 + i, 100.5 + i));
    ones.splice(7, 1); // the second 5 minute bar is missing a minute
    const five = aggregate(ones, 5);
    expect(five).toHaveLength(1);
    expect(five[0]).toEqual({ t: 0, o: 100, h: 105, l: 99, c: 104.5 });
  });
});

describe("indicators", () => {
  it("ema starts at the first value and follows the standard formula", () => {
    const e = ema([10, 20], 9);
    expect(e[0]).toBe(10);
    expect(e[1]).toBeCloseTo(20 * 0.2 + 10 * 0.8, 10);
  });
  it("adx is high in a steady trend and low in a flat market", () => {
    const up = Array.from({ length: 80 }, (_, i) => bar(i, 100 + i, 101 + i, 99.5 + i, 100.8 + i));
    const flatMarket = Array.from({ length: 80 }, (_, i) => bar(i, 100, 100.5 + (i % 2) * 0.1, 99.5 - (i % 2) * 0.1, 100));
    expect(adx(up).at(-1)).toBeGreaterThan(40);
    expect(adx(flatMarket).at(-1)).toBeLessThan(15);
  });
});

describe("crosses and the 1 hour filter use only closed bars", () => {
  const series = () => {
    const bars = [];
    // 300 bars falling, then 300 rising, then 300 falling: crosses up then down.
    let p = 1000;
    for (let i = 0; i < 900; i++) {
      p += i < 300 ? -1 : i < 600 ? 1.2 : -1.2;
      bars.push(bar(i, p, p + 0.2, p - 0.2, p));
    }
    return bars;
  };
  it("finds a cross up and a cross down, and the signal time is the bar's close", () => {
    const bars = series();
    const c = findCrosses(bars, 1);
    expect(c.some((x) => x.dir === 1)).toBe(true);
    expect(c.some((x) => x.dir === -1)).toBe(true);
    for (const x of c) expect(x.at).toBe(bars[x.i].t + MIN);
  });
  it("changing bars AFTER a signal never changes that signal (no look-ahead)", () => {
    const bars = series();
    const before = findCrosses(bars, 1).filter((x) => x.i < 700);
    const changed = bars.map((b, i) => (i >= 700 ? { ...b, c: b.c + 50 * Math.sin(i) } : b));
    expect(findCrosses(changed, 1).filter((x) => x.i < 700)).toEqual(before);
  });
  it("the trend lookup ignores a bar that has not closed yet", () => {
    const bars = series();
    const look = makeTrendLookup(bars, 1);
    const early = look(bars[500].t + MIN - 1); // bar 500 is still open: bar 499 is the last closed one
    const sameWithBar500Wrecked = makeTrendLookup(bars.map((b, i) => (i === 500 ? { ...b, c: 1 } : b)), 1)(bars[500].t + MIN - 1);
    expect(early).toBe(sameWithBar500Wrecked);
    expect(look(0)).toBe(0);
  });
});

describe("walkTrade: the pessimistic order inside a minute", () => {
  const opts = (tpPct, breakeven) => ({ tpPct, breakeven });
  it("long: stop at -0.3%", () => {
    const bars = [flat(0, 100), bar(1, 100, 100, 99.6, 99.7)];
    const r = walkTrade(bars, 0, 1, 100, Infinity, opts(0.6, false));
    expect(r.type).toBe("stop");
    expect(r.exit).toBeCloseTo(99.7, 10);
  });
  it("long: take profit at +0.6%", () => {
    const bars = [flat(0, 100), bar(1, 100, 100.7, 100, 100.6)];
    const r = walkTrade(bars, 0, 1, 100, Infinity, opts(0.6, false));
    expect(r.type).toBe("tp");
    expect(r.exit).toBeCloseTo(100.6, 10);
  });
  it("a minute that touches both the stop and the take profit is a stop", () => {
    const bars = [bar(0, 100, 100.8, 99.5, 100)];
    expect(walkTrade(bars, 0, 1, 100, Infinity, opts(0.6, false)).type).toBe("stop");
  });
  it("short mirrors long", () => {
    const stop = walkTrade([bar(0, 100, 100.4, 100, 100.3)], 0, -1, 100, Infinity, opts(0.6, false));
    expect(stop.type).toBe("stop");
    expect(stop.exit).toBeCloseTo(100.3, 10);
    const tp = walkTrade([bar(0, 100, 100, 99.3, 99.4)], 0, -1, 100, Infinity, opts(0.6, false));
    expect(tp.type).toBe("tp");
    expect(tp.exit).toBeCloseTo(99.4, 10);
  });
  it("breakeven: after +0.3% the stop moves to +0.12% and a pull-back ends the trade there", () => {
    const bars = [flat(0, 100), bar(1, 100, 100.35, 100.2, 100.3), bar(2, 100.3, 100.3, 100.05, 100.1)];
    const r = walkTrade(bars, 0, 1, 100, Infinity, opts(0.6, true));
    expect(r.type).toBe("be");
    expect(r.exit).toBeCloseTo(100.12, 10);
  });
  it("without breakeven the same path keeps running past the pull-back", () => {
    const bars = [flat(0, 100), bar(1, 100, 100.35, 100.2, 100.3), bar(2, 100.3, 100.3, 100.05, 100.1), bar(3, 100.1, 100.7, 100.1, 100.6)];
    const r = walkTrade(bars, 0, 1, 100, Infinity, opts(0.6, false));
    expect(r.type).toBe("tp");
  });
  it("a minute that triggers breakeven and also reaches the new stop is stopped there (pessimistic)", () => {
    const bars = [bar(0, 100, 100.4, 100.05, 100.2)];
    const r = walkTrade(bars, 0, 1, 100, Infinity, opts(0.6, true));
    expect(r.type).toBe("be");
    expect(r.exit).toBeCloseTo(100.12, 10);
  });
  it("breakeven moves only once and never loosens the stop", () => {
    // After the move, a dip to +0.13% does not stop it; one to +0.11% does.
    const ok = walkTrade([bar(0, 100, 100.4, 100.2, 100.3), bar(1, 100.3, 100.3, 100.13, 100.2), bar(2, 100.2, 100.7, 100.2, 100.6)], 0, 1, 100, Infinity, opts(0.6, true));
    expect(ok.type).toBe("tp");
    const out = walkTrade([bar(0, 100, 100.4, 100.2, 100.3), bar(1, 100.3, 100.3, 100.11, 100.2)], 0, 1, 100, Infinity, opts(0.6, true));
    expect(out.type).toBe("be");
  });
  it("a gap through the stop fills at the open, not at the stop", () => {
    const r = walkTrade([flat(0, 100), bar(1, 99.0, 99.1, 98.9, 99)], 0, 1, 100, Infinity, opts(0.6, false));
    expect(r.exit).toBe(99.0);
  });
  it("a signal flip closes at the next bar's open", () => {
    const bars = [flat(0, 100), flat(1, 100.1), flat(2, 100.2), flat(3, 100.3)];
    const r = walkTrade(bars, 0, 1, 100, 2 * MIN, opts(0.6, false));
    expect(r).toMatchObject({ type: "flip", exit: 100.2 });
  });
  it("a trade still open at the end is closed at the last price", () => {
    const r = walkTrade([flat(0, 100), flat(1, 100.1)], 0, 1, 100, Infinity, opts(0.6, false));
    expect(r).toMatchObject({ type: "end", exit: 100.1 });
  });
});

describe("fees", () => {
  const t = (dir, exit, type) => ({ dir, entry: 100, exit, type });
  it("case 1: taker both ways", () => {
    // +0.6% gross, 0.055% in, 0.055% * 1.006 out
    expect(netPercent(t(1, 100.6, "tp"), 1)).toBeCloseTo(0.6 - 0.055 - 0.055 * 1.006, 10);
  });
  it("case 2: maker in and on take profit, taker on a stop", () => {
    expect(netPercent(t(1, 100.6, "tp"), 2)).toBeCloseTo(0.6 - 0.02 - 0.02 * 1.006, 10);
    expect(netPercent(t(1, 99.7, "stop"), 2)).toBeCloseTo(-0.3 - 0.02 - 0.055 * 0.997, 10);
    expect(netPercent(t(1, 100.12, "be"), 2)).toBeCloseTo(0.12 - 0.02 - 0.055 * 1.0012, 10);
    expect(netPercent(t(1, 100.2, "flip"), 2)).toBeCloseTo(0.2 - 0.02 - 0.055 * 1.002, 10);
  });
  it("a short profits when the price falls", () => {
    expect(netPercent(t(-1, 99.4, "tp"), 1)).toBeCloseTo(0.6 - 0.055 - 0.055 * 0.994, 10);
  });
  it("extra slippage costs 0.01% per taker fill", () => {
    const plain = netPercent(t(1, 100.6, "tp"), 1);
    expect(plain - netPercent(t(1, 100.6, "tp"), 1, true)).toBeCloseTo(0.01 + 0.01 * 1.006, 10);
    const plain2 = netPercent(t(1, 100.6, "tp"), 2);
    expect(plain2 - netPercent(t(1, 100.6, "tp"), 2, true)).toBeCloseTo(0, 10); // no taker fill at all
  });
});

describe("statistics", () => {
  it("profit factor, drawdown and slices", () => {
    expect(profitFactor([2, -1, 3, -1])).toBeCloseTo(2.5, 10);
    expect(profitFactor([1, 2])).toBe(Infinity);
    expect(maxDrawdown([1, -2, 1, -1, 3])).toBeCloseTo(2, 10);
    const trades = [0, 1, 2, 3].map((k) => ({ t: k * 100 + 1 }));
    expect(positiveSlices(trades, [1, -1, 1, 1], { from: 0, to: 400 }).positive).toBe(3);
  });
  it("bootstrap is repeatable and its lower end is below the mean", () => {
    const nets = Array.from({ length: 300 }, (_, i) => (i % 3 === 0 ? -1 : 0.7));
    const a = bootstrapLower(nets, 0.997);
    expect(bootstrapLower(nets, 0.997)).toBe(a);
    expect(a).toBeLessThan(nets.reduce((s, x) => s + x, 0) / nets.length);
  });
  it("mulberry32 is deterministic", () => {
    expect(mulberry32(5)()).toBe(mulberry32(5)());
  });
});

// A random walk has no edge: nothing may pass on it, in either cost case, on any exit. This guards against a leak in the engine.
function randomWalk(n, seed) {
  const rnd = mulberry32(seed);
  const bars = [];
  let p = 50_000;
  for (let i = 0; i < n; i++) {
    const o = p;
    let h = o, l = o;
    for (let k = 0; k < 4; k++) {
      p *= 1 + (rnd() - 0.5) * 0.0016;
      h = Math.max(h, p);
      l = Math.min(l, p);
    }
    bars.push({ t: 1_700_000_040_000 - (1_700_000_040_000 % MIN) + i * MIN, o, h, l, c: p });
  }
  return bars;
}

describe("whole pipeline on data with no edge", () => {
  const bars = randomWalk(60_000, 99);
  it("builds trades for every version and loses to fees on every exit setting", () => {
    const rows = runAll(bars, { range: { from: bars[0].t, to: bars.at(-1).t + MIN }, withControl: false });
    expect(rows).toHaveLength(5 * GRID.length * 2);
    expect(rows.every((r) => r.ev.n > 0)).toBe(true);
    for (const r of rows.filter((x) => x.costCase === 1)) expect(r.ev.verdict).not.toBe("PASS");
    // Fees alone cost about 0.11% a trade, so the average net must be clearly negative in case 1.
    for (const r of rows.filter((x) => x.costCase === 1 && x.ev.n > 100)) expect(r.ev.avg).toBeLessThan(0);
  });
  it("shorting costs the same as buying: gross is near zero on random data", () => {
    const rows = runAll(bars, { range: { from: bars[0].t, to: bars.at(-1).t + MIN }, withControl: false });
    const a = rows.find((r) => r.version.id === "A" && r.grid.id === "tp0.6" && r.costCase === 1);
    expect(Math.abs(a.ev.gross)).toBeLessThan(0.08);
  });
});

describe("the evaluator would pass a planted edge", () => {
  it("a series where every cross is followed by a big move in its direction passes the trade count and profit rules", () => {
    // Build 1 minute bars so each cross is followed by a steady move the right way.
    const bars = [];
    let p = 1000;
    let t = 0;
    for (let seg = 0; seg < 120; seg++) {
      const dir = seg % 2 === 0 ? 1 : -1;
      for (let i = 0; i < 300; i++) {
        p *= 1 + dir * 0.0006;
        bars.push({ t: t * MIN, o: p / (1 + dir * 0.0006), h: Math.max(p, p / (1 + dir * 0.0006)), l: Math.min(p, p / (1 + dir * 0.0006)), c: p });
        t++;
      }
    }
    const crosses = findCrosses(bars, 1);
    const plans = planTrades(crosses, () => true);
    const range = { from: bars[0].t, to: bars.at(-1).t + MIN };
    const trades = runPlan(bars, plans, { tpPct: 1.5, breakeven: false }, range);
    const ev = evaluate(bars, plans, trades, { tpPct: 1.5, breakeven: false }, range, 1);
    expect(ev.n).toBeGreaterThan(50);
    expect(ev.avg).toBeGreaterThan(0.03);
    expect(ev.pf).toBeGreaterThan(1.3);
    expect(ev.slices.positive).toBeGreaterThanOrEqual(3);
  });
});

describe("chance control", () => {
  it("is sorted and uses the same number of trades", () => {
    const bars = randomWalk(20_000, 5);
    const plans = planTrades(findCrosses(bars, 1), () => true);
    const totals = chanceControl(bars, plans, { tpPct: 0.6, breakeven: true }, { from: bars[0].t, to: bars.at(-1).t + MIN }, 1, 50);
    expect(totals).toHaveLength(50);
    expect([...totals].sort((a, b) => a - b)).toEqual(totals);
  });
});

describe("buildVersions / splitRange", () => {
  it("reserves the last 60 days and the filtered versions never trade more than the unfiltered 15 minute one", () => {
    const bars = randomWalk(40_000, 3);
    const v = Object.fromEntries(buildVersions(bars).map((x) => [x.id, x]));
    expect(v.C.plans.length).toBeLessThanOrEqual(v.B.plans.length);
    expect(v.B.plans.length).toBeLessThanOrEqual(v.R1.plans.length);
    const r = splitRange(bars);
    expect(r.main.to).toBe(r.holdout.from);
    expect(r.holdout.to - r.holdout.from).toBe(60 * 24 * 60 * MIN);
  });
});

describe("download", () => {
  it("pages backwards, removes duplicates, retries a bad page and returns oldest first", async () => {
    const all = Array.from({ length: 2500 }, (_, i) => [String((i + 1) * MIN), "1", "2", "0.5", "1.5", "1", "1"]);
    let calls = 0;
    const fetchFn = async (url) => {
      calls++;
      if (calls === 2) throw new Error("fetch failed");
      const q = new URL(url).searchParams;
      const end = Number(q.get("end"));
      const start = Number(q.get("start"));
      const rows = all.filter((r) => Number(r[0]) <= end && Number(r[0]) >= start).sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, 1000);
      return { json: async () => ({ retCode: 0, result: { list: rows } }) };
    };
    const got = await downloadCandles({ startMs: MIN, endMs: 2500 * MIN, fetchFn, pauseMs: 0 });
    expect(got).toHaveLength(2500);
    expect(got[0].t).toBe(MIN);
    expect(got.at(-1).t).toBe(2500 * MIN);
    expect(gapStats(got)).toEqual({ missing: 0, gaps: 0 });
  });
  it("reports gaps, and the CSV round-trips", () => {
    const c = [{ t: 0, o: 1, h: 2, l: 0.5, c: 1.5 }, { t: 3 * MIN, o: 1.5, h: 2, l: 1, c: 1.8 }];
    expect(gapStats(c)).toEqual({ missing: 2, gaps: 1 });
    expect(fromCsv(toCsv(c))).toEqual(c);
    expect(parseRow(["60000", "1", "2", "0.5", "1.5", "9", "9"])).toEqual({ t: 60000, o: 1, h: 2, l: 0.5, c: 1.5 });
  });
  it("gives up with a clear message when Bybit keeps failing", async () => {
    await expect(downloadCandles({ startMs: 0, endMs: 10 * MIN, fetchFn: async () => { throw new Error("fetch failed"); }, pauseMs: 0 })).rejects.toThrow(/Download failed/);
  });
});
