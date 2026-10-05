import { cookies } from "next/headers";
import { isValidSession, SESSION_COOKIE_NAME } from "@/lib/automation/session";
import { StatusDashboard } from "@/components/automation/StatusDashboard";

export default async function AutomationStatusPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ error }, cookieStore] = await Promise.all([searchParams, cookies()]);
  const authed = isValidSession(cookieStore.get(SESSION_COOKIE_NAME)?.value);

  if (!authed) {
    return (
      <div className="mx-auto max-w-sm space-y-4 py-16">
        <div>
          <h1 className="text-lg font-semibold">Automation status</h1>
          <p className="mt-1 text-sm text-muted">Password-protected - this controls a live trading bot.</p>
        </div>
        <form action="/api/automation/status/login" method="POST" className="space-y-3">
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

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Automation status</h1>
        <p className="mt-1 text-sm text-muted">Signal automation engine - kill switch, positions, decisions and signals.</p>
      </div>
      <StatusDashboard />
    </div>
  );
}
