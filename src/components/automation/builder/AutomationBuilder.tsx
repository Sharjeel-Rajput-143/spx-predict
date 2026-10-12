"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { IconChevronDown, IconMore, IconPlus } from "@/components/icons";
import { cn } from "@/lib/format";
import { Btn, Dropdown, inputClass, MenuDivider, MenuItem, Modal, Pill, TextPromptModal } from "../bot/primitives";
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

  const [rail, setRail] = useState<RailTab>("inputs");
  const [zoom, setZoom] = useState(1);
  /** On a phone the left rail (Inputs, Opportunities, Warnings) opens over the canvas instead of beside it. */
  const [railOpen, setRailOpen] = useState(false);
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
    if (window.innerWidth < 640) setZoom(0.7); // a phone starts zoomed out so more of the flow fits
  }, []);

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
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2.5 sm:gap-3 sm:px-5 sm:py-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-line text-muted" aria-hidden>
          <FlowGlyph />
        </span>
        <input
          ref={titleRef}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            changed();
          }}
          readOnly={readOnly}
          aria-label="Automation name"
          className="min-w-0 max-w-xs flex-1 basis-32 rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-base font-semibold outline-none hover:border-line focus:border-accent read-only:hover:border-transparent"
        />
        {saved && <span className="text-xs text-up">Saved</span>}
        {flash && <span className="text-xs text-muted">{flash}</span>}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2 sm:gap-2.5">
          <Btn kind="secondary" className="inline-flex items-center gap-2 font-semibold md:hidden"  onClick={() => setRailOpen((o) => !o)} aria-expanded={railOpen}>
            Details
          </Btn>
          {!readOnly && (
            <label className="relative inline-flex items-center rounded-lg border border-line bg-surface text-muted hover:bg-surface-2" title="Folder">
              <span className="pointer-events-none absolute left-3">
                <FolderGlyph />
              </span>
              <select
                value={folder}
                onChange={(e) => {
                  if (e.target.value === "__new") setNewFolder(true);
                  else {
                    setFolder(e.target.value);
                    changed();
                  }
                }}
                aria-label="Folder"
                className="max-w-40 cursor-pointer appearance-none bg-transparent py-2 pl-10 pr-8 text-sm text-fg outline-none"
              >
                {folders.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
                <option value="__new">New folder...</option>
              </select>
              <IconChevronDown width={14} height={14} className="pointer-events-none absolute right-2.5" />
            </label>
          )}
          <Btn kind="secondary" className="inline-flex items-center gap-2 font-semibold" aria-label="Run Test"  onClick={() => setTesting(true)}>
            <BugGlyph />
            <span className="hidden sm:inline">Run Test</span>
          </Btn>
          {!readOnly && (
            <Btn kind="primary" className="inline-flex items-center justify-center gap-2 font-semibold sm:min-w-28"  onClick={save}>
              <SaveGlyph />
              <span>Save</span>
            </Btn>
          )}
          <Btn kind="secondary" className="inline-flex items-center justify-center gap-2 font-semibold sm:min-w-28"  onClick={() => (dirty && !readOnly ? setConfirmClose(true) : onClose())}>
            <span aria-hidden className="text-base leading-none">×</span>
            Close
          </Btn>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <aside className={cn("w-full shrink-0 flex-col border-r border-line bg-surface md:static md:flex md:w-[24rem]", railOpen ? "absolute inset-0 z-20 flex" : "hidden")}>
          {(
            [
              ["inputs", "Inputs", inputs.length],
              ["opportunities", "Opportunities", check.opportunities.length],
              ["warnings", "Warnings", check.warnings.length],
            ] as [RailTab, string, number][]
          ).map(([key, label, count]) => {
            const open = rail === key;
            return (
              <section key={key} className={cn("flex min-h-0 flex-col", open ? "flex-1" : "border-t border-line")}>
                <button
                  onClick={() => setRail(key)}
                  aria-expanded={open}
                  className={cn("flex w-full items-center gap-2.5 px-5 py-4 text-left", open ? "border-b border-line" : "hover:bg-surface-2")}
                >
                  <span className="text-base font-semibold">{label}</span>
                  {key !== "inputs" && (
                    <span className={cn("rounded-md px-2 py-0.5 text-xs font-semibold", key === "warnings" && count > 0 ? "bg-amber-500/15 text-amber-500" : "bg-accent/10 text-accent")}>{count}</span>
                  )}
                </button>
                {open && (
                  <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
                    {key === "inputs" && (
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
                    {key === "opportunities" && (
                      <div className="space-y-2.5">
                        {check.opportunities.length === 0 ? (
                          <p className="text-sm text-muted">No trades yet. Add an Open Position step and it shows up here in plain English.</p>
                        ) : (
                          check.opportunities.map((o) => (
                            <button key={o.stepId} onClick={() => setOpenId(o.stepId)} className="block w-full rounded-lg border border-line bg-bg px-3 py-2.5 text-left hover:border-accent">
                              <span className="block text-sm font-semibold">{o.title}</span>
                              <span className="mt-0.5 block text-xs text-muted">{o.summary}</span>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                    {key === "warnings" && (
                      <div className="space-y-4 text-sm text-muted">
                        {check.warnings.length === 0 ? <p>No warnings found.</p> : <ul className="space-y-2">{check.warnings.map((w) => <li key={w} className="rounded-lg bg-amber-500/10 px-3 py-2 text-amber-500">{w}</li>)}</ul>}
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
                )}
              </section>
            );
          })}
        </aside>

        <main className="relative flex-1 overflow-auto bg-bg">
          <div className="min-h-full w-max min-w-full px-4 py-6 sm:px-10 sm:py-8" style={{ zoom }}>
            {(note || !readOnly) && (
              <p className={cn("mb-4 max-w-3xl rounded-lg px-3 py-2 text-xs", readOnly ? "bg-accent/10 text-accent" : "bg-amber-500/10 text-amber-500")}>
                {note ??
                  "Preview: flows you save here live in this browser and aren't connected to the signal engine yet - they can't place orders or send anything."}
              </p>
            )}
            <div className="text-xs font-medium uppercase tracking-wide text-muted">Start automation</div>
            <div className="relative mt-4 pl-10">
              <Arrow className="absolute left-1 top-4" />
              <FlowList steps={steps} parentId={null} lane="root" ctx={handlers} />
            </div>
          </div>
          <div className="pointer-events-none sticky bottom-5 float-right mr-5 flex gap-2">
            <button onClick={() => setZoom((z) => Math.min(1, Math.round((z + 0.1) * 10) / 10))} disabled={zoom >= 1} aria-label="Zoom in" className="pointer-events-auto grid h-11 w-11 place-items-center rounded-full border border-line bg-surface text-lg text-muted shadow-sm hover:text-fg disabled:opacity-40">
              +
            </button>
            <button onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10))} disabled={zoom <= 0.5} aria-label="Zoom out" className="pointer-events-auto grid h-11 w-11 place-items-center rounded-full border border-line bg-surface text-lg text-muted shadow-sm hover:text-fg disabled:opacity-40">
              −
            </button>
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
              <Btn kind="secondary"  onClick={() => setConfirmClose(false)}>
                Keep editing
              </Btn>
              <Btn kind="secondary"  onClick={onClose}>
                Discard
              </Btn>
              <Btn kind="primary"
                
                onClick={() => {
                  save();
                  onClose();
                }}
              >
                Save and close
              </Btn>
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
    <div className="space-y-6 text-[15px] text-muted">
      {inputs.length > 0 && (
        <ul className="space-y-2.5">
          {inputs.map((i) => (
            <li key={i.id} className="rounded-lg border border-line bg-bg p-3">
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
        <div className="space-y-6">
          <Help title="What are inputs?" text="Inputs are custom values for your automation that work like variables." />
          <Help title="Where can I use inputs?" text="Any field with a link icon next to it can be replaced with an input." />
          <Help title="How do I create an input?" text="Click the link icon, then name it. Reuse the same input in your automation like a variable." />
          <Help title="When do I provide a value for the input?" text="You are prompted to set a value for each input when you use the automation." />
          <button className="text-sm font-medium text-accent hover:underline" onClick={onHideHelp}>
            Hide this message
          </button>
        </div>
      )}
    </div>
  );
}

const Help = ({ title, text }: { title: string; text: string }) => (
  <div>
    <div className="text-base font-semibold text-fg">{title}</div>
    <p className="mt-2 leading-relaxed">{text}</p>
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
          <Btn kind="secondary"  onClick={onClose}>
            Close
          </Btn>
        ) : (
          <>
            <Btn kind="secondary"  onClick={onClose}>
              Cancel
            </Btn>
            <Btn kind="primary"  onClick={() => onSave(text)}>
              Save
            </Btn>
          </>
        )
      }
    >
      <textarea className={inputClass} rows={5} value={text} readOnly={readOnly} onChange={(e) => setText(e.target.value)} placeholder="Why this step exists, edge cases..." aria-label="Notes" autoFocus />
    </Modal>
  );
}

const Arrow = ({ className }: { className?: string }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={cn("text-faint", className)} aria-hidden>
    <path d="M5 4v6a5 5 0 005 5h8" />
    <path d="M14 11l4 4-4 4" />
  </svg>
);
const FlowGlyph = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="5" r="2.2" />
    <circle cx="6" cy="19" r="2.2" />
    <circle cx="18" cy="19" r="2.2" />
    <path d="M12 7.2v4.3M12 11.5l-6 5.3M12 11.5l6 5.3" />
  </svg>
);
const FolderGlyph = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden>
    <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
  </svg>
);
const BugGlyph = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M9 4l1.2 1.5a5 5 0 013.6 0L15 4l1.2.9-1 1.3A5 5 0 0117 10h3v1.8h-3v1.4l2.6 1.5-.9 1.5-2-1.2a5 5 0 01-9.4 0l-2 1.2-.9-1.5L7 13.2v-1.4H4V10h3a5 5 0 011.8-3.8l-1-1.3z" />
  </svg>
);
const SaveGlyph = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
    <path d="M14 3v5h5M12 17v-5M9.5 14.5L12 12l2.5 2.5" />
  </svg>
);

/** The "+" button: a white square with a border, as Option Alpha draws it. */
function AddButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} aria-label="Add step" className="grid h-9 w-9 place-items-center rounded-md border border-line bg-surface text-muted shadow-sm hover:border-accent hover:text-accent">
      <IconPlus width={16} height={16} />
    </button>
  );
}

