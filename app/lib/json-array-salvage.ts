// app/lib/json-array-salvage.ts
// 途中で切れた JSON 配列から、**完結している要素だけ**を拾う（純関数・DB 依存なし）。
//
// 2026-09-21 竹内「なにかエラー起きている部分あるのか調査」で見つけた物:
//   /api/cron/rule-organize（毎週日曜21:00）は Opus に30件ずつルールを判定させているが、
//   本番ログ（2026-09-20T21:00-21:05）で **7回中6回が stop_reason=max_tokens**（出力4096/4096ちょうど）。
//   受け側は `rawText.match(/\[[\s\S]*\]/)` で閉じ括弧 `]` を要求していたため、
//   切れた回は**バッチ丸ごと捨てられていた**（判定は1件も反映されない）。
//   さらにその後 300秒でタイムアウトし、Step5（反映）に到達せず**その週の整理が全部無効**だった。
//
// 直し方は2つ:
//   ① 出力の枠を広げる（max_tokens 4096 → 8192）＝そもそも切らさない
//   ② それでも切れた時に**完結している要素だけ拾う**＝この関数（捨てない）
//
// 「全部か無か」をやめる。30件中20件まで読めていたら、その20件は使う。
export type LooseParse<T> = {
  /** 完結して読めた要素 */
  items: T[];
  /** 閉じ括弧に届かなかった（＝出力が途中で切れた） */
  truncated: boolean;
  /** 配列そのものが見つからなかった */
  noArray: boolean;
};

/**
 * JSON 配列を「読めるところまで」読む。
 * ・先頭の ```json 等の囲みは無視する（最初の `[` から見る）
 * ・文字列の中の `{` `}` `[` `]` とエスケープを正しく数える
 * ・要素が壊れていればその要素だけ捨てて次へ進む
 */
export function parseJsonArrayLoose<T = unknown>(raw: string): LooseParse<T> {
  const s = raw ?? "";
  const start = s.indexOf("[");
  if (start < 0) return { items: [], truncated: false, noArray: true };

  const items: T[] = [];
  let depth = 0;          // { } の深さ
  let objStart = -1;      // 今読んでいる要素の開始位置
  let inStr = false;      // 文字列の中か
  let esc = false;        // 直前がバックスラッシュか
  let closed = false;     // 配列が ] で閉じたか

  for (let i = start + 1; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") { if (depth === 0) objStart = i; depth++; continue; }
    if (c === "}") {
      depth--;
      if (depth === 0 && objStart >= 0) {
        const chunk = s.slice(objStart, i + 1);
        try { items.push(JSON.parse(chunk) as T); } catch { /* 壊れた要素は捨てて次へ */ }
        objStart = -1;
      }
      continue;
    }
    if (c === "]" && depth === 0) { closed = true; break; }
  }
  // depth > 0 のまま終わった＝最後の要素が途中で切れている（その要素は拾わない）
  return { items, truncated: !closed, noArray: false };
}
