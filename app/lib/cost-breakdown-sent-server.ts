// app/lib/cost-breakdown-sent-server.ts — この会話で直近21日に送った御見積書の画像（読み取り済み image_details.kind=estimate）を DB から読む所（読むだけ）
//   AIX【初期費用について】の文の生成（/api/aix/action）と、画面の初期値（/api/aix/sent-estimates）が同じ物を使う
//   2026-10-28 本番の確かめ: 画面は画像が0枚だと生成ボタンを押せず、サーバの代わりの道（COST_BREAKDOWN_SENT_ESTIMATE）に届かなかった → 画面の初期値にも同じ物を入れる
import { supabase } from "@/app/lib/supabase-server";
import { pickSentEstimateUrls } from "@/app/lib/cost-breakdown-sent";

export async function loadSentEstimateUrls(conversationId: string, nowMs: number = Date.now()): Promise<string[]> {
  const sinceIso = new Date(nowMs - 21 * 86_400_000).toISOString();
  // 送った時刻で選ぶ（読み取りの時刻は後から読み直した分で揃うことがある）: スタッフが送った画像 → そのうち読み取りが見積書の物
  const { data: sentImgs } = await supabase.from("messages").select("image_url, created_at").eq("conversation_id", conversationId).neq("sender", "customer").not("image_url", "is", null).gte("created_at", sinceIso).order("created_at", { ascending: false }).limit(40);
  const imgRows = ((sentImgs ?? []) as Array<{ image_url: string | null; created_at: string | null }>).filter((r) => r.image_url);
  const { data: est } = imgRows.length ? await supabase.from("image_details").select("image_url").eq("kind", "estimate").in("image_url", imgRows.map((r) => r.image_url as string)) : { data: [] };
  const estSet = new Set(((est ?? []) as Array<{ image_url: string }>).map((r) => r.image_url));
  return pickSentEstimateUrls(imgRows.filter((r) => estSet.has(r.image_url as string)).map((r) => ({ image_url: r.image_url, read_at: r.created_at })));
}
