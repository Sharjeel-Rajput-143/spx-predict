"use client";

import { useEffect, useRef } from "react";

/**
 * Calls `load` now and then every `intervalMs`, the way a live page should:
 *  - never while the tab is hidden (a forgotten tab would keep the server busy all day, and an alert arriving then would queue behind it);
 *  - never while the last call is still waiting for its answer (a slow server would otherwise be given more and more to do);
 *  - at once when you come back to the tab or the connection returns, so what you see is fresh the moment you look.
 * `load` may return a promise; the next call waits for it.
 */
export function usePolling(load: () => unknown, intervalMs: number): void {
  const latest = useRef(load);
  useEffect(() => {
    latest.current = load;
  });

  useEffect(() => {
    let running = false;
    const tick = async () => {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      try {
        await latest.current();
      } catch {
        /* the page shows its own error; the next tick tries again */
      } finally {
        running = false;
      }
    };
    void tick();
    const id = setInterval(tick, intervalMs);
    const back = () => void tick();
    document.addEventListener("visibilitychange", back);
    window.addEventListener("online", back);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("online", back);
    };
  }, [intervalMs]);
}
