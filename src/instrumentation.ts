/** Runs once when the server starts. The end-of-day sweep and the crash recovery live in a timer inside
 * this process, so they must start at boot - not wait for the first webhook (a restart at 4pm, with no
 * alert since, would otherwise skip the sweep). Not on Vercel: a serverless function has no process that
 * stays up for a timer (see docs/deploying.md). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.VERCEL) return;
  const { startEodScheduler } = await import("@/lib/automation/eodSweep");
  startEodScheduler();
}
