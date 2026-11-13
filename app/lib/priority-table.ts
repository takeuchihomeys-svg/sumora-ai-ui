// app/lib/priority-table.ts — 場面×状態ごとの「優先度の表」（純関数・定数だけ・作業員16・2026-11-13）
//
// 竹内さん 11/13「優先度の部分等を具体的にできるように。統括の部分を細分化して強化する」。
//   KB P1 d030d496（判断の順番・確認の順番・優先度の細分化）・P0 7d6fe3eb（統括が状況で確認の順番を選び、なぜを持つ）・ef6626d7（深さ）・41dadfe6（竹内さんの番だけで作る）。
//   弱い所 conductor:order-table-single-line（順番の表が1本）・brain:aix-before-asks-no-now-later（aix を先に決め、依頼ごとの道より先に AIX を出す）を、
//   場面×状態の行に分けて直す土台。行の数・実例は竹内さん本人の番だけ（従業員の番は数えない）。
// 1行＝1つの場面×状態（check-order の型 id ＋状態の手がかり）。6つの欄:
//   ① first        一番先に応える事（どの依頼か・なぜか・なぜの札 why_tag）＝judge-basis-types の Priority の名前
//   ② order        依頼の並べ順（主と従・後に回す依頼と理由）
//   ③ checks       確かめる順番と深さ（check-order の CheckStep・judge-basis-types の BasisDepth／BasisDepthVia）
//   ④ now_vs_later 今やる事（brain-now-later の this_turn・answer_source）
//      ask_parts   依頼を「今言える部分／確認が要る部分」に分けた物（ask-parts の AskPart と同じ形）
//   ⑤ combo        返信と AIX の組と順番（send-combo-table の SendCombo の名前）
//   ⑥ avoid        やらない事（no_touch＝触れない話題・repeat_scope＝繰り返さない条件）
//   ＋ tags        なぜその順かの札（文）
// 置き方: 統括の記録（meta.check_order.priority）に残し、文の設計図の why_order（compose-plan-rows-v2 の V2WhyOrder）へ名前で渡す。
//   道（返信か AIX か）は変えない。ブレインの道と表の先頭がずれた時は印（conflicts）を残すだけ（P0 9eb6aa9c: 判断はブレイン基準）。
// スイッチ: PRIORITY_TABLE（既定 off＝何も足さない／shadow・on＝記録だけ）。

import type { Priority, BasisDepth, BasisDepthVia } from "./judge-basis-types";
import type { CheckStep } from "./check-order";
import type { NowThisTurn, AnswerSource } from "./brain-now-later";
import type { AskPart } from "./ask-parts";
import type { SendCombo } from "./send-combo-table";
import type { V2WhyOrder } from "./compose-plan-rows-v2";

type Env = Record<string, string | undefined>;
export function priorityTableOn(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  const v = String(env.PRIORITY_TABLE ?? "").trim().toLowerCase();
  return v === "on" || v === "shadow";
}

/** なぜその依頼が一番先か（札）。文の設計図の why_order（V2WhyOrder）へ写す名前を1か所で持つ */
export const PRIORITY_WHY = ["decider_first", "ask_first", "doubt_first", "worry_first", "receive_first", "now_part_first", "result_first", "promise_first"] as const;
export type PriorityWhy = typeof PRIORITY_WHY[number];
export const PRIORITY_WHY_JA: Record<PriorityWhy, string> = {
  decider_first: "決め手の問いが先（物件を決める手前・他の答えが空振りになる）",
  ask_first: "問いが先（答えないと信頼が作れない）",
  doubt_first: "疑問が先（答えないまま約束するとこちらへの不信が残る）",
  worry_first: "不安が先（取られる・埋まる不安の事実を同じ通で）",
  receive_first: "受けが先（外す・断るを受けないと押されたと感じる）",
  now_part_first: "言える部分が先（確かめる部分は約束に分け、両にらみにしない）",
  result_first: "約束の果たしが先（結果・事実を先に・誘いは後）",
  promise_first: "約束が先（確かめる前に答えると作り話になる）",
};
/** 札 → 設計図の主の行の why_order（compose-plan-rows-v2）。従の行は after_answer、後の通へ回す物はこの返信の行に立てない */
export const PRIORITY_WHY_TO_V2: Record<PriorityWhy, V2WhyOrder> = {
  decider_first: "asked_order", ask_first: "asked_order", doubt_first: "asked_order", now_part_first: "asked_order", promise_first: "asked_order", result_first: "asked_order",
  worry_first: "ease_first", receive_first: "ease_first",
};

