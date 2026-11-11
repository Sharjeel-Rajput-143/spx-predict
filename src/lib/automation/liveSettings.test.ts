import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_LIMITS } from "./bybitLiveLimits";
import { DEFAULT_LIVE_SETTINGS, __resetLiveSettings, bootLiveSettings, enableLive, turnMirrorOff, liveDataDir, readLiveSettings, sanitize, setStage, turnLiveOff, updateLiveSettings } from "./liveSettings";

const ok = { gate: { ok: true, why: "" }, keyPresent: true, preflightOk: true, confirmed: true };
const file = () => path.join(liveDataDir(), "settings.json");
const asRestart = () => {
  (globalThis as { __liveBooted?: boolean }).__liveBooted = false; // a new process
};

beforeEach(() => __resetLiveSettings());
afterEach(() => {
  vi.restoreAllMocks();
  __resetLiveSettings();
});

describe("the live settings start safe", () => {
  it("everything is OFF, nothing is waiting to resume, and the numbers are the agreed ones when nothing was ever saved", () => {
    expect(readLiveSettings()).toEqual(DEFAULT_LIVE_SETTINGS);
    expect(DEFAULT_LIVE_SETTINGS).toMatchObject({ enabled: false, mirrorEnabled: false, resume: false, stage: 1, dailyLossUsd: 2, typedAt: null });
  });
  it("lives in its own folder, never inside the demo records", () => {
    expect(liveDataDir()).toContain("spx-predict-live-test-");
    expect(liveDataDir()).not.toBe(process.env.AUTOMATION_DATA_DIR);
    expect(liveDataDir().startsWith(String(process.env.AUTOMATION_DATA_DIR))).toBe(false);
  });
  it("a damaged or hostile file reads as the safe defaults", () => {
    fs.mkdirSync(liveDataDir(), { recursive: true });
    fs.writeFileSync(file(), "{not json");
    expect(readLiveSettings()).toEqual(DEFAULT_LIVE_SETTINGS);
    fs.writeFileSync(file(), JSON.stringify({ enabled: "yes", mirrorEnabled: 1, resume: "true", stage: 9, dailyLossUsd: 5000, warnings: "x", typedAt: "now" }));
    expect(readLiveSettings()).toMatchObject({ enabled: false, mirrorEnabled: false, resume: false, stage: 1, dailyLossUsd: 3, warnings: [], typedAt: null });
  });
  it("a saved daily loss above the ceiling is read as the ceiling; nonsense as the default", () => {
    expect(sanitize({ dailyLossUsd: 50 }).dailyLossUsd).toBe(LIVE_LIMITS.dailyLossCeilingUsd);
    expect(sanitize({ dailyLossUsd: -1 }).dailyLossUsd).toBe(2);
    expect(sanitize({ dailyLossUsd: 1.5 }).dailyLossUsd).toBe(1.5);
  });
});

