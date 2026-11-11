// Downloads Bybit's PUBLIC BTCUSDT linear perpetual 1 minute candles. No API key, no account, nothing is sent except the symbol and time range.
// Candles are saved as a CSV in a folder you choose (outside the repo), never inside the project.
//
//   node scripts/backtest/download.mjs <folder> [months=24]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const HOST = "https://api.bybit.com";
const MIN = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parse one Bybit kline row ["startMs","open","high","low","close","volume","turnover"]. */
export function parseRow(r) {
  return { t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]) };
}

/**
 * Walks backwards from `endMs` to `startMs` in pages of 1000 candles. `fetchFn` is injectable for tests.
 * Returns candles oldest first, with duplicates removed.
 */
export async function downloadCandles({ startMs, endMs, fetchFn = fetch, pauseMs = 120, log = () => {}, symbol = "BTCUSDT", interval = "1" }) {
  const byTime = new Map();
  let cursor = endMs;
  let pages = 0;
  while (cursor > startMs) {
    const url = `${HOST}/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=1000&start=${startMs}&end=${cursor}`;
    let rows = null;
    for (let attempt = 1; attempt <= 6 && rows === null; attempt++) {
      try {
        const res = await fetchFn(url, { signal: AbortSignal.timeout(20_000) });
        const body = await res.json();
        if (body.retCode !== 0) throw new Error(`Bybit said ${body.retCode}: ${body.retMsg}`);
        rows = body.result.list;
      } catch (err) {
        if (attempt === 6) throw new Error(`Download failed after 6 tries at ${new Date(cursor).toISOString()}: ${err.message}`);
        await sleep(pauseMs * attempt * 5);
      }
    }
    if (!rows.length) break;
    let oldest = Infinity;
    for (const r of rows) {
      const c = parseRow(r);
      byTime.set(c.t, c);
      oldest = Math.min(oldest, c.t);
    }
    pages++;
    if (pages % 100 === 0) log(`  ${pages} pages, back to ${new Date(oldest).toISOString()}`);
    if (oldest >= cursor) break; // no progress
    cursor = oldest - 1;
    await sleep(pauseMs);
  }
  return [...byTime.values()].filter((c) => c.t >= startMs && c.t <= endMs).sort((a, b) => a.t - b.t);
}

export function toCsv(candles) {
  return candles.map((c) => `${c.t},${c.o},${c.h},${c.l},${c.c}`).join("\n") + "\n";
}

export function fromCsv(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [t, o, h, l, c] = line.split(",").map(Number);
    out.push({ t, o, h, l, c });
  }
  return out;
}

/** Counts missing minutes between candles, for the report. */
export function gapStats(candles) {
  let missing = 0, gaps = 0;
  for (let i = 1; i < candles.length; i++) {
    const d = (candles[i].t - candles[i - 1].t) / MIN - 1;
    if (d > 0) { missing += d; gaps++; }
  }
  return { missing, gaps };
}

async function main() {
  const [dir, monthsArg] = process.argv.slice(2);
  if (!dir) {
    console.error("Usage: node scripts/backtest/download.mjs <folder> [months=24]");
    process.exit(2);
  }
  const resolved = path.resolve(dir);
  if (resolved.startsWith(path.resolve(import.meta.dirname, "../.."))) {
    console.error("Refusing to write candle data inside the project folder. Pick a folder outside it.");
    process.exit(2);
  }
  fs.mkdirSync(resolved, { recursive: true });
  const months = Number(monthsArg ?? 24);
  const endMs = Math.floor(Date.now() / MIN) * MIN - MIN; // last complete minute
  const d = new Date(endMs);
  d.setUTCMonth(d.getUTCMonth() - months);
  const startMs = Math.floor(d.getTime() / MIN) * MIN;
  console.log(`Downloading BTCUSDT 1 minute candles ${new Date(startMs).toISOString()} -> ${new Date(endMs).toISOString()} (public data, no key)`);
  const candles = await downloadCandles({ startMs, endMs, log: console.log });
  fs.writeFileSync(path.join(resolved, "btcusdt-1m.csv"), toCsv(candles));
  const g = gapStats(candles);
  console.log(`Saved ${candles.length} candles. First ${new Date(candles[0].t).toISOString()}, last ${new Date(candles.at(-1).t).toISOString()}. Missing minutes: ${g.missing} in ${g.gaps} gaps.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
