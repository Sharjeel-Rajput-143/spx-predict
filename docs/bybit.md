# Bybit demo executor

A third backend behind the same `BrokerExecutor` interface (next to the simulation and Deriv). It trades the **BTCUSDT linear perpetual** with **market orders** on a Bybit **demo** account, with a stop loss and a take profit on Bybit's side, a daily loss limit, a kill switch, and a results panel on the site. The decision engine is unchanged: a confirmed TradingView 9/20 EMA signal comes in, a flip closes the opposite side and only then opens the new one, and the duplicate guard still applies.

Code: `src/lib/automation/bybitExecutor.ts` (orders and stops), `bybitDay.ts` (the day's numbers and the limit), `bybitRisk.ts` (the monitor), `bybitView.ts` + `components/automation/BybitPanel.tsx` (the display). Tests: `bybit*.test.ts`, `BybitPanel.test.tsx`, `scripts/bybit/check.test.mjs`.

## Switching it on

Put these in **`.env.local`** (git-ignored; never in chat, a commit or a screenshot), then restart the app:

```
BROKER=bybit
BYBIT_DEMO_API_KEY=...        # Bybit -> Demo Trading -> profile -> API -> Create New Key (trade permission)
BYBIT_DEMO_API_SECRET=...
STOP_LOSS_PERCENT=1           # percent of the entry price
TAKE_PROFIT_PERCENT=2
POSITION_SIZE=0.001           # BTC per order (Bybit's smallest)
DAILY_MAX_LOSS_USD=50
BREAKEVEN_TRIGGER_PERCENT=0.3 # optional: move the stop to breakeven at this much profit (default 0.3; 0 = off)
BREAKEVEN_LOCK_PERCENT=0.12   # optional: put the moved stop this far past the entry, on the profit side (default 0.12)
BYBIT_ALWAYS_ON=true          # 24/7; leave unset to keep to the 09:35-15:55 New York window
```

The last four risk settings have **no defaults**. With any of them (or the key or secret) missing, the executor does not exist: the Settings page shows "Not usable" naming what is missing, and an order throws before any request is made.

Which bot: the **BTC Bybit Bot** (bot id `btc_bybit`, underlying `BTC`) is the only bot whose orders go to Bybit. The NDX Bias Bot has **no link to Bybit**: with `BROKER=bybit` it runs on the internal simulation (its positions are labelled simulated), turning it on never places a Bybit order, and the Bybit executor itself refuses any order for another underlying. `BRIDGE_SYMBOLS` is not used for Bybit. The BTC bot works from **Bybit's own price** (the demo host's mark price of BTCUSDT), never the NDX quote; a BTC trade is recorded as a BTC trade (no option spread is created), with the real fill as its entry and exit and Bybit's result after fees. The two named webhooks ("Bybit bullish" / "Bybit bearish") belong to this bot. The signal is whatever TradingView sends that bot's webhook, so point that alert at the **BTCUSDT chart**. The "NDX" in the bot's name is only a label for this wiring. The bot's quantity must be 1: one fixed size, one position.

## The BTC Bybit Bot

Its own bot, separate from the NDX Bias Bot (Automation, bot "BTC Bybit Bot"). It keeps the same signal rules as every bot: bullish goes long, bearish goes short, a flip closes the other side first (reduce only, confirmed) and then opens, the duplicate guard, one call a minute per webhook, the daily loss limit, the kill switch, the 10-second risk monitor, the breakeven stop and the fast webhook answer. It trades only BTCUSDT on the Bybit demo account.

- **Webhooks:** "Bybit bullish" and "Bybit bearish" are attached to this bot's Bullish and Bearish triggers. They were moved from the NDX Bias Bot with the same tokens, so the TradingView alerts and ngrok need no change (`src/lib/automation/btcBotMigration.test.ts` is the one-time tool that did it; run only with the app stopped).
- **Prices:** the bot's price is Bybit's, the signal's price shown in the Log is Bybit's mark price at the moment of the call, and the trade's entry and exit are Bybit's real fills.
- **Where the trades show:** Bybit page (live trade and Bybit's full history), Positions (the bot's open trade and closed trades: BTC prices, result after fees, how each closed, labelled "Bybit demo · BTC"), the bot's own page, and Calendar (each day's result after fees, New York dates; the BTC bot trades around the clock, so the calendar's market closures do not stop it).
- **History page:** the "History" item in the left menu is the prediction game's history and is unrelated to the bots; the BTC trade history is on the Bybit page and under Positions.
- **Daily limit:** counted from this bot's own closed trades (a bot's day starts at $0), plus the open loss as Bybit reports it.

