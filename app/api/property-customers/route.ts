import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { recordConditionHistory, conditionSourceTag } from "@/app/lib/condition-history";
import { itemizeWants, type WantsCustomerLike } from "@/app/lib/customer-wants";
import { searchRentMinOf, type CustomerLike } from "@/app/lib/property-brain";

// 条件変更履歴の追跡対象フィールド（condition-history.ts の TRACKED と同一）
const CONDITION_TRACKED_FIELDS = [
  "desired_area", "floor_plan", "rent_max", "rent_min",
  "walk_minutes", "move_in_time", "building_age", "initial_cost_limit", "other_requests",
  "floor_area_min", "floor_area_max", "pet", "commute_station", "commute_minutes",
  "area_mode", "preferences", "ng_points",
];

// 今日まだ未対応かどうか判定
function needsActionToday(c: { status: string; last_property_sent_at: string | null; hot_confirmed_at?: string | null; property_viewed_at?: string | null }): boolean {
  if (c.status === "new_inquiry") return true;
  const now = new Date();
  // JSTでの「今日の0時」をUTC基準で正しく計算（サーバーがUTCでも9時間ズレない）
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const jstDateStr = jstNow.toISOString().slice(0, 10); // 例: "2026-07-05"（JSTの今日）
  const todayStart = new Date(`${jstDateStr}T00:00:00+09:00`);
  if (c.status === "hot") {
    const sent     = c.last_property_sent_at && new Date(c.last_property_sent_at) >= todayStart;
    const confirmed = c.hot_confirmed_at      && new Date(c.hot_confirmed_at)      >= todayStart;
    const viewed   = c.property_viewed_at     && new Date(c.property_viewed_at)    >= todayStart;
    return !sent && !confirmed && !viewed;
  }
  if (c.status === "property_search") {
    if (!c.last_property_sent_at) return true;
    return (now.getTime() - new Date(c.last_property_sent_at).getTime()) / 86400000 >= 3;
  }
  return false;
}

// 全員完了したときだけ🎉を売上番長グループに送る
async function checkAllDone(): Promise<void> {
  try {
    const token = process.env.LINE_HANBANCYO_CHANNEL_ACCESS_TOKEN ?? process.env.LINE_SUMORA_CHANNEL_ACCESS_TOKEN;
    if (!token) return;
    let groupId: string | null = process.env.LINE_STAFF_GROUP_ID ?? null;
    if (!groupId) {
      const { data: grp } = await supabase.from("hanbancyo_settings").select("value").eq("key", "group_id").maybeSingle();
      groupId = (grp?.value as string) ?? null;
    }
    if (!groupId) return;

    const { data } = await supabase
      .from("property_customers")
      .select("status, last_property_sent_at, hot_confirmed_at, property_viewed_at")
      .in("status", ["new_inquiry", "hot", "property_search"]);
    if (!data || data.length === 0) return;

    const remaining = (data as Array<{ status: string; last_property_sent_at: string | null; hot_confirmed_at: string | null; property_viewed_at: string | null }>)
      .filter(needsActionToday).length;
    if (remaining > 0) return;

    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: groupId, messages: [{ type: "text", text: "🎉 本日の物件出し全員完了！\nお疲れ様でした！" }] }),
    });
  } catch { /* 失敗は無視 */ }
}

// 2026-10-06 v2.5.80（⑯）竹内「物件検索する際の拡張ツールを開く際も重すぎる」: 拡張の一覧は ?view=list で軽い形を受ける。
//   実測（本番 325人）: 既定の形は 1.69MB（br 圧縮で 324KB）・3.0秒。重い所は 要望の項目（want_items 250KB・行ごとに計算）・
//   会話の最後の発言（linked_conversation 132KB）・ai_summary_json 106KB・ai_summary 93KB・raw_format_text 38KB。
//   一覧に要らない物（会話の要約・人物像・申込フォームの原文・条件の要約・要望の項目の計算・会話の最後の発言と画像）を外す。
//   お客様を開いた時は今まで通り ?id= で全部を受ける（拡張の fetchFreshCustomer）。既定（view なし）の形は変えない（⑫ の /conditions・アプリが使う）
const LIST_DROP = ["ai_summary", "ai_summary_json", "personality_profile", "raw_format_text", "condition_summary", "condition_summary_hash"] as const;

