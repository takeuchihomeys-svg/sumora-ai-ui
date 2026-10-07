// 2026-10-07 竹内「文の質をあげてボタンとしてつかっていく」: AIX【物件を探す】（条件を受けて探す約束の1通）の材料・最小の型・出口の注意
// 実行: npx tsx app/lib/__tests__/property-search-promise.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { PROPERTY_SEARCH_STAFF_EXAMPLES, PROPERTY_SEARCH_SYSTEM, buildPropertySearchUser, propertySearchFallback, propertySearchTextIssues } from "../property-search-promise";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { const a = JSON.stringify(actual), b = JSON.stringify(exp); if (a !== b) throw new Error(`expected ${b} but got ${a}`); },
    toContain(s: string) { if (!String(actual).includes(s)) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(s)}`); },
    notToContain(s: string) { if (String(actual).includes(s)) throw new Error(`expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(s)}`); },
  };
}

it("手本はスタッフの実送信（名前だけ〇〇）・出口の注意に1つも当たらない", () => {
  for (const t of PROPERTY_SEARCH_STAFF_EXAMPLES) expect(propertySearchTextIssues(t)).toBe([]);
  expect(PROPERTY_SEARCH_STAFF_EXAMPLES.every((t) => /ピックアップ/.test(t))).toBe(true);
  expect(PROPERTY_SEARCH_SYSTEM).toContain("例1:\nかしこまりました！！\n家賃をもう少し上げたご条件で");
});
it("出口（注意だけ・本文は変えない）: 号室・「お客様」と呼ぶ・形の記号の漏れ。手打ちでも書く物（額・内覧・見積・確認）は拾わない", () => {
  expect(propertySearchTextIssues("かしこまりました！！\nスワンズ京都東寺ガーデン 205号室もございます！！")).toBe(["号室"]);
  expect(propertySearchTextIssues("お客様にオススメできるお部屋ピックアップしてお送りさせて頂きます！！")).toBe(["「お客様」と呼んだ"]);
  expect(propertySearchTextIssues("他のお客様のお申込みが入りましたので、新たにピックアップさせて頂きます！！")).toBe([]);
  expect(propertySearchTextIssues("ご連絡頂きありがとうございます😊！！」\n②「本日16時お部屋ご案内させて頂きます！」")).toBe(["形の記号の漏れ"]);
  // 手打ち 517通に当てて 0 通（会話の「14」をスタッフは「14万円以内」と書く・内覧のキャンセルと一緒に約束する 等）
  expect(propertySearchTextIssues("かしこまりました！！\n中央区、浪速区全域から14万円以内の2LDKのお部屋ピックアップさせていただきます😊！！")).toBe([]);
  expect(propertySearchTextIssues("かしこまりました！！\nLuxe難波西2の内覧キャンセル承りました！！\n大国町エリアから初期費用10万以下でお部屋、引き続きピックアップしてお送りさせて頂きます！！")).toBe([]);
});
it("材料: 名前が無ければ「名前も『お客様』も書かない」・補足メモは最優先", () => {
  const u = buildPropertySearchUser({ name: "", history: "【直近の会話】\nお客様: 大国町で探してます", staffNote: "1K・7畳以上" });
  expect(u).toContain("お客様名: 不明（名前も「お客様」も書かない）");
  expect(u).toContain("【スタッフの補足メモ（今回探す条件・最優先）】1K・7畳以上");
  expect(buildPropertySearchUser({ name: "YUMAさん", history: "" })).toContain("お客様名: YUMAさん");
});
it("最小の型（LLM が空の時）: 名前ありなし", () => {
  expect(propertySearchFallback("YUMAさん")).toBe("かしこまりました！！\nYUMAさんにオススメできるお部屋ピックアップしてお送りさせて頂きます😊！！");
  expect(propertySearchFallback("")).toBe("かしこまりました！！\nオススメできるお部屋ピックアップしてお送りさせて頂きます😊！！");
  expect(propertySearchFallback("")).notToContain("お客様");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
