// GET /api/cron/pickup-retention  （Vercel Cron・毎日 JST 4:40）
//   ?dry=1 … 消す予定だけ返す（Blob も DB も触らない）。&measure=1 で大きさの見込みも返す
// 売上サポ（property_pickups）の画像・資料（Vercel Blob の pickups/ 配下）を、届いてから 72時間で消し、行に expired_at を付ける。
// 行（説明文・判定・札・分析の文字）は残す。画面は「保存期間が終了しました」（LINE と同じ見え方）。
// 2026-09-25 竹内「3日前の画像は消されるように。保存期間が終了しましたと出る感じで。そうすれば重くなり続ける心配がない」
// 選び方と消さない物は app/lib/pickup-retention.ts（純関数・テストあり）と app/lib/pickup-retention-server.ts。
import { NextRequest, NextResponse } from "next/server";
import { runPickupRetention } from "@/app/lib/pickup-retention-server";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const sp = req.nextUrl.searchParams;
  const dry = sp.get("dry") === "1";
  const report = await runPickupRetention({ dry, measure: dry && sp.get("measure") === "1" });
  return NextResponse.json(report, { status: report.ok ? 200 : 500 });
}
