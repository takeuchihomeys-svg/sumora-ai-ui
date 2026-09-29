// scripts/audit-rent-band.ts
// 「家賃帯のどこの部屋をスタッフが選んで送っているか」を実データで測る（読むだけ・DB に書かない・LLM を呼ばない）。
//
// 2026-09-29 竹内「家賃帯が低ければ低い方が良いわけではない。例えば 8万円以内なら、出来る限り 8万円に近い方が全体的に条件の良い部屋が多い。
//   家賃は相場を見て元付業者が決めている。…お客さん自体もおおよその相場を分かった上で家賃の限度額を出してきているので、その中でオススメ出来る物件を見つける」
//   （R さん: 条件 7万〜8万・上位オススメの 7件が 7万円未満。一番オススメ CityLife ディナスティ新大阪 602 は 46,000＋管理費 10,000）
//
// ■ 正解＝スタッフが選んで送った事実（feedback_property_selection_label）。お客様の返信の有無は使わない
// ■ 家賃の位置 = (家賃＋管理費) ÷ 家賃の上限（rent_max は管理費込みの決まり）。その回の時点の条件（property_condition_history で戻す）
//   上限の読み方は property-brain.buildCustomerProfile と同じ（3万未満・上限＜下限は入力誤りとして捨てる）
//   管理費が読めない候補は「家賃だけ」で比べ、adminKnown=false の印を付ける（位置が低めに出る）。表は「管理費が読めた物だけ」も出す
// ■ 材料
//   pickup … 売上サポ（property_pickups）の回。選んだ物＝status sent／sent_at／その回の後 72時間以内にお客様に届いた同じ物件
//   pool   … 拡張の回（property_candidate_pools）。選んだ物＝その回の後 72時間以内にお客様に届いた同じ建物（scoring-learning と同じ）
//   送付   … お客様に届いた全部の送付（sent_properties の customer）に、同じお客様の候補・共有の行から家賃を結ぶ
//   決まった … 申込・成約の会話（closed_won・applying・screening）で、申込期間のまとめの物件→最後の見積書の物件→最後に届いた物件の順で推定
// ■ 安さを望む人: 条件の欄（property-brain の RENT_CHEAP_RE・初期費用を抑えたい）＋その回より前のお客様の発言（安い方がいい・できれば6万 等）
// ■ 個人情報: お客様は ID の先頭8文字だけ。お客様の発言は出さない（語の種類だけ）
// ■ YUMA（テスト用の会話）は外す
//
// 実行: npx tsx --env-file=.env.local scripts/audit-rent-band.ts [--days=180] [--show=5] [--out=path.json]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { buildCustomerProfile, normalizeBuildingName, splitBuildingRoom, type CustomerLike } from "../app/lib/property-brain";
import { customerAt, sameBuilding, type ConditionHistoryRow } from "../app/lib/scoring-learning-episodes";
import { factsFromPickup } from "../app/lib/recommendation-snapshot-server";
import { isTestConversation, YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "180"), 10);
const SHOW = parseInt(String(args.show ?? "5"), 10);
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
const chunks = <T,>(xs: T[], n: number) => { const o: T[][] = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o; };
const parse = (v: unknown) => (typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v);
const num = (v: unknown) => { const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };
const short = (id: unknown) => String(id ?? "").slice(0, 8) || "?";
const half = (s: unknown) => String(s ?? "").normalize("NFKC");
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
const med = (xs: number[]) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const f1 = (x: number | null | undefined, d = 1) => (x == null ? "-" : x.toFixed(d));
const bkey = (name: unknown) => normalizeBuildingName(splitBuildingRoom(String(name ?? "")).building).replace(/[・･\-‐ー－\s]/g, "").toLowerCase();
const normRoom = (r: unknown) => half(r).replace(/号室?$/, "").replace(/^0+(?=\d)/, "").trim();

// ─── 家賃の位置の帯 ─────────────────────────────────────────────────────────
export const BANDS: Array<{ key: string; lo: number; hi: number }> = [
  { key: "<60%", lo: -Infinity, hi: 0.6 }, { key: "60-70%", lo: 0.6, hi: 0.7 }, { key: "70-80%", lo: 0.7, hi: 0.8 },
  { key: "80-85%", lo: 0.8, hi: 0.85 }, { key: "85-90%", lo: 0.85, hi: 0.9 }, { key: "90-95%", lo: 0.9, hi: 0.95 },
  { key: "95-100%", lo: 0.95, hi: 1.0 + 1e-9 }, { key: "100-110%", lo: 1.0 + 1e-9, hi: 1.1 + 1e-9 }, { key: ">110%", lo: 1.1 + 1e-9, hi: Infinity },
];
const bandOf = (r: number) => BANDS.find((b) => r >= b.lo && r < b.hi)!.key;

// ─── 安さを望む言い方（お客様の発言） ──────────────────────────────────────────
const MSG_RENT_CHEAP = /(?:家賃|賃料|月々|毎月)[^、。,\n]{0,12}(?:低い|低め|安い|安め|安く|抑え|おさえ|下げ)|安い(?:方|ほう)が|なるべく安|できるだけ安|出来るだけ安|出来る限り安|安(?:い|め)(?:の|な)?(?:物件|お部屋|部屋|所|ところ)/;
const MSG_SOFT_TARGET = /(?:できれば|出来れば|理想は|なるべく|本当は)[^。\n]{0,10}\d+(?:\.\d+)?\s*万|\d+(?:\.\d+)?\s*万(?:円)?(?:台|くらい|ぐらい|程度|前後)?(?:が理想|だと(?:嬉|うれ|助か|有難|ありがた)|に(?:抑え|おさえ)たい)/;
const MSG_INITIAL = /初期(?:費用)?[^。\n]{0,12}(?:抑え|おさえ|安く|安い|低く|少な)/;
const MSG_NEG = /こだわらない|気にしない|高くても|多少高く|上がっても/;
type CheapKind = "rent" | "soft_target" | "initial" | "form_rent" | "form_initial";

