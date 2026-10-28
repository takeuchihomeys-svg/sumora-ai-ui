// app/lib/brain-depth.ts — 統括の③「どこまで深く読むか」を番ごとに決める（純関数・まずは記録だけ）
//
// 2026-10-29 竹内さんの答え③「軽い番は前の判断の引き継ぎと安い AI・送れる物の確かめは残す」・10/28「深く読む部分なら深く読むなどの判断を強化」。
// 学び（project_brain_weaknesses）: 「速く・じっくり」を全部の番に一律で試して効かなかった → 深さは場面と状態で決める。
// 第1段（この版）: 深さと理由を毎回ログ（brain:depth）に残すだけ。判断・費用は変えない。数えてから（浅すぎ＝材料が届かない外れ／深すぎ＝読み直しの費用）
//   軽い番の引き継ぎ（LLM を安い物にする・呼ばない）を次の段で入れる。テスト: app/lib/__tests__/brain-depth.test.ts
export type BrainDepth = "light" | "normal" | "deep";
export type DepthInput = {
  /** 今のお客様の連投の文 */
  turnText: string;
  /** スタンプ・画像だけ（文字が無い） */
  stampOnly: boolean;
  /** お礼・了承だけ（問い・依頼が無い） */
  ackOnly: boolean;
  /** 前のこちらの通が締め（ご検討・何卒・新着が出次第 等） */
  closedBefore: boolean;
  /** 売上サポに送れる新しい候補がある（ある時は軽くしない＝送れる物の確かめは残す） */
  pickupReady: boolean | null;
  /** こちらのまだ果たしていない約束の数 */
  openPromises: number;
  /** 前のお客様の通からの空き（時間） */
  gapHours: number | null;
};

const DEEP_WORDS: ReadonlyArray<[string, RegExp]> = [
  ["申込", /申込|申し込|契約/],
  ["審査", /審査|保証人|名義|在籍確認/],
  ["費用の不満", /高い|高すぎ|安く(?:なら|でき)|値引|割引|予算(?:オーバー|を超)/],
  ["条件の言い直し", /(?:やっぱり|やはり|でも大丈夫|じゃなくても|に変え|変更|広げ|上げても)/],
  ["キャンセル・断り", /キャンセル|やめ(?:ます|とき)|見送|他で決め|他社/],
];

export function decideBrainDepth(i: DepthInput): { depth: BrainDepth; reason: string } {
  const t = String(i.turnText ?? "").normalize("NFKC");
  const deep = DEEP_WORDS.find(([, re]) => re.test(t));
  if (deep) return { depth: "deep", reason: deep[0] };
  const asks = (t.match(/[?？]/g) ?? []).length + (t.match(/(?:ますか|ですか|でしょうか|ください|下さい|ほしい|欲しい)/g) ?? []).length;
  if (asks >= 2) return { depth: "deep", reason: "複数の依頼" };
  if (i.gapHours !== null && i.gapHours >= 24 * 7) return { depth: "deep", reason: "久しぶりの連絡" };
  if (i.openPromises > 0 && !i.ackOnly && !i.stampOnly) return { depth: "deep", reason: "約束の結果待ちの番" };
  if ((i.stampOnly || i.ackOnly) && i.closedBefore && !i.pickupReady && i.openPromises === 0) return { depth: "light", reason: i.stampOnly ? "締めの後のスタンプ" : "締めの後の短いお礼" };
  if (i.ackOnly && Array.from(t.trim()).length <= 20 && !i.pickupReady) return { depth: "light", reason: "短いお礼・了承" };
  return { depth: "normal", reason: "一般" };
}
