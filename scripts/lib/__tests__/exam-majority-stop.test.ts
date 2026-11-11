// 過半数が決まった後の回・判定を呼ばない（2026-11-11 作業員8・exam-flake.majoritySettled / judgeMajoritySettled / majoritySigOfRow）
// 実行: npx tsx scripts/lib/__tests__/exam-majority-stop.test.ts（自己完結・LLM も DB も使わない。全 PASS で exit 0）
// 確かめる事: 決まったと言った時点で止めても、全部の回を回した時と過半数（perProblem の数え方＝回の数を分母にした過半数）が1つも変わらない
import { majoritySettled, judgeMajoritySettled, majoritySigOfRow, majorityEarlyStopOn, confirmJudgeMerge } from "../exam-flake";

let fail = 0, pass = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.error(`FAIL ${m}`); } };
const maj = (xs: boolean[]) => xs.filter(Boolean).length * 2 > xs.length;

// ① 回の過半数: 長さ N の全部の組み合わせ（7個の○✕の印のうち3種類の答え）で、止めた所までの過半数＝全部の過半数
{
  const kinds = [
    { score: { path: true, pass: true, primary: true }, asks: [{ covered: true, route: true }], ng: [] },
    { score: { path: true, pass: false, primary: false }, asks: [{ covered: false, route: true }], ng: [] },
    { score: { path: false, pass: false, primary: false }, asks: [{ covered: false, route: false }], ng: [{ violated: true }] },
  ];
  const bools = (r: (typeof kinds)[number]) => majoritySigOfRow(r).split(",").map((x) => x === "true");
  let cases = 0, stopped = 0;
  for (const N of [2, 3, 4, 5]) {
    const total = 3 ** N;
    for (let m = 0; m < total; m++) {
      const seq: number[] = []; let x = m; for (let i = 0; i < N; i++) { seq.push(x % 3); x = Math.floor(x / 3); }
      const rows = seq.map((k) => kinds[k]);
      let stop = N; const sigs: string[] = [];
      for (let k = 0; k < N; k++) { if (k >= 1 && majoritySettled(sigs, N)) { stop = k; break; } sigs.push(majoritySigOfRow(rows[k])); }
      if (stop < N) stopped++;
      const full = rows.map(bools), cut = rows.slice(0, stop).map(bools);
      for (let c = 0; c < full[0].length; c++) ok(maj(full.map((b) => b[c])) === maj(cut.map((b) => b[c])), `N=${N} seq=${seq.join("")} 列${c}: 止めると過半数が変わった`);
      cases++;
    }
  }
  ok(stopped > 0, "一度も止まらない（節約にならない）");
  console.log(`  回の過半数: ${cases}通りの並び・止めた ${stopped}`);
}

// ② 決まらない時は止めない
ok(!majoritySettled(["a"], 3), "1回だけで止めた");
ok(!majoritySettled(["a", "b"], 3), "割れているのに止めた");
ok(majoritySettled(["a", "a"], 3), "3回のうち2回同じなのに止めない");
ok(!majoritySettled(["a", "a"], 4), "4回のうち2回同じは決まっていない");
ok(majoritySettled(["a", "a", "a"], 4), "4回のうち3回同じなのに止めない");
ok(!majoritySettled(["a", "a"], 1), "1回の試験で止めた");

