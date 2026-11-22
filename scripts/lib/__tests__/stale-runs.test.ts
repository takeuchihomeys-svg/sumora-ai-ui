// scripts/lib/__tests__/stale-runs.test.ts — 穴の型①「作ったのに回っていない」（npx tsx で回す）
import { cronPeriodHours, cronNameOf, staleCronsOf, staleMetricsOf } from "../stale-runs";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };

t("毎日", cronPeriodHours("0 1 * * *") === 24);
t("15分ごと", cronPeriodHours("*/15 * * * *") === 24);
t("週1", cronPeriodHours("0 19 * * 0") === 168);
t("平日", cronPeriodHours("0 1 * * 1-5") === 168 || cronPeriodHours("0 1 * * 1,2,3,4,5") === 24);
t("月1", cronPeriodHours("0 0 1 * *") === 744);
t("読めない", cronPeriodHours("bad") === null);
t("名前", cronNameOf("/api/cron/auto-property-search?mode=am") === "auto-property-search");
const now = Date.parse("2026-11-21T12:00:00Z");
const crons = [{ path: "/api/cron/a", schedule: "0 1 * * *" }, { path: "/api/cron/b", schedule: "0 1 * * *" }, { path: "/api/cron/c", schedule: "0 19 * * 0" }, { path: "/api/cron/d", schedule: "0 1 * * *" }, { path: "/api/cron/e", schedule: "0 1 * * *" }];
const last = new Map<string, string | null>([["a", "2026-11-21T01:00:00Z"], ["b", "2026-11-19T01:00:00Z"], ["c", "2026-11-15T19:00:00Z"], ["d", null]]);
const s = staleCronsOf(crons, last, now, undefined, "2026-10-01T00:00:00Z");
t("b は止まっている", s.some((x) => x.name === "b" && x.kind === "cron_stale"), s);
t("a・c は回っている", !s.some((x) => x.name === "a" || x.name === "c"), s);
t("d は一度も無い", s.some((x) => x.name === "d" && x.kind === "cron_never"), s);
t("e は読めていないので判定しない", !s.some((x) => x.name === "e"), s);
const m = staleMetricsOf([{ metric: "x", owner: "N" }, { metric: "y", owner: "N" }, { metric: "z", owner: "K2" }], new Map([["x", "2026-11-19"], ["y", "2026-11-18"]]), "2026-11-21");
t("x は2日の余裕の中", !m.some((r) => r.name === "x"), m);
t("y は止まっている", m.some((r) => r.name === "y" && r.kind === "metric_stale"), m);
t("z は一度も無い（持ち主つき）", m.some((r) => r.name === "z" && r.kind === "metric_never" && r.owner === "K2"), m);
t("keep-warm は期待から外す", staleCronsOf([{ path: "/api/cron/keep-warm", schedule: "*/10 * * * *" }], new Map([["keep-warm", "2026-09-19T06:30:00Z"]]), now).length === 0);
// 2026-11-22 作業員N2: 記録を足してから予定の1周＋余裕が過ぎるまでは「一度も無い」にしない
const wrapNow = Date.parse("2026-11-21T22:30:00Z");
const w = staleCronsOf([{ path: "/api/cron/daily", schedule: "0 1 * * *" }, { path: "/api/cron/weekly", schedule: "0 19 * * 0" }], new Map([["daily", null], ["weekly", null]]), wrapNow, undefined, "2026-11-21T14:30:00Z");
t("足して8時間の毎日・週1は まだ一度も無いにしない", w.length === 0, w);
const w2 = staleCronsOf([{ path: "/api/cron/daily", schedule: "0 1 * * *" }, { path: "/api/cron/weekly", schedule: "0 19 * * 0" }], new Map([["daily", null], ["weekly", null]]), Date.parse("2026-11-23T00:00:00Z"), undefined, "2026-11-21T14:30:00Z");
t("足して33時間: 毎日は一度も無い・週1はまだ", w2.length === 1 && w2[0].name === "daily" && w2[0].kind === "cron_never", w2);
console.log(`stale-runs: ${pass} 通過・${fail} 失敗`);
if (fail) process.exit(1);
