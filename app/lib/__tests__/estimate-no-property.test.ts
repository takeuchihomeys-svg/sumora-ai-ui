// 2026-09-14 ゆうこ事例: 物件が1件も無い最初の返信に「最大限割引させていただいた御見積書を作成しお送り」が入った。
//   ①条件の復唱「家賃13万円〜・1LDK…ピックアップ」が見積金額内訳ゲートに当たり、置換文で見積書の約束になった
//   ②見積の判定が「物件なし・費用の質問」を見積書OKにしていた（見積書は物件か見積の依頼がある時だけ）
// 実行: npx tsx app/lib/__tests__/estimate-no-property.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { enforceAixGates } from "../validate-reply";
import { isMisumoriContextAppropriate, buildEstimateGateNote } from "../estimate-context";
import { costQuestionBeforeProperty } from "../cost-question-scope";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}
const FORM = "▶︎【お部屋お探し中！】\n\n（ご希望のお部屋探しご条件）\n①【ご入居の時期】⇒未定\n②【ご希望の家賃（13万円〜◯万円）】⇒\n③【希望の広さ・間取り】⇒1LDK\n④【希望築年数】\n⑤【ご希望のエリア・駅名】⇒御堂筋線 （職場が天王寺駅）\n⑥【ご希望の駅徒歩分数】⇒5分\n⑦【初期費用の限度額】⇒\n⑧【その他ご要望あれば】⇒トイレお風呂別 オートロック24時間ごみ捨て可能";
const Q = "これは分割払いで初期費用ですか？\n夜職なのですが可能ですか？\nたぶんブラックリスト入ってるのですが😭\n引越しは何月にいつしたいかは未定です";
const TURN = ["初めまして、Tiktokからきました", FORM, "初期費用34万", Q];
const ECHO = "御堂筋線周辺全域から家賃13万円〜・1LDK・駅徒歩5分以内・トイレお風呂別・オートロックでゆうこさんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！";

it("ゆうこ: 条件の復唱（家賃13万円〜＝下限だけ）は見積金額内訳ゲートで置き換えない", () => {
  const r = enforceAixGates(ECHO, { customerMessage: TURN.join("\n") });
  expect(r.violations.length).toBe(0); expect(r.cleaned).toBe(ECHO);
});
it("ゆうこ②: 予算（初期費用23万円以内）の復唱のピックアップ宣言は落とさない（条件を固める文）", () => {
  const s = "天王寺周辺・1LDK・初期費用23万円以内でゆうこさんにオススメできるお部屋ピックアップさせて頂きます！！";
  const r = enforceAixGates(s, { customerMessage: "1LDKで 職場が天王寺なので\n近くで探してて\n初期費用23万くらいで探しです", customerConditions: "初期費用上限: 230000", estimateAllowed: false });
  expect(r.violations.length).toBe(0); expect(r.cleaned).toBe(s);
});
it("物件探しの宣言でもお客様の条件に無い金額・見積の語は従来どおりゲートの対象", () => {
  expect(enforceAixGates("初期費用15万円以内のお部屋ピックアップさせて頂きます！！", { customerMessage: "初期費用なるべく安く" }).violations.length > 0).toBe(true);
  expect(enforceAixGates("初期費用23万円の御見積書と一緒にお部屋ピックアップさせて頂きます！！", { customerMessage: "初期費用23万くらい" }).violations.length > 0).toBe(true);
});
it("敷金礼金0円の条件のピックアップ宣言は落とさない", () => {
  const s = "大阪駅難波駅周辺全域から敷金礼金0円でRさんのご条件に合ったお部屋をピックアップしてお送りさせて頂きます！！";
  expect(enforceAixGates(s, { customerMessage: "敷金礼金なしで探しています" }).violations.length).toBe(0);
});
it("物件の紹介の金額（家賃管理費込82,000円…オススメ出来るお部屋）は従来どおりゲートの対象", () => {
  const r = enforceAixGates("家賃管理費込82,000円の2LDK、駐車場付きでかなりオススメ出来るお部屋となります！！", { customerMessage: "家賃8万円以内で探しています" });
  expect(r.violations.some((v) => /見積金額内訳/.test(v))).toBe(true);
});
it("見積書が不許可の文脈（estimateAllowed=false）では金額の文を落とすだけ・見積書の約束を入れない", () => {
  const r = enforceAixGates("初期費用は敷金50,000円・礼金1ヶ月分となります！！\nよろしくお願いします！！", { customerMessage: "初期費用はいくらですか？", estimateAllowed: false });
  expect(/見積/.test(r.cleaned)).toBe(false); expect(/50,000円/.test(r.cleaned)).toBe(false);
});
it("見積書が許可の文脈では従来どおり見積書の作成宣言に置き換える", () => {
  const r = enforceAixGates("敷金50,000円・礼金1ヶ月分となります！！", { customerMessage: "この物件の初期費用はいくらですか？", estimateAllowed: true });
  expect(/御見積書を作成しお送り/.test(r.cleaned)).toBe(true);
});
it("物件固有金額の置換文に社内の操作名（AIX【見積書送る】）を入れない", () => {
  const r = enforceAixGates("管理費は¥5,000となります！！", { customerMessage: "管理費はいくらですか？" });
  expect(/AIX|スタッフが資料/.test(r.cleaned)).toBe(false);
});

