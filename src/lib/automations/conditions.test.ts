import { describe, expect, it } from "vitest";
import { evaluateCondition } from "./conditions";

describe("evaluateCondition", () => {
  describe("crossing_up", () => {
    it("fires the bar A moves from at-or-below B to above B", () => {
      expect(evaluateCondition("crossing_up", { prevA: 9, currA: 11, prevB: 10, currB: 10 })).toBe(true);
    });
    it("fires when A was exactly equal to B and moves above", () => {
      expect(evaluateCondition("crossing_up", { prevA: 10, currA: 10.5, prevB: 10, currB: 10 })).toBe(true);
    });
    it("does not fire if A was already above B", () => {
      expect(evaluateCondition("crossing_up", { prevA: 11, currA: 12, prevB: 10, currB: 10 })).toBe(false);
    });
    it("does not fire if A stays below B", () => {
      expect(evaluateCondition("crossing_up", { prevA: 8, currA: 9, prevB: 10, currB: 10 })).toBe(false);
    });
  });

  describe("crossing_down", () => {
    it("fires the bar A moves from at-or-above B to below B", () => {
      expect(evaluateCondition("crossing_down", { prevA: 11, currA: 9, prevB: 10, currB: 10 })).toBe(true);
    });
    it("does not fire if A stays above B", () => {
      expect(evaluateCondition("crossing_down", { prevA: 12, currA: 11, prevB: 10, currB: 10 })).toBe(false);
    });
  });

  describe("greater_than / less_than", () => {
    it("greater_than is level-based, true every bar it holds", () => {
      expect(evaluateCondition("greater_than", { prevA: 5, currA: 71, prevB: 70, currB: 70 })).toBe(true);
      expect(evaluateCondition("greater_than", { prevA: 71, currA: 72, prevB: 70, currB: 70 })).toBe(true);
    });
    it("less_than mirrors greater_than", () => {
      expect(evaluateCondition("less_than", { prevA: 35, currA: 29, prevB: 30, currB: 30 })).toBe(true);
      expect(evaluateCondition("less_than", { prevA: 29, currA: 31, prevB: 30, currB: 30 })).toBe(false);
    });
  });

  describe("crosses_value", () => {
    it("fires crossing up through a fixed value", () => {
      expect(evaluateCondition("crosses_value", { prevA: 68, currA: 72, prevB: 70, currB: 70 })).toBe(true);
    });
    it("fires crossing down through the same fixed value", () => {
      expect(evaluateCondition("crosses_value", { prevA: 72, currA: 68, prevB: 70, currB: 70 })).toBe(true);
    });
    it("does not fire when neither side of the value changed", () => {
      expect(evaluateCondition("crosses_value", { prevA: 72, currA: 75, prevB: 70, currB: 70 })).toBe(false);
    });
  });
});