/** A lane: its first step, then each next step nested under the one before it (with the arrow), then the "+" at the end. */
function FlowList({ steps, parentId, lane, ctx }: { steps: Step[]; parentId: string | null; lane: LaneKey; ctx: Ctx }) {
  const [first, ...rest] = steps;
  if (!first) return ctx.readOnly ? null : <AddButton onClick={() => ctx.onAdd({ parentId, lane })} />;
  return (
    <div>
      <StepNode step={first} ctx={ctx} />
      {(rest.length > 0 || !ctx.readOnly) && (
        <div className={cn("mt-4", rest.length > 0 && "relative ml-14")}>
          {rest.length > 0 && <Arrow className="absolute -left-9 top-3.5" />}
          <FlowList steps={rest} parentId={parentId} lane={lane} ctx={ctx} />
        </div>
      )}
    </div>
  );
}

/** What the tile on the left of a step looks like: a tinted block with a solid mark, by kind of step. */
function Tile({ kind }: { kind: StepKind }) {
  const info = stepInfo(kind);
  const solid =
    kind === "decision" || kind === "conditional"
      ? "rounded-full bg-amber-500 text-white"
      : kind === "close_position"
        ? "rounded-md bg-down text-white"
        : kind === "open_position" || kind === "open_trade_idea"
          ? "rounded-md bg-up text-white"
          : info.tile;
  const tint = kind === "decision" || kind === "conditional" ? "bg-amber-500/15" : kind === "close_position" ? "bg-down-soft" : kind === "open_position" || kind === "open_trade_idea" ? "bg-up-soft" : "bg-surface-2";
  return (
    <span className={cn("grid h-[3.25rem] w-[3.25rem] shrink-0 place-items-center rounded-l-md", tint)}>
      <span className={cn("grid h-7 w-7 place-items-center text-sm font-bold leading-none", solid)}>{info.glyph}</span>
    </span>
  );
}

