"use client";

import { useState } from "react";
import { WebhookSettings } from "@/components/automations/WebhookSettings";
import { cn } from "@/lib/format";

const SECTIONS = [{ key: "webhook", label: "Webhook" }] as const;

/** Settings, with a section list on the left (Webhook for now). */
export function SettingsView() {
  const [section, setSection] = useState<(typeof SECTIONS)[number]["key"]>("webhook");

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
              className={cn(
                "rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors",
                section === s.key ? "bg-accent/10 text-accent" : "text-muted hover:bg-surface-2 hover:text-fg",
              )}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0">{section === "webhook" && <WebhookSettings />}</div>
      </div>
    </div>
  );
}
