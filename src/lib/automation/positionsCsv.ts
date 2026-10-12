import { positionPL, positionPLKind, positionQuantity } from "./pnl";
import type { Position } from "./types";

/** The most positions one export holds, as in Option Alpha. */
export const EXPORT_LIMIT = 10_000;

const COLUMNS = ["Position ID", "Bot", "Symbol", "Strategy", "Status", "Opened (UTC)", "Closed (UTC)", "Expiration", "Contracts", "Short strike", "Long strike", "Credit", "Close price", "P/L", "P/L source", "Tags", "Notes"] as const;

/** One cell of a spreadsheet file. A value that starts with = + - @ would be run as a formula when the file is opened (a note or a tag is
 * typed by a person), so it is written with a leading apostrophe; quotes, commas and line breaks are escaped. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const iso = (ms: number | null) => (ms == null ? "" : new Date(ms).toISOString());

/** The positions as a CSV file (at most EXPORT_LIMIT, newest first as given). */
export function positionsToCsv(positions: Position[], botName: (id: string) => string): string {
  const rows = positions.slice(0, EXPORT_LIMIT).map((p) => {
    const pl = positionPL(p);
    return [
      p.id,
      botName(p.botId),
      p.underlying,
      p.type === "short_put_spread" ? "Short Put Spread" : "Short Call Spread",
      p.status,
      iso(p.openedAt),
      iso(p.closedAt),
      p.expiry,
      positionQuantity(p),
      p.shortStrike,
      p.longStrike,
      p.credit,
      p.closePrice,
      pl,
      positionPLKind(p) ?? "",
      (p.tags ?? []).join("; "),
      p.notes ?? "",
    ].map(csvCell).join(",");
  });
  return [COLUMNS.join(","), ...rows].join("\r\n") + "\r\n";
}
