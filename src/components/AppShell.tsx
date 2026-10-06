"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { APP_NAME } from "@/lib/config";
import { cn } from "@/lib/format";
import { useGame } from "./GameProvider";
import { TEXT_SIZES, TEXT_SIZE_KEY, type TextSize } from "./automation/settings/sections";
import { IconAutomation, IconCalendar, IconHistory, IconLogout, IconMoon, IconPanelLeft, IconPositions, IconPredict, IconSettings, IconSun, IconUser } from "./icons";

/** Automation leads; the rest follow. Predict and Leaderboard are hidden for
 * now - their routes still work, they're just not linked. */
const NAV = [
  { href: "/automations", label: "Automation", Icon: IconAutomation },
  { href: "/positions", label: "Positions", Icon: IconPositions },
  { href: "/calendar", label: "Calendar", Icon: IconCalendar },
  { href: "/history", label: "History", Icon: IconHistory },
  { href: "/profile", label: "Profile", Icon: IconUser },
  { href: "/settings", label: "Settings", Icon: IconSettings },
];

const HOME = "/automations";

const isActive = (pathname: string, href: string) => {
  // The bot pages live under /automation/..., but belong to Automation.
  if (href === "/automations") return pathname.startsWith("/automations") || pathname.startsWith("/automation/");
  return pathname === href || pathname.startsWith(`${href}/`);
};

const COLLAPSE_KEY = "automation:sidebar-collapsed";

/** New York time, ticking every 30s - the clock the trading window runs on. */
function EasternClock({ collapsed }: { collapsed: boolean }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!now) return null;
  const time = now.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  return (
    <div className={cn("mx-3 mb-2 rounded-md bg-up-soft px-2 py-1 text-center text-[11px] font-medium text-up", collapsed && "mx-2 px-0")} title="Current time in New York">
      {collapsed ? time.replace(/\s?(AM|PM)/, "") : `${time} ET`}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, toggleTheme } = useGame();
  const [collapsed, setCollapsed] = useState(false);
  const [auth, setAuth] = useState<{ authRequired: boolean; signedIn: boolean } | null>(null);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
      // The text size chosen under Settings > General.
      const size = localStorage.getItem(TEXT_SIZE_KEY) as TextSize | null;
      if (size && size in TEXT_SIZES) document.documentElement.style.fontSize = `${TEXT_SIZES[size]}px`;
    } catch {
      /* storage unavailable: stay expanded */
    }
    fetch("/api/automation/session")
      .then((r) => r.json())
      .then(setAuth)
      .catch(() => undefined);
  }, [pathname]);

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !c;
    });

  const logOut = async () => {
    await fetch("/api/automation/logout", { method: "POST" });
    router.push("/automations");
    router.refresh();
    setAuth((a) => (a ? { ...a, signedIn: false } : a));
  };
  const ThemeIcon = theme === "dark" ? IconSun : IconMoon;
  const themeLabel = `Switch to ${theme === "dark" ? "light" : "dark"} mode`;

  return (
    <div className="min-h-dvh">
      {/* Desktop: left sidebar. */}
      <aside className={cn("fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-line bg-surface transition-[width] xl:flex", collapsed ? "w-16" : "w-56")}>
        <div className={cn("flex h-14 items-center", collapsed ? "justify-center" : "justify-between pr-2")}>
          <Link href={HOME} className={cn("flex items-center gap-2 font-semibold tracking-tight", collapsed ? "" : "px-4")} title={APP_NAME}>
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-fg text-bg">
              <IconPredict width={16} height={16} />
            </span>
            {!collapsed && <span>{APP_NAME}</span>}
          </Link>
          {!collapsed && (
            <button onClick={toggleCollapsed} aria-label="Collapse sidebar" className="grid h-8 w-8 place-items-center rounded-lg text-faint hover:bg-surface-2 hover:text-fg">
              <IconPanelLeft width={16} height={16} />
            </button>
          )}
        </div>
        {collapsed && (
          <button onClick={toggleCollapsed} aria-label="Expand sidebar" className="mx-auto mb-1 grid h-8 w-8 place-items-center rounded-lg text-faint hover:bg-surface-2 hover:text-fg">
            <IconPanelLeft width={16} height={16} />
          </button>
        )}

        <nav className="flex-1 space-y-1 px-3 py-3">
          {NAV.map(({ href, label, Icon }) => {
            const active = isActive(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                title={collapsed ? label : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  collapsed && "justify-center px-0",
                  active ? "bg-accent/10 text-accent" : "text-muted hover:bg-surface-2 hover:text-fg",
                )}
              >
                <Icon width={18} height={18} strokeWidth={active ? 2.2 : 1.8} />
                {!collapsed && label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-line pt-3">
          <EasternClock collapsed={collapsed} />
          <div className="space-y-1 px-3 pb-3">
            <button
              onClick={toggleTheme}
              aria-label={themeLabel}
              title={collapsed ? themeLabel : undefined}
              className={cn("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg", collapsed && "justify-center px-0")}
            >
              <ThemeIcon width={18} height={18} />
              {!collapsed && (theme === "dark" ? "Light mode" : "Dark mode")}
            </button>
            {auth?.authRequired && auth.signedIn && (
              <button
                onClick={logOut}
                title={collapsed ? "Log out" : undefined}
                className={cn("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg", collapsed && "justify-center px-0")}
              >
                <IconLogout width={18} height={18} />
                {!collapsed && "Log out"}
              </button>
            )}
          </div>
        </div>
      </aside>

      {/* Below desktop: slim top bar + bottom tabs. */}
      <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-md xl:hidden">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <Link href={HOME} className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-fg text-bg">
              <IconPredict width={16} height={16} />
            </span>
            <span>{APP_NAME}</span>
          </Link>
          <button
            onClick={toggleTheme}
            aria-label={themeLabel}
            className="grid h-9 w-9 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <ThemeIcon width={18} height={18} />
          </button>
        </div>
      </header>

      <main className={cn("mx-auto max-w-5xl px-4 pb-28 pt-4 xl:max-w-none xl:px-8 xl:pb-12 xl:pt-6", collapsed ? "xl:ml-16" : "xl:ml-56")}>
        {children}
      </main>

      <nav
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/90 backdrop-blur-md xl:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="mx-auto grid max-w-lg" style={{ gridTemplateColumns: `repeat(${NAV.length}, minmax(0, 1fr))` }}>
          {NAV.map(({ href, label, Icon }) => {
            const active = isActive(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium transition-colors",
                  active ? "text-fg" : "text-faint",
                )}
              >
                <Icon width={20} height={20} strokeWidth={active ? 2.2 : 1.8} />
                {label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
