// scripts/exam-problem-rag.ts — 試験の問題を RAG で選ぶ（①埋め込み ②スイッチの説明 ③候補 ⑥手の選びとの突き合わせ）
// 2026-11-27 作業員L（竹内さん 11/27「明日の昼じゃなくて今から作る」・統括役の頼み）。計算は scripts/lib/exam-problem-rag.ts
//   置き場: <exam-cache>/exam-problem-rag.json（問題とスイッチの文の hash と埋め込み・文が同じなら埋め込み直さない）
//   埋め込みは OpenAI text-embedding-3-small を直に（embedding_cache の表には書かない）。文は maskForEmbedding で伏せてから。DB は読まない（--kb の時だけ設計知見を軽く読む）
//   既定は記録だけ: 候補を出すだけで、試験の選びは変えない（EXAM_PROBLEM_RAG=shadow）
// 実行: npx tsx --env-file=.env.local scripts/exam-problem-rag.ts [--switches=A,B|--all-marked] [--k=12] [--out=<json>] [--dry]
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { examCacheRoot } from "./lib/llm-cassette";
import { maskForEmbedding } from "../app/lib/pii-mask";
import { SWITCH_REACH } from "./lib/exam-switch-reach";
import { SWITCH_TARGET_MARK } from "./lib/exam-snapshot-need";
import { loadLearnedReach } from "./lib/exam-learned-reach";
import { SWITCH_SCENE_WORDS, centerVecs, centroidOf, commentsNearSwitch, ragCandidates, ragEvalOf, ragQueryModeOf, reachedIdsOf, subVec, ragMissOf, sceneShapeText, switchSceneText, type RagEvalRun, type RagProblemIn } from "./lib/exam-problem-rag";
import { readRunsWithMarks } from "./build-exam-dictionary";
import type { ExamDictionary } from "./lib/exam-dictionary";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const has = (k: string) => process.argv.includes(`--${k}`);
export const EXAM_PROBLEM_RAG_FILE = () => join(examCacheRoot(), "exam-problem-rag.json");
type Store = { v: 1; model: string; problems: Record<string, { h: string; v: number[] }>; switches: Record<string, { h: string; text: string; v: number[] }>; usage: { tokens: number; calls: number } };
const MODEL = "text-embedding-3-small";
const hashOf = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

async function embedMany(texts: string[]): Promise<{ vs: number[][]; tokens: number }> {
  const raw = process.env.OPENAI_API_KEY ?? ""; const key = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (!key) throw new Error("OPENAI_API_KEY が無い（--env-file=.env.local）");
  const res = await fetch("https://api.openai.com/v1/embeddings", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: MODEL, input: texts }), signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`embeddings ${res.status}`);
  const j = (await res.json()) as { data: Array<{ index: number; embedding: number[] }>; usage?: { total_tokens?: number } };
  const vs: number[][] = []; for (const d of j.data) vs[d.index] = d.embedding;
  return { vs, tokens: j.usage?.total_tokens ?? 0 };
}
function loadStore(): Store { try { const s = JSON.parse(readFileSync(EXAM_PROBLEM_RAG_FILE(), "utf8")) as Store; if (s.v === 1 && s.model === MODEL) return s; } catch { /* 無ければ作る */ } return { v: 1, model: MODEL, problems: {}, switches: {}, usage: { tokens: 0, calls: 0 } }; }

/** ② スイッチの説明の材料: コードのコメント（スイッチ名の出る .ts）・SWITCH_REACH の needs・印 */
function switchParts(sw: string, kb: Record<string, string[]>) {
  let files: string[] = [];
  try { files = execFileSync("git", ["grep", "-l", sw, "--", "app/lib", "app/api", "scripts/lib/exam-switch-reach.ts", "scripts/lib/exam-snapshot-need.ts"], { encoding: "utf8" }).split("\n").filter((f) => f.endsWith(".ts") && !f.includes(".test.")); } catch { /* 無い */ }
  const comments: string[] = [];
  const others = [...Object.keys(SWITCH_TARGET_MARK), ...Object.keys(SWITCH_REACH)];
  // app の部品を先に（試験の表の説明は後）
  files.sort((a, b) => Number(a.startsWith("scripts/")) - Number(b.startsWith("scripts/")));
  for (const f of files.slice(0, 8)) { try { comments.push(...commentsNearSwitch(readFileSync(f, "utf8"), sw, 8, 2, others)); } catch { /* 読めない */ } }
  const def = SWITCH_REACH[sw] as { needs?: string[]; mark?: string } | undefined;
  return { comments: [...new Set(comments)].slice(0, 4), needs: def?.needs ?? [], mark: SWITCH_TARGET_MARK[sw] ?? def?.mark ?? null, kb: kb[sw] ?? [] };
}

