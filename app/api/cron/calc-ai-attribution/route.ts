import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
// 2026-09-27 竹内: テスト用の会話（YUMA）は学習に入れない（一覧は test-conversations.ts の1か所）
import { isTestConversation } from "@/app/lib/test-conversations";
import { outcomeApplyBasisEnabled } from "@/app/lib/application-reach";

// AI貢献率（アトリビューション）日次計算バッチ
// 直近30日の closed_won 会話のうち、AIが貢献（was_ai_used=true または was_ai_modified=true）した割合を算出し、
// ai_prompts (key='ai_attribution_metrics') に JSON で保存する。
// C01修正: was_ai_modified=true のみは「スタッフが大幅修正した会話」を数えており過大評価。
//         was_ai_used=true（AIをほぼそのまま採用）を追加して正確な貢献率を算出する。
// generate-reply やダッシュボードが参照できる「AI貢献率」の定量化。
// 毎日1回（vercel.json cron: 30 16 * * * = JST 01:30）

export const maxDuration = 60;

const METRICS_KEY = "ai_attribution_metrics";

function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false; // 未設定時は全拒否（fail-closed）
  const authHeader = req.headers.get("authorization");
  const xSecret = req.headers.get("x-cron-secret");
  return authHeader === `Bearer ${cronSecret}` || xSecret === cronSecret;
}

async function run() {
  // 1. 直近30日の対象の会話一覧
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // 2026-10-08 竹内さん「申込で数える」（このツールの成功＝申込に届いた事）: 台帳（deal_outcomes）の applied_at が直近30日の会話。
  //   確定の成約（result=won・result_certainty=confirmed）は別に数えて並べる（重い正解・推定の成約は数えない）。
  //   台帳が読めない・OUTCOME_APPLY_BASIS=off の時は旧（conversations.status=closed_won・updated_at 30日）
  let basis: "applied" | "closed_won" = "closed_won";
  let rawIds: string[] = [];
  const wonConfirmedIds = new Set<string>();
  if (outcomeApplyBasisEnabled(process.env)) {
    const { data: ap, error: apErr } = await supabase.from("deal_outcomes").select("conversation_id, result, result_certainty")
      .gte("applied_at", since).limit(10000);
    if (!apErr) {
      basis = "applied";
      for (const r of (ap ?? []) as Array<{ conversation_id: string; result: string | null; result_certainty: string | null }>) {
        rawIds.push(r.conversation_id);
        if (r.result === "won" && r.result_certainty === "confirmed") wonConfirmedIds.add(r.conversation_id);
      }
    } else console.warn("[calc-ai-attribution] deal_outcomes 読めず旧の数え方:", apErr.message);
  }
  if (basis === "closed_won") {
    const { data: wonConvs, error: convErr } = await supabase
      .from("conversations")
      .select("id")
      .eq("status", "closed_won")
      .gte("updated_at", since)
      .limit(10000);
    if (convErr) {
      console.error("[calc-ai-attribution] conv fetch error:", convErr.message);
      return NextResponse.json({ ok: false, error: convErr.message }, { status: 500 });
    }
    rawIds = (wonConvs ?? []).map((c) => c.id as string);
  }

  // 2026-09-27: テスト用の会話（YUMA）は学びに入れない
  const convIds = [...new Set(rawIds)].filter((id) => !isTestConversation(id));
  const total = convIds.length;

  // 2. AIが貢献した返信例（was_ai_used=true または was_ai_modified=true）を取得
  // C01: was_ai_used=true はAI文をほぼそのまま採用（最も確実な貢献シグナル）
  //      was_ai_modified=true はスタッフが大幅修正したが参考にした（貢献あり）
  //      両方をカバーすることで正確な「AI貢献率」を算出する
  const assistedConvIds = new Set<string>();
  let aiMessageCount = 0;

  if (total > 0) {
    // URLの長さ制限を避けるためconvIdsを200件ずつチャンクしてクエリ
    const CHUNK = 200;
    const allExamples: Array<{ conversation_id: string | null }> = [];
    for (let i = 0; i < convIds.length; i += CHUNK) {
      const chunk = convIds.slice(i, i + CHUNK);
      const { data: chunkData, error: chunkErr } = await supabase
        .from("ai_reply_examples")
        .select("conversation_id")
        .in("conversation_id", chunk)
        .or("was_ai_used.eq.true,was_ai_modified.eq.true")
        .limit(10000);
      if (chunkErr) {
        console.error("[calc-ai-attribution] examples fetch error:", chunkErr.message);
        return NextResponse.json({ ok: false, error: chunkErr.message }, { status: 500 });
      }
      allExamples.push(...(chunkData ?? []));
    }
    for (const ex of allExamples) {
      if (ex.conversation_id) {
        assistedConvIds.add(ex.conversation_id as string);
        aiMessageCount++;
      }
    }
  }

  // 3. メトリクス計算
  const aiAssisted = assistedConvIds.size;
  const rate = total > 0 ? Math.round((aiAssisted / total) * 1000) / 1000 : 0;
  const avgMsgs = aiAssisted > 0 ? Math.round((aiMessageCount / aiAssisted) * 100) / 100 : 0;

  const wonIds = convIds.filter((id) => wonConfirmedIds.has(id));
  const metrics = {
    basis,
    rate,
    total,
    ai_assisted: aiAssisted,
    won_total: wonIds.length,
    won_assisted: wonIds.filter((id) => assistedConvIds.has(id)).length,
    avg_msgs: avgMsgs,
    calculated_at: new Date().toISOString(),
  };

  // 4. ai_prompts に upsert（content カラムに JSON 文字列で保存）
  const { error: upsertErr } = await supabase.from("ai_prompts").upsert(
    {
      key: METRICS_KEY,
      label: "AI貢献率メトリクス（自動計算・直近30日）",
      content: JSON.stringify(metrics),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  );

  if (upsertErr) {
    console.error("[calc-ai-attribution] upsert error:", upsertErr.message);
    return NextResponse.json({ ok: false, error: upsertErr.message }, { status: 500 });
  }

  console.log(
    `[calc-ai-attribution] done: rate=${rate} total=${total} ai_assisted=${aiAssisted} avg_msgs=${avgMsgs}`
  );
  return NextResponse.json({ ok: true, ...metrics });
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return run();
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return run();
}
