"use client";

import { Card as AntCard, Segmented as AntSegmented } from "antd";
import type { ReactNode } from "react";
import { cn } from "@/lib/format";
import type { Outcome } from "@/lib/types";
import { IconArrowDown, IconArrowUp, IconCheck, IconX } from "./icons";

/** A panel: Ant Design's Card with no padding of its own (a screen adds its own, as a class, exactly as before). */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <AntCard variant="outlined" className={className} styles={{ body: { padding: 0 } }}>
      {children}
    </AntCard>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-sm font-semibold text-fg">{children}</h2>
      {action}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  icon,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl px-3 py-2.5", className ?? "border border-line bg-surface")}>
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
        {icon}
        {label}
      </div>
      <div className="tabular mt-1 text-lg font-semibold leading-tight">{value}</div>
      {hint && <div className="tabular mt-0.5 text-xs text-faint">{hint}</div>}
    </div>
  );
}

export function DirectionPill({ dir, size = "sm" }: { dir: Outcome; size?: "sm" | "md" }) {
  const Icon = dir === "up" ? IconArrowUp : dir === "down" ? IconArrowDown : null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md font-semibold uppercase",
        size === "sm" ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1 text-xs",
        dir === "up" && "bg-up-soft text-up",
        dir === "down" && "bg-down-soft text-down",
        dir === "flat" && "bg-surface-2 text-muted",
      )}
    >
      {Icon && <Icon width={size === "sm" ? 11 : 13} height={size === "sm" ? 11 : 13} />}
      {dir}
    </span>
  );
}

export function ResultMark({ correct, size = 22 }: { correct: boolean; size?: number }) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full",
        correct ? "bg-up-soft text-up" : "bg-down-soft text-down",
      )}
      style={{ width: size, height: size }}
      aria-label={correct ? "Correct" : "Incorrect"}
    >
      {correct ? <IconCheck width={size * 0.55} height={size * 0.55} /> : <IconX width={size * 0.55} height={size * 0.55} />}
    </span>
  );
}

export function Avatar({ name, hue, size = 36 }: { name: string; hue: number; size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full font-semibold uppercase text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: `linear-gradient(135deg, hsl(${hue} 65% 52%), hsl(${(hue + 40) % 360} 70% 38%))`,
      }}
      aria-hidden
    >
      {name.replace(/[^a-z0-9]/gi, "").slice(0, 2) || "?"}
    </span>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return <AntSegmented<T> options={options} value={value} onChange={onChange} />;
}
