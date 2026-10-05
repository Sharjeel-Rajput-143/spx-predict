"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconInfo } from "@/components/icons";
import { cn } from "@/lib/format";
import type { Tone } from "./model";

export function Switch({
  on,
  onChange,
  disabled,
  label,
}: {
  on: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50",
        on ? "bg-up" : "bg-surface-2 ring-1 ring-inset ring-line",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
          on ? "left-[22px]" : "left-0.5 !bg-faint",
        )}
      />
    </button>
  );
}

const TONE_CLASS: Record<Tone | "neutral" | "info", string> = {
  ok: "bg-up-soft text-up",
  error: "bg-down-soft text-down",
  warn: "bg-amber-500/15 text-amber-500",
  skip: "bg-surface-2 text-muted",
  neutral: "bg-surface-2 text-muted",
  info: "bg-accent/15 text-accent",
};

export function Pill({ tone = "neutral", children }: { tone?: Tone | "neutral" | "info"; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium", TONE_CLASS[tone])}>
      {children}
    </span>
  );
}

export function DirectionTag({ direction }: { direction: string }) {
  const bull = direction === "bullish";
  const bear = direction === "bearish";
  return <Pill tone={bull ? "ok" : bear ? "error" : "neutral"}>{direction || "unknown"}</Pill>;
}

/** Open overlays, outermost first. Escape closes only the topmost, so a panel
 * stacked over another doesn't take its parent down with it. */
const overlayStack: symbol[] = [];

export function useEscapeToClose(onClose: () => void): void {
  // Register once, in the order overlays opened; always call the latest onClose.
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    const me = Symbol("overlay");
    overlayStack.push(me);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && overlayStack[overlayStack.length - 1] === me) latest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const i = overlayStack.indexOf(me);
      if (i !== -1) overlayStack.splice(i, 1);
    };
  }, []);
}

/** Render while a popover (menu, dropdown list) is open so Escape closes it
 * before the panel it sits in. */
export function EscapeLayer({ onEscape }: { onEscape: () => void }) {
  useEscapeToClose(onEscape);
  return null;
}

/** Right-hand slide-over, closes on Escape or backdrop click. */
export function Drawer({
  title,
  onClose,
  children,
  footer,
  wide,
  extraWide,
  headerActions,
  onBack,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Pinned under the scrolling body - where a panel's Save button lives. */
  footer?: ReactNode;
  wide?: boolean;
  /** An even wider panel, for dense detail views. */
  extraWide?: boolean;
  /** Buttons shown in the header, just before the close button. */
  headerActions?: ReactNode;
  /** Shows a back arrow before the title: a sub-panel returning to its parent. */
  onBack?: () => void;
}) {
  useEscapeToClose(onClose);

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal aria-label={title}>
      <button aria-label="Close" className="absolute inset-0 bg-black/50" onClick={onClose} />
      <aside className={cn("relative flex h-full w-full flex-col border-l border-line bg-surface shadow-2xl", extraWide ? "max-w-2xl" : wide ? "max-w-lg" : "max-w-md")}>
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-center gap-2">
            {onBack && (
              <button onClick={onBack} aria-label="Back" className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg">
                ←
              </button>
            )}
            <h2 className="text-sm font-semibold">{title}</h2>
          </div>
          <div className="flex items-center gap-2">
            {headerActions}
            <button
              onClick={onClose}
              aria-label="Close"
              className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
            >
              ×
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <footer className="border-t border-line p-4">{footer}</footer>}
      </aside>
    </div>
  );
}

export function KeyValue({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="divide-y divide-line text-sm">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex items-start justify-between gap-4 py-2">
          <dt className="text-muted">{k}</dt>
          <dd className="tabular text-right font-medium">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Th({ children, right }: { children?: ReactNode; right?: boolean }) {
  return (
    <th className={cn("whitespace-nowrap px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-faint", right ? "text-right" : "text-left")}>
      {children}
    </th>
  );
}

export function Td({ children, right, className }: { children?: ReactNode; right?: boolean; className?: string }) {
  return <td className={cn("tabular whitespace-nowrap px-3 py-2.5 text-sm", right && "text-right", className)}>{children}</td>;
}

/** Pill switch with the state spelled out inside it. */
export function OnOffSwitch({ on, onChange, disabled, label }: { on: boolean; onChange: () => void; disabled?: boolean; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        "relative flex h-7 w-[68px] shrink-0 items-center rounded-full px-2 text-[11px] font-bold tracking-wide transition-colors disabled:opacity-50",
        on ? "justify-start bg-accent text-white" : "justify-end bg-surface-2 text-muted ring-1 ring-inset ring-line",
      )}
    >
      {on ? "ON" : "OFF"}
      <span className={cn("absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all", on ? "right-1" : "left-1")} />
    </button>
  );
}

