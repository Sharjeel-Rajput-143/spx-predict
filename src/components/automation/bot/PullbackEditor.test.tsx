import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LIVE_CHAIN_WARNING, PullbackEditor, numbersBody, toggleChainAction, type PullbackValues } from "./PullbackEditor";

// THE ONE PULLBACK CARD both Bybit bots use. Display and the two actions that need care; the server's rules are tested in pullbackLive.test.ts and pullbackExit.test.ts.

const values = (over: Partial<PullbackValues> = {}): PullbackValues => ({ enabled: true, fallUsd: 0.03, minPeakUsd: 0.12, chainEnabled: false, chainStopUsd: 0.03, chainMax: 10, ...over });
const html = (pb: PullbackValues, extra: { live?: boolean; chainRunning?: { trades: number } | null } = {}) => renderToStaticMarkup(<PullbackEditor pb={pb} save={() => undefined} {...extra} />).replace(/<!-- -->/g, "");

describe("the card shows the values of the bot it was given", () => {
  it("the defaults: pullback exit ON, $0.03 fall, $0.12 minimum peak, chain OFF", () => {
    const m = html(values());
    expect(m).toContain("Pullback exit");
    expect(m).toMatch(/aria-label="Fall from the peak in dollars"[^>]*value="0.03"|value="0.03"[^>]*aria-label="Fall from the peak in dollars"/);
    expect(m).toMatch(/aria-label="Minimum peak in dollars"[^>]*value="0.12"|value="0.12"[^>]*aria-label="Minimum peak in dollars"/);
    expect(m).toContain("The default is $0.12");
    expect(m).toMatch(/aria-checked="true"[^>]*aria-label="Pullback exit on\/off"|aria-label="Pullback exit on\/off"[^>]*aria-checked="true"/);
    expect(m).toMatch(/aria-checked="false"[^>]*aria-label="Chain mode on\/off"|aria-label="Chain mode on\/off"[^>]*aria-checked="false"/);
  });
  it("two bots with different saved values show different numbers", () => {
    expect(html(values({ minPeakUsd: 0.3 }))).toMatch(/value="0.3"/);
    expect(html(values({ minPeakUsd: 0 }))).toMatch(/value="0"/);
    expect(html(values({ fallUsd: 0.05 }))).toMatch(/value="0.05"/);
  });
  it("the live card says it is the LIVE bot's, real money, with its own values; the demo card does not", () => {
    const live = html(values(), { live: true });
    expect(live).toContain('data-testid="pullback-live-chip"');
    expect(live).toContain("LIVE bot, real money");
    expect(live).toMatch(/counts in the day&#x27;s 5 trades and obeys the \$2 daily loss limit/);
    expect(live).toMatch(/LIVE bot&#x27;s own copy of the rule/);
    const demo = html(values());
    expect(demo).not.toContain("pullback-live-chip");
    expect(demo).not.toContain("real money");
    expect(demo).toMatch(/demo bot&#x27;s own copy/);
  });
  it("shows a running chain", () => {
    expect(html(values({ chainEnabled: true }), { chainRunning: { trades: 3 } })).toContain("A chain is running: 3 chain trade(s) so far.");
    expect(html(values())).not.toContain("A chain is running");
  });
});

describe("Save numbers sends the four numbers as numbers", () => {
  it("exactly what was typed", () => {
    expect(numbersBody({ fall: "0.05", minPeak: "0.2", chainStop: "0.04", chainMax: "7" })).toEqual({ fallUsd: 0.05, minPeakUsd: 0.2, chainStopUsd: 0.04, chainMax: 7 });
    expect(numbersBody({ fall: "0.03", minPeak: "0", chainStop: "0.03", chainMax: "10" }).minPeakUsd).toBe(0); // a typed 0 is sent as 0 (no minimum)
  });
});

describe("the chain switch", () => {
  it("on the LIVE bot, turning the chain ON asks first, in words about real money; a 'no' sends nothing", () => {
    const save = vi.fn();
    const no = vi.fn(() => false);
    expect(toggleChainAction({ pb: values(), live: true, confirm: no, save })).toBe(false);
    expect(no).toHaveBeenCalledWith(LIVE_CHAIN_WARNING);
    expect(LIVE_CHAIN_WARNING).toMatch(/LIVE bot/);
    expect(LIVE_CHAIN_WARNING).toMatch(/REAL money/);
    expect(LIVE_CHAIN_WARNING).toMatch(/stop loss at Bybit/);
    expect(LIVE_CHAIN_WARNING).toMatch(/\$2 daily loss limit/);
    expect(save).not.toHaveBeenCalled();
  });
  it("a 'yes' sends the change", () => {
    const save = vi.fn();
    expect(toggleChainAction({ pb: values(), live: true, confirm: () => true, save })).toBe(true);
    expect(save).toHaveBeenCalledWith({ chainEnabled: true }, "Chain mode on.");
  });
  it("turning it OFF on the live bot needs no question, and the demo bot is never asked", () => {
    const save = vi.fn();
    const ask = vi.fn(() => false);
    toggleChainAction({ pb: values({ chainEnabled: true }), live: true, confirm: ask, save });
    toggleChainAction({ pb: values(), live: false, confirm: ask, save });
    expect(ask).not.toHaveBeenCalled();
    expect(save.mock.calls).toEqual([[{ chainEnabled: false }, "Chain mode off."], [{ chainEnabled: true }, "Chain mode on."]]);
  });
});
