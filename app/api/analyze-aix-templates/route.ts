import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

// ── AIXテンプレート実績の週次学習（analyze-aix-templates）────
// スタッフがAIXボタン後にTemplateModalで選んで送ったテンプレート文
// (template_selection_logs.final_sent_text) を ai_reply_examples に
// entry_source='aix_template' としてバックフィルする。
//
// データの流れ:
//   template_selection_logs (aix_action_type IS NOT NULL) … テンプレート選択実績
//     final_sent_text = 実際に送った文（学習対象）
//     was_modified_after_adapt = スタッフが編集したか
//   aix_usage_logs (conversation_id一致・aix_type一致・±60分以内)
//     generated_text … AIX本文の冒頭200字（customer_messageの文脈として付与）
//     customer_reacted … ⭐品質シグナル
//   messages (送信直前の customer 3件) … 「お客様の状況」テキスト
//
// 冪等管理: template_selection_logs.example_backfilled_at
//   NULL のレコードのみ処理対象。INSERT 成功後に更新。
//   - 処理失敗したログは更新しない → 次回実行で再試行（フェイルオープン）。
//   - さらに INSERT 前に同一 sent_reply の重複チェックを必ず行う（二重バックフィル防止）。
//
// 起動経路:
//   1. Vercel cron（毎週日曜 UTC21:00 = JST月曜6:00・vercel.json 参照）→ GET → POST 委譲
//   2. 手動 POST（INTERNAL_API_SECRET / CRON_SECRET・Body: { limit?: number }）

export const maxDuration = 300;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// ── 品質フィルター（2026-08-29追加）──────────────────────────────
// 短文（「はい」「承知しました」等）は学習価値がないため除外する
const MIN_TEXT_LENGTH = 30;
// 物件カード形式（構造化記号で始まる本文）はテンプレ実例バケットへの誤混入とみなし除外する
const CARD_FORMAT_PATTERN = /^[🌟⭐★■━┏◆▼]/;

// aix_usage_logs との突合窓: AIX送信（usage log）はテンプレート送信の前に起きるため
// 「テンプレート送信の60分前 〜 5分後」の同一アクションログを直前のAIX送信とみなす
// （調査で284/285件がこの窓で成立確認済み）
const USAGE_WINDOW_BEFORE_MS = 60 * 60 * 1000;
const USAGE_WINDOW_AFTER_MS = 5 * 60 * 1000;

// customer_message に付与するAIX本文の最大文字数
const AIX_CONTEXT_MAX_CHARS = 200;

// CRON_SECRET（Vercel cron）または INTERNAL_API_SECRET（requireInternalAuth）のどちらかで認証する
function checkAuth(req: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (cronSecret && auth === `Bearer ${cronSecret}`) return null;
  return requireInternalAuth(req);
}

type TemplateLogRow = {
  id: string;
  aix_action_type: string;
  conversation_id: string | null;
  final_sent_text: string | null;
  adapted_text: string | null; // AI適応後・スタッフ編集前のテキスト（ai_draft として保存 → 差分学習対象）
  created_at: string | null;
  was_modified_after_adapt: boolean | null;
  conversation_status: string | null;
  brain_template_hint: string | null;
};

type UsageLogRow = {
  conversation_id: string;
  aix_type: string | null;
  created_at: string | null;
  customer_reacted: boolean | null;
  generated_text: string | null; // AIX本文（customer_messageに文脈として追加する）
};

type LogResult = { inserted: boolean; skipped?: string; error?: string };

