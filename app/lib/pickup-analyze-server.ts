// app/lib/pickup-analyze-server.ts（サーバー専用・DB・DeepSeek。画面側から import しない）
// 「🔍 画像で分析」の物件1件分: 事実を用意（sheet-read-server）→ 決まらない希望だけ文字で聞く → 点と要確認（pickup-image-analysis）。
// /api/property-pickups/analyze と YUMA のテストスクリプトが同じ関数を使う（設計知見「本番検証は画面が渡すのと同じ形で渡す」）
// 2026-09-24 竹内「読んだ結果を物件ごとに保存し、2回目以降は画像を読み直さない（希望との照合は文字だけ）」
import { buildPickupAnalysis, type PickupImageAnalysis } from "@/app/lib/pickup-image-analysis";
import { loadSheetFacts, judgeWantsByText, type SheetReadOutcome, type SheetSourceRow, type SheetUsage } from "@/app/lib/sheet-read-server";
import { matchWantsWithFacts, checkSheetConsistency, parseSummaryFacts } from "@/app/lib/sheet-facts";
import { SHEET_PROMPT_VERSION, SHEET_READ_MAX_TOKENS, SHEET_RETRY_MAX_TOKENS } from "@/app/lib/sheet-prompt";
import type { ImageWant, WantCheck } from "@/app/lib/image-wants";

/** DeepSeek の使用量を llm_usage_logs に（2026-09-24 竹内「pickup_image_analysis の llm_usage_logs に conversation_id を入れる」） */
export function recordSheetUsage(u: SheetUsage, conversationId: string | null): void {
  void import("@/app/lib/llm-usage-recorder").then(({ recordAltUsage }) => recordAltUsage({
    model: u.model, action: "pickup_image_analysis", conversationId,
    usage: { input_tokens: Math.max(0, u.input - u.cacheHit), output_tokens: u.output, cache_read_input_tokens: u.cacheHit },
    status: u.input > 0 ? 200 : 0, errorType: u.ok ? null : (u.input > 0 ? "empty_or_unparsable" : "no_response"),
    // sys_head は前置きの種類ごとに分ける（どの型でキャッシュが効いているかを後から読むため）
    durationMs: u.ms, sysHead: `【🔍 画像で分析・${u.section}${u.retry ? "・読み直し" : ""}】${SHEET_PROMPT_VERSION}`, sysKeyFull: null,
    maxTokens: u.retry ? SHEET_RETRY_MAX_TOKENS : SHEET_READ_MAX_TOKENS,
  })).catch(() => {});
}

export type PickupAnalyzeResult = { analysis: PickupImageAnalysis | null; facts: SheetReadOutcome; usage: SheetUsage[]; error: string | null };

/** 物件1件を分析する（保存はしない・呼び出し側が image_analysis に書く）。使用量は llm_usage_logs に記録する */
export async function analyzePickupRow(row: SheetSourceRow & { conversation_id?: string | null }, wants: ImageWant[], opts?: { conversationId?: string | null }): Promise<PickupAnalyzeResult> {
  const conv = row.conversation_id ?? opts?.conversationId ?? null;
  const facts = await loadSheetFacts(row);
  const usage: SheetUsage[] = [...facts.usage];
  // 決まった手順で決まらない希望だけ文字で聞く（物件と資料が一致している時だけ。点を出さない要確認では聞かない＝費用をかけない）
  let llmChecks: WantCheck[] | undefined;
  if ((facts.text.hasText || facts.image) && wants.length) {
    const ok = checkSheetConsistency({ summary: row.summary_text, text: facts.text, image: facts.image }).status === "ok";
    const undecided = new Set(matchWantsWithFacts(wants, facts.text, ok ? facts.image : null, parseSummaryFacts(row.summary_text).madori).undecided);
    if (ok && undecided.size) {
      const j = await judgeWantsByText(facts.text, facts.image, wants.filter((w) => undecided.has(w.id)));
      if (j.usage) usage.push(j.usage);
      llmChecks = j.checks;
    }
  }
  for (const u of usage) recordSheetUsage(u, conv);
  const analysis = buildPickupAnalysis({ wants, text: facts.text, image: facts.image, summary: row.summary_text, llmChecks });
  if (analysis) {
    analysis.sheet = {
      type: facts.sheetType, type_by: facts.typeBy, crop_mode: facts.crop?.mode ?? null, crop_basis: facts.crop?.basis ?? null,
      crop_reason: facts.crop?.reason ?? null, facts_id: facts.factsId, source: facts.source, prompt_version: SHEET_PROMPT_VERSION, see: facts.image?.see ?? null,
    };
  }
  return { analysis, facts, usage, error: analysis ? null : (facts.error ?? "読めなかった") };
}
