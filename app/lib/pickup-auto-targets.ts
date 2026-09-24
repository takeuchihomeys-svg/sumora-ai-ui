// app/lib/pickup-auto-targets.ts（純関数・DB 依存なし）
// 売上サポに届いた時の自動の読み取り（pickup-auto-analyze.ts）で「どの物件を読むか」を決める。テストできるように分けた。
// 2026-09-25 竹内「必要な分は自動で判定する形とする」
import { wantFeatures, WANT_FEATURES, type ImageWant } from "./image-wants";
import type { SheetSourceRow } from "./sheet-read-server";
import type { PickupEquipment } from "./pickup-equipment";

export const AUTO_ANALYZE_MAX = 20;
export const AUTO_ANALYZE_CONCURRENCY = 3;
export const AUTO_ACTION = "pickup_image_analysis_auto";

/** 画像の希望の強い設備 → 資料の設備欄のキー（設備欄で ○/× が決まれば画像で読まない） */
const FEATURE_TO_EQUIP: Record<string, string> = {
  wic: "walk_in_closet", counter_kitchen: "counter_kitchen", bath_toilet: "bath_toilet", washbasin: "washbasin", laundry_in: "laundry_in",
};

/** 推奨の強い設備（キー）。画像でしか分からない物だけ（WIC・対面キッチン・収納・配置・水回り） */
export function strongFeatures(wants: ImageWant[]): string[] {
  const out = new Set<string>();
  for (const w of wants) for (const k of wantFeatures(w.text)) if (WANT_FEATURES.find((f) => f.key === k)?.strong) out.add(k);
  return [...out];
}

/** その物件で画像を読む必要があるか（推奨の強い設備のうち、設備欄で決まっていない物が1つでもあれば読む） */
export function rowNeedsImage(features: string[], equipment: Pick<PickupEquipment, "match"> | null | undefined): boolean {
  if (!features.length) return false;
  const decided = new Set((equipment?.match ?? []).filter((m) => m.result !== "unlisted").map((m) => m.key));
  return features.some((f) => { const e = FEATURE_TO_EQUIP[f]; return !e || !decided.has(e); });
}

export type AutoRow = SheetSourceRow & { verdict: string | null; equipment: PickupEquipment | null; rank: number };

/** 読む物件を選ぶ（純関数・テスト用に分ける） */
export function pickAutoTargets(rows: AutoRow[], features: string[], max = AUTO_ANALYZE_MAX): { targets: AutoRow[]; skipped: Array<{ id: number; why: string }> } {
  const skipped: Array<{ id: number; why: string }> = [];
  const targets: AutoRow[] = [];
  for (const r of [...rows].sort((a, z) => a.rank - z.rank)) {
    if (r.verdict === "drop") { skipped.push({ id: r.id, why: "外す候補" }); continue; }
    if (r.image_analysis) { skipped.push({ id: r.id, why: "保存済み" }); continue; }
    if (!r.pdf_blob_url && !r.page_image_url && !r.trim_image_url) { skipped.push({ id: r.id, why: "資料なし" }); continue; }
    if (!rowNeedsImage(features, r.equipment)) { skipped.push({ id: r.id, why: "設備欄で決まった" }); continue; }
    if (targets.length >= max) { skipped.push({ id: r.id, why: "上限" }); continue; }
    targets.push(r);
  }
  return { targets, skipped };
}
