/**
 * 学習完成（期間・土台・つながり・一連）
 */
import { buildLearnCompleteChain } from "../learn-complete-chain";
import { LEARN_PERIODS } from "../learn-periods";

function t(name: string, cond: boolean, detail?: unknown) {
  console.log((cond ? "  ✓ " : "  ✗ ") + name + (!cond && detail != null ? " " + JSON.stringify(detail) : ""));
  if (!cond) process.exitCode = 1;
}

console.log("\n■ incomplete when pillars missing");
{
  const r = buildLearnCompleteChain({});
  t("not ok empty", r.ok === false);
  t("4 pillars", r.total_n === 4);
  t("done < 4", r.done_n < 4);
  t("path has steps", r.path_to_complete.length > 0);
  t("bottleneck set", !!r.bottleneck);
}

console.log("\n■ period ok when windows aligned");
{
  const r = buildLearnCompleteChain({
    period: {
      used: { daysOps: 3, daysAudit: 3, auditWindowMs: LEARN_PERIODS.materialsMs, logMemoryDays: 2, commandsDays: 7 },
    },
  });
  const p = r.pillars.find((x) => x.id === "period");
  t("period pillar ok", p?.ok === true, p);
}

console.log("\n■ all four complete");
{
  const r = buildLearnCompleteChain({
    period: {
      used: { daysOps: 3, daysAudit: 3, auditWindowMs: LEARN_PERIODS.materialsMs, logMemoryDays: 2, commandsDays: 7 },
      screenSolid: 40,
      autoAfter: true,
      readCount: 2,
    },
    foundationMissingN: 0,
    foundationOkN: 52,
    foundationTotalN: 52,
    keyFoundationFails: [],
    linkBottleneckN: null,
    linkLine: "連携完了",
    readCount: 2,
    autoAfter: true,
    screenSolid: 40,
    improveBottleneckN: null,
    improveLine: "一連 1〜6 ✓",
  });
  t("ok", r.ok === true, r);
  t("done 4/4", r.done_n === 4 && r.total_n === 4);
  t("bottleneck null", r.bottleneck == null);
  t("path complete", /完成済み/.test(r.path_to_complete));
}

console.log("\n■ link blocks when solid low");
{
  const r = buildLearnCompleteChain({
    period: { used: { daysOps: 3, daysAudit: 3 } },
    foundationMissingN: 0,
    foundationOkN: 50,
    foundationTotalN: 50,
    screenSolid: 5,
    readCount: 1,
    autoAfter: true,
    improveBottleneckN: null,
    improveLine: "一連 ✓",
  });
  const link = r.pillars.find((x) => x.id === "link");
  t("link not ok", link?.ok === false, link);
  t("next mentions solid", /solid/i.test(link?.next || ""), link?.next);
}