/** 行を選ぶ状態の手がかり（ブレインが既に出した欄から作る・網＝決めではない） */
export type PriorityCues = {
  multiAsks?: boolean;      // 問いが2つ以上
  splitParts?: boolean;     // 1つの依頼に今言える部分と確認が要る部分が混ざる（ask-parts）
  askedAgain?: boolean;     // こちらの送信への問い返し・食い違い（our_send_uptake の asked_again／misread）
  notHooked?: boolean;      // 送った物件が刺さっていない（外す）
  hooked?: boolean;
  takenWorry?: boolean;
  firstContact?: boolean;
  hasQuestion?: boolean;
  resultReady?: boolean;
  broughtUnchecked?: boolean;
  ackOnly?: boolean;
  pendingPromise?: boolean;
};

export type PriorityRow = {
  /** 安定した行の id（型 id＋状態の短い英語）。一度付けたら変えない（state の説明は自由に直せる）。設計図（作業員10）はこの id で行を引く */
  id: string;
  /** check-order の型 id */
  type: string;
  /** その型の中の状態（説明） */
  state: string;
  /** 状態の手がかり（無い行はその型の受け） */
  match?: (c: PriorityCues) => boolean;
  first: { need: Priority; what: string; why: string; why_tag: PriorityWhy };
  order: { main: string; subs: string[]; deferred: Array<{ what: string; why: string }> };
  checks: { steps: CheckStep[]; depth: BasisDepth; via?: BasisDepthVia; why: string };
  /** 今の番（主の依頼）: brain-now-later の名前 */
  now_vs_later: { this_turn: NowThisTurn; answer_source: AnswerSource };
  /** 依頼の部分（ask-parts の形） */
  ask_parts: AskPart[];
  combo: SendCombo;
  avoid: { no_touch: string[]; repeat_scope: string | null };
  tags: string[];
  /** 竹内さんの番の数・実例（従業員の番は数えない） */
  count: string;
};

