// 2026-09-27 竹内「スコアリング AD 1ヶ月未満の物件は点数かなり落とす／しかし元付業者が株式会社アズ・スタットの場合は例外／
//   株式会社アズ・スタットは AD 記載なくても基本的に 200% あるから 200% とみなす」のテスト
// 実行: npx tsx app/lib/__tests__/agent-ad-assume.test.ts
// 資料の文字・説明文は property_pickups #621（Luxe難波南 204・リアプロ）の実物（元付業者のページの末尾）。お客様の情報は無い
import { assumedAdAgentOf, assumedAdStamp, assumedAdSummaryLine, assumedAdAgentInLine } from "../agent-ad-assume";
import { buildCustomerProfile, judgeProperty, parsePropertyFacts, applyAdRulesToRow, reasonPoints, reasonJa, HOLD_REASON_CODES, ngHitCodes } from "../property-brain";
import { listingAdStamp, listingAdText, splitAdStamp } from "../pickup-listing-text";
import { parseAdFromText } from "../property-pickups";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ""}`); }
}

// #621 の資料の文字（元付業者のページの末尾・AD の欄は「A D」だけで値が無い）
const AZ_PDF = [
  "取引態様：貸主", "手数料", "負担 貸主:0% 借主:100%", "分配 元付:0% 客付:100%", "特記事項：",
  "webサービス広告掲載 [要確認]・チラシ、雑誌等掲載広告 [要確認]",
  "新予定日:2026/10/10 ※掲載情報は随時更新される場合がございます。 Powered by RealNetPro co.,ltd.",
  "国土交通大臣免許(2)第8096号", "株式会社アズ・スタット 大阪本社", "大阪市淀川区東三国２丁目37-3",
  "TEL：06-6150-4148 FAX：06-6150-0070", "詳細はHPよりご確認ください", "https://trader-vacancy.az-stat.com/admin/", "A D",
].join("\n");
const AZ_SUMMARY = "【21】Luxe難波南 204号室\n78,000円 8,500円\n1K 25.23㎡\n御堂筋線「大国町」徒歩1分";

console.log("■ 元付業者の見分け（アズ・スタット）");
t("実物の資料 → アズ・スタット・2ヶ月", JSON.stringify(assumedAdAgentOf(AZ_PDF)) === JSON.stringify({ name: "アズ・スタット", adMonths: 2 }));
t("書き方の揺れ（アズスタット・ｱｽﾞ･ｽﾀｯﾄ・URL だけ）", !!assumedAdAgentOf("株式会社アズスタット") && !!assumedAdAgentOf("ｱｽﾞ･ｽﾀｯﾄ") && !!assumedAdAgentOf("https://trader-vacancy.az-stat.com/admin/"));
t("ほかの元付業者は null", assumedAdAgentOf("株式会社エイブル 大阪本社\nA D 100%") === null && assumedAdAgentOf("") === null);
t("資料から AD の値は読めない（今まで AD_UNKNOWN）", JSON.stringify(parseAdFromText(AZ_PDF)) === JSON.stringify({ adMonths: null, adYen: null }) && listingAdText(AZ_PDF) === null);

console.log("■ 札（資料の文字でないと分かる形）");
t("「AD 200%（アズ・スタット）」", listingAdStamp(AZ_PDF) === "AD 200%（アズ・スタット）" && assumedAdStamp({ name: "アズ・スタット", adMonths: 2 }) === "AD 200%（アズ・スタット）");
t("札の芯と付け足し（芯「AD 200%」・付け足し「（アズ・スタット）」）", JSON.stringify(splitAdStamp("AD 200%（アズ・スタット）")) === JSON.stringify({ core: "AD 200%", rest: "（アズ・スタット）" }), splitAdStamp("AD 200%（アズ・スタット）"));
t("資料に AD の値がある時は資料の文字のまま（みなさない）", listingAdStamp(AZ_PDF.replace(/\nA D$/, "\nA D 100%（税込）")) === "A D 100%（税込）");

console.log("■ 判定（説明文にみなしの行を足す → 2ヶ月の段 +20・0点の印）");
{
  const p = buildCustomerProfile({ rent_max: 90_000, floor_plan: "1K" });
  const line = assumedAdSummaryLine({ name: "アズ・スタット", adMonths: 2 });
  t("行「AD 2ヶ月（アズ・スタット・記載なしのため200%とみなす）」", line === "AD 2ヶ月（アズ・スタット・記載なしのため200%とみなす）" && assumedAdAgentInLine(line) === "アズ・スタット");
  const f = parsePropertyFacts(`${AZ_SUMMARY}\n${line}`);
  t("読み: 2ヶ月・みなした元付業者", f.adMonths === 2 && f.adAssumedBy === "アズ・スタット", f);
  const plain = judgeProperty(parsePropertyFacts(AZ_SUMMARY), p);
  const az = judgeProperty(f, p);
  t("AD 不明（0点）→ 200%（AD_HIGH +20）・通すのまま", plain.reasonCodes.includes("AD_UNKNOWN") && az.reasonCodes.includes("AD_HIGH") && az.reasonCodes.includes("AD_ASSUMED_AGENT") && az.score - plain.score === 20 && az.verdict === "pass", [plain.score, az.score, az.reasonCodes]);
  t("印は 0点・日本語で分かる", reasonPoints("AD_ASSUMED_AGENT") === 0 && /アズ・スタット/.test(reasonJa("AD_ASSUMED_AGENT")) && az.reasonsJa.some((x) => /アズ・スタット/.test(x)));
  const written = parsePropertyFacts(`${AZ_SUMMARY}\nAD 1ヶ月`);
  t("ふつうの「AD 1ヶ月」の行はみなしの印を付けない", written.adAssumedBy === undefined && written.adMonths === 1);
}

console.log("■ AD 1ヶ月未満は点数をかなり落とす（通す→保留）");
{
  const p = buildCustomerProfile({ rent_max: 90_000, floor_plan: "1K" });
  const one = judgeProperty(parsePropertyFacts(`${AZ_SUMMARY}\nAD 1ヶ月`), p);
  const half = judgeProperty(parsePropertyFacts(`${AZ_SUMMARY}\nAD 0.5ヶ月`), p);
  const none = judgeProperty(parsePropertyFacts(`${AZ_SUMMARY}\nAD なし`), p);
  const unknown = judgeProperty(parsePropertyFacts(AZ_SUMMARY), p);
  t("AD 0.5ヶ月: −15・保留", half.reasonCodes.includes("AD_UNDER_1M") && reasonPoints("AD_UNDER_1M") === -15 && half.verdict === "hold", half.reasonCodes);
  t("AD なし: −20・保留（0.5ヶ月より下）", none.reasonCodes.includes("AD_NONE") && reasonPoints("AD_NONE") === -20 && none.verdict === "hold" && none.score < half.score, [none.score, half.score]);
  t("AD 1ヶ月（通す）との差は 30点以上", one.verdict === "pass" && one.score - half.score >= 30, [one.score, half.score]);
  t("AD 不明（記載なし・読めない）は今まで通り 0点・保留にしない", unknown.reasonCodes.includes("AD_UNKNOWN") && unknown.verdict === "pass");
  t("保留の理由の表に入った", HOLD_REASON_CODES.has("AD_UNDER_1M") && HOLD_REASON_CODES.has("AD_NONE"));
  t("お客様の NG 条件には数えない（質の高い10件は保留で別に外す）", ngHitCodes(["AD_UNDER_1M", "AD_NONE"]).length === 0);
}

console.log("■ 保存済みの行に当てる（applyAdRulesToRow）");
{
  // #621 の実物の札（AD 不明・通す 164）
  const r621 = { reason_codes: ["RENT_OK", "RENT_ABOVE_USUAL", "ZERO_ZERO", "FLOOR_PLAN_MATCH", "WALK_OK", "BUILDING_AGE_OK", "AD_UNKNOWN", "EQUIP_BATH_TOILET_MUST_OK", "AREA_WARD_MATCH", "SEARCH_PINPOINT", "FIT_ALL"], score: 164, verdict: "pass", pdf_text: AZ_PDF };
  const a = applyAdRulesToRow(r621);
  t("#621 アズ・スタット: 164 → 184（AD 200% +20）・通すのまま", !!a && a.change === "assumed_agent" && a.score === 184 && a.verdict === "pass" && a.reason_codes.includes("AD_HIGH") && !a.reason_codes.includes("AD_UNKNOWN"), a);
  t("元付業者が違えば当てない", applyAdRulesToRow({ ...r621, pdf_text: "株式会社エイブル\nA D" }) === null);
  // AD 0.5ヶ月の通す行（前の決まりで −8・全部合う +15・ピンポイント +10）
  const low = { reason_codes: ["RENT_OK", "FLOOR_PLAN_MATCH", "WALK_OK", "AD_UNDER_1M", "SEARCH_PINPOINT", "FIT_ALL"], score: 140, verdict: "pass" };
  const b = applyAdRulesToRow(low)!;
  // 140 − 7（−8→−15）− 15（全部合う）− 10（ピンポイントが 0点）＝ 108・保留
  t("AD 0.5ヶ月の通す行: 140 → 108・保留（全部合う・ピンポイントが 0点）", b.change === "low_ad" && b.score === 108 && b.verdict === "hold" && b.reason_codes.includes("SEARCH_PINPOINT_HELD") && !b.reason_codes.includes("FIT_ALL"), b);
  t("当たらない行は null", applyAdRulesToRow({ reason_codes: ["RENT_OK", "AD_HIGH"], score: 150, verdict: "pass" }) === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
