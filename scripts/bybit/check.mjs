#!/usr/bin/env node
// BYBIT DEMO CONNECTION CHECK - runs against your Bybit DEMO account (https://api-demo.bybit.com only) and prints exactly what Bybit returned for every call.
// It reads BYBIT_DEMO_API_KEY and BYBIT_DEMO_API_SECRET from the environment or from .env.local (only those names are read), and never prints them.
//
//   node scripts/bybit/check.mjs            reads only: time, instrument limits, price, balance, position, order list, closed PnL. Buys nothing.
//   node scripts/bybit/check.mjs --trade    ALSO opens one small BTCUSDT market order (POSITION_SIZE) WITH a stop loss and take profit (STOP_LOSS_PERCENT, TAKE_PROFIT_PERCENT),
//                                           reads it back and checks the stops are on the position at Bybit, closes it with a
//                                           reduce-only market order, reads that back, and reads Bybit's closed profit and loss. Refuses unless the
//                                           demo account holds nothing in the symbol first.
//
// A call Bybit's demo does not support is reported as FAILED with Bybit's own retCode and message, and the check goes on with the rest.
// Same request fields and signing as src/lib/automation/bybitExecutor.ts.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REQUIRED = ["BYBIT_DEMO_API_KEY", "BYBIT_DEMO_API_SECRET"];
export const DEMO_HOST = "api-demo.bybit.com";

export function blank(text, secrets) {
  return secrets.filter((s) => s && s.length >= 4).reduce((t, s) => t.split(s).join("***"), String(text));
}

/** Only the Bybit settings are taken from an env file (BYBIT_*, and the four risk settings); nothing else in it is read into the program. */
export const RISK_NAMES = ["STOP_LOSS_PERCENT", "TAKE_PROFIT_PERCENT", "POSITION_SIZE", "DAILY_MAX_LOSS_USD"];
export function parseBybitEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || !(m[1].startsWith("BYBIT_") || RISK_NAMES.includes(m[1]))) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

