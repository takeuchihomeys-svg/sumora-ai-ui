// app/lib/compose-plan-rows-v2.ts — 設計図の1行（1文）を10個の欄に細分化する（COMPOSE_PLAN_ROWS_V2・既定 off・純関数）
//   作業員10・2026-11-13（竹内さん「文の設計図の部分を細かく強化する。細分化して強化する」・統括役の10欄・点検役の実例 12362 12548 12838 12196 12164 12562 11865 12680）
//
// ■ 何を直すか（11/13 の数え）: 設計図の行は正解53番で1番あたり 1.8行・竹内さんの文は3〜5文。信頼・締めの行がほとんど立たず、誘導先の行の「何を」が25行とも空。
//   → 行の数と役目を竹内さんの場面×主の役目ごとの並び（PHRASE_ROWS_TABLE・竹内さんの180番）に合わせる。竹内さんが入れる割合が 0.5 以上の役目は立て、0.2 未満は立てない
//   → 1行に10個の欄: role・sub・uses（作業員22 の下の欄の名前と値）・source・certainty・how・why_order・length・stand・share
// ■ 立てない条件（足しすぎを止める）
//   - スタッフしか知らない番（主の依頼の道が AIX）に潜在の一文を立てない（点検 12348）
//   - 潜在の材料（latentCover）が無い時は潜在の行を立てない（作らない）
//   - 資料の事実はお客様が聞いた事（依頼ごとの答え）に結び付く物だけ使う。聞かれていない資料の事実は足さない（点検 12164「建設中のため内覧は…」を竹内さんは消した）
//   - 探す条件の番で、こちらが前に送った条件と同じ物は全部繰り返さず、変わった点だけ（点検 12196）＝ stand に no_full_repeat を付ける
// ■ 名前: 役目は作業員22 の decided-subfields の8役目（head・press・trust・latent・bridge・close）、下の欄は作業員22 の29個（fact.value・our.checked・aim.mid 等）、
//   確かさは assertable / basically / needs_check、潜在の種類は作業員16 の LATENT_KINDS

import type { SentencePlan, SevenFields, PlanRow } from "./compose-sentence-plan";
import type { SentenceRole } from "./takeuchi-anatomy-roles";
import { PHRASE_ROWS_TABLE, PHRASE_TRUST_SUB_TABLE, PHRASE_SUB_TABLE } from "./compose-phrase-catalog-data";
import { endingOf, endingsFor, trustFor, TRUST_JA, trustSubsOfText } from "./compose-phrase-catalog";
import { headWordOf, HEAD_WORD_JA } from "./compose-head";
import { strengthFromSeven } from "./next-move-types";
import { focusSubOfTakeuchiText } from "./conductor-focus";
import { composeBriefRolesOn, applyNextConcreteToRows } from "./compose-brief-roles";
import { PRIORITY_ROWS, PRIORITY_WHY_TO_V2, type PriorityRow, type PriorityWhy } from "./priority-table";
import type { ComposeFact } from "./compose-asks-facts";
import type { ClosingDecision, AnswerSource } from "./compose-value-slots";

type Env = Record<string, string | undefined>;
export function composePlanRowsV2On(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.COMPOSE_PLAN_ROWS_V2 ?? "").trim().toLowerCase() === "on";
}
export const V2_ROLES = ["head", "press", "trust", "latent", "bridge", "close"] as const;
export type V2Role = typeof V2_ROLES[number];
export const V2_ROLE_JA: Record<V2Role, string> = { head: "頭", press: "押さえ", trust: "信頼", latent: "潜在の一文", bridge: "つなぎ", close: "締め" };
/** 文の役目13種 → 6役目（build-phrase-catalog の V2_OF と同じ） */
export const V2_OF: Partial<Record<SentenceRole, V2Role>> = { greet: "head", uke: "head", answer: "press", promise: "press", trust: "trust", barrier: "trust", worry: "latent", viewing: "bridge", apply: "bridge", estimate: "bridge", ask_send: "bridge", keep: "close", close: "close" };
export type V2Sub =
  | "conclusion" | "numbers" | "name_property" | "split_known_check"
  | "effort" | "fact" | "scarcity" | "company_detail" | "support" | "options" | "honest_weak" | "deadline" | "flexible"
  | "viewing" | "estimate" | "apply" | "ask_send"
  | "their_timing" | "keep_promise" | "fixed"
  | "kashikomari" | "hai" | "arigato" | "daijobu" | "none"
  | "worry";
