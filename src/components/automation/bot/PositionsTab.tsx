"use client";

import { planStrikes } from "@/lib/automation/strikes";
import { useEffect, useMemo, useState } from "react";
import { IconChevronDown, IconMore, IconPlus } from "@/components/icons";
import { Card } from "@/components/ui";
import { cn } from "@/lib/format";
import { positionPL, positionPremium, positionQuantity, positionRisk } from "@/lib/automation/pnl";
import { ACTIVE_POSITION_STATUSES, type BotStaticConfig, type Order, type Position, type PositionType, type Signal } from "@/lib/automation/types";
import type { BotContext } from "./BotDetail";
import { LegPills } from "./LegPills";
import { PositionDetails, type PositionBot } from "./PositionDetails";
import {
  Checkbox,
  Dropdown,
  Drawer,
  Field,
  InfoTip,
  KeyValue,
  MenuItem,
  Modal,
  Pill,
  Td,
  Th,
  buttonClass,
  inputClass,
  type ToastItem,
} from "./primitives";
import { NO_PRICE_TIP, TYPE_LABEL, etDateTime, etDayKey, etShortTime, groupByDay, num, pctText, plClass, plText, usd, usd2 } from "./model";

/** Phase 1 has no option chain, so an open position's mark, P/L and net
 * liquidation value are unknown; premium and risk come from the credit. */
const OPEN_PRICE_TIP = "Needs live option prices, which Phase 1 doesn't have.";

const STATUS_TONE: Record<string, "ok" | "skip" | "warn" | "error" | "info"> = {
  opening: "info",
  open: "ok",
  closing: "warn",
  closed: "ok",
  expired: "info",
  rejected: "error",
};

export interface PositionsViewProps {
  positions: Position[];
  orders: Order[];
  signals: Signal[];
  now: number;
  /** The configured expected credit for a bot, used until a fill reports a real one. */
  estimateFor: (botId: string) => number | undefined;
  /** When given, a Bot column is shown (the all-bots page). */
  botName?: (botId: string) => string;
  /** Name and account of a position's bot, for its details panel. Falls back to botName. */
  botInfo?: (botId: string) => PositionBot;
  /** Single-bot mode only: enables "+ New Position". */
  newPosition?: { botId: string; config: BotStaticConfig };
  onChanged: () => void;
  notify: (tone: ToastItem["tone"], text: string) => void;
  /** Called by "Analyze results" (e.g. to scroll/focus). Optional. */
  initialClosedOpen?: boolean;
  /** Open this position's details as soon as it's in the list ("View position"). */
  focusPositionId?: string | null;
  onFocusHandled?: () => void;
}

export function PositionsTab({ ctx }: { ctx: BotContext }) {
  const { data } = ctx;
  return (
    <PositionsView
      positions={data.positions}
      orders={data.orders}
      signals={data.signals}
      now={data.now}
      estimateFor={() => data.config?.openingCreditEstimate}
      botInfo={() => ({ id: data.bot.id, name: data.bot.name, accountId: data.bot.accountId })}
      newPosition={data.config ? { botId: data.bot.id, config: data.config } : undefined}
      onChanged={ctx.reload}
      notify={ctx.notify}
      focusPositionId={ctx.focusPositionId}
      onFocusHandled={ctx.clearFocusPosition}
    />
  );
}

/** Last price of each underlying the positions trade (SPX, NDX...), polled lightly - the "Last" column.
 * null when there's no live quote for it. */
