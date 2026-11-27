// scripts/audit-deal-stage-before-apply.ts — 台帳 #742: DEAL_STAGE_BEFORE_APPLY の off/on を、申込に届いた会話で比べる（読むだけ・DB に書かない・LLM なし）
// 2026-11-25 作業員L（統括役の決め）。確かめ: deal-flow の order（地図と順番が違う）が減り、到達率・型が大きく動かないこと。
//   審査落ちの後の探し直し（申込の後の condition_hearing）が、新しい案件（episode）の扱いと食い違わないか（申込の後の条件が、同じ案件の中に残っている数）も出す。
//   会話ごとに computeConversationOutcome を off と on で2回（会話で絞った読み・22時以降に回す）。出すのは数だけ
// 実行: npx tsx --env-file=.env.local scripts/audit-deal-stage-before-apply.ts [--limit=200]
import { createClient } from "@supabase/supabase-js";
import { computeConversationOutcome } from "../app/lib/deal-outcome-server";
import { isTestConversation } from "../app/lib/test-conversations";
import { dealFlowOf, flowTypes, stationReach, type DealFlow, type DealRow } from "./lib/deal-flow";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const SWITCH = arg("switch", "DEAL_STAGE_BEFORE_APPLY");

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const { data, error } = await sb.from("deal_outcomes").select("conversation_id").not("applied_at", "is", null).limit(2000);
  if (error) throw new Error(error.message);
  const convs = [...new Set(((data ?? []) as Array<{ conversation_id: string }>).map((r) => r.conversation_id))].filter((c) => !isTestConversation(c)).slice(0, Number(arg("limit", "200")));
  const flows: Record<"off" | "on", DealFlow[]> = { off: [], on: [] };
  let postCond = 0, postCondLaterEpisode = 0, postSent = 0, heldMoved = 0, failed = 0;
  let id = 0;
  for (const c of convs) {
    const r: Partial<Record<"off" | "on", Awaited<ReturnType<typeof computeConversationOutcome>>>> = {};
    for (const mode of ["off", "on"] as const) {
      process.env[SWITCH] = mode; // 2026-11-26: --switch=<名前> で他のスイッチの off/on も比べる（既定 DEAL_STAGE_BEFORE_APPLY）
      try { r[mode] = await computeConversationOutcome(c, { db: sb as never }); } catch { r[mode] = null; }
    }
    if (!r.off || !r.on) { failed++; continue; }
    for (const mode of ["off", "on"] as const) for (const row of r[mode]!.rows) flows[mode].push(dealFlowOf({ ...(row as unknown as DealRow), id: ++id, conversation_id: c }));
    r.on.episodes.forEach((e, k) => {
      if (e.postApplyStageAt?.condition) { postCond++; if (k < r.on!.episodes.length - 1) postCondLaterEpisode++; }
      if (e.postApplyStageAt?.property_sent) postSent++;
      const o = r.off!.episodes[k];
      if (o && o.stageAt.viewing_held !== e.stageAt.viewing_held) heldMoved++;
    });
    await new Promise((res) => setTimeout(res, 100));
  }
  const cnt = (fs: DealFlow[], kind: string) => fs.reduce((a, f) => a + f.issues.filter((i) => i.kind === kind).length, 0);
  console.log(`# ${SWITCH} off/on（申込に届いた会話 ${convs.length}・読めなかった ${failed}）\n`);
  console.log("| 数 | off | on |\n|---|---|---|");
  console.log(`| 案件 | ${flows.off.length} | ${flows.on.length} |`);
  console.log(`| 申込に届いた案件 | ${flows.off.filter((f) => f.applied).length} | ${flows.on.filter((f) => f.applied).length} |`);
  for (const k of ["order", "record_missing", "no_road"]) console.log(`| ${k} | ${cnt(flows.off, k)} | ${cnt(flows.on, k)} |`);
  const ro = stationReach(flows.off), rn = stationReach(flows.on);
  for (let i = 0; i < ro.length; i++) if (ro[i].n || rn[i].n) console.log(`| 到達率 ${ro[i].station} | ${ro[i].rate ?? "—"}%（${ro[i].n}） | ${rn[i].rate ?? "—"}%（${rn[i].n}） |`);
  const to = flowTypes(flows.off).slice(0, 6), tn = flowTypes(flows.on).slice(0, 6);
  console.log("\n型（上位6）:");
  for (let i = 0; i < 6; i++) console.log(`- off ${to[i] ? `${to[i].type} ${to[i].applied}` : "—"}／on ${tn[i] ? `${tn[i].type} ${tn[i].applied}` : "—"}`);
  console.log(`\non で段から外して postApplyStageAt に移した: 条件 ${postCond}（うち後に新しい案件がある＝案件の切れ目の前の探し直し ${postCondLaterEpisode}）・物件送り ${postSent}・内覧したの時刻を申込の1分前に ${heldMoved}`);
  console.log("（申込の後の条件が最後の案件に残る＝審査落ちの後の探し直しが新しい案件に切れていない疑い。案件の切れ目は episodeBoundaries・on/off で変わらない）");
})().catch((e) => { console.error(e); process.exit(1); });
