// scripts/yuma-condition-leak-test.ts — 条件の種類ごとに「物件のどこに出たか」を YUMA で確かめる（どこにも出ない種類＝漏れ）
//
// 2026-09-24 竹内「YUMA でテストお願い。ほかにもれないか」（HONOKA さんの件: 宅配BOX・エレベーターが条件欄にあるのに物件の照合で見ていなかった）
//
// やること:
//   ① テスト用の物件顧客（customer_name「YUMA_LEAK_TEST」）に、条件の種類を全部入れる（scripts/audit-condition-coverage.ts の KINDS）
//   ② 既存の物件資料（property_pickups の pdf_blob_url・リアプロと itandi の両方）を借りる。お客様の情報は持ってこない
//      （説明文の 🌟・🧠 の行は外して番号を振り直す／pdf_url は渡さない＝本番の sent_properties に AD を書きに行かない）
//   ③ 本番と同じ recordPickupBatch（app/lib/property-pickups-server.ts）に通す → property_pickups に行ができる
//   ④ 条件の種類ごとに「判定の札（reason_codes）／設備の照合（equipment.match）／🌟 に渡る条件の文／画像で分析の希望（wants）」の
//      どこに出たかを表にし、どこにも出ない種類を「漏れ」として出す。売上サポに「照らせない条件」として表示だけされた物も分けて出す
//
// 実行（既定は --dry-run: DB に書かない・DeepSeek を呼ばない）:
//   npx tsx --env-file=.env.local scripts/yuma-condition-leak-test.ts                 # dry-run: 資料を読んで、本番と同じ純関数（設備の照合・判定）だけ当てた表
//   npx tsx --env-file=.env.local scripts/yuma-condition-leak-test.ts --apply         # テスト顧客を作り recordPickupBatch に通す（DeepSeek は呼ばない）
//   npx tsx --env-file=.env.local scripts/yuma-condition-leak-test.ts --apply --with-analysis
//                                                                                     # 上に加えて 🌟（rankAndAnnotateSummaries）・資料の画像の読み取り・🔍 画像で分析（analyzePickupRow）を DeepSeek で通す
//   npx tsx --env-file=.env.local scripts/yuma-condition-leak-test.ts --cleanup       # 作った物を全部消す
// オプション: --limit=N（リアプロ・itandi から各 N 件・既定 3） --no-yuma（property_pickups を YUMA の会話に付けない）
//
// DeepSeek を呼ばない仕組み: --with-analysis が無い時は process.env.DEEPSEEK_API_KEY を空にしてから本番の関数を呼ぶ
//   （readPropertyImageDetail・readFloorPlanFacts・callDeepSeek は鍵が無いと呼ばずに空を返す＝費用 0）
// Blob: .env.local に BLOB_READ_WRITE_TOKEN が無いと recordPickupBatch の put が失敗し、行の pdf_blob_url・画像は空のまま（文字層・設備・判定は動く）。
//   --with-analysis の時は、画像で分析が資料を開けるように、空の pdf_blob_url に借りた資料の URL を入れる（テストの行だけ）
// 消す物（--cleanup）: property_pickups（batch_id like 'YUMA_leak_%'）・その行を元にした property_sheet_facts（source_pickup_id）と
//   保存した判定（wants_judged）の書き足し（実行前の写しで戻す）・image_details（テストの行の画像 URL）・property_brain_judgments・
//   テスト顧客（property_customers）とその sent_properties／property_condition_history・Blob（pickups/YUMA_leak_… の URL だけ）
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KINDS, buildCtx, buildCustomerConditionsString, type CustomerRow, type Kind, type Ctx } from "./audit-condition-coverage";
import { buildCustomerProfile, judgeProperty, parsePropertyFacts, fillFactsFromTerms } from "../app/lib/property-brain";
import { parseListingTerms } from "../app/lib/listing-terms";
import { buildBatchEquipment, type PickupEquipment } from "../app/lib/pickup-equipment";
import { extractImageWants, dedupeWantsByTopic, type ImageWant, type WantCheck } from "../app/lib/image-wants";
import { extractPdfText } from "../app/lib/pdf-text";
import { parseAdFromText } from "../app/lib/property-pickups";
import { enrichSummariesFromPdf } from "../app/lib/pickup-rank";
import { parseAreaWant, parseCommuteWants, buildPropertyLocation, matchArea, matchCommute, locationReasonCodes, toPickupLocation, type PickupLocation } from "../app/lib/area-want";
import { parseListingText } from "../app/lib/listing-text";
import { buildConditionSummary, uncheckableLabels, formatSummaryLine } from "../app/lib/condition-summary";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(`--${k}`);
const arg = (k: string) => (argv.find((a) => a.startsWith(`--${k}=`)) ?? "").split("=").slice(1).join("=") || null;
const APPLY = flag("apply");
const WITH_ANALYSIS = flag("with-analysis");
const CLEANUP = flag("cleanup");
const LIMIT = Math.max(1, Math.min(10, Number(arg("limit") ?? "3")));
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const LINK_YUMA = !flag("no-yuma");
const TEST_NAME = "YUMA_LEAK_TEST";
const BATCH_PREFIX = "YUMA_leak_";
const STATE_FILE = join(tmpdir(), "yuma-condition-leak-state.json");

