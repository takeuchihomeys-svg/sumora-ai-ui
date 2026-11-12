// app/lib/conductor-allocation.ts — 統括の「番ごとの部品の配分表」（純関数・DB/LLM なし・作業員22・2026-11-12）
//
// 竹内さんの決定 11/12（KB P1 fd1c7c62・親 P0 575a7cd5・ea2a9405①予算と止め時・0dbfbc97 順番の表）
//   「ブレインの統括はちゃんと順番等も理解して配分できるように細かく強化していく」。
//   台帳 meeting-gap:conductor-budget-stop（番ごとの費用の上限と止め時が無い）・conductor-roster-todos-unwired（呼ぶ部品の一覧が本番につながっていない）。
//
// ここにある物:
//   ① STEP_TO_PART … 「判断の順番」（check-order.ts の CheckStep）と「部品を動かす順」（conductor-focus.ts の FOCUS_ORDER の役）は別物。名前を分けたまま、対応表で結ぶ
//   ② ALLOCATION … 場面の型 T1〜T11 × 読む深さ（shallow／normal／deep）ごとに、動かす部品と順番・動かさない部品と理由・費用の目安・止め時
//   ③ pickAllocation … 型と深さから配分を1つ選ぶ（深さが無ければ CHECK_DEPTH の既定の深さ）
//   ④ allocationDigest … 選んだ配分の名前の1行（digest.al）。部品の名前と並べ方は orderDigest・judge_basis の order と同じ（"judge>fetch>…"）
//   ⑤ stopCheck … 止め時（材料がそろった／費用の上限）を見て、残りの部品のうち任意の物を呼ぶかを返す
// 置き方の決まり: 配分は「決定の材料を集める側」だけ。返信か AIX か（meta.action）は読まないし変えない。
// スイッチ: CONDUCTOR_ALLOCATION（既定 off＝どこからも呼ばない＝今と同じ／shadow＝meta.conductor_allocation と digest.al に記録だけ／
//   on＝同じ記録に加えて下の部品が読む口（今は読む部品が無い・部品を実際に止めるのは試験で悪化0を確かめてから）。
// テスト: scripts/test-conductor-allocation.ts。物差し: scripts/allocation-score.ts（試験の答案の jsonl と llm_usage の route 別の数）。
import { CHECK_DEPTH, CHECK_ORDER_TYPES, type CheckOrderCues, type CheckStep, pickCheckOrder } from "./check-order";
import { FOCUS_ORDER } from "./conductor-focus";
import { rosterById } from "./conductor-roles";
import type { BasisDepth } from "./judge-basis-types";

type Env = Record<string, string | undefined>;
export type AllocationMode = "off" | "shadow" | "on";
export function allocationMode(env: Env = typeof process !== "undefined" ? process.env : {}): AllocationMode {
  const v = String(env.CONDUCTOR_ALLOCATION ?? "").trim().toLowerCase();
  return v === "on" ? "on" : v === "shadow" ? "shadow" : "off";
}

/** 部品（FOCUS_ORDER にある役の名前だけ） */
export const PARTS = ["judge", "fetch", "deep", "viewing_calendar", "aix_desk", "property_search", "estimate", "combine", "compose", "writer", "second", "check_ground", "check_worry"] as const;
export type Part = typeof PARTS[number];
/** 部品の段（FOCUS_ORDER の stage と同じ）。並べ方は 段→PARTS の順（FOCUS_ORDER の各行の並びと食い違わない） */
export const PART_STAGE: Record<Part, "rough" | "detail" | "compose" | "verify"> = {
  judge: "rough", fetch: "detail", deep: "detail", viewing_calendar: "detail", aix_desk: "detail", property_search: "detail", estimate: "detail",
  combine: "compose", compose: "compose", writer: "compose", second: "compose", check_ground: "verify", check_worry: "verify",
};
const STAGE_RANK = { rough: 0, detail: 1, compose: 2, verify: 3 } as const;

