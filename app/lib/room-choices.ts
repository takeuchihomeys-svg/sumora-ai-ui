// app/lib/room-choices.ts
// 申込のお部屋がまだ決まっていない時の「候補の号室」（純関数・DB 依存なし）。
//
// 2026-09-16 竹内（カイナ事例）「AIX の申込誘導の文で部屋が決まっていなければ 3部屋の中でどれが良いか、会話を合わせるボタンで生成」:
//   お客様「内見は大丈夫なので進めて頂きたいです！」→ 実送信 11:53（手打ち）
//   「かしこまりました！！／代理契約でお申込みさせて頂きます！！／現在募集の3部屋の中で(1303号室・906号室・506号室)／
//    お部屋は何号室で審査かけさせていただきましょうか！！」。
//   号室は会話（画像だけ）にも AIX の記録（property_names はマンション名だけ）にも無いので、スタッフが入れた物だけを使う。

/** 「1303・906・506」「1303号室, 906号室」→ ["1303号室","906号室","506号室"]（重複は1つ・順は入力のまま） */
export function parseRoomChoices(input: string | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of (input ?? "").split(/[・,、\/／\s]+/)) {
    const t = raw.trim();
    if (!t) continue;
    // 号室・部屋・室 の表記ゆれを「〇〇号室」に揃える（数字・英数字の部屋番号だけを受ける）
    const m = t.match(/^([0-9０-９A-Za-z\-]+)\s*(?:号室|号|部屋|室)?$/);
    if (!m) continue;
    const no = m[1].replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    const label = `${no}号室`;
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

/** 号室を聞く形にするか（候補が2つ以上ある時だけ。1つなら決まっているのと同じ） */
export function shouldAskRoomChoice(rooms: readonly string[]): boolean {
  return rooms.length >= 2;
}

/** 生成に渡す行（件数と号室。スタッフが入れた物だけ・LLM に作らせない） */
export function roomChoiceNote(rooms: readonly string[]): string {
  return `件数: ${rooms.length}部屋\n号室: ${rooms.join("・")}`;
}
