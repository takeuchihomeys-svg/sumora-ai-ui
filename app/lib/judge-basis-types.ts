// app/lib/judge-basis-types.ts — 判断の根拠のメモ・重点の物差しの型の名前を1か所にまとめる（純関数・定数だけ）
//
// 2026-11-12 作業員17（竹内さん「統括のブレインを測れるように」・KB 1a78e4e3・7d6fe3eb・ef6626d7・親 575a7cd5）。
//   別の作業員16 が竹内さんの番から「順番・優先度・重点・深さ」の型の表を作っている。名前を合わせる時はこのファイルだけ直す
//   （ブレインへの指示文・読み取り・物差し・試験の正解の欄は全部ここから読む）。
//   重点は conductor-focus.ts の FOCUS_KINDS。優先・確認の順番・深さは作業員16 の check-order.ts（Need・CheckStep・CheckDepth）の名前（11/12 統括役の決め）。
//   2026-11-12 作業員22: 作業員17 の feat/basis-align-1112（名前の合わせ直し）を、作業員16 の今の形（深さは base＝shallow|normal|deep ＋ via＝back|fact・優先は Need・T12 入り）を正にして載せ直した（統括役の決め）。
//   順番の役（FOCUS_ORDER の部品の名前 judge・fetch…）は判断の順番ではなく「部品を動かす順」＝conductor-allocation.ts の STEP_TO_PART で結ぶ（ここでは持たない）。
import { FOCUS_KINDS, FOCUS_LABEL, type Focus } from "./conductor-focus";
import { INFO_KEYS, INFO_LABEL, type InfoKey } from "./info-fill-map";
import type { Need, CheckStep, CheckDepth } from "./check-order";

export { FOCUS_KINDS, FOCUS_LABEL, type Focus };

/** 表の型との食い違いを tsc で止める（作業員16 の表で増減したらここが赤くなる＝この1か所だけ直す） */
type Exact<A extends string, B extends string> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/** 読む深さ（16 の CheckDepth.base）と、普通の番の中身（CheckDepth.via: back＝前の約束・送った物に遡る／fact＝資料・会社の事実を見る） */
export const DEPTH_KINDS = ["shallow", "normal", "deep"] as const;
export type BasisDepth = typeof DEPTH_KINDS[number];
export const DEPTH_LABEL: Record<BasisDepth, string> = { shallow: "浅い", normal: "普通", deep: "深い（読みの候補を立てて確かめる）" };
export const DEPTH_VIA_KINDS = ["back", "fact"] as const;
export type BasisDepthVia = typeof DEPTH_VIA_KINDS[number];
export const DEPTH_VIA_LABEL: Record<BasisDepthVia, string> = { back: "遡る（前の約束・送った物）", fact: "事実を見る（資料・会社の事実）" };

/** 優先した要件（16 の Need）。先頭が一番大切 */
export const NEED_KINDS = ["keep_result", "answer", "confirm_promise", "send_promise", "worry", "next_move", "relation"] as const;
export const PRIORITY_KINDS = NEED_KINDS;
export type Priority = Need;
export const NEED_LABEL: Record<Need, string> = {
  keep_result: "前の約束の結果を果たす", answer: "聞かれた事に答える", confirm_promise: "確かめる約束をする", send_promise: "送る約束をする",
  worry: "不安を消す", next_move: "次の段に進める", relation: "関係をつなぐ",
};
export const PRIORITY_LABEL = NEED_LABEL;
/** 重点（Focus）→ 一番に置く優先の既定（重点だけの問題から優先の最初を推す線・表の型の priority 先頭と同じ向き） */
export const FOCUS_TOP_PRIORITY: Record<Focus, Priority> = {
  answer: "answer", promise_make: "confirm_promise", promise_keep: "keep_result", ease: "worry", close: "next_move", propose: "next_move", relation: "relation",
};

