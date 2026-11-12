// app/lib/judge-basis-types.ts — 判断の根拠のメモ・重点の物差しの型の名前を1か所にまとめる（純関数・定数だけ）
//
// 2026-11-12 作業員17（竹内さん「統括のブレインを測れるように」・KB 1a78e4e3・7d6fe3eb・ef6626d7・親 575a7cd5）。
//   別の作業員16 が竹内さんの番から「順番・優先度・重点・深さ」の型の表を作っている。名前を合わせる時はこのファイルだけ直す
//   （ブレインへの指示文・読み取り・物差し・試験の正解の欄は全部ここから読む）。
//   重点（FOCUS_KINDS）と順番の役（FOCUS_ORDER の role）は conductor-focus.ts の物をそのまま使う（二重に持たない）。
import { FOCUS_KINDS, FOCUS_LABEL, FOCUS_ORDER, type Focus } from "./conductor-focus";

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

/** 外れた段（左から先に起きた段を数える） */
export const MISS_STAGES = ["read", "pick", "depth", "priority", "focus", "order", "path"] as const;
export type BasisMissStage = typeof MISS_STAGES[number];
export const MISS_STAGE_LABEL: Record<BasisMissStage, string> = {
  read: "読み（候補に正解の読みが無い）", pick: "読みの選び（候補にあったが選ばなかった）", depth: "深さ", priority: "優先", focus: "重点", order: "順番", path: "道",
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
  /** 付けた人・日付・根拠の番（人が確かめた物だけ入れる） */
  by?: string;
};
