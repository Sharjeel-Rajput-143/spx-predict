"use client";

import { useCallback, useEffect, useState } from "react";
import { WebhookSettings } from "@/components/automations/WebhookSettings";
import { cn } from "@/lib/format";
import { AccountsSection, ArchiveSection, GeneralSection, OutboundGate, WebhooksSection, type ArchivedBot, type SettingsData, type SavePatch, type WebhookView } from "./settings/sections";

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
  const [error, setError] = useState<string | null>(null);
  const [showOutbound, setShowOutbound] = useState(false);

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

  const createHook = async (name: string, botId: string, direction: "bullish" | "bearish"): Promise<string | null> => {
    const res = await fetch("/api/automation/webhooks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, botId, direction }) });
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
        <nav className="flex gap-1 md:flex-col" aria-label="Settings sections">
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
          {data && section === "accounts" && <AccountsSection data={data} />}
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
              onDelete={(id) => fetch(`/api/automation/webhooks/${id}`, { method: "DELETE" }).then(load)}
              outbound={
                <OutboundGate shown={showOutbound} onShow={() => setShowOutbound(true)}>
                  <WebhookSettings />
                </OutboundGate>
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
