// app/lib/room-jo-server.ts（サーバー専用・DB。画面側から import しない）
// 「🔍 画像で分析」（ボタン・届いた時の自動）で間取り図が読めた後に、判定の「要確認: 洋室の帖数」（ROOM_JO_UNKNOWN）を付け直す。
//
// 2026-09-27 竹内「7畳以上は、帖数が資料に書かれていなかったら間取り図から読み取る」:
//   判定（property-pickups-server の judgeProperty）の時に資料の文字で帖数が読めなかった物件は ROOM_JO_UNKNOWN（0点の要確認）で入る。
//   間取り図の読み取り（sheet-read-server・DeepSeek・物件ごとに保存）は rooms の帖数を前から読んでいる → 新しい LLM 呼び出しは足さず、
//   読めた帖数で札・点・判定（7帖未満＝外す候補）を付け直す。図は資料と一致した時（review ok）だけ使う
import { supabase } from "@/app/lib/supabase";
import { applyRoomJoToRow, roomJoWantOfCustomer, reasonJa, type CustomerLike } from "@/app/lib/property-brain";
import { roomJoOfSheet, parseSummaryFacts } from "@/app/lib/sheet-facts";
import type { SheetReadOutcome } from "@/app/lib/sheet-read-server";
import type { PickupImageAnalysis } from "@/app/lib/pickup-image-analysis";

const CUSTOMER_COLS = "preferences, other_requests, additional_conditions, floor_plan, layout, raw_format_text";

/** 分析の結果から、その行の洋室の帖数の札を付け直して保存する。付け直さない時は null（失敗しても投げない） */
export async function applyRoomJoAfterAnalysis(
  rowId: number,
  res: { analysis: PickupImageAnalysis | null; facts: SheetReadOutcome },
  summaryText: string | null,
): Promise<{ result: "ok" | "ng"; jo: number; from: string; verdict: string } | null> {
  try {
    const got = roomJoOfSheet(res.facts.text, res.facts.image, res.analysis?.review?.status === "ok", parseSummaryFacts(summaryText).madori);
    if (!got) return null;
    const { data, error } = await supabase.from("property_pickups").select("id, reason_codes, reasons_ja, score, verdict, property_customer_id").eq("id", rowId).limit(1);
    if (error) { console.warn("[room-jo] 行を引けない:", error.message); return null; }
    const row = (data ?? [])[0] as { reason_codes: string[] | null; reasons_ja: string[] | null; score: number | null; verdict: string | null; property_customer_id: string | null } | undefined;
    if (!row || !row.property_customer_id || !(row.reason_codes ?? []).includes("ROOM_JO_UNKNOWN")) return null;
    const c = await supabase.from("property_customers").select(CUSTOMER_COLS).eq("id", row.property_customer_id).limit(1);
    if (c.error) { console.warn("[room-jo] お客様を引けない:", c.error.message); return null; }
    const want = roomJoWantOfCustomer(((c.data ?? [])[0] ?? {}) as CustomerLike);
    const r = applyRoomJoToRow(row, want, got.jo, got.from);
    if (!r) return null;
    // 札から作れない一文（同じ建物の省略の知らせ等・先頭に付く）は残す
    const derived = new Set((row.reason_codes ?? []).map(reasonJa));
    const extra = (row.reasons_ja ?? []).filter((x) => !derived.has(x));
    const { error: uErr } = await supabase.from("property_pickups")
      .update({ reason_codes: r.reason_codes, reasons_ja: [...extra, ...r.reasons_ja], score: r.score, verdict: r.verdict })
      .eq("id", rowId).contains("reason_codes", ["ROOM_JO_UNKNOWN"]);
    if (uErr) { console.warn("[room-jo] 保存できない:", uErr.message); return null; }
    console.log(JSON.stringify({ tag: "property-pickups:room-jo", id: rowId, jo: got.jo, from: got.from, want: want?.jo ?? null, result: r.result, verdict: r.verdict, before: row.verdict }));
    return { result: r.result, jo: got.jo, from: got.from, verdict: r.verdict };
  } catch (e) {
    console.warn("[room-jo] 失敗:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
