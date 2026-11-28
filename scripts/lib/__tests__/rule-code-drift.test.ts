// npx tsx scripts/lib/__tests__/rule-code-drift.test.ts — 決まりとコードの食い違いの見張り（台帳 #818）
import assert from "node:assert/strict";
import { switchNamesInText, switchDefaultsInCode, ruleCodeDrift, writtenAsSwitch, idLinkedSwitchesInCode, idLinkDrift, driftLedgerTitle, type KbRow } from "../rule-code-drift";

assert.deepEqual(switchNamesInText("戻す TWO_STAGE_ANSWERABLE_DIRECT=off・JST_ISO と A_B は拾わない・NEXT_PUBLIC_SUPABASE_URL も"), ["TWO_STAGE_ANSWERABLE_DIRECT"]);
const d = switchDefaultsInCode('(env.A_SW_ON ?? "").trim().toLowerCase() !== "off"; env.B_SW_OFF === "on"; stagedOn("C_SW_ALL", env, STAGE_ALL); stageOnNow("D_SW_ST", c)');
assert.deepEqual([d.get("A_SW_ON"), d.get("B_SW_OFF"), d.get("C_SW_ALL"), d.get("D_SW_ST")], ["on", "off", "on", "staged"]);
assert.equal(writtenAsSwitch("戻す FOO_BAR_X=off で", "FOO_BAR_X"), true);
assert.equal(writtenAsSwitch("SWITCH_TARGET_MARK に足す", "SWITCH_TARGET_MARK"), false);

const row = (o: Partial<KbRow>): KbRow => ({ id: "aaaa1111-0000", title: "t", insight: "", rationale: "", applied_to: "", tags: [], is_current: true, priority: 2, retired_reason: null, superseded_by: null, ...o });
const code = { defaults: new Map([["OLD_RULE_SW", "on" as const], ["NEW_RULE_SW", "off" as const]]), where: new Map([["OLD_RULE_SW", ["app/lib/x.ts"]]]), seen: new Set(["OLD_RULE_SW", "NEW_RULE_SW"]) };
const ds = ruleCodeDrift([
  row({ id: "r1aaaaaa-x", is_current: false, insight: "OLD_RULE_SW=on で", retired_reason: "改めた", superseded_by: "n1" }),
  row({ id: "c1aaaaaa-x", priority: 1, insight: "NEW_RULE_SW（既定 off）を入れる" }),
  row({ id: "c2aaaaaa-x", priority: 0, insight: "GONE_RULE_SW=on にする" }),
  row({ id: "c3aaaaaa-x", priority: 2, insight: "NEW_RULE_SW=on" }),
], code);
assert.deepEqual(ds.map((x) => [x.kind, x.sw]), [["退役・コードは生きている", "OLD_RULE_SW"], ["決まりは生きている・コードは止まっている", "NEW_RULE_SW"], ["決まりは生きている・コードに無い", "GONE_RULE_SW"]], "P2 の行はコードに無い・止まっているを出さない");
assert.equal(ds[0].currentMentions, 0);

