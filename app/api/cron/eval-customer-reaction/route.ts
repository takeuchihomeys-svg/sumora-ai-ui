import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

export const maxDuration = 60;

// POST /api/cron/eval-customer-reaction（毎日 JST 20:30）
// 顧客反応ベースの文評価（軽量版）:
// AIX 送信後24時間以内に顧客が返信したかを messages テーブルで確認し、
// aix_usage_logs.customer_reacted (boolean) を UPDATE する。
//
// 対象: 送信から24時間以上経過し、まだ未評価（customer_reacted IS NULL）のログ。
// 取りこぼし救済のため過去7日まで遡る（実行失敗日があってもバックフィルされる）。
const BATCH_LIMIT = 200;
const CONCURRENCY = 10;

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
    const until24hAgo = new Date(now - 24 * 3600 * 1000).toISOString();

    // 送信から24h以上経過した未評価ログ（sent_at は NULL がありうるため created_at で範囲抽出）
    const { data: usageLogs, error: usageErr } = await supabase
      .from("aix_usage_logs")
      .select("id, conversation_id, aix_type, sent_at, created_at")
      .is("customer_reacted", null)
      .gte("created_at", since7d)
      .lte("created_at", until24hAgo)
      .order("created_at", { ascending: true })
      .limit(BATCH_LIMIT);

    if (usageErr) {
      await finishCronLog(runLogId, false, undefined, usageErr.message);
      return NextResponse.json({ ok: false, error: usageErr.message }, { status: 500 });
    }

    const logs = (usageLogs ?? []) as Array<{
      id: string;
      conversation_id: string;
      aix_type: string | null;
      sent_at: string | null;
      created_at: string;
    }>;

    if (logs.length === 0) {
      await finishCronLog(runLogId, true, { evaluated: 0 });
      return NextResponse.json({ ok: true, evaluated: 0 });
    }

    const reactedIds: string[] = [];
    const notReactedIds: string[] = [];

    // 送信後24h以内に顧客返信があったかを確認（CONCURRENCY件ずつ並列）
    for (let i = 0; i < logs.length; i += CONCURRENCY) {
      const chunk = logs.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async (log) => {
        const sendTime = log.sent_at ?? log.created_at;
        const windowEnd = new Date(new Date(sendTime).getTime() + 24 * 3600 * 1000).toISOString();
        try {
          const { count, error } = await supabase
            .from("messages")
            .select("id", { count: "exact", head: true })
            .eq("conversation_id", log.conversation_id)
            .eq("sender", "customer")
            .gt("created_at", sendTime)
            .lte("created_at", windowEnd);
          if (error) return; // 失敗分は NULL のまま残し次回リトライ
          if ((count ?? 0) > 0) reactedIds.push(log.id);
          else notReactedIds.push(log.id);
        } catch { /* 次回リトライ */ }
      }));
    }

    // まとめて UPDATE（true / false の2クエリ）
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

    // ── 低反応 aix_type のナレッジを decay（学習ループへの接続） ──
    // 今回のバッチで not_reacted 率>=50% かつ件数>=2 の aix_type を特定し、
    // その conversation_state に対応する ai_reply_knowledge の importance を下げる
    let decaySucceeded = 0;
    let decayFailed = 0;
    try {
      const notReactedSet = new Set(notReactedIds);
      const reactedSet = new Set(reactedIds);
      const notReactedByType = new Map<string, number>();
      const totalByType = new Map<string, number>(); // reacted + not_reacted の合計
      for (const log of logs) {
        if (!log.aix_type) continue;
        // 今回判定できたもの（reactedまたはnot_reacted）のみカウント
        if (reactedSet.has(log.id) || notReactedSet.has(log.id)) {
          totalByType.set(log.aix_type, (totalByType.get(log.aix_type) ?? 0) + 1);
        }
        if (!notReactedSet.has(log.id)) continue;
        notReactedByType.set(log.aix_type, (notReactedByType.get(log.aix_type) ?? 0) + 1);
      }
      for (const [aix_type, count] of notReactedByType.entries()) {
        const total = totalByType.get(aix_type) ?? count;
        const notReactedRate = count / total;
        // 件数>=2 かつ 非反応率>=50% の両条件でdecay（バッチの偶然の偏りを防ぐ）
        if (count < 2 || notReactedRate < 0.5) continue;
        const { data: staleIds } = await supabase
          .from("ai_reply_knowledge")
          .select("id")
          .eq("conversation_state", aix_type)
          .neq("hypothesis_status", "rejected")
          .lt("importance", 7) // 高重要度は保護
          .limit(30);
        const ids = (staleIds ?? []).map(r => r.id as string).filter(Boolean);
        if (ids.length === 0) {
          // knowledge_apply_log の aix_type と conversation_state のマッピング不一致を検知
          console.warn(`[eval-customer-reaction] decay skip: aix_type="${aix_type}" に conversation_state一致のknowledgeが見つかりません（マッピング不一致の可能性 / not_reacted=${count}/${total}件）`);
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

    await finishCronLog(runLogId, true, {
      evaluated,
      reacted: reactedIds.length,
      not_reacted: notReactedIds.length,
      reaction_rate: reactionRate,
      decay_succeeded: decaySucceeded,
      decay_failed: decayFailed,
    });
    return NextResponse.json({
      ok: true,
      evaluated,
      reacted: reactedIds.length,
      not_reacted: notReactedIds.length,
      reaction_rate: reactionRate,
      decay_succeeded: decaySucceeded,
      decay_failed: decayFailed,
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
