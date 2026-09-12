// 2026-09-12 竹内方針（あや事例）: AIX【初期費用を説明】— 説明と仕組みを1通で・金額は入力値だけ
// 実行: npx tsx app/lib/__tests__/cost-explain-text.test.ts（自己完結ハーネス。全 PASS で exit 0）
import {
  buildCostExplainMessage, costExplainMissing, customerDoubtsCheapness, extractEstimateAmounts, mentionsBrokerFee, parseYen,
} from "../cost-explain-text";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(s: string) { if (typeof actual !== "string" || !actual.includes(s)) throw new Error(`expected to contain ${JSON.stringify(s)} but got ${JSON.stringify(actual)}`); },
    notToContain(s: string) { if (typeof actual === "string" && actual.includes(s)) throw new Error(`expected not to contain ${JSON.stringify(s)} but got ${JSON.stringify(actual)}`); },
  };
}

const AYA = "ありがとうございます🙇🏻‍♀️՞\n仲介手数料無しで大丈夫でしょうか？\n他の不動産屋さんに問い合わせると\n初期費用31万プラス日割り家賃と\n伺っているので、、、💦\n安いのには何か理由があるのでしょうか？\n申し訳ございません。\n少し不安になったのでご質問しました🙇‍♀️";

// ── 文面 ──
it("あや: スタッフが2通で送った説明と仕組みを1通で作る（金額は入力値）", () => {
  const t = buildCostExplainMessage({
    customerName: "あや", askedBrokerFee: mentionsBrokerFee(AYA), noLandlordFee: false,
    landlordFeeYen: 67000, landlordFeeLabel: "家賃1ヶ月分", refundYen: 22000, savingYen: null,
  });
  expect(t).toBe(
    "仲介手数料は0円で大丈夫です！！オーナー様からの広告料をお客様に還元させて頂いている仕組みのため、初期費用を一般的な不動産業者様よりお安くご提案出来ております！！\n\n" +
    "他社様との金額差はこの還元の有無によるものですので、ご安心ください😊！！\n\n" +
    "こちらの物件は貸主から家賃1ヶ月分の手数料を弊社不動産仲介会社は頂く事が出来ます！！\n" +
    "67,000円を貸主から頂き、そこから22,000円をあやさんの初期費用に還元させて頂きますので、弊社としましても利益残りますのでご安心頂けますと幸いです！！",
  );
});
it("仲介手数料に触れていない質問（𝓡「なぜ安くできるのですか」）はご質問のお礼から", () => {
  const t = buildCostExplainMessage({
    customerName: "R", askedBrokerFee: false, noLandlordFee: false,
    landlordFeeYen: 44000, landlordFeeLabel: "家賃半月分", refundYen: 20000, savingYen: null,
  });
  expect(t).toContain("ご質問ありがとうございます😊！！\n弊社は仲介手数料0円となります！！オーナー様からの広告料");
  expect(t).toContain("貸主から家賃半月分の手数料を");
  expect(t).notToContain("大丈夫です");
});
it("報酬の言い方が無ければ「手数料」だけ", () => {
  const t = buildCostExplainMessage({ customerName: "あ", askedBrokerFee: true, noLandlordFee: false, landlordFeeYen: 50000, landlordFeeLabel: null, refundYen: 10000, savingYen: null });
  expect(t).toContain("こちらの物件は貸主から手数料を弊社不動産仲介会社は");
});
it("貸主から手数料が無いお部屋: 割引出来ないが一般的な不動産業者より〇〇円お得（ﾓﾓｶ 実例）", () => {
  const t = buildCostExplainMessage({ customerName: "モモカ", askedBrokerFee: false, noLandlordFee: true, landlordFeeYen: null, landlordFeeLabel: null, refundYen: null, savingYen: 29150 });
  expect(t).toContain("こちらの物件は貸主から手数料がないお部屋となりますので、割引出来ない形となりますが、一般的な不動産業者より29,150円お得となります！！");
  expect(t).notToContain("還元させて頂きますので");
});
it("入力不足: 報酬なし・還元額なし・還元額が報酬を超える", () => {
  expect(costExplainMissing({ noLandlordFee: false, landlordFeeYen: null, refundYen: 22000 })).toBe("貸主からの報酬を入力してください");
  expect(costExplainMissing({ noLandlordFee: false, landlordFeeYen: 67000, refundYen: null })).toBe("初期費用への還元額を入力してください");
  expect(costExplainMissing({ noLandlordFee: false, landlordFeeYen: 20000, refundYen: 22000 })).toBe("還元額が貸主からの報酬を超えています");
  expect(costExplainMissing({ noLandlordFee: false, landlordFeeYen: 67000, refundYen: 22000 })).toBe(null);
  expect(costExplainMissing({ noLandlordFee: true, landlordFeeYen: null, refundYen: null })).toBe(null);
});