// コメントが設計知見の id を根拠に書いている所（名前が決まりの文に無くても照らせる）
const src = ["// 設計知見 5aa28356 を改める", "function f(env) {", '  return (env.TWO_STAGE_ANSWERABLE_DIRECT ?? "").trim().toLowerCase() !== "off";', "}"].join("\n");
const links = idLinkedSwitchesInCode(src).map((l) => ({ ...l, file: "app/lib/turn-contract.ts" }));
assert.ok(links.some((l) => l.id8 === "5aa28356" && l.sw === "TWO_STAGE_ANSWERABLE_DIRECT" && l.code === "on"));
const il = idLinkDrift([row({ id: "5aa28356-1111", is_current: false, title: "A1 すぐ AIX" })], links);
assert.equal(il.length, 1); assert.equal(il[0].sw, "TWO_STAGE_ANSWERABLE_DIRECT");
assert.equal(idLinkDrift([row({ id: "5aa28356-1111", is_current: true })], links).length, 0, "現行の行の id は出さない");
assert.ok(driftLedgerTitle(il[0]).startsWith("決まりとコードの食い違い: TWO_STAGE_ANSWERABLE_DIRECT"));
// 2026-11-27 統括役の決め 3・6: 戻す口（=on で昔に戻す）とスイッチだけやめた物は「止まっている」に出さない
import("../rule-code-drift").then(({ revertSwitchesInText, droppedSwitchesInText }) => {
  assert.deepEqual(revertSwitchesInText("戻す: HUMAN_LEARN_DAYTIME_REBUILD=on（昼も作る）"), ["HUMAN_LEARN_DAYTIME_REBUILD"]);
  assert.deepEqual(revertSwitchesInText("LOST_AS_NEGATIVE は昔の動きに戻す口（=on で旧）"), ["LOST_AS_NEGATIVE"]);
  assert.deepEqual(droppedSwitchesInText("（#818）このスイッチは台帳でやめた: AIX_FIRST_BLUEPRINT＝台帳 #21（もう要らない）"), ["AIX_FIRST_BLUEPRINT"]);
  const c2 = { defaults: new Map([["REV_SW_X", "off" as const], ["DROP_SW_X", "off" as const], ["LIVE_SW_X", "off" as const]]), where: new Map(), seen: new Set(["REV_SW_X", "DROP_SW_X", "LIVE_SW_X"]), revert: new Set(["REV_SW_X"]) };
  const d2 = ruleCodeDrift([row({ id: "c9aaaaaa-x", priority: 1, insight: "REV_SW_X=on で入る・DROP_SW_X=on・LIVE_SW_X=on\nこのスイッチは台帳でやめた: DROP_SW_X＝台帳 #9" })], c2);
  assert.deepEqual(d2.map((x) => x.sw), ["LIVE_SW_X"], "戻す口とやめたスイッチは出さない");
  console.log("rule-code-drift ok 16");
});
// 2026-11-27 作業員L（#822 の続き）: 決まり同士の一部の上書き（fd949dd7 ← 5bb9f76a の形）
import("../rule-code-drift").then(({ partialOverrides, fnNamesInAppliedTo }) => {
  const k = (o: Partial<KbRow> & { id: string }): KbRow => ({ title: "t", insight: "", rationale: null, applied_to: null, tags: [], is_current: true, priority: 1, retired_reason: null, superseded_by: null, ...o });
  assert.deepEqual(fnNamesInAppliedTo("app/lib/hold-soft-next.ts（holdSoftMoveFor・holdSoftNextMaterial）・customer-mindset.hesitationMoveOf・generate-reply"), ["hesitationMoveOf", "holdSoftMoveFor", "holdSoftNextMaterial"]);
  const old = k({ id: "fd949dd7-0000", title: "保留の柔らかい1文・家族の相談でも添える", applied_to: "customer-mindset.hesitationMoveOf" });
  const nw = k({ id: "5bb9f76a-0000", title: "家族と相談は締め＋サポート", insight: "10/15 の1文と食い違っていた。ブレインの材料（hesitationMoveOf）から 10/15 の一手を外す", applied_to: "app/lib/customer-mindset.ts の hesitationMoveOf" });
  assert.deepEqual(partialOverrides([old, nw]).map((p) => `${p.oldId.slice(0, 8)}<${p.newId.slice(0, 8)}:${p.fns.join()}`), ["fd949dd7<5bb9f76a:hesitationMoveOf"]);
  assert.equal(partialOverrides([k({ ...old, insight: "家族の番は 5bb9f76a で上書き" }), nw]).length, 0, "古い方に追記があれば出さない");
  assert.equal(partialOverrides([k({ ...old, superseded_by: "x" }), nw]).length, 0);
  assert.equal(partialOverrides([k({ ...old, priority: 2 }), nw]).length, 0, "P2 は見ない");
  assert.equal(partialOverrides([old, k({ ...nw, insight: "材料を足す" })]).length, 0, "上書きの語が無い");
  assert.equal(partialOverrides([nw, old]).length, 0, "新しい方が後ろ（作った順）");
  console.log("rule-code-drift partial-override ok 7");
});
import("../rule-code-drift").then(({ partialOverrides }) => {
  const k = (o: Partial<KbRow> & { id: string }): KbRow => ({ title: "t", insight: "", rationale: null, applied_to: null, tags: [], is_current: true, priority: 1, retired_reason: null, superseded_by: null, ...o });
  const old = k({ id: "2cb3be5a-x", applied_to: "matchAnchors" }); const nw = k({ id: "fbedd55b-x", insight: "上書き", applied_to: "matchAnchors" });
  assert.equal(partialOverrides([old, nw]).length, 0, "外れと決めた組は出さない");
  console.log("rule-code-drift dismissed ok");
});
