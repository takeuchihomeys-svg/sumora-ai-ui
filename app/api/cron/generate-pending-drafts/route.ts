import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { detectPlaceholders } from "@/app/lib/validate-reply";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

export const maxDuration = 300;

const PER_CONV_TIMEOUT_MS = 120_000; // generate-reply Step1(45s)+Step2(45s)+余裕=120s
const TIME_BUDGET_MS = 240_000; // maxDuration300sの80%を処理に使う

const SKIP_STATUSES = new Set(["applying", "application", "screening", "contract", "closed_won", "closed_lost"]);

const STATUS_ALIAS: Record<string, string> = {
  first_reply:             "hearing",
  condition_hearing:       "hearing",
  property_search:         "hearing",
  property_recommendation: "proposing",
  viewing:                 "proposing",
  estimate_request:        "proposing",
  availability_check:      "proposing",
  application:             "applying",
  screening:               "applying",
  contract:                "applying",
};

// メッセージ基準の重複防止（旧: 時刻固定5分cooldownは廃止）
// 「どのメッセージ（draft_pending_at / orphanedはupdated_at）まで生成試行済みか」を会話ごとに記録し、
// 記録済みマーカー以下ならスキップ、新しい顧客メッセージが来てマーカーが進めば即座に再生成対象にする。
// インメモリ・ベストエフォート（インスタンス再起動でリセットされるが、①はdraft_pending_atクリア・②はai_draft有無がDB側の防波堤）。
const MARKER_RETENTION_MS = 24 * 60 * 60 * 1000; // 記録の保持期限（メモリ肥大防止のみが目的）
const attemptedMarkers = new Map<string, { markerMs: number; recordedAt: number }>(); // convId -> 生成試行済みメッセージマーカー

// 孤立サロゲート（LINE絵文字等）をU+FFFDに置換してAnthropicへのHTTP 400を防止
function sanitizeSurrogates(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

function pruneAttemptedMarkers() {
  const cutoff = Date.now() - MARKER_RETENTION_MS;
  for (const [id, rec] of attemptedMarkers) {
    if (rec.recordedAt < cutoff) attemptedMarkers.delete(id);
  }
}

// 会話の「最新顧客メッセージ」を表すマーカー（ms）。pendingはdraft_pending_at、orphanedはupdated_atで代用
function markerOf(c: { draft_pending_at?: string | null; updated_at?: string | null }): number {
  const iso = c.draft_pending_at ?? c.updated_at;
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? Date.now() : ms;
}

// 60秒デバウンス経過済みの会話に対してまとめ下書き生成（毎分Cronから呼ばれる）
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return run();
}

