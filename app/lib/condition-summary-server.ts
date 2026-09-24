// app/lib/condition-summary-server.ts（サーバー専用・DB・DeepSeek。画面側から import しない）
// お客様の条件の要約（condition-summary.ts）を作り、決定論で読めない節だけ DeepSeek で要約して property_customers に保存する。
//
// 2026-09-25 竹内「文章の部分も要約できるようにする」:
//   - 鍵＝自由文（条件欄・NG 欄・その他・エリア）のハッシュ＋版。文が変わらない限り DeepSeek を呼ばない（保存した答えを使う）
//   - DeepSeek に渡すのは読めない節だけ。名前（maskPII）・電話・メール・番地（maskClause）を伏せる。お客様の画像は渡さない
//   - 推論なし（thinking disabled）・温度 0・固定の前置き（SUMMARY_SYSTEM_PROMPT）を先頭＝前置きキャッシュが効く
//   - 失敗しても投げない（決定論の要約だけ返す）
import { createHash } from "node:crypto";
import { supabase } from "@/app/lib/supabase";
import { maskPII } from "@/app/lib/pii-mask";
import { callDeepSeek } from "@/app/lib/vision-alt-provider";
import {
  buildConditionSummary, conditionFreeText, buildSummaryUserText, parseSummaryResponse, maskClause, formatSummaryLine, uncheckableLabels,
  SUMMARY_SYSTEM_PROMPT, CONDITION_SUMMARY_VERSION, type ConditionSummary, type SummaryCustomer, type SummaryItem,
} from "@/app/lib/condition-summary";

export const SUMMARY_COLS = "id, customer_name, rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet, move_in_time, created_at, floor_area_min, raw_format_text, desired_area, commute_station, commute_minutes, condition_summary, condition_summary_hash";

export type SavedSummary = { v: string; hash: string; ai: SummaryItem[]; clauses: string[]; at: string; model: string | null };

export type LoadedSummary = {
  summary: ConditionSummary;
  /** DeepSeek の要約（保存済み・今回作った物。無ければ空） */
  ai: SummaryItem[];
  /** 「条件の要約: …」 */
  line: string;
  /** 照らせない条件 */
  uncheckable: string[];
  /** DeepSeek を今回呼んだか */
  called: boolean;
  hash: string;
};

export function summaryHash(c: SummaryCustomer): string {
  return createHash("sha256").update(`${CONDITION_SUMMARY_VERSION}\n${conditionFreeText(c)}`).digest("hex").slice(0, 32);
}

/** 使用量を llm_usage_logs に（action を分ける） */
function recordUsage(u: { model: string; input: number; output: number; cacheHit: number; ms: number; ok: boolean }, conversationId: string | null): void {
  void import("@/app/lib/llm-usage-recorder").then(({ recordAltUsage }) => recordAltUsage({
    model: u.model, action: "condition_summary", conversationId,
    usage: { input_tokens: Math.max(0, u.input - u.cacheHit), output_tokens: u.output, cache_read_input_tokens: u.cacheHit },
    status: u.input > 0 ? 200 : 0, errorType: u.ok ? null : (u.input > 0 ? "empty_or_unparsable" : "no_response"),
    durationMs: u.ms, sysHead: `【条件の要約】${CONDITION_SUMMARY_VERSION}`, sysKeyFull: null, maxTokens: 500,
  })).catch(() => {});
}

/**
 * 1人分の要約。allowLlm=false は保存済みの DeepSeek の要約だけ使う（詳細 API から・待たせない）。
 * allowLlm=true は、読めない節があってハッシュが変わっていれば DeepSeek を1回呼んで保存する（売上サポに届いた時の裏で）
 */
export async function loadConditionSummary(propertyCustomerId: string | null, opts: { allowLlm?: boolean; conversationId?: string | null; customer?: SummaryCustomer & { condition_summary?: SavedSummary | null } } = {}): Promise<LoadedSummary | null> {
  let c = opts.customer ?? null;
  if (!c) {
    if (!propertyCustomerId) return null;
    const { data, error } = await supabase.from("property_customers").select(SUMMARY_COLS).eq("id", propertyCustomerId).maybeSingle();
    if (error || !data) {
      // 列がまだ無い（migrate 前）時は保存なしで決定論だけ
      if (error && /condition_summary/.test(error.message)) {
        const r2 = await supabase.from("property_customers").select(SUMMARY_COLS.replace(", condition_summary, condition_summary_hash", "")).eq("id", propertyCustomerId).maybeSingle();
        c = (r2.data ?? null) as unknown as typeof c;
      }
      if (!c) return null;
    } else c = data as unknown as typeof c;
  }
  const cust = c as SummaryCustomer & { condition_summary?: SavedSummary | null };
  const summary = buildConditionSummary(cust);
  const hash = summaryHash(cust);
  const saved = cust.condition_summary && cust.condition_summary.hash === hash ? cust.condition_summary : null;
  let ai: SummaryItem[] = saved?.ai ?? [];
  let called = false;
  const clauses = [...summary.unread, ...summary.unchecked];
  // 鍵が無い環境（テスト・ローカル）では呼ばない＝空の使用量の行（status 0・no_response）を llm_usage_logs に残さない
  const hasKey = !!(process.env.DEEPSEEK_API_KEY ?? "").trim();
  if (!saved && opts.allowLlm && hasKey && clauses.length > 0 && propertyCustomerId) {
    const names = [cust.customer_name].filter(Boolean) as string[];
    const masked = clauses.map((x) => maskClause(maskPII(x, names)));
    const t0 = Date.now();
    const r = await callDeepSeek(SUMMARY_SYSTEM_PROMPT, buildSummaryUserText(masked), { thinking: false, maxTokens: 500, timeoutMs: 30_000, temperature: 0 });
    called = true;
    const parsed = r ? parseSummaryResponse(r.text, masked.length) : [];
    recordUsage({ model: r?.model ?? "deepseek-flash", input: r?.usage.input ?? 0, output: r?.usage.output ?? 0, cacheHit: r?.usage.cacheHit ?? 0, ms: Date.now() - t0, ok: !!r && parsed.length > 0 }, opts.conversationId ?? null);
    if (r) {
      ai = parsed;
      const toSave: SavedSummary = { v: CONDITION_SUMMARY_VERSION, hash, ai, clauses: masked, at: new Date().toISOString(), model: r.model };
      const { error } = await supabase.from("property_customers").update({ condition_summary: toSave, condition_summary_hash: hash }).eq("id", propertyCustomerId);
      if (error) console.warn("[condition-summary] 保存できない:", error.message);
    }
  } else if (!saved && opts.allowLlm && clauses.length === 0 && propertyCustomerId && cust.condition_summary?.hash !== hash) {
    // 読めない節が無い人も「この文は見た」と残す（次から比べるだけ）
    const toSave: SavedSummary = { v: CONDITION_SUMMARY_VERSION, hash, ai: [], clauses: [], at: new Date().toISOString(), model: null };
    await supabase.from("property_customers").update({ condition_summary: toSave, condition_summary_hash: hash }).eq("id", propertyCustomerId).then(() => {}, () => {});
  }
  const items = [...summary.items, ...ai.filter((x) => x.mode !== "info")];
  return { summary, ai, line: formatSummaryLine(items), uncheckable: uncheckableLabels(summary, ai.length ? ai : null), called, hash };
}
