// scripts/replay-report.cjs — scripts/.replay-out/*.jsonl（yuma-replay-scenarios.ts の出力）を読んで、場面ごとの表と1件ずつの中身を出す（読むだけ）
// 実行: node scripts/replay-report.cjs <label>[,<label>…] [--detail]
const fs = require("fs");
const labels = (process.argv[2] || "").split(",").filter(Boolean);
const detail = process.argv.includes("--detail");
const rows = labels.flatMap((l) => fs.readFileSync(`scripts/.replay-out/${l}.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)).filter((r) => !r._summary);
const sums = labels.flatMap((l) => fs.readFileSync(`scripts/.replay-out/${l}.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)).filter((r) => r._summary);
const cl = (s, n) => String(s ?? "").replace(/\n+/g, " / ").slice(0, n);
const agree = (v) => v === "same" || v === "same_meaning";
const by = new Map();
for (const r of rows) { const k = r.stage_ja; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
let N = 0, P = 0, T = 0, TN = 0, G = 0, A = 0;
console.log("場面            n  道の一致  文の一致  関所を通る  自動で正しく  関所の理由");
for (const [k, rs] of by) {
  const p = rs.filter((r) => r.path_ok).length, wt = rs.filter((r) => r.text_verdict), t = wt.filter((r) => agree(r.text_verdict)).length;
  const g = rs.filter((r) => r.gate === "ok").length, a = rs.filter((r) => r.auto_correct).length;
  N += rs.length; P += p; T += t; TN += wt.length; G += g; A += a;
  const reasons = {}; for (const r of rs) reasons[r.gate] = (reasons[r.gate] || 0) + 1;
  console.log(`${k.padEnd(12)} ${String(rs.length).padStart(3)}  ${p}/${rs.length}      ${t}/${wt.length}      ${g}          ${a}          ${JSON.stringify(reasons)}`);
}
console.log(`合計          ${N}  道 ${P}/${N}（${Math.round(P / N * 100)}%）・文の一致 ${T}/${TN}・関所を通る ${G}・自動で正しく ${A}`);
const ds = sums.reduce((a, s) => a + (s.deepseek || 0), 0), tot = sums.reduce((a, s) => a + (s.total || 0), 0);
console.log(`llm_usage_logs（YUMA）: DeepSeek ${ds}/${tot}  ${JSON.stringify(sums.map((s) => s.models))}`);
if (detail) for (const r of rows) {
  console.log(`\n${r.id} ${r.path_ok ? "OK" : "NG"} 道=${r.decided} 正解=${r.accept} src=${r.brain?.source} mode=${r.brain?.reply_mode} 関所=${r.gate} 文=${r.text_verdict || "-"}(${r.text_reason || ""}) 最終C=${JSON.stringify(r.final_check?.issues || [])}`);
  if (r.draft) console.log("  案:", cl(r.draft, 320));
  console.log("  実:", cl(r.staff_text, 220));
  if (r.audit?.length) console.log("  検査:", r.audit.join(" / "));
  if (r.aix_fill) console.log("  AIX:", r.aix_fill.level, JSON.stringify(r.aix_fill.blockers), r.aix_text ? cl(r.aix_text, 220) : (r.aix_skipped || ""), r.aix_text_verdict ? `[${r.aix_text_verdict}]` : "");
  if (r.error) console.log("  ERR", r.error);
}
