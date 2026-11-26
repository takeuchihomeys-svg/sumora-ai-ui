// app/lib/__tests__/time-map.test.ts — 時間の地図（予定表）（2026-11-27 作業員A・#808）
//   実行: npx tsx app/lib/__tests__/time-map.test.ts
import { buildTimeMap, timeMapLine, timeMapLineOn, isBusinessDay, nextBusinessDay, prevBusinessDay } from "../time-map";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
t("営業日: 土日・祝日・年末年始は休み", !isBusinessDay("2026-11-28") && !isBusinessDay("2026-11-23") && !isBusinessDay("2026-12-30") && !isBusinessDay("2027-01-02") && isBusinessDay("2026-11-27"));
t("次・前の営業日", nextBusinessDay("2026-11-28") === "2026-11-30" && prevBusinessDay("2026-11-29") === "2026-11-27" && nextBusinessDay("2026-12-29") === "2027-01-04");
const evs = buildTimeMap({ todayYmd: "2026-11-27", moveIn: { kind: "date", startYmd: "2027-01-10", source: "registered" }, viewings: [{ ymd: "2026-12-01", time: "13:00" }, { ymd: "2026-11-20" }], promises: [{ kind: "確認", promisedAt: "2026-11-26T03:00:00Z", dueAt: "2026-11-28T03:00:00Z", overdue: false }, { kind: "探す", promisedAt: "2026-11-20T03:00:00Z", dueAt: "2026-11-23T03:00:00Z", overdue: true }] });
t("入居・申込の目安（営業日に寄せた入居の30〜14日前）・内覧・約束が日の順", evs.map((e) => e.kind).join() === "promise_due,promise_due,viewing,apply_by,move_in" && evs.find((e) => e.kind === "apply_by")!.label.includes("2026-12-11") && evs.find((e) => e.kind === "apply_by")!.label.includes("2026-12-25"));
t("過ぎた内覧は入れない・期限を過ぎた約束は今日に寄せる", !evs.some((e) => e.label.includes("2026-11-20")) && evs.some((e) => e.ymd === "2026-11-27" && e.label.includes("期限を過ぎている")));
t("休みの日は管理会社の次の営業日を出す", buildTimeMap({ todayYmd: "2026-11-28" }).some((e) => e.kind === "mgmt_next_open" && e.ymd === "2026-11-30"));
t("入居が分からない・申込の目安が過ぎた時は申込の目安を出さない", !buildTimeMap({ todayYmd: "2026-11-27", moveIn: { kind: "unknown" } }).some((e) => e.kind === "apply_by") && !buildTimeMap({ todayYmd: "2026-11-27", moveIn: { kind: "date", startYmd: "2026-12-08" } }).some((e) => e.kind === "apply_by"));
t("1行: 決めるのはあなた・既定 off", timeMapLine(evs).includes("決めるのはあなた") && timeMapLine([]) === "" && !timeMapLineOn({}));
console.log(`time-map: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
