# IBKR bridge contract

What the app (`src/lib/automation/ibkrExecutor.ts`) expects from the bridge: the always-on server that holds the IB Gateway login and
talks to the app over HTTPS. The app is only the client; the bridge is not written yet. This file is the agreement between the two.

## Switching it on

| Setting | Meaning |
|---|---|
| `BROKER=ibkr` | Use the bridge. `BROKER=internal` (the default) is the app's own simulation; `EXECUTOR=` is the older spelling of the same switch. Setting both to different values is an error. |
| `BRIDGE_URL` | `https://...` (plain `http://` only for `localhost` / `127.0.0.1`). No user name or password in it. |
| `BRIDGE_SECRET` | At least 16 characters. Sent on every request as the `X-Bridge-Secret` header. |
| `PRICE_SOURCE=broker` | Prices (strikes, live checks, exits) come from `GET /quote/{symbol}`. Default `feed` (Google/Yahoo). No fallback between them. |
| `BRIDGE_MAX_QUOTE_AGE_MS` | A quote older than this is "no price". Default 60000. Paper data without a subscription is delayed (about 15 minutes), so it is refused until this is raised on purpose: use `1200000` (20 minutes) for paper testing of the plumbing only. Real-time data needs a paid subscription. |
| `BRIDGE_SYMBOLS` | The underlyings the bridge takes, default `NDX`. A bot on any other underlying (SPX) runs on the app's internal simulation, labelled as such, and its price comes from the public feed; nothing is sent to the bridge for it. Add `SPX` here only once the bridge accepts it. |
| `IBKR_ALLOW_LIVE=true` | Allows an account that does not start with `DU`. Also needs `IBKR_MAX_CONTRACTS_PER_ORDER` and `IBKR_MAX_RISK_PER_ORDER` (no defaults). Leave unset. |

Where the app runs: on the same small server as the bridge and IB Gateway (the app refuses to drive a broker from Vercel). Then `BRIDGE_URL`
can be `http://localhost:<port>`, and the minute checks (missed-open retry, exit options, end-of-day sweep) run by themselves.
TradingView reaches the app over HTTPS on a domain name; the bridge itself should listen on localhost only.

The app refuses to send any order unless `GET /health` says `connected: true` and the account id starts with `DU`. The bridge must enforce the same
rule itself: it is a second lock, not a replacement.

## Endpoints

All answers are JSON objects. Any non-2xx is an error; the first 300 characters of the body are shown to the operator, so never put a secret in one.
The app never repeats a failed order request: after a timeout the outcome is unknown and the position stays blocked until a person checks.

| Call | Request | Answer |
|---|---|---|
| `GET /health` | - | `{ "connected": true, "account": "DU1234567", "paper": true }` |
| `GET /quote/ndx` | - | `{ "price": 21003.7, "asOf": 1790000000000, "delayed": false }` (`asOf` = epoch ms the quote is from) |
| `GET /quote/spread?underlying=NDX&root=NDXP&expiry=2026-10-06&type=short_put_spread&shortStrike=20970&longStrike=20960` | - | `{ "short": {"bid": 12.0, "ask": 12.6}, "long": {"bid": 8.7, "ask": 9.3}, "delayed": true }` (`delayed` is optional: when it is missing the app asks `GET /quote/ndx` for it, once a minute; Greeks may be added, the app ignores them for now) |
| `POST /open_spread` | `{ underlying, root, expiry, type, right, shortStrike, longStrike, clientOrderId, quantity, limitCredit, tif: "DAY" }` | `{ "ref": "<order reference>" }` |
| `POST /close_spread` | `{ underlying, root, expiry, type, right, shortStrike, longStrike, positionId, clientOrderId?, quantity, orderType: "limit", limitDebit, tif: "DAY" }` | `{ "ref": "..." }` |
| `GET /order/{ref}` | - | `{ "status": "working" \| "partially_filled" \| "filled" \| "canceled" \| "rejected", "filledQuantity": 0, "averagePrice": 3.45, "rejectReason": "...", "priceBand": { "edge": 1.6, "marketPrice": 1.1 } }` (`rejectReason` is IBKR's own words, up to 400 characters, also on a cancel IBKR did itself; `priceBand` only when IBKR refused the price as too far through its market, error 202, and each key inside it only if IBKR's message had it; the status stays `canceled`) |
| `DELETE /order/{ref}` | - | `{ "ok": true }` |
| `GET /positions` | - | `{ "positions": [ { "symbol": "NDXP261006P20970000", "quantity": -1 } ] }` (OCC-style symbol; negative = short; an empty account is `[]`) |

