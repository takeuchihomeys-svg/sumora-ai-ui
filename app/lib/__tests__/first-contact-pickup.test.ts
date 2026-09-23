// 真の初回の「最初の一手」（first_contact_pickup）を決める純関数のテスト（自己完結ハーネス）
// 実行: npx tsx app/lib/__tests__/first-contact-pickup.test.ts
// 実物: scripts/audit-first-move.ts F（09-12 以降の初回ガード 44会話）で読んだお客様の本文と scene_evidence
import { resolveFirstContactPickup, isFirstContactPropertyNomination, firstContactSuggestedAction } from "../first-contact-pickup";
import { isConditionFormMessage } from "../reply-context";
import { detectAixSceneEvidence } from "../aix-scene-evidence";
import { compactSceneEvidence } from "../brain-aix-feedback";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const eq = (a: unknown, b: unknown) => { if (a !== b) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };

/** brain-core の初回ガードと同じ組み立て: 条件フォーム判定＋場面の証拠（決定論）→ 純関数 */
function pickupFor(customerText: string, o: { finalAix?: string | null; hasImage?: boolean } = {}) {
  const scene = compactSceneEvidence(detectAixSceneEvidence({ latestCustomerTurn: customerText, hasCustomerImage: !!o.hasImage }));
  return resolveFirstContactPickup({ finalAix: o.finalAix ?? null, custSentConditionForm: isConditionFormMessage(customerText), sceneEvidence: scene });
}

// 実物（F 条件フォーム 17会話: 要対応 15/17・最初の返信はピックアップ宣言 14/14・押した AIX は property_send 10/12）
describe("条件フォーム → property_send（現行の線・壊さない）", () => {
  const form = "▶︎【お部屋お探し中！】（ご希望のお部屋探しご条件）\n①ご希望エリア⇒大阪市内 城東区\n②家賃⇒7万円まで\n③間取り⇒1LDK\n④入居時期⇒11月上旬\n⑤その他⇒オートロック";
  it("フォーム本文 → property_send", () => eq(pickupFor(form), "property_send"));
  it("LLM が estimate_sheet を選んでもフォームなら property_send", () => eq(pickupFor(form, { finalAix: "estimate_sheet" }), "property_send"));
  it("LLM が property_send を選んだ文だけの依頼 → property_send", () =>
    eq(pickupFor("大阪市内で家賃7万以内の1LDKを探しています。11月入居希望です", { finalAix: "property_send" }), "property_send"));
  it("LLM が property_search → property_send", () =>
    eq(pickupFor("京橋駅の近くで探してます", { finalAix: "property_search" }), "property_send"));
});

// 実物（F 物件画像 6会話: 最初の返信は募集状況確認の宣言 3/4・押した AIX は estimate_sheet 3/3。#41・#54 の scene）
describe("物件の画像／URL の指名 → property_check_result（新規）", () => {
  it("[画像] だけ（#41: scene S1_vacancy・property_nomination・image）", () =>
    eq(pickupFor("[画像]", { hasImage: true }), "property_check_result"));
  it("画像＋「この物件気になってます」（#54）", () =>
    eq(pickupFor("[画像]\nこの物件気になってます！空いてますか？", { hasImage: true }), "property_check_result"));
  it("URL だけ", () => eq(pickupFor("https://suumo.jp/chintai/jnc_000012345678/"), "property_check_result"));
  it("LLM が estimate_sheet を選んでも初回は募集状況の確認が先", () =>
    eq(pickupFor("[画像]\nこちらの物件はまだ空いてますか？", { hasImage: true, finalAix: "estimate_sheet" }), "property_check_result"));
  // 画像＋費用の質問は場面が S6（見積・費用）になり物件指名ではない。初回で見積を先に出す線は実物に無いので null のまま（ガード後の fresh 層に委ねる）
  it("画像＋費用の質問（scene S6）→ null（線を引いていない）", () =>
    eq(pickupFor("[画像]\nここの初期費用いくらですか", { hasImage: true, finalAix: "estimate_sheet" }), null));
  it("DB の scene_evidence（compact 形）をそのまま渡せる", () =>
    eq(resolveFirstContactPickup({ finalAix: null, custSentConditionForm: false, sceneEvidence: { scene: "S1_vacancy", reason: "property_nomination", property_by: "image" } }), "property_check_result"));
});

