// 複数画像をまとめて送る区切り方（2026-09-22 竹内「公式LINEから送るような形で横並びに」）
// 実行: npx tsx app/lib/__tests__/line-image-batch.test.ts（全 PASS で exit 0）
import { buildImageBatchPushes, LINE_PUSH_MAX_MESSAGES, IMAGE_BATCH_MAX } from "../line-image-batch";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}
const U = (i: number) => `https://example.supabase.co/storage/v1/object/public/property-images/aix/c/${i}.jpeg`;

it("★★ 物件資料＋見積書の2枚は1回の送信にまとめる（画像が先）", () => {
  const r = buildImageBatchPushes([U(1), U(2)]);
  if (!r.ok) throw new Error(r.error);
  expect(r.pushes.length).toBe(1);
  expect(r.pushes[0].length).toBe(2);
  expect((r.pushes[0][0] as { type: string }).type).toBe("image");
});
it("★★ 10枚は 5＋5 の2回（LINE の1回の上限は5通）", () => {
  const r = buildImageBatchPushes(Array.from({ length: 10 }, (_, i) => U(i)));
  if (!r.ok) throw new Error(r.error);
  expect(r.pushes.length).toBe(2);
  expect(r.pushes[0].length).toBe(LINE_PUSH_MAX_MESSAGES);
  expect(r.pushes[1].length).toBe(5);
});
it("★ 本文は画像の後。入るなら最後の塊に入れる（2枚＋本文＝1回）", () => {
  const r = buildImageBatchPushes([U(1), U(2)], "募集状況確認させて頂きました！！");
  if (!r.ok) throw new Error(r.error);
  expect(r.pushes.length).toBe(1);
  expect((r.pushes[0][2] as { type: string }).type).toBe("text");
});
it("★ 5枚＋本文は本文だけ次の回", () => {
  const r = buildImageBatchPushes([U(1), U(2), U(3), U(4), U(5)], "ご査収ください");
  if (!r.ok) throw new Error(r.error);
  expect(r.pushes.length).toBe(2);
  expect(r.pushes[1].length).toBe(1);
});
it("★★ 上限（10枚）を超えたら黙って削らず error", () => {
  const r = buildImageBatchPushes(Array.from({ length: IMAGE_BATCH_MAX + 1 }, (_, i) => U(i)));
  expect(r.ok).toBe(false);
});
it("★ https でない URL（blob: 等）は error（LINE が受け付けない）", () => {
  expect(buildImageBatchPushes([U(1), "blob:http://localhost/abc"]).ok).toBe(false);
});
it("画像が無ければ error", () => {
  expect(buildImageBatchPushes([]).ok).toBe(false);
  expect(buildImageBatchPushes(["", "  "]).ok).toBe(false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
