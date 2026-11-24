// scripts/lib/exam-offonly-key.ts — 2つの main の commit の間の変更が「その試験の構成で off のまま動かない所」だけか（git を読む・LLM なし・DB なし）
// 2026-11-24 作業員A（統括役の頼み: 作り直しの2番目の理由「段に効くファイルの変更」）。見分けは exam-offonly-diff.ts（迷う物は作り直す）。
//   使う所: scripts/audit-exam-offonly-key.ts（過去に当てる）・scripts/brain-exam.ts の前の持ち越し（EXAM_BASELINE_OFFONLY_KEY=on の時だけ・既定 off）
import { execFileSync } from "node:child_process";
import { defaultsAtCommit } from "./brain-exam-baseline";
import { filesAtCommit, examGraph } from "./exam-scope";
import { parseUnifiedDiff, offOnlyChange, gateSwitchesOf, neutralFunctionsOf, type OffCtx } from "./exam-offonly-diff";

const git = (a: string[], cwd?: string) => { try { return execFileSync("git", a, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };
const SRC = ["app", "lib"];
const isSrc = (p: string) => /\.(ts|tsx)$/.test(p) && !/__tests__|\.test\.tsx?$/.test(p);
// commit の組ごとの判定（同じ組は1回だけ）
/** 判定の控え（commit の組・段・構成の env ごと） */
export const pairMemo = new Map<string, { safe: boolean; why: string; files: number }>();
const textMemo = new Map<string, string | null>();
const textAt = (c: string, p: string) => { const k = `${c}:${p}`; if (!textMemo.has(k)) textMemo.set(k, git(["show", k])); return textMemo.get(k)!; };
const gateSrcMemo = new Map<string, string>(), gateMemo = new Map<string, Map<string, string>>(), defMemo = new Map<string, Map<string, string>>();
// その段の鍵に入るファイル（exam-scope.examStageKeysOf と同じ集め方: ブレインの入口から＋試験の道具が読む app。下書きの段は下書きの入口からも）
const graphMemo = new Map<string, { brain: Set<string>; draft: Set<string> }>();
// 関数の定義だけを git grep で引く（全部のファイルを持つとメモリが足りない）
const defMemo2 = new Map<string, string>();
const defsOf = (c: string, names: string[]) => {
  const want = names.filter((n) => !defMemo2.has(`${c}|${n}`));
  for (let i = 0; i < want.length; i += 40) {
    const chunk = want.slice(i, i + 40);
    const t = git(["grep", "-h", "-A5", "-E", `^(export )?(async )?(function (${chunk.join("|")})\\b|const (${chunk.join("|")}) *=)`, c, "--", ...SRC]) ?? "";
    for (const n of chunk) { const re = new RegExp(`^(?:export )?(?:async )?(?:function ${n}\\b|const ${n} *=)`, "m"); const m = re.exec(t); defMemo2.set(`${c}|${n}`, m ? t.slice(m.index, m.index + 600).split(/\n--\n/)[0] : ""); }
  }
  return names.map((n) => defMemo2.get(`${c}|${n}`) ?? "").filter(Boolean);
};
function stageFiles(commit: string): { brain: Set<string>; draft: Set<string> } {
  const hit = graphMemo.get(commit); if (hit) return hit;
  const g = examGraph(filesAtCommit(commit).files);
  const isApp = (f: string) => f.startsWith("app/") || f.startsWith("lib/");
  const tool = [...g.tool].filter(isApp);
  const brain = new Set([...[...g.brain].filter(isApp), ...tool]), draft = new Set([...brain, ...[...g.draft].filter(isApp)]);
  const res = { brain, draft }; graphMemo.set(commit, res); return res;
}
export function offOnlyBetween(prev: string, cur: string, env: Record<string, string>, stage: "brain" | "draft"): { safe: boolean; why: string; files: number } {
  const k = `${prev}..${cur}|${stage}|${JSON.stringify(env)}`;
  const hit = pairMemo.get(k); if (hit) return hit;
  const diff = git(["diff", "-U0", "--no-color", prev, cur, "--", ...SRC]);
  if (diff === null) { const r = { safe: false, why: "git diff が取れない", files: 0 }; pairMemo.set(k, r); return r; }
  const sf = stageFiles(cur)[stage], sp = stageFiles(prev)[stage];
  const inStage = parseUnifiedDiff(diff).filter((f) => sf.has(f.path) || sp.has(f.path));
  // 段の鍵に入る .ts 以外（json・md の知識・プロンプトの文）が変わったら、中身を読めないので作り直す
  const other = inStage.find((f) => !isSrc(f.path));
  if (other) { const r = { safe: false, why: `作り直す: ${other.path}（.ts でない段のファイルが変わった）`, files: inStage.length }; pairMemo.set(k, r); return r; }
  const files = inStage;
  if (!files.length) { const r = { safe: false, why: "app・lib の .ts の変更が無い（鍵は別の物で変わった＝作り直す）", files: 0 }; pairMemo.set(k, r); return r; }
  const texts = new Map<string, string>();
  for (const f of files) { if (f.isDeleted) continue; const t = textAt(cur, f.path); if (t !== null) texts.set(f.path, t); }
  // ゲートの関数 → スイッチ（cur の app・lib 全部から）・スイッチの既定（cur）
  const all = gateSrcMemo.get(cur) ?? git(["grep", "-h", "-A2", "-E", "^(export )?(const [a-zA-Z]\\w*(On|Mode|Enabled)\\b|function [a-zA-Z]\\w*(On|Mode|Enabled)\\()", cur, "--", ...SRC]) ?? "";
  gateSrcMemo.set(cur, all);
  const gates = gateMemo.get(cur) ?? gateSwitchesOf(all.replace(/^--$/gm, "")); gateMemo.set(cur, gates);
  const names = new Set<string>([...gates.values()]);
  for (const t of texts.values()) for (const m of t.matchAll(/env\??\.([A-Z][A-Z0-9_]+)\b/g)) names.add(m[1]);
  const dk = `${cur}|${[...names].sort().join(",")}`; const defs = defMemo.get(dk) ?? defaultsAtCommit(cur, [...names]); defMemo.set(dk, defs);
  const ctx: OffCtx = {
    switchOff: (n) => { const v = (env[n] ?? defs.get(n) ?? "?").trim().toLowerCase(); return v === "off"; },
    gateSwitch: (fn) => gates.get(fn) ?? null,
  };
  // off なら偽を返す関数（足した行で呼ぶ関数の定義だけ）
  const called = [...new Set(files.flatMap((f) => f.hunks.flatMap((h) => h.added.flatMap((l) => [...l.matchAll(/\b([a-zA-Z]\w{2,})\(/g)].map((m) => m[1])))))].filter((n) => !/^(if|for|while|switch|return|await|import|String|Number|Boolean|Array|Object|JSON|Math|Date|Set|Map|Promise|RegExp|Error|console|parseInt|parseFloat|encodeURIComponent)$/.test(n));
  ctx.neutral = neutralFunctionsOf(defsOf(cur, called.slice(0, 400)), ctx);
  const r0 = offOnlyChange(files, texts, ctx);
  const bad = r0.verdicts.filter((v) => v.kind === "unsafe");
  const kinds = [...new Set(r0.verdicts.map((v) => v.kind))].join("・");
  const r = { safe: r0.safe, why: r0.safe ? `塊 ${r0.verdicts.length}（${kinds}）` : `作り直す: ${bad[0]?.path}:${bad[0]?.at}（${bad[0]?.why}）ほか ${Math.max(0, bad.length - 1)}`, files: files.length };
  pairMemo.set(k, r);
  return r;
}
