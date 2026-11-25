// scripts/lib/claude-check-gate.ts — 本番と割れやすい場面の直しは、on の前に Claude で数問だけ確かめる関所（純関数＋置き場の読み・LLM なし）
// 2026-11-25 作業員A（統括役の頼み・「試験のブレインは DeepSeek・本番は Claude」）:
//   audit-model-split（problems.json の prodBrain × results の DeepSeek）で、物件・確認の場面の道が本番の Claude と試験の DeepSeek で 37% 食い違った。
//   その型の問題が効く問題に入っている直しは、DeepSeek の悪化0だけで on にしない＝Claude で最大5問・1回（--stage=brain）の確かめの記録を先に置く。
//   場面の型の表（SPLIT_SCENES）は 11/25 の晩の Claude 20問の結果で決める（今は表の形と読み口だけ・rate は未定）。
//   関所の強さ CLAUDE_CHECK_GATE: 既定 on（記録が無ければ on に進めない・--force で越える・11/26 統括役の決め）／warn（書くだけ）／off
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 割れやすい場面の型（families＝道の系統・正解か本番の道がこの系統に入る問題を当てる）。rate＝今のコードの Claude と DeepSeek が同じ道を選んだ割合（未定は null） */
export type SplitScene = { id: string; label: string; families: string[]; rate: number | null; n: number | null; since: string };
export const SPLIT_SCENES: SplitScene[] = [
  // 11/25 の晩の Claude 20問の結果で rate・n を入れ、割れが小さければ外す（統括役の決め）
  // 11/25 の晩の Claude 16問（a-claude-1125・今のコード）: 試験の DeepSeek と同じ系統 12/16（75%）。割れた4問は全部 DeepSeek 返信 → Claude AIX（見積 2・内覧 1・確認 1）＝Claude は AIX に寄る
  { id: "property_or_check_vs_reply", label: "物件・確認の AIX か返信か", families: ["物件", "確認"], rate: 0.75, n: 16, since: "2026-11-25" },
];

export type GateMode = "off" | "warn" | "on";
export function claudeCheckGateMode(env: Record<string, string | undefined> = process.env): GateMode {
  // 2026-11-26 統括役の決め: 既定 on（返信に倒す直しで効く問題に物件・確認の型があるものは、on の前に Claude で最大5問・1回・Claude の確かめは1晩 $2 まで）。戻す CLAUDE_CHECK_GATE=warn
  const v = (env.CLAUDE_CHECK_GATE ?? "on").trim().toLowerCase();
  return v === "off" ? "off" : v === "on" ? "on" : "warn";
}

