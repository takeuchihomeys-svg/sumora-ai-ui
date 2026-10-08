// app/lib/staff-writer.ts — スタッフの送信の書き手（竹内さん／従業員）を決める（純関数・2026-10-08）
//   竹内「竹内のLINEか従業員のLINEかで考える方がかなり分析の質が変わる」
//   返信の書き方の基準は竹内さん（設計知見 22802738・P1）。messages に送信者の列が無かったので、
//   これからは送った端末（staff_devices）・グループの発言者（speaker_user_id）で決め、取れない過去の通だけ文の癖で埋める。
//
//   ⚠ 名乗り（「鈴木と申します」「代表の竹内」）は使わない（竹内「竹内でも鈴木って名乗っているため」10/08）。
//   ⚠ 目的の形（呼び名の後の改行・何卒・開口語の絵文字）は手掛かりに使わない（それを測る監査が自分の答えを見てしまう）。
//   ⚠ 時刻も使わない（「従業員は平日10〜21時」を確かめる側に回すため）。
//   出所: scripts/lib/r8-style-targets.ts の writerScore（8巡目）をここへ移した（向きも重みも同じ）。

import { isMaterialOnlyText } from "./daily-greeting"; // import なしの純関数（循環なし）

export type StaffWriter = "takeuchi" | "employee";
/** sure＝確か／likely＝たぶん／unknown＝不明 */
export type WriterConfidence = "sure" | "likely" | "unknown";
/** 何で決めたか（強い順）: device＝送った端末・group_speaker＝グループの発言者・manual＝人が付けた・style＝文の癖・style_context＝同じ会話の近くの通 */
export type WriterSource = "device" | "group_speaker" | "manual" | "style" | "style_context";
export type WriterLabel = { writer: StaffWriter | null; confidence: WriterConfidence; score: number; cues: string[] };

export type WriterCue = { key: string; writer: StaffWriter; re: RegExp };
/**
 * 文の癖の手掛かり（表記の好み・1回ごとに1点）。A＝竹内さん（漢字の表記）／B＝従業員（かなの表記）。
 * 検算は scripts/audit-staff-writer.ts（その手掛かりを除いて決まった通で、同じ向きに出る割合）。
 * 「ござ」は 8巡目に B の手掛かりにしていたが外した（10/08 実測: 従業員がいない時間＝夜21〜朝10時の手打ち 591通で 18%・平日昼 20%
 *   ＝竹内さんも「ございます」と打つ）。夜の手打ちでの率: 頂 76%・致し 31%・出来 37%／いただ 9%・いたし 2%・でき 9%。
 */
export const WRITER_CUES: WriterCue[] = [
  { key: "頂", writer: "takeuchi", re: /頂/g },
  { key: "致し", writer: "takeuchi", re: /致し/g },
  { key: "如何", writer: "takeuchi", re: /如何/g },
  { key: "御座", writer: "takeuchi", re: /御座/g },
  { key: "出来", writer: "takeuchi", re: /出来/g },
  { key: "いただ", writer: "employee", re: /いただ/g },
  { key: "いたし", writer: "employee", re: /いたし/g },
  { key: "いかが", writer: "employee", re: /いかが/g },
  { key: "〜でき", writer: "employee", re: /(?:確認|ご用意|ご案内|お送り|作成)でき/g },
];

const count = (s: string, re: RegExp) => (s.match(new RegExp(re.source, "g")) ?? []).length;

/**
 * 文の癖で書き手を決める。
 *   確か: 片方の手掛かりだけが2つ以上 ／ たぶん: 差が1以上（反対の手掛かりが混ざる時も含む）／ 不明: 差が0
 *   exclude: 検算のために外す手掛かり（key）
 */
export function writerFromText(text: string | null | undefined, opts: { exclude?: string[]; includeMaterial?: boolean } = {}): WriterLabel {
  const s = String(text ?? "");
  // 資料文（🌟物件カード・【】見積の本体・室内イメージの URL）は道具が作る文＝書き手の癖が出ない（10/08: 手打ちに見えた 🌟カードが
  //   全部「頂・出来」で A に寄っていた）。押した人は端末・文脈で決める
  if (!opts.includeMaterial && isMaterialOnlyText(s)) return { writer: null, confidence: "unknown", score: 0, cues: ["資料文"] };
  let a = 0, b = 0; const cues: string[] = [];
  for (const c of WRITER_CUES) {
    if (opts.exclude?.includes(c.key)) continue;
    const n = count(s, c.re); if (!n) continue;
    cues.push(`${c.key}×${n}`);
    if (c.writer === "takeuchi") a += n; else b += n;
  }
  const score = a - b;
  if (score === 0) return { writer: null, confidence: "unknown", score, cues };
  const writer: StaffWriter = score > 0 ? "takeuchi" : "employee";
  const sure = Math.abs(score) >= 2 && (score > 0 ? b === 0 : a === 0);
  return { writer, confidence: sure ? "sure" : "likely", score, cues };
}

