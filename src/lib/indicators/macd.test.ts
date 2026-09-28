import { describe, expect, it } from "vitest";
import { macd } from "./macd";
import { sma } from "./sma";

describe("macd", () => {
  it("macd line is NaN until the slow EMA warms up, then fast-EMA minus slow-EMA", () => {
    const values = [0, 1, 3, 6, 10, 15, 21, 28, 36, 45];
    const { macd: line } = macd(values, 1, 2, 2);
    expect(line.slice(0, 1).every(Number.isNaN)).toBe(true);
    expect(line[1]).toBeCloseTo(values[1] - sma(values, 2)[1], 6);
  });

  it("the signal line is SMA-seeded over the first `signalLength` valid macd values", () => {
    const values = [0, 1, 3, 6, 10, 15, 21, 28, 36, 45];
    const fast = 1;
    const slow = 2;
    const signalLength = 3;
    const { macd: line, signal } = macd(values, fast, slow, signalLength);
    const firstValid = slow - 1;
    const seedIndex = firstValid + signalLength - 1;
    const expectedSeed = sma(line.slice(firstValid), signalLength)[signalLength - 1];
    expect(signal[seedIndex]).toBeCloseTo(expectedSeed, 6);
    expect(signal.slice(0, seedIndex).every(Number.isNaN)).toBe(true);
  });

  it("histogram is macd minus signal wherever both are defined", () => {
    const values = [5, 6, 4, 8, 9, 3, 12, 15, 7, 20, 22];
    const { macd: line, signal, histogram } = macd(values, 3, 6, 4);
    for (let i = 0; i < values.length; i++) {
      if (!Number.isNaN(signal[i])) {
        expect(histogram[i]).toBeCloseTo(line[i] - signal[i], 9);
      } else {
        expect(Number.isNaN(histogram[i])).toBe(true);
      }
    }
  });
});
