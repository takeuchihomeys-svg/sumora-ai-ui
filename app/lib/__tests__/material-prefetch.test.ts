// 2026-11-27 作業員L: ブレインの材料の読みを先に始めて並べて待つ（app/lib/material-prefetch.ts・BRAIN_MATERIAL_PARALLEL・既定 off）
// 実行: npx tsx app/lib/__tests__/material-prefetch.test.ts
import assert from "node:assert/strict";
import { createMaterialPrefetch, makeLimiter, materialParallelMax } from "../material-prefetch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function main() {
  assert.equal(materialParallelMax({}), 4); assert.equal(materialParallelMax({ BRAIN_MATERIAL_PARALLEL_MAX: "2" }), 2); assert.equal(materialParallelMax({ BRAIN_MATERIAL_PARALLEL_MAX: "99" }), 8);

  // off: 登録だけ・置き場で初めて呼ぶ（今まで通り）
  { let calls = 0; const p = createMaterialPrefetch(false); p.register("a", async () => { calls++; return 1; }); assert.equal(calls, 0, "off は登録で呼ばない"); assert.equal(await p.take<number>("a"), 1); assert.equal(calls, 1); }
  // on: 登録で先に始め、置き場で同じ答え・2回呼ばない
  { let calls = 0; const p = createMaterialPrefetch(true); p.register("a", async () => { calls++; await sleep(10); return "x"; }); assert.equal(await p.take<string>("a"), "x"); assert.equal(calls, 1, "on でも1回だけ"); }
  // on: guard が false の読みは先に始めない（置き場で今まで通り）
  { let calls = 0; const p = createMaterialPrefetch(true); p.register("a", async () => { calls++; return 2; }, false); await sleep(5); assert.equal(calls, 0); assert.equal(await p.take<number>("a"), 2); assert.equal(calls, 1); }
  // 失敗は置き場で同じ例外（置き場の try/catch がそのまま効く）
  for (const on of [false, true]) { const p = createMaterialPrefetch(on); p.register("e", async () => { throw new Error("読めない"); }); await sleep(1); await assert.rejects(p.take("e"), /読めない/); }
  // 答えは on と off で同じ・置き場の順に足せば並びも同じ
  {
    const jobs: Array<[string, number, string]> = [["a", 30, "A"], ["b", 5, "B"], ["c", 15, "C"], ["d", 1, "D"], ["e", 20, "E"]];
    const build = async (on: boolean) => { const p = createMaterialPrefetch(on, 2); for (const [k, ms, v] of jobs) p.register(k, async () => { await sleep(ms); return v; }); let s = ""; for (const [k] of jobs) s += `【${await p.take<string>(k)}】`; return s; };
    const off = await build(false), on = await build(true);
    assert.equal(on, off, "on と off で材料の文字が同じ（並べた順も置き場の順）");
    assert.equal(on, "【A】【B】【C】【D】【E】");
  }
  // 上限: 同時に走るのは max まで
  {
    const lim = makeLimiter(3); let running = 0, peak = 0;
    await Promise.all(Array.from({ length: 10 }, () => lim(async () => { running++; peak = Math.max(peak, running); await sleep(5); running--; })));
    assert.equal(peak, 3, "同時に走るのは上限まで");
  }
  // 並べると待ちが重なる（材料の区間が短くなる）
  {
    const t = async (on: boolean) => { const p = createMaterialPrefetch(on, 4); for (const k of ["a", "b", "c", "d"]) p.register(k, async () => { await sleep(40); return k; }); const t0 = Date.now(); for (const k of ["a", "b", "c", "d"]) await p.take(k); return Date.now() - t0; };
    const off = await t(false), on = await t(true);
    assert.ok(off >= 150 && on < 100, `off ${off}ms・on ${on}ms`);
  }
  // 登録していない読みは止める（書き間違いを黙って通さない）
  await assert.rejects(createMaterialPrefetch(true).take("無い"), /登録されていない/);
  // 8秒の待ちの間に先に始めた読み: 一番新しい通が同じで新しい時だけ受け取る・受け取りは1回・違えば捨てて読み直す
  {
    const { earlyStart, adoptEarly } = await import("../material-prefetch");
    let calls = 0; const job = { a: async () => { calls++; return "早い"; } };
    earlyStart("c1", "2026-11-27T03:00:00Z", job, 4, 1000);
    assert.equal(adoptEarly("c1", "2026-11-27T03:00:09Z", 2000), null, "待ちの間に新しい通が来たら捨てる");
    assert.equal(adoptEarly("c1", "2026-11-27T03:00:00Z", 2000), null, "捨てた後は残らない（受け取りは1回）");
    earlyStart("c2", "t", job, 4, 1000);
    assert.equal(adoptEarly("c2", "t", 1000 + 61_000), null, "60秒より古ければ捨てる");
    earlyStart("c3", "t", job, 4, 1000);
    const got = adoptEarly("c3", "t", 5000); assert.ok(got);
    const p = createMaterialPrefetch(true, 4, got);
    let lateCalls = 0; p.register("a", async () => { lateCalls++; return "遅い"; });
    assert.equal(await p.take<string>("a"), "早い", "受け取った読みを使う（同じ関数の答え）"); assert.equal(lateCalls, 0, "読み直さない");
    const q = createMaterialPrefetch(true, 4, null); q.register("a", async () => "読み直し"); assert.equal(await q.take<string>("a"), "読み直し", "受け取れない時は今まで通り読む");
    assert.equal(adoptEarly(null, "t"), null);
    void calls;
  }
  console.log("material-prefetch ok 21");
}
main().catch((e) => { console.error(e); process.exit(1); });
