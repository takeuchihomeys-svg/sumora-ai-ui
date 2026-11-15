// scripts/audit-appeal-record.ts
// 竹内さん本人の一押しの文（AIX 物件オススメの🌟・「お送りさせて頂きましたお部屋の中でも」）を訴求の記録の欄（app/lib/appeal-record.ts）に分けて数え、
// 同じ番の AI の文（aix_usage_logs.generated_text＝ツールが作った下書き）と欄ごとに合う・ずれるを出す（読むだけ・LLM なし・費用0・DB に書かない）。
//
// 2026-11-15 作業員K（統括役の OK 済み: 作る順の1と2）。
//   ① 竹内さんの🌟（recommendation_snapshots × messages.staff_writer='takeuchi'）と「お部屋の中でも」（messages）を欄に分ける
//   ② AI の文がある番だけ、竹内さんの文と欄ごとに比べる（AI の文＝その送信に結んだ aix_usage_logs の generated_text）
//   ③ 従業員の🌟も同じ物差しで並べる（竹内さんとの違いを見る）
// ■ 個人情報: 文は出さない（欄の数だけ）。YUMA は外す
// 実行: npx tsx --env-file=.env.local scripts/audit-appeal-record.ts [--days=90] [--json=path]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { appealRecordFromText, compareAppealRecords, type AppealRecord, type AppealWriter, type WantLite } from "../app/lib/appeal-record";
import { TOPIC_LABEL, customerWants } from "../app/lib/recommendation-gaps";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "90"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
type Row = Record<string, any>;
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
const chunks = <T,>(xs: T[], n: number) => { const o: T[][] = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o; };
async function all(build: (a: number, b: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < 30; p++) { const { data, error } = await build(p * 500, p * 500 + 499); if (error) throw new Error(error.message); out = out.concat(data ?? []); if (!data || data.length < 500) break; }
  return out;
}

type Pair = { kind: "star" | "naka"; writer: AppealWriter; staff: AppealRecord; ai: AppealRecord | null };

