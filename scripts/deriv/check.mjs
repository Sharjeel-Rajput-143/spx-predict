#!/usr/bin/env node
// DERIV CONNECTION CHECK - runs the acceptance steps against your DEMO account, reading the three settings from the environment
// (DERIV_API_TOKEN, DERIV_APP_ID, DERIV_ACCOUNT_ID). It never prints them.
//
//   node scripts/deriv/check.mjs                 connect + price + proposal (reads only, buys nothing)
//   node scripts/deriv/check.mjs --trade         ALSO buys one demo CALL on US Tech 100, then sells it at once, logging the contract id
//
// Same request fields as src/lib/automation/derivExecutor.ts. Refuses to trade unless Deriv's address for the account is the DEMO one.
import { pathToFileURL } from "node:url";

export const REQUIRED = ["DERIV_API_TOKEN", "DERIV_APP_ID", "DERIV_ACCOUNT_ID"];

export function blank(text, secrets) {
  return secrets.filter((s) => s && s.length >= 4).reduce((t, s) => t.split(s).join("***"), String(text));
}

/** One WebSocket conversation. `WS` is the WebSocket class (injectable for tests). */
function open(WS, url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WS(url);
    let id = 0;
    const waiting = new Map();
    const timer = setTimeout(() => reject(new Error("The Deriv WebSocket did not open in time.")), timeoutMs);
    ws.onerror = () => (clearTimeout(timer), reject(new Error("The Deriv WebSocket could not be opened (the one-time password may have expired or been used).")));
    ws.onclose = () => { for (const w of waiting.values()) w.reject(new Error("The Deriv connection closed.")); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      const w = waiting.get(m.req_id);
      if (!w) return;
      waiting.delete(m.req_id);
      m.error ? w.reject(new Error(`Deriv refused the request: ${m.error.code}: ${m.error.message}`)) : w.resolve(m);
    };
    ws.onopen = () => {
      clearTimeout(timer);
      resolve({
        call: (o) => new Promise((res, rej) => {
          const r = ++id;
          const t = setTimeout(() => rej(new Error(`Deriv did not answer "${Object.keys(o)[0]}".`)), timeoutMs);
          waiting.set(r, { resolve: (m) => (clearTimeout(t), res(m)), reject: (e) => (clearTimeout(t), rej(e)) });
          ws.send(JSON.stringify({ ...o, req_id: r }));
        }),
        close: () => ws.close(),
      });
    };
  });
}

/** Returns the lines it printed. `deps`: { env, fetch, WebSocket, print, trade }. Throws on the first failure, loudly. */
export async function runCheck(deps) {
  const { env, trade = false } = deps;
  const out = [];
  const say = (l) => { out.push(l); deps.print?.(l); };
  const missing = REQUIRED.filter((n) => !(env[n] ?? "").trim());
  if (missing.length) throw new Error(`Missing settings: ${missing.join(", ")}.`);
  const token = env.DERIV_API_TOKEN.trim(), appId = env.DERIV_APP_ID.trim(), account = env.DERIV_ACCOUNT_ID.trim();
  const base = (env.DERIV_API_BASE || "https://api.derivws.com").replace(/\/+$/, "");
  const symbol = env.DERIV_SYMBOL || "OTC_NDX";
  const currency = (env.DERIV_CURRENCY || "USD").toUpperCase();
  const stake = Number(env.DERIV_STAKE || 10);
  const secrets = [token, appId];
  const otp = async () => {
    const res = await deps.fetch(`${base}/trading/v1/options/accounts/${encodeURIComponent(account)}/otp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Deriv-App-ID": appId, Accept: "application/json" } });
    const text = await res.text();
    let body = null; try { body = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) { const e = body?.errors?.[0]; throw new Error(blank(`1. FAILED: Deriv refused the sign-in (HTTP ${res.status}${e?.code ? `, ${e.code}` : ""}): ${e?.message ?? text.slice(0, 200)}`, secrets)); }
    const url = body?.data?.url;
    if (typeof url !== "string") throw new Error("1. FAILED: Deriv answered the sign-in without a WebSocket address.");
    return url;
  };

  // 1. sign in and connect
  const url = await otp();
  const demo = new URL(url).pathname.split("/").includes("demo");
  say(`1. Signed in to account ${account}: Deriv's address for it is the ${demo ? "DEMO" : "REAL"} one.`);
  if (!demo) throw new Error("Refusing to continue: this is not a demo account.");
  let s = await open(deps.WebSocket, url);
  await s.call({ ping: 1 });
  say("1. Connected and authenticated (ping answered).");
  s.close();

  // 2. a live price and a proposal
  const pub = await open(deps.WebSocket, `${base.replace(/^https:/, "wss:")}/trading/v1/options/ws/public`);
  const h = (await pub.call({ ticks_history: symbol, end: "latest", count: 1, style: "ticks" })).history;
  pub.close();
  say(`2. ${symbol} (US Tech 100) latest price: ${h?.prices?.[0]} (epoch ${h?.times?.[0]}).`);
  s = await open(deps.WebSocket, await otp());
  const proposal = (await s.call({ proposal: 1, contract_type: "CALL", amount: stake, basis: "stake", currency, underlying_symbol: symbol, duration: Number(env.DERIV_DURATION || 1), duration_unit: env.DERIV_DURATION_UNIT || "h" })).proposal;
  say(`2. Proposal for a CALL, stake ${stake} ${currency}: ask price ${proposal.ask_price}, payout ${proposal.payout}, spot ${proposal.spot}.`);
  if (!trade) { s.close(); say("Read-only check done. Add --trade to buy and sell one demo contract."); return out; }

  // 3. buy, 4. sell, 5. log the contract id
  const buy = (await s.call({ buy: proposal.id, price: Math.round(proposal.ask_price * 1.02 * 100) / 100 })).buy;
  say(`3. Bought a demo CALL. CONTRACT ID ${buy.contract_id} (look it up on the Deriv portfolio page), transaction ${buy.transaction_id}, paid ${buy.buy_price}.`);
  s.close();
  s = await open(deps.WebSocket, await otp());
  const poc = (await s.call({ proposal_open_contract: 1, contract_id: buy.contract_id })).proposal_open_contract;
  if (poc.is_sold === 1) say(`4. Contract ${buy.contract_id} is already sold (sale ${poc.sell_price}).`);
  else if (poc.is_valid_to_sell !== 1) throw new Error(`4. FAILED: Deriv says contract ${buy.contract_id} cannot be sold now${poc.validation_error ? `: ${poc.validation_error}` : ""}. It is still open: close it on the Deriv portfolio page.`);
  else {
    const sold = (await s.call({ sell: buy.contract_id, price: 0 })).sell;
    say(`4. Sold contract ${buy.contract_id} for ${sold.sold_for}, transaction ${sold.transaction_id}.`);
  }
  s.close();
  say("All steps passed.");
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCheck({ env: process.env, fetch, WebSocket, print: (l) => console.log(l), trade: process.argv.includes("--trade") }).catch((err) => {
    console.error(blank(err instanceof Error ? err.message : String(err), [process.env.DERIV_API_TOKEN, process.env.DERIV_APP_ID]));
    process.exitCode = 1;
  });
}
