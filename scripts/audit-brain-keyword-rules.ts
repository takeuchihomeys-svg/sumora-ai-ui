// scripts/audit-brain-keyword-rules.ts — 学習した語のルール（trigger_action_rules keyword_rule）の中身と、ブレインの「AIX なし」の上書きの監査（読むだけ）
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-keyword-rules.ts [--since=2026-09-05] [--list]
//
// 2026-09-27 竹内「重い順から治す」①（app/lib/brain-keyword-rules.ts）:
//   1. 全ルールに isMeaninglessRuleKeyword を当て、理由ごとの件数と語の一覧（= learn-trigger-rules の次の実行で消える候補）
//   2. brain_decision_logs の decision_source=signal:*（ブレインの LLM が AIX を出さず信号で埋めた判断）ごとに、
//      その時のお客様の最後の発言へ語のルール（信号5.5・8）を当て直し、語のルール由来らしい判断と、スタッフが実際に押した AIX を並べる
//      ※ ルールは今の表で当て直す（当時の表ではない）。信号の番号は記録に無いので「語のルールが同じ action を出すか」で推定する
import { createClient } from "@supabase/supabase-js";
import {
  meaninglessRuleKeywordReason, humanKeywordRuleHit, summedKeywordRuleHit, type KeywordRule,
} from "../app/lib/brain-keyword-rules";
import { TEST_CONVERSATION_IDS } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const since = arg("since", "2026-09-05");
const showList = process.argv.includes("--list");

async function all<T>(build: (from: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await build(f);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  type Row = KeywordRule & { category: string; conversation_status: string | null };
  const rules = (await all<Row>((f) => sb.from("trigger_action_rules").select("action_type,keyword,confidence,occurrence_count,category,conversation_status").eq("category", "keyword_rule").range(f, f + 999)));
  const readable = (r: Row) => (r.confidence ?? 0) >= 0.65 && (r.occurrence_count ?? 0) >= 1 && typeof r.keyword === "string" && r.keyword.length >= 2;
  const byWhy: Record<string, Row[]> = {};
  for (const r of rules) { const w = meaninglessRuleKeywordReason(r.keyword); if (w) (byWhy[w] ??= []).push(r); }
  const bad = Object.values(byWhy).flat();
  console.log(`=== 1. 語のルール keyword_rule ${rules.length}件（ブレインが読む conf≥0.65: ${rules.filter(readable).length}）`);
  console.log(`意味の無い語 ${bad.length}件（ブレインが読む物 ${bad.filter(readable).length}）`);
  for (const [w, rs] of Object.entries(byWhy)) {
    const ex = rs.filter(readable).sort((a, b) => (b.occurrence_count ?? 0) - (a.occurrence_count ?? 0)).slice(0, 8)
      .map((r) => `「${r.keyword}」→${r.action_type}(${r.confidence}/${r.occurrence_count})`).join(" ");
    console.log(`- ${w}: ${rs.length}件（読む ${rs.filter(readable).length}） 例: ${ex}`);
    if (showList) console.log(`    一覧: ${[...new Set(rs.map((r) => r.keyword))].join(" / ")}`);
  }

  // 2. 信号で埋めた判断
  type Dec = { id: string; conversation_id: string; created_at: string; analyzed_msg_ts: string | null; decision_source: string | null; suggested_action: string | null; actual_aix_type: string | null; matched: boolean | null; actual_at: string | null; digest: { dir?: string } | null };
  const decs = (await all<Dec>((f) => sb.from("brain_decision_logs")
    .select("id,conversation_id,created_at,analyzed_msg_ts,decision_source,suggested_action,actual_aix_type,matched,actual_at,digest")
    .gte("created_at", since).like("decision_source", "signal:%").range(f, f + 999)))
    .filter((d) => !TEST_CONVERSATION_IDS.includes(d.conversation_id) && !/^signal:(scene_|focused_)/.test(d.decision_source ?? ""));
  const before = rules.filter(readable).sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || (b.occurrence_count ?? 0) - (a.occurrence_count ?? 0) || a.keyword.localeCompare(b.keyword));
  const after = before.filter((r) => !meaninglessRuleKeywordReason(r.keyword));
  let wordLike = 0, wordLikeMatched = 0, wordLikeNoAix = 0, wordLikeOther = 0, meaninglessOnly = 0;
  const lines: string[] = [];
  for (const d of decs) {
    const ts = d.analyzed_msg_ts ?? d.created_at;
    const { data: msgs } = await sb.from("messages").select("sender,text,created_at").eq("conversation_id", d.conversation_id)
      .eq("sender", "customer").lte("created_at", new Date(new Date(ts).getTime() + 2000).toISOString())
      .order("created_at", { ascending: false }).limit(1);
    const cust = (msgs?.[0]?.text as string | undefined) ?? "";
    const action = (d.decision_source ?? "").replace(/^signal:/, "");
    const h0 = humanKeywordRuleHit(cust, before); const s0 = summedKeywordRuleHit(cust, before);
    const byWord = (h0?.action_type === action) || (s0?.action === action);
    if (!byWord) continue;
    wordLike++;
    if (d.matched) wordLikeMatched++; else if (!d.actual_aix_type) wordLikeNoAix++; else wordLikeOther++;
    const h1 = humanKeywordRuleHit(cust, after); const s1 = summedKeywordRuleHit(cust, after);
    const stillAfterFilter = (h1?.action_type === action) || (s1?.action === action);
    if (!stillAfterFilter) meaninglessOnly++;
    const kws = h0?.action_type === action ? [h0.keyword] : (s0?.keywords ?? []);
    lines.push(`${d.created_at.slice(0, 16)} ${d.conversation_id.slice(0, 8)} ${d.decision_source} 語[${kws.join("・")}]${stillAfterFilter ? "" : "（意味の無い語だけ）"} → スタッフ: ${d.actual_aix_type ?? "AIX なし"}${d.matched ? "（一致）" : ""}\n    お客様「${cust.replace(/\s+/g, " ").slice(0, 70)}」 方向: ${(d.digest?.dir ?? "").slice(0, 50)}`);
  }
  console.log(`\n=== 2. 信号で埋めた判断（${since}〜・YUMA 除く・場面の信号を除く）${decs.length}件`);
  console.log(`語のルールが同じ action を出す（語のルール由来らしい）: ${wordLike}件 → スタッフが同じ AIX ${wordLikeMatched}・AIX なし ${wordLikeNoAix}・別の AIX ${wordLikeOther}`);
  console.log(`  そのうち意味の無い語だけで当たっていた物: ${meaninglessOnly}件（直し②で消える）／残り ${wordLike - meaninglessOnly}件は直し①（ブレインの「なし」を上書きしない）で消える`);
  for (const l of lines) console.log(l);
}
main().catch((e) => { console.error(e); process.exit(1); });
