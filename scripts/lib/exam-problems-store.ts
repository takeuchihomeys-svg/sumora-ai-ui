// scripts/lib/exam-problems-store.ts — ブレインの試験の問題（伏せた会話の写し＋台帳）を、全部の作業ツリーで共有する置き場
//
// 2026-10-15 竹内「試験の API を節約」③: 作業者（作業ツリー）ごとに scripts/brain-exam/problems.json（8MB・DB を問題ごとに十数回読む）を
//   作り直していた。作り直すと builtAt が変わる → 「前（main）」の取り置きの問題の hash が作業ツリーごとに違い、使い回しが効かなかった。
//   → <倉庫の根>/.claude/exam-cache/brain-exam-problems/<問題 id>/<正解の hash>.json に1問1ファイルで置く。
//      正解の hash は spec.json のその問題の中身（ExamSpec の欄）＝正解を直したら別のファイル（古い正解の問題を使わない）。
//      1問1ファイル・中身は鍵で決まる・一時ファイル → rename で書く＝同時に書いても壊れない（鍵が要らない）。
//   置き場は .gitignore（.claude/exam-cache/）・伏せた会話が入るので倉庫に上げない。止める: EXAM_SHARED_PROBLEMS=off
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { examCacheRoot, stableStringify } from "./llm-cassette";
import { atomicWriteJson } from "./exam-shared-file";

export const SHARED_PROBLEMS_DIR = join(examCacheRoot(), "brain-exam-problems");
/** 正解（spec.json の1問）の欄。問題（ExamProblem）はこれに会話の写し等を足した物 */
export const SPEC_KEYS = ["id", "type", "tags", "source", "conv", "at", "accept", "mustNot", "asks", "ng", "why", "addedAt", "addedBy", "acceptWhen", "acceptStrict", "noDateShift", "property", "stage"] as const;
type AnyObj = Record<string, unknown>;

export function sharedProblemsEnabled(env: Record<string, string | undefined> = process.env): boolean { return String(env.EXAM_SHARED_PROBLEMS ?? "").trim().toLowerCase() !== "off"; }
export function specPart(o: AnyObj): AnyObj {
  const out: AnyObj = {};
  for (const k of SPEC_KEYS) if (o[k] !== undefined) out[k] = o[k];
  return out;
}
/** 正解の hash（spec の1問でも、それから作った問題でも同じ値） */
export function specHashOf(o: AnyObj): string { return createHash("sha256").update(stableStringify(specPart(o))).digest("hex").slice(0, 16); }
export function sharedFileOf(id: string, specHash: string, dir = SHARED_PROBLEMS_DIR): string {
  if (!/^[\w-]+$/.test(id)) throw new Error(`問題 id が置き場の名前にできない: ${id}`);
  return join(dir, id, `${specHash}.json`);
}
export function readSharedProblem<P extends AnyObj>(spec: AnyObj, dir = SHARED_PROBLEMS_DIR): P | null {
  const f = sharedFileOf(String(spec.id), specHashOf(spec), dir);
  if (!existsSync(f)) return null;
  try { const p = JSON.parse(readFileSync(f, "utf8")) as P; return specHashOf(p) === specHashOf(spec) ? p : null; } catch { return null; }
}
/** 作った問題を置く（もう同じ物があれば書かない）。返り値は新しく置いた数 */
export function publishProblems(problems: AnyObj[], dir = SHARED_PROBLEMS_DIR): number {
  let n = 0;
  for (const p of problems) {
    if (!p?.id || !Array.isArray(p.context)) continue; // 正解だけ（作れなかった問題）は置かない
    const f = sharedFileOf(String(p.id), specHashOf(p), dir);
    if (existsSync(f)) continue;
    atomicWriteJson(f, p); n++;
  }
  return n;
}
export type FillResult<P> = { problems: P[]; fromShared: string[]; staleKept: string[]; missing: string[]; changed: boolean };
/**
 * spec.json の順に問題を並べる。手元の問題が今の正解と同じならそれ、違う・無いなら共有の置き場から（同じ正解の物）。
 * どちらにも無ければ、手元の古い問題を残す（今まで通り）・それも無ければ missing（brain-exam-add --rebuild --only= で作る）。
 * spec に無い手元の問題（他の作業で足した物）は後ろに残す。
 */
export function fillProblemsFromShared<P extends AnyObj>(spec: AnyObj[], local: P[], o: { dir?: string; addMissing?: (id: string) => boolean } = {}): FillResult<P> {
  const dir = o.dir ?? SHARED_PROBLEMS_DIR;
  // 手元に無い問題を足すか（既定: 手元の problems.json が無い時だけ全部足す＝今までの「手元にある問題だけ回す」を変えない）
  const addMissing = o.addMissing ?? (() => local.length === 0);
  const byId = new Map(local.map((p) => [String(p.id), p]));
  const out: P[] = [], fromShared: string[] = [], staleKept: string[] = [], missing: string[] = [];
  const seen = new Set<string>();
  for (const s of spec) {
    const id = String(s.id); seen.add(id);
    const lp = byId.get(id);
    if (!lp && !addMissing(id)) continue;
    if (lp && specHashOf(lp) === specHashOf(s)) { out.push(lp); continue; }
    const sp = readSharedProblem<P>(s, dir);
    if (sp) { out.push(sp); fromShared.push(id); continue; }
    if (lp) { out.push(lp); staleKept.push(id); continue; }
    missing.push(id);
  }
  for (const p of local) if (!seen.has(String(p.id))) out.push(p);
  return { problems: out, fromShared, staleKept, missing, changed: fromShared.length > 0 };
}
