// app/lib/new-arrivals.ts
// AIXツールの「新着物件」: ブレインの基準をクリアした物件（一括検索・個別の検索でブレインが仕分けた「通す」）のうち、
// スタッフがまだ見ていない物を、お客様ごとに数える（純関数・DB 依存なし・画面からも使える）。
//
// 2026-09-25 竹内「右の一覧の項目を新着物件に名前変更。ブレインの基準をクリアした物件（一括検索や自動検索等でブレインが仕分ける）が
//   あれば LINE 一覧と同じ UI で 1・2 や文字が出る。トーク一覧も新着物件があった順に」
//   決定: 自動検索（11時・17時の自動便）はまだ行わない → 新着物件は手動の一括・個別の検索の分だけ。既読はスタッフ全員で共有（seen_at）。
//
// 新着＝次の全部を満たす property_pickups の行:
//   ① verdict = 'pass'（ブレインの基準をクリア。保留・外す候補・判定なしは入れない）
//   ② status = 'pending'（まだ送っていない・見送っていない）
//   ③ expired_at IS NULL かつ 届いてから PICKUP_RETENTION_HOURS（72時間）以内（画像・資料が残っている間だけ＝送れる物だけ）
//   ④ seen_at IS NULL（詳細を開くと /api/property-pickups/seen がまとめて入れる）
//   ⑤ お客様に送った物件（sent_properties・お客様に届いた行）の建物に当たらない（同じ建物は新着として知らせない。
//      名前の近さ 0.75＝candidate-facts.sameBuildingName。「物件」「マンション」等の一般名は比べない＝新着のまま）
import { PICKUP_RETENTION_HOURS } from "./pickup-retention";
import { sameBuildingName } from "./candidate-facts";
import { isGenericBuildingName } from "./generic-building-name";
import { parseRentFromSummary } from "./property-summary-parse";

export type NewArrivalRow = {
  id: number;
  created_at: string;
  property_name: string | null;
  summary_text?: string | null;
  verdict: string | null;
  status: string | null;
  expired_at?: string | null;
  seen_at?: string | null;
  score?: number | null;
  recommended?: number | null;
  rank?: number | null;
};
export type SentBuilding = { property_name: string | null };

export const NEW_ARRIVAL_WINDOW_HOURS = PICKUP_RETENTION_HOURS;

/** 送った物件の建物に当たるか（一般名は比べない） */
export function hitsSentBuilding(name: string | null | undefined, sent: ReadonlyArray<SentBuilding>): boolean {
  if (!name || isGenericBuildingName(name)) return false;
  for (const s of sent) {
    if (!s.property_name || isGenericBuildingName(s.property_name)) continue;
    if (sameBuildingName(name, s.property_name)) return true;
  }
  return false;
}

/** 1行が新着か（上の①〜⑤） */
export function isNewArrival(r: NewArrivalRow, sent: ReadonlyArray<SentBuilding>, nowMs: number = Date.now()): boolean {
  if (r.verdict !== "pass") return false;
  if (r.status !== "pending") return false;
  if (r.expired_at) return false;
  if (r.seen_at) return false;
  const at = Date.parse(r.created_at);
  if (!Number.isFinite(at) || nowMs - at > NEW_ARRIVAL_WINDOW_HOURS * 3600_000) return false;
  return !hitsSentBuilding(r.property_name, sent);
}

export type NewArrivalSummary = {
  count: number;
  /** 一番新しい新着が届いた時刻（トーク一覧の並び） */
  at: string | null;
  /** 2行目に出す一番の物件（点の高い順 → 🌟 → 順位） */
  top: { id: number; name: string; rentYen: number | null } | null;
  ids: number[];
};

/** お客様1人分の新着のまとめ */
export function summarizeNewArrivals(rows: ReadonlyArray<NewArrivalRow>, sent: ReadonlyArray<SentBuilding>, nowMs: number = Date.now()): NewArrivalSummary {
  const hits = rows.filter((r) => isNewArrival(r, sent, nowMs));
  if (hits.length === 0) return { count: 0, at: null, top: null, ids: [] };
  const at = hits.map((r) => r.created_at).sort((a, z) => Date.parse(z) - Date.parse(a))[0];
  const top = hits.slice().sort((a, z) =>
    ((z.score ?? -1) - (a.score ?? -1)) || ((z.recommended ?? 0) - (a.recommended ?? 0)) || ((a.rank ?? 99) - (z.rank ?? 99)) || (a.id - z.id))[0];
  return {
    count: hits.length,
    at,
    top: { id: top.id, name: String(top.property_name ?? "").trim() || "物件", rentYen: parseRentFromSummary(top.summary_text ?? "") },
    ids: hits.map((r) => r.id),
  };
}

/** 家賃の短い書き方（72,000 → 7.2万・75,500 → 7.55万） */
export function manYen(yen: number | null | undefined): string | null {
  if (yen == null || !Number.isFinite(yen) || yen <= 0) return null;
  const v = Math.round(yen / 100) / 100;
  return `${String(v)}万`;
}

/** トーク一覧の2行目（「🆕 新着2件・〇〇 7.2万」）。新着が無ければ null */
export function newArrivalLine(s: Pick<NewArrivalSummary, "count" | "top">): string | null {
  if (!s.count) return null;
  const rent = manYen(s.top?.rentYen);
  const head = s.top ? `・${s.top.name}${rent ? ` ${rent}` : ""}` : "";
  return `🆕 新着${s.count}件${head}`;
}

/**
 * トーク一覧の並び（新着物件のタブ）: 新着のあるお客様を「一番新しい新着」の新しい順に上へ。無いお客様は元の並び（LINE の順）のまま下に。
 */
export function sortByNewArrivals<T extends { new_count?: number | null; new_at?: string | null }>(list: ReadonlyArray<T>): T[] {
  const withNew = list.filter((c) => (c.new_count ?? 0) > 0);
  const rest = list.filter((c) => !((c.new_count ?? 0) > 0));
  withNew.sort((a, z) => (Date.parse(z.new_at ?? "") || 0) - (Date.parse(a.new_at ?? "") || 0));
  return [...withNew, ...rest];
}
