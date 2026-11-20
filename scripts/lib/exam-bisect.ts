// scripts/lib/exam-bisect.ts — 悪化した組を半分ずつに分けて積み直す（二分）の決め方（純関数・LLM も DB も使わない）
//
// 2026-11-21 作業員H（統括役の頼み・KB d57f27eb「組が悪化した時だけスイッチごとに分けて流し直して原因を探す」）:
//   3組（判断・返信の文・AIX の文）にまとめて流し、悪化した組だけ分ける決まりなのに、係に分ける口が無く手で env を半分にしていた。
//   `exam-conductor --bisect=<依頼の label>` で、その依頼の env のスイッチを半分ずつ2本にし、悪化した問題（確かな悪化＋道の悪化）だけを流す。
//   悪化が出た方にもう一度 --bisect をかければ、スイッチ1つまで絞れる（1つになったら止める）。
/** スイッチでない env（試験の道具の設定）。分けずに両方へ写す */
export const NON_SWITCH_ENV = /^(?:EXAM_|LLM_|BRAIN_EXAM_|REPLAY_|TEST_CLOCK_)/;

export function switchKeys(env: Record<string, string> | null | undefined): string[] {
  return Object.keys(env ?? {}).filter((k) => !NON_SWITCH_ENV.test(k)).sort();
}

export type BisectJob = { label: string; env: Record<string, string>; only: string };
export type BisectChild = BisectJob & { half: "A" | "B"; switches: string[] };

/** 2本の依頼の中身。悪化の問題が無い・スイッチが1つ以下なら error */
export function bisectPlan(job: BisectJob, worseIds: ReadonlyArray<string>): { children: BisectChild[] } | { error: string } {
  const keys = switchKeys(job.env);
  if (keys.length <= 1) return { error: `スイッチが ${keys.length}つ＝これ以上分けられない（${keys.join(",") || "なし"} が原因の候補）` };
  const ids = [...new Set(worseIds.filter(Boolean))];
  if (!ids.length) return { error: "悪化した問題が無い（確かな悪化・道の悪化が0）＝分けて流す物が無い" };
  const half = Math.ceil(keys.length / 2);
  const groups: Array<["A" | "B", string[]]> = [["A", keys.slice(0, half)], ["B", keys.slice(half)]];
  const base = Object.fromEntries(Object.entries(job.env ?? {}).filter(([k]) => NON_SWITCH_ENV.test(k)));
  const stem = job.label.replace(/-b[AB]+$/, "");
  const path = (job.label.match(/-b([AB]+)$/)?.[1] ?? "");
  return {
    children: groups.map(([h, sw]) => ({
      half: h, switches: sw,
      label: `${stem}-b${path}${h}`,
      env: { ...base, ...Object.fromEntries(sw.map((k) => [k, job.env[k]])) },
      only: ids.join(","),
    })),
  };
}
