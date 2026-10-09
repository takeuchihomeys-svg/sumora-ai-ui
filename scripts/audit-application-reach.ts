// scripts/audit-application-reach.ts — 「場面×段階×ブレインの判断 → 申込到達率」を台帳の作り方で計算して目で読む（読むだけ・LLM なし・DB に書かない）
//   ブレインの判断のある会話ごとに computeConversationOutcome（毎日の cron と同じ・場面と段階を出来事に付ける）→ computeReachStats。
//   旧（aix_action_attribution・ブレインに渡していた勝率）との前後も出す。決まりは app/lib/application-reach.ts（竹内さんの決定 10/08 ①⑥）
// 実行: npx tsx --env-file=.env.local scripts/audit-application-reach.ts [--min=20] [--limit=400] [--strict]
//   --strict: 10/08 の厳密な数え方（改善案1〜6・30日の固定窓・実際に送った AIX・案件は最初の判断1つ・理由不明の切り替えと初回のガードを外す・95%の幅が重ならない時だけ渡す）
import { createClient } from "@supabase/supabase-js";
import { computeConversationOutcome } from "../app/lib/deal-outcome-server";
import { computeReachStats, buildReachNote, reachedApplication, SCENE_LABEL, STAGE_BUCKET_LABEL, type ReachDecisionPoint, type ReachEpisode, type StageBucket } from "../app/lib/application-reach";
import { isTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const MIN = Number(arg("min", "20"));
const STRICT = process.argv.includes("--strict");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

async function main() {
  const nowMs = Date.now();
  // 旧: ブレインに渡していた勝率（brain-core loadBrainSystemInputs と同じ加重平均）
  const { data: attr } = await sb.from("aix_action_attribution").select("action_type, win_rate, usage_count").not("win_rate", "is", null);
  const g = new Map<string, { w: number; u: number }>();
  for (const r of (attr ?? []) as Array<{ action_type: string; win_rate: number; usage_count: number | null }>) {
    const x = g.get(r.action_type) ?? { w: 0, u: 0 }; const u = Number(r.usage_count ?? 1) || 1; x.w += Number(r.win_rate) * u; x.u += u; g.set(r.action_type, x);
  }
  const old = [...g.entries()].map(([a, x]) => ({ a, rate: x.u ? x.w / x.u : 0, n: x.u })).filter((r) => r.rate > 0).sort((p, q) => q.rate - p.rate).slice(0, 8);
  console.log(`=== 旧: ブレインに渡していた「成約につながりやすいアクション（実測勝率）」${old.length}行（aix_action_attribution ${attr?.length ?? 0}行）===`);
  for (const r of old) console.log(`- ${r.a}: 成約率${(r.rate * 100).toFixed(1)}% (n=${r.n})`);

  // 新: 判断のある会話
  const ids = new Set<string>();
  for (let i = 0; i < 50_000; i += 1000) {
    const { data, error } = await sb.from("brain_decision_logs").select("conversation_id").order("created_at").range(i, i + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ conversation_id: string }>) if (!isTestConversation(r.conversation_id)) ids.add(r.conversation_id);
    if ((data ?? []).length < 1000) break;
  }
  const list = [...ids].slice(0, Number(arg("limit", "1000")));
  const points: ReachDecisionPoint[] = [];
  const episodes: ReachEpisode[] = [];
  let applied = 0, epN = 0, noScene = 0;
  for (const id of list) {
    const o = await computeConversationOutcome(id, { nowMs });
    if (!o) continue;
    for (const r of o.rows) { epN++; if (reachedApplication(r)) applied++; episodes.push({ conversationId: id, episodeNo: r.episode_no, appliedAt: r.applied_at, result: r.result, confirmedWon: r.result === "won" && r.result_certainty === "confirmed", switchReason: r.switch_reason }); }
    const actual = new Map<string, { at: number; type: string }>();
    for (const e of o.events) {
      if (e.kind !== "aix_sent" || !e.decision_id) continue;
      const t = (e.detail as { aix_type?: string } | null)?.aix_type; if (!t) continue;
      const at = Date.parse(e.at); const prev = actual.get(e.decision_id);
      if (!prev || at < prev.at) actual.set(e.decision_id, { at, type: t });
    }
    for (const e of o.events) {
      if (e.kind !== "brain_decision") continue;
      const d = (e.detail ?? {}) as { action?: string | null; scene?: string | null; vb?: StageBucket; src?: string | null };
      if (!d.scene) noScene++;
      points.push({ conversationId: id, episodeNo: e.episode_no, at: e.at, action: d.action ?? null, scene: d.scene ?? null, bucket: d.vb ?? null, src: d.src ?? null, decisionId: e.decision_id, actualAction: e.decision_id ? actual.get(e.decision_id)?.type ?? null : null });
    }
  }
  const rows = computeReachStats(points, episodes, { nowMs, strict: STRICT });
  console.log(`（数え方: ${STRICT ? "厳密（10/08 改善案1〜6）" : "旧"}）`);
  console.log(`\n=== 新: 判断 ${points.length}件（場面なし ${noScene}）・会話 ${list.length}・案件 ${epN}（申込に届いた ${applied}）→ 場面×段階×判断 ${rows.length}行・線（${MIN}案件）を超えた ${rows.filter((r) => r.n >= MIN).length}行 ===`);
  for (const r of rows.filter((x) => x.n >= 3)) console.log(`${(SCENE_LABEL[r.scene_key] ?? r.scene_key).padEnd(8)} ${STAGE_BUCKET_LABEL[r.stage_bucket as StageBucket]} ${r.action.padEnd(24)} n=${String(r.n).padStart(3)} 申込=${String(r.reached).padStart(2)} ${(r.rate * 100).toFixed(0)}%`);
  console.log(`\n=== ブレインに渡る注記（線 ${MIN}）===`);
  let shown = 0;
  for (const scene of Object.keys(SCENE_LABEL)) for (const b of ["pre_viewing", "post_viewing"] as const) {
    const note = buildReachNote(rows, scene, b, { minN: MIN, computedAt: new Date(nowMs).toISOString(), strict: STRICT });
    if (note) { shown++; console.log(note + "\n"); }
  }
  if (!shown) console.log("（無し＝今は線を超えて比べられる場面が無い → ブレインには何も足さない）");
}
main().catch((e) => { console.error(e); process.exit(1); });
