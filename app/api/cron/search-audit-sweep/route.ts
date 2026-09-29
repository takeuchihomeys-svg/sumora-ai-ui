// GET /api/cron/search-audit-sweep  （Vercel Cron・15分ごと）
// 検索の点検の見回り（2026-09-25 竹内「検索がちゃんとされていなかったら原因を見つけられるようにする」）:
//   ① started のまま20分たった回を abandoned にして札 STALLED を付ける（拡張が落ちた・PC が閉じられた等＝終わりの合図が来ない回）
//   ② 見立て（DeepSeek）の残り（ai_status=pending・応答の後の waitUntil が落ちた分）を1回20件まで
//   ?dry=1 は無い（書き込みは見回りの札だけ・LINE には送らない）
import { NextRequest, NextResponse } from "next/server";
import { sweepSearchAudits } from "@/app/lib/search-audit-server";
import { purgeOldSnapshots } from "@/app/lib/extension-snapshots-server";
import { fillOutcomes } from "@/app/lib/screen-watch-server";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const logId = await startCronLog("search-audit-sweep");
  // 見立て1件は最長 40秒（20秒×読み直し1回）。240秒を過ぎたら新しい見立てを始めない
  const report = await sweepSearchAudits({ deadlineAt: Date.now() + 230_000, limit: 20 });
  // 2026-09-29 ③ 拡張の「今の画面」（extension_snapshots・写真の Blob）を14日で消す。失敗しても点検の見回りは失敗にしない（ログに残す）
  const snapshots = await purgeOldSnapshots().catch((e) => ({ ok: false, rows: 0, blobs: 0, error: e instanceof Error ? e.message : String(e) }));
  if (!snapshots.ok) console.warn("[search-audit-sweep] 拡張の画面の消し込みに失敗:", snapshots.error);
  // 2026-09-29 ④ 見張り（screen-watch）のその後の実際を結ぶ（24時間たった行: 点検の最後の札・スタッフが手で直したか・条件の変更）。失敗しても見回りは失敗にしない
  const watch = await fillOutcomes().catch((e) => ({ ok: false, filled: 0, error: e instanceof Error ? e.message : String(e) }));
  if (!watch.ok) console.warn("[search-audit-sweep] 見張りの結び付けに失敗:", (watch as { error?: string }).error);
  const out = { ...report, snapshots, watch };
  await finishCronLog(logId, report.ok, out as unknown as Record<string, unknown>, report.errors[0]);
  return NextResponse.json(out, { status: report.ok ? 200 : 500 });
}
