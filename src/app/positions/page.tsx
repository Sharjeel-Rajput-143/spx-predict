import { PositionsPage } from "@/components/automation/PositionsPage";

export default async function Positions({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view } = await searchParams;
  return <PositionsPage initialView={view === "analyze" ? "analyze" : "list"} />;
}
