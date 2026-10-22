// REHEARSAL RUNNER - the logic, with every outside thing (network, clock, files, notifications) passed in, so tests can run whole scenarios
// against a fake app and a fake bridge. PAPER ONLY: nothing here runs unless the bridge says the account is paper.
//
// What it may call (and nothing else - a test checks this list):
//   bridge: GET /health, GET /positions, GET /quote/ndx
//   app:    GET /api/automation/session, POST /api/login, GET /api/automation/status, GET /api/automation/bots/ndx_ema_bias,
//           POST /api/automation/test/alert (the Status page's "send test alert"), POST /api/automation/positions/<id>/close (its "Close position")
// It never presses Resolve, never switches the bot or the kill switch, never clears a flag.

export const BOT_ID = "ndx_ema_bias";
export const APP_URL_DEFAULT = "http://localhost:3000";
export const BRIDGE_URL_DEFAULT = "http://localhost:8787";
export const ACTIVE = ["opening", "open", "closing"];

/** The settings the rehearsal app is started with. Names are listed in a preflight; values never are. */
export const REQUIRED_ENV = [
  "BROKER",
  "BRIDGE_URL",
  "BRIDGE_SECRET",
  "PRICE_SOURCE",
  "BRIDGE_MAX_QUOTE_AGE_MS",
  "BRIDGE_SYMBOLS",
  "QUOTE_MAX_WIDTH",
  "CLOSE_MAX_ABOVE_MARKET",
  "CLOSE_USE_MARKS",
  "AUTOMATION_STORAGE",
  "AUTOMATION_DATA_DIR",
  "WEBHOOK_SECRET",
];

/** The paths a run may call. Anything else is a bug. */
export const ALLOWED_APP_CALLS = [
  /^GET \/api\/automation\/session$/,
  /^POST \/api\/login$/,
  /^GET \/api\/automation\/status$/,
  /^GET \/api\/automation\/bots\/ndx_ema_bias$/,
  /^POST \/api\/automation\/test\/alert$/,
  /^POST \/api\/automation\/positions\/[A-Za-z0-9_-]+\/close$/,
];
export const ALLOWED_BRIDGE_CALLS = [/^GET \/health$/, /^GET \/positions$/, /^GET \/quote\/ndx$/];

export class RefuseError extends Error {
  constructor(message) {
    super(message);
    this.name = "RefuseError";
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------------------------------------------

/** Reads only the wanted keys from the text of an env file (KEY=value, optional `export`, optional quotes, # comments). */
export function parseEnvText(text, wanted) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || !wanted.includes(m[1])) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

/** A function that blanks every known secret in a piece of text. Secrets shorter than 4 characters are not matched (they would blank ordinary words). */
export function makeRedactor(secrets) {
  const list = [...new Set(secrets.filter((s) => typeof s === "string" && s.length >= 4))].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = String(text);
    for (const s of list) out = out.split(s).join("***");
    return out;
  };
}

export const money = (n) => (typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : "-");

export function fmtTime(ms) {
  if (!Number.isFinite(ms)) return "--:--:--";
  return `${new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false })} ET`;
}

/** OCC-style option symbol, written the way the app writes it (root + YYMMDD + C/P + strike x 1000, 8 digits). */
export function occSymbol(root, expiry, right, strike) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiry);
  if (!m) throw new Error(`Bad expiry "${expiry}".`);
  const thousandths = Math.round(strike * 1000);
  return `${root}${m[1].slice(2)}${m[2]}${m[3]}${right === "call" ? "C" : "P"}${String(thousandths).padStart(8, "0")}`;
}

/** What the broker's account should hold for the app's active positions: symbol -> contracts (short negative). */
export function expectedLegs(positions) {
  const held = new Map();
  for (const p of positions) {
    if (!ACTIVE.includes(p.status) || !p.optionRoot) continue;
    const right = p.type === "short_put_spread" ? "put" : "call";
    const q = p.filledQuantity || p.requestedQuantity || 0;
    const add = (strike, qty) => {
      const sym = occSymbol(p.optionRoot, p.expiry, right, strike);
      held.set(sym, (held.get(sym) ?? 0) + qty);
    };
    add(p.shortStrike, -q);
    add(p.longStrike, q);
  }
  return held;
}

