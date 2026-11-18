/**
 * 学習期間・構築の細部（period construct）
 */
import { LEARN_PERIODS, materialsDays, logMemoryDays } from "../learn-periods";
import { buildLearnPeriodConstruct, learnPeriodDays } from "../learn-period-construct";

function t(name: string, cond: boolean, detail?: unknown) {
  console.log((cond ? "  ✓ " : "  ✗ ") + name + (!cond && detail != null ? " " + JSON.stringify(detail) : ""));
  if (!cond) process.exitCode = 1;
}

console.log("\n■ learn-periods helpers");
t("materialsDays=3", materialsDays() === 3);
t("logMemoryDays=2", logMemoryDays() === 2);
t("learnPeriodDays materials", learnPeriodDays("materialsMs") === 3);

console.log("\n■ aligned foundation windows");
{
  const r = buildLearnPeriodConstruct({
    used: { daysOps: 3, daysAudit: 3, auditWindowMs: LEARN_PERIODS.materialsMs, logMemoryDays: 2 },
    screenSolid: 40,
    photoLearnTask: true,
    unreadNormal: 0,
  });
  t("no period gaps when aligned", r.gaps.filter((g) => g.facet === "period").length === 0, r.gaps);
  t("period_aligned mark ok", r.construct_marks.find((m) => m.id === "period_aligned")?.ok === true);
  t("foundationOps 3日", r.periods.foundationOps === "3日");
  t("foundationAudit 3日", r.periods.foundationAudit === "3日");
}

console.log("\n■ detects ops/audit split (legacy 2/3)");
{
  const r = buildLearnPeriodConstruct({ used: { daysOps: 2, daysAudit: 3 } });
  t("ops gap (2≠3)", r.gaps.some((g) => g.id === "ops_window"), r.gaps);
  t("audit 3日は材料と一致", !r.gaps.some((g) => g.id === "audit_window"));
  t("period_aligned false", r.construct_marks.find((m) => m.id === "period_aligned")?.ok === false);
}
console.log("\n■ detects both misaligned");
{
  const r = buildLearnPeriodConstruct({ used: { daysOps: 2, daysAudit: 2 } });
  t("ops gap", r.gaps.some((g) => g.id === "ops_window"));
  t("audit gap", r.gaps.some((g) => g.id === "audit_window"));
}

console.log("\n■ logMemory / normalFresh labels");
{
  const r = buildLearnPeriodConstruct({});
  t("logMemory 2日", r.periods.logMemory === "2日");
  t("normalFresh 1日", r.periods.normalFresh === "1日");
}

console.log("\n■ shotLearnDays misalign");
{
  const r = buildLearnPeriodConstruct({ used: { shotLearnDays: 7 } });
  t("shot_window gap", r.gaps.some((g) => g.id === "shot_window"), r.gaps);
}