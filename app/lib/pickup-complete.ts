// app/lib/pickup-complete.ts（純関数・DB も DeepSeek も使わない。画面・サーバー・テストで共用）
// 拡張でお客様の作業を終えた時（「確認」☑／「✅ 送った」）に、そのお客様の売上サポのピックアップ（リアプロ・itandi・レインズの全部の回）を
// 1つの「まとめ」（complete_group_id）にし、まとめた全件で順位と 👑 を付け直すための決まり。
//
// 2026-09-25 竹内（売上サポのスマホの画面を見て）「まとめられていない。スタッフモードで送った時は、拡張ツールはお客さんのところ完了ボタン押したら
//   リアプロと itandi の全部分析されるようにする。1件ずつごちゃごちゃしてて読みにくい」
//   → 今は merge-pdfs の1回（サイト・ページごと）が1バッチで、👑 も回ごと／直近6時間で別々に出ていた。
//     「完了」を押した時点で、前の完了より後（最大24時間）のまだまとめていない行を全部1つにまとめる。
// 決まり:
//   - 対象: そのお客様の行のうち complete_group_id が空で、押した時から COMPLETE_WINDOW_HOURS 以内に届いた物（状態は問わない＝送った物もまとめに入れる）
//   - まとめ ID: お客様と対象の一番古い行の id から決める（completeGroupId）。2台の PC が同時に押しても同じ ID になり、行の書き込みは
//     「complete_group_id が空の行だけ」なので、先に書いた方だけが行を取る（後の方は 0件＝二重に読まない）
//   - 順位: 外す候補は最後 → 判定の点（高い順・点なしは後）→ 画像の点 → 判定（通す＞保留）→ 🌟★/🌟 → 新しい回 → 元の順位 → id
//   - 👑: 画像で分析した点がある物件があれば pickCustomerBest（画面の 👑 と同じ並び）をまとめた全件に当てる。無ければ点の一番（外す候補・送付済みを除く）
import { pickCustomerBest, verdictOrder, okCountOf, type BestCandidateRow } from "./pickup-best";

/** 「完了」でまとめる行の古さの上限（時間）。前の完了より後の行は complete_group_id が空なので、実際は「前の完了以降・最大24時間」 */
export const COMPLETE_WINDOW_HOURS = 24;

export type CompleteSourceRow = {
  id: number;
  created_at: string;
  batch_id: string;
  site: string | null;
  status: string;
  complete_group_id: string | null;
};

export type CompleteTargets = {
  /** まとめる行（古い順） */
  ids: number[];
  batchIds: string[];
  /** サイトごとの件数（realpro / itandi / reins / 不明） */
  sites: Record<string, number>;
  /** 窓の中で、もう別のまとめに入っている行の数（前の完了の分） */
  alreadyGrouped: number;
  /** 窓の中で一番新しいまとめの ID（対象が 0 件の時に「もうまとめてある」と返すため） */
  latestGroupId: string | null;
};

const siteKey = (s: string | null | undefined): string => {
  const v = (s ?? "").toLowerCase();
  if (v.includes("itandi")) return "itandi";
  if (v.includes("reins")) return "reins";
  if (v.includes("real")) return "realpro";
  return v || "unknown";
};

/** まとめる行を選ぶ（純関数）。now は ms */
export function selectCompleteTargets(rows: ReadonlyArray<CompleteSourceRow>, now: number, windowHours = COMPLETE_WINDOW_HOURS): CompleteTargets {
  const since = now - windowHours * 3600_000;
  const inWindow = rows.filter((r) => { const t = Date.parse(r.created_at); return Number.isFinite(t) && t >= since && t <= now + 60_000; });
  const open = inWindow.filter((r) => !r.complete_group_id).sort((a, z) => (Date.parse(a.created_at) - Date.parse(z.created_at)) || (a.id - z.id));
  const grouped = inWindow.filter((r) => !!r.complete_group_id).sort((a, z) => Date.parse(z.created_at) - Date.parse(a.created_at) || z.id - a.id);
  const sites: Record<string, number> = {};
  for (const r of open) { const k = siteKey(r.site); sites[k] = (sites[k] ?? 0) + 1; }
  return {
    ids: open.map((r) => r.id),
    batchIds: [...new Set(open.map((r) => r.batch_id))],
    sites,
    alreadyGrouped: grouped.length,
    latestGroupId: grouped[0]?.complete_group_id ?? null,
  };
}

/**
 * まとめ ID（決まった形）。同じお客様・同じ一番古い行なら同じ ID ＝ 二重押し・2台の PC から同時に押しても同じまとめになる。
 * 形: cg_<お客様 id の先頭8文字>_<一番古い行の id>
 */
export function completeGroupId(propertyCustomerId: string, ids: ReadonlyArray<number>): string | null {
  if (!propertyCustomerId || !ids.length) return null;
  const first = Math.min(...ids);
  if (!Number.isFinite(first)) return null;
  return `cg_${propertyCustomerId.replace(/-/g, "").slice(0, 8)}_${first}`;
}

