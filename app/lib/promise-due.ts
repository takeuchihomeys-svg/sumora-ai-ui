// app/lib/promise-due.ts — こちらの約束の文から「いつまで」（期限の日）を読み、今から見て「あと N日／今日／N日過ぎ」を出す（純関数・DB も LLM もなし）
//
// 2026-10-28 台帳 w05-promise-staleness（「約束・送った物件の古さの決まりが無い」→「〇日前・期限まであと／過ぎ」を言えない）:
//   既にある物: 約束の経過（promise-tracker の「N時間前・遅れ気味/遅れ」＝種類ごとの実測の中央値・90%）／送った物件の古さ
//   （SENT_CONFIRMED_NOTE＝何日前に送った・7日超は念のため確認／STALE_MATERIAL_NOTE＝7日以上前の資料）。
//   無かった物: 約束の文の中の期限（「明日一番で」「本日中に」「10/30までに」「週明けに」）の日と、今から見た残り・過ぎ。
//   ここは日を読むだけ。遅れの判断・どう返すかはブレイン（P0 9eb6aa9c）。重ならないよう、送った物件の古さは SENT_CONFIRMED_NOTE に任せる。
//   切替 PROMISE_DUE_NOTE=on の時だけ（既定 off）。テスト: app/lib/__tests__/promise-due.test.ts
import { jstParts } from "./jst-date";

export function promiseDueNoteEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.PROMISE_DUE_NOTE ?? "").trim().toLowerCase() === "on";
}

const DAY = 86_400_000;
const N = (s: string) => s.normalize("NFKC");
/** JST の暦の日（UTC の 0時で表す） */
const dayOf = (ms: number) => { const p = jstParts(ms); return Date.UTC(p.y, p.m - 1, p.d); };
const DOW: Record<string, number> = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };

/** 約束の文の期限の日（JST の暦の日を UTC 0時で）。読めなければ null */
export function promiseDueDay(sentence: string, saidAtMs: number): number | null {
  const t = N(sentence);
  const base = dayOf(saidAtMs);
  const md = t.match(/(?<![0-9])(1[0-2]|0?[1-9])\s*[\/月]\s*(3[01]|[12][0-9]|0?[1-9])\s*日?/);
  if (md) {
    const p = jstParts(saidAtMs);
    let d = Date.UTC(p.y, Number(md[1]) - 1, Number(md[2]));
    if (d < base - 30 * DAY) d = Date.UTC(p.y + 1, Number(md[1]) - 1, Number(md[2])); // 年をまたぐ（12月に「1/5」）
    return d;
  }
  if (/本日中|今日中|本日|今日/.test(t)) return base;
  if (/明後日|あさって/.test(t)) return base + 2 * DAY;
  if (/明日|明朝|あした/.test(t)) return base + DAY;
  const dowNow = new Date(base).getUTCDay();
  if (/週明け|来週(?:の)?(?:頭|初め|はじめ)/.test(t)) return base + (((8 - dowNow) % 7) || 7) * DAY; // 次の月曜
  if (/今週中/.test(t)) return base + ((7 - dowNow) % 7) * DAY; // その週の日曜
  const w = t.match(/(来週)?\s*の?\s*([月火水木金土日])曜/);
  if (w) {
    let diff = (DOW[w[2]] - dowNow + 7) % 7;
    if (w[1]) diff += diff === 0 ? 7 : (DOW[w[2]] > dowNow ? 7 : 0);
    return base + diff * DAY;
  }
  return null;
}

/** 「期限 10/30（あと2日）」「期限 10/28（今日）」「期限 10/27（1日過ぎ）」。読めなければ null */
export function promiseDueLabel(sentence: string, saidAtMs: number, nowMs: number): string | null {
  const due = promiseDueDay(sentence, saidAtMs);
  if (due == null) return null;
  const diff = Math.round((due - dayOf(nowMs)) / DAY);
  const d = new Date(due);
  const md = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return `期限 ${md}（${diff > 0 ? `あと${diff}日` : diff === 0 ? "今日" : `${-diff}日過ぎ`}）`;
}
