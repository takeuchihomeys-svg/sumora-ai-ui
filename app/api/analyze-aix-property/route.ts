import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

// ── AIX物件本文の週次学習（analyze-aix-property）──────────────────
// AIXボタン「物件ピックアップ（property_send）」「物件オススメ（property_recommendation）」で
// 実際に送信された本文（aix_usage_logs.generated_text）を ai_reply_examples に
// entry_source='aix_property' としてバックフィルする。
// aix/action がこのバケットを直接参照し、過去の良質な訴求文をfew-shotとして注入する。
//
// データの流れ:
//   aix_usage_logs (aix_type IN ('property_send','property_recommendation'))
//     generated_text … 実際に送信されたAIX物件本文（学習対象）
//     customer_reacted … ⭐品質シグナル（お客様が反応した実例 = is_starred）
//     was_edited … スタッフが編集して送ったか（reply_angle: ai_edited / ai_generated）
//   messages (送信直前の customer 3件) … 「お客様の状況」テキスト
//   conversations.suggested_aix_meta … AIX-META主要フィールド（あれば文脈として付与）
//
// 冪等管理: aix_usage_logs.property_example_backfilled_at
//   NULL のレコードのみ処理対象。INSERT 成功後に更新。
//   - 処理失敗したログは更新しない → 次回実行で再試行（フェイルオープン）。
//   - INSERT 前に同一 sent_reply の重複チェックを必ず行う（二重バックフィル防止）。
//
// 起動経路:
//   1. Vercel cron（毎週日曜 UTC22:00 = JST月曜7:00・vercel.json 参照）→ GET → POST 委譲
//   2. 手動 POST（INTERNAL_API_SECRET / CRON_SECRET・Body: { limit?: number }）

export const maxDuration = 300;

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

// 学習対象とみなす本文の最小文字数（挨拶だけの断片・エラー文を除外）
// ※ 30字未満の短文（「はい」等）はこの条件で同時に除外される
const MIN_TEXT_LENGTH = 50;

// 品質フィルター（2026-08-29追加）: 物件カード形式（構造化記号で始まる本文）は
// 「訴求文」バケットへの誤混入とみなし除外する（学習対象は会話的な物件紹介文のみ）
const CARD_FORMAT_PATTERN = /^[🌟⭐★■━┏◆▼]/;

// ai_draft（スタッフ編集前のAIX原文）を aix_generate_log から引く突合窓（送信60分前まで）
const DRAFT_LOOKUP_WINDOW_MS = 60 * 60 * 1000;

// CRON_SECRET（Vercel cron）または INTERNAL_API_SECRET（requireInternalAuth）のどちらかで認証する
function checkAuth(req: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (cronSecret && auth === `Bearer ${cronSecret}`) return null;
  return requireInternalAuth(req);
}

type UsageLogRow = {
  id: string;
  conversation_id: string | null;
  aix_type: string;
  generated_text: string | null;
  customer_reacted: boolean | null;
  was_edited: boolean | null;
  conversation_status: string | null;
  sent_at: string | null;
  created_at: string | null;
};

type AixMetaLite = {
  customer_intent?: string | null;
  checkpoint_stage?: string | null;
  closing_strategy?: string | null;
  repeated_concern?: string | null;
  winning_pattern?: string | null;
  property_search_params?: { preferences?: string | string[] | null } | null;
};

type LogResult = { inserted: boolean; skipped?: string; error?: string };

async function markBackfilled(logId: string): Promise<boolean> {
  const { error } = await supabase
    .from("aix_usage_logs")
    .update({ property_example_backfilled_at: new Date().toISOString() })
    .eq("id", logId);
  if (error) console.warn("[analyze-aix-property] property_example_backfilled_at更新失敗:", error.message);
  return !error;
}

