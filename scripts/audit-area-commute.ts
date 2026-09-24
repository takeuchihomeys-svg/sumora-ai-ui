// scripts/audit-area-commute.ts — 売上サポの判定の穴埋め（家賃下限・間取りの「も可」・広さ・築浅・エリア・通勤・条件の要約）の全件監査（DB は読むだけ・LLM は呼ばない）
// 実行: npx tsx --env-file=.env.local scripts/audit-area-commute.ts [--customers] [--pickups] [--summary] [--limit=20]
//   --customers: 全お客様の条件を読んだ結果（間取りの「も可」・下限・広さ・築浅・エリア・通勤）を1人1行で出す（読み違いを目で見る）
//   --pickups:   保存済みの property_pickups（文字層あり）に当てて、物件の場所・エリア・通勤の照合を代表のお客様ごとに出す
//   --summary:   条件の要約（決定論）と照らせない条件を1人1行で出す
// 個人情報: お客様の名前・電話は出さない（id の先頭8字だけ）。例の文の番地・電話は伏せる。
//
// 2026-09-25 竹内「家賃の下限入れる」「1DKも可…」「文章の部分も要約」「エリア…大阪の理解」「通勤…沿線の知識」
import { createClient } from "@supabase/supabase-js";
import { buildCustomerProfile, judgeProperty, parsePropertyFacts, type CustomerLike } from "../app/lib/property-brain";
import { parseAreaWant, parseCommuteWants, buildPropertyLocation, matchArea, matchCommute, locationReasonCodes } from "../app/lib/area-want";
import { buildConditionSummary, formatSummaryLine, uncheckableLabels } from "../app/lib/condition-summary";
import { parseListingText } from "../app/lib/listing-text";

const COLS = "id, customer_name, rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet, move_in_time, created_at, floor_area_min, raw_format_text, desired_area, commute_station, commute_minutes";
const TEST_NAME_RE = /YUMA|ＹＵＭＡ|テスト|TEST|test/;
const safe = (s: string) => String(s ?? "").replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}|\d+丁目[\d\-ー－]*|\d+-\d+(?:-\d+)?|[\w.+-]+@[\w-]+\.[\w.-]+/g, "＊").replace(/\s+/g, " ");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];

