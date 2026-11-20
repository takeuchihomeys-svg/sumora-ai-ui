/**
 * 最新録画 → 自動の最新課題 → 通常モードから改善（2026-11-15 竹内さん）
 *
 *   「画像は最新で録画したらそのことも把握して」
 *   「自動モードで最新の課題みつけて」
 *   「通常モードから改善していくようにしていくようにする」
 *
 * ★ なぜ要るか
 *   統括は全期間の抜け・弱い所は言えても、
 *   ・今撮った画像が「最新」か
 *   ・自動の**いまの**課題（古い版 2.7.58 と混ざらない）
 *   ・それを通常の画像から直す、という**回し方**
 *   を材料に持っていなかった。打ち合わせを何度しても回らない原因。
 *
 * ⚠ 純関数。DB・費用は触らない。判断は統括（learn-supervisor）がする。
 */
import {
  foldRuns, foldTapClick, countChangedWithoutClick, countRetries, fieldName,
  type AutoRow, type AutoOp,
} from "./learn-auto-audit";
import { isAutoMode } from "./press-by";

export type ShotRowLite = {
  created_at?: string | null;
  mode?: string | null;
  shot_key?: string | null;
  shot_w?: number | null;
  shot_learn?: unknown;
  ext_version?: string | null;
  shot_ops?: unknown;
};

/** 最新録画の画像がどうなっているか */
export type RecordingFreshness = {
  /** 通常モード最新画像の時刻（ISO） */
  normalLatestAt: string | null;
  /** 自動モード最新画像の時刻 */
  autoLatestAt: string | null;
  /** 直近24hの通常画像枚数（shot_keyあり） */
  normalLast24h: number;
  /** 直近24hの自動画像枚数 */
  autoLast24h: number;
  /** 通常の最新がもう学べているか */
  normalLatestLearned: boolean | null;
  /** 自動の最新が学べているか（自動は手本にしない・把握用） */
  autoLatestLearned: boolean | null;
  normalLatestW: number;
  autoLatestW: number;
  normalLatestVer: string | null;
  autoLatestVer: string | null;
  line: string;
};

/** 自動モードの最新課題（古い版と混ぜない） */
export type LatestAutoChallenge = {
  /** 見た検索の回数（run） */
  runs: number;
  /** 窓の開始（ISO） */
  since: string | null;
  /** 最新の版 */
  extVersion: string | null;
  /** 押さずに値が変わった欄 */
  changedNoClick: string[];
  /** 同じ欄を2回以上（押し直し） */
  retries: string[];
  /** 改善の対象欄（通常から読む優先） */
  fields: string[];
  challenges: Array<{ what: string; why: string; field?: string }>;
  line: string;
};

function isAuto(mode: unknown): boolean {
  return isAutoMode(mode);
}
function isNormal(mode: unknown): boolean {
  return !isAuto(mode);
}

/**
 * 最新録画の画像を把握する（純関数）。
 *   ⚠ shot_key がある行だけ「画像あり」。
 */
export function summarizeRecordingFreshness(
  rows: ReadonlyArray<ShotRowLite>,
  nowMs: number = Date.now(),
): RecordingFreshness {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.shot_key === "string" && r.shot_key);
  const dayAgo = nowMs - 24 * 3600_000;
  let normalLatest: ShotRowLite | null = null;
  let autoLatest: ShotRowLite | null = null;
  let normalLast24h = 0, autoLast24h = 0;
  for (const r of list) {
    const at = Date.parse(String(r.created_at ?? "")) || 0;
    const learned = !!(r.shot_learn && typeof r.shot_learn === "object");
    if (isNormal(r.mode)) {
      if (at >= dayAgo) normalLast24h++;
      if (!normalLatest || at > (Date.parse(String(normalLatest.created_at ?? "")) || 0)) normalLatest = r;
      void learned;
    } else if (isAuto(r.mode)) {
      if (at >= dayAgo) autoLast24h++;
      if (!autoLatest || at > (Date.parse(String(autoLatest.created_at ?? "")) || 0)) autoLatest = r;
    }
  }
  const nLearned = normalLatest ? !!(normalLatest.shot_learn && typeof normalLatest.shot_learn === "object") : null;
  const aLearned = autoLatest ? !!(autoLatest.shot_learn && typeof autoLatest.shot_learn === "object") : null;
  const parts: string[] = [];
  if (normalLatest?.created_at) {
    parts.push(`通常 最新 ${String(normalLatest.created_at).slice(0, 19)}（${Number(normalLatest.shot_w) || 0}px・${nLearned ? "学習済" : "未学習"}・版${normalLatest.ext_version || "?"}）`);
  } else parts.push("通常の画像なし");
  if (autoLatest?.created_at) {
    parts.push(`自動 最新 ${String(autoLatest.created_at).slice(0, 19)}（${Number(autoLatest.shot_w) || 0}px・版${autoLatest.ext_version || "?"}）`);
  } else parts.push("自動の画像なし");
  parts.push(`直近24h 通常${normalLast24h}枚・自動${autoLast24h}枚`);
  if (normalLatest && !nLearned && (Number(normalLatest.shot_w) || 0) >= 800) {
    parts.push("⚠ 最新の通常画像はまだ読んでいない（最新から学ぶ）");
  }
  return {
    normalLatestAt: normalLatest?.created_at ? String(normalLatest.created_at) : null,
    autoLatestAt: autoLatest?.created_at ? String(autoLatest.created_at) : null,
    normalLast24h, autoLast24h,
    normalLatestLearned: nLearned,
    autoLatestLearned: aLearned,
    normalLatestW: Number(normalLatest?.shot_w) || 0,
    autoLatestW: Number(autoLatest?.shot_w) || 0,
    normalLatestVer: normalLatest?.ext_version != null ? String(normalLatest.ext_version) : null,
    autoLatestVer: autoLatest?.ext_version != null ? String(autoLatest.ext_version) : null,
    line: parts.join("／"),
  };
}

