// scripts/audit-route-misread-move.ts — 統括の判断の「今どこ」（地図の駅）を、その後の実際の一手で照らして毎日数える（読むだけ・LLM なし・台帳 #657）
// 実行: npx tsx --env-file=.env.local scripts/audit-route-misread-move.ts [--days=7] [--json=<file>]
//   読む: brain_decision_logs（digest.ar がある判断・11/23 から）・aix_usage_logs（その会話の送付・判断の前30日〜後30時間）・conversations（申込以降を外す・backfill の印）
//   分け方は app/lib/route-misread-move.ts（型 match／behind／ahead／other_path／timed／unknown・原因 材料が無い／読み違い／数え方）
// 2026-11-24 作業員A（統括役の頼み）
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { parseAr, misreadMoveOf, misreadMoveMetricRows, MOVE_KIND_JA, MOVE_CAUSE_JA, type MoveKind, type MoveCause } from "../app/lib/route-misread-move";
import { ROUTE_NODES, ROUTE_BRANCHES } from "../app/lib/apply-route-map";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const days = Number(arg("days", "7"));
const POST = new Set(["applying", "application", "screening", "approved", "contract", "closed_won", "closed_lost"]);

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data: logs, error } = await sb.from("brain_decision_logs").select("conversation_id, created_at, ar:digest->>ar").gte("created_at", since).not("digest->>ar", "is", null).order("created_at").limit(3000);
  if (error) throw error;
  const rows0 = (logs ?? []) as Array<{ conversation_id: string; created_at: string; ar: string | null }>;
  const convIds = [...new Set(rows0.map((r) => r.conversation_id))];
  const convs = new Map<string, { status: string | null; post: boolean; backfill: boolean }>();
  const sends = new Map<string, Array<{ t: number; aix: string }>>();
  const from = new Date(Date.parse(since) - 30 * 864e5).toISOString();
  for (let i = 0; i < convIds.length; i += 80) {
    const ch = convIds.slice(i, i + 80);
    const [{ data: c }, { data: a }] = await Promise.all([
      sb.from("conversations").select("id, status, is_post_apply, src:last_brain_meta->apply_route->>src").in("id", ch),
      sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at").in("conversation_id", ch).gte("created_at", from).order("created_at").limit(5000),
    ]);
    for (const x of (c ?? []) as Array<{ id: string; status: string | null; is_post_apply: boolean | null; src: string | null }>) convs.set(x.id, { status: x.status, post: !!x.is_post_apply || (!!x.status && POST.has(x.status)), backfill: x.src === "backfill" });
    for (const x of (a ?? []) as Array<{ conversation_id: string; aix_type: string | null; created_at: string }>) { if (!x.aix_type) continue; const l = sends.get(x.conversation_id) ?? []; l.push({ t: Date.parse(x.created_at), aix: String(x.aix_type).split("/")[0] }); sends.set(x.conversation_id, l); }
  }
  type Out = { conv: string; at: string; node: string | null; branch: string | null; move: string | null; hours: number | null; kind: MoveKind; cause: MoveCause };
  const out: Out[] = [];
  let post = 0;
  for (const r of rows0) {
    const cv = convs.get(r.conversation_id);
    if (cv?.post) { post++; continue; }
    const ar = parseAr(r.ar); if (!ar) continue;
    const t = Date.parse(r.created_at);
    const list = sends.get(r.conversation_id) ?? [];
    const next = list.find((s) => s.t > t && s.t - t <= 30 * 36e5);
    const before = list.filter((s) => s.t < t && t - s.t <= 30 * 864e5).map((s) => s.aix);
    const hours = next ? Math.round(((next.t - t) / 36e5) * 10) / 10 : null;
    const v = misreadMoveOf({ node: ar.node, branch: ar.branch, moveAix: next?.aix ?? null, hoursAfter: hours, sentBefore: before });
    out.push({ conv: r.conversation_id.slice(0, 8), at: r.created_at, node: ar.node, branch: ar.branch, move: next?.aix ?? null, hours, ...v });
  }
  const nm = (n: string | null, b: string | null) => `${n ? (ROUTE_NODES as Record<string, { name: string }>)[n]?.name ?? n : "?"}${b ? `／分:${(ROUTE_BRANCHES as Record<string, { name: string }>)[b]?.name ?? b}` : ""}`;
  const cnt = (f: (o: Out) => boolean) => out.filter(f).length;
  console.log(`■ 統括の判断の「今どこ」× その後の一手（${days}日・digest.ar のある判断 ${rows0.length}・申込以降で外す ${post}・照らした ${out.length}）`);
  for (const k of ["match", "behind", "ahead", "other_path", "timed", "unknown"] as MoveKind[]) console.log(`  ${MOVE_KIND_JA[k]}: ${cnt((o) => o.kind === k)}`);
  for (const m of misreadMoveMetricRows(out)) console.log(`  ${m.metric}: ${m.value ?? "—"}%（${m.n}番）`);
  console.log(`\n■ 読み違いの型 × 駅 × 原因（上位）`);
  const g = new Map<string, number>();
  for (const o of out.filter((x) => x.kind === "behind" || x.kind === "ahead" || x.kind === "other_path")) { const k = `${MOVE_KIND_JA[o.kind]}｜${nm(o.node, o.branch)}→一手 ${o.move}｜${o.cause ? MOVE_CAUSE_JA[o.cause] : "-"}`; g.set(k, (g.get(k) ?? 0) + 1); }
  for (const [k, v] of [...g.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${v}  ${k}`);
  const byNode = new Map<string, { n: number; miss: number }>();
  for (const o of out.filter((x) => x.kind !== "unknown" && x.kind !== "timed")) { const k = nm(o.node, o.branch); const s = byNode.get(k) ?? { n: 0, miss: 0 }; s.n++; if (o.kind !== "match") s.miss++; byNode.set(k, s); }
  console.log(`\n■ 駅ごとの読み違いの割合（照らせた番）: ${[...byNode.entries()].sort((a, b) => b[1].miss - a[1].miss).map(([k, s]) => `${k} ${s.miss}/${s.n}`).join("・")}`);
  console.log(`  #676 の backfill の判断（別に数える）: ${[...convs.values()].filter((c) => c.backfill).length}会話（digest.ar の判断とは別・まだ書いていなければ 0）`);
  if (arg("json")) writeFileSync(arg("json"), JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