## What it sends

| Step | Call |
|---|---|
| Bullish signal | `POST /v5/order/create` Buy, Market, `category: linear`, `positionIdx: 0` (one-way mode), `qty: POSITION_SIZE`, **`stopLoss`, `takeProfit`** (triggered on the mark price, closing at market, whole position), `orderLinkId` |
| Bearish signal | the same with `side: Sell` (a short; the stops are mirrored) |
| Close / flip | the opposite side, Market, **`reduceOnly: true`**, the same size |
| Check the stops | `GET /v5/position/list` shows the stop loss and take profit on the position; if missing, `POST /v5/position/trading-stop` sets them once |
| Status | `GET /v5/order/realtime` (then `/v5/order/history`) |
| Safety reads | `GET /v5/position/list` before every open and every close |
| What Bybit closed | `GET /v5/order/history` (a filled order with `stopOrderType` StopLoss / TakeProfit) |
| Result | `GET /v5/position/closed-pnl` (Bybit's own profit and loss, net of fees) |

Every private call is signed (HMAC-SHA256 over `timestamp + apiKey + recvWindow + query-or-body`). The stops are `STOP_LOSS_PERCENT` / `TAKE_PROFIT_PERCENT` of Bybit's mark price at the moment of the order, rounded to the price tick (a long stops below and takes profit above; a short is the mirror). They are percent of **price**, not of margin: with leverage the loss on the margin is bigger.

## The flip, step by step

1. A confirmed signal for the **other** side arrives. The engine first asks Bybit what became of the bot's open position (see "A stop or take profit closes it" below).
2. It sends a **reduce-only market** order on the old side and reads the order back until Bybit says it is filled.
3. Only then does it open the new side. The open itself refuses unless Bybit shows the account **flat**.
4. If the close fails, **nothing new is opened**, the error is logged (Log tab, an error record, the bell), and the bot is flagged.

A signal for the side that is **already open** is ignored (`already_in_position`); the same alert delivered twice, or any identical one within 120 seconds, is ignored (`duplicate_signal`). There is only ever one open position in the symbol.

## A stop or take profit closes it

Bybit closes the trade by itself when the mark price reaches the stop loss or the take profit. The bot finds out at three moments: when a signal arrives, when someone presses Close position, and every 10 seconds while a trade is open (the risk monitor). The account being flat while the bot's record is open means Bybit closed it: the position is marked **closed**, with how (`stop_loss`, `breakeven_stop` (a stop that had been moved to breakeven), or `take_profit`, from Bybit's own order history, `closed_at_broker` if it was closed by hand), its real exit price and the real result. The bot is then flat, and the **next confirmed signal opens normally** (on either side).

## Risk rules