/** 道の系統（prod-yardstick-db の aixFamily と同じ分け・ここは問題の正解の文字から読むだけ） */
export function familyOfAnswer(a: string): string {
  // 2段:check／2段:pickup／2段:estimate＝今は返信・後で約束の AIX（その系統の「AIX か返信か」の問題）
  const ts = a.match(/^2段:([a-z_]+)/);
  if (ts) return /check|photo|brought/.test(ts[1]) ? "確認" : /pickup|search/.test(ts[1]) ? "物件" : /estimate/.test(ts[1]) ? "見積" : "返信";
  if (!a.startsWith("AIX:")) return "返信";
  const k = a.slice(4).split("/")[0];
  if (/property_check|acknowledge_check|^確認/.test(k)) return "確認";
  if (/estimate|cost_|^見積/.test(k)) return "見積";
  if (/property_send|property_recommend|new_arrival|^物件/.test(k)) return "物件";
  if (/viewing|meeting|^内覧/.test(k)) return "内覧";
  return k;
}
export type ProblemLite = { id: string; accept?: string[]; mustNot?: string[]; prodBrain?: { mode?: string | null; action?: string | null } | null };
/** 問題が当たる型（無ければ []） */
export function scenesOfProblem(p: ProblemLite, table: readonly SplitScene[] = SPLIT_SCENES): string[] {
  const fams = new Set([...(p.accept ?? []), ...(p.mustNot ?? [])].map(familyOfAnswer));
  if (p.prodBrain?.mode === "aix" && p.prodBrain.action) fams.add(familyOfAnswer(`AIX:${p.prodBrain.action}`));
  return table.filter((s) => s.families.some((f) => fams.has(f))).map((s) => s.id);
}
/** 問題の表（spec.json の正解＋problems.json の本番の道を id で重ねる・作り直す前の新しい問題も spec から読む） */
export function loadProblemsLite(dir = "scripts/brain-exam"): Map<string, ProblemLite> {
  const read = (f: string): ProblemLite[] => { try { const j = JSON.parse(readFileSync(join(dir, f), "utf8")); return (Array.isArray(j) ? j : j.problems ?? Object.values(j)) as ProblemLite[]; } catch { return []; } };
  const m = new Map<string, ProblemLite>();
  for (const p of read("spec.json")) if (p?.id) m.set(p.id, { id: p.id, accept: p.accept, mustNot: p.mustNot });
  for (const p of read("problems.json")) if (p?.id) m.set(p.id, { id: p.id, accept: m.get(p.id)?.accept ?? p.accept, mustNot: m.get(p.id)?.mustNot ?? p.mustNot, prodBrain: p.prodBrain ?? null });
  return m;
}
/** 効く問題のうち Claude の確かめが要る問題（型が当たる物・並びは効く問題の順） */
export function claudeCheckTargets(eff: readonly string[], problems: ReadonlyMap<string, ProblemLite>, table: readonly SplitScene[] = SPLIT_SCENES): Array<{ id: string; scenes: string[] }> {
  return eff.map((id) => ({ id, scenes: problems.get(id) ? scenesOfProblem(problems.get(id)!, table) : [] })).filter((x) => x.scenes.length);
}
/** Claude の確かめの組の名前（記録を探す鍵） */
export const claudeCheckLabel = (sw: string, day: string) => `cc-${sw.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${day}`;
/** 見込み（1問1回・Claude のブレインの段。11/25 の晩の20問の実費で直す） */
/** Claude の確かめは1晩 $2 まで（11/26 統括役の決め） */
export const CLAUDE_CHECK_NIGHT_CAP_USD = 2;
export const CLAUDE_BRAIN_USD_PER_REP = 0.19; // 11/25 の晩の実費: Claude 36回 $3.01＝1問1回 約 $0.19（ブレイン 2回＋判定）

/** 置き場（scripts/brain-exam/results）に、そのスイッチの Claude の確かめの行があるか */
export function claudeCheckRecord(sw: string, resultsDir = "scripts/brain-exam/results"): { label: string; ids: string[]; pass: number; n: number } | null {
  if (!existsSync(resultsDir)) return null;
  const pre = `cc-${sw.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-`;
  const files = readdirSync(resultsDir).filter((f) => f.startsWith(pre) && f.endsWith(".jsonl")).sort();
  if (!files.length) return null;
  const f = files[files.length - 1];
  const rows = readFileSync(join(resultsDir, f), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as { id?: string; model?: string; error?: string; score?: { pass?: boolean } }; } catch { return null; } })
    .filter((r): r is NonNullable<typeof r> => !!r && !!r.id && !r.error && /claude/i.test(String(r.model ?? "")));
  if (!rows.length) return null;
  return { label: f.replace(/\.jsonl$/, ""), ids: [...new Set(rows.map((r) => r.id!))], pass: rows.filter((r) => r.score?.pass).length, n: rows.length };
}

/** on に進める前の判定（純関数に近い形・記録は呼ぶ側が渡す） */
export function claudeGateVerdict(i: { mode: GateMode; targets: Array<{ id: string; scenes: string[] }>; record: ReturnType<typeof claudeCheckRecord> }): { block: boolean; line: string } {
  if (i.mode === "off" || !i.targets.length) return { block: false, line: "" };
  if (i.record) return { block: false, line: `Claude の確かめ: ${i.record.label}（${i.record.pass}/${i.record.n} 合格）` };
  const line = `本番と割れやすい場面（${[...new Set(i.targets.flatMap((t) => t.scenes))].join("・")}）の効く問題 ${i.targets.map((t) => t.id).join(",")} に Claude の確かめの記録が無い（scripts/claude-check-plan.ts で組を作る）`;
  return { block: i.mode === "on", line };
}
