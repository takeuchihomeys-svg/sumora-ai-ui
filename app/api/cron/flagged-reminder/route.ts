// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 60;

// conversations.status のラベル
const STATUS_LABELS: Record<string, string> = {
  hearing:              "ヒアリング中",
  first_reply:          "初回返信",
  condition_hearing:    "条件ヒアリング",
  property_search:      "物件探し",
  proposing:            "物件提案中",
  property_recommendation: "物件提案中",
  viewing:              "内見調整",
  estimate_request:     "見積依頼",
  availability_check:   "空室確認",
  applying:             "申込中",
  screening:            "審査中",
  contract:             "契約中",
};

// property_customers.status のラベル（物件出しブロック用）
const PROP_STATUS_LABELS: Record<string, string> = {
  new_inquiry:     "反響きたて",
  hot:             "ホット客",
  property_search: "物件探し中",
};

function getJSTHour(): number {
  return (new Date().getUTCHours() + 9) % 24;
}

/** 放置時間を「30分 / 4時間 / 3日」の形で返す（48時間以上は日表示） */
function elapsedLabel(d?: string | null): string {
  if (!d) return "不明";
  const ms = Date.now() - new Date(d).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "不明";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${Math.max(mins, 1)}分`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}時間`;
  return `${Math.floor(hours / 24)}日`;
}

function elapsedMs(d?: string | null): number {
  if (!d) return 0;
  const t = new Date(d).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(Date.now() - t, 0);
}

// ── 物件出し必須の判定（announce-hot-customers と同じロジック） ──
// setHours はサーバー（UTC）ローカルタイムなので JST と 9h ずれる。
// UTC ms に +9h して UTC midnight を JST midnight として扱う。
const JST_OFFSET_MS = 9 * 3600 * 1000;

function needsPropertySend(pcStatus: string | null, lastSentAt: string | null): boolean {
  if (!pcStatus) return false;
  const todayJst = new Date(
    Math.floor((Date.now() + JST_OFFSET_MS) / 86400000) * 86400000 - JST_OFFSET_MS
  );
  if (pcStatus === "new_inquiry") return true;
  if (pcStatus === "hot") return !lastSentAt || new Date(lastSentAt) < todayJst;
  if (pcStatus === "property_search") {
    if (!lastSentAt) return true;
    return (Date.now() - new Date(lastSentAt).getTime()) / 86400000 >= 3;
  }
  return false;
}

// ── 型定義 ──
type PropertyCustomerRel = {
  status: string | null;
  last_property_sent_at: string | null;
  desired_area: string | null;
  area: string | null;
  floor_plan: string | null;
  layout: string | null;
  rent_max: number | null;
  max_rent: number | null;
};

type ConversationRow = {
  id: string;
  customer_name: string | null;
  status: string | null;
  last_message: string | null;
  last_sender: string | null;
  updated_at: string | null;
  property_customer_id: string | null;
  // Supabase のリレーションは配列 or 単一オブジェクトで返る
  property_customers: PropertyCustomerRel | PropertyCustomerRel[] | null;
};

type Entry = {
  name: string;
  waitedMs: number;
  waited: string;
  convStatusLabel: string;
  preview: string;
  pc: PropertyCustomerRel | null;
  needsProperty: boolean;
};

/** リレーションを単一オブジェクトに正規化 */
function firstRel(rel: ConversationRow["property_customers"]): PropertyCustomerRel | null {
  if (!rel) return null;
  return Array.isArray(rel) ? (rel[0] ?? null) : rel;
}

/** 家賃を「〜16万」形式に。DBは円建て（110000）だが万円単位（16）で入っているケースも吸収 */
function rentLabel(pc: PropertyCustomerRel): string | null {
  const raw = pc.rent_max ?? pc.max_rent;
  if (!raw || raw <= 0) return null;
  const wan = raw > 1000 ? Math.floor(raw / 10000) : Math.floor(raw);
  if (wan <= 0) return null;
  return `〜${wan}万`;
}

