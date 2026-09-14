// 2026-09-14 あい事例: 見積書を送った物件への「いちばん早くて10月末入居ですか？」は、管理会社に入居可能日を確認して
//   AIX【物件確認した→入居可能日（mgmt_move_in）】で答える。確認します・本文での当て推量にしない。
// 実行: npx tsx app/lib/__tests__/move-in-check.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { detectAixSceneEvidence, customerRequestedPropertyCheck, lastStaffTurnFocus, type SceneEvidenceInput } from "../aix-scene-evidence";
import { MOVEIN_Q_RE } from "../scene-patterns";
import { sceneSignalFallback, buildSceneEvidencePromptText } from "../brain-aix-feedback";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}
const ESTIMATE = [
  { sender: "staff", text: "ル・クレール今福502号室\n9/30日退去予定のお部屋となります！！" },
  { sender: "customer", text: "ここの初期費用はどれぐらいですか？" },
  { sender: "staff", text: "[画像]" },
  { sender: "staff", text: "【ル・クレール今福 502号室】\n\n初期費用さらに\n🌟27,000円割引させて頂き\n初期費用：88,440円\n\n※ご入居日によって日割家賃が発生致します。" },
  { sender: "staff", text: "あいさんお世話になっております！！\nこちら初期費用の御見積書となります！\nお気に召されましたらお申込しお部屋抑えさせて頂きます😊！！" },
  { sender: "customer", text: "ありがとうございます" },
  { sender: "customer", text: "いちばん早くて10月末入居ですか？" },
];
const ev = (o: Partial<SceneEvidenceInput>) => detectAixSceneEvidence({ latestCustomerTurn: "", hasCustomerImage: false, ...o });

it("あい: 見積書の直後の「いちばん早くて10月末入居ですか？」→ S2・mgmt_move_in・物件の特定は context", () => {
  const e = ev({ latestCustomerTurn: "ありがとうございます\nいちばん早くて10月末入居ですか？", recentMessages: ESTIMATE, propertyStatus: "move_out_scheduled" });
  expect(e?.scene).toBe("S2_move_in"); expect(e?.checkPattern).toBe("mgmt_move_in"); expect(e?.propertySpecifiedBy).toBe("context");
  expect(sceneSignalFallback(e)?.action).toBe("property_check_result");
  expect(buildSceneEvidencePromptText(e, []).includes("直前にこちらが送った1件の物件")).toBe(true);
});
it("あい: お客様からの確認の依頼として数える（物件確認のやること）", () =>
  expect(customerRequestedPropertyCheck({ recentMessages: ESTIMATE })).toBe(true));
it("退去予定でない物件（即入居・クリーニング中）の見積書の後は context にしない（スタッフは本文で答えた）", () =>
  expect(ev({ latestCustomerTurn: "いちばん早くて10月末入居ですか？", recentMessages: ESTIMATE.slice(1) })).toBe(null));
it("入居日の希望を言っただけ（質問ではない）は context にしない", () =>
  expect(ev({ latestCustomerTurn: "最短で8末入居 8/15入金みたいなのが理想です。。", recentMessages: ESTIMATE, propertyStatus: "move_out_scheduled" })).toBe(null));
it("物件の文脈が無い一般の質問（条件のヒアリング中）は S2 にしない", () => {
  const msgs = [{ sender: "staff", text: "ご希望のご条件お送りください！！" }, { sender: "customer", text: "いちばん早くていつ入居できますか？" }];
  expect(ev({ latestCustomerTurn: "いちばん早くていつ入居できますか？", recentMessages: msgs, propertyStatus: "move_out_scheduled" })).toBe(null);
});
it("複数の物件を送った直後（URL 2件以上）は1つに決まらないので context にしない", () => {
  const msgs = [{ sender: "staff", text: "◎A https://a.example/1\n◎B https://b.example/2" }, { sender: "customer", text: "いちばん早くて何日入居になりますか？" }];
  expect(lastStaffTurnFocus(msgs).focus).toBe(false);
  expect(ev({ latestCustomerTurn: "いちばん早くて何日入居になりますか？", recentMessages: msgs, propertyStatus: "move_out_scheduled" })).toBe(null);
});
it("入居時期を伝え済みの物件は本文で答える（context にしない）", () => {
  const msgs = [{ sender: "staff", text: "【フィレンツェ 1109号室】\n8月末退去予定・9月中旬ご入居可能なお部屋です！！\n初期費用さらに🌟2万円割引させて頂き" }, { sender: "customer", text: "何日入居になりますか？" }];
  expect(lastStaffTurnFocus(msgs).moveInTold).toBe(true);
  expect(ev({ latestCustomerTurn: "何日入居になりますか？", recentMessages: msgs, propertyStatus: "move_out_scheduled" })).toBe(null);
});
it("入居日の質問の言い回しを広げた（質問の形だけ）", () => {
  for (const t of ["いちばん早くて10月末入居ですか？", "入居日いつからなら可能なんですか？", "何日入居になりますか？ 最短で！", "入居はいつ頃になりますか", "早ければいつ頃住めますか？"])
    expect(MOVEIN_Q_RE.test(t)).toBe(true);
});
it("入居日の質問ではないもの（希望・予定・申込時期・いつでも）は含めない", () => {
  for (const t of ["もう体調戻って8月には入居できるように動きたいです", "入居はいつでも大丈夫です", "10月末入居希望だといつ頃申し込めばいいでしょうか？", "入居時期はいつまで待ってもらえますか？", "早めに入居したいです"])
    expect(MOVEIN_Q_RE.test(t)).toBe(false);
});
it("物件の語がある入居日の質問は従来どおり（context は使わない）", () =>
  expect(ev({ latestCustomerTurn: "この物件の最短入居可能日はいつですか？" })?.propertySpecifiedBy).toBe("property_word"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