// ───────────────────────── テスト顧客（条件の種類を全部入れる） ─────────────────────────

/**
 * 1つの節に1つの種類が入るように書く（どの種類がどこに出たかを見分けるため）。
 * 資料は難波（リアプロ）・東淀川/淀川区（itandi）なので、エリアはその駅にしてある（検索で絞った後の資料という前提）
 */
export const TEST_CUSTOMER: CustomerRow & Record<string, unknown> = {
  customer_name: TEST_NAME,
  status: "property_search",
  rent_min: 50_000,
  rent_max: 80_000,
  desired_area: "難波駅・西中島南方駅",
  area_mode: "station",
  walk_minutes: 10,
  floor_plan: "1K",
  floor_area_min: 25,
  building_age: 15,
  initial_cost_limit: 150_000,
  move_in_time: "即入居",
  pet: true,
  commute_station: "梅田駅",
  commute_minutes: 20,
  structure_types: "RC造",
  preferences: [
    "オートロック", "宅配ボックス", "エレベーター", "バストイレ別", "独立洗面台", "室内洗濯機置場", "2階以上", "南向き",
    "駐車場", "駐輪場", "二人入居可", "ネット無料", "築浅", "内装が綺麗", "1DKも可", "電子ピアノ（楽器可）", "保証人不要", "フリーレント", "25平米以上", "広めのリビング",
  ].join("・"),
  ng_points: "1階NG・木造NG・定期借家NG・3点ユニットNG",
  other_requests: [
    "敷金礼金なし", "初期費用を抑えたい", "管理費込み8万以内", "法人契約", "外国籍可", "梅田まで電車20分", "スーパー近く", "更新料なし",
    "西中島南方より北のエリア", "駅近", "審査が不安", "家具家電付き", "喫煙可",
  ].join("、"),
  additional_conditions: null,
  raw_format_text: "▶︎【お部屋お探し中！】\n①【ご入居の時期】⇒即入居\n②【ご希望の家賃】⇒5万〜8万\n③【ご希望のエリア】⇒難波・西中島南方\n④【駅徒歩】⇒10分\n⑤【ご希望の間取り】⇒1K・1DKも可",
};

// ───────────────────────── 資料を借りる ─────────────────────────

type SrcRow = { id: number; site: string; summary_text: string; pdf_blob_url: string; property_name: string };

async function loadSources(): Promise<Record<"realpro" | "itandi", SrcRow[]>> {
  const out: Record<"realpro" | "itandi", SrcRow[]> = { realpro: [], itandi: [] };
  for (const site of ["realpro", "itandi"] as const) {
    const { data, error } = await sb.from("property_pickups").select("id, site, summary_text, pdf_blob_url, property_name, batch_id")
      .eq("site", site).not("pdf_blob_url", "is", null).not("batch_id", "like", `${BATCH_PREFIX}%`).not("batch_id", "like", "YUMA_%")
      .order("id", { ascending: false }).limit(40);
    if (error) throw new Error(error.message);
    // 同じ資料を2回使わない
    const seen = new Set<string>();
    for (const r of (data ?? []) as Array<SrcRow & { batch_id: string }>) {
      if (seen.has(r.pdf_blob_url)) continue;
      seen.add(r.pdf_blob_url);
      out[site].push({ id: r.id, site, summary_text: r.summary_text, pdf_blob_url: r.pdf_blob_url, property_name: r.property_name });
      if (out[site].length >= LIMIT) break;
    }
  }
  return out;
}

/** 説明文の 🌟 の印と 🧠 の行を外して【N】を振り直す（本番の merge-pdfs に届く前の形） */
function cleanSummary(s: string, n: number): string {
  return String(s ?? "").replace(/^【\d+[^】]*】/u, `【${n}】`).replace(/\n\s*🧠[\s\S]*$/u, "").trim();
}

