// 試験の係の順番: 待った時間で priority が下がる（古い依頼が後回しになり続けない）・長い待ちの線（scripts/lib/exam-conductor-core.ts）
// 実行: npx tsx scripts/lib/__tests__/exam-job-aging.test.ts（全 PASS で exit 0）
// 2026-11-21 作業員H: M1119-*（priority 5・11/19 04:0xZ）が2日間、後から -2〜-5 で積まれた依頼に抜かれ続けた実物を形にした
import { compareJobs, effectivePriority, longWaiting, jobAgingOn, JOB_AGING_STEP_MS } from "../exam-conductor-core";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };
const now = Date.parse("2026-11-21T04:00:00Z");
const h = (n: number) => new Date(now - n * 3600_000).toISOString();

ok("既定 on・off で止まる", jobAgingOn({}) && !jobAgingOn({ EXAM_JOB_AGING: "off" }));
ok("積んだばかりは priority のまま", effectivePriority({ priority: 5, createdAt: h(1) }, now, true) === 5);
ok("6時間ごとに -1", effectivePriority({ priority: 5, createdAt: h(13) }, now, true) === 3);
ok("off なら下がらない", effectivePriority({ priority: 5, createdAt: h(48) }, now, false) === 5);
ok("読めない createdAt は priority のまま", effectivePriority({ priority: 5, createdAt: "" }, now, true) === 5);
ok("段の幅は6時間", JOB_AGING_STEP_MS === 6 * 3600_000);

// 実物の形: M の依頼（priority 5・48時間待ち）と、今積んだ依頼（priority -3）
const m = { label: "M1119-conductor-focus", priority: 5, createdAt: h(48), runner: "brain-exam", only: "q008,q053,q158,q428,q156", repeat: 1 };
const fresh = { label: "k2-1121-x", priority: -3, createdAt: h(0.2), runner: "brain-exam", only: "q001,q002", repeat: 1 };
const fresh2 = { label: "k2-1121-y", priority: -2, createdAt: h(1), runner: "brain-exam", only: "q003", repeat: 1 };
const order = [fresh, fresh2, m].sort((a, b) => compareJobs(a as never, b as never, now)).map((x) => x.label);
ok("48時間待った priority 5 は、今の -3 より先", order[0] === "M1119-conductor-focus", order);
const m6 = { ...m, createdAt: h(5) };
const order2 = [fresh, m6].sort((a, b) => compareJobs(a as never, b as never, now)).map((x) => x.label);
ok("5時間待ちならまだ -3 が先（急ぎの順は保つ）", order2[0] === "k2-1121-x", order2);
const tsc = { label: "tsc-x", priority: -5, createdAt: h(0.1), runner: "tsc-remote" };
const order3 = [m, tsc].sort((a, b) => compareJobs(a as never, b as never, now)).map((x) => x.label);
ok("tsc（-5）と 48時間待ち（5→-3）なら tsc が先", order3[0] === "tsc-x", order3);

ok("24時間以上は長い待ち", longWaiting({ createdAt: h(25) }, now) && !longWaiting({ createdAt: h(23) }, now) && !longWaiting({ createdAt: "" }, now));

console.log(`exam-job-aging: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
