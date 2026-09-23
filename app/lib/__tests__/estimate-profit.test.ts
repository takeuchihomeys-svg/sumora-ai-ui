// 2026-09-24 竹内「AD − 見積書の割引金額が利益。物件オススメ・ピックアップで送った物件なら AD も分かっているはず。連動する」
// 実行: npx tsx app/lib/__tests__/estimate-profit.test.ts（実物の本文をそのまま使う）
import { parseEstimateItems, linkAdForEstimate, computeProfitYen, summarizeEstimateProfit, formatProfitNote, type AdSource } from "../estimate-profit";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); }
  else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 300)}` : ""}`); }
}

// 実物（aix_usage_logs estimate_sheet・2026-09）
const ONE = "【アコード中之島 1402号室】\n\n初期費用さらに\n🌟26,500円割引させて頂き\n初期費用：208,110円\n\nスモラなら一般的な不動産業者より95,020円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。";
const TWO = "①【ドリームネオポリス桜ノ宮】\n\n初期費用さらに\n🌟82,000円割引させて頂き\n初期費用：126,180円\n\nスモラなら一般的な不動産業者より179,120円節約出来ます！！\n\n②【フレンシアノイエ難波南 601号室】\n\n初期費用さらに\n🌟44,000円割引させて頂き\n初期費用：120,030円\n\nスモラなら一般的な不動産業者より182,920円節約出来ます！！\n\n※ご入居日によって日割家賃が発生致します。";
const PAREN = "【プレジオ本町 1005号室】\n\n初期費用さらに\n🌟88,500円割引させて頂き\n初期費用：150,000円（初期費用前家賃だけ）\n\nギガ賃貸なら一般的な不動産業者より242,500円節約出来ます！！";
const NO_HEAD = "初期費用さらに\n🌟30,000円割引させて頂き\n初期費用：134,480円";

console.log("── ★ 本文から物件ごとの割引を取り出す");
{
  const a = parseEstimateItems(ONE);
  t("★ 1件: 物件名・号室・割引・初期費用", a.length === 1 && a[0].propertyName === "アコード中之島" && a[0].roomNo === "1402" && a[0].discountYen === 26_500 && a[0].initialCostYen === 208_110, a);
  const b = parseEstimateItems(TWO);
  t("★ 2件（①②）: 号室なし と 号室あり", b.length === 2 && b[0].propertyName === "ドリームネオポリス桜ノ宮" && b[0].roomNo === null && b[0].discountYen === 82_000
    && b[1].propertyName === "フレンシアノイエ難波南" && b[1].roomNo === "601" && b[1].discountYen === 44_000 && b[1].initialCostYen === 120_030, b);
  const c = parseEstimateItems(PAREN);
  t("★ 初期費用の後ろに括弧が付いても読める", c.length === 1 && c[0].discountYen === 88_500 && c[0].initialCostYen === 150_000, c);
  const d = parseEstimateItems(NO_HEAD);
  t("★ 【】が無い本文は物件名なしの1件（割引だけ）", d.length === 1 && d[0].propertyName === "" && d[0].discountYen === 30_000, d);
  t("★ 空・関係ない文は0件", parseEstimateItems("").length === 0 && parseEstimateItems("かしこまりました！！").length === 0);
  t("★ 全角の数字・コロンも読める", parseEstimateItems("【Ａ 101号室】\n🌟３０，０００円割引\n初期費用：１２３，４５６円")[0]?.discountYen === 30_000);
  t("★ ありえない割引（100万円）は捨てる", parseEstimateItems("【X 101号室】\n🌟1000000円割引")[0]?.discountYen === null);
}

console.log("── ★ AD と結び付ける（候補プール → 送付記録）");
{
  const sources: AdSource[] = [
    { kind: "candidate_pool", name: "アコード中之島", adMonths: 2, rent: null, at: "2026-09-20T01:00:00Z" },
    { kind: "sent_property", name: "アコード中之島", roomNo: "1402", rent: 78_000, adMonths: null, at: "2026-09-21T01:00:00Z" },
    { kind: "sent_property", name: "フレンシアノイエ難波南", roomNo: "601", rent: 65_000, adMonths: 1, at: "2026-09-19T01:00:00Z" },
    { kind: "sent_property", name: "フレンシアノイエ難波南", roomNo: "402", rent: 60_000, adMonths: 0.5, at: "2026-09-18T01:00:00Z" },
    { kind: "candidate_pool", name: "エステムコート難波サウスプレイスVIIIハイド", adMonths: 2, rent: 70_000, at: "2026-09-19T01:00:00Z" },
  ];
  const [one] = parseEstimateItems(ONE);
  const l1 = linkAdForEstimate(one, sources);
  t("★ 候補プールの AD（2ヶ月）＋送付記録の家賃（78,000）→ AD 156,000円", l1?.source === "candidate_pool" && l1.adMonths === 2 && l1.rent === 78_000 && l1.adYen === 156_000, l1);
  t("★ 利益 ＝ AD − 割引", computeProfitYen(l1?.adYen, one.discountYen) === 156_000 - 26_500);
  const [, two] = parseEstimateItems(TWO);
  const l2 = linkAdForEstimate(two, sources);
  t("★ 号室が合う送付記録を選ぶ（601 の AD 1ヶ月・家賃 65,000）", l2?.source === "sent_property" && l2.adMonths === 1 && l2.adYen === 65_000, l2);
  const l3 = linkAdForEstimate({ index: 0, propertyName: "エステムコート難波サウスプレイスVIリリアン", roomNo: "201", discountYen: 30_000, initialCostYen: null }, sources);
  t("★ シリーズ番号が違う建物（VI ↔ VIII）には結び付けない", l3 === null, l3);
  t("★ 物件名が無ければ結び付けない", linkAdForEstimate({ index: 0, propertyName: "", roomNo: null, discountYen: 30_000, initialCostYen: null }, sources) === null);
  t("★ 出所に AD が無ければ null（家賃だけでは AD にならない）", linkAdForEstimate(one, [{ kind: "sent_property", name: "アコード中之島", rent: 78_000 }]) === null);
  const l4 = linkAdForEstimate(one, [{ kind: "sent_property", name: "アコード中之島", roomNo: "1402", adMonths: 1.5, rent: null }]);
  t("★ 家賃が無ければ ad_months だけ残し AD 円は null", l4?.adMonths === 1.5 && l4.adYen === null && l4.rent === null, l4);
}

console.log("── ★ まとめ（中央値）と材料の1行");
{
  const s = summarizeEstimateProfit([
    { discount_yen: 26_500, ad_yen: 156_000, profit_yen: 129_500 },
    { discount_yen: 82_000, ad_yen: null, profit_yen: null },
    { discount_yen: 44_000, ad_yen: 65_000, profit_yen: 21_000 },
    { discount_yen: 90_000, ad_yen: 60_000, profit_yen: -30_000 },
  ]);
  t("★ 件数・割引の中央値・結び付いた件数・利益が出ていない件数", s.n === 4 && s.discountMedianYen === 63_000 && s.linked === 3 && s.negative === 1 && s.profitMedianYen === 21_000, s);
  const note = formatProfitNote(s);
  t("★ 1行に数字が入る", note.includes("見積書 4件") && note.includes("割引の中央値 63,000円") && note.includes("利益が出ていない 1件"), note);
  t("★ 記録が無ければ空文字", formatProfitNote(summarizeEstimateProfit([])) === "");
}

console.log(`\n合計: ${passed}/${passed + failed}`);
if (failed > 0) process.exit(1);
