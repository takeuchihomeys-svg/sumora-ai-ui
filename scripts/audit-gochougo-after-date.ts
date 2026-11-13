// scripts/audit-gochougo-after-date.ts — GOCHOUGO_AFTER_DATE（お客様が日を言った後の「ご都合よろしい…」）が実送信を止める数を、FC_GOCHOUGO_DATE_ALIGN の off／on で比べる（読むだけ・LLM なし）
//
// 2026-11-13 作業員9（弱い所 685・統括役）。送った例（ai_reply_examples）の送った文に、最終チェックの V4（runVocabSemanticChecks）を当てる。
//   off で止まり on で止まらない送信（竹内さんの「10/24(土) 14:00〜16:00 ご案内可能です…ご都合よろしいお時間御座いますでしょうか」の形）と、
//   on でも止まる送信を、お客様の発言と並べて全部出す（目で読む・件数だけ見ない）。on で新しく素通りする下書きも出す。
// 実行（営業時間 9〜22時は避ける）: npx tsx --env-file=.env.local scripts/audit-gochougo-after-date.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { runVocabSemanticChecks, type FinalCheckContext } from "../app/lib/final-check";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "365"));
const SINCE = new Date(Date.now() - DAYS * 864e5).toISOString();
const TEST_IDS = new Set(["dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7"]);
const GOCHOUGO_RE = /ご都合(?:の)?(?:よろしい|宜しい|良い|よい)(?:お)?(?:日にち|日|お?時間|タイミング)/;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const one = (s: unknown, n = 160) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);

const jstHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hour12: false }).format(new Date())) % 24;
if (jstHour >= 9 && jstHour < 22 && !process.argv.includes("--force")) { console.log(`営業時間（JST ${jstHour}時）は流さない（--force で外す）`); process.exit(0); }

const fires = (text: string, cust: string, on: boolean): boolean => {
  process.env.FC_GOCHOUGO_DATE_ALIGN = on ? "on" : "off"; // 2026-11-13 既定 on になったので off は明示する
  const ctx = { lastCustomerMessage: cust, recentMessages: [{ sender: "customer", text: cust }] } as unknown as FinalCheckContext;
  return runVocabSemanticChecks(text, ctx).some((i) => i.code === "GOCHOUGO_AFTER_DATE");
};

async function main() {
  const rows: Row[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from("ai_reply_examples").select("id, created_at, conversation_id, customer_message, ai_draft, sent_reply")
      .gte("created_at", SINCE).order("created_at").range(p * 500, p * 500 + 499);
    if (error) { console.log(`⚠ ${error.message}`); break; }
    for (const r of (data ?? []) as Row[]) if (!TEST_IDS.has(r.conversation_id)) rows.push(r);
    if ((data ?? []).length < 500) break;
  }
  const sentOffOn: Row[] = [], sentBoth: Row[] = [], draftNewPass: Row[] = [];
  let sentFiresOff = 0;
  for (const r of rows) {
    const cust = String(r.customer_message ?? "");
    const sent = String(r.sent_reply ?? "");
    if (sent && GOCHOUGO_RE.test(sent)) {
      const off = fires(sent, cust, false), on = fires(sent, cust, true);
      if (off) sentFiresOff++;
      if (off && !on) sentOffOn.push(r); else if (off && on) sentBoth.push(r);
    }
    const draft = String(r.ai_draft ?? "");
    if (draft && GOCHOUGO_RE.test(draft) && fires(draft, cust, false) && !fires(draft, cust, true)) draftNewPass.push(r);
  }
  delete process.env.FC_GOCHOUGO_DATE_ALIGN;
  console.log(`期間 ${DAYS}日・送った例 ${rows.length}件・実送信で GOCHOUGO_AFTER_DATE が当たる ${sentFiresOff}通（off）`);
  console.log(`\n■ on で止まらなくなる実送信 ${sentOffOn.length}通（誤った止めが減る分）`);
  for (const r of sentOffOn) console.log(`  ${String(r.id).slice(0, 8)} ${String(r.created_at).slice(0, 10)}\n    客: ${one(r.customer_message)}\n    送: ${one(r.sent_reply, 220)}`);
  console.log(`\n■ on でも止まる実送信 ${sentBoth.length}通（目で読む: 竹内さんが正しく送った物なら誤った止めが残る）`);
  for (const r of sentBoth) console.log(`  ${String(r.id).slice(0, 8)} ${String(r.created_at).slice(0, 10)}\n    客: ${one(r.customer_message)}\n    送: ${one(r.sent_reply, 220)}`);
  console.log(`\n■ on で新しく素通りする下書き ${draftNewPass.length}件（目で読む: 送った文と比べて、止めるべきだった物が無いか）`);
  for (const r of draftNewPass) console.log(`  ${String(r.id).slice(0, 8)} ${String(r.created_at).slice(0, 10)}\n    客: ${one(r.customer_message)}\n    下: ${one(r.ai_draft, 220)}\n    送: ${one(r.sent_reply, 160)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
