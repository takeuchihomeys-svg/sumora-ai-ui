// scripts/lib/exam-preflight-reach.ts — 試験を積む前の点検: on にするスイッチの材料が、積む問題の写しに入っているか（純関数＋小さな読み口・LLM なし・DB なし・作業員N2・2026-11-23・台帳 #462）
//
// 11/22 夜の穴（作業員A の #648）: ess-1122r-pickupwhy の SIP_JUDGE は9問とも写しに資料の読みが0行＝1度も効かずに「試験で確かめた」事になり、費用だけ払った。
//   結果を見る点検（scripts/audit-exam-switch-reach.ts）は流した後。ここでは積む前に、同じ問題の前の回の写し（results/*.jsonl の ledger.inserted）から
//   「要る材料が0行の問題」を見つけて警告する（既定は警告だけ・積むのは止めない）。前の回が無い問題は分からない＝数えない。
//   あわせて「1回ずつの比べ」（--repeat=1 で前も1回）の警告も出す（11/22 の確かな悪化9本のうち3本がこれ）。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SWITCH_REACH, type SwitchReachDef } from "./exam-switch-reach";

export type PriorLedger = Map<string, Record<string, number>>;
export type PreflightReach = { sw: string; needs: string[]; noMaterial: string[]; withMaterial: string[]; unknown: string[]; warn: boolean };

/** 積む前の届きの点検（純関数）: スイッチごとに、要る材料が前の回の写しで0行の問題・あった問題・前の回が無い問題 */
export function preflightReachOf(onSwitches: readonly string[], ids: readonly string[], prior: PriorLedger, table: Record<string, SwitchReachDef> = SWITCH_REACH): PreflightReach[] {
  const out: PreflightReach[] = [];
  for (const sw of onSwitches) {
    const needs = table[sw]?.needs ?? [];
    if (!needs.length) continue; // 写しの材料が要らないスイッチ（印・指示文）は積む前には分からない
    const noMaterial: string[] = [], withMaterial: string[] = [], unknown: string[] = [];
    for (const id of ids) {
      const l = prior.get(id);
      if (!l) { unknown.push(id); continue; }
      (needs.some((t) => (l[t] ?? 0) > 0) ? withMaterial : noMaterial).push(id);
    }
    out.push({ sw, needs, noMaterial, withMaterial, unknown, warn: noMaterial.length > 0 && withMaterial.length === 0 });
  }
  return out;
}

/**
 * 2026-11-24 作業員L（統括役の頼み・竹内さん 11/24「試験もっと効率よく費用を抑える」・前の晩は $3.82 のうち $3.42 が材料0のスイッチ）:
 *   積む前の関所（純関数）。EXAM_PREFLIGHT_REACH: 既定（未設定・on）＝関所／warn＝今まで通り警告だけ／off＝点検しない。
 *   ・block … on にするスイッチのどれかで、積む問題が全部「要る材料0行」（前の回がある問題だけで・前の回が無い問題が1つでもあれば止めない）＝積まない（--force で越える）
 *   ・drop … 一部の問題だけ0行: 材料の要るスイッチ全部で材料0行の問題を外す（どれか1つのスイッチで材料があれば残す）。外すと何も残らない時は block
 */
export type PreflightGate = { mode: "gate" | "warn" | "off"; block: string[]; drop: string[]; keep: string[] };
export function preflightGateMode(env: Record<string, string | undefined> = process.env): PreflightGate["mode"] {
  const v = String(env.EXAM_PREFLIGHT_REACH ?? "").trim().toLowerCase();
  return v === "off" ? "off" : v === "warn" ? "warn" : "gate";
}
export function preflightGate(r: readonly PreflightReach[], ids: readonly string[], mode: PreflightGate["mode"] = "gate"): PreflightGate {
  const out: PreflightGate = { mode, block: [], drop: [], keep: [...ids] };
  if (mode !== "gate") return out;
  const judged = r.filter((x) => x.needs.length);
  if (!judged.length) return out;
  for (const x of judged) if (x.noMaterial.length && !x.withMaterial.length && !x.unknown.length) out.block.push(x.sw);
  if (out.block.length) return { ...out, keep: [] };
  const useless = (id: string) => judged.every((x) => x.noMaterial.includes(id));
  out.drop = ids.filter(useless);
  out.keep = ids.filter((id) => !useless(id));
  if (out.drop.length && !out.keep.length) out.block = judged.map((x) => x.sw);
  return out;
}

