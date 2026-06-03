import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import crypto from "crypto";

const SECRET = process.env.LINE_HANBANCYO_CHANNEL_SECRET ?? "";

function verifySignature(body: string, signature: string): boolean {
  if (!SECRET) return true;
  const hash = crypto.createHmac("sha256", SECRET).update(body).digest("base64");
  return hash === signature;
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get("x-line-signature") ?? "";
  if (!verifySignature(rawBody, sig)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const body = JSON.parse(rawBody) as { events: Array<{
    type: string;
    source: { type: string; groupId?: string; userId?: string };
    message?: { type: string; text?: string };
    replyToken?: string;
  }> };

  for (const event of body.events ?? []) {
    // グループIDを取得・保存
    if (event.source.type === "group" && event.source.groupId) {
      const groupId = event.source.groupId;
      await supabase.from("hanbancyo_settings").upsert(
        { key: "group_id", value: groupId },
        { onConflict: "key" }
      );
    }

    // タスク完了コマンド: 「完了 [顧客名]」
    if (
      event.type === "message" &&
      event.message?.type === "text" &&
      event.message.text?.startsWith("完了")
    ) {
      const name = event.message.text.replace(/^完了\s*/, "").trim();
      if (name) {
        const { data } = await supabase
          .from("property_customers")
          .select("id")
          .ilike("customer_name", `%${name}%`)
          .limit(1)
          .single();
        if (data?.id) {
          await supabase
            .from("property_customers")
            .update({ last_property_sent_at: new Date().toISOString() })
            .eq("id", data.id);
        }
      }
    }
  }

  return NextResponse.json({ ok: true });
}
