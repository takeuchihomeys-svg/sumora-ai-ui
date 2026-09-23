// 2026-09-16 竹内（慶次事例）: 「AIX か返信か」の2択をセットする場面
// 実行: npx tsx app/lib/__tests__/two-choice.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { resolveTwoChoice, TRADEOFF_QUESTION_RE, MORE_PROPERTY_REQUEST_RE } from "../two-choice";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

const base = {
  checkpointStage: "proposing" as string | null,
  sentPropertyCount: 4,
  finalAix: "property_send" as string | null,
  conditionChangeType: null as string | null,
  customerIntent: "question" as string | null,
};
const KEIJI = "礼金10万がネックですねぇ\n初期費用がどれぐらいか\n今から仕事ですので、他にあれば、送っておいてください。\n確認して見たい物件があれば、ご連絡致します。";

it("慶次: 「他にあれば、送っておいてください」＋費用の質問 → 2択（物件ピックアップか返信か）", () => {
  const v = resolveTwoChoice({ ...base, customerText: KEIJI });
  expect(v.two).toBe(true);
  expect(v.reason).toBe("more_property_request");
});
it("実データの言い方も拾う（他に物件探したくて／他に物件ありましたら送って／ほかにもおすすめの物件あれば教えて）", () => {
  for (const t of [
    "他に物件探したくて",
    "築年数が気になってしまいました。\n他に物件ありましたら送って頂きたいです。",
    "ほかにもおすすめの物件あれば教えて欲しいです。",
    "駐車場有りの物件で探していて、他にオススメの物件あれば教えていただきたいです🙇‍♀️",
  ]) expect(resolveTwoChoice({ ...base, customerText: t }).two).toBe(true);
});
it("条件のトレードオフの相談は従来どおり2択（みく事例の型）", () => {
  expect(resolveTwoChoice({ ...base, customerText: "築年数が古いのはどうなんでしょうか？" }).reason).toBe("tradeoff_question");
  expect(TRADEOFF_QUESTION_RE.test("この物件なぜ高いんですか？")).toBe(true);
});
it("出さない場面: 物件提案中でない・送付済み物件なし・確定アクション・お客様が断っている", () => {
  expect(resolveTwoChoice({ ...base, customerText: KEIJI, checkpointStage: "applying" }).reason).toBe("not_proposing");
  expect(resolveTwoChoice({ ...base, customerText: KEIJI, sentPropertyCount: 0 }).reason).toBe("no_sent_property");
  expect(resolveTwoChoice({ ...base, customerText: KEIJI, finalAix: "viewing_invite" }).reason).toBe("decided_action");
  expect(resolveTwoChoice({ ...base, customerText: KEIJI, finalAix: "application_push" }).reason).toBe("decided_action");
  expect(resolveTwoChoice({ ...base, customerText: KEIJI, customerIntent: "negative" }).reason).toBe("customer_negative");
});
it("慶次: 条件の変更（礼金がネック）が一緒でも、はっきり頼まれていれば2択にする（実会話で condition_change に弾かれていた）", () => {
  const v = resolveTwoChoice({ ...base, customerText: KEIJI, conditionChangeType: "budget" });
  expect(v.two).toBe(true);
  expect(v.reason).toBe("more_property_request");
  // 依頼が無い条件の変更だけなら従来どおり1択（物件探しが正解）
  expect(resolveTwoChoice({ ...base, customerText: "やっぱり築年数が古いのは気になります", conditionChangeType: "age" }).reason).toBe("condition_change");
});
it("合図が無ければ2択にしない（ブレインが2択と言った時だけ通す）", () => {
  expect(resolveTwoChoice({ ...base, customerText: "ありがとうございます！" }).two).toBe(false);
  expect(resolveTwoChoice({ ...base, customerText: "ありがとうございます！", llmTwoChoice: true }).reason).toBe("llm");
  expect(resolveTwoChoice({ ...base, customerText: "" }).reason).toBe("no_customer_text");
});
it("あや: 物件を受け取って「検討してみます」→ 2択（物件オススメか返信か）", () => {
  const v = resolveTwoChoice({ ...base, customerText: "物件ありがとうございます🙇🏻‍♀️՞\n検討してみます。", customerIntent: "chat" });
  expect(v.two).toBe(true);
  expect(v.reason).toBe("considering");
});
it("実データの言い方も拾う（少し検討します／考えてみます／悩んでいます／迷っています）", () => {
  for (const t of [
    "ありがとうございます！\n少し検討します！",
    "ありがとうございます🙇‍♀️\n検討させてください🙇‍♀️",
    "一度考えてみます！",
    "長居の方と悩んでいるので検討させていただきます",
    "どちらにするか迷っています",
  ]) expect(resolveTwoChoice({ ...base, customerText: t, customerIntent: "chat" }).two).toBe(true);
});
it("検討の語が本文に無くても、ブレインが「検討して持ち帰った」と読んだ時は2択", () => {
  expect(resolveTwoChoice({ ...base, customerText: "ありがとうございます！", hesitancyPattern: "thinking" }).reason).toBe("considering");
  expect(resolveTwoChoice({ ...base, customerText: "ありがとうございます！", hesitancyPattern: "undecided" }).reason).toBe("considering");
  // 折り返しの連絡待ち・時期の話は2択にしない（返信の場面ではない）
  expect(resolveTwoChoice({ ...base, customerText: "ありがとうございます！", hesitancyPattern: "callback" }).two).toBe(false);
  expect(resolveTwoChoice({ ...base, customerText: "ありがとうございます！", hesitancyPattern: "timeline" }).two).toBe(false);
});
it("お礼だけ（検討の語なし）は2択にしない＝返信せず連絡を待つ場面（朱莉事例の closed-ack の担当）", () => {
  expect(resolveTwoChoice({ ...base, customerText: "ありがとうございます！" }).two).toBe(false);
  expect(resolveTwoChoice({ ...base, customerText: "物件ありがとうございます🙇‍♀️" }).two).toBe(false);
});
it("「一旦保留で検討します」は探すのを止める話なので2択にしない（検討の語より保留が先）", () => {
  expect(resolveTwoChoice({ ...base, customerText: "一旦保留で検討させてください" }).reason).toBe("pause_search");
});

