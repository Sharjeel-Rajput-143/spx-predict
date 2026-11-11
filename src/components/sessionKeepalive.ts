/**
 * Keeps a signed-in person signed in while they are using the page. `onActivity` is called for a real user action (click,
 * key, touch, scroll); at most one request goes out per `minGapMs`, and none at all while nothing is happening, so an
 * untouched page lets the sign-in run out. Data refreshes on a timer never count.
 */
export function createKeepalive({ ping, now = Date.now, minGapMs = 60_000 }: { ping: () => Promise<unknown>; now?: () => number; minGapMs?: number }) {
  let last = -Infinity;
  return function onActivity(): boolean {
    const t = now();
    if (t - last < minGapMs) return false;
    last = t;
    void ping().catch(() => undefined);
    return true;
  };
}

export const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
