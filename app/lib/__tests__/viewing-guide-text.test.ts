// app/lib/__tests__/viewing-guide-text.test.ts
// 実行: npx tsx app/lib/__tests__/viewing-guide-text.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { buildViewingGuideText, propertyLabel } from "../viewing-guide-text";

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
// 2026-09-19（土）を「今」として固定する
const NOW = Date.parse("2026-09-19T12:00:00+09:00");

it("物件ラベル: 号室があれば「〇〇 202号室」・重複した「号室」は付けない", () => {
  expect(propertyLabel({ name: "The Peak Osaka Bay", roomNumber: "202" })).toBe("The Peak Osaka Bay 202号室");
  expect(propertyLabel({ name: "The Peak Osaka Bay", roomNumber: "202号室" })).toBe("The Peak Osaka Bay 202号室");
  expect(propertyLabel({ name: "エスリード弁天町パークプレイス" })).toBe("エスリード弁天町パークプレイス");
  expect(propertyLabel({ name: "  " })).toBe("");
});

it("はる事例: 空室1件＋退去予定1件を段落で分けて書く（実送信と同じ形）", () => {
  const r = buildViewingGuideText([
    { name: "The Peak Osaka Bay", roomNumber: "202" },
    { name: "エスリード弁天町パークプレイス", vacateDate: "9月30日" },
  ], "はる", NOW);
  expect(r.text).toBe(
    "よろしければ一度ご内覧如何でしょうか😊！！\n\n" +
    "The Peak Osaka Bay 202号室は空室ですので、はるさんご都合よろしいお日にちにお部屋ご案内させて頂きます！！\n\n" +
    "エスリード弁天町パークプレイスにつきましては9月30日退去予定のお部屋となりますので10月1日以降ご内覧可能です😌！！",
  );
  expect(r.hasVacating).toBe(true);
  expect(r.unreadable.length).toBe(0);
});

it("内覧できるのは退去日の翌日（黄金ルール）。「9月末」「9月下旬」も翌日の扱いに揃う", () => {
  const one = (vac: string) => buildViewingGuideText([{ name: "A", vacateDate: vac }], "はる", NOW).text;
  expect(one("9月30日")).toContain("10月1日以降ご内覧可能");
  expect(one("9月27日")).toContain("9月28日以降ご内覧可能");
  expect(one("9月末")).toContain("10月1日以降ご内覧可能");
  // 退去日そのものを解禁日にしない（旧実装のバグ）
  expect(one("9月27日")).notToContain("9月27日以降ご内覧可能");
});

it("空室が複数なら「と」でつなぐ・全部空室なら退去予定の段落は出ない", () => {
  const r = buildViewingGuideText([
    { name: "A", roomNumber: "101" },
    { name: "B", roomNumber: "202" },
  ], "はるさん", NOW);
  expect(r.text).toContain("A 101号室とB 202号室は空室ですので");
  expect(r.text).notToContain("退去予定");
  expect(r.hasVacating).toBe(false);
});

it("退去日が入っているのに読めない物件は本文に混ぜず unreadable で返す", () => {
  const r = buildViewingGuideText([
    { name: "A", roomNumber: "101" },
    { name: "B", vacateDate: "たぶん来月あたり" },
  ], "はる", NOW);
  expect(r.unreadable.length).toBe(1);
  expect(r.unreadable[0]).toBe("B");
  expect(r.text).notToContain("B");        // 曖昧な日付のまま送らない
  expect(r.text).toContain("A 101号室は空室ですので");
});

it("物件が無い時は日程だけ聞く（従来の形）・敬称は重ねない", () => {
  const r = buildViewingGuideText([], "はるさん", NOW);
  expect(r.text).toContain("はるさんご都合よろしいお日にちにご案内させて頂きます😊！！");
  expect(r.text).notToContain("はるさんさん");
  expect(buildViewingGuideText([], null, NOW).text).toContain("お客様ご都合");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.join("\n")); process.exit(1); }
