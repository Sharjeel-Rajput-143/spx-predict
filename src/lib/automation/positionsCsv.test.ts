import { describe, expect, it } from "vitest";
import { EXPORT_LIMIT, csvCell, positionsToCsv } from "./positionsCsv";
import { buildPosition } from "./testSupport";

describe("one cell", () => {
  it("plain values as they are, empty for nothing, quoted when they hold a comma, quote or line break", () => {
    expect(csvCell("NDX")).toBe("NDX");
    expect(csvCell(3.5)).toBe("3.5");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(Number.NaN)).toBe("");
    expect(csvCell("a, b")).toBe('"a, b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });
  it("text a spreadsheet would run as a formula is made harmless", () => {
    for (const bad of ["=SUM(A1:A9)", "+1", "-1+1", "@cmd", "\tx"]) expect(csvCell(bad).startsWith("'") || csvCell(bad).startsWith('"\'')).toBe(true);
    expect(csvCell(-5)).toBe("-5"); // a real negative number is a number, not text
  });
});

describe("the file", () => {
  const p = buildPosition({ id: "p1", botId: "b", underlying: "NDX", type: "short_put_spread", status: "closed", shortStrike: 20_970, longStrike: 20_960, credit: 4, closePrice: 1, requestedQuantity: 2, filledQuantity: 2, openedAt: Date.UTC(2026, 9, 6, 14, 0), closedAt: Date.UTC(2026, 9, 6, 15, 0), expiry: "2026-10-06", tags: ["a", "b"], notes: '=HYPERLINK("x")' });
  it("has a header and one line per position, with the result worked out", () => {
    const lines = positionsToCsv([p], () => "NDX Bias").trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("Position ID,Bot,Symbol,Strategy,Status,Opened (UTC),Closed (UTC),Expiration,Contracts,Short strike,Long strike,Credit,Close price,P/L,P/L source,Tags,Notes");
    expect(lines[1]).toBe('p1,NDX Bias,NDX,Short Put Spread,closed,2026-10-06T14:00:00.000Z,2026-10-06T15:00:00.000Z,2026-10-06,2,20970,20960,4,1,600,fill,a; b,"\'=HYPERLINK(""x"")"');
  });
  it("an empty list is just the header, and an unpriced position has an empty P/L", () => {
    expect(positionsToCsv([], () => "x").trim().split("\r\n")).toHaveLength(1);
    const open = buildPosition({ id: "o", botId: "b", type: "short_call_spread", status: "open" });
    expect(positionsToCsv([open], () => "x").split("\r\n")[1]).toMatch(/,,,/);
  });
  it("holds at most 10,000 positions", () => {
    const many = Array.from({ length: EXPORT_LIMIT + 5 }, (_, i) => buildPosition({ id: `m${i}`, botId: "b", type: "short_put_spread", status: "closed" }));
    expect(positionsToCsv(many, () => "x").trim().split("\r\n")).toHaveLength(EXPORT_LIMIT + 1);
  });
});
