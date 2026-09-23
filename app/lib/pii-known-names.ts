// app/lib/pii-known-names.ts
// 読み替え（pii-pseudonym）の「正解集合」＝お客様の名前を取ってくる1か所。
//
// 2026-09-19 竹内「お客さんの本名や電話番号は絶対にマスキングするように」
//   事例（ai_reply_examples）には**他のお客様**の会話が毎回8件載るので、当事者の名前だけでは足りない。
//   会話は300件台なので全部持っても軽い。5分だけ覚えておく。
//
// ⚠ AIX と返信生成で別々に実装しない（設計知見「同じ事実を2か所に置かない」）。
//   pii-pseudonym.ts は DB に触らない純関数のままにしたいので、取得はこのファイルに分ける。
import { supabase } from "./supabase";

let cache: { at: number; names: string[] } | null = null;
const TTL_MS = 5 * 60_000;

/**
 * 当事者の別名: property_customers の登録名（本名のことがある）。
 * 2026-09-23 YUMA の DeepSeek 実測: 【お客様の希望条件（DB登録済み）】の「顧客名: 〇〇さん」は LINE の表示名と違い、
 *   全会話の表示名一覧にも無いので素のまま外に出ていた（ground-truth.ts が property_customer_id で引く）。
 *   取れなくても生成は止めない（表示名の仮名化は別に効く）
 */
export async function loadPartyAliases(conversationId: string | null | undefined): Promise<string[]> {
  if (!conversationId) return [];
  try {
    const { data: conv } = await supabase.from("conversations").select("property_customer_id").eq("id", conversationId).maybeSingle();
    const pcId = (conv as { property_customer_id?: string | null } | null)?.property_customer_id ?? null;
    if (!pcId) return [];
    const { data: pc } = await supabase.from("property_customers").select("customer_name").eq("id", pcId).maybeSingle();
    const name = String((pc as { customer_name?: string | null } | null)?.customer_name ?? "").trim();
    return name ? [name] : [];
  } catch (e) {
    console.warn("[pii-known-names] 登録名の取得失敗:", e instanceof Error ? e.message : e);
    return [];
  }
}

/** 全会話のお客様名（重複なし）。取れなければ前回の値、それも無ければ空 */
export async function loadKnownCustomerNames(): Promise<string[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.names;
  try {
    const { data } = await supabase.from("conversations").select("customer_name").limit(2000);
    const names = [...new Set((data ?? [])
      .map((r: { customer_name: string | null }) => (r.customer_name ?? "").trim())
      .filter(Boolean))];
    cache = { at: Date.now(), names };
    return names;
  } catch (e) {
    // 取れなくても当事者の名前は伏せられる。ここで生成を止めない
    console.warn("[pii-known-names] 取得失敗:", e instanceof Error ? e.message : e);
    return cache?.names ?? [];
  }
}
