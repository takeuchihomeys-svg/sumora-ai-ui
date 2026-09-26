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

// ─── お部屋ごとに見る（2026-09-26 穴:G5・切り替え）───
// 退去予定・入居中はお部屋ごとの事実。旧: 会話全体で「退去予定の話→先押さえの勧め」を見ていたので、
//   9/18 の第2エクセルハイツ（9月末退去予定・「お気に召されましたらお申込みしお部屋押さえ」）の後、
//   9/24 に新着の別の物件（パレス城北 401）を送り、お客様の「日曜内覧可能でしょうか？」が AIX【申込へ】に変わった（9b9b81ba・スタッフは内覧へ）。
// 直し方: ①退去予定の話のお部屋（その行と直前2行の「〇〇 NNN号室」・🌟/【】のラベル）を取り出す
//   ②その後にスタッフが**別のお部屋**を送った・案内した（名前のある通）なら、お客様の内覧の希望はその別のお部屋の話として補正しない
//   ③先押さえの勧めは「退去予定のお部屋の通」（その通が退去予定の語・そのお部屋の名前を持つ、または名前の無い通）の時だけ数える。
//     物件送付の定型の締め（お気に召されましたらお申込しお部屋抑え）が**別のお部屋の送付**に付いている時は数えない
//   ④お客様が名前でお部屋を指していれば、それが退去予定のお部屋か別のお部屋かで決める
//   名前が取れない通は旧のまま（補正する側に倒さない・倒す側も変えない）。

/** 本文のお部屋の手がかり（建物の鍵＋部屋の番号）。「メゾンラトゥール 103号室」「🌟パレス城北 401」「【スプランディッド本町グラン 1003号室】」 */
export type MoveOutPropRef = { key: string; room: string | null };
const PROP_WITH_ROOM_RE = /([^\s\n、。！!？?「」（）()【】🌟:：・,，]{2,24}?)[ 　]*(?<![0-9０-９])([0-9０-９]{2,4})[ 　]*号室/g;
// 反証レビュー（2026-09-26）: 「【家賃 65000】」が 家賃6＋5000 のお部屋になっていた → 数字の前後に数字・桁区切りが続く物は部屋の番号にしない
const PROP_LABEL_RE = /(?:🌟|【)[ 　]*([^\n【】🌟]{2,40}?)[ 　]*(?<![0-9０-９,，])([0-9０-９]{2,4})(?![0-9０-９,，])[ 　]*(?:号室?)?[ 　]*(?:】|$)/gm;
const NOT_A_NAME_RE = /^(?:お送り|こちら|そちら|上記|下記|物件|お部屋|他|ほか|全|計|合計|約|第?[0-9０-９]+件)/;
/** 費用・条件の見出し（【管理費 5000】【築 15】）はお部屋の名前ではない */
const NOT_A_NAME_TAIL_RE = /(?:家賃|賃料|管理費|共益費|敷金|礼金|保証金|初期費用|合計|駐車場?|築|徒歩|面積|階)$/;
/** 名前の前の指し示し（「こちらのメゾンラトゥール 103号室」→ メゾンラトゥール）。旧は NOT_A_NAME_RE で名前ごと捨てていた */
const NAME_LEAD_RE = /^(?:こちら|そちら|あちら|上記|下記|先程|先ほど|前回|以前|今回|最初|次)の/;
/** 漢数字（第二↔第2）: 両側を同じにそろえるだけ（「一条」も両側で「1条」になるので照合に害は無い） */
const KANJI_DIGIT: Record<string, string> = { "〇": "0", "一": "1", "二": "2", "三": "3", "四": "4", "五": "5", "六": "6", "七": "7", "八": "8", "九": "9" };
// 反証レビュー: 「第2エクセルハイツ 110」と「第二エクセルハイツ110号室」を別のお部屋と読み、退去予定の縛りを外していた（switched_to_other_property）→ 漢数字をそろえる
const propKey = (s: string) => s.normalize("NFKC").replace(/[〇一二三四五六七八九]/g, (c) => KANJI_DIGIT[c] ?? c).replace(/[\s　・\-‐ー－―]/g, "").toLowerCase();
const roomNo = (s: string) => toHalf(s).replace(/^0+/, "");
export function moveOutPropRefs(text: string | null | undefined): MoveOutPropRef[] {
  const t = text ?? "";
  const out: MoveOutPropRef[] = [];
  const add = (name: string, room: string) => {
    const n = name.replace(/^(?:の中で|中で|で|は|が|も|と|の)/, "").trim().replace(NAME_LEAD_RE, "").trim();
    if (n.length < 2 || NOT_A_NAME_RE.test(n) || NOT_A_NAME_TAIL_RE.test(n)) return;
    const key = propKey(n);
    if (key.length < 3) return;
    const r = { key, room: roomNo(room) };
    if (!out.some((o) => o.key === r.key && o.room === r.room)) out.push(r);
  };
  for (const m of t.matchAll(PROP_LABEL_RE)) add(m[1], m[2]);
  for (const m of t.matchAll(PROP_WITH_ROOM_RE)) add(m[1], m[2]);
  return out;
}
/** 同じお部屋か（部屋の番号が両方あって違えば別・建物の鍵は先頭4文字の含み合い） */
export function samePropRef(a: MoveOutPropRef, b: MoveOutPropRef): boolean {
  if (a.room && b.room && a.room !== b.room) return false;
  const k = Math.min(4, a.key.length, b.key.length);
  if (k < 3) return false;
  return a.key.includes(b.key.slice(0, k)) || b.key.includes(a.key.slice(0, k));
}
/** お客様の文に送ったお部屋の建物名が出ているか（「neoとこの二件」「パレス城北いけますか」: 号室なしでも建物の鍵4文字で見る） */
function customerNamesProp(customerText: string, p: MoveOutPropRef): boolean {
  const k = p.key.slice(0, Math.min(6, p.key.length));
  return k.length >= 4 && propKey(customerText).includes(k);
}

