// app/lib/search-audit-ghost.ts — 点検（search_audits）の「幽霊の行」を見分ける（純関数・DB も fetch も無し）
//
// 2026-09-30 本番（search_audits 9/30・ITANDI の一括の回すべて）:
//   background の axlx-switch-customer 1回を popup の2つの受け口（underbar の中継・chrome.runtime.onMessage）が受け、
//   自動入力のボタンを2回押していた。2本目は点検の文脈（run_id・種類・命令）が1本目に使われた後なので、
//   新しい run_id・trigger="single"・command_id なしの行が、一括の行の 6〜13秒後に同じお客様・同じサイトで出来た（＝幽霊の行）。
//   例: id 249（web_brain・16:22:53）→ 250（single・16:23:06・watchdog-timeout）／ 252 → 253／ 258 → 259／ 265 → 266／ 275 → 276
//   拡張は v2.5.48 で受け口を1本にしたが、古い版の PC が残る間と過去の行のために、読む側でも数えない:
//     ・前回の検索（lastCompleteSearches＝更新日の計画・古い行で止める線）: 幽霊の行を「最後に終わった検索」にしない
//     ・まとめを待つ判定（searchHold）: 幽霊の行で「検索中」「まだ始まっていないサイト」を決めない
//     ・見張り: 幽霊の行には DOUBLE_FILL の札（bad）＝同じ自動入力が2本走った

/** 一括の行からこの時間以内に出た single を幽霊とみなす（実測 6〜13秒・popup の読み直し 6秒＋人の間を含めて余裕） */
export const GHOST_WINDOW_MS = 40_000;

export type GhostRowLite = {
  property_customer_id?: string | null;
  site?: string | null;
  trigger?: string | null;
  command_id?: string | null;
  created_at?: string | null;
  run_id?: string | null;
};

const siteKey = (s: string | null | undefined): string => {
  const v = String(s ?? "").toLowerCase();
  if (v.includes("itandi")) return "itandi";
  if (v.includes("reins")) return "reins";
  if (v.includes("real")) return "realpro";
  return v;
};
const at = (s: string | null | undefined) => Date.parse(String(s ?? ""));

/** 一括・自動の回の行か（命令がある、または種類が single でない） */
function isBatchRow(r: GhostRowLite): boolean {
  const t = String(r.trigger ?? "");
  return !!r.command_id || (!!t && t !== "single");
}

/**
 * row が幽霊の行なら、元の一括の行を返す（無ければ null）。
 *   条件: row は trigger=single・command_id なし／同じお客様・同じサイトの一括の行が、row の 0〜GHOST_WINDOW_MS 前にある。
 *   お客様の分からない行・時刻の読めない行は幽霊にしない（迷ったら数える側）
 */
export function ghostSourceOf<T extends GhostRowLite>(row: GhostRowLite, rows: ReadonlyArray<T>, windowMs: number = GHOST_WINDOW_MS): T | null {
  if (String(row.trigger ?? "") !== "single" || row.command_id) return null;
  const cid = String(row.property_customer_id ?? "");
  const t = at(row.created_at);
  if (!cid || !Number.isFinite(t)) return null;
  const site = siteKey(row.site);
  let best: T | null = null;
  for (const o of rows) {
    if (o === row || (row.run_id && o.run_id === row.run_id)) continue;
    if (String(o.property_customer_id ?? "") !== cid || siteKey(o.site) !== site || !isBatchRow(o)) continue;
    const gap = t - at(o.created_at);
    if (!(gap >= 0 && gap <= windowMs)) continue;
    if (!best || at(o.created_at) > at(best.created_at)) best = o;
  }
  return best;
}

export function isGhostSingle(row: GhostRowLite, rows: ReadonlyArray<GhostRowLite>, windowMs: number = GHOST_WINDOW_MS): boolean {
  return ghostSourceOf(row, rows, windowMs) !== null;
}

/** 幽霊の行を除いた一覧（順はそのまま） */
export function dropGhostSingles<T extends GhostRowLite>(rows: ReadonlyArray<T>, windowMs: number = GHOST_WINDOW_MS): T[] {
  return rows.filter((r) => !isGhostSingle(r, rows, windowMs));
}
