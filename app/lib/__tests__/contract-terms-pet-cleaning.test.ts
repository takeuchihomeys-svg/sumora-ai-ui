// 契約条件の網のペット・清掃費（app/lib/contract-terms-question.ts・CONTRACT_TERMS_PET_CLEANING=on）のテスト（自己完結ハーネス）
//
// 2026-11-11 作業員1（弱い所 564）: お客様の文は実物（line_watch_turns 10597 ほか）。資料の行・文字層は売上サポ（property_pickups）の実物の形
//   （物件名・号室は資料のまま。個人の値は無い）。
// 実行: npx tsx app/lib/__tests__/contract-terms-pet-cleaning.test.ts
import { detectContractTermTopics, routeContractTerm, buildContractTermsNote, contractTermsAllInMaterial, contractTermsPetCleaningOn, petAskOf, petEvidenceOf, cleaningFeeEvidenceOf, isTermsInquiryOnSentProperty } from "../contract-terms-question";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };
const ok = (v: unknown, msg = "expected truthy") => { if (!v) throw new Error(msg); };
const withEnv = (v: string | undefined, fn: () => void) => {
  const prev = process.env.CONTRACT_TERMS_PET_CLEANING;
  if (v === undefined) delete process.env.CONTRACT_TERMS_PET_CLEANING; else process.env.CONTRACT_TERMS_PET_CLEANING = v;
  try { fn(); } finally { if (prev === undefined) delete process.env.CONTRACT_TERMS_PET_CLEANING; else process.env.CONTRACT_TERMS_PET_CLEANING = prev; }
};

// 実物の資料（グラン寝屋川 101・リアプロの文字層の特記事項）
const GRAN_PDF = [
  "物件名 グラン寝屋川", "号室名 101（1階部分）", "敷金 0円", "礼金 0円",
  "条 件", "【条件】 保証会社利用必須", "取引態様：媒介", "特記事項：",
  "1年以内の解約は賃料総額の2ヵ月分、2年以内の解約は賃料総額の1ヶ月分が短期解約違約金として必要となります。退去時ハウスクリーニング代として40,000円(",
  "税別)、エアコンクリーニング代として20,000円(税別)必要となります。",
  "・保証会社：保証会社利用必須 日本賃貸住宅保証機構株式会社 収納代行 保証人有 賃料総額30%最低保証料25000円・鍵交換代：33,000円（契約時）シリンダー2個・室内消毒代：22,000円（契約時）",
].join("\n");

describe("既定 off（入れる CONTRACT_TERMS_PET_CLEANING=on）", () => {
  it("off の時は拾わない（10597 の実物）", () => withEnv(undefined, () => {
    eq(contractTermsPetCleaningOn(), false);
    eq(detectContractTermTopics("ありがとうございます！室内清掃費ってつけないんですかね？"), []);
    eq(detectContractTermTopics("ここは犬のみですか？"), []);
  }));
  it("on の時は拾う", () => withEnv("on", () => {
    eq(detectContractTermTopics("ありがとうございます！室内清掃費ってつけないんですかね？"), ["cleaning_fee"]);
    eq(detectContractTermTopics("ここは犬のみですか？"), ["pet"]);
  }));
});

describe("検出（on）", () => withEnv("on", () => {
  it("猫・ペットの可否の問い", () => {
    eq(detectContractTermTopics("猫飼えますか？"), ["pet"]);
    eq(detectContractTermTopics("こちらペット可でしょうか"), ["pet"]);
    eq(detectContractTermTopics("小型犬1匹いるのですが大丈夫ですか？"), ["pet"]);
  });
  it("探す条件・交渉は拾わない", () => {
    eq(detectContractTermTopics("ペット可の物件ありますか？"), []);
    eq(detectContractTermTopics("ペット可で探してもらえますか？"), []);
    eq(detectContractTermTopics("クリーニング代安くなりませんか？"), []);
  });
  it("見積書の中身の問い（クリーニング代が見積に入っているか）は清掃費の網に入れない（AIX【初期費用について】の側）", () => {
    eq(detectContractTermTopics("クリーニング代は見積もりに入ってますか？"), []);
    eq(detectContractTermTopics("初期費用にクリーニング費用は含まれていますか？"), []);
  });
  it("退去時の費用の問い", () => {
    eq(detectContractTermTopics("退去時の費用ってかかりますか？"), ["cleaning_fee"]);
    eq(detectContractTermTopics("クリーニング費用はいくらですか？"), ["cleaning_fee"]);
  });
  it("物件を指した問いは送った物件の契約条件の問い", () => {
    ok(isTermsInquiryOnSentProperty("ここは犬のみですか？"));
  });
}));