/** 「中目黒 1LDK 〜16万・ホット客」のような条件サマリー */
function conditionSummary(pc: PropertyCustomerRel | null): string {
  if (!pc) return "";
  const parts: string[] = [];
  const area = pc.desired_area || pc.area;
  if (area) parts.push(area.slice(0, 14));
  const layout = pc.floor_plan || pc.layout;
  if (layout) parts.push(layout.slice(0, 10));
  const rent = rentLabel(pc);
  if (rent) parts.push(rent);
  const cond = parts.join(" ");
  const statusLabel = PROP_STATUS_LABELS[pc.status ?? ""] ?? "";
  if (cond && statusLabel) return `${cond}・${statusLabel}`;
  return cond || statusLabel;
}

function makePreview(row: ConversationRow, max: number): string {
  if (row.last_sender !== "customer") return "";
  const msg = (row.last_message ?? "").replace(/\s+/g, " ").trim();
  if (!msg) return "";
  return `「${msg.slice(0, max)}${msg.length > max ? "…" : ""}」`;
}

function greeting(hour: number): string {
  if (hour < 11) return "おはようございます☀️";
  if (hour < 17) return "おつかれさまです🙌";
  return "おつかれさまです🌙";
}

const HOUR_MS = 3600 * 1000;
/** 通常返信ブロックで表示する最大人数（残りは「ほかN人」に畳む） */
const NORMAL_DISPLAY_LIMIT = 10;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // 9:00〜20:00 JST の間だけ配信
  const jstHour = getJSTHour();
  if (jstHour < 9 || jstHour >= 20) {
    return NextResponse.json({ ok: true, skipped: true, reason: `JST ${jstHour}時 — 配信時間外（9:00〜20:00のみ）` });
  }

  // お盆期間スキップ・メンション制御
  // 8/12: 締めの手動LINEを送ったので今日の自動配信はスキップ
  // 8/13〜8/15: 鈴木お盆休み中のため自動配信は続けるがメンションなし
  const jstDateStr = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  if (jstDateStr === "2026-08-12") {
    return NextResponse.json({ ok: true, skipped: true, reason: "8/12 鈴木への締めLINEを送信済み — 今日の自動配信はスキップ" });
  }
  const suzukiObon = jstDateStr >= "2026-08-13" && jstDateStr <= "2026-08-15";

  // 30分以内に既に送信済みなら重複送信しない（Cron リトライ対策）
  const COOLDOWN_KEY = "flagged_reminder_last_sent_at";
  const cooldownMins = 55;
  const { data: lastSentRow } = await supabase
    .from("hanbancyo_settings").select("value").eq("key", COOLDOWN_KEY).maybeSingle();
  if (lastSentRow?.value) {
    const lastSentMs = new Date(lastSentRow.value as string).getTime();
    if (Date.now() - lastSentMs < cooldownMins * 60 * 1000) {
      return NextResponse.json({ ok: true, skipped: true, reason: `${cooldownMins}分以内に送信済み` });
    }
  }

  // 1時間前のタイムスタンプ（1時間以上返信が止まっている会話のみ対象）
  const oneHourAgo = new Date(Date.now() - HOUR_MS).toISOString();

  // 要対応 かつ 1時間以上更新なし（last_senderは問わない）の会話を取得
  const { data: flagged, error } = await supabase
    .from("conversations")
    .select(
      "id, customer_name, status, last_message, last_sender, updated_at, property_customer_id, " +
      "property_customers(status, last_property_sent_at, desired_area, area, floor_plan, layout, rent_max, max_rent)"
    )
    .eq("is_flagged", true)
    .lt("updated_at", oneHourAgo)
    .not("status", "in", "(closed_won,closed_lost)")
    .order("updated_at", { ascending: true })
    .limit(50);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!flagged || flagged.length === 0) {
    return NextResponse.json({ ok: true, sent: false, count: 0, reason: "1時間以上未返信の要対応なし" });
  }

  // LINEグループ設定
  let groupId: string | null = process.env.LINE_STAFF_GROUP_ID ?? null;
  if (!groupId) {
    const { data } = await supabase.from("hanbancyo_settings").select("value").eq("key", "group_id").maybeSingle();
    groupId = (data?.value as string) ?? null;
  }
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ?? process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN;

  if (!groupId || !token) {
    return NextResponse.json({ ok: false, error: "LINE config missing" }, { status: 500 });
  }

  // 鈴木のユーザーID取得（@メンション用）
  const { data: suzukiRow } = await supabase
    .from("hanbancyo_settings")
    .select("value")
    .eq("key", "suzuki_line_user_id")
    .maybeSingle();
  // お盆中はメンションしない
  const suzukiUserId = suzukiObon ? null : ((suzukiRow?.value as string) ?? null);

  // ── エントリ化 ──
  const rows = flagged as unknown as ConversationRow[];
  const entries: Entry[] = rows.map((row) => {
    const pc = firstRel(row.property_customers);
    const waitedMs = elapsedMs(row.updated_at);
    return {
      name: row.customer_name || "名称未設定",
      waitedMs,
      waited: elapsedLabel(row.updated_at),
      convStatusLabel: STATUS_LABELS[row.status ?? ""] ?? (row.status ?? ""),
      preview: makePreview(row, 24),
      pc,
      needsProperty: needsPropertySend(pc?.status ?? null, pc?.last_property_sent_at ?? null),
    };
  });

  // 放置が長い順にソート（全員まとめて1リスト）
  const sorted = [...entries].sort((a, b) => b.waitedMs - a.waitedMs);

  // ── メッセージ本文生成 ──
  const shown  = sorted.slice(0, NORMAL_DISPLAY_LIMIT);
  const hidden = sorted.length - shown.length;

  const lines = shown.map((e) => {
    const cond = conditionSummary(e.pc);
    const sub  = cond || e.preview || e.convStatusLabel;
    const head = `・ ${e.name}  ${e.waited}${e.convStatusLabel && !cond ? `  ${e.convStatusLabel}` : ""}`;
    return sub && sub !== e.convStatusLabel ? `${head}\n  ${sub}` : head;
  });
  if (hidden > 0) lines.push(`  ほか${hidden}人`);

  // 兄貴スタイル：気持ちを高める・熱く引っ張る
  const MOTIVATIONS = [
    "しょーへい、絶対いける!! ここ返したら最高の流れになるで！",
    "あとひと踏ん張りや！ここで動いた分が全部先につながってくる！",
    "この一手が絶対に先につながる。さあいこ、しょーへい！",
    "ここ決めたら最高やで！お客さんもしょーへいも絶対笑顔になる！",
    "しょーへいならここから全部ひっくり返せる。本当にそう思ってる！",
    "返すたびに信頼が積み上がってる。今日もその積み上げしてこ！",
    "ここが踏ん張りどきや！返した先に絶対いい結果が待ってるで！",
    "この返信一つ一つが、しょーへいの力になってる。全力でいこ！",
  ];
  const motivation = MOTIVATIONS[Math.floor(Date.now() / (30 * 60 * 1000)) % MOTIVATIONS.length];

  const bodyText = [
    `要対応  1時間以上止まってる（${entries.length}人）`,
    "",
    lines.join("\n"),
    "",
    motivation,
  ].join("\n");

  // @鈴木メンション付き textV2 メッセージ（鈴木IDがない場合は通常テキスト）
  const message = suzukiUserId
    ? {
        type: "textV2",
        text: `{mention} ${bodyText}`,
        substitution: {
          mention: {
            type: "mention",
            mentionee: { type: "user", userId: suzukiUserId },
          },
        },
      }
    : { type: "text", text: bodyText };

  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: groupId, messages: [message] }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error("[flagged-reminder] LINE push failed:", res.status, body);
      return NextResponse.json({ ok: false, error: body }, { status: 500 });
    }
  } catch (e) {
    console.error("[flagged-reminder] LINE push error:", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }

  // 送信成功後にタイムスタンプを記録
  await supabase.from("hanbancyo_settings").upsert(
    { key: COOLDOWN_KEY, value: new Date().toISOString() },
    { onConflict: "key" }
  );

  return NextResponse.json({
    ok: true,
    sent: true,
    count: entries.length,
  });
}