`GET /order/{ref}` and `DELETE /order/{ref}` are not in the first sketch of the bridge but the app cannot watch or cancel an order without them.
`POST /sweep` (close everything) is in the sketch and is not called by the app yet.

## Rules the bridge must keep

- **One combo order, both legs together** (IBKR combo, SMART routing, NDXP, same-day expiry). Never two single-leg orders.
- **`clientOrderId` is the idempotency key.** The same id twice returns the first order's `ref` and places nothing. The app builds it as
  `<alert id>:open:<price step>` for an open and `<alert id>:close:<position id>:<price step>` for a close.
- **Prices rounded to the option tick** (0.05 under 3.00, 0.10 above) by the bridge; the app sends the exact number it computed.
- **`tif` is always sent and always `DAY`.**
- **Statuses are exactly the five above.** The app treats any other value as an error, never as "working".
- **Refuse an account that does not start with `DU`** unless the bridge's own live flag was switched on on purpose.
- **A close is checked against the account** (implemented in the bridge, and also in the app, so there are two locks): a close BUYS the combo, so
  if the account does not hold the spread it would OPEN the opposite spread. A close is refused unless the account holds the short leg at
  `-quantity` or more and the long leg at `+quantity` or more.
- **The app never sends a combo without a limit price.** A close always carries `orderType: "limit"` and a `limitDebit` worked out from `GET /quote/spread`; when
  there is no usable quote the app sends nothing at all. The bridge may refuse `orderType: "market"` outright. A "market" close in the app (the expiration exit,
  the end-of-day sweep) becomes one limit order at the far end of the spread.
- **A refused price is re-priced from IBKR's own numbers.** On a `priceBand` the app sends a new price starting at `marketPrice` and stepping toward the edge, at most
  twice per order. The edge is exclusive (the price at the edge is refused), so a BUY goes at least one tick below it and a SELL at least one tick above (tick 0.05 below
  3.00, 0.10 from 3.00). A BUY is also never more than `CLOSE_MAX_ABOVE_MARKET` (default 1.00) above `marketPrice`, and never past the bot's own final price.
- **A quote too wide to price from is not used** on real-time data: a best-to-worst gap over `QUOTE_MAX_WIDTH` (default 3.00) is refused. While the data is `delayed` the
  limit is off, or every paper trade would be refused.
- **A close that ends with nothing filled goes back to "open"** only when `GET /positions` shows the whole spread still held; otherwise it stays "closing" for Resolve.
- **A cancel is a request.** `DELETE /order/{ref}` may answer before the order is over; the app then asks `GET /order/{ref}` until the status is `canceled`, `filled`
  or `rejected` (up to 15 seconds) before it sends the next price, and treats a fill that landed first as a fill.
- `limitCredit` is per spread (a credit); `limitDebit` is per spread (a debit); `quantity` is a whole number of spreads.

## Not covered yet

- Option chain (`getOptionChain` exists on the interface and nothing implements or uses it).
- Balances (`getBalances`), so the Accounts page shows no IBKR balance.
- A once-a-minute check of the app's positions against `GET /positions` (the check exists as a button, and as
  `RECONCILE_INTERVAL_MINUTES` on a server that stays up).

Failure alerts are in-app notifications (the bell in the app's header) and do not involve the bridge.
