// AIX 用の Jev に「ブレインの材料」を渡すと当たりが変わるかの前後比べ（読み取りのみ・DB は書かない。Jev の使用量だけ llm_usage_logs に残る）
//
// 2026-09-29 竹内「材料は渡す・答えは渡さない」（memory feedback_jev_brain_materials）。
//   前（今）: 会話8通＋状態＋送った物件数＋直前の AIX（本番の影と同じ）
//   後（新）: 前＋ buildAixJevMaterials（要約・登録の条件・段階・台帳・直近の AIX・今回だけ／切り替えの語）
//   正解: スタッフが実際に押した AIX（aix_usage_logs・送った物だけ）とピッカー（check_pattern の「何を確認したか」・send_mode・app_sub_mode）
//   参考: 同じ場面のブレインの提案（brain_decision_logs・その発言の後〜押す前の最新）
//
// ⚠ 過去の場面は「その時点の材料」に戻す（未来の事実が混ざると当たりが水増しになる）:
//   ・会話・AIX・送付の記録・内覧・タスク … 押した時刻より前だけ（customer-state-server の読み込みを時刻で切る）
//   ・登録の条件 … property_condition_history でその時刻より後の変更を old_value に戻す（scoring-learning-episodes.customerAt）
//   ・お客様の要約（ai_summary_json）… 履歴が無い。ai_summary_at がその時刻より前の時だけ使う（既定）。
//       --current-summary を付けると今の要約を入れる「上限の目安」（未来の混入あり）も並べる
//   ・仮名化（pii-pseudonym）は会話・材料の両方。申込以降の会話・YUMA は除く
// 実行: npx tsx --env-file=.env.local scripts/eval-jev-aix-materials.ts [--days=60] [--per-type=8] [--limit=60] [--show=40] [--out=path.json] [--current-summary]
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { createMasker } from "../app/lib/pii-pseudonym";
import { evaluateAixWithJev, evaluatePickerWithJev, hasPickerQuestion, CHECK_PATTERN_TO_TOPIC, TOPIC_CHECK_PATTERNS, JEV_AIX_OPTIONS, type JevStateMessage } from "../app/lib/aix-jev";
import { buildAixJevMaterials, type AixJevMaterials, type JevCustomerRow } from "../app/lib/aix-jev-materials";
import { isJevEnabled } from "../app/lib/jev-client";
import { isPostApplyStatus } from "../app/lib/llm-alt-provider";
import { loadCustomerStateInput } from "../app/lib/customer-state-server";
import { resolveCustomerState } from "../app/lib/customer-state";
import { buildActionLedger } from "../app/lib/action-ledger";
import { customerAt, type ConditionHistoryRow } from "../app/lib/scoring-learning-episodes";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "60"));
const PER_TYPE = Number(arg("per-type", "8"));
const LIMIT = Number(arg("limit", "60"));
const SHOW = Number(arg("show", "40"));
const OUT = arg("out", "");
const CURRENT_SUMMARY = process.argv.includes("--current-summary");

const PC_COLS = "desired_area, area_mode, floor_plan, rent_min, rent_max, floor_area_min, floor_area_max, walk_minutes, commute_station, commute_minutes, move_in_time, pet, initial_cost_limit, building_age, preferences, ng_points, other_requests, ai_summary_json, ai_summary_at";

type Log = { id: string; conversation_id: string; aix_type: string; check_pattern: string | null; send_mode: string | null; app_sub_mode: string | null; created_at: string; conversation_status: string | null };
type Arm = "before" | "after" | "after_cur";
type ArmResult = { aix: string | null; aixProb: number | null; picker: string | null; pickerProb: number | null };

function pickerTruth(l: Log): string | null {
  if (l.aix_type === "property_check_result") return l.check_pattern && TOPIC_CHECK_PATTERNS.has(l.check_pattern) ? CHECK_PATTERN_TO_TOPIC[l.check_pattern] : null;
  if (l.aix_type === "application_push") return l.app_sub_mode;
  if (l.aix_type === "property_send" || l.aix_type === "property_recommendation") return l.send_mode;
  return null;
}

