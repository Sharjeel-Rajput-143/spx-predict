/**
 * The optional pre-conditions an Open Position step can require before it
 * trades, in two groups (Entry Criteria and Position Criteria). Each is a
 * checkbox sentence with inline values. They are part of a saved design - the
 * signal engine has its own fixed guards and does not read these.
 */
export type CritPiece = { t: "text"; v: string } | { t: "input"; k: string; ph: string };

export interface Criterion {
  id: string;
  pieces: CritPiece[];
  tip?: string;
}

const t = (v: string): CritPiece => ({ t: "text", v });
const i = (k: string, ph: string): CritPiece => ({ t: "input", k, ph });
const range = (min = "Min", max = "Max"): CritPiece[] => [i("min", min), t(" - "), i("max", max)];

export const ENTRY_CRITERIA: Criterion[] = [
  { id: "capital", pieces: [t("Bot has enough available capital")], tip: "Skip the trade when the bot's allocation can't cover its maximum loss." },
  { id: "open_lt", pieces: [t("Bot has less than "), i("n", "1"), t(" open position(s)")] },
  { id: "new_today", pieces: [t("Bot opened less than "), i("n", "1"), t(" new position(s) today")] },
  { id: "symbol_lt", pieces: [t("Bot has less than "), i("n", "1"), t(" open position(s) with symbol")] },
  { id: "identical_leg", pieces: [t("Bot doesn't have a position with an identical leg")], tip: "Avoids opening a leg that duplicates one already held (the same strike, type and expiry)." },
  { id: "vix", pieces: [t("VIX is between "), ...range()] },
  { id: "ivr", pieces: [t("IV Rank is between "), ...range()] },
];

export const POSITION_CRITERIA: Criterion[] = [
  { id: "bidask", pieces: [t("Bid/ask spread is less than $"), i("v", "0.00")], tip: "A wide bid/ask spread means a poor fill." },
  { id: "mid", pieces: [t("Mid price is between $"), ...range()] },
  { id: "width", pieces: [t("Spread width is between "), ...range()] },
  { id: "otm", pieces: [t("OTM % is greater than "), i("v", "0"), t("%")], tip: "How far the short strike is out of the money." },
  { id: "earnings", pieces: [t("Expires before next earnings report")] },
  { id: "fomc", pieces: [t("Expires before next FOMC meeting")] },
  { id: "exdiv", pieces: [t("Expires before next ex-dividend date")] },
  { id: "alpha", pieces: [t("Alpha is greater than "), i("v", "0"), t("%")], tip: "Edge versus the market's own pricing of the trade." },
  { id: "ev", pieces: [t("EV per contract greater than $"), i("v", "0")], tip: "Expected value per contract." },
  { id: "rr", pieces: [t("Reward/risk ratio between "), i("min", "Min"), t("% - "), i("max", "Max"), t("%")] },
  { id: "rr_pop", pieces: [t("Reward/risk ratio favorable for probability of max profit")], tip: "Requires the payoff to be worth the odds of keeping the full credit." },
  { id: "pop", pieces: [t("Probability of profit greater than "), i("v", "0"), t("%")] },
  { id: "pomp", pieces: [t("Probability of max profit greater than "), i("v", "0"), t("%")] },
  { id: "pomloss", pieces: [t("Probability of max loss less than "), i("v", "0"), t("%")] },
  { id: "maxprofit", pieces: [t("Max profit per contract greater than $"), i("v", "0")] },
  { id: "maxloss", pieces: [t("Max loss per contract less than $"), i("v", "0")] },
];

export const critKey = (id: string) => `crit:${id}`;
export const critValueKey = (id: string, k: string) => `crit:${id}:${k}`;

/** Which criteria are switched on in a step's config. */
export function enabledCriteria(config: Record<string, string>, list: Criterion[]): Criterion[] {
  return list.filter((c) => config[critKey(c.id)] === "1");
}