// ── 金額の読み取り ──
it("金額入力: 67,000 / 67000円 / 6.7万 / 全角", () => {
  expect(parseYen("67,000")).toBe(67000);
  expect(parseYen("67000円")).toBe(67000);
  expect(parseYen("6.7万")).toBe(67000);
  expect(parseYen("６７０００")).toBe(67000);
  expect(parseYen("")).toBe(null);
  expect(parseYen("abc")).toBe(null);
});
it("直近の見積書送る（AIX）から還元額・節約額の初期値を拾う", () => {
  const est = "【LIVIAZ NAMBA KRASS 1201号室】\n\n初期費用さらに\n🌟24,000円割引させて頂き\n初期費用：199,500円\n\nギガ賃貸なら一般的な不動産業者より97,700円節約出来ます！！";
  const r = extractEstimateAmounts(["こんにちは", est, "お手隙の際にご査収ください😌！！"]);
  expect(r.refundYen).toBe(24000);
  expect(r.savingYen).toBe(97700);
  expect(extractEstimateAmounts(["こんにちは"]).refundYen).toBe(null);
});

// ── ブレイン用の判定（200日の実データ: 正解3件・誤り0件に合わせた） ──
it("安さへの不安: あや", () => expect(customerDoubtsCheapness(AYA)).toBe(true));
it("安さへの疑問: 𝓡「初期費用ここまでなぜ安くできるのですか？」", () => expect(customerDoubtsCheapness("質問なのですが、\n初期費用ここまでなぜ安くできるのですか？")).toBe(true));
it("安さへの不安: みこと「他社だと38万円だったのですが本当に22万円より高くなることはないですか？」", () => {
  expect(customerDoubtsCheapness("他社だと38万円だったのですが本当に22万円より高くなることはないですか？")).toBe(true);
});
it("交渉の相談は外す: mai.t「仲介手数料無料や礼金の交渉はむずかしい物件なのか」", () => {
  expect(customerDoubtsCheapness("こちらの物件は仲介手数料無料や礼金の交渉はむずかしい物件なのかお聞きしたいです。")).toBe(false);
});
it("請求への指摘は外す: a🤫「仲介手数料なしってこの前言われたんですけど」", () => expect(customerDoubtsCheapness("仲介手数料なしってこの前言われたんですけど")).toBe(false));
it("画像の読み取り文字は外す（他社見積書の「仲介手数料 0円」）", () => expect(customerDoubtsCheapness("[画像] ご請求金額 250,000円\n仲介手数料 0円\n計 268,846円")).toBe(false));
it("値引きの相談は外す: さくら「他社で21万ぐらいの初期費用やったんですけど、安くできますか？」", () => {
  expect(customerDoubtsCheapness("この物件他社で21万ぐらいの初期費用やったんですけど、安くできますか？")).toBe(false);
});
it("値引きの相談は外す: 「もう少し金額安くなりませんか？」", () => expect(customerDoubtsCheapness("ここの物件前向きに検討中なんですが、もう少し金額安くなりませんか？")).toBe(false));
it("金額の質問（見積書送る）は外す: 「初期費用がどれくらいになるか教えていただきたい」", () => {
  expect(customerDoubtsCheapness("初期費用がどれくらいになるか教えていただきたいのですが、可能でしょうか？")).toBe(false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
