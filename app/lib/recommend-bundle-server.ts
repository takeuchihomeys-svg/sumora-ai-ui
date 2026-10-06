// app/lib/recommend-bundle-server.ts（サーバー専用・画面から import しない）
// 物件オススメの「お送りした中でも」を決める材料: 直近の物件ピックアップ（束）を送ってからの時間と、オススメする部屋が束の中にあるか。
//
// 2026-10-06 ⑰ 竹内「お送りした中でもは物件ピックアップの中の物件オススメの物件についてオススメしている形。AIXの物件ピックアップで
//   複数の物件をピックアップして、そのなかでもお客さんにオススメする物件をAIXの物件オススメからおくっている」
//   束＝この会話で一番新しい AIX【物件ピックアップした】（aix_usage_logs property_send）。束の部屋＝その前後に送付記録（sent_properties・お客様に届いた行）に入った部屋。
//   判定（時間の線・束の外なら使わない）は recommendation-frame.bundleCompareOk（純関数）。ここは DB から材料を読むだけ。
import type { SupabaseClient } from "@supabase/supabase-js";
import { sameBuildingName, nameSimilarity } from "./candidate-facts";

export type RecommendBundleFacts = { hoursSinceLastBundle: number | null; starInLastBundle: boolean | null; bundleSize: number; members?: string[] };

/**
 * 束の部屋の名前の中にオススメする部屋の建物があるか（true＝束の中・false＝はっきり束の外・null＝分からない）。
 * ⚠ 束の部屋の名前は送った画像の読み取り（sent_properties の vision 行）で、字の読み違いが多い
 *   （180日の当て直し: 束の直後1時間で「束の外」と出た 40通のうち 29通はスタッフが比較の形＝実は束の中。
 *    「ガーデンプラッツ↔ガーデンプランツ」「プレジョール鶴見↔プレジール鶴見」「トラストマン編江↔堀江」）。
 *   → 近い名前（2文字組の近さ 0.5 以上）は束の中。はっきり束の外と言うのは、束に2部屋以上あって一番近い名前でも 0.3 未満の時だけ
 */
export const STAR_IN_BUNDLE_MIN = 0.5;
export const STAR_OUT_OF_BUNDLE_MAX = 0.3;
export function starInBundle(starName: string | null | undefined, members: readonly string[]): boolean | null {
  const s = String(starName ?? "").trim();
  if (!s || members.length === 0) return null;
  if (members.some((m) => sameBuildingName(m, s))) return true;
  const best = Math.max(...members.map((m) => nameSimilarity(m, s)));
  if (best >= STAR_IN_BUNDLE_MIN) return true;
  if (members.length >= 2 && best < STAR_OUT_OF_BUNDLE_MAX) return false;
  return null;
}

/** 束の時間と束の部屋（読めない時は「分からない」＝ hoursSinceLastBundle を undefined にして今までの判定に任せる） */
export async function loadRecommendBundleFacts(
  sb: SupabaseClient, conversationId: string, starName: string | null | undefined, nowMs: number = Date.now(),
): Promise<Partial<RecommendBundleFacts>> {
  try {
    const { data: logs, error } = await sb.from("aix_usage_logs").select("created_at").eq("conversation_id", conversationId).eq("aix_type", "property_send")
      .lte("created_at", new Date(nowMs).toISOString()).order("created_at", { ascending: false }).limit(1);
    if (error) return {};
    const last = (logs ?? [])[0] as { created_at?: string } | undefined;
    if (!last?.created_at) return { hoursSinceLastBundle: null, starInLastBundle: null, bundleSize: 0 };
    const t = Date.parse(last.created_at);
    const { data: rows } = await sb.from("sent_properties").select("property_name, delivery, sent_at").eq("conversation_id", conversationId)
      .gte("sent_at", new Date(t - 3 * 60_000).toISOString()).lte("sent_at", new Date(t + 5 * 60_000).toISOString()).limit(60);
    const members = [...new Set(((rows ?? []) as Array<{ property_name: string | null; delivery: string | null }>)
      .filter((r) => r.delivery !== "shared" && r.property_name).map((r) => String(r.property_name)))];
    return { hoursSinceLastBundle: Math.max(0, (nowMs - t) / 3_600_000), starInLastBundle: starInBundle(starName, members), bundleSize: members.length, members };
  } catch {
    return {};
  }
}
