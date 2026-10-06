"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AccountIcon, accountLabel } from "@/components/automation/accounts";
import { IconAutomation, IconCopy, IconEdit } from "@/components/icons";
import { cn } from "@/lib/format";
import { breakeven, maxLoss, maxProfit, otmFraction, rewardRisk, type Spread } from "@/lib/automation/payoff";
import { positionPL, positionPLKind, positionPremium, positionQuantity, positionRisk } from "@/lib/automation/pnl";
import type { Order, Position, Signal } from "@/lib/automation/types";
import { POSITION_TYPES } from "../builder/model";
import { PayoffChart } from "./PayoffChart";
import { Drawer, InfoTip, Modal, Pill, buttonClass, inputClass, type ToastItem } from "./primitives";
import { LegPills } from "./LegPills";
import { NO_PRICE_TIP, TYPE_LABEL, etDateTime, etDayKey, num, pctText, plClass, plText, usd, usd2 } from "./model";

const NEEDS_CHAIN = "Needs live option prices (an option chain), which Phase 1 doesn't have.";
const NEEDS_MODEL = "Needs option prices and a pricing model, which Phase 1 doesn't have. Nothing is estimated.";

export interface PositionBot {
  id: string;
  name: string;
  accountId?: string | null;
}

interface Props {
  position: Position;
  orders: Order[];
  signals: Signal[];
  estimate: number | undefined;
  bot: PositionBot;
  /** The underlying's last price (live quote), or null when there isn't one. */
  last: number | null;
  now: number;
  onClose: () => void;
  onChanged: () => void;
  notify: (tone: ToastItem["tone"], text: string) => void;
}

const dayDiff = (fromKey: string, toKey: string) => Math.round((Date.parse(toKey) - Date.parse(fromKey)) / 86_400_000);

/** Everything about one position: the numbers that follow from its own
 * trade, the payoff at expiry, exit options, its bot, its fills, tags and notes. */
