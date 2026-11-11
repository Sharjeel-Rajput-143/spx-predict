// OFFLINE BACKTEST ENGINE. Pure functions only: no network, no files, no API keys, nothing from the live bot.
// The rules it follows are written in PASS_FAIL_BAR.md and PASS_FAIL_BAR_ADDENDUM_2026-11-10.md.

export const MIN = 60_000;
export const STOP_PCT = 0.3;
export const BE_TRIGGER_PCT = 0.3;
export const BE_LOCK_PCT = 0.12;
export const WARMUP_BARS = 200;
export const TAKER = 0.055;
export const MAKER = 0.02;
export const SLIPPAGE = 0.01;

/** Build bigger bars from 1 minute bars. A bar is kept only when all of its minutes exist. Bar time = start. */
export function aggregate(bars1m, minutes) {
  if (minutes === 1) return bars1m;
  const span = minutes * MIN;
  const out = [];
  let cur = null;
  let count = 0;
  for (const b of bars1m) {
    const start = Math.floor(b.t / span) * span;
    if (!cur || cur.t !== start) {
      if (cur && count === minutes) out.push(cur);
      cur = { t: start, o: b.o, h: b.h, l: b.l, c: b.c };
      count = 1;
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      count++;
    }
  }
  if (cur && count === minutes) out.push(cur);
  return out;
}

export function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length);
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder ADX. Entries before the indicator has enough data are NaN. */
export function adx(bars, period = 14) {
  const n = bars.length;
  const out = new Array(n).fill(NaN);
  if (n < period * 2 + 1) return out;
  const tr = new Array(n).fill(0);
  const pdm = new Array(n).fill(0);
  const mdm = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = bars[i].h - bars[i - 1].h;
    const down = bars[i - 1].l - bars[i].l;
    pdm[i] = up > down && up > 0 ? up : 0;
    mdm[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
  }
  let trS = 0, pS = 0, mS = 0;
  for (let i = 1; i <= period; i++) {
    trS += tr[i];
    pS += pdm[i];
    mS += mdm[i];
  }
  const dx = new Array(n).fill(NaN);
  const calcDx = () => {
    const pdi = trS ? (100 * pS) / trS : 0;
    const mdi = trS ? (100 * mS) / trS : 0;
    return pdi + mdi ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
  };
  dx[period] = calcDx();
  for (let i = period + 1; i < n; i++) {
    trS = trS - trS / period + tr[i];
    pS = pS - pS / period + pdm[i];
    mS = mS - mS / period + mdm[i];
    dx[i] = calcDx();
  }
  let a = 0;
  for (let i = period; i < period * 2; i++) a += dx[i];
  a /= period;
  out[period * 2 - 1] = a;
  for (let i = period * 2; i < n; i++) {
    a = (a * (period - 1) + dx[i]) / period;
    out[i] = a;
  }
  return out;
}

/** EMA 9 / EMA 20 crosses on a bar series. dir +1 = cross up, -1 = cross down. `at` = the moment the bar has closed. */
export function findCrosses(bars, minutes, fast = 9, slow = 20) {
  const closes = bars.map((b) => b.c);
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const out = [];
  for (let i = Math.max(1, WARMUP_BARS); i < bars.length; i++) {
    const up = f[i - 1] <= s[i - 1] && f[i] > s[i];
    const down = f[i - 1] >= s[i - 1] && f[i] < s[i];
    if (up || down) out.push({ i, dir: up ? 1 : -1, at: bars[i].t + minutes * MIN });
  }
  return out;
}

/**
 * Trend of a bar series on its last fully closed bar at or before `time`: +1 (EMA 9 above EMA 20), -1, or 0 (not known yet).
 * Uses only bars that have closed by `time`.
 */
export function makeTrendLookup(bars, minutes) {
  const closes = bars.map((b) => b.c);
  const f = ema(closes, 9);
  const s = ema(closes, 20);
  const ends = bars.map((b) => b.t + minutes * MIN);
  return (time) => {
    let lo = 0, hi = ends.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ends[mid] <= time) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best < WARMUP_BARS) return 0;
    return f[best] > s[best] ? 1 : f[best] < s[best] ? -1 : 0;
  };
}

/** Index of the first 1 minute bar with t >= time (binary search). */
export function firstIndexAtOrAfter(bars1m, time) {
  let lo = 0, hi = bars1m.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars1m[mid].t < time) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Walk one trade forward on 1 minute bars from `startIdx` (its first bar opens at the entry price) up to the cap time.
 * Order inside a minute is unknown, so the rules are pessimistic and fixed: the stop wins over the take profit, the original
 * stop wins over a breakeven move, and a minute that triggers breakeven and also reaches the new stop is stopped there.
 * Returns { exit, type, t } where type is stop | be | tp | flip | end.
 */
