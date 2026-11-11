#!/usr/bin/env node
// HOLD A DEMO TRADE OPEN so it can be watched on the site's Bybit tab. DEMO ONLY (https://api-demo.bybit.com).
//
//   node scripts/bybit/hold-trade.mjs [--seconds 180] [--side long|short]
//
// Opens ONE market order of POSITION_SIZE WITH its stop loss and take profit (STOP_LOSS_PERCENT, TAKE_PROFIT_PERCENT), prints the position as Bybit reports it every
// few seconds, then closes it with a reduce-only market order and prints Bybit's closed profit and loss. It always closes (also on Ctrl+C), refuses unless the demo
// account holds nothing in the symbol, and never prints the key or secret. The trade is placed here, not by the bot, so the site shows it as the open trade with a note
// that the bot has no record of it; it does not appear in the bot's closed trades afterwards.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEMO_HOST, blank, parseBybitEnv } from "./check.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `deps`: { env, fetch, print, seconds, side, sleepMs, onClose }. Returns { ok, lines }. Throws before sending anything if a setting is missing or the account is not flat. */
export async function runHold(deps) {
  const { env, seconds = 180, side = "long" } = deps;
  const doFetch = deps.fetch ?? fetch;
  const lines = [];
  const say = (l) => {
    lines.push(l);
    deps.print?.(l);
  };
  const missing = ["BYBIT_DEMO_API_KEY", "BYBIT_DEMO_API_SECRET", "POSITION_SIZE", "STOP_LOSS_PERCENT", "TAKE_PROFIT_PERCENT"].filter((n) => !(env[n] ?? "").trim());
  if (missing.length) throw new Error(`Missing settings: ${missing.join(", ")}.`);
  const key = env.BYBIT_DEMO_API_KEY.trim();
  const secret = env.BYBIT_DEMO_API_SECRET.trim();
  const base = (env.BYBIT_API_BASE || `https://${DEMO_HOST}`).replace(/\/+$/, "");
  if (new URL(base).hostname !== DEMO_HOST || new URL(base).protocol !== "https:") throw new Error(`Refused: this only ever talks to https://${DEMO_HOST}.`);
  const symbol = (env.BYBIT_SYMBOL || "BTCUSDT").toUpperCase();
  const qty = Number(env.POSITION_SIZE);
  const slPct = Number(env.STOP_LOSS_PERCENT);
  const tpPct = Number(env.TAKE_PROFIT_PERCENT);
  if (!(qty > 0) || !(slPct > 0 && slPct < 100) || !(tpPct > 0 && tpPct < 100)) throw new Error("POSITION_SIZE, STOP_LOSS_PERCENT and TAKE_PROFIT_PERCENT must be plain positive numbers (the percents below 100).");
  const long = side !== "short";
  const secrets = [key, secret];
  const fmt = (n) => Number(n.toFixed(8)).toString();

  async function call(method, p, params, auth = true) {
    const entries = Object.entries(params ?? {}).map(([k, v]) => [k, String(v)]);
    const query = method === "GET" && entries.length ? new URLSearchParams(entries).toString() : "";
    const body = method === "POST" ? JSON.stringify(params ?? {}) : undefined;
    const headers = { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) };
    if (auth) {
      const ts = String(Date.now());
      headers["X-BAPI-API-KEY"] = key;
      headers["X-BAPI-TIMESTAMP"] = ts;
      headers["X-BAPI-RECV-WINDOW"] = "5000";
      headers["X-BAPI-SIGN"] = crypto.createHmac("sha256", secret).update(`${ts}${key}5000${body ?? query}`).digest("hex");
    }
    const res = await doFetch(`${base}${p}${query ? `?${query}` : ""}`, { method, headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!res.ok || !json || json.retCode !== 0) throw new Error(blank(`Bybit ${method} ${p} refused: ${json ? `retCode ${json.retCode}: ${json.retMsg}` : `HTTP ${res.status} ${text.slice(0, 200)}`}`, secrets));
    return json.result ?? {};
  }
  const position = async () => ((await call("GET", "/v5/position/list", { category: "linear", symbol })).list ?? []).find((r) => Number(r.size) > 0) ?? null;

  if (await position()) throw new Error("Not trading: the demo account already holds a position in this symbol. Close it first.");
  const info = await call("GET", "/v5/market/instruments-info", { category: "linear", symbol }, false);
  const tick = Number(info.list?.[0]?.priceFilter?.tickSize);
  const t = await call("GET", "/v5/market/tickers", { category: "linear", symbol }, false);
  const mark = Number(t.list?.[0]?.markPrice);
  if (!(tick > 0) || !(mark > 0)) throw new Error("Bybit gave no mark price or tick, so the stops can't be worked out. Nothing was sent.");
  const decimals = String(tick).includes(".") ? String(tick).split(".")[1].length : 0;
  const at = (x) => (Math.round(x / tick) * tick).toFixed(decimals);
  const stopLoss = at(mark * (long ? 1 - slPct / 100 : 1 + slPct / 100));
  const takeProfit = at(mark * (long ? 1 + tpPct / 100 : 1 - tpPct / 100));

  const tag = crypto.randomBytes(6).toString("hex");
  say(`Opening a ${long ? "LONG" : "SHORT"} ${fmt(qty)} ${symbol} at market (mark ${mark}), stop loss ${stopLoss} (${slPct}%), take profit ${takeProfit} (${tpPct}%).`);
  const opened = await call("POST", "/v5/order/create", { category: "linear", symbol, side: long ? "Buy" : "Sell", orderType: "Market", qty: fmt(qty), positionIdx: 0, orderLinkId: `hold-o-${tag}`, stopLoss, takeProfit, slTriggerBy: "MarkPrice", tpTriggerBy: "MarkPrice", tpslMode: "Full", slOrderType: "Market", tpOrderType: "Market" });
  say(`OPENED. Bybit order id ${opened.orderId}. Watch it now on the site: http://localhost:3000/automation/bybit`);

  let closed = false;
  const closeNow = async () => {
    if (closed) return;
    closed = true;
    const held = await position();
    if (!held) {
      say("The position is already closed at Bybit (its stop loss or take profit fired).");
      return;
    }
    const out = await call("POST", "/v5/order/create", { category: "linear", symbol, side: held.side === "Buy" ? "Sell" : "Buy", orderType: "Market", qty: held.size, reduceOnly: true, positionIdx: 0, orderLinkId: `hold-c-${tag}` });
    say(`CLOSED (reduce only). Bybit order id ${out.orderId}.`);
    for (let i = 0; i < 5; i++) {
      await (deps.sleepMs === undefined ? sleep(1500) : sleep(deps.sleepMs));
      const rows = (await call("GET", "/v5/position/closed-pnl", { category: "linear", symbol, limit: 10 })).list ?? [];
      const mine = rows.find((r) => r.orderId === out.orderId);
      if (mine) {
        say(`Bybit's closed profit and loss: ${mine.closedPnl} (entry ${mine.avgEntryPrice}, exit ${mine.avgExitPrice}; fees included).`);
        return;
      }
    }
    say("Bybit has not listed the closed profit and loss yet.");
  };
  deps.onClose?.(closeNow);

  let ok = true;
  try {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      await (deps.sleepMs === undefined ? sleep(15000) : sleep(deps.sleepMs));
      const held = await position();
      if (!held) {
        say("The position is no longer open at Bybit (a stop fired).");
        closed = true;
        break;
      }
      say(`  ${held.side === "Buy" ? "long" : "short"} ${held.size} entry ${held.avgPrice} mark ${held.markPrice} unrealised P/L ${held.unrealisedPnl} (stop ${held.stopLoss || "none"}, take profit ${held.takeProfit || "none"})`);
      if (deps.sleepMs !== undefined && deps.sleepMs === 0) break;
    }
  } catch (err) {
    ok = false;
    say(`STOPPED: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try {
      await closeNow();
    } catch (err) {
      ok = false;
      say(`!!! THE CLOSE FAILED: ${err instanceof Error ? err.message : String(err)}. Close the small ${symbol} position by hand at Bybit (Positions -> Close).`);
    }
  }
  return { ok, lines };
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(here, "..", "..", ".env.local");
  const fromFile = fs.existsSync(file) ? parseBybitEnv(fs.readFileSync(file, "utf8")) : {};
  const env = { ...fromFile, ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v && (k.startsWith("BYBIT_") || ["STOP_LOSS_PERCENT", "TAKE_PROFIT_PERCENT", "POSITION_SIZE"].includes(k)))) };
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : fallback;
  };
  let closer = null;
  process.on("SIGINT", async () => {
    console.log("\nCtrl+C: closing the trade first...");
    try {
      await closer?.();
    } finally {
      process.exit(1);
    }
  });
  try {
    const { ok } = await runHold({ env, seconds: Number(arg("--seconds", 180)), side: arg("--side", "long"), print: (l) => console.log(l), onClose: (fn) => (closer = fn) });
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error(`\nSTOPPED: ${blank(err instanceof Error ? err.message : String(err), [env.BYBIT_DEMO_API_KEY, env.BYBIT_DEMO_API_SECRET])}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
