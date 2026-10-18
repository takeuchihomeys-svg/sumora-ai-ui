// 2026-10-18 竹内さん 10/18: AIX【確認した（条件・交渉）→ライフラインについて】のテスト。文は実物（お客様の発言・9/25・9/28・6/24）
// 実行: npx tsx app/lib/__tests__/aix-lifeline.test.ts
import { composeLifelineMessage, isLifelineQuestion, LIFELINE_PROMISE_RE, LIFELINE_CONTACT_HEAD } from "../aix-lifeline";
import { confirmTopicForCheckPattern, checkPatternForConfirmTopic, classifyStaffTextForLedger } from "../action-ledger";
import { normalizeBrainCheckPattern } from "../brain-check-pattern";
import { CHECK_PATTERN_TO_TOPIC, TOPIC_TO_CHECK_PATTERN } from "../aix-jev";
import { CONDITION_CHECK_OPTIONS } from "../aix-pickers";
import { detectAixSceneEvidence } from "../aix-scene-evidence";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };

it("問い: 実物を拾う・費用や設備の話は拾わない", () => {
  ok(isLifelineQuestion("お振込み完了とのことです！\n\nライフラインのご連絡先など送って頂きたいです🙏🏻"), "9/25");
  ok(isLifelineQuestion("植田様のライフラインも送っていただきたいです！"), "9/28");
  ok(isLifelineQuestion("水道の開栓は入居日と同時になりますか？"), "6/24");
  ok(isLifelineQuestion("電気の手続きはどこに連絡すればいいですか？"), "電気の手続き");
  ok(!isLifelineQuestion("ガス代は家賃に込みですか？"), "ガス代");
  ok(!isLifelineQuestion("こちらはプロパンガスですか？"), "プロパン");
  ok(!isLifelineQuestion("初期費用0円でライフラインのお話聞くだけで2万くれるとこもありました。"), "他社の話");
});
it("連絡先はスタッフの入力のまま・LLM の写しは落とす", () => {
  const contacts = "関西電力\n0800-777-8810\n\n大阪ガス\n0120-0-94817";
  const gen = "ハイツA101のライフラインにつきまして管理会社に確認させて頂きましたところ、特に指定はございませんでした😊！！\n【ライフラインご連絡先】\n関西電力\n0800-777-8811";
  const out = composeLifelineMessage(gen, contacts);
  ok(out.startsWith("ハイツA101のライフラインにつきまして"), out);
  ok(out.endsWith(`${LIFELINE_CONTACT_HEAD}\n\n${contacts}`), out);
  ok(!out.includes("0800-777-8811"), "LLM の写し間違いが残る");
  ok((out.match(/【ライフラインご連絡先】/g) ?? []).length === 1, "見出しが2つ");
});
it("連絡先が空なら本文だけ・見出し付きで入れた時は二重にしない", () => {
  ok(composeLifelineMessage("Aのライフラインにつきまして…特に指定はございませんでした😊！！", "") === "Aのライフラインにつきまして…特に指定はございませんでした😊！！", "空");
  const c = `${LIFELINE_CONTACT_HEAD}\n関西電力\n0800-777-8810`;
  const out = composeLifelineMessage("本文", c);
  ok((out.match(/【ライフラインご連絡先】/g) ?? []).length === 1 && out.endsWith(c), out);
});
it("約束の台帳: 「別途ご案内させて頂きます」を約束（要件 ライフライン）にする・ピッカーと行き来", () => {
  ok(LIFELINE_PROMISE_RE.test("ライフラインのお手続きにつきましては別途ご案内させて頂きます！！"), "正規表現");
  const e = classifyStaffTextForLedger("はい😊！！\nライフラインのお手続きにつきましては別途ご案内させて頂きます！！", "2026-10-18T10:00:00Z");
  ok(e?.kind === "confirmation_promised" && e.detail?.object === "ライフライン", JSON.stringify(e));
  ok(confirmTopicForCheckPattern("mgmt_lifeline") === "ライフライン" && checkPatternForConfirmTopic("ライフライン") === "mgmt_lifeline", "行き来");
});
it("ブレインの check_pattern・Jev・ピッカーの一覧", () => {
  ok(normalizeBrainCheckPattern("mgmt_lifeline") === "mgmt_lifeline", "brain");
  ok(CHECK_PATTERN_TO_TOPIC.mgmt_lifeline === "lifeline" && TOPIC_TO_CHECK_PATTERN.lifeline === "mgmt_lifeline", "jev");
  ok(CONDITION_CHECK_OPTIONS.some((o) => o.value === "mgmt_lifeline" && o.label === "ライフラインについて"), "picker");
});
it("場面の網: ライフラインの問い → property_check_result/mgmt_lifeline（約束の後）・off で出ない", () => {
  const input: Parameters<typeof detectAixSceneEvidence>[0] = { latestCustomerTurn: "植田様のライフラインも送っていただきたいです！", hasCustomerImage: false, recentMessages: [] };
  const ev = detectAixSceneEvidence(input);
  ok(ev?.checkPattern === "mgmt_lifeline" && ev.timing === "after_confirm", JSON.stringify(ev));
  process.env.AIX_MGMT_LIFELINE = "off";
  try { ok(detectAixSceneEvidence(input)?.checkPattern !== "mgmt_lifeline", "off でも出る"); } finally { delete process.env.AIX_MGMT_LIFELINE; }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
