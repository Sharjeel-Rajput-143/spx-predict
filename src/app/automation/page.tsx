import { redirect } from "next/navigation";

// The bots list lives under Automations now.
export default function AutomationBotsPage() {
  redirect("/automations");
}
