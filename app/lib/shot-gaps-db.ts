/**
 * 写真の学習の抜けを DB から件数だけで数える（統括Pro 用）。
 *
 * ★ 2026-11-19 竹内さん「統括pro徹底的に改善」:
 *   本番の束（main のコードで作る）には `shot_gaps` / `shot_gaps_normal` が無く、
 *   束を読む統括Pro は学べ済みを常に 0 と数えて「写真はあるが学べ済み0（flash未実行）」と誤判定していた。
 *   束に無い時はここで DB から数えて補う。
 *
 * ⚠ 営業時間でも重くならないよう、行の中身は読まず `count: exact, head: true` だけで数える。
 *   数え方は `summarizeShotGaps` と同じ（大きい＝800px 以上・欄0は「学べたが空」）。
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type ShotGapsCounts = {
  total: number;
  unlearnedBig: number;
  unlearnedSmall: number;
  learnedButEmpty: number;
  learnedOk: number;
  todo: number;
};

type Filter = (q: any) => any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function countRows(sb: SupabaseClient, base: Filter, extra: Filter): Promise<number> {
  const q = extra(base(sb.from("human_motion_learn").select("id", { count: "exact", head: true })));
  const r = await q;
  if (r.error) throw new Error(String(r.error.message || r.error).slice(0, 160));
  return Number(r.count) || 0;
}

/** 件数から抜けのまとめを作る（純関数） */
export function shotGapsFromCounts(c: {
  total: number;
  learned: number;
  learnedWithFields: number;
  unlearnedBig: number;
}): ShotGapsCounts | null {
  const total = Math.max(0, c.total);
  if (!total) return null;
  const learned = Math.min(total, Math.max(0, c.learned));
  const learnedOk = Math.min(learned, Math.max(0, c.learnedWithFields));
  const learnedButEmpty = learned - learnedOk;
  const unlearned = total - learned;
  const unlearnedBig = Math.min(unlearned, Math.max(0, c.unlearnedBig));
  const unlearnedSmall = unlearned - unlearnedBig;
  return { total, unlearnedBig, unlearnedSmall, learnedButEmpty, learnedOk, todo: unlearnedBig + learnedButEmpty };
}

/**
 * site（realpro / itandi / all）と期間で、全モード・通常だけの抜けを数える。
 */
export async function shotGapsFromDb(
  sb: SupabaseClient,
  opts: { site: string; sinceIso: string },
): Promise<{ shot_gaps: ShotGapsCounts | null; shot_gaps_normal: ShotGapsCounts | null }> {
  const base: Filter = (q) => {
    let x = q.gte("created_at", opts.sinceIso).not("shot_key", "is", null);
    if (opts.site && opts.site !== "all") x = x.eq("site", opts.site);
    return x;
  };
  const normal: Filter = (q) => q.or("mode.is.null,mode.not.in.(aix,auto)");
  const all: Filter = (q) => q;

  const one = async (mode: Filter) => {
    const b: Filter = (q) => mode(base(q));
    const [total, learned, learnedWithFields, unlearnedBig] = await Promise.all([
      countRows(sb, b, (q) => q),
      countRows(sb, b, (q) => q.not("shot_learn", "is", null)),
      countRows(sb, b, (q) => q.not("shot_learn", "is", null).not("shot_learn->fields->0", "is", null)),
      countRows(sb, b, (q) => q.is("shot_learn", null).gte("shot_w", 800)),
    ]);
    return shotGapsFromCounts({ total, learned, learnedWithFields, unlearnedBig });
  };

  const [shot_gaps, shot_gaps_normal] = await Promise.all([one(all), one(normal)]);
  return { shot_gaps, shot_gaps_normal };
}
