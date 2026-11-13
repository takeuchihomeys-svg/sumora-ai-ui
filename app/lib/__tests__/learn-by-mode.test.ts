// モード別（通常／自動／AIX）の学習と統括の判断（2026-11-14）
//
// 竹内さん「データベースにたまっている画像のデータと統括連携してできていない部分、弱い部分強化するようにする。
//   いま通常と自動のところで自動で強化必要な部分強化するのと、できていない部分もちゃんとデータベースに
//   理解させて強化していく形とする」
//
// 実測で分かった事:
//   - DB の `mode` が**全部空**（通常／自動／AIX の区別が付かない）
//   - 写真の記録は `mode: null` 固定だった
//   - 学習の記録も `_modeNow` が staff しか見ていなかった
//   - 学習の束に「モード別」の学びが無く、統括もモードを判断していなかった
//
// 実行: npx tsx app/lib/__tests__/learn-by-mode.test.ts
import { planLearnFromWeak } from "../shot-learn";
import { buildHumanLearnBundle, compactBundle } from "../human-learn-brain";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(c: boolean, label: string) { if (!c) throw new Error(label); }

const mk = (ops: string[], mode: string, extra: Record<string, unknown> = {}) => ({
  created_at: new Date().toISOString(),
  site: "realpro",
  mode,
  shot_taken: true,
  shot_ops: ops.map((f) => ({ f, k: "click", w: "checkbox", g: 500 })),
  gap_ms: 500,
  point_fields: Object.fromEntries(ops.map((f) => [f, { x: 0.5, y: 0.5, n: 2 }])),
  ...extra,
});

console.log("=== ① モード別に学ぶ（by_mode）");
{
  it("normal と aix を別々に集計する", () => {
    const form = ["required_time", "rental_cost2", "square_meter_l"];
    const rows = [
      mk(form, "normal"), mk(form, "normal"), mk(form, "normal"),
      mk(form, "aix"), mk(form, "aix"), mk(form, "aix"),
    ];
    const b = compactBundle(buildHumanLearnBundle(rows as never));
    ok(!!b.by_mode, "by_mode が無い");
    ok(!!b.by_mode!.normal, "normal が無い");
    ok(!!b.by_mode!.aix, "aix が無い");
    eq(b.by_mode!.normal.rows, 3);
    eq(b.by_mode!.aix.rows, 3);
  });
  it("mode_counts に件数が入る", () => {
    const form = ["required_time", "rental_cost2"];
    const rows = [mk(form, "normal"), mk(form, "aix"), mk(form, "aix")];
    const b = compactBundle(buildHumanLearnBundle(rows as never));
    eq(b.mode_counts, { normal: 1, aix: 2 });
  });
  it("3件未満のモードは学びを作らない（偶然を学ばない）", () => {
    const form = ["required_time", "rental_cost2"];
    const rows = [mk(form, "normal"), mk(form, "normal"), mk(form, "normal"), mk(form, "aix")];
    const b = compactBundle(buildHumanLearnBundle(rows as never));
    ok(!!b.by_mode!.normal, "normal が無い");
    ok(!b.by_mode!.aix, "aix が作られている（3件未満なのに）");
  });
  it("mode が空の記録はモード別に入れない（旧版）", () => {
    const form = ["required_time", "rental_cost2"];
    const rows = [mk(form, ""), mk(form, ""), mk(form, ""), mk(form, "normal"), mk(form, "normal"), mk(form, "normal")];
    const b = compactBundle(buildHumanLearnBundle(rows as never));
    ok(!("" in (b.by_mode || {})), "空のモードが入っている");
    ok(!!b.by_mode!.normal, "normal が無い");
  });
}

