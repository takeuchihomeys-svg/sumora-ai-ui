import { NextRequest, NextResponse } from "next/server";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { getCachedPromptRules } from "@/app/lib/prompt-cache";
import { fetchGroundTruth } from "@/app/lib/ground-truth";
import { runFinalCheck, sha1, type CheckResult } from "@/app/lib/final-check";
// 2026-09-09 Fable5 行動台帳: generate-reply と同じ buildActionLedger（aix_usage_logs > line_tasks > 本文）で送付実績を決める
import { buildActionLedger, type LedgerAixRow, type LedgerTask } from "@/app/lib/action-ledger";
// G32（2026-09-09 Fable5 じゅにあ事例）: 冒頭決定（挨拶行＋開口語）を generate-reply と同じ resolveGreeting で再計算（四者同名）。createdAt が無ければ tpo_debug.greeting の復元値
import { resolveGreeting, toGreetingLite, normalizeGreetingLite, computeAlreadyGreetedToday, isProgressPushMessage, type GreetingDecisionLite } from "@/app/lib/greeting";
import { analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse, resolveTurnPair, type PairContext, type SubstanceVerdict } from "@/app/lib/reply-context";
import { isConditionFormMessage } from "@/app/lib/line-reply-prompts";
// 2026-09-11 竹内方針3: 呼び名の唯一の決定（generate-reply と同じ関数）
import { resolveAddressName } from "@/app/lib/validate-reply";

