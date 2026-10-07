import type { BotStaticConfig } from "@/lib/automation/types";
import { appendStep, cloneStep, newCondition, newStep, type Condition, type Step } from "./model";

const TYPE_NAME = { put: "Short put spread", call: "Short call spread" } as const;
const TYPE_KEY = { put: "short_put_spread", call: "short_call_spread" } as const;

const holds = (type: "put" | "call", count = 1): Condition => {
  const c = newCondition("bot_has_type");
  return { ...c, values: { ...c.values, type: TYPE_NAME[type], count: `${count} position${count === 1 ? "" : "s"}` } };
};

export interface FlowWindow {
  /** "HH:MM", 24h New York time. */
  start: string;
  end: string;
}

/** "09:35" -> "9:35am" - how the condition text writes a time. */
export function clock12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const hour = ((h + 11) % 12) + 1;
  return `${hour}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
}

/**
 * The engine's real logic for one signal direction, drawn as a flow so it can
 * be read alongside flows you design: inside market hours -> close the
 * opposite side if held -> open the wanted side unless already held.
 * "Already holding the wanted side?" counts as many positions as the bot's per-type limit allows (`perTypeLimit`), so it
 * reads the same as the check the engine runs. (Duplicate protection, the position/daily/allocation limits, the strike
 * checks and the error failsafe apply on top of this and aren't drawn, as in Option Alpha, where they are bot-level safeguards.)
 */
export function builtInFlow(direction: "bullish" | "bearish", cfg: BotStaticConfig | null, window?: FlowWindow, perTypeLimit = 1): Step[] {
  const wanted = direction === "bullish" ? "put" : "call";
  const opposite = wanted === "put" ? "call" : "put";
  const offset = cfg ? (wanted === "put" ? cfg.putShortOffset : cfg.callShortOffset) : 0;

  const open = newStep("open_position");
  open.config = {
    ...open.config,
    type: TYPE_KEY[wanted],
    symbol: cfg?.underlying ?? "SPX",
    short_off: Math.abs(offset).toFixed(2),
    short_dir: offset < 0 ? "below" : "above",
    long_off: (cfg?.widthPoints ?? 5).toFixed(2),
    long_dir: wanted === "put" ? "below" : "above",
    size: String(cfg?.quantity ?? 3),
    price: cfg ? `Limit credit $${cfg.openingCreditEstimate.toFixed(2)} (${cfg.openPricePercent ?? 100}% of bid/ask)` : "Limit credit",
  };

  /** "Already holding the wanted side? yes: do nothing. no: open it." Each use gets fresh step ids. */
  const holdsWanted = (): Step => ({ ...newStep("decision", [holds(wanted, perTypeLimit)]), yes: [], no: [cloneStep(open)] });

  const timeCondition = newCondition("bot_time");
  if (window) timeCondition.values = { ...timeCondition.values, from: clock12(window.start), to: clock12(window.end) };
  const hours = newStep("decision", [timeCondition]);
  const hasOpposite = newStep("decision", [holds(opposite)]);
  const close = newStep("close_position");
  close.config = { ...close.config, type: TYPE_KEY[opposite], symbol: cfg?.underlying ?? "SPX", price: `${cfg?.closePricePercent ?? 100}% of bid/ask, waits for the fill`, qty: "100% of position" };

  let steps: Step[] = [hours];
  steps = appendStep(steps, hours.id, "yes", hasOpposite);
  steps = appendStep(steps, hasOpposite.id, "yes", close);
  steps = appendStep(steps, hasOpposite.id, "yes", holdsWanted());
  steps = appendStep(steps, hasOpposite.id, "no", holdsWanted());
  return steps;
}

export type MonitorDirection = "bullish" | "bearish";

/**
 * A Close Monitor drawn as a flow, like Option Alpha's "BullishSpx Close Monitor": the position check, then (our safety
 * addition) "the latest confirmed signal is bullish", then Close Position. The second check is what stops it closing the
 * position a signal has just opened - without it a monitor would fight the flip.
 */
export function monitorFlow(direction: MonitorDirection, cfg: BotStaticConfig | null): Step[] {
  const wrong = direction === "bullish" ? "call" : "put";
  const hasWrong = newStep("decision", [holds(wrong)]);
  const latest = newCondition("bot_latest_signal");
  const confirmed = newStep("decision", [{ ...latest, values: { ...latest.values, signal: direction } }]);
  const close = newStep("close_position");
  close.config = { ...close.config, type: TYPE_KEY[wrong], symbol: cfg?.underlying ?? "NDX", price: `${cfg?.closePricePercent ?? 100}% of bid/ask, waits for the fill`, qty: "100% of position" };

  let steps: Step[] = [hasWrong];
  steps = appendStep(steps, hasWrong.id, "yes", confirmed);
  steps = appendStep(steps, confirmed.id, "yes", close);
  return steps;
}
