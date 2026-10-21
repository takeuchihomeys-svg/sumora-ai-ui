// app/lib/alt-pii-gate.ts
// DeepSeek（別クラウド）に回す直前の共通の門: 送る本文に個人を特定する「値」があれば Claude に戻す（純関数）。
//
// 2026-10-15 竹内「核となるブレインはアンソロピック（Claude）に。核じゃない所を DeepSeek にする。個人情報は渡さないのを徹底」:
//   今までの守り（llm-alt-provider の出口）は「申込以降の印」「時刻の線の印（会話の呼び出し）」「線より前の発言の網（cut の時だけ）」と、
//   入口ごとの名前・番号の伏せ（maskPII）で、本文そのものに個人の値が残っていないかを見る網は**テストの間だけ**（test-pii-guard.testPiiRefusal）だった。
//   → 本番でも、回すと決まった呼び出しの本文に値が残っていれば Claude に戻す（入口の伏せ漏れの最後の歯止め・fail-closed）。
//
// 【見るのは「値」だけ】本文には指示文（「本人確認書類（運転免許証・パスポート）…」「生年月日」等の語）が入るので、語では止めない（止めると全部が Claude に戻る）。
//   ・携帯電話の番号（070/080/090）・メールアドレス・記入済みの申込フォーム … test-pii-guard と同じ形（実データ YUMA 504通で当たり 0）
//   ・生年月日は**欄の名前と組**の時だけ（「生年月日 1995年…」）。test-pii-guard の「平成27年3月」は物件の築年月と同じ形なので本番の門では使わない
//   ・個人番号・免許証番号（欄の名前と組）・口座番号の値。欄の無い12桁の番号は見ない（レインズの物件番号・SUUMO の jnc_ と同じ形）
//   住所は物件の所在地と同じ形なので値では見ない（申込フォームの欄・郵便番号の伏せ＝maskPII の側で守る）。
// 止める: LLM_ALT_PII_GATE=off（既定 on）

import { MOBILE_RE, EMAIL_RE, APPLICATION_FORM_RE, INCOME_VALUE_RE } from "./test-pii-guard";
import { isIdDocument } from "./id-document-guard";
import { classifyPersonalDocument } from "./personal-document-guard";

const URL_RE = /https?:\/\/[^\s"'<>）)]+/g;
/** 生年月日の欄と値の組（「生年月日：1995年3月12日」「生年月日 平成7年」「生年月日 1995/03/12」） */
export const LABELED_BIRTH_RE = /生年月日\s*[:：]?\s*(?:(?:19|20)\d{2}\s*[年/.\-]|(?:昭和|平成|令和)\s*(?:\d{1,2}|元)\s*年)/;
/** 申込フォームの生年月日の値（年月日の漢字つき・2010年以前） */
const BIRTH_FULL_RE = /(?:19\d{2}|200\d)\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/;
/** 個人番号・免許証番号の欄と値 */
export const LABELED_ID_RE = /(?:マイナンバー|個人番号|免許証番号|運転免許証番号|保険証番号|在留カード番号)\s*[:：は]?\s*[0-9０-９]/;
/** 口座番号の値 */
export const BANK_ACCOUNT_RE = /口座番号\s*[:：は]?\s*[0-9０-９]{6,8}/;

/** 送る本文に個人を特定する値があれば理由（日本語）・無ければ null */
export function altPiiSignal(text: string | null | undefined): string | null {
  const raw = String(text ?? "");
  if (!raw) return null;
  const t = raw.replace(URL_RE, " ");
  if (APPLICATION_FORM_RE.test(t) && (MOBILE_RE.test(t) || BIRTH_FULL_RE.test(t) || LABELED_BIRTH_RE.test(t) || INCOME_VALUE_RE.test(t))) return "記入済みの申込フォーム";
  if (MOBILE_RE.test(t)) return "携帯電話の番号";
  if (EMAIL_RE.test(t)) return "メールアドレス";
  if (LABELED_BIRTH_RE.test(t)) return "生年月日の値";
  if (LABELED_ID_RE.test(t)) return "個人番号・免許証番号";
  if (BANK_ACCOUNT_RE.test(t)) return "口座番号";
  return null;
}

/** 門を使うか（既定 on・LLM_ALT_PII_GATE=off で止める） */
export function altPiiGateEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.LLM_ALT_PII_GATE ?? "on").trim().toLowerCase() !== "off";
}

