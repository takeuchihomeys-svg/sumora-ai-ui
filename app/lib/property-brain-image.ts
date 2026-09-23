// app/lib/property-brain-image.ts
// 物件検索ブレインの「画像でしか分からない有無」だけを DeepSeek（vision-alt-provider と同じ型・reasoning low）で読む。
//
// 2026-09-23 竹内「間取りを読み取ってお客さん希望の条件に近いか…画像からそうすれば何が良い物件なのか分かる」
//
// ■ 線引き（設計知見の既知の制約）
//   - OCR は数値を誤読する → 家賃・AD・敷礼・徒歩は**表の文字が正**。画像からは **有無・可否だけ**（バストイレ別・独立洗面・収納・南向き・階）。
//   - 別クラウドに出してよいのは**物件資料だけ**（お客様の画像・本人確認書類は出さない）。ここは検索結果の間取り図しか受けない。
//   - 推論モデルは「答えが0文字」で失敗するので、成否は取れた項目で見る。失敗は null（判定を止めない・落とさない）。
//   - 無条件には読まない: お客様の希望に画像でしか分からない語がある時だけ、1バッチ5枚まで。

import { callVisionAlt, VISION_ALT_MODEL_DEFAULT } from "./vision-alt-provider";
import type { ImageFacts, ImageWantKey } from "./property-brain";

export const PROPERTY_BRAIN_IMAGE_MAX_PER_BATCH = 5;
export const PROPERTY_BRAIN_IMAGE_TIMEOUT_MS = 8_000;
/** 推論を含むので余裕を持つ（答えは JSON 1行） */
export const PROPERTY_BRAIN_IMAGE_MAX_TOKENS = 1_500;

const KEY_QUESTIONS: Record<ImageWantKey, string> = {
  bath_toilet_separate: "bath_toilet_separate: 浴室とトイレが別々の部屋か（ユニットバスなら false）",
  separate_washstand: "separate_washstand: 独立した洗面台（洗面所）があるか",
  storage: "storage: 収納（クローゼット・押入・WIC）があるか",
  south_facing: "south_facing: 方位記号や記載から南向きと分かるか（分からなければ null）",
  floor_2_plus: "floor_2_plus: 部屋が2階以上と分かるか（1階なら false・分からなければ null）",
};

/** system は固定（DeepSeek の自動前置きキャッシュが効く）。お客様の情報は入れない */
export const PROPERTY_BRAIN_IMAGE_SYSTEM =
  "あなたは賃貸物件の間取り図・物件資料を読む係です。画像から分かる「有無」だけを JSON で返してください。" +
  "数値（家賃・面積・徒歩分数）は読まないでください。判断できない項目は null にしてください。" +
  "出力は JSON オブジェクト1つだけ（説明文なし）。キーは指示された物だけ、値は true / false / null。";

export function buildImageQuestion(keys: ImageWantKey[]): string {
  return `次の項目を画像から判断して JSON で返してください:\n${keys.map((k) => "- " + KEY_QUESTIONS[k]).join("\n")}`;
}

/** 応答から JSON を取り出す（前後に文が付いても・失敗なら null） */
export function parseImageFacts(text: string | null | undefined, keys: ImageWantKey[]): ImageFacts | null {
  const s = String(text ?? "");
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
  const out: ImageFacts = {};
  let got = 0;
  for (const k of keys) {
    const v = obj[k];
    if (v === true || v === false) { out[k] = v; got++; }
    else out[k] = null;
  }
  return got > 0 ? out : null;   // 1項目も取れなければ失敗扱い（成否は取れた項目で見る）
}

export type ImageReadResult = { facts: ImageFacts | null; ms: number; model: string; usage?: { input: number; output: number; cacheHit: number } };

/**
 * 1枚読む。失敗は facts=null（呼び出し側は判定を変えない）。
 * 費用は llm_usage_logs に action="property_brain_image" で残す（recordAltUsage・記録の失敗で本処理を止めない）。
 */
export async function readFloorPlanFacts(imageUrl: string, keys: ImageWantKey[], opts?: { timeoutMs?: number }): Promise<ImageReadResult> {
  const startedAt = Date.now();
  const model = (process.env.VISION_ALT_MODEL ?? VISION_ALT_MODEL_DEFAULT).trim();
  if (!/^https?:\/\//.test(imageUrl) || keys.length === 0) return { facts: null, ms: 0, model };
  const content = [
    { type: "text", text: buildImageQuestion(keys) },
    { type: "image", source: { type: "url", url: imageUrl } },
  ];
  const res = await callVisionAlt(PROPERTY_BRAIN_IMAGE_SYSTEM, content, {
    maxTokens: PROPERTY_BRAIN_IMAGE_MAX_TOKENS,
    timeoutMs: opts?.timeoutMs ?? PROPERTY_BRAIN_IMAGE_TIMEOUT_MS,
    effort: "low",
  });
  const ms = Date.now() - startedAt;
  const facts = res ? parseImageFacts(res.text, keys) : null;
  void import("./llm-usage-recorder").then(({ recordAltUsage }) => {
    recordAltUsage({
      model: res?.model ?? model, action: "property_brain_image", conversationId: null,
      usage: { input_tokens: res?.usage.cacheMiss ?? 0, output_tokens: res?.usage.output ?? 0, cache_read_input_tokens: res?.usage.cacheHit ?? 0 },
      status: res ? 200 : 0, errorType: res ? (facts ? null : "empty_or_unparsable") : "no_response",
      durationMs: ms, sysHead: PROPERTY_BRAIN_IMAGE_SYSTEM.slice(0, 200), sysKeyFull: null, maxTokens: PROPERTY_BRAIN_IMAGE_MAX_TOKENS,
    });
  }).catch(() => {});
  return { facts, ms, model: res?.model ?? model, usage: res?.usage };
}