export function walkTrade(bars1m, startIdx, dir, entry, capTime, opts) {
  const { tpPct, breakeven } = opts;
  const stopDist = (entry * STOP_PCT) / 100;
  const tpDist = (entry * tpPct) / 100;
  const trigDist = (entry * BE_TRIGGER_PCT) / 100;
  const lockDist = (entry * BE_LOCK_PCT) / 100;
  let stop = entry - dir * stopDist;
  const tp = entry + dir * tpDist;
  const trigger = entry + dir * trigDist;
  let moved = false;
  for (let i = startIdx; i < bars1m.length; i++) {
    const b = bars1m[i];
    if (b.t >= capTime) return { exit: b.o, type: "flip", t: b.t };
    // Worst and best price in our direction during this minute.
    const worst = dir === 1 ? b.l : b.h;
    const best = dir === 1 ? b.h : b.l;
    const stopHit = dir === 1 ? worst <= stop : worst >= stop;
    if (stopHit) {
      const gapped = dir === 1 ? b.o <= stop : b.o >= stop;
      return { exit: gapped ? b.o : stop, type: moved ? "be" : "stop", t: b.t };
    }
    if (breakeven && !moved) {
      const trig = dir === 1 ? best >= trigger : best <= trigger;
      if (trig) {
        moved = true;
        stop = entry + dir * lockDist;
        const nowStopped = dir === 1 ? worst <= stop : worst >= stop;
        if (nowStopped) return { exit: stop, type: "be", t: b.t };
      }
    }
    const tpHit = dir === 1 ? best >= tp : best <= tp;
    if (tpHit) return { exit: tp, type: "tp", t: b.t };
  }
  const last = bars1m[bars1m.length - 1];
  return { exit: last.c, type: "end", t: last.t };
}

/** Net result (percent of entry value) of one finished trade in a cost case. extraSlip adds the slippage test. */
export function netPercent(trade, costCase, extraSlip = false) {
  const { dir, entry, exit, type } = trade;
  const ratio = exit / entry;
  const gross = dir * (ratio - 1) * 100;
  let entryFee, exitFee, entryTaker, exitTaker;
  if (costCase === 1) {
    entryFee = TAKER; exitFee = TAKER; entryTaker = true; exitTaker = true;
  } else {
    entryFee = MAKER; entryTaker = false;
    exitTaker = type !== "tp";
    exitFee = exitTaker ? TAKER : MAKER;
  }
  let net = gross - entryFee - exitFee * ratio;
  if (extraSlip) net -= (entryTaker ? SLIPPAGE : 0) + (exitTaker ? SLIPPAGE * ratio : 0);
  return net;
}

/**
 * Plan every trade for a version, independent of the exit settings: when a cross happens, which trades would be opened.
 * `filter(cross) -> boolean` decides if a new trade opens. Each cross opens at most one trade, capped at the next cross.
 */
export function planTrades(crosses, filter) {
  const plans = [];
  for (let k = 0; k < crosses.length; k++) {
    const c = crosses[k];
    if (!filter(c)) continue;
    const cap = k + 1 < crosses.length ? crosses[k + 1].at : Infinity;
    plans.push({ at: c.at, dir: c.dir, cap });
  }
  return plans;
}

/** Run a plan with one exit setting. Returns trades with entry, exit, type and times. */
export function runPlan(bars1m, plans, opts, range) {
  const trades = [];
  for (const p of plans) {
    if (p.at < range.from || p.at >= range.to) continue;
    const idx = firstIndexAtOrAfter(bars1m, p.at);
    if (idx >= bars1m.length || bars1m[idx].t - p.at > 5 * MIN) continue; // no candle there (data gap)
    const entry = bars1m[idx].o;
    const cap = Math.min(p.cap, range.to);
    const r = walkTrade(bars1m, idx, p.dir, entry, cap, opts);
    trades.push({ t: p.at, dir: p.dir, entry, exit: r.exit, type: r.type, exitT: r.t, cap });
  }
  return trades;
}

// ---------- statistics ----------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const sum = (xs) => xs.reduce((a, b) => a + b, 0);

export function profitFactor(nets) {
  let w = 0, l = 0;
  for (const x of nets) (x > 0 ? (w += x) : (l -= x));
  return l === 0 ? (w > 0 ? Infinity : 0) : w / l;
}

/** Worst peak-to-trough fall of the running total (adding results, no compounding). */
export function maxDrawdown(nets) {
  let cum = 0, peak = 0, dd = 0;
  for (const x of nets) {
    cum += x;
    if (cum > peak) peak = cum;
    dd = Math.max(dd, peak - cum);
  }
  return dd;
}

