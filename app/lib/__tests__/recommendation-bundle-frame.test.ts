// app/lib/__tests__/recommendation-bundle-frame.test.ts
// 2026-10-06 ⑰ 竹内「お送りした中でもは物件ピックアップの中の物件オススメの物件についてオススメしている形」
//   「お送りした中でも」（compare）は直近の束（物件ピックアップ）の中から推す時・束の直後（1時間以内）だけ
// 実行: npx tsx app/lib/__tests__/recommendation-bundle-frame.test.ts
import { resolveRecommendationScenario, bundleCompareOk, type PropertySendFacts } from "../recommendation-frame";
import { starInBundle } from "../recommend-bundle-server";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") { if (cond) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); } }
const base: PropertySendFacts = { priorSentPropertyCount: 1, priorBulkSendCount: 1, priorSingleSendCount: 0, hoursSinceLastSend: 0.1, brainSentPropertyCount: 7 };
const sc = (pickupType: string | null, f: Partial<PropertySendFacts>) => resolveRecommendationScenario({ actionType: "property_recommendation", pickupType, checkPattern: null, facts: { ...base, ...f } });

// あかりさん（10/04）: 物件ピックアップ7件の10分後に、その中の1件を物件オススメ（ピッカー「新規ピックアップ」）
t("新規ピックアップ・束の直後・束の中 → 比較（お送りした中でも）", sc("新規ピックアップ", { hoursSinceLastBundle: 0.17, starInLastBundle: true }) === "compare");
t("新規ピックアップ・束の直後・束の中か分からない → 比較", sc("新規ピックアップ", { hoursSinceLastBundle: 0.17, starInLastBundle: null }) === "compare");
t("新規ピックアップ・束の外の部屋 → 比較しない", sc("新規ピックアップ", { hoursSinceLastBundle: 0.17, starInLastBundle: false }) === "followup_single");
t("新規ピックアップ・束から2時間 → 比較しない", sc("新規ピックアップ", { hoursSinceLastBundle: 2, starInLastBundle: true }) === "followup_single");
t("ピッカーなし・束から3日（旧は7日まで比較）→ 比較しない", sc(null, { hoursSinceLastBundle: 72, starInLastBundle: null }) === "followup_single");
t("ピッカーなし・束の直後 → 比較", sc(null, { hoursSinceLastBundle: 0.5, starInLastBundle: null }) === "compare");
t("新着1件は束の直後でも新着（新たに見つけた1件）", sc("新着1件", { hoursSinceLastBundle: 0.2, starInLastBundle: true }) === "new_listing");
t("継続ピックアップ（これまで送った中から）は今まで通り7日まで比較", sc("継続ピックアップ", { hoursSinceLastBundle: 72 }) === "compare");
t("束が無い（null）・送付実績あり → 比較しない", sc(null, { hoursSinceLastBundle: null }) === "followup_single");
t("束の時間が渡されない（undefined）→ 今までの判定（ピッカーなし・7日以内は比較）", sc(null, {}) === "compare");
t("bundleCompareOk: 渡されなければ null", bundleCompareOk(base) === null);
// 束の部屋の照合
t("束の部屋の名前に同じ建物 → 束の中", starInBundle("ＭＥＬＤＩＡ千船", ["メゾンドF02", "ＭＥＬＤＩＡ千船", "プレサンス西九条"]) === true);
t("束に無い建物 → 束の外", starInBundle("エステムプラザ難波", ["メゾンドF02", "ＭＥＬＤＩＡ千船"]) === false);
t("名前が分からない → null", starInBundle(null, ["メゾンドF02"]) === null && starInBundle("メゾンドF02", []) === null);
console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
