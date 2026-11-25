// 台帳 #747 MATERIAL_PRIORITY（作業員L 11/26）
import assert from "node:assert/strict";
import { materialPriorityMode, pickFirstKeys, applyMaterialPriority, materialPriorityDigest, materialPriorityMeasures, USED_MARKERS } from "../material-priority";

assert.equal(materialPriorityMode({}), "off");
assert.equal(materialPriorityMode({ MATERIAL_PRIORITY: "shadow" }), "shadow");
assert.equal(materialPriorityMode({ MATERIAL_PRIORITY: "on" }), "on");

// 入口の答えが無い番は選ばない（今の並び）
assert.deepEqual(pickFirstKeys({ focus: null, saysAix: false, hasStation: true, available: ["station_state"] }).keys, []);
// AIX の番と見た・約束を果たす重点 → 確認の約束の流れが先
assert.deepEqual(pickFirstKeys({ focus: "promise_keep", saysAix: true, hasStation: false, available: ["now_fulfillable", "check_promise_flow", "topic_state"] }).keys, ["check_promise_flow", "now_fulfillable"]);
// 締めの重点・駅あり → 駅の今の状態と逆算の計画（無い行は飛ばす・3つまで）
assert.deepEqual(pickFirstKeys({ focus: "close", saysAix: false, hasStation: true, available: ["station_state", "now_fulfillable", "ack_confirm"] }).keys, ["station_state", "now_fulfillable"]);
assert.equal(pickFirstKeys({ focus: "answer", saysAix: true, hasStation: true, available: ["check_promise_flow", "now_fulfillable", "info_fill", "station_state"] }).keys.length, 3);

// 並べ替え: 選んだ行を先頭の塊へ（中身は変えない・残りは今の順）
const cs = "【状況】A\n\n今果たせる: X\n\n【話題】T";
const route = "地図の文\n【この駅の今の状態】S";
const blocks = [{ key: "now_fulfillable", text: "今果たせる: X", from: "cs" as const }, { key: "station_state", text: "【この駅の今の状態】S", from: "route" as const }, { key: "topic_state", text: "【話題】T", from: "cs" as const }];
const r = applyMaterialPriority({ cs, route, blocks, keys: ["station_state", "now_fulfillable"], why: "重点 close・駅あり" });
assert.deepEqual(r.moved, ["station_state", "now_fulfillable"]);
assert.ok(r.cs.startsWith("【まず見る（統括の入口の読み: 重点 close・駅あり）】\n【この駅の今の状態】S\n今果たせる: X\n\n"));
assert.ok(r.cs.includes("【状況】A") && r.cs.includes("【話題】T") && r.cs.indexOf("【状況】A") < r.cs.indexOf("【話題】T"));
assert.equal((r.cs.match(/今果たせる: X/g) ?? []).length, 1);
assert.ok(!r.route.includes("【この駅の今の状態】S") && r.route.includes("地図の文"));
// 見つからない行は動かさない・何も動かなければ元のまま
const r2 = applyMaterialPriority({ cs, route, blocks: [{ key: "ack_confirm", text: "無い行", from: "cs" }], keys: ["ack_confirm"], why: "" });
assert.equal(r2.cs, cs); assert.equal(r2.route, route); assert.deepEqual(r2.moved, []);
// 「この順で決めよ」とは書かない（道を引っぱらない）
assert.ok(!/決め|判断せよ|従/.test(r.cs.split("\n")[0]));

// 記録と物差し
assert.equal(materialPriorityDigest({ mode: "off", ready: true, keys: ["a"], moved: [] }), null);
const dg = materialPriorityDigest({ mode: "on", ready: true, keys: ["check_promise_flow", "now_fulfillable"], moved: ["check_promise_flow"] });
assert.equal(dg, "mp-v2|o|r|check_promise_flow,now_fulfillable|check_promise_flow");
const ms = materialPriorityMeasures([{ mpr: dg, aix: "property_check_result" }, { mpr: "mp-v2|s|-||" }, { ci: "x" }]);
assert.deepEqual(ms, { picked: 2, ready: 1, headShare: 50, used: 2, usedOf: 2 });
// 2026-11-26 作業員A: 使った目印（場面で分ける・探す約束の後のお礼・逆算の計画）
assert.equal(USED_MARKERS.check_promise_flow({ cpf: "a", aix: "property_check_result" }), true);
assert.equal(USED_MARKERS.check_promise_flow({ cpf: "q", aix: "" }), true);
assert.equal(USED_MARKERS.check_promise_flow({ cpf: "q", aix: "property_check_result" }), false);
assert.equal(USED_MARKERS.pickup_promise_flow({ ppf: "r", aix: "property_send" }), true);
assert.equal(USED_MARKERS.pickup_promise_flow({ ppf: "n", aix: "property_send" }), false);
assert.equal(USED_MARKERS.pickup_promise_flow({ aix: "" }), null);
assert.equal(USED_MARKERS.route_backplan({ bpn: "estimate", aix: "estimate_sheet" }), true);
assert.equal(USED_MARKERS.route_backplan({ bpn: "estimate", aix: "viewing_invite" }), false);
assert.equal(USED_MARKERS.route_backplan({ bpn: "estimate", aix: "" }), null);
assert.equal(USED_MARKERS.station_state({}), null);
assert.deepEqual(pickFirstKeys({ focus: "promise_keep", saysAix: true, hasStation: false, available: ["now_fulfillable", "pickup_promise_flow", "check_promise_flow"] }).keys, ["check_promise_flow", "pickup_promise_flow", "now_fulfillable"]);
console.log("material-priority ok 21+11");
// 配線（brain-core・brain-layers）: 行を控える・off は控えるだけ・記録の欄
import { readFileSync } from "node:fs";
import { join } from "node:path";
const core = readFileSync(join(__dirname, "../brain-core.ts"), "utf8"), layers = readFileSync(join(__dirname, "../brain-layers.ts"), "utf8");
for (const k of ["check_promise_flow", "ack_confirm", "pickup_why", "now_fulfillable", "topic_state", "info_fill", "station_state"]) assert.ok(core.includes(`materialBlocks.push({ key: "${k}"`), `控えが無い: ${k}`);
assert.ok(/if \(mpMode !== "off" && intakeP && materialBlocks\.length\)/.test(core), "off の時は何もしない");
assert.ok(/mpMode === "on" && pick\.keys\.length\) \{ const r = mp\.applyMaterialPriority/.test(core), "並べ替えは on の時だけ");
assert.ok(/materialPriorityDigest\(meta\.material_priority/.test(layers), "digest.mpr");
console.log("material-priority wiring ok 10");