// ═══ 申込から戻ったお客様（線のある呼び出し＝cut）の強めの網 ═══════════════════════════════════════
// 2026-10-21 竹内さんの決定（023ec7bd）「申込中の会話などマスキングちゃんとおこなえば DeepSeek にわたして生成しても良い…申込中のマスキングの部分のしくみ徹底」:
//   線（deepseek_cutoff_at・戻しの印）より後だけを渡すが、線の後に申込情報の名残（記入済みの値・書類の読み取り・伏せた跡）が残っていれば
//   DeepSeek に出さない（Claude のまま）。入口の伏せ（pii-pseudonym・maskPII）が置いた跡（仮名の生年月日・勤務先・申込フォームの伏せ字）も当てる
//   ＝申込情報が1つでも絡む呼び出しは Claude（伏せ方に頼らない）。見るのは messages の本文だけ（system＝指示文の語では止めない）。
//   止める LLM_ALT_REAPPLY_GATE=off（既定 on・LLM_ALT_PII_GATE=off なら一緒に止まる）

/** 生年月日らしい日付（2009年以前の年月日／和暦の年月日＋生）。築年月（「平成20年3月築」）は日が無いので当てない */
const BIRTH_DAY_RE = /(?:19\d{2}|200\d)\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|(?:昭和|平成)\s*(?:\d{1,2}|元)\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日\s*生/;
/** 勤務先の欄と値（コロンつき・伏せ字以外） */
const WORKPLACE_VALUE_RE = /(?:勤務先|勤め先|職場)\s*[:：]\s*(?![\[［(（]|〇〇|○○)[^\s\n、。]{2,}/;
/** 入口の伏せが置いた跡（申込フォームの伏せ字・仮名の勤務先・ラベルの値の伏せ字） */
const MASKED_APPLICATION_TRACE_RE = /申込フォームに記入して送信|（勤務先）|\[回答済み・非表示\]/;

/** 申込から戻った会話の呼び出し（cut）で、messages の本文に申込情報の名残があれば理由・無ければ null */
export function altPiiSignalReapply(text: string | null | undefined): string | null {
  const base = altPiiSignal(text);
  if (base) return base;
  const t = String(text ?? "").replace(URL_RE, " ");
  if (!t.trim()) return null;
  if (INCOME_VALUE_RE.test(t)) return "年収の値";
  if (BIRTH_DAY_RE.test(t)) return "生年月日らしい日付";
  if (WORKPLACE_VALUE_RE.test(t)) return "勤務先の値";
  if (MASKED_APPLICATION_TRACE_RE.test(t)) return "申込情報を伏せた跡";
  if (APPLICATION_FORM_RE.test(t)) return "申込フォームの欄";
  if (isIdDocument(null, t)) return "本人確認書類の読み取り";
  const doc = classifyPersonalDocument(t);
  if (doc) return `個人の書類の読み取り（${doc}）`;
  return null;
}

/**
 * 2026-10-21 確かめ役: 同じ呼び出しの system に当てる「値」だけの網。AIX は会話の材料（ブレインの判断・メモ・要約）を system の動的な塊に入れるので、
 *   messages だけでは見落とす。指示文の語（申込フォーム・本人確認書類）では止めない＝値（年収・生年月日らしい日付・勤務先の値・入口で伏せた跡）だけ。
 */
export function altPiiSignalReapplyValues(text: string | null | undefined): string | null {
  const t = String(text ?? "").replace(URL_RE, " ");
  if (!t.trim()) return null;
  if (INCOME_VALUE_RE.test(t)) return "年収の値";
  if (BIRTH_DAY_RE.test(t)) return "生年月日らしい日付";
  if (WORKPLACE_VALUE_RE.test(t)) return "勤務先の値";
  if (MASKED_APPLICATION_TRACE_RE.test(t)) return "申込情報を伏せた跡";
  return null;
}

/** 強めの網を使うか（既定 on） */
export function altReapplyGateEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return altPiiGateEnabled(env) && (env.LLM_ALT_REAPPLY_GATE ?? "on").trim().toLowerCase() !== "off";
}

// ═══ 網に当たったら Claude に戻す前に、まず値を伏せて渡す（2026-10-21 竹内さんの決定 414dc9d4）═══════════════════════
// 「申込中のところのお客さんの情報マスキングすればちゃんと DeepSeek に渡せるようになるのでは」:
//   線のある呼び出し（cut＝申込から戻った会話）と印 masked（2番手で申込中・並行で探す）は、年収・生年月日・勤務先・書類の読み取り・申込フォームの欄の値を
//   伏せ字に置き換えてから DeepSeek へ。置き換えた後にもう一度値の網を当て、まだ値が残る時だけ Claude に戻す。
//   見るのは「値」だけ（欄の見出し・入口が置いた伏せ字の跡・指示文の語では戻さない＝伏せ字は値ではない）。審査の事情（screening-sensitive）は今まで通り Claude。
//   止める REAPPLY_MASK_INSTEAD=off（旧＝網に当たれば Claude）
export const ALT_MASK = "［伏せ字］";
export const ALT_DOC_MASK = "[画像] 書類（読み取りは伏せ字）";

export function maskInsteadEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.REAPPLY_MASK_INSTEAD ?? "").trim().toLowerCase() !== "off";
}

