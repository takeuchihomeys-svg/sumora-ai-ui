// 物件ピックアップが1回の検索で何回に分かれて届くか・まとめ（完了）までの時間・分析の呼び出し数（読むだけ・個人情報は出さない）
// 2026-09-26 自動まとめを10分→3分にした根拠（pickup-complete.ts AUTO_COMPLETE_QUIET_MINUTES）。実行: npx tsx --env-file=.env.local scripts/audit-pickup-arrivals.ts
import { supabase } from "../app/lib/supabase";
const since = "2026-09-19T00:00:00Z";
async function all<T>(q: (from: number) => any): Promise<T[]> { const out: T[] = []; for (let f = 0; ; f += 1000) { const { data, error } = await q(f); if (error) throw error; out.push(...(data ?? [])); if (!data || data.length < 1000) break; } return out; }
(async () => {
  const rows = await all<any>((f) => supabase.from("property_pickups").select("id,created_at,batch_id,property_customer_id,conversation_id,site,complete_group_id,image_analysis,recommended,verdict").gte("created_at", since).order("created_at").range(f, f + 999));
  console.log("rows", rows.length);
  // batches
  const b = new Map<string, any>();
  for (const r of rows) { const x = b.get(r.batch_id) ?? { id: r.batch_id, pc: r.property_customer_id ?? r.conversation_id ?? "?", at: Date.parse(r.created_at), site: r.site, n: 0, gids: new Set(), analyzed: 0, star: 0 }; x.n++; if (r.complete_group_id) x.gids.add(r.complete_group_id); if (r.image_analysis && typeof r.image_analysis.match === "number") x.analyzed++; if (r.recommended > 0) x.star++; b.set(r.batch_id, x); }
  const batches = [...b.values()].sort((a, z) => a.at - z.at);
  console.log("batches", batches.length);
  // sessions per customer: gap <= 30min
  const byPc = new Map<string, any[]>(); for (const x of batches) { const a = byPc.get(x.pc) ?? []; a.push(x); byPc.set(x.pc, a); }
  const gaps: number[] = []; const sessSizes: number[] = []; const sessStars: number[] = []; const sessSpan: number[] = [];
  let sessions = 0, multi = 0;
  for (const [, arr] of byPc) {
    let cur: any[] = [];
    const flush = () => { if (!cur.length) return; sessions++; sessSizes.push(cur.length); if (cur.length > 1) multi++; sessStars.push(cur.filter((x) => x.star > 0).length); sessSpan.push((cur[cur.length - 1].at - cur[0].at) / 60000); cur = []; };
    for (const x of arr) { if (cur.length && x.at - cur[cur.length - 1].at > 30 * 60000) flush(); if (cur.length) gaps.push((x.at - cur[cur.length - 1].at) / 1000); cur.push(x); }
    flush();
  }
  const q = (a: number[], p: number) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
  console.log("sessions(<=30min)", sessions, "multi-batch", multi);
  const hist: Record<string, number> = {}; for (const s of sessSizes) hist[s] = (hist[s] ?? 0) + 1; console.log("batches/session", JSON.stringify(hist));
  const sh: Record<string, number> = {}; for (const s of sessStars) sh[s] = (sh[s] ?? 0) + 1; console.log("batches with 🌟 per session", JSON.stringify(sh));
  console.log("gap sec p10/p25/p50/p75/p90/max", [0.1, .25, .5, .75, .9, .999].map((p) => q(gaps, p)?.toFixed(0)).join(" / "));
  const bk = { "<30s": 0, "30-60s": 0, "1-2m": 0, "2-5m": 0, "5-10m": 0, "10-30m": 0 } as Record<string, number>;
  for (const g of gaps) bk[g < 30 ? "<30s" : g < 60 ? "30-60s" : g < 120 ? "1-2m" : g < 300 ? "2-5m" : g < 600 ? "5-10m" : "10-30m"]++;
  console.log("gap buckets", JSON.stringify(bk));
  console.log("session span min p50/p90/max", [.5, .9, .999].map((p) => q(sessSpan, p)?.toFixed(1)).join(" / "));
  const perBatchItems = batches.map((x) => x.n); console.log("items/batch p50/p90/max", q(perBatchItems, .5), q(perBatchItems, .9), q(perBatchItems, .999));
  // same-site consecutive vs different site
  let sameSite = 0, diffSite = 0; for (const [, arr] of byPc) for (let i = 1; i < arr.length; i++) { if (arr[i].at - arr[i - 1].at > 30 * 60000) continue; if (arr[i].site === arr[i - 1].site) sameSite++; else diffSite++; }
  console.log("consecutive gap same-site", sameSite, "diff-site", diffSite);
  // completions
  const comps = await all<any>((f) => supabase.from("property_pickup_completions").select("group_id,created_at,trigger,mode,requested_by,status,batch_ids,finished_at,result").gte("created_at", since).range(f, f + 999));
  const tr: Record<string, number> = {}; for (const c of comps) tr[`${c.trigger}/${c.requested_by}/${c.status}`] = (tr[`${c.trigger}/${c.requested_by}/${c.status}`] ?? 0) + 1;
  console.log("completions", comps.length, JSON.stringify(tr));
  const lag: number[] = []; const late: number[] = [];
  for (const c of comps) { const bs = (c.batch_ids ?? []).map((id: string) => b.get(id)).filter(Boolean); if (!bs.length) continue; const last = Math.max(...bs.map((x: any) => x.at)); lag.push((Date.parse(c.created_at) - last) / 60000);
    const pc = bs[0].pc; const after = (byPc.get(pc) ?? []).filter((x) => x.at > Date.parse(c.created_at) && x.at - Date.parse(c.created_at) < 30 * 60000 && !x.gids.size); late.push(after.length); }
  console.log("complete lag min p10/p50/p90", [.1, .5, .9].map((p) => q(lag, p)?.toFixed(1)).join(" / "));
  console.log("batches arriving within 30m after a completion (unclaimed)", late.reduce((s, x) => s + x, 0), "of completions", late.filter((x) => x > 0).length);
  const bpc: Record<string, number> = {}; for (const c of comps) { const k = (c.batch_ids ?? []).length; bpc[k] = (bpc[k] ?? 0) + 1; } console.log("batches/completion", JSON.stringify(bpc));
  const ungrouped = batches.filter((x) => !x.gids.size).length; console.log("batches never grouped", ungrouped);
  // LLM calls
  const logs = await all<any>((f) => supabase.from("llm_usage_logs").select("created_at,action,model,status,conversation_id").gte("created_at", since).in("action", ["property_rank", "pickup_image_analysis", "condition_summary", "pickup_image_read", "image_detail", "floor_plan_facts"]).range(f, f + 999));
  const ac: Record<string, number> = {}; for (const l of logs) ac[l.action] = (ac[l.action] ?? 0) + 1; console.log("llm", JSON.stringify(ac));
  const { data: acts } = await supabase.from("llm_usage_logs").select("action").gte("created_at", "2026-09-25T00:00:00Z").ilike("route", "%pickup%").limit(1000);
  const a2: Record<string, number> = {}; for (const l of acts ?? []) a2[l.action] = (a2[l.action] ?? 0) + 1; console.log("pickup-route actions", JSON.stringify(a2));
  // condition_summary per conversation per session
  const cs = logs.filter((l) => l.action === "condition_summary"); const csConv: Record<string, number> = {}; for (const l of cs) csConv[l.conversation_id ?? "-"] = (csConv[l.conversation_id ?? "-"] ?? 0) + 1;
  console.log("condition_summary calls per conv (dist)", JSON.stringify(Object.values(csConv).reduce((h: any, n) => { h[n] = (h[n] ?? 0) + 1; return h; }, {})));
  const pa = logs.filter((l) => l.action === "pickup_image_analysis"); console.log("image analysis calls", pa.length, "items analyzed", rows.filter((r) => r.image_analysis && typeof r.image_analysis.match === "number").length);
})().catch((e) => { console.error(e.message); process.exit(1); });
