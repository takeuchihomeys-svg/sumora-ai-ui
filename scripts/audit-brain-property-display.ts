// scripts/audit-brain-property-display.ts — 画面の物件名をブレイン基準にそろえた時（app/lib/brain-property-display.ts）の前後を数える
//   （読み取りのみ・LLM なし・$0）。2026-10-13 P1 0593a0aa（未桜）。
//
// ブレインの今の物件の出所: brain_decision_logs.digest->>prop（= current_property・実在ゲートの後・9/13〜）と analyzed_msg_ts。
//   新しい判断＝判断した顧客発言の時刻が、その時点の最新のお客様の発言より前でない（isBrainPickFresh）。
//
// --part=prefill  AIX の物件名の先入れの当たり率: スタッフが入れた物件名（aix_usage_logs.property_names）× 直前の新しいブレインの物件。
//                 当たり＝スタッフの名前のどれかと同じ部屋・同じ建物（片方に部屋が無い）
// --part=state    状況の1行の主のお部屋: ブレインの判断の時点で、規則だけ（今）とブレイン優先で主が変わる番を数え、変わった番を出す（目で読む）
// --part=promise  【必ず】の物件名: こちらの確認の約束の通で、本文の名前とブレイン優先の名前が変わる番を数えて出す
//
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-property-display.ts --part=prefill|state|promise [--days=60] [--show=60]
import { createClient } from "@supabase/supabase-js";
import { brainNameMatchesAny, looseMatchEnabled } from "../app/lib/property-name-loose";
import { splitPropertyName, sameBrainPropertyRef, matchRoomRefs, buildingKeyOf, isBrainPickFresh, resolveCustomerState, type BrainPropertyPick, type CustomerStateInput } from "../app/lib/customer-state";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const one = (s: string | null | undefined, n = 90) => String(s ?? "").replace(/\s*\n\s*/g, " / ").slice(0, n);
const days = Number(arg("days", "60"));
const SHOW = Number(arg("show", "60"));
const since = new Date(Date.now() - days * 86400_000).toISOString();

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

type Dec = { conversation_id: string; created_at: string; analyzed_msg_ts: string | null; prop: string | null };
async function loadDecisions(): Promise<Map<string, Dec[]>> {
  const rows = await pageAll<Dec>((a, b) => sb.from("brain_decision_logs").select("conversation_id, created_at, analyzed_msg_ts, prop:digest->>prop")
    .gte("created_at", new Date(Date.parse(since) - 7 * 86400_000).toISOString()).order("created_at").range(a, b));
  const by = new Map<string, Dec[]>();
  for (const r of rows) { const a = by.get(r.conversation_id) ?? []; a.push(r); by.set(r.conversation_id, a); }
  return by;
}
/** その時刻より前の一番新しい判断（判断ログの無い時代は null） */
function decisionAt(list: Dec[] | undefined, at: string): Dec | null {
  if (!list) return null;
  let best: Dec | null = null;
  for (const d of list) if (d.created_at <= at) best = d; else break;
  return best;
}
async function customerTimes(convIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < convIds.length; i += 50) {
    const ids = convIds.slice(i, i + 50);
    const rows = await pageAll<{ conversation_id: string; created_at: string }>((a, b) => sb.from("messages").select("conversation_id, created_at")
      .in("conversation_id", ids).eq("sender", "customer").gte("created_at", new Date(Date.parse(since) - 30 * 86400_000).toISOString()).order("created_at").range(a, b));
    for (const r of rows) { const a = out.get(r.conversation_id) ?? []; a.push(r.created_at); out.set(r.conversation_id, a); }
  }
  return out;
}
const lastBefore = (times: string[] | undefined, at: string) => { let x: string | null = null; for (const t of times ?? []) if (t <= at) x = t; else break; return x; };
const pickOf = (d: Dec | null): BrainPropertyPick | null => (d ? { name: d.prop, analyzedMsgTs: d.analyzed_msg_ts } : null);

