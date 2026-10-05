import type { BotStaticConfig } from "@/lib/automation/types";
import { appendStep, cloneStep, newCondition, newStep, type Condition, type Step } from "./model";

const TYPE_NAME = { put: "Short put spread", call: "Short call spread" } as const;
const TYPE_KEY = { put: "short_put_spread", call: "short_call_spread" } as const;

const holds = (type: "put" | "call"): Condition => {
  const c = newCondition("bot_has_type");
  return { ...c, values: { ...c.values, type: TYPE_NAME[type] } };
};

/**
 * The engine's real logic for one signal direction, drawn as a flow so it can
 * be read alongside flows you design: inside market hours -> close the
 * opposite side if held -> open the wanted side unless already held.
 * (Duplicate protection, the position/daily/allocation limits, the strike
 * checks and the error failsafe apply on top of this and aren't drawn.)
 */
export function builtInFlow(direction: "bullish" | "bearish", cfg: BotStaticConfig | null): Step[] {
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
    price: cfg ? `Limit credit $${cfg.openingCreditEstimate.toFixed(2)}` : "Limit credit",
  };

  /** "Already holding the wanted side? yes: do nothing. no: open it." Each use gets fresh step ids. */
  const holdsWanted = (): Step => ({ ...newStep("decision", [holds(wanted)]), yes: [], no: [cloneStep(open)] });

  const hours = newStep("decision", [newCondition("bot_time")]);
  const hasOpposite = newStep("decision", [holds(opposite)]);
  const close = newStep("close_position");
  close.config = { ...close.config, type: TYPE_KEY[opposite], price: "Limit order, waits for the fill", qty: "100% of position" };

  let steps: Step[] = [hours];
  steps = appendStep(steps, hours.id, "yes", hasOpposite);
  steps = appendStep(steps, hasOpposite.id, "yes", close);
  steps = appendStep(steps, hasOpposite.id, "yes", holdsWanted());
  steps = appendStep(steps, hasOpposite.id, "no", holdsWanted());
  return steps;
}
