import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BotContext } from "../bot/BotDetail";
import type { BotStaticConfig } from "@/lib/automation/types";
import { AutomationBuilder } from "./AutomationBuilder";
import { builtInFlow } from "./builtin";
import { CloseEditor, OpenEditor, TimeWindowEditor, inputsWith, liveNodeEditor } from "./LiveNodeEditors";
import { walk, type AutomationDraft, type Step } from "./model";

const noop = () => undefined;
const html = (node: React.ReactElement) => renderToStaticMarkup(node);

const config: BotStaticConfig = {
  id: "ndx_ema_bias",
  name: "NDX Bias Bot",
  accountId: "paper-ndx",
  underlying: "NDX",
  quantity: 1,
  widthPoints: 10,
  strikeIncrement: 5,
  putShortOffset: -0.01,
  callShortOffset: 0.01,
  allocationLimit: 2000,
  openingCreditEstimate: 3.5,
  optionRoot: "NDXP",
  eodSweepTime: "16:15",
  priceRange: { min: 15000, max: 30000 },
  strikeRounding: "outward",
  openPricePercent: 100,
  closePricePercent: 100,
  totalPositionLimit: 1,
};

function ctxFor(over: { config?: BotStaticConfig | null; activePositions?: number; patch?: BotContext["patch"] } = {}): BotContext {
  return {
    data: {
      config: over.config === undefined ? config : over.config,
      limits: { hours: { start: "09:35", end: "15:55", timezone: "America/New_York" } },
      counts: { activePositions: over.activePositions ?? 0 },
      bot: { configError: "NDX bot cannot start - required setting not set: X" },
    },
    reload: noop,
    notify: noop,
    patch: over.patch ?? (vi.fn(async () => true) as never),
    navigate: noop,
    openRun: noop,
    viewPosition: noop,
    focusPositionId: null,
    clearFocusPosition: noop,
  } as unknown as BotContext;
}

const stepOf = (kind: string, pick?: (s: Step) => boolean) => {
  let found: Step | undefined;
  walk(builtInFlow("bullish", config), (s) => {
    if (!found && s.kind === kind && (!pick || pick(s))) found = s;
  });
  return found!;
};
const timeStep = () => stepOf("decision", (s) => s.conditions?.[0]?.templateId === "bot_time");
const holdsStep = () => stepOf("decision", (s) => s.conditions?.[0]?.templateId === "bot_has_type");

