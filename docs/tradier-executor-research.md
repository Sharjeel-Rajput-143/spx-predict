# Tradier as the Phase 2 broker - research

Question: can Tradier's API place the bots' spread trades (SPX now, NDX next)?
Short answer: **yes on the API side; NDX dailies and the paper account need one real check before anyone commits.**
**Status: the executor is now implemented but disabled.** `src/lib/automation/tradierExecutor.ts` sits behind the same `BrokerExecutor` interface and is only built when `EXECUTOR=tradier` (the default is `mock`). It is not connected to any account, has never made a real request, and is covered only by unit tests with a fake `fetch` and SAMPLE response shapes written from the docs (not recordings). Using it for real still needs Blue's approval.

What it does:
- Defaults to the **sandbox** URL. The production URL is refused unless `TRADIER_BASE_URL` points at it **and** `TRADIER_ALLOW_PRODUCTION=true` is set separately. Any other host is refused.
- Refuses to start without `TRADIER_TOKEN` and `TRADIER_ACCOUNT_ID`; signals are then answered 503 and nothing is placed.
- Open = one `multileg` `credit` order (sell the short, buy the long); close = one `multileg` `market` order. The kill switch, dry run, hours guard and every other check run in the engine, before any executor is called, so they apply to both executors.

### TODO(unconfirmed) - marked in the code, not guessed

1. **NDX daily option symbol format** - root (`NDXP` vs `NDX`), and whether it is sent bare or padded. Built as `ROOT + YYMMDD + C/P + strike x 1000 (8 digits)`; the executor refuses to run without a configured root.
2. **Whether the sandbox carries index options** - untested.
3. **How a credit price is expressed on a multileg order** - sent as a positive `price` with `type=credit`; confirm with Tradier's preview-order call.
4. `type=market` accepted for a multileg index spread (used for closes, since the engine sends no close price).
5. Response field names for fills (`exec_quantity`, `avg_fill_price`, `reason_description`) - written from memory of Tradier's responses, to be checked against a real one.
6. Reconciling `listPositions` against Tradier's account positions (today it returns our own rows).

This was read from Tradier's public docs (docs.tradier.com), not tried against an account. Items marked **verify** are not confirmed by anything we read.

## What the docs confirm

| Need | Tradier |
| --- | --- |
| Paper trading | Sandbox `https://sandbox.tradier.com/v1` - "supports the full trading API with paper money and delayed market data". Options data there is 15 minutes delayed. |
| Live | `https://api.tradier.com/v1`. Same endpoints. |
| Auth | Bearer token (from the Tradier dashboard), `Accept: application/json`, form-encoded bodies. |
| Spread order | `POST /v1/accounts/{account_id}/orders` with `class=multileg`, `symbol` (underlying), `type` = `credit` / `debit` / `even` / `market`, `duration`, `price` (required for credit/debit), and per leg `option_symbol[n]`, `side[n]`, `quantity[n]`. Up to 4 legs. |
| Leg sides | `buy_to_open`, `buy_to_close`, `sell_to_open`, `sell_to_close`. |
| Order status | `pending`, `open`, `partially_filled`, `filled`, `expired`, `canceled`, `rejected`, `pending_cancel`. |
| Other calls | Get order, cancel order, change order, **preview order** (validation and cost before sending), account positions, options chains / strikes / expirations / symbol lookup. |
| Index options | Tradier lists SPX, RUT, VIX and **NDX** as index symbols with ORATS-derived index prices, and its fee schedule lists NDX index options. SPX/XSP/VIX options also trade 8am-5pm ET. |

## How it maps onto our `BrokerExecutor`

| Our method | Tradier |
| --- | --- |
| `placeOpenOrder` | Build the two OCC option symbols from the underlying root, the expiry and the strikes; send a `multileg` `credit` order with `sell_to_open` (short) and `buy_to_open` (long) at `limitCredit`. `ref` = the returned `order.id`. |
| `placeCloseOrder` | Same, `debit`, `buy_to_close` the short and `sell_to_close` the long. |
| `getOrder` | `GET .../orders/{id}`: map status (`open`/`pending` -> working, `partially_filled`, `filled`, `canceled`/`expired`, `rejected`) and the average fill price onto `OrderState.averagePrice`, which is what feeds `closePrice` and P/L. |
| `cancelOrder` | `DELETE .../orders/{id}`. |
| `listPositions` | `GET .../accounts/{id}/positions`, mapped back to our rows. |

The engine needs no change: it already treats the executor as async, polls `getOrder`, times out and cancels. The work is one new file (a `TradierExecutor`) plus the OCC symbol builder, picked by an env switch next to `AUTOMATION_DRY_RUN`.

## Not confirmed - check before building

1. **NDX dailies.** The docs never mention index option roots. Does the account see `NDXP` (the daily series) and a 0DTE expiry every weekday? Check `markets/options/lookup?underlying=NDX` and `markets/options/expirations?symbol=NDX&includeAllRoots=true` with a real token. This also settles the addendum's open question on the root (NDXP vs NDX) and the strike increment.
2. **Sandbox coverage.** Whether the sandbox carries index options at all, or only equities. If not, paper-testing NDX through Tradier is not possible and the mock stays the only paper path.
3. **Credit sign and price.** The docs say `price` is "the limit price" without saying how a credit is expressed. Use **preview order** to confirm before the first real send.
4. **OCC symbol shape for the index roots** (root padding, `NDXP` vs `NDX`) - the docs only show an equity example (`AAPL251017C00247500`).
5. **Final trading time** of the NDX series, which sets `BOT_NDX_EMA_BIAS_EOD_SWEEP_TIME`.
6. **Account type and options level** needed for defined-risk spreads, and Tradier's rate limits - neither was in what we read.
7. **Fees** are listed for NDX options but were not checked against our 1-lot, $2,000-allocation plan.

## Suggested path

1. Open a Tradier sandbox token and run the two lookup calls in (1) by hand - no engine involved.
2. Settle the TODO list above from those real responses and update the sample shapes in `tradierExecutor.test.ts`.
3. Use preview order on the first real order shape; compare against our `limitCredit` convention.
4. Only then, with Blue's sign-off, point `EXECUTOR=tradier` at the sandbox - keeping `AUTOMATION_DRY_RUN` and the kill switch as they are. Production stays behind its own flag.

## Sources

- Trading overview: https://docs.tradier.com/docs/trading
- Endpoint index: https://docs.tradier.com/llms.txt
- Place order (incl. multileg): https://docs.tradier.com/reference/brokerage-api-trading-place-order
- Orders and statuses: https://docs.tradier.com/docs/orders
- Index pricing (SPX, RUT, VIX, NDX): https://support.tradier.com/kb/guide/en/how-spx-and-other-index-prices-are-calculated-at-tradier-VzhPhHcgiM/Steps/4544172