export const PRIORITY_ROWS: readonly PriorityRow[] = [
  // 手がかりが重なる時（問い返しで問いも複数）は問い返しの行を先に取る（疑問に答えないと他の答えも信じてもらえない・11865）
  {
    id: "T2_question_fact.asked_again", type: "T2_question_fact", state: "こちらの送信への問い返し（掲載との食い違い）", match: (c) => !!c.askedAgain,
    first: { need: "answer", what: "おとり物件という事か", why: "疑問に答えないまま約束を言うと、こちらへの不信が残る", why_tag: "doubt_first" },
    order: { main: "ポータルの掲載の仕組み（答え）", subs: ["掲載の物件も送ってもらえれば確認する"], deferred: [{ what: "新着のピックアップの約束", why: "答えの後の別の通（竹内さんは約10分後に2通目）" }] },
    checks: { steps: ["read_ask", "hypothesize", "our_last_send", "fact_answer", "now_vs_later"], depth: "normal", via: "back", why: "こちらの直前の送信（掲載終了の確認）を見て、疑問が掲載へかこちらへかを分ける" },
    now_vs_later: { this_turn: "answer", answer_source: "company_fact" },
    ask_parts: [
      { part: "掲載の仕組み", source: "company_fact", certainty: "assertable", route: "reply" },
      { part: "新着のピックアップ", source: "none", certainty: "assertable", route: "promise" },
    ],
    combo: "reply_reply",
    avoid: { no_touch: [], repeat_scope: "ピックアップの約束は答えの後に1回" },
    tags: ["疑問への答えが先", "約束は後の通"],
    count: "点検役の 11865（ブレインの下書きは約束が先・答えが後）",
  },
  {
    id: "T2_question_fact.multi_asks", type: "T2_question_fact", state: "問いが複数（この物件で良いかの確かめ＋空き・色・入居日）", match: (c) => !!c.multiAsks,
    first: { need: "answer", what: "この物件で良いかに当たる問い（空き・色など物件の中身）", why: "お客様は物件を決める手前。決め手の問いに先に答えないと、入居日の答えが空振りになる", why_tag: "decider_first" },
    order: { main: "物件の中身の問い（空いている部屋・色）", subs: ["入居日（会社の事実の期間）", "事情（異動で11/16以降）への受け"], deferred: [{ what: "白基調の別の物件", why: "物件の中身の答えが『合わない』の時だけ、AIX で別の物件を出す" }] },
    checks: { steps: ["read_ask", "our_last_send", "fact_answer", "staff_only", "now_vs_later"], depth: "deep", via: "fact", why: "4つの問いの答えの出所が別（資料の値・会社の事実・代わりの物件）。出所ごとに分けないと、答えられる物まで確認の約束に倒れる" },
    now_vs_later: { this_turn: "answer", answer_source: "material_value" },
    ask_parts: [
      { part: "空いている部屋・色", source: "material_value", certainty: "assertable", route: "reply" },
      { part: "入居日", source: "company_fact", certainty: "basically", route: "reply" },
      { part: "白基調の別の物件", source: "none", certainty: "assertable", route: "aix" },
    ],
    combo: "reply_then_aix_quick",
    avoid: { no_touch: ["聞かれていない募集状況以外の条件"], repeat_scope: "事情（異動）は受けを1回だけ" },
    tags: ["決め手の問いが先", "答えの出所で分ける", "合わない時だけ代わり"],
    count: "点検役の 12548（1通に問い4つ・主は『この物件で良いか』）・竹内さんは返信→3分後に白基調の物件を AIX",
  },
  {
    id: "T12_hooked_comparing_taken.hold_which", type: "T12_hooked_comparing_taken", state: "抑えられる部屋の確かめ（申込の手前）",
    first: { need: "answer", what: "抑えられる部屋はどれか", why: "答えそのものが申込の手前の判断材料。取られる不安の事実（他の号室の申込）も同じ通で", why_tag: "worry_first" },
    order: { main: "抑えられるのは送った202号室", subs: ["他の号室は申込が入り2番手以降", "202も申込が入る可能性"], deferred: [] },
    checks: { steps: ["read_ask", "hypothesize", "our_last_send", "fact_answer", "now_vs_later"], depth: "deep", via: "back", why: "「間取りの確かめ」か「抑える手前」かを読みの候補で分けないと、取られる不安への先回りが落ちる" },
    now_vs_later: { this_turn: "answer", answer_source: "material_value" },
    ask_parts: [{ part: "抑えられる部屋", source: "material_value", certainty: "assertable", route: "reply" }],
    combo: "reply_only",
    avoid: { no_touch: ["内覧の日程（聞かれていない）"], repeat_scope: null },
    tags: ["答えが先", "取られる不安の事実を同じ通で", "他の号室の申込状況"],
    count: "点検役の 12362＝q438（ブレインの下書きは202の答えだけで、他の号室と取られる線が抜けた）",
  },
  {
    id: "T1_conditions_first.drop_sent", type: "T1_conditions_first", state: "送った物件を外す（場所の割に高い）", match: (c) => !!c.notHooked,
    first: { need: "send_promise", what: "その物件を外して、条件の線で探し直す約束", why: "外す事を受けないと、合わない物件を押されたと感じる", why_tag: "receive_first" },
    order: { main: "対象から外す", subs: ["エリアと家賃の上限を復唱して探す約束"], deferred: [{ what: "物件の束", why: "ピックアップが揃ってから AIX（竹内さんは11分後）" }] },
    checks: { steps: ["read_ask", "our_last_send", "now_vs_later"], depth: "normal", via: "back", why: "どの送った物件のどの点（家賃×場所）が合わないかを、こちらの送信で確かめる" },
    now_vs_later: { this_turn: "promise", answer_source: "none" },
    ask_parts: [
      { part: "外して探す", source: "none", certainty: "assertable", route: "promise" },
      { part: "物件の束", source: "none", certainty: "assertable", route: "aix" },
    ],
    combo: "promise_then_aix_later",
    avoid: { no_touch: ["お客様が言っていない条件の上乗せ（白基調・リフォーム済み 等）"], repeat_scope: "登録の条件の全部の復唱はしない（言い直した線だけ）" },
    tags: ["外す受けが先", "言っていない条件を足さない"],
    count: "点検役の 12196＝q407（ブレインの下書きは言っていない条件を足した）",
  },
  {
    id: "T8_cost.split_parts", type: "T8_cost", state: "初期費用の項目を外せるか（必須か・外せるか）", match: (c) => !!c.splitParts,
    first: { need: "answer", what: "鍵交換代は必須か（資料で言える部分）", why: "今言える部分を先に答え、確かめる部分は約束に分ける（両にらみにしない）", why_tag: "now_part_first" },
    order: { main: "必須かどうか（資料）", subs: ["外せるかは管理会社に確かめる約束"], deferred: [{ what: "外した額の御見積書", why: "管理会社の答えの後" }] },
    checks: { steps: ["read_ask", "fact_answer", "staff_only", "now_vs_later"], depth: "normal", via: "fact", why: "1つの依頼の中に資料で言える部分と管理会社の部分が混ざる（ask-parts）" },
    now_vs_later: { this_turn: "answer", answer_source: "material_value" },
    ask_parts: [
      { part: "必須か", source: "material_value", certainty: "assertable", route: "reply" },
      { part: "外せるか", source: "staff_only", who: "mgmt", certainty: "needs_check", route: "promise" },
    ],
    combo: "promise_then_aix_later",
    avoid: { no_touch: [], repeat_scope: "前に言った初期費用の予算は繰り返さない" },
    tags: ["言える部分が先", "確かめる部分は約束", "前に言った初期費用5万以内"],
    count: "点検役の 12643＝q411",
  },
  // ─── 弱い所 brain:aix-before-asks-no-now-later の行（AIX を先に出しがちな状態・竹内さん本人の番の数） ───
  {
    id: "T11_first_contact_hearing.ask_first", type: "T11_first_contact_hearing", state: "初回で問い・不安がある",
    first: { need: "answer", what: "初回の問い・不安への答え", why: "いきなりフォーム（AIX）だと機械的に見え、信頼が作れない。答えてから聞く", why_tag: "ask_first" },
    order: { main: "挨拶＋問いへの答え", subs: [], deferred: [{ what: "AIX【条件ヒアリング】", why: "答えの返信の数秒〜1分半後（フォームの案内の返信は決まった文）" }] },
    checks: { steps: ["read_ask", "fact_answer", "now_vs_later"], depth: "normal", via: "fact", why: "初回は送った物が無いので遡らない。問いが会社の事実で答えられるかだけ確かめる" },
    now_vs_later: { this_turn: "answer", answer_source: "company_fact" },
    ask_parts: [
      { part: "問い・不安への答え", source: "company_fact", certainty: "basically", route: "reply" },
      { part: "条件ヒアリング", source: "none", certainty: "assertable", route: "aix" },
    ],
    combo: "reply_then_aix_quick",
    avoid: { no_touch: ["条件が揃う前の物件名・家賃の言い切り"], repeat_scope: null },
    tags: ["問いが先", "フォームは後"],
    count: "竹内さんの番 11/12 監査 120日（グループを外した704番）: 初回83番で RA 3・RAR 9（返信＋2分以内の AIX 6組・間隔の中央30秒）",
  },
  {
    id: "T10_result_ready.result_ready", type: "T10_result_ready", state: "前の約束の結果が手元（空いていた・見積ができた・募集終了）",
    first: { need: "keep_result", what: "確かめた結果（事実・金額）", why: "約束を果たす事実を先に正確に渡す。誘い・次の手は後の返信で人の言葉で", why_tag: "result_first" },
    order: { main: "結果の AIX（物件確認した・見積書）", subs: [], deferred: [{ what: "内覧・申込への誘い（悪い知らせなら代わりの物件）", why: "結果の後の返信（関係を縮めない）" }] },
    checks: { steps: ["read_ask", "our_last_send", "staff_only", "now_vs_later"], depth: "normal", via: "back", why: "開いている約束と、その結果が揃っているかを遡って確かめる" },
    now_vs_later: { this_turn: "deliver", answer_source: "staff_only" },
    ask_parts: [{ part: "確かめた結果", source: "staff_only", who: "mgmt", certainty: "assertable", route: "aix" }],
    combo: "aix_then_reply",
    avoid: { no_touch: ["結果を待たずに言った見込み"], repeat_scope: "約束の言い直しはしない（果たす番）" },
    tags: ["約束の果たしが先", "誘いは後の返信"],
    count: "竹内さんの番 200日 AR 79・11/12 監査 120日 AR 56",
  },
  {
    id: "T4_property_shared.brought_unchecked", type: "T4_property_shared", state: "持ち込みの物件・まだ募集状況を確かめていない", match: (c) => !!c.broughtUnchecked,
    first: { need: "confirm_promise", what: "募集状況を確かめる約束（＋確認出来次第の御見積書）", why: "確かめる前に空き・見積を出すと作り話・無駄な見積になる。今の番は約束まで", why_tag: "promise_first" },
    order: { main: "募集状況の確認の約束", subs: ["確認出来次第、最大限割引の御見積書とあわせて連絡"], deferred: [{ what: "AIX【物件確認した】→【見積書】", why: "確かめた後で順に（1通に詰めない）" }] },
    checks: { steps: ["read_ask", "hypothesize", "our_last_send", "staff_only", "now_vs_later"], depth: "deep", via: "back", why: "何のために送ったか（空き／費用／条件の参考）を読みの候補で分けてから約束の中身を決める" },
    now_vs_later: { this_turn: "promise", answer_source: "staff_only" },
    ask_parts: [
      { part: "空いているか", source: "staff_only", who: "mgmt", certainty: "needs_check", route: "promise" },
      { part: "御見積書", source: "staff_only", who: "mgmt", certainty: "needs_check", route: "aix" },
    ],
    combo: "promise_then_aix_later",
    avoid: { no_touch: ["確かめる前の空き・金額"], repeat_scope: null },
    tags: ["約束が先", "見積は空きの後"],
    count: "竹内さん本人の約100日（同じ日の2通目のこちらの最初の手）: 約束 18／直接の AIX 5（KB 0f475703）",
  },
  {
    id: "T5_ack_hypothesis.ack_after_promise", type: "T5_ack_hypothesis", state: "約束の後のお礼・了承だけ", match: (c) => !!c.ackOnly && !!c.pendingPromise,
    first: { need: "relation", what: "お礼への短い受け＋約束を守る姿勢", why: "お礼の番に約束を果たす AIX を出すと、聞かれていない物を先に押す。果たすのは揃ってから", why_tag: "receive_first" },
    order: { main: "短い受け", subs: ["約束を守る姿勢"], deferred: [{ what: "約束を果たす AIX", why: "物件・結果が揃ってから（お礼の番の後）" }] },
    checks: { steps: ["read_ask", "hypothesize", "our_last_send", "now_vs_later"], depth: "shallow", why: "直前のこちらの約束で何への了承かを決めるだけ（材料は取りに行かない）" },
    now_vs_later: { this_turn: "ack", answer_source: "none" },
    ask_parts: [{ part: "お礼・了承", source: "none", certainty: "assertable", route: "reply" }],
    combo: "reply_only",
    avoid: { no_touch: ["新しい物件の売り込み"], repeat_scope: "約束の中身を全部言い直さない" },
    tags: ["受けが先", "果たすのは揃ってから"],
    count: "竹内さんの ack・considering 44通のうち約束の後 keep 5（check-order T5）",
  },
];

