// 2026-10-01 竹内「『家賃込の価格でしょうか？』に対しては初期費用は前家賃込みとなっている…家賃込みだけの部分ならAIXじゃなくて自動返信からでも大丈夫」
// 実行: npx tsx app/lib/__tests__/rent-included-question.test.ts（自己完結ハーネス。全 PASS で exit 0）
// 文は全部お客様・スタッフの実送信（scripts/audit-rent-included-question.ts の出力）のまま
import { isRentIncludedQuestion, rentIncludedOnlyTurn } from "../rent-included-question";
import { matchCompanyFacts } from "../company-facts";
import { findCompanyFactContradiction, findCompanyFactContradictionsUngated } from "../company-fact-guard";
import { customerAsksCostComposition } from "../cost-breakdown";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

it("ひまり 9/26「家賃込の価格でしょうか？」→ 家賃込みかの質問", () => {
  expect(isRentIncludedQuestion("家賃込の価格でしょうか？")).toBe(true);
});
it("8b260f7e 7/14・5752c0d1 7/21（スタッフは手打ちで答えた）→ 家賃込みかの質問", () => {
  expect(isRentIncludedQuestion("8月末から入居したとして、そこから9月末までの家賃は初期費用に含まれているってことですよね！")).toBe(true);
  expect(isRentIncludedQuestion("9/1入居なら 以前の初期費用に10月分家賃が含まれてる認識でしょうか？")).toBe(true);
  expect(isRentIncludedQuestion("9/1入居の場合の初期費用が上記であれば初期費用に10月分家賃が入ってるのかとおもっておりまして")).toBe(true);
});
it("初期費用の中身（家賃だけで住めるか・日割）は当たらない＝AIX【初期費用について】のまま", () => {
  expect(isRentIncludedQuestion("例えばこの場合家賃と管理費を先振り込んだら住めるってことですか？")).toBe(false);
  expect(isRentIncludedQuestion("翌月分の家賃込みという事は 入居日次第では日割りの家賃分もプラスで要るという事ですかね？")).toBe(false);
  expect(isRentIncludedQuestion("前家賃だけで入居できるところないですか？？")).toBe(false);
});
it("家賃の条件・値引き・支払い方法は当たらない", () => {
  expect(isRentIncludedQuestion("RIFFの物件なんですが家賃込み込みで7万になりませんか？")).toBe(false);
  expect(isRentIncludedQuestion("家賃は共益費込みでの値段なのでお願いいたします🙇‍♂️")).toBe(false);
  expect(isRentIncludedQuestion("すみません💦100000円は管理費も込みでしょうか？")).toBe(false);
  expect(isRentIncludedQuestion("あと、家賃は振込みでせっていしたいのですが可能でしょうか。")).toBe(false);
  expect(isRentIncludedQuestion("では、家賃12万円（共益費込み）で、お願いします。")).toBe(false);
});
it("条件フォームは当たらない", () => {
  expect(isRentIncludedQuestion("（みことさんご希望のお部屋探しご条件） ①ご入居時期 2ヶ月後 ②ご希望家賃（管理費込み） 6～7 ③ご希望間取り 1K")).toBe(false);
});
it("連投: 家賃込みかの質問＋お礼だけ → true／他に依頼・質問（内覧・見積もり）→ false（ブレインの判断のまま）", () => {
  expect(rentIncludedOnlyTurn("ありがとうございます！\n家賃込の価格でしょうか？")).toBe(true);
  expect(rentIncludedOnlyTurn("家賃込の価格でしょうか？\n内覧したいです")).toBe(false);
  expect(rentIncludedOnlyTurn("家賃込の価格でしょうか？\nあと見積もりお願いします")).toBe(false);
  expect(rentIncludedOnlyTurn("家賃込の価格でしょうか？\n火災保険は別ですか？")).toBe(false);
  expect(rentIncludedOnlyTurn("ありがとうございます")).toBe(false);
});
it("S9（初期費用の中身）にも当たる文がある＝ブレインの入口は家賃込みかを先に採る（S9 だけの文は従来どおり）", () => {
  expect(customerAsksCostComposition("8月末から入居したとして、そこから9月末までの家賃は初期費用に含まれているってことですよね！")).toBe(true);
  expect(customerAsksCostComposition("家賃込の価格でしょうか？")).toBe(false);
});
it("会社の事実（返信の生成・最終チェック）: 家賃込みの質問の時だけ rent_included が届く", () => {
  expect(matchCompanyFacts("家賃込の価格でしょうか？").some((f) => f.id === "rent_included")).toBe(true);
  expect(matchCompanyFacts("火災保険は別ですか？").some((f) => f.id === "rent_included")).toBe(false);
});
it("出口: AIX の下書きの「いいえ、家賃は含まれておりません」は家賃込みの質問の時に指摘（実送信 365日で 0通の形）", () => {
  const draft = "ひまりさんお世話になっております！！\nいいえ、家賃は含まれておりません！！\nこちら初期費用137,980円に鍵交換代・賃貸保証料・火災保険・仲介手数料まで含めさせて頂いております😊！！";
  expect(findCompanyFactContradiction(draft, ["家賃込の価格でしょうか？"])?.factId).toBe("rent_included");
  expect(findCompanyFactContradiction(draft, ["火災保険は別ですか？"])).toBe(null);
});
it("出口は正しい文に当てない（スタッフの実送信・日割家賃・管理費）", () => {
  for (const s of [
    "ひまりさんお世話になっております！！\n初期費用翌月分の前家賃込みとなります！！",
    "はい！！ 初期費用156980円となります！！ こちらの費用は初期費用の前家賃が含まれております😊！！",
    "見積書記載の金額は翌月分（9月分）の家賃が含まれた総額となっております！！",
    "こちらの御見積書には日割家賃は含まれておりません！！",
    "家賃に管理費は含まれておりません！！",
  ]) expect(findCompanyFactContradictionsUngated(s).some((h) => h.factId === "rent_included")).toBe(false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
