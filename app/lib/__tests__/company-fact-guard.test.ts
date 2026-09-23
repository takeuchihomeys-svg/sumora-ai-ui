// 会社の事実に反する断定を出口で見つける純関数（company-fact-guard）と final-check V16 のテスト（自己完結ハーネス）
// 実行: npx tsx app/lib/__tests__/company-fact-guard.test.ts
//
// 文はすべて実物（DeepSeek 経路の生成・AI 下書き・実送信・line-reply-prompts の正例）。
// 全件監査: npx tsx --env-file=.env.local scripts/audit-final-check-company-facts.ts（実送信365日 7,997通でゲート無し当たり0）
import {
  findCompanyFactContradiction,
  findCompanyFactContradictionsUngated,
  buildCompanyFactsForCheck,
} from "../company-fact-guard";
import { runDeterministicChecks } from "../final-check";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const truthy = (a: unknown, m = "") => { if (!a) throw new Error(`expected truthy ${m}`); };
const falsy = (a: unknown, m = "") => { if (a) throw new Error(`expected falsy ${m}`); };
const eq = (a: unknown, b: unknown) => { if (a !== b) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };
const ids = (body: string) => findCompanyFactContradictionsUngated(body).map((h) => h.factId);

// ── 落とす物（実物の生成・下書き）──
describe("落とす: 会社の事実に反する断定（DeepSeek 経路の実物）", () => {
  it("場面③ 室内写真は現在ご用意出来ていない為、私の方で撮影しお送りさせて頂きます", () =>
    eq(ids("かしこまりました😊！！\n室内写真は現在ご用意出来ていない為、私の方で撮影しお送りさせて頂きます😊！！")[0], "room_photo"));
  it("場面② 弊社での室内撮影は行えておらず現状写真はご用意できておりません", () =>
    eq(ids("弊社での室内撮影は行えておらず現状写真はご用意できておりません。")[0], "room_photo"));
  it("写真はございません（理由なし）", () => eq(ids("室内の写真はございません！！")[0], "room_photo"));
  it("撮影は行っておりません", () => eq(ids("室内の撮影は行っておりません！！")[0], "room_photo"));
  it("場面① 店舗にご来店頂いてのご相談も承っております", () =>
    eq(ids("店舗にご来店頂いてのご相談も承っております😊！！")[0], "store"));
  it("事務所でのご相談も可能です", () => eq(ids("事務所でのご相談も可能です！！")[0], "store"));
  it("対面でのご相談も承っております", () => eq(ids("対面でのご相談も承っております！！")[0], "store"));
  it("09-05 下書き: クレジットカード払いは対応しておらず、現金でのお振込みとなります（スタッフが直した）", () =>
    eq(ids("お支払い方法につきましては、クレジットカード払いは対応しておらず、現金でのお振込みとなります。")[0], "credit_card"));
  it("クレカ決済はご利用いただけません", () => eq(ids("クレカ決済はご利用いただけません！！")[0], "credit_card"));
  it("緊急連絡先は不要です", () => eq(ids("緊急連絡先は不要です！！")[0], "emergency_contact"));
  it("緊急連絡先は必須ではありません", () => eq(ids("緊急連絡先は必須ではありませんのでご安心ください！！")[0], "emergency_contact"));
  it("オンライン内覧は行っておりません", () => eq(ids("オンライン内覧は行っておりません！！")[0], "viewing_method"));
});

