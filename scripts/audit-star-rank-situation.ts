// scripts/audit-star-rank-situation.ts
// 🌟（一番オススメ）の並べ方（app/lib/recommend-star-rank.ts）を「材料の届き方」と「お客様の状況」で点検する（読むだけ・LLM なし・費用0・DB に書かない）。
//
// 2026-10-06 竹内「実際読みとった画像から分析できていればかなり質高くなっているはず　またお客さんの状況に連動して、評価基準も変動できていればより正確に…
//   物件検索のブレインに足りない部分、足りないクエリなどがあれば追加する」
//
// ■ 回 … recommendation_snapshots（候補2件以上・🌟が候補にある・YUMA を除く）。点は今の判定で付け直し（episodeFromSnapshot・条件はその時点に戻す）
// ■ 材料の届き方（出どころごとに、候補に無い項目だけ埋める。順に）
//   ① 保存済みの候補（🌟の時点の記録）
//   ② 送った画像の読み取り sent_image_properties.facts（候補の image_url で引く・号室が違う古い結び違いは使わない）＋ 募集状況（status）
//   ③ 売上サポの行 property_pickups（同じお客様・🌟の14日前まで・建物名の近さ0.75）… AD・構造・設備・築年・敷礼・入居可能日
//      ※ 🌟の記録（recommendation-snapshot-server）は売上サポの行から説明文と資料の文字しか取らず、AD の札・構造・設備の読み取りは候補に入っていない（足りないクエリ）
//   ④ rent_observations（建物名＋号室）
// ■ 出す物
//   1. 値の有り率（①→②→③→④）と、材料ごとの1位一致（今の点／並べ方）
//   2. 状況ごと（お客様の希望の話題・入居の急ぎ）に「🌟が束の中で一番か」（希望あり／なし × ランダム）
//   3. 状況で重みを変える案の当て直し（全体／後3割／live・対の比べ）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-star-rank-situation.ts [--days=180] [--stage=4]
import { createClient } from "@supabase/supabase-js";
import { baseReasonPoints, type SentRowLike, type PatternRowLike } from "../app/lib/property-brain";
import { customerAt, buildContext, episodeFromSnapshot, isCustomerSend, type ConditionHistoryRow } from "../app/lib/scoring-learning-episodes";
import { nameKey, bestBuildingMatch } from "../app/lib/candidate-facts";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";
import { rankStarCandidates, STAR_RANK_RULE, STAR_SITUATION_RULE, starSituationOf, type StarCandidate, type StarSituation, type StarSituationRule } from "../app/lib/recommend-star-rank";
import { adMonthsOfPickup, structureOf, equipmentKeysOf, areaSqmOfPickup, starSituationFromConditions } from "../app/lib/star-rank-pickup";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "180"), 10);
const STAGE = parseInt(String(args.stage ?? "4"), 10);
// --wants=cond … 希望の話題を条件欄（構造化＋自由文）だけから（本番の 👑 はお客様の発言を読まないので、同じ材料で確かめる）
const WANTS_COND_ONLY = String(args.wants ?? "") === "cond";
// --wants=live … 本番の 👑 と同じ関数（star-rank-pickup.starSituationFromConditions・その時点の条件欄）で状況を決める
const WANTS_LIVE = String(args.wants ?? "") === "live";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
type Row = Record<string, any>;
const D = 864e5, H = 36e5;
const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "-");
const chunks = <T,>(xs: T[], n: number) => { const o: T[][] = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o; };
const normRoom = (r: unknown) => String(r ?? "").replace(/[^0-9A-Za-z]/g, "").replace(/^0+(?=\d)/, "");
async function all(build: (a: number, b: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>, page = 1000): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < 80; p++) {
    const { data, error } = await build(p * page, p * page + page - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out = out.concat(data);
    if (data.length < page) break;
  }
  return out;
}
// 設備の語（候補・ピックアップの資料）→ listing-equipment の鍵
const LABEL_KEY: Record<string, string> = {
  エレベーター: "elevator", 宅配ボックス: "delivery_box", オートロック: "autolock", ネット無料: "net_free", 駐車場: "parking", "バス・トイレ別": "bath_toilet",
  独立洗面台: "washbasin", 室内洗濯機置場: "laundry_in", 角部屋: "corner", ペット相談: "pet", 南向き: "south", エアコン: "aircon", システムキッチン: "system_kitchen",
  対面キッチン: "counter_kitchen", 追い焚き: "reheating", 浴室乾燥機: "bath_dryer", 温水洗浄便座: "washlet", ウォークインクローゼット: "walk_in_closet",
  "2口コンロ": "burner2", フローリング: "flooring", 駐輪場: "bike_parking", "24時間ゴミ出し": "garbage24", モニター付インターホン: "monitor_intercom", 最上階: "top_floor",
};
const toKey = (s: string) => LABEL_KEY[s] ?? s;

