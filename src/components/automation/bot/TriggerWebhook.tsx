"use client";

import { useCallback, useEffect, useState } from "react";
import type { TriggerOption } from "@/lib/automation/types";
import { SecretUrl } from "../SecretUrl";
import { WebhookAttachPanel, type AttachedWebhook } from "./WebhookAttachPanel";
import { buttonClass } from "./primitives";

interface TriggerState {
  current: (AttachedWebhook & { path: string }) | null;
  options: TriggerOption[];
}

/** The webhook part of a trigger's gear panel: loads the trigger's attachment, saves a change, detaches, copies the URL
 * for TradingView, and sends a test call. Every change goes to the server, which logs it. */
export function TriggerWebhook({
  botId,
  dir,
  triggerName,
  canTest,
  notify,
  alwaysOn: savedAlwaysOn,
  saveAlwaysOn,
}: {
  botId: string;
  dir: "bullish" | "bearish";
  triggerName: string;
  /** Test calls run on the mock executor and the Tradier sandbox only, never against real money. */
  canTest: boolean;
  notify: (tone: "ok" | "error", text: string) => void;
  /** The trigger's saved Always On, and how to save a change to it. */
  alwaysOn: boolean;
  saveAlwaysOn: (on: boolean) => Promise<boolean>;
}) {
  const [state, setState] = useState<TriggerState | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");
  const [alwaysOn, setAlwaysOn] = useState(savedAlwaysOn);
  useEffect(() => setAlwaysOn(savedAlwaysOn), [savedAlwaysOn]);
  const label = dir === "bullish" ? "Bullish signal" : "Bearish signal";
  const otherLabel = dir === "bullish" ? "Bearish signal" : "Bullish signal";
  const endpoint = `/api/automation/bots/${botId}/triggers/${dir}`;

  const apply = useCallback((next: TriggerState) => {
    setState(next);
    setSelected(next.current?.id ?? "");
  }, []);

  const load = useCallback(() => {
    fetch(endpoint)
      .then((r) => (r.ok ? r.json() : null))
      .then((json: TriggerState | null) => json && apply(json))
      .catch(() => undefined);
  }, [endpoint, apply]);

  useEffect(() => {
    setOrigin(window.location.origin);
    load();
  }, [load]);

  const send = async (init: RequestInit, okText: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, init);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? "Couldn't save it.");
        return false;
      }
      apply(json as TriggerState);
      notify("ok", okText);
      return true;
    } catch {
      setError("Couldn't reach the server.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const attachChanged = selected !== "" && selected !== state?.current?.id;
  const alwaysOnChanged = alwaysOn !== savedAlwaysOn;

  const save = async () => {
    if (attachChanged) {
      const ok = await send({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ webhookId: selected }) }, "Webhook attached.");
      if (!ok) return;
    }
    if (alwaysOnChanged) {
      setBusy(true);
      const ok = await saveAlwaysOn(alwaysOn);
      setBusy(false);
      if (!ok) setError("Couldn't save Always On.");
    }
  };

  /** The full URL, fetched on demand (the lists only ever hold it masked), copied for TradingView. */
  const copyUrl = async (id: string) => {
    try {
      const res = await fetch(`/api/automation/webhooks/${id}/url`, { cache: "no-store" });
      if (!res.ok) throw new Error();
      const { path } = (await res.json()) as { path: string };
      await navigator.clipboard.writeText(`${origin}${path}`);
      notify("ok", "Webhook URL copied.");
    } catch {
      notify("error", "Couldn't copy the URL.");
    }
  };

  /** "+": creates an unattached webhook and selects it (Save attaches it). */
  const create = async (name: string): Promise<string | null> => {
    try {
      const res = await fetch("/api/automation/webhooks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return json.error ?? "Couldn't create it.";
      const stateRes = await fetch(endpoint);
      if (stateRes.ok) {
        const next = (await stateRes.json()) as TriggerState;
        setState(next);
        setSelected(json.webhook.id);
      }
      return null;
    } catch {
      return "Couldn't reach the server.";
    }
  };

  const detach = () => {
    if (!window.confirm(`Detach "${state?.current?.name}" from ${triggerName}? TradingView calls to its URL will be refused until a webhook is attached again.`)) return;
    void send({ method: "DELETE" }, "Webhook detached.");
  };

  if (!state) return <p className="text-sm text-muted">Loading the webhook...</p>;

  return (
    <WebhookAttachPanel
      triggerName={triggerName}
      automationName={label}
      otherAutomationName={otherLabel}
      current={state.current}
      options={state.options}
      selected={selected}
      onSelect={setSelected}
      alwaysOn={alwaysOn}
      onAlwaysOn={setAlwaysOn}
      saveDisabled={!attachChanged && !alwaysOnChanged}
      onCreate={create}
      onCopy={copyUrl}
      onSave={() => void save()}
      onDetach={detach}
      busy={busy}
      error={error}
      urlSlot={state.current && <SecretUrl webhookId={state.current.id} maskedPath={state.current.path} origin={origin} onCopied={() => notify("ok", "Webhook URL copied.")} onProblem={(m) => notify("error", m)} />}
      testSlot={state.current && canTest && state.current.active && <TestHook webhookId={state.current.id} />}
    />
  );
}

/** "Test hook": sends this webhook's signal through the real path (mock or Tradier sandbox only). As for a real call, no
 * price is needed: left blank it runs on the live quote; a typed price overrides it. */
function TestHook({ webhookId }: { webhookId: string }) {
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const n = Number(price.replace(/,/g, ""));
  const blank = price.trim() === "";
  const ok = blank || (Number.isFinite(n) && n > 0);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`/api/automation/webhooks/${webhookId}/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ price: blank ? null : n }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setResult(`Not sent: ${j.error ?? res.status}`);
      else {
        const steps = ((j.decisions ?? []) as { outcome: string }[]).map((d) => d.outcome).join(" → ") || "no decision yet";
        setResult(`Sent at ${Number(j.price).toLocaleString("en-US")}${blank ? " (live quote)" : ""} → ${steps}${j.finished ? "" : " (still working…)"}`);
      }
    } catch {
      setResult("Couldn't reach the server.");
    }
    setBusy(false);
  };

  return (
    <div className="space-y-1.5 border-t border-line pt-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted">
          Price (optional)
          <input
            className="ml-2 w-28 rounded-lg border border-line bg-bg px-2 py-1 text-right text-sm text-fg outline-none focus:border-accent"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="live quote"
            aria-label="Test hook price"
          />
        </label>
        <button className={buttonClass.secondary} disabled={busy || !ok} onClick={run}>
          {busy ? "Sending…" : "Test hook"}
        </button>
      </div>
      <p className="text-xs text-faint">Runs the real path on the mock executor or the Tradier sandbox (paper money), never against real money.</p>
      {result && <p className="text-xs text-muted">{result}</p>}
    </div>
  );
}
