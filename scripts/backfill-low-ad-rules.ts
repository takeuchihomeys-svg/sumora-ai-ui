// scripts/backfill-low-ad-rules.ts
// 2026-09-27 竹内「スコアリング AD 1ヶ月未満の物件は点数かなり落とす／しかし元付業者が株式会社アズ・スタットの場合は例外／
//   株式会社アズ・スタットは AD 記載なくても基本的に 200% あるから 200% とみなす」:
//   保存済みのピックアップ（property_pickups）に今の決まりを当てる（property-brain.applyAdRulesToRow・純関数）。
//     ① AD 1ヶ月未満（AD_UNDER_1M −8→−15）・AD なし（AD_NONE −10→−20）を保留に（AD の段・ピンポイントは 0点・全部合うを外す）
//     ② AD 不明（AD_UNKNOWN）で資料の元付業者がアズ・スタット → AD 200%（AD_ASSUMED_AGENT＋AD_HIGH +20）
//   あわせて、まとめ（property_pickup_completions）の 👑 と順位を今の1本の並び（合計＝判定の点＋画像の加点）で付け直す。
// 既定は見るだけ（何も書かない）。書く時は --apply（デプロイの後に1回）。
//   npx tsx --env-file=.env.local scripts/backfill-low-ad-rules.ts [--since=2026-09-01] [--apply] [--list]
import { createClient } from "@supabase/supabase-js";
import { applyAdRulesToRow, dropDiscountFromRow } from "../app/lib/property-brain";
import { applyActiveScoringWeights } from "../app/lib/scoring-learning-server";
import { bestRuleTag, overallPoints, type BestCandidateRow } from "../app/lib/pickup-best";
import { rankCompleteGroup } from "../app/lib/pickup-complete";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const APPLY = process.argv.includes("--apply");
const LIST = process.argv.includes("--list");
const SINCE = arg("since", "2026-09-01");
const YUMA_CONV = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

type Row = BestCandidateRow & { conversation_id: string | null; complete_group_id: string | null; summary_text: string | null; reasons_ja: string[] | null; pdf_text: string | null };
const label = (r: Row | undefined | null) => (r ? `#${r.id} ${r.property_name}${r.room_no ? ` ${r.room_no}` : ""}（${r.verdict} ${r.score}${overallPoints(r) !== r.score ? `・合計 ${overallPoints(r)}` : ""}）` : "なし");