describe("turning live ON takes one confirm, a passed check and a key (no typed word)", () => {
  it("no confirm: refused, whatever else is sent (a typed word does nothing)", () => {
    for (const confirmed of [undefined, false, "true", 1, "LIVE"] as never[]) {
      expect(enableLive({ ...ok, confirmed }), String(confirmed)).toMatchObject({ ok: false, reason: expect.stringMatching(/Confirm that real money/) });
    }
    expect(enableLive({ ...ok, confirmed: undefined, typed: "LIVE" } as never)).toMatchObject({ ok: false });
    expect(readLiveSettings()).toMatchObject({ enabled: false, mirrorEnabled: false, resume: false });
  });
  it("no key, or a check that did not pass, is refused with the reason", () => {
    expect(enableLive({ ...ok, keyPresent: false })).toMatchObject({ ok: false, reason: expect.stringMatching(/no live key/) });
    expect(enableLive({ ...ok, preflightOk: false, preflightWhy: "cross margin" })).toMatchObject({ ok: false, reason: expect.stringMatching(/cross margin/) });
    expect(readLiveSettings()).toMatchObject({ enabled: false, mirrorEnabled: false, resume: false });
  });
  it("with all of it, the toggle AND the mirror go ON in one write, and the ON state is saved for a resume", () => {
    expect(enableLive(ok, 1234)).toEqual({ ok: true });
    expect(readLiveSettings()).toMatchObject({ enabled: true, mirrorEnabled: true, resume: true, typedAt: 1234, offReason: null });
    expect(JSON.parse(fs.readFileSync(file(), "utf8"))).toMatchObject({ enabled: true, mirrorEnabled: true, resume: true });
  });
  it("stage 1 is not held up by the live gate; stage 2 is", () => {
    expect(enableLive({ ...ok, gate: { ok: false, why: "0 of 6" } })).toEqual({ ok: true });
    expect(readLiveSettings()).toMatchObject({ enabled: true, stage: 1 });
    turnLiveOff("test");
    expect(setStage(2, { ok: false, why: "tests passed 0 of 6" })).toMatchObject({ ok: false });
    expect(readLiveSettings().stage).toBe(1);
    expect(setStage(2, { ok: true, why: "" })).toEqual({ ok: true });
    expect(enableLive({ ...ok, gate: { ok: false, why: "0 of 6" } })).toMatchObject({ ok: false, reason: expect.stringMatching(/Stage 2 needs the live gate/) });
    expect(enableLive(ok)).toEqual({ ok: true });
  });
  it("a change of stage turns the toggle OFF and clears the saved ON state, and going back to stage 1 is always allowed", () => {
    enableLive(ok);
    expect(setStage(2, { ok: true, why: "" })).toEqual({ ok: true });
    expect(readLiveSettings()).toMatchObject({ enabled: false, resume: false, stage: 2 });
    expect(setStage(1, { ok: false, why: "" })).toEqual({ ok: true });
    expect(readLiveSettings().stage).toBe(1);
  });
  it("records when it was turned ON, and clears the last OFF reason", () => {
    turnLiveOff("a test");
    expect(readLiveSettings().offReason).toBe("a test");
    enableLive(ok, 1234);
    expect(readLiveSettings()).toMatchObject({ enabled: true, typedAt: 1234, offReason: null });
  });
  it("a write that fails leaves everything OFF, and nothing saved to resume", () => {
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(enableLive(ok)).toMatchObject({ ok: false, reason: expect.stringMatching(/stays OFF/) });
    expect(readLiveSettings()).toMatchObject({ enabled: false, mirrorEnabled: false, resume: false });
  });
});

describe("the auto resume door (enableLive with resume: true)", () => {
  it("is refused when there is no saved ON state, whatever else is true", () => {
    expect(enableLive({ resume: true, gate: ok.gate, keyPresent: true, preflightOk: true })).toMatchObject({ ok: false, reason: expect.stringMatching(/nothing to resume/) });
    expect(readLiveSettings().enabled).toBe(false);
  });
  it("needs the key, the passed check and (stage 2) the gate, just like a click", () => {
    enableLive(ok);
    turnLiveOff("x"); // clears the saved state
    expect(enableLive({ resume: true, gate: ok.gate, keyPresent: true, preflightOk: true })).toMatchObject({ ok: false });
    // a restart with the toggle ON keeps the saved state
    enableLive(ok);
    asRestart();
    bootLiveSettings(5);
    expect(enableLive({ resume: true, gate: ok.gate, keyPresent: false, preflightOk: true })).toMatchObject({ ok: false, reason: expect.stringMatching(/no live key/) });
    expect(enableLive({ resume: true, gate: ok.gate, keyPresent: true, preflightOk: false })).toMatchObject({ ok: false });
    expect(readLiveSettings().enabled).toBe(false);
    expect(enableLive({ resume: true, gate: ok.gate, keyPresent: true, preflightOk: true }, 6)).toEqual({ ok: true });
    expect(readLiveSettings()).toMatchObject({ enabled: true, mirrorEnabled: true, resume: true });
  });
});

