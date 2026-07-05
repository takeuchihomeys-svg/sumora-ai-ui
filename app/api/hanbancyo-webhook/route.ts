import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import crypto from "crypto";

const SECRET = process.env.LINE_HANBANCYO_CHANNEL_SECRET ?? "";
const TOKEN = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ?? "";

function verifySignature(body: string, signature: string): boolean {
  if (!SECRET) return true;
  const hash = crypto.createHmac("sha256", SECRET).update(body).digest("base64");
  return hash === signature;
}

async function replyToLine(replyToken: string, text: string) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  });
}

async function getRemainingCount(): Promise<number> {
  const { data } = await supabase
    .from("property_customers")
    .select("status, last_property_sent_at")
    .in("status", ["new_inquiry", "hot", "property_search"]);
  if (!data) return 0;

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  return data.filter((c) => {
    if (c.status === "new_inquiry") return true;
    if (c.status === "hot") {
      return !c.last_property_sent_at || new Date(c.last_property_sent_at) < todayStart;
    }
    if (c.status === "property_search") {
      if (!c.last_property_sent_at) return true;
      return (now.getTime() - new Date(c.last_property_sent_at).getTime()) / 86400000 >= 3;
    }
    return false;
  }).length;
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get("x-line-signature") ?? "";
  if (!verifySignature(rawBody, sig)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let body: {
    events: Array<{
      type: string;
      source: { type: string; groupId?: string; userId?: string };
      message?: { type: string; text?: string };
      replyToken?: string;
    }>;
  };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  for (const event of body.events ?? []) {
    // グループIDを取得・保存
    if (event.source.type === "group" && event.source.groupId) {
      await supabase
        .from("hanbancyo_settings")
        .upsert({ key: "group_id", value: event.source.groupId }, { onConflict: "key" });
    }

    if (event.type !== "message" || event.message?.type !== "text") continue;
    const text = event.message.text ?? "";
    const replyToken = event.replyToken ?? "";

    // 完了コマンド: 「完了 [顧客名]」
    if (text.startsWith("完了")) {
      const name = text.replace(/^完了\s*/, "").trim();
      if (!name) continue;

      const { data } = await supabase
        .from("property_customers")
        .select("id, customer_name")
        .ilike("customer_name", `%${name}%`)
        .limit(1)
        .maybeSingle();

      if (data?.id) {
        await supabase
          .from("property_customers")
          .update({ last_property_sent_at: new Date().toISOString() })
          .eq("id", data.id);

        const remaining = await getRemainingCount();
        const msg =
          remaining > 0
            ? `✅ ${data.customer_name}様 完了！\n残り ${remaining}名`
            : `✅ ${data.customer_name}様 完了！\n🎉 全員完了！お疲れ様でした！`;
        if (replyToken) await replyToLine(replyToken, msg);
      } else if (replyToken) {
        await replyToLine(replyToken, `⚠️「${name}」に一致する顧客が見つかりませんでした`);
      }
    }

    // 格上げコマンド: 「格上げ [顧客名]」
    if (text.startsWith("格上げ")) {
      const name = text.replace(/^格上げ\s*/, "").trim();
      if (!name) continue;

      const { data } = await supabase
        .from("property_customers")
        .select("id, customer_name")
        .ilike("customer_name", `%${name}%`)
        .limit(1)
        .maybeSingle();

      if (data?.id) {
        await supabase
          .from("property_customers")
          .update({ status: "hot", updated_at: new Date().toISOString() })
          .eq("id", data.id);

        if (replyToken) {
          await replyToLine(
            replyToken,
            `🔥 ${data.customer_name}様をhotに格上げ！\n毎日物件出し対象になりました`,
          );
        }
      } else if (replyToken) {
        await replyToLine(replyToken, `⚠️「${name}」に一致する顧客が見つかりませんでした`);
      }
    }
  }

  return NextResponse.json({ ok: true });
}
