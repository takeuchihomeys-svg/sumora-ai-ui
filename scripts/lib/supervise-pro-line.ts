// scripts/lib/supervise-pro-line.ts — 統括Pro（作業員G・台帳 #474）の毎日の数を毎朝の1枚の1行に（純関数・作業員N2・2026-11-22・G の頼み）
//
// 読む物: quality_daily の search_found_ok:<site>（土台 F の ✓ の割合）・search_found_critical:<site>（重要欠の数）・search_pro_completion:<site>（自動モード完成度）・
//         search_cause_layer:<型>:<site>（原因の型の数）・search_pro_misjudge（段A の判定の外れ・入り始めたら）。最新の日を、前の日・前の週（7日前）と比べる。
// 直しの候補（持ち主 作業員G）: ✓ の割合・完成度が前の日より下がった／重要欠・判定の外れが前の日より増えた
export type QdRow = { day: string; metric: string; value: number | string | null };

export function superviseProLine(rows: ReadonlyArray<QdRow>, site = "realpro"): { line: string | null; fixes: string[]; day: string | null } {
  const days = [...new Set(rows.map((r) => r.day))].sort();
  const day = days[days.length - 1] ?? null;
  if (!day) return { line: null, fixes: [], day: null };
  const dayMinus = (n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
  const v = (m: string, d: string): number | null => { const r = rows.find((x) => x.day === d && x.metric === m); return r?.value == null ? null : Number(r.value); };
  const cmp = (m: string, digits: number) => {
    const a = v(m, day), b = v(m, dayMinus(1)), c = v(m, dayMinus(7));
    const f = (x: number | null) => (a == null || x == null ? "—" : `${a - x >= 0 ? "+" : ""}${Number((a - x).toFixed(digits))}`);
    return { a, b, text: `${a ?? "—"}（前の日 ${f(b)}・前の週 ${f(c)}）` };
  };
  const ok = cmp(`search_found_ok:${site}`, 3), crit = cmp(`search_found_critical:${site}`, 0), comp = cmp(`search_pro_completion:${site}`, 1), mis = cmp("search_pro_misjudge", 0);
  const layers = rows.filter((r) => r.day === day && r.metric.startsWith("search_cause_layer:") && r.metric.endsWith(`:${site}`) && Number(r.value) > 0)
    .map((r) => ({ k: r.metric.split(":")[1], n: Number(r.value) })).sort((a, b) => b.n - a.n);
  const line = `- 統括Pro（${site}・${day}）: 土台 ✓ ${ok.text}・重要欠 ${crit.text}・完成度 ${comp.text}${mis.a != null ? `・段A の判定の外れ ${mis.text}` : ""}・原因の型 ${layers.map((x) => `${x.k} ${x.n}`).join("・") || "—"}（作業員G・台帳 #474）`;
  const fixes: string[] = [];
  if (ok.a != null && ok.b != null && ok.a < ok.b) fixes.push(`統括Pro の土台 ✓ が前の日より下がった（${ok.b}→${ok.a}・${site}）→ 作業員G・台帳 #474`);
  if (comp.a != null && comp.b != null && comp.a < comp.b) fixes.push(`統括Pro の自動モード完成度が前の日より下がった（${comp.b}→${comp.a}・${site}）→ 作業員G・台帳 #474`);
  if (crit.a != null && crit.b != null && crit.a > crit.b) fixes.push(`統括Pro の重要欠が前の日より増えた（${crit.b}→${crit.a}・${site}）→ 作業員G・台帳 #474`);
  if (mis.a != null && mis.b != null && mis.a > mis.b) fixes.push(`統括Pro の段A の判定の外れが前の日より増えた（${mis.b}→${mis.a}）→ 作業員G・台帳 #474`);
  return { line, fixes, day };
}
