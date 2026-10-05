import { cn } from "@/lib/format";

/** How an account id reads in the UI. Paper accounts get a friendly name;
 * a brokerage account number is masked so it's never shown in full. */
export function accountLabel(id: string): string {
  if (/^paper/i.test(id)) return "Paper Trading";
  const digits = id.match(/^([A-Za-z]{0,4})[-_ ]?(\d{6,})$/);
  if (digits) return `${digits[1] ? `${digits[1].toUpperCase()} ` : "XX "}****${digits[2].slice(-4)}`;
  return id;
}

export type AccountKind = "paper" | "broker" | "other";

export const accountKind = (id: string): AccountKind => (/^paper/i.test(id) ? "paper" : /\d{6,}/.test(id) ? "broker" : "other");

/** A small tile standing in for the account's provider. */
export function AccountIcon({ id, className }: { id: string; className?: string }) {
  const kind = accountKind(id);
  return (
    <span
      aria-hidden
      className={cn(
        "grid h-6 w-6 shrink-0 place-items-center rounded-md text-[11px] font-bold",
        kind === "paper" ? "bg-up-soft text-up" : kind === "broker" ? "bg-accent/15 text-accent" : "bg-surface-2 text-muted",
        className,
      )}
    >
      {kind === "paper" ? "P" : kind === "broker" ? "B" : id.slice(0, 1).toUpperCase()}
    </span>
  );
}
