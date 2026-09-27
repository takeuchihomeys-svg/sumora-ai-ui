// scripts/backfill-image-bonus-crowns.ts
// 2026-09-27 竹内「ここは合わせる」: 👑 と順位の決まりを版 b（合計＝判定の点＋画像の加点・pickup-best.compareOverall／BEST_RULE_TAG）に上げた。
//   前の版のまとめ（property_pickup_completions.result.basis_rule が違う物）は、画面・一覧では best_id を使わず並べ直す（書き直す前でも画面は新しい決まり）。
//   この道具は、まとめの 👑（best_id・best_basis）と行の順位（property_pickups.complete_rank）を新しい決まりで付け直す。
//   行の点・判定（score・verdict・reason_codes）は書き換えない（画像の加点は読み出す時に毎回出す＝判定の札が変わっても食い違わない）。
// 既定は見るだけ（何も書かない）。書く時は --apply（デプロイの後に1回）。
//   npx tsx --env-file=.env.local scripts/backfill-image-bonus-crowns.ts [--since=2026-09-20] [--apply] [--list]
// 出す物: まとめごとの 👑 の変化（前: まとめの best_id → 後: 新しい決まり）・合計と画像の加点・上から5件の順位の入れ替わり
import { createClient } from "@supabase/supabase-js";
import { dropDiscountFromRow } from "../app/lib/property-brain";
import { applyActiveScoringWeights } from "../app/lib/scoring-learning-server";
import { bestRuleTag, BEST_RULE_TAG, overallPoints, imageBonusPoints, type BestCandidateRow } from "../app/lib/pickup-best";
import { rankCompleteGroup } from "../app/lib/pickup-complete";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const APPLY = process.argv.includes("--apply");
const LIST = process.argv.includes("--list");
const SINCE = arg("since", "2026-09-01");
/** YUMA（竹内さんのテスト用の会話） */
const YUMA_CONV = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

type Row = BestCandidateRow & { conversation_id: string | null; complete_group_id: string | null; summary_text: string | null; reasons_ja: string[] | null; site?: string | null };

const label = (r: Row | undefined | null) => {
  if (!r) return "なし";
  const b = imageBonusPoints(r);
  return `#${r.id} ${r.property_name}${r.room_no ? ` ${r.room_no}` : ""}（${r.verdict} 判定 ${r.score}${b != null ? `・画像 ${b >= 0 ? "+" : ""}${b}＝合計 ${overallPoints(r)}` : "・画像なし"}）`;
};

async function main() {
  const w = await applyActiveScoringWeights(sb as never);
  console.log(`重みの版: ${w.version || "定数"}・決まり ${BEST_RULE_TAG}・${APPLY ? "★書き込む（--apply）" : "見るだけ（--apply で書く）"}・対象 ${SINCE} 以降`);
  const { data: comps, error: ce } = await sb.from("property_pickup_completions").select("group_id, best_id, best_basis, status, result").gte("created_at", SINCE).limit(2000);
  if (ce) throw new Error(ce.message);
  const done = ((comps ?? []) as Array<{ group_id: string; best_id: number | null; best_basis: string | null; status: string | null; result: Record<string, unknown> | null }>).filter((c) => c.status === "done");
  let same = 0, changed = 0, alreadyNew = 0, orderChanged = 0, yumaChanged = 0, yumaGroups = 0;
  const updates: Array<{ gid: string; ranking: ReturnType<typeof rankCompleteGroup>; result: Record<string, unknown> | null }> = [];
  for (const c of done) {
    if (c.result?.basis_rule === BEST_RULE_TAG) { alreadyNew++; continue; }
    const { data, error } = await sb.from("property_pickups")
      .select("id, created_at, batch_id, site, rank, status, recommended, property_name, room_no, verdict, score, image_analysis, search_override, reason_codes, reasons_ja, summary_text, conversation_id, complete_group_id")
      .eq("complete_group_id", c.group_id).limit(500);
    if (error) { console.warn(`  ${c.group_id} 読めない: ${error.message}`); continue; }
    // 割引と AD の比べの札を外した点・判定・札（まとめの付け直しと同じ・pickup-complete-server）
    const rows = ((data ?? []) as Row[]).map((r) => { const d = dropDiscountFromRow(r); return (d ? { ...r, score: d.score, verdict: d.verdict, reason_codes: d.reason_codes } : r) as Row; });
    if (!rows.length) continue;
    const isYuma = rows.some((r) => r.conversation_id === YUMA_CONV);
    if (isYuma) yumaGroups++;
    const before = c.best_id != null ? rows.find((r) => r.id === Number(c.best_id)) ?? null : null;
    const ranking = rankCompleteGroup(rows, { basis: "score" });
    const after = ranking.bestId != null ? rows.find((r) => r.id === ranking.bestId) ?? null : null;
    // 前の版（判定の点 → 同じ点なら画像の点）の並び＝希望の一覧を外して加点を出さない形で同じ関数に当てる
    const oldTop = rankCompleteGroup(rows.map((r) => ({ ...r, image_analysis: r.image_analysis ? { ...r.image_analysis, wants: undefined } : null })), { basis: "score" }).order.slice(0, 5).map((o) => o.id).join(",");
    if (oldTop !== ranking.order.slice(0, 5).map((o) => o.id).join(",")) orderChanged++;
    const isSame = (before?.id ?? null) === (after?.id ?? null);
    if (isSame) same++; else { changed++; if (isYuma) yumaChanged++; }
    if (!isSame || LIST) console.log(`  ${isSame ? "＝" : "👑"} ${c.group_id}（${rows.length}件${isYuma ? "・YUMA" : ""}）: ${label(before)} → ${label(after)}`);
    updates.push({ gid: c.group_id, ranking, result: c.result });
  }
  console.log(`\n■ まとめ（完了）${done.length}: 新しい決まりで書き済み ${alreadyNew}・付け直す ${updates.length} → 👑 が変わる ${changed}（うち YUMA ${yumaChanged}/${yumaGroups}）・同じ ${same}・上から5件が画像の加点で入れ替わる ${orderChanged}`);
  if (!APPLY) { console.log("\n（見るだけ。書く時は --apply）"); return; }
  let ok = 0;
  for (const u of updates) {
    await Promise.allSettled(u.ranking.order.map((o) => sb.from("property_pickups").update({ complete_rank: o.complete_rank }).eq("id", o.id).eq("complete_group_id", u.gid)));
    const { error: e } = await sb.from("property_pickup_completions").update({
      best_id: u.ranking.bestId, best_basis: u.ranking.bestBasis,
      result: { ...(u.result ?? {}), basis_rule: bestRuleTag("score"), best_score: u.ranking.bestScore, best_match: u.ranking.bestMatch, best_total: u.ranking.bestTotal, best_bonus: u.ranking.bestBonus, rerank_image_bonus_at: new Date().toISOString() },
    }).eq("group_id", u.gid);
    if (e) console.warn(`  ${u.gid} 書けない: ${e.message}`); else ok++;
  }
  console.log(`\n★ 書いた: まとめ ${ok}/${updates.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