console.log("=== ② 統括がモードごとに判断する（mode_plan）");
{
  it("記録が3件未満なら「学べていない」", () => {
    const p = planLearnFromWeak([], [], { aix: { rows: 1, next: 0, steps: 0, gaps: { median_ms: null, samples: 0 } } });
    const m = p.mode_plan.find((x) => x.mode === "aix")!;
    ok(m.verdict.includes("学べていない"), m.verdict);
    ok(m.action.includes("録画"), m.action);
  });
  it("記録はあるのに押す順番0なら「ops が空」を疑う", () => {
    const p = planLearnFromWeak([], [], { aix: { rows: 10, next: 0, steps: 0, gaps: { median_ms: null, samples: 0 } } });
    const m = p.mode_plan.find((x) => x.mode === "aix")!;
    ok(m.verdict.includes("押す順番が0通り"), m.verdict);
    ok(m.action.includes("ops"), m.action);
  });
  it("押す順番はあるが画面の手順が0なら「もう少し操作」", () => {
    const p = planLearnFromWeak([], [], { normal: { rows: 10, next: 3, steps: 0, gaps: { median_ms: 500, samples: 5 } } });
    const m = p.mode_plan.find((x) => x.mode === "normal")!;
    ok(m.verdict.includes("画面の手順が0"), m.verdict);
  });
  it("待つ長さが0なら「間を記録」", () => {
    const p = planLearnFromWeak([], [], { normal: { rows: 10, next: 3, steps: 2, gaps: { median_ms: null, samples: 0 } } });
    const m = p.mode_plan.find((x) => x.mode === "normal")!;
    ok(m.verdict.includes("待つ長さが0"), m.verdict);
  });
  it("全部そろっていれば「学べています」", () => {
    const p = planLearnFromWeak([], [], { normal: { rows: 10, next: 3, steps: 2, gaps: { median_ms: 500, samples: 5 } } });
    const m = p.mode_plan.find((x) => x.mode === "normal")!;
    ok(m.verdict.includes("学べています"), m.verdict);
    eq(m.action, "追加で強化する所は無し");
  });
  it("記録が0件のモードも出す（通常／自動／AIX）", () => {
    const p = planLearnFromWeak([], [], {});
    for (const m of ["normal", "staff", "aix"]) {
      ok(!!p.mode_plan.find((x) => x.mode === m), `${m} が出ていない`);
    }
  });
  it("日本語の名前で出る", () => {
    const p = planLearnFromWeak([], [], { aix: { rows: 0, next: 0, steps: 0, gaps: { median_ms: null, samples: 0 } } });
    const m = p.mode_plan.find((x) => x.mode === "aix")!;
    ok(m.verdict.includes("AIX"), m.verdict);
  });
}

console.log("=== ③ 学習の束に入り、人が読める行になる");
{
  const form = ["required_time", "rental_cost2", "square_meter_l"];
  it("by_mode が束に入る", () => {
    const b = compactBundle(buildHumanLearnBundle([mk(form, "normal"), mk(form, "normal"), mk(form, "normal")] as never));
    ok(!!b.by_mode, "by_mode が無い");
  });
  it("統括に mode_plan が入る", () => {
    const b = compactBundle(buildHumanLearnBundle([mk(form, "normal"), mk(form, "normal"), mk(form, "normal")] as never));
    ok(!!b.learn_plan, "learn_plan が無い");
    ok(Array.isArray(b.learn_plan!.mode_plan), "mode_plan が無い");
    ok((b.learn_plan!.mode_plan ?? []).length > 0, "mode_plan が空");
  });
}

console.log("=== ④ 中身（入力した値・お客様の情報）は入れない");
{
  const form = ["required_time", "rental_cost2"];
  it("モード別にも段の名前だけ", () => {
    const b = compactBundle(buildHumanLearnBundle([mk(form, "normal"), mk(form, "normal"), mk(form, "normal")] as never));
    const s = JSON.stringify(b.by_mode);
    ok(!/value|お客様|氏名/.test(s), "中身らしき物が入っている");
  });
}

console.log(`\n結果: 合格 ${passed} / 不合格 ${failed}`);
if (failed) { for (const f of failures) console.log("  ✗ " + f); process.exit(1); }
