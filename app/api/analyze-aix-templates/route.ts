import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

// ── AIXテンプレート橋渡し文の学習データバックフィル（analyze-aix-templates）────
// 「✨ この会話に合った文を生成」（aix-template-generate）は ai_reply_examples の
// AIX専用実例バケット（entry_source='aix_action' + 同一 aix_action）を参照するが、
// 過去のAIX送信実績がほとんど蓄積されていない。
//
// この API は過去の aix_generate_log（AIXが生成し実際に送信確認された橋渡し文）から
// 「どのAIXアクションで・どんなお客様状況のとき・どんな橋渡し文を送ったか」を復元し、
// ai_reply_examples に entry_source='aix_action' としてバックフィルする。
//
// データの流れ:
//   aix_generate_log (status='used')          … 送信確認済みの生成文（学習対象）
//     ※ スキーマ上の status は generated / used / discarded。
//       'used' = save-reply-example が送信確認時に更新した「実際に送られた」ログ。
//   aix_usage_logs (aix_type一致・±5分以内)    … customer_reacted（⭐品質シグナル）/ was_edited
//   messages (送信直前の customer 3件)         … 「お客様の状況」テキスト
//   conversations.status                       … 会話フェーズ（conversation_state として保存）
//
// 冪等管理: aix_generate_log.example_backfilled_at（migrate-schema で追加）。
//   - NULL のログのみ処理対象。INSERT 成功（または重複確認）後に更新する。
//   - 処理失敗したログは更新しない → 次回実行で再試行（フェイルオープン）。
//   - さらに INSERT 前に同一 sent_reply の重複チェックを必ず行う（二重バックフィル防止）。
//
// 起動経路:
//   1. Vercel cron（毎週日曜 UTC21:00 = JST月曜6:00・vercel.json 参照）→ GET → POST 委譲
//   2. 手動 POST（INTERNAL_API_SECRET / CRON_SECRET・Body: { limit?: number }）

export const maxDuration = 300;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// aix_usage_logs との突合窓（生成時刻±5分以内の同一アクションログを送信ログとみなす）
const USAGE_MATCH_WINDOW_MS = 5 * 60 * 1000;

// CRON_SECRET（Vercel cron）または INTERNAL_API_SECRET（requireInternalAuth）のどちらかで認証する
function checkAuth(req: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (cronSecret && auth === `Bearer ${cronSecret}`) return null;
  return requireInternalAuth(req);
}

type GenerateLogRow = {
  id: string;
  action_type: string;
  conversation_id: string | null;
  generated_text: string | null;
  generated_at: string | null;
  check_pattern: string | null;
};

type UsageLogRow = {
  conversation_id: string;
  aix_type: string | null;
  created_at: string | null;
  customer_reacted: boolean | null;
  was_edited: boolean | null;
};

type LogResult = { inserted: boolean; skipped?: string; error?: string };

