// scripts/audit-star-soft-hold.ts
// 2026-10-06e 竹内さん「あっている」: 保留の理由が初期費用だけ（INITIAL_COST_NOT_ZERO）で AD が高い行を🌟（👑）の候補に入れる — AD の線（1.5 か 2）をデータで選ぶ（読むだけ・LLM なし・費用0・DB に書かない）。
//   本番と同じ関数（pickup-best.pickCustomerBest の softHoldAdLine）で当て直す。
//   1) スタッフの🌟に結べた回（recommendation_snapshots → 前72時間の売上サポの行・audit-star-two-axis-pickups と同じ組み方）: 線なし（06d）／1／1.5／2 の 1位一致・新だけ当たり／旧だけ当たり・
//      「誤って入る」＝線で入った保留の行が 👑 になったがスタッフの🌟ではない回
//   2) 全部のお客様の束（🌟の記録の有無に関わらず・お客様×6時間の窓）: 線ごとに 👑 が保留の行へ移った回の数（正解は分からない＝入る量の目安）と移った先の AD
//   3) 🌟が保留の行だった回の中身（目で読む）
// ■ 正解はスタッフが🌟にした事実・個人情報は出さない（物件名は出す）・YUMA は外す
// 実行: npx tsx --env-file=.env.local scripts/audit-star-soft-hold.ts [--days=60] [--show=12]
import { createClient } from "@supabase/supabase-js";
import { nameKey, bestBuildingMatch, toHalf } from "../app/lib/candidate-facts";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";
import { starSituationFromConditions, STAR_SITUATION_COLUMNS, initialCostOnlyHold, adMonthsOfPickup } from "../app/lib/star-rank-pickup";
import { pickCustomerBest, type BestCandidateRow } from "../app/lib/pickup-best";
import { listingDealStatus } from "../app/lib/listing-deal-status";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "60"), 10);
const SHOW = parseInt(String(args.show ?? "12"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
type Row = Record<string, any>;
const D = 864e5, H = 36e5;
const pct = (a: number, n: number) => (n ? `${Math.round((a / n) * 100)}%` : "-");
const chunks = <T,>(xs: T[], n: number) => { const o: T[][] = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o; };
const normRoom = (r: unknown) => toHalf(String(r ?? "")).replace(/[^0-9A-Za-z]/g, "").replace(/^0+(?=\d)/, "");
async function all(build: (a: number, b: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>, page = 500): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < 400; p++) { const { data, error } = await build(p * page, p * page + page - 1); if (error) throw new Error(error.message); if (!data?.length) break; out = out.concat(data); if (data.length < page) break; }
  return out;
}
const COLS = "id, batch_id, property_customer_id, conversation_id, created_at, rank, status, sent_at, recommended, property_name, room_no, verdict, score, reason_codes, image_analysis, terms, summary_text, ad_yen, equipment, search_override";
const LINES: Array<[string, number | null]> = [["線なし（06d）", null], ["線 1", 1], ["線 1.5", 1.5], ["線 2", 2], ["線 2.5", 2.5]];

(async () => {
  const until = Date.now();
  const picks = await all((a, b) => sb.from("property_pickups").select(COLS).gte("created_at", new Date(until - (DAYS + 5) * D).toISOString()).order("id").range(a, b) as never);
  const allPicks = picks.filter((r) => r.conversation_id !== YUMA_CONVERSATION_ID);
  const snaps = (await all((a, b) => sb.from("recommendation_snapshots").select("id, conversation_id, property_customer_id, sent_at, star_name, star_room, source")
    .gte("sent_at", new Date(until - DAYS * D).toISOString()).not("star_name", "is", null).order("id").range(a, b) as never)).filter((s) => s.conversation_id !== YUMA_CONVERSATION_ID && s.property_customer_id);
  const pcs = [...new Set(allPicks.map((r) => String(r.property_customer_id ?? "")).filter(Boolean))];
  const custs = new Map<string, Row>();
  for (const c of chunks(pcs, 80)) { const { data } = await sb.from("property_customers").select(`id, ${STAR_SITUATION_COLUMNS}`).in("id", c); for (const r of (data ?? []) as Row[]) custs.set(String(r.id), r); }
  const pkOf = new Map<string, Row[]>(); for (const r of allPicks) { const k = String(r.property_customer_id ?? ""); if (!k) continue; if (!pkOf.has(k)) pkOf.set(k, []); pkOf.get(k)!.push(r); }
  const P = (...x: unknown[]) => console.log(...x);
  const asPending = (rs: Row[]): BestCandidateRow[] => rs.map((r) => ({ ...r, status: "pending" }) as BestCandidateRow);
  const best = (rs: Row[], pc: string, line: number | null) => pickCustomerBest(asPending(rs), { basis: "score", windowHours: 24 * 365, situation: starSituationFromConditions(custs.get(pc) as never), softHoldAdLine: line });
  const soft = (r: Row) => initialCostOnlyHold(r as never);
  const adOf = (r: Row) => adMonthsOfPickup(r as never);

  // 保留の行の内訳（全体）
  const holds = allPicks.filter((r) => r.verdict === "hold");
  const softRows = holds.filter(soft);
  const adBand = (v: number | null) => (v == null ? "不明" : v < 1 ? "<1" : v < 1.5 ? "1" : v < 2 ? "1.5" : v < 2.5 ? "2" : "2.5+");
  const bandCount = (rs: Row[]) => { const m: Record<string, number> = {}; for (const r of rs) { const k = adBand(adOf(r)); m[k] = (m[k] ?? 0) + 1; } return ["不明", "<1", "1", "1.5", "2", "2.5+"].map((k) => `${k}:${m[k] ?? 0}`).join(" "); };
  const initOnlyByCode = holds.filter((r) => { const c = (r.reason_codes ?? []) as string[]; return c.includes("INITIAL_COST_NOT_ZERO"); });
  P(`=== 0. ${DAYS}日の売上サポの行 ${allPicks.length}・保留 ${holds.length}（INITIAL_COST_NOT_ZERO の札あり ${initOnlyByCode.length}）・うち理由が初期費用だけ ${softRows.length}（AD の帯 ${bandCount(softRows)}）`);
  const sentAll = allPicks.filter((r) => r.status === "sent" || r.sent_at);
  P(`   送った行 ${sentAll.length}: 初期費用だけの保留 ${sentAll.filter(soft).length}（AD の帯 ${bandCount(sentAll.filter(soft))}）・他の保留 ${sentAll.filter((r) => r.verdict === "hold" && !soft(r)).length}・通す ${sentAll.filter((r) => r.verdict !== "hold").length}（AD の帯 ${bandCount(sentAll.filter((r) => r.verdict !== "hold"))}）`);

  // 1) スタッフの🌟に結べた回
  const dedupe = (rs: Row[]) => { const seen = new Set<string>(); return rs.filter((r) => { const k = `${nameKey(r.property_name)}#${normRoom(r.room_no)}`; if (seen.has(k)) return false; seen.add(k); return true; }); };
  const candOf = (rs: Row[]) => dedupe(rs.filter((r) => r.verdict !== "drop" && typeof r.score === "number" && listingDealStatus({ evidenceMoveIn: r.terms?.evidence?.moveIn ?? null }) == null));
  type Ep = { at: string; pc: string; star: Row; pool: Row[] };
  const eps: Ep[] = [];
  for (const s of snaps) {
    const t = Date.parse(s.sent_at); const pc = String(s.property_customer_id);
    const rows = (pkOf.get(pc) ?? []).filter((r) => Date.parse(r.created_at) <= t + 60_000 && Date.parse(r.created_at) >= t - 72 * H);
    if (!rows.length) continue;
    const star = bestBuildingMatch(String(s.star_name), s.star_room ?? null, rows, (r: Row) => r.property_name, (r: Row) => r.room_no);
    if (!star) continue;
    // 👑 の候補と同じ: 外す候補・審査中／商談中を除く・点がある行
    const pool = candOf(rows);
    if (!pool.some((r) => r.id === star.id)) pool.push(star);
    if (pool.length < 2) continue;
    eps.push({ at: s.sent_at, pc, star, pool });
  }
  eps.sort((a, b) => a.at.localeCompare(b.at));
  const cut = Math.floor(eps.length * 0.7);
  P(`\n=== 1. スタッフの🌟に結べた回 ${eps.length}（前7割 ${cut}・後3割 ${eps.length - cut}）・🌟が初期費用だけの保留 ${eps.filter((e) => soft(e.star)).length}（AD ${eps.filter((e) => soft(e.star)).map((e) => adOf(e.star) ?? "?").join("・")}）・🌟が他の保留 ${eps.filter((e) => e.star.verdict === "hold" && !soft(e.star)).length}`);
  P(`   束に初期費用だけの保留がある回 ${eps.filter((e) => e.pool.some(soft)).length}・その行の AD の帯 ${bandCount(eps.flatMap((e) => e.pool.filter(soft)))}`);
  const base = eps.map((e) => best(e.pool, e.pc, null)?.id ?? null);
  for (const [name, line] of LINES) {
    let tr = 0, te = 0, on = 0, oo = 0, wrongIn = 0, rightIn = 0, admittedNotStar = 0;
    eps.forEach((e, i) => {
      const b = best(e.pool, e.pc, line); const id = b?.id ?? null; const hit = id === e.star.id, hit0 = base[i] === e.star.id;
      if (hit) { if (i < cut) tr++; else te++; }
      if (hit && !hit0) on++;
      if (hit0 && !hit) oo++;
      const pickedHold = !!b && e.pool.some((r) => r.id === id && r.verdict === "hold") && e.pool.some((r) => r.verdict !== "hold");
      if (pickedHold) { if (hit) rightIn++; else wrongIn++; }
      if (line != null) admittedNotStar += e.pool.filter((r) => r.id !== e.star.id && soft(r) && (adOf(r) ?? -1) >= line).length;
    });
    P(`  ${name.padEnd(12)} 前7割 ${pct(tr, cut)}(${tr}/${cut}) ／ 後3割 ${pct(te, eps.length - cut)}(${te}/${eps.length - cut}) ／ 全体 ${pct(tr + te, eps.length)} ・ 新だけ当たり ${on}／旧だけ当たり ${oo} ・ 保留の行が 👑: 🌟と同じ ${rightIn}・違う（誤って入る）${wrongIn} ・ 候補に入った🌟でない保留の行 ${admittedNotStar}`);
  }

  // 2) 全部のお客様の束（お客様×6時間の窓）
  const windows: Array<{ pc: string; rows: Row[] }> = [];
  for (const [pc, rs] of pkOf) {
    const sorted = rs.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    let cur: Row[] = [];
    for (const r of sorted) { if (cur.length && Date.parse(r.created_at) - Date.parse(cur[0].created_at) > 6 * H) { windows.push({ pc, rows: cur }); cur = []; } cur.push(r); }
    if (cur.length) windows.push({ pc, rows: cur });
  }
  const W = windows.map((w) => ({ ...w, rows: candOf(w.rows) })).filter((w) => w.rows.length >= 2);
  P(`\n=== 2. 全部のお客様の束 ${W.length}（お客様×6時間・候補2件以上）: 線ごとに 👑 が初期費用だけの保留の行へ移った回（正解は分からない＝入る量）`);
  const w0 = W.map((w) => best(w.rows, w.pc, null)?.id ?? null);
  const flips: Record<string, Row[]> = {};
  for (const [name, line] of LINES) {
    if (line == null) continue;
    const moved: Row[] = []; let open = 0;
    W.forEach((w, i) => {
      const b = best(w.rows, w.pc, line);
      if (w.rows.some((r) => soft(r) && (adOf(r) ?? -1) >= line)) open++;
      if (b && b.id !== w0[i]) { const r = w.rows.find((x) => x.id === b.id)!; moved.push({ ...r, __from: w.rows.find((x) => x.id === w0[i]), __reasons: b.star_reasons }); }
    });
    flips[name] = moved;
    P(`  ${name.padEnd(8)} 入れる行がある束 ${open}・👑 が変わった ${moved.length}（移った先の AD の帯 ${bandCount(moved)}）`);
  }
  const extra15 = (flips["線 1.5"] ?? []).filter((r) => !(flips["線 2"] ?? []).some((x) => x.id === r.id));
  P(`  線 1.5 だけで変わる回 ${extra15.length}（AD1.5〜2未満の保留が 👑 に）`);
  const desc = (r: Row) => `${r.property_name} ${r.room_no ?? ""}（${r.verdict}・AD${adOf(r)}・${r.score}点・敷${r.terms?.deposit ?? "?"}礼${r.terms?.keyMoney ?? "?"}）`;
  for (const r of extra15.slice(0, SHOW)) P(`    ${String(r.created_at).slice(0, 10)} → ${desc(r)} ← 前の 👑 ${r.__from ? desc(r.__from) : "-"}`);
  P(`  線 2 で変わる回の中身（目で読む）`);
  for (const r of (flips["線 2"] ?? []).slice(0, SHOW)) P(`    ${String(r.created_at).slice(0, 10)} → ${desc(r)} ← 前の 👑 ${r.__from ? desc(r.__from) : "-"}\n       理由: ${(r.__reasons ?? []).join("・")}`);

  // 3) 🌟が保留の行だった回
  P(`\n=== 3. 🌟が保留の行だった回（目で読む）`);
  for (const e of eps.filter((x) => x.star.verdict === "hold")) {
    const b06 = best(e.pool, e.pc, null), b2 = best(e.pool, e.pc, 2), b15 = best(e.pool, e.pc, 1.5);
    const nm = (id: number | null | undefined) => { const r = e.pool.find((x) => x.id === id); return r ? `${r.property_name} ${r.room_no ?? ""}` : "-"; };
    P(`  ${e.at.slice(0, 10)} 🌟 ${desc(e.star)}（${soft(e.star) ? "初期費用だけの保留" : "他の保留"}・札 ${((e.star.reason_codes ?? []) as string[]).filter((c) => /INITIAL|ZERO|AD_|RENT_OVER|NG$/.test(c)).join(",")}）・束 ${e.pool.length}（通す ${e.pool.filter((r) => r.verdict !== "hold").length}）`);
    P(`     06d → ${nm(b06?.id)} ／ 線2 → ${nm(b2?.id)}${b2?.id === e.star.id ? " ✓" : ""} ／ 線1.5 → ${nm(b15?.id)}${b15?.id === e.star.id ? " ✓" : ""}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
