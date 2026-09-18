// 2026-09-12 竹内方針（あや事例）: AIX【初期費用を説明】— 説明と仕組みを1通で・金額は入力値だけ
// 実行: npx tsx app/lib/__tests__/cost-explain-text.test.ts（自己完結ハーネス。全 PASS で exit 0）
import {
  buildCostExplainMessage, buildCostMechanismMessage, costExplainMissing, customerDoubtsCheapness, extractEstimateAmounts, mentionsBrokerFee, parseYen,
  checkCostFacts, fixBrokerFeeWording, buildCostExplainFactsNote,
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

// ── 仕組みを説明（2026-09-19 竹内「報酬額いれなくても説明されるようにする」）──
// 文はスタッフ実送信と公式LINEの挨拶メッセージの言い回しだけを使う（新しい言い方を作らない）
it("★ スモラ: 金額の入力なしで作れる（公式LINEの挨拶と同じ「前家賃＋2,980円」）", () => {
  const m = buildCostMechanismMessage({ customerName: "ゆうこ", account: "sumora", askedBrokerFee: false });
  expect(m).toContain("スモ割が最大適用出来るお部屋でしたら、初期費用は【前家賃＋2,980円】のみでご入居頂けます！！");
  expect(m).toContain("仲介手数料の2,980円は一律で発生し、お部屋によって割引出来る金額が変わります");
  expect(m).toContain("オーナー様からの広告料をお客様に還元させて頂いている仕組みのため");
  expect(m).toContain("ゆうこさんが気になっているお部屋のスクショをお送り頂くだけで");
});
it("★ スモラでは「仲介手数料0円」と書かない（実態は2,980円が一律）", () => {
  const m = buildCostMechanismMessage({ customerName: "ゆうこ", account: "sumora", askedBrokerFee: true });
  expect(m).notToContain("仲介手数料は0円");
  expect(m).notToContain("仲介手数料0円");
});
it("★ イエヤス: 仲介手数料0円＋イエヤス割（実送信の言い方）", () => {
  const m = buildCostMechanismMessage({ customerName: "けんじ", account: "ieyasu", askedBrokerFee: false });
  expect(m).toContain("ほとんどのお部屋を仲介手数料0円でご紹介可能となります！！");
  expect(m).toContain("イエヤス割");
  expect(m).toContain("中には仲介手数料を頂くお部屋もございます");
  expect(m).notToContain("2,980円");   // スモラの数字を混ぜない
  expect(m).notToContain("スモ割");
});
it("ギガ: ギガ割になる", () => {
  const m = buildCostMechanismMessage({ customerName: "けんじ", account: "giga", askedBrokerFee: false });
  expect(m).toContain("ギガ割");
  expect(m).notToContain("イエヤス割");
});
it("アカウント未指定はスモラ扱い（件数最多・挨拶メッセージの型）", () => {
  expect(buildCostMechanismMessage({ customerName: "A", account: null, askedBrokerFee: false })).toContain("スモ割");
});
it("物件ごとの金額は1つも書かない（入力が要らない＝創作もしない）", () => {
  const m = buildCostMechanismMessage({ customerName: "A", account: "sumora", askedBrokerFee: false });
  const amounts = m.match(/[\d,]+円/g) ?? [];
  expect(amounts.every((a) => a === "2,980円")).toBe(true);
});
it("名前が空でも壊れない", () => {
  expect(buildCostMechanismMessage({ customerName: "", account: "ieyasu", askedBrokerFee: false })).toContain("お客様が気になっているお部屋");
});
it("締めは既存と同じ（他社との差は還元の有無）", () => {
  expect(buildCostMechanismMessage({ customerName: "A", account: "sumora", askedBrokerFee: false }))
    .toContain("他社様との金額差はこの還元の有無によるものですので、ご安心ください😊！！");
});

// ── スモラの仲介手数料は 2,980円（2026-09-19 竹内「スモラだけ2,980円と変えておく」）──
// 根拠: DB ルール ai_prompt_rules 4f2474ee「仲介手数料は一律2,980円（固定）であり割引するものではない」
//   スモラ実送信「仲介手数料2,980円のみでご案内させていただきます」（7/12・7/15・7/21）
//   「仲介手数料の2,980円は一律で発生し」（8/11）。0円は代表の特別許可という例外（8/19・8/28）
it("★ スモラ: 仲介手数料に触れられた時「一律2,980円のみ」と答える（0円と書かない）", () => {
  const m = buildCostExplainMessage({
    customerName: "あや", account: "sumora", askedBrokerFee: true,
    noLandlordFee: false, landlordFeeYen: 67000, landlordFeeLabel: "家賃1ヶ月分", refundYen: 22000, savingYen: null,
  });
  expect(m).toContain("仲介手数料は一律2,980円のみとなります！！");
  expect(m).notToContain("仲介手数料は0円");
  expect(m).toContain("67,000円を貸主から頂き、そこから22,000円をあやさんの初期費用に還元");
});
it("★ スモラ: 仲介手数料に触れられていない時も0円と書かない", () => {
  const m = buildCostExplainMessage({
    customerName: "あや", account: "sumora", askedBrokerFee: false,
    noLandlordFee: false, landlordFeeYen: 67000, landlordFeeLabel: null, refundYen: 22000, savingYen: null,
  });
  expect(m).toContain("弊社は仲介手数料2,980円のみでご案内させて頂いております！！");
  expect(m).notToContain("仲介手数料0円");
});
it("★ イエヤス・ギガは今までどおり0円", () => {
  for (const acct of ["ieyasu", "giga"]) {
    const m = buildCostExplainMessage({
      customerName: "あや", account: acct, askedBrokerFee: true,
      noLandlordFee: false, landlordFeeYen: 67000, landlordFeeLabel: null, refundYen: 22000, savingYen: null,
    });
    expect(m).toContain("仲介手数料は0円で大丈夫です！！");
    expect(m).notToContain("2,980円");
  }
});
it("アカウント未指定は従来どおり（既存の呼び出しの挙動を変えない）", () => {
  const m = buildCostExplainMessage({
    customerName: "あや", askedBrokerFee: true,
    noLandlordFee: false, landlordFeeYen: 67000, landlordFeeLabel: null, refundYen: 22000, savingYen: null,
  });
  expect(m).toContain("仲介手数料は0円で大丈夫です！！");
});
it("貸主から手数料なしのお部屋でも冒頭はアカウントで変わる", () => {
  const m = buildCostExplainMessage({
    customerName: "ﾓﾓｶ", account: "sumora", askedBrokerFee: false,
    noLandlordFee: true, landlordFeeYen: null, landlordFeeLabel: null, refundYen: null, savingYen: 29150,
  });
  expect(m).toContain("弊社は仲介手数料2,980円のみで");
  expect(m).toContain("一般的な不動産業者より29,150円お得となります！！");
});
it("冒頭の言い方は1か所（brokerFeeOpening）— 仕組み説明と食い違わない", () => {
  const explain = buildCostExplainMessage({
    customerName: "A", account: "sumora", askedBrokerFee: false,
    noLandlordFee: false, landlordFeeYen: 67000, landlordFeeLabel: null, refundYen: 22000, savingYen: null,
  });
  const mech = buildCostMechanismMessage({ customerName: "A", account: "sumora", askedBrokerFee: false });
  // どちらもスモラでは「0円」と言わない
  expect(explain).notToContain("仲介手数料0円");
  expect(mech).notToContain("仲介手数料0円");
});

// ── 会話を合わせるの出口（2026-09-19 竹内「会話を合わせるボタンをつける」）──
it("★ 入力に無い金額は〇〇円に伏せる（送信前チェックで止まる）", () => {
  const draft = "オーナー様からの広告料を還元しております！！\n67,000円を貸主から頂き、そこから22,000円を還元させて頂きます！！\n初期費用は総額198,000円となります！！";
  const r = checkCostFacts(draft, [67000, 22000]);
  expect(r.cleaned).toContain("67,000円を貸主から頂き");
  expect(r.cleaned).toContain("22,000円を還元");
  expect(r.cleaned).toContain("初期費用は総額〇〇円となります");  // 入力に無い総額は伏せる
  expect(String(r.unmatched)).toBe("198000");
});
it("スモラの仲介手数料2,980円は常に許す（会社の仕組みの数字）", () => {
  const r = checkCostFacts("スモラでは仲介手数料を2,980円に抑えております！！", []);
  expect(r.cleaned).toContain("2,980円");
  expect(String(r.unmatched.length)).toBe("0");
});
it("万円の書き方も拾う", () => {
  const r = checkCostFacts("他社様では31万円とのことですが", [67000]);
  expect(r.cleaned).toContain("〇〇円");
  expect(String(r.unmatched)).toBe("310000");
});
it("金額が無い文は触らない", () => {
  const t = "オーナー様からの広告料をお客様に還元させて頂いている仕組みのため、お安くご提案出来ております！！";
  expect(checkCostFacts(t, []).cleaned).toBe(t);
});
it("★ スモラで「仲介手数料0円」と書いたら2,980円に直す（出口の決定論）", () => {
  const r = fixBrokerFeeWording("仲介手数料は0円で大丈夫です！！ご安心ください😊！！", "sumora");
  expect(r.text).toContain("仲介手数料は一律2,980円");
  expect(r.text).notToContain("仲介手数料は0円");   // ※「2,980円」の中に "0円" が含まれるので、語ごと確かめる
  expect(String(r.fixed)).toBe("1");
});
it("「仲介手数料無料」も直す", () => {
  expect(fixBrokerFeeWording("こちらのお部屋は仲介手数料無料でご案内可能です！！", "sumora").text).toContain("仲介手数料2,980円");
});
it("イエヤス・ギガは直さない（0円が正しい）", () => {
  const t = "仲介手数料は0円で大丈夫です！！";
  expect(fixBrokerFeeWording(t, "ieyasu").text).toBe(t);
  expect(fixBrokerFeeWording(t, "giga").text).toBe(t);
});
it("★ 材料には入力した金額と、アカウントの仕組みだけが入る", () => {
  const note = buildCostExplainFactsNote({ account: "sumora", mode: "fee", landlordFeeYen: 67000, landlordFeeLabel: "家賃1ヶ月分", refundYen: 22000 });
  expect(note).toContain("スモラは**一律2,980円**");
  expect(note).toContain("家賃1ヶ月分の手数料 67,000円");
  expect(note).toContain("22,000円 をお客様の初期費用に還元");
  expect(note).toContain("他の金額は書かない");
});
it("材料: 手数料なしのお部屋", () => {
  const note = buildCostExplainFactsNote({ account: "ieyasu", mode: "no_fee", savingYen: 29150 });
  expect(note).toContain("貸主から手数料がない");
  expect(note).toContain("29,150円 お得");
  expect(note).toContain("イエヤス割");
});
it("材料: 仕組みだけの時は金額を書かないと明記する", () => {
  expect(buildCostExplainFactsNote({ account: "sumora", mode: "mechanism" })).toContain("物件ごとの金額は書かない");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
