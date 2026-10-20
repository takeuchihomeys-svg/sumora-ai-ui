// scripts/lib/exam-scope.ts — 直したファイルから「試すべき段階（ブレイン／下書き／両方）」を決める・main の版の鍵（試験に効く所の中身）を出す
//
// 2026-10-15 竹内「試験の API を節約（質は落とさない）」の4つの①②:
//   ① --stage=diff: origin/main との分かれ目から今の作業ツリーまでに変わったファイルを、試験が読むコードの繋がり（import の線）で分ける。
//      ブレインだけが読む → brain（下書きを作らない＝1問 約5回減る）／下書きだけが読む → draft／両方・試験の道具・設定・分からない → draft（安全側＝両方）
//      どこからも読まれない（文書・画面・別の道具）→ none（試験に効かない＝brain の最小で回す）
//      ※ 試験の下書きはブレインの答案を固定して generate-reply を流す（brainMetaDirect）→ 下書きの線はブレインの入口（brain-core 等）の先へ辿らない。
//   ② main の版の鍵: main の commit そのものではなく「試験が読むファイルの中身（blob の hash）」の hash。main が進んでも試験に効く所が同じなら
//      同じ鍵＝前の取り置きをそのまま使う。変わっていれば別の鍵＝古い main の答案を新しい main の比べに使わない。
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { updateJsonFile } from "./exam-shared-file";

export type Stage = "brain" | "draft";
export type ChangeClass = "brain" | "draft" | "both" | "none";
export type FileMap = Map<string, string>;

/** ブレインの段の入口（brain-exam.ts が読む物） */
export const BRAIN_ENTRIES = ["app/lib/brain-core.ts", "app/lib/brain-layers.ts", "app/lib/deepseek-scope.ts", "app/lib/reply-context.ts"];
/** ブレインを走らせる所（下書きの段では答案を固定するので、この先は下書きに効かない） */
const BRAIN_RUNNER = "app/lib/brain-core.ts";
/** 下書きの段の入口（generate-reply・--auto-hint の手がかり） */
export const DRAFT_ENTRIES = ["app/api/generate-reply/route.ts", "app/lib/reply-hint-auto.ts"];
/** 試験の道具（採点・入口・録音・問題）＝変われば全部の段に効く */
export const TOOL_ENTRIES = ["scripts/brain-exam.ts", "scripts/brain-exam-add.ts"];
const TOOL_DATA_RE = /^scripts\/brain-exam\/(?:spec\.json|stage-by-type\.json)$/;
/** 設定（読み込み・型・依存）＝変われば全部に効く */
const CONFIG_RE = /^(?:package\.json|package-lock\.json|tsconfig\.json|next\.config\.[cm]?[jt]s|\.env[\w.-]*)$/;
const CODE_RE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|json)$/;
const TEST_RE = /(?:^|\/)__tests__\/|\.test\.[cm]?[jt]sx?$/;

// ─── import の線 ─────────────────────────────────────────────────────────
const IMPORT_RES = [
  /(?:^|[^\w$.])(?:import|export)\s+(?:type\s+)?[^'"`;]*?\sfrom\s*["']([^"']+)["']/g,
  /(?:^|[^\w$.])import\s*\(\s*["']([^"']+)["']\s*\)/g,
  /(?:^|[^\w$.])require\s*\(\s*["']([^"']+)["']\s*\)/g,
  /(?:^|[^\w$.])import\s+["']([^"']+)["']/g,
];
export function importSpecs(src: string): string[] {
  const out = new Set<string>();
  for (const re of IMPORT_RES) { re.lastIndex = 0; let m: RegExpExecArray | null; while ((m = re.exec(src))) out.add(m[1]); }
  return [...out];
}
const EXTS = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs", ".json", "/index.ts", "/index.tsx", "/index.js"];
/** 倉庫の中のファイルへ解く（パッケージ・node: は null） */
export function resolveSpec(from: string, spec: string, has: (p: string) => boolean): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith("./") || spec.startsWith("../")) base = posix.normalize(posix.join(posix.dirname(from), spec));
  else return null;
  for (const e of EXTS) { const p = base + e; if (has(p)) return p; }
  // .js と書いて .ts を指す（ESM の書き方）
  const js = base.replace(/\.(?:js|mjs)$/, "");
  if (js !== base) for (const e of [".ts", ".tsx", ".mts"]) if (has(js + e)) return js + e;
  return null;
}
/** 入口から辿れるファイル（stop の中のファイルには入るが、その先へは辿らない） */
export function reach(entries: string[], files: FileMap, stop: ReadonlySet<string> = new Set()): Set<string> {
  const seen = new Set<string>();
  const has = (p: string) => files.has(p);
  const q = entries.filter(has);
  while (q.length) {
    const f = q.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    if (stop.has(f) && !entries.includes(f)) continue;
    if (!/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(f)) continue;
    for (const s of importSpecs(files.get(f) ?? "")) { const r = resolveSpec(f, s, has); if (r && !seen.has(r)) q.push(r); }
  }
  return seen;
}

