// app/lib/example-db-guard.ts — 手本の保存と AI の答えの JSON 読みの守り（純関数・既定 on）
//
// 2026-11-20 作業員L（統括役の頼み）:
//   ① /api/save-reply-example で「Empty or invalid json」が3回（11/20 16:50 JST・同じ送信の再試行）。台帳 #373 と同じ形＝欄の中の絵文字の片割れ。
//      文字の切り出しは Array.from の単位（clipChars）にし、書く直前に db-json-sanitize で片割れ・\u0000 を落とす。戻す EXAMPLE_DB_JSON_GUARD=off
//   ② /api/extract-estimate-info で AI の答えの JSON の後ろに余計な文字（2つ目の {…} や説明）が付き、貪欲な /\{[\s\S]*\}/ が後ろまで拾って
//      JSON.parse が落ちた（11/20 16:55 JST・position 1300 line 37）。最初の { から対応する } まで（文字列の中の括弧は数えない）を取り出す。
//      戻す ESTIMATE_JSON_FIRST_OBJECT=off

type Env = Record<string, string | undefined>;
const envOf = (env?: Env): Env => env ?? (typeof process !== "undefined" ? process.env : {});

export function exampleDbGuardOn(env?: Env): boolean {
  return (envOf(env).EXAMPLE_DB_JSON_GUARD ?? "on").trim().toLowerCase() !== "off";
}
export function estimateJsonFirstObjectOn(env?: Env): boolean {
  return (envOf(env).ESTIMATE_JSON_FIRST_OBJECT ?? "on").trim().toLowerCase() !== "off";
}

/** 文字（コードポイント）の単位で先頭 n 字。絵文字を途中で切らない */
export function clipChars(s: string | null | undefined, n: number): string {
  return Array.from(String(s ?? "")).slice(0, Math.max(0, n)).join("");
}

/**
 * 最初の { から、対応する } までを返す（文字列 "…" の中の括弧・\" は数えない）。閉じていなければ null。
 * ```json の囲みや前置き・後ろの説明・2つ目の {…} があっても、最初の1つだけを取る。
 */
export function firstJsonObject(raw: string | null | undefined): string | null {
  const s = String(raw ?? "");
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === "\"") inStr = false;
      continue;
    }
    if (c === "\"") inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}
