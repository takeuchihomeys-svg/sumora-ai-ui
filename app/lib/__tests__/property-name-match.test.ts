// app/lib/__tests__/property-name-match.test.ts
// 実行: npx tsx app/lib/__tests__/property-name-match.test.ts（自己完結ハーネス。全 PASS で exit 0）
//
// 2026-09-20 竹内「お客さん毎に送った物件のテーブル作ってそこから読み取れるようにすれば良いのでは」
// 材料は**本番の実物**（スタッフ送信画像6枚を Haiku / Sonnet5 で読んだ結果と、sent_properties の実データ）。
import { normalizePropertyName, similarity, matchKnownProperty, resolveReadProperty, MATCH_MIN_SCORE } from "../property-name-match";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} got ${JSON.stringify(actual)}`); },
    toContain(sub: string) { if (!String(actual).includes(sub)) throw new Error(`"${String(actual)}" に "${sub}" が無い`); },
    atLeast(n: number) { if (Number(actual) < n) throw new Error(`${actual} < ${n}`); },
    atMost(n: number) { if (Number(actual) > n) throw new Error(`${actual} > ${n}`); },
  };
}

console.log("\n── 表記ゆれをそろえる（sent_properties の実データ）──");

it("先頭の番号を外す（【1】ポルチュラーカ ＝ ポルチュラーカ）", () => {
  expect(normalizePropertyName("【1】ポルチュラーカ")).toBe(normalizePropertyName("ポルチュラーカ"));
  expect(normalizePropertyName("②メゾンボヌール")).toBe(normalizePropertyName("メゾンボヌール"));
  expect(normalizePropertyName("3. プランドールB")).toBe(normalizePropertyName("プランドールB"));
});

it("全角スペース・全角英数をそろえる（モメント　ブリーシュフル）", () => {
  expect(normalizePropertyName("モメント　ブリーシュフル")).toBe(normalizePropertyName("モメント ブリーシュフル"));
  expect(normalizePropertyName("ＲＩＳＩＮＧ Ｍａｉｓｏｎ")).toBe(normalizePropertyName("RISING Maison"));
});

it("記号の有無で別物にしない（porte bonheur(ポルトボヌール)）", () => {
  expect(similarity("porte bonheur(ポルトボヌール)", "porte bonheur ポルトボヌール")).toBe(1);
  expect(similarity("ハイツカトレア B", "ハイツカトレアB")).toBe(1);
});

console.log("\n── ★ 迷うものは捨てる（誤読を DB に入れない・fail-closed）──");

// 実測: Haiku は同じ画像を「スプランディッド堀江」「スプラッティド堀江」と別名で読んだ。
//   似ている度は 0.47 で、別物（0.35）と近すぎる。**その間に線は引けない**ので両方捨てる。
it("★ Haiku の誤読は寄せずに捨てる（0.47 ＜ 閾値）", () => {
  const s = similarity("スプラッティド堀江", "スプランディッド堀江");
  expect(s).atMost(MATCH_MIN_SCORE - 0.01);
  expect(matchKnownProperty("スプラッティド堀江", ["スプランディッド堀江"]) === null).toBe(true);
});

it("★ 別物にも寄せない（ファースネックス大阪Ⅱ → アーバネックス本町Ⅱ にしない）", () => {
  const s = similarity("ファースネックス大阪Ⅱ", "アーバネックス本町Ⅱ");
  expect(s).atMost(MATCH_MIN_SCORE - 0.01);
  expect(matchKnownProperty("ファースネックス大阪Ⅱ", ["アーバネックス本町Ⅱ"]) === null).toBe(true);
});

it("★ 記号・空白だけの違いは寄せる（表記ゆれは吸収する）", () => {
  expect(matchKnownProperty("porte bonheur(ポルトボヌール)", ["porte bonheur ポルトボヌール"])?.exact).toBe(true);
  expect(matchKnownProperty("ハイツカトレアB", ["ハイツカトレア B"])?.exact).toBe(true);
  expect(matchKnownProperty("モメント ブリーシュフル", ["モメント　ブリーシュフル"])?.exact).toBe(true);
});

it("完全一致はそのまま（RISING Maison 本町橋）", () => {
  const m = matchKnownProperty("RISING Maison 本町橋", ["RISING Maison 本町橋", "ハイムM&K"]);
  expect(m?.name).toBe("RISING Maison 本町橋");
  expect(m?.exact).toBe(true);
});

console.log("\n── ★ 照合できなければ記録しない（誤読を DB に入れない）──");

it("★ 既知の物件名が1つも無ければ null（読み取った名前をそのまま使わない）", () => {
  expect(resolveReadProperty({ propertyName: "スプランディッド堀江", roomNumber: "403" }, []) === null).toBe(true);
});

it("★ 似ている名前が無ければ null", () => {
  expect(resolveReadProperty({ propertyName: "まったく別のマンション", roomNumber: "101" }, ["スプランディッド堀江"]) === null).toBe(true);
});

it("寄せた名前と号室を返す（号室の先頭ゼロは外す＝日本の号室は0から始まらない）", () => {
  const r = resolveReadProperty({ propertyName: "スプランディッド堀江", roomNumber: "0403" }, ["スプランディッド堀江"]);
  expect(r?.propertyName).toBe("スプランディッド堀江");
  expect(r?.roomNumber).toBe("403");
});

it("「403号室」と読まれても号室の字を外す", () => {
  expect(resolveReadProperty({ propertyName: "ハイムM&K", roomNumber: "306号室" }, ["ハイムM&K"])?.roomNumber).toBe("306");
});

console.log("\n── 壊れない ──");

it("空・null・1文字で落ちない", () => {
  expect(normalizePropertyName(null)).toBe("");
  expect(normalizePropertyName("")).toBe("");
  expect(similarity("", "あ")).toBe(0);
  expect(matchKnownProperty("", ["テスト"]) === null).toBe(true);
  expect(matchKnownProperty("あ", ["テスト"]) === null).toBe(true);   // 1文字は照合しない
  expect(resolveReadProperty({}, ["テスト"]) === null).toBe(true);
});

it("既知の名前に空文字が混ざっていても落ちない", () => {
  const m = matchKnownProperty("ハイムM&K", ["", "  ", "ハイムM&K"]);
  expect(m?.name).toBe("ハイムM&K");
});

console.log(`\n${failed === 0 ? "✅ 全 PASS" : "❌ 失敗あり"}  ${passed} passed / ${failed} failed`);
if (failed) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
