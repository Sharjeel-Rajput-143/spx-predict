/**
 * The line under a test button, and keeping it true. A test alert is answered after at most 45 seconds, but the order it places can take
 * about 2.5 minutes to finish (up to 4 prices, 10 seconds each, then 2 minutes at the last). Until it does, the line says what is going on,
 * and it is rewritten by itself when the run ends.
 */
export interface TestDecision {
  outcome: string;
  reason?: string;
}

export const WAITING_NOTE = "waiting for the order: the bot tries up to 4 prices over about 2½ minutes, and this line updates by itself when it ends";

/** "bullish test alert at 21,000 → opened" or "... → (nothing decided yet) - waiting for the order: ..." */
export function testLine(head: string, decisions: TestDecision[], finished: boolean): string {
  const steps = decisions.map((d) => d.outcome).join(" → ") || "no decision yet";
  return finished ? `${head} → ${steps}` : `${head} → ${steps} (${WAITING_NOTE})`;
}

type Fetcher = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * Asks how the run is getting on every few seconds, calling `onUpdate` with each new line, until it has finished or `maxMs` has passed.
 * Returns a function that stops it (for when the screen goes away). Never throws.
 */
export function watchTestRun(
  signalId: string,
  head: string,
  onUpdate: (line: string, finished: boolean) => void,
  options: { everyMs?: number; maxMs?: number; fetcher?: Fetcher } = {},
): () => void {
  const { everyMs = 3000, maxMs = 5 * 60_000 } = options;
  const fetcher: Fetcher = options.fetcher ?? ((u) => fetch(u, { cache: "no-store" }));
  let stopped = false;
  const started = Date.now();
  const tick = async () => {
    if (stopped) return;
    try {
      const res = await fetcher(`/api/automation/test/run?signalId=${encodeURIComponent(signalId)}`);
      if (res.ok) {
        const j = (await res.json()) as { finished?: boolean; decisions?: TestDecision[] };
        const finished = j.finished === true;
        if (!stopped) onUpdate(testLine(head, j.decisions ?? [], finished), finished);
        if (finished) return;
      }
    } catch {
      /* the next look tries again */
    }
    if (stopped) return;
    if (Date.now() - started >= maxMs) {
      onUpdate(`${head} → no answer yet after ${Math.round(maxMs / 60_000)} minutes: open the bot's Log to see how it ended`, true);
      return;
    }
    setTimeout(tick, everyMs);
  };
  setTimeout(tick, everyMs);
  return () => {
    stopped = true;
  };
}
