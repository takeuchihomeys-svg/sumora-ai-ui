// app/lib/staff-todo-reply-server.ts — 【やることリスト】の控え（どの番号がどの行か）の保存と、グループの✅の書き込み
//   読み方・結びつけ方は staff-todo-reply.ts（純関数）。グループの発言は hanbancyo-webhook が渡す。
//   書く物:
//     staff_todo_marks（表・scripts/staff-todo-marks-migration.sql）… 行の鍵と✅の時刻（一覧の✅・経過の止め）。表が無い間は書けない（下の2つは書く）
//     aix_action_items … AIX 要対応の行なら status=done・done_by=staff_group（AIX要対応の他の画面・朝の報告とも揃う）
//     calendar_events  … お客様への約束の行なら is_done=true（カレンダー・朝の報告とも揃う）
import type { SupabaseClient } from "@supabase/supabase-js";
import { numberTodoItems, type TodoList } from "@/app/lib/staff-todo-list";
import {
  parseTodoReply, pickTodoSnapshot, resolveTodoReply, renderTodoReplyAck, TODO_SNAPSHOT_KEEP,
  type TodoSnapshot, type TodoSnapshotItem,
} from "@/app/lib/staff-todo-reply";

const SNAP_KEY = "staff_todo_snapshots";

export async function loadTodoSnapshots(sb: SupabaseClient): Promise<TodoSnapshot[]> {
  const { data } = await sb.from("hanbancyo_settings").select("value").eq("key", SNAP_KEY).maybeSingle();
  const v = data?.value as unknown;
  try {
    const arr = typeof v === "string" ? JSON.parse(v) : v;
    return Array.isArray(arr) ? (arr as TodoSnapshot[]) : [];
  } catch { return []; }
}

/**
 * 【やることリスト】を送るグループ（pushToHanbancyoGroup と同じ決め方: env → hanbancyo_settings.group_id）。
 *   2026-10-21 確かめる人: 同じボットが入っている物件出しのグループ（pickup_group_id）の「✅3」「完了 〇〇」で一覧の行を✅にしないように、
 *   このグループの発言だけを読む
 */
export async function todoListGroupId(sb: SupabaseClient): Promise<string | null> {
  if (process.env.LINE_STAFF_GROUP_ID) return process.env.LINE_STAFF_GROUP_ID;
  const { data } = await sb.from("hanbancyo_settings").select("value").eq("key", "group_id").maybeSingle();
  return (data?.value as string | undefined) ?? null;
}

/** 送った一覧の番号の控え（新しい順に数件） */
export function snapshotOf(list: TodoList, messageId: string | null, sentAtIso: string): TodoSnapshot {
  return {
    messageId, sentAt: sentAtIso,
    items: numberTodoItems(list).map(({ n, item, customer }): TodoSnapshotItem => ({
      n, key: item.key, conversationId: item.conversationId, name: customer.name, label: `${item.kindLabel}：${item.task}`.slice(0, 80),
    })),
  };
}
export async function saveTodoSnapshot(sb: SupabaseClient, snap: TodoSnapshot): Promise<void> {
  const prev = await loadTodoSnapshots(sb);
  const next = [snap, ...prev].slice(0, TODO_SNAPSHOT_KEEP);
  const { error } = await sb.from("hanbancyo_settings").upsert({ key: SNAP_KEY, value: JSON.stringify(next) }, { onConflict: "key" });
  if (error) console.warn("[staff-todo] snapshot save:", error.message);
}

/** 行を✅にする（表への記録＋元の行の完了）。表に書けなかった鍵を返す */
export async function markTodoItemsDone(sb: SupabaseClient, items: ReadonlyArray<TodoSnapshotItem>, by: { userId: string | null; text: string }, nowIso: string): Promise<{ unrecorded: string[] }> {
  const unrecorded: string[] = [];
  if (items.length === 0) return { unrecorded };
  const { error } = await sb.from("staff_todo_marks").upsert(
    items.map((i) => ({ item_key: i.key, conversation_id: i.conversationId, marked_at: nowIso, marked_by: by.userId, via: "group_reply", note: by.text.slice(0, 200) })),
    { onConflict: "item_key", ignoreDuplicates: true },
  );
  if (error) { console.warn("[staff-todo] staff_todo_marks write:", error.message); unrecorded.push(...items.map((i) => i.key)); }
  const aixIds = items.filter((i) => i.key.startsWith("aix:")).map((i) => i.key.slice(4));
  const promiseIds = items.filter((i) => i.key.startsWith("promise:")).map((i) => Number(i.key.slice(8))).filter(Number.isFinite);
  if (aixIds.length) {
    const r = await sb.from("aix_action_items").update({ status: "done", done_at: nowIso, done_by: "staff_group", updated_at: nowIso })
      .in("id", aixIds).eq("status", "pending");
    if (r.error) console.warn("[staff-todo] aix done:", r.error.message);
  }
  if (promiseIds.length) {
    const r = await sb.from("calendar_events").update({ is_done: true }).in("id", promiseIds).eq("is_done", false);
    if (r.error) console.warn("[staff-todo] promise done:", r.error.message);
  }
  return { unrecorded };
}

/**
 * グループの発言を読んで✅にし、返事の文を返す（読まない発言は null＝何も返さない）。
 * 表がまだ無い時、AIX 要対応・約束の行は元の行を閉じるので✅になる。返信・内覧の行は表が無いと残る（返事でそう伝える）
 */
export async function handleTodoGroupReply(sb: SupabaseClient, ev: { text: string; quotedMessageId?: string | null; userId?: string | null }, nowMs: number = Date.now()): Promise<string | null> {
  const parsed = parseTodoReply(ev.text);
  if (!parsed) return null;
  const snaps = await loadTodoSnapshots(sb);
  const snap = pickTodoSnapshot(snaps, ev.quotedMessageId ?? null, nowMs);
  if (!snap) return null;
  const res = resolveTodoReply(parsed, snap);
  // 番号も名前も当たらず、名前だけの返信（普段の会話の「〇〇さん済みです」等）は黙る。番号を書いた時だけ「無い」と返す
  if (res.hits.length === 0 && res.unknownNumbers.length === 0) return null;
  const nowIso = new Date(nowMs).toISOString();
  const { unrecorded } = await markTodoItemsDone(sb, res.hits, { userId: ev.userId ?? null, text: ev.text }, nowIso);
  // 残りの数は返さない（LINE の送信で自動の✅になった行は表に無いので、表だけで数えると多く見える）。次の一覧で分かる
  const ack = renderTodoReplyAck(res, null);
  const lost = res.hits.filter((h) => unrecorded.includes(h.key) && !h.key.startsWith("aix:") && !h.key.startsWith("promise:"));
  return lost.length ? `${ack ?? ""}\n⚠️ ${lost.map((h) => h.n).join("・")} は記録の表がまだ無いため、次の一覧にも出ます` : ack;
}
