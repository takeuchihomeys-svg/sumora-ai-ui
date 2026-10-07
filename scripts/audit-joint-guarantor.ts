// 連帯保証人の会社の事実（company-facts joint_guarantor）と出口（company-fact-guard）の監査（読み取りのみ・LLM 0）
// 2026-10-07 5巡目（d46290ff 10/01 の誤答「連帯保証人様へのご連絡はございません・本人確認書類のみ」）
//   A. お客様の発言（365日）で joint_guarantor の入口が当たる通を全部表示（当たりすぎ・漏れを目で読む）
//   B. スタッフの実送信（365日）に出口の2本をゲート無しで当てる（0 でなければ入れない）
//   C. AI の下書き（line_watch_turns.draft_first/last）で出口が当たる物（変換の前後を読む）
// 実行: npx tsx --env-file=.env.local scripts/audit-joint-guarantor.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { matchCompanyFacts } from "../app/lib/company-facts";
import { findCompanyFactContradictionsUngated } from "../app/lib/company-fact-guard";
import { TEST_CONVERSATION_IDS } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 365);
const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
const mask = (t: string) => t.replace(/([^\s、。！!？?「」（）()0-9０-９]{1,8})(さん|様)(?=[\n、。！!])/g, "〇〇$2");
const one = (t: string, n = 150) => mask(t.replace(/\n/g, "␤").slice(0, n));
const testSet = new Set(TEST_CONVERSATION_IDS);

async function pageAll(sender: string, like: string) {
  const out: { conversation_id: string; text: string; created_at: string }[] = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from("messages").select("conversation_id, text, created_at").eq("sender", sender)
      .gte("created_at", since).ilike("text", like).order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as typeof out));
    if ((data ?? []).length < 1000) break;
  }
  return out.filter((m) => !testSet.has(m.conversation_id));
}

async function main() {
  const cust = await pageAll("customer", "%保証人%");
  const hit = cust.filter((m) => matchCompanyFacts(m.text).some((f) => f.id === "joint_guarantor"));
  console.log(`A. お客様の「保証人」を含む発言 ${cust.length} 通 → 入口が当たる ${hit.length} 通`);
  for (const m of hit) console.log(`  ○ ${m.created_at.slice(0, 10)} ${m.conversation_id.slice(0, 8)} ${one(m.text)}`);
  console.log(`  （当たらない物）`);
  for (const m of cust.filter((x) => !hit.includes(x)).slice(-60)) console.log(`  × ${m.created_at.slice(0, 10)} ${m.conversation_id.slice(0, 8)} ${one(m.text, 90)}`);

  const staff = await pageAll("staff", "%保証人%");
  const bad = staff.flatMap((m) => findCompanyFactContradictionsUngated(m.text).filter((h) => h.factId === "joint_guarantor").map((h) => ({ m, h })));
  console.log(`\nB. スタッフの「保証人」を含む送信 ${staff.length} 通 → 出口の当たり ${bad.length}（0 でなければ入れない）`);
  for (const { m, h } of bad) console.log(`  ✗ ${m.created_at.slice(0, 10)} ${m.conversation_id.slice(0, 8)} 「${one(h.sentence)}」`);

  const { data: turns } = await sb.from("line_watch_turns").select("conversation_id, customer_turn_at, draft_first, draft_last")
    .gte("customer_turn_at", since).or("draft_first.ilike.%保証人%,draft_last.ilike.%保証人%").limit(2000);
  const drafts = (turns ?? []).filter((t) => !testSet.has(t.conversation_id as string));
  let n = 0;
  console.log(`\nC. 見張りの下書き（保証人を含む ${drafts.length} 番）`);
  for (const t of drafts) {
    for (const k of ["draft_first", "draft_last"] as const) {
      const hs = findCompanyFactContradictionsUngated(String(t[k] ?? "")).filter((h) => h.factId === "joint_guarantor");
      if (!hs.length) continue;
      n++;
      console.log(`  ▶ ${String(t.customer_turn_at).slice(0, 16)} ${String(t.conversation_id).slice(0, 8)} ${k}: ${hs.map((h) => `「${one(h.sentence, 80)}」`).join(" ")}`);
    }
  }
  console.log(`  当たり ${n}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
