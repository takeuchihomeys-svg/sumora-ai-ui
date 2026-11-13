// app/lib/conductor-brief.ts — 番ごとの統括の指示書（CONDUCTOR_BRIEF・純関数・DB/LLM なし・作業員22・2026-11-12）
//
// 竹内さん 11/12「ブレインの統括の部分も具体的に判断できるように」「統括としての機能に足りていない部分や強化する部分あれば入れていく」
//   （親 P0 575a7cd5・8bfcdf60②下の役の答えを事実と照らして疑う・ea2a9405③自信を測って分からない時は正直に渡す）。
// 今の統括が出すのは名前（重点の種類・型の id・配分）だけで、具体の中身が無かった。今日できた部品を1つの具体の一覧にまとめる:
//   ① main     この番の主の要件（お客様の部分）……作業員21 の customer-part-types が入るまでは判断のブレインの依頼ごとの読み（turn_contract.asks）
//   ② facts    答えに使う事実と出所（会話・資料・会社の事実・一般）
//   ③ missing  足りない情報（作業員1 の INFO_KEYS・分かっていない／古い／材料が届いていない）
//   ④ open     照らし合わせの残り（作業員4 の exchange-ledger）
//   ⑤ type     型・確認の順番・なぜ（作業員16 の check-order）
//   ⑥ alloc    配分（conductor-allocation）
//   ⑦ combine  組と順番（作業員7 の send-combo-table.pickSendCombo・型×決まった道×手がかり。無ければ meta.two_message_plan_digest）
//   ⑧ next     次の一手の具体（行き先と強さ・時機は作業員16 の NEXT_MOVE_OF_TYPE、何を差し出すか・仕込み・いつは作業員7 の next-move-detail.buildNextMoveDetail）
//   ⑨ aim      目的・押さえる要点（判断の根拠のメモ judge_basis の purpose・key_point と同じ名前）
//   ⑩ doubts   下の役の答えを事実と突き合わせた疑いの印（conductor-doubt の DOUBT_TABLE・種類ごとに何と何を突き合わせるか・なぜ・直しの多い順・決め直さない）
//   ⑪ sure     番の確かさ（conductor-doubt の SURE_CUES の重み・高・中・低）と人に回す線の案（HANDOFF_RULE）
// 決まり: どの欄も事実と名前だけ。返信か AIX かを決める言葉は入れない（疑いの印は道を読んで照らすが、道を変えない）。部品が無い欄は「未」。
// スイッチ: CONDUCTOR_BRIEF（既定 off＝何も足さない／shadow・on＝meta.conductor_brief と digest.cb に記録だけ）。
//
// ■ 2026-11-13 作業員16（統括役の頼み「指示書を具体に・本番で0件」・KB 9613ffaa）: 欄を今日の名前で埋める。
//   facts   に出所の7つ（answer-source の kind・who）と確かさ（assertable／basically／needs_check）を足す
//   split   依頼ごとの 今言える部分／確認が要る部分（compose-decided.askPartsOf）
//   fetch   足りない事実の取りに行く先（material-fetch.materialFetchPlan・取り先が無い＝staff＝スタッフだけ）
//   order   確かめる順番と優先度（priority-table.priorityTableRecord の名前: first・why_tag・why_order・this_turn・answer_source・depth・defer・avoid・印）
//   combine に優先度の表の組（priority）を並べる・next に何を（offer）・いつ（when）・どの形で（form）・aim に中期（mid）
//   型（check_order_type）が無い番は check-order-wire.checkOrderRecord をこの中で作る（CHECK_ORDER_TABLE が off でも指示書の欄が埋まる・meta には書かない）
//   文の統括と書き手には briefForRole で役目ごとに要る欄だけ（decided-subfields の下の欄×役目の表から引く・BRIEF_SECTION_SUBS）
import { CHECK_ORDER_TYPES, CHECK_DEPTH, NEXT_MOVE_OF_TYPE, checkOrderById } from "./check-order";
import { checkOrderRecord } from "./check-order-wire";
import { priorityTableRecord, type PriorityRecord } from "./priority-table";
import { askPartsOf, factCertaintyOf, type Certainty } from "./compose-decided";
import { fromContractBasis, checkResultReadyOf, type AnswerSourceKind, type StaffWho } from "./answer-source";
import { materialFetchPlan, type FetchSource } from "./material-fetch";
import { SUB_FIELDS, type SubRole } from "./decided-subfields";
import { buildDecidedLedger, type DecidedItem } from "./conductor-decided";
import { pickSendCombo, routeOfMeta, type SendCombo } from "./send-combo-table";
import { buildNextMoveDetail, type Offer, type PlantFact, type When } from "./next-move-detail";
import { briefDoubts, briefSure, type BriefDoubt, type Sure, type SureCueKey } from "./conductor-doubt";
import type { InfoCell } from "./info-fill-map";
import type { OpenItem } from "./exchange-ledger";

