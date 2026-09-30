// scripts/audit-rent-min-bands.ts
// 「下限（rent_min）に対してどこまで安い部屋をスタッフが選んで送っているか」を下限の家賃帯ごとに測る（読むだけ・DB に書かない・LLM を呼ばない）。
//
// 2026-09-30 竹内「家賃の下限 95% を保留は強すぎる。85% 程までいけるが、そこは家賃帯による。家賃高い人とかもっと幅持って良いし、
//   その点は物件ピックアップで実際に送ってるの見たら良い」
// ■ 位置 = (家賃＋管理費) ÷ 下限（rent_min・その回の時点の条件＝property_condition_history で戻す）。下限の無いお客様は対象外
//   rent_min は拡張の検索では「賃料」の欄（管理費を含まない）に入る。ここでは property-brain の判定と同じく管理費込みで割る（下限に甘い側）
// ■ 正解＝スタッフが選んで送った事実（feedback_property_selection_label）。お客様の返信の有無は使わない
// ■ 材料（audit-rent-band.ts と同じ読み方）
//   pickup … 売上サポ（property_pickups）の回。選んだ物＝status sent／sent_at／その回の後 72時間以内に届いた同じ部屋
//   pool   … 拡張の回（property_candidate_pools）。選んだ物＝その回の後 72時間以内に届いた同じ建物
//   送付   … お客様に届いた全部の送付（sent_properties の customer）。家賃は同じお客様の候補から管理費まで結ぶ
//   🌟     … スタッフが一番に推した物件の本文の家賃（合計）
//   決まった … 申込・成約の会話で申込の印の直前の🌟
// ■ 個人情報: お客様は ID の先頭8文字だけ
// ■ YUMA（テスト用の会話）は外す
//
// 実行: npx tsx --env-file=.env.local scripts/audit-rent-min-bands.ts [--days=180] [--out=path.json]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { buildCustomerProfile, normalizeBuildingName, splitBuildingRoom, rentMinHoldRatio, RENT_BAND_RULE, type CustomerLike } from "../app/lib/property-brain";
import { customerAt, sameBuilding, type ConditionHistoryRow } from "../app/lib/scoring-learning-episodes";
import { factsFromPickup } from "../app/lib/recommendation-snapshot-server";
import { isTestConversation, YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "180"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = Record<string, any>;
const H = 3600_000, D = 24 * H, WINDOW = 72 * H;

async function all(build: (a: number, b: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>, page = 1000): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < 200; p++) {
    const { data, error } = await build(p * page, p * page + page - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out = out.concat(data);
    if (data.length < page) break;
  }
  return out;
}
const parse = (v: unknown) => (typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v);
const num = (v: unknown) => { const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };
const short = (id: unknown) => String(id ?? "").slice(0, 8) || "?";
const half = (s: unknown) => String(s ?? "").normalize("NFKC");
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
const f2 = (x: number | null | undefined) => (x == null ? "-" : x.toFixed(2));
const bkey = (name: unknown) => normalizeBuildingName(splitBuildingRoom(String(name ?? "")).building).replace(/[・･\-‐ー－\s]/g, "").toLowerCase();
const normRoom = (r: unknown) => half(r).replace(/号室?$/, "").replace(/^0+(?=\d)/, "").trim();
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); if (!s.length) return null; return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]; };

// 下限の家賃帯（件数を見て区切る）
export const MIN_TIERS: Array<{ key: string; lo: number; hi: number }> = [
  { key: "〜5万台", lo: 0, hi: 60_000 }, { key: "6万台", lo: 60_000, hi: 70_000 }, { key: "7万台", lo: 70_000, hi: 80_000 },
  { key: "8〜9万台", lo: 80_000, hi: 100_000 }, { key: "10万以上", lo: 100_000, hi: Infinity },
];
const tierOf = (min: number) => MIN_TIERS.find((t) => min >= t.lo && min < t.hi)!.key;
// 下限に対する位置の帯
export const POS: Array<{ key: string; lo: number; hi: number }> = [
  { key: "<70%", lo: -Infinity, hi: 0.70 }, { key: "70-75%", lo: 0.70, hi: 0.75 }, { key: "75-80%", lo: 0.75, hi: 0.80 },
  { key: "80-85%", lo: 0.80, hi: 0.85 }, { key: "85-90%", lo: 0.85, hi: 0.90 }, { key: "90-95%", lo: 0.90, hi: 0.95 },
  { key: "95-100%", lo: 0.95, hi: 1.0 }, { key: "≥100%", lo: 1.0, hi: Infinity },
];
const posOf = (r: number) => POS.find((b) => r >= b.lo && r < b.hi)!.key;

