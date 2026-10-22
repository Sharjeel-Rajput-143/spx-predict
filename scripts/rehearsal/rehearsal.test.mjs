import { describe, expect, it } from "vitest";
import {
  ALLOWED_APP_CALLS,
  ALLOWED_BRIDGE_CALLS,
  AppClient,
  BridgeClient,
  REQUIRED_ENV,
  RefuseError,
  SCENARIOS,
  compareAppToBroker,
  expectedLegs,
  formatChecks,
  makeRedactor,
  occSymbol,
  parseEnvText,
  runPreflight,
  runScenario,
} from "./lib.mjs";
import { acquireLock, buildRehearsalEnv, envNamesOf, makeCopier, makeNotifier, startApp, stopApp } from "./ops.mjs";

// A fake app and a fake bridge, in memory. The clock only moves when the runner sleeps, so every run is instant and repeatable.
const BRIDGE_SECRET = "bridge-secret-VALUE-1234";
const APP_PASSWORD = "app-password-VALUE-5678";
const COOKIE = "automation_session=cookie-VALUE-9999";

class World {
  constructor() {
    this.t = Date.UTC(2026, 9, 16, 15, 0, 0);
    this.calls = [];
    this.paper = true;
    this.connected = true;
    this.bridgeDown = false;
    this.appDown = false;
    this.price = 29650;
    this.bot = { enabled: true, killSwitch: false, needsAttention: false, needsAttentionReason: null };
    this.positions = [];
    this.orders = [];
    this.decisions = [];
    this.runs = [];
    this.broker = [];
    this.pending = []; // functions run, one per poll of the bot
    this.id = 0;
    this.alertBehavior = (signal) => this.instantTrade(signal);
    this.closeBehavior = (p) => this.instantClose(p);
    this.statusOverride = {};
  }
  now = () => this.t;
  sleep = async (ms) => {
    this.t += ms;
  };
  uid(prefix) {
    return `${prefix}-${++this.id}-${"x".repeat(8)}`;
  }
  legSymbols(p) {
    const right = p.type === "short_put_spread" ? "P" : "C";
    return [`NDXP261016${right}${String(p.shortStrike * 1000).padStart(8, "0")}`, `NDXP261016${right}${String(p.longStrike * 1000).padStart(8, "0")}`];
  }
  addOrder(positionId, kind, limitPrice, status, filled = 0, extra = {}) {
    const o = { id: this.uid("ord"), positionId, kind, limitPrice, status, filledQuantity: filled, ref: this.uid("ref"), createdAt: this.t, ...extra };
    this.orders.push(o);
    return o;
  }
  decide(signalId, outcome, reason) {
    this.decisions.unshift({ id: this.uid("dec"), signalId, botId: "ndx_ema_bias", outcome, reason, createdAt: this.t });
  }
  openPosition(type, signalId) {
    const short = type === "short_put_spread" ? 29600 : 29700;
    const p = { id: this.uid("pos"), botId: "ndx_ema_bias", type, shortStrike: short, longStrike: type === "short_put_spread" ? short - 50 : short + 50, requestedQuantity: 1, filledQuantity: 1, expiry: "2026-10-16", optionRoot: "NDXP", status: "open", credit: 15, openedAt: this.t, closePrice: null, underlyingAtOpen: this.price, venue: "ibkr" };
    this.positions.unshift(p);
    this.addOrder(p.id, "open", 15, "filled", 1);
    const [s, l] = this.legSymbols(p);
    this.broker.push({ symbol: s, quantity: -1 }, { symbol: l, quantity: 1 });
    this.decide(signalId, "opened", "Opened new position.");
    return p;
  }
  closePositionNow(p, signalId, price = 4.5) {
    p.status = "closed";
    p.closePrice = price;
    this.addOrder(p.id, "close", price, "filled", 1);
    const [s, l] = this.legSymbols(p);
    this.broker = this.broker.filter((b) => b.symbol !== s && b.symbol !== l);
    this.decide(signalId, "closed", "Close order filled.");
  }
  finishRun(signalId, steps = []) {
    this.runs.unshift({ signalId, startedAt: this.t, nodes: [{ kind: "action", action: "open", steps }] });
  }
  active() {
    return this.positions.filter((p) => ["opening", "open", "closing"].includes(p.status));
  }
  instantTrade(signal) {
    const signalId = this.uid("sig");
    const wanted = signal === "bullish" ? "short_put_spread" : "short_call_spread";
    const held = this.active()[0];
    if (held && held.type === wanted) {
      this.decide(signalId, "already_held", "Already holding this side: nothing was sent.");
    } else {
      if (held) this.closePositionNow(held, signalId);
      this.openPosition(wanted, signalId);
    }
    this.finishRun(signalId, ["Price 1 of 4: $15.00, waited up to 10s - filled 1 of 1"]);
    return { status: 200, body: { signalId, finished: true, decisions: [] } };
  }
  instantClose(p) {
    this.closePositionNow(p, null);
    return { status: 200, body: { result: { ok: true, outcome: "closed", reason: "Close order filled." } } };
  }
  fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const reply = (status, json, headers = {}) => new Response(JSON.stringify(json), { status, headers });
    if (u.origin === "http://bridge.test") {
      this.calls.push({ side: "bridge", key: `${method} ${u.pathname}`, secret: init.headers?.["X-Bridge-Secret"] });
      if (this.bridgeDown) throw new TypeError("fetch failed");
      if (init.headers?.["X-Bridge-Secret"] !== BRIDGE_SECRET) return reply(401, { detail: "bad secret" });
      if (u.pathname === "/health") return reply(200, { connected: this.connected, account: "DUR265777", paper: this.paper });
      if (u.pathname === "/positions") return reply(200, { positions: this.broker });
      if (u.pathname === "/quote/ndx") return reply(200, { price: this.price, asOf: this.t, delayed: true });
      return reply(404, {});
    }
    this.calls.push({ side: "app", key: `${method} ${u.pathname}`, cookie: init.headers?.Cookie });
    if (this.appDown) throw new TypeError("fetch failed");
    if (u.pathname === "/api/automation/session") return reply(200, { authRequired: true, signedIn: init.headers?.Cookie === COOKIE });
    if (u.pathname === "/api/login") {
      const body = JSON.parse(init.body);
      return body.password === APP_PASSWORD ? reply(200, { ok: true }, { "set-cookie": `${COOKIE}; Path=/; HttpOnly` }) : reply(401, { error: "Wrong email or password." });
    }
    if (init.headers?.Cookie !== COOKIE) return reply(401, { error: "Unauthorized." });
    if (u.pathname === "/api/automation/status") return reply(200, { executor: { kind: "ibkr", venue: "ibkr", error: null, sandbox: true, priceSource: "broker", ...this.statusOverride } });
    if (u.pathname === "/api/automation/bots/ndx_ema_bias") {
      const fn = this.pending.shift();
      fn?.();
      return reply(200, { bot: { ...this.bot, id: "ndx_ema_bias" }, positions: this.positions, orders: this.orders, decisions: this.decisions, runs: this.runs });
    }
    if (u.pathname === "/api/automation/test/alert") {
      const body = JSON.parse(init.body);
      const r = this.alertBehavior(body.signal, body);
      return reply(r.status, r.body);
    }
    const close = /^\/api\/automation\/positions\/([^/]+)\/close$/.exec(u.pathname);
    if (close) {
      const p = this.positions.find((x) => x.id === close[1]);
      const r = this.closeBehavior(p);
      return reply(r.status, r.body);
    }
    return reply(404, {});
  };
  deps(extra = {}) {
    return {
      bridge: new BridgeClient({ fetchImpl: this.fetch, url: "http://bridge.test", secret: BRIDGE_SECRET }),
      app: new AppClient({ fetchImpl: this.fetch, url: "http://app.test", login: { email: "me@example.com", password: APP_PASSWORD } }),
      now: this.now,
      sleep: this.sleep,
      pollMs: 3000,
      timeoutMs: 6 * 60_000,
      ...extra,
    };
  }
}

