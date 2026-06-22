import { NextRequest, NextResponse } from "next/server";
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

export async function POST(req: NextRequest) {
  const body = await req.json() as { conversation_id?: string; memo?: string };
  const convId = body.conversation_id;
  const memo = body.memo || "";
  if (!convId) return NextResponse.json({ ok: false }, { status: 400 });

  try {
    const db = getDb();

    const { data: conv } = await db
      .from("conversations")
      .select("status, property_customer_id, ai_draft, last_sender")
      .eq("id", convId)
      .single();

    if (!conv) return NextResponse.json({ ok: false, skipped: true });
    if (conv.last_sender !== "customer") return NextResponse.json({ ok: true, skipped: true });
    if (conv.ai_draft) return NextResponse.json({ ok: true, skipped: true, draft: conv.ai_draft as string });
    if (SKIP_STATUSES.has(conv.status as string)) return NextResponse.json({ ok: true, skipped: true });

    const [{ data: msgs }, { data: pc }] = await Promise.all([
      db.from("messages").select("sender, text, created_at").eq("conversation_id", convId)
        .order("created_at", { ascending: false }).limit(20),
      conv.property_customer_id
        ? db.from("property_customers")
          .select("customer_name, desired_area, floor_plan, rent_min, rent_max, ai_summary, preferences, ng_points")
          .eq("id", conv.property_customer_id).single()
        : Promise.resolve({ data: null }),
    ]);

    const recentMsgs = ((msgs || []) as Array<{ sender: string; text: string; created_at?: string }>)
      .reverse()
      .map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at }));

    // first_reply変換：スタッフ返信ゼロ + hearing → 初回挨拶文
    const hasStaffMsg = recentMsgs.some((m) => m.sender === "staff");
    const normalizedStatus = STATUS_ALIAS[conv.status as string] ?? conv.status;
    const effectiveState = !hasStaffMsg && normalizedStatus === "hearing" ? "first_reply" : (conv.status as string);

    const lastStaffIdx = recentMsgs.map((m, i) => m.sender === "staff" ? i : -1).filter((i) => i >= 0).at(-1);
    const msgsAfterStaff = lastStaffIdx !== undefined ? recentMsgs.slice(lastStaffIdx + 1) : recentMsgs;
    const unreplied = msgsAfterStaff
      .filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]")
      .slice(-3);
    const targetMessage = unreplied.map((m) => m.text).join("\n");

    if (!targetMessage.trim()) return NextResponse.json({ ok: true, skipped: true });

    type PC = { customer_name?: string; desired_area?: string; floor_plan?: string; rent_min?: number; rent_max?: number; ai_summary?: string; preferences?: string; ng_points?: string } | null;
    const pcData = pc as PC;
    const dbConditions = [
      pcData?.desired_area && `エリア: ${pcData.desired_area}`,
      pcData?.floor_plan && `間取り: ${pcData.floor_plan}`,
      (pcData?.rent_min || pcData?.rent_max) && `家賃: ${pcData?.rent_min ? Math.floor(pcData.rent_min / 10000) + "万〜" : ""}${pcData?.rent_max ? Math.floor(pcData.rent_max / 10000) + "万" : ""}`,
      pcData?.preferences && `こだわり: ${pcData.preferences}`,
      pcData?.ng_points && `NG: ${pcData.ng_points}`,
    ].filter(Boolean).join(", ");
    const customerConditions = dbConditions || memo;

    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
      ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");

    const draftRes = await fetch(`${baseUrl}/api/generate-reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: targetMessage,
        state: effectiveState,
        customerName: pcData?.customer_name || "",
        recentMessages: recentMsgs,
        customerConditions,
        customerSummary: pcData?.ai_summary || "",
      }),
    });

    if (!draftRes.ok || !draftRes.body) {
      return NextResponse.json({ ok: false, error: "generation failed" });
    }

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
          try { const meta = JSON.parse(buffer.slice(0, nl)) as { ok: boolean }; if (!meta.ok) return NextResponse.json({ ok: false }); } catch { return NextResponse.json({ ok: false }); }
          metaDone = true;
          fullText = buffer.slice(nl + 1);
        }
      } else {
        fullText += chunk;
      }
    }

    const finalDraft = fullText.trim();
    if (!finalDraft) return NextResponse.json({ ok: false });

    // DBに保存（Realtimeで他デバイスにも反映）
    await db.from("conversations").update({ ai_draft: finalDraft }).eq("id", convId);

    return NextResponse.json({ ok: true, draft: finalDraft });
  } catch (e) {
    console.error("generate-draft-bg error:", e);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
