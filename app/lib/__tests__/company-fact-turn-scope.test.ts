// 2026-10-20 会社の事実の窓は「今回の番」（こちらの最後の送信より後のお客様の発言）だけ（company-facts.customerTextsForCompanyFacts）
// 本番 10/20 13:07（スモラ）: 他社で内見してよいかの問い（12:53）にスタッフが答えて弊社での内覧に進んだ後の番で、
//   ブレイン・最終チェックの窓（直近のお客様3通）が前の問いを拾い other_company_viewing を「今聞いている」と渡していた。文は言い換え（個人の事情は入れない）
// 実行: npx tsx app/lib/__tests__/company-fact-turn-scope.test.ts
import { customerTextsForCompanyFacts, matchCompanyFacts, buildCompanyFactsNote } from "../company-facts";
import { buildCompanyFactsForCheck } from "../company-fact-guard";
import { companyFactCustomerTexts, companyFactGuardCustomerTexts, runVocabSemanticChecks } from "../final-check";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(name); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(got: T, want: T) { const a = JSON.stringify(got), b = JSON.stringify(want); if (a !== b) throw new Error(`期待 ${b}\n      実際 ${a}`); }

const OTHER_VIEW = "弊社の方が安いので契約はそちらでしたいのですが、他社さんでこの物件の内見の予定があって、一度そっちで内見だけしてこようかなと思ってるんですが大丈夫でしょうか？？";
const conv = [
  { sender: "customer", text: "この物件、他社さんで紹介してもらっているのですが、そちらだと初期費用どれぐらいですか？" },
  { sender: "staff", text: "御見積書をお送りさせて頂きます！！" },
  { sender: "customer", text: "やす！！" },
  { sender: "customer", text: OTHER_VIEW },
  { sender: "staff", text: "大丈夫です😊！！よろしければ弊社にてご内見可能です！！" },
  { sender: "customer", text: "それならお願いします！\n他社さんうまく断ります笑" },
  { sender: "staff", text: "弊社直近ですと本日18:00〜 明日12:00〜ご案内可能です！！" },
  { sender: "customer", text: "直近だと25の夕方\nあとは28以降ならいけます" },
  { sender: "customer", text: "ちなみに審査なのですが、保証人が使えない為、別の人の名義で審査を通そうと思っております。" },
];
const upTo1301 = conv.slice(0, 8);   // 13:01 の番（13:02 の発言が届く前に作られた下書き）

it("前提: 前の問い（他社で内見してよいか）には other_company_viewing が当たる", () => {
  eq(matchCompanyFacts(OTHER_VIEW).map((f) => f.id).includes("other_company_viewing"), true);
});
it("今回の番＝こちらの最後の送信より後のお客様の発言だけ（連投は2通とも）", () => {
  eq(customerTextsForCompanyFacts(conv), [conv[7].text, conv[8].text]);
});
it("13:01 の番: 窓は日程の返事だけ＝前の問いを拾わない（旧の窓は拾っていた）", () => {
  const now = customerTextsForCompanyFacts(upTo1301, { env: {} });
  eq(now, [conv[7].text]);
  eq(buildCompanyFactsForCheck(["", ...now]), "");
  const old = customerTextsForCompanyFacts(upTo1301, { env: { COMPANY_FACT_TURN_SCOPE: "off" } });
  eq(old.includes(OTHER_VIEW), true);
  eq(buildCompanyFactsForCheck(["", ...old]).includes("他社で内覧した"), true);
});
it("ブレインの窓（新しい順の履歴を逆にして渡す）でも同じ＝事実のブロックが出ない", () => {
  const newestFirst = [...upTo1301].reverse();
  eq(buildCompanyFactsNote(customerTextsForCompanyFacts([...newestFirst].reverse()), { account: "sumora" }), "");
});
it("今回の番で聞かれた時は渡す（聞かれた時だけの線は変えない）", () => {
  const cur = [...conv.slice(0, 7), { sender: "customer", text: OTHER_VIEW }];
  eq(matchCompanyFacts(customerTextsForCompanyFacts(cur)).map((f) => f.id).includes("other_company_viewing"), true);
});
it("最新がこちらの送信なら空（答えた後の番に前の事実を持ち越さない）", () => {
  eq(customerTextsForCompanyFacts(conv.slice(0, 5)), []);
});
it("こちらの送信が無い会話（初回の連投）は全部（最大10通）", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ sender: "customer", text: `t${i}` }));
  eq(customerTextsForCompanyFacts(many).length, 10);
  eq(customerTextsForCompanyFacts(many)[9], "t11");
});
it("戻す COMPANY_FACT_TURN_SCOPE=off は旧の窓（お客様の直近3通）", () => {
  eq(customerTextsForCompanyFacts(conv, { env: { COMPANY_FACT_TURN_SCOPE: "off" } }), [conv[5].text, conv[7].text, conv[8].text]);
});

// 2026-10-20 確かめる人: 止め（V16・V16b）の窓は狭めない＝今回の番 ∪ 旧の窓
const cardConv = [
  { sender: "customer", text: "初期費用って分割払いできますか？" },
  { sender: "staff", text: "お送り頂いたお部屋の募集状況確認させて頂きます！！" },
  { sender: "customer", text: "ありがとうございます" },
];
it("止めの窓: [COMPANY_FACTS] の窓は今回の番だけ・止めの窓は前の番の問いも含む", () => {
  eq(companyFactCustomerTexts({ recentMessages: cardConv }), ["ありがとうございます"]);
  eq(companyFactGuardCustomerTexts({ recentMessages: cardConv }).includes(cardConv[0].text), true);
});
it("V16b: 前の番でカード払いを聞かれ、下書きが手数料無しで「カードで分割できます」と書いたら今まで通り止める", () => {
  const issues = runVocabSemanticChecks("クレジットカード払いですと分割でのお支払いも可能です！！", { lastCustomerMessage: "ありがとうございます", recentMessages: cardConv } as never);
  eq(issues.some((i) => i.code === "COMPANY_FACT_CONTRADICTION"), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