/** 型と状態の手がかりから行を選ぶ（網・ブレインの決めではない＝P0 9eb6aa9c）。手がかりの合う行→手がかりの無い行（その型の受け）→null */
export function priorityRowFor(type: string | null | undefined, cues: PriorityCues = {}): { row: PriorityRow; hit: "state" | "type" } | null {
  if (!type) return null;
  const rows = PRIORITY_ROWS.filter((r) => r.type === type);
  const byState = rows.find((r) => r.match?.(cues));
  if (byState) return { row: byState, hit: "state" };
  const base = rows.find((r) => !r.match);
  return base ? { row: base, hit: "type" } : null;
}

type M = Record<string, unknown>;
const obj = (v: unknown): M | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as M) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const SOURCE_NOW = new Set(["material_value", "company_fact"]);

/** 判断の後の meta から状態の手がかり（返信か AIX かの欄は読まない）。check_order.cues（check-order-wire）も使う */
export function priorityCuesFromMeta(meta: M | null | undefined): PriorityCues {
  const m = meta ?? {};
  const co = new Set(arr(obj(m.check_order)?.cues).filter((x): x is string => typeof x === "string"));
  const asks = arr(obj(m.turn_contract)?.asks).map(obj).filter((a): a is M => !!a);
  const qAsks = asks.filter((a) => a.kind === "question");
  const qs = arr(m.customer_questions).filter((x) => typeof x === "string" && x.trim());
  const uptake = arr(m.our_send_uptake).map(obj);
  const split = asks.some((a) => { const ps = arr(a.parts).map(obj); return ps.some((p) => SOURCE_NOW.has(String(p?.source))) && ps.some((p) => p?.source === "staff_only"); });
  return {
    multiAsks: qAsks.length >= 2 || qs.length >= 2,
    splitParts: split,
    askedAgain: uptake.some((u) => u?.kind === "asked_again" || u?.kind === "misread"),
    notHooked: uptake.some((u) => u?.hook === "not_hooked"),
    hooked: co.has("hooked"), takenWorry: co.has("takenWorry"), firstContact: co.has("firstContact"), hasQuestion: co.has("hasQuestion"),
    resultReady: co.has("resultReady"), broughtUnchecked: co.has("customerSentProperty") && !co.has("resultReady"),
    ackOnly: co.has("ackOnly"), pendingPromise: co.has("pendingPromise"),
  };
}

