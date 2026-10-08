// app/lib/example-pii-guard.ts
// 手本（ai_reply_examples）・ナレッジ（ai_reply_knowledge）など「他のお客様の会話から作った材料」に、
// 申込の書類（記入済みの申込フォーム）・本人確認書類・収入の書類の書き起こし・個人の値（携帯・生年月日・メール・現住所）が
// 入っていないかを見て、外す／伏せる純関数（DB・env に依存しない）。
//
// 2026-10-08 事故（YUMA のテスト中に見つかった）: 手本 9bbf9b90（entry_source=aix_template・物件オススメ）の customer_message に
//   別のお客様の記入済み申込フォーム（氏名・フリガナ・生年月日 等）がそのまま入っていて、「子ども不可ですか？」の手本に選ばれた。
//   テストは歯止め（test-pii-guard）で止まったが、本番は手本の customer_message を素のまま Claude（と回す設定なら DeepSeek）に渡す。
//   入口: analyze-aix-templates が「送信直前のお客様の発言3件」を customer_message にそのまま入れていた（申込フォームの通も入る）。
//   決まり: 申込の書類・身分証・収入の書類の個人情報は LLM に渡さない（memory/test_protocol_brain.md・申込以降は別ツール）。
//
// 使い所（3か所で同じ判定＝三者同名）:
//   ① 入れる時（手本・ナレッジを作る経路）: sanitizeExampleText で伏せてから保存する
//   ② LLM へ送る直前（fetch の出口・llm-request-sanitize）: redactExampleSpansInPrompt で手本の「お客様: 「…」」だけを伏せる
//   ③ 監査（scripts/audit-example-pii.ts）: examplePiiReason で数える
//
// 誤検知の線（何を当てないか）:
//   ・空の申込フォーマット（スタッフが送る記入欄・項目名だけ）は当てない＝値（携帯・生年月日の値・年収の値）か「項目に値が書かれた行」2行以上の時だけ
//   ・「本人確認書類（運転免許証・マイナンバーカード）の裏表写真」のような依頼文は当てない（id-document-guard の指紋は書き起こしの形だけ）
//   ・会社・管理会社の固定電話（06-）は当てない（携帯 070/080/090 だけ）
//   ・入居希望日（2026年11月1日）は生年月日にしない（2010年以前・昭和／平成の値だけ）
//   ・物件の住所（住所：大阪市…）は当てない（現住所・登記住所・旧住所・前住所のラベルの時だけ）

import { isIdDocument } from "./id-document-guard";
import { classifyPersonalDocument } from "./personal-document-guard";
import { isApplicationPayload, filledFormLineCount, APPLICATION_FORM_PLACEHOLDER } from "./pii-pseudonym";
import { MOBILE_RE, EMAIL_RE, APPLICATION_FORM_RE, INCOME_VALUE_RE } from "./test-pii-guard";

export { APPLICATION_FORM_PLACEHOLDER };
/** 書類（本人確認・収入・身元）の書き起こしの代わりに残す文字列 */
export const PERSONAL_DOCUMENT_PLACEHOLDER = "[お客様が個人の書類を送信（個人情報のため非表示）]";

/** 現住所などお客様の住所のラベル＋値（物件の「住所：」は当てない）。値に 〒 か番地の数字がある時だけ */
const HOME_ADDRESS_RE = /(現住所|登記住所|旧住所|前住所)[^\n]{0,8}?[:：　 ]\s*[^\n]{0,30}?(?:〒\s*\d|\d{1,4}\s*[-‐－ー丁]\s*\d)/;
/** 郵便番号の値（〒530-0001） */
const POSTAL_VALUE_RE = /〒\s*\d{3}\s*[-‐－ー]?\s*\d{4}/;
/** 生年月日になり得る値（年月日・点・斜線の形。1900〜2015年・昭和／平成）。申込フォームの形と組の時だけ使う（築年月に当たるため単独では使わない） */
const BIRTH_ANY_RE = /(?:19\d{2}|200\d|201[0-5])\s*[年.．/／]\s*\d{1,2}\s*[月.．/／]\s*\d{1,2}|(?:昭和|平成)\s*(?:\d{1,2}|元)\s*[年.．/／]\s*\d{1,2}\s*[月.．/／]/;
/** 生年月日のラベルの近くの値（申込フォームの外でも生年月日と言える形） */
const BIRTH_LABELED_RE = /(生年月日|生まれ|誕生日)[^\n]{0,12}?(?:\d{2,4}\s*[年.．/／]\s*\d{1,2}\s*[月.．/／]\s*\d{1,2}|(?:昭和|平成)\s*\d)/;
/** 申込フォーム・申込書の形（記入欄の見出し） */
const FORM_HEAD_RE = /【[^】\n]{0,12}申込[^】\n]{0,12}】|【[^】\n]{0,6}(?:緊急連絡先|連帯保証人|保証人)[^】\n]{0,6}】/;
/** 身分証の書き起こしにしか出ない語（スタッフの依頼文「運転免許証の裏表」には出ない） */
const ID_STRONG_RE = /マイナンバー総合フリーダイヤル|公安委員会|(?:臓器|脳死)提供[^\n]{0,30}(?:意思|心臓|眼球)|[資资]格確認書[^\n]{0,60}(?:被保険者|資格を喪失)|주민등록|このカードを拾得|拾得された方は/;

