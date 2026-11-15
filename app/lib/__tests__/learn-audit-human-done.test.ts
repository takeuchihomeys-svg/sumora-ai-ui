/**
 * 実行: npx tsx app/lib/__tests__/learn-audit-human-done.test.ts
 *
 * 2026-11-15 **実測で見つけた「完走率8%」の正体**を固定する。
 *
 *   ⚠ `search_audits` の実測（全期間）:
 *      brain_normal / single … 完走 20回 / 止まり **385回**（止まった回にも人の操作 1016手）
 *      brain_staff  / single … 完走 11回 / 止まり **188回**
 *
 *   なぜ: 人の検索は**結果の取り込みが無い**ので `finished` を送る経路が無く、
 *     20分後に見回りが `abandoned` にしていた。＝ **止まっていない回が「止まった」に数えられていた**。
 *     統括はこれを見て「完走率 8%・検索が押せていない」と誤解していた。
 *
 *   → 人の検索は「最後まで操作したか（ops 10手以上）」で完走と判断する。
 */
import { summarizeAudits, type AuditRow } from "../learn-audit-summary";

let passed = 0, failed = 0;
function t(name: string, cond: boolean, extra?: unknown) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 400) : "")); }
}
const now = Date.UTC(2026, 10, 15, 12, 0, 0);
const row = (o: Partial<AuditRow> & { ops?: number }): AuditRow => ({
  created_at: new Date(now - 3600_000).toISOString(),
  status: "started", site: "realpro", mode: "brain_normal", steps: [],
  filled: { ops: Array.from({ length: o.ops ?? 0 }, (_, i) => ({ k: "click", i })) },
  ...o,
});

console.log("■ ① 人の検索（操作が最後まで入っている）は「止まった」に数えない");
{
  const s = summarizeAudits([row({ status: "started", mode: "brain_normal", ops: 35 })], { now });
  t("完走に数える", s.finished === 1, s);
  t("止まりに数えない", s.abandoned === 0, s);
  t("完走率100%", s.finish_rate === 100, s);
}

console.log("\n■ ② スタッフモードも同じ（人が押す検索）");
{
  const s = summarizeAudits([row({ status: "started", mode: "brain_staff", ops: 49 })], { now });
  t("完走に数える", s.finished === 1, s);
}

console.log("\n■ ③ ⚠ 自動（brain_aix）は今まで通り「止まった」に数える（勝手に完走にしない）");
{
  const s = summarizeAudits([row({ status: "abandoned", mode: "brain_aix", ops: 40 })], { now });
  t("止まりに数える", s.abandoned === 1, s);
  t("完走にしない", s.finished === 0, s);
  t("止まった場所を残す（終わりの合図が来なかった）",
    (s.stalled_at[0]?.stage ?? "").includes("終わりの合図"), s.stalled_at);
  /**
   * ⚠ `started` のままの回は「まだ走っている」として数える（既存の仕様）。
   *   20分たつと見回りが `abandoned` にする。**人の検索はそれより前に完走に数える**のが今回の直し。
   */
  const s2 = summarizeAudits([row({ status: "started", mode: "brain_aix", ops: 40 })], { now });
  t("started は進行中として数える（abandoned にしない）", s2.started === 1 && s2.abandoned === 0, s2);
}

console.log("\n■ ④ 操作が少なすぎる回は完走にしない（押し始めただけ）");
{
  // 見回りが拾った後（abandoned）は止まり。started のままなら進行中。
  const s = summarizeAudits([    row({ status: "abandoned", mode: "brain_normal", ops: 3 })], { now });
  t("止まりに数える", s.abandoned === 1, s);
  const s2 = summarizeAudits([row({ status: "started", mode: "brain_normal", ops: 3 })], { now });
  t("完走にしない（進行中）", s2.finished === 0 && s2.started === 1, s2);
}

console.log("\n■ ④-2 操作の記録が無い回は「判断できない」に分ける（完了率の分母から外す）");
{
  // 実測: 古い版 2.5.91 の4回は ops=0（操作の記録を送っていなかった）
  const s = summarizeAudits([
    row({ status: "abandoned", mode: "brain_staff", ops: 0, filled: {} }),
    row({ status: "abandoned", mode: "brain_staff", ops: 0, filled: {} }),
    row({ status: "finished", mode: "brain_aix", ops: 0, filled: {} }),
  ], { now });
  t("判断できない＝2", s.unknown === 2, s);
  t("止まりに混ぜない", s.abandoned === 0, s);
  t("完走率は 1/1（判断できる回だけで数える）", s.finish_rate === 100, s.finish_rate);
  t("runs は全部の回（3）", s.runs === 3, s.runs);
  // エラーが分かっている回は「判断できない」に入れない（止まった理由が分かる）
  const s2 = summarizeAudits([row({ status: "abandoned", mode: "brain_aix", ops: 0, filled: {}, error: "AXLX_AREA_MISMATCH" })], { now });
  t("エラーがある回は止まりに数える", s2.abandoned === 1 && s2.unknown === 0, s2);
}

console.log("\n■ ⑤ 実際の数字で「8%」が正しく直る（まりあさんの今日の記録）");
{
  // 2026-11-15 の実測: realpro の brain_normal 4回（ops 35/39/49/53）＋ brain_aix 1回（finished）
  const rows: AuditRow[] = [
    row({ status: "started", mode: "brain_normal", ops: 35 }),
    row({ status: "started", mode: "brain_normal", ops: 39 }),
    row({ status: "started", mode: "brain_normal", ops: 49 }),
    row({ status: "started", mode: "brain_normal", ops: 53 }),
    row({ status: "finished", mode: "brain_aix", ops: 0 }),
  ];
  const s = summarizeAudits(rows, { now });
  t("5回中5回が完走（旧は1回＝8%と数えていた）", s.finished === 5, { finished: s.finished, rate: s.finish_rate });
  t("完走率100%", s.finish_rate === 100, s.finish_rate);
  t("「完走率が低い」と言わない", !(s.top_problem ?? "").includes("完走していません"), s.top_problem);
}

console.log("\n■ ⑥ 本当に止まった自動の回は残る（見落とさない）");
{
  const s = summarizeAudits([
    row({ status: "abandoned", mode: "brain_aix", ops: 0, error: "AXLX_AREA_MISMATCH: 地域がそろいません" }),
    row({ status: "finished", mode: "brain_aix", ops: 9 }),
  ], { now });
  t("止まり1・完走1", s.abandoned === 1 && s.finished === 1, s);
  t("理由が残る", (s.errors[0]?.error ?? "").includes("AREA_MISMATCH"), s.errors);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
