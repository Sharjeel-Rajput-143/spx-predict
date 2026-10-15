import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Assessment } from "@/lib/automation/positionResolve";
import { ResolveView } from "./ResolvePanel";

// What the Resolve window shows for each answer the broker can give. Server-render checks: no browser, no network.

const noop = () => undefined;
const base: Assessment = {
  positionId: "p1", status: "closing", resolvable: true, verdict: null, headline: "", detail: "", held: null, expected: { short: -1, long: 1 },
  workingOrders: [], fill: null, actions: [], needsPrice: false, canRetryClose: false, noBroker: false,
};
const view = (a: Partial<Assessment>, over: Partial<Parameters<typeof ResolveView>[0]> = {}) =>
  renderToStaticMarkup(<ResolveView assessment={{ ...base, ...a }} confirmed={false} onConfirm={noop} price="" onPrice={noop} busy={null} onAct={noop} onRetryClose={noop} {...over} />);

describe("the Resolve window", () => {
  it("the broker still holds the spread: says so, shows both sides, offers Return to open and the existing close", () => {
    const out = view({ verdict: "holds_spread", headline: "The broker still holds the whole spread.", detail: "Nothing is working.", held: { short: -1, long: 1 }, actions: ["return_to_open"], canRetryClose: true });
    expect(out).toContain("The broker still holds the whole spread.");
    expect(out).toContain("broker asked");
    expect(out).toContain("Our records say");
    expect(out).toContain("closing; it should hold -1 short leg and +1 long leg");
    expect(out).toContain("-1 short leg and 1 long leg");
    expect(out).toContain("Return to open");
    expect(out).toContain("Close position (try the close again)");
    expect(out).toContain("I have seen what the broker shows and want to do this.");
    expect(out).not.toContain("Mark closed");
  });

  it("nothing is done until the person confirms: every action is disabled while the box is unticked, and enabled when ticked", () => {
    const a = { verdict: "holds_nothing" as const, headline: "The broker holds nothing.", held: { short: 0, long: 0 }, actions: ["mark_closed" as const], fill: { price: 1.2, quantity: 1 } };
    const off = view(a);
    expect(off).toMatch(/<button[^>]*\sdisabled=""[^>]*><span>Mark closed<\/span>/);
    const on = view(a, { confirmed: true });
    expect(on).not.toMatch(/<button[^>]*\sdisabled=""[^>]*><span>Mark closed<\/span>/);
    expect(on).toContain("Broker&#x27;s fill");
    expect(on).toContain("1 at $1.20");
  });

  it("asks for a price only when the broker's own order could not give one", () => {
    const withFill = view({ verdict: "holds_nothing", actions: ["mark_closed"], needsPrice: false, fill: { price: 1.2, quantity: 1 } });
    expect(withFill).not.toContain("Price per spread");
    const without = view({ verdict: "holds_nothing", actions: ["mark_closed"], needsPrice: true });
    expect(without).toContain('aria-label="Price per spread"');
    expect(without).toContain("Price it closed at (per spread)");
    expect(view({ status: "opening", verdict: "holds_spread", actions: ["mark_open"], needsPrice: true })).toContain("Credit it opened at (per spread)");
  });

  it("an order still working: only the cancel is offered, and the working order is named", () => {
    const out = view({ verdict: "order_working", headline: "An order for this position is still working.", actions: ["cancel_orders"], workingOrders: [{ id: "o1", ref: "ib-4", kind: "close", status: "working" }] });
    expect(out).toContain("Cancel the working order");
    expect(out).toContain("close order ib-4 (working)");
    expect(out).not.toContain("Return to open");
  });

  it("something else is held: nothing can be done from here, and there are no buttons to press", () => {
    const out = view({ verdict: "other_holdings", headline: "The account holds something else.", detail: "Expected 1 but ...", held: { short: -1, long: 0 }, actions: [] });
    expect(out).toContain("Nothing can be done from here. Fix it at the broker, then open this again.");
    expect(out).not.toContain("I have seen what the broker shows");
    expect(out).not.toMatch(/<button/);
  });

  it("a broker that can't be reached is shown as that, with nothing to press", () => {
    const out = view({ verdict: "broker_unreachable", headline: "The broker could not be reached, so nothing is offered.", actions: [] });
    expect(out).toContain("broker unreachable");
    expect(out).toContain("Nothing can be done from here");
  });

  it("a simulated position says no broker was asked, in the pill, the table and the confirmation", () => {
    const out = view({ verdict: "no_broker", noBroker: true, headline: "This is a simulated position: there is no broker account to ask.", actions: ["return_to_open", "mark_closed"], needsPrice: true });
    expect(out).toContain("no broker asked");
    expect(out).toContain("not asked");
    expect(out).toContain("I know no broker account was asked. This is what really happened.");
    expect(out).toContain("Return to open");
    expect(out).toContain("Mark closed");
  });

  it("while an action runs its button says so and every button is off", () => {
    const out = view({ verdict: "holds_nothing", actions: ["mark_closed"], fill: { price: 1, quantity: 1 } }, { confirmed: true, busy: "mark_closed" });
    expect(out).toContain("Marking…");
    expect(out).toMatch(/<button[^>]*\sdisabled=""[^>]*><span>Marking…<\/span>/);
  });

  it("a position that isn't stuck just says so", () => {
    expect(view({ resolvable: false, headline: "Nothing to resolve: this position is open." })).toContain("Nothing to resolve: this position is open.");
  });

  it("the retry-close button is only there when the broker still holds the spread and the page can retry", () => {
    expect(view({ canRetryClose: true, actions: ["return_to_open"] }, { onRetryClose: undefined })).not.toContain("try the close again");
    expect(view({ canRetryClose: false, actions: ["return_to_open"] })).not.toContain("try the close again");
  });
});