/** 郵便番号の裸の形（530-0001）。携帯・固定電話の途中には当てない */
const POSTAL_BARE_RE = /(?<![\d-‐－ー])\d{3}[-‐－ー]\d{4}(?![\d-‐－ー])/;
/** 値の種類の数（携帯・郵便番号・現住所・ラベル付きの生年月日・メール） */
function personalValueKinds(t: string): number {
  return [MOBILE_RE.test(t), POSTAL_VALUE_RE.test(t) || POSTAL_BARE_RE.test(t), HOME_ADDRESS_RE.test(t), BIRTH_LABELED_RE.test(t), EMAIL_RE.test(t)].filter(Boolean).length;
}

export type ExamplePiiKind = "id_document" | "personal_document" | "application_form" | "personal_value";
export type ExamplePiiHit = { kind: ExamplePiiKind; reason: string };

/** 個人の値（携帯・生年月日・メール・現住所・郵便番号・年収）があるか */
function hasPersonalValue(t: string): boolean {
  return MOBILE_RE.test(t) || BIRTH_ANY_RE.test(t) || EMAIL_RE.test(t) || HOME_ADDRESS_RE.test(t) || POSTAL_VALUE_RE.test(t) || INCOME_VALUE_RE.test(t);
}

/**
 * 他のお客様の材料（手本の発言・ナレッジの本文 等）に個人情報が入っているか。無ければ null。
 * 強い物から順に見る（身分証 → 収入・身元の書類 → 記入済みの申込フォーム → 個人の値）。
 * 「[画像] 本人確認書類」のような保存済みの見出しは中身が無い（既に伏せてある）ので当てない。
 * 空の申込フォーマット（スタッフが送る記入欄）は値が無いので当てない＝**書類・フォームの形と値の両方**がある時だけ。
 */
export function examplePiiReason(text: string | null | undefined): ExamplePiiHit | null {
  const t = String(text ?? "");
  if (!t.trim()) return null;
  const value = hasPersonalValue(t);
  if (ID_STRONG_RE.test(t)) return { kind: "id_document", reason: "本人確認書類" };
  if ((value || BIRTH_LABELED_RE.test(t)) && isIdDocument(null, t)) return { kind: "id_document", reason: "本人確認書類" };
  const doc = classifyPersonalDocument(t);
  if (doc === "申込書") return { kind: "application_form", reason: "記入済みの申込フォーム" };
  if (doc) return { kind: "personal_document", reason: `個人の書類（${doc}）` };
  const formShape = FORM_HEAD_RE.test(t) || APPLICATION_FORM_RE.test(t) || (isApplicationPayload(t) && filledFormLineCount(t) >= 2);
  if (formShape && value) return { kind: "application_form", reason: "記入済みの申込フォーム" };
  // 連絡先の記入（携帯＋郵便番号・現住所・生年月日・メールのうち2種類以上）＝フォームの見出しが無くても申込・身元の記入として丸ごと伏せる（カナの氏名が値だけ伏せでは残るため）
  if (personalValueKinds(t) >= 2) return { kind: "application_form", reason: "連絡先の記入（2種類以上の値）" };
  // 申込の情報を管理会社・保証会社へ回す文（年収の値＋勤務先・勤続・〒・生年月日 等）。「年収300万以上が目安」のような説明文は組の語が無いので当てない
  if (INCOME_VALUE_RE.test(t) && /勤務先|勤続|勤め先|生年月日|フリガナ|〒\s*\d/.test(t)) return { kind: "application_form", reason: "申込の情報（年収・勤務先）" };
  if (MOBILE_RE.test(t)) return { kind: "personal_value", reason: "携帯電話の番号" };
  if (BIRTH_LABELED_RE.test(t)) return { kind: "personal_value", reason: "生年月日の値" };
  if (HOME_ADDRESS_RE.test(t)) return { kind: "personal_value", reason: "現住所の値" };
  if (EMAIL_RE.test(t)) return { kind: "personal_value", reason: "メールアドレス" };
  return null;
}

