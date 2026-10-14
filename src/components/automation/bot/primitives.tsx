"use client";

import { Button, Checkbox as AntCheckbox, ConfigProvider, Drawer as AntDrawer, Modal as AntModal, Popover, Switch as AntSwitch, Tag, Tooltip, notification, type ButtonProps } from "antd";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconInfo } from "@/components/icons";
import { cn } from "@/lib/format";
import type { Tone } from "./model";

/**
 * On a server render (the tests; never a real page, where a panel only opens after a click) Ant Design's panels draw nothing at all, so
 * a plain stand-in with the same structure is drawn instead, which is what lets the tests read a panel's contents. In a browser this is
 * always false and the Ant Design panel is used.
 */
const inPlace = typeof document === "undefined";

/** The green on/off switch: Ant Design's Switch, in the app's "up" green. */
const GREEN = { components: { Switch: { colorPrimary: "#089981", colorPrimaryHover: "#0aa88e" } } };

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
    <ConfigProvider theme={GREEN}>
      <AntSwitch
        checked={on}
        disabled={disabled}
        aria-label={label}
        onClick={(_, e) => {
          e.stopPropagation();
          onChange();
        }}
      />
    </ConfigProvider>
  );
}

const TAG_COLOR: Record<Tone | "neutral" | "info", string> = {
  ok: "success",
  error: "error",
  warn: "warning",
  skip: "default",
  neutral: "default",
  info: "processing",
};

/** A small status label: Ant Design's Tag, filled and borderless. */
export function Pill({ tone = "neutral", children }: { tone?: Tone | "neutral" | "info"; children: ReactNode }) {
  return (
    <Tag variant="filled" color={TAG_COLOR[tone]} style={{ margin: 0, padding: "0 6px", fontSize: 11, lineHeight: "18px", fontWeight: 500, whiteSpace: "nowrap" }}>
      {children}
    </Tag>
  );
}

/** A button: Ant Design's Button in the app's three kinds (primary blue, plain, danger red). Takes what a <button> takes; `type` is the HTML type. */
export type BtnKind = "primary" | "secondary" | "danger";
export function Btn({ kind = "secondary", type, ...rest }: Omit<ButtonProps, "type" | "htmlType" | "danger" | "color" | "variant"> & { kind?: BtnKind; type?: "button" | "submit" | "reset" }) {
  return <Button type={kind === "secondary" ? "default" : "primary"} danger={kind === "danger"} htmlType={type ?? "button"} {...rest} />;
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

/** Right-hand slide-over (Ant Design's Drawer), closes on Escape or backdrop click. */
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
  if (inPlace) {
    return (
      <div role="dialog" aria-modal aria-label={title}>
        <header>
          {onBack && <button aria-label="Back">←</button>}
          <h2>{title}</h2>
          {headerActions}
          <button aria-label="Close">×</button>
        </header>
        <div>{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    );
  }
  return (
    <AntDrawer
      open
      rootClassName="app-drawer"
      onClose={onClose}
      size={extraWide ? 672 : wide ? 512 : 448}
      placement="right"
      closable={{ placement: "end", "aria-label": "Close" }}
      destroyOnHidden
      title={
        <span className="flex items-center gap-2 whitespace-nowrap">
          {onBack && <Btn type="button" kind="secondary" size="small" aria-label="Back" onClick={onBack} icon={<span aria-hidden>←</span>} />}
          {title}
        </span>
      }
      extra={headerActions ? <span className="flex flex-wrap items-center justify-end gap-2">{headerActions}</span> : undefined}
      footer={footer}
      styles={{ header: { padding: "12px 16px" }, body: { padding: 16 }, footer: { padding: 16 } }}
    >
      {children}
    </AntDrawer>
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

/** Switch with the state spelled out inside it: Ant Design's Switch with ON and OFF in it. */
export function OnOffSwitch({ on, onChange, disabled, label }: { on: boolean; onChange: () => void; disabled?: boolean; label: string }) {
  return <AntSwitch checked={on} disabled={disabled} aria-label={label} checkedChildren="ON" unCheckedChildren="OFF" onClick={() => onChange()} style={{ minWidth: 56 }} />;
}

/** (i) icon that explains a label on hover or keyboard focus: Ant Design's Tooltip. */
export function InfoTip({ text }: { text: string }) {
  return (
    <span className="ml-1 inline-flex align-middle">
      <Tooltip title={text} styles={{ container: { maxWidth: 224, fontSize: 12 } }}>
        <button type="button" aria-label={text} className="text-faint hover:text-fg focus:text-fg">
          <IconInfo width={13} height={13} />
        </button>
      </Tooltip>
    </span>
  );
}

/** Centered dialog (Ant Design's Modal); closes on Escape or backdrop click. */
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
  if (inPlace) {
    return (
      <div role="dialog" aria-modal aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button aria-label="Close">×</button>
        </header>
        <div>{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    );
  }
  return (
    <AntModal
      open
      centered
      title={title}
      onCancel={onClose}
      width={wide ? 672 : 448}
      destroyOnHidden
      closable={{ "aria-label": "Close" }}
      footer={footer ? <div className="flex items-center justify-end gap-2">{footer}</div> : null}
      styles={{ body: { maxHeight: "70vh", overflowY: "auto" } }}
    >
      {children}
    </AntModal>
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

/** Button that opens a floating panel; clicking away or Escape closes it. Ant Design's Popover. */
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
      <Popover
        trigger="click"
        open={open}
        onOpenChange={setOpen}
        placement={align === "right" ? "bottomRight" : "bottomLeft"}
        arrow={false}
        classNames={{ root: width }}
        styles={{ container: { padding: 4 } }}
        content={
          <div role="menu">
            {open && <EscapeLayer onEscape={close} />}
            {children(close)}
          </div>
        }
      >
        {/* The popover opens and closes itself on a click anywhere in here, so the trigger's own toggle does nothing. */}
        <div>{trigger({ open, toggle: () => undefined })}</div>
      </Popover>
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

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <AntCheckbox checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)}>
      {label}
    </AntCheckbox>
  );
}

export interface ToastItem {
  id: number;
  tone: "ok" | "warn" | "error" | "info";
  text: string;
}

const NOTICE_TYPE = { ok: "success", warn: "warning", error: "error", info: "info" } as const;

/** Pop-up messages at the bottom right (Ant Design's notifications). The page decides how long each stays (it removes it from `items`). */
export function Toasts({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: number) => void }) {
  const [api, holder] = notification.useNotification({ placement: "bottomRight", duration: 0, showProgress: false });
  const shown = useRef(new Set<number>());
  const dismissed = useRef(onDismiss);
  dismissed.current = onDismiss;
  useEffect(() => {
    const live = new Set(items.map((t) => t.id));
    for (const t of items) {
      if (shown.current.has(t.id)) continue;
      shown.current.add(t.id);
      api.open({ key: String(t.id), type: NOTICE_TYPE[t.tone], title: t.text, role: "status", onClose: () => dismissed.current(t.id) });
    }
    for (const id of [...shown.current]) {
      if (live.has(id)) continue;
      shown.current.delete(id);
      api.destroy(String(id));
    }
  }, [items, api]);
  return <>{holder}</>;
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
          <Btn kind="secondary" onClick={onClose}>
            Cancel
          </Btn>
          <Btn kind="primary" onClick={submit} disabled={!allowEmpty && !value.trim()}>
            {confirmLabel}
          </Btn>
        </>
      }
    >
      <Field label={label}>
        <input className={inputClass} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} autoFocus />
      </Field>
    </Modal>
  );
}
