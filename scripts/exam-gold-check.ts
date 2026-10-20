// scripts/exam-gold-check.ts — 試験の正解の食い違いを探して「竹内さんへの確認」の一覧を作る（決まった計算・LLM なし・DB は設計知見を読むだけ）
//
// 2026-10-20 竹内さん（試験のブレインを最優先で改善する・QUALITY⑥）。決め方は scripts/lib/exam-gold-check.ts（単体テストあり）。
//   似た場面（お客様の発言の種類×直前のこちらの送信の種類・札・発言の近さ）なのに、どちらの正解の道で答えてももう片方で外れる組を出す。
//   正解は直さない（竹内さんが決める）。出した一覧は試験の外れの理由の読み手（exam-brain.ts）が「正解が揺れている」の手がかりに使う。
// 実行: npx tsx --env-file=.env.local scripts/exam-gold-check.ts [--min-sim=0.6] [--no-kb] [--json]
// 置き場: <倉庫の根>/.claude/exam-cache/exam-brain/gold-check/（latest.json・<日付>.md）。伏せた問題の札と正解の道だけ（会話の本文は書かない）
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadExamProblems, EXAM_BRAIN_DIR, type AnyProblem } from "./lib/exam-brain-io";
import { findConflicts, groupConflicts, kbHitsFor, sceneWords, custKindOf, staffKindOf, type GoldProblem } from "./lib/exam-gold-check";

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string) => args.includes(`--${k}`);
export const GOLD_CHECK_DIR = join(EXAM_BRAIN_DIR, "gold-check");

function goldOf(p: AnyProblem): GoldProblem {
  const q = p as AnyProblem & { customer?: string; context?: Array<{ s?: string; t?: string; aix?: boolean }>; mustNot?: string[]; why?: string };
  const last = [...(q.context ?? [])].reverse().find((m) => m.s === "staff");
  return { id: q.id, type: q.type, tags: q.tags, accept: q.accept, mustNot: q.mustNot, why: q.why, customer: q.customer, lastStaff: last?.t, lastStaffAix: !!last?.aix };
}

(async () => {
  const { spec, full } = loadExamProblems();
  const ps = spec.map((s) => goldOf({ ...(full.get(s.id) ?? {}), ...s } as AnyProblem));
  const noText = ps.filter((p) => !p.customer).map((p) => p.id);
  const cs = findConflicts(ps.filter((p) => p.customer), { minSim: Number(arg("min-sim", "0.6")) || 0.6 });
  const groups = groupConflicts(cs);
  let kb: Array<{ id: string; title: string; insight?: string; tags?: string[] | null }> = [];
  if (!flag("no-kb")) {
    try { const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""); const { loadKbRows } = await import("./lib/exam-rag-store"); kb = (await loadKbRows(sb)) as typeof kb; }
    catch (e) { console.warn(`（設計知見が読めない → KB の照らしなし: ${String(e).slice(0, 100)}）`); }
  }
  const byId = new Map(ps.map((p) => [p.id, p]));
  const lines: string[] = [`# 竹内さんへの確認（正解の食い違い・${new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ")} JST）`, "", `問題 ${ps.length}問（発言の写しが無い ${noText.length}問は比べない）・食い違いの組 ${cs.length}・束 ${groups.length}`, ""];
  const out = groups.map((g, i) => {
    const members = g.ids.map((id) => byId.get(id)!).filter(Boolean);
    const hits = kbHitsFor(sceneWords(g, members), kb);
    // 正解の道の族（同じ正解の問題をまとめて見せる）
    const fam = new Map<string, string[]>();
    for (const m of members) { const k = (m.accept ?? []).join(" | "); fam.set(k, [...(fam.get(k) ?? []), m.id]); }
    lines.push(`## ${i + 1}. ${g.strong ? "【強い】" : "【弱い】"}場面「${g.scene.replace("|", "・直前に")}」${g.ids.length}問`);
    for (const [k, ids] of fam) lines.push(`- 正解 ${k} … ${ids.join(",")}（${ids.map((id) => byId.get(id)?.type ?? "").filter((x, j, a) => a.indexOf(x) === j).join("・")}）`);
    for (const p of g.pairs.slice(0, 4)) lines.push(`  - ${p.a}×${p.b}（近さ ${p.sim}）: ${p.why}`);
    for (const m of members.slice(0, 6)) if (m.why) lines.push(`  - ${m.id} の正解の理由: ${String(m.why).replace(/\s+/g, " ").slice(0, 80)}`);
    lines.push(hits.length ? `- 関係しそうな設計知見: ${hits.map((h) => `${h.id.slice(0, 8)}「${h.title.slice(0, 40)}」`).join("・")}` : "- 関係しそうな設計知見: 見つからない（新しく決める事かも）");
    lines.push(`- 竹内さんに聞くこと: この場面（${g.scene.replace("|", "・直前に")}）の正解はどれか。どちらも正しいなら、何で分かれるか（例: 約束の結果がもう出ているか・頼まれた中身）を札か正解の理由に書く`, "");
    return { ...g, kb: hits, families: [...fam].map(([accept, ids]) => ({ accept, ids })) };
  });
  if (!groups.length) lines.push("食い違いは見つからない（--min-sim を下げると広く探す）");
  console.log(lines.join("\n"));
  mkdirSync(GOLD_CHECK_DIR, { recursive: true });
  const date = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  writeFileSync(join(GOLD_CHECK_DIR, `${date}.md`), lines.join("\n"));
  writeFileSync(join(GOLD_CHECK_DIR, "latest.json"), JSON.stringify({ at: new Date().toISOString(), n: ps.length, conflicts: cs, groups: out, scene: Object.fromEntries(ps.map((p) => [p.id, `${custKindOf(p.customer)}|${staffKindOf(p.lastStaff, p.lastStaffAix)}`])) }, null, 1));
  console.log(`\n保存: ${join(GOLD_CHECK_DIR, `${date}.md`)}・${join(GOLD_CHECK_DIR, "latest.json")}`);
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
