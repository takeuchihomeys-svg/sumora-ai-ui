// scripts/audit-deal-condition-gap.ts — 「申込したのに条件の時刻が無い」件を分ける（台帳 #728・作業員A の頼み・読むだけ・LLM なし・DeepSeek に渡さない）
// 2026-11-25 作業員L。申込より前の通だけ読む（申込以降・審査の中身は読まない）。出すのは数と会話 id の頭8字だけ（文は出さない）。広い読み＝22時以降
//   分け: first_msg_conditions＝スタッフの最初の通より前にお客様が条件を2種類以上書いた（条件の段を通らない道）
//         staff_hand_asked＝スタッフが手打ちで条件を聞いた（記録の抜け＝条件の時刻を付ける側の直しの対象）
//         later_customer_conditions＝聞かれずに後からお客様が条件・brought_property＝物件の持ち込み・no_conditions_seen＝通に条件が見えない
// 実行: npx tsx --env-file=.env.local scripts/audit-deal-condition-gap.ts [--out=<json>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { conditionGapOf, type FlowMsg, type CondGapKind } from "./lib/deal-flow";
import { isTestConversation } from "../app/lib/test-conversations";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const JA: Record<CondGapKind, string> = {
  first_msg_conditions: "初回の通に条件（条件の段を通らない道）",
  staff_hand_asked: "スタッフが手打ちで条件を聞いた（記録の抜け）",
  later_customer_conditions: "聞かれずに後からお客様が条件",
  brought_property: "物件の持ち込み",
  no_conditions_seen: "通に条件が見えない",
};

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const { data, error } = await sb.from("deal_outcomes").select("id, conversation_id, first_contact_at, applied_at").not("applied_at", "is", null).is("condition_at", null).limit(2000);
  if (error) throw new Error(error.message);
  const deals = ((data ?? []) as Array<{ id: number; conversation_id: string; first_contact_at: string | null; applied_at: string }>).filter((d) => !isTestConversation(d.conversation_id));
  const rows: Array<{ id: number; conv8: string; kind: CondGapKind; firstKinds: string[]; msgs: number }> = [];
  for (const d of deals) {
    let q = sb.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", d.conversation_id).lt("created_at", d.applied_at).order("created_at").limit(400);
    if (d.first_contact_at) q = q.gte("created_at", new Date(Date.parse(d.first_contact_at) - 60e3).toISOString());
    const { data: m, error: e } = await q;
    if (e) throw new Error(e.message);
    const msgs: FlowMsg[] = ((m ?? []) as Array<{ sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null }>).map((x) => ({ sender: x.sender, text: x.text, at: x.created_at, aix: x.is_aix_generated }));
    const g = conditionGapOf(msgs);
    rows.push({ id: d.id, conv8: d.conversation_id.slice(0, 8), kind: g.kind, firstKinds: g.firstKinds, msgs: msgs.length });
    await new Promise((r) => setTimeout(r, 150)); // 試験の係と DB が重ならないように少しずつ
  }
  const by = new Map<CondGapKind, number>();
  for (const r of rows) by.set(r.kind, (by.get(r.kind) ?? 0) + 1);
  console.log(`# 申込したのに条件の時刻が無い件の分け（${rows.length}件・試験の会話は除く・申込より前の通だけ）\n`);
  console.log("| 分け | 件 | 意味 |\n|---|---|---|");
  for (const [k, n] of [...by].sort((a, b) => b[1] - a[1])) console.log(`| ${k} | ${n} | ${JA[k]} |`);
  const kinds = new Map<string, number>();
  for (const r of rows.filter((x) => x.kind === "first_msg_conditions")) for (const k of r.firstKinds) kinds.set(k, (kinds.get(k) ?? 0) + 1);
  console.log(`\n初回の通の条件の種類: ${[...kinds].map(([k, n]) => `${k} ${n}`).join("・") || "—"}`);
  console.log(`通が0の件: ${rows.filter((r) => r.msgs === 0).length}`);
  console.log(`手打ちで聞いた件（頭8字）: ${rows.filter((r) => r.kind === "staff_hand_asked").map((r) => r.conv8).join(" ") || "—"}`);
  if (arg("out")) writeFileSync(arg("out"), JSON.stringify({ at: new Date().toISOString(), n: rows.length, by: Object.fromEntries(by), rows }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
