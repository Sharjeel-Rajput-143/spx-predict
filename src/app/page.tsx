import { redirect } from "next/navigation";

// The prediction chart is hidden from the app for now (it still lives at
// /predict); Automation is the landing page.
export default function Home() {
  redirect("/automations");
}