async function fetchBase64(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer()).toString("base64");
  } catch { return null; }
}

// ───────────────────────── 種類ごとに「どこに出たか」 ─────────────────────────

type ResultRow = { site: string; rank: number; summary: string; reasonCodes: string[]; equipment: PickupEquipment | null; analysisChecks?: WantCheck[] | null; location?: PickupLocation | null };
// 2026-09-25 判定の穴埋め後: judged＝判定がこの種類を読んでいる（札が付かないのは今回の物件が範囲内なだけ 例: 家賃下限）／
//   uncheckShown＝売上サポの「📝 条件の要約」の照らせない条件に出る（condition-summary）／loc＝📍（property_pickups.location）に照合が出た物件数／notNeeded＝喫煙・家具家電（竹内さんが不要と言った）
type Seen = { kind: Kind; inCustomer: string | null; codes: number; noMaterial: number; equip: number; rank: boolean; wants: string[]; analysisDecided: number; shownUncovered: boolean; judged: boolean; uncheckShown: boolean; loc: number; notNeeded: boolean };

/**
 * 判定はあるのに物件側の値が読めていない（材料なし）かを種類ごとに見る。説明文を本番と同じ parsePropertyFacts で読む。
 * 2026-09-24 実測: property_pickups 36行中 33行が INITIAL_COST_UNKNOWN（敷金・礼金が説明文に無く、資料の文字層から補っていない）・築年の札は 0行
 */
const MATERIAL: Record<string, (summary: string, codes: string[]) => boolean> = {
  rent_max: (s) => parsePropertyFacts(s).rentYen != null,
  admin_fee: (s) => parsePropertyFacts(s).adminFeeYen != null,
  // 2026-09-25: 敷礼・築年は資料の表（listing-terms）で埋める → 判定の札で見る（説明文に無くても INITIAL_COST_UNKNOWN が付かなければ材料あり）
  initial_cost: (s, codes) => !codes.includes("INITIAL_COST_UNKNOWN") || (() => { const f = parsePropertyFacts(s); return f.depositMonths != null && f.keyMoneyMonths != null; })(),
  zero_zero: (s, codes) => !codes.includes("INITIAL_COST_UNKNOWN") || (() => { const f = parsePropertyFacts(s); return f.depositMonths != null && f.keyMoneyMonths != null; })(),
  walk: (s) => parsePropertyFacts(s).walkMinutes != null,
  floor_plan: (s) => parsePropertyFacts(s).floorPlan != null,
  floor_plan_text_only: (s) => parsePropertyFacts(s).floorPlan != null,
  building_age: (s, codes) => codes.some((c) => /^BUILDING_AGE_/.test(c)) || parsePropertyFacts(s).buildingAge != null,
  // 2026-09-25: 正規表現の「\」が抜けていて常に「材料なし」だった。広さは資料の文字層でも埋める（SQM_ の札が付けば材料あり）
  area_sqm: (s, codes) => codes.some((c) => /^SQM_(?!UNKNOWN)/.test(c)) || /\d+(?:\.\d+)?\s*(?:㎡|m2|平米)/i.test(s.normalize("NFKC")),
};

/** 設備の照合の「設備」の種類から外すキー（別の種類で数える） */
const OTHER_EQUIP_KEYS = new Set(["floor", "floor2", "top_floor", "south", "rc", "not_wood", "pet", "two_person", "no_guarantor", "parking", "bike_parking"]);

function whereShown(x: Ctx, rows: ResultRow[], wants: ImageWant[]): Seen[] {
  return KINDS.map((k) => {
    const inCustomer = k.present(x);
    // 札・設備の行は、その種類を判定・設備が本当に読んでいる時だけ数える（「1DKも可」は列の 1K の札が付いても届いていない）
    const seesIt = !!(k.J?.(x) || k.E?.(x));
    const codes = k.codeRe && seesIt ? rows.filter((r) => r.reasonCodes.some((c) => (k.codeRe as RegExp).test(c) && !/_UNKNOWN$/.test(c))).length : 0;
    const noMaterial = MATERIAL[k.id] && seesIt ? rows.filter((r) => !MATERIAL[k.id](r.summary, r.reasonCodes)).length : 0;
    const equip = !k.E?.(x) ? 0 : rows.filter((r) => (r.equipment?.match ?? []).some((m) => (k.id === "equipment" ? !OTHER_EQUIP_KEYS.has(m.key) : (k.equipKeys ?? []).includes(m.key)))).length;
    const rank = !!k.R?.(x);
    const ev = inCustomer ?? "";
    const wantHits = wants.filter((w) => (k.wantRe ? k.wantRe.test(w.text) : false) || (ev.length >= 2 && !/^[a-z_]+=/.test(ev) && w.text.includes(ev.slice(0, 6)))).map((w) => w.id);
    const analysisDecided = rows.filter((r) => (r.analysisChecks ?? []).some((c) => wantHits.includes(c.id) && c.result !== "unknown")).length;
    const shownUncovered = rows.some((r) => (r.equipment?.uncovered ?? []).some((u) => ev && u.includes(ev.slice(0, 4))));
    const judged = !!k.J?.(x);
    const uncheckShown = !!k.U?.(x);
    const isLoc = ["area", "area_multi", "area_text", "commute"].includes(k.id);
    const loc = !isLoc ? 0 : rows.filter((r) => k.id === "commute" ? (r.location?.commute ?? []).length > 0 : !!r.location?.area).length;
    return { kind: k, inCustomer, codes, noMaterial, equip, rank, wants: wantHits, analysisDecided, shownUncovered, judged, uncheckShown, loc, notNeeded: !!k.notNeeded };
  });
}

