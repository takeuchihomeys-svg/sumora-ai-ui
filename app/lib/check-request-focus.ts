// app/lib/check-request-focus.ts — AIX【物件確認した】の書く役に「この確認で頼まれた事」（上の階・別のお部屋・床の色 等）を渡す（純関数）
//
// 2026-10-28 竹内さんの指摘（ayaka・10/24〜10/26）: お客様は物件ごとに「ここは上の階空いてたりしますか？」「これも上の階があれば嬉しいです」、
//   こちらは「3件、上の階の空き状況も含めて管理会社に募集状況確認させて頂きます！！」と約束していた。
//   下書き（aix_generate_log 10/26 01:11）は「Prosper豊中南 503号室は募集中です…ソルテラス関目高殿駅前・アーバンパーク淡路は残念ながら募集終了」＝頼みの中身（上の階）に答えていない。
//   竹内さんが送った文:「Prosper豊中南 のみお送り頂きましたお部屋よりも上の階のお部屋募集に出ておりましたが5階部分のお部屋となります！！
//   ソルテラス関目高殿駅前・アーバンパーク淡路はお送り頂きましたお部屋よりも上の階のお部屋募集に出ていない状況となります！！」
//   会話の履歴には頼みの文があったが、書く役への材料は「確認結果: 募集中/募集終了」だけで、頼みの中身を結果の言い方に結ぶ材料が無かった。
// 直し: 前の物件確認の結果より後の、お客様の頼みとこちらの確認の約束から「頼まれた事」の語を拾い、結果をその頼みに答える形で書くよう材料に渡す。
//   決めるのは書く役（本文を書き換えない）。入れる CHECK_REQUEST_FOCUS=on（既定 off）
export function checkRequestFocusOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.CHECK_REQUEST_FOCUS ?? "").trim().toLowerCase() === "on";
}

type Msg = { sender: string; text: string | null | undefined };

/** 頼まれた事の種類（語の網・お客様の言い方の例は会話から写す） */
const FOCUS: Array<{ key: string; re: RegExp }> = [
  { key: "上の階のお部屋", re: /上の階|上階|高層階|もっと上|より上/ },
  { key: "下の階のお部屋", re: /下の階|低層階|1階(?:以外|じゃない)|より下/ },
  { key: "角部屋", re: /角部屋/ },
  { key: "同じ建物の別のお部屋", re: /(?:他|別|ほか)の(?:お?部屋|号室)|同じ(?:建物|マンション)の/ },
  { key: "床の色（お部屋の内装）", re: /床の色|床が(?:白|グレー|黒|茶)|フローリングの色/ },
  { key: "向き（南向き等）", re: /南向き|東向き|西向き|北向き|日当たり/ },
  { key: "同じ間取りのお部屋", re: /同じ間取り/ },
];

const CHECK_DONE_RE = /募集状況確認(?:いたしました|致しました|させて頂きましたところ)|募集中(?:です|となります|のお部屋)|募集終了|募集に出ていない/;
const PROMISE_RE = /確認させて頂きます|確認致します|確認いたします|確認させていただきます/;

/**
 * 前の確認の結果（こちらの「募集状況確認いたしました」等）より後の、お客様の頼み・こちらの確認の約束から頼まれた事を拾う。
 *   返す: 頼まれた事の種類・お客様の言葉（1つ・40字まで）・こちらの約束（1つ・60字まで）・材料の行（無ければ空）
 */
export function checkRequestFocus(history: ReadonlyArray<Msg>, o: { conditions?: string | null } = {}): { keys: string[]; quote: string | null; promise: string | null; line: string } {
  let from = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.sender !== "customer" && CHECK_DONE_RE.test(String(m.text ?? "")) && !PROMISE_RE.test(String(m.text ?? ""))) { from = i + 1; break; }
  }
  const span = history.slice(from);
  const keys: string[] = [];
  let quote: string | null = null;
  let promise: string | null = null;
  for (const m of span) {
    const t = String(m.text ?? "");
    // 頼みとして数えるのは、お客様の頼み・問い（画像の読み・物件の紹介文は除く）と、こちらの確認の約束だけ。
    //   監査（60日 350番）: こちらの物件の紹介文（「角部屋・南向き」）・画像の読み（「南向き（灰色ボタン）」）を拾っていた 44番の大半が頼みでなかった
    if (m.sender === "customer" ? (/^\s*\[画像\]|^【/.test(t) || !/[？?]|空い|あれば|がいい|が良い|希望|ありますか|ですか|嬉しい|探し|ないですか|ませんか/.test(t)) : !PROMISE_RE.test(t)) continue;
    const hit = FOCUS.filter((f) => f.re.test(t));
    if (!hit.length) continue;
    for (const h of hit) if (!keys.includes(h.key)) keys.push(h.key);
    // 頼みの語を含む1文だけ（挨拶・前置きを写さない）
    const sent = t.split(/[。！!？?\n]+/).map((x) => x.trim()).find((x) => hit.some((h) => h.re.test(x))) ?? t;
    const cut = (x: string, n: number) => Array.from(x.replace(/\s+/g, " ").trim()).slice(0, n).join("");
    if (m.sender === "customer" && !quote) quote = cut(sent, 40);
    if (m.sender !== "customer" && PROMISE_RE.test(t)) promise = cut(sent, 70);
  }
  const floorWish = o.conditions && /[0-9０-９]+階以上|2階以上|高層階|上の階/.test(o.conditions) ? (o.conditions.match(/[0-9０-９]+階以上|高層階|上の階/)?.[0] ?? null) : null;
  if (!keys.length && !floorWish) return { keys, quote, promise, line: "" };
  const bits = [
    keys.length ? `頼まれた事: ${keys.join("・")}` : "",
    quote ? `お客様「${quote}」` : "",
    promise ? `こちらの約束「${promise}」` : "",
    floorWish ? `登録のご希望: ${floorWish}` : "",
  ].filter(Boolean).join("／");
  const howTo = keys.includes("上の階のお部屋")
    ? "結果はこの頼みに答える形で書く（例: 「〇〇のみお送り頂きましたお部屋よりも上の階のお部屋募集に出ておりましたが5階部分のお部屋となります！！」「〇〇はお送り頂きましたお部屋よりも上の階のお部屋募集に出ていない状況となります！！」）。頼まれたお部屋が無かった物を「募集終了」とまとめて言い切らない"
    : "結果はこの頼みに答える形で書く（頼まれた事が分かる言い方で・頼まれたお部屋が無かった物は「〇〇は募集に出ていない状況」と頼みに沿って伝える）";
  return { keys, quote, promise, line: `・この確認で頼まれた事（会話から）: ${bits} → ${howTo}` };
}
