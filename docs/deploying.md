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

## Looking at the UI on Vercel without a password (demo only)

In the Vercel project's environment variables set `AUTOMATION_AUTH_DISABLED=true` and `AUTOMATION_DATA_DIR=/tmp/automation`, then redeploy. The sign-in box disappears and every page opens, with a yellow "Sign-in is switched off" warning at the top. Anyone who finds the address can then use the admin pages, so only do this for a demo with nothing real behind it. The setting is ignored (sign-in stays on) whenever Tradier production is enabled. The `/tmp` data is temporary and not shared between instances, and the engine still cannot take real alerts on Vercel.
