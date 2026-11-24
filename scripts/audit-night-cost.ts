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
};
const zeroCost = (): Cost => ({ ds: 0, dsJudge: 0, oa: 0, cl: 0, calls: 0 });
const zeroLever = (): Lever => ({ runs: 0, tierAnswers: 0, tierNoPro: 0, proCalls: 0, guards: 0, guardJobs: 0, aSkipped: 0, repsSkipped: 0, cReused: 0, cReusedUsd: 0, cRan: 0, cChildUsd: 0, pinned: 0, replayUsd: 0, idSame: 0, idItems: 0, gateDropped: 0, narrowDropped: 0, blocked: 0 });
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
      if (/積まない: /.test(l) && !/夜の基準は積まない/.test(l)) lev[i].blocked++;
    }
  } catch { /* */ }

  const prev = cost.slice(0, days), now = cost[days];
  const avg = (f: (c: Cost) => number) => prev.reduce((a, c) => a + f(c), 0) / days;
  const pl = lev.slice(0, days), ln = lev[days];
  const lavg = (k: keyof Lever) => pl.reduce((a, x) => a + x[k], 0) / days;
  const $ = (n: number) => `$${n.toFixed(2)}`;
  if (argv.includes("--json")) { console.log(JSON.stringify({ night, window: win, nights, cost, lev, dbRows }, null, 1)); return; }

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

  const a = ravg(total), t = total(now);
  console.log(`\n## 竹内さんへの1行`);
  console.log(`試験の費用は前の${days}晩のうち試験のあった${ran.length}晩の1晩平均（${days}晩で割ると ${$(avg(total))}） ${$(a)} → 今夜 ${$(t)}（${a ? `${t <= a ? "−" : "+"}${Math.abs(((t - a) / a) * 100).toFixed(0)}%` : "前の記録なし"}・DeepSeek ${$(now.ds + now.dsJudge)}・OpenAI ${$(now.oa)}・Claude ${$(now.cl)}）`);
})().catch((e) => { console.error(e); process.exit(1); });
