// scripts/audit-appeal-spacious.ts
// 竹内さんが「お部屋の中でも」で広さを推すのは、その物件が送った束の中で一番広い時か（読むだけ・LLM なし・費用0）。
// 統括役の (b)。束＝直前の🌟の回（recommendation_snapshots・同じ会話・送信の2時間前まで）の candidates の area_sqm。推した物件＝束の is_star。
// 線が見つからない時は「見つからない」と出す。
// 実行: npx tsx --env-file=.env.local scripts/audit-appeal-spacious.ts [--days=120]
import { createClient } from "@supabase/supabase-js";
import { appealRecordFromText } from "../app/lib/appeal-record";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "120"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
type Row = Record<string, any>;

(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const { data } = await sb.from("messages").select("conversation_id, created_at, text").eq("sender", "staff").eq("staff_writer", "takeuchi").gte("created_at", since).like("text", "%お部屋の中でも%").limit(500);
  const rows = ((data ?? []) as Row[]).filter((m) => m.conversation_id !== YUMA_CONVERSATION_ID);
  const tab = { push_largest: 0, push_not: 0, nopush_largest: 0, nopush_not: 0, unknown: 0 };
  for (const m of rows) {
    const t = Date.parse(m.created_at);
    const { data: snaps } = await sb.from("recommendation_snapshots").select("candidates, sent_at").eq("conversation_id", m.conversation_id)
      .lte("sent_at", m.created_at).gte("sent_at", new Date(t - 2 * 3600_000).toISOString()).order("sent_at", { ascending: false }).limit(1);
    const cands = ((snaps?.[0]?.candidates ?? []) as Row[]);
    const star = cands.find((c) => c.is_star);
    const areas = cands.map((c) => Number(c.area_sqm)).filter((x) => x > 0);
    if (!star || Number(star.area_sqm) <= 0 || areas.length < 2) { tab.unknown++; continue; }
    const largest = Number(star.area_sqm) >= Math.max(...areas);
    const pushed = appealRecordFromText(String(m.text), { surface: "reply", writer: "takeuchi" }).points.includes("spacious");
    if (pushed && largest) tab.push_largest++; else if (pushed) tab.push_not++; else if (largest) tab.nopush_largest++; else tab.nopush_not++;
  }
  const n = rows.length;
  console.log(`竹内さんの「お部屋の中でも」${n}通（${DAYS}日）・束の広さが読めない ${tab.unknown}通`);
  console.log(`  一番広い物件: 広さを推した ${tab.push_largest}・推さない ${tab.nopush_largest}`);
  console.log(`  一番広くない物件: 広さを推した ${tab.push_not}・推さない ${tab.nopush_not}`);
  const pL = tab.push_largest / Math.max(1, tab.push_largest + tab.nopush_largest), pN = tab.push_not / Math.max(1, tab.push_not + tab.nopush_not);
  console.log(`  広さを推す割合: 一番広い時 ${Math.round(pL * 100)}%・そうでない時 ${Math.round(pN * 100)}%`);
  console.log(tab.push_largest + tab.nopush_largest >= 5 && pL - pN >= 0.3 ? "線の候補: 束の中で一番広い時に広さを推す" : "線の候補: 見つからない（一番広いかどうかで推す割合が大きく変わらない、または数が少ない）");
})().catch((e) => { console.error(e); process.exit(1); });
