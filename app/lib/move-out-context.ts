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

/** スタッフが内覧可能日・内覧可を明示した（退去前の内覧制限は解除済み）。
 *  2026-09-12 竹内方針A-3: route.ts detectPropertyStatus（旧 VIEWING_CONFIRMED_PATTERN）と final-check E6 VIEWING_BEFORE_VACANCY が同じ定義を使う */
export const VIEWING_CONFIRMED_PATTERN =
  /内覧(?:開始|可能|でき|いただけ)|からご案内|よりご案内|[0-9０-９]{1,2}[\/月][0-9０-９]{1,2}(?:日)?(?:から|より|以降|には?)?(?:ご案内|内覧|案内)|退去(?:済み?|後).*(?:ご?案内|内覧)/;

/** 直近スタッフ発言（最大5件を改行で連結したもの）で退去前の内覧制限が解除されているか */
export function isMoveOutReleased(recentStaffText: string): boolean {
  return VIEWING_CONFIRMED_PATTERN.test(recentStaffText ?? "");
}

const ROOM_NO_RE = /([0-9０-９]{3,4})\s*号室?/g;
const toHalf = (s: string) => s.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
/** 退去予定・入居中の根拠行に書かれた号室番号（無ければ空） */
export function moveOutRoomNumbers(evidence: string): Set<string> {
  const out = new Set<string>();
  for (const line of (evidence ?? "").split("\n")) {
    if (!MOVE_OUT_PATTERN.test(line)) continue;
    for (const m of line.matchAll(ROOM_NO_RE)) out.add(toHalf(m[1]));
  }
  return out;
}
/** 本文に書かれた号室番号 */
export function roomNumbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of (text ?? "").matchAll(ROOM_NO_RE)) out.add(toHalf(m[1]));
  return out;
}
/** 退去予定の根拠の号室と本文の号室が両方あり、1つも重ならない（別の部屋の退去予定を当てはめない） */
export function moveOutRoomMismatch(evidence: string, text: string): boolean {
  const ev = moveOutRoomNumbers(evidence);
  const tx = roomNumbersIn(text);
  if (ev.size === 0 || tx.size === 0) return false;
  for (const r of tx) if (ev.has(r)) return false;
  return true;
}

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

// ─── スタッフが内覧を案内したか（退去予定の物件でも内覧の日程調整に進んでいるか） ───
// 2026-09-15 竹内（隼斗事例）: 「10月30日退去予定」の物件をお送りした後、スタッフが「本日ご内覧如何でしょうか 17:30〜18:30お部屋ご案内出来ます」と
//   内覧を案内し、お客様が「本日は厳しいので18日はどうでしょうか？」と日程を返した。ブレインは内覧へ（9/18の候補を提示）を選んだが、
//   退去予定の補正（直近の履歴に「退去予定」があれば申込へ＝先押さえ）が上書きし、AIX 申込へ が出た。
//   実データ（120日）: 直近のスタッフ発言に退去予定がある中でお客様が内覧を希望した回、スタッフの次の AIX は 内覧へ13・待ち合わせ11・申込へ6。
//   申込へ の6件はスタッフが「退去前のため現地ご案内ができません」と伝えた場面。退去予定の語だけでは内覧できないとは言えない。
//   → 退去予定の話の後にスタッフが内覧（日時・可否）を案内していれば、内覧の日程調整に進んでいる（補正しない）。
//   「〜ができませんが」「退去前」の文、物件送付の定型の「お気に召されましたらご案内」は案内に数えない。
const STAFF_VIEWING_OFFER_RE =
  /(?:ご?内覧|内見|ご?案内)[^。！!？?\n]{0,12}?(?:如何|いかが|出来ます|できます|可能(?:です|でした|となります)|させて(?:頂|いただ)き(?:ます|たい)|させて(?:頂|いただ)けます)/;
const STAFF_VIEWING_NEG_RE = /出来(?:ません|ない|かね)|でき(?:ません|ない|かね)|不可|退去前|入居中|難しい|お気に召され/;

