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
});
