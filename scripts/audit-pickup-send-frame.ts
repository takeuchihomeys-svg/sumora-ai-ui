// scripts/audit-pickup-send-frame.ts
// AIX【物件ピックアップした】の送り方「新着」の枠を、時系列（前回の送付の後に依頼・条件の変化・ピックアップの約束があったか）で直すと、
// スタッフが実際に送った文の枠（新着と書いたか）とどれだけ合うかを数える（読むだけ・LLM なし・費用0）。
// 2026-10-06 ⑰（あかりさんの事例・app/lib/property-send-now.ts）
// 実行: npx tsx --env-file=.env.local scripts/audit-pickup-send-frame.ts [--days=90] [--show=10]
import { createClient } from "@supabase/supabase-js";
import { readSendNow, effectiveSendFrame } from "../app/lib/property-send-now";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "90"), 10);
const SHOW = parseInt(String(args.show ?? "10"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = Record<string, any>;
const STAFF_NEW_RE = /新着|募集に(?:出|で)ました|新たに募集/;
const mask = (s: string) => s.replace(/[^\s、。！？\n]{1,8}さん/g, "〇〇さん").replace(/\n+/g, " / ").slice(0, 110);

(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const { data: logs, error } = await sb.from("aix_usage_logs").select("conversation_id, created_at, send_mode, conversation_match, generated_text")
    .eq("aix_type", "property_send").eq("send_mode", "new_arrival").gte("created_at", since).neq("conversation_id", YUMA_CONVERSATION_ID).order("created_at").limit(2000);
  if (error) throw new Error(error.message);
  let n = 0, staffNew = 0, curAgree = 0, newAgree = 0, req = 0;
  const flips: string[] = [], misses: string[] = [];
  for (const l of (logs ?? []) as Row[]) {
    const sent = String(l.generated_text ?? "");
    if (!sent.trim()) continue;
    const { data: hist } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", l.conversation_id)
      .lt("created_at", new Date(Date.parse(l.created_at) - 30_000).toISOString()).order("created_at", { ascending: false }).limit(40);
    const msgs = ((hist ?? []) as Row[]).reverse().map((m) => ({ sender: String(m.sender), text: m.text }));
    const now = readSendNow(msgs);
    const frame = effectiveSendFrame("new_arrival", now);
    const sNew = STAFF_NEW_RE.test(sent);
    n++; if (sNew) staffNew++;
    if (sNew === true) curAgree++;                       // 今: 送り方が新着なら必ず新着の言い方
    if (sNew === (frame === "new_arrival")) newAgree++;
    if (frame === "requested") req++;
    if (frame === "requested" && !sNew && flips.length < SHOW) flips.push(`○ 依頼に応えた送付（スタッフも新着と書かない）: ${mask(sent)} ｜ 場面: ${[...now.conditionChange, ...now.staffPromises].slice(0, 2).join(" / ")}`);
    if (frame === "requested" && sNew && misses.length < SHOW) misses.push(`× 依頼に応えたと見たがスタッフは新着: ${mask(sent)} ｜ 場面: ${[...now.conditionChange, ...now.staffPromises, ...now.customerLatest].slice(0, 2).join(" / ")}`);
  }
  console.log(`=== 送り方「新着」の物件ピックアップ（${DAYS}日・${n}通・スタッフが新着と書いた ${staffNew}）===`);
  console.log(`新着の言い方を使うかの一致: 今（いつも新着）${curAgree}/${n}（${Math.round(curAgree / n * 100)}%）→ 時系列で直す ${newAgree}/${n}（${Math.round(newAgree / n * 100)}%）・依頼に応えたと見た ${req}`);
  for (const s of flips) console.log(`  ${s}`);
  for (const s of misses) console.log(`  ${s}`);
})().catch((e) => { console.error(e); process.exit(1); });
