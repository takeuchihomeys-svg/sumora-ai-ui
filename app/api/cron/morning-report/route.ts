import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

const ACCOUNT_LABEL: Record<string, string> = {
  sumora: "スモラ", ieyasu: "イエヤス", giga: "ギガ賃貸", hasu: "ハス",
};

function relTime(d?: string | null): string {
  if (!d) return "不明";
  const diff = Date.now() - new Date(d).getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 24) return `${h}時間前`;
  return `${Math.floor(h / 24)}日前`;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // LINEグループ設定
  let groupId: string | null = process.env.LINE_STAFF_GROUP_ID ?? null;
  if (!groupId) {
    const { data } = await supabase.from("hanbancyo_settings").select("value").eq("key", "group_id").single();
    groupId = (data?.value as string) ?? null;
  }
  const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ?? process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN;
  if (!groupId || !token) {
    return NextResponse.json({ ok: false, error: "LINE config missing" }, { status: 500 });
  }

  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

  // 並列取得
  const [
    { data: pendingTasks },
    { data: unrepliedConvs },
    { data: hotCustomers },
  ] = await Promise.all([
    // ① 未完了タスク
    supabase
      .from("line_tasks")
      .select("id, conversation_id, task_type, customer_name, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true }),

    // ② 未返信の会話（お客さんが最後に送信 & 2日以内）
    supabase
      .from("conversations")
      .select("id, customer_name, account, updated_at")
      .eq("last_sender", "customer")
      .neq("status", "closed_won")
      .gte("updated_at", twoDaysAgo)
      .order("updated_at", { ascending: false })
      .limit(10),

    // ③ 今日物件を出すべきホット顧客
    supabase
      .from("property_customers")
      .select("id, customer_name, status, last_property_sent_at")
      .in("status", ["hot", "new_inquiry"])
      .order("last_property_sent_at", { ascending: true, nullsFirst: true })
      .limit(10),
  ]);

  const sections: string[] = [];

  // ① 未完了タスク
  const tasks = pendingTasks ?? [];
  if (tasks.length > 0) {
    const TASK_EMOJI: Record<string, string> = { property_check: "🔍", property_send: "🏠" };
    const TASK_LABEL: Record<string, string> = { property_check: "物件確認", property_send: "物件出し" };
    const lines = tasks.map((t, i) =>
      `${i + 1}. ${TASK_EMOJI[t.task_type as string] ?? "📋"} ${t.customer_name ?? "不明"}さん — ${TASK_LABEL[t.task_type as string] ?? t.task_type}（${relTime(t.created_at as string)}～）`
    );
    sections.push(`📋 未完了タスク（${tasks.length}件）\n\n${lines.join("\n")}`);
  }

  // ② 未返信
  const unreplied = unrepliedConvs ?? [];
  if (unreplied.length > 0) {
    const lines = unreplied.map((c, i) => {
      const acct = ACCOUNT_LABEL[(c.account as string) ?? "sumora"] ?? "スモラ";
      return `${i + 1}. ${c.customer_name ?? "名称未設定"}さん（${acct}）— ${relTime(c.updated_at as string)}`;
    });
    sections.push(`💬 未返信のお客さん（${unreplied.length}件）\n\n${lines.join("\n")}`);
  }

  // ③ 今日物件を出すべき顧客
  const todayStart = new Date();
  todayStart.setUTCHours(todayStart.getUTCHours() - (todayStart.getUTCHours() % 24), 0, 0, 0);
  todayStart.setTime(todayStart.getTime() - 9 * 60 * 60 * 1000); // JST today start

  const needsProp = (hotCustomers ?? []).filter((c) => {
    if (c.status === "new_inquiry") return true;
    if (c.status === "hot") {
      return !c.last_property_sent_at || new Date(c.last_property_sent_at as string) < todayStart;
    }
    return false;
  });

  if (needsProp.length > 0) {
    const lines = needsProp.map((c, i) => {
      const last = c.last_property_sent_at ? relTime(c.last_property_sent_at as string) : "未送信";
      const tag = c.status === "new_inquiry" ? "新規" : "毎日出し";
      return `${i + 1}. 🔥 ${c.customer_name ?? "不明"}さん（${tag}）— ${last}`;
    });
    sections.push(`🏠 今日物件を出すべきお客さん（${needsProp.length}件）\n\n${lines.join("\n")}`);
  }

  if (sections.length === 0) {
    const text = "🌅 おはようございます！\n今日は未完了タスク・未返信ともにゼロです🎉\n引き続きよろしくお願いします！";
    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: groupId, messages: [{ type: "text", text }] }),
    });
    return NextResponse.json({ ok: true, tasks: 0, unreplied: 0, needsProp: 0 });
  }

  const text = `🌅 おはようございます！今日のタスクレポートです\n\n${sections.join("\n\n——————\n\n")}\n\n全員対応よろしくお願いします！`;

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: groupId, messages: [{ type: "text", text }] }),
  });

  if (!res.ok) {
    const body = await res.text();
    return NextResponse.json({ ok: false, error: body }, { status: 500 });
  }

  return NextResponse.json({ ok: true, tasks: tasks.length, unreplied: unreplied.length, needsProp: needsProp.length });
}
