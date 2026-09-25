// scripts/audit-recommendation-gaps.ts
// 🌟（AIX 物件オススメ）の回ごとに「お客様が求めている点」「スタッフが訴求した点」「ブレインの点が高かった物件」を並べ、
// 食い違い（ギャップ）を出す（読むだけ・DB に書かない・LLM を呼ばない）。
//
// 2026-09-25 竹内「候補の記憶を太くする。会話を見たりオススメしている部分を見ればギャップが分かる」
//   正解は「スタッフが選んで送った事実」（memory feedback_property_selection_label）。お客様の返信の有無は使わない。
//
// ■ 測り方
//   ① スタッフの送信で先頭が「🌟物件名」の物（＝AIX 物件オススメ）
//   ② その時点の候補一覧: recommendation_snapshots に行があればそれ、無ければ同じ関数（buildRecommendationSnapshot）で
//      その場で組み立てる（＝同じ会話でお客様に直近72時間に送った物件＋拡張の回・売上サポの行で値を埋めた物）
//   ③ 候補を全部 judgeProperty で点にする。材料は候補の値だけ（🌟の本文から読んだ値は混ぜない＝🌟に有利にしない）。
//      送付済みの減点は入れない（候補は全部お客様に送った物なので、入れると全件が同じだけ下がる）
//   ④ 希望（条件欄＋🌟の前14日のお客様の発言）・訴求（🌟の本文）・事実（候補の値）を同じ話題の語彙で比べる（recommendation-gaps.ts）
//   出力は伏せ字（お客様の呼び名・電話番号）。物件名は出す（お客様の個人情報ではない）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-recommendation-gaps.ts [--days=60] [--until=ISO] [--show=8] [--out=path.json]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { buildCustomerProfile, judgeProperty, parsePropertyFacts, type CustomerLike, type PropertyDataLike } from "../app/lib/property-brain";
import { coverageOf, enrichCandidate, FACT_FIELDS, type CandidateFacts } from "../app/lib/candidate-facts";
import { compareRound, factTopics, maskPersonal, TOPIC_LABEL, type TopicKey, type WantHit } from "../app/lib/recommendation-gaps";
import { buildRecommendationSnapshot, fillPoolFromPickups, type SnapshotRow } from "../app/lib/recommendation-snapshot-server";
import { isGenericBuildingName } from "../app/lib/generic-building-name";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "60"), 10);
const UNTIL = String(args.until ?? new Date().toISOString());
const SHOW = parseInt(String(args.show ?? "8"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = Record<string, any>;
const D = 864e5;

async function all(build: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < 50; p++) {
    const { data, error } = await build(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out = out.concat(data);
    if (data.length < 1000) break;
  }
  return out;
}
async function pmap<T, R>(xs: T[], n: number, f: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < xs.length) { const i = next++; out[i] = await f(xs[i], i); } }));
  return out;
}
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
const CUST_COLS = "id, rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet, move_in_time, created_at, floor_area_min, raw_format_text";

/** 候補の値 → judgeProperty の材料（候補の値だけ） */
function factsForJudge(c: CandidateFacts) {
  const data: PropertyDataLike = {
    rank: typeof c.rank === "number" ? c.rank : null, name: c.name ?? null, rent: c.rent ?? null, floor_plan: c.floor_plan ?? null, walk_minutes: c.walk_minutes ?? null,
    ad_months: c.ad_months ?? null, ad_yen: c.ad_yen ?? null, deposit_months: c.deposit_months ?? null, key_money_months: c.key_money_months ?? null,
  };
  const f = parsePropertyFacts(`【1】${c.name ?? "物件"}${c.room_no ? ` ${c.room_no}号室` : ""}`, data);
  f.adminFeeYen = c.admin_fee_yen ?? null;
  f.buildingAge = c.building_age ?? null;
  if (c.area_sqm != null) f.areaSqm = c.area_sqm;
  return f;
}
const RICH = ["rent", "walk_minutes", "deposit_months", "building_age"] as const;
const richness = (c: CandidateFacts) => RICH.filter((k) => c[k] != null).length;

