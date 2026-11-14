// 実際の検索の結果（search_audits）を統括が把握する（2026-11-14）
//
// 竹内さん「データベースと統括もちゃんと関連しなきゃいけない」
//   「これで統括に確認したらすべて把握している状態にする。弱い部分も統括はすべて把握する」
//
// 見つけた穴:
//   統括は human_motion_learn（人の動き）だけを見ていた。
//   search_audits（実際の検索）は **1180行** あり、**60回中56回が途中で止まっていた**（93%）のに、
//   統括は「学べています（自動検索に渡してよい）」と言っていた。
//
// 実行: npx tsx app/lib/__tests__/learn-audit.test.ts
import { summarizeAudits, stageLabel } from "../learn-audit-summary";
import { superviseLearn } from "../learn-supervisor";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

const NOW = Date.parse("2026-11-14T15:00:00+09:00");
const at = (minAgo: number) => new Date(NOW - minAgo * 60000).toISOString();

console.log("■ ① 実際の検索の集計（完走率・止まった場所）");
{
  const rows = [
    { created_at: at(5), status: "finished", severity: "ok", steps: [{ k: "search" }, { k: "done" }] },
    { created_at: at(10), status: "abandoned", cause_key: "stalled:realpro:none", severity: "bad", steps: [{ k: "search_look" }] },
    { created_at: at(15), status: "abandoned", cause_key: "stalled:realpro:none", severity: "bad", steps: [{ k: "ward" }, { k: "search_look" }] },
    { created_at: at(20), status: "abandoned", cause_key: "stalled:realpro:none", severity: "bad", steps: [{ k: "modal_confirm" }] },
    { created_at: at(25), status: "abandoned", cause_key: "error:realpro:duplicate", severity: "bad", error: "duplicate-call-ignored", steps: [{ k: "search" }] },
  ];
  const s = summarizeAudits(rows as never, { sinceMs: 24 * 3600_000, now: NOW });
  ok("回数", s.runs === 5, s.runs);
  ok("完走 1回", s.finished === 1, s.finished);
  ok("途中で止まった 4回", s.abandoned === 4, s.abandoned);
  ok("完走率 20%", s.finish_rate === 20, s.finish_rate);
  ok("重い物（bad）4件", s.bad === 4, s.bad);
  ok("一番の問題を1文で言える", !!s.top_problem && s.top_problem.includes("20%"), s.top_problem);
  ok("  止まった場所が出る", Array.isArray(s.stalled_at) && s.stalled_at.length > 0, s.stalled_at);
  ok("  一番多い止まり方は「検索の前に見直す」", s.stalled_at[0]?.stage.includes("見直") || s.stalled_at[0]?.stage === "search_look", s.stalled_at[0]);
  ok("原因が出る", Array.isArray(s.causes) && s.causes.some((c) => c.cause.includes("途中で止まった")), s.causes);
  ok("エラーの言葉が出る", Array.isArray(s.errors) && s.errors.some((e) => e.error.includes("duplicate")), s.errors);
}

console.log("\n■ ② 段の名前が日本語になる");
{
  ok("search_look → 検索の前に見直す", stageLabel("search_look").includes("見直"), stageLabel("search_look"));
  ok("ward → 区を選ぶ", stageLabel("ward") === "区を選ぶ");
  ok("modal_confirm → 確定してリストへ", stageLabel("modal_confirm") === "確定してリストへ");
  ok("知らない段はそのまま", stageLabel("unknown_stage") === "unknown_stage");
  ok("空は(不明)", stageLabel("") === "(不明)");
}

console.log("\n■ ③ 統括が「実際の検索の完走率」で結論を下げる（一番大事）");
{
  const base = {
    rows: 100, next: 30, points: 57, opens: 13, screens: 2, sequence: 4, gap_ms: 900,
    weak: [] as Array<{ kind: string; name: string }>,
    mode_counts: { normal: 100 }, site_counts: { realpro: 100 }, with_ops: 60, guessed_opens: 0,
    site: "all", shot_rows: 99,
  };
  // 完走率 7%（実測と同じ）→ ready にしない
  const bad = superviseLearn({
    ...base,
    audits: { runs: 60, finished: 4, abandoned: 56, finish_rate: 7, stalled_at: [{ stage: "検索の前に見直す", n: 49 }], bad: 58 },
  });
  ok("完走率7%なら ready にしない", bad.verdict !== "ready", bad.verdict);
  ok("  止まった場所を議題の先頭に出す", bad.meeting.agenda[0]?.topic.includes("途中で止まっている"), bad.meeting.agenda[0]);
  ok("  何回中何回かを言う", String(bad.meeting.agenda[0]?.why || "").includes("4"), bad.meeting.agenda[0]?.why);
  ok("  どこで止まるかを言う", String(bad.meeting.agenda[0]?.why || "").includes("見直"), bad.meeting.agenda[0]?.why);
  ok("  竹内さんに聞く（どれから直すか）", bad.meeting.questions.some((q) => q.q.includes("完走")), bad.meeting.questions.map((q) => q.q));
  ok("  自己点検で矛盾を言う", bad.self_check.ok === false, bad.self_check.issues);
  ok("  根拠に実際の検索を出す", bad.meeting.evidence.some((e) => e.label.includes("実際の検索")), bad.meeting.evidence.map((e) => e.label));

  // 完走率 100% → ready を妨げない
  const good = superviseLearn({ ...base, audits: { runs: 10, finished: 10, abandoned: 0, finish_rate: 100, bad: 0 } });
  ok("完走率100%なら ready を妨げない", good.verdict === "ready", good.verdict);

  // 完走率 70% → almost まで
  const mid = superviseLearn({ ...base, audits: { runs: 10, finished: 7, abandoned: 3, finish_rate: 70, bad: 3 } });
  ok("完走率70%は almost まで", mid.verdict === "almost", mid.verdict);
}

console.log("\n■ ④ 壊れない");
{
  ok("空の行", summarizeAudits([], { now: NOW }).runs === 0);
  ok("null", summarizeAudits(null as never, { now: NOW }).runs === 0);
  ok("古い行は数えない（24時間より前）", summarizeAudits([{ created_at: at(60 * 30), status: "finished" }] as never, { sinceMs: 24 * 3600_000, now: NOW }).runs === 0);
  ok("steps が壊れていても落ちない", (() => {
    const s = summarizeAudits([{ created_at: at(1), status: "abandoned", steps: "壊れた" }] as never, { now: NOW });
    return s.runs === 1;
  })());
  ok("audits が null でも統括は動く", (() => {
    const r = superviseLearn({ rows: 100, next: 12, points: 25, opens: 6, screens: 3, sequence: 5, gap_ms: 900, weak: [], with_ops: 60 });
    return !!r.verdict;
  })());
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
