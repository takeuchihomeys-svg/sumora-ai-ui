// 2026-11-10 作業員8: kb-eval の先引き（まとめて埋め込み・同時に数本の RPC）の純関数
// 実行: npx tsx scripts/lib/__tests__/kb-eval-prefetch.test.ts（env 不要・全 OK で exit 0）
import { prefetchQueries, mapLimit } from "../kb-eval-prefetch";

let passed = 0, failed = 0;
function t(name: string, cond: boolean, extra?: unknown) {
  if (cond) { passed++; console.log("  OK  " + name); } else { failed++; console.log("  NG  " + name + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 300) : "")); }
}

(async () => {
  const have = new Set(["既に"]);
  const q = prefetchQueries(["a", "b", "a", "", "既に", "c"], have);
  t("重複・空・既にある問いを除き、順番は入力のまま", JSON.stringify(q) === JSON.stringify(["a", "b", "c"]), q);

  let running = 0, peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3, 0, 6], 3, async (ms, i) => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, ms * 3));
    running--; return i * 10;
  });
  t("同時は n 本まで", peak <= 3 && peak >= 2, peak);
  t("返す順は入力の順", JSON.stringify(out) === JSON.stringify([0, 10, 20, 30, 40, 50, 60]), out);
  t("空の配列でも止まらない", (await mapLimit([], 4, async () => 1)).length === 0);

  console.log(`\n${passed} OK / ${failed} NG`);
  process.exit(failed ? 1 : 0);
})();
