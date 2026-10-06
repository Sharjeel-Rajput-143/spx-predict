import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Run } from "@/lib/automation/types";
import { DecisionLog, RunTrace } from "./RunTrace";

const noop = () => undefined;
const html = (n: React.ReactElement) => renderToStaticMarkup(n);

// The run from the write-up: Decision -> Decision (true) -> Close card -> Decision (false) -> Open card -> End.
const run: Run = {
  id: "sig-1",
  botId: "b",
  signalId: "sig-1",
  source: "webhook",
  automation: "Bullish signal",
  trigger: "Webhook",
  startedAt: Date.UTC(2026, 9, 6, 19, 10), // 3:10pm ET
  nodes: [
    { kind: "decision", text: "Current market time is between 9:35am - 3:55pm", result: true, measured: "Current time is 3:10pm" },
    { kind: "decision", text: "Bot has exactly or more than 1 position with Short Call Spread type and any status", result: true, measured: "1 position" },
    {
      kind: "action",
      action: "close",
      title: "Close Position (SPX, Short Call Spread)",
      positionId: "pos-call",
      summary: "SPX Short Call Spread Oct 2 / -7,720 call, +7,725 call",
      params: [
        { label: "Price", value: "Close order with no limit price set" },
        { label: "Quantity", value: "3 contracts (100% of position)" },
      ],
      outcome: "closed",
      reason: "Close order filled.",
    },
    { kind: "decision", text: "Bot holds fewer than 1 Short Put Spread position", result: false, measured: "1 position" },
    {
      kind: "action",
      action: "open",
      title: "Open SPX Short Put Spread",
      positionId: "pos-put",
      summary: "SPX Short Put Spread Oct 2 / -7,700 put, +7,695 put",
      params: [{ label: "Price", value: "Limit credit $2.20" }, { label: "Short put", value: "7700 (7720.5 - 20, rounded to 5)" }],
      outcome: "opened",
      reason: "Opened new position.",
    },
  ],
};

const render = (r: Run = run, exists: (id: string) => boolean = () => true) =>
  html(<RunTrace run={r} positionExists={exists} onViewPosition={noop} onAutomation={noop} onClose={noop} />);

describe("Automation log - the replay", () => {
  it("has the header (automation link, Triggered by link), a start line, and ends with End", () => {
    const out = render();
    for (const t of ["Automation log", "Automation", "Bullish signal", "Triggered by", "Webhook", "Start automation", "Oct 6", "3:10"]) expect(out, t).toContain(t);
    expect(out).toMatch(/href="\/settings"[^>]*>Webhook</);
    expect(out.lastIndexOf("End")).toBeGreaterThan(out.indexOf("Open SPX Short Put Spread"));
  });

  it("shows every node visited, in order, with the recorded Yes/No under each check", () => {
    const out = render();
    const order = [
      "Current market time is between 9:35am - 3:55pm",
      "Bot has exactly or more than 1 position with Short Call Spread type and any status",
      "Close Position (SPX, Short Call Spread)",
      "Bot holds fewer than 1 Short Put Spread position",
      "Open SPX Short Put Spread",
    ].map((t) => out.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out.match(/>Yes</g)).toHaveLength(2);
    expect(out.match(/>No</g)).toHaveLength(1);
    expect(out.match(/↓/g)).toHaveLength(run.nodes.length + 1); // one before each node, and before End
  });

  it("draws checks as the builder's orange-circle pill and actions as bordered result cards", () => {
    const out = render();
    expect(out.match(/bg-amber-500\/20/g)).toHaveLength(3); // three decision pills
    expect(out.match(/rounded-xl border border-line bg-surface px-4 py-3/g)).toHaveLength(2); // two action cards
  });

  it("an action card shows the exact legs, a View position button, and a dark tooltip with the settings as sent", () => {
    const out = render();
    expect(out).toContain("SPX Short Call Spread Oct 2 / -7,720 call, +7,725 call");
    expect(out).toContain("SPX Short Put Spread Oct 2 / -7,700 put, +7,695 put");
    expect(out.match(/>View position</g)).toHaveLength(2);
    expect(out).toContain('role="tooltip"');
    expect(out).toContain("bg-neutral-900");
    expect(out).toContain("As sent");
    expect(out).toContain("Close order with no limit price set");
    expect(out).toContain("7700 (7720.5 - 20, rounded to 5)");
  });

  it("a position that no longer exists can't be viewed", () => {
    expect(render(run, () => false).match(/<button[^>]*disabled[^>]*>View position<\/button>/g)).toHaveLength(2);
  });

  it("a failed order shows its outcome and reason instead of looking like a success", () => {
    const failed: Run = { ...run, nodes: [{ ...(run.nodes[2] as Extract<Run["nodes"][number], { kind: "action" }>), outcome: "close_rejected", reason: "broker down", positionId: null }] };
    const out = render(failed);
    expect(out).toContain("Close rejected");
    expect(out).toContain("broker down");
    expect(out).not.toContain(">View position<");
  });

  it("a manual run has plain 'Triggered by' text, not a link", () => {
    const out = render({ ...run, source: "ui", trigger: "Manual action", automation: "Manual position" });
    expect(out).toContain("Manual action");
    expect(out).not.toMatch(/href="\/settings"/);
  });

  it("a run that stopped at its first check is just that check, then End", () => {
    const out = render({ ...run, nodes: [{ kind: "decision", text: "Bot is switched on", result: false, measured: "Bot is off" }] });
    expect(out).toContain("Bot is switched on");
    expect(out).toContain(">No<");
    expect(out).not.toContain("View position");
    expect(out).toContain(">End<");
  });
});

describe("Decision log - the value that was checked", () => {
  const log = (node: Extract<Run["nodes"][number], { kind: "decision" }>) => html(<DecisionLog node={node} run={run} onBack={noop} onClose={noop} />);

  it("a passed check: green check, the condition, and the measured value", () => {
    const out = log({ kind: "decision", text: "Current market time is between 9:35am - 3:55pm", result: true, measured: "Current time is 9:40am" });
    expect(out).toContain("Decision log");
    expect(out).toContain('aria-label="Passed"');
    expect(out).toContain("bg-up-soft");
    expect(out).toContain("✓");
    expect(out).toContain("Current time is 9:40am");
    expect(out).toContain('aria-label="Back"');
    expect(out).toContain("the run carried on");
  });

  it("a failed check: red ×, and the value that failed it", () => {
    const out = log({ kind: "decision", text: "Bot has exactly or more than 1 position with Short Call Spread type and any status", result: false, measured: "0 positions" });
    expect(out).toContain('aria-label="Failed"');
    expect(out).toContain("bg-down-soft");
    expect(out).toContain("×");
    expect(out).toContain("0 positions");
    expect(out).toContain("the run stopped here");
  });
});
