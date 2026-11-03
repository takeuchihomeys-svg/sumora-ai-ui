// app/api/ops-anomalies/route.ts — 画面の上の印（OpsAnomalyBanner）が読む開いた異常（種類・件数・時刻だけ・個人情報なし）
import { NextResponse } from "next/server";
import { opsAdminClient, openAnomalies } from "@/app/lib/ops-anomaly-server";

export const dynamic = "force-dynamic";

export async function GET() {
  const db = opsAdminClient();
  if (!db) return NextResponse.json({ ok: false, items: [] });
  try { return NextResponse.json({ ok: true, items: await openAnomalies(db) }); }
  catch { return NextResponse.json({ ok: false, items: [] }); }
}
