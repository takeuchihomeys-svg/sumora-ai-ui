// app/lib/viewing-date-request.ts
// 2026-09-15 竹内（隼斗事例）「内覧日付指定あった場合の AIX の流れ」:
//   スタッフ「本日ご内覧如何でしょうか 17:30〜18:30」→ お客様「本日は厳しいので18日はどうでしょうか？」に、
//   AIX【内覧へ】内覧日指定ありの日程が「9月16日 13:00〜16:00」になった（正しくは 9/18 の空き時間）。
//   原因: ①会話のお客様の発言を全部つなげて日付を探し、「本日は厳しい」の「本日」を希望日にした（否定を見ない・古い発言も混ざる）
//         ②「18日」（月なし）を読めない ③カレンダーは3日分だけで、希望日が範囲外だと最初の空き日（9/16）に置き換えていた
//   → お客様の最新の発言（最後のスタッフ発言より後の連投）だけから、断りの文を除いて希望日を読む。日付・曜日は日本時間（jst-date）。
//   返信の形はスタッフの実送信（隼斗 9/15）:
//     かしこまりました！！
//     9/18お部屋ご案内させて頂きます！！
//
//     9/18(金) 10:30〜11:30 17:00〜18:30
//     ご案内可能です😊！！
//     隼斗さんご都合よろしいお時間御座いますでしょうか！！
import { jstParts, WEEKDAYS_JA } from "./jst-date";

const DAY_MS = 86_400_000;

export type RequestedViewingDate = {
  /** 'YYYY-MM-DD'（日本時間） */
  ymd: string;
  m: number;
  d: number;
  /** '9/18' */
  md: string;
  /** '9/18(金)' */
  label: string;
};

type Msg = { sender?: string | null; text?: string | null };

const MEDIA_ONLY_RE = /^\s*(?:\[(?:画像|動画|スタンプ|ファイル)\][^\n]*\s*)+$/;

/** お客様の最新の発言（最後のスタッフ発言より後の連投）。最後がスタッフなら、その前のお客様の連投。messages は古い順 */
export function latestCustomerTurnText(messagesOldestFirst: ReadonlyArray<Msg>): string {
  const msgs = messagesOldestFirst.filter((m) => !!(m.text ?? "").trim() && !MEDIA_ONLY_RE.test(m.text ?? ""));
  let end = msgs.length - 1;
  while (end >= 0 && msgs[end].sender !== "customer") end--;
  if (end < 0) return "";
  let start = end;
  while (start - 1 >= 0 && msgs[start - 1].sender === "customer") start--;
  return msgs.slice(start, end + 1).map((m) => m.text ?? "").join("\n");
}

/** 断りの文（その日は行けない）— この文に書かれた日付は希望日にしない */
const DECLINE_RE = /厳し|きびし|難し|むずかし|無理|むり|ダメ|だめ|不可|行けな|いけな|行けません|いけません|都合(?:が|の)?(?:悪|合わ|つか)|予定(?:が|入)|空いてな|空いていな|空いてません|キャンセル|は仕事|仕事が(?:ある|入)/;
/** 内覧ではない日付（入居・引越し・契約・支払い・審査） */
const NON_VIEWING_RE = /入居|引っ?越|退去|契約|振込|振り込|支払|審査|書類|鍵|住み始め/;
const CLAUSE_SPLIT_RE = /[。\n、，,！!？?]|ので|のですが|ですが|けれど|けど/;
/** 日付を希望として言っている文（「今日はありがとうございました」の今日は拾わない）。短い返事（「18日で」「18日」）は日付だけで希望 */
const ASK_RE = /どう|いかが|如何|可能|大丈夫|いけ|行け|空いて|お願い|希望|でき|出来|なら|だと|とか|でも|で$|か$|内覧|内見|見学|案内|伺/;

const toHalf = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
const pad2 = (n: number) => String(n).padStart(2, "0");

function fromUtcDay(t: number): RequestedViewingDate {
  const x = new Date(t);
  const m = x.getUTCMonth() + 1;
  const d = x.getUTCDate();
  return { ymd: `${x.getUTCFullYear()}-${pad2(m)}-${pad2(d)}`, m, d, md: `${m}/${d}`, label: `${m}/${d}(${WEEKDAYS_JA[x.getUTCDay()]})` };
}

/** 'M/D(曜)'（日本時間の日付として） */
export function viewingDateLabel(ymd: string): string {
  const mm = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!mm) return ymd;
  return fromUtcDay(Date.UTC(Number(mm[1]), Number(mm[2]) - 1, Number(mm[3]))).label;
}

/**
 * 文から内覧の希望日を読む（今日以降・60日以内・日付の順）。
 * 今日/本日・明日・明後日・M月D日・M/D・D日（月なし＝今日以降で最も近い月）・（今週/来週）〇曜。断りの文・入居等の文の日付は読まない
 */
