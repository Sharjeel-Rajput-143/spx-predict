# Deploying: what runs on Vercel and what doesn't

## What happened with Vercel

Vercel **is** deploying every push to `main` (Production deployments for both commits so far, status "Deployment has completed"), and the production domain serves the newest build - the new Settings page and the Testing button are on it. What does not work there is the *engine* behind those pages:

| Symptom on the Vercel site | Cause |
| --- | --- |
| Signing in on the status page gives an error | `AUTOMATION_STATUS_PASSWORD` isn't set in Vercel's environment variables. A production build refuses all access without it. (It now says so, instead of failing blindly.) |
| A TradingView alert to the webhook gets a 500 | `WEBHOOK_SECRET` isn't set, and the host can't keep records (see below). The webhook now answers 503 with the reason. |
| Bots, positions and settings never appear or never stick | The engine keeps its state in JSON files (`data/automation`) and in memory. Vercel's disk is read-only and each request can land on a different, short-lived instance. |

Even with the environment variables set, **the engine cannot run on a serverless host as built**:
- its records are files on disk (read-only on Vercel);
- sessions, per-bot locks and the end-of-day timer live in one process's memory;
- it answers a webhook immediately and keeps working in the background (placing the order, waiting up to ~2.5 minutes for fills on the SmartPricing ladder), which a serverless function is allowed to stop as soon as it has responded.

For real trading that matters: a signal could be accepted and never acted on, or an order sent and never followed.

## What to do

**Recommended: run the engine on a server that stays up**, with a writable disk, and keep Vercel (or not) for the rest.
1. Any always-on host: a small VPS, or Railway / Render / Fly with a persistent volume.
2. `npm ci && npm run build && npm start` (one instance only - not two copies).
3. Environment: `WEBHOOK_SECRET`, `AUTOMATION_STATUS_PASSWORD`, `AUTOMATION_DATA_DIR` (a path on the persistent volume), plus the bot settings from `.env.example`. Put it behind HTTPS (TradingView needs a public https URL).
4. Back up the data folder.
5. Create the webhooks under Settings > Webhooks on *that* server, and paste its URLs into TradingView.

**Not recommended for money: make it serverless-compatible.** It would need an external database for the records, locks that work across instances, background work that survives the response (and a long enough function time limit), and a re-think of the timers. That is a rewrite of the storage and execution layers, with real risk.

The status page shows a red "This server can't run the engine" banner whenever it is opened on a host that can't write its records.

## The Vercel demo - works like the local one, no settings needed

On Vercel with no environment variables at all (and only the mock executor) the app is a demo that behaves like the local one: no sign-in box, both bots ready to use, **Send test alert** and **Send a test call** work at any hour, and a TradingView call to a webhook is answered after the engine has run it (so nothing is cut off when the function ends). Its settings come from demo values built in for this case only (test numbers, never used locally or with a broker). Its data sits in a temporary folder, so it can reset when Vercel starts a fresh instance.

Limits to know when showing it:
- A real alert obeys market hours (weekdays 9:35am-3:55pm ET); only the test alert and test call work outside them.
- Nothing is a real order: it is the mock executor.
- A broker can't be driven from Vercel (`EXECUTOR=tradier` is refused there). That needs a server that stays up, as above.

Sign-in comes back automatically as soon as it matters: set `AUTOMATION_STATUS_PASSWORD` and the password box returns; set `EXECUTOR=tradier` with no password and access is denied until you set one.

## Where production storage lives, and how the flip wait and the sweep run

**Storage.** The engine's records (bots, signals, decisions, orders, positions, runs, alerts, webhooks, settings) are JSON files in `AUTOMATION_DATA_DIR` (default `data/automation`), written atomically. In production that has to be a **persistent disk on an always-on server** (a VPS, or Railway / Render / Fly with a volume), backed up. **Vercel is not a place for it**: its filesystem is read-only apart from a per-instance temporary folder that is lost when the instance is replaced, and the engine refuses to start a broker there (`storageProblem`).

