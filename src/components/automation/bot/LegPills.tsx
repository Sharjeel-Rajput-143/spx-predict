import { cn } from "@/lib/format";
import type { Position } from "@/lib/automation/types";

/** Strike pills: the sold leg's letter badge is red, the bought leg's green. */
export function LegPills({ p }: { p: Position }) {
  const letter = p.type === "short_put_spread" ? "P" : "C";
  const pill = (strike: number, role: "sold" | "bought") => (
    <span title={role === "sold" ? "Sold (short) leg" : "Bought (long) leg"} className="inline-flex items-center gap-1 rounded-md bg-surface-2 py-0.5 pl-1.5 pr-0.5 text-xs">
      <span className="tabular">{strike}</span>
      <span className={cn("grid h-4 w-4 place-items-center rounded-full text-[9px] font-bold text-white", role === "sold" ? "bg-down" : "bg-up")}>{letter}</span>
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1">
      {pill(p.shortStrike, "sold")}
      {pill(p.longStrike, "bought")}
    </span>
  );
}

