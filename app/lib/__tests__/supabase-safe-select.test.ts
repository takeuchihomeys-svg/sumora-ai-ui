// 「DB に無い列があると、その列だけ外して読み直す」の試験（app/lib/supabase-safe-select.ts）
// 実行: npx tsx app/lib/__tests__/supabase-safe-select.test.ts
//
// なぜ要るか（2026-11-13 竹内さん「なんで連携できていないのか」）:
//   実際に DB には `shot_b64` と `shot_learn` が無かったのに、コードは
//   「`shot_ops` が無い時だけ外す」と書いてあった。`select` は1列でも無いと**全部落ちる**ので、
//     - 学習 … `shot_ops` まで外れて「押す順番 0通り」
//     - 写真一覧 … 最小の列まで落ちて `shot_ops` が返らない
//   という**静かに壊れる**形になっていた。ここで固定する。
import { selectDroppingMissing, missingColumnOf, isMissingColumnError } from "../supabase-safe-select";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(cond: boolean, label: string) { if (!cond) throw new Error(label); }

async function ita(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}

async function main() {
  console.log("=== 1. エラーの文から無い列を拾う");
  const cand = ["created_at", "shot_ops", "shot_learn", "shot_b64"];
  it("column human_motion_learn.shot_b64 does not exist", () => eq(missingColumnOf("column human_motion_learn.shot_b64 does not exist", cand), "shot_b64"));
  it("Could not find the 'shot_learn' column", () => eq(missingColumnOf("Could not find the 'shot_learn' column of 'human_motion_learn' in the schema cache", cand), "shot_learn"));
  it("column \"shot_ops\" of relation", () => eq(missingColumnOf('column "shot_ops" of relation "human_motion_learn" does not exist', cand), "shot_ops"));
  it("候補に無い名前は拾わない", () => eq(missingColumnOf("column human_motion_learn.zzz does not exist", cand), null));
  it("関係ないエラーは拾わない", () => eq(missingColumnOf("permission denied for table human_motion_learn", cand), null));

  console.log("=== 2. 「列が無い」エラーかの判定");
  it("42703 は列が無い", () => eq(isMissingColumnError({ code: "42703", message: "x" }), true));
  it("PGRST204 は列が無い", () => eq(isMissingColumnError({ code: "PGRST204", message: "x" }), true));
  it("does not exist を含む", () => eq(isMissingColumnError({ code: null, message: "column a does not exist" }), true));
  it("RLS は列が無い扱いにしない", () => eq(isMissingColumnError({ code: "42501", message: "row-level security" }), false));
  it("null は false", () => eq(isMissingColumnError(null), false));

  console.log("=== 3. 無い列だけ外して読み直す（本番で起きた形）");
  await ita("shot_b64 と shot_learn が無くても shot_ops は残る", async () => {
    const EXISTS = new Set(["created_at", "site", "shot_ops", "point_fields"]);
    let calls = 0;
    const run = async (csv: string) => {
      calls++;
      const cols = csv.split(", ").map((s) => s.trim());
      const bad = cols.find((c) => !EXISTS.has(c));
      if (bad) return { data: null, error: { code: "42703", message: `column human_motion_learn.${bad} does not exist` } };
      return { data: [{ ok: true }], error: null };
    };
    const r = await selectDroppingMissing(["created_at", "site", "shot_ops", "shot_learn", "shot_b64", "point_fields"], run);
    eq(r.error, null, "error");
    ok(r.cols.includes("shot_ops"), "shot_ops が残る（押す順番を学べる）");
    ok(r.dropped.includes("shot_learn"), "shot_learn を外した");
    ok(r.dropped.includes("shot_b64"), "shot_b64 を外した");
    ok(!r.cols.includes("shot_learn") && !r.cols.includes("shot_b64"), "外した物は返さない");
    eq(calls, 3, "やり直しは最小回数");
  });

  console.log("=== 4. 列の名前が拾えない形でも通る");
  await ita("schema cache の文でも、読める列だけ残る", async () => {
    const EXISTS = new Set(["created_at", "shot_ops"]);
    const run = async (csv: string) => {
      const cols = csv.split(", ").map((s) => s.trim());
      const bad = cols.find((c) => !EXISTS.has(c));
      if (bad) return { data: null, error: { code: "PGRST204", message: "schema cache is out of date" } };
      return { data: [{ ok: true }], error: null };
    };
    const r = await selectDroppingMissing(["created_at", "shot_ops", "unknown_col"], run);
    eq(r.error, null, "error");
    eq(r.cols.join("|"), "created_at|shot_ops");
    ok(r.dropped.includes("unknown_col"), "読めない列を dropped に入れる");
  });

  console.log("=== 5. 列が無い以外のエラーは、そのまま返す（隠さない）");
  await ita("RLS は隠さず・列も外さない", async () => {
    let calls = 0;
    const run = async () => { calls++; return { data: null, error: { code: "42501", message: "row-level security" } }; };
    const r = await selectDroppingMissing(["a", "b"], run);
    ok(!!r.error && /row-level security/.test(String(r.error.message)), "エラーを返す");
    eq(calls, 1, "無駄にやり直さない");
    eq(r.dropped.length, 0, "勝手に列を外さない");
  });

  console.log("=== 6. 全部の列が無い時（無限に回らない）");
  await ita("エラーで戻る・回り続けない", async () => {
    let calls = 0;
    const run = async (csv: string) => {
      calls++;
      const first = csv.split(", ")[0];
      return { data: null, error: { code: "42703", message: `column human_motion_learn.${first} does not exist` } };
    };
    const r = await selectDroppingMissing(["a", "b", "c"], run);
    ok(!!r.error, "エラーで戻る");
    ok(calls <= 6, "無限に回らない（calls=" + calls + "）");
  });

  console.log(`\n結果: 合格 ${passed} / 不合格 ${failed}`);
  if (failed) { for (const f of failures) console.log("  ✗ " + f); process.exit(1); }
}

main();