function useLasts(symbols: string[]): Record<string, number | null> {
  const [prices, setPrices] = useState<Record<string, number | null>>({});
  const key = [...new Set(symbols)].sort().join(",");
  useEffect(() => {
    let alive = true;
    const list = key ? key.split(",") : [];
    const tick = () =>
      list.forEach((symbol) =>
        fetch(`/api/quote?symbol=${encodeURIComponent(symbol)}`)
          .then((r) => r.json())
          .then((q) => alive && setPrices((p) => ({ ...p, [symbol]: typeof q?.tick?.price === "number" ? q.tick.price : null })))
          .catch(() => undefined),
      );
    tick();
    const id = setInterval(tick, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [key]);
  return prices;
}

const dayDiff = (fromKey: string, toKey: string) => Math.round((Date.parse(toKey) - Date.parse(fromKey)) / 86_400_000);
const weekday = (label: string) => label.split(",")[0].toUpperCase();

export function PositionsView(props: PositionsViewProps) {
  const { positions, orders, signals, now, estimateFor, botName, botInfo, newPosition, onChanged, notify } = props;
  const [selected, setSelected] = useState<Position | null>(null);
  const [adding, setAdding] = useState(false);
  const [closedOpen, setClosedOpen] = useState(props.initialClosedOpen ?? true);
  const [showTags, setShowTags] = useState(false);
  const [status, setStatus] = useState<"all" | "closed" | "expired" | "rejected">("all");
  const underlying = newPosition?.config.underlying ?? positions[0]?.underlying ?? "SPX";
  const symbols = [...new Set([underlying, ...positions.map((p) => p.underlying)])];
  const lasts = useLasts(symbols);
  const lastOf = (p: { underlying: string }) => lasts[p.underlying] ?? null;
  const last = lasts[underlying] ?? null;

  // "View position" from the Log: open that position once it's here.
  useEffect(() => {
    if (!props.focusPositionId) return;
    const target = positions.find((p) => p.id === props.focusPositionId);
    if (target) setSelected(target);
    props.onFocusHandled?.();
  }, [props.focusPositionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = positions.filter((p) => ACTIVE_POSITION_STATUSES.includes(p.status));
  const closed = positions.filter((p) => !ACTIVE_POSITION_STATUSES.includes(p.status)).filter((p) => status === "all" || p.status === status);
  const closedGroups = groupByDay(closed, (p) => p.closedAt ?? p.openedAt ?? 0, now);
  const signalById = useMemo(() => new Map(signals.map((s) => [s.id, s])), [signals]);

  const table = { estimateFor, botName, onSelect: setSelected, lastOf, now, signalById, showTags };

  const totals = open.reduce(
    (acc, p) => {
      acc.premium += positionPremium(p, estimateFor(p.botId)) ?? 0;
      acc.risk += positionRisk(p, estimateFor(p.botId)) ?? 0;
      return acc;
    },
    { premium: 0, risk: 0 },
  );

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">Open positions</h2>
          <div className="flex items-center gap-4">
            <Checkbox checked={showTags} onChange={setShowTags} label="Show tags" />
            {newPosition && (
              <button className={cn(buttonClass.secondary, "flex items-center gap-1.5 !py-1.5")} onClick={() => setAdding(true)}>
                <IconPlus width={14} height={14} /> New position
              </button>
            )}
          </div>
        </div>
        {open.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">No open positions.</p>
        ) : (
          <OpenTable positions={open} totals={totals} {...table} />
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <button onClick={() => setClosedOpen((o) => !o)} aria-expanded={closedOpen} className="flex items-center gap-1.5 text-sm font-semibold">
            Closed positions
            <IconChevronDown width={14} height={14} className={cn("text-faint transition-transform", !closedOpen && "-rotate-90")} />
          </button>
          {closedOpen && (
            <div className="flex flex-wrap items-center gap-2">
              <Checkbox checked={showTags} onChange={setShowTags} label="Show tags" />
              <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status" className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm outline-none focus:border-fg">
                <option value="all">Status: all</option>
                <option value="closed">Closed</option>
                <option value="expired">Expired</option>
                <option value="rejected">Rejected</option>
              </select>
              <select aria-label="Symbol" className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm outline-none focus:border-fg" defaultValue={symbols[0]}>
                {symbols.map((s) => (
                  <option key={s} value={s}>
                    Symbol: {s}
                  </option>
                ))}
              </select>
              <Dropdown
                align="right"
                trigger={({ toggle }) => (
                  <button onClick={toggle} aria-label="More" className="grid h-8 w-8 place-items-center rounded-lg border border-line text-muted hover:text-fg">
                    <IconMore width={16} height={16} />
                  </button>
                )}
              >
                {(close) => (
                  <>
                    {newPosition ? (
                      <>
                        <a href={`/api/automation/bots/${newPosition.botId}/export?kind=positions&format=csv`} onClick={close} className="block rounded-lg px-3 py-2 text-sm hover:bg-surface-2">
                          Export positions (CSV)
                        </a>
                        <a href={`/api/automation/bots/${newPosition.botId}/export?kind=all&format=json`} onClick={close} className="block rounded-lg px-3 py-2 text-sm hover:bg-surface-2">
                          Export everything (JSON)
                        </a>
                      </>
                    ) : (
                      <MenuItem disabled onClick={close}>Export from a bot&apos;s page</MenuItem>
                    )}
                  </>
                )}
              </Dropdown>
            </div>
          )}
        </div>
        {closedOpen &&
          (closed.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted">Nothing closed yet.</p>
          ) : (
            closedGroups.map(([label, rows]) => (
              <div key={label}>
                <div className="bg-surface-2/60 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{label === "Today" || label === "Yesterday" ? label : weekday(label)}</div>
                <ClosedTable positions={rows} {...table} />
              </div>
            ))
          ))}
      </Card>

      {selected && (
        <PositionDetails
          position={positions.find((p) => p.id === selected.id) ?? selected}
          orders={orders}
          signals={signals}
          estimate={estimateFor(selected.botId)}
          bot={botInfo?.(selected.botId) ?? { id: selected.botId, name: botName?.(selected.botId) ?? selected.botId }}
          last={lastOf(positions.find((p) => p.id === selected.id) ?? selected)}
          now={now}
          onClose={() => setSelected(null)}
          onChanged={onChanged}
          notify={notify}
        />
      )}
      {adding && newPosition && <NewPositionModal config={newPosition.config} botId={newPosition.botId} last={last} onClose={() => setAdding(false)} onDone={onChanged} notify={notify} />}
    </div>
  );
}

interface TableProps {
  estimateFor: (botId: string) => number | undefined;
  botName?: (botId: string) => string;
  onSelect: (p: Position) => void;
  lastOf: (p: Position) => number | null;
  now: number;
  signalById: Map<string, Signal>;
  showTags: boolean;
}

function Description({ p, showTags }: { p: Position; showTags?: boolean }) {
  return (
    <div>
      <div className="font-medium">{p.underlying}</div>
      <div className="text-xs text-muted">
        {TYPE_LABEL[p.type]}
        {p.manual ? " · manual" : ""}
      </div>
      {showTags && (p.tags?.length ?? 0) > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {p.tags!.map((t) => (
            <span key={t} className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function OpenTable({ positions, totals, estimateFor, botName, onSelect, lastOf, now, showTags }: TableProps & { positions: Position[]; totals: { premium: number; risk: number } }) {
  const today = etDayKey(now);
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-line">
            <Th>Description</Th>
            {botName && <Th>Bot</Th>}
            <Th>Legs</Th>
            <Th right>Last</Th>
            <Th right>DTE</Th>
            <Th right>Qty</Th>
            <Th right>P/L<InfoTip text={OPEN_PRICE_TIP} /></Th>
            <Th right>ROR<InfoTip text="Return on risk: P/L divided by the capital at risk. Needs P/L." /></Th>
            <Th right>Net liq<InfoTip text={OPEN_PRICE_TIP} /></Th>
            <Th right>Premium</Th>
            <Th right>Risk</Th>
            <Th right>DIT</Th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const est = estimateFor(p.botId);
            return (
              <tr key={p.id} onClick={() => onSelect(p)} className="cursor-pointer border-b border-line last:border-b-0 hover:bg-surface-2/60">
                <Td><Description p={p} showTags={showTags} /></Td>
                {botName && <Td className="text-muted">{botName(p.botId)}</Td>}
                <Td><LegPills p={p} /></Td>
                <Td right>{lastOf(p) != null ? num(lastOf(p)!) : "—"}</Td>
                <Td right><span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-xs">{Math.max(0, dayDiff(today, p.expiry))}d</span></Td>
                <Td right>{p.filledQuantity ? `${p.filledQuantity}/${p.requestedQuantity}` : p.requestedQuantity}</Td>
                <Td right className="text-faint">—</Td>
                <Td right className="text-faint">—</Td>
                <Td right className="text-faint">—</Td>
                <Td right>{fmt(positionPremium(p, est), (v) => `+${usd(v)}`)}</Td>
                <Td right>{fmt(positionRisk(p, est), usd)}</Td>
                <Td right>{p.openedAt ? `${Math.max(0, dayDiff(etDayKey(p.openedAt), today))}d` : "—"}</Td>
              </tr>
            );
          })}
          <tr className="border-t border-line bg-surface-2/40 font-medium">
            <Td>Total</Td>
            {botName && <Td />}
            <Td /><Td /><Td /><Td /><Td /><Td /><Td />
            <Td right>+{usd(totals.premium)}</Td>
            <Td right>{usd(totals.risk)}</Td>
            <Td />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const fmt = (v: number | null, f: (n: number) => string) => (v == null ? "—" : f(v));

function ClosedTable({ positions, estimateFor, botName, onSelect, signalById, showTags }: TableProps & { positions: Position[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-line">
            <Th>Description</Th>
            {botName && <Th>Bot</Th>}
            <Th>Legs</Th>
            <Th>Exp</Th>
            <Th>Status</Th>
            <Th right>Qty</Th>
            <Th right>Trade pr</Th>
            <Th right>Close price</Th>
            <Th right>P/L<InfoTip text={NO_PRICE_TIP} /></Th>
            <Th right>ROR</Th>
            <Th right>Premium</Th>
            <Th right>Risk</Th>
            <Th right>Price at open / close</Th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const est = estimateFor(p.botId);
            const pl = positionPL(p);
            const risk = positionRisk(p, est);
            const atOpen = p.underlyingAtOpen ?? (p.openSignalId ? signalById.get(p.openSignalId)?.price : undefined);
            const atClose = p.underlyingAtClose ?? (p.closeSignalId ? signalById.get(p.closeSignalId)?.price : undefined);
            return (
              <tr key={p.id} onClick={() => onSelect(p)} className="cursor-pointer border-b border-line last:border-b-0 hover:bg-surface-2/60">
                <Td><Description p={p} showTags={showTags} /></Td>
                {botName && <Td className="text-muted">{botName(p.botId)}</Td>}
                <Td><LegPills p={p} /></Td>
                <Td className="text-muted">{p.expiry.slice(5)}</Td>
                <Td>
                  <Pill tone={STATUS_TONE[p.status] ?? "neutral"}>{p.status[0].toUpperCase() + p.status.slice(1)}</Pill>
                  {p.closedAt && <div className="mt-0.5 text-[11px] text-faint">{new Date(p.closedAt).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" })}</div>}
                </Td>
                <Td right>{positionQuantity(p)}</Td>
                <Td right>{p.credit != null ? usd2(p.credit) : "—"}</Td>
                <Td right>{p.closePrice != null ? usd2(p.closePrice) : "—"}</Td>
                <Td right className={plClass(pl)}>{plText(pl)}</Td>
                <Td right className={plClass(pl)}>{pl != null && risk ? pctText(pl / risk) : "—"}</Td>
                <Td right>{fmt(positionPremium(p, est), (v) => `+${usd(v)}`)}</Td>
                <Td right>{fmt(risk, usd)}</Td>
                <Td right className="text-muted">
                  {atOpen != null ? num(atOpen) : "—"} / {atClose != null ? num(atClose) : "—"}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** "+ New position": explicit short strike, long strike derived from the bot's width. */
function NewPositionModal({
  config,
  botId,
  last,
  onClose,
  onDone,
  notify,
}: {
  config: BotStaticConfig;
  botId: string;
  last: number | null;
  onClose: () => void;
  onDone: () => void;
  notify: (tone: ToastItem["tone"], text: string) => void;
}) {
  const [type, setType] = useState<PositionType>("short_put_spread");
  const suggest = (t: PositionType) => {
    if (last == null) return "";
    return String(planStrikes(t, last, config).shortStrike);
  };
  const [shortStrike, setShortStrike] = useState(suggest("short_put_spread"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const short = Number(shortStrike);
  const valid = shortStrike.trim() !== "" && Number.isFinite(short);
  const long = !valid ? null : type === "short_put_spread" ? short - config.widthPoints : short + config.widthPoints;
  const risk = (config.widthPoints - config.openingCreditEstimate) * 100 * config.quantity;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/automation/bots/${botId}/positions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, shortStrike: short }) });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(json.result?.reason ?? json.error ?? "The position wasn't opened.");
    notify("ok", "Position opened.");
    onDone();
    onClose();
  };

  return (
    <Modal
      title="New position"
      onClose={onClose}
      footer={
        <>
          <button className={buttonClass.secondary} onClick={onClose}>
            Cancel
          </button>
          <button className={buttonClass.primary} onClick={submit} disabled={busy || !valid}>
            {busy ? "Opening..." : "Open position"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Places a position through the same guards as a signal (hours, limits, allocation, strike checks). Quantity and width come from the bot&apos;s inputs.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {(["short_put_spread", "short_call_spread"] as const).map((t) => (
            <button
              key={t}
              aria-pressed={type === t}
              onClick={() => {
                setType(t);
                setShortStrike(suggest(t));
              }}
              className={cn("rounded-lg border px-3 py-2.5 text-left text-sm", type === t ? "border-accent bg-accent/10" : "border-line hover:bg-surface-2")}
            >
              {TYPE_LABEL[t]}
            </button>
          ))}
        </div>
        <Field label="Short strike" hint={last != null ? `Suggested from ${config.underlying} ${num(last)} and the bot's offset.` : "No live quote - enter the strike."}>
          <input className={inputClass} inputMode="decimal" value={shortStrike} onChange={(e) => setShortStrike(e.target.value)} />
        </Field>
        <KeyValue
          rows={[
            ["Long strike", long != null ? String(long) : "—"],
            ["Quantity", config.quantity],
            ["Expected credit", usd2(config.openingCreditEstimate)],
            ["Max risk", usd(risk)],
          ]}
        />
        {error && <p className="rounded-lg bg-down-soft px-3 py-2 text-sm text-down">{error}</p>}
      </div>
    </Modal>
  );
}
