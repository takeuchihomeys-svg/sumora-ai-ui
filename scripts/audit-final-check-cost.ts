// ファイナルチェックはボトルネックか・DeepSeek に置き換えられるか（読み取りのみ）
//
// 2026-09-20 竹内「ファイナルチェックの部分がボトルネックになっていないかも確認
//   ファイナルチェックの部分 DeepSeek に置き換えが出来るなら置き換えする」
//
// 設計知見（先に読むべきもの）:
//   「fail-open の検査を別クラウドに回すと、守りが黙って外れる — JSON スキーマ強制が変換で落ちる」
//   final-check の callSonnet は Anthropic に output_config:{format:{type:"json_schema", schema:ISSUE_SCHEMA}} を
//   送って**出力の形を強制**しているが、toOpenAIBody はこの項目を変換していない。
//   DeepSeek に回すと形の強制が消え、JSON.parse 失敗 → callSonnet が throw →
//   そのパスは **fail-open で passes_completed に載らず、下書きはそのまま通る**。
//   つまり「安くなった」ように見えて**検査が動かないまま安くなる**。
//
// ここでは実データで ①所要時間 ②失敗しているパス ③費用 を出し、置き換えの是非を判断する材料にする。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function main() {
  const days = Number(process.env.DAYS ?? 14);
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  // ① 所要時間（conversations.ai_draft_check.pass_ms）
  const { data: cs } = await sb.from("conversations").select("id, ai_draft_check, updated_at")
    .not("ai_draft_check", "is", null).order("updated_at", { ascending: false }).limit(400);
  const rows = (cs ?? []) as unknown as Array<Record<string, unknown>>;
  const passMs = new Map<string, number[]>();
  let withCheck = 0, okTrue = 0, revisionExhausted = 0;
  const failCount = new Map<string, number>();
  for (const r of rows) {
    const c = r.ai_draft_check as Record<string, unknown> | null;
    if (!c || typeof c !== "object") continue;
    withCheck++;
    if (c.ok === true) okTrue++;
    if (c.revision_exhausted === true) revisionExhausted++;
    const pm = c.pass_ms as Record<string, number> | undefined;
    if (pm) for (const [k, v] of Object.entries(pm)) {
      if (!passMs.has(k)) passMs.set(k, []);
      passMs.get(k)!.push(Number(v));
    }
    const pf = c.pass_failures as string[] | undefined;
    if (Array.isArray(pf)) for (const f of pf) failCount.set(String(f), (failCount.get(String(f)) ?? 0) + 1);
  }
  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  const p90 = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * 0.9)] : NaN; };
  console.log(`=== ① ファイナルチェックの所要時間（検査の記録がある ${withCheck}件）===`);
  let sumMed = 0;
  for (const [k, a] of [...passMs.entries()].sort((x, y) => med(y[1]) - med(x[1]))) {
    console.log(`   ${k.padEnd(16)} 中央値 ${String(Math.round(med(a))).padStart(5)}ms  p90 ${String(Math.round(p90(a))).padStart(5)}ms  (${a.length}件)`);
    sumMed += med(a);
  }
  console.log(`   ※ 3パスは並列なので、実際の待ち時間は**最も遅いパス**（約 ${Math.round(Math.max(...[...passMs.values()].map(med)))}ms）`);
  console.log(`   参考: 直列に足すと ${Math.round(sumMed)}ms`);
  console.log(`   指摘なし（ok=true）: ${okTrue}/${withCheck}件 ／ 修正しきれなかった: ${revisionExhausted}件`);
  if (failCount.size) {
    console.log(`\n   --- 失敗したパス（fail-open で黙って通る＝検査が動いていない）---`);
    for (const [k, n] of [...failCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(4)}件  ${k}`);
  } else console.log(`   失敗したパス: 0件`);

  // ② 生成全体の中での位置（llm_usage_logs）
  const { data: lu } = await sb.from("llm_usage_logs")
    .select("route, model, input_tokens, output_tokens, cache_read_tokens, cost_usd, duration_ms, created_at")
    .gte("created_at", since).limit(6000);
  const logs = (lu ?? []) as unknown as Array<Record<string, unknown>>;
  const byRoute = new Map<string, { n: number; cost: number; ms: number[]; model: Set<string> }>();
  for (const l of logs) {
    const r = String(l.route ?? "?");
    if (!byRoute.has(r)) byRoute.set(r, { n: 0, cost: 0, ms: [], model: new Set() });
    const c = byRoute.get(r)!;
    c.n++; c.cost += Number(l.cost_usd ?? 0);
    if (Number.isFinite(Number(l.duration_ms))) c.ms.push(Number(l.duration_ms));
    c.model.add(String(l.model ?? "?"));
  }
  console.log(`\n=== ② LLM 呼び出し（直近${days}日 ${logs.length}件）===`);
  console.log(`   ${"route".padEnd(22)} 回数    費用$     中央値ms  モデル`);
  for (const [r, c] of [...byRoute.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 14)) {
    console.log(`   ${r.padEnd(22)} ${String(c.n).padStart(5)}  ${c.cost.toFixed(2).padStart(8)}  ${String(Math.round(med(c.ms))).padStart(8)}  ${[...c.model].slice(0, 2).join(",")}`);
  }
  const total = [...byRoute.values()].reduce((s, c) => s + c.cost, 0);
  console.log(`   合計 $${total.toFixed(2)}（${days}日）＝ 1日あたり $${(total / days).toFixed(2)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
