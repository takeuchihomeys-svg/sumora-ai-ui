// scripts/audit-night-cost.ts — 1晩の試験の費用と、削り方ごとの効き（読むだけ・LLM なし・DB は日付と route で絞った読みだけ）
// 2026-11-24 作業員L（統括役の頼み・竹内さん「試験にお金がもったいない」）: 朝の報告を1本で出す。
//   費用: DeepSeek（試験＝llm_usage_logs の route=script:brain-exam-*・判定＝手元の local-llm-spend.jsonl の brain-exam-*）・OpenAI（gpt-*）・Claude（claude-*）
//     ＝今夜と前の7晩の1晩平均を並べる。DeepSeek・OpenAI は app/lib/llm-price の表の単価（DeepSeek の倍の時間は2倍）、Claude は claudeUsageUsd
//   削り方の効き（今日入れた物）: 判定の段（tier）で pro を呼ばなかった答案・守りの問題の数・a（最初の1回が前と同じで回さなかった回）・
//     c（使い回した基準）・入力が同じで呼ばなかった回（pins）・積む前の関所／問題の絞りで外した問題・積まなかった組
//     ＝作業ツリーの results/*.cost.json（書いた時刻で晩に分ける）・係の済んだ依頼（exam-queue/done）・係の記録（conductor.log）
//   晩の区切り: 既定は D 22時〜翌8時（JST・試験の係の時間）。--window=day で D 12時〜翌12時（昼の試験も入れる）
// 実行: npx tsx --env-file=.env.local scripts/audit-night-cost.ts [--night=2026-11-24] [--days=7] [--window=night|day] [--json]
import { createClient } from "@supabase/supabase-js";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { altUsageUsd, claudeUsageUsd } from "../app/lib/llm-price";
import { execFileSync } from "node:child_process";
import { classifyJob, effMetrics, worseNight, proposalFor, REASON_JA, type EffJob, type EffMetrics } from "./lib/exam-efficiency";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const HOME = "C:/Users/竹内 悠馬/sumora-ai-ui";
const CACHE = join(HOME, ".claude", "exam-cache");
const Q = join(CACHE, "exam-queue");
const H = 3_600_000;

/** 晩 D（JST の日付）の [始め, 終わり)（ms） */
export function nightWindow(d: string, win: "night" | "day"): [number, number] {
  const base = Date.parse(`${d}T00:00:00+09:00`);
  return win === "day" ? [base + 12 * H, base + 36 * H] : [base + 22 * H, base + 32 * H];
}
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 24 * H).toISOString().slice(0, 10);

type Cost = { ds: number; dsJudge: number; oa: number; cl: number; calls: number };
type Lever = {
  runs: number; tierAnswers: number; tierNoPro: number; proCalls: number; guards: number; guardJobs: number;
  aSkipped: number; repsSkipped: number; cReused: number; cReusedUsd: number; cRan: number; cChildUsd: number;
  pinned: number; replayUsd: number; idSame: number; idItems: number; gateDropped: number; narrowDropped: number; blocked: number;
  /** 2026-11-25 作業員L（#686 の④）: #683（覚えた材料で問題を絞る）・#684（本番の照らしで余地0の直しを積まない）の効き。
   *   係の記録の行に「（#683）」「（#684）」の印と「N問を外した」「積まない」を書く決まり（作る人はこの形で log する） */
  t683Dropped: number; t684Blocked: number; t684Dropped: number;
};
const zeroCost = (): Cost => ({ ds: 0, dsJudge: 0, oa: 0, cl: 0, calls: 0 });
const zeroLever = (): Lever => ({ runs: 0, tierAnswers: 0, tierNoPro: 0, proCalls: 0, guards: 0, guardJobs: 0, aSkipped: 0, repsSkipped: 0, cReused: 0, cReusedUsd: 0, cRan: 0, cChildUsd: 0, pinned: 0, replayUsd: 0, idSame: 0, idItems: 0, gateDropped: 0, narrowDropped: 0, blocked: 0, t683Dropped: 0, t684Blocked: 0, t684Dropped: 0 });
const total = (c: Cost) => c.ds + c.dsJudge + c.oa + c.cl;

