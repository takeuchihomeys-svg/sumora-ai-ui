import { NextRequest, NextResponse } from "next/server";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { getCachedPromptRules } from "@/app/lib/prompt-cache";
import { fetchGroundTruth } from "@/app/lib/ground-truth";
import { runFinalCheck } from "@/app/lib/final-check";
import { countSentProperties } from "@/app/lib/estimate-context";
import { supabase } from "@/app/lib/supabase";

// ─── 送信時の最終チェックAPI（スタッフ編集後テキストの再チェック専用）───────────
// page.tsx executeSend() が「生成時チェックのハッシュと不一致」（=スタッフが編集した）
// 場合のみ呼ぶ。3パス並列（各2.5s abort）なので実測 ≤3s。クライアント側は2.8sで
// タイムアウトして fail-open する（このAPIがどれだけ遅くても送信はブロックされない）。
//
// ⚠️ このルートでは自動修正（revised_text）は絶対に行わない。
//    スタッフが手で編集した文章をAIが書き換えるのは越権（判断はスタッフに返す）。
export const maxDuration = 15;

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
  let suggestedAixMeta: {
    action: string | null;
    reply_mode?: "aix" | "auto_reply" | null;
    enforcement_level?: "required" | "recommended" | "optional";
  } | null = null;
  try {
    const body = await req.json() as {
      text?: string;
      conversationId?: string;
      recentMessages?: Array<{ sender: string; text: string }>;
      customerName?: string;
      isAix?: boolean;
      suggestedAixMeta?: {
        action: string | null;
        reply_mode?: "aix" | "auto_reply" | null;
        enforcement_level?: "required" | "recommended" | "optional";
      } | null;
    };
    text = (body.text ?? "").trim();
    conversationId = body.conversationId;
    recentMessages = Array.isArray(body.recentMessages) ? body.recentMessages : [];
    customerName = body.customerName;
    isAix = body.isAix ?? false;
    suggestedAixMeta = body.suggestedAixMeta ?? null;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });

  // ルール + 正解データを並列取得（fetchGroundTruth は throw せず1.5sで諦める fail-open）
  // ルールは共有キャッシュ（prompt-cache.ts: TTL60秒 + SWR + fail-open）経由で取得
  const [dbRules, groundTruth, finalCheckRules] = await Promise.all([
    getCachedPromptRules("generate_reply", {}),
    fetchGroundTruth(conversationId),
    // includeGlobal=false: global共通ルールを除外し final_check 専用ルールのみ取得
    getCachedPromptRules("final_check", {}, false),
  ]);
  const lastCustomerMessage = [...recentMessages].reverse().find((m) => m.sender === "customer")?.text;

  // A-3（2026-09-08）: generate-reply が保存した tpo_label / phaseGuideKey を ai_draft_check.tpo_debug から引き、
  // 生成時と送信時で同一の場面ラベル・フェーズで決定論チェックが走るようにする（従来は ctx 欠落で
  // WAIT免除・開口語チェック・STATE_REGRESSION が送信時だけ効かなかった）。fail-open（取得失敗は従来どおり）
  let tpoLabel: string | undefined;
  let phaseKey: string | undefined;
  if (conversationId) {
    try {
      const { data: convRow } = await supabase
        .from("conversations")
        .select("ai_draft_check")
        .eq("id", conversationId)
        .maybeSingle();
      const dbg = (convRow as { ai_draft_check?: { tpo_debug?: { tpo_label?: string | null; phaseGuideKey?: string | null } } | null } | null)?.ai_draft_check?.tpo_debug;
      tpoLabel = dbg?.tpo_label ?? undefined;
      phaseKey = dbg?.phaseGuideKey ?? undefined;
    } catch (e) {
      console.warn("[check-reply] ai_draft_check 取得失敗（ctx なしで続行）:", e instanceof Error ? e.message : e);
    }
  }
  const MEDIA_ONLY_RE = /^\s*(?:\[(?:画像|動画|スタンプ|ファイル)\]\s*)+$/;
  const hasStaffText = recentMessages.some((m) => m.sender === "staff" && !!(m.text || "").trim() && !MEDIA_ONLY_RE.test(m.text || ""));
  // 2026-09-08 Fable5: generate-reply と同じ countSentProperties()（見積書画像・地図等の非物件送付は除外）
  const sentPropertiesCount = countSentProperties(recentMessages);

  // haikuTimeoutMs=2500: 送信時専用の短いタイムアウト（クライアント 2800ms 以内に収まる）
  // generate-reply は runFinalCheckWithRevision 経由でデフォルト 8000ms を使用
  const result = await runFinalCheck(text, {
    dbRules,
    finalCheckRules: finalCheckRules || undefined,
    recentMessages,
    lastCustomerMessage,
    // brainContextJson（旧step1Json）なし: check-reply モードでは履歴から Haiku 自身に質問を抽出させる
    checkpointFacts: groundTruth.checkpointFacts,
    customerConditionsDb: groundTruth.customerConditionsDb,
    staffSourceText: customerName ? `お客様のお名前: ${customerName}さん` : undefined,
    customerName: customerName || undefined,
    tpoLabel,
    phaseKey,
    isEarlyConversation: !hasStaffText,
    sentPropertiesCount,
    isAix,
    brainMeta: suggestedAixMeta
      ? {
          action: (suggestedAixMeta.action ?? null) as string | null,
          enforcement_level: (suggestedAixMeta.enforcement_level ?? "recommended") as "required" | "recommended",
        }
      : null,
  }, 2500);
  delete result.revised_text; // このモードでは絶対に書き換え結果を返さない

  return NextResponse.json(result);
}
