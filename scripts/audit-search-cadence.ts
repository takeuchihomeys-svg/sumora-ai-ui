// scripts/audit-search-cadence.ts（読むだけ・DB に書かない・LLM なし）
// 2026-09-30 竹内「午前のところも、物件新規で一度ピックアップで送ったお客さん以外は、更新順で行った方が漏れなく更新された物件を確認できる。
//   ピンポイント検索と広げて検索を繰り返していく。ここをどう繰り返していくか、最善の案で」
//   → 「どの回し方が新着を漏らさず、送れる物件を最も拾えるか」の材料を直近30日の実データで出す。
//
// 出所:
//   ・拾った物件＝sent_properties の delivery=shared（★物件出し★への共有＝拡張が資料を送った1件ごと・建物名＋号室＋家賃＋AD）
//     （property_candidate_pools は号室・更新日を持たないので、部屋の照合には共有の行を使う）
//   ・送った物件＝sent_properties の お客様に届いた行（sent-delivery.isCustomerRow・feedback_property_selection_label＝スタッフが選んで送った事実）
//   ・便の見分け＝automation_commands（payload.source: auto_schedule am/pm・aix・web_brain）の customer_ids × [picked_up_at, completed_at] の窓
//     ＋ search_audits（trigger・is_wide・9/26〜）。どれにも当たらない回は「手動」
//   ・更新日の代わり＝その部屋（建物名＋号室）が全お客様の共有の行で最初に現れた時刻（first_seen）。候補にも資料にも更新日は残っていない
//     （資料の「次回更新予定日」は出力日＋14日で固定＝更新日ではない・2026-09-30 に確かめた）
//   ・ピンポイント／広げて＝property_pickups.search_mode（9/27〜）＋ search_audits.is_wide
//
// 実行: npx tsx --env-file=.env.local scripts/audit-search-cadence.ts [--days=30] [--show=8]
import { createClient } from "@supabase/supabase-js";
import { sentRoomKey, normRoomName, usableRoomName, splitRoomFromName } from "../app/lib/sent-room-match";
import { isCustomerRow } from "../app/lib/sent-delivery";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "30"));
const SHOW = Number(arg("show", "8"));
const SINCE = new Date(Date.now() - DAYS * 86400_000).toISOString();
const YUMA_CONV = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

type Cmd = { id: string; created_at: string; status: string; customer_ids: string[] | null; sites: string[] | null; payload: Record<string, unknown> | null; picked_up_at: string | null; completed_at: string | null };
type Shared = { id: string; property_customer_id: string | null; property_name: string; room_no: string | null; rent: number | null; ad_months: number | null; ad_yen: number | null; property_url: string | null; sent_at: string };
type Cust = { id: string; property_customer_id: string | null; conversation_id: string | null; property_name: string; room_no: string | null; sent_at: string; source: string | null; channel: string | null; delivery: string | null; pickup_id: number | null };
type Audit = { run_id: string; created_at: string; finished_at: string | null; status: string; property_customer_id: string | null; site: string | null; trigger: string | null; command_id: string | null; is_wide: boolean | null; intended: Record<string, unknown> | null; result: Record<string, unknown> | null; checks: unknown };
type Pick = { id: number; created_at: string; batch_id: string; property_customer_id: string | null; site: string | null; property_name: string; room_no: string | null; verdict: string | null; score: number | null; search_mode: string | null; status: string; sent_at: string | null; location: Record<string, unknown> | null; reason_codes: string[] | null };
type Customer = { id: string; created_at: string; desired_area: string | null; area_mode: string | null; last_property_sent_at: string | null; property_viewed_at: string | null; status: string | null };