/** 旧基準（2026-09-24 の漏れテスト）: 札・設備・🌟・画像のどこにも出ない＝漏れ（「照らせない条件」の表示だけ・不要も漏れに数えていた） */
function oldLeak(s: Seen): boolean { return !(s.codes > 0 || s.equip > 0 || s.rank || s.wants.length > 0); }
/** 今の基準: 札・設備・📍・判定が読んでいる・画像・照らせない条件に表示・🌟・不要 のどれにも無い＝漏れ（audit-condition-coverage と同じ見方） */
function verdictOf(s: Seen): { leak: boolean; ja: string } {
  if (s.notNeeded) return { leak: false, ja: "不要（喫煙・家具家電）" };
  if (s.codes > 0 || s.equip > 0 || s.loc > 0) return { leak: false, ja: s.noMaterial > 0 && s.codes === 0 ? "届いた（札は材料なし）" : "届いた（札・設備・📍）" };
  if (s.judged) return { leak: false, ja: "判定が読んでいる（今回の物件は札の対象外）" };
  if (s.wants.length > 0) return { leak: false, ja: "画像で分析の希望" };
  if (s.uncheckShown || s.shownUncovered) return { leak: false, ja: "照らせない条件に表示" };
  if (s.rank) return { leak: false, ja: "🌟 の文だけ" };
  return { leak: true, ja: s.noMaterial > 0 ? "漏れ（判定はあるが材料なし）" : "漏れ" };
}

function printTable(seen: Seen[], nRows: number, analysis: boolean) {
  console.log(`\n=== 条件の種類ごとに「どこに出たか」（物件 ${nRows}件） ===`);
  console.log("札=判定の札が付いた物件数（_UNKNOWN は除く） 材料なし=物件側の値が読めない物件数 設備=設備の照合 📍=場所の照合 🌟=順位付けの文 画像=画像で分析の希望 判定=判定がこの種類を読む 照らせない=📝 の照らせない条件" + (analysis ? " 分析=画像で分析で ok/ng が決まった物件数" : ""));
  console.log(["種類", "テスト顧客", "札", "材料なし", "設備", "📍", "🌟", "画像", "判定", "照らせない", ...(analysis ? ["分析"] : []), "旧基準", "結果"].join("\t"));
  const leaks: Seen[] = [];
  const oldLeaks: Seen[] = [];
  for (const s of seen) {
    if (!s.inCustomer) { console.log([s.kind.label, "（入っていない）"].join("\t")); continue; }
    const v = verdictOf(s);
    if (v.leak) leaks.push(s);
    if (oldLeak(s)) oldLeaks.push(s);
    console.log([s.kind.label, s.inCustomer.slice(0, 18), s.codes, s.noMaterial, s.equip, s.loc, s.rank ? "○" : "－", s.wants.join(",") || "－", s.judged ? "○" : "－", s.uncheckShown ? "○" : "－", ...(analysis ? [s.analysisDecided] : []), oldLeak(s) ? "漏れ" : "－", v.ja].join("\t"));
  }
  console.log(`\n■ 旧基準の漏れ（札・設備・🌟・画像のどこにも出ない）${oldLeaks.length}種類`);
  for (const s of oldLeaks) console.log(`  - ${s.kind.label} → 今: ${verdictOf(s).ja}`);
  console.log(`\n■ 今の基準の漏れ（どこにも出ない・表示もされない）${leaks.length}種類`);
  for (const s of leaks) console.log(`  - ${s.kind.label}（テスト顧客: ${s.inCustomer}）— 物件側: ${s.kind.sheet}【${s.kind.readable}】`);
  const noMat = seen.filter((s) => s.inCustomer && s.noMaterial > 0);
  if (noMat.length) {
    console.log(`\n■ 判定はあるのに物件側の値が読めない（材料なし）種類 ${noMat.length}種類`);
    for (const s of noMat) console.log(`  - ${s.kind.label}: ${s.noMaterial}/${nRows}件で読めない（物件側: ${s.kind.sheet}）`);
  }
}

