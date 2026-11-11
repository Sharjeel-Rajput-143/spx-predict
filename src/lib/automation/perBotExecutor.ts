import "server-only";
import { isLiveRef, LIVE_BOT_ID } from "./bybitLiveLimits";
import { OrderNotPlacedError } from "./orderErrors";
import type { BrokerExecutor, CloseOrderOptions, ExecutorVenue, OpenSpreadRequest, OrderState, Position } from "./types";

/**
 * One executor in front of two: the demo one (everything the app did before) and the live one. A call goes where its OWN bot or order says, never by the underlying (both bots
 * trade BTC):
 *   - a new order: by the request's bot;       - a close: by the position's bot;       - a question about an order: by the order reference ("bybitlive-" = live);
 *   - listPositions / entryBlock / syncPositions: by the bot.
 * Everything that has no bot in it (quotes, hours, balances) is the demo executor's, as before. The demo executor never sees a live bot or a live reference.
 *
 * If the live executor does not exist (no live key), a call for the live bot is refused in words; nothing is ever sent to the demo account in its place.
 */
export class PerBotExecutor implements BrokerExecutor {
  readonly venue: ExecutorVenue | undefined;
  readonly limitOnly: boolean | undefined;
  venueFor?: BrokerExecutor["venueFor"];
  limitOnlyFor?: BrokerExecutor["limitOnlyFor"];
  getSpreadQuote?: BrokerExecutor["getSpreadQuote"];
  getUnderlyingQuote?: BrokerExecutor["getUnderlyingQuote"];
  getOptionChain?: BrokerExecutor["getOptionChain"];
  listBrokerPositions?: BrokerExecutor["listBrokerPositions"];
  getBalances?: BrokerExecutor["getBalances"];
  isPaperAccount?: BrokerExecutor["isPaperAccount"];
  tradingWindowFor?: BrokerExecutor["tradingWindowFor"];
  lastBuyMinutesFor?: BrokerExecutor["lastBuyMinutesFor"];
  getContractResult?: BrokerExecutor["getContractResult"];
  syncPositions?: BrokerExecutor["syncPositions"];
  entryBlock?: BrokerExecutor["entryBlock"];
  getSpreadMark?: BrokerExecutor["getSpreadMark"];

  constructor(
    private readonly demo: BrokerExecutor,
    /** The live executor, or null when there is none (no live key, or it could not be built). */
    private readonly live: () => BrokerExecutor | null,
    private readonly liveBotId: string = LIVE_BOT_ID,
  ) {
    this.venue = demo.venue;
    this.limitOnly = demo.limitOnly;
    const d = demo;
    // No bot in the question: the demo executor answers, as it always did.
    if (d.venueFor) this.venueFor = (u) => d.venueFor!(u);
    if (d.limitOnlyFor) this.limitOnlyFor = (u) => d.limitOnlyFor!(u);
    if (d.getSpreadQuote) this.getSpreadQuote = (r) => d.getSpreadQuote!(r);
    if (d.getUnderlyingQuote) this.getUnderlyingQuote = (s) => d.getUnderlyingQuote!(s);
    if (d.getOptionChain) this.getOptionChain = (r) => d.getOptionChain!(r);
    if (d.listBrokerPositions) this.listBrokerPositions = () => d.listBrokerPositions!();
    if (d.getBalances) this.getBalances = () => d.getBalances!();
    if (d.isPaperAccount) this.isPaperAccount = () => d.isPaperAccount!();
    if (d.tradingWindowFor) this.tradingWindowFor = (u) => d.tradingWindowFor!(u);
    if (d.lastBuyMinutesFor) this.lastBuyMinutesFor = (u, n) => d.lastBuyMinutesFor!(u, n);
    // A bot or an order reference in the question: it goes where that bot or reference belongs.
    if (d.getContractResult) this.getContractResult = (ref) => this.forRef(ref, true)?.getContractResult?.(ref) ?? Promise.resolve(null);
    if (d.syncPositions) this.syncPositions = (botId, now) => (this.isLive(botId) ? (this.live()?.syncPositions?.(botId, now) ?? Promise.resolve(0)) : d.syncPositions!(botId, now));
    if (d.entryBlock) {
      this.entryBlock = (botId, now) => {
        if (!this.isLive(botId)) return d.entryBlock!(botId, now);
        const live = this.live();
        if (!live?.entryBlock) return Promise.resolve({ outcome: "kill_switch" as const, reason: "Skipped: the live executor is not available (no live key). Nothing was sent." });
        return live.entryBlock(botId, now);
      };
    }
    if (d.getSpreadMark) this.getSpreadMark = (p, q) => (this.isLive(p.botId) ? (this.live()?.getSpreadMark?.(p, q) ?? Promise.resolve(null)) : d.getSpreadMark!(p, q));
  }

  /** The demo executor behind the router (the Bybit demo one sits behind its own router): for the screens and monitors that read the demo account directly. */
  get primaryExecutor(): BrokerExecutor | undefined {
    return (this.demo as { primaryExecutor?: BrokerExecutor }).primaryExecutor;
  }

  private isLive(botId: string | undefined): boolean {
    return botId === this.liveBotId;
  }

  private liveOrRefuse(): BrokerExecutor {
    const live = this.live();
    if (!live) throw new OrderNotPlacedError("Refused: the live executor is not available (no live key is set), so nothing was sent. Nothing is ever sent to the demo account in its place.");
    return live;
  }

  private forBot(botId: string | undefined): BrokerExecutor {
    return this.isLive(botId) ? this.liveOrRefuse() : this.demo;
  }

  /** `soft`: a question that can be answered "no result" (returns null when the live executor is missing) instead of refused. */
  private forRef(ref: string, soft = false): BrokerExecutor | null {
    if (!isLiveRef(ref)) return this.demo;
    return soft ? this.live() : this.liveOrRefuse();
  }

  async placeOpenOrder(req: OpenSpreadRequest): Promise<{ ref: string }> {
    return this.forBot(req.botId).placeOpenOrder(req);
  }

  async placeCloseOrder(position: Position, options?: CloseOrderOptions): Promise<{ ref: string }> {
    return this.forBot(position.botId).placeCloseOrder(position, options);
  }

  async getOrder(ref: string): Promise<OrderState> {
    return this.forRef(ref)!.getOrder(ref);
  }

  async cancelOrder(ref: string): Promise<void> {
    return this.forRef(ref)!.cancelOrder(ref);
  }

  async listPositions(botId: string): Promise<Position[]> {
    return this.forBot(botId).listPositions(botId);
  }
}
