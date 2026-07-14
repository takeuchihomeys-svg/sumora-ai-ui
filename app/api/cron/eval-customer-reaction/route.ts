import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

export const maxDuration = 60;

// POST /api/cron/eval-customer-reaction（毎日 JST 20:30）
// 顧客反応ベースの正誤評価:
// AI返信後 72時間以内にお客様から返信があれば → 正解（correct_count++）
// 72時間以内に返信なし → 誤（wrong_count++）
// 申込中・審査中（applying/screening）は別ツールでやりとりするため除外。
const BATCH_LIMIT = 200;
const CONCURRENCY = 10;

// 72時間以内に返信あり → 正解、なし → 誤
const REACTION_WINDOW_HOURS = 72;
// 申込中・審査中は screening-admin でやりとりするため LINE沈黙は誤シグナルにしない
const EXCLUDED_STATUSES = ["applying", "screening"];
// H-4: 顧客返信を期待しないAIXアクション（非返信=wrong にしてはいけない）
// - meeting_place: 待ち合わせ確定連絡（返信不要）
// - greeting_viewing: 内覧後挨拶（社交的・返信率低くても正常）
// - acknowledge_check: 管理会社/オーナー宛て確認（顧客へのメッセージでない）
// - condition_hearing: 条件ヒアリングフォーム送付（フォーム回答=LINE返信でない）
const EXCLUDED_AIX_TYPES = ["meeting_place", "greeting_viewing", "acknowledge_check", "condition_hearing"];

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const runLogId = await startCronLog("eval-customer-reaction");

  try {
    const now = Date.now();
    const since7d = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
    const until72hAgo = new Date(now - REACTION_WINDOW_HOURS * 3600 * 1000).toISOString();

    // 送信から72h以上経過した未評価ログ
    const { data: usageLogs, error: usageErr } = await supabase
      .from("aix_usage_logs")
      .select("id, conversation_id, aix_type, sent_at, created_at")
      .is("customer_reacted", null)
      .gte("created_at", since7d)
      .lte("created_at", until72hAgo)
      .order("created_at", { ascending: true })
      .limit(BATCH_LIMIT);

    if (usageErr) {
      await finishCronLog(runLogId, false, undefined, usageErr.message);
      return NextResponse.json({ ok: false, error: usageErr.message }, { status: 500 });
    }

    const rawLogs = (usageLogs ?? []) as Array<{
      id: string;
      conversation_id: string;
      aix_type: string | null;
      sent_at: string | null;
      created_at: string;
    }>;

    if (rawLogs.length === 0) {
      await finishCronLog(runLogId, true, { evaluated: 0 });
      return NextResponse.json({ ok: true, evaluated: 0 });
    }

    // 申込中・審査中の会話を除外（別ツールでやりとりしているため）
    const convIds = [...new Set(rawLogs.map(l => l.conversation_id))];
    const { data: convStatuses } = await supabase
      .from("conversations")
      .select("id, status")
      .in("id", convIds);
    const excludedConvIds = new Set(
      (convStatuses ?? [])
        .filter(c => EXCLUDED_STATUSES.includes(c.status as string))
        .map(c => c.id as string)
    );
    const statusFiltered = rawLogs.filter(l => !excludedConvIds.has(l.conversation_id));
    const skippedByStatus = rawLogs.length - statusFiltered.length;
    // H-4: 返信不要アクションを72h非返信評価から除外（非返信=wrong の誤シグナル防止）
    const logs = statusFiltered.filter(l => !l.aix_type || !EXCLUDED_AIX_TYPES.includes(l.aix_type));
    const skippedByAixType = statusFiltered.length - logs.length;

    if (logs.length === 0) {
      await finishCronLog(runLogId, true, { evaluated: 0, skipped_by_status: skippedByStatus, skipped_by_aix_type: skippedByAixType });
      return NextResponse.json({ ok: true, evaluated: 0, skipped_by_status: skippedByStatus, skipped_by_aix_type: skippedByAixType });
    }

    const reactedIds: string[] = [];
    const notReactedIds: string[] = [];

    // 送信後72h以内に顧客返信があったかを確認（CONCURRENCY件ずつ並列）
    const startTime = Date.now();
    for (let i = 0; i < logs.length; i += CONCURRENCY) {
      if (Date.now() - startTime > 50_000) {
        console.warn("[eval-customer-reaction] 時間制限到達");
        break;
      }
      const chunk = logs.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async (log) => {
        const sendTime = log.sent_at ?? log.created_at;
        const windowEnd = new Date(new Date(sendTime).getTime() + REACTION_WINDOW_HOURS * 3600 * 1000).toISOString();
        try {
          const { count, error } = await supabase
            .from("messages")
            .select("id", { count: "exact", head: true })
            .eq("conversation_id", log.conversation_id)
            .eq("sender", "customer")
            .gt("created_at", sendTime)
            .lte("created_at", windowEnd);
          if (error) { console.warn("[eval-customer-reaction] per-item失敗 id:", log.id, "error:", error.message); return; }
          if ((count ?? 0) > 0) reactedIds.push(log.id);
          else notReactedIds.push(log.id);
        } catch (e) { console.warn("[eval-customer-reaction] per-item失敗 id:", log.id, "error:", (e as Error)?.message); }
      }));
    }

    // まとめて UPDATE
    if (reactedIds.length > 0) {
      const { error: reactErr } = await supabase.from("aix_usage_logs").update({ customer_reacted: true }).in("id", reactedIds);
      if (reactErr) console.warn("[eval-customer-reaction] reacted update failed:", reactErr.message);
    }
    if (notReactedIds.length > 0) {
      const { error: notReactErr } = await supabase.from("aix_usage_logs").update({ customer_reacted: false }).in("id", notReactedIds);
      if (notReactErr) console.warn("[eval-customer-reaction] not-reacted update failed:", notReactErr.message);
    }

    const evaluated = reactedIds.length + notReactedIds.length;
    const reactionRate = evaluated > 0 ? Math.round((reactedIds.length / evaluated) * 1000) / 1000 : null;

    // ── 正誤シグナルを ai_reply_knowledge にフィードバック ──
    // 72h以内に返信あり → correct_count++、なし → wrong_count++
    // knowledge_apply_log から適用されたナレッジIDを特定して更新
    let knowledgeFed = 0;
    try {
      const reactedSet = new Set(reactedIds);
      const notReactedSet = new Set(notReactedIds);

      // aix_usage_log.id → conversation_id マップ
      const idToConv = new Map<string, string>();
      for (const log of logs) idToConv.set(log.id, log.conversation_id);

      const reactedConvIds = new Set(reactedIds.map(id => idToConv.get(id) ?? "").filter(Boolean));
      const notReactedConvIds = new Set(notReactedIds.map(id => idToConv.get(id) ?? "").filter(Boolean));
      const allConvIds = [...new Set([...reactedConvIds, ...notReactedConvIds])];

      if (allConvIds.length > 0) {
        // ④ source フィルタ: この cron は AIX 送信（aix_usage_logs）への反応を評価するため、
        // aix/action 由来の適用ログのみ対象にする（generate-reply 由来と混在させない）
        const { data: applyLogs } = await supabase
          .from("knowledge_apply_log")
          .select("knowledge_id, conversation_id")
          .in("conversation_id", allConvIds)
          .eq("result", "pending")
          .eq("source", "aix_action");

        type FeedbackPair = { knowledge_id: string; conversation_id: string };
        const kCorrect: FeedbackPair[] = [];
        const kWrong: FeedbackPair[] = [];
        const correctPairs = new Set<string>();
        const wrongPairs = new Set<string>();

        for (const al of (applyLogs ?? [])) {
          const kid = al.knowledge_id as string;
          const convId = al.conversation_id as string;
          if (!kid || !convId) continue;
          const pairKey = `${kid}::${convId}`;
          if (reactedConvIds.has(convId) && !correctPairs.has(pairKey)) {
            correctPairs.add(pairKey);
            kCorrect.push({ knowledge_id: kid, conversation_id: convId });
          } else if (notReactedConvIds.has(convId) && !wrongPairs.has(pairKey)) {
            wrongPairs.add(pairKey);
            kWrong.push({ knowledge_id: kid, conversation_id: convId });
          }
        }

        if (kCorrect.length > 0 || kWrong.length > 0) {
          // ① ペア単位RPC: (knowledge_id × conversation_id) で更新（別会話の pending ログ巻き込み防止）
          await supabase.rpc("update_knowledge_feedback_by_pairs", {
            p_correct_pairs: kCorrect.length > 0 ? kCorrect : null,
            p_wrong_pairs: kWrong.length > 0 ? kWrong : null,
            p_feedback_source: "reaction_72h",
          });
          knowledgeFed = kCorrect.length + kWrong.length;
        }
      }
    } catch (e) {
      console.warn("[eval-customer-reaction] knowledge feedback失敗:", e);
    }

    // ── 低反応 aix_type のナレッジを decay（学習ループへの接続） ──
    let decaySucceeded = 0;
    let decayFailed = 0;
    let brushupSucceeded = 0;
    let brushupFailed = 0;
    try {
      const notReactedSet = new Set(notReactedIds);
      const reactedSet = new Set(reactedIds);
      const notReactedByType = new Map<string, number>();
      const totalByType = new Map<string, number>();
      for (const log of logs) {
        if (!log.aix_type) continue;
        if (reactedSet.has(log.id) || notReactedSet.has(log.id)) {
          totalByType.set(log.aix_type, (totalByType.get(log.aix_type) ?? 0) + 1);
        }
        if (!notReactedSet.has(log.id)) continue;
        notReactedByType.set(log.aix_type, (notReactedByType.get(log.aix_type) ?? 0) + 1);
      }
      for (const [aix_type, count] of notReactedByType.entries()) {
        const total = totalByType.get(aix_type) ?? count;
        const notReactedRate = count / total;
        if (count < 2 || notReactedRate < 0.5) continue;
        const { data: staleIds } = await supabase
          .from("ai_reply_knowledge")
          .select("id")
          .eq("conversation_state", aix_type)
          .neq("hypothesis_status", "rejected")
          .lt("importance", 7)
          .limit(30);
        const ids = (staleIds ?? []).map(r => r.id as string).filter(Boolean);
        if (ids.length === 0) {
          console.warn(`[eval-customer-reaction] decay skip: aix_type="${aix_type}" に conversation_state一致のknowledgeが見つかりません`);
          continue;
        }
        const { error: rpcErr } = await supabase.rpc("decay_knowledge_importance", { p_ids: ids });
        if (rpcErr) {
          console.warn(`[eval-customer-reaction] decay RPC失敗: aix_type="${aix_type}"`, rpcErr.message);
          decayFailed++;
        } else {
          decaySucceeded++;
        }
      }
    } catch (e) {
      console.warn("[eval-customer-reaction] ナレッジdecay失敗:", e);
    }

    // ── confirmed rules (importance>=7) の高非反応率ズレ検知 ──
    try {
      const { data: highImpStats } = await supabase
        .from("aix_usage_logs")
        .select("aix_type, customer_reacted")
        .not("customer_reacted", "is", null)
        .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

      const highImpBuckets: Record<string, { total: number; noReact: number }> = {};
      for (const row of (highImpStats ?? [])) {
        const t = (row.aix_type as string) ?? "unknown";
        if (!highImpBuckets[t]) highImpBuckets[t] = { total: 0, noReact: 0 };
        highImpBuckets[t].total++;
        if (!row.customer_reacted) highImpBuckets[t].noReact++;
      }

      for (const [aix_type, stats] of Object.entries(highImpBuckets)) {
        if (stats.total < 5) continue;
        const noReactRate = stats.noReact / stats.total;
        if (noReactRate < 0.7) continue;

        const { data: highRules } = await supabase
          .from("ai_reply_knowledge")
          .select("id, title")
          .eq("hypothesis_status", "confirmed")
          .eq("conversation_state", aix_type)
          .gte("importance", 7)
          .limit(3);

        for (const rule of (highRules ?? [])) {
          // dedup: implementation_notes に knowledge_id が含まれる pending 起票が既にあればスキップ
          // （旧実装の .filter("cs", ...) はJSON文字列表現に依存して一致せずdedupが効かなかった）
          const { data: existing } = await supabase
            .from("aix_feature_suggestions")
            .select("id")
            .eq("suggestion_type", "knowledge_brushup")
            .eq("status", "pending")
            .ilike("implementation_notes", `%${rule.id as string}%`)
            .limit(1);
          if (existing && existing.length > 0) continue;

          const { error: brushupErr } = await supabase.from("aix_feature_suggestions").insert({
            suggestion_type: "knowledge_brushup",
            // suggested_title は NOT NULL 制約あり（欠落するとINSERTが100%失敗する）
            suggested_title: `要見直し: ${(rule.title as string).slice(0, 40)}`,
            description: `⚠️ 顧客非反応率 ${Math.round(noReactRate * 100)}%（${stats.total}件）: 「${(rule.title as string).slice(0, 50)}」のルールを見直してください`,
            implementation_notes: JSON.stringify({ knowledge_id: rule.id as string, aix_type, no_react_rate: noReactRate }),
            action_type: aix_type,
            status: "pending",
          });
          if (brushupErr) {
            console.warn("[eval-customer-reaction] brushup insert失敗:", brushupErr.message);
            brushupFailed++;
          } else {
            brushupSucceeded++;
          }
        }
      }
    } catch (e) {
      console.warn("[eval-customer-reaction] confirmed brushup失敗:", e);
    }

    await finishCronLog(runLogId, true, {
      evaluated,
      reacted: reactedIds.length,
      not_reacted: notReactedIds.length,
      reaction_rate: reactionRate,
      knowledge_fed: knowledgeFed,
      skipped_by_status: skippedByStatus,
      skipped_by_aix_type: skippedByAixType,
      decay_succeeded: decaySucceeded,
      decay_failed: decayFailed,
      brushup_succeeded: brushupSucceeded,
      brushup_failed: brushupFailed,
    });
    return NextResponse.json({
      ok: true,
      evaluated,
      reacted: reactedIds.length,
      not_reacted: notReactedIds.length,
      reaction_rate: reactionRate,
      knowledge_fed: knowledgeFed,
      skipped_by_status: skippedByStatus,
      skipped_by_aix_type: skippedByAixType,
      decay_succeeded: decaySucceeded,
      decay_failed: decayFailed,
      brushup_succeeded: brushupSucceeded,
      brushup_failed: brushupFailed,
    });
  } catch (e) {
    console.error("[eval-customer-reaction]", e);
    await finishCronLog(runLogId, false, undefined, e instanceof Error ? e.message : String(e));
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}

// GET: Vercel CronはGETでリクエストするため、認証チェック後POSTへ委譲
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return POST(req);
}
