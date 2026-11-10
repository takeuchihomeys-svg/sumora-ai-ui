// scripts/lib/exam-reflection-io.ts — 試験の決め直し・振り返りの読み書き（ファイルだけ・LLM も DB も使わない）
// 2026-11-10 作業員8c: 純関数は exam-reflection.ts。ここは係（exam-conductor）と週の台本（exam-reflection-weekly）が読む所だけ
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { examCacheRoot } from "./llm-cassette";
import { reflectRun, replanSuggest, targetsUnchanged, weeklyRowOf, type ReflRow, type Reflection, type Replan, type ReplanCard, type ResultLite, type WeeklyRow } from "./exam-reflection";

const readJson = <T>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch { return d; } };

/** 試験の問題の札（exam-rag の cards・依頼の作業ツリーの spec にある物だけ） */
export function loadReplanCards(cwd: string): ReplanCard[] {
  const specIds = new Set(readJson<Array<{ id: string }>>(join(cwd, "scripts/brain-exam/spec.json"), []).map((x) => x.id));
  const raw = readJson<{ cards?: Record<string, ReplanCard> }>(join(examCacheRoot(), "brain-exam-rag", "cards.json"), {}).cards ?? {};
  return Object.values(raw).filter((c) => specIds.has(c.id));
}

/** 夜の基準に前の答えがある問題（使い回せる） */
export function loadNightlyIds(): Set<string> {
  const B = join(examCacheRoot(), "brain-exam-baseline");
  try { return new Set(readdirSync(B).filter((f) => /^nightly-base-.*\.json$/.test(f)).flatMap((f) => readJson<{ problems?: string[] } | null>(join(B, f), null)?.problems ?? [])); } catch { return new Set(); }
}

/** 同じスイッチの過去の依頼（results/*.json の reflection）で何かを見つけた問題 */
export function hitIdsForSwitch(resDir: string, switchName: string, exceptLabel?: string): Set<string> {
  const out = new Set<string>();
  if (!switchName) return out;
  let files: string[] = [];
  try { files = readdirSync(resDir).filter((f) => f.endsWith(".json") && !f.endsWith(".reps.json")); } catch { return out; }
  for (const f of files) {
    const r = readJson<ResultLite | null>(join(resDir, f), null);
    if (!r || r.switch !== switchName || r.label === exceptLabel || !r.reflection) continue;
    for (const x of r.reflection.found) out.add(x.id);
  }
  return out;
}

/** done/ の依頼から label → 守りの問題（古い結果に守りが書かれていない時に使う） */
export function guardsByLabel(doneDir: string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  let files: string[] = [];
  try { files = readdirSync(doneDir).filter((f) => f.endsWith(".json")); } catch { return m; }
  for (const f of files) {
    const j = readJson<{ label?: string; guards?: string[] } | null>(join(doneDir, f), null);
    if (j?.label && j.guards?.length) m.set(j.label, j.guards);
  }
  return m;
}

/** results/*.json のうち、at が [fromMs, toMs) の brain-exam の結果を週の行にする */
export function readWeeklyRows(resDir: string, doneDir: string, fromMs: number, toMs: number): WeeklyRow[] {
  if (!existsSync(resDir)) return [];
  const gm = guardsByLabel(doneDir);
  const rows: WeeklyRow[] = [];
  for (const f of readdirSync(resDir)) {
    if (!f.endsWith(".json") || f.endsWith(".reps.json") || /^reflection-weekly-/.test(f)) continue;
    const r = readJson<ResultLite | null>(join(resDir, f), null);
    const t = Date.parse(r?.at ?? "");
    if (!r || !Number.isFinite(t) || t < fromMs || t >= toMs) continue;
    const w = weeklyRowOf(r, (label) => gm.get(label) ?? null);
    if (w) rows.push(w);
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * 係（exam-conductor の runJob の最後）から呼ぶ: 振り返りと決め直しの案を作る。止める EXAM_REFLECTION=off（null を返す）
 *   stableOf は札の問題のうち安定（揺れの記録で独立に3回以上同じ答え）の物を返す（係の jobRepsPlan）
 */
export function reflectAndReplan(input: {
  label: string; owner: string; switchName: string; cwd: string; stage: string; ids: string[]; guards: string[];
  cur: ReflRow[]; base: ReflRow[] | null; result: ResultLite; worseN: number | null; resDir: string;
  stableOf?: (ids: string[]) => string[];
  /** 掘り（--dig）は原因を掘る回＝効いたかを見ない＝案を出さない */ dig?: boolean;
}): { reflection: Reflection; replan: Replan | null } | null {
  if ((process.env.EXAM_REFLECTION ?? "").trim().toLowerCase() === "off") return null;
  const ids = input.ids.length ? input.ids : [...new Set(input.cur.map((r) => r.id))]; // RAG で選んだ依頼は only が空＝今の回の行から
  const reflection = reflectRun({ ids, guards: input.guards, rows: input.cur, result: input.result });
  let replan: Replan | null = null;
  if (input.base && input.worseN != null && !input.dig) {
    const g = new Set(input.guards);
    const targets = ids.filter((id) => !g.has(id));
    const tu = targetsUnchanged(input.cur, input.base, targets);
    if (tu.unchanged) {
      const cards = loadReplanCards(input.cwd);
      let stable: string[] = [];
      try { stable = input.stableOf?.(cards.map((c) => c.id)) ?? []; } catch { /* 無くてよい */ }
      replan = replanSuggest({
        targets, jobIds: ids, switchName: input.switchName, label: input.label, owner: input.owner, cwd: input.cwd,
        cards, nightlyIds: loadNightlyIds(), stableIds: new Set(stable), hitIds: hitIdsForSwitch(input.resDir, input.switchName, input.label),
        verdict: { unchanged: true, compared: tu.compared, worseN: input.worseN, pathN: input.result.pathWorse?.length ?? 0, essenceN: input.result.essenceWorse?.length ?? 0 },
        stage: input.stage === "draft" ? "draft" : null,
      });
    }
  }
  return { reflection, replan };
}
