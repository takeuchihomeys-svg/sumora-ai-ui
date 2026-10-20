// 送った物件への反応（上過ぎる・狭い・駅から遠い・高い・古い）とメモが、次のピックアップに効いているかを測る（読むだけ・LLM なし・本文は出さない）
// 2026-10-20 竹内（P1 1a57c6db）「AIX ツールはお客さんの反応に反応して判断も変えているかな？」
//
// 測ること（直近 DAYS 日の売上サポの回 property_pickups）:
//   ① 回の時点で、そのお客様に「物差しのある不満」（reaction-negatives・その回より前の反応とメモ）がある回
//   ② その回の物件のうち不満に当たる物（REACTION_*_NG / _HARD）の数・送った物（status=sent）の中で当たる物
//   ③ 点の1位（通す・保留の中で点が一番・今の👑に近い）が当たるか: 今の点 → 反応を入れた点（AIX_REACTIONS_LINK=on と同じ計算・決定論）
//   ④ 条件欄の ng_points の節のうち設備・階の読み取り（parseEquipmentWants）に入らない物（採点に使われていない NG）
// 実行: npx tsx --env-file=.env.local scripts/audit-reactions-link.ts   （DAYS=60）
import { createClient } from "@supabase/supabase-js";
import { parsePropertyFacts } from "../app/lib/property-brain";
import { floorFromRoom, parseEquipmentWants } from "../app/lib/listing-equipment";
import { buildReactionNegatives, reactionCodesFor, reactionRowAdjust, latestNegatives, REACTION_RULE, REACTION_POINTS } from "../app/lib/reaction-negatives";
import { assembleReactionInput, loadReactionRows, propKeyOf } from "../app/lib/reaction-negatives-server";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const DAYS = Number(process.env.DAYS ?? 60);
// SIM_NG=-15 で弱い減点の大きさを変えて当て直す（既定は本番の点）
if (process.env.SIM_NG) for (const c of Object.keys(REACTION_POINTS)) if (c.endsWith("_NG")) REACTION_POINTS[c] = Number(process.env.SIM_NG);
type Row = { id: number; created_at: string; batch_id: string; property_customer_id: string | null; property_name: string; room_no: string | null; summary_text: string | null; verdict: string | null; score: number | null; reason_codes: string[] | null; status: string };

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const rows: Row[] = [];
  for (let p = 0; p < 50; p++) {
    const { data, error } = await sb.from("property_pickups").select("id, created_at, batch_id, property_customer_id, property_name, room_no, summary_text, verdict, score, reason_codes, status")
      .gte("created_at", since).not("property_customer_id", "is", null).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    rows.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  const byCust = new Map<string, Row[]>();
  for (const r of rows) { const k = r.property_customer_id as string; (byCust.get(k) ?? byCust.set(k, []).get(k)!).push(r); }
  console.log(`売上サポの行 ${rows.length}・お客様 ${byCust.size}・回 ${new Set(rows.map((r) => r.batch_id)).size}（${DAYS}日）`);

  const attrCount: Record<string, number> = {}; const scopeCount: Record<string, number> = {};
  let custWithNeg = 0, custWithAnyReaction = 0;
  let batches = 0, batchesWithNeg = 0, batchesViol = 0, rowsInNegBatches = 0, rowsViol = 0, sentInNeg = 0, sentViol = 0;
  let top1ViolBefore = 0, top1ViolAfter = 0, top3ViolBefore = 0, top3ViolAfter = 0, top3N = 0, hardHeld = 0, okUp = 0;
  const violAttr: Record<string, number> = {};
  let k = 0;
  for (const [pc, crs] of byCust) {
    k++;
    const minT = Math.min(...crs.map((r) => Date.parse(r.created_at)));
    const maxT = Math.max(...crs.map((r) => Date.parse(r.created_at)));
    const rx = await loadReactionRows(sb, pc, { sinceIso: new Date(minT - REACTION_RULE.maxAgeDays * 86_400_000).toISOString(), untilIso: new Date(maxT).toISOString() });
    const input = assembleReactionInput(rx);
    const stAll = buildReactionNegatives({ ...input, now: new Date(maxT) });
    if (stAll.negatives.length || Object.keys(stAll.perProperty).length) custWithAnyReaction++;
    if (latestNegatives(stAll.negatives).length) custWithNeg++;
    for (const x of stAll.negatives) { attrCount[x.attr] = (attrCount[x.attr] ?? 0) + 1; scopeCount[`${x.scope}${x.ref == null ? "(物差しなし)" : ""}`] = (scopeCount[`${x.scope}${x.ref == null ? "(物差しなし)" : ""}`] ?? 0) + 1; }
    const byBatch = new Map<string, Row[]>();
    for (const r of crs) (byBatch.get(r.batch_id) ?? byBatch.set(r.batch_id, []).get(r.batch_id)!).push(r);
    for (const [, br] of byBatch) {
      batches++;
      const at = new Date(Math.min(...br.map((r) => Date.parse(r.created_at))) - 1000);
      const st = buildReactionNegatives({ ...input, now: at });
      const negs = latestNegatives(st.negatives);
      if (!negs.length) continue;
      batchesWithNeg++;
      const cand = (r: Row) => {
        const f = parsePropertyFacts(r.summary_text ?? "");
        const pk = propKeyOf(r.property_name, r.room_no);
        return { c: { floor: floorFromRoom(pk.room || f.roomNo || null), rentTotal: f.rentYen != null ? f.rentYen + (f.adminFeeYen ?? 0) : null, areaSqm: f.areaSqm ?? null, walk: f.walkMinutes, age: f.buildingAge }, key: pk.key };
      };
      const viol = (r: Row) => reactionCodesFor(cand(r).c, negs).filter((c) => /_(NG|HARD)$/.test(c));
      let anyViol = false;
      for (const r of br) {
        rowsInNegBatches++;
        const v = viol(r);
        if (v.length) { rowsViol++; anyViol = true; for (const c of v) violAttr[c] = (violAttr[c] ?? 0) + 1; }
        if (r.status === "sent") { sentInNeg++; if (v.length) sentViol++; }
      }
      if (anyViol) batchesViol++;
      // 点の並び（外す候補を除く）: 今の点 → 反応を入れた点
      const open = br.filter((r) => r.verdict !== "drop" && r.score != null);
      if (!open.length) continue;
      const vo = (r: { verdict: string | null }) => (r.verdict === "pass" ? 0 : 1);
      const before = [...open].sort((a, z) => vo(a) - vo(z) || (z.score! - a.score!) || a.id - z.id);
      const adj = open.map((r) => { const c = cand(r); const a = reactionRowAdjust(r, c.c, c.key, { negatives: st.negatives, perProperty: {} }); return { r, score: a.score!, verdict: a.verdict }; });
      for (const a of adj) { if (a.verdict === "hold" && a.r.verdict === "pass") hardHeld++; if (a.score > a.r.score!) okUp++; }
      const after = [...adj].sort((a, z) => vo(a) - vo(z) || (z.score - a.score) || a.r.id - z.r.id).map((x) => x.r);
      if (viol(before[0]).length) top1ViolBefore++;
      if (viol(after[0]).length) top1ViolAfter++;
      const n3 = Math.min(3, open.length); top3N += n3;
      top3ViolBefore += before.slice(0, n3).filter((r) => viol(r).length).length;
      top3ViolAfter += after.slice(0, n3).filter((r) => viol(r).length).length;
    }
    if (k % 20 === 0) process.stderr.write(`.. ${k}/${byCust.size}\n`);
  }
  console.log(`\n■ 反応・メモ（お客様単位・回の期間の終わりの時点）`);
  console.log(`  反応かメモのあるお客様 ${custWithAnyReaction}/${byCust.size}・物差しのある不満があるお客様 ${custWithNeg}`);
  console.log(`  不満の向き`, attrCount, ` 出どころ`, scopeCount);
  console.log(`\n■ 回の時点で物差しのある不満がある回 ${batchesWithNeg}/${batches}`);
  console.log(`  その回の物件 ${rowsInNegBatches} のうち不満に当たる ${rowsViol}（${batchesViol} 回）`, violAttr);
  console.log(`  その回で送った物件 ${sentInNeg} のうち不満に当たる ${sentViol}`);
  console.log(`  点の1位が不満に当たる: 今 ${top1ViolBefore} → 反応を入れると ${top1ViolAfter}（回 ${batchesWithNeg} のうち点のある回）`);
  console.log(`  点の上位3件で不満に当たる: 今 ${top3ViolBefore}/${top3N} → ${top3ViolAfter}/${top3N}`);
  console.log(`  NG と言った不満で通す→保留 ${hardHeld}・解消の加点が付いた ${okUp}`);

  // ④ ng_points の節のうち採点の読み取りに入らない物
  const { data: pcs } = await sb.from("property_customers").select("id, ng_points").in("id", [...byCust.keys()]);
  let withNg = 0, clauses = 0, read = 0, elsewhere = 0, uncovered = 0, other = 0;
  for (const c of (pcs ?? []) as Array<{ id: string; ng_points: string | null }>) {
    if (!c.ng_points?.trim()) continue;
    withNg++;
    const w = parseEquipmentWants({ ng_points: c.ng_points });
    const nWant = new Set(w.wants.map((x) => x.text)).size;
    read += nWant; elsewhere += w.handledElsewhere.length; uncovered += w.uncovered.length; other += w.other.length;
    clauses += nWant + w.handledElsewhere.length + w.uncovered.length + w.other.length;
  }
  console.log(`\n■ 条件欄の ng_points（この期間に売上サポの回があるお客様 ${byCust.size} 人）: 書いてある ${withNg} 人・節 ${clauses}`);
  console.log(`  設備・階の読み取りに入る ${read}・家賃や駅など別の所で見る ${elsewhere}・部屋の条件だが読めない ${uncovered}・その他 ${other}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