**The flip wait.** A flip is close, wait for the confirmation, then open. It runs as ordinary async work in the server process, inside that bot's lock, and answers the webhook immediately. With the price ladder a close can wait up to about 2.5 minutes (3 prices x 10s, then the final price's 2 minutes) and the open the same - so one flip can take around 5 minutes of wall time. That is fine in a process that stays up and not in a serverless function, which is stopped soon after it responds and has a maximum run time.

**The end-of-day sweep.** A one-minute timer in the same process (`startEodScheduler` in `eodSweep.ts`) checks each bot's own sweep time (NDX: 16:05 ET) and sweeps once a day, inside the bot's lock. It is started **when the server boots** (`src/instrumentation.ts`), not by the first webhook, so a restart at 4pm with no alert since doesn't skip it. After a restart a broker run also reads back any order left in flight (`recovery.ts`), and the per-signal stale-position check expires anything left from a previous day.

**One instance only.** The locks, the timer and the caches live in one process; two copies would each run a sweep and each hold their own lock.

**If it had to run on Vercel** it would be a rewrite, not a setting: the records move to an external database (Postgres or Redis) with a lock that works across instances; the sweep becomes a scheduled function (Vercel Cron calling a secured route; check the plan's cron frequency, since the daily-only plans can't hit 16:05); and the flip wait becomes a durable queue or workflow, because a function can't wait minutes and stay alive. Not recommended with money, and not in scope now: the Vercel site stays a mock demo.

## Does the current NDX storage work in production? (plain answer)

- **On Vercel: no.** The data folder (`webhooks.json`, `positions.json`, ...) can't be written to the deployed project folder (read-only). The app falls back to a temporary folder that belongs to one function instance and disappears when it is recycled, so attachments, positions, counters and the bot's on/off state would not persist, and each instance would see different data. With a broker configured the engine refuses to run there. Vercel stays a mock demo.
- **On a server that stays up, with a persistent disk: yes.** Put `AUTOMATION_DATA_DIR` on that disk, run one instance, and back the folder up (it contains the webhook secrets). Writes are atomic, files are versioned, and a damaged or missing file stops the engine with a clear message instead of starting empty.
- **For Blue's testing, use a small always-on server with a disk** (a VPS, or Railway / Render / Fly with a persistent volume) running `npm run build && npm start`. A database is **not** needed first: for one instance the JSON files are enough, and the storage interface means a database can be added later without changing the engine. A database (plus cross-instance locks, a cron-called sweep and a durable queue for the flip wait) is only needed if the engine must run on serverless hosting or on more than one instance.
- **The flip wait and the end-of-day sweep** run as timers and background work inside that one server process (the sweep starts at boot), so they need the same always-on host. The 10-error failsafe and the daily counters are worked out from the stored records by date: they need nothing scheduled, only the persistent disk.

## Signing in

The whole app sits behind a sign-in page (`/login`: email and password). Set `APP_LOGIN_EMAIL`, `APP_LOGIN_PASSWORD` and `AUTH_SECRET` in the host's environment settings (`.env.local` on a laptop). They are not in the code and not in the data folder. `AUTH_SECRET` is a long random value that is not the password (at least 32 characters; `openssl rand -base64 48`): it signs the session cookie, and a production server refuses to sign anyone in without it. The session is a signed, HttpOnly, SameSite=Strict cookie (Secure on HTTPS); changing the email or the password signs everyone out, five wrong tries from one address lock it out for 15 minutes, and 15 wrong tries from anywhere lock the whole login for 15 minutes (the address header can be faked). A request that another website makes with your browser is refused, every response carries no-framing, no-sniffing and no-referrer headers, and the app is served over HTTPS only (HSTS). Wrong and right sign-ins are written to the server log with the address, never the password. Limits: the wrong-try counter lives in memory (a restart clears it), and there is one login, with no second factor. Keep the host's secrets private and use a long, unique password.

