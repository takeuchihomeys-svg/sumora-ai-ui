// scripts/audit-confirm-prior-promise.ts — CONFIRM_NO_OBJECT（創作約束）の block のうち、FC_CONFIRM_PRIOR_PROMISE=on で info に下がる番を全部出す（読むだけ・LLM なし）
//
// 2026-11-13 作業員9（統括役・最終チェックの直し 2・8f67f33b）。下がる番の「前の約束・お客様の発言・下書き・送った文」を並べて目で読む（件数だけ見ない）。
//   誤った許し（本当に創作の約束なのに下げた）が 0 でなければ既定 on にしない。
// 実行（営業時間 9〜22時は避ける）: npx tsx --env-file=.env.local scripts/audit-confirm-prior-promise.ts [--days=90]
import { createClient } from "@supabase/supabase-js";
import { priorStaffConfirmObject, isAckOnlyCustomer } from "../app/lib/confirm-prior-promise";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "90"));
const SINCE = new Date(Date.now() - DAYS * 864e5).toISOString();
const TEST_IDS = new Set(["dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7"]);
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const one = (s: unknown, n = 140) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);

async function main() {
  const rows: Row[] = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("id, created_at, conversation_id, customer_message, ai_draft, sent_reply, reply_context_snapshot->preRevisionCodes")
      .gte("created_at", SINCE).order("created_at").range(p * 500, p * 500 + 499);
    if (error) { console.log(`⚠ ${error.message}`); break; }
    for (const r of (data ?? []) as Row[]) {
      if (TEST_IDS.has(r.conversation_id)) continue;
      const codes: string[] = Array.isArray(r.preRevisionCodes) ? r.preRevisionCodes : [];
      if (codes.some((c) => String(c) === "CONFIRM_NO_OBJECT:block")) rows.push(r);
    }
    if ((data ?? []).length < 500) break;
  }
  let flip = 0, ack = 0;
  console.log(`期間 ${DAYS}日・CONFIRM_NO_OBJECT の block ${rows.length}番`);
  for (const r of rows) {
    const { data: ms } = await sb.from("messages").select("sender, text, is_aix_generated, created_at")
      .eq("conversation_id", r.conversation_id).lt("created_at", r.created_at).order("created_at", { ascending: false }).limit(12);
    const recent = ((ms ?? []) as Row[]).reverse().map((m) => ({ sender: m.sender === "customer" ? "customer" : "staff", text: m.text, isAix: !!m.is_aix_generated }));
    // 送った例は送信の後に記録される＝末尾のこちらの通（この番の送信そのもの）を外して、生成の時の並びに戻す
    while (recent.length && recent[recent.length - 1].sender !== "customer") recent.pop();
    const cust = String(r.customer_message ?? "");
    const prior = priorStaffConfirmObject(recent, cust);
    if (isAckOnlyCustomer(cust)) ack++;
    console.log(`${prior ? "▼下がる" : "  残る "} ${String(r.id).slice(0, 8)} ${String(r.created_at).slice(0, 10)}${prior ? ` 前の約束「${one(prior, 40)}」` : ""}`);
    console.log(`   客: ${one(cust)}`);
    console.log(`   下: ${one(r.ai_draft)}`);
    console.log(`   送: ${one(r.sent_reply)}`);
    if (prior) flip++;
  }
  console.log(`\n下がる ${flip}番／block ${rows.length}番（お礼・了承だけの発言 ${ack}番）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