// テンプレート選択ログ1件をバックフィルする。成功（または重複としてスキップ確定）時のみ
// example_backfilled_at を更新する。
async function backfillFromTemplateLog(
  log: TemplateLogRow,
  usageLogs: UsageLogRow[]
): Promise<LogResult> {
  const sentText = (log.final_sent_text ?? "").trim();
  const sentAt = log.created_at;
  if (!sentText || !sentAt || !log.conversation_id) {
    // データ不備 → 学習価値なし。マークして確定スキップ（無限再試行防止）
    await markBackfilled(log.id);
    return { inserted: false, skipped: "missing_data" };
  }

  // 品質フィルター①: 30字未満の短文（「はい」「承知しました」等）は学習対象外
  if (sentText.length < MIN_TEXT_LENGTH) {
    await markBackfilled(log.id);
    return { inserted: false, skipped: "too_short" };
  }

  // 品質フィルター②: 物件カード形式（🌟・■等の構造化記号で始まる）は誤混入とみなし除外
  if (CARD_FORMAT_PATTERN.test(sentText)) {
    await markBackfilled(log.id);
    return { inserted: false, skipped: "card_format" };
  }

  // 重複チェック: 同一 aix_action + 同一 sent_reply がテンプレートバケットに既に存在すれば挿入しない
  const { data: dup, error: dupErr } = await supabase
    .from("ai_reply_examples")
    .select("id")
    .eq("entry_source", "aix_template")
    .eq("aix_action", log.aix_action_type)
    .eq("sent_reply", sentText)
    .limit(1)
    .maybeSingle();
  if (dupErr) return { inserted: false, error: `重複チェック失敗: ${dupErr.message}` };
  if (dup) {
    await markBackfilled(log.id);
    return { inserted: false, skipped: "duplicate" };
  }

  // 送信時刻の直前の顧客メッセージ3件 → 「お客様の状況」テキスト
  const { data: msgRows, error: msgErr } = await supabase
    .from("messages")
    .select("text")
    .eq("conversation_id", log.conversation_id)
    .eq("sender", "customer")
    .lt("created_at", sentAt)
    .not("text", "is", null)
    .order("created_at", { ascending: false })
    .limit(3);
  if (msgErr) return { inserted: false, error: `messages取得失敗: ${msgErr.message}` };
  let customerMessage = ((msgRows ?? []) as Array<{ text: string | null }>)
    .map((m) => (m.text ?? "").trim())
    .filter((t) => t.length > 0)
    .reverse() // 最新順で取得 → 時系列順に並べ直す
    .join("\n")
    .slice(0, 1000);

  // 品質フィルター③: 顧客メッセージ文脈が1件もない実例は ⭐候補にしない（is_starred=false 強制）
  // ※ 後段で付与する〔直前のAIX送信〕文脈は顧客発話ではないため、ここで判定を確定させる
  const hasCustomerContext = customerMessage.length > 0;

  // aix_usage_logs 突合: 同一会話・同一アクション・「送信60分前〜5分後」窓内で最も時間の近いログ
  const sentTime = new Date(sentAt).getTime();
  const usage = usageLogs
    .filter((u) => {
      if (u.conversation_id !== log.conversation_id) return false;
      if (u.aix_type !== log.aix_action_type) return false;
      if (!u.created_at) return false;
      const t = new Date(u.created_at).getTime();
      return t >= sentTime - USAGE_WINDOW_BEFORE_MS && t <= sentTime + USAGE_WINDOW_AFTER_MS;
    })
    .sort(
      (a, b) =>
        Math.abs(new Date(a.created_at!).getTime() - sentTime) -
        Math.abs(new Date(b.created_at!).getTime() - sentTime)
    )[0];

  // 直前のAIX送信本文（冒頭200字）を文脈として customer_message に付与
  const aixText = (usage?.generated_text ?? "").trim();
  if (aixText) {
    const aixContext = `〔直前のAIX送信〕${aixText.slice(0, AIX_CONTEXT_MAX_CHARS)}`;
    customerMessage = customerMessage ? `${customerMessage}\n${aixContext}` : aixContext;
  }

  const wasModified = log.was_modified_after_adapt === true;
  // AI適応後・スタッフ編集前のテキストを ai_draft として保存する。
  // これがないと aix-weekly-learning の差分学習（ai_draft IS NOT NULL 条件）で永遠に対象外になる
  const aiDraft = (log.adapted_text ?? "").trim();
  const { error: insErr } = await supabase.from("ai_reply_examples").insert({
    entry_source: "aix_template",
    aix_action: log.aix_action_type,
    // 顧客メッセージが1件もない場合は既存の慣例（save-reply-example）に合わせる
    customer_message: customerMessage || "（初回連絡）",
    sent_reply: sentText,
    conversation_state: log.conversation_status ?? "unknown",
    conversation_id: log.conversation_id,
    sent_at: sentAt,
    // お客様が反応した実例 = ⭐良い実例（aix-template-generate が is_starred 優先で参照）
    // 品質フィルター③: 顧客メッセージ文脈がない実例は品質シグナルを下げる（⭐にしない）
    is_starred: hasCustomerContext && usage?.customer_reacted === true,
    // AI適応のまま送信 / スタッフが編集して送信
    reply_angle: wasModified ? "ai_edited" : "ai_generated",
    was_ai_used: true,
    was_ai_modified: wasModified,
    ...(aiDraft && aiDraft !== sentText ? { ai_draft: aiDraft } : {}),
    // embedding は付与しない → backfill-embeddings が embedding IS NULL を拾って後追い生成する
  });
  if (insErr) return { inserted: false, error: `ai_reply_examples insert失敗: ${insErr.message}` };

  // バックフィル完了 → example_backfilled_at を記録（冪等ガード）
  // 更新失敗時は次回再処理されるが、上の sent_reply 重複チェックで捕捉されるため二重挿入にはならない
  const marked = await markBackfilled(log.id);
  if (!marked) return { inserted: true, error: "example_backfilled_at更新失敗（重複チェックで次回捕捉）" };

  return { inserted: true };
}

