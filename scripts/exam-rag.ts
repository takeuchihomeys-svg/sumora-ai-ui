// scripts/exam-rag.ts — 試験の問題の札（場面・言葉・効く部品・正解・前に落ちたか・関係する設計知見）を作る・選び方を見る・知見に結ぶ
//
// 2026-10-16 竹内「試験の問題を DB にためて RAG 検索で選ぶ」「試験と設計知見を連動させる」。LLM は呼ばない（埋め込み text-embedding-3-small と KB の検索だけ）。
//   置き場: 表（exam_problem_index・exam_problem_kb_links）があれば表、無ければ <倉庫の根>/.claude/exam-cache/brain-exam-rag/（.gitignore・伏せた言葉が入る）
//   KB（system_design_thinking）は読むだけ。
// 使い方:
//   札を作る・埋める・近い知見を紐付ける（文が変わった問題だけ埋める・1問 約300トークン＝$0.000006）:
//     npx tsx --env-file=.env.local scripts/exam-rag.ts --index [--only=q001,q002] [--relink]
//   選び方を見る（試験は回さない）: npx tsx --env-file=.env.local scripts/exam-rag.ts --select [--select-n=12] [--select-q="言葉"]
//   直して通った問題を知見に結ぶ: npx tsx --env-file=.env.local scripts/exam-rag.ts --link --problem=q151,q152 --kb=<知見 id|id8|title:題>
//   1問の札と紐付けを見る: npx tsx --env-file=.env.local scripts/exam-rag.ts --show=q151
//   竹内さんの新しいお手本を問題にする: scripts/brain-exam-add.ts --add（正解は竹内さんの実送信）で spec に足し、--tags=お手本 を付ける → 次の --index で札になり、
//     まだ回していない問題として --select=rag に必ず入る（README の例: KAORI さん 10/12 21:01 の物件オススメ2通目）
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_CASSETTE_DIR } from "./lib/llm-cassette";
import { buildIndex, ragSelect, recordFixedLinks } from "./lib/exam-rag-run";
import { loadCards, loadLinks, readPendingLinks } from "./lib/exam-rag-store";
import { fillProblemsFromShared } from "./lib/exam-problems-store";
import { formatLinks, topLinks } from "./lib/exam-rag";

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string) => args.includes(`--${k}`);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

type Prob = { id: string; type: string; tags?: string[]; stage?: string } & Record<string, unknown>;
function problems(): Prob[] {
  const spec = existsSync("scripts/brain-exam/spec.json") ? JSON.parse(readFileSync("scripts/brain-exam/spec.json", "utf8")) as Array<Record<string, unknown>> : [];
  const local = existsSync("scripts/brain-exam/problems.json") ? JSON.parse(readFileSync("scripts/brain-exam/problems.json", "utf8")) as Prob[] : [];
  const r = fillProblemsFromShared<Prob>(spec, local, { addMissing: () => true });
  const only = arg("only").split(",").filter(Boolean);
  return r.problems.filter((p) => Array.isArray(p.context) && (!only.length || only.includes(p.id)));
}
const stageByType: Record<string, string> = (() => { try { return JSON.parse(readFileSync("scripts/brain-exam/stage-by-type.json", "utf8")) as Record<string, string>; } catch { return {}; } })();
/** brain-exam.ts の --stage=auto と同じ（問題の stage → 型 → 札 → *） */
function stageOf(p: Prob): "brain" | "draft" {
  const s = p.stage ?? stageByType[p.type] ?? (p.tags ?? []).map((t) => stageByType[t]).find(Boolean) ?? stageByType["*"];
  return s === "draft" ? "draft" : "brain";
}

(async () => {
  if (flag("index")) {
    const ps = problems();
    await buildIndex(sb, ps as never, { stageOf: stageOf as never, cassetteDir: DEFAULT_CASSETTE_DIR, relink: flag("relink") });
    return;
  }
  if (flag("select")) {
    const ps = problems();
    const r = await ragSelect(sb, ps as never, { stageOf: stageOf as never, topN: Math.max(1, Number(arg("select-n", "12")) || 12), extraQuery: arg("select-q") || undefined, range: arg("select-range") || undefined });
    console.log(`${r.mode === "all" ? "全部" : "RAG"}: ${r.picked.length}/${ps.length}問・段 ${r.decision.cls}・変わったファイル ${r.decision.files.length}・知見の変化 ${r.kbChanged}・当たった知見 ${r.kbHits.length}・埋め込み ${r.tokens}トークン${r.note ? `・${r.note}` : ""}`);
    for (const h of r.kbHits.slice(0, 8)) console.log(`  当たった知見 ${h.id.slice(0, 8)}（${h.score.toFixed(2)}）${(h.title ?? "").slice(0, 60)}`);
    for (const p of r.picked.slice(0, 80)) console.log(`  ${p.must ? "◆" : "・"} ${p.id}: ${p.why.join("／")}`);
    return;
  }
  if (flag("link")) {
    const ids = arg("problem").split(",").filter(Boolean), kb = arg("kb").split(",").filter(Boolean);
    if (!ids.length || !kb.length) throw new Error("--problem=q001,… と --kb=<知見> が要る");
    recordFixedLinks(ids, kb, "手で結んだ");
    console.log(`控えた: ${ids.join(",")} ↔ ${kb.join(",")}。次の --index で知見の id に解いて結ぶ（今すぐ: --index --only=${ids.join(",")}）`);
    return;
  }
  if (arg("show")) {
    const id = arg("show");
    const c = (await loadCards(sb))[id];
    if (!c) { console.log(`${id} の札が無い（--index --only=${id}）`); return; }
    console.log(`${c.id} [${c.type}／${c.sub}] 段 ${c.stage}・正解 ${c.accept.join("|")}・埋め込み ${c.embedding?.length ? "あり" : "なし"}・効く部品 ${c.parts.actions.join(",") || "-"}`);
    console.log(`  言葉: ${c.words.replace(/\n/g, "⏎").slice(0, 200)}`);
    console.log(`  正解の送信: ${c.answer.replace(/\n/g, "⏎").slice(0, 200)}`);
    const ls = topLinks((await loadLinks(sb))[id], 8);
    console.log(`  知見: ${ls.length ? formatLinks(ls) : "なし"}`);
    const pend = readPendingLinks().filter((x) => x.problemId === id);
    if (pend.length) console.log(`  まだ解いていない紐付け: ${pend.map((x) => x.kbRef).join(",")}`);
    return;
  }
  console.log("使い方は先頭のコメント（--index／--select／--link／--show）");
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
