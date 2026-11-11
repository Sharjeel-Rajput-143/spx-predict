import { LIVE_BOT_ID } from "./bybitLiveLimits";

/**
 * THE LIVE BOT IS NEVER "RUN" BY HAND FROM A BOT PAGE. The generic Run buttons ("Run now", "Run this trigger now", "Run automation") send a signal for a bot as if TradingView had sent it. For the live
 * bot that would open a real-money trade with no "Are you sure?" click, no Manual label and no exclusion from the entry retry. So the live bot is opened only by real signals (the mirror) and by the
 * Open UP / Open DOWN buttons on the Live page (manualOpen.ts). The pages hide the buttons for it, and the Run route refuses it on the server with this sentence. The demo bot is unchanged.
 */
export const canRunByHand = (botId: string): boolean => botId !== LIVE_BOT_ID;

export const LIVE_RUN_REFUSAL = "The live bot cannot be run by hand from this page. It is opened only by real TradingView signals and by the Open UP and Open DOWN buttons on the Live page.";
