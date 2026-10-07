# Walkthrough: showing the owner the signal engine in testing mode

Everything below runs on the **mock executor**. No broker, no real orders, no outside network. Every trade on screen is labelled **TEST**.

> **Do not place manual orders on positions the bot manages.** An order placed by hand (at the broker, or in another app) is invisible to the bot: it can leave a position the bot believes is open already closed, or one it has never heard of. To get out of a position, use **Close position** in this app, so the bot, its limits and its log stay in step with the account. The status page carries the same note.
>
> Scope: this walkthrough is the **NDX bot only**. SPX stays in Option Alpha and is not part of this engine.

## Before you start (once, privately)

1. Put the run settings in a local, git-ignored env file (for example `.env.local`): `WEBHOOK_SECRET`, `AUTOMATION_TEST_MODE=true`, and clearly-labelled **test** values for each bot's required settings (see `.env.example`). Do not use or show real values; the owner hasn't given them yet.
2. Optional, for a snappier demo: `AUTOMATION_ORDER_POLL_INTERVAL_MS=300`.
3. `npm run dev`, then open **Automation** and click **Testing** (top right), or go to `/automation/status`.

## What he sees on arrival

- A yellow banner: **Mock executor - test trades only. Nothing reaches a broker.**
- The NDX bot's card with an **On/Off** switch and a separate **Kill switch**, the numbers he knows from Option Alpha - **Allocation, Capital at risk, Available, Positions today (of the daily limit), Active positions (of the position limit)** - a line saying how strikes are chosen, and **Send test alert** with a price box and two buttons.
- An **Activity alerts** list (opened, closed, warning, error). Email is off.
- Empty tables: Active positions, Closed and expired positions, Orders, and Alerts and the decision for each.

## Attach the webhooks (once)

1. **Settings > Webhooks > Your webhooks**: create *BullishNDX* and *BearishNDX* (a name only; they start unattached).
2. Open the **NDX Bias Bot > Settings > Automations**. Click the **gear** on the **Bullish** trigger, pick *BullishNDX* in the dropdown, **Save**. Do the same on the **Bearish** trigger with *BearishNDX*. A webhook already on the other trigger shows as unavailable (one webhook, one trigger).
3. The panel shows the URL masked: **Reveal** or **Copy** gets the full one for TradingView. **Test hook** sends a test call through the real path. **Detach** removes it. Each change is in the bot's Log.

## The script

1. **Bullish alert.** On the NDX card, click **Bullish - short put spread**.
   - Within a second the card says `bullish test alert at ... -> opened`.
   - **Active positions**: one *Short put spread*, legs like `-20,805 put / +20,795 put`, credit, status `open`, tagged TEST.
   - **Orders**: one *Open (sell the spread)* order, state `filled`.
   - **Alerts**: the bullish alert with its decision `opened`, and under it the target price, rounding and strikes (`Target 21,003.69 (21,003.7 - 0.01), rounded down to 5 -> short 21,000, long 20,990`).
   - **Activity alerts** gains an *Opened* line; the card's Capital at risk and Positions today move.
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
   - Switch the NDX bot **Off** with nothing held and send an alert: `automations_off`, nothing placed. With a position held, send the **opposite** alert: the log says "Bot off, close only", the position closes, and the Open step is blocked ("Bot off"): nothing new opens. This is Option Alpha's "Always On", copied only for closes - **opens always respect the bot switch**. Switch it back **On**.
   - Turn the **Kill switch** on and send any alert: `kill_switch`, nothing closed, nothing opened. The end-of-day sweep and **Close position** still work with it on. Turn it off.
4. **A limit switches the bot off.** Open the NDX bot's Settings > Safeguards, set the allocation to a small number (for example 600) and send a bullish alert: the decision is `allocation_limit_reached`, the card shows **Needs attention** with the reason, an *Activity alert* is raised, and the bot is **Off**. Put the allocation back, check the bot, switch it **On**. The position limit and the daily limit do the same. Ten errors in one trading day do it too (`error_failsafe`); the count starts again the next trading day.
   - Say: "When a safeguard trips, the bot stops and tells you why. It doesn't carry on trading and it doesn't keep guessing."
5. **The end-of-day sweep.** The NDX bot's sweep time is 16:05 ET, ten minutes before its options stop trading (4:15pm). With a position still open, **Settings > Bot inputs > End-of-day sweep** decides what happens: *estimate* (the position expires and its P/L is worked out from the underlying's price, labelled *est.*), *market* (a market close order is sent), or *manual* (it expires and appears under **Waiting for your P/L**, where you type the result in). With no fresh price to estimate from, the position waits there too.
6. **Replay a run (optional).** With live quotes each price the order tried is listed in the trace, in order, with what happened at each. Open a bot from the Automation list, **Log** tab, click a row: the step-by-step trace with each check's Yes/No and the value it measured.
7. **Reset.** Click **Reset test data** (bottom, next to the alerts) and confirm. Everything recorded clears; bots and settings stay.

## What to say if he asks

- *Why is credit exactly the configured number and P/L blank?* The mock has no market. It fills at the expected credit and reports no close price, and nothing is invented. Real fills come from a real broker later.
- *Is anything sent anywhere?* No. The executor is the mock. A Tradier executor exists but is disabled, defaults to Tradier's sandbox, and is untested against a real account.
- *Does Send test alert use the real path?* Yes: same secret check, validation, dedupe, per-bot lock, decision logic and executor as a real TradingView alert. The only difference is the TEST flag (and, with testing mode on, the clock check is skipped so the demo works outside market hours - the trace says so).
- *What's still needed before NDX can run for real?* The strike increment, both short-strike offsets, the expected credit, the price range, and the end-of-day sweep time - all with no defaults on purpose.
