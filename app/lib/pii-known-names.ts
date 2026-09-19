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
