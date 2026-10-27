// 1000行ずつ回して読む（app/lib/read-all-rows.ts）— 作り物の問い合わせ・DB なし
// 実行: npx tsx app/lib/__tests__/read-all-rows.test.ts（全 PASS で exit 0）
import { readRowsUpTo, readAllRowsEnabled } from "../read-all-rows";

let passed = 0, failed = 0;
async function it(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

/** 本番と同じく1回 1000行で切る作り物の表（rows 行） */
const table = (rows: number) => {
  const calls: Array<[number, number, boolean]> = [];
  const mk = (from: number, to: number, paged: boolean) => {
    calls.push([from, to, paged]);
    const end = Math.min(rows - 1, to, from + 999);
    const data = from > end ? [] : Array.from({ length: end - from + 1 }, (_, i) => from + i);
    return Promise.resolve({ data, error: null });
  };
  return { mk, calls };
};

(async () => {
  console.log("read-all-rows");
  await it("切替は既定 off", () => { eq(readAllRowsEnabled({}), false); eq(readAllRowsEnabled({ READ_ALL_ROWS: "on" }), true); });
  await it("off は1回だけ（本番は 1000行で切れる＝今まで通り）", async () => {
    const t = table(3455);
    const r = await readRowsUpTo<number>(t.mk, 8000, false);
    eq(r.data.length, 1000); eq(t.calls, [[0, 7999, false]]);
  });
  await it("on は 1000行ずつ最後まで", async () => {
    const t = table(3455);
    const r = await readRowsUpTo<number>(t.mk, 8000, true);
    eq(r.data.length, 3455); eq(r.pages, 4); eq(r.truncated, false); eq(r.data[3454], 3454);
  });
  await it("on でも max で止める（truncated）", async () => {
    const t = table(9275);
    const r = await readRowsUpTo<number>(t.mk, 2500, true);
    eq(r.data.length, 2500); eq(r.truncated, true); eq(t.calls.map((c) => c[1]), [999, 1999, 2499]);
  });
  await it("ちょうど 1000行の時はもう1回読んで終わる", async () => {
    const t = table(1000);
    const r = await readRowsUpTo<number>(t.mk, 5000, true);
    eq(r.data.length, 1000); eq(r.pages, 2);
  });
  await it("エラーはそこまでの行と一緒に返す", async () => {
    let n = 0;
    const r = await readRowsUpTo<number>(() => Promise.resolve(n++ === 0 ? { data: Array(1000).fill(1), error: null } : { data: null, error: { message: "timeout" } }), 5000, true);
    eq(r.data.length, 1000); eq(r.error?.message, "timeout");
  });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
