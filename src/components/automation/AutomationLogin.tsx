/** Password form. `compact` drops the page-level spacing so it can sit in a modal. */
export function AutomationLogin({ next, error, compact }: { next: string; error?: boolean; compact?: boolean }) {
  return (
    <div className={compact ? "space-y-4" : "mx-auto max-w-sm space-y-4 py-16"}>
      <div>
        <h1 className="text-lg font-semibold">Sign in</h1>
        <p className="mt-1 text-sm text-muted">Password-protected - this controls a trading bot.</p>
      </div>
      <form action="/api/automation/status/login" method="POST" className="space-y-3">
        <input type="hidden" name="next" value={next} />
        <input
          type="password"
          name="password"
          placeholder="Password"
          autoFocus
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-fg"
        />
        <button type="submit" className="w-full rounded-lg bg-fg px-3 py-2 text-sm font-medium text-bg">
          Sign in
        </button>
        {error && <p className="text-xs text-down">Wrong password.</p>}
      </form>
    </div>
  );
}