/** 📝 条件の要約（決定論）と照らせない条件 */
function printSummary(c: Record<string, unknown>) {
  const s = buildConditionSummary(c as never);
  console.log(`\n📝 条件の要約（決定論）: ${formatSummaryLine(s.items) || "（なし）"}`);
  console.log(`   照らせない条件: ${uncheckableLabels(s).join("・") || "（なし）"}`);
  console.log(`   読めない節（DeepSeek の要約に回る）: ${[...s.unread, ...s.unchecked].join(" ／ ") || "（なし）"}`);
}

// ───────────────────────── dry-run（純関数だけ・書かない） ─────────────────────────

async function dryRun(src: Record<"realpro" | "itandi", SrcRow[]>) {
  const x = buildCtx(TEST_CUSTOMER);
  const profile = buildCustomerProfile(TEST_CUSTOMER);
  const areaW = parseAreaWant(TEST_CUSTOMER.desired_area as string, [TEST_CUSTOMER.preferences, TEST_CUSTOMER.other_requests].filter(Boolean).join("\n"));
  const commuteW = parseCommuteWants(TEST_CUSTOMER);
  const rows: ResultRow[] = [];
  for (const site of ["realpro", "itandi"] as const) {
    const list = src[site];
    const texts = await Promise.all(list.map(async (r) => {
      const b64 = await fetchBase64(r.pdf_blob_url);
      if (!b64) return null;
      const t = await extractPdfText(b64, { maxPages: 2, maxChars: 8000 });
      return t.text || null;
    }));
    // 本番の merge-pdfs と同じく、資料の文字層で説明文を補う（純 JS・外部 API なし）
    const b64s = await Promise.all(list.map((r) => fetchBase64(r.pdf_blob_url)));
    const summaries = await enrichSummariesFromPdf(list.map((r, k) => cleanSummary(r.summary_text, k + 1)), b64s, "yuma-leak");
    const eq = buildBatchEquipment(list.map((_, k) => ({ key: `k${k}`, pdfText: texts[k] })), TEST_CUSTOMER);
    const eqOf = new Map(eq.rows.map((r) => [r.key, r]));
    list.forEach((r, k) => {
      const facts = parsePropertyFacts(summaries[k]);
      if (facts.adMonths == null && facts.adYen == null && texts[k]) {
        const ad = parseAdFromText(texts[k] as string);
        if (ad.adMonths != null) facts.adMonths = ad.adMonths; else if (ad.adYen != null) facts.adYen = ad.adYen;
      }
      const e = eqOf.get(`k${k}`);
      // 本番の recordPickupBatch と同じ: 資料の表の募集の条件で敷礼・築年を埋め、入居時期・契約・入居の条件を判定に渡す
      const terms = texts[k] ? parseListingTerms(texts[k] as string) : null;
      if (terms) fillFactsFromTerms(facts, terms);
      if (facts.areaSqm == null && texts[k]) { const a = parseListingText(texts[k] as string).areaSqm; if (a != null) facts.areaSqm = a; }
      // 本番の recordPickupBatch と同じ: 物件の場所（説明文・文字層）× 希望のエリア・通勤（area-want・決定論）
      const loc = buildPropertyLocation(summaries[k], texts[k]);
      const am = matchArea(areaW, loc); const cm = matchCommute(commuteW, loc);
      const j = judgeProperty(facts, profile, k, { equipment: e?.match ?? null, terms, locationCodes: locationReasonCodes(am, cm) });
      const saved = toPickupLocation(loc, am, cm);
      rows.push({ site, rank: k + 1, summary: summaries[k], reasonCodes: j.reasonCodes, equipment: e?.saved ?? null, location: saved });
      console.log(`  [${site}] 【${k + 1}】${r.property_name}（資料 #${r.id}・文字層 ${texts[k] ? "あり" : "なし"}） ${j.verdict} ${j.score}点 札: ${j.reasonCodes.join(" ")}`);
      console.log(`      説明文: ${summaries[k].replace(/\n/g, " / ")}`);
      if (e?.saved.line) console.log(`      条件: ${e.saved.line}`);
      if (saved.line) console.log(`      ${saved.line}`);
    });
  }
  const wants = dedupeWantsByTopic(extractImageWants({ conditions: TEST_CUSTOMER }));
  console.log(`\n🌟 に渡る条件の文: ${buildCustomerConditionsString(TEST_CUSTOMER) ?? "（なし）"}`);
  console.log(`画像で分析の希望（条件欄だけ）: ${wants.map((w) => `${w.id}${w.ng ? "[NG]" : ""}${w.text}`).join(" ／ ")}`);
  printSummary(TEST_CUSTOMER);
  printTable(whereShown(x, rows, wants), rows.length, false);
}

