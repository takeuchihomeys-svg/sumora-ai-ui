// app/lib/search-override-history.ts（サーバー用・DB を読む）
// 「前の条件」を読む口（2026-11-10 竹内さん）。
//   竹内さん「拡張ツールのところも前の条件いれて。AIXツールも前の条件だと理解できればより使いやすい。最新が一番優先される」
//   ＝ 一度「大正駅だけ・1LDK」で検索したお客様に、次に「家賃8万まで」とだけ言われたら、
//     「大正駅だけ・1LDK・家賃8万まで」で探す（書かれていない条件は前の物を残す・書かれた条件は新しい方で置き換える）。
//
// どこから読むか（新しい方を採る・2か所だけ）:
//   ① automation_commands の payload.search_override（web_brain＝AIXツールのメモ／aix＝ブレインの「今回だけ」）
//   ② property_pickups の search_override（その回の検索で実際に使った上書き。判定と画面の1行が読む物）
//   古すぎる物は使わない（PREV_MAX_AGE_MS）。お客様が引っ越しの話を何週間も前からしている時は、前の条件を残す方が近い。
//   ただし月をまたぐと条件が変わりすぎるので 30 日で切る（それより前は「前の条件」と呼べない）。
//
// 決まり: 読むだけ（DB に書かない）。関所（sanitizeSearchOverride）を通った物だけ返す。
import type { SupabaseClient } from "@supabase/supabase-js";
import { sanitizeSearchOverride } from "@/app/lib/search-override-read";
import type { SearchOverride } from "@/app/lib/search-override";

/** 前の条件として使う上限（30日） */
export const PREV_MAX_AGE_MS = 30 * 24 * 3600_000;

export type PreviousOverride = {
  override: SearchOverride;
  /** いつ時点の条件か（ISO） */
  at: string;
  /** どこから読んだか（点検・画面の1行） */
  from: "command" | "pickup";
};

const usable = (ov: SearchOverride | null, at: string | null, nowMs: number): boolean => {
  if (!ov) return false;
  const t = Date.parse(String(at ?? ""));
  return Number.isFinite(t) && nowMs - t <= PREV_MAX_AGE_MS;
};

/**
 * そのお客様の「前の条件」（一番新しい上書き）。無ければ null。投げない（読めなければ null＝今まで通り）。
 * @param opts.maxAgeMs 前の条件として使う上限（既定 PREV_MAX_AGE_MS）
 */
export async function loadPreviousSearchOverride(
  db: SupabaseClient,
  propertyCustomerId: string | null | undefined,
  opts: { nowMs?: number; maxAgeMs?: number } = {},
): Promise<PreviousOverride | null> {
  const cid = String(propertyCustomerId ?? "").trim();
  if (!cid) return null;
  const nowMs = opts.nowMs ?? Date.now();
  const maxAge = opts.maxAgeMs ?? PREV_MAX_AGE_MS;
  const within = (at: string | null): boolean => {
    const t = Date.parse(String(at ?? ""));
    return Number.isFinite(t) && nowMs - t <= maxAge;
  };
  const since = new Date(nowMs - maxAge).toISOString();
  const found: PreviousOverride[] = [];
  try {
    const { data, error } = await db
      .from("automation_commands")
      .select("id, created_at, payload")
      .in("payload->>source", ["web_brain", "aix"])
      .contains("customer_ids", [cid])
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(5);
    if (!error) {
      for (const r of (data ?? []) as Array<{ created_at: string | null; payload: { search_override?: unknown } | null }>) {
        const ov = sanitizeSearchOverride(r.payload?.search_override);
        if (ov && within(r.created_at)) { found.push({ override: ov, at: String(r.created_at), from: "command" }); break; }
      }
    }
  } catch { /* 読めない時は ② だけ見る */ }
  try {
    const { data, error } = await db
      .from("property_pickups")
      .select("created_at, search_override")
      .eq("property_customer_id", cid)
      .gte("created_at", since)
      .not("search_override", "is", null)
      .order("created_at", { ascending: false })
      .limit(5);
    if (!error) {
      for (const r of (data ?? []) as Array<{ created_at: string | null; search_override: unknown }>) {
        const ov = sanitizeSearchOverride(r.search_override);
        if (ov && within(r.created_at)) { found.push({ override: ov, at: String(r.created_at), from: "pickup" }); break; }
      }
    }
  } catch { /* 読めない時は ① だけ */ }
  if (!found.length) return null;
  // 新しい方を採る（同じ時刻ならコマンドの方を採る＝その回に指示された物が先）
  found.sort((a, b) => (Date.parse(b.at) - Date.parse(a.at)) || (a.from === "command" ? -1 : 1));
  const top = found[0];
  return usable(top.override, top.at, nowMs) ? top : null;
}
