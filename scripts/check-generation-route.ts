// テストで生成した返信本文が「本番と同じ経路（DeepSeek）」で作られたかを確かめる（読み取りのみ）
//
// 2026-09-23 竹内「テストに文の生成は必ずdeepseekでおこなう。返信生成はdeepseekで作成するので」
//   同日の実測: 本番の返信本文の生成は DeepSeek 170回／Claude 205回（7日）なのに、ローカルの YUMA テストは
//   143回すべて Claude だった（.env.local に LLM_ALT_ACTIONS が無く、静かに Claude へ戻っていた）。
//
// 2026-09-26 テストの3段（竹内「この形でおこなう」）: テスト用の切り替え LLM_TEST_MODE=deepseek-all の状態と、
//   手元（env=local*）で Claude に行った呼び出し（ブレインを除く）の数も出す。
//   ① 試行錯誤（LLM_TEST_MODE=deepseek-all で開発サーバを起動）… ブレイン以外の Claude が 0 なら ✅
//   ③ 最後の確かめ（LLM_TEST_MODE を外して起動）… 判定・最終チェックが Claude で動いていれば本番と同じ組み合わせ
//
// 使い方: 生成を伴うテスト（yuma-*.ts）の前後に走らせる。
//   npx tsx --env-file=.env.local scripts/check-generation-route.ts [MINUTES=30] [CONV=YUMA]
//   → 直近 MINUTES 分の llm_usage_logs（返信本文の生成＝sys_head ハードゲート）を model 別に数え、
//     DeepSeek が 0 なら ❌（経路が外れている: LLM_ALT_ACTIONS / 申込以降の判定 / 自動返信の歯止め を疑う）
//   ⚠ .env.local の LLM_TEST_MODE を見るのはこのスクリプトの環境。開発サーバを別の env で起動した時は、
//     下の「env 列」（local:deepseek-all ＝切り替えありの回）で判断する
import { createClient } from "@supabase/supabase-js";
import { readTestMode, testModeBlockedReason, isBrainCall } from "../app/lib/llm-test-mode";

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

  // ── テスト用の切り替え（LLM_TEST_MODE）──
  const mode = readTestMode(process.env);
  const blocked = testModeBlockedReason(process.env);
  console.log(`\n=== テスト用の切り替え（LLM_TEST_MODE）===`);
  console.log(`   この環境の値: ${mode ?? "なし（本番と同じ組み合わせ＝判定・最終チェックは Claude）"}${blocked ? `  ⚠ ${blocked}` : ""}`);
  // 判定・最終チェックは conversation_id を持たない呼び出しが多いので、会話ではなく手元（env=local*）の全部で数える
  const { data: all, error: e2 } = await sb.from("llm_usage_logs")
    .select("model, route, env, action, sys_head, status, error_type")
    .like("env", "local%").gte("created_at", since).order("created_at", { ascending: false }).limit(2000);
  if (e2) { console.error(e2.message); process.exit(1); }
  const loc = (all ?? []) as Array<{ model: string | null; route: string | null; env: string | null; action: string | null; sys_head: string | null; status: number | null; error_type: string | null }>;
  const isClaude = (m: string | null) => /claude|sonnet|haiku|opus/i.test(m ?? "");
  const groups = new Map<string, number>();
  for (const r of loc) {
    const kind = isClaude(r.model) ? (isBrainCall(r.action, r.sys_head) ? "Claude（ブレイン）" : "Claude（ブレイン以外）") : (r.model ?? "?");
    const k = `${(r.env ?? "?").padEnd(20)} ${kind.padEnd(22)} ${r.route ?? "(route なし)"}`;
    groups.set(k, (groups.get(k) ?? 0) + 1);
  }
  console.log(`   直近${minutes}分の手元（env=local*）の呼び出し ${loc.length}回（env 列 / 相手 / route）`);
  for (const [k, n] of [...groups].sort((a, b) => b[1] - a[1])) console.log(`     ${k.padEnd(70)} ${n}`);
  const testRows = loc.filter((r) => (r.env ?? "").includes(":deepseek-all"));
  const leaked = testRows.filter((r) => isClaude(r.model) && !isBrainCall(r.action, r.sys_head));
  const altFailed = testRows.filter((r) => r.error_type === "alt_failed").length;
  if (testRows.length === 0) console.log("   切り替えありの回（env=local:deepseek-all）の記録なし");
  else if (leaked.length === 0) console.log(`   ✅ 切り替えありの回: ブレイン以外の Claude 0回（DeepSeek 失敗 ${altFailed}回）`);
  else console.log(`   ❌ 切り替えありの回に ブレイン以外の Claude ${leaked.length}回（画像つき・申込以降は Claude のまま。それ以外なら経路が外れている）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
