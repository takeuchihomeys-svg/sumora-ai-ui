// scripts/audit-reading-amounts.ts — 画像から読んだ金額（賃料・管理費・敷金・礼金）を、売上サポの同じ物件の行（資料の文字の層）で答え合わせする（読むだけ・LLM なし・$0）
//
// 2026-10-14 竹内さん「賃料・管理費・敷金・礼金・保証料・初期費用の読み取りを実データで測る。売上サポの同じ物件の行（資料の文字の層の値）で答え合わせし、
//   取り違え（70,000/7,000・管理費込み/別 等）を直す」。
//   読み取り: sent_image_properties.facts（送った画像1枚ごと・readPropertyImage → candidate-facts.factsFromImageRead）
//   正解: property_pickups.pdf_text（資料の文字の層）を listing-terms で読んだ 賃料・管理費・敷金・礼金（ヶ月・円）
//   組: 建物が同じ（property-name-loose）＋号室が同じ（room-no）＋資料の行が読み取りの前後 30日以内
//   保証料・初期費用は資料の表に無い（保証会社の欄の文・見積書の画像）＝読み取りが無いので数えない（見積書の金額は AIX が画像で送る決まり）
// 実行: npx tsx --env-file=.env.local scripts/audit-reading-amounts.ts [--show=20] [--after]
//   --after: 読み取りの値に amounts の安全の線（app/lib/reading-amounts.ts）を当てた後の数も出す
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const SHOW = Number((process.argv.find((a) => a.startsWith("--show=")) ?? "--show=20").split("=")[1]);
const AFTER = process.argv.includes("--after");

async function all<T>(t: string, cols: string, f?: (q: any) => any): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: T[] = [];
  for (let i = 0; ; i += 500) { let q = sb.from(t).select(cols).range(i, i + 499); if (f) q = f(q); const { data, error } = await q; if (error) throw new Error(`${t}: ${error.message}`); out.push(...((data ?? []) as T[])); if (!data || data.length < 500) break; }
  return out;
}
type Facts = { rent?: number; admin_fee_yen?: number; deposit_months?: number; deposit_yen?: number; key_money_months?: number; key_money_yen?: number; src?: string };

