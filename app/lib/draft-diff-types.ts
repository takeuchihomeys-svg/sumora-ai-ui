// app/lib/draft-diff-types.ts — 「AI の下書き × スタッフが実際に送った文」の直しを、中身の型に分ける（純関数・LLM なし・本番の動きは変えない）
//
// なぜ（2026-10-20 P0 竹内さんの方法「弱い所を型で数えて根本から直す」「直された下書きの学び」「差分」）:
//   text-diff-types.ts は文の表面の差（！・絵文字・改行・表記）と「足した／消した文」までは分けるが、
//   「何を足したか（答え・約束・内覧の誘い・申込の誘い・挨拶・名前）」「何を消したか（ご査収・かしこまりました・違う事実・スタッフだけが知る事・違う日付・違う物件）」
//   が出ない。直す場所（ブレイン・会社の事実・書く役の決まり・出口の確かめ）は中身の型ごとに違うので、ここで中身の型に分けて数える。
//   使う所: scripts/audit-draft-diff-types.ts（見張り line_watch_turns の下書き × 送った文・場面ごとに数える）
//
// 1組の分け方:
//   主の型（1つ）: no_draft｜unchanged｜trivial｜rewritten_tone｜replaced｜content_edit
//   中身の型（content_edit の時・複数）: added:<kind>｜removed:<kind>
import { coreOf, dice, sentencesOf, isStaffOnlyReport } from "./text-diff-types";

export const PRIMARY_TYPES = ["no_draft", "unchanged", "trivial", "rewritten_tone", "replaced", "content_edit"] as const;
export type PrimaryType = (typeof PRIMARY_TYPES)[number];

export const ADDED_KINDS = ["staff_only", "promise", "invite_viewing", "invite_apply", "ask", "request", "answer", "empathy", "closing", "greeting", "name", "other"] as const;
export const REMOVED_KINDS = ["gosashu", "kashikomari", "staff_only", "wrong_date", "wrong_property", "wrong_fact", "promise", "invite_viewing", "invite_apply", "ask", "answer", "empathy", "closing", "greeting", "name", "other"] as const;
export type AddedKind = (typeof ADDED_KINDS)[number];
export type RemovedKind = (typeof REMOVED_KINDS)[number];
export type ContentType = `added:${AddedKind}` | `removed:${RemovedKind}`;

export const PRIMARY_JA: Record<PrimaryType, string> = {
  no_draft: "下書きなし", unchanged: "そのまま", trivial: "小さな直し（表面だけ）", rewritten_tone: "言い回しの書き直し（中身は同じ）",
  replaced: "丸ごと差し替え", content_edit: "中身の足し引き",
};
export const CONTENT_JA: Record<ContentType, string> = {
  "added:staff_only": "足した: スタッフだけが知る事（確認の結果 等）", "added:promise": "足した: 約束（確認します・お送りします）",
  "added:invite_viewing": "足した: 内覧の誘い", "added:invite_apply": "足した: 申込の誘い", "added:answer": "足した: 答え（言い切り）",
  "added:ask": "足した: 聞き返し（希望・日程を聞く）", "added:request": "足した: お客様への依頼（お送りください・ご入力ください）", "added:empathy": "足した: 受け止め・支える一言", "added:closing": "足した: 締め（お気軽に・よろしく）",
  "added:greeting": "足した: 挨拶・お礼", "added:name": "足した: 名前の呼びかけ", "added:other": "足した: その他",
  "removed:gosashu": "消した: ご査収", "removed:kashikomari": "消した: かしこまりました／承知", "removed:staff_only": "消した: スタッフだけが知る事（AI が言い切った）",
  "removed:wrong_date": "消した/直した: 違う日付・時刻", "removed:wrong_property": "消した/直した: 違う物件・号室", "removed:wrong_fact": "消した/直した: 違う数字・事実",
  "removed:promise": "消した: 約束", "removed:invite_viewing": "消した: 内覧の誘い", "removed:invite_apply": "消した: 申込の誘い",
  "removed:ask": "消した: 聞き返し", "removed:answer": "消した: 答え（言い切り）", "removed:empathy": "消した: 受け止め・支える一言・決意",
  "removed:closing": "消した: 締め（お待ちしております・お気軽に）", "removed:greeting": "消した: 挨拶・お礼", "removed:name": "消した: 名前の呼びかけ", "removed:other": "消した: その他",
};