/** 表の組の最初の1通（reply｜aix） */
const firstSlotOf = (c: SendCombo): "reply" | "aix" => (c.startsWith("aix") ? "aix" : "reply");
/** ブレインの最初の1通: send_sequence の先頭 → 道（reply_mode=aix かつ action）→ reply */
function brainFirstSlot(m: M): "reply" | "aix" {
  const seq = arr(m.send_sequence).map(obj);
  const s0 = seq[0]?.slot;
  if (s0 === "reply" || s0 === "aix") return s0;
  return String(m.reply_mode ?? "") === "aix" && String(m.action ?? "").trim() ? "aix" : "reply";
}

export type PriorityRecord = {
  type: string; state: string; hit: "state" | "type";
  /** 行の id（PriorityRow.id・meta.check_order.priority.row_id） */
  row_id: string;
  first: Priority; why_tag: PriorityWhy;
  this_turn: NowThisTurn; answer_source: AnswerSource;
  combo: SendCombo; deferred: number; depth: BasisDepth;
  /** やらない事の数（触れない話題＋繰り返さない条件） */
  avoid: number;
  /** 文の設計図の主の行の why_order（compose-plan-rows-v2 の名前） */
  why_order: V2WhyOrder;
  /** ブレインの出力と表のずれの印（記録だけ・道は変えない）。aix_before_asks＝表は返信が先なのにブレインは AIX が先 */
  conflicts: string[];
};