const ALL_ENV = [...REQUIRED_ENV];

describe("small helpers", () => {
  it("parseEnvText reads only the wanted keys, with quotes, export and comments", () => {
    const text = ['# a comment', 'APP_LOGIN_EMAIL="me@example.com"', "export APP_LOGIN_PASSWORD='p w'", "AUTH_SECRET=never-wanted", "OTHER=1 # trailing", "APP_LOGIN_PASSWORD_X=nope"].join("\n");
    expect(parseEnvText(text, ["APP_LOGIN_EMAIL", "APP_LOGIN_PASSWORD"])).toEqual({ APP_LOGIN_EMAIL: "me@example.com", APP_LOGIN_PASSWORD: "p w" });
  });

  it("the redactor blanks every secret, longest first, and ignores very short ones", () => {
    const r = makeRedactor(["abc-secret-1234", "abc-secret", "xy", ""]);
    expect(r("token abc-secret-1234 and abc-secret and xy")).toBe("token *** and *** and xy");
  });

  it("occSymbol matches the app's format", () => {
    expect(occSymbol("NDXP", "2026-10-16", "put", 29600)).toBe("NDXP261016P29600000");
    expect(occSymbol("NDXP", "2026-10-16", "call", 29700.5)).toBe("NDXP261016C29700500");
  });

  it("compareAppToBroker: agreement, a leg the broker lacks, a leg the app lacks, a wrong size; closed positions are not expected", () => {
    const p = { type: "short_call_spread", shortStrike: 29700, longStrike: 29750, expiry: "2026-10-16", optionRoot: "NDXP", filledQuantity: 1, status: "open" };
    const held = [{ symbol: "NDXP261016C29700000", quantity: -1 }, { symbol: "NDXP261016C29750000", quantity: 1 }];
    expect(compareAppToBroker([p], held)).toEqual([]);
    expect(compareAppToBroker([{ ...p, status: "closed" }], [])).toEqual([]);
    expect(compareAppToBroker([p], [])).toHaveLength(2);
    expect(compareAppToBroker([], held)[0]).toMatch(/broker holds NDXP261016C29700000 -1, but the app has no position/);
    expect(compareAppToBroker([p], [{ ...held[0], quantity: -2 }, held[1]])[0]).toMatch(/app shows -1, the broker holds -2/);
    expect([...expectedLegs([p]).entries()]).toEqual([["NDXP261016C29700000", -1], ["NDXP261016C29750000", 1]]);
  });
});

