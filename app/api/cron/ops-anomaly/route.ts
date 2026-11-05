// app/api/cron/ops-anomaly/route.ts — 本番の異常の知らせ（5分ごと・SQL の件数だけ・LLM は呼ばない）＋版の記録（スイッチの組の指紋）
//   ・版の記録: いつも（OPS_ANOMALY_WATCH が off でも）このデプロイの環境のスイッチの組を brain_switch_versions に upsert（1行・5分に1回）
//     → brain_decision_logs.digest.ver（8字）から、その判断がどのスイッチの組で出たかを引ける（app/lib/switch-fingerprint.ts）
//   ・異常の知らせ: OPS_ANOMALY_WATCH=on の時だけ数えて書く（既定 off）。=dry は数えて決めて Vercel のログに1行出すだけ（最初の確かめ・vercel crons run は query を渡せない）。?dry=1 も同じ（off でも動く）
//   判断は app/lib/ops-anomaly.ts・数えと書き込みは app/lib/ops-anomaly-server.ts
import { NextRequest, NextResponse } from "next/server";
import { opsAnomalyWatchMode, opsAnomalyBalanceLive } from "@/app/lib/ops-anomaly";
import { opsAdminClient, runOpsAnomalyWatch } from "@/app/lib/ops-anomaly-server";
import { switchFingerprint } from "@/app/lib/switch-fingerprint";
import { brainVersionOf } from "@/app/lib/brain-decision-ledger";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const mode = opsAnomalyWatchMode();
  // ?dry=1 か OPS_ANOMALY_WATCH=dry は数えて決めるだけ（ops_anomalies に書かない・結果は Vercel のログに1行）
  const dry = req.nextUrl.searchParams.get("dry") === "1" || mode === "dry";
  const db = opsAdminClient();
  if (!db) return NextResponse.json({ ok: false, error: "SUPABASE_SERVICE_ROLE_KEY が無い（ops_anomalies・brain_switch_versions はサーバーの鍵だけで書ける）" }, { status: 500 });
  // 版の記録（失敗しても異常の見張りは止めない）
  const fp = switchFingerprint(process.env);
  let ver: string | null = null;
  if (req.nextUrl.searchParams.get("dry") !== "1") {
    const { error } = await db.from("brain_switch_versions").upsert({ hash: fp.h, switches: fp.text, n: fp.n, commit_sha: brainVersionOf(process.env), last_seen_at: new Date().toISOString() }, { onConflict: "hash" });
    ver = error ? `書けない: ${error.message.slice(0, 80)}` : fp.h;
  }
  if (mode === "off" && req.nextUrl.searchParams.get("dry") !== "1") return NextResponse.json({ ok: true, ver, skipped: "OPS_ANOMALY_WATCH が on でない" });
  try {
    // 2026-11-05: 残高切れ（402）だけは dry の間も表と竹内さん個人の LINE（YUMA）に出す（?dry=1 の手の確かめでは出さない）
    const r = await runOpsAnomalyWatch(db, { dry, balanceLive: mode === "dry" && req.nextUrl.searchParams.get("dry") !== "1" && opsAnomalyBalanceLive() });
    console.log(JSON.stringify({ tag: "ops-anomaly", mode, dry, ver: ver ?? fp.h, stats: r.stats, anomalies: r.anomalies.map((a) => ({ kind: a.kind, severity: a.severity, why: a.why })), inserted: r.inserted, updated: r.updated, resolved: r.resolved }));
    return NextResponse.json({ ok: true, dry, ver: ver ?? fp.h, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, ver, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
