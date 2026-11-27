// scripts/lib/stage-coverage.ts — 部品のスイッチが段階（rollout の stageOn）で読まれているかの点検（純関数＋ファイルの読み・LLM なし・DB なし）
// 2026-11-27 作業員L（竹内さんの決め 11/27「on の部品は段階（stageOn）で読む形に移し、悪化したら自動で1段戻す」・作業員A と分けた: 拾う所と判定は L・段階の読み口は A）:
//   拾う: app/lib で env.X を "off" と比べる（既定 on）か "on" と比べる（既定 off）スイッチ。
//   段階で読んでいる＝どこかのファイルに stagedOn("X"（A の app/lib/switch-stage.ts・同期）・stageOnNow("X"・stageOn("X"（rollout.ts）の、名前を文字列で直書きした呼び出しがある。
//   名前を変数で渡す物は数えない（点検できない＝書き方の決まり）。今ある物は許しの一覧（stage-coverage-allowlist.json）で警告だけ・一覧に無い新しい物はテストで止める。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NOT_PART_SWITCH_RE } from "./switch-mark-coverage";

/** 1つのファイルの中の env で読むスイッチ（既定 on も既定 off も） */
export function envSwitchesInCode(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/(?:process\.)?env\.([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\s*(?:\?\?\s*""\s*\))?(?:\s*\.\s*trim\(\))?(?:\s*\.\s*toLowerCase\(\))?\s*[!=]==\s*"(?:on|off)"/g)) out.add(m[1]);
  return [...out].sort();
}
/** 1つのファイルの中で段階で読んでいるスイッチ（名前を文字列で直書きした呼び出しだけ） */
export function stagedSwitchesInCode(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/\b(?:stagedOn|stageOnNow|stageOn)\(\s*["'`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)["'`]/g)) out.add(m[1]);
  return [...out].sort();
}
export function scanDir(dir: string): { env: string[]; staged: string[] } {
  const env = new Set<string>(), staged = new Set<string>();
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      if (f === "__tests__" || f === "node_modules") continue;
      const p = join(d, f); let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) { try { const c = readFileSync(p, "utf8"); for (const s of envSwitchesInCode(c)) env.add(s); for (const s of stagedSwitchesInCode(c)) staged.add(s); } catch { /* 読めないファイルは飛ばす */ } }
    }
  };
  walk(dir);
  return { env: [...env].sort(), staged: [...staged].sort() };
}
/** 段階で読んでいるか（純関数）: 段階の読みがある・許しの一覧にある（警告）・新しい（止める） */
export function stageCoverage(envSwitches: readonly string[], staged: ReadonlySet<string>, allow: ReadonlySet<string>): { staged: string[]; allowed: string[]; fresh: string[] } {
  const s: string[] = [], a: string[] = [], f: string[] = [];
  for (const x of envSwitches) { if (NOT_PART_SWITCH_RE.test(x)) continue; (staged.has(x) ? s : allow.has(x) ? a : f).push(x); }
  return { staged: s, allowed: a, fresh: f };
}
