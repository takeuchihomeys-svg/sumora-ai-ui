// 契約条件の質問（app/lib/contract-terms-question.ts）と資料のとおりの言い切りの免除（validate-reply.materialGroundsAssertion）のテスト（自己完結ハーネス）
//
// 2026-10-08 竹内（8巡目）「資料に書いてある事は返信の本文で答えて良い」
// 文はすべて実物（scripts/audit-r8-contract-terms.ts --days=180）。会話は id の先頭8文字。資料の行・文字層も実物（property_pickups）。
// 実行: npx tsx app/lib/__tests__/contract-terms-question.test.ts
import { detectContractTermTopics, routeContractTerm, buildContractTermsNote, contractTermsAllInMaterial, motodukeOfPdf } from "../contract-terms-question";
import { materialGroundsAssertion, materialDateTokens } from "../validate-reply";
import { vacancyDateFromMaterial, vacatingViewingAnswer } from "../viewing-check-first";
import { freeRentFactsFromStaffText, collectStaffFreeRent, staffFreeRentFor, ungroundedFreeRentSentence } from "../staff-free-rent";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };
const ok = (v: unknown, msg = "expected truthy") => { if (!v) throw new Error(msg); };

describe("検出（この物件の値を聞いている・実物）", () => {
  const hits: Array<[string, string, string[]]> = [
    ["8b260f7e 07-16", "こっちで前向きに考えたいかもです！\nこの物件は駐車場あります？", ["parking"]],
    ["0d114ee3 07-10", "ウェルフォートはバイク置き場とか自転車置き場はありますか？", ["parking"]],
    ["921772f5 08-02", "ありがとうございます！\n素敵ですね🥺⭐️\nこちらの新築物件は駐車場は別途費用かかりますでしょうか？", ["parking"]],
    ["62d01e33 09-11", "なるほどです🤔\n\nちなみにこの物件の管理会社ってどちらですか？？", ["management_company"]],
    ["aee2078e 06-29", "ありがとうございます！\n保証会社はどこになるでしょうか？", ["guarantor_company"]],
    ["f568a14b 08-23", "これは保証会社どこになりますか？", ["guarantor_company"]],
    ["0be2022b 07-17", "これ全部保証人なしで行ける感じですか？！", ["guarantor_person"]],
    ["4bd00c61 06-08", "かしこまりました\n\n3件とも、保証人不要でしょうか？", ["guarantor_person"]],
    ["0133b787 06-07", "レジュールアッシュ難波MINAMIはいつ退去予定ですか？", ["move_in"]],
    ["6fc6828c 06-12", "ありがとうございます\nフジパレス加賀屋1番館はいつ退去されますか？", ["move_in"]],
    ["331b0338 09-10", "ロイヤル大淀はいつから入居可能ですか？", ["move_in"]],
    ["8590144d 09-23", "こちらもフリーレントでしょうか？", ["free_rent"]],
  ];
  for (const [name, text, topics] of hits) it(name, () => eq(detectContractTermTopics(text), topics));
});

describe("検出しない（交渉・条件・一般の意味・近くの駐車場・URL・フォーム）", () => {
  const misses: Array<[string, string]> = [
    ["2ae0d94e 交渉", "ちなみに、礼金はどうにもならないですよね…？🥲"],
    ["ad97cd40 交渉", "こちら、礼金下げることは厳しいですか🥲"],
    ["ba1527de 交渉", "フリーレントつけれないですか？"],
    ["ed7695c5 条件", "敷金礼金なしの物件は大国町、なんば、桜川駅付近には少ないですか？😢"],
    ["4bd00c61 条件", "いつも通り\n\n、敷金・礼金なし\n、洗濯機置き場あり\n、保証人不要物件\n\nで何かありますか？？"],
    ["3722d12d 意味", "保証会社というのは入居サポートセンターのことですか？"],
    ["d3245ba7 近く", "近隣に駐車場ってありますか？"],
    ["f568a14b 探す", "駐車場付きのマンションありますか？"],
    ["8b260f7e 条件の一覧", "10月\n6万\n1K\n東大阪市、近鉄八尾や久宝寺付近\n30分以内\n駐車場あり、バストイレ別、洗面台独立\nこれでお願いします。"],
    ["URL", "ビビアンパレス桜川公園 7階\nhttps://suumo.jp/chintai/__JJ_FR301FD001_arz1060z2bcz11.html?vos=share01"],
    ["申込フォーム", "【申込者記入欄】\n・入居希望日\n10月1日\n・保証人：なし"],
    ["2ae0d94e 敷金の一般論", "ネットで、敷金ない物件は退去時に高額請求される可能性があるため危険と見たのですが、やはり敷金ない物件は危ないでしょうか…？"],
  ];
  for (const [name, text] of misses) it(name, () => eq(detectContractTermTopics(text), []));
});