/** meta（判断の後・check_order の後）→ 統括の記録の1行。型が無い・表に無い型なら null */
export function priorityTableRecord(meta: M | null | undefined): PriorityRecord | null {
  const m = meta ?? {};
  const type = typeof m.check_order_type === "string" ? m.check_order_type : (typeof obj(m.check_order)?.type === "string" ? String(obj(m.check_order)!.type) : null);
  const pick = priorityRowFor(type, priorityCuesFromMeta(m));
  if (!pick) return null;
  const r = pick.row;
  const conflicts: string[] = [];
  const want = firstSlotOf(r.combo), got = brainFirstSlot(m);
  if (want === "reply" && got === "aix") conflicts.push("aix_before_asks");
  if (want === "aix" && got === "reply") conflicts.push("reply_before_result");
  // ブレインの優先順位の段（brain-priority・既定 on）の1番が AIX なのに、表の先頭は返信の依頼＝AIX を依頼より先に出した印
  const p1 = arr(m.priorities).map(obj).filter((x): x is M => !!x).sort((a, b) => Number(a.rank ?? 99) - Number(b.rank ?? 99))[0];
  if (p1?.handling === "aix" && want === "reply" && !conflicts.includes("aix_before_asks")) conflicts.push("priority1_aix");
  const nl = obj(m.now_vs_later);
  if (typeof nl?.this_turn === "string" && nl.this_turn !== r.now_vs_later.this_turn) conflicts.push(`this_turn:${nl.this_turn}>${r.now_vs_later.this_turn}`);
  if (typeof nl?.answer_source === "string" && nl.answer_source !== r.now_vs_later.answer_source) conflicts.push(`answer_source:${nl.answer_source}>${r.now_vs_later.answer_source}`);
  return {
    type: r.type, state: r.state, hit: pick.hit, row_id: r.id, first: r.first.need, why_tag: r.first.why_tag,
    this_turn: r.now_vs_later.this_turn, answer_source: r.now_vs_later.answer_source,
    combo: r.combo, deferred: r.order.deferred.length, depth: r.checks.depth,
    avoid: r.avoid.no_touch.length + (r.avoid.repeat_scope ? 1 : 0),
    why_order: PRIORITY_WHY_TO_V2[r.first.why_tag], conflicts,
  };
}