export type CompleteRankRow = BestCandidateRow & {
  site?: string | null;
  score?: number | null;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const matchOf = (r: CompleteRankRow): number | null => num(r.image_analysis?.match);

/** まとめた全件の並び（外す候補は最後 → 判定の点 → 画像の点 → 判定 → 🌟 → 新しい回 → 元の順位 → id） */
export function compareCompleteGroup(a: CompleteRankRow, z: CompleteRankRow): number {
  const dropA = a.verdict === "drop" ? 1 : 0, dropZ = z.verdict === "drop" ? 1 : 0;
  if (dropA !== dropZ) return dropA - dropZ;
  const sa = num(a.score), sz = num(z.score);
  if (sa != null && sz != null && sa !== sz) return sz - sa;
  if (sa == null && sz != null) return 1;
  if (sa != null && sz == null) return -1;
  const ma = matchOf(a), mz = matchOf(z);
  if (ma != null && mz != null && ma !== mz) return mz - ma;
  if (ma == null && mz != null) return 1;
  if (ma != null && mz == null) return -1;
  return (okCountOf(z.image_analysis ?? null) - okCountOf(a.image_analysis ?? null))
    || (verdictOrder(a) - verdictOrder(z))
    || ((z.recommended ?? 0) - (a.recommended ?? 0))
    || (Date.parse(z.created_at) - Date.parse(a.created_at))
    || (a.rank - z.rank)
    || (a.id - z.id);
}

export type CompleteRanking = {
  /** まとめの中の順位（1から） */
  order: Array<{ id: number; complete_rank: number }>;
  /** 👑（まとめた全件の一番）。候補が無ければ null */
  bestId: number | null;
  /** 👑 の決め方: image＝画像で分析した点（画面の 👑 と同じ）／score＝判定の点の一番 */
  bestBasis: "image" | "score" | null;
  bestMatch: number | null;
  bestScore: number | null;
  /** まとめた回の数・件数 */
  batches: number;
  items: number;
  /** 点（画像）が付いた件数・まだ分析していない件数 */
  imageScored: number;
  notAnalyzed: number;
};

/** まとめた全件で順位と 👑 を付け直す（純関数） */
export function rankCompleteGroup(rows: ReadonlyArray<CompleteRankRow>): CompleteRanking {
  const sorted = rows.slice().sort(compareCompleteGroup);
  const order = sorted.map((r, i) => ({ id: r.id, complete_rank: i + 1 }));
  // 画像の点で 👑（画面と同じ pickCustomerBest。窓はまとめ全体＝48時間で切らない。未送信の行だけ）
  const img = rows.length ? pickCustomerBest(rows, { windowHours: COMPLETE_WINDOW_HOURS * 2 + 1 }) : null;
  let bestId: number | null = null, bestBasis: CompleteRanking["bestBasis"] = null;
  if (img) { bestId = img.id; bestBasis = "image"; }
  else {
    const top = sorted.find((r) => r.status === "pending" && r.verdict !== "drop" && num(r.score) != null);
    if (top) { bestId = top.id; bestBasis = "score"; }
  }
  const best = bestId != null ? rows.find((r) => r.id === bestId) ?? null : null;
  return {
    order, bestId, bestBasis,
    bestMatch: best ? matchOf(best) : null,
    bestScore: best ? num(best.score) : null,
    batches: new Set(rows.map((r) => r.batch_id)).size,
    items: rows.length,
    imageScored: rows.filter((r) => matchOf(r) != null).length,
    notAnalyzed: rows.filter((r) => !r.image_analysis).length,
  };
}

/** 拡張のトーストに出す短い文（件数だけ・お客様の名前は出さない） */
export function completeToastJa(r: { claimed: number; sites: Record<string, number>; already?: boolean; skipped?: string | null }): string {
  if (r.skipped === "brain_off") return "";
  if (r.claimed <= 0) return r.already ? "売上サポ: もうまとめてあります（新しいピックアップなし）" : "売上サポ: まとめる新しいピックアップはありません";
  const label: Record<string, string> = { realpro: "リアプロ", itandi: "itandi", reins: "レインズ" };
  const parts = Object.entries(r.sites).filter(([, n]) => n > 0).map(([k, n]) => `${label[k] ?? k} ${n}件`);
  return `売上サポにまとめました: ${parts.join("・") || `${r.claimed}件`}（分析と順位の付け直しは1〜3分で反映）`;
}

/**
 * 完了の API の認証（純関数）。
 *   - アプリ・scripts: 既存の内部認証（Authorization: Bearer INTERNAL_API_SECRET）＝ requireInternalAuth と同じ
 *   - 拡張: 拡張には秘密を書けない（ハードコード禁止）ので、自動化の API（/api/automation/*）と同じ x-automation-key
 *     （拡張の chrome.storage.local.automationApiKey）。サーバーに AUTOMATION_API_KEY が無い時は自動化の API と同じく通す
 *   ⚠ ここで動くのは「そのお客様の売上サポの行をまとめて、まだ読んでいない物件を読む」だけ（最大20件・保存済みは読まない）
 */
export function completeAuthOk(h: { authorization: string | null; automationKey: string | null }, env: { internalSecret?: string | null; automationKey?: string | null }): boolean {
  if (env.internalSecret && h.authorization === `Bearer ${env.internalSecret}`) return true;
  if (env.automationKey) return h.automationKey === env.automationKey;
  return true;
}