type C = { key: string; chosen: boolean; codes: string[]; base: number; f: Row };
type Ep = { at: string; live: boolean; cands: C[]; sit: StarSituation; wants: Set<string>; urgency: string };

function moveInUrgency(moveIn: unknown, atIso: string): string {
  const s = String(moveIn ?? "").normalize("NFKC");
  if (!s.trim()) return "unknown";
  if (/即|すぐ|至急|急ぎ|今月|早め|なるべく早|今週|来週/.test(s)) return "urgent";
  const m = s.match(/(\d{1,2})\s*月/);
  if (m) return ((parseInt(m[1], 10) - (new Date(atIso).getMonth() + 1) + 12) % 12) <= 1 ? "urgent" : "later";
  return "unknown";
}

(async () => {
  const until = Date.now();
  const snaps = (await all((a, b) => sb.from("recommendation_snapshots").select("id, conversation_id, property_customer_id, sent_at, star_in_candidates, candidate_count, candidates, source, customer_wants")
    .gte("sent_at", new Date(until - DAYS * D).toISOString()).gte("candidate_count", 2).order("id").range(a, b) as never, 300)).filter((s) => s.conversation_id !== YUMA_CONVERSATION_ID && s.property_customer_id && s.star_in_candidates);
  const pcs = [...new Set(snaps.map((s) => String(s.property_customer_id)))];
  const custs = new Map<string, Row>(); const hist: Row[] = [], sents: Row[] = [], pats: Row[] = [], picks: Row[] = [];
  for (const c of chunks(pcs, 80)) {
    const { data } = await sb.from("property_customers").select("id, rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet, move_in_time, created_at, floor_area_min, raw_format_text, desired_area, commute_station, commute_minutes").in("id", c);
    for (const r of (data ?? []) as Row[]) custs.set(r.id, r);
    hist.push(...await all((a, b) => sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, created_at").in("property_customer_id", c).order("id").range(a, b) as never));
    sents.push(...await all((a, b) => sb.from("sent_properties").select("property_customer_id, property_name, room_no, rent, delivery, source, sent_at").in("property_customer_id", c).order("id").range(a, b) as never));
    pats.push(...await all((a, b) => sb.from("property_selection_patterns").select("property_customer_id, selling_points, selection_label, created_at").in("property_customer_id", c).order("id").range(a, b) as never));
    picks.push(...await all((a, b) => sb.from("property_pickups").select("id, property_customer_id, created_at, property_name, room_no, reason_codes, summary_text, ad_yen, equipment, terms").in("property_customer_id", c).order("id").range(a, b) as never));
  }
  const g = (xs: Row[]) => { const m = new Map<string, Row[]>(); for (const x of xs) { const k = String(x.property_customer_id); if (!m.has(k)) m.set(k, []); m.get(k)!.push(x); } return m; };
  const hOf = g(hist), sOf = g(sents), pOf = g(pats), pkOf = g(picks);

  const byImage = new Map<string, Row>();
  let linkErr = 0;
  const urls = [...new Set(snaps.flatMap((s) => ((s.candidates ?? []) as Row[]).map((c) => String(c.image_url ?? "")).filter(Boolean)))];
  for (const c of chunks(urls, 20)) {
    const { data, error } = await sb.from("sent_image_properties").select("image_url, property_name, room_no, facts").in("image_url", c).not("facts", "is", null);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Row[]) {
      const fr = (r.facts as Row)?.room_no;
      if (fr != null && r.room_no != null && normRoom(fr) && normRoom(r.room_no) && normRoom(fr) !== normRoom(r.room_no)) { linkErr++; continue; }
      byImage.set(String(r.image_url), r.facts as Row);
    }
  }
  const roByKey = new Map<string, Row>();
  for (const r of await all((a, b) => sb.from("rent_observations").select("property_name, room_no, rent, admin_fee, area_sqm, building_age, walk_minutes, structure, floor, deposit_months, key_money_months, equipment, ad_yen, floor_plan").order("id").range(a, b) as never)) roByKey.set(`${nameKey(r.property_name)}#${normRoom(r.room_no)}`, r);

  const KEYS = ["rent", "area_sqm", "building_age", "walk_minutes", "ad", "equipment", "structure", "deposit_months", "status"];
  const has = (x: Row, k: string) => k === "ad" ? (x.ad_months != null || x.ad_yen != null) : k === "equipment" ? (Array.isArray(x.equipment) && x.equipment.length > 0) : k === "structure" ? x.__structure != null : k === "status" ? x.__status != null : x[k] != null;
  const have: Record<string, number[]> = {}; let candN = 0; let pickLinked = 0;
  const eps: Ep[] = [];
  for (const s of snaps) {
    const pc = String(s.property_customer_id); const base = custs.get(pc); if (!base) continue;
    const cands = ((typeof s.candidates === "string" ? JSON.parse(s.candidates) : s.candidates) ?? []) as Row[];
    const t = Date.parse(s.sent_at);
    const firstSent = Math.min(...cands.map((c) => Date.parse(String(c.sent_at ?? ""))).filter(Number.isFinite), t);
    const { c } = customerAt(base, (hOf.get(pc) ?? []) as ConditionHistoryRow[], s.sent_at);
    const before = (sOf.get(pc) ?? []).filter((x) => Date.parse(x.sent_at) < firstSent - 60_000 && isCustomerSend(x)) as SentRowLike[];
    const pt = (pOf.get(pc) ?? []).filter((p) => Date.parse(p.created_at) < t) as PatternRowLike[];
    const ctx = buildContext(c, before, pt, s.sent_at);
    const pkList = (pkOf.get(pc) ?? []).filter((r) => Date.parse(r.created_at) <= t + 60_000 && Date.parse(r.created_at) >= t - 14 * D);
    const stages: Row[][] = [cands.map((x) => ({ ...x, equipment: Array.isArray(x.equipment) ? x.equipment.map(toKey) : x.equipment, __structure: x.structure ?? null }))];
    const fill = (x: Row, k: string, v: unknown) => { if (x[k] == null && v != null && v !== "") x[k] = v; };
    // ② 画像
    stages.push(stages[0].map((cd) => {
      const x: Row = { ...cd };
      const f = byImage.get(String(cd.image_url ?? ""));
      if (f) {
        for (const k of ["rent", "admin_fee_yen", "area_sqm", "building_age", "walk_minutes", "floor_plan", "deposit_months", "key_money_months", "station", "floor"]) fill(x, k, f[k]);
        if (x.stations == null && Array.isArray(f.stations)) x.stations = f.stations;
        if (x.ad_months == null && x.ad_yen == null) { fill(x, "ad_months", f.ad_months); fill(x, "ad_yen", f.ad_yen); }
        if (f.status) x.__status = f.status;
      }
      return x;
    }));
    // ③ 売上サポの行
    stages.push(stages[1].map((cd) => {
      const x: Row = { ...cd };
      const pk = bestBuildingMatch(String(cd.name ?? ""), cd.room_no ?? null, pkList, (r: Row) => r.property_name, (r: Row) => r.room_no);
      if (pk) {
        pickLinked++;
        if (x.ad_months == null && x.ad_yen == null) { const m = adMonthsOfPickup(pk); if (m != null) x.ad_months = m; }
        const st = structureOf(pk.equipment); if (x.__structure == null && st) x.__structure = st;
        const eq = equipmentKeysOf(pk.equipment); if ((!Array.isArray(x.equipment) || !x.equipment.length) && eq) x.equipment = eq;
        fill(x, "building_age", pk.terms?.buildingAge); fill(x, "area_sqm", areaSqmOfPickup(pk));
        fill(x, "deposit_months", pk.terms?.deposit); fill(x, "key_money_months", pk.terms?.keyMoney);
        if (pk.terms?.moveIn?.availableFrom) x.__available = pk.terms.moveIn.availableFrom;
      }
      return x;
    }));
    // ④ rent_observations
    stages.push(stages[2].map((cd) => {
      const x: Row = { ...cd };
      const ro = roByKey.get(`${nameKey(cd.name)}#${normRoom(cd.room_no)}`);
      if (ro) {
        fill(x, "rent", ro.rent); fill(x, "admin_fee_yen", ro.admin_fee); fill(x, "area_sqm", ro.area_sqm != null ? Number(ro.area_sqm) : null); fill(x, "building_age", ro.building_age);
        fill(x, "walk_minutes", ro.walk_minutes); fill(x, "floor", ro.floor); fill(x, "deposit_months", ro.deposit_months != null ? Number(ro.deposit_months) : null);
        fill(x, "key_money_months", ro.key_money_months != null ? Number(ro.key_money_months) : null); fill(x, "floor_plan", ro.floor_plan);
        if (x.ad_yen == null && x.ad_months == null && ro.ad_yen != null) x.ad_yen = ro.ad_yen;
        if ((!Array.isArray(x.equipment) || !x.equipment.length) && ro.equipment && typeof ro.equipment === "object") x.equipment = Object.entries(ro.equipment as Row).filter(([, v]) => v === true).map(([k]) => k);
        if (x.__structure == null && ro.structure) x.__structure = ro.structure;
      }
      return x;
    }));
    for (let i = 0; i < cands.length; i++) { candN++; for (const k of KEYS) { have[k] ??= [0, 0, 0, 0]; for (let st = 0; st < 4; st++) if (has(stages[st][i], k)) have[k][st]++; } }
    const filled = stages[Math.min(STAGE, 4) - 1];
    let e = null;
    try { e = episodeFromSnapshot({ ...s, candidates: filled }, ctx); } catch { e = null; }
    if (!e) continue;
    const wants = new Set<string>(((s.customer_wants ?? []) as Row[]).filter((w) => !WANTS_COND_ONLY || w.from !== "messages").map((w) => String(w.key)));
    const urgency = moveInUrgency(c.move_in_time, s.sent_at);
    const sit = WANTS_LIVE ? (starSituationFromConditions(c) ?? starSituationOf({})) : starSituationOf({ wantTopics: [...wants], moveInUrgent: urgency === "urgent" });
    const ec: C[] = e.cands.map((cc) => {
      const src = filled.find((fc) => cc.key === `${fc.name}${fc.room_no ? ` ${normRoom(fc.room_no)}` : ""}`) ?? filled.find((fc) => cc.key.startsWith(String(fc.name))) ?? {};
      return { key: cc.key, chosen: cc.chosen, codes: cc.codes, base: 50 + cc.codes.reduce((a, k) => a + baseReasonPoints(k), 0), f: { ...cc.feats, __structure: src.__structure ?? null, __status: src.__status ?? null, __available: src.__available ?? null, equipment: src.equipment ?? null } };
    });
    eps.push({ at: e.at, live: s.source === "live", cands: ec, sit, wants, urgency });
  }
  eps.sort((a, b) => a.at.localeCompare(b.at));
  const hold = eps.slice(Math.floor(eps.length * 0.7)), live = eps.filter((e) => e.live);

  console.log(`=== 材料の届き方（候補 ${candN}・回 ${eps.length}・live ${live.length}・後3割 ${hold.length}）===`);
  console.log(`画像の結び違いで外した ${linkErr}・売上サポの行に結べた候補 ${pickLinked}`);
  console.log(`項目       ①保存  ②+画像  ③+売上サポ  ④+観測`);
  for (const k of KEYS) console.log(`${k.padEnd(15)} ${have[k].map((v) => pct(v / candN).padStart(6)).join("  ")}`);

  const toStar = (c: C): StarCandidate => ({
    key: c.key, codes: c.codes, score: c.base, pointsOf: baseReasonPoints, areaSqm: c.f.area_sqm, buildingAge: c.f.building_age, structure: c.f.__structure,
    equipmentCount: c.f.equipment_count, equipWantHits: c.f.equip_want_hits, adMonths: c.f.ad_months,
    zeroZero: c.f.zero_zero == null ? null : c.f.zero_zero === 1, walkMinutes: c.f.walk, vacancy: c.f.__status === "open" ? "open" : c.f.__status === "move_out_planned" || c.f.__status === "under_construction" ? "later" : null,
    equipmentKeys: Array.isArray(c.f.equipment) ? c.f.equipment : null, floor: c.f.floor,
  });
  const top1 = (xs: Ep[], rule = STAR_RANK_RULE, useSit = false, sr: Readonly<StarSituationRule> = STAR_SITUATION_RULE) => xs.filter((e) => { const r = rankStarCandidates(e.cands.map(toStar), rule, useSit ? e.sit : undefined, sr); return !!e.cands.find((c) => c.key === r[0].key)?.chosen; }).length / (xs.length || 1);
  const scoreTop1 = (xs: Ep[]) => xs.filter((e) => { const mx = Math.max(...e.cands.map((c) => c.base)); return e.cands.find((c) => c.base === mx)!.chosen; }).length / (xs.length || 1);
  const rand = (xs: Ep[]) => xs.reduce((a, e) => a + e.cands.filter((c) => c.chosen).length / e.cands.length, 0) / (xs.length || 1);
  const disc = (xs: Ep[], rule = STAR_RANK_RULE, sr: Readonly<StarSituationRule> = STAR_SITUATION_RULE) => {
    let onlyNew = 0, onlyOld = 0;
    for (const e of xs) {
      const o = rankStarCandidates(e.cands.map(toStar), rule)[0].key, n = rankStarCandidates(e.cands.map(toStar), rule, e.sit, sr)[0].key;
      const oh = !!e.cands.find((c) => c.key === o)?.chosen, nh = !!e.cands.find((c) => c.key === n)?.chosen;
      if (nh && !oh) onlyNew++; if (oh && !nh) onlyOld++;
    }
    return `状況ありだけ当たり ${onlyNew}・なしだけ当たり ${onlyOld}`;
  };
  const line = (lab: string, f: (xs: Ep[]) => number) => console.log(`${lab.padEnd(26)} ${pct(f(eps))} ／ ${pct(f(hold))} ／ ${pct(f(live))}`);
  console.log(`\n=== 1位一致（全体 ／ 後3割 ／ live）・材料は段 ${STAGE} まで ===`);
  line("ランダム", rand);
  line("今の点（同点は元の並び）", scoreTop1);
  line("並べ方（状況なし＝今の本番）", (x) => top1(x));
  line("並べ方＋状況", (x) => top1(x, STAR_RANK_RULE, true));
  console.log(`対の比べ: 全体 ${disc(eps)}／後3割 ${disc(hold)}／live ${disc(live)}`);
  // 状況の足し点の案（1つずつ・組み合わせ）
  const Z: StarSituationRule = { zero: 0, spacious: 0, newBuild: 0, stationNear: 0, floorHigh: 0, vacantNow: 0, equipEach: 0 };
  const variants: Array<[string, StarSituationRule]> = [];
  for (const k of ["zero", "spacious", "newBuild", "stationNear", "floorHigh", "vacantNow", "equipEach"] as const) for (const v of [5, 10, 20]) variants.push([`${k} +${v}`, { ...Z, [k]: v }]);
  variants.push(["zero+20 floorHigh+10", { ...Z, zero: 20, floorHigh: 10 }], ["zero+20 floorHigh+20", { ...Z, zero: 20, floorHigh: 20 }], ["zero+15 floorHigh+15", { ...Z, zero: 15, floorHigh: 15 }], ["zero+20 floor+10 equip+5", { ...Z, zero: 20, floorHigh: 10, equipEach: 5 }], ["zero+30", { ...Z, zero: 30 }], ["floorHigh+30", { ...Z, floorHigh: 30 }]);
  for (const [lab, sr] of variants) console.log(`  案 ${lab.padEnd(18)} ${pct(top1(eps, STAR_RANK_RULE, true, sr))} ／ ${pct(top1(hold, STAR_RANK_RULE, true, sr))} ／ ${pct(top1(live, STAR_RANK_RULE, true, sr))}  ${disc(eps, STAR_RANK_RULE, sr)}`);
  // 目で見る: 状況で👑が入れ替わった回（本番の足し点）。物件名・値だけ（お客様の名前・発言は出さない）
  console.log(`
=== 状況で一番が入れ替わった回（本番の足し点 STAR_SITUATION_RULE）===`);
  for (const e of eps) {
    const o = rankStarCandidates(e.cands.map(toStar))[0], n = rankStarCandidates(e.cands.map(toStar), STAR_RANK_RULE, e.sit)[0];
    if (o.key === n.key) continue;
    const star = e.cands.find((c) => c.chosen)!;
    const desc = (k: string) => { const c = e.cands.find((x) => x.key === k)!; return `${k}（敷礼0=${c.f.zero_zero ?? "?"}・${c.f.floor ?? "?"}階・${c.f.area_sqm ?? "?"}㎡・築${c.f.building_age ?? "?"}・AD ${c.f.ad_months ?? "?"}）`; };
    console.log(`  ${e.at.slice(0, 10)} ${e.live ? "live" : "backfill"} 候補${e.cands.length} 状況[${[e.sit.zero && "敷礼0", e.sit.floorHigh && "2階以上"].filter(Boolean).join("・")}] 前 ${desc(o.key)} → 後 ${desc(n.key)}${n.key === star.key ? " ＝🌟と一致" : o.key === star.key ? " ✗前が🌟だった" : ` ／ 🌟は ${desc(star.key)}`}`);
  }

  // 2. 状況ごとに🌟が束の中で一番か（希望あり／なし）
  console.log(`\n=== 状況ごと: 🌟が束の中で一番（値が割れる回だけ・同じ値含む）— 希望あり ／ 希望なし ===`);
  const best = (xs: Ep[], f: (c: C) => number | null) => {
    let n = 0, b = 0, r = 0;
    for (const e of xs) {
      const vals = e.cands.map(f).filter((v): v is number => v != null);
      const sv = f(e.cands.find((c) => c.chosen)!);
      if (sv == null || vals.length < 2 || new Set(vals).size < 2) continue;
      const mx = Math.max(...vals); n++; if (sv === mx) b++; r += vals.filter((v) => v === mx).length / vals.length;
    }
    return `n=${String(n).padStart(3)} 🌟 ${pct(b / (n || 1)).padStart(4)}（ラ ${pct(r / (n || 1))}）`;
  };
  const eqHas = (k: string) => (c: C) => (Array.isArray(c.f.equipment) ? (c.f.equipment.includes(k) ? 1 : 0) : null);
  const tests: Array<[string, (e: Ep) => boolean, (c: C) => number | null]> = [
    ["初期費用・敷礼0 → 敷礼0", (e) => e.wants.has("low_initial") || e.wants.has("zero_deposit"), (c) => c.f.zero_zero],
    ["入居を急ぐ → 空室（即入居）", (e) => e.urgency === "urgent" || e.wants.has("move_in"), (c) => (c.f.__status === "open" ? 1 : c.f.__status ? 0 : null)],
    ["広さ → 一番広い", (e) => e.wants.has("spacious"), (c) => c.f.area_sqm],
    ["築浅 → 一番新しい", (e) => e.wants.has("new_build"), (c) => (c.f.building_age == null ? null : -c.f.building_age)],
    ["駅近 → 徒歩が一番短い", (e) => e.wants.has("station_near"), (c) => (c.f.walk == null ? null : -c.f.walk)],
    ["家賃 → 家賃比が一番低い", (e) => e.wants.has("rent"), (c) => (c.f.rent_ratio == null ? null : -c.f.rent_ratio)],
    ["静か → RC", (e) => e.wants.has("quiet"), (c) => (c.f.__structure == null ? null : /RC/.test(c.f.__structure) ? 1 : 0)],
    ["2階以上 → 階が高い", (e) => e.wants.has("floor2"), (c) => c.f.floor],
    ["バス・トイレ別", (e) => e.wants.has("bath_toilet"), eqHas("bath_toilet")],
    ["独立洗面台", (e) => e.wants.has("washbasin"), eqHas("washbasin")],
    ["オートロック・セキュリティ", (e) => e.wants.has("autolock") || e.wants.has("security"), eqHas("autolock")],
    ["宅配ボックス", (e) => e.wants.has("delivery_box"), eqHas("delivery_box")],
    ["室内洗濯機置場", (e) => e.wants.has("laundry_in"), eqHas("laundry_in")],
    ["日当たり → 南向き", (e) => e.wants.has("sunny"), eqHas("south")],
    ["(参考) 設備の数", (e) => e.wants.size > 0, (c) => c.f.equipment_count],
    ["(参考) AD", (e) => true, (c) => c.f.ad_months],
  ];
  for (const [lab, w, f] of tests) console.log(`  ${lab.padEnd(22)} あり ${best(eps.filter(w), f)} ／ なし ${best(eps.filter((e) => !w(e)), f)}`);
})().catch((e) => { console.error(e); process.exit(1); });
