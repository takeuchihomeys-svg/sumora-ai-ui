// app/lib/pickup-wants-fit-server.ts（サーバー専用・DB と DeepSeek を読む）
// AIX【物件ピックアップした】: 売上サポから来た束（pickup_ids）とお客様の要望を照らした注記（pickup-wants-fit.ts）を作る。
// 白基調の希望がある時だけ、束の各部屋の内装の色を読む（interior-tone-read.ts・並べて・全体で時間の枠つき）。
//
// 2026-10-07 竹内（会話「し」）「お客さんの希望の条件に合っていない部分をちゃんといれたうえで、具体的に内覧訴求」
//   戻すのは PICKUP_WANTS_FIT=off（注記も出口の注意も出ない）／色だけ止めるのは PICKUP_INTERIOR_TONE=off
// 2026-10-07（Ryoichi・築浅かリノベ）: リノベ済みを資料の文字で読むため pdf_text も読む（terms.renovated が無い 10/06d より前の行）
import type { SupabaseClient } from "@supabase/supabase-js";
import { parsePickupFact } from "./pickup-send-facts";
import { bundleWantsFit, buildBundleFitNote, customerWantsForFit, pickupFitInputFromRow, type BundleFit } from "./pickup-wants-fit";
import type { InteriorTone } from "./interior-tone";

/** 色を読む全体の時間の枠（AIX の文を待たせすぎない。1枚 1〜3秒・並べて読む） */
export const BUNDLE_TONE_BUDGET_MS = 9_000;
/** 色を読む部屋の上限（束の先頭から） */
export const BUNDLE_TONE_MAX = 10;

type Row = {
  id: number; property_name: string | null; summary_text: string | null; image_lines: string[] | null; site: string | null;
  pdf_blob_url: string | null; page_image_url: string | null; pdf_text: string | null;
  terms: Parameters<typeof pickupFitInputFromRow>[0]["terms"]; equipment: Parameters<typeof pickupFitInputFromRow>[0]["equipment"];
};

export async function loadBundleWantsFit(
  supabase: SupabaseClient, pickupIds: readonly number[], conditionsText: string | null | undefined,
  opts?: { conversationId?: string | null },
): Promise<{ fit: BundleFit; note: string; toneRead: number } | null> {
  if ((process.env.PICKUP_WANTS_FIT ?? "on").trim() === "off" || pickupIds.length === 0) return null;
  // 照らす要望が条件の文に無くても、設備の照合（行の equipment.match）はある事がある → 行は読む
  const wants = customerWantsForFit(conditionsText);
  const { data, error } = await supabase.from("property_pickups")
    .select("id, property_name, summary_text, image_lines, site, pdf_blob_url, page_image_url, pdf_text, terms, equipment")
    .in("id", [...pickupIds]);
  if (error || !data) return null;
  const byId = new Map((data as Row[]).map((r) => [r.id, r]));
  const rows = pickupIds.map((id) => byId.get(id)).filter((r): r is Row => !!r);
  if (rows.length !== pickupIds.length) return null;
  let tones: Array<InteriorTone | null> = rows.map(() => null);
  let toneRead = 0;
  if (wants.white && (process.env.PICKUP_INTERIOR_TONE ?? "on").trim() !== "off") {
    const { readInteriorToneForPickup } = await import("./interior-tone-read");
    const target = rows.slice(0, BUNDLE_TONE_MAX);
    const timer = new Promise<null>((res) => setTimeout(() => res(null), BUNDLE_TONE_BUDGET_MS));
    const reads = target.map((r) => readInteriorToneForPickup(r, { conversationId: opts?.conversationId ?? null, timeoutMs: BUNDLE_TONE_BUDGET_MS - 500 }).then((x) => x.tone).catch(() => null));
    const settled = await Promise.all(reads.map((p) => Promise.race([p, timer])));
    tones = rows.map((_, i) => (i < settled.length ? settled[i] : null));
    toneRead = settled.filter(Boolean).length;
  }
  const inputs = rows.map((r, i) => pickupFitInputFromRow(r, parsePickupFact(r), tones[i]));
  const fit = bundleWantsFit(inputs, wants);
  return { fit, note: buildBundleFitNote(fit), toneRead };
}
