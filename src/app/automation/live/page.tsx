import { cookies } from "next/headers";
import Link from "next/link";
import { AutomationLogin } from "@/components/automation/AutomationLogin";
import { LivePanel } from "@/components/automation/LivePanel";
import { PageHeader } from "@/components/automation/PageHeader";
import { SESSION_COOKIE_NAME, isValidSession } from "@/lib/automation/session";

/** The Live page: the live switch and the mirror (both OFF until the word LIVE is typed), the account check, the gate numbers, the limits, and the live bot's trades. */
export default async function AutomationLivePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const [{ error }, cookieStore] = await Promise.all([searchParams, cookies()]);
  if (!isValidSession(cookieStore.get(SESSION_COOKIE_NAME)?.value)) {
    return <AutomationLogin next="/automation/live" error={error === "config" ? "config" : !!error} />;
  }
  return (
    <div className="space-y-4">
      <PageHeader
        title="Live trading"
        back={
          <Link href="/automation/bybit" className="text-accent hover:underline">
            ← Bybit
          </Link>
        }
      />
      <LivePanel />
    </div>
  );
}
