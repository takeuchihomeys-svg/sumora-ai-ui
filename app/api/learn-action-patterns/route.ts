import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { normalizeStatus } from "@/app/lib/status-normalize";

// bootstrapは最大1200超のDB往復が発生するため延長（Vercel Pro上限300秒）
export const maxDuration = 300;

// AIX送信後に呼び出す（1件ログ）または既存データをブートストラップ
// POST { action: "log", conversation_status, action_type, customer_msg_summary }
// POST { action: "bootstrap" }  → 既存データから一括学習
// GET → パターン統計を返す

export async function GET() {
  const { data, error } = await supabase
    .from("action_pattern_logs")
    .select("conversation_status, action_type")
    .neq("source", "bootstrap_done") // 完了マーカー行は統計から除外
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // ステータス×アクションの集計
  const freq: Record<string, Record<string, number>> = {};
  for (const row of data ?? []) {
    const s = row.conversation_status as string;
    const a = row.action_type as string;
    freq[s] ??= {};
    freq[s][a] = (freq[s][a] ?? 0) + 1;
  }
  return NextResponse.json({ ok: true, total: data?.length ?? 0, freq });
}

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    action: "log" | "bootstrap";
    conversation_status?: string;
    action_type?: string;
    customer_msg_summary?: string;
    previous_action_type?: string;
    predicted_action?: string;
    source?: string;
    suggestion_source?: string;
    conversation_id?: string;
    dismissed_reason?: string;
  };

  // ① 1件ログ（AIX送信後にフロントから呼ぶ）
  if (body.action === "log") {
    if (!body.conversation_status || !body.action_type) {
      return NextResponse.json({ ok: false, error: "missing fields" });
    }
    // フロントから渡された source を尊重（提案採択学習ループ用）
    // 高2: page.tsx が送る全 source を許可（未登録だと manual に化けて学習の重み付けが壊れる）
    const ALLOWED_SOURCES = new Set(["manual", "suggestion_accepted", "suggestion_dismissed", "prediction_match", "prediction_mismatch", "send_cancelled", "suggestion_bypassed", "prediction_accepted", "prediction_bypassed", "split_draft_used"]);
    const source = body.source && ALLOWED_SOURCES.has(body.source) ? body.source : "manual";

    // 案5: 却下理由（提案バナー✕→3択チップで選択）。想定外の値はnullに落とす
    const ALLOWED_DISMISS_REASONS = new Set(["timing_early", "wrong_action", "already_done"]);
    const dismissedReason = body.dismissed_reason && ALLOWED_DISMISS_REASONS.has(body.dismissed_reason) ? body.dismissed_reason : null;

    // PA-1: previous_action_type の確実な記録
    // フロントの lastAixByConvRef はリロードで消える（921/937件がNULLの根本原因）ため、
    // 未指定時は aix_usage_logs からサーバー側で復元する
    let previousAction: string | null = body.previous_action_type ?? null;
    if (!previousAction && body.conversation_id) {
      const { data: recentUsage } = await supabase
        .from("aix_usage_logs")
        .select("aix_type, created_at")
        .eq("conversation_id", body.conversation_id)
        .order("created_at", { ascending: false })
        .limit(2);
      if (recentUsage && recentUsage.length > 0) {
        // 競合ガード: フロントは /api/log-aix-usage を並行で叩くため、
        // 「今回の送信ログ」（同一action_typeかつ直近30秒以内）が既にINSERT済みならスキップして1つ前を採用
        const first = recentUsage[0];
        const isCurrentSend =
          first.aix_type === body.action_type &&
          Date.now() - new Date(first.created_at as string).getTime() < 30_000;
        const prevRow = isCurrentSend ? recentUsage[1] : first;
        previousAction = (prevRow?.aix_type as string) ?? null;
      }
    }

    await supabase.from("action_pattern_logs").insert({
      conversation_status: normalizeStatus(body.conversation_status),
      action_type: body.action_type,
      customer_msg_summary: (body.customer_msg_summary ?? "").slice(0, 150),
      previous_action_type: previousAction,
      predicted_action: body.predicted_action ?? null,
      conversation_id: body.conversation_id ?? null,
      source,
      // 中5: 提案経路（suggest-next-action の source）。どのルール経由の提案が採択されたかの集計に使う
      suggestion_source: body.suggestion_source ?? null,
      // 案5: 却下理由（timing_early / wrong_action / already_done）。suggestion_dismissed 時のみ入る
      dismissed_reason: dismissedReason,
    });
    return NextResponse.json({ ok: true });
  }

  // ② ブートストラップ（一度だけ呼ぶ）
  if (body.action === "bootstrap") {
    // 冪等ガード: 「完了マーカー」が存在する場合のみスキップ
    // （途中失敗で部分挿入されたまま永久に再実行拒否になるのを防ぐため、
    //   マーカーは全件完了時のみセットする）
    const { count: doneCount } = await supabase
      .from("action_pattern_logs")
      .select("id", { count: "exact", head: true })
      .eq("source", "bootstrap_done");
    if ((doneCount ?? 0) > 0) {
      return NextResponse.json({ ok: false, error: "already bootstrapped" });
    }

    // 前回途中失敗の部分挿入データを削除してから再実行（重複防止）
    await supabase
      .from("action_pattern_logs")
      .delete()
      .in("source", ["bootstrap", "bootstrap_inferred"]);

    const inserted: { status: string; action: string; msg: string }[] = [];
    let failed = 0;

    // ---- A: line_tasks → property_check / property_send / estimate_sheet ----
    const { data: tasks } = await supabase
      .from("line_tasks")
      .select("id, conversation_id, task_type, created_at")
      .in("status", ["completed", "pending"])
      .order("created_at", { ascending: false })
      .limit(400);

    for (const task of tasks ?? []) {
      try {
        // タスク作成直前の顧客メッセージを取得
        const { data: msgRow } = await supabase
          .from("messages")
          .select("text")
          .eq("conversation_id", task.conversation_id as string)
          .eq("sender", "customer")
          .lt("created_at", task.created_at as string)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        // この会話の現在のステータス
        const { data: conv } = await supabase
          .from("conversations")
          .select("status")
          .eq("id", task.conversation_id as string)
          .maybeSingle();

        const status = normalizeStatus((conv?.status as string) ?? "hearing");
        const actionType = task.task_type as string;
        const msgText = ((msgRow?.text as string) ?? "").slice(0, 150);

        const { error: insertError } = await supabase.from("action_pattern_logs").insert({
          conversation_status: status,
          action_type: actionType,
          customer_msg_summary: msgText,
          source: "bootstrap",
        });
        if (insertError) throw new Error(insertError.message);
        inserted.push({ status, action: actionType, msg: msgText.slice(0, 30) });
      } catch (e) {
        failed++;
        console.error(`[bootstrap] task ${task.id} failed:`, e instanceof Error ? e.message : e);
      }
    }

    // ---- B: 内覧・申込フェーズの会話から viewing_invite / application_push を推定 ----
    // viewing以降のステータス = 内覧が成立したはず
    const { data: viewingConvs } = await supabase
      .from("conversations")
      .select("id, status")
      .in("status", ["viewing", "application", "contract"])
      .limit(200);

    for (const conv of viewingConvs ?? []) {
      try {
        // その会話の最後の顧客メッセージを取得（タイミング推定用）
        const { data: msgRow } = await supabase
          .from("messages")
          .select("text")
          .eq("conversation_id", conv.id as string)
          .eq("sender", "customer")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        // viewing = proposing → viewing の遷移で viewing_invite が使われた
        // application/contract = viewing → application で application_push が使われた
        const rawPrevStatus = (conv.status as string) === "viewing" ? "proposing" : "viewing";
        const prevStatus = normalizeStatus(rawPrevStatus);
        const actionType = (conv.status as string) === "viewing" ? "viewing_invite" : "application_push";
        const msgText = ((msgRow?.text as string) ?? "").slice(0, 150);

        const { error: insertError } = await supabase.from("action_pattern_logs").insert({
          conversation_status: prevStatus,
          action_type: actionType,
          customer_msg_summary: msgText,
          source: "bootstrap_inferred",
        });
        if (insertError) throw new Error(insertError.message);
        inserted.push({ status: prevStatus, action: actionType, msg: msgText.slice(0, 30) });
      } catch (e) {
        failed++;
        console.error(`[bootstrap] conv ${conv.id} failed:`, e instanceof Error ? e.message : e);
      }
    }

    // 冪等フラグ: 全件エラーなしで完了した場合のみ完了マーカーをセット
    // （失敗があった場合はマーカー未設定のまま → 次回再実行で部分データを削除してやり直せる）
    if (failed === 0) {
      const { error: markerError } = await supabase.from("action_pattern_logs").insert({
        conversation_status: "_meta",
        action_type: "_bootstrap_done",
        customer_msg_summary: "",
        source: "bootstrap_done",
      });
      if (markerError) console.error("[bootstrap] failed to set done marker:", markerError.message);
    }

    return NextResponse.json({ ok: true, inserted: inserted.length, failed, complete: failed === 0, breakdown: inserted.slice(0, 20) });
  }

  return NextResponse.json({ ok: false, error: "unknown action" });
}
