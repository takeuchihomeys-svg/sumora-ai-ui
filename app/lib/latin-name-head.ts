// app/lib/latin-name-head.ts（純関数・依存なし・画面とサーバで共用）
// 英字の語が空白で並ぶ物件名（「Park Lane Minami 1302号室」「GRAN TOYONAKA 102号室」「Tio Fleur 102号室」）を、
//   「空白を含まない名前＋号室」の正規表現で読むと最後の語だけ（「Minami」「TOYONAKA」「Fleur」）になる。
// 2026-10-15 実データ（スタッフの文 180日・「号室」を含む 1,983通・2,164か所）: 名前の直前が「英字の語＋空白」の所 189（8.7%）
//   ＝待ち合わせの物件の先入れ（aix-prefill）・内覧の物件の先入れ（aix-autofill-readiness）・送った物件の名前（customer-mindset）・下書きの照らし（draft-fact-grounding）で名前が欠けていた。
// ここは読んだ名前の前に、空白1つずつで続く語を足して戻すだけ（足すのは名前か直前の語に英字がある時・平仮名だけの語・区切りの字・改行・2つ以上の空白で止まる・6語・40字まで）。
// 戻す: LATIN_NAME_HEAD=off

export function latinNameHeadEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.LATIN_NAME_HEAD ?? env.NEXT_PUBLIC_LATIN_NAME_HEAD ?? "").trim().toLowerCase() !== "off";
}

const LATIN_RE = /[A-Za-zＡ-Ｚａ-ｚ]/;
/** 名前の語の尻（区切りの字・印・時刻の字を含まない並び） */
const TAIL_TOKEN_RE = /([^\s／/、。！!？?「」『』・〜~～:：【】()（）[\]🌟★☆♪]+)$/u;
const HIRAGANA_ONLY_RE = /^[ぁ-ゖー]+$/;
const ONE_SPACE_RE = /[ 　]$/;

/**
 * text の start の位置から始まる名前 name の前に、空白1つで続く語を足す（英字の物件名の頭）。
 *   「【URBAN PARK難波南 602号室」の start が「PARK」なら「URBAN PARK難波南」。改行・2つ以上の空白・区切りの字で止まる
 */
export function withLatinHead(text: string, start: number, name: string, env?: Record<string, string | undefined>): string {
  if (!name || !latinNameHeadEnabled(env)) return name;
  let rest = String(text ?? "").slice(0, Math.max(0, start));
  const head: string[] = [];
  let len = Array.from(name).length;
  while (head.length < 6) {
    if (!ONE_SPACE_RE.test(rest)) break;
    const r = rest.slice(0, -1);
    if (ONE_SPACE_RE.test(r)) break; // 2つ以上の空白
    const m = r.match(TAIL_TOKEN_RE);
    if (!m) break;
    let tok = m[1];
    if (HIRAGANA_ONLY_RE.test(tok)) break;
    // 文に続けて書いた名前（「お部屋の中でも特にJ's Garden」）: 語の中の最後の平仮名より後ろだけを名前にして、そこで止める
    const kana = tok.match(/^.*[ぁ-ゖ]([^ぁ-ゖ]+)$/u);
    if (kana) {
      tok = kana[1];
      if (!LATIN_RE.test(tok) && !LATIN_RE.test(head[0] ?? name)) break;
      if (len + Array.from(tok).length + 1 > 40) break;
      head.unshift(tok);
      break;
    }
    // 足すのは、この語か、すぐ後ろ（名前・足した語）に英字がある時だけ
    if (!LATIN_RE.test(tok) && !LATIN_RE.test(head[0] ?? name)) break;
    if (len + Array.from(tok).length + 1 > 40) break;
    head.unshift(tok);
    len += Array.from(tok).length + 1;
    rest = r.slice(0, r.length - tok.length);
  }
  // 英字の無い語は英字の語に挟まれた時だけ残す（「Park Hills 難波南 Lumiere」は残す・「お部屋 Tio Grace」の「お部屋」は外す）
  while (head.length && !LATIN_RE.test(head[0])) head.shift();
  return head.length ? `${head.join(" ")} ${name}` : name;
}
