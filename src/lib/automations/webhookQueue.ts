import "server-only";
import { isSafeWebhookUrl } from "./urlValidation";
import { triggerLogStore } from "./store";

interface DeliveryJob {
  ruleId: string;
  /** Decrypted URL - lives only in memory for the life of this job, never logged or persisted. */
  url: string;
  payload: Record<string, unknown>;
  attempt: number;
}

/** Immediate, then a couple of backoff retries (spec 4.2). */
const RETRY_DELAYS_MS = [2000, 8000];

const queue: DeliveryJob[] = [];
let processing = false;

export function enqueueDelivery(job: Omit<DeliveryJob, "attempt">) {
  queue.push({ ...job, attempt: 1 });
  void processQueue();
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift()!;
      await attemptDelivery(job);
    }
  } finally {
    processing = false;
  }
}

function logAttempt(job: DeliveryJob, statusCode: number | null, success: boolean, error?: string) {
  triggerLogStore.insert({
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ruleId: job.ruleId,
    firedAt: Date.now(),
    payload: JSON.stringify(job.payload),
    statusCode,
    success,
    error,
    attempt: job.attempt,
  });
}

function scheduleRetry(job: DeliveryJob) {
  if (job.attempt > RETRY_DELAYS_MS.length) return;
  const delay = RETRY_DELAYS_MS[job.attempt - 1];
  setTimeout(() => {
    queue.push({ ...job, attempt: job.attempt + 1 });
    void processQueue();
  }, delay);
}

async function attemptDelivery(job: DeliveryJob) {
  // Re-checked at delivery time, not just at save time - a URL that was
  // safe when saved could now resolve differently.
  const safety = await isSafeWebhookUrl(job.url);
  if (!safety.ok) {
    logAttempt(job, null, false, safety.reason);
    return; // not retryable - the URL itself is the problem
  }

  try {
    const res = await fetch(job.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(job.payload),
      // Never blindly follow a redirect to a different, unvetted host (spec 5.3).
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const success = res.status >= 200 && res.status < 300;
    logAttempt(job, res.status, success);
    if (!success) scheduleRetry(job);
  } catch (err) {
    logAttempt(job, null, false, err instanceof Error ? err.message : "Unknown error");
    scheduleRetry(job);
  }
}
