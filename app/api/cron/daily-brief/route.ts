import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 60;

// ── 型定義 ────────────────────────────────────────────────────────────

type ConvRow = {
  id: string;
  customer_name: string | null;
  status: string | null;
  last_message?: string | null;
  last_sender?: string | null;
  is_hot?: boolean | null;
  updated_at: string | null;
};

// ── Helpers ───────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  first_reply:             "初回返信",
  condition_hearing:       "条件ヒアリング",
  hearing:                 "ヒアリング中",
  property_search:         "物件探し中",
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

// JST曜日: 0=日 1=月 2=火 3=水 4=木 5=金 6=土
function getJSTDayOfWeek(): number {
  const jstMs = Date.now() + 9 * 60 * 60 * 1000;
  return new Date(jstMs).getDay();
}

function pickByDay<T>(arr: T[]): T {
  return arr[getJSTDayOfWeek() % arr.length];
}

function buildBukkenLines(rows: ConvRow[]): string[] {
  return rows.map((c, i) => {
    const statusLabel = STATUS_LABELS[c.status ?? ""] ?? c.status ?? "状況不明";
    const elapsed = elapsedLabel(c.updated_at);
    return `${i + 1}. ${c.customer_name || "名称未設定"}（${elapsed}・${statusLabel}）`;
  });
}

// ── 人間っぽい声かけ（絵文字なし）────────────────────────────────────

const MORNING_OPENERS = [
  "日曜やけどよろしく。休みでも動いてるお客さんいる。",
  "月曜の朝。今週も反応あるやつから全部返して。",
  "火曜日。昨日の勢いそのままいって。",
  "水曜。週の折り返しやから今日もしっかり回して。",
  "木曜日。週末まであと少し。今日も全力でいって。",
  "金曜の朝。週末前に全部片付けて。ここが踏ん張りどころ。",
  "土曜やけどよろしく。お客さんは休日こそ動いてる。",
];

const MORNING_CLOSERS = [
  "反応あるやつから順番に全部返して。",
  "上から一気にいって。",
  "要対応から潰したら熱い客を攻める流れで。",
  "返信早いほどアポに繋がるから今日もよろしく。",
  "鈴木ならできる。全部やって。",
  "お客さん待ってるから今日もよろしく。",
  "いつも動いてくれてありがとう。今日もよろしく。",
];

const EVENING_OPENERS = [
  "日曜もここまでありがとう。残りだけやって。",
  "月曜の終わり。残りの対応だけやりきって終わりにして。",
  "火曜のラスト。あと少しだけ頑張って。",
  "水曜の夕方。今日中に全部返して。",
  "木曜のラスト。明日を楽にするために今日やりきって。",
  "金曜夕方。週末前にここをきれいにして終わって。",
  "土曜もここまでありがとう。残りのお客さんだけあと少し。",
];

const EVENING_CLOSERS = [
  "今日よく動けた。残りだけ頼む。",
  "ここ返したら今日は終わりにしていい。あと少し。",
  "夕方はお客さんも返事しやすいから今がチャンス。",
  "今日頑張った分、明日が楽になる。いって。",
  "残り全部返したらゆっくり休んで。",
  "鈴木の対応でお客さん助かってる。もう少しだけ。",
  "今日も1日ありがとう。最後だけ頼む。",
];

const DEADLINE_DONE_MESSAGES = [
  "このペース続けて。",
  "明日もよろしく。",
  "完璧だった。",
];

const DEADLINE_PUSH_MESSAGES = [
  "まだ残ってる。19時まで動いて。",
  "あと少しやから集中して。",
  "定時ギリギリやけど、残りを全部返してから終わりにして。",
];

