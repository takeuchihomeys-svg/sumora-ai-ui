// scripts/audit-reading-confidence.ts — 読み取りの「怪しい印」が実際の誤りとどれだけ一緒に出るかを数える（読むだけ・LLM なし・$0）
//
// 2026-10-14 竹内さん（設計知見 56ecf24a・P1）「自信が無い時・根拠が見つからない時だけ深く調べる。全部に毎回かけない」。
//   印（app/lib/reading-confidence.ts）を保存済みの読み取りに当て、
//     ・印が出る割合（＝読み直しが走る割合）
//     ・印の付いた物のうち本当に誤りの割合（精度）／誤りのうち印が付いた割合（拾えた割合）
//   を欄ごと（物件名・号室・敷金礼金の単位）に出す。
//   読み取り: sent_image_properties（facts.src=image・送った画像1枚ごとの1回目の読み取り）
//     物件名は照合できなかった行（source=vision・backfill_vision＝読んだ名前のまま）だけ（照合できた行は会話の名前に寄せた後）
//   正解: rent_observations（売上サポの行＝資料の文字の層）で 賃料が同じ・㎡が ±0.05・間取りが同じ部屋が1つの建物に決まり、
//     しかも名前が似ている（similarity ≥ --sim）時、その建物・号室・敷金礼金。
//     ⚠ 名前が似ていない時は数えない: 賃料と㎡だけでは別の建物が偶然そろう（ドミール桜川III ↔ II・セレッソコート新大阪 ↔ エスプレイス難波サウスゲート）
//   --names: 住所（賃料・㎡・間取り）の照らしで名前を直す案の 直る／誤って直す を出す（reading-confidence.attrNameFix）
// 実行: npx tsx --env-file=.env.local scripts/audit-reading-confidence.ts [--show=15] [--sim=0.5]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const SHOW = Number((process.argv.find((a) => a.startsWith("--show=")) ?? "--show=15").split("=")[1]);
const SIM = Number((process.argv.find((a) => a.startsWith("--sim=")) ?? "--sim=0.5").split("=")[1]);

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

type Facts = { rent?: number; area_sqm?: number; floor_plan?: string; station?: string; deposit_months?: number; deposit_yen?: number; key_money_months?: number; key_money_yen?: number; src?: string; room_no?: string };
type Obs = import("../app/lib/reading-confidence").AttrRow;

