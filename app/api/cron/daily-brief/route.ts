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

// ── 人間味ある声かけ（曜日ローテーション）────────────────────────────

// JST曜日: 0=日 1=月 2=火 3=水 4=木 5=金 6=土
function getJSTDayOfWeek(): number {
  const utcMs = Date.now();
  const jstMs = utcMs + 9 * 60 * 60 * 1000;
  return new Date(jstMs).getDay();
}

const MORNING_OPENERS = [
  "日曜日もお願いします🙏 休みの日でも動いてくれてるお客さんいます。よろしくお願いします！",
  "今週も始まりましたね！月曜の朝から一気にいきましょう。要対応から潰していきましょう🔥",
  "火曜日です。昨日の勢いそのまま続けていきましょう！",
  "週の折り返し、水曜日です。今日もしっかりいきましょう💪",
  "木曜日です。週末まであと少し。今日も全力でいきましょう！",
  "金曜日です！週末前に全部片付けていきましょう🔥 ここが踏ん張りどころです。",
  "土曜日もよろしくお願いします！お客さんは休日こそ動いてます。",
];

const MORNING_CLOSERS = [
  "今日も鈴木さんに頼ってます。よろしくお願いします🙏",
  "上から順番に一気にいきましょう！",
  "要対応から潰してったら、あとは熱い客を攻める流れでいきましょう🔥",
  "返信が早いほどアポに繋がります。今日もよろしく！",
  "一緒に頑張っていきましょう💪 鈴木さんならできます！",
  "お客さんが待ってます。今日もよろしくお願いします！",
  "着実にこなしていきましょう。いつも頑張ってくれてありがとうございます🙏",
];

const EVENING_OPENERS = [
  "日曜日もここまでお疲れ様でした。ラストスパートだけお願いします🔥",
  "月曜日の締め、お疲れ様です！残りの対応だけやりきって終わりにしましょう。",
  "火曜日のラストスパートです！あと少しだけ一緒に頑張りましょう💪",
  "水曜日の夕方です。週の折り返し、今日中に全部返しておきましょう！",
  "木曜日のラストです。明日の自分を楽にするために、今日やりきりましょう🙏",
  "金曜夕方！週末前にここをきれいにして気持ちよく終わりましょう🔥",
  "土曜日もここまでありがとうございます。残りのお客さんだけもうひと踏ん張り！",
];

const EVENING_CLOSERS = [
  "今日は本当によく頑張ってくれました。残りだけお願いします🙏",
  "ここを返したら今日は終わりにしていいです。あと少しだけ！",
  "夕方の時間帯、お客さんも返事しやすいです。今がチャンスです！",
  "今日頑張った分、明日の自分が楽になります。いきましょう💪",
  "残り対応を全部返したら、今日はゆっくり休んでください🙏",
  "鈴木さんの対応でお客さんが助かってます。もうひと踏ん張りよろしく🔥",
  "今日も1日本当にお疲れ様でした。最後だけよろしくお願いします！",
];

function pickByDay<T>(arr: T[]): T {
  return arr[getJSTDayOfWeek() % arr.length];
}

// ── 鈴木 祥平 LINE User ID 解決（DBキャッシュ → Group Members API） ──────

const SUZUKI_NAME = "鈴木 祥平";
const SUZUKI_CACHE_KEY = "suzuki_line_user_id";

