import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isValidSyncKey, screeningTaskIdFor } from "@/app/lib/screening-calendar-sync";

function getScreeningClient() {
  return createClient(
    process.env.SCREENING_ADMIN_SUPABASE_URL!,
    process.env.SCREENING_ADMIN_SUPABASE_ANON_KEY!
  );
}

// GET /api/daily-tasks?from=2026-06-01&to=2026-06-30
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  if (!from || !to) {
    return NextResponse.json({ error: "from/to required" }, { status: 400 });
  }

  const sb = getScreeningClient();
  const { data, error } = await sb
    .from("daily_tasks")
    .select("id, customer_name, content, date, time, end_time, done, screening_id, management_company")
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: true })
    .order("time", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// POST /api/daily-tasks
//   sync_key（こちらのカレンダーの予定の id）を付けると、申込ツールの行の id をその予定から決める（dt_sumora_cal_<id>）。
//   同じ予定は何回送っても1行: あれば日時・中身を直す／無ければ入れる（update_only の時は無ければ何もしない）。
//   2026-09-30 竹内「内覧カレンダー登録したら、申込ツールのカレンダーにも連動して入れる」（app/lib/screening-calendar-sync.ts）
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { customer_name, content, date, time, end_time } = body;

  if (!content || !date) {
    return NextResponse.json({ error: "content/date required" }, { status: 400 });
  }

  const today = new Date().toISOString().slice(0, 10);

  if (body.sync_key !== undefined && body.sync_key !== null) {
    if (!isValidSyncKey(body.sync_key)) return NextResponse.json({ error: "invalid sync_key" }, { status: 400 });
    const syncId = screeningTaskIdFor(body.sync_key);
    const sbSync = getScreeningClient();
    const { data: cur, error: selErr } = await sbSync.from("daily_tasks").select("id, date, time").eq("id", syncId).maybeSingle();
    if (selErr) return NextResponse.json({ error: selErr.message }, { status: 500 });
    if (cur) {
      const updates: Record<string, unknown> = { customer_name: customer_name || "", content, date, time: time || "", end_time: end_time || "" };
      const { error: upErr } = await sbSync.from("daily_tasks").update(updates).eq("id", syncId);
      if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
      // 日時が変わった時は申込ツールの事前のお知らせ（3時間前・1時間前）をもう一度出せるように印を戻す。列が無い等で失敗しても本体は直っている
      if (cur.date !== date || (cur.time || "") !== (time || "")) {
        const { error: nErr } = await sbSync.from("daily_tasks").update({ notified_3h: false, notified_1h: false }).eq("id", syncId);
        if (nErr) console.warn("[daily-tasks] notified reset failed:", nErr.message);
      }
      console.log(JSON.stringify({ tag: "screening-calendar:sync", action: "updated", id: syncId, date, time: time || "" }));
      return NextResponse.json({ id: syncId, action: "updated" });
    }
    if (body.update_only) return NextResponse.json({ id: syncId, action: "skipped_not_found" });
    const { error: insErr } = await sbSync.from("daily_tasks").insert({
      id: syncId, customer_name: customer_name || "", content, date, time: time || "", end_time: end_time || "", done: false, created_at: today,
    });
    // 同時に2回届いた時（id の重複）は先の1回が入っているので成功扱い
    if (insErr && insErr.code !== "23505") return NextResponse.json({ error: insErr.message }, { status: 500 });
    console.log(JSON.stringify({ tag: "screening-calendar:sync", action: "inserted", id: syncId, date, time: time || "" }));
    return NextResponse.json({ id: syncId, action: "inserted" });
  }

  const id = `dt_sumora_${Date.now()}`;

  const sb = getScreeningClient();
  const { data, error } = await sb
    .from("daily_tasks")
    .insert({
      id,
      customer_name: customer_name || "",
      content,
      date,
      time: time || "",
      end_time: end_time || "",
      done: false,
      created_at: today,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// DELETE /api/daily-tasks?id=xxx
export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  // sync_key: こちらのカレンダーの予定を消した時に、その予定から入れた申込ツールの行（dt_sumora_cal_<id>）だけを消す（無ければ何も起きない）
  const syncKey = searchParams.get("sync_key");
  if (syncKey !== null && !isValidSyncKey(syncKey)) return NextResponse.json({ error: "invalid sync_key" }, { status: 400 });
  const id = syncKey !== null ? screeningTaskIdFor(syncKey) : searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const sb = getScreeningClient();
  const { error } = await sb.from("daily_tasks").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

// PATCH で更新を許可するカラム（id / screening_id / created_at は変更禁止）
const PATCH_ALLOWED_COLUMNS = [
  "customer_name",
  "content",
  "date",
  "time",
  "end_time",
  "done",
  "management_company",
] as const;

// PATCH /api/daily-tasks?id=xxx  (done切り替え等)
export async function PATCH(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const body = await req.json() as Record<string, unknown>;
  const updates: Record<string, unknown> = {};
  for (const key of PATCH_ALLOWED_COLUMNS) {
    if (key in body) updates[key] = body[key];
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "no updatable fields" }, { status: 400 });
  }

  const sb = getScreeningClient();
  const { error } = await sb.from("daily_tasks").update(updates).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
