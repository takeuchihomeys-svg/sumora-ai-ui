// scripts/audit-shadow-auto.ts — 影の自動返信の数え（#812・費用0・LLM なし・書かない・2026-11-27 作業員A）
//   line_watch_turns（30日・軽い読み）の auto_eligible（関所を通るか）・verdict・下書き・スタッフの文・スタッフの AIX から、関所の穴と場面ごとの候補を出す。
//   危ない間違いは L の #811 の dangerOfEdit（app/lib/delegation-index.ts）と同じ物差し（取り込み前の写しでは読めないので、無ければ「数えない」と出す）
//   --write: quality_daily に shadow:*（毎晩の費用0の仕事・14日）／--out=<json>: 関所を通るのにスタッフが AIX を押した番の一覧（#821 の数えの元）
//   実行: npx tsx --env-file=.env.local scripts/audit-shadow-auto.ts [--days=30] [--write] [--out=<json>]
import { createClient } from "@supabase/supabase-js";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { gateHoles, sceneReadiness, shadowLines, type ShadowTurn } from "../app/lib/shadow-auto-reply";
import { finalCheckStateOf } from "../app/lib/auto-gate-final-check";

const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "30");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "", { auth: { persistSession: false } });
const req = createRequire(__filename);
const delegPath = "../app/lib/delegation-index";
let dangerOfEdit: ((d: string | null, s: string | null) => string[]) | null = null;
try { dangerOfEdit = (req(delegPath) as { dangerOfEdit: (d: string | null, s: string | null) => string[] }).dangerOfEdit; } catch { dangerOfEdit = null; }

async function main() {
  const { data, error } = await sb.from("line_watch_turns").select("conversation_id, customer_turn_at, brain_action, brain_reply_mode, scene_key, tpo_label, verdict, auto_eligible, draft_last, staff_texts, staff_aix, final_check, conv_status").gte("customer_turn_at", new Date(Date.now() - DAYS * 864e5).toISOString()).limit(5000);
  if (error) throw error;
  const turns: ShadowTurn[] = ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
    const staff = Array.isArray(r.staff_texts) ? (r.staff_texts as Array<{ text?: string } | string>).map((x) => (typeof x === "string" ? x : x?.text ?? "")).join("\n") : (r.staff_texts as string | null) ?? null;
    const aix = Array.isArray(r.staff_aix) && (r.staff_aix as unknown[]).length > 0;
    return {
      scene: String(r.scene_key ?? r.tpo_label ?? "-"), wouldSend: !!(r.auto_eligible as { would_send?: boolean } | null)?.would_send, verdict: (r.verdict as string | null) ?? null,
      draft: (r.draft_last as string | null) ?? null, staffText: staff, staffPressedAix: aix,
      danger: dangerOfEdit && !aix ? dangerOfEdit((r.draft_last as string | null) ?? null, staff) : [],
      finalCheckOk: r.final_check == null ? null : finalCheckStateOf(r.final_check) === "ok", convStatus: (r.conv_status as string | null) ?? null,
    };
  });
  if (!dangerOfEdit) console.log("（危ない間違いは数えない: delegation-index がこの写しに無い＝L の #811 の取り込みの後に数える）");
  const holes = gateHoles(turns), rs = sceneReadiness(turns);
  console.log(shadowLines(holes, rs).join("\n"));
  const raw = (data ?? []) as Array<Record<string, unknown>>;
  const out = process.argv.find((a) => a.startsWith("--out="))?.slice(6);
  if (out) {
    // 関所を通るのにスタッフが AIX を押した番（返信か AIX かの外れ）＝#821（AIX ツールの判定とブレイン）の数えの元に渡す
    const list = raw.map((r, i) => ({ r, t: turns[i] })).filter((x) => x.t.wouldSend && x.t.staffPressedAix).map(({ r, t }) => ({ conv: String(r.conversation_id ?? "").slice(0, 8), at: r.customer_turn_at, scene: t.scene, brain_action: r.brain_action ?? null, brain_reply_mode: r.brain_reply_mode ?? null, staff_aix: r.staff_aix }));
    writeFileSync(out, JSON.stringify(list, null, 1));
    console.log(`AIX の番を返信にした番の一覧 ${list.length} → ${out}（#821 の数えの元）`);
  }
  if (process.argv.includes("--write")) {
    const day = new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 10);
    const rows = [
      { metric: "shadow:passed", value: holes.passed, n: turns.length }, { metric: "shadow:staff_aix", value: holes.staffAix, n: holes.passed },
      { metric: "shadow:danger", value: dangerOfEdit ? holes.danger : null, n: holes.passed }, { metric: "shadow:post_apply_scene", value: holes.postApplyScene, n: holes.passed },
      { metric: "shadow:ready_scenes", value: rs.filter((r) => r.ready).length, n: rs.length },
      ...rs.slice(0, 12).map((r) => ({ metric: `shadow:same:${r.scene}`, value: r.sameRate, n: r.judged })),
    ].map((r) => ({ day, scope: "all", source: "scripts/audit-shadow-auto.ts", ...r }));
    const { error: e2 } = await sb.from("quality_daily").upsert(rows, { onConflict: "day,metric,scope" });
    console.log(e2 ? `quality_daily: ${e2.message}` : `quality_daily ${rows.length}行`);
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
