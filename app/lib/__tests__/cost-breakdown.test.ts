// 2026-09-15 竹内（ゆうこ事例）: AIX【初期費用について】— 見積書の画像の読み取り結果だけで初期費用の中身を答える
// 実行: npx tsx app/lib/__tests__/cost-breakdown.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { customerAsksCostComposition, parseCostBreakdownJson, formatCostBreakdownFacts, checkAmountsAgainstBreakdown, yenOf } from "../cost-breakdown";
import { enforceAixGates, isCostBreakdownExplanation } from "../validate-reply";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(s: string) { if (!String(actual).includes(s)) throw new Error(`expected to contain ${JSON.stringify(s)} in ${JSON.stringify(actual)}`); },
    notToContain(s: string) { if (String(actual).includes(s)) throw new Error(`expected NOT to contain ${JSON.stringify(s)} in ${JSON.stringify(actual)}`); },
  };
}

it("実例（ゆうこ・他）: 家賃だけで住めるか・何が含まれるか・火災保険は別か → 初期費用について", () => {
  for (const t of [
    "家賃だけ払ったら住めるんですか？",
    "例えばこの場合家賃と管理費を先振り込んだら住めるってことですか？",
    "初期費用とは別の火災保険ですかね？💦",
    "SUUMOに書いてある鍵交換代とかももろもろかかってまた金額上乗せされていきますよね",
    "クリーニング代38,300円が敷金から精算されるのか、敷金とは別に退去時に38,300円を支払いになるんですか？",
    "初期費用って何が含まれてますか？",
  ]) expect(customerAsksCostComposition(t)).toBe(true);
});
it("除外: 値引きの相談・支払い方法・金額だけの質問・安さへの不安・画像の読み取り文字・条件の話", () => {
  for (const t of [
    "もう少し初期費用安くなる物件ってないですよね…？",
    "これは分割払いで初期費用ですか？",
    "初期費用が8日に引き落とされるということですかね、？",
    "初期費用いくらですか？",
    "仲介手数料無しで大丈夫でしょうか？安いのには何か理由があるのでしょうか？",
    "[画像] 家賃 33,000円\n敷金 50000円\n礼金 19,500円",
    "初期費用を10万以下と家賃5万円代の物件ってやはり築が古くなりますか？",
    "初期費用など次第では申し込み考えさせていただきたいとおもってます",
    // 実データの誤検出（240日・21件中）: 見積書の依頼・金額の質問・契約の手続き
    "はじめまして。この物件について、初期費用の見積もりをお願いしたく、ご連絡いたしました。可能でしたら、初期費用の総額と内訳をお送りいただけますでしょうか。",
    "こちらの物件の初期費用はおいくらになりますでしょうか？あわせて、初期費用の内訳も教えていただけますと幸いです。",
    "BKBの31から入れるのですが31の分の家賃、日割家賃？何円かかりますか🙇‍♀️",
    "火災保険の封筒ってなんですか？ ウェブ登録だけしてまだ代金支払ってないです💦",
    "すみません、あと今保証会社から電話かかってきたのですがこれはなんの電話でしょうか？",
    "火災保険は申し込み中です。 新しい見積書はお願い出来ませんか？",
  ]) expect(customerAsksCostComposition(t)).toBe(false);
});

const visionJson = `{"property_name":"レシオス阿倍野ヴィータ","room_number":"303","monthly_rent":"62,000円","management_fee":"5,000円",
"items":[{"label":"敷金","amount":"0円"},{"label":"礼金","amount":"62,000円"},{"label":"保証料","amount":"33,500円"},{"label":"鍵交換","amount":"22,000円"},{"label":"前家賃","amount":"67,000円"}],
"discount":"30,000円","total":"154,500円","saving":"98,000円","notes":["※ご入居日によって日割家賃が発生致します","退去時クリーニング 38,500円（退去時）"]}`;

it("読み取り結果の整形: 項目・合計・割引・注記（0円の行も残す）", () => {
  const b = parseCostBreakdownJson("```json\n" + visionJson + "\n```");
  if (!b) throw new Error("parse failed");
  expect(b.items.length).toBe(5);
  expect(b.items[0].amount).toBe(0);
  expect(b.total).toBe(154500);
  expect(b.notes.length).toBe(2);
  expect(parseCostBreakdownJson('{"items":[]}')).toBe(null); // 何も読めなければ作らない
});

