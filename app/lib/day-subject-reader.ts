// app/lib/day-subject-reader.ts — 「何の日か」と「確認の相手（主語）」を読む決まった処理（純関数・DB/LLM なし）
//
// 2026-10-20 竹内さん（設計知見 5b0b8e82・f44ca5c3・67f54c24・d9533aad）:
//   ①内覧の日程の調整の流れの中の「出来れば今月末か来月頭あたりが希望です」を入居日と読んだ（直前のこちらの一文に『ご入居』）
//     「何のことについて言っているのか理解すれば、ここが内覧日のことという事は分かるはず」
//   ②「朝方は空いてないでしょうか？」に「ご案内が可能か確認させて頂きます」＝内覧の日時はスタッフ（自社のカレンダー）で決める事なのに、
//     管理会社に聞く事と同じ『確認の約束』にした（確認の相手の取り違え）
//   ③お客様の「今日中にまた連絡します」に『本日』を返す＝圧（お客様が自分で決めた期日を、こちらから繰り返さない）
//   根本: 日付の話が「何の日か（内覧・入居・連絡・支払・申込）」と、確認が「誰が答えを持っているか（スタッフ・管理会社・お客様）」を
//         決める所がどこにも無く、ブレイン（LLM）が直前の一文の語に引っ張られていた。
//   → ここで決まった処理で読み、ブレインの材料（行動台帳の後ろ）と書く役の台帳の注記に同じ文で渡す（四者同名・同じ関数）。
//
// ⚠ 判断（AIX・返信）はブレインが決める（P0 9eb6aa9c）。ここは「この日付は何の日の話か」「この確認は誰が答えを持っているか」の読みだけ。
// 切り替え: DAY_SUBJECT_READER=on の時だけ材料に入る（既定 off＝ブレイン・書く役の文は1文字も変わらない）。
//   監査: scripts/audit-day-subject.ts（見張りの下書きとスタッフの送信で数える・LLM なし）

import type { ViewingFlowStage } from "./viewing-flow";

export function daySubjectReaderEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.DAY_SUBJECT_READER ?? "").toLowerCase() === "on";
}

const N = (s: string | null | undefined) => String(s ?? "").normalize("NFKC");

// ─── ① 何の日か ────────────────────────────────────────────────────────
export type DateKind = "viewing" | "move_in" | "contact" | "payment" | "application" | "unknown";
export const DATE_KIND_JA: Record<DateKind, string> = {
  viewing: "内覧の希望日", move_in: "入居の時期", contact: "お客様からの連絡の期日", payment: "支払・振込の日", application: "申込の日", unknown: "不明",
};
export type TimeOfDay = "morning" | "noon" | "afternoon" | "evening";
export const TIME_OF_DAY_JA: Record<TimeOfDay, string> = { morning: "朝方（午前）", noon: "お昼", afternoon: "午後", evening: "夕方以降" };

/** 日付・時期の言い方（幅を含む）。「今日はありがとう」等は文の形で外す */
export const DATE_EXPR_RE = /今月末|月末|来月(?:頭|初め|はじめ|上旬|中旬|下旬|末|中)?|再来月|[0-9]{1,2}\s*月(?:頭|初め|はじめ|上旬|中旬|下旬|末|中|[0-9]{1,2}日?)?|上旬|中旬|下旬|月初め?|(?<![0-9])(?:1[0-2]|0?[1-9])\s*\/\s*(?:3[01]|[12][0-9]|0?[1-9])(?![0-9]|\s*(?:m|㎡|平米|帖|畳))|(?<![0-9])[0-9]{1,2}\s*日(?!間|程|以内)|[月火水木金土日]曜|土日|週末|平日|今週|来週|再来週|明後日|あさって|明日|あした|今日中|本日中|今日|本日|年内|年明け|(?:もう少し|もっと)先/;
const TIME_OF_DAY_RES: Array<[TimeOfDay, RegExp]> = [
  ["morning", /朝方|朝(?:イチ|一|早く|から|なら|は|に|の|でも|$)|午前/],
  ["noon", /お昼|昼(?:頃|ごろ|なら|は|に|過ぎ|すぎ|から|でも)/],
  ["afternoon", /午後/],
  // 「夜分遅くに失礼致します」の夜は時間帯の指定ではない（見張りの番で誤読）
  ["evening", /夕方|夜(?:なら|は|に|の時間|でも|から|以降)|(?:1[7-9]|2[0-2])\s*時(?:以降|から|過ぎ|すぎ)/],
];
export function timeOfDayOf(text: string | null | undefined): TimeOfDay | null {
  const t = N(text);
  for (const [k, re] of TIME_OF_DAY_RES) if (re.test(t)) return k;
  return null;
}