/** (i) icon that explains a label on hover or keyboard focus. */
export function InfoTip({ text }: { text: string }) {
  return (
    <span className="group relative ml-1 inline-flex align-middle">
      <button type="button" aria-label={text} className="text-faint hover:text-fg focus:text-fg">
        <IconInfo width={13} height={13} />
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-30 mt-1.5 hidden w-56 -translate-x-1/2 rounded-lg border border-line bg-surface px-3 py-2 text-left text-xs font-normal normal-case leading-snug tracking-normal text-fg shadow-xl group-focus-within:block group-hover:block"
      >
        {text}
      </span>
    </span>
  );
}

/** Centered dialog; closes on Escape or backdrop click. */
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEscapeToClose(onClose);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal aria-label={title}>
      <button aria-label="Close" className="absolute inset-0 cursor-default bg-black/50" onClick={onClose} />
      <div className={cn("relative flex max-h-[90vh] w-full flex-col rounded-2xl border border-line bg-surface shadow-2xl", wide ? "max-w-2xl" : "max-w-md")}>
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg">
            ×
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export const inputClass =
  "w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-60";

export const buttonClass = {
  primary: "rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50",
  secondary: "rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium transition-colors hover:bg-surface-2 disabled:opacity-50",
  danger: "rounded-lg bg-down px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50",
};

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-faint">{hint}</span>}
    </label>
  );
}

/** Button that opens a floating panel; clicking away closes it. */
export function Dropdown({
  trigger,
  children,
  align = "left",
  width = "min-w-52",
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <div className="relative">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <>
          <EscapeLayer onEscape={close} />
          <button aria-label="Close menu" className="fixed inset-0 z-10 cursor-default" onClick={close} />
          <div
            role="menu"
            className={cn("absolute top-full z-20 mt-2 rounded-xl border border-line bg-surface p-1 shadow-xl", width, align === "right" ? "right-0" : "left-0")}
          >
            {children(close)}
          </div>
        </>
      )}
    </div>
  );
}

export function MenuItem({
  onClick,
  children,
  danger,
  disabled,
}: {
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40",
        danger && "text-down",
      )}
    >
      {children}
    </button>
  );
}

export function MenuDivider() {
  return <div className="my-1 border-t border-line" />;
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
      {label}
    </label>
  );
}

export interface ToastItem {
  id: number;
  tone: "ok" | "warn" | "error" | "info";
  text: string;
}

export function Toasts({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed bottom-20 right-4 z-[60] flex w-80 flex-col gap-2 xl:bottom-6">
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cn(
            "pointer-events-auto flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm shadow-xl",
            t.tone === "ok" && "border-up/40 bg-surface text-up",
            t.tone === "error" && "border-down/40 bg-surface text-down",
            t.tone === "warn" && "border-amber-500/40 bg-surface text-amber-500",
            t.tone === "info" && "border-line bg-surface text-fg",
          )}
        >
          <span>{t.text}</span>
          <button onClick={() => onDismiss(t.id)} aria-label="Dismiss" className="text-faint hover:text-fg">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** Asks for one line of text (a new account, a new group). */
export function TextPromptModal({
  title,
  label,
  initial = "",
  confirmLabel = "Save",
  allowEmpty,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial?: string;
  confirmLabel?: string;
  /** Let the value be blank (e.g. clearing a caption). */
  allowEmpty?: boolean;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const submit = () => (allowEmpty || value.trim()) && onSubmit(value.trim());
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className={buttonClass.secondary} onClick={onClose}>
            Cancel
          </button>
          <button className={buttonClass.primary} onClick={submit} disabled={!allowEmpty && !value.trim()}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <Field label={label}>
        <input className={inputClass} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} autoFocus />
      </Field>
    </Modal>
  );
}
