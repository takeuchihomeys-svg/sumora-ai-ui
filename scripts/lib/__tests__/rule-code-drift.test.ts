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
console.log("rule-code-drift ok 12");