/** 文の中にある「何の日か」の語（強い順に見る） */
const CONTACT_RE = /(?:連絡|返信|返事|お返事|お伝え|報告)(?:します|しますね|させて|いたします|致します|入れます|できれば|出来れば|できる|出来る)|(?:また|改めて|あとで|後で|後ほど)[^。！!？?\n]{0,6}(?:連絡|ご連絡|返事|返信)/;
const PAYMENT_RE = /振込|振り込|支払|入金|お金(?:の)?(?:用意|準備)|用意でき/;
const APPLICATION_RE = /申込|申し込|審査/;
const MOVE_IN_RE = /入居|引っ?越|引越|転居|住み(?:始|替)|退去|入れ(?:る|ます)(?:ところ|所|部屋|お部屋|物件|とこ)/;
const VIEWING_RE = /内覧|内見|見学|ご案内|案内|[見観]に(?:行|い)|見れ|見られ|見たい/;
const KIND_RES: Array<[DateKind, RegExp]> = [["contact", CONTACT_RE], ["payment", PAYMENT_RE], ["application", APPLICATION_RE], ["move_in", MOVE_IN_RE], ["viewing", VIEWING_RE]];
function explicitKindOf(clause: string): DateKind | null {
  for (const [k, re] of KIND_RES) if (re.test(clause)) return k;
  return null;
}
/** お礼・挨拶の中の日付（「今日はありがとうございました」）は希望でも約束でもない */
const THANKS_ONLY_RE = /ありがと|有難|お疲れ|助かり/;
const PAST_REPORT_RE = /(?:行って|見て|して|観て)(?:き|来)(?:た|ました)|(?:内覧|内見|見学)(?:し|致し|いたし)(?:た|ました)(?!い)/;
const ASKISH_RE =/希望|がいい|が良い|がよい|で(?:お願い|大丈夫|いけ|行け)|なら|だと|とか|でも|頃|ごろ|あたり|辺り|以降|から|まで|可能|空いて|空き|いけ|行け|どう|いかが|如何|ます|です|か$|[?？]|ません/;

/** こちらの文: 内覧の候補日を出した・日程を聞いた（内覧の日程の調整中の印） */
/** ※「お気に召されましたらご都合よろしいお日にちにご案内させて頂きます」は物件のご紹介の決まり文句＝調整中の印にしない（条件の聞き取りの番で誤読した） */
export const STAFF_VIEWING_SCHEDULING_RE = /ご案内可能|ご内覧可能|内覧可能|お日にち御座いますでしょうか|お日にちございますでしょうか|ご都合よろしいお時間|(?:内覧|ご案内|ご内覧)[^。！!？?\n]{0,16}(?:日程|お日にち|いつ|何日)|[0-9]{1,2}\s*:\s*[0-9]{2}\s*[〜~～\-－]\s*[0-9]{1,2}\s*:\s*[0-9]{2}/;
/** こちらの直前の文: 聞かれたお部屋への答えで「よろしければ一度ご都合よろしいお日にちにお部屋ご案内させて頂きます」と内覧に誘った
 *  （物件のご紹介の決まり文句「お気に召されたお部屋ご都合よろしいお日にちに…」は当たらない）。流れの段（viewing-flow）はまだ none の所。
 *  次のお客様の語の無い日付（「明日空いてたりしますでしょうか」）は内覧の日（q181: 残った別の確認の約束に寄って確認の返信にした） */
