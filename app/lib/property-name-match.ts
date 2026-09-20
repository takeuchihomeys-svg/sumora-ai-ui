// app/lib/property-name-match.ts
// 読み取った物件名を「この会話で実際に出ている物件名」に寄せる（純関数・DB 依存なし）。
//
// 2026-09-20 竹内「お客さん毎に送った物件のテーブル作ってそこから読み取れるようにすれば良いのでは。
//   その画像の読み込みに限定して（別のモデル）を使う」
//
// 【なぜ照合が要るか】画像から読み取った物件名は**誤読する**。同じ画像6枚を実測したら:
//   Haiku : 「スプランディッド堀江」と「スプラッティド堀江」／「アーバネックス本町Ⅱ」と「ファースネックス大阪Ⅱ」
//           ＝ **同じ物件を違う名前で読む**
//   Sonnet5: 同じ物件は同じ名前（6/6 一致）
//   誤った物件名をブレインに渡すと、本文から正規表現で取ろうとして失敗した時と同じで、
//   **かえってすれ違いを生む**（汚れた材料は渡さない方がまし）。
//
// 【やり方】読み取った名前を、その会話で既に分かっている物件名（sent_properties・本文の【】🌟）と
//   突き合わせて、十分近いものがあればその名前に**寄せる**。無ければ**捨てる**（fail-closed）。
//   ＝ 読み取りのモデルが変わっても、この関門は同じように効く。

/**
 * 物件名の表記ゆれを吸収する。
 * ・先頭の「【1】」「①」「1.」などの番号を外す（sent_properties に実際に入っている）
 * ・全角英数→半角／全角スペース→半角／連続スペースを1つに
 * ・比較で意味を持たない記号（・･、。（）()「」-−ー_/）を外す
 */
export function normalizePropertyName(s: string | null | undefined): string {
  let t = (s ?? "").trim();
  if (!t) return "";
  t = t.replace(/^\s*(?:【\s*[0-9０-９]{1,2}\s*】|[①-⑳]|[0-9０-９]{1,2}\s*[.．)）])\s*/, "");
  t = t.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  // 比較のための正規化なので**空白も外す**（「porte bonheur(ポルトボヌール)」と
  // 「porte bonheur ポルトボヌール」を同じ物と見なす。表示には元の文字列を使う）
  t = t.replace(/[・･、。,，（）()「」『』\[\]【】\-−ー_/／　\s]/g, "");
  return t.toLowerCase();
}

/** 2文字のかたまりの集合（日本語の似ている度を測るのに向く） */
function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length === 1) { out.add(s); return out; }
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** 似ている度 0〜1（Dice 係数）。完全一致なら 1 */
export function similarity(a: string, b: string): number {
  const x = normalizePropertyName(a), y = normalizePropertyName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = bigrams(x), B = bigrams(y);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/**
 * 既知の物件名に寄せる閾値。**高めに引いて、迷うものは捨てる**（fail-closed）。
 *
 * 実測で線を引いた:
 *   記号・空白だけの違い「porte bonheur(ポルトボヌール)」↔「porte bonheur ポルトボヌール」 … 1.00
 *   Haiku の誤読「スプラッティド堀江」↔「スプランディッド堀江」                          … **0.47**
 *   別物「ファースネックス大阪Ⅱ」↔「アーバネックス本町Ⅱ」                              … 0.35
 * 誤読(0.47)と別物(0.35)が近すぎるので、その間に線は引けない。
 * → **誤読も寄せずに捨てる**。物件名を間違えて記録するより、記録しない方がまし
 *   （汚れた材料をブレインに渡すと、かえって文のすれ違いを生む）。
 * ※ Sonnet5 で読むと同じ物件は同じ名前で読めた（6/6）ので、実運用では取りこぼしは少ない。
 */
export const MATCH_MIN_SCORE = 0.7;

export type PropertyMatch = { name: string; score: number; exact: boolean };

/**
 * 読み取った物件名を既知の名前に寄せる。
 * @returns 十分近い既知の名前（無ければ null ＝ 記録しない）
 */
export function matchKnownProperty(
  read: string | null | undefined,
  known: ReadonlyArray<string>,
  minScore: number = MATCH_MIN_SCORE,
): PropertyMatch | null {
  const r = normalizePropertyName(read);
  if (!r || r.length < 2) return null;
  let best: PropertyMatch | null = null;
  for (const k of known) {
    const kn = normalizePropertyName(k);
    if (!kn) continue;
    const s = similarity(r, kn);
    if (s >= minScore && (!best || s > best.score)) best = { name: k.trim(), score: s, exact: s === 1 };
  }
  return best;
}

/**
 * 読み取り結果を「記録してよいか」まで含めて判定する。
 * 既知の名前が1つも無い会話では、**読み取った名前をそのまま使わない**（照合できないので捨てる）。
 * ＝ 誤読を DB に入れない側に倒す。
 */
export function resolveReadProperty(
  read: { propertyName?: string | null; roomNumber?: string | null },
  known: ReadonlyArray<string>,
): { propertyName: string; roomNumber: string } | null {
  const m = matchKnownProperty(read.propertyName, known);
  if (!m) return null;
  const room = (read.roomNumber ?? "").trim().replace(/^0+(?=\d)/, "").replace(/号室\s*$/, "");
  return { propertyName: m.name, roomNumber: room };
}
