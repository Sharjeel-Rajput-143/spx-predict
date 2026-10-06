import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BotStaticConfig, Position } from "@/lib/automation/types";
import { buildPosition } from "@/lib/automation/testSupport";
import { PositionDetails } from "./PositionDetails";
import { PositionsView } from "./PositionsTab";
import { RunModal } from "./RunModal";
import { payloadFor } from "./SettingsTab";
import { SymbolsPanel } from "./SymbolsPanel";

// An NDX bot must say NDX everywhere - not the SPX the pages were first written for.
const noop = () => undefined;
const html = (n: React.ReactElement) => renderToStaticMarkup(n);
const NOW = Date.UTC(2026, 9, 6, 18, 0);

const ndxPosition: Position = buildPosition({ id: "n1", botId: "ndx_ema_bias", underlying: "NDX", type: "short_put_spread", status: "open", shortStrike: 21_000, longStrike: 20_990, requestedQuantity: 1, filledQuantity: 1, credit: 3.5, underlyingAtOpen: 21_003.7, openedAt: NOW - 3_600_000 });

const config: BotStaticConfig = { id: "ndx_ema_bias", name: "NDX", accountId: "paper-ndx", underlying: "NDX", quantity: 1, widthPoints: 10, strikeIncrement: 5, putShortOffset: -0.01, callShortOffset: 0.01, allocationLimit: 2000, openingCreditEstimate: 3.5 };

describe("an NDX bot's pages say NDX", () => {
  it("the TradingView message copied from its settings carries symbol NDX, not SPX", () => {
    const msg = JSON.parse(payloadFor("bullish", "ndx_ema_bias", "NDX").replace("{{close}}", "1"));
    expect(msg).toMatchObject({ bot: "ndx_ema_bias", signal: "bullish", symbol: "NDX" });
    expect(payloadFor("bearish", "spx_ema_bias", "SPX")).toContain('"symbol": "SPX"');
  });

  it("the Symbols panel offers 'NDX only' and says the engine trades NDX", () => {
    const out = html(<SymbolsPanel botId="ndx_ema_bias" underlying="NDX" onSaved={noop} onClose={noop} />);
    expect(out).toContain("NDX only");
    expect(out).toContain("trades NDX from webhook signals");
    expect(out).not.toContain("SPX only");
    expect(html(<SymbolsPanel botId="x" onSaved={noop} onClose={noop} />)).toContain("SPX only");
  });

  it("Run automation labels the price as NDX's", () => {
    const out = html(<RunModal botId="ndx_ema_bias" underlying="NDX" onClose={noop} onDone={noop} />);
    expect(out).toContain("NDX price");
    expect(out).not.toContain("SPX price");
  });

  it("the position details name NDX, not SPX", () => {
    const out = html(<PositionDetails position={ndxPosition} orders={[]} signals={[]} estimate={3.5} bot={{ id: "ndx_ema_bias", name: "NDX", accountId: "paper-ndx" }} last={null} now={NOW} onClose={noop} onChanged={noop} notify={noop} />);
    expect(out).toContain("NDX at open");
    expect(out).toContain("Short Put Spread");
    expect(out).toContain(">NDX<");
    expect(out).toContain("NDX at the signal that opened it.");
    expect(out).not.toContain("SPX");
  });

  it("the positions list names NDX and offers an NDX symbol filter", () => {
    const out = html(
      <PositionsView positions={[ndxPosition]} orders={[]} signals={[]} now={NOW} estimateFor={() => 3.5} newPosition={{ botId: "ndx_ema_bias", config }} onChanged={noop} notify={noop} />,
    );
    expect(out).toContain(">NDX<");
    expect(out).toContain("Symbol: NDX");
    expect(out).not.toContain("Symbol: SPX");
  });
});
