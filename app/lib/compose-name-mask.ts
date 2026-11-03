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
