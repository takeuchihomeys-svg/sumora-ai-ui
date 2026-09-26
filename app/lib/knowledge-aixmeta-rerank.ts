// app/lib/knowledge-aixmeta-rerank.ts
// 返信生成のナレッジ検索（match_reply_knowledge）の並べ替えに、最新のブレインの判断（AIX-META）を使う（純関数・依存なし）。
//
// 2026-09-13 竹内さん「動的な部分で最新の AIX-META を渡して質の高い RAG 検索にする」:
//   ナレッジの問いは「文書と同じ構成」（場面ラベル＋state＋直前のスタッフ発言＋今回の顧客発言・設計知見 d65330ad）のまま、
//   AIX-META は並べ替えにだけ使う。今は場面ラベルの加点（boost_state）だけで、推奨 AIX・お客様の質問・返信の方向は使っていなかった。
//   さらに今の並び（類似度×重要度×鮮度）は重要度の高い一般的な原則を上に上げすぎ、上位10件より11〜20件目の方が実際の返信に近かった。
//   評価（送信済み返信32件・送信時の新しい判断と実際の返信の対・上位10件と実際の返信の平均 cos）:
//     今 0.4340 → 推奨 AIX の話題 +0.03・言葉 +0.02: 0.4417 → +0.05/+0.03: 0.4435 → +0.08/+0.05: 0.4448（採用）→ +0.2/+0.12: 0.4475（伸びは小さく当てはめすぎの恐れ）
//   新しい判断（fresh かつ分析の省略でない）の時だけ使う（古い判断の推奨 AIX で並べ替えると、古い判断の注入＝穴:G6 になる）

/** 推奨 AIX ごとの「その場面のナレッジ」に出てくる語 */
export const AIX_TOPIC_RE: Record<string, RegExp> = {
  estimate_sheet: /見積|初期費用|割引|総額/,
  cost_explain: /初期費用|安さ|仕組み|報酬|還元/,
  cost_breakdown: /初期費用|敷金|礼金|日割|火災保険|内訳|見積/,
  guarantor_info: /保証会社|審査|独立系|信販|信用系|LICC|並行/,   // 種類は3つ（2026-09-26）。LICC は旧の言い方
  phone_call: /電話|通話|相談/,
  viewing_invite: /内覧|内見|案内|見学/,
  meeting_place: /待ち合わせ|集合|現地|案内/,
  greeting_viewing: /内覧|内見|案内/,
  application_push: /申込|申し込み|審査|書類/,
  property_send: /物件|ピックアップ|条件|お探し/,
  property_recommendation: /物件|オススメ|おすすめ|ピックアップ/,
  property_search: /物件|ピックアップ|条件/,
  property_check_result: /募集|空室|空き|管理会社/,
  acknowledge_check: /募集|空室|確認/,
  condition_hearing: /条件|希望|ヒアリング/,
};

export const AIX_TOPIC_BONUS = 0.08;
export const META_WORD_BONUS = 0.05;

const STOP_WORDS = /^(する|させ|頂く|こと|ため|よう|お客様|返信|確認する|伝える)$/;

/** お客様の質問・話題・返信の方向から、ナレッジの本文に探す語（漢字・カタカナの2文字以上・最大12語） */
export function extractMetaKeywords(parts: Array<string | null | undefined>): string[] {
  const text = parts.filter(Boolean).join(" ");
  const words = text.match(/[一-龠々ァ-ヶー]{2,}/g) ?? [];
  return [...new Set(words.filter((w) => !STOP_WORDS.test(w)))].slice(0, 12);
}

export type AixMetaRerankSignals = { action: string | null; words: string[] };

/** ナレッジ1件への加点（推奨 AIX の話題に合う +0.08・質問/話題/返信の方向の語を含む +0.05） */
export function aixMetaKnowledgeBonus(title: string | null | undefined, content: string | null | undefined, sig: AixMetaRerankSignals | null | undefined): number {
  if (!sig) return 0;
  const text = `${title ?? ""} ${content ?? ""}`;
  const re = sig.action ? AIX_TOPIC_RE[sig.action] : undefined;
  let b = 0;
  if (re && re.test(text)) b += AIX_TOPIC_BONUS;
  if (sig.words.length && sig.words.some((w) => text.includes(w))) b += META_WORD_BONUS;
  return b;
}
