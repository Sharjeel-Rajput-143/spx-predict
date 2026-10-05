"use client";

import { useEffect, useState } from "react";
import { AutomationLogin } from "@/components/automation/AutomationLogin";
import { ConnectionsPanel } from "@/components/automations/ConnectionsPanel";
import { Card, SectionTitle } from "@/components/ui";

type Bots = { id: string; name: string }[];

/** Settings > Webhook: where signals come in (TradingView -> our bots) and
 * where rule alerts go out (connections). */
export function WebhookSettings() {
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">Webhook</h2>
          <p className="mt-1 text-sm text-muted">Incoming signals for the bots, and outgoing connections for rule alerts.</p>
        </div>
        <IncomingWebhook />
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Outgoing connections</h3>
        <ConnectionsPanel />
      </section>
    </div>
  );
}

function IncomingWebhook() {
  const [bots, setBots] = useState<Bots | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
    fetch("/api/automation/status").then(async (r) => {
      if (r.status === 401) return setSignedOut(true);
      const json = await r.json();
      setBots(json.bots);
    });
  }, []);

  if (signedOut) return <AutomationLogin next="/settings" />;

  const botId = bots?.[0]?.id ?? "spx_ema_bias";
  const example = JSON.stringify(
    {
      secret: "<WEBHOOK_SECRET>",
      bot: botId,
      signal: "bullish",
      symbol: "SPX",
      price: "{{close}}",
      bar_time: "{{timenow}}",
      interval: "{{interval}}",
    },
    null,
    2,
  ).replace('"{{close}}"', "{{close}}");

  return (
    <Card className="space-y-4 p-4">
      <SectionTitle>Incoming - TradingView signals</SectionTitle>

      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-muted">URL</div>
        <code className="mt-1 block break-all rounded-lg bg-surface-2 px-3 py-2 text-sm">
          POST {origin}/api/webhook/tradingview
        </code>
      </div>

      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-muted">Message body</div>
        <pre className="mt-1 overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs leading-relaxed">{example}</pre>
        <p className="mt-2 text-xs text-muted">
          TradingView can&apos;t send custom headers, so the secret travels in the body. <code>signal</code> is{" "}
          <code>bullish</code> or <code>bearish</code>. Set <code>WEBHOOK_SECRET</code> in <code>.env.local</code> - the secret is
          never shown here.
        </p>
      </div>

      <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-500">
        Wire only the two <strong>confirmed</strong> alerts (bullish and bearish) to this URL - never the raw EMA cross alerts. The
        engine drops duplicates, but wiring both is how you get two entries on every flip.
      </div>

      {bots && (
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-muted">Bots that accept signals</div>
          <ul className="mt-1 text-sm">
            {bots.map((b) => (
              <li key={b.id}>
                {b.name} <code className="text-faint">{b.id}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
