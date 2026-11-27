// app/lib/site-key.ts — サイトの呼び名を3つにそろえる、ここが唯一の正本（2026-11-26）。
//
// 竹内さん「リアプロと ITANDI をごちゃごちゃにしない仕組み」。サイトの呼び名は
// 「realpro（リアプロ）」「itandi」「reins（レインズ）」の3つ。DB の site 列・売上サポ・検索の点検は realpro を使い、
// 拡張・コマンド（automation_commands.sites）は realnetpro を使う（2つの呼び名がある）。
// 以前は同じ変換が8か所以上にコピーされていた（siteKey・normalizeSite・pickupSiteOf・siteOfCommand…）。
// ずれると「リアプロの値が ITANDI の回に入る」「ITANDI の結果がリアプロの点検に数えられる」が起きるので、
// ここだけに置く。ほかのファイルでは `=== "realnetpro"` のような比べ方を書かない（見張り: site-split-guard.test.js ④）。
//
// 知らない値は null（＝どのサイトでもない）。大文字小文字・前後の空白は無視する。

export type SiteKey = "realpro" | "itandi" | "reins";
/** 拡張・コマンド（automation_commands.sites）の呼び名 */
export type CommandSiteKey = "realnetpro" | "itandi" | "reins";

/** サイトの呼び名 → 3つのどれか。知らない値は null。 */
export function siteKeyOf(s: string | null | undefined): SiteKey | null {
  const v = String(s ?? "").trim().toLowerCase();
  if (v === "realpro" || v === "realnetpro" || v === "リアプロ") return "realpro";
  if (v === "itandi") return "itandi";
  if (v === "reins" || v === "レインズ") return "reins";
  return null;
}

/** サイトの呼び名 → コマンド（拡張）の呼び名。リアプロだけ realnetpro に変わる。知らない値は null。 */
export function commandSiteKeyOf(s: string | null | undefined): CommandSiteKey | null {
  const k = siteKeyOf(s);
  if (k === "realpro") return "realnetpro";
  if (k === "itandi") return "itandi";
  if (k === "reins") return "reins";
  return null;
}
