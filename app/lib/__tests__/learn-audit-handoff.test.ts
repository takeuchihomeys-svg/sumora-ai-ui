/**
 * 完了→次客の細分化（handoff）と学習期間の正本
 */
import { summarizeAudits } from "../learn-audit-summary";
import { LEARN_PERIODS, periodLabelJa } from "../learn-periods";

function t(name: string, cond: boolean, detail?: unknown) {
  console.log((cond ? "  ✓ " : "  ✗ ") + name + (!cond && detail != null ? " " + JSON.stringify(detail) : ""));
  if (!cond) process.exitCode = 1;
}

const now = Date.now();
const row = (o: Record<string, unknown>) => ({
  created_at: new Date(now - 1000).toISOString(),
  status: "abandoned",
  site: "realpro",
  mode: "brain_aix",
  steps: [],
  filled: { ops: [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}] },
  ...o,
});

console.log("\n■ learn-periods");
t("材料は3日", LEARN_PERIODS.materialsMs === 3 * 86400_000);
t("指示は7日", LEARN_PERIODS.commandsMs === 7 * 86400_000);
t("ラベル", periodLabelJa(LEARN_PERIODS.materialsMs) === "3日");

console.log("\n■ handoff 細分化");
{
  const s = summarizeAudits([
    row({ steps: [{ k: "switch_fail" }, { k: "page:fill_start" }], error: null }),
    row({ steps: [{ k: "owner_mismatch" }], error: "owner_mismatch: x" }),
    row({ steps: [{ k: "no_fill_start" }], error: "AXLX_NO_FILL_START" }),
    row({ steps: [{ k: "batch_timeout" }], error: null }),
    row({ steps: [{ k: "search" }], error: "pipeline_busy" }),
    row({ steps: [{ k: "tab_reload" }, { k: "supersede" }], error: null }),
  ], { now, sinceMs: LEARN_PERIODS.materialsMs });
  t("handoff がある", !!s.handoff, s.handoff);
  t("switch_fail", s.handoff!.switch_fail === 1, s.handoff);
  t("owner_mismatch", s.handoff!.owner_mismatch === 1, s.handoff);
  t("no_fill_start", s.handoff!.no_fill_start === 1, s.handoff);
  t("batch_timeout", s.handoff!.batch_timeout === 1, s.handoff);
  t("pipeline_busy", s.handoff!.pipeline_busy === 1, s.handoff);
  t("tab_reload", s.handoff!.tab_reload === 1, s.handoff);
  t("supersede", s.handoff!.supersede === 1, s.handoff);
  t("series_done 初期0", s.handoff!.series_done === 0, s.handoff);
  t("flow_handoff_gap 初期0", s.handoff!.flow_handoff_gap === 0, s.handoff);
  t("line に次客切替", /次客切替失敗/.test(s.handoff!.line), s.handoff!.line);
}

console.log("\n■ F45 完了理解台帳");
{
  const s = summarizeAudits([
    row({
      status: "finished",
      steps: [
        { k: "flow_done_place" },
        { k: "flow_done_conditions" },
        { k: "flow_done_search" },
        { k: "flow_done_fill_done" },
        { k: "flow_done_ready_next" },
        { k: "series_done" },
        { k: "flow_understand_ledger" },
      ],
    }),
    row({ steps: [{ k: "flow_gap_search" }], error: null }),
  ], { now, sinceMs: LEARN_PERIODS.materialsMs });
  t("flow がある", !!s.flow, s.flow);
  t("place_ok", s.flow!.place_ok === 1, s.flow);
  t("ready_next", s.flow!.ready_next === 1, s.flow);
  t("gaps", s.flow!.gaps === 1, s.flow);
  t("handoff.series_done", s.handoff!.series_done === 1, s.handoff);
  t("line に一連", /一連完了|次客へ渡してよい|場所完了/.test(s.flow!.line), s.flow!.line);
}

console.log("\n■ 既定 sinceMs は materialsMs");
{
  const old = summarizeAudits([
    row({
      created_at: new Date(now - 2 * 86400_000).toISOString(),
      steps: [{ k: "switch_fail" }],
      filled: { ops: Array.from({ length: 12 }, () => ({})) },
    }),
  ], { now });
  t("2日前も材料窓に入る", old.handoff!.switch_fail === 1, old);
}