const g = (re: RegExp) => new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
const MOBILE_G = g(MOBILE_RE);
const BIRTH_G = g(BIRTH_ANY_RE);
const POSTAL_G = g(POSTAL_VALUE_RE);
const EMAIL_G = g(EMAIL_RE);
const HOME_ADDRESS_LINE_G = /(現住所|登記住所|旧住所|前住所)(\s*[:：]?\s*)[^\n]+/g;

/** 個人の値だけを伏せる（文の他の部分は残す） */
export function maskPersonalValues(text: string): string {
  return text
    .replace(MOBILE_G, "〇〇〇-〇〇〇〇-〇〇〇〇")
    .replace(BIRTH_G, "〇〇年〇月〇日")
    .replace(POSTAL_G, "〒〇〇〇-〇〇〇〇")
    .replace(EMAIL_G, "〇〇@〇〇")
    .replace(HOME_ADDRESS_LINE_G, (_m, label: string, sep: string) => `${label}${sep}〇〇`);
}

/** こちら（スタッフ）の文に入った申込の情報（管理会社・保証会社へ回した記入内容 等）の代わりに残す文字列 */
export const STAFF_PII_PLACEHOLDER = "[申込の情報（個人情報のため非表示）]";
/** どちらの発言か（伏せ字の言い方を変える。お客様の発言を「お客様が記入して送信」、こちらの文は「申込の情報」） */
export type ExampleSide = "customer" | "staff";

/**
 * 手本・ナレッジに入れる文を安全にする。
 * ・書類・記入済みの申込フォーム → 発言の塊ごと伏せ字に置き換える。ただし analyze-aix-templates が後ろに足す
 *   こちら側の文脈（〔直前のAIX送信〕〔AIX-META〕〔Brainテンプレヒント〕など「〔」で始まる行）は残す
 * ・個人の値だけ → 値だけ伏せる
 * 返り値の changed=false なら元の文そのまま。
 */
export function sanitizeExampleText(text: string | null | undefined, side: ExampleSide = "customer"): { text: string; changed: boolean; hit: ExamplePiiHit | null } {
  const t = String(text ?? "");
  const hit = examplePiiReason(t);
  if (!hit) return { text: t, changed: false, hit: null };
  if (hit.kind === "personal_value") {
    const masked = maskPersonalValues(t);
    return { text: masked, changed: masked !== t, hit };
  }
  const lines = t.split("\n");
  const ourContext = side === "customer" ? lines.filter((l) => /^〔/.test(l.trim())) : [];
  const placeholder = side === "staff" ? STAFF_PII_PLACEHOLDER
    : hit.kind === "application_form" ? APPLICATION_FORM_PLACEHOLDER : PERSONAL_DOCUMENT_PLACEHOLDER;
  // こちら側の文脈の行にも値が混ざり得る（AIX の本文に申込フォームを引用した等）。値のある行・フォームの見出しの行から後ろは落とす
  const kept: string[] = [];
  for (const l of ourContext) {
    if (examplePiiReason(l) || FORM_HEAD_RE.test(l)) break;
    kept.push(l);
  }
  const out = [placeholder, ...kept].join("\n");
  return { text: out, changed: out !== t, hit };
}

/**
 * LLM へ送る本文（プロンプトの文字列）の中の「手本の発言」だけを伏せる（fetch の出口用）。
 * 対象の形（手本を並べる全経路の書き方）:
 *   お客様: 「…」\nスモラ: 「…」   … generate-reply・aix-template-generate・aix/action・enhance-reply・generate-reply-patterns
 *   [お客様の状況] 「…」             … aix-template-generate の統合手本
 *   - [成約] (applying段階) 「…」     … brain-core の成約した会話の返信例（他のお客様のスタッフの文）
 * 今の会話の履歴（「お客様: 本文」のように鉤括弧が無い形）・ルール・ブレインの判断には触らない
 * （今の会話の申込フォームは申込以降の歯止め・保証会社の読み取り等の別の決まりで扱う）。
 */
