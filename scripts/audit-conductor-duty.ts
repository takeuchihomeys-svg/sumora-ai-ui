// scripts/audit-conductor-duty.ts — 統括の受け持ち表（土台ごとに 持つ／使う／反映 のどこまで・読むだけ・LLM なし・費用0・軽い読み）
//
// 2026-11-23 作業員A（竹内さん 11/23・P0・台帳 #662）。表は scripts/lib/conductor-duty.ts。段の状態は連携の地図の見張りの最新（cron_run_logs・linkage-watch）。
// 実行: npx tsx --env-file=.env.local scripts/audit-conductor-duty.ts [--json]
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { LINKAGE_MAP } from "../app/lib/linkage-map";
import { runLinkageWatch } from "../app/lib/linkage-watch-server";
import { CONDUCTOR_DUTY, conductorDutyOf, conductorDutySummary, DUTY_JA, type LinkStatus, type DutyStage } from "./lib/conductor-duty";

/** 連携の地図の見張りの最新（作業員P の loadLinkageStatus と同じ読み） */
export async function loadLinkStatus(sb: SupabaseClient): Promise<(LinkStatus & { at: string }) | null> {
  const { data } = await sb.from("cron_run_logs").select("started_at,result_json").eq("cron_name", "linkage-watch").eq("ok", true).order("started_at", { ascending: false }).limit(1);
  const r = (data?.[0] ?? null) as { started_at: string; result_json: { cut?: Array<{ id: string }>; off?: Array<{ id: string }>; unmeasured?: Array<{ id: string }> } | null } | null;
  if (!r?.result_json) return liveLinkStatus(sb);
  return { at: r.started_at, cut: new Set((r.result_json.cut ?? []).map((x) => x.id)), off: new Set((r.result_json.off ?? []).map((x) => x.id)), unmeasured: r.result_json.unmeasured ? new Set(r.result_json.unmeasured.map((x) => x.id)) : undefined };
}

/** 見張りの記録が無い時は今ここで回す（作業員L の runLinkageWatch・直近3日の判断の meta を読む軽い読み）。unknown は測れない行 */
export async function liveLinkStatus(sb: SupabaseClient): Promise<(LinkStatus & { at: string }) | null> {
  try {
    const rep = await runLinkageWatch(sb);
    const ids = (st: string[]) => new Set(rep.results.filter((r) => st.includes(r.status)).map((r) => r.id));
    return { at: `${new Date().toISOString()}（今回した）`, cut: ids(["broken", "sparse"]), off: ids(["parent_off"]), unmeasured: ids(["unknown"]) };
  } catch { return null; }
}

if (/audit-conductor-duty\.ts$/.test(process.argv[1] ?? "")) (async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const st = await loadLinkStatus(sb);
  const res = conductorDutyOf(CONDUCTOR_DUTY, new Set(LINKAGE_MAP.map((r) => r.id)), st);
  const sm = conductorDutySummary(res);
  if (process.argv.includes("--json")) { console.log(JSON.stringify({ at: st?.at ?? null, summary: { have: sm.have, use: sm.use, reflect: sm.reflect, n: sm.n }, res })); return; }
  console.log(`見張りの最新: ${st?.at ?? "なし"}`);
  console.log(sm.line);
  for (const r of res) console.log(`  ${r.name}（${r.owner}）: ${(["have", "use", "reflect"] as DutyStage[]).map((s) => `${DUTY_JA[s]} ${r.stages[s].state}${r.stages[s].bad.length ? `（${r.stages[s].bad.join("・")}）` : ""}`).join("・")}${r.parts.length ? `｜先につなぐ部品 ${r.parts.join("・")}` : ""}`);
})().catch((e) => { console.error(e); process.exit(1); });
