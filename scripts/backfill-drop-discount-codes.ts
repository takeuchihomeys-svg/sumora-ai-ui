// scripts/backfill-drop-discount-codes.ts
// 2026-09-27 竹内「割引が AD より大きいとあるが、AD はこっち側で自由に変えられるものやから、そこは影響しない」:
//   保存済みのピックアップ（property_pickups）に残る割引と AD の比べの札（PROFIT_NEGATIVE −10・保留／AD_COVERS_DISCOUNT 0点）を外し、
//   点・判定・理由を付け直す（property-brain.rejudgeWithoutDiscount・純関数）。あわせて、画面と同じ1本の並び（判定の点 → 画像の点）で
//   まとめ（property_pickup_completions）の 👑 と順位を付け直す。
// 既定は見るだけ（何も書かない）。書く時は --apply（デプロイの後に1回）。
//   npx tsx --env-file=.env.local scripts/backfill-drop-discount-codes.ts [--since=2026-09-20] [--apply] [--list]
// 出す物: 変わる行の数・保留→通すの数・まとめごとの 👑 の変化（前: まとめの best_id／無ければ前の決まり・後: 新しい決まり）・順位の入れ替わり
import { createClient } from "@supabase/supabase-js";
import { dropDiscountFromRow } from "../app/lib/property-brain";
import { NEW_ARRIVAL_WINDOW_HOURS } from "../app/lib/new-arrivals";
import { applyActiveScoringWeights } from "../app/lib/scoring-learning-server";
import { pickCustomerBest, verdictOrder, bestRuleTag, type BestCandidateRow } from "../app/lib/pickup-best";
import { rankCompleteGroup, COMPLETE_BEST_WINDOW_HOURS } from "../app/lib/pickup-complete";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const APPLY = process.argv.includes("--apply");
const LIST = process.argv.includes("--list");
const SINCE = arg("since", "2026-09-01");

type Row = BestCandidateRow & { property_customer_id: string | null; complete_group_id: string | null; summary_text: string | null; reason_codes: string[] | null; reasons_ja: string[] | null; room_no: string | null; search_override?: unknown };

/** 前の決まり（2026-09-27 より前）: 判定の点 → 判定 → 🌟 → 新しい回 → 順位（画像の点は見ない） */
function oldBest(rows: Row[]): Row | null {
  const c = rows.filter((r) => r.status === "pending" && typeof r.score === "number" && r.verdict !== "drop");
  c.sort((a, z) => ((z.score as number) - (a.score as number)) || (verdictOrder(a) - verdictOrder(z)) || (z.recommended - a.recommended)
    || (Date.parse(z.created_at) - Date.parse(a.created_at)) || (a.rank - z.rank) || (a.id - z.id));
  return c[0] ?? null;
}
const label = (r: Row | undefined | null) => (r ? `#${r.id} ${r.property_name}${r.room_no ? ` ${r.room_no}` : ""}（${r.verdict} ${r.score}）` : "なし");

