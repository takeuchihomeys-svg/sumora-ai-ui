// app/lib/rag-probes-check.ts — RAG のベクトル検索（match_*）が厳密か（ivfflat.probes が関数に付いているか）を毎朝見張る
//
// 2026-10-08 RAG のゴミ調査（scripts/audit-rag-garbage.ts）で見つけた事故: 9/13 に付けた `ALTER FUNCTION match_* SET ivfflat.probes = 100` が
//   全部消えていた（proconfig が null）。migrate-schema（毎晩 JST 0:10 の cron）が CREATE OR REPLACE FUNCTION で関数を作り直すたびに SET が消え、
//   直後の ALTER は vector を読み込んだのと別の呼び出しで流れて permission denied になっていた（結果の JSON に積まれるだけで誰も見ない）。
//   その間、手本の検索の上位24件のうち厳密な検索と重なるのは平均 3.7件・AIX の手本は 1.2/8＝静かに壊れていた。
//   10/09 竹内さんが本番で戻し、migrate-schema を DO ブロックに直した。再発したら朝の報告の前に気づけるよう、ここで毎朝確かめる。
//
// 読むだけ: exec_sql（void を返す）に「足りない関数があれば例外を投げる」DO ブロックを渡し、エラーの文で結果を受け取る（DB に何も書かない・新しい関数も作らない）。

/** probes を付けておく関数（migrate-schema の ALTER と同じ・名前だけ）。
 *   2026-11-18 作業員H: match_reply_knowledge・match_reply_examples・match_aix_reply_examples は HNSW に替えた（probes ではなく定義の SET hnsw.*）・
 *   match_winning_patterns は索引なし（数十行）＝ここから外し、下の RAG_HNSW_FUNCS・RAG_SEARCH_PATH_FUNCS で見張る */
export const RAG_PROBES_FUNCS = ["match_design_thinking", "match_conversation_checkpoints"] as const;
/** HNSW の関数（定義に hnsw.ef_search が付いているか） */
export const RAG_HNSW_FUNCS = ["match_reply_knowledge", "match_reply_examples", "match_aix_reply_examples"] as const;
/** extensions を search_path に要る関数（11/15・11/18 に public だけに戻って毎回0件になっていた match_takeuchi_compose 等） */
export const RAG_SEARCH_PATH_FUNCS = ["match_takeuchi_compose", "match_conductor_focus", "match_conductor_turns"] as const;
/** 必要な probes（索引の lists の最大＝ai_reply_examples・system_design_thinking の 100 以上で全区画＝厳密） */
export const RAG_PROBES_MIN = 100;
export const RAG_PROBES_MISSING_TAG = "RAG_PROBES_MISSING:";

/** 見張りの SQL（読むだけ。足りない関数があれば例外の文に名前を並べる）。11/18 から HNSW の設定と search_path も同じ1回で見る */
export function buildRagProbesCheckSql(funcs: ReadonlyArray<string> = RAG_PROBES_FUNCS, min = RAG_PROBES_MIN, hnsw: ReadonlyArray<string> = RAG_HNSW_FUNCS, sp: ReadonlyArray<string> = RAG_SEARCH_PATH_FUNCS): string {
  const q = (xs: ReadonlyArray<string>) => xs.map((f) => `'${f.replace(/[^a-z_]/g, "")}'`).join(",") || "''";
  return `DO $$ DECLARE m text; BEGIN
SELECT string_agg(name, ',' ORDER BY name) INTO m FROM (
SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN (${q(funcs)})
AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}'::text[])) c WHERE c ~ '^ivfflat\\.probes=[0-9]+$' AND split_part(c, '=', 2)::int >= ${Math.max(1, Math.floor(min))})
UNION ALL
SELECT p.proname || '(hnsw)' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN (${q(hnsw)})
AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}'::text[])) c WHERE c ~ '^hnsw\\.ef_search=[0-9]+$')
UNION ALL
SELECT p.proname || '(search_path)' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN (${q(sp)})
AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}'::text[])) c WHERE c ~ '^search_path=.*extensions')
) x;
IF m IS NOT NULL THEN RAISE EXCEPTION '${RAG_PROBES_MISSING_TAG}%', m; END IF;
END $$;`;
}

export type RagProbesResult = { status: "ok" } | { status: "missing"; funcs: string[] } | { status: "unknown"; error: string };

/** exec_sql のエラー（無ければ null）から結果を読む */
export function parseRagProbesCheck(errorMessage: string | null | undefined): RagProbesResult {
  if (!errorMessage) return { status: "ok" };
  const i = errorMessage.indexOf(RAG_PROBES_MISSING_TAG);
  if (i >= 0) {
    const funcs = errorMessage.slice(i + RAG_PROBES_MISSING_TAG.length).split(/[,\s"]+/).map((s) => s.trim()).filter((s) => /^match_[a-z_]+(?:\((?:hnsw|search_path)\))?$/.test(s));
    return { status: "missing", funcs };
  }
  return { status: "unknown", error: errorMessage.slice(0, 200) };
}

/** 朝の報告に足す1行（問題が無ければ空） */
export function ragProbesWarningLine(r: RagProbesResult): string {
  if (r.status === "missing") return `⚠️ RAG の関数の設定が外れています: ${r.funcs.join("・")}（名前だけ＝ivfflat.probes が無い・(hnsw)＝hnsw.ef_search が無い・(search_path)＝extensions が無く毎回0件・migrate-schema の作り直しで消えた疑い）`;
  return "";
}

/** 見張りの実行（失敗しても投げない） */
export async function checkRagProbes(sb: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: { message: string } | null }> }): Promise<RagProbesResult> {
  try {
    const { error } = await sb.rpc("exec_sql", { sql: buildRagProbesCheckSql() });
    return parseRagProbesCheck(error?.message ?? null);
  } catch (e) {
    return { status: "unknown", error: e instanceof Error ? e.message : String(e) };
  }
}
