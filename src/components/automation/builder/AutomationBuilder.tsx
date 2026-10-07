"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { IconChevronDown, IconMore, IconPlus } from "@/components/icons";
import { cn } from "@/lib/format";
import { Dropdown, MenuDivider, MenuItem, Modal, Pill, TextPromptModal, buttonClass, inputClass } from "../bot/primitives";
import { AddStepDrawer } from "./AddStepDrawer";
import { ClosePositionDrawer } from "./ClosePositionDrawer";
import { DecisionDrawer } from "./DecisionDrawer";
import { NodeEditor } from "./NodeEditor";
import { OpenPositionDrawer } from "./OpenPositionDrawer";
import { RunTestDrawer } from "./RunTestDrawer";
import {
  appendStep,
  checkFlow,
  cloneStep,
  describeStep,
  findStep,
  hasBody,
  insertBefore,
  isBranching,
  lanes,
  needsCondition,
  newId,
  newStep,
  removeStep,
  stepInfo,
  updateStep,
  type AutomationDraft,
  type BotInput,
  type LaneKey,
  type Step,
  type StepKind,
} from "./model";
import { addFolder, hideInputsHelp, isInputsHelpHidden, loadFolders, saveDraft } from "./store";

/** Where a new step goes: the end of a lane, or just before an existing step. */
type Target = { parentId: string | null; lane: LaneKey } | { beforeId: string };

type RailTab = "inputs" | "opportunities" | "warnings";

interface Ctx {
  inputs: BotInput[];
  readOnly: boolean;
  onAdd: (t: Target) => void;
  onOpen: (s: Step) => void;
  onMenu: (action: "copy" | "precede" | "caption" | "notes" | "delete", s: Step) => void;
  onToggleCollapse: (id: string) => void;
}

/**
 * Full-page flow builder: a canvas that starts at "START AUTOMATION" and grows
 * one "+" at a time, with Inputs / Opportunities / Warnings in a left rail.
 * Designs save to this browser (see store.ts). `readOnly` is for the built-in
 * triggers: a reference drawing of what the engine does.
 */