The webhook URLs TradingView calls (`/hook/<token>`) stay open: TradingView has no cookie to send, so each URL is protected by its own secret token, and a wrong one gets "not found". Everything else, pages and API alike, needs the sign-in.

## Vercel with a Turso database

A serverless host has no disk that lasts: each instance has its own temporary folder, so webhooks and bots created on one instance seem to vanish on the next. With `TURSO_DB_URL` and `TURSO_DB_TOKEN` set in Vercel's environment variables (and `AUTH_SECRET`, see above), the records live in one Turso database instead, and every instance sees the same ones. Redeploy after setting them.

- One table, `records`, one row per record. Each request loads the records first and saves its changes before it answers; if the database can't be reached the request answers 503 with the reason, never as if the records were empty.
- Two instances changing different records never overwrite each other; two changing the very same record at the same moment: the last save wins.
- A laptop or a server with a disk keeps using the JSON files even with `TURSO_*` set (set `AUTOMATION_STORAGE=turso` to use the database there too). Data in the files and in the database is separate.
- This makes the records last. It does not make Vercel a place to trade: the timers (end-of-day sweep, monitors) don't run there, and a function can be stopped while an order is still being followed. Run real paper trading on a server that stays up.
- The database holds the webhook secrets: keep the token private, and rotate it in Turso if it leaks.

## Users and ownership

Every record (bots, webhooks, positions, orders, signals, log decisions, runs, alerts, templates, settings) carries `userId`, a reference to a row in `users`. The one login from the environment is the owner; a record with no `userId` (made before this existed) belongs to it, so nothing needed migrating. A signed-in request sees and changes only its own user's records; the engine, when a TradingView call or the clock starts it, works under the bot's owner. Settings are one row per user. The built-in bots belong to the owner.

Only one login exists today (`APP_LOGIN_EMAIL`/`APP_LOGIN_PASSWORD`). The structure is ready for more, but there is no screen to add users yet.

Removing: a webhook, a bot (archive first), a trigger's webhook and a position's tags and notes can be edited and removed as before. A position can be deleted once it is closed, expired or rejected (or is a test position); an open or closing one can't. A log entry can be deleted from the records (its signal, decisions and run) once it is older than the duplicate-protection window; "Clear log" still only hides.

## Answering TradingView in time

TradingView gives up on a webhook call after about 3 seconds ("request took too long and timed out"). A call is therefore answered as soon as the signal is saved, and the bot's work (the flip, the orders, the log) carries on behind the answer: on Vercel the function is kept alive for it (Next's `after`), and on a server that stays up it simply continues. The next request on the same instance waits its turn behind that work, so records are never loaded over unsaved ones.

- **A webhook is only a trigger, as in Option Alpha** ("bots cannot accept JSON payloads; a webhook can only trigger an automation to run"). The alert's message is never read, and no price, time or direction is taken from it. The bot uses its own live quote of its underlying (the app's price feed); the direction comes from the URL.
- With a fresh quote already known, the answer goes out within the time it takes to save one record.
- With none (a server that has just started), the call waits up to 1.5 seconds for the first quote, then answers "202 queued" and keeps looking for up to 8 more seconds. If there is still no quote the call is logged as rejected ("no_price"), so it shows in the bot's Log instead of vanishing.
- The Test Hook button isn't time-limited: it waits for the bot to finish and shows the decisions.

## Housekeeping the bot does by itself

- **A run the server stopped partway through.** A signal's run saves its step-by-step record when it ends. A signal accepted more than 10 minutes ago with no such record is logged as "Run interrupted" (an error alert; the bot is marked as needing attention). If it was a flip that closed one side and never opened the other, the message says so. The bot does not open the missing side by itself: the price has moved and the next signal may say otherwise. The scheduler looks every minute; on a host with no timer (Vercel) the next webhook call does.
- **Old log entries.** Signals, their decisions and runs, alerts and error records older than `LOG_RETENTION_DAYS` (default 90; `0` keeps everything) are removed, at most once a day. Positions and their orders are never removed. Keeping the log small matters most on Vercel, where every request loads all the records.