export type ExamGraph = { brain: Set<string>; draft: Set<string>; tool: Set<string> };
export function examGraph(files: FileMap): ExamGraph {
  const brain = reach(BRAIN_ENTRIES, files);
  // 下書きの段はブレインの答案を固定して流す（brainMetaDirect＝generate-reply は runBrainAndNotify を呼ばない）＝ブレインを走らせる brain-core の先は下書きの段では動かない。
  //   2026-10-15 確かめる人: 止めるのは brain-core の先だけ。brain-core 自身は generate-reply が定数（PROPERTY_CONDITION_INQUIRY_RE）を読む＝下書きにも効く（両方）。
  //   reply-context・deepseek-scope は generate-reply が直に使う共有の部品＝止めない（旧はここで止めて消していた＝reply-context を直しても下書きを回さなかった）
  const draft = reach(DRAFT_ENTRIES, files, new Set([BRAIN_RUNNER]));
  const toolAll = reach(TOOL_ENTRIES, files, new Set([...BRAIN_ENTRIES, ...DRAFT_ENTRIES]));
  const tool = new Set([...toolAll].filter((f) => !brain.has(f) && !draft.has(f) && ![...BRAIN_ENTRIES, ...DRAFT_ENTRIES].includes(f)));
  return { brain, draft, tool };
}

export type FileVerdict = { file: string; cls: ChangeClass; why: string };
/** 1つのファイルの分け方。exists=false は消したファイル */
export function classifyFile(file: string, g: ExamGraph, exists = true): FileVerdict {
  const f = file.replace(/\\/g, "/");
  const inB = g.brain.has(f), inD = g.draft.has(f);
  if (inB && inD) return { file: f, cls: "both", why: "ブレインと下書きの両方が読む" };
  if (inB) return { file: f, cls: "brain", why: "ブレインだけが読む" };
  if (inD) return { file: f, cls: "draft", why: "下書きだけが読む" };
  if (g.tool.has(f) || TOOL_DATA_RE.test(f)) return { file: f, cls: "both", why: "試験の道具・問題" };
  if (CONFIG_RE.test(f)) return { file: f, cls: "both", why: "設定" };
  if (TEST_RE.test(f)) return { file: f, cls: "none", why: "単体テスト" };
  if (!exists && CODE_RE.test(f) && f.startsWith("app/")) return { file: f, cls: "both", why: "消した app のコード（読んでいたか分からない＝安全側）" };
  if (CODE_RE.test(f)) return { file: f, cls: "none", why: "試験の入口から読まれない" };
  return { file: f, cls: "none", why: "コードでない（文書・画像等）" };
}
/** 全部のファイルをまとめた段。both か、brain と draft の両方があれば both */
export function combineClasses(vs: FileVerdict[]): ChangeClass {
  const s = new Set(vs.map((v) => v.cls));
  if (s.has("both") || (s.has("brain") && s.has("draft"))) return "both";
  if (s.has("brain")) return "brain";
  if (s.has("draft")) return "draft";
  return "none";
}
/** 段の分け方 → 試験の --stage。分からない・両方は draft（＝ブレインも下書きも回す）。none は brain（最小） */
export function stageOfClass(c: ChangeClass): Stage { return c === "brain" || c === "none" ? "brain" : "draft"; }

