"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, headerButtonClass } from "@/components/automation/PageHeader";
import { AutomationBuilder } from "@/components/automation/builder/AutomationBuilder";
import type { AutomationDraft } from "@/components/automation/builder/model";
import { blankDraft, deleteDraft, loadLibrary } from "@/components/automation/builder/store";
import { Modal, Pill, buttonClass } from "@/components/automation/bot/primitives";
import { IconFolder, IconPlus, IconSad } from "@/components/icons";
import { Card } from "@/components/ui";

/** Library > Automations: every flow saved from the builder, by folder.
 * Flows live in this browser and aren't connected to the engine (preview). */
export function AutomationLibraryPage() {
  const [drafts, setDrafts] = useState<AutomationDraft[] | null>(null);
  const [bot, setBot] = useState<{ id: string; name: string }>({ id: "spx_ema_bias", name: "SPX EMA 9/20 Bias" });
  const [editing, setEditing] = useState<AutomationDraft | null>(null);
  const [deleting, setDeleting] = useState<AutomationDraft | null>(null);

  const reload = useCallback(() => setDrafts(loadLibrary()), []);
  useEffect(() => {
    reload();
    // Run Test needs a bot to point at; use the first one, if the list is reachable.
    fetch("/api/automation/bots")
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => json?.bots?.[0] && setBot({ id: json.bots[0].id, name: json.bots[0].name }))
      .catch(() => undefined);
  }, [reload]);

  const byFolder = useMemo(() => {
    const map = new Map<string, AutomationDraft[]>();
    for (const d of [...(drafts ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)) map.set(d.folder, [...(map.get(d.folder) ?? []), d]);
    return [...map.entries()];
  }, [drafts]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Automations"
        back={<Link href="/automations" className="text-muted hover:text-fg">← Automation</Link>}
        actions={
          <>
            <Link href="/automations/templates" className={headerButtonClass}>
              Templates
            </Link>
            <button className={`${buttonClass.primary} flex items-center gap-1.5`} onClick={() => setEditing(blankDraft())}>
              <IconPlus width={14} height={14} /> New automation
            </button>
          </>
        }
      />
      <div className="flex items-center gap-2 text-xs text-muted">
        <Pill tone="warn">Preview</Pill>
        Saved in this browser. These flows aren&apos;t connected to the signal engine and don&apos;t run.
      </div>

      {drafts === null ? (
        <Card className="p-4 text-sm text-muted">Loading...</Card>
      ) : drafts.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 px-4 py-16 text-center text-muted">
          <IconSad width={44} height={44} className="text-faint" />
          <p className="text-sm">You haven&apos;t saved an automation yet.</p>
        </Card>
      ) : (
        byFolder.map(([folder, list]) => (
          <Card key={folder} className="overflow-hidden">
            <div className="flex items-center gap-2 border-b border-line bg-surface-2/50 px-4 py-2 text-sm font-semibold">
              <IconFolder width={15} height={15} className="text-muted" /> {folder}
            </div>
            <ul className="divide-y divide-line">
              {list.map((d) => (
                <li key={d.id} className="flex items-center gap-3 px-4 py-3">
                  <button onClick={() => setEditing(d)} className="min-w-0 flex-1 text-left">
                    <span className="block text-sm font-medium hover:text-accent">{d.name}</span>
                    <span className="block text-xs text-muted">
                      {d.steps.length} step{d.steps.length === 1 ? "" : "s"} · updated {new Date(d.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </span>
                  </button>
                  <button onClick={() => setEditing(d)} className="text-sm text-muted hover:text-fg">
                    Open
                  </button>
                  <button onClick={() => setDeleting(d)} className="text-sm text-muted hover:text-down">
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        ))
      )}

      {editing && (
        <AutomationBuilder
          key={editing.id}
          draft={editing}
          botId={bot.id}
          botName={bot.name}
          onSaved={reload}
          onClose={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {deleting && (
        <Modal
          title="Delete this automation?"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button className={buttonClass.secondary} onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button
                className={buttonClass.danger}
                onClick={() => {
                  deleteDraft(deleting.id);
                  setDeleting(null);
                  reload();
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <p className="text-sm text-muted">
            <span className="font-medium text-fg">{deleting.name}</span> will be removed from this browser&apos;s library. A bot it was attached to simply stops listing it.
          </p>
        </Modal>
      )}
    </div>
  );
}
