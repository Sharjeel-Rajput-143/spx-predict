"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { APP_NAME } from "@/lib/config";
import { cn } from "@/lib/format";
import { useGame } from "./GameProvider";
import { IconAutomation, IconHistory, IconMoon, IconPredict, IconSun, IconTrophy, IconUser } from "./icons";

const NAV = [
  { href: "/", label: "Predict", Icon: IconPredict },
  { href: "/leaderboard", label: "Leaders", Icon: IconTrophy },
  { href: "/history", label: "History", Icon: IconHistory },
  { href: "/profile", label: "Profile", Icon: IconUser },
];

/** Desktop-only - a separate automation/webhook feature doesn't need to
 * crowd the primary game's mobile tab bar; it's reachable there from Profile. */
const DESKTOP_ONLY_NAV = [{ href: "/automations", label: "Automations", Icon: IconAutomation }];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { theme, toggleTheme } = useGame();

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 xl:max-w-[1440px]">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-fg text-bg">
              <IconPredict width={16} height={16} />
            </span>
            <span>{APP_NAME}</span>
          </Link>

          <nav className="hidden items-center gap-1 xl:flex">
            {[...NAV, ...DESKTOP_ONLY_NAV].map(({ href, label }) => {
              const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-sm transition-colors",
                    active ? "bg-surface-2 text-fg" : "text-muted hover:text-fg",
                  )}
                >
                  {label === "Leaders" ? "Leaderboard" : label}
                </Link>
              );
            })}
          </nav>

          <button
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            className="grid h-9 w-9 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            {theme === "dark" ? <IconSun width={18} height={18} /> : <IconMoon width={18} height={18} />}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 pb-28 pt-4 xl:max-w-[1440px] xl:pb-12 xl:pt-6">{children}</main>

      <nav
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/90 backdrop-blur-md xl:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="mx-auto grid max-w-lg grid-cols-4">
          {NAV.map(({ href, label, Icon }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium transition-colors",
                  active ? "text-fg" : "text-faint",
                )}
              >
                <Icon width={22} height={22} strokeWidth={active ? 2.2 : 1.8} />
                {label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
