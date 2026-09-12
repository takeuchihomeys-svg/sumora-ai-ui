// GET /api/cron/announce-aix-actions（vercel.json: 30 1,3,5,7,9,11 * * * ＝ 日本時間 10:30〜20:30 の2時間ごと）
// 売上番長グループへ「AIX要対応リスト」を送る（2026-09-12 竹内方針）。
//   ・{名}さん → AIX【ボタン】 … 未対応（ブレインが AIX 必要と判断・まだ AIX を送っていない）
//   ✅{名}さん → AIX【ボタン】 … 今日 AIX を送って完了したもの
// 登録・1件通知は brain-core runBrainAndNotify、完了は log-aix-usage（app/lib/aix-action-items.ts）。
// 旧 flagged-reminder（毎時「要対応 1時間以上止まってる」）はこの一覧に置き換えて cron から外した。
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { buildAixActionList, pushToHanbancyoGroup, AIX_NOTICE_FRESH_MS, type AixActionItemRow } from "@/app/lib/aix-action-items";
import { jstDayStartMs } from "@/app/lib/jst-date";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // 重複防止（90分）: 手動実行や Vercel の再試行で同じ一覧を連投しない
  const { data: last } = await supabase.from("hanbancyo_settings").select("value").eq("key", "announce_aix_last_sent_at").maybeSingle();
  if (last?.value && Date.now() - new Date(last.value as string).getTime() < 90 * 60 * 1000) {
    return NextResponse.json({ ok: true, skipped: true, reason: "cooldown (90min)" });
  }

  // 2026-09-12 竹内（まさゆき事例）: 48時間より前のお客様発言への指示は今の要対応ではない → 一覧に載せる前に片付ける
  //   （お客様がまた発言すればブレインが改めて判断・通知する。未返信のまま残っている会話は受信箱側で見える）
  const staleCutoff = new Date(Date.now() - AIX_NOTICE_FRESH_MS).toISOString();
  await supabase.from("aix_action_items")
    .update({ status: "dismissed", dismissed_reason: "stale_customer_turn", updated_at: new Date().toISOString() })
    .eq("status", "pending").lt("brain_analyzed_msg_ts", staleCutoff);

  const todayStart = new Date(jstDayStartMs()).toISOString();
  const [{ data: pending, error: e1 }, { data: doneToday, error: e2 }] = await Promise.all([
    supabase.from("aix_action_items")
      .select("id, conversation_id, customer_name, action, check_pattern, status, done_aix_type, done_at, created_at")
      .eq("status", "pending").order("created_at", { ascending: true }).limit(100),
    supabase.from("aix_action_items")
      .select("id, conversation_id, customer_name, action, check_pattern, status, done_aix_type, done_at, created_at")
      .eq("status", "done").gte("done_at", todayStart).order("done_at", { ascending: true }).limit(100),
  ]);
  if (e1 || e2) return NextResponse.json({ ok: false, error: (e1 ?? e2)?.message }, { status: 500 });

  const text = buildAixActionList([...(pending ?? []), ...(doneToday ?? [])] as AixActionItemRow[]);
  if (!text) return NextResponse.json({ ok: true, skipped: true, reason: "no items" });

  const sent = await pushToHanbancyoGroup(text);
  if (sent) {
    await supabase.from("hanbancyo_settings").upsert({ key: "announce_aix_last_sent_at", value: new Date().toISOString() }, { onConflict: "key" });
  }
  return NextResponse.json({ ok: sent, pending: pending?.length ?? 0, done_today: doneToday?.length ?? 0 });
}
