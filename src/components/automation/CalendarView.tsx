"use client";

import { useMemo, useState } from "react";
import { Card, SectionTitle } from "@/components/ui";
import { cn } from "@/lib/format";
import { BTC_LABEL, botTrades, resultsByDay, useBybitReply } from "./BtcTrades";
import { signedDollars, plTone } from "./BybitPanel";
import { nyseCalendarDay, type NyseCalendarDay } from "@/lib/nyseCalendar";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Noon UTC always lands on the same America/New_York calendar date. */
const dayMs = (y: number, m: number, d: number) => Date.UTC(y, m, d, 12);

function etToday(): { y: number; m: number; d: number } {
  const [y, m, d] = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }).split("-").map(Number);
  return { y, m: m - 1, d };
}

function statusOf(y: number, m: number, d: number): NyseCalendarDay & { weekend: boolean } {
  const weekend = [0, 6].includes(new Date(Date.UTC(y, m, d)).getUTCDay());
  return { ...nyseCalendarDay(dayMs(y, m, d)), weekend };
}

const TEXT: Record<NyseCalendarDay["status"], string> = { open: "Regular session", "early-close": "Early close 1:00 PM ET", closed: "Market closed" };

/** The NYSE trading calendar the bots' hours guard follows: no signals are
 * acted on during a closure, and on an early close the window ends 5 minutes
 * before 1:00 PM ET. */
export function CalendarView() {
  const { reply } = useBybitReply(15_000);
  const btcDays = useMemo(() => (reply?.active && reply.view ? resultsByDay(botTrades(reply.view)) : null), [reply]);
  return <CalendarGrid btcDays={btcDays} />;
}

