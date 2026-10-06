# Signal bots - known limitations

Things that look like bugs but are deliberate for now. Each says why, and what would change it.

## The automation builder is a design tool, not a runtime

- **Saved flows don't run.** Flows, attached automations and symbol-scan settings are stored in the browser (`localStorage`, see `src/components/automation/builder/store.ts`). They are not sent to the server, are not read by the signal engine, and can't place an order or call a webhook. The UI marks them **Preview**. Clearing site data deletes them; they don't follow you to another browser.
- **Run test is a read-through.** It lists the steps in order (both paths of every decision) and evaluates nothing. The "Prevent automation from modifying bot" box is real UI but changes nothing, because there is nothing connected to modify.
- **Entry / Position criteria are saved, not enforced.** The 7 + 16 checklists are part of a design. The engine applies its own fixed guards (position, daily and allocation limits, leg overlap, strike validation) and does not read them.
- **Open Position settings don't drive strikes.** The engine builds strikes from the bot's offsets, width and quantity (Settings > Bot inputs). The built-in Bullish/Bearish flows are *drawn from* those inputs for reference; editing them is disabled.
- **To make a flow real** it would need a server-side store, a validator, and an executor that runs steps through the same guards, lock and decision log as a webhook signal. That replaces the spec'd fixed decision logic with user-defined logic and is a design decision, not a bolt-on.

## Builder details

- **Conditions are a fixed catalog, not a live search.** The condition picker offers a hand-written set of sentences (Stocks / Indicators / Positions / Bot) and filters them as you type. It does not query market data or an indicator registry. Adding a condition means adding an entry to `CONDITION_CATALOG` in `builder/model.ts`.
- **The node menu has no "Move".** It offers Settings, Precede with..., Copy Action, Edit Caption, Edit Notes and Delete. Steps are placed with the + buttons and *Precede with...*; there's no drag-and-drop or "move to another branch".
- **Steps can only be appended** at the end of a branch, or inserted before an existing step. There is no insert-after or reorder.
- **Conditions are ANDed.** A Decision can stack several conditions; there is no OR / grouping.

## Position details

- **Shown as "-" on purpose:** market value, mid price, bid/ask, delta/theta/gamma/vega, alpha, EV and the probabilities. They need an option chain or a pricing model; nothing is estimated. Everything that follows from the trade itself is real: credit, capital at risk, max profit/loss, breakeven, reward/risk, OTM %, days in trade, and the expiry payoff diagram.
- **The payoff diagram is the expiry payoff**, not today's mark-to-market curve (that would need option prices). The blue pill is the live SPX quote when there is one, else SPX at open.
- **Exit Options are shown but disabled** (Edit / Reset stats, the "off" warning, five rows of "None"): profit targets and stop losses need live option prices, and there are no high/low watermarks to show.
- **Override is disabled.** There is no way to override a position's status in Phase 1.
- **Move** reassigns an *open* position to another bot on the *same account* that is set up, not archived, and has room under its limits. It moves the position's counts too (the target's "opened today" goes up). Both bots get a "Position moved" decision.

## Automation log (the run replay)

- **Only runs from now on have a trace.** The engine now records, for every signal and manual action, the checks it walked through (each with its Yes/No and the real value it compared) and the orders it placed (with the exact legs and a frozen copy of their settings). Entries from before that was added only have their outcome, and the log says so.
- **The checks are the engine's own, not Option Alpha's.** A flip reads: bot on, (trigger on), market hours, not a duplicate, opposite side held?, no close in flight, **Close card**, room for the wanted side, position / daily / allocation limits, strikes valid, no leg overlap, **Open card**. A run that stops early shows only the checks it reached.
- **The "as sent" tooltip lists what the engine actually sends** - for a close that's the quantity and confirm timeout (a close order carries no limit price); for an open it's the limit credit, quantity, expiry, how each strike was derived, and the fill timeout. There is no Memo or Tags field because the engine's orders don't have them.
- **View position** opens the position's details if it still exists; it's disabled once a bot's history has been deleted.
- **A crash mid-run is logged too.** An unexpected error leaves an "Unexpected error" decision row and a trace of the steps reached, then still surfaces to the caller.
- **Clear Log hides, it doesn't delete** - traces stay in the export store and in the engine's duplicate protection.

## Not built (Phase 1 has nothing behind them)

- **Exit Options** (profit target / stop loss on a position) - needs live option prices.
- **P/L, Change, Return, win rate and the rest** show "-" until the executor reports fill prices. `AUTOMATION_MOCK_PRICING=simulated` invents close prices for demos; the bot page then says every figure is fictional.
- **Scan Speeds and watchlist scanning** - these bots are driven by webhook signals, not polling. The Bot symbols panel saves its settings as a preview only; the engine trades SPX.
- **Transfer History**, **Backtester**, and the rest of the Option Alpha sidebar (Home, Trade Ideas, Screener, Community, More Tools).
- **"Show tags" on positions** - positions aren't tagged; bots are.
- **Live accounts.** Every bot is paper (mock executor). The Live filter exists but matches nothing until a real broker (Phase 2) is connected. Brokerage account numbers, when they exist, are masked in the UI.

