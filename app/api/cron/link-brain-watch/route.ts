// GET /api/cron/link-brain-watch（Vercel Cron・毎日 JST 21:05 = UTC 12:05・vercel.json "5 12 * * *"・line-watch-daily（20:50）の後）
//   つなぎのブレイン 段1「見張り」（2026-10-20 竹内さん・設計知見 e07a8b73・98bca000）: 渡るべき物が次のブレインに渡ったかを、つなぎ8本ごとに
//   決まった計算で数える（app/lib/link-brain-watch.ts・LLM なし・$0）。結果は cron_run_logs.result_json（数だけ・例の文は残さない）。
//   外へ（LINE）は送らない。窓は直近24時間（約束は熟す 72時間・要対応は 24時間だけ前へずらして数える＝毎晩の数えが日ごとに重ならない）。
//   切替: LINK_BRAIN_WATCH（既定 on・止める =off）／LINK_BRAIN_TODO（既定 off・on で、果たしていない約束（要対応も無い）を AIX要対応に立て【やることリスト】に載せる。
//     1件ずつの通知が on（STAFF_TODO_INSTANT_NOTICE）の間は立てない＝LINE へ出さない）
//   ?dry=1 … 記録しない・立てない（数えだけ返す）
//   2026-10-22 竹内さんの決定（設計知見 395e0064）: 同じ回でブレインの「分からない事」を brain_unknowns に足す（app/lib/brain-unknowns.ts・LLM なし・$0）。
//     窓は前の回が集めた所の続き（最大48時間）＝やり直しても二重に数えない。止める BRAIN_UNKNOWNS=off
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase-server";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import { runLinkWatch } from "@/app/lib/link-brain-watch-server";
import { compactLinkSummary, linkBrainTodoEnabled, linkBrainWatchEnabled, LINK_BRAIN_NOTE_PREFIX } from "@/app/lib/link-brain-watch";
import { registerRuleAixActionItem } from "@/app/lib/aix-action-items";
import { aixInstantNoticeEnabled } from "@/app/lib/staff-todo-list";
import { BREAK_JA, LINK_JA } from "@/app/lib/link-brain-watch";
import { brainUnknownsEnabled, unknownsFromLinkSummary } from "@/app/lib/brain-unknowns";
import { collectBrainUnknowns } from "@/app/lib/brain-unknowns-server";

export const maxDuration = 300;
export const dynamic = "force-dynamic";
const LINK_TODO_MAX = 20;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!linkBrainWatchEnabled()) return NextResponse.json({ ok: true, skipped: true, reason: "LINK_BRAIN_WATCH is off" });
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  const logId = dry ? null : await startCronLog("link-brain-watch");
  try {
    const nowMs = Date.now();
    const s = await runLinkWatch(supabase, { fromMs: nowMs - 86_400_000, toMs: nowMs, nowMs }, { examplesPerType: 2 }); // 例は会話 id と時刻だけ brain_unknowns に使う（記録の要約には例の文を入れない）
    const out: Record<string, unknown> = compactLinkSummary(s);
    if (!dry && linkBrainTodoEnabled() && !aixInstantNoticeEnabled()) {
      let added = 0;
      for (const t of s.todo.slice(0, LINK_TODO_MAX)) {
        if (await registerRuleAixActionItem({ conversationId: t.conversationId, customerName: t.customerName, action: t.action, checkPattern: t.checkPattern, note: `${LINK_BRAIN_NOTE_PREFIX}:${t.breakType}` })) added++;
      }
      out.todo_added = added;
    }
    if (!dry && brainUnknownsEnabled()) {
      try {
        const fromIso = await lastUnknownsTo(nowMs);
        const toIso = new Date(nowMs).toISOString();
        // つなぎの切れは見張りの窓（24時間）ごとの数なので、同じ日にやり直した回（前の回から20時間未満）では足さない
        const linkHits = nowMs - Date.parse(fromIso) >= 20 * 3_600_000 ? unknownsFromLinkSummary(s, BREAK_JA, LINK_JA) : [];
        const u = await collectBrainUnknowns(supabase, fromIso, toIso, linkHits);
        out.unknowns = { from: fromIso, ...u };
        out.unknowns_to = toIso;
      } catch (e) { out.unknowns_error = e instanceof Error ? e.message : String(e); }
    }
    await finishCronLog(logId, true, out);
    return NextResponse.json({ ok: true, dry, ...out });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishCronLog(logId, false, { ok: false, error: msg }, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/** 前の回が分からない事を集め終えた時刻（無ければ24時間前・48時間より前には戻らない） */
async function lastUnknownsTo(nowMs: number): Promise<string> {
  const floor = nowMs - 48 * 3_600_000;
  try {
    const { data } = await supabase.from("cron_run_logs").select("result_json").eq("cron_name", "link-brain-watch").eq("ok", true)
      .order("started_at", { ascending: false }).limit(5);
    for (const r of (data ?? []) as Array<{ result_json: { unknowns_to?: unknown } | null }>) {
      const t = Date.parse(String(r.result_json?.unknowns_to ?? ""));
      if (Number.isFinite(t)) return new Date(Math.max(floor, Math.min(t, nowMs))).toISOString();
    }
  } catch { /* 読めなければ24時間 */ }
  return new Date(nowMs - 86_400_000).toISOString();
}
