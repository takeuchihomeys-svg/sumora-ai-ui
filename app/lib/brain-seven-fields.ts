// app/lib/brain-seven-fields.ts — 案A: 本番の番でブレインに竹内さんの7つの欄（seven_read）と潜在の4欄（latent_read）を出させる（既定 off）
//
// 2026-11-12 作業員10（統括役の案A・竹内さん 11/12「文の構成のところにもちゃんと細分化されたブレインの判断が届くように」・KB 1f5bd301・d72ad06b・c3673fba）。
//   今まで作業員5 の7つの欄・潜在の4欄は夜の読み（オフライン・竹内さんの過去の番）だけで、本番の meta には無かった＝設計図の訴求・押さえ方・信頼の作り方・潜在の具体が空。
//   ここはブレインの「今回の発言」の出力に2つの欄を足すだけ（形と読み取りは作業員5 の takeuchi-seven-read の SevenRead・LatentFour と同じ＝文の統括の受け口がそのまま読む）。
//   判断（道・AIX）は変えない: 欄は文の側の材料。出させるのは BRAIN_SEVEN_FIELDS=on の時だけ（既定 off）。
//   費用の見込み: 出力が1番 約150〜250トークン（Sonnet 5.5 の出力 $10/100万）＝1番 約 $0.0015〜0.0025・指示文はキャッシュの前置きの外（今回の発言の層の指定）
// テスト: npx tsx app/lib/__tests__/brain-seven-fields.test.ts
import { parseSevenRead, parseLatentFour, POINT_METHODS, TRUST_METHODS, type SevenRead, type LatentFour } from "./takeuchi-seven-read";

type Env = Record<string, string | undefined>;
export function brainSevenOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.BRAIN_SEVEN_FIELDS ?? "").trim().toLowerCase() === "on";
}

export const BRAIN_SEVEN_FIELD = `"seven_read"（返信の文の統括に渡す・この番で竹内さんならどう書くか。判断［道・AIX］は変えない・材料に無い事実は書かない）: {"point": {"what": "お客様の一通のどの部分（どの物件のどの点・どの問い）を一番押さえるか 40字", "how": "どう押さえるか 30字", "skipped": "後に回す所・答えない所 か null"}, "bridge": {"what": "次の一歩につなげるために細かく書く所 40字", "how": "どうつなぐか 30字"} か null, "lead": "viewing|apply|estimate|ask_send|keep|answer_only|none", "appeal": {"property": "物件名と号室 か null", "point": "推す点（家賃・広さ・駅・新しさ・設備・初期費用・空き の具体）", "how": "どう推すか"} か null（推さない番は null）, "latent": {"what": "この物件・この時期・この人の事情で具体に何が気になっているか（種類で止めない）40字", "fact": "先回りに使う事実（会話・資料・会社の事実にある物だけ）", "how": "どう先回りするか"} か null, "point_how": [${POINT_METHODS.join("|")} から], "trust_how": [${TRUST_METHODS.join("|")} から], "push": {"push": true/false, "strength": "strong|mid|weak|null", "reason": "押す・待つ理由（刺さり・時期・物件の残り・お客様の言葉）"}}`;
export const BRAIN_LATENT_FIELD = `"latent_read"（お客様の潜在を4つに分けて読む・読めない番は {"none": true}）: {"trigger": {"kind": "customer_words|scene|prev_send|property_fact", "text": "きっかけの言葉・事実 30字"}, "part": {"property": "物件名と号室 か null", "point": "何の部分（初期費用・空き・入居日・審査・広さ・立地・内覧の日 等）"}, "feeling": {"what": "どんな気持ちか具体に 40字", "strength": "strong|mid|weak"}, "want": "本当はどうしたいか 40字", "fact": "先回りに使える事実 か null"}`;

/** ブレインの「今回の発言」の出力に足す項目（off なら空文字） */
export function brainSevenOutputItem(env?: Env): string {
  return brainSevenOn(env) ? `、${BRAIN_SEVEN_FIELD}、${BRAIN_LATENT_FIELD}` : "";
}

/** 生の欄 → 型（作業員5 の読み取りをそのまま使う・壊れていれば null） */
export function normalizeBrainSeven(raw: unknown): SevenRead | null {
  if (!raw || typeof raw !== "object") return null;
  try { return parseSevenRead(JSON.stringify(raw)); } catch { return null; }
}
export function normalizeBrainLatent(raw: unknown): LatentFour | null {
  if (!raw || typeof raw !== "object") return null;
  try { return parseLatentFour(JSON.stringify(raw)); } catch { return null; }
}