type Cust = CustomerLike & { id: string; customer_name: string | null; desired_area: string | null; commute_station: string | null; commute_minutes: number | null };

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
  const all: Cust[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("property_customers").select(COLS).range(from, from + 999);
    if (error) { console.error(error.message); process.exit(1); }
    all.push(...((data ?? []) as Cust[]));
    if (!data || data.length < 1000) break;
  }
  const rows = all.filter((r) => !TEST_NAME_RE.test(String(r.customer_name ?? "")));
  const cnt = { people: rows.length, rentMin: 0, rentMinDropped: 0, alt: 0, sqm: 0, ageText: 0, area: 0, areaUnread: 0, exclude: 0, commute: 0, commuteMinutes: 0, summaryUnread: 0, summaryUnchecked: 0 };
  const show = process.argv.includes("--customers");
  const showSum = process.argv.includes("--summary");
  for (const c of rows) {
    const p = buildCustomerProfile(c);
    const area = parseAreaWant(c.desired_area, [c.preferences, c.other_requests].filter(Boolean).join("\n"));
    const cm = parseCommuteWants(c);
    if (p.rentMin != null) cnt.rentMin++;
    else if (typeof c.rent_min === "number" && c.rent_min > 0) cnt.rentMinDropped++;
    if (p.floorPlanAlt) cnt.alt++;
    if (p.sqmMin != null) cnt.sqm++;
    if (p.ageTextMax) cnt.ageText++;
    if (area.any) cnt.area++;
    if (area.unread.length) cnt.areaUnread++;
    if (area.exclude.stations.length || area.exclude.wards.length) cnt.exclude++;
    if (cm.length) cnt.commute++;
    if (cm.some((x) => x.minutes != null)) cnt.commuteMinutes++;
    const s = buildConditionSummary(c);
    if (s.unread.length) cnt.summaryUnread++;
    if (s.unchecked.length) cnt.summaryUnchecked++;
    if (show && (p.floorPlanAlt || p.ageTextMax || area.exclude.stations.length || area.exclude.wards.length || cm.length || (p.rentMin == null && c.rent_min))) {
      console.log(`[${c.id.slice(0, 8)}] 間取り列=${safe(String(c.floor_plan ?? ""))} → 本命=${p.floorPlanWant.plans.join("/") || (p.floorPlanWant.any ? "なし" : "")}${p.floorPlanWant.minRank ? `(下限${p.floorPlanWant.minRank})` : ""} も可=${p.floorPlanAlt?.plans.join("/") ?? "-"}`
        + ` ｜下限=${c.rent_min ?? "-"}→${p.rentMin ?? "使わない"} ｜広さ=${p.sqmMin ?? "-"} ｜築浅=${p.ageTextMax ? `${p.ageTextMax.word}:${p.ageTextMax.years}` : "-"}`
        + ` ｜以外=${[...area.exclude.stations, ...area.exclude.wards].join("/") || "-"} ｜通勤=${cm.map((x) => `${x.target}:${x.minutes ?? "-"}`).join("/") || "-"}`);
    }
    if (showSum) {
      console.log(`[${c.id.slice(0, 8)}] ${safe(formatSummaryLine(s.items)).slice(0, 220)}\n    照らせない: ${safe(uncheckableLabels(s).join("／")).slice(0, 200) || "-"}`);
    }
  }
  console.log("\n=== 全お客様の読み取り（" + cnt.people + "人・テストを除く） ===");
  console.log(cnt);

  // --sample: 代表のお客様（エリアの書き方が違う人）に、場所の違う見本の物件4件を当てて目で確かめる
  if (process.argv.includes("--sample")) {
    const SAMPLES: Array<[string, string]> = [
      ["【見本A】恵美須町", ["所在地 大阪府大阪市浪速区恵美須西1丁目", "交通", "堺筋線「恵美須町」徒歩5分"].join("\n")],
      ["【見本B】新大阪", ["所在地 大阪府大阪市淀川区西中島5丁目", "交通", "御堂筋線「新大阪」徒歩6分"].join("\n")],
      ["【見本C】布施", ["所在地 大阪府東大阪市長堂1丁目", "交通", "近鉄奈良線「布施」徒歩4分"].join("\n")],
      ["【見本D】西宮北口", ["所在地 兵庫県西宮市甲風園1丁目", "交通", "阪急神戸線「西宮北口」徒歩7分"].join("\n")],
      ["【見本E】京橋", ["所在地 大阪府大阪市都島区東野田町3丁目", "交通", "大阪環状線「京橋」徒歩5分"].join("\n")],
    ];
    const NL = "\n";
    const limit = Number(arg("limit") ?? "20");
    const picked = rows.filter((c) => c.desired_area || c.commute_station).filter((c, i, arr) => arr.findIndex((x) => x.desired_area === c.desired_area) === i);
    // 書き方が違う人を選ぶ（駅だけ・区だけ・路線・範囲・通勤・読めない語）
    const kinds = (c: Cust) => { const a = parseAreaWant(c.desired_area, [c.preferences, c.other_requests].filter(Boolean).join(NL)); return [a.stations.length > 0, a.wards.length > 0, a.lines.length > 0, a.regions.length > 0, parseCommuteWants(c).length > 0, a.unread.length > 0].map(Number).join(""); };
    const seen = new Map<string, number>();
    const chosen: Cust[] = [];
    for (const c of picked) { const k = kinds(c); const n = seen.get(k) ?? 0; if (n < 3 && chosen.length < limit) { chosen.push(c); seen.set(k, n + 1); } }
    for (const c of chosen) {
      const a = parseAreaWant(c.desired_area, [c.preferences, c.other_requests].filter(Boolean).join(NL));
      const cm = parseCommuteWants(c);
      console.log(`${NL}[${c.id.slice(0, 8)}] 「${safe(String(c.desired_area ?? "")).slice(0, 70)}」 通勤=${cm.map((x) => `${x.target}:${x.minutes ?? "-"}`).join("/") || "-"}`);
      for (const [name, text] of SAMPLES) {
        const loc = buildPropertyLocation(name, text);
        const am = matchArea(a, loc);
        const cms = matchCommute(cm, loc);
        console.log(`   ${name} → ${am ? `${am.code}（${am.why}）` : "札なし"}${cms.length ? " ｜ " + cms.slice(0, 2).map((x) => `${x.code}（${x.why}）`).join(" ") : ""}`);
      }
    }
  }

  if (process.argv.includes("--pickups")) {
    const limit = Number(arg("limit") ?? "20");
    const { data: pk, error } = await sb.from("property_pickups").select("id, property_customer_id, summary_text, pdf_text").not("pdf_text", "is", null).order("id", { ascending: false }).limit(600);
    if (error) { console.error(error.message); process.exit(1); }
    const byCust = new Map<string, Array<{ id: number; summary_text: string; pdf_text: string }>>();
    for (const r of (pk ?? []) as Array<{ id: number; property_customer_id: string | null; summary_text: string; pdf_text: string }>) {
      if (!r.property_customer_id) continue;
      byCust.set(r.property_customer_id, [...(byCust.get(r.property_customer_id) ?? []), r]);
    }
    const custById = new Map(all.map((c) => [c.id, c]));
    const codeCount: Record<string, number> = {};
    let shown = 0, props = 0, located = 0, wardByAddr = 0;
    for (const [cid, items] of byCust) {
      const c = custById.get(cid);
      if (!c) continue;
      const area = parseAreaWant(c.desired_area, [c.preferences, c.other_requests].filter(Boolean).join("\n"));
      const cm = parseCommuteWants(c);
      const p = buildCustomerProfile(c);
      const head = shown < limit;
      if (head) console.log(`\n[${cid.slice(0, 8)}] 希望エリア「${safe(String(c.desired_area ?? "")).slice(0, 60)}」 通勤=${cm.map((x) => `${x.target}:${x.minutes ?? "-"}`).join("/") || "-"} 間取り=${safe(String(c.floor_plan ?? ""))}${p.floorPlanAlt ? `（も可 ${p.floorPlanAlt.plans.join("/")}）` : ""} 下限=${p.rentMin ?? "-"}`);
      for (const it of items.slice(0, 18)) {
        props++;
        const loc = buildPropertyLocation(it.summary_text, it.pdf_text);
        if (loc.point) located++;
        if (loc.wardSource === "address") wardByAddr++;
        const am = matchArea(area, loc);
        const cms = matchCommute(cm, loc);
        const codes = locationReasonCodes(am, cms);
        for (const k of codes) codeCount[k] = (codeCount[k] ?? 0) + 1;
        const facts = parsePropertyFacts(it.summary_text);
        if (facts.areaSqm == null) { const a = parseListingText(it.pdf_text).areaSqm; if (a != null) facts.areaSqm = a; }
        const j = judgeProperty(facts, p, 0, { locationCodes: codes });
        const extra = j.reasonCodes.filter((x) => /^(RENT_BELOW_MIN|FLOOR_PLAN_ALT_MATCH|SQM_|BUILDING_AGE_TEXT)/.test(x));
        if (head) console.log(`   #${it.id} ${safe(it.summary_text.split("\n")[0]).slice(0, 24)} 📍${loc.stations.slice(0, 2).map((s) => `${s.station}${s.walk ?? "?"}分`).join("・") || "駅?"}・${(loc.ward ?? "区?").replace(/^大阪市/, "")}(${loc.wardSource ?? "-"}) → ${am ? `${am.code}（${am.why}）` : "エリア札なし"} ｜ ${cms.map((x) => `${x.code}（${x.why}）`).join(" ") || "通勤なし"}${extra.length ? ` ｜ ${extra.join(",")}` : ""}`);
      }
      if (head) shown++;
    }
    console.log(`\n=== 保存済みの物件に当てた結果: ${props}件・位置が取れた ${located}件・区を住所から ${wardByAddr}件 ===`);
    console.log(codeCount);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
