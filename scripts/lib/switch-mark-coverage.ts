// scripts/lib/switch-mark-coverage.ts — 既定 off のスイッチに「材料の印」が決まっているかの点検（純関数＋ファイルの読み・LLM なし・DB なし）
// 2026-11-27 作業員L（統括役の決め③「新しく既定 off の部品を作る時は、材料に入った番に material_marks の印を付け、SWITCH_TARGET_MARK にも足す」）:
//   app/lib の「=== "on"」で読むスイッチ（既定 off の形）を集め、印か要る材料の行（SWITCH_TARGET_MARK・SWITCH_REACH の mark／needs・SNAPSHOT_NEED）が無い物を出す。
//   今ある物は許しの一覧（switch-mark-allowlist.json）で警告だけ。一覧に無い新しいスイッチは、テスト（switch-mark-coverage.test.ts）で止める。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** 1つのファイルの中の既定 off のスイッチの名前（env.X / process.env.X を "on" と比べる形） */
export function offSwitchesInCode(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/(?:process\.)?env\.([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\s*(?:\?\?\s*""\s*\))?(?:\s*\.\s*trim\(\))?(?:\s*\.\s*toLowerCase\(\))?\s*===\s*"on"/g)) out.add(m[1]);
  return [...out].sort();
}
export function offSwitchesInDir(dir: string): string[] {
  const out = new Set<string>();
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (f === "__tests__" || f === "node_modules") continue;
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) { try { for (const s of offSwitchesInCode(readFileSync(p, "utf8"))) out.add(s); } catch { /* 読めないファイルは飛ばす */ } }
    }
  };
  walk(dir);
  return [...out].sort();
}
/** 印の決まっていないスイッチ（純関数）: covered に無い物を、許しの一覧にある物（警告）と新しい物（止める）に分ける */
export function markCoverage(offSwitches: readonly string[], covered: ReadonlySet<string>, allow: ReadonlySet<string>): { covered: string[]; allowed: string[]; fresh: string[] } {
  const c: string[] = [], a: string[] = [], f: string[] = [];
  for (const s of offSwitches) (covered.has(s) ? c : allow.has(s) ? a : f).push(s);
  return { covered: c, allowed: a, fresh: f };
}
