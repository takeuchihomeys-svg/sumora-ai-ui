// ブレインの段階（checkpoint_stage）と会話の方向の段階（conversation_direction.current_phase）の新しい決め方（app/lib/brain-stage.ts）を
// 本番の直近の会話に当て、前後の変化を一覧にする（読み取りのみ・LLM なし・書き込みなし）。
// 2026-09-27 竹内「この問題直して大丈夫」（ブレインの段階に内覧が出ない・方向の段階が戦略の文の語で決まる・穴:G1）
//
//   各会話の最後のブレインの判断（last_brain_meta）が見たお客様の発言の時刻 T（analyzed_msg_ts＋90秒）で customer-state を作り直し（T より後の材料は外す）、
//     前: 保存されている checkpoint_stage ／ 旧の方向の段階（戦略の文の語 = 旧 detectPhaseFromBrainMeta の写し）
//     後: correctBrainStage ／ resolveDirectionPhase
//   を並べる。お客様の名前は伏せる（会話ID先頭8桁・お客様の最後の発言は70字まで・電話番号を伏せる）。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-stage.ts   （DAYS=30・SHOW=all で変わらない会話も全部）
import { createClient } from "@supabase/supabase-js";
import { loadCustomerStateInput } from "../app/lib/customer-state-server";
import { resolveCustomerState, STAGE_LABEL, type CustomerStateInput } from "../app/lib/customer-state";
import { correctBrainStage, resolveDirectionPhase } from "../app/lib/brain-stage";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const DAYS = Number(process.env.DAYS ?? 30);
const SHOW = process.env.SHOW ?? "";
const id8 = (s: string) => s.slice(0, 8);
const mask = (s: string | null | undefined) => (s ?? "").replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "[電話]").replace(/[^\s、。！!？?「」（）()\n:：]{1,8}(さん|様)/g, "〇〇$1").replace(/\s+/g, " ").slice(0, 70);
const cnt = (a: string[]) => { const m: Record<string, number> = {}; for (const v of a) m[v] = (m[v] ?? 0) + 1; return Object.entries(m).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join("・"); };
const APPLY_OR_LATER = new Set(["applying", "application", "screening", "approved", "contract", "closed_won", "closed_lost"]);

/** 旧 brain-core detectPhaseFromBrainMeta の写し（前後の比較のためだけ・2026-09-27 に置き換え） */
function legacyPhase(meta: Record<string, unknown>, convStatus: string | null, hasApplicationHistory: boolean): string {
  if (convStatus === "applying") return "applying";
  const txt = [meta.action, meta.closing_strategy, meta.next_steps].filter(Boolean).join(" ");
  if (/再探し|また探|別の物件|審査落/.test(txt)) return hasApplicationHistory ? "proposing" : "hearing";
  const isShinsaAnxiety = /審査.{0,10}(不安|心配)/.test(txt);
  const hasApplyingSignal = /申込/.test(txt) || (/審査/.test(txt) && !isShinsaAnxiety);
  if (hasApplyingSignal && !/再|また|別/.test(txt)) return "applying";
  if (/内覧(?!可)|内見(?!可)/.test(txt)) return "viewing";
  if (/提案|物件/.test(txt)) return "proposing";
  return "hearing";
}

function cutAt(input: CustomerStateInput, t: number): CustomerStateInput {
  const le = (s: string | null | undefined) => !s || Date.parse(s) <= t;
  return {
    ...input,
    now: t,
    messages: input.messages.filter((m) => le(m.createdAt)),
    aixRows: input.aixRows.filter((r) => le(r.sent_at ?? r.created_at)),
    recordedFacts: input.recordedFacts.filter((f) => le((f as { sent_at?: string | null }).sent_at ?? null)),
    viewingHistory: input.viewingHistory.filter((v) => le(v.created_at ?? null)),
    sentProperties: input.sentProperties.filter((s) => le(s.sent_at)),
    lineTasks: (input.lineTasks ?? []).filter((x) => le(x.created_at)),
    ledger: null,
  };
}