type Env = Record<string, string | undefined>;
export type BriefMode = "off" | "shadow";
export function conductorBriefMode(env: Env = typeof process !== "undefined" ? process.env : {}): BriefMode {
  const v = String(env.CONDUCTOR_BRIEF ?? "").trim().toLowerCase();
  return v === "shadow" || v === "on" ? "shadow" : "off";
}

/** 判断の本体で集めて meta に置く入力（CONDUCTOR_BRIEF の時だけ・他の部品のスイッチが off でも集める＝プロンプトには入れない） */
export type BriefInputs = {
  /** 申込までの地図の今の駅と、要る情報の埋まり具合（info-fill-map） */
  info?: { node: string | null; cells: InfoCell[] } | null;
  /** 照らし合わせの残りと、果たし済みのこちらの約束の鍵（exchange-ledger） */
  ledger?: { open: OpenItem[]; keptPromises: string[] } | null;
};

export const BRIEF_NONE = "未" as const;
type Missing<T> = T | typeof BRIEF_NONE;
/** 答えに使う事実（出所は answer-source の7つ・確かさは compose-decided の3つ） */
export type BriefFact = { quote: string; value: string; from: string; source?: AnswerSourceKind; who?: StaffWho; certainty?: Certainty };
export type ConductorBrief = {
  main: Missing<{ from: "turn_contract"; items: Array<{ kind: string; quote: string; topic: string | null }> }>;
  facts: Missing<BriefFact[]>;
  /** 依頼ごとの 今言える部分／確認が要る部分（compose-decided.askPartsOf） */
  split?: Missing<Array<{ quote: string; source: AnswerSourceKind; who?: StaffWho; now: string | null; check: string | null; certainty: Certainty }>>;
  missing: Missing<{ node: string | null; keys: Array<{ key: string; state: string }> }>;
  /** 足りない事実の取りに行く先（material-fetch・staff＝取り先が無くスタッフだけが知る） */
  fetch?: Missing<Array<{ label: string; to: FetchSource | "staff" }>>;
  open: Missing<Array<{ kind: string; what: string; overdue: boolean }>>;
  type: Missing<{ id: string; check: string[]; why: string; depth: string; from?: "meta" | "brief" }>;
  /** 確かめる順番と優先度（priority-table の名前） */
  order?: Missing<Omit<PriorityRecord, "combo" | "type" | "state">>;
  alloc: Missing<{ name: string; parts: string[] }>;
  /** 組の正は send_combo_table（統括役の決め 11/13）。priority は優先度の表の組で「参考」として並べるだけ（主には使わない・14日の数えで寄せるか決める） */
  combine: Missing<{ combo: string; order: string; gap: string; why: string; from: "send_combo_table" | "two_message_plan"; priority?: string | null }>;
  next: Missing<{ dest: string; strength: string; timing: string; offer: Offer | null; plants: PlantFact[]; when: When | null; form?: "reply" | "aix" | "combo" | null; from: "next_move_detail" | "type_table" }>;
  aim: { purpose: string | null; purposeFrom: "judge_basis" | "type_table" | null; keyPoint: Missing<string>; mid?: Missing<string> };
  /** 統括が決めた事の1つの置き場（重点・約束・段階・誘導先・継続の約束・こちら側の状態・依頼ごとの道と答え／conductor-decided.ts） */
  decided: DecidedItem[];
  doubts: BriefDoubt[];
  /** 番の確かさ（conductor-doubt の SURE_CUES の重みの合計・人に回す線の案 handoff） */
  sure: { level: Sure; score: number; cues: SureCueKey[]; handoff: boolean };
  /** 作れなかった部品（欄の名前） */
  notYet: string[];
};

const FACT_BASES = new Set(["conversation", "material", "company_fact", "general"]);
const BASIS_JA: Record<string, string> = { conversation: "会話", material: "資料", company_fact: "会社の事実", general: "一般", judgement: "判断" };
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, n = 60): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);