// ── 鈴木 祥平 LINE User ID 解決 ──────────────────────────────────────

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
  const isDeadline = mode === "deadline";

  const COOLDOWN_KEY = isDeadline
    ? "daily_brief_deadline_last_sent_at"
    : isEvening
    ? "daily_brief_evening_last_sent_at"
    : "daily_brief_morning_last_sent_at";
  const COOLDOWN_HOURS = 6;

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

  // ── 共通定数 ──────────────────────────────────────────────────────────
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const CLOSED = "(closed_won,closed_lost,lost)";
  const mentionPrefix = "﻿@鈴木 祥平";

  // JST今日0時をUTCに変換
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  jstNow.setUTCHours(0, 0, 0, 0);
  const todayStart = new Date(jstNow.getTime() - 9 * 60 * 60 * 1000).toISOString();

  // ── 締切モード（JST 19:00 / mode=deadline）────────────────────────────
  if (isDeadline) {
    const [{ data: doneList }, { data: deadlineBukken }] = await Promise.all([
      // 今日JST0時以降にstaffが更新した顧客
      supabase.from("conversations")
        .select("id, customer_name, status, last_sender, is_hot, updated_at")
        .eq("is_flagged", false).eq("line_status", "active").eq("last_sender", "staff")
        .not("status", "in", CLOSED).gt("updated_at", todayStart)
        .order("updated_at", { ascending: false }),

      // 全対象顧客リスト（bukkenDashiと同条件）
      supabase.from("conversations")
        .select("id, customer_name, status, last_sender, is_hot, updated_at")
        .eq("is_flagged", false).eq("line_status", "active")
        .not("status", "in", CLOSED).gt("updated_at", sevenDaysAgo)
        .order("is_hot", { ascending: false })
        .order("updated_at", { ascending: false })
        .limit(20),
    ]);

    const doneCount = doneList?.length ?? 0;
    const doneIds = new Set((doneList ?? []).map((r: ConvRow) => r.id));
    const remainingList = ((deadlineBukken as ConvRow[]) ?? []).filter(r => !doneIds.has(r.id));
    const remainingCount = remainingList.length;

    let deadlineText: string;

    if (doneCount >= 15) {
      const praise = pickByDay(DEADLINE_DONE_MESSAGES);
      deadlineText = `${mentionPrefix} 19時。今日${doneCount}人動かした。ナイス！！ ${praise}`;
    } else {
      const push = pickByDay(DEADLINE_PUSH_MESSAGES);
      const remainLines = remainingList.slice(0, 10).map((c, i) => {
        const statusLabel = STATUS_LABELS[c.status ?? ""] ?? c.status ?? "状況不明";
        return `${i + 1}. ${c.customer_name || "名称未設定"}（${statusLabel}）`;
      });
      const moreLine = remainingList.length > 10 ? `...他${remainingList.length - 10}人` : "";

      deadlineText = [
        `${mentionPrefix} 19時。今日は${doneCount}人対応して、まだ${remainingCount}人残ってる。`,
        "",
        push,
        "",
        "【未対応】",
        ...remainLines,
        ...(moreLine ? [moreLine] : []),
        "",
        "明日は朝から動いて。遅れが続くと週の目標が厳しくなる。",
      ].join("\n");
    }

    const result = await pushLineMessage(groupId, token, deadlineText, suzukiUserId);
    if (!result.ok) {
      console.error("[daily-brief deadline] LINE push failed:", result.error);
      return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
    }

    await supabase.from("hanbancyo_settings")
      .upsert({ key: COOLDOWN_KEY, value: new Date().toISOString() }, { onConflict: "key" });

    return NextResponse.json({ ok: true, sent: true, mode: "deadline", doneCount, remainingCount });
  }

  // ── DB queries（朝・夕方共通）─────────────────────────────────────────
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [{ data: hannou }, { data: saiyuusen }, { data: bukkenDashi }] = await Promise.all([
    // 【新着】= お客さんから返信が来ている（24h以内・flagなし）
    supabase.from("conversations")
      .select("id, customer_name, status, last_message, last_sender, is_hot, updated_at")
      .eq("last_sender", "customer").eq("is_flagged", false).eq("line_status", "active")
      .not("status", "in", CLOSED).gt("updated_at", twentyFourHoursAgo)
      .order("updated_at", { ascending: false }).limit(10),

    // 【最優先】= staffがflagした要対応客
    supabase.from("conversations")
      .select("id, customer_name, status, last_message, last_sender, is_hot, updated_at")
      .eq("is_flagged", true).eq("line_status", "active")
      .not("status", "in", CLOSED).order("updated_at", { ascending: true }).limit(8),

    // 【物件出し】= is_hot優先で20件（is_hotが少なければ7日以内アクティブで補完）
    supabase.from("conversations")
      .select("id, customer_name, status, last_sender, is_hot, updated_at")
      .eq("is_flagged", false).eq("line_status", "active")
      .not("status", "in", CLOSED).gt("updated_at", sevenDaysAgo)
      .order("is_hot", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(20),
  ]);

  const bukkenRows = (bukkenDashi as ConvRow[]) ?? [];
  const hotCount = bukkenRows.filter(r => r.is_hot).length;
  const fillCount = bukkenRows.filter(r => !r.is_hot).length;
  const totalBukken = bukkenRows.length;

  // ── 朝メッセージ ──────────────────────────────────────────────────────
  if (!isEvening) {
    // 昨日のスタッフ活動件数チェック
    const yesterdayStart = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { count: yesterdayCount } = await supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("last_sender", "staff")
      .gt("updated_at", yesterdayStart)
      .lt("updated_at", todayStart);
    const yesterdayPraise = (yesterdayCount ?? 0) >= 5
      ? `昨日${yesterdayCount}件動かしてたな。ナイス！！\n\n`
      : "";

    const parts: string[] = [];

    if (hannou && hannou.length > 0) {
      const lines = (hannou as ConvRow[]).map(c => {
        const time = elapsedLabel(c.updated_at);
        const preview = msgPreview(c.last_message ?? null);
        return `・${c.customer_name || "名称未設定"}　${time}${preview ? `\n　${preview}` : ""}`;
      });
      parts.push(`【新着】返信来てる。今すぐ対応して。\n${lines.join("\n")}`);
    }

    if (saiyuusen && saiyuusen.length > 0) {
      const lines = (saiyuusen as ConvRow[]).map(c => {
        const time = elapsedLabel(c.updated_at);
        const replyMark = c.last_sender === "customer" ? "[返信あり]" : "";
        const action = ["viewing", "estimate_request", "availability_check"].includes(c.status ?? "")
          ? " → 内覧アポ"
          : ["application", "applying"].includes(c.status ?? "")
          ? " → 申込クロージング"
          : "";
        return `・${c.customer_name || "名称未設定"}　${time}${replyMark}${action}`;
      });
      parts.push(`【最優先】\n${lines.join("\n")}`);
    }

    if (bukkenRows.length > 0) {
      const bukkenLines = buildBukkenLines(bukkenRows);
      parts.push(
        [
          `【物件出し】（本日の目標: 20件）`,
          ...bukkenLines,
          `合計 ${totalBukken} 件 | 反応あり → 最優先 → 物件出し の順で動いて。`,
        ].join("\n")
      );
    }

    if (parts.length === 0) {
      return NextResponse.json({ ok: true, skipped: true, reason: "no customers to report" });
    }

    const fullText = [
      `${mentionPrefix} ${yesterdayPraise}${pickByDay(MORNING_OPENERS)}`,
      "",
      `今日の物件出しリスト。is_hot ${hotCount}人 + 7日以内アクティブ ${fillCount}人 = 計${totalBukken}人。直近に返信あった順。`,
      "",
      parts.join("\n\n"),
      "",
      "──────────────────",
      `物件出し目標: 本日${totalBukken}件（目標20件）`,
      "",
      pickByDay(MORNING_CLOSERS),
    ].join("\n");

    const result = await pushLineMessage(groupId, token, fullText, suzukiUserId);
    if (!result.ok) {
      console.error("[daily-brief morning] LINE push failed:", result.error);
      return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
    }

    await supabase.from("hanbancyo_settings")
      .upsert({ key: COOLDOWN_KEY, value: new Date().toISOString() }, { onConflict: "key" });

    return NextResponse.json({
      ok: true, sent: true, mode: "morning",
      hannou: hannou?.length ?? 0, saiyuusen: saiyuusen?.length ?? 0, bukkenDashi: bukkenDashi?.length ?? 0,
    });
  }

  // ── 夕方メッセージ（JST 18:00）────────────────────────────────────────
  // 今日のスタッフ活動件数チェック
  const { count: todayDoneCount } = await supabase
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("last_sender", "staff")
    .gt("updated_at", todayStart);
  const todayPraise = (todayDoneCount ?? 0) >= 8
    ? `今日ここまで${todayDoneCount}件動かしてる。ナイス！！\n\n`
    : "";

  const eveningParts: string[] = [];

  if (hannou && hannou.length > 0) {
    const lines = (hannou as ConvRow[]).map(c => {
      const time = elapsedLabel(c.updated_at);
      const preview = msgPreview(c.last_message ?? null);
      return `・${c.customer_name || "名称未設定"}　${time}${preview ? ` ${preview}` : ""}`;
    });
    eveningParts.push(`【新着】今日中に全員返して。\n${lines.join("\n")}`);
  }

  if (saiyuusen && saiyuusen.length > 0) {
    const lines = (saiyuusen as ConvRow[]).map(c => {
      const time = elapsedLabel(c.updated_at);
      const replyMark = c.last_sender === "customer" ? "[返信あり]" : "";
      const action = ["viewing", "estimate_request", "availability_check"].includes(c.status ?? "")
        ? " → 内覧アポ"
        : ["application", "applying"].includes(c.status ?? "")
        ? " → 申込"
        : "";
      return `・${c.customer_name || "名称未設定"}　${time}${replyMark}${action}`;
    });
    eveningParts.push(`【最優先】\n${lines.join("\n")}`);
  }

  if (bukkenRows.length > 0) {
    const bukkenLines = buildBukkenLines(bukkenRows);
    eveningParts.push(
      [
        `【物件出し】残り${totalBukken}件`,
        ...bukkenLines,
      ].join("\n")
    );
  }

  if (eveningParts.length === 0) {
    return NextResponse.json({ ok: true, skipped: true, reason: "no customers to report" });
  }

  const eveningText = [
    `${mentionPrefix} ${todayPraise}${pickByDay(EVENING_OPENERS)}`,
    "",
    `18時時点・残り対応（反応あり${hannou?.length ?? 0}人・最優先${saiyuusen?.length ?? 0}人）`,
    "",
    eveningParts.join("\n\n"),
    "",
    "──────────────────",
    pickByDay(EVENING_CLOSERS),
  ].join("\n");

  const result = await pushLineMessage(groupId, token, eveningText, suzukiUserId);
  if (!result.ok) {
    console.error("[daily-brief evening] LINE push failed:", result.error);
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }

  await supabase.from("hanbancyo_settings")
    .upsert({ key: COOLDOWN_KEY, value: new Date().toISOString() }, { onConflict: "key" });

  return NextResponse.json({
    ok: true, sent: true, mode: "evening",
    hannou: hannou?.length ?? 0, saiyuusen: saiyuusen?.length ?? 0, bukkenDashi: bukkenDashi?.length ?? 0,
  });
}
