// scripts/ext-test-all.ts — 拡張の試験を「全部」回し、基準（既知の赤）より増えた赤だけを失敗にする（2026-11-26）
//
// 竹内さん「ちゃんと反映されるようにしくみ化／ほかに反映できていない部分あるか」。
//   実測 2026-11-26: tests/chrome-extension は 332 本あるのに、連動の点検（ext-link-check）が回していたのは 15 本だけ。
//   残り 317 本のうち 124 本が赤（コードが進んで試験が置き去り＝コードの文字列を見る古い試験が多い）だった。
//   → 「試験が通っている」の言葉が 15 本ぶんしか裏付けが無かった。
//
// やり方（隠さない）:
//   ・赤の一覧を tests/chrome-extension/_known-red.json に「未整理の古い赤」として置く（件数は毎回表示する）。
//   ・実行: 基準に無い赤（＝新しく壊れた）があれば終了コード 1。基準にある赤が直っていたら「基準から外せる」と出す。
//   ・基準を作り直す／縮める: --write-baseline（直した後に回す。増やす方向には使わない＝新しい赤は先に直す）。
//
//   npx tsx scripts/ext-test-all.ts                  … 比べる（約 1〜2 分）
//   npx tsx scripts/ext-test-all.ts --write-baseline … 今の赤を基準にする（初回／直した後）
//   npx tsx scripts/ext-test-all.ts --list           … 基準の赤の名前を出す
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIR = path.join(ROOT, "tests", "chrome-extension");
const BASE = path.join(DIR, "_known-red.json");
const argv = process.argv.slice(2);

type Baseline = { at: string; note: string; red: string[] };

function loadBase(): Baseline | null {
  try { return JSON.parse(fs.readFileSync(BASE, "utf8")) as Baseline; } catch { return null; }
}

function run(file: string): Promise<{ name: string; red: boolean; ng: number; code: number | null; timedOut: boolean; tail: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(DIR, file)], { cwd: ROOT });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { p.kill(); } catch { /* 終わっていた */ } }, 60_000);
    p.stdout.on("data", (d) => { out += String(d); });
    p.stderr.on("data", (d) => { out += String(d); });
    p.on("close", (code) => {
      clearTimeout(timer);
      const ng = (out.match(/✗/g) ?? []).length;
      const tail = out.trim().split(/\r?\n/).slice(-8).join(" | ");
      resolve({ name: file, red: code !== 0 || ng > 0 || timedOut, ng, code, timedOut, tail });
    });
    p.on("error", (err) => { clearTimeout(timer); resolve({ name: file, red: true, ng: 0, code: null, timedOut: false, tail: String(err) }); });
  });
}

async function main() {
  const base = loadBase();
  if (argv.includes("--list")) {
    console.log(base ? base.red.join("\n") : "基準なし");
    return;
  }
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".test.js")).sort();
  const results: Array<{ name: string; red: boolean; ng: number; code: number | null; timedOut: boolean; tail: string }> = [];
  let i = 0;
  const worker = async () => { while (i < files.length) { const f = files[i++]; results.push(await run(f)); } };
  await Promise.all(Array.from({ length: 8 }, worker));

  const red = results.filter((r) => r.red).map((r) => r.name).sort();
  console.log(`■ 拡張の試験 全${files.length}本: 青 ${files.length - red.length}／赤 ${red.length}`);

  if (argv.includes("--write-baseline")) {
    const prev = base ? new Set(base.red) : null;
    const added = prev ? red.filter((n) => !prev.has(n)) : [];
    if (added.length && !argv.includes("--allow-grow")) {
      console.log(`❌ 基準より赤が増える（${added.length}本）。基準を増やす前に直す（どうしても増やすなら --allow-grow と理由を記録）`);
      added.forEach((n) => console.log(`   + ${n}`));
      process.exit(1);
    }
    const out: Baseline = {
      at: new Date().toISOString(),
      note: "未整理の古い赤の一覧（隠すためではなく、新しい赤を見分けるための基準）。直したら --write-baseline で縮める。増やさない。",
      red,
    };
    fs.writeFileSync(BASE, JSON.stringify(out, null, 2) + "\n", "utf8");
    console.log(`基準を書きました（赤 ${red.length}本${prev ? `・前 ${prev.size}本` : ""}）`);
    return;
  }

  if (!base) { console.log("❌ 基準が無い（--write-baseline で作る）"); process.exit(1); }
  const known = new Set(base.red);
  const fresh = red.filter((n) => !known.has(n));
  const healed = base.red.filter((n) => !red.includes(n));
  console.log(`  基準の赤 ${base.red.length}本（未整理の古い赤・${base.at.slice(0, 10)}）`);
  if (healed.length) console.log(`  ✅ 直っていた ${healed.length}本（--write-baseline で基準から外せる）: ${healed.slice(0, 5).join(" / ")}${healed.length > 5 ? " …" : ""}`);
  if (fresh.length) {
    console.log(`  ❌ 新しく赤になった ${fresh.length}本（基準に無い＝今の変更で壊した可能性）`);
    const byName = new Map(results.map((r) => [r.name, r]));
    fresh.forEach((n) => {
      const r = byName.get(n);
      console.log(`     ✗ ${n} (code=${r?.code}, ng=${r?.ng}, timeout=${r?.timedOut}) :: ${r?.tail ?? ""}`);
    });
    process.exit(1);
  }
  console.log("  ✅ 新しい赤は無い（古い赤が残っていることは、上の件数どおり）");
}

main().catch((e) => { console.error(e); process.exit(1); });
