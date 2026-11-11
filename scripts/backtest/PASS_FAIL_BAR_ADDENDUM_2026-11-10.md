# Addendum to the pass / fail bar: take profit grid

Written 2026-11-10, **before any candle was downloaded and before any backtest was run.** The original bar (`PASS_FAIL_BAR.md`, 2026-11-09) is unchanged. This addendum only adds the grid and tightens the rules that the grid makes weaker. Nothing here may be edited after results are seen.

## 1. What is added

Every version in the original bar (A, B, C and the references R1, R2) is run with **each** of these exits. All use the 0.3% stop.

| Grid id | Take profit | Breakeven stop |
|---------|-------------|----------------|
| tp0.6 | 0.6% | off |
| tp0.6+be | 0.6% | on |
| tp1.0 | 1.0% | off |
| tp1.0+be | 1.0% | on |
| tp1.5 | 1.5% | off |
| tp1.5+be | 1.5% | on |

- Breakeven "on" means exactly the live rule: at +0.3% the stop moves to entry +0.12% (long) or entry -0.12% (short), once, tightening only. Breakeven "off" means the stop stays at 0.3% until the trade ends.
- The take profit is the only thing that changes between grid cells. Signals, data, fees, the 1 minute path simulation and all tie-break rules are exactly as in the original bar.
- Both cost cases are reported for every cell, after fees.

## 2. Things the original bar did not say (settled now, before running)

- **A filtered signal still closes the trade it opposes.** For versions B and C, an opposite cross always closes the open trade at the next bar open. The filter (1 hour trend, ADX) only decides whether a new trade is opened in the new direction. A cross that fails the filter therefore leaves the bot flat.
- **Each cross opens at most one trade.** A trade can last at most until the next cross.
- **Warm-up:** the first 200 bars of each series are not used for signals, so the averages have settled.
- **A trade still open at the end of the data** is closed at the last price and counted.
- **A 1 minute bar that triggers breakeven and also touches the new breakeven stop** counts as stopped at the breakeven stop (the pessimistic order). A gap through the stop fills at the bar open. A take profit fills exactly at its level.
- **Slippage test (rule 8):** an extra 0.01% against us on every taker fill. In Case 1 that is the entry and the exit; in Case 2 only the stop, breakeven stop and flip exits.
- **Bar data:** 1 minute candles are downloaded and the 5 minute, 15 minute and 1 hour bars are built from them (same result as downloading them, and keeps one consistent clock).

## 3. Tighter rules, because 18 variants are now tried

Three versions times six exits = **18 candidate variants** per cost case (the references do not count and cannot pass). Trying more things makes a lucky result more likely, so two of the original rules are tightened. All other rules stay as written.

| Original rule | Now |
|---------------|-----|
| 6. Bootstrap interval 99%, lower end above zero | **99.7%** lower end above zero (about 0.05 divided by 18), 5,000 resamples, fixed seed |
| 7. Beats the 95th percentile of 1,000 random-direction controls | Beats the **99.7th** percentile of 1,000 random-direction controls |

Rules 1 to 5 and 8 are unchanged: at least 200 trades; average net at least +0.03% per trade; profit factor at least 1.30; at least 3 of 4 equal time slices positive; total divided by worst drawdown at least 2.0; still above zero with the extra slippage.

## 4. Holdout

The locked last 60 days are used **at most once, for one variant**. If several variants pass, the one with the highest average net result per trade in the main test (in the cost case it passed) goes to the holdout. The holdout bar in section 5 of the original document is unchanged. No other variant is run on the holdout afterwards.

## 5. What gets reported

For every cell, in both cost cases: trades, win rate, average net per trade, total net, profit factor, worst drawdown, how many of the 4 slices are positive, the bootstrap lower end, the control percentile, the result with extra slippage, and each failed rule. A grid cell that looks good but fails a rule is reported as FAIL with the reason, never rounded up.

Verdicts keep the meaning in section 6 of the original bar. In particular a PASS is permission for a longer demo forward test and nothing else, and no live scalper that trades without TradingView signals is built before the owner has reviewed the results.