async function main() {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const rows: any[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("conversations")
      .select("id,status,line_source_type,is_post_apply,property_customer_id,conversation_direction,last_brain_meta,brain_analyzed_at")
      .gte("brain_analyzed_at", since).range(i, i + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  const convs = rows.filter((c) => c.line_source_type !== "group" && c.id !== YUMA && c.last_brain_meta && c.last_brain_meta.analyzed_msg_ts && c.last_brain_meta.analyzed_msg_ts >= since);
  // 申込経験者（sent_properties.applicant_rank）
  const pcIds = convs.map((c) => c.property_customer_id).filter(Boolean);
  const ranked = new Set<string>();
  for (let i = 0; i < pcIds.length; i += 200) {
    const { data } = await sb.from("sent_properties").select("property_customer_id").in("property_customer_id", pcIds.slice(i, i + 200)).not("applicant_rank", "is", null);
    for (const r of data ?? []) ranked.add(r.property_customer_id);
  }
  console.log(`対象会話 ${convs.length}（${DAYS}日にブレインの判断あり・グループと YUMA を除く）`);

  type Row = { id: string; status: string; post: boolean; csStage: string; csDetail: string | null; csSince: string | null; oldStage: string; newStage: string; src: string; storedPhase: string; legacy: string; newPhase: string; lastCust: string; closing: string; headline: string };
  const out: Row[] = [];
  let failed = 0;
  for (const c of convs) {
    const meta = c.last_brain_meta as Record<string, unknown>;
    const t = Date.parse(String(meta.analyzed_msg_ts)) + 90_000;
    let input: CustomerStateInput | null = null;
    try { input = await loadCustomerStateInput(c.id); } catch { failed++; continue; }
    if (!input) { failed++; continue; }
    const cut = cutAt(input, t);
    const cs = resolveCustomerState(cut);
    const oldStage = typeof meta.checkpoint_stage === "string" ? meta.checkpoint_stage : "(null)";
    const corr = correctBrainStage(meta.checkpoint_stage as string | null, { stage: cs.stage, since: cs.since }, t, { conditionChangeType: (meta.condition_change_type as string | null) ?? null });
    const hasApp = ["applying", "screening", "closed_lost"].includes(c.status ?? "") || (!!c.property_customer_id && ranked.has(c.property_customer_id));
    const merged = { ...meta, checkpoint_stage: corr.stage };
    const lastCust = [...cut.messages].reverse().find((m) => m.sender === "customer" && (m.text ?? "").trim());
    out.push({
      id: c.id, status: c.status ?? "", post: APPLY_OR_LATER.has(c.status ?? "") || !!c.is_post_apply,
      csStage: cs.stage, csDetail: cs.stageDetail, csSince: cs.since,
      oldStage, newStage: corr.stage ?? "(null)", src: corr.source,
      storedPhase: String(c.conversation_direction?.current_phase ?? "(none)"),
      legacy: legacyPhase(meta, c.status, hasApp),
      newPhase: resolveDirectionPhase({ checkpointStage: merged.checkpoint_stage as string | null, status: c.status, hasApplicationHistory: hasApp }),
      lastCust: mask(lastCust?.text), closing: mask(String(meta.closing_strategy ?? "")), headline: cs.headline,
    });
  }
  if (failed) console.log(`読み込めなかった会話 ${failed}`);
  const pre = out.filter((r) => !r.post);
  console.log(`\n== 前: 保存されている段階（申込前 ${pre.length}件） ==`);
  console.log(`checkpoint_stage: ${cnt(pre.map((r) => r.oldStage))}`);
  console.log(`status=viewing の段階: ${cnt(pre.filter((r) => r.status === "viewing").map((r) => r.oldStage))}`);
  console.log(`customer-state が内覧の場面: ${cnt(pre.filter((r) => ["viewing_arranging", "viewing_scheduled", "viewed"].includes(r.csStage)).map((r) => `${STAGE_LABEL[r.csStage as keyof typeof STAGE_LABEL]}→${r.oldStage}`))}`);
  console.log(`方向の段階（保存）: ${cnt(pre.map((r) => r.storedPhase))}`);
  const appl = out.filter((r) => r.storedPhase === "applying");
  console.log(`方向=applying ${appl.length}件の checkpoint_stage: ${cnt(appl.map((r) => r.oldStage))}`);

  console.log(`\n== 後 ==`);
  console.log(`checkpoint_stage: ${cnt(pre.map((r) => r.newStage))}`);
  console.log(`status=viewing の段階: ${cnt(pre.filter((r) => r.status === "viewing").map((r) => r.newStage))}`);
  console.log(`方向の段階（新）: ${cnt(pre.map((r) => r.newPhase))}`);
  console.log(`方向（旧の語の決め方）→（新）: ${cnt(pre.filter((r) => r.legacy !== r.newPhase).map((r) => `${r.legacy}→${r.newPhase}`))}`);

  const changed = out.filter((r) => r.oldStage !== r.newStage);
  console.log(`\n== ブレインの段階が変わる会話 ${changed.length}件（申込以降 ${changed.filter((r) => r.post).length}） ==`);
  for (const r of changed) console.log(`${id8(r.id)} [${r.status}] ${r.oldStage}→${r.newStage} ｜状況: ${r.headline}${r.csSince ? `（${r.csSince.slice(5, 16)}〜）` : ""}\n    お客様: ${r.lastCust}`);

  const phaseChanged = pre.filter((r) => r.legacy !== r.newPhase);
  console.log(`\n== 方向の段階が変わる会話（申込前 ${phaseChanged.length}件・旧の語→新） ==`);
  for (const r of phaseChanged) console.log(`${id8(r.id)} [${r.status}] ${r.legacy}→${r.newPhase}（段階 ${r.oldStage}→${r.newStage}）｜状況: ${r.headline}\n    戦略: ${r.closing}\n    お客様: ${r.lastCust}`);

  const kept = pre.filter((r) => ["viewing_arranging", "viewing_scheduled", "viewed"].includes(r.csStage) && r.newStage !== "viewing");
  console.log(`\n== 内覧の場面なのに viewing にしなかった会話 ${kept.length}件（上げない理由を読む） ==`);
  for (const r of kept) console.log(`${id8(r.id)} [${r.status}] 段階=${r.oldStage} ｜状況: ${r.headline}${r.csSince ? `（${r.csSince.slice(5, 16)}〜）` : ""}\n    お客様: ${r.lastCust}`);

  const llmViewingEarly = pre.filter((r) => r.oldStage === "viewing" && !["viewing_arranging", "viewing_scheduled", "viewed"].includes(r.csStage));
  console.log(`\n== LLM は viewing・customer-state は内覧の場面でない ${llmViewingEarly.length}件（下げない） ==`);
  for (const r of llmViewingEarly) console.log(`${id8(r.id)} [${r.status}] ｜状況: ${r.headline}\n    お客様: ${r.lastCust}`);
  if (SHOW === "all") for (const r of out) console.log(`${id8(r.id)} ${r.status} cs=${r.csStage} ${r.oldStage}→${r.newStage} phase ${r.storedPhase}/${r.legacy}→${r.newPhase}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
