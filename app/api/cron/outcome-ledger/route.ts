// GET /api/cron/outcome-ledger — 結果の台帳（deal_outcomes・outcome_events）を毎日作り直す（決定論・LLM なし・API 費用0）
//   毎日 JST 9:30（auto-seiyaku の JST 9:00 の後）。直近60日に動いた会話（updated_at）だけ。それより前の会話は埋め戻し（scripts/backfill-outcome-ledger.ts）で作る。
//   「申込前で30日返事なし＝推定の失注」は返事が来たら次の回で自然に取り消される（会話の updated_at が動く→作り直す）。
//   止める: OUTCOME_LEDGER=off。決まりは app/lib/deal-outcome.ts・計画は memory/plan_outcome_ledger.md
import { NextRequest, NextResponse } from "next/server";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import { computeConversationOutcome, writeConversationOutcome, listOutcomeConversations } from "@/app/lib/deal-outcome-server";
import { refreshReachStats } from "@/app/lib/application-reach-server";
import { applicationReachEnabled } from "@/app/lib/application-reach";

export const maxDuration = 300;
const ACTIVE_DAYS = 60;
const BUDGET_MS = 250_000;
const CONCURRENCY = 4;

function isAuthorized(req: NextRequest): boolean {
  const s = process.env.CRON_SECRET;
  return Boolean(s) && req.headers.get("authorization") === `Bearer ${s}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if ((process.env.OUTCOME_LEDGER ?? "").trim().toLowerCase() === "off") return NextResponse.json({ ok: true, skipped: "OUTCOME_LEDGER=off" });
  const runLogId = await startCronLog("outcome-ledger");
  const started = Date.now();
  try {
    const ids = await listOutcomeConversations({ activeSince: new Date(started - ACTIVE_DAYS * 86_400_000).toISOString() });
    let done = 0, rows = 0, events = 0, deferred = 0;
    const errors: string[] = [];
    const queue = [...ids];
    const worker = async () => {
      for (;;) {
        if (Date.now() - started > BUDGET_MS) { deferred = queue.length; return; }
        const id = queue.shift(); if (!id) return;
        try {
          const o = await computeConversationOutcome(id, { nowMs: started });
          if (!o) continue;
          const w = await writeConversationOutcome(o);
          done++; rows += w.rows; events += w.events;
        } catch (e) { errors.push(`${id.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`); }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    // 2026-10-08 ⑥: 台帳を作り直した後に「場面×段階×ブレインの判断 → 申込到達率」を数え直す（brain_action_reach_stats・ブレインが読む）。BRAIN_APPLY_REACH=off で止まる
    let reach: Awaited<ReturnType<typeof refreshReachStats>> | { skipped: string } = { skipped: "off" };
    if (applicationReachEnabled(process.env)) {
      if (Date.now() - started > BUDGET_MS + 30_000) reach = { skipped: "no_time" };
      else { try { reach = await refreshReachStats({ nowMs: started }); } catch (e) { reach = { skipped: e instanceof Error ? e.message : String(e) }; } }
    }
    const summary = { candidates: ids.length, done, rows, events, deferred, failed: errors.length, reach };
    await finishCronLog(runLogId, errors.length === 0 || done > 0, { ...summary, errors: errors.slice(0, 5) });
    return NextResponse.json({ ok: true, ...summary, errors: errors.slice(0, 5) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(runLogId, false, undefined, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
