import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

const SKIP_STATUSES = new Set(["applying", "screening", "contract", "closed_won"]);

export async function POST(req: NextRequest) {
  const body = await req.json() as { conversation_id?: string };
  const convId = body.conversation_id;
  if (!convId) return NextResponse.json({ ok: false }, { status: 400 });

  after(async () => {
    try {
      const db = getDb();

      const { data: conv } = await db
        .from("conversations")
        .select("status, property_customer_id, ai_draft, last_sender")
        .eq("id", convId)
        .single();

      // Skip conditions
      if (!conv) return;
      if (conv.last_sender !== "customer") return;
      if (conv.ai_draft) return; // already generated
      if (SKIP_STATUSES.has(conv.status as string)) return;

      const [{ data: msgs }, { data: pc }] = await Promise.all([
        db.from("messages").select("sender, text").eq("conversation_id", convId)
          .order("created_at", { ascending: false }).limit(20),
        conv.property_customer_id
          ? db.from("property_customers")
            .select("customer_name, desired_area, floor_plan, rent_min, rent_max, ai_summary, preferences, ng_points")
            .eq("id", conv.property_customer_id).single()
          : Promise.resolve({ data: null }),
      ]);

      const recentMsgs = ((msgs || []) as Array<{ sender: string; text: string }>).reverse();

      // Build target message: unread customer messages (up to 3) after last staff reply
      const lastStaffIdx = recentMsgs.map((m, i) => m.sender === "staff" ? i : -1).filter((i) => i >= 0).at(-1);
      const msgsAfterStaff = lastStaffIdx !== undefined ? recentMsgs.slice(lastStaffIdx + 1) : recentMsgs;
      const unreplied = msgsAfterStaff
        .filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]")
        .slice(-3);
      const targetMessage = unreplied.map((m) => m.text).join("\n");

      if (!targetMessage.trim()) return;

      type PC = { customer_name?: string; desired_area?: string; floor_plan?: string; rent_min?: number; rent_max?: number; ai_summary?: string; preferences?: string; ng_points?: string } | null;
      const pcData = pc as PC;
      const customerConditions = [
        pcData?.desired_area && `エリア: ${pcData.desired_area}`,
        pcData?.floor_plan && `間取り: ${pcData.floor_plan}`,
        (pcData?.rent_min || pcData?.rent_max) && `家賃: ${pcData?.rent_min ? Math.floor(pcData.rent_min / 10000) + "万〜" : ""}${pcData?.rent_max ? Math.floor(pcData.rent_max / 10000) + "万" : ""}`,
        pcData?.preferences && `こだわり: ${pcData.preferences}`,
        pcData?.ng_points && `NG: ${pcData.ng_points}`,
      ].filter(Boolean).join(", ");

      const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
        ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

      const draftRes = await fetch(`${baseUrl}/api/generate-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: targetMessage,
          state: conv.status,
          customerName: pcData?.customer_name || "",
          recentMessages: recentMsgs,
          customerConditions,
          customerSummary: pcData?.ai_summary || "",
        }),
      });

      if (!draftRes.ok || !draftRes.body) return;

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
            try { const meta = JSON.parse(buffer.slice(0, nl)) as { ok: boolean }; if (!meta.ok) return; } catch { return; }
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
      }
    } catch {}
  });

  return NextResponse.json({ ok: true });
}