/** 8巡目の監査（scripts/lib/r8-style-targets）と同じ形の A/B/? */
export const writerLetter = (l: WriterLabel): "A" | "B" | "?" => (l.writer === "takeuchi" ? "A" : l.writer === "employee" ? "B" : "?");

/**
 * 文の癖で決まらない通を、同じ会話の近くの通（前後 windowMs 以内・文の癖で決まった通だけ）から埋める。
 *   前後で一番近い通がどちらも同じ書き手（片方しか無い時はその1つ）→ たぶん。食い違う → 不明。
 *   連鎖させない（埋めた通を次の材料にしない）。
 */
export function writerFromContext(
  at: number,
  neighbors: Array<{ at: number; label: WriterLabel }>,
  windowMs = 3 * 3600_000,
): WriterLabel {
  const dec = neighbors.filter((n) => n.label.writer && n.label.confidence !== "unknown" && Math.abs(n.at - at) <= windowMs && n.at !== at);
  const before = dec.filter((n) => n.at < at).sort((x, y) => y.at - x.at)[0];
  const after = dec.filter((n) => n.at > at).sort((x, y) => x.at - y.at)[0];
  const ws = [before, after].filter(Boolean).map((n) => n!.label.writer);
  if (!ws.length || new Set(ws).size > 1) return { writer: null, confidence: "unknown", score: 0, cues: [] };
  return { writer: ws[0], confidence: "likely", score: 0, cues: ["文脈"] };
}

/** 端末の書き手の対応（staff_devices.writer）・グループの発言者の LINE ID の対応から決める（確か） */
export function writerFromIdentity(input: {
  deviceWriter?: string | null;
  speakerUserId?: string | null;
  takeuchiLineIds?: string[];
  employeeLineIds?: string[];
}): { writer: StaffWriter; source: WriterSource } | null {
  const d = input.deviceWriter;
  if (d === "takeuchi" || d === "employee") return { writer: d, source: "device" };
  const sp = input.speakerUserId ?? "";
  if (sp && input.takeuchiLineIds?.includes(sp)) return { writer: "takeuchi", source: "group_speaker" };
  if (sp && input.employeeLineIds?.includes(sp)) return { writer: "employee", source: "group_speaker" };
  return null;
}

/** 分析での使い方の線: 竹内さんの送信は書き方も中身も正解／従業員は中身（道・事実・AIX の番）だけ／不明は従来どおり（混ぜる） */
export type WriterUse = "style_and_content" | "content_only" | "legacy";
export function writerUse(writer: StaffWriter | null | undefined, confidence?: WriterConfidence | null): WriterUse {
  if (writer === "takeuchi" && confidence !== "unknown") return "style_and_content";
  if (writer === "employee" && confidence !== "unknown") return "content_only";
  return "legacy";
}

/**
 * 表記を竹内さんの形に直す（決定論の置換・中身は変えない）。従業員の直しから学んだナレッジの文を竹内さんの書き方に揃える時に使う。
 *   対象は竹内さんの手打ちで 9割以上が片方に寄っている表記だけ（10/08 端末で竹内さんと決まった手打ち 573通 × 従業員 1,100通で数えた）:
 *     いただ→頂（370:12）・いたし→致し（102:1）・いかが→如何・お見積書→御見積書（77:2）・お申し込み→お申込み（44:4）・おすすめ／おススメ→オススメ（136:0）・
 *     でき次第／できる限り→出来次第／出来る限り（18:0・12:0）・〜でき（確認・ご用意・ご案内・お送り・作成・オススメ）→出来・下さい→ください（0:216）・
 *     呼び名の後の改行を取る（竹内さん 7/573＝1%・従業員 267/1100）
 *   「事が出来／ことができ」（40:20）・「ございます」（竹内さんも打つ）・絵文字・！の数は触らない（割れている物は直さない）。
 */
export function toTakeuchiNotation(text: string): string {
  return String(text ?? "")
    .replace(/^([^\n、。！!？?]{1,15}(?:さん|様))[ \t]*\n+/, "$1")
    .replace(/いただ/g, "頂")
    .replace(/いたし/g, "致し")
    .replace(/いかが/g, "如何")
    .replace(/お見積書/g, "御見積書")
    .replace(/お申し込み/g, "お申込み")
    .replace(/おすすめ|おススメ/g, "オススメ")
    .replace(/でき次第/g, "出来次第")
    .replace(/できる限り/g, "出来る限り")
    .replace(/(確認|ご用意|ご案内|お送り|作成|オススメ)でき/g, "$1出来")
    .replace(/下さい/g, "ください");
}

/** 書き手で分けるのを止める（旧に戻す）: STAFF_WRITER_SPLIT=off */
export function staffWriterSplitEnabled(): boolean {
  return (process.env.STAFF_WRITER_SPLIT ?? "on").toLowerCase() !== "off";
}

