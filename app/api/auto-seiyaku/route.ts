import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

export const maxDuration = 300;

// 申込中相当のステータス（正規キー "applying" + 旧データの後方互換エイリアス）
// ※ closed_won は既に成約済みのため対象外
const APPLYING_STATUSES = ["applying", "application", "screening", "contract"];

// 「2週間無連絡」の閾値（日数）
const INACTIVE_DAYS = 14;

// 1回の実行で処理する会話の上限（安全弁）
const MAX_CANDIDATES = 200;

/**
 * 申込中（applying 相当）の会話で、最後のメッセージ（customer/staff どちらも）から
 * 14日以上経過しているものを自動的にご成約（closed_won）へ更新する。
 *
 * - 成約パターン学習は cron/analyze-closed-conversations（毎日 JST 21:00）が
 *   「直近48時間に closed_won になった会話」を拾うため、ここでは updated_at を
 *   現在時刻に更新するだけで自動的に学習対象になる（手動の updateConversationStatus と同じ挙動）。
 * - メッセージが1件もない会話は判定材料がないためスキップする。
 */
async function runAutoSeiyaku() {
  const runLogId = await startCronLog("auto-seiyaku");

  try {
    const nowMs = Date.now();
    const cutoffIso = new Date(nowMs - INACTIVE_DAYS * 24 * 3600 * 1000).toISOString();

    // 申込中相当の会話を取得
    const { data: convs, error: convErr } = await supabase
      .from("conversations")
      .select("id, customer_name, status")
      .in("status", APPLYING_STATUSES)
      .limit(MAX_CANDIDATES);

    if (convErr) {
      await finishCronLog(runLogId, false, undefined, convErr.message);
      return NextResponse.json({ ok: false, error: convErr.message }, { status: 500 });
    }

    const candidates = (convs ?? []) as Array<{
      id: string;
      customer_name: string | null;
      status: string | null;
    }>;

    let updated = 0;
    let skippedNoMessages = 0;
    let skippedRecentActivity = 0;
    const details: Array<{
      id: string;
      customer_name: string | null;
      prev_status: string | null;
      last_message_at: string;
      days_inactive: number;
    }> = [];
    const errors: string[] = [];

    for (const conv of candidates) {
      try {
        // 会話の最終メッセージ（sender問わず）を取得
        // 「無連絡」= 顧客からもスタッフからも14日間やり取りがない状態
        const { data: lastMsg, error: msgErr } = await supabase
          .from("messages")
          .select("created_at")
          .eq("conversation_id", conv.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (msgErr) {
          errors.push(`${conv.id}: ${msgErr.message}`);
          continue;
        }
        if (!lastMsg?.created_at) {
          // メッセージゼロの会話は判定不能なので触らない
          skippedNoMessages += 1;
          continue;
        }
        if (lastMsg.created_at > cutoffIso) {
          skippedRecentActivity += 1;
          continue;
        }

        // 14日以上無連絡 → ご成約（closed_won）へ更新
        // .in("status", ...) で競合ガード（実行中に手動でステータス変更された場合は上書きしない）
        const { error: updateErr } = await supabase
          .from("conversations")
          .update({
            status: "closed_won",
            updated_at: new Date().toISOString(),
          })
          .eq("id", conv.id)
          .in("status", APPLYING_STATUSES);

        if (updateErr) {
          errors.push(`${conv.id}: ${updateErr.message}`);
          continue;
        }

        updated += 1;
        details.push({
          id: conv.id,
          customer_name: conv.customer_name,
          prev_status: conv.status,
          last_message_at: lastMsg.created_at,
          days_inactive: Math.floor(
            (nowMs - new Date(lastMsg.created_at).getTime()) / (24 * 3600 * 1000),
          ),
        });
      } catch (e) {
        errors.push(`${conv.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const summary = {
      candidates: candidates.length,
      updated,
      skipped_no_messages: skippedNoMessages,
      skipped_recent_activity: skippedRecentActivity,
      failed: errors.length,
    };
    await finishCronLog(runLogId, true, { ...summary, errors: errors.slice(0, 5) });
    return NextResponse.json({ ok: true, ...summary, details });
  } catch (e) {
    console.error("[auto-seiyaku]", e);
    const message = e instanceof Error ? e.message : String(e);
    await finishCronLog(runLogId, false, undefined, message);
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}

function isAuthorized(req: NextRequest): boolean {
  // fail-closed: CRON_SECRET 未設定時も拒否（未認証実行を防ぐ）
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  return Boolean(cronSecret) && auth === `Bearer ${cronSecret}`;
}

// GET: Vercel Cron から毎日 JST 9:00（UTC 0:00）に実行
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return runAutoSeiyaku();
}

// POST: 手動実行用（同じく CRON_SECRET 認証必須）
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return runAutoSeiyaku();
}
