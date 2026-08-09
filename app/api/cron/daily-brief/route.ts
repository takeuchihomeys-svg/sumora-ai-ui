import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 60;

// ── Helpers ───────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  first_reply:             "初回返信",
  condition_hearing:       "条件ヒアリング",
  hearing:                 "ヒアリング中",
  property_search:         "物件探し",
  property_recommendation: "物件提案中",
  proposing:               "物件提案中",
  viewing:                 "内見調整",
  estimate_request:        "見積依頼",
  availability_check:      "空室確認",
  application:             "申込中",
  applying:                "申込中",
  screening:               "審査中",
  contract:                "契約中",
};

function elapsedLabel(d?: string | null): string {
  if (!d) return "不明";
  const ms = Date.now() - new Date(d).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "不明";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${Math.max(mins, 1)}分前`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}

function msgPreview(msg: string | null, max = 22): string {
  if (!msg) return "";
  const s = msg.replace(/\s+/g, " ").trim();
  if (!s) return "";
  return `「${s.slice(0, max)}${s.length > max ? "…" : ""}」`;
}

// ── 鈴木 祥平 LINE User ID 解決（DBキャッシュ → Group Members API） ──────
const SUZUKI_NAME = "鈴木 祥平";
const SUZUKI_CACHE_KEY = "suzuki_line_user_id";

async function resolveSuzukiUserId(groupId: string, token: string): Promise<string | null> {
  // 1. DBキャッシュ確認
  const { data: cached } = await supabase
    .from("hanbancyo_settings")
    .select("value")
    .eq("key", SUZUKI_CACHE_KEY)
    .maybeSingle();
  if (cached?.value) return cached.value as string;

  // 2. LINE Group Members IDs API でメンバー一覧取得
  const idsRes = await fetch(`https://api.line.me/v2/bot/group/${groupId}/members/ids`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!idsRes.ok) return null;
  const { memberIds } = (await idsRes.json()) as { memberIds: string[] };

  // 3. 各メンバーのプロフィールを確認して「鈴木 祥平」を探す
  for (const uid of memberIds) {
    const profileRes = await fetch(
      `https://api.line.me/v2/bot/group/${groupId}/member/${uid}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) }
    );
    if (!profileRes.ok) continue;
    const profile = (await profileRes.json()) as { displayName?: string; userId?: string };
    if (profile.displayName === SUZUKI_NAME && profile.userId) {
      // 4. DBにキャッシュして次回以降は即座に返す
      await supabase
        .from("hanbancyo_settings")
        .upsert({ key: SUZUKI_CACHE_KEY, value: profile.userId }, { onConflict: "key" });
      return profile.userId;
    }
  }
  return null;
}

// ── Route handler ─────────────────────────────────────────────────────

const COOLDOWN_KEY = "daily_brief_last_sent_at";

export async function GET(req: NextRequest) {
  // Auth
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // Cooldown guard — prevent Vercel retry double-sends (23h window)
  const { data: lastSentRow } = await supabase
    .from("hanbancyo_settings")
    .select("value")
    .eq("key", COOLDOWN_KEY)
    .maybeSingle();

  if (lastSentRow?.value) {
    const elapsed = Date.now() - new Date(lastSentRow.value as string).getTime();
    if (elapsed < 23 * 60 * 60 * 1000) {
      return NextResponse.json({ ok: true, skipped: true, reason: "cooldown (23h)" });
    }
  }

  // LINE config
  let groupId: string | null =
    process.env.LINE_STAFF_GROUP_ID ?? process.env.LINE_GROUP_ID ?? null;
  if (!groupId) {
    const { data } = await supabase
      .from("hanbancyo_settings")
      .select("value")
      .eq("key", "group_id")
      .maybeSingle();
    groupId = (data?.value as string) ?? null;
  }

  const token =
    process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ??
    process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN ??
    process.env.LINE_CHANNEL_ACCESS_TOKEN ??
    null;

  if (!groupId || !token) {
    return NextResponse.json({ ok: false, error: "LINE config missing" }, { status: 500 });
  }

  // 鈴木 祥平の LINE User ID を取得（DB キャッシュ → なければ Group Members API で検索）
  const suzukiUserId = await resolveSuzukiUserId(groupId, token);

  // ── Parallel DB queries ─────────────────────────────────────────────
  const sixHoursAgo  = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const CLOSED = "(closed_won,closed_lost,lost)";

  const [
    { data: yotaiou },
    { data: noreply },
    { data: hot },
  ] = await Promise.all([
    // A: 要対応 — flagged + customer spoke last
    supabase
      .from("conversations")
      .select("id, customer_name, status, last_message, updated_at")
      .eq("is_flagged", true)
      .eq("last_sender", "customer")
      .eq("line_status", "active")
      .not("status", "in", CLOSED)
      .order("updated_at", { ascending: true })
      .limit(8),

    // B: 返信できていない — not flagged, customer waiting 6h+
    supabase
      .from("conversations")
      .select("id, customer_name, status, last_message, updated_at")
      .eq("last_sender", "customer")
      .eq("is_flagged", false)
      .eq("line_status", "active")
      .not("status", "in", CLOSED)
      .lt("updated_at", sixHoursAgo)
      .order("updated_at", { ascending: true })
      .limit(8),

    // C: 熱い — is_hot, active in last 7 days
    supabase
      .from("conversations")
      .select("id, customer_name, status, last_sender, updated_at")
      .eq("is_hot", true)
      .eq("line_status", "active")
      .not("status", "in", CLOSED)
      .gt("updated_at", sevenDaysAgo)
      .order("updated_at", { ascending: false })
      .limit(6),
  ]);

  // ── Build message sections ──────────────────────────────────────────
  type ConvRow = {
    id: string;
    customer_name: string | null;
    status: string | null;
    last_message?: string | null;
    last_sender?: string | null;
    updated_at: string | null;
  };

  const sections: string[] = [];

  // A section — 要対応
  if (yotaiou && yotaiou.length > 0) {
    const lines = (yotaiou as ConvRow[]).map((c, i) => {
      const time    = elapsedLabel(c.updated_at);
      const preview = msgPreview(c.last_message ?? null);
      return `${i + 1}. ${c.customer_name || "名称未設定"} ｜ ${time}${preview ? `\n   ${preview}` : ""}`;
    });
    sections.push(
      `━━ 🚨 要対応（${yotaiou.length}人）━━\nお客さんが返信待ちです。\n\n${lines.join("\n\n")}`
    );
  }

  // B section — 返信できていない
  if (noreply && noreply.length > 0) {
    const lines = (noreply as ConvRow[]).map((c, i) => {
      const time    = elapsedLabel(c.updated_at);
      const preview = msgPreview(c.last_message ?? null);
      return `${i + 1}. ${c.customer_name || "名称未設定"} ｜ ${time}${preview ? `\n   ${preview}` : ""}`;
    });
    sections.push(
      `━━ ⏰ 返信できていない（${noreply.length}人）━━\nflagなし・でも返事待ちです。\n\n${lines.join("\n\n")}`
    );
  }

  // C section — 熱い客
  if (hot && hot.length > 0) {
    const lines = (hot as ConvRow[]).map((c, i) => {
      const statusLabel = STATUS_LABELS[c.status ?? ""] ?? (c.status ?? "");
      const time        = elapsedLabel(c.updated_at);
      const replyMark   = c.last_sender === "customer" ? " ⚡返信待ち" : "";
      return `${i + 1}. ${c.customer_name || "名称未設定"} ｜ ${time} → ${statusLabel}${replyMark}`;
    });
    sections.push(
      `━━ 🔥 今日の熱い客（${hot.length}人）━━\nアポ・申込を狙いにいきましょう！\n\n${lines.join("\n")}`
    );
  }

  // Skip if nothing to report
  if (sections.length === 0) {
    return NextResponse.json({ ok: true, skipped: true, reason: "no customers to report" });
  }

  // ── Build full message text ─────────────────────────────────────────
  const totalUrgent = (yotaiou?.length ?? 0) + (noreply?.length ?? 0);

  // @mention: ﻿ は LINE メンションのアンカー文字（position 0）
  // "@鈴木 祥平" = 6文字。スパン（﻿ + @鈴木 祥平）= 7文字
  const mentionPrefix = "﻿@鈴木 祥平";

  const fullText = [
    `${mentionPrefix} おはようございます☀️`,
    "",
    `今日の対応リストです（要対応${yotaiou?.length ?? 0}人・返信待ち${noreply?.length ?? 0}人）`,
    "",
    sections.join("\n\n"),
    "",
    "──────────────────",
    "🎯 今日の目標",
    "　内覧アポ 3件 ／ 申込 1件",
    "",
    totalUrgent > 0
      ? `上${totalUrgent}人、今日中に潰していきましょう💪`
      : "今日もやっていきましょう💪",
  ].join("\n");

  // ── LINE push with optional @mention ───────────────────────────────
  type MentionMessage =
    | { type: "text"; text: string }
    | {
        type: "text";
        text: string;
        mentionees: { index: number; length: number; type: "user"; userId: string }[];
      };

  const message: MentionMessage = suzukiUserId
    ? {
        type: "text",
        text: fullText,
        mentionees: [
          {
            index: 0,   // ﻿ position
            length: 7,  // ﻿ (1) + @鈴木 祥平 (6) = 7 chars
            type: "user",
            userId: suzukiUserId,
          },
        ],
      }
    : { type: "text", text: fullText };

  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ to: groupId, messages: [message] }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error("[daily-brief] LINE push failed:", res.status, body);
      return NextResponse.json({ ok: false, error: body }, { status: 500 });
    }
  } catch (e) {
    console.error("[daily-brief] LINE push error:", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }

  // 送信時刻を記録（クールダウンガード用）
  await supabase
    .from("hanbancyo_settings")
    .upsert({ key: COOLDOWN_KEY, value: new Date().toISOString() }, { onConflict: "key" });

  return NextResponse.json({
    ok: true,
    sent: true,
    yotaiou:  yotaiou?.length  ?? 0,
    noreply:  noreply?.length  ?? 0,
    hot:      hot?.length      ?? 0,
  });
}
