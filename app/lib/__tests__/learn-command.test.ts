// 統括が「現場への指示の詰まり」も把握する（2026-11-14）
//
// 竹内さん「統括側に足りていない部分があれば強化する形とする。その点も強化」
//
// 見つけた穴:
//   統括は search_audits（検索の結果）と human_motion_learn（人の動き）を見ていたが、
//   **automation_commands（現場への指示）を見ていなかった**（実測 1609行）。
//   検索が動いていても、指示が拾われないまま／失敗したままなら現場は止まる。
//
// 実行: npx tsx app/lib/__tests__/learn-command.test.ts
import { summarizeCommands } from "../learn-command-summary";
import { superviseLearn } from "../learn-supervisor";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

const NOW = Date.parse("2026-11-14T15:00:00+09:00");
const at = (minAgo: number) => new Date(NOW - minAgo * 60000).toISOString();

console.log("■ ① 指示の状態をまとめる");
{
  const rows = [
    { created_at: at(5), status: "done" },
    { created_at: at(10), status: "error", error_message: "AXLX_NO_TAB: タブが開いていません" },
    { created_at: at(15), status: "error", error_message: "AXLX_NO_TAB: タブが開いていません" },
    { created_at: at(20), status: "running", picked_up_at: at(19) },
    { created_at: at(120), status: "pending" },   // 2時間前から拾われていない（詰まり）
  ];
  const s = summarizeCommands(rows as never, { sinceMs: 24 * 3600_000, now: NOW });
  ok("数", s.total === 5, s.total);
  ok("完了 1", s.done === 1, s.done);
  ok("失敗 2", s.failed === 2, s.failed);
  ok("実行中 1", s.running === 1, s.running);
  ok("待ち 1", s.pending === 1, s.pending);
  ok("失敗の理由が出る", s.errors.length > 0 && s.errors[0].n === 2, s.errors);
  ok("⚠ 拾われないまま（30分以上）を見つける", !!s.top_problem && s.top_problem.includes("拾われない"), s.top_problem);
}

console.log("\n■ ② 詰まりが無ければ問題にしない");
{
  const rows = [
    { created_at: at(5), status: "done" },
    { created_at: at(10), status: "done" },
  ];
  const s = summarizeCommands(rows as never, { sinceMs: 24 * 3600_000, now: NOW });
  ok("問題なし", s.top_problem === null, s.top_problem);
}

console.log("\n■ ③ 失敗が多いと問題にする");
{
  const rows = [
    { created_at: at(5), status: "error", error_message: "AXLX_NO_TAB" },
    { created_at: at(10), status: "error", error_message: "AXLX_NO_TAB" },
    { created_at: at(15), status: "done" },
  ];
  const s = summarizeCommands(rows as never, { sinceMs: 24 * 3600_000, now: NOW });
  ok("失敗を問題にする", !!s.top_problem && s.top_problem.includes("失敗"), s.top_problem);
  ok("  一番多い理由を出す", !!s.top_problem && s.top_problem.includes("AXLX_NO_TAB"), s.top_problem);
}

console.log("\n■ ④ 統括が議題の先頭に出す");
{
  const base = {
    rows: 100, next: 30, points: 57, opens: 13, screens: 2, sequence: 4, gap_ms: 900,
    weak: [] as Array<{ kind: string; name: string }>,
    mode_counts: { normal: 100 }, site_counts: { realpro: 100 }, with_ops: 60, guessed_opens: 0,
    site: "all", shot_rows: 99,
  };
  const r = superviseLearn({
    ...base,
    commands: { total: 10, done: 5, failed: 2, pending: 3, running: 0, top_problem: "拾われないまま 3件の指示が残っています" },
  });
  ok("議題の先頭が「指示が詰まっている」", !!r.meeting.agenda[0] && r.meeting.agenda[0].topic.includes("指示が詰まって"), r.meeting.agenda[0]);
  ok("  なぜ（拾われないまま3件）を出す", String(r.meeting.agenda[0]?.why || "").includes("3件"), r.meeting.agenda[0]?.why);
  ok("  どこから直すか聞く", r.meeting.questions.some((q) => q.q.includes("指示")), r.meeting.questions.map((q) => q.q));
  ok("  根拠に現場への指示を出す", r.meeting.evidence.some((e) => e.label.includes("現場への指示")), r.meeting.evidence.map((e) => e.label));
}

console.log("\n■ ⑤ 壊れない");
{
  ok("空", summarizeCommands([], { now: NOW }).total === 0);
  ok("null", summarizeCommands(null as never, { now: NOW }).total === 0);
  ok("status が空でも待ちに入る", summarizeCommands([{ created_at: at(1), status: "" }] as never, { sinceMs: 24 * 3600_000, now: NOW }).pending === 1);
  ok("commands が null でも統括は動く", (() => {
    const r = superviseLearn({ rows: 100, next: 12, points: 25, opens: 6, screens: 3, sequence: 5, gap_ms: 900, weak: [], with_ops: 60 });
    return !!r.verdict && !r.meeting.agenda.some((a) => a.topic.includes("指示が詰まって"));
  })());
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
