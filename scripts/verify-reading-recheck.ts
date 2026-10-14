// scripts/verify-reading-recheck.ts — 印の付いた送った画像（物件の資料）を見本で拡大して読み直し、直る／誤って直す を確かめる
//   （DeepSeek・推論なし・1枚1回・llm_usage_logs にも書かない＝本番 DB は読むだけ）
//
// 2026-10-14 竹内さん（設計知見 56ecf24a）「自信が無い時だけ深く調べる」。読み直しの決め方は app/lib/reading-confidence.ts（adopt*・applyRecheckedUnits）、
//   読み直しは app/lib/reading-recheck-server.ts（全体＋縦横2つずつの拡大）。全件は読み直さない（見本だけ・設計知見 b1a3ac8f）。
//   正解: rent_observations（売上サポの行）で賃料・㎡・間取りが1つの建物に決まり名前が似ている時のその名前・号室・敷金礼金（scripts/audit-reading-confidence.ts と同じ）
// 実行: npx tsx --env-file=.env.local scripts/verify-reading-recheck.ts [--names=8] [--rooms=6] [--units=6]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: number) => Number((process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1]);
const N_NAMES = arg("names", 8), N_ROOMS = arg("rooms", 6), N_UNITS = arg("units", 6);

async function all<T>(t: string, cols: string, f?: (q: any) => any): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: T[] = [];
  for (let i = 0; ; i += 1000) {
    let q = sb.from(t).select(cols).range(i, i + 999);
    if (f) q = f(q);
    const { data, error } = await q;
    if (error) throw new Error(`${t}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}
type Facts = Record<string, unknown> & { rent?: number; area_sqm?: number; floor_plan?: string; src?: string; deposit_months?: number; key_money_months?: number };

async function main() {
  const fix = await import("../app/lib/property-name-fix");
  const rc = await import("../app/lib/reading-confidence");
  const { recheckImageFields } = await import("../app/lib/reading-recheck-server");
  const { parseLoose } = await import("../app/lib/property-name-loose");
  const { similarity, normalizePropertyName } = await import("../app/lib/property-name-match");
  type Src = import("../app/lib/property-name-fix").LedgerSource;
  const rows: Array<{ name: string | null; source: Src }> = [];
  for (const r of await all<{ property_name: string | null }>("property_pickups", "property_name")) rows.push({ name: r.property_name, source: "text" });
  for (const r of await all<{ property_names: string[] | null; line_message_id: string | null }>("aix_usage_logs", "property_names, line_message_id", (q) => q.not("property_names", "is", null))) { if (String(r.line_message_id ?? "").startsWith("bexam")) continue; for (const n of r.property_names ?? []) rows.push({ name: n, source: "staff" }); }
  for (const r of await all<{ property_name: string | null; source: string | null }>("sent_properties", "property_name, source")) rows.push({ name: r.property_name, source: r.source === "vision" ? "read" : "shared" });
  const ledger = fix.buildLedger(rows);
  const obs = await all<import("../app/lib/reading-confidence").AttrRow>("rent_observations", "property_name, room_no, rent, area_sqm, floor_plan, total_floors, deposit_months, key_money_months", (q) => q.not("rent", "is", null).not("area_sqm", "is", null));
  const sip = (await all<{ image_url: string; property_name: string | null; room_no: string | null; source: string | null; facts: Facts | null; created_at: string }>(
    "sent_image_properties", "image_url, property_name, room_no, source, facts, created_at", (q) => q.not("facts", "is", null))).filter((r) => r.facts?.src === "image");
  sip.sort((a, b) => b.created_at.localeCompare(a.created_at));

  const truthOf = (r: typeof sip[number], readName: string) => {
    const f = r.facts ?? {};
    const hit = rc.lookupByAttributes(obs, { rent: f.rent ?? null, areaSqm: f.area_sqm ?? null, floorPlan: f.floor_plan ?? null, room: r.room_no });
    return hit && similarity(normalizePropertyName(readName), normalizePropertyName(hit.name)) >= 0.5 ? hit : null;
  };
  const names: typeof sip = [], rooms: typeof sip = [], units: typeof sip = [];
  const seen = new Set<string>();
  for (const r of sip) {
    if (seen.has(r.image_url)) continue;
    const raw = r.source === "vision" || r.source === "backfill_vision";
    const nf = fix.fixReadPropertyName(r.property_name, ledger, {});
    const ns = raw ? rc.nameSignals(r.property_name ?? "", nf).filter((s) => rc.NAME_TRIGGER.has(s)) : [];
    const af = ns.length ? rc.attrNameFix(nf.name, rc.lookupByAttributes(obs, { rent: r.facts?.rent ?? null, areaSqm: r.facts?.area_sqm ?? null, floorPlan: r.facts?.floor_plan ?? null })) : null;
    if (ns.length && !af && names.length < N_NAMES) { names.push(r); seen.add(r.image_url); continue; }
    if (rc.roomSignals(r.room_no).some((s) => s !== "room_text") && rooms.length < N_ROOMS) { rooms.push(r); seen.add(r.image_url); continue; }
    if (rc.amountUnitSignals(r.facts ?? {}, {}).length && units.length < N_UNITS) {
      const pk = parseLoose(nf.name);
      const hit = rc.lookupByAttributes(obs, { rent: r.facts?.rent ?? null, areaSqm: r.facts?.area_sqm ?? null, floorPlan: r.facts?.floor_plan ?? null, room: r.room_no });
      if (rc.alignUnitWithPickup(r.facts ?? {}, hit, pk?.key ?? null, ["deposit"])) continue;   // ①で決まる物は読み直さない
      units.push(r); seen.add(r.image_url);
    }
  }
  // 単位の取り違えの分かっている2件（トップヒル森河内・パレーシャル難波）を見本に必ず入れる
  for (const n of ["トップヒル森河内", "パレーシャル難波"]) {
    const r = sip.find((x) => (x.property_name ?? "").includes(n) && rc.amountUnitSignals(x.facts ?? {}, {}).length && !seen.has(x.image_url));
    if (r) { units.push(r); seen.add(r.image_url); }
  }

  let calls = 0, inTok = 0, outTok = 0, hitTok = 0;
  const tally = { name: { n: 0, adopt: 0, right: 0, wrong: 0, unknown: 0 }, room: { n: 0, adopt: 0, right: 0, wrong: 0, unknown: 0 }, unit: { n: 0, fixed: 0, confirmed: 0, unclear: 0, right: 0, wrong: 0 } };
  const go = async (kind: "name" | "room" | "unit", r: typeof sip[number]) => {
    const again = await recheckImageFields(r.image_url, { record: false });
    calls++;
    if (again?.usage) { inTok += again.usage.input; outTok += again.usage.output; hitTok += again.usage.cacheHit; }
    const nf = fix.fixReadPropertyName(r.property_name, ledger, {});
    const truth = truthOf(r, nf.name);
    const head = `[${kind}] ${r.property_name} ${r.room_no ?? ""}（拡大 ${again?.tiles ?? "-"}枚・${again?.ms ?? "-"}ms）`;
    if (!again) { console.log(`${head}\n   読み直し失敗`); return; }
    if (kind === "name") {
      tally.name.n++;
      const ad = rc.adoptRecheckedName(nf, fix.fixReadPropertyName(again.propertyName, ledger, {}));
      const ok = truth ? (ad ? parseLoose(ad.name)?.key === truth.key : null) : null;
      if (ad) { tally.name.adopt++; if (ok === true) tally.name.right++; else if (ok === false) tally.name.wrong++; else tally.name.unknown++; }
      console.log(`${head}\n   読み直し「${again.propertyName}」→ ${ad ? `使う ${ad.name}（${ad.rule}）` : "使わない"} ／ 正 ${truth?.name ?? "（照らせない）"}${ad && ok === false ? " ✗誤って直す" : ad && ok ? " ✓" : ""}`);
    } else if (kind === "room") {
      tally.room.n++;
      const ad = rc.adoptRecheckedRoom(r.room_no, again.roomNumber);
      const ok = truth && truth.rooms.length ? (ad ? truth.rooms.includes(ad) : null) : null;
      if (ad) { tally.room.adopt++; if (ok === true) tally.room.right++; else if (ok === false) tally.room.wrong++; else tally.room.unknown++; }
      console.log(`${head}\n   読み直し「${again.roomNumber}」→ ${ad ? `使う ${ad}` : "使わない"} ／ 資料の号室 ${truth?.rooms.join("/") || "（照らせない）"}${ad && ok === false ? " ？（同じ型の別の部屋かも）" : ad && ok ? " ✓" : ""}`);
    } else {
      tally.unit.n++;
      const res = rc.applyRecheckedUnits(r.facts ?? {}, again, ["deposit"], ["key_money"]);
      const f2 = res.unclear.length ? rc.markUnitUnclear(res.facts, res.unclear) : res.facts;
      if (res.changes.length) tally.unit.fixed++; else if (res.unclear.length) tally.unit.unclear++; else tally.unit.confirmed++;
      const tM = truth?.depositMonths ?? null;
      const rentV = typeof f2.rent === "number" ? f2.rent : 0;
      const nowM = typeof f2.deposit_months === "number" ? f2.deposit_months : typeof f2.deposit_yen === "number" && rentV ? Math.round((f2.deposit_yen / rentV) * 10) / 10 : null;
      const ok = tM != null && nowM != null && !res.unclear.length ? Math.abs(nowM - tM) < 0.15 : null;
      if (ok === true) tally.unit.right++; else if (ok === false) tally.unit.wrong++;
      console.log(`${head}\n   1回目 敷金 ${r.facts?.deposit_months}・礼金 ${r.facts?.key_money_months} ／ 読み直し 敷金「${again.deposit}」礼金「${again.keyMoney}」→ ${res.changes.join(",") || (res.unclear.length ? `単位不明の印（${res.unclear.join(",")}）` : "月数で確か")} ／ 資料 敷金 ${tM ?? "（照らせない）"}ヶ月${ok === false ? " ✗" : ok ? " ✓" : ""}`);
    }
  };
  for (const r of names) await go("name", r);
  for (const r of rooms) await go("room", r);
  for (const r of units) await go("unit", r);
  const usd = (inTok - hitTok) * 0.15 / 1e6 + hitTok * 0.003 / 1e6 + outTok * 0.6 / 1e6;
  console.log(`\n物件名 ${JSON.stringify(tally.name)}\n号室 ${JSON.stringify(tally.room)}\n敷金礼金 ${JSON.stringify(tally.unit)}`);
  console.log(`DeepSeek ${calls}回・入力 ${inTok}（キャッシュ ${hitTok}）・出力 ${outTok}・約 $${usd.toFixed(4)}（1回 約 $${(usd / Math.max(1, calls)).toFixed(5)}・ピークは2倍）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