// ───────────────────────── --apply ─────────────────────────

type State = { customerId: string | null; batchIds: string[]; sheetFactsBefore: Array<{ id: number; wants_judged: unknown; updated_at: string | null }> };
function saveState(s: State) { writeFileSync(STATE_FILE, JSON.stringify(s)); }
function loadState(): State | null { try { return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) as State : null; } catch { return null; } }

async function apply(src: Record<"realpro" | "itandi", SrcRow[]>) {
  if (!WITH_ANALYSIS) process.env.DEEPSEEK_API_KEY = ""; // 本番の関数が DeepSeek を呼ばずに空を返す（費用 0）
  const { recordPickupBatch } = await import("../app/lib/property-pickups-server");

  // 前回の残りを先に消す（同じ名前のテスト顧客を2つ作らない）
  await cleanup(true);
  const { data: cust, error: cErr } = await sb.from("property_customers").insert(TEST_CUSTOMER).select("id").single();
  if (cErr || !cust) throw new Error(`テスト顧客を作れない: ${cErr?.message}`);
  const customerId = (cust as { id: string }).id;
  const state: State = { customerId, batchIds: [], sheetFactsBefore: [] };
  if (WITH_ANALYSIS) {
    const { data: sf } = await sb.from("property_sheet_facts").select("id, wants_judged, updated_at").limit(5000);
    state.sheetFactsBefore = (sf ?? []) as State["sheetFactsBefore"];
  }
  saveState(state);
  console.log(`テスト顧客を作成: ${customerId.slice(0, 8)}…（${TEST_NAME}）`);

  const stamp = Date.now();
  for (const site of ["realpro", "itandi"] as const) {
    const list = src[site];
    if (!list.length) { console.log(`[${site}] 借りる資料が無い`); continue; }
    let summaries = list.map((r, k) => cleanSummary(r.summary_text, k + 1));
    const b64 = await Promise.all(list.map((r) => fetchBase64(r.pdf_blob_url)));
    // 本番の merge-pdfs と同じ順: 資料で説明文を補う（純 JS）→ 🌟（DeepSeek・--with-analysis の時だけ）
    summaries = await enrichSummariesFromPdf(summaries, b64, "yuma-leak");
    if (WITH_ANALYSIS) {
      const { rankAndAnnotateSummaries } = await import("../app/lib/pickup-rank");
      summaries = await rankAndAnnotateSummaries(summaries, buildCustomerConditionsString(TEST_CUSTOMER));
    }
    const batchId = `${BATCH_PREFIX}${stamp}_${site}.pdf`;
    state.batchIds.push(batchId);
    saveState(state);
    const res = await recordPickupBatch({
      batchId, propertyCustomerId: customerId, conversationId: LINK_YUMA ? YUMA : null, customerName: TEST_NAME, site,
      summaries,
      pdfUrls: list.map(() => null), // 本番の sent_properties（property_url 一致）に AD を書きに行かない
      pdfBase64List: b64,
    });
    console.log(`[${site}] recordPickupBatch: ${JSON.stringify(res)}`);
  }

  const { data: made } = await sb.from("property_pickups")
    .select("id, batch_id, site, rank, property_name, summary_text, pdf_url, pdf_blob_url, pdf_text, pdf_has_text, trim_image_url, page_image_url, image_analysis, reason_codes, reasons_ja, verdict, score, equipment, location, conversation_id")
    .like("batch_id", `${BATCH_PREFIX}${stamp}_%`).order("id");
  const madeRows = (made ?? []) as Array<Record<string, unknown>>;
  console.log(`\nproperty_pickups に ${madeRows.length}行（YUMA に${LINK_YUMA ? "付けた" : "付けていない"}）`);
  for (const r of madeRows) {
    const eq = r.equipment as PickupEquipment | null;
    console.log(`  #${r.id} [${r.site}] 【${r.rank}】${r.property_name} ${r.verdict} ${r.score}点 札: ${((r.reason_codes as string[] | null) ?? []).join(" ")}`);
    if (eq?.line) console.log(`      条件: ${eq.line}`);
    if (eq?.uncovered?.length) console.log(`      照らせない条件: ${eq.uncovered.join("・")}`);
    const lc = r.location as PickupLocation | null;
    if (lc?.line) console.log(`      ${lc.line}`);
  }

  // 画像で分析（本番の /api/property-pickups/analyze と同じ関数。希望は条件欄だけ＝会話は混ぜない）
  const wants = dedupeWantsByTopic(extractImageWants({ conditions: TEST_CUSTOMER }));
  const analysisOf = new Map<number, WantCheck[] | null>();
  if (WITH_ANALYSIS) {
    const srcUrls = [...src.realpro, ...src.itandi];
    for (const r of madeRows) {
      if (r.pdf_blob_url) continue;
      const s = (r.site === "realpro" ? src.realpro : src.itandi)[Number(r.rank) - 1] ?? srcUrls[0];
      await sb.from("property_pickups").update({ pdf_blob_url: s.pdf_blob_url }).eq("id", r.id as number);
      r.pdf_blob_url = s.pdf_blob_url;
    }
    const { analyzePickupRow } = await import("../app/lib/pickup-analyze-server");
    type Row = Parameters<typeof analyzePickupRow>[0];
    await Promise.all(madeRows.map(async (r) => {
      const out = await analyzePickupRow(r as unknown as Row, wants, { conversationId: LINK_YUMA ? YUMA : null });
      analysisOf.set(r.id as number, out.analysis?.checks ?? null);
      if (out.analysis) await sb.from("property_pickups").update({ image_analysis: { ...out.analysis, wants, analyzed_at: new Date().toISOString() } }).eq("id", r.id as number);
      console.log(`  🔍 #${r.id} ${out.analysis ? `${out.analysis.match ?? "要確認"}点 ${out.analysis.checks.map((c) => `${c.id}:${c.result}`).join(" ")}` : `読めない（${out.error}）`}`);
    }));
  }

  const x = buildCtx(TEST_CUSTOMER);
  const rows: ResultRow[] = madeRows.map((r) => ({
    site: String(r.site), rank: Number(r.rank), summary: String(r.summary_text ?? ""), reasonCodes: (r.reason_codes as string[] | null) ?? [],
    equipment: (r.equipment as PickupEquipment | null) ?? null, analysisChecks: analysisOf.get(r.id as number) ?? null,
    location: (r.location as PickupLocation | null) ?? null,
  }));
  printSummary(TEST_CUSTOMER);
  const { data: savedSum } = await sb.from("property_customers").select("condition_summary, condition_summary_hash").eq("id", customerId).maybeSingle();
  const cs = (savedSum as { condition_summary?: { ai?: unknown[]; model?: string | null } | null } | null)?.condition_summary;
  console.log(`   保存された要約: ${cs ? `あり（DeepSeek の要約 ${cs.ai?.length ?? 0}件・model ${cs.model ?? "なし"}）` : "なし"}`);
  console.log(`\n🌟 に渡る条件の文: ${buildCustomerConditionsString(TEST_CUSTOMER) ?? "（なし）"}`);
  console.log(`画像で分析の希望（条件欄だけ）: ${wants.map((w) => `${w.id}${w.ng ? "[NG]" : ""}${w.text}`).join(" ／ ")}`);
  printTable(whereShown(x, rows, wants), rows.length, WITH_ANALYSIS);
  console.log(`\n片付け: npx tsx --env-file=.env.local scripts/yuma-condition-leak-test.ts --cleanup`);
}

