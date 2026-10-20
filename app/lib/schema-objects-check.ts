// app/lib/schema-objects-check.ts — 本番に要る関数・トリガーがあるかを毎朝見張る（読むだけ・LLM なし・費用0）
//
// 2026-10-17 事故: migrate-schema（毎晩 JST 0:10・300秒）が DROP FUNCTION と CREATE FUNCTION を別々の呼び出しで流し、
//   その間で時間切れになって match_design_thinking_exact（設計知見の RAG）が消えていた。誰も気づかない形だったので、
//   朝の報告（morning-report）で「コードが rpc で呼ぶ関数」と「migrate-schema が作るトリガー」があるかを確かめ、
//   無ければ cron_run_logs（cron_name=schema-objects-check）に ok=false で残し、朝の報告に1行出す。
//
// 読み方は rag-probes-check.ts と同じ: exec_sql（void を返す）に「足りない物があれば例外を投げる」DO ブロックを渡し、エラーの文で受け取る。

/** コードの .rpc("…") で呼ぶ関数（exec_sql は見張り自体が使うので除く）。足したら __tests__/schema-objects-check.test.ts が教える */
export const REQUIRED_FUNCS = [
  "area_rent_stats", "backfill_outcome_status", "confirm_knowledge_feedback", "conversation_last_customer_at",
  "decay_knowledge_importance", "design_thinking_neighbors", "expired_line_upload_objects", "find_similar_hypothesis_pairs",
  "find_similar_line_station", "find_similar_region", "find_similar_station", "increment_aix_transition",
  "increment_knowledge_used_count", "increment_template_recommend_picked", "increment_template_recommend_shown",
  "increment_template_use_count", "match_aix_reply_examples", "match_design_thinking_exact", "match_region_map",
  "match_reply_examples", "match_reply_knowledge", "match_station_map", "match_templates", "match_winning_patterns",
  "psk_mark_used", "search_conversation_ids_by_message", "update_knowledge_feedback_by_pairs",
  // rpc では呼ばないが probes の見張り（rag-probes-check.ts）の対象
  "match_design_thinking", "match_conversation_checkpoints",
] as const;

/** migrate-schema が作るトリガー（名前＋表） */
export const REQUIRED_TRIGGERS: ReadonlyArray<{ name: string; table: string }> = [
  { name: "update_property_customers_updated_at", table: "property_customers" },
  { name: "trg_trigger_action_rules_set_category", table: "trigger_action_rules" },
  { name: "trg_conversations_deepseek_cutoff", table: "conversations" },
  { name: "trg_conversations_line_watch", table: "conversations" },
  { name: "rent_observe_pool_trg", table: "property_candidate_pools" },
  { name: "rent_observe_sent_trg", table: "sent_properties" },
  { name: "rent_observe_pickup_trg", table: "property_pickups" },
  { name: "trg_fill_message_staff_writer", table: "messages" },
  // 2026-10-18 知識の検索の halfvec の写しを埋める（無いと新しい知識が float に戻るだけ＝静かに遅くなる）
  { name: "trg_ai_reply_knowledge_embedding_h", table: "ai_reply_knowledge" },
];

export const SCHEMA_MISSING_TAG = "SCHEMA_OBJECTS_MISSING:";

const ident = (s: string) => s.replace(/[^a-z0-9_]/g, "");

/** 見張りの SQL（読むだけ。足りない物があれば例外の文に「fn:名前」「trg:名前」を並べる） */
export function buildSchemaObjectsCheckSql(
  funcs: ReadonlyArray<string> = REQUIRED_FUNCS,
  triggers: ReadonlyArray<{ name: string; table: string }> = REQUIRED_TRIGGERS,
): string {
  const f = funcs.map((x) => `('${ident(x)}')`).join(",") || "(NULL)";
  const t = triggers.map((x) => `('${ident(x.name)}','${ident(x.table)}')`).join(",") || "(NULL,NULL)";
  return `DO $$ DECLARE m text; BEGIN
SELECT string_agg(x, ',' ORDER BY x) INTO m FROM (
  SELECT 'fn:' || r.n AS x FROM (VALUES ${f}) AS r(n)
  WHERE r.n IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public' AND p.proname = r.n)
  UNION ALL
  SELECT 'trg:' || r.n AS x FROM (VALUES ${t}) AS r(n, tbl)
  WHERE r.n IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relname = r.tbl AND g.tgname = r.n AND NOT g.tgisinternal AND g.tgenabled <> 'D')
) q;
IF m IS NOT NULL THEN RAISE EXCEPTION '${SCHEMA_MISSING_TAG}%', m; END IF;
END $$;`;
}

export type SchemaObjectsResult =
  | { status: "ok" }
  | { status: "missing"; funcs: string[]; triggers: string[] }
  | { status: "unknown"; error: string };

/** exec_sql のエラー（無ければ null）から結果を読む */
export function parseSchemaObjectsCheck(errorMessage: string | null | undefined): SchemaObjectsResult {
  if (!errorMessage) return { status: "ok" };
  const i = errorMessage.indexOf(SCHEMA_MISSING_TAG);
  if (i < 0) return { status: "unknown", error: errorMessage.slice(0, 200) };
  const items = errorMessage.slice(i + SCHEMA_MISSING_TAG.length).split(/[,\s"]+/).map((s) => s.trim());
  const funcs = items.filter((s) => /^fn:[a-z0-9_]+$/.test(s)).map((s) => s.slice(3));
  const triggers = items.filter((s) => /^trg:[a-z0-9_]+$/.test(s)).map((s) => s.slice(4));
  return { status: "missing", funcs, triggers };
}

/** 朝の報告に足す1行（問題が無ければ空） */
export function schemaObjectsWarningLine(r: SchemaObjectsResult): string {
  if (r.status !== "missing") return "";
  const parts = [
    r.funcs.length ? `関数 ${r.funcs.join("・")}` : "",
    r.triggers.length ? `トリガー ${r.triggers.join("・")}` : "",
  ].filter(Boolean);
  return `⚠️ 本番の DB に要る物がありません: ${parts.join(" / ")}（migrate-schema の作り直しの途中で止まった疑い・呼ぶ機能が失敗します）`;
}

/** 見張りの実行（失敗しても投げない） */
export async function checkSchemaObjects(sb: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: { message: string } | null }> }): Promise<SchemaObjectsResult> {
  try {
    const { error } = await sb.rpc("exec_sql", { sql: buildSchemaObjectsCheckSql() });
    return parseSchemaObjectsCheck(error?.message ?? null);
  } catch (e) {
    return { status: "unknown", error: e instanceof Error ? e.message : String(e) };
  }
}
