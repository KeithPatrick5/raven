import ReportsClient from "./ReportsClient";
import { getSignalTruthSnapshot } from "@/lib/signalTruth";

export const dynamic = "force-dynamic";

async function safeTruth() {
  try {
    return await getSignalTruthSnapshot("7d");
  } catch {
    return null;
  }
}

export default async function ReportsPage() {
  const truth = await safeTruth();
  return <ReportsClient truth={truth} />;
}