export const STAFF_VIEWING_INVITE_RE = /(?:よろしければ|宜しければ)(?:一度|是非|ぜひ)?[^。！!？?\n]{0,4}ご都合(?:の)?(?:よろしい|宜しい|良い)(?:お日にち|日)に[^。！!？?\n]{0,4}ご案内/;
/** こちらの文: 待ち合わせを案内した（内覧は決まった＝調整中ではない） */
const STAFF_MEETING_RE = /待ち合わせ|現地エントランス|お待ちしております/;
/** こちらの文: 入居の時期を聞いた */
export const STAFF_ASK_MOVE_IN_RE = /(?:ご入居|入居|お引越し|お引っ越し|引っ越し)[^。！!？?\n]{0,16}(?:いつ|何日|時期|ご希望|ご都合|ご予定|頃)|(?:いつ|何日|時期)[^。！!？?\n]{0,10}(?:ご入居|入居|お引越し|お引っ越し)/;

export type DateKindSource = "explicit" | "turn" | "flow" | "staff_question" | "none";
export type DateKindReading = {
  kind: DateKind;
  source: DateKindSource;
  /** お客様の言った日付の言い方（「今月末」「来月頭」） */
  dateText: string | null;
  timeOfDay: TimeOfDay | null;
  /** こちらの直前の文が入居を聞いていた（flow で内覧と読んだ時の食い違いの印） */
  staffAskedMoveIn: boolean;
  reason: string;
};

export type ReaderMsg = { sender: string; text?: string | null };

/** お客様の今の番（最後のこちらの文より後の連投）と、その前のこちらの文（新しい順・最大3） */
export function splitTurn(msgsOldestFirst: ReadonlyArray<ReaderMsg>): { customer: string; staffBefore: string[] } {
  const msgs = msgsOldestFirst.filter((m) => (m.text ?? "").trim());
  let end = msgs.length - 1;
  while (end >= 0 && msgs[end].sender !== "customer") end--;
  if (end < 0) return { customer: "", staffBefore: [] };
  let start = end;
  while (start - 1 >= 0 && msgs[start - 1].sender === "customer") start--;
  const staffBefore: string[] = [];
  for (let i = start - 1; i >= 0 && staffBefore.length < 3; i--) if (msgs[i].sender !== "customer") staffBefore.push(String(msgs[i].text ?? ""));
  return { customer: msgs.slice(start, end + 1).map((m) => String(m.text ?? "")).join("\n"), staffBefore };
}

/**
 * 内覧の日程の調整が開いているか。流れの段（viewing-flow・台帳と同じ値）が渡されたらそれだけで決める。
 *   段が無い時（試験・監査の一部）だけ、こちらの直近の文の印で見る
 *   段が none でも、こちらの直前の文が聞かれたお部屋の内覧に誘った（STAFF_VIEWING_INVITE_RE）時は開く（q181・段がまだ動いていない所）
 */
export function viewingSchedulingOpen(stage: ViewingFlowStage | null | undefined, staffBefore: readonly string[]): boolean {
  const invitedJustNow = !!staffBefore[0] && STAFF_VIEWING_INVITE_RE.test(N(staffBefore[0]));
  if (stage) return stage === "wished" || stage === "proposing" || stage === "date_agreed" || (stage === "none" && invitedJustNow);
  if (invitedJustNow) return true;
  const recent = staffBefore.slice(0, 3).map(N);
  if (recent.some((t) => STAFF_MEETING_RE.test(t) && !STAFF_VIEWING_SCHEDULING_RE.test(t))) return false;
  return recent.some((t) => STAFF_VIEWING_SCHEDULING_RE.test(t));
}

