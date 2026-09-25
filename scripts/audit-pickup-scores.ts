// scripts/audit-pickup-scores.ts
// 売上サポ（property_pickups）の点数と札を監査する（読むだけ・DB に書かない・DeepSeek を呼ばない）。
//   本番の recordPickupBatch と同じ材料（説明文を資料の文字層で補う → AD 補い → 募集の条件 → 広さ → 設備 → 場所）で judgeProperty を当て直し、
//   札ごとに資料の文字の該当行と並べて出す（目で読む用）。
//   送付済みの照合は行ができた時点より前の送付だけ（後から送った物で自分自身が送付済みにならないように）。
//   npx tsx --env-file=.env.local scripts/audit-pickup-scores.ts [--ids=50,51]
import { createClient } from "@supabase/supabase-js";
import { extractPdfText } from "../app/lib/pdf-text";
import { enrichSummariesFromPdf } from "../app/lib/pickup-rank";
import { parseAdFromText } from "../app/lib/property-pickups";
import { buildCustomerProfile, judgeProperty, parsePropertyFacts, fillFactsFromTerms, reasonPoints, BASE_SCORE, SCORE_MAX, type SentRowLike, type PatternRowLike } from "../app/lib/property-brain";
import { buildBatchEquipment } from "../app/lib/pickup-equipment";
import { parseListingTerms } from "../app/lib/listing-terms";
import { parseListingText, normalizeListingText } from "../app/lib/listing-text";
import { parseAreaWant, parseCommuteWants, buildPropertyLocation, matchArea, matchCommute, locationReasonCodes } from "../app/lib/area-want";
import { loadCustomerProfit } from "../app/lib/estimate-profit-server";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const idsArg = process.argv.find((a) => a.startsWith("--ids="))?.slice(6).split(",").map(Number);

async function b64Of(url: string | null): Promise<string | null> {
  if (!url) return null;
  try { const r = await fetch(url); if (!r.ok) return null; return Buffer.from(await r.arrayBuffer()).toString("base64"); } catch { return null; }
}
/** 資料の文字の該当行（目で見る用） */
function grab(text: string, re: RegExp, n = 1): string {
  const lines = normalizeListingText(text).split("\n");
  const out: string[] = [];
  lines.forEach((l, i) => { if (re.test(l) && out.length < n) out.push([l, lines[i + 1] ?? ""].join(" ⏎ ").slice(0, 110)); });
  return out.join(" | ") || "－";
}

type Row = Record<string, any>;

