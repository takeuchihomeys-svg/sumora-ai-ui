// app/lib/viewing-slots.ts
// 内覧の候補に出す「1日あたりの時間の数」を1か所で決める（純関数・DB 依存なし）。
//
// 2026-09-16 竹内（𝒮 さん事例）「この時間が2つ出るパターンはお客さんからの日付指定があった場合のみ。
//   こちらから日にち送る場合は1日1つと前までの通りで行う」:
//   𝒮 15:20「明日だと何時だとご都合よろしいでしょうか？」→ 15:27 AIX【内覧へ】「9/17(木) 12:00〜14:00  16:00〜18:00」
//   → 15:28 お客様「12時〜14時でお願いしたいです！」で決まった。お客様が日にちを決めている時は、その日の空き時間を並べるのが正しい。
//   一方こちらから日にちを出す時（直近ですと…の形）は、実送信 180日で日付の数＝枠の数が 54件（2日→2枠 27・3日→3枠 25）に対し、
//   1日に2枠並べたのは3件だけ。選択肢が増えるほど返事が鈍るので、こちらから出す日は1日1つに揃える。
//
// 材料（calendar_info）も画面の初期値も生成文の出口も、この関数だけを通す。
import { requestedViewingDatesFromMessages } from "./viewing-date-request";

const SLOT_RE = /\d{1,2}:\d{2}(?:\s*[〜~～]\s*\d{1,2}:\d{2})?/g;
const DATE_RE = /(\d{1,2})\s*[\/／]\s*(\d{1,2})/;
/** 枠と枠の間の区切り（2つ目以降を落とす時に一緒に消す） */
const SEP_RE = /[\s\/・、,／]/;

/** 'M/D' に揃える（"09/17" → "9/17"） */
export function normalizeMd(md: string): string {
  const m = (md ?? "").match(DATE_RE);
  return m ? `${Number(m[1])}/${Number(m[2])}` : "";
}

/** その日に出す時間（お客様が日にちを指定した日はその日の空き時間を全部・こちらから出す日は先頭の1つだけ） */
export function pickDaySlots(slots: ReadonlyArray<string>, requested: boolean): string[] {
  const list = slots.filter((s) => !!(s ?? "").trim());
  if (requested) return [...list];
  return list.slice(0, 1);
}

/** 1行の中の2つ目以降の時間を落とす（区切りも一緒に消す。「9/18(金) 10:30〜11:30 17:00〜18:30」→「9/18(金) 10:30〜11:30」） */
function limitLineSlots(line: string): string {
  const ms = [...line.matchAll(SLOT_RE)];
  if (ms.length <= 1) return line;
  let out = line;
  // 後ろから消す（前方の位置は変わらない）
  for (let i = ms.length - 1; i >= 1; i--) {
    const m = ms[i];
    const start = m.index ?? 0;
    let s = start;
    while (s > 0 && SEP_RE.test(out[s - 1])) s--;
    out = out.slice(0, s) + out.slice(start + m[0].length);
  }
  return out;
}

/**
 * 1行1日のカレンダーの材料・生成文から、お客様が指定していない日の2つ目以降の時間を落とす。
 * requestedMds が空なら全部の日を1つに。日付（M/D）が読めない行は触らない（判断できないので減らさない）
 */
export function limitSlotsPerDay(text: string, requestedMds: ReadonlyArray<string> = []): string {
  const wanted = new Set(requestedMds.map(normalizeMd).filter(Boolean));
  return (text ?? "")
    .split("\n")
    .map((line) => {
      const dm = line.match(DATE_RE);
      if (wanted.size > 0) {
        if (!dm) return line;                                  // 日付が読めない行は触らない
        if (wanted.has(`${Number(dm[1])}/${Number(dm[2])}`)) return line; // お客様が指定した日はそのまま
      }
      return limitLineSlots(line);
    })
    .join("\n");
}

/**
 * 内覧の案内文の出口（AIX【内覧へ】の生成後）。お客様が日にちを**1日だけ**指定していれば、その日の時間はそのまま。
 * それ以外（こちらから日にちを出す・複数日を並べる）は1日1つに落とす。
 * 指定日は画面の入力（viewing_requested_dates）を先に見て、無ければお客様の最新の発言から読む（経路が違っても同じ判断になる）
 */
export function limitViewingSlotsInReply(
  text: string,
  o: {
    requestedDatesText?: string | null;
    messages?: ReadonlyArray<{ sender?: string | null; text?: string | null }>;
    nowMs?: number;
  } = {},
): string {
  const fromInput = [...String(o.requestedDatesText ?? "").matchAll(/(\d{1,2})\s*[\/／]\s*(\d{1,2})/g)]
    .map((m) => `${Number(m[1])}/${Number(m[2])}`);
  const mds = fromInput.length > 0
    ? fromInput
    : requestedViewingDatesFromMessages(o.messages ?? [], o.nowMs ?? Date.now()).map((r) => r.md);
  return limitSlotsPerDay(text, mds.length === 1 ? mds : []);
}
