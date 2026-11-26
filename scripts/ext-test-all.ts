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

type Baseline = {
  at: string; note: string; red: string[];
  /**
   * 2.8.313: 赤のファイルごとの「失敗した項目」（数字・版・→以降は丸める）。
   * ファイル単位の基準では、すでに赤のファイルの中に新しい失敗が増えても見えなかった（実測: 赤112本のうち、
   * 今回の変更が触る所を見張る試験も赤で、中の失敗が増えても「古い赤」として通っていた）。
   */
  fails?: Record<string, string[]>;
};

/** 失敗の行を比べやすい形にする（版・数字・→以降の値は変わるので丸める） */
export function normFail(line: string): string {
  return line.trim().split(" → ")[0].replace(/\d+(\.\d+)*/g, "#").replace(/\s+/g, " ").slice(0, 140);
}

type RunRes = { name: string; red: boolean; ng: number; code: number | null; timedOut: boolean; tail: string; fails: string[] };

function loadBase(): Baseline | null {
  try { return JSON.parse(fs.readFileSync(BASE, "utf8")) as Baseline; } catch { return null; }
}

function run(file: string): Promise<RunRes> {
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
      const fails = [...new Set(out.split(/\r?\n/).filter((l) => /^\s*(NG:|✗|❌|FAIL)/.test(l)).map(normFail))];
      resolve({ name: file, red: code !== 0 || ng > 0 || timedOut, ng, code, timedOut, tail, fails });
    });
    p.on("error", (err) => { clearTimeout(timer); resolve({ name: file, red: true, ng: 0, code: null, timedOut: false, tail: String(err), fails: [] }); });
  });
}

async function main() {
  const base = loadBase();
  if (argv.includes("--list")) {
    console.log(base ? base.red.join("\n") : "基準なし");
    return;
  }
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".test.js")).sort();
  const results: RunRes[] = [];
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
    const failsOut: Record<string, string[]> = {};
    for (const r of results) if (r.red && r.fails.length) failsOut[r.name] = r.fails.slice().sort();
    const out: Baseline = {
      at: new Date().toISOString(),
      note: "未整理の古い赤の一覧（隠すためではなく、新しい赤を見分けるための基準）。直したら --write-baseline で縮める。増やさない。fails は赤のファイルごとの失敗項目（中の失敗が増えたら止める）。",
      red,
      fails: failsOut,
    };
    fs.writeFileSync(BASE, JSON.stringify(out, null, 2) + "\n", "utf8");
    console.log(`基準を書きました（赤 ${red.length}本${prev ? `・前 ${prev.size}本` : ""}）`);
    return;
  }

  if (!base) { console.log("❌ 基準が無い（--write-baseline で作る）"); process.exit(1); }
  const known = new Set(base.red);
  let fresh = red.filter((n) => !known.has(n));
  const healed = base.red.filter((n) => !red.includes(n));

  // 2.8.313 乱数（seed）で動く試験は回ごとに赤・青が変わる（実測: bulk-loop-chaos・ai-customer-mode）。
  //   1回の赤で止めると誤報になり、基準に入れると本物を隠す → 疑わしい物だけ2回やり直し、毎回赤の物だけ止める。不安定な物は別に出す。
  const innerFirst = new Map<string, string[]>();
  if (base.fails) {
    for (const r of results) {
      if (!r.red || !known.has(r.name) || !(r.name in base.fails)) continue;
      const was = new Set(base.fails[r.name]);
      const add = r.fails.filter((l) => !was.has(l));
      if (add.length) innerFirst.set(r.name, add);
    }
  }
  const suspects = [...new Set([...fresh, ...innerFirst.keys()])];
  const flaky: string[] = [];
  if (suspects.length) {
    const reruns = new Map<string, RunRes[]>();
    for (const f of suspects) {
      const rs: RunRes[] = [];
      for (let k = 0; k < 2; k++) rs.push(await run(f));
      reruns.set(f, rs);
    }
    fresh = fresh.filter((f) => {
      const all = reruns.get(f) ?? [];
      const stable = all.every((x) => x.red);
      if (!stable) flaky.push(`${f}（3回中 ${1 + all.filter((x) => x.red).length}回赤）`);
      return stable;
    });
    for (const [f, add] of [...innerFirst]) {
      const all = reruns.get(f) ?? [];
      const keep = add.filter((l) => all.every((x) => x.fails.includes(l)));
      if (keep.length) innerFirst.set(f, keep); else { innerFirst.delete(f); if (!flaky.some((x) => x.startsWith(f))) flaky.push(`${f}（中の失敗項目が回ごとに変わる）`); }
    }
  }
  if (flaky.length) {
    console.log(`  ⚠ 不安定な試験 ${flaky.length}本（乱数で回ごとに結果が変わる＝止めずに別に出す・本物の間欠の不具合の可能性もあるので放置しない）`);
    flaky.forEach((x) => console.log(`     ~ ${x}`));
  }
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
  // 2.8.313 すでに赤のファイルの「中」で新しく失敗した項目（ファイル単位の基準では見えない）
  if (base.fails) {
    const inner: Array<{ file: string; line: string }> = [];
    // 基準に項目の記録が無いファイル（失敗行を出さない型の試験）は比べられないので、上の集計に入っていない
    for (const [file, lines] of innerFirst) for (const line of lines) inner.push({ file, line });
    if (inner.length) {
      console.log(`  ❌ 赤のファイルの中で新しく失敗した項目 ${inner.length}件（基準に無い＝今の変更で壊した可能性）`);
      inner.slice(0, 20).forEach((x) => console.log(`     ✗ ${x.file} :: ${x.line}`));
      process.exit(1);
    }
    console.log(`  ✅ 赤のファイルの中の失敗項目も基準より増えていない（${Object.keys(base.fails).length}ファイル・${Object.values(base.fails).reduce((a, b) => a + b.length, 0)}項目を比べた）`);
  } else {
    console.log("  ⚠ 基準に失敗項目の記録が無い（--write-baseline で作ると、赤の中の増加も見張れる）");
  }
  console.log("  ✅ 新しい赤は無い（古い赤が残っていることは、上の件数どおり）");
}

main().catch((e) => { console.error(e); process.exit(1); });
