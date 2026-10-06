// scripts/audit-building-ad-assume.ts
// 2026-10-06 竹内さん「だいじょうぶ」: AD が書かれていない部屋を同じ建物の別の部屋の AD で補う（app/lib/building-ad-assume.ts）の当て直し（読むだけ・LLM なし・費用0・DB に書かない）。
//   1) AD が分かる行で当て直す: その行の AD を隠し、その時点までに届いていた売上サポの行（同じ回を含む・30日以内）の同じ建物の別の部屋から補う → 補える数・実際の AD と合う率・高く見せた率・線（1.5／2）の側が同じ率
//      決め方（一番低い／中央／一番高い／一番新しい × 元付の免許番号を見る／見ない）を並べる
//   2) AD 不明の行（AD_UNKNOWN）: 今の決まりで補える数と値・AD1未満で補わなかった数・目で読む実例
// 実行: npx tsx --env-file=.env.local scripts/audit-building-ad-assume.ts [--days=60] [--show=15]
import { createClient } from "@supabase/supabase-js";
import { adMonthsOfPickup } from "../app/lib/star-rank-pickup";
import { sameBuildingAdOf, agentLicenseOf, buildingAdKey, BUILDING_AD_RULE, type BuildingAdSource, type BuildingAdRule } from "../app/lib/building-ad-assume";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "60"), 10);
const SHOW = parseInt(String(args.show ?? "15"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
type Row = Record<string, any>;
const pct = (a: number, n: number) => (n ? `${Math.round((a / n) * 100)}%` : "-");
async function all(build: (a: number, b: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>, page = 500): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < 400; p++) { const { data, error } = await build(p * page, p * page + page - 1); if (error) throw new Error(error.message); if (!data?.length) break; out = out.concat(data); if (data.length < page) break; }
  return out;
}

(async () => {
  const since = new Date(Date.now() - (DAYS + 30) * 864e5).toISOString();
  const rows = await all((a, b) => sb.from("property_pickups").select("id, batch_id, created_at, property_name, room_no, reason_codes, ad_yen, summary_text, pdf_text, site, status, verdict").gte("created_at", since).order("id").range(a, b) as never);
  const P = (...x: unknown[]) => console.log(...x);
  const assumed = (r: Row) => ((r.reason_codes ?? []) as string[]).some((c) => /^AD_ASSUMED_/.test(c));
  const src: Array<BuildingAdSource & { id: number; t: number }> = rows.map((r) => ({
    id: r.id, name: r.property_name, room: r.room_no, adMonths: adMonthsOfPickup(r), assumed: assumed(r), agent: agentLicenseOf(r.pdf_text), at: r.created_at, t: Date.parse(r.created_at),
  }));
  const until = Date.now() - DAYS * 864e5;
  const targets = rows.filter((r) => Date.parse(r.created_at) >= until);
  const sourcesFor = (r: Row) => { const t = Date.parse(r.created_at) + 60_000; return src.filter((s) => s.id !== r.id && s.t <= t); };
  const keyed = targets.filter((r) => buildingAdKey(r.property_name));
  P(`=== 0. ${DAYS}日の売上サポの行 ${targets.length}（建物の鍵あり ${keyed.length}）・AD 不明 ${targets.filter((r) => adMonthsOfPickup(r) == null).length}（札 AD_UNKNOWN ${targets.filter((r) => (r.reason_codes ?? []).includes("AD_UNKNOWN")).length}）・元付の免許が読めた行 ${pct(src.filter((s) => s.agent).length, src.length)}`);

  // 1) AD が分かる行で当て直す
  const known = targets.filter((r) => adMonthsOfPickup(r) != null && !assumed(r));
  P(`\n=== 1. AD が分かる行 ${known.length} で当て直す（隠して補う）: 補える数・一致・高く見せた・低く見せた・線1.5の側が同じ・線2の側が同じ`);
  const variants: Array<[string, Partial<BuildingAdRule>]> = [
    ["今の決まり（一番低い・元付を見る・AD1未満は補わない）", {}],
    ["一番低い・元付を見ない", { requireSameAgent: false }],
    ["中央", { pick: "median" }],
    ["一番高い", { pick: "max" }],
    ["一番新しい", { pick: "latest" }],
    ["一番低い・AD1未満も補う", { minAd: 0 }],
    ["一番低い・7日以内", { maxDays: 7 }],
    ["一番低い・2部屋以上", { minRooms: 2 }],
  ];
  for (const [name, v] of variants) {
    const rule = { ...BUILDING_AD_RULE, ...v };
    let n = 0, eq = 0, over = 0, under = 0, s15 = 0, s2 = 0, spread = 0, spreadEq = 0;
    for (const r of known) {
      const act = adMonthsOfPickup(r)!;
      const a = sameBuildingAdOf({ name: r.property_name, room: r.room_no, agent: agentLicenseOf(r.pdf_text), at: r.created_at }, sourcesFor(r), rule);
      if (!a) continue;
      n++;
      if (a.adMonths === act) eq++; else if (a.adMonths > act) over++; else under++;
      if ((a.adMonths >= 1.5) === (act >= 1.5)) s15++;
      if ((a.adMonths >= 2) === (act >= 2)) s2++;
      if (a.min !== a.max) { spread++; if (a.adMonths === act) spreadEq++; }
    }
    P(`  ${name.padEnd(34)} 補える ${n}（${pct(n, known.length)}）・一致 ${pct(eq, n)}（${eq}）・高く ${pct(over, n)}（${over}）・低く ${pct(under, n)}（${under}）・線1.5 ${pct(s15, n)}・線2 ${pct(s2, n)}・建物でばらつく ${spread}（一致 ${spreadEq}）`);
  }
  // 高く見せた実例（今の決まり）
  const overEx: string[] = [];
  for (const r of known) {
    const act = adMonthsOfPickup(r)!;
    const a = sameBuildingAdOf({ name: r.property_name, room: r.room_no, agent: agentLicenseOf(r.pdf_text), at: r.created_at }, sourcesFor(r));
    if (a && a.adMonths > act && overEx.length < SHOW) overEx.push(`   ${String(r.created_at).slice(0, 10)} ${r.property_name} ${r.room_no ?? ""}: 実際 AD${act} ← 補い AD${a.adMonths}（元 ${a.from.map((f) => `${f.room ?? "?"}:${f.adMonths}`).join("・")}）`);
  }
  P(`  今の決まりで高く見せた実例 ${overEx.length}`); for (const x of overEx) P(x);

  // 2) AD 不明の行
  const unk = targets.filter((r) => adMonthsOfPickup(r) == null);
  const filled: string[] = []; let low = 0, n = 0, agentSkip = 0;
  const vals: Record<string, number> = {};
  for (const r of unk) {
    const tgt = { name: r.property_name, room: r.room_no, agent: agentLicenseOf(r.pdf_text), at: r.created_at };
    const a = sameBuildingAdOf(tgt, sourcesFor(r));
    if (!a) {
      if (sameBuildingAdOf(tgt, sourcesFor(r), { ...BUILDING_AD_RULE, minAd: 0 })) low++;
      else if (sameBuildingAdOf(tgt, sourcesFor(r), { ...BUILDING_AD_RULE, requireSameAgent: false })) agentSkip++;
      continue;
    }
    n++; vals[String(a.adMonths)] = (vals[String(a.adMonths)] ?? 0) + 1;
    if (filled.length < SHOW) filled.push(`   ${String(r.created_at).slice(0, 10)} ${r.property_name} ${r.room_no ?? ""}（${r.site}・${r.verdict}）→ AD${a.adMonths}（元 ${a.from.map((f) => `${f.room ?? "?"}:${f.adMonths}`).join("・")}${a.min !== a.max ? `・ばらつき ${a.min}〜${a.max}` : ""}）`);
  }
  P(`\n=== 2. AD 不明 ${unk.length}: 今の決まりで補える ${n}（値 ${Object.entries(vals).map(([k, v]) => `AD${k}:${v}`).join(" ")}）・AD1未満なので補わない ${low}・元付が違うので補わない ${agentSkip}`);
  for (const x of filled) P(x);
  // 補えない理由の段（いつの行でも／AD が分かる／その時点までに届いていた／元付が同じ）
  let f1 = 0, f2 = 0, f3 = 0, f4 = 0;
  const futureOnly: string[] = [];
  for (const r of unk) {
    const key = buildingAdKey(r.property_name); if (!key) continue;
    const others = src.filter((s) => s.id !== r.id && buildingAdKey(s.name) === key && String(s.room ?? "") !== String(r.room_no ?? ""));
    if (!others.length) continue; f1++;
    const kn = others.filter((s) => s.adMonths != null && !s.assumed); if (!kn.length) continue; f2++;
    const past = kn.filter((s) => s.t <= Date.parse(r.created_at) + 60_000); if (!past.length) { if (futureOnly.length < SHOW) futureOnly.push(`   ${String(r.created_at).slice(0, 10)} ${r.property_name} ${r.room_no ?? ""} ← 後から届いた ${kn.map((s) => `${String(s.at).slice(5, 10)} ${s.room ?? "?"}:AD${s.adMonths}${s.agent && s.agent !== agentLicenseOf(r.pdf_text) ? "（元付が違う）" : ""}`).join("・")}`); continue; } f3++;
    const ag = agentLicenseOf(r.pdf_text); if (past.some((s) => !ag || !s.agent || s.agent === ag)) f4++;
  }
  P(`  補えない理由の段: 同じ建物の別の部屋の行がある ${f1} → そのうち AD が分かる ${f2} → その時点までに届いていた ${f3} → 元付が同じ（か読めない）${f4}`);
  P(`  後から届いた行でしか補えない実例（本番の判定の時には無い）`); for (const x of futureOnly) P(x);
  // 元付が違う実例
  for (const r of unk) {
    const tgt = { name: r.property_name, room: r.room_no, agent: agentLicenseOf(r.pdf_text), at: r.created_at };
    if (sameBuildingAdOf(tgt, sourcesFor(r))) continue;
    const a = sameBuildingAdOf(tgt, sourcesFor(r), { ...BUILDING_AD_RULE, requireSameAgent: false });
    if (a) P(`   元付が違う: ${String(r.created_at).slice(0, 10)} ${r.property_name} ${r.room_no ?? ""}（免許 ${tgt.agent ?? "?"}）← ${a.from.map((f) => `${f.room ?? "?"}:AD${f.adMonths}`).join("・")}（免許 ${[...new Set(sourcesFor(r).filter((s) => buildingAdKey(s.name) === buildingAdKey(r.property_name) && s.adMonths != null).map((s) => s.agent ?? "?"))].join("・")}）`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
