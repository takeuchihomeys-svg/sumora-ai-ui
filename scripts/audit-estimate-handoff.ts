// 見積書ツールへの連携（LINE → 見積書作成）を作る前の実測（読み取りのみ・LLM は呼ばない）
// 2026-10-01 竹内「見積書きかれたら LINE のところに見積書のがでて押したら見積書のツールに連携・送った物件がセットされた状態で
//   見積書つくれるようにして AD も分かるようにすれば割引金額と最終確認だけスタッフがおこなえばスムーズ」
//
// 測ること（直近 DAYS 日・YUMA を除く）:
//   ① 見積書の数（AIX【見積書送る】で本文に【物件】か「円割引」がある通＝見積書そのもの。カバーレターだけの通は数えない）／日
//      見積書ツールの読み取り（llm_usage_logs route=/api/extract-estimate-info）／日
//   ② お客様の依頼（見積・初期費用の発言）→ 見積書を送るまでの時間
//   ③ 見積書の物件はどこから来たか: こちらが送った（sent_properties の customer 行・売上サポ）／お客様が持ち込んだ（画像・URL）／分からない
//      AD が分かるか（property_pickups の ad_yen・sent_properties の ad_months（共有の行も含む））
//   ④ スタッフが手で入れている物: 入居日（日割の注記が無い＝入居日を入れた）・割引（円割引の有無）・割引の中央値・割引/AD
//   ⑤ 物件の送付と一緒の見積書: 見積書の前 N 分以内に物件の送付（AIX 物件ピックアップ・オススメ・物件確認・スタッフの画像）があり、
//      見積書の物件がその送付の物件か。初期費用を抑えたい（条件の列・発言）お客様で割合が違うか
//
// 実行: npx tsx --env-file=.env.local scripts/audit-estimate-handoff.ts   （DAYS=120・TOGETHER_MIN=30）
import { createClient } from "@supabase/supabase-js";
import { parseEstimateItems } from "../app/lib/estimate-profit";
import { matchKnownProperty, MATCH_MIN_SCORE } from "../app/lib/property-name-match";
import { FOCUSED_ESTIMATE_ASK_RE } from "../app/lib/focused-estimate-request";
import { wantsLowInitialCostText } from "../app/lib/estimate-handoff";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const DAYS = Number(process.env.DAYS ?? 120);
const TOGETHER_MIN = Number(process.env.TOGETHER_MIN ?? 30);
const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : "—");
const qs = (xs: number[]) => { if (!xs.length) return "—"; const s = [...xs].sort((a, b) => a - b); const q = (p: number) => s[Math.floor((s.length - 1) * p)]; return `中央値 ${q(0.5)}・Q1 ${q(0.25)}・Q3 ${q(0.75)}（n=${s.length}）`; };
const ASK_RE = new RegExp(`${FOCUSED_ESTIMATE_ASK_RE.source}|見積|初期費用`);
const jstDay = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(0, 10);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function page(table: string, cols: string, extra: (q: any) => any, tcol = "created_at"): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  for (let p = 0; p < 200; p++) {
    const { data, error } = await extra(sb.from(table).select(cols).order(tcol).range(p * 1000, p * 1000 + 999));
    if (error) { console.error(table, error.message); break; }
    out.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  const aix = await page("aix_usage_logs", "id, conversation_id, aix_type, created_at, generated_text, previous_action_type", (q) => q.gte("created_at", since).neq("conversation_id", YUMA));
  const est = aix.filter((r) => r.aix_type === "estimate_sheet" && parseEstimateItems(r.generated_text).some((it) => it.propertyName || it.discountYen != null));
  const sends = aix.filter((r) => ["property_send", "property_recommendation", "property_check_result"].includes(r.aix_type));
  console.log(`\n① 見積書（AIX 見積書送る・本文あり）${est.length}通 / ${new Set(est.map((r) => r.conversation_id)).size}会話（${DAYS}日）`);
  const perDay = new Map<string, number>();
  for (const r of est) perDay.set(jstDay(r.created_at), (perDay.get(jstDay(r.created_at)) ?? 0) + 1);
  const days = [...perDay.values()];
  console.log(`  送った日 ${days.length}日・1日あたり ${qs(days)}・暦日平均 ${(est.length / DAYS).toFixed(2)}`);
  const ext = await page("llm_usage_logs", "created_at, env", (q) => q.eq("route", "/api/extract-estimate-info").gte("created_at", since));
  const extDays = new Map<string, number>();
  for (const r of ext.filter((x) => x.env === "production")) extDays.set(jstDay(r.created_at), (extDays.get(jstDay(r.created_at)) ?? 0) + 1);
  console.log(`  見積書ツールの AI 読み取り（本番・記録は 9/15〜）${[...extDays.values()].reduce((a, b) => a + b, 0)}回・${extDays.size}日・1日 ${qs([...extDays.values()])}`);

  // 会話 → property_customer_id
  const convIds = [...new Set(est.map((r) => r.conversation_id))];
  const convs = await page("conversations", "id, property_customer_id, account", (q) => q.in("id", convIds), "id");
  const pcOf = new Map<string, string | null>(convs.map((c) => [c.id, c.property_customer_id]));
  const pcIds = [...new Set(convs.map((c) => c.property_customer_id).filter(Boolean))] as string[];
  const custs = pcIds.length ? await page("property_customers", "id, initial_cost_limit, preferences, other_requests, raw_format_text", (q) => q.in("id", pcIds), "id") : [];
  const custOf = new Map(custs.map((c) => [c.id, c]));

  let asked = 0; const lat: number[] = []; const latSameDay: number[] = [];
  let items = 0, fromOurs = 0, fromPickup = 0, fromCustomer = 0, unknown = 0, adKnown = 0, noMoveIn = 0, withDisc = 0;
  const discounts: number[] = []; const discOverAd: number[] = [];
  let together = 0, togetherLow = 0, lowAll = 0, proactive = 0, proactiveLow = 0; const proactiveSamples: string[] = []; const togetherKinds = new Map<string, number>();
  const togetherSamples: string[] = [];
  for (const r of est) {
    const t = new Date(r.created_at).getTime();
    const from = new Date(t - 7 * 86400e3).toISOString();
    const { data: msgs } = await sb.from("messages").select("sender, text, image_url, image_type, created_at").eq("conversation_id", r.conversation_id).gte("created_at", from).lte("created_at", r.created_at).order("created_at");
    const ms = (msgs ?? []) as Array<{ sender: string; text: string | null; image_url: string | null; image_type: string | null; created_at: string }>;
    // ② 依頼→送付（直近72時間のお客様の見積・初期費用の発言のうち、最後のこちらの見積書より後の最初の物）
    const cust72 = ms.filter((m) => m.sender === "customer" && t - new Date(m.created_at).getTime() <= 72 * 3600e3 && ASK_RE.test(m.text ?? ""));
    if (cust72.length) {
      asked++;
      const first = cust72[0];
      const mins = Math.round((t - new Date(first.created_at).getTime()) / 60000);
      lat.push(mins);
      if (jstDay(first.created_at) === jstDay(r.created_at)) latSameDay.push(mins);
    }
    // ③ 物件の出所
    const pc = pcOf.get(r.conversation_id) ?? null;
    let sq = sb.from("sent_properties").select("property_name, room_no, ad_months, ad_yen, delivery, source, channel, sent_at, pickup_id").lte("sent_at", r.created_at).gte("sent_at", new Date(t - 90 * 86400e3).toISOString()).limit(2000);
    sq = pc ? sq.eq("property_customer_id", pc) : sq.eq("conversation_id", r.conversation_id);
    const { data: sent } = await sq;
    const sentRows = (sent ?? []) as Array<{ property_name: string | null; ad_months: number | null; ad_yen: number | null; delivery: string | null; source: string | null; channel: string | null; sent_at: string; pickup_id: number | null }>;
    const custRows = sentRows.filter((s) => s.delivery === "customer" && s.source !== "aix:estimate_sheet" && s.property_name);
    let pq = sb.from("property_pickups").select("property_name, room_no, ad_yen, status, sent_at").lte("created_at", r.created_at).gte("created_at", new Date(t - 90 * 86400e3).toISOString()).limit(500);
    pq = pc ? pq.eq("property_customer_id", pc) : pq.eq("conversation_id", r.conversation_id);
    const { data: picks } = await pq;
    const pickRows = (picks ?? []) as Array<{ property_name: string; ad_yen: number | null; status: string | null; sent_at: string | null }>;
    const customerBrought = ms.some((m) => m.sender === "customer" && (m.image_url && ["floor_plan", "property_photo", "estimate", "other"].includes(m.image_type ?? "") || /https?:\/\//.test(m.text ?? "")));
    const lowWish = (() => {
      const c = pc ? custOf.get(pc) : null;
      const colText = c ? `${c.preferences ?? ""} ${c.other_requests ?? ""} ${c.raw_format_text ?? ""}` : "";
      return (c?.initial_cost_limit ?? 0) > 0 || wantsLowInitialCostText(colText) || ms.some((m) => m.sender === "customer" && wantsLowInitialCostText(m.text ?? ""));
    })();
    if (lowWish) lowAll++;
    const its = parseEstimateItems(r.generated_text).filter((it) => it.propertyName);
    if (/※ご入居日によって日割/.test(r.generated_text ?? "")) noMoveIn++;
    let togetherHere = false;
    for (const it of its) {
      items++;
      if (it.discountYen != null) { withDisc++; discounts.push(it.discountYen); }
      const ourHit = matchKnownProperty(it.propertyName, [...new Set(custRows.map((s) => s.property_name!))], MATCH_MIN_SCORE);
      const pickHit = matchKnownProperty(it.propertyName, [...new Set(pickRows.map((s) => s.property_name))], MATCH_MIN_SCORE);
      const adHitNames = [...new Set(sentRows.filter((s) => s.ad_months != null || s.ad_yen != null).map((s) => s.property_name!).filter(Boolean))];
      const adHit = matchKnownProperty(it.propertyName, adHitNames, MATCH_MIN_SCORE);
      const pickAd = pickHit ? pickRows.find((p) => p.property_name === pickHit.name && p.ad_yen != null) : null;
      if (ourHit) fromOurs++; else if (customerBrought) fromCustomer++; else unknown++;
      if (pickHit) fromPickup++;
      if (pickAd || adHit) {
        adKnown++;
        const adYen = pickAd?.ad_yen ?? null;
        if (adYen && it.discountYen) discOverAd.push(Math.round((it.discountYen / adYen) * 100));
      }
      // ⑤ 送付と一緒（前 N 分以内にこの物件を送った）
      if (ourHit) {
        const recent = custRows.filter((s) => s.property_name === ourHit.name && String(s.source ?? "").startsWith("aix:") && t - new Date(s.sent_at).getTime() <= TOGETHER_MIN * 60e3 && t >= new Date(s.sent_at).getTime());
        if (recent.length) { togetherHere = true; const k = recent[0].source ?? "?"; togetherKinds.set(k, (togetherKinds.get(k) ?? 0) + 1); }
      }
    }
    // 送付 AIX の直後（物件名が取れない送付も）: 前 N 分以内に物件の送付 AIX
    if (!togetherHere) {
      const s2 = sends.find((s) => s.conversation_id === r.conversation_id && s.aix_type !== "property_check_result" && t - new Date(s.created_at).getTime() <= TOGETHER_MIN * 60e3 && t >= new Date(s.created_at).getTime());
      if (s2) { togetherHere = true; togetherKinds.set(`aix:${s2.aix_type}(名前なし)`, (togetherKinds.get(`aix:${s2.aix_type}(名前なし)`) ?? 0) + 1); }
    }
    if (togetherHere) {
      together++; if (lowWish) togetherLow++;
      // 先回り＝送付の後にお客様の発言が無いまま見積書（お客様に聞かれる前に送った）
      const sendTimes = [
        ...custRows.filter((s) => String(s.source ?? "").startsWith("aix:") && t - new Date(s.sent_at).getTime() <= TOGETHER_MIN * 60e3 && t >= new Date(s.sent_at).getTime()).map((s) => new Date(s.sent_at).getTime()),
        ...sends.filter((s) => s.conversation_id === r.conversation_id && s.aix_type !== "property_check_result" && t - new Date(s.created_at).getTime() <= TOGETHER_MIN * 60e3 && t >= new Date(s.created_at).getTime()).map((s) => new Date(s.created_at).getTime()),
      ];
      const firstSendAt = Math.min(...sendTimes);
      const custBetween = ms.some((m) => m.sender === "customer" && new Date(m.created_at).getTime() > firstSendAt && new Date(m.created_at).getTime() < t);
      if (!custBetween) {
        proactive++; if (lowWish) proactiveLow++;
        const lastCust = [...ms].reverse().find((m) => m.sender === "customer" && m.text && new Date(m.created_at).getTime() < firstSendAt);
        proactiveSamples.push(`  ${r.created_at.slice(0, 16)} ${r.conversation_id.slice(0, 8)} 抑えたい=${lowWish ? "○" : "×"} 送付→見積 ${Math.round((t - Math.max(...sendTimes)) / 60000)}分 前=${r.previous_action_type ?? "-"} 送付前のお客様「${(lastCust?.text ?? "").replace(/\s+/g, " ").slice(0, 60)}」`);
      }
      if (togetherSamples.length < 12) {
        const lastCust = [...ms].reverse().find((m) => m.sender === "customer" && m.text);
        togetherSamples.push(`  ${r.created_at.slice(0, 16)} ${r.conversation_id.slice(0, 8)} 抑えたい=${lowWish ? "○" : "×"} 前=${r.previous_action_type ?? "-"} 直前のお客様「${(lastCust?.text ?? "").replace(/\s+/g, " ").slice(0, 50)}」`);
      }
    }
  }
  console.log(`\n② お客様の依頼（見積・初期費用の発言・72時間以内）がある見積書 ${asked}/${est.length}（${pct(asked, est.length)}）`);
  console.log(`  依頼→送付（分）全体: ${qs(lat)}`);
  console.log(`  依頼と同じ日に送った分だけ: ${qs(latSameDay)}`);
  console.log(`\n③ 見積書の物件 ${items}件（物件名あり）: こちらが送った ${fromOurs}（${pct(fromOurs, items)}）・お客様の持ち込み ${fromCustomer}（${pct(fromCustomer, items)}）・分からない ${unknown}（${pct(unknown, items)}）`);
  console.log(`  売上サポ（property_pickups）の行と一致 ${fromPickup}（${pct(fromPickup, items)}）・AD が分かる ${adKnown}（${pct(adKnown, items)}）`);
  console.log(`\n④ 手で入れている物: 入居日を入れていない（日割の注記あり）${noMoveIn}/${est.length}（${pct(noMoveIn, est.length)}）・割引あり ${withDisc}/${items}（${pct(withDisc, items)}）`);
  console.log(`  割引: ${qs(discounts)}`);
  console.log(`  割引/AD（%）: ${qs(discOverAd)}`);
  console.log(`\n⑤ 物件の送付と一緒（前 ${TOGETHER_MIN}分以内に送った物件の見積書・送付 AIX の直後）${together}/${est.length}（${pct(together, est.length)}）`);
  console.log(`  初期費用を抑えたい: 一緒 ${togetherLow}/${together}（${pct(togetherLow, together)}）・全見積書 ${lowAll}/${est.length}（${pct(lowAll, est.length)}）`);
  console.log(`  送付の種類: ${[...togetherKinds].map(([k, v]) => `${k} ${v}`).join("・")}`);
  console.log(togetherSamples.join("\n"));
  console.log(`  うち先回り（送付の後にお客様の発言なしで見積書）${proactive}/${together}・抑えたい ${proactiveLow}/${proactive}`);
  console.log(proactiveSamples.slice(0, 25).join("\n"));

  // ⑤' 逆向き: 物件の送付（AIX 物件ピックアップ・オススメ）のうち、N 分以内に見積書が続いた割合（抑えたい・それ以外）
  const sendOnly = sends.filter((s) => s.aix_type !== "property_check_result");
  const sendConv = [...new Set(sendOnly.map((s) => s.conversation_id))];
  const sconvs = await page("conversations", "id, property_customer_id", (q) => q.in("id", sendConv), "id");
  const spc = new Map<string, string | null>(sconvs.map((c) => [c.id, c.property_customer_id]));
  const spcIds = [...new Set(sconvs.map((c) => c.property_customer_id).filter(Boolean))] as string[];
  const scusts = spcIds.length ? await page("property_customers", "id, initial_cost_limit, preferences, other_requests, raw_format_text", (q) => q.in("id", spcIds), "id") : [];
  const scOf = new Map(scusts.map((c) => [c.id, c]));
  const estByConv = new Map<string, number[]>();
  for (const e of est) estByConv.set(e.conversation_id, [...(estByConv.get(e.conversation_id) ?? []), new Date(e.created_at).getTime()]);
  const tally = { low: [0, 0], other: [0, 0] } as Record<"low" | "other", [number, number]>;
  const byType = new Map<string, [number, number]>();
  for (const s of sendOnly) {
    const c = spc.get(s.conversation_id) ? scOf.get(spc.get(s.conversation_id)!) : null;
    const low = !!c && ((c.initial_cost_limit ?? 0) > 0 || wantsLowInitialCostText(`${c.preferences ?? ""} ${c.other_requests ?? ""} ${c.raw_format_text ?? ""}`));
    const t = new Date(s.created_at).getTime();
    const hit = (estByConv.get(s.conversation_id) ?? []).some((et) => et >= t && et - t <= TOGETHER_MIN * 60e3);
    const k = low ? "low" : "other";
    tally[k][0]++; if (hit) tally[k][1]++;
    const bt = byType.get(s.aix_type) ?? [0, 0]; bt[0]++; if (hit) bt[1]++; byType.set(s.aix_type, bt);
  }
  console.log(`\n⑤' 物件の送付 AIX のうち ${TOGETHER_MIN}分以内に見積書が続いた: 抑えたい ${tally.low[1]}/${tally.low[0]}（${pct(tally.low[1], tally.low[0])}）・それ以外 ${tally.other[1]}/${tally.other[0]}（${pct(tally.other[1], tally.other[0])}）`);
  console.log(`  種類別: ${[...byType].map(([k, v]) => `${k} ${v[1]}/${v[0]}（${pct(v[1], v[0])}）`).join("・")}`);

  // ⑥ 物件オススメに御見積書を同封した通（AIX【物件オススメ】の ③見積書の欄・本文「御見積書同封させて頂きました」）
  //    場面: 今回のお客様の連投に費用・見積の依頼があるか／初期費用を抑えたいお客様か／オススメの場面（situation_kind）
  const recs = await page("aix_usage_logs", "id, conversation_id, created_at, generated_text, picker_choices", (q) => q.eq("aix_type", "property_recommendation").gte("created_at", since).neq("conversation_id", YUMA));
  const rconvs = await page("conversations", "id, property_customer_id", (q) => q.in("id", [...new Set(recs.map((r) => r.conversation_id))]), "id");
  const rpc = new Map<string, string | null>(rconvs.map((c) => [c.id, c.property_customer_id]));
  const rpcIds = [...new Set(rconvs.map((c) => c.property_customer_id).filter(Boolean))] as string[];
  const rcusts = rpcIds.length ? await page("property_customers", "id, initial_cost_limit, preferences, other_requests, raw_format_text", (q) => q.in("id", rpcIds), "id") : [];
  const rcOf = new Map(rcusts.map((c) => [c.id, c]));
  type Cell = { n: number; asked: number; low: number; first: number };
  const cell = (): Cell => ({ n: 0, asked: 0, low: 0, first: 0 });
  const withE = cell(), withoutE = cell();
  const sitWith = new Map<string, number>(), sitAll = new Map<string, number>();
  const samples: string[] = [];
  for (const r of recs) {
    const has = /御見積書同封/.test(r.generated_text ?? "") || r.picker_choices?.has_estimate_image === true;
    const c = has ? withE : withoutE;
    c.n++;
    const t = new Date(r.created_at).getTime();
    const { data: msgs } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", r.conversation_id).gte("created_at", new Date(t - 30 * 86400e3).toISOString()).lte("created_at", r.created_at).order("created_at");
    const ms = (msgs ?? []) as Array<{ sender: string; text: string | null; created_at: string }>;
    // 送った本文・画像（AIX の記録より先に messages に入る）を外すため、t の15分前より前のこちらの発言で区切る
    let lastStaff = -1; ms.forEach((m, i) => { if (m.sender !== "customer" && t - new Date(m.created_at).getTime() > 15 * 60e3) lastStaff = i; });
    const turn = ms.slice(lastStaff + 1).filter((m) => m.sender === "customer" && t - new Date(m.created_at).getTime() > 0).map((m) => m.text ?? "").join("\n");
    const asked = ASK_RE.test(turn);
    const pc = rpc.get(r.conversation_id); const cu = pc ? rcOf.get(pc) : null;
    const low = (!!cu && ((cu.initial_cost_limit ?? 0) > 0 || wantsLowInitialCostText(`${cu.preferences ?? ""} ${cu.other_requests ?? ""} ${cu.raw_format_text ?? ""}`))) || ms.some((m) => m.sender === "customer" && wantsLowInitialCostText(m.text ?? ""));
    const firstRec = !recs.some((x) => x.conversation_id === r.conversation_id && x.created_at < r.created_at);
    if (asked) c.asked++; if (low) c.low++; if (firstRec) c.first++;
    const sit = String(r.picker_choices?.situation_kind ?? r.picker_choices?.pickup_type ?? "-");
    sitAll.set(sit, (sitAll.get(sit) ?? 0) + 1); if (has) sitWith.set(sit, (sitWith.get(sit) ?? 0) + 1);
    if (has && samples.length < 15) samples.push(`  ${r.created_at.slice(0, 16)} ${r.conversation_id.slice(0, 8)} 依頼=${asked ? "○" : "×"} 抑えたい=${low ? "○" : "×"} 場面=${sit} 今回の連投「${turn.replace(/\s+/g, " ").slice(0, 50)}」`);
  }
  const line = (lab: string, c: Cell) => `  ${lab} ${c.n}通: 今回の連投に費用・見積の依頼 ${pct(c.asked, c.n)}・抑えたい ${pct(c.low, c.n)}・その会話で最初のオススメ ${pct(c.first, c.n)}`;
  console.log(`\n⑥ 物件オススメに御見積書を同封 ${withE.n}/${withE.n + withoutE.n}（${pct(withE.n, withE.n + withoutE.n)}）`);
  console.log(line("同封あり", withE));
  console.log(line("同封なし", withoutE));
  console.log(`  場面別の同封率: ${[...sitAll].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${sitWith.get(k) ?? 0}/${v}（${pct(sitWith.get(k) ?? 0, v)}）`).join("・")}`);
  console.log(samples.join("\n"));
}
main().catch((e) => { console.error(e); process.exit(1); });