/** 値を伏せる欄（申込フォームの個人の欄だけ。住所・名前・年齢・電話は物件の文や入口の伏せと重なるので見出しでは伏せない＝番号・メールは値の形で伏せる） */
const SENSITIVE_LABELS = "氏名|フリガナ|ふりがな|生年月日|年収|月収|収入|給与|勤務先|勤め先|会社名|職場|勤続年数|雇用形態|連帯保証人|保証人|緊急連絡先|続柄|現住所|代表者|代表者名|契約者|契約者名|申込者名|入居者名|法人名";
/** 見出し＋コロン＋値 */
const LABEL_COLON_G = new RegExp(`((?<!管理|仲介|保証|不動産|物件)(?:${SENSITIVE_LABELS})[^\\n:：]{0,6}?\\s*[:：]\\s*)(?![［\\[]|〇〇|○○)([^\\n、。｜|】\\]]+)`, "g");
/** 見出し＋空白＋値（申込フォームの実物はコロンが無い形がある・pii-mask の APP_LABEL_SPACE_REGEX と同じ考え） */
const LABEL_SPACE_G = new RegExp(`((?<!管理|仲介|保証|不動産|物件)(?:${SENSITIVE_LABELS})(?:[、,][^\\n：:\\s　]{0,8})?[ 　]+)(?![（(［\\[]|〇〇|○○)([^\\s、。｜|】\\]\\n][^\\n、。｜|】\\]]*)`, "g");
const INCOME_G = /年収\s*[:：は]?\s*(?:約)?\s*[\d,，０-９]{2,}\s*(?:万|円)(?:円)?/g;
const LABELED_BIRTH_G = /(生年月日\s*[:：]?\s*)((?:19|20)\d{2}\s*[年/.\-]\s*\d{1,2}(?:\s*[月/.\-]\s*\d{1,2}\s*日?)?|(?:昭和|平成|令和)\s*(?:\d{1,2}|元)\s*年(?:\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?)?)/g;
const BIRTH_DAY_G = /(?:19\d{2}|200\d)\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日(?:\s*生(?:まれ)?)?|(?:昭和|平成)\s*(?:\d{1,2}|元)\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日\s*生(?:まれ)?/g;
const WORKPLACE_G = /((?:勤務先|勤め先|職場)\s*[:：]\s*)(?![\[［(（]|〇〇|○○)[^\s\n、。]{2,}/g;
const MOBILE_G = /0[789]0[-‐－ー\s]?\d{4}[-‐－ー\s]?\d{4}/g;
const EMAIL_G = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z.]{2,}/g;
const LABELED_ID_G = /((?:マイナンバー|個人番号|免許証番号|運転免許証番号|保険証番号|在留カード番号)\s*[:：は]?\s*)[0-9０-９][0-9０-９\s\-]*/g;
const BANK_ACCOUNT_G = /(口座番号\s*[:：は]?\s*)[0-9０-９]{6,8}/g;
/** 会話の1通の頭らしい行（申込フォーム・書類の読み取りの区切り）。「お客様: 」「スモラ: 」「[顧客 10/12]」「10/12(土) お客様」等 */
const MSG_HEAD_RE = /^\s*(?:\[?\s*(?:顧客|スタッフ|お客様|スモラ|AIX|担当|管理会社)(?:\(AIX\)|（AIX）)?\s*(?:[:：\]]|\s\d)|【(?:顧客|お客様|スモラ|スタッフ)】|\[?\d{1,2}\/\d{1,2}(?:\s|\(|（|\])|\d{1,2}月\d{1,2}日\s*[（(]?[日月火水木金土]?[）)]?\s*(?:お客様|スモラ|顧客|スタッフ))/;
const IMAGE_MARK_RE = /\[画像\]|\[ファイル\]/;
/** 書類の読み取りと分かる強い指紋（[画像] が無い行にも当てる） */
const STRONG_DOC_RE = /公安委員会|マイナンバー総合フリーダイヤル|(?:臓器|脳死)提供.{0,10}(?:意思|心臓|眼球)|[資资]格確認書.{0,20}被保険者|주민등록/;

function isDocBlock(block: string): boolean {
  return (IMAGE_MARK_RE.test(block) || STRONG_DOC_RE.test(block)) && (isIdDocument(null, block) || classifyPersonalDocument(block) !== null);
}
/** 書類の読み取りの束（画像の行から、空行・次の1通の頭・次の画像まで。最大 maxLines 行） */
function regionEnd(lines: string[], start: number, maxLines: number): number {
  let j = start + 1;
  while (j < lines.length && j - start < maxLines) {
    const l = lines[j];
    if (!l.trim() || MSG_HEAD_RE.test(l) || IMAGE_MARK_RE.test(l)) break;
    j++;
  }
  return j;
}

// ─── 申込フォームの束 ───
// 実物（10/21 の確かめ）: 入口の伏せ（maskPII）で見出しの「申込者様記入欄」が「おお客様記入欄」に変わり APPLICATION_FORM_RE に当たらない／
//   欄の名前の次の行に値を書く・欄の名前を書かずに「・値」だけ並べる形があり、欄の名前と値の組だけでは名前・住所・勤務先名が残った。
//   → 束（見出し「〜記入欄／入力欄」か、欄の名前の行が近くに3つ以上）を見つけ、次の1通の頭まで（空行をまたぐ）の行を、見出しと欄の名前だけの行を残して全部伏せる。
/** 束の見出し（入口の伏せの後の形も） */
const FORM_HEADING_RE = /記入欄|入力欄|ご記入|ご入力|緊急連絡先欄|お仕事情報|仕事内容|勤務先情報|お勤め先情報|在籍確認の?情報/;
/** 欄の名前（行の頭） */
const FORM_FIELD_WORDS = "氏名|お名前|名前|フリガナ|ふりがな|生年月日|現住所|住所|住居年数|住居形態|携帯番号|携帯|電話番号|メールアドレス|メール|配偶者|勤務先名|勤務先所在地|勤務先電話番号|勤務先|勤め先|会社名|勤続年数|年収|月収|雇用形態|業種|職種|役職|健康保険|保険証|続柄|入居希望日|入居人数|同居人|緊急連絡先|連帯保証人|保証人|性別|年齢|ペット|駐車場|自動車|車|国籍|学校名|学年|代表者名|代表者|契約者名|契約者|法人名|資本金|設立|従業員数";
const FORM_FIELD_LINE_RE = new RegExp(`^\\s*[・･\\-*＊●○◆■□◎]?\\s*(?:${FORM_FIELD_WORDS})`);
const FORM_FIELD_PREFIX_RE = new RegExp(`^(\\s*[・･\\-*＊●○◆■□◎]?\\s*(?:${FORM_FIELD_WORDS})(?:[、,・／/]\\s*(?:${FORM_FIELD_WORDS}))*(?:名|欄)?\\s*[:：]?)`);
const FORM_FIELD_WORDS_G = new RegExp(`${FORM_FIELD_WORDS}|記入欄|入力欄|欄|様|本人|必須|任意|有無|（[^）]{0,10}含め）|\\([^)]{0,10}含め\\)`, "g");
/** 伏せ字・入口の伏せの跡だけ（値ではない） */
const PLACEHOLDERS_G = /［伏せ字］|\[回答済み・非表示\]|\[電話番号非表示\]|\[メールアドレス非表示\]|\[郵便番号非表示\]|〇〇|○○/g;
const strip = (s: string) => s.replace(/[\s　・･、,，.。:：【】[\]［］()（）「」『』※＊*\-ー－~〜／/|｜〒◎●○◆■□]/g, "");
const placeholderOnly = (s: string) => strip(s.replace(PLACEHOLDERS_G, "")).length === 0;
/** 束の見出しの語（「【おお客様記入欄】」「【代理契約 お客様ご入力欄】」「【同居人記入欄】（お客様含め）」） */
const FORM_HEADING_WORDS_G = /お?お?客様|代理契約|申込者様?|同居人|緊急連絡先|連帯保証人様?|ご?記入|ご?入力|欄|（[^）]{0,12}）|\([^)]{0,12}\)/g;

/** 見出しだけ・欄の名前だけの行か（値が1字も無い） */
function isFormLabelOnly(line: string): boolean {
  return strip(line.replace(FORM_FIELD_WORDS_G, "")).length === 0;
}
/** 束の1行を伏せる（見出し・欄の名前だけの行は残す／欄の名前＋値は名前を残して値を伏せる／それ以外は行ごと） */
function maskFormLine(line: string): string {
  if (!line.trim() || isFormLabelOnly(line) || placeholderOnly(line)) return line;
  if (FORM_HEADING_RE.test(line) && strip(line.replace(FORM_HEADING_WORDS_G, "").replace(FORM_FIELD_WORDS_G, "")).length === 0) return line;
  const m = line.match(FORM_FIELD_PREFIX_RE);
  if (m) {
    const rest = line.slice(m[1].length);
    return placeholderOnly(rest) ? line : `${m[1]} ${ALT_MASK}`;
  }
  return ALT_MASK;
}
/** 束の始まりか（見出し、または欄の名前の行で、そこから15行に欄の名前の行が3つ以上） */
//   fieldStart=false（system＝指示文）は見出しの時だけ（指示文の箇条書き「・住所は…」「・年収は…」を束にしない）
//   headingOk=false（system の指示文の所＝会話の1通の外）は見出しでも束にしない（指示文の「仕事内容を聞く」等の後ろを伏せない）
function isFormStart(lines: string[], i: number, fieldStart = true, headingOk = true): boolean {
  const l = lines[i];
  if (FORM_HEADING_RE.test(l) || APPLICATION_FORM_RE.test(l)) return headingOk;
  if (!fieldStart || !FORM_FIELD_LINE_RE.test(l)) return false;
  let n = 0;
  for (let k = i; k < Math.min(lines.length, i + 15); k++) { if (k > i && MSG_HEAD_RE.test(lines[k])) break; if (FORM_FIELD_LINE_RE.test(lines[k])) n++; }
  return n >= 3;
}
/** 束の終わり（次の1通の頭まで・空行はまたぐ・最大150行） */
function formEnd(lines: string[], start: number): number {
  let j = start + 1;
  while (j < lines.length && j - start < 150 && !MSG_HEAD_RE.test(lines[j])) j++;
  return j;
}
/** 1通の頭の行にフォームが続いて書かれている時（「お客様: 【お客様記入欄】」）は頭を残して中身を束として扱う */
function splitHead(line: string): { head: string; body: string } {
  const m = line.match(/^(\s*(?:\[[^\]]{0,24}\]\s*)?(?:顧客|スタッフ|お客様|スモラ)(?:\(AIX\)|（AIX）)?\s*[:：]\s*)/);
  return m ? { head: m[1], body: line.slice(m[1].length) } : { head: "", body: line };
}

