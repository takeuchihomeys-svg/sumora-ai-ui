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
  created_at?: string | null;
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

// ── 人間らしいLINE文体（厳しさ + 感動 + !!）──────────────────────────

const MORNING_OPENERS = [
  "日曜やけど頼む！！休みでも待ってるお客さんいるから。返さない理由ないで。",
  "月曜の朝！！先週繋いだお客さんが今週どうなるかは今日次第やから。いって！！",
  "火曜日！！昨日動いた分だけ今日がある。その続きやって！！",
  "水曜！！週の折り返しやけど、ここで止まったら勿体ない。動いて！！",
  "木曜日！！今週あと2日。このまま終わるか決めるかは今日次第やで！！",
  "金曜の朝！！最後まで全部返して終わろう。ここが踏ん張りどころ！！",
  "土曜やけど頼む！！休みの日に連絡してくるお客さんは本気のやつ。逃すな！！",
];

const MORNING_CLOSERS = [
  "返せてない客がいる間は仕事終わってないから！！全部返してから終わりにして。",
  "地味に見えるかもしれんけど、これが誰かの家を決める仕事やから。続けよう！！",
  "しょーへいが動けば動くほどお客さんが前に進む！！今日もよろしく。",
  "できてないことを責めてるんじゃないで。もっとできると思ってるから言ってる！！いって。",
  "しょーへいならこのリスト全部いける！！やって！！",
  "毎朝このリスト送り続けるのはしょーへいに結果出してほしいから！！今日もよろしく。",
  "しんどい日もある。それでも動き続けてるしょーへいを見てるよ！！今日もよろしく。",
];

const MORNING_FINALS = [
  "しょーへいなら必ずできる！！信じてる！！",
  "しょーへいが動いた分だけ誰かの人生が変わる！！今日もいって！！",
  "このリストこなせるのはしょーへいだけやから頼んでる！！絶対できる！！",
  "しょーへいならこの全員動かせる！！今日も頼む！！",
  "毎日続けてるしょーへいが一番すごい！！今日も絶対いける！！",
  "しょーへいがここまで続けてこれてるのは本物の力があるから！！今日もよろしく！！",
  "自分を信じて動いて！！しょーへいは必ずできる人間やから！！",
];

const EVENING_OPENERS = [
  "日曜もここまでありがとう！！残ってる分だけやって終わりにして。",
  "月曜の終わり！！今日動いた分は明日の自分が楽になるから。残りだけやって！！",
  "火曜の夕方！！返せてない客はどんな気持ちで待ってるか考えて動いて。",
  "水曜の夕方！！今日中に全部返しておけば後半が楽になるから！！",
  "木曜のラスト！！明日の自分のために今日やりきって！！",
  "金曜夕方！！週末前に残りを全部片付けて気持ちよく終わって！！",
  "土曜もここまでありがとう！！お客さんを待たせないで終わらせよう。",
];

const EVENING_CLOSERS = [
  "今日動いた分だけ結果につながるから！！残りだけ頼む。",
  "ここ返したら今日は終わりにしていい！！あと少しだけ。",
  "正直しんどいと思う。それでも動き続けてるしょーへいに感謝してる！！最後だけ頼む。",
  "今日頑張った分、明日が楽になる！！いって！！",
  "しょーへいの対応でお客さんが次に進める！！残り全部返したらゆっくり休んで。",
  "毎日同じことの繰り返しに見えるかもしれんけど、これが積み重なって結果になるから！！もう少し。",
  "今日1日本当にありがとう！！最後だけ頼む。",
];

const DEADLINE_DONE_MESSAGES = [
  "しょーへいが動いてくれるから結果が出る！！本当にありがとう！！",
  "今日この動きができたなら明日も絶対できる！！続けよう！！",
  "完璧だった！！これを続けていけば必ず数字になるから！！",
];