(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  // ① 🌟の回
  const snaps = (await all((a, b) => sb.from("recommendation_snapshots").select("id, conversation_id, aix_usage_log_id, star_text, customer_wants, star_name, star_room").gte("created_at", since).order("id").range(a, b) as never))
    .filter((s) => s.conversation_id !== YUMA_CONVERSATION_ID);
  const logIds = [...new Set(snaps.map((s) => String(s.aix_usage_log_id ?? "")).filter(Boolean))];
  const logs = new Map<string, Row>();
  for (const c of chunks(logIds, 100)) { const { data } = await sb.from("aix_usage_logs").select("id, line_message_id, generated_text").in("id", c); for (const r of (data ?? []) as Row[]) logs.set(String(r.id), r); }
  const lms = [...new Set([...logs.values()].map((l) => String(l.line_message_id ?? "")).filter(Boolean))];
  const msgs = new Map<string, Row>();
  for (const c of chunks(lms, 100)) { const { data } = await sb.from("messages").select("line_message_id, text, staff_writer").in("line_message_id", c); for (const r of (data ?? []) as Row[]) msgs.set(String(r.line_message_id), r); }
  const pairs: Pair[] = [];
  for (const s of snaps) {
    const l = logs.get(String(s.aix_usage_log_id ?? "")); const m = l ? msgs.get(String(l.line_message_id ?? "")) : null;
    const text = String(m?.text ?? s.star_text ?? ""); if (!text.trim()) continue;
    const writer: AppealWriter = m?.staff_writer === "takeuchi" ? "takeuchi" : m?.staff_writer === "employee" ? "employee" : "unknown";
    const wants = (Array.isArray(s.customer_wants) ? s.customer_wants : []) as WantLite[];
    const pk = s.star_name ? `${s.star_name}${s.star_room ? ` ${s.star_room}` : ""}` : null;
    const staff = appealRecordFromText(text, { surface: "aix_first", writer, wants, propertyKey: pk });
    const gen = String(l?.generated_text ?? "");
    const ai = gen.trim() ? appealRecordFromText(gen, { surface: "aix_first", writer: "ai", wants, propertyKey: pk }) : null;
    pairs.push({ kind: "star", writer, staff, ai });
  }
  // ② 「お部屋の中でも」（スタッフの送信）
  const naka = await all((a, b) => sb.from("messages").select("line_message_id, conversation_id, text, staff_writer, created_at").eq("sender", "staff").gte("created_at", since).like("text", "%お部屋の中でも%").order("id").range(a, b) as never);
  const nakaLm = naka.map((m) => String(m.line_message_id ?? "")).filter(Boolean);
  const genOf = new Map<string, string>();
  for (const c of chunks(nakaLm, 100)) { const { data } = await sb.from("aix_usage_logs").select("line_message_id, generated_text").in("line_message_id", c); for (const r of (data ?? []) as Row[]) if (r.generated_text) genOf.set(String(r.line_message_id), String(r.generated_text)); }
  // 2通目（✨ aix-template-generate）の AI の文: 同じ会話で送信の60分前〜送信までの aix_generate_log の一番新しい文
  const convIds = [...new Set(naka.map((m) => String(m.conversation_id)))];
  const gl: Row[] = [];
  for (const c of chunks(convIds, 50)) gl.push(...await all((a, b) => sb.from("aix_generate_log").select("conversation_id, generated_text, created_at, action_type").in("conversation_id", c).gte("created_at", since).order("id").range(a, b) as never));
  const glOf = new Map<string, Row[]>(); for (const g of gl) { const k = String(g.conversation_id); if (!glOf.has(k)) glOf.set(k, []); glOf.get(k)!.push(g); }
  // お客様の希望（今の条件欄から・その番の時点に巻き戻すのは次の段）
  const { data: convRows } = await sb.from("conversations").select("id, property_customer_id").in("id", convIds.slice(0, 1000));
  const pcOf = new Map<string, string>(((convRows ?? []) as Row[]).filter((r) => r.property_customer_id).map((r) => [String(r.id), String(r.property_customer_id)]));
  const pcRows = new Map<string, Row>();
  for (const c of chunks([...new Set(pcOf.values())], 100)) { const { data } = await sb.from("property_customers").select("id, rent_max, max_rent, floor_plan, walk_minutes, building_age, initial_cost_limit, pet, move_in_time, floor_area_min, preferences, ng_points, other_requests, additional_conditions").in("id", c); for (const r of (data ?? []) as Row[]) pcRows.set(String(r.id), r); }
  const wantsOfConv = (cid: string): WantLite[] => { const pc = pcRows.get(pcOf.get(cid) ?? ""); return pc ? customerWants({ conditions: pc as never }) : []; };
  const starLms = new Set([...logs.values()].map((l) => String(l.line_message_id ?? "")));
  for (const m of naka) {
    if (m.conversation_id === YUMA_CONVERSATION_ID || starLms.has(String(m.line_message_id ?? ""))) continue; // 🌟と同じ送信は①で数えた
    const writer: AppealWriter = m.staff_writer === "takeuchi" ? "takeuchi" : m.staff_writer === "employee" ? "employee" : "unknown";
    const wants = wantsOfConv(String(m.conversation_id));
    const staff = appealRecordFromText(String(m.text), { surface: "reply", writer, wants });
    const t = Date.parse(String(m.created_at));
    const near = (glOf.get(String(m.conversation_id)) ?? []).filter((g) => g.generated_text && Date.parse(g.created_at) <= t && Date.parse(g.created_at) >= t - 3600_000).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    const g = genOf.get(String(m.line_message_id ?? "")) ?? (near ? String(near.generated_text) : undefined);
    pairs.push({ kind: "naka", writer, staff, ai: g ? appealRecordFromText(g, { surface: "reply", writer: "ai", wants }) : null });
  }

  const out: Row = { days: DAYS, groups: {} };
  const dist = (xs: Pair[]) => {
    const n = xs.length; const top = new Map<string, number>(); const st = new Map<string, number>(); const aim = new Map<string, number>(); const wn = new Map<string, number>();
    let wantT = 0, wantH = 0, gap = 0, prev = 0, one = 0, withWants = 0;
    for (const p of xs) {
      for (const t of p.staff.points) top.set(t, (top.get(t) ?? 0) + 1);
      st.set(p.staff.strength, (st.get(p.staff.strength) ?? 0) + 1); aim.set(p.staff.aim, (aim.get(p.staff.aim) ?? 0) + 1);
      for (const w of p.staff.whyNow) wn.set(w, (wn.get(w) ?? 0) + 1);
      if (p.staff.fit.wantTotal) { withWants++; wantT += p.staff.fit.wantTotal; wantH += p.staff.fit.wantHit; }
      if (p.staff.fit.gapFirst) gap++; if (p.staff.relevance.prevRef) prev++; if (p.staff.relevance.oneOfMany) one++;
    }
    const fmt = (m: Map<string, number>, lab?: (k: string) => string) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${lab ? lab(k) : k} ${v}（${pct(v, n)}）`).join("・");
    return { n, points: fmt(top, (k) => TOPIC_LABEL[k as keyof typeof TOPIC_LABEL] ?? k), strength: fmt(st), aim: fmt(aim), whyNow: fmt(wn), wantHit: `${wantH}/${wantT}（${pct(wantH, wantT)}・希望がある ${withWants}回）`, gapFirst: pct(gap, n), prevRef: pct(prev, n), oneOfMany: pct(one, n) };
  };
  const cmp = (xs: Pair[]) => {
    const ys = xs.filter((p) => p.ai); const n = ys.length; if (!n) return { n: 0 };
    let ov = 0, why = 0, gap = 0, prev = 0, wn = 0, st = 0, aim = 0; const miss = new Map<string, number>(), extra = new Map<string, number>();
    for (const p of ys) { const c = compareAppealRecords(p.staff, p.ai!); ov += c.pointsOverlap; if (c.whySame) why++; if (c.gapFirstSame) gap++; if (c.prevRefSame) prev++; if (c.whyNowSame) wn++; if (c.strengthSame) st++; if (c.aimSame) aim++;
      for (const t of c.missingPoints) miss.set(t, (miss.get(t) ?? 0) + 1); for (const t of c.extraPoints) extra.set(t, (extra.get(t) ?? 0) + 1); }
    const fmt = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${TOPIC_LABEL[k as keyof typeof TOPIC_LABEL] ?? k} ${v}`).join("・");
    return { n, pointsOverlap: `${Math.round((ov / n) * 100)}%`, whySame: pct(why, n), gapFirstSame: pct(gap, n), prevRefSame: pct(prev, n), whyNowSame: pct(wn, n), strengthSame: pct(st, n), aimSame: pct(aim, n), aiMissing: fmt(miss), aiExtra: fmt(extra) };
  };
  for (const kind of ["star", "naka"] as const) for (const w of ["takeuchi", "employee"] as const) {
    const xs = pairs.filter((p) => p.kind === kind && p.writer === w);
    const lab = `${kind === "star" ? "🌟" : "お部屋の中でも"}・${w === "takeuchi" ? "竹内さん" : "従業員"}`;
    const d = dist(xs), c = cmp(xs);
    out.groups[lab] = { dist: d, cmp: c };
    console.log(`\n=== ${lab}（${d.n}通）===`);
    console.log(`  推した点: ${d.points}`);
    console.log(`  希望に応えた点: ${d.wantHit}・外れを先に ${d.gapFirst}・前のやり取りへの言及 ${d.prevRef}・束の中から1件 ${d.oneOfMany}`);
    console.log(`  今推す理由: ${d.whyNow || "（無し）"}`);
    console.log(`  強さ: ${d.strength}`);
    console.log(`  狙う返事: ${d.aim}`);
    if (c.n) console.log(`  AI の文と比べた ${c.n}通: 推した点の重なり ${c.pointsOverlap}・希望に応える点が同じ ${c.whySame}・外れを先に ${c.gapFirstSame}・前への言及 ${c.prevRefSame}・今推す理由 ${c.whyNowSame}・強さ ${c.strengthSame}・狙う返事 ${c.aimSame}\n    AI に無い点（竹内さん側だけ）: ${c.aiMissing}\n    AI だけの点: ${c.aiExtra}`);
    else console.log(`  AI の文と比べられる番 0`);
  }
  if (args.json) writeFileSync(String(args.json), JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