// 2026-09-11 統合設計（経路G・T4）: 送信時チェック（2.3s）は Sonnet の context_check が時間内にほぼ返らない（24h で約76%タイムアウト）。
//   context_check を Haiku で走らせる（生成時の3パス結果を未完走の結果で上書きしない）。モデル ID は final-check の MODEL_CHECK_FAST と同じ
const MODEL_CHECK_FAST_FOR_SEND = "claude-haiku-4-5-20251001";
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
  let recentMessages: Array<{ sender: string; text: string; createdAt?: string }> = [];
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
      recentMessages?: Array<{ sender: string; text: string; createdAt?: string }>;
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
  // 2026-09-11 竹内方針3: 呼び名は generate-reply と同じ resolveAddressName で決める（旧: body.customerName の生値をそのまま基準名にしていた）
  const addressName = resolveAddressName({ messages: recentMessages, displayName: customerName ?? "" });
  customerName = addressName.name || undefined;

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
  let greetingLite: GreetingDecisionLite | undefined;
  let stored: (CheckResult & { context_hash?: string }) | undefined;
  if (conversationId) {
    try {
      const { data: convRow } = await supabase
        .from("conversations")
        .select("ai_draft_check")
        .eq("id", conversationId)
        .maybeSingle();
      stored = (convRow as { ai_draft_check?: (CheckResult & { context_hash?: string }) | null } | null)?.ai_draft_check ?? undefined;
      const dbg = (convRow as { ai_draft_check?: { tpo_debug?: { tpo_label?: string | null; phaseGuideKey?: string | null; greeting?: unknown } } | null } | null)?.ai_draft_check?.tpo_debug;
      tpoLabel = dbg?.tpo_label ?? undefined;
      phaseKey = dbg?.phaseGuideKey ?? undefined;
      // G32: 生成時の冒頭決定（旧形式 kind=waited は normalizeGreetingLite が standard へ写像）
      greetingLite = normalizeGreetingLite(dbg?.greeting) ?? undefined;
    } catch (e) {
      console.warn("[check-reply] ai_draft_check 取得失敗（ctx なしで続行）:", e instanceof Error ? e.message : e);
    }
  }
  // 2026-09-11 統合設計（経路G・T4）: 同じテキスト×同じ顧客文なら、生成時に3パス完走したチェック結果をそのまま返す
  //   （送信時の2.3sチェックが生成時の完走結果を未完走の結果で上書きしていた。page.tsx は変更しない＝サーバ側だけで直す）
  try {
    if (stored && (stored.passes_completed?.length ?? 0) === 3 && stored.checked_text_hash === await sha1(text.trim())
        && !!stored.context_hash && stored.context_hash === await sha1((lastCustomerMessage ?? "").trim())) {
      const { revised_text: _r, ...rest } = stored;
      void _r;
      return NextResponse.json({ ...rest, reused_from_generation: true });
    }
  } catch (e) {
    console.warn("[check-reply] 生成時結果の再利用判定に失敗（再チェックで続行）:", e instanceof Error ? e.message : e);
  }
  const MEDIA_ONLY_RE = /^\s*(?:\[(?:画像|動画|スタンプ|ファイル)\]\s*)+$/;
  const hasStaffText = recentMessages.some((m) => m.sender === "staff" && !!(m.text || "").trim() && !MEDIA_ONLY_RE.test(m.text || ""));
  // 2026-09-09 Fable5 行動台帳: generate-reply と同じ buildActionLedger（一次証拠 aix_usage_logs > line_tasks > 本文 regex）。fail-open
  const [aixRes, taskRes] = conversationId
    ? await Promise.all([
        supabase.from("aix_usage_logs").select("aix_type, check_pattern, created_at, sent_at, line_message_id, generated_text, property_names, estimate_sent").eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(30).then((r) => r, () => ({ data: [] as LedgerAixRow[] })),
        // 2026-09-11 統合設計（L6）: result 列も取る（property_check の result=NULL は「機械的に閉じられただけ」で報告ではない＝generate-reply と同じ台帳）
        supabase.from("line_tasks").select("task_type, status, created_at, completed_at, result").eq("conversation_id", conversationId).in("status", ["pending", "completed"]).order("created_at", { ascending: false }).limit(20).then((r) => r, () => ({ data: [] as LedgerTask[] })),
      ])
    : [{ data: [] as LedgerAixRow[] }, { data: [] as LedgerTask[] }];
  const lastCustomerAt = [...recentMessages].reverse().find((m) => m.sender === "customer")?.createdAt ?? null;
  const ledger = buildActionLedger({
    recentAixRows: (aixRes.data ?? []) as LedgerAixRow[],
    messages: recentMessages,
    lineTasks: (taskRes.data ?? []) as LedgerTask[],
    lastCustomerAt,
  });
  const sentPropertiesCount = ledger.facts.propertiesSentCount;
  // 2026-09-11 統合設計（L6・経路E6）: 往復文脈を generate-reply と同じ入力（aix 行・直前スタッフ時刻・台帳・直前の顧客発言）で作り、
  //   final-check に渡す（旧実装は final-check 内で aix 行・時刻なしに再計算し、生成時と別の staff 判定が context_check に同居していた）
  let substanceForCheck: SubstanceVerdict | undefined;
  let pairContextForCheck: PairContext | undefined;
  try {
    const lastStaffForPair = [...recentMessages].reverse().find((m) => m.sender === "staff" && !MEDIA_ONLY_RE.test(m.text || ""));
    const lastStaffIdx = recentMessages.map((m) => m.sender).lastIndexOf("staff");
    const priorCustomerText = lastStaffIdx < 0 ? "" : [...recentMessages.slice(0, lastStaffIdx)].reverse().find((m) => m.sender === "customer")?.text ?? "";
    const staffTurn = classifyLastStaffTurn(lastStaffForPair?.text ?? "", { recentAixRows: (aixRes.data ?? []) as never, lastStaffAt: lastStaffForPair?.createdAt ?? null, ledger });
    substanceForCheck = analyzeSubstance(lastCustomerMessage, undefined, { staffAskedQuestion: staffTurn.kind === "question_to_customer" });
    const customer = classifyCustomerResponse(substanceForCheck, staffTurn, { isConditionPresented: isConditionFormMessage(lastCustomerMessage ?? ""), ledger });
    pairContextForCheck = resolveTurnPair(staffTurn, customer, substanceForCheck, lastStaffForPair?.text ?? "", { ledger, customerName: customerName ?? "", priorCustomerText });
  } catch (e) {
    console.warn("[check-reply] 往復文脈の構築に失敗（final-check 内の再計算で続行）:", e instanceof Error ? e.message : e);
    substanceForCheck = undefined; pairContextForCheck = undefined;
  }

  // G32: 冒頭決定（四者同名）。createdAt があれば generate-reply と同じ resolveGreeting で再計算、無ければ tpo_debug.greeting の復元値
  //      （復元値が first なのにスタッフ送信済みなら古い decision の誤適用防止のため破棄）
  let greetingDecision: GreetingDecisionLite | undefined = greetingLite && greetingLite.kind === "first" && hasStaffText ? undefined : greetingLite;
  if (recentMessages.some((m) => !!m.createdAt)) {
    try {
      const lastStaff = [...recentMessages].reverse().find((m) => m.sender === "staff");
      const staffTurn = classifyLastStaffTurn(lastStaff?.text ?? "", { recentAixRows: (aixRes.data ?? []) as never, lastStaffAt: lastStaff?.createdAt ?? null, ledger });
      const substance = analyzeSubstance(lastCustomerMessage, undefined, { staffAskedQuestion: staffTurn.kind === "question_to_customer" });
      const customerResponse = classifyCustomerResponse(substance, staffTurn);
      greetingDecision = toGreetingLite(resolveGreeting({
        customerName: customerName ?? "",
        isFirstEverReply: !hasStaffText,
        alreadyGreetedToday: computeAlreadyGreetedToday(recentMessages) ?? false,
        recentMessages,
        jstHour: (new Date().getUTCHours() + 9) % 24,
        isProgressPush: isProgressPushMessage(lastCustomerMessage, { isAckOnly: substance.isAckOnly }),
        isSubstantive: (t) => analyzeSubstance(t).has,
        customerKind: customerResponse.kind,
        customerSecondary: customerResponse.secondary,
        substanceKinds: substance.kinds,
        isDeliverableReply: isAix,
      }));
    } catch (e) {
      console.warn("[check-reply] greeting 再計算失敗（復元値で続行）:", e instanceof Error ? e.message : e);
    }
  }

  // timeoutMs=2300: 送信時専用の短いタイムアウト（クライアント 2800ms 以内に収まる）。再送はしない（時間が無い）
  // generate-reply は runFinalCheckWithRevision 経由で deadline 連動（パス上限 rule 20s / anomaly 15s / context 25s・失敗パスは1回再送）
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
    nameAliases: addressName.aliases,
    tpoLabel,
    phaseKey,
    greetingDecision, // G32: 冒頭の対称検査（final-check ⑦）の正
    isEarlyConversation: !hasStaffText,
    sentPropertiesCount,
    // 台帳は渡すが ledgerStrict=false（スタッフ編集文の再チェック＝実行前提語は warning に留め、判断はスタッフに返す）
    ledger, ledgerStrict: false,
    isAix,
    brainMeta: suggestedAixMeta
      ? {
          action: (suggestedAixMeta.action ?? null) as string | null,
          enforcement_level: (suggestedAixMeta.enforcement_level ?? "recommended") as "required" | "recommended",
        }
      : null,
    substance: substanceForCheck, pairContext: pairContextForCheck,
  }, { timeoutMs: 2300, retry: false, passModels: { context_check: MODEL_CHECK_FAST_FOR_SEND } });
  delete result.revised_text; // このモードでは絶対に書き換え結果を返さない

  return NextResponse.json(result);
}