export function extractRequestedViewingDates(text: string, nowMs: number = Date.now()): RequestedViewingDate[] {
  const now = jstParts(nowMs);
  const today = Date.UTC(now.y, now.m - 1, now.d);
  const found = new Map<string, RequestedViewingDate>();
  const add = (t: number) => {
    if (!Number.isFinite(t) || t < today || t > today + 60 * DAY_MS) return;
    const r = fromUtcDay(t);
    found.set(r.ymd, r);
  };
  const ymdOf = (y: number, m: number, d: number): number => {
    const t = Date.UTC(y, m - 1, d);
    const x = new Date(t);
    return x.getUTCMonth() === m - 1 && x.getUTCDate() === d ? t : NaN; // 2/30 等は無効
  };

  // 「16,17,18,19日」の並びは1日ずつに（読点で文を分ける前に「16日,17日,18日,19日」にする）
  const src = toHalf(text ?? "").replace(/(\d{1,2})(?=\s*[,、・，]\s*(?:\d{1,2}\s*[,、・，]\s*)*\d{1,2}\s*日)/g, "$1日");
  for (const raw of src.split(CLAUSE_SPLIT_RE)) {
    const clause = raw.trim();
    if (!clause || DECLINE_RE.test(clause) || NON_VIEWING_RE.test(clause)) continue;
    if (!ASK_RE.test(clause) && clause.length > 8) continue;

    if (/明後日|あさって/.test(clause)) add(today + 2 * DAY_MS);
    if (/明日|あした/.test(clause.replace(/明後日/g, ""))) add(today + DAY_MS);
    if (/今日|本日/.test(clause)) add(today);

    // M月D日 / M/D
    for (const mm of clause.matchAll(/(?<![0-9:])(\d{1,2})\s*(?:月\s*(\d{1,2})\s*日?|[\/／]\s*(\d{1,2}))(?![0-9:])/g)) {
      const mo = Number(mm[1]);
      const da = Number(mm[2] ?? mm[3]);
      if (mo < 1 || mo > 12) continue;
      let t = ymdOf(now.y, mo, da);
      if (Number.isFinite(t) && t < today - 60 * DAY_MS) t = ymdOf(now.y + 1, mo, da); // 年またぎ
      add(t);
    }
    // D日（月なし）: 今月の D 日が今日以降なら今月、過ぎていれば来月
    for (const mm of clause.matchAll(/(?<![0-9月\/／])(\d{1,2})\s*日(?!間|後|前|以内|程度|ほど|中|曜|分)/g)) {
      const da = Number(mm[1]);
      if (da < 1 || da > 31) continue;
      let t = ymdOf(now.y, now.m, da);
      if (!Number.isFinite(t) || t < today) {
        const nm = now.m === 12 ? 1 : now.m + 1;
        const ny = now.m === 12 ? now.y + 1 : now.y;
        t = ymdOf(ny, nm, da);
      }
      add(t);
    }
    // （今週/来週/再来週）〇曜
    for (const mm of clause.matchAll(/(再来週|来週|今週)?\s*の?\s*([月火水木金土日])曜/g)) {
      const target = WEEKDAYS_JA.indexOf(mm[2] as (typeof WEEKDAYS_JA)[number]);
      if (target < 0) continue;
      const prefix = mm[1];
      if (prefix) {
        const mondayOffset = now.dow === 0 ? -6 : 1 - now.dow; // 今週の月曜
        const weeks = prefix === "今週" ? 0 : prefix === "来週" ? 1 : 2;
        const idx = target === 0 ? 6 : target - 1; // 月=0 … 日=6
        add(today + (mondayOffset + weeks * 7 + idx) * DAY_MS);
      } else {
        let diff = target - now.dow;
        if (diff <= 0) diff += 7;
        add(today + diff * DAY_MS);
      }
    }
  }
  return [...found.values()].sort((a, b) => a.ymd.localeCompare(b.ymd));
}

/** 会話（古い順）からお客様の最新の発言の内覧希望日を読む */
export function requestedViewingDatesFromMessages(messagesOldestFirst: ReadonlyArray<Msg>, nowMs: number = Date.now()): RequestedViewingDate[] {
  return extractRequestedViewingDates(latestCustomerTurnText(messagesOldestFirst), nowMs);
}

/**
 * 内覧日指定ありの返信（テンプレ・AI 不要）。times は日付ごとの空き時間（"10:30〜11:30 17:00〜18:30"。空なら時間の行を出さない）。
 * スタッフの実送信（隼斗 9/15）の形。日付が複数なら「お日にち・お時間」を伺う
 */
export function buildViewingSpecificMessage(o: {
  dates: ReadonlyArray<{ md: string; label: string; times: string }>;
  customerName: string;
  propertyName?: string;
}): string {
  const dates = o.dates.filter((d) => d.md);
  if (dates.length === 0) return "";
  const mdList = dates.map((d) => d.md).join("・");
  const head = o.propertyName?.trim()
    ? `かしこまりました！！\n${mdList}${o.propertyName.trim()}ご案内させて頂きます！！`
    : `かしこまりました！！\n${mdList}お部屋ご案内させて頂きます！！`;
  const lines = dates.filter((d) => d.times.trim()).map((d) => `${d.label} ${d.times.trim()}`);
  const name = o.customerName ? `${o.customerName}さん` : "";
  const ask = dates.length > 1 ? "ご都合よろしいお日にち・お時間御座いますでしょうか！！" : "ご都合よろしいお時間御座いますでしょうか！！";
  if (lines.length === 0) return `${head}\n${name}${ask}`;
  return `${head}\n\n${lines.join("\n")}\nご案内可能です😊！！\n${name}${ask}`;
}
