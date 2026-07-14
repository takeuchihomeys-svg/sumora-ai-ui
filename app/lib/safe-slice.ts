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
