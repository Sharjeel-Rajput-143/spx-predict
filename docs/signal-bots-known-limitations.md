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
