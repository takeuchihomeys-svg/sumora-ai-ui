// scripts/audit-apply-intent-wording.ts — お客様が申込を決めた番に、スタッフが最初に何を送ったか（読むだけ・LLM なし）
// 2026-10-02 竹内「こんなかんじじゃない。実際の言い回しを確認する。AIっぽい文となっている」（AIX【申込へ！】の文）:
//   app/lib/apply-sub-mode.ts の isApplyDecision が当たる番と当たらない番を出し、スタッフの最初の1通の形（2行の確定・誘導・フォーマット・他）を数える。
// 実行: npx tsx --env-file=.env.local scripts/audit-apply-intent-wording.ts [--days=365] [--show]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { isApplyDecision, decideApplySubMode } from "../app/lib/apply-sub-mode";

const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "365");
const SHOW = process.argv.includes("--show");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
/** 申込の語がある番（広く拾う・判定の外れも見るため） */
const WIDE_RE = /申し?込|お申込|決め(?:ます|ました)|審査(?:を)?(?:一旦|一度)?(?:通して|進めて|お願い)/;
type Msg = { conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null };

function kindOf(t: string): string {
  const s = t.trim();
  if (/記入欄】|フリガナ/.test(s)) return "フォーマット";
  if (/^かしこまりました/.test(s) && /申し?込/.test(s)) return "確定の2行（かしこまりました＋申込）";
  if (/お気に召され/.test(s)) return "誘導";
  if (/^かしこまりました/.test(s)) return "かしこまりました＋他（確認等）";
  return "他";
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const msgs: Msg[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(i, i + 999);
    if (error) throw new Error(error.message);
    msgs.push(...((data ?? []) as Msg[]));
    if (!data || data.length < 1000) break;
  }
  const by = new Map<string, Msg[]>();
  for (const m of msgs) { if (isTestConversation(m.conversation_id)) continue; if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push(m); }
  const tally: Record<string, Record<string, number>> = { "確定と判定": {}, "確定でない": {} };
  for (const [cid, ms] of by) {
    for (let i = 0; i < ms.length; i++) {
      if (ms[i].sender !== "customer" || (i > 0 && ms[i - 1].sender === "customer")) continue;
      const turn: string[] = []; let j = i;
      for (; j < ms.length && ms[j].sender === "customer"; j++) turn.push(ms[j].text ?? "");
      const t = turn.join("\n");
      if (!WIDE_RE.test(t) || /【お申込者様記入欄】|フリガナ/.test(t)) continue;
      const t0 = Date.parse(ms[i].created_at);
      const staff: Msg[] = [];
      for (let k = j; k < ms.length && ms[k].sender === "staff" && Date.parse(ms[k].created_at) - t0 < 6 * 3600e3; k++) staff.push(ms[k]);
      if (!staff.length) continue;
      const decided = isApplyDecision(t);
      const k1 = kindOf(staff[0].text ?? "");
      const g = tally[decided ? "確定と判定" : "確定でない"];
      g[k1] = (g[k1] ?? 0) + 1;
      if (SHOW && (decided || k1.startsWith("確定"))) {
        const staffTexts = ms.slice(Math.max(0, i - 8), i).filter((m) => m.sender === "staff").map((m) => m.text ?? "");
        console.log(`\n--- ${cid.slice(0, 8)} ${ms[i].created_at.slice(0, 16)} 判定=${decided ? "確定" : "－"}（形 ${decideApplySubMode({ customerText: t, recentStaffTexts: staffTexts }).mode}）／スタッフ=${k1}\nC: ${t.replace(/\n/g, " / ").slice(0, 150)}\nS: ${staff.map((s) => (s.is_aix_generated ? "[AIX]" : "") + String(s.text ?? "").replace(/\n/g, "⏎")).join(" || ").slice(0, 220)}`);
      }
    }
  }
  console.log(`\n=== ${DAYS}日・お客様の申込の語がある番（申込書の記入そのものは除く）`);
  for (const [k, g] of Object.entries(tally)) console.log(`  ${k}: ${Object.entries(g).map(([a, n]) => `${a} ${n}`).join("・") || "0"}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
