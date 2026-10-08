// app/lib/search-result-choice.ts — 検索の結果を見て決める番の2択（AIX【物件ピックアップした／物件オススメ】か AIX【全力サポート】か）（純関数）
//
// 2026-10-08 竹内さん（足りない把握の調べの答え③）「そう。物件が無ければそっちから送るので、その場面の時は2択にする」:
//   ピックアップの約束（2段:pickup）の 19% は人が「新着で…出次第お送り」（＝探したが今は合うお部屋が無い）と書いている。
//   これは検索の結果＝スタッフだけが知る情報で、送った件数・間隔では線が引けなかった（scripts/audit-grasp-gaps の調べ）。
//   → ブレインが物件の AIX（物件ピックアップした・物件オススメ・物件を探す）を出す番で、売上サポに今送れる候補が無い（pickupReady=false＝検索してみないと分からない）時は、
//     2つ目の AIX に【全力サポート】を並べる（alt_actions）。物件があればピックアップ側、無ければ全力サポート側をスタッフが選ぶ。
//   売上サポに新しい候補がある時（送れる物がある）・申込以降・2段の約束の返信にした番（AIX が無い）は並べない。
//   戻す: SEARCH_RESULT_TWO_CHOICE=off
// テスト: app/lib/__tests__/search-result-choice.test.ts

export const PROPERTY_AIX = new Set(["property_send", "property_recommendation", "property_search"]);

export function searchResultChoiceEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.SEARCH_RESULT_TWO_CHOICE ?? "").trim().toLowerCase() !== "off";
}

/**
 * 2つ目の AIX の並び（元の alt_actions に全力サポートを足した物）。足さない時は元のまま。
 *   pickupReady … 売上サポに今送れる新しい候補がある（brain-core の freshPickupReady）。null＝読んでいない（物件の AIX でない番）
 */
export function searchResultAltActions(o: {
  finalAix: string | null | undefined;
  pickupReady: boolean | null | undefined;
  postApply: boolean;
  altActions: string[] | undefined;
  env?: Record<string, string | undefined>;
}): { altActions: string[] | undefined; added: boolean } {
  const keep = { altActions: o.altActions, added: false };
  if (!searchResultChoiceEnabled(o.env)) return keep;
  if (!o.finalAix || !PROPERTY_AIX.has(o.finalAix) || o.postApply) return keep;
  if (o.pickupReady !== false) return keep;
  const alts = [...(o.altActions ?? [])].filter((a) => a !== o.finalAix);
  if (alts.includes("zenryoku_support")) return keep;
  return { altActions: [...alts, "zenryoku_support"], added: true };
}

/** 画面・ブレインのメモに付ける一文 */
export const SEARCH_RESULT_CHOICE_NOTE = "（検索の結果で選ぶ: 送れる物件があれば AIX【物件ピックアップした／物件オススメ】・今は条件に合うお部屋が無ければ AIX【全力サポート】）";