/** スタッフの1通が内覧（日時・可否）を案内しているか（文単位で見て、否定・条件付きの文は数えない） */
export function staffOffersViewing(text: string | null | undefined): boolean {
  return (text ?? "").split(/[。！!？?\n]/).some((s) => STAFF_VIEWING_OFFER_RE.test(s) && !STAFF_VIEWING_NEG_RE.test(s));
}

type SenderText = { sender?: string | null; text?: string | null };

/**
 * スタッフが先押さえ（申込で部屋を抑える）を勧めた・退去前は内覧できないと伝えた文。
 * 実データ（120日）: 退去予定の話の後にお客様が内覧を希望し、スタッフが 申込へ を押した回は、全てその前にスタッフがこれを書いていた
 * （「お気に召されましたら、先にお申込みしお部屋を抑えさせて」「退去前のため現在は現地ご案内ができません」）。書いていない回は内覧の案内（内覧へ・待ち合わせ）
 */
const STAFF_HOLD_ADVICE_RE =
  /(?:お申し?込み?|申込)[^。！!？?\n]{0,14}(?:抑え|押さえ|おさえ)|先に?お申し?込|退去前[^。！!？?\n]{0,15}(?:ご?案内|ご?内覧|内見)[^。！!？?\n]{0,8}(?:でき|出来)(?:ません|ない|かね)|(?:内覧|内見)(?:は|が)?(?:退去後|出来ません|できません)/;

/** スタッフの1通が先押さえを勧めた・退去前は内覧できないと伝えたか */
export function staffAdvisesHold(text: string | null | undefined): boolean {
  return STAFF_HOLD_ADVICE_RE.test(text ?? "");
}

/** 退去予定の話（最後に出た通）以降のスタッフの通（古い順）。退去予定の話が無ければ null */
function staffSinceMoveOut(msgs: ReadonlyArray<SenderText>, order: "newest_first" | "oldest_first"): SenderText[] | null {
  const oldestFirst = order === "newest_first" ? [...msgs].reverse() : [...msgs];
  let last = -1;
  oldestFirst.forEach((m, i) => { if (MOVE_OUT_PATTERN.test(moveOutEvidenceFromMsgs([m]))) last = i; });
  if (last < 0) return null;
  return oldestFirst.slice(last).filter((m) => m.sender !== "customer");
}

/** 退去予定・入居中の話があり、その話以降のスタッフの最後の言及が「内覧の案内」＝内覧の日程調整に進んでいる */
export function moveOutViewingReleased(msgs: ReadonlyArray<SenderText>, order: "newest_first" | "oldest_first"): boolean {
  const staff = staffSinceMoveOut(msgs, order);
  if (!staff) return false;
  for (let i = staff.length - 1; i >= 0; i--) {
    if (staffOffersViewing(staff[i].text)) return true;
    if (staffAdvisesHold(staff[i].text)) return false;
  }
  return false;
}

/**
 * 退去予定・入居中のため内覧へ進めず、申込（先押さえ）に回すべきか（brain-core の信号0.95・内覧誤提案ガード・次の AIX の3か所で共有）。
 * 2026-09-15 竹内（隼斗事例）で「退去予定」の語だけで決めるのをやめた: 退去予定の話の後、スタッフの最後の言及が
 * 先押さえの勧め・退去前は内覧できない（staffAdvisesHold）の時だけ true。内覧を案内した・何も言っていない時はブレイン（LLM）の判断のまま
 */
export function moveOutBlocksViewing(msgs: ReadonlyArray<SenderText>, order: "newest_first" | "oldest_first"): boolean {
  const staff = staffSinceMoveOut(msgs, order);
  if (!staff) return false;
  for (let i = staff.length - 1; i >= 0; i--) {
    if (staffOffersViewing(staff[i].text)) return false;
    if (staffAdvisesHold(staff[i].text)) return true;
  }
  return false;
}
