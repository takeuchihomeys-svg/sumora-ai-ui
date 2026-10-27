// GET /api/cron/staff-todo-list（vercel.json: 30 1-11 * * * ＝ 日本時間 10:30〜20:30 の1時間ごと）
//   つなぎのブレイン（管理者）が売上番長グループ（LINE_STAFF_GROUP_ID）に出す【やることリスト】（2026-10-20 竹内さん・設計知見 1d7ac7f4）。
//   2026-10-21 竹内さんの決定（f87ccb7e）: 被っている AIX要対応リスト（announce-aix-actions）を置き換える・
//     やることリストは必ず行う物・✅はグループの✅も（hanbancyo-webhook → staff-todo-reply）・基本は LINE から自動・14日を過ぎた約束は外す・（0日）は書かない
//   2026-10-21 竹内さんの決定（268a904a）: 🌟ターゲット🌟をまとめる（TODO_TARGET_MERGE・既定 on＝announce-hot-customers は別の投稿を出さない）・
//     ターゲットは毎日「新着の物件確認」（物件を送れば✅・グループの「☑3」「〇〇さん なし」で☑）・アナウンスは営業時間に1時間ごと（旧 2時間ごと）。
//     並び（cb760598・1214dc48）と的確な指示（c0a91198）は staff-todo-priority.ts・staff-todo-instruction.ts
//   組み立ては app/lib/staff-todo-list.ts（決まった計算・LLM なし）。
//   切替 STAFF_TODO_LIST（既定 on）。off にすると送らず、announce-aix-actions が元の AIX要対応リスト・announce-hot-customers がターゲットを送る。
//   ?preview=1 … 送らずに文だけ返す（切替に関係なく・読むだけ・片付けもしない）。&at=<ISO> でその時点の一覧
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase-server";
import { loadStaffTodoList } from "@/app/lib/staff-todo-list-server";
import { composeStaffTodoPost, staffTodoListEnabled, TODO_LIST_MAX_CHARS, STAFF_TODO_COOLDOWN_MS } from "@/app/lib/staff-todo-list";
import { pushToHanbancyoGroupWithId, dismissStaleAixActionItems, AIX_NOTICE_FRESH_MS } from "@/app/lib/aix-action-items";
import { saveTodoSnapshot, snapshotOf, loadTodoSnapshots } from "@/app/lib/staff-todo-reply-server";
// 2026-10-28 読み込みの締め切り（STAFF_TODO_FAST_LOAD=on の時だけハブの予算を残り時間から決める）
import { todoDeadlineAtMs } from "@/app/lib/staff-todo-load-timing";

// 10/26 午後から 60秒で切れて一覧が送れていなかった（Vercel Runtime Timeout）。読み込みが重くなったので上限を 300秒に
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const startedAtMs = Date.now();
  const deadlineAtMs = todoDeadlineAtMs(startedAtMs, maxDuration);
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const preview = url.searchParams.get("preview") === "1";
  const atParam = url.searchParams.get("at");
  const atMs = atParam && Number.isFinite(Date.parse(atParam)) ? Date.parse(atParam) : Date.now();

  if (preview) {
    const list = await loadStaffTodoList(supabase, atMs, { deadlineAtMs });
    const post = composeStaffTodoPost(list, { snapshots: await loadTodoSnapshots(supabase) });
    const text = post.text;
    return NextResponse.json({ ok: true, preview: true, text, length: text?.length ?? 0, open: list.openCount, done: list.doneCount, carried: post.carried, skipped: list.skipped });
  }
  if (!staffTodoListEnabled()) return NextResponse.json({ ok: true, skipped: true, reason: "STAFF_TODO_LIST is off" });

  // 重複防止（50分）: 手動実行・再試行で同じ一覧を連投しない（1時間ごとの便は通す）
  const { data: last } = await supabase.from("hanbancyo_settings").select("value").eq("key", "staff_todo_last_sent_at").maybeSingle();
  if (last?.value && Date.now() - new Date(last.value as string).getTime() < STAFF_TODO_COOLDOWN_MS) {
    return NextResponse.json({ ok: true, skipped: true, reason: "cooldown (50min)" });
  }

  // 48時間より前のお客様発言への AIX 要対応を片付ける（置き換えた AIX要対応リストがしていた事・宣言済みのピックアップは残す）
  const stale = await dismissStaleAixActionItems(AIX_NOTICE_FRESH_MS).catch((e) => { console.warn("[staff-todo] stale:", e); return null; });

  const list = await loadStaffTodoList(supabase, Date.now(), { deadlineAtMs });
  // 長い時は④⑤を入るだけ出して残りは次の便へ（2026-10-21 竹内さん「オススメでおねがい」）。回す順は前の便の控えから
  const post = composeStaffTodoPost(list, { snapshots: await loadTodoSnapshots(supabase) });
  const text = post.text;
  if (!text) return NextResponse.json({ ok: true, skipped: true, reason: "no items", stale });

  // LINE の text は 5000字まで（超えると送信が 400 で落ちる）。長い時は組み立てが④⑤を1人1行に詰め、それでも長ければ入るだけ出して残りを次の便に回す。それでも長ければ後ろを切る
  const safeText = text.length > TODO_LIST_MAX_CHARS ? `${text.slice(0, TODO_LIST_MAX_CHARS)}\n…（以下省略）` : text;
  const sent = await pushToHanbancyoGroupWithId(safeText);
  if (sent.ok) {
    const nowIso = new Date().toISOString();
    await supabase.from("hanbancyo_settings").upsert({ key: "staff_todo_last_sent_at", value: nowIso }, { onConflict: "key" });
    // 番号の控え（グループで「✅3」と返された時にどの行か分かるように）。この便に出した一覧（回した人は入らない）で振る＝次の便の回す順にも使う
    await saveTodoSnapshot(supabase, snapshotOf(post.list, sent.messageId, nowIso));
  }
  return NextResponse.json({ ok: sent.ok, open: list.openCount, done: list.doneCount, carried: post.carried, length: safeText.length, stale });
}