/** Differences between what the app thinks is held and what the broker says it holds. An empty list = they agree. */
export function compareAppToBroker(appPositions, brokerPositions) {
  const want = expectedLegs(appPositions);
  const have = new Map();
  for (const b of brokerPositions) have.set(b.symbol, (have.get(b.symbol) ?? 0) + b.quantity);
  const problems = [];
  for (const sym of new Set([...want.keys(), ...have.keys()])) {
    const w = want.get(sym) ?? 0;
    const h = have.get(sym) ?? 0;
    if (w !== h) {
      if (w !== 0 && h === 0) problems.push(`The app shows ${sym} ${w}, but the broker holds none of it.`);
      else if (w === 0) problems.push(`The broker holds ${sym} ${h}, but the app has no position for it.`);
      else problems.push(`${sym}: the app shows ${w}, the broker holds ${h}.`);
    }
  }
  return problems;
}

export const spreadText = (p) => `${p.type === "short_put_spread" ? "put" : "call"} spread ${p.shortStrike}/${p.longStrike}`;
const shortId = (id) => String(id).slice(-6);

function orderLine(o) {
  const bits = [`${fmtTime(o.createdAt)}  ${o.kind}  limit ${money(o.limitPrice)}  ${o.status}  filled ${o.filledQuantity}`];
  if (o.ibkrStatus) bits.push(`IBKR ${o.ibkrStatus}${o.permId !== undefined ? ` (permId ${o.permId})` : ""}`);
  if (o.priceBand) bits.push(`price band: market ${o.priceBand.marketPrice ?? "?"}, edge ${o.priceBand.edge ?? "?"}`);
  if (o.rejectReason) bits.push(`broker said: ${String(o.rejectReason).slice(0, 160)}`);
  return bits.join("  |  ");
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------------------------------------------------------------

export class BridgeClient {
  constructor({ fetchImpl, url, secret, onCall }) {
    this.fetchImpl = fetchImpl;
    this.url = url.replace(/\/+$/, "");
    this.secret = secret;
    this.onCall = onCall;
  }
  async get(path) {
    this.onCall?.(`GET ${path}`);
    const res = await this.fetchImpl(`${this.url}${path}`, { method: "GET", headers: { "X-Bridge-Secret": this.secret, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Bridge GET ${path} answered HTTP ${res.status}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Bridge GET ${path} did not answer with JSON`);
    }
  }
}

export class AppClient {
  constructor({ fetchImpl, url, login, onCall }) {
    this.fetchImpl = fetchImpl;
    this.url = url.replace(/\/+$/, "");
    this.login = login;
    this.onCall = onCall;
    this.cookie = null;
  }
  async request(method, path, body, timeoutMs = 90_000) {
    this.onCall?.(`${method} ${path.replace(/\/positions\/[^/]+\/close/, "/positions/<id>/close")}`);
    const headers = { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) };
    const res = await this.fetchImpl(`${this.url}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, ok: res.ok, json, headers: res.headers };
  }
  /** Signs in when the app asks for it (the same login the browser uses). Returns whether the app is ready to answer. */
  async signIn() {
    const s = await this.request("GET", "/api/automation/session", undefined, 15_000);
    if (!s.ok) throw new Error(`The app answered HTTP ${s.status} on /api/automation/session`);
    if (s.json?.authRequired === false || s.json?.signedIn === true) return;
    if (!this.login?.password) throw new RefuseError("The app asks for a sign-in, but APP_LOGIN_PASSWORD was not found in .env.local, so the runner cannot sign in.");
    const r = await this.request("POST", "/api/login", { email: this.login.email ?? "", password: this.login.password }, 15_000);
    if (!r.ok) throw new RefuseError(`Sign-in to the app was refused (HTTP ${r.status}). Check APP_LOGIN_EMAIL and APP_LOGIN_PASSWORD in .env.local.`);
    const raw = r.headers?.get?.("set-cookie") ?? "";
    const m = /(automation_session=[^;,\s]+)/.exec(raw);
    if (!m) throw new Error("The app signed us in but sent no session cookie.");
    this.cookie = m[1];
  }
  async getStatus() {
    const r = await this.request("GET", "/api/automation/status", undefined, 30_000);
    if (!r.ok) throw new Error(`/api/automation/status answered HTTP ${r.status}`);
    return r.json;
  }
  async getBot() {
    const r = await this.request("GET", `/api/automation/bots/${BOT_ID}`, undefined, 30_000);
    if (!r.ok) throw new Error(`/api/automation/bots/${BOT_ID} answered HTTP ${r.status}`);
    return r.json;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * One line per check. `deps`: { bridge, app, now(), recordedEnvNames (names the `start` command set, or null), print }.
 * Returns { ok, checks: [{ name, ok, detail }] }. Never prints a value of a setting.
 */
export async function runPreflight(deps, options = {}) {
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok, detail });
  let health = null;
  try {
    health = await deps.bridge.get("/health");
    add("The bridge is reachable", true, deps.bridge.url);
  } catch (err) {
    add("The bridge is reachable", false, err.message);
  }
  add("IB Gateway is connected to the bridge", health?.connected === true, health ? "" : "no answer from the bridge");
  add("The bridge says this is a paper account (paper: true)", health?.paper === true, health?.account ? `account ${health.account}` : "");

  let appUp = false;
  try {
    await deps.app.signIn();
    appUp = true;
    add(`The app is up on ${deps.app.url}`, true, "signed in");
  } catch (err) {
    add(`The app is up on ${deps.app.url}`, false, err.message);
  }

  let bot = null;
  let status = null;
  if (appUp) {
    try {
      bot = await deps.app.getBot();
      status = await deps.app.getStatus();
    } catch (err) {
      add("The app answers about the NDX bot", false, err.message);
    }
  }
  if (bot) {
    add("The kill switch is off", bot.bot.killSwitch === false, bot.bot.killSwitch ? "the kill switch is ON" : "");
    add("The bot is on", bot.bot.enabled === true, bot.bot.enabled ? "" : "the bot is OFF");
    add('No "Needs attention" flag is set', !bot.bot.needsAttention, bot.bot.needsAttention ? String(bot.bot.needsAttentionReason ?? "").slice(0, 160) : "");
    const active = bot.positions.filter((p) => ACTIVE.includes(p.status));
    add("The app has no open positions", active.length === 0, active.map((p) => `${spreadText(p)} ${p.status}`).join("; "));
    if (!options.skipBrokerPositions) {
      try {
        const held = (await deps.bridge.get("/positions")).positions ?? [];
        add("The broker account holds no positions", held.length === 0, held.map((h) => `${h.symbol} ${h.quantity}`).join("; "));
      } catch (err) {
        add("The broker account holds no positions", false, err.message);
      }
    }
    const ex = status?.executor;
    add("The app is set to trade through the bridge (BROKER=ibkr, paper)", ex?.venue === "ibkr" && ex?.sandbox !== false && !ex?.error, ex ? `venue ${ex.venue}${ex.error ? `: ${ex.error}` : ""}` : "no executor status");
    add("The app takes prices from the broker (PRICE_SOURCE=broker)", ex?.priceSource === "broker", ex ? `price source ${ex.priceSource ?? "?"}` : "");
  }
  const names = deps.recordedEnvNames;
  if (names === null || names === undefined) {
    add("The rehearsal settings are present", false, "this app was not started with `start`, so its settings cannot be checked. Stop it and use: node scripts/rehearsal/cli.mjs start");
  } else {
    const missing = REQUIRED_ENV.filter((n) => !names.includes(n));
    add("The rehearsal settings are present", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : `present: ${REQUIRED_ENV.join(", ")}`);
  }
  return { ok: checks.every((c) => c.ok), checks, bot };
}

export function formatChecks(result) {
  const lines = result.checks.map((c) => `${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
  lines.push("", `OVERALL: ${result.ok ? "PASS" : "FAIL"}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------------------------------------------

export const SCENARIOS = ["open-bullish", "open-bearish", "close", "flip", "repeat-alert"];

const oppositeSignal = (type) => (type === "short_put_spread" ? "bearish" : "bullish");
const sameSignal = (type) => (type === "short_put_spread" ? "bullish" : "bearish");

/**
 * Runs one scenario and returns { report, verdict, ok, needsAttention }.
 * deps: { bridge, app, now(), sleep(ms), pollMs, timeoutMs, price (optional number), print(line) }
 */
export async function runScenario(name, deps) {
  if (!SCENARIOS.includes(name)) throw new RefuseError(`Unknown scenario "${name}". Choose one of: ${SCENARIOS.join(", ")}.`);
  const say = deps.print ?? (() => {});

  // 1. Gates. Anything wrong here refuses to run; nothing has been sent yet.
  let health;
  try {
    health = await deps.bridge.get("/health");
  } catch (err) {
    throw new RefuseError(`Refusing to run: the bridge cannot be reached (${err.message}).`);
  }
  if (health.paper !== true) throw new RefuseError("Refusing to run: the bridge does not say paper is true. Nothing was sent.");
  if (health.connected !== true) throw new RefuseError("Refusing to run: IB Gateway is not connected to the bridge. Nothing was sent.");
  await deps.app.signIn();
  const before = await deps.app.getBot();
  if (before.bot.killSwitch) throw new RefuseError("Refusing to run: the kill switch is on.");
  if (!before.bot.enabled) throw new RefuseError("Refusing to run: the bot is off.");
  if (before.bot.needsAttention) throw new RefuseError(`Refusing to run: the bot shows "Needs attention" (${String(before.bot.needsAttentionReason ?? "").slice(0, 200)}). Look at it and clear it yourself; the runner never does.`);

  // 2. Preconditions for this scenario.
  const active = before.positions.filter((p) => ACTIVE.includes(p.status));
  let signal = null;
  let closeTarget = null;
  if (name === "open-bullish" || name === "open-bearish") {
    if (active.length > 0) throw new RefuseError(`Refusing to run ${name}: a position is already held (${active.map((p) => `${spreadText(p)} ${p.status}`).join("; ")}).`);
    signal = name === "open-bullish" ? "bullish" : "bearish";
  } else {
    const open = active.filter((p) => p.status === "open");
    if (active.length !== 1 || open.length !== 1) throw new RefuseError(`Refusing to run ${name}: it needs exactly one open position, and the app shows ${active.length === 0 ? "none" : active.map((p) => `${spreadText(p)} ${p.status}`).join("; ")}.`);
    closeTarget = open[0];
    if (name === "flip") signal = oppositeSignal(closeTarget.type);
    if (name === "repeat-alert") signal = sameSignal(closeTarget.type);
  }
  const heldBefore = (await deps.bridge.get("/positions")).positions ?? [];
  const preMismatch = compareAppToBroker(before.positions, heldBefore);
  if (preMismatch.length > 0) throw new RefuseError(`Refusing to run: the app and the broker already disagree before anything is sent: ${preMismatch.join(" ")}`);
  if (name.startsWith("open") && heldBefore.length > 0) throw new RefuseError("Refusing to run: the broker account already holds positions.");

  // 3. Send.
  let price = deps.price;
  if (signal) {
    if (!(price > 0)) {
      const q = await deps.bridge.get("/quote/ndx");
      price = Number(q.price);
      if (!(price > 0)) throw new RefuseError("Refusing to run: the bridge gave no NDX price to put in the alert (pass --price).");
    }
  }
  const startedAt = deps.now();
  const orderIdsBefore = new Set(before.orders.map((o) => o.id));
  const decisionIdsBefore = new Set(before.decisions.map((d) => d.id));
  const seen = {
    orderIds: new Set(orderIdsBefore),
    statuses: new Map(before.positions.map((p) => [p.id, p.status])),
  };
  const changes = [];
  const note = (ms, text) => {
    changes.push({ at: ms, text });
    say(`${fmtTime(ms)}  ${text}`);
  };

  let sent;
  let signalId = null;
  let closeResult = null;
  if (signal) {
    note(startedAt, `Sending a test ${signal} alert at NDX ${price} (the same alert the Status page button sends)`);
    const r = await deps.app.request("POST", "/api/automation/test/alert", { bot: BOT_ID, signal, price }, 90_000);
    sent = `test ${signal} alert at ${price}`;
    if (!r.ok && !r.json?.signalId) {
      note(deps.now(), `The app refused the alert: HTTP ${r.status} ${JSON.stringify(r.json ?? {}).slice(0, 200)}`);
    }
    signalId = r.json?.signalId ?? null;
  } else {
    note(startedAt, `Pressing Close position on ${spreadText(closeTarget)} (the same call the Close position button makes)`);
    const r = await deps.app.request("POST", `/api/automation/positions/${closeTarget.id}/close`, undefined, 400_000);
    sent = `close of ${spreadText(closeTarget)}`;
    closeResult = r.json?.result ?? { ok: false, reason: `HTTP ${r.status}` };
    note(deps.now(), `The app answered the close: ${closeResult.ok ? "ok" : "not closed"} - ${closeResult.outcome ?? ""} ${String(closeResult.reason ?? "").slice(0, 220)}`.trim());
  }

  // 4. Watch until it settles, needs attention, or times out.
  const deadline = startedAt + (deps.timeoutMs ?? 6 * 60_000);
  let latest = before;
  let outcome = "timeout";
  while (true) {
    latest = await deps.app.getBot();
    const t = deps.now();
    for (const p of latest.positions) {
      const was = seen.statuses.get(p.id);
      if (was !== p.status) {
        note(t, `${was === undefined ? "new position" : "position"} ${shortId(p.id)} ${spreadText(p)}: ${was === undefined ? "" : `${was} -> `}${p.status}${p.status === "open" && p.credit != null ? `, credit ${money(p.credit)}` : ""}${p.closePrice != null && (p.status === "closed") ? `, close price ${money(p.closePrice)}` : ""}`);
        seen.statuses.set(p.id, p.status);
      }
    }
    for (const o of latest.orders) {
      if (!seen.orderIds.has(o.id)) {
        seen.orderIds.add(o.id);
        note(Math.max(t, o.createdAt ?? t), `order sent: ${o.kind} limit ${money(o.limitPrice)}`);
      }
    }
    if (latest.bot.needsAttention) {
      outcome = "needs-attention";
      break;
    }
    const inFlight = latest.positions.some((p) => p.status === "opening" || p.status === "closing");
    const runDone = signalId ? latest.runs.some((r) => r.signalId === signalId) : true;
    if (runDone && !inFlight) {
      outcome = "settled";
      break;
    }
    if (t >= deadline) {
      outcome = "timeout";
      break;
    }
    await deps.sleep(deps.pollMs ?? 3000);
  }
  const finishedAt = deps.now();

  // 5. Cross-check with the broker, then judge.
  let brokerHeld = [];
  let brokerError = null;
  try {
    brokerHeld = (await deps.bridge.get("/positions")).positions ?? [];
  } catch (err) {
    brokerError = err.message;
  }
  const mismatches = brokerError ? [`The broker's positions could not be read (${brokerError}), so the app could not be checked against it.`] : compareAppToBroker(latest.positions, brokerHeld);

  const newOrders = latest.orders.filter((o) => !orderIdsBefore.has(o.id)).sort((a, b) => a.createdAt - b.createdAt);
  const newDecisions = latest.decisions.filter((d) => !decisionIdsBefore.has(d.id));
  const activeAfter = latest.positions.filter((p) => ACTIVE.includes(p.status));
  const expectation = expectedEnd(name, { before, latest, activeAfter, closeTarget, newOrders });
  let verdict;
  if (outcome === "needs-attention") verdict = "NEEDS ATTENTION - the runner stopped and touched nothing";
  else if (outcome === "timeout") verdict = "TIMEOUT - still not settled when the time was up";
  else if (mismatches.length > 0) verdict = "MISMATCH between the app and the broker";
  else if (!expectation.ok) verdict = `NOT AS EXPECTED - ${expectation.why}`;
  else verdict = "OK";
  const ok = verdict === "OK";

  const report = buildReport({ name, sent, startedAt, finishedAt, verdict, changes, newOrders, newDecisions, latest, before, mismatches, brokerHeld, expectation, signalId, closeResult });
  return { report, verdict, ok, needsAttention: outcome === "needs-attention", outcome };
}

/** What each scenario should leave behind. */
function expectedEnd(name, { before, latest, activeAfter, closeTarget, newOrders }) {
  const beforeIds = new Set(before.positions.map((p) => p.id));
  const created = latest.positions.filter((p) => !beforeIds.has(p.id));
  if (name === "open-bullish" || name === "open-bearish") {
    const want = name === "open-bullish" ? "short_put_spread" : "short_call_spread";
    const ok = activeAfter.length === 1 && activeAfter[0].type === want && activeAfter[0].status === "open";
    return { ok, why: ok ? "" : `expected one open ${want === "short_put_spread" ? "put" : "call"} spread, the app shows ${activeAfter.length === 0 ? "none" : activeAfter.map((p) => `${spreadText(p)} ${p.status}`).join("; ")}` };
  }
  if (name === "close") {
    const now = latest.positions.find((p) => p.id === closeTarget.id);
    const ok = !!now && now.status === "closed" && activeAfter.length === 0;
    return { ok, why: ok ? "" : `expected the position closed, it is ${now?.status ?? "missing"}` };
  }
  if (name === "flip") {
    const old = latest.positions.find((p) => p.id === closeTarget.id);
    const want = closeTarget.type === "short_put_spread" ? "short_call_spread" : "short_put_spread";
    const ok = old?.status === "closed" && activeAfter.length === 1 && activeAfter[0].type === want && activeAfter[0].status === "open";
    return { ok, why: ok ? "" : `expected the old spread closed and a ${want === "short_put_spread" ? "put" : "call"} spread open; the old one is ${old?.status ?? "missing"}, now held: ${activeAfter.length === 0 ? "none" : activeAfter.map((p) => `${spreadText(p)} ${p.status}`).join("; ")}` };
  }
  // repeat-alert: nothing sent, nothing changed
  const same = latest.positions.find((p) => p.id === closeTarget.id);
  const ok = created.length === 0 && newOrders.length === 0 && same?.status === "open" && activeAfter.length === 1;
  return { ok, why: ok ? "" : `expected nothing to happen, but ${newOrders.length} order(s) were sent and ${created.length} position(s) created` };
}

export function buildReport({ name, sent, startedAt, finishedAt, verdict, changes, newOrders, newDecisions, latest, before, mismatches, brokerHeld, expectation, signalId, closeResult }) {
  const L = [];
  L.push(`REHEARSAL REPORT: ${name}`);
  L.push(`Started ${fmtTime(startedAt)}, finished ${fmtTime(finishedAt)} (${Math.round((finishedAt - startedAt) / 1000)} s)`);
  L.push(`RESULT: ${verdict}`);
  L.push(`What was sent: ${sent}`);
  L.push("");
  L.push("WHAT HAPPENED, IN ORDER");
  for (const c of changes) L.push(`  ${fmtTime(c.at)}  ${c.text}`);
  L.push("");
  L.push("POSITIONS NOW (this bot)");
  const beforeIds = new Set(before.positions.map((p) => p.id));
  const relevant = latest.positions.filter((p) => ACTIVE.includes(p.status) || !beforeIds.has(p.id) || (before.positions.find((b) => b.id === p.id)?.status ?? p.status) !== p.status);
  if (relevant.length === 0) L.push("  none changed");
  for (const p of relevant) {
    L.push(`  ${shortId(p.id)}  ${spreadText(p)}  ${p.status}  strikes ${p.shortStrike}/${p.longStrike}  credit ${money(p.credit)}${p.closePrice != null ? `  close price ${money(p.closePrice)}` : ""}  NDX at open ${p.underlyingAtOpen ?? "-"}`);
  }
  L.push("");
  L.push("EACH PRICE TRIED");
  if (newOrders.length === 0) L.push("  no order was sent");
  for (const o of newOrders) L.push(`  ${orderLine(o)}`);
  L.push("");
  L.push("NEWEST LOG LINES");
  const lines = newDecisions.slice(0, 8);
  if (lines.length === 0) L.push("  none");
  for (const d of lines) L.push(`  ${fmtTime(d.createdAt)}  ${d.outcome}: ${String(d.reason).replace(/\s+/g, " ").slice(0, 330)}`);
  if (closeResult && closeResult.steps) {
    // the close route returns its own steps too
    for (const s of closeResult.steps.slice(0, 12)) L.push(`    step: ${String(s).slice(0, 260)}`);
  }
  const runStep = latest.runs.filter((r) => (signalId ? r.signalId === signalId : (r.startedAt ?? 0) >= startedAt - 2000)).flatMap((r) => r.nodes).filter((n) => n.kind === "action" && n.steps);
  for (const n of runStep) for (const s of n.steps.slice(0, 14)) L.push(`    step: ${String(s).slice(0, 260)}`);
  L.push("");
  L.push("APP vs BROKER");
  L.push(`  The broker holds: ${brokerHeld.length === 0 ? "nothing" : brokerHeld.map((h) => `${h.symbol} ${h.quantity}`).join(", ")}`);
  if (mismatches.length === 0) L.push("  They agree.");
  for (const m of mismatches) L.push(`  MISMATCH: ${m}`);
  if (!expectation.ok) L.push(`  Expected end state not reached: ${expectation.why}`);
  if (latest.bot.needsAttention) {
    L.push("");
    L.push(`NEEDS ATTENTION: ${String(latest.bot.needsAttentionReason ?? "").replace(/\s+/g, " ").slice(0, 400)}`);
    L.push("The runner stopped here. It did not press Resolve or clear anything. Open the position in the app and use Resolve yourself if you want to.");
  }
  return L.join("\n");
}
