import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusView, legsText, type StatusResponse } from "./StatusDashboard";

const noop = () => undefined;

const data = (over: Partial<StatusResponse> = {}): StatusResponse => ({
  now: Date.UTC(2026, 9, 6, 14, 40),
  executor: { kind: "mock", venue: "mock", error: null, dryRun: false, testMode: true },
  bots: [
    { id: "ndx_ema_bias", name: "NDX EMA 9/20 Bias", underlying: "NDX", enabled: true, needsAttention: false, needsAttentionReason: null, configError: null, missingSettings: null, errorCountToday: 0, errorFailsafeThreshold: 10, newPositionsToday: 2, dailyNewPositionLimit: 10, activePositionCount: 1, closedPositionCount: 1, totalPositionLimit: 1, suggestedPrice: 21_003.7, allocation: 2000, atRisk: 650, available: 1350, settings: { quantity: 1, widthPoints: 10, strikeIncrement: 5, putShortOffset: -0.01, callShortOffset: 0.01, strikeRounding: "outward", openPricePercent: 100, closePricePercent: 100, smartPricing: "normal", window: "9:35am - 3:55pm", alerts: { open: true, close: true, warning: true, error: true } } },
    { id: "spx_ema_bias", name: "SPX EMA 9/20 Bias", underlying: "SPX", enabled: false, needsAttention: false, needsAttentionReason: null, configError: "SPX needs settings", missingSettings: [{ key: "BOT_SPX_EMA_BIAS_PUT_SHORT_OFFSET", why: "ask the owner" }], errorCountToday: 0, errorFailsafeThreshold: 10, newPositionsToday: 0, dailyNewPositionLimit: 10, activePositionCount: 0, closedPositionCount: 0, totalPositionLimit: 3, suggestedPrice: null, allocation: null, atRisk: 0, available: null, settings: null },
  ],
  positions: [
    { id: "p2", botId: "ndx_ema_bias", underlying: "NDX", type: "short_call_spread", status: "open", shortStrike: 21_035, longStrike: 21_045, requestedQuantity: 1, filledQuantity: 1, expiry: "2026-10-06", credit: 3.5, openedAt: 2, closedAt: null, venue: "mock", test: true },
    { id: "p1", botId: "ndx_ema_bias", underlying: "NDX", type: "short_put_spread", status: "closed", shortStrike: 20_975, longStrike: 20_965, requestedQuantity: 1, filledQuantity: 1, expiry: "2026-10-06", credit: 3.5, closePrice: null, openedAt: 1, closedAt: 2, venue: "mock", test: true },
  ],
  orders: [
    { id: "o1", botId: "ndx_ema_bias", kind: "open", status: "filled", limitPrice: 3.5, filledQuantity: 1, createdAt: 1, positionType: "short_put_spread", shortStrike: 20_975, longStrike: 20_965, underlying: "NDX", venue: "mock" },
    { id: "o2", botId: "ndx_ema_bias", kind: "close", status: "filled", limitPrice: 0, filledQuantity: 1, createdAt: 2, positionType: "short_put_spread", shortStrike: 20_975, longStrike: 20_965, underlying: "NDX", venue: "mock" },
  ],
  signals: [
    { id: "s2", botId: "ndx_ema_bias", signal: "bearish", price: 21_003.7, status: "accepted", rejectReason: null, receivedAt: 2, test: true, symbol: "NDX", decisions: [{ id: "d1", outcome: "closed", reason: "Closed short_put_spread position.", createdAt: 2 }, { id: "d2", outcome: "opened", reason: "Opened new position.", createdAt: 3 }] },
    { id: "s3", botId: "ndx_ema_bias", signal: "bullish", price: 0, status: "rejected", rejectReason: "bad_secret", receivedAt: 1, test: false, symbol: null, decisions: [] },
  ],
  alerts: [{ id: "a1", botId: "ndx_ema_bias", kind: "open", outcome: "opened", message: "NDX EMA 9/20 Bias: Opened new position.", createdAt: 3, email: "off" }],
  alertEmail: { enabled: false, to: null },
  ...over,
});

const render = (d: StatusResponse) => renderToStaticMarkup(<StatusView data={d} busyBot={null} results={{}} onToggle={noop} onSend={noop} onReset={noop} />);