/** 出所の名前は compose-value-slots の AnswerSource が正（作業員22・作業員7b も揃える） */
export type V2Source = AnswerSource;
export type V2Certainty = "assertable" | "basically" | "needs_check";
export type V2WhyOrder = "greet_first" | "asked_order" | "ease_first" | "after_answer" | "keep_last";
export type PlanRowV2 = {
  role: V2Role;
  sub: V2Sub;
  /** 使う下の欄（作業員22 の名前）と値 */
  uses: Array<{ field: string; value: string }>;
  source: V2Source;
  certainty: V2Certainty;
  /** 竹内さんの言い回しの骨の札（終わりの言い方・信頼の札） */
  how: string | null;
  why_order: V2WhyOrder;
  length: "short" | "normal";
  /** 立てた理由／立てない理由の札 */
  stand: string[];
  /** この場面×主の役目で竹内さんがこの行を入れる割合（0〜1） */
  share: number | null;
  /** 元の設計図の行の役目（13種） */
  from?: SentenceRole | null;
  /** 他の文の中で言う信頼の添え（作業員9 の最終チェックの4つ目の段が下書きに出たかを数える・kind は effort | deadline | flexible） */
  embeds?: Array<{ kind: "effort" | "deadline" | "flexible"; share: number }>;
  /** 文の強さ（つなぎだけ） */
  strength?: string | null;
};
export type RowsV2Input = {
  plan: SentencePlan; s7: SevenFields; meta: unknown; scene: string | null; customerText: string;
  facts: ReadonlyArray<ComposeFact>; closing: ClosingDecision | null;
  recentStaff: ReadonlyArray<{ text: string; aix?: boolean }>;
  /** 主の依頼の道が AIX（スタッフしか知らない番） */
  staffOnlyTurn?: boolean;
  kinds?: ReadonlyArray<string>;
};
const STAND_MIN = 0.5, DROP_MAX = 0.2;
/** 信頼の下の役目: 1文として立つ物（行を立てる）と、他の文の中で言う物（押さえ・つなぎの how に添える） */
const STANDALONE_TRUST: ReadonlySet<string> = new Set(["support", "scarcity", "company_detail", "honest_weak", "options"]);
const EMBED_TRUST: Readonly<Record<string, V2Role>> = { effort: "press", deadline: "press", flexible: "bridge" };
const V2_SUB_OF_TRUST: Readonly<Record<string, V2Sub>> = { support: "support", scarcity: "scarcity", company_detail: "company_detail", honest_weak: "honest_weak", options: "options", effort: "effort", deadline: "deadline", flexible: "flexible" };
const TRUST_EMBED_JA: Readonly<Record<string, string>> = { effort: "こちらの手間を見せる", deadline: "期日を示す", flexible: "都合に合わせる" };
/** 場面×主の役目 → 下の役目（bridge.viewing・press.promise・close.fixed 等）の竹内さんの割合（3番未満は場面 * に落とす） */
export function subShareFor(scene: string | null, mainRole: SentenceRole | null, key: string): number | null {
  if (!mainRole) return null;
  const a = scene ? PHRASE_SUB_TABLE[`${scene}|${mainRole}`] : undefined;
  const t = a && a.n >= 3 ? a : PHRASE_SUB_TABLE[`*|${mainRole}`];
  return t ? t.shares.find(([k]) => k === key)?.[1] ?? 0 : null;
}
/** 下の役目で立てる線（11/13 細分化・竹内さんが入れる割合・広い正解53番で決めた）: つなぎ 0.15（0.1 は余分 7・0.25 は当たり 12）・従の押さえ 0.1（0.3 は当たり 1 減で余分同じ）・継続の約束 0.3・決まりの締め 0.5 */
export const SUB_STAND = { bridge: 0.15, press_sub: 0.1, keep_promise: 0.3, fixed: 0.5 } as const;
/** 下の役目の割合で立てる（COMPOSE_PLAN_ROWS_V2 の中・COMPOSE_ROWS_V2_SUB=off で 11/13 の前の立て方に戻す） */
export function rowsV2SubOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.COMPOSE_ROWS_V2_SUB ?? "").trim().toLowerCase() !== "off";
}
/**
 * 役目ごとに割合の線を当てるか（COMPOSE_ROWS_V2_SUB の中）。つなぎは当てない（11/13 統括役: 広い正解で当たり 17→13 に減る・余分は 8→5）＝
 * COMPOSE_ROWS_V2_SUB_BRIDGE=on の時だけ当てる。押さえ・締めは当てる（締めは落とした5行が全部竹内さんに無い下の役目）。
 */
export function rowsV2SubRoleOn(role: "press" | "bridge" | "close", env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  if (!rowsV2SubOn(env)) return false;
  if (role === "bridge") return (env.COMPOSE_ROWS_V2_SUB_BRIDGE ?? "").trim().toLowerCase() === "on";
  return true;
}
/** 作業員16 の優先度の表（meta.check_order.priority）を主の行の why_order・並べ順・立てない条件に使う（COMPOSE_PLAN_ROWS_V2 の中・COMPOSE_ROWS_V2_PRIORITY=off で止める） */
export function rowsV2PriorityOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.COMPOSE_ROWS_V2_PRIORITY ?? "").trim().toLowerCase() !== "off";
}
/** 表の「触れない話題」→ 立てない行（表の文字そのままで引く・無い物は書き手への注記だけ） */
const NO_TOUCH_BLOCKS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "内覧の日程（聞かれていない）": ["bridge.viewing"],
  "新しい物件の売り込み": ["bridge.viewing", "bridge.apply"],
};
export type RowsV2Priority = { why_tag: PriorityWhy; why_order: V2WhyOrder; row: PriorityRow | null; deferPromise: boolean; blocks: Set<string>; via: "row_id" | "type_state" | null; missing: string | null };
/**
 * meta.check_order.priority（priorityTableRecord）→ 表の行・主の why_order・後の通へ回す約束・立てない行。
 *   行は安定した id（row_id ↔ PriorityRow.id）で引く。row_id の無い古い記録だけ type＋state の文字に落とす。
 *   どちらでも引けない時は missing に印を残し、書き手への注記に「表の行が引けない」と出す（静かに落とさない・やらない事は効かない）。
 */