async function main() {
  const { parseListingTerms } = await import("../app/lib/listing-terms");
  const { parseLoose } = await import("../app/lib/property-name-loose");
  const { canonicalRoomNo } = await import("../app/lib/room-no");
  const amounts = AFTER ? await import("../app/lib/reading-amounts") : null;
  const pk = await all<{ id: number; property_name: string | null; room_no: string | null; pdf_text: string | null; created_at: string }>("property_pickups", "id, property_name, room_no, pdf_text, created_at", (q) => q.not("pdf_text", "is", null).not("room_no", "is", null));
  const truthBy = new Map<string, Array<{ at: number; rent: number | null; admin: number | null; depM: number | null; keyM: number | null; depY: number | null; keyY: number | null; name: string }>>();
  for (const r of pk) {
    const p = parseLoose(r.property_name); const room = canonicalRoomNo(r.room_no, {});
    if (!p || !room) continue;
    const t = parseListingTerms(r.pdf_text, { today: r.created_at });
    if (t.rentYen == null) continue;
    const k = `${p.key}|${room}`;
    const a = truthBy.get(k) ?? [];
    a.push({ at: Date.parse(r.created_at), rent: t.rentYen, admin: t.adminFeeYen, depM: t.depositYen ? null : t.depositMonths, keyM: t.keyMoneyYen ? null : t.keyMoneyMonths, depY: t.depositYen ?? null, keyY: t.keyMoneyYen ?? null, name: r.property_name ?? "" });
    truthBy.set(k, a);
  }
  const sip = await all<{ image_url: string; property_name: string | null; room_no: string | null; facts: Facts | null; created_at: string }>("sent_image_properties", "image_url, property_name, room_no, facts, created_at", (q) => q.not("facts", "is", null));
  type Kind = "rent" | "admin" | "deposit" | "key";
  const stat: Record<Kind, { n: number; ok: number; bad: number; types: Map<string, number>; ex: string[] }> = {
    rent: { n: 0, ok: 0, bad: 0, types: new Map(), ex: [] }, admin: { n: 0, ok: 0, bad: 0, types: new Map(), ex: [] },
    deposit: { n: 0, ok: 0, bad: 0, types: new Map(), ex: [] }, key: { n: 0, ok: 0, bad: 0, types: new Map(), ex: [] },
  };
  const bump = (k: Kind, ok: boolean, type: string, ex: string) => { const s = stat[k]; s.n++; if (ok) s.ok++; else { s.bad++; s.types.set(type, (s.types.get(type) ?? 0) + 1); if (s.ex.length < SHOW) s.ex.push(ex); } };
  let pairs = 0;
  for (const r of sip) {
    let f = r.facts ?? {};
    if (f.src !== "image") continue;
    const p = parseLoose(r.property_name); const room = canonicalRoomNo(r.room_no, {});
    if (!p || !room) continue;
    const at = Date.parse(r.created_at);
    const truth = (truthBy.get(`${p.key}|${room}`) ?? []).filter((x) => Math.abs(x.at - at) <= 30 * 86400_000).sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0];
    if (!truth) continue;
    pairs++;
    if (amounts) f = amounts.checkReadAmounts(f as never, {}).facts as Facts;
    const label = `${r.property_name} ${room}`;
    if (f.rent != null && truth.rent != null) {
      const ok = f.rent === truth.rent;
      const type = ok ? "" : f.rent === truth.rent * 10 ? "×10" : f.rent * 10 === truth.rent ? "÷10" : truth.admin != null && f.rent === truth.rent + truth.admin ? "管理費込み" : truth.admin != null && f.rent === truth.admin ? "管理費と取り違え" : Math.abs(f.rent - truth.rent) <= 2000 ? "近い（別の部屋・改定）" : "その他";
      bump("rent", ok, type, `${label}: 読み ${f.rent} ／ 資料 ${truth.rent}（管理費 ${truth.admin}）`);
    }
    if (f.admin_fee_yen != null && truth.admin != null) {
      const ok = f.admin_fee_yen === truth.admin;
      const type = ok ? "" : f.admin_fee_yen === truth.admin * 10 ? "×10" : f.admin_fee_yen * 10 === truth.admin ? "÷10" : f.admin_fee_yen === 0 ? "0（なしと読んだ）" : "その他";
      bump("admin", ok, type, `${label}: 読み ${f.admin_fee_yen} ／ 資料 ${truth.admin}`);
    }
    for (const [k, rm, ry, tm, ty] of [["deposit", f.deposit_months, f.deposit_yen, truth.depM, truth.depY], ["key", f.key_money_months, f.key_money_yen, truth.keyM, truth.keyY]] as const) {
      if (rm == null && ry == null) continue;
      if (tm == null && ty == null) continue;
      const readM = rm != null ? rm : ry != null && truth.rent ? Math.round((ry / truth.rent) * 10) / 10 : null;
      const truM = tm != null ? tm : ty != null && truth.rent ? Math.round((ty / truth.rent) * 10) / 10 : null;
      const ok = readM != null && truM != null && Math.abs(readM - truM) < 0.05;
      const other = k === "deposit" ? (truth.keyM ?? null) : (truth.depM ?? null);
      const type = ok ? "" : readM != null && other != null && Math.abs(readM - other) < 0.05 ? "敷金と礼金の取り違え" : readM === 0 ? "0（なしと読んだ）" : truM === 0 ? "資料はなし" : "その他";
      bump(k, ok, type, `${label}: 読み ${rm ?? ry} ／ 資料 ${tm ?? ty}（${k}）`);
    }
  }
  console.log(`組（送った画像の読み取り × 同じ部屋の売上サポの行・30日以内）: ${pairs}${AFTER ? "（安全の線の後）" : ""}`);
  if (amounts) {
    const all2 = sip.filter((r) => r.facts?.src === "image").map((r) => ({ r, g: amounts.checkReadAmounts(r.facts as never, {}) })).filter((x) => x.g.changes.length);
    console.log(`保存済みの読み取り（facts・画像 ${sip.filter((r) => r.facts?.src === "image").length}件）で安全の線が直す行: ${all2.length}  例 ${all2.slice(0, 6).map((x) => `${x.r.property_name} ${x.g.changes.join(",")}`).join(" ｜ ")}`);
  }
  for (const [k, s] of Object.entries(stat)) {
    console.log(`■ ${k}: ${s.n}件 正 ${s.ok}・誤 ${s.bad}（${[...s.types].map(([t, n]) => `${t} ${n}`).join("・")}）`);
    for (const e of s.ex) console.log(`   ${e}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