/** The month grid. `btcDays` is the BTC Bybit Bot's net result per New York day (null when Bybit is not the broker). */
export function CalendarGrid({ btcDays = null }: { btcDays?: Map<string, { pnl: number; trades: number }> | null }) {
  const today = useMemo(etToday, []);
  const [cursor, setCursor] = useState({ y: today.y, m: today.m });

  const firstDow = new Date(Date.UTC(cursor.y, cursor.m, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(cursor.y, cursor.m + 1, 0)).getUTCDate();
  const cells: (number | null)[] = [...Array(firstDow).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];

  const upcoming = useMemo(() => {
    const out: { label: string; status: NyseCalendarDay["status"]; date: string }[] = [];
    for (let i = 0; i < 365 && out.length < 8; i++) {
      const dt = new Date(Date.UTC(today.y, today.m, today.d + i, 12));
      const s = statusOf(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
      if (s.status !== "open")
        out.push({
          label: s.label ?? TEXT[s.status],
          status: s.status,
          date: dt.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }),
        });
    }
    return out;
  }, [today]);

  const todayStatus = statusOf(today.y, today.m, today.d);
  const step = (delta: number) =>
    setCursor(({ y, m }) => {
      const dt = new Date(Date.UTC(y, m + delta, 1));
      return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() };
    });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Calendar</h1>

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">
              {MONTHS[cursor.m]} {cursor.y}
            </h2>
            <div className="flex gap-1">
              <button onClick={() => step(-1)} aria-label="Previous month" className="rounded-lg border border-line px-3 py-1 text-sm text-muted hover:text-fg">
                ‹
              </button>
              <button onClick={() => setCursor({ y: today.y, m: today.m })} className="rounded-lg border border-line px-3 py-1 text-sm text-muted hover:text-fg">
                Today
              </button>
              <button onClick={() => step(1)} aria-label="Next month" className="rounded-lg border border-line px-3 py-1 text-sm text-muted hover:text-fg">
                ›
              </button>
            </div>
          </div>

          <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium uppercase tracking-wide text-faint">
            {WEEKDAYS.map((d) => (
              <div key={d} className="py-1">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((d, i) => {
              if (d === null) return <div key={`b${i}`} />;
              const s = statusOf(cursor.y, cursor.m, d);
              const isToday = cursor.y === today.y && cursor.m === today.m && d === today.d;
              const key = `${cursor.y}-${String(cursor.m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
              const btc = btcDays?.get(key);
              return (
                <div
                  key={d}
                  title={btc ? `${BTC_LABEL}: ${btc.trades} trade${btc.trades === 1 ? "" : "s"}, ${signedDollars(btc.pnl)} after fees` : s.label}
                  data-testid={btc ? "btc-day" : undefined}
                  className={cn(
                    "min-h-16 rounded-lg border p-1.5 text-left",
                    isToday ? "border-accent" : "border-line",
                    s.weekend && "bg-surface-2/50 text-faint",
                    s.status === "closed" && "bg-down-soft",
                    s.status === "early-close" && "bg-amber-500/10",
                  )}
                >
                  <div className={cn("tabular text-sm", isToday && "font-semibold text-accent")}>{d}</div>
                  {s.status !== "open" && (
                    <div className={cn("mt-0.5 text-[10px] leading-tight", s.status === "closed" ? "text-down" : "text-amber-500")}>
                      {s.label}
                    </div>
                  )}
                  {btc && (
                    <div className={cn("mt-0.5 text-[10px] font-semibold leading-tight tabular", plTone(btc.pnl))}>
                      {signedDollars(btc.pnl)}
                      <span className="block font-normal text-faint">
                        BTC · {btc.trades} trade{btc.trades === 1 ? "" : "s"}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted">
            <Legend className="bg-down-soft" label="Market closed" />
            <Legend className="bg-amber-500/10" label="Early close (1:00 PM ET)" />
            <Legend className="bg-surface-2/50" label="Weekend" />
            {btcDays && <span className="text-faint">BTC · result of the BTC Bybit Bot that day, after fees ({BTC_LABEL}; New York dates)</span>}
          </div>
        </Card>

        <div className="space-y-4">
          <Card className="p-4">
            <SectionTitle>Today</SectionTitle>
            <div className="text-sm font-medium">
              {todayStatus.weekend ? "Weekend - no trading" : todayStatus.label ?? TEXT[todayStatus.status]}
            </div>
            <p className="mt-1 text-xs text-muted">
              {todayStatus.weekend || todayStatus.status === "closed"
                ? "Bots log any signal as outside hours and place nothing."
                : todayStatus.status === "early-close"
                  ? "Bots stop acting at 12:55 PM ET today."
                  : "Bots act within their configured window (see a bot's Settings)."}
            </p>
          </Card>

          {btcDays && (
            <Card className="p-4" data-testid="btc-days">
              <SectionTitle>{BTC_LABEL}, by day</SectionTitle>
              <p className="mb-2 text-xs text-muted">The BTC Bybit Bot trades around the clock, so this calendar's market hours and closures do not stop it.</p>
              {btcDays.size === 0 ? (
                <p className="text-sm text-muted">No closed trades yet.</p>
              ) : (
                <ul className="divide-y divide-line text-sm">
                  {[...btcDays.entries()]
                    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
                    .slice(0, 10)
                    .map(([day, r]) => (
                      <li key={day} className="flex items-center justify-between gap-3 py-2">
                        <div>
                          <div className="font-medium">{day}</div>
                          <div className="text-xs text-muted">
                            {r.trades} trade{r.trades === 1 ? "" : "s"}
                          </div>
                        </div>
                        <span className={cn("font-semibold tabular", plTone(r.pnl))}>{signedDollars(r.pnl)}</span>
                      </li>
                    ))}
                </ul>
              )}
            </Card>
          )}

          <Card className="p-4">
            <SectionTitle>Upcoming closures</SectionTitle>
            <ul className="divide-y divide-line text-sm">
              {upcoming.map((u) => (
                <li key={u.date + u.label} className="flex items-center justify-between gap-3 py-2">
                  <div>
                    <div className="font-medium">{u.label}</div>
                    <div className="text-xs text-muted">{u.date}</div>
                  </div>
                  <span className={cn("text-xs", u.status === "closed" ? "text-down" : "text-amber-500")}>
                    {u.status === "closed" ? "Closed" : "1:00 PM"}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("h-3 w-3 rounded border border-line", className)} />
      {label}
    </span>
  );
}
