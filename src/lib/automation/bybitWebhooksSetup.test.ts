import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ONE-TIME SETUP / REPAIR, not a test: creates the two named webhooks "Bybit bullish" and "Bybit bearish" in the app's REAL data folder, attaches each to the matching
 * trigger of the BTC Bybit Bot, and makes sure they belong to the OWNER (the login in APP_LOGIN_EMAIL), because the pages only show a signed-in person their own records.
 * Run it ONLY while the app is stopped (the app keeps its records in memory and would not see, or would overwrite, a file written under it). Skipped unless asked for:
 *
 *   SETUP_BYBIT_WEBHOOKS=<file for the report> npx vitest run src/lib/automation/bybitWebhooksSetup.test.ts                 creates / repairs them
 *   SETUP_BYBIT_WEBHOOKS=<file for the report> SETUP_MODE=check npx vitest run src/lib/automation/bybitWebhooksSetup.test.ts   only reads, changes nothing
 *
 * It never duplicates: a webhook with that name that already exists is reused (and its owner repaired if it is wrong). The report holds the paths (secrets: the URL is the
 * credential) only in the apply mode, in a file created readable by you alone; the check mode writes no token anywhere.
 */
const out = process.env.SETUP_BYBIT_WEBHOOKS;

describe.skipIf(!out)("create or repair the two Bybit webhooks in the real data folder", () => {
  it("creates, attaches and gives them to the owner", async () => {
    const root = path.resolve(__dirname, "../../..");
    // the real folder, written to disk durably (the test setup points at a throwaway folder and skips the flush)
    // (SETUP_DATA_DIR points it at a copy, to rehearse on.)
    process.env.AUTOMATION_DATA_DIR = process.env.SETUP_DATA_DIR ?? path.join(root, "data/automation");
    process.env.AUTOMATION_STORAGE_FSYNC = "true";
    delete process.env.VERCEL;
    // The owner is the login in APP_LOGIN_EMAIL; this process must know it, as the app does, or every record is stamped with the wrong owner.
    const env = fs.readFileSync(path.join(root, ".env.local"), "utf8");
    const email = /^\s*APP_LOGIN_EMAIL\s*=\s*(.*?)\s*$/m.exec(env)?.[1]?.replace(/^["']|["']$/g, "");
    expect(email, "APP_LOGIN_EMAIL is set in .env.local").toBeTruthy();
    process.env.APP_LOGIN_EMAIL = email!;
    expect(fs.existsSync(path.join(process.env.AUTOMATION_DATA_DIR, "meta.json")), "the real data folder is where it is expected").toBe(true);

    const { ensureBotRecord } = await import("./bots");
    const { createWebhook, webhookUrlPath } = await import("./webhooks");
    const { storage, webhooksStore } = await import("./store");
    const { ownerUserId } = await import("@/lib/auth/users");
    const { runAs } = await import("./userContext");
    const checkOnly = process.env.SETUP_MODE === "check";
    const owner = ownerUserId();
    const raw = storage.repository<{ id: string; name: string; userId?: string; botId: string | null; direction: string | null; active: boolean; token: string }>("webhooks");
    const rawDecisions = storage.repository<{ id: string; userId?: string; outcome: string; reason: string }>("decisions");
    const users = JSON.parse(fs.readFileSync(path.join(process.env.AUTOMATION_DATA_DIR, "users.json"), "utf8")).items as { id: string }[];

    const report: string[] = [];
    report.push(`owner id from APP_LOGIN_EMAIL: ${owner}`);
    report.push(`users in the data: ${users.map((u) => u.id).join(", ")}  (the owner is one of them: ${users.some((u) => u.id === owner)})`);
    if (!checkOnly) ensureBotRecord("btc_bybit");

    const names = [["Bybit bullish", "bullish"], ["Bybit bearish", "bearish"]] as const;
    const lines: string[] = [];
    for (const [name, direction] of names) {
      let row = raw.all().find((w) => w.name.toLowerCase() === name.toLowerCase());
      report.push(`${name}: ${row ? `exists, stamped with user ${row.userId ?? "(none: the owner's)"}${row.userId && row.userId !== owner ? "  <-- NOT the owner: the owner's pages cannot see it" : ""}` : "does not exist"}`);
      if (checkOnly) continue;
      if (!row) {
        createWebhook({ name, botId: "btc_bybit", direction }); // stamped with the owner now that APP_LOGIN_EMAIL is known
        row = raw.all().find((w) => w.name.toLowerCase() === name.toLowerCase())!;
      } else if (row.userId && row.userId !== owner) {
        raw.update(row.id, { userId: owner });
        report.push(`${name}: repaired, now the owner's`);
        row = raw.all().find((w) => w.name.toLowerCase() === name.toLowerCase())!;
      }
      expect(row).toMatchObject({ botId: "btc_bybit", direction, active: true });
      expect(row.userId === undefined || row.userId === owner, `${name} belongs to the owner`).toBe(true);
      lines.push(`${name} | ${direction} trigger of BTC Bybit Bot | ${webhookUrlPath(row)}`);
    }

    // The two log lines "webhook attached" the first run wrote carry the same wrong stamp: the Log tab would not show them to the owner either.
    const wrongLogs = rawDecisions.all().filter((d) => d.outcome === "webhook_attached" && d.userId && d.userId !== owner && names.some(([n]) => d.reason.includes(`"${n}"`)));
    report.push(`log lines "webhook attached" stamped with another user: ${wrongLogs.length}`);
    if (!checkOnly) {
      for (const d of wrongLogs) rawDecisions.update(d.id, { userId: owner });
      if (wrongLogs.length) report.push(`log lines repaired: ${wrongLogs.length}`);
    }

    // What the owner's signed-in pages see (the Settings page reads through this), and what the webhook route sees (everything).
    const seenByOwner = runAs(owner, () => webhooksStore.all().filter((w) => names.some(([n]) => n === w.name)).map((w) => w.name));
    const seenByRoute = webhooksStore.all().filter((w) => names.some(([n]) => n === w.name)).map((w) => w.name);
    report.push(`visible to the signed-in owner (the Settings page): ${seenByOwner.length} of 2 ${JSON.stringify(seenByOwner)}`);
    report.push(`visible to the webhook route (a TradingView call): ${seenByRoute.length} of 2`);
    fs.writeFileSync(out!, `${report.join("\n")}\n`, { mode: 0o600 });
    if (!checkOnly) {
      fs.writeFileSync(`${out}.paths`, `${lines.join("\n")}\n`, { mode: 0o600 });
      expect(seenByOwner).toHaveLength(2);
    }
  });
});