export function priorityForRowsV2(meta: unknown): RowsV2Priority | null {
  const rec = (meta as { check_order?: { priority?: { type?: unknown; state?: unknown; why_tag?: unknown; why_order?: unknown; row_id?: unknown } | null } } | null)?.check_order?.priority;
  if (!rec || typeof rec.why_tag !== "string" || !(rec.why_tag in PRIORITY_WHY_TO_V2)) return null;
  const why_tag = rec.why_tag as PriorityWhy;
  const rowId = typeof rec.row_id === "string" && rec.row_id ? rec.row_id : null;
  const byId = rowId ? PRIORITY_ROWS.find((r) => (r as { id?: unknown }).id === rowId) ?? null : null;
  const byText = !byId && !rowId ? PRIORITY_ROWS.find((r) => r.type === rec.type && r.state === rec.state) ?? null : null;
  const row = byId ?? byText;
  const via = byId ? "row_id" as const : byText ? "type_state" as const : null;
  const missing = row ? null : rowId ? `row_id=${rowId}` : `type=${String(rec.type ?? "-")}`;
  // 後の通へ回す依頼のうち約束の部分（11865: 新着のピックアップの約束は答えの後の別の通）＝この返信に約束の行を立てない
  const deferPromise = !!row && row.order.deferred.some((d) => row.ask_parts.some((pt) => pt.route === "promise" && (d.what.includes(pt.part) || pt.part.includes(d.what))));
  const blocks = new Set<string>((row?.avoid.no_touch ?? []).flatMap((t) => NO_TOUCH_BLOCKS[t] ?? []));
  return { why_tag, why_order: (typeof rec.why_order === "string" ? rec.why_order : PRIORITY_WHY_TO_V2[why_tag]) as V2WhyOrder, row, deferPromise, blocks, via, missing };
}
/** 物件を送る AIX の道（brain-attention の PROPERTY_AIX と同じ3つ） */
const PROPERTY_AIX: ReadonlySet<string> = new Set(["property_send", "property_recommendation", "property_search"]);
/** 場面×主の役目 → 信頼の下の役目の割合（3番未満は場面 * に落とす） */
export function trustSubsFor(scene: string | null, mainRole: SentenceRole | null): Array<[string, number]> {
  if (!mainRole) return [];
  const a = scene ? PHRASE_TRUST_SUB_TABLE[`${scene}|${mainRole}`] : undefined;
  const t = a && a.n >= 3 ? a : PHRASE_TRUST_SUB_TABLE[`*|${mainRole}`];
  return t ? t.shares : [];
}
const TIME_RE = /来週|今週|週末|明日|明後日|月末|今月中|来月|\d{1,2}月(?:\d{1,2}日|上旬|中旬|下旬|頃)?|\d{1,2}日|[月火水木金土日]曜/;
const SCARCITY_RE = /1部屋のみ|一部屋のみ|こちらの1部屋|1部屋となります|残り1|このお部屋のみ|のみとなります|2番手/;
const COMPANY_RE = /独立系|保証会社|仲介手数料|弊社|審査(?:通過|基準)|クレジットカード/;
const FROM_SOURCE: Record<ComposeFact["from"], V2Source> = { 会話: "conversation", 資料: "material", 会社の事実: "company_fact", 一般: "general", 判断: "conversation", 約束の中身: "staff_only", 見積の記録: "record", 内覧の記録: "record" };
const certaintyOf = (s: V2Source): V2Certainty => (s === "staff_only" ? "needs_check" : s === "general" ? "basically" : "assertable");
export function rowsPresence(scene: string | null, mainRole: SentenceRole | null): { n: number; at: string; roles: Map<V2Role, { share: number; pos: number }> } | null {
  if (!mainRole) return null;
  const a = scene ? PHRASE_ROWS_TABLE[`${scene}|${mainRole}`] : undefined;
  const t = a && a.n >= 3 ? { ...a, at: `${scene}|${mainRole}` } : PHRASE_ROWS_TABLE[`*|${mainRole}`] ? { ...PHRASE_ROWS_TABLE[`*|${mainRole}`], at: `*|${mainRole}` } : null;
  if (!t) return null;
  return { n: t.n, at: t.at, roles: new Map(t.roles.map(([r, s, p]) => [r as V2Role, { share: s, pos: p }])) };
}
/** 設計図の行（v1）と材料から10欄の行を作る。返す rows は竹内さんの並びの順・dropped は立てなかった行と理由 */
export function buildPlanRowsV2(i: RowsV2Input): { rows: PlanRowV2[]; dropped: Array<{ role: V2Role; why: string }>; presenceAt: string | null } {
  const mainV1 = i.plan.rows.find((r) => r.rank === "main") ?? null;
  const mainRole = mainV1?.role ?? null;
  const pres = rowsPresence(i.scene, mainRole);
  const shareOf = (r: V2Role) => pres?.roles.get(r)?.share ?? null;
  const posOf = (r: V2Role) => pres?.roles.get(r)?.pos ?? (r === "head" ? 0 : r === "close" ? 1 : 0.5);
  const dropped: Array<{ role: V2Role; why: string }> = [];
  const rows: PlanRowV2[] = [];
  const replyFacts = i.facts.filter((f) => f.from !== "約束の中身");
  const promiseFacts = i.facts.filter((f) => f.from === "約束の中身");
  const lastStaff = i.recentStaff[i.recentStaff.length - 1] ?? null;
  const ourText = i.recentStaff.map((m) => m.text).join("\n");
  const prop = i.s7.appeal?.property ?? null;
  const subOn = rowsV2SubOn(), closeSubOn = rowsV2SubRoleOn("close");
  // 作業員5 の重点の下の種類（meta.conductor_focus.focus_sub）。check_estimate＝確認と見積の両方の約束 → 押さえ（確認）とつなぎ（見積へ）の2行で受ける
  const focusSub = subOn ? String((i.meta as { conductor_focus?: { focus_sub?: unknown } } | null)?.conductor_focus?.focus_sub ?? "") : "";
  const checkEstimate = focusSub === "check_estimate";
  // 押さえの余分（11/13 広い正解で竹内さんに押さえが無いのに立てた 8番）の直し・押さえの細分化（COMPOSE_ROWS_V2_SUB の中）:
  //   ① 主の約束を確認／探して送る／見積の3つに分ける。探して送る約束は竹内さんでは締めの継続の約束（q112・q004「ピックアップ出来次第お送り」）、
  //      見積の約束はつなぎの見積へ（q055）。確認の約束だけが押さえ。種類は作業員5 の focus_sub → 無ければブレインの答えを同じ札（focusSubOfTakeuchiText）で読む → 物件を送る AIX の道なら探して送る
  //   ② 答える依頼が全部「報告・気持ち」で、会話の事実しか無い時は答えの押さえを立てない（頭の受けで受ける・q073・q141・q173・q200。竹内さんの文に答えの文が無い 4/4・押さえがある番で外れ 0）
  const pressSubOn = rowsV2SubRoleOn("press");
  const tc0 = (i.meta as { turn_contract?: { asks?: Array<{ kind?: unknown; answer?: unknown; route?: unknown }>; lead_with?: unknown } } | null)?.turn_contract;
  const leadAsk = tc0?.asks?.[typeof tc0?.lead_with === "number" ? tc0.lead_with : 0] ?? null;
  const metaAction = String((i.meta as { action?: unknown } | null)?.action ?? "");
  const mainPromiseKind: string | null = !pressSubOn || mainRole !== "promise" ? null
    : ["check", "search", "estimate", "check_estimate"].includes(focusSub) ? focusSub
    : focusSubOfTakeuchiText("promise_make", String(leadAsk?.answer ?? "")) ?? (PROPERTY_AIX.has(metaAction) ? "search" : null);
  const searchAsKeep = mainPromiseKind === "search", estimateAsBridge = mainPromiseKind === "estimate";
  const replyAsks = (tc0?.asks ?? []).filter((a) => String(a.route ?? "") !== "none");
  const prio = rowsV2PriorityOn() ? priorityForRowsV2(i.meta) : null;
  const receiveOnly = pressSubOn && mainRole === "answer" && replyAsks.length > 0 && replyAsks.every((a) => ["report", "feeling"].includes(String(a.kind ?? ""))) && replyFacts.every((f) => f.from === "会話");
  // 頭
  {
    const h = headWordOf({ customerText: i.customerText, prev: lastStaff ? { text: lastStaff.text, aix: !!lastStaff.aix } : null });
    const share = shareOf("head");
    if (h.word === "none") dropped.push({ role: "head", why: `受けなしの番（${h.why}）` });
    else rows.push({ role: "head", sub: h.word, uses: lastStaff ? [{ field: "our.sent", value: lastStaff.aix ? "AIX" : "返信" }] : [], source: "conversation", certainty: "assertable", how: HEAD_WORD_JA[h.word], why_order: "greet_first", length: "short", stand: [h.why], share, from: "uke" });
  }
  // 押さえ（主）＋ v1 のほかの行
  const v1ByV2 = new Map<V2Role, PlanRow[]>();
  for (const r of i.plan.rows) { const v2 = V2_OF[r.role]; if (!v2 || v2 === "head") continue; const a = v1ByV2.get(v2) ?? []; a.push(r); v1ByV2.set(v2, a); }
  for (const r of v1ByV2.get("press") ?? []) {
    const isPromise = r.role === "promise";
    if (r.rank === "main" && isPromise && (searchAsKeep || estimateAsBridge)) { dropped.push({ role: "press", why: searchAsKeep ? "探して送る約束は締めの継続の約束で受ける" : "見積の約束はつなぎの見積へで受ける" }); continue; }
    if (prio?.deferPromise && isPromise && r.rank !== "main") { dropped.push({ role: "press", why: "後の通へ回す約束（優先度の表）" }); continue; }
    if (!isPromise && receiveOnly) { dropped.push({ role: "press", why: `${String(leadAsk?.kind)} の依頼で会話の事実だけ（頭の受けで受ける）` }); continue; }
    // 従の押さえ（主でない答え・約束）は、竹内さんがこの場面×主の役目でその下の役目を入れる割合 SUB_STAND.press_sub 以上の時だけ
    if (rowsV2SubRoleOn("press") && r.rank !== "main" && !(checkEstimate && isPromise)) { const sh = subShareFor(i.scene, mainRole, `press.${isPromise ? "promise" : "answer"}`); if (sh != null && sh < SUB_STAND.press_sub) { dropped.push({ role: "press", why: `従の${isPromise ? "約束" : "答え"}は竹内さんの割合 ${sh}（${SUB_STAND.press_sub} 未満）` }); continue; } }
    const f0 = isPromise ? promiseFacts : replyFacts;
    const sub: V2Sub = isPromise ? "split_known_check" : f0.some((f) => /\d/.test(f.text)) ? "numbers" : prop ? "name_property" : "conclusion";
    const src: V2Source = isPromise ? "staff_only" : (i.kinds ?? []).includes("K13") ? "checked_result" : f0[0] ? FROM_SOURCE[f0[0].from] : "conversation";
    rows.push({ role: "press", sub, uses: [...f0.slice(0, 2).map((f) => ({ field: isPromise ? "our.open_promise" : "fact.value", value: f.text })), ...(isPromise && replyFacts.length ? replyFacts.slice(0, 1).map((f) => ({ field: "fact.value", value: f.text })) : [])], source: src, certainty: certaintyOf(src), how: endingsFor(i.scene, r.role)?.top[0]?.[0] ?? null, why_order: "asked_order", length: "normal", stand: [r.rank === "main" ? "主の文" : "従の文"], share: shareOf("press"), from: r.role });
  }
  // check_estimate の押さえ（確認の約束）: 設計図に約束の行が無くても立てる（「確認出来次第、最大限割引の御見積書とあわせて」の確認の半分）
  if (checkEstimate && !rows.some((r) => r.role === "press" && r.sub === "split_known_check")) {
    rows.push({ role: "press", sub: "split_known_check", uses: promiseFacts.slice(0, 2).map((f) => ({ field: "our.open_promise", value: f.text })), source: "staff_only", certainty: "needs_check", how: endingsFor(i.scene, "promise")?.top[0]?.[0] ?? null, why_order: "asked_order", length: "normal", stand: ["focus_sub check_estimate（確認の約束）"], share: shareOf("press"), from: "promise" });
  }
  // 信頼
  {
    const share = shareOf("trust");
    const have = v1ByV2.get("trust") ?? [];
    const all = [i.customerText, lastStaff?.text ?? "", ...replyFacts.map((f) => f.text)].join("\n");
    const scarce = SCARCITY_RE.exec(all)?.[0] ?? null, company = replyFacts.find((f) => f.from === "会社の事実" || COMPANY_RE.test(f.text)) ?? null;
    // 点検 12838・12240: 信頼の中身（今ある物の少なさ・会社の事実の具体）が材料にある時は、割合が低い場面でも立てる
    // 足しすぎを締める（11/13 正解53 で竹内さんに無いのに立てた 13→10・当たり 10→8）: 少なさの事実がある時（12362・12838）・会社の具体は割合 0.3 以上の場面・それ以外は割合 0.5 以上の場面だけ
    // 2026-11-13 細分化: 信頼の下の役目ごとの竹内さんの割合（PHRASE_TRUST_SUB_TABLE・場面×主の役目）。
    //   1文として立つ下の役目（サポートの姿勢・少なさ・会社の具体・正直な弱点・選択肢）は、割合 0.4 以上で立てる。
    //   他の文の中で言う下の役目（こちらの手間・期日・都合に合わせる）は行を立てず、押さえ・つなぎの行の how に添える（下の embedTrust）
    const subs = trustSubsFor(i.scene, mainRole);
    const standSub = subs.find(([k, s]) => STANDALONE_TRUST.has(k) && s >= 0.4)?.[0] ?? null;
    if (scarce || (company && (share ?? 0) >= 0.3) || standSub || (share ?? 0) >= STAND_MIN) {
      const sub: V2Sub = scarce ? "scarcity" : company ? "company_detail" : standSub ? V2_SUB_OF_TRUST[standSub] ?? "fact" : mainRole === "promise" ? "effort" : "fact";
      const tr = trustFor(i.scene, mainRole);
      rows.push({ role: "trust", sub, uses: scarce ? [{ field: "fact.value", value: scarce }] : company ? [{ field: "fact.value", value: company.text }] : [], source: company ? "company_fact" : scarce ? "material" : "conversation", certainty: "assertable", how: tr?.shares[0] ? TRUST_JA[tr.shares[0][0]] ?? null : null, why_order: "after_answer", length: "normal", stand: [have.length ? "設計図にある" : `竹内さんが入れる割合 ${share}`], share, from: have[0]?.role ?? "trust" });
    } else dropped.push({ role: "trust", why: `竹内さんが入れる割合 ${share ?? "-"}（${STAND_MIN} 未満）` });
  }
  // 潜在の一文
  {
    const share = shareOf("latent");
    const lc = i.s7.latentCover;
    if (i.staffOnlyTurn) dropped.push({ role: "latent", why: "staff_only_no_latent（スタッフしか知らない番）" });
    else if (!lc?.kind && !lc?.what) dropped.push({ role: "latent", why: "潜在の材料が無い（作らない）" });
    // 潜在の一文は「どの不安か」と「使う事実」の2つが揃う時だけ（不安だけでは文にしない・11/13 正解53 で竹内さんに無いのに立てた 8）
    else if (!lc.fact) dropped.push({ role: "latent", why: "潜在の事実が無い（不安だけでは文にしない）" });
    else if ((v1ByV2.get("latent") ?? []).length || (share ?? 0) >= STAND_MIN) {
      rows.push({ role: "latent", sub: "worry", uses: [...(lc.what ? [{ field: "latent.concern", value: lc.what }] : []), ...(lc.fact ? [{ field: "fact.value", value: lc.fact }] : [])], source: lc.fact ? "material" : "conversation", certainty: lc.fact ? "assertable" : "basically", how: lc.how ?? null, why_order: (posOf("latent") < posOf("press")) ? "ease_first" : "after_answer", length: "normal", stand: [lc.kind ? `潜在の種類 ${lc.kind}` : "潜在の材料あり"], share, from: "worry" });
    } else dropped.push({ role: "latent", why: `竹内さんが入れる割合 ${share ?? "-"}（${DROP_MAX} 未満）` });
  }
  // つなぎ
  const bridgeV1: PlanRow[] = [...(v1ByV2.get("bridge") ?? [])];
  // check_estimate のつなぎ（見積へ）: 設計図に見積の行が無くても立てる（見積の半分）
  if ((checkEstimate || estimateAsBridge) && !bridgeV1.some((r) => r.role === "estimate")) bridgeV1.push({ rank: "sub", role: "estimate", part: null, how: null, next: null, from: "focus_sub" });
  for (const r of bridgeV1) {
    if (prio?.blocks.has(`bridge.${r.role}`)) { dropped.push({ role: "bridge", why: `触れない話題（優先度の表: ${prio.row?.avoid.no_touch.join("・")}）` }); continue; }
    // つなぎは既定で割合の線を当てない（COMPOSE_ROWS_V2_SUB_BRIDGE=on の時だけ: 割合 SUB_STAND.bridge 以上・主の役目そのもの・check_estimate の見積は立てる）
    if (rowsV2SubRoleOn("bridge") && r.role !== mainRole && !((checkEstimate || estimateAsBridge) && r.role === "estimate")) { const sh = subShareFor(i.scene, mainRole, `bridge.${r.role}`); if (sh != null && sh < SUB_STAND.bridge) { dropped.push({ role: "bridge", why: `${r.role} へ誘うのは竹内さんの割合 ${sh}（${SUB_STAND.bridge} 未満）` }); continue; } }
    const strength = strengthFromSeven(i.s7.push ? { push: i.s7.push.push, strength: i.s7.push.strength } : null);
    const uses = [
      ...(prop ? [{ field: "hook.property", value: prop }] : []),
      ...(r.role === "viewing" && (r.part || i.s7.appeal?.what) ? [{ field: "hook.point", value: String(r.part ?? i.s7.appeal?.what) }] : []),
      ...(r.role === "apply" ? replyFacts.filter((f) => SCARCITY_RE.test(f.text)).slice(0, 1).map((f) => ({ field: "fact.value", value: f.text })) : []),
      ...(i.s7.bridge?.what ? [{ field: "aim.mid", value: i.s7.bridge.what }] : []),
    ];
    rows.push({ role: "bridge", sub: r.role as V2Sub, uses, source: "conversation", certainty: "assertable", how: endingsFor(i.scene, r.role)?.top[0]?.[0] ?? null, why_order: "after_answer", length: "normal", stand: [uses.length ? "何を: 下の欄から" : "何を: 材料が無い（物件名・日時を作らない）"], share: shareOf("bridge"), from: r.role, strength });
  }
  // 締め
  {
    const share = shareOf("close");
    const keep = (v1ByV2.get("close") ?? []).find((r) => r.role === "keep") ?? (searchAsKeep ? { rank: "main" as const, role: "keep" as const, part: leadAsk?.answer ? String(leadAsk.answer) : null, how: null, next: null, from: "promise_search" } : null);
    const time = TIME_RE.exec(i.customerText)?.[0] ?? null;
    const keepSh = subShareFor(i.scene, mainRole, "close.keep_promise"), fixedSh = subShareFor(i.scene, mainRole, "close.fixed");
    // 細分化（11/13）: お客様の言った時期 → 継続の約束（設計図にあって割合 0.3 以上）→ 決まりの締め（割合 0.5 以上）の順で1つ
    //   COMPOSE_ROWS_V2_SUB=off: 前の立て方（設計図に継続の約束がある・締めの割合 0.5 以上）
    const closingSign = !!(i.closing && i.closing.sign !== "none");
    const keepOk = !!keep && !prio?.deferPromise && (!closeSubOn || searchAsKeep || i.s7.leadTo === "keep" || keepSh == null || keepSh >= SUB_STAND.keep_promise || mainRole === "keep");
    const fixedOk = closingSign || (closeSubOn ? (fixedSh ?? share ?? 0) >= SUB_STAND.fixed : (share ?? 0) >= STAND_MIN);
    if (time || keepOk || fixedOk) {
      const sub: V2Sub = time ? "their_timing" : keepOk ? "keep_promise" : "fixed";
      rows.push({ role: "close", sub, uses: time ? [{ field: "latent.expect", value: time }] : keep?.part ? [{ field: "aim.mid", value: keep.part }] : [], source: "conversation", certainty: "assertable", how: time ? "お客様の言った時期で結ぶ（例: 〇〇のご連絡お待ちしております）" : endingsFor(i.scene, keep ? "keep" : "close")?.top[0]?.[0] ?? null, why_order: "keep_last", length: "short", stand: [time ? `お客様の言った時期「${time}」` : keep ? "継続の約束は主の答えの後の最後" : `竹内さんが入れる割合 ${share}`], share, from: keep ? "keep" : "close" });
    } else dropped.push({ role: "close", why: `継続の約束 ${keepSh ?? "-"}・決まりの締め ${fixedSh ?? "-"}（竹内さんの割合）` });
  }
  // 他の文の中で言う信頼（こちらの手間・期日・都合に合わせる）は、その行の how に添える（竹内さんの割合 0.4 以上の時だけ）
  for (const [k, sh] of trustSubsFor(i.scene, mainRole)) {
    const target = EMBED_TRUST[k]; if (!target || sh < 0.4) continue;
    const row = rows.find((r) => r.role === target); if (!row) continue;
    row.stand.push(`信頼の添え: ${TRUST_EMBED_JA[k]}（竹内さん ${Math.round(sh * 100)}%）`);
    (row.embeds ??= []).push({ kind: k as "effort" | "deadline" | "flexible", share: sh });
  }
  // 足しすぎの印（探す条件の番で前に送った条件を全部繰り返さない）
  if (i.scene === "conditions" && lastStaff && /ピックアップ/.test(lastStaff.text)) for (const r of rows) if (r.role === "press" || (r.role === "close" && r.sub === "keep_promise")) r.stand.push("no_full_repeat（変わった条件だけ）");
  for (const r of rows) if (r.source === "material" && r.role !== "press" && !r.uses.length) r.stand.push("no_unasked_material");
  // 統括の指示書の次の一手の具体（next_concrete）をつなぎ・締めの行の材料に（COMPOSE_BRIEF_ROLES・既定 off）
  if (composeBriefRolesOn()) applyNextConcreteToRows(rows, i.meta);
  // 優先度の表（作業員16）: 主の行の why_order・やらない事（触れない話題・繰り返さない条件）を主の行の札に
  const mainRow = rows.find((r) => r.stand.includes("主の文")) ?? rows.find((r) => r.role === "close" && r.sub === "keep_promise" && searchAsKeep) ?? null;
  if (prio && mainRow) {
    mainRow.why_order = prio.why_order;
    mainRow.stand.push(`priority:${prio.why_tag}`);
    for (const t of prio.row?.avoid.no_touch ?? []) mainRow.stand.push(`no_touch:${t}`);
    if (prio.row?.avoid.repeat_scope) mainRow.stand.push(`repeat_scope:${prio.row.avoid.repeat_scope}`);
  }
  // 表の行が引けない（row_id が表に無い・古い記録で文字が変わった）: 静かに落とさず、行の札と書き手への注記に残す
  if (prio?.missing) {
    const at = mainRow ?? rows[0] ?? null;
    if (at) at.stand.push(`priority_row_missing:${prio.missing}`);
    dropped.push({ role: at?.role ?? "press", why: `優先度の表の行が引けない（${prio.missing}）・やらない事は効かない` });
  }
  // 竹内さんの並びの順（頭→…→締め。同じ位置は元の順）。主の押さえは従の押さえより先。
  //   不安・受けが先（ease_first）の時は、信頼・潜在の行を主の押さえのすぐ後に（12362: 抑えられる部屋の答え→他の号室は2番手の事実）
  const easeFirst = prio?.why_order === "ease_first" && mainRow?.role === "press";
  const posKey = (r: PlanRowV2) => r.role === "head" ? -1 : r.role === "close" ? 2
    : (easeFirst && (r.role === "trust" || r.role === "latent") ? posOf("press") + 0.001 : posOf(r.role)) + (r.role === "press" && mainRow && r !== mainRow ? 0.002 : 0);
  const order = rows.map((r, k) => ({ r, k })).sort((a, b) => posKey(a.r) - posKey(b.r) || a.k - b.k).map((x) => x.r);
  return { rows: order, dropped, presenceAt: pres?.at ?? null };
}
/**
 * 信頼の添え（他の文の中で言う信頼）が下書きに出たかの印。作業員9 の最終チェックの4つ目の段（final-check-blueprint-match・FC_BLUEPRINT_MARK）が
 * 同じ rowsV2 から数える時の名前（印の名前は向こうの UnmatchedKind と同じ snake_case）。出たかは竹内さんの文の札付けと同じ trustSubsOfText で見る
 * （PHRASE_TRUST_SUB_TABLE を作った物差しと同じ＝竹内さんの割合と下書きを同じ線で比べられる）。印だけ・本文は変えない。
 */