// ── 誤削除0の確認: 実送信の近い形（監査 B で全部読んだ物）をそのまま入れる ──
describe("落とさない: 実送信に実在する形（監査で残ると確かめた物）", () => {
  it("06-26 建築中のため室内完成されておらず、室内写真まだご用意出来ておりません（理由付き・実送信）", () =>
    eq(ids("Sierra深江南は建築中のため室内完成されておらず、室内写真まだご用意出来ておりません").length, 0));
  it("line-reply-prompts の正例: 建築中のため室内が完成されておらず、室内写真はまだご用意出来ておりません", () =>
    eq(ids("建築中のため室内が完成されておらず、室内写真はまだご用意出来ておりません").length, 0));
  it("07-23 建設中のお部屋となりますので、室内写真が出ていない物件となります", () =>
    eq(ids("パラシオ柴島現在建設中のお部屋となりますので、室内写真が出ていない物件となります").length, 0));
  it("05-22 写真がない場合は内覧の際に直接お部屋をご確認頂けます（条件形）", () =>
    eq(ids("実際にお気に召されたお部屋が見つかりましたら、写真がない場合は内覧の際に直接お部屋をご確認頂けますので、ご安心ください✨").length, 0));
  it("09-22 リノベーション工事中となり写真掲載がされていないお部屋もなります", () =>
    eq(ids("現在リノベーション工事中となり写真掲載がされていないお部屋もなります").length, 0));
  it("05-21 お送りいただいている画像がこちらで確認できていない（届いた画像の話）", () =>
    eq(ids("申し訳ございません、お送りいただいている画像がこちらで確認できていない状況です💦").length, 0));
  it("退去前のため撮影は出来ません（物件固有の理由）", () =>
    eq(ids("退去前のため現在撮影は出来ません。退去後撮影してお送りさせて頂きます！！").length, 0));
  it("08-05 店舗では無く作業用の事務所となりますので、ご来社でのご相談が出来ない形（会社の事実そのもの・4通）", () =>
    eq(ids("店舗では無く作業用の事務所となりますので、ご来社でのご相談が出来ない形となります").length, 0));
  it("05-19 本日のご来店を心よりお待ちしております（内覧の待ち合わせ）", () =>
    eq(ids("本日のご来店を心よりお待ちしております😊").length, 0));
  it("申込テンプレ: ご来店頂けますと内覧から審査まで", () =>
    eq(ids("ご来店頂けますと内覧から審査までスムーズに進めさせて頂きます！！").length, 0));
  it("09-16 ご来店頂く為のオトリ物件（ポータルの説明）", () =>
    eq(ids("ニフティ等のポータルサイトは終了したお部屋を、ご来店頂く為のオトリ物件として掲載されている場合御座います").length, 0));
  it("09-05 実送信: クレジットカード払い対応しております", () =>
    eq(ids("お支払い方法につきましてクレジットカード払い対応しております！！").length, 0));
  it("保証会社の話: クレカ系の保証会社は審査が通りません（支払い方法ではない）", () =>
    eq(ids("クレカ系の保証会社は滞納歴があると審査が通りません").length, 0));
  it("分割サービスは導入しておりません（会社の事実そのもの）", () =>
    eq(ids("分割払いはクレジットカードの分割のみで、分割サービスは導入しておりません").length, 0));
  it("08-28 連帯保証人と緊急連絡先は審査の際に必要となります", () =>
    eq(ids("基本的に連帯保証人と緊急連絡先は審査の際に必要となります").length, 0));
  it("09-06 3親等以内の緊急連絡先を設定いただく必要がございます", () =>
    eq(ids("3親等以内の緊急連絡先を設定いただく必要がございます").length, 0));
  it("内覧可能エリア外のためオンライン内覧が出来ない（会社の事実そのもの）", () =>
    eq(ids("こちらのお部屋は内覧可能エリア外のためオンライン内覧も出来ない形となります").length, 0));
  it("空・null", () => { eq(ids("").length, 0); eq(findCompanyFactContradictionsUngated(null).length, 0); });
});

