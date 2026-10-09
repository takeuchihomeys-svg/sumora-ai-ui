// scripts/audit-brain-exam-failures.ts — ブレインの試験の落ちた問題を、保存した答案（複数の回）から1問ずつ並べる（読むだけ・LLM も DB も呼ばない・$0）
//
// 2026-10-09 竹内さん「ブレインの試験をできれば90%超えたい」→ 落ちた問題を (a) 試験そのもの／(b) スタッフだけが知る事／(c) 材料が届いていない／
//   (d) 決定論の規則・型の上書き／(e) ブレインの読み違い に分けるための材料。同じ問題の複数の回（同じ DeepSeek・構成が違う回も）を並べて、
//   道・本質・依頼の判定が回ごとにどれだけ揺れるかも出す。
// 使い方: npx tsx scripts/audit-brain-exam-failures.ts [--base=base-ds-1009] [--labels=base-ds-1009,r13-tc-ds3,r13-tc-ds4,base-ds-1008,base-claude-all-1008] [--only=q001] [--all] [--out=<ファイル>]
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { brainPathCode, judgePath, type BrainExamOutput } from "./lib/brain-exam-score";
import type { ExamProblem } from "./brain-exam-add";

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const BASE = arg("base", "base-ds-1009");
const LABELS = arg("labels", "base-ds-1009,r13-tc-ds3,r13-tc-ds4,base-ds-1008,r13-tc-ds,base-claude-all-1008").split(",").filter(Boolean);
const ONLY = arg("only").split(",").filter(Boolean);
const ALL = args.includes("--all");
const OUT = arg("out");

type Row = {
  id: string; rep: number; label: string; model: string; error?: string;
  brain: Record<string, unknown> | null; path: { code: string };
  asks: Array<{ q: string; covered: boolean; why: string }> | null; ng: Array<{ text: string; violated: boolean; why: string }> | null;
  score: { pass: boolean }; essence?: { code: string } | null; trace?: Record<string, unknown>; raw?: Record<string, unknown> | null;
  draft?: { text: string | null; code: string; pass: boolean } | null;
};
const probs = JSON.parse(readFileSync("scripts/brain-exam/problems.json", "utf8")) as Array<ExamProblem & { acceptWhen?: { searchExhausted?: string[] } }>;
const acceptOf = (p: (typeof probs)[number]) => p.acceptWhen?.searchExhausted?.length ? p.acceptWhen.searchExhausted : p.accept;
const read = (l: string): Row[] => { const f = `scripts/brain-exam/results/${l}.jsonl`; return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((x) => JSON.parse(x) as Row).filter((r) => !r.error) : []; };
const runs = new Map(LABELS.map((l) => [l, read(l)]));
const pathOk = (p: (typeof probs)[number], r: Row) => judgePath(brainPathCode(r.brain as BrainExamOutput), acceptOf(p), p.mustNot ?? []).ok;
const passOf = (p: (typeof probs)[number], r: Row) => pathOk(p, r) && (!r.asks || r.asks.every((a) => a.covered)) && (!r.ng || !r.ng.some((g) => g.violated));

