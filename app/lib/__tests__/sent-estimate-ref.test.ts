// こちらが手で送った見積書・御請求書の物件（2026-11-21 作業員G・#461 案2）。実物は宛名・金額の一部を伏せて写した
// 実行: npx tsx app/lib/__tests__/sent-estimate-ref.test.ts
import { estimateSentRecordOn, isEstimateImageText, parseEstimatePropertyRef } from "../sent-estimate-ref";
import { resolveReadProperty } from "../property-name-match";

let failed = 0;
function ok(name: string, cond: boolean) { if (!cond) { failed++; console.log("  ✗", name); } else console.log("  ✓", name); }

const H = "[画像] 【見積書・初期費用の明細】\n";
const SEIKYU = H + "御請求書\n\n2026年11月20日\n\n（お名前）様\n\n御請求金額 ¥336,653\n\n物件名：SJS七条堀川\n住所：\n入居者：（お名前）様\n\n<契約条件>\n家 賃：105,000";
const SEIKYU_BAKE = H + "御請求書　2026年11月20日\n（お名前）様\n御請求金額　¥349,360\n\n物件名：SJSと条堀川\n住所：3F　神\n入居者：（お名前）様";
const MITSUMORI = H + "御見積書\n様\n\n御請求金額　¥174,650\n\n物件名：Willet's　風\n住　所：103号室\n入居者：　様\n家　賃：63,000";

ok("見積書の通を見分ける", isEstimateImageText(SEIKYU) && !isEstimateImageText("[画像] 【物件の資料】\n物件名：x"));
ok("名前を読む", parseEstimatePropertyRef(SEIKYU)?.propertyName === "SJS七条堀川");
ok("号室が無ければ null", parseEstimatePropertyRef(SEIKYU)?.roomNo === null);
ok("3F は号室にしない", parseEstimatePropertyRef(SEIKYU_BAKE)?.roomNo === null);
ok("住所の行の号室を読む", parseEstimatePropertyRef(MITSUMORI)?.roomNo === "103");
ok("物件の資料の通は読まない", parseEstimatePropertyRef("[画像] 【物件の資料】\n物件名：ABC") === null);
ok("名前の欄が空なら null", parseEstimatePropertyRef(H + "御見積書\n物件名：\n住所：") === null);

// 照合（呼ぶ側の線）: 会話の既知の名前に寄る時だけ使う
const known = ["SJS七条堀川", "ウィレッツ風"];
ok("正しい名前は照合できる", resolveReadProperty({ propertyName: "SJS七条堀川", roomNumber: "" }, known)?.propertyName === "SJS七条堀川");
const bake = resolveReadProperty({ propertyName: parseEstimatePropertyRef(SEIKYU_BAKE)!.propertyName, roomNumber: "" }, known);
ok("化けた名前は照合の結果どちらでも既知の名前か null（作らない）", bake === null || known.includes(bake.propertyName));
ok("会話に無い名前は照合しない", resolveReadProperty({ propertyName: "全然ちがうマンション", roomNumber: "" }, known) === null);

ok("既定 off", estimateSentRecordOn({}) === false && estimateSentRecordOn({ ESTIMATE_SENT_RECORD: "on" }) === true);

if (failed) { console.log(`FAIL ${failed}`); process.exit(1); } else console.log("全 PASS");