/** 警告の行（無ければ空） */
export function preflightLines(r: readonly PreflightReach[], o: { repeat?: number } = {}): string[] {
  const lines: string[] = [];
  for (const x of r) {
    if (!x.noMaterial.length) continue;
    lines.push(`⚠ 積む前の点検: ${x.sw} の要る材料（${x.needs.join("・")}）が前の回の写しで0行の問題 ${x.noMaterial.length}/${x.noMaterial.length + x.withMaterial.length + x.unknown.length}（${x.noMaterial.slice(0, 8).join(",")}）${x.warn ? "＝効く問題が1つも無い（この組はスイッチを確かめない・材料の入る問題に替えるか写しに材料を入れる）" : "＝その問題は外すのが良い"}`);
  }
  if ((o.repeat ?? 2) <= 1) lines.push("⚠ 積む前の点検: --repeat=1（前も1回の問題は、1回ずつの比べで確かな悪化と出やすい・--repeat=3 を勧める）");
  return lines;
}

/** 前の回の写し（results/*.jsonl・直近 days 日・問題ごとに ledger.inserted の最大）を読む（積む問題だけ） */
export function readPriorLedger(resultsDir: string, ids: ReadonlySet<string>, o: { days?: number; nowMs?: number } = {}): PriorLedger {
  const out: PriorLedger = new Map();
  if (!existsSync(resultsDir) || !ids.size) return out;
  const since = (o.nowMs ?? Date.now()) - (o.days ?? 14) * 86_400_000;
  for (const f of readdirSync(resultsDir)) {
    if (!f.endsWith(".jsonl") || f.includes(".base-merged")) continue;
    const p = join(resultsDir, f);
    try { if (statSync(p).mtimeMs < since) continue; } catch { continue; }
    let text = "";
    try { text = readFileSync(p, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line) continue;
      const m = /"id":"([^"]+)"/.exec(line.slice(0, 40));
      if (!m || !ids.has(m[1])) continue;
      try {
        const r = JSON.parse(line) as { id: string; ledger?: { inserted?: Record<string, number> } | null };
        const cur = out.get(r.id) ?? {};
        for (const [k, v] of Object.entries(r.ledger?.inserted ?? {})) cur[k] = Math.max(cur[k] ?? 0, Number(v) || 0);
        out.set(r.id, cur);
      } catch { /* 壊れた行は飛ばす */ }
    }
  }
  return out;
}

/** 費用の無駄（純関数）: 回ごとに on のスイッチの届きで分ける。
 *   wasted … on のスイッチが全部「効いていない（印0・材料0）」＝その回の費用は確かめに使われていない
 *   partial … 効いていないスイッチが1つ以上ある（その分の確かめは無い）
 *   unverified … 全部が「確かめられない」（対応表に無い・印が入る前・指示文が全問）＝届いたかが分からない */
export function wastedCostOf(runs: ReadonlyArray<{ label: string; cost: number | null; reach: ReadonlyArray<{ status: string }> }>) {
  const bad = (s: string) => s === "no_material" || s === "not_reached";
  const unv = (s: string) => s === "mark_after_head" || s === "prompt_all" || s === "unknown";
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  let wasted = 0, partial = 0, unverified = 0, total = 0; const w: string[] = [], p: string[] = [], u: string[] = [];
  for (const r of runs) {
    const c = r.cost ?? 0; total += c;
    if (!r.reach.length) continue;
    if (r.reach.every((x) => bad(x.status))) { wasted += c; w.push(r.label); }
    else if (r.reach.some((x) => bad(x.status))) { partial += c; p.push(r.label); }
    else if (r.reach.every((x) => unv(x.status))) { unverified += c; u.push(r.label); }
  }
  return { wasted: r3(wasted), runs: w, partial: r3(partial), partialRuns: p, unverified: r3(unverified), unverifiedRuns: u, total: r3(total) };
}