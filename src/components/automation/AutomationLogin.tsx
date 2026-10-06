"use client";

import { useEffect, useState } from "react";

export interface SessionInfo {
  authRequired: boolean;
  signedIn: boolean;
  passwordConfigured?: boolean;
  storageProblem?: string | null;
}

/** What to tell the person before they type a password that can never work. */
export function loginNotices(info: SessionInfo | null): { blocked: boolean; messages: string[] } {
  if (!info) return { blocked: false, messages: [] };
  const messages: string[] = [];
  const blocked = info.authRequired && info.passwordConfigured === false;
  if (blocked) {
    messages.push("Sign-in isn't set up on this server: AUTOMATION_STATUS_PASSWORD is not set. Add it in your host's environment variables (on Vercel: Project > Settings > Environment Variables) and redeploy.");
  }
  if (info.storageProblem) {
    messages.push(`This server can't run the engine, even once you can sign in. ${info.storageProblem}`);
  }
  return { blocked, messages };
}

/** Password form. `compact` drops the page-level spacing so it can sit in a modal.
 * `error`: true = wrong password; "config" = this server has no password set at all. */
export function AutomationLogin({ next, error, compact }: { next: string; error?: boolean | "config"; compact?: boolean }) {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  useEffect(() => {
    fetch("/api/automation/session")
      .then((r) => r.json())
      .then(setInfo)
      .catch(() => undefined);
  }, []);
  const { blocked, messages } = loginNotices(info);

  return (
    <div className={compact ? "space-y-4" : "mx-auto max-w-sm space-y-4 py-16"}>
      <div>
        <h1 className="text-lg font-semibold">Sign in</h1>
        <p className="mt-1 text-sm text-muted">Password-protected - this controls a trading bot.</p>
      </div>
      {messages.map((m) => (
        <p key={m} className="rounded-lg bg-down-soft px-3 py-2 text-xs text-down">
          {m}
        </p>
      ))}
      <form action="/api/automation/status/login" method="POST" className="space-y-3">
        <input type="hidden" name="next" value={next} />
        <input
          type="password"
          name="password"
          placeholder="Password"
          autoFocus
          disabled={blocked}
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-fg disabled:opacity-50"
        />
        <button type="submit" disabled={blocked} className="w-full rounded-lg bg-fg px-3 py-2 text-sm font-medium text-bg disabled:opacity-50">
          Sign in
        </button>
        {error === "config" ? (
          <p className="text-xs text-down">Sign-in isn&apos;t set up on this server: AUTOMATION_STATUS_PASSWORD is not set. Set it in the host&apos;s environment settings and redeploy.</p>
        ) : (
          error && <p className="text-xs text-down">Wrong password.</p>
        )}
      </form>
    </div>
  );
}
