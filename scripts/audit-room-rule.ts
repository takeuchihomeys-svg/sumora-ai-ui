// scripts/audit-room-rule.ts — #684 の余地の関所を、前の晩までの組になぞる（読むだけ・LLM なし・2026-11-25 作業員L）
//   係の済んだ依頼（exam-queue/done の env の on・積んだ時刻）ごとに、その時刻の前14日の本番の照らしで余地を出し（scripts/lib/exam-room.ts）、
//   係の結果（exam-queue/results/<label>.json の better・worseSure・usd）と並べる。
//   on にしてよい線: 「余地0（積まない）なのに良くなった組」が0件。あわせて「余地0なのに確かな悪化を見つけた組」（止めると見落とす悪化）も数える。
// 実行: npx tsx --env-file=.env.local scripts/audit-room-rule.ts [--days=7] [--queue=<exam-queue>]
import { createClient } from "@supabase/supabase-js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { roomOf } from "./lib/exam-room";
import { readRoomTurns } from "./lib/exam-room-db";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const Q = arg("queue", "C:/Users/竹内 悠馬/sumora-ai-ui/.claude/exam-cache/exam-queue");
const days = Number(arg("days", "7")) || 7;

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const since = Date.now() - days * 86_400_000;
  const jobs: Array<{ label: string; at: number; on: string[] }> = [];
  for (const f of readdirSync(join(Q, "done"))) {
    if (!f.endsWith(".json")) continue;
    try {
      const j = JSON.parse(readFileSync(join(Q, "done", f), "utf8")) as { label?: string; runner?: string; createdAt?: string; env?: Record<string, string> };
      const at = Date.parse(j.createdAt ?? "");
      if (!j.label || at < since || (j.runner && j.runner !== "brain-exam")) continue;
      const on = Object.entries(j.env ?? {}).filter(([k, v]) => !k.startsWith("EXAM_") && String(v).toLowerCase() === "on").map(([k]) => k);
      if (on.length) jobs.push({ label: j.label, at, on });
    } catch { /* */ }
  }
  const turns = await readRoomTurns(sb as never, new Date(since - 14 * 86_400_000).toISOString());
  const out = { jobs: jobs.length, byDecision: {} as Record<string, number>, withResult: 0, blockedUsd: 0, blockedBetter: [] as string[], blockedSure: [] as string[], deferBetter: [] as string[], okBetter: 0, okJobs: 0, rows: [] as string[] };
  for (const j of jobs) {
    const rr = roomOf({ onSwitches: j.on, turns: turns.filter((t) => t.at < j.at && t.at >= j.at - 14 * 86_400_000) });
    out.byDecision[rr.decision] = (out.byDecision[rr.decision] ?? 0) + 1;
    const rf = join(Q, "results", `${j.label}.json`);
    if (!existsSync(rf)) continue;
    let r: { better?: number; worseSure?: unknown[]; usd?: string | number } = {};
    try { r = JSON.parse(readFileSync(rf, "utf8")); } catch { continue; }
    out.withResult++;
    const better = (r.better ?? 0) > 0, sure = (r.worseSure ?? []).length > 0, usd = Number(String(r.usd ?? 0).replace(/[^0-9.]/g, "")) || 0;
    if (rr.decision === "block") { out.blockedUsd += usd; if (better) out.blockedBetter.push(j.label); if (sure) out.blockedSure.push(j.label); }
    if (rr.decision === "defer" && better) out.deferBetter.push(j.label);
    if (rr.decision === "ok") { out.okJobs++; if (better) out.okBetter++; }
    if (rr.decision !== "unknown") out.rows.push(`${j.label}: ${rr.decision}（${rr.why}）・良くなった ${r.better ?? 0}・確かな悪化 ${(r.worseSure ?? []).length}・$${usd.toFixed(3)}`);
  }
  console.log(JSON.stringify({ ...out, blockedUsd: +out.blockedUsd.toFixed(3), turns: turns.length }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