// ── ゲート: お客様がその事実を聞いている時だけ ──
describe("ゲート（matchCompanyFacts＝生成と同じ関数）", () => {
  const PHOTO_NG = "室内写真は現在ご用意出来ていない為、私の方で撮影しお送りさせて頂きます😊！！";
  it("お客様が「これ室内写真欲しいです」→ 写真の断定を返す", () => {
    const h = findCompanyFactContradiction(PHOTO_NG, ["これ室内写真欲しいです"]);
    truthy(h); eq(h?.factId, "room_photo");
  });
  it("お客様が店舗の話しかしていない → 写真の断定は返さない（別の事実）", () =>
    falsy(findCompanyFactContradiction(PHOTO_NG, ["当日はそちらの店舗へ伺い、ご相談させていただきながら"])));
  it("お客様が何も聞いていない → null", () => falsy(findCompanyFactContradiction(PHOTO_NG, ["ありがとうございます！"])));
  it("直近3通のどれかで聞いていれば当たる（写真の依頼→了承→断定）", () =>
    truthy(findCompanyFactContradiction(PHOTO_NG, ["はい", "写真お願いできますか？"])));
  it("画像の書き起こし（[画像] 室内写真…）は聞いたことにならない", () =>
    falsy(findCompanyFactContradiction(PHOTO_NG, ["[画像] 室内写真 1LDK 家賃7万円"])));
  it("店舗を聞かれて「店舗にご来店頂いてのご相談も承っております」→ store", () =>
    eq(findCompanyFactContradiction("店舗にご来店頂いてのご相談も承っております😊！！", ["当日はそちらの店舗へ伺い、ご相談させていただきながら、ほかの物件もご紹介いただければと思います"])?.factId, "store"));
});

describe("検査に渡す会社の事実（anomaly_scan の [COMPANY_FACTS]）", () => {
  it("聞かれていなければ空文字", () => eq(buildCompanyFactsForCheck(["ありがとうございます"]), ""));
  it("写真を聞かれたら写真の事実（強調記号は外す）", () => {
    const s = buildCompanyFactsForCheck(["これ室内写真欲しいです"]);
    truthy(s.includes("撮影して送ることができる")); falsy(s.includes("**"));
  });
});

// ── final-check の決定論の段（V16）に繋がっているか ──
describe("final-check V16 COMPANY_FACT_CONTRADICTION", () => {
  const ctxOf = (cust: string) => ({
    lastCustomerMessage: cust,
    recentMessages: [
      { sender: "staff", text: "かしこまりました！！\nご希望のお部屋お送りさせて頂きます！！", createdAt: "2026-09-23T01:00:00Z" },
      { sender: "customer", text: cust, createdAt: "2026-09-23T01:10:00Z" },
    ],
    customerName: "佐藤",
  });
  it("場面③の実物 → block", () => {
    const iss = runDeterministicChecks("かしこまりました😊！！\n室内写真は現在ご用意出来ていない為、私の方で撮影しお送りさせて頂きます😊！！", ctxOf("これ室内写真欲しいです"));
    const hit = iss.find((i) => i.code === "COMPANY_FACT_CONTRADICTION");
    truthy(hit, JSON.stringify(iss.map((i) => i.code)));
    eq(hit?.severity, "block");
    truthy(hit?.evidence && "かしこまりました😊！！\n室内写真は現在ご用意出来ていない為、私の方で撮影しお送りさせて頂きます😊！！".includes(hit.evidence), "evidence は本文に実在する");
  });
  it("正しい返し（撮影してお送り）→ 出ない", () => {
    const iss = runDeterministicChecks("かしこまりました😊！！\n室内の写真・動画を撮影してお送りさせて頂きます😊！！", ctxOf("これ室内写真欲しいです"));
    falsy(iss.some((i) => i.code === "COMPANY_FACT_CONTRADICTION"));
  });
  it("理由付きの実送信（建築中）→ 出ない", () => {
    const iss = runDeterministicChecks("建築中のため室内が完成されておらず、室内写真はまだご用意出来ておりません！！", ctxOf("これ室内写真欲しいです"));
    falsy(iss.some((i) => i.code === "COMPANY_FACT_CONTRADICTION"));
  });
  it("場面①の実物（店舗）→ block", () => {
    const iss = runDeterministicChecks("店舗にご来店頂いてのご相談も承っております😊！！", ctxOf("当日はそちらの店舗へ伺い、ご相談させていただきながら、ほかの物件もご紹介いただければと思います"));
    eq(iss.find((i) => i.code === "COMPANY_FACT_CONTRADICTION")?.severity, "block");
  });
  it("聞かれていない時は出ない（会社の事実は聞かれた時だけ）", () => {
    const iss = runDeterministicChecks("室内写真はございません！！", ctxOf("ありがとうございます！"));
    falsy(iss.some((i) => i.code === "COMPANY_FACT_CONTRADICTION"));
  });
});

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.map((f) => ` - ${f}`).join("\n")); process.exit(1); }
