/**
 * Deterministic mock price model.
 *
 * Price is a pure function of (symbol, time), built from layered value noise.
 * That means the "open" and "close" of any past window can be recomputed,
 * which lets us seed believable history and settle rounds consistently.
 * Replace with a real feed later via the GameService interface.
 */
import { getTicker } from "../config";

function hash(str: string, n: number) {
  let h = 2166136261 ^ n;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  }
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1; // -1..1
}

function smooth(x: number) {
  return x * x * (3 - 2 * x);
}

function valueNoise(seed: string, t: number, periodMs: number) {
  const x = t / periodMs;
  const i = Math.floor(x);
  const f = smooth(x - i);
  const a = hash(seed, i);
  const b = hash(seed, i + 1);
  return a + (b - a) * f;
}

const LAYERS: [number, number][] = [
  // [period ms, amplitude as fraction of price]
  [30 * 60_000, 0.006],
  [6 * 60_000, 0.0025],
  [75_000, 0.0011],
  [18_000, 0.0005],
  [4_000, 0.00018],
];

export function mockPriceAt(symbol: string, t: number): number {
  const base = getTicker(symbol).basePrice;
  let drift = 0;
  LAYERS.forEach(([period, amp], idx) => {
    drift += amp * valueNoise(`${symbol}:${idx}`, t, period);
  });
  return Math.round(base * (1 + drift) * 100) / 100;
}

export function mockSeries(symbol: string, fromMs: number, toMs: number, stepMs: number) {
  const start = Math.floor(fromMs / stepMs) * stepMs;
  const out = [];
  for (let t = start; t <= toMs; t += stepMs) out.push({ t, price: mockPriceAt(symbol, t) });
  return out;
}

/** Deterministic synthetic volume for a bar, scaled roughly by its duration. */
export function mockVolumeAt(symbol: string, barStartMs: number, durationMs: number): number {
  const n = Math.floor(barStartMs / 1000);
  const noise = 0.5 + 0.5 * (hash(`${symbol}:vol`, n) * 0.5 + 0.5);
  const perSecond = getTicker(symbol).symbol === "ES1!" ? 40 : 2200;
  return Math.round(perSecond * (durationMs / 1000) * noise);
}