// 資料（実物・売上サポの行）
const LECIEL_LINES = ["現況: 空室", "入居可能日: 2026年11月上旬", "駐輪場: 自転車置場", "保証会社: 保証会社利用必須 株式会社シノケンコミュニケーションズ", "連帯保証人: 保証人不要", "入居条件: 外国人契約可能・2人入居可能・保証人不要・保証会社利用可能・保証会社利用必須"];
const LECIEL_TERMS = { deposit: 0, keyMoney: 0, freeRent: null, evidence: { deposit: "敷金なし", keyMoney: "礼金なし", moveIn: "空室/2026年11月上旬" } };
const FLARE_PDF = "大阪府知事免許(1)第64549号 (一社)大阪府宅地建物取引業協会\n蓮産業株式会社 本店\n大阪市中央区瓦町３丁目4-10\n敷金 なし\n礼金 なし\n駐車場\n・保証会社：保証会社利用必須 全保連 初回50% 1,350円/月";
const ESLEAD_PDF = "大阪府知事免許(1)第64549号 (一社)大阪府宅地建物取引業協会\n蓮産業株式会社 本店\nTEL：06-6732-8377\n取引態様：媒介\n国土交通大臣免許(3)第8000号 (公社)全日本不動産協会\nエスリード賃貸株式会社\nTEL：06-6345-1842\n取引態様：貸主代理";

describe("資料の道", () => {
  it("礼金・敷金 0 は資料で答える", () => {
    const k = routeContractTerm("key_money", { terms: LECIEL_TERMS, lines: LECIEL_LINES });
    eq([k.route, k.facts], ["material", ["礼金なし"]]);
    eq(routeContractTerm("deposit", { terms: LECIEL_TERMS }).route, "material");
  });
  it("礼金の記載が無ければ確認", () => eq(routeContractTerm("key_money", { lines: ["現況: 空室"] }).route, "confirm"));
  it("保証会社は guarantor-material の1本で会社名", () => {
    const r = routeContractTerm("guarantor_company", { lines: LECIEL_LINES });
    ok(r.route === "material" && /シノケン/.test(r.facts[0]), JSON.stringify(r));
  });
  it("保証会社「利用必須」だけは確認", () => eq(routeContractTerm("guarantor_company", { lines: ["保証会社: 保証会社利用必須"] }).route, "confirm"));
  it("保証人不要は資料で（緊急連絡先）", () => eq(routeContractTerm("guarantor_person", { lines: LECIEL_LINES }).route, "material"));
  it("保証人「原則必須/相談」は確認", () => eq(routeContractTerm("guarantor_person", { lines: ["連帯保証人: 原則連帯保証人必須/相談可能"] }).route, "confirm"));
  it("入居可能日の日付は資料で", () => eq(routeContractTerm("move_in", { lines: LECIEL_LINES }).route, "material"));
  it("退去予定の日付は資料で", () => {
    const r = routeContractTerm("move_in", { lines: ["現況: 退去予定(10/31)", "入居可能日: 相談"] });
    eq([r.route, r.why], ["material", "資料に退去予定日の記載"]);
  });
  it("退去予定で日付なしは確認", () => eq(routeContractTerm("move_in", { lines: ["現況: 退去予定", "入居可能日: 相談"] }).route, "confirm"));
  it("駐車場の行が無ければ確認（無いとは言わない）", () => eq(routeContractTerm("parking", { lines: LECIEL_LINES.filter((l) => !/駐/.test(l)) }).route, "confirm"));
  it("駐車場の行（料金）は資料で", () => eq(routeContractTerm("parking", { lines: ["駐車場: 空有 15,000円/月"] }).route, "material"));
  it("リアプロの「なし 駐車場」", () => { const r = routeContractTerm("parking", { pdfText: "町内会費\nなし 駐車場\n備 考" }); eq([r.route, r.facts], ["material", ["駐車場 なし"]]); });
  it("フリーレントの記載が無ければ確認", () => eq(routeContractTerm("free_rent", { terms: LECIEL_TERMS, lines: LECIEL_LINES }).route, "confirm"));
});