/**
 * お客様の今の番の日付の話が何の日か（文ごと・日付のある文だけ）。
 *   ①文の中の語（入居・内覧・連絡します・振込・申込）＝explicit
 *   ②同じ番の別の文の語が1種類だけ＝turn（「内覧したいです。土曜の朝方は空いてますか」）
 *   ③内覧の日程の調整中（候補日を出した・日程を聞いた後）＝flow で内覧の希望日（直前の一文に『ご入居』があっても主の流れを優先・5b0b8e82）
 *   ④こちらが直前に入居の時期を聞いた＝staff_question で入居
 */
export function readDateKinds(i: { customerText: string; staffBefore: readonly string[]; viewingStage?: ViewingFlowStage | null }): DateKindReading[] {
  const t = N(i.customerText);
  const clauses = t.split(/[。\n！!？?]+|(?<=ので|けど|けれど|ですが)/).map((s) => s.trim()).filter(Boolean);
  const turnKinds = new Set(clauses.map(explicitKindOf).filter((k): k is DateKind => !!k));
  const turnTime = timeOfDayOf(t);
  const staffAskedMoveIn = !!i.staffBefore[0] && STAFF_ASK_MOVE_IN_RE.test(N(i.staffBefore[0]));
  const open = viewingSchedulingOpen(i.viewingStage ?? null, i.staffBefore);
  const out: DateKindReading[] = [];
  for (const c of clauses) {
    const m = c.match(DATE_EXPR_RE);
    const tod = timeOfDayOf(c);
    if (!m && !tod) continue;
    if (THANKS_ONLY_RE.test(c) && !/希望|お願い|可能|空いて|いけ|行け|[?？]/.test(c)) continue;
    if (!ASKISH_RE.test(c) && !explicitKindOf(c)) continue;
    // 済んだ事の報告（「本日内覧に行ってきた」）は日付の希望でも約束でもない
    if (PAST_REPORT_RE.test(c)) continue;
    const base = { dateText: m ? m[0].replace(/\s+/g, "") : null, timeOfDay: tod ?? (m ? turnTime : null), staffAskedMoveIn };
    const ex = explicitKindOf(c);
    if (ex) { out.push({ kind: ex, source: "explicit", ...base, reason: "文の中の語" }); continue; }
    if (turnKinds.size === 1) { out.push({ kind: [...turnKinds][0], source: "turn", ...base, reason: "同じ番の別の文の語" }); continue; }
    if (open) { out.push({ kind: "viewing", source: "flow", ...base, reason: staffAskedMoveIn ? "内覧の日程の調整中（直前の一文に『ご入居』があるが主の流れは内覧の日程）" : "内覧の日程の調整中" }); continue; }
    if (staffAskedMoveIn) { out.push({ kind: "move_in", source: "staff_question", ...base, reason: "こちらが直前に入居の時期を聞いた" }); continue; }
    out.push({ kind: "unknown", source: "none", ...base, reason: "決める手がかり無し" });
  }
  return out;
}