async function main() {
  let q = sb.from("property_pickups").select("id, created_at, batch_id, property_customer_id, conversation_id, site, rank, summary_text, pdf_text, pdf_blob_url, score, verdict, reason_codes, recommended").order("id");
  if (idsArg) q = q.in("id", idsArg);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = data as Row[];
  const byBatch = new Map<string, Row[]>();
  for (const r of rows) { if (!byBatch.has(r.batch_id)) byBatch.set(r.batch_id, []); byBatch.get(r.batch_id)!.push(r); }
  const summaryOut: Row[] = [];
  for (const [batch, rs] of byBatch) {
    const created = rs[0].created_at as string;
    const pcid = rs[0].property_customer_id as string | null;
    const b64s = await Promise.all(rs.map((r) => b64Of(r.pdf_blob_url)));
    const texts = await Promise.all(rs.map(async (r, k) => r.pdf_text || (b64s[k] ? (await extractPdfText(b64s[k]!, { maxPages: 2, maxChars: 8000 })).text || null : null)));
    const summaries = await enrichSummariesFromPdf(rs.map((r) => r.summary_text), b64s, "audit");
    let profile: ReturnType<typeof buildCustomerProfile> | null = null;
    let customer: Row | null = null;
    let loc: Row | null = null;
    if (pcid) {
      const since = new Date(new Date(created).getTime() - 180 * 86400_000).toISOString();
      const [c, s, p, cv] = await Promise.all([
        sb.from("property_customers").select("rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet, move_in_time, created_at, floor_area_min, raw_format_text, desired_area, commute_station, commute_minutes").eq("id", pcid).maybeSingle(),
        sb.from("sent_properties").select("property_name, rent, delivery, source, room_no, sent_at").eq("property_customer_id", pcid).gte("sent_at", since).lt("sent_at", created).limit(500),
        sb.from("property_selection_patterns").select("selling_points, selection_label, created_at").eq("property_customer_id", pcid).lt("created_at", created).order("created_at", { ascending: false }).limit(60),
        sb.from("conversations").select("id").eq("property_customer_id", pcid).limit(10),
      ]);
      customer = c.data as Row | null;
      if (customer) {
        const profit = await loadCustomerProfit({ propertyCustomerId: pcid, conversationIds: ((cv.data ?? []) as Row[]).map((x) => x.id) });
        profile = buildCustomerProfile(customer, (s.data ?? []) as SentRowLike[], (p.data ?? []) as PatternRowLike[], profit.discountMedianYen, { today: created });
        const area = parseAreaWant(customer.desired_area, [customer.preferences, customer.other_requests].filter(Boolean).join("\n"));
        const commute = parseCommuteWants(customer);
        loc = area.any || commute.length ? { area, commute } : null;
        console.log(`\n######## batch ${batch.slice(0, 50)} created ${created.slice(0, 16)} site ${rs[0].site} 顧客 ${pcid.slice(0, 8)} 送付(前) ${(s.data ?? []).length} パターン ${(p.data ?? []).length} 割引 ${profile.discountYen}`);
        console.log(`  条件: 家賃 ${customer.rent_min ?? "-"}〜${customer.rent_max ?? customer.max_rent ?? "-"} 間取り「${customer.floor_plan ?? customer.layout ?? ""}」 徒歩 ${customer.walk_minutes ?? "-"} 築 ${customer.building_age ?? "-"} 広さ ${customer.floor_area_min ?? "-"} 初期上限 ${customer.initial_cost_limit ?? "-"} ペット ${customer.pet} 入居「${customer.move_in_time ?? ""}」 エリア「${customer.desired_area ?? ""}」 通勤「${customer.commute_station ?? ""} ${customer.commute_minutes ?? ""}」`);
        console.log(`  自由文: ${[customer.preferences, customer.other_requests, customer.ng_points, customer.additional_conditions].filter(Boolean).join(" / ").replace(/\n/g, " ").slice(0, 400)}`);
        console.log(`  profile: rentMax ${profile.rentMax} rentMin ${profile.rentMin} plan ${JSON.stringify(profile.floorPlanWant.plans)} min ${profile.floorPlanWant.minRank} alt ${JSON.stringify(profile.floorPlanAlt?.plans ?? null)} sqm ${profile.sqmMin} walk ${profile.walkMax} age ${profile.buildingAgeMax} ageText ${JSON.stringify(profile.ageTextMax)} lowInit ${profile.wantsLowInitialCost}(${profile.lowInitialCostSource}) imageWants ${profile.imageWants.join(",")} moveIn ${JSON.stringify(profile.moveInWant)} cond ${profile.conditionWants?.join(",")} sentBld ${profile.history.sentBuildings.size} ratioMed ${profile.history.rentRatioMedian}`);
        console.log(`  エリア: ${JSON.stringify(loc?.area ?? null).slice(0, 400)} 通勤: ${JSON.stringify(loc?.commute ?? null).slice(0, 200)}`);
        console.log(`  設備の希望: ${JSON.stringify(eqWantsOf(customer)).slice(0, 400)}`);
      }
    } else console.log(`\n######## batch ${batch.slice(0, 50)} created ${created.slice(0, 16)} 顧客なし（判定なし・事実だけ）`);
    const eq = buildBatchEquipment(rs.map((_, k) => ({ key: `k${k}`, pdfText: texts[k], label: `【${k + 1}】` })), customer as never);
    const eqOf = new Map(eq.rows.map((r) => [r.key, r]));
    rs.forEach((r, k) => {
      const text = texts[k] ?? "";
      const facts = parsePropertyFacts(summaries[k]);
      if (facts.adMonths == null && facts.adYen == null && text) { const ad = parseAdFromText(text); if (ad.adMonths != null) facts.adMonths = ad.adMonths; else if (ad.adYen != null) facts.adYen = ad.adYen; }
      const t = text ? parseListingTerms(text, { today: created }) : null;
      const filled = t ? fillFactsFromTerms(facts, t) : [];
      if (facts.areaSqm == null && text) { const a = parseListingText(text).areaSqm; if (a != null) facts.areaSqm = a; }
      const pl = buildPropertyLocation(summaries[k], text);
      const am = loc ? matchArea(loc.area, pl) : null;
      const cm = loc ? matchCommute(loc.commute, pl) : [];
      const codesLoc = loc ? locationReasonCodes(am, cm) : [];
      const e = eqOf.get(`k${k}`);
      const j = profile ? judgeProperty(facts, profile, k, { equipment: e?.match ?? null, terms: t, today: created, locationCodes: codesLoc }) : null;
      const sum = j ? BASE_SCORE + j.reasonCodes.reduce((a, c) => a + reasonPoints(c), 0) : null;
      console.log(`\n--- id ${r.id} 【${r.rank}】 rec ${r.recommended} 保存: ${r.score}点 ${r.verdict} → 今: ${j?.score ?? "-"}点 ${j?.verdict ?? "-"}（素点 ${sum}${sum != null && sum > SCORE_MAX ? " 上限で切れ" : ""}）`);
      console.log(`  説明文: ${summaries[k].replace(/\n/g, " / ")}`);
      console.log(`  事実: 家賃 ${facts.rentYen} 管理 ${facts.adminFeeYen} 敷 ${facts.depositMonths} 礼 ${facts.keyMoneyMonths} 間取 ${facts.floorPlan} ㎡ ${facts.areaSqm} 築 ${facts.buildingAge} 徒歩 ${facts.walkMinutes} AD ${facts.adMonths}ヶ月/${facts.adYen}円 （資料で埋め: ${filled.join(",") || "-"}）`);
      if (t) console.log(`  terms: 敷 ${t.depositMonths}(${t.depositYen ?? ""}) 礼 ${t.keyMoneyMonths}(${t.keyMoneyYen ?? ""}) 保証金 ${t.guaranteeDeposit} 築 ${t.builtYear}/${t.builtMonth}=${t.buildingAgeYears}年 入居 ${JSON.stringify(t.moveIn)} 契約 ${t.contract.kind} 更新 ${t.renewalFee.kind} FR ${JSON.stringify(t.freeRent)}`);
      console.log(`  場所: ${JSON.stringify(pl.stations).slice(0, 250)} 区 ${pl.ward}  area ${am ? `${am.code} ${JSON.stringify(am).slice(0, 200)}` : "-"}  通勤 ${cm.map((c) => `${c.code} ${c.why}`).join(" ; ")}`);
      if (e) console.log(`  設備: ${JSON.stringify(e.saved).slice(0, 400)}`);
      if (j) console.log(`  札: ${j.reasonCodes.map((c) => `${c}(${reasonPoints(c)})`).join(" ")}`);
      console.log(`  保存札: ${(r.reason_codes ?? []).join(" ")}`);
      if (text) {
        console.log(`  資料 賃料: ${grab(text, /^賃料/)}  管理: ${grab(text, /管理費|共益費/)}`);
        console.log(`  資料 敷礼: ${grab(text, /敷金|礼金/, 2)}`);
        console.log(`  資料 間取/㎡: ${grab(text, /間取|専有面積/, 2)}  築: ${grab(text, /^築年/)}  階: ${grab(text, /号室名|所在階|階建/, 2)}`);
        console.log(`  資料 入居: ${grab(text, /入居|現況/)}  交通: ${grab(text, /^交通/)}`);
        console.log(`  資料 AD: ${grab(text, /A\s*D\s*\d|広告費|広告料/i, 3)}`);
        console.log(`  資料 設備: ${grab(text, /^設\s*備|^設備/, 1)}`);
      }
      summaryOut.push({ id: r.id, b: batch.slice(0, 12), rank: r.rank, rec: r.recommended, saved: r.score, now: j?.score ?? null, raw: sum, v: j?.verdict ?? null, ad: facts.adMonths ?? (facts.adYen && facts.rentYen ? +(facts.adYen / facts.rentYen).toFixed(2) : null) });
    });
  }
  console.log("\n\n==== 一覧 JSON ====\n" + JSON.stringify(summaryOut));
}

function eqWantsOf(c: Row) {
  // 画面と同じ設備の希望の読み（buildBatchEquipment の wants）
  return buildBatchEquipment([], c as never).wants.wants.map((w) => `${w.key}${w.mode === "ng" ? "(NG)" : ""}${w.strong ? "!" : ""}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
