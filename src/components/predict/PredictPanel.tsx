"use client";

import { useEffect, useRef, useState } from "react";
import { LOCK_MS, ROUND_MS } from "@/lib/config";
import { cn, formatCountdown, formatPrice, formatTime } from "@/lib/format";
import type { Direction, RoundWindow } from "@/lib/types";
import { IconArrowDown, IconArrowUp, IconLock } from "../icons";

interface Props {
  window: RoundWindow;
  now: number;
  guess: Direction | null;
  openPrice: number | null;
  price: number | null;
  onGuess: (d: Direction) => void;
  disabled?: boolean;
  onLockForClose?: () => void;
}

export function PredictPanel({ window, now, guess, openPrice, price, onGuess, disabled, onLockForClose }: Props) {
  const remaining = Math.max(0, window.endMs - now);
  const progress = 1 - remaining / ROUND_MS;
  const urgent = remaining <= 10_000 && !guess;
  const lockedForClose = remaining <= LOCK_MS && !guess;
  const [pressed, setPressed] = useState<Direction | null>(null);
  const wasLocked = useRef(false);

  useEffect(() => {
    if (lockedForClose && !wasLocked.current) onLockForClose?.();
    wasLocked.current = lockedForClose;
  }, [lockedForClose, onLockForClose]);

  const handle = (d: Direction) => {
    if (guess || disabled || lockedForClose) return;
    setPressed(d);
    if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate?.(12);
    onGuess(d);
  };

  const winning =
    guess && price != null && openPrice != null
      ? guess === "up"
        ? price > openPrice
        : price < openPrice
      : null;

  return (
    <div>
      {/* Countdown */}
      <div className="flex items-end justify-between">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
            {guess ? "Candle closes in" : lockedForClose ? "Locked for close" : "Lock in before close"}
          </div>
          <div
            className={cn(
              "tabular font-mono text-3xl font-semibold tracking-tight transition-colors",
              urgent ? "text-down" : "text-fg",
            )}
            aria-live="off"
          >
            {formatCountdown(remaining)}
          </div>
        </div>
        <div className="text-right text-xs text-faint">
          <div>Window</div>
          <div className="tabular text-muted">
            {formatTime(window.startMs)} to {formatTime(window.endMs)}
          </div>
        </div>
      </div>
      <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-surface-2">
        <div
          className={cn("h-full rounded-full transition-[width] duration-300 ease-linear", urgent ? "bg-down" : "bg-fg/70")}
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      {/* Buttons */}
      <div className={cn("mt-4 grid grid-cols-2 gap-3", lockedForClose && "animate-lock-pulse")}>
        <GuessButton
          dir="up"
          active={guess === "up"}
          dimmed={guess === "down"}
          locked={!!guess || lockedForClose}
          pressed={pressed === "up"}
          onClick={() => handle("up")}
          disabled={disabled}
        />
        <GuessButton
          dir="down"
          active={guess === "down"}
          dimmed={guess === "up"}
          locked={!!guess || lockedForClose}
          pressed={pressed === "down"}
          onClick={() => handle("down")}
          disabled={disabled}
        />
      </div>

      <div className="mt-3 min-h-10 text-center text-sm">
        {guess ? (
          <div className="animate-pop-in inline-flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-muted">
            <IconLock width={14} height={14} />
            <span>
              Locked <b className={guess === "up" ? "text-up" : "text-down"}>{guess.toUpperCase()}</b>
              {openPrice != null && (
                <>
                  {" "}vs open <span className="tabular text-fg">{formatPrice(openPrice)}</span>
                </>
              )}
            </span>
            {winning != null && (
              <span
                className={cn(
                  "ml-1 rounded-md px-1.5 py-0.5 text-xs font-semibold",
                  winning ? "bg-up-soft text-up" : "bg-down-soft text-down",
                )}
              >
                {winning ? "Winning" : "Losing"}
              </span>
            )}
          </div>
        ) : lockedForClose ? (
          <div className="animate-pop-in inline-flex items-center justify-center gap-1.5 text-muted">
            <IconLock width={14} height={14} />
            <span>Candle closing - guesses are locked.</span>
          </div>
        ) : (
          <span className="text-faint">
            Will this candle close above or below its open? One tap, one guess.
          </span>
        )}
      </div>
    </div>
  );
}

function GuessButton({
  dir,
  active,
  dimmed,
  locked,
  pressed,
  onClick,
  disabled,
}: {
  dir: Direction;
  active: boolean;
  dimmed: boolean;
  locked: boolean;
  pressed: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  const up = dir === "up";
  const Icon = up ? IconArrowUp : IconArrowDown;
  return (
    <button
      onClick={onClick}
      disabled={locked || disabled}
      aria-pressed={active}
      aria-label={`Predict ${dir}`}
      className={cn(
        "group relative flex h-24 flex-col items-center justify-center gap-1 rounded-2xl text-lg font-bold uppercase tracking-wide transition-all duration-200 md:h-28",
        "focus-visible:outline-2 focus-visible:outline-offset-2",
        up ? "focus-visible:outline-up" : "focus-visible:outline-down",
        !locked && (up ? "bg-up text-white hover:brightness-110 active:scale-[0.97]" : "bg-down text-white hover:brightness-110 active:scale-[0.97]"),
        active && (up ? "bg-up text-white ring-4 ring-up/25" : "bg-down text-white ring-4 ring-down/25"),
        dimmed && "bg-surface-2 text-faint",
        disabled && !locked && "opacity-50",
        pressed && active && "animate-pop-in",
      )}
    >
      <Icon width={28} height={28} className={cn(!locked && (up ? "group-hover:-translate-y-0.5" : "group-hover:translate-y-0.5"), "transition-transform")} />
      {dir}
    </button>
  );
}
