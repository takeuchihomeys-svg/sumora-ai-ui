import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 60;

const ACCOUNT_LABEL: Record<string, string> = {
  sumora: "スモラ", ieyasu: "イエヤス", giga: "ギガ賃貸", hasu: "ハス",
};

function relTime(d?: string | null): string {
  if (!d) return "不明";
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  return `${Math.floor(h / 24)}日前`;
}

function getJSTHour(): number {
  return (new Date().getUTCHours() + 9) % 24;
}

// 物件出しが必要か判定
function needsPropertyAction(status: string, lastSentAt: string | null): boolean {
  if (status === "new_inquiry") return true;
  // B04: setHours はサーバー（UTC）ローカルタイムを使うため JST と 9h ずれる。
  //      UTC ms に +9h して UTC midnight を JST midnight として扱う。
  const jstOffsetMs = 9 * 3600 * 1000;
  const todayJst = new Date(Math.floor((Date.now() + jstOffsetMs) / 86400000) * 86400000 - jstOffsetMs);
  if (status === "hot") return !lastSentAt || new Date(lastSentAt) < todayJst;
  if (status === "property_search") {
    if (!lastSentAt) return true;
    return (Date.now() - new Date(lastSentAt).getTime()) / 86400000 >= 3;
  }
  return false;
}

