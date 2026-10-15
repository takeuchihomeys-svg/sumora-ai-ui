// scripts/brain-exam-flake.ts — ブレインの試験の揺れの記録を見る・旧の結果から取り込む（LLM を呼ばない・DB を読まない）
//
// 2026-10-15 竹内「試験の API を節約（質は落とさない）」④ の道具。brain-exam.ts --repeat-flaky が読む揺れの記録
//   （<倉庫の根>/.claude/exam-cache/brain-exam-flake/）を、全部の作業ツリーの旧の結果（scripts/brain-exam/results/*.jsonl）と
//   前（main）の取り置きから取り込む。旧の結果は道だけ見る: 同じ実行（label）の中で割れた → 揺れる／録音の再生でない別々の実行 3つ以上・5回以上
//   ずっと同じ道 → 道だけで安定（1回目の道がいつもと違えば足す）。
//
//   取り込む:  npx tsx scripts/brain-exam-flake.ts --import
//   見る:      npx tsx scripts/brain-exam-flake.ts --show [--only=q001,q002] [--model=deepseek-all]
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { FLAKE_DIR, flakeVerdict, importLegacyRows, readObs } from "./lib/exam-flake";
import { BASELINE_DIR, problemHash } from "./lib/brain-exam-baseline";

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string) => args.includes(`--${k}`);

type Row = { id: string; rep: number; at?: string; model?: string; label?: string; path?: { code?: string }; score?: { pass?: boolean }; draft?: { code?: string; pass?: boolean } | null; error?: string };
const readJsonl = (f: string): Row[] => { try { return readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Row]; } catch { return []; } }); } catch { return []; } };

function repoRoot(): string { return dirname(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim()); }

function importAll() {
  const root = repoRoot();
  const dirs = [join(root, "scripts/brain-exam/results")];
  const wtRoot = join(root, ".claude/worktrees");
  if (existsSync(wtRoot)) for (const w of readdirSync(wtRoot)) dirs.push(join(wtRoot, w, "scripts/brain-exam/results"));
  let files = 0, rows = 0;
  const seenLabel = new Set<string>();
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith(".jsonl"))) {
      const label = f.replace(/\.jsonl$/, "");
      if (seenLabel.has(label)) continue; // 同じ label（main の子の結果を写した物など）は1回
      seenLabel.add(label);
      const rs = readJsonl(join(d, f));
      if (!rs.length) continue;
      // 録音の再生（replay/strict）で回した実行は前の答えの写し＝独立でない。録音の前（10/15 より前）と record は独立
      let cassette = ""; try { cassette = String((JSON.parse(readFileSync(join(d, `${label}.meta.json`), "utf8")) as { cassette?: string }).cassette ?? ""); } catch { /* meta が無い */ }
      rows += importLegacyRows(rs, label, undefined, { independent: cassette !== "replay" && cassette !== "strict" }); files++;
    }
  }
  // 前（main）の取り置き（問題ごと・回の行）
  if (existsSync(BASELINE_DIR)) for (const d of readdirSync(BASELINE_DIR)) {
    const full = join(BASELINE_DIR, d);
    let names: string[] = []; try { names = readdirSync(full).filter((x) => x.endsWith(".json") && x !== "config.json"); } catch { continue; }
    for (const n of names) {
      try {
        const b = JSON.parse(readFileSync(join(full, n), "utf8")) as { fromLabel?: string; rows?: Row[] };
        const label = b.fromLabel ?? `baseline-${d}`;
        if (!b.rows?.length || seenLabel.has(`${label}#${n}`)) continue;
        seenLabel.add(`${label}#${n}`);
        rows += importLegacyRows(b.rows, `${label}-${n.replace(/\.json$/, "")}`);
      } catch { /* */ }
    }
  }
  console.log(`取り込んだ: 結果 ${files}ファイル・${rows}行 → ${FLAKE_DIR}`);
}

function show() {
  const only = arg("only").split(",").filter(Boolean);
  const model = arg("model", "deepseek-all");
  const probsFile = "scripts/brain-exam/problems.json";
  const probs = existsSync(probsFile) ? (JSON.parse(readFileSync(probsFile, "utf8")) as Array<{ id: string }>) : [];
  const ids = only.length ? only : existsSync(FLAKE_DIR) ? readdirSync(FLAKE_DIR) : [];
  const byId = new Map(probs.map((p) => [p.id, p]));
  const c = { flaky: 0, stable: 0, unknown: 0 } as Record<string, number>;
  for (const id of ids.sort()) {
    const p = byId.get(id);
    const v = flakeVerdict(readObs(id), { problemHash: p ? problemHash(p) : "-", model });
    c[v.verdict]++;
    if (v.verdict !== "unknown" || only.length) console.log(`${id} ${v.verdict}（${v.why}・記録 ${v.n}）`);
  }
  console.log(`モデル ${model}: 揺れる ${c.flaky}・安定 ${c.stable}・分からない ${c.unknown}`);
}

if (flag("import")) importAll();
else if (flag("show")) show();
else console.log("使い方: --import（旧の結果から揺れを取り込む）／ --show [--only=q001] [--model=deepseek-all]");
