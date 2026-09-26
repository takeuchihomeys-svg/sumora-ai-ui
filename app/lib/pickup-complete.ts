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
//   - 👑: pickCustomerBest（画面の 👑 と同じ純関数）をまとめた全件に当てる。2026-09-25 からお客様ごとの basis で
//     （画像で分析が必要なお客様＝画像の点・不要なお客様＝判定の点。決まりの表は pickup-best.ts の先頭）。👑 はまとめの順位でも1番にする
//
// 2026-09-25 竹内「スタッフモードで最終更新した10分間物件がなければ、その間の物件でまとめることできるか。毎回完了押すよりも、
//   最後にスタッフモードで指定したお客さん（例 YUMA さん物件完了後）10分たてば自動的に送られた物件まとめて、ほかの一括検索や自動モードのときのようにまとめて判定する」
//   → 10分の自動まとめ（autoCompleteDue / isQuietFor）: そのお客様のまだまとめていない行のうち一番新しい行（created_at＝売上サポに届いた時刻）から
//     AUTO_COMPLETE_QUIET_MINUTES 分、新しい行が届かなければ「完了」と同じまとめをする。「完了」ボタンは残す（すぐまとめたい時用）。
//   - 対象はブレイン ON の回＝property_pickups の全行（行があるのはブレイン ON の時だけ・merge-pdfs の brain_mode）。
//     🧠×通常・🧠×AIX の自動便・一括検索の回にもかける: 行にモードの印が無く見分けられない上、一括検索もお客様ごとにサイトを続けて回すので
//     （background.js の _runBatch: お客様 → サイトの二重ループ）同じお客様のリアプロ・itandi・レインズは数分おきに続けて届き、10分の静けさで1つに寄る。
//     1回ずつ届いた回を寄せても順位と 👑 が「まとめた全件」になるだけで、送った物・判定は変えない（悪くならない）
//   - 境目: ちょうど10分（now − 最後 ＝ 600000ms）でまとめる（>=）。未来の時刻（時計のずれ）はまとめない
import { pickCustomerBest, verdictOrder, okCountOf, type BestCandidateRow, type BestBasis } from "./pickup-best";

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

/** 👑 の窓（まとめ全体を切らない長さ）。画面がまとめた回の 👑 を出し直す時も同じ値で呼ぶ */
export const COMPLETE_BEST_WINDOW_HOURS = COMPLETE_WINDOW_HOURS * 2 + 1;

/**
 * まとめた全件で順位と 👑 を付け直す（純関数）。
 * basis: お客様の決まり（bestBasisFor(customerImageNeed(...))）。省略は image（前の動き）
 */