// ── 語の網（文1つに当てる）──
const PROMISE_RE = /(?:確認|お調べ|お探し|探さ|ピックアップ|お送り|送付|ご連絡|ご案内|手配|お伝え|共有)(?:させて|致し|いたし|して)?(?:頂|いただ)?(?:き|け)?(?:ます|ますね|しますね)|次第|後ほど|改めて(?:ご連絡|お送り)|本日中|明日中/;
const INVITE_VIEWING_RE = /(?:ご)?内覧|(?:ご)?内見|見学|ご案内(?:可能|出来|でき|させ)/;
const INVITE_ASK_RE = /いかが|如何|でしょうか|ませんか|可能です|出来ます|できます|お気軽|ぜひ|是非|お越し|お気に召され|よろしければ|宜しければ|ご都合/;
const INVITE_APPLY_RE = /(?:お)?申込|(?:お)?申し込み|仮押さえ|お手続き/;
const GREETING_RE = /お世話になっております|お世話になります|ありがとうございます|有難うございます|お疲れ様|失礼(?:致|いた)します/;
const ASK_RE = /(?:でしょうか|ますか|ですか|ませんか)(?:[？?!！]|[p{Extended_Pictographic}️]|$)|お聞かせ|教えて(?:頂|いただ|くださ|下さ)/u;
const EMPATHY_RE = /受け止め|お気持ち|ご安心|全力|最善|精一杯|お力にな|寄り添|ご心配|ご不安|嬉しい|うれしい|残念|お悩み|大変(?:でした|ですね|恐縮)|お役に立て/;
const CLOSING_RE = /お待ちしております|お気軽に|何時でも|いつでも|ご連絡(?:ください|下さい)|よろしくお願い|宜しくお願い/;
/** 画像・動画・スタンプの置き場所（文に数えない） */
export const MEDIA_ONLY_RE = /^\[(?:画像|動画|スタンプ|ファイル|音声)\]$/;
const NAME_RE = /^[^\s、。！!？?]{1,14}(?:さん|様)(?:[、,！!\s]|$)/;
const ANSWER_RE = /(?:です|ございます|となります|可能|大丈夫|問題(?:ござい|あり)ません|かかります|不要|必要|出来ます|できます|ありません|ないです|(?:ます|ません)(?:[！!。]|[p{Extended_Pictographic}️]|$))/u;
/** お客様への依頼（お送りください・ご入力ください・ご確認ください） */
const REQUEST_RE = /(?:お送り|ご入力|ご確認|ご査収|ご記入|ご提出|ご用意|お知らせ|ご返信|ご回答)(?:頂|いただ)?(?:ください|下さい|頂けますと|いただけますと|願います)/;
const GOSASHU_RE = /ご査収/;
const KASHIKOMARI_RE = /かしこまりました|承知(?:いた|致)?しました/;
// 日付・時刻（数字の付いた物だけ。「明日」等の語は日付の取り違えに数えない）
const DATE_RE = /\d{1,2}\s*[\/月]\s*\d{1,2}|\d{1,2}\s*日|\d{1,2}\s*[:：時]\s*\d{0,2}|[月火水木金土日]曜/g;
// 物件・号室（号室・番の数字、物件名の型）
const PROPERTY_RE = /\d{2,4}\s*号室?|[ァ-ヶー]{3,}(?:\s*[ァ-ヶーA-Za-z0-9]*)?(?=\s*\d{2,4}\s*号|\s*(?:様|さん)?の(?:お部屋|物件))|[一-龠ァ-ヶー]{2,}(?:マンション|ハイツ|コーポ|レジデンス|ハウス|荘)/g;
const NUMBER_RE = /\d+(?:\.\d+)?/g;

const n = (t: string) => String(t ?? "").normalize("NFKC").replace(/,/g, "");
const setOf = (t: string, re: RegExp) => new Set((n(t).match(re) ?? []).map((x) => x.replace(/\s/g, "")));
const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

