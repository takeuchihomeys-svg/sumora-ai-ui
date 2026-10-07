// app/lib/viewing-greeting-text.ts — AIX【内覧挨拶】の文（内覧前は決まった3行・LLM なし／内覧後の1行目）。純関数・依存なし
//
// 2026-10-07 竹内「文の質をあげてボタンとしてつかっていく」（AIX の判断のずれの調査で「内覧挨拶 押下0」）:
//   押下0は**記録の穴**だった＝挨拶のピッカーは生成した文を返信の入力欄に入れ、スタッフは普通の送信で送る（aix_usage_logs に残らない）。
//   aix_generate_log では 8/21〜10/06 に 101回作られ（YUMA 除く）、83回が送られた（そのまま 30・直して 53）。
//   直された訳（実物を並べて読んだ）:
//     内覧前（Haiku が3行を書く）: 形の指示の記号が漏れる（「…😊！！」⏎②「本日16時お部屋ご案内させて頂きます！」⏎③「…」」4回）／
//       名前の代わりに「ご連絡頂きありがとうございます😊！！」（初回の挨拶・画面が渡す直近15通にこちらの文が無いと初回と読む）／
//       物件名を足す（「本日12時にスプランディッドＸご案内」）／「今日も1日よろしくお願い致します」。
//     スタッフの内覧前の手打ち（120日 67通）はほぼ全部が同じ3行:
//       「〇〇さんお世話になっております！！⏎本日14時お部屋ご案内させて頂きます！⏎本日は何卒よろしくお願い致します！！」
//     → 内覧前は LLM を呼ばず、この3行を決定論で作る（挨拶は「今日こちらが送ったか」だけで決める・初回の挨拶にしない）
//   内覧後: 名前が分からない時「お客様本日お時間頂きありがとうございました！！」（12回・相手を「お客様」と呼ばない＝10/02 の決まり）
//     → 名前が無ければ呼ばない（「本日お時間頂きありがとうございました！！」）

/** 「14:00」→「14時」・「14:30」→「14時半」・「10:45」→「10時45分」・「14時」はそのまま。読めなければ空（時刻を書かない） */
export function viewingTimeJa(raw: string | null | undefined): string {
  const t = String(raw ?? "").normalize("NFKC").trim();
  if (!t) return "";
  const m = /^(\d{1,2})\s*[:時]\s*(\d{1,2})?\s*分?$/.exec(t) ?? /^(\d{1,2})時半$/.exec(t);
  if (!m) return "";
  const h = Number(m[1]);
  if (!(h >= 0 && h <= 23)) return "";
  if (/時半$/.test(t)) return `${h}時半`;
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (!(min >= 0 && min <= 59)) return "";
  if (min === 0) return `${h}時`;
  if (min === 30) return `${h}時半`;
  return `${h}時${min}分`;
}

/**
 * 内覧前の挨拶（スタッフの手打ちの3行の型）。
 * @param name 「〇〇さん」（分からなければ ""＝呼ばない）
 * @param greeting 今日はじめての LINE なら「お世話になっております！！」・今日すでに送っていれば ""
 * @param time 内覧の時刻（"14:00" 等・無ければ ""＝「本日お部屋ご案内させて頂きます！」）
 */
export function buildViewingBeforeGreeting(o: { name: string; greeting: string; time?: string | null }): string {
  const head = `${o.name ?? ""}${o.greeting ?? ""}`.trim();
  const t = viewingTimeJa(o.time);
  return [head, `本日${t}お部屋ご案内させて頂きます！`, "本日は何卒よろしくお願い致します！！"].filter(Boolean).join("\n");
}

/** 内覧後の1行目（名前が無ければ呼ばない） */
export function viewingAfterThankLine(name: string): string {
  return `${name ?? ""}本日お時間頂きありがとうございました！！`;
}
