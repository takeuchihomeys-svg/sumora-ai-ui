// GET /api/cron/scoring-pref-learning  （Vercel Cron・毎週日曜 20:40 UTC＝月曜 JST 5:40・重みの学習 scoring-learning の 30分後）
//   ?dry=1 … 材料・当て直し・DeepSeek の読み（件数を絞る）を返すだけ（DB に書かない）。&days=400（既定）
//   &reads=N … dry の時に DeepSeek で読む件数（種類ごと・既定 5）。&llm=0 で DeepSeek を呼ばない
// お客様ごとのこだわりの倍率（customer-pref-weights）を、今まで送った物件から毎週学び直し、良くなった時だけ表（scoring_pref_weights）を更新する。
// 数字は決定論・費用 0。文を読む材料（お客様のこだわりの強さ・スタッフの訴求・👑と違う物件を選んだ仮説・週のまとめ）だけ DeepSeek
// （物件検索ブレインと同じ口・週 $1 の上限）。既定は「良くなった時だけ自動で表を更新」（CUSTOMER_PREF_LEARNING_AUTO_APPLY=off で提案だけ）。
// 2026-09-29 竹内「（お客様ごとの採点の倍率を毎週の学習に）組み込む」「DeepSeek で分析できるかな？ 物件検索ブレイン（DeepSeek）の部分が分析する形」
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { runPrefLearning } from "@/app/lib/customer-pref-learning-server";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const sp = req.nextUrl.searchParams;
  const dry = sp.get("dry") === "1";
  const days = Math.min(400, Math.max(14, parseInt(sp.get("days") ?? "400", 10) || 400));
  const reads = Math.max(0, parseInt(sp.get("reads") ?? "5", 10) || 0);
  const llmOff = sp.get("llm") === "0";
  try {
    const r = await runPrefLearning(supabase, {
      dry, days,
      llm: llmOff ? { enabled: false } : dry ? { maxReads: { customer: reads, appeal: reads, hypothesis: reads }, budgetUsd: 0.2 } : undefined,
    });
    // 返す物は要約だけ（帯・札ごとの表は DB の scoring_pref_learning_runs に）
    return NextResponse.json({
      ok: r.ok, dry: r.dry, error: r.error ?? null, runId: r.runId ?? null, activeVersion: r.activeVersion, ms: r.ms,
      counts: r.counts, holdout: { base: r.backtest.base, weighted: r.backtest.weighted, gain: r.backtest.gain }, changes: r.backtest.learned.changes,
      decision: r.backtest.decision, byCustomer: r.byCustomer, llmBacktest: r.llmBacktest, apply: { apply: r.apply.apply, propose: r.apply.propose, reason: r.apply.reason, version: r.apply.version, diff: r.apply.diff },
      llm: r.llm, appealTop: r.appealTop, hypothesisTop: r.hypothesisTop, weeklySummary: r.weeklySummary, weeklySummarySource: r.weeklySummarySource,
    }, { status: r.ok ? 200 : 500 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
