// scripts/audit-c6-situational.ts — C6『弊社でもお申込み・ご内覧頂けます』を状況の判断に改めた（1c4dddf7）時の実測（読むだけ・LLM なし・本文は伏せる）
//   ① AIX が作った文（aix_usage_logs）でこの一文が入っていた数と、その時の場面（viewing_plan/hold/compare/なし）
//   ② 人の実送信: 他社の物件の話の後の見積書の番で、スタッフがこの一文を書いた割合（場面別）
// 実行: npx tsx --env-file=.env.local scripts/audit-c6-situational.ts [--days=180]
import { createClient } from "@supabase/supabase-js";
import { otherAgentSituation, resolveOtherAgentEstimate } from "../app/lib/aix-owner-answers-1021";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=180").slice(7)) || 180;
type M = { conversation_id: string; sender: string; text: string | null; created_at: string };
const HERE_RE = /弊社(?:でも|にて|で)[^\n]{0,12}(?:お申込|お申し込|ご内覧|ご内見|内覧|内見)/;
const mask = (s: string | null) => String(s ?? "").replace(/[0-9０-９]/g, "＊").replace(/\S+?(?:さん|様)/g, "〇〇さん").replace(/[ァ-ヶー]{3,}|[A-Za-z]{3,}/g, "□□").replace(/\s+/g, " ").slice(0, 90);

async function convMsgs(id: string, until?: string): Promise<M[]> {
  let q = sb.from("messages").select("conversation_id, sender, text, created_at").eq("conversation_id", id).order("created_at", { ascending: false }).limit(60);
  if (until) q = q.lt("created_at", until);
  const { data } = await q;
  return ((data ?? []) as M[]).reverse();
}

async function main() {
  // ① AIX が作った文
  const { data: logs, error } = await sb.from("aix_usage_logs").select("id, aix_type, created_at, sent_at, conversation_id, generated_text")
    .ilike("generated_text", "%弊社でもお申込み・ご内覧頂けます%").order("created_at", { ascending: false }).limit(200);
  if (error) throw error;
  const gen: Record<string, number> = {};
  const genEx: string[] = [];
  let genSent = 0, wouldAppendNow = 0;
  for (const r of (logs ?? []) as Array<{ aix_type: string; created_at: string; sent_at: string | null; conversation_id: string | null }>) {
    const before = r.conversation_id ? await convMsgs(r.conversation_id, r.created_at) : [];
    const sit = otherAgentSituation(before, {}) ?? "none";
    gen[sit] = (gen[sit] ?? 0) + 1;
    if (r.sent_at) genSent++;
    if (resolveOtherAgentEstimate(before, {}).otherAgent) wouldAppendNow++;
    const last = [...before].reverse().find((m) => otherAgentSituation([m], {}) !== null) ?? [...before].reverse().find((m) => m.sender === "customer");
    if (genEx.length < 8) genEx.push(`${r.created_at.slice(0, 10)} ${r.aix_type} 場面=${sit} 送信=${r.sent_at ? "済" : "未"} 直前のお客様「${mask(last?.text ?? "")}」`);
  }
  // ①b 3bf336a6（10/21 08:20 JST）以降の見積書の AIX: 旧の決め（他社の話があれば毎回）と新しい決めで足す数
  const { data: estLogs } = await sb.from("aix_usage_logs").select("aix_type, created_at, conversation_id, generated_text").gte("created_at", "2026-10-20T23:20:00Z").order("created_at", { ascending: false }).limit(1000);
  let estN = 0, oldAppend = 0, newAppend = 0; const estSit: Record<string, number> = {}; const estEx: string[] = [];
  for (const r of (estLogs ?? []) as Array<{ aix_type: string; created_at: string; conversation_id: string | null; generated_text: string | null }>) {
    if (!(r.aix_type === "estimate_sheet" || /御見積書/.test(r.generated_text ?? "")) || !r.conversation_id) continue;
    estN++;
    const before = await convMsgs(r.conversation_id, r.created_at);
    const o = resolveOtherAgentEstimate(before, { ESTIMATE_OTHER_AGENT_LINE: "always" }); const n = resolveOtherAgentEstimate(before, {});
    if (o.otherAgent) { oldAppend++; estSit[o.otherAgentSituation ?? "none"] = (estSit[o.otherAgentSituation ?? "none"] ?? 0) + 1;
      const last = [...before].reverse().find((m) => otherAgentSituation([m], {}) !== null);
      if (estEx.length < 8) estEx.push(`${r.created_at.slice(0, 10)} ${r.aix_type} 場面=${o.otherAgentSituation} 新=${n.otherAgent ? "足す" : "判断"} お客様「${mask(last?.text ?? "")}」`); }
    if (n.otherAgent) newAppend++;
  }
  console.log(JSON.stringify({ estimateLogsSince1021: estN, oldRuleAppends: oldAppend, newRuleAppends: newAppend, oldAppendBySituation: estSit }));
  console.log("— 10/21 以降の見積の AIX で旧の決めなら足していた例（伏せ字）\n" + estEx.join("\n"));
  // ② 人の実送信
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: M[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error: e } = await sb.from("messages").select("conversation_id, sender, text, created_at").gte("created_at", since).order("created_at").range(from, from + 999);
    if (e) throw e;
    rows.push(...((data ?? []) as M[]));
    if (!data || data.length < 1000) break;
  }
  const byConv = new Map<string, M[]>();
  for (const r of rows) { if (!byConv.has(r.conversation_id)) byConv.set(r.conversation_id, []); byConv.get(r.conversation_id)!.push(r); }
  const human: Record<string, { cards: number; withLine: number }> = {};
  const humanEx: string[] = [];
  for (const msgs of byConv.values()) {
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.sender === "customer" || !/初期費用[：:]\s*[0-9０-９,，]+円/.test(m.text ?? "")) continue;
      if (i > 0 && msgs[i - 1].sender !== "customer" && /初期費用[：:]/.test(msgs[i - 1].text ?? "")) continue;
      const before = msgs.slice(Math.max(0, i - 40), i);
      const sit = otherAgentSituation(before, {});
      if (!sit) continue;
      const t0 = Date.parse(m.created_at);
      const after = msgs.slice(i + 1).filter((x) => x.sender !== "customer" && Date.parse(x.created_at) - t0 < 30 * 60_000).map((x) => x.text ?? "").join("\n");
      const has = HERE_RE.test(after + (m.text ?? ""));
      human[sit] = human[sit] ?? { cards: 0, withLine: 0 };
      human[sit].cards++; if (has) human[sit].withLine++;
      const last = [...before].reverse().find((x) => otherAgentSituation([x], {}) !== null);
      if (humanEx.length < 10) humanEx.push(`${m.created_at.slice(0, 10)} 場面=${sit} 一文=${has ? "あり" : "なし"} お客様「${mask(last?.text ?? "")}」`);
    }
  }
  console.log(JSON.stringify({ generatedWithLine: (logs ?? []).length, generatedSent: genSent, generatedBySituation: gen, wouldStillAppendNow: wouldAppendNow, days, humanBySituation: human }, null, 1));
  console.log("— AIX の例（伏せ字）\n" + genEx.join("\n"));
  console.log("— 人の実送信の例（伏せ字）\n" + humanEx.join("\n"));
}
main().catch((e) => { console.error(e); process.exit(1); });
