// app/lib/customer-sim-guard.ts
// お客様役（テスト）の鍵と印（2026-09-27 竹内「YUMA で自動的に YUMA から自動返信が来て、返信を繰り返せたら理想」）。
//
// お客様の発言は本来 LINE の署名つきの webhook からしか入らない。お客様役は本番のサーバーの中の入口
// （/api/test/customer-sim）から、webhook と同じ関数（line-webhook-text.handleTextMessage）で会話に入れる。
// 本物のお客様に一切動かないよう、入口は三重の鍵:
//   ① 内部認証（requireInternalAuth）  ② 環境変数 CUSTOMER_SIM_ENABLED が "1"／"true" の時だけ
//   ③ テスト用の会話の一覧（test-conversations.ts）にある会話だけ（それ以外は必ず 403）
//
// 印: お客様役の発言は messages.line_message_id を "sim-<uuid>" にする（列を足さない・LINE の id は数字だけなので重ならない）。
//   これで「今の番がお客様役か」を DB から読める。お客様役の番では売上番長グループ・鈴木さんへの通知
//   （AIX要対応・条件受領・地域変更・物件出しの依頼・条件の矛盾）とカレンダーの登録と物件の自動検索を出さない。
//   竹内さんが YUMA の LINE から送った本物の発言（手動のテスト）は印が無いので今まで通り。
import { supabase } from "@/app/lib/supabase";
import { isTestConversation } from "@/app/lib/test-conversations";

/** お客様役の発言の line_message_id の頭（LINE の message id は数字だけ） */
export const SIM_LINE_MESSAGE_PREFIX = "sim-";

/** お客様役の発言の line_message_id か */
export function isSimLineMessageId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(SIM_LINE_MESSAGE_PREFIX);
}

/** お客様役の発言に付ける line_message_id（重複保存の防止にもそのまま効く） */
export function newSimLineMessageId(): string {
  return `${SIM_LINE_MESSAGE_PREFIX}${crypto.randomUUID()}`;
}

/** 環境変数のスイッチ（"1" / "true" だけ。書き間違い・空は切） */
export function customerSimEnabled(raw: string | null | undefined = process.env.CUSTOMER_SIM_ENABLED): boolean {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

export type SimAccess = { ok: true } | { ok: false; status: 401 | 403 | 400; reason: string };

/**
 * 入口の鍵（純関数）。順番: 認証 → スイッチ → 会話の一覧。
 * 認証が通らなければ 401、スイッチが切・テスト用でない会話は 403。
 */
export function checkCustomerSimAccess(input: { authOk: boolean; enabled: boolean; conversationId: string | null | undefined }): SimAccess {
  if (!input.authOk) return { ok: false, status: 401, reason: "unauthorized" };
  if (!input.enabled) return { ok: false, status: 403, reason: "customer_sim_disabled" };
  const cid = String(input.conversationId ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(cid)) return { ok: false, status: 400, reason: "conversation_id required" };
  if (!isTestConversation(cid)) return { ok: false, status: 403, reason: "not_a_test_conversation" };
  return { ok: true };
}

/**
 * 今の番（最後のお客様の発言）がお客様役か。
 *   テスト用の会話でなければ DB を読まずに false（本物のお客様の経路には読み取りも増やさない）。
 *   テスト用の会話で読み取りに失敗した時は true（通知を出さない側に倒す）。
 */
export async function isSimulatedCustomerTurn(conversationId: string | null | undefined): Promise<boolean> {
  if (!isTestConversation(conversationId)) return false;
  try {
    const { data, error } = await supabase
      .from("messages")
      .select("line_message_id")
      .eq("conversation_id", String(conversationId))
      .eq("sender", "customer")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return true;
    return isSimLineMessageId((data?.line_message_id as string | null) ?? null);
  } catch {
    return true;
  }
}