type Cand = {
  round: string; source: "pickup" | "pool"; cust: string; at: string; key: string; name: string; room: string;
  rent: number | null; admin: number | null; total: number | null; adminKnown: boolean;
  rentMax: number | null; rentMin: number | null; ratio: number | null; belowMin: boolean | null; bandPos: number | null;
  age: number | null; sqm: number | null; equip: number | null; zeroZero: boolean | null; ad: number | null;
  chosen: boolean; score: number | null; rank: number | null; codes: string[];
};

async function main() {
  const until = Date.now();
  const sinceIso = new Date(until - DAYS * D).toISOString();

  // ── お客様・履歴・会話・発言 ──
  const custs = new Map<string, Row>();
  for (const r of await all((a, b) => sb.from("property_customers").select("id, rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet, move_in_time, created_at, floor_area_min, raw_format_text, desired_area").range(a, b) as never)) custs.set(r.id, r);
  const hist = await all((a, b) => sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, created_at").range(a, b) as never);
  const histOf = new Map<string, ConditionHistoryRow[]>();
  for (const h of hist) (histOf.get(h.property_customer_id) ?? histOf.set(h.property_customer_id, []).get(h.property_customer_id)!).push(h as ConditionHistoryRow);
  const convs = await all((a, b) => sb.from("conversations").select("id, status, property_customer_id").range(a, b) as never);
  const yumaCust = new Set<string>(convs.filter((c) => c.id === YUMA_CONVERSATION_ID && c.property_customer_id).map((c) => String(c.property_customer_id)));
  const convOfCust = new Map<string, string[]>();
  for (const c of convs) if (c.property_customer_id && !isTestConversation(c.id)) (convOfCust.get(c.property_customer_id) ?? convOfCust.set(c.property_customer_id, []).get(c.property_customer_id)!).push(c.id);
  const custOfConv = new Map(convs.filter((c) => c.property_customer_id).map((c) => [String(c.id), String(c.property_customer_id)]));
  const msgs = await all((a, b) => sb.from("messages").select("conversation_id, text, created_at").eq("sender", "customer").not("text", "is", null).order("id").range(a, b) as never);
  const msgsOfCust = new Map<string, Array<{ t: number; kinds: CheapKind[] }>>();
  for (const m of msgs) {
    const pc = custOfConv.get(String(m.conversation_id)); if (!pc) continue;
    const t = half(m.text); if (MSG_NEG.test(t) && !MSG_SOFT_TARGET.test(t)) continue;
    const kinds: CheapKind[] = [];
    if (MSG_RENT_CHEAP.test(t)) kinds.push("rent");
    if (MSG_SOFT_TARGET.test(t)) kinds.push("soft_target");
    if (MSG_INITIAL.test(t)) kinds.push("initial");
    if (kinds.length) (msgsOfCust.get(pc) ?? msgsOfCust.set(pc, []).get(pc)!).push({ t: Date.parse(m.created_at), kinds });
  }
  const profileCache = new Map<string, ReturnType<typeof buildCustomerProfile> | null>();
  const profAt = (pc: string, at: string) => {
    const k = `${pc}@${at.slice(0, 13)}`;
    if (profileCache.has(k)) return profileCache.get(k)!;
    const base = custs.get(pc);
    let p: ReturnType<typeof buildCustomerProfile> | null = null;
    if (base) { const { c } = customerAt(base, histOf.get(pc) ?? [], at); p = buildCustomerProfile(c as CustomerLike, [], [], null, { today: at }); }
    profileCache.set(k, p); return p;
  };
  const cheapOf = (pc: string, at: string): CheapKind[] => {
    const p = profAt(pc, at); const out = new Set<CheapKind>();
    if (p?.written?.rentCheap) out.add("form_rent");
    if (p?.wantsLowInitialCost) out.add("form_initial");
    const t = Date.parse(at);
    for (const m of msgsOfCust.get(pc) ?? []) if (m.t <= t) m.kinds.forEach((k) => out.add(k));
    return [...out];
  };
  const cheapGroup = (kinds: CheapKind[]) => kinds.some((k) => k === "rent" || k === "soft_target" || k === "form_rent") ? "家賃を安く" : kinds.length ? "初期費用だけ" : "言っていない";

  // ── 送付（お客様に届いた物） ──
  const sends = (await all((a, b) => sb.from("sent_properties").select("property_customer_id, conversation_id, property_name, room_no, rent, source, delivery, channel, sent_at, pickup_id").gte("sent_at", new Date(until - (DAYS + 10) * D).toISOString()).order("id").range(a, b) as never))
    .filter((s) => !isTestConversation(s.conversation_id) && !yumaCust.has(String(s.property_customer_id ?? "")));
  const isCust = (s: Row) => s.delivery === "customer" || (s.delivery == null && s.source !== "line_group");
  const custSends = sends.filter(isCust);
  for (const s of custSends) if (!s.property_customer_id && s.conversation_id) s.property_customer_id = custOfConv.get(String(s.conversation_id)) ?? null;
  const custSendsOf = new Map<string, Row[]>();
  for (const s of custSends) if (s.property_customer_id) (custSendsOf.get(s.property_customer_id) ?? custSendsOf.set(s.property_customer_id, []).get(s.property_customer_id)!).push(s);

  const cands: Cand[] = [];
  const mkCand = (o: Omit<Cand, "total" | "ratio" | "belowMin" | "bandPos" | "rentMax" | "rentMin" | "adminKnown">): Cand => {
    const p = profAt(o.cust, o.at);
    const rentMax = p?.rentMax ?? null, rentMin = p?.rentMin ?? null;
    const total = o.rent != null ? o.rent + (o.admin ?? 0) : null;
    return {
      ...o, total, adminKnown: o.admin != null, rentMax, rentMin,
      ratio: total != null && rentMax ? total / rentMax : null,
      belowMin: total != null && rentMin ? total < rentMin : null,
      bandPos: total != null && rentMax && rentMin && rentMax > rentMin ? (total - rentMin) / (rentMax - rentMin) : null,
    };
  };

  // ── ① 売上サポの回 ──
  const pk = (await all((a, b) => sb.from("property_pickups").select("id, created_at, batch_id, complete_group_id, complete_rank, rank, property_customer_id, conversation_id, property_name, room_no, summary_text, pdf_text, score, reason_codes, status, sent_at, equipment").gte("created_at", sinceIso).order("id").range(a, b) as never, 200))
    .filter((r) => r.property_customer_id && !isTestConversation(r.conversation_id) && !yumaCust.has(String(r.property_customer_id)));
  const groups = new Map<string, Row[]>();
  for (const r of pk) { const k = r.complete_group_id ?? `b:${r.batch_id}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
  for (const [gid, rows] of groups) {
    const pc = String(rows[0].property_customer_id);
    const t0 = Math.min(...rows.map((r) => Date.parse(r.created_at)));
    const at = new Date(t0).toISOString();
    const win = (custSendsOf.get(pc) ?? []).filter((s) => Date.parse(s.sent_at) >= t0 - 10 * 60_000 && Date.parse(s.sent_at) <= t0 + WINDOW);
    const seen = new Set<string>();
    for (const r of rows) {
      const room = normRoom(r.room_no);
      const k = `${bkey(r.property_name)}#${room}`;
      const hit = win.some((s) => s.pickup_id === r.id || (sameBuilding(s.property_name, r.property_name) && (!s.room_no || !room || normRoom(s.room_no) === room)));
      const chosen = r.status === "sent" || !!r.sent_at || hit;
      if (seen.has(k)) { const d = cands.find((c) => c.round === `pickup:${gid}` && c.key === k); if (d && chosen) d.chosen = true; continue; }
      seen.add(k);
      let f: Row = {};
      try { f = factsFromPickup(r) as Row; } catch { /* 読めない */ }
      const eq = Array.isArray(r.equipment) ? r.equipment.length : Array.isArray(f.equipment) ? f.equipment.length : null;
      const codes = (parse(r.reason_codes) ?? []) as string[];
      cands.push(mkCand({
        round: `pickup:${gid}`, source: "pickup", cust: pc, at, key: k, name: String(r.property_name ?? ""), room,
        rent: num(f.rent), admin: num(f.admin_fee_yen), age: num(f.building_age), sqm: num(f.area_sqm), equip: eq,
        zeroZero: f.deposit_months != null && f.key_money_months != null ? f.deposit_months === 0 && f.key_money_months === 0 : null,
        ad: num(f.ad_months), chosen, score: num(r.score), rank: num(r.complete_rank) ?? num(r.rank), codes,
      }));
    }
  }

  // ── ② 拡張の回 ──
  const pools = (await all((a, b) => sb.from("property_candidate_pools").select("id, property_customer_id, candidates, sent_at").gte("sent_at", sinceIso).order("sent_at").range(a, b) as never, 200))
    .filter((p) => p.property_customer_id && !yumaCust.has(String(p.property_customer_id)));
  for (const p of pools) {
    const pc = String(p.property_customer_id);
    const raw = parse(p.candidates) as Row[] | null;
    if (!Array.isArray(raw) || raw.length < 2) continue;
    const t = Date.parse(p.sent_at);
    const win = (custSendsOf.get(pc) ?? []).filter((s) => s.property_name && Date.parse(s.sent_at) >= t - 10 * 60_000 && Date.parse(s.sent_at) <= t + WINDOW);
    if (!win.length) continue;   // 送付の無い回は比べられない（scoring-learning と同じ）
    const seen = new Set<string>();
    raw.forEach((c, i) => {
      const room = normRoom(c.room_no);
      const k = `${bkey(c.name)}#${room}`;
      if (!c.name || seen.has(k)) return;
      seen.add(k);
      const chosen = win.some((s) => sameBuilding(s.property_name, c.name) && (!s.room_no || !room || normRoom(s.room_no) === room));
      cands.push(mkCand({
        round: `pool:${p.id}`, source: "pool", cust: pc, at: new Date(t).toISOString(), key: k, name: String(c.name), room,
        rent: num(c.rent), admin: num(c.admin_fee_yen), age: num(c.building_age), sqm: num(c.area_sqm), equip: Array.isArray(c.equipment) ? c.equipment.length : null,
        zeroZero: c.deposit_months != null && c.key_money_months != null ? Number(c.deposit_months) === 0 && Number(c.key_money_months) === 0 : null,
        ad: num(c.ad_months), chosen, score: null, rank: num(c.pool_rank) ?? num(c.rank) ?? i + 1, codes: [],
      }));
    });
  }

  // ── 家賃の索引（お客様ごと・建物＋号室）: 候補＋共有の行（家賃だけ） ──
  const idx = new Map<string, Array<{ name: string; room: string; rent: number; admin: number | null; age: number | null; sqm: number | null }>>();
  const put = (pc: string, name: string, room: string, rent: number | null, admin: number | null, age: number | null, sqm: number | null) => {
    if (rent == null || rent < 15000) return;
    (idx.get(pc) ?? idx.set(pc, []).get(pc)!).push({ name, room, rent, admin, age, sqm });
  };
  for (const c of cands) put(c.cust, c.name, c.room, c.rent, c.admin, c.age, c.sqm);
  for (const s of sends) if (s.property_customer_id) put(String(s.property_customer_id), String(s.property_name ?? ""), normRoom(s.room_no), num(s.rent), null, null, null);
  const lookup = (pc: string, name: string, room: string) => {
    const xs = (idx.get(pc) ?? []).filter((x) => sameBuilding(x.name, name) && (!room || !x.room || x.room === room));
    if (!xs.length) return null;
    const withAdm = xs.find((x) => x.admin != null && (!room || x.room === room)) ?? xs.find((x) => x.admin != null);
    const best = withAdm ?? xs[0];
    return { rent: best.rent, admin: best.admin, age: xs.find((x) => x.age != null)?.age ?? null, sqm: xs.find((x) => x.sqm != null)?.sqm ?? null };
  };

  // ─── 表を出す ────────────────────────────────────────────────────────────
  const out: Row = { days: DAYS, generated_at: new Date().toISOString() };
  const bandTable = (title: string, groupsIn: Array<[string, Cand[] | Array<{ ratio: number | null }>]>) => {
    console.log(`\n■ ${title}`);
    console.log(["帯（家賃＋管理費÷上限）".padEnd(14), ...groupsIn.map(([g, xs]) => `${g}(${xs.filter((x) => x.ratio != null).length})`.padStart(16))].join(""));
    const res: Row = {};
    for (const b of BANDS) {
      const cells = groupsIn.map(([g, xs]) => { const v = xs.filter((x) => x.ratio != null); const n = v.filter((x) => bandOf(x.ratio!) === b.key).length; (res[g] ??= {})[b.key] = n; return `${n} ${pct(n, v.length)}`.padStart(16); });
      console.log([b.key.padEnd(14), ...cells].join(""));
    }
    const sums = groupsIn.map(([g, xs]) => { const v = xs.filter((x) => x.ratio != null).map((x) => x.ratio!); const within = v.filter((r) => r <= 1.0 + 1e-9); const top = within.filter((r) => r >= 0.85).length; (res[g] ??= {}).median = med(v); (res[g]).upper85_of_within = within.length ? top / within.length : null; return `中央${f1(med(v), 2)}／上限内の85%以上 ${pct(top, within.length)}`.padStart(16); });
    console.log(["要約".padEnd(14), ...sums].join("  "));
    return res;
  };

  // ── A. 回ごとの選んだ物 vs 選ばなかった物 ──
  const rounds = new Map<string, Cand[]>();
  for (const c of cands) (rounds.get(c.round) ?? rounds.set(c.round, []).get(c.round)!).push(c);
  const usable = [...rounds.values()].filter((xs) => xs.some((c) => c.chosen && c.ratio != null) && xs.some((c) => !c.chosen && c.ratio != null));
  const uc = usable.flat().filter((c) => c.ratio != null);
  console.log(`\n=== 家賃帯の監査（${DAYS}日・読むだけ） ===`);
  console.log(`候補 ${cands.length}（家賃あり ${cands.filter((c) => c.ratio != null).length}・管理費まで読めた ${cands.filter((c) => c.ratio != null && c.adminKnown).length}）／比べられる回 ${usable.length}（売上サポ ${usable.filter((r) => r[0].source === "pickup").length}・拡張 ${usable.filter((r) => r[0].source === "pool").length}）・お客様 ${new Set(usable.map((r) => r[0].cust)).size}`);
  { const per = new Map<string, number>(); for (const r of usable) per.set(short(r[0].cust), (per.get(short(r[0].cust)) ?? 0) + 1);
    console.log(`  回の多いお客様: ${[...per.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} ${n}回`).join("・")}`);
    out.A_rounds_per_customer = Object.fromEntries(per); }
  out.A_all = bandTable("A. 比べられる回: 選んで送った物 vs 送らなかった物（全部）", [["選んだ", uc.filter((c) => c.chosen)], ["選ばない", uc.filter((c) => !c.chosen)]]);
  const ucAdm = uc.filter((c) => c.adminKnown);
  out.A_admin = bandTable("A'. 同じ・管理費まで読めた候補だけ", [["選んだ", ucAdm.filter((c) => c.chosen)], ["選ばない", ucAdm.filter((c) => !c.chosen)]]);
  for (const src of ["pickup", "pool"] as const) {
    const x = uc.filter((c) => c.source === src);
    out[`A_${src}`] = bandTable(`A-${src === "pickup" ? "売上サポ" : "拡張"}`, [["選んだ", x.filter((c) => c.chosen)], ["選ばない", x.filter((c) => !c.chosen)]]);
  }

  // 帯ごとの「選ばれる率」と比（lift）
  console.log("\n■ 帯ごとの選ばれる率（上限内の回・全部）と lift（選んだ物の割合 ÷ 候補の割合）");
  const liftRes: Row = {};
  const ucIn = uc;
  const nC = ucIn.filter((c) => c.chosen).length, nAll = ucIn.length;
  for (const b of BANDS) {
    const inB = ucIn.filter((c) => bandOf(c.ratio!) === b.key); const ch = inB.filter((c) => c.chosen).length;
    const lift = nAll && nC && inB.length ? (ch / nC) / (inB.length / nAll) : null;
    liftRes[b.key] = { n: inB.length, chosen: ch, rate: inB.length ? ch / inB.length : null, lift };
    console.log(`  ${b.key.padEnd(10)} 候補 ${String(inB.length).padStart(5)}  選んだ ${String(ch).padStart(4)}  率 ${pct(ch, inB.length).padStart(4)}  lift ${f1(lift, 2)}`);
  }
  out.A_lift = liftRes;

  // 回の中の順位（0=その回で一番安い・1=一番高い）
  const within = (xs: Cand[]) => {
    const v = xs.filter((c) => c.ratio != null && c.ratio <= 1.1 + 1e-9);
    if (v.length < 3 || !v.some((c) => c.chosen) || !v.some((c) => !c.chosen)) return null;
    const sorted = [...v].sort((a, b) => a.total! - b.total!);
    const pos = (c: Cand) => { const lo = sorted.findIndex((x) => x.total === c.total); const hi = sorted.length - 1 - [...sorted].reverse().findIndex((x) => x.total === c.total); return ((lo + hi) / 2) / (sorted.length - 1); };
    return { chosen: v.filter((c) => c.chosen).map(pos), others: v.filter((c) => !c.chosen).map(pos), cust: v[0].cust, at: v[0].at, src: v[0].source };
  };
  const wr = usable.map(within).filter(Boolean) as Array<{ chosen: number[]; others: number[]; cust: string; at: string; src: string }>;
  const byGroup = new Map<string, number[]>();
  const roundGroup = new Map<string, string>();
  for (const r of usable) roundGroup.set(r[0].round, cheapGroup(cheapOf(r[0].cust, r[0].at)));
  console.log("\n■ 回の中の家賃の順位（0＝その回で一番安い・1＝一番高い・上限の110%以内の候補・3件以上の回）");
  for (const [i, r] of usable.entries()) { const w = within(r); if (!w) continue; const g = roundGroup.get(r[0].round)!; (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(...w.chosen); (byGroup.get("全部") ?? byGroup.set("全部", []).get("全部")!).push(...w.chosen); void i; }
  out.A_within = {};
  for (const [g, xs] of byGroup) {
    const top = xs.filter((x) => x >= 2 / 3).length, bot = xs.filter((x) => x < 1 / 3).length;
    out.A_within[g] = { n: xs.length, mean: mean(xs), top_third: top / xs.length, bottom_third: bot / xs.length };
    console.log(`  ${g.padEnd(8)} 選んだ ${String(xs.length).padStart(4)}件  平均 ${f1(mean(xs), 2)}  上の1/3 ${pct(top, xs.length)}  下の1/3 ${pct(bot, xs.length)}  （偶然なら 0.50・33%・33%）`);
  }
  console.log(`  回の数 ${wr.length}（売上サポ ${wr.filter((w) => w.src === "pickup").length}・拡張 ${wr.filter((w) => w.src === "pool").length}）`);

  // ── A2. 安さを望む人とそうでない人 ──
  const grp = (c: Cand) => roundGroup.get(c.round) ?? cheapGroup(cheapOf(c.cust, c.at));
  out.A_group = {};
  for (const g of ["言っていない", "初期費用だけ", "家賃を安く"]) {
    const x = uc.filter((c) => grp(c) === g);
    console.log(`\n  （${g}: お客様 ${new Set(x.map((c) => c.cust)).size}人・回 ${new Set(x.map((c) => c.round)).size}）`);
    out.A_group[g] = bandTable(`A2. ${g}`, [["選んだ", x.filter((c) => c.chosen)], ["選ばない", x.filter((c) => !c.chosen)]]);
  }

  // ── A3. 下限との関係 ──
  console.log("\n■ A3. 下限がある人: 下限未満の物件（家賃＋管理費 < 下限）");
  const withMin = uc.filter((c) => c.rentMin != null);
  const bm = (xs: Cand[]) => `${xs.filter((c) => c.belowMin).length}/${xs.length} ${pct(xs.filter((c) => c.belowMin).length, xs.length)}`;
  console.log(`  選んだ ${bm(withMin.filter((c) => c.chosen))}  選ばない ${bm(withMin.filter((c) => !c.chosen))}  （お客様 ${new Set(withMin.map((c) => c.cust)).size}人）`);
  const bp = (xs: Cand[]) => { const v = xs.filter((c) => c.bandPos != null).map((c) => c.bandPos!); return `中央 ${f1(med(v), 2)}・0〜1 の内 ${pct(v.filter((x) => x >= 0 && x <= 1).length, v.length)}・0 未満 ${pct(v.filter((x) => x < 0).length, v.length)}`; };
  console.log(`  下限〜上限の中の位置（0＝下限・1＝上限）  選んだ ${bp(withMin.filter((c) => c.chosen))}／選ばない ${bp(withMin.filter((c) => !c.chosen))}`);
  out.A_min = { chosen: withMin.filter((c) => c.chosen).length, chosen_below: withMin.filter((c) => c.chosen && c.belowMin).length, others: withMin.filter((c) => !c.chosen).length, others_below: withMin.filter((c) => !c.chosen && c.belowMin).length };

  // ── B. お客様に届いた全部の送付 ──
  const sentPos: Array<{ ratio: number | null; adminKnown: boolean; cust: string; group: string; belowMin: boolean | null }> = [];
  const seenSend = new Set<string>();
  let noFacts = 0;
  for (const s of custSends) {
    const pc = s.property_customer_id ? String(s.property_customer_id) : null; if (!pc || !s.property_name) continue;
    if (Date.parse(s.sent_at) < until - DAYS * D) continue;
    const k = `${pc}|${bkey(s.property_name)}#${normRoom(s.room_no)}`; if (seenSend.has(k)) continue; seenSend.add(k);
    const f = num(s.rent) != null ? { rent: num(s.rent)!, admin: null as number | null } : lookup(pc, String(s.property_name), normRoom(s.room_no));
    const fx = f && f.admin == null ? lookup(pc, String(s.property_name), normRoom(s.room_no)) ?? f : f;
    if (!fx) { noFacts++; continue; }
    const p = profAt(pc, s.sent_at); if (!p?.rentMax) continue;
    const total = fx.rent + (fx.admin ?? 0);
    sentPos.push({ ratio: total / p.rentMax, adminKnown: fx.admin != null, cust: pc, group: cheapGroup(cheapOf(pc, s.sent_at)), belowMin: p.rentMin ? total < p.rentMin : null });
  }
  console.log(`\n=== B. お客様に届いた送付（物件ごとに1回・家賃が結べた物 ${sentPos.length}・結べない ${noFacts}・お客様 ${new Set(sentPos.map((x) => x.cust)).size}人） ===`);
  out.B = bandTable("B. 届いた送付の家賃の位置", [["全部", sentPos], ["管理費あり", sentPos.filter((x) => x.adminKnown)], ["言っていない", sentPos.filter((x) => x.group === "言っていない")], ["家賃を安く", sentPos.filter((x) => x.group === "家賃を安く")]]);
  // お客様ごとの中央値（人の数で見る）
  const perCust = new Map<string, number[]>();
  for (const x of sentPos) (perCust.get(x.cust) ?? perCust.set(x.cust, []).get(x.cust)!).push(x.ratio!);
  const custMeds = [...perCust.values()].filter((v) => v.length >= 3).map((v) => med(v)!);
  console.log(`  お客様ごとの中央値（3件以上 ${custMeds.length}人）: 中央 ${f1(med(custMeds), 2)}・0.85 以上の人 ${pct(custMeds.filter((m) => m >= 0.85).length, custMeds.length)}・0.75 未満の人 ${pct(custMeds.filter((m) => m < 0.75).length, custMeds.length)}`);
  out.B_cust = { n: custMeds.length, median: med(custMeds), ge85: custMeds.filter((m) => m >= 0.85).length, lt75: custMeds.filter((m) => m < 0.75).length };

  // ── C. 申込・成約で決まった物件 ──
  const apply = await all((a, b) => sb.from("apply_period_summaries").select("conversation_id, summary_json, created_at").range(a, b) as never);
  const est = await all((a, b) => sb.from("estimate_records").select("conversation_id, property_customer_id, property_name, room_no, estimated_at, created_at").range(a, b) as never);
  const decided: Array<{ conv: string; status: string; how: string; name: string; ratio: number | null; adminKnown: boolean; belowMin: boolean | null; group: string; total: number | null; rentMax: number | null }> = [];
  for (const c of convs.filter((c) => ["closed_won", "applying", "screening", "contract"].includes(c.status) && c.property_customer_id && !isTestConversation(c.id))) {
    const pc = String(c.property_customer_id);
    let name: string | null = null, room = "", how = "", at = new Date().toISOString();
    const ap = apply.find((a) => a.conversation_id === c.id && Array.isArray(parse(a.summary_json)?.properties) && parse(a.summary_json).properties.length);
    if (ap) { name = String(parse(ap.summary_json).properties[0]); how = "申込のまとめ"; at = ap.created_at; }
    if (!name) { const e = est.filter((e) => e.conversation_id === c.id && e.property_name).sort((a, b) => Date.parse(b.estimated_at ?? b.created_at) - Date.parse(a.estimated_at ?? a.created_at))[0]; if (e) { name = e.property_name; room = normRoom(e.room_no); how = "最後の見積書"; at = e.estimated_at ?? e.created_at; } }
    if (!name) { const s = (custSendsOf.get(pc) ?? []).filter((s) => s.property_name).sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at))[0]; if (s) { name = s.property_name; room = normRoom(s.room_no); how = "最後に届いた物件"; at = s.sent_at; } }
    if (!name) continue;
    const f = lookup(pc, name, room);
    const p = profAt(pc, at);
    const total = f ? f.rent + (f.admin ?? 0) : null;
    decided.push({ conv: short(c.id), status: c.status, how, name, total, rentMax: p?.rentMax ?? null, ratio: total != null && p?.rentMax ? total / p.rentMax : null, adminKnown: f?.admin != null, belowMin: total != null && p?.rentMin ? total < p.rentMin : null, group: cheapGroup(cheapOf(pc, at)) });
  }
  console.log(`\n=== C. 申込・成約の会話で決まった物件（推定・会話 ${decided.length}・家賃が結べた ${decided.filter((d) => d.ratio != null).length}） ===`);
  out.C = bandTable("C. 決まった物件の家賃の位置", [["全部", decided], ["成約", decided.filter((d) => d.status === "closed_won")], ["言っていない", decided.filter((d) => d.group === "言っていない")]]);
  for (const d of decided.filter((d) => d.ratio != null)) console.log(`  ${d.conv} ${d.status.padEnd(10)} ${d.how.padEnd(8)} ${d.name.slice(0, 22).padEnd(22)} 計${d.total} ÷ 上限${d.rentMax} = ${f1(d.ratio, 2)}${d.adminKnown ? "" : "（管理費不明）"}${d.belowMin ? "・下限未満" : ""}・${d.group}`);
  out.C_rows = decided;

  // ── B2・C2. 🌟（スタッフが一番に推した物件）の本文の家賃（本文の「家賃N円・管理費M円（合計X円）」を読む） ──
  //   🌟の本文は家賃と管理費を必ず書く（2026-06〜）ので、候補に家賃の無い会話でも位置が出せる。
  //   決まった物件（C2）＝申込・成約の会話で、申込の印（「番手にて受理」「お申込み完了」等のこちらの文）の直前の🌟
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
    const admNone = /(?:管理費|共益費)\s*(?:なし|無し|0円)/.test(t);
    const r = rent ? +rent[1] : null;
    const total = sum ? +sum[1] : r != null ? r + (adm ? +adm[1] : 0) : null;
    return { name, rent: r, total: total != null && total >= 15000 && total <= 1_000_000 ? total : null, adminKnown: !!sum || !!adm || admNone };
  };
  const starRows: Array<{ conv: string; pc: string; at: string; name: string; total: number; ratio: number | null; belowMin: boolean | null; group: string; adminKnown: boolean; rentMax: number | null }> = [];
  for (const m of staffStar) {
    if (isTestConversation(m.conversation_id)) continue;
    const pc = custOfConv.get(String(m.conversation_id)); if (!pc || yumaCust.has(pc)) continue;
    if (Date.parse(m.created_at) < until - DAYS * D) continue;
    if (!/^\s*🌟/u.test(half(m.text))) continue;           // 🌟で始まる推しの文だけ（一覧の中の🌟は数えない）
    const s = readStar(String(m.text)); if (s.total == null) continue;
    const p = profAt(pc, m.created_at); const rentMax = p?.rentMax ?? null;
    starRows.push({ conv: String(m.conversation_id), pc, at: m.created_at, name: s.name, total: s.total, ratio: rentMax ? s.total / rentMax : null, belowMin: p?.rentMin ? s.total < p.rentMin : null, group: cheapGroup(cheapOf(pc, m.created_at)), adminKnown: s.adminKnown, rentMax });
  }
  // 同じ会話・同じ物件の🌟は1回に
  const starU = [...new Map(starRows.map((r) => [`${r.conv}|${bkey(r.name)}`, r])).values()];
  console.log(`\n=== B2. 🌟（スタッフが一番に推した物件・本文の家賃）: ${starU.length}件・会話 ${new Set(starU.map((r) => r.conv)).size}（上限あり ${starU.filter((r) => r.ratio != null).length}） ===`);
  out.B2 = bandTable("B2. 🌟の家賃の位置", [["全部", starU], ["言っていない", starU.filter((r) => r.group === "言っていない")], ["初期費用だけ", starU.filter((r) => r.group === "初期費用だけ")], ["家賃を安く", starU.filter((r) => r.group === "家賃を安く")]]);
  const sw = starU.filter((r) => r.rentMax != null && r.belowMin != null);
  console.log(`  下限がある人の🌟: 下限未満 ${sw.filter((r) => r.belowMin).length}/${sw.length}`);
  const starPerCust = new Map<string, number[]>(); for (const r of starU) if (r.ratio != null) (starPerCust.get(r.pc) ?? starPerCust.set(r.pc, []).get(r.pc)!).push(r.ratio);
  const sMeds = [...starPerCust.values()].map((v) => med(v)!);
  console.log(`  お客様ごとの🌟の中央値（${sMeds.length}人）: 中央 ${f1(med(sMeds), 2)}・0.85 以上の人 ${pct(sMeds.filter((m) => m >= 0.85).length, sMeds.length)}・0.75 未満の人 ${pct(sMeds.filter((m) => m < 0.75).length, sMeds.length)}`);
  out.B2_cust = { n: sMeds.length, median: med(sMeds), ge85: sMeds.filter((m) => m >= 0.85).length, lt75: sMeds.filter((m) => m < 0.75).length };

  const decided2: typeof starU = [];
  for (const c of convs.filter((c) => ["closed_won", "applying", "screening", "contract"].includes(c.status) && c.property_customer_id && !isTestConversation(c.id))) {
    const mark = applyMark.filter((m) => m.conversation_id === c.id && APPLY_RE.test(half(m.text))).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
    const cut = mark ? Date.parse(mark.created_at) : Infinity;
    const last = starRows.filter((r) => r.conv === c.id && Date.parse(r.at) <= cut).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    if (last) decided2.push({ ...last, conv: `${c.status}:${mark ? "印あり" : "印なし"}:${short(c.id)}` });
  }
  console.log(`\n=== C2. 申込・成約の会話で申込の直前の🌟（決まった物件の推定・${decided2.length}会話・申込の印あり ${decided2.filter((d) => d.conv.includes("印あり")).length}） ===`);
  out.C2 = bandTable("C2. 決まった物件（申込の直前の🌟）の家賃の位置", [["全部", decided2], ["印あり", decided2.filter((d) => d.conv.includes("印あり"))], ["言っていない", decided2.filter((d) => d.group === "言っていない")]]);
  for (const d of decided2) console.log(`  ${d.conv.padEnd(26)} ${d.name.slice(0, 20).padEnd(20)} 計${d.total} ÷ 上限${d.rentMax ?? "?"} = ${f1(d.ratio, 2)}${d.belowMin ? "・下限未満" : ""}・${d.group}`);
  out.C2_rows = decided2.map(({ pc: _pc, ...r }) => r);

  // ── D. 家賃の位置と質（築年・広さ・設備） ──
  console.log("\n=== D. 家賃の位置と質（同じ回の中央値との差・上限の110%以内・管理費不明も含む） ===");
  const dRows: Row = {};
  const roundMed = new Map<string, { age: number | null; sqm: number | null; equip: number | null }>();
  for (const [rid, xs] of rounds) roundMed.set(rid, { age: med(xs.map((c) => c.age!).filter((v) => v != null)), sqm: med(xs.map((c) => c.sqm!).filter((v) => v != null)), equip: med(xs.map((c) => c.equip!).filter((v) => v != null)) });
  console.log("帯".padEnd(10) + "件".padStart(6) + "築年(中央)".padStart(12) + "築年差".padStart(8) + "㎡(中央)".padStart(10) + "㎡差".padStart(8) + "設備数".padStart(8) + "設備差".padStart(8) + "敷礼0".padStart(8) + "AD(中央)".padStart(9));
  const allWithRatio = cands.filter((c) => c.ratio != null);
  for (const b of BANDS) {
    const x = allWithRatio.filter((c) => bandOf(c.ratio!) === b.key); if (!x.length) continue;
    const rm = (c: Cand, k: "age" | "sqm" | "equip") => { const m = roundMed.get(c.round)?.[k]; return c[k] != null && m != null ? c[k]! - m : null; };
    const ages = x.map((c) => c.age).filter((v): v is number => v != null), sqms = x.map((c) => c.sqm).filter((v): v is number => v != null), eqs = x.map((c) => c.equip).filter((v): v is number => v != null);
    const dA = x.map((c) => rm(c, "age")).filter((v): v is number => v != null), dS = x.map((c) => rm(c, "sqm")).filter((v): v is number => v != null), dE = x.map((c) => rm(c, "equip")).filter((v): v is number => v != null);
    const zz = x.filter((c) => c.zeroZero != null); const ads = x.map((c) => c.ad).filter((v): v is number => v != null);
    dRows[b.key] = { n: x.length, age: med(ages), age_diff: mean(dA), sqm: med(sqms), sqm_diff: mean(dS), equip: med(eqs), equip_diff: mean(dE), zero_zero: zz.length ? zz.filter((c) => c.zeroZero).length / zz.length : null, ad: med(ads), n_age: ages.length, n_sqm: sqms.length, n_equip: eqs.length };
    console.log(b.key.padEnd(10) + String(x.length).padStart(6) + `${f1(med(ages), 0)}(${ages.length})`.padStart(12) + f1(mean(dA), 1).padStart(8) + `${f1(med(sqms), 1)}(${sqms.length})`.padStart(10) + f1(mean(dS), 1).padStart(8) + `${f1(med(eqs), 0)}(${eqs.length})`.padStart(8) + f1(mean(dE), 1).padStart(8) + pct(zz.filter((c) => c.zeroZero).length, zz.length).padStart(8) + f1(med(ads), 1).padStart(9));
  }
  out.D = dRows;
  // 回の中の相関（家賃の順位と築年・広さの順位）
  const spearman = (pairs: Array<[number, number]>) => {
    if (pairs.length < 4) return null;
    const rk = (xs: number[]) => { const s = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]); const r = new Array(xs.length); for (let i = 0; i < s.length;) { let j = i; while (j + 1 < s.length && s[j + 1][0] === s[i][0]) j++; for (let k = i; k <= j; k++) r[s[k][1]] = (i + j) / 2; i = j + 1; } return r as number[]; };
    const a = rk(pairs.map((p) => p[0])), b = rk(pairs.map((p) => p[1])); const ma = mean(a)!, mb = mean(b)!;
    let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return da && db ? n / Math.sqrt(da * db) : null;
  };
  const corr = (k: "age" | "sqm" | "equip") => { const rs: number[] = []; for (const xs of rounds.values()) { const v = xs.filter((c) => c.total != null && c[k] != null && (c.ratio ?? 0) <= 1.1 + 1e-9).map((c) => [c.total!, c[k]!] as [number, number]); const r = spearman(v); if (r != null) rs.push(r); } return { n: rs.length, median: med(rs), mean: mean(rs) }; };
  out.D_corr = { age: corr("age"), sqm: corr("sqm"), equip: corr("equip") };
  console.log(`  回の中の順位相関（家賃↑と…・4件以上の回）: 築年 ${f1(out.D_corr.age.median, 2)}（${out.D_corr.age.n}回・負＝高いほど新しい）／広さ ${f1(out.D_corr.sqm.median, 2)}（${out.D_corr.sqm.n}回）／設備数 ${f1(out.D_corr.equip.median, 2)}（${out.D_corr.equip.n}回）`);

  // ── E. 今の点は家賃の位置をどう見ているか（売上サポの保存の点） ──
  const scored = cands.filter((c) => c.source === "pickup" && c.score != null && c.ratio != null && c.ratio <= 1.0 + 1e-9);
  const sc: Row = {};
  console.log("\n=== E. 売上サポの保存の点（上限内）: 帯ごとの点の中央値・点の順位 1〜5 位に入る率 ===");
  const topN = new Set<string>();
  for (const [rid, xs] of rounds) if (xs[0].source === "pickup") [...xs].filter((c) => c.score != null).sort((a, b) => b.score! - a.score!).slice(0, 5).forEach((c) => topN.add(`${rid}|${c.key}`));
  for (const b of BANDS) { const x = scored.filter((c) => bandOf(c.ratio!) === b.key); if (!x.length) continue; const t = x.filter((c) => topN.has(`${c.round}|${c.key}`)).length; sc[b.key] = { n: x.length, score_median: med(x.map((c) => c.score!)), top5: t / x.length, chosen: x.filter((c) => c.chosen).length }; console.log(`  ${b.key.padEnd(10)} ${String(x.length).padStart(4)}件  点(中央) ${f1(med(x.map((c) => c.score!)), 0).padStart(4)}  上位5 ${pct(t, x.length).padStart(4)}  選んだ ${x.filter((c) => c.chosen).length}`); }
  const spE: number[] = []; for (const xs of rounds.values()) { if (xs[0].source !== "pickup") continue; const r = spearman(xs.filter((c) => c.score != null && c.total != null && (c.ratio ?? 0) <= 1.0 + 1e-9).map((c) => [c.total!, c.score!] as [number, number])); if (r != null) spE.push(r); }
  console.log(`  回の中の順位相関（家賃↑と点↑）: 中央 ${f1(med(spE), 2)}（${spE.length}回・負＝安いほど点が高い）`);
  out.E = { bands: sc, corr_median: med(spE), corr_n: spE.length };

  // ── 代表例: R さんの回・安い物が選ばれた回 ──
  console.log("\n=== 代表例 ===");
  const rRound = [...rounds.entries()].find(([rid]) => rid.includes("cg_5a1f7ae9_1772"));
  if (rRound) {
    const [rid, xs] = rRound;
    console.log(`■ R さんの回（${rid}・お客様 ${short(xs[0].cust)}・上限 ${xs[0].rentMax}・下限 ${xs[0].rentMin}・${cheapGroup(cheapOf(xs[0].cust, xs[0].at))}・${cheapOf(xs[0].cust, xs[0].at).join("/") || "なし"}）`);
    for (const c of [...xs].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, 27)) {
      const rc = c.codes.filter((k) => /^RENT_|^AD_|ZERO_ZERO|AGE_|SQM|FLOOR_PLAN/.test(k)).join(",");
      console.log(`  点${String(c.score ?? "-").padStart(4)} 順${String(c.rank ?? "-").padStart(3)} ${c.name.slice(0, 20).padEnd(20)} ${c.room.padEnd(5)} ${c.rent ?? "?"}+${c.admin ?? "?"}=${c.total ?? "?"}（${f1(c.ratio, 2)}） 築${c.age ?? "?"} ${c.sqm ?? "?"}㎡ AD${c.ad ?? "?"}${c.chosen ? " ★送った" : ""}  ${rc}`);
    }
    out.R_round = xs.map((c) => ({ name: c.name, room: c.room, rent: c.rent, admin: c.admin, ratio: c.ratio, age: c.age, sqm: c.sqm, ad: c.ad, score: c.score, chosen: c.chosen, codes: c.codes }));
  }
  // 選んだ物が上限寄り／安い側の回を数件
  const ex = wr.map((w, i) => ({ w, i })).slice(0, 0); void ex;
  const exRounds = usable.filter((xs) => xs.length >= 4).map((xs) => ({ xs, w: within(xs) })).filter((o) => o.w);
  const lowPick = exRounds.filter((o) => mean(o.w!.chosen)! < 0.34).slice(0, SHOW), highPick = exRounds.filter((o) => mean(o.w!.chosen)! > 0.66).slice(0, SHOW);
  for (const [lab, list] of [["安い側を選んだ回", lowPick], ["上限寄りを選んだ回", highPick]] as const) {
    console.log(`■ ${lab}（${lab === "安い側を選んだ回" ? exRounds.filter((o) => mean(o.w!.chosen)! < 0.34).length : exRounds.filter((o) => mean(o.w!.chosen)! > 0.66).length}回中 ${list.length}）`);
    for (const { xs } of list) {
      const x0 = xs[0];
      const ch = xs.filter((c) => c.chosen && c.ratio != null).map((c) => `${c.name.slice(0, 14)} ${c.total}(${f1(c.ratio, 2)}) 築${c.age ?? "?"} ${c.sqm ?? "?"}㎡`).join(" / ");
      const rs = xs.filter((c) => c.ratio != null).map((c) => c.ratio!);
      console.log(`  ${x0.round.slice(0, 26)} ${short(x0.cust)} 上限${x0.rentMax} 候補${rs.length}（位置 ${f1(Math.min(...rs), 2)}〜${f1(Math.max(...rs), 2)}）${cheapGroup(cheapOf(x0.cust, x0.at))}: ${ch}`);
    }
  }

  if (args.out) { writeFileSync(String(args.out), JSON.stringify(out, null, 2)); console.log(`\n→ ${args.out}`); }
}

main().catch((e) => { console.error(e); process.exit(1); });
