"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader, headerButtonClass } from "@/components/automation/PageHeader";
import { RulesPanel } from "@/components/automations/RulesPanel";
import type { AlertConnectionView } from "@/lib/automations/types";

export function RulesView() {
  const [connections, setConnections] = useState<AlertConnectionView[]>([]);

  useEffect(() => {
    fetch("/api/automations/connections")
      .then((r) => r.json())
      .then((data) => setConnections(data.connections ?? []));
  }, []);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Rules"
        back={
          <Link href="/automations" className="text-muted hover:text-fg">
            ← Automation
          </Link>
        }
        actions={
          <Link href="/settings" className={headerButtonClass}>
            Webhook settings
          </Link>
        }
      />
      <p className="text-sm text-muted">
        Rules watch the live chart and fire a webhook for you. Connections are managed in Settings › Webhook.
      </p>
      <RulesPanel connections={connections} />
    </div>
  );
}
