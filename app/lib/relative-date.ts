// app/lib/relative-date.ts
// 「明日」「明後日」などの相対の日を、日本時間の暦で絶対の日に直す（純関数・DB 依存なし）。
//
// 2026-09-15 竹内（yasuki 事例）「お客さん昨日の返信で明日と言っている。もう今日なので、明日入れない。日本時間基準に考える」:
//   お客様 9/15(月) 18:15「確認したい事がありますのでまた明日午前中に連絡させて頂きます。」→ こちらの返信は 9/16(火) 8:37。
//   下書き「明日午前中のご連絡お待ちしております😊！！」＝お客様の「明日」をそのまま写した（お客様の明日＝9/16＝今日）。
//   実データ（180日）: お客様が「明日」と言った後、同じ日に返信した55件ではスタッフも「明日」33件だが、
//   日をまたいだ9件では「明日」は0件（「本日」3件・日付に触れない6件）。
import { JST_OFFSET_MS, WEEKDAYS_JA, jstDayStartMs } from "@/app/lib/jst-date";

/** 相対の日の語 → 何日後か（日本時間の暦の日で数える） */
const RELATIVE_DAY_WORDS: ReadonlyArray<{ word: string; offset: number }> = [
  { word: "明々後日", offset: 3 },
  { word: "明明後日", offset: 3 },
  { word: "しあさって", offset: 3 },
  { word: "明後日", offset: 2 },
  { word: "あさって", offset: 2 },
  { word: "明日", offset: 1 },
  { word: "あした", offset: 1 },
  { word: "あす", offset: 1 },
  { word: "明朝", offset: 1 },
  // 「一昨日」を「昨日」より先に見る（先に「昨日」を置き換えると「一昨日」が壊れる）
  { word: "一昨日", offset: -2 },
  { word: "おととい", offset: -2 },
  { word: "昨日", offset: -1 },
  { word: "きのう", offset: -1 },
  { word: "本日", offset: 0 },
  { word: "今日", offset: 0 },
];
const DAY_MS = 86_400_000;
const pad2 = (n: number) => String(n).padStart(2, "0");

export type RelativeDayHit = { word: string; offset: number; dayStartMs: number };

/** 文中の相対の日の語を、その発言の時刻（日本時間）を起点に絶対の日へ。長い語を先に見る（明後日が「明日」で切れないように） */
export function resolveRelativeDays(text: string | null | undefined, atMs: number): RelativeDayHit[] {
  const t = text ?? "";
  const hits: RelativeDayHit[] = [];
  const taken: Array<[number, number]> = [];
  for (const { word, offset } of RELATIVE_DAY_WORDS) {
    let from = 0;
    for (;;) {
      const i = t.indexOf(word, from);
      if (i < 0) break;
      from = i + word.length;
      if (taken.some(([s, e]) => i < e && i + word.length > s)) continue;
      taken.push([i, i + word.length]);
      if (!hits.some((h) => h.word === word)) hits.push({ word, offset, dayStartMs: jstDayStartMs(atMs) + offset * DAY_MS });
    }
  }
  return hits;
}

