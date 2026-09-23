// テストで生成した返信本文が「本番と同じ経路（DeepSeek）」で作られたかを確かめる（読み取りのみ）
//
// 2026-09-23 竹内「テストに文の生成は必ずdeepseekでおこなう。返信生成はdeepseekで作成するので」
//   同日の実測: 本番の返信本文の生成は DeepSeek 170回／Claude 205回（7日）なのに、ローカルの YUMA テストは
//   143回すべて Claude だった（.env.local に LLM_ALT_ACTIONS が無く、静かに Claude へ戻っていた）。
//
// 使い方: 生成を伴うテスト（yuma-*.ts）の後に走らせる。
//   npx tsx --env-file=.env.local scripts/check-generation-route.ts [MINUTES=30] [CONV=YUMA]
//   → 直近 MINUTES 分の llm_usage_logs（返信本文の生成＝sys_head ハードゲート）を model 別に数え、
//     DeepSeek が 0 なら ❌（経路が外れている: LLM_ALT_ACTIONS / 申込以降の判定 / 自動返信の歯止め を疑う）
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

async function main() {
  const minutes = Number(process.env.MINUTES ?? 30);
  const conv = process.env.CONV ?? YUMA;
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const { data, error } = await sb.from("llm_usage_logs")
    .select("model, route, env, created_at, sys_head")
    .eq("conversation_id", conv).gte("created_at", since).order("created_at", { ascending: false }).limit(500);
  if (error) { console.error(error.message); process.exit(1); }
  const rows = (data ?? []) as Array<{ model: string | null; route: string | null; env: string | null; sys_head: string | null }>;
  const gen = rows.filter((r) => (r.sys_head ?? "").includes("ハードゲート"));
  const by = new Map<string, number>();
  for (const r of gen) { const k = `${r.env ?? "?"} / ${r.route ?? "?"} / ${r.model ?? "?"}`; by.set(k, (by.get(k) ?? 0) + 1); }
  console.log(`=== 直近${minutes}分・会話 ${conv.slice(0, 8)}… の返信本文の生成 ${gen.length}回 ===`);
  for (const [k, n] of [...by].sort((a, b) => b[1] - a[1])) console.log(`   ${k.padEnd(60)} ${n}`);
  const deepseek = gen.filter((r) => /deepseek/i.test(r.model ?? "")).length;
  const envSet = (process.env.LLM_ALT_ACTIONS ?? "").includes("reply_generate");
  console.log(`\n.env.local の LLM_ALT_ACTIONS に reply_generate: ${envSet ? "あり" : "❌ なし（本番と経路が違う）"}`);
  if (gen.length === 0) console.log("⚠ 生成の記録が無い（時間の範囲か会話IDを確認）");
  else if (deepseek === 0) console.log("❌ DeepSeek で作られた本文が 0 回。経路が外れている: LLM_ALT_ACTIONS ／ 申込以降の判定（post-apply.ts・YUMA は status_manual_back_at を最新に）／ 自動返信の歯止め を疑う");
  else console.log(`✅ DeepSeek ${deepseek}/${gen.length}（本番と同じ経路）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
