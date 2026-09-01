import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import crypto from "crypto";

export const maxDuration = 30;

const SECRET = process.env.LINE_HANBANCYO_CHANNEL_SECRET ?? "";
const TOKEN = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ?? "";

function verifySignature(body: string, signature: string): boolean {
  if (!SECRET) return false;
  const hash = crypto.createHmac("sha256", SECRET).update(body).digest("base64");
  return hash === signature;
}

async function replyToLine(replyToken: string, text: string) {
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error("[hanbancyo-webhook] LINE reply failed:", res.status, await res.text());
    }
  } catch (e) {
    console.error("[hanbancyo-webhook] LINE reply error:", e);
  }
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
      source?: { type?: string; groupId?: string; userId?: string };
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
    const sourceType = event.source?.type;
    const sourceGroupId = event.source?.groupId;

    if (sourceType === "group" && sourceGroupId) {
      // 既存のgroup_idと異なる場合はpickup_group_idとして保存（新グループ自動検出）
      const { data: existingRow } = await supabase
        .from("hanbancyo_settings")
        .select("value")
        .eq("key", "group_id")
        .maybeSingle();
      const existingGroupId = existingRow?.value as string | null;
      if (existingGroupId && existingGroupId !== sourceGroupId) {
        // 既存のgroup_idと異なる新グループ → pickup_group_idとして登録
        const { error: pickupErr } = await supabase
          .from("hanbancyo_settings")
          .upsert({ key: "pickup_group_id", value: sourceGroupId }, { onConflict: "key" });
        if (pickupErr) {
          console.error("[hanbancyo-webhook] pickup_group_id upsert失敗:", pickupErr.message);
        } else {
          console.log("[hanbancyo-webhook] pickup_group_id を自動登録:", sourceGroupId);
        }
      } else {
        const { error: upsertErr } = await supabase
          .from("hanbancyo_settings")
          .upsert({ key: "group_id", value: sourceGroupId }, { onConflict: "key" });
        if (upsertErr) {
          console.error("[hanbancyo-webhook] hanbancyo_settings upsert失敗:", upsertErr.message);
        }
      }
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