async function run() {
  const runLogId = await startCronLog("generate-pending-drafts").catch(() => null);
  const db = getDb();
  const threshold = new Date(Date.now() - 60 * 1000).toISOString();
  // 10分以上前のpendingは対象外（処理失敗した会話が毎分再処理され続けるのを防ぐ上限）
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // ① 60秒以上前〜10分以内にpendingになった会話（デバウンス経過・古すぎるものは除外）
  const { data: pendingConvs, error } = await db
    .from("conversations")
    .select("id, status, property_customer_id, last_sender, draft_pending_at, updated_at, draft_fail_count")
    .not("draft_pending_at", "is", null)
    .lte("draft_pending_at", threshold)
    .gte("draft_pending_at", tenMinutesAgo)
    .limit(5); // 3→5: 同時多数メッセージ時の処理件数を増やす

  // ② 取りこぼし救済: pending_atなし（または10分以上前の古いpending）・下書きなし・24時間以内・未返信
  const { data: orphanedConvs, error: orphanedError } = await db
    .from("conversations")
    .select("id, status, property_customer_id, last_sender, draft_pending_at, updated_at, draft_fail_count")
    .eq("last_sender", "customer")
    // __TRUNCATED__センチネル（尻切れで保存見送りになった会話）も救済対象に含める
    .or("ai_draft.is.null,ai_draft.eq.__TRUNCATED__")
    .or("draft_pending_at.is.null,draft_pending_at.lt." + tenMinutesAgo)
    // DB側リトライ制御: 10分以内に生成試行済み（draft_attempted_at）ならスキップ
    // （インメモリMapはVercelサーバーレスでインスタンス間共有されないため、DBフラグが本命の防波堤）
    .or("draft_attempted_at.is.null,draft_attempted_at.lt." + tenMinutesAgo)
    .gte("updated_at", sevenDaysAgo)
    .neq("status", "applying")
    .neq("status", "application")
    .neq("status", "screening")
    .neq("status", "contract")
    .neq("status", "closed_won")
    .neq("status", "closed_lost")
    // 5回以上失敗した会話は諦める（draft_fail_countがnullの行=未失敗も対象に含める）
    .or("draft_fail_count.is.null,draft_fail_count.lt.5")
    .limit(3); // 2→3: orphaned救済の件数を増やす

  if (orphanedError) {
    console.error("[generate-pending-drafts] orphaned query error:", orphanedError);
  }
  console.log("[generate-pending-drafts] pending:", pendingConvs?.length ?? 0, "orphaned:", orphanedConvs?.length ?? 0, "sevenDaysAgo:", sevenDaysAgo);

  // 重複除外してまとめる ＋ メッセージ基準スキップ: 最新の顧客メッセージ（マーカー）に対して生成試行済みならスキップ。
  // 記録より新しいマーカー（＝生成後に届いた新メッセージ）なら経過時間に関係なく即座に処理対象になる。
  pruneAttemptedMarkers();
  const pendingIds = new Set((pendingConvs || []).map(c => c.id as string));
  const combined = [
    ...(pendingConvs || []).map(c => ({ ...c, __source: "pending" as const })),
    ...(orphanedConvs || [])
      .filter(c => !pendingIds.has(c.id as string))
      .map(c => ({ ...c, __source: "orphaned" as const })),
  ].filter(c => {
    const rec = attemptedMarkers.get(c.id as string);
    return rec === undefined || markerOf(c) > rec.markerMs;
  });

  if (error) {
    // pendingクエリ失敗でも、取得済みのorphaned救済分は処理を続行する
    // （従来は500即returnで、フェッチ済みorphaned行がこの実行で一切処理されず破棄されていた）
    console.error("[generate-pending-drafts] pending query error:", error);
    if (orphanedError || combined.length === 0) {
      if (runLogId) await finishCronLog(runLogId, false, undefined, error.message).catch(() => null);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
  }

  console.log("[generate-pending-drafts] processing:", combined.length, "conversations at", new Date().toISOString());

  if (combined.length === 0) {
    // M-4: 早期returnでも finishCronLog を必ず呼ぶ（「開始したのに終了なし」の宙ぶらりんログ防止）
    if (runLogId) await finishCronLog(runLogId, true, { processed: 0 }).catch(() => null);
    return NextResponse.json({ ok: true, processed: 0, debug: { pending: pendingConvs?.length ?? 0, orphaned: orphanedConvs?.length ?? 0, orphanedError: orphanedError?.message ?? null, sevenDaysAgo } });
  }

  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  const batchStart = Date.now();
  let isFirst = true;
  for (const conv of combined) {
    // 残り時間が少ない場合は残りを次回Cronに委ねる
    if (Date.now() - batchStart > TIME_BUDGET_MS) {
      console.warn("[generate-pending-drafts] time budget exceeded, deferring rest");
      break;
    }

    const convId = conv.id as string;
    const convStatus = conv.status as string;
    const pcId = conv.property_customer_id as string | null;

    // 処理間に小スリープを入れてAPI負荷を分散（直列処理）
    if (!isFirst) await new Promise(r => setTimeout(r, 1000));
    isFirst = false;

    // SKIPチェック: DB書き込み（claim）前に確認してクレーム無駄打ちを防ぐ（修正③）
    if (SKIP_STATUSES.has(convStatus) || conv.last_sender !== "customer") {
      skipped++;
      continue;
    }

    // 先にpendingをクリアして重複処理を防ぐ ＋ 生成試行時刻をDBに記録
    // （失敗しても draft_attempted_at から10分間はorphanedクエリの再試行対象外になる）
    // MEDIUM-4: 楽観的ロック — 複数インスタンスが同一会話を同時にクレームしても1つしか成功しない
    // ①pending  → draft_pending_at がまだセットされている行のみ更新
    // ②orphaned → draft_pending_at は NULL のため .not(pending,is,null) では絶対に成立しない。
    //             draft_attempted_at（未試行 or 10分以上前）をロック条件に使う
    const claimBase = db.from("conversations")
      .update({ draft_pending_at: null, draft_attempted_at: new Date().toISOString() })
      .eq("id", convId);
    const { data: claimed, error: markErr } = await (conv.__source === "orphaned"
      ? claimBase.or("draft_attempted_at.is.null,draft_attempted_at.lt." + tenMinutesAgo)
      : claimBase.not("draft_pending_at", "is", null)
    ).select("id");
    if (markErr) {
      // マーク失敗のまま生成すると毎分再処理＋二重生成になるためスキップ
      console.error("[generate-pending-drafts] mark update failed:", convId, markErr.message);
      skipped++;
      continue;
    }
    if (!claimed?.length) {
      // 別インスタンスが先にクレーム済み → スキップ
      skipped++;
      continue;
    }

    // クレーム成功後のみマーカーを記録（クレーム前に記録するとウォームインスタンスでorphanedが24時間ブロックされる）
    attemptedMarkers.set(convId, { markerMs: markerOf(conv), recordedAt: Date.now() });

    try {
      const [{ data: msgs }, { data: pc }] = await Promise.all([
        db.from("messages").select("sender, text, image_url, created_at, is_aix_generated").eq("conversation_id", convId)
          .order("created_at", { ascending: false }).limit(20),
        pcId
          ? db.from("property_customers")
            .select("customer_name, desired_area, floor_plan, rent_min, rent_max, ai_summary, preferences, ng_points, walk_minutes, move_in_time, building_age, other_requests, additional_conditions")
            .eq("id", pcId).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);

      type Msg = { sender: string; text: string | null; image_url: string | null; created_at: string; is_aix_generated: boolean | null };
      // 画像のみメッセージ（image_urlあり・textなし）は "[画像]" プレースホルダとして文脈に残す
      const recentMsgs = ((msgs || []) as Msg[]).reverse().map(m => ({
        ...m,
        text: sanitizeSurrogates(m.text || (m.image_url ? "[画像]" : "")),
      }));

      // スタッフの最後のメッセージ以降の未読を全てまとめる（最大5通）
      const lastStaffIdx = recentMsgs.map((m, i) => m.sender === "staff" ? i : -1).filter(i => i >= 0).at(-1);
      const msgsAfterStaff = lastStaffIdx !== undefined ? recentMsgs.slice(lastStaffIdx + 1) : recentMsgs;
      const unreplied = msgsAfterStaff
        .filter(m => m.sender === "customer" && m.text)
        .slice(-5);

      const targetMessage = sanitizeSurrogates(unreplied.map(m => m.text).join("\n"));
      // 未読が画像/動画プレースホルダのみなら生成スキップ（文脈自体はrecentMessagesで保持される）
      const hasRealText = unreplied.some(m => m.text !== "[画像]" && m.text !== "[動画]");
      if (!targetMessage.trim()) { skipped++; continue; }
      if (!hasRealText) {
        // 画像/動画のみ：返信生成不可のため sentinel を書き込んで orphaned の無限10分ループを止める
        await db.from("conversations")
          .update({ ai_draft: "[画像のみ]", draft_attempted_at: null })
          .eq("id", convId)
          .is("ai_draft", null);
        skipped++;
        continue;
      }

      type PC = { customer_name?: string; desired_area?: string; floor_plan?: string; rent_min?: number; rent_max?: number; ai_summary?: string; preferences?: string; ng_points?: string; walk_minutes?: number; move_in_time?: string; building_age?: number; other_requests?: string; additional_conditions?: string } | null;
      const pcData = pc as PC;

      let hasStaffMsg = recentMsgs.some(m => m.sender === "staff");
      // 直近20件にスタッフ返信が見つからない場合は全履歴を確認（長い会話でfirst_reply誤判定を防ぐ）
      if (!hasStaffMsg) {
        const { data: staffCheck } = await db.from("messages")
          .select("id").eq("conversation_id", convId).eq("sender", "staff")
          .limit(1).maybeSingle();
        if (staffCheck) hasStaffMsg = true;
      }
      const normalizedStatus = STATUS_ALIAS[convStatus] ?? convStatus;
      const effectiveState = !hasStaffMsg && normalizedStatus === "hearing" ? "first_reply" : normalizedStatus;

      const customerConditions = [
        pcData?.desired_area && `エリア: ${pcData.desired_area}`,
        pcData?.floor_plan && `間取り: ${pcData.floor_plan}`,
        (pcData?.rent_min || pcData?.rent_max) && `家賃: ${pcData?.rent_min ? Math.floor(pcData.rent_min / 10000) + "万〜" : ""}${pcData?.rent_max ? Math.floor(pcData.rent_max / 10000) + "万" : ""}`,
        pcData?.preferences && `こだわり: ${pcData.preferences}`,
        pcData?.ng_points && `NG: ${pcData.ng_points}`,
        pcData?.walk_minutes && `駅徒歩: ${pcData.walk_minutes}分以内`,
        pcData?.move_in_time && `入居時期: ${pcData.move_in_time}`,
        pcData?.building_age && `築年数: ${pcData.building_age}年以内`,
        pcData?.other_requests && `その他希望: ${pcData.other_requests}`,
        pcData?.additional_conditions && `追加条件: ${pcData.additional_conditions}`,
      ].filter(Boolean).join(", ");

      const draftRes = await fetch(`${baseUrl}/api/generate-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: targetMessage,
          state: effectiveState,
          customerName: pcData?.customer_name || "",
          recentMessages: recentMsgs.map(m => ({ sender: m.sender, text: m.text || "", imageUrl: m.image_url ?? undefined, createdAt: m.created_at, isAix: m.is_aix_generated ?? false })),
          customerConditions,
          customerSummary: pcData?.ai_summary || "",
          // RLHF断絶修正: conversationId を渡して generate-reply 側の logKnowledgeApply を発火させる
          // （knowledge_apply_log に記録され、text_retention / deal_outcome フィードバックの対象になる）
          // ※ generate-reply 側も成功時に ai_draft を保存するが、同一クリーンテキストの冪等な上書きなので二重化の実害なし。
          //    max_tokens 時は generate-reply は保存スキップ → 本cronが後から __TRUNCATED__ センチネルを書くため整合する。
          conversationId: convId,
          // 本文末尾に <<<STOP_REASON:xxx>>> トレーラーを付けてもらう（尻切れドラフトの品質ゲート用）
          includeStopReason: true,
        }),
        signal: AbortSignal.timeout(PER_CONV_TIMEOUT_MS),
      });

      if (!draftRes.ok || !draftRes.body) {
        const errBody = await draftRes.text().catch(() => "(body読み取り失敗)");
        console.error("[generate-pending-drafts] generate-reply HTTPエラー:", convId, "status:", draftRes.status, "body:", errBody.slice(0, 200));
        await db.from("conversations").update({
          draft_fail_count: (conv.draft_fail_count ?? 0) + 1,
          draft_last_error: `HTTP ${draftRes.status}: ${errBody.slice(0, 500)}`,
        }).eq("id", convId);
        failed++;
        continue;
      }

      const reader = draftRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "", metaDone = false, fullText = "", metaFailed = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!metaDone) {
          buffer += chunk;
          const nl = buffer.indexOf("\n");
          if (nl >= 0) {
            const metaLine = buffer.slice(0, nl);
            let metaOk = false;
            try { metaOk = (JSON.parse(metaLine) as { ok: boolean }).ok === true; } catch { /* パース失敗 → metaOk=false */ }
            if (!metaOk) {
              console.error("[generate-pending-drafts] generate-reply メタ行NG（ok:false or JSONパース失敗）:", convId, "meta:", metaLine.slice(0, 200));
              metaFailed = true;
              break;
            }
            metaDone = true;
            fullText = buffer.slice(nl + 1);
          }
        } else {
          fullText += chunk;
        }
      }
      // マルチバイト文字がチャンク境界で分断された場合の残りをフラッシュ（日本語末尾文字の欠け防止）
      fullText += decoder.decode();

      if (metaFailed || !metaDone) {
        if (!metaFailed) console.error("[generate-pending-drafts] ストリームがメタ行なしで終了:", convId, "buffer:", buffer.slice(0, 200));
        await db.from("conversations").update({
          draft_fail_count: (conv.draft_fail_count ?? 0) + 1,
          draft_last_error: metaFailed ? "generate-reply meta line NG (ok:false or parse error)" : "stream ended without meta line",
        }).eq("id", convId);
        failed++;
        continue;
      }

      // 内部タグ（<<<STOP_REASON:xxx>>> / <<<SUGGESTED_AIX:{...}>>>）を抽出して本文から除去
      // ⚠️ 末尾アンカー（$）での抽出は禁止 — SUGGESTED_AIX が STOP_REASON の後に付くケースがあり、
      //    $ アンカーだとマッチ失敗してタグ入りのまま ai_draft に保存される（顧客に内部指示が届く事故の原因）
      let finalDraft = fullText.trim();
      let stopReason = "";
      const trailerMatch = finalDraft.match(/<<<STOP_REASON:([\w-]*)>>>/);
      if (trailerMatch) {
        stopReason = trailerMatch[1];
      }
      finalDraft = finalDraft
        .replace(/\n?<<<STOP_REASON:[\w-]*>>>/g, "")
        .replace(/\n?<<<SUGGESTED_AIX:[\s\S]*?>>>/g, "")
        .trim();

      // 品質ゲート①: max_tokens 尻切れドラフトは保存しない
      // MEDIUM-3: センチネル値 "__TRUNCATED__" を保存して尻切れドラフトの誤送信を防ぐ
      // __TRUNCATED__ はorphaned救済の再試行対象になったため、attempted_at はクリアせず残す
      // （null にすると orphaned クエリを毎分すり抜けて無限リトライになる。10分バックオフで再試行）
      // 新しい顧客メッセージが来れば draft_pending_at が再セットされ①経由で即再生成される
      if (stopReason === "max_tokens") {
        console.warn("[generate-pending-drafts] draft truncated (stop_reason=max_tokens), saving sentinel:", convId);
        await db.from("conversations")
          .update({
            ai_draft: "__TRUNCATED__",
            draft_fail_count: (conv.draft_fail_count ?? 0) + 1,
            draft_last_error: "stop_reason=max_tokens: draft truncated",
          })
          .eq("id", convId);
        failed++;
        continue;
      }

      if (finalDraft) {
        // 品質ゲート②: プレースホルダ（[日付] [物件名] 等）残存は警告ログのみ（保存はする）
        const leftover = detectPlaceholders(finalDraft);
        if (leftover.length > 0) {
          console.warn("[generate-pending-drafts] placeholder remains in draft:", convId, leftover.join(" "));
        }
        // 成功時: 下書き保存 ＋ attempted_at クリア + fail_count リセット（API障害回復後にorphaned救済が再度拾えるようにする）
        // .is("ai_draft", null) ガード: bg-async が先に保存した下書きを上書きしない
        await db.from("conversations").update({ ai_draft: finalDraft, draft_attempted_at: null, draft_fail_count: 0 }).eq("id", convId).is("ai_draft", null);
        processed++;
      } else {
        // タグ除去後に本文が空 → 生成失敗として記録（attempted_at は残し10分バックオフで再試行させる）
        console.error("[generate-pending-drafts] 生成結果が空（タグ除去後）:", convId, "raw:", fullText.slice(0, 200));
        await db.from("conversations").update({
          draft_fail_count: (conv.draft_fail_count ?? 0) + 1,
          draft_last_error: `empty draft after tag removal. raw: ${fullText.slice(0, 500)}`,
        }).eq("id", convId);
        failed++;
      }
    } catch (e) {
      // fetchタイムアウト（AbortSignal 45秒）・ネットワーク断・DB例外もここに落ちる
      console.error("[generate-pending-drafts] convId:", convId, e);
      const errMsg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      try {
        // draft_attempted_at は上書きしない（クレーム時のタイムスタンプを維持 → 10分バックオフ有効）
        // null にリセットすると1分毎に連打リトライして draft_fail_count を無駄に消費する
        await db.from("conversations").update({
          draft_fail_count: (conv.draft_fail_count ?? 0) + 1,
          draft_last_error: errMsg,
        }).eq("id", convId);
      } catch { /* DB更新失敗は無視 */ }
      failed++;
    }
  }

  // M-4: 正常終了時も finishCronLog を必ず呼ぶ（従来はエラー時のみ記録され、成功実行が「終了なし」で残っていた）
  if (runLogId) await finishCronLog(runLogId, true, { processed, skipped, failed }).catch(() => null);
  return NextResponse.json({ ok: true, processed, skipped, failed });
}
