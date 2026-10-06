# Tradier paper account (sandbox): checklist

**Status: nothing is connected.** The Tradier executor stays disabled (`EXECUTOR=mock`) until both sides confirm this checklist is complete. Nothing here places an order.

- **Part 1** is for Blue, in plain language.
- **Part 2** is for us (the developers).

---

# Part 1 - For Blue

**This is test money only.** A Tradier "sandbox" is a practice account with pretend money. Nothing real is touched: no real cash, no real trades, no real brokerage balance. The system only ever talks to the practice side.

## 1. Get the practice (sandbox) account details

1. Go to **tradier.com** and create a free account (or log in if you already have one). Please do this yourself: the account has to be in your name, and we can't create it for you.
   - If it asks you to deposit money or link a bank, **stop and tell us first**. We don't need real money for this.
2. Log in at **web.tradier.com**.
3. Click **your name (top right)**, then **API Access**.
4. On that page, scroll to the section called **Sandbox Account Access (Paper Trading)**. You need two things from that section only:
   - the **Sandbox access token** (a long string of letters and numbers), and
   - the **Sandbox account number**.
5. **Do not copy anything from the "Production" (real money) section**, and don't show that section to anyone. We never need it.

> Tradier's screens change from time to time. If a name above doesn't match what you see, tell us what you do see and we'll point you to the right place.

## 2. How to send them to us safely

The token works like a password. **Never** paste the token or account number into Upwork chat, email, a GitHub file, or any message. If one ends up there by mistake, tell us straight away and we'll replace it.

**The safest way, and the only one our app supports today:** on a screen share, **you type them yourself** into our server's private settings (we set up the empty spots beforehand; you only fill in the two values). We won't record the call or take screenshots while they're on screen. Afterwards, if the Tradier page lets you generate a new token, do that once the testing is finished.

- Entering them on the app's own **Settings page** is **not available** today, and we don't recommend adding it: it would store the token inside the app's data files.

## 3. What we still need you to confirm

Please answer these in plain words:

> **Values still marked TODO until Blue confirms** (they are copies or defaults, not choices anyone made for NDX): the short strike offsets, the 5-point strike increment (the Tradier check will show the real one), the 10-point width, 1 contract, a position limit of 1, and the $2,000 allocation.