describe("preflight", () => {
  const run = (w, names = ALL_ENV) => runPreflight({ bridge: w.deps().bridge, app: w.deps().app, recordedEnvNames: names });
  const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name);

  it("passes when everything is right, and lists names only", async () => {
    const w = new World();
    const r = await run(w);
    expect(r.ok).toBe(true);
    const text = formatChecks(r);
    expect(text).toMatch(/PASS {2}The bridge says this is a paper account/);
    expect(text).toMatch(/OVERALL: PASS/);
    for (const n of REQUIRED_ENV) expect(text).toContain(n);
    for (const secret of [BRIDGE_SECRET, APP_PASSWORD, "cookie-VALUE-9999", "rehearsal-only-secret-value"]) expect(text).not.toContain(secret);
  });

  it("fails, saying which check, for each thing that can be wrong", async () => {
    const cases = [
      [(w) => (w.bridgeDown = true), /The bridge is reachable/],
      [(w) => (w.connected = false), /IB Gateway is connected/],
      [(w) => (w.paper = false), /paper account \(paper: true\)/],
      [(w) => (w.appDown = true), /The app is up/],
      [(w) => (w.bot.killSwitch = true), /kill switch is off/],
      [(w) => (w.bot.enabled = false), /The bot is on/],
      [(w) => ((w.bot.needsAttention = true), (w.bot.needsAttentionReason = "old error")), /Needs attention/],
      [(w) => w.openPosition("short_put_spread", "s"), /no open positions/],
      [(w) => (w.broker = [{ symbol: "X", quantity: 1 }]), /broker account holds no positions/],
      [(w) => (w.statusOverride = { venue: "mock" }), /trade through the bridge/],
      [(w) => (w.statusOverride = { priceSource: "feed" }), /prices from the broker/],
    ];
    for (const [setup, re] of cases) {
      const w = new World();
      setup(w);
      const r = await run(w);
      expect(r.ok).toBe(false);
      expect(failed(r).join(" | ")).toMatch(re);
    }
  });

  it("fails on missing setting names and when the settings cannot be checked at all", async () => {
    const w = new World();
    const r = await run(w, ALL_ENV.filter((n) => n !== "CLOSE_USE_MARKS"));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => !c.ok).detail).toBe("missing: CLOSE_USE_MARKS");
    const r2 = await run(w, null);
    expect(r2.ok).toBe(false);
    expect(r2.checks.find((c) => !c.ok).detail).toMatch(/not started with `start`/);
  });
});

