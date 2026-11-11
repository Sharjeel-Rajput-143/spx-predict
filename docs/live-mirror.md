# The live twin of the BTC bot (built, OFF, not released)

Status: written in the working copy only. Nothing here is in the running app until a release is prepared, rehearsed and promoted (see `release.md`), at a time the owner chooses.

## What exists

| Piece | File | In one line |
|---|---|---|
| Hard limits | `bybitLiveLimits.ts` | 0.001 BTC, daily loss default $2 / ceiling $3, 5 trades a day, 1 position, stage 1 = 10x, stage 2 = 3x. Ceilings in code, nothing can raise them. |
| Live executor | `bybitLive.ts` | The demo executor on the real host only (`api.bybit.com`) with its own key. Before every entry: key rights, isolated margin and leverage set and read back. |
| Settings and switch | `liveSettings.ts` | Own folder (`LIVE_DATA_DIR`, else `live/` next to the demo records). Switch OFF by default, OFF after every restart, ON only with the typed word LIVE. |
| Router | `perBotExecutor.ts` | A call goes where its own bot or order reference says. The demo executor never sees the live bot. |
| The bot | `bots.ts` | `btc_bybit_live`, born OFF, account `bybit-live`, limits from the code. |
| Mirror | `liveMirror.ts` + `hook/[token]/route.ts` | The demo hook also feeds the live bot, behind the answer, after the demo bot. |
| Live watchdog and risk check | `bybitLiveWatchdog.ts` | The demo ones, run against the live account, with their own alarms. |

## The mirror (Option B), the promises

1. The demo answer is built from the demo bot's result alone. The mirror is started after the answer is built and handed to the same deferred work the route already uses.
2. The mirror runs AFTER the demo bot's own processing (or after 10 s if the demo is stuck), in its own try/catch, with its own time limits (60 s). It never rejects.
3. One setting switches it: `mirrorEnabled` in the live settings. OFF by default.
4. With the live switch OFF the live bot is OFF, and an OFF bot only closes (engine "Always On"): a mirrored signal can end a position it holds, never open one.
5. The live bot can be reached ONLY through the mirror. An outside call with the shared secret, a test alert, or a webhook attached to it gets "Unknown bot."

Proof: `mirror.test.ts` and `mirrorEndToEnd.test.ts` next to the route (the demo answer, signal, decisions and position are identical when the live side throws, rejects, hangs or is slow), `liveMirror.test.ts`, `liveWiring.test.ts`, and a break-it check for each.

## Option A (a later fallback, NOT built): live fully separate

Use it if you want the live bot to have its own TradingView alerts and its own webhook addresses, with no link to the demo hooks.

1. In TradingView make two more alerts (bullish, bearish) with new webhook addresses. Do not touch the existing ones.
2. In the app make two new named webhooks. They cannot be attached to the live bot yet: `ingestWebhook` refuses the live bot unless the call comes from the mirror. A small, tested change is needed first: let a webhook whose bot is the live bot pass `mirrorOf` itself in `hook/[token]/route.ts` (that webhook's secret URL is then the door), and offer the live bot in the webhook bot choices.
3. Turn the mirror OFF (`mirrorEnabled` false). The demo hooks then never reach the live bot.
4. Everything else (limits, switch, watchdog) is unchanged.

Switching between B and A is a setting plus the alerts; neither changes the demo hooks.

## Not built yet

The ledger and the gate numbers (failure tests on the real demo account X of 6, partial fill on the fake exchange yes or no, clean trades X of 5), the live page and the typed-LIVE form, the routes that turn the switch on and the mirror on and off, and the demo failure tests. The settings and the checks they will call are built and tested.
