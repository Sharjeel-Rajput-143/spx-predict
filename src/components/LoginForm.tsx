"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { APP_NAME } from "@/lib/config";

const HIGHLIGHTS: { title: string; text: string; icon: ReactNode }[] = [
  {
    title: "TradingView in, trades out",
    text: "A bullish or bearish alert calls your webhook and the bot does the rest.",
    icon: <path d="M3 17l5-5 4 4 8-9M15 7h5v5" />,
  },
  {
    title: "Practice first",
    text: "Testing mode and the mock executor run by default. Nothing real until you say so.",
    icon: <path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6l8-3zM9 12l2 2 4-4" />,
  },
  {
    title: "Every decision logged",
    text: "See why each signal opened, closed or was skipped.",
    icon: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  },
];

const Icon = ({ children, className = "h-5 w-5" }: { children: ReactNode; className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    {children}
  </svg>
);

const Spinner = () => <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />;

/** The brand panel on the left (hidden on a phone): what the app is, in three lines. */
function BrandPanel() {
  return (
    <aside className="relative hidden overflow-hidden bg-[#0b1226] p-12 text-white lg:flex lg:flex-col lg:justify-between">
      <div className="pointer-events-none absolute -left-24 -top-24 h-96 w-96 rounded-full bg-accent/40 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 -right-16 h-96 w-96 rounded-full bg-up/25 blur-3xl" />

      <div className="relative flex items-center gap-3 text-lg font-semibold tracking-tight">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-white/10 ring-1 ring-white/20">
          <Icon>
            <path d="M3 17l5-5 4 4 8-9M15 7h5v5" />
          </Icon>
        </span>
        {APP_NAME}
      </div>

      <div className="relative max-w-md space-y-8">
        <div className="space-y-3">
          <h2 className="text-4xl font-semibold leading-tight tracking-tight">Your signals, run with guard rails.</h2>
          <p className="text-base text-white/70">An automation desk for your NDX bias bot: clear status, clear limits, and a kill switch within reach.</p>
        </div>
        <ul className="space-y-5">
          {HIGHLIGHTS.map((h) => (
            <li key={h.title} className="flex gap-4">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/10 ring-1 ring-white/15">
                <Icon>{h.icon}</Icon>
              </span>
              <div>
                <p className="font-medium">{h.title}</p>
                <p className="text-sm text-white/65">{h.text}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <p className="relative text-xs text-white/50">Paper trading and testing only until you decide otherwise.</p>
    </aside>
  );
}

/** The sign-in page: a brand panel and the form side by side on a wide screen, the form alone on a phone. Email and
 * password go to /api/login; on success the browser goes to the page it came for. */
export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, next }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? "Couldn't sign in.");
        setBusy(false);
        return;
      }
      window.location.assign(json.next ?? "/automations");
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
      setBusy(false);
    }
  };

  const field = "w-full rounded-xl border bg-surface px-4 py-3 text-sm outline-none transition-colors placeholder:text-faint focus:border-accent focus:ring-4 focus:ring-accent/15";
  const border = error ? "border-down" : "border-line";

  return (
    <main className="grid min-h-dvh bg-bg lg:grid-cols-2">
      <BrandPanel />

      <section className="flex items-center justify-center px-5 py-10 sm:px-10">
        <div className="w-full max-w-md space-y-8">
          {/* On a phone the brand panel is gone, so the name sits above the form. */}
          <div className="flex items-center gap-3 text-lg font-semibold tracking-tight lg:hidden">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent text-white">
              <Icon>
                <path d="M3 17l5-5 4 4 8-9M15 7h5v5" />
              </Icon>
            </span>
            {APP_NAME}
          </div>

          <div className="space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight">Welcome back</h1>
            <p className="text-sm text-muted">Sign in to open your automation desk.</p>
          </div>

          <form onSubmit={submit} className="space-y-5" aria-label="Sign in" noValidate>
            <div className="space-y-2">
              <label htmlFor="login-email" className="text-sm font-medium">
                Email
              </label>
              <input
                id="login-email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="username"
                autoFocus
                required
                placeholder="you@example.com"
                className={`${field} ${border}`}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={Boolean(error)}
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="login-password" className="text-sm font-medium">
                Password
              </label>
              <div className="relative">
                <input
                  id="login-password"
                  name="password"
                  type={show ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  placeholder="Enter your password"
                  className={`${field} ${border} pr-12`}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={Boolean(error)}
                />
                <button
                  type="button"
                  onClick={() => setShow((s) => !s)}
                  aria-label={show ? "Hide password" : "Show password"}
                  aria-pressed={show}
                  className="absolute inset-y-0 right-0 grid w-12 place-items-center rounded-r-xl text-muted hover:text-fg"
                >
                  <Icon className="h-[18px] w-[18px]">
                    {show ? (
                      <>
                        <path d="M3 3l18 18M10.6 6.2A9.8 9.8 0 0 1 12 6c5 0 8.5 4 9.5 6a14 14 0 0 1-2.6 3.4M6.5 7.5C4.4 8.9 3 11 2.5 12c1 2 4.5 6 9.5 6 1.4 0 2.7-.3 3.8-.8" />
                        <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
                      </>
                    ) : (
                      <>
                        <path d="M2.5 12C3.5 10 7 6 12 6s8.5 4 9.5 6c-1 2-4.5 6-9.5 6s-8.5-4-9.5-6z" />
                        <circle cx="12" cy="12" r="3" />
                      </>
                    )}
                  </Icon>
                </button>
              </div>
            </div>

            {error && (
              <p role="alert" className="flex items-start gap-2 rounded-xl bg-down-soft px-4 py-3 text-sm text-down">
                <Icon className="mt-0.5 h-4 w-4 shrink-0">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v5M12 16h.01" />
                </Icon>
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy || !email || !password}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <>
                  <Spinner /> Signing in...
                </>
              ) : (
                "Sign in"
              )}
            </button>
          </form>

          <p className="text-center text-xs text-faint">Trouble signing in? The login is set by whoever runs this server.</p>
        </div>
      </section>
    </main>
  );
}
