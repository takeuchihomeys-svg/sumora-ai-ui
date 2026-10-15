// 実行: npx tsx app/lib/__tests__/pickup-bundle-common-facts.test.ts
// 2026-10-15 竹内さん「入れれるようにする」: 物件ピックアップした の束に共通の事実・画像ごとの行 ID の持ち回し
import { bundleCommonFacts, buildBundleCommonFactsNote, parsePickupIdsByImage, pickupCommonFactsEnabled } from "../pickup-bundle-common-facts";
import { pickupIdsForSentFiles } from "../sent-image-order";

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`✗ ${name}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`); }
};
const row = (deposit: number | null, keyMoney: number | null, eq_: Record<string, { s: string; ev?: string; d?: string }> = {}, extra: Record<string, unknown> = {}) =>
  ({ terms: { deposit, keyMoney, moveIn: { kind: "date" }, newBuild: false, freeRent: null, ...extra }, equipment: { facts: eq_ } });

// 敷金・礼金
eq("全部屋 敷0礼0", bundleCommonFacts([row(0, 0), row(0, 0)]), ["敷金礼金なし"]);
eq("全部屋 礼金あり", bundleCommonFacts([row(1, 1), row(0, 1)]), ["礼金あり"]);
eq("礼金なし・敷金はまちまち", bundleCommonFacts([row(1, 0), row(0, 0)]), ["礼金なし"]);
eq("礼金がまちまち＝出さない", bundleCommonFacts([row(0, 1), row(0, 0)]), ["敷金なし"]);
eq("1部屋でも読めない＝礼金は出さない", bundleCommonFacts([row(0, 1), row(0, null)]), ["敷金なし"]);
// 分からない部屋があれば何も作らない
eq("行の無い画像あり", bundleCommonFacts([row(0, 0), null]), []);
eq("1部屋", bundleCommonFacts([row(0, 0)]), []);
// 設備
const park = { s: "ok", ev: "敷地内駐車場／空きあり", d: "空きあり" };
eq("敷地内駐車場", bundleCommonFacts([row(1, 1, { parking: park }), row(1, 1, { parking: park })]), ["礼金あり", "敷地内駐車場あり"]);
eq("近隣駐車場は出さない", bundleCommonFacts([row(null, null, { parking: { s: "ok", ev: "近隣駐車場", d: "近隣" } }), row(null, null, { parking: park })]), []);
eq("記載なしは共通にしない", bundleCommonFacts([row(null, null, { autolock: { s: "ok" } }), row(null, null, {})]), []);
eq("ペット相談を含む", bundleCommonFacts([row(null, null, { pet: { s: "ok", d: "可" } }), row(null, null, { pet: { s: "ok", d: "相談" } })]), ["ペット飼育可能（相談の部屋を含む）"]);
eq("バストイレ別・オートロック", bundleCommonFacts([row(null, null, { bath_toilet: { s: "ok" }, autolock: { s: "ok" } }), row(null, null, { bath_toilet: { s: "ok" }, autolock: { s: "ok" } })]), ["バス・トイレ別", "オートロック付き"]);
eq("ng があれば出さない", bundleCommonFacts([row(null, null, { pet: { s: "ok" } }), row(null, null, { pet: { s: "ng" } })]), []);
eq("即入居・フリーレント", bundleCommonFacts([row(null, null, {}, { moveIn: { kind: "immediate" }, freeRent: { months: 1 } }), row(null, null, {}, { moveIn: { kind: "immediate" }, freeRent: { months: 2 } })]), ["即入居可", "フリーレント付き"]);
// 注記
eq("注記なし", buildBundleCommonFactsNote([], 3), "");
eq("注記の頭", buildBundleCommonFactsNote(["礼金あり"], 3).split("\n")[0], "【今回送る3部屋すべてに共通の事実（売上サポの資料の文字から・全部屋で確かめた物だけ）】礼金あり");
// 戻す
eq("既定 on", pickupCommonFactsEnabled({}), true);
eq("off", pickupCommonFactsEnabled({ PICKUP_COMMON_FACTS: "off" }), false);
// 画像ごとの行 ID
eq("by_image 読み", parsePickupIdsByImage([3, null, "5"], 3), [3, null, 5]);
eq("数が合わない", parsePickupIdsByImage([3, null], 3), null);
eq("同じ ID が2枚", parsePickupIdsByImage([3, 3], 2), null);
const A = { a: 1 }, B = { b: 1 }, C = { c: 1 }, X = { x: 1 };
eq("そのまま", pickupIdsForSentFiles({ handoffIds: [10, 11, 12], handoffFiles: [A, B, C], sentFiles: [A, B, C] }), [10, 11, 12]);
eq("並べ替え・外した", pickupIdsForSentFiles({ handoffIds: [10, 11, 12], handoffFiles: [A, B, C], sentFiles: [C, A] }), [12, 10]);
eq("足した画像は null", pickupIdsForSentFiles({ handoffIds: [10, 11], handoffFiles: [A, B], sentFiles: [A, X, B] }), [10, null, 11]);
eq("同じ File が2回は2回目 null", pickupIdsForSentFiles({ handoffIds: [10], handoffFiles: [A], sentFiles: [A, A] }), [10, null]);
eq("数が合わない handoff", pickupIdsForSentFiles({ handoffIds: [10], handoffFiles: [A, B], sentFiles: [A] }), [null]);

console.log(`pickup-bundle-common-facts: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
