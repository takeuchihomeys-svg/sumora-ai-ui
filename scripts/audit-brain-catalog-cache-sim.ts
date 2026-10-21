// scripts/audit-brain-catalog-cache-sim.ts — 読むだけ・LLM なし。
//   2026-10-22 ブレイン（brain_fresh）の費用調べ: 素の入力（キャッシュされない user）の約2割は「AIX のボタン一覧」（catalogBlockForBrain(場面)）で、
//   これは会話をまたいで場面（9種）だけで決まる。user の先頭に場面の一覧を1ブロックで置いて 1h の印を付けたら、本番の並びでいくら浮くかを数える。
//   場面は見張りの行（line_watch_turns.materials.brain.blocks[].brainScene・at）を同じ会話の近い時刻で当てる（無ければ同じ会話の直前の場面・それも無ければ "other"）。
//   system の書き直し（cache_write_1h>0）があった回は前置きが変わったとみなして全部の場面の鍵を捨てる（控えめ）。
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-catalog-cache-sim.ts [--days=14] [--tpc=1.1]
import { createClient } from "@supabase/supabase-js";
import { catalogBlockForBrain } from "../app/lib/aix-catalog";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "14"));
const TPC = Number(arg("tpc", "1.1"));
const SINCE = new Date(Date.now() - DAYS * 86_400_000).toISOString();
const t = (s: string) => Date.parse(s);

(async () => {
  type L = { created_at: string; conversation_id: string | null; cache_write_1h: number | null };
  const llm: L[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("llm_usage_logs").select("created_at, conversation_id, cache_write_1h")
      .gte("created_at", SINCE).eq("env", "production").eq("action", "brain_fresh").lt("status", 400).order("created_at").range(i, i + 999);
    if (error) throw new Error(error.message);
    llm.push(...((data ?? []) as L[])); if ((data ?? []).length < 1000) break;
  }
  const blocks = new Map<string, Array<{ at: number; scene: string }>>();
  for (let s = t(SINCE) - 86_400_000; s < Date.now(); s += 6 * 3600_000) {
    const { data, error } = await sb.from("line_watch_turns").select("conversation_id, materials")
      .gte("customer_turn_at", new Date(s).toISOString()).lt("customer_turn_at", new Date(s + 6 * 3600_000).toISOString()).not("materials", "is", null).limit(1000);
    if (error) { console.error(error.message); continue; }
    for (const r of (data ?? []) as Array<{ conversation_id: string; materials: { brain?: { blocks?: unknown } } | null }>) {
      const b = r.materials?.brain?.blocks; const list = (Array.isArray(b) ? b : b ? [b] : []) as Array<{ at?: string; brainScene?: string; layer?: string }>;
      for (const x of list) if (x.at && x.brainScene && x.layer === "fresh") {
        if (!blocks.has(r.conversation_id)) blocks.set(r.conversation_id, []);
        blocks.get(r.conversation_id)!.push({ at: t(x.at), scene: x.brainScene });
      }
    }
  }
  const tok = (scene: string) => Math.round(catalogBlockForBrain((scene === "off" || scene === "other" ? scene : scene) as never).length * TPC);
  let matched = 0, prior = 0, none = 0;
  const exp = new Map<string, number>();
  let now = 0, after = 0, hits = 0, writes = 0;
  const per: Record<string, number> = {};
  for (const c of llm) {
    const ct = t(c.created_at);
    const list = blocks.get(c.conversation_id ?? "") ?? [];
    let scene = list.find((b) => Math.abs(b.at - ct) < 90_000)?.scene;
    if (scene) matched++; else { scene = list.filter((b) => b.at <= ct).at(-1)?.scene; if (scene) prior++; else { scene = "other"; none++; } }
    per[scene] = (per[scene] ?? 0) + 1;
    const T = tok(scene);
    now += T * 2;
    if ((c.cache_write_1h ?? 0) > 0) exp.clear();
    const e = exp.get(scene);
    if (e && e > ct) { after += T * 0.2; hits++; } else { after += T * 4; writes++; }
    exp.set(scene, ct + 3600_000);
  }
  const usd = (x: number) => x / 1e6;
  console.log(`brain_fresh ${llm.length}回 / ${DAYS}日（場面: 時刻で当てた ${matched}・直前の場面 ${prior}・不明→other ${none}）`);
  console.log(`場面: ${JSON.stringify(per)}`);
  console.log(`AIX 一覧の入力: 今 $${usd(now).toFixed(2)} → 先頭に置いて1hの印 $${usd(after).toFixed(2)}（読み ${hits}・書き ${writes}）＝ ${DAYS}日で $${usd(now - after).toFixed(2)}・月 $${(usd(now - after) / DAYS * 30).toFixed(2)}`);
})();
