# Deriv executor (NDX bot, demo account)

`BROKER=deriv` sends the NDX bot's orders to your Deriv **demo** account. The decision engine is unchanged: only the executor behind it is new
([derivExecutor.ts](../src/lib/automation/derivExecutor.ts)). SPX stays on the internal simulation. The Interactive Brokers backend is hidden, not removed:
it is still built and still selectable with `BROKER=ibkr`.

## What Deriv really offers on US Tech 100 (checked live against Deriv's public API)
- The symbol is **`OTC_NDX`** ("US Tech 100", market `indices`, submarket `americas_OTC`).
- **Multipliers are NOT offered on it.** `MULTUP`/`MULTDOWN` are not offered for `OTC_NDX` (62 other symbols have them, for example the Volatility indices), and a proposal for one
  is refused (`TradingDurationNotAllowed`). What `OTC_NDX` offers: `CALL`/`PUT` (Rise/Fall), `HIGHER`/`LOWER`, `ONETOUCH`/`NOTOUCH`, `UPORDOWN`, `RANGE`.
- So the default product is **Rise/Fall for a fixed duration**: a bullish signal buys a `CALL`, a bearish one a `PUT` (stake `DERIV_STAKE`, duration `DERIV_DURATION`/`DERIV_DURATION_UNIT`,
  default 1 hour), and a close **sells the contract back** at market before it expires. `DERIV_PRODUCT=multiplier` exists for symbols that do offer Multipliers and
  **fails loudly** on one that does not.
- A fixed-duration contract is not a credit spread: there are no strikes, and it can end before the bot's own end-of-day sweep. Set the bot's end-of-day sweep to "Close at market" so a
  contract still held at 16:05 New York time is sold.

## How it connects (Deriv's new API)
1. `POST https://api.derivws.com/trading/v1/options/accounts/{DERIV_ACCOUNT_ID}/otp` with `Authorization: Bearer <DERIV_API_TOKEN>` and `Deriv-App-ID: <DERIV_APP_ID>`
   returns `{ data: { url } }`: a WebSocket address with a one-time password (120 seconds, single use).
2. Each operation (a buy, a sell, a status read) gets its own one-time address, connects at once, does its work and closes.
3. Trading calls: `proposal` (a quote), `buy` (`{ buy: <proposal id>, price: <ceiling> }`), `sell` (`{ sell: <contract id>, price: 0 }` = at market),
   `proposal_open_contract` (is it sold, can it be sold). Prices for the underlying come from the public WebSocket (`ticks_history`, count 1), no token.
4. The account is **demo-only**: if Deriv's address for the account is not the `/demo` one, the executor refuses before connecting, unless `DERIV_ALLOW_REAL=true`.

## Trading window
Orders go to Deriv only between **09:35 and 15:55 New York time, Monday to Friday** (`DERIV_HOURS_START` / `DERIV_HOURS_END`, "HH:MM" strings). The time zone is `America/New_York`, so it follows
daylight saving by itself (9:35 is 13:35 UTC in summer and 14:35 UTC in winter), and it uses the exchange calendar like the other bots: no holidays, and an early-close day ends the same
distance before 1:00pm (12:55). It is separate from the hours Deriv has the instrument open.

- **Signals** (opens, and the close inside a flip): outside the window the engine logs `outside_hours` - "Skipped: outside trading window (9:35am - 3:55pm New York time, Monday to Friday). Nothing was sent to the broker." -
  and does nothing. Not even Deriv's sign-in is called. A test alert does not skip the window for Deriv. The window wins over any hours set on the bot.
- **Scheduled closes** (exit options, Close Monitors, the automatic entry retry) use the same window.
- **End-of-day close:** a Deriv-backed bot is swept **a minute before the window ends** (15:54; 12:54 on an early-close day), and the sweep **always sells** the contract, whatever the bot's sweep mode says
  (an "estimate" would mark it expired while Deriv still holds it). A bot's own earlier sweep time still wins. If the app was down and the sweep only runs after the window, nothing is sent: the bot is flagged
  "Needs attention" and the Log says the position is still held and must be closed by hand.
- **The one exception:** a person's own **Close position** button is still sent outside the window, so a position can never be left unable to close.
- Reading a price or an order's status is not an order and is not limited.

## Last buy time
A new contract is only bought up to **window end - the contract's length - a margin** (`DERIV_LAST_BUY_MARGIN_MINUTES`, default 5): **14:50 New York time** for the default 1 hour contract
(11:50 on an early-close day). After it a new signal is logged as **"after last buy time"** (`after_last_buy_time`) and **not sent**: no position is made, nothing is rejected, the bot is not flagged and stays on.
A flip after that time still sells the held contract; only the new buy is skipped. Closes are never held to the last buy time. The executor also refuses a buy after it as a last lock. A contract length that cannot fit
the window (for example 1 day) is refused when the settings are read.

## Results of Deriv positions
A Deriv position's profit or loss is **never** worked out from strikes or a credit, and **no estimate is ever stored** for it:
- A contract the bot sells: its result is Deriv's own profit for the contract, read back (`settlement.kind = "broker"`), which wins over the engine's arithmetic.
- A contract that expired or was left unsold, or any Deriv position the scheduler cannot settle yet: the position says **"unknown, check Deriv"** until Deriv's own `profit` is read (every minute, at most every 10 minutes per position, at any hour).
- The end-of-day estimate, the settlement from the day's closing price and the hindsight comparison all skip Deriv positions. The spread payoff chart is not drawn for them.

## Settings
Set these in your own Terminal or environment file; never paste them into chat. See `.env.example` for the whole list.

| Name | Meaning |
|---|---|
| `DERIV_API_TOKEN`, `DERIV_APP_ID`, `DERIV_ACCOUNT_ID` | required |
| `DERIV_PRODUCT` | `rise_fall` (default) or `multiplier` |
| `DERIV_STAKE`, `DERIV_MAX_STAKE` | dollars per contract (default 10) and the most one order may stake (default 100) |
| `DERIV_DURATION`, `DERIV_DURATION_UNIT` | contract length (default 1 h) |
| `DERIV_HOURS_START`, `DERIV_HOURS_END` | the trading window, New York time (default 09:35 and 15:55) |
| `DERIV_LAST_BUY_MARGIN_MINUTES` | minutes kept before the end, on top of the contract length, for the last buy time (default 5) |
| `DERIV_SYMBOL`, `DERIV_CURRENCY`, `DERIV_MULTIPLIER`, `DERIV_MAX_SLIPPAGE`, `DERIV_ALLOW_REAL`, `DERIV_API_BASE` | optional |

Run `BROKER=deriv PRICE_SOURCE=broker npm run dev` (with the three required names set) to use it.

## How the engine's numbers map
The engine counts a credit spread's price in points and its result as (credit - close price) x 100 x contracts. To keep that arithmetic right without changing the engine, prices from
Deriv are in hundredths of a dollar per contract: an opening's "credit" is stake / 100 and a close's "close price" is (2 x stake - sale value) / 100, so the engine's own formula gives the
profit in dollars exactly. The strikes and width the engine shows for a Deriv position mean nothing to Deriv, and the allocation check still counts risk as (width - credit) x 100.

## Checking the connection yourself
`node scripts/deriv/check.mjs` signs in, connects, and fetches a live price and a proposal (it buys nothing). `node scripts/deriv/check.mjs --trade` also buys one demo `CALL`, prints its
**contract id** (find it on the Deriv portfolio page) and sells it. It refuses to trade on anything but a demo account.
