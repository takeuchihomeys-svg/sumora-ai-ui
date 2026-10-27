// app/lib/brain-cache-order.ts — ブレインの材料を「キャッシュが効く並び」に置き直す（純関数・中身は1文字も減らさない）
//
// 2026-10-27 節約①（作業員1）。実測（本番7日）: brain_fresh 364回・キャッシュ読み 約4.5万・毎回読み直し 約2万トークン・効き 67%。
//   録音された本物の要求（brain_fresh 10/20〜 5,174回）で、前後の呼び出しの「毎回読み直しの部分（customerSpecific）」が先頭から同じなのは平均 2,582字/15,397字（17%）。
//   食い違いの始まりは AIX の一覧の2行目「【AIX のボタン×ピッカー（場面「◯◯」に関係する物）】」＝一覧の中身は場面だけで決まり、会話には依らない。
//   ところが一覧（約7,000字）とアクション別ルール（場面×会話の段階で決まる）は、会話ごとの材料（A・B）より後ろ・キャッシュの区切りの無い所に置かれていた。
//   → 2つを会話ごとの材料より前の独立したブロックにし、キャッシュの区切り（1h）を付ける＝同じ場面なら他の会話とも共有して読める。
//   区切りは最大4つ（system 2つ＋このブロック＝3つ）。温めのスイッチで A・B にも区切りが付いて4を超える時は、変わりやすい B の区切りから外す。
// スイッチ: BRAIN_CACHE_ORDER=on（既定 off＝今と1文字も同じ並び）

export function brainCacheOrderOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_CACHE_ORDER ?? "").trim().toLowerCase() === "on";
}

export type UserBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl?: "1h" } };

/**
 * 場面で決まる材料（AIX の一覧＋アクション別ルール）のブロックを、会話ごとの材料の前に置く。
 *   sceneText が空なら userContent をそのまま返す。区切りの合計（systemMarks＋user の区切り）が4を超えたら、後ろの会話ブロックの区切りから外す。
 */
export function withSceneBlock(userContent: ReadonlyArray<UserBlock>, sceneText: string, systemMarks: number, maxMarks = 4): UserBlock[] {
  if (!sceneText.trim()) return [...userContent];
  const out: UserBlock[] = [{ type: "text", text: sceneText, cache_control: { type: "ephemeral", ttl: "1h" } }, ...userContent.map((b) => ({ ...b }))];
  let marks = systemMarks + out.filter((b) => b.cache_control).length;
  for (let i = out.length - 1; i > 0 && marks > maxMarks; i--) {
    if (out[i].cache_control) { delete out[i].cache_control; marks--; }
  }
  return out;
}
