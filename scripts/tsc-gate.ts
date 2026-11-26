// scripts/tsc-gate.ts — 型エラーを「基準より増えたら止める」（2026-11-27 / 2.8.313）
//
// 絶対ルール5「コミット前に npx tsc --noEmit・型エラーのある状態でコミット禁止」を、コミットの見張り（.githooks/pre-commit）が
// 見ていなかった（実測: 型エラー8ファイルが残ったままコミットが通った）。
//   ・すでにある型エラー（今回触っていない無関係な試験）は基準に置く（隠すためではなく、新しい物を見分けるため）。
//   ・基準に無い型エラーが1つでも出たら終了コード 1（コミットを止める）。
//   ・直したら --write-baseline で基準を縮める（増やす方向には使わせない）。
//
//   npx tsx scripts/tsc-gate.ts                  … 比べる（約 70 秒）
//   npx tsx scripts/tsc-gate.ts --write-baseline … 今の型エラーを基準にする（縮める時だけ・増える時は --allow-grow）
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const BASE = path.join(process.cwd(), "scripts", "_tsc-baseline.json");
const argv = process.argv.slice(2);

type Baseline = { at: string; note: string; errors: string[] };

/** 型エラー1行を「場所の行番号に依らない」形にする（行・桁が動いても同じ物と見る） */
export function keyOfTscLine(line: string): string | null {
  const m = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
  if (!m) return null;
  return `${m[1].replace(/\\/g, "/")}|${m[4]}|${m[5].replace(/\s+/g, " ").slice(0, 110)}`;
}

function loadBase(): Baseline | null {
  try { return JSON.parse(fs.readFileSync(BASE, "utf8")) as Baseline; } catch { return null; }
}

function main() {
  const bin = path.join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
  const r = spawnSync(process.execPath, [bin, "--noEmit", "--pretty", "false"], { cwd: process.cwd(), encoding: "utf8", maxBuffer: 1 << 28 });
  const out = (r.stdout || "") + (r.stderr || "");
  const keys = [...new Set(out.split(/\r?\n/).map(keyOfTscLine).filter((k): k is string => !!k))].sort();
  console.log(`■ 型エラー ${keys.length}件（tsc --noEmit・場所の行番号は見ない）`);
  if (r.status !== 0 && keys.length === 0) {
    console.log("❌ tsc が失敗したが型エラーの行が読めない（環境の問題の恐れ）");
    console.log(out.trim().split(/\r?\n/).slice(-5).join("\n"));
    process.exit(1);
  }
  const base = loadBase();

  if (argv.includes("--write-baseline")) {
    const prev = base ? new Set(base.errors) : null;
    const added = prev ? keys.filter((k) => !prev.has(k)) : [];
    if (added.length && !argv.includes("--allow-grow")) {
      console.log(`❌ 基準より型エラーが増える（${added.length}件）。先に直す（どうしても増やすなら --allow-grow と理由を記録）`);
      added.slice(0, 10).forEach((k) => console.log(`   + ${k}`));
      process.exit(1);
    }
    const o: Baseline = {
      at: new Date().toISOString(),
      note: "今ある型エラー（今回の変更に関係ない物）の基準。隠すためではなく、新しい型エラーを見分けるため。直したら --write-baseline で縮める。増やさない。",
      errors: keys,
    };
    fs.writeFileSync(BASE, JSON.stringify(o, null, 2) + "\n", "utf8");
    console.log(`基準を書きました（${keys.length}件${prev ? `・前 ${prev.size}件` : ""}）`);
    return;
  }

  if (!base) { console.log("❌ 基準が無い（--write-baseline で作る）"); process.exit(1); }
  const known = new Set(base.errors);
  const fresh = keys.filter((k) => !known.has(k));
  const healed = base.errors.filter((k) => !keys.includes(k));
  console.log(`  基準 ${base.errors.length}件（${base.at.slice(0, 10)}）`);
  if (healed.length) console.log(`  ✅ 直っていた ${healed.length}件（--write-baseline で基準から外せる）`);
  if (fresh.length) {
    console.log(`  ❌ 新しい型エラー ${fresh.length}件（基準に無い＝今の変更で増えた）`);
    fresh.slice(0, 20).forEach((k) => console.log(`     ✗ ${k}`));
    process.exit(1);
  }
  console.log("  ✅ 新しい型エラーは無い");
}

main();
