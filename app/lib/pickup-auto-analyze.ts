// app/lib/pickup-auto-analyze.ts（サーバー専用・DB・DeepSeek。画面側から import しない）
// 売上サポに届いた時（recordPickupBatch の後・同じ waitUntil の中）に、画像でしか分からない希望があるお客様だけ、
// その回の物件を「🔍 画像で分析」と同じ形で自動で読む。
//
// 2026-09-25 竹内「売上サポに送られたら、条件指定あれば間取り図とか設備も自動的に読み取るようにする。
//   今はボタンを押す必要があるけど、必要な分は自動で判定する形とする」
// 決まり:
//   - 読むのは imageAnalysisNeed が recommended（WIC・対面キッチン・収納・部屋の配置・水回り 等）のお客様だけ。
//     それ以外（宅配BOX・階のように資料の文字で決まる希望だけ・希望なし）は読まない＝DeepSeek 0回
//   - 読む物件: 外す候補（verdict=drop）は読まない・同じ建物で省いた部屋はそもそも行が無い・保存済み（image_analysis あり）は読まない・
//     推奨の希望が全部、資料の設備欄（文字層）で ○/× 決まった物件は読まない。最大 20件・同時 3件
//   - 時間: merge-pdfs の maxDuration（300秒）の中で終える。締め切り（deadlineAt）を過ぎたら新しい物件は始めない
//   - 結果はボタンと同じ形（property_pickups.image_analysis に {…分析, wants, analyzed_at}）＋ auto: {at, labels}。
//     失敗しても記録（property_pickups の行）はそのまま
//   - llm_usage_logs の action は pickup_image_analysis_auto（ボタンと分ける）・conversation_id を入れる
import { supabase } from "@/app/lib/supabase";
import { loadImageWants } from "@/app/lib/image-wants-server";
import { imageAnalysisNeed } from "@/app/lib/image-wants";
import { analyzePickupRow } from "@/app/lib/pickup-analyze-server";
import { runWithActionRename } from "@/app/lib/llm-action-scope";
import { pickAutoTargets, strongFeatures, AUTO_ANALYZE_CONCURRENCY, AUTO_ACTION, type AutoRow } from "@/app/lib/pickup-auto-targets";

export type AutoAnalyzeResult = {
  level: "recommended" | "optional" | "none";
  labels: string[];
  targets: number;
  analyzed: number;
  failed: number;
  skipped: Array<{ id: number; why: string }>;
  ms: number;
  calls: number;
  input: number;
  cacheHit: number;
  output: number;
};

/**
 * 1回分（batch）を自動で読む。ids＝この回で入れた property_pickups の id。失敗しても投げない。
 * deadlineAt（ms）を過ぎたら新しい物件は始めない（始めた物は最後まで）
 */
export async function autoAnalyzeBatch(input: { ids: number[]; propertyCustomerId: string | null; conversationId: string | null; deadlineAt?: number }): Promise<AutoAnalyzeResult> {
  const t0 = Date.now();
  const out: AutoAnalyzeResult = { level: "none", labels: [], targets: 0, analyzed: 0, failed: 0, skipped: [], ms: 0, calls: 0, input: 0, cacheHit: 0, output: 0 };
  try {
    if (!input.ids.length || (!input.propertyCustomerId && !input.conversationId)) return out;
    // 希望: ボタンと同じ材料（条件欄・会話 120日・訴求点。名前・電話は伏せる）。DB だけ（DeepSeek は呼ばない）
    const wants = await loadImageWants({ conversationId: input.conversationId, propertyCustomerId: input.propertyCustomerId });
    const need = imageAnalysisNeed(wants);
    out.level = need.level; out.labels = need.labels;
    if (need.level !== "recommended") return out;
    const features = strongFeatures(wants);
    const { data, error } = await supabase.from("property_pickups")
      .select("id, rank, site, pdf_url, pdf_blob_url, pdf_text, pdf_has_text, summary_text, trim_image_url, page_image_url, image_analysis, verdict, equipment")
      .in("id", input.ids);
    if (error) { console.warn("[pickup-auto] 行を引けない:", error.message); return out; }
    const { targets, skipped } = pickAutoTargets((data ?? []) as AutoRow[], features);
    out.targets = targets.length; out.skipped = skipped;
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= targets.length) return;
        if (input.deadlineAt && Date.now() > input.deadlineAt) { out.skipped.push({ id: targets[i].id, why: "時間切れ" }); continue; }
        const r = targets[i];
        try {
          const res = await runWithActionRename({ pickup_image_analysis: AUTO_ACTION }, () => analyzePickupRow(r, wants, { conversationId: input.conversationId }));
          for (const u of res.usage) { out.calls++; out.input += u.input; out.cacheHit += u.cacheHit; out.output += u.output; }
          if (res.analysis) {
            const at = new Date().toISOString();
            const { data: saved, error: uErr } = await supabase.from("property_pickups")
              .update({ image_analysis: { ...res.analysis, wants, analyzed_at: at, auto: { at, labels: need.labels } } }).eq("id", r.id)
              // 2026-09-25 反証レビュー: 読んでいる間にスタッフが「🔍 画像で分析」を押して先に保存した結果（希望を足した物）を上書きしない
              .is("image_analysis", null).select("id");
            if (uErr) { out.failed++; console.warn("[pickup-auto] 保存できない:", uErr.message); }
            else if (!saved?.length) out.skipped.push({ id: r.id, why: "ボタンで先に保存済み" });
            else out.analyzed++;
          } else out.failed++;
        } catch (e) {
          out.failed++;
          console.warn("[pickup-auto] 読めない:", e instanceof Error ? e.message : String(e));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(AUTO_ANALYZE_CONCURRENCY, targets.length) }, worker));
    return out;
  } catch (e) {
    console.warn("[pickup-auto] 失敗:", e instanceof Error ? e.message : String(e));
    return out;
  } finally {
    out.ms = Date.now() - t0;
    console.log(JSON.stringify({ tag: "property-pickups:auto-analyze", customer: input.propertyCustomerId?.slice(0, 8) ?? null, level: out.level, labels: out.labels, targets: out.targets, analyzed: out.analyzed, failed: out.failed, skipped: out.skipped.length, ms: out.ms, calls: out.calls, input: out.input, cacheHit: out.cacheHit, output: out.output }));
  }
}
