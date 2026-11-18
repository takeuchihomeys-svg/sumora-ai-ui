// 依頼の createdAt が数・空でも係の並べ替えが落ちない（2026-11-18 作業員H・k1118-sizejudge-tsc1 で係が落ちた）
// 実行: npx tsx scripts/lib/__tests__/exam-compare-jobs-created.test.ts
import { compareJobs, createdAtIso } from "../exam-conductor-core";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, extra); } };
t("文字はそのまま", createdAtIso("2026-11-18T01:15:46.274Z") === "2026-11-18T01:15:46.274Z");
t("数（ミリ秒）は ISO に", createdAtIso(1794967845179) === new Date(1794967845179).toISOString());
t("読めない物は空", createdAtIso(undefined) === "" && createdAtIso({}) === "" && createdAtIso(NaN) === "");
const now = Date.parse("2026-11-18T03:00:00Z");
const a = { priority: -1, runner: "tsc-remote", createdAt: 1794967845179 as unknown as string };
const b = { priority: -1, runner: "tsc-remote", createdAt: "2026-11-18T01:15:46.274Z" };
const c = { priority: -1, runner: "tsc-remote", createdAt: undefined as unknown as string };
let threw = false; let order: string[] = [];
try { order = [c, a, b].sort((x, y) => compareJobs(x as never, y as never, now)).map((x) => createdAtIso(x.createdAt as unknown)); } catch { threw = true; }
t("数・空が混ざっても落ちない", !threw);
t("古い順・読めない物は最後", order[0] === b.createdAt && order[1] === new Date(1794967845179).toISOString() && order[2] === "", order);
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
