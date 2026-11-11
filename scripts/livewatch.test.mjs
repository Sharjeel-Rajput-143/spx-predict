import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { FAILS_TO_ALARM, MAC_EVERY_MS, step } from "./livewatch.mjs";

const T0 = 1_000_000_000_000;
/** Feeds a list of looks (ok / not ok, seconds apart) and returns every action that came out, with its second. */
function run(looks, { maintenanceUntil = 0 } = {}) {
  let state = {};
  const out = [];
  looks.forEach(([ok, atSec]) => {
    const r = step({ ok, now: T0 + atSec * 1000, maintenanceUntil, state });
    state = r.state;
    for (const a of r.actions) out.push([atSec, a]);
  });
  return out;
}

describe("the down-watcher", () => {
  it("says nothing while the app answers", () => {
    expect(run([[true, 0], [true, 30], [true, 60]])).toEqual([]);
  });
  it("one missed look is not an alarm; two in a row (about a minute) is", () => {
    expect(FAILS_TO_ALARM).toBe(2);
    expect(run([[false, 0]])).toEqual([]);
    expect(run([[false, 0], [false, 30]])).toEqual([[30, "mac-down"]]);
  });
  it("a single blip between good looks never alarms", () => {
    expect(run([[true, 0], [false, 30], [true, 60], [false, 90], [true, 120]])).toEqual([]);
  });
  it("keeps ringing the Mac every minute while down", () => {
    const out = run(Array.from({ length: 22 }, (_, i) => [false, i * 30]));
    expect(out.every(([, a]) => a === "mac-down")).toBe(true);
    expect(out.map(([t]) => t).slice(0, 4)).toEqual([30, 90, 150, 210]);
    expect(MAC_EVERY_MS).toBe(60_000);
  });
  it("tells you once when it is back, and then resets", () => {
    const out = run([[false, 0], [false, 30], [true, 60], [true, 90]]);
    expect(out.filter(([, a]) => a === "mac-recovered")).toEqual([[60, "mac-recovered"]]);
    // down again later: it rings again at once
    const again = run([[false, 0], [false, 30], [true, 60], [false, 90], [false, 120]]);
    expect(again.filter(([, a]) => a === "mac-down").map(([t]) => t)).toEqual([30, 120]);
  });
  it("stays quiet during a release on purpose, and a release that ends does not leave a half-counted failure behind", () => {
    const until = (T0 + 100_000);
    expect(run([[false, 0], [false, 30], [false, 60]], { maintenanceUntil: until })).toEqual([]);
    // the flag has expired: it needs two fresh failures
    const out = run([[false, 0], [false, 30], [false, 60], [false, 110], [false, 140]], { maintenanceUntil: until });
    expect(out.map(([t]) => t)).toEqual([140]);
  });
});
