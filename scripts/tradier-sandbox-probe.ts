/**
 * A READ-ONLY look at Tradier's SANDBOX, to settle what the platform doesn't know yet about NDX: the option root,
 * the symbol format, the strike increment near the money, whether a 0DTE series exists, and what a quote looks like.
 * It sends GET requests only - it cannot place, change or cancel an order - and it refuses any host but the sandbox.
 *
 *   set -a; . ./.env.local; set +a
 *   node --experimental-strip-types scripts/tradier-sandbox-probe.ts            # NDX
 *   node --experimental-strip-types scripts/tradier-sandbox-probe.ts SPX        # or another index
 *
 * Needs TRADIER_TOKEN and TRADIER_ACCOUNT_ID (sandbox values). The token is never printed.
 */
import { asList, nearMoneyPuts, ourSymbol, parseOcc, pickExpiry, rootsOf, strikeIncrementNear, type ChainOption } from "../src/lib/automation/tradierProbe.ts";

const SANDBOX = "sandbox.tradier.com";
const token = process.env.TRADIER_TOKEN?.trim();
const accountId = process.env.TRADIER_ACCOUNT_ID?.trim();
const base = (process.env.TRADIER_BASE_URL?.trim() || `https://${SANDBOX}/v1`).replace(/\/+$/, "");
const underlying = (process.argv[2] ?? "NDX").toUpperCase();

if (!token || !accountId) {
  console.error("Set TRADIER_TOKEN and TRADIER_ACCOUNT_ID (the SANDBOX ones) in your env file first.");
  process.exit(1);
}
if (new URL(base).hostname !== SANDBOX) {
  console.error(`Refusing: this probe only talks to ${SANDBOX}, not ${new URL(base).hostname}.`);
  process.exit(1);
}

async function get(path: string, query: Record<string, string> = {}): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  const url = `${base}${path}${Object.keys(query).length ? `?${new URLSearchParams(query)}` : ""}`;
  const res = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave null */
  }
  return { ok: res.ok, status: res.status, json, text };
}

const say = (s = "") => console.log(s);
const head = (s: string) => say(`\n== ${s}`);
const fail = (what: string, r: { status: number; text: string }) => say(`   ! ${what}: HTTP ${r.status} ${r.text.slice(0, 200).replace(/\s+/g, " ")}`);

head("Account");
const profile = await get("/user/profile");
if (profile.ok) {
  const accounts = asList<{ account_number?: string; type?: string; classification?: string }>(profile.json?.profile?.account);
  say(`   profile ok; accounts: ${accounts.map((a) => `${a.account_number} (${a.type ?? "?"})`).join(", ") || "none listed"}`);
  say(`   the account id you set (${accountId}) is ${accounts.some((a) => a.account_number === accountId) ? "listed" : "NOT listed here - check TRADIER_ACCOUNT_ID"}`);
} else fail("profile", profile);

const bal = await get(`/accounts/${encodeURIComponent(accountId)}/balances`);
if (bal.ok) {
  const b = bal.json?.balances ?? {};
  say(`   balances: total equity ${b.total_equity ?? "?"}, option buying power ${b.margin?.option_buying_power ?? b.option_buying_power ?? "?"}, cash ${b.total_cash ?? "?"}`);
} else fail("balances", bal);

head("Market");
const clock = await get("/markets/clock");
if (clock.ok) say(`   ${JSON.stringify(clock.json?.clock ?? clock.json).slice(0, 220)}`);
else fail("clock", clock);

const quote = await get("/markets/quotes", { symbols: underlying });
const price: number | null = quote.ok ? Number(asList<{ last?: number; close?: number }>(quote.json?.quotes?.quote)[0]?.last ?? asList<{ close?: number }>(quote.json?.quotes?.quote)[0]?.close ?? NaN) : null;
if (price && Number.isFinite(price)) say(`   ${underlying} last: ${price}  (sandbox data is delayed)`);
else {
  fail(`${underlying} quote`, quote);
  say("   Without a price the strike checks below are skipped.");
}

head(`${underlying} option roots`);
const lookup = await get("/markets/options/lookup", { underlying });
if (lookup.ok) {
  const roots = rootsOf(lookup.json);
  say(roots.length ? `   ${roots.map((r) => `${r.root}: ${r.contracts} contracts`).join("   ") }` : "   none listed");
  say(`   -> the daily (0DTE) series is normally a separate root: look for ${underlying}P (NDX) / SPXW (SPX).`);
} else fail("lookup", lookup);

head("Expirations");
const exp = await get("/markets/options/expirations", { symbol: underlying, includeAllRoots: "true", strikes: "false" });
let expiry: string | null = null;
if (exp.ok) {
  const dates = asList<string | { date?: string }>(exp.json?.expirations?.date ?? exp.json?.expirations?.expiration).map((d) => (typeof d === "string" ? d : d.date ?? "")).filter(Boolean);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const pick = pickExpiry(dates, today);
  expiry = pick.expiry;
  say(`   ${dates.length} expirations; next few: ${dates.filter((d) => d >= today).slice(0, 6).join(", ") || "none"}`);
  say(expiry ? `   inspecting ${expiry}${pick.zeroDte ? " (today: a 0DTE series exists)" : " (no 0DTE listed today)"}` : "   none upcoming");
} else fail("expirations", exp);

if (expiry) {
  head(`Strikes on ${expiry}`);
  const st = await get("/markets/options/strikes", { symbol: underlying, expiration: expiry });
  if (st.ok) {
    const strikes = asList<number>(st.json?.strikes?.strike).map(Number);
    say(`   ${strikes.length} strikes, ${Math.min(...strikes)} to ${Math.max(...strikes)}`);
    if (price && Number.isFinite(price)) {
      const { increment, gaps } = strikeIncrementNear(strikes, price);
      say(`   spacing near ${price}: ${increment ?? "unknown"}  (distinct gaps seen: ${gaps.join(", ") || "-"})`);
      say(`   -> set BOT_${underlying}_EMA_BIAS_STRIKE_INCREMENT=${increment ?? "?"}  (and the width must be a multiple of it)`);
    }
  } else fail("strikes", st);

  head("A sample of real contracts");
  const chain = await get("/markets/options/chains", { symbol: underlying, expiration: expiry, greeks: "false" });
  if (chain.ok) {
    const options = asList<ChainOption>(chain.json?.options?.option);
    const sample = price && Number.isFinite(price) ? nearMoneyPuts(options, price, 2) : options.slice(0, 2);
    for (const o of sample) {
      const p = parseOcc(o.symbol);
      say(`   ${o.symbol}  root=${o.root_symbol ?? p?.root}  strike=${o.strike}  bid=${o.bid} ask=${o.ask}`);
      if (p) {
        const ours = ourSymbol(p.root, p.expiry, p.right, p.strike);
        say(`     our symbol builder gives ${ours}  ${ours === o.symbol ? "(MATCHES)" : "(DIFFERENT - the executor's symbol format needs fixing)"}`);
      }
    }
    if (sample.length >= 2) {
      const [a, b] = sample;
      say(`   a put spread short ${a.strike} / long ${b.strike}: natural credit ${(Number(a.bid) - Number(b.ask)).toFixed(2)}, best ${(Number(a.ask) - Number(b.bid)).toFixed(2)}`);
    }
    if (sample.length === 0) say("   no puts found in the chain answer - check the raw shape below");
    say(`   raw shape: ${JSON.stringify(chain.json).slice(0, 260)}`);
  } else fail("chains", chain);
}

say("\nDone. Nothing was placed, changed or canceled.");