/**
 * 自動モードの**最新**課題を出す（純関数）。
 *   ⚠ 全30日を混ぜると古い版の課題が残る（実測: 2.7.58 が候補を汚す）。
 *   → 最新の自動画像から遡って `hours` 時間（既定48）だけ見る。
 */
export function summarizeLatestAutoChallenges(
  rows: ReadonlyArray<ShotRowLite>,
  opt: { hours?: number; nowMs?: number } = {},
): LatestAutoChallenge {
  const hours = Math.max(1, Math.min(168, opt.hours ?? 48));
  const now = opt.nowMs ?? Date.now();
  const autoAll = (Array.isArray(rows) ? rows : []).filter((r) => isAuto(r.mode) && r.shot_key);
  let newestAt = 0;
  for (const r of autoAll) {
    const t = Date.parse(String(r.created_at ?? "")) || 0;
    if (t > newestAt) newestAt = t;
  }
  const sinceMs = newestAt > 0 ? Math.max(now - hours * 3600_000, newestAt - hours * 3600_000) : now - hours * 3600_000;
  // 最新の自動から遡る（最新が無ければ窓だけ）
  const windowStart = newestAt > 0 ? newestAt - hours * 3600_000 : sinceMs;
  const auto = autoAll.filter((r) => (Date.parse(String(r.created_at ?? "")) || 0) >= windowStart) as AutoRow[];
  const runs = foldRuns(auto);
  const folded = runs.map((r) => ({ ...r, ops: foldTapClick(r.ops) as AutoOp[] }));
  const changedAcc: Record<string, number> = {};
  for (const r of folded) {
    for (const [f, n] of Object.entries(countChangedWithoutClick(r.ops))) {
      changedAcc[f] = (changedAcc[f] || 0) + n;
    }
  }
  const retriesAcc = countRetries(folded.map((r) => r.ops));
  const changedNoClick = Object.entries(changedAcc).sort((a, b) => b[1] - a[1]).map(([f]) => f);
  const retries = Object.entries(retriesAcc).filter(([, n]) => n >= 1).sort((a, b) => b[1] - a[1]).map(([f]) => f);
  const fields = [...new Set([...changedNoClick, ...retries])].slice(0, 12);
  const challenges: LatestAutoChallenge["challenges"] = [];
  for (const f of changedNoClick.slice(0, 5)) {
    challenges.push({
      what: "押さずに値が変わった",
      why: `${f}（最新の自動録画・選ばずに入れた疑い）`,
      field: f,
    });
  }
  for (const f of retries.slice(0, 5)) {
    if (changedNoClick.includes(f)) continue;
    challenges.push({
      what: "同じ欄を2回以上押した",
      why: `${f}×${retriesAcc[f]}（最新の自動・迷い）`,
      field: f,
    });
  }
  const ver = folded[0]?.row?.ext_version != null ? String((folded[0].row as ShotRowLite).ext_version) : null;
  const since = folded.length
    ? folded.map((r) => String(r.row.created_at ?? "")).filter(Boolean).sort()[0] || null
    : null;
  const parts: string[] = [];
  parts.push(`最新自動 ${folded.length}回（版${ver || "?"}）`);
  if (changedNoClick.length) parts.push(`⚠ 押さず変化 ${changedNoClick.slice(0, 4).join("・")}`);
  if (retries.length) parts.push(`⚠ 押し直し ${retries.slice(0, 4).join("・")}`);
  if (!challenges.length) parts.push("最新窓に目立つ課題なし");
  return {
    runs: folded.length,
    since,
    extVersion: ver,
    changedNoClick,
    retries,
    fields,
    challenges,
    line: parts.join("／"),
  };
}

/**
 * 自動の最新課題 → 通常モードから改善する計画（純関数）。
 */
export function planImproveFromNormal(
  ch: LatestAutoChallenge,
  fresh: RecordingFreshness,
): { fields: string[]; what: string; why: string; how: string; preferNewest: boolean } | null {
  if (!ch.fields.length && !ch.challenges.length) return null;
  const fields = ch.fields.length ? ch.fields : ch.challenges.map((c) => c.field).filter((x): x is string => !!x);
  if (!fields.length) return null;
  const latestNote = fresh.normalLatestAt
    ? `通常の最新画像 ${String(fresh.normalLatestAt).slice(0, 19)}${fresh.normalLatestLearned === false ? "（未学習）" : ""}`
    : "通常の最新画像なし";
  return {
    fields: fields.slice(0, 8),
    what: "自動の最新課題を、通常モードの画像から改善する",
    why: `自動の課題欄: ${fields.slice(0, 5).join("・")}／${latestNote}`,
    how: "通常モードの最新〜近い画像を読んで、課題欄の種類・位置・押し方を束に載せる（photo_learn・newest・mode=normal）",
    preferNewest: true,
  };
}

/** 欄名の軽い正規化（突き合わせ用） */
export function fieldKey(f: string): string {
  return fieldName(f).toLowerCase();
}
