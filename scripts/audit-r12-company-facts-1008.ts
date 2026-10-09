// scripts/audit-r12-company-facts-1008.ts — 10/08 竹内さんの答えで足した会社の事実（申込の時期・オーナー審査以降のキャンセル料・SUUMO・虫・業者の名前・緊急連絡先）を
//   実データに当てて目で読む（読むだけ・LLM なし）
//   ① お客様の発言（365日）に ask が当たった通を全部出す（誤当たりを読む）
//   ② 出口: スタッフの送信（全期間）に「聞かれていない業者の名前」「緊急連絡先に支払い義務」が当たる通（誤削除0か）
// 実行: npx tsx --env-file=.env.local scripts/audit-r12-company-facts-1008.ts [--show]
import { createClient } from "@supabase/supabase-js";
import { COMPANY_FACTS } from "../app/lib/company-facts";
import { findUnaskedVendorName, findCompanyFactContradictionsUngated } from "../app/lib/company-fact-guard";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
async function readAll(q: (f: number, t: number) => any) { const out: any[] = []; for (let i = 0; ; i += 1000) { const r = await q(i, i + 999); if (r.error) throw r.error; out.push(...(r.data ?? [])); if ((r.data ?? []).length < 1000) break; } return out; }
const SHOW = process.argv.includes("--show");
const IDS = ["apply_window", "cancel", "suumo_listing", "bugs_high_floor", "vendor_name", "emergency_contact"];
(async () => {
  const since = new Date(Date.now() - 365 * 86400_000).toISOString();
  const cust = await readAll((f, t) => sb.from("messages").select("conversation_id, created_at, text").eq("sender", "customer").gte("created_at", since).order("created_at").range(f, t));
  console.log(`お客様の発言 ${cust.length}通（365日）`);
  for (const id of IDS) {
    const f = COMPANY_FACTS.find((x) => x.id === id)!;
    const hit = cust.filter((m) => { const t = String(m.text ?? ""); if (/^\s*\[(?:画像|動画|スタンプ|ファイル)\]/.test(t)) return false; const a = typeof f.ask === "function" ? f.ask(t) : f.ask.test(t); return a && !(f.not && f.not.test(t)); });
    console.log(`\n■ ${id}: ${hit.length}通`);
    if (SHOW || id !== "cancel") for (const m of hit.slice(-40)) console.log(`  ${m.created_at.slice(0, 10)} ${String(m.text).replace(/\n/g, "／").slice(0, 110)}`);
  }
  // ② 出口
  const staff = await readAll((f, t) => sb.from("messages").select("conversation_id, created_at, text, is_aix_generated, staff_writer").eq("sender", "staff").order("created_at").range(f, t));
  const byConv = new Map<string, any[]>();
  for (const m of cust) { const a = byConv.get(m.conversation_id) ?? []; a.push(m); byConv.set(m.conversation_id, a); }
  let vendor = 0, emerg = 0;
  for (const s of staff) {
    if (s.is_aix_generated) continue;
    const prev = (byConv.get(s.conversation_id) ?? []).filter((c) => c.created_at < s.created_at).slice(-4).map((c) => c.text);
    const v = findUnaskedVendorName(s.text, prev);
    if (v) { vendor++; console.log(`  [業者名・聞かれていない] ${s.created_at.slice(0, 10)} ${v.sentence.slice(0, 80)} ／ 直前: ${prev.slice(-1)[0]?.replace(/\n/g, "／").slice(0, 60) ?? "-"}`); }
    const e = findCompanyFactContradictionsUngated(s.text).filter((h) => h.factId === "emergency_contact" && /支払|義務|責任/.test(h.sentence));
    if (e.length) { emerg++; console.log(`  [緊急連絡先に支払い義務] ${s.created_at.slice(0, 10)} ${e[0].sentence.slice(0, 80)}`); }
  }
  console.log(`\n出口（手打ちの送信 ${staff.filter((s) => !s.is_aix_generated).length}通）: 聞かれていない業者の名前 ${vendor}通・緊急連絡先に支払い義務 ${emerg}通`);
})();
