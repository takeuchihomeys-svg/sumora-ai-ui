// 2026-11-25 作業員A: 試験の係が晩の初めに1回流す費用0の仕事（scripts/lib/exam-night-jobs.ts）
// 実行: npx tsx scripts/lib/__tests__/exam-night-jobs.test.ts
import { nightKeyOf, nightZeroCostDue, nightZeroCostSteps } from "../exam-night-jobs";

let passed = 0, failed = 0;
const t = (name: string, c: boolean, d?: unknown) => { if (c) passed++; else { failed++; console.log("  NG  " + name + (d !== undefined ? "  " + JSON.stringify(d) : "")); } };
const jst = (s: string) => Date.parse(`${s}+09:00`);
t("22時と翌2時は同じ晩の鍵", nightKeyOf(jst("2026-11-25T22:10:00")) === nightKeyOf(jst("2026-11-26T02:00:00")));
t("昼は流さない", !nightZeroCostDue(null, jst("2026-11-25T15:00:00")).due);
t("晩の初めに流す", nightZeroCostDue(null, jst("2026-11-25T22:05:00")).due);
t("同じ晩は1回だけ", !nightZeroCostDue(nightKeyOf(jst("2026-11-25T22:05:00")), jst("2026-11-26T01:00:00")).due);
t("次の晩はまた流す", nightZeroCostDue(nightKeyOf(jst("2026-11-25T22:05:00")), jst("2026-11-26T22:30:00")).due);
t("=off で止まる", !nightZeroCostDue(null, jst("2026-11-25T23:00:00"), { EXAM_NIGHT_ZERO_COST: "off" }).due);
const st = nightZeroCostSteps("x.json");
t("順: 60日の照らし → 駅ごとの物差し → 先読みの当たり → 次の石 → 連携の升 → 連鎖 → 受け持ち表 → AIX の外れ → 覚えた表 → 割れの型の表 → on の後 → shadow の当たり → 辞書 → 週の組 → 影の自動返信 → 地図の木 → 試験を寄せる場面 → 条件の取り合い → 木の数え直し", st.length === 20 && st[18].args[0].includes("audit-condition-write-arbiter") && st[18].args.includes("--write") && st[15].args[0].includes("audit-shadow-auto") && st[16].args.includes("--tree-out=x-tree.json") && st[17].args[0].includes("audit-exam-focus-scenes") && st[19].args.includes("--tree=x-tree.json") && st[0].args[0].includes("route-progress") && st[1].args.includes("--from=x.json") && st[2].args[0].includes("backplan-hit") && st[2].args.includes("--from=x.json") && st[3].args[0].includes("backplan-miss") && st[4].args[0].includes("next-stone") && st[4].args.includes("--from=x.json") && st[5].args[0].includes("linkage-gap-recount") && st[6].args[0].includes("chain-patterns") && st[7].args[0].includes("conductor-ownership") && st[8].args[0].includes("aix-miss") && st[9].args[0].includes("learned-reach") && st[10].args[0].includes("build-claude-split") && st[11].args[0].includes("audit-on-after") && st[12].args[0].includes("audit-material-priority-hit") && st[13].args[0].includes("build-exam-dictionary") && st[14].args[0].includes("plan-week-combo"));
console.log(`exam-night-jobs: ${passed} OK / ${failed} NG`);
if (failed) process.exit(1);
