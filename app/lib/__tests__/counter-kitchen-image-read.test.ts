// カウンターキッチンを画像から読む（2026-11-21 作業員G・台帳 #477）: スイッチと問いの組み立て・答えの読み取り
// 実行: npx tsx app/lib/__tests__/counter-kitchen-image-read.test.ts
import { buildImageQuestion, counterKitchenImageReadOn, imageReadKeys, parseImageFacts } from "../property-brain-image";

let failed = 0;
function ok(name: string, cond: boolean) { if (!cond) { failed++; console.log("  ✗", name); } else console.log("  ✓", name); }

ok("既定 off", counterKitchenImageReadOn({}) === false);
ok("on", counterKitchenImageReadOn({ COUNTER_KITCHEN_IMAGE_READ: " ON " }) === true);
ok("off の時は counter_kitchen を問いから外す", JSON.stringify(imageReadKeys(["storage", "counter_kitchen"], {})) === JSON.stringify(["storage"]));
ok("on の時は残す", imageReadKeys(["storage", "counter_kitchen"], { COUNTER_KITCHEN_IMAGE_READ: "on" }).includes("counter_kitchen"));
ok("off の時の問いは今までと同じ", buildImageQuestion(imageReadKeys(["storage", "counter_kitchen"], {})) === buildImageQuestion(["storage"]));
ok("問いに「カウンター」「対面」の書き込みを先に見る文", /「カウンター」「対面」と書いてあれば true/.test(buildImageQuestion(["counter_kitchen"])));
ok("分からなければ null", parseImageFacts('{"counter_kitchen": null, "storage": true}', ["counter_kitchen", "storage"])?.counter_kitchen === null);
ok("true を読む", parseImageFacts('{"counter_kitchen": true}', ["counter_kitchen"])?.counter_kitchen === true);
ok("1つも取れなければ失敗（null）", parseImageFacts('{"counter_kitchen": "たぶん"}', ["counter_kitchen"]) === null);

if (failed) { console.log(`FAIL ${failed}`); process.exit(1); } else console.log("全 PASS");