async function main() {
  if (!isJevEnabled()) { console.log("TYPESAFE_API_KEY が無いので何もしない"); return; }
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const { data: logsRaw, error } = await sb.from("aix_usage_logs")
    .select("id, conversation_id, aix_type, check_pattern, send_mode, app_sub_mode, created_at, conversation_status")
    .gte("created_at", since).neq("conversation_id", YUMA).not("sent_at", "is", null)
    .order("created_at", { ascending: false }).limit(5000);
  if (error) throw error;
  // 種類ごとに新しい順・1会話1件（同じ会話の連打で偏らない）。ピッカーの正解がある行を先に取る
  const byType = new Map<string, Log[]>();
  const seen = new Set<string>();
  const logs = ((logsRaw ?? []) as Log[]).filter((l) => l.aix_type in JEV_AIX_OPTIONS && !isPostApplyStatus(l.conversation_status));
  logs.sort((a, b) => Number(!!pickerTruth(b)) - Number(!!pickerTruth(a)));
  for (const l of logs) {
    const key = `${l.aix_type}:${l.conversation_id}`;
    if (seen.has(key)) continue;
    const arr = byType.get(l.aix_type) ?? [];
    if (arr.length >= PER_TYPE) continue;
    seen.add(key); arr.push(l); byType.set(l.aix_type, arr);
  }
  const sample = [...byType.values()].flat().slice(0, LIMIT);
  console.log(`=== AIX の Jev: 材料なし（前）と材料あり（後）の比べ（${DAYS}日・種類ごと最大${PER_TYPE}件・計${sample.length}件）===`);

  const { data: nameRows } = await sb.from("conversations").select("id, customer_name, property_customer_id").limit(5000);
  const convOf = new Map<string, { name: string; pcId: string | null }>();
  const knownNames: string[] = [];
  for (const r of ((nameRows ?? []) as Array<{ id: string; customer_name: string | null; property_customer_id: string | null }>)) {
    const n = (r.customer_name ?? "").trim();
    convOf.set(r.id, { name: n, pcId: r.property_customer_id });
    if (n) knownNames.push(n);
  }

  const arms: Arm[] = CURRENT_SUMMARY ? ["before", "after", "after_cur"] : ["before", "after"];
  const stat = new Map<Arm, { aixN: number; aixOk: number; hiN: number; hiOk: number; pkN: number; pkOk: number; probOkSum: number; probNgSum: number; ngN: number }>();
  for (const a of arms) stat.set(a, { aixN: 0, aixOk: 0, hiN: 0, hiOk: 0, pkN: 0, pkOk: 0, probOkSum: 0, probNgSum: 0, ngN: 0 });
  const perType = new Map<string, Record<Arm, { n: number; ok: number }>>();
  const brainStat = { n: 0, ok: 0 };
  const details: Array<Record<string, unknown>> = [];
  let summaryUsed = 0;

  for (const l of sample) {
    const T = l.created_at;
    const Tms = Date.parse(T);
    const conv = convOf.get(l.conversation_id) ?? { name: "", pcId: null };
    const masker = createMasker({ conversationId: l.conversation_id, customerName: conv.name || null, knownNames });
    const mask = (s: string) => masker.maskBlock(s);

    // ── その時点の読み込み（ブレインと同じ部品: customer-state-server の読み込み → 時刻で切る）
    const input = await loadCustomerStateInput(l.conversation_id).catch(() => null);
    if (!input) continue;
    // ⚠ 場面の時刻は「押した時刻」ではなく「その前の最後のお客様の発言」（ブレイン・本番の影が走る瞬間）。
    //   aix_usage_logs.created_at は**送った後**に付く（sent_at より約2秒後・実測 10日300件）ので、押した時刻で切ると
    //   その AIX 自身の本文（直前15分に平均2〜6通）・送った物件・台帳の記録が材料に入り、答えが漏れる（「0分前に物件を送った」→ Jev は none）
    const lastCustBeforeT = [...input.messages].reverse().find((m) => m.sender === "customer" && Date.parse(m.createdAt) < Tms);
    if (!lastCustBeforeT) continue;
    const Cms = Date.parse(lastCustBeforeT.createdAt) + 1;
    const before = <X>(xs: X[], at: (x: X) => string | null | undefined) => xs.filter((x) => { const t = Date.parse(at(x) ?? ""); return Number.isFinite(t) && t < Cms; });
    const msgs = before(input.messages, (m) => m.createdAt);
    const cut = {
      ...input, now: Cms, messages: msgs,
      aixRows: before(input.aixRows, (r) => r.sent_at ?? r.created_at),
      recordedFacts: before(input.recordedFacts, (f) => f.sent_at),
      viewingHistory: before(input.viewingHistory, (v) => v.created_at ?? v.scheduled_date),
      sentProperties: before(input.sentProperties, (s) => s.sent_at),
      lineTasks: before(input.lineTasks ?? [], (t) => t.created_at),
      brainPhase: null, brainSituation: null,   // ブレインの段階は入れない（材料にも使わない）
    };
    const state = resolveCustomerState(cut);
    const last15 = msgs.slice(-15);
    const lastCust = [...msgs].reverse().find((m) => m.sender === "customer") ?? null;
    const ledger = buildActionLedger({
      recentAixRows: [...cut.aixRows].reverse().slice(0, 30),
      messages: last15.map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.createdAt, isAix: !!m.isAix, lineMessageId: m.lineMessageId ?? null })),
      lineTasks: cut.lineTasks, lastCustomerAt: lastCust?.createdAt ?? null, recordedFacts: cut.recordedFacts, now: Cms,
    });
    // 未返信のお客様の連投（最後のスタッフ発言より後）
    const lastStaffIdx = msgs.map((m) => m.sender).lastIndexOf("staff");
    const unreplied = msgs.slice(lastStaffIdx + 1).filter((m) => m.sender === "customer").map((m) => m.text ?? "").join("\n");

    type PcRow = JevCustomerRow & { ai_summary_at?: string | null };
    let pc: PcRow | null = null;
    let restored: string[] = [];
    if (conv.pcId) {
      const [{ data: pcRow }, { data: hist }] = await Promise.all([
        sb.from("property_customers").select(PC_COLS).eq("id", conv.pcId).maybeSingle(),
        sb.from("property_condition_history").select("changed_field, old_value, created_at").eq("property_customer_id", conv.pcId).limit(500),
      ]);
      if (pcRow) {
        const r = customerAt(pcRow as Record<string, unknown>, (hist ?? []) as ConditionHistoryRow[], new Date(Cms).toISOString());
        pc = r.c as unknown as PcRow; restored = r.restored;
      }
    }
    const summaryAsOf = pc?.ai_summary_at && Date.parse(pc.ai_summary_at) < Cms;
    if (summaryAsOf) summaryUsed++;
    const matInput = {
      now: Cms, state, ledger: ledger.facts, latestCustomerText: unreplied, mask,
      recentAix: [...cut.aixRows].reverse().map((r) => ({ aix_type: r.aix_type, check_pattern: r.check_pattern ?? null, created_at: r.created_at ?? lastCustBeforeT.createdAt, sent_at: r.sent_at ?? null })),
    };
    const materials: AixJevMaterials | null = buildAixJevMaterials({ ...matInput, customer: pc ? { ...pc, ai_summary_json: summaryAsOf ? pc.ai_summary_json : null } : null });
    const materialsCur: AixJevMaterials | null = CURRENT_SUMMARY ? buildAixJevMaterials({ ...matInput, customer: pc }) : null;

    const masked: JevStateMessage[] = msgs.slice(-8).map((m) => ({ sender: m.sender, text: mask(m.text ?? ""), createdAt: m.createdAt, isAix: !!m.isAix }));
    const lastAix = [...cut.aixRows].reverse()[0]?.aix_type ?? null;
    const base = { messages: masked, status: l.conversation_status, sentPropertyCount: ledger.facts.propertiesSentCount, lastAixType: lastAix, conversationId: l.conversation_id, timeoutMs: 15_000 };
    const truthPk = pickerTruth(l);

    const res: Partial<Record<Arm, ArmResult>> = {};
    for (const arm of arms) {
      const mat = arm === "before" ? null : arm === "after" ? materials : materialsCur;
      const ev = await evaluateAixWithJev({ ...base, materials: mat });
      const pk = truthPk && hasPickerQuestion(l.aix_type) ? await evaluatePickerWithJev({ ...base, aixType: l.aix_type, materials: mat }) : null;
      const r: ArmResult = { aix: ev?.decision.aix ?? null, aixProb: ev?.decision.aixProb ?? null, picker: pk?.decision.picker ?? null, pickerProb: pk?.decision.prob ?? null };
      res[arm] = r;
      const s = stat.get(arm)!;
      if (r.aix) {
        s.aixN++;
        const ok = r.aix === l.aix_type;
        if (ok) { s.aixOk++; s.probOkSum += r.aixProb ?? 0; } else { s.ngN++; s.probNgSum += r.aixProb ?? 0; }
        if ((r.aixProb ?? 0) >= 0.8) { s.hiN++; if (ok) s.hiOk++; }
        const pt = perType.get(l.aix_type) ?? ({} as Record<Arm, { n: number; ok: number }>);
        pt[arm] = pt[arm] ?? { n: 0, ok: 0 }; pt[arm].n++; if (ok) pt[arm].ok++;
        perType.set(l.aix_type, pt);
      }
      if (truthPk && r.picker) { s.pkN++; if (r.picker === truthPk) s.pkOk++; }
    }
    // 参考: 同じ場面のブレインの提案（その発言の後〜押す前の最新）
    const { data: bd } = await sb.from("brain_decision_logs").select("suggested_action, created_at").eq("conversation_id", l.conversation_id)
      .lt("created_at", T).gte("created_at", new Date(Cms - 60_000).toISOString()).order("created_at", { ascending: false }).limit(1);
    const brainAct = ((bd ?? [])[0] as { suggested_action: string | null } | undefined)?.suggested_action ?? null;
    if (bd && bd.length) { brainStat.n++; if (brainAct === l.aix_type) brainStat.ok++; }

    details.push({
      conv: l.conversation_id.slice(0, 8), at: T, truth: l.aix_type, truthPicker: truthPk, brain: brainAct,
      customer: mask(unreplied || (lastCust?.text ?? "")).replace(/\s+/g, " ").slice(0, 120),
      ...Object.fromEntries(arms.map((a) => [a, res[a]])),
      restoredFields: restored, summaryAsOf: !!summaryAsOf, materials,
    });
    process.stdout.write(".");
  }
  console.log("");

  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
  console.log(`\nお客様の要約がその時点で有った場面: ${summaryUsed}/${details.length}（無い場面は要約なしで比べる）`);
  console.log(`\n■ AIX（全ボタンから1つ）の一致率（正解＝スタッフが押した AIX）`);
  for (const a of arms) {
    const s = stat.get(a)!;
    console.log(`  ${a.padEnd(10)} ${s.aixOk}/${s.aixN} = ${pct(s.aixOk, s.aixN).padStart(6)}  確率0.8以上 ${s.hiOk}/${s.hiN} = ${pct(s.hiOk, s.hiN)}  平均確率 当たり ${(s.probOkSum / Math.max(1, s.aixOk)).toFixed(2)}／外れ ${(s.probNgSum / Math.max(1, s.ngN)).toFixed(2)}`);
  }
  console.log(`  参考 ブレイン（brain_decision_logs・その発言の後〜押す前）: ${brainStat.ok}/${brainStat.n} = ${pct(brainStat.ok, brainStat.n)}`);
  console.log(`\n■ ボタンが決まった後のピッカーの一致率（本番の影と同じ形）`);
  for (const a of arms) { const s = stat.get(a)!; console.log(`  ${a.padEnd(10)} ${s.pkOk}/${s.pkN} = ${pct(s.pkOk, s.pkN)}`); }
  console.log(`\n■ 種類ごと（AIX）`);
  for (const [k, v] of [...perType.entries()].sort()) console.log(`  ${k.padEnd(24)} ${arms.map((a) => `${a}=${v[a]?.ok ?? 0}/${v[a]?.n ?? 0}`).join("  ")}`);

  console.log(`\n■ 前と後で答えが違った場面（目で読む）`);
  let shown = 0;
  for (const d of details) {
    const b = d.before as ArmResult | undefined, a = d.after as ArmResult | undefined;
    if (!b || !a || (b.aix === a.aix && b.picker === a.picker)) continue;
    if (shown++ >= SHOW) break;
    const mark = (r: ArmResult) => `${r.aix}(${(r.aixProb ?? 0).toFixed(2)})${r.picker ? `/${r.picker}(${(r.pickerProb ?? 0).toFixed(2)})` : ""}`;
    console.log(`\n  ${d.conv} ${d.at} 正解=${d.truth}${d.truthPicker ? `/${d.truthPicker}` : ""} ブレイン=${d.brain ?? "-"}`);
    console.log(`    客「${d.customer}」`);
    console.log(`    前=${mark(b)}  後=${mark(a)}  ${b.aix === d.truth ? "前○" : "前×"}${a.aix === d.truth ? "後○" : "後×"}`);
    console.log(`    材料: ${JSON.stringify(d.materials).slice(0, 700)}`);
  }
  if (OUT) { writeFileSync(OUT, JSON.stringify(details, null, 1), "utf8"); console.log(`\n詳細: ${OUT}`); }
  setTimeout(() => process.exit(0), 300);
}
main().catch((e) => { console.error(e); process.exit(1); });