/** 1回の費用の目安（USD）。名簿（conductor-roles.ts の ROSTER）にある部品は名簿の値を使う（二重に持たない）。
 *  名簿に無い物: judge＝判断のブレイン本体（Sonnet・キャッシュ込みの目安）・fetch＝道具（DB だけ）・combine＝決まった計算・second＝2通目の書き手（writer と同じ）。
 *  目安は scripts/allocation-score.ts で実測に置き換える（--usage の route 別の数） */
const NOT_IN_ROSTER: Partial<Record<Part, number>> = { judge: 0.04, fetch: 0, combine: 0 };
export function partCostUsd(p: Part): number {
  if (p in NOT_IN_ROSTER) return NOT_IN_ROSTER[p]!;
  const r = rosterById(p === "second" ? "writer" : p === "fetch" ? "fetch_sent_ledger" : p);
  return r?.cost.usd ?? 0;
}

// ── ① 判断の順番（CheckStep）→ 部品（Part）の対応表 ─────────────────────
/** 判断の1歩を、どの部品が受け持つか（先頭が主・後ろは材料を足す部品）。判断の順番の名前は check-order.ts、部品の名前は FOCUS_ORDER のまま */
export const STEP_TO_PART: Readonly<Record<CheckStep, readonly Part[]>> = {
  read_ask: ["judge"],
  hypothesize: ["judge", "deep"],          // 読みの候補を立てる（深い番だけ deep が全履歴で候補を足す）
  our_last_send: ["fetch", "judge"],       // こちらが送った物（fetch_sent_ledger）で読みを確定
  staff_only: ["judge", "aix_desk"],       // スタッフしか知らない事か（迷う時だけ aix_desk に相談）
  fact_answer: ["fetch", "check_ground"],  // 資料・会社の事実を取りに行き、書いた後に根拠を確かめる
  now_vs_later: ["judge", "combine"],      // 今の番の出力と後の AIX を分ける（何通・どの順は combine）
  route: ["judge"],                         // 返信か AIX か（配分は読まない・決め直さない）
  focus: ["judge", "combine"],
  aim: ["judge"],
  roles: ["compose", "writer"],
};

// ── ② 配分表 ───────────────────────────────────────────────
export type StopRule = {
  /** これがそろったら fetch を呼び足さない（材料がそろった） */
  materials: string[];
  /** この番で使ってよい費用の上限（USD）。超えそうなら任意の部品（optional）を呼ばずに今ある答えでまとめる */
  maxUsd: number;
  why: string;
};
export type Allocation = {
  /** 配分の名前（digest に残す）: "<型の id>/<s|n|d>" */
  name: string;
  typeId: string;
  depth: BasisDepth;
  /** 動かす部品（動かす順） */
  parts: Part[];
  /** 止め時に外してよい部品（parts の部分集合） */
  optional: Part[];
  /** 動かさない部品とその理由 */
  skip: Array<{ part: Part; why: string }>;
  /** なぜこの配分か */
  why: string;
  /** 費用の目安（parts の partCostUsd の合計） */
  estUsd: number;
  stop: StopRule;
};

type Row = { parts: Part[]; optional?: Part[]; why: string; materials: string[] };
type TypeAlloc = { rows: Record<BasisDepth, Row>; skip: Partial<Record<Part, string>> };

