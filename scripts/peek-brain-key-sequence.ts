// ブレイン（action=brain_fresh/brain_full）の sys_key_full が時間順にどう入れ替わるかを見る（読み取りのみ・本文は出さない）
// 目的: 温め（brain-warm）の反証。鍵が「デプロイ／DB更新で前に進む」だけか、「同じ時間帯で A→B→A と行き来する（＝system[1] の並びが非決定）」かを事実で見る。
// 併せて system[1] の材料の並びに同点があるか（ai_reply_knowledge の importance+created_at・trigger_action_rules の keyword）を数える。
// 実行: npx tsx --env-file=.env.local scripts/peek-brain-key-sequence.ts [--days=2]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
const days = Number(arg("days") ?? "2");
const jst = (s: string) => new Date(new Date(s).getTime() + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");

async function main() {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data, error } = await sb.from("llm_usage_logs")
    .select("created_at, action, env, status, cache_read, cache_write_1h, sys_key_full, duration_ms")
    .gte("created_at", since).in("action", ["brain_fresh", "brain_full", "brain_fresh_claude"]).order("created_at", { ascending: true }).limit(2000);
  if (error) { console.log(error.message); process.exit(1); }
  const rows = (data ?? []) as Array<{ created_at: string; action: string; env: string | null; status: number; cache_read: number; cache_write_1h: number; sys_key_full: string | null; duration_ms: number }>;
  console.log(`=== ${days}日分 brain_* ${rows.length}行: 鍵が切り替わった所だけ（env 別・時間順） ===`);
  for (const env of ["production", "local"]) {
    console.log(`--- env=${env}`);
    let prev: string | null = null; let run = 0; let runStart = "";
    const seen = new Map<string, number>();
    for (const r of rows.filter((x) => x.env === env)) {
      const k = r.sys_key_full ?? "(null)";
      seen.set(k, (seen.get(k) ?? 0) + 1);
      if (k !== prev) {
        if (prev) console.log(`  ${runStart}〜 ${prev} ×${run}`);
        prev = k; run = 0; runStart = jst(r.created_at);
      }
      run++;
    }
    if (prev) console.log(`  ${runStart}〜 ${prev} ×${run}`);
    // 行き来（A→B→A）の検出: 鍵が「戻った」回数
    const order: string[] = [];
    for (const r of rows.filter((x) => x.env === env)) { const k = r.sys_key_full ?? "(null)"; if (order[order.length - 1] !== k) order.push(k); }
    const returned = order.filter((k, i) => order.slice(0, i).includes(k)).length;
    console.log(`  鍵の種類 ${seen.size}・切り替わり ${order.length - 1}回・前に出た鍵に戻った回数 ${returned}回`);
  }
  // 冷えた回（cache_write_1h >= 35k）の duration
  const cold = rows.filter((r) => r.env === "production" && r.cache_write_1h >= 35_000);
  console.log(`\n=== 本番の全冷え ${cold.length}回 ===`);
  for (const r of cold) console.log(`  ${jst(r.created_at)} ${r.action} w1h=${r.cache_write_1h} read=${r.cache_read} 所要 ${Math.round(r.duration_ms / 1000)}s`);

  // system[1] の材料の同点
  const { data: kn } = await sb.from("ai_reply_knowledge").select("importance, created_at").eq("category", "principle").gte("importance", 9)
    .or("hypothesis_status.is.null,hypothesis_status.neq.rejected").order("importance", { ascending: false }).order("created_at", { ascending: false }).limit(10);
  const knKeys = (kn ?? []).map((r: { importance: number; created_at: string }) => `${r.importance}|${r.created_at}`);
  console.log(`\n=== ai_reply_knowledge 上位10の (importance, created_at) 同点: ${knKeys.length - new Set(knKeys).size}組 ===`);
  const { data: tr } = await sb.from("trigger_action_rules").select("keyword").like("keyword", "BOUNDARY%").gte("confidence", 0.5).order("keyword", { ascending: true }).limit(10);
  const trKeys = (tr ?? []).map((r: { keyword: string }) => r.keyword);
  console.log(`=== trigger_action_rules BOUNDARY% 上位10の keyword 同点: ${trKeys.length - new Set(trKeys).size}組（件数 ${trKeys.length}） ===`);
  const { count: trTotal } = await sb.from("trigger_action_rules").select("*", { count: "exact", head: true }).like("keyword", "BOUNDARY%").gte("confidence", 0.5);
  console.log(`    BOUNDARY% かつ confidence>=0.5 の総数 ${trTotal}（10 を超えていれば limit の境目で同点の入れ替わりが起き得る）`);
  const { data: pr } = await sb.from("ai_prompt_rules").select("priority, id").eq("is_active", true).eq("is_permanent", true).is("action_type", null).order("priority", { ascending: false }).order("id", { ascending: true }).limit(20);
  console.log(`=== ai_prompt_rules 恒久ルール ${pr?.length ?? 0}件（id で決定的） ===`);
}
main().catch((e) => { console.error(e); process.exit(1); });