/**
 * 送る文から申込情報の値を伏せる（純関数・DeepSeek に回る出口だけで使う）。
 *   書類の読み取りの束 → ALT_DOC_MASK／申込フォームの束 → 見出しと欄の名前だけ残して行ごと伏せる／
 *   個人の欄の値・年収・生年月日・勤務先・携帯・メール・個人番号・口座 → 伏せ字
 */
//   opts.fieldStart: true（messages）＝欄の名前の行の並びでも束にする／"customer"（system＝指示文＋AIX の会話の材料）＝お客様の1通の中だけ／false＝見出しの時だけ
export type FieldStart = boolean | "customer";
const CUSTOMER_HEAD_RE = /^\s*(?:\[[^\]]{0,24}\]\s*)?(?:\[?\s*顧客|お客様)(?:\s*\d{1,2}\/\d{1,2}\])?\s*[:：\]\s]/;
function fieldStartAt(mode: FieldStart, inCustomer: boolean): boolean {
  return mode === true || (mode === "customer" && inCustomer);
}
const STAFF_HEAD_RE = /^\s*(?:\[[^\]]{0,24}\]\s*)?\[?\s*(?:スモラ|スタッフ|AIX|担当)/;

// ─── お客様の行だけの網（フォームの欄の名前を書かずに答えた値）───
// 10/21 の確かめ（scripts/audit-reapply-mask.ts の別の網）: 「1年一ヶ月。250万円程度です」「〇〇株式会社 400万」「〒… 大阪府…3-4-10 〇〇工業」のように、
//   欄の名前の無い答えで年収・勤務先・勤務先の住所が残った（旧の網でも素通りしていた形）。お客様の行（スタッフの1通でない行）だけで伏せる
//   （物件の文・管理会社名・指示文を壊さないため）。
/** 100万以上の金額（家賃・初期費用はこの桁にならない＝年収・貯金） */
const BIG_MONEY_G = /(?<![\d,，.０-９])[\d０-９]{3,4}\s*万(?:円)?/g;
/** 法人の名前（管理会社・仲介・保証会社・貸主の名前の後ろは除く） */
const CORP_G = /(?<!(?:管理会社|管理|仲介|貸主|オーナー|保証会社)\s*[:：は]?\s*)[^\s、。,，「」【】『』()（）:：]{0,20}(?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人|社団法人|財団法人|医療法人|社会福祉法人|学校法人|（株）|\(株\)|（有）|\(有\))[^\s、。,，「」【】『』()（）]{0,20}/g;
const KANA_CORP_G = /[ァ-ヶー]{0,30}(?:カブシキガイシャ|ユウゲンガイシャ|ゴウドウガイシャ|シャダンホウジン|ザイダンホウジン|フクシホウジン|イリョウホウジン|ガッコウホウジン)[ァ-ヶー]{0,30}/g;
/** 郵便番号の後ろの住所（物件の文＝交通・徒歩・所在地等がある行は除く） */
const POSTAL_MARK_RE = /\[郵便番号非表示\]|〒/;
const PROPERTY_LINE_RE = /交通|徒歩|駅|所在地|物件|間取り|賃料|家賃|築|号室|管理費|https?:/;
const ADDRESS_G = /(?:[一-龯]{2,3}[都道府県])?[一-龯]{1,6}[市区町村郡][^\s、。,，]{0,24}/g;
function maskCustomerLine(line: string): string {
  let l = line.replace(BIG_MONEY_G, ALT_MASK).replace(CORP_G, (m) => (m.trim() ? ALT_MASK : m)).replace(KANA_CORP_G, (m) => (m ? ALT_MASK : m));
  if (POSTAL_MARK_RE.test(l) && !PROPERTY_LINE_RE.test(l)) l = l.replace(ADDRESS_G, ALT_MASK);
  return l;
}
/** お客様の行に値が残っているか（maskCustomerLine と同じ網） */
function customerLineValue(line: string): string | null {
  if (new RegExp(BIG_MONEY_G.source).test(line)) return "100万以上の金額";
  if (new RegExp(CORP_G.source).test(line) || new RegExp(KANA_CORP_G.source).test(line)) return "法人の名前";
  if (POSTAL_MARK_RE.test(line) && !PROPERTY_LINE_RE.test(line) && new RegExp(ADDRESS_G.source).test(line.replace(/\[[^\]]*\]|［[^］]*］/g, ""))) return "郵便番号の後ろの住所";
  return null;
}
// ─── 勤め先の手がかりがある行（スタッフの1通も）: 在籍確認の案内で勤務先の法人名・住所を書き写した1通（10/21 の確かめ）───
//   法人名は管理会社・保証会社・自社の名前と同じ形なので、勤め先の手がかりの語がある行だけで伏せる
const WORK_CUE_RE = /勤務先|お勤め|勤め先|職場|在籍確認|お仕事|代表者|勤続|就業|就労|年収|雇用/;
const ADDRESS_NUM_G = /(?:[一-龯]{2,3}[都道府県])?[一-龯]{1,6}[市区町村郡][^\s、。,，]{0,24}\d[^\s、。,，]{0,16}/g;
function maskWorkCueLine(line: string): string {
  if (!WORK_CUE_RE.test(line)) return line;
  return line.replace(CORP_G, (m) => (m.trim() ? ALT_MASK : m)).replace(ADDRESS_NUM_G, ALT_MASK);
}
function workCueValue(text: string): string | null {
  for (const l of text.split("\n")) {
    if (!WORK_CUE_RE.test(l)) continue;
    if (new RegExp(CORP_G.source).test(l)) return "勤め先の法人名";
    if (new RegExp(ADDRESS_NUM_G.source).test(l)) return "勤め先の住所";
  }
  return null;
}
/** この行はお客様の行か（messages は「スタッフの1通でない行」、system はお客様の1通の中だけ） */
function customerish(mode: FieldStart, inCustomer: boolean, inStaff: boolean): boolean {
  return mode === true ? !inStaff : mode === "customer" && inCustomer;
}

