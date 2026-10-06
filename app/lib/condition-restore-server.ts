// app/lib/condition-restore-server.ts — 条件を「元に戻す」（LINE の「やっぱり元々の条件で」・画面の「元に戻す」）の DB 側。決め方は condition-restore.ts（純関数）
//
// 2026-10-06 ⑫ 竹内さん（R）「やっぱり元々の条件で等きたばあいは、もともとの条件に戻すなどLINEにしたがって物件検索の条件も変動するように」
//   戻す元は property_condition_history（列ごとの old/new）。戻した事も履歴に残す（書き手 restore／undo）＝もう一度戻せる。
//   画面の帯（additional_conditions の auto 行）に「条件を元に戻しました: …」を出す。
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordConditionHistory, conditionSourceTag } from "@/app/lib/condition-history";
import { planConditionRestore, planUndoLatestChange, RESTORE_FIELDS, type RevertCue, type RestoreHistoryRow, type RestorePlan } from "@/app/lib/condition-restore";

const LABEL: Record<string, string> = {
  desired_area: "エリア", floor_plan: "間取り", rent_max: "家賃上限", rent_min: "家賃下限", floor_area_min: "広さ(㎡以上)", walk_minutes: "徒歩分数", building_age: "築年数",
};
const jstStamp = () => {
  const j = new Date(Date.now() + 9 * 3600_000);
  return `${j.getUTCMonth() + 1}/${j.getUTCDate()} ${String(j.getUTCHours()).padStart(2, "0")}:${String(j.getUTCMinutes()).padStart(2, "0")}`;
};

async function applyPlan(
  db: SupabaseClient,
  pcId: string,
  current: Record<string, unknown>,
  plan: RestorePlan,
  writer: "restore" | "undo",
  messageId: string | null,
  inferAreaMode?: (area: string) => Promise<"station" | "ward" | "auto">,
): Promise<{ changed: Record<string, unknown>; line: string | null; error?: string }> {
  if (!Object.keys(plan.updates).length) return { changed: {}, line: null };
  const line = `[${jstStamp()}|auto] 条件を元に戻しました: ${Object.entries(plan.updates).map(([f, v]) => `${LABEL[f] ?? f} ${String(current[f] ?? "（空）")}→${String(v)}`).join("、")}`;
  const prevAdd = (current.additional_conditions as string | null) ?? "";
  const extra: Record<string, unknown> = { additional_conditions: prevAdd ? `${prevAdd}\n${line}` : line };
  if (typeof plan.updates.desired_area === "string" && inferAreaMode) {
    const mode = await inferAreaMode(plan.updates.desired_area).catch(() => "auto" as const);
    if (mode !== "auto") extra.area_mode = mode;
  }
  const { error } = await db.from("property_customers").update({ ...plan.updates, ...extra, updated_at: new Date().toISOString() }).eq("id", pcId);
  if (error) return { changed: {}, line: null, error: error.message };
  await recordConditionHistory(db, pcId, current, plan.updates, conditionSourceTag(writer, messageId));
  return { changed: plan.updates, line };
}

async function loadRowAndHistory(db: SupabaseClient, pcId: string) {
  const cols = [...RESTORE_FIELDS, "additional_conditions"].join(",");
  const [{ data: row }, { data: hist }] = await Promise.all([
    db.from("property_customers").select(cols).eq("id", pcId).maybeSingle(),
    db.from("property_condition_history").select("changed_field, old_value, new_value, created_at, source_message_id")
      .eq("property_customer_id", pcId).in("changed_field", [...RESTORE_FIELDS]).order("created_at", { ascending: true }).limit(500),
  ]);
  return { row: (row ?? null) as Record<string, unknown> | null, hist: (hist ?? []) as RestoreHistoryRow[] };
}

/** LINE の「やっぱり元々の条件で」: 会話の紐付け先の条件を戻す */
export async function restoreConditionsFromLine(
  db: SupabaseClient,
  convId: string,
  cue: RevertCue,
  messageId: string | null,
  inferAreaMode?: (area: string) => Promise<"station" | "ward" | "auto">,
): Promise<{ pcId: string | null; plan: RestorePlan | null; changed: Record<string, unknown>; error?: string }> {
  const { data: conv } = await db.from("conversations").select("property_customer_id").eq("id", convId).maybeSingle();
  const pcId = (conv?.property_customer_id as string | null | undefined) ?? null;
  if (!pcId) return { pcId: null, plan: null, changed: {} };
  const { row, hist } = await loadRowAndHistory(db, pcId);
  if (!row) return { pcId, plan: null, changed: {} };
  const plan = planConditionRestore(hist, row, cue);
  const res = await applyPlan(db, pcId, row, plan, "restore", messageId, inferAreaMode);
  console.log(JSON.stringify({ tag: "condition-restore:line", convId, pcId, kind: cue.kind, evidence: cue.evidence, changed: res.changed, skipped: plan.skipped, error: res.error ?? null }));
  return { pcId, plan, changed: res.changed, error: res.error };
}

/** 画面の「元に戻す」: 一番新しい変更の束を取り消す */
export async function undoLatestConditionChange(
  db: SupabaseClient,
  pcId: string,
  inferAreaMode?: (area: string) => Promise<"station" | "ward" | "auto">,
): Promise<{ plan: RestorePlan; changed: Record<string, unknown>; error?: string }> {
  const { row, hist } = await loadRowAndHistory(db, pcId);
  if (!row) return { plan: { updates: {}, skipped: ["顧客が見つからない"], target: {} }, changed: {} };
  const plan = planUndoLatestChange(hist, row);
  const res = await applyPlan(db, pcId, row, plan, "undo", null, inferAreaMode);
  console.log(JSON.stringify({ tag: "condition-restore:undo", pcId, changed: res.changed, skipped: plan.skipped, error: res.error ?? null }));
  return { plan, changed: res.changed, error: res.error };
}
