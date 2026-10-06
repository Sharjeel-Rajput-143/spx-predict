# NDX on Tradier's sandbox: TradingView alert -> this system -> a paper order

**Paper money only.** Tradier's sandbox is a separate environment with a test balance; nothing here touches a real account, and the platform refuses Tradier's production address unless three separate settings are turned on (do not turn them on). Every step below can be done without risking a dollar.

The path: `TradingView alert -> your webhook URL -> this engine (checks, strikes, SmartPricing) -> Tradier sandbox order -> position on the status page`.

## What you need
1. A **Tradier sandbox** token and account id (Tradier's developer site gives a sandbox login with a paper account). Not the brokerage token.
2. This app running on a machine that **stays on and has a writable disk** - not Vercel (see `docs/deploying.md`).
3. A **public https address** for TradingView to call. For testing from your own computer, a tunnel such as `ngrok http 3000` is enough (ngrok is installed here). **A tunnel exposes the whole app to the internet**, so set `AUTOMATION_STATUS_PASSWORD` first.
4. A TradingView account with two-factor authentication on (it is required for webhook alerts).

## 1. Settings (a git-ignored `.env.local`; never commit it, never paste it into chat)

```
EXECUTOR=tradier
TRADIER_TOKEN=<sandbox token>
TRADIER_ACCOUNT_ID=<sandbox account id>
WEBHOOK_SECRET=<any long random string>
AUTOMATION_STATUS_PASSWORD=<a password for the admin pages>
AUTOMATION_DRY_RUN=true            # decisions and ladders only, no orders - until you turn it off

# The NDX bot needs no settings: it has working defaults (strike spacing 5, option root NDXP, sweep 16:15 ET,
# offsets -0.01/+0.01). The probe below prints the real spacing/root if you want to override them.
```
Do **not** set `TRADIER_BASE_URL` or `TRADIER_ALLOW_PRODUCTION`. Leave the sandbox default.

## 2. Look at the real NDX chain (read-only)
```
set -a; . ./.env.local; set +a
node --experimental-strip-types scripts/tradier-sandbox-probe.ts
```
It sends GET requests only and refuses any host but the sandbox. It prints: the account and its test balance, the NDX option roots, whether a 0DTE series exists today, the strike spacing near the money (use it for `STRIKE_INCREMENT`; the 10-point width must be a multiple of it), a sample of real contracts with bid/ask, and - important - whether our symbol builder produces exactly Tradier's symbols. **If it says DIFFERENT, stop and tell me:** the executor's symbol format needs fixing before any order.

## 3. Start it and check the account
Start the app, open **Settings > Trading Accounts**: the "Broker account" card shows the sandbox account's balance. The Automation status page shows a blue "Tradier SANDBOX (paper money)" banner.

## 4. Create the webhooks
**Settings > Webhooks > Your webhooks**: create *BullishNDX* (NDX bot, bullish) and *BearishNDX* (NDX bot, bearish). Each gets a secret URL like `https://<your-address>/hook/<48 characters>`. Use **Send a test call** on each with today's NDX level: with dry run on it shows the SmartPricing ladder it would use, and sends nothing.

## 5. First paper order
Turn `AUTOMATION_DRY_RUN` off and restart. **Send a test call** on BullishNDX during market hours (9:35am-3:55pm ET, a weekday). Check, in order:
- the status page: a position with the legs and credit, the order `filled`, the decision `opened` and the ladder it walked;
- **Check broker positions**: it should say "All matched";
- Tradier's own sandbox account: the two legs, short and long.
Then BearishNDX: the put spread should close first, then the call spread open.
(The sandbox's market data is delayed ~15 minutes, so ladder prices are built from delayed bid/asks; fills in the sandbox are Tradier's simulation.)

## 6. Point TradingView at it
1. Public address: run `ngrok http 3000` and use the https address it prints (or your server's own domain).
2. On the NDX chart, make an alert on the **confirmed** bullish signal. **Notifications > Webhook URL**: paste BullishNDX's URL. **Message**: `{"price":{{close}},"bar_time":"{{timenow}}","interval":"{{interval}}"}`.
3. Do the same for the bearish signal with BearishNDX's URL. Never wire the raw EMA-cross alerts.
4. When an alert fires, watch the status page: the signal, its decisions, the order.

## If something is off
- **Nothing arrives:** the alert's webhook URL, the tunnel, and that the server is running. A call in the last minute is ignored; a switched-off webhook answers 404.
- **`config_error`:** a required NDX setting is missing - the status page names it.
- **`outside_hours` / `price_out_of_range` / `symbol_mismatch`:** the engine refused it on purpose; the decision says why.
- **A mismatch from "Check broker positions":** the bot is flagged and stops; look at the sandbox account and decide. Nothing is fixed automatically.
- The bot's on/off switch is the kill switch.

## Before this is ever real money
Everything in `docs/going-live-checklist.md` - in particular weeks of paper trading, the owner's approval, and per-order caps.