const SKIP_DEEP = "深く読む（Sonnet の考える時間・1回 約$0.12）は深い番だけ";
const SKIP_WORRY = "奥の心配（3段の worry）を言っていない番は確かめない";
// 型ごとの配分（深さの3段）。skip は「その型のどの深さでも動かさない部品の理由」。深さで外れる部品の理由は skipFor が足す
const TABLE: Record<string, TypeAlloc> = {
  T1_conditions_first: {
    rows: {
      shallow: { parts: ["judge", "combine", "compose", "writer"], why: "初回の条件の受け取り。約束にまとめるだけで前の送信を遡らない", materials: [] },
      normal: { parts: ["judge", "fetch", "combine", "compose", "writer"], why: "前の条件・送った物件との差（変更か追加か）を送った物の記録で見る", materials: ["sent_ledger"] },
      deep: { parts: ["judge", "fetch", "deep", "combine", "compose", "writer"], optional: ["deep"], why: "2回目以降の言い直し・送った物件を外す言い方は全履歴で差を読む", materials: ["sent_ledger", "customer_memo"] },
    },
    skip: { aix_desk: "物件の AIX は物件が揃った後の番（今押すと送る物が無い・10/02 2段）", property_search: "今の番はピックアップの約束。物件を選ぶのは後の番", estimate: "物件が無い", viewing_calendar: "内覧の段階でない", second: "1通（約束の返信）", check_ground: "物件・費用の事実を書かない（約束だけ）", check_worry: SKIP_WORRY },
  },
  T2_question_fact: {
    rows: {
      shallow: { parts: ["judge", "fetch", "writer", "check_ground"], why: "答えだけで足りる問い（分割・保証会社）。設計図を呼ばず結論で答える", materials: ["company_fact"] },
      normal: { parts: ["judge", "fetch", "combine", "compose", "writer", "check_ground"], why: "資料・会社の事実を取りに行き、答え→次の一手の構成で書く", materials: ["sheet_detail", "company_fact"] },
      deep: { parts: ["judge", "fetch", "deep", "combine", "compose", "writer", "check_ground"], optional: ["deep"], why: "物件ごとに答えが違う・答えが申込の判断に直結する番は全履歴で物件を確かめる", materials: ["sheet_detail", "company_fact", "sent_ledger"] },
    },
    skip: { aix_desk: "答えられる問い（スタッフしか知らない事でない）", property_search: "物件を出す番でない", estimate: "費用の問いは T8", viewing_calendar: "内覧の問いは T7", second: "1通（答えの返信）", check_worry: SKIP_WORRY },
  },
  T3_question_staff_only: {
    rows: {
      shallow: { parts: ["judge", "fetch", "writer"], why: "資料に無いと確かめて、確認の約束を短く返す", materials: ["sheet_detail"] },
      normal: { parts: ["judge", "fetch", "combine", "compose", "writer"], why: "資料に無い事を確かめてから、聞かれた事そのものを確認すると約束する（q065 答えられる事を保留しない）", materials: ["sheet_detail", "company_fact"] },
      deep: { parts: ["judge", "fetch", "aix_desk", "combine", "compose", "writer"], optional: ["aix_desk"], why: "スタッフしか知らない気配が強い時だけ AIX の統括に相談する（決めるのは判断のブレイン）", materials: ["sheet_detail", "company_fact", "sent_ledger"] },
    },
    skip: { deep: "確認の結果はスタッフしか知らない。深く読んでも答えは出ない", property_search: "物件を出す番でない", estimate: "見積の番でない", viewing_calendar: "内覧の段階でない", second: "1通（確認の約束）", check_ground: "事実を書かない（確認の約束だけ）", check_worry: SKIP_WORRY },
  },
  T4_property_shared: {
    rows: {
      shallow: { parts: ["judge", "fetch", "compose", "writer"], why: "空きを確かめる約束だけの番（初回でない・前に送った物件）", materials: ["sent_ledger"] },
      normal: { parts: ["judge", "fetch", "combine", "compose", "writer"], why: "前にその物件を送ったか・条件の参考かを送った物の記録で見て、募集確認の約束（見積はその後と約束）", materials: ["sent_ledger", "property_record"] },
      deep: { parts: ["judge", "fetch", "deep", "combine", "compose", "writer"], optional: ["deep"], why: "何のために送ったかは言葉に無い。条件・前の送信・初回かを全履歴で読み、読みの候補から1つに決める（本番 11264）", materials: ["sent_ledger", "property_record", "customer_memo"] },
    },
    skip: { estimate: "見積は空きを確かめた後（埋まっている物件の見積は信頼を落とす・約束を1通に詰めない）", aix_desk: "確認の結果はまだ無い（後の番で AIX【物件確認した】）", property_search: "お客様の物件の確認が先", viewing_calendar: "内覧の段階でない", second: "1通（募集確認の約束）", check_ground: "物件の事実を書かない（確認の約束だけ）", check_worry: SKIP_WORRY },
  },
  T5_ack_hypothesis: {
    rows: {
      shallow: { parts: ["judge", "writer"], why: "お礼だけ。受け→締めで中身を足さない（お礼の番で設計図を呼ばない 8bfcdf60①）", materials: [] },
      normal: { parts: ["judge", "fetch", "compose", "writer"], why: "何への了承かは直前のこちらの送信で決まる。送った物の記録を見て次の扉を選ぶ", materials: ["sent_ledger"] },
      deep: { parts: ["judge", "fetch", "deep", "combine", "compose", "writer"], optional: ["deep"], why: "約束が複数開いている・見積の後の了承（1部屋のみは抑える）・食い違う反応は全履歴で候補を確かめる", materials: ["sent_ledger", "estimate"] },
    },
    skip: { aix_desk: "お礼の番は果たしの番ではない（10/14・約束を果たす AIX はその後）", property_search: "物件を出す番でない", estimate: "見積の番でない", viewing_calendar: "内覧の日時を決める番でない", second: "1通（受けの返信）", check_ground: "事実を書かない", check_worry: SKIP_WORRY },
  },
  T6_considering: {
    rows: {
      shallow: { parts: ["judge", "writer"], why: "急がず扉だけ。深く読むと押す材料を拾って道を引っぱる（浅 17/22）", materials: [] },
      normal: { parts: ["judge", "fetch", "writer"], why: "見積の後・新着で待つ等、前の送信で扉の向きを決める", materials: ["sent_ledger"] },
      deep: { parts: ["judge", "fetch", "deep", "compose", "writer", "check_worry"], optional: ["deep", "check_worry"], why: "今日中に決める合図・埋まる不安を口にした番だけ、不安と押す線を読む", materials: ["sent_ledger"] },
    },
    skip: { aix_desk: "検討の番に AIX を押さない", property_search: "物件を出す番でない", estimate: "見積の番でない", viewing_calendar: "日時を決める番でない", combine: "1通・受けと扉だけ", second: "1通（扉だけの返信）", check_ground: "事実を書かない" },
  },
  T7_viewing: {
    rows: {
      shallow: { parts: ["judge", "fetch", "writer"], why: "可否・最終時刻への即答が中心（浅 11/22）", materials: ["company_fact"] },
      normal: { parts: ["judge", "fetch", "viewing_calendar", "combine", "compose", "writer"], why: "段階（候補日→決定→待ち合わせ）のどこかを見て、空いている枠を取ってから日程へ", materials: ["company_fact", "viewing_slots"] },
      deep: { parts: ["judge", "fetch", "deep", "viewing_calendar", "aix_desk", "combine", "compose", "writer", "check_ground"], optional: ["deep", "aix_desk"], why: "内見できない物件（申込で先に抑える線）・他社で内覧予定の番だけ深く", materials: ["company_fact", "viewing_slots", "sheet_detail"] },
    },
    skip: { property_search: "物件を出す番でない", estimate: "見積の番でない", second: "日にちの確定はスタッフの番（AIX【内覧調整】は判断のブレインが決める）", check_worry: SKIP_WORRY },
  },
  T8_cost: {
    rows: {
      shallow: { parts: ["judge", "fetch", "writer", "check_ground"], why: "総額・分割の問いに会社の事実で答える（金額を材料の外で言わないかは浅くても確かめる）", materials: ["company_fact"] },
      normal: { parts: ["judge", "fetch", "estimate", "combine", "compose", "writer", "check_ground"], why: "物件がある時は見積の材料（費用の中身・割引）を取ってから答える（SCENE_ORDER cost の順）", materials: ["company_fact", "estimate"] },
      deep: { parts: ["judge", "fetch", "deep", "estimate", "combine", "compose", "writer", "check_ground", "check_worry"], optional: ["deep", "check_worry"], why: "安さを不審に思う・総額が見えず決められない不安（15/22）を先回りする番", materials: ["company_fact", "estimate", "sheet_detail"] },
    },
    skip: { aix_desk: "見積書の AIX は判断のブレインが決める（物件がある時だけ）", property_search: "総額が高い時の別の物件は約束（後の番）", viewing_calendar: "内覧の段階でない", second: "1通（答えの返信）" },
  },
  T9_apply_signal: {
    rows: {
      shallow: { parts: ["judge", "fetch", "writer", "check_ground"], why: "合図に即答。対象物件と空きの事実だけ確かめる", materials: ["sent_ledger"] },
      normal: { parts: ["judge", "fetch", "aix_desk", "combine", "compose", "writer", "check_ground"], why: "対象物件を特定して申込の書類（AIX）へ。物件と空きを事実で確かめる（事実 12/22）", materials: ["sent_ledger", "sheet_detail"] },
      deep: { parts: ["judge", "fetch", "deep", "aix_desk", "combine", "compose", "writer", "check_ground", "check_worry"], optional: ["deep", "check_worry"], why: "名指しが曖昧・審査の不安・申込の門（書類の手前で止める）の番", materials: ["sent_ledger", "sheet_detail", "company_fact"] },
    },
    skip: { property_search: "決めた物件がある", estimate: "見積は前の番", viewing_calendar: "申込の番", second: "1通（承認）" },
  },
  T10_result_ready: {
    rows: {
      shallow: { parts: ["judge", "fetch", "aix_desk", "second"], why: "約束が1つで結果が揃っている。結果の AIX を果たすだけ", materials: ["sent_ledger", "now_fulfillable"] },
      normal: { parts: ["judge", "fetch", "aix_desk", "property_search", "combine", "second"], why: "どの約束の結果かを遡って先に果たし、空いていなければ代わりの物件（FOCUS_ORDER promise_keep の順）", materials: ["sent_ledger", "now_fulfillable", "property_record"] },
      deep: { parts: ["judge", "fetch", "deep", "aix_desk", "property_search", "estimate", "combine", "compose", "writer", "second"], optional: ["deep", "estimate"], why: "約束が複数・新しい問いも来た番。結果を先に・問いへの答えは後の通", materials: ["sent_ledger", "now_fulfillable", "property_record", "estimate"] },
    },
    skip: { viewing_calendar: "結果の報告が先（内覧は空いていた後）", check_ground: "結果はスタッフが確かめた事（AIX の中）", check_worry: SKIP_WORRY },
  },
  T11_first_contact_hearing: {
    rows: {
      shallow: { parts: ["judge", "aix_desk", "combine", "writer", "second"], why: "初回の挨拶だけ。受けの返信→フォームの AIX の2通", materials: [] },
      normal: { parts: ["judge", "fetch", "aix_desk", "combine", "compose", "writer", "second"], why: "言われた事情に会社の事実で答えてからフォーム（2通・この順）", materials: ["company_fact"] },
      deep: { parts: ["judge", "fetch", "deep", "aix_desk", "combine", "compose", "writer", "second", "check_worry"], optional: ["deep", "check_worry"], why: "2人・審査の不安・再来の事情を言った番は不安に答えてからフォーム", materials: ["company_fact", "customer_memo"] },
    },
    skip: { property_search: "条件がまだ揃っていない", estimate: "物件が無い", viewing_calendar: "内覧の段階でない", check_ground: "物件・費用の事実を書かない" },
  },
};

