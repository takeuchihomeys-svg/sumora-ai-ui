// 試験の写し: 申込の意思の番で、本番の会話の「申込の情報の状態」（app/lib/apply-info-state.ts）を試験の会話にも見せる。2026-11-11 作業員3（A2）
//   試験の問題の会話は 30通の写しで、申込の書類（記入済みのフォーマット）は個人の値のため写さない＝本番のブレインが読める「届いている」が試験では消える。
//   本番の会話を読むだけ（LLM なし）で状態を決め、場面の最初の通の前に、個人の値の無い決まった1通（こちらの文）を入れる:
//     received → 「お申込み完了しております！！」（申込が動いた事実だけ）／ form_sent → 空の申込フォーマットの見出し（スタッフが送る形＝個人の値なし）
//   APPLY_INTENT_FORM_STATE=on の時だけ（off の回・前の基準は今まで通り何も入れない）。止める EXAM_APPLY_INFO_COPY=off
import type { SupabaseClient } from "@supabase/supabase-js";
import { APPLY_INFO_OR_FILTER, readApplyInfoState, isApplyIntentTurn, applyIntentFormStateOn, type ApplyInfoMsg, type ApplyInfoReading } from "../../app/lib/apply-info-state";

export { APPLY_INFO_OR_FILTER };

export function examApplyInfoCopyOn(env: Record<string, string | undefined> = process.env): boolean {
  return applyIntentFormStateOn(env) && (env.EXAM_APPLY_INFO_COPY ?? "").trim().toLowerCase() !== "off";
}

/** 本番の会話の番の時点の状態（読むだけ） */
export async function prodApplyInfoReading(sb: SupabaseClient, conv: string, atIso: string): Promise<ApplyInfoReading> {
  const { data, error } = await sb.from("messages").select("sender, text, created_at, image_type")
    .eq("conversation_id", conv).lt("created_at", atIso).gte("created_at", new Date(Date.parse(atIso) - 180 * 86_400_000).toISOString())
    .or(APPLY_INFO_OR_FILTER).order("created_at", { ascending: false }).limit(60);
  if (error) throw new Error(error.message);
  return readApplyInfoState((data ?? []) as ApplyInfoMsg[]);
}

/** 入れる決まった1通（個人の値なし）。none は入れない */
export function applyInfoStandInText(state: ApplyInfoReading["state"]): string | null {
  if (state === "received") return "お申込み完了しております！！";
  if (state === "form_sent") return "【お申込者様記入欄】\n・入居希望日\n・氏名、フリガナ\n・生年月日";
  return null;
}

/** 試験の会話に入れる行（入れない時は null）。customerText は問題のお客様の連投 */
export async function examApplyInfoRow(sb: SupabaseClient, p: { conv: string; at: string; customer: string }, firstSceneIso: string, conv: string, lineId: string):
  Promise<{ row: Record<string, unknown>; reading: ApplyInfoReading } | null> {
  if (!examApplyInfoCopyOn() || !isApplyIntentTurn(p.customer)) return null;
  const reading = await prodApplyInfoReading(sb, p.conv, p.at);
  const text = applyInfoStandInText(reading.state);
  if (!text) return null;
  return { reading, row: { conversation_id: conv, sender: "staff", text, is_aix_generated: false, line_message_id: lineId, created_at: new Date(Date.parse(firstSceneIso) - 500).toISOString() } }; // 線（場面の最初の通の1秒前）より後・場面の最初の通より前＝ブレインの20通の窓の外（本番の古い通と同じ）
}
