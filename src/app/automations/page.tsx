"use client";

import { useEffect, useState } from "react";
import { ConnectionsPanel } from "@/components/automations/ConnectionsPanel";
import { RulesPanel } from "@/components/automations/RulesPanel";
import { Segmented } from "@/components/ui";
import type { AlertConnectionView } from "@/lib/automations/types";

type Tab = "rules" | "connections";

export default function AutomationsPage() {
  const [tab, setTab] = useState<Tab>("rules");
  const [connections, setConnections] = useState<AlertConnectionView[]>([]);

  const loadConnections = () => {
    fetch("/api/automations/connections")
      .then((r) => r.json())
      .then((data) => setConnections(data.connections ?? []));
  };

  useEffect(loadConnections, [tab]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Automations</h1>
        <p className="mt-1 text-sm text-muted">
          Connect a webhook, then build a rule from any indicator already in the terminal - this platform watches the live
          chart for you instead of a paid TradingView alerts plan.
        </p>
      </div>

      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: "rules", label: "Rules" },
          { value: "connections", label: "Connections" },
        ]}
      />

      {tab === "rules" ? <RulesPanel connections={connections} /> : <ConnectionsPanel />}
    </div>
  );
}
