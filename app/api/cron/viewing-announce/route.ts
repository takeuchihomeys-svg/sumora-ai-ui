import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 60;

// JSTの現在時刻を分で返す (例: 10:30 → 630)
function getJSTMinutes(): { todayJST: string; nowMinutes: number } {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const todayJST = jst.toISOString().slice(0, 10);
  const nowMinutes = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  return { todayJST, nowMinutes };
}

// グループID/tokenをループ外で1回だけ解決（N+1解消）
async function resolveLineConfig(): Promise<{ targetId: string; token: string } | null> {
  let targetId = process.env.LINE_STAFF_GROUP_ID ?? null;
  if (!targetId) {
    const { data } = await supabase
      .from("hanbancyo_settings").select("value").eq("key", "group_id").maybeSingle();
    targetId = (data?.value as string) ?? null;
  }
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN
    ?? process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN;
  if (!targetId || !token) return null;
  return { targetId, token };
}

// 成否を boolean で返す（送信失敗時はフラグを立てない設計に対応）
async function sendGroupMessage(cfg: { targetId: string; token: string }, text: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ to: cfg.targetId, messages: [{ type: "text", text }] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error("[viewing-announce] LINE push failed:", res.status, await res.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (err) {
    console.error("[viewing-announce] LINE push error:", err);
    return false;
  }
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { todayJST, nowMinutes } = getJSTMinutes();

  // 今日の内覧を取得
  const { data: viewings, error } = await supabase
    .from("viewings")
    .select("id, customer_name, viewing_time, pre_announce_sent, post_announce_sent")
    .eq("viewing_date", todayJST)
    .eq("status", "scheduled")
    .limit(50);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!viewings || viewings.length === 0) return NextResponse.json({ ok: true, announced: 0 });

  // LINE設定をループ外で1回解決
  const cfg = await resolveLineConfig();
  if (!cfg) {
    console.warn("[viewing-announce] LINE group_id or token not configured — skipping");
    return NextResponse.json({ ok: false, error: "LINE config missing" }, { status: 500 });
  }

  let announced = 0;

  for (const v of viewings) {
    try {
      const customerName = (v.customer_name as string) || "お客様";
      const timeStr = (v.viewing_time as string) || "";

      // 内覧時刻を分で取得
      let viewingMinutes: number | null = null;
      if (timeStr) {
        const parts = timeStr.split(":");
        if (parts.length >= 2) {
          const h = parseInt(parts[0], 10);
          const m = parseInt(parts[1], 10);
          if (Number.isFinite(h) && Number.isFinite(m)) viewingMinutes = h * 60 + m;
        }
      }

      // ── 内覧前アナウンス ──
      if (!v.pre_announce_sent) {
        let shouldPre = false;

        if (viewingMinutes !== null) {
          const oneHourBefore = viewingMinutes - 60;
          if (nowMinutes >= oneHourBefore && nowMinutes < viewingMinutes) shouldPre = true;
          if (nowMinutes >= 9 * 60 && nowMinutes < 9 * 60 + 30 && nowMinutes < viewingMinutes) shouldPre = true;
        } else {
          if (nowMinutes >= 9 * 60 && nowMinutes < 9 * 60 + 30) shouldPre = true;
        }

        if (shouldPre) {
          const timeLabel = timeStr ? ` ${timeStr}〜` : "";
          const text = `📅【内覧前アナウンス】\n今日${customerName}さん${timeLabel}内覧！！\n内覧前挨拶を送ってあげて！！`;
          // B01: CAS更新（pre_announce_sent=false 条件付き）で先にフラグを立ててから送信
          // → 複数インスタンス同時実行時の二重送信を防ぐ（負けた側は 0行更新でスキップ）
          const { data: casData, error: upErr } = await supabase
            .from("viewings")
            .update({ pre_announce_sent: true })
            .eq("id", v.id as string)
            .eq("pre_announce_sent", false)
            .select("id");
          if (upErr) { console.error("[viewing-announce] pre_announce_sent CAS error:", upErr.message); }
          else if (casData && casData.length > 0) {
            // 更新できた = 今回のインスタンスが送信権を獲得
            const sent = await sendGroupMessage(cfg, text);
            if (sent) announced++;
            else {
              // LINE送信失敗時はフラグを戻して次回再試行できるようにする
              await supabase.from("viewings").update({ pre_announce_sent: false }).eq("id", v.id as string);
            }
          }
          // casData.length === 0 の場合は別インスタンスが送信済み → スキップ
        }
      }

      // ── 内覧後アナウンス ──
      if (!v.post_announce_sent) {
        let shouldPost = false;

        if (viewingMinutes !== null) {
          if (nowMinutes >= viewingMinutes + 30) shouldPost = true;
        } else {
          if (nowMinutes >= 18 * 60 && nowMinutes < 18 * 60 + 30) shouldPost = true;
        }

        if (shouldPost) {
          const text = `🏠【内覧後アナウンス】\n${customerName}さん内覧終わり！！\nAIX→挨拶（内覧後）で挨拶送って！！😊`;
          // B01: CAS更新で先にフラグを立ててから送信（pre と同じパターン）
          const { data: casData, error: upErr } = await supabase
            .from("viewings")
            .update({ post_announce_sent: true })
            .eq("id", v.id as string)
            .eq("post_announce_sent", false)
            .select("id");
          if (upErr) { console.error("[viewing-announce] post_announce_sent CAS error:", upErr.message); }
          else if (casData && casData.length > 0) {
            const sent = await sendGroupMessage(cfg, text);
            if (sent) announced++;
            else {
              await supabase.from("viewings").update({ post_announce_sent: false }).eq("id", v.id as string);
            }
          }
        }
      }
    } catch (err) {
      // 1件の失敗で残りの内覧処理を止めない
      console.error("[viewing-announce] viewing処理エラー:", v.id, err);
    }
  }

  return NextResponse.json({ ok: true, announced });
}