// ───────────────────────── --cleanup ─────────────────────────

async function cleanup(quiet = false) {
  const log = (s: string) => { if (!quiet) console.log(s); };
  const state = loadState();
  const { data: rowsData } = await sb.from("property_pickups").select("id, pdf_blob_url, page_image_url, agent_image_url, trim_image_url").like("batch_id", `${BATCH_PREFIX}%`);
  const rows = (rowsData ?? []) as Array<{ id: number; pdf_blob_url: string | null; page_image_url: string | null; agent_image_url: string | null; trim_image_url: string | null }>;
  const ids = rows.map((r) => r.id);
  const urls = [...new Set(rows.flatMap((r) => [r.pdf_blob_url, r.page_image_url, r.agent_image_url, r.trim_image_url]).filter((u): u is string => !!u))];
  // テストが作った Blob だけ（借りた資料の URL は消さない）
  const ownBlob = urls.filter((u) => /\/pickups\/(?:trim\/)?YUMA_leak_/.test(u));

  if (ids.length) {
    const sf = await sb.from("property_sheet_facts").delete().in("source_pickup_id", ids).select("id");
    log(`property_sheet_facts（テストの行を元にした読み取り）${(sf.data ?? []).length}行を消した${sf.error ? `（${sf.error.message}）` : ""}`);
  }
  // 保存した判定（wants_judged）の書き足しを実行前の写しに戻す
  if (state?.sheetFactsBefore?.length) {
    const { data: now } = await sb.from("property_sheet_facts").select("id, wants_judged").in("id", state.sheetFactsBefore.map((s) => s.id));
    let restored = 0;
    for (const n of (now ?? []) as Array<{ id: number; wants_judged: unknown }>) {
      const before = state.sheetFactsBefore.find((s) => s.id === n.id);
      if (!before || JSON.stringify(before.wants_judged) === JSON.stringify(n.wants_judged)) continue;
      await sb.from("property_sheet_facts").update({ wants_judged: before.wants_judged, updated_at: before.updated_at }).eq("id", n.id);
      restored++;
    }
    log(`property_sheet_facts の wants_judged を ${restored}行 実行前に戻した`);
  }
  const ownImageUrls = urls.filter((u) => ownBlob.includes(u));
  if (ownImageUrls.length) {
    const d = await sb.from("image_details").delete().in("image_url", ownImageUrls).select("image_url");
    log(`image_details ${(d.data ?? []).length}行を消した`);
  }
  if (ids.length) {
    const d = await sb.from("property_pickups").delete().in("id", ids).select("id");
    log(`property_pickups ${(d.data ?? []).length}行を消した${d.error ? `（${d.error.message}）` : ""}`);
  } else log("property_pickups: テストの行は無い");

  const { data: custs } = await sb.from("property_customers").select("id").eq("customer_name", TEST_NAME);
  const custIds = ((custs ?? []) as Array<{ id: string }>).map((c) => c.id);
  if (state?.customerId && !custIds.includes(state.customerId)) custIds.push(state.customerId);
  if (custIds.length) {
    for (const t of ["property_brain_judgments", "sent_properties", "property_condition_history", "property_selection_patterns"]) {
      const d = await sb.from(t).delete().in("property_customer_id", custIds).select("property_customer_id");
      if ((d.data ?? []).length) log(`${t} ${(d.data ?? []).length}行を消した`);
    }
    const d = await sb.from("property_customers").delete().in("id", custIds).select("id");
    log(`property_customers（${TEST_NAME}）${(d.data ?? []).length}行を消した${d.error ? `（${d.error.message}）` : ""}`);
  }
  const j = await sb.from("property_brain_judgments").delete().like("batch_key", `${BATCH_PREFIX}%`).select("id");
  if ((j.data ?? []).length) log(`property_brain_judgments（batch_key）${(j.data ?? []).length}行を消した`);

  if (ownBlob.length) {
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      const { del } = await import("@vercel/blob");
      await del(ownBlob);
      log(`Blob ${ownBlob.length}件を消した`);
    } else log(`⚠ Blob ${ownBlob.length}件は BLOB_READ_WRITE_TOKEN が無いので消せない（本番の環境変数で --cleanup をもう一度）`);
  }
  if (!quiet && existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
}

// ───────────────────────── main ─────────────────────────

async function main() {
  if (CLEANUP) { await cleanup(); return; }
  const src = await loadSources();
  console.log(`借りる資料: リアプロ ${src.realpro.length}件（#${src.realpro.map((r) => r.id).join(",#")}）・itandi ${src.itandi.length}件（#${src.itandi.map((r) => r.id).join(",#")}）`);
  const x = buildCtx(TEST_CUSTOMER);
  const missing = KINDS.filter((k) => !k.present(x) && !["rent_max_unreliable", "floor_plan_unparsed", "equipment_uncovered"].includes(k.id));
  if (missing.length) console.log(`⚠ テスト顧客に入っていない種類: ${missing.map((k) => k.label).join("・")}`);
  if (!APPLY) {
    console.log("\n--dry-run（DB に書かない・DeepSeek を呼ばない）: 本番と同じ純関数（設備の照合 buildBatchEquipment・判定 judgeProperty）だけ当てる");
    await dryRun(src);
    console.log("\n本番の recordPickupBatch に通すには --apply（DeepSeek も通すなら --apply --with-analysis）");
    return;
  }
  await apply(src);
}

main().catch((e) => { console.error(e); process.exit(1); });
