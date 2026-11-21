// scripts/audit-aix-first-move.ts — スタッフが AIX を押した「最初の一手」の番で、ブレインが返信・別の AIX と言った番を1番ずつ並べる（読むだけ・LLM なし・費用0）
//
// 2026-11-21 作業員K2（台帳 #469・統括役の頼み 3）: 竹内さんが物件の AIX を押した最初の一手 63番のうち、ブレインが返信 21番・別の AIX 12番。
//   物件確認した の返信 12番も。1番ずつ読んで、原因の3つ（材料が届いていない／場面の読み違い／AIX の番を返信にしている）に分けるための並び。
//   「最初の一手」= 押した AIX の直前の判断（24時間以内）の後に、お客様の新しい発言もスタッフの手打ちも無い番。
//   出す物: 会話の頭6字・時刻・押した AIX・ブレインの一手と道・出どころ・段・判断の後から押すまでの分・こちらの直前の送信の頭40字（--show-staff の時だけ）・
//     お客様の今の束の型（customer-reaction-predict.classifyCustomerBurst）。お客様の文は出さない（--show-customer は手元で読む時だけ・報告に写さない）。
// 重い読み: 30日の aix_usage_logs と会話ごとの読み。営業時間（JST 9〜22時）は --days=3 に絞る。
// 実行（22時以降）: npx tsx --env-file=.env.local scripts/audit-aix-first-move.ts [--days=30] [--fam=property|property_check_result|all] [--writer=takeuchi|all] [--show-staff] [--show-customer] [--json=<出力>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { classifyCustomerBurst } from "../app/lib/customer-reaction-predict";
import { NO_LINE_TEST_CONVERSATION_IDS, STAFF_INTERNAL_CONVERSATION_IDS, YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const has = (k: string) => process.argv.includes(`--${k}`);
const famOf = (t: string | null | undefined) => (t === "property_send" || t === "property_recommendation" ? "property" : String(t ?? ""));
type U = { conversation_id: string; aix_type: string | null; check_pattern: string | null; sent_at: string | null; created_at: string; line_message_id: string | null };
type B = { created_at: string; suggested_action: string | null; suggested_reply_mode: string | null; suggested_check_pattern: string | null; decision_source: string | null; digest: { sg?: string | null } | null };
type M = { sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null; line_message_id: string | null };

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  let days = Number(arg("days", "30")) || 30;
  const h = (new Date().getUTCHours() + 9) % 24;
  if (h >= 9 && h < 22 && !has("force")) { days = Math.min(days, 3); console.log(`営業時間なので --days=${days} に絞った（全部は22時以降）`); }
  const fam = arg("fam", "all"), writer = arg("writer", "takeuchi");
  const skip = new Set<string>([YUMA_CONVERSATION_ID, ...NO_LINE_TEST_CONVERSATION_IDS, ...STAFF_INTERNAL_CONVERSATION_IDS]);
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data: us, error } = await sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, sent_at, created_at, line_message_id")
    .gte("sent_at", since).not("aix_type", "is", null).order("sent_at").limit(5000);
  if (error) throw new Error(error.message);
  const presses = ((us ?? []) as U[]).filter((u) => !skip.has(u.conversation_id) && (fam === "all" || famOf(u.aix_type) === fam));
  const byConv = new Map<string, U[]>(); for (const u of presses) byConv.set(u.conversation_id, [...(byConv.get(u.conversation_id) ?? []), u]);
  const rows: Array<Record<string, unknown>> = [];
  let skippedOwnTurn = 0;
  for (const [c, list] of byConv) {
    const from = new Date(Date.parse(list[0].sent_at ?? list[0].created_at) - 864e5).toISOString();
    const [mq, bq] = await Promise.all([
      sb.from("messages").select("sender, text, created_at, is_aix_generated, staff_writer, line_message_id").eq("conversation_id", c).gte("created_at", from).order("created_at").limit(3000),
      sb.from("brain_decision_logs").select("created_at, suggested_action, suggested_reply_mode, suggested_check_pattern, decision_source, digest").eq("conversation_id", c).gte("created_at", from).order("created_at").limit(2000),
    ]);
    const ms = (mq.data ?? []) as M[], bs = (bq.data ?? []) as B[];
    for (const u of list) {
      const at = Date.parse(u.sent_at ?? u.created_at);
      const w = ms.find((m) => m.line_message_id && m.line_message_id === u.line_message_id)?.staff_writer ?? null;
      if (writer !== "all" && w !== writer) continue;
      const b = [...bs].reverse().find((x) => Date.parse(x.created_at) <= at && at - Date.parse(x.created_at) <= 864e5);
      if (!b) continue;
      const bt = Date.parse(b.created_at);
      const between = ms.filter((m) => Date.parse(m.created_at) > bt && Date.parse(m.created_at) < at - 5000);
      if (between.some((m) => m.sender === "customer" || (m.sender === "staff" && !m.is_aix_generated))) continue; // 最初の一手だけ
      const same = b.suggested_reply_mode === "aix" && famOf(b.suggested_action) === famOf(u.aix_type);
      const kind = same ? "同じ" : b.suggested_reply_mode === "aix" ? "別の AIX" : "返信";
      const before = ms.filter((m) => Date.parse(m.created_at) <= bt);
      let i = before.length - 1; const burst: string[] = [];
      while (i >= 0 && before[i].sender === "customer") { burst.unshift(String(before[i].text ?? "")); i--; }
      // 2026-11-21 夜: 判断がこちらの通の後に作られた番（お客様の束が無い＝自分の約束の後の判断）は最初の一手に数えない（30日で 14番がこの形だった）
      if (!burst.length) { skippedOwnTurn++; continue; }
      const lastStaff = [...before].reverse().find((m) => m.sender === "staff");
      rows.push({
        conv: c.slice(0, 6), at: new Date(at).toISOString().slice(0, 16), pressed: u.aix_type, cp: u.check_pattern, kind,
        brain: b.suggested_action, mode: b.suggested_reply_mode, bcp: b.suggested_check_pattern, src: b.decision_source, sg: b.digest?.sg ?? null,
        min: Math.round((at - bt) / 6e4), burst: burst.length ? classifyCustomerBurst(burst) : "（お客様の束なし）", lastStaffAix: lastStaff?.is_aix_generated ?? null,
        ...(has("show-staff") ? { staff: String(lastStaff?.text ?? "").replace(/\s+/g, " ").slice(0, 40) } : {}),
        ...(has("show-customer") ? { customer: burst.join(" / ").replace(/\s+/g, " ").slice(0, 80) } : {}),
      });
    }
  }
  const tally = new Map<string, number>(); for (const r of rows) { const k = `${famOf(String(r.pressed))}|${r.kind}`; tally.set(k, (tally.get(k) ?? 0) + 1); }
  console.log(`AIX の最初の一手（${days}日・書き手 ${writer}・系統 ${fam}）: ${rows.length}番（こちらの通の後の判断で外した ${skippedOwnTurn}）`);
  for (const [k, n] of [...tally].sort()) console.log(`  ${k}: ${n}`);
  for (const r of rows.filter((x) => x.kind !== "同じ")) console.log(JSON.stringify(r));
  if (arg("json", "")) writeFileSync(arg("json", ""), JSON.stringify(rows, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
