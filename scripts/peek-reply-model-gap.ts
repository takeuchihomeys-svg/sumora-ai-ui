// 本番のお客様の会話だけで、返信本文が DeepSeek に回っているかを見る（読み取りのみ）
// 2026-09-21 竹内「返信の部分はdeepsheek一択になっているか」
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;

async function main() {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 30; p++) {
    const { data, error } = await sb.from("llm_usage_logs")
      .select("created_at, route, model, env, status, stream, conversation_id, sys_head, input_uncached, output_tokens")
      .gte("created_at", "2026-09-19T00:00:00Z").order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  const gen = out.filter((r) => String(r.route) === "/api/generate-reply"
    && /ハードゲート|指示の優先順位/.test(String(r.sys_head ?? "")));
  const prod = gen.filter((r) => String(r.env) === "production" && String(r.conversation_id ?? "") !== YUMA);

  const show = (title: string, rows: Array<Record<string, unknown>>) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(String(r.model), (m.get(String(r.model)) ?? 0) + 1);
    const tot = rows.length || 1;
    console.log(`\n=== ${title}（${rows.length}回）===`);
    for (const [k, c] of [...m.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`   ${String(c).padStart(4)}回 (${(c / tot * 100).toFixed(1).padStart(5)}%)  ${k}  ${k.startsWith("deepseek") ? "✅" : "⚠ Claude"}`);
    }
  };
  show("切り替え後(9/19〜)の返信本文 — 全部", gen);
  show("切り替え後 — 本番のお客様の会話だけ（YUMA・localを除く）", prod);

  console.log(`\n=== Claude に残った本番の回（会話・ストリーミング・状態）===`);
  for (const r of prod.filter((r) => String(r.model).startsWith("claude")).slice(0, 15)) {
    console.log(`   ${String(r.created_at).slice(0, 19)}  conv=${String(r.conversation_id ?? "なし").slice(0, 8)}  stream=${r.stream}  status=${r.status}  入力${n(r.input_uncached)}`);
  }

  console.log(`\n=== 日別（本番のお客様の会話だけ）===`);
  const byDay = new Map<string, { ds: number; cl: number }>();
  for (const r of prod) {
    const d = String(r.created_at).slice(0, 10);
    const b = byDay.get(d) ?? { ds: 0, cl: 0 };
    if (String(r.model).startsWith("deepseek")) b.ds++; else b.cl++;
    byDay.set(d, b);
  }
  for (const [d, v] of [...byDay.entries()].sort()) {
    const t = v.ds + v.cl;
    console.log(`   ${d}  DeepSeek ${String(v.ds).padStart(3)} / Claude ${String(v.cl).padStart(3)}  → DeepSeek ${(v.ds / t * 100).toFixed(1)}%`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
