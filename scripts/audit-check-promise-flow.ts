// scripts/audit-check-promise-flow.ts — 確認の約束の流れの場面（app/lib/check-promise-flow.ts）が竹内さん本人の番でどう当たるか（台帳 #688・読むだけ・LLM なし・費用 0）
// 2026-11-25 作業員A（竹内さんの4つの決め 11/25 朝）: audit-aix-turn-judgment の json の番（竹内さん本人・申込以降を外す）ごとに、番の時刻で場面を出し、
//   竹内さんの最初の一手（返信が先／AIX が先の種類）とブレインの道を並べる。本文・名前は出さない
// 実行: npx tsx --env-file=.env.local scripts/audit-check-promise-flow.ts --json=<audit-aix-turn-judgment の json>
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { checkPromiseFlowOf } from "../app/lib/check-promise-flow";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
type Row = { id: number; conv: string; at: string; cls: string; tk: string | null; v: string; route?: string };

(async () => {
  const ids = arg("ids") ? new Set(arg("ids").split(",").map(Number)) : null;
  const rows = (JSON.parse(readFileSync(arg("json"), "utf8")) as Row[]).filter((r) => !ids || ids.has(r.id));
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const { data: wt } = await sb.from("line_watch_turns").select("id, conversation_id, customer_last_at, customer_turn_at").in("id", rows.map((r) => r.id));
  const W = new Map(((wt ?? []) as Array<{ id: number; conversation_id: string; customer_last_at: string | null; customer_turn_at: string }>).map((w) => [w.id, w]));
  const tab = new Map<string, { n: number; moves: Map<string, number>; brain: Map<string, number>; ex: string[] }>();
  for (const r of rows) {
    const w = W.get(r.id); if (!w) continue;
    const now = Date.parse(w.customer_last_at ?? w.customer_turn_at) + 1000;
    const lo = new Date(now - 3 * 86_400_000).toISOString(), hi = new Date(now).toISOString();
    const [mq, aq] = await Promise.all([
      sb.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", w.conversation_id).gte("created_at", lo).lte("created_at", hi).order("created_at").limit(1000),
      sb.from("aix_usage_logs").select("aix_type, sent_at, created_at").eq("conversation_id", w.conversation_id).gte("created_at", lo).lte("created_at", hi).limit(500),
    ]);
    const f = checkPromiseFlowOf(((mq.data ?? []) as Array<{ sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null }>).map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: !!m.is_aix_generated })),
      (aq.data ?? []) as Array<{ aix_type: string | null; sent_at: string | null; created_at: string | null }>, now);
    if (ids) console.log(`  ${r.id} ${r.conv} ${w.customer_turn_at} 場面 ${f.scene ?? "—"}・竹内さん ${r.cls}/${r.tk ?? "—"}`);
    if (!f.scene) continue;
    const move = r.cls === "reply" || r.cls === "two_stage" ? "返信が先" : `AIX:${r.tk}`;
    const o = tab.get(f.scene) ?? { n: 0, moves: new Map(), brain: new Map(), ex: [] };
    o.n++; o.moves.set(move, (o.moves.get(move) ?? 0) + 1); o.brain.set(String(r.route ?? "?"), (o.brain.get(String(r.route ?? "?")) ?? 0) + 1); if (o.ex.length < 4) o.ex.push(`${r.conv}(${String(r.at).slice(5, 10)})`);
    tab.set(f.scene, o);
  }
  console.log(`■ 確認の約束の流れの場面 × 竹内さん本人の最初の一手（番 ${rows.length}）`);
  for (const [s, o] of tab) console.log(`  ${s}: n ${o.n}・竹内さん ${[...o.moves].map(([k, v]) => `${k} ${v}`).join("・")}・ブレインの道 ${[...o.brain].map(([k, v]) => `${k} ${v}`).join("・")}・例 ${o.ex.join("・")}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
