"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/format";
import { testLine } from "./testRun";
import { AccountsSection, ArchiveSection, GeneralSection, WebhooksSection, type ArchivedBot, type BrokerView, type SettingsData, type SavePatch, type WebhookView } from "./settings/sections";

const SECTIONS = [
  { key: "general", label: "General" },
  { key: "accounts", label: "Trading Accounts" },
  { key: "archive", label: "Bot Archive" },
  { key: "webhooks", label: "Webhooks" },
] as const;
type SectionKey = (typeof SECTIONS)[number]["key"];

/** Settings, with a section list on the left. General opens first, so the outbound Option Alpha feature isn't loaded unless asked for. */
export function SettingsView() {
  const [section, setSection] = useState<SectionKey>("general");
  const [data, setData] = useState<SettingsData | null>(null);
  const [archived, setArchived] = useState<ArchivedBot[]>([]);
  const [hooks, setHooks] = useState<WebhookView[]>([]);
  const [broker, setBroker] = useState<BrokerView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/automation/settings")
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 401 ? "Sign in on the Automation page first." : "Couldn't load the settings.");
        return r.json();
      })
      .then((json: SettingsData) => {
        setData(json);
        setError(null);
      })
      .catch((err) => setError(err.message));
    fetch("/api/automation/bots")
      .then((r) => (r.ok ? r.json() : { bots: [] }))
      .then((json: { bots: (ArchivedBot & { archived: boolean })[] }) => setArchived(json.bots.filter((b) => b.archived)))
      .catch(() => undefined);
    fetch("/api/automation/webhooks")
      .then((r) => (r.ok ? r.json() : { webhooks: [] }))
      .then((json: { webhooks: WebhookView[] }) => setHooks(json.webhooks))
      .catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  /** Saves part of the settings; returns the server's message when it was refused. */
  const save = async (patch: SavePatch): Promise<string | null> => {
    const res = await fetch("/api/automation/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return json.error ?? "Couldn't save.";
    setData(json as SettingsData);
    return null;
  };

  const loadBroker = useCallback(() => {
    setBroker(null);
    fetch("/api/automation/broker")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: BrokerView | null) => setBroker(j))
      .catch(() => undefined);
  }, []);
  // Only when the Accounts section is open (and a broker is in use): a read of the account's balances.
  useEffect(() => {
    if (section === "accounts" && data?.executor.venue === "tradier") loadBroker();
  }, [section, data?.executor.venue, loadBroker]);

  const createHook = async (name: string): Promise<string | null> => {
    const res = await fetch("/api/automation/webhooks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return json.error ?? "Couldn't create it.";
    load();
    return null;
  };

  const botAction = (id: string, init: RequestInit) => fetch(`/api/automation/bots/${id}`, init).then(load);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Settings</h1>
      <div className="grid gap-6 md:grid-cols-[180px_1fr]">
        <nav className="flex gap-1 overflow-x-auto [scrollbar-width:none] md:flex-col md:overflow-visible" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              onClick={() => setSection(s.key)}
              aria-current={section === s.key ? "page" : undefined}
              className={cn("rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors", section === s.key ? "bg-accent/10 text-accent" : "text-muted hover:bg-surface-2 hover:text-fg")}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0">
          {error && <p className="rounded-lg bg-down-soft px-3 py-2 text-sm text-down">{error}</p>}
          {!error && !data && <p className="text-sm text-muted">Loading...</p>}
          {data && section === "general" && <GeneralSection data={data} save={save} />}
          {data && section === "accounts" && <AccountsSection data={data} broker={broker} onRefresh={loadBroker} />}
          {section === "archive" && (
            <ArchiveSection
              bots={archived}
              onRestore={(id) => botAction(id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived: false }) })}
              onDelete={(id) => botAction(id, { method: "DELETE" })}
            />
          )}
          {data && section === "webhooks" && (
            <WebhooksSection
              data={data}
              origin={typeof window === "undefined" ? "" : window.location.origin}
              hooks={hooks}
              onCreate={createHook}
              onToggle={(id, active) => fetch(`/api/automation/webhooks/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active }) }).then(load)}
              onRequireText={(id, requireDirectionText) => fetch(`/api/automation/webhooks/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requireDirectionText }) }).then(load)}
              onDelete={(id) => fetch(`/api/automation/webhooks/${id}`, { method: "DELETE" }).then(load)}
              onRename={async (id, name) => {
                const res = await fetch(`/api/automation/webhooks/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
                const json = await res.json().catch(() => ({}));
                load();
                return res.ok ? null : (json.error ?? "Couldn't rename it.");
              }}
              canTest={data.executor.venue === "mock" || ((data.executor.venue === "tradier" || data.executor.venue === "ibkr" || data.executor.venue === "deriv" || data.executor.venue === "bybit") && data.executor.sandbox === true)}
              onTest={async (id) => {
                const res = await fetch(`/api/automation/webhooks/${id}/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
                const j = await res.json().catch(() => ({}));
                if (!res.ok) return `Not sent: ${j.error ?? res.status}`;
                const line = testLine(`Sent at ${Number(j.price).toLocaleString("en-US")} (live quote)`, j.decisions ?? [], j.finished === true);
                return `${line}. ${j.finished ? "" : "Open the bot's Log to see how it ends. "}See the Automation status page for the order.`;
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
