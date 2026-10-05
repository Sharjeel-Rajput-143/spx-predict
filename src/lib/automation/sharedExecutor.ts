import "server-only";
import { MockExecutor } from "./executor";

/** The one executor instance the running process uses - Phase 2 swaps this
 * for a real IBKR-backed BrokerExecutor behind the same interface.
 * AUTOMATION_MOCK_PRICING=simulated makes the mock report made-up close
 * prices so the P/L screens can be exercised; leave it unset otherwise. */
export const MOCK_PRICING_SIMULATED = process.env.AUTOMATION_MOCK_PRICING === "simulated";

export const sharedExecutor = new MockExecutor({ simulatePricing: MOCK_PRICING_SIMULATED });
