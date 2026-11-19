// 拡張の動きの学習の書き込みを重なった時だけ間を空けて少しずつ（2026-11-18 作業員H・HUMAN_MOTION_PACE・既定 on）
// 実行: npx tsx app/lib/__tests__/human-motion-pacer.test.ts
import { humanMotionPaceOn, BurstMeter, PacedWriter } from "../human-motion-pacer";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
(async () => {
  t("既定 on・=off で止める", humanMotionPaceOn({}) && !humanMotionPaceOn({ HUMAN_MOTION_PACE: "off" }));
  const m = new BurstMeter(10_000, 8);
  const hits = Array.from({ length: 10 }, (_, i) => m.hit(1000 + i * 100));
  t("10秒に8回までは重なりでない・9回目から重なり", hits.slice(0, 8).every((x) => !x) && hits[8] && hits[9], hits);
  t("窓を過ぎれば戻る", !new BurstMeter(10_000, 8).hit(0) && (() => { const b = new BurstMeter(10_000, 2); b.hit(0); b.hit(1); b.hit(2); return !b.hit(20_000); })());
  // まとめて書く: 60行 → 25・25・10 の3回・間に待ち
  const batches: number[] = [], ones: number[] = [], sleeps: number[] = [];
  const w = new PacedWriter<number>({ insertMany: async (rows) => { batches.push(rows.length); return { error: null }; }, insertOne: async (r) => { ones.push(r); }, sleep: async (ms) => { sleeps.push(ms); }, batch: 25, gapMs: 1500 });
  let p: Promise<void> | null = null;
  for (let i = 0; i < 60; i++) p = w.push(i);
  await p;
  t("60行を 25・25・10 でまとめて書く（行ごとに書かない）", JSON.stringify(batches) === "[25,25,10]" && ones.length === 0, batches);
  t("束の間を空ける", sleeps.length === 3 && sleeps.every((x) => x === 1500), sleeps);
  t("書き終わると溜まりは0", w.pending === 0);
  // まとめて書けない時（無い列）は1行ずつ（落とさない）
  const ones2: number[] = [];
  const w2 = new PacedWriter<number>({ insertMany: async () => ({ error: { message: "column \"opens\" does not exist", code: "42703" } }), insertOne: async (r) => { ones2.push(r); }, sleep: async () => {}, batch: 25 });
  let p2: Promise<void> | null = null;
  for (let i = 0; i < 3; i++) p2 = w2.push(i);
  await p2;
  t("まとめて書けない時は1行ずつ全部書く", JSON.stringify(ones2) === "[0,1,2]", ones2);
  console.log(`\n${pass} OK / ${fail} NG`);
  if (fail) process.exit(1);
})();
