import "server-only";
import type { LegQuotes } from "./smartPricing";
import type { BrokerBalances, BrokerExecutor, BrokerPosition, CloseOrderOptions, ExecutorVenue, OpenSpreadRequest, OrderState, Position, SpreadQuoteRequest, UnderlyingQuote } from "./types";

/**
 * One executor that sends each bot's orders where they can really go. The bridge to IBKR handles only some underlyings (NDX today); a bot on
 * any other (SPX) keeps running on the internal simulation, clearly labelled as such (its positions carry venue "mock"), instead of being
 * refused or, worse, sent where it cannot go. Nothing about NDX changes.
 *
 * Routing is by underlying for a new order, by the position's own venue for a close, and by the order reference for anything asked about an
 * order afterwards (the simulation's references start with "mock-"). The paper-only and limit-only rules belong to the real broker and stay
 * with it; the simulation has none of them.
 */

export const SIMULATION_REF_PREFIX = "mock-";

export class RoutedExecutor implements BrokerExecutor {
  readonly venue: ExecutorVenue | undefined;
  readonly limitOnly: boolean | undefined;
  getSpreadQuote?: (req: SpreadQuoteRequest) => Promise<LegQuotes | null>;
  getUnderlyingQuote?: (symbol: string) => Promise<UnderlyingQuote | null>;
  listBrokerPositions?: () => Promise<BrokerPosition[]>;
  getBalances?: () => Promise<BrokerBalances>;

  constructor(
    private readonly primary: BrokerExecutor,
    private readonly fallback: BrokerExecutor,
    /** The underlyings the primary takes (upper case). */
    private readonly symbols: readonly string[],
  ) {
    this.venue = primary.venue;
    this.limitOnly = primary.limitOnly;
    const p = primary;
    if (p.getSpreadQuote) this.getSpreadQuote = (req) => (this.takes(req.underlying) ? p.getSpreadQuote!(req) : Promise.resolve(null));
    if (p.getUnderlyingQuote) this.getUnderlyingQuote = (symbol) => (this.takes(symbol) ? p.getUnderlyingQuote!(symbol) : Promise.resolve(null));
    if (p.listBrokerPositions) this.listBrokerPositions = () => p.listBrokerPositions!();
    if (p.getBalances) this.getBalances = () => p.getBalances!();
  }

  /** Whether the primary (the real broker) takes this underlying. Unknown counts as yes: nothing is rerouted on a guess. */
  takes(underlying: string | undefined): boolean {
    return !underlying || this.symbols.includes(underlying.toUpperCase());
  }

  venueFor(underlying: string): ExecutorVenue {
    return this.takes(underlying) ? (this.primary.venue ?? "mock") : (this.fallback.venue ?? "mock");
  }

  limitOnlyFor(underlying: string): boolean {
    return this.takes(underlying) && this.primary.limitOnly === true;
  }

  private forRef(ref: string): BrokerExecutor {
    return ref.startsWith(SIMULATION_REF_PREFIX) ? this.fallback : this.primary;
  }

  placeOpenOrder(req: OpenSpreadRequest): Promise<{ ref: string }> {
    return (this.takes(req.underlying) ? this.primary : this.fallback).placeOpenOrder(req);
  }

  placeCloseOrder(position: Position, options?: CloseOrderOptions): Promise<{ ref: string }> {
    const simulated = position.venue === "mock" || !this.takes(position.underlying);
    return (simulated ? this.fallback : this.primary).placeCloseOrder(position, options);
  }

  getOrder(ref: string): Promise<OrderState> {
    return this.forRef(ref).getOrder(ref);
  }

  cancelOrder(ref: string): Promise<void> {
    return this.forRef(ref).cancelOrder(ref);
  }

  listPositions(botId: string): Promise<Position[]> {
    return this.primary.listPositions(botId);
  }
}