// AIX-META主要フィールドを customer_message 末尾に付与する文脈テキストに変換する。
// suggested_aix_meta は揮発フィールド（スタッフ返信でクリア）のため、取得できた場合のみベストエフォートで付与。
function buildMetaContext(meta: AixMetaLite | null): string {
  if (!meta) return "";
  const prefs = meta.property_search_params?.preferences;
  const prefText = Array.isArray(prefs) ? prefs.join("・") : (prefs ?? "");
  const lines = [
    meta.customer_intent ? `顧客インテント: ${meta.customer_intent}` : "",
    meta.checkpoint_stage ? `フェーズ: ${meta.checkpoint_stage}` : "",
    meta.closing_strategy ? `成約戦略: ${meta.closing_strategy}` : "",
    meta.repeated_concern ? `繰り返し懸念: ${meta.repeated_concern}` : "",
    meta.winning_pattern ? `勝ちパターン: ${meta.winning_pattern}` : "",
    prefText ? `刺さるポイント: ${prefText}` : "",
  ].filter(Boolean);
  return lines.length > 0 ? `〔AIX-META〕${lines.join(" / ")}` : "";
}

// 使用ログ1件をバックフィルする。成功（または重複としてスキップ確定）時のみ
// property_example_backfilled_at を更新する。
async function backfillFromUsageLog(log: UsageLogRow): Promise<LogResult> {
  const sentText = (log.generated_text ?? "").trim();
  const anchorAt = log.sent_at ?? log.created_at;
  if (!sentText || sentText.length < MIN_TEXT_LENGTH || !anchorAt || !log.conversation_id) {
    // データ不備 → 学習価値なし。マークして確定スキップ（無限再試行防止）
    await markBackfilled(log.id);
    return { inserted: false, skipped: "missing_data" };
  }

  // 品質フィルター: 物件カード形式（🌟・■等の構造化記号で始まる）は誤混入とみなし除外
  if (CARD_FORMAT_PATTERN.test(sentText)) {
    await markBackfilled(log.id);
    return { inserted: false, skipped: "card_format" };
  }

  // 重複チェック: 同一 aix_action + 同一 sent_reply が物件バケットに既に存在すれば挿入しない
  const { data: dup, error: dupErr } = await supabase
    .from("ai_reply_examples")
    .select("id")
    .eq("entry_source", "aix_property")
    .eq("aix_action", log.aix_type)
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
    .lt("created_at", anchorAt)
    .not("text", "is", null)
    .order("created_at", { ascending: false })
    .limit(3);
  if (msgErr) return { inserted: false, error: `messages取得失敗: ${msgErr.message}` };
  let customerMessage = ((msgRows ?? []) as Array<{ text: string | null }>)
    .map((m) => (m.text ?? "").trim())
    .filter((t) => t.length > 0 && t !== "[画像]" && t !== "[動画]")
    .reverse() // 最新順で取得 → 時系列順に並べ直す
    .join("\n")
    .slice(0, 800);

  // 品質フィルター: 顧客メッセージ文脈が1件もない実例は ⭐候補にしない（is_starred=false 強制）
  // ※ 後段で付与する〔AIX-META〕文脈は顧客発話ではないため、ここで判定を確定させる
  const hasCustomerContext = customerMessage.length > 0;

  // AIX-META主要フィールドを文脈として付与（揮発フィールドのためベストエフォート）
  try {
    const { data: convRow } = await supabase
      .from("conversations")
      .select("suggested_aix_meta")
      .eq("id", log.conversation_id)
      .maybeSingle();
    const metaContext = buildMetaContext((convRow?.suggested_aix_meta ?? null) as AixMetaLite | null);
    if (metaContext) {
      customerMessage = customerMessage ? `${customerMessage}\n${metaContext}` : metaContext;
    }
  } catch {
    // meta取得失敗は無視（顧客メッセージのみでバックフィル続行）
  }

  const wasEdited = log.was_edited === true;

  // スタッフ編集前のAIX原文を ai_draft として取得（best-effort）。
  // aix_usage_logs.generated_text は編集後テキストのため、真の原文は aix_generate_log にある。
  // これがないと aix-weekly-learning の差分学習（ai_draft IS NOT NULL 条件）で永遠に対象外になる
  let aiDraft: string | null = null;
  if (wasEdited) {
    try {
      const windowStart = new Date(new Date(anchorAt).getTime() - DRAFT_LOOKUP_WINDOW_MS).toISOString();
      const { data: genRow } = await supabase
        .from("aix_generate_log")
        .select("generated_text")
        .eq("conversation_id", log.conversation_id)
        .eq("action_type", log.aix_type)
        .gte("generated_at", windowStart)
        .lte("generated_at", anchorAt)
        .order("generated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const draft = ((genRow?.generated_text as string | null) ?? "").trim();
      if (draft && draft !== sentText) aiDraft = draft;
    } catch {
      // 原文取得失敗は無視（ai_draft なしでバックフィル続行）
    }
  }

  const { error: insErr } = await supabase.from("ai_reply_examples").insert({
    entry_source: "aix_property",
    aix_action: log.aix_type,
    customer_message: customerMessage || "（初回連絡）",
    sent_reply: sentText,
    conversation_state: log.conversation_status ?? log.aix_type,
    conversation_id: log.conversation_id,
    sent_at: anchorAt,
    // お客様が反応した実例 = ⭐良い実例（aix/action が is_starred 優先で参照）
    // 品質フィルター: 顧客メッセージ文脈がない実例は品質シグナルを下げる（⭐にしない）
    is_starred: hasCustomerContext && log.customer_reacted === true,
    reply_angle: wasEdited ? "ai_edited" : "ai_generated",
    was_ai_used: true,
    was_ai_modified: wasEdited,
    ...(aiDraft ? { ai_draft: aiDraft } : {}),
    // embedding は付与しない → backfill-embeddings が embedding IS NULL を拾って後追い生成する
  });
  if (insErr) return { inserted: false, error: `ai_reply_examples insert失敗: ${insErr.message}` };

  // バックフィル完了 → property_example_backfilled_at を記録（冪等ガード）
  // 更新失敗時は次回再処理されるが、上の sent_reply 重複チェックで捕捉されるため二重挿入にはならない
  const marked = await markBackfilled(log.id);
  if (!marked) return { inserted: true, error: "property_example_backfilled_at更新失敗（重複チェックで次回捕捉）" };

  return { inserted: true };
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

  const runLogId = await startCronLog("analyze-aix-property");
  try {
    // Step 1: 未処理のAIX物件本文送信実績を取得
    // sent_at IS NOT NULL = 実際にLINE送信された本文のみ学習対象（生成のみ・破棄されたドラフトは除外）
    const { data: logRows, error: logErr } = await supabase
      .from("aix_usage_logs")
      .select("id, conversation_id, aix_type, generated_text, customer_reacted, was_edited, conversation_status, sent_at, created_at")
      .in("aix_type", ["property_send", "property_recommendation"])
      .not("generated_text", "is", null)
      .neq("generated_text", "")
      .not("conversation_id", "is", null)
      .not("sent_at", "is", null)
      .is("property_example_backfilled_at", null)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (logErr) {
      await finishCronLog(runLogId, false, undefined, logErr.message);
      return NextResponse.json({ ok: false, error: logErr.message }, { status: 500 });
    }
    const logs = (logRows ?? []) as UsageLogRow[];

    if (logs.length === 0) {
      await finishCronLog(runLogId, true, { candidates: 0, inserted: 0 });
      return NextResponse.json({ ok: true, candidates: 0, inserted: 0, skipped: 0, failed: 0 });
    }

    // Step 2: 1件ずつバックフィル（1件の失敗は他を止めない）
    let inserted = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const log of logs) {
      try {
        const result = await backfillFromUsageLog(log);
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

    // Step 3: embedding バックフィルを fire-and-forget で起動（analyze-aix-templates と同方式）
    // 挿入したレコードは embedding NULL のため、backfill-embeddings の対象として拾われる
    if (inserted > 0 && process.env.INTERNAL_API_SECRET) {
      const baseUrl =
        process.env.NEXT_PUBLIC_APP_URL ??
        (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
      void fetch(`${baseUrl}/api/backfill-embeddings`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.INTERNAL_API_SECRET}` },
      }).catch((e) =>
        console.warn("[analyze-aix-property] backfill-embeddings起動失敗:", e instanceof Error ? e.message : String(e))
      );
    }

    const summary = { candidates: logs.length, inserted, skipped, failed };
    await finishCronLog(runLogId, true, { ...summary, errors: errors.slice(0, 5) });
    return NextResponse.json({ ok: true, ...summary, errors: errors.slice(0, 5) });
  } catch (e) {
    console.error("[analyze-aix-property]", e);
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
