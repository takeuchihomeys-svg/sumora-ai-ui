// app/lib/name-inside-word.ts — お客様の名前が「語の途中」に入った壊れた文を見つける（純関数・検出だけ・本文は書き換えない）
//
// 2026-10-06 竹内（し 事例）「誤字が発生する原因　また発生してるって監視や最終チェックわかってるのになぜ編集されていないのか」
//   表示名「し」・呼び名「角田」の会話で、出口の名前直し（validate-reply.enforceCustomerName）が本文中の「し」を全部「角田」に替え、
//   「か角田こまりま角田た！！」「ピックアップ角田て」「お部屋探角田」の下書きが 10/04〜10/06 に5通出た（送信は0）。
//   最終チェックの LLM（anomaly_scan）は FABRICATED_NAME を warning で出したが、作り直しは block の時だけ・接地修正は名前を直せない
//   （CHECKPOINT に無い事実で置換できない）ため、指摘だけ出て本文はそのまま画面に出た。
//   → 決定論の block（NAME_INSIDE_WORD）にして、作り直しの対象・自動送信の関所に乗せる。
//
// ■ 線の引き方（誤検出を避ける）
//   ・名前は2字以上で、ひらがなだけの名前は対象外（「はる」「あや」は普通の語の中に出る）
//   ・名前の前後が**両方ひらがな**で、後ろが敬称（さん・さま・ちゃん・くん）でない所だけ
//     例: 「ま角田た」「探角田全力」(前が漢字なので×)…前後ひらがなの「か角田こ」「ま角田た」「ップ角田て」(前がカタカナ×)
//   ・本文を直さない（元の字が分からない）。見つけたら作り直し・送らせない側に倒す

export type NameInsideWordHit = { name: string; evidence: string; index: number };

const HIRA = /^[ぁ-ゖ]$/;
const HONORIFIC_AFTER = /^(?:さん|さま|ちゃん|くん)/;

export function detectNameInsideWord(text: string | null | undefined, names: ReadonlyArray<string | null | undefined>): NameInsideWordHit[] {
  const src = String(text ?? "");
  if (!src) return [];
  // 登録名が「黒明さん」と敬称つきで入っていることがある（敬称を外して名前だけにする）
  const list = [...new Set(names.map((n) => String(n ?? "").trim().replace(/\s*(?:さん|さま|様|ちゃん|くん)$/, "").trim()))]
    .filter((n) => Array.from(n).length >= 2 && !/^[ぁ-ゖー]+$/.test(n) && /[\p{L}]/u.test(n));
  const hits: NameInsideWordHit[] = [];
  for (const name of list) {
    let i = 0;
    for (;;) {
      const at = src.indexOf(name, i);
      if (at < 0) break;
      i = at + name.length;
      const before = Array.from(src.slice(Math.max(0, at - 2), at)).pop() ?? "";
      const rest = src.slice(at + name.length);
      const after = Array.from(rest.slice(0, 2))[0] ?? "";
      if (!HIRA.test(before) || !HIRA.test(after)) continue;
      if (HONORIFIC_AFTER.test(rest)) continue;
      hits.push({ name, index: at, evidence: src.slice(Math.max(0, at - 6), Math.min(src.length, at + name.length + 6)) });
    }
  }
  return hits;
}