// ─── ② 確認の相手（主語） ───────────────────────────────────────────────
export type ConfirmParty = "staff" | "management" | "customer";
export const CONFIRM_PARTY_JA: Record<ConfirmParty, string> = { staff: "スモラのスタッフ（自社で決める）", management: "管理会社・オーナー（外に確かめる）", customer: "お客様ご自身" };
export type ConfirmTopic = "viewing_datetime" | "estimate" | "pickup" | "vacancy" | "move_in_available" | "pet" | "negotiation" | "occupancy" | "facility" | "customer_schedule";
export const CONFIRM_TOPIC_JA: Record<ConfirmTopic, string> = {
  viewing_datetime: "内覧の日時", estimate: "御見積書の作成", pickup: "お部屋のピックアップ", vacancy: "募集状況", move_in_available: "入居可能日・退去予定",
  pet: "ペットの可否", negotiation: "条件の交渉", occupancy: "入居の人数・名義", facility: "資料に無い設備", customer_schedule: "お客様のご予定・ご家族との相談",
};
export const CONFIRM_TOPIC_PARTY: Record<ConfirmTopic, ConfirmParty> = {
  viewing_datetime: "staff", estimate: "staff", pickup: "staff",
  vacancy: "management", move_in_available: "management", pet: "management", negotiation: "management", occupancy: "management", facility: "management",
  customer_schedule: "customer",
};
/** 話題の網（強い順・管理会社に聞く物を先に見る＝「退去予定のお部屋の内覧はいつから」は入居可能日） */
const TOPIC_RES: Array<[ConfirmTopic, RegExp]> = [
  ["move_in_available", /入居可能|いつから(?:の)?(?:入居|住め)|退去予定|空き予定|内覧(?:開始|可能)日|いつから(?:内覧|内見|見れ|見られ)/],
  ["vacancy", /空いて(?:ます|いますか|る|ますか)|空室|募集(?:中|して)|まだ(?:あり|空)|埋ま/],
  ["pet", /ペット|犬|猫|小型犬/],
  ["negotiation", /値下げ|値引|交渉|安く(?:なり|でき)|下げ(?:られ|れ)|フリーレント|礼金(?:なし|ゼロ|0)/],
  ["occupancy", /二人入居|2人入居|同棲|ルームシェア|法人|名義|友人と/],
  ["facility", /楽器|ピアノ|駐車場|駐輪|バイク置|宅配ボックス|ネット(?:回線|環境)|光回線/],
  ["viewing_datetime", /(?:内覧|内見|見学|ご案内|案内)[^。！!？?\n]{0,16}(?:可能|空いて|でき|いけ|行け|日|時|朝|午前|午後|夕方|夜)|(?:朝方|午前|午後|夕方|[0-9]{1,2}\s*時)[^。！!？?\n]{0,12}(?:空いて|可能|いけ|行け|でき|どう|ない)|(?:もう少し|もっと)先の日|(?:他|別)の(?:日|お日にち|日程|時間)/],
  ["estimate", /見積|初期費用(?:を|の)?(?:出し|教え|いくら)/],
  ["pickup", /(?:他|別)の(?:物件|お部屋|部屋)|探して|ピックアップ|ありませんか|ないですか/],
  ["customer_schedule", /(?:家族|親|彼氏|彼女|夫|妻|旦那|嫁|パートナー)[^。！!？?\n]{0,8}(?:相談|確認|聞いて)|(?:予定|シフト|スケジュール)[^。！!？?\n]{0,8}(?:確認|分かり|わかり)/],
];
export function confirmTopicsOf(text: string | null | undefined): ConfirmTopic[] {
  const t = N(text);
  const out: ConfirmTopic[] = [];
  for (const [k, re] of TOPIC_RES) if (re.test(t) && !out.includes(k)) out.push(k);
  // 設備の費用の問い（「駐車場代は＋11,000円ですか」）は送った見積・資料で答える事＝管理会社に聞く設備の有無にしない（YUMA3 q140）
  const res = out.filter((k) => !(k === "facility" && /代|料金|円|費用|プラス|込み|含ま|足さ|加算/.test(t)));
  // 内覧の日時の網は「入居可能日」と重なる（「いつから内覧」）＝入居可能日があれば内覧の日時は外す
  if (res.includes("move_in_available")) return res.filter((k) => k !== "viewing_datetime");
  return res;
}

export type ConfirmPartyReading = { topic: ConfirmTopic; party: ConfirmParty };
/**
 * お客様の今の番の話題ごとに、答えを持っている相手。
 *   内覧の日程の調整中は、日付・時間帯だけの番（「朝方は空いてないでしょうか？」）も内覧の日時（スタッフ）にする（f44ca5c3・67f54c24）
 */
