# Releases: how the live BTC bot is served

The live bot runs from a **built copy** in `~/spx-live` (`next build` + `next start`), not from the folder where code is edited. Editing, testing and building happen in copies. The live copy changes only when a person runs `promote`, at a time they choose, when no trade is open.

```
~/spx-live/
  releases/r-YYYYMMDD-HHMMSS/   one folder per built release (source snapshot, node_modules clone, build, logs)
  current  ->  the release that is live          previous  ->  the one before it (for rollback)
  data/                         the live records (automation/, automations/): shared by every release
  shared/.env.local             owner-only copy of the settings
  launchd/                      the two launch jobs, kept here until promote installs them
  logs/app.log, watch.log       what the live app and the down-watcher print
```

Nothing prints the contents of `.env.local`, a token or a key.

## The commands (all `node scripts/release.mjs …`, run in the project folder)

| Command | What it does | Changes what is live? |
|---|---|---|
| `setup` | Makes `~/spx-live`, copies `.env.local` there (owner only), writes the launch jobs to `~/spx-live/launchd` (not installed). | No |
| `check-env` | Says whether `AUTH_SECRET` is set and how long it is (never the value). | No |
| `prepare` | Checks free memory (needs 30% and 2.5 GB), snapshots the code, then typecheck, full tests and `next build` in the release folder at **low priority**, stopping if memory falls under 15%. | No |
| `rehearse [id]` | Starts the built release on **port 3100** in dry-run (watchdog, risk monitor and every order OFF) on a **copy** of the data, runs the warm check twice, stops it. | No |
| `promote [id] --i-chose-the-time [--wait]` | The swap. See below. | **Yes** |
| `rollback` | One step back to the previous release. | **Yes** |
| `status` | What is live, what is prepared, memory, AUTH_SECRET. | No |

## What `promote` checks before it touches anything

1. The release passed tests, build and the rehearsal.
2. It is **1:00 to 2:30 minutes after a 5-minute bar close** (:x1:00 to :x2:30 past a multiple of five). Otherwise it refuses and says when the window opens (`--wait` waits for it).
3. Free memory is enough.
4. The bot's own records show no position open, opening or closing.
5. The Bybit demo account is **flat with no live orders** (read-only check; anything unclear counts as not flat).
6. `.env.local` is copied again (**changes to `.env.local` only take effect at a release**), and `AUTH_SECRET` is at least 32 characters.

Then: maintenance flag on (the down-watcher stays quiet) → stop the live process → (first cutover only) move the live records to `~/spx-live/data`, every file checked by checksum, the old folders kept as `…pre-cutover-<time>` → switch `current` → install and start the launch jobs → wait until the hook answers → warm check twice (webhook route, session check, Bybit page, each under 1.5 s) → wait for the watchdog's **"Startup check"** line in the new log → flag off.

**If any step fails, it rolls back by itself** and tells you.

## After a promote

Run `node scripts/warm.mjs` yourself. Look at the Log tab for the "Startup check: …" line. Do not call it live until the hook, the session check and the Bybit page answered.

## Rollback

- Any later release: `node scripts/release.mjs rollback` (one step, then it proves the old release answers).
- The first cutover has nothing before it but the dev server. If `promote` fails it restores the records and starts `npm run dev` again by itself. To go back by hand later: stop the launch jobs (`launchctl bootout gui/$(id -u)/com.spxlive.app`), move `~/spx-live/data/automation*` back over `data/` in the project folder, run `npm run dev`.

## If the bot goes down (the down-watcher)

A launch job looks at `/hook/warm` every 30 seconds. Two missed looks in a row (about a minute) = down: a Mac notification with a sound every minute, and a line in `~/spx-live/logs/watch.log`, until the app answers again (then a "bot is back" notice). It stays quiet during a promote on purpose, and while the Mac sleeps.

**There is no phone alert.** If you are away from the Mac or asleep you will not hear it. A phone alert (ntfy) can be added later.

The app itself restarts after a crash (launchd `KeepAlive`, at most every 5 seconds).

## Rules

- Never edit or break-test files in the folder the live app runs from. Edit and test in a copy.
- Build and rehearse only after checking free memory and disk; the tool does both and refuses below 30% memory or below 2 GB of free disk (a release is about 0.7 GB, and the live app must always be able to write its records and logs).
- A swap never starts right before a bar close, and never with a trade open.
- A change to the stop-safety files (`bybitExecutor.ts`, `bybitWatchdog.ts`, `stopVerdict` logic) means the demo failure tests that covered them must be run again before the live gate counts them.