async function markBackfilled(logId: string): Promise<boolean> {
  const { error } = await supabase
    .from("template_selection_logs")
    .update({ example_backfilled_at: new Date().toISOString() })
    .eq("id", logId);
  if (error) console.warn("[analyze-aix-templates] example_backfilled_at更新失敗:", error.message);
  return !error;
}

export async function POST(req: NextRequest) {
  const authError = checkAuth(req);
  if (authError) return authError;

  let limit = DEFAULT_LIMIT;
  try {
    const body = await req.json() as { limit?: number };
    if (typeof body.limit === "number" && Number.isFinite(body.limit)) {
      limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(body.limit)));
    }
  } catch {
    // Body なし（cron GET 委譲等）はデフォルト値で続行
  }

  const runLogId = await startCronLog("analyze-aix-templates");
  try {
    // Step 1: 未処理のテンプレート選択実績を取得
    // aix_action_type IS NOT NULL = AIXボタン経由のテンプレート送信（学習対象）
    const { data: logRows, error: logErr } = await supabase
      .from("template_selection_logs")
      .select("id, aix_action_type, conversation_id, final_sent_text, adapted_text, created_at, was_modified_after_adapt, conversation_status, brain_template_hint")
      .not("aix_action_type", "is", null)
      .not("final_sent_text", "is", null)
      .neq("final_sent_text", "")
      .not("conversation_id", "is", null)
      .is("example_backfilled_at", null)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (logErr) {
      await finishCronLog(runLogId, false, undefined, logErr.message);
      return NextResponse.json({ ok: false, error: logErr.message }, { status: 500 });
    }
    const logs = (logRows ?? []) as TemplateLogRow[];

    if (logs.length === 0) {
      await finishCronLog(runLogId, true, { candidates: 0, inserted: 0 });
      return NextResponse.json({ ok: true, candidates: 0, inserted: 0, skipped: 0, failed: 0 });
    }

    const convIds = Array.from(new Set(logs.map((l) => l.conversation_id).filter((c): c is string => !!c)));

    // Step 2-3 の一括プリフェッチ: aix_usage_logs（±60分窓用・generated_text = AIX本文も取得）
    // ※ conversation_state は template_selection_logs.conversation_status（送信時点のスナップショット）を
    //   そのまま使うため conversations の再取得は不要
    const { data: usageRows, error: usageErr } = await supabase
      .from("aix_usage_logs")
      .select("conversation_id, aix_type, created_at, customer_reacted, generated_text")
      .in("conversation_id", convIds);
    // aix_usage_logs 取得失敗はフェイルオープン（品質シグナル・AIX文脈なしでバックフィル続行）
    if (usageErr) {
      console.warn("[analyze-aix-templates] aix_usage_logs取得失敗:", usageErr.message);
    }
    const usageLogs = (usageRows ?? []) as UsageLogRow[];

    // Step 4: 1件ずつバックフィル（1件の失敗は他を止めない）
    let inserted = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const log of logs) {
      try {
        const result = await backfillFromTemplateLog(log, usageLogs);
        if (result.inserted) inserted += 1;
        else if (result.skipped) skipped += 1;
        else {
          failed += 1;
          if (result.error) errors.push(`${log.id}: ${result.error}`);
        }
      } catch (e) {
        failed += 1;
        errors.push(`${log.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Step 5: embedding バックフィルを fire-and-forget で起動（generate-reply 方式）
    // 挿入したレコードは embedding NULL のため、backfill-embeddings の対象として拾われる
    if (inserted > 0 && process.env.INTERNAL_API_SECRET) {
      const baseUrl =
        process.env.NEXT_PUBLIC_APP_URL ??
        (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
      void fetch(`${baseUrl}/api/backfill-embeddings`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.INTERNAL_API_SECRET}` },
      }).catch((e) =>
        console.warn("[analyze-aix-templates] backfill-embeddings起動失敗:", e instanceof Error ? e.message : String(e))
      );
    }

    const summary = { candidates: logs.length, inserted, skipped, failed };
    await finishCronLog(runLogId, true, { ...summary, errors: errors.slice(0, 5) });
    return NextResponse.json({ ok: true, ...summary, errors: errors.slice(0, 5) });
  } catch (e) {
    console.error("[analyze-aix-templates]", e);
    await finishCronLog(runLogId, false, undefined, e instanceof Error ? e.message : String(e));
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}

// GET: Vercel Cron は GET でリクエストするため、認証チェック後 POST へ委譲
export async function GET(req: NextRequest) {
  const authError = checkAuth(req);
  if (authError) return authError;
  return POST(req);
}
