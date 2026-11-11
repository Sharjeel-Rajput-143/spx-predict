# Backtest pass / fail bar

Written 2026-11-09, **before any backtest has been run**. Nothing below may be changed after results are seen.
If a rule turns out to be wrong, the fix is a new dated bar and fresh data, not an edit to this one.

The backtester places no orders, uses no API keys and never touches the live bot. It reads only Bybit's public candle data.

## 1. What is tested

Three candidate versions, plus two reference runs that are shown for context and can never "pass".

| Id | Signal bars | Rule |
|----|-------------|------|
| A | 5 minute | EMA 9 crosses EMA 20. Cross up = long, cross down = short. |
| B | 15 minute | Same EMA 9/20 cross, but only trade in the direction of the 1 hour trend. 1 hour trend = EMA 9 above (long) or below (short) EMA 20 on the last fully closed 1 hour bar. |
| C | 15 minute | B, and ADX(14) on the 15 minute bars must be above 20. |
| R1 (reference) | 15 minute | EMA 9/20 cross, no filter. |
| R2 (reference) | 1 hour | EMA 9/20 cross, no filter. |

Exits for every version, copied from the live bot:
- Stop loss 0.3% from entry. Take profit 0.6% from entry.
- Breakeven: when the price is 0.3% in profit, move the stop to entry +0.12% (long) or entry -0.12% (short). Once per trade, tightens only, take profit unchanged.
- An opposite signal closes the trade at the next bar open and opens the new direction (the live "signal flip").
- One position at a time. No daily loss limit is modeled (the real size, 0.001 BTC, makes it irrelevant).

Execution rules (to prevent flattering the results):
- A signal is known only when its bar has closed. The entry is the **next** bar's open. The 1 hour filter uses only fully closed 1 hour bars.
- The path after entry is simulated on **1 minute** bars, so stop, take profit and breakeven order is not guessed.
- If one 1 minute bar touches both the stop and the take profit, the **stop wins**. If one bar both triggers breakeven and touches the original stop, the **original stop wins**.
- Funding payments and the daily loss limit are not modeled (stated limitation).
- The signal rule is a proxy for the TradingView alerts, whose script I cannot see. A pass here does not prove the live alerts behave the same.

## 2. Data

- Bybit public BTCUSDT linear perpetual candles (1 minute, 5 minute, 15 minute, 1 hour), as far back as the public endpoint serves, up to 24 months.
- **Locked holdout:** the most recent 60 days are set aside and **not run at all** in the main test. They are used once, only if a version passes (section 5).
- If the main-test period is shorter than 6 months, the result is **INCONCLUSIVE**, not pass or fail.

## 3. Cost cases

Both cases use the same trades; only the fees differ.

- **Case 1, the live reality:** taker 0.055% on every fill, entry and exit. Round trip 0.11%.
- **Case 2, optimistic upper bound:** maker 0.02% on entry and on take profit; taker 0.055% on the stop, breakeven stop and signal-flip exits. It assumes every limit order fills at the signal price, which real markets do not do, so Case 2 can only be read as a ceiling.

## 4. The bar for a PASS

A version passes a case only if **all** of these hold on the main-test data:

1. **Enough trades:** at least 200 trades. Fewer = INCONCLUSIVE.
2. **Average net result per trade** (after that case's fees) of at least **+0.03%** of trade value.
3. **Profit factor** (gross wins / gross losses, after fees) of at least **1.30**.
4. **Consistency:** the data is cut into 4 equal consecutive time slices. At least **3 of the 4** must have a positive net result.
5. **Drawdown:** total net result divided by the worst peak-to-trough drop (adding trade results, no compounding) is at least **2.0**.
6. **Not luck:** the lower end of a 99% bootstrap confidence interval for the average net result per trade (5,000 resamples, fixed seed) is **above zero**. (99% rather than 95% because three versions are tried.)
7. **Beats chance:** total net result is higher than the 95th percentile of 1,000 control runs that use the same entry times, same exits and same fees but random long/short direction.
8. **Survives slippage:** after adding an extra 0.01% against us on every taker fill, the average net result per trade is still above zero.

If any rule fails, the version FAILS that case. Failing rules are listed so the reason is clear.

## 5. Holdout rule

Only a version that PASSES Case 1 (or Case 2, for the "is a limit-order build worth it" question) is run, once, on the locked 60 days.
- It must show a positive average net result per trade and a profit factor of at least 1.10.
- With fewer than 30 holdout trades the answer is INCONCLUSIVE and more data must be waited for.
- No parameter, rule or cost changes are allowed after the holdout is run.

## 6. What the verdicts mean

- **Case 1 PASS** = this setup is worth a longer demo forward test. It is not permission to trade real money.
- **Only Case 2 PASS** = the signal has an edge only if entries can be made as a maker. Next step is to study whether limit entries really fill, not to change the bot.
- **FAIL on both** = do not build a scalper from this idea. A new idea needs a new dated bar and untouched data.
- **INCONCLUSIVE** = no conclusion either way.
- No live scalper that trades without TradingView signals is built until the results are reviewed with the owner.
