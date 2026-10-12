"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AutomationLogin } from "@/components/automation/AutomationLogin";
import { PageHeader, headerButtonClass } from "@/components/automation/PageHeader";
import { Btn, buttonClass, Modal } from "@/components/automation/bot/primitives";
import { IconFolder, IconSad } from "@/components/icons";
import { Card } from "@/components/ui";
import type { BotTemplate } from "@/lib/automation/types";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** Library > Templates: saved sets of bot inputs to start new bots from. */
export function TemplatesPage() {
  const [templates, setTemplates] = useState<BotTemplate[] | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [deleting, setDeleting] = useState<BotTemplate | null>(null);

  const load = useCallback(() => {
    fetch("/api/automation/bots")
      .then((r) => {
        if (r.status === 401) {
          setSignedOut(true);
          return null;
        }
        return r.json();
      })
      .then((json) => json && setTemplates(json.templates));
  }, []);
  useEffect(load, [load]);

  if (signedOut) return <AutomationLogin next="/automations/templates" />;

  const remove = async (t: BotTemplate) => {
    await fetch(`/api/automation/templates/${t.id}`, { method: "DELETE" });
    setDeleting(null);
    load();
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Templates"
        back={<Link href="/automations" className="text-muted hover:text-fg">← Automation</Link>}
        actions={
          <Link href="/automations/library" className={headerButtonClass}>
            Automations
          </Link>
        }
      />
      {templates === null ? (
        <Card className="p-4 text-sm text-muted">Loading...</Card>
      ) : templates.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 px-4 py-16 text-center text-muted">
          <IconSad width={44} height={44} className="text-faint" />
          <p className="text-sm">You haven&apos;t saved a template yet.</p>
          <p className="text-xs text-faint">Open a bot&apos;s ... menu and choose Save as template.</p>
        </Card>
      ) : (
        <Card className="divide-y divide-line">
          {templates.map((t) => (
            <div key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3.5">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
                <IconFolder width={18} height={18} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">{t.name}</div>
                <div className="text-xs text-muted">
                  {t.config.quantity}x · {t.config.widthPoints}pt wide · offsets {t.config.putShortOffset}/{t.config.callShortOffset} · credit ${t.config.openingCreditEstimate} · {usd(t.safeguards?.allocationLimit ?? t.config.allocationLimit)} allocation ·
                  saved {new Date(t.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </div>
              </div>
              <Link href={`/automations?newFromTemplate=${t.id}`} className={buttonClass.secondary}>
                New bot from this
              </Link>
              <button onClick={() => setDeleting(t)} className="text-sm text-muted hover:text-down">
                Delete
              </button>
            </div>
          ))}
        </Card>
      )}

      {deleting && (
        <Modal
          title="Delete this template?"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Btn kind="secondary"  onClick={() => setDeleting(null)}>
                Cancel
              </Btn>
              <Btn kind="danger"  onClick={() => remove(deleting)}>
                Delete
              </Btn>
            </>
          }
        >
          <p className="text-sm text-muted">
            <span className="font-medium text-fg">{deleting.name}</span> will be removed from the Library. Bots already made from it are not affected.
          </p>
        </Modal>
      )}
    </div>
  );
}