function StepNode({ step, ctx }: { step: Step; ctx: Ctx }) {
  const info = stepInfo(step.kind);
  const branches = lanes(step);
  const expandable = isBranching(step.kind) || hasBody(step.kind);
  return (
    <div>
      <div className="flex items-center gap-3">
        <div className="flex max-w-full items-stretch rounded-md border border-line bg-surface shadow-sm">
          <Tile kind={step.kind} />
          <button onClick={() => ctx.onOpen(step)} className="min-w-0 flex-1 px-4 text-left" title={step.notes}>
            <span className="block text-[15px] font-medium">
              {describeStep(step, ctx.inputs)}
              {step.notes && <span className="ml-1.5 text-[11px] font-normal text-faint">· note</span>}
            </span>
          </button>
          <Dropdown
            align="right"
            width="min-w-48"
            trigger={({ toggle }) => (
              <button onClick={toggle} aria-label={`${info.name} actions`} className="grid h-full w-10 place-items-center text-faint hover:text-fg">
                <IconMore width={18} height={18} />
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
        {expandable && (
          <button onClick={() => ctx.onToggleCollapse(step.id)} aria-label={step.collapsed ? "Expand branches" : "Collapse branches"} aria-expanded={!step.collapsed} className="grid h-8 w-8 place-items-center rounded-full text-faint hover:bg-surface-2 hover:text-fg">
            <IconChevronDown width={15} height={15} className={cn("transition-transform", !step.collapsed && "rotate-180")} />
          </button>
        )}
      </div>

      {!step.collapsed && branches.length > 0 && (
        <div className="relative ml-6 pt-4">
          {branches.map((l, i) => {
            const first = i === 0;
            const last = i === branches.length - 1;
            // The line runs from the step above down to the last label, which sits on it.
            const labelCenter = "0.9375rem";
            return (
              <div key={l.label} className={cn("relative flex items-start", !last && "pb-4")}>
                <span
                  aria-hidden
                  className="absolute left-0 w-px bg-line"
                  style={{ top: first ? "-1rem" : 0, height: last ? (first ? `calc(1rem + ${labelCenter})` : labelCenter) : first ? "calc(100% + 1rem)" : "100%" }}
                />
                <span className="relative z-10 -ml-[1.5625rem] mt-0.5 w-[3.125rem] shrink-0 rounded-md bg-surface-2 py-1 text-center text-xs font-medium tracking-wide text-muted">{l.label}</span>
                <span aria-hidden className="mt-[0.9375rem] h-px w-4 shrink-0 bg-line" />
                <div className={cn("min-w-0 flex-1", !l.steps.length && !ctx.readOnly && "-mt-0.5")}>
                  <FlowList steps={l.steps} parentId={step.id} lane={step.kind === "decision" && i === 1 ? "no" : "yes"} ctx={ctx} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
