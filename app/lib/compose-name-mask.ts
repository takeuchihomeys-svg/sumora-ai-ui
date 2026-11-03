// app/lib/compose-name-mask.ts — 場面の RAG の表（takeuchi_compose_examples）に置く文の名前の伏せ（純関数）
//
// 2026-11-03 作業員6（統括の指示・伏せ直しの失敗の直し）: 正規表現で文の途中の「〇〇さん」を全部置き換えると、かなの続き
//   （「よろしければ〇〇さん」→「よろYUMAさん」・「最大限割引さ…」）まで名前として飲み込んだ（11/03 夜・353行を壊した）。
//   → **その会話のお客様の名前だけ**（conversations の表示名 customer_name・呼び名 call_name と、その姓・名＝空白・中黒で分けた物）を YUMA に置き換える。
//   長い名前から先に置き換える。2文字未満の部分は「さん」付きの時だけ置き換える（1文字の名前が言葉の途中に当たらないように）。
export function customerNameTokens(names: ReadonlyArray<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const raw of names) {
    const n = String(raw ?? "").normalize("NFKC").trim();
    if (!n || n === "YUMA") continue;
    out.add(n.replace(/\s+/g, ""));
    out.add(n);
    for (const part of n.split(/[\s　・･]+/)) if (part && part !== "YUMA") out.add(part);
  }
  return [...out].filter(Boolean).sort((a, b) => b.length - a.length);
}
export function maskCustomerNames(text: string, tokens: ReadonlyArray<string>): string {
  let r = String(text ?? "");
  for (const n of tokens) r = r.split(`${n}さん`).join("YUMAさん");
  for (const n of tokens) if (n.length >= 2) r = r.split(n).join("YUMA");
  return r;
}

/** 2026-11-04 版 20261104a: こちらが送った文の頭の「〇〇さん」（竹内さん・スタッフのお客様の呼び方）も伏せる名前に足す
 *  （表示名・呼び名と違う呼び方＝ローマ字の表示名をかなで呼ぶ・フルネームの表示名を苗字だけで呼ぶ が29行残っていた）。
 *  拾うのは文の頭だけ（文の途中の「〇〇さん」は拾わない）。こちら・皆・お客・管理会社・大家・業者・スタッフの名前は外す */
const NOT_NAMES = new Set(["こちら", "皆", "みな", "皆様", "お客", "管理会社", "大家", "業者", "鈴木", "竹内", "山之内", "YUMA"]);
export function staffHeadNames(staffTexts: ReadonlyArray<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const t of staffTexts) {
    const m = String(t ?? "").normalize("NFKC").trim().match(/^([^\s\n、。！!？?「（(]{1,8})さん/);
    if (m && !NOT_NAMES.has(m[1])) out.add(m[1]);
  }
  return [...out];
}