export function maskApplicationValuesForAlt(text: string | null | undefined, opts: { fieldStart?: FieldStart } = {}): string {
  const mode: FieldStart = opts.fieldStart ?? true;
  let inCustomer = false, inStaff = false;
  const raw = String(text ?? "");
  if (!raw) return raw;
  const lines = raw.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (IMAGE_MARK_RE.test(l) || STRONG_DOC_RE.test(l)) {
      const end = regionEnd(lines, i, 60);
      if (isDocBlock(lines.slice(i, end).join("\n"))) { out.push(ALT_DOC_MASK); i = end; continue; }
    }
    if (MSG_HEAD_RE.test(l)) { inCustomer = CUSTOMER_HEAD_RE.test(l); inStaff = STAFF_HEAD_RE.test(l); }
    const { head, body } = splitHead(l);
    const probe = [body, ...lines.slice(i + 1)];
    if (isFormStart(probe, 0, fieldStartAt(mode, inCustomer), mode !== "customer" || inCustomer || inStaff)) {
      const end = formEnd(lines, i);
      out.push(head + maskFormLine(body));
      for (let k = i + 1; k < end; k++) out.push(maskFormLine(lines[k]));
      i = end;
      continue;
    }
    out.push(maskWorkCueLine(customerish(mode, inCustomer, inStaff) ? maskCustomerLine(l) : l));
    i++;
  }
  return out.join("\n")
    .replace(LABELED_BIRTH_G, `$1${ALT_MASK}`)
    .replace(BIRTH_DAY_G, ALT_MASK)
    .replace(INCOME_G, `年収${ALT_MASK}`)
    .replace(WORKPLACE_G, `$1${ALT_MASK}`)
    .replace(LABEL_COLON_G, `$1${ALT_MASK}`)
    .replace(LABEL_SPACE_G, `$1${ALT_MASK}`)
    .replace(LABELED_ID_G, `$1${ALT_MASK}`)
    .replace(BANK_ACCOUNT_G, `$1${ALT_MASK}`)
    .replace(MOBILE_G, "[電話番号非表示]")
    .replace(EMAIL_G, "[メールアドレス非表示]")
    .replace(NAME_WITH_READING_G, ALT_MASK)
    .replace(NAME_KANA_PAIR_G, ALT_MASK)
    .replace(KANA_CORP_G, (m) => (m ? ALT_MASK : m))
    .replace(KANA_READING_RUN_G, ALT_MASK);
}

