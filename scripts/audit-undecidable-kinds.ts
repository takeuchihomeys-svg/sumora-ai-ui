// scripts/audit-undecidable-kinds.ts — 判断できない番を a〜e に分けて数える（夜だけ・読むだけ・LLM なし・費用 0）
//
// 2026-11-03 竹内さん（KB P1「ブレインが判断できない所を細かく分けて対策する」）・統括役の頼み（10/29 以降の見張りの外れ・自信が低い番）。
//   分けは app/lib/undecidable-kind.ts（候補の網・1番に複数あり得る）。a の「記録に無い」は、内覧の記録（viewing_history の report）とお客様のメモの有無で見る。
//   読みは3回だけ（見張りの外れの一覧1回＋判断の記録の digest を id でまとめて1回＋内覧の記録を会話でまとめて1回）。営業時間（JST 9〜22時）は動かない（--force で手元の確かめだけ）。
// 実行: npx tsx --env-file=.env.local scripts/audit-undecidable-kinds.ts [--since=2026-10-29] [--list]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { undecidableKinds, UNDECIDABLE_JA, UNDECIDABLE_FIX, type UndecidableKind } from "../app/lib/undecidable-kind";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const jstHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hour12: false }).format(new Date()));
if (jstHour >= 9 && jstHour < 22 && !process.argv.includes("--force")) { console.log(`営業時間（JST ${jstHour}時）は回さない（22時以降に）`); process.exit(0); }

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const SINCE = arg("since", "2026-10-29");

type Turn = { id: number; conversation_id: string; customer_turn_at: string; verdict: string | null; draft_last: string | null; staff_texts: string[] | string | null; staff_aix: unknown; decision_id: string | null; customer_last_at: string | null; customer_text?: string | null };

(async () => {
  const { data: turns, error } = await sb.from("line_watch_turns")
    .select("id, conversation_id, customer_turn_at, customer_last_at, verdict, draft_last, staff_texts, staff_aix, decision_id")
    .gte("customer_turn_at", SINCE).in("verdict", ["different", "partial"]).limit(3000);
  if (error) throw new Error(error.message);
  const misses = ((turns ?? []) as Turn[]).filter((t) => !isTestConversation(t.conversation_id));
  // 自信が低い番（need が溜まってから）: digest.nd の2文字目が l
  const ids = [...new Set(misses.map((t) => t.decision_id).filter((x): x is string => !!x))];
  const nd = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from("brain_decision_logs").select("id, digest").in("id", ids.slice(i, i + 200));
    for (const d of data ?? []) { const v = (d.digest as { nd?: string } | null)?.nd; if (v) nd.set(d.id as string, v); }
  }
  const convs = [...new Set(misses.map((t) => t.conversation_id))];
  // お客様の今の番の文（customer_turn_at〜customer_last_at のお客様の発言）を会話でまとめて読む
  for (let i = 0; i < convs.length; i += 100) {
    const { data } = await sb.from("messages").select("conversation_id, text, created_at").in("conversation_id", convs.slice(i, i + 100)).eq("sender", "customer").gte("created_at", SINCE).limit(5000);
    for (const t of misses) {
      const from = Date.parse(t.customer_turn_at), to = Date.parse(t.customer_last_at ?? t.customer_turn_at) + 1000;
      const txt = (data ?? []).filter((m) => m.conversation_id === t.conversation_id && Date.parse(m.created_at as string) >= from - 1000 && Date.parse(m.created_at as string) <= to).map((m) => m.text ?? "").join("\n");
      if (txt) t.customer_text = txt;
    }
  }
  const hasReport = new Set<string>();
  for (let i = 0; i < convs.length; i += 200) {
    const { data } = await sb.from("viewing_history").select("conversation_id, viewing_report").in("conversation_id", convs.slice(i, i + 200)).not("viewing_report", "is", null);
    for (const r of data ?? []) hasReport.add(r.conversation_id as string);
  }
  const count: Record<UndecidableKind | "none", number> = { a: 0, b: 0, c: 0, d: 0, e: 0, none: 0 };
  const list: string[] = [];
  let lowConf = 0;
  for (const t of misses) {
    const staff = Array.isArray(t.staff_texts) ? t.staff_texts.join("\n") : (t.staff_texts ?? "");
    const aixInput = t.staff_aix ? JSON.stringify(t.staff_aix).slice(0, 300) : null;
    const k = undecidableKinds({ customerText: t.customer_text ?? "", staffText: staff, aixInput, draft: t.draft_last, hasRecordOfFact: hasReport.has(t.conversation_id) });
    if (t.decision_id && /^.l/.test(nd.get(t.decision_id) ?? "")) lowConf++;
    if (!k.length) count.none++;
    for (const x of k) count[x]++;
    if (process.argv.includes("--list")) list.push(`- ${t.id} ${t.customer_turn_at.slice(5, 16)} [${k.join(",") || "-"}] 客「${(t.customer_text ?? "").replace(/\s+/g, " ").slice(0, 30)}」`);
  }
  console.log(`# 判断できない番の種類（${SINCE} 以降の見張りの外れ ${misses.length}番・自信が低い番 ${lowConf}）`);
  console.log("| 種類 | 件数 | 対策の案 |\n|---|---|---|");
  for (const k of ["a", "b", "c", "d", "e"] as UndecidableKind[]) console.log(`| ${k} ${UNDECIDABLE_JA[k]} | ${count[k]} | ${UNDECIDABLE_FIX[k]} |`);
  console.log(`| 網に当たらない | ${count.none} | 安い時間に DeepSeek で読む |`);
  if (list.length) console.log("\n" + list.join("\n"));
})().catch((e) => { console.error(e); process.exitCode = 1; });