const L: string[] = [];
const baseRows = runs.get(BASE) ?? [];
const failed = probs.filter((p) => { const r = baseRows.find((x) => x.id === p.id); return ALL || (r && !passOf(p, r)); }).filter((p) => !ONLY.length || ONLY.includes(p.id));
L.push(`# 落ちた問題（基準 ${BASE}）${failed.length} 問・並べた回 ${LABELS.join(", ")}`);
// 回ごとの合否の表（揺れ）
L.push(`\n## 回ごとの合否（○合格・△道は正解・✕道も外れ・-なし）`);
L.push(`  id   型 | ${LABELS.map((l) => l.slice(0, 14)).join(" | ")} | 道の正解の回/回`);
for (const p of probs.filter((p) => !ONLY.length || ONLY.includes(p.id))) {
  let pathHits = 0, n = 0;
  const cells = LABELS.map((l) => {
    const r = runs.get(l)!.find((x) => x.id === p.id);
    if (!r) return "-";
    n++; const ok = pathOk(p, r); if (ok) pathHits++;
    return passOf(p, r) ? "○" : ok ? "△" : "✕";
  });
  L.push(`  ${p.id} ${p.type.slice(0, 6).padEnd(6, "　")} | ${cells.join(" | ")} | ${pathHits}/${n}`);
}
for (const p of failed) {
  L.push(`\n========== ${p.id} [${p.type}${p.tags?.length ? `・${p.tags.join(",")}` : ""}] sub=${p.sub}`);
  L.push(`正解: ${acceptOf(p).join(" | ")}${p.mustNot?.length ? `  ⛔ ${p.mustNot.join(",")}` : ""}${p.acceptWhen?.searchExhausted ? `（元の accept: ${p.accept.join("|")}）` : ""}`);
  L.push(`理由: ${p.why}`);
  for (const a of p.asks ?? []) L.push(`  依頼: 「${a.q}」→ ${a.route}／${a.point}`);
  for (const g of p.ng ?? []) L.push(`  言ってはいけない: ${g}`);
  const ctx = p.context.slice(-8).map((m) => `   ${m.s === "staff" ? (m.aix ? "S[AIX]" : "S") : "C"}(${m.ago}分前): ${m.t.replace(/\n+/g, "⏎").slice(0, 220)}`);
  L.push(`会話（最後の8通）:\n${ctx.join("\n")}`);
  L.push(`竹内さんの実送信: ${String(p.staffText ?? "").replace(/\n+/g, "⏎").slice(0, 400)}`);
  L.push(`条件: ${JSON.stringify(Object.fromEntries(Object.entries(p.pc ?? {}).filter(([k, v]) => v !== null && v !== "" && !/^ai_summary|personality/.test(k)))).slice(0, 300)}`);
  L.push(`台帳: ${Object.entries(p.ledger ?? {}).map(([t, rs]) => `${t}=${rs.length}`).join(" ")}${(p.ledger?.aix_usage_logs ?? []).length ? `｜AIX: ${(p.ledger!.aix_usage_logs).slice(-5).map((x) => `${String(x.row.aix_type)}(${x.ago}分前)`).join(",")}` : ""}`);
  L.push(`当時の本番のブレイン: ${JSON.stringify(p.prodBrain)}`);
  for (const l of LABELS) {
    const r = runs.get(l)!.find((x) => x.id === p.id);
    if (!r) continue;
    const b = r.brain ?? {};
    const missing = (r.asks ?? []).filter((a) => !a.covered).map((a) => `「${a.q.slice(0, 18)}」(${a.why})`).join(" ");
    const vio = (r.ng ?? []).filter((g) => g.violated).map((g) => `「${g.text.slice(0, 18)}」(${g.why})`).join(" ");
    L.push(`  [${l}] ${passOf(p, r) ? "○" : "✕"} 本質=${r.essence?.code ?? "-"} 最終=${r.path.code} 出どころ=${String(r.trace?.decision_source ?? r.trace?.decision_source_no_aix ?? "-")}${missing ? ` 抜け${missing}` : ""}${vio ? ` 違反${vio}` : ""}`);
    if (l === BASE || l === LABELS[0]) {
      L.push(`     方向: ${String(b.reply_direction ?? "").replace(/\n/g, " ").slice(0, 260)}`);
      if (r.raw) L.push(`     LLM の最初: mode=${r.raw.reply_mode} action=${String(r.raw.action ?? "").slice(0, 60)} 理由=${String(r.raw.reason ?? "").slice(0, 160)}`);
      const tc = b.turn_contract as { asks?: Array<Record<string, unknown>> } | undefined;
      if (tc?.asks?.length) L.push(`     turn_contract.asks: ${tc.asks.map((a) => `${String(a.q ?? a.ask ?? "").slice(0, 30)}→${a.route ?? a.how ?? ""}`).join("／").slice(0, 300)}`);
      if (r.draft?.text) L.push(`     下書き(${r.draft.code}${r.draft.pass ? "○" : "✕"}): ${r.draft.text.replace(/\n+/g, "⏎").slice(0, 220)}`);
    }
  }
}
const s = L.join("\n");
if (OUT) writeFileSync(OUT, s); else console.log(s);
console.error(`問題 ${failed.length}・行 ${s.length}字${OUT ? `→ ${OUT}` : ""}`);
