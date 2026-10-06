// app/lib/pickup-search-facts.ts
// AIX【物件ピックアップした】の文に「今回実際に検索した条件」（拡張の検索の記録 search_audits.filled.form）を渡す（純関数・DB 依存なし）。
//
// 2026-10-06 ⑰ 竹内「物件ピックアップの文のところもAIXツールと連携したら、最善の文が出来るから、そうする方向でいく」
//   調査（scripts/audit-aix-draft-vs-sent.ts）: 新着のピックアップの1行目は、スタッフが実際に検索した条件へ書き直していた
//   （「九条含めた西区もご条件のエリアに加え」「2DK以上」「家賃13万円程」）。下書きは登録の希望条件しか見ていなかった。
//   拡張はお客様ごとに実際に入れた検索条件を search_audits.filled.form（区・沿線・駅・家賃の上限/下限・間取り・徒歩・築年）に残している。
// ■ 決め
//   ・読むのは今回の送付の前 12時間以内に終わった検索（status=finished）のうち、サイトごとに一番新しい1回。両サイトの値は合わせる（区・沿線は和）
//   ・"-1"・空は「指定なし」
//   ・生成に渡すのは「②の条件はこの検索した条件と合わせる（登録の希望条件と違う時はこちら）」の材料だけ。条件の作文はしない

export type SearchAuditRow = { site?: string | null; is_wide?: boolean | null; created_at: string; status?: string | null; filled?: unknown };
export type SearchedConditions = {
  wards: string[]; lines: string[]; stations: string[]; layouts: string[];
  rentMax: number | null; rentMin: number | null; walkMax: number | null; ageMax: number | null;
  widened: boolean; sites: string[];
};

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : parseInt(String(v ?? "").replace(/[^0-9-]/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean) : []);

/** 送付の前の検索の記録 → 実際に検索した条件（無ければ null） */
export function searchedConditionsFrom(rows: readonly SearchAuditRow[], beforeMs: number, windowMs = 12 * 3_600_000): SearchedConditions | null {
  const fin = rows
    .filter((r) => (r.status ?? "finished") === "finished" && Date.parse(r.created_at) <= beforeMs && Date.parse(r.created_at) >= beforeMs - windowMs)
    .filter((r) => { const f = r.filled as { form?: unknown } | null; return !!f && typeof f === "object" && !!f.form && typeof f.form === "object"; })
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (!fin.length) return null;
  const perSite = new Map<string, SearchAuditRow>();
  for (const r of fin) { const s = String(r.site ?? "-"); if (!perSite.has(s)) perSite.set(s, r); }
  const out: SearchedConditions = { wards: [], lines: [], stations: [], layouts: [], rentMax: null, rentMin: null, walkMax: null, ageMax: null, widened: false, sites: [] };
  for (const [site, r] of perSite) {
    const f = (r.filled as { form: Record<string, unknown> }).form;
    out.sites.push(site);
    out.wards.push(...strs(f.wards)); out.lines.push(...strs(f.lines)); out.stations.push(...strs(f.stations)); out.layouts.push(...strs(f.layouts));
    const rm = num(f.rent_max), rn = num(f.rent_min), w = num(f.walk), a = num(f.age);
    if (rm != null) out.rentMax = Math.max(out.rentMax ?? 0, rm);
    if (rn != null) out.rentMin = out.rentMin == null ? rn : Math.min(out.rentMin, rn);
    if (w != null) out.walkMax = Math.max(out.walkMax ?? 0, w);
    if (a != null) out.ageMax = Math.max(out.ageMax ?? 0, a);
    if (r.is_wide) out.widened = true;
  }
  const u = (a: string[]) => [...new Set(a)];
  out.wards = u(out.wards); out.lines = u(out.lines); out.stations = u(out.stations); out.layouts = u(out.layouts);
  return out;
}

const man = (yen: number) => { const m = yen / 10000; return `${Number.isInteger(m) ? m : m.toFixed(1).replace(/\.0$/, "")}万円`; };

/** 生成に渡すブロック（無ければ空） */
export function buildSearchedConditionsNote(c: SearchedConditions | null, bundleCount?: number | null): string {
  if (!c) return "";
  const area = [c.wards.length ? `区・市: ${c.wards.slice(0, 8).join("・")}` : "", c.lines.length ? `沿線: ${c.lines.slice(0, 6).join("・")}` : "", c.stations.length ? `駅: ${c.stations.slice(0, 10).join("・")}` : ""].filter(Boolean);
  const rent = c.rentMax != null ? `家賃: ${c.rentMin != null ? `${man(c.rentMin)}〜` : ""}${man(c.rentMax)}以内（管理費込みかは拡張の設定）` : "";
  const items = [...area, rent, c.layouts.length ? `間取り: ${c.layouts.join("・")}` : "", c.walkMax != null ? `駅徒歩: ${c.walkMax}分以内` : "", c.ageMax != null ? `築年: ${c.ageMax}年以内` : ""].filter(Boolean);
  if (!items.length) return "";
  return [
    `【今回実際に検索した条件（AIXツール・拡張の検索の記録${c.sites.length ? `・${c.sites.join("/")}` : ""}${c.widened ? "・広げて検索" : ""}）${bundleCount ? `→ 見つかったお部屋のうち今回 ${bundleCount}件をお送りする` : ""}】`,
    ...items.map((s) => `・${s}`),
    "→ ②のエリア・家賃・間取りは、この検索した条件と合わせて書く（登録の希望条件と違う時はこちらが今回の事実。登録の条件のうち検索に使っていない物を「〜のお部屋」と言い切らない）。広げて検索した時は広げた事を受け止めて書く",
  ].join("\n");
}
