// scripts/audit-brought-first-act.ts — お客様が物件を持ち込んだ番（ポータルの URL・物件の資料や画面の画像）で、竹内さん本人が最初に何をしたか（物件確認した が先か、ピックアップが先か）を数える（読むだけ・LLM なし・費用0）
//
// 2026-11-21 作業員K2（台帳 #190 の一番太い型・統括役の頼み）: 本番の最初の一手で「持ち込み・SNS の画面・条件の言い直し → ブレインは物件確認した・竹内さんはピックアップ」が 5番あった。
//   竹内さん本人の 60日の番で過半数を数える。番＝お客様の束（持ち込みを含む）の後の、こちらの塊（次のお客様の通まで）。書き手は塊の最初のこちらの通。
//   最初の一手: 塊の中の最初の AIX の種類（物件確認した／ピックアップ・オススメ／見積書／ほか）、AIX が無ければ返信（確認の約束・ピックアップの約束・ほか）。
//   文は出さない（数だけ）。
// 実行（22時以降）: npx tsx --env-file=.env.local scripts/audit-brought-first-act.ts [--days=60]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation, isNoLineTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
export const BROUGHT_RE = /https?:\/\/(?:[a-z0-9.-]*\.)?(?:suumo|homes|athome|chintai|canary-app|ieagent|smocca|realestate\.yahoo|door\.ac|minimini|apamanshop|eheya)|【物件の(?:資料|画面)/i;
const PICKUP_PROMISE_RE = /ピックアップ|お探しさせて|お調べさせて|新着で募集に出次第/;
const CHECK_PROMISE_RE = /募集状況|空き状況|確認させて頂き|確認出来次第|確認でき次第|確認させていただき/;
type M = { sender: string; text: string | null; created_at: string; staff_writer: string | null; is_aix_generated: boolean | null };
type U = { aix_type: string | null; sent_at: string | null; created_at: string };
export function firstActOf(aixTypes: ReadonlyArray<string>, ourTexts: ReadonlyArray<string>): string {
  const a = aixTypes[0];
  if (a === "property_check_result" || a === "acknowledge_check") return "AIX 物件確認した";
  if (a === "property_send" || a === "property_recommendation") return "AIX ピックアップ・オススメ";
  if (a === "estimate_sheet") return "AIX 見積書";
  if (a) return `AIX ${a}`;
  const t = ourTexts.join("\n");
  if (CHECK_PROMISE_RE.test(t) && PICKUP_PROMISE_RE.test(t)) return "返信（確認とピックアップの両方の約束）";
  if (CHECK_PROMISE_RE.test(t)) return "返信（確認の約束）";
  if (PICKUP_PROMISE_RE.test(t)) return "返信（ピックアップの約束）";
  return "返信（ほか）";
}
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const days = Number(arg("days", "60")) || 60;
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data: tk } = await sb.from("messages").select("conversation_id").eq("sender", "staff").eq("staff_writer", "takeuchi").gte("created_at", since).limit(30000);
  const convs = [...new Set(((tk ?? []) as Array<{ conversation_id: string }>).map((r) => r.conversation_id))].filter((c) => !isTestConversation(c) && !isNoLineTestConversation(c));
  const tally: Record<string, number> = {}; let n = 0;
  const second: Record<string, number> = {};
  for (const c of convs) {
    const [mq, uq] = await Promise.all([
      sb.from("messages").select("sender, text, created_at, staff_writer, is_aix_generated").eq("conversation_id", c).gte("created_at", since).order("created_at").limit(3000),
      sb.from("aix_usage_logs").select("aix_type, sent_at, created_at").eq("conversation_id", c).gte("created_at", since).not("sent_at", "is", null).limit(1000),
    ]);
    const ms = (mq.data ?? []) as M[], us = ((uq.data ?? []) as U[]).sort((a, b) => Date.parse(a.sent_at!) - Date.parse(b.sent_at!));
    for (let i = 0; i < ms.length; i++) {
      if (ms[i].sender !== "staff" || (i > 0 && ms[i - 1].sender === "staff")) continue;
      const cust: string[] = []; for (let j = i - 1; j >= 0 && ms[j].sender === "customer"; j--) cust.unshift(String(ms[j].text ?? ""));
      if (!cust.length || !BROUGHT_RE.test(cust.join("\n"))) continue;
      // 書き手は塊の最初の手打ちの通（AIX の通は書き手が付かない時がある）
      let k = i; const ours: string[] = []; let writer: string | null = null;
      while (k < ms.length && ms[k].sender !== "customer") { if (!ms[k].is_aix_generated) { ours.push(String(ms[k].text ?? "")); writer ??= ms[k].staff_writer; } k++; }
      const from = Date.parse(ms[i].created_at) - 5000, to = k < ms.length ? Date.parse(ms[k].created_at) : Infinity;
      const aix = us.filter((u) => { const t = Date.parse(u.sent_at!); return t >= from && t < to; }).map((u) => String(u.aix_type));
      if (writer !== "takeuchi") continue;
      n++;
      const act = firstActOf(aix, ours);
      tally[act] = (tally[act] ?? 0) + 1;
      if (aix.length >= 2) { const pair = `${aix[0]}→${aix[1]}`; second[pair] = (second[pair] ?? 0) + 1; }
    }
  }
  console.log(`お客様の持ち込みの番の竹内さん本人の最初の一手（${days}日・${n}番）`);
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}（${Math.round((100 * v) / Math.max(1, n))}%）`);
  console.log("  同じ塊の AIX の順（2つ以上）:", Object.entries(second).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・") || "なし");
})().catch((e) => { console.error(e); process.exit(1); });
