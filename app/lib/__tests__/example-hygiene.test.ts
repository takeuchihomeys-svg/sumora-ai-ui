// app/lib/__tests__/example-hygiene.test.ts
// 実行: npx tsx app/lib/__tests__/example-hygiene.test.ts（自己完結ハーネス。全 PASS で exit 0）
//
// 2026-09-20 竹内「他にも文生成の問題起きないか徹底的にテスト」
//
// 見つけた穴: AIX【確認します】(acknowledge_check) は**管理会社・オーナー宛て**のメッセージも作る
//   （aix/action/route.ts に「【メッセージの宛先】管理会社またはオーナー（お客様宛てではない）」と明記された正しい機能）。
//   その出力が手本 ai_reply_examples に入り、line-reply-prompts.ts の
//   `STATE_SEARCH_ALIASES.applying` が "acknowledge_check" を含むため、
//   **申込中のお客様への返信を作る時に管理会社宛ての文が手本として渡っていた**（手本8件・☆付きあり）。
//
// 線（scripts/audit-mgmt-phrase-line.ts）: お客様へのLINE 12,031通に **0通** ／ 手本に8件 ＝ 誤削除0。
import { isUsableExampleText, isUsableAiDraft, isCustomerFacingExample, isGenerationFailureText, maskExampleAmounts } from "../example-hygiene";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} got ${JSON.stringify(actual)}`); } };
}

console.log("\n── ★ 管理会社・オーナー宛ての文は、お客様への手本にしない ──");

// 本番の手本にそのまま入っていた物（ai_reply_examples.sent_reply）
const MGMT_REAL: string[] = [
  "ゆそひさんのご案内をしております！！\nプレアール都島Ⅲ103号室の募集状況と、ご入居可能日を確認させていただきます！！\nあわせて最大限割引した初期費用の御見積もりもお願いできますでしょうか！！\nご確認頂けますと幸いです。よろしくお願い致します！！",
  "ASAさんのご案内をしております！！\nジオナ塚本708号室、初期費用について更なる割引が可能かご確認をお願いできますでしょうか！！\nあわせて最大限割引した初期費用の御見積もりもお願いできますでしょうか！！",
  "SHIGIさんのご案内をしております！！\nシエリアタワーなんば1605号室について、前向きにご検討頂いているお客様がいらっしゃり、初期費用のご相談です。",
  "恋さんのご案内をしております！！\nお送り頂きました物件のご提案物件、募集状況を確認させていただきます！！\nあわせて最大限割引した初期費用の御見積もりもお願いできますでしょうか！！",
];
for (const s of MGMT_REAL) {
  it(`★ 本物の管理会社宛て「${s.slice(0, 16)}…」は手本にしない`, () => {
    expect(isCustomerFacingExample(s)).toBe(false);
  });
}

it("★ お客様の名前が第三者に説明される形は必ず落とす（宛先の取り違え）", () => {
  expect(isCustomerFacingExample("大野さんのご案内をしております！！ エスティメゾン南堀江1103号室の番手確認をさせて頂きます！！")).toBe(false);
});

console.log("\n── 誤削除0（お客様へのLINEに実在する文は1つも落とさない）──");

// 本番の実送信（messages.sender=staff）から採った形
const CUSTOMER_REAL: string[] = [
  "かしこまりました😊！！\nお送り頂きました物件の募集状況確認させて頂きます！！\n確認出来次第ご連絡させて頂きます😌！！",
  "お世話になっております！！\nお客様お送り頂きました物件の中で\n・KTIレジデンス西中島II 202号室\nこちら2件現在募集中となります！！",
  "ご査収いただきありがとうございます😊！！\nかしこまりました！！\n代表に更に割引可能か交渉させていただきます！！",
  "ふりーだむさん、お世話になっております😊！！\n申込書類のご案内をさせて頂きますので、ご入居ご希望時期をお伺いできますでしょうか！！",
  "はい！！\n明日全てご案内させていただきます！！\n何卒よろしくお願い致します！！",
  "【エストレーラ 305号室】\n初期費用の御見積書お送りさせて頂きます！！\nお手隙の際にご査収ください😌！！",
  "お気に召されましたらお申込しお部屋抑えさせて頂きます！！",
];
for (const s of CUSTOMER_REAL) {
  it(`「${s.slice(0, 18)}…」は手本として使える`, () => {
    expect(isCustomerFacingExample(s)).toBe(true);
  });
}

it("★「ご案内させて頂きます」（お客様への内覧案内）は落とさない — 似ているが別物", () => {
  expect(isCustomerFacingExample("よろしければご都合よろしいお日にちにお部屋ご案内させて頂きます😌！！")).toBe(true);
  expect(isCustomerFacingExample("明日16時お部屋ご案内させて頂きます！！")).toBe(true);
});

it("★「申込書類のご案内をさせて頂きます」（お客様宛て）は落とさない", () => {
  expect(isCustomerFacingExample("申込書類のご案内をさせて頂きますので、ご入居ご希望時期をお伺いできますでしょうか！！")).toBe(true);
});

it("★「御見積書お送りさせて頂きます」（お客様宛て）は落とさない", () => {
  expect(isCustomerFacingExample("最大限割引しました初期費用の御見積書お送りさせて頂きます！！")).toBe(true);
});

console.log("\n── 既存の判定を壊していない（生成失敗文・テスト送信）──");

it("生成失敗文は手本にしない", () => {
  expect(isUsableExampleText("（AI返信の生成に失敗しました。再生成をお試しください）")).toBe(false);
  expect(isGenerationFailureText("（AI返信の生成に失敗しました。再生成をお試しください）")).toBe(true);
  expect(isUsableAiDraft("（AI返信の生成に失敗しました。再生成をお試しください）")).toBe(false);
});

it("テスト送信（極端に短い）は手本にしない", () => {
  expect(isUsableExampleText("あ")).toBe(false);
  expect(isUsableExampleText("test")).toBe(false);
});

it("空・null は手本にしない", () => {
  expect(isUsableExampleText("")).toBe(false);
  expect(isUsableExampleText(null)).toBe(false);
  expect(isCustomerFacingExample("")).toBe(false);
  expect(isCustomerFacingExample(null)).toBe(false);
});

it("ふつうの返信は手本にできる", () => {
  expect(isUsableExampleText("かしこまりました😊！！\nお部屋ご案内させて頂きます！！")).toBe(true);
});

// 2026-09-23 S4 の実測: 手本の金額（¥44,000／¥27,500）を一字一句写した → 注入の直前で伏せ字
console.log("\n── 手本の金額は伏せ字にして渡す（S4） ──");
it("¥44,000 と 27,500円 が伏せ字になる", () => {
  expect(maskExampleAmounts("礼金は¥44,000、鍵交換代は27,500円となります！！")).toBe("礼金は¥〇〇、鍵交換代は〇〇円となります！！");
});
it("8.5万円・8万5千円も伏せる", () => {
  expect(maskExampleAmounts("家賃8.5万円・管理費5,000円")).toBe("家賃〇〇円・管理費〇〇円");
});
it("号室・日付・時刻・徒歩分は触らない", () => {
  const s = "303号室、9/22（火）14:00にご案内可能です！！駅徒歩7分・築5年";
  expect(maskExampleAmounts(s)).toBe(s);
});
it("金額の無い文は1文字も変わらない", () => {
  const s = "かしこまりました😊！！\nお部屋ご案内させて頂きます！！";
  expect(maskExampleAmounts(s)).toBe(s);
});

console.log(`\n${failed === 0 ? "✅ 全 PASS" : "❌ 失敗あり"}  ${passed} passed / ${failed} failed`);
if (failed) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
