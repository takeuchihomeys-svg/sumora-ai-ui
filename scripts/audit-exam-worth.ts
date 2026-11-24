// scripts/audit-exam-worth.ts — 積む前の「試験の値打ちの表」（読むだけ・LLM なし・DB は台帳の work_items の off の行だけ＝軽い読み）
// 実行: npx tsx --env-file=.env.local scripts/audit-exam-worth.ts [--days=7] [--no-db] [--json=<file>]
// 2026-11-24 作業員A（竹内さん 11/24「試験の改善を優先する」・統括役の頼み）。計算は scripts/lib/exam-worth.ts
//   今の off の合否: off の基準の置き場（brain-exam-baseline）の一番新しい答え。問題の当て先: night_bundle_candidates の「効く …／守り …」・scene-map.json・前に流した同じスイッチの組
//   前の7晩に当てる: 流した組（係の done と results）の効く問題（only − guards）が、流した時の off で全部合格だった組＝余地0。その費用と、そこで見つかった確かな悪化の数（見落としの恐れ）
import { createClient } from "@supabase/supabase-js";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASELINE_DIR } from "./lib/brain-exam-baseline";
import { examCacheRoot } from "./lib/llm-cassette";
import { worthRow, rankWorth, roomOf, parseCandidateLine, parseCandidateBlocks, type OffPass, type WorthRow } from "./lib/exam-worth";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? "";
const DAYS = Number(arg("days") || 7);
const readJ = <T>(p: string, d: T): T => { try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return d; } };
const spec = readJ<Array<{ id: string; type?: string; source?: string }>>("scripts/brain-exam/spec.json", []);
const sceneMap = readJ<Record<string, { only?: string[] }>>("scripts/brain-exam/scene-map.json", {});

// off の答え（問題ごと・時刻つき）
type OffAt = { t: number; pass: number; n: number };
const offs = new Map<string, OffAt[]>();
for (const d of readdirSync(BASELINE_DIR)) {
  if (!/^(?:v-[0-9a-f]+|[0-9a-f]{10})-[0-9a-f]{10}$/.test(d)) continue;
  for (const f of readdirSync(join(BASELINE_DIR, d))) {
    if (!f.endsWith(".json") || f === "config.json") continue;
    const b = readJ<{ id?: string; savedAt?: string; rows?: Array<{ error?: string; score?: { pass?: boolean } }> } | null>(join(BASELINE_DIR, d, f), null);
    if (!b?.id || !b.savedAt || !b.rows) continue;
    const ok = b.rows.filter((r) => !r.error);
    const a = offs.get(b.id) ?? []; a.push({ t: Date.parse(b.savedAt), pass: ok.filter((r) => r.score?.pass).length, n: ok.length }); offs.set(b.id, a);
  }
}
const offAt = (t: number) => { const m = new Map<string, OffPass>(); for (const [id, a] of offs) { const x = a.filter((o) => o.t <= t && o.n).sort((p, q) => q.t - p.t)[0]; if (x) m.set(id, { pass: x.pass, n: x.n }); } return m; };
const offNow = offAt(Date.now());

// 前に流した組（係の done と results）
const Q = join(examCacheRoot(), "exam-queue");
type Job = { label: string; switch?: string; only?: string; stage?: string; createdAt: string; runner?: string };
type Res = { guards?: string[] | string; usd?: string | number; worseSure?: number; worse?: number; better?: number; verdict?: string; at?: string };
const jobs: Array<Job & { res: Res | null }> = [];
for (const f of existsSync(join(Q, "done")) ? readdirSync(join(Q, "done")) : []) {
  if (!f.endsWith(".json")) continue;
  const j = readJ<Job | null>(join(Q, "done", f), null);
  if (!j?.label || (j.runner && j.runner !== "brain-exam") || !j.only) continue;
  jobs.push({ ...j, res: readJ<Res | null>(join(Q, "results", `${j.label}.json`), null) });
}
const usdOf = (r: Res | null) => Number(String(r?.usd ?? "0").replace(/[^0-9.]/g, "")) || 0;
const guardsOf = (r: Res | null) => (Array.isArray(r?.guards) ? r!.guards : String(r?.guards ?? "").split(/[,・\s]+/)).filter((x) => /^q\d+$/.test(x));

// ── 前の7晩に当てる ──
const since = Date.now() - DAYS * 86_400_000;
const past = jobs.filter((j) => Date.parse(j.createdAt) >= since && j.res);
let r0usd = 0, r0n = 0, r0worse = 0, allUsd = 0, flatUsd = 0, unkUsd = 0;
const r0labels: string[] = [], r0worseLabels: string[] = [];
for (const j of past) {
  const only = String(j.only).split(",").filter(Boolean);
  const g = guardsOf(j.res), eff = only.filter((id) => !g.includes(id));
  const usd = usdOf(j.res); allUsd += usd;
  if ((j.res!.worse ?? 0) === 0 && (j.res!.better ?? 0) === 0) flatUsd += usd;
  const r = roomOf(eff, offAt(Date.parse(j.createdAt)));
  if (r.unknown.length === eff.length) { unkUsd += usd; continue; }
  if (r.room === 0 && !r.unknown.length) {
    r0n++; r0usd += usd; r0labels.push(j.label);
    if ((j.res!.worseSure ?? 0) > 0) { r0worse++; r0worseLabels.push(`${j.label}（確かな悪化 ${j.res!.worseSure}）`); }
  }
}
console.log(`■ 前の ${DAYS}晩に当てる: 流した組 ${past.length}・$${allUsd.toFixed(2)}（差が何も無かった組 $${flatUsd.toFixed(2)}＝${allUsd ? Math.round((flatUsd / allUsd) * 100) : 0}%）`);
console.log(`  余地0（効く問題が流した時の off で全部合格）: ${r0n}組・$${r0usd.toFixed(2)}（${allUsd ? Math.round((r0usd / allUsd) * 100) : 0}%）・その組で見つかった確かな悪化: ${r0worse}組${r0worseLabels.length ? `（${r0worseLabels.slice(0, 6).join("・")}）` : ""}`);
console.log(`  off の答えが無くて余地を出せない組: $${unkUsd.toFixed(2)}`);

