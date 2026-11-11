# The live toggle (release 6)

The Live page (`/automation/live`, reached from the Bybit page) has **one master toggle, "Live trading"**. It is the only place live trading is turned ON. There is no typed word and no separate mirror switch:
turning the toggle ON turns the mirror ON with it (the live bot then receives the TradingView signals). Nothing here creates, asks for, or shows a live key.

## What turns it ON and OFF

| Control | Route (signed in only) | ON needs | OFF needs |
|---|---|---|---|
| Live trading toggle | `POST /api/automation/live/switch` `{on:true, confirm:true}` / `{on:false}` | the one "Are you sure?" confirm (`confirm` exactly `true`; the page shows plain words that real money is involved); a live key is present; an account check that passes **right now** (the app runs it); no kill switch; stage 2 also needs the live gate | nothing but being signed in; one click; never waits for Bybit |
| Account check | `POST /api/automation/live/check` | (turns nothing ON) asks Bybit what the key may do, sets isolated margin and the stage's leverage when the account is flat, reads both back | |
| Daily loss limit / stage | `POST /api/automation/live/settings` `{dailyLossUsd, stage}` | a limit above 0 and at most $3; stage 2 only with the gate; a stage change turns the toggle OFF | |
| Status | `GET /api/automation/live` | read only, asks Bybit nothing, never returns a key | |

The page's confirm box is a convenience. The server checks every rule again, so a hand-made request gets the same answers. The generic bot toggle refuses the live bot (409): it follows the live toggle only.

## The mirror
It is ON only together with the toggle. When the toggle is turned OFF the mirror stays ON **only while a live position is held** (the app's records or the live account show one), so an opposite signal can still close it; `tidyMirror`
(run right after an OFF click and every 10 s) turns it OFF as soon as none is held. If the live account cannot be read the mirror is left as it is, never turned off blind. After a restart the mirror is OFF until the toggle is ON again.

## Auto resume
The toggle's ON state is saved (`resume` in the live settings). Every way the toggle goes OFF clears it, because all of them go through `turnLiveOff`: the OFF click, a STOP LOSS ALARM, a tripped daily loss limit, a failed account check,
the kill switch, a stage change. So after a plain app restart or a release promote, `resume` is still true only if the toggle was ON and nothing tripped. The app then comes up OFF and, a few seconds later, `attemptAutoResume` turns it
ON again **only if** a live key is present, there is no kill switch and no tripped daily limit, stage 2 has its gate, the account check passes right then, the margin reads back as isolated, and the live account holds no position
or holds one with a stop loss confirmed on the right side. It writes a `live_auto_resume` event in the ledger and a Log row. A refusal drops the saved state (the toggle stays OFF until it is turned ON deliberately); a failed
safety check also raises the red banner. If Bybit cannot be read it tries again (after 5 s, 30 s, 90 s, 5 min, 10 min), then gives up. It never runs in a dry run (a rehearsal). A file from before this setting existed does not resume.

## What turns the toggle OFF by itself (and is never resumed)
a STOP LOSS ALARM on the live account, a tripped daily loss cap, a failed account check, the kill switch (the live bot's own, or `BYBIT_KILL_SWITCH`), a stage change. The Log gets a row, the live bot gets the red banner,
and the Live page says why. Turning it ON again (confirm, check passed) clears that banner. A held live position stays protected and can still be closed: OFF stops new entries only.

## Limits (ceilings written in `bybitLiveLimits.ts`; nothing on the page can raise them)
0.001 BTC per order, daily loss $2 by default (never above $3), 5 new trades a day, one position at a time. Stage 1: a $10 account, isolated margin at 10x. Stage 2: up to $35, isolated at 3x (needs the gate).

## What is not proven against the real Bybit
The tests use a fake exchange. The real shapes of `/v5/user/query-api`, `/v5/account/info`, `set-margin-mode`, `set-leverage` and the position record were seen on the demo account and by the CEO's account check; the auto resume itself
has never run against the real live account.

## Release 9: the pullback exit and the chain on the live bot; two fixes
- **Pullback exit and chain mode on BOTH Bybit bots**, the same code and the same defaults (pullback exit ON, $0.03 fall, $0.12 minimum peak, chain OFF). Each bot keeps its own saved values, its own peak, its own chain and its own lock, and each is read from and closed on its own account. On the live bot a pullback exit is a reduce-only MARKET close (the Bybit stop loss and take profit stay in place until it fills); it also works with the toggle OFF (a held position can always be closed). A live chain trade goes through the live engine, so every live limit applies: 0.001 BTC, one position, the trades-a-day count (a live chain trade counts in it), the $2 daily loss limit, the live toggle. The card is on the live bot's Settings tab and on the Live page's Settings tab; turning the chain ON for the live bot asks first.
- **OFF race:** if the toggle is OFF when a live entry returns (it was clicked, or a trip turned it OFF, while the order was going out), the entry is closed again at once with a reduce-only order and the open is refused in words; if it cannot be closed it stays open with its stop and the log says so.
- **Daily count:** "Reset daily counter" no longer works for the live bot (the route refuses it, the button is gone, and the count ignores any stored reset). A live chain trade counts in the live count.