/** 確認の順番（16 の CheckStep）。ブレインに書かせる順番（judge_basis.order）と正解の順番はこの名前 */
export const CHECK_STEPS = ["read_ask", "hypothesize", "our_last_send", "staff_only", "fact_answer", "now_vs_later", "route", "focus", "aim", "roles"] as const;
export const ORDER_ROLES: readonly string[] = CHECK_STEPS;
export const STEP_LABEL: Record<CheckStep, string> = {
  read_ask: "何を言われたか", hypothesize: "読みの候補を立てる", our_last_send: "こちらの直前の送信で確定", staff_only: "スタッフしか知らない事か", fact_answer: "事実で答えられるか",
  now_vs_later: "今の番の出力と後で果たす物を分ける", route: "返信か AIX か", focus: "重点", aim: "目的・押すか待つか", roles: "文の役目の並び",
};

export const _TYPE_CHECKS: [Exact<typeof NEED_KINDS[number], Need>, Exact<typeof CHECK_STEPS[number], CheckStep>, Exact<BasisDepth, CheckDepth["base"]>, Exact<BasisDepthVia, NonNullable<CheckDepth["via"]>>] = [true, true, true, true];

// ── 2026-11-12 作業員22（作業員17 から持ち主を引き継ぎ・竹内さん 11/12「なぜやっているか・何の情報が足りていないから行っているか・どこの要点を押さえにいっているか」）
/** 目的（なぜこの番でこれをするか）。名前は作業員16 の check-order.ts の Need（型の priority の欄）と同じ。表の側で増減したら下の型の検査が tsc で落ちる */
export const PURPOSE_KINDS = NEED_KINDS;
export type Purpose = Need;
export const PURPOSE_LABEL = NEED_LABEL;
/** 足りない情報（何が分かっていないからこの番でそうしているか）。名前は作業員1 の info-fill-map.ts の INFO_KEYS（13項目）の1か所（11/12 統括役の決め）。
 *  ここでは写さずに読む（項目が増減したらブレインへの指示・読み取り・物差しが一緒に変わる）。取りに行く材料の道具（brain-need の NEED_TOOLS）とは別物 */
export const MISSING_KINDS = INFO_KEYS;
export type MissingKind = InfoKey;
export const MISSING_LABEL: Record<MissingKind, string> = INFO_LABEL;

/** 外れた段（左から先に起きた段を数える）。目的（purpose）と足りない情報（missing）は深さの後・優先の前（何のために・何が無いかが先に決まり、その後で優先を並べる） */
export const MISS_STAGES = ["read", "pick", "depth", "purpose", "missing", "priority", "focus", "order", "path"] as const;
export type BasisMissStage = typeof MISS_STAGES[number];
export const MISS_STAGE_LABEL: Record<BasisMissStage, string> = {
  read: "読み（候補に正解の読みが無い）", pick: "読みの選び（候補にあったが選ばなかった）", depth: "深さ", purpose: "目的", missing: "足りない情報", priority: "優先", focus: "重点", order: "順番", path: "道",
};

/** 試験の問題 spec に足す正解の欄（任意・全部省略できる） */
export type BasisGold = {
  /** 竹内さんがその番で一番大切にした事（重点） */
  focus?: Focus;
  /** 優先の並び（先頭が一番大切） */
  priority?: Priority[];
  /** 読む深さ（無ければ type の表の CHECK_DEPTH.base） */
  depth?: BasisDepth;
  /** 確認の順番（CheckStep の並び）。無ければ type の表の check から出す */
  order?: string[];
  /** 作業員16 の型の表（check-order.ts）の型の id（T1_conditions_first 等）。優先・確認の順番・深さを省略した時はここから出す（goldOf） */
  type?: string;
  /** 目的（PURPOSE_KINDS・check-order の Need と同じ名前）。無ければ type の表の priority の先頭 */
  purpose?: Purpose;
  /** 足りない情報（MISSING_KINDS）。[] は「足りない物は無い」 */
  missing?: MissingKind[];
  /** 押さえる要点（竹内さんがその番で押さえた所・30字） */
  keyPoint?: string;
  /** 付けた人・日付・根拠の番（人が確かめた物だけ入れる） */
  by?: string;
};
