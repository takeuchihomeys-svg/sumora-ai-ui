// scripts/lib/exam-night-jobs.ts — 試験の係（exam-conductor --run）が晩の初めに1回流す費用0の仕事（LLM なし・重い読み可の時間だけ）
// 2026-11-25 作業員A（統括役の決め: 新しい Vercel の cron は足さない・毎晩手で流すと抜ける）
//   ① 駅ごとの元の数: audit-route-progress-takeuchi --days=60 --json → audit-route-station-daily --from --write（台帳 #687）
//   ② AIX の外れの組ごとの数: audit-aix-miss-causes --days=30 --write（台帳 #688・毎朝の self-improve も数えるが、晩にも書いておく）
//   ③ 前の on の回から覚えた表: build-learned-reach --days=60（exam-cache/learned-reach.json・台帳 #683）
//   晩＝JST 22時〜翌6時。晩の鍵は「JST の日付を12時で切った日」（22時と翌2時は同じ晩）。止める: EXAM_NIGHT_ZERO_COST=off
export function nightKeyOf(nowMs: number): string { return new Date(nowMs + 9 * 3_600_000 - 12 * 3_600_000).toISOString().slice(0, 10); }
export function nightZeroCostDue(lastKey: string | null | undefined, nowMs: number, env: Record<string, string | undefined> = {}): { due: boolean; key: string } {
  const key = nightKeyOf(nowMs);
  if ((env.EXAM_NIGHT_ZERO_COST ?? "").trim().toLowerCase() === "off") return { due: false, key };
  const h = new Date(nowMs + 9 * 3_600_000).getUTCHours();
  const night = h >= 22 || h < 6;
  return { due: night && lastKey !== key, key };
}
/** 流す台本（順に・前が落ちても次は流す）。json は係の置き場の印のフォルダに置く */
export function nightZeroCostSteps(jsonPath: string): Array<{ name: string; args: string[]; timeoutMin: number }> {
  return [
    { name: "駅ごとの元の数（60日の照らし）", args: ["scripts/audit-route-progress-takeuchi.ts", "--days=60", "--max-conv=400", "--first-move", `--json=${jsonPath}`], timeoutMin: 40 },
    { name: "駅ごとの物差し（quality_daily）", args: ["scripts/audit-route-station-daily.ts", `--from=${jsonPath}`, "--days=60", "--write"], timeoutMin: 15 },
    // 2026-11-25 作業員A（#745 ③）: 逆算の計画の この先 の当たり（同じ照らしの json・DB は書くだけ）
    { name: "地図の先読みの当たり（quality_daily）", args: ["scripts/audit-route-backplan-hit.ts", `--from=${jsonPath}`, "--write"], timeoutMin: 5 },
    // 2026-11-26 作業員A（#745 の直し④）: 竹内さんの先読みとの一致（主の物差し・竹内さん本人の文を軽く読む）
    { name: "竹内さんの先読みとの一致（quality_daily）", args: ["scripts/audit-route-backplan-miss.ts", `--from=${jsonPath}`, "--write"], timeoutMin: 10 },
    { name: "AIX の外れの組ごとの数（quality_daily）", args: ["scripts/audit-aix-miss-causes.ts", "--days=30", "--write"], timeoutMin: 15 },
    // 2026-11-25 作業員A（#683・L と表を1本に）: 前の on の回から覚えた表（exam-cache/learned-reach.json・L の reachRowOf が読む）
    { name: "覚えた表（learned-reach.json）", args: ["scripts/build-learned-reach.ts", "--days=60"], timeoutMin: 10 },
  ];
}