// 生成ログ1件をバックフィルする。成功（または重複としてスキップ確定）時のみ
// example_backfilled_at を更新する。
async function backfillFromLog(
  log: GenerateLogRow,
  conv: { customer_name: string | null; status: string | null } | undefined,
  usageLogs: UsageLogRow[]
): Promise<LogResult> {
  const generatedText = (log.generated_text ?? "").trim();
  const generatedAt = log.generated_at;
  if (!generatedText || !generatedAt || !log.conversation_id) {
    // データ不備 → 学習価値なし。マークして確定スキップ（無限再試行防止）
    await markBackfilled(log.id);
    return { inserted: false, skipped: "missing_data" };
  }

  // 重複チェック: 同一 aix_action + 同一 sent_reply が AIX バケットに既に存在すれば挿入しない
  const { data: dup, error: dupErr } = await supabase
    .from("ai_reply_examples")
    .select("id")
    .eq("entry_source", "aix_action")
    .eq("aix_action", log.action_type)
    .eq("sent_reply", generatedText)
    .limit(1)
    .maybeSingle();
  if (dupErr) return { inserted: false, error: `重複チェック失敗: ${dupErr.message}` };
  if (dup) {
    await markBackfilled(log.id);
    return { inserted: false, skipped: "duplicate" };
  }

  // 送信（生成）時刻の直前の顧客メッセージ3件 → 「お客様の状況」テキスト
  const { data: msgRows, error: msgErr } = await supabase
    .from("messages")
    .select("text")
    .eq("conversation_id", log.conversation_id)
    .eq("sender", "customer")
    .lt("created_at", generatedAt)
    .not("text", "is", null)
    .order("created_at", { ascending: false })
    .limit(3);
  if (msgErr) return { inserted: false, error: `messages取得失敗: ${msgErr.message}` };
  const customerMessage = ((msgRows ?? []) as Array<{ text: string | null }>)
    .map((m) => (m.text ?? "").trim())
    .filter((t) => t.length > 0)
    .reverse() // 最新順で取得 → 時系列順に並べ直す
    .join("\n")
    .slice(0, 1000);

  // aix_usage_logs 突合: 同一会話・同一アクション・生成時刻±5分以内の最も近いログ
  const genTime = new Date(generatedAt).getTime();
  const usage = usageLogs
    .filter(
      (u) =>
        u.conversation_id === log.conversation_id &&
        u.aix_type === log.action_type &&
        u.created_at &&
        Math.abs(new Date(u.created_at).getTime() - genTime) < USAGE_MATCH_WINDOW_MS
    )
    .sort(
      (a, b) =>
        Math.abs(new Date(a.created_at!).getTime() - genTime) -
        Math.abs(new Date(b.created_at!).getTime() - genTime)
    )[0];

  const wasEdited = usage?.was_edited === true;
  const { error: insErr } = await supabase.from("ai_reply_examples").insert({
    entry_source: "aix_action",
    aix_action: log.action_type,
    // 顧客メッセージが1件もない場合は既存の慣例（save-reply-example）に合わせる
    customer_message: customerMessage || "（初回連絡）",
    sent_reply: generatedText,
    conversation_state: conv?.status ?? "unknown",
    conversation_id: log.conversation_id,
    sent_at: generatedAt,
    // お客様が反応した実例 = ⭐良い実例（aix-template-generate が is_starred 優先で参照）
    is_starred: usage?.customer_reacted === true,
    // AI生成のまま送信 / スタッフが編集して送信（usage log なしは ai_generated 扱い）
    reply_angle: wasEdited ? "ai_edited" : "ai_generated",
    was_ai_used: true,
    was_ai_modified: wasEdited,
    // embedding は付与しない → backfill-embeddings が embedding IS NULL を拾って後追い生成する
  });
  if (insErr) return { inserted: false, error: `ai_reply_examples insert失敗: ${insErr.message}` };

  // バックフィル完了 → example_backfilled_at を記録（冪等ガード）
  // 更新失敗時は inserted:false を返して次回再処理させると重複INSERTになるが、
  // 次回は上の sent_reply 重複チェックで捕捉されるため二重挿入にはならない
  const marked = await markBackfilled(log.id);
  if (!marked) return { inserted: true, error: "example_backfilled_at更新失敗（重複チェックで次回捕捉）" };

  return { inserted: true };
}

async function markBackfilled(logId: string): Promise<boolean> {
  const { error } = await supabase
    .from("aix_generate_log")
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
    // Step 1: 未処理の送信確認済み生成ログを取得
    // status='used' = save-reply-example が送信確認時に generated → used へ更新したログ
    const { data: logRows, error: logErr } = await supabase
      .from("aix_generate_log")
      .select("id, action_type, conversation_id, generated_text, generated_at, check_pattern")
      .eq("status", "used")
      .not("generated_text", "is", null)
      .neq("generated_text", "")
      .not("conversation_id", "is", null)
      .is("example_backfilled_at", null)
      .order("generated_at", { ascending: false })
      .limit(limit);
    if (logErr) {
      await finishCronLog(runLogId, false, undefined, logErr.message);
      return NextResponse.json({ ok: false, error: logErr.message }, { status: 500 });
    }
    const logs = (logRows ?? []) as GenerateLogRow[];

    if (logs.length === 0) {
      await finishCronLog(runLogId, true, { candidates: 0, inserted: 0 });
      return NextResponse.json({ ok: true, candidates: 0, inserted: 0, skipped: 0, failed: 0 });
    }

    const convIds = Array.from(new Set(logs.map((l) => l.conversation_id).filter((c): c is string => !!c)));

    // Step 2-3 の一括プリフェッチ: conversations（会話フェーズ）と aix_usage_logs（品質シグナル）
    const [convRes, usageRes] = await Promise.all([
      supabase.from("conversations").select("id, customer_name, status").in("id", convIds),
      supabase
        .from("aix_usage_logs")
        .select("conversation_id, aix_type, created_at, customer_reacted, was_edited")
        .in("conversation_id", convIds),
    ]);
    if (convRes.error) {
      await finishCronLog(runLogId, false, undefined, convRes.error.message);
      return NextResponse.json({ ok: false, error: convRes.error.message }, { status: 500 });
    }
    // aix_usage_logs 取得失敗はフェイルオープン（品質シグナルなしでバックフィル続行）
    if (usageRes.error) {
      console.warn("[analyze-aix-templates] aix_usage_logs取得失敗:", usageRes.error.message);
    }
    const convMap = new Map(
      ((convRes.data ?? []) as Array<{ id: string; customer_name: string | null; status: string | null }>)
        .map((c) => [c.id, { customer_name: c.customer_name, status: c.status }])
    );
    const usageLogs = (usageRes.data ?? []) as UsageLogRow[];

    // Step 4: 1件ずつバックフィル（1件の失敗は他を止めない）
    let inserted = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const log of logs) {
      try {
        const result = await backfillFromLog(
          log,
          log.conversation_id ? convMap.get(log.conversation_id) : undefined,
          usageLogs
        );
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
