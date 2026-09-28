import "server-only";
import { getServerBars } from "../marketData/serverBars";
import { decryptSecret } from "./crypto";
import { describeRule } from "./describe";
import { evaluateRule } from "./engine";
import { checkRateLimit } from "./rateLimit";
import { connectionsStore, rulesStore } from "./store";
import { enqueueDelivery } from "./webhookQueue";

const TICK_MS = 5000;
const BARS_NEEDED = 260; // enough warm-up room for the slowest default indicator settings
let started = false;

function tick() {
  const rules = rulesStore.query((r) => r.enabled);

  for (const rule of rules) {
    try {
      const bars = getServerBars(rule.symbol, rule.timeframe, BARS_NEEDED);
      if (bars.length < 2) continue;

      const latestBarTime = bars[bars.length - 1].t;
      // Spec 3.2: evaluate once per bar close, not on every tick.
      if (rule.lastEvaluatedBarTime === latestBarTime) continue;
      rulesStore.update(rule.id, { lastEvaluatedBarTime: latestBarTime });

      const result = evaluateRule(rule, bars);
      if (!result?.triggered) continue;

      if (!checkRateLimit(rule.userId, "webhook-fire", 60, 60 * 60_000)) continue;

      const connection = connectionsStore.get(rule.connectionId);
      if (!connection || !connection.active) continue;

      const url = decryptSecret(connection.webhookUrlEncrypted);
      const payload = {
        symbol: rule.symbol,
        timeframe: rule.timeframe,
        condition: describeRule(rule),
        message: rule.message,
        values: { a: result.valueA, b: result.valueB },
        firedAt: new Date(result.barTime).toISOString(),
      };
      enqueueDelivery({ ruleId: rule.id, url, payload });
      rulesStore.update(rule.id, { lastTriggeredAt: Date.now() });
    } catch (err) {
      console.error(`[automations] rule ${rule.id} evaluation failed`, err);
    }
  }
}

/** Lazily started (mirrors tickStore's poller) the first time any
 * automations route is hit, and kept alive for the life of the process. */
export function startAutomationScheduler() {
  if (started) return;
  started = true;
  tick();
  setInterval(tick, TICK_MS);
}