export function PositionDetails({ position: p, orders: allOrders, signals, estimate, bot, last, now, onClose, onChanged, notify }: Props) {
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [closing, setClosing] = useState(false);
  const [moving, setMoving] = useState(false);

  const credit = p.credit ?? estimate ?? null;
  const quantity = positionQuantity(p);
  const kind = p.type === "short_put_spread" ? "put" : "call";
  const letter = kind === "put" ? "P" : "C";
  const width = Math.abs(p.shortStrike - p.longStrike);
  const premium = positionPremium(p, estimate);
  const risk = positionRisk(p, estimate);
  const pl = positionPL(p);
  const plKind = positionPLKind(p);
  const plSource = plKind === "estimated" ? "estimated from the underlying's price at the end-of-day sweep" : plKind === "manual" ? "entered by hand" : null;
  const spread: Spread | null = credit != null ? { type: p.type, shortStrike: p.shortStrike, longStrike: p.longStrike, credit, quantity } : null;

  const openSignal = p.openSignalId ? signals.find((s) => s.id === p.openSignalId) : undefined;
  const atOpen = p.underlyingAtOpen ?? openSignal?.price ?? null;
  const underlying = last ?? atOpen;
  const underlyingLabel = last != null ? `${p.underlying} now` : `${p.underlying} at open`;
  const otm = spread && underlying != null ? otmFraction(p, underlying) : null;

  const today = etDayKey(now);
  const endKey = p.closedAt ? etDayKey(p.closedAt) : today;
  const dit = p.openedAt ? Math.max(0, dayDiff(etDayKey(p.openedAt), endKey)) : null;
  const dte = Math.max(0, dayDiff(today, p.expiry));
  const expiryPill = new Date(`${p.expiry}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).toUpperCase();
  const closable = p.status === "open" || p.status === "closing";
  const orders = allOrders.filter((o) => o.positionId === p.id).sort((a, b) => a.createdAt - b.createdAt);

  const summary = `${p.underlying} ${TYPE_LABEL[p.type]} ${p.shortStrike}/${p.longStrike} ${letter}, exp ${p.expiry}, ${quantity} contracts${credit != null ? `, credit ${usd2(credit)}` : ""}`;

  const copy = () =>
    navigator.clipboard
      ?.writeText(summary)
      .then(() => notify("ok", "Position summary copied."))
      .catch(() => notify("error", "Couldn't copy."));

  const doClose = async () => {
    setClosing(true);
    const res = await fetch(`/api/automation/positions/${p.id}/close`, { method: "POST" });
    const json = await res.json().catch(() => ({}));
    setClosing(false);
    setConfirmingClose(false);
    res.ok ? notify("ok", "Position closed.") : notify("error", json.result?.reason ?? json.error ?? "The close failed.");
    onChanged();
  };

  const headerActions = (
    <>
      <button onClick={copy} aria-label="Copy position summary" title="Copy a one-line summary" className="grid h-8 w-8 place-items-center rounded-lg border border-line text-muted hover:text-fg">
        <IconCopy width={15} height={15} />
      </button>
      {closable && (
        <button onClick={() => setConfirmingClose(true)} className={cn(buttonClass.secondary, "!border-down/40 !py-1.5 text-down")}>
          Close position
        </button>
      )}
      <button disabled title="Overriding a position's status isn't available in Phase 1" className={cn(buttonClass.secondary, "!py-1.5")}>
        Override
      </button>
    </>
  );

  return (
    <Drawer title="Position details" onClose={onClose} extraWide headerActions={headerActions}>
      <div className="space-y-6">
        {/* Header strip */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-lg bg-accent/10 px-2.5 py-1.5 text-sm font-bold text-accent">{p.underlying}</span>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold">{POSITION_TYPES[p.type]}</span>
              <span className="rounded-md bg-surface-2 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-muted">{expiryPill}</span>
              <Pill tone={p.status === "open" ? "ok" : p.status === "rejected" ? "error" : "neutral"}>{p.status}</Pill>
              {p.manual && <Pill>Manual</Pill>}
            </div>
            <div className="mt-1.5">
              <LegPills p={p} />
            </div>
          </div>
        </div>

        {/* Core metrics */}
        <div className="grid gap-x-8 sm:grid-cols-2">
          <Rows
            rows={[
              ["Total P/L", <span key="a" className={plClass(pl)}>{plText(pl)}{plSource && <span className="ml-1.5 text-[11px] font-medium text-faint">{plKind === "estimated" ? "estimated" : "by hand"}</span>}</span>, plSource ? `This result was ${plSource}, not read from a fill.` : NO_PRICE_TIP],
              ["Return %", <span key="b" className={plClass(pl)}>{pl != null && premium ? pctText(pl / premium) : "—"}</span>, "Total P/L divided by the credit received."],
              ["Credit to open", premium != null ? usd(premium) : "—"],
              ["Market value", "—", NEEDS_CHAIN],
              ["Capital at risk", risk != null ? usd(risk) : "—", "Maximum loss: (width - credit) x 100 x quantity."],
              ["Return on risk", <span key="c" className={plClass(pl)}>{pl != null && risk ? pctText(pl / risk) : "—"}</span>, "Total P/L divided by the capital at risk."],
            ]}
          />
          <Rows
            rows={[
              ["Trade price", credit != null ? `${usd2(credit)}${p.credit == null ? " (est.)" : ""}` : "—"],
              ["Mid price", "—", NEEDS_CHAIN],
              ["Bid / ask", "—", NEEDS_CHAIN],
              ["Quantity", `${quantity} contract${quantity === 1 ? "" : "s"}`],
              ["DIT", dit != null ? `${dit} day${dit === 1 ? "" : "s"}` : "—", "Days in trade."],
              ["Price at open", atOpen != null ? num(atOpen) : "—", `${p.underlying} at the signal that opened it.`],
            ]}
          />
        </div>

        {/* Greeks */}
        <div className="grid grid-cols-4 gap-3 rounded-xl border border-line px-4 py-3 text-center">
          {["Delta", "Theta", "Gamma", "Vega"].map((g) => (
            <div key={g}>
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
                {g}
                <InfoTip text={NEEDS_MODEL} />
              </div>
              <div className="tabular mt-1 text-sm font-medium text-faint">—</div>
            </div>
          ))}
        </div>

        {/* Probability / risk */}
        <div className="grid gap-x-8 sm:grid-cols-2">
          <Rows
            rows={[
              [
                "Reward/risk",
                spread && rewardRisk(spread) != null ? <Pill key="rr" tone="ok">{pctText(rewardRisk(spread), 1, false)}</Pill> : "—",
                "Max profit divided by max loss.",
              ],
              ["OTM %", otm != null ? <span key="otm" className={otm < 0 ? "text-down" : undefined}>{pctText(otm, 2, false)}</span> : "—", `How far the short strike is out of the money, against ${underlyingLabel}. Negative means in the money.`],
              ["Breakeven", spread ? num(breakeven(spread)) : "—", "Where the position neither gains nor loses at expiry."],
              ["Max profit", spread ? <span key="mp" className="text-up">{usd(maxProfit(spread))}</span> : "—"],
              ["Max loss", spread ? <span key="ml" className="text-down">{usd(maxLoss(spread))}</span> : "—"],
            ]}
          />
          <Rows
            rows={[
              ["Alpha", "—", NEEDS_MODEL],
              ["EV", "—", NEEDS_MODEL],
              ["Prob of profit", "—", NEEDS_MODEL],
              ["Prob of max profit", "—", NEEDS_MODEL],
              ["Prob of max loss", "—", NEEDS_MODEL],
            ]}
          />
        </div>

        {/* Payoff */}
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Profit and loss at expiry</h3>
          {spread ? (
            <PayoffChart spread={spread} underlying={underlying} underlyingLabel={underlyingLabel} />
          ) : (
            <p className="rounded-lg bg-surface-2 px-3 py-6 text-center text-sm text-muted">No credit is known for this position yet, so there is nothing to draw.</p>
          )}
          {underlying != null && <p className="mt-2 text-[11px] text-faint">Blue pill: {underlyingLabel}. Hover the chart for P/L at any price.</p>}
        </section>

        {/* Exit options */}
        <section className="rounded-xl border border-line">
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
            <div className="flex items-center gap-3 text-sm font-semibold">
              Exit options
              <button disabled title="Exit options need live option prices, which Phase 1 doesn't have." className="text-xs font-medium text-faint">
                Edit
              </button>
              <button disabled title="There are no exit-option statistics to reset." className="text-xs font-medium text-faint">
                Reset stats
              </button>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-md bg-down-soft px-2 py-0.5 text-[11px] font-medium text-down">⚠ Bot exit options are off</span>
          </div>
          <Rows
            flush
            rows={[
              ["Profit %", "None"],
              ["Profit $", "None"],
              ["Stop loss %", "None"],
              ["Stop loss $", "None"],
              ["Expiration", `${dte} day${dte === 1 ? "" : "s"} to expiration`],
            ]}
          />
          <p className="border-t border-line px-4 py-2 text-[11px] text-faint">Profit targets and stop losses need live option prices, so they aren&apos;t built in Phase 1.</p>
        </section>

        {/* Bot */}
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Bot</h3>
          <div className="flex items-center gap-3 rounded-xl border border-line px-4 py-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
              <IconAutomation width={18} height={18} />
            </span>
            <div className="min-w-0 flex-1">
              <Link href={`/automation/bots/${bot.id}`} className="block truncate text-sm font-semibold hover:text-accent">
                {bot.name}
              </Link>
              {bot.accountId && (
                <span className="flex items-center gap-1.5 text-xs text-muted">
                  <AccountIcon id={bot.accountId} className="h-4 w-4 text-[9px]" /> {accountLabel(bot.accountId)}
                </span>
              )}
            </div>
            <button
              className={cn(buttonClass.secondary, "!py-1.5")}
              onClick={() => setMoving(true)}
              disabled={p.status !== "open"}
              title={p.status === "open" ? "Move this position to another bot" : "Only an open position can be moved"}
            >
              Move
            </button>
          </div>
        </section>

        {/* Trades */}
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Trades</h3>
          {orders.length === 0 ? (
            <p className="text-sm text-muted">No orders sent.</p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {orders.map((o) => {
                const filled = o.status === "filled" || o.status === "partially_filled";
                const price = o.kind === "open" ? credit : p.closePrice;
                const movement = o.kind === "open" ? `${o.limitPrice.toFixed(2)} → ${credit != null ? credit.toFixed(2) : "—"}` : `→ ${p.closePrice != null ? p.closePrice.toFixed(2) : "—"}`;
                return (
                  <li key={o.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium">
                          {o.kind === "open" ? "Open" : "Close"} {o.filledQuantity || quantity} contract{(o.filledQuantity || quantity) === 1 ? "" : "s"} - {etDateTime(o.updatedAt)}
                        </div>
                        <div className="tabular mt-0.5 text-xs text-muted">{movement}</div>
                      </div>
                      <div className="text-right text-sm">
                        {filled ? <span className="font-medium">{price != null ? `filled at ${usd2(price)}` : "filled"}</span> : <Pill tone={o.status === "rejected" ? "error" : "neutral"}>{o.status}</Pill>}
                        {o.rejectReason && <div className="text-xs text-down">{o.rejectReason}</div>}
                      </div>
                    </div>
                    <Link href={`/automation/bots/${bot.id}?tab=log`} className="mt-1.5 inline-block text-xs font-medium text-accent hover:underline">
                      Automation log
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <TagsBlock position={p} onChanged={onChanged} notify={notify} />
        <NotesBlock position={p} onChanged={onChanged} notify={notify} />
      </div>

      {confirmingClose && (
        <Modal
          title="Close this position?"
          onClose={() => setConfirmingClose(false)}
          footer={
            <>
              <button className={buttonClass.secondary} onClick={() => setConfirmingClose(false)}>
                Cancel
              </button>
              <button className={buttonClass.danger} onClick={doClose} disabled={closing}>
                {closing ? "Closing..." : "Close position"}
              </button>
            </>
          }
        >
          <p className="text-sm text-muted">
            Sends a close order for {p.underlying} {p.shortStrike}/{p.longStrike} {kind} spread to the executor now. If the close fails, the bot is flagged as needing attention.
          </p>
        </Modal>
      )}
      {moving && <MoveModal position={p} currentBot={bot} onClose={() => setMoving(false)} onMoved={() => { setMoving(false); onClose(); onChanged(); }} notify={notify} />}
    </Drawer>
  );
}

function Rows({ rows, flush }: { rows: [string, React.ReactNode, string?][]; flush?: boolean }) {
  return (
    <dl className={cn("divide-y divide-line text-sm", flush && "px-4")}>
      {rows.map(([label, value, tip]) => (
        <div key={label} className="flex items-center justify-between gap-4 py-2">
          <dt className="text-muted">
            {label}
            {tip && <InfoTip text={tip} />}
          </dt>
          <dd className="tabular text-right font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function TagsBlock({ position: p, onChanged, notify }: { position: Position; onChanged: () => void; notify: Props["notify"] }) {
  const [draft, setDraft] = useState("");
  const tags = p.tags ?? [];
  const save = async (next: string[]) => {
    const res = await fetch(`/api/automation/positions/${p.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tags: next }) });
    if (!res.ok) notify("error", "Couldn't save the tags.");
    onChanged();
  };
  const add = () => {
    const t = draft.trim();
    setDraft("");
    if (t && !tags.includes(t)) save([...tags, t]);
  };
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Tags</h3>
      {tags.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-2 py-1 text-xs">
              {t}
              <button onClick={() => save(tags.filter((x) => x !== t))} aria-label={`Remove tag ${t}`} className="text-faint hover:text-down">
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} onBlur={add} placeholder="Add tag" aria-label="Add tag" className={inputClass} />
    </section>
  );
}

