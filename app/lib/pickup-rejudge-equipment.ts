// app/lib/pickup-rejudge-equipment.ts — お客様の条件（設備の希望）が判定の後に変わった時、送る前の候補（pending）だけ設備の照合を付け直す（決定論・LLM なし）
//
// 2026-11-21 作業員K2（台帳 #476・統括役の決め）: 30日の候補の行で、条件に設備の希望があるのに判定の札（EQUIP_*）が付いていない 19行のうち 18行は、
//   判定の後にお客様の条件が更新された番だった（判定した時は条件の欄にその希望が無かった）＝配線の切れではなく「判定の古さ」。
//   直し: 送る前の候補（status=pending・sent_at なし）だけ、保存した資料の文字（pdf_text）から設備の照合を作り直し、
//   property-brain.applyEquipmentMatch（保存済みの判定に設備欄の照合を付け直す既存の純関数・2026-09-24〜）で点・判定・理由を付け直す。
//   送った行は触らない。同じ回の行（落とした部屋は保存に無いので回の中の行だけ）で建物の補いをする。
// 付け直すかの線（純関数 needsEquipRejudge）: 保存した設備の照合の希望の組（key・mode・strong）と、今の条件から読んだ希望の組が違う時だけ
//   （条件の更新が要約・他の欄だけの時は動かない）。
// ■ スイッチ PICKUP_REJUDGE_ON_COND: 既定 off（読まない・書かない）／on（/api/property-pickups の一覧を読む時に、その時の候補の会話のお客様ごとに付け直す）
// 確かめ: scripts/audit-pickup-stale-judgment.ts（条件の更新より古い判定の pending の数・on の後に 0 になるか）
// テスト: app/lib/__tests__/pickup-rejudge-equipment.test.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseEquipmentWants, type CustomerConditionsLike, type EquipmentWant } from "./listing-equipment";

type Env = Record<string, string | undefined>;
export function pickupRejudgeOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return String(env.PICKUP_REJUDGE_ON_COND ?? "").trim().toLowerCase() === "on";
}

const wantKey = (w: { key?: unknown; mode?: unknown; strong?: unknown }) => `${String(w.key)}:${String(w.mode ?? "must")}:${w.strong ? 1 : 0}`;
/** 保存した設備の照合（property_pickups.equipment.match）の希望の組 */
export function savedWantKeys(equipment: unknown): Set<string> {
  const m = equipment && typeof equipment === "object" ? (equipment as { match?: unknown }).match : null;
  return new Set((Array.isArray(m) ? m : []).filter((x) => x && typeof x === "object").map((x) => wantKey(x as Record<string, unknown>)));
}
export function currentWantKeys(wants: ReadonlyArray<EquipmentWant>): Set<string> {
  return new Set(wants.map((w) => wantKey(w)));
}
/** 付け直すか（希望の組が違う時だけ） */
export function needsEquipRejudge(equipment: unknown, wants: ReadonlyArray<EquipmentWant>): boolean {
  const a = savedWantKeys(equipment), b = currentWantKeys(wants);
  if (a.size !== b.size) return true;
  for (const k of b) if (!a.has(k)) return true;
  return false;
}

type PendRow = { id: number; batch_id: string; pdf_text: string | null; reason_codes: string[] | null; equipment: unknown; status: string | null; sent_at: string | null; image_facts?: unknown };
/** 1人のお客様の送る前の候補を付け直す（書いた行の数を返す）。失敗は飲み込んで 0 */
export async function rejudgePendingEquipment(sb: SupabaseClient, propertyCustomerId: string, opts: { days?: number; maxRows?: number } = {}): Promise<{ checked: number; rejudged: number }> {
  try {
    const { data: pc } = await sb.from("property_customers").select("preferences, ng_points, other_requests, additional_conditions, structure_types").eq("id", propertyCustomerId).maybeSingle();
    if (!pc) return { checked: 0, rejudged: 0 };
    const wants = parseEquipmentWants(pc as CustomerConditionsLike).wants;
    const since = new Date(Date.now() - (opts.days ?? 14) * 864e5).toISOString();
    const { data: rows } = await sb.from("property_pickups").select("id, batch_id, pdf_text, reason_codes, equipment, status, sent_at, image_facts")
      .eq("property_customer_id", propertyCustomerId).gte("created_at", since).limit(opts.maxRows ?? 200);
    const all = (rows ?? []) as PendRow[];
    // 2026-11-21 作業員K2（COUNTER_KITCHEN_IMAGE_JUDGE=on の時だけ・counter-kitchen-image-judge.ts）: カウンターキッチンが記載なしの札の行に、作業員G の画像の読みが入っていれば付け直す
    const ck = await import("./counter-kitchen-image-judge");
    const ckOn = ck.counterKitchenImageJudgeOn();
    const ckPending = (r: PendRow) => ckOn && ck.counterKitchenImageValue(r.image_facts) != null && (r.reason_codes ?? []).some((c) => /^EQUIP_COUNTER_KITCHEN_.*UNLISTED$/.test(c));
    const stale = all.filter((r) => r.status === "pending" && !r.sent_at && ((pickupRejudgeOn() && needsEquipRejudge(r.equipment, wants)) || ckPending(r)));
    if (!stale.length) return { checked: all.length, rejudged: 0 };
    const { buildBatchEquipment } = await import("./pickup-equipment");
    const { applyEquipmentMatch } = await import("./property-brain");
    const { prefWeightForCustomer } = await import("./customer-pref-learning-server");
    const prefW = await prefWeightForCustomer(sb, propertyCustomerId);
    let rejudged = 0;
    const batches = [...new Set(stale.map((r) => r.batch_id))];
    for (const b of batches) {
      const inBatch = all.filter((r) => r.batch_id === b);
      const eq = buildBatchEquipment(inBatch.map((r) => ({ key: r.id, pdfText: r.pdf_text, label: `#${r.id}` })), pc as CustomerConditionsLike);
      const byId = new Map(eq.rows.map((x) => [Number(x.key), x]));
      for (const r of stale.filter((x) => x.batch_id === b)) {
        const e = byId.get(r.id);
        if (!e) continue;
        const match = (ckOn ? ck.applyCounterKitchenImage(e.match, ck.counterKitchenImageValue(r.image_facts)) : null) ?? e.match;
        const j = applyEquipmentMatch({ reasonCodes: r.reason_codes ?? [] }, match, prefW);
        const { error } = await sb.from("property_pickups").update({
          score: j.score, verdict: j.verdict, reason_codes: j.reasonCodes, reasons_ja: j.reasonsJa,
          equipment: { ...(e.saved as unknown as Record<string, unknown>), rejudgedAt: new Date().toISOString(), rejudgedBy: "pickup-rejudge-equipment" },
        }).eq("id", r.id).eq("status", "pending");
        if (!error) rejudged++;
      }
    }
    console.log(JSON.stringify({ tag: "pickup:rejudge-equipment", propertyCustomerId, checked: all.length, stale: stale.length, rejudged }));
    return { checked: all.length, rejudged };
  } catch (e) {
    console.warn("[pickup-rejudge-equipment]", e instanceof Error ? e.message : String(e));
    return { checked: 0, rejudged: 0 };
  }
}
