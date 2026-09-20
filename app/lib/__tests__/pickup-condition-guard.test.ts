// app/lib/__tests__/pickup-condition-guard.test.ts
// 実行: npx tsx app/lib/__tests__/pickup-condition-guard.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { conditionGrounded, findUngroundedConditions, buildUngroundedNotice } from "../pickup-condition-guard";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} got ${JSON.stringify(actual)}`); },
    toContain(sub: string) { if (!String(actual).includes(sub)) throw new Error(`"${String(actual)}" に "${sub}" が無い`); },
    notToContain(sub: string) { if (String(actual).includes(sub)) throw new Error(`"${String(actual)}" に "${sub}" が入っている`); },
  };
}

// 慶次さんの実物: 会話には「ペット飼育有無 無し」（申込フォーム）しかない
const KEIJI_SOURCES = [
  "出来れば中央大通りより北側でお願いしたいです。ミナミ方面は、避けたいです。",
  "【お申込者様記入欄】\n・入居希望日 10月25日前後\n・ペット飼育有無 無し\n・駐車場（台数）0",
  "ガスコンロ希望（無くても可）／敷金礼金なし",
];

it("慶次事例: 申込フォームの「ペット飼育有無 無し」は根拠にしない", () => {
  expect(conditionGrounded("ペット", KEIJI_SOURCES)).toBe(false);
  expect(conditionGrounded("駐車場", KEIJI_SOURCES)).toBe(false);   // 「（台数）0」も否定
});

it("慶次事例: 「ペット可条件でお部屋ピックアップ」を根拠なしとして見つける", () => {
  const draft = "かしこまりました！！\n\nペット可条件でお部屋ピックアップさせて頂きます！！\n\nピックアップ出来次第ご連絡させて頂きます😌！！";
  const hits = findUngroundedConditions(draft, KEIJI_SOURCES);
  expect(hits.length).toBe(1);
  expect(hits[0].word).toBe("ペット");
  expect(buildUngroundedNotice(hits)).toContain("ペット");
  expect(buildUngroundedNotice(hits)).toContain("会話に根拠の無い条件");
});

it("お客様が言っている条件は見つけない（実送信94%はこちら）", () => {
  const src = ["ペット可能でお願いします", "駐車場も必要です"];
  expect(findUngroundedConditions("ペット可・駐車場ありのお部屋ピックアップさせて頂きます！！", src).length).toBe(0);
});

it("複数条件のうち根拠の無いものだけ見つける", () => {
  const src = ["家賃5〜10万円で2部屋以上、同棲可でお願いします"];
  const hits = findUngroundedConditions("家賃5〜10万円・オートロック・2部屋以上・同棲可でお部屋をお探しさせて頂きます！！", src);
  expect(hits.length).toBe(1);
  expect(hits[0].word).toBe("オートロック");
  // 「10万円」の 0 を否定と読んで同棲まで根拠なしにしない（監査で見つけた誤り）
  expect(conditionGrounded("同棲", src)).toBe(true);
});

it("質問文は見ない（「ペットは猫ちゃんですか？」＝条件の宣言ではない）", () => {
  const draft = "ペットは猫ちゃんですか？それとも犬ちゃんですか？その情報があればぴったりなお部屋をピックアップしてすぐにご提案させていただきます";
  expect(findUngroundedConditions(draft, []).length).toBe(0);
});

it("ピックアップ宣言の行以外は見ない（物件カードの設備説明）", () => {
  const draft = "🌟サザンパークス 406\n・オートロック付き\n・ペット可\n\nお手隙の際にご査収ください😌！！";
  expect(findUngroundedConditions(draft, []).length).toBe(0);
});

it("条件語が無い宣言・空文字は何も見つけない", () => {
  expect(findUngroundedConditions("かしこまりました！！\n中央大通りより北側でお部屋ピックアップさせて頂きます！！", KEIJI_SOURCES).length).toBe(0);
  expect(findUngroundedConditions("", KEIJI_SOURCES).length).toBe(0);
  expect(buildUngroundedNotice([])).toBe("");
});

it("登録条件が根拠になる（条件フォームが画像で来た時の取りこぼしを減らす）", () => {
  const draft = "バストイレ別のお部屋ピックアップさせて頂きます！！";
  expect(findUngroundedConditions(draft, ["ありがとうございます"]).length).toBe(1);
  expect(findUngroundedConditions(draft, ["ありがとうございます", "preferences: バストイレ別・独立洗面台"]).length).toBe(0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.join("\n")); process.exit(1); }