export type MoveOutViewingVerdict = {
  blocks: boolean;
  reason: "no_move_out" | "viewing_offered" | "hold_advised" | "hold_for_other_property" | "switched_to_other_property" | "customer_names_other_property" | "no_hold_advice";
  /** 退去予定の話のお部屋（取れた物だけ） */
  moveOutProps: MoveOutPropRef[];
};

/**
 * 退去予定・入居中のため内覧へ進めず、申込（先押さえ）に回すべきか（brain-core の信号0.95・内覧誤提案ガード・次の AIX の3か所で共有）。
 * 2026-09-15 竹内（隼斗事例）で「退去予定」の語だけで決めるのをやめた: 退去予定の話の後、スタッフの最後の言及が
 * 先押さえの勧め・退去前は内覧できない（staffAdvisesHold）の時だけ true。内覧を案内した・何も言っていない時はブレイン（LLM）の判断のまま
 * 2026-09-26（穴:G5）: お部屋ごとに見る（上の ①〜④）。理由も返す（監査 scripts/audit-move-out-guard.ts）
 */
export function moveOutViewingVerdict(msgs: ReadonlyArray<SenderText>, order: "newest_first" | "oldest_first"): MoveOutViewingVerdict {
  const oldestFirst = order === "newest_first" ? [...msgs].reverse() : [...msgs];
  let last = -1;
  oldestFirst.forEach((m, i) => { if (MOVE_OUT_PATTERN.test(moveOutEvidenceFromMsgs([m]))) last = i; });
  if (last < 0) return { blocks: false, reason: "no_move_out", moveOutProps: [] };
  // ① 退去予定の話のお部屋: 退去予定の語の行と直前2行（「メゾンラトゥール 103号室現在募集中となります！！\n10月30日退去予定」）
  const moText = oldestFirst[last].text ?? "";
  const lines = moText.split("\n");
  const moveOutProps: MoveOutPropRef[] = [];
  lines.forEach((l, i) => {
    if (!MOVE_OUT_PATTERN.test(l)) return;
    for (const p of moveOutPropRefs(lines.slice(Math.max(0, i - 2), i + 1).join("\n"))) if (!moveOutProps.some((q) => samePropRef(p, q))) moveOutProps.push(p);
  });
  //   行の近くに名前が無い（「🌟第2エクセルハイツ 110」が先頭で、退去予定は8行下の本文）→ その通の全てのお部屋。
  //   複数のお部屋の通でも全部を「退去予定のお部屋」に入れる＝別のお部屋と読む範囲が狭まるだけ（補正を外す側に倒さない）
  if (!moveOutProps.length) for (const p of moveOutPropRefs(moText)) if (!moveOutProps.some((q) => samePropRef(p, q))) moveOutProps.push(p);
  const isMoveOutProp = (p: MoveOutPropRef) => moveOutProps.some((q) => samePropRef(p, q));
  // ④ お客様の最後の連投がお部屋を名前で指しているか
  const tail: string[] = [];
  for (let i = oldestFirst.length - 1; i > last && oldestFirst[i].sender === "customer"; i--) tail.unshift(oldestFirst[i].text ?? "");
  const custText = tail.join("\n");
  const since = oldestFirst.slice(last);
  const staffIdx = since.map((m, i) => ({ m, i })).filter((x) => x.m.sender !== "customer");
  const namedLater = staffIdx.slice(1).flatMap((x) => moveOutPropRefs(x.m.text)).filter((p) => !isMoveOutProp(p));
  if (custText && moveOutProps.length) {
    const namesMoveOut = moveOutProps.some((p) => customerNamesProp(custText, p)) || moveOutPropRefs(custText).some(isMoveOutProp);
    const namesOther = namedLater.some((p) => customerNamesProp(custText, p)) || moveOutPropRefs(custText).some((p) => !isMoveOutProp(p));
    if (namesOther && !namesMoveOut) return { blocks: false, reason: "customer_names_other_property", moveOutProps };
  }
  // 新しい方から: 内覧の案内→補正しない／先押さえの勧め（退去予定のお部屋の通）→補正／別のお部屋の通→補正しない
  for (let j = staffIdx.length - 1; j >= 0; j--) {
    const { m, i } = staffIdx[j];
    const t = m.text ?? "";
    if (staffOffersViewing(t)) return { blocks: false, reason: "viewing_offered", moveOutProps };
    // この通のお部屋。名前が無い通は、同じ連投（間にお客様の発言が無い）の直前のスタッフの通のお部屋を見る（写真・ラベルの通の後の締めの通）
    let props = moveOutPropRefs(t);
    if (!props.length && i > 0) {
      for (let k = i - 1; k >= 0 && since[k].sender !== "customer"; k--) { props = moveOutPropRefs(since[k].text); if (props.length) break; }
    }
    const isMoveOutMsg = i === 0;
    const aboutMoveOut = isMoveOutMsg || MOVE_OUT_PATTERN.test(t) || /退去前/.test(t) || props.some(isMoveOutProp);
    const other = moveOutProps.length ? props.filter((p) => !isMoveOutProp(p)) : [];
    if (staffAdvisesHold(t)) {
      // ③ 別のお部屋の送付に付いた定型の締めは、退去予定のお部屋の先押さえの勧めではない
      if (!aboutMoveOut && other.length) return { blocks: false, reason: "hold_for_other_property", moveOutProps };
      return { blocks: true, reason: "hold_advised", moveOutProps };
    }
    // ② 退去予定の話の後に別のお部屋を送った・名前を出した → お客様の内覧の希望はそちらの話
    if (!isMoveOutMsg && !aboutMoveOut && other.length) return { blocks: false, reason: "switched_to_other_property", moveOutProps };
  }
  return { blocks: false, reason: "no_hold_advice", moveOutProps };
}

