/**
 * An order the broker never took: it was refused before anything was sent (a check of ours, the Gateway being down), or the bridge answered
 * the request with a refusal (an HTTP 4xx such as 409 "clientOrderId was already used", or 503). Nothing is working at the broker, so the
 * engine can put the position back the way it was.
 *
 * Everything else that goes wrong while sending (no answer, a timeout, an answer that isn't understood) is NOT this: the order may have
 * been taken, so it is left for a person (see closePosition).
 *
 * `needsResolve`: a refusal that is not a failed attempt but a fact about the account (it does not hold the spread being closed). The
 * position is left "closing" so Resolve can look at it.
 */
export class OrderNotPlacedError extends Error {
  readonly needsResolve: boolean;
  constructor(message: string, options?: { needsResolve?: boolean; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "OrderNotPlacedError";
    this.needsResolve = options?.needsResolve === true;
  }
}

/** The bridge answered with an HTTP error: its status, kept apart from the message so callers don't parse text. */
export class BridgeHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "BridgeHttpError";
  }
}

/** True when this HTTP status means the bridge refused the request (so no order exists): any 4xx except 408 (a timeout, which is not a refusal), and 503. */
export const isRefusalStatus = (status: number) => (status >= 400 && status < 500 && status !== 408) || status === 503;
