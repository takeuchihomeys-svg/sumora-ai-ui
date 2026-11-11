// scripts/audit-watch-scene-v2.ts — 見張り専用の場面（LINE_WATCH_SCENE_V2）の前後で場面が変わった番を全部並べる（直近28日・dry・読むだけ・書かない・送らない・LLM なし）
// 実行: npx tsx --env-file=.env.local scripts/audit-watch-scene-v2.ts（営業時間 9〜22時は流さない）
import { createClient } from "@supabase/supabase-js";
import { evaluateLineWatchTurns } from "../app/lib/line-watch-eval-server";
import { isTestConversation } from "../app/lib/test-conversations";
(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const run = async (v2: boolean) => { process.env.LINE_WATCH_SCENE_V2 = v2 ? "on" : "off"; return evaluateLineWatchTurns(sb, { dry: true, days: 28, backlogDays: 28, limit: 20000, reevalFinal: true, collect: true }); };
  const a = await run(false), b = await run(true);
  const before = new Map((a.rows ?? []).map((r) => [r.id, r.patch.scene_key as string]));
  const changed = (b.rows ?? []).filter((r) => !isTestConversation(r.conversation_id) && before.get(r.id) !== r.patch.scene_key);
  const ids = changed.map((r) => r.id);
  const { data } = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, customer_last_at, tpo_label").in("id", ids);
  const cnt: Record<string, number> = {};
  for (const r of changed) { const k = before.get(r.id) + " → " + r.patch.scene_key; cnt[k] = (cnt[k] ?? 0) + 1; }
  console.log(JSON.stringify(cnt, null, 1));
  for (const t of (data ?? []) as any[]) {
    const { data: m } = await sb.from("messages").select("text").eq("conversation_id", t.conversation_id).eq("sender", "customer").gte("created_at", new Date(Date.parse(t.customer_turn_at) - 1000).toISOString()).lte("created_at", new Date(Date.parse(t.customer_last_at ?? t.customer_turn_at) + 1000).toISOString()).order("created_at");
    const r = changed.find((x) => x.id === t.id)!;
    console.log(`${t.id} | ${before.get(t.id)} → ${r.patch.scene_key} | tpo=${(t.tpo_label ?? "").slice(0, 14)} | ${((m ?? []) as any[]).map((x) => x.text ?? "").join(" / ").replace(/\n/g, " ").slice(0, 90)}`);
  }
})();