const sortParts = (ps: ReadonlyArray<Part>): Part[] =>
  [...new Set(ps)].sort((a, b) => STAGE_RANK[PART_STAGE[a]] - STAGE_RANK[PART_STAGE[b]] || PARTS.indexOf(a) - PARTS.indexOf(b));
const DEPTH_SHORT: Record<BasisDepth, string> = { shallow: "s", normal: "n", deep: "d" };
const r3 = (x: number) => Math.round(x * 1000) / 1000;

function build(typeId: string, depth: BasisDepth): Allocation {
  const t = TABLE[typeId];
  const row = t.rows[depth];
  const parts = sortParts(row.parts);
  const skip: Allocation["skip"] = [];
  for (const p of PARTS) {
    if (parts.includes(p)) continue;
    const why = t.skip[p] ?? (p === "deep" ? SKIP_DEEP : p === "check_worry" ? SKIP_WORRY : depth !== "deep" && Object.values(t.rows).some((r) => r.parts.includes(p)) ? `${depth === "shallow" ? "浅い" : "普通の"}番では呼ばない（深い番だけ）` : "この型では呼ばない");
    skip.push({ part: p, why });
  }
  const estUsd = r3(parts.reduce((s, p) => s + partCostUsd(p), 0));
  // 費用の上限＝目安の 1.25倍（任意の部品を呼び足さない線）。浅い番は低く・深い番だけ deep の分まで
  const maxUsd = r3(Math.max(estUsd * 1.25, 0.05));
  return {
    name: `${typeId}/${DEPTH_SHORT[depth]}`, typeId, depth, parts, optional: (row.optional ?? []).filter((p) => parts.includes(p)), skip, why: row.why, estUsd,
    stop: { materials: row.materials, maxUsd, why: row.materials.length ? `材料（${row.materials.join("・")}）がそろったら取りに行き足さない・上限 $${maxUsd} を超えそうなら任意の部品を呼ばずにまとめる` : `取りに行く材料は無い・上限 $${maxUsd}` },
  };
}