// 実物（F 文だけ 19会話: 未返信 12＝業者DM・既存入居者・入金相談／ピックアップ宣言 6）
describe("文だけ・業者DM → null（挨拶下書きだけ・要対応を立てない）", () => {
  it("「お部屋探し希望です」→ null", () => eq(pickupFor("お部屋探し希望です"), null));
  it("「ブラックなど審査は通らないですか」→ null", () => eq(pickupFor("ブラックなど審査は通らないですか"), null));
  it("「不動産屋の会社名教えてください」→ null", () => eq(pickupFor("不動産屋の会社名教えてください"), null));
  it("業者DM「公式LINEへ突然失礼します…賃太郎…」→ null", () =>
    eq(pickupFor("公式LINEへ突然失礼します。賃太郎の〇〇と申します。賃貸仲介の集客でお困りではないでしょうか？"), null));
  it("LLM=estimate_sheet で scene 無し → null（見積る物件が無い）", () =>
    eq(pickupFor("初期費用ってだいたいいくらくらいですか", { finalAix: "estimate_sheet" }), null));
  it("LLM=property_check_result でも画像／URL の指名が無ければ null", () =>
    eq(pickupFor("いい物件ありますか", { finalAix: "property_check_result" }), null));
  it("空文字 → null", () => eq(pickupFor(""), null));
});

// 監査で止めた判断: 初回の condition_hearing は実送信 4.6%／最初の AIX 8.6% で線が引けない
describe("condition_hearing は初回の一手にしない（線が引けない）", () => {
  it("LLM が condition_hearing → null", () => eq(pickupFor("引っ越し考えてます", { finalAix: "condition_hearing" }), null));
});

// 文の物件名・号室だけ（property_word・room_no）は初回では材料にしない（画像／URL の実物しか線が無い）
describe("物件の指名の根拠の線", () => {
  it("image → 指名", () => eq(isFirstContactPropertyNomination({ reason: "property_nomination", property_by: "image" }), true));
  it("url → 指名", () => eq(isFirstContactPropertyNomination({ reason: "property_nomination", property_by: "url" }), true));
  it("property_word → 指名にしない", () => eq(isFirstContactPropertyNomination({ reason: "property_nomination", property_by: "property_word" }), false));
  it("別の理由（availability_question）→ 指名にしない", () => eq(isFirstContactPropertyNomination({ reason: "availability_question", property_by: "image" }), false));
  it("null → false", () => eq(isFirstContactPropertyNomination(null), false));
});

// 反証者が120日を全件当てて見つけた1件: 電子契約完了画面のスクショ＋名乗り（契約段階のお客様）に要対応が立っていた
describe("画像の指名でも物件の画像でない種類は募集状況の確認にしない", () => {
  const scene = { scene: "S1_vacancy", reason: "property_nomination", property_by: "image" };
  it("image_type=id_document（本人確認書類）→ null", () => eq(resolveFirstContactPickup({ finalAix: null, custSentConditionForm: false, sceneEvidence: scene, imageType: "id_document" }), null));
  it("image_type=estimate（見積書）→ null", () => eq(resolveFirstContactPickup({ finalAix: null, custSentConditionForm: false, sceneEvidence: scene, imageType: "estimate" }), null));
  it("image_type=other（TikTok のスクショはこれ）→ property_check_result のまま", () => eq(resolveFirstContactPickup({ finalAix: null, custSentConditionForm: false, sceneEvidence: scene, imageType: "other" }), "property_check_result"));
  it("image_type 未読み取り（null）→ property_check_result のまま", () => eq(resolveFirstContactPickup({ finalAix: null, custSentConditionForm: false, sceneEvidence: scene, imageType: null }), "property_check_result"));
  it("URL の指名は image_type に関係なく property_check_result", () => eq(resolveFirstContactPickup({ finalAix: null, custSentConditionForm: false, sceneEvidence: { ...scene, property_by: "url" }, imageType: "id_document" }), "property_check_result"));
});

// brain_decision_logs に残す suggested_action（測り方の穴）
describe("suggested_action は action が無ければ first_contact_pickup", () => {
  it("action あり → action", () => eq(firstContactSuggestedAction("viewing_invite", "property_send"), "viewing_invite"));
  it("action なし・pickup あり → pickup", () => eq(firstContactSuggestedAction(null, "property_check_result"), "property_check_result"));
  it("両方なし → null", () => eq(firstContactSuggestedAction(null, null), null));
  it("空文字は無し扱い", () => eq(firstContactSuggestedAction("", ""), null));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