async function main() {
  const w = await applyActiveScoringWeights(sb as never);
  console.log(`重みの版: ${w.version || "定数"}・${APPLY ? "★書き込む（--apply）" : "見るだけ（--apply で書く）"}・対象 ${SINCE} 以降`);
  const rows: Row[] = [];
  for (let from = 0; ; from += 200) {
    const { data, error } = await sb.from("property_pickups")
      .select("id, created_at, batch_id, rank, status, recommended, property_name, room_no, verdict, score, reason_codes, reasons_ja, summary_text, pdf_text, conversation_id, complete_group_id, search_override, image_analysis")
      .gte("created_at", SINCE).order("id").range(from, from + 199);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 200) break;
  }
  // 画面と同じ読み出し（割引と AD の比べの札を外した後）に当てる
  const base = rows.map((r) => { const d = dropDiscountFromRow(r); return (d ? { ...r, score: d.score, verdict: d.verdict, reason_codes: d.reason_codes, reasons_ja: d.reasons_ja } : r) as Row; });
  const changed = new Map<number, { score: number; verdict: string; reason_codes: string[]; reasons_ja: string[] }>();
  let lowAd = 0, lowPassToHold = 0, az = 0, azRows = 0, azUp = 0;
  const azRe = /ア[ \t　]*ズ[ \t　]*[・･]?[ \t　]*ス[ \t　]*タ[ \t　]*ッ[ \t　]*ト|az-stat\.com/i;
  for (const r of base) {
    if (azRe.test(r.pdf_text ?? "")) azRows++;
    const x = applyAdRulesToRow(r);
    if (!x) continue;
    changed.set(r.id, { score: x.score, verdict: x.verdict, reason_codes: x.reason_codes, reasons_ja: x.reasons_ja });
    if (x.change === "low_ad") { lowAd++; if (r.verdict === "pass" && x.verdict === "hold") lowPassToHold++; }
    else { az++; if (x.score > (r.score ?? 0)) azUp++; }
    if (LIST || r.verdict !== x.verdict || r.score !== x.score) console.log(`  #${r.id} ${r.property_name}${r.room_no ? ` ${r.room_no}` : ""}: ${r.verdict} ${r.score} → ${x.verdict} ${x.score}（${x.change === "low_ad" ? "AD 1ヶ月未満・なし" : "アズ・スタット AD 200%"}${r.conversation_id === YUMA_CONV ? "・YUMA" : ""}）`);
  }
  console.log(`\n■ 行 ${rows.length}: AD 1ヶ月未満・なしの行 ${lowAd}（通す→保留 ${lowPassToHold}）／資料にアズ・スタットがある行 ${azRows}（AD 不明→200% に付け直す ${az}・点が上がる ${azUp}）`);

  // まとめ（完了）の 👑
  const byGroup = new Map<string, Row[]>();
  for (const r of base) if (r.complete_group_id) { const g = byGroup.get(r.complete_group_id) ?? []; g.push(r); byGroup.set(r.complete_group_id, g); }
  const gids = [...byGroup.keys()];
  const comp = new Map<string, { best_id: number | null; result: Record<string, unknown> | null; status: string | null }>();
  for (let i = 0; i < gids.length; i += 100) {
    const { data } = await sb.from("property_pickup_completions").select("group_id, best_id, status, result").in("group_id", gids.slice(i, i + 100));
    for (const c of (data ?? []) as Array<{ group_id: string; best_id: number | null; status: string | null; result: Record<string, unknown> | null }>) comp.set(c.group_id, c);
  }
  let crownChanged = 0, touched = 0, yumaChanged = 0;
  const updates: Array<{ gid: string; ranking: ReturnType<typeof rankCompleteGroup>; result: Record<string, unknown> | null }> = [];
  for (const [gid, g] of byGroup) {
    const cp = comp.get(gid);
    if (!cp || cp.status !== "done") continue;
    const hit = g.some((r) => changed.has(r.id));
    const after = g.map((r) => (changed.has(r.id) ? { ...r, ...changed.get(r.id)! } : r));
    const before = pickBefore(g, cp.best_id);
    const ranking = rankCompleteGroup(after, { basis: "score" });
    const nb = ranking.bestId != null ? after.find((r) => r.id === ranking.bestId) ?? null : null;
    if (!hit && (before?.id ?? null) === (nb?.id ?? null)) continue;
    if (hit) touched++;
    if ((before?.id ?? null) !== (nb?.id ?? null)) {
      crownChanged++;
      const yuma = g.some((r) => r.conversation_id === YUMA_CONV);
      if (yuma) yumaChanged++;
      console.log(`  👑 ${gid}（${g.length}件${yuma ? "・YUMA" : ""}）: ${label(before)} → ${label(nb)}`);
    }
    if (hit) updates.push({ gid, ranking, result: cp.result });
  }
  console.log(`\n■ まとめ（完了）: 付け直す行があるまとめ ${touched} → 👑 が変わる ${crownChanged}（うち YUMA ${yumaChanged}）`);

  if (!APPLY) { console.log("\n（見るだけ。書く時は --apply）"); return; }
  let okRows = 0;
  for (const [id, v] of changed) {
    const { error: e } = await sb.from("property_pickups").update(v).eq("id", id);
    if (e) console.warn(`  #${id} 書けない: ${e.message}`); else okRows++;
  }
  let okGroups = 0;
  for (const u of updates) {
    await Promise.allSettled(u.ranking.order.map((o) => sb.from("property_pickups").update({ complete_rank: o.complete_rank }).eq("id", o.id).eq("complete_group_id", u.gid)));
    const { error: e } = await sb.from("property_pickup_completions").update({
      best_id: u.ranking.bestId, best_basis: u.ranking.bestBasis,
      result: { ...(u.result ?? {}), basis_rule: bestRuleTag("score"), best_score: u.ranking.bestScore, best_match: u.ranking.bestMatch, best_total: u.ranking.bestTotal, best_bonus: u.ranking.bestBonus, rejudged_low_ad_at: new Date().toISOString() },
    }).eq("group_id", u.gid);
    if (e) console.warn(`  ${u.gid} 書けない: ${e.message}`); else okGroups++;
  }
  console.log(`\n★ 書いた: 行 ${okRows}/${changed.size}・まとめ ${okGroups}/${updates.length}`);
}

/** 今の 👑（まとめの best_id・無ければ今の決まりで付け直す前の行から） */
function pickBefore(g: Row[], bestId: number | null): Row | null {
  if (bestId != null) { const r = g.find((x) => x.id === Number(bestId) && x.status === "pending"); if (r) return r; }
  const rk = rankCompleteGroup(g, { basis: "score" });
  return rk.bestId != null ? g.find((x) => x.id === rk.bestId) ?? null : null;
}
main().catch((e) => { console.error(e); process.exit(1); });