export function AutomationBuilder({
  draft: initial,
  botId,
  botName,
  readOnly = false,
  note,
  liveEditor,
  onSaved,
  onClose,
}: {
  draft: AutomationDraft;
  botId: string;
  botName: string;
  readOnly?: boolean;
  /** A line of context shown above the canvas (used for built-in flows). */
  note?: string;
  /** Built-in flows only: a node's real, saved-to-the-bot editor. Returns null for a node with nothing to edit
   * (it then opens read-only). The canvas structure itself stays fixed. */
  liveEditor?: (step: Step, close: () => void) => React.ReactNode | null;
  onSaved: (draft: AutomationDraft) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [folder, setFolder] = useState(initial.folder);
  const [steps, setSteps] = useState<Step[]>(initial.steps);
  const [inputs, setInputs] = useState<BotInput[]>(initial.inputs ?? []);
  const [folders, setFolders] = useState<string[]>([initial.folder]);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const [rail, setRail] = useState<RailTab>("opportunities");
  const [addTarget, setAddTarget] = useState<Target | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [captionId, setCaptionId] = useState<string | null>(null);
  const [notesId, setNotesId] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<Step | null>(null);
  const [testing, setTesting] = useState(false);
  const [newFolder, setNewFolder] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [helpHidden, setHelpHidden] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setFolders([...new Set([initial.folder, ...loadFolders()])]);
    setHelpHidden(isInputsHelpHidden());
    if (!readOnly) titleRef.current?.select();
  }, [readOnly]);

  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(id);
  }, [flash]);

  const check = useMemo(() => checkFlow(steps, inputs), [steps, inputs]);

  const changed = () => {
    setDirty(true);
    setSaved(false);
  };
  const mutate = (fn: (s: Step[]) => Step[]) => {
    setSteps(fn(steps));
    changed();
  };
  const place = (target: Target, step: Step) =>
    mutate((s) => ("beforeId" in target ? insertBefore(s, target.beforeId, step) : appendStep(s, target.parentId, target.lane, step)));

  const pickKind = (kind: StepKind) => {
    if (!addTarget) return;
    const step = newStep(kind);
    place(addTarget, step);
    setAddTarget(null);
    if (kind !== "loop_bot_symbols") setOpenId(step.id); // straight into its settings
  };

  const save = () => {
    const trimmed = name.trim() || "Untitled automation";
    const draft: AutomationDraft = { id: initial.id, name: trimmed, folder, steps, inputs, updatedAt: Date.now() };
    saveDraft(draft);
    setName(trimmed);
    setDirty(false);
    setSaved(true);
    onSaved(draft);
  };

  const handlers: Ctx = {
    inputs,
    readOnly,
    onAdd: setAddTarget,
    onOpen: (s) => setOpenId(s.id),
    onToggleCollapse: (id) => setSteps((cur) => updateStep(cur, id, (x) => ({ ...x, collapsed: !x.collapsed }))),
    onMenu: (action, s) => {
      if (action === "copy") {
        setClipboard(cloneStep(s));
        setFlash(`Copied “${describeStep(s, inputs)}”. Paste it from any + button.`);
      } else if (action === "precede") setAddTarget({ beforeId: s.id });
      else if (action === "caption") setCaptionId(s.id);
      else if (action === "notes") setNotesId(s.id);
      else mutate((cur) => removeStep(cur, s.id));
    },
  };

  const openedStep = openId ? findStep(steps, openId) : undefined;
  const live = openedStep && liveEditor ? liveEditor(openedStep, () => setOpenId(null)) : null;
  /** The preview drawers only open for a node that has no live editor. */
  const opened = live ? undefined : openedStep;
  const captioning = captionId ? findStep(steps, captionId) : undefined;
  const noting = notesId ? findStep(steps, notesId) : undefined;

  const saveConfig = (id: string, config: Record<string, string>) => {
    mutate((s) => updateStep(s, id, (x) => ({ ...x, config })));
    setOpenId(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg" role="dialog" aria-modal aria-label="Automation builder">
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
        <input
          ref={titleRef}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            changed();
          }}
          readOnly={readOnly}
          aria-label="Automation name"
          className="min-w-0 max-w-xs flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-sm font-semibold outline-none hover:border-line focus:border-accent read-only:hover:border-transparent"
        />
        {!readOnly && (
          <>
            <select
              value={folder}
              disabled={readOnly}
              onChange={(e) => {
                if (e.target.value === "__new") setNewFolder(true);
                else {
                  setFolder(e.target.value);
                  changed();
                }
              }}
              aria-label="Folder"
              className="rounded-lg border border-line bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-accent disabled:opacity-60"
            >
              {folders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
              {!readOnly && <option value="__new">New folder...</option>}
            </select>
            <Pill tone="warn">Preview</Pill>
          </>
        )}
        {saved && <span className="text-xs text-up">Saved</span>}
        {flash && <span className="text-xs text-muted">{flash}</span>}
        <div className="ml-auto flex items-center gap-2">
          <button className={buttonClass.secondary} onClick={() => setTesting(true)}>
            Run test
          </button>
          {!readOnly && (
            <button className={buttonClass.primary} onClick={save}>
              Save
            </button>
          )}
          <button className={buttonClass.secondary} onClick={() => (dirty && !readOnly ? setConfirmClose(true) : onClose())}>
            Close
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-[22rem] shrink-0 flex-col border-r border-line bg-surface md:flex">
          <div className="grid grid-cols-3 border-b border-line text-sm" role="tablist">
            {(
              [
                ["inputs", "Inputs", inputs.length],
                ["opportunities", "Opportunities", check.opportunities.length],
                ["warnings", "Warnings", check.warnings.length],
              ] as [RailTab, string, number][]
            ).map(([key, label, count]) => (
              <button
                key={key}
                role="tab"
                aria-selected={rail === key}
                onClick={() => setRail(key)}
                className={cn("-mb-px whitespace-nowrap border-b-2 px-1.5 py-2.5 text-xs font-medium transition-colors", rail === key ? "border-accent text-accent" : "border-transparent text-muted hover:text-fg")}
              >
                {label}{" "}
                <span className={cn("ml-0.5 rounded-md px-1 text-[11px] font-semibold", key === "warnings" && count > 0 ? "bg-amber-500/15 text-amber-500" : "bg-surface-2 text-muted")}>{count}</span>
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {rail === "inputs" && (
              <InputsPanel
                inputs={inputs}
                readOnly={readOnly}
                helpHidden={helpHidden}
                onHideHelp={() => {
                  hideInputsHelp();
                  setHelpHidden(true);
                }}
                onChange={(next) => {
                  setInputs(next);
                  changed();
                }}
              />
            )}
            {rail === "opportunities" && (
              <div className="space-y-2.5">
                {check.opportunities.length === 0 ? (
                  <p className="text-xs text-muted">No trades yet. Add an Open Position step and it shows up here in plain English.</p>
                ) : (
                  check.opportunities.map((o) => (
                    <button key={o.stepId} onClick={() => setOpenId(o.stepId)} className="block w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-left hover:border-accent">
                      <span className="block text-sm font-semibold">{o.title}</span>
                      <span className="mt-0.5 block text-xs text-muted">{o.summary}</span>
                    </button>
                  ))
                )}
              </div>
            )}
            {rail === "warnings" && (
              <div className="space-y-4 text-xs text-muted">
                {check.warnings.length === 0 ? <p>No warnings.</p> : <ul className="space-y-2">{check.warnings.map((w) => <li key={w} className="rounded-lg bg-amber-500/10 px-3 py-2 text-amber-500">{w}</li>)}</ul>}
                {check.suggestions.length > 0 && (
                  <div>
                    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide">Suggestions</div>
                    <ul className="space-y-1.5">
                      {check.suggestions.map((t) => (
                        <li key={t}>• {t}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>

        <main className="flex-1 overflow-auto p-6">
          {(note || !readOnly) && (
            <p className={cn("mb-4 rounded-lg px-3 py-2 text-xs", readOnly ? "bg-accent/10 text-accent" : "bg-amber-500/10 text-amber-500")}>
              {note ??
                "Preview: flows you save here live in this browser and aren't connected to the signal engine yet - they can't place orders or send anything."}
            </p>
          )}
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Start automation</div>
          <div className="mt-2">
            <FlowList steps={steps} parentId={null} lane="root" ctx={handlers} />
          </div>
        </main>
      </div>

      {addTarget && (
        <AddStepDrawer
          onPick={pickKind}
          onPaste={
            clipboard
              ? () => {
                  place(addTarget, cloneStep(clipboard));
                  setAddTarget(null);
                }
              : undefined
          }
          pasteLabel={clipboard ? describeStep(clipboard, inputs) : undefined}
          onClose={() => setAddTarget(null)}
        />
      )}

      {live}
      {opened && needsCondition(opened.kind) && (
        <DecisionDrawer
          title={stepInfo(opened.kind).name}
          heading={opened.kind === "decision" ? "Follow the “Yes” path if…" : "Run the steps inside if…"}
          initial={opened.conditions ?? []}
          readOnly={readOnly}
          onSave={(conditions) => {
            mutate((s) => updateStep(s, opened.id, (x) => ({ ...x, conditions })));
            setOpenId(null);
          }}
          onClose={() => setOpenId(null)}
        />
      )}
      {opened?.kind === "open_position" && (
        <OpenPositionDrawer
          step={opened}
          inputs={inputs}
          readOnly={readOnly}
          onCreateInput={(n, v) => {
            const id = newId("input");
            setInputs((cur) => [...cur, { id, name: n.trim() || "Input", value: v }]);
            changed();
            return id;
          }}
          onUpdateInput={(id, v) => {
            setInputs((cur) => cur.map((i) => (i.id === id ? { ...i, value: v } : i)));
            changed();
          }}
          onSave={(config) => saveConfig(opened.id, config)}
          onClose={() => setOpenId(null)}
        />
      )}
      {opened?.kind === "close_position" && <ClosePositionDrawer step={opened} readOnly={readOnly} onSave={(config) => saveConfig(opened.id, config)} onClose={() => setOpenId(null)} />}
      {opened && !needsCondition(opened.kind) && opened.kind !== "open_position" && opened.kind !== "close_position" && (
        <NodeEditor step={opened} readOnly={readOnly} onSave={(config) => saveConfig(opened.id, config)} onClose={() => setOpenId(null)} />
      )}

      {captioning && (
        <TextPromptModal
          title="Edit caption"
          label="Caption (leave blank to use the automatic description)"
          initial={captioning.caption ?? ""}
          allowEmpty
          onClose={() => setCaptionId(null)}
          onSubmit={(v) => {
            mutate((s) => updateStep(s, captioning.id, (x) => ({ ...x, caption: v || undefined })));
            setCaptionId(null);
          }}
        />
      )}
      {noting && <NotesModal step={noting} readOnly={readOnly} onSave={(text) => { mutate((s) => updateStep(s, noting.id, (x) => ({ ...x, notes: text || undefined }))); setNotesId(null); }} onClose={() => setNotesId(null)} />}
      {testing && <RunTestDrawer steps={steps} inputs={inputs} currentBotId={botId} currentBotName={botName} onClose={() => setTesting(false)} />}
      {newFolder && (
        <TextPromptModal
          title="New folder"
          label="Folder name"
          onClose={() => setNewFolder(false)}
          onSubmit={(v) => {
            setFolders(addFolder(v));
            setFolder(v);
            changed();
            setNewFolder(false);
          }}
        />
      )}
      {confirmClose && (
        <Modal
          title="Close without saving?"
          onClose={() => setConfirmClose(false)}
          footer={
            <>
              <button className={buttonClass.secondary} onClick={() => setConfirmClose(false)}>
                Keep editing
              </button>
              <button className={buttonClass.secondary} onClick={onClose}>
                Discard
              </button>
              <button
                className={buttonClass.primary}
                onClick={() => {
                  save();
                  onClose();
                }}
              >
                Save and close
              </button>
            </>
          }
        >
          <p className="text-sm text-muted">You have changes that haven&apos;t been saved.</p>
        </Modal>
      )}
    </div>
  );
}

function InputsPanel({
  inputs,
  readOnly,
  helpHidden,
  onHideHelp,
  onChange,
}: {
  inputs: BotInput[];
  readOnly: boolean;
  helpHidden: boolean;
  onHideHelp: () => void;
  onChange: (next: BotInput[]) => void;
}) {
  return (
    <div className="space-y-4 text-xs text-muted">
      {inputs.length === 0 ? (
        <p>No inputs yet.</p>
      ) : (
        <ul className="space-y-2.5">
          {inputs.map((i) => (
            <li key={i.id} className="rounded-xl border border-line bg-bg p-2.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-fg">{i.name}</span>
                {!readOnly && (
                  <button onClick={() => onChange(inputs.filter((x) => x.id !== i.id))} aria-label={`Delete input ${i.name}`} className="text-faint hover:text-down">
                    ×
                  </button>
                )}
              </div>
              <input
                value={i.value}
                disabled={readOnly}
                onChange={(e) => onChange(inputs.map((x) => (x.id === i.id ? { ...x, value: e.target.value } : x)))}
                aria-label={`${i.name} value`}
                className={cn(inputClass, "mt-1.5 !py-1.5")}
              />
            </li>
          ))}
        </ul>
      )}
      {!helpHidden && (
        <div className="space-y-3 border-t border-line pt-4">
          <Help title="What are inputs?" text="Inputs are custom values for your automation that work like variables." />
          <Help title="Where can I use them?" text="Any field with a link icon next to it can be replaced with an input." />
          <Help title="How do I create an input?" text="Click the link icon, then name it. Reuse the same input in your automation like a variable." />
          <Help title="When do I provide a value for the input?" text="You are prompted to set a value for each input when you use the automation." />
          <button className="font-medium text-accent hover:underline" onClick={onHideHelp}>
            Hide this message
          </button>
        </div>
      )}
    </div>
  );
}

const Help = ({ title, text }: { title: string; text: string }) => (
  <div>
    <div className="font-semibold text-fg">{title}</div>
    <p className="mt-0.5">{text}</p>
  </div>
);

function NotesModal({ step, readOnly, onSave, onClose }: { step: Step; readOnly: boolean; onSave: (text: string) => void; onClose: () => void }) {
  const [text, setText] = useState(step.notes ?? "");
  return (
    <Modal
      title="Edit notes"
      onClose={onClose}
      footer={
        readOnly ? (
          <button className={buttonClass.secondary} onClick={onClose}>
            Close
          </button>
        ) : (
          <>
            <button className={buttonClass.secondary} onClick={onClose}>
              Cancel
            </button>
            <button className={buttonClass.primary} onClick={() => onSave(text)}>
              Save
            </button>
          </>
        )
      }
    >
      <textarea className={inputClass} rows={5} value={text} readOnly={readOnly} onChange={(e) => setText(e.target.value)} placeholder="Why this step exists, edge cases..." aria-label="Notes" autoFocus />
    </Modal>
  );
}

function FlowList({ steps, parentId, lane, ctx }: { steps: Step[]; parentId: string | null; lane: LaneKey; ctx: Ctx }) {
  return (
    <div className="space-y-2">
      {steps.map((s) => (
        <StepNode key={s.id} step={s} ctx={ctx} />
      ))}
      {!ctx.readOnly && (
        <button
          onClick={() => ctx.onAdd({ parentId, lane })}
          aria-label="Add step"
          className="grid h-8 w-8 place-items-center rounded-lg border border-dashed border-line text-muted hover:border-accent hover:text-accent"
        >
          <IconPlus width={16} height={16} />
        </button>
      )}
    </div>
  );
}

function StepNode({ step, ctx }: { step: Step; ctx: Ctx }) {
  const info = stepInfo(step.kind);
  const branches = lanes(step);
  const expandable = isBranching(step.kind) || hasBody(step.kind);
  return (
    <div>
      <div className="flex max-w-3xl items-center gap-3 rounded-full border border-line bg-surface py-1.5 pl-2 pr-2">
        <span className={cn("grid h-8 w-8 shrink-0 place-items-center text-sm font-bold", info.tile, info.tile.includes("rounded-full") ? "" : "rounded-lg")}>{info.glyph}</span>
        <button onClick={() => ctx.onOpen(step)} className="min-w-0 flex-1 text-left" title={step.notes}>
          <span className="block truncate text-sm font-medium">
            {describeStep(step, ctx.inputs)}
            {step.notes && <span className="ml-1.5 text-[11px] font-normal text-faint">· note</span>}
          </span>
        </button>
        {expandable && (
          <button onClick={() => ctx.onToggleCollapse(step.id)} aria-label={step.collapsed ? "Expand branches" : "Collapse branches"} aria-expanded={!step.collapsed} className="grid h-7 w-7 place-items-center rounded-full text-faint hover:bg-surface-2 hover:text-fg">
            <IconChevronDown width={14} height={14} className={cn("transition-transform", step.collapsed && "-rotate-90")} />
          </button>
        )}
        <Dropdown
          align="right"
          width="min-w-48"
          trigger={({ toggle }) => (
            <button onClick={toggle} aria-label={`${info.name} actions`} className="grid h-7 w-7 place-items-center rounded-full text-faint hover:bg-surface-2 hover:text-fg">
              <IconMore width={16} height={16} />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem onClick={() => { close(); ctx.onOpen(step); }}>Settings</MenuItem>
              {!ctx.readOnly && <MenuItem onClick={() => { close(); ctx.onMenu("precede", step); }}>Precede with…</MenuItem>}
              <MenuItem onClick={() => { close(); ctx.onMenu("copy", step); }}>Copy Action</MenuItem>
              <MenuItem onClick={() => { close(); ctx.onMenu("caption", step); }} disabled={ctx.readOnly}>Edit Caption</MenuItem>
              <MenuItem onClick={() => { close(); ctx.onMenu("notes", step); }}>Edit Notes</MenuItem>
              {!ctx.readOnly && (
                <>
                  <MenuDivider />
                  <MenuItem danger onClick={() => { close(); ctx.onMenu("delete", step); }}>Delete</MenuItem>
                </>
              )}
            </>
          )}
        </Dropdown>
      </div>

      {!step.collapsed && branches.length > 0 && (
        <div className="ml-5 mt-2 space-y-2 border-l border-line pl-4">
          {branches.map((l, i) => (
            <div key={l.label} className="flex items-start gap-3">
              <span className="mt-1.5 w-11 shrink-0 rounded bg-surface-2 px-2 py-0.5 text-center text-[10px] font-bold tracking-wider text-muted">{l.label}</span>
              <div className="min-w-0 flex-1">
                <FlowList steps={l.steps} parentId={step.id} lane={step.kind === "decision" && i === 1 ? "no" : "yes"} ctx={ctx} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
