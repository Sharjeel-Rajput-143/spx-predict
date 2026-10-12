"use client";

import { useEffect, useState } from "react";
import { Btn, Checkbox, Drawer, Field, inputClass, Pill } from "../bot/primitives";
import { previewTrace, type BotInput, type Step } from "./model";

/** "Test Automation": pick a bot, keep the safety box checked, start. In this
 * preview a test only reads the design back to you in order - it is not run
 * against the bot, so nothing can change either way. */
export function RunTestDrawer({ steps, inputs = [], currentBotId, currentBotName, onClose }: { steps: Step[]; inputs?: BotInput[]; currentBotId: string; currentBotName: string; onClose: () => void }) {
  const [bots, setBots] = useState<{ id: string; name: string }[]>([{ id: currentBotId, name: currentBotName }]);
  const [botId, setBotId] = useState(currentBotId);
  const [prevent, setPrevent] = useState(true);
  const [result, setResult] = useState<ReturnType<typeof previewTrace> | null>(null);

  useEffect(() => {
    fetch("/api/automation/bots")
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => json && setBots(json.bots.filter((b: { archived: boolean }) => !b.archived)))
      .catch(() => undefined);
  }, []);

  const chosen = bots.find((b) => b.id === botId)?.name ?? currentBotName;

  return (
    <Drawer
      title="Test automation"
      onClose={onClose}
      footer={
        result ? (
          <Btn kind="secondary" className="w-full"  onClick={() => setResult(null)}>
            Back
          </Btn>
        ) : (
          <Btn kind="primary" className="w-full"  onClick={() => setResult(previewTrace(steps, inputs))}>
            Start test
          </Btn>
        )
      }
    >
      {result ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Pill tone="warn">Preview</Pill>
            <span className="text-sm text-muted">Read-through for {chosen}. Nothing was run and nothing changed.</span>
          </div>
          {result.length === 0 ? (
            <p className="text-sm text-muted">The flow is empty - add a step first.</p>
          ) : (
            <ol className="space-y-1.5 text-sm">
              {result.map((line, i) => (
                <li key={i} className="flex gap-2" style={{ paddingLeft: line.depth * 18 }}>
                  <span className="w-12 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-faint">{line.label}</span>
                  <span>{line.text}</span>
                </li>
              ))}
            </ol>
          )}
          {!prevent && <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-500">The safety box was off. In this preview that changes nothing: saved flows aren&apos;t connected to any bot.</p>}
        </div>
      ) : (
        <div className="space-y-5">
          <Field label="Bot to run test">
            <select className={inputClass} value={botId} onChange={(e) => setBotId(e.target.value)}>
              {bots.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="space-y-1.5">
            <Checkbox checked={prevent} onChange={setPrevent} label="Prevent automation from modifying bot" />
            <p className="ml-[26px] text-xs text-muted">
              Your bot (positions, tags, etc) will not be modified during this test. Uncheck this box to allow the automation full access to
              open/close positions, modify tags, set exit options, etc.
            </p>
          </div>
          <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">Preview: designs saved here aren&apos;t connected to the signal engine yet, so a test only reads the flow back to you.</p>
        </div>
      )}
    </Drawer>
  );
}