export function readConfirmParties(i: { customerText: string; staffBefore: readonly string[]; viewingStage?: ViewingFlowStage | null }): ConfirmPartyReading[] {
  let ts = confirmTopicsOf(i.customerText);
  // 日付・時間帯を内覧の日と読んだ番（何の日かの読み）は、内覧の日時（スタッフ）の話題を持つ
  const viewingDates = readDateKinds(i).filter((d) => d.kind === "viewing");
  if (viewingDates.length) {
    // 「空いて」は募集状況とも内覧の空きとも読める: 同じ文に日付・時間帯がある時だけ内覧の空き（「明日ってまだ空いてますか」「朝方は空いてないでしょうか」）
    const vacancyClauses = N(i.customerText).split(/[。\n！!？?]+/).filter((c) => /空いて|空き|空室|募集|埋ま/.test(c));
    if (vacancyClauses.length && vacancyClauses.every((c) => DATE_EXPR_RE.test(c) || !!timeOfDayOf(c))) ts = ts.filter((k) => k !== "vacancy");
    if (!ts.includes("viewing_datetime") && !ts.includes("move_in_available")) ts = ["viewing_datetime", ...ts];
  }
  return ts.map((topic) => ({ topic, party: CONFIRM_TOPIC_PARTY[topic] }));
}

// ─── 下書きの見張り（監査・出口の材料・決まった処理） ─────────────────────────────
/** 下書きの確認の約束の文（「確認させて頂きます」「確認出来次第ご連絡」） */
const CONFIRM_PROMISE_SENT_RE = /[^。！!？?\n]*(?:確認させて(?:頂|いただ)き|確認(?:出来|でき)次第|確認(?:いた|致)します|お調べ(?:いた|致)します)[^。！!？?\n]*/g;
export function draftConfirmPromiseSentences(draft: string | null | undefined): string[] {
  return N(draft).match(CONFIRM_PROMISE_SENT_RE)?.map((s) => s.trim()) ?? [];
}
/** 下書きの確認の約束が「スタッフが自分で決められる内覧の日時」を管理会社と同じ確認にしている（67f54c24 の外れの型） */
export function draftConfirmsOwnViewingTime(draft: string | null | undefined): boolean {
  const ss = draftConfirmPromiseSentences(draft);
  if (!ss.length) return false;
  const all = N(draft);
  return ss.some((s) => {
    const ctx = s.length < 24 ? all : s; // 「確認出来次第ご連絡させて頂きます」だけの文は前の文と合わせて見る
    return /(?:ご案内|ご内覧|内覧|内見|お時間|朝方|午前|午後|夕方)[^。！!？?\n]{0,16}(?:可能|でき|出来)[^。！!？?\n]{0,6}か|ご案内(?:可能な|できる|出来る)(?:お時間|日|お日にち)|(?:お日にち|日程|候補日?)(?:の候補)?(?:を|の)?(?:確認|お調べ)/.test(ctx)
      && !/(?:管理会社|オーナー|退去|募集|空き予定|入居|内覧開始|内覧可能日)/.test(ctx);
  });
}

/** 下書きが日付を何の日として書いたか（お客様の言った日付の言い方の近く・決まった処理） */
export function draftKindNearDate(draft: string | null | undefined, dateText: string | null): DateKind | null {
  if (!dateText) return null;
  const t = N(draft);
  const at = t.indexOf(dateText);
  if (at < 0) return null;
  const win = t.slice(Math.max(0, at - 12), at + dateText.length + 16);
  if (/入居|引っ?越|引越/.test(win)) return "move_in";
  if (/内覧|内見|ご案内|案内|見学/.test(win)) return "viewing";
  if (/連絡|ご返信|お返事/.test(win)) return "contact";
  return null;
}

/** お客様が自分で決めた連絡の期日（「今日中にまた連絡します」）を下書きがこちらから繰り返した（d9533aad の外れの型） */
export function draftEchoesCustomerDeadline(customerText: string, draft: string | null | undefined): boolean {
  const c = N(customerText);
  if (!/(?:今日中|本日中|今日|本日)[^。！!？?\n]{0,16}(?:連絡|返信|返事|お返事|お伝え)/.test(c) || !CONTACT_RE.test(c)) return false;
  return /今日中|本日中|本日|今日/.test(N(draft));
}

