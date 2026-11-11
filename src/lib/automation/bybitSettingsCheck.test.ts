import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error - a plain .mjs script, shared with the connection check
import { parseBybitEnv } from "../../../scripts/bybit/check.mjs";
import { getBotStaticConfig } from "./bots";
import { readBybitConfig } from "./bybitExecutor";
import { bybitBotId } from "./bybitView";
import { bybitExecutor, executorStatus, isPaperStatus } from "./sharedExecutor";

/**
 * What the Settings page reports for the executor, worked out from your real .env.local with the app's own code, and whether the Bybit demo account is flat. Skipped
 * unless asked for: BYBIT_CHECK_ENV=1 npx vitest run src/lib/automation/bybitSettingsCheck.test.ts. Prints names and non-secret values only; never the key or secret.
 */
const on = process.env.BYBIT_CHECK_ENV === "1";

describe.skipIf(!on)("the Settings page's view of Bybit, from .env.local", () => {
  it("the executor is usable, a demo account, and the account holds nothing", async () => {
    const text = fs.readFileSync(path.resolve(__dirname, "../../../.env.local"), "utf8");
    for (const [k, v] of Object.entries(parseBybitEnv(text) as Record<string, string>)) process.env[k] = v;
    const broker = /^\s*BROKER\s*=\s*(\S+)/m.exec(text)?.[1];
    if (broker) process.env.BROKER = broker;
    process.env.EXECUTOR = "";

    const status = executorStatus();
    const { apiKey: _k, apiSecret: _s, ...cfg } = readBybitConfig();
    const lines: string[] = [];
    const out = path.join(os.tmpdir(), "bybit-settings-check.txt");
    const say = (l: string) => {
      lines.push(l);
      fs.writeFileSync(out, `${lines.join("\n")}\n`);
    };
    say(`Settings page, Executor: ${JSON.stringify(status)}`);
    say(`non-secret settings: ${JSON.stringify(cfg)}`);
    say(`paper (demo) account: ${isPaperStatus(status)}`);
    expect(status).toMatchObject({ kind: "bybit", venue: "bybit", error: null, sandbox: true, baseUrl: "https://api-demo.bybit.com" });
    expect(isPaperStatus(status)).toBe(true);

    const bybit = bybitExecutor();
    expect(bybit, "the Bybit executor exists for the pages and the risk monitor").not.toBeNull();
    const ndx = getBotStaticConfig("btc_bybit");
    say(`BTC Bybit Bot loads: underlying ${ndx.underlying}, quantity ${ndx.quantity}`);
    say(`the bot whose orders go to Bybit: ${bybitBotId(bybit!)}`);
    expect(bybitBotId(bybit!)).toBe("btc_bybit");
    expect(ndx.quantity).toBe(1);

    const held = await bybit!.getAccountPosition();
    say(`Bybit account position: ${held.side === null ? "flat (holds nothing)" : `${held.side} ${held.size}`}`);
    expect(held.side).toBeNull();
  });
});
