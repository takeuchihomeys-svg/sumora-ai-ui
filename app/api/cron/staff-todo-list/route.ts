// GET /api/cron/staff-todo-list（vercel.json: 30 1,3,5,7,9,11 * * * ＝ 日本時間 10:30〜20:30 の2時間ごと）
//   つなぎのブレイン（管理者）が売上番長グループ（LINE_STAFF_GROUP_ID）に出す【やることリスト】（2026-10-20 竹内さん・設計知見 1d7ac7f4）。
//   2026-10-21 竹内さんの決定（f87ccb7e）: 2時間ごと・被っている AIX要対応リスト（announce-aix-actions）を置き換える・
//     申込中などのターゲットのリスト（announce-hot-customers・announce-sonota・daily-brief・evening-reminder）は今のまま・
//     やることリストは必ず行う物・✅はグループの✅も（hanbancyo-webhook → staff-todo-reply）・基本は LINE から自動・14日を過ぎた約束は外す・（0日）は書かない
//   組み立ては app/lib/staff-todo-list.ts（決まった計算・LLM なし）。
//   切替 STAFF_TODO_LIST（既定 on）。off にすると送らず、announce-aix-actions が元の AIX要対応リストを送る。
//   ?preview=1 … 送らずに文だけ返す（切替に関係なく・読むだけ・片付けもしない）。&at=<ISO> でその時点の一覧
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { loadStaffTodoList } from "@/app/lib/staff-todo-list-server";
import { renderStaffTodoList, staffTodoListEnabled } from "@/app/lib/staff-todo-list";
import { pushToHanbancyoGroupWithId, dismissStaleAixActionItems, AIX_NOTICE_FRESH_MS } from "@/app/lib/aix-action-items";
import { saveTodoSnapshot, snapshotOf } from "@/app/lib/staff-todo-reply-server";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const preview = url.searchParams.get("preview") === "1";
  const atParam = url.searchParams.get("at");
  const atMs = atParam && Number.isFinite(Date.parse(atParam)) ? Date.parse(atParam) : Date.now();

  if (preview) {
    const list = await loadStaffTodoList(supabase, atMs);
    return NextResponse.json({ ok: true, preview: true, text: renderStaffTodoList(list), open: list.openCount, done: list.doneCount, skipped: list.skipped });
  }
  if (!staffTodoListEnabled()) return NextResponse.json({ ok: true, skipped: true, reason: "STAFF_TODO_LIST is off" });

  // 重複防止（90分）: 手動実行・再試行で同じ一覧を連投しない
  const { data: last } = await supabase.from("hanbancyo_settings").select("value").eq("key", "staff_todo_last_sent_at").maybeSingle();
  if (last?.value && Date.now() - new Date(last.value as string).getTime() < 90 * 60 * 1000) {
    return NextResponse.json({ ok: true, skipped: true, reason: "cooldown (90min)" });
  }

  // 48時間より前のお客様発言への AIX 要対応を片付ける（置き換えた AIX要対応リストがしていた事・宣言済みのピックアップは残す）
  const stale = await dismissStaleAixActionItems(AIX_NOTICE_FRESH_MS).catch((e) => { console.warn("[staff-todo] stale:", e); return null; });

  const list = await loadStaffTodoList(supabase, Date.now());
  const text = renderStaffTodoList(list);
  if (!text) return NextResponse.json({ ok: true, skipped: true, reason: "no items", stale });

  // LINE の text は 5000字まで（超えると送信が 400 で落ちる）。並びは優先度順なので後ろ（優先度の低い方）を切る
  const safeText = text.length > 4900 ? `${text.slice(0, 4900)}\n…（以下省略）` : text;
  const sent = await pushToHanbancyoGroupWithId(safeText);
  if (sent.ok) {
    const nowIso = new Date().toISOString();
    await supabase.from("hanbancyo_settings").upsert({ key: "staff_todo_last_sent_at", value: nowIso }, { onConflict: "key" });
    // 番号の控え（グループで「✅3」と返された時にどの行か分かるように）
    await saveTodoSnapshot(supabase, snapshotOf(list, sent.messageId, nowIso));
  }
  return NextResponse.json({ ok: sent.ok, open: list.openCount, done: list.doneCount, stale });
}