export function buildConductorBrief(meta: Record<string, unknown> | null | undefined): ConductorBrief {
  const m = meta ?? {};
  const inputs = (obj(m.conductor_brief_inputs) ?? {}) as BriefInputs;
  const notYet: string[] = [];
  const asks = arr(obj(m.turn_contract)?.asks).map(obj).filter((a): a is Record<string, unknown> => !!a);

  // ① 主の要件
  const main: ConductorBrief["main"] = asks.length
    ? { from: "turn_contract", items: asks.slice(0, 4).map((a) => ({ kind: str(a.kind, 12) ?? "?", quote: str(a.quote, 40) ?? "", topic: str(a.topic, 20) })) }
    : BRIEF_NONE;
  notYet.push("customer_part");
  if (main === BRIEF_NONE) notYet.push("main");

  // ② 答えに使う事実（出所つき）
  const factAsks = asks.filter((a) => FACT_BASES.has(String(a.basis)) && str(a.answer));
  const ready = checkResultReadyOf(m);
  // 依頼ごとの部分（統括役の決め 11/13: 確認が要る部分がある依頼は needs_check＝指示書の中は常にこの形・指示書そのものが既定 off）
  const parts = askPartsOf(asks, { checkResultReady: ready, mixedNeedsCheck: true });
  const facts: ConductorBrief["facts"] = asks.length ? factAsks.slice(0, 4).map((a) => {
    const src = fromContractBasis(a.basis, a.route, { checkResultReady: ready });
    const q = typeof a.quote === "string" ? a.quote.trim().slice(0, 40) : "";
    const certainty = parts.find((p) => p.quote === q)?.certainty ?? factCertaintyOf(a, { checkResultReady: ready });
    return { quote: str(a.quote, 30) ?? "", value: str(a.answer, 60)!, from: BASIS_JA[String(a.basis)] ?? String(a.basis), source: src.kind, ...(src.who ? { who: src.who } : {}), certainty };
  }) : BRIEF_NONE;
  notYet.push("fact_id");
  if (facts === BRIEF_NONE) notYet.push("facts");
  // ②' 依頼ごとの 今言える部分／確認が要る部分
  const split: ConductorBrief["split"] = parts.length ? parts.slice(0, 4).map((p) => ({ quote: p.quote.slice(0, 30), source: p.source.kind, ...(p.source.who ? { who: p.source.who } : {}), now: p.now ? p.now.slice(0, 40) : null, check: p.check ? p.check.slice(0, 40) : null, certainty: p.certainty })) : BRIEF_NONE;
  if (split === BRIEF_NONE) notYet.push("split");

  // ③ 足りない情報
  const info = inputs.info ?? null;
  const missing: ConductorBrief["missing"] = info ? { node: info.node, keys: info.cells.filter((c) => c.state !== "known").map((c) => ({ key: c.key, state: c.state })) } : BRIEF_NONE;
  if (missing === BRIEF_NONE) notYet.push("missing");
  // ③' 足りない事実の取りに行く先（ブレインの自己申告 material_missing・BRAIN_MATERIAL_SELF_REPORT の時だけある）
  const mmLabels = arr(m.material_missing).filter((x): x is string => typeof x === "string" && !!x.trim());
  const fetch: ConductorBrief["fetch"] = Array.isArray(m.material_missing) ?materialFetchPlan(mmLabels).map((p) => ({ label: p.label.slice(0, 30), to: p.source ?? "staff" })) : BRIEF_NONE;
  if (fetch === BRIEF_NONE) notYet.push("fetch");

  // ④ 照らし合わせの残り
  const ledger = inputs.ledger ?? null;
  const open: ConductorBrief["open"] = ledger ? ledger.open.slice(0, 5).map((o) => ({ kind: o.kind, what: o.what.slice(0, 40), overdue: o.overdue })) : BRIEF_NONE;
  if (open === BRIEF_NONE) notYet.push("open");

  // ⑤ 型・確認の順番・なぜ
  //   型が meta に無い番（CHECK_ORDER_TABLE が off）は、ここで同じ関数で作る（meta には書かない・指示書の中だけ）
  const metaType = typeof m.check_order_type === "string" ? m.check_order_type : null;
  const coRec = obj(m.check_order) ? null : (() => { try { return checkOrderRecord(m, typeof m.check_order_scene === "string" ? m.check_order_scene : null); } catch { return null; } })();
  const typeId = metaType ?? coRec?.type ?? null;
  const t = typeId ? checkOrderById(typeId) : null;
  const type: ConductorBrief["type"] = t ? { id: t.id, check: [...t.check], why: t.why.slice(0, 80), depth: `${CHECK_DEPTH[t.id]?.base ?? "?"}${CHECK_DEPTH[t.id]?.via ? `+${CHECK_DEPTH[t.id]!.via}` : ""}`, from: metaType ? "meta" : "brief" } : BRIEF_NONE;
  if (type === BRIEF_NONE) notYet.push("type");

  // ⑤' 確かめる順番と優先度（priority-table・場面×状態の行。手がかりの合わない状態は 未）
  const pr = typeId ? (() => { try { return priorityTableRecord(coRec ? { ...m, check_order: coRec, check_order_type: typeId } : { ...m, check_order_type: typeId }); } catch { return null; } })() : null;
  const order: ConductorBrief["order"] = pr ? { row_id: pr.row_id, hit: pr.hit, first: pr.first, why_tag: pr.why_tag, this_turn: pr.this_turn, answer_source: pr.answer_source, deferred: pr.deferred, depth: pr.depth, avoid: pr.avoid, why_order: pr.why_order, conflicts: pr.conflicts } : BRIEF_NONE;
  if (order === BRIEF_NONE) notYet.push("order");

  // ⑥ 配分
  const ca = obj(m.conductor_allocation);
  const alloc: ConductorBrief["alloc"] = ca && typeof ca.name === "string" && Array.isArray(ca.parts) ? { name: ca.name, parts: (ca.parts as unknown[]).map(String) } : BRIEF_NONE;
  if (alloc === BRIEF_NONE) notYet.push("alloc");

  // ⑦ 組と順番
  // 組と順番: 型×決まった道（routeOfMeta＝道は読むだけ）×手がかり（作業員7 の表・記録だけ）
  const nl = obj(m.now_vs_later);
  const unkept = (ledger?.open ?? []).filter((o) => o.kind === "our_promise_unkept").length;
  // 型が決まらない番は組を選ばない（道だけでは選べない・未）
  const combo = !typeId ? null : pickSendCombo({ type: typeId, route: routeOfMeta(m), cues: {
    firstContact: typeId === "T11_first_contact_hearing", resultReady: typeId === "T10_result_ready" || arr(nl?.ready_now).length > 0,
    openPromise: unkept > 0, multiTopics: asks.filter((a) => a.kind === "question").length >= 2,
  } });
  const plan2 = str(m.two_message_plan_digest, 40);
  const combine: ConductorBrief["combine"] = combo ? { combo: combo.combo, order: combo.order, gap: combo.gap, why: combo.why.slice(0, 80), from: "send_combo_table", priority: pr?.combo ?? null } : plan2 ? { combo: plan2, order: "", gap: "", why: "", from: "two_message_plan", priority: pr?.combo ?? null } : BRIEF_NONE;
  if (combine === BRIEF_NONE) notYet.push("combine");

  // ⑧ 次の一手（型の表・作業員7 の具体は未）
  const nm = t ? NEXT_MOVE_OF_TYPE[t.id]?.usual : null;
  const anxT = String(obj(obj(m.customer_mindset)?.anxiety)?.target ?? "");
  const worry = anxT === "先に取られる" ? "taken" : anxT === "審査" ? "screening" : anxT === "費用" ? "cost" : null;
  const detail = nm ? buildNextMoveDetail({ dest: nm.dest, situation: { checkType: typeId, worry, property: "unknown" }, combo: (combo?.combo ?? null) as SendCombo | null }) : null;
  const next: ConductorBrief["next"] = nm ? { dest: nm.dest, strength: nm.strength, timing: nm.timing, offer: detail?.offer ?? null, plants: detail?.plants.map((p) => p.fact) ?? [], when: detail?.when ?? null, form: detail?.form ?? null, from: detail ? "next_move_detail" : "type_table" } : BRIEF_NONE;
  if (next === BRIEF_NONE) notYet.push("next");

  // ⑨ 目的・要点（判断の根拠のメモと同じ名前）
  const jb = obj(m.judge_basis);
  const jbPurpose = str(jb?.purpose, 20);
  const keyPoint = str(jb?.key_point, 50) ?? str(jb?.keyPoint, 50);
  const aim: ConductorBrief["aim"] = jbPurpose ? { purpose: jbPurpose, purposeFrom: "judge_basis", keyPoint: keyPoint ?? BRIEF_NONE } : t ? { purpose: t.priority[0] ?? null, purposeFrom: "type_table", keyPoint: keyPoint ?? BRIEF_NONE } : { purpose: null, purposeFrom: null, keyPoint: keyPoint ?? BRIEF_NONE };
  if (aim.keyPoint === BRIEF_NONE) notYet.push("key_point");
  //   中期（次の2〜3番でどこへ）: 作業員7 の turn_aims.midAim → judge_next.dest（decided-subfields の aim.mid と同じ取り先）
  aim.mid = str(obj(m.turn_aims)?.midAim, 30) ?? str(obj(m.judge_next)?.dest, 20) ?? BRIEF_NONE;
  if (aim.mid === BRIEF_NONE) notYet.push("mid");

  // ⑩ 疑いの印（下の役の答えを事実と突き合わせる・決め直さない）
  const doubts = briefDoubts(m, { asks, ledger, info, typeId });
  // ⑪ 確かさ
  const sure = briefSure(m, { doubts, info, typeId });
  // ⑫ 決めた事の台帳（作業員24 の根A）
  const decided = buildDecidedLedger(m, { openPromises: (ledger?.open ?? []).filter((o) => o.kind === "our_promise_unkept").map((o) => o.what) });
  return { main, facts, split, missing, fetch, open, type, order, alloc, combine, next, aim, decided, doubts, sure, notYet };
}

