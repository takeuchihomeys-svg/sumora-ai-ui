// scripts/audit-exam-input-drift-heads.ts — 試験の on の回で「最初のブレインの呼び出しの入力が off と違う」元を、プロンプトの見出しごとに分ける（読むだけ・LLM なし・DB なし）
// 実行: npx tsx scripts/audit-exam-input-drift-heads.ts [--days=14] [--max=400] [--json=<file>]
// 2026-11-25 夜 作業員A（台帳 #683・統括役の頼み: 試験の費用の一番大きな元）
//   on の回の行（results の jsonl）で、控え（前の main の答え）があったのに brain_full の要求の印が違った問題×回を拾い、
//   その回の brain_full の要求の本文（録音の置き場 llm-cassette の normBody）と、off の基準の同じ問題×回の brain_full の本文を行ごとに比べる。
//   違った行は、直前の見出し（【…】・「## …」）ごとに数える。見出しの違いだけで入力が変わっていた行（＝その見出しを off と同じに固めれば「効かない」と覚えられる行）を数える。
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { examCacheRoot } from "./lib/llm-cassette";
import { readEntry, DEFAULT_CASSETTE_DIR } from "./lib/llm-cassette";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
const DAYS = Number(arg("days") || 14), MAX = Number(arg("max") || 400);
const RES = arg("results") || "C:/Users/竹内 悠馬/sumora-ai-ui/.claude/worktrees/exam-night/scripts/brain-exam/results";
const BL = join(examCacheRoot(), "brain-exam-baseline");
type Call = { pk: string; key: string; action: string | null; src: string };
type Row = { id: string; rep: number; at?: string; error?: unknown; llmCalls?: Call[]; inputDiff?: { pinned?: number; changed?: string[]; firstChanged?: string } | null };

// off の基準: 問題ごとの答えの行（時刻つき）
const offRows = new Map<string, Array<{ t: number; rows: Row[] }>>();
for (const d of readdirSync(BL)) {
  if (!/^(?:v-[0-9a-f]+|[0-9a-f]{10})-[0-9a-f]{10}$/.test(d)) continue;
  for (const f of readdirSync(join(BL, d))) {
    if (!f.endsWith(".json") || f === "config.json") continue;
    try { const b = JSON.parse(readFileSync(join(BL, d, f), "utf8")) as { id: string; savedAt: string; rows: Row[] }; const a = offRows.get(b.id) ?? []; a.push({ t: Date.parse(b.savedAt), rows: b.rows }); offRows.set(b.id, a); } catch { /* */ }
  }
}
const offCallAt = (id: string, rep: number, t: number): Call | null => {
  const xs = (offRows.get(id) ?? []).filter((x) => x.t <= t).sort((a, b) => b.t - a.t);
  for (const x of xs) { const r = x.rows.find((y) => y.rep === rep && !y.error) ?? x.rows.find((y) => !y.error); const c = r?.llmCalls?.find((c) => c.action === "brain_full"); if (c?.key) return c; }
  return null;
};
const bodyOf = (key: string): string | null => { const e = readEntry(DEFAULT_CASSETTE_DIR, key); return e ? e.normBody : null; };
// 本文 → 行（JSON の文字列の中の \n も行に）
const linesOf = (s: string) => s.replace(/\\n/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
const headOf = (l: string) => { const m = l.match(/【([^】]{1,40})】/) ?? l.match(/^#{1,3}\s*(.{1,40})/); return m ? m[1] : null; };
/** 違った行の見出し（off にあって on に無い行・on にあって off に無い行の、それぞれ直前の見出し） */
function changedHeads(a: string, b: string): { heads: Map<string, number>; nA: number; nB: number } {
  const la = linesOf(a), lb = linesOf(b);
  const sa = new Set(la), sb = new Set(lb);
  const heads = new Map<string, number>();
  const walk = (ls: string[], other: Set<string>) => { let h = "(見出しの前)"; for (const l of ls) { const x = headOf(l); if (x) h = x; if (!other.has(l)) heads.set(h, (heads.get(h) ?? 0) + 1); } };
  walk(la, sb); walk(lb, sa);
  return { heads, nA: la.length, nB: lb.length };
}

const since = Date.now() - DAYS * 86_400_000;
const out: Array<{ file: string; id: string; rep: number; heads: Record<string, number>; why?: string }> = [];
let seen = 0, noOff = 0, noBody = 0;
for (const f of readdirSync(RES)) {
  if (!f.endsWith(".jsonl") || f.startsWith("main-") || f.includes(".base-merged")) continue;
  const p = join(RES, f);
  try { if (statSync(p).mtimeMs < since) continue; } catch { continue; }
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line || out.length >= MAX) continue;
    let r: Row; try { r = JSON.parse(line) as Row; } catch { continue; }
    if (r.error || !(r.inputDiff?.pinned ?? 0) || r.inputDiff?.firstChanged !== "brain_full") continue;
    seen++;
    const on = r.llmCalls?.find((c) => c.action === "brain_full");
    const off = offCallAt(r.id, r.rep, Date.parse(r.at ?? "") || Date.now());
    if (!on?.key || !off) { noOff++; continue; }
    const a = bodyOf(off.key), b = bodyOf(on.key);
    if (!a || !b) { noBody++; continue; }
    const ch = changedHeads(a, b);
    out.push({ file: f, id: r.id, rep: r.rep, heads: Object.fromEntries(ch.heads) });
  }
}
// 見出しごとに、違いが出た行（問題×回）の数
const byHead = new Map<string, number>();
for (const o of out) for (const h of Object.keys(o.heads)) byHead.set(h, (byHead.get(h) ?? 0) + 1);
console.log(`■ brain_full から入力が違った行（直近 ${DAYS}日・控えあり）: 拾った ${seen}・比べた ${out.length}（off の行が無い ${noOff}・録音の本文が無い ${noBody}・上限 ${MAX}）`);
console.log(`  違いが出た見出し（行の数・多い順）:`);
for (const [h, n] of [...byHead].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`    ${h}: ${n}`);
// 1つの見出しだけで違った行（その見出しを固めれば同じ入力になる）
const single = new Map<string, number>();
for (const o of out) { const hs = Object.keys(o.heads); if (hs.length === 1) single.set(hs[0], (single.get(hs[0]) ?? 0) + 1); }
console.log(`  見出し1つだけの違い（その見出しを off と同じにすれば同じ入力）: ${[...single].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([h, n]) => `${h} ${n}`).join("・")}`);
const sz = new Map<number, number>(); for (const o of out) { const k = Math.min(Object.keys(o.heads).length, 5); sz.set(k, (sz.get(k) ?? 0) + 1); }
console.log(`  違った見出しの数ごとの行: ${[...sz].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k}${k === 5 ? "+" : ""}個 ${n}`).join("・")}`);
if (arg("json")) writeFileSync(arg("json"), JSON.stringify(out, null, 1));
