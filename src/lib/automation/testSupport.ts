import { __resetAllStores } from "./store";
import { easternDateKey } from "./tradingHours";
import type { Position, PositionStatus, PositionType } from "./types";

export const TEST_BOT_ID = "spx_ema_bias";

/** A Tuesday, 10:40am America/New_York (EDT) - safely inside the default
 * trading window, verified against Intl rather than hand-computed offsets. */
export const BASE_NOW = Date.UTC(2026, 9, 6, 14, 40);

/** The bot's required-with-no-default env vars, set to concrete test values
 * so getBotStaticConfig("spx_ema_bias") doesn't throw. Call once per test file. */
export function setTestBotEnv(): void {
  process.env.BOT_SPX_EMA_BIAS_PUT_SHORT_OFFSET = "-20";
  process.env.BOT_SPX_EMA_BIAS_CALL_SHORT_OFFSET = "20";
  process.env.BOT_SPX_EMA_BIAS_QUANTITY = "3";
  process.env.BOT_SPX_EMA_BIAS_WIDTH_POINTS = "5";
  process.env.BOT_SPX_EMA_BIAS_STRIKE_INCREMENT = "5";
  process.env.BOT_SPX_EMA_BIAS_ALLOCATION_LIMIT = "20000";
  process.env.BOT_SPX_EMA_BIAS_OPENING_CREDIT_ESTIMATE = "2.2";
  process.env.BOT_SPX_EMA_BIAS_ACCOUNT_ID = "test-account";
}

export const NDX_BOT_ID = "ndx_ema_bias";

/** The NDX bot's required-with-no-default settings, set to concrete test
 * values. These are test numbers only - the real ones come from Blue. */
export function setNdxTestEnv(): void {
  process.env.BOT_NDX_EMA_BIAS_STRIKE_INCREMENT = "5";
  process.env.BOT_NDX_EMA_BIAS_PUT_SHORT_OFFSET = "-30";
  process.env.BOT_NDX_EMA_BIAS_CALL_SHORT_OFFSET = "30";
  process.env.BOT_NDX_EMA_BIAS_OPENING_CREDIT_ESTIMATE = "3.5";
  process.env.BOT_NDX_EMA_BIAS_PRICE_MIN = "15000";
  process.env.BOT_NDX_EMA_BIAS_PRICE_MAX = "30000";
  process.env.BOT_NDX_EMA_BIAS_EOD_SWEEP_TIME = "16:15";
}

export function resetAutomationStores(): void {
  __resetAllStores();
}

/** Minimal, valid Position row for tests that need to seed existing state
 * directly rather than driving it through a full signal. */
export function buildPosition(overrides: Partial<Position> & { type: PositionType; status: PositionStatus }): Position {
  return {
    id: `pos-test-${Math.random().toString(36).slice(2)}`,
    botId: TEST_BOT_ID,
    underlying: "SPX",
    shortStrike: 7700,
    longStrike: 7695,
    requestedQuantity: 3,
    filledQuantity: 3,
    expiry: easternDateKey(BASE_NOW),
    credit: 2.2,
    openedAt: BASE_NOW,
    closedAt: null,
    openSignalId: null,
    closeSignalId: null,
    brokerOrderRef: null,
    ...overrides,
  };
}
