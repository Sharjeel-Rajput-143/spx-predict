import { cookies } from "next/headers";
import Link from "next/link";
import { AutomationLogin } from "@/components/automation/AutomationLogin";
import { BybitPanel } from "@/components/automation/BybitPanel";
import { PageHeader, headerButtonClass } from "@/components/automation/PageHeader";
import { SESSION_COOKIE_NAME, isValidSession } from "@/lib/automation/session";

/** The Bybit tab of the Automation page: the open trade live from Bybit, the closed trades, and the day's and running totals. */
export default async function AutomationBybitPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const [{ error }, cookieStore] = await Promise.all([searchParams, cookies()]);
  if (!isValidSession(cookieStore.get(SESSION_COOKIE_NAME)?.value)) {
    return <AutomationLogin next="/automation/bybit" error={error === "config" ? "config" : !!error} />;
  }
  return (
    <div className="space-y-4">
      <PageHeader
        title="Bybit"
        actions={
          <Link href="/automation/live" className={headerButtonClass}>
            Live trading
          </Link>
        }
        back={
          <Link href="/automations" className="text-accent hover:underline">
            ← Automation
          </Link>
        }
      />
      <BybitPanel inactiveNote="Bybit is not the broker right now (set BROKER=bybit in .env.local and restart the app), or its settings are incomplete: the Settings page says which." />
    </div>
  );
}
