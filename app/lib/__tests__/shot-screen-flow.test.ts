/** 写真から学ぶ（画面ごとの仕組み）の試験 — 2026-11-13 */
// 竹内さん「録画した画像もみて押し方や仕組みなども学習おねがい。抜けている部分徹底的に学習できるように」
//
// 実行: npx tsx app/lib/__tests__/shot-screen-flow.test.ts
import { screenOf, learnFromShots, cleanFields } from "../shot-learn";
import { buildHumanLearnBundle, compactBundle } from "../human-learn-brain";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(c: boolean, label: string) { if (!c) throw new Error(label); }

const mk = (ops: string[], extra: Record<string, unknown> = {}) => ({
  created_at: new Date().toISOString(),
  site: "realpro",
  shot_taken: true,
  shot_ops: ops.map((f) => ({ f, k: "click" })),
  ...extra,
});

console.log("=== ① 画面の種類を判定する（URL が無くても）");
it("URL が結果ページなら result", () => eq(screenOf({ url: "https://x/main.php?method=estate&display=building" }), "result"));
it("URL が入力なら form", () => eq(screenOf({ url: "https://x/main.php?method=estate" }), "form"));
it("所在地絞り込みの操作があれば modal", () => eq(screenOf({ ops: [{ f: "所在地絞り込み" }, { f: "区を選ぶ" }] }), "modal"));
it("沿線・駅絞り込みの操作があれば modal", () => eq(screenOf({ ops: [{ f: "沿線・駅絞り込み" }] }), "modal"));
it("確定してリストへ があれば modal", () => eq(screenOf({ ops: [{ f: "確定してリストへ" }] }), "modal"));
it("one_city を含む欄があれば modal", () => eq(screenOf({ fields: [{ name: "大阪市北区｜label.one_city" }] }), "modal"));
it("賃料・面積の欄があれば form", () => eq(screenOf({ ops: [{ f: "rental_cost1" }] }), "form"));
it("何も無ければ other", () => eq(screenOf({}), "other"));

console.log("=== ② 写真から「画面ごとの手順」を作る");
it("地域の手順が学べる", () => {
  const area = ["確定してリストへ", "所在地絞り込み", "区を選ぶ", "地域の設定へ進む", "町字を選ぶ", "確定してリストへ"];
  const r = learnFromShots([mk(area), mk(area)] as never);
  ok(!!r.screens.modal, "modal が無い");
  const pairs = r.screens.modal.steps.map((s) => `${s.from}→${s.to}`);
  ok(pairs.includes("所在地絞り込み→区を選ぶ"), pairs.join(","));
  ok(pairs.includes("町字を選ぶ→確定してリストへ"), pairs.join(","));
  eq(r.withOps, 2, "操作つきの枚数");
});
it("駅の手順が学べる", () => {
  const st = ["沿線・駅絞り込み", "沿線を選ぶ", "駅の設定へ進む", "確定してリストへ"];
  const r = learnFromShots([mk(st), mk(st)] as never);
  const pairs = r.screens.modal.steps.map((s) => `${s.from}→${s.to}`);
  ok(pairs.includes("沿線を選ぶ→駅の設定へ進む"), pairs.join(","));
  ok(pairs.includes("駅の設定へ進む→確定してリストへ"), pairs.join(","));
});
it("条件入力の手順も別に学べる", () => {
  const form = ["required_time", "rental_cost2", "square_meter_l", "rental_cost1", "structured_date"];
  const r = learnFromShots([mk(form), mk(form)] as never);
  ok(!!r.screens.form, "form が無い");
  const pairs = r.screens.form.steps.map((s) => `${s.from}→${s.to}`);
  ok(pairs.includes("required_time→rental_cost2"), pairs.join(","));
});
it("最後に押す物が分かる（小窓は 確定してリストへ）", () => {
  const area = ["所在地絞り込み", "区を選ぶ", "確定してリストへ"];
  const r = learnFromShots([mk(area), mk(area)] as never);
  eq(r.screens.modal.lastPressed[0].name, "確定してリストへ");
});
it("1回だけの組は採らない（偶然を学ばない）", () => {
  const r = learnFromShots([mk(["所在地絞り込み", "区を選ぶ"])] as never);
  eq(r.screens.modal.steps.length, 0, "1回の組");
});
it("操作が無い写真でも落ちない", () => {
  const r = learnFromShots([{ created_at: "x", shot_ops: [], site: "realpro" }] as never);
  eq(r.total, 1);
  eq(r.withOps, 0);
});
it("壊れた入力でも落ちない", () => {
  const r = learnFromShots([null, { shot_ops: "x" }, { shot_ops: [null, 1] }] as never);
  ok(r.total === 3, "total");
});

console.log("=== ③ 束に入り、人が読める行になる");
it("screen_flow と shots が入る", () => {
  const area = ["所在地絞り込み", "区を選ぶ", "確定してリストへ"];
  const b = compactBundle(buildHumanLearnBundle([mk(area), mk(area)] as never));
  ok(!!b.screen_flow, "screen_flow が無い");
  ok(!!b.screen_flow!.modal, "modal が無い");
  ok(!!b.shots && b.shots.total === 2, "shots");
});
it("人が読める行に「小窓（地域・駅）」が出る", () => {
  const area = ["所在地絞り込み", "区を選ぶ", "確定してリストへ"];
  const b = compactBundle(buildHumanLearnBundle([mk(area), mk(area)] as never));
  const s = b.lines.join("\n");
  ok(/写真から学んだ画面ごとの仕組み/.test(s), "見出しが無い");
  ok(/小窓（地域・駅）/.test(s), "小窓が出ない");
  ok(/所在地絞り込み → 区を選ぶ/.test(s), "順番が出ない");
});

console.log("=== ④ 中身（入力した値・お客様の情報）は入れない");
it("段の名前だけを持つ", () => {
  const area = ["所在地絞り込み", "区を選ぶ", "確定してリストへ"];
  const b = compactBundle(buildHumanLearnBundle([mk(area), mk(area)] as never));
  const s = JSON.stringify(b.screen_flow);
  ok(!/大阪市/.test(s), "区の名前が入っている");
  ok(!/value/.test(s), "入力値が入っている");
});
it("欄の種類だけを読む（中身は読まない）", () => {
  const f = cleanFields([{ name: "rental_cost1", kind: "select", value: "120000" }]);
  eq(f.length, 1);
  ok(!("value" in (f[0] as object)), "value が残っている");
});

console.log(`\n結果: 合格 ${passed} / 不合格 ${failed}`);
if (failed) { for (const f of failures) console.log("  ✗ " + f); process.exit(1); }
