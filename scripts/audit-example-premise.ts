// scripts/audit-example-premise.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-example-premise.ts [--name=慶次] [--days=14]
//
// 2026-09-19 竹内（慶次事例）「場面を把握する場所が無いなら作成して強化する。クエリをつくるなどして」
//
// 何を見る道具か:
//   ① その会話の**場面の事実**（行動台帳: 内覧打診・待ち合わせ・物件送付・見積送付）
//   ② その場面で**前提が欠けている語**（example-premise の missingPremiseKeys）
//   ③ その state の手本のうち、前提フィルタで**落ちる手本が何件あるか**（＝写される危険があった手本）
// 読み取りのみ。出力は個人情報を含むので共有しない。
import { createClient } from "@supabase/supabase-js";
import { buildActionLedger, type LedgerAixRow, type LedgerMessage } from "../app/lib/action-ledger";
import { buildPremiseExcludeRe, missingPremiseKeys, PREMISE_RULES, type PremiseFacts } from "../app/lib/example-premise";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const nameQ = arg("name");
const days = Number(arg("days", "14"));

async function factsFor(convId: string): Promise<{ facts: PremiseFacts; staffHist: string; cust: string; state: string }> {
  const { data: msgs } = await sb.from("messages")
    .select("sender, text, created_at").eq("conversation_id", convId)
    .order("created_at", { ascending: false }).limit(40);
  const ordered = (msgs ?? []).reverse();
  const { data: aix } = await sb.from("aix_usage_logs")
    .select("aix_type, created_at, sent_at").eq("conversation_id", convId)
    .order("created_at", { ascending: false }).limit(20);
  const { data: conv } = await sb.from("conversations").select("status").eq("id", convId).maybeSingle();

  const ledger = buildActionLedger({
    recentAixRows: (aix ?? []) as unknown as LedgerAixRow[],
    messages: ordered.map((m) => ({ sender: m.sender as string, text: (m.text ?? "") as string, createdAt: m.created_at as string })) as LedgerMessage[],
    lineTasks: [],
    lastCustomerAt: [...ordered].reverse().find((m) => m.sender === "customer")?.created_at as string ?? null,
    now: Date.now(),
  });
  const cust = [...ordered].reverse().find((m) => m.sender === "customer")?.text ?? "";
  const staffHist = [...ordered].reverse().find((m) => m.sender !== "customer")?.text ?? "";
  return {
    facts: {
      viewingInvited: ledger.facts.viewingInvited,
      meetingPlaceSent: ledger.facts.meetingPlaceSent,
      propertiesSentCount: ledger.facts.propertiesSentCount,
      estimateSent: ledger.facts.estimateSent,
    },
    staffHist: String(staffHist), cust: String(cust), state: String(conv?.status ?? ""),
  };
}

async function report(convId: string, label: string) {
  const { facts, staffHist, cust, state } = await factsFor(convId);
  const missing = missingPremiseKeys({ staffHist, customerMessage: cust, facts });
  const re = buildPremiseExcludeRe({ staffHist, customerMessage: cust, facts });
  console.log(`\n${"=".repeat(68)}`);
  console.log(`■ ${label}  state=${state}`);
  console.log(`  【場面の事実】内覧打診=${facts.viewingInvited} 待ち合わせ=${facts.meetingPlaceSent} 物件送付=${facts.propertiesSentCount}件 見積送付=${facts.estimateSent}`);
  console.log(`  【お客様の直近】${cust.replace(/\n/g, " / ").slice(0, 80)}`);
  console.log(`  【前提が欠けている語】${missing.join(", ") || "（なし）"}`);

  if (!re) { console.log("  → 落とす手本なし"); return; }
  // その state の手本のうち、何件が落ちるか
  const { data: ex } = await sb.from("ai_reply_examples")
    .select("sent_reply").eq("conversation_state", state).limit(1000);
  const list = (ex ?? []).map((e) => String(e.sent_reply ?? "")).filter(Boolean);
  const dropped = list.filter((s) => re.test(s));
  console.log(`  【この state の手本 ${list.length}件のうち、前提が無くて落ちる: ${dropped.length}件（${((100 * dropped.length) / Math.max(list.length, 1)).toFixed(1)}%）】`);
  // ルール別
  for (const r of PREMISE_RULES) {
    if (!missing.includes(r.key)) continue;
    const n = list.filter((s) => r.vocab.test(s)).length;
    if (n > 0) console.log(`      ${r.key.padEnd(14)} ${n}件`);
  }
  console.log(`  --- 落ちる手本の例（3件・これが写されていた）---`);
  dropped.slice(0, 3).forEach((d) => console.log(`      ${d.replace(/\n/g, " / ").slice(0, 100)}`));
}

async function main() {
  if (nameQ) {
    const { data: convs } = await sb.from("conversations")
      .select("id, customer_name, updated_at").ilike("customer_name", `%${nameQ}%`)
      .order("updated_at", { ascending: false }).limit(3);
    for (const c of convs ?? []) await report(c.id as string, `${c.customer_name}（${String(c.id).slice(0, 8)}）`);
    return;
  }
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data: convs } = await sb.from("conversations")
    .select("id, customer_name").gte("updated_at", since)
    .order("updated_at", { ascending: false }).limit(8);
  for (const c of convs ?? []) await report(c.id as string, `${c.customer_name}（${String(c.id).slice(0, 8)}）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
