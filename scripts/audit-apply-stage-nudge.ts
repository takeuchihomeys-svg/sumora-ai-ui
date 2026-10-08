// scripts/audit-apply-stage-nudge.ts — 「審査に出した形跡があるのに段階が申込でない」促しの線を実 LINE で目で読む（読むだけ・LLM なし・DB に書かない）
//   ① 審査の形跡と読んだ文を全部（こちら／お客様）＋ 似た語で当てなかった文の見本  ② 今、画面に促しが出る会話
//   決まりは app/lib/apply-stage-nudge.ts（竹内さんの決定 10/08 ④）
// 実行: npx tsx --env-file=.env.local scripts/audit-apply-stage-nudge.ts [--days=120] [--miss=40]
import { createClient } from "@supabase/supabase-js";
import { screeningEvidenceOf, resolveApplyStageNudge, isPreApplyForNudge } from "../app/lib/apply-stage-nudge";
import { isTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const d = (s: string | null | undefined) => (s ? new Date(Date.parse(s) + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ") : "-");

async function main() {
  const since = new Date(Date.now() - Number(arg("days", "120")) * 86_400_000).toISOString();
  type M = { conversation_id: string; sender: string; created_at: string; text: string | null };
  const msgs: M[] = [];
  for (let i = 0; i < 400_000; i += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, created_at, text").gte("created_at", since).ilike("text", "%審査%").order("created_at").order("id").range(i, i + 999);
    if (error) throw new Error(error.message); msgs.push(...((data ?? []) as M[])); if ((data ?? []).length < 1000) break;
  }
  const hit: string[] = [], miss: string[] = [];
  for (const m of msgs) {
    if (isTestConversation(m.conversation_id)) continue;
    const line = `${m.conversation_id.slice(0, 8)} ${d(m.created_at)} [${m.sender === "customer" ? "客" : "店"}] ${String(m.text ?? "").replace(/\s+/g, " ").slice(0, 150)}`;
    if (screeningEvidenceOf({ sender: m.sender, text: m.text, createdAt: m.created_at })) hit.push(line); else miss.push(line);
  }
  console.log(`\n=== 審査の形跡と読んだ文 ${hit.length}通（「審査」を含む ${msgs.length}通のうち）===`);
  for (const l of hit) console.log(l);
  const nMiss = Number(arg("miss", "40"));
  console.log(`\n=== 当てなかった文の見本（新しい順 ${nMiss}通）===`);
  for (const l of miss.slice(-nMiss).reverse()) console.log(l);

  // ② 今の促し
  const convIds = [...new Set(msgs.map((m) => m.conversation_id))].filter((id) => !isTestConversation(id));
  console.log(`\n=== 今、促しが出る会話（審査の語がある ${convIds.length}会話から）===`);
  let shown = 0;
  for (const id of convIds) {
    const { data: c } = await sb.from("conversations").select("status, status_manual_back_at, customer_name").eq("id", id).maybeSingle();
    if (!c || !isPreApplyForNudge(c.status)) continue;
    const { data: hist } = await sb.from("conversation_stage_history").select("from_status, to_status, changed_at").eq("conversation_id", id).order("changed_at", { ascending: false }).limit(50);
    const pre = new Set(["applying", "application", "screening", "contract"]);
    const back = ((hist ?? []) as Array<{ from_status: string | null; to_status: string | null; changed_at: string }>).find((h) => pre.has(h.from_status ?? "") && !pre.has(h.to_status ?? ""));
    const lastBackAt = [back?.changed_at, c.status_manual_back_at].filter(Boolean).sort().pop() ?? null;
    const { data: recent } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", id).order("created_at", { ascending: false }).limit(200);
    const n = resolveApplyStageNudge({ status: c.status, lastBackAt, nowMs: Date.now(), messages: ((recent ?? []) as Array<{ sender: string; text: string | null; created_at: string }>).map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at })) });
    if (!n) continue;
    shown++;
    const ev = ((recent ?? []) as Array<{ sender: string; text: string | null; created_at: string }>).find((m) => m.created_at === n.at);
    console.log(`${id.slice(0, 8)} ${c.status} 戻し=${d(lastBackAt)} ${n.kind}/${n.by} ${d(n.at)} ${String(ev?.text ?? "").replace(/\s+/g, " ").slice(0, 120)}`);
  }
  console.log(`→ ${shown}会話`);
}
main().catch((e) => { console.error(e); process.exit(1); });