/** 型 × 深さ の全部の配分（決まった表・読み込み時に1回作る） */
export const ALLOCATION: Readonly<Record<string, Readonly<Record<BasisDepth, Allocation>>>> = Object.fromEntries(
  CHECK_ORDER_TYPES.map((t) => [t.id, { shallow: build(t.id, "shallow"), normal: build(t.id, "normal"), deep: build(t.id, "deep") }]),
);

// ── ③ 選び方 ─────────────────────────────────────────────
/** 型と深さから配分を1つ選ぶ。深さが無ければ型の既定の深さ（CHECK_DEPTH.base）。型が表に無ければ null（今まで通り FOCUS_ORDER の順） */
export function pickAllocation(typeId: string | null | undefined, depth?: BasisDepth | null): Allocation | null {
  if (!typeId || !ALLOCATION[typeId]) return null;
  const d: BasisDepth = depth ?? CHECK_DEPTH[typeId]?.base ?? "normal";
  return ALLOCATION[typeId][d];
}
/** 状況の手がかり（check-order の CheckOrderCues）から、pickCheckOrder の先頭の型で選ぶ */
export function pickAllocationFromCues(c: CheckOrderCues, depth?: BasisDepth | null): { alloc: Allocation; why: string } | null {
  const top = pickCheckOrder(c)[0];
  const a = top ? pickAllocation(top.id, depth) : null;
  return a && top ? { alloc: a, why: top.why } : null;
}