describe("scenarios", () => {
  const go = (w, name, extra) => runScenario(name, w.deps(extra));

  it("open-bullish: opens a put spread, and the report shows strikes, credit, the price tried, the log line and that the broker agrees", async () => {
    const w = new World();
    const r = await go(w, "open-bullish");
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe("OK");
    expect(r.report).toMatch(/REHEARSAL REPORT: open-bullish/);
    expect(r.report).toMatch(/Sending a test bullish alert at NDX 29650/);
    expect(r.report).toMatch(/put spread 29600\/29550/);
    expect(r.report).toMatch(/credit 15\.00/);
    expect(r.report).toMatch(/open {2}limit 15\.00 {2}filled {2}filled 1/);
    expect(r.report).toMatch(/opened: Opened new position\./);
    expect(r.report).toMatch(/They agree\./);
    expect(r.report).toMatch(/ET {2}new position .* put spread 29600\/29550: open, credit 15\.00/);
  });

  it("open-bearish opens a call spread", async () => {
    const w = new World();
    const r = await go(w, "open-bearish");
    expect(r.ok).toBe(true);
    expect(r.report).toMatch(/call spread 29700\/29750/);
    expect(w.broker).toHaveLength(2);
  });

  it("close: closes the open position, with the close price in the report and the broker flat", async () => {
    const w = new World();
    w.openPosition("short_put_spread", "s0");
    const r = await go(w, "close");
    expect(r.ok).toBe(true);
    expect(r.report).toMatch(/Pressing Close position on put spread 29600\/29550/);
    expect(r.report).toMatch(/close price 4\.50/);
    expect(r.report).toMatch(/The broker holds: nothing/);
  });

  it("flip: closes the held side and opens the other", async () => {
    const w = new World();
    w.openPosition("short_put_spread", "s0");
    const r = await go(w, "flip");
    expect(r.ok).toBe(true);
    expect(r.report).toMatch(/test bearish alert/);
    expect(w.positions.map((p) => `${p.type}:${p.status}`).sort()).toEqual(["short_call_spread:open", "short_put_spread:closed"]);
    expect(r.report).toMatch(/close {2}limit 4\.50/);
  });

  it("repeat-alert: the same side again sends nothing, and that is the expected result", async () => {
    const w = new World();
    w.openPosition("short_call_spread", "s0");
    const r = await go(w, "repeat-alert");
    expect(r.ok).toBe(true);
    expect(r.report).toMatch(/test bearish alert/);
    expect(r.report).toMatch(/no order was sent/);
    expect(r.report).toMatch(/already_held/);
  });

  it("repeat-alert is judged NOT as expected if an order was sent", async () => {
    const w = new World();
    w.openPosition("short_call_spread", "s0");
    w.alertBehavior = () => {
      const signalId = w.uid("sig");
      w.addOrder(w.positions[0].id, "close", 1, "canceled");
      w.decide(signalId, "close_timeout", "Close order ended without filling.");
      w.finishRun(signalId);
      return { status: 200, body: { signalId, finished: true, decisions: [] } };
    };
    const r = await go(w, "repeat-alert");
    expect(r.ok).toBe(false);
    expect(r.verdict).toMatch(/NOT AS EXPECTED/);
  });

  it("an order still working is waited for, polling until the position is open", async () => {
    const w = new World();
    w.alertBehavior = (signal) => {
      const signalId = w.uid("sig");
      const p = w.openPosition(signal === "bullish" ? "short_put_spread" : "short_call_spread", signalId);
      p.status = "opening";
      w.decisions.shift();
      w.pending.push(() => {}, () => {}, () => {
        p.status = "open";
        w.decide(signalId, "opened", "Opened new position.");
        w.finishRun(signalId, ["Price 2 of 4: filled"]);
      });
      return { status: 200, body: { signalId, finished: false, decisions: [] } };
    };
    const r = await go(w, "open-bullish");
    expect(r.ok).toBe(true);
    expect(r.report).toMatch(/opening -> open/);
    expect(r.report).toMatch(/Price 2 of 4: filled/);
  });

  it("a close that ends canceled shows every price tried and the broker's trail, and is not OK", async () => {
    const w = new World();
    const p = w.openPosition("short_put_spread", "s0");
    w.closeBehavior = () => {
      w.addOrder(p.id, "close", 17, "canceled", 0, { ibkrStatus: "Cancelled", permId: 98421380, priceBand: { marketPrice: 4.9, edge: 5.5 }, rejectReason: "Order Canceled - reason: too far" });
      w.decide(null, "close_timeout", "Close order ended without filling.");
      return { status: 409, body: { result: { ok: false, outcome: "close_timeout", reason: "Close order ended without filling.", steps: ["Price 1 of 4: $17.00 ... Cancelled"] } } };
    };
    const r = await go(w, "close");
    expect(r.ok).toBe(false);
    expect(r.verdict).toMatch(/NOT AS EXPECTED - expected the position closed, it is open/);
    expect(r.report).toMatch(/close {2}limit 17\.00 {2}canceled {2}filled 0 {2}\| {2}IBKR Cancelled \(permId 98421380\) {2}\| {2}price band: market 4\.9, edge 5\.5 {2}\| {2}broker said: Order Canceled/);
    expect(r.report).toMatch(/close_timeout: Close order ended without filling/);
    expect(r.report).toMatch(/step: Price 1 of 4: \$17\.00/);
  });

  it("stops on Needs attention, touches nothing more, and says it did not press Resolve", async () => {
    const w = new World();
    const p = w.openPosition("short_put_spread", "s0");
    w.closeBehavior = () => {
      p.status = "closing";
      w.bot.needsAttention = true;
      w.bot.needsAttentionReason = "Close order never filled before the confirm timeout.";
      return { status: 409, body: { result: { ok: false, outcome: "close_timeout", reason: "never filled" } } };
    };
    const r = await go(w, "close");
    expect(r.needsAttention).toBe(true);
    expect(r.verdict).toMatch(/NEEDS ATTENTION/);
    expect(r.report).toMatch(/NEEDS ATTENTION: Close order never filled/);
    expect(r.report).toMatch(/did not press Resolve/);
    const posts = w.calls.filter((c) => c.key.startsWith("POST") && !c.key.includes("login")).map((c) => c.key);
    expect(posts).toEqual(["POST /api/automation/positions/<id>/close".replace("<id>", p.id)]);
  });

  it("a position that never settles ends in a timeout, not a hang", async () => {
    const w = new World();
    w.alertBehavior = (signal) => {
      const signalId = w.uid("sig");
      w.openPosition(signal === "bullish" ? "short_put_spread" : "short_call_spread", signalId).status = "opening";
      return { status: 200, body: { signalId, finished: false, decisions: [] } };
    };
    const r = await go(w, "open-bullish", { timeoutMs: 60_000, pollMs: 5000 });
    expect(r.ok).toBe(false);
    expect(r.verdict).toMatch(/TIMEOUT/);
  });

  it("a mismatch between the app and the broker is reported", async () => {
    const w = new World();
    w.alertBehavior = (signal) => {
      const r = w.instantTrade(signal);
      w.broker = []; // the broker holds nothing though the app says open
      return r;
    };
    const r = await go(w, "open-bullish");
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe("MISMATCH between the app and the broker");
    expect(r.report).toMatch(/MISMATCH: The app shows NDXP261016P29600000 -1, but the broker holds none of it\./);
  });
});

