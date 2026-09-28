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

function logAttempt(job: DeliveryJob, statusCode: number | null, success: boolean, error?: string, isTest = false) {
  triggerLogStore.insert({
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ruleId: job.ruleId,
    firedAt: Date.now(),
    payload: JSON.stringify(job.payload),
    statusCode,
    success,
    error,
    attempt: job.attempt,
    isTest,
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

interface PostResult {
  statusCode: number | null;
  success: boolean;
  error?: string;
  /** false when the URL itself is the problem (SSRF guard) - retrying
   * against the same unsafe URL would never help. */
  retryable: boolean;
}

async function postOnce(url: string, payload: Record<string, unknown>): Promise<PostResult> {
  // Re-checked at delivery time, not just at save time - a URL that was
  // safe when saved could now resolve differently.
  const safety = await isSafeWebhookUrl(url);
  if (!safety.ok) return { statusCode: null, success: false, error: safety.reason, retryable: false };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // Never blindly follow a redirect to a different, unvetted host (spec 5.3).
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const success = res.status >= 200 && res.status < 300;
    return { statusCode: res.status, success, retryable: !success };
  } catch (err) {
    return { statusCode: null, success: false, error: err instanceof Error ? err.message : "Unknown error", retryable: true };
  }
}

async function attemptDelivery(job: DeliveryJob) {
  const result = await postOnce(job.url, job.payload);
  logAttempt(job, result.statusCode, result.success, result.error);
  if (!result.success && result.retryable) scheduleRetry(job);
}

/** Manual "Send Test": a single attempt, no retry, logged and reported back
 * to the caller synchronously so the UI can show success/failure right away. */
export async function sendTestWebhook(job: { ruleId: string; url: string; payload: Record<string, unknown> }) {
  const result = await postOnce(job.url, job.payload);
  logAttempt({ ...job, attempt: 1 }, result.statusCode, result.success, result.error, true);
  return { ok: result.success, statusCode: result.statusCode, error: result.error };
}
