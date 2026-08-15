import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// POST: 内覧予定を登録
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      conversation_id: string;
      customer_name?: string;
      viewing_date: string; // YYYY-MM-DD
      viewing_time?: string; // HH:MM
    };

    const { conversation_id, customer_name, viewing_date, viewing_time } = body;
    if (!conversation_id || !viewing_date) {
      return NextResponse.json({ ok: false, error: "conversation_id and viewing_date required" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("viewings")
      .insert({
        conversation_id,
        customer_name: customer_name ?? null,
        viewing_date,
        viewing_time: viewing_time ?? null,
        status: "scheduled",
      })
      .select("id")
      .single();

    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

    // --- 後処理: viewing_history追加 + conversation_direction即更新 ---
    // エラーが起きても内覧登録自体は成功とする
    try {
      // 1. viewing_history に追加（is_primary=false で仮挿入）
      await supabase.from("viewing_history").insert({
        conversation_id,
        customer_name: customer_name ?? null,
        scheduled_date: viewing_date,
        scheduled_time: viewing_time ?? null,
        status: "scheduled",
        is_primary: false,
        actual_date: null,
      });

      // 2. 同じ conversation_id の全件を is_primary=false にリセット
      await supabase
        .from("viewing_history")
        .update({ is_primary: false })
        .eq("conversation_id", conversation_id);

      // 3. 最新 scheduled_date のレコードを is_primary=true に昇格
      const { data: latest } = await supabase
        .from("viewing_history")
        .select("id")
        .eq("conversation_id", conversation_id)
        .order("scheduled_date", { ascending: false })
        .limit(1)
        .single();
      if (latest?.id) {
        await supabase
          .from("viewing_history")
          .update({ is_primary: true })
          .eq("id", latest.id);
      }

      // 4. conversation_direction を即更新
      const nowJst = new Date(Date.now() + 9 * 3600 * 1000);
      const todayJst = `${nowJst.getUTCFullYear()}-${String(nowJst.getUTCMonth() + 1).padStart(2, "0")}-${String(nowJst.getUTCDate()).padStart(2, "0")}`;

      const phaseDetail =
        viewing_date === todayJst ? "today"
          : viewing_date > todayJst ? "confirmed_future"
            : "after_viewing";

      const aixButton =
        phaseDetail === "after_viewing" || phaseDetail === "today"
          ? "greeting_viewing"
          : "meeting_place";

      const viewingScheduledAt = viewing_time
        ? `${viewing_date}T${viewing_time}:00+09:00`
        : `${viewing_date}T00:00:00+09:00`;

      // 既存の conversation_direction をマージしてから更新
      const { data: convRow } = await supabase
        .from("conversations")
        .select("conversation_direction")
        .eq("id", conversation_id)
        .single();

      const existingDir = (convRow?.conversation_direction as Record<string, unknown>) ?? {};

      await supabase
        .from("conversations")
        .update({
          conversation_direction: {
            ...existingDir,
            current_phase: "viewing",
            viewing_scheduled_at: viewingScheduledAt,
            viewing_phase_detail: phaseDetail,
            suggested_aix_button: aixButton,
            updated_at: new Date().toISOString(),
          },
        })
        .eq("id", conversation_id);
    } catch (postErr) {
      // 後処理エラーはログのみ・内覧登録自体は成功
      console.error("[viewings POST] post-processing error:", postErr);
    }
    // --- 後処理ここまで ---

    return NextResponse.json({ ok: true, id: data.id });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

// PUT: 内覧ステータス更新
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json() as {
      id: string;
      status: string;
      viewing_date?: string;
      conversation_id?: string;
    };
    const { id, status, viewing_date, conversation_id } = body;
    if (!id || !status) {
      return NextResponse.json({ ok: false, error: "id and status required" }, { status: 400 });
    }

    // viewings テーブルを更新
    const { error } = await supabase
      .from("viewings")
      .update({ status })
      .eq("id", id);

    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

    // 後処理: status=done 時に viewing_history と conversation_direction も更新
    if (status === "done" && conversation_id && viewing_date) {
      try {
        // viewing_history の status・actual_date を更新
        await supabase
          .from("viewing_history")
          .update({ status: "done", actual_date: viewing_date })
          .eq("conversation_id", conversation_id)
          .eq("scheduled_date", viewing_date);

        // conversation_direction を after_viewing に更新
        const { data: convRow } = await supabase
          .from("conversations")
          .select("conversation_direction")
          .eq("id", conversation_id)
          .single();

        const existingDir = (convRow?.conversation_direction as Record<string, unknown>) ?? {};

        await supabase
          .from("conversations")
          .update({
            conversation_direction: {
              ...existingDir,
              viewing_phase_detail: "after_viewing",
              suggested_aix_button: "greeting_viewing",
              updated_at: new Date().toISOString(),
            },
          })
          .eq("id", conversation_id);
      } catch (postErr) {
        console.error("[viewings PUT] post-processing error:", postErr);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

// GET: 今日の内覧一覧（クーロン用）
export async function GET() {
  const todayJST = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("viewings")
    .select("*")
    .eq("viewing_date", todayJST)
    .eq("status", "scheduled");

  if (error) return NextResponse.json({ viewings: [] });
  return NextResponse.json({ viewings: data ?? [] });
}
