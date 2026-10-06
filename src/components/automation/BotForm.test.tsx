import { describe, expect, it } from "vitest";
import { validateInputs } from "@/lib/automation/bots";
import { BLANK_FORM, formFromTemplate, toInputs } from "./BotForm";

describe("New bot form", () => {
  it("has no default for the short strike offsets or the expected credit", () => {
    expect(BLANK_FORM.putShortOffset).toBe("");
    expect(BLANK_FORM.callShortOffset).toBe("");
    expect(BLANK_FORM.openingCreditEstimate).toBe("");
  });

  it("an untouched blank form is rejected by the same validation the server uses", () => {
    const inputs = toInputs({ ...BLANK_FORM, name: "Anything" });
    expect(inputs.putShortOffset).toBeUndefined();
    expect(validateInputs(inputs)).toMatch(/offset/i);
  });

  it("a fully filled form is accepted", () => {
    const inputs = toInputs({ ...BLANK_FORM, name: "Ok", putShortOffset: "-20", callShortOffset: "20", openingCreditEstimate: "2" });
    expect(validateInputs(inputs)).toBeNull();
  });

  it("seeds from a template but never copies its name", () => {
    const form = formFromTemplate({
      id: "t",
      name: "Tpl",
      createdAt: 0,
      config: { name: "Orig", accountId: "paper-3", underlying: "SPX", quantity: 2, widthPoints: 10, strikeIncrement: 5, putShortOffset: -30, callShortOffset: 25, allocationLimit: 9000, openingCreditEstimate: 3 },
    });
    expect(form).toMatchObject({ name: "", accountId: "paper-3", widthPoints: "10", putShortOffset: "-30" });
  });

  it("accepts decimal offsets, like the live bot's -0.01 / +0.01", () => {
    const inputs = toInputs({ ...BLANK_FORM, name: "Ok", putShortOffset: "-0.01", callShortOffset: "0.01", openingCreditEstimate: "2" });
    expect(inputs).toMatchObject({ putShortOffset: -0.01, callShortOffset: 0.01 });
    expect(validateInputs(inputs)).toBeNull();
  });

  it("defaults to out-of-the-money rounding and 100% of bid/ask, and carries a changed choice through", () => {
    expect(BLANK_FORM).toMatchObject({ strikeRounding: "outward", openPricePercent: "100", closePricePercent: "100" });
    const inputs = toInputs({ ...BLANK_FORM, name: "Ok", putShortOffset: "-1", callShortOffset: "1", openingCreditEstimate: "2", strikeRounding: "nearest", openPricePercent: "90" });
    expect(inputs).toMatchObject({ strikeRounding: "nearest", openPricePercent: 90, closePricePercent: 100 });
    expect(validateInputs({ ...inputs, openPricePercent: 150 })).toMatch(/percent of bid\/ask/);
  });

  it("editing a built-in bot keeps what the form doesn't show - the underlying, option root, price range, sweep time", () => {
    const base = { name: "NDX", accountId: "paper-ndx", underlying: "NDX", quantity: 1, widthPoints: 10, strikeIncrement: 5, putShortOffset: -0.01, callShortOffset: 0.01, allocationLimit: 2000, openingCreditEstimate: 3.5, optionRoot: "NDXP", eodSweepTime: "16:15", priceRange: { min: 15000, max: 30000 }, id: "ndx_ema_bias" } as never;
    const edited = toInputs({ ...formFromTemplate({ id: "t", name: "t", createdAt: 0, config: base }), name: "NDX", widthPoints: "10" }, base);
    expect(edited).toMatchObject({ underlying: "NDX", optionRoot: "NDXP", eodSweepTime: "16:15", priceRange: { min: 15000, max: 30000 } });
    expect(edited).not.toHaveProperty("id");
  });
});