it("確定事実のブロック: 金額は見積書の数字だけ・火災保険は行が無くスタッフ入力も無ければ触れない・日割家賃は計算しない", () => {
  const b = parseCostBreakdownJson(visionJson)!;
  const f = formatCostBreakdownFacts([b]);
  expect(f.block).toContain("レシオス阿倍野ヴィータ 303号室");
  expect(f.block).toContain("礼金: 62,000円");
  expect(f.block).toContain("※0円の項目: 敷金");
  expect(f.block).toContain("火災保険: 御見積書の項目に無い。別途かどうか・金額は分からないので触れない");
  expect(f.block).toContain("日割家賃: ご入居日によって発生する（金額は計算しない");
  expect(f.allowedAmounts.includes(67000)).toBe(true); // 家賃＋管理費
  const withIns = formatCostBreakdownFacts([b], { insuranceSeparateYen: 18000 });
  expect(withIns.block).toContain("別途 18,000円 必要");
  expect(withIns.allowedAmounts.includes(18000)).toBe(true);
});

it("実物の御見積書（コーポ平野上町・火災保険18,000円が合計に含まれる）: 「含まれている・別途と書かない」と明示する（手本の「火災保険は別途」を写した誤りの再発防止）", () => {
  const real = parseCostBreakdownJson(JSON.stringify({ property_name: "コーポ平野上町", room_number: "303", items: [
    { label: "敷金", amount: "0" }, { label: "礼金", amount: "0" }, { label: "翌月分家賃", amount: "38,000" }, { label: "鍵交換代", amount: "18,700" },
    { label: "賃貸保証料(50%の場合)", amount: "21,500" }, { label: "火災保険", amount: "18,000" }, { label: "仲介手数料", amount: "0" },
  ], discount: "8,000", total: "109,700" }))!;
  const f = formatCostBreakdownFacts([real], { insuranceSeparateYen: 18000 });
  expect(f.block).toContain("火災保険: 御見積書に含まれている（火災保険 18,000円）。「別途」と書かない");
  expect(f.block).notToContain("別途 18,000円 必要"); // 御見積書に行があればスタッフ入力より御見積書が正
  expect(f.block).toContain("すべて初期費用の合計に含まれている");
});

it("本文の金額の照合: 見積書に無い金額（計算した・作った・手本から写した）は〇〇円に伏せ字", () => {
  const b = parseCostBreakdownJson(visionJson)!;
  const { allowedAmounts } = formatCostBreakdownFacts([b]);
  const draft = "家賃・管理費のみではご入居出来かねまして、御見積書の初期費用154,500円が必要となります！！\n礼金6.2万円・保証料33,500円が含まれ、敷金は0円となります！！\n火災保険は別途18,000円、日割家賃は9,000円程となります！！";
  const r = checkAmountsAgainstBreakdown(draft, allowedAmounts);
  expect(r.cleaned).toContain("154,500円");
  expect(r.cleaned).toContain("6.2万円");
  expect(r.cleaned).toContain("0円");
  expect(r.cleaned).notToContain("18,000円");
  expect(r.cleaned).notToContain("9,000円");
  expect(r.unmatched.length).toBe(2);
});

it("本文のゲート: ブレインが初期費用についての時、ゆうこの下書きの費用の中身の文を受付の一文に置き換える（金額が無くても）", () => {
  const draft = "かしこまりました！！\n初期費用は家賃・管理費に加え敷金礼金等含む総額となり、家賃・管理費のみでのご入居は出来かねます💦\n御堂筋線沿線も含めてゆうこさんにオススメできるお部屋新たにピックアップしてお送りさせて頂きます😌！！";
  const on = enforceAixGates(draft, { costBreakdownAix: true });
  expect(on.cleaned).notToContain("敷金礼金");
  expect(on.cleaned).toContain("ご質問ありがとうございます😊！！");
  expect(on.cleaned).toContain("ピックアップしてお送りさせて頂きます");
  const off = enforceAixGates(draft, {});
  expect(off.cleaned).toContain("敷金礼金");
  expect(isCostBreakdownExplanation("御堂筋線沿線も含めてオススメできるお部屋ピックアップさせて頂きます！！")).toBe(false);
});

it("yenOf: 表記ゆれ", () => {
  expect(yenOf("67,000円")).toBe(67000);
  expect(yenOf("６．７万")).toBe(67000);
  expect(yenOf("0円")).toBe(0);
  expect(yenOf("不明")).toBe(null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