describe("StatusView", () => {
  it("says it's the mock executor, and marks every position and order as TEST", () => {
    const html = render(data());
    expect(html).toContain("Mock executor — test trades only. Nothing reaches a broker.");
    // 2 positions + 2 orders + 1 test alert + 2 bot cards' "Send test alert" tags + the 2 alert rows' own tag
    expect((html.match(/>TEST</g) ?? []).length).toBeGreaterThanOrEqual(7);
  });

  it("shows the legs and credit of active and closed positions, in separate tables", () => {
    const html = render(data());
    expect(html).toContain("-21,035 call / +21,045 call");
    expect(html).toContain("-20,975 put / +20,965 put");
    expect(html).toContain("$3.50");
    expect(html.indexOf("Active positions")).toBeLessThan(html.indexOf("-21,035 call"));
    expect(html.indexOf("-21,035 call")).toBeLessThan(html.indexOf("Closed and expired positions"));
    expect(html.indexOf("Closed and expired positions")).toBeLessThan(html.indexOf("-20,975 put / +20,965 put"));
  });

  it("lists orders with their states and what each did", () => {
    const html = render(data());
    expect(html).toContain("Open (sell the spread)");
    expect(html).toContain("Close (buy it back)");
    expect(html).toContain("$3.50 credit");
    expect(html).toContain("no limit");
    expect(html).toContain(">filled<");
  });

  it("puts the decisions under each alert, and shows a rejected alert too", () => {
    const html = render(data());
    expect(html).toContain("Alerts and the decision for each");
    expect(html).toContain("Closed short_put_spread position.");
    expect(html).toContain("Opened new position.");
    expect(html).toContain("rejected: bad_secret");
  });

  it("has Bullish and Bearish test buttons for each bot, the bot's on/off state, and the suggested price", () => {
    const html = render(data());
    expect((html.match(/Bullish → short put spread/g) ?? []).length).toBe(2);
    expect((html.match(/Bearish → short call spread/g) ?? []).length).toBe(2);
    expect(html).toContain("On — click to turn off");
    expect(html).toContain("Off — click to turn on");
    expect(html).toContain('value="21003.7"');
  });

  it("a bot that isn't set up shows what's missing and can't be tested", () => {
    const html = render(data());
    expect(html).toContain("Setup needed");
    expect(html).toContain("PUT_SHORT_OFFSET");
    expect(html).toContain("Finish this bot&#x27;s setup first.");
  });

  it("shows the owner's numbers: allocation, capital at risk, available, positions today, active positions", () => {
    const html = render(data());
    for (const label of ["Allocation", "Capital at risk", "Available", "Positions today", "Active positions"]) expect(html).toContain(label);
    expect(html).toContain("$2,000");
    expect(html).toContain("$650");
    expect(html).toContain("$1,350");
    expect(html).toContain("2/10"); // positions today against the daily limit
    expect(html).toContain("1/1"); // active positions against the position limit
  });

  it("says how strikes are chosen: offsets, rounding, window, order price", () => {
    const html = render(data());
    expect(html).toContain("Short put -0.01 / short call +0.01");
    expect(html).toContain("out of the money (put down, call up)");
    expect(html).toContain("9:35am - 3:55pm");
    expect(html).toContain("100% (open) / 100% (close) of bid/ask");
  });

  it("lists activity alerts, with email off", () => {
    const html = render(data());
    expect(html).toContain("Activity alerts");
    expect(html).toContain(">Opened<");
    expect(html).toContain("NDX EMA 9/20 Bias: Opened new position.");
    expect(html).toContain("Email off");
    expect(render(data({ alertEmail: { enabled: true, to: "owner@example.invalid" } }))).toContain("queued only");
  });

  it("shows the target price, rounding and strikes under a decision", () => {
    const d = data();
    d.signals[0].decisions[1].strikePlan = "Target 21,003.69 (21,003.7 - 0.01), rounded down to 5 -> short 21,000, long 20,990";
    expect(render(d)).toContain("Target 21,003.69 (21,003.7 - 0.01), rounded down to 5 -&gt; short 21,000, long 20,990");
  });

  it("offers Reset test data on the mock executor", () => {
    expect(render(data())).toContain("Reset test data");
  });

  it("with a broker executor: no test alerts, no reset, and it says which Tradier", () => {
    const sandbox = render(data({ executor: { kind: "tradier", venue: "tradier", error: null, baseUrl: "https://sandbox.tradier.com/v1", sandbox: true, dryRun: false, testMode: false } }));
    expect(sandbox).toContain("Tradier SANDBOX (paper money)");
    expect(sandbox).not.toContain("Reset test data");
    // The sandbox is paper money, so test alerts are allowed there - and labelled PAPER, not TEST.
    expect(sandbox).not.toContain("Test alerts never run against real money");
    expect(sandbox).toContain(">PAPER<");
    const production = render(data({ executor: { kind: "tradier", venue: "tradier", error: null, baseUrl: "https://api.tradier.com/v1", sandbox: false, dryRun: false, testMode: false } }));
    expect(production).toContain("Test alerts never run against real money");
    const live = render(data({ executor: { kind: "tradier", venue: "tradier", error: null, baseUrl: "https://api.tradier.com/v1", sandbox: false, dryRun: false, testMode: false } }));
    expect(live).toContain("Tradier PRODUCTION");
  });

  it("production Tradier is a red LIVE - real money banner, the sandbox is not", () => {
    const live = render(data({ executor: { kind: "tradier", venue: "tradier", error: null, baseUrl: "https://api.tradier.com/v1", sandbox: false, dryRun: false, testMode: false } }));
    expect(live).toContain("LIVE — Tradier PRODUCTION: real money");
    expect(live).toContain("bg-down-soft");
    const sandbox = render(data({ executor: { kind: "tradier", venue: "tradier", error: null, baseUrl: "https://sandbox.tradier.com/v1", sandbox: true, dryRun: false, testMode: false } }));
    expect(sandbox).not.toContain("LIVE");
  });

  it("the broker check appears only with a broker executor, and says what it found", () => {
    const tradier = data({ executor: { kind: "tradier", venue: "tradier", error: null, baseUrl: "https://sandbox.tradier.com/v1", sandbox: true, dryRun: false, testMode: false } });
    const view = (reconcile: Parameters<typeof StatusView>[0]["reconcile"], d = tradier) => renderToStaticMarkup(<StatusView data={d} busyBot={null} results={{}} onToggle={noop} onSend={noop} onReset={noop} reconcile={reconcile} />);
    expect(view({ report: null, busy: false, error: null, onRun: noop })).toContain("Check broker positions");
    expect(view({ report: null, busy: false, error: null, onRun: noop })).toContain("never opens or closes anything");
    expect(view({ report: { checkedAt: 1, ok: true, expectedLegs: 2, brokerLegs: 2, problems: [] }, busy: false, error: null, onRun: noop })).toContain("All matched");
    const bad = view({ report: { checkedAt: 1, ok: false, expectedLegs: 2, brokerLegs: 1, problems: [{ kind: "missing_at_broker", symbol: "X", text: "X: we show 1 but the broker holds none." }] }, busy: false, error: null, onRun: noop });
    expect(bad).toContain("we show 1 but the broker holds none.");
    expect(view({ report: null, busy: true, error: null, onRun: noop })).toContain("Checking…");
    // The mock has no broker account to check.
    expect(view({ report: null, busy: false, error: null, onRun: noop }, data())).not.toContain("Check broker positions");
  });

  it("shows each bot's SmartPricing preset", () => {
    expect(render(data())).toContain("SmartPricing normal (needs live quotes)");
  });

  it("shows an unusable executor as an error and dry run as a label", () => {
    expect(render(data({ executor: { kind: "tradier", venue: "tradier", error: "EXECUTOR=tradier cannot start - required settings not set: TRADIER_TOKEN", dryRun: false, testMode: false } }))).toContain("signals are refused until this is fixed");
    expect(render(data({ executor: { kind: "mock", venue: "mock", error: null, dryRun: true, testMode: false } }))).toContain("Dry run: decisions only, no orders");
  });

  it("legsText reads short then long, put or call", () => {
    expect(legsText({ type: "short_put_spread", shortStrike: 7700, longStrike: 7695 })).toBe("-7,700 put / +7,695 put");
    expect(legsText({ type: "short_call_spread", shortStrike: 7740, longStrike: 7745 })).toBe("-7,740 call / +7,745 call");
    expect(legsText({ type: null, shortStrike: null, longStrike: null })).toBe("—");
  });
});
