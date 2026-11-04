// app/lib/conductor-weights.ts — 入口の統括の重みの表（conductor_weights）に入れる行を作る（作業員1・11/04・純関数）
//   元: 作業員2の竹内さんの合い方の表（.claude/exam-cache/takeuchi-fit/table-YYYYMMDD.json・竹内さん本人の番だけ・場面ごとの n とブレインの比率）。
//   決まり（統括役 11/04）: 件数が足りる場面（few=false・n>=20）だけ・basis='takeuchi'・source='record'・decides=false（統括は意見を出すだけの段・重みを読む側は shadow）。
//   weight＝その場面でのブレインの比率（pct/100）。hit（竹内さんと合った率）はこの表には無い＝NULL（当たりの数えは別の口で埋める）

export type FitTable = { date: string; rows: Array<{ id: string; scene: string; n: number; few: boolean; brains: Array<{ brain: string; pct: number }> }> };
export type ConductorWeightRow = {
  scene: string; brain: string; answer_kind: string; basis: "takeuchi"; weight: number; n: number; hit: number | null;
  source: "record"; kb_id: string | null; decides: false;
};
const BRAINS = new Set(["judge", "todo", "aix", "property_search", "estimate", "viewing", "compose"]);
export const WEIGHT_MIN_N = 20;

export function weightsFromFitTable(t: FitTable): { rows: ConductorWeightRow[]; skipped: string[] } {
  const rows: ConductorWeightRow[] = [], skipped: string[] = [];
  for (const r of t.rows) {
    if (r.few || r.n < WEIGHT_MIN_N) { skipped.push(`${r.scene}（${r.n}件・少ない）`); continue; }
    for (const b of r.brains) {
      if (!BRAINS.has(b.brain)) { skipped.push(`${r.scene}.${b.brain}（知らないブレイン）`); continue; }
      const w = Math.round(Math.min(100, Math.max(0, b.pct))) / 100;
      rows.push({ scene: r.scene, brain: b.brain, answer_kind: "*", basis: "takeuchi", weight: w, n: r.n, hit: null, source: "record", kb_id: null, decides: false });
    }
  }
  return { rows, skipped };
}

/** サーバーの鍵が無い時に流す SQL（値は数と決まった言葉だけ・会話の文は無い） */
export function weightsUpsertSql(rows: ReadonlyArray<ConductorWeightRow>): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const vals = rows.map((r) => `(${q(r.scene)}, ${q(r.brain)}, ${q(r.answer_kind)}, 'takeuchi', ${r.weight}, ${r.n}, NULL, 'record', NULL, false, now())`).join(",\n  ");
  return `INSERT INTO conductor_weights (scene, brain, answer_kind, basis, weight, n, hit, source, kb_id, decides, updated_at) VALUES\n  ${vals}\nON CONFLICT (scene, brain, answer_kind, basis) DO UPDATE SET weight = EXCLUDED.weight, n = EXCLUDED.n, source = EXCLUDED.source, updated_at = now()\n  WHERE conductor_weights.decides = false AND conductor_weights.source = 'record';`;
}