1. **Short strike distance for the NDX bot.** We are using **0.01 below the price for puts** and **0.01 above the price for calls** (copied from your SPX bot, which is the closest example we have). Is that what you want for NDX?
2. **Trading hours.** Alerts are acted on **9:35am to 3:55pm New York time**. Keep that, or change it?
3. **Size.** We start with **1 contract**, **10 points wide**, **one position at a time**, and **$2,000** set aside for the bot, with strikes **5 points apart** (we'll confirm the real spacing once connected). OK for the test?
4. **How long the test runs.** Option Alpha's own advice is 30 to 60 days of practice before using real money. How long do you want?
5. **No manual orders.** Please confirm you **will not place orders by hand on positions the bot manages** (not at Tradier, not in another app). If you want out of a position, use the **Close position** button in our app. Hand-placed orders are invisible to the bot and will confuse it.
6. **Your TradingView alert.** Please confirm:
   - you (or we, with you) will create the alert in TradingView. Webhook alerts need two-step login (2FA) switched on in TradingView;
   - the alert web address (URL) comes from our app's **Settings > Webhooks**, one for bullish and one for bearish. The web address itself works like a password, so send it the same safe way as the token, not in chat.

---

# Part 2 - For us

## 1. What the app needs in its environment

Variable names only. Never put values in this file, the repo, chat or logs. Local values go in the git-ignored `.env.local`.

| Variable | What it is | Local (`.env.local`) | Vercel | Always-on server (later) |
| --- | --- | --- | --- | --- |
| `EXECUTOR` | `mock` (default) or `tradier` | `tradier` only once we both confirm | **Never** (refused there; Vercel stays the mock demo) | `tradier` |
| `TRADIER_TOKEN` | the **sandbox** token | yes | **Never** | yes |
| `TRADIER_ACCOUNT_ID` | the **sandbox** account number | yes | **Never** | yes |
| `TRADIER_BASE_URL` | **leave unset** (the default is the sandbox) | unset | unset | unset |
| `TRADIER_ALLOW_PRODUCTION` | **never set** during paper trading | unset | unset | unset |
| `TRADIER_MAX_CONTRACTS_PER_ORDER`, `TRADIER_MAX_RISK_PER_ORDER` | caps on one opening order (required for production, optional in the sandbox) | optional: 1 and a small dollar figure | n/a | optional |
| `AUTOMATION_DRY_RUN` | `true` first: reads quotes and writes the decision log, sends no order | `true` | n/a | `true` first |
| `AUTOMATION_STATUS_PASSWORD` | sign-in for the admin pages (**required** with Tradier: no password means access denied) | yes | n/a | yes |
| `WEBHOOK_SECRET` | secret for the older single webhook URL (named webhooks carry their own secret in the URL) | yes | n/a | yes |
| `AUTOMATION_DATA_DIR` | folder for the bots' records (needs a persistent disk, backed up) | scratch folder | n/a | a path on the persistent volume |
| `BOT_NDX_EMA_BIAS_PUT_SHORT_OFFSET`, `..._CALL_SHORT_OFFSET` | short strike offsets (Blue to confirm) | optional | n/a | yes |
| `BOT_NDX_EMA_BIAS_STRIKE_INCREMENT` | strike spacing near the money (from the probe) | after the probe | n/a | yes |
| `BOT_NDX_EMA_BIAS_OPTION_ROOT` | the NDX daily series root (default `NDXP`; from the probe) | after the probe | n/a | yes |
| `BOT_NDX_EMA_BIAS_HOURS_START`, `..._HOURS_END` | the bot's signal window (Blue to confirm; the global one is `AUTOMATION_HOURS_START` / `AUTOMATION_HOURS_END`) | optional | n/a | optional |
| `BOT_NDX_EMA_BIAS_QUANTITY`, `..._WIDTH_POINTS`, `..._ALLOCATION_LIMIT`, `..._TOTAL_POSITION_LIMIT` | 1 contract, 10 wide, $2,000, one position (TODO until Blue confirms; width must be a multiple of the strike increment) | yes | n/a | yes |
| `BOT_NDX_EMA_BIAS_STRIKE_PRICE_SOURCE`, `STRIKE_QUOTE_MAX_AGE_SECONDS` | `alert` (default) or `live`; keep `alert` on the mock and the sandbox (its quotes are delayed 15 minutes per Tradier's FAQ). `live` only once a real-time quote source is connected. | `alert` | n/a | `alert` until then |
| `BOT_NDX_EMA_BIAS_EOD_SWEEP_TIME`, `..._EOD_SWEEP_MODE` | sweep at 16:05 ET; `estimate`, `market` or `manual` | defaults are fine | n/a | defaults |
| `RECONCILE_INTERVAL_MINUTES` | optional automatic broker check | optional | n/a | optional |

Notes:

- **Sandbox and live stay separate.** `TRADIER_TOKEN` and `TRADIER_ACCOUNT_ID` hold the sandbox pair and nothing else. The live token is **not** stored anywhere now; it goes only into the production host's own environment panel, at go-live, never into a file we share. Never keep both in one file. (A sandbox token sent to the production address simply fails, which is one more reason to leave `TRADIER_BASE_URL` unset.)
- `BOT_NDX_EMA_BIAS_ACCOUNT_ID` is **our own label** ("paper-ndx"), not the Tradier account number.
- Vercel gets **none** of the Tradier values: the engine refuses a broker there (no persistent disk, no always-on process; see `docs/deploying.md`).
- The EOD "estimate" and the webhook's price fallback use the app's own live price feed (Google / Yahoo), not Tradier, so they don't depend on the sandbox's delayed quotes.

## 2. First connection checks (all read only), in this order

Run from a terminal with the sandbox values loaded, using the probe script (GET requests only, sandbox host only, never prints the token): `node --experimental-strip-types scripts/tradier-sandbox-probe.ts`. Stop at the first failure.

| # | Check | Endpoint | Pass if | If it fails |
| --- | --- | --- | --- | --- |
| 1 | Token works | `GET /user/profile` | HTTP 200 with a profile | Token wrong, expired, or from the production section. Ask Blue to re-copy the **sandbox** token. Don't retry in a loop. |
| 2 | Account number matches | the same profile answer | the configured account id is in the listed accounts | Fix `TRADIER_ACCOUNT_ID`. The probe says "NOT listed". |
| 3 | Balances come back | `GET /accounts/{id}/balances` | equity, option buying power and cash returned | Account not set up for options or the id is wrong: ask Blue / Tradier support. |
| 4 | Market clock and NDX quote | `GET /markets/clock`, `GET /markets/quotes?symbols=NDX` | a price comes back | See "NDX in the sandbox" below. |
| 5 | NDX option chain lookup | `GET /markets/options/lookup`, `/expirations`, `/strikes`, `/chains` | roots listed, a 0DTE expiration, strikes, sample contracts with bid/ask | See the table in section 3. |

**Nothing places an order at this stage.** The probe has no POST, PUT or DELETE in it.

## 3. Unconfirmed items we can only settle once connected

| Item | How we check | If the answer is no |
| --- | --- | --- |
| **NDX daily option symbol format** (root `NDXP` vs `NDX`; the code builds `ROOT` + `YYMMDD` + `C`/`P` + strike x 1000, 8 digits) | Check 5: the probe prints the roots and compares our symbol builder with real contracts ("MATCHES" or "DIFFERENT"). | Fix `occSymbol` and `BOT_NDX_EMA_BIAS_OPTION_ROOT` from the real answer, then update the sample responses in `tradierExecutor.test.ts`. No order until it says MATCHES. |
| **Whether the sandbox supports NDX index options at all** (Tradier says the sandbox covers "US-based equities and options"; index options aren't mentioned) | Checks 4 and 5: NDX quote and NDX options lookup both return data. | There is no Tradier paper path for NDX. We stop and tell Blue. The choices are: keep the mock executor as the only paper path, or ask Tradier support (techsupport@tradier.com) whether index options can be enabled. We do **not** switch to SPX (it stays in Option Alpha); using an ETF such as QQQ for a plumbing test would be Blue's decision, not ours. |
| **How a credit is written on a multileg order** (we send a positive `price` with `type=credit`) | **Preview only**, after checks 1-5 pass and we both say go: Tradier's order call with `preview=true` validates and prices an order without placing it. Needs a small script (not written yet) that hard-codes `preview=true`, accepts only the sandbox host, and is covered by a fake-fetch test, because one missing flag would turn a preview into a real send. | Don't send. Compare Tradier's reply with our convention, fix the executor, re-run the preview. |
| **Close order type** (limit preferred over market) | The engine closes with a limit debit from the SmartPricing ladder whenever it has quotes; a market order is only the fallback with no quote, and the sweep's "market" mode. Preview both a multileg `debit` limit and a `market` close. | If market is refused: sweep mode `market` stays unusable (use `estimate` or `manual`), and the executor must be changed before going on, because today a close with no quote is sent as a market order (that change is not built). If the limit close is refused too: no go. |
| **NDX strike increment near the money** (assumed 5) | Check 5 prints the spacing near the current price. | Set `BOT_NDX_EMA_BIAS_STRIKE_INCREMENT` to it. The width must be a multiple of it: if the spacing is 25, a 10-point width is refused at startup and Blue must choose a new width. |

Also settled by the same run (marked `TODO(unconfirmed)` in `tradierExecutor.ts`): the `/markets/quotes` shape for index option symbols and the option tick size (0.05 assumed), the fill field names (`exec_quantity`, `avg_fill_price`), the positions answer shape, and the final trading time of the NDXP series.

## 4. Go / no-go before the first paper order

All of these, in order:

1. This checklist is complete, and Blue and we have both said so in writing.
2. Checks 1-5 pass, the symbol builder says MATCHES, and the preview steps pass (or their failures are resolved as above).
3. **Dry run first.** `EXECUTOR=tradier` with `AUTOMATION_DRY_RUN=true`: send alerts and read the decision log's ladders against Tradier's own chain. No order is sent.
4. **Then one paper order, one contract.** `BOT_NDX_EMA_BIAS_QUANTITY=1`, dry run off, and both caps set tight. Watch it fill; check it in Tradier's sandbox screen; run **Check broker positions**; then close it with **Close position** and check that too.
5. Only then does the planned test period (Blue's answer to question 4) start.
6. **The Production URL stays refused** unless someone sets both `TRADIER_BASE_URL` to the production address and `TRADIER_ALLOW_PRODUCTION=true` (plus the two caps). Not part of this stage.

If any step fails, we stop and go back; we don't work around it.

## 5. What could block us

- **Signup from Pakistan.** As reported to us, Tradier blocks signups from Pakistan (we haven't verified this). **Blue has to create the account and the token himself**, and we can never do it on his behalf.
- **A brokerage application may be needed first.** Tradier's FAQ says "all Tradier Brokerage account holders can create paper trading accounts". It's unclear whether a free sandbox login exists without an approved brokerage account. If Blue is asked for ID, funding or approval, that can take days. Ask Tradier support early.
- **Sandbox quotes are 15 minutes delayed**, and there is no delayed streaming (we poll). The ladder prices come from those old quotes, so sandbox fills say nothing about real fills. The test proves the plumbing, not the prices.
- **NDX may not be in the sandbox at all** (see section 3). This is the biggest unknown; it decides whether Tradier paper trading is possible for NDX.
- **Options approval level.** Spreads may need a particular options level on the account; we haven't confirmed which.
- **Rate limits** are not published for the sandbox; the engine polls each working order every 2 seconds, so we watch for HTTP 429.
- **The token is tied to Blue's login.** The same page also shows his Production token. A mistake while sharing a screen could expose it, so Blue should only open the sandbox section.
- **Hosting.** The engine needs an always-on server with a persistent disk and one instance only (`docs/deploying.md`). Vercel can't run a broker. Someone has to own and pay for that host, and it needs a public https address for TradingView.
- **TradingView.** Webhook alerts need two-step login (2FA) on the account, and as far as we know a paid plan (to check with Blue).
- **Blue not placing manual orders.** A hand-placed order on a managed position breaks the bot's picture of the account; the broker check would flag it, but only after the fact.
- **Sandbox behaviour may differ** from production (resets, different fills, order types). Our tests use sample responses written from the docs, not recordings, until the first real run.

## Sources

- Tradier API getting started: https://docs.tradier.com/docs/getting-started (tokens at `web.tradier.com/user/api`)
- Tradier API FAQ (15-minute delay, no delayed streaming, US equities and options): https://docs.tradier.com/docs/faq
- Our research notes: `docs/tradier-executor-research.md`, `docs/going-live-checklist.md`, `docs/deploying.md`
