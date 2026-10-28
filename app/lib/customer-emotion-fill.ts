// app/lib/customer-emotion-fill.ts — 番ごとの「お客様の気持ち」の欄を空にしない（純関数）
//
// 2026-10-28 作業員5（統括のブレインの状況のまとめの土台・scripts/audit-conductor-states.ts）:
//   竹内さんの番 879 のうち、その番のブレインの記録（brain_decision_logs.digest.emo）に気持ちがあるのは 36% だけ。
//   判断はあるのに気持ちが空 15%（customer_emotion が空・customer_mindset.state はある）／その番の判断の記録が無い 49%。
//   気持ちは統括の振り分けの状態の2番目に効く欄（場面×約束×気持ちで、竹内さんの動きがそろう番が一番増えた）。
// 埋め方（上から・決まった所で止める）:
//   ① その番のブレインの customer_emotion
//   ② その番のブレインの customer_mindset.state（気持ちの要約の一番目）
//   ③ 前の判断（last_brain_meta）の customer_emotion／customer_mindset.state を引き継ぐ（その番にブレインが動かなかった時）
//   ④ お客様の文の言葉で決まった手順の仮の値（「仮」の札・言葉が無ければ空）
// 入れる BRAIN_EMOTION_FILL（既定 on・止める off）。決めた値は材料・記録だけに使う（文を書き換えない）
export function brainEmotionFillOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_EMOTION_FILL ?? "on").trim().toLowerCase() !== "off";
}

export type EmotionSource = "brain" | "mindset" | "inherited" | "provisional";
export type FilledEmotion = { value: string; source: EmotionSource } | null;

type MetaLike = { customer_emotion?: unknown; customer_mindset?: { state?: unknown } | null } | null | undefined;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 20) : null);

/** お客様の文の言葉から仮の気持ち（言い切れる語がある時だけ・無ければ null） */
export function provisionalEmotion(text: string | null | undefined): string | null {
  const t = String(text ?? "").normalize("NFKC");
  if (!t.trim() || /^\s*\[(?:画像|動画|ファイル)/.test(t)) return null;
  if (/急ぎ|急いで|至急|今日中|明日まで|すぐに?(?:入居|住|引っ?越)|早めに|早く/.test(t)) return "急いでいる";
  if (/不安|心配|怖い|大丈夫(?:でしょうか|ですか)|通るか|通りますか|迷って|悩んで|どうしよう|😭|💦|🥲|😢/.test(t)) return "迷い・不安";
  if (/嬉しい|うれしい|助かり|ありがたい|最高|いいですね|良いですね|気に入|素敵|楽しみ|😊|😆|🥰|✨|！！/.test(t)) return "前向き";
  if (/高い|厳しい|微妙|ちょっと(?:難しい|違う)|やめ|見送|なし(?:で|に)/.test(t)) return "乗り気でない";
  return null;
}

export function fillCustomerEmotion(o: { meta?: MetaLike; prevMeta?: MetaLike; customerText?: string | null }): FilledEmotion {
  const a = str(o.meta?.customer_emotion);
  if (a) return { value: a, source: "brain" };
  const b = str(o.meta?.customer_mindset?.state);
  if (b) return { value: b, source: "mindset" };
  const c = str(o.prevMeta?.customer_emotion) ?? str(o.prevMeta?.customer_mindset?.state);
  if (c) return { value: c, source: "inherited" };
  const d = provisionalEmotion(o.customerText);
  return d ? { value: d, source: "provisional" } : null;
}
