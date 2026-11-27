// scripts/build-claude-split.ts — 台帳 #799 ③: 本番（Claude）と試験（DeepSeek）の割れの型の表を、置き場の結果から作り直す（読むだけ・LLM なし・DB なし・費用0）
// 2026-11-26 作業員L（統括役の頼み）: 結果（scripts/brain-exam/results/*.jsonl）の Claude の行（model に claude）と同じ問題の DeepSeek の行の道の系統を比べ、
//   系統ごとの一致率を <exam-cache>/claude-split-learned.json に書く（scripts/lib/claude-split-learned.ts）。関所（claude-check-gate.splitScenesNow）が手の表と重ねて読む。
//   晩の費用0の仕事で毎晩流す（exam-night-jobs）。
// 実行: npx tsx scripts/build-claude-split.ts [--results=scripts/brain-exam/results] [--min-n=5] [--max-rate=0.85] [--dry]
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { aixFamily } from "./lib/prod-yardstick-db";
import { splitFamiliesOf, learnedScenesOf, alignByHead, type SplitRow, type LearnedSplitFile } from "./lib/claude-split-learned";
import { CLAUDE_SPLIT_LEARNED_FILE, SPLIT_SCENES } from "./lib/claude-check-gate";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const dir = arg("results", "scripts/brain-exam/results");
const minN = Number(arg("min-n", "5")) || 5, maxRate = Number(arg("max-rate", "0.85")) || 0.85;
/** 道の系統（audit-model-split と同じ: AIX は aixFamily・それ以外は返信・2段は今の通＝返信） */
export const famOfCode = (code: string) => (code.startsWith("AIX:") ? aixFamily(code.slice(4).split("/")[0]) : "返信");

if (require.main === module) {
  const rows: SplitRow[] = [];
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !f.includes(".base-merged")) : [];
  const claudeIds = new Set<string>();
  const all: Array<SplitRow> = [];
  for (const f of files) {
    let txt = ""; try { txt = readFileSync(join(dir, f), "utf8"); } catch { continue; }
    // 版（meta.head）と始めた時刻（meta.startedAt・無ければファイルの時刻）＝同じ版どうしで比べる（alignByHead）
    const meta = (() => { try { return JSON.parse(readFileSync(join(dir, f.replace(/\.jsonl$/, ".meta.json")), "utf8")) as { head?: string; startedAt?: string }; } catch { return null; } })();
    const head = meta?.head ?? null;
    const at = meta?.startedAt ? Date.parse(meta.startedAt) : (() => { try { return statSync(join(dir, f)).mtimeMs; } catch { return 0; } })();
    for (const l of txt.split("\n")) {
      if (!l || !/"model":"[^"]*(claude|deepseek)/i.test(l)) continue;
      try {
        const r = JSON.parse(l) as { id?: string; model?: string; error?: string; path?: { code?: string | null } | null };
        if (!r.id || r.error || !r.path?.code) continue;
        const claude = /claude/i.test(String(r.model ?? ""));
        if (claude) claudeIds.add(r.id);
        all.push({ id: r.id, claude, fam: famOfCode(String(r.path.code)), head, at });
      } catch { /* 壊れた行は飛ばす */ }
    }
  }
  for (const r of all) if (claudeIds.has(r.id)) rows.push(r);
  const al = alignByHead(rows);
  const fams = splitFamiliesOf(al.rows);
  const day = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  const scenes = learnedScenesOf(fams, day, minN, maxRate);
  const out: LearnedSplitFile = { v: 1, builtAt: new Date().toISOString(), minN, maxRate, families: fams, scenes };
  console.log(`Claude の行のある問題 ${claudeIds.size}（結果 ${files.length}本・同じ版でそろった ${al.sameHead}・近い版で補った ${al.nearHead}）・系統ごとの一致: ${Object.entries(fams).map(([k, v]) => `${k} ${v.agree}/${v.n}`).join("・") || "なし"}`);
  console.log(`割れやすい型（一致 ${maxRate} 未満・n ${minN} 以上・返信は外す）: ${scenes.map((s) => `${s.families[0]} ${Math.round((s.rate ?? 0) * 100)}%（${s.n}）`).join("・") || "なし"}／手の表: ${SPLIT_SCENES.map((s) => s.families.join("+")).join("・")}`);
  if (!process.argv.includes("--dry")) { const p = CLAUDE_SPLIT_LEARNED_FILE(); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(out, null, 1)); console.log(`書いた: ${p}`); }
}