function NotesBlock({ position: p, onChanged, notify }: { position: Position; onChanged: () => void; notify: Props["notify"] }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(p.notes ?? "");
  useEffect(() => setDraft(p.notes ?? ""), [p.notes]);

  const save = async () => {
    const res = await fetch(`/api/automation/positions/${p.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes: draft }) });
    if (!res.ok) return notify("error", "Couldn't save the notes.");
    setEditing(false);
    onChanged();
  };

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Notes</h3>
        {!editing && p.notes && (
          <button onClick={() => setEditing(true)} className="text-xs font-medium text-accent hover:underline">
            Edit notes
          </button>
        )}
      </div>
      {editing ? (
        <div className="space-y-2">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} className={inputClass} autoFocus aria-label="Notes" />
          <div className="flex justify-end gap-2">
            <button className={buttonClass.secondary} onClick={() => { setDraft(p.notes ?? ""); setEditing(false); }}>
              Cancel
            </button>
            <button className={buttonClass.primary} onClick={save}>
              Save
            </button>
          </div>
        </div>
      ) : p.notes ? (
        <p className="whitespace-pre-wrap text-sm">{p.notes}</p>
      ) : (
        <button onClick={() => setEditing(true)} className="flex w-full flex-col items-center gap-1 rounded-lg border border-dashed border-line py-5 text-sm text-muted hover:text-fg">
          <IconEdit width={20} height={20} />
          Edit notes
        </button>
      )}
    </section>
  );
}

interface BotChoice {
  id: string;
  name: string;
  accountId: string | null;
  archived: boolean;
  configError: string | null;
}

/** Picks the bot to move a position to; says why a bot can't take it. */
function MoveModal({ position: p, currentBot, onClose, onMoved, notify }: { position: Position; currentBot: PositionBot; onClose: () => void; onMoved: () => void; notify: Props["notify"] }) {
  const [bots, setBots] = useState<BotChoice[] | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/automation/bots")
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => setBots(json ? json.bots : []))
      .catch(() => setBots([]));
  }, []);

  const why = (b: BotChoice): string | null => {
    if (b.id === p.botId) return "Current bot";
    if (b.archived) return "Archived";
    if (b.configError) return "Needs its inputs first";
    if (currentBot.accountId && b.accountId && b.accountId !== currentBot.accountId) return "Different account";
    return null;
  };

  const move = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/automation/positions/${p.id}/move`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ botId: target }) });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(json.error ?? "Couldn't move it.");
    notify("ok", `Moved to ${bots?.find((b) => b.id === target)?.name ?? "the other bot"}.`);
    onMoved();
  };

  return (
    <Modal
      title="Move position"
      onClose={onClose}
      footer={
        <>
          <button className={buttonClass.secondary} onClick={onClose}>
            Cancel
          </button>
          <button className={buttonClass.primary} onClick={move} disabled={!target || busy}>
            {busy ? "Moving..." : "Move"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">
          The other bot&apos;s switch, limits and flips govern this position from now on. It must be on the same account and have room for it.
        </p>
        {bots === null ? (
          <p className="text-sm text-muted">Loading...</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {bots.map((b) => {
              const blocked = why(b);
              return (
                <li key={b.id}>
                  <label className={cn("flex items-center gap-3 px-4 py-3 text-sm", blocked ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-surface-2/60")}>
                    <input type="radio" name="target" disabled={!!blocked} checked={target === b.id} onChange={() => setTarget(b.id)} className="accent-[var(--accent)]" />
                    <span className="flex-1 font-medium">{b.name}</span>
                    <span className="text-xs text-faint">{blocked ?? (b.accountId ? accountLabel(b.accountId) : "")}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {error && <p className="rounded-lg bg-down-soft px-3 py-2 text-sm text-down">{error}</p>}
      </div>
    </Modal>
  );
}
