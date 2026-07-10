import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

export const maxDuration = 30;

// POST /api/cron/auto-reply-guard（毎週月曜 JST 14:10・auto-reply-readiness の10分後）
// ガードレール + キルスイッチ: 自動返信化 ready のアクション品質が落ちたら自動的に ready 解除する。
//
// 判定: aix_readiness_snapshots の直近3週分（week1=最古 → week3=最新）で
//   week1.acceptance_rate > week2.acceptance_rate > week3.acceptance_rate（2週連続下降）
//   かつ week3 が week1 より 15%ポイント以上低下 → キルスイッチ発動
//
// 発動時:
//   - ai_prompts.auto_reply_readiness の scores で該当アクションを ready=false に上書き
//   - ai_prompts key='auto_reply_guard_latest' に発動記録を保存（morning-report が読んで報告）
const DROP_THRESHOLD = 0.15; // 15%ポイント

type ReadinessScore = {
  aix_type: string;
  acceptance_rate?: number | null;
  edit_rate?: number | null;
  win_rate?: number | null;
  ready?: boolean;
  reason?: string | null;
};

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const runLogId = await startCronLog("auto-reply-guard");

  try {
    const reportDate = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

    // 1. 直近3週分のスナップショットを取得（余裕を持って5週間分を引いてJSで直近3日付に絞る）
    const since = new Date(Date.now() - 35 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const { data: snapRows, error: snapErr } = await supabase
      .from("aix_readiness_snapshots")
      .select("report_date, aix_type, acceptance_rate, ready")
      .gte("report_date", since)
      .order("report_date", { ascending: false })
      .limit(500);

    if (snapErr) {
      await finishCronLog(runLogId, false, undefined, snapErr.message);
      return NextResponse.json({ ok: false, error: snapErr.message }, { status: 500 });
    }

    const snapshots = (snapRows ?? []) as Array<{
      report_date: string;
      aix_type: string;
      acceptance_rate: number | string | null;
      ready: boolean;
    }>;

    // 直近3つの report_date（降順で取得済み → dates[0]=最新）
    const dates = Array.from(new Set(snapshots.map((s) => s.report_date))).slice(0, 3);
    if (dates.length < 3) {
      await finishCronLog(runLogId, true, { skipped: true, note: `snapshots for ${dates.length} week(s) only（3週分必要）` });
      return NextResponse.json({ ok: true, paused: [], note: "3週分のスナップショットが揃っていないためスキップ" });
    }
    const [week3Date, week2Date, week1Date] = dates; // week3=最新, week1=最古

    // 週×aix_type → acceptance_rate / ready のマップ
    const byWeek: Record<string, Record<string, { rate: number | null; ready: boolean }>> = {};
    for (const s of snapshots) {
      if (!dates.includes(s.report_date)) continue;
      byWeek[s.report_date] ??= {};
      const rate = s.acceptance_rate === null ? null : Number(s.acceptance_rate);
      byWeek[s.report_date][s.aix_type] = { rate: Number.isFinite(rate as number) ? rate : null, ready: s.ready };
    }

    // 2. 最新週で ready=true のアクションのうち、2週連続下降 + 15pt以上低下を検出
    const paused: Array<{ aix_type: string; week1_rate: number; week2_rate: number; week3_rate: number }> = [];
    for (const [aixType, latest] of Object.entries(byWeek[week3Date] ?? {})) {
      if (!latest.ready) continue;
      const r3 = latest.rate;
      const r2 = byWeek[week2Date]?.[aixType]?.rate ?? null;
      const r1 = byWeek[week1Date]?.[aixType]?.rate ?? null;
      if (r1 === null || r2 === null || r3 === null) continue;
      if (r1 > r2 && r2 > r3 && r1 - r3 >= DROP_THRESHOLD) {
        paused.push({ aix_type: aixType, week1_rate: r1, week2_rate: r2, week3_rate: r3 });
      }
    }

    // 3. 該当アクションを ai_prompts.auto_reply_readiness の scores で ready=false に上書き
    if (paused.length > 0) {
      const { data: readinessRow } = await supabase
        .from("ai_prompts")
        .select("content")
        .eq("key", "auto_reply_readiness")
        .maybeSingle();

      if (readinessRow?.content) {
        try {
          const readiness = JSON.parse(readinessRow.content as string) as { report_date?: string; scores?: ReadinessScore[] };
          const pausedTypes = new Map(paused.map((p) => [p.aix_type, p]));
          let changed = false;
          for (const score of readiness.scores ?? []) {
            const hit = pausedTypes.get(score.aix_type);
            if (!hit || score.ready !== true) continue;
            score.ready = false;
            const pct = (r: number) => `${Math.round(r * 100)}%`;
            score.reason = `⚠️ ガードレール発動: 採択率が2週連続低下（${pct(hit.week1_rate)}→${pct(hit.week2_rate)}→${pct(hit.week3_rate)}）のため自動返信化を一時停止 / ${score.reason ?? ""}`;
            changed = true;
          }
          if (changed) {
            await supabase.from("ai_prompts").upsert(
              {
                key: "auto_reply_readiness",
                label: "自動返信化準備スコア",
                content: JSON.stringify(readiness, null, 2),
                updated_at: new Date().toISOString(),
              },
              { onConflict: "key" }
            );
          }
        } catch (e) {
          console.error("[auto-reply-guard] readiness JSON parse failed:", e);
        }
      }
    }

    // 4. 発動記録を保存（morning-report が「⚠️ 自動返信化を一時停止」として報告する）
    await supabase.from("ai_prompts").upsert(
      {
        key: "auto_reply_guard_latest",
        label: "自動返信ガードレール（最新）",
        content: JSON.stringify({ report_date: reportDate, paused }, null, 2),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" }
    );

    await finishCronLog(runLogId, true, { paused: paused.map((p) => p.aix_type), weeks: dates });
    return NextResponse.json({ ok: true, report_date: reportDate, weeks: dates, paused });
  } catch (e) {
    console.error("[auto-reply-guard]", e);
    await finishCronLog(runLogId, false, undefined, e instanceof Error ? e.message : String(e));
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}

// GET: Vercel CronはGETでリクエストするため、認証チェック後POSTへ委譲
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return POST(req);
}
