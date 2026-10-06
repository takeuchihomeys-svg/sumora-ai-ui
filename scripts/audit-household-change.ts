// scripts/audit-household-change.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-household-change.ts [--days=365]
// 2026-10-06 ⑫ 竹内「一人になった場合など連動して物件検索の条件も変更されるようにする」（あかり）
//   ① お客様の発言のうち世帯の変わり目（一人になる・二人になる・家族が増える・ペットを手放す）・「小さくて大丈夫」に当たる通（目で読む用に全件出す）
//   ② その時の登録の条件（今の行）に当てると何が変わるか（household-change.planHouseholdConditions）
//   ③ 条件に届いていたか: その発言の後に property_condition_history で外す・足す変更が記録されていたか
//   ④ 世帯の話でない通（申込の書類・内覧・物件1件の質問）に当たらないか＝誤って直す通は目で読んで0にする
// 読み取りのみ。名前は出さない（会話の id の先頭8字）。
import { createClient } from "@supabase/supabase-js";
import { householdChangeOf, smallerOkOf } from "../app/lib/condition-reading";
import { planHouseholdConditions } from "../app/lib/household-change";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const days = Number(arg("days", "365"));
const since = new Date(Date.now() - days * 86400_000).toISOString();

async function pageAll<T>(q: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; ; p++) { const { data, error } = await q(p * 1000, p * 1000 + 999); if (error) throw new Error(error.message); if (!data?.length) break; out.push(...data); if (data.length < 1000) break; }
  return out;
}

async function main() {
  type M = { conversation_id: string; text: string | null; created_at: string };
  const msgs = await pageAll<M>((a, b) => sb.from("messages").select("conversation_id, text, created_at").eq("sender", "customer").gte("created_at", since).order("created_at").range(a, b));
  const hits = msgs.filter((m) => m.text && (householdChangeOf(m.text) || smallerOkOf(m.text)));
  console.log(`お客様の発言 ${msgs.length} 通（${days}日）／世帯の変わり目・小さくて大丈夫 ${hits.length} 通\n`);
  const convIds = [...new Set(hits.map((h) => h.conversation_id))];
  const { data: convs } = await sb.from("conversations").select("id, property_customer_id").in("id", convIds.length ? convIds : ["-"]);
  const pcOf = new Map((convs ?? []).map((c) => [c.id as string, c.property_customer_id as string | null]));
  const pcIds = [...new Set([...pcOf.values()].filter(Boolean))] as string[];
  const { data: pcs } = await sb.from("property_customers").select("id, preferences, other_requests, floor_area_min, floor_plan").in("id", pcIds.length ? pcIds : ["-"]);
  const pcRow = new Map((pcs ?? []).map((p) => [p.id as string, p]));
  const { data: hist } = await sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, new_value, created_at").in("property_customer_id", pcIds.length ? pcIds : ["-"]);
  let wouldChange = 0, reached = 0;
  for (const h of hits) {
    const change = householdChangeOf(h.text);
    const smaller = smallerOkOf(h.text);
    const pcId = pcOf.get(h.conversation_id) ?? null;
    const cur = pcId ? pcRow.get(pcId) : null;
    const plan = cur ? planHouseholdConditions(cur as never, change, smaller) : null;
    const cols = plan ? Object.keys(plan.updates) : [];
    if (cols.length) wouldChange++;
    const after = (hist ?? []).filter((x) => x.property_customer_id === pcId && x.created_at >= h.created_at && /preferences|other_requests|floor_area_min/.test(String(x.changed_field)));
    const got = after.some((x) => change?.kind === "to_single" ? /二人入居|同棲|カップル/.test(String(x.old_value ?? "")) && !/二人入居|同棲|カップル/.test(String(x.new_value ?? "")) : x.changed_field === "floor_area_min");
    if (got) reached++;
    console.log(`${h.created_at.slice(0, 16)} ${h.conversation_id.slice(0, 8)} ${change?.kind ?? "-"}${smaller ? "+smaller" : ""} 条件に届いた=${got ? "○" : "×"} 今の行に当てると=${cols.length ? JSON.stringify(plan!.updates) : "変化なし"}`);
    console.log(`   「${String(h.text).replace(/\n/g, " / ").slice(0, 120)}」`);
    if (plan?.banner) console.log(`   帯: ${plan.banner}`);
  }
  console.log(`\n今の行に当てて列が変わる ${wouldChange} 件／これまでに条件へ届いていた ${reached}/${hits.length} 件`);
}
main().catch((e) => { console.error(e); process.exit(1); });
