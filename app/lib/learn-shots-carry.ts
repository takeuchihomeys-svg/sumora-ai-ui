/**
 * 束の作り直しで「写真で学んだ位置」（shots.learned）を消さない。
 *
 *   2026-11-19 タクヤ audit #1513（learn_warm screen=0）の実測:
 *   本番の作り直し（#2413〜#2420）は shots に total / with_ops しか持たず、
 *   直前の束（#2412・902位置）の learned を落としていた → 拡張の画面位置が空になる。
 *   → 新しい束に learned が無い時だけ、**同じ scope** の直近の束から learned / learned_scene を継ぐ。
 *     ⚠ 別の scope（all ↔ realpro ↔ itandi）からは継がない（サイトを混ぜない・竹内さん「１は危ない」）。
 *   → 版の確認（touch=0）が束の本体を読まずに数だけ返せるよう、束の一番上に screen_solid / screen_positions を置く。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { sanitizeLearnedForSite } from "./human-motion-sanitize";

type LearnedMap = Record<string, unknown[]>;

export const CARRY_LOOKBACK = 30;

function asLearned(v: unknown): LearnedMap | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: LearnedMap = {};
  for (const [k, list] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(list) && list.length) out[k] = list;
  }
  return Object.keys(out).length ? out : null;
}

/** x,y を持つ位置の数と、そのうち n≥3（確かな位置）の数 */
export function countLearnedPositions(learned: unknown): { positions: number; solid: number } {
  let positions = 0, solid = 0;
  const m = asLearned(learned);
  if (!m) return { positions, solid };
  for (const list of Object.values(m)) {
    for (const f of list) {
      const rec = f as { x?: unknown; y?: unknown; n?: unknown };
      if (typeof rec?.x !== "number" || typeof rec?.y !== "number") continue;
      positions++;
      if ((Number(rec.n) || 0) >= 3) solid++;
    }
  }
  return { positions, solid };
}

export type CarryResult = { carried: boolean; from_id: number | null; positions: number; solid: number; why: string };

/**
 * bundle を書き換える（insert の直前に呼ぶ）。失敗しても束はそのまま書ける（位置が無いだけ）。
 * 読むのは id の一覧（軽い）と、1行ずつの shots.learned だけ（束の本体は読まない）。
 */
export async function carryLearnedShots(
  sb: SupabaseClient,
  scope: string,
  bundle: unknown,
  lookback = CARRY_LOOKBACK,
): Promise<CarryResult> {
  const b = bundle as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return { carried: false, from_id: null, positions: 0, solid: 0, why: "no_bundle" };
  const shots = (b.shots && typeof b.shots === "object" ? b.shots : {}) as Record<string, unknown>;
  const stamp = (c: { positions: number; solid: number }) => {
    b.screen_solid = c.solid;
    b.screen_positions = c.positions;
  };
  const siteFilter = (scope === "realpro" || scope === "itandi") ? scope : null;
  const ownRaw = asLearned(shots.learned);
  const own = ownRaw ? asLearned(sanitizeLearnedForSite(ownRaw, siteFilter).learned) : null;
  if (own) {
    shots.learned = own;
    const c = countLearnedPositions(own);
    stamp(c);
    return { carried: false, from_id: null, ...c, why: "own" };
  }
  try {
    const ids = await sb.from("human_learn_profile")
      .select("id").eq("scope", scope)
      .order("id", { ascending: false })
      .limit(Math.max(1, Math.min(60, lookback)));
    if (ids.error) { stamp({ positions: 0, solid: 0 }); return { carried: false, from_id: null, positions: 0, solid: 0, why: "ids_error:" + ids.error.message.slice(0, 80) }; }
    for (const r of (ids.data ?? []) as Array<{ id: number }>) {
      const q = await sb.from("human_learn_profile")
        .select("learned:bundle->shots->learned, learned_scene:bundle->shots->learned_scene")
        .eq("id", r.id).limit(1);
      if (q.error) continue;
      const row = ((q.data ?? [])[0] ?? null) as { learned?: unknown; learned_scene?: unknown } | null;
      const gotRaw = asLearned(row?.learned);
      if (!gotRaw) continue;
      // ★ 2026-11-27: 過去の汚染束（例: #2514）から他サイト・ゴミを継がないよう引き継ぎ時点で浄化する
      const got = asLearned(sanitizeLearnedForSite(gotRaw, siteFilter).learned);
      if (!got) continue;
      const next: Record<string, unknown> = { ...shots, learned: got, carried_from: r.id };
      const scRaw = asLearned(row?.learned_scene);
      const scClean = scRaw ? asLearned(sanitizeLearnedForSite(scRaw, siteFilter).learned) : null;
      if (scClean) next.learned_scene = scClean;
      b.shots = next;
      const c = countLearnedPositions(got);
      stamp(c);
      return { carried: true, from_id: r.id, ...c, why: "carried" };
    }
    stamp({ positions: 0, solid: 0 });
    return { carried: false, from_id: null, positions: 0, solid: 0, why: "none_in_history" };
  } catch (e) {
    stamp({ positions: 0, solid: 0 });
    return { carried: false, from_id: null, positions: 0, solid: 0, why: "error:" + String((e as Error)?.message || e).slice(0, 80) };
  }
}
