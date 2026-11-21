// scripts/audit-aix-ack-and-fresh.ts — AIX の土台の2つの物差し（読むだけ・LLM なし・費用0）
//
// 2026-11-22 作業員K2（台帳 #536「AIX【確認します】は候補から外す」の物差し・#540「AIX の文はブレインに連動（届き方）」の物差し）。
//   ① 確認します: ブレインが acknowledge_check を勧めた判断の数と出どころ（decision_source）。決まり（e506807a）どおりなら、代表確認の決まり（rule:further_discount_daihyo）だけ。
//      それ以外の出どころで勧めた数＝外れ（ack_check_other）。
//   ② 届き方: スタッフが押した AIX のうち、押した時にブレインの判断が最後のお客様の発言を見た物（analyzed_msg_ts が最後のお客様の発言より後・5秒の幅）の割合＝
//      AIX の文にブレインの本質（aix-brain-contract.buildAixContractNote）が届ける前提が満たされた割合（fresh）。種類ごと・書き手ごと。
//   --json= で { days, ack: { total, daihyo, other }, fresh: { <系統>: { n, fresh } } } を書く（毎日の数の元）。
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-ack-and-fresh.ts [--days=7] [--json=<道>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { aixFamilyOf } from "../app/lib/aix-family";
import { isTestConversation, isNoLineTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const days = Number(arg("days", "7")) || 7;
  const since = new Date(Date.now() - days * 864e5).toISOString();
  // ① 確認します
  const { data: ack } = await sb.from("brain_decision_logs").select("conversation_id, decision_source").eq("suggested_action", "acknowledge_check").gte("created_at", since).limit(2000);
  const ackRows = ((ack ?? []) as Array<{ conversation_id: string; decision_source: string | null }>).filter((r) => !isTestConversation(r.conversation_id) && !isNoLineTestConversation(r.conversation_id));
  const daihyo = ackRows.filter((r) => /further_discount_daihyo/.test(String(r.decision_source ?? ""))).length;
  // ② 届き方
  const { data: us } = await sb.from("aix_usage_logs").select("conversation_id, aix_type, sent_at").gte("sent_at", since).not("aix_type", "is", null).limit(3000);
  const presses = ((us ?? []) as Array<{ conversation_id: string; aix_type: string; sent_at: string }>).filter((u) => !isTestConversation(u.conversation_id) && !isNoLineTestConversation(u.conversation_id));
  const fresh: Record<string, { n: number; fresh: number }> = {};
  const byConv = new Map<string, typeof presses>(); for (const p of presses) byConv.set(p.conversation_id, [...(byConv.get(p.conversation_id) ?? []), p]);
  for (const [c, list] of byConv) {
    const from = new Date(Date.parse(list.map((p) => p.sent_at).sort()[0]) - 2 * 864e5).toISOString();
    const [mq, bq] = await Promise.all([
      sb.from("messages").select("created_at").eq("conversation_id", c).eq("sender", "customer").gte("created_at", from).order("created_at").limit(2000),
      sb.from("brain_decision_logs").select("created_at, analyzed_msg_ts").eq("conversation_id", c).gte("created_at", from).order("created_at").limit(2000),
    ]);
    const cust = ((mq.data ?? []) as Array<{ created_at: string }>).map((m) => Date.parse(m.created_at));
    const decs = (bq.data ?? []) as Array<{ created_at: string; analyzed_msg_ts: string | null }>;
    for (const p of list) {
      const at = Date.parse(p.sent_at);
      const lastCust = [...cust].reverse().find((t) => t < at) ?? null;
      const d = [...decs].reverse().find((x) => Date.parse(x.created_at) <= at);
      const ok = !!d?.analyzed_msg_ts && (lastCust == null || Date.parse(d.analyzed_msg_ts) >= lastCust - 5000);
      const fam = aixFamilyOf(p.aix_type);
      const c2 = (fresh[fam] ??= { n: 0, fresh: 0 }); c2.n++; if (ok) c2.fresh++;
    }
  }
  console.log(`① AIX【確認します】をブレインが勧めた（${days}日）: ${ackRows.length}・代表確認の決まり ${daihyo}・それ以外（外れ） ${ackRows.length - daihyo}`);
  console.log(`② 押した時にブレインの判断が最後のお客様の発言を見ていた割合（${days}日）:`);
  for (const [k, v] of Object.entries(fresh).sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k.padEnd(18)} ${v.fresh}/${v.n}（${v.n ? Math.round((100 * v.fresh) / v.n) : 0}%）`);
  if (arg("json", "")) writeFileSync(arg("json", ""), JSON.stringify({ days, ack: { total: ackRows.length, daihyo, other: ackRows.length - daihyo }, fresh }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