## Behaviour worth knowing

- **An empty bot can't trade until its inputs are set.** Name, account and allocation are all it needs to exist, but the strike offsets and expected credit have no defaults, so it shows *Setup needed* and refuses to switch on until they're entered.
- **Day trading "Not allowed"** holds a same-day position to expiry instead of flipping it; manual closes still work.
- **Sign-in** is skipped in development when `AUTOMATION_STATUS_PASSWORD` is unset, and a production build refuses all access without one.

## NDX bot (ndx_ema_bias)

- It is the same engine and webhook as SPX, configured by `BOT_NDX_EMA_BIAS_*` env values. Until the required ones are set (strike increment, expected credit, price range, sweep time) it shows "Setup needed" and every signal for it logs `config_error` naming what is missing. They have no defaults on purpose; the real numbers come from Blue and the option chain.
- Still to verify before live use (marked TODO in `.env.example`): the NDXP root and a 0DTE series every weekday, the real strike increment, the series' final trading time, and the broker. Mock executor only.
- `symbol_mismatch` is checked only when the alert sends a `symbol`. A body with no symbol is protected by the price range alone, so keep the alert body from the addendum.
- Bots are only ever created in the UI as SPX; NDX is the env-configured built-in. Extra NDX bots from the New Bot form are accepted by validation but the form has no NDX option yet.
- The allocation check keeps its existing outcome name, `allocation_limit_reached` (the addendum calls it `allocation_exceeded`).
- Broker research (Tradier) and the disabled executor are in `docs/tradier-executor-research.md`.

## Testing mode and the Tradier executor

- The admin page (Automation > Testing, `/automation/status`) is the demo surface: positions with legs and credit, orders and their states, the decisions under each alert, bot on/off, **Send test alert**, **Reset test data**. Every trade on the mock executor is labelled TEST.
- Send test alert is mock-only. It builds the TradingView body on the server (the secret never reaches the browser) and calls the same ingest function as the webhook. It only differs by an internal `test` flag, which a webhook body cannot set.
- A test alert runs outside trading hours only with `AUTOMATION_TEST_MODE=true`; the trace then says "Testing mode: clock check skipped". Real alerts always obey the clock.
- The mock fills at the configured expected credit and reports no close price, so credit shows the configured number and P/L stays blank. Nothing here says anything about real fills.
- Reset test data wipes every recorded alert, position, order, decision and run (bots and settings stay) and is refused unless the mock executor is selected.
- `EXECUTOR=tradier` is implemented but disabled and unverified against any real account - see the TODO list in `docs/tradier-executor-research.md`. `symbol_mismatch` and `price_out_of_range` leave the signal row as "accepted" (the route answers 200); the decision log carries the outcome.

## Settings taken from the live Option Alpha SPX bot

