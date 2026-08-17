import { NextRequest, NextResponse } from "next/server";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { fetchPromptRules } from "@/app/lib/prompt-rules";
import { fetchGroundTruth } from "@/app/lib/ground-truth";
import { runFinalCheck } from "@/app/lib/final-check";

// ─── 送信時の最終チェックAPI（スタッフ編集後テキストの再チェック専用）───────────
// page.tsx executeSend() が「生成時チェックのハッシュと不一致」（=スタッフが編集した）
// 場合のみ呼ぶ。3パス並列（各2.5s abort）なので実測 ≤3s。クライアント側は2.8sで
// タイムアウトして fail-open する（このAPIがどれだけ遅くても送信はブロックされない）。
//
// ⚠️ このルートでは自動修正（revised_text）は絶対に行わない。
//    スタッフが手で編集した文章をAIが書き換えるのは越権（判断はスタッフに返す）。
export const maxDuration = 15;

// ai_prompt_rules の60秒モジュールスコープキャッシュ（送信のたびのDB往復を防ぐ）
let rulesCache: { at: number; text: string } = { at: 0, text: "" };
async function getCachedRules(): Promise<string> {
  if (Date.now() - rulesCache.at < 60_000 && rulesCache.text) return rulesCache.text;
  try {
    const text = await fetchPromptRules("generate_reply", {});
    rulesCache = { at: Date.now(), text };
    return text;
  } catch {
    return rulesCache.text; // 取得失敗時は古いキャッシュで続行（fail-open）
  }
}

// final_check 専用ルールの60秒キャッシュ
let finalCheckRulesCache: { at: number; text: string } = { at: 0, text: "" };
async function getCachedFinalCheckRules(): Promise<string> {
  if (Date.now() - finalCheckRulesCache.at < 60_000 && finalCheckRulesCache.text) return finalCheckRulesCache.text;
  try {
    // includeGlobal=false: global共通ルールを除外し final_check 専用ルールのみ取得
    const text = await fetchPromptRules("final_check", {}, false);
    finalCheckRulesCache = { at: Date.now(), text };
    return text;
  } catch {
    return finalCheckRulesCache.text;
  }
}

export async function POST(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  }

  let text = "";
  let conversationId: string | undefined;
  let recentMessages: Array<{ sender: string; text: string }> = [];
  let customerName: string | undefined;
  let isAix = false;
  try {
    const body = await req.json() as {
      text?: string;
      conversationId?: string;
      recentMessages?: Array<{ sender: string; text: string }>;
      customerName?: string;
      isAix?: boolean;
    };
    text = (body.text ?? "").trim();
    conversationId = body.conversationId;
    recentMessages = Array.isArray(body.recentMessages) ? body.recentMessages : [];
    customerName = body.customerName;
    isAix = body.isAix ?? false;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });

  // ルール + 正解データを並列取得（fetchGroundTruth は throw せず1.5sで諦める fail-open）
  const [dbRules, groundTruth, finalCheckRules] = await Promise.all([
    getCachedRules(),
    fetchGroundTruth(conversationId),
    getCachedFinalCheckRules(),
  ]);
  const lastCustomerMessage = [...recentMessages].reverse().find((m) => m.sender === "customer")?.text;

  // haikuTimeoutMs=2500: 送信時専用の短いタイムアウト（クライアント 2800ms 以内に収まる）
  // generate-reply は runFinalCheckWithRevision 経由でデフォルト 8000ms を使用
  const result = await runFinalCheck(text, {
    dbRules,
    finalCheckRules: finalCheckRules || undefined,
    recentMessages,
    lastCustomerMessage,
    // step1Json なし: check-reply モードでは履歴から Haiku 自身に質問を抽出させる
    checkpointFacts: groundTruth.checkpointFacts,
    customerConditionsDb: groundTruth.customerConditionsDb,
    staffSourceText: customerName ? `お客様のお名前: ${customerName}さん` : undefined,
    isAix,
  }, 2500);
  delete result.revised_text; // このモードでは絶対に書き換え結果を返さない

  return NextResponse.json(result);
}
