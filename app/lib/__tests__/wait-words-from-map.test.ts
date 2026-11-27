/**
 * 待ちの言葉（ボックスの「⏳ 何を待っているか（あと N 秒）」）が流れの地図から作られているか（2.8.325・竹内さん 2026-11-27）。
 *   ・地図の待ち（LOOP_WAITS）は、どの手にあるか・言葉・秒数が正しい（checkWaits）
 *   ・拡張の WAIT_WORDS（bulk-dl.js）は地図と同じ（生成部分が古くない）
 *   ・言葉は生成部分の外に手で書いていない（ラベルの重複を止める）
 *   ・各待ちは拡張のコードで実際に使われている（地図に書いただけの待ちを止める）
 *   ・悪い地図（重なり・手が無い・言葉が空・秒数が逆）を止める自己点検
 * npx tsx app/lib/__tests__/wait-words-from-map.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOOP_WAITS, checkWaits, renderWaitWordsJs, type FlowWait } from "../loop-flow-map";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
}
const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

console.log("■ 今の地図の待ちは正しい");
{
  const bad = checkWaits();
  assert(bad.length === 0, "地図の待ちに問題: " + bad.join(" / "));
  // 2.8.328: 見えないタブで押さずに待つ（reset_hidden・最大10分）を足した
  assert(LOOP_WAITS.length === 9, "待ちは9つ（検索後・押したあと・読み直しあと・リセット後・見えるまで・保険の60〜90秒・20秒の3つ）");
  console.log("  ✓ 9つの待ち・どの手にあるか・言葉・秒数が正しい");
}

console.log("■ 拡張の WAIT_WORDS は地図と同じ（生成部分が古くない）");
{
  const dl = read("chrome-extension/bulk-dl.js");
  const m = dl.match(/\/\* WAIT_WORDS:BEGIN \*\/\n([\s\S]*?)\n\s*\/\* WAIT_WORDS:END \*\//);
  assert(!!m, "bulk-dl.js に WAIT_WORDS の目印");
  assert(m![1] === renderWaitWordsJs("WAIT_WORDS"), "bulk-dl.js の WAIT_WORDS が地図と違う（npx tsx scripts/gen-panel-words.ts）");
  console.log("  ✓ 地図と同じ");
}

console.log("■ 言葉は生成部分の外に手で書いていない");
{
  const dl = read("chrome-extension/bulk-dl.js").replace(/\/\* WAIT_WORDS:BEGIN \*\/[\s\S]*?\/\* WAIT_WORDS:END \*\//, "");
  for (const w of LOOP_WAITS) {
    assert(!dl.includes(w.label), `bulk-dl.js に「${w.label.slice(0, 16)}…」を手で書いている（地図の LOOP_WAITS から引く）`);
  }
  console.log("  ✓ 手書きの言葉なし");
}

console.log("■ 各待ちは拡張のコードで使われている（地図に書いただけを止める）");
{
  const dl = read("chrome-extension/bulk-dl.js");
  const bg = read("chrome-extension/background.js");
  const used: Record<string, boolean> = {
    search_to_sort: /_setBulkWaitById\("search_to_sort", wait\)/.test(dl),
    sort_lag: /_setBulkWaitById\("sort_lag", 1200 \+ _lagG\)/.test(dl),
    sort_resume_lag: /_setBulkWaitById\("sort_resume_lag", _lagR\)/.test(dl),
    // リセット後の待ちは background が id を送る（言葉は bulk-dl の WAIT_WORDS）
    reset_settle: /_bulkWaitShow\("reset_settle", _settleMs\)/.test(bg) && /msg\.type === "axlx-bulk-wait"/.test(dl),
    reset_insure: /_bulkWaitShow\("reset_insure", _insureMs\)/.test(bg) && /msg\.type === "axlx-bulk-wait"/.test(dl),
    // 2.8.328: 見えないタブで押さずに待つ（_waitRealproVisible が id で枠を出す）
    reset_hidden: /_bulkWaitShow\("reset_hidden", RESET_HIDDEN_WAIT_MAX_MS\)/.test(bg),
    // 2.8.328: 完了の20秒あけ（_gapBeforeNext が id で枠を出す）
    reset_gap: /_gapBeforeNext\(customerId, auditRunId, "reset_gap", 20000\)/.test(bg),
    reset_done_gap: /_gapBeforeNext\(customerId, auditRunId, "reset_done_gap", 20000\)/.test(bg),
    api_reload_gap: /_gapBeforeNext\(customer && customer\.id, null, "api_reload_gap", 20000\)/.test(bg),
  };
  for (const w of LOOP_WAITS) assert(used[w.id] === true, `待ち ${w.id} がコードで使われていない（地図に書いただけ）`);
  console.log("  ✓ 9つとも配線されている");
}

console.log("■ 悪い地図を止める（自己点検）");
{
  const good: FlowWait[] = JSON.parse(JSON.stringify(LOOP_WAITS));
  const dup = [...good, { ...good[0] }];
  assert(checkWaits(dup).some((m) => /重なっている/.test(m)), "同じ id の待ちを止める");
  const noNode = good.map((w, i) => (i === 0 ? { ...w, nodeId: "no_such" } : w));
  assert(checkWaits(noNode).some((m) => /が地図に無い/.test(m)), "どの手か分からない待ちを止める");
  const empty = good.map((w, i) => (i === 1 ? { ...w, label: "  " } : w));
  assert(checkWaits(empty).some((m) => /言葉（label）が無い/.test(m)), "言葉が空の待ちを止める");
  const rev = good.map((w, i) => (i === 2 ? { ...w, minMs: 9000, maxMs: 1000 } : w));
  assert(checkWaits(rev).some((m) => /秒数が正しくない/.test(m)), "秒数が逆の待ちを止める");
  console.log("  ✓ 4つの悪い形を止める");
}

console.log("wait-words-from-map.test OK");