// ─── 今の作業ツリーから ───────────────────────────────────────────────────
function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 }).toString();
}
/** 作業ツリーのコード（app/・scripts/）を読む */
export function workingFiles(root = "."): FileMap {
  const m: FileMap = new Map();
  const walk = (rel: string) => {
    let names: string[] = [];
    try { names = readdirSync(join(root, rel)); } catch { return; }
    for (const n of names) {
      if (n === "node_modules" || n.startsWith(".")) continue;
      const r = rel ? `${rel}/${n}` : n;
      let st; try { st = statSync(join(root, r)); } catch { continue; }
      if (st.isDirectory()) walk(r);
      else if (CODE_RE.test(n)) { try { m.set(r, readFileSync(join(root, r), "utf8")); } catch { /* */ } }
    }
  };
  walk("app"); walk("scripts"); walk("lib");
  return m;
}
/** origin/main（無ければ main）との分かれ目 */
export function mergeBaseWithMain(cwd?: string): string | null {
  for (const ref of ["origin/main", "main"]) { try { return git(["merge-base", "HEAD", ref], cwd).trim(); } catch { /* 次 */ } }
  return null;
}
/** 分かれ目から今の作業ツリーまでに変わったファイル（作業中・まだ入れていない新しいファイルも） */
export function changedFiles(base: string, cwd?: string): string[] {
  const out = new Set<string>();
  for (const l of git(["diff", "--name-only", base], cwd).split("\n")) if (l.trim()) out.add(l.trim());
  for (const l of git(["ls-files", "--others", "--exclude-standard"], cwd).split("\n")) if (l.trim()) out.add(l.trim());
  return [...out].sort();
}
export type StageDecision = { stage: Stage; cls: ChangeClass; base: string | null; files: FileVerdict[]; note: string };
/** --stage=diff の決め方。分かれ目が取れない・git が読めない時は両方（draft） */
export function decideStageFromDiff(cwd = "."): StageDecision {
  const base = (() => { try { return mergeBaseWithMain(cwd); } catch { return null; } })();
  if (!base) return { stage: "draft", cls: "both", base: null, files: [], note: "main との分かれ目が分からない → 安全側（両方）" };
  let files: string[];
  try { files = changedFiles(base, cwd); } catch { return { stage: "draft", cls: "both", base, files: [], note: "変わったファイルが読めない → 安全側（両方）" }; }
  const g = examGraph(workingFiles(cwd));
  if (!g.brain.size) return { stage: "draft", cls: "both", base, files: [], note: "ブレインの入口が見つからない → 安全側（両方）" };
  const vs = files.map((f) => classifyFile(f, g, existsSync(join(cwd, f))));
  const cls = combineClasses(vs);
  const note = !files.length ? "main から変わったファイルが無い（試験に効く所の変更なし）" : cls === "none" ? "変わったファイルは試験の入口から読まれない" : "";
  return { stage: stageOfClass(cls), cls, base, files: vs, note };
}

// ─── ② main の版の鍵 ───────────────────────────────────────────────────────
/** commit のコード（app/・scripts/・lib/ の CODE_RE）を git から読む（cat-file --batch で1回） */
export function filesAtCommit(commit: string, cwd?: string): { files: FileMap; blobs: Map<string, string> } {
  const blobs = new Map<string, string>();
  for (const l of git(["ls-tree", "-r", commit], cwd).split("\n")) {
    const m = l.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/);
    if (m) blobs.set(m[2].replace(/^"|"$/g, ""), m[1]);
  }
  const want = [...blobs].filter(([p]) => CODE_RE.test(p) && /^(?:app|scripts|lib)\//.test(p));
  const out = execFileSync("git", ["cat-file", "--batch"], { cwd, input: want.map(([, h]) => h).join("\n") + "\n", maxBuffer: 512 * 1024 * 1024 });
  const files: FileMap = new Map();
  let off = 0, i = 0;
  while (off < out.length && i < want.length) {
    const nl = out.indexOf(0x0a, off);
    const head = out.subarray(off, nl).toString();
    const size = Number(head.split(" ")[2] ?? 0);
    files.set(want[i][0], out.subarray(nl + 1, nl + 1 + size).toString("utf8"));
    off = nl + 1 + size + 1; i++;
  }
  return { files, blobs };
}
/**
 * 試験に効く所の中身の鍵: ブレイン・下書き・試験の道具が読むファイルと設定の blob の hash を並べた sha256。
 * 試験の道具（scripts/brain-exam*・scripts/lib）は main の子では今の作業ツリーから写す（prepareMainWorktree）ので、ここでは app と設定だけを見る。
 */