async function resolveSuzukiUserId(groupId: string, token: string): Promise<string | null> {
  const { data: cached } = await supabase
    .from("hanbancyo_settings")
    .select("value")
    .eq("key", SUZUKI_CACHE_KEY)
    .maybeSingle();
  if (cached?.value) return cached.value as string;

  const idsRes = await fetch(`https://api.line.me/v2/bot/group/${groupId}/members/ids`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!idsRes.ok) return null;
  const { memberIds } = (await idsRes.json()) as { memberIds: string[] };

  for (const uid of memberIds) {
    const profileRes = await fetch(
      `https://api.line.me/v2/bot/group/${groupId}/member/${uid}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) }
    );
    if (!profileRes.ok) continue;
    const profile = (await profileRes.json()) as { displayName?: string; userId?: string };
    if (profile.displayName === SUZUKI_NAME && profile.userId) {
      await supabase
        .from("hanbancyo_settings")
        .upsert({ key: SUZUKI_CACHE_KEY, value: profile.userId }, { onConflict: "key" });
      return profile.userId;
    }
  }
  return null;
}

// ── LINE push ─────────────────────────────────────────────────────────

async function pushLineMessage(
  groupId: string,
  token: string,
  text: string,
  suzukiUserId: string | null
): Promise<{ ok: boolean; error?: string }> {
  type MentionMessage =
    | { type: "text"; text: string }
    | { type: "text"; text: string; mentionees: { index: number; length: number; type: "user"; userId: string }[] };

  const message: MentionMessage = suzukiUserId
    ? { type: "text", text, mentionees: [{ index: 0, length: 7, type: "user", userId: suzukiUserId }] }
    : { type: "text", text };

  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: groupId, messages: [message] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: body };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Route handler ─────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const mode = req.nextUrl.searchParams.get("mode") ?? "morning";
  const isEvening = mode === "evening";
  const COOLDOWN_KEY = isEvening ? "daily_brief_evening_last_sent_at" : "daily_brief_morning_last_sent_at";
  const COOLDOWN_HOURS = 6; // 朝・夜それぞれ6h以内の再送信を防ぐ

  const { data: lastSentRow } = await supabase
    .from("hanbancyo_settings")
    .select("value")
    .eq("key", COOLDOWN_KEY)
    .maybeSingle();

  if (lastSentRow?.value) {
    const elapsed = Date.now() - new Date(lastSentRow.value as string).getTime();
    if (elapsed < COOLDOWN_HOURS * 60 * 60 * 1000) {
      return NextResponse.json({ ok: true, skipped: true, reason: `cooldown (${COOLDOWN_HOURS}h)` });
    }
  }

  // LINE config
  let groupId: string | null = process.env.LINE_STAFF_GROUP_ID ?? process.env.LINE_GROUP_ID ?? null;
  if (!groupId) {
    const { data } = await supabase
      .from("hanbancyo_settings").select("value").eq("key", "group_id").maybeSingle();
    groupId = (data?.value as string) ?? null;
  }

  const token =
    process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ??
    process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN ??
    process.env.LINE_CHANNEL_ACCESS_TOKEN ?? null;

  if (!groupId || !token) {
    return NextResponse.json({ ok: false, error: "LINE config missing" }, { status: 500 });
  }

  const suzukiUserId = await resolveSuzukiUserId(groupId, token);

  // ── DB queries ───────────────────────────────────────────────────────
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo       = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000).toISOString();
  const CLOSED = "(closed_won,closed_lost,lost)";

  const [{ data: yotaiou }, { data: noreply }, { data: hot }] = await Promise.all([
    // 🚨 要対応: flagあり・お客さん返信待ち
    supabase.from("conversations")
      .select("id, customer_name, status, last_message, updated_at")
      .eq("is_flagged", true).eq("last_sender", "customer").eq("line_status", "active")
      .not("status", "in", CLOSED).order("updated_at", { ascending: true }).limit(8),

    // ⚡ 24h以内にやり取りあり・返信できていないお客さん（flagなし）
    supabase.from("conversations")
      .select("id, customer_name, status, last_message, updated_at")
      .eq("last_sender", "customer").eq("is_flagged", false).eq("line_status", "active")
      .not("status", "in", CLOSED).gt("updated_at", twentyFourHoursAgo)
      .order("updated_at", { ascending: true }).limit(10),

    // 🔥 熱い客: is_hot=true・7日以内アクティブ
    supabase.from("conversations")
      .select("id, customer_name, status, last_sender, updated_at")
      .eq("is_hot", true).eq("line_status", "active")
      .not("status", "in", CLOSED).gt("updated_at", sevenDaysAgo)
      .order("updated_at", { ascending: false }).limit(6),
  ]);

  type ConvRow = {
    id: string; customer_name: string | null; status: string | null;
    last_message?: string | null; last_sender?: string | null; updated_at: string | null;
  };

  // ── 朝メッセージ ─────────────────────────────────────────────────────
  if (!isEvening) {
    const sections: string[] = [];

    if (yotaiou && yotaiou.length > 0) {
      const lines = (yotaiou as ConvRow[]).map((c, i) => {
        const time = elapsedLabel(c.updated_at);
        const statusLabel = STATUS_LABELS[c.status ?? ""] ?? (c.status ?? "");
        const preview = msgPreview(c.last_message ?? null);
        return `${i + 1}. ${c.customer_name || "名称未設定"} ｜ ${statusLabel} ｜ ${time}\n   ${preview || "（メッセージ確認して今すぐ返信！）"}`;
      });
      sections.push(`━━ 🚨 最優先・今すぐ返信（${yotaiou.length}人）━━\n返信が来てます。今すぐ対応してください🔥\n\n${lines.join("\n\n")}`);
    }

    if (noreply && noreply.length > 0) {
      const lines = (noreply as ConvRow[]).map((c, i) => {
        const time = elapsedLabel(c.updated_at);
        const statusLabel = STATUS_LABELS[c.status ?? ""] ?? (c.status ?? "");
        const preview = msgPreview(c.last_message ?? null);
        return `${i + 1}. ${c.customer_name || "名称未設定"} ｜ ${statusLabel} ｜ ${time}\n   ${preview || "（内容確認して返信！）"}`;
      });
      sections.push(`━━ ⚡ 24h以内やり取り・返信待ち（${noreply.length}人）━━\n昨日〜今日やり取りしてるお客さん。まだ返せていません！\n\n${lines.join("\n\n")}`);
    }

    if (hot && hot.length > 0) {
      const lines = (hot as ConvRow[]).map((c, i) => {
        const statusLabel = STATUS_LABELS[c.status ?? ""] ?? (c.status ?? "");
        const time = elapsedLabel(c.updated_at);
        const replyMark = c.last_sender === "customer" ? " ⚡返信待ち" : "";
        const action = ["viewing", "estimate_request", "availability_check"].includes(c.status ?? "")
          ? " → 内覧アポ詰める！"
          : ["application", "applying"].includes(c.status ?? "")
          ? " → 申込クロージング！"
          : " → 物件提案・次アクション！";
        return `${i + 1}. ${c.customer_name || "名称未設定"} ｜ ${statusLabel} ｜ ${time}${replyMark}${action}`;
      });
      sections.push(`━━ 🔥 熱い客・今日中に詰める（${hot.length}人）━━\nここで内覧アポ・申込につなげていきましょう！\n\n${lines.join("\n")}`);
    }

    if (sections.length === 0) {
      return NextResponse.json({ ok: true, skipped: true, reason: "no customers to report" });
    }

    const totalUrgent = (yotaiou?.length ?? 0) + (noreply?.length ?? 0);
    const mentionPrefix = "﻿@鈴木 祥平";

    const fullText = [
      `${mentionPrefix} ${pickByDay(MORNING_OPENERS)}`,
      "",
      `📋 本日の対応リスト（要対応${yotaiou?.length ?? 0}人・24h返信待ち${noreply?.length ?? 0}人・熱い客${hot?.length ?? 0}人）`,
      "",
      sections.join("\n\n"),
      "",
      "──────────────────",
      "🎯 今日の目標",
      "　内覧アポ 3件 ／ 申込 1件",
      "　上から順番に詰めていきましょう🔥",
      "",
      totalUrgent > 0
        ? `${pickByDay(MORNING_CLOSERS)}`
        : "今日もよろしくお願いします！",
    ].join("\n");

    const result = await pushLineMessage(groupId, token, fullText, suzukiUserId);
    if (!result.ok) {
      console.error("[daily-brief morning] LINE push failed:", result.error);
      return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
    }

    await supabase.from("hanbancyo_settings")
      .upsert({ key: COOLDOWN_KEY, value: new Date().toISOString() }, { onConflict: "key" });

    return NextResponse.json({ ok: true, sent: true, mode: "morning",
      yotaiou: yotaiou?.length ?? 0, noreply: noreply?.length ?? 0, hot: hot?.length ?? 0 });
  }

  // ── 夕方メッセージ（ラストスパート）────────────────────────────────
  const sections: string[] = [];

  if (yotaiou && yotaiou.length > 0) {
    const lines = (yotaiou as ConvRow[]).map((c, i) => {
      const time = elapsedLabel(c.updated_at);
      const statusLabel = STATUS_LABELS[c.status ?? ""] ?? (c.status ?? "");
      const preview = msgPreview(c.last_message ?? null);
      return `${i + 1}. ${c.customer_name || "名称未設定"} ｜ ${statusLabel} ｜ ${time}${preview ? ` ${preview}` : ""}`;
    });
    sections.push(`🚨 最優先・今すぐ返信（${yotaiou.length}人）\n今日中に必ず返してください！\n${lines.join("\n")}`);
  }

  if (noreply && noreply.length > 0) {
    const lines = (noreply as ConvRow[]).map((c, i) => {
      const time = elapsedLabel(c.updated_at);
      const statusLabel = STATUS_LABELS[c.status ?? ""] ?? (c.status ?? "");
      const preview = msgPreview(c.last_message ?? null);
      return `${i + 1}. ${c.customer_name || "名称未設定"} ｜ ${statusLabel} ｜ ${time}${preview ? ` ${preview}` : ""}`;
    });
    sections.push(`⚡ 24h以内やり取り・返信待ち（${noreply.length}人）\n今日中にここだけ返してください！\n${lines.join("\n")}`);
  }

  if (hot && hot.length > 0) {
    const lines = (hot as ConvRow[]).map((c, i) => {
      const statusLabel = STATUS_LABELS[c.status ?? ""] ?? (c.status ?? "");
      const replyMark = c.last_sender === "customer" ? " ⚡返信待ち" : "";
      const action = ["viewing", "estimate_request", "availability_check"].includes(c.status ?? "")
        ? " → 内覧アポ！"
        : ["application", "applying"].includes(c.status ?? "")
        ? " → 申込！"
        : "";
      return `${i + 1}. ${c.customer_name || "名称未設定"} → ${statusLabel}${replyMark}${action}`;
    });
    sections.push(`🔥 熱い客（${hot.length}人）夕方が勝負です！\n${lines.join("\n")}`);
  }

  if (sections.length === 0) {
    return NextResponse.json({ ok: true, skipped: true, reason: "no customers to report" });
  }

  const totalRemaining = (yotaiou?.length ?? 0) + (noreply?.length ?? 0);
  const mentionPrefix = "﻿@鈴木 祥平";

  const eveningText = [
    `${mentionPrefix} ${pickByDay(EVENING_OPENERS)}`,
    "",
    `18時時点・残り対応リスト（${totalRemaining}人・ラストスパートです）`,
    "",
    sections.join("\n\n"),
    "",
    "──────────────────",
    "🎯 今日の目標",
    "　内覧アポ 3件 ／ 申込 1件",
    "",
    pickByDay(EVENING_CLOSERS),
  ].join("\n");

  const result = await pushLineMessage(groupId, token, eveningText, suzukiUserId);
  if (!result.ok) {
    console.error("[daily-brief evening] LINE push failed:", result.error);
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }

  await supabase.from("hanbancyo_settings")
    .upsert({ key: COOLDOWN_KEY, value: new Date().toISOString() }, { onConflict: "key" });

  return NextResponse.json({ ok: true, sent: true, mode: "evening",
    yotaiou: yotaiou?.length ?? 0, noreply: noreply?.length ?? 0, hot: hot?.length ?? 0 });
}
