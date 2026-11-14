// 録画の「一連の動き」から型を作る（2026-11-14）
//
// 竹内さん「画面録画したのみたら一連の動き学習できるからいまみてみて。設計知見と統括の部分」
//
// 実測（本番の録画18本から）:
//   確定してリストへ → required_time → rental_cost2 → 左の敷金・礼金なし → deposit_recommpence
//   → square_meter_l → rental_cost1 → structured_date → 左の1K｜label → room_layout_id[]
//   ＝ **条件の入力の一連の流れが1本の鎖になった**（これまでは1組ずつしか見えなかった）
//   ただし【地域（所在地）】のまとまりが空＝**地域の段が記録されていない**
//
// 実行: npx tsx app/lib/__tests__/learn-sequence.test.ts
import { learnSequenceFromShots } from "../shot-learn";
import { buildHumanLearnBundle, compactBundle } from "../human-learn-brain";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(c: boolean, label: string) { if (!c) throw new Error(label); }

const S = (names: string[]) => names.map((f) => ({ f }));

console.log("=== ① 一連の動きを1本の鎖にする");
{
  const seq = S(["所在地絞り込み", "区を選ぶ", "地域の設定へ進む", "町字を選ぶ", "確定してリストへ", "required_time", "rental_cost2", "square_meter_l"]);
  it("実際に押された順が鎖になる", () => {
    const r = learnSequenceFromShots([seq, seq], { min: 2 });
    eq(r.sequence, seq.map((x) => x.f));
  });
  it("サンプル数が分かる", () => {
    const r = learnSequenceFromShots([seq, seq, seq], { min: 2 });
    eq(r.samples, 3);
  });
  it("1本でも作れる（min に満たない組は锁に入れない）", () => {
    const r = learnSequenceFromShots([seq], { min: 2 });
    ok(r.samples === 1, "samples");
  });
}

console.log("=== ② 意味のあるまとまりに分ける");
{
  const seq = S(["所在地絞り込み", "区を選ぶ", "確定してリストへ", "沿線・駅絞り込み", "沿線を選ぶ", "駅の設定へ進む", "determine", "required_time", "rental_cost2", "左の検索｜span"]);
  it("地域・駅・条件・検索に分かれる", () => {
    const r = learnSequenceFromShots([seq, seq], { min: 2 });
    const names = r.groups.map((g) => g.name);
    ok(names.includes("地域（所在地）"), names.join(","));
    ok(names.includes("駅・沿線"), names.join(","));
    ok(names.includes("条件の入力"), names.join(","));
  });
  it("地域の中身が順番どおり", () => {
    const seq2 = S(["所在地絞り込み", "区を選ぶ", "地域の設定へ進む", "町字を選ぶ", "確定してリストへ"]);
    const r = learnSequenceFromShots([seq2, seq2], { min: 2 });
    const g = r.groups.find((x) => x.name === "地域（所在地）")!;
    eq(g.steps, ["所在地絞り込み", "区を選ぶ", "地域の設定へ進む", "町字を選ぶ"]);
  });
}

console.log("=== ③ 偶然を型にしない（min）");
{
  it("1回だけの組は鎖に入れない", () => {
    // A→B は2回・B→C は1回 → C は入らない
    const r = learnSequenceFromShots([S(["A", "B"]), S(["A", "B"]), S(["A", "B", "C"])], { min: 2 });
    ok(!r.sequence.includes("C"), r.sequence.join(">"));
  });
  it("回数の多い組を優先する（揺れる時）", () => {
    // ⚠ 2026-11-14: 1文字の名前は「入れ物」として学習から除く（isLearnableName）。
    //   試験のデータは実名にする（A/B/C では除外されて空になる）。
    const r = learnSequenceFromShots([
      S(["rental_cost1", "rental_cost2", "square_meter_l"]),
      S(["rental_cost1", "rental_cost2", "square_meter_l"]),
      S(["rental_cost1", "required_time", "square_meter_l"]),
    ], { min: 2 });
    eq(r.sequence, ["rental_cost1", "rental_cost2", "square_meter_l"]);
  });
}

console.log("=== ④ 壊れた入力でも落ちない");
{
  it("空・null・短い並び", () => {
    eq(learnSequenceFromShots([]).sequence, []);
    eq(learnSequenceFromShots([null, { shot_ops: "x" }, S(["A"])] as never).sequence, []);
  });
  it("同じ欄の連続は組みにしない", () => {
    const r = learnSequenceFromShots([S(["A", "A", "A", "B"]), S(["A", "A", "A", "B"])], { min: 2 });
    ok(!r.edges.some((e) => e.from === "A" && e.to === "A"), "A→A が入っている");
  });
}

console.log("=== ⑤ 学習の束に入り、人が読める行になる");
{
  // ⚠ 同じ日の同じ並びは1回に畳まれる（録画の水増し対策）。
  //   鎖が1本になる事を確かめたいので、**日付をずらす**（別の日の同じ手順＝本物の繰り返し）。
  const mk = (ops: string[], dayOffset = 0) => ({
    created_at: new Date(Date.now() - dayOffset * 86400_000).toISOString(),
    site: "realpro", mode: "normal",
    shot_ops: ops.map((f) => ({ f, k: "click" })),
    point_fields: Object.fromEntries(ops.map((f) => [f, { x: 0.5, y: 0.5, n: 2 }])),
  });
  const seq = ["所在地絞り込み", "区を選ぶ", "確定してリストへ", "required_time", "rental_cost2"];
  const days = [mk(seq, 0), mk(seq, 1), mk(seq, 2)];
  it("sequence_flow が入る", () => {
    const b = compactBundle(buildHumanLearnBundle(days as never));
    ok(!!b.sequence_flow, "sequence_flow が無い");
    eq(b.sequence_flow!.sequence, seq);
  });
  it("人が読める行に「一連の動き」が出る", () => {
    const b = compactBundle(buildHumanLearnBundle(days as never));
    const s = b.lines.join("\n");
    ok(/▼ 一連の動き/.test(s), "見出しが無い");
    ok(/所在地絞り込み → 区を選ぶ/.test(s), "順番が出ない");
    ok(/【地域（所在地）】/.test(s), "地域のまとまりが出ない");
  });
  it("中身（入力した値・お客様）は入れない", () => {
    const b = compactBundle(buildHumanLearnBundle(days as never));
    const s = JSON.stringify(b.sequence_flow);
    ok(!/value|お客様|氏名|大阪市/.test(s), "中身らしき物が入っている");
  });
}

console.log(`\n結果: 合格 ${passed} / 不合格 ${failed}`);
if (failed) { for (const f of failures) console.log("  ✗ " + f); process.exit(1); }
