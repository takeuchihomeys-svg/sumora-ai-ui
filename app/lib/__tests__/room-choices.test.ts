// 2026-09-16 竹内（カイナ事例）: 申込のお部屋が決まっていない時の候補の号室
// 実行: npx tsx app/lib/__tests__/room-choices.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { parseRoomChoices, shouldAskRoomChoice, roomChoiceNote } from "../room-choices";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

it("カイナ: 「1303・906・506」→ 3部屋（実送信の (1303号室・906号室・506号室) と同じ）", () => {
  const r = parseRoomChoices("1303・906・506");
  expect(r.join("・")).toBe("1303号室・906号室・506号室");
  expect(shouldAskRoomChoice(r)).toBe(true);
  expect(roomChoiceNote(r)).toBe("件数: 3部屋\n号室: 1303号室・906号室・506号室");
});
it("号室が付いていてもそのまま・区切りは 読点/カンマ/スラッシュ/空白 も通す", () => {
  expect(parseRoomChoices("1303号室, 906号室").join("・")).toBe("1303号室・906号室");
  expect(parseRoomChoices("205、301 402/503").join("・")).toBe("205号室・301号室・402号室・503号室");
  expect(parseRoomChoices("１３０３・９０６").join("・")).toBe("1303号室・906号室");
});
it("「部屋」「室」の表記ゆれ・英数字の部屋番号も揃える", () => {
  expect(parseRoomChoices("A101・B202室・303部屋").join("・")).toBe("A101号室・B202号室・303号室");
});
it("同じ号室は1つにまとめる・空や記号だけは落とす", () => {
  expect(parseRoomChoices("1303・1303・906").join("・")).toBe("1303号室・906号室");
  expect(parseRoomChoices("　・、").length).toBe(0);
  expect(parseRoomChoices("").length).toBe(0);
  expect(parseRoomChoices(null).length).toBe(0);
});
it("号室ではない文字列（物件名・階数の説明）は号室にしない", () => {
  expect(parseRoomChoices("アーバンフラッツ心斎橋").length).toBe(0);
  expect(parseRoomChoices("3部屋の中から").length).toBe(0);
});
it("候補が1つなら聞かない（決まっているのと同じ）", () => {
  expect(shouldAskRoomChoice(parseRoomChoices("1303"))).toBe(false);
  expect(shouldAskRoomChoice([])).toBe(false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