// ── 今夜以降の候補と台帳の off の行 ──
const candFile = ["memory/night_bundle_candidates.md", "../../../memory/night_bundle_candidates.md"].find((p) => existsSync(p));
const candLines = candFile ? readFileSync(candFile, "utf8").split(/\r?\n/) : [];
// 新しい書式（「- 組:」の下に「効く:」「守り:」の行）を先に・その組に無いスイッチだけ古い1行の書き方から
const blocks = parseCandidateBlocks(candLines);
const blockSw = new Set(blocks.flatMap((b) => b.switches));
const cands = [...blocks.map((b) => ({ switches: b.switches, eff: b.eff, guards: b.guards, stage: b.stage })), ...candLines.map((l) => parseCandidateLine(l)).filter((x): x is NonNullable<ReturnType<typeof parseCandidateLine>> => !!x && !x.switches.some((w) => blockSw.has(w)))];
const lastJobOf = (sw: string) => jobs.filter((j) => j.switch === sw).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
const rows: WorthRow[] = [];
const seen = new Set<string>();
const addRow = (key: string, sw: string | null, eff: string[], guards: string[], stage: "brain" | "draft") => {
  const k = `${sw ?? key}|${eff.join(",")}`; if (seen.has(k)) return; seen.add(k);
  rows.push(worthRow({ key, switch: sw, stage, eff, guards, off: offNow, spec }));
};
for (const c of cands) addRow(`候補: ${c.switches.slice(0, 2).join("・") || "(名前なし)"}`, c.switches[0] ?? null, c.eff, c.guards, c.stage ?? "brain");
(async () => {
  if (!process.argv.includes("--no-db")) {
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
    const { data } = await sb.from("work_items").select("id, switch_name").eq("stage", "built_off").limit(500);
    for (const w of (data ?? []) as Array<{ id: number; switch_name: string | null }>) {
      const sw = w.switch_name; if (!sw) { addRow(`台帳 #${w.id}`, null, [], [], "brain"); continue; }
      const c = cands.find((x) => x.switches.includes(sw));
      if (c) { addRow(`台帳 #${w.id}`, sw, c.eff, c.guards, c.stage ?? "brain"); continue; }
      const sm = sceneMap[sw]?.only; if (sm?.length) { addRow(`台帳 #${w.id}`, sw, sm, [], "brain"); continue; }
      const lj = lastJobOf(sw);
      if (lj) { const only = String(lj.only).split(",").filter(Boolean), g = guardsOf(lj.res); addRow(`台帳 #${w.id}`, sw, only.filter((x) => !g.includes(x)), g, lj.stage === "draft" ? "draft" : "brain"); continue; }
      addRow(`台帳 #${w.id}`, sw, [], [], "brain");
    }
  }
  const ranked = rankWorth(rows);
  const cnt = (m: WorthRow["mark"]) => ranked.filter((r) => r.mark === m).length;
  console.log(`\n■ 試験の値打ちの表（${ranked.length}行・積む ${cnt("積む")}・余地不明 ${cnt("off の答えが無い（余地不明）")}・当て先なし ${cnt("問題の当て先なし")}・積まない（余地0）${cnt("積まない（余地0）")}）`);
  console.log(`  余地0 の行の費用の合計（積まないで済む見込み）: $${ranked.filter((r) => r.mark === "積まない（余地0）").reduce((s, r) => s + r.usd, 0).toFixed(2)}`);
  for (const r of ranked.filter((x) => x.mark !== "問題の当て先なし").slice(0, 40)) console.log(`  ${r.mark === "積む" ? "○" : r.mark === "積まない（余地0）" ? "✗" : "？"} ${r.key}${r.switch && !r.key.includes(r.switch) ? `（${r.switch}）` : ""}: 余地 ${r.room}/${r.eff.length}${r.roomIds.length ? `（${r.roomIds.join(",")}）` : ""}${r.unknown.length ? `・off なし ${r.unknown.length}` : ""}・重み ${r.weight}・$${r.usd.toFixed(2)}・値打ち ${r.score}`);
  if (arg("json")) writeFileSync(arg("json"), JSON.stringify({ backtest: { groups: past.length, usd: allUsd, flatUsd, room0: { n: r0n, usd: r0usd, worse: r0worse, labels: r0labels, worseLabels: r0worseLabels } }, rows: ranked }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