describe("scenarios refuse to run, and send nothing, when it is not safe", () => {
  const posts = (w) => w.calls.filter((c) => c.key.startsWith("POST /api/automation"));
  const refuses = async (w, name, re) => {
    await expect(runScenario(name, w.deps())).rejects.toThrow(RefuseError);
    await expect(runScenario(name, w.deps())).rejects.toThrow(re);
    expect(posts(w)).toHaveLength(0);
  };

  it("the bridge does not say paper is true", async () => {
    const w = new World();
    w.paper = false;
    await refuses(w, "open-bullish", /does not say paper is true/);
  });

  it("the bridge cannot be reached, or Gateway is not connected", async () => {
    const a = new World();
    a.bridgeDown = true;
    await refuses(a, "open-bullish", /bridge cannot be reached/);
    const b = new World();
    b.connected = false;
    await refuses(b, "open-bullish", /Gateway is not connected/);
  });

  it("the kill switch is on, the bot is off, or Needs attention is set", async () => {
    const a = new World();
    a.bot.killSwitch = true;
    await refuses(a, "open-bullish", /kill switch is on/);
    const b = new World();
    b.bot.enabled = false;
    await refuses(b, "open-bullish", /bot is off/);
    const c = new World();
    c.bot.needsAttention = true;
    c.bot.needsAttentionReason = "something";
    await refuses(c, "open-bullish", /Needs attention/);
  });

  it("each scenario's own precondition", async () => {
    const held = new World();
    held.openPosition("short_put_spread", "s");
    await refuses(held, "open-bullish", /already held/);
    await refuses(held, "open-bearish", /already held/);
    for (const name of ["close", "flip", "repeat-alert"]) await refuses(new World(), name, /needs exactly one open position/);
    const closing = new World();
    closing.openPosition("short_put_spread", "s").status = "closing";
    await refuses(closing, "close", /needs exactly one open position/);
  });

  it("the app and the broker already disagree", async () => {
    const w = new World();
    w.openPosition("short_put_spread", "s");
    w.broker = [];
    await refuses(w, "close", /already disagree/);
  });

  it("an unknown scenario name", async () => {
    await expect(runScenario("resolve", new World().deps())).rejects.toThrow(/Unknown scenario/);
  });
});

