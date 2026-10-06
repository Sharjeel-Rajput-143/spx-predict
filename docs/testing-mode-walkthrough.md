# Walkthrough: showing the owner the signal engine in testing mode

Everything below runs on the **mock executor**. No broker, no real orders, no outside network. Every trade on screen is labelled **TEST**.

## Before you start (once, privately)

1. Put the run settings in a local, git-ignored env file (for example `.env.local`): `WEBHOOK_SECRET`, `AUTOMATION_TEST_MODE=true`, and clearly-labelled **test** values for each bot's required settings (see `.env.example`). Do not use or show real values; the owner hasn't given them yet.
2. Optional, for a snappier demo: `AUTOMATION_ORDER_POLL_INTERVAL_MS=300`.
3. `npm run dev`, then open **Automation** and click **Testing** (top right), or go to `/automation/status`.

## What he sees on arrival

- A yellow banner: **Mock executor - test trades only. Nothing reaches a broker.**
- One card per bot (SPX and NDX) with an **On/Off** switch (the kill switch), position counters, and **Send test alert** with a price box and two buttons.
- Empty tables: Active positions, Closed and expired positions, Orders, and Alerts and the decision for each.

## The script

1. **Bullish alert.** On the NDX card, click **Bullish - short put spread**.
   - Within a second the card says `bullish test alert at ... -> opened`.
   - **Active positions**: one *Short put spread*, legs like `-20,805 put / +20,795 put`, credit, status `open`, tagged TEST.
   - **Orders**: one *Open (sell the spread)* order, state `filled`.
   - **Alerts**: the bullish alert with its decision `opened`.
   - Say: "A TradingView alert arrived, the engine ran its checks, and opened a put spread. The long strike is always the short strike minus the width - never the price."
2. **The flip.** Click **Bearish - short call spread** on the same card.
   - The card says `... -> closed -> opened`.
   - **Closed positions** now holds the put spread (`closed`). **Active positions** holds a *Short call spread*.
   - **Orders** shows three rows in order: Open, then *Close (buy it back)*, then a new Open. The close is confirmed filled before the new position opens.
   - **Alerts** shows the bearish alert with two decisions: `closed`, then `opened`.
   - Say: "A flip closes the old side, waits for the confirmation, then opens the new one. If the close never confirmed, it would stop and open nothing."
3. **Safeguards (pick any).**
   - Click **Bearish** again straight away: `duplicate_signal` - the engine refuses a repeat inside the window.
   - Type an SPX-sized price (for example 7,720) in the NDX box and send: `price_out_of_range` - a wrong chart can't produce NDX strikes.
   - Switch the NDX bot **Off**, send an alert: `automations_off`, nothing placed. Switch it back **On**.
4. **The other bot.** Repeat step 1 on the SPX card. Show that the NDX position is untouched - each bot has its own limits and queue.
5. **Replay a run (optional).** Open a bot from the Automation list, **Log** tab, click a row: the step-by-step trace with each check's Yes/No and the value it measured.
6. **Reset.** Click **Reset test data** (bottom, next to the alerts) and confirm. Everything recorded clears; bots and settings stay.

## What to say if he asks

- *Why is credit exactly the configured number and P/L blank?* The mock has no market. It fills at the expected credit and reports no close price, and nothing is invented. Real fills come from a real broker later.
- *Is anything sent anywhere?* No. The executor is the mock. A Tradier executor exists but is disabled, defaults to Tradier's sandbox, and is untested against a real account.
- *Does Send test alert use the real path?* Yes: same secret check, validation, dedupe, per-bot lock, decision logic and executor as a real TradingView alert. The only difference is the TEST flag (and, with testing mode on, the clock check is skipped so the demo works outside market hours - the trace says so).
- *What's still needed before NDX can run for real?* The strike increment, both short-strike offsets, the expected credit, the price range, and the end-of-day sweep time - all with no defaults on purpose.
