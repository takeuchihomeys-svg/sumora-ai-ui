// app/lib/move-out-context.ts
// G10（2026-09-08 Fable5）: 退去・引越し・解約語の「主語」判定。
// 四者同名: route.ts（negativeDetail / detectPropertyStatus / 方向性）・brain-core.ts・final-check.ts が全てここを import する。
// 原則: 顧客は提案物件の退去日を自分から知り得ない（スタッフが伝えて初めて知る）ので、
//       顧客発話の退去語はデフォルトで「現住居＝入居時期情報」であり、離脱でも物件募集状況でもない。
import { FORM_LABEL_RE } from "./line-reply-prompts";

export type MoveOutSubject = "current_home" | "proposed_property" | "search_exit" | "none";

/** 現住居を指す主語マーカー */
export const CURRENT_HOME_RE =
  /(?:今|いま|現在|現)(?:の|、)?\s*(?:お?家|お?部屋|マンション|アパート|物件|住まい|住居|所|ところ|賃貸|契約)|(?:今|いま|現在)(?:は|も)?(?:住んで|借りて|契約して)|現住|現居|実家|自宅|住んで(?:る|いる|います)|ご?入居(?:時期|希望|予定)|引っ?越し(?:時期|予定|したい|希望)/;

/** 提案物件を指す主語マーカー（スタッフ送付物件への言及・物件情報の転記・URL） */
export const PROPOSED_PROPERTY_REF_RE =
  /そちら|その(?:物件|お?部屋)|この(?:物件|お?部屋)|こちらの(?:物件|お?部屋)|(?:送って|お送り)(?:もらった|いただいた|頂いた|くださった)|ご?提案(?:いただい|頂い|された)|ご?紹介(?:いただい|頂い|された)|[①-⑩]|[ABCＡＢＣ](?:の|は)|[0-9０-９]+(?:件目|つ目|番目)|現況|募集|物件名|賃料|管理費|https?:\/\//;

export const MOVE_VERB_RE = /退去|退室|解約|引っ?越(?:し|す)|転居|転勤|転出/;

/** 部屋探し自体の終了（本当の離脱）。「ありがとうございました」単独は感謝返しなので含めない */
export const SEARCH_EXIT_RE =
  /(?:お?部屋探し|物件探し|お?家探し|引っ?越し|転居)(?:自体|の話|の件|は|を|が|も)?\s*(?:なくな|無くな|中止|白紙|取りやめ|取り止め|やめ|辞め|見送|延期)|引っ?越し先(?:が|は|も)?(?:決ま|見つか)|(?:他社|他(?:の)?(?:会社|仲介|業者|不動産)|別の(?:会社|仲介|業者|不動産)|他のところ|別のところ|知人|友人|親戚|自分)(?:で|に|の紹介で|さん.{0,6}で?)(?:契約|申込|決め|決ま|見つけ)|(?:他|別)の(?:物件|お?部屋)(?:で|に)(?:決め|決ま|契約|申込)|お世話になりました/;

/** 物件募集状況（退去予定/入居中）: route.ts・brain-core.ts のローカル定義をここに集約（二重定義禁止） */
export const MOVE_OUT_PATTERN = /退去予定|入居中|[0-9０-９]{1,2}\s*月末?\s*退去|退去[はが]?[0-9０-９]{1,2}\s*月/;

/** 現住居の退去句「今の家は3月末退去予定」を丸ごと伏字化する（replace 専用・/g） */
export const CURRENT_HOME_MOVEOUT_CLAUSE_RE = new RegExp(
  `(?:${CURRENT_HOME_RE.source})[^\\n。！!]{0,25}?(?:${MOVE_VERB_RE.source})[^\\n。！!、]{0,15}`, "g",
);

/** 顧客最新メッセージの退去・引越し語の主語を判定（文単位・条件フォームラベルは剥がしてから） */
export function classifyMoveOutSubject(msg: string): MoveOutSubject {
  const m = (msg ?? "").trim();
  if (!m) return "none";
  if (SEARCH_EXIT_RE.test(m)) return "search_exit";
  if (!MOVE_VERB_RE.test(m)) return "none";
  const sentences = m.split(/[\n。！!？?]/).filter((s) => MOVE_VERB_RE.test(s));
  let proposed = false;
  for (const raw of sentences) {
    const s = raw.replace(FORM_LABEL_RE, "");
    if (CURRENT_HOME_RE.test(s)) return "current_home";
    if (PROPOSED_PROPERTY_REF_RE.test(s)) proposed = true;
  }
  if (proposed) return "proposed_property";
  // 主語なし: 退去・引越し系は「自分の家」の話（顧客は提案物件の退去日を自分から知り得ない）。解約単独は対象不明 → none
  return /退去|退室|引っ?越|転居|転勤|転出/.test(m) ? "current_home" : "none";
}

/** 募集状況判定に使ってよいテキストだけを残す（history は「スモラ:」「お客様:」行形式）
 *  スタッフ行は全採用／顧客行はラベル剥がし→現住居退去句を伏字化→提案物件への言及が残る行のみ採用 */
export function moveOutEvidenceText(history: string | null | undefined, customerMessage: string): string {
  const lines = `${history ?? ""}\n${(customerMessage ?? "").split("\n").map((l) => `お客様:${l}`).join("\n")}`.split("\n");
  return lines.map((l) => {
    if (!l.startsWith("お客様:")) return l;
    const masked = l.replace(FORM_LABEL_RE, "").replace(CURRENT_HOME_MOVEOUT_CLAUSE_RE, "");
    return PROPOSED_PROPERTY_REF_RE.test(masked) ? masked : "";
  }).join("\n");
}

/** brain-core 用（sender 付きメッセージ配列版） */
export function moveOutEvidenceFromMsgs(msgs: ReadonlyArray<{ sender?: string | null; text?: string | null }>): string {
  return msgs.map((m) => {
    const t = m.text ?? "";
    if (m.sender !== "customer") return t;
    const masked = t.replace(FORM_LABEL_RE, "").replace(CURRENT_HOME_MOVEOUT_CLAUSE_RE, "");
    return PROPOSED_PROPERTY_REF_RE.test(masked) ? masked : "";
  }).join("\n");
}