export const TRUST_EMBED_MARK = { effort: "trust_embed_effort", deadline: "trust_embed_deadline", flexible: "trust_embed_flexible" } as const;
export type TrustEmbedKind = keyof typeof TRUST_EMBED_MARK;
export type TrustEmbedShown = { kind: TrustEmbedKind; mark: (typeof TRUST_EMBED_MARK)[TrustEmbedKind]; row: string; share: number; shown: boolean };
export function trustEmbedsShown(draft: string, rows: ReadonlyArray<{ role: string; embeds?: ReadonlyArray<{ kind: string; share: number }> | null }> | null | undefined): TrustEmbedShown[] {
  if (!rows?.length) return [];
  const got = new Set<string>(trustSubsOfText(String(draft ?? "")));
  const out: TrustEmbedShown[] = [];
  for (const r of rows) for (const e of r.embeds ?? []) {
    if (!(e.kind in TRUST_EMBED_MARK)) continue;
    const kind = e.kind as TrustEmbedKind;
    out.push({ kind, mark: TRUST_EMBED_MARK[kind], row: r.role, share: e.share, shown: got.has(kind) });
  }
  return out;
}
/** 最終チェックの1行のログ（fc:blueprint-unmatched）に足す欄: 立てた添えの数・出た数・出なかった印 */
export function trustEmbedLogFields(shown: ReadonlyArray<TrustEmbedShown>): { embeds: number; embeds_shown: number; embeds_missing: string[] } {
  return { embeds: shown.length, embeds_shown: shown.filter((x) => x.shown).length, embeds_missing: shown.filter((x) => !x.shown).map((x) => x.mark) };
}
export function planRowsV2Digest(rows: ReadonlyArray<PlanRowV2>): string {
  return rows.map((r) => `r2:${r.role}.${r.sub}|${r.uses.map((u) => u.field).join("+") || "-"}|${r.source}|${r.certainty}|${r.why_order}|${r.share ?? "-"}`).join(";");
}
const WHY_JA: Record<V2WhyOrder, string> = { greet_first: "最初", asked_order: "聞かれた順", ease_first: "不安を先に解く", after_answer: "答えの後", keep_last: "最後" };
const SUB_JA: Partial<Record<V2Sub, string>> = { support: "サポートの姿勢", options: "選択肢", honest_weak: "正直な弱点", deadline: "期日", flexible: "都合に合わせる", conclusion: "結論で答える", numbers: "事実を数字で", name_property: "物件名で名指し", split_known_check: "今言える部分と確認の部分を分ける", effort: "こちらの手間", fact: "事実の裏付け", scarcity: "少なさ", company_detail: "会社の具体", their_timing: "お客様の言った時期を使う", keep_promise: "継続の約束", fixed: "決まりの締め", worry: "奥の不安への一文", viewing: "内覧へ", estimate: "見積へ", apply: "申込へ", ask_send: "送ってもらう" };
/** 書き手への注記（on の時だけ・値は下の欄のまま・文は写さない） */
export function planRowsV2Note(rows: ReadonlyArray<PlanRowV2>, env?: Env): string {
  if (!composePlanRowsV2On(env) || !rows.length) return "";
  const L = rows.map((r, k) => `  ${k + 1}. ${V2_ROLE_JA[r.role]}（${SUB_JA[r.sub] ?? HEAD_WORD_JA[r.sub as keyof typeof HEAD_WORD_JA] ?? r.sub}）${r.uses.filter((u) => u.field !== "our.sent").length ? `: ${r.uses.filter((u) => u.field !== "our.sent").map((u) => u.value).join("・")}` : ""}${r.certainty === "needs_check" ? "（言い切らない・確認の約束）" : r.certainty === "basically" ? "（基本的に）" : ""}${r.how ? `／型「${r.how}」` : ""}／${WHY_JA[r.why_order]}${r.length === "short" ? "・短く" : ""}${r.stand.some((s) => s.startsWith("no_full_repeat")) ? "・前の条件を全部繰り返さず変わった点だけ" : ""}${r.embeds?.length ? `・この文の中で${r.embeds.map((e) => TRUST_EMBED_JA[e.kind]).join("・")}` : ""}${r.stand.filter((x) => x.startsWith("no_touch:")).map((x) => `・触れない: ${x.slice(9)}`).join("")}${r.stand.filter((x) => x.startsWith("repeat_scope:")).map((x) => `・繰り返さない: ${x.slice(13)}`).join("")}${r.stand.filter((x) => x.startsWith("priority_row_missing:")).map((x) => `・優先度の表の行が引けない（${x.slice(21)}）`).join("")}`);
  return `- 1文ずつの設計図（竹内さんの同じ場面の並び・この行以外の文は足さない）:\n${L.join("\n")}`;
}
export { endingOf };
