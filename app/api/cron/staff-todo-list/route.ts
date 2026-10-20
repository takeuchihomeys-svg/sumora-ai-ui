// GET /api/cron/staff-todo-list — つなぎのブレイン（管理者）がスタッフのグループに出す【やることリスト】（2026-10-20 竹内さん・設計知見 1d7ac7f4）
//   組み立ては app/lib/staff-todo-list.ts（決まった計算・LLM なし）。
//   ⚠ 送るのは切替 STAFF_TODO_LIST=on の時だけ（既定 off）。vercel.json の crons にはまだ入れていない（外に出る文なので竹内さんの承認の後に時刻とグループを決めて入れる）。
//   ?preview=1 … 送らずに文だけ返す（切替に関係なく・読むだけ）。&at=<ISO> でその時点の一覧
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { loadStaffTodoList } from "@/app/lib/staff-todo-list-server";
import { renderStaffTodoList, staffTodoListEnabled } from "@/app/lib/staff-todo-list";
import { pushToHanbancyoGroup } from "@/app/lib/aix-action-items";

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

  if (!preview && !staffTodoListEnabled()) return NextResponse.json({ ok: true, skipped: true, reason: "STAFF_TODO_LIST is off" });

  const list = await loadStaffTodoList(supabase, atMs);
  const text = renderStaffTodoList(list);
  if (preview) return NextResponse.json({ ok: true, preview: true, text, open: list.openCount, done: list.doneCount, skipped: list.skipped });
  if (!text) return NextResponse.json({ ok: true, skipped: true, reason: "no items" });

  // 重複防止（90分）: 手動実行・再試行で同じ一覧を連投しない
  const { data: last } = await supabase.from("hanbancyo_settings").select("value").eq("key", "staff_todo_last_sent_at").maybeSingle();
  if (last?.value && Date.now() - new Date(last.value as string).getTime() < 90 * 60 * 1000) {
    return NextResponse.json({ ok: true, skipped: true, reason: "cooldown (90min)" });
  }
  const sent = await pushToHanbancyoGroup(text);
  if (sent) await supabase.from("hanbancyo_settings").upsert({ key: "staff_todo_last_sent_at", value: new Date().toISOString() }, { onConflict: "key" });
  return NextResponse.json({ ok: sent, open: list.openCount, done: list.doneCount });
}
