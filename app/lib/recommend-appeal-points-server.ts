// app/lib/recommend-appeal-points-server.ts（サーバー専用・読むだけ）— AIX 物件オススメ（🌟）の訴求の材料を集めて注記にする
//   物件の事実: 売上サポの行（summary_text・pdf_text・terms・equipment）→ recommendation-snapshot-server.factsFromPickup／savedFactsFromPickup
//   お客様の希望: property_customers の条件欄＋画面が渡したお客様の発言（recommendation-gaps.customerWants）
//   広げた軸: 判定の札（reason_codes）。作り方は recommend-appeal-points.ts（純）
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildAppealPoints, buildAppealPointsNote, recommendAppealPointsEnabled, type AppealPoints } from "@/app/lib/recommend-appeal-points";
import { customerWants } from "@/app/lib/recommendation-gaps";
import type { CandidateFacts } from "@/app/lib/candidate-facts";

export type AppealPickupRow = { summary_text: string | null; pdf_text: string | null; terms?: unknown; reason_codes?: string[] | null; room_no?: string | null; equipment?: unknown };

export async function loadRecommendAppealNote(
  db: SupabaseClient,
  input: { row: AppealPickupRow | null; propertyCustomerId: string | null | undefined; recentMessages?: unknown },
): Promise<{ note: string; points: AppealPoints | null }> {
  if (!recommendAppealPointsEnabled() || !input.row) return { note: "", points: null };
  try {
    const { factsFromPickup, savedFactsFromPickup } = await import("@/app/lib/recommendation-snapshot-server");
    const facts = { ...factsFromPickup(input.row as never), ...savedFactsFromPickup(input.row as never) } as CandidateFacts;
    let pc: Record<string, any> | null = null;
    if (input.propertyCustomerId) {
      const { data } = await db.from("property_customers").select("rent_max, floor_plan, walk_minutes, building_age, initial_cost_limit, pet, move_in_time, floor_area_min, preferences, ng_points, other_requests, additional_conditions").eq("id", input.propertyCustomerId).maybeSingle();
      pc = (data as Record<string, any> | null) ?? null;
    }
    const msgs = Array.isArray(input.recentMessages)
      ? (input.recentMessages as Array<{ sender?: string | null; role?: string | null; text?: string | null; content?: string | null }>)
        .filter((m) => m && (m.sender === "customer" || m.role === "customer" || m.role === "user")).map((m) => String(m.text ?? m.content ?? ""))
      : [];
    const wants = customerWants({ conditions: pc as never, messages: msgs });
    const points = buildAppealPoints(facts, wants, { rentMax: pc?.rent_max ?? null, walkMax: pc?.walk_minutes ?? null, ageMax: pc?.building_age ?? null, sqmMin: pc?.floor_area_min ?? null }, { reasonCodes: input.row.reason_codes ?? null });
    return { note: buildAppealPointsNote(points), points };
  } catch (e) {
    console.warn("[recommend-appeal-points] 材料を作れない（画像だけで続ける）:", e instanceof Error ? e.message : String(e));
    return { note: "", points: null };
  }
}
