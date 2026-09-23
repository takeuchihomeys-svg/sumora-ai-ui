// 家賃交渉の していない約束 を入口で落とす関数のテスト（自己完結ハーネス）
// 実行: npx tsx app/lib/__tests__/rent-negotiation-guard.test.ts
//
// 文はすべて実物（実送信・AI下書き ai_reply_examples・ブレインの reply_direction）。
import {
  isRentNegotiationPromise,
  isRentNegotiationTopic,
  customerAskedRentNegotiation,
  stripRentNegotiation,
  stripRentNegotiationFromList,
} from "../rent-negotiation-guard";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const truthy = (a: unknown, m = "") => { if (!a) throw new Error(`expected truthy ${m}`); };
const falsy = (a: unknown, m = "") => { if (a) throw new Error(`expected falsy ${m}`); };
const eq = (a: unknown, b: unknown) => { if (a !== b) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };

// ── 落とす物: 実物のブレインの方向（dir）と AI 下書き（実送信は0通なので誤削除0）──
describe("落とす（家賃・賃料の値下げをこれからする予告）", () => {
  it("9/21 dir: 家賃交渉の確認を宣言し", () =>
    truthy(isRentNegotiationPromise("家賃交渉の確認を宣言し")));
  it("9/23 dir: 朝日プラザの家賃交渉を継続する", () =>
    truthy(isRentNegotiationPromise("新着物件の検索と朝日プラザの家賃交渉を継続する姿勢を示す")));
  it("9/23 下書き本文: 家賃交渉ができないか管理会社に確認させて頂きます", () =>
    truthy(isRentNegotiationPromise("現在ご検討いただいている物件についても、家賃交渉ができないか管理会社に確認させて頂きます")));
  it("08-28 下書き: 家賃込み込みでの金額交渉が可能か確認させて頂きます", () =>
    truthy(isRentNegotiationPromise("家賃込み込みでの金額交渉が可能か確認させて頂きます")));
  it("07-21 下書き: 家賃の減額交渉が可能か確認させて頂きます", () =>
    truthy(isRentNegotiationPromise("家賃の減額交渉が可能か確認させて頂きます")));
  it("07-18 下書き: その分の費用を家賃値引きとして交渉させて頂きます", () =>
    truthy(isRentNegotiationPromise("その分の費用を家賃値引きとして交渉させて頂きます")));
  it("9/21 dir（別会話）: 家賃交渉可能性も併せて回答する", () =>
    truthy(isRentNegotiationPromise("URL物件の募集状況を確認し家賃交渉可能性も併せて回答する")));
});

// ── 誤削除0の確認: 実送信15通の内訳をそのまま入れる ──
describe("落とさない（実送信に実在する形）", () => {
  it("06-17 過去形の結果報告（唯一残すべき下書き）", () =>
    falsy(isRentNegotiationPromise("家賃の交渉をさせて頂きましたが、減額は一切行っていないとのことでした")));
  it("結果報告（否決）", () =>
    falsy(isRentNegotiationPromise("管理会社に確認しましたところ、家賃の減額は考えていないとのことでした")));
  it("敷金・礼金の交渉（実送信15通・残す）", () =>
    falsy(isRentNegotiationPromise("礼金の交渉もさせて頂きます")));
  it("お部屋が決まりましたら交渉もさせて頂きます（敷礼の将来形・残す）", () =>
    falsy(isRentNegotiationPromise("お部屋が決まりましたら交渉もさせて頂きます")));
  it("管理費の値下げ（顧客が依頼した後・実送信3通）", () =>
    falsy(isRentNegotiationPromise("管理費の値下げが可能か管理会社に確認させて頂きます")));
  it("支払方法・スライドの交渉（実送信4通）", () =>
    falsy(isRentNegotiationPromise("お支払い方法のスライドが可能か交渉させて頂きます")));
  it("物件情報（家賃減額募集中）", () =>
    falsy(isRentNegotiationPromise("こちらのお部屋は家賃減額募集中となっております")));
  it("初期費用の割引（実送信818通＝会社の本当の答え）", () =>
    falsy(isRentNegotiationPromise("最大限割引させて頂いた初期費用の御見積書をお送りさせて頂きます")));
  it("家賃の条件で探す（値下げではない）", () =>
    falsy(isRentNegotiationPromise("家賃8万円以下・同間取りの新着物件をピックアップしてお送りする")));
  it("節が分かれていれば敷礼の交渉を巻き込まない", () =>
    falsy(isRentNegotiationPromise("礼金の交渉もさせて頂きます")));
  // ⑦全件監査（audit-rent-negotiation）で止めた3件。実送信なので必ず残す
  it("監査1: お客様の質問を並べた見出し行「✅家賃の交渉について」", () =>
    falsy(isRentNegotiationPromise("✅家賃の交渉について")));
  it("監査2: 家賃のスライド交渉（共益費を賃料に寄せる・値下げではない）", () =>
    falsy(isRentNegotiationPromise("管理会社に家賃のスライド交渉させていただき、共益費の3,000円は賃料にスライド可能とのご返事でした")));
  it("監査3: 口座振込での家賃支払いの交渉（支払方法・値下げではない）", () =>
    falsy(isRentNegotiationPromise("審査時に管理会社・オーナーさんに口座振り込みでの家賃支払いが問題ないか交渉させていただきます")));
});

