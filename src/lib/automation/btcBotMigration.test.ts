import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ONE-TIME MIGRATION, not a test: creates the BTC Bybit Bot record and moves the two named webhooks "Bybit bullish" and "Bybit bearish" from the NDX Bias Bot to it,
 * keeping their tokens (so the TradingView alerts and ngrok need no change). Run it ONLY while the app is stopped (the app keeps its records in memory). Skipped unless asked for:
 *
 *   MIGRATE_BTC_BOT=<file for the report> npx vitest run src/lib/automation/btcBotMigration.test.ts                       does it
 *   MIGRATE_BTC_BOT=<file for the report> SETUP_MODE=check npx vitest run src/lib/automation/btcBotMigration.test.ts       only reads, changes nothing
 *   SETUP_DATA_DIR=<folder> points it at a COPY of the data, to rehearse on.
 *
 * Safe to run twice (the second run changes nothing). It touches no position, order or signal, and never writes or prints a token: the report says only whether each token is
 * unchanged. The BTC bot is switched ON (it is the bot the alerts are meant to trade); the NDX Bias Bot's switch is left exactly as it was.
 */
const out = process.env.MIGRATE_BTC_BOT;

describe.skipIf(!out)("move the Bybit webhooks to the BTC Bybit Bot in the real data folder", () => {
  it("creates the bot and re-points the two webhooks", async () => {
    const root = path.resolve(__dirname, "../../..");
    process.env.AUTOMATION_DATA_DIR = process.env.SETUP_DATA_DIR ?? path.join(root, "data/automation");
    process.env.AUTOMATION_STORAGE_FSYNC = "true";
    delete process.env.VERCEL;
    const env = fs.readFileSync(path.join(root, ".env.local"), "utf8");
    const email = /^\s*APP_LOGIN_EMAIL\s*=\s*(.*?)\s*$/m.exec(env)?.[1]?.replace(/^["']|["']$/g, "");
    expect(email, "APP_LOGIN_EMAIL is set in .env.local").toBeTruthy();
    process.env.APP_LOGIN_EMAIL = email!;
    expect(fs.existsSync(path.join(process.env.AUTOMATION_DATA_DIR, "meta.json")), "the real data folder is where it is expected").toBe(true);

    const { BTC_BOT_ID, ensureBotRecord } = await import("./bots");
    const { repointWebhook } = await import("./webhooks");
    const { botsStore, webhooksStore } = await import("./store");
    const checkOnly = process.env.SETUP_MODE === "check";
    const NDX = "ndx_ema_bias";
    const names = [["Bybit bullish", "bullish"], ["Bybit bearish", "bearish"]] as const;
    const report: string[] = [];
    const tokens = new Map(webhooksStore.all().map((w) => [w.id, w.token]));
    report.push(`NDX Bias Bot switch before: enabled=${botsStore.get(NDX)?.enabled}`);
    report.push(`BTC Bybit Bot record before: ${botsStore.get(BTC_BOT_ID) ? `exists, enabled=${botsStore.get(BTC_BOT_ID)!.enabled}` : "none"}`);
    if (!checkOnly) ensureBotRecord(BTC_BOT_ID);

    for (const [name, direction] of names) {
      const hook = webhooksStore.all().find((w) => w.name === name);
      expect(hook, `webhook "${name}" exists`).toBeTruthy();
      report.push(`${name}: on ${hook!.botId}, ${hook!.direction}, active=${hook!.active}`);
      if (checkOnly) continue;
      const moved = repointWebhook(hook!.id, BTC_BOT_ID);
      report.push(`${name}: ${moved.changed ? "moved to the BTC Bybit Bot" : "already there (nothing changed)"}`);
      const now = webhooksStore.get(hook!.id)!;
      expect(now).toMatchObject({ botId: BTC_BOT_ID, direction, active: true });
      expect(now.token, `${name}: the token is unchanged`).toBe(tokens.get(hook!.id));
    }

    report.push(`NDX Bias Bot switch after: enabled=${botsStore.get(NDX)?.enabled}`);
    report.push(`BTC Bybit Bot after: ${botsStore.get(BTC_BOT_ID) ? `exists, enabled=${botsStore.get(BTC_BOT_ID)!.enabled}` : "none"}`);
    const left = webhooksStore.all().filter((w) => w.botId === NDX).map((w) => w.name);
    report.push(`webhooks still on the NDX Bias Bot: ${left.length ? left.join(", ") : "none"}`);
    for (const [id, token] of tokens) expect(webhooksStore.get(id)?.token, "every token is unchanged").toBe(token);
    fs.writeFileSync(out!, report.join("\n") + "\n");
    console.log(report.join("\n"));
  });
});
