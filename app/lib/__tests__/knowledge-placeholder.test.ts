// app/lib/__tests__/knowledge-placeholder.test.ts
// 実行: npx tsx app/lib/__tests__/knowledge-placeholder.test.ts（自己完結ハーネス。全 PASS で exit 0）
// 本文は ai_reply_knowledge の**実物**（used の多い順）をそのまま使う。
import { maskKnowledgeSpecifics, MASKED_NOTE } from "../knowledge-placeholder";

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

it("実物[3] used=501 wrong=52: 条件の列挙を伏せて、言い回しの型は残す", () => {
  const r = maskKnowledgeSpecifics(
    "〇〇さんお待たせ致しました！！大阪市内全域からペット可・駅徒歩5分以内・家賃15万円以内の2LDKのご条件に合ったお部屋ピックアップさせて頂きました！！", "phrase");
  expect(r.changed).toBe(true);
  expect(r.text).notToContain("ペット");
  expect(r.text).notToContain("15万円");
  expect(r.text).notToContain("2LDK");
  expect(r.text).notToContain("大阪市内");
  // 言い回しの型（写させたい所）は残る
  expect(r.text).toContain("〇〇さんお待たせ致しました！！");
  expect(r.text).toContain("お部屋ピックアップさせて頂きました！！");
  // 助詞が余らない（「〇〇からのご条件」→「〇〇からご条件」）
  expect(r.text).toBe("〇〇さんお待たせ致しました！！〇〇からご条件に合ったお部屋ピックアップさせて頂きました！！");
});

// 2026-09-19 監査で見つけた誤りの回帰（語の途中で切らない）
it("「乗り換えなしのエリア」の途中で切らない（句読点・行頭からしか畳まない）", () => {
  const r = maskKnowledgeSpecifics(
    "〇〇さんお待たせ致しました！！梅田、難波まで乗り換えなしのエリア、築年数5年以内の駐車場有りのお部屋かなり限りございましたので、大阪市内全域からご条件に近いお部屋ピックアップさせていただきました！！", "phrase");
  expect(r.text).notToContain("エ〇〇");      // 旧: 「エ〇〇から」と語の途中で切れていた
  expect(r.text).toContain("ピックアップさせていただきました！！");
});

it("実物[5] used=421 wrong=43: 同じ型の別の手本も伏せる", () => {
  const r = maskKnowledgeSpecifics(
    "〇〇さんお待たせ致しました！！大阪市内全域からペット可・2LDK・駅徒歩10分以内・家賃17万円前後のご条件に合ったお部屋ピックアップさせて頂きました！！", "phrase");
  expect(r.changed).toBe(true);
  expect(r.text).notToContain("ペット");
  expect(r.text).notToContain("17万円");
  expect(r.text).toContain("お部屋ピックアップさせて頂きました！！");
});

it("実物[9] used=287 wrong=51: 括弧の中の条件列挙は（〇〇）にする", () => {
  const r = maskKnowledgeSpecifics(
    "〇〇さんのご希望条件（5階以上・ペット可・広めの間取り）に合うお部屋をピックアップ次第ご連絡させていただきます！！", "phrase");
  expect(r.changed).toBe(true);
  expect(r.text).notToContain("ペット");
  expect(r.text).notToContain("5階以上");
  expect(r.text).toContain("（〇〇）");
  expect(r.text).toContain("ピックアップ次第ご連絡させていただきます！！");
});

it("実物[4] used=463 wrong=64: エリアの列挙も〇〇に畳む（他のお客様のエリアを持ち込まない）", () => {
  const r = maskKnowledgeSpecifics(
    "かしこまりました！！なんば・日本橋・芦原橋・桜川・本町・島之内周辺全域から家賃管理費込み9〜11万円の1LDKのお部屋をピックアップしてお送りさせて頂きます！！", "phrase");
  expect(r.changed).toBe(true);
  expect(r.text).notToContain("なんば");
  expect(r.text).notToContain("11万円");
  expect(r.text).toContain("かしこまりました！！");
  expect(r.text).toContain("ピックアップしてお送りさせて頂きます！！");
});

it("実物[8] used=310: ナレッジ自身の方針（「列挙するのはNG」）は触らない", () => {
  const src = "ピックアップ行でペット可・礼金なし・審査通過しやすい等の具体的条件を列挙するのはNG。「ご条件のエリアから」とシンプルにまとめ、条件の詳細説明は省略する。";
  const r = maskKnowledgeSpecifics(src, "phrase");
  expect(r.text).toContain("ペット可・礼金なし・審査通過しやすい");   // 方針の説明なので残す
  expect(r.text).toContain("列挙するのはNG");
});

it("phrase 以外（pattern / principle / style）は1文字も触らない", () => {
  const src = "お客様が具体的な物件条件（駅徒歩・間取り・ペット可など）を追加提示した場合は、まず提示された条件を正確に復唱すること。";
  for (const cat of ["pattern", "principle", "style", "applying_pattern", null, ""]) {
    const r = maskKnowledgeSpecifics(src, cat);
    expect(r.changed).toBe(false);
    expect(r.text).toBe(src);
  }
});

it("宣言文でない phrase・具体値の無い phrase は触らない", () => {
  const a = "駐車場追加の件、管理会社に確認させていただきましたが、現在満車とのご返事でした。";
  expect(maskKnowledgeSpecifics(a, "phrase").changed).toBe(false);   // ピックアップ宣言ではない
  const b = "〇〇さんお待たせ致しました！！ご条件に合ったお部屋ピックアップさせて頂きました！！";
  expect(maskKnowledgeSpecifics(b, "phrase").changed).toBe(false);   // 具体値が無い
  expect(maskKnowledgeSpecifics("", "phrase").changed).toBe(false);
});

it("伏せた事を伝える1行がある（〇〇の意味を LLM に誤解させない）", () => {
  expect(MASKED_NOTE).toContain("このお客様の条件を入れる所");
  expect(MASKED_NOTE).toContain("別のお客様の物");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.join("\n")); process.exit(1); }
