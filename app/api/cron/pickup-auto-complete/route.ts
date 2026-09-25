// GET /api/cron/pickup-auto-complete  （Vercel Cron・2分おき）
//   ?dry=1 … 自動でまとめる時が来たお客様の数だけ返す（書かない）
// 売上サポ（property_pickups）の 10分の自動まとめ。そのお客様のまだまとめていない一番新しい行（届いた時刻 created_at）から10分、
// 新しい行が届かなければ、拡張の「完了」と同じまとめ（complete_group_id・自動の読み取り・まとめた全件での順位と 👑）をする。
// 2026-09-25 竹内「毎回完了おすよりも最後にスタッフモードで指定したお客さん（例 yuma さん物件完了後）10分たてば自動的に送られた物件まとめて、
//   ほかの一括検索や自動モードのときのようにまとめて判定する」
// 決まり（純関数）は app/lib/pickup-complete.ts の autoCompleteDue／isQuietFor、動きは pickup-complete-server.ts の runAutoCompleteSweep。
// 2分おきにしたのは: まとまるまで最長 12分（10分＋2分）・何もない時は1問い合わせだけ（毎分の Cron は既に3本あり、プランで分単位が使える）。
// 拡張の chrome.alarms と売上サポの詳細を開いた時も同じ判定でまとめる（どれか1つが動けばまとまる・同じまとめ ID で冪等）。
import { NextRequest, NextResponse } from "next/server";
import { runAutoCompleteSweep } from "@/app/lib/pickup-complete-server";

// 1回 最大3人・1人の読み取りは 200秒で新しい物件を始めない（pickup-complete の FINISH_DEADLINE と同じ）
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const report = await runAutoCompleteSweep({ dry, deadlineAt: Date.now() + 200_000 });
  return NextResponse.json(report, { status: report.ok ? 200 : 500 });
}