describe("live editors on a built-in flow", () => {
  it("each editable node opens its own editor; a position check is explained, not editable", () => {
    const ctx = ctxFor();
    const render = (step: Step) => html(<>{liveNodeEditor({ step, direction: "bullish", ctx, onClose: noop })}</>);
    expect(render(timeStep())).toContain("Market time window");
    expect(render(stepOf("open_position"))).toContain("Open short put spread");
    expect(render(stepOf("close_position"))).toContain("Close position");
    const fixed = render(holdsStep());
    expect(fixed).toContain("Position check");
    expect(fixed).toContain("Fixed by the engine");
    expect(fixed).not.toContain(">Save<");
  });

  it("says plainly that the values are live, and warns when a position is open", () => {
    const out = html(<TimeWindowEditor ctx={ctxFor({ activePositions: 1 })} onClose={noop} />);
    expect(out).toContain("Live: these values are this bot&#x27;s real settings");
    expect(out).toContain("It keeps the values it was opened with.");
    expect(html(<TimeWindowEditor ctx={ctxFor()} onClose={noop} />)).not.toContain("It keeps the values");
  });

  it("the time editor offers the 5-minute marks and starts on the bot's window", () => {
    const out = html(<TimeWindowEditor ctx={ctxFor()} onClose={noop} />);
    expect(out).toContain("Current market time is between");
    expect(out).toContain('<option value="09:35" selected="">9:35am</option>');
    expect(out).toContain('<option value="15:55" selected="">3:55pm</option>');
    expect(out).toContain(">12:00pm<");
    // The default-window reset only appears once the bot has its own window.
    expect(out).not.toContain("Use the default window");
    expect(html(<TimeWindowEditor ctx={ctxFor({ config: { ...config, hours: { start: "10:00", end: "15:00" } } })} onClose={noop} />)).toContain("Use the default window (9:35am - 3:55pm)");
  });

  it("the open editor shows the real values, decimals included, for the right side", () => {
    const put = html(<OpenEditor direction="bullish" ctx={ctxFor()} onClose={noop} />);
    expect(put).toContain("Open short put spread");
    expect(put).toContain('aria-label="Short put offset" value="-0.01"');
    expect(put).toContain('aria-label="Spread width" value="10"');
    expect(put).toContain('aria-label="Contracts" value="1"');
    expect(put).toContain('aria-label="Expected credit" value="3.5"');
    expect(put).toContain("NDX");
    expect(put).toContain("Exactly 0 days (same day)");
    const call = html(<OpenEditor direction="bearish" ctx={ctxFor()} onClose={noop} />);
    expect(call).toContain("Open short call spread");
    expect(call).toContain('aria-label="Short call offset" value="0.01"');
  });

  it("the close editor shows the close side and its price", () => {
    const out = html(<CloseEditor direction="bullish" ctx={ctxFor()} onClose={noop} />);
    expect(out).toContain("NDX, short call spread");
    expect(out).toContain("100% of position");
    expect(out).toContain('aria-label="Close price percent" value="100"');
  });

  it("a bot without its inputs says so instead of offering fields", () => {
    for (const el of [<TimeWindowEditor key="t" ctx={ctxFor({ config: null })} onClose={noop} />, <OpenEditor key="o" direction="bullish" ctx={ctxFor({ config: null })} onClose={noop} />, <CloseEditor key="c" direction="bullish" ctx={ctxFor({ config: null })} onClose={noop} />]) {
      const out = html(el);
      expect(out).toContain("Not set up yet");
      expect(out).toContain("NDX bot cannot start");
      expect(out).not.toContain(">Save<");
    }
  });
});

describe("what a live save sends", () => {
  it("keeps every setting the editor doesn't show, and drops the id", () => {
    const next = inputsWith(config, { putShortOffset: -0.05, widthPoints: 10 });
    expect(next).toMatchObject({ putShortOffset: -0.05, callShortOffset: 0.01, underlying: "NDX", optionRoot: "NDXP", eodSweepTime: "16:15", priceRange: { min: 15000, max: 30000 }, totalPositionLimit: 1 });
    expect(next).not.toHaveProperty("id");
  });

  it("sets or clears the bot's own window", () => {
    expect(inputsWith(config, { hours: { start: "10:00", end: "15:00" } })).toMatchObject({ hours: { start: "10:00", end: "15:00" } });
    expect(inputsWith({ ...config, hours: { start: "10:00", end: "15:00" } }, { hours: null })).not.toHaveProperty("hours");
  });
});

describe("the built-in canvas", () => {
  const draft: AutomationDraft = { id: "builtin-bullish", name: "Bullish signal", folder: "Built-in", steps: builtInFlow("bullish", config, { start: "09:35", end: "15:55" }), inputs: [], updatedAt: 0 };

  it("is marked live when it has editors, and read-only otherwise; it never offers Save for the design", () => {
    const live = html(<AutomationBuilder draft={draft} botId="b" botName="B" readOnly liveEditor={() => null} onSaved={noop} onClose={noop} />);
    expect(live).toContain("Built-in · live");
    expect(live).not.toMatch(/<button[^>]*>Save<\/button>/);
    const plain = html(<AutomationBuilder draft={draft} botId="b" botName="B" readOnly onSaved={noop} onClose={noop} />);
    expect(plain).toContain("Built-in · read only");
  });
});
