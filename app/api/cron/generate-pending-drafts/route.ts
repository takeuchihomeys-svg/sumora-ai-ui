import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
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

// 60秒デバウンス経過済みの会話に対してまとめ下書き生成（毎分Cronから呼ばれる）
export async function GET() {
  const db = getDb();
  const threshold = new Date(Date.now() - 60 * 1000).toISOString();

  // 60秒以上前にpendingになった会話を最大10件取得
  const { data: pendingConvs, error } = await db
    .from("conversations")
    .select("id, status, property_customer_id, last_sender")
    .not("draft_pending_at", "is", null)
    .lte("draft_pending_at", threshold)
    .limit(10);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!pendingConvs || pendingConvs.length === 0) {
    return NextResponse.json({ ok: true, processed: 0 });
  }

  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
    ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

  let processed = 0;
  let skipped = 0;

  for (const conv of pendingConvs) {
    const convId = conv.id as string;
    const convStatus = conv.status as string;
    const pcId = conv.property_customer_id as string | null;

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
            .select("customer_name, desired_area, floor_plan, rent_min, rent_max, ai_summary, preferences, ng_points")
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

      type PC = { customer_name?: string; desired_area?: string; floor_plan?: string; rent_min?: number; rent_max?: number; ai_summary?: string; preferences?: string; ng_points?: string } | null;
      const pcData = pc as PC;

      const hasStaffMsg = recentMsgs.some(m => m.sender === "staff");
      const normalizedStatus = STATUS_ALIAS[convStatus] ?? convStatus;
      const effectiveState = !hasStaffMsg && normalizedStatus === "hearing" ? "first_reply" : convStatus;

      const customerConditions = [
        pcData?.desired_area && `エリア: ${pcData.desired_area}`,
        pcData?.floor_plan && `間取り: ${pcData.floor_plan}`,
        (pcData?.rent_min || pcData?.rent_max) && `家賃: ${pcData?.rent_min ? Math.floor(pcData.rent_min / 10000) + "万〜" : ""}${pcData?.rent_max ? Math.floor(pcData.rent_max / 10000) + "万" : ""}`,
        pcData?.preferences && `こだわり: ${pcData.preferences}`,
        pcData?.ng_points && `NG: ${pcData.ng_points}`,
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
