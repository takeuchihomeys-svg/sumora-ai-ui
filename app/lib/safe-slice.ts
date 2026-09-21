/**
 * サロゲートペア（絵文字等）を途中で切断しないslice。
 * String.prototype.slice はUTF-16コードユニット単位で切るため、
 * 上限がちょうど絵文字の中間に当たると不正なサロゲート片（�）が残り、
 * LLMプロンプト・embedding入力・DB保存文字列を汚染する。
 * 末尾がハイサロゲート（上位サロゲート）の場合は1コードユニット削って返す。
 */
export function safeSlice(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  const sliced = str.slice(0, maxLen);
  // 末尾がハイサロゲート（上位サロゲート）なら1文字削る
  const lastChar = sliced.charCodeAt(sliced.length - 1);
  if (lastChar >= 0xd800 && lastChar <= 0xdbff) {
    return sliced.slice(0, -1);
  }
  return sliced;
}

// ─── 2026-09-21: 壊れた絵文字が1つでも混ざると**生成が丸ごと失敗する** ──────────────
// YUMA の本番経路テストで3回とも 400 になった:
//   "The request body is not valid JSON: no low surrogate in string: line 1 column 55656"
// ＝ プロンプトのどこかに絵文字の片割れ（前半だけ／後半だけ）が入っていて、
//    Anthropic API が JSON として受け取れない。下書きは「生成に失敗しました」になる。
//
// ⚠ DB 側は無傷だった（scripts/audit-broken-surrogate.ts で ai_reply_knowledge 11,212行・
//   ai_reply_examples 6,820行を見て 0件）。つまり**コードのどこかで切った時に割れている**。
//   safeSlice を使っていない `slice(0, N)` が1か所でもあれば起きる。
//
// 原因箇所を1つずつ潰すのは時間がかかり、その間ずっと生成が落ちるので、
// **送る直前に落とす関門**を置く（設計知見「壊れていたら自動で安全に壊れる形にする」）。
// 落とすのは片割れだけなので、正しい絵文字は1文字も消えない。

/** 片割れのサロゲート（壊れた絵文字）が含まれているか */
export function hasBrokenSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (n >= 0xdc00 && n <= 0xdfff) { i++; continue; }
      return true;                 // 後半が無い前半
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;   // 前半が無い後半
  }
  return false;
}

/**
 * 片割れのサロゲートだけを落とす（正しい絵文字はそのまま）。
 * API に送る直前・embedding に入れる直前で通す。
 */
export function stripBrokenSurrogates(s: string): string {
  if (!s || !hasBrokenSurrogate(s)) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (n >= 0xdc00 && n <= 0xdfff) { out += s[i] + s[i + 1]; i++; continue; }
      continue;                    // 後半が無い前半は捨てる
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;      // 前半が無い後半も捨てる
    out += s[i];
  }
  return out;
}