async function main() {
  const until = new Date(UNTIL).getTime();
  const since = new Date(until - DAYS * D).toISOString();
  const untilIso = new Date(until).toISOString();

  // ── A. 候補の記録の太さ（拡張の回・この期間）: 元のまま → 太くした後（生の文字）→ 売上サポの行で埋めた後
  const pools = await all((a, b) => sb.from("property_candidate_pools").select("id, site, sent_at, property_customer_id, candidates, facts_version").gte("sent_at", since).lt("sent_at", untilIso).order("sent_at").range(a, b) as never);
  const pickups = await all((a, b) => sb.from("property_pickups").select("id, batch_id, created_at, rank, property_name, room_no, summary_text, pdf_text, pdf_url, pdf_blob_url, recommended, property_customer_id, site").gte("created_at", new Date(until - (DAYS + 1) * D).toISOString()).lt("created_at", untilIso).range(a, b) as never);
  const pkByCust = new Map<string, Row[]>();
  for (const p of pickups) { const k = String(p.property_customer_id ?? ""); if (!pkByCust.has(k)) pkByCust.set(k, []); pkByCust.get(k)!.push(p); }
  const rawC: CandidateFacts[] = [], enrC: CandidateFacts[] = [], pkC: CandidateFacts[] = [];
  let poolsWithPickup = 0;
  const bySite: Record<string, { raw: CandidateFacts[]; enr: CandidateFacts[] }> = {};
  for (const p of pools) {
    const cands = (Array.isArray(p.candidates) ? p.candidates : []) as Row[];
    const site = String(p.site ?? "?");
    bySite[site] ??= { raw: [], enr: [] };
    for (const c of cands) { rawC.push(c as CandidateFacts); bySite[site].raw.push(c as CandidateFacts); const e = enrichCandidate(c, { now: p.sent_at }); enrC.push(e); bySite[site].enr.push(e); }
    const r = fillPoolFromPickups({ sent_at: p.sent_at, candidates: cands }, pkByCust.get(String(p.property_customer_id ?? "")) ?? []);
    if (r.batch) poolsWithPickup++;
    pkC.push(...r.candidates);
  }
  const covRaw = coverageOf(rawC), covEnr = coverageOf(enrC), covPk = coverageOf(pkC);
  console.log(`\n=== A. 候補の記録（拡張の回）${since.slice(0, 10)}〜${untilIso.slice(0, 10)}: ${pools.length}回・${rawC.length}件（売上サポの行と結べた回 ${poolsWithPickup}）`);
  console.log("項目".padEnd(18) + "元のまま".padStart(9) + "太くした後".padStart(10) + "＋売上サポ".padStart(10));
  for (const f of FACT_FIELDS) console.log(f.padEnd(18) + pct(covRaw[f] * rawC.length, rawC.length).padStart(9) + pct(covEnr[f] * enrC.length, enrC.length).padStart(10) + pct(covPk[f] * pkC.length, pkC.length).padStart(10));
  for (const [s, v] of Object.entries(bySite)) {
    const cr = coverageOf(v.raw);
    console.log(`  [${s}] ${v.raw.length}件: 家賃 ${pct(cr.rent * v.raw.length, v.raw.length)}・管理費 ${pct(cr.admin_fee_yen * v.raw.length, v.raw.length)}（うち家賃と同じ値＝読み違い ${v.raw.filter((c) => c.admin_fee_yen != null && c.admin_fee_yen === c.rent).length}）・徒歩 ${pct(cr.walk_minutes * v.raw.length, v.raw.length)}・AD ${pct(cr.ad_months_or_yen * v.raw.length, v.raw.length)}・敷金 ${pct(cr.deposit_months * v.raw.length, v.raw.length)}・築 ${pct(cr.building_age * v.raw.length, v.raw.length)}`);
  }

  // ── B. 🌟の回
  const msgs = await all((a, b) => sb.from("messages").select("id, conversation_id, text, created_at").eq("sender", "staff").like("text", "🌟%")
    .gte("created_at", since).lt("created_at", untilIso).order("created_at").range(a, b) as never);
  const snaps = await all((a, b) => sb.from("recommendation_snapshots").select("*").gte("sent_at", since).lt("sent_at", untilIso).range(a, b) as never);
  console.log(`\n=== B. 🌟の送信 ${msgs.length}通（記録済みの候補一覧 ${snaps.length}行・無い回はその場で組み立て）`);
  const rounds = (await pmap(msgs, 6, async (m) => {
    const head = String(m.text ?? "").split("\n")[0].replace(/^🌟\s*/u, "").trim();
    if (!head || isGenericBuildingName(head)) return null;
    const saved = snaps.find((s) => s.message_id === m.id || (s.conversation_id === m.conversation_id && Math.abs(Date.parse(s.sent_at) - Date.parse(m.created_at)) < 120_000));
    const snap = (saved as SnapshotRow | undefined) ?? await buildRecommendationSnapshot(sb as never, { conversationId: m.conversation_id, sentAt: m.created_at, starText: String(m.text), messageId: m.id, source: "backfill" });
    return snap ? { m, snap, saved: !!saved } : null;
  })).filter(Boolean) as Array<{ m: Row; snap: SnapshotRow; saved: boolean }>;

  const custIds = [...new Set(rounds.map((r) => r.snap.property_customer_id).filter(Boolean) as string[])];
  const custs = new Map<string, Row>();
  for (let i = 0; i < custIds.length; i += 80) {
    const { data } = await sb.from("property_customers").select(CUST_COLS).in("id", custIds.slice(i, i + 80));
    for (const r of (data ?? []) as Row[]) custs.set(r.id, r);
  }

  let withCust = 0, multi = 0, starIn = 0, evaluated = 0, top1 = 0, top3 = 0, rand1 = 0, rand3 = 0, relSum = 0, allTied = 0;
  const richRel: Record<string, { n: number; rel: number; top1: number }> = {};
  const appealCnt: Partial<Record<TopicKey, number>> = {}, wantCnt: Partial<Record<TopicKey, number>> = {}, wantAppealed: Partial<Record<TopicKey, number>> = {};
  const blindCnt: Partial<Record<TopicKey, number>> = {}, seenCnt: Partial<Record<TopicKey, number>> = {};
  const starOnlyCnt: Partial<Record<TopicKey, number>> = {}, topOnlyCnt: Partial<Record<TopicKey, number>> = {};
  const inc = (o: Partial<Record<TopicKey, number>>, k: TopicKey) => { o[k] = (o[k] ?? 0) + 1; };
  const starCandAll: CandidateFacts[] = [], otherCandAll: CandidateFacts[] = [];
  let topDiffers = 0, topDiffNoFact = 0;
  // 2026-09-20 から送った画像を読んで送付記録に残すようになった（sent-image-record）。それより前は候補一覧がほぼ作れない
  const RECENT = Date.parse(String(args.recent ?? "2026-09-20T00:00:00Z"));
  const rc = { rounds: 0, starIn: 0, evaluated: 0, top1: 0, rel: 0, rand1: 0 };
  const recentCands: CandidateFacts[] = [];
  const shows: string[] = [];
  const perRound: Row[] = [];

  for (const { m, snap } of rounds) {
    const cust = snap.property_customer_id ? custs.get(snap.property_customer_id) : null;
    if (snap.star_in_candidates) starIn++;
    const recent = Date.parse(snap.sent_at) >= RECENT;
    if (recent) { rc.rounds++; if (snap.star_in_candidates) rc.starIn++; recentCands.push(...snap.candidates); }
    for (const c of snap.candidates) (c.is_star ? starCandAll : otherCandAll).push(c);
    const wants = (snap.customer_wants ?? []) as WantHit[];
    for (const a of snap.appeal_topics ?? []) inc(appealCnt, a);
    for (const w of wants) { inc(wantCnt, w.key); if ((snap.appeal_topics ?? []).includes(w.key)) inc(wantAppealed, w.key); }
    if (!cust) continue;
    withCust++;
    const prof = buildCustomerProfile(cust as CustomerLike, [], [], null, { today: snap.sent_at });
    const fprof = { rentMax: (cust.rent_max ?? cust.max_rent) as number | null, walkMax: cust.walk_minutes as number | null, ageMax: cust.building_age as number | null, sqmMin: cust.floor_area_min as number | null };
    const scored = snap.candidates.map((c, i) => ({ facts: c as CandidateFacts, isStar: !!c.is_star, score: judgeProperty(factsForJudge(c), prof, i, { today: snap.sent_at }).score }));
    const g = compareRound({ starText: snap.star_text, wants, candidates: scored, profile: fprof });
    for (const k of g.appealBlind) inc(blindCnt, k);
    for (const k of g.appealSeen) inc(seenCnt, k);
    if (scored.length >= 2 && g.starPos != null) {
      multi++;
      evaluated++;
      const n = scored.length;
      if (g.starPos === 1) top1++;
      if (g.starPos <= 3) top3++;
      rand1 += 1 / n; rand3 += Math.min(3, n) / n;
      const rel = (g.starPos - 1) / (n - 1);
      relSum += rel;
      if (recent) { rc.evaluated++; rc.rel += rel; rc.rand1 += 1 / n; if (g.starPos === 1) rc.top1++; }
      if (new Set(scored.map((s) => s.score)).size === 1) allTied++;
      const rich = Math.round(scored.reduce((a, s) => a + richness(s.facts), 0) / n);
      const rk = `材料${rich}/4`;
      richRel[rk] ??= { n: 0, rel: 0, top1: 0 };
      richRel[rk].n++; richRel[rk].rel += rel; if (g.starPos === 1) richRel[rk].top1++;
      if (g.top) {
        topDiffers++;
        if (!g.top.starOnly.length && !g.top.topOnly.length) topDiffNoFact++;
        for (const k of g.top.starOnly) inc(starOnlyCnt, k);
        for (const k of g.top.topOnly) inc(topOnlyCnt, k);
      }
      perRound.push({ at: snap.sent_at, n, starPos: g.starPos, rel: +rel.toFixed(3), starScore: g.starScore, topScore: g.topScore, appeals: g.appeals, wants: wants.map((w) => w.key), wantedNotAppealed: g.wantedNotAppealed, appealBlind: g.appealBlind, top: g.top ? { starOnly: g.top.starOnly, topOnly: g.top.topOnly } : null });
      if (shows.length < SHOW && (g.top || g.wantedNotAppealed.length)) {
        const star = scored.find((s) => s.isStar)!;
        const fmt = (c: CandidateFacts) => `家賃${c.rent ?? "?"}${c.admin_fee_yen != null ? `+${c.admin_fee_yen}` : ""} ${c.floor_plan ?? "?"} ${c.area_sqm ?? "?"}㎡ 徒歩${c.walk_minutes ?? "?"} 敷${c.deposit_months ?? "?"}礼${c.key_money_months ?? "?"} 築${c.building_age ?? "?"} AD${c.ad_months ?? (c.ad_yen != null ? `${c.ad_yen}円` : "?")} [${Object.values(c.src ?? {}).filter((v, i, a) => a.indexOf(v) === i).join(",")}]`;
        shows.push([
          `■ ${snap.sent_at.slice(0, 16)} 候補${n} 🌟${g.starPos}位（${g.starScore}点・最高${g.topScore}）${snap.star_in_candidates ? "" : " ※🌟は直近の送付に無い"}`,
          `  希望: ${wants.map((w) => `${TOPIC_LABEL[w.key]}(${w.from === "messages" ? "発言" : w.from === "free_text" ? "自由文" : "条件"})`).join("・") || "なし"}`,
          `  訴求: ${g.appeals.map((k) => TOPIC_LABEL[k]).join("・") || "なし"}`,
          `  求めたのに訴求なし: ${g.wantedNotAppealed.map((k) => TOPIC_LABEL[k]).join("・") || "なし"}／訴求したがブレインに見えない: ${g.appealBlind.map((k) => TOPIC_LABEL[k]).join("・") || "なし"}`,
          `  🌟 ${star.facts.name} ${fmt(star.facts)}`,
          g.top ? `  一番 ${g.top.name}（${g.top.score}点） 🌟だけ:${g.top.starOnly.map((k) => TOPIC_LABEL[k]).join("・") || "なし"} 一番だけ:${g.top.topOnly.map((k) => TOPIC_LABEL[k]).join("・") || "なし"}` : "  一番 = 🌟",
          `  本文: ${maskPersonal(snap.star_text.split("\n").slice(1).join(" ").replace(/\s+/g, " ")).slice(0, 160)}`,
        ].join("\n"));
      }
    }
    void m;
  }

  console.log(`🌟の回 ${rounds.length}（物件顧客あり ${withCust}・🌟が直近72時間の送付の中にある ${starIn}=${pct(starIn, rounds.length)}）`);
  console.log(`候補2件以上で点を比べた回 ${evaluated}: 🌟が1位 ${pct(top1, evaluated)}（でたらめ ${pct(rand1, evaluated)}）・3位以内 ${pct(top3, evaluated)}（でたらめ ${pct(rand3, evaluated)}）・相対順位の平均 ${(relSum / Math.max(1, evaluated)).toFixed(3)}（0=1位・でたらめ0.5）・全部同点 ${allTied}`);
  const rcov = coverageOf(recentCands);
  console.log(`  うち ${new Date(RECENT).toISOString().slice(0, 10)} 以降 ${rc.rounds}回: 🌟が直近の送付の中 ${pct(rc.starIn, rc.rounds)}・点を比べた ${rc.evaluated}回 🌟1位 ${pct(rc.top1, rc.evaluated)}（でたらめ ${pct(rc.rand1, rc.evaluated)}）・相対順位 ${(rc.rel / Math.max(1, rc.evaluated)).toFixed(3)}`);
  console.log(`     候補 ${recentCands.length}件の値: 家賃 ${pct(rcov.rent * recentCands.length, recentCands.length)}・管理費 ${pct(rcov.admin_fee_yen * recentCands.length, recentCands.length)}・敷金 ${pct(rcov.deposit_months * recentCands.length, recentCands.length)}・間取り ${pct(rcov.floor_plan * recentCands.length, recentCands.length)}・㎡ ${pct(rcov.area_sqm * recentCands.length, recentCands.length)}・徒歩 ${pct(rcov.walk_minutes * recentCands.length, recentCands.length)}・築 ${pct(rcov.building_age * recentCands.length, recentCands.length)}・AD ${pct(rcov.ad_months_or_yen * recentCands.length, recentCands.length)}`);
  for (const [k, v] of Object.entries(richRel).sort()) console.log(`   ${k}: ${v.n}回 相対順位 ${(v.rel / v.n).toFixed(3)}・1位 ${pct(v.top1, v.n)}`);

  const cs = coverageOf(starCandAll), co = coverageOf(otherCandAll);
  console.log(`\n=== C. 🌟の時点の候補の値（🌟 ${starCandAll.length}件／他 ${otherCandAll.length}件）`);
  for (const f of FACT_FIELDS) console.log(`  ${f.padEnd(18)} 🌟 ${pct(cs[f] * starCandAll.length, starCandAll.length).padStart(6)}  他 ${pct(co[f] * otherCandAll.length, otherCandAll.length).padStart(6)}`);
  // 🌟の本文には書いてある（スタッフは知っている）のに、候補の値（ブレインの材料）には無い項目
  const stf = rounds.map((r) => (r.snap.star_text_facts ?? {}) as CandidateFacts);
  const cst = coverageOf(stf);
  console.log(`  ― 🌟の本文から読めた値（参考・点には使わない）: 家賃 ${pct(cst.rent * stf.length, stf.length)}・管理費 ${pct(cst.admin_fee_yen * stf.length, stf.length)}・敷礼 ${pct(cst.deposit_months * stf.length, stf.length)}・間取り ${pct(cst.floor_plan * stf.length, stf.length)}・㎡ ${pct(cst.area_sqm * stf.length, stf.length)}・駅徒歩 ${pct(cst.walk_minutes * stf.length, stf.length)}・築 ${pct(Math.max(cst.built_ym, cst.building_age) * stf.length, stf.length)}・設備 ${pct(cst.equipment * stf.length, stf.length)}`);
  const srcCnt: Record<string, number> = {};
  for (const c of [...starCandAll, ...otherCandAll]) for (const v of new Set(Object.values(c.src ?? {}))) srcCnt[v] = (srcCnt[v] ?? 0) + 1;
  console.log(`  出どころ（件数）: ${Object.entries(srcCnt).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);

  const keys = Object.keys(TOPIC_LABEL) as TopicKey[];
  console.log(`\n=== D. 話題ごと（${rounds.length}回）: 訴求した回・希望があった回・希望があって訴求した率・訴求したが🌟の値でブレインに見えない率`);
  for (const k of keys.sort((a, b) => (appealCnt[b] ?? 0) + (wantCnt[b] ?? 0) - (appealCnt[a] ?? 0) - (wantCnt[a] ?? 0))) {
    const a = appealCnt[k] ?? 0, w = wantCnt[k] ?? 0;
    if (!a && !w) continue;
    const bl = blindCnt[k] ?? 0, se = seenCnt[k] ?? 0;
    console.log(`  ${TOPIC_LABEL[k].padEnd(10)} 訴求 ${String(a).padStart(4)}  希望 ${String(w).padStart(4)}  希望→訴求 ${pct(wantAppealed[k] ?? 0, w).padStart(6)}  ${bl + se ? `見えない ${pct(bl, bl + se)}` : ""}`);
  }
  console.log(`\n=== E. ブレインの一番が🌟でない回 ${topDiffers}/${evaluated}: 🌟だけが満たす話題（スタッフが選んだ理由の候補）／一番だけが満たす話題（ブレインが重く見た物）`);
  console.log(`  🌟だけ: ${Object.entries(starOnlyCnt).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${TOPIC_LABEL[k as TopicKey]} ${v}`).join("・") || "なし"}`);
  console.log(`  一番だけ: ${Object.entries(topOnlyCnt).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${TOPIC_LABEL[k as TopicKey]} ${v}`).join("・") || "なし"}`);
  console.log(`  事実の話題で差が無い（家賃・AD・間取りの点差だけ）: ${topDiffNoFact}`);
  if (shows.length) console.log(`\n=== F. 回の例（${shows.length}）\n${shows.join("\n\n")}`);

  if (args.out) writeFileSync(String(args.out), JSON.stringify({ since, until: untilIso, coverage: { raw: covRaw, enriched: covEnr, withPickups: covPk }, rounds: perRound }, null, 1));
  void factTopics;
}
main().catch((e) => { console.error(e); process.exit(1); });