export function moveOutBlocksViewing(msgs: ReadonlyArray<SenderText>, order: "newest_first" | "oldest_first"): boolean {
  return moveOutViewingVerdict(msgs, order).blocks;
}

/**
 * 返信生成の履歴（「スモラ:」「お客様:」の行・続きの行は前の発言に足す）＋今回のお客様の発言を、古い順のメッセージにする。
 * 2026-09-26（穴:G5・四者同名）: 生成の detectPropertyStatus（【🚨 物件募集状況】退去予定＝内覧日程を提案しない）も、
 *   ブレインと同じ moveOutViewingVerdict でお部屋ごとに見るため
 */
export function moveOutMsgsFromHistory(history: string | null | undefined, customerMessage: string): SenderText[] {
  const out: SenderText[] = [];
  for (const line of (history ?? "").split("\n")) {
    const m = line.match(/^(スモラ|お客様)[:：]\s?(.*)$/);
    if (m) out.push({ sender: m[1] === "スモラ" ? "staff" : "customer", text: m[2] });
    else if (out.length) out[out.length - 1] = { ...out[out.length - 1], text: `${out[out.length - 1].text ?? ""}\n${line}` };
  }
  if ((customerMessage ?? "").trim()) out.push({ sender: "customer", text: customerMessage });
  return out;
}

/** 退去予定の話の後に、お客様の話の相手が別のお部屋に移っている（生成で退去予定の縛りを当てない） */
export function moveOutSwitchedToOtherProperty(v: MoveOutViewingVerdict): boolean {
  return v.reason === "switched_to_other_property" || v.reason === "customer_names_other_property" || v.reason === "hold_for_other_property";
}