type Item = { src: string; round: string; cust: string; at: string; name: string; total: number; adminKnown: boolean; min: number; max: number | null; r: number; chosen: boolean; ad: number | null; age: number | null };

async function main() {
  const until = Date.now();
  const sinceIso = new Date(until - DAYS * D).toISOString();
  const custs = new Map<string, Row>();
  for (const r of await all((a, b) => sb.from("property_customers").select("id, rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet, move_in_time, created_at, floor_area_min, raw_format_text, desired_area").range(a, b) as never)) custs.set(r.id, r);
  const hist = await all((a, b) => sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, created_at").range(a, b) as never);
  const histOf = new Map<string, ConditionHistoryRow[]>();
  for (const h of hist) (histOf.get(h.property_customer_id) ?? histOf.set(h.property_customer_id, []).get(h.property_customer_id)!).push(h as ConditionHistoryRow);
  const convs = await all((a, b) => sb.from("conversations").select("id, status, property_customer_id").range(a, b) as never);
  const yumaCust = new Set<string>(convs.filter((c) => c.id === YUMA_CONVERSATION_ID && c.property_customer_id).map((c) => String(c.property_customer_id)));
  const custOfConv = new Map(convs.filter((c) => c.property_customer_id).map((c) => [String(c.id), String(c.property_customer_id)]));
  const cache = new Map<string, { min: number | null; max: number | null }>();
  const profAt = (pc: string, at: string) => {
    const k = `${pc}@${at.slice(0, 13)}`; if (cache.has(k)) return cache.get(k)!;
    const base = custs.get(pc); let v = { min: null as number | null, max: null as number | null };
    if (base) { const { c } = customerAt(base, histOf.get(pc) ?? [], at); const p = buildCustomerProfile(c as CustomerLike, [], [], null, { today: at }); v = { min: p.rentMin ?? null, max: p.rentMax ?? null }; }
    cache.set(k, v); return v;
  };

  const sends = (await all((a, b) => sb.from("sent_properties").select("property_customer_id, conversation_id, property_name, room_no, rent, source, delivery, sent_at, pickup_id").gte("sent_at", new Date(until - (DAYS + 10) * D).toISOString()).order("id").range(a, b) as never))
    .filter((s) => !isTestConversation(s.conversation_id) && !yumaCust.has(String(s.property_customer_id ?? "")));
  const custSends = sends.filter((s) => s.delivery === "customer" || (s.delivery == null && s.source !== "line_group"));
  for (const s of custSends) if (!s.property_customer_id && s.conversation_id) s.property_customer_id = custOfConv.get(String(s.conversation_id)) ?? null;
  const custSendsOf = new Map<string, Row[]>();
  for (const s of custSends) if (s.property_customer_id) (custSendsOf.get(s.property_customer_id) ?? custSendsOf.set(s.property_customer_id, []).get(s.property_customer_id)!).push(s);

  const items: Item[] = [];
  const idx = new Map<string, Array<{ name: string; room: string; rent: number; admin: number | null }>>();
  const put = (pc: string, name: string, room: string, rent: number | null, admin: number | null) => { if (rent == null || rent < 15000) return; (idx.get(pc) ?? idx.set(pc, []).get(pc)!).push({ name, room, rent, admin }); };
  const mk = (src: string, round: string, pc: string, at: string, name: string, rent: number | null, admin: number | null, chosen: boolean, ad: number | null, age: number | null) => {
    put(pc, name, "", rent, admin);
    if (rent == null) return;
    const p = profAt(pc, at); if (p.min == null) return;
    const total = rent + (admin ?? 0);
    items.push({ src, round, cust: pc, at, name, total, adminKnown: admin != null, min: p.min, max: p.max, r: total / p.min, chosen, ad, age });
  };

  // ① 売上サポ
  const pk = (await all((a, b) => sb.from("property_pickups").select("id, created_at, batch_id, complete_group_id, property_customer_id, conversation_id, property_name, room_no, summary_text, pdf_text, status, sent_at").gte("created_at", sinceIso).order("id").range(a, b) as never, 200))
    .filter((r) => r.property_customer_id && !isTestConversation(r.conversation_id) && !yumaCust.has(String(r.property_customer_id)));
  const groups = new Map<string, Row[]>();
  for (const r of pk) { const k = r.complete_group_id ?? `b:${r.batch_id}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
  for (const [gid, rows] of groups) {
    const pc = String(rows[0].property_customer_id);
    const t0 = Math.min(...rows.map((r) => Date.parse(r.created_at)));
    const at = new Date(t0).toISOString();
    const win = (custSendsOf.get(pc) ?? []).filter((s) => Date.parse(s.sent_at) >= t0 - 10 * 60_000 && Date.parse(s.sent_at) <= t0 + WINDOW);
    const seen = new Map<string, Item | null>();
    for (const r of rows) {
      const room = normRoom(r.room_no); const k = `${bkey(r.property_name)}#${room}`;
      const chosen = r.status === "sent" || !!r.sent_at || win.some((s) => s.pickup_id === r.id || (sameBuilding(s.property_name, r.property_name) && (!s.room_no || !room || normRoom(s.room_no) === room)));
      if (seen.has(k)) { const d = seen.get(k); if (d && chosen) d.chosen = true; continue; }
      let f: Row = {}; try { f = factsFromPickup(r) as Row; } catch { /* 読めない */ }
      const n0 = items.length;
      mk("pickup", `pickup:${gid}`, pc, at, String(r.property_name ?? "") + (room ? ` ${room}` : ""), num(f.rent), num(f.admin_fee_yen), chosen, num(f.ad_months), num(f.building_age));
      seen.set(k, items.length > n0 ? items[items.length - 1] : null);
    }
  }
  // ② 拡張の回
  const pools = (await all((a, b) => sb.from("property_candidate_pools").select("id, property_customer_id, candidates, sent_at").gte("sent_at", sinceIso).order("sent_at").order("id").range(a, b) as never, 200))
    .filter((p) => p.property_customer_id && !yumaCust.has(String(p.property_customer_id)));
  for (const p of pools) {
    const pc = String(p.property_customer_id);
    const raw = parse(p.candidates) as Row[] | null; if (!Array.isArray(raw) || raw.length < 2) continue;
    const t = Date.parse(p.sent_at);
    const win = (custSendsOf.get(pc) ?? []).filter((s) => s.property_name && Date.parse(s.sent_at) >= t - 10 * 60_000 && Date.parse(s.sent_at) <= t + WINDOW);
    if (!win.length) continue;
    const seen = new Set<string>();
    for (const c of raw) {
      const room = normRoom(c.room_no); const k = `${bkey(c.name)}#${room}`;
      if (!c.name || seen.has(k)) continue; seen.add(k);
      const chosen = win.some((s) => sameBuilding(s.property_name, c.name) && (!s.room_no || !room || normRoom(s.room_no) === room));
      mk("pool", `pool:${p.id}`, pc, new Date(t).toISOString(), String(c.name), num(c.rent), num(c.admin_fee_yen), chosen, num(c.ad_months), num(c.building_age));
    }
  }
  const lookup = (pc: string, name: string) => {
    const xs = (idx.get(pc) ?? []).filter((x) => sameBuilding(x.name, name)); if (!xs.length) return null;
    return xs.find((x) => x.admin != null) ?? xs[0];
  };

  const out: Row = { days: DAYS, generated_at: new Date().toISOString() };
  const table = (title: string, cols: Array<[string, Array<{ r: number; min: number }>]>) => {
    console.log(`\n■ ${title}`);
    const res: Row = {};
    for (const t of MIN_TIERS) {
      const line: string[] = [];
      for (const [g, xs] of cols) {
        const v = xs.filter((x) => tierOf(x.min) === t.key);
        const counts = POS.map((b) => v.filter((x) => posOf(x.r) === b.key).length);
        const below = v.filter((x) => x.r < 1);
        (res[g] ??= {})[t.key] = { n: v.length, counts: Object.fromEntries(POS.map((b, i) => [b.key, counts[i]])), below: below.length, below_p10: q(below.map((x) => x.r), 0.1), below_min: below.length ? Math.min(...below.map((x) => x.r)) : null };
        line.push(`${g} ${String(v.length).padStart(4)}: ${counts.map((n) => String(n).padStart(3)).join(" ")} | 下限未満 ${below.length}（${pct(below.length, v.length)}）最小 ${f2(below.length ? Math.min(...below.map((x) => x.r)) : null)}`);
      }
      console.log(`  ${t.key.padEnd(7)} ${line.join("\n          ")}`);
    }
    return res;
  };
  console.log(`=== 下限に対する位置（家賃＋管理費 ÷ 下限）・下限の家賃帯ごと（${DAYS}日・読むだけ） ===`);
  console.log(`  列: ${POS.map((b) => b.key).join(" ")}`);

  // A. 回の中の選んだ物 vs 選ばなかった物（選んだ物と選ばない物が両方ある回）
  const rounds = new Map<string, Item[]>();
  for (const it of items) (rounds.get(it.round) ?? rounds.set(it.round, []).get(it.round)!).push(it);
  const usable = [...rounds.values()].filter((xs) => xs.some((c) => c.chosen) && xs.some((c) => !c.chosen)).flat();
  console.log(`  候補（下限あり・家賃あり） ${items.length}／比べられる回 ${new Set(usable.map((x) => x.round)).size}・お客様 ${new Set(usable.map((x) => x.cust)).size}人`);
  out.A = table("A. 比べられる回: 選んだ物／選ばない物", [["選んだ", usable.filter((x) => x.chosen)], ["選ばない", usable.filter((x) => !x.chosen)]]);
  out.A_pickup = table("A-売上サポだけ（物件ピックアップ）", [["選んだ", usable.filter((x) => x.chosen && x.src === "pickup")], ["選ばない", usable.filter((x) => !x.chosen && x.src === "pickup")]]);

  // 帯ごと・位置ごとの選ばれる率
  console.log("\n■ A の選ばれる率（位置ごと・下限の家賃帯ごと: 選んだ/候補）");
  out.A_rate = {};
  for (const t of MIN_TIERS) {
    const v = usable.filter((x) => tierOf(x.min) === t.key);
    const cells = POS.map((b) => { const inB = v.filter((x) => posOf(x.r) === b.key); const ch = inB.filter((x) => x.chosen).length; ((out.A_rate[t.key] ??= {})[b.key] = { n: inB.length, chosen: ch }); return `${ch}/${inB.length}`.padStart(7); });
    const allRate = v.length ? v.filter((x) => x.chosen).length / v.length : 0;
    console.log(`  ${t.key.padEnd(7)} ${cells.join(" ")}  （全体 ${pct(v.filter((x) => x.chosen).length, v.length)}・お客様 ${new Set(v.map((x) => x.cust)).size}人・上限÷下限 中央 ${f2(med(v.filter((x) => x.max).map((x) => x.max! / x.min)))}）`);
    void allRate;
  }

  // B. お客様に届いた全部の送付
  const sentItems: Array<{ r: number; min: number; cust: string; name: string; total: number; adminKnown: boolean }> = [];
  const seenS = new Set<string>();
  for (const s of custSends) {
    const pc = s.property_customer_id ? String(s.property_customer_id) : null; if (!pc || !s.property_name) continue;
    if (Date.parse(s.sent_at) < until - DAYS * D) continue;
    const k = `${pc}|${bkey(s.property_name)}#${normRoom(s.room_no)}`; if (seenS.has(k)) continue; seenS.add(k);
    const lk = lookup(pc, String(s.property_name));
    const rent = lk?.rent ?? num(s.rent); if (rent == null || rent < 15000) continue;
    const admin = lk?.admin ?? null;
    const p = profAt(pc, s.sent_at); if (p.min == null) continue;
    sentItems.push({ r: (rent + (admin ?? 0)) / p.min, min: p.min, cust: pc, name: String(s.property_name), total: rent + (admin ?? 0), adminKnown: admin != null });
  }
  out.B = table(`B. お客様に届いた送付（${sentItems.length}件・お客様 ${new Set(sentItems.map((x) => x.cust)).size}人）`, [["送付", sentItems]]);

  // C. 🌟 と 申込直前の🌟
  const staffStar = await all((a, b) => sb.from("messages").select("conversation_id, text, created_at").eq("sender", "staff").like("text", "%🌟%").order("id").range(a, b) as never);
  const applyMark = await all((a, b) => sb.from("messages").select("conversation_id, text, created_at").eq("sender", "staff").or("text.like.%番手%,text.like.%お申込み完了%,text.like.%お申込完了%,text.like.%申込受付%").order("id").range(a, b) as never);
  const APPLY_RE = /番手(?:にて|で)[^。\n]{0,12}(?:受理|申込|お申込|完了)|お申込み?(?:完了|受付)|申込(?:を)?受付/;
  const readStar = (text: string) => {
    const t = half(text).replace(/,/g, "");
    const head = t.split("\n").find((l) => /🌟/u.test(l)) ?? "";
    const name = head.replace(/🌟★?/gu, "").trim().split(/\s+/)[0] ?? "";
    const sum = t.match(/(?:合計|込み?)\s*(\d{4,7})\s*円/);
    const rent = t.match(/(?:家賃|賃料)\s*[:：]?\s*(\d{4,7})\s*円/);
    const adm = t.match(/(?:管理費|共益費)\s*[:：]?\s*(\d{3,6})\s*円/);
    const r = rent ? +rent[1] : null;
    const total = sum ? +sum[1] : r != null ? r + (adm ? +adm[1] : 0) : null;
    return { name, total: total != null && total >= 15000 && total <= 1_000_000 ? total : null };
  };
  const stars: Array<{ conv: string; at: string; r: number; min: number; name: string; total: number }> = [];
  for (const m of staffStar) {
    if (isTestConversation(m.conversation_id)) continue;
    const pc = custOfConv.get(String(m.conversation_id)); if (!pc || yumaCust.has(pc)) continue;
    if (Date.parse(m.created_at) < until - DAYS * D) continue;
    if (!/^\s*🌟/u.test(half(m.text))) continue;
    const s = readStar(String(m.text)); if (s.total == null) continue;
    const p = profAt(pc, m.created_at); if (p.min == null) continue;
    stars.push({ conv: String(m.conversation_id), at: m.created_at, r: s.total / p.min, min: p.min, name: s.name, total: s.total });
  }
  const starU = [...new Map(stars.map((r) => [`${r.conv}|${bkey(r.name)}`, r])).values()];
  const decided: typeof starU = [];
  for (const c of convs.filter((c) => ["closed_won", "applying", "screening", "contract"].includes(c.status) && c.property_customer_id && !isTestConversation(c.id))) {
    const mark = applyMark.filter((m) => m.conversation_id === c.id && APPLY_RE.test(half(m.text))).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
    const cut = mark ? Date.parse(mark.created_at) : Infinity;
    const last = stars.filter((r) => r.conv === c.id && Date.parse(r.at) <= cut).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    if (last) decided.push(last);
  }
  out.C = table(`C. 🌟（${starU.length}件）／申込の直前の🌟（${decided.length}会話）`, [["🌟", starU], ["決まった", decided]]);

  // D. 下限未満で選んだ物（目で読む）
  console.log("\n■ D. 下限未満で選んで送った物（A・下限の家賃帯ごと・位置の低い順）");
  const belowChosen = usable.filter((x) => x.chosen && x.r < 1).sort((a, b) => a.min - b.min || a.r - b.r);
  for (const x of belowChosen) console.log(`  ${tierOf(x.min).padEnd(7)} ${short(x.cust)} ${x.src.padEnd(6)} 下限${x.min}・上限${x.max ?? "-"} ${x.name.slice(0, 24).padEnd(24)} 計${x.total}${x.adminKnown ? "" : "(管理費不明)"} → ${f2(x.r)}・AD ${x.ad ?? "-"}・築 ${x.age ?? "-"}`);
  out.D = belowChosen.map((x) => ({ tier: tierOf(x.min), cust: short(x.cust), src: x.src, min: x.min, max: x.max, name: x.name, total: x.total, r: x.r, ad: x.ad }));
  console.log("\n■ D'. 下限未満で送った物（B・届いた送付）");
  for (const x of sentItems.filter((x) => x.r < 1).sort((a, b) => a.min - b.min || a.r - b.r)) console.log(`  ${tierOf(x.min).padEnd(7)} ${short(x.cust)} 下限${x.min} ${x.name.slice(0, 24).padEnd(24)} 計${x.total}${x.adminKnown ? "" : "(管理費不明)"} → ${f2(x.r)}`);

  console.log("\n■ D''. 下限未満の🌟（C・スタッフが一番に推した物・本文の合計）");
  const custOfConvS = (conv: string) => short(custOfConv.get(conv));
  for (const x of starU.filter((x) => x.r < 1).sort((a, b) => a.min - b.min || a.r - b.r)) {
    const pc = custOfConv.get(x.conv)!; const p = profAt(pc, x.at);
    console.log(`  ${tierOf(x.min).padEnd(7)} ${custOfConvS(x.conv)} ${x.at.slice(0, 10)} 下限${x.min}・上限${p.max ?? "-"} ${x.name.slice(0, 24).padEnd(24)} 計${x.total} → ${f2(x.r)}${decided.includes(x) ? "・申込の直前" : ""}`);
  }
  out.D_star = starU.filter((x) => x.r < 1).map((x) => ({ tier: tierOf(x.min), cust: custOfConvS(x.conv), at: x.at, min: x.min, name: x.name, total: x.total, r: x.r }));
  // 下限のあるお客様ごとの🌟の位置（人の数で見る）
  console.log("\n■ 🌟の下限に対する位置（お客様ごと・下限の家賃帯ごと: 人数・最小の中央・下限未満の🌟がある人）");
  for (const t of MIN_TIERS) {
    const per = new Map<string, number[]>();
    for (const x of starU.filter((x) => tierOf(x.min) === t.key)) { const k = custOfConv.get(x.conv)!; (per.get(k) ?? per.set(k, []).get(k)!).push(x.r); }
    const mins = [...per.values()].map((v) => Math.min(...v));
    console.log(`  ${t.key.padEnd(7)} ${per.size}人・🌟 ${[...per.values()].reduce((a, v) => a + v.length, 0)}件・各人の最小の中央 ${f2(med(mins))}・下限未満の🌟がある人 ${mins.filter((m) => m < 1).length}（最小 ${f2(mins.length ? Math.min(...mins) : null)}）`);
  }

  // E. 線の候補ごとに、選んだ物の保留になる数・選ばない物の保留になる数
  console.log("\n■ E. 保留の線の候補（下限 × 線 未満を保留）: 選んだ物の保留／選ばない物の保留（A・下限の家賃帯ごと）");
  out.E = {};
  for (const t of MIN_TIERS) {
    const v = usable.filter((x) => tierOf(x.min) === t.key);
    const cells = [0.95, 0.90, 0.875, 0.85, 0.825, 0.80, 0.75].map((line) => { const a = v.filter((x) => x.chosen && x.r < line).length, b = v.filter((x) => !x.chosen && x.r < line).length; (out.E[t.key] ??= {})[line] = { chosen: a, others: b }; return `${line}: ${a}/${b}`.padEnd(13); });
    console.log(`  ${t.key.padEnd(7)} 選んだ ${v.filter((x) => x.chosen).length}・選ばない ${v.filter((x) => !x.chosen).length} | ${cells.join(" ")}`);
  }
  // F. 前の線（一律 0.95）と今の表（property-brain rentMinHoldRatio・下限の家賃帯ごと）で保留になる数
  console.log(`\n■ F. 保留になる数: 前の線（一律 0.95）→ 今の表（${RENT_BAND_RULE.minHoldTiers.map((t) => `下限${t.minFrom / 10000}万〜 ${t.holdRatio}`).join("・")}）`);
  out.F = {};
  const heldBy = (xs: Array<{ r: number; min: number }>, f: (min: number) => number) => xs.filter((x) => x.r < f(x.min)).length;
  const lists: Array<[string, Array<{ r: number; min: number }>]> = [["同じ回で選んだ", usable.filter((x) => x.chosen)], ["同じ回で選ばない", usable.filter((x) => !x.chosen)], ["届いた送付", sentItems], ["🌟", starU], ["申込の直前の🌟", decided]];
  for (const t of MIN_TIERS) {
    const cells = lists.map(([g, xs]) => { const v = xs.filter((x) => tierOf(x.min) === t.key); const a = heldBy(v, () => 0.95), b = heldBy(v, rentMinHoldRatio); (out.F[t.key] ??= {})[g] = { n: v.length, prev: a, now: b }; return `${g} ${a}→${b}/${v.length}`; });
    console.log(`  ${t.key.padEnd(7)} ${cells.join("・")}`);
  }
  if (args.out) { writeFileSync(String(args.out), JSON.stringify(out, null, 1)); console.log(`\n→ ${args.out}`); }
}
main().catch((e) => { console.error(e); process.exit(1); });