export function addedKindOf(sentence: string): AddedKind {
  const s = n(sentence).trim();
  if (isStaffOnlyReport(s)) return "staff_only";
  if (NAME_RE.test(s) && coreOf(s).length <= 16) return "name";
  if (INVITE_VIEWING_RE.test(s) && INVITE_ASK_RE.test(s)) return "invite_viewing";
  if (INVITE_APPLY_RE.test(s) && INVITE_ASK_RE.test(s)) return "invite_apply";
  if (REQUEST_RE.test(s)) return "request";
  if (PROMISE_RE.test(s)) return "promise";
  if (ASK_RE.test(s)) return "ask";
  if (EMPATHY_RE.test(s)) return "empathy";
  if (CLOSING_RE.test(s)) return "closing";
  if (GREETING_RE.test(s) && coreOf(s).length <= 30) return "greeting";
  if (ANSWER_RE.test(s)) return "answer";
  return "other";
}
export function removedKindOf(sentence: string): RemovedKind {
  const s = n(sentence).trim();
  if (GOSASHU_RE.test(s)) return "gosashu";
  if (isStaffOnlyReport(s)) return "staff_only";
  if (KASHIKOMARI_RE.test(s) && coreOf(s).length <= 20) return "kashikomari";
  if (NAME_RE.test(s) && coreOf(s).length <= 16) return "name";
  if (INVITE_VIEWING_RE.test(s) && INVITE_ASK_RE.test(s)) return "invite_viewing";
  if (INVITE_APPLY_RE.test(s) && INVITE_ASK_RE.test(s)) return "invite_apply";
  if (PROMISE_RE.test(s)) return "promise";
  if (ASK_RE.test(s)) return "ask";
  if (EMPATHY_RE.test(s)) return "empathy";
  if (CLOSING_RE.test(s)) return "closing";
  if (GREETING_RE.test(s) && coreOf(s).length <= 30) return "greeting";
  if (ANSWER_RE.test(s)) return "answer";
  return "other";
}

export type DraftDiff = {
  primary: PrimaryType;
  content: ContentType[];           // 重なりなし・決まった順
  sim: number;                      // 芯の Dice（0〜1）
  added: Array<{ kind: AddedKind; text: string }>;
  removed: Array<{ kind: RemovedKind; text: string }>;
};

const FORMULA_ONLY_RE = /^(?:はい|かしこまりました|承知(?:いた|致)?しました|ありがとうございます|お世話になっております|[^\s、。！!]{1,14}(?:さん|様))$/;

/**
 * 下書き draft と送った文 sent を分ける。draft が空（null・空白）は no_draft。
 * 決まり:
 *   unchanged … 前後の空白を除いて同じ
 *   trivial … 芯（絵文字・記号・空白・表記の揺れを除いた物）が同じ、または芯の似ている度 ≥0.92 かつ文の足し引きが無い
 *   replaced … 芯の似ている度 <0.3 かつ下書きの文の 3 割未満しか送った文に残っていない
 *   rewritten_tone … 文の足し引きが無く、言い換えだけ（並べた文はすべて対になる）
 *   content_edit … それ以外（足した／消した文・数字や日付や物件の違い）
 */
