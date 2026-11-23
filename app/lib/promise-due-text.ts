// app/lib/promise-due-text.ts — 行動台帳（sent_facts）の約束の「期日を読むための文」（純関数・DB も LLM もなし）
//
// 2026-11-23 作業員L（統括役の頼み・found_gap）: 台帳の約束の文（detail.sentence）は約束の型に当たった1文だけ・80字で、
//   同じ通の「12月17日に…ピックアップしお送りさせて頂きます」（e4bb495d）や、同じ文の頭の「12月中旬ごろになりましたら」（ac34b364）を落とし、
//   期日を「72時間」と誤っていた（行動台帳の期日超えに、まだ期日の前の約束が入った）。
//   → 1通の中で、その種類の約束の言葉がある文を全部、文の終わりまで（切らずに・合わせて 300字まで）取る＝detail.dueText。
//     期日は dueText から読む（promise-drop-watch.promiseDeadlineMs に、「〇月中旬」「〇月末」等の時期の言葉を足す）。
// 切替 LEDGER_PROMISE_DUE_TEXT: 既定 on（2026-11-23 統括役の決め・14日 139行で期日が変わるのは期日の前の2件だけ・新しく期日超え0）＝約束の行に dueText を足す（sentence は変えない）／off＝書かない。
//   dueText を読むのは行動台帳の数（scripts/lib/promise-ledger-metrics）だけ（ブレイン・書き手・カレンダー・AIX の材料は sentence 等の名前の決まった欄だけを読む・grep で確かめた）
// テスト: app/lib/__tests__/promise-due-text.test.ts
import { promiseDeadlineMs } from "./promise-drop-watch";

type Env = Record<string, string | undefined>;
export function ledgerPromiseDueTextEnabled(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.LEDGER_PROMISE_DUE_TEXT ?? "").trim().toLowerCase() !== "off";
}

export const DUE_TEXT_MAX = 300;
/** これからする事の言い方（過去形・報告は外す） */
const FUTURE_RE = /させて(?:頂|いただ)きます|して(?:参|まい)ります|(?:致|いた)します|お送りします|ご連絡します/;
const PAST_RE = /(?:頂き|いただき|致し|いたし|し)ました(?:[！!。？?\n]|ところ|$)/;
/** 種類ごとの約束の言葉（台帳の種類の名前で） */
const KIND_WORD_RE: Record<string, RegExp> = {
  pickup_declared: /ピックアップ|お部屋探し|お探し|探させ|お部屋[^。！!？?\n]{0,30}お送り|新着/,
  confirmation_promised: /確認|お調べ|交渉|問い合わせ|ご連絡/,
  estimate_declared: /見積/,
};

/** 1通 → その種類の約束の言葉がある文（文の終わりまで・合わせて DUE_TEXT_MAX 字まで）。無ければ null */
export function promiseDueTextOf(text: string, kind: string): string | null {
  const word = KIND_WORD_RE[kind];
  if (!word) return null;
  const t = String(text ?? "").normalize("NFKC");
  const ss = t.split(/\n|(?<=[。！!？?])(?![。！!？?])/).map((x) => x.trim()).filter(Boolean);
  const hit = ss.filter((s) => word.test(s) && FUTURE_RE.test(s) && !PAST_RE.test(s));
  if (!hit.length) return null;
  return hit.join(" ").replace(/[\p{Extended_Pictographic}️]/gu, "").replace(/\s+/g, " ").trim().slice(0, DUE_TEXT_MAX) || null;
}

const DAY = 86_400_000;
const jstDay = (ms: number) => { const d = new Date(ms + 9 * 3_600_000); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 }; };
/**
 * 時期の言葉（「12月中旬」「1月末」「12月初旬」）の日（その時期の終わりの日の JST 24時）。いくつかあれば一番後ろ（約束の動きの近く）の物
 *   「1月末ごろのお引越しに向け12月中旬ごろになりましたら…再開」→ 12月中旬（20日）
 *   時期の言葉の後が「に・から・まで・になりましたら」の時だけ（「12月初旬のご入居に間に合うよう…至急ピックアップ」の入居の時期は期日でない・8739fa57）
 */
export function promisePeriodDeadlineMs(text: string, atMs: number): number | null {
  const ms = [...String(text ?? "").normalize("NFKC").matchAll(/(?<![0-9])(1[0-2]|0?[1-9])\s*月\s*(上旬|初旬|頭|はじめ|初め|中旬|下旬|末)\s*(?:頃|ごろ)?\s*(?:になりましたら|になり次第|に(?!向け|間に合|なる)|から|まで)/g)];
  const m = ms[ms.length - 1];
  if (!m) return null;
  const mon = Number(m[1]);
  const now = jstDay(atMs);
  let y = now.y;
  if (mon < now.m - 1) y += 1; // 11月に「1月末」は来年
  const lastDay = new Date(Date.UTC(y, mon, 0)).getUTCDate();
  const day = /上旬|初旬|頭|はじめ|初め/.test(m[2]) ? 10 : m[2] === "中旬" ? 20 : lastDay;
  return Date.UTC(y, mon - 1, day) + DAY - 9 * 3_600_000;
}

/** dueText からの期日（日付・「明日」等の言葉 → 時期の言葉 → 72時間の順） */
/** 入居・引越しの日付（「12/13のご入居に間に合うよう」・43e1cbb5）は約束の期日でないので、期日を読む前に外す */
export const MOVE_IN_DATE_RE = /(?<![0-9])(?:1[0-2]|0?[1-9])\s*[\/月]\s*(?:3[01]|[12][0-9]|0?[1-9])\s*日?\s*(?:\([^)]*\))?\s*(?:頃|ごろ)?\s*(?:の|に|から)?\s*(?:ご入居|お引越し|お引っ越し|入居|引越し)/g;
export function promiseDueFromText(dueText: string, atMs: number): { ms: number; by: "words" | "period" | "default72h" } {
  dueText = String(dueText ?? "").normalize("NFKC").replace(MOVE_IN_DATE_RE, "");
  const d = promiseDeadlineMs(dueText, atMs);
  if (d.by === "words") return d;
  const p = promisePeriodDeadlineMs(dueText, atMs);
  return p != null && p > atMs ? { ms: p, by: "period" } : d;
}
