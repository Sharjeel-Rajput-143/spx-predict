#!/usr/bin/env node
// POST-EDIT CHECK: run this after ANY change to the source while the app is running (`next dev` recompiles a route the first time it is asked for after a change, and the
// webhook has about 3 seconds before TradingView gives up). It asks, in order, for the pages that must answer, so the recompile is paid HERE and not by an alert, and it
// shows how long each took and whether it answered what it should. It places no order, sends no signal and uses no token: the webhook is asked with GET /hook/warm (which
// answers for any address and triggers nothing) and with POST to an address that does not exist (always "Not found").
//
//   node scripts/warm.mjs [http://localhost:3000]        exit 0 = everything answered as it should, fast
//
// A request that takes over SLOW_MS is flagged: that is the wait a real alert would have had. Run it twice after an edit; the second run shows the warm times.
import { pathToFileURL } from "node:url";

export const SLOW_MS = 1500;

export const CHECKS = [
  { name: "webhook route loads (GET /hook/warm)", method: "GET", path: "/hook/warm", expect: [200], body: (t) => t.includes('"ok":true') },
  { name: "webhook route refuses an unknown address (POST)", method: "POST", path: "/hook/0000", expect: [404], body: (t) => t.includes("Not found"), send: "{}" },
  { name: "session check", method: "GET", path: "/api/automation/session", expect: [200], body: (t) => t.includes("authRequired") },
  { name: "Bybit page (signed out: sent to sign in)", method: "GET", path: "/automation/bybit", expect: [307, 200], redirect: "manual" },
  { name: "Bybit data (signed out: refused)", method: "GET", path: "/api/automation/bybit", expect: [401, 200] },
];

/** Runs every check. `fetchFn` and `now` are injectable for tests. Returns { results, ok }. */
export async function warm(base, { fetchFn = fetch, now = () => performance.now() } = {}) {
  const results = [];
  for (const c of CHECKS) {
    const started = now();
    let status = null;
    let text = "";
    let error = null;
    try {
      const res = await fetchFn(`${base}${c.path}`, { method: c.method, redirect: c.redirect ?? "follow", ...(c.send ? { body: c.send, headers: { "content-type": "application/json" } } : {}), signal: AbortSignal.timeout(20_000) });
      status = res.status;
      text = await res.text().catch(() => "");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const ms = Math.round(now() - started);
    const answered = error === null && c.expect.includes(status) && (c.body ? c.body(text) : true);
    results.push({ name: c.name, status, ms, answered, slow: ms > SLOW_MS, error });
  }
  return { results, ok: results.every((r) => r.answered && !r.slow) };
}

export function format(results) {
  return results.map((r) => `${r.answered ? "OK  " : "FAIL"} ${r.slow ? "SLOW" : "    "} ${String(r.ms).padStart(5)} ms  ${String(r.status ?? "-").padEnd(3)} ${r.name}${r.error ? `  (${r.error})` : ""}`).join("\n");
}

async function main() {
  const base = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");
  const { results, ok } = await warm(base);
  console.log(format(results));
  console.log(ok ? "\nEverything answered, and fast enough for TradingView." : `\nNOT OK: something did not answer as it should, or took over ${SLOW_MS} ms (an alert would have timed out). Run it again; if it still fails, look at the app's log.`);
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
