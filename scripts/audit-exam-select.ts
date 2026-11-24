// scripts/audit-exam-select.ts — 「回す問題の最小の組」（scripts/lib/exam-select.ts）を前の7晩に当てる物差し（読むだけ・LLM なし・DB なし）
// 実行: npx tsx scripts/audit-exam-select.ts [--days=7] [--json=<file>]
// 2026-11-24 夜 作業員A（台帳 #683 の広げ・統括役の頼み: 既定 on にする前にこの物差しを見せる）
//   1つの組ごとに: 流した時の材料（前の回の写し・その時より前の物）と off（off の基準の置き場・その時より前の一番新しい答え）で選び直し、
//   全部回した時の結論（確かな悪化の問題 worseSure・良くなった問題＝on で過半数合格・off で過半数外れ）が選んだ組に全部入っているかを見る。見落としは型ごとに出す
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { examCacheRoot } from "./lib/llm-cassette";
import { loadOffPass } from "./lib/exam-worth";
import { readPriorLedger } from "./lib/exam-preflight-reach";
import { SWITCH_REACH } from "./lib/exam-switch-reach";
import { selectMinimal, sameConclusion } from "./lib/exam-select";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
const DAYS = Number(arg("days") || 7);
const readJ = <T>(p: string, d: T): T => { try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return d; } };
const Q = join(examCacheRoot(), "exam-queue"), BL = join(examCacheRoot(), "brain-exam-baseline");
const spec = readJ<Array<{ id: string; type?: string }>>("scripts/brain-exam/spec.json", []);
const typeOf = new Map(spec.map((p) => [p.id, p.type ?? "?"]));
type Job = { label: string; switch?: string; only?: string; stage?: string; createdAt: string; runner?: string; cwd?: string; env?: Record<string, string> };
type Res = { worseSure?: Array<{ id: string }> | number | null; usd?: string | number; verdict?: string };
const since = Date.now() - DAYS * 86_400_000;
const offMemo = new Map<number, ReturnType<typeof loadOffPass>>();
const offAt = (t: number) => { const k = Math.floor(t / 3_600_000); if (!offMemo.has(k)) offMemo.set(k, loadOffPass(BL, t)); return offMemo.get(k)!; };

const rows: Array<{ label: string; n: number; keep: number; usd: number; usdKeep: number; narrowed: boolean; same: boolean | null; missedWorse: string[]; missedBetter: string[]; why: string; dropCounts: Record<string, number> }> = [];
for (const f of existsSync(join(Q, "done")) ? readdirSync(join(Q, "done")) : []) {
  if (!f.endsWith(".json")) continue;
  const j = readJ<Job | null>(join(Q, "done", f), null);
  if (!j?.label || (j.runner && j.runner !== "brain-exam") || !j.only || Date.parse(j.createdAt) < since) continue;
  const res = readJ<Res | null>(join(Q, "results", `${j.label}.json`), null);
  if (!res) continue;
  const ids = j.only.split(",").filter(Boolean);
  const t = Date.parse(j.createdAt);
  // 試すスイッチ（依頼の switch の名前）だけ。env の on には係の設定（examEnv）の既定の物も混じる＝それで「表に無い」と止めない
  const envOn = Object.entries(j.env ?? {}).filter(([, v]) => String(v).trim().toLowerCase() === "on").map(([k]) => k);
  const named = [...String(j.switch ?? "").matchAll(/[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+/g)].map((m) => m[0]);
  const onSw = named.length ? named.filter((n) => envOn.includes(n) || !Object.keys(j.env ?? {}).length) : envOn;
  const resultsDir = join(j.cwd ?? ".", "scripts", "brain-exam", "results");
  const prior = readPriorLedger(resultsDir, new Set(ids), { nowMs: t });
  const off = offAt(t);
  const sel = selectMinimal({ ids, onSwitches: onSw, prior, off, table: SWITCH_REACH, stage: j.stage === "draft" ? "draft" : "brain" });
  // 全部回した時の結論
  const worse = Array.isArray(res.worseSure) ? res.worseSure.map((x) => x.id) : [];
  const onRows = existsSync(join(resultsDir, `${j.label}.jsonl`)) ? readFileSync(join(resultsDir, `${j.label}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as { id: string; error?: unknown; score?: { pass?: boolean } }; } catch { return null; } }).filter((x): x is { id: string; error?: unknown; score?: { pass?: boolean } } => !!x) : null;
  let better: string[] = [];
  if (onRows) {
    const by = new Map<string, boolean[]>();
    for (const r of onRows) if (!r.error) by.set(r.id, [...(by.get(r.id) ?? []), !!r.score?.pass]);
    better = [...by].filter(([id, xs]) => xs.filter(Boolean).length * 2 > xs.length && (() => { const o = off.get(id); return !!o && o.pass * 2 < o.n; })()).map(([id]) => id);
  }
  const sc = onRows || worse.length ? sameConclusion(sel, { worse, better }) : null;
  const usd = Number(String(res.usd ?? "0").replace(/[^0-9.]/g, "")) || 0;
  rows.push({ label: j.label, n: ids.length, keep: sel.keep.length, usd, usdKeep: ids.length ? usd * (sel.keep.length / ids.length) : 0, narrowed: sel.narrowed, same: sc ? sc.same : null, missedWorse: sc?.missedWorse ?? [], missedBetter: sc?.missedBetter ?? [], why: sel.reason, dropCounts: sel.dropCounts });
}
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const nar = rows.filter((r) => r.narrowed), judged = nar.filter((r) => r.same !== null);
const same = judged.filter((r) => r.same);
console.log(`■ 回す問題の最小の組を前の ${DAYS}晩に当てる: 組 ${rows.length}・$${sum(rows.map((r) => r.usd)).toFixed(2)}`);
console.log(`  絞れた組: ${nar.length}（問題 ${sum(nar.map((r) => r.n))} → ${sum(nar.map((r) => r.keep))}）・減る費用の見込み $${sum(nar.map((r) => r.usd - r.usdKeep)).toFixed(2)}（問題の数の割合で按分）`);
console.log(`  同じ結論（確かな悪化・良くなった問題が選んだ組に全部入る）: ${same.length}/${judged.length}（${judged.length ? Math.round((same.length / judged.length) * 100) : 0}%）・比べられない（結果の行が無い）${nar.length - judged.length}`);
const missW = judged.flatMap((r) => r.missedWorse.map((id) => `${r.label}:${id}（${typeOf.get(id)}）`)), missB = judged.flatMap((r) => r.missedBetter.map((id) => `${r.label}:${id}（${typeOf.get(id)}）`));
console.log(`  見落とし: 確かな悪化 ${missW.length}${missW.length ? `（${missW.slice(0, 8).join("・")}）` : ""}・良くなった問題 ${missB.length}${missB.length ? `（${missB.slice(0, 8).join("・")}）` : ""}`);
const notWhy = new Map<string, number>(); for (const r of rows.filter((x) => !x.narrowed)) notWhy.set(r.why.replace(/（[^）]*）/g, "").slice(0, 40), (notWhy.get(r.why.replace(/（[^）]*）/g, "").slice(0, 40)) ?? 0) + 1);
console.log(`  絞らなかった組の理由: ${[...notWhy].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join("・")}`);
const dc = new Map<string, number>(); for (const r of nar) for (const [k, v] of Object.entries(r.dropCounts)) dc.set(k, (dc.get(k) ?? 0) + v);
console.log(`  選ばなかった問題の理由: ${[...dc].map(([k, v]) => `${k} ${v}`).join("・")}`);
if (arg("json")) writeFileSync(arg("json"), JSON.stringify(rows, null, 1));
