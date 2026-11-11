// OFFLINE BACKTEST RUNNER. Reads a candle CSV made by download.mjs, places no orders, uses no API keys, never touches the live bot.
//
//   node scripts/backtest/run.mjs <folder> [--out report.md]
//   node scripts/backtest/run.mjs <folder> --holdout <versionId> <gridId> <case>     (the ONE allowed look at the locked last 60 days)
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fromCsv, gapStats } from "./download.mjs";
import { MIN, adx, aggregate, evaluate, findCrosses, makeTrendLookup, planTrades, runPlan } from "./engine.mjs";

export const HOLDOUT_DAYS = 60;

export const GRID = [
  { id: "tp0.6", tpPct: 0.6, breakeven: false },
  { id: "tp0.6+be", tpPct: 0.6, breakeven: true },
  { id: "tp1.0", tpPct: 1.0, breakeven: false },
  { id: "tp1.0+be", tpPct: 1.0, breakeven: true },
  { id: "tp1.5", tpPct: 1.5, breakeven: false },
  { id: "tp1.5+be", tpPct: 1.5, breakeven: true },
];

/** The candidate versions (A, B, C may pass) and the references (R1, R2 are shown only). */
export function buildVersions(bars1m) {
  const b5 = aggregate(bars1m, 5);
  const b15 = aggregate(bars1m, 15);
  const b60 = aggregate(bars1m, 60);
  const crosses5 = findCrosses(b5, 5);
  const crosses15 = findCrosses(b15, 15);
  const crosses60 = findCrosses(b60, 60);
  const trend1h = makeTrendLookup(b60, 60);
  const adx15 = adx(b15, 14);
  const trendFilter = (c) => trend1h(c.at) === c.dir;
  const adxFilter = (c) => trendFilter(c) && adx15[c.i] > 20;
  return [
    { id: "A", label: "5m EMA 9/20", canPass: true, plans: planTrades(crosses5, () => true) },
    { id: "B", label: "15m EMA 9/20 + 1h trend", canPass: true, plans: planTrades(crosses15, trendFilter) },
    { id: "C", label: "15m EMA 9/20 + 1h trend + ADX>20", canPass: true, plans: planTrades(crosses15, adxFilter) },
    { id: "R1", label: "15m EMA 9/20, no filter (reference)", canPass: false, plans: planTrades(crosses15, () => true) },
    { id: "R2", label: "1h EMA 9/20, no filter (reference)", canPass: false, plans: planTrades(crosses60, () => true) },
  ];
}

export function splitRange(bars1m) {
  const first = bars1m[0].t;
  const last = bars1m[bars1m.length - 1].t + MIN;
  const holdFrom = last - HOLDOUT_DAYS * 24 * 60 * MIN;
  return { main: { from: first, to: holdFrom }, holdout: { from: holdFrom, to: last } };
}

export function runAll(bars1m, { range, withControl = true, only = null } = {}) {
  const r = range ?? splitRange(bars1m).main;
  const versions = buildVersions(bars1m).filter((v) => !only || v.id === only.version);
  const rows = [];
  for (const v of versions) {
    for (const g of GRID) {
      if (only && g.id !== only.grid) continue;
      const trades = runPlan(bars1m, v.plans, g, r);
      for (const costCase of only ? [only.case] : [1, 2]) {
        const ev = evaluate(bars1m, v.plans, trades, g, r, costCase, { withControl: withControl && v.canPass });
        rows.push({ version: v, grid: g, costCase, ev });
      }
    }
  }
  return rows;
}

const pct = (x, d = 3) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}%` : "n/a");
const day = (t) => new Date(t).toISOString().slice(0, 10);

export function formatReport(rows, { range, meta }) {
  const L = [];
  L.push(`# Backtest results, take profit grid (after fees)`);
  L.push("");
  L.push(`Main-test period ${day(range.from)} to ${day(range.to)} (${((range.to - range.from) / 86_400_000).toFixed(0)} days). ${meta}`);
  L.push(`Bar: PASS_FAIL_BAR.md + PASS_FAIL_BAR_ADDENDUM_2026-11-10.md. All numbers are % of trade value, after fees. Stop is 0.3% everywhere.`);
  L.push("");
  for (const costCase of [1, 2]) {
    L.push(`## Cost case ${costCase}: ${costCase === 1 ? "taker 0.055% on every fill (the live reality)" : "maker 0.02% on entry and take profit, taker 0.055% on stop / breakeven / flip (optimistic ceiling)"}`);
    L.push("");
    L.push(`| Version | Exit | Trades | Win % | Gross/trade | Net/trade | Total net | PF | Worst DD | Slices+ | CI low | Slip avg | Verdict | Why not |`);
    L.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
    for (const r of rows.filter((x) => x.costCase === costCase)) {
      const e = r.ev;
      L.push(
        `| ${r.version.id} | ${r.grid.id} | ${e.n} | ${(e.winRate * 100).toFixed(1)} | ${pct(e.gross)} | ${pct(e.avg)} | ${pct(e.total, 1)} | ${Number.isFinite(e.pf) ? e.pf.toFixed(2) : "inf"} | ${e.dd.toFixed(1)} | ${e.slices.positive}/4 | ${pct(e.ciLow)} | ${pct(e.slipAvg)} | ${r.version.canPass ? e.verdict : "ref"} | ${r.version.canPass ? e.fails.join("; ") : ""} |`,
      );
    }
    L.push("");
  }
  const passes = rows.filter((r) => r.version.canPass && r.ev.verdict === "PASS");
  L.push(`## Summary`);
  L.push("");
  L.push(passes.length ? passes.map((r) => `- PASS: version ${r.version.id}, ${r.grid.id}, case ${r.costCase}, net ${pct(r.ev.avg)} per trade`).join("\n") : "- No variant passed in either cost case.");
  return L.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const dir = args[0];
  if (!dir) {
    console.error("Usage: node scripts/backtest/run.mjs <folder> [--out report.md] | --holdout <version> <grid> <case>");
    process.exit(2);
  }
  const bars = fromCsv(fs.readFileSync(path.join(dir, "btcusdt-1m.csv"), "utf8"));
  const g = gapStats(bars);
  const { main: mainRange, holdout } = splitRange(bars);
  const hi = args.indexOf("--holdout");
  if (hi >= 0) {
    const [version, grid, c] = args.slice(hi + 1);
    const rows = runAll(bars, { range: holdout, only: { version, grid, case: Number(c) } });
    console.log(formatReport(rows, { range: holdout, meta: `HOLDOUT, one allowed look. Missing minutes in the data: ${g.missing}.` }));
    return;
  }
  const started = Date.now();
  const rows = runAll(bars, { range: mainRange });
  const report = formatReport(rows, { range: mainRange, meta: `${bars.length} one-minute candles, ${g.missing} missing minutes in ${g.gaps} gaps. The last ${HOLDOUT_DAYS} days (${day(holdout.from)} onward) were NOT run.` });
  const oi = args.indexOf("--out");
  if (oi >= 0) fs.writeFileSync(args[oi + 1], report + "\n");
  console.log(report);
  console.error(`done in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