describe("元付（管理会社）", () => {
  it("弊社の帯（蓮産業）は数えない・次の帯の会社", () => eq(motodukeOfPdf(ESLEAD_PDF), "エスリード賃貸株式会社"));
  it("弊社の帯だけなら無し", () => eq(motodukeOfPdf(FLARE_PDF), null));
  it("免許の次が書類の文なら拾わない", () => eq(motodukeOfPdf("国土交通大臣免許(1)第1号 協会\n免許証がある場合は不要)(4)印鑑証明書原本(連帯保証人のみ)"), null));
  it("管理会社は資料で", () => eq(routeContractTerm("management_company", { pdfText: ESLEAD_PDF }).route, "material"));
});

describe("材料の文", () => {
  it("全部資料なら allInMaterial", () => {
    const routes = [routeContractTerm("key_money", { terms: LECIEL_TERMS }), routeContractTerm("guarantor_person", { lines: LECIEL_LINES })];
    ok(contractTermsAllInMaterial(routes));
    const note = buildContractTermsNote({ name: "Le・Ciel 野里", roomNo: "102" }, routes);
    ok(/本文で資料のとおりに答える/.test(note) && /緊急連絡先/.test(note), note);
  });
  it("1つでも確認なら false", () => ok(!contractTermsAllInMaterial([routeContractTerm("key_money", { terms: LECIEL_TERMS }), routeContractTerm("free_rent", {})])));
});

describe("資料のとおりの言い切りの免除（materialGroundsAssertion）", () => {
  const facts = "現況: 退去予定(10/31)\n入居可能日: 2026年11月上旬";
  it("日付の揃え", () => eq(materialDateTokens(facts).sort(), ["10/31", "11月上旬"]));
  it("退去予定日は資料のとおり → 免除", () => ok(materialGroundsAssertion("VACANCY_ASSERTION", "こちらのお部屋は10月31日退去予定のお部屋となります！！", facts)));
  it("入居可能時期は資料のとおり → 免除", () => ok(materialGroundsAssertion("MOVEIN_DATE_ASSERTION", "11月上旬からご入居可能となります！！", facts)));
  it("資料に無い日付（早めた）→ 免除しない", () => ok(!materialGroundsAssertion("MOVEIN_DATE_ASSERTION", "11月1日からご入居可能です！！", facts)));
  it("空室・募集中の言い切りは免除しない（今の募集状況）", () => ok(!materialGroundsAssertion("VACANCY_ASSERTION", "現在空室となっております！！", "現況: 空室")));
  it("資料に退去予定が無いのに退去予定 → 免除しない", () => ok(!materialGroundsAssertion("VACANCY_ASSERTION", "10月31日退去予定のお部屋となります", "入居可能日: 2026年11月上旬")));
  it("即入居は資料に即入居がある時だけ", () => {
    ok(materialGroundsAssertion("MOVEIN_DATE_ASSERTION", "即入居可能なお部屋となります！！", "入居可能日: 即入"));
    ok(!materialGroundsAssertion("MOVEIN_DATE_ASSERTION", "即入居可能なお部屋となります！！", "入居可能日: 相談"));
  });
  it("資料が空なら免除しない", () => ok(!materialGroundsAssertion("MOVEIN_DATE_ASSERTION", "11月上旬からご入居可能です", "")));
  it("審査・告知は対象外", () => ok(!materialGroundsAssertion("SCREENING_ASSURANCE", "審査は問題ございません", facts)));
});

// 8巡目 決定4: 退去予定日が分かる時は「〇月〇日退去予定のため、〇月〇日以降にご内覧可能です！！」（手打ち 180日 A の多数派）
describe("退去予定日から内覧できる日（viewing-check-first）", () => {
  const NOW = Date.parse("2026-10-08T03:00:00Z");
  it("現況: 退去予定(10/31)", () => eq(vacancyDateFromMaterial(["現況: 退去予定(10/31)", "入居可能日: 相談"]), "10月31日"));
  it("退去予定日：2026/07/27", () => eq(vacancyDateFromMaterial(["退去予定日：2026/07/27"]), "7月27日"));
  it("10月末退去予定", () => eq(vacancyDateFromMaterial(["現況: 10月末退去予定"]), "10月末"));
  it("日付なし・旬だけは null（内覧開始日を作らない）", () => { eq(vacancyDateFromMaterial(["現況: 退去予定"]), null); eq(vacancyDateFromMaterial(["現況: 退去予定 / 2026年11月下旬"]), null); });
  it("文は実送信の多数派の形", () => eq(vacatingViewingAnswer("10月31日", NOW)?.sentence, "10月31日退去予定のため、11月1日以降にご内覧可能です！！"));
  it("月末", () => eq(vacatingViewingAnswer("10月末", NOW)?.sentence, "10月末退去予定のため、11月1日以降にご内覧可能です！！"));
  it("もう内覧できる日なら null", () => eq(vacatingViewingAnswer("10月5日", NOW), null));
});