// ─── どの行でも伏せる人の名前の形（スタッフが申込の中身を書き写した1通にも出る・10/21 の確かめ）───
/** 漢字の氏名＋カナの読み（「山田 太郎（ヤマダ タロウ）」） */
//   読みは姓と名の間に空白がある形だけ（「収納（ウォークインクローゼット）」に当てない）
const NAME_WITH_READING_G = /[一-龯々ぁ-ん]{1,4}[\s　]?[一-龯々ぁ-ん]{1,5}[\s　]*[（(][ァ-ヶー]{1,10}[\s　][ァ-ヶー]{1,10}[）)]/g;
/** 漢字の氏名＋空白＋カナの氏名（「山田 太郎 ヤマダ タロウ」） */
const NAME_KANA_PAIR_G = /[一-龯々]{1,4}[\s　][一-龯々]{1,4}[\s　]+[ァ-ヶー]{2,10}[\s　][ァ-ヶー]{2,10}/g;
/** 住所の読み（「オオサカシ ヒガシスミヨシク テルガオカ」＝県・市の語の後に区・市・町の語。設備の並び「オートロック エレベーター」には当てない） */
const KANA_READING_RUN_G = /[ァ-ヶー]{2,}(?:シ|フ|ケン|ト|ドウ)[\s　]+[ァ-ヶー]{2,}(?:ク|シ|チョウ|マチ|ムラ|グン)(?:[\s　]+[ァ-ヶー0-9０-９\-]{1,})*/g;
/** 値が残っているか（どの行でも見る網） */
function globalNameValue(text: string): string | null {
  if (new RegExp(NAME_WITH_READING_G.source).test(text) || new RegExp(NAME_KANA_PAIR_G.source).test(text)) return "氏名と読み";
  if (new RegExp(KANA_CORP_G.source).test(text)) return "法人の名前の読み";
  if (new RegExp(KANA_READING_RUN_G.source).test(text)) return "カナの読みの並び";
  return null;
}

