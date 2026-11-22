// 手でまとめて送った束の室内写真を、同じ束の資料の物件に結ぶ（2026-11-21 作業員G・#461 案3）
// 実行: npx tsx app/lib/__tests__/sent-batch-photo.test.ts
import { batchPhotoAttribution, sentBatchPhotoAttributeOn } from "../sent-batch-photo";

let failed = 0;
function ok(name: string, cond: boolean) { if (!cond) { failed++; console.log("  ✗", name); } else console.log("  ✓", name); }

const sheet = { url: "s", propertyName: "グランメゾンA", roomNo: "302" };
const p1 = { url: "p1", propertyName: null, roomNo: null };
const p2 = { url: "p2", propertyName: null, roomNo: null };

const r = batchPhotoAttribution([sheet, p1, p2]);
ok("資料1つ＋写真2枚 → 写真2枚を結ぶ", r.length === 2 && r.every((x) => x.propertyName === "グランメゾンA" && x.roomNo === "302"));
ok("同じ物件の資料2枚（表記ゆれ）＋写真 → 結ぶ", batchPhotoAttribution([sheet, { url: "s2", propertyName: "グランメゾン A", roomNo: "302" }, p1]).length === 1);
ok("違う物件の資料2枚 → 結ばない", batchPhotoAttribution([sheet, { url: "s2", propertyName: "メゾンB", roomNo: "101" }, p1]).length === 0);
ok("同じ建物の別の号室 → 結ばない", batchPhotoAttribution([sheet, { url: "s2", propertyName: "グランメゾンA", roomNo: "401" }, p1]).length === 0);
ok("資料が無い束 → 結ばない", batchPhotoAttribution([p1, p2]).length === 0);
ok("1枚だけ → 結ばない", batchPhotoAttribution([p1]).length === 0);
ok("全部に記録がある → 何もしない", batchPhotoAttribution([sheet, { ...sheet, url: "s3" }]).length === 0);
ok("既定 off", sentBatchPhotoAttributeOn({}) === false && sentBatchPhotoAttributeOn({ SENT_BATCH_PHOTO_ATTRIBUTE: "on" }) === true);

if (failed) { console.log(`FAIL ${failed}`); process.exit(1); } else console.log("全 PASS");
