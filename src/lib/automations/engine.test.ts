import { describe, expect, it } from "vitest";
import { ema } from "../indicators/ema";
import { evaluateRule } from "./engine";
import type { AlertRule } from "./types";
import type { Bar } from "../marketData/types";

function bar(t: number, c: number): Bar {
  return { t, o: c, h: c, l: c, c };
}

/** A downtrend that sharply reverses into an uptrend - EMA(9) should cross
 * back above EMA(20) somewhere during the reversal. This is the same
 * "EMA 9/20 crossing up" setup from the spec, driven through the real
 * engine + the real ema() implementation rather than hand-picked numbers. */
function buildReversalBars(): Bar[] {
  const closes: number[] = [];
  for (let i = 0; i < 40; i++) closes.push(100 - i); // 100 down to 61
  for (let i = 0; i < 40; i++) closes.push(61 + i * 3); // sharp reversal up
  return closes.map((c, i) => bar(i * 60_000, c));
}

const emaRule = (length: number): AlertRule["operandA"] => ({ mode: "indicator", kind: "ema", settings: { length, source: "close" } });

describe("evaluateRule", () => {
  it("fires crossing_up on exactly the bar where EMA(9) crosses above EMA(20), matching the raw ema() series", () => {
    const bars = buildReversalBars();
    const closes = bars.map((b) => b.c);
    const fast = ema(closes, 9);
    const slow = ema(closes, 20);

    // Ground truth from the same primitive the engine itself calls.
    let expectedCrossIndex = -1;
    for (let i = 1; i < bars.length; i++) {
      if (fast[i - 1] <= slow[i - 1] && fast[i] > slow[i]) {
        expectedCrossIndex = i;
        break;
      }
    }
    expect(expectedCrossIndex).toBeGreaterThan(0);

    const rule = {
      operandA: emaRule(9),
      condition: "crossing_up" as const,
      operandB: emaRule(20),
    };

    const triggeredAt: number[] = [];
    for (let i = 1; i < bars.length; i++) {
      const result = evaluateRule(rule, bars.slice(0, i + 1));
      if (result?.triggered) triggeredAt.push(i);
    }

    expect(triggeredAt).toEqual([expectedCrossIndex]);
  });

  it("does not fire while the fast EMA stays below the slow EMA", () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 30; i++) bars.push(bar(i * 60_000, 100 - i * 0.1)); // gentle, steady decline

    const rule = {
      operandA: emaRule(9),
      condition: "crossing_up" as const,
      operandB: emaRule(20),
    };

    for (let i = 20; i < bars.length; i++) {
      const result = evaluateRule(rule, bars.slice(0, i + 1));
      expect(result?.triggered).toBe(false);
    }
  });

  it("returns null until both EMAs have warmed up", () => {
    const bars = [bar(0, 100), bar(60_000, 101)];
    const rule = { operandA: emaRule(9), condition: "crossing_up" as const, operandB: emaRule(20) };
    expect(evaluateRule(rule, bars)).toBeNull();
  });

  it("supports a fixed-value operand (RSI crossing above 70)", () => {
    // A choppy start (RSI hovering near 50, so Wilder's avgLoss is nonzero)
    // followed by a steady climb - RSI rises gradually through 70 rather
    // than jumping straight to 100 the way a pure monotonic series would.
    const closes: number[] = [];
    let price = 100;
    for (let i = 0; i < 20; i++) {
      price += i % 2 === 0 ? 1 : -1;
      closes.push(price);
    }
    for (let i = 0; i < 30; i++) {
      price += 2;
      closes.push(price);
    }
    const bars = closes.map((c, i) => bar(i * 60_000, c));

    const rule = {
      operandA: { mode: "indicator" as const, kind: "rsi" as const, settings: { length: 14, source: "close" as const } },
      condition: "crosses_value" as const,
      operandB: { mode: "value" as const, value: 70 },
    };

    const triggeredAt: number[] = [];
    for (let i = 1; i < bars.length; i++) {
      const result = evaluateRule(rule, bars.slice(0, i + 1));
      if (result?.triggered) triggeredAt.push(i);
    }
    expect(triggeredAt.length).toBe(1);
  });
});