const PROP_STATUS_LABEL: Record<string, string> = {
  new_inquiry: "新規",
  hot: "毎日出し",
  property_search: "物件出し",
};

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let targetId = process.env.LINE_STAFF_GROUP_ID ?? null;
  // フォールバック: hanbancyo_settings テーブルの group_id を使う
  if (!targetId) {
    const { data: grpRow } = await supabase.from("hanbancyo_settings").select("value").eq("key", "group_id").maybeSingle();
    targetId = grpRow?.value ?? null;
  }
  if (!targetId) {
    return NextResponse.json({ ok: false, error: "LINE_STAFF_GROUP_ID not configured (env) and hanbancyo_settings group_id not set (db)" }, { status: 500 });
  }
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ?? process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    return NextResponse.json({ ok: false, error: "LINE token not configured" }, { status: 500 });
  }

  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  // ① 🔥マークされた会話 / 物件出し要 / 3日フォローアップ を並列取得
  const [{ data: hotConvs }, { data: propCustomers }, { data: staleConvs }] = await Promise.all([
    supabase
      .from("conversations")
      .select("id, customer_name, account, last_message, last_sender, updated_at, property_customer_id, property_customers(last_property_sent_at, hot_confirmed_at)")
      .eq("is_hot", true)
      .order("updated_at", { ascending: false })
      .limit(30),

    // ② 物件出し要のお客さん（hot/new_inquiry/property_search）
    supabase
      .from("property_customers")
      .select("id, customer_name, status, last_property_sent_at, account")
      .in("status", ["new_inquiry", "hot", "property_search"])
      .order("updated_at", { ascending: false })
      .limit(30),

    // ③ 3日以上お客さんから連絡あり・未返信（🔥でない会話）
    supabase
      .from("conversations")
      .select("id, customer_name, account, last_message, updated_at")
      .eq("last_sender", "customer")
      .eq("is_hot", false)
      .neq("status", "closed_won")
      .lt("updated_at", threeDaysAgo)
      .order("updated_at", { ascending: true })
      .limit(10),
  ]);

  type HotConvRow = {
    id: string; customer_name: string | null; account: string | null;
    last_message: string | null; last_sender: string | null; updated_at: string | null;
    property_customer_id: string | null;
    // Supabaseのリレーションは常に配列で返る
    property_customers: { last_property_sent_at: string | null; hot_confirmed_at: string | null }[] | null;
  };

  // 今日の開始（JST 00:00 = UTC 前日15:00）
  const _jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  _jstNow.setUTCHours(0, 0, 0, 0);
  const todayStart = new Date(_jstNow.getTime() - 9 * 60 * 60 * 1000);
  const isDoneToday = (pc: HotConvRow["property_customers"]) => {
    const row = pc?.[0]; // 配列の先頭のみ参照
    if (!row) return false;
    const sent = row.last_property_sent_at && new Date(row.last_property_sent_at) >= todayStart;
    const confirmed = row.hot_confirmed_at && new Date(row.hot_confirmed_at) >= todayStart;
    return !!(sent || confirmed);
  };

  // 🔥会話に紐付いているproperty_customer_idのセット（重複排除用）
  const hotLinkedPcIds = new Set(
    (hotConvs as HotConvRow[] ?? []).map((c) => c.property_customer_id).filter(Boolean) as string[]
  );

  // 物件出しが実際に必要な人だけに絞り、🔥と重複する人は除外
  type PropCustomer = { id: string; customer_name: string | null; status: string | null; last_property_sent_at: string | null; account: string | null };
  const needsPropList = (propCustomers as PropCustomer[] ?? []).filter((c) =>
    needsPropertyAction(c.status ?? "", c.last_property_sent_at ?? null) &&
    !hotLinkedPcIds.has(c.id)
  );

  // どれも0件ならスキップ
  if ((!hotConvs || hotConvs.length === 0) && needsPropList.length === 0 && (!staleConvs || staleConvs.length === 0)) {
    return NextResponse.json({ ok: true, skipped: true, reason: "no actions needed" });
  }

  const hour = getJSTHour();
  const sections: string[] = [];

  // 🔥セクション
  if (hotConvs && hotConvs.length > 0) {
    const rows = hotConvs as HotConvRow[];
    const doneCount = rows.filter((c) =>
      isDoneToday(c.property_customers) ||
      (c.last_sender !== "customer" && !!c.updated_at && new Date(c.updated_at) >= todayStart)
    ).length;
    const lines = rows.map((c, i) => {
      const name = c.customer_name || "名称未設定";
      const acct = ACCOUNT_LABEL[c.account ?? "sumora"] ?? "スモラ";
      const time = relTime(c.updated_at);
      const replyMark = c.last_sender === "customer" ? "⏰ 未返信" : "返信済";
      // スタッフが今日返信 or 物件を送った/確認した → ✅対応済
      const staffActedToday = c.last_sender !== "customer" && !!c.updated_at &&
        new Date(c.updated_at) >= todayStart;
      const repliedRecently = c.last_sender !== "customer" && !!c.updated_at &&
        (Date.now() - new Date(c.updated_at).getTime()) < 24 * 60 * 60 * 1000;
      const actionMark = (isDoneToday(c.property_customers) || staffActedToday)
        ? "✅ 本日対応済"
        : repliedRecently
          ? "💬 返信済"
          : "❌ 未対応";
      const preview = (c.last_message ?? "").slice(0, 18) + ((c.last_message ?? "").length > 18 ? "…" : "");
      return `${i + 1}. ${name}（${acct}）\n   ${actionMark}　${replyMark} ${time}\n   └ ${preview}`;
    });
    sections.push(`🔥 あついお客さん（${rows.length}人 / ✅${doneCount}名対応済）\n\n${lines.join("\n\n")}`);
  }

  // 📦物件出し要セクション
  if (needsPropList.length > 0) {
    const lines = needsPropList.map((c, i) => {
      const name = c.customer_name || "名称未設定";
      const label = PROP_STATUS_LABEL[c.status ?? ""] ?? c.status ?? "";
      const sentLabel = c.last_property_sent_at
        ? `${Math.floor((Date.now() - new Date(c.last_property_sent_at).getTime()) / 86400000)}日前送信`
        : "未送信";
      return `${i + 1}. ${name} — ${label} ${sentLabel}`;
    });
    sections.push(`📦 物件出し要（${needsPropList.length}人）\n\n${lines.join("\n")}`);
  }

  // ⏰ 3日以上未返信セクション（朝9時のタイミングのみ表示）
  type StaleConvRow = { id: string; customer_name: string | null; account: string | null; last_message: string | null; updated_at: string | null };
  const staleList = staleConvs as StaleConvRow[] ?? [];
  if (staleList.length > 0) {
    const lines = staleList.map((c, i) => {
      const name = c.customer_name || "名称未設定";
      const acct = ACCOUNT_LABEL[c.account ?? "sumora"] ?? "スモラ";
      const days = Math.floor((Date.now() - new Date(c.updated_at ?? "").getTime()) / 86400000);
      const preview = (c.last_message ?? "").slice(0, 20) + ((c.last_message ?? "").length > 20 ? "…" : "");
      return `${i + 1}. ${name}（${acct}）— ${days}日前\n   └ ${preview}`;
    });
    sections.push(`⏰ 3日以上未返信（${staleList.length}人）\n\n${lines.join("\n\n")}`);
  }

  const message = `${sections.join("\n\n——————\n\n")}\n\nAIX LINX より ${hour}:00`;

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: targetId, messages: [{ type: "text", text: message }] }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("announce-hot-customers LINE error:", text);
    return NextResponse.json({ ok: false, error: text }, { status: 500 });
  }

  return NextResponse.json({ ok: true, hot: hotConvs?.length ?? 0, needsProp: needsPropList.length, stale: staleList.length });
}
