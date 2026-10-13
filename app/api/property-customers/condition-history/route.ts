// app/api/property-customers/condition-history/route.ts — 会話画面の「条件の更新」の履歴（日時付き・新しい順）と、行ごとの「確認済み」
// 2026-10-13 竹内さん（未桜）「ブレイン自動反映のところも大きくて枠を取りすぎている。ちゃんと折りたたんで、更新があった時に日時を入れて記憶していけば見やすい」
//   GET  ?id=<property_customers.id> → { groups: ConditionHistoryGroup[] }（property_condition_history を束にまとめる・condition-restore.groupConditionHistory）
//   POST { id, group } → その束を確認済みに（property_condition_history.confirmed_at）。一番新しい束なら今までの「確認済み」と同じく additional_conditions を空にする
//   ⚠ confirmed_at の列は migrate-schema に足した（本番の DDL は未実行の可能性）＝列が無くても読める・確認は additional_conditions を空にするだけで続ける
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { groupConditionHistory, RESTORE_FIELDS, type RestoreHistoryRow } from "@/app/lib/condition-restore";

export const dynamic = "force-dynamic";
const ID_RE = /^[0-9a-f-]{36}$/i;
type Row = RestoreHistoryRow & { id: string; confirmed_at?: string | null };

async function loadHistory(id: string): Promise<{ rows: Row[]; hasConfirmCol: boolean }> {
  const base = "id, changed_field, old_value, new_value, created_at, source_message_id";
  const q = (cols: string) => supabase.from("property_condition_history").select(cols).eq("property_customer_id", id).order("created_at", { ascending: false }).limit(300);
  const r1 = await q(`${base}, confirmed_at`);
  if (!r1.error) return { rows: (r1.data ?? []) as unknown as Row[], hasConfirmCol: true };
  const r2 = await q(base);
  if (r2.error) throw new Error(r2.error.message);
  return { rows: (r2.data ?? []) as unknown as Row[], hasConfirmCol: false };
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!ID_RE.test(id)) return NextResponse.json({ error: "id is required" }, { status: 400 });
  try {
    const [{ rows, hasConfirmCol }, { data: cur }] = await Promise.all([
      loadHistory(id),
      supabase.from("property_customers").select(RESTORE_FIELDS.join(",")).eq("id", id).maybeSingle(),
    ]);
    return NextResponse.json({ groups: groupConditionHistory(rows, (cur ?? null) as Record<string, unknown> | null, { max: 20 }), persisted: hasConfirmCol });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e), groups: [] }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { id?: string; group?: string };
  const id = typeof body.id === "string" ? body.id : "";
  const group = typeof body.group === "string" ? body.group : "";
  if (!ID_RE.test(id) || !group) return NextResponse.json({ error: "id and group are required" }, { status: 400 });
  try {
    const { rows, hasConfirmCol } = await loadHistory(id);
    const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const i = group.indexOf("|");
    const at = Date.parse(group.slice(0, i)), src = group.slice(i + 1);
    const ids = sorted.filter((r) => String(r.source_message_id ?? "") === src && Math.abs(Date.parse(r.created_at) - at) <= 120_000).map((r) => r.id);
    if (hasConfirmCol && ids.length) {
      const { error } = await supabase.from("property_condition_history").update({ confirmed_at: new Date().toISOString() }).in("id", ids);
      if (error) console.warn("[condition-history] confirm:", error.message);
    }
    // 一番新しい束を確認した＝今までの帯の「確認済み」と同じ（additional_conditions を空にする）
    const newest = sorted[sorted.length - 1];
    const isNewest = !newest || ids.includes(newest.id);
    if (isNewest) {
      const { error } = await supabase.from("property_customers").update({ additional_conditions: null }).eq("id", id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, confirmed: ids.length, clearedNotice: isNewest, persisted: hasConfirmCol });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
