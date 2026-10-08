// GET /api/cron/viewing-morning-greeting（vercel.json: 15 0 * * * ＝ 日本時間 9:15）
// 2026-10-08 竹内さん「作る」: 待ち合わせ場所の AIX で確定した内覧の日の朝に、まだ当日の内覧挨拶を送っていない会話へ
//   AIX要対応「AIX【内覧挨拶→内覧前】」を立てて売上番長グループへ1件ずつ通知する（app/lib/viewing-morning-greeting-server.ts）。
//   内覧の候補の枠は 11:00〜（feedback_viewing_slot_rules）＝9:15 なら内覧の前に十分間に合う。30分を切った内覧は立てない。
//   ?dry=1 は読むだけ（登録・通知・取り下げなし）。戻す VIEWING_MORNING_GREETING=off
import { NextRequest, NextResponse } from "next/server";
import { runViewingMorningGreeting } from "@/app/lib/viewing-morning-greeting-server";

export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (process.env.VIEWING_MORNING_GREETING === "off" || process.env.VIEWING_DAY_GREETING === "off") {
    return NextResponse.json({ ok: true, skipped: true, reason: "VIEWING_MORNING_GREETING=off" });
  }
  const dryRun = req.nextUrl.searchParams.get("dry") === "1";
  const r = await runViewingMorningGreeting({ dryRun });
  return NextResponse.json({
    ok: true, dryRun, dismissedPast: r.dismissed,
    registered: r.rows.filter((x) => x.registered).map((x) => ({ conversationId: x.conversationId, appointment: x.appointment })),
    whys: r.rows.reduce<Record<string, number>>((a, x) => { a[x.why] = (a[x.why] ?? 0) + 1; return a; }, {}),
  });
}
