import { describe, expect, it } from "vitest";
import { NAV, isActive } from "./AppShell";

const activeFor = (pathname: string) => NAV.filter((n) => isActive(pathname, n.href)).map((n) => n.label);

describe("the side menu", () => {
  it("has a Bybit tab right after Automation, pointing at the Bybit page", () => {
    expect(NAV.map((n) => n.label)).toEqual(["Automation", "Bybit", "Positions", "Calendar", "History", "Profile", "Settings"]);
    expect(NAV.find((n) => n.label === "Bybit")?.href).toBe("/automation/bybit");
  });

  it("highlights only Bybit on the Bybit page, and Automation (not Bybit) on the other automation pages", () => {
    expect(activeFor("/automation/bybit")).toEqual(["Bybit"]);
    expect(activeFor("/automations")).toEqual(["Automation"]);
    expect(activeFor("/automation/status")).toEqual(["Automation"]);
    expect(activeFor("/automation/bots/ndx_ema_bias")).toEqual(["Automation"]);
    expect(activeFor("/positions")).toEqual(["Positions"]);
  });

  it("highlights Bybit (and only Bybit) on the Live page", () => {
    expect(activeFor("/automation/live")).toEqual(["Bybit"]);
  });
});