/** 場面（reply-scene の ReplyScene）→ 型の既定（型の id が meta に無い時の線・ack と considering 等は場面と型が1つずつ） */
export const SCENE_TO_TYPE: Readonly<Record<string, string>> = {
  conditions: "T1_conditions_first", question: "T2_question_fact", property_share: "T4_property_shared", ack: "T5_ack_hypothesis",
  considering: "T6_considering", viewing: "T7_viewing", cost: "T8_cost", apply: "T9_apply_signal",
};
/** 深さの名前の揃え（brain-depth の light → shallow） */
export function normDepth(v: unknown): BasisDepth | null {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "shallow" || s === "light" ? "shallow" : s === "normal" ? "normal" : s === "deep" ? "deep" : null;
}

// ── ④ 記録の1行 ───────────────────────────────────────────
/** digest.al の1行。"<配分の名前>:<部品の順>"（部品の順は orderDigest・judge_basis の order と同じ並べ方） 例 "T4_property_shared/d:judge>fetch>deep>combine>compose>writer" */
export const allocationDigest = (a: Allocation | null | undefined): string | null => (a ? `${a.name}:${a.parts.join(">")}` : null);
/** digest の長さの都合で短くした名前（型の番号だけ） 例 "T4/d:judge>fetch>deep>combine>compose>writer" */
export const allocationDigestShort = (a: Allocation | null | undefined): string | null => (a ? `${a.typeId.split("_")[0]}/${DEPTH_SHORT[a.depth]}:${a.parts.join(">")}` : null);