function resultDirs(): string[] {
  const out = [join(HOME, "scripts", "brain-exam", "results")];
  const W = join(HOME, ".claude", "worktrees");
  try { for (const w of readdirSync(W)) out.push(join(W, w, "scripts", "brain-exam", "results")); } catch { /* */ }
  return out.filter((d) => existsSync(d));
}

(async () => {
  const win = (arg("window", "night") === "day" ? "day" : "night") as "night" | "day";
  const days = Math.max(1, Number(arg("days", "7")) || 7);
  // 既定の晩: 今（JST）から10時間前の日付（朝に流すと昨夜になる）
  const night = arg("night", new Date(Date.now() + 9 * H - 10 * H).toISOString().slice(0, 10));
  const nights = Array.from({ length: days + 1 }, (_, i) => addDays(night, i - days)); // 古い順・最後が今夜
  const wins = nights.map((d) => nightWindow(d, win));
  const nightOf = (ms: number) => { for (let i = 0; i < wins.length; i++) if (ms >= wins[i][0] && ms < wins[i][1]) return i; return -1; };
  const cost = nights.map(zeroCost), lev = nights.map(zeroLever);

  // 1) DB: 試験の呼び出し（route=script:brain-exam-*・日付で絞る・1000行ずつ）
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  let dbRows = 0;
  for (const [i, [a, b]] of wins.entries()) {
    let lastId = 0;
    for (let page = 0; page < 200; page++) {
      const { data, error } = await sb.from("llm_usage_logs").select("id, model, created_at, status, input_uncached, cache_read, cache_write, cache_write_5m, cache_write_1h, output_tokens")
        .gte("created_at", new Date(a).toISOString()).lt("created_at", new Date(b).toISOString()).like("route", "script:brain-exam%").gt("id", lastId).order("id", { ascending: true }).limit(1000);
      if (error) throw new Error(error.message);
      const rs = (data ?? []) as Array<{ id: number; model: string | null; status: number | null; created_at: string }>;
      for (const r of rs) {
        lastId = Math.max(lastId, Number(r.id)); dbRows++;
        if (!(r.status != null && r.status >= 1 && r.status < 400)) continue;
        const m = String(r.model ?? "");
        cost[i].calls++;
        if (/^claude/.test(m)) cost[i].cl += claudeUsageUsd(r as never);
        else if (/^gpt-/.test(m)) cost[i].oa += altUsageUsd(r as never);
        else cost[i].ds += altUsageUsd(r as never);
      }
      if (rs.length < 1000) break;
    }
  }
  // 2) 手元: 判定（brain-exam-* の道具・DB に残らない）
  try {
    for (const l of readFileSync(join(CACHE, "local-llm-spend.jsonl"), "utf8").split("\n")) {
      if (!l) continue;
      try {
        const x = JSON.parse(l) as { at?: string; tool?: string; usd?: number; model?: string };
        if (!String(x.tool ?? "").startsWith("brain-exam")) continue;
        const i = nightOf(Date.parse(x.at ?? "")); if (i < 0) continue;
        if (/^gpt-/.test(String(x.model ?? ""))) cost[i].oa += x.usd ?? 0; else cost[i].dsJudge += x.usd ?? 0;
      } catch { /* */ }
    }
  } catch { /* 手元の記録が無くても止めない */ }
  // 3) 答案ごとの費用の記録（cost.json・書いた時刻で晩に分ける）と入力の違い（inputdiff.json）
  for (const d of resultDirs()) {
    let fs: string[] = []; try { fs = readdirSync(d); } catch { continue; }
    for (const f of fs) {
      if (!f.endsWith(".cost.json") && !f.endsWith(".inputdiff.json")) continue;
      let t = 0; try { t = statSync(join(d, f)).mtimeMs; } catch { continue; }
      const i = nightOf(t); if (i < 0) continue;
      try {
        const j = JSON.parse(readFileSync(join(d, f), "utf8"));
        const L = lev[i];
        if (f.endsWith(".inputdiff.json")) { for (const v of Object.values((j.items ?? {}) as Record<string, { same?: boolean }>)) { L.idItems++; if (v?.same) L.idSame++; } continue; }
        L.runs++;
        const tier = j.judge?.tier as { problems?: number; proCalls?: number } | undefined;
        if (tier?.problems) { L.tierAnswers += tier.problems; L.proCalls += tier.proCalls ?? 0; L.tierNoPro += Math.max(0, tier.problems - (tier.proCalls ?? 0)); }
        L.aSkipped += j.flakeSkip?.sameAsBase ?? 0; L.repsSkipped += j.flakeSkip?.n ?? 0;
        L.cReused += j.baseline?.reused ?? 0; L.cReusedUsd += j.baseline?.reusedUsd ?? 0; L.cRan += j.baseline?.ran ?? 0; L.cChildUsd += j.baseline?.childUsd ?? 0;
        L.pinned += j.total?.pinned ?? 0; L.replayUsd += j.total?.replayUsd ?? 0;
      } catch { /* */ }
    }
  }
  // 4) 守り（済んだ依頼の guards・積んだ時刻で晩に分ける）
  try {
    for (const f of readdirSync(join(Q, "done"))) {
      if (!f.endsWith(".json")) continue;
      try {
        const j = JSON.parse(readFileSync(join(Q, "done", f), "utf8")) as { createdAt?: string; guards?: string[] };
        if (!j.guards?.length) continue;
        const i = nightOf(Date.parse(j.createdAt ?? "")); if (i < 0) continue;
        lev[i].guards += j.guards.length; lev[i].guardJobs++;
      } catch { /* */ }
    }
  } catch { /* */ }
  // 5) 係の記録: 積む前の関所・問題の絞り・積まなかった組
  try {
    for (const l of readFileSync(join(Q, "conductor.log"), "utf8").split("\n")) {
      const i = nightOf(Date.parse(l.slice(0, 24))); if (i < 0) continue;
      const g = l.match(/積む前の関所: 材料0の問題 (\S+) を外した/); if (g) lev[i].gateDropped += g[1].split(",").length;
      const n = l.match(/問題の絞り: (\d+)問を外した/); if (n) lev[i].narrowDropped += Number(n[1]);
      const d6 = l.match(/（#68([34])）[^\n]*?(\d+)問を外した/); if (d6) { if (d6[1] === "3") lev[i].t683Dropped += Number(d6[2]); else lev[i].t684Dropped += Number(d6[2]); }
      if (/（#684）[^\n]*積まない/.test(l)) lev[i].t684Blocked++;
      if (/積まない: /.test(l) && !/夜の基準は積まない/.test(l)) lev[i].blocked++;
    }
  } catch { /* */ }

  // 6) 2026-11-24 作業員L（台帳 #686・竹内さん「試験の費用も抑えて、質も上げていく仕組み」）: 効率の物差し
  //   依頼ごと（係の結果 exam-queue/results/<label>.json の usd・worseSure・worseFlake・better・reps）を晩に分け、守りの問題の分の $ を回数の割合で出す
  const guardsOf = new Map<string, string[]>();
  try { for (const f of readdirSync(join(Q, "done"))) { if (!f.endsWith(".json")) continue; try { const j = JSON.parse(readFileSync(join(Q, "done", f), "utf8")) as { label?: string; guards?: string[] }; if (j.label && j.guards?.length) guardsOf.set(j.label, j.guards); } catch { /* */ } } } catch { /* */ }
  const effJobs: EffJob[][] = nights.map(() => []);
  try {
    for (const f of readdirSync(join(Q, "results"))) {
      if (!f.endsWith(".json")) continue;
      try {
        const r = JSON.parse(readFileSync(join(Q, "results", f), "utf8")) as { label?: string; owner?: string; runner?: string; usd?: string | number; at?: string; reps?: Record<string, number>; worseSure?: unknown[]; worseFlake?: unknown[]; better?: number; worse?: number };
        if (!r.label || r.usd == null || /tsc/.test(String(r.runner ?? ""))) continue;
        const i = nightOf(Date.parse(r.at ?? "")); if (i < 0) continue;
        const usd = Number(String(r.usd).replace(/[^0-9.]/g, "")) || 0;
        const reps = r.reps ?? {}, all = Object.values(reps).reduce((a, b) => a + b, 0);
        const g = guardsOf.get(r.label) ?? [], gr = g.reduce((a, id) => a + (reps[id] ?? 0), 0);
        effJobs[i].push({ label: r.label, owner: String(r.owner ?? ""), usd, cls: classifyJob(r), guardUsd: all ? (usd * gr) / all : 0 });
      } catch { /* */ }
    }
  } catch { /* */ }
  const dayWins = nights.map((d) => nightWindow(d, "day"));
  const fixesOn = nights.map(() => 0);
  {
    const { data } = await sb.from("work_item_events").select("at, to_stage").gte("at", new Date(dayWins[0][0]).toISOString()).lt("at", new Date(dayWins[days][1]).toISOString()).in("to_stage", ["on", "passed"]).limit(2000);
    for (const e of (data ?? []) as Array<{ at: string }>) { const t = Date.parse(e.at); const i = dayWins.findIndex(([a, b]) => t >= a && t < b); if (i >= 0) fixesOn[i]++; }
  }
  const matchOf = new Map<string, number>();
  {
    // 竹内さんの番の一致（line-watch-eval の reply_match・%）。n が5番に満たない日は数が小さすぎて動きに使わない
    const { data } = await sb.from("quality_daily").select("day, value, n").eq("scope", "takeuchi").eq("metric", "reply_match").gte("day", nights[0]).lte("day", addDays(night, 1));
    for (const r of (data ?? []) as Array<{ day: string; value: number | null; n: number | null }>) if (r.value != null && (r.n ?? 0) >= 5) matchOf.set(String(r.day), Number(r.value));
  }
  const eff: EffMetrics[] = nights.map((d, i) => {
    const L = lev[i], jobUsd = effJobs[i].reduce((a, j) => a + j.usd, 0);
    const probs = effJobs[i].length ? jobUsd / Math.max(1, effJobs[i].length * 5) : 0; // 外した問題1問の目安＝1本の $ を5問で割った程度
    const m0 = matchOf.get(d), m1 = matchOf.get(addDays(d, 1));
    return effMetrics({ jobs: effJobs[i], rebuildUsd: L.cChildUsd, fixesOn: fixesOn[i], stoppedUsd: L.cReusedUsd + L.replayUsd + (L.gateDropped + L.narrowDropped) * probs, totalUsd: total(cost[i]), matchDelta: m0 != null && m1 != null ? m1 - m0 : null });
  });
  const prev = cost.slice(0, days), now = cost[days];
  const avg = (f: (c: Cost) => number) => prev.reduce((a, c) => a + f(c), 0) / days;
  const pl = lev.slice(0, days), ln = lev[days];
  const lavg = (k: keyof Lever) => pl.reduce((a, x) => a + x[k], 0) / days;
  const $ = (n: number) => `$${n.toFixed(2)}`;
  if (argv.includes("--json")) { console.log(JSON.stringify({ night, window: win, nights, cost, lev, eff, dbRows }, null, 1)); return; }

  console.log(`# 試験の費用（${night} の晩・${win === "day" ? "12時〜翌12時" : "22時〜翌8時"} JST）と前の${days}晩`);
  console.log(`（DB の試験の呼び出し ${dbRows}行・判定は手元の記録・読むだけ）\n`);
  console.log("| 晩 | DeepSeek 試験 | DeepSeek 判定 | OpenAI | Claude | 合計 |");
  console.log("|---|---|---|---|---|---|");
  nights.forEach((d, i) => { const c = cost[i]; console.log(`| ${d.slice(5)}${i === days ? "（今夜）" : ""} | ${$(c.ds)} | ${$(c.dsJudge)} | ${$(c.oa)} | ${$(c.cl)} | ${$(total(c))} |`); });
  console.log(`| 前の${days}晩の平均 | ${$(avg((c) => c.ds))} | ${$(avg((c) => c.dsJudge))} | ${$(avg((c) => c.oa))} | ${$(avg((c) => c.cl))} | ${$(avg(total))} |`);
  const ran = prev.filter((c) => total(c) > 0.01), ravg = (f: (c: Cost) => number) => (ran.length ? ran.reduce((a, c) => a + f(c), 0) / ran.length : 0);
  console.log(`| 試験のあった晩（${ran.length}晩）の平均 | ${$(ravg((c) => c.ds))} | ${$(ravg((c) => c.dsJudge))} | ${$(ravg((c) => c.oa))} | ${$(ravg((c) => c.cl))} | ${$(ravg(total))} |`);

  console.log(`\n## 削り方ごとの効き（今夜／前の${days}晩の1晩平均）`);
  const row = (name: string, k: keyof Lever, unit: string, extra = "") => console.log(`- ${name}: ${ln[k]}${unit}／${lavg(k).toFixed(1)}${unit}${extra}`);
  console.log(`- 答案の費用の記録: ${ln.runs}本／${lavg("runs").toFixed(1)}本`);
  row("判定の段（tier）で pro を呼ばなかった答案", "tierNoPro", "件", `（tier の答案 ${ln.tierAnswers}・pro を呼んだ ${ln.proCalls}回）`);
  row("守りの問題", "guards", "問", `（守りの付いた依頼 ${ln.guardJobs}本）`);
  row("a（最初の回が前と同じで回さなかった回）", "aSkipped", "回", `（揺れ・過半数などで省いた回の全部 ${ln.repsSkipped}）`);
  row("c（使い回した基準の答え）", "cReused", "問", `（使い回した分 ${$(ln.cReusedUsd)}・作り直した ${ln.cRan}問 ${$(ln.cChildUsd)}）`);
  row("入力が同じで呼ばなかった回（pins）", "pinned", "回", `（録音で返した分 ${$(ln.replayUsd)}・入力が全部同じ答え ${ln.idSame}/${ln.idItems}${ln.idItems ? `＝${((ln.idSame / ln.idItems) * 100).toFixed(1)}%` : ""}）`);
  row("積む前の関所で外した問題", "gateDropped", "問");
  row("問題の絞りで外した問題", "narrowDropped", "問");
  row("関所で積まなかった依頼", "blocked", "本");
  row("#683 覚えた材料で外した問題", "t683Dropped", "問");
  row("#684 本番の照らしで余地0＝積まなかった依頼", "t684Blocked", "本", `（外した問題 ${ln.t684Dropped}問）`);

  // 効率の物差し（台帳 #686）
  const e = eff[days], ep = eff.slice(0, days);
  const pct = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(0)}%`);
  console.log("\n## 効率の物差し（晩ごと）");
  console.log("| 晩 | 費用 | 依頼 | 確かな悪化を見つけた | 良くなった | on にできた直し | 直し1本あたり | 差なしの組の $ | 止めた $ | 竹内さんの番の一致の動き |");
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  nights.forEach((d, i) => { const x = eff[i]; console.log(`| ${d.slice(5)}${i === days ? "（今夜）" : ""} | ${$(x.totalUsd)} | ${x.jobs} | ${x.sure} | ${x.better} | ${x.fixesOn} | ${x.usdPerFix == null ? "—" : $(x.usdPerFix)} | ${pct(x.noDiffShare)} | ${$(x.stoppedUsd)} | ${x.matchDelta == null ? "—" : (x.matchDelta >= 0 ? "+" : "") + x.matchDelta.toFixed(1)} |`); });
  const wn = worseNight(e, ep);
  console.log(`\n## 自動の点検（前の${days}晩と比べて）`);
  const proposals: Array<{ title: string; next: string; owner: string }> = [];
  if (!wn.worse) console.log("- 効率は前の晩より悪くなっていない（差なしの割合・直し1本あたりの $）");
  else {
    console.log(`- 効率が悪くなった: ${wn.why.join("・")}`);
    console.log(`- 一番増えた理由: ${wn.reason ? REASON_JA[wn.reason] : "—"}（前の平均より +${$(wn.overUsd)}）・内訳 差なし ${$(e.reasonUsd.nodiff)}・作り直し ${$(e.reasonUsd.rebuild)}・守り ${$(e.reasonUsd.guards)}・揺れ ${$(e.reasonUsd.flake)}`);
    if (wn.reason) { const pr = proposalFor(wn.reason, effJobs[days], night); proposals.push(pr); console.log(`- 次の削りの案（持ち主 ${pr.owner}）: ${pr.next}`); }
  }
  // 書き込み（--write: quality_daily に test:efficiency:*・--write-items: 案を台帳の行に。同じ題の行があれば足さない）
  if (argv.includes("--write")) {
    const day = addDays(night, 1);
    const kv: Array<[string, number | null]> = [
      ["usd", e.totalUsd], ["fixes_on", e.fixesOn], ["sure_worse", e.sure], ["better", e.better], ["usd_per_fix", e.usdPerFix], ["nodiff_share", e.noDiffShare], ["stopped_usd", e.stoppedUsd],
      ["usd_deepseek", now.ds + now.dsJudge], ["usd_openai", now.oa], ["usd_claude", now.cl], ["worse_night", wn.worse ? 1 : 0],
    ];
    const rows = kv.filter(([, v]) => v != null).map(([k, v]) => ({ day, metric: `test:efficiency:${k}`, scope: "all", value: Number(v), n: e.jobs, source: "audit-night-cost", detail: k === "worse_night" ? { why: wn.why, reason: wn.reason, night } : { night } }));
    const { error } = await sb.from("quality_daily").upsert(rows, { onConflict: "day,metric,scope" });
    console.log(error ? `quality_daily に書けない: ${error.message}` : `quality_daily に ${rows.length}行（${day}・test:efficiency:*）`);
  }
  if (argv.includes("--write-items")) for (const pr of proposals) {
    const { data: ex } = await sb.from("work_items").select("id").eq("title", pr.title).limit(1);
    if (ex?.length) { console.log(`台帳: もうある（#${(ex[0] as { id: number }).id}）`); continue; }
    execFileSync("npx", ["tsx", "--env-file=.env.local", "scripts/work-items.ts", "--add", `"--title=${pr.title}"`, "--area=試験", "--origin=found_gap", "--stage=todo", `"--owner=${pr.owner}"`, `"--next=${pr.next}"`], { stdio: "inherit", shell: true });
  }

  const a = ravg(total), t = total(now);
  console.log(`\n## 竹内さんへの1行`);
  console.log(`試験の費用は前の${days}晩のうち試験のあった${ran.length}晩の1晩平均（${days}晩で割ると ${$(avg(total))}） ${$(a)} → 今夜 ${$(t)}（${a ? `${t <= a ? "−" : "+"}${Math.abs(((t - a) / a) * 100).toFixed(0)}%` : "前の記録なし"}・DeepSeek ${$(now.ds + now.dsJudge)}・OpenAI ${$(now.oa)}・Claude ${$(now.cl)}・on にできた直し ${e.fixesOn}本${e.usdPerFix != null ? `（1本あたり ${$(e.usdPerFix)}）` : ""}・差なしの組の $ ${pct(e.noDiffShare)}）`);
})().catch((e) => { console.error(e); process.exit(1); });
