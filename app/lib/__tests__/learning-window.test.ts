// 2026-10-08 竹内さんの決定の2「毎週の学習の窓を 30日に広げる」（learning-window.ts）
// 件数は本番の実数（10/08 に数えた: weekly-learning の修正差分 新しい7日 40・前の23日 155／AIX の線引き 捨てた AIX 新しい7日 268・前の23日 606）
// 実行: npx tsx app/lib/__tests__/learning-window.test.ts
import {
  learningWindow, learningWindowOff, isRecent, recencyWeight, weightedCount, recurrenceThreshold, meetsRecurrence,
  equivalentCount, splitByRecency, pickRecentFirst, recencyTag, windowCountsLabel, weightingInstruction,
} from "../learning-window";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

const NOW = Date.parse("2026-10-12T03:00:00Z"); // 月曜 JST 12:00（weekly-learning chunk=1）
const D = 24 * 3600 * 1000;
const ago = (days: number) => new Date(NOW - days * D).toISOString();
const w30 = learningWindow("weekly-learning", 7, { now: NOW, env: {} });
const wOff = learningWindow("weekly-learning", 7, { now: NOW, env: { LEARNING_WINDOW_30D: "off" } });

it("既定は 30日・新しい7日", () => { eq(w30.legacy, false); eq(w30.days, 30); eq(w30.recentDays, 7); eq(w30.sinceIso, ago(30)); eq(w30.recentSinceIso, ago(7)); });
it("LEARNING_WINDOW_30D=off で旧の窓（7日・分けない）", () => { eq(wOff.legacy, true); eq(wOff.days, 7); eq(wOff.recentDays, 7); });
it("14日の cron も off で 14日に戻る", () => { const w = learningWindow("auto-star-winners", 14, { now: NOW, env: { LEARNING_WINDOW_30D: "off" } }); eq([w.legacy, w.days], [true, 14]); });
it("名前を並べた cron だけ旧の窓", () => {
  const env = { LEARNING_WINDOW_30D: "auto-star-winners, weekly-learning" };
  eq(learningWindowOff("weekly-learning", env), true);
  eq(learningWindowOff("aix-weekly-learning", env), false);
});
it("LEARNING_WINDOW_DAYS=7 は旧の窓（14日の cron は 14日）", () => {
  eq(learningWindow("weekly-learning", 7, { now: NOW, env: { LEARNING_WINDOW_DAYS: "7" } }).legacy, true);
  const w = learningWindow("auto-analyze-losers", 14, { now: NOW, env: { LEARNING_WINDOW_DAYS: "7" } });
  eq([w.legacy, w.days], [true, 14]);
});
it("LEARNING_WINDOW_DAYS=45 は 45日（上限90）", () => {
  eq(learningWindow("weekly-learning", 7, { now: NOW, env: { LEARNING_WINDOW_DAYS: "45" } }).days, 45);
  eq(learningWindow("weekly-learning", 7, { now: NOW, env: { LEARNING_WINDOW_DAYS: "400" } }).days, 90);
  eq(learningWindow("weekly-learning", 7, { now: NOW, env: { LEARNING_WINDOW_DAYS: "abc" } }).days, 30);
});

it("新しい7日=2点・前の23日=1点・時刻なしは前", () => {
  eq(recencyWeight(w30, ago(1)), 2); eq(recencyWeight(w30, ago(6.9)), 2); eq(recencyWeight(w30, ago(7.1)), 1);
  eq(isRecent(w30, null), false);
  eq(weightedCount(w30, [ago(1), ago(2), ago(10)]), 5);
});
it("旧の窓では窓の中は全部新しい（重み2＝旧の数え方と同じ）", () => eq(weightedCount(wOff, [ago(1), ago(6)]), 4));

it("くり返しの線 2N−1: 旧「2件以上」→3点・旧「3件以上」→5点", () => { eq(recurrenceThreshold(2), 3); eq(recurrenceThreshold(3), 5); });
it("旧「新しい2件以上」: 新1件だけは通らない・新2件／新1＋前1／前3件は通る・前2件は通らない", () => {
  eq(meetsRecurrence(w30, [ago(1)], 2), false);
  eq(meetsRecurrence(w30, [ago(1), ago(2)], 2), true);
  eq(meetsRecurrence(w30, [ago(1), ago(20)], 2), true);
  eq(meetsRecurrence(w30, [ago(10), ago(20), ago(25)], 2), true);
  eq(meetsRecurrence(w30, [ago(10), ago(20)], 2), false);
});
it("旧の窓では meetsRecurrence＝件数 >= N（旧の `< 2` で止める形と同じ）", () => {
  eq(meetsRecurrence(wOff, [ago(1)], 2), false);
  eq(meetsRecurrence(wOff, [ago(1), ago(2)], 2), true);
  eq(meetsRecurrence(wOff, [ago(1), ago(2)], 3), false);
  eq(meetsRecurrence(wOff, [ago(1), ago(2), ago(3)], 3), true);
});