/** Lower end of a two-sided bootstrap interval of the mean. `level` = 0.997 gives the 0.15th percentile. */
export function bootstrapLower(nets, level, resamples = 5000, seed = 12345) {
  if (!nets.length) return NaN;
  const rnd = mulberry32(seed);
  const n = nets.length;
  const means = new Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += nets[Math.floor(rnd() * n)];
    means[r] = s / n;
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - level) / 2;
  return means[Math.max(0, Math.floor(alpha * resamples))];
}

/** How many of 4 equal consecutive time slices of [from, to) have a positive net total. */
export function positiveSlices(trades, nets, range, slices = 4) {
  const width = (range.to - range.from) / slices;
  const totals = new Array(slices).fill(0);
  trades.forEach((t, i) => {
    const s = Math.min(slices - 1, Math.max(0, Math.floor((t.t - range.from) / width)));
    totals[s] += nets[i];
  });
  return { positive: totals.filter((x) => x > 0).length, totals };
}

export function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Control: same entry times, same caps, same exits and fees, but the direction of each trade is a coin flip.
 * Both directions are simulated once; each control run just picks one per trade.
 */
export function chanceControl(bars1m, plans, opts, range, costCase, runs = 1000, seed = 777) {
  const longs = runPlan(bars1m, plans.map((p) => ({ ...p, dir: 1 })), opts, range).map((t) => netPercent(t, costCase));
  const shorts = runPlan(bars1m, plans.map((p) => ({ ...p, dir: -1 })), opts, range).map((t) => netPercent(t, costCase));
  const rnd = mulberry32(seed);
  const totals = new Array(runs);
  for (let r = 0; r < runs; r++) {
    let s = 0;
    for (let i = 0; i < longs.length; i++) s += rnd() < 0.5 ? longs[i] : shorts[i];
    totals[r] = s;
  }
  totals.sort((a, b) => a - b);
  return totals;
}

export const BAR = {
  minTrades: 200,
  minAvgNet: 0.03,
  minProfitFactor: 1.3,
  minPositiveSlices: 3,
  minRecovery: 2.0,
  ciLevel: 0.997,
  chancePercentile: 0.997,
};

/** Score a finished set of trades for one cost case against the bar. */
export function evaluate(bars1m, plans, trades, opts, range, costCase, { withControl = true, bar = BAR } = {}) {
  const nets = trades.map((t) => netPercent(t, costCase));
  const n = nets.length;
  const total = sum(nets);
  const avg = n ? total / n : 0;
  const pf = profitFactor(nets);
  const dd = maxDrawdown(nets);
  const recovery = dd === 0 ? (total > 0 ? Infinity : 0) : total / dd;
  const slices = positiveSlices(trades, nets, range);
  const ciLow = bootstrapLower(nets, bar.ciLevel);
  const slipAvg = n ? sum(trades.map((t) => netPercent(t, costCase, true))) / n : 0;
  const gross = n ? sum(trades.map((t) => t.dir * (t.exit / t.entry - 1) * 100)) / n : 0;
  const wins = nets.filter((x) => x > 0).length;
  let chance = NaN;
  let chanceThreshold = NaN;
  if (withControl && n > 0) {
    const totals = chanceControl(bars1m, plans, opts, range, costCase);
    chanceThreshold = percentile(totals, bar.chancePercentile);
    chance = chanceThreshold;
  }
  const fails = [];
  if (n < bar.minTrades) fails.push(`only ${n} trades (need ${bar.minTrades})`);
  else {
    if (!(avg >= bar.minAvgNet)) fails.push(`average net ${avg.toFixed(3)}% per trade (need ${bar.minAvgNet}%)`);
    if (!(pf >= bar.minProfitFactor)) fails.push(`profit factor ${pf.toFixed(2)} (need ${bar.minProfitFactor})`);
    if (slices.positive < bar.minPositiveSlices) fails.push(`${slices.positive} of 4 slices positive (need ${bar.minPositiveSlices})`);
    if (!(recovery >= bar.minRecovery)) fails.push(`total / worst drawdown ${Number.isFinite(recovery) ? recovery.toFixed(2) : "inf"} (need ${bar.minRecovery})`);
    if (!(ciLow > 0)) fails.push(`bootstrap lower end ${ciLow.toFixed(3)}% (need above 0)`);
    if (withControl && !(total > chanceThreshold)) fails.push(`total ${total.toFixed(1)}% does not beat chance (${chanceThreshold.toFixed(1)}%)`);
    if (!(slipAvg > 0)) fails.push(`with +${SLIPPAGE}% slippage average is ${slipAvg.toFixed(3)}%`);
  }
  const verdict = n < bar.minTrades ? "INCONCLUSIVE" : fails.length ? "FAIL" : "PASS";
  const types = {};
  for (const t of trades) types[t.type] = (types[t.type] ?? 0) + 1;
  return { n, wins, winRate: n ? wins / n : 0, gross, avg, total, pf, dd, recovery, slices, ciLow, slipAvg, chanceThreshold: chance, verdict, fails, types };
}