/** 指示書の欄 → 届き方の表（decided-subfields）の下の欄。文の統括と書き手へは、この下の欄の役目に当たる欄だけ渡す（表は decided-subfields が正） */
export const BRIEF_SECTION_SUBS: Readonly<Record<string, readonly string[]>> = {
  main: ["focus.first"],
  facts: ["fact.value", "fact.source", "fact.certainty"],
  split: ["fact.for_ask"],
  missing: ["aim.to_apply"],
  fetch: ["our.checked"],
  open: ["our.open_promise"],
  type: ["priority.why"],
  order: ["priority.first", "priority.why", "priority.why_order", "priority.now", "priority.defer", "priority.avoid"],
  combine: ["priority.combo"],
  next: ["aim.mid", "aim.plant"],
  aim: ["aim.turn", "aim.mid"],
};
/** 役目 → 渡す指示書の欄の名前（下の欄の役目の和）。alloc・doubts・sure・decided は統括の中だけ（書き手へは渡さない） */
export function briefSectionsForRole(role: SubRole): string[] {
  return Object.entries(BRIEF_SECTION_SUBS).filter(([, subs]) => subs.some((sub) => SUB_FIELDS.find((f) => f.sub === sub)?.roles.includes(role))).map(([k]) => k);
}
/** 役目ごとに要る欄だけの指示書（未の欄は渡さない） */
export function briefForRole(b: ConductorBrief | null | undefined, role: SubRole): Record<string, unknown> {
  if (!b) return {};
  const src = b as unknown as Record<string, unknown>;
  return Object.fromEntries(briefSectionsForRole(role).filter((k) => src[k] !== undefined && src[k] !== BRIEF_NONE).map((k) => [k, src[k]]));
}

