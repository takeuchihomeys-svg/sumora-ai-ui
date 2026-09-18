// app/lib/phrase-shape.ts
// 生成文と実送信を「言い回しの型」で突き合わせるための整形（純関数・DB 依存なし）。
//
// 2026-09-18 竹内「型との距離を測る仕組み」:
//   これまで「よくわからん文」は、竹内さんが画面で気付いて指摘 → 私が実データを数える、の繰り返しだった。
//   （物件名が混ざる／複数の／全力サポートの連発／重複しないよう選定…）
//   どれも最後は同じ形に行き着く＝**その言い回しがスタッフ実送信に何件あるか**。0件なら創作。
//   それを毎回手で数えるのをやめ、生成文から言い回しを取り出して自動で突き合わせる。
//
// 設計知見に従った作り:
//   ・「語の出現で作らず、実データの全件を ◯× で並べて外すべき型を足していく」
//     → 検出結果は**列挙するだけ**で自動では落とさない（落とす線は人が見て引く）
//   ・「件数を必ず出す（0件・1件・多数）」→ 実送信の件数を必ず添える
//
// 日本語は**述部が末尾に来る**ので、言い回しの型は節の末尾に出る:
//   「お手隙の際にご査収ください」→「ご査収ください」（実送信 1,136件）
//   「前回お送りした物件とは重複しないよう選定しております」→「選定しております」（実送信 0件）

/** 絵文字・装飾・記号 */
const DECOR_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}★☆♪●○◆◇■□▲△▼▽]/gu;
/** 数値を含む表現（家賃・帖・号室・日付・徒歩分・㎡・％） */
const NUMERIC_EXPR_RE =
  /[0-9０-９][0-9０-９,，.．]*\s*(?:円|万|帖|畳|号室|号|階|部屋|件|名|人|月|日|年|分|時|㎡|平米|%|％|LDK|DK|K|R)?/g;
/** お客様の呼びかけ（「YUMAさん」「田中様」） */
const ADDRESS_RE = /[^\s、,。！!？?]{1,12}(?:さん|サン|様|さま)/g;
/** 括弧の中身（オススメポイント等の箇条書きの補足） */
const PAREN_RE = /[（(][^）)]{0,40}[）)]/g;

/** 節に切る（句読点・改行で。日本語の言い回しの単位） */
export function splitClauses(text: string): string[] {
  return (text ?? "")
    .split(/[\n。！!？?]+/)
    .flatMap((s) => s.split(/、/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

/**
 * 会話ごとに変わる部分（物件名・数字・お客様名・絵文字）を落として、言い回しの骨格だけにする。
 * 物件名は固有名詞なので完全には取れないが、**述部を取る**目的には十分（述部に固有名詞は来ない）。
 */
export function maskVariables(clause: string): string {
  return (clause ?? "")
    .replace(DECOR_RE, "")
    .replace(PAREN_RE, "")
    .replace(ADDRESS_RE, "")
    .replace(NUMERIC_EXPR_RE, "")
    .replace(/[A-Za-z]{2,}/g, "")       // ローマ字の物件名
    .replace(/[・／/\-–—~〜]+/g, "")
    .replace(/\s+/g, "")
    .trim();
}

/** 述部の頭に来ると意味をなさない字（ここから始まる切り出しは1つ前へずらす） */
const BAD_HEAD_RE = /^(?:て|で|に|を|が|は|の|も|と|や|か|ば|ら|れ|り|っ|ん|、|,)/;

/**
 * 節の末尾から言い回しの型（述部）を取る。
 * 日本語は述部が末尾に来るので、ここが「その言い方をするかどうか」の指紋になる。
 * len は取り出す長さ（既定8字）。助詞で始まる切り方は避ける。
 */
export function predicateOf(clause: string, len = 8): string | null {
  const m = maskVariables(clause);
  if (m.length < 4) return null;
  if (m.length <= len) return m;
  for (let l = len; l <= Math.min(len + 4, m.length); l++) {
    const cand = m.slice(m.length - l);
    if (!BAD_HEAD_RE.test(cand)) return cand;
  }
  return m.slice(m.length - len);
}

/**
 * 述部（動詞・助動詞で終わる）らしいか。
 * 2026-09-18 本番の点検で、物件名・駅名の断片（「ンフラッツ心斎橋」「大国町駅徒歩」「専有面積）」）が
 *   「実送信0件」として大量に出た。固有名詞は会話ごとに違うので照合しても意味がない。
 *   **言い回し**（どう言うか）を測りたいので、述部で終わるものだけを対象にする。
 */
const PREDICATE_TAIL_RE =
  /(?:ます|ました|ません|ませんか|ましょうか|です|でした|ですが|ください|下さい|おります|ております|いたします|致します|頂きます|いただきます|可能|ない|たい|よう|しました|される|できます|出来ます)$/;

export function isPredicateLike(s: string): boolean {
  // 末尾の絵文字・記号・句読点を落としてから見る（「ご案内可能です😊！！」）
  const tail = (s ?? "").replace(DECOR_RE, "").replace(/[！!。、,）)\s]+$/, "");
  return PREDICATE_TAIL_RE.test(tail);
}

export type PhraseShape = {
  /** 実送信と突き合わせる語（述部） */
  predicate: string;
  /** 元の節（人が読んで判断するため・設計知見「全件を並べて目で見る」） */
  clause: string;
};

/**
 * 文から「実送信と突き合わせる言い回し」を取り出す（重複は畳む）。
 * predicateOnly（既定 true）で、述部で終わるものだけにする＝固有名詞・物件情報の断片を除く。
 */
export function extractPhraseShapes(text: string, len = 8, predicateOnly = true): PhraseShape[] {
  const seen = new Set<string>();
  const out: PhraseShape[] = [];
  for (const clause of splitClauses(text)) {
    const predicate = predicateOf(clause, len);
    if (!predicate || predicate.length < 4) continue;
    if (predicateOnly && !isPredicateLike(clause)) continue;
    if (seen.has(predicate)) continue;
    seen.add(predicate);
    out.push({ predicate, clause });
  }
  return out;
}

/**
 * 実送信の件数と突き合わせた結果。
 * 落とす・落とさないはここでは決めない（設計知見「自動で落とさず、線は人が見て引く」）。
 */
export type PhraseVerdict = PhraseShape & {
  /** スタッフ実送信での件数 */
  sentCount: number;
  /** 生成側での出現回数 */
  generatedCount: number;
};

/** 実送信0件＝こちらが一度も使ったことのない言い回し（創作の候補） */
export function isUnseenPhrase(v: PhraseVerdict): boolean {
  return v.sentCount === 0;
}
