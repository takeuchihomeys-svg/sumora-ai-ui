// scripts/audit-ad-hold-line.ts
// 「保留の札がある物件が AD だけで通す物件より上に来ない」の線を実データで決めるための監査（読むだけ・DB に書かない・LLM を呼ばない）。
//   audit-star-rank.ts と同じ材料（🌟の送信 → その回の候補プール → judgeProperty）で、AD の段の点の扱いを4通りに変えて🌟の順位を比べ、
//   「保留の物件が AD の点だけで回の1位（通す物件より上）になる回」を数える。
//   V0 そのまま ／ V1 保留の物件は AD の段の点を 0 ／ V2 保留の物件は半分 ／ V3 判定の順（通す＞保留＞外す）を点より先
//   npx tsx --env-file=.env.local scripts/audit-ad-hold-line.ts --until=2026-09-25T12:00:00Z [--days=365]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import {
  buildCustomerProfile, judgeProperty, parsePropertyFacts, normalizeFloorPlanToken, normalizeBuildingName,
  type CustomerLike, type SentRowLike, type PatternRowLike, type PropertyDataLike,
} from "../app/lib/property-brain";
import { isGenericBuildingName } from "../app/lib/generic-building-name";
import { reasonPoints } from "../app/lib/property-brain";
const AD_TIER = new Set(["AD_1M", "AD_1_5M", "AD_HIGH", "AD_2_5M", "AD_VERY_HIGH"]);
const adPts = (codes: string[]) => codes.filter((c) => AD_TIER.has(c)).reduce((a, c) => a + reasonPoints(c), 0);
const variants = ["V0", "V1", "V2", "V3"] as const;
const vScore = (v: string, j: { score: number; verdict: string; reasonCodes: string[] }) => { const held = j.verdict !== "pass"; if (v === "V1" && held) return j.score - adPts(j.reasonCodes); if (v === "V2" && held) return j.score - adPts(j.reasonCodes) / 2; if (v === "V3") return (j.verdict === "pass" ? 1000 : j.verdict === "hold" ? 500 : 0) + j.score; return j.score; };
const vm: Record<string, { rel: number; top1: number; top3: number; n: number; holdTopByAd: number; starHoldTop: number }> = Object.fromEntries(variants.map((v) => [v, { rel: 0, top1: 0, top3: 0, n: 0, holdTopByAd: 0, starHoldTop: 0 }]));
const holdStarCases: string[] = [];
const starAdHold: Array<number | null> = [], starAdPass: Array<number | null> = [];
const adDist = (xs: Array<number | null>) => { const k = xs.filter((x): x is number => x != null && x <= 12); const q = (f: (x: number) => boolean) => `${(100 * k.filter(f).length / Math.max(1, k.length)).toFixed(0)}%`; const sorted = [...k].sort((a, b) => a - b); return `件 ${xs.length}・AD 分かる ${k.length}・中央 ${sorted.length ? sorted[Math.floor(sorted.length / 2)] : "-"}・2ヶ月以上 ${q((x) => x >= 2)}・3ヶ月以上 ${q((x) => x >= 3)}・1ヶ月未満 ${q((x) => x < 1)}`; };

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a, "1"]; }));
const DAYS = parseInt(String(args.days ?? "90"), 10);
const UNTIL = String(args.until ?? new Date().toISOString());
const SHOW = parseInt(String(args.show ?? "0"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

type Row = Record<string, any>;
const H = 3600_000, D = 24 * H;

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
function chunks<T>(xs: T[], n = 150): T[][] { const o: T[][] = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o; }

const toHalf = (s: string) => s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
/** 「グランコート 201号室」→ 建物と号室 */
function splitRoom(name: string): { building: string; room: string } {
  const s = toHalf(name).trim();
  const m = s.match(/[\s　]*(\d{1,4})\s*号室?\s*$/) ?? s.match(/[\s　]+(\d{1,4})$/);
  if (!m) return { building: s, room: "" };
  return { building: s.slice(0, m.index ?? 0).trim(), room: m[1].replace(/^0+(?=\d)/, "") };
}
const key = (name: string) => normalizeBuildingName(splitRoom(name).building).replace(/[・･\-‐ー－]/g, "");
function sameBuilding(a: string, b: string): boolean {
  const x = key(a), y = key(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 5 && (x.includes(y) || y.includes(x));
}

/** 🌟の本文から物件の値を読む（④ 誤保留の数え方・任務B と同じ材料） */
function factsFromStarText(text: string, name: string) {
  const t = toHalf(text).replace(/,/g, "");
  const total = t.match(/(?:合計|管理費込み?|管理費共益費込み?|総額)[^\d]{0,6}(\d{5,6})円/);
  const rent = t.match(/家賃\s*(\d{5,6})円/);
  const adm = t.match(/(?:管理費|共益費)\s*(\d{3,5})円/);
  const walk = t.match(/徒歩\s*(\d{1,2})\s*分/);
  const plan = normalizeFloorPlanToken(t.replace(/\d{5,6}円/g, ""));
  const ageY = t.match(/築\s*(\d{1,2})\s*年/);
  const built = t.match(/(20\d{2}|19\d{2})年(?:\d{1,2}月)?築/);
  const newB = /新築/.test(t);
  const age = ageY ? parseInt(ageY[1], 10) : built ? Math.max(0, 2026 - parseInt(built[1], 10)) : newB ? 0 : null;
  const zero = /敷金礼金(?:なし|0|ゼロ|無し)|敷礼(?:なし|0|ゼロ)|敷金・礼金(?:なし|0)|礼金敷金(?:なし|0)/.test(t);
  const rentYen = total ? parseInt(total[1], 10) : rent ? parseInt(rent[1], 10) : null;
  const adminFeeYen = total ? 0 : adm ? parseInt(adm[1], 10) : null;
  const f = parsePropertyFacts(`【1】${name}`, { rent: rentYen, floor_plan: plan, walk_minutes: walk ? parseInt(walk[1], 10) : null });
  f.adminFeeYen = adminFeeYen;
  f.buildingAge = age;
  if (zero) { f.depositMonths = 0; f.keyMoneyMonths = 0; }
  return f;
}

async function main() {
  const until = new Date(UNTIL).getTime();
  const since = new Date(until - DAYS * D).toISOString();
  const untilIso = new Date(until).toISOString();

  // ① 🌟の送信
  const msgs = await all((a, b) => sb.from("messages").select("id, conversation_id, text, created_at").eq("sender", "staff").like("text", "🌟%")
    .gte("created_at", since).lt("created_at", untilIso).order("created_at").range(a, b) as never);
  const convIds = [...new Set(msgs.map((m) => m.conversation_id as string))];
  const convCust = new Map<string, string>();
  for (const c of chunks(convIds)) {
    const { data } = await sb.from("conversations").select("id, property_customer_id").in("id", c);
    for (const r of (data ?? []) as Row[]) if (r.property_customer_id) convCust.set(r.id, r.property_customer_id);
  }
  const custIds = [...new Set([...convCust.values()])];
  const custs = new Map<string, CustomerLike>();
  const pools: Row[] = [], sents: Row[] = [], pats: Row[] = [];
  const poolSince = new Date(until - (DAYS + 14) * D).toISOString();
  const sentSince = new Date(until - (DAYS + 200) * D).toISOString();
  for (const c of chunks(custIds, 60)) {
    const { data } = await sb.from("property_customers").select("id, rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet, move_in_time, created_at, floor_area_min, raw_format_text").in("id", c);
    for (const r of (data ?? []) as Row[]) custs.set(r.id, r as CustomerLike);
    pools.push(...await all((a, b) => sb.from("property_candidate_pools").select("id, property_customer_id, site, candidates, sent_at").in("property_customer_id", c).gte("sent_at", poolSince).lt("sent_at", untilIso).range(a, b) as never));
    sents.push(...await all((a, b) => sb.from("sent_properties").select("property_customer_id, property_name, room_no, rent, delivery, source, sent_at, ad_months").in("property_customer_id", c).gte("sent_at", sentSince).lt("sent_at", untilIso).range(a, b) as never));
    pats.push(...await all((a, b) => sb.from("property_selection_patterns").select("property_customer_id, selling_points, selection_label, created_at").in("property_customer_id", c).lt("created_at", untilIso).range(a, b) as never));
  }
  const byCust = <T extends Row>(xs: T[]) => { const m = new Map<string, T[]>(); for (const x of xs) { const k = x.property_customer_id; if (!m.has(k)) m.set(k, []); m.get(k)!.push(x); } return m; };
  const poolsOf = byCust(pools), sentsOf = byCust(sents), patsOf = byCust(pats);
  for (const ps of poolsOf.values()) ps.sort((a, z) => Date.parse(z.sent_at) - Date.parse(a.sent_at));

  let starMsgs = 0, withCust = 0, matched = 0, evaluated = 0;
  let top1Tie = 0, top1Unique = 0, top3Avg = 0, randTop1 = 0, randTop3 = 0, relSum = 0, allTied = 0, extTop1 = 0, extTop3 = 0;
  let starAlreadySent = 0, starAlreadySentOther = 0, starSameRoom = 0, starDrop = 0, starHold = 0;
  const flagCounts: Record<string, number> = {};
  let flagged = 0, textJudged = 0;
  const shows: string[] = [];
  const perStar: Array<{ msg: string; n: number; pos: number; rel: number; score: number; max: number; adKnown: boolean; allAdKnown: boolean }> = [];

  for (const m of msgs) {
    const first = String(m.text ?? "").split("\n")[0].replace(/^🌟\s*/u, "").trim();
    if (!first || isGenericBuildingName(first)) continue;
    starMsgs++;
    const pc = convCust.get(m.conversation_id);
    const cust = pc ? custs.get(pc) : null;
    if (!pc || !cust) continue;
    withCust++;
    const t = Date.parse(m.created_at);
    const custSent = sentsOf.get(pc) ?? [];
    const custPats = patsOf.get(pc) ?? [];

    // ④ 🌟の本文の値で判定（送付済みの照合は入れない＝条件の線だけを見る）
    {
      const prof = buildCustomerProfile(cust, [], custPats.filter((p) => Date.parse(p.created_at) < t) as PatternRowLike[], null, { today: m.created_at });
      const j = judgeProperty(factsFromStarText(String(m.text), first), prof, 0, { today: m.created_at });
      textJudged++;
      if (j.flagCodes.length) { flagged++; for (const c of j.flagCodes) flagCounts[c] = (flagCounts[c] ?? 0) + 1; }
      // 🌟の AD（同じお客様への送付記録・同じ建物・前後2日）: 保留の🌟と通す🌟で AD の分布を比べる（スタッフが条件外を AD で選んでいるか）
      const sr = custSent.find((x) => x.property_name && sameBuilding(String(x.property_name), first) && Math.abs(Date.parse(x.sent_at) - t) <= 2 * D && x.ad_months != null);
      // 送付記録に無ければ、その回の候補プール（14日前〜送信時）の同じ建物の AD
      let adm: number | null = sr ? Number(sr.ad_months) : null;
      if (adm == null) {
        for (const p of poolsOf.get(pc) ?? []) {
          const ts = Date.parse(p.sent_at); if (ts > t || ts < t - 14 * D) continue;
          const cs = ((typeof p.candidates === "string" ? JSON.parse(p.candidates) : p.candidates) ?? []) as Row[];
          const hit = cs.find((c) => c.name && sameBuilding(String(c.name), first) && (c.ad_months != null || (c.ad_yen != null && c.rent)));
          if (hit) { adm = hit.ad_months != null ? Number(hit.ad_months) : Number(hit.ad_yen) / Number(hit.rent); break; }
        }
      }
      const bucket = j.flagCodes.length ? starAdHold : starAdPass;
      bucket.push(adm);
    }

    // ② その回
    const pool = (poolsOf.get(pc) ?? []).find((p) => {
      const ts = Date.parse(p.sent_at);
      if (ts > t || ts < t - 14 * D) return false;
      const cands = (typeof p.candidates === "string" ? JSON.parse(p.candidates) : p.candidates) as Row[];
      return (cands ?? []).some((c) => c.name && !isGenericBuildingName(c.name) && sameBuilding(c.name, first));
    });
    if (!pool) continue;
    matched++;
    const rawCands = ((typeof pool.candidates === "string" ? JSON.parse(pool.candidates) : pool.candidates) ?? []) as Row[];
    const seen = new Set<number>();
    const cands = rawCands.filter((c) => c.name && !seen.has(c.rank) && (seen.add(c.rank), true));
    if (cands.length < 2) continue;
    const pt = Date.parse(pool.sent_at);
    // 同じ回のグループ共有（拡張の送付記録）から 家賃・号室（同じ名前が1行だけの時）
    const session = custSent.filter((s) => Math.abs(Date.parse(s.sent_at) - pt) <= 15 * 60_000 && (s.delivery === "shared" || s.source === "line_group"));
    const before = custSent.filter((s) => Date.parse(s.sent_at) < pt - 15 * 60_000) as SentRowLike[];
    const prof = buildCustomerProfile(cust, before, custPats.filter((p) => Date.parse(p.created_at) < pt) as PatternRowLike[], null, { today: pool.sent_at });
    const starSplit = splitRoom(first);
    const judged = cands.map((c, i) => {
      const hits = session.filter((s) => s.property_name && sameBuilding(s.property_name, c.name));
      const one = hits.length === 1 ? hits[0] : null;
      const isStar = sameBuilding(c.name, first);
      // 🌟の物件は本文の号室を使う（同じ建物の部屋違いがあっても🌟の部屋）
      const room = isStar && starSplit.room ? starSplit.room : one?.room_no ? String(one.room_no) : "";
      // --ad=off: AD を材料から外して測る（AD がスタッフの選び方と合っているかの切り分け）
      const adOff = args.ad === "off";
      const data: PropertyDataLike = { rank: c.rank, name: c.name, rent: c.rent ?? one?.rent ?? null, floor_plan: c.floor_plan ?? null, ad_months: adOff ? null : c.ad_months ?? one?.ad_months ?? null, ad_yen: adOff ? null : c.ad_yen ?? null };
      const f = parsePropertyFacts(`【${c.rank}】${c.name}${room ? ` ${room}号室` : ""}`, data);
      const j = judgeProperty(f, prof, i, { today: pool.sent_at });
      return { c, j, isStar };
    });
    const star = judged.find((x) => x.isStar)!;
    const others = judged.filter((x) => x !== star);
    const gt = others.filter((x) => x.j.score > star.j.score).length;
    const eq = others.filter((x) => x.j.score === star.j.score).length;
    const n = judged.length;
    const pos = 1 + gt + eq / 2;
    for (const v of variants) {
      const sc = judged.map((x) => vScore(v, x.j));
      const ss = vScore(v, star.j);
      const g = sc.filter((x, k) => judged[k] !== star && x > ss).length, e2 = sc.filter((x, k) => judged[k] !== star && x === ss).length;
      const M = vm[v]; M.n++; M.rel += (g + e2 / 2) / (n - 1); if (g === 0) M.top1++; if (1 + g + e2 / 2 <= 3) M.top3++;
      // 1位（最高点）が保留で、AD の段の点を抜くと通す物件の最高点を下回る回
      const best = Math.max(...sc); const topIdx = sc.indexOf(best); const top = judged[topIdx];
      const bestPass = Math.max(-1, ...judged.filter((x) => x.j.verdict === "pass").map((x) => vScore(v, x.j)));
      if (top.j.verdict !== "pass" && bestPass >= 0 && vScore(v, top.j) - (v === "V3" ? 0 : (v === "V1" ? 0 : v === "V2" ? adPts(top.j.reasonCodes) / 2 : adPts(top.j.reasonCodes))) < bestPass) M.holdTopByAd++;
      if (star.j.verdict !== "pass" && g === 0) M.starHoldTop++;
    }
    if (star.j.verdict !== "pass" && holdStarCases.length < 30) holdStarCases.push(`🌟保留 ${star.j.score}点 AD段${adPts(star.j.reasonCodes)} 札[${star.j.flagCodes.join(",")}] ／ 回の通す物件の最高 ${Math.max(-1, ...judged.filter((x) => x.j.verdict === "pass").map((x) => x.j.score))} ／ 候補${n}`);
    evaluated++;
    if (gt === 0) top1Tie++;
    if (gt === 0 && eq === 0) top1Unique++;
    if (pos <= 3) top3Avg++;
    randTop1 += 1 / n;
    randTop3 += Math.min(3, n) / n;
    relSum += (gt + eq / 2) / (n - 1);
    if (new Set(judged.map((x) => x.j.score)).size === 1) allTied++;
    const extRank = [...judged].sort((a, z) => a.c.rank - z.c.rank).indexOf(star) + 1;
    if (extRank === 1) extTop1++;
    if (extRank <= 3) extTop3++;
    if (star.j.reasonCodes.includes("ALREADY_SENT")) starAlreadySent++;
    if (star.j.reasonCodes.includes("ALREADY_SENT_OTHER_ROOM")) starAlreadySentOther++;
    if (star.j.reasonCodes.includes("ALREADY_SENT_SAME_ROOM")) starSameRoom++;
    if (star.j.verdict === "drop") starDrop++;
    if (star.j.verdict === "hold") starHold++;
    perStar.push({ msg: String(m.id).slice(0, 8), n, pos, rel: +((gt + eq / 2) / (n - 1)).toFixed(3), score: star.j.score, max: Math.max(...judged.map((x) => x.j.score)), adKnown: star.c.ad_months != null || star.c.ad_yen != null, allAdKnown: judged.every((x) => x.c.ad_months != null || x.c.ad_yen != null) });
    if (shows.length < SHOW && gt > 0) {
      shows.push(`回 ${pool.sent_at.slice(0, 10)} 候補${n} 🌟${pos}位（${star.j.score}点・最高${Math.max(...judged.map((x) => x.j.score))}）\n` +
        judged.map((x) => `   ${x.isStar ? "🌟" : "  "}【${x.c.rank}】${x.j.score} ${x.c.floor_plan ?? "?"} AD${x.c.ad_months ?? "?"} ${x.j.reasonCodes.join(",")}`).join("\n"));
    }
  }

  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
  const res = {
    until: untilIso, days: DAYS,
    starMsgs, withCust, matched, evaluated,
    top1_withTies: pct(top1Tie, evaluated), top1_unique: pct(top1Unique, evaluated), top3_avgRank: pct(top3Avg, evaluated),
    random_top1: pct(randTop1, evaluated), random_top3: pct(randTop3, evaluated),
    relativeRank: evaluated ? +(relSum / evaluated).toFixed(3) : null, allTiedSessions: `${allTied}/${evaluated}`,
    extension_top1: pct(extTop1, evaluated), extension_top3: pct(extTop3, evaluated),
    star_ALREADY_SENT: starAlreadySent, star_ALREADY_SENT_OTHER_ROOM: starAlreadySentOther, star_ALREADY_SENT_SAME_ROOM: starSameRoom,
    star_verdict_drop: starDrop, star_verdict_hold: starHold,
    textJudged, starFlagged: `${flagged}/${textJudged}（${pct(flagged, textJudged)}）`, starFlagCodes: flagCounts,
  };
  // 🌟の AD が候補プールに有る回だけ（AD が無い🌟は「AD 不明 0点」で AD の分かる他の候補より下がる＝材料の欠けの影響を切り分ける）
  const known = perStar.filter((x) => x.adKnown);
  Object.assign(res, { starAdKnown: known.length, starAdKnown_relativeRank: known.length ? +(known.reduce((a, x) => a + x.rel, 0) / known.length).toFixed(3) : null,
    starAdKnown_top1_withTies: pct(known.filter((x) => x.score === x.max).length, known.length), starAdKnown_top3: pct(known.filter((x) => x.pos <= 3).length, known.length) });
  // 回の候補が全部 AD の分かる回（AD の有無の欠けが無い＝点の重みそのものの当たり方）
  const full = perStar.filter((x) => x.allAdKnown);
  Object.assign(res, { allAdKnownSessions: full.length, allAdKnown_relativeRank: full.length ? +(full.reduce((a, x) => a + x.rel, 0) / full.length).toFixed(3) : null,
    allAdKnown_top1_withTies: pct(full.filter((x) => x.score === x.max).length, full.length), allAdKnown_top1_unique_or_tied: pct(full.filter((x) => x.pos <= 1.5).length, full.length), allAdKnown_top3: pct(full.filter((x) => x.pos <= 3).length, full.length),
    allAdKnown_random_top3: pct(full.reduce((a, x) => a + Math.min(3, x.n) / x.n, 0), full.length) });
  console.log(JSON.stringify(res, null, 2));
  console.log("\n■ AD の段の扱い別\n" + variants.map((v) => { const M = vm[v]; return `${v}: 回 ${M.n} 🌟相対順位 ${(M.rel / M.n).toFixed(3)} 1位(同点込) ${(100 * M.top1 / M.n).toFixed(1)}% 3位以内 ${(100 * M.top3 / M.n).toFixed(1)}% 保留がADで1位 ${M.holdTopByAd} 🌟が保留で1位 ${M.starHoldTop}`; }).join("\n"));
  console.log(`\n■ 🌟の本文で判定: 保留の🌟 ${adDist(starAdHold)}\n                    通す🌟 ${adDist(starAdPass)}`);
  console.log("\n■ 🌟が保留の回\n" + holdStarCases.join("\n"));
  if (shows.length) console.log("\n■ 🌟が1位でない回の例\n" + shows.join("\n\n"));
  if (args.out) writeFileSync(String(args.out), JSON.stringify({ res, perStar }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
