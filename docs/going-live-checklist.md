# Going live: what stands between this platform and real trading

Written from Option Alpha's own documentation (docs.optionalpha.com: SmartPricing, order handling, automation behavior, autotrading best practices) and from what the platform does today. **Nothing here has been run against a real Tradier account.** Real money stays off until every gate below is met; the platform has no way to place a real order by accident (the default executor is the mock, and production Tradier needs three separate settings).

## 1. How it compares with the Option Alpha bot

| Option Alpha | This platform |
| --- | --- |
| Bullish/Bearish flow: in the window, close the opposite side, open the wanted side if not held | Same logic. The flip is two-stage (close, wait for the confirmed fill, then open), so a failed close never leaves both sides open |
| One automation at a time per bot (runs synchronously, never overlapping) | A per-bot lock: signals for one bot are processed strictly one after another |
| SmartPricing Normal: up to 4 timed limit orders from the mid toward the final price, 10s each; final price live 2 minutes | **Built.** Same presets (Normal / Fast / Patient / Off). Needs live quotes, so it only runs on a real executor; the mock sends one price |
| Partial fill: wait for the rest, timeout restarts at 2 minutes on each partial; remainder canceled; position keeps what filled | Same |
| Short strike a flat $ from the price; long a flat $ from the short; fixed contracts | Same (decimals allowed). Rounding mode is ours to verify: put down, call up |
| Position limit, daily limit, allocation, leg-overlap guards | Same, per bot |
| Expiring ITM positions: setting "calculate P/L from the underlying close" (the owner's choice) | Never auto-closes; marks positions expired in an end-of-day sweep. Same effect |
| Assignment is not supported | Not an issue for cash-settled European index options (SPX, NDX): nothing to assign |
| Close Monitor automations (sweep for wrong-side positions) | Deliberately not copied. A future version must compare against the latest confirmed signal |
| Exit options, entry/position filters, other strike and sizing modes | Not built; the live bot uses none of them |
| Broker keeps the books | **Built:** a broker check (reconcile) and crash recovery read the broker back; neither trades |

## 2. What was added for real trading (all disabled until you turn it on)

- **SmartPricing ladder** for opens and closes, off the spread's own bid/ask.
- **Hard limits on one opening order** in production: `TRADIER_MAX_CONTRACTS_PER_ORDER` and `TRADIER_MAX_RISK_PER_ORDER`, no defaults. A limit credit that isn't between 0 and the width is refused. Closing is never capped.
- **Crash recovery:** on startup, any position left "opening" or "closing" has its order read back from the broker and settled if certain (filled, rejected) or flagged if not. It never places or cancels an order.
- **Broker check:** "Check broker positions" on the Automation status page (and optionally every N minutes) compares our open positions with what Tradier holds, leg by leg, flags the bot and raises an Error alert on a mismatch. It never opens or closes anything.
- **A red LIVE banner** on the status page whenever the executor is Tradier production.

## 3. Gates - do not skip

1. **Owner approval.** Blue decides that real trading starts, on which account, and at what size.
2. **Verify Tradier in the sandbox first** (paper money, no real orders). Every item marked TODO(unconfirmed) in `tradierExecutor.ts` is settled by one real run:
   - the NDXP/SPXW option symbol format and that the sandbox carries index options;
   - the `/markets/quotes` response (bid/ask) for those symbols, and the option tick size (0.05 is assumed);
   - how a credit price is expressed on a multileg order (use Tradier's preview-order call first);
   - that a market-type multileg close is accepted, and the response field names for fills (`exec_quantity`, `avg_fill_price`);
   - the shape of the account positions answer.
   Then update the sample responses in `tradierExecutor.test.ts` from what Tradier really returned.
3. **Paper trade first.** Option Alpha's own advice is 30-60 days with the same allocation and sizing before going live, because "paper fills are favorable and live fills are not guaranteed". Do it on the Tradier sandbox, not the mock.
4. **Start at one contract** with the caps set tight, and watch the first sessions by hand.
5. **Host it as one long-running server** (`next build && next start`) with `AUTOMATION_STATUS_PASSWORD` set and the webhook behind HTTPS. The bots' state lives in this process and in JSON files, so run a single instance (not serverless, not two copies) and back up the `data/automation` folder. Recovery and the broker check exist because a process can still die mid-order.
6. **Automated is not unattended.** Check the broker account itself, not just this page, especially in the first weeks.

## 4. Turning it on, in order

1. Sandbox: `EXECUTOR=tradier`, `TRADIER_TOKEN`, `TRADIER_ACCOUNT_ID` (sandbox token). Leave `AUTOMATION_DRY_RUN=true` at first: it reads quotes and shows each ladder in the log without sending an order.
2. Run signals in dry run; read the decision log's ladders against the broker's own chain.
3. Turn dry run off in the sandbox. Place test trades; use Check broker positions after each.
4. Only after the gates above: `TRADIER_BASE_URL=https://api.tradier.com/v1`, `TRADIER_ALLOW_PRODUCTION=true`, the two caps. The page then shows the red LIVE banner.
5. Keep the bot's on/off switch (the kill switch) and Dry run in reach: both still apply to every executor.

## 5. Risks that remain

- **Real fills differ from the mock's.** The mock fills at your limit; a real broker fills at market. P/L comes only from prices the broker reports.
- **Fees and slippage are not modeled.**
- **Settlement.** SPX/NDX options cash-settle; the broker settles them, our records mark them expired. If a settlement ever differs from our records, the broker check shows it. TODO(verify): the final trading time of each series for `*_EOD_SWEEP_TIME`.
- **One account, one bot's legs.** The broker check ignores anything in the account outside the series our bots trade.
- **The decision log is not a ledger.** The broker's statements are the record of what really happened.
