# Bybit stop loss safety

Rule: **a position at Bybit never exists without a working stop loss that covers all of it.** An unconfirmed stop is treated as a missing one. Where a guarantee is impossible, this page says so (section 6). Everything here is for the Bybit **demo** account; live stays off (section 5).

## 1. How it works

| Step | What happens | Code |
|---|---|---|
| Entry | The stop loss and take profit are inside the entry order itself (`/v5/order/create`), triggered on the mark price, closing at market, covering the whole position (`tpslMode: Full`). | `placeOpenOrder` |
| Check after the entry | Within **5 seconds** (`STOP_CHECK_BUDGET_MS`), however slow the reads are: the position is read, and the stop must exist, cover all of it, and be where it should be **against the real fill price**. | `ensureProtected` |
| Tolerance | A stop must be within **0.05 percentage points of price** (`STOP_TOLERANCE_PERCENT`, `BYBIT_STOP_TOLERANCE_PERCENT`) of STOP_LOSS_PERCENT from the average fill: about $37 on $75,000. Right after an entry the stop may be neither looser nor tighter than that. Later, only *looser* is wrong, because a breakeven stop is tighter on purpose. | `stopVerdict` |
| Hard rule | Stop missing, wrong, or **unconfirmed (Bybit cannot be read)**: one repair attempt, then reduce-only market closes **every second** until the account is protected or flat. A reduce-only order can never open or add to a position, so it is safe to send even when the position cannot be read. | `ensureProtected`, `watchdogStep` |
| Give-up point of an entry | After 30 seconds the entry reports `UNPROTECTED POSITION`, raises the alarm and hands over to the watchdog, which keeps closing every second. | `UNPROTECTED_CAP_MS` |
| Watchdog | Every **1.5 seconds** it reads the account. **Any** position is in scope, recorded by the bot or not. Same rule as above. The first look after a start is the **startup check**. A position an entry is still confirming is left to the entry. | `watchdogStep`, `bybitWatchdog.ts` |
| Take profit | A missing take profit is set once; it is never a reason to close. | |
| Entry refusal | No new entry while a position has no correct stop, or after 3 failed reads in a row (about 4.5 seconds). Nothing is sent. | `watchdogHealth` |
| Alarm | Shown in the **page Log** (an executor error, which also rings the **bell**), in the bot's **red banner** ("needs attention", with the sentence), and in the console. Raised at once for a missing or wrong stop, and after **20 seconds** of Bybit being unreadable while a position may be open. The all-clear is written to the Log but does **not** clear the banner: a person looks at what happened. | `raiseStopAlarm` |