// ③ 判定の過半数: 項目ごと・本質の道
{
  type O = { asks: boolean[]; route: boolean[]; ng: boolean[]; rawPath: string | null };
  const mk = (a: number, r: number, g: number, p: number): O => ({ asks: [!!(a & 1), !!(a & 2)], route: [!!(r & 1), !!(r & 2)], ng: [!!(g & 1)], rawPath: ["返信", "2段:check", null][p] });
  const all: O[] = []; for (let a = 0; a < 4; a++) for (let r = 0; r < 4; r++) for (let g = 0; g < 2; g++) for (let p = 0; p < 3; p++) all.push(mk(a, r, g, p));
  const modeOf = (xs: Array<string | null>) => { const c = new Map<string | null, number>(); for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1); let best: string | null = null, n = 0; for (const [k, v] of c) if (v > n) { best = k; n = v; } return best; };
  const final = (os: O[]) => JSON.stringify({ a: [0, 1].map((i) => maj(os.map((o) => o.asks[i]))), r: [0, 1].map((i) => maj(os.map((o) => o.route[i]))), g: [maj(os.map((o) => o.ng[0]))], p: modeOf(os.map((o) => o.rawPath)) });
  let n = 0, st = 0;
  for (let t = 0; t < 4000; t++) {
    const R = 3; const os = Array.from({ length: R }, (_, i) => all[(t * 7919 + i * 104729 + (t % 13) * i) % all.length]);
    // 2つ同じ答えを多めに混ぜる（本物は大半が一致）
    if (t % 2) os[1] = os[0];
    const done: O[] = []; let stop = R;
    for (let k = 0; k < R; k++) { if (judgeMajoritySettled(done, R)) { stop = k; break; } done.push(os[k]); }
    if (stop < R) st++;
    ok(final(os) === final(os.slice(0, stop)), `判定: 止めると過半数が変わった ${final(os)} / ${final(os.slice(0, stop))}`);
    n++;
  }
  ok(st > 0, "判定が一度も止まらない");
  console.log(`  判定の過半数: ${n}通り・止めた ${st}`);
  ok(!judgeMajoritySettled([mk(1, 1, 0, 0)], 3), "判定1回で止めた");
  ok(!judgeMajoritySettled([mk(1, 1, 0, 0), mk(1, 1, 0, 1)], 3), "本質の道が割れているのに止めた");
  ok(judgeMajoritySettled([mk(3, 3, 1, 0), mk(3, 3, 1, 0)], 3), "同じ判定2回で止めない");
}

// ④ スイッチ
ok(majorityEarlyStopOn({}), "既定は on");
ok(!majorityEarlyStopOn({ EXAM_MAJORITY_EARLY_STOP: "off" }), "off で止まらない");

// ⑤ 印に下書き・主な依頼・厳しい道が入る
ok(majoritySigOfRow({ score: { path: true, pass: true }, draft: { pass: true } }) !== majoritySigOfRow({ score: { path: true, pass: true }, draft: { pass: false } }), "下書きの合否が印に入っていない");
ok(majoritySigOfRow({ score: { path: true, pass: true }, pathStrict: false }) !== majoritySigOfRow({ score: { path: true, pass: true }, pathStrict: true }), "厳しい道が印に入っていない");
ok(majoritySigOfRow({ score: { path: true, pass: true, primary: true } }) !== majoritySigOfRow({ score: { path: true, pass: true, primary: false } }), "主な依頼が印に入っていない");

// ⑥ 悪化の確かめ（confirmJudgeMerge）: 直す向きは ✕→○（依頼）・違反→守った（言ってはいけない事）だけ。全部の組み合わせで確かめる
{
  const bits = (n: number, k: number) => Array.from({ length: k }, (_, i) => !!(n & (1 << i)));
  let cases = 0, flips = 0;
  for (let s = 0; s < 8; s++) for (let v1 = 0; v1 < 8; v1++) for (let v2 = 0; v2 < 8; v2++) for (const nv of [1, 2, 3]) {
    const stored = { asks: bits(s, 1), route: bits(s >> 1, 1), ng: bits(s >> 2, 1) };
    const extra = [{ asks: bits(v1, 1), route: bits(v1 >> 1, 1), ng: bits(v1 >> 2, 1) }, { asks: bits(v2, 1), route: bits(v2 >> 1, 1), ng: bits(v2 >> 2, 1) }].slice(0, nv - 1);
    const votes = [stored, ...extra];
    const { merged, changed } = confirmJudgeMerge(stored, votes);
    cases++; if (changed) flips++;
    // ○は○のまま・守ったは守ったのまま（新しい悪化を作らない）
    ok(!(stored.asks[0] && !merged.asks[0]), "依頼の○を✕に変えた");
    ok(!(stored.route[0] && !merged.route[0]), "答え方の○を✕に変えた");
    ok(!(!stored.ng[0] && merged.ng[0]), "守ったを違反に変えた");
    // 変えたのは過半数が言った時だけ
    const maj = (xs: boolean[]) => xs.filter(Boolean).length * 2 > xs.length;
    if (!stored.asks[0] && merged.asks[0]) ok(maj(votes.map((v) => v.asks[0])), "過半数でないのに依頼を○にした");
    if (stored.ng[0] && !merged.ng[0]) ok(!maj(votes.map((v) => v.ng[0])), "過半数が違反なのに守ったにした");
    // 1回だけ（足した判定が無い）なら変えない
    if (nv === 1) ok(changed === 0, "判定を足していないのに変えた");
  }
  ok(flips > 0, "一度も直らない");
  console.log(`  悪化の確かめ: ${cases}通り・直した ${flips}`);
}

console.log(`${fail ? "FAIL" : "PASS"} ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