/** 日本時間の「M/D（曜）」 */
export function jstDayLabel(dayStartMs: number): string {
  const d = new Date(dayStartMs + JST_OFFSET_MS);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEKDAYS_JA[d.getUTCDay()]}）`;
}

/**
 * その日を「今」から見て何と書くか。今日=本日／明日／明後日、それ以外の先の日は「M/D（曜）」、過ぎた日は null（日付に触れない）
 * ＝ 日をまたいだ9件のスタッフ実送信（本日3・日付に触れない6・明日0）に合わせる
 */
export function expressionForNow(dayStartMs: number, nowMs: number): string | null {
  const diff = Math.round((dayStartMs - jstDayStartMs(nowMs)) / DAY_MS);
  if (diff === 0) return "本日";
  if (diff === 1) return "明日";
  if (diff === 2) return "明後日";
  if (diff > 2) return jstDayLabel(dayStartMs);
  return null; // 過ぎた日
}

/** 生成の指示に入れる注記（お客様の言葉の「明日」が今から見て何か）。ズレが無ければ空文字 */
export function buildRelativeDayNote(customerText: string | null | undefined, customerAtMs: number, nowMs: number): string {
  const hits = resolveRelativeDays(customerText, customerAtMs);
  const lines: string[] = [];
  for (const h of hits) {
    const now = expressionForNow(h.dayStartMs, nowMs);
    if (now === h.word) continue; // 同じ日に返信＝そのままで正しい
    lines.push(now
      ? `・お客様の「${h.word}」＝${jstDayLabel(h.dayStartMs)}（お客様の発言の時点から数えた日）。今は${jstDayLabel(jstDayStartMs(nowMs))}なので、返信では「${now}」と書く（「${h.word}」とは書かない）`
      : `・お客様の「${h.word}」＝${jstDayLabel(h.dayStartMs)}で、今（${jstDayLabel(jstDayStartMs(nowMs))}）から見ると過ぎている。返信では日付の語を書かず「ご連絡お待ちしております」のように書く`);
  }
  if (lines.length === 0) return "";
  return `\n\n【📅 お客様の言葉の日付（日本時間・必ず直すこと）】\n${lines.join("\n")}`;
}

/** 待つ・受け取る文＝お客様の予告を受けた文（この文の中の相対の日だけ直す。こちらの新しい予定の「明日」は触らない） */
const AWAIT_SENTENCE_RE = /お待ち|(?:ご連絡|ご返答|ご返信|お電話|お写真|ご来店|ご案内|お送り)(?:を)?(?:お待ち|頂け|いただけ|下さ|ください)|(?:ご連絡|ご返答|ご返信|お電話)(?:を)?(?:くださ|下さ)/;

/**
 * 下書きの中の「お客様の言葉を写した相対の日」を、今から見た正しい言い方に直す。
 * 直すのは「待つ・受け取る文」だけ（こちらの新しい約束「明日一番で確認させて頂きます」は今から見た明日なので触らない）
 */
export function fixStaleRelativeDays(
  draft: string,
  customerText: string | null | undefined,
  customerAtMs: number,
  nowMs: number,
): { text: string; applied: string[] } {
  const hits = resolveRelativeDays(customerText, customerAtMs).filter((h) => expressionForNow(h.dayStartMs, nowMs) !== h.word);
  if (hits.length === 0) return { text: draft, applied: [] };
  const applied: string[] = [];
  const sentences = draft.split(/(?<=[。！!\n])/);
  const out = sentences.map((s) => {
    if (!AWAIT_SENTENCE_RE.test(s)) return s;
    let r = s;
    for (const h of hits) {
      if (!r.includes(h.word)) continue;
      const now = expressionForNow(h.dayStartMs, nowMs);
      if (now === null) {
        // 過ぎた日 → 日付の語を落とす（「明日午前中のご連絡」→「ご連絡」・助詞の「の」「に」も一緒に）
        const before = r;
        r = r.replace(new RegExp(`${h.word}(?:の)?(?:午前中|午後|中|朝|夕方|夜)?(?:の|に)?`, "g"), "");
        if (r !== before) applied.push(`STALE_RELATIVE_DAY_DROPPED:${h.word}`);
      } else {
        r = r.split(h.word).join(now);
        applied.push(`STALE_RELATIVE_DAY_FIXED:${h.word}→${now}`);
      }
    }
    return r;
  }).join("");
  return { text: out, applied };
}

// ─────────────────────────────────────────────────────────────
// 2026-09-16 竹内（𝒮 さん事例）「先ほどって入ってるけど、そこは先ほどではない。日付の把握が出来ていない」:
//   こちらの前の発言（9/8 10:44・8日前）を下書きが「先程は10月23日ごろまでの延長が可能とご案内させて頂きましたが」と書いた。
//   原因: LLM に渡す会話履歴に時刻が1つも入っていない（「スモラ: …」「お客様: …」だけ）ので、自分の発言がいつかを知らない。
//   実データ（180日）: スタッフの「先程／先ほど」29件中23件が3時間以内。3時間を超えて会話の発言を指した例は無く、
//   3時間超の6件は「先ほどはお電話ありがとうございました」等の LINE 外の出来事か旧 AI の文
// ─────────────────────────────────────────────────────────────
const HOUR_MS = 3600_000;
/** 日本時間の「HH:MM」 */
const jstHm = (ms: number) => { const d = new Date(ms + JST_OFFSET_MS); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; };
/** 「先程」が使える幅（これを超えたら会話の発言には使わない） */
export const RECENT_REF_MAX_MS = 3 * HOUR_MS;
const RECENT_REF_RE = /(?:先程|先ほど|さきほど)(?:は|の|に|、)?/g;
/** 電話・来店・内覧など LINE の発言ではない出来事（この文の「先程」は触らない） */
const OFFLINE_EVENT_RE = /お?電話|ご?来店|ご?来社|ご?内覧|内見|お時間(?:を)?(?:頂|いただ)|対面|ご面談/;

/** 経過時間を日本語に（15分前・3時間前・8日前） */
export function elapsedLabel(fromMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - fromMs);
  const days = Math.round((jstDayStartMs(nowMs) - jstDayStartMs(fromMs)) / DAY_MS);
  if (days >= 1) return `${days}日前`;
  const h = Math.floor(diff / HOUR_MS);
  if (h >= 1) return `${h}時間前`;
  return `${Math.max(1, Math.floor(diff / 60000))}分前`;
}

/** 生成の指示に入れる「この会話の時刻」（履歴の行の形は変えずに、いつの発言かを渡す） */
export function buildConversationClockNote(
  lastStaffAtMs: number | null,
  lastCustomerAtMs: number | null,
  nowMs: number,
): string {
  const lines: string[] = [`・今: ${jstDayLabel(jstDayStartMs(nowMs))} ${jstHm(nowMs)}`];
  if (lastStaffAtMs !== null) {
    const stale = nowMs - lastStaffAtMs > RECENT_REF_MAX_MS;
    lines.push(`・こちらの最後の発言: ${jstDayLabel(jstDayStartMs(lastStaffAtMs))} ${jstHm(lastStaffAtMs)}（${elapsedLabel(lastStaffAtMs, nowMs)}）${stale ? "→ 3時間以上前なので「先程」「先ほど」とは書かない（日付に触れずに書く）" : ""}`);
  }
  if (lastCustomerAtMs !== null) {
    lines.push(`・お客様の最新メッセージ: ${jstDayLabel(jstDayStartMs(lastCustomerAtMs))} ${jstHm(lastCustomerAtMs)}（${elapsedLabel(lastCustomerAtMs, nowMs)}）`);
  }
  if (lines.length === 1) return "";
  return `\n\n【🕐 この会話の時刻（日本時間・会話履歴の行には時刻が無いのでここで把握すること）】\n${lines.join("\n")}`;
}

/**
 * こちらの前の発言が3時間より前なのに「先程」と書いていたら、その語を落とす（日付に触れない形にする）。
 * 電話・来店・内覧など LINE の発言でない出来事を指す文は触らない
 */
export function fixStaleRecentReference(draft: string, lastStaffAtMs: number | null, nowMs: number): { text: string; applied: string[] } {
  if (lastStaffAtMs === null || nowMs - lastStaffAtMs <= RECENT_REF_MAX_MS) return { text: draft, applied: [] };
  const applied: string[] = [];
  const out = draft.split(/(?<=[。！!\n])/).map((s) => {
    if (!/先程|先ほど|さきほど/.test(s) || OFFLINE_EVENT_RE.test(s)) return s;
    const r = s.replace(RECENT_REF_RE, "");
    if (r !== s) applied.push(`STALE_RECENT_REF_DROPPED:${elapsedLabel(lastStaffAtMs, nowMs)}`);
    return r;
  }).join("");
  return { text: applied.length ? out : draft, applied };
}

/**
 * 文の中の相対の日を絶対の日（M/D（曜））に直す。ブレインの判断（返信の方向・お客様が示した時期）を保存する時に使う。
 * 判断は後（別の日）に読まれることがあるので、相対の語のまま残すと翌日の生成がそれを写す（yasuki 事例の元）
 */
export function absolutizeRelativeDays(text: string | null | undefined, atMs: number): string {
  const t = text ?? "";
  if (!t) return t;
  const hits = resolveRelativeDays(t, atMs);
  let out = t;
  for (const h of hits) out = out.split(h.word).join(jstDayLabel(h.dayStartMs));
  return out;
}
