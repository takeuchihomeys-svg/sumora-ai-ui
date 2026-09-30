// scripts/backfill-ad-points.ts
// 2026-09-30 竹内「AD1 で加点高すぎる。AD1 の加点は 0 くらいで、AD1.5 がプラス 10 点、AD2 がプラス 22 点等」:
//   保存済みのピックアップ（property_pickups）の点を今の AD の表（property-brain AD_TIER_POINTS）に付け直す。
//   札（reason_codes）は変えない。点は「保存の点 ＋（今の表の点 − 旧の表の点）」（AD の札の分だけ動かす・他の配点は保存のまま）。
//   判定は pass の行が 40点の線（passLineScore）を割ったら hold（AD1 の +15 が無くなって線を割る行）。保留・外す候補はそのまま。
//   あわせて、まとめ（property_pickup_completions）の 👑 と順位を今の1本の並びで付け直す（backfill-low-ad-rules と同じ）。
// 既定は見るだけ（何も書かない）。書く時は --apply（デプロイの後に1回）。未送信（pending）の行だけ（--all で送信済みも）。
//   npx tsx --env-file=.env.local scripts/backfill-ad-points.ts [--since=2026-09-20] [--apply] [--list] [--all]
import { createClient } from "@supabase/supabase-js";
import { dropDiscountFromRow, reasonPoints, passLineScore, SCORE_MAX, EQUIP_CAP_CODE } from "../app/lib/property-brain";
import { bestRuleTag, overallPoints, type BestCandidateRow } from "../app/lib/pickup-best";
import { rankCompleteGroup } from "../app/lib/pickup-complete";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const APPLY = process.argv.includes("--apply");
const LIST = process.argv.includes("--list");
const ALL = process.argv.includes("--all");
const SINCE = arg("since", "2026-09-20");

/** 2026-09-30 より前の AD の点（9/25 案B＋9/27 の AD 1ヶ月未満）。_HELD（保留の物件の AD）は前も今も 0点 */
const OLD_AD: Record<string, number> = { AD_1M: 15, AD_1_5M: 2, AD_HIGH: 20, AD_2_5M: 0, AD_VERY_HIGH: 0, AD_UNDER_1M: -15, AD_NONE: -20 };
/** 札の点の差（今 − 旧）の合計 */
export function adPointDelta(codes: readonly string[]): number {
  return codes.reduce((s, c) => s + (c in OLD_AD ? reasonPoints(c) - OLD_AD[c] : 0), 0);
}

type Row = BestCandidateRow & { conversation_id: string | null; complete_group_id: string | null; summary_text: string | null; reasons_ja: string[] | null };
const label = (r: Row | undefined | null) => (r ? `#${r.id} ${r.property_name}${r.room_no ? ` ${r.room_no}` : ""}（${r.verdict} ${r.score}${overallPoints(r) !== r.score ? `・合計 ${overallPoints(r)}` : ""}）` : "なし");

async function main() {
  console.log(`${APPLY ? "★書き込む（--apply）" : "見るだけ（--apply で書く）"}・対象 ${SINCE} 以降・${ALL ? "送信済みも" : "未送信だけ"}`);
  const rows: Row[] = [];
  for (let from = 0; ; from += 200) {
    let q = sb.from("property_pickups")
      .select("id, created_at, batch_id, rank, status, recommended, property_name, room_no, verdict, score, reason_codes, reasons_ja, summary_text, conversation_id, complete_group_id, search_override, image_analysis")
      .gte("created_at", SINCE).order("id").range(from, from + 199);
    if (!ALL) q = q.eq("status", "pending");
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 200) break;
  }
  const base = rows.map((r) => { const d = dropDiscountFromRow(r); return (d ? { ...r, score: d.score, verdict: d.verdict, reason_codes: d.reason_codes, reasons_ja: d.reasons_ja } : r) as Row; });
  const changed = new Map<number, { score: number; verdict: string }>();
  let up = 0, down = 0, toHold = 0;
  for (const r of base) {
    const codes = (r.reason_codes ?? []) as string[];
    if (typeof r.score !== "number" || codes.includes(EQUIP_CAP_CODE)) continue;
    const d = adPointDelta(codes);
    if (!d) continue;
    const score = Math.max(0, Math.min(SCORE_MAX, r.score + d));
    const verdict = r.verdict === "pass" && passLineScore(codes, score) < 40 ? "hold" : String(r.verdict);
    if (score === r.score && verdict === r.verdict) continue;
    changed.set(r.id, { score, verdict });
    if (score > r.score) up++; else down++;
    if (verdict !== r.verdict) toHold++;
    if (LIST || verdict !== r.verdict) console.log(`  #${r.id} ${r.property_name}${r.room_no ? ` ${r.room_no}` : ""}: ${r.verdict} ${r.score} → ${verdict} ${score}（${codes.filter((c) => /^AD_/.test(c)).join(",")}）`);
  }
  console.log(`\n■ 行 ${rows.length}: 点が変わる ${changed.size}（上がる ${up}・下がる ${down}・通す→保留 ${toHold}）`);

  // まとめ（完了）の 👑
  const byGroup = new Map<string, Row[]>();
  for (const r of base) if (r.complete_group_id) { const g = byGroup.get(r.complete_group_id) ?? []; g.push(r); byGroup.set(r.complete_group_id, g); }
  const gids = [...byGroup.keys()];
  const comp = new Map<string, { best_id: number | null; result: Record<string, unknown> | null; status: string | null }>();
  for (let i = 0; i < gids.length; i += 100) {
    const { data } = await sb.from("property_pickup_completions").select("group_id, best_id, status, result").in("group_id", gids.slice(i, i + 100));
    for (const c of (data ?? []) as Array<{ group_id: string; best_id: number | null; status: string | null; result: Record<string, unknown> | null }>) comp.set(c.group_id, c);
  }
  let crownChanged = 0;
  const updates: Array<{ gid: string; ranking: ReturnType<typeof rankCompleteGroup>; result: Record<string, unknown> | null }> = [];
  for (const [gid, g] of byGroup) {
    const cp = comp.get(gid);
    if (!cp || cp.status !== "done" || !g.some((r) => changed.has(r.id))) continue;
    const after = g.map((r) => (changed.has(r.id) ? { ...r, ...changed.get(r.id)! } : r));
    const before = cp.best_id != null ? g.find((x) => x.id === Number(cp.best_id)) ?? null : null;
    const ranking = rankCompleteGroup(after, { basis: "score" });
    const nb = ranking.bestId != null ? after.find((r) => r.id === ranking.bestId) ?? null : null;
    if ((before?.id ?? null) !== (nb?.id ?? null)) { crownChanged++; console.log(`  👑 ${gid}（${g.length}件）: ${label(before)} → ${label(nb as Row | null)}`); }
    updates.push({ gid, ranking, result: cp.result });
  }
  console.log(`■ まとめ（完了）: 付け直す ${updates.length} → 👑 が変わる ${crownChanged}`);

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
      result: { ...(u.result ?? {}), basis_rule: bestRuleTag("score"), best_score: u.ranking.bestScore, best_match: u.ranking.bestMatch, best_total: u.ranking.bestTotal, best_bonus: u.ranking.bestBonus, rescored_ad_points_at: new Date().toISOString() },
    }).eq("group_id", u.gid);
    if (e) console.warn(`  ${u.gid} 書けない: ${e.message}`); else okGroups++;
  }
  console.log(`\n★ 書いた: 行 ${okRows}/${changed.size}・まとめ ${okGroups}/${updates.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