it("「他のお部屋探し保留でも大丈夫ですか」（探すのを止める話）は2択にしない", () => {
  // 語としては依頼の形に当たるが、保留・止めての時は2択にしない（実データ: かおる 7/19）
  expect(MORE_PROPERTY_REQUEST_RE.test("ちょっとまだわからないので他のお部屋探し保留でも大丈夫ですか？")).toBe(true);
  const v = resolveTwoChoice({ ...base, customerText: "ちょっとまだわからないので他のお部屋探し保留でも大丈夫ですか？" });
  expect(v.two).toBe(false);
  expect(v.reason).toBe("pause_search");
});

// ─── 謝って預けた場面（2026-09-17 竹内・慶次事例）───
it("慶次: 「本当にご無理を言いまして申し訳ありません。よろしくお願い致します。」は2択（物件ピックアップか返信か）", () => {
  const r = resolveTwoChoice({ ...base, customerText: "本当にご無理を言いまして申し訳ありません。\nよろしくお願い致します。" });
  expect(r.two).toBe(true);
  expect(r.reason).toBe("apology_entrust");
  // 条件の変更が一緒に立っていても2択にする（他のお部屋の依頼と同じ扱い）
  expect(resolveTwoChoice({ ...base, customerText: "礼金がネックですみません。よろしくお願い致します。", conditionChangeType: "budget" }).two).toBe(true);
});
it("謝罪だけ・お願いだけでは2択にしない（両方そろって預けた形の時だけ）", () => {
  expect(resolveTwoChoice({ ...base, customerText: "ありがとうございます！よろしくお願い致します。" }).reason).toBe("no_signal");
  expect(resolveTwoChoice({ ...base, customerText: "遅くなってすみません。" }).reason).toBe("no_signal");
  // 内覧・申込が決まっている時は従来どおり出さない
  expect(resolveTwoChoice({ ...base, customerText: "ご無理を言って申し訳ありません。よろしくお願いします。", finalAix: "viewing_invite" }).two).toBe(false);
});

// ─── 室内の写真の依頼（2026-09-23 竹内「室内の写真が欲しいといわれたら AIX の物件確認したの室内写真確認したのピッカーから送る形」）───
it("ブレインが写真の AIX を決めた（roomPhotoRequest）→ 2択（AIX 室内写真 か 返信 か）", () => {
  const v = resolveTwoChoice({ ...base, customerText: "これ室内写真欲しいです", finalAix: "property_check_result", roomPhotoRequest: true });
  expect(v.two).toBe(true);
  expect(v.reason).toBe("room_photo_request");
});
it("写真の依頼は内覧の段階（viewing）でも2択・申込以降は出さない", () => {
  expect(resolveTwoChoice({ ...base, customerText: "室内の写真ありますか？", finalAix: "property_check_result", roomPhotoRequest: true, checkpointStage: "viewing" }).two).toBe(true);
  expect(resolveTwoChoice({ ...base, customerText: "室内の写真ありますか？", finalAix: "property_check_result", roomPhotoRequest: true, checkpointStage: "applying" }).reason).toBe("not_proposing");
  expect(resolveTwoChoice({ ...base, customerText: "室内の写真ありますか？", finalAix: "property_check_result", roomPhotoRequest: true, checkpointStage: "hearing" }).reason).toBe("not_proposing");
});
it("送付済み物件なし・確定アクション・お客様が断っている時は従来どおり出さない", () => {
  expect(resolveTwoChoice({ ...base, customerText: "室内の写真ありますか？", roomPhotoRequest: true, sentPropertyCount: 0 }).reason).toBe("no_sent_property");
  expect(resolveTwoChoice({ ...base, customerText: "室内の写真ありますか？", roomPhotoRequest: true, finalAix: "viewing_invite" }).reason).toBe("decided_action");
  expect(resolveTwoChoice({ ...base, customerText: "室内の写真ありますか？", roomPhotoRequest: true, customerIntent: "negative" }).reason).toBe("customer_negative");
});
it("ブレインが決めていない（証拠だけ）なら写真の理由では立てない（所有権はブレイン）", () => {
  expect(resolveTwoChoice({ ...base, customerText: "室内の写真ありますか？", finalAix: "property_send" }).reason).toBe("no_signal");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