async function all<T>(q: (from: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let off = 0; off < 200000; off += 1000) {
    const { data, error } = await q(off);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
const ms = (s: string) => new Date(s).getTime();
const jstDate = (s: string) => new Date(ms(s) + 9 * 3600_000).toISOString().slice(0, 10);
const jstHour = (s: string) => new Date(ms(s) + 9 * 3600_000).getUTCHours();
const siteOf = (url: string | null) => /itandi/i.test(url ?? "") ? "itandi" : /realnetpro|realpro/i.test(url ?? "") ? "realpro" : "other";
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
const short = (id: string | null | undefined) => String(id ?? "").slice(0, 8);
function quant(xs: number[], q: number): number | null { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]; }
function hist(xs: number[], edges: number[], unit: string): string {
  const lab: string[] = []; let prev = -Infinity;
  for (const e of [...edges, Infinity]) { const n = xs.filter((x) => x > prev && x <= e).length; lab.push(`${prev === -Infinity ? "〜" : ">" + prev + unit + "〜"}${e === Infinity ? "" : e + unit}: ${n}`); prev = e; }
  return lab.join(" / ");
}

/** 部屋の鍵: 完全一致（建物名＋号室）。号室が無い行は建物名だけ（fuzzy）で当てる */
function keyOf(name: string, room: string | null): { exact: string | null; bld: string | null } {
  let r = (room ?? "").trim();
  let n = name;
  if (!r) { const sp = splitRoomFromName(name); if (sp.room) { r = sp.room; n = sp.building || name; } }
  const exact = sentRoomKey(n, r);
  const bld = usableRoomName(n) ? normRoomName(n) : null;
  return { exact, bld };
}

/** 便のラベル */
type Label = "am" | "pm" | "aix" | "web_brain:pin" | "web_brain:wide" | "web_brain:chain" | "manual:pin" | "manual:wide" | "single" | "unknown";
function labelOfCmd(c: Cmd): Label {
  const p = c.payload ?? {};
  const src = String(p.source ?? "");
  if (src === "auto_schedule") return p.mode === "pm" ? "pm" : "am";
  if (src === "aix") return "aix";
  if (src === "web_brain") return p.chain ? "web_brain:chain" : p.is_wide ? "web_brain:wide" : "web_brain:pin";
  return "unknown";
}
const ORDER: Label[] = ["am", "pm", "aix", "web_brain:pin", "web_brain:wide", "web_brain:chain", "manual:pin", "manual:wide", "single", "unknown"];
const LABEL_JA: Record<Label, string> = {
  am: "午前の便（広げて・AD順・更新日=前回から）", pm: "午後の便（ピンポイント・AD順※・更新日=人ごと）", aix: "AIX の検索（ピンポイント・登録の条件）",
  "web_brain:pin": "AIXツール一括（ピンポイント）", "web_brain:wide": "AIXツール一括（広げて）", "web_brain:chain": "自動で広げて（chain）",
  "manual:pin": "手動の一括（ピンポイント）", "manual:wide": "手動の一括（広げて）", single: "個別の検索", unknown: "出所不明（手の検索・記録なし）",
};

(async () => {
  console.log(`=== 検索の回し方の材料（直近 ${DAYS} 日・${SINCE.slice(0, 10)}〜・読むだけ）===\n`);
  const [cmds, shared, custRows, audits, picks, customers] = await Promise.all([
    all<Cmd>((o) => sb.from("automation_commands").select("id, created_at, status, customer_ids, sites, payload, picked_up_at, completed_at").gte("created_at", SINCE).order("created_at").order("id").range(o, o + 999)),
    all<Shared>((o) => sb.from("sent_properties").select("id, property_customer_id, property_name, room_no, rent, ad_months, ad_yen, property_url, sent_at").eq("delivery", "shared").gte("sent_at", SINCE).order("sent_at").order("id").range(o, o + 999)),
    all<Cust>((o) => sb.from("sent_properties").select("id, property_customer_id, conversation_id, property_name, room_no, sent_at, source, channel, delivery, pickup_id").neq("delivery", "shared").gte("sent_at", SINCE).order("sent_at").order("id").range(o, o + 999)),
    all<Audit>((o) => sb.from("search_audits").select("run_id, created_at, finished_at, status, property_customer_id, site, trigger, command_id, is_wide, intended, result, checks").gte("created_at", SINCE).order("created_at").order("id").range(o, o + 999)),
    all<Pick>((o) => sb.from("property_pickups").select("id, created_at, batch_id, property_customer_id, site, property_name, room_no, verdict, score, search_mode, status, sent_at, location, reason_codes").gte("created_at", SINCE).order("created_at").order("id").range(o, o + 999)),
    all<Customer>((o) => sb.from("property_customers").select("id, created_at, desired_area, area_mode, last_property_sent_at, property_viewed_at, status").order("created_at").order("id").range(o, o + 999)),
  ]);
  const custById = new Map(customers.map((c) => [c.id, c]));
  const sent = custRows.filter((r) => isCustomerRow({ delivery: r.delivery, source: r.source } as never) && r.conversation_id !== YUMA_CONV && r.property_customer_id);
  console.log(`命令 ${cmds.length}・共有の行（拾った物件） ${shared.length}・お客様に届いた送付 ${sent.length}（${new Set(sent.map((s) => s.property_customer_id)).size}人）・点検 ${audits.length}・売上サポの行 ${picks.length}\n`);

  // ── 1. 共有の行（拾った物件）に便のラベルを付ける ──────────────────────
  const runCmds = cmds.filter((c) => c.picked_up_at && ["done", "error"].includes(c.status) && (c.payload?.source));
  const cmdWin = runCmds.map((c) => ({ c, from: ms(c.picked_up_at!) - 2 * 60_000, to: (c.completed_at ? ms(c.completed_at) : ms(c.picked_up_at!) + 3 * 3600_000) + 3 * 60_000, ids: new Set((c.customer_ids ?? []).map(String)), label: labelOfCmd(c) }));
  const auditWin = audits.filter((a) => a.property_customer_id).map((a) => ({ a, from: ms(a.created_at) - 60_000, to: (a.finished_at ? ms(a.finished_at) : ms(a.created_at) + 30 * 60_000) + 3 * 60_000 }));
  type Found = Shared & { label: Label; site: string; exact: string | null; bld: string | null; cmdId: string | null; wide: boolean | null };
  const found: Found[] = shared.filter((s) => s.property_customer_id).map((s) => {
    const t = ms(s.sent_at); const site = siteOf(s.property_url);
    let label: Label = "unknown"; let cmdId: string | null = null; let wide: boolean | null = null;
    const cw = cmdWin.find((w) => w.ids.has(String(s.property_customer_id)) && t >= w.from && t <= w.to);
    if (cw) { label = cw.label; cmdId = cw.c.id; wide = cw.label === "am" || cw.label.endsWith("wide") || cw.label.endsWith("chain") ? true : cw.label === "pm" || cw.label === "aix" || cw.label.endsWith("pin") ? false : null; }
    else {
      const aw = auditWin.find((w) => w.a.property_customer_id === s.property_customer_id && (w.a.site ?? "") === site && t >= w.from && t <= w.to);
      if (aw) { wide = aw.a.is_wide; label = aw.a.trigger === "single" ? "single" : aw.a.trigger === "bulk_manual" ? (aw.a.is_wide ? "manual:wide" : "manual:pin") : aw.a.trigger === "web_brain" ? (aw.a.is_wide ? "web_brain:wide" : "web_brain:pin") : "unknown"; }
    }
    const k = keyOf(s.property_name, s.room_no);
    return { ...s, label, site, exact: k.exact, bld: k.bld, cmdId, wide };
  });

  // 便ごとの拾った数
  console.log("■ 1. 便ごとに拾った物件（共有の行＝資料を送った1件ごと・同じ部屋は1回に数える）");
  const byLabel = new Map<Label, { rows: number; rooms: Set<string>; custs: Set<string>; runs: Set<string> }>();
  for (const f of found) {
    const b = byLabel.get(f.label) ?? { rows: 0, rooms: new Set(), custs: new Set(), runs: new Set() };
    b.rows++; if (f.exact) b.rooms.add(f.exact); b.custs.add(String(f.property_customer_id)); b.runs.add(`${f.property_customer_id}|${f.site}|${jstDate(f.sent_at)}|${jstHour(f.sent_at) < 15 ? "a" : "p"}`);
    byLabel.set(f.label, b);
  }
  console.log("| 便 | 行 | 部屋（重複なし） | お客様 | 回（人×サイト×日×午前/午後） |\n|---|---|---|---|---|");
  for (const l of ORDER) { const b = byLabel.get(l); if (!b) continue; console.log(`| ${LABEL_JA[l]} | ${b.rows} | ${b.rooms.size} | ${b.custs.size} | ${b.runs.size} |`); }
  console.log("※ 午後の便の AD順: v2.5.35（9/27）より前は popup の経路で bulk-dl が AD 高い順に並べ替えていた（候補の並びが AD 降順＝実データで確認）。9/28〜29 の便は cancelled・9/30 は pending → **この30日に「更新順」で回した便は1回も無い**\n");

  // ── 2. 送った物件がどの便で最初に現れたか ──────────────────────
  console.log("■ 2. お客様に送った物件（スタッフが選んで送った事実）が、その人の検索でどの便に現れていたか");
  const foundByCust = new Map<string, Found[]>();
  for (const f of found) { const a = foundByCust.get(String(f.property_customer_id)) ?? []; a.push(f); foundByCust.set(String(f.property_customer_id), a); }
  type SentHit = { s: Cust; first: Found | null; labels: Set<Label>; matched: "exact" | "bld" | "none"; firstSeenAll: string | null; firstSeenCust: string | null };
  const firstSeenAll = new Map<string, string>(); // 部屋の鍵 → 全お客様で最初に現れた時刻
  for (const f of found) { if (f.exact && !firstSeenAll.has(f.exact)) firstSeenAll.set(f.exact, f.sent_at); }
  const firstSeenBld = new Map<string, string>();
  for (const f of found) { if (f.bld && !firstSeenBld.has(f.bld)) firstSeenBld.set(f.bld, f.sent_at); }
  const hits: SentHit[] = sent.map((s) => {
    const k = keyOf(s.property_name, s.room_no);
    const mine = (foundByCust.get(String(s.property_customer_id)) ?? []).filter((f) => ms(f.sent_at) <= ms(s.sent_at) + 60_000);
    let m = k.exact ? mine.filter((f) => f.exact === k.exact) : [];
    let matched: SentHit["matched"] = m.length ? "exact" : "none";
    if (!m.length && k.bld) { m = mine.filter((f) => f.bld === k.bld); if (m.length) matched = "bld"; }
    const labels = new Set(m.map((f) => f.label));
    const first = m.length ? m[0] : null;
    return { s, first, labels, matched, firstSeenAll: (k.exact && firstSeenAll.get(k.exact)) || (k.bld && firstSeenBld.get(k.bld)) || null, firstSeenCust: first?.sent_at ?? null };
  });
  const nExact = hits.filter((h) => h.matched === "exact").length, nBld = hits.filter((h) => h.matched === "bld").length, nNone = hits.filter((h) => h.matched === "none").length;
  console.log(`送付 ${sent.length}件: 検索の記録に当たる ${nExact}（部屋の完全一致）＋ ${nBld}（建物名だけ・号室が読めない行）・当たらない ${nNone}（検索の記録の外＝スタッフの手の検索・レインズ・記録前）`);
  const firstBy = new Map<Label, number>(), anyBy = new Map<Label, number>();
  for (const h of hits) { if (!h.first) continue; firstBy.set(h.first.label, (firstBy.get(h.first.label) ?? 0) + 1); for (const l of h.labels) anyBy.set(l, (anyBy.get(l) ?? 0) + 1); }
  console.log("| 便 | 送った物件が最初に現れた | その便にも現れていた（重複あり） |\n|---|---|---|");
  for (const l of ORDER) { if (!firstBy.get(l) && !anyBy.get(l)) continue; console.log(`| ${LABEL_JA[l]} | ${firstBy.get(l) ?? 0} | ${anyBy.get(l) ?? 0} |`); }
  // 「その便でしか出なかった」
  const onlyIn = (pred: (l: Label) => boolean, name: string) => {
    const only = hits.filter((h) => h.labels.size && [...h.labels].every(pred));
    const both = hits.filter((h) => h.labels.size && [...h.labels].some(pred) && ![...h.labels].every(pred));
    console.log(`・${name} だけに現れた送付物件: ${only.length}件（他の便にも現れた: ${both.length}件）`);
    for (const h of only.slice(0, SHOW)) console.log(`    ${short(h.s.property_customer_id)} ${h.s.property_name} ${h.s.room_no ?? ""}（送 ${h.s.sent_at.slice(5, 16)}・現れた ${h.first?.sent_at.slice(5, 16)}・${[...h.labels].join(",")}）`);
  };
  onlyIn((l) => l === "am" || l.endsWith("wide") || l.endsWith("chain"), "広げての回（午前の便・広げて）");
  onlyIn((l) => l === "pm" || l === "aix" || l.endsWith("pin"), "ピンポイントの回（午後の便・AIX・ピンポイント）");
  onlyIn((l) => l === "am", "午前の便");
  onlyIn((l) => l === "pm", "午後の便");
  console.log("");

  // ── 3. 更新日の代わり: 最初に現れてから送るまで ──────────────────────
  console.log("■ 3. 送った物件の『新しさ』（その部屋が全お客様の検索で最初に現れた時刻 → 送った時刻。更新日そのものは記録に無い）");
  const censorMs = ms(SINCE) + 7 * 86400_000;
  const fresh = hits.filter((h) => h.firstSeenAll && ms(h.firstSeenAll) >= censorMs).map((h) => (ms(h.s.sent_at) - ms(h.firstSeenAll!)) / 86400_000);
  const censored = hits.filter((h) => h.firstSeenAll && ms(h.firstSeenAll) < censorMs).length;
  console.log(`対象 ${fresh.length}件（窓の最初の7日に既に出ていた ${censored}件は除く）: 中央値 ${quant(fresh, 0.5)?.toFixed(1)}日・p75 ${quant(fresh, 0.75)?.toFixed(1)}日・p90 ${quant(fresh, 0.9)?.toFixed(1)}日`);
  console.log(`  分布: ${hist(fresh, [0.5, 1, 2, 3, 5, 7, 14], "日")}`);
  const freshCust = hits.filter((h) => h.firstSeenCust).map((h) => (ms(h.s.sent_at) - ms(h.firstSeenCust!)) / 86400_000);
  console.log(`その人の検索に最初に現れてから送るまで（${freshCust.length}件）: 中央値 ${quant(freshCust, 0.5)?.toFixed(2)}日・p75 ${quant(freshCust, 0.75)?.toFixed(1)}日・p90 ${quant(freshCust, 0.9)?.toFixed(1)}日`);
  console.log(`  分布: ${hist(freshCust, [0.25, 1, 2, 3, 7], "日")}`);
  // 拾った物件全体の新しさ（便ごと）: 現れた時点で全体の初出からどれだけ経っていたか
  console.log("拾った物件が『初出』だった率（便ごと・その回で全お客様を通じて最初に現れた部屋の割合・窓の最初の7日は除く）:");
  for (const l of ORDER) {
    const rows = found.filter((f) => f.label === l && f.exact && ms(f.sent_at) >= censorMs);
    if (!rows.length) continue;
    const firstRows = rows.filter((f) => firstSeenAll.get(f.exact!) === f.sent_at);
    const age = rows.map((f) => (ms(f.sent_at) - ms(firstSeenAll.get(f.exact!)!)) / 86400_000);
    console.log(`  ${LABEL_JA[l]}: 初出 ${firstRows.length}/${rows.length}（${pct(firstRows.length, rows.length)}）・初出からの日数 中央値 ${quant(age, 0.5)?.toFixed(1)}・p90 ${quant(age, 0.9)?.toFixed(1)}`);
  }
  console.log("");

  // ── 4. 前回の検索からの空き（人×サイト） ──────────────────────
  console.log("■ 4. 前回の検索からの空き（共有の行を 30分の塊＝1回として、同じ人×サイトの前の回との間）");
  const runsBy = new Map<string, number[]>();
  for (const f of found) { const k = `${f.property_customer_id}|${f.site}`; const a = runsBy.get(k) ?? []; const t = ms(f.sent_at); if (!a.length || t - a[a.length - 1] > 30 * 60_000) a.push(t); runsBy.set(k, a); }
  const gaps: number[] = []; let runsTotal = 0;
  for (const a of runsBy.values()) { runsTotal += a.length; for (let i = 1; i < a.length; i++) gaps.push((a[i] - a[i - 1]) / 3600_000); }
  console.log(`回 ${runsTotal}（人×サイト ${runsBy.size}）・空き ${gaps.length}組: 中央値 ${quant(gaps, 0.5)?.toFixed(1)}h・p25 ${quant(gaps, 0.25)?.toFixed(1)}h・p75 ${quant(gaps, 0.75)?.toFixed(1)}h・p90 ${quant(gaps, 0.9)?.toFixed(1)}h`);
  console.log(`  分布: ${hist(gaps, [1, 6, 12, 24, 48, 72, 168], "h")}`);
  const udPlans = runCmds.filter((c) => c.payload?.update_days_plan).flatMap((c) => Object.values((c.payload!.update_days_plan as { by_customer: Record<string, { days: number | null; base_days: number | null; gap_hours: number | null; widened: boolean }> }).by_customer ?? {}));
  if (udPlans.length) {
    const byDays = new Map<string, number>(); let widened = 0;
    for (const p of udPlans) { byDays.set(String(p.days ?? "指定なし"), (byDays.get(String(p.days ?? "指定なし")) ?? 0) + 1); if (p.widened) widened++; }
    console.log(`  命令の更新日の計画（${udPlans.length}人分・v2.5.41〜）: ${[...byDays.entries()].map(([k, v]) => `${k}日 ${v}`).join("・")}・空きで広げた ${widened}`);
  }
  const udIntended = audits.filter((a) => a.intended && a.site === "realpro").map((a) => String((a.intended as Record<string, unknown>).rp_update_days ?? "なし"));
  const udCount = new Map<string, number>(); for (const u of udIntended) udCount.set(u, (udCount.get(u) ?? 0) + 1);
  console.log(`  点検に残った更新日（リアプロ・${udIntended.length}回）: ${[...udCount.entries()].sort().map(([k, v]) => `${k}日 ${v}`).join("・")}`);
  const cut = audits.filter((a) => a.status === "finished" && a.result?.page_limit);
  const rowsCut = cut.map((a) => Number(a.result?.read_rows ?? 0));
  console.log(`  ページの上限で打ち切った回: ${cut.length}/${audits.filter((a) => a.status === "finished").length}（読んだ行の中央値 ${quant(rowsCut, 0.5)}）＝AD順で上限に当たった回は、AD の低い新着がページの外に残っている`);
  console.log("");

  // ── 5. 同じ人の午前（広げて・AD順）と午後（ピンポイント）を比べる ──────────────────────
  console.log("■ 5. 同じお客様の同じ日の午前の便 × 午後の便（リアプロ）: 部屋の重なり");
  const dayRuns = new Map<string, { am: Set<string>; pm: Set<string>; amRows: number; pmRows: number }>();
  for (const f of found) {
    if (f.site !== "realpro" || !f.exact || (f.label !== "am" && f.label !== "pm")) continue;
    const k = `${f.property_customer_id}|${jstDate(f.sent_at)}`;
    const d = dayRuns.get(k) ?? { am: new Set(), pm: new Set(), amRows: 0, pmRows: 0 };
    if (f.label === "am") { d.am.add(f.exact); d.amRows++; } else { d.pm.add(f.exact); d.pmRows++; }
    dayRuns.set(k, d);
  }
  let pairs = 0, amOnly = 0, pmOnly = 0, both = 0; const ex: string[] = [];
  for (const [k, d] of dayRuns) {
    if (!d.am.size || !d.pm.size) continue;
    pairs++;
    const b = [...d.am].filter((x) => d.pm.has(x)).length;
    both += b; amOnly += d.am.size - b; pmOnly += d.pm.size - b;
    if (ex.length < SHOW) ex.push(`${short(k.split("|")[0])} ${k.split("|")[1]}: 午前 ${d.am.size}・午後 ${d.pm.size}・共通 ${b}・午前だけ ${d.am.size - b}・午後だけ ${d.pm.size - b}`);
  }
  console.log(`両方ある人×日 ${pairs}組: 共通 ${both}・午前だけ ${amOnly}・午後だけ ${pmOnly}（午後だけ＝午前の後に更新された物か、ピンポイントで上位に来た物）`);
  for (const e of ex) console.log(`  ${e}`);
  // 午後だけに出た部屋のうち、全体の初出がその日の午前の便より後（＝日中に出た新着）
  let pmNew = 0, pmNotNew = 0;
  for (const [k, d] of dayRuns) {
    if (!d.am.size || !d.pm.size) continue;
    for (const x of d.pm) { if (d.am.has(x)) continue; const fs = firstSeenAll.get(x); const amT = found.filter((f) => f.exact && f.label === "am" && `${f.property_customer_id}|${jstDate(f.sent_at)}` === k).map((f) => ms(f.sent_at)); const amMin = Math.min(...amT); if (fs && ms(fs) > amMin) pmNew++; else pmNotNew++; }
  }
  console.log(`  午後だけの部屋 ${pmOnly}件のうち、全体でもその日の午前より後に初めて出た（日中の新着）: ${pmNew}・前から有った（ピンポイント／AD順の並びの差）: ${pmNotNew}\n`);

  // ── 6. ピンポイント／広げて（売上サポの行・9/27〜） ──────────────────────
  console.log("■ 6. ピンポイント／広げて（property_pickups.search_mode・9/27〜・売上サポの行）");
  const pk = picks.filter((p) => p.property_customer_id && p.search_mode);
  const sentKeys = new Map<string, Cust[]>(); // 人|鍵 → 送付
  for (const s of sent) { const k = keyOf(s.property_name, s.room_no); for (const kk of [k.exact, k.bld]) { if (!kk) continue; const key = `${s.property_customer_id}|${kk}`; const a = sentKeys.get(key) ?? []; a.push(s); sentKeys.set(key, a); } }
  const sentByPickupId = new Map<number, Cust>(); for (const s of sent) if (s.pickup_id) sentByPickupId.set(s.pickup_id, s);
  const modeStat = new Map<string, { rows: number; pass: number; sentRows: number; sentPass: number; wardOut: number; wardOutSent: number; results: Map<string, number> }>();
  for (const p of pk) {
    const st = modeStat.get(p.search_mode!) ?? { rows: 0, pass: 0, sentRows: 0, sentPass: 0, wardOut: 0, wardOutSent: 0, results: new Map() };
    st.rows++; if (p.verdict === "pass") st.pass++;
    const k = keyOf(p.property_name, p.room_no);
    const later = (kk: string | null) => kk ? (sentKeys.get(`${p.property_customer_id}|${kk}`) ?? []).some((s) => ms(s.sent_at) >= ms(p.created_at) - 60_000 && ms(s.sent_at) <= ms(p.created_at) + 7 * 86400_000) : false;
    const wasSent = p.status === "sent" || sentByPickupId.has(p.id) || later(k.exact) || later(k.bld);
    if (wasSent) { st.sentRows++; if (p.verdict === "pass") st.sentPass++; }
    const res = String((p.location?.area as Record<string, unknown> | undefined)?.result ?? "?");
    st.results.set(res, (st.results.get(res) ?? 0) + 1);
    const out = /^(close|far|ward_wide|station_wide|region|line)$/.test(res);
    if (out) { st.wardOut++; if (wasSent) st.wardOutSent++; }
    modeStat.set(p.search_mode!, st);
  }
  console.log("| 検索 | 行 | 通す | 送った（7日以内・部屋の一致 or status=sent） | 送った/行 | 希望の区・駅の外（隣・広い） | その中で送った |\n|---|---|---|---|---|---|---|");
  for (const [m, st] of modeStat) console.log(`| ${m} | ${st.rows} | ${st.pass} | ${st.sentRows} | ${pct(st.sentRows, st.rows)} | ${st.wardOut} | ${st.wardOutSent} |`);
  for (const [m, st] of modeStat) console.log(`  ${m} の場所の内訳: ${[...st.results.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
  const widenSent = pk.filter((p) => p.search_mode === "widen" && (p.status === "sent" || sentByPickupId.has(p.id)));
  for (const p of widenSent.slice(0, SHOW)) console.log(`  広げてで送った例: ${short(p.property_customer_id)} ${p.property_name} ${p.room_no ?? ""} 点 ${p.score} 場所=${String((p.location?.area as Record<string, unknown> | undefined)?.why ?? "")}`);
  // 自動で広げた回（chain）の後に送れた物
  const chainCmds = runCmds.filter((c) => c.payload?.chain);
  const chainFound = found.filter((f) => f.label === "web_brain:chain");
  const chainSent = hits.filter((h) => h.labels.has("web_brain:chain"));
  console.log(`  自動で広げた命令 ${chainCmds.length}・拾った ${chainFound.length}行・そこから送った ${chainSent.length}件\n`);

  // ── 7. 新規のお客様（初回のご提案）と AD2 の優先 ──────────────────────
  console.log("■ 7. 新規のお客様（まだ1件も送っていない）の初回のご提案と AD の段（9/29 の pickup-ad-priority 以降の回）");
  const firstSentAt = new Map<string, string>();
  for (const s of [...custRows].filter((r) => isCustomerRow({ delivery: r.delivery, source: r.source } as never) && r.property_customer_id).sort((a, b) => a.sent_at < b.sent_at ? -1 : 1)) if (!firstSentAt.has(String(s.property_customer_id))) firstSentAt.set(String(s.property_customer_id), s.sent_at);
  const AD_PRIORITY_SINCE = "2026-09-29T00:00:00Z";
  const groups = new Map<string, Pick[]>();
  for (const p of picks) { if (!p.property_customer_id || p.created_at < AD_PRIORITY_SINCE) continue; const a = groups.get(p.batch_id) ?? []; a.push(p); groups.set(p.batch_id, a); }
  let firstRounds = 0, firstRoundsSent = 0; const adEx: string[] = [];
  const adTier = (codes: string[] | null) => (codes ?? []).some((c) => /^AD_(HIGH|2_5M|VERY_HIGH|ASSUMED_AGENT)/.test(c)) ? "AD2" : (codes ?? []).some((c) => /^AD_1_5M/.test(c)) ? "AD1.5" : (codes ?? []).some((c) => /^AD_1M/.test(c)) ? "AD1" : "不明";
  for (const [bid, rows] of groups) {
    const cid = String(rows[0].property_customer_id); const fs = firstSentAt.get(cid);
    const isFirst = !fs || ms(fs) >= ms(rows[0].created_at);
    if (!isFirst) continue;
    firstRounds++;
    const sentRows = rows.filter((p) => p.status === "sent" || sentByPickupId.has(p.id));
    if (sentRows.length) firstRoundsSent++;
    const tiers = new Map<string, number>(); for (const p of rows.filter((p) => p.verdict === "pass")) tiers.set(adTier(p.reason_codes), (tiers.get(adTier(p.reason_codes)) ?? 0) + 1);
    const sentTiers = sentRows.map((p) => adTier(p.reason_codes));
    if (adEx.length < SHOW) adEx.push(`${short(cid)} ${bid.slice(0, 24)} ${rows[0].created_at.slice(5, 16)}: 通す ${[...tiers.entries()].map(([k, v]) => `${k} ${v}`).join("・") || "0"}・送った ${sentRows.length}（${sentTiers.join(",") || "-"}）`);
  }
  console.log(`初回のご提案の回 ${firstRounds}（送った回 ${firstRoundsSent}）`);
  for (const e of adEx) console.log(`  ${e}`);
  const newSince = customers.filter((c) => c.created_at >= SINCE && c.desired_area);
  const newSent = newSince.filter((c) => firstSentAt.has(c.id));
  const newDelay = newSent.map((c) => (ms(firstSentAt.get(c.id)!) - ms(c.created_at)) / 3600_000);
  console.log(`この30日に登録された（条件のある）お客様 ${newSince.length}人・初回のご提案が届いた ${newSent.length}人・登録から初回まで 中央値 ${quant(newDelay, 0.5)?.toFixed(1)}h・p75 ${quant(newDelay, 0.75)?.toFixed(1)}h\n`);

  // ── 8. 「更新順だけ」「AD順だけ」にした時に漏れる物（実数） ──────────────────────
  console.log("■ 8. 『更新順だけ』『AD順だけ』にした時に漏れる物（この30日の送付を元に）");
  const sentWithRun = hits.filter((h) => h.first);
  // AD順だけ（今の全部の便）＝今の実績そのもの。漏れ＝ページの上限で切れた回に AD の低い新着が残る → 送付物件のうち、拾った時に「その人のその回で3ページ目以降の順位」は分からないので、代わりに AD の段で見る
  const adOf = (f: Found) => f.ad_months != null ? Number(f.ad_months) : f.ad_yen && f.rent ? Number(f.ad_yen) / Number(f.rent) : null;
  const adDist = sentWithRun.map((h) => adOf(h.first!)).filter((x): x is number => x != null);
  console.log(`送った物件の AD（拾った時の記録・${adDist.length}件）: 1ヶ月未満 ${adDist.filter((x) => x < 1).length}・1ヶ月 ${adDist.filter((x) => x >= 1 && x < 1.5).length}・1.5ヶ月 ${adDist.filter((x) => x >= 1.5 && x < 2).length}・2ヶ月以上 ${adDist.filter((x) => x >= 2).length}`);
  console.log("  → AD順で上限に当たる回では AD 1〜1.5ヶ月の新着がページの外に残る。送付の中で AD 2ヶ月未満の割合＝" + pct(adDist.filter((x) => x < 2).length, adDist.length));
  // 更新順だけ＝更新日で絞った窓の中の物件だけを読む。漏れ＝その人の前回の検索より前に出ていて、送った時にも残っていた物（更新順＋更新日の窓では2度と出ない）
  let staleSent = 0, freshSent = 0; const staleEx: string[] = [];
  for (const h of sentWithRun) {
    const key = `${h.s.property_customer_id}|${h.first!.site}`; const runs = runsBy.get(key) ?? []; const t = ms(h.first!.sent_at);
    const idx = runs.findIndex((r) => Math.abs(r - t) <= 30 * 60_000 || (r <= t && t - r <= 30 * 60_000)); const prev = idx > 0 ? runs[idx - 1] : null;
    const fs = h.firstSeenAll ? ms(h.firstSeenAll) : null;
    if (prev != null && fs != null && fs < prev - 60_000 && fs >= censorMs) { staleSent++; if (staleEx.length < SHOW) staleEx.push(`${short(h.s.property_customer_id)} ${h.s.property_name} ${h.s.room_no ?? ""}（全体の初出 ${h.firstSeenAll!.slice(5, 16)}・その人の前回の検索 ${new Date(prev).toISOString().slice(5, 16)}・拾った ${h.first!.sent_at.slice(5, 16)}・${h.first!.label}）`); }
    else if (fs != null && fs >= censorMs) freshSent++;
  }
  console.log(`送った物件のうち『その人の前回の検索より前から全体に出ていた』＝更新日の窓＋更新順だけでは拾えない物: ${staleSent}件／『前回の検索より後に初めて出た』（更新順で拾える）: ${freshSent}件（窓の最初の7日は除く）`);
  for (const e of staleEx) console.log(`  ${e}`);
  console.log("");

  console.log("■ 9. 便ごとの1回あたりの結果（リアプロ・共有の行の数）");
  for (const l of ORDER) {
    const rows = found.filter((f) => f.label === l && f.site === "realpro");
    if (!rows.length) continue;
    const perRun = new Map<string, number>();
    for (const f of rows) { const k = `${f.property_customer_id}|${jstDate(f.sent_at)}|${jstHour(f.sent_at) < 15 ? "a" : "p"}`; perRun.set(k, (perRun.get(k) ?? 0) + 1); }
    const xs = [...perRun.values()];
    console.log(`  ${LABEL_JA[l]}: 回 ${xs.length}・1回の物件数 中央値 ${quant(xs, 0.5)}・p90 ${quant(xs, 0.9)}・最大 ${Math.max(...xs)}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