// ─── 材料の文（ブレイン・書く役で同じ文） ─────────────────────────────────────
export type DaySubjectReading = { dates: DateKindReading[]; parties: ConfirmPartyReading[] };
export function readDaySubject(msgsOldestFirst: ReadonlyArray<ReaderMsg>, viewingStage?: ViewingFlowStage | null): DaySubjectReading {
  const { customer, staffBefore } = splitTurn(msgsOldestFirst);
  if (!customer.trim()) return { dates: [], parties: [] };
  return {
    dates: readDateKinds({ customerText: customer, staffBefore, viewingStage }),
    parties: readConfirmParties({ customerText: customer, staffBefore, viewingStage }),
  };
}

/**
 * ブレイン・書く役に渡す短い注記（取り違えが起きる所だけ・無ければ ""）。
 * 2026-10-21 改（YUMA3 の on で依頼の抜け・道の外れ）: 旧は読めた物を全部「【何の日か・確認の相手】」の別の塊で最大6行出し、
 *   ①q140「駐車場代は＋11,000円ですか」を『資料に無い設備＝管理会社に聞く事（分からなければ確認の約束）』と書いてブレインが答えずに確認へ寄った
 *   ②q049「18日の内覧のあとに行けるか」（決まった事＝返信）に『内覧の日時は AIX で中身を入れて送る』を出して AIX【内覧へ】に寄った
 *   ③q177 も話題の網（設備・ピックアップ）の行だけで依頼が抜けた
 *   → 文の語だけで決まる物（入居・振込・申込・内覧の語がある日付）と、話題の網だけの確認の相手（管理会社・スタッフ）は何も足さない
 *     （ブレインが元から読める・足すと注意が依頼から逸れる）。直前の問いだけで読む入居の時期も足さない
 *     （流れの段が無い時に内覧の日を入居と書く向きの外れになる）。出すのは
 *     ・内覧の日程の調整中で語の無い日付・時間帯（主の流れで読む＝q190・q191 の型）
 *     ・お客様が自分で決めた連絡の期日（受けの中身も一緒に・d9533aad）
 *     ・お客様ご自身が確かめる事
 *     の最大2行で、お客様の言葉に結ぶ（別の見出しの塊にしない）。
 */
export function buildDaySubjectNote(r: DaySubjectReading): string {
  const lines: string[] = [];
  let flowSaid = false;
  for (const d of r.dates) {
    const what = `${d.dateText ?? ""}${d.timeOfDay ? `${d.dateText ? "・" : ""}${TIME_OF_DAY_JA[d.timeOfDay]}` : ""}`;
    if (!what) continue;
    if (d.kind === "viewing" && d.source === "flow") {
      if (flowSaid) continue;
      flowSaid = true;
      lines.push(`・お客様の「${what}」は内覧の日程の調整への答え${d.staffAskedMoveIn ? "（入居の時期ではない）" : ""}＝内覧の日時はスモラのカレンダーで決める事（確認の約束にせず内覧の流れの AIX で返す）`);
    } else if (d.kind === "contact") {
      lines.push(`・お客様の「${what}…連絡します」は、ごゆっくり・気になる点があれば何時でもご連絡を、で受ける（期日「本日・今日中」はこちらから繰り返さない）`);
    }
  }
  for (const p of r.parties) {
    if (p.party === "customer") lines.push(`・${CONFIRM_TOPIC_JA[p.topic]}はお客様ご自身が確かめる事（こちらが確認する約束にしない）`);
  }
  if (!lines.length) return "";
  return `\n${[...new Set(lines)].slice(0, 2).join("\n")}`;
}

/** 切り替えつき（off の時は必ず ""） */
export function daySubjectNoteIfEnabled(msgsOldestFirst: ReadonlyArray<ReaderMsg>, viewingStage?: ViewingFlowStage | null, env?: Record<string, string | undefined>): string {
  if (!daySubjectReaderEnabled(env)) return "";
  // 読みの失敗でブレイン・書く役を止めない（注記が無いだけにする）
  try { return buildDaySubjectNote(readDaySubject(msgsOldestFirst ?? [], viewingStage)); }
  catch (e) { console.warn("[day-subject] read failed", e instanceof Error ? e.message : e); return ""; }
}
