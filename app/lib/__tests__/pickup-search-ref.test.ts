// merge-pdfs の本文から検索の回・一括の指示を取り出す（pickupSearchRef）のテスト（2026-11-10）
// 実行: npx tsx app/lib/__tests__/pickup-search-ref.test.ts（全 PASS で exit 0）
import { pickupSearchRef } from "../pickup-search-ref";

let pass = 0, fail = 0;
function t(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ""}`); }
}

{
  // 本番の形（search_audits.run_id は sa_xxxx_yyyy・automation_commands.id は uuid）
  const r = pickupSearchRef({ batch_owner: { customer_id: "c1", run_id: "sa_mvqhsk0w_2v8kc5mi", command_id: "0f8a3c1e-1111-4222-8333-944445555666" } });
  t("batch_owner の run_id と command_id を取る", r.searchRunId === "sa_mvqhsk0w_2v8kc5mi" && r.searchCommandId === "0f8a3c1e-1111-4222-8333-944445555666", r);
}
{
  const r = pickupSearchRef({ search_run_id: "sa_a", search_command_id: "cmd-1", batch_owner: { run_id: "sa_b", command_id: "cmd-2" }, search_stamp: { v: 1, run_id: "sa_c" } });
  t("本文の search_run_id / search_command_id が先", r.searchRunId === "sa_a" && r.searchCommandId === "cmd-1", r);
}
{
  const r = pickupSearchRef({ search_stamp: { v: 1, run_id: "sa_c" } });
  t("batch_owner が無ければ search_stamp の run_id", r.searchRunId === "sa_c" && r.searchCommandId === null, r);
}
{
  const r = pickupSearchRef({});
  t("何も無ければ両方 null（記録は止めない）", r.searchRunId === null && r.searchCommandId === null, r);
  const n = pickupSearchRef(null);
  t("本文が null でも落ちない", n.searchRunId === null && n.searchCommandId === null, n);
}
{
  const r = pickupSearchRef({ batch_owner: { run_id: "x'; drop table--", command_id: 123 } });
  t("形の合わない値（記号・数字）は null", r.searchRunId === null && r.searchCommandId === null, r);
  const long = pickupSearchRef({ search_run_id: "a".repeat(81) });
  t("81 字以上は null", long.searchRunId === null, long);
  const sp = pickupSearchRef({ search_run_id: "  sa_trim  " });
  t("前後の空白は外す", sp.searchRunId === "sa_trim", sp);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