/** digest.cb の1行（判断の根拠と同じ名前: type・purpose・missing・open・doubt・sure） 例 "T4|p:confirm_promise|m:2|o:1|f:1|d:fact_missed|s:mid!|未:7"（! は人に回す線の案に当たった） */
export function conductorBriefDigest(v: unknown): string | null {
  const b = obj(v) as unknown as ConductorBrief | null;
  if (!b || !b.sure) return null;
  const n = (x: unknown) => (x === BRIEF_NONE ? "未" : Array.isArray(x) ? String(x.length) : x && typeof x === "object" && Array.isArray((x as { keys?: unknown }).keys) ? String((x as { keys: unknown[] }).keys.length) : "?");
  const ty = b.type === BRIEF_NONE ? "未" : b.type.id.split("_")[0];
  return [
    ty, `p:${b.aim?.purpose ?? "?"}`, `m:${n(b.missing)}`, `o:${n(b.open)}`, `f:${n(b.facts)}`,
    b.doubts.length ? `d:${b.doubts.map((d) => d.kind).join(",")}` : "d:-", `s:${b.sure.level}${b.sure.handoff ? "!" : ""}`, `未:${b.notYet.length}`,
    // 2026-11-13 作業員16: 優先度の表の札とずれの印（order がある番だけ・aix_before_asks を試験の答案で数える）
    ...(b.order && b.order !== BRIEF_NONE ? [`w:${b.order.why_tag}${b.order.conflicts.length ? `!${b.order.conflicts.filter((c) => !c.includes(":")).join(",")}` : ""}`] : []),
  ].join("|").slice(0, 120);
}

/** 型の一覧（テスト用・型の表にある id だけ） */
export const BRIEF_TYPE_IDS: readonly string[] = CHECK_ORDER_TYPES.map((x) => x.id);