describe("清掃費の資料の読み（実物の形）", () => {
  it("グラン寝屋川の特記事項（改行で切れた金額をつないで・退去時）", () => {
    const ev = cleaningFeeEvidenceOf({ pdfText: GRAN_PDF });
    eq(ev, [
      { text: "退去時ハウスクリーニング代として40,000円(税別)", timing: "退去時" },
      // 「、」でつながる2つ目は前の項目の時期（竹内さんの実送信も両方「退去時に」）
      { text: "エアコンクリーニング代として20,000円(税別)必要となります", timing: "退去時" },
    ]);
    const r = routeContractTerm("cleaning_fee", { pdfText: GRAN_PDF });
    eq(r.route, "material"); eq(r.why, "資料に退去時の清掃費の記載");
  });
  it("「室内消毒代：22,000円（契約時）」は清掃費にしない", () => {
    ok(!cleaningFeeEvidenceOf({ pdfText: GRAN_PDF }).some((e) => /消毒/.test(e.text)));
  });
  it("「室内清掃費用：33,000円（契約時）」は契約時（入居時に払う物）", () => {
    const r = routeContractTerm("cleaning_fee", { pdfText: "・保険：保険要加入 2年契約 20,000円・カギ交換費用：16,500円（契約時）・室内清掃費用：33,000円（契約時）" });
    eq(r.route, "material"); eq(r.facts, ["室内清掃費用：33,000円（契約時）"]); eq(r.why, "資料に契約時（入居時）の清掃費の記載");
  });
  it("「クリーニング費用：80,000円」（時期の記載なし）は時期を足さない印", () => {
    const r = routeContractTerm("cleaning_fee", { pdfText: "募集戸数：2戸・クリーニング費用：80,000円" });
    eq(r.route, "material"); eq(r.facts, ["クリーニング費用：80,000円"]); ok(/時期の記載が無い/.test(r.why), r.why);
  });
  it("ハウスクリーニングとエアコン洗浄が並ぶ（項目名の前の「・」で切る）", () => {
    const ev = cleaningFeeEvidenceOf({ pdfText: "20,000円・カギ交換代：30,800円（契約時）・ハウスクリーニング：46,200円（退去時）・エアコン洗浄：16,500円（退去時）・コールセンター（スマートサポート）" });
    eq(ev.map((e) => e.text), ["ハウスクリーニング：46,200円（退去時）", "エアコン洗浄：16,500円（退去時）"]);
  });
  it("間取りごとの金額（「・1LDK:33,000円」では切らない）", () => {
    const ev = cleaningFeeEvidenceOf({ pdfText: "Kは可 ●ハウスクリーニング代:1K:27,500円(税込)・1LDK:33,000円(税込) ※退去時 ●鍵交換代:27,500円" });
    eq(ev, [{ text: "ハウスクリーニング代:1K:27,500円(税込)・1LDK:33,000円(税込) / 退去時", timing: "退去時" }]);
  });
  it("同じ資料の2ページ（弊社の帯・元付）の重なりは1つ", () => {
    eq(cleaningFeeEvidenceOf({ pdfText: `${GRAN_PDF}\n${GRAN_PDF}` }).length, 2);
  });
  // 2026-11-11 監査（売上サポ 40行）で見つけた取り違え: 隣の項目の時期を清掃費の時期と読んでいた
  it("隣の項目の「（契約時）」を清掃費の時期にしない（アプリーレの形）", () => {
    const ev = cleaningFeeEvidenceOf({ pdfText: "・カギ交換費用：16,500円（契約時）案内方法備考 : 全部屋対象の告知事項有/解約予告1ヶ月前(日割有)/短期解約違約金無しハウスクリーニング代 20平米超 1平米毎1,100円加算" });
    eq(ev, [{ text: "ハウスクリーニング代 20平米超 1平米毎1,100円加算", timing: null }]);
  });
  it("「■退去時精算手数料」は清掃費の時期にしない（プレサンスの形）", () => {
    const ev = cleaningFeeEvidenceOf({ pdfText: "■鍵交換代33,000円■室内清掃費55,000円■事務手数料22,000円■退去時精算手数料5,500円(最終請求時)" });
    eq(ev, [{ text: "室内清掃費55,000円", timing: null }]);
  });
  it("同じ区切りにつながった AD（広告料）は材料に出さない（フォルム城東中央の形）", () => {
    const ev = cleaningFeeEvidenceOf({ pdfText: "清掃費：52,800円（税込）A D 100％" });
    eq(ev, [{ text: "清掃費：52,800円（税込）", timing: null }]);
    ok(!/A\s?D|広告料/.test(buildContractTermsNote({ name: "X", roomNo: "1" }, [routeContractTerm("cleaning_fee", { pdfText: "エアコンクリーニング代(1台当り) 13,200円(退去時)A D 2ヶ月" })])));
  });
  it("時期が「 / 退去時」で次に来る形・「（入居時）」の形・ページの頭の文字を拾わない", () => {
    eq(cleaningFeeEvidenceOf({ pdfText: "500 円 ( 内税 ) / 契約時 , 室内清掃費用： 33,000 円 ( 内税 ) / 退去時 , 契約事務手数料： 3,300 円" }), [{ text: "室内清掃費用： 33,000 円 ( 内税 ) / 退去時", timing: "退去時" }]);
    eq(cleaningFeeEvidenceOf({ pdfText: "（光触媒プラン）36300円(入居時)、クリーニング代58300円(入居時)、鍵代22000円(入居時)" }), [{ text: "クリーニング代58300円(入居時)", timing: "契約時" }]);
    eq(cleaningFeeEvidenceOf({ pdfText: "・室内清掃費用：33,000円（退去時）\n9527751\n出力日:2026/10/28 18:41:46 / 次回更新予定日:2026/11/11 ※掲載情報は随時更新される場合がございます。" }), [{ text: "室内清掃費用：33,000円（退去時）", timing: "退去時" }]);
  });
  it("金額の無い「管理形態 清掃」・記載なしは確認", () => {
    eq(routeContractTerm("cleaning_fee", { pdfText: "宅配ボックス 暗証番号 ・ 管理形態 清掃 ・ エレベータ 各階有" }).route, "confirm");
    eq(routeContractTerm("cleaning_fee", { pdfText: "敷金 0円\n礼金 0円" }).route, "confirm");
  });
});