// 10/08 竹内（最優先）「フリーレントはスタッフが入れていた物件だけ」: 実物は scripts/audit-r8-free-rent.ts（180日 staff 62通）
describe("フリーレントはスタッフの送付だけ（staff-free-rent）", () => {
  const AIX_REC = "🌟Luxe難波西2 706号室\n\n1件新着で〇〇さんにかなりオススメ出来るお部屋が募集に出ました！！\n\n（オススメポイント）\n・フリーレント1ヶ月（家賃1ヶ月分免除）\n・敷金礼金なし";
  it("🌟の見出しの物件に yes", () => { const f = freeRentFactsFromStaffText(AIX_REC); eq(f.map((x) => [x.property, x.kind]), [["Luxe難波西2 706号室", "yes"]]); });
  it("建物名に括弧・空白がある見出し（YUMA で物件に結び付かなかった）", () => {
    const f = collectStaffFreeRent([{ text: "🌟Avantio Anhelo(アバンティオアネーロ) 202号室\n\n1件新着で\n・フリーレント1ヶ月（家賃1ヶ月分免除）" }]);
    ok(staffFreeRentFor(f, "Avantio Anhelo(アバンティオアネーロ)", "202")?.kind === "yes");
    eq(staffFreeRentFor(f, "Avantio Anhelo(アバンティオアネーロ)", "305"), null);
  });
  it("相談可は negotiable", () => eq(freeRentFactsFromStaffText("🌟ライズコート永田 502号室\n・フリーレント1ヶ月相談可")[0].kind, "negotiable"));
  it("管理会社の回答で無い → none", () => eq(freeRentFactsFromStaffText("管理会社に確認させていただきましたが、現在フリーレント対応はしていないとのことです！！")[0].kind, "none"));
  it("交渉の結果「どちらも考えていない」→ none", () => eq(freeRentFactsFromStaffText("管理会社に礼金の減額、フリーレント付けれるかの交渉させていただきましたが、どちらも現状考えていないとのご返答でした。")[0].kind, "none"));
  it("「フリーレントあり（8/15まで賃料発生なし）」は yes", () => eq(freeRentFactsFromStaffText("🌟リブリ・Y.Y 響 201号室\n・201・206号室はフリーレントあり（8/15まで賃料発生なし）")[0].kind, "yes"));
  it("探す約束は事実にしない", () => eq(freeRentFactsFromStaffText("さらに家賃を抑えられ、フリーレント付きのお部屋も含めてピックアップしてお送りさせて頂きます😊！！"), []));
  it("物件ごとに引く", () => {
    const facts = collectStaffFreeRent([{ text: AIX_REC, createdAt: "2026-08-10T00:00:00Z" }]);
    ok(staffFreeRentFor(facts, "Luxe難波西2", "706")?.kind === "yes");
    eq(staffFreeRentFor(facts, "エスリード難波レジデンス", "1406"), null);
  });
  it("契約条件の道: スタッフの送付があれば material・無ければ確認（資料の terms.freeRent は読まない）", () => {
    const facts = collectStaffFreeRent([{ text: AIX_REC }]);
    eq(routeContractTerm("free_rent", { staffFreeRent: staffFreeRentFor(facts, "Luxe難波西2", "706") }).route, "material");
    eq(routeContractTerm("free_rent", { terms: { freeRent: { months: 1, label: "フリーレント1ヶ月" } }, lines: ["フリーレント: 1ヶ月"] }).route, "confirm");
  });
  it("出口: スタッフの送付が無いのに「フリーレント1ヶ月付き」→ 止める", () => ok(ungroundedFreeRentSentence("こちらのお部屋はフリーレント1ヶ月付きのお部屋となります！！", []) !== null));
  it("出口: スタッフの送付があれば通す", () => eq(ungroundedFreeRentSentence("こちらのお部屋はフリーレント1ヶ月付きのお部屋となります！！", collectStaffFreeRent([{ text: AIX_REC }])), null));
  it("出口: 条件の言い直し・探す約束・確認は対象外（見張りの下書き 844341・db3722）", () => {
    eq(ungroundedFreeRentSentence("フリーレント・風呂トイレ別・エアコン付きのご希望も踏まえてお送りしております！", []), null);
    eq(ungroundedFreeRentSentence("石橋阪大前周辺全域からフリーレント物件も含めて、〇〇さんのご条件に合うお部屋ピックアップしてお送りさせて頂きます！！", []), null);
    eq(ungroundedFreeRentSentence("フリーレントにつきましては管理会社に確認させて頂きます！！", []), null);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