it("ならした件数: 同じ頻度なら旧の 14日の件数と同じ所で鳴る", () => {
  // 旧（14日）: 4.67日に1件＝14日で3件。新（30日）: 新しい7日 1.5件・前の23日 4.93件 → 重み 7.93 → 14日にならすと 3.0
  const times: string[] = [];
  for (let d = 0.5; d < 30; d += 14 / 3) times.push(ago(d));
  const w = learningWindow("aix-weekly-learning", 14, { now: NOW, env: {} });
  const eqv = equivalentCount(w, times, 14);
  if (Math.abs(eqv - 3) > 0.6) throw new Error(`eqv=${eqv}`);
  const wl = learningWindow("aix-weekly-learning", 14, { now: NOW, env: { LEARNING_WINDOW_30D: "off" } });
  eq(equivalentCount(wl, [ago(1), ago(5), ago(13)], 14), 3);
});
it("ならした件数: 新しい7日の物は前の23日の物の2倍に数える（鮮度）", () => {
  const w = learningWindow("aix-weekly-learning", 14, { now: NOW, env: {} });
  // 新しい7日に2件だけ: 旧の14日では2件で線(3)に届かない。新では 4×14/37=1.5（届かない）→ 新しい7日に4件で 8×14/37=3.03（届く）
  eq(equivalentCount(w, [ago(1), ago(2)], 14) >= 3, false);
  eq(equivalentCount(w, [ago(1), ago(2), ago(3), ago(4)], 14) >= 3, true);
  // 前の23日に4件だけ: 4×14/37=1.5 → 届かない（古い物だけでは鳴りにくい）
  eq(equivalentCount(w, [ago(10), ago(15), ago(20), ago(25)], 14) >= 3, false);
});

it("分ける: 窓の外は捨てる", () => {
  const rows = [{ t: ago(1) }, { t: ago(8) }, { t: ago(29) }, { t: ago(31) }];
  const s = splitByRecency(w30, rows, (r) => r.t);
  eq([s.recent.length, s.older.length], [1, 2]);
});

type Row = { id: number; t: string; star?: boolean };
// 本番の形: 新しい7日 40件・前の23日 155件（weekly-learning の修正差分 10/08）
const rows: Row[] = [
  ...Array.from({ length: 40 }, (_, i) => ({ id: i, t: ago(0.1 + i * 0.17) })),
  ...Array.from({ length: 155 }, (_, i) => ({ id: 100 + i, t: ago(7.1 + i * 0.148), star: i === 77 })),
];
it("選ぶ: 新しい7日は渡された順で上限まで・前の23日は上限つき（40＋20）", () => {
  const p = pickRecentFirst(w30, rows, (r) => r.t, { recentMax: 40, olderMax: 20 });
  eq(p.length, 60);
  eq(p.slice(0, 40).map((r) => r.id), rows.slice(0, 40).map((r) => r.id));
  eq(p.slice(40).every((r) => r.id >= 100), true);
});
it("選ぶ: 前の23日は prefer（⭐）が先・残りは23日の中で偏らない（最古と最新を含む）", () => {
  const p = pickRecentFirst(w30, rows, (r) => r.t, { recentMax: 40, olderMax: 20, prefer: (r) => !!r.star });
  const older = p.slice(40);
  eq(older[0].id, 177);
  const ids = older.map((r) => r.id);
  eq(ids.includes(254), true, "最古"); eq(ids.includes(100), true, "最新");
  eq(new Set(ids).size, ids.length, "重複なし");
});
it("選ぶ: 新しい物が少ない時も前の23日は olderMax まで（新しい物の空きで増やさない＝費用の上限）", () => {
  const few = [...rows.slice(0, 3), ...rows.slice(40)];
  eq(pickRecentFirst(w30, few, (r) => r.t, { recentMax: 40, olderMax: 20 }).length, 23);
});
it("選ぶ: 旧の窓では recentMax 件だけ（旧と同じ）", () => {
  const legacyRows = rows.filter((r) => Date.parse(r.t) >= NOW - 7 * D);
  eq(pickRecentFirst(wOff, legacyRows, (r) => r.t, { recentMax: 15, olderMax: 8 }).map((r) => r.id), legacyRows.slice(0, 15).map((r) => r.id));
});

it("札と見出し", () => {
  eq(recencyTag(w30, ago(1)), "【新しい7日】");
  eq(recencyTag(w30, ago(9)), "【前の23日】");
  eq(recencyTag(wOff, ago(1)), "");
  eq(windowCountsLabel(w30, 40, 20), "直近30日（新しい7日 40件・前の23日 20件）");
  eq(windowCountsLabel(wOff, 40, 0), "直近7日");
});
it("指示: 旧の窓では空・新では 2点/1点 と線（2N−1）を書く", () => {
  eq(weightingInstruction(wOff, 2), "");
  const s = weightingInstruction(w30, 2);
  if (!/2点/.test(s) || !/1点/.test(s) || !/合計3点以上/.test(s)) throw new Error(s);
  if (!/合計5点以上/.test(weightingInstruction(w30, 3))) throw new Error("3件→5点");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.join("\n")); process.exit(1); }