const EXAMPLE_TURN_RE = /(お客様:\s?「)([\s\S]{0,4000}?)(」\s*\n\s*スモラ:\s?「)/g;
const EXAMPLE_SITUATION_RE = /(\[お客様の状況\]\s?「)([\s\S]{0,4000}?)(」)/g;
/** ブレインの「成約した会話の実際の返信例」（brain-core: `- [成約] (applying段階) 「…」`・改行は空白に潰してある1行） */
const EXAMPLE_BRAIN_RE = /^(- \[[^\]\n]{0,30}\] \([^)\n]{0,40}段階\) 「)([^\n]{0,1200})(」)$/gm;
/** こちらの発言（手本の「スモラ: 「…」」）。閉じ括弧の後が空行・次の例・終わりの所まで（本文の中の「物件名」の 」で切らない） */
const EXAMPLE_STAFF_RE = /(スモラ:\s?「)([\s\S]{0,4000}?)(」)(?=[ \t]*(?:\n[ \t]*\n|\n\[例|\n【|$))/g;

export function redactExampleSpansInPrompt(text: string): { text: string; redacted: number } {
  let redacted = 0;
  const fixWith = (side: ExampleSide) => (_m: string, head: string, body: string, tail: string) => {
    const s = sanitizeExampleText(body, side);
    if (!s.changed) return `${head}${body}${tail}`;
    redacted++;
    return `${head}${s.text}${tail}`;
  };
  const out = text
    .replace(EXAMPLE_TURN_RE, fixWith("customer"))
    .replace(EXAMPLE_SITUATION_RE, fixWith("customer"))
    .replace(EXAMPLE_STAFF_RE, fixWith("staff"))
    .replace(EXAMPLE_BRAIN_RE, fixWith("staff"));
  return { text: redacted ? out : text, redacted };
}

/** 出口の速い判定: 本文（JSON の文字列のまま）に手本の形と個人情報の手掛かりの両方が無ければ何もしない */
const QUICK_EXAMPLE_RE = /お客様:\s?「|スモラ:\s?「|\[お客様の状況\]|段階\) 「/;
const QUICK_PII_RE = /生年月日|フリガナ|氏名|現住所|緊急連絡先|勤務先|年収|0[789]0[-‐－ー\s]?\d{4}|公安委員会|@[A-Za-z0-9-]+\.|(?:19\d{2}|200\d|201\d)\s*[年.／/]|昭和|平成|〒|臓器|脳死|資格確認書|주민등록|マイナンバー総合/;
export function mightHaveExamplePii(rawBody: string): boolean {
  return QUICK_EXAMPLE_RE.test(rawBody) && QUICK_PII_RE.test(rawBody);
}

/** 欄の名前からどちらの発言かを決める（customer_message／customerMessage はお客様・他はこちら） */
function sideOfField(key: string): ExampleSide {
  return /^customer[_]?message$/i.test(key) ? "customer" : "staff";
}

/**
 * 手本・ナレッジに入れる前の歯止め（入口）。渡した欄（customer_message・sent_reply・ai_draft 等）をそれぞれ sanitizeExampleText に通す。
 * 戻す: EXAMPLE_PII_SAVE_GUARD=off（入れる時だけ。出口の EXAMPLE_PII_GUARD とは別）
 * hits は「欄:理由」（ログ用・本文は入れない）
 */
export function sanitizeExampleFields<T extends Record<string, string | null | undefined>>(
  fields: T,
  env: Record<string, string | undefined>,
): { fields: T; hits: string[] } {
  if ((env.EXAMPLE_PII_SAVE_GUARD ?? "").trim().toLowerCase() === "off") return { fields, hits: [] };
  const out: Record<string, string | null | undefined> = { ...fields };
  const hits: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v !== "string" || !v) continue;
    const s = sanitizeExampleText(v, sideOfField(k));
    if (s.changed) { out[k] = s.text; hits.push(`${k}:${s.hit?.reason ?? "?"}`); }
  }
  return { fields: out as T, hits };
}