const compact = (v, max = 700) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)} ...(cut)` : s;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `deps`: { env, fetch, print, trade, sleepMs }. Returns { lines, results, ok }. Never throws for a failed Bybit call: it records it and goes on.
 * It throws only for a setting that is missing or not the demo host, before anything is sent.
 */
export async function runCheck(deps) {
  const { env, trade = false } = deps;
  const doFetch = deps.fetch ?? fetch;
  const wait = deps.sleepMs ?? 700;
  const lines = [];
  const say = (l) => {
    lines.push(l);
    deps.print?.(l);
  };
  const missing = REQUIRED.filter((n) => !(env[n] ?? "").trim());
  if (missing.length) throw new Error(`Missing settings: ${missing.join(", ")}. Put them in .env.local (BYBIT_DEMO_API_KEY=... and BYBIT_DEMO_API_SECRET=...).`);
  const key = env.BYBIT_DEMO_API_KEY.trim();
  const secret = env.BYBIT_DEMO_API_SECRET.trim();
  const base = (env.BYBIT_API_BASE || `https://${DEMO_HOST}`).replace(/\/+$/, "");
  let host = "";
  try {
    const u = new URL(base);
    host = u.protocol === "https:" && !u.username && u.pathname === "/" ? u.hostname : "";
  } catch {
    /* not an address */
  }
  if (host !== DEMO_HOST) throw new Error(`Refused: BYBIT_API_BASE must be https://${DEMO_HOST}. This check only ever talks to the Bybit DEMO host.`);
  const symbol = (env.BYBIT_SYMBOL || "BTCUSDT").toUpperCase();
  const qty = Number(env.POSITION_SIZE || env.POSITION_SIZE || 0.001);
  const slPct = Number(env.STOP_LOSS_PERCENT);
  const tpPct = Number(env.TAKE_PROFIT_PERCENT);
  const recv = 5000;
  const secrets = [key, secret];
  if (!(qty > 0)) throw new Error("POSITION_SIZE must be above 0.");
  if (trade) {
    const unset = ["POSITION_SIZE", "STOP_LOSS_PERCENT", "TAKE_PROFIT_PERCENT"].filter((n) => !(env[n] ?? "").trim());
    if (unset.length) throw new Error(`Not trading: ${unset.join(", ")} must be set (they have no defaults), so the test order can carry its stop loss and take profit.`);
    if (!(slPct > 0 && slPct < 100 && tpPct > 0 && tpPct < 100)) throw new Error("STOP_LOSS_PERCENT and TAKE_PROFIT_PERCENT must be numbers above 0 and below 100.");
  }
  const fmt = (n) => Number(n.toFixed(8)).toString();

  const results = [];
  /** One call. Records PASS or FAILED with what Bybit returned. */
  async function call(label, method, p, params, { auth = true } = {}) {
    const entries = Object.entries(params ?? {}).map(([k, v]) => [k, String(v)]);
    const query = method === "GET" && entries.length ? new URLSearchParams(entries).toString() : "";
    const body = method === "POST" ? JSON.stringify(params ?? {}) : undefined;
    const headers = { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) };
    if (auth) {
      const ts = String(Date.now());
      headers["X-BAPI-API-KEY"] = key;
      headers["X-BAPI-TIMESTAMP"] = ts;
      headers["X-BAPI-RECV-WINDOW"] = String(recv);
      headers["X-BAPI-SIGN"] = crypto.createHmac("sha256", secret).update(`${ts}${key}${recv}${body ?? query}`).digest("hex");
    }
    let status = 0;
    let text = "";
    try {
      const res = await doFetch(`${base}${p}${query ? `?${query}` : ""}`, { method, headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(15000) });
      status = res.status;
      text = await res.text();
    } catch (err) {
      const r = { label, ok: false, detail: `no answer: ${blank(err instanceof Error ? err.message : String(err), secrets)}` };
      results.push(r);
      say(`FAILED  ${method} ${p}  (${label})\n        ${r.detail}`);
      return { ok: false, json: null, result: null };
    }
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    const ok = status >= 200 && status < 300 && json && json.retCode === 0;
    const shown = blank(compact(json ?? text), secrets);
    const r = { label, ok, detail: ok ? "retCode 0 OK" : json ? `HTTP ${status}, retCode ${json.retCode}: ${blank(String(json.retMsg), secrets)}` : `HTTP ${status}: ${blank(text.slice(0, 200), secrets)}` };
    results.push(r);
    say(`${ok ? "PASS  " : "FAILED"}  ${method} ${p}  (${label})\n        HTTP ${status}  ${shown}`);
    return { ok, json, result: json?.result ?? null };
  }

  say(`Bybit demo check - host ${DEMO_HOST}, symbol ${symbol}, size ${fmt(qty)}${trade ? "  (TRADE MODE: one small order will be opened and closed)" : "  (read only)"}`);

  const time = await call("server time", "GET", "/v5/market/time", {}, { auth: false });
  if (time.ok) {
    const skew = Math.abs(Date.now() - Number(time.result.timeNano ? BigInt(time.result.timeNano) / 1000000n : Number(time.result.timeSecond) * 1000));
    say(`        clock difference to Bybit: about ${Math.round(skew)} ms (calls are refused above ${recv} ms)`);
  }
  const info = await call("instrument limits", "GET", "/v5/market/instruments-info", { category: "linear", symbol }, { auth: false });
  const lot = info.result?.list?.[0]?.lotSizeFilter ?? null;
  const tick = await call("price", "GET", "/v5/market/tickers", { category: "linear", symbol }, { auth: false });
  const last = Number(tick.result?.list?.[0]?.lastPrice);
  let sizeOk = true;
  if (lot) {
    const min = Number(lot.minOrderQty), step = Number(lot.qtyStep), minNotional = Number(lot.minNotionalValue);
    const stepsOk = Math.abs(qty / step - Math.round(qty / step)) < 1e-9;
    say(`        limits: min qty ${lot.minOrderQty}, step ${lot.qtyStep}, min order value ${lot.minNotionalValue}; your size ${fmt(qty)}${Number.isFinite(last) ? ` is worth about ${(qty * last).toFixed(2)} USDT at ${last}` : ""}`);
    if (qty < min || !stepsOk) {
      sizeOk = false;
      say(`        PROBLEM: ${fmt(qty)} is not a size Bybit accepts (min ${min}, step ${step}).`);
    }
    if (Number.isFinite(last) && qty * last < minNotional) {
      sizeOk = false;
      say(`        PROBLEM: the order would be worth ${(qty * last).toFixed(2)}, under Bybit's minimum of ${minNotional}.`);
    }
  }
  const bal = await call("wallet balance (checks the key)", "GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" });
  const wallet = bal.result?.list?.[0];
  const funded = !bal.ok || Number(wallet?.totalAvailableBalance ?? wallet?.totalEquity) > 0;
  if (bal.ok) {
    say(`        equity ${wallet?.totalEquity}, available ${wallet?.totalAvailableBalance}`);
    if (!funded) say("        PROBLEM: the demo account has NO FUNDS, so Bybit will refuse every order (retCode 110007). In Bybit, with Demo Trading on, go to Assets and use Request Demo Funds, then run this again.");
  }
  const pos = await call("position", "GET", "/v5/position/list", { category: "linear", symbol });
  // Plain lines worked out from Bybit's FULL reply (the reply is cut when shown above). scripts/release.mjs reads these to decide "flat".
  if (pos.ok) say(`        HELD POSITIONS: ${(pos.result?.list ?? []).filter((r) => Number(r.size) > 0).length}`);
  const liveOrders = await call("live orders", "GET", "/v5/order/realtime", { category: "linear", symbol, limit: 50 });
  if (liveOrders.ok) say(`        OPEN ORDERS: ${(liveOrders.result?.list ?? []).length}`);
  await call("order history", "GET", "/v5/order/history", { category: "linear", symbol, limit: 5 });
  await call("closed profit and loss", "GET", "/v5/position/closed-pnl", { category: "linear", symbol, limit: 5 });
  await call("executions (fills)", "GET", "/v5/execution/list", { category: "linear", symbol, limit: 5 });

  let tradeOk = true;
  if (trade) {
    if (!bal.ok || !pos.ok) throw new Error("Not trading: the key or the position could not be read above, so nothing was sent.");
    if (!sizeOk) throw new Error("Not trading: the size above is not one Bybit accepts, so nothing was sent.");
    if (!funded) throw new Error("Not trading: the demo account has no funds (equity 0), so Bybit would refuse the order. Request demo funds in Bybit (Demo Trading -> Assets), then run this again. Nothing was sent.");
    const held = (pos.result.list ?? []).filter((r) => Number(r.size) > 0);
    if (held.length) throw new Error(`Not trading: the demo account already holds ${held.map((r) => `${r.side} ${r.size} ${symbol}`).join(", ")}. Close that first, so this check only ever touches its own order.`);

    const tag = crypto.randomBytes(8).toString("hex");
    const tickSize = Number(info.result?.list?.[0]?.priceFilter?.tickSize);
    const mark = Number(tick.result?.list?.[0]?.markPrice);
    if (!(tickSize > 0) || !(mark > 0)) throw new Error("Not trading: Bybit gave no mark price or price tick, so the stops can't be worked out.");
    const decimals = String(tickSize).includes(".") ? String(tickSize).split(".")[1].length : 0;
    const at = (x) => (Math.round(x / tickSize) * tickSize).toFixed(decimals);
    const stopLoss = at(mark * (1 - slPct / 100));
    const takeProfit = at(mark * (1 + tpPct / 100));
    say("\n--- TRADE: open one small market order, with its stop loss and take profit ---");
    say(`        mark price ${mark}: stop loss ${stopLoss} (${slPct}%), take profit ${takeProfit} (${tpPct}%)`);
    const open = await call("open (Buy, market, with stops)", "POST", "/v5/order/create", { category: "linear", symbol, side: "Buy", orderType: "Market", qty: fmt(qty), positionIdx: 0, orderLinkId: `chk-o-${tag}`, stopLoss, takeProfit, slTriggerBy: "MarkPrice", tpTriggerBy: "MarkPrice", tpslMode: "Full", slOrderType: "Market", tpOrderType: "Market" });
    if (!open.ok) {
      say("\nThe open was refused, so nothing is held. Bybit's reply is above.");
      tradeOk = false;
    } else {
      const openId = open.result.orderId;
      say(`        ORDER ID (open): ${openId}`);
      await sleep(wait);
      const o = await call("read the open order back", "GET", "/v5/order/realtime", { category: "linear", symbol, orderId: openId });
      const row = o.result?.list?.find((r) => r.orderId === openId) ?? null;
      if (row) say(`        status ${row.orderStatus}, filled ${row.cumExecQty} at average ${row.avgPrice}`);
      else {
        const h = await call("read the open order from history", "GET", "/v5/order/history", { category: "linear", symbol, orderId: openId });
        const hr = h.result?.list?.find((r) => r.orderId === openId);
        if (hr) say(`        status ${hr.orderStatus}, filled ${hr.cumExecQty} at average ${hr.avgPrice}`);
      }
      const afterOpen = await call("position after the open", "GET", "/v5/position/list", { category: "linear", symbol });
      const row0 = (afterOpen.result?.list ?? []).find((r) => Number(r.size) > 0);
      if (row0) {
        const ok = Number(row0.stopLoss) > 0 && Number(row0.takeProfit) > 0;
        say(`        stops on the position at Bybit: stop loss ${row0.stopLoss || "NONE"}, take profit ${row0.takeProfit || "NONE"}${ok ? "" : "   <-- MISSING: the bot would set them with trading-stop, or close the trade at once"}`);
        if (!ok) tradeOk = false;
      }

      say("\n--- TRADE: close it with a reduce-only market order ---");
      let close = await call("close (Sell, market, reduceOnly)", "POST", "/v5/order/create", { category: "linear", symbol, side: "Sell", orderType: "Market", qty: fmt(qty), reduceOnly: true, positionIdx: 0, orderLinkId: `chk-c-${tag}` });
      if (!close.ok) {
        say("        The close failed. Trying it once more...");
        close = await call("close, second try", "POST", "/v5/order/create", { category: "linear", symbol, side: "Sell", orderType: "Market", qty: fmt(qty), reduceOnly: true, positionIdx: 0, orderLinkId: `chk-c2-${tag}` });
      }
      if (!close.ok) {
        tradeOk = false;
        say(`\n!!! A SMALL ${symbol} POSITION IS STILL OPEN on your Bybit demo account. Close it by hand at Bybit (Positions -> Close), then tell me what Bybit's reply above said.`);
      } else {
        const closeId = close.result.orderId;
        say(`        ORDER ID (close): ${closeId}`);
        await sleep(wait);
        const c = await call("read the close order back", "GET", "/v5/order/realtime", { category: "linear", symbol, orderId: closeId });
        const crow = c.result?.list?.find((r) => r.orderId === closeId) ?? null;
        if (crow) say(`        status ${crow.orderStatus}, filled ${crow.cumExecQty} at average ${crow.avgPrice}, reduceOnly ${crow.reduceOnly}`);
        const after = await call("position after the close", "GET", "/v5/position/list", { category: "linear", symbol });
        const still = (after.result?.list ?? []).filter((r) => Number(r.size) > 0);
        say(still.length ? `        STILL HELD: ${still.map((r) => `${r.side} ${r.size}`).join(", ")}` : "        flat again: the demo account holds nothing in the symbol");
        if (still.length) tradeOk = false;
        let pnl = null;
        for (let i = 0; i < 4 && !pnl; i++) {
          if (i) await sleep(wait * 2);
          const r = await call(i ? "closed profit and loss, again" : "closed profit and loss for the close", "GET", "/v5/position/closed-pnl", { category: "linear", symbol, limit: 20 });
          pnl = r.result?.list?.find((x) => x.orderId === closeId) ?? null;
          if (!r.ok) break;
        }
        if (pnl) say(`        Bybit's closed PnL for the close order: ${pnl.closedPnl} (entry ${pnl.avgEntryPrice}, exit ${pnl.avgExitPrice})`);
        else say("        Bybit has not listed a closed PnL for this order (it may lag, or the demo may not support it).");
        await call("fills of the two orders", "GET", "/v5/execution/list", { category: "linear", symbol, limit: 10 });
      }
    }
  }

  const failed = results.filter((r) => !r.ok);
  say("\n=== SUMMARY ===");
  for (const r of results) say(`${r.ok ? "PASS  " : "FAILED"}  ${r.label}${r.ok ? "" : ` - ${r.detail}`}`);
  say(failed.length ? `\n${failed.length} call(s) failed. The ones that say "not supported" are demo limits, not a problem in the bot - tell me which.` : "\nAll calls passed.");
  const ok = failed.length === 0 && tradeOk;
  return { lines, results, ok };
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const envFile = path.resolve(here, "..", "..", ".env.local");
  const fromFile = fs.existsSync(envFile) ? parseBybitEnv(fs.readFileSync(envFile, "utf8")) : {};
  const env = { ...fromFile, ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => (k.startsWith("BYBIT_") || RISK_NAMES.includes(k)) && v)) };
  const trade = process.argv.includes("--trade");
  try {
    const { ok } = await runCheck({ env, trade, print: (l) => console.log(l) });
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error(`\nSTOPPED: ${blank(err instanceof Error ? err.message : String(err), [env.BYBIT_DEMO_API_KEY, env.BYBIT_DEMO_API_SECRET])}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