const base = { customerMessage: Q, recentCustomerMessages: TURN.slice(0, 3), lastStaffMessage: "", brainFresh: false };
it("ゆうこ: 物件が無い費用の質問は見積書不許可（forbid・cost_question_no_property）", () => {
  const v = isMisumoriContextAppropriate({ ...base, sentPropertiesCount: 0 });
  expect(v.mode).toBe("forbid"); expect(v.signals.includes("cost_question_no_property")).toBe(true);
  expect(buildEstimateGateNote(v).includes("物件はまだ無い")).toBe(true);
});
it("送付済みの物件がある時の費用の質問は従来どおり見積書（declare）", () =>
  expect(isMisumoriContextAppropriate({ ...base, customerMessage: "初期費用はいくらですか？", sentPropertiesCount: 3 }).mode).toBe("declare"));
it("お客様が物件（URL・画像）を送った費用の質問は見積書（declare）", () => {
  expect(isMisumoriContextAppropriate({ ...base, customerMessage: "https://suumo.jp/chintai/x/ ここの初期費用いくらですか？", sentPropertiesCount: 0 }).mode).toBe("declare");
  expect(isMisumoriContextAppropriate({ ...base, customerMessage: "ここの初期費用いくらですか？", hasCustomerImage: true, sentPropertiesCount: 0 }).mode).toBe("declare");
});
it("連投の前の通に URL・「ここと ここと ここの初期費用」・「お見積もり確認したい」は物件・依頼あり（declare）", () => {
  expect(isMisumoriContextAppropriate({ ...base, customerMessage: "費用抑えたいです😭 どのくらいですか？", recentCustomerMessages: ["https://suumo.jp/chintai/bc_1/"], sentPropertiesCount: 0 }).mode).toBe("declare");
  expect(isMisumoriContextAppropriate({ ...base, customerMessage: "ここと ここと ここのそれぞれの初期費用教えて欲しいです", recentCustomerMessages: [], sentPropertiesCount: 0 }).mode).toBe("declare");
  expect(isMisumoriContextAppropriate({ ...base, customerMessage: "初期費用のお見積もり確認したいです", recentCustomerMessages: [], sentPropertiesCount: 0 }).mode).toBe("declare");
});
it("物件が無くても見積の依頼なら見積書（declare）", () =>
  expect(isMisumoriContextAppropriate({ ...base, customerMessage: "見積もりお願いできますか？", sentPropertiesCount: 0 }).mode).toBe("declare"));

it("costQuestionBeforeProperty: ゆうこ → true／物件あり・送付済み・見積の依頼 → false", () => {
  expect(costQuestionBeforeProperty(TURN.join("\n"), 0)).toBe(true);
  expect(costQuestionBeforeProperty(TURN.join("\n"), 2)).toBe(false);
  expect(costQuestionBeforeProperty("[画像]\nここの初期費用いくらですか？", 0)).toBe(false);
  expect(costQuestionBeforeProperty("見積もりお願いできますか？初期費用いくらですか", 0)).toBe(false);
  expect(costQuestionBeforeProperty(FORM, 0)).toBe(false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
