// app/lib/check-order-wire.ts — 判断の順番の型（check-order.ts）を本番のブレインの meta につなぐ土台（純関数・DB/LLM なし・作業員22・2026-11-12）
//
// 竹内さん 11/12「他にも出来る部分は先に行っていく」・KB P1 d030d496（確認の順番・判断の順番・優先度を細かく）・fd1c7c62（配分）・親 P0 575a7cd5。
// やる事: ブレインが判断を書き終えた後の meta（既に出した欄だけ）から、作業員16 の pickCheckOrder の手がかり（CheckOrderCues）を作り、
//   先頭の型の id を meta.check_order_type に、候補と手がかりを meta.check_order に記録する。
//   読む側: 配分（conductor-allocation.allocationFromMeta が check_order_type を先に読む）・作業員10 の文の型の表（同じ id）。
// 置き方の決まり（道を引っぱらない・q406・q057・q065・q022）:
//   - 返信か AIX か（action・reply_mode・aix_now・turn_contract の route）は読まない。手がかりは場面・お客様の一通の読み・台帳の事実・こちらの送信の受け取られ方だけ。
//   - meta の判断の欄は1つも変えない（足すのは check_order_type・check_order の2つだけ）。
// スイッチ: CHECK_ORDER_TABLE（check-order.checkOrderMode・既定 off＝何も足さない＝今と同じ／shadow＝記録だけ／on＝今は shadow と同じ記録。後の欄の注記は別の段）。
// 決まった計算は候補の網（P0 9eb6aa9c: 判断はブレイン基準）。ここで選んだ型は記録で、ブレインの判断を変えない。
import { CHECK_ORDER_TYPES, pickCheckOrder, type CheckOrderCues } from "./check-order";

type Meta = Record<string, unknown>;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const FACT_BASES = new Set(["conversation", "material", "company_fact", "general"]);

/** meta（判断の後）＋今の一通の場面（reply-scene の ReplyScene）→ pickCheckOrder の手がかり。返信か AIX かの欄は読まない */
export function cuesFromMeta(meta: Meta | null | undefined, scene: string | null | undefined): CheckOrderCues {
  const m = meta ?? {};
  const rc = obj(m.read_candidates);
  const rcTurn = typeof rc?.turn === "string" ? rc.turn : null;
  const facts = obj(obj(m.action_ledger)?.facts);
  const qs = arr(m.customer_questions).filter((x) => typeof x === "string" && x.trim());
  const intent = typeof m.customer_intent === "string" ? m.customer_intent : null;
  // 依頼ごとの読み（turn_contract.asks）は「何についての問いか・答えの根拠があるか」だけ読む（route は読まない）
  const asks = arr(obj(m.turn_contract)?.asks).map(obj).filter((a): a is Record<string, unknown> => !!a);
  const qAsks = asks.filter((a) => a.kind === "question");
  const factQ = qAsks.filter((a) => FACT_BASES.has(String(a.basis)));
  const nl = obj(m.now_vs_later);
  const uptake = arr(m.our_send_uptake).map(obj);
  const anxiety = obj(obj(m.customer_mindset)?.anxiety);
  const hasQuestion = qs.length > 0 || intent === "question" || qAsks.length > 0;
  return {
    firstContact: rcTurn === "first_contact" || (!!facts && facts.propertiesSentCount === 0 && facts.lastStaffEntry == null),
    ackOnly: scene === "ack" || rcTurn === "ack_only",
    hasQuestion,
    answerableByFact: qAsks.length ? factQ.length > 0 : null,
    // 問いはあるのに、会話・資料・会社の事実のどれにも根拠が無い＝スタッフしか知らない事の候補（網・ブレインの決めではない）
    staffOnly: qAsks.length ? factQ.length === 0 : null,
    pendingPromise: facts?.pickupPromisedUnfulfilled === true || (typeof nl?.our_open === "string" && !!nl.our_open.trim()),
    resultReady: arr(nl?.ready_now).some((x) => typeof x === "string" && x.trim()),
    customerSentProperty: scene === "property_share" || rcTurn === "brought_property",
    conditionStated: scene === "conditions" || (typeof m.condition_change_type === "string" && !!m.condition_change_type),
    applySignal: scene === "apply" || intent === "decision",
    considering: scene === "considering" || (typeof m.hesitancy_pattern === "string" && !!m.hesitancy_pattern),
    topic: scene === "viewing" ? "viewing" : scene === "cost" ? "cost" : hasQuestion ? "other" : null,
    hooked: uptake.some((u) => u?.hook === "hooked"),
    takenWorry: anxiety?.target === "先に取られる",
  };
}

export type CheckOrderRecord = {
  /** 先頭の型（採る型）。手がかりが無ければ null */
  type: string | null;
  /** 候補（優先の順・最大4） */
  cands: string[];
  why: string | null;
  scene: string | null;
  /** 立った手がかりの名前だけ（true の物） */
  cues: string[];
  /** 2026-11-13 作業員16: 場面×状態の優先度の表の行（priority-table.priorityTableRecord・PRIORITY_TABLE=shadow|on の時だけ・記録だけ） */
  priority?: import("./priority-table").PriorityRecord | null;
};
const KNOWN = new Set(CHECK_ORDER_TYPES.map((t) => t.id));
export function checkOrderRecord(meta: Meta | null | undefined, scene: string | null | undefined): CheckOrderRecord {
  const cues = cuesFromMeta(meta, scene);
  const cands = pickCheckOrder(cues).filter((c) => KNOWN.has(c.id));
  const on = Object.entries(cues).filter(([k, v]) => v === true || (k === "topic" && typeof v === "string" && v !== "other")).map(([k, v]) => (k === "topic" ? `topic:${v}` : k));
  return { type: cands[0]?.id ?? null, cands: cands.slice(0, 4).map((c) => c.id), why: cands[0]?.why ?? null, scene: scene ?? null, cues: on };
}
/** digest.co（"T4>T2|scene"・型の番号だけ） */
export function checkOrderDigest(v: unknown): string | null {
  const r = obj(v);
  const cands = arr(r?.cands).filter((x): x is string => typeof x === "string");
  if (!cands.length) return null;
  return `${cands.map((c) => c.split("_")[0]).join(">")}${typeof r?.scene === "string" ? `|${r.scene}` : ""}`.slice(0, 40);
}