export function examVersionKeyOf(files: FileMap, blobs: Map<string, string>): string {
  // 鍵は広め（安全側）: 試験の道具・ブレイン・下書きの入口から止めずに辿れる app のファイル全部（入口・別クラウドの包み・記録の網も入る）
  const all = reach([...TOOL_ENTRIES, ...BRAIN_ENTRIES, ...DRAFT_ENTRIES], files);
  const rel = new Set<string>([...all].filter((f) => f.startsWith("app/") || f.startsWith("lib/")));
  for (const p of blobs.keys()) if (CONFIG_RE.test(p) && !p.startsWith(".env")) rel.add(p);
  const lines = [...rel].sort().map((p) => `${p} ${blobs.get(p) ?? "-"}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12);
}
/** commit → 版の鍵（置き場に控える＝同じ commit は2回目から git を読まない） */
export function examVersionKey(commit: string, cacheFile?: string, cwd?: string): string {
  let memo: Record<string, string> = {};
  if (cacheFile && existsSync(cacheFile)) { try { memo = JSON.parse(readFileSync(cacheFile, "utf8")) as Record<string, string>; } catch { memo = {}; } }
  if (memo[commit]) return memo[commit];
  const { files, blobs } = filesAtCommit(commit, cwd);
  const k = examVersionKeyOf(files, blobs);
  // 同時に書いても壊れないよう、鍵の中で読み直して足してから原子的に置き換える
  if (cacheFile) { try { updateJsonFile<Record<string, string>>(cacheFile, () => ({}), (cur) => ({ ...cur, [commit]: k })); } catch { /* 控えられなくても鍵は返す */ } }
  return k;
}

// ─── 2026-10-20 段ごとの main の版の鍵（main が進んでも、その問題の段に効く所が同じなら前の main の答えを持ち越す） ─────────────
/** 鍵の作り方の版（集める範囲を変えたら上げる＝古い鍵（範囲が狭い）とは決して一致しない＝持ち越さない） */
export const STAGE_KEY_VERSION = "sk2";
const stageKeyOf = (paths: Set<string>, blobs: Map<string, string>) => createHash("sha256").update(`${STAGE_KEY_VERSION}\n`).update([...paths].sort().map((p) => `${p} ${blobs.get(p) ?? "-"}`).join("\n")).digest("hex").slice(0, 12);
/**
 * commit の段ごとの鍵: brain＝ブレインの入口から辿れる app・設定／draft＝それに下書きの入口から辿れる物（exam-brain-io.workingScopeKeys と同じ集め方・同じ blob の hash）。
 *   竹内さん 10/20「main が変わっても、問題に関係ないファイルだけなら前の main の答えを使う」: ブレインだけの問題（stage=brain）は下書きだけの変更では答えが変わらない。
 *   試験の道具（scripts/brain-exam*・scripts/lib）は main の子に今の作業ツリーから写す（prepareMainWorktree）ので、ここでは見ない（examVersionKeyOf と同じ）
 */
export function examStageKeysOf(files: FileMap, blobs: Map<string, string>): { brain: string; draft: string } {
  const isApp = (f: string) => f.startsWith("app/") || f.startsWith("lib/");
  const brain = new Set([...reach(BRAIN_ENTRIES, files)].filter(isApp));
  const draft = new Set([...brain, ...[...reach(DRAFT_ENTRIES, files)].filter(isApp)]);
  // 10/20 見直し: 試験の道具（brain-exam.ts 等）が main の子で直接読む app（採点の似た名前・知見の網・値段 等）も答えに効く＝鍵に入れる（examVersionKeyOf と同じ広さ）。
  //   ブレインの鍵には下書きの段だけの物（下書きの入口とその先）は入れない＝下書きだけの変更ではブレインの答えを持ち越せるまま
  const draftOnly = new Set([...draft].filter((f) => !brain.has(f)));
  for (const f of reach(TOOL_ENTRIES, files, new Set([...BRAIN_ENTRIES, ...DRAFT_ENTRIES]))) {
    if (!isApp(f)) continue;
    draft.add(f);
    if (!draftOnly.has(f) && !DRAFT_ENTRIES.includes(f)) brain.add(f);
  }
  for (const p of blobs.keys()) if (CONFIG_RE.test(p) && !p.startsWith(".env")) { brain.add(p); draft.add(p); }
  return { brain: stageKeyOf(brain, blobs), draft: stageKeyOf(draft, blobs) };
}
/** commit → 段ごとの鍵（置き場に控える＝同じ commit は2回目から git を読まない）。読めない commit（手元に無い）は null */
export function examStageKeys(commit: string, cacheFile?: string, cwd?: string): { brain: string; draft: string } | null {
  let memo: Record<string, { brain: string; draft: string }> = {};
  if (cacheFile && existsSync(cacheFile)) { try { memo = JSON.parse(readFileSync(cacheFile, "utf8")) as typeof memo; } catch { memo = {}; } }
  if (memo[commit]) return memo[commit];
  let k: { brain: string; draft: string };
  try { const { files, blobs } = filesAtCommit(commit, cwd); k = examStageKeysOf(files, blobs); } catch { return null; }
  if (cacheFile) { try { updateJsonFile<Record<string, { brain: string; draft: string }>>(cacheFile, () => ({}), (cur) => ({ ...cur, [commit]: k })); } catch { /* 控えられなくても鍵は返す */ } }
  return k;
}