export type AllocationMeta = { name: string; parts: Part[]; est_usd: number; max_usd: number; from: "type" | "scene"; depth_from: "judge_basis" | "brain_depth" | "default" };
/** 判断の後の meta から配分を選んで記録の形にする（meta は変えない・action は読まない）。
 *  型: meta.check_order_type（型の表を配線した後）→ 無ければ場面（meta.scene_evidence.scene または引数の scene）の既定の型。
 *  深さ: judge_basis.depth → brain_depth.depth → 型の既定。 */
export function allocationFromMeta(meta: Record<string, unknown> | null | undefined, o: { scene?: string | null } = {}): AllocationMeta | null {
  if (!meta) return null;
  const typeRaw = typeof meta.check_order_type === "string" ? meta.check_order_type : null;
  const sceneRaw = o.scene ?? (meta.scene_evidence as { scene?: unknown } | null | undefined)?.scene;
  const typeId = typeRaw && ALLOCATION[typeRaw] ? typeRaw : typeof sceneRaw === "string" ? SCENE_TO_TYPE[sceneRaw] ?? null : null;
  if (!typeId) return null;
  const jb = normDepth((meta.judge_basis as { depth?: unknown } | null | undefined)?.depth);
  const bd = normDepth((meta.brain_depth as { depth?: unknown } | null | undefined)?.depth);
  const a = pickAllocation(typeId, jb ?? bd ?? null);
  if (!a) return null;
  return { name: a.name, parts: a.parts, est_usd: a.estUsd, max_usd: a.stop.maxUsd, from: typeRaw && ALLOCATION[typeRaw] ? "type" : "scene", depth_from: jb ? "judge_basis" : bd ? "brain_depth" : "default" };
}

/** meta.conductor_allocation（AllocationMeta）→ digest.al（"T4/d:judge>fetch>…"・90字まで）。形が違う物は null */
export function allocationMetaDigest(v: unknown): string | null {
  const a = v as { name?: unknown; parts?: unknown } | null | undefined;
  if (!a || typeof a.name !== "string" || !a.name.includes("/") || !Array.isArray(a.parts)) return null;
  const [typeId, d] = a.name.split("/");
  return `${typeId.split("_")[0]}/${d}:${(a.parts as unknown[]).map(String).join(">")}`.slice(0, 90);
}

// ── ⑤ 止め時 ─────────────────────────────────────────────
/** 次の部品を呼ぶか。fetch は材料がそろっていれば呼ばない・任意の部品は費用の上限を超えそうなら呼ばない・必須の部品は止めない（今ある答えでまとめる） */
export function stopCheck(a: Allocation, part: Part, state: { spentUsd: number; have: ReadonlyArray<string> }): { call: boolean; why: string } {
  if (!a.parts.includes(part)) return { call: false, why: `${a.name} の配分に無い` };
  if (part === "fetch" && a.stop.materials.length && a.stop.materials.every((m) => state.have.includes(m))) return { call: false, why: "材料がそろった" };
  if (a.optional.includes(part) && state.spentUsd + partCostUsd(part) > a.stop.maxUsd) return { call: false, why: `費用の上限 $${a.stop.maxUsd} を超える` };
  return { call: true, why: "配分どおり" };
}

/** FOCUS_ORDER にある役の一覧（テスト・物差しで「部品名が FOCUS_ORDER の中だけ」を確かめる） */
export const FOCUS_ORDER_ROLES: ReadonlySet<string> = new Set(Object.values(FOCUS_ORDER).flatMap((s) => s.map((x) => x.role)));
