// scripts/audit-ungrounded-amount.ts
// 2026-10-02 ⑫ 11巡目: 「会話に無い金額の言い切りは自動で送らない」（staff-confirm-facts.findUngroundedAmount）の線引き。読むだけ・LLM なし。
//   ①AI の下書き（ai_reply_examples.ai_draft・120日）で当たる数と、スタッフがその金額を送った文に残したか（＝止めすぎか）
//   ②人の手打ちで当たる割合（参考: スタッフは資料・相場を知っているので普通に書く＝人の文には当てない前提の確かめ）
// 根拠（groundText）は、その下書き・送信より前の直近30通＋顧客の行の家賃（rent_min/max）。
// 実行: npx tsx --env-file=.env.local scripts/audit-ungrounded-amount.ts [--days=120] [--show=30]
import { createClient } from "@supabase/supabase-js";
import { findUngroundedAmount } from "../app/lib/staff-confirm-facts";
import { isTestConversation } from "../app/lib/test-conversations";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const DAYS = Number(arg("days", "120")), SHOW = Number(arg("show", "30"));
type M = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const msgs: M[] = [];
  for (let f = 0; f < 600_000; f += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(f, f + 999);
    if (error) throw error; msgs.push(...((data ?? []) as M[])); if ((data ?? []).length < 1000) break;
  }
  const by = new Map<string, M[]>();
  for (const m of msgs) { if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push(m); }
  const { data: convs } = await sb.from("conversations").select("id, property_customer_id").limit(5000);
  const pcOf = new Map(((convs ?? []) as Array<{ id: string; property_customer_id: string | null }>).map((c) => [c.id, c.property_customer_id]));
  const { data: pcs } = await sb.from("property_customers").select("id, rent_min, rent_max, initial_cost_limit").limit(5000);
  const pcRent = new Map(((pcs ?? []) as Array<{ id: string; rent_min: number | null; rent_max: number | null; initial_cost_limit: number | null }>).map((p) => [p.id, [p.rent_min, p.rent_max, p.initial_cost_limit].filter(Boolean).map((v) => `${v}円`).join(" ")]));
  const groundOf = (cid: string, at: string) => {
    const ms = (by.get(cid) ?? []).filter((m) => m.created_at < at).slice(-30).map((m) => m.text ?? "").join("\n");
    return `${ms}\n${pcRent.get(pcOf.get(cid) ?? "") ?? ""}`;
  };
  // ① AI の下書き
  const { data: ex } = await sb.from("ai_reply_examples").select("conversation_id, ai_draft, sent_reply, created_at").gte("created_at", since).not("ai_draft", "is", null).limit(20000);
  let nd = 0, hit = 0, kept = 0, changed = 0, shown = 0;
  for (const r of (ex ?? []) as Array<{ conversation_id: string | null; ai_draft: string; sent_reply: string | null; created_at: string }>) {
    if (!r.conversation_id || isTestConversation(r.conversation_id)) continue;
    nd++;
    const h = findUngroundedAmount(r.ai_draft, groundOf(r.conversation_id, r.created_at));
    if (!h) continue;
    hit++;
    const sent = (r.sent_reply ?? "").normalize("NFKC").replace(/[,，]/g, "");
    const keptAll = h.amounts.every((a) => sent.includes(a) || sent.includes(`${Number(a) / 10000}万`));
    if (keptAll) kept++; else changed++;
    if (shown++ < SHOW) console.log(`${r.conversation_id.slice(0, 8)} ${keptAll ? "スタッフも送った" : "スタッフは変えた/消した"}｜案: ${h.text.slice(0, 70)}｜送: ${(r.sent_reply ?? "").replace(/\n/g, " / ").slice(0, 70)}`);
  }
  console.log(`\nAI の下書き ${nd}・会話に無い金額あり ${hit}（スタッフもその金額を送った ${kept}・変えた/消した ${changed}）`);
  // ② 人の手打ち（参考）
  let nh = 0, hh = 0;
  for (const [cid, ms] of by) {
    if (isTestConversation(cid)) continue;
    for (const m of ms) {
      if (m.sender === "customer" || m.is_aix_generated || !(m.text ?? "").trim()) continue;
      nh++;
      if (findUngroundedAmount(m.text, groundOf(cid, m.created_at))) hh++;
    }
  }
  console.log(`人の手打ち ${nh}・会話に無い金額あり ${hh}（参考: 人の文には当てない）`);
})();