/**
 * 定型の文の骨（呼び名・挨拶・数字を外した頭 16字）。同じ骨が多くの会話に出る文＝昔の AIX・定型文の出力（記録の無い頃の物）で、
 *   書き手の癖ではなく作った人（竹内さん）の表記になる → 文の癖では決めず、押した人は文脈で決める。
 *   10/08 実測: 「〇〇さんお待たせ致しました！！⏎⏎…ピックアップさせて頂きました」の直後に同じ人が「…させていただきました」と打っていた。
 */
export function cannedSkeleton(text: string | null | undefined): string {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/^[^\n、！!。？?]{1,14}(?:さん|様)[、,\s]*/, "")
    .replace(/^(?:お世話になっております|お世話になります|お待たせ(?:致|いた)しました)[\p{Extended_Pictographic}\u{FE0F}！!。\s]*/u, "")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\s！!。、,・]/gu, "")
    .replace(/[0-9０-９]+/g, "#")
    .slice(0, 16);
}
/** 定型とみなす線: 同じ骨が出る会話の数 */
export const CANNED_MIN_CONVERSATIONS = 4;

/**
 * 人ではなく前の自動返信が sender=staff で送っていた期間（JST）。書き手の判定・人の書き方の監査から外す。
 *   5/17〜5/23: 前の自動返信（8巡目の監査で外していた線）／8/16〜8/17: お盆の自動返信（🙇・「〜ですね」・夜中の長文・10/08 に見つけた）
 */
export const AUTO_REPLY_PERIODS_JST: Array<[string, string]> = [
  ["2026-05-17", "2026-05-24"],
  ["2026-08-16", "2026-08-18"],
];
export function inAutoReplyPeriod(iso: string): boolean {
  const d = new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 10);
  return AUTO_REPLY_PERIODS_JST.some(([a, b]) => d >= a && d < b);
}

/**
 * AI の下書きを直して送った通の書き手: 送った文の手掛かりから下書きにあった分を引いた「直した所」だけで決める。
 *   下書きの「頂き」をそのまま残しただけでは竹内さんの証拠にしない（10/08: 下書きそのままの送信は 88% が A の表記＝下書き自体が A の書き方）。
 *   下書きに無い手掛かりが無い（＝表記を触っていない）時は不明。
 */
export function writerFromEdit(draft: string | null | undefined, sent: string | null | undefined): WriterLabel {
  const d = String(draft ?? ""), s = String(sent ?? "");
  let a = 0, b = 0; const cues: string[] = [];
  for (const c of WRITER_CUES) {
    const n = count(s, c.re) - count(d, c.re); if (n <= 0) continue;
    cues.push(`${c.key}+${n}`);
    if (c.writer === "takeuchi") a += n; else b += n;
  }
  const score = a - b;
  if (score === 0) return { writer: null, confidence: "unknown", score, cues };
  const writer: StaffWriter = score > 0 ? "takeuchi" : "employee";
  const sure = Math.abs(score) >= 2 && (score > 0 ? b === 0 : a === 0);
  return { writer, confidence: sure ? "sure" : "likely", score, cues };
}

/**
 * 見張りの番の返事のまとまりの書き手（下書き × 送った文）。直した所の表記で決め、無ければ送った文全体の「確か」だけ。
 *   messages.staff_writer（端末・グループの発言者）が入るようになったら、呼び出し側でそちらを先に使う。
 */
export function staffWriterOfBurst(draft: string | null | undefined, sent: string | null | undefined): { writer: StaffWriter | null; confidence: WriterConfidence; source: string } | null {
  if (!String(sent ?? "").trim()) return null;
  if (draft) { const e = writerFromEdit(draft, sent); if (e.writer) return { writer: e.writer, confidence: e.confidence, source: "style_edit" }; }
  const t = writerFromText(sent);
  return t.writer && t.confidence === "sure" ? { writer: t.writer, confidence: t.confidence, source: "style" } : null;
}

/**
 * 手本（ai_reply_examples）の並びを書き手で: 竹内さん → 不明 → 従業員 の順に安定して並べ替える（同じ書き手の中の順は保つ・捨てない）。
 *   手本の文は送った文そのもの＝書き方を真似される → 書き方の基準の竹内さんを先に。STAFF_WRITER_EXAMPLES=off／STAFF_WRITER_SPLIT=off で並べ替えない。
 *   10/08 実測: line_reply の手本 1,866 件で 竹内 1,233（確か 851）・従業員 286・不明 347／★ 889 件で 竹内 650・従業員 72
 */
export function sortExamplesByWriter<T extends { sent_reply?: string | null; staff_writer?: string | null }>(list: ReadonlyArray<T>): T[] {
  if (!staffWriterSplitEnabled() || (process.env.STAFF_WRITER_EXAMPLES ?? "on").toLowerCase() === "off") return [...list];
  const rank = (x: T) => {
    const w = x.staff_writer === "takeuchi" || x.staff_writer === "employee" ? x.staff_writer : writerFromText(x.sent_reply).writer;
    return w === "takeuchi" ? 0 : w === "employee" ? 2 : 1;
  };
  return list.map((x, i) => ({ x, i, r: rank(x) })).sort((a, b) => a.r - b.r || a.i - b.i).map((o) => o.x);
}
