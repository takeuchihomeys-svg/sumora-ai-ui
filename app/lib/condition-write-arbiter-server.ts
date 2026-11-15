// app/lib/condition-write-arbiter-server.ts
// condition-write-arbiter.ts の DB の口（直前の履歴と根拠の発言の時刻を読む）。読むのは1人の直近6時間の履歴だけ（軽い）。
// スイッチ CONDITION_WRITE_ARBITER=off（既定）|shadow|on。off の時は DB を読まずにそのまま返す。
import type { SupabaseClient } from "@supabase/supabase-js";
import { arbitrateConditionUpdates, conditionWriteArbiterMode, REVERT_WINDOW_MS, type HistoryRowLike } from "./condition-write-arbiter";

export async function applyConditionWriteArbiter(
  db: SupabaseClient,
  args: { customerId: string; writer: string; messageId?: string | null; current: Record<string, unknown> | null; updates: Record<string, unknown>; convId?: string | null },
): Promise<Record<string, unknown>> {
  const mode = conditionWriteArbiterMode();
  if (mode === "off" || !args.customerId || Object.keys(args.updates).length === 0) return args.updates;
  try {
    const now = new Date();
    const { data: hist } = await db.from("property_condition_history")
      .select("changed_field, old_value, new_value, source_message_id, created_at")
      .eq("property_customer_id", args.customerId)
      .gte("created_at", new Date(now.getTime() - REVERT_WINDOW_MS).toISOString())
      .order("created_at", { ascending: false }).limit(60);
    const rows = (hist ?? []) as HistoryRowLike[];
    if (!rows.length) return args.updates;
    const ids = [...new Set([args.messageId ?? "", ...rows.map((r) => String(r.source_message_id ?? "").split(":")[1] ?? "")].filter((x) => /^[0-9a-f-]{36}$/i.test(x)))];
    const at = new Map<string, string>();
    if (ids.length) {
      const { data: ms } = await db.from("messages").select("id, created_at").in("id", ids);
      for (const m of (ms ?? []) as Array<{ id: string; created_at: string }>) at.set(String(m.id), String(m.created_at));
    }
    const r = arbitrateConditionUpdates({
      mode, writer: args.writer, now: now.toISOString(), messageId: args.messageId ?? null, messageAt: args.messageId ? at.get(args.messageId) ?? null : null,
      current: args.current, updates: args.updates, history: rows, messageAtOf: (id) => at.get(id),
    });
    if (r.skipped.length) {
      // 止めた欄＝「条件の更新の案」（画面に出すのは aix_feature_suggestions の案が通ってから）
      console.log(JSON.stringify({
        tag: mode === "on" ? "condition-arbiter:skip" : "condition-arbiter:shadow", convId: args.convId ?? null, customerId: args.customerId, writer: args.writer,
        fields: r.skipped.map((s) => ({ field: s.field, against: s.against?.writer, proposed: String(args.updates[s.field] ?? "").slice(0, 60) })),
      }));
    }
    return r.updates;
  } catch (e) {
    console.warn("[condition-arbiter]", e instanceof Error ? e.message : e);
    return args.updates;
  }
}
