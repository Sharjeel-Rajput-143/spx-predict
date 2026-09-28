"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { DEFAULT_SYMBOL } from "@/lib/config";
import { computeStats } from "@/lib/game";
import { MOCK_USER, seedUserHistory } from "@/lib/mock/data";
import type { GameService } from "@/lib/services/gameService";
import { getGameService } from "@/lib/services";
import { playSound } from "@/lib/sound";
import type { Direction, RoundResult, RoundWindow, UserProfile, UserStats } from "@/lib/types";

type Theme = "dark" | "light";

interface PendingGuess {
  window: RoundWindow;
  guess: Direction;
  placedAt: number;
}

interface GameState {
  hydrated: boolean;
  service: GameService;
  symbol: string;
  setSymbol: (s: string) => void;
  profile: UserProfile;
  setUsername: (name: string) => void;
  results: RoundResult[]; // newest first
  stats: UserStats;
  pending: Record<string, PendingGuess>;
  settlingIds: string[];
  lastReveal: RoundResult | null;
  dismissReveal: () => void;
  placeGuess: (window: RoundWindow, guess: Direction) => Promise<boolean>;
  theme: Theme;
  toggleTheme: () => void;
  soundEnabled: boolean;
  toggleSound: () => void;
  resetDemo: () => void;
}

const GameContext = createContext<GameState | null>(null);
const STORAGE_KEY = "spx-predict:v1";

interface Persisted {
  symbol: string;
  profile: UserProfile;
  results: RoundResult[];
  pending: Record<string, PendingGuess>;
  theme: Theme;
  soundEnabled?: boolean;
}

function load(): Persisted | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Persisted) : null;
  } catch {
    return null;
  }
}

function save(p: Persisted) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable, state stays in memory */
  }
}

export function GameProvider({
  children,
  service = getGameService(),
}: {
  children: ReactNode;
  service?: GameService;
}) {
  const [hydrated, setHydrated] = useState(false);
  const [symbol, setSymbol] = useState(DEFAULT_SYMBOL);
  const [profile, setProfile] = useState<UserProfile>(MOCK_USER);
  const [results, setResults] = useState<RoundResult[]>([]);
  const [pending, setPending] = useState<Record<string, PendingGuess>>({});
  const [settlingIds, setSettlingIds] = useState<string[]>([]);
  const [lastReveal, setLastReveal] = useState<RoundResult | null>(null);
  const [theme, setTheme] = useState<Theme>("dark");
  const [soundEnabled, setSoundEnabled] = useState(false);
  const settlingRef = useRef(new Set<string>());
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;

  // Load persisted state on the client only (history depends on Date.now()).
  useEffect(() => {
    const saved = load();
    if (saved) {
      setSymbol(saved.symbol);
      setProfile(saved.profile);
      setResults(saved.results);
      setPending(saved.pending);
      setTheme(saved.theme);
      setSoundEnabled(saved.soundEnabled ?? false);
    } else {
      setResults(seedUserHistory(Date.now()));
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    save({ symbol, profile, results, pending, theme, soundEnabled });
  }, [hydrated, symbol, profile, results, pending, theme, soundEnabled]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  // Settlement loop: once a window closes, ask the service for the outcome.
  useEffect(() => {
    if (!hydrated) return;
    const tick = () => {
      const now = Date.now();
      Object.values(pending).forEach((p) => {
        if (p.window.endMs > now || settlingRef.current.has(p.window.id)) return;
        settlingRef.current.add(p.window.id);
        setSettlingIds((ids) => [...ids, p.window.id]);
        service.settleRound(p.window, p.guess).then((result) => {
          settlingRef.current.delete(p.window.id);
          setSettlingIds((ids) => ids.filter((id) => id !== p.window.id));
          setPending((prev) => {
            const next = { ...prev };
            delete next[p.window.id];
            return next;
          });
          setResults((prev) => (prev.some((r) => r.id === result.id) ? prev : [result, ...prev]));
          // Only pop the reveal for rounds that just ended, not stale ones from a reload.
          if (now - result.endMs < 60_000) {
            setLastReveal(result);
            if (soundEnabledRef.current) playSound(result.correct ? "win" : "lose");
          }
        });
      });
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [hydrated, pending, service]);

  const placeGuess = useCallback(
    async (window: RoundWindow, guess: Direction) => {
      if (pending[window.id] || Date.now() >= window.endMs) return false;
      setPending((prev) => ({ ...prev, [window.id]: { window, guess, placedAt: Date.now() } }));
      setLastReveal(null);
      if (soundEnabledRef.current) playSound("tap");
      await service.submitGuess(window, guess);
      return true;
    },
    [pending, service],
  );

  // Auto-hide the reveal after a while so the screen resets for the next call.
  useEffect(() => {
    if (!lastReveal) return;
    const id = setTimeout(() => setLastReveal(null), 12_000);
    return () => clearTimeout(id);
  }, [lastReveal]);

  const stats = useMemo(() => computeStats(results), [results]);

  const value: GameState = {
    hydrated,
    service,
    symbol,
    setSymbol,
    profile,
    setUsername: (username) => setProfile((p) => ({ ...p, username })),
    results,
    stats,
    pending,
    settlingIds,
    lastReveal,
    dismissReveal: () => setLastReveal(null),
    placeGuess,
    theme,
    toggleTheme: () => setTheme((t) => (t === "dark" ? "light" : "dark")),
    soundEnabled,
    toggleSound: () => setSoundEnabled((s) => !s),
    resetDemo: () => {
      setPending({});
      setLastReveal(null);
      setResults(seedUserHistory(Date.now()));
      setProfile(MOCK_USER);
    },
  };

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export function useGame() {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error("useGame must be used inside <GameProvider>");
  return ctx;
}
