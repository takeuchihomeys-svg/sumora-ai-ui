// お客様が送った物件の画像の深い読み（2026-11-21 作業員G・#461 ②）: 空の欄だけを埋める純関数
// 実行: npx tsx app/lib/__tests__/customer-image-deep-read.test.ts
import { customerImageDeepReadOn, deepReadNeeded, deepReadPatch } from "../customer-image-deep-read";

let failed = 0;
function ok(name: string, cond: boolean) { if (!cond) { failed++; console.log("  ✗", name); } else console.log("  ✓", name); }

const base = { kind: "property_screen", property_name: null, room_no: null, rent_yen: 68000, admin_yen: null, madori: "1K", area_sqm: null, station: null, walk_min: null, age_years: null };
ok("物件の画面で空の欄がある → 読む", deepReadNeeded(base).need && deepReadNeeded(base).missing.includes("station"));
ok("書類は読まない", deepReadNeeded({ ...base, kind: "contract_document" }).need === false);
ok("見積は読まない", deepReadNeeded({ ...base, kind: "estimate" }).need === false);
ok("全部埋まっていれば読まない", deepReadNeeded({ ...base, property_name: "A", room_no: "1", admin_yen: 0, area_sqm: 20, station: "B", walk_min: 5, age_years: 3 }).need === false);

const read = [{ propertyName: "Uresidence新大阪", roomNumber: "0707号室", rent: 70000, adminFee: 7000, floorPlan: "1K", areaSqm: 22.6, station: "新大阪", walkMinutes: 15, built: "2017年02月" }];
const p = deepReadPatch(base, read, "2026-11-21");
ok("空の欄を埋める（名前・号室・管理費・㎡・駅・徒歩・築年）", p.property_name === "Uresidence新大阪" && p.room_no === "0707" && p.admin_yen === 7000 && p.area_sqm === 22.6 && p.station === "新大阪" && p.walk_min === 15 && p.age_years === 9);
ok("書き起こしで読めた値は上書きしない（家賃・間取り）", p.rent_yen === undefined && p.madori === undefined);
ok("一覧（2件）は埋めない", Object.keys(deepReadPatch(base, [read[0], { ...read[0], roomNumber: "0808" }])).length === 0);
ok("おかしな値は入れない（家賃 500円・徒歩 120分）", Object.keys(deepReadPatch({ ...base, rent_yen: null }, [{ rent: 500, walkMinutes: 120 }])).length === 0);
ok("読めなければ空", Object.keys(deepReadPatch(base, [])).length === 0);
ok("既定 off", customerImageDeepReadOn({}) === false && customerImageDeepReadOn({ CUSTOMER_IMAGE_DEEP_READ: "on" }) === true);

if (failed) { console.log(`FAIL ${failed}`); process.exit(1); } else console.log("全 PASS");
