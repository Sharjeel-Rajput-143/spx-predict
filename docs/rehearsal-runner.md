# Rehearsal runner (NDX bot, paper only)

A small command-line tool that runs the rehearsal scenarios for you and writes one plain report for each. It lives in `scripts/rehearsal/`.
It talks to the app on `http://localhost:3000` and to the bridge on `http://localhost:8787`, and it checks the app against the broker's `/positions`.

Run every command from the project folder (`/Users/syedhamidakhtar/Downloads/spx-predict`):

| Command | What it does |
|---|---|
| `node scripts/rehearsal/cli.mjs preflight` | PASS/FAIL list: bridge reachable, Gateway connected, bridge says `paper: true`, app up, kill switch off, bot on, no "Needs attention", no open positions (app and broker), the rehearsal settings present (names only). |
| `node scripts/rehearsal/cli.mjs start` | Starts the app in the background with the rehearsal settings (secret read from `~/.bridge_secret`). Refuses if port 3000 is busy or the bridge does not say paper is true. Log: `~/ndx-rehearsal-logs/app-<time>.log`. |
| `node scripts/rehearsal/cli.mjs stop` | Stops the app that `start` started (and only that one). |
| `node scripts/rehearsal/cli.mjs scenario open-bullish` | Sends the Status page's test alert (bullish), waits until the position is open, checks it against the broker. |
| `node scripts/rehearsal/cli.mjs scenario open-bearish` | The same, bearish. |
| `node scripts/rehearsal/cli.mjs scenario close` | Presses Close position on the one open position and waits. |
| `node scripts/rehearsal/cli.mjs scenario flip` | Sends the opposite alert to the held side: close, then open the other side. |
| `node scripts/rehearsal/cli.mjs scenario repeat-alert` | Sends the same side again: nothing should be sent. |

Options for `scenario`: `--price 29650` (NDX price in the alert; default: the bridge's NDX quote) and `--timeout-minutes 6`.

Each scenario prints a report (also saved to `~/ndx-rehearsal-logs/report-<scenario>-<time>.txt` and copied to the clipboard) and shows a macOS notification.

Safety rules: it refuses unless the bridge says paper is true; it never prints a secret; it never presses Resolve, switches the bot or the kill switch, or clears a flag; it stops as soon as the bot shows "Needs attention"; one scenario at a time (a lock file).
The only calls it makes are listed at the top of `scripts/rehearsal/lib.mjs`, and a test checks them.