// ─── 先入れの当たり率 ───
async function partPrefill() {
  const TYPES = ["property_check_result", "meeting_place", "viewing_invite", "application_push", "guarantor_info", "estimate_sheet"];
  const logs = await pageAll<{ conversation_id: string; created_at: string; aix_type: string; check_pattern: string | null; property_names: string[] | null }>((a, b) =>
    sb.from("aix_usage_logs").select("conversation_id, created_at, aix_type, check_pattern, property_names").in("aix_type", TYPES).not("sent_at", "is", null)
      .not("property_names", "is", null).gte("created_at", since).order("created_at").range(a, b));
  const named = logs.filter((l) => (l.property_names ?? []).some((n) => (n ?? "").trim()));
  const decs = await loadDecisions();
  const ct = await customerTimes([...new Set(named.map((l) => l.conversation_id))]);
  type K = string;
  const tally = new Map<K, { n: number; noDec: number; stale: number; nullProp: number; hit: number; miss: number }>();
  const misses: string[] = [];
  let nearMiss = 0;
  const bump = (k: K) => { const v = tally.get(k) ?? { n: 0, noDec: 0, stale: 0, nullProp: 0, hit: 0, miss: 0 }; tally.set(k, v); return v; };
  for (const l of named) {
    const names = (l.property_names ?? []).filter((n) => (n ?? "").trim());
    const key = `${l.aix_type}${l.check_pattern ? `/${l.check_pattern}` : ""}${names.length > 1 ? "（2件以上）" : ""}`;
    const v = bump(key), all = bump("全部");
    v.n++; all.n++;
    const d = decisionAt(decs.get(l.conversation_id), l.created_at);
    if (!d) { v.noDec++; all.noDec++; continue; }
    const pick = pickOf(d)!;
    if (!isBrainPickFresh(pick, lastBefore(ct.get(l.conversation_id), l.created_at))) { v.stale++; all.stale++; continue; }
    if (!(d.prop ?? "").trim()) { v.nullProp++; all.nullProp++; continue; }
    const br = splitPropertyName(d.prop);
    // 区切り1（property-name-loose）: 書き方の違いを許す照合。PROPERTY_NAME_LOOSE_MATCH=off で前の測り方
    const ok = (!!br && names.some((n) => { const r = splitPropertyName(n); return !!r && sameBrainPropertyRef(br, r); }))
      || (looseMatchEnabled() && brainNameMatchesAny(d.prop, names));
    // 表記ゆれ（似ている・片方がもう片方を含む＝customer-state では寄せない）は外れに数えるが別に数える
    if (!ok && br && names.some((n) => { const r = splitPropertyName(n); return !!r && matchRoomRefs(br, r) === "maybe"; })) nearMiss++;
    // 部屋の形: ブレインが部屋まで言ったか
    const shape = bump(`${key}｜ブレイン${br?.room ? "部屋あり" : "建物だけ"}`);
    shape.n++;
    if (ok) { v.hit++; all.hit++; shape.hit++; } else { v.miss++; all.miss++; shape.miss++; misses.push(`${l.created_at.slice(0, 16)} ${l.conversation_id.slice(0, 8)} ${key}｜ブレイン「${d.prop}」｜スタッフ「${names.join("・")}」`); }
  }
  console.log(`■ AIX の物件名 × 直前の新しいブレインの物件（${days}日・名前を入れた送信 ${named.length}件）`);
  console.log("種類 | 件数 | 判断なし | 古い | ブレイン null | 当たり | 外れ | 当たり率（ブレインが物件を言った番）");
  for (const [k, v] of [...tally.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const said = v.hit + v.miss;
    console.log(`${k} | ${v.n} | ${v.noDec} | ${v.stale} | ${v.nullProp} | ${v.hit} | ${v.miss} | ${said ? `${Math.round((v.hit / said) * 100)}%` : "-"}`);
  }
  console.log(`\n外れのうち表記ゆれ（似ている・含む）: ${nearMiss}`);
  console.log(`\n外れ（最大${SHOW}）:`);
  for (const m of misses.slice(0, SHOW)) console.log("  " + m);
}

// ─── 状況の1行 ───
async function partState() {
  const { loadCustomerStateInput } = await import("../app/lib/customer-state-server");
  const decs = await loadDecisions();
  const withProp = [...decs.entries()].map(([cid, list]) => [cid, list.filter((d) => d.created_at >= since && (d.prop ?? "").trim() && d.analyzed_msg_ts)] as const).filter(([, l]) => l.length);
  let judged = 0, stale = 0, notInLedger = 0, same = 0, changed = 0, pinned = 0;
  const verdicts = { brain: 0, rule: 0, both: 0, unknown: 0 };
  const out: string[] = [];
  for (const [cid, list] of withProp) {
    let input: CustomerStateInput | null = null;
    try { input = await loadCustomerStateInput(cid); } catch { continue; }
    if (!input) continue;
    // 同じ顧客発言への判断は最後の1件
    const byTs = new Map<string, Dec>();
    for (const d of list) byTs.set(d.analyzed_msg_ts!, d);
    const { data: msgsAll } = await sb.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", cid).gte("created_at", new Date(Date.parse(since) - 86400_000).toISOString()).order("created_at").limit(3000);
    const { data: aixAll } = await sb.from("aix_usage_logs").select("created_at, aix_type, property_names").eq("conversation_id", cid).not("sent_at", "is", null).gte("created_at", since).order("created_at").limit(500);
    for (const d of byTs.values()) {
      judged++;
      const asOf = d.created_at;
      const le = (x?: string | null) => !x || x <= asOf;
      const at: CustomerStateInput = {
        ...input, now: Date.parse(asOf),
        messages: input.messages.filter((m) => m.createdAt <= asOf), aixRows: input.aixRows.filter((r) => le(r.sent_at ?? r.created_at)),
        recordedFacts: input.recordedFacts.filter((f) => f.sent_at <= asOf), lineTasks: (input.lineTasks ?? []).filter((t) => le(t.created_at)),
        viewingHistory: input.viewingHistory.filter((v) => le(v.created_at)), sentProperties: input.sentProperties.filter((r) => le(r.sent_at)), ledger: null,
      };
      const rule = resolveCustomerState(at);
      const brain = resolveCustomerState({ ...at, brainProperty: { name: d.prop, analyzedMsgTs: d.analyzed_msg_ts } });
      const lastCust = at.messages.filter((m) => m.sender === "customer" && (m.text ?? "").trim()).at(-1);
      if (!isBrainPickFresh({ analyzedMsgTs: d.analyzed_msg_ts }, lastCust?.createdAt)) { stale++; continue; }
      if (brain.conflicts.some((c) => c.code === "BRAIN_PROPERTY_DIFFERS")) pinned++;
      if (brain.focusSource !== "brain") { notInLedger++; continue; }
      if (brain.focusKey === rule.focusKey) { same++; continue; }
      changed++;
      const ruleName = rule.properties.find((p) => p.key === rule.focusKey)?.name ?? "（主なし）";
      const brainName = brain.properties.find((p) => p.key === brain.focusKey)?.name ?? "?";
      const after = (msgsAll ?? []).filter((m) => m.created_at > asOf && m.sender === "staff" && (m.text ?? "").trim() && !/^\s*\[画像\]\s*$/.test(m.text ?? "")).slice(0, 2);
      const aixNext = (aixAll ?? []).find((a) => a.created_at > asOf && (a.property_names ?? []).length);
      // 正解の目安: 判断の後 24 時間のこちらの本文（最初の2通）と次の AIX の物件名に、どちらの建物の名前が出たか（建物の鍵の含み）
      const within = (t: string) => Date.parse(t) - Date.parse(asOf) <= 86400_000;
      const answer = buildingKeyOf([...after.filter((m) => within(m.created_at)).map((m) => m.text ?? ""), ...(aixNext && within(aixNext.created_at) ? aixNext.property_names ?? [] : [])].join(" "));
      const bk = (n: string) => splitPropertyName(n)?.buildingKey ?? "";
      const rk = bk(ruleName), bkk = bk(brainName);
      const ruleHit = !!rk && rk.length >= 3 && answer.includes(rk), brainHit = !!bkk && bkk.length >= 3 && answer.includes(bkk);
      const verdict = brainHit && !ruleHit ? "brain" : ruleHit && !brainHit ? "rule" : brainHit && ruleHit ? "both" : "unknown";
      verdicts[verdict]++;
      out.push([
        `● [${verdict}] ${asOf.slice(0, 16)} ${cid.slice(0, 8)}  規則「${ruleName}」→ ブレイン「${brainName}」（current_property「${d.prop}」）`,
        `   お客様: ${one(lastCust?.text, 110)}`,
        ...after.map((m) => `   次のこちら(${m.created_at.slice(5, 16)}): ${one(m.text, 130)}`),
        aixNext ? `   次の AIX(${aixNext.created_at.slice(5, 16)} ${aixNext.aix_type}): ${(aixNext.property_names ?? []).join("・")}` : "",
      ].filter(Boolean).join("\n"));
    }
  }
  console.log(`■ 状況の1行の主のお部屋（${days}日・ブレインが物件を言った判断 ${judged}番）`);
  console.log(`  古い判断（判断の後にお客様が話した）: ${stale}`);
  console.log(`  台帳に合うお部屋なし／記録で決まる相手（内覧予定・申込）で上書きしない: ${notInLedger}（うち記録で決まる相手と違う＝info の食い違い ${pinned}）`);
  console.log(`  ブレインのお部屋＝規則の主: ${same}`);
  console.log(`  ブレイン優先で主が変わる: ${changed}（次のこちらの本文・AIX に出た名前で: ブレインが正 ${verdicts.brain}／規則が正 ${verdicts.rule}／両方 ${verdicts.both}／どちらも出ない ${verdicts.unknown}）`);
  const only = arg("only", "");
  console.log(`\n変わる番（最大${SHOW}${only ? `・${only} だけ` : ""}）:`);
  for (const s of out.filter((x) => !only || x.startsWith(`● [${only}]`)).slice(0, SHOW)) console.log(s);
}

// ─── 【必ず】の物件名 ───
async function partPromise() {
  const { classifyStaffTextFacts } = await import("../app/lib/action-ledger");
  const { resolvePromisePropertyName, promiseBrainContext } = await import("../app/lib/brain-property-display");
  const rows = await pageAll<{ conversation_id: string; text: string | null; created_at: string }>((a, b) => sb.from("messages").select("conversation_id, text, created_at")
    .eq("sender", "staff").gte("created_at", since).ilike("text", "%確認%").order("created_at").range(a, b));
  const decs = await loadDecisions();
  const ct = await customerTimes([...new Set(rows.map((r) => r.conversation_id))]);
  const msgsBy = new Map<string, Array<{ sender: string; text: string | null; created_at: string }>>();
  const pcIds = [...new Set(rows.map((r) => r.conversation_id))];
  for (let i = 0; i < pcIds.length; i += 30) {
    const ids = pcIds.slice(i, i + 30);
    for (const m of await pageAll<{ conversation_id: string; sender: string; text: string | null; created_at: string }>((a, b) => sb.from("messages").select("conversation_id, sender, text, created_at")
      .in("conversation_id", ids).gte("created_at", new Date(Date.parse(since) - 14 * 86400_000).toISOString()).order("created_at").range(a, b))) {
      const x = msgsBy.get(m.conversation_id) ?? []; x.push(m); msgsBy.set(m.conversation_id, x);
    }
  }
  let promises = 0, fresh = 0, toBrainNoText = 0, keepAB = 0, conflict = 0, keepNoBrain = 0, guarded = 0;
  const pv = { brain: 0, wrong: 0, unknown: 0 };
  const out: string[] = [];
  for (const r of rows) {
    const es = classifyStaffTextFacts(r.text ?? "", r.created_at).filter((e) => e.kind === "confirmation_promised" && e.status === "promised");
    if (!es.length) continue;
    promises++;
    const d = decisionAt(decs.get(r.conversation_id), r.created_at);
    const pick = pickOf(d);
    // 送信時と同じ材料（promiseBrainContext: 送信より前の発言・今回の送信の束を飛ばしたお客様の今の連投）
    const before = (msgsBy.get(r.conversation_id) ?? []).filter((m) => m.created_at <= r.created_at).slice(-30).reverse();
    const ctx = promiseBrainContext(before, r.created_at);
    const lc = ctx?.latestCustomerAt ?? lastBefore(ct.get(r.conversation_id), r.created_at);
    if (!ctx || !pick || !isBrainPickFresh(pick, lc) || !(pick.name ?? "").trim()) { keepNoBrain++; continue; }
    fresh++;
    const textName = es[0].detail.propertyName ?? null;
    const res = resolvePromisePropertyName(textName, pick, { latestCustomerAt: lc, env: {}, promiseText: r.text, customerTurnTexts: ctx.customerTurnTexts });
    if (res.source === "text") { keepAB++; continue; }
    if (res.source === "none") { guarded++; continue; }
    if (res.textName) conflict++; else toBrainNoText++;
    // 正解の目安: 約束の後 72 時間の、こちらの次の AIX の物件名（物件確認した・見積書 等）にブレインの建物が入るか
    const { data: nx } = await sb.from("aix_usage_logs").select("created_at, aix_type, property_names").eq("conversation_id", r.conversation_id).not("sent_at", "is", null)
      .gt("created_at", r.created_at).lt("created_at", new Date(Date.parse(r.created_at) + 72 * 3600_000).toISOString()).not("property_names", "is", null).order("created_at").limit(3);
    const nxNames = (nx ?? []).flatMap((a) => a.property_names ?? []);
    const bks = (res.name ?? "").split(/[・、]/).map((s) => splitPropertyName(s)?.buildingKey ?? "").filter((k) => k.length >= 3);
    const ansKey = buildingKeyOf(nxNames.join(" "));
    const v = !nxNames.length ? "unknown" : bks.some((k) => ansKey.includes(k)) ? "brain" : "wrong";
    pv[v]++;
    out.push(`● [${v}] ${r.created_at.slice(0, 16)} ${r.conversation_id.slice(0, 8)} ${res.textName ? `食い違い 本文「${res.textName}」→` : "本文に名前なし →"} ブレイン「${res.name}」\n   こちら: ${one(r.text, 150)}${nxNames.length ? `\n   次の AIX: ${(nx ?? []).map((a) => `${a.aix_type}(${a.created_at.slice(5, 16)}) ${(a.property_names ?? []).join("・")}`).join(" / ")}` : ""}`);
  }
  console.log(`■ 【必ず】の物件名（${days}日・確認の約束の通 ${promises}）`);
  console.log(`  新しいブレインの物件が無い（今まで通り）: ${keepNoBrain}`);
  console.log(`  新しいブレインの物件あり: ${fresh}（本文のまま＝本文の名前にブレインの物件が入る ${keepAB}／名前なしのまま＝何件もの約束・本文に別の物件名らしい語・仮の名前 ${guarded}／本文に名前なし→ブレイン ${toBrainNoText}／食い違い→ブレイン ${conflict}）`);
  console.log(`  変わる通の次の AIX の物件名（72時間）: ブレインの物件が入る ${pv.brain}／入らない ${pv.wrong}／AIX の物件名なし ${pv.unknown}`);
  console.log(`\n変わる通（最大${SHOW}）:`);
  for (const s of out.slice(0, SHOW)) console.log(s);
}

// ─── 区切り2: current_property の安全の線・台帳の表記への寄せ（refineCurrentProperty）を 60日の判断に当てる ───
//   判断の時点の会話の文（直近120通）・台帳（送った物件・AIX の記録の物件名）で、通さない／台帳の表記に直す番を数えて出す（目で読む）
async function partRefine() {
  const { refineCurrentProperty } = await import("../app/lib/current-property-gate");
  const decs = await loadDecisions();
  const list = [...decs.entries()].map(([cid, l]) => [cid, l.filter((d) => d.created_at >= since && (d.prop ?? "").trim())] as const).filter(([, l]) => l.length);
  const cnt: Record<string, number> = {};
  const out: string[] = [];
  for (const [cid, ds] of list) {
    const [{ data: ms }, { data: sp }, { data: ax }] = await Promise.all([
      sb.from("messages").select("text, created_at").eq("conversation_id", cid).gte("created_at", new Date(Date.parse(since) - 30 * 86400_000).toISOString()).order("created_at").limit(3000),
      sb.from("sent_properties").select("property_name, room_no, sent_at").eq("conversation_id", cid).order("sent_at").limit(500),
      sb.from("aix_usage_logs").select("created_at, property_names").eq("conversation_id", cid).not("sent_at", "is", null).order("created_at").limit(500),
    ]);
    const seen = new Set<string>();
    for (const d of ds) {
      const k = `${d.analyzed_msg_ts}|${d.prop}`; if (seen.has(k)) continue; seen.add(k);
      const texts = (ms ?? []).filter((m) => m.created_at <= d.created_at).slice(-120).map((m) => m.text as string | null);
      const ledgerNames = [
        ...(sp ?? []).filter((s) => (s.sent_at ?? "") <= d.created_at).map((s) => `${s.property_name ?? ""}${s.room_no ? ` ${s.room_no}` : ""}`),
        ...(ax ?? []).filter((a) => a.created_at <= d.created_at).flatMap((a) => (a.property_names ?? []) as string[]),
      ];
      const r = refineCurrentProperty(d.prop, { texts, ledgerNames });
      cnt[r.reason] = (cnt[r.reason] ?? 0) + 1;
      if (r.reason !== "kept") out.push(`● [${r.reason}] ${d.created_at.slice(0, 16)} ${cid.slice(0, 8)} 「${d.prop}」→「${r.value ?? "（null）"}」`);
    }
  }
  console.log(`■ current_property の安全の線（${days}日・物件を言った判断）`, cnt);
  for (const s of out.slice(0, SHOW)) console.log(s);
}

// ─── 区切り3: AIX の記録の物件名を送った本文に合わせる（reconcileAixPropertyNames）を 60日の記録に当てる ───
async function partRecords() {
  const { reconcileAixPropertyNames } = await import("../app/lib/aix-sent-names");
  const { matchLoose, isSameLoose } = await import("../app/lib/property-name-loose");
  const logs = await pageAll<{ conversation_id: string; created_at: string; aix_type: string; property_names: string[] | null; generated_text: string | null }>((a, b) =>
    sb.from("aix_usage_logs").select("conversation_id, created_at, aix_type, property_names, generated_text").not("sent_at", "is", null).not("property_names", "is", null).gte("created_at", since).order("created_at").range(a, b));
  let n = 0, changed = 0;
  for (const l of logs) {
    if (!(l.property_names ?? []).length) continue;
    n++;
    const r = reconcileAixPropertyNames(l.property_names, l.generated_text, (a, b) => isSameLoose(matchLoose(a, b)), {}, l.aix_type);
    if (!r.changed) continue;
    changed++;
    console.log(`● ${l.created_at.slice(0, 16)} ${l.conversation_id.slice(0, 8)} ${l.aix_type}｜記録「${(l.property_names ?? []).join("・")}」→ 本文「${(r.names ?? []).join("・")}」\n   ${one(l.generated_text, 140)}`);
  }
  console.log(`■ AIX の記録の物件名（${days}日・名前のある記録 ${n}）: 本文に合わせて変わる ${changed}`);
}

// ─── 区切り4: 台帳の新しい ▶（並びの何番目・内覧の日にちの返事）が出る番と、その ▶ がスタッフが入れた物件名と合うか ───
async function partMaterial() {
  const { loadPropertyThreads } = await import("../app/lib/property-thread-server");
  const { brainNameMatchesAny } = await import("../app/lib/property-name-loose");
  const TYPES = ["property_check_result", "meeting_place", "viewing_invite", "application_push", "guarantor_info", "estimate_sheet"];
  const logs = (await pageAll<{ conversation_id: string; created_at: string; aix_type: string; property_names: string[] | null }>((a, b) =>
    sb.from("aix_usage_logs").select("conversation_id, created_at, aix_type, property_names").in("aix_type", TYPES).not("sent_at", "is", null)
      .not("property_names", "is", null).gte("created_at", since).order("created_at").range(a, b))).filter((l) => (l.property_names ?? []).some((n) => (n ?? "").trim()));
  const decs = await loadDecisions();
  let fired = 0, hit = 0;
  for (const l of logs) {
    const d = decisionAt(decs.get(l.conversation_id), l.created_at);
    if (!d) continue;
    const s = await loadPropertyThreads(l.conversation_id, { asOf: d.created_at });
    const tt = (s?.turnTargets ?? []).filter((t) => /＝直前にこちらが送った|内覧の日にちの返事/.test(t.why ?? ""));
    if (!tt.length) continue;
    fired++;
    const ok = tt.some((t) => brainNameMatchesAny(t.display, l.property_names ?? []));
    if (ok) hit++;
    console.log(`● [${ok ? "合う" : "合わない"}] ${l.created_at.slice(0, 16)} ${l.conversation_id.slice(0, 8)} ${l.aix_type}｜▶「${tt.map((t) => t.display).join("・")}」${tt[0].why}｜スタッフ「${(l.property_names ?? []).join("・")}」｜ブレイン「${d.prop ?? ""}」`);
  }
  console.log(`■ 新しい ▶ が出た番 ${fired}・スタッフの物件名と合う ${hit}`);
}

(async () => {
  const part = arg("part", "prefill");
  if (part === "material") { await partMaterial(); return; }
  if (part === "refine") { await partRefine(); return; }
  if (part === "records") { await partRecords(); return; }
  if (part === "prefill") await partPrefill();
  else if (part === "state") await partState();
  else if (part === "promise") await partPromise();
})().catch((e) => { console.error(e); process.exit(1); });
