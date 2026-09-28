"use client";

import { useState } from "react";

type TestOutcome = { ok: boolean; message: string };

/** Manually fires a rule's webhook once - against mock data or the last
 * known live price, independent of the app's global data-source mode - so
 * a rule can be validated at 2am or on a weekend before ever trusting it live. */
export function TestAlertButton({ ruleId }: { ruleId: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);

  const send = async (source: "mock" | "live") => {
    setMenuOpen(false);
    setSending(true);
    setOutcome(null);
    try {
      const res = await fetch(`/api/automations/rules/${ruleId}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      });
      const data = await res.json();
      if (!res.ok) {
        setOutcome({ ok: false, message: data.error ?? "Test failed." });
      } else if (data.ok) {
        setOutcome({ ok: true, message: `Delivered (${data.statusCode}) using ${data.source} data.` });
      } else {
        setOutcome({ ok: false, message: data.error ?? `Webhook returned ${data.statusCode ?? "an error"}.` });
      }
    } catch {
      setOutcome({ ok: false, message: "Could not reach the server." });
    } finally {
      setSending(false);
      setTimeout(() => setOutcome(null), 6000);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setMenuOpen((v) => !v)}
        disabled={sending}
        className="text-xs font-medium text-muted hover:text-fg disabled:opacity-50"
      >
        {sending ? "Sending..." : "Send Test"}
      </button>

      {menuOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-40 overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
            <button
              onClick={() => send("mock")}
              className="block w-full px-3 py-2 text-left text-xs hover:bg-surface-2"
            >
              Test with mock data
            </button>
            <button
              onClick={() => send("live")}
              className="block w-full border-t border-line px-3 py-2 text-left text-xs hover:bg-surface-2"
            >
              Test with live price
            </button>
          </div>
        </>
      )}

      {outcome && (
        <div
          className={
            "absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border px-2.5 py-1.5 text-xs " +
            (outcome.ok ? "border-up/30 bg-up-soft text-up" : "border-down/30 bg-down-soft text-down")
          }
        >
          {outcome.message}
        </div>
      )}
    </div>
  );
}