if (require.main === module) (async () => {
  const k = Number(arg("k", "12")) || 12; const dry = has("dry");
  const ps = (() => { const j = JSON.parse(readFileSync("scripts/brain-exam/problems.json", "utf8")); return (Array.isArray(j) ? j : j.problems) as RagProblemIn[]; })();
  const store = loadStore();
  // ① 問題の場面の形
  const todo: Array<{ id: string; text: string; h: string }> = [];
  for (const p of ps) { const text = sceneShapeText(p, maskForEmbedding); const h = hashOf(text); if (store.problems[p.id]?.h !== h) todo.push({ id: p.id, text, h }); }
  // ② スイッチの説明
  const sws = has("all-marked") ? [...new Set([...Object.keys(SWITCH_TARGET_MARK), ...Object.entries(SWITCH_REACH).filter(([, d]) => (d as { mark?: string }).mark).map(([s]) => s)])] : arg("switches").split(",").filter(Boolean);
  const kb: Record<string, string[]> = (() => { const f = arg("kb-file"); if (!f || !existsSync(f)) return {}; try { return JSON.parse(readFileSync(f, "utf8")); } catch { return {}; } })();
  const swTodo: Array<{ sw: string; text: string; h: string }> = [];
  for (const sw of sws) { const text = switchSceneText(sw, switchParts(sw, kb)); const h = hashOf(text); if (store.switches[sw]?.h !== h) swTodo.push({ sw, text, h }); }
  // 場面の言葉（SWITCH_SCENE_WORDS）は別の鍵 scene:<名前> で持つ（問題と同じ書き方＝問題の平均を引いて比べる）
  for (const sw of sws) { const text = SWITCH_SCENE_WORDS[sw]; if (!text) continue; const h = hashOf(text); if (store.switches[`scene:${sw}`]?.h !== h) swTodo.push({ sw: `scene:${sw}`, text, h }); }
  const chars = [...todo, ...swTodo].reduce((a, x) => a + x.text.length, 0);
  console.log(`[rag] 問題 ${ps.length}（埋め込み直し ${todo.length}）・スイッチ ${sws.length}（直し ${swTodo.length}）・字数 ${chars}（概算 $${((chars * 1.2) / 1e6 * 0.02).toFixed(5)}）`);
  if (has("show")) { const p = ps.find((x) => x.id === arg("show-id", ps[0].id)); if (p) console.log(sceneShapeText(p, maskForEmbedding)); for (const s of swTodo.slice(0, 2)) console.log(`---\n${s.text}`); }
  if (dry) return;
  const all = [...todo.map((t) => ({ key: `p:${t.id}`, ...t })), ...swTodo.map((t) => ({ key: `s:${t.sw}`, id: t.sw, ...t }))];
  for (let i = 0; i < all.length; i += 96) {
    const part = all.slice(i, i + 96); const { vs, tokens } = await embedMany(part.map((x) => x.text));
    store.usage.tokens += tokens; store.usage.calls++;
    part.forEach((x, j) => { if (x.key.startsWith("p:")) store.problems[x.id] = { h: x.h, v: vs[j] }; else store.switches[x.id] = { h: x.h, text: x.text, v: vs[j] }; });
    writeFileSync(EXAM_PROBLEM_RAG_FILE(), JSON.stringify(store));
  }
  console.log(`[rag] 埋め込み 累計 ${store.usage.tokens} tokens・${store.usage.calls} 回（$${(store.usage.tokens / 1e6 * 0.02).toFixed(5)}）`);
  // ③ 候補 と ⑥ 手の選び（SWITCH_REACH.eff・learned-reach の hit）との突き合わせ
  const dict = (() => { try { return JSON.parse(readFileSync(join(examCacheRoot(), "exam-dictionary.json"), "utf8")) as ExamDictionary; } catch { return null; } })();
  const never = new Set(Object.entries(dict?.problems ?? {}).filter(([, d]) => d.neverPassed).map(([id]) => id));
  const learned = loadLearnedReach(join(examCacheRoot(), "learned-reach.json"));
  const raw: Record<string, number[]> = {}; for (const p of ps) if (store.problems[p.id]) raw[p.id] = store.problems[p.id].v;
  const { mean, centered: vecs } = has("no-center") ? { mean: [] as number[], centered: raw } : centerVecs(raw);
  // 2026-11-27: スイッチの説明どうしも平均を引く（説明は「作業員・台帳・竹内さん」の言葉が共通＝全部のスイッチが同じ問題に寄る）
  const swMean = has("no-center") ? [] : centerVecs(Object.fromEntries(sws.filter((x) => store.switches[x]).map((x) => [x, store.switches[x].v]))).mean;
  const out: Record<string, unknown> = {};
  // ⑤ 前の回（係の結果のファイル・DB なし）: --eval=<results の場所>
  const evalDir = arg("eval");
  const evalRuns: RagEvalRun[] | null = evalDir ? readRunsWithMarks(evalDir).runs.map((r) => ({ label: r.label, switches: r.switches, rows: r.rowsFull })) : null;
  for (const sw of sws) {
    const s = store.switches[sw]; if (!s) continue;
    // 2026-11-27 統括役の決め: 2段＝届いた例が2問以上あれば重心で・無ければ場面の言葉（SWITCH_SCENE_WORDS）・それも無ければ説明
    const marks = [SWITCH_TARGET_MARK[sw], (SWITCH_REACH[sw] as { mark?: string } | undefined)?.mark].filter((x): x is string => !!x);
    const reached = evalRuns ? reachedIdsOf(sw, marks, evalRuns).filter((id) => vecs[id]) : [];
    const sc = store.switches[`scene:${sw}`];
    const mode = ragQueryModeOf(reached.length, !!sc);
    const q = mode === "重心" ? centroidOf(reached, vecs)! : mode === "場面の言葉" ? (mean.length ? subVec(sc.v, mean) : sc.v) : swMean.length ? subVec(s.v, swMean) : s.v;
    // 重心の時は届いた問題そのものは候補から外さない（もう届くと分かっている＝効く問題に入れる）・順位の先頭に置く
    const c0 = ragCandidates(q, vecs, k, never);
    const c = mode === "重心" ? (() => { const r = new Set(reached); const rest = [...c0.eff, ...c0.guard].filter((x) => !r.has(x.id)); const effX = [...reached.map((id) => ({ id, sim: 1 })), ...rest].slice(0, Math.max(k, reached.length)); return { eff: effX, guard: rest.filter((x) => !effX.some((y) => y.id === x.id)).slice(0, k) }; })() : c0;
    const eff = ((SWITCH_REACH[sw] as { eff?: string[] } | undefined)?.eff ?? []);
    const hits = Object.entries(learned?.switches?.[sw]?.problems ?? {}).filter(([, v]) => v.v === "hit").map(([id]) => id);
    const ragIds = [...c.eff, ...c.guard].map((x) => x.id);
    out[sw] = { mode, reached, eff: c.eff, guard: c.guard, vsEff: eff.length ? ragMissOf(ragIds, eff) : null, vsLearned: hits.length ? ragMissOf(ragIds, hits) : null };
    console.log(`${sw} [${mode}]: 効く候補 ${c.eff.map((x) => `${x.id}(${x.sim})`).join(" ")}${eff.length ? ` ／手の eff ${ragMissOf(ragIds, eff).hit.length}/${eff.length}` : ""}${hits.length ? ` ／覚えの hit ${ragMissOf(ragIds, hits).hit.length}/${hits.length}` : ""}`);
    if (evalRuns) {
      const e = ragEvalOf(sw, marks, evalRuns, ragIds, (id) => dict?.problems[id]?.unitUsd ?? 0);
      (out[sw] as Record<string, unknown>).eval = e;
      if (e.runs.length) console.log(`  ⑤ 前の回 ${e.runs.length}組: 今の選び 届いた ${e.now.reached}/${e.now.n}（$${e.now.usd}・届いた1問あたり $${e.now.usdPerReached ?? "-"}）／RAG 候補 ${e.rag.n} のうち走った ${e.rag.ran}・届いた ${e.rag.reached}（まだ走っていない ${e.rag.notRun.length}）／届いたのに RAG が外した ${e.reachedMissedByRag.length}`);
    }
  }
  const o = arg("out"); if (o) writeFileSync(o, JSON.stringify({ at: new Date().toISOString(), k, results: out }, null, 1));
})().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
