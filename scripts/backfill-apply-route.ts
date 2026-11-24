// scripts/backfill-apply-route.ts — 地図の駅を残す前（11/21 より前）の統括の判断に、申込までの地図の駅（apply_route）だけを足す（LLM なし・台帳 #676）
// 実行（exam-night・22時以降）:
//   npx tsx --env-file=.env.local scripts/backfill-apply-route.ts --dry [--max=200]           … 件数と見本10件（書かない）
//   npx tsx --env-file=.env.local scripts/backfill-apply-route.ts --write --backup=<控えのファイル> [--max=200]   … 統括役が --dry を見てから
// 決まり（2026-11-24 統括役の了承）:
//   - 足すのは last_brain_meta.apply_route だけ（ほかの欄は1字も変えない）。印 src="backfill"・at（足した時刻）・basis（当てた時刻）
//   - 申込以降（is_post_apply・申込以降の状態）は外す。今 apply_route の node がある会話は触らない
//   - 当て方は audit-route-progress-takeuchi と同じ（scripts/lib/route-locate-at.ts・お客様の最後の連投の時点）
//   - 書く前の値（apply_route の今の値＝ほぼ null）と brain_analyzed_at を控えのファイルに残す。書く時は brain_analyzed_at が変わっていない行だけ（その間に判断が作り直された会話は書かない）
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { loadCustomerStateInput } from "../app/lib/customer-state-server";
import { locateAt, POST_STATUSES } from "./lib/route-locate-at";
import { ROUTE_NODES, ROUTE_BRANCHES } from "../app/lib/apply-route-map";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const WRITE = process.argv.includes("--write");
const MAX = Number(arg("max", "200"));
if (WRITE && !arg("backup")) { console.error("--write には --backup=<控えのファイル> が要る"); process.exit(1); }
if (!WRITE && !process.argv.includes("--dry")) { console.error("--dry か --write を付ける"); process.exit(1); }

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const { data, error } = await sb.from("conversations")
    .select("id, status, is_post_apply, brain_analyzed_at, ar:last_brain_meta->apply_route, ts:last_brain_meta->>analyzed_msg_ts")
    .not("last_brain_meta", "is", null).gte("updated_at", new Date(Date.now() - 60 * 86400e3).toISOString()).limit(2000);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ id: string; status: string | null; is_post_apply: boolean | null; brain_analyzed_at: string | null; ar: { node?: string | null } | null; ts: string | null }>;
  const post = rows.filter((r) => r.is_post_apply || (r.status && POST_STATUSES.has(r.status)));
  const has = rows.filter((r) => !post.includes(r) && r.ar?.node);
  const targets = rows.filter((r) => !post.includes(r) && !r.ar?.node).slice(0, MAX);
  console.log(`■ 判断のある会話（60日） ${rows.length}・申込以降で外す ${post.length}・もう駅がある ${has.length}・足す対象 ${rows.length - post.length - has.length}（今回 ${targets.length}）`);
  const out: Array<{ id: string; before: unknown; analyzedAt: string | null; apply_route: Record<string, unknown> | null; why?: string }> = [];
  for (const r of targets) {
    try {
      const input = await loadCustomerStateInput(r.id);
      if (!input) { out.push({ id: r.id, before: r.ar, analyzedAt: r.brain_analyzed_at, apply_route: null, why: "材料が読めない" }); continue; }
      const lastCust = [...input.messages].reverse().find((m) => m.sender === "customer");
      if (!lastCust) { out.push({ id: r.id, before: r.ar, analyzedAt: r.brain_analyzed_at, apply_route: null, why: "お客様の通が無い" }); continue; }
      const T = Date.parse(lastCust.createdAt) + 1000;
      const loc = locateAt(input, T, false);
      out.push({ id: r.id, before: r.ar, analyzedAt: r.brain_analyzed_at, apply_route: { node: loc.loc.node, branch: loc.loc.branch, next: loc.loc.next?.label?.slice(0, 40) ?? null, next_aix: (loc.loc.next?.aix ?? []).slice(0, 3), substate: loc.sub1, src: "backfill", at: new Date().toISOString(), basis: new Date(T).toISOString() } });
    } catch (e) { out.push({ id: r.id, before: r.ar, analyzedAt: r.brain_analyzed_at, apply_route: null, why: (e instanceof Error ? e.message : String(e)).slice(0, 80) }); }
  }
  const ok = out.filter((o) => o.apply_route);
  const byNode = new Map<string, number>(); for (const o of ok) { const k = `${(ROUTE_NODES as Record<string, { name: string }>)[String(o.apply_route!.node)]?.name ?? o.apply_route!.node}${o.apply_route!.branch ? `／分:${(ROUTE_BRANCHES as Record<string, { name: string }>)[String(o.apply_route!.branch)]?.name ?? o.apply_route!.branch}` : ""}`; byNode.set(k, (byNode.get(k) ?? 0) + 1); }
  console.log(`  当てられた ${ok.length}・当てられない ${out.length - ok.length}（${[...new Set(out.filter((o) => !o.apply_route).map((o) => o.why))].join("・")}）`);
  console.log(`  駅ごと: ${[...byNode.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
  console.log(`\n■ 見本10件（会話の id の先頭8字・名前は出さない）`);
  for (const o of ok.slice(0, 10)) console.log(`  ${o.id.slice(0, 8)}: ${JSON.stringify({ node: o.apply_route!.node, branch: o.apply_route!.branch, next: o.apply_route!.next, substate: o.apply_route!.substate, basis: String(o.apply_route!.basis).slice(0, 16) })}`);
  if (!WRITE) { console.log(`\n（--dry: 書いていない）`); return; }
  // 控え（書く前の値）を先に残す
  writeFileSync(arg("backup"), JSON.stringify(out.map((o) => ({ id: o.id, before_apply_route: o.before ?? null, brain_analyzed_at: o.analyzedAt })), null, 1));
  let wrote = 0, skipped = 0;
  for (const o of ok) {
    const { data: cur, error: e1 } = await sb.from("conversations").select("last_brain_meta, brain_analyzed_at").eq("id", o.id).maybeSingle();
    if (e1 || !cur) { skipped++; continue; }
    const meta = (cur as { last_brain_meta: Record<string, unknown> | null }).last_brain_meta;
    if (!meta || (meta.apply_route as { node?: unknown } | undefined)?.node || (cur as { brain_analyzed_at: string | null }).brain_analyzed_at !== o.analyzedAt) { skipped++; continue; } // その間に判断が作り直された・もう駅がある
    const { error: e2, count } = await sb.from("conversations").update({ last_brain_meta: { ...meta, apply_route: o.apply_route } }, { count: "exact" }).eq("id", o.id).eq("brain_analyzed_at", o.analyzedAt as string);
    if (e2 || !count) { skipped++; continue; }
    wrote++;
  }
  console.log(`\n■ 書いた ${wrote}・書かなかった ${skipped}（控え ${arg("backup")}）`);
})().catch((e) => { console.error(e); process.exit(1); });