- **Offsets are decimals now.** The live bot puts the short strike 0.01 beyond the price. Both built-in bots default to put -0.01 / call +0.01. For SPX that is the owner's real value; for NDX it is the SPX bot's value copied over - **owner to confirm for NDX**. The NDX strike increment is still required, with no default.
- **Rounding mode (`*_STRIKE_ROUNDING`, default `outward`).** The short put rounds down and the short call rounds up (the out-of-the-money side); `nearest` is the alternative. **TODO: verify "outward" against Option Alpha's real behavior.** This is the default for every bot, so an SPX signal at a price like 7720.5 now gives a call spread at 7745/7750 where it used to give 7740/7745. Set `BOT_SPX_EMA_BIAS_STRIKE_ROUNDING=nearest` to get the old result.
- **Every decision records how its strikes were chosen**: price, signed offset, target (price + offset), rounding mode, increment and the chosen short/long strikes - in the decision's detail, on the status page under each alert, and in the run trace.
- **Order price is a percent of bid/ask** (`*_OPEN_PRICE_PERCENT`, `*_CLOSE_PRICE_PERCENT`, default 100, shown on the bot's Settings and on the order). **TODO: the exact meaning of "100% of bid/ask" is unconfirmed**, and the mock has no bid/ask, so nothing is computed from it yet - it travels with the order for a real executor. The credit-below-width check is unchanged.
- **Position limits per bot.** SPX holds up to 3 positions by default (`BOT_SPX_EMA_BIAS_TOTAL_POSITION_LIMIT`), NDX stays at 1; a limit set under Settings > Safeguards still wins. One position per side stays the default, so the live bot's flows (close the opposite side, then open if none is open) are unchanged.
- **Activity alerts** (opened, closed, warning, error) are recorded for each bot (per-bot switches under Settings > Alerts, all on) and listed on the status page. Warnings are safeguard blocks (limits, symbol mismatch, price out of range, overlap); errors are failures (executor error, rejected or timed-out orders, bad config). Routine skips (bot off, outside hours, same side already held, duplicates, dry run) raise none. **Email is optional and off by default, and no mail sender is wired**: with `ALERT_EMAIL_ENABLED=true` and `ALERT_EMAIL_TO` set, each alert is only marked "queued". Choosing a provider is the owner's call.
- **The two-stage flip stays**: close, wait for the confirmation, then open - safer than Option Alpha's single path.
- **Option Alpha's "Close Monitor" automations are deliberately not copied.** It uses them to sweep wrong-side positions. If a similar check is wanted later it must compare against the **latest confirmed signal**, so it can never close the correct side.

## Order pricing and the other Option Alpha options (decided)

- **The mechanism is understood.** "100% of bid/ask" on the live bot is the **Final Price** setting inside a **SmartPricing** ladder running in **Normal** mode: up to four timed limit orders, ten seconds apart, the last one reaching the full bid/ask spread. Close Position uses the same preset, with quantity 100% of the position.
- **Our single price plus the 120 second timeout is a deliberate simplification of that, for now.** The engine sends one price and waits; the percent-of-bid/ask settings travel with the order but nothing is computed from them, because the mock has no bid/ask.
- **Final check with Blue:** only whether the live bot was ever switched off Normal. The mechanism itself is not an open question.
- **Planned follow-up, tied to the broker decision (deferred, not forgotten):** once a broker is chosen and wired to live quotes (Tradier or otherwise), revisit adding a repricing ladder that steps toward the full spread the way Normal does - four prices, ten seconds each, ending at 100% of bid/ask. Until then the single price stays.
- **Intentionally out of scope:** the other strike modes (delta, percent, expected move, GEX...), the other position-sizing modes (risk caps, percent of allocation, martingale), exit options (profit taking, stop loss, trailing stop...) and the entry and position filters. The live bot uses none of them, so there is nothing in its behavior to match. The engine stays as is: flat offsets for strikes, fixed contract sizing, no exit logic, hold to expiry with the end-of-day sweep. Any of these gets built only when specifically asked for.
- **Other points from the same review:** OA's start/end times are choices on a 5-minute grid (ours take any HH:MM); OA has no weekday condition (our guard adds weekdays and the NYSE calendar); its position-count check ("exactly or more than 1 ... any status") matches ours, which counts opening, open and closing positions; its expiration is exactly 0 days, any series (not monthlys only), calendar days; NDX is not a searchable symbol there.

## The built-in canvas is live; the flows you design are still previews

- **Bullish and Bearish signal (Settings > Automations):** the canvas now opens as "Built-in · live". Click a node to edit its real values: the market time window (start and end on the 5-minute marks, or back to the default window), the open step (short strike offset with decimals, rounding, width, contracts, expected credit, price % of bid/ask) and the close step (price % of bid/ask). Save writes them to the bot's settings - the same ones as Settings > Bot inputs - and they apply to the next signal; an open position keeps the values it was opened with. The canvas redraws from the saved values.
- **The shape of the flow is fixed.** It is the engine's logic, so steps can't be added, removed or reordered there, and the position-check nodes are explanations, not editable. Duplicate protection, the limits (Settings > Safeguards), the strike checks and the failsafe aren't drawn.
- **Shared values.** Window, rounding, width, contracts, credit and price % belong to the bot, so editing them on the Bullish canvas also changes the Bearish one. Only the short offset is per side.
- **Saving stores the bot's inputs with the bot**, which overrides its environment settings from then on (as Bot inputs already did for a built-in bot). The values it didn't show - option root, price range, sweep time, position limit - are carried over unchanged.
- **Designs you build with the + button are unchanged:** they save to this browser only and don't reach the engine.


## Settings page (modelled on Option Alpha's)

- **Sections:** General, Trading Accounts, Bot Archive, Webhooks - in this app's own styling. Option Alpha's Subscription Plan, Community Profile and Referral Program are about their business, not this engine, and are not built. Personal information and Change Password are omitted too: sign-in is one shared password (`AUTOMATION_STATUS_PASSWORD`).
- **Real, saved settings:** the default trading window (Bot schedule; a bot's own window on its canvas still wins), email preferences, session timeout, and text size (this browser only). Bot Archive restores and deletes for real.
- **Email is preferences only.** No mail sender is connected, so enabling it queues each alert and sends nothing. Which provider to use is the owner's call.
- **Session timeout** only matters when sign-in is required (a password is set). Two-step authentication is shown as not available.
- **Trading Accounts** is read-only: the executor in use and the accounts the bots name. Add account is disabled until the broker decision.
- **Webhooks** now leads with the alerts this app *receives*: the URL, whether `WEBHOOK_SECRET` is set (never its value), and a ready TradingView message for each bot and direction with a `<SECRET>` placeholder. The old outbound Option Alpha connections sit behind a "Show connections" button, so opening Settings no longer loads them.
- **Exit options and in-the-money positions:** unlike Option Alpha there are no exit options and no auto-close, so these show as explanations, not controls.