/** 統括の記録の短い印: "first=answer|why=decider_first|combo=reply_then_aix_quick|defer=1|depth=deep" */
export function priorityDigest(r: PriorityRow | PriorityRecord | null | undefined): string | null {
  if (!r) return null;
  if ("first" in r && typeof r.first === "string") {
    const x = r as PriorityRecord;
    return `first=${x.first}|why=${x.why_tag}|combo=${x.combo}|defer=${x.deferred}|depth=${x.depth}${x.conflicts.length ? `|x=${x.conflicts.join(",")}` : ""}`;
  }
  const row = r as PriorityRow;
  return `first=${row.first.need}|why=${row.first.why_tag}|combo=${row.combo}|defer=${row.order.deferred.length}|depth=${row.checks.depth}`;
}

/** 文の設計図（作業員10）へ渡す1行（道が決まった後の設計図の材料・道の言葉は入れない） */
export function whyOrderLine(r: PriorityRow | null | undefined): string | null {
  if (!r) return null;
  return `先に: ${r.first.what}（${PRIORITY_WHY_JA[r.first.why_tag]}）／主: ${r.order.main}／従: ${r.order.subs.join("・") || "無し"}${r.order.deferred.length ? `／後に回す: ${r.order.deferred.map((d) => `${d.what}（${d.why}）`).join("・")}` : ""}${r.avoid.no_touch.length ? `／触れない: ${r.avoid.no_touch.join("・")}` : ""}${r.avoid.repeat_scope ? `／繰り返さない: ${r.avoid.repeat_scope}` : ""}`;
}
