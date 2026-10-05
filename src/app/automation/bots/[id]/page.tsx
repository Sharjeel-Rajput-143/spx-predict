import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { AutomationLogin } from "@/components/automation/AutomationLogin";
import { BotDetail } from "@/components/automation/bot/BotDetail";
import { isKnownBot } from "@/lib/automation/bots";
import { SESSION_COOKIE_NAME, isValidSession } from "@/lib/automation/session";

export default async function BotPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; error?: string }>;
}) {
  const [{ id }, { tab, error }, cookieStore] = await Promise.all([params, searchParams, cookies()]);
  if (!isKnownBot(id)) notFound();

  if (!isValidSession(cookieStore.get(SESSION_COOKIE_NAME)?.value)) {
    return <AutomationLogin next={`/automation/bots/${id}`} error={!!error} />;
  }
  // Keyed by bot so switching bots remounts: no stale data, no alerts for the previous bot's history.
  return <BotDetail key={id} botId={id} initialTab={tab} />;
}
