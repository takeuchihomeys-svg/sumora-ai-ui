// 2026-09-24 竹内「1番オススメの物件全体の中で送る。今回は物件数多かったからか出ていなかった」— 回をまたいだ一番のテスト
// 実行: npx tsx app/lib/__tests__/pickup-best.test.ts
// 形は 2026-09-24 の実例（同じお客様に 1分以内に 1件・10件・1件 の3回。id 34〜45）。お客様の情報は無い
import { pickCustomerBest, type BestCandidateRow } from "../pickup-best";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, extra?: unknown) {
  if (ok) { passed++; console.log(`  OK  ${name}`); } else { failed++; console.log(`  NG  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ""}`); }
}
const row = (id: number, batch: string, at: string, rank: number, match: number | null | undefined, extra?: Partial<BestCandidateRow>): BestCandidateRow => ({
  id, batch_id: batch, created_at: at, rank, status: "pending", recommended: 0, property_name: `物件${id}`,
  image_analysis: match === undefined ? null : { match, match_raw: match }, ...extra,
});
{
  const rows = [
    row(34, "B0", "2026-09-24T09:01:29Z", 1, undefined),
    row(35, "B1", "2026-09-24T09:01:44Z", 1, 100, { recommended: 2 }),
    ...[36, 37, 38, 39, 40, 41, 42, 43, 44].map((id, i) => row(id, "B1", "2026-09-24T09:01:44Z", i + 2, null)),
    row(45, "B2", "2026-09-24T09:02:09Z", 1, 100),
  ];
  const b = pickCustomerBest(rows);
  t("★ 実例: 3回をまたいで一番は 35（同点 100 は 🌟★ が上）", b?.id === 35, b);
  t("★ 実例: 同点は 45", JSON.stringify(b?.tied_ids) === "[45]", b?.tied_ids);
  t("★ 実例: 点あり 2・未判定 9・未分析 1・3回分", b?.scored === 2 && b?.unscored === 9 && b?.not_analyzed === 1 && b?.batches === 3, b);
}
{
  const rows = [
    row(1, "B1", "2026-09-24T09:00:00Z", 1, 60),
    row(2, "B2", "2026-09-24T09:05:00Z", 3, 90),
  ];
  t("★ 別の回の方が点が高ければそちら", pickCustomerBest(rows)?.id === 2);
}
{
  const rows = [
    row(1, "B1", "2026-09-24T09:00:00Z", 1, 20, { image_analysis: { match: 20, match_raw: 30 } }),
    row(2, "B2", "2026-09-24T09:05:00Z", 1, 20, { image_analysis: { match: 20, match_raw: 70 } }),
  ];
  t("★ 全部が必須 NG で 20 点 → 上限前の点（match_raw）で決める", pickCustomerBest(rows)?.id === 2);
}
{
  const rows = [
    row(1, "B1", "2026-09-24T09:00:00Z", 2, 80),
    row(2, "B2", "2026-09-24T09:05:00Z", 5, 80),
  ];
  t("★ 同点・同じ印 → 新しい回", pickCustomerBest(rows)?.id === 2);
}
{
  const rows = [
    row(1, "B1", "2026-09-23T09:00:00Z", 1, 100),
    row(2, "B2", "2026-09-24T09:00:00Z", 1, 50),
  ];
  t("★ 最新の回から 6時間より前の回は対象にしない（別の探し物）", pickCustomerBest(rows)?.id === 2);
  t("★ 窓を広げれば入る", pickCustomerBest(rows, { windowHours: 48 })?.id === 1);
}
{
  const rows = [
    row(1, "B1", "2026-09-24T09:00:00Z", 1, 100, { status: "sent" }),
    row(2, "B1", "2026-09-24T09:00:00Z", 2, 40),
  ];
  t("★ 送信済・見送りは対象にしない", pickCustomerBest(rows)?.id === 2);
}
t("★ 点が1件も無ければ null", pickCustomerBest([row(1, "B1", "2026-09-24T09:00:00Z", 1, null)]) === null);
t("★ 空は null", pickCustomerBest([]) === null);

// 2026-09-24 竹内「前回の反証で出た点も直す」: 同点は「合う」の数が多い方を上に／要確認は未判定と分けて数える
{
  const okc = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `W${i + 1}`, result: "ok" }));
  const rows = [
    row(1, "B1", "2026-09-24T09:00:00Z", 1, 100, { image_analysis: { match: 100, match_raw: 100, checks: okc(1) } }),
    row(2, "B1", "2026-09-24T09:00:00Z", 2, 100, { image_analysis: { match: 100, match_raw: 100, ok_count: 4 } }),
    row(3, "B1", "2026-09-24T09:00:00Z", 3, null, { image_analysis: { match: null, review: { status: "要確認", reasons: ["物件名が違う"] } } }),
    row(4, "B1", "2026-09-24T09:00:00Z", 4, null),
  ];
  const b = pickCustomerBest(rows);
  t("★ 同点は「合う」の数が多い方（順位より先）", b?.id === 2, b);
  t("★ 要確認は needs_check に数え、未判定（unscored）と分ける", b?.needs_check === 1 && b?.unscored === 1, b);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