describe("お客様が自分から家賃の交渉を頼んだ時だけ通す", () => {
  it("家賃の交渉をお願いできますか → 依頼あり", () =>
    truthy(customerAskedRentNegotiation(["家賃の交渉をお願いできますか？"])));
  it("家賃の値下げをしてほしいです → 依頼あり", () =>
    truthy(customerAskedRentNegotiation(["家賃の値下げをしてほしいです"])));
  it("もう少し安くなりませんか？ → 依頼ではない（07-21 の実送信は初期費用の割引だった）", () =>
    falsy(customerAskedRentNegotiation(["もう少し安くなりませんか？"])));
  it("家賃が安いと嬉しかったですね → 依頼ではない（あっぴさんの実物）", () =>
    falsy(customerAskedRentNegotiation(["1個目間取りがいいですけど家賃が安いと嬉しかったですね！"])));
});

describe("方向から落とす（節ごと）", () => {
  it("前半だけ落として後半を残す（9/21 の実物）", () => {
    const r = stripRentNegotiation("家賃交渉の確認を宣言し、同条件で新着物件のピックアップも継続する");
    eq(r.text, "同条件で新着物件のピックアップも継続する");
    truthy(r.dropped);
  });
  it("残りが短すぎる時は null（9/23 の実物）", () => {
    const r = stripRentNegotiation("感謝を受け取り、新着物件の検索と朝日プラザの家賃交渉を継続する姿勢を示す");
    eq(r.text, null);
    truthy(r.dropped);
  });
  it("当たらない方向はそのまま（誤削除0）", () => {
    const d = "条件に合う新着のお部屋をピックアップして届ける";
    const r = stripRentNegotiation(d);
    eq(r.text, d);
    eq(r.dropped, null);
  });
  it("お客様が依頼していれば落とさない", () => {
    const d = "家賃の減額交渉が可能か管理会社に確認する";
    const r = stripRentNegotiation(d, { customerAsked: true });
    eq(r.text, d);
    eq(r.dropped, null);
  });
  it("空・null はそのまま", () => {
    eq(stripRentNegotiation(null).text, null);
    eq(stripRentNegotiation("").dropped, null);
  });
});

// 入口（方向・key_topics）は厳しくてよい／出口（本文）は誤削除0が要る = 判定を2本に分ける
describe("入口のゆるい判定（名詞句も落とす）と出口の厳しい判定（実送信を壊さない）", () => {
  it("入口: 家賃交渉の確認（名詞句）は落とす", () => truthy(isRentNegotiationTopic("家賃交渉の確認")));
  it("出口: 家賃交渉の確認（名詞句）だけでは本文を指摘しない", () => falsy(isRentNegotiationPromise("家賃交渉の確認")));
  it("入口でも支払方法の交渉・過去形は落とさない", () => {
    falsy(isRentNegotiationTopic("家賃のスライド交渉を確認する"));
    falsy(isRentNegotiationTopic("家賃の減額交渉をした結果を報告する"));
  });
  it("入口でも敷金礼金・初期費用は落とさない", () => {
    falsy(isRentNegotiationTopic("礼金の交渉を申し出る"));
    falsy(isRentNegotiationTopic("初期費用を最大限割引する"));
  });
});

// 2026-09-23 反証者の指摘で足した2件（実物）
describe("反証で足した形", () => {
  it("7/18 だいちさんの下書き（連体・並列形「交渉させて頂くなど」・スタッフが全削除）→ 予告として拾う", () =>
    truthy(isRentNegotiationPromise("万が一洋室へのエアコン新設が難しい場合でも、その分の費用を家賃値引きとして交渉させて頂くなど、最大限サポートさせて頂きます")));
  it("連用形「交渉させて頂き、」も拾う", () =>
    truthy(isRentNegotiationPromise("家賃の減額交渉をさせて頂き、結果が出次第ご連絡します".replace("結果が出次第ご連絡します", "並行でお部屋も探します"))));
  it("断り文「家賃の交渉はお受け出来かねますが…」は約束ではない → 拾わない", () =>
    falsy(isRentNegotiationPromise("家賃の交渉はお受け出来かねますが、初期費用は最大限お安くさせて頂きます")));
  it("「家賃交渉は難しいのですが」も拾わない", () =>
    falsy(isRentNegotiationPromise("家賃交渉は難しいのですが、初期費用の割引を代表に申請させて頂きます")));
});

describe("key_topics から落とす", () => {
  it("家賃交渉の項目だけ落ちる", () => {
    const r = stripRentNegotiationFromList(["家賃交渉の確認", "新着物件のピックアップ宣言", "初期費用の割引の案内"]);
    eq(r.items.length, 2);
    eq(r.dropped.length, 1);
    eq(r.items[0], "新着物件のピックアップ宣言");
  });
});

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.map((f) => ` - ${f}`).join("\n")); process.exit(1); }
