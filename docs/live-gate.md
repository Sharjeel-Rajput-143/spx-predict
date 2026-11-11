# The live gate: how it is measured

Stage 1 (a $10 account) is not held up by the gate. Stage 2 (up to $35, isolated, 3x) needs ALL THREE, each on the code that is running now:

1. **Failure tests on the real demo account: X of 6.** Scenarios 1 to 6, run against the real Bybit demo account.
2. **Partial fill proven on the fake exchange: yes / no.** The demo account cannot do it (a 0.001 BTC market order always fills whole), so it is proven on the fake exchange. It is a separate line, not part of the X of 6, and the page must say so. A fake pass never counts for scenarios 1 to 6.
3. **Clean counted demo trades: X of 5.** One unprotected moment resets this to 0.

The numbers come from the ledger, a chained file of facts the code writes: `<live folder>/ledger.jsonl` (`~/spx-live/data/live/ledger.jsonl` for the built copy). Nobody types into it and the page cannot edit it. Read the numbers (signed in): `GET /api/automation/live/gate`; it returns `tests` (X of 6, with each scenario), `partialFill` (proven or not, stale or not), `trades` (X of 5) and `why` in plain words. The live page that shows them comes in release 3.

## The tests

Defined by `bybitStopLive.test.ts` (details in `bybit-stop-safety.md`). 1 to 6 are run against the real Bybit demo account. Scenario 7, the partial fill, is run by the same harness on the fake exchange, on the same code, in the same run; the ledger marks it "fake" and counts it only for the partial-fill line.

Run them (only with the owner's word: the live app stopped, TradingView alerts paused, nothing else trading the demo account):

```
cd ~/spx-live/current
BYBIT_LIVE=1 BYBIT_LEDGER_DIR=$HOME/spx-live/data/live npx vitest run src/lib/automation/bybitStopLive.test.ts
```

Every scenario writes its result, pass or fail, with the exact hash of the stop-safety code it ran against. A skipped or unfinished test writes nothing. `BYBIT_LEDGER_DIR=none` runs without recording; without the variable a real run refuses to start.

## The re-run rule

The stop-safety code is three files: `bybitExecutor.ts`, `bybitWatchdog.ts`, `bybitRisk.ts`. Change any of them (even a comment) and every earlier pass, the partial fill included, is **stale**: the gate shows it as "stale: run again" and counts it as not passed until the scenario has been run again on the new code. The latest run on the current code decides: a pass followed by a failure is a failure. (The rule is deliberately wider than "the tests that covered the changed lines": any change means all six real tests and the partial fill.)

## A counted trade

A closed demo trade (the BTC Bybit Bot, not the live bot) is counted when its entry's stop loss was confirmed by the executor AND no unprotected moment (any stop-loss alarm: a missing, wrong or unconfirmed stop, or Bybit unreachable with a position held) happened from the moment the entry order was sent to its close. A trade without a confirmed-stop record (everything before the ledger existed) is not counted.

**The reset rule:** the clean count is the number of counted trades that closed AFTER the last unprotected moment. One unprotected moment, anywhere, takes it to 0, and counting starts again from the next trade.

## What makes the gate fail whatever the numbers say

A ledger line that was edited, removed or reordered (every line carries the hash of the one before); a write that failed and is still waiting; the stop-safety code unreadable.
