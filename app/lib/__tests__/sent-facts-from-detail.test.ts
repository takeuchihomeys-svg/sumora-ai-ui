// 送った画像の値の空の欄を、同じ画像の書き写しの読みから埋める（2026-11-22 作業員G・#509 ③）。実物の1件の形を伏せて
// 実行: npx tsx app/lib/__tests__/sent-facts-from-detail.test.ts
import { factsPatchFromDetail, floorPlanOf, statusOf, sentFactsFromDetailOn } from "../sent-facts-from-detail";

let failed = 0;
function ok(name: string, cond: boolean) { if (!cond) { failed++; console.log("  ✗", name); } else console.log("  ✓", name); }

// 物件の読みは駅・面積・管理費だけ／書き写しには間取り・築年・現況・所在階
const facts = { src: "image", station: "〇〇", area_sqm: 22.43, walk_minutes: 14, admin_fee_yen: 10000 };
const lines = ["間取り: 1K[6×K]", "所在階: 14階部分", "向き: 西", "築年: 2013年09月", "構造: 鉄筋コンクリート造 地上14階", "現況: 空室", "入居可能日: 2026年11月下旬"];
const p = factsPatchFromDetail(facts, lines, "2026-11-22");
ok("間取りを埋める（記号だけ）", p.floor_plan === "1K");
ok("築年月と築年数", p.built_ym === "2013-09" && p.building_age === 13);
ok("現況 空室 → open", p.status === "open");
ok("所在階 14", p.floor === 14);
ok("埋めた印", p.fill_from === "image_details");
ok("入っている値は上書きしない", !("area_sqm" in p) && !("station" in p));
ok("全部入っていれば何もしない", Object.keys(factsPatchFromDetail({ floor_plan: "1LDK", built_ym: "2019-07", building_age: 7, status: "open", floor: 3 }, lines)).length === 0);
ok("読めない形は埋めない", Object.keys(factsPatchFromDetail({}, ["間取り: 不明", "現況: 相談"])).length === 0);
ok("退去予定", statusOf("退去予定 / 12月末") === "move_out_planned");
ok("ワンルーム", floorPlanOf("ワンルーム") === "1R" && floorPlanOf("2LDK+S") === "2LDK");
ok("既定 off", sentFactsFromDetailOn({}) === false && sentFactsFromDetailOn({ SENT_FACTS_FROM_DETAIL: "on" }) === true);

if (failed) { console.log(`FAIL ${failed}`); process.exit(1); } else console.log("全 PASS");
