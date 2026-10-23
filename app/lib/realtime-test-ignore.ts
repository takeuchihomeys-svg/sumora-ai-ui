// app/lib/realtime-test-ignore.ts
// 2026-10-23 LINE画面の軽量化（Realtime）: 試験・再生のスクリプトがテスト専用の会話（YUMA・YUMA2〜5）に通を入れては消す。
//   2/12〜の messages は 384,546 件入って 356,528 件消えた（今ある通は約2.8万件）＝入る通の約93%が試験の通。
//   その1件ずつが開いている全部のスタッフの画面に Realtime で届き、一覧の作り直し・並べ替え・描き直しをしていた。
//   → テスト専用の会話の Realtime は、その会話を選んでいる時だけ当てる（他は30秒ごとの読み直しで追いつく）。
//   スタッフ同士の会話（STAFF_INTERNAL）は本物のやり取りなので外さない（isTestOnlyConversation＝YUMA＋YUMA2〜5 だけ）。
//   戻す NEXT_PUBLIC_RT_IGNORE_TEST=off
import { isTestOnlyConversation } from "./test-conversations";

export function rtIgnoreTestEnabled(raw: string | undefined): boolean {
  return (raw ?? "").trim().toLowerCase() !== "off";
}
export const RT_IGNORE_TEST = rtIgnoreTestEnabled(process.env.NEXT_PUBLIC_RT_IGNORE_TEST);

/** この会話の Realtime の出来事を読み飛ばすか（テスト専用の会話で・選んでいない時だけ） */
export function shouldIgnoreTestRealtime(
  conversationId: string | number | null | undefined,
  selectedId: string | null | undefined,
  enabled: boolean = RT_IGNORE_TEST,
): boolean {
  if (!enabled || conversationId === null || conversationId === undefined) return false;
  const cid = String(conversationId).trim();
  if (!cid || !isTestOnlyConversation(cid)) return false;
  return cid !== String(selectedId ?? "").trim();
}

/** 物件顧客の更新: つながる会話が全部テスト専用で、どれも選んでいない時だけ読み飛ばす（つながる会話が無い時は呼び手が先に返す） */
export function shouldIgnoreTestRealtimeForConvs(
  conversationIds: ReadonlyArray<string>,
  selectedId: string | null | undefined,
  enabled: boolean = RT_IGNORE_TEST,
): boolean {
  if (!enabled || conversationIds.length === 0) return false;
  return conversationIds.every((id) => shouldIgnoreTestRealtime(id, selectedId, true));
}
