import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TriggerOption } from "@/lib/automation/types";
import { WebhookAttachPanel, directionMismatch } from "./WebhookAttachPanel";

const noop = () => undefined;
const option = (name: string): TriggerOption => ({ id: name, name, active: true, available: true, attachedHere: false, reason: null });

describe("a webhook named for the other direction", () => {
  it("is flagged on the trigger it doesn't fit, for either direction", () => {
    expect(directionMismatch("bullish", "BearishSPX")).toMatch(/sounds like a bearish webhook, but this is the bullish trigger/);
    expect(directionMismatch("bearish", "bullish_ndx")).toMatch(/sounds like a bullish webhook, but this is the bearish trigger/);
    expect(directionMismatch("bullish", "SPX BEARISH alert")).not.toBeNull();
  });

  it("says nothing when the name fits, says both, says neither, or there is no choice yet", () => {
    expect(directionMismatch("bullish", "BullishSPX")).toBeNull();
    expect(directionMismatch("bearish", "BearishSPX")).toBeNull();
    expect(directionMismatch("bullish", "Bullish and Bearish")).toBeNull();
    expect(directionMismatch("bullish", "My SPX hook")).toBeNull();
    expect(directionMismatch("bullish", undefined)).toBeNull();
    expect(directionMismatch("bullish", "unbearish")).toBeNull(); // not the word on its own
  });
});

const panel = (automationName: string, selected: string) =>
  renderToStaticMarkup(
    <WebhookAttachPanel
      triggerName={automationName}
      automationName={automationName}
      otherAutomationName="x"
      current={null}
      options={[option("BullishSPX"), option("BearishSPX")]}
      selected={selected}
      onSelect={noop}
      alwaysOn
      onAlwaysOn={noop}
      onSave={noop}
      saveDisabled={false}
      onDetach={noop}
      onCreate={async () => null}
      onCopy={noop}
      busy={false}
    />,
  );

describe("the attach panel", () => {
  it("warns when a Bearish-named webhook is chosen for the Bullish signal, and not for the right one", () => {
    expect(panel("Bullish signal", "BearishSPX")).toContain('role="alert"');
    expect(panel("Bullish signal", "BearishSPX")).toContain("sounds like a bearish webhook");
    expect(panel("Bullish signal", "BullishSPX")).not.toContain('role="alert"');
    expect(panel("Bearish signal", "BullishSPX")).toContain("sounds like a bullish webhook");
    expect(panel("Bearish signal", "")).not.toContain('role="alert"');
  });
});
