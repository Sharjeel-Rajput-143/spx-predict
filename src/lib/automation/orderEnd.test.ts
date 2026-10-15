import { describe, expect, it } from "vitest";
import { brokerSaid, readBrokerTrail, trailText } from "./orderEnd";

describe("what a Log entry says about an order that ended", () => {
  const trail = { ibkrStatus: "Cancelled", permId: 7, events: [{ time: "1", status: "A" }, { time: "2", status: "B" }, { time: "3", status: "C" }, { time: "4", status: "Cancelled", code: 202, message: "too far" }] };

  it("names the IBKR status, the permanent id and only the last three events", () => {
    expect(trailText(trail)).toBe('IBKR status Cancelled (permId 7); last events: 2 B; 3 C; 4 Cancelled [202] "too far"');
    expect(trailText({})).toBe("");
    expect(trailText({ permId: 9 })).toBe("permId 9");
  });

  it("puts the broker's words first, then the trail, and says plainly when there is nothing", () => {
    expect(brokerSaid({ rejectReason: "No.", ...trail }, true)).toBe("The broker's words: No. IBKR status Cancelled (permId 7); last events: 2 B; 3 C; 4 Cancelled [202] \"too far\".");
    expect(brokerSaid({}, true)).toBe("The broker gave no reason, price band or events.");
    expect(brokerSaid({}, false)).toBe(""); // our own timeout: the broker was not asked to explain anything
    expect(brokerSaid({ priceBand: { marketPrice: 1 } }, true)).toBe(""); // the band is worded elsewhere
  });

  it("reads the trail defensively", () => {
    expect(readBrokerTrail({})).toEqual({});
    expect(readBrokerTrail({ events: [{ status: "Filled" }] })).toEqual({ events: [{ time: "", status: "Filled" }] });
  });
});
