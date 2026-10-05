import { describe, expect, it } from "vitest";
import { accountKind, accountLabel } from "./accounts";

describe("accountLabel", () => {
  it("names paper accounts", () => {
    expect(accountLabel("paper-1")).toBe("Paper Trading");
    expect(accountLabel("Paper-2")).toBe("Paper Trading");
  });

  it("masks a brokerage account number - never shows it in full", () => {
    expect(accountLabel("U12341854")).toBe("U ****1854");
    expect(accountLabel("TR-0000001854")).toBe("TR ****1854");
    expect(accountLabel("123456789")).toBe("XX ****6789");
    expect(accountLabel("U12341854")).not.toContain("1234185");
  });

  it("leaves a plain name alone", () => {
    expect(accountLabel("live-account")).toBe("live-account");
  });

  it("classifies by kind", () => {
    expect(accountKind("paper-1")).toBe("paper");
    expect(accountKind("U12341854")).toBe("broker");
    expect(accountKind("mine")).toBe("other");
  });
});