Rate limits (Bybit's documentation): 600 requests per 5 seconds per IP; the position read about 50 per second per account. The watchdog uses under 1 a second. Demo trading has the default limits and they cannot be raised.

## 2. What was found before this work (the audit)

- The stop was already attached in the entry order, but a position that could not be **read** after the entry was **not** closed ("stop could not be confirmed", no close). Fixed: it is treated as unconfirmed and the hard rule applies.
- A failed close was not retried. Fixed: retried every second.
- The 10-second monitor read the stop each cycle but only wrote a console line when it was missing, never compared its price, and watched only positions the bot had a record of. Fixed by the watchdog.
- Nothing checked stops after a restart. Fixed: the first watchdog look is the startup check.

## 3. Failure scenarios (fake exchange: `bybitStopSafety.test.ts`, 37 tests)

| Scenario | Result |
|---|---|
| Stop call fails (entry came back without a stop) | repaired once; if refused, closed reduce-only until flat |
| Stop deleted by hand at Bybit | alarm, one repair, confirmed, all clear |
| Repair refused | reduce-only closes every second until flat |
| Network cut after the entry | confirmed within 5 s if it answers; otherwise blind reduce-only closes every second from second 5; alarm after 20 s; ends flat or protected |
| Partial fill | what is held gets a stop covering all of it (Full mode), logged |
| Stop covers only part (Partial mode) | counted as wrong; repaired to Full, or closed |
| Flip while a stop is pending | old side closes reduce-only, new side opens with its own stop; no unprotected moment |
| Restart with a position open | startup check repairs a stop that went missing meanwhile |
| Bybit unreadable | 3 failed reads refuse new entries; 20 s with a position at risk raises the alarm |

## 4. Demo failure tests (`bybitStopLive.test.ts`)

Run on the real demo account **only when asked for**, never by `npm test`:

```
BYBIT_LIVE=fake npx vitest run src/lib/automation/bybitStopLive.test.ts   # same scenarios on the fake (harness self-test)
BYBIT_LIVE=1    npx vitest run src/lib/automation/bybitStopLive.test.ts   # the real demo account
```

Conditions: the demo account is flat and funded; **nothing else trades it** (the BTC bot switched off, no TradingView alert firing: the watchdog treats any position as its own and would act on a second trader's); the minimum size, 0.001 BTC (about $76). It reads only `BYBIT_DEMO_API_KEY` and `BYBIT_DEMO_API_SECRET`, as the existing demo test does. Each scenario ends flat and prints its exact START and END time; the report is saved to the system temp folder (`bybit-stop-live-report.txt`).

| # | Scenario | Expected | About |
|---|---|---|---|
| 0 | connection, account flat | | 5 s |
| 1 | does Bybit remove the stop when the position closes? | stop gone, no working stop orders left | 10 s |
| 2 | stop deleted by hand | alarm, one repair, confirmed | 10 s |
| 3 | stop deleted and the repair call fails | reduce-only closes until flat | 15 s |
| 4 | network cut after the entry (25 failed calls) | ends flat or protected, never unprotected | 40 s |
| 5 | flip: bullish then bearish signal | old side closed, new side has its own stop | 30 s |
| 6 | restart with a position open, stop deleted meanwhile | startup check repairs it | 10 s |
| 7 | partial fill | not testable on demo (a 0.001 BTC market order fills whole): fake only | |

## 5. Live gate (design only; nothing below is built, live stays OFF)

Today the executor **refuses any host except the demo one**, so live cannot be reached by a setting. Going live would be a deliberate, separate change guarded by all of these:

1. **Separate switch and settings:** `BYBIT_LIVE_ENABLED` off by default; its own key names (`BYBIT_LIVE_API_KEY`, `BYBIT_LIVE_API_SECRET`); the demo key is never accepted by the live path and the live key never by the demo path. A separate key at Bybit: trade-only permission, **no withdrawal**, locked to this machine's IP, preferably a sub-account holding only the trading amount.
2. **Evidence required before it can be enabled** (checked by the server, from a ledger the watchdog writes): the watchdog has run **clean on demo for 7 consecutive days**, with **at least 20 trades**, and **zero unprotected moments** in that period. An unprotected moment is any watchdog stop alarm (missing, wrong, or Bybit unreadable with a position at risk). Any one resets the 7 days. The ledger needs building first so the clock can start; that is the first piece to build if this is approved.
3. **Typed confirmation:** the UI asks you to type `LIVE`, showing the evidence numbers and the caps; the confirmation is stored with the time and expires on restart or after 24 hours.
4. **Lower caps than demo, hard-coded as ceilings in code (not only settings):** position size at most the minimum order, a daily loss limit below the demo one, and a per-trade stop no wider than the demo's. The kill switch starts ON.
5. **Same safety rules, stricter:** the watchdog, hard rule and entry refusal apply unchanged; an alarm on live would also switch the bot off.

## 6. What cannot be guaranteed

- **Slippage on the stop.** It is a market order triggered on the mark price. In a gap or fast wick it can fill beyond the stop price.
- **Mark price versus last price.** A mark-price trigger can fire later than a last-price one in a sudden move.
- **Bybit's side.** An outage, maintenance, a rejected stop order when it triggers, forced liquidation, or auto-deleveraging are outside our control.
- **A Bybit we cannot reach.** We cannot confirm or close anything. The stop already at Bybit still works if it was set; we can only raise the alarm.
- **A sleeping Mac or stopped app.** Monitoring stops; the stop at Bybit does not.
- **Demo versus live.** Bybit's documentation says demo follows the same trading rules but says nothing about fills or stop behaviour. Demo fills and stop triggers do not prove live ones. The documentation also does not spell out how a stop on a market order is checked, so what Bybit accepts is confirmed by the demo tests, not assumed.
- **Docs uncertainty:** the Set Trading Stop page says "the system will cancel these orders if the position is closed" and warns that changing only one side of an existing TP/SL pair can break their link (relevant to the take-profit-only repair); both are confirmed on the demo account in scenarios 1 and 2, not assumed.
