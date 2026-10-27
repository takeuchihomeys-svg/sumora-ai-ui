// scripts/audit-read-all-rows.ts — READ_ALL_ROWS（1回 1000行で切れていた読みを回して読む）の前後を本番の実データで比べる（読むだけ・書かない・LLM なし）
//   ① 🌟ターゲット（loadBrainTargets）: 人・段・お客様の最後の発言の時刻の違い
//   ② アツい印の取り下げ（syncBrainHotDrops・dryRun）: 取り下げる人の違い
//   ③ 直した読みの行数（off＝1回／on＝回して読む）
//   実行: npx tsx --env-file=.env.local scripts/audit-read-all-rows.ts
import { supabase } from "../app/lib/supabase-server";
import { loadBrainTargets, syncBrainHotDrops } from "../app/lib/brain-attention-server";
import { readRowsUpTo } from "../app/lib/read-all-rows";

const setFlag = (on: boolean) => { if (on) process.env.READ_ALL_ROWS = "on"; else delete process.env.READ_ALL_ROWS; };

(async () => {
  // ① ターゲット
  setFlag(false); const offT = await loadBrainTargets();
  setFlag(true); const onT = await loadBrainTargets();
  const key = (t: { conversationId: string; tier: string }) => `${t.conversationId.slice(0, 8)} ${t.tier}`;
  const offK = new Set(offT.map(key)), onK = new Set(onT.map(key));
  console.log(`== ① ターゲット off ${offT.length}人 / on ${onT.length}人`);
  for (const t of offT) if (!onK.has(key(t))) console.log(`  - off だけ: ${t.customerName} ${t.tier}（${t.reason}）`);
  for (const t of onT) if (!offK.has(key(t))) console.log(`  + on だけ: ${t.customerName} ${t.tier}（${t.reason}）`);
  const offBy = new Map(offT.map((t) => [t.conversationId, t]));
  let lastDiff = 0;
  for (const t of onT) { const o = offBy.get(t.conversationId); if (o && o.lastCustomerAt !== t.lastCustomerAt) { lastDiff++; if (lastDiff <= 10) console.log(`  ~ 最後の発言: ${t.customerName} ${o.lastCustomerAt} → ${t.lastCustomerAt}`); } }
  console.log(`  最後の発言の時刻が変わる人 ${lastDiff}`);

  // ② アツい印の取り下げ（dryRun・切替 HOT_DROP_BY_BRAIN を手元で on にして判定だけ）
  process.env.HOT_DROP_BY_BRAIN = "on";
  setFlag(false); const offH = await syncBrainHotDrops(supabase, { dryRun: true });
  setFlag(true); const onH = await syncBrainHotDrops(supabase, { dryRun: true });
  const hk = (h: Record<string, unknown>) => JSON.stringify([h.conversationId ?? h.conversation_id, h.reason ?? null]);
  const offHK = new Set(offH.map((h) => hk(h as unknown as Record<string, unknown>))), onHK = new Set(onH.map((h) => hk(h as unknown as Record<string, unknown>)));
  console.log(`\n== ② アツい印の取り下げ off ${offH.length}人 / on ${onH.length}人`);
  for (const h of offH) if (!onHK.has(hk(h as unknown as Record<string, unknown>))) console.log(`  - off だけ: ${JSON.stringify(h).slice(0, 200)}`);
  for (const h of onH) if (!offHK.has(hk(h as unknown as Record<string, unknown>))) console.log(`  + on だけ: ${JSON.stringify(h).slice(0, 200)}`);

  // ③ 行数
  const since30 = new Date(Date.now() - 30 * 86400e3).toISOString();
  const since90 = new Date(Date.now() - 90 * 86400e3).toISOString();
  const since84 = new Date(Date.now() - 84 * 86400e3).toISOString();
  const rows = async (name: string, mk: Parameters<typeof readRowsUpTo>[0], max: number) => {
    const off = await readRowsUpTo(mk, max, false), on = await readRowsUpTo(mk, max, true);
    console.log(`  ${name}: off ${off.data.length}行 / on ${on.data.length}行${on.truncated ? "（上限で止めた）" : ""}`);
  };
  console.log("\n== ③ 直した読みの行数");
  await rows("AIX ツールの一覧のまとめ ID（30日）", (a, b, p) => { const q = supabase.from("property_pickups").select("batch_id, complete_group_id").not("complete_group_id", "is", null).order("created_at", { ascending: false }).gte("created_at", since30); return (p ? q.order("id", { ascending: false }) : q).range(a, b); }, 3000);
  await rows("学習のログ（90日・要約あり）", (a, b, p) => { const q = supabase.from("action_pattern_logs").select("id").not("customer_msg_summary", "is", null).not("action_type", "like", "%_submode").gte("created_at", since90).order("created_at", { ascending: false }); return (p ? q.order("id", { ascending: false }) : q).range(a, b); }, 3000);
  await rows("学習のログ（90日・直前の AIX あり）", (a, b, p) => { const q = supabase.from("action_pattern_logs").select("id").not("previous_action_type", "is", null).not("action_type", "like", "%_submode").gte("created_at", since90).order("created_at", { ascending: false }); return (p ? q.order("id", { ascending: false }) : q).range(a, b); }, 3000);
  await rows("キーワードのルール", (a, b, p) => { const q = supabase.from("trigger_action_rules").select("id").eq("category", "keyword_rule"); return (p ? q.order("id", { ascending: false }) : q).range(a, b); }, 5000);
  await rows("ルールの一覧（画面）", (a, b, p) => { const q = supabase.from("trigger_action_rules").select("id").order("action_type", { ascending: true }).order("confidence", { ascending: false }).order("occurrence_count", { ascending: false }); return (p ? q.order("id", { ascending: false }) : q).range(a, b); }, 2000);
  await rows("返信の KPI（12週）", (a, b, p) => { const q = supabase.from("ai_reply_examples").select("created_at").gte("created_at", since84).order("created_at", { ascending: true }); return (p ? q.order("id", { ascending: true }) : q).range(a, b); }, 30000);
  process.exit(0);
})();
