// scripts/audit-material-priority-hit.ts — MATERIAL_PRIORITY の shadow の当たり（入口が選んだ3つ × 竹内さん本人の一手 × USED_MARKERS）を数える（読むだけ・LLM なし・費用0）
// 2026-11-26 作業員L（竹内さん「統括の連携と優先度・かなり重要」・統括役の頼み）: 本番の判断の記録（digest.mpr のある番）ごとに、その後 24時間の内の
//   最初のこちらの通が竹内さん本人（messages.staff_writer=takeuchi）なら、その一手（AIX の種類・返信は ""）で app/lib/material-priority.priorityHitsOf を当てる。
//   --write で quality_daily に mp:shadow_hit（当たりの割合・n＝決められた番・detail に目印ごとの数と当たった番の会話と時刻）を書く。11/30 の MATERIAL_PRIORITY の組の効く問題はこの当たった番から選ぶ。
//   晩の費用0の仕事で毎晩（前の24時間）・毎朝の1枚にも1行。申込以降とテストの会話は数えない
// 実行: npx tsx --env-file=.env.local scripts/audit-material-priority-hit.ts [--hours=24] [--write]
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { priorityHitsOf, type PriorityHitRow } from "../app/lib/material-priority";
import { isTestConversation } from "../app/lib/test-conversations";

const POST = new Set(["applying", "application", "screening", "approved", "contract", "closed_won"]);
/** その番の後 24時間の内の最初のこちらの通が竹内さん本人なら一手（AIX の種類・返信は ""）・違えば null */
export async function takeuchiMoveAfter(sb: SupabaseClient, conv: string, atIso: string): Promise<string | null> {
  const t = Date.parse(atIso);
  const { data: m } = await sb.from("messages").select("created_at, is_aix_generated, staff_writer").eq("conversation_id", conv).eq("sender", "staff").gt("created_at", atIso).lt("created_at", new Date(t + 864e5).toISOString()).order("created_at").limit(1);
  const x = ((m ?? []) as Array<{ created_at: string; is_aix_generated: boolean | null; staff_writer: string | null }>)[0];
  if (!x || x.staff_writer !== "takeuchi") return null;
  if (!x.is_aix_generated) return "";
  const xt = Date.parse(x.created_at);
  const { data: a } = await sb.from("aix_usage_logs").select("aix_type").eq("conversation_id", conv).gte("created_at", new Date(xt - 180_000).toISOString()).lte("created_at", new Date(xt + 180_000).toISOString()).limit(1);
  return String(((a ?? []) as Array<{ aix_type: string | null }>)[0]?.aix_type ?? "").split("/")[0] || null;
}
export async function measurePriorityHits(sb: SupabaseClient, sinceIso: string, untilIso: string) {
  const { data } = await sb.from("brain_decision_logs").select("conversation_id, created_at, conversation_status, digest").gte("created_at", sinceIso).lt("created_at", untilIso).neq("source", "test").not("digest->>mpr", "is", null).limit(3000);
  const rows: PriorityHitRow[] = [];
  for (const r of (data ?? []) as Array<{ conversation_id: string; created_at: string; conversation_status: string | null; digest: Record<string, unknown> | null }>) {
    if (!r.digest || isTestConversation(r.conversation_id) || POST.has(String(r.conversation_status ?? ""))) continue;
    rows.push({ conv: r.conversation_id, at: r.created_at, digest: r.digest, takeuchiAix: await takeuchiMoveAfter(sb, r.conversation_id, r.created_at) });
  }
  return { withMpr: (data ?? []).length, ...priorityHitsOf(rows) };
}

if (require.main === module) (async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const hours = Number(process.argv.find((a) => a.startsWith("--hours="))?.slice(8) ?? "24") || 24;
  const until = new Date(), since = new Date(until.getTime() - hours * 3_600_000);
  const r = await measurePriorityHits(sb, since.toISOString(), until.toISOString());
  console.log(`MATERIAL_PRIORITY の shadow の当たり（前の${hours}時間・mpr のある判断 ${r.withMpr}・竹内さん本人の番 ${r.turns}）: 当たり ${r.hit}・外れ ${r.miss}・決められない ${r.undecided}・割合 ${r.rate ?? "—"}%`);
  console.log(`目印ごと: ${Object.entries(r.byKey).map(([k, v]) => `${k} ${v.hit}/${v.of}`).join("・") || "なし"}`);
  if (process.argv.includes("--write")) {
    const day = new Date(until.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
    const { error } = await sb.from("quality_daily").upsert([{ day, metric: "mp:shadow_hit", scope: "all", value: r.rate, n: r.hit + r.miss, detail: { turns: r.turns, hit: r.hit, miss: r.miss, undecided: r.undecided, withMpr: r.withMpr, byKey: r.byKey, hits: r.hits.slice(0, 200) } }], { onConflict: "day,metric,scope" });
    if (error) throw new Error(error.message);
    console.log(`quality_daily に書いた: mp:shadow_hit（${day}）`);
  }
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
