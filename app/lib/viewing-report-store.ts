// app/lib/viewing-report-store.ts
// 内覧の内容（viewing_history.viewing_report）を書く・読む。形の整え・プロンプトの文は viewing-report.ts（純関数）。
// 2026-09-15 竹内（yasuki 事例）: 内覧後の挨拶の画面で入れた「内覧に行ったスタッフが分かったこと」を、その日の内覧の記録に書き、実施済みにする
//   （旧: 内覧前の挨拶・待ち合わせで作った「予定」は、内覧後に何をしても予定のまま。日付が過ぎると「日付経過（実施は未確認）」で閉じていた）
import { supabase } from "@/app/lib/supabase";
import { jstYmd } from "./jst-date";
import { normalizeViewingReport, pickViewingRowForReport, type ViewingReport } from "./viewing-report";

type Row = { id: string; scheduled_date: string; status: string | null; property_name: string | null; actual_date: string | null };

/** 内覧の内容を書く（今日〜3日前の内覧の記録を実施済みに・無ければ今日の記録を作る）。書いた記録の id を返す */
export async function recordViewingReport(o: {
  conversationId: string; customerName?: string | null; report: string; propertyName?: string | null; nowMs?: number;
}): Promise<{ ok: true; id: string; created: boolean; viewedOn: string } | { ok: false; error: string }> {
  const report = normalizeViewingReport(o.report);
  if (!report) return { ok: false, error: "内覧の内容が空です" };
  const nowMs = o.nowMs ?? Date.now();
  const today = jstYmd(nowMs);
  const nowIso = new Date(nowMs).toISOString();
  const propertyName = (o.propertyName ?? "").trim() || null;

  const { data, error } = await supabase.from("viewing_history")
    .select("id, scheduled_date, status, property_name, actual_date")
    .eq("conversation_id", o.conversationId).order("scheduled_date", { ascending: false }).limit(10);
  if (error) return { ok: false, error: error.message };
  const row = pickViewingRowForReport((data ?? []) as Row[], today);

  let id: string;
  let created = false;
  let viewedOn: string;
  if (row) {
    viewedOn = row.scheduled_date;
    const { error: upErr } = await supabase.from("viewing_history").update({
      status: "done",
      actual_date: row.actual_date ?? row.scheduled_date,
      viewing_report: report,
      viewing_report_at: nowIso,
      // 内覧した物件はスタッフの入力が正（待ち合わせの物件と違う物件を見ることもある）
      ...(propertyName ? { property_name: propertyName } : {}),
      updated_at: nowIso,
    }).eq("id", row.id);
    if (upErr) return { ok: false, error: upErr.message };
    id = row.id;
  } else {
    viewedOn = today;
    const { data: ins, error: insErr } = await supabase.from("viewing_history").insert({
      conversation_id: o.conversationId, customer_name: o.customerName ?? null,
      scheduled_date: today, actual_date: today, status: "done", is_primary: false,
      property_name: propertyName, viewing_report: report, viewing_report_at: nowIso,
      notes: "内覧後の挨拶で内覧の内容を記録（内覧の予定の記録なし）",
    }).select("id").single();
    if (insErr || !ins?.id) return { ok: false, error: insErr?.message ?? "insert failed" };
    id = ins.id as string;
    created = true;
  }
  // 未来の予定が無ければ、この内覧をその会話の主な内覧にする（次の内覧の予定がある時はそちらのまま）
  const hasFuture = ((data ?? []) as Row[]).some((r) => r.scheduled_date > today && r.status === "scheduled");
  if (!hasFuture) {
    await supabase.from("viewing_history").update({ is_primary: false }).eq("conversation_id", o.conversationId).neq("id", id);
    await supabase.from("viewing_history").update({ is_primary: true }).eq("id", id);
  }
  console.log(JSON.stringify({ tag: "viewing:report-recorded", conversationId: o.conversationId, viewedOn, created, chars: report.length }));
  return { ok: true, id, created, viewedOn };
}

/** 内覧の内容（新しい順） */
export async function loadViewingReports(conversationId: string, limit = 3): Promise<ViewingReport[]> {
  try {
    const { data, error } = await supabase.from("viewing_history")
      .select("scheduled_date, actual_date, property_name, viewing_report, viewing_report_at")
      .eq("conversation_id", conversationId).not("viewing_report", "is", null)
      .order("viewing_report_at", { ascending: false }).limit(limit);
    if (error) { console.warn("[viewing-report] load failed:", error.message); return []; }
    return ((data ?? []) as Array<{ scheduled_date: string; actual_date: string | null; property_name: string | null; viewing_report: string | null; viewing_report_at: string | null }>)
      .filter((r) => r.viewing_report && r.viewing_report_at)
      .map((r) => ({ viewedOn: r.actual_date ?? r.scheduled_date, propertyName: r.property_name, report: r.viewing_report as string, reportedAt: r.viewing_report_at as string }));
  } catch { return []; }
}