describe("what a run may call, and what it may print", () => {
  it("every scenario uses only the allowed calls: never Resolve, the bot switch, the kill switch, settle, move or reset", async () => {
    for (const name of SCENARIOS) {
      const w = new World();
      if (name !== "open-bullish" && name !== "open-bearish") w.openPosition("short_put_spread", "s0");
      await runScenario(name, w.deps());
      const app = w.calls.filter((c) => c.side === "app").map((c) => c.key.replace(/\/positions\/[^/]+\/close/, "/positions/id/close"));
      const bridge = w.calls.filter((c) => c.side === "bridge").map((c) => c.key);
      for (const key of app) expect(ALLOWED_APP_CALLS.some((re) => re.test(key.replace("/positions/id/close", "/positions/abc/close")))).toBe(true);
      for (const key of bridge) expect(ALLOWED_BRIDGE_CALLS.some((re) => re.test(key))).toBe(true);
      expect(app.join(" ")).not.toMatch(/resolve|toggle|kill|settle|move|daily-reset|test\/reset/);
      // nothing but reads goes to the bridge
      expect(bridge.every((k) => k.startsWith("GET "))).toBe(true);
    }
  });

  it("the secret goes to the bridge in a header and to the app only as the sign-in cookie; no report contains a secret", async () => {
    const w = new World();
    const r = await runScenario("open-bullish", w.deps());
    for (const secret of [BRIDGE_SECRET, APP_PASSWORD, "cookie-VALUE-9999", "rehearsal-only-secret-value"]) expect(r.report).not.toContain(secret);
    expect(w.calls.filter((c) => c.side === "bridge").every((c) => c.secret === BRIDGE_SECRET)).toBe(true);
  });

  it("the app is signed into once with the login, and a wrong password is refused without the runner retrying", async () => {
    const w = new World();
    const deps = w.deps();
    deps.app.login = { email: "", password: "wrong" };
    await expect(runScenario("open-bullish", deps)).rejects.toThrow(/Sign-in to the app was refused/);
    expect(w.calls.filter((c) => c.key === "POST /api/login")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// ops: start, stop, lock, notification, clipboard
// ---------------------------------------------------------------------------------------------------------------------------------
function fakeFs() {
  const files = new Map();
  return {
    files,
    mkdirSync() {},
    openSync(p) {
      files.set(p, files.get(p) ?? "");
      return 9;
    },
    writeFileSync(p, t) {
      files.set(p, String(t));
    },
    readFileSync(p) {
      if (!files.has(p)) throw new Error("ENOENT");
      return files.get(p);
    },
    existsSync: (p) => files.has(p),
    rmSync(p) {
      files.delete(p);
    },
  };
}

describe("start, stop, lock, notification and clipboard", () => {
  const baseDeps = (w, over = {}) => {
    const fs = fakeFs();
    const spawned = [];
    const out = [];
    return {
      fs,
      spawned,
      out,
      deps: {
        fs,
        spawn: (cmd, args, opts) => (spawned.push({ cmd, args, opts }), { pid: 4242, unref() {} }),
        isPortBusy: async () => false,
        bridge: w.deps().bridge,
        env: buildRehearsalEnv({ bridgeSecret: BRIDGE_SECRET, home: "/home/me", base: {} }),
        baseEnv: { PATH: "/usr/bin" },
        cwd: "/repo",
        logDir: "/home/me/ndx-rehearsal-logs",
        now: () => Date.UTC(2026, 9, 16, 15, 0, 0),
        waitForApp: async () => true,
        print: (l) => out.push(l),
        ...over,
      },
    };
  };

  it("the rehearsal settings include every required name, the secret from the file, and the chase only when it was exported", () => {
    const env = buildRehearsalEnv({ bridgeSecret: BRIDGE_SECRET, home: "/home/me", base: {} });
    expect(Object.keys(env).sort()).toEqual([...REQUIRED_ENV].sort());
    expect(env.BRIDGE_SECRET).toBe(BRIDGE_SECRET);
    expect(env.CLOSE_USE_MARKS).toBe("1");
    expect(env.CLOSE_CHASE_MAX).toBeUndefined();
    expect(buildRehearsalEnv({ bridgeSecret: "s", home: "/h", base: { CLOSE_CHASE_MAX: "3" } }).CLOSE_CHASE_MAX).toBe("3");
    expect(envNamesOf(env)).toEqual(expect.arrayContaining(REQUIRED_ENV));
  });

  it("start: runs `npm run dev` in the background with the rehearsal settings, logs to a file, records names only, and prints how to stop it", async () => {
    const w = new World();
    const { fs, spawned, out, deps } = baseDeps(w);
    const r = await startApp(deps);
    expect(r.up).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ cmd: "npm", args: ["run", "dev"], opts: { cwd: "/repo", detached: true } });
    expect(spawned[0].opts.env.BRIDGE_SECRET).toBe(BRIDGE_SECRET);
    expect(spawned[0].opts.stdio[1]).toBe(9);
    const state = fs.files.get("/home/me/ndx-rehearsal-logs/app.json");
    expect(JSON.parse(state).envNames).toEqual(expect.arrayContaining(REQUIRED_ENV));
    expect(state).not.toContain(BRIDGE_SECRET);
    expect(out.join("\n")).not.toContain(BRIDGE_SECRET);
    expect(out.join("\n")).toMatch(/Log file: \/home\/me\/ndx-rehearsal-logs\/app-.*\.log/);
    expect(out.join("\n")).toMatch(/To stop it: node scripts\/rehearsal\/cli\.mjs stop {4}\(or: kill -- -4242\)/);
  });

  it("start refuses when port 3000 is busy, when the bridge cannot be reached, or when it does not say paper", async () => {
    const w = new World();
    const busy = baseDeps(w, { isPortBusy: async () => true });
    await expect(startApp(busy.deps)).rejects.toThrow(/port 3000 is busy/);
    expect(busy.spawned).toHaveLength(0);
    const down = new World();
    down.bridgeDown = true;
    const d = baseDeps(down);
    await expect(startApp(d.deps)).rejects.toThrow(/bridge cannot be reached/);
    expect(d.spawned).toHaveLength(0);
    const live = new World();
    live.paper = false;
    const l = baseDeps(live);
    await expect(startApp(l.deps)).rejects.toThrow(/does not say paper is true/);
    expect(l.spawned).toHaveLength(0);
  });

  it("start says plainly when the app did not come up in time", async () => {
    const w = new World();
    const { out, deps } = baseDeps(w, { waitForApp: async () => false });
    const r = await startApp(deps);
    expect(r.up).toBe(false);
    expect(out.join("\n")).toMatch(/did not answer within the time allowed/);
  });

  it("stop: only the app this runner started, and only if the process looks like it", async () => {
    const w = new World();
    const { fs, deps } = baseDeps(w);
    await expect(stopApp({ ...deps, commandOf: async () => "" , kill() {} })).rejects.toThrow(/Nothing to stop/);
    await startApp(deps);
    const kills = [];
    await expect(stopApp({ fs, logDir: deps.logDir, print() {}, commandOf: async () => "/usr/bin/python3 bridge.py", kill: (...a) => kills.push(a) })).rejects.toThrow(/does not look like the app/);
    expect(kills).toEqual([]);
    const r = await stopApp({ fs, logDir: deps.logDir, print() {}, commandOf: async () => "npm run dev", kill: (...a) => kills.push(a) });
    expect(r.stopped).toBe(true);
    expect(kills).toEqual([[-4242, "SIGTERM"]]);
    expect(fs.existsSync("/home/me/ndx-rehearsal-logs/app.json")).toBe(false);
  });

  it("stop cleans up after a process that is already gone", async () => {
    const w = new World();
    const { fs, deps } = baseDeps(w);
    await startApp(deps);
    const kills = [];
    const r = await stopApp({ fs, logDir: deps.logDir, print() {}, commandOf: async () => "", kill: (...a) => kills.push(a) });
    expect(r.stopped).toBe(false);
    expect(kills).toEqual([]);
  });

  it("one scenario at a time: a lock held by a live process refuses, a dead one is taken over, and release removes it", () => {
    const fs = fakeFs();
    const base = { fs, logDir: "/logs", pid: 111 };
    const release = acquireLock({ ...base, isAlive: () => false });
    expect(fs.files.get("/logs/scenario.lock")).toBe("111");
    expect(() => acquireLock({ ...base, pid: 222, isAlive: (p) => p === 111 })).toThrow(/another scenario is running \(process 111\)/);
    release();
    expect(fs.existsSync("/logs/scenario.lock")).toBe(false);
    fs.writeFileSync("/logs/scenario.lock", "999");
    acquireLock({ ...base, pid: 333, isAlive: () => false });
    expect(fs.files.get("/logs/scenario.lock")).toBe("333");
  });

  it("the macOS notification passes the text as arguments, strips quotes, and does nothing elsewhere", () => {
    const calls = [];
    makeNotifier((cmd, args) => calls.push([cmd, args]), "darwin")('Rehearsal "close"', 'done "now" \\ ok');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("osascript");
    expect(calls[0][1][0]).toBe("-e");
    expect(calls[0][1][1]).toBe('display notification "done now  ok" with title "Rehearsal close"');
    const none = [];
    makeNotifier((...a) => none.push(a), "linux")("t", "m");
    expect(none).toEqual([]);
  });

  it("the clipboard copy pipes the report to pbcopy and says whether it worked", async () => {
    let written = "";
    const handlers = {};
    const fakeSpawn = (cmd, args) => {
      expect(cmd).toBe("pbcopy");
      return { on: (e, f) => (handlers[e] = f), stdin: { end: (t) => ((written = t), setTimeout(() => handlers.close(0), 0)) } };
    };
    expect(await makeCopier(fakeSpawn, "darwin")("the report")).toBe(true);
    expect(written).toBe("the report");
    expect(await makeCopier(fakeSpawn, "linux")("x")).toBe(false);
  });
});