/** 伏せた後の文のお客様の行に、欄の名前の無い値（100万以上の金額・法人の名前・郵便番号の後ろの住所）が残っているか */
function customerValuesRemain(text: string, mode: FieldStart): string | null {
  let inCustomer = false, inStaff = false;
  for (const l of text.split("\n")) {
    if (MSG_HEAD_RE.test(l)) { inCustomer = CUSTOMER_HEAD_RE.test(l); inStaff = STAFF_HEAD_RE.test(l); }
    if (!customerish(mode, inCustomer, inStaff)) continue;
    const v = customerLineValue(l);
    if (v) return v;
  }
  return null;
}

/** 伏せた後の文に、値の残った申込フォームの束があるか（束の中の行が見出し・欄の名前・伏せ字だけか） */
function formValuesRemain(text: string, mode: FieldStart = true): boolean {
  const lines = text.split("\n");
  let inCustomer = false, inStaff = false;
  for (let i = 0; i < lines.length; i++) {
    if (MSG_HEAD_RE.test(lines[i])) { inCustomer = CUSTOMER_HEAD_RE.test(lines[i]); inStaff = STAFF_HEAD_RE.test(lines[i]); }
    const { body } = splitHead(lines[i]);
    if (!isFormStart([body, ...lines.slice(i + 1)], 0, fieldStartAt(mode, inCustomer), mode !== "customer" || inCustomer || inStaff)) continue;
    const end = formEnd(lines, i);
    for (let k = i; k < end; k++) {
      const l = k === i ? body : lines[k];
      if (maskFormLine(l) !== l) return true;
    }
    i = end - 1;
  }
  return false;
}