- **Stops on every entry.** The entry carries them. After the fill the position is read back; if either is missing it is set once (`trading-stop`) from the real entry price. If that fails the position is **closed again at once** (reduce only) and the failure is thrown and logged ("Entry closed again at once: the stop loss and take profit could not be attached..."). If even that close fails the error says **UNPROTECTED POSITION** in capitals, and the bot is flagged.
- **Daily loss limit (`DAILY_MAX_LOSS_USD`).** The day's loss is the realized result of the trades closed today plus the open loss as Bybit reports it (an open profit offsets nothing). When it reaches the limit the monitor closes every open position (reduce only), remembers the day, and new entries are refused (`daily_loss_limit_reached`) until the next New York date. It is checked every 10 seconds while a trade is open and before every entry. "Day" is the New York calendar date, like every other daily count in the app.
- **Breakeven stop (`BREAKEVEN_TRIGGER_PERCENT`, `BREAKEVEN_LOCK_PERCENT`).** So a winner cannot turn into a big loser. The 10-second risk monitor watches the open trade; once it is `BREAKEVEN_TRIGGER_PERCENT` in profit (percent of the entry price, measured at the mark price, the price the stops use; default 0.3) its stop loss is moved **at Bybit** (`trading-stop`, so it protects the trade even if this app stops) to `BREAKEVEN_LOCK_PERCENT` past the entry on the profit side (default 0.12, so being stopped out roughly covers the fees). For a long that is `entry x (1 + lock/100)`, for a short `entry x (1 - lock/100)`, rounded to Bybit's price tick toward the profit side. Rules: **the take profit is not sent and does not move**; the stop is **only ever tightened** (a stop already at or past that price, for instance one you moved by hand, is left alone); it is done **once per trade** and written on the trade, so running twice (or a restart) never repeats it; a flip, a close or a new trade starts with none. If Bybit **refuses** the move because the price is already beyond the new stop (retCode `10001`), the trade is closed instead with a reduce-only market order (`breakeven_close`) and the log says so; any other failure is logged and tried again on the next pass. The kill switch and the daily loss limit come first: when either closes the trade nothing is moved. `BREAKEVEN_TRIGGER_PERCENT=0` turns it off; the lock must be below the trigger or the settings are refused. The Bybit page's open-trade box then says "Stop loss: moved to breakeven" with the new price and the time, and a trade closed by that stop shows **Breakeven stop** under How it closed (not "Stop loss"). If the stop is hit, Bybit closes at the stop price, so the result is about the lock minus fees (a small plus or minus), not a full stop loss.
- **Kill switch.** The bot's Kill switch button (or `BYBIT_KILL_SWITCH=true`, which needs a restart) stops every new order at once, and the monitor **closes the open position** (reduce only, `kill_switch`). The executor itself refuses an open while it is on, so even a manual order cannot go out.
- **Demo only.** The host must be `api-demo.bybit.com`; any other `BYBIT_API_BASE` is refused when the settings are read. There is no setting for real money.
- **One fixed size.** `POSITION_SIZE` per order, an order for more than one contract is refused.
- **Closing is reduce only.** A close can never open the other side, and is checked against what the account really holds (refused, with nothing sent, if it doesn't hold that side in that size).
- **A lost answer is not retried.** If an order request gets no answer, the order is looked up by its `orderLinkId` before anything is called failed; if it still can't be known the error says to check Bybit before sending another.
- **Every step is logged:** each signal and what was decided, each order (the Orders list), each fill, each stop, flip and close (with the reason), and each failure (Log tab, error records, the bell). The key and secret never appear.

## Trading window

- `BYBIT_ALWAYS_ON=true`: orders at any time (weekends and holidays too). There is **no end of day**: nothing is swept, no position is marked expired, and a position stays held until a signal, a stop or a limit closes it.
- Otherwise: only inside `BYBIT_HOURS_START` to `BYBIT_HOURS_END` (default 09:35 to 15:55 New York time, Monday to Friday, exchange calendar). The end-of-day sweep closes what is held a minute before the window ends. A person's own **Close position**, the kill switch and the daily limit are never held to the window.

## Results on the site (Status page, under the executor banner)

Refreshes every 3 seconds from Bybit.

- **Open trade:** side, entry price, current (mark) price, size, and the live profit or loss in dollars (green with `+`, red with `-`), plus the stop loss and take profit set at Bybit. These are Bybit's own position fields (`avgPrice`, `markPrice`, `unrealisedPnl`), not our arithmetic. If Bybit can't be read it says so rather than showing an old number; if the bot and the account disagree it says that too.
- **Closed trades:** entry, exit, how it closed (signal flip, stop loss, take profit, daily limit, kill switch, end of day, closed by hand / at Bybit), the final profit or loss, and the time. A result Bybit itself reported is labelled "Bybit".
- **Totals:** today's result (realized + open), the running total, and the **room left before `DAILY_MAX_LOSS_USD`** with a bar.

## Profit and loss

Never worked out from the strikes or width the engine builds (they mean nothing to Bybit). The engine's arithmetic is kept by carrying a price as the dollar value of one contract divided by 100; both entry and exit are Bybit's real fill prices, so `(credit - close price) x 100` is exactly `(exit - entry) x size` for a long (and `(entry - exit) x size` for a short), before fees. Once Bybit lists its closed profit and loss for the closing order, that net figure (fees included) replaces it. If the demo doesn't support that endpoint, the fill-based figure stays.

## Checking it against your demo account

```
npm run bybit:check            # reads only: time, limits, price, balance, position, orders, closed PnL
npm run bybit:check -- --trade # opens one 0.001 order WITH its stops, checks they are on the position, closes it reduce only, reads Bybit's closed PnL
npm run bybit:demo-test        # the full scenario test below
npm run bybit:selftest         # the same scenarios against the in-memory fake (no network, no key): proves the test itself
```

`bybit:demo-test` runs the real executor and engine against the demo account and prints exactly what Bybit returned for every call (also saved to a file whose path it prints): (0) connect, (1) one open and close, (2) duplicate signals, (3) a flip, (4) a stop loss hit at Bybit, (5) the daily loss limit, (6) the site's open profit/loss against Bybit's own position data, (7) the kill switch. It refuses to start unless the account is flat, ends every scenario flat, and says INCONCLUSIVE (never a made-up pass) when the market did not move far enough in the wait to reach a stop or the limit. A call the demo does not support is reported with Bybit's own retCode and message.