describe("ペットの資料の読み（実物の形）", () => {
  const SODAN_CAT = ["ペット: 可/小型犬:可/猫:可（ペット相談（小型犬、猫可））", "入居条件: ペット相談（小型犬、猫可）・外国人契約可能・2人入居可能・保証人不要"];
  it("お客様の動物・頭数", () => {
    eq(petAskOf("猫2匹飼えますか？"), { animals: ["cat"], count: 2 });
    eq(petAskOf("ここは犬のみですか？"), { animals: ["dog"], count: null });
    eq(petAskOf("中型犬なんですが"), { animals: ["large_dog"], count: null });
  });
  it("資料の行と入居条件の中のペットの項目（括弧の中の「、」で切らない）", () => {
    eq(petEvidenceOf({ lines: SODAN_CAT }), ["ペット: 可/小型犬:可/猫:可（ペット相談（小型犬、猫可））"]);
    eq(petEvidenceOf({ pdfText: "【条件】 ペット相談（小型犬、猫可）・外国人契約可能・事務所利用可能・" }), ["条件: ペット相談（小型犬、猫可）"]);
  });
  it("猫可の資料に「猫飼えますか」→ 資料で答える", () => {
    const r = routeContractTerm("pet", { lines: SODAN_CAT }, { questionText: "猫飼えますか？" });
    eq(r.route, "material");
  });
  it("「ここは犬のみですか？」（猫の飼い主・犬猫可の資料）→ 資料で答える", () => {
    eq(routeContractTerm("pet", { lines: SODAN_CAT }, { questionText: "ここは犬のみですか？" }).route, "material");
  });
  it("うさぎ・中型犬は資料に無い → 確認", () => {
    eq(routeContractTerm("pet", { lines: SODAN_CAT }, { questionText: "うさぎは飼えますか？" }).route, "confirm");
    eq(routeContractTerm("pet", { lines: SODAN_CAT }, { questionText: "中型犬なんですが大丈夫ですか？" }).route, "confirm");
  });
  it("「ペット: ペット相談」だけで猫2匹 → 確認（猫・頭数が資料に無い＝KB fd38ad9a・1bc5683e）", () => {
    const r = routeContractTerm("pet", { lines: ["ペット: ペット相談"] }, { questionText: "猫2匹飼いたいのですが大丈夫ですか？" });
    eq(r.route, "confirm"); ok(/猫/.test(r.why), r.why);
  });
  it("「ペット: ペット相談」で動物を言っていない問い → 資料で答える（ペット飼育可能）", () => {
    eq(routeContractTerm("pet", { lines: ["ペット: ペット相談"] }, { questionText: "こちらペット可でしょうか" }).route, "material");
  });
  it("1匹までの資料に2匹 → 確認／1匹 → 資料", () => {
    const L = ["ペット: 小型犬or猫1匹まで飼育可(敷金1ヶ月)・ペット相談"];
    const r2 = routeContractTerm("pet", { lines: L }, { questionText: "猫2匹は大丈夫ですか？" });
    eq(r2.route, "confirm"); ok(/1匹まで/.test(r2.why), r2.why);
    eq(routeContractTerm("pet", { lines: L }, { questionText: "猫飼えますか？" }).route, "material");
  });
  it("不可の形（「ペット: 不可」「新規入居者よりペット飼育不可」「ペット飼育・一時預かり不可」）→ 資料で答える", () => {
    for (const l of ["ペット: 不可", "ペット: 新規入居者よりペット飼育不可", "ペット: ペット飼育・一時預かり不可"]) {
      const r = routeContractTerm("pet", { lines: [l] }, { questionText: "ペット飼えますか？" });
      eq(r.route, "material"); eq(r.why, "資料にペット不可の記載");
    }
  });
  it("「小型犬1匹又は猫1匹飼育可」に猫 → 資料で答える（監査の実物）", () => {
    eq(routeContractTerm("pet", { lines: ["ペット: ペット相談・敷金1ヶ月で小型犬1匹又は猫1匹飼育可"] }, { questionText: "猫飼えますか？" }).route, "material");
  });
  it("「ペット相談（小型犬のみ）」に猫 → 確認（不可と読まない・言い切らない）", () => {
    eq(routeContractTerm("pet", { lines: ["ペット: ペット相談（小型犬のみ）"] }, { questionText: "猫飼えますか？" }).route, "confirm");
  });
  it("記載なし → 確認", () => {
    eq(routeContractTerm("pet", { lines: ["駐車場: 空きなし"], pdfText: "【条件】 保証会社利用必須" }, { questionText: "ペット飼えますか？" }).route, "confirm");
  });
});

describe("材料の文", () => {
  it("清掃費・ペットの項目名と答え方が出る", () => {
    const routes = [routeContractTerm("cleaning_fee", { pdfText: GRAN_PDF }), routeContractTerm("pet", { lines: ["ペット: 不可"] }, { questionText: "ペット飼えますか？" })];
    ok(contractTermsAllInMaterial(routes));
    const note = buildContractTermsNote({ name: "グラン寝屋川", roomNo: "101" }, routes);
    ok(/清掃費（クリーニング費用）: 資料に記載あり/.test(note), note);
    ok(/退去時ハウスクリーニング代として40,000円/.test(note), note);
    ok(/ペット: 資料に記載あり/.test(note) && /ペット飼育不可のお部屋/.test(note), note);
  });
  it("確認の時は AIX【確認した】", () => {
    const note = buildContractTermsNote({ name: "X", roomNo: "201" }, [routeContractTerm("pet", { lines: ["ペット: ペット相談"] }, { questionText: "猫2匹は？" })]);
    ok(/ペット: 資料では答えられない/.test(note) && /AIX【確認した/.test(note), note);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
