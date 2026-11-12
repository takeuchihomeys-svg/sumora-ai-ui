// app/lib/judge-basis-types.ts — 判断の根拠のメモ・重点の物差しの型の名前を1か所にまとめる（純関数・定数だけ）
//
// 2026-11-12 作業員17（竹内さん「統括のブレインを測れるように」・KB 1a78e4e3・7d6fe3eb・ef6626d7・親 575a7cd5）。
//   別の作業員16 が竹内さんの番から「順番・優先度・重点・深さ」の型の表を作っている。名前を合わせる時はこのファイルだけ直す
//   （ブレインへの指示文・読み取り・物差し・試験の正解の欄は全部ここから読む）。
//   重点（FOCUS_KINDS）と順番の役（FOCUS_ORDER の role）は conductor-focus.ts の物をそのまま使う（二重に持たない）。
import { FOCUS_KINDS, FOCUS_LABEL, FOCUS_ORDER, type Focus } from "./conductor-focus";
import { INFO_KEYS, INFO_LABEL, type InfoKey } from "./info-fill-map";
import type { Need } from "./check-order";

export { FOCUS_KINDS, FOCUS_LABEL, type Focus };

/** 読む深さ */
export const DEPTH_KINDS = ["shallow", "normal", "deep"] as const;
export type BasisDepth = typeof DEPTH_KINDS[number];
export const DEPTH_LABEL: Record<BasisDepth, string> = { shallow: "浅い", normal: "普通", deep: "深い" };

/** 優先した要件（並べる時の名前）。竹内さんの番の「一番大切にした事」の言い方に合わせる（答える・抑える・不安を消す・次の一手…） */
export const PRIORITY_KINDS = ["answer_question", "keep_promise", "ease_worry", "next_step", "hold_property", "avoid_risk", "keep_relation"] as const;
export type Priority = typeof PRIORITY_KINDS[number];
export const PRIORITY_LABEL: Record<Priority, string> = {
  answer_question: "聞かれた事に答える", keep_promise: "約束を果たす", ease_worry: "不安を消す", next_step: "次の一手（内覧・申込・物件）に進める",
  hold_property: "物件を抑える", avoid_risk: "間違い・リスクを避ける", keep_relation: "関係をつなぐ",
};
/** 重点（Focus）→ 一番に置く優先の既定（正解側の推定・竹内さんの番の重点から優先の最初を推す時の線） */
export const FOCUS_TOP_PRIORITY: Record<Focus, Priority> = {
  answer: "answer_question", promise_make: "keep_promise", promise_keep: "keep_promise", ease: "ease_worry", close: "next_step", propose: "next_step", relation: "keep_relation",
};

/** 順番の役（FOCUS_ORDER にある role の一覧・順は初めて出た順） */
export const ORDER_ROLES: readonly string[] = (() => {
  const seen: string[] = [];
  for (const steps of Object.values(FOCUS_ORDER)) for (const s of steps) if (!seen.includes(s.role)) seen.push(s.role);
  return seen;
})();

// ── 2026-11-12 作業員22（作業員17 から持ち主を引き継ぎ・竹内さん 11/12「なぜやっているか・何の情報が足りていないから行っているか・どこの要点を押さえにいっているか」）
/** 目的（なぜこの番でこれをするか）。名前は作業員16 の check-order.ts の Need（型の priority の欄）と同じ。表の側で増減したら下の型の検査が tsc で落ちる */
export const PURPOSE_KINDS = ["keep_result", "answer", "confirm_promise", "send_promise", "worry", "next_move", "relation"] as const;
export type Purpose = typeof PURPOSE_KINDS[number];
type Exact<A extends string, B extends string> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const _PURPOSE_IS_NEED: Exact<Purpose, Need> = true;
export const PURPOSE_LABEL: Record<Purpose, string> = {
  keep_result: "前の約束の結果を果たす", answer: "聞かれた事に答える", confirm_promise: "確かめる約束をする", send_promise: "送る約束をする",
  worry: "不安を消す", next_move: "次の段に進める", relation: "関係をつなぐ",
};
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
  /** 読む深さ */
  depth?: BasisDepth;
  /** 順番（役の並び）。無ければ FOCUS_ORDER[focus] の役から出す */
  order?: string[];
  /** 作業員16 の型の表（check-order.ts）の型の id（T1_conditions_first 等）。名前を合わせた後、優先・順番・深さをここから出す */
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