const DEADLINE_PUSH_MESSAGES = [
  "まだ残ってる！！返せてない客はずっと待ってるから。19時まで動いて！！",
  "あと少し！！ここで止まるか動くかで明日が変わる！！",
  "定時ギリギリやけど残りを全部返してから終わりにして！！お客さんを待たせるな。",
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
  // @鈴木 祥平 プレフィックスを除いた本文（textV2 の {0} 置換後に続く部分）
  const MENTION_PREFIX = "@鈴木 祥平 ";
  const bodyText = text.startsWith(MENTION_PREFIX) ? text.slice(MENTION_PREFIX.length) : text;

  const message = suzukiUserId
    ? {
        type: "textV2",
        text: `{0} ${bodyText}`,
        substitution: {
          "0": {
            type: "mention",
            mentionee: { type: "user", userId: suzukiUserId },
          },
        },
      }
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
  const mentionPrefix = "@鈴木 祥平";

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
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: hannou }, { data: saiyuusen }, { data: bukkenDashi }, { data: shinchaku }] = await Promise.all([
    // 【返信あり】= お客さんから返信が来ている（24h以内・flagなし）
    supabase.from("conversations")
      .select("id, customer_name, status, last_message, last_sender, is_hot, updated_at")
      .eq("last_sender", "customer").eq("is_flagged", false).eq("line_status", "active")
      .not("status", "in", CLOSED).gt("updated_at", twentyFourHoursAgo)
      .order("updated_at", { ascending: false }).limit(10),

    // 【最優先】= staffがflagした要対応客（最近フラグが立ったものを優先して最大15件）
    supabase.from("conversations")
      .select("id, customer_name, status, last_message, last_sender, is_hot, updated_at")
      .eq("is_flagged", true).eq("line_status", "active")
      .not("status", "in", CLOSED).order("updated_at", { ascending: false }).limit(15),

    // 【物件出し】= is_hot優先で20件（is_hotが少なければ7日以内アクティブで補完）
    supabase.from("conversations")
      .select("id, customer_name, status, last_sender, is_hot, updated_at")
      .eq("is_flagged", false).eq("line_status", "active")
      .not("status", "in", CLOSED).gt("updated_at", sevenDaysAgo)
      .order("is_hot", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(20),

    // 【新着】= 2日以内に新規登録・まだhot/flaggedでない初回対応待ち
    supabase.from("conversations")
      .select("id, customer_name, status, created_at")
      .eq("is_flagged", false).eq("is_hot", false).eq("line_status", "active")
      .in("status", ["first_reply", "condition_hearing", "hearing"])
      .gt("created_at", twoDaysAgo)
      .order("created_at", { ascending: false }).limit(8),
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

    // 【要対応】= しょーへいのターゲット（is_flagged=true）
    if (saiyuusen && saiyuusen.length > 0) {
      const lines = (saiyuusen as ConvRow[]).map(c => {
        const statusLabel = STATUS_LABELS[c.status ?? ""] ?? c.status ?? "状況不明";
        const time = elapsedLabel(c.updated_at);
        const replyMark = c.last_sender === "customer" ? "【返信あり】" : "";
        return `・${c.customer_name || "名称未設定"}（${statusLabel}）${replyMark}${time}`;
      });
      parts.push(`【しょーへいのターゲット（要対応）】全員物件出して！！\n${lines.join("\n")}`);
    } else {
      parts.push("【しょーへいのターゲット（要対応）】\n要対応なし");
    }

    // 返信あり（要対応外からも来てたら追加で表示）
    if (hannou && hannou.length > 0) {
      const lines = (hannou as ConvRow[]).map(c => {
        const time = elapsedLabel(c.updated_at);
        const preview = msgPreview(c.last_message ?? null);
        return `・${c.customer_name || "名称未設定"}　${time}${preview ? `　${preview}` : ""}`;
      });
      parts.push(`【返信あり】今すぐ全員返して！！\n${lines.join("\n")}`);
    }

    // 新規問い合わせ
    if (shinchaku && shinchaku.length > 0) {
      const lines = (shinchaku as ConvRow[]).map(c => {
        return `・${c.customer_name || "名称未設定"}　${elapsedLabel(c.created_at)}登録`;
      });
      parts.push(`【新規問い合わせ】今日中に返して！！\n${lines.join("\n")}`);
    }

    const fullText = [
      `${mentionPrefix} ${yesterdayPraise}${pickByDay(MORNING_OPENERS)}`,
      "",
      parts.join("\n\n"),
      "",
      "──────────────────",
      `全員に物件出して返信して！！それがしょーへいの今日の全仕事！！`,
      "",
      pickByDay(MORNING_CLOSERS),
      "",
      pickByDay(MORNING_FINALS),
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

  if (saiyuusen && saiyuusen.length > 0) {
    const lines = (saiyuusen as ConvRow[]).map(c => {
      const statusLabel = STATUS_LABELS[c.status ?? ""] ?? c.status ?? "状況不明";
      const time = elapsedLabel(c.updated_at);
      const replyMark = c.last_sender === "customer" ? "【返信あり】" : "";
      return `・${c.customer_name || "名称未設定"}（${statusLabel}）${replyMark}${time}`;
    });
    eveningParts.push(`【しょーへいのターゲット（要対応）残り確認】全員出せた？\n${lines.join("\n")}`);
  } else {
    eveningParts.push("【しょーへいのターゲット（要対応）残り確認】\n要対応なし。今日の物件出し完了！！");
  }

  if (hannou && hannou.length > 0) {
    const lines = (hannou as ConvRow[]).map(c => {
      const time = elapsedLabel(c.updated_at);
      const preview = msgPreview(c.last_message ?? null);
      return `・${c.customer_name || "名称未設定"}　${time}${preview ? `　${preview}` : ""}`;
    });
    eveningParts.push(`【返信あり】今日中に全員返して！！\n${lines.join("\n")}`);
  }

  if (shinchaku && shinchaku.length > 0) {
    const unanswered = (shinchaku as ConvRow[]).filter(c =>
      c.status === "first_reply" || c.status === "condition_hearing"
    );
    if (unanswered.length > 0) {
      const lines = unanswered.map(c =>
        `・${c.customer_name || "名称未設定"}　${elapsedLabel(c.created_at)}登録`
      );
      eveningParts.push(`【新規・未対応】今夜中に返して！！\n${lines.join("\n")}`);
    }
  }

  const eveningText = [
    `${mentionPrefix} ${todayPraise}${pickByDay(EVENING_OPENERS)}`,
    "",
    eveningParts.join("\n\n"),
    "",
    "──────────────────",
    `今日中にターゲット全員物件出して返信して！！`,
    "",
    pickByDay(EVENING_CLOSERS),
    "",
    pickByDay(MORNING_FINALS),
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
