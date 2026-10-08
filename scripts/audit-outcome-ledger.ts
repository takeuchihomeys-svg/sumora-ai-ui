// scripts/audit-outcome-ledger.ts — 結果の台帳を目で読む（読むだけ・LLM なし・DB に書かない）
//   ① 案件を結果の種類ごとに N 件ずつ（段階の時刻・根拠・物件）  ② お客様の文の型（他で決めた・引越し中止・審査落ち・申込の取り消し）の当たりを実物で
//   計画: memory/plan_outcome_ledger.md 段3。件数だけ見ない（CLAUDE.md「おかしな文を1通見つけた時」7）
// 実行:
//   npx tsx --env-file=.env.local scripts/audit-outcome-ledger.ts [--n=5] [--show=won|lost|switched|in_progress] [--since=2026-05-01]
//   npx tsx --env-file=.env.local scripts/audit-outcome-ledger.ts --texts [--days=200]    # 文の型の当たりを全部出す
import { createClient } from "@supabase/supabase-js";
import { computeConversationOutcome, listOutcomeConversations } from "../app/lib/deal-outcome-server";
import { detectDealLossText, isScreeningRejectedText, isApplicationCancelText } from "../app/lib/deal-outcome";
import { isTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const N = Number(arg("n", "5"));
const SHOW = arg("show", "");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const d = (s: string | null | undefined) => (s ? new Date(Date.parse(s) + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ") : "-");

async function texts() {
  const since = new Date(Date.now() - Number(arg("days", "200")) * 86_400_000).toISOString();
  type M = { conversation_id: string; sender: string; created_at: string; text: string | null };
  const msgs: M[] = [];
  for (let i = 0; i < 300_000; i += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, created_at, text").gte("created_at", since).order("created_at").order("id").range(i, i + 999);
    if (error) throw new Error(error.message); msgs.push(...((data ?? []) as M[])); if ((data ?? []).length < 1000) break;
  }
  const hits: Record<string, string[]> = { declined_elsewhere: [], move_cancelled: [], screening_rejected: [], application_cancel: [] };
  for (const m of msgs) {
    if (isTestConversation(m.conversation_id)) continue;
    const t = String(m.text ?? "").normalize("NFKC");
    const line = `${m.conversation_id.slice(0, 8)} ${d(m.created_at)} [${m.sender === "customer" ? "客" : "店"}] ${t.replace(/\s+/g, " ").slice(0, 140)}`;
    if (m.sender === "customer") { const k = detectDealLossText(t); if (k) hits[k].push(line); }
    if (isScreeningRejectedText(t)) hits.screening_rejected.push(line);
    if (m.sender === "customer" && isApplicationCancelText(t)) hits.application_cancel.push(line);
  }
  for (const [k, xs] of Object.entries(hits)) { console.log(`\n■ ${k}: ${xs.length}`); for (const x of xs.slice(0, 60)) console.log(`  ${x}`); }
}

async function cases() {
  const ids = await listOutcomeConversations({ sinceCreated: `${arg("since", "2026-05-01")}T00:00:00+09:00` });
  const by: Record<string, string[]> = {};
  for (const id of ids) {
    const o = await computeConversationOutcome(id);
    if (!o) continue;
    for (const r of o.rows) {
      const key = `${r.result}/${r.result_certainty}/${r.result_evidence}${r.lost_type ? `/${r.lost_type}` : ""}`;
      if (SHOW && r.result !== SHOW) continue;
      (by[key] ??= []);
      if (by[key].length >= N) { by[key].push(""); continue; }
      by[key].push(`${id.slice(0, 8)}#${r.episode_no} 段階=${r.max_stage}${r.carried_trust_stage ? `（前の案件 ${r.carried_trust_stage}）` : ""} 初回${d(r.first_contact_at)} 送付${d(r.property_sent_at)} 内覧${d(r.viewing_at)}/${d(r.viewing_held_at)} 申込${d(r.applied_at)}${r.applied_at_estimated ? "（推定）" : ""} 結果${d(r.won_at ?? r.lost_at ?? r.ended_at)}${r.chased === false ? " 追いかけなし" : ""}\n      物件=${r.property_name ?? "-"}（${r.property_evidence ?? "-"}・${r.property_certainty ?? "-"}）`);
    }
  }
  for (const [k, xs] of Object.entries(by).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n■ ${k}: ${xs.length}`);
    for (const x of xs.filter(Boolean)) console.log(`  ${x}`);
  }
}

(process.argv.includes("--texts") ? texts() : cases()).catch((e) => { console.error(e); process.exit(1); });
