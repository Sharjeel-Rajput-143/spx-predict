# SPX Predict (working title)

A TradingView-style charting terminal for a simple prediction game. Players call whether the current candle on SPX (or NDX, SPY, QQQ, ES1!) closes above or below its open, then compete on accuracy and streaks.

Prices come from either a deterministic mock feed (default) or a live Google Finance scrape (see "Market data" below - important caveats there).

## Run it

```bash
npm install
npm run dev        # http://localhost:3000, mock data
npm run build && npm start
npm test            # indicator unit tests (Vitest)
```

Prediction window length defaults to **5 minutes** (`ROUND_MS` in `src/lib/config.ts`), independent of whatever timeframe the chart is displaying. Override for a faster demo loop:

```bash
NEXT_PUBLIC_ROUND_SECONDS=60 npm run dev
```

For the live feed:

```bash
NEXT_PUBLIC_DATA_SOURCE=live npm run dev
```

## Stack

Next.js 16 (App Router), React 19, Tailwind CSS 4, TypeScript, Vitest.

Charting is [Lightweight Charts](https://github.com/tradingview/lightweight-charts) (TradingView, Apache License 2.0) - candles, hollow candles, bars, line and area series, a volume pane for symbols that have one, indicator overlays/oscillator panes, and a custom series primitive for the prediction-window highlight. The on-chart attribution link next to the OHLC legend is required by the license; keep it if you touch `ChartLegend.tsx`.

## Screens

| Route | What it does |
| --- | --- |
| `/` Predict | Toolbar (symbol search, timeframes + favorites, chart type, indicators, sound, theme, fullscreen, reset, shortcuts help), Lightweight Charts pane with OHLC legend, indicator legend and prediction-window overlay, market status badge, order-ticket sidebar on desktop (countdown, Up/Down, streak/accuracy, recent rounds) with a sticky Up/Down bar on mobile, collapsible Recent rounds / History panel, first-visit onboarding tip |
| `/leaderboard` | Today / Week / All time, podium for top 3, sortable by accuracy or streak, your row pinned when you're off screen |
| `/history` | Your calls grouped by day, filter by wins/losses and ticker, open (unsettled) calls on top |
| `/profile` | Username (editable), overall stats, last 20 calls strip, accuracy split by direction and ticker, theme toggle, demo reset |
| `/dev/feed-check` | Dev-only: last 50 bars for a symbol/timeframe as a plain table, for comparing the live feed against TradingView bar by bar. Disabled in production builds. |
| `/automations` | Signal Automations - connect a webhook (Option Alpha today), build a rule from any indicator + condition, get it fired for you instead of a paid TradingView alerts plan. See "Automations" below. Reachable from the desktop nav or Profile on mobile. |

Dark mode is the default (TradingView-ish palette: `#131722` background, `#089981` up, `#f23645` down, `#2962ff` accent). Light mode is in the header and on Profile.

## Game rules as built

* A window is aligned to the clock (`floor(now / length)`), so everyone plays the same candle.
* One guess per ticker per window. Guessing locks `LOCK_MS` (default 5s) before the window closes even without a guess, shown as "Locked for close".
* Correct means the close is strictly above (Up) or below (Down) the window open. A flat close counts as a loss.
* Streak = consecutive correct calls, newest first. Leaderboard ranks by accuracy with a minimum number of calls per period, streak breaks ties.
* The chart's view timeframe (1m ... 1W) only changes what you're looking at. The prediction window itself is always `ROUND_MS`, drawn as a dashed OPEN line and a background highlight regardless of the view timeframe.
* Keyboard shortcuts (desktop): Arrow Up/Down to predict, 1-9 to jump timeframes, `/` to open symbol search - see the `?` button in the toolbar.

## Project layout

```
src/
  app/                        routes (page.tsx, leaderboard, history, profile, dev/feed-check)
    api/
      bars/route.ts            GET historical OHLC bars (server-aggregated from real ticks)
      stream/route.ts          GET Server-Sent Events stream of live ticks
      ticks/route.ts           GET raw ticks (used for the header's price history)
      quote/route.ts           GET latest tick + feed health
      settle/route.ts          GET authoritative open/close for a prediction window
  components/
    GameProvider.tsx          app state: guesses, settlement loop, stats, theme, sound, persistence
    AppShell.tsx              header, desktop nav, mobile tab bar
    predict/
      Toolbar.tsx              symbol search, timeframes, chart type, indicators, sound, theme, fullscreen, reset, shortcuts
      SymbolSearch.tsx         symbol dropdown/search (imperative `open()` for the "/" shortcut)
      OrderTicket.tsx          desktop sidebar: countdown, Up/Down, streak/accuracy
      BottomPanel.tsx          collapsible Recent rounds / History tabs
      IndicatorsModal.tsx      searchable add-indicator picker
      OnboardingTip.tsx        first-visit 3-step tip, gated on localStorage
      PredictPanel.tsx, PriceHeader.tsx, Rounds.tsx   countdown+buttons+lock, price header+market badge, reveal/feed
      chart/
        LightweightChart.tsx   the chart engine (series, indicator series/panes, legend hookup, countdown, crosshair)
        ChartPanel.tsx         loading/empty state + legend + chart composition
        ChartLegend.tsx        OHLC legend overlay
        IndicatorLegend.tsx    per-indicator legend rows: value, eye/gear/x, inline settings popover
        predictionPrimitive.ts custom series primitive: prediction-window background highlight
    ui.tsx, icons.tsx          shared primitives
  hooks/
    useLive.ts                 useNow, usePriceFeed (tick-level, for header price)
    useBars.ts                 OHLC bars for the chart, via MarketDataFeed, plus feed-staleness flag
  lib/
    types.ts                  domain types (mirror what an API should return)
    config.ts                 app name, tickers, timeframes, window length, lock length, chart types
    chartPrefs.ts              localStorage for symbol/timeframe/chart type/indicators
    marketStatus.ts            regular-hours-only open/pre/after/closed approximation
    sound.ts                   tiny WebAudio beeps (tap/lock/win/lose)
    game.ts                    window math, outcome, stats
    services/
      gameService.ts           GameService interface + mock implementation
      liveGameService.ts       live implementation: settles via /api/settle, ticks via /api/stream
      index.ts                 getGameService() factory, NEXT_PUBLIC_DATA_SOURCE switch
    marketData/
      types.ts                 MarketDataFeed interface + Bar type + LIVE_FEED_SYMBOLS
      mockFeed.ts               mock adapter
      liveFeed.ts               live adapter: /api/bars + /api/stream, client-side tick->bar aggregation
      googleFinance.ts          server-only Google Finance HTML scraper (see caveats below)
      tickStore.ts              server-only in-memory tick poller + store, shared by the /api routes
      aggregateTicks.ts         raw ticks -> OHLC bars for an arbitrary timeframe
      index.ts                  getMarketDataFeed(symbol) factory
      mock/                    deterministic price model, seeded history, fake leaderboard
    indicators/                pure functions + Vitest specs: sma, ema, wma, bollinger, vwap, rsi,
                                macd, stochastic, atr, supertrend, plus registry.ts (defaults/metadata)
                                and compute.ts (indicator -> chart-ready line series)
```

## Wiring a real backend

Two separate seams, on purpose:

* **`GameService`** (`src/lib/services/gameService.ts`) owns guesses, settlement and the leaderboard. `src/lib/services/index.ts` is the factory; `GameProvider` calls it for its default service.
* **`MarketDataFeed`** (`src/lib/marketData/types.ts`) owns chart data only: `getBars` for history, `subscribeBars` for the live in-progress + closed bar. `src/lib/marketData/index.ts` is the factory, keyed by symbol (falls back to mock for anything the live adapter doesn't cover).

| GameService method | Live implementation |
| --- | --- |
| `submitGuess(window, guess)` | Resolves immediately today - a real backend should enforce the one-guess rule and cutoff time server-side |
| `settleRound(window, guess)` | `GET /api/settle` - the authoritative open/close from the same tick store the chart reads, never client-side prices; retries a few times before falling back to a flat/push result if the feed has a gap |
| `getLeaderboard(period, self)` | Still mock - there's no real accounts backend here |
| `getPriceHistory` / `subscribePrice` | `GET /api/ticks` / `GET /api/stream` (SSE) - raw ticks, used for the header's live price |

Today, user state (history, profile, theme, sound, chart prefs) is kept in `localStorage`. Once there's an API, load results and profile from the server in `GameProvider` instead and keep only theme/sound/chart prefs locally.

## Market data

Two adapters behind `NEXT_PUBLIC_DATA_SOURCE=mock|live` (default `mock`):

* **mock** - the original deterministic price model, unlimited history, always healthy.
* **live** - scrapes Google Finance quote pages server-side (`src/lib/marketData/googleFinance.ts`), polling every 2s into an in-memory tick store (`tickStore.ts`) that the `/api/bars`, `/api/stream`, `/api/ticks` and `/api/settle` routes all read from. Covers **SPX, NDX, SPY, QQQ** (Google Finance quote codes in `GOOGLE_FINANCE_CODES`); **ES1!** has no Google Finance quote page (continuous futures aren't listed there) and always falls back to mock.

**Read this before relying on the live feed for anything real:**

1. **There is no public Google Finance API.** This parses undocumented server-rendered HTML. It can break silently the moment Google changes their markup - there's no SLA, no support channel, nothing to page you when it breaks.
2. **It's a Terms-of-Service gray area**, not a licensed data feed. I looked into paid providers first (Massive/Polygon.io, Twelve Data, Finnhub, Tradier) - every one of them gates showing real-time data to *any* end user (even a single tester) behind a business/enterprise agreement starting around $2,500/mo; the cheap advertised tiers are personal-use-only. Scraping was the explicit choice to move forward without that cost, made with that tradeoff understood.
3. **Reliability in practice:** in testing, the scraper needed a warm-up request (Google serves a stripped page with no price data at all to a cookie-less first request) and occasionally needs a retry - handled with an in-memory cookie jar and a one-shot retry in `googleFinance.ts`, plus the stale-data guard below as the real safety net.
4. **The in-memory tick store is a single-process singleton.** Fine for `next dev` / a single always-on server; it will not stay in sync across multiple serverless instances or replicas without replacing `tickStore.ts` with a shared store.
5. **Settlement always uses the server's own tick history** (`/api/settle`), never a client-observed price, so what's charted is what's settled against - even though the underlying source is unofficial.
6. **Stale-data guard** (`useBars`'s `stale` flag): if no tick arrives for 5 seconds, a "Reconnecting" banner appears and Up/Down are disabled, independent of market hours (a closed market still ticks, with an unchanged price; a broken feed goes silent).
7. **Market hours** (`src/lib/marketStatus.ts`) are a regular-hours-only approximation (9:30-16:00 ET, Mon-Fri; ES1! treated as near-24h) with **no holiday or early-close calendar** - a real deployment should source that from the provider. This gating only applies in live mode; mock stays testable at any hour.
8. Verify accuracy yourself at `/dev/feed-check` against TradingView's own SPX chart before trusting it for anything beyond a demo.

If you later swap in a licensed provider, the seam to replace is `src/lib/marketData/liveFeed.ts` + the `/api/*` route handlers (keep API keys server-side there) - `googleFinance.ts` and `tickStore.ts` are the pieces that go away.

## Indicators

`src/lib/indicators/` - pure functions, unit-tested against hand-computed values matching TradingView's documented formulas (Wilder RMA for RSI/ATR, SMA-seeded EMA, population-stddev Bollinger Bands, standard 12/26/9 MACD, etc. - each file documents its formula in a comment). Run `npm test`.

Overlays (SMA, EMA, WMA, Bollinger Bands, VWAP, Supertrend) draw on the main pane; oscillators (RSI, MACD, Stochastic, ATR) get their own resizable sub-pane (Lightweight Charts' built-in pane splitter). Add one via the toolbar's Indicators button (search, filtered to VWAP only showing for volume symbols); each active one appears in the chart's indicator legend with its live value(s) and eye (hide) / gear (length, source, colors, line width) / x (remove) controls, persisted via `chartPrefs`.

## Automations

`/automations` connects a webhook (Option Alpha today, but the platform field is generic - `AutomationPlatform` in `src/lib/automations/types.ts` is where a second one gets added) and builds rules from any indicator/condition combination, then fires the webhook for you when it triggers - reusing the exact same `computeIndicator()` the chart's own indicators use, so a rule's crossing point matches what you'd see if you built the same alert manually in TradingView.

**Architecture notes, since this is the first part of the app with real server-side state:**

* **No database, no real auth.** The app has neither anywhere else (everything today is `localStorage` + one mock user), so this doesn't introduce them either - a real DB/auth layer would be a much bigger addition than "add signal automations" asked for. `src/lib/automations/store.ts` is a tiny JSON-file-backed store (`data/automations/*.json`, gitignored) keyed to a single hard-coded demo user (`DEMO_USER_ID = "me"`, same id as `MOCK_USER`). Swapping in a real database only means replacing that one file - every route calls it through `all/get/insert/update/remove/query`.
* **Background evaluation** (`src/lib/automations/scheduler.ts`) is a `setInterval` loop in the same Node process as the live-feed poller (`tickStore.ts`), lazily started the first time any `/api/automations/*` route is hit. It reads bars through `getServerBars()` (`src/lib/marketData/serverBars.ts`), which explicitly excludes the still-forming bar so "once per bar close" (spec 3.2) means what it says - a rule's `lastEvaluatedBarTime` only advances when a bar has actually finished closing, not on every 5s scheduler tick. This only runs in a single always-on process; it will not stay in sync across multiple serverless instances.
* **Webhook URLs are encrypted at rest** (AES-256-GCM, `src/lib/automations/crypto.ts`) and masked (`https://app.optionalpha.com/hook/••••••17`, Option Alpha's own convention) the moment they're saved - the API response for creating a connection never echoes the plaintext back, not even once, and no later response ever includes the encrypted field. Set `ALERTS_ENCRYPTION_KEY` in production; without it the app falls back to a hard-coded dev key and logs a warning.
* **SSRF guards** (`src/lib/automations/urlValidation.ts`): https-only, rejects localhost/private-IP-literal hosts outright, and re-resolves DNS to reject private addresses - checked both when a connection is saved and again right before every delivery. Delivery itself (`webhookQueue.ts`) uses `redirect: "manual"`, so a webhook endpoint can never redirect the request to a different, unvetted host. This is deliberately not full DNS-rebinding protection (which would need to pin the resolved IP for the actual request); documented as a known gap rather than silently assumed away.
* **Delivery** is queued rather than called synchronously from the evaluator, retries twice with backoff (2s, 8s) on a non-2xx response or network error, and logs every attempt (status code, success/failure, which attempt number) to the trigger-history store - visible per rule at `/automations` or via `GET /api/automations/rules/:id/log`.
* **Rate limits** (`rateLimit.ts`, in-memory fixed windows) cap rule/connection creation and webhook firing per user - fine for the single demo user this app has; a shared store (Redis, etc.) would be needed for multiple instances.

Tests: `src/lib/automations/conditions.test.ts` (all five condition types against known sequences), `engine.test.ts` (a real EMA(9)/EMA(20) reversal - crossing detection cross-checked against the raw `ema()` output, plus an RSI-crosses-70 fixed-value case), `webhookQueue.test.ts` (a real local HTTP server as the mock receiver: confirms exactly one POST on success, zero when nothing's enqueued, and a real retry-with-backoff round-trip on failure). All exercised for real once end-to-end too, against a real EMA(1)/EMA(2) crossing on mock SPX data and a real outbound HTTPS POST.
