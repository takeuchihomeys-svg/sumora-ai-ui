import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import { promoteToConfirmed } from "@/app/lib/knowledge-promote";

export const maxDuration = 60;

// POST /api/cron/eval-winning-pattern（毎週月曜 JST 9:00 = UTC 0:00）
// 判定軸:
//   was_ai_modified=false & was_ai_used=true = スタッフがAI返信を無修正で送信 = AI正解 → correct
//   was_ai_modified=true  & was_ai_used=true = スタッフがAI返信を修正して送信 = AI返信に問題あり → wrong
// 直近7日の ai_reply_examples から両シグナルを取得し、
// 対応する knowledge_apply_log の pending ログを correct / wrong に更新する。
// 成約/失注による判定は廃止（closed_won/closed_lost は今のフェーズでは判断基準にしない）。
const BATCH_LIMIT = 200;

type ReplyExample = {
  id: string;
  conversation_id: string;
};

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const runLogId = await startCronLog("eval-winning-pattern");

  try {
    const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

    // 直近7日の ai_reply_examples から「スタッフがAI返信を無修正で送信」したものを取得
    // was_ai_modified=false & was_ai_used=true = AI生成が正解だったケース
    const { data: examples, error: exErr } = await supabase
      .from("ai_reply_examples")
      .select("id, conversation_id")
      .eq("was_ai_modified", false)
      .eq("was_ai_used", true)
      .gte("created_at", since7d)
      .order("created_at", { ascending: false })
      .limit(BATCH_LIMIT);

    if (exErr) {
      await finishCronLog(runLogId, false, undefined, exErr.message);
      return NextResponse.json({ ok: false, error: exErr.message }, { status: 500 });
    }

    // 直近7日の「スタッフがAI返信を修正して送信」= AI返信に問題があったケース = wrong シグナル
    const { data: wrongExamples, error: wrongErr } = await supabase
      .from("ai_reply_examples")
      .select("id, conversation_id")
      .eq("was_ai_modified", true)
      .eq("was_ai_used", true)
      .gte("created_at", since7d)
      .order("created_at", { ascending: false })
      .limit(BATCH_LIMIT);

    if (wrongErr) {
      await finishCronLog(runLogId, false, undefined, wrongErr.message);
      return NextResponse.json({ ok: false, error: wrongErr.message }, { status: 500 });
    }

    const exampleList = (examples ?? []) as ReplyExample[];
    const wrongList = (wrongExamples ?? []) as ReplyExample[];
    if (exampleList.length === 0 && wrongList.length === 0) {
      await finishCronLog(runLogId, true, { evaluated: 0, knowledge_fed: 0 });
      return NextResponse.json({ ok: true, evaluated: 0, knowledge_fed: 0 });
    }

    const convIds = [...new Set([
      ...exampleList.map(e => e.conversation_id),
      ...wrongList.map(e => e.conversation_id),
    ])];

    // 対応する knowledge_apply_log（source='generate_reply', result='pending'）を取得
    const { data: applyLogs } = await supabase
      .from("knowledge_apply_log")
      .select("knowledge_id, conversation_id")
      .in("conversation_id", convIds)
      .eq("result", "pending")
      .eq("source", "generate_reply");

    // was_ai_modified=false → correct として kCorrect ペアを構築
    // knowledge_id × conversation_id 単位でデデュプ（同一会話内の重複は除去しつつ、
    // 異なる会話での適用は別々にカウントする → apply_count が正確に加算される）
    type FeedbackPair = { knowledge_id: string; conversation_id: string };
    const kCorrect: FeedbackPair[] = [];
    const correctPairsSeen = new Set<string>();

    for (const ex of exampleList) {
      const kids = [...new Set(
        (applyLogs ?? [])
          .filter(a => a.conversation_id === ex.conversation_id && a.knowledge_id)
          .map(a => a.knowledge_id as string)
      )];
      for (const kid of kids) {
        const pairKey = `${kid}::${ex.conversation_id}`;
        if (!correctPairsSeen.has(pairKey)) {
          correctPairsSeen.add(pairKey);
          kCorrect.push({ knowledge_id: kid, conversation_id: ex.conversation_id });
        }
      }
    }

    // was_ai_modified=true → wrong として kWrong ペアを構築
    // 同一会話が correct と wrong の両方に現れた場合は correct を優先し wrong から除外する
    // （同一会話に複数 example があるケースの矛盾防止）
    const kWrong: FeedbackPair[] = [];
    const wrongPairsSeen = new Set<string>();
    for (const ex of wrongList) {
      const kids = [...new Set(
        (applyLogs ?? [])
          .filter(a => a.conversation_id === ex.conversation_id && a.knowledge_id)
          .map(a => a.knowledge_id as string)
      )];
      for (const kid of kids) {
        const pairKey = `${kid}::${ex.conversation_id}`;
        // correct 側で既に採用されたペアは wrong にしない（correct優先）
        if (correctPairsSeen.has(pairKey) || wrongPairsSeen.has(pairKey)) continue;
        wrongPairsSeen.add(pairKey);
        kWrong.push({ knowledge_id: kid, conversation_id: ex.conversation_id });
      }
    }

    let knowledgeFed = 0;
    if (kCorrect.length > 0 || kWrong.length > 0) {
      // ペア単位RPC: (knowledge_id × conversation_id) で correct/wrong に更新（別会話の pending 巻き込み防止）
      // feedback_source='text_retention': スタッフのテキスト採用/修正シグナル
      await supabase.rpc("update_knowledge_feedback_by_pairs", {
        p_correct_pairs: kCorrect.length > 0 ? kCorrect : null,
        p_wrong_pairs: kWrong.length > 0 ? kWrong : null,
        p_feedback_source: "text_retention",
      });
      knowledgeFed = kCorrect.length + kWrong.length;
    }

    // ── hypothesis → confirmed 自動昇格 ──
    // apply_count >= 5 かつ correct_rate >= 70% のナレッジを confirmed に昇格
    try {
      const { data: promotionCandidates } = await supabase
        .from("ai_reply_knowledge")
        .select("id, title, content, importance, conversation_state, correct_count, wrong_count, apply_count")
        .eq("hypothesis_status", "hypothesis")
        .gte("correct_count", 5)
        .gte("apply_count", 5)
        .limit(30);
      let autoPromoted = 0;
      for (const rule of promotionCandidates ?? []) {
        const c = (rule.correct_count as number) ?? 0;
        const w = (rule.wrong_count as number) ?? 0;
        if (c + w === 0) continue;
        if (w / (c + w) >= 0.3) continue; // 外れ率30%以上は昇格しない
        // H-2: promoted_by='batch_eval' を記録して昇格（ai_prompt_rules への即時同期込み）
        await promoteToConfirmed(rule.id as string, "batch_eval", {
          title: rule.title as string,
          content: (rule.content as string | null) ?? "",
          importance: (rule.importance as number | null) ?? 0,
          conversation_state: (rule.conversation_state as string | null) ?? null,
        });
        autoPromoted++;
      }
      if (autoPromoted > 0) {
        console.log(`[eval-winning-pattern] hypothesis→confirmed自動昇格: ${autoPromoted}件`);
      }
    } catch (e) {
      console.warn("[eval-winning-pattern] hypothesis昇格失敗:", e);
    }

    const summary = {
      evaluated: exampleList.length + wrongList.length,
      correct: kCorrect.length,
      wrong: kWrong.length,
      knowledge_fed: knowledgeFed,
      evaluated_at: new Date().toISOString(),
    };

    // 結果サマリーを ai_prompts に保存（key='winning_pattern_eval_latest'）
    await supabase.from("ai_prompts").upsert({
      key: "winning_pattern_eval_latest",
      label: "winning_pattern 成果検証（週次・最新）",
      content: JSON.stringify(summary),
      updated_at: new Date().toISOString(),
    }, { onConflict: "key" });

    await finishCronLog(runLogId, true, summary);
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    console.error("[eval-winning-pattern]", e);
    await finishCronLog(runLogId, false, undefined, e instanceof Error ? e.message : String(e));
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}

// GET: Vercel Cron は GET でリクエストするため、認証チェック後 POST へ委譲
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return POST(req);
}