/**
 * 伏せた後にまだ値が残っているか（理由・無ければ null）。見るのは値だけ（欄の見出し・伏せ字の跡・指示文の語は数えない）。
 *   docs=true（messages 側）の時だけ書類の読み取りの束も見る（system は指示文に「運転免許証・氏名・住所」等の語が並ぶので見ない）
 */
export function altPiiValuesRemain(text: string | null | undefined, opts: { docs?: boolean } = {}): string | null {
  const t = String(text ?? "").replace(URL_RE, " ");
  if (!t.trim()) return null;
  const base = altPiiSignal(t);
  if (base) return base;
  if (INCOME_VALUE_RE.test(t)) return "年収の値";
  if (BIRTH_DAY_RE.test(t)) return "生年月日らしい日付";
  if (WORKPLACE_VALUE_RE.test(t)) return "勤務先の値";
  if (formValuesRemain(t, opts.docs === true ? true : "customer")) return "申込フォームの値";
  const cv = customerValuesRemain(t, opts.docs === true ? true : "customer") ?? globalNameValue(t) ?? workCueValue(t);
  if (cv) return cv;
  if (opts.docs) {
    const lines = t.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!(IMAGE_MARK_RE.test(lines[i]) || STRONG_DOC_RE.test(lines[i]))) continue;
      if (isDocBlock(lines.slice(i, regionEnd(lines, i, 60)).join("\n"))) return "書類の読み取り";
    }
  }
  return null;
}

/** Anthropic の本文の形（出口で使う最小の形） */
type MaskBlock = { type?: string; text?: string };
type MaskBody = { system?: string | MaskBlock[]; messages?: Array<{ role?: string; content?: string | MaskBlock[] }> };
function mapText<T extends string | MaskBlock[] | undefined>(c: T, f: (s: string) => string): T {
  if (typeof c === "string") return f(c) as T;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b === "object" && typeof b.text === "string" && (!b.type || b.type === "text") ? { ...b, text: f(b.text) } : b)) as T;
  return c;
}
function textOf(c: string | MaskBlock[] | undefined): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.map((b) => (b && typeof b === "object" && typeof b.text === "string" ? b.text : "")).join("\n");
}

/**
 * 本文（system・messages）を伏せて、伏せきれたかを返す（純関数）。remain が null なら masked を DeepSeek に送ってよい。
 *   changed＝伏せ字に置き換えた所があった（記録用）
 */
export function maskAltBody<B extends MaskBody>(body: B): { masked: B; remain: string | null; changed: boolean } {
  const masked = {
    ...body,
    ...(body.system !== undefined ? { system: mapText(body.system, (t) => maskApplicationValuesForAlt(t, { fieldStart: "customer" })) } : {}),
    ...(body.messages !== undefined ? { messages: body.messages.map((m) => ({ ...m, content: mapText(m.content, (t) => maskApplicationValuesForAlt(t)) })) } : {}),
  } as B;
  const sysBefore = textOf(body.system), sys = textOf(masked.system);
  const msgsBefore = (body.messages ?? []).map((m) => textOf(m.content)).join("\n");
  const msgs = (masked.messages ?? []).map((m) => textOf(m.content)).join("\n");
  const remain = altPiiValuesRemain(sys) ?? altPiiValuesRemain(msgs, { docs: true });
  return { masked, remain, changed: sys !== sysBefore || msgs !== msgsBefore };
}