async function main() {
  const w = await applyActiveScoringWeights(sb as never);
  console.log(`重みの版: ${w.version || "定数"}・${APPLY ? "★書き込む（--apply）" : "見るだけ（--apply で書く）"}・対象 ${SINCE} 以降`);
  const { data, error } = await sb.from("property_pickups")
    .select("id, created_at, batch_id, rank, status, recommended, property_name, room_no, verdict, score, reason_codes, reasons_ja, summary_text, property_customer_id, complete_group_id, search_override, image_analysis, seen_at, expired_at")
    .gte("created_at", SINCE).order("id").limit(5000);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Row[];
  const changed = new Map<number, { score: number; verdict: string; reason_codes: string[]; reasons_ja: string[] }>();
  let holdToPass = 0, stillHold = 0, pointsOnly = 0, newArrivalUp = 0;
  for (const r of rows) {
    // 付け直す前の画面（/api/property-pickups の詳細）と同じ純関数（property-brain.dropDiscountFromRow）。
    //   点は「保存の点 ＋ 札の差」・AD_COVERS_DISCOUNT（0点の知らせ）だけの行は札と理由の一文を外すだけ（点・判定は保存のまま）
    const d = dropDiscountFromRow(r);
    if (!d) continue;
    const neg = d.negative;
    const verdict = d.verdict;
    changed.set(r.id, { score: d.score, verdict, reason_codes: d.reason_codes, reasons_ja: d.reasons_ja });
    if (!neg) pointsOnly++;
    else if (r.verdict === "hold" && verdict === "pass") {
      holdToPass++;
      // 新着物件の数（new-arrivals: 通す・未送信・まだ見ていない・72時間以内）に新しく入る行
      const x = r as Row & { seen_at?: string | null; expired_at?: string | null };
      if (r.status === "pending" && !x.seen_at && !x.expired_at && Date.now() - Date.parse(r.created_at) < NEW_ARRIVAL_WINDOW_HOURS * 3600_000) newArrivalUp++;
    }
    else stillHold++;
    const ns = changed.get(r.id)!.score;
    if (LIST || r.verdict !== verdict || r.score !== ns) console.log(`  #${r.id} ${r.property_name}${r.room_no ? ` ${r.room_no}` : ""}: ${r.verdict} ${r.score} → ${verdict} ${ns}${neg ? "（割引＞AD の保留を外した）" : "（まかなえるの知らせを外しただけ）"}`);
  }
  const pn = rows.filter((r) => (r.reason_codes ?? []).includes("PROFIT_NEGATIVE")).length;
  console.log(`\n■ 行: ${rows.length}行中 割引の比べの札あり ${changed.size}行（PROFIT_NEGATIVE ${pn}行）→ 割引＞AD の保留だった行: 保留→通す ${holdToPass}・ほかの理由で保留のまま ${stillHold}／まかなえるの知らせを外すだけ（点・判定そのまま）${pointsOnly}`);
  console.log(`  うち新着物件の数（通す・未送信・未読・${NEW_ARRIVAL_WINDOW_HOURS}時間以内）に新しく入る: ${newArrivalUp}行（--apply で一覧の新着の数がこの分増える）`);

  // まとめ（complete_group_id）ごと・まとめの無い行はお客様×回の時刻で寄せず batch_id ごと
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = r.complete_group_id ?? `batch:${r.batch_id}`;
    const g = groups.get(k) ?? []; g.push(r); groups.set(k, g);
  }
  const gids = [...groups.keys()].filter((k) => !k.startsWith("batch:"));
  const comp = new Map<string, { best_id: number | null; result: Record<string, unknown> | null }>();
  for (let i = 0; i < gids.length; i += 100) {
    const { data: cs } = await sb.from("property_pickup_completions").select("group_id, best_id, result").in("group_id", gids.slice(i, i + 100));
    for (const c of (cs ?? []) as Array<{ group_id: string; best_id: number | null; result: Record<string, unknown> | null }>) comp.set(c.group_id, { best_id: c.best_id, result: c.result });
  }
  let crownChanged = 0, crownSame = 0, groupsTouched = 0, orderChanged = 0, crownByImageOnly = 0, crownByDiscount = 0;
  const updates: Array<{ gid: string; ranking: ReturnType<typeof rankCompleteGroup>; result: Record<string, unknown> | null }> = [];
  for (const [k, g] of groups) {
    const touched = g.some((r) => changed.has(r.id));
    const after = g.map((r) => (changed.has(r.id) ? { ...r, ...changed.get(r.id)! } : r));
    const cp = comp.get(k);
    const before = cp?.best_id != null ? g.find((r) => r.id === Number(cp.best_id) && r.status === "pending") ?? oldBest(g) : oldBest(g);
    const newBest = pickCustomerBest(after, { basis: "score", windowHours: COMPLETE_BEST_WINDOW_HOURS });
    const oldNewRule = pickCustomerBest(g, { basis: "score", windowHours: COMPLETE_BEST_WINDOW_HOURS });
    if (!touched && (before?.id ?? null) === (newBest?.id ?? null)) continue;
    if (touched) groupsTouched++;
    // 順位（まとめの順位の上から5件）が変わったか
    const oldOrder = rankCompleteGroup(g, { basis: "score" }).order.slice(0, 5).map((o) => o.id).join(",");
    const newRank = rankCompleteGroup(after, { basis: "score" });
    if (oldOrder !== newRank.order.slice(0, 5).map((o) => o.id).join(",")) orderChanged++;
    const same = (before?.id ?? null) === (newBest?.id ?? null);
    if (same) crownSame++; else {
      crownChanged++;
      // 何で変わったか: 割引の比べを外した点で変わった／新しい並び（同じ点は画像の点）・前の決まりのまとめの best_id を使わなくなったことで変わった
      const byDiscount = (oldNewRule?.id ?? null) !== (newBest?.id ?? null);
      if (byDiscount) crownByDiscount++; else crownByImageOnly++;
      const nb = after.find((r) => r.id === newBest?.id);
      console.log(`  👑 ${k}（${g.length}件・${byDiscount ? "割引＞AD の保留を外したので" : "並びの決まり（判定の点 → 画像の点）で並べ直したので"}）: ${label(before)} → ${label(nb)}`);
    }
    if (!k.startsWith("batch:") && cp) updates.push({ gid: k, ranking: newRank, result: cp.result });
  }
  console.log(`\n■ まとめ・回: ${groups.size}（割引の比べの札がある ${groupsTouched}）→ 👑 が変わる ${crownChanged}（割引＞AD を外したので ${crownByDiscount}・並びの決まり／前の版のまとめの best_id を使わないので ${crownByImageOnly}）・同じ ${crownSame}・上から5件の順位が変わる ${orderChanged}`);

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
      result: { ...(u.result ?? {}), basis_rule: bestRuleTag("score"), best_score: u.ranking.bestScore, best_match: u.ranking.bestMatch, rejudged_without_discount_at: new Date().toISOString() },
    }).eq("group_id", u.gid);
    if (e) console.warn(`  ${u.gid} 書けない: ${e.message}`); else okGroups++;
  }
  console.log(`\n★ 書いた: 行 ${okRows}/${changed.size}・まとめ ${okGroups}/${updates.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