export function classifyDraftDiff(draftRaw: string | null | undefined, sentRaw: string | null | undefined): DraftDiff {
  const d = String(draftRaw ?? "").replace(/\r/g, "").trim(), s = String(sentRaw ?? "").replace(/\r/g, "").trim();
  const empty: DraftDiff = { primary: "no_draft", content: [], sim: 0, added: [], removed: [] };
  if (!d) return empty;
  if (d === s) return { ...empty, primary: "unchanged", sim: 1 };
  const cd = coreOf(d), cs = coreOf(s);
  const sim = Math.round(dice(cd, cs) * 100) / 100;

  // 文の対（貪欲・芯の Dice ≥0.45）
  const ds = sentencesOf(d), ss = sentencesOf(s);
  const cand: Array<{ di: number; si: number; v: number }> = [];
  ds.forEach((x, di) => ss.forEach((y, si) => { const v = dice(coreOf(x), coreOf(y)); if (v >= 0.45) cand.push({ di, si, v }); }));
  cand.sort((a, b) => b.v - a.v);
  const uD = new Set<number>(), uS = new Set<number>(); const pairs: Array<{ di: number; si: number; v: number }> = [];
  for (const c of cand) { if (uD.has(c.di) || uS.has(c.si)) continue; uD.add(c.di); uS.add(c.si); pairs.push(c); }

  const content = new Set<ContentType>();
  const added: DraftDiff["added"] = [], removed: DraftDiff["removed"] = [];
  // 文全体での有無（定型の1語だけの文も数えるため）
  if (GOSASHU_RE.test(d) && !GOSASHU_RE.test(s)) content.add("removed:gosashu");
  if (KASHIKOMARI_RE.test(d) && !KASHIKOMARI_RE.test(s)) content.add("removed:kashikomari");
  const firstLine = (t: string) => n(t).split(/\n/)[0].trim();
  if (NAME_RE.test(firstLine(s)) && !NAME_RE.test(firstLine(d))) content.add("added:name");
  if (NAME_RE.test(firstLine(d)) && !NAME_RE.test(firstLine(s))) content.add("removed:name");
  const gD = /お世話になっております|お世話になります/.test(d), gS = /お世話になっております|お世話になります/.test(s);
  if (gS && !gD) content.add("added:greeting");
  if (gD && !gS) content.add("removed:greeting");

  for (let i = 0; i < ds.length; i++) if (!uD.has(i) && !FORMULA_ONLY_RE.test(coreOf(ds[i])) && !MEDIA_ONLY_RE.test(ds[i].trim())) { const k = removedKindOf(ds[i]); removed.push({ kind: k, text: ds[i] }); content.add(`removed:${k}`); }
  for (let i = 0; i < ss.length; i++) if (!uS.has(i) && !FORMULA_ONLY_RE.test(coreOf(ss[i])) && !MEDIA_ONLY_RE.test(ss[i].trim())) { const k = addedKindOf(ss[i]); added.push({ kind: k, text: ss[i] }); content.add(`added:${k}`); }

  // 対になった文の中の事実の違い（日付 → 物件 → 数字の順・1対に1つ）
  for (const p of pairs) {
    const a = ds[p.di], b = ss[p.si];
    if (!sameSet(setOf(a, DATE_RE), setOf(b, DATE_RE)) && setOf(a, DATE_RE).size) { content.add("removed:wrong_date"); removed.push({ kind: "wrong_date", text: a }); continue; }
    if (!sameSet(setOf(a, PROPERTY_RE), setOf(b, PROPERTY_RE)) && setOf(a, PROPERTY_RE).size) { content.add("removed:wrong_property"); removed.push({ kind: "wrong_property", text: a }); continue; }
    if (!sameSet(setOf(a, NUMBER_RE), setOf(b, NUMBER_RE)) && setOf(a, NUMBER_RE).size) { content.add("removed:wrong_fact"); removed.push({ kind: "wrong_fact", text: a }); }
  }
  // 消した文の中の日付・物件で、送った文に無い物（文ごと消した取り違え）
  for (const r of removed) {
    if (r.kind !== "other" && r.kind !== "promise" && r.kind !== "answer") continue;
    const dd = [...setOf(r.text, DATE_RE)].filter((x) => !setOf(s, DATE_RE).has(x));
    const pp = [...setOf(r.text, PROPERTY_RE)].filter((x) => !setOf(s, PROPERTY_RE).has(x));
    if (dd.length && setOf(s, DATE_RE).size) content.add("removed:wrong_date");
    else if (pp.length && setOf(s, PROPERTY_RE).size) content.add("removed:wrong_property");
  }

  const kept = ds.length ? pairs.length / ds.length : 0;
  let primary: PrimaryType;
  if (cd === cs || (sim >= 0.92 && !added.length && !removed.length && ![...content].some((c) => /wrong_/.test(c)))) primary = "trivial";
  else if (sim < 0.3 && kept < 0.3) primary = "replaced";
  else if (!added.length && !removed.length && !content.size) primary = "rewritten_tone";
  else if (!added.length && !removed.length && [...content].every((c) => c === "removed:kashikomari" || c === "added:name" || c === "removed:name" || c === "added:greeting" || c === "removed:greeting")) primary = "rewritten_tone";
  else primary = "content_edit";
  const order = [...ADDED_KINDS.map((k) => `added:${k}`), ...REMOVED_KINDS.map((k) => `removed:${k}`)] as ContentType[];
  return { primary, content: order.filter((c) => content.has(c)), sim, added, removed };
}

/** 例を出す時の伏せ字（名前・数字・カタカナの語・〜マンション等）。出力は短く切る */
export function maskText(t: string, max = 70): string {
  const s = n(t).replace(/\n/g, " / ")
    .replace(/[^\s、。！!？?/]{1,14}(?=さん|様)/g, "○○")
    .replace(/https?:\/\/\S+/g, "〈リンク〉")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, "〈メール〉")
    .replace(/\d/g, "#")
    .replace(/[ァ-ヶー]{3,}/g, "＊＊")
    .replace(/[A-Za-z][A-Za-z\s.'&-]*/g, "＊＊")
    .replace(/[一-龠ァ-ヶー＊\s]{1,14}(?=#{2,4}\s*号)/g, "＊＊ ")
    .replace(/[一-龠]{1,8}(?=マンション|ハイツ|コーポ|レジデンス|ハウス|荘|駅|区|市|町)/g, "＊＊");
  const m = s.replace(/＊＊[一-龠々]{1,6}/g, "＊＊").replace(/[一-龠々]{1,6}＊＊/g, "＊＊");
  return m.length > max ? m.slice(0, max) + "…" : m;
}