async function main() {
  const fix = await import("../app/lib/property-name-fix");
  const { parseLoose } = await import("../app/lib/property-name-loose");
  const { canonicalRoomNo } = await import("../app/lib/room-no");
  const { similarity, normalizePropertyName } = await import("../app/lib/property-name-match");
  const rc = await import("../app/lib/reading-confidence");

  // 帳簿（全部・本番は loadLedgerFor でその場で引く＝audit-property-name-fix-runtime.ts で同じと確かめ済み）
  type Src = import("../app/lib/property-name-fix").LedgerSource;
  const rows: Array<{ name: string | null; source: Src }> = [];
  for (const r of await all<{ property_name: string | null }>("property_pickups", "property_name")) rows.push({ name: r.property_name, source: "text" });
  for (const r of await all<{ property_names: string[] | null; line_message_id: string | null }>("aix_usage_logs", "property_names, line_message_id", (q) => q.not("property_names", "is", null))) { if (String(r.line_message_id ?? "").startsWith("bexam")) continue; for (const n of r.property_names ?? []) rows.push({ name: n, source: "staff" }); }
  for (const r of await all<{ property_name: string | null; source: string | null }>("sent_properties", "property_name, source")) rows.push({ name: r.property_name, source: r.source === "vision" ? "read" : "shared" });
  const ledger = fix.buildLedger(rows);

  const obs = await all<Obs>("rent_observations", "property_name, room_no, rent, area_sqm, floor_plan, total_floors, deposit_months, key_money_months", (q) => q.not("rent", "is", null).not("area_sqm", "is", null));
  const sip = await all<{ image_url: string; property_name: string | null; room_no: string | null; source: string | null; facts: Facts | null; created_at: string }>(
    "sent_image_properties", "image_url, property_name, room_no, source, facts, created_at", (q) => q.not("facts", "is", null));
  const reads = sip.filter((r) => r.facts?.src === "image");
  const RAW = new Set(["vision", "backfill_vision"]);

  type Cell = { flagged: number; flaggedBad: number; bad: number; n: number; bySignal: Map<string, { n: number; bad: number }>; exBad: string[]; exMissed: string[]; exFalse: string[] };
  const mk = (): Cell => ({ flagged: 0, flaggedBad: 0, bad: 0, n: 0, bySignal: new Map(), exBad: [], exMissed: [], exFalse: [] });
  const cell = { name: mk(), room: mk(), unit: mk() };
  const add = (c: Cell, sigs: string[], bad: boolean, label: string) => {
    c.n++; if (bad) c.bad++;
    if (sigs.length) { c.flagged++; if (bad) { c.flaggedBad++; if (c.exBad.length < SHOW) c.exBad.push(`[${sigs.join(",")}] ${label}`); } else if (c.exFalse.length < SHOW) c.exFalse.push(`[${sigs.join(",")}] ${label}`); }
    else if (bad && c.exMissed.length < SHOW) c.exMissed.push(label);
    for (const s of sigs) { const x = c.bySignal.get(s) ?? { n: 0, bad: 0 }; x.n++; if (bad) x.bad++; c.bySignal.set(s, x); }
  };
  const rate = { reads: 0, nameRaw: 0, name: 0, nameNotInLedger: 0, room: 0, unit: 0, unitByPickup: 0, any: 0 };
  const roomEx = new Map<string, string[]>();
  const variants = { all: 0, depOnly: 0, depOrKey2: 0 };
  // 名前＋号室で売上サポの行（本番の①: 同じ部屋の行があればそれに合わせる）
  const obsByRoom = new Map<string, Obs[]>();
  for (const o of obs) { const p = parseLoose(o.property_name); const room = canonicalRoomNo(o.room_no ?? "", {}); if (!p || !room) continue; const k = `${p.key}|${room}`; obsByRoom.set(k, [...(obsByRoom.get(k) ?? []), o]); }
  const unitStat = { unitErr: 0, otherErr: 0, ex: [] as string[] };
  const nil = { n: 0, bad: 0 };   // 帳簿に無いだけ（印にしない）の行の誤り
  // 住所（賃料・㎡・間取り）の照らしで名前を直す案
  const attrFix = { tried: 0, fixed: 0, right: 0, wrong: 0, noTruth: 0, exRight: [] as string[], exWrong: [] as string[], exNoTruth: [] as string[], noPlace: 0 };

  for (const r of reads) {
    const f = r.facts ?? {};
    rate.reads++;
    const raw = RAW.has(r.source ?? "");
    const nameFix = fix.fixReadPropertyName(r.property_name, ledger, {});
    const nsAll = raw ? rc.nameSignals(r.property_name ?? "", nameFix) : [];
    const ns = nsAll.filter((s) => rc.NAME_TRIGGER.has(s));
    const rs = rc.roomSignals(r.room_no ?? f.room_no ?? "");
    const ds = rc.amountUnitSignals(f);
    const readName = nameFix.status === "fixed" ? nameFix.name : (r.property_name ?? "");
    const pk = parseLoose(readName);
    const sameRoomObs = pk ? obsByRoom.get(`${pk.key}|${canonicalRoomNo(r.room_no ?? "", {})}`) ?? [] : [];
    if (raw) { rate.nameRaw++; if (ns.length) rate.name++; if (nsAll.includes("not_in_ledger")) rate.nameNotInLedger++; }
    if (rs.length) { rate.room++; roomEx.set(rs.join(","), [...(roomEx.get(rs.join(",")) ?? []), `${r.property_name} 「${r.room_no}」`]); }
    { const dm = f.deposit_months, km = f.key_money_months; const di = typeof dm === "number" && Number.isInteger(dm) && dm >= 1 && dm <= 3; const ki = typeof km === "number" && Number.isInteger(km) && km >= 1 && km <= 3; if (di) variants.depOnly++; if (di || (ki && km! >= 2)) variants.depOrKey2++; if (di || ki) variants.all++; }
    if (ds.length) { rate.unit++; if (sameRoomObs.some((o) => o.deposit_months != null || o.key_money_months != null)) rate.unitByPickup++; }
    if (ns.length || rs.length || ds.length) rate.any++;

    const hit = rc.lookupByAttributes(obs, { rent: f.rent ?? null, areaSqm: f.area_sqm ?? null, floorPlan: f.floor_plan ?? null, room: r.room_no ?? null });
    const sim = hit ? similarity(normalizePropertyName(readName), normalizePropertyName(hit.name)) : 0;
    if (hit && pk && hit.key === pk.key && rc.roomSignals(r.room_no, { totalFloors: hit.totalFloors }).includes("room_floor")) { const k = "room_floor（建物の階数を超える）"; roomEx.set(k, [...(roomEx.get(k) ?? []), `${r.property_name} 「${r.room_no}」 階数 ${hit.totalFloors}`]); }
    const truthOk = !!hit && sim >= SIM;

    // 名前の直しの案（印のある照合前の名前だけ）
    if (raw && ns.length) {
      attrFix.tried++;
      const af = rc.attrNameFix(readName, hit, { minSim: 0 });
      if (af) {
        attrFix.fixed++;
        if (!af.placeless) {
          // 正しいかは「その会話の後のスタッフの名前」で確かめる代わりに、同じ賃料・㎡の行の名前がその物（＝af.name）なので、
          //   読み違いか別の建物かを目で読む例を出す（数は SHOW まで）
        } else attrFix.noPlace++;
        const label = `${r.property_name} → ${af.name}（似 ${af.sim.toFixed(2)}${af.placeless ? "・地名なし" : ""}）`;
        if (af.sim >= 0.5) { attrFix.right++; if (attrFix.exRight.length < 60) attrFix.exRight.push(label); }
        else { attrFix.wrong++; if (attrFix.exWrong.length < 60) attrFix.exWrong.push(label); }
      } else if (attrFix.exNoTruth.length < SHOW) { attrFix.noTruth++; attrFix.exNoTruth.push(`${r.property_name}${hit ? `（照らし: ${hit.name} 似 ${sim.toFixed(2)}）` : "（照らし: 決まらない）"}`); }
      else attrFix.noTruth++;
    }

    if (!truthOk) continue;
    if (raw) {
      const b = parseLoose(hit!.name);
      const bad = !pk || !b || pk.key !== b.key;
      add(cell.name, ns, bad, `${r.property_name} → 正 ${hit!.name}（似 ${sim.toFixed(2)}${nsAll.includes("not_in_ledger") ? "・帳簿に無い" : ""}）`);
      if (nsAll.includes("not_in_ledger")) { nil.n++; if (bad) nil.bad++; }
    }
    const room = canonicalRoomNo(r.room_no ?? "", {});
    if (room && hit!.rooms.length && (hit!.rooms.includes(room) || hit!.rooms.length === 1)) {
      add(cell.room, rs, !hit!.rooms.includes(room), `${r.property_name} ${r.room_no} → 資料 ${hit!.rooms.join("/")}`);
    }
    // 敷金・礼金の単位の取り違え（読んだ月数を万円と見ると資料と合う）
    for (const [rm, ry, tm, sig] of [[f.deposit_months, f.deposit_yen, hit!.depositMonths, "deposit_unit"], [f.key_money_months, f.key_money_yen, hit!.keyMoneyMonths, "key_money_unit"]] as const) {
      if (tm == null || (rm == null && ry == null) || !f.rent) continue;
      const readM = rm != null ? rm : Math.round(((ry as number) / f.rent) * 10) / 10;
      const bad = Math.abs(readM - tm) >= 0.15;
      const unitErr = bad && rm != null && rm > 0 && Math.abs((rm * 10000) / f.rent - tm) <= 0.1;
      if (unitErr && unitStat.ex.length < SHOW) unitStat.ex.push(`${r.property_name} ${sig} 読み ${rm} ／ 資料 ${tm}ヶ月（賃料 ${f.rent}）`);
      if (unitErr) unitStat.unitErr++; else if (bad) unitStat.otherErr++;
      add(cell.unit, ds.includes(sig as never) ? [sig] : [], unitErr, `${r.property_name} 読み ${rm ?? ry}${rm != null ? "ヶ月" : "円"} ／ 資料 ${tm}ヶ月（賃料 ${f.rent}）`);
    }
  }

  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "-");
  console.log(`読み取り（送った画像の1回目・facts あり）: ${rate.reads}件`);
  console.log(`  印が出る割合（読み直しが走る割合）: 物件名 ${rate.name}/${rate.nameRaw}（${pct(rate.name, rate.nameRaw)}・照合前の名前だけ／帳簿に無いだけ ${rate.nameNotInLedger} は印にしない）・号室 ${rate.room}（${pct(rate.room, rate.reads)}）・敷金礼金の単位 ${rate.unit}（${pct(rate.unit, rate.reads)}・うち同じ部屋の売上サポの行がある ${rate.unitByPickup}）・どれか ${rate.any}（${pct(rate.any, rate.reads)}）`);
  for (const [k, c] of Object.entries(cell)) {
    console.log(`\n■ ${k}: 正解のある ${c.n}件・誤り ${c.bad}・印 ${c.flagged}（うち誤り ${c.flaggedBad}＝精度 ${pct(c.flaggedBad, c.flagged)}・拾えた ${pct(c.flaggedBad, c.bad)}）`);
    for (const [s, x] of c.bySignal) console.log(`   印 ${s}: ${x.n}件・誤り ${x.bad}（${pct(x.bad, x.n)}）`);
    if (c.exBad.length) console.log(`   印あり・誤り:\n     ${c.exBad.join("\n     ")}`);
    if (c.exFalse.length) console.log(`   印あり・正しい（空振り）:\n     ${c.exFalse.join("\n     ")}`);
    if (c.exMissed.length) console.log(`   印なし・誤り（拾えなかった）:\n     ${c.exMissed.join("\n     ")}`);
  }
  console.log(`
帳簿に無いだけ（not_in_ledger・印にしない）: 正解のある ${nil.n}件・誤り ${nil.bad}（${pct(nil.bad, nil.n)}）＝印にすると照合前の名前の ${pct(rate.nameNotInLedger, rate.nameRaw)} に読み直しが走る`);
  console.log(`\n敷金礼金の単位の印の案（全読み取り ${rate.reads} のうち印が出る数）: 敷金か礼金が1〜3の整数 ${variants.all}・敷金が1〜3の整数 ${variants.depOnly}・敷金が1〜3か礼金が2〜3 ${variants.depOrKey2}`);
  console.log(`\n号室の印（全読み取り）:`);
  for (const [k, xs] of roomEx) console.log(`   ${k}: ${xs.length}件  ${xs.slice(0, 12).join("｜")}`);
  console.log(`\n敷金礼金: 単位の取り違え ${unitStat.unitErr}・単位でない誤り（0↔1ヶ月 等・この印の外）${unitStat.otherErr}\n   ${unitStat.ex.join("\n   ")}`);
  console.log(`\n住所（賃料・㎡・間取り）の照らしで名前を直す案（印のある照合前の名前 ${attrFix.tried}）: 1件に決まって直す ${attrFix.fixed}（似 ≥0.5 ${attrFix.right}・似 <0.5 ${attrFix.wrong}・うち地名なし ${attrFix.noPlace}）・決まらない ${attrFix.noTruth}`);
  console.log(`   直す（似 ≥0.5）:\n     ${attrFix.exRight.join("\n     ")}`);
  if (attrFix.exWrong.length) console.log(`   直す（似 <0.5・別の建物の恐れ）:\n     ${attrFix.exWrong.join("\n     ")}`);
  console.log(`   決まらない:\n     ${attrFix.exNoTruth.join("\n     ")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