export async function GET(req: NextRequest) {
  const singleId = new URL(req.url).searchParams.get("id");
  const listView = !singleId && new URL(req.url).searchParams.get("view") === "list";
  const pcQuery = singleId
    ? supabase.from("property_customers").select("*").eq("id", singleId)
    : supabase.from("property_customers").select("*").order("updated_at", { ascending: false });
  const [{ data, error }, { data: convData }] = await Promise.all([
    pcQuery,
    supabase
      .from("conversations")
      .select("id, property_customer_id, last_message, last_sender, updated_at, account, status, profile_image_url, customer_name, is_hot, is_flagged")
      .not("property_customer_id", "is", null),
  ]);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const convMap = new Map((convData || []).map((c) => [c.property_customer_id, c]));
  if (listView) {
    const rows = (data || []).map((c) => {
      const o: Record<string, unknown> = { ...c };
      for (const k of LIST_DROP) delete o[k];
      const conv = convMap.get(c.id) ?? (c.parent_customer_id ? convMap.get(c.parent_customer_id) ?? null : null);
      o.rent_min_search = searchRentMinOf(c as CustomerLike)?.yen ?? null;
      o.is_linked = convMap.has(c.id) || (!!c.parent_customer_id && convMap.has(c.parent_customer_id));
      o.linked_conversation = conv ? { id: conv.id, property_customer_id: conv.property_customer_id, last_sender: conv.last_sender, updated_at: conv.updated_at, account: conv.account, status: conv.status, is_hot: conv.is_hot, is_flagged: conv.is_flagged } : null;
      o.list_view = true; // 一覧の軽い形の印（拡張はお客様を開く時に ?id= で全部を取り直す）
      return o;
    });
    return NextResponse.json(rows, { headers: { "Cache-Control": "no-store, must-revalidate" } });
  }
  const result = (data || []).map((c) => ({
    ...c,
    // 2026-09-29 要望の項目（設備／NG／その他・純関数 customer-wants.itemizeWants）。拡張の popup の条件の表示が読む（検索には入れない）
    want_items: itemizeWants(c as WantsCustomerLike),
    // 2026-10-02 ⑫ 竹内さんの決定: 検索に入れる家賃の下限（書いた下限・無ければ おおよその下限 × 保留の線＝採点で保留になる所より下は探さない）。
    //   顧客の行には書かない（使う時に property-brain.searchRentMinOf の1か所で出す）。拡張は rent_min_search を rent_min より先に読む
    rent_min_search: searchRentMinOf(c as CustomerLike)?.yen ?? null,
    // 2026-10-06 ⑫（ゆいと）: 2つ目の探し物の行（子・「ゆいと（物置）」）は会話の紐付けが親にある → 親の会話を出す（拡張・一覧で送る先・LINE が分かる）
    is_linked: convMap.has(c.id) || (!!c.parent_customer_id && convMap.has(c.parent_customer_id)),
    linked_conversation: convMap.get(c.id) ?? (c.parent_customer_id ? convMap.get(c.parent_customer_id) ?? null : null),
  }));
  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store, must-revalidate" },
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { error, data } = await supabase
    .from("property_customers")
    .insert(body)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const body = await req.json();
  const { id, ...fields } = body;

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  // 物件送信（last_property_sent_at 更新）時の自動ステータス処理
  if ("last_property_sent_at" in fields && !("status" in fields)) {
    const { data: current } = await supabase
      .from("property_customers")
      .select("id, status, property_send_count")
      .eq("id", id)
      .maybeSingle();

    if (current?.status === "new_inquiry") {
      // 新規問い合わせ → 毎日物件出しに自動昇格
      fields.status = "hot";
      fields.property_send_count = 1;
    } else if (current?.status === "hot") {
      // 毎日物件出しの場合: 返信状況を確認してカウント管理
      const newCount = ((current.property_send_count as number) ?? 0) + 1;

      // 紐付き会話の最終送信者を確認（返信があればカウントリセット）
      // GETと同じく property_customer_id で直接紐付け（line_user_id が null でも判定できる）
      const { data: conv } = await supabase
        .from("conversations")
        .select("last_sender")
        .eq("property_customer_id", id)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const lastSender: string | null = conv?.last_sender ?? null;

      const hasCustomerReply = lastSender === "customer";
      if (hasCustomerReply) {
        // お客さんから返信あり → カウントリセット
        fields.property_send_count = 1;
      } else if (newCount >= 2) {
        // 返信なしで2回送信 → 物件出しにダウングレード
        fields.status = "property_search";
        fields.property_send_count = 0;
      } else {
        fields.property_send_count = newCount;
      }
    }
  }

  // 条件フィールドが含まれる場合、UPDATE前に旧値を取得（変更履歴の diff 用）
  const trackedInPatch = CONDITION_TRACKED_FIELDS.filter((f) => f in fields);
  let oldConditionRow: Record<string, unknown> | null = null;
  if (trackedInPatch.length > 0) {
    const { data: oldRow } = await supabase
      .from("property_customers")
      .select(trackedInPatch.join(","))
      .eq("id", id)
      .maybeSingle();
    oldConditionRow = (oldRow as Record<string, unknown> | null) ?? null;
  }

  const { error, data } = await supabase
    .from("property_customers")
    .update(fields)
    .eq("id", id)
    .select()
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 条件変更を履歴化（fire-and-forget・UPDATE成功後のみ）
  if (trackedInPatch.length > 0) {
    void recordConditionHistory(supabase, String(id), oldConditionRow, fields, conditionSourceTag("screen_edit"))
      .catch((e) => console.warn("[condition-history] PATCH:", e));
  }

  // 物件送った or 確認済みのとき: 全員完了チェック（fire-and-forget）
  if ("last_property_sent_at" in body || "property_viewed_at" in body) {
    void checkAllDone();
  }

  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const { error } = await supabase
    .from("property_customers")
    .delete()
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
