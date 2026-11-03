// scripts/exam-handoff.ts — 通しの試験の集計（受け渡しの落ちを番ごとに数える・LLM なし・DB なし）
//
// 2026-11-03 竹内さん「ちゃんと統括と各ブレインが連携できるように」・統括役の指示（通しの試験）:
//   1つの番が 統括 → AIX の統括（相談・差し戻し）→ 構成のブレイン（意図・設計図）→ 書き手 → 確かめ → 統括の決め直し を通る時、
//   どの受け渡しで物が落ちたかを番ごとに記録する（app/lib/conductor-handoff.ts handoffChecks の落ち5種）。
//   回すのは brain-exam（全部のスイッチ on・--stage=draft・deepseek-all・試験の統括の列で1本ずつ）。この台本は、その結果の jsonl を読んで数えるだけ。
//
//   回し方（例・安い時間に試験の統括の列で）:
//     列に足す: exam-conductor.ts --add --label=handoff-all --stage=draft --only=<作業員6の30番＋AIX の番の数問> --repeat=1
//       --env=BRAIN_NEED_REPORT=on,BRAIN_THREE_LAYER=on,BRAIN_MAIN_POINT=on,BRAIN_PLAN_AHEAD=on,BRAIN_MATERIAL_PROVENANCE=on,BRAIN_FLOW_SIGNALS=on,CONDUCTOR_HANDOFF=on,BRAIN_RECHECK=on,AIX_DESK_COMMAND=on,AIX_DESK_CONSULT=on,BRAIN_COMPOSE_BLUEPRINT=on
//     集計: npx tsx scripts/exam-handoff.ts --label=handoff-all [--baseline=<label>] [--json]
//   読む欄（brain-exam の行）: brain.action・brain.main_point・brain.recheck_digest・brain.aix_recheck・brain.aix_desk（作業員1）・
//     draft（下書きの本文）・compose（作業員6の composeDigestLine の1行）・checks（確かめの指摘の数と、決め直しに渡ったか）
//   欄が無い問題は「-」（確かめていない）として数える＝落ちにはしない。
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { handoffChecks, DROP_JA, type HandoffDrop } from "../app/lib/conductor-handoff";

type Row = {
  id: string; rep?: number; type?: string;
  brain?: Record<string, unknown> | null;
  draft?: string | { text?: string } | null;
  compose?: string | null;
  checks?: { findings?: number; routed?: boolean } | null;
};
export type HandoffRowResult = { id: string; rep: number; type: string; digest: string; drops: HandoffDrop[] };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
function deskAnswerOf(b: Record<string, unknown>): string | null {
  const ad = b.aix_desk as { pick?: unknown; sendBack?: unknown } | undefined;
  if (ad && (ad.pick || ad.sendBack)) return str(ad.pick) ?? (ad.sendBack ? "reply" : null);
  const rc = b.aix_recheck as { kind?: unknown; key?: unknown } | undefined;
  if (rc?.kind === "aix") return str(rc.key);
  if (rc?.kind === "not_aix" || rc?.kind === "promise") return "reply";
  return null;
}
const composeMainOf = (line: string | null | undefined) => (line ? (line.match(/メイン=([^ ]+)/)?.[1] ?? null) : null);
const blueprintOkOf = (line: string | null | undefined) => (!line ? null : /設計図から外れ=なし/.test(line) ? true : /設計図から外れ=/.test(line) ? false : null);
const recheckCountOf = (rk: string | null) => { const m = rk?.match(/^s?(\d+)\//); return m ? Number(m[1]) : 0; };

export function scoreHandoffRow(r: Row): HandoffRowResult {
  const b = (r.brain ?? {}) as Record<string, unknown>;
  const finalAction = str(b.action) && b.reply_mode !== "auto_reply" ? String(b.action) : "reply";
  const desk = deskAnswerOf(b);
  const rk = str(b.recheck_digest);
  const draft = typeof r.draft === "string" ? r.draft : r.draft?.text ?? null;
  const res = handoffChecks({
    deskAnswer: desk, finalAction, rechecked: recheckCountOf(rk) > 0,
    mainPoint: str(b.main_point), composeMain: composeMainOf(r.compose), draftText: draft,
    blueprintOk: blueprintOkOf(r.compose), recheckCount: recheckCountOf(rk),
    checkFindings: r.checks?.findings ?? 0, checkRouted: r.checks?.routed ?? false,
  });
  return { id: r.id, rep: r.rep ?? 1, type: r.type ?? "-", digest: res.digest, drops: res.drops };
}

export function summarize(rows: ReadonlyArray<HandoffRowResult>): { n: number; byDrop: Record<HandoffDrop, number>; anyDrop: number } {
  const byDrop = Object.fromEntries((Object.keys(DROP_JA) as HandoffDrop[]).map((k) => [k, 0])) as Record<HandoffDrop, number>;
  let anyDrop = 0;
  for (const r of rows) { if (r.drops.length) anyDrop++; for (const d of r.drops) byDrop[d]++; }
  return { n: rows.length, byDrop, anyDrop };
}

function readLabel(label: string): Row[] {
  const f = join(process.cwd(), "scripts", "brain-exam", "results", `${label}.jsonl`);
  if (!existsSync(f)) throw new Error(`結果が無い: ${f}`);
  return readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l) as Row; } catch { return null; } }).filter((x): x is Row => !!x && !!x.id);
}

function main() {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? null;
  const label = arg("label");
  if (!label) { console.log("使い方: npx tsx scripts/exam-handoff.ts --label=<brain-exam の label> [--baseline=<label>] [--json]"); process.exitCode = 1; return; }
  const cur = readLabel(label).map(scoreHandoffRow);
  const base = arg("baseline") ? readLabel(arg("baseline")!).map(scoreHandoffRow) : null;
  if (process.argv.includes("--json")) { console.log(JSON.stringify({ label, rows: cur, summary: summarize(cur), baseline: base ? summarize(base) : null })); return; }
  const s = summarize(cur);
  console.log(`# 受け渡しの落ち（${label}・${s.n}番・落ちのあった番 ${s.anyDrop}）`);
  for (const [k, v] of Object.entries(s.byDrop)) console.log(`- ${DROP_JA[k as HandoffDrop]}: ${v}${base ? `（前 ${summarize(base).byDrop[k as HandoffDrop]}）` : ""}`);
  console.log("\n## 落ちのあった番");
  for (const r of cur.filter((x) => x.drops.length)) console.log(`- ${r.id}#${r.rep}（${r.type}）${r.digest} … ${r.drops.map((d) => DROP_JA[d]).join("・")}`);
}
if (process.argv[1] && /exam-handoff\.ts$/.test(process.argv[1])) main();