describe("turning live OFF", () => {
  it("says why and when, stays OFF, and clears the saved ON state; the mirror is left as it is", () => {
    enableLive(ok);
    turnLiveOff("STOP LOSS ALARM: x", 777);
    expect(readLiveSettings()).toMatchObject({ enabled: false, resume: false, mirrorEnabled: true, offReason: "STOP LOSS ALARM: x", offAt: 777 });
  });
  it("turnMirrorOff always turns the mirror OFF, and can be undone only by a deliberate ON", () => {
    enableLive(ok);
    turnLiveOff("x");
    turnMirrorOff("none held");
    expect(readLiveSettings().mirrorEnabled).toBe(false);
    expect(enableLive(ok)).toEqual({ ok: true });
    expect(readLiveSettings()).toMatchObject({ enabled: true, mirrorEnabled: true });
  });
  it("is OFF even when the disk will not take the write", () => {
    enableLive(ok);
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    turnLiveOff("alarm");
    vi.restoreAllMocks();
    expect(readLiveSettings().enabled).toBe(false); // the file still says ON; the in-memory OFF wins
  });
  it("after a failed OFF write, turning it ON again takes the confirm again", () => {
    enableLive(ok);
    turnLiveOff("x");
    expect(readLiveSettings().enabled).toBe(false);
    expect(enableLive({ ...ok, confirmed: false })).toMatchObject({ ok: false });
    expect(enableLive(ok)).toEqual({ ok: true });
    expect(readLiveSettings().enabled).toBe(true);
  });
});

describe("a restart", () => {
  it("with the toggle ON and nothing tripped: it comes up OFF in memory and on disk, the saved ON state is kept, and a resume is waiting", () => {
    enableLive(ok);
    updateLiveSettings({ dailyLossUsd: 1 });
    asRestart();
    expect(bootLiveSettings(99)).toEqual({ resumePending: true });
    expect(readLiveSettings()).toMatchObject({ enabled: false, mirrorEnabled: false, resume: true, dailyLossUsd: 1, offReason: null });
    expect(JSON.parse(fs.readFileSync(file(), "utf8"))).toMatchObject({ enabled: false, mirrorEnabled: false, resume: true }); // on disk too
  });
  it("after an OFF click or any trip: nothing is waiting, and it stays OFF", () => {
    enableLive(ok);
    turnLiveOff("alarm");
    asRestart();
    expect(bootLiveSettings(99)).toEqual({ resumePending: false });
    expect(readLiveSettings()).toMatchObject({ enabled: false, resume: false });
  });
  it("a file from before the saved state existed (ON, no resume) comes up OFF with nothing to resume", () => {
    fs.mkdirSync(liveDataDir(), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ enabled: true, mirrorEnabled: true, stage: 1, dailyLossUsd: 2 }));
    expect(bootLiveSettings(99)).toEqual({ resumePending: false });
    expect(readLiveSettings()).toMatchObject({ enabled: false, mirrorEnabled: false, resume: false });
    expect(readLiveSettings().offReason).toMatch(/restarted/);
  });
  it("is OFF in memory even when the disk will not take the write", () => {
    enableLive(ok);
    asRestart();
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    bootLiveSettings(99);
    vi.restoreAllMocks();
    expect(readLiveSettings()).toMatchObject({ enabled: false, mirrorEnabled: false });
  });
  it("runs once per process", () => {
    enableLive(ok);
    asRestart();
    bootLiveSettings(1);
    expect(bootLiveSettings(2)).toEqual({ resumePending: false });
  });
});

describe("the other settings", () => {
  it("the mirror is OFF until the toggle is turned ON, and changing a setting never turns live ON", () => {
    expect(readLiveSettings().mirrorEnabled).toBe(false);
    updateLiveSettings({ mirrorEnabled: true });
    expect(readLiveSettings()).toMatchObject({ mirrorEnabled: true, enabled: false, resume: false });
  });
  it("the daily loss limit can be set lower, but a value above $3 is stored as $3", () => {
    updateLiveSettings({ dailyLossUsd: 1 });
    expect(readLiveSettings().dailyLossUsd).toBe(1);
    updateLiveSettings({ dailyLossUsd: 99 });
    expect(readLiveSettings().dailyLossUsd).toBe(3);
  });
  it("updating a setting never flips the toggle ON, or the saved ON state, even if the patch tries", () => {
    updateLiveSettings({ enabled: true, resume: true } as never);
    expect(readLiveSettings()).toMatchObject({ enabled: false, resume: false });
  });
});

describe("tests never touch a real folder", () => {
  it("the live folder here is in the system temp folder", () => {
    expect(liveDataDir().startsWith(os.tmpdir())).toBe(true);
  });
});
