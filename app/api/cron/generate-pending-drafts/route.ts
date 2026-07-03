import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

const SKIP_STATUSES = new Set(["applying", "screening", "contract", "closed_won"]);

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

// Cooldown: 同じ会話が毎分再処理されるのを防ぐ（インメモリ・毎分Cronでインスタンスが温存される前提のベストエフォート）
const COOLDOWN_MS = 5 * 60 * 1000; // 5分
const recentAttempts = new Map<string, number>(); // convId -> 最終処理試行時刻(ms)

function pruneRecentAttempts() {
  const cutoff = Date.now() - COOLDOWN_MS;
  for (const [id, ts] of recentAttempts) {
    if (ts < cutoff) recentAttempts.delete(id);
  }
}

// 60秒デバウンス経過済みの会話に対してまとめ下書き生成（毎分Cronから呼ばれる）
export async function GET() {
  const db = getDb();
  const threshold = new Date(Date.now() - 60 * 1000).toISOString();
  // 10分以上前のpendingは対象外（処理失敗した会話が毎分再処理され続けるのを防ぐ上限）
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // ① 60秒以上前〜10分以内にpendingになった会話（デバウンス経過・古すぎるものは除外）
  const { data: pendingConvs, error } = await db
    .from("conversations")
    .select("id, status, property_customer_id, last_sender")
    .not("draft_pending_at", "is", null)
    .lte("draft_pending_at", threshold)
    .gte("draft_pending_at", tenMinutesAgo)
    .limit(3);

  // ② 取りこぼし救済: pending_atなし（または10分以上前の古いpending）・下書きなし・24時間以内・未返信
  const { data: orphanedConvs, error: orphanedError } = await db
    .from("conversations")
    .select("id, status, property_customer_id, last_sender")
    .eq("last_sender", "customer")
    .is("ai_draft", null)
    .or("draft_pending_at.is.null,draft_pending_at.lt." + tenMinutesAgo)
    .gte("updated_at", yesterday)
    .neq("status", "applying")
    .neq("status", "screening")
    .neq("status", "contract")
    .neq("status", "closed_won")
    .neq("status", "closed_lost")
    .limit(2);

  if (orphanedError) {
    console.error("[generate-pending-drafts] orphaned query error:", orphanedError);
  }
  console.log("[generate-pending-drafts] pending:", pendingConvs?.length ?? 0, "orphaned:", orphanedConvs?.length ?? 0, "yesterday:", yesterday);

  // 重複除外してまとめる ＋ Cooldown: 直近5分以内に処理試行済みの会話はスキップ
  pruneRecentAttempts();
  const cooldownCutoff = Date.now() - COOLDOWN_MS;
  const pendingIds = new Set((pendingConvs || []).map(c => c.id as string));
  const combined = [
    ...(pendingConvs || []),
    ...(orphanedConvs || []).filter(c => !pendingIds.has(c.id as string)),
  ].filter(c => {
    const last = recentAttempts.get(c.id as string);
    return last === undefined || last < cooldownCutoff;
  });

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  console.log("[generate-pending-drafts] processing:", combined.length, "conversations at", new Date().toISOString());

  if (combined.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, debug: { pending: pendingConvs?.length ?? 0, orphaned: orphanedConvs?.length ?? 0, orphanedError: orphanedError?.message ?? null, yesterday } });
  }

  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
    ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");

  let processed = 0;
  let skipped = 0;

  let isFirst = true;
  for (const conv of combined) {
    const convId = conv.id as string;
    const convStatus = conv.status as string;
    const pcId = conv.property_customer_id as string | null;

    // 処理間に小スリープを入れてAPI負荷を分散（直列処理）
    if (!isFirst) await new Promise(r => setTimeout(r, 1000));
    isFirst = false;

    // Cooldown記録（成否に関わらず試行時刻を記録し、5分間は再処理しない）
    recentAttempts.set(convId, Date.now());

    // 先にpendingをクリアして重複処理を防ぐ
    await db.from("conversations")
      .update({ draft_pending_at: null })
      .eq("id", convId);

    if (SKIP_STATUSES.has(convStatus) || conv.last_sender !== "customer") {
      skipped++;
      continue;
    }

    try {
      const [{ data: msgs }, { data: pc }] = await Promise.all([
        db.from("messages").select("sender, text").eq("conversation_id", convId)
          .order("created_at", { ascending: false }).limit(20),
        pcId
          ? db.from("property_customers")
            .select("customer_name, desired_area, floor_plan, rent_min, rent_max, ai_summary, preferences, ng_points, walk_minutes, move_in_time, building_age, other_requests, additional_conditions")
            .eq("id", pcId).single()
          : Promise.resolve({ data: null }),
      ]);

      const recentMsgs = ((msgs || []) as Array<{ sender: string; text: string }>).reverse();

      // スタッフの最後のメッセージ以降の未読を全てまとめる（最大5通）
      const lastStaffIdx = recentMsgs.map((m, i) => m.sender === "staff" ? i : -1).filter(i => i >= 0).at(-1);
      const msgsAfterStaff = lastStaffIdx !== undefined ? recentMsgs.slice(lastStaffIdx + 1) : recentMsgs;
      const unreplied = msgsAfterStaff
        .filter(m => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]")
        .slice(-5);

      const targetMessage = unreplied.map(m => m.text).join("\n");
      if (!targetMessage.trim()) { skipped++; continue; }

      type PC = { customer_name?: string; desired_area?: string; floor_plan?: string; rent_min?: number; rent_max?: number; ai_summary?: string; preferences?: string; ng_points?: string; walk_minutes?: number; move_in_time?: string; building_age?: number; other_requests?: string; additional_conditions?: string } | null;
      const pcData = pc as PC;

      const hasStaffMsg = recentMsgs.some(m => m.sender === "staff");
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
          recentMessages: recentMsgs.map(m => ({ sender: m.sender, text: m.text || "" })),
          customerConditions,
          customerSummary: pcData?.ai_summary || "",
        }),
      });

      if (!draftRes.ok || !draftRes.body) continue;

      const reader = draftRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "", metaDone = false, fullText = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!metaDone) {
          buffer += chunk;
          const nl = buffer.indexOf("\n");
          if (nl >= 0) {
            try { const meta = JSON.parse(buffer.slice(0, nl)) as { ok: boolean }; if (!meta.ok) break; } catch { break; }
            metaDone = true;
            fullText = buffer.slice(nl + 1);
          }
        } else {
          fullText += chunk;
        }
      }

      const finalDraft = fullText.trim();
      if (finalDraft) {
        await db.from("conversations").update({ ai_draft: finalDraft }).eq("id", convId);
        processed++;
      }
    } catch (e) {
      console.error("[generate-pending-drafts] convId:", convId, e);
    }
  }

  return NextResponse.json({ ok: true, processed, skipped });
}