export function rankCompleteGroup(rows: ReadonlyArray<CompleteRankRow>, opts?: { basis?: BestBasis }): CompleteRanking {
  const sorted = rows.slice().sort(compareCompleteGroup);
  // 👑（画面と同じ pickCustomerBest・同じ basis。窓はまとめ全体で切らない。未送信の行だけ）
  const pick = rows.length ? pickCustomerBest(rows, { windowHours: COMPLETE_BEST_WINDOW_HOURS, basis: opts?.basis ?? "image" }) : null;
  const bestId: number | null = pick?.id ?? null;
  const bestBasis: CompleteRanking["bestBasis"] = pick?.basis ?? null;
  // 👑 はまとめの順位でも1番（順位の1番と 👑 が別の物件だと、どちらが一番か読めない）。残りは compareCompleteGroup の並び
  const ordered = bestId != null ? [...sorted.filter((r) => r.id === bestId), ...sorted.filter((r) => r.id !== bestId)] : sorted;
  const order = ordered.map((r, i) => ({ id: r.id, complete_rank: i + 1 }));
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

// ── 10分の自動まとめ（2026-09-25）─────────────────────────────────────────────

/**
 * 最後に届いた行から何分、新しい行が届かなければ自動でまとめるか。
 * 2026-09-26 竹内「物件検索全部完了してから分析するようにする。最後の完了してから1分後にまとめて分析した方が効率良い」→ 10分 → 3分。
 *   実測（scripts/audit-pickup-arrivals.ts・9/24〜26 本番 16回・6ラウンド）: 1回の検索が分かれて届く間隔は 6〜23秒が9/10・最大 122秒
 *   （リアプロの一括は 2件ずつ 7回に分かれて届いた例あり）。1分だと 122秒の間で割れる → 3分（観測の最大の約1.5倍）。
 *   Cron は2分おきなので実際は最後の物件から 3〜5分でまとまる。3分を過ぎて同じ回の物件が届いた時は joinableGroupId で
 *   前のまとめに足して順位と 👑 を付け直す（割れない）。拡張の alarm（10分半）はそのまま＝後から来ても「もうまとめてある」で何もしない
 */
export const AUTO_COMPLETE_QUIET_MINUTES = 3;
export const AUTO_COMPLETE_QUIET_MS = AUTO_COMPLETE_QUIET_MINUTES * 60_000;

/** 後から届いた回を前のまとめに足してよい間（画面のまとめの回 groupPickupRounds と同じ 30分・最初の行から3時間） */
export const LATE_JOIN_GAP_MS = 30 * 60_000;
export const LATE_JOIN_MAX_SPAN_MS = 3 * 60 * 60_000;

/**
 * まとめた後に同じ回の物件が届いた時、前のまとめ（complete_group_id）に足すか（純関数）。
 * まだまとめていない行の一番古い行が、一番新しいまとめの最後の行から gapMs 以内・そのまとめの最初の行から maxSpanMs 以内なら、そのまとめ ID。
 * 画面は同じお客様の回を 30分の間で1つの吹き出しに寄せる（groupPickupRounds）ので、まとめもそれに合わせる（👑 が2つに割れない）。
 */
export function joinableGroupId(rows: ReadonlyArray<Pick<CompleteSourceRow, "id" | "created_at" | "complete_group_id">>, gapMs = LATE_JOIN_GAP_MS, maxSpanMs = LATE_JOIN_MAX_SPAN_MS): string | null {
  const at = (r: { created_at: string }) => Date.parse(r.created_at);
  const open = rows.filter((r) => !r.complete_group_id && Number.isFinite(at(r)));
  const grouped = rows.filter((r) => !!r.complete_group_id && Number.isFinite(at(r)));
  if (!open.length || !grouped.length) return null;
  const firstOpen = Math.min(...open.map(at));
  // 一番新しいまとめ（最後の行の時刻で比べる）
  const latest = grouped.reduce((a, r) => (at(r) > at(a) || (at(r) === at(a) && r.id > a.id) ? r : a));
  const gid = latest.complete_group_id as string;
  const members = grouped.filter((r) => r.complete_group_id === gid).map(at);
  const gFirst = Math.min(...members), gLast = Math.max(...members);
  if (firstOpen < gLast) return null;   // まとめより前に届いた行がある（順番が崩れている）→ 足さない
  if (firstOpen - gLast > gapMs) return null;
  const openLast = Math.max(...open.map(at));
  if (openLast - gFirst > maxSpanMs) return null;
  return gid;
}

/** 最後に届いた時刻から quietMs 経ったか（ちょうどは経った扱い・未来の時刻は経っていない） */
export function isQuietFor(lastAtMs: number, now: number, quietMs = AUTO_COMPLETE_QUIET_MS): boolean {
  if (!Number.isFinite(lastAtMs) || !Number.isFinite(now)) return false;
  return now - lastAtMs >= quietMs;
}

/** まだまとめていない行（complete_group_id が空）の一番新しい届いた時刻（ms）。無ければ null */
export function lastOpenAt(rows: ReadonlyArray<Pick<CompleteSourceRow, "created_at" | "complete_group_id">>): number | null {
  let last: number | null = null;
  for (const r of rows) {
    if (r.complete_group_id) continue;
    const t = Date.parse(r.created_at);
    if (Number.isFinite(t) && (last == null || t > last)) last = t;
  }
  return last;
}

export type AutoCompleteRow = { id: number; created_at: string; property_customer_id: string | null; complete_group_id: string | null };
export type AutoCompleteCustomer = { property_customer_id: string; open: number; last_at: string; due_at: string };

/**
 * 自動でまとめる時が来たお客様を選ぶ（純関数）。rows は全お客様の行（直近 COMPLETE_WINDOW_HOURS）。
 *   due: まだまとめていない行があり、その一番新しい行から quietMs 経った（古い順＝待たせている順）
 *   waiting: まだ届き続けているかもしれない（due_at が来たら due になる）
 * 窓（24時間）より古い行は「完了」と同じく拾わない
 */
export function autoCompleteDue(rows: ReadonlyArray<AutoCompleteRow>, now: number, quietMs = AUTO_COMPLETE_QUIET_MS, windowHours = COMPLETE_WINDOW_HOURS): { due: AutoCompleteCustomer[]; waiting: AutoCompleteCustomer[] } {
  const since = now - windowHours * 3600_000;
  const by = new Map<string, { open: number; last: number }>();
  for (const r of rows) {
    if (!r.property_customer_id || r.complete_group_id) continue;
    const t = Date.parse(r.created_at);
    if (!Number.isFinite(t) || t < since) continue;
    const c = by.get(r.property_customer_id) ?? { open: 0, last: -Infinity };
    c.open++; if (t > c.last) c.last = t;
    by.set(r.property_customer_id, c);
  }
  const due: AutoCompleteCustomer[] = [], waiting: AutoCompleteCustomer[] = [];
  for (const [pcid, c] of by) {
    const item = { property_customer_id: pcid, open: c.open, last_at: new Date(c.last).toISOString(), due_at: new Date(c.last + quietMs).toISOString() };
    (isQuietFor(c.last, now, quietMs) ? due : waiting).push(item);
  }
  due.sort((a, z) => a.last_at.localeCompare(z.last_at));
  waiting.sort((a, z) => a.due_at.localeCompare(z.due_at));
  return { due, waiting };
}

/** 拡張のトーストに出す短い文（件数だけ・お客様の名前は出さない） */
export function completeToastJa(r: { claimed: number; sites: Record<string, number>; already?: boolean; skipped?: string | null }): string {
  if (r.skipped === "brain_off") return "";
  // 2026-09-25 竹内「売上サポの名前は AIXツールに変更」（スタッフ向けの文だけ・お客様に届く文には出ていない）
  if (r.claimed <= 0) return r.already ? "AIXツール: もうまとめてあります（新しいピックアップなし）" : "AIXツール: まとめる新しいピックアップはありません";
  const label: Record<string, string> = { realpro: "リアプロ", itandi: "itandi", reins: "レインズ" };
  const parts = Object.entries(r.sites).filter(([, n]) => n > 0).map(([k, n]) => `${label[k] ?? k} ${n}件`);
  return `AIXツールにまとめました: ${parts.join("・") || `${r.claimed}件`}（分析と順位の付け直しは1〜3分で反映）`;
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
