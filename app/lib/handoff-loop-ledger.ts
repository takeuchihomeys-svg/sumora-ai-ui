/**
 * 連続客ループの完了台帳（決定論）＋細分化強化
 *
 * 幹の流れ: 切替 → 前客外し → 条件入れ → 検索 → 送付 → 送付後外し → 次客可
 * 2026-11-23 DB実測: post_send_clear=0件の穴 → 2.8.203で stamp 修正。
 * 竹内さん「穴の部分で土台必要な部分はつくって細分化して強化する／とことん強化／統括pro」
 */

/** 幹7段（一連OKの判定） */
export type HandoffLoopAtoms = {
  leftover_clean?: boolean;
  customer_think?: boolean;
  place_fill?: boolean;
  search?: boolean;
  send_or_pdf?: boolean;
  post_send_clear?: boolean;
  ready_next?: boolean;
  human_takeover?: boolean;
};

/** 細分化原子（弱い所だけ次手にする） */
export type HandoffFineId =
  | "switch"
  | "place_clear"
  | "place_select"
  | "conditions"
  | "search"
  | "fill_done"
  | "send_or_pdf"
  | "post_send_clear"
  | "ready_next"
  | "next_clear"
  | "customer_think"
  | "designated"
  /** ★ 2.8.222: いま客・次客・いま段／次段の把握（ループ完了→次へ） */
  | "who_grasp"
  | "loop_advance";

export type HandoffFineAtoms = Record<HandoffFineId, boolean>;

export type HandoffLoopJudge = {
  ok: boolean;
  gaps: string[];
  summary: string;
  /** 次客へ進めてよいか（人が引き取った時は不可） */
  canAdvance: boolean;
};

export type HandoffStrengthenItem = {
  id: HandoffFineId;
  layer: "free" | "human" | "cost";
  why: string;
  next: string;
  foundation: "F44" | "F45" | "F47" | "F61" | "F62";
};

export type HandoffStrengthenPlan = {
  ok: boolean;
  trunk_gaps: string[];
  fine_gaps: HandoffFineId[];
  items: HandoffStrengthenItem[];
  line: string;
  next: string;
};

const ORDER: Array<keyof HandoffLoopAtoms> = [
  "leftover_clean",
  "customer_think",
  "place_fill",
  "search",
  "send_or_pdf",
  "post_send_clear",
  "ready_next",
];

const LABEL: Record<keyof HandoffLoopAtoms, string> = {
  leftover_clean: "前客外し",
  customer_think: "客ごと思考",
  place_fill: "条件入れ",
  search: "検索",
  send_or_pdf: "送付",
  post_send_clear: "送付後外し",
  ready_next: "次客可",
  human_takeover: "人引取",
};

/** 細分化の順番（無料で効く物が先） */
export const HANDOFF_FINE_ORDER: HandoffFineId[] = [
  "switch",
  "who_grasp",
  "place_clear",
  "place_select",
  "conditions",
  "customer_think",
  "search",
  "fill_done",
  "send_or_pdf",
  "post_send_clear",
  "ready_next",
  "loop_advance",
  "next_clear",
  "designated",
];

const FINE_LABEL: Record<HandoffFineId, string> = {
  switch: "客切替",
  place_clear: "前客場所外し",
  place_select: "新客場所入れ",
  conditions: "条件欄",
  search: "検索押下",
  fill_done: "入力完了",
  send_or_pdf: "送付",
  post_send_clear: "送付後外し",
  ready_next: "次客可",
  next_clear: "次客前外し",
  customer_think: "客ごと思考",
  designated: "指定客ロック",
  who_grasp: "いま客・次客把握",
  loop_advance: "ループ完了→次へ",
};

const FINE_RE: Record<HandoffFineId, RegExp> = {
  switch: /flow_done_switch|flow_atom_ok_switch|switch_grasp|handoff_atom_switch/,
  place_clear: /leftover_clean|leftover_done_F57|clear_method_|flow_atom_ok_place_clear|handoff_atom_place_clear|sameKindMustClear|leftover_force_same/,
  place_select: /flow_done_place|flow_atom_ok_place_select|now_customer.*place|handoff_atom_place_select/,
  conditions: /flow_done_conditions|flow_atom_ok_conditions|handoff_atom_conditions/,
  search: /flow_done_search|search_press|search_armed|now_customer search|flow_atom_ok_search|handoff_atom_search/,
  fill_done: /flow_done_fill_done|flow_atom_ok_fill_done|handoff_atom_fill_done/,
  send_or_pdf: /auto_pdf|batch_customer_done|dl:auto_pdf|flow_atom_ok_send|handoff_atom_send/,
  post_send_clear: /post_send_clear|flow_atom_ok_post_send|handoff_atom_post_send/,
  ready_next: /ready_next|series_done|flow_done_ready_next|flow_atom_ok_ready_next|handoff_atom_ready/,
  next_clear: /flow_atom_ok_next_clear|leftover_scan|handoff_atom_next_clear|loop_phase_grasp/,
  customer_think: /customer_think|handoff_atom_think/,
  designated: /designated_lock|designated_done|handoff_atom_designated/,
  who_grasp: /next_customer_grasp|loop_who_grasp|now_customer/,
  loop_advance: /loop_advance|loop_phase_grasp|dl:loop_handoff_grasp|clear_then_fill_ok/,
};

/** 監査 steps から幹原子を読む */
export function atomsFromAuditSteps(
  steps: ReadonlyArray<{ k?: string; d?: string } | string> | null | undefined,
): HandoffLoopAtoms {
  const blob = JSON.stringify(steps || []);
  return {
    leftover_clean: /leftover_clean|leftover_done_F57|leftover_scan/.test(blob),
    customer_think: /customer_think/.test(blob),
    place_fill: /now_customer.*place|flow_done_place|guide_phase_ok|flow_atom_ok_place_select|loop_phase_grasp/.test(blob),
    search: /now_customer search|search_press|search_armed|guide_phase_after_search|flow_done_search|flow_atom_ok_search/.test(blob),
    send_or_pdf: /auto_pdf|batch_customer_done|dl:auto_pdf|flow_atom_ok_send/.test(blob),
    post_send_clear: /post_send_clear|flow_atom_ok_post_send|handoff_atom_post_send/.test(blob),
    ready_next: /ready_next|series_done|flow_done_ready_next|flow_atom_ok_ready_next|loop_advance/.test(blob),
    human_takeover: /human_takeover/.test(blob),
  };
}

/** 細分化原子 */
export function fineAtomsFromAuditSteps(
  steps: ReadonlyArray<{ k?: string; d?: string } | string> | null | undefined,
): HandoffFineAtoms {
  const blob = JSON.stringify(steps || []);
  const out = {} as HandoffFineAtoms;
  for (const id of HANDOFF_FINE_ORDER) {
    out[id] = FINE_RE[id].test(blob);
  }
  return out;
}

export function judgeHandoffLoop(atoms: HandoffLoopAtoms): HandoffLoopJudge {
  const gaps: string[] = [];
  for (const k of ORDER) {
    if (!atoms[k]) gaps.push(LABEL[k]);
  }
  const human = !!atoms.human_takeover;
  const canAdvance = !human && !!atoms.ready_next;
  const ok = gaps.length === 0 && !human;
  const bits = ORDER.map((k) => (atoms[k] ? "✓" : "✗") + LABEL[k]).join(" ");
  return {
    ok,
    gaps,
    canAdvance,
    summary: (human ? "人引取で一括HOLD " : "") + bits + (gaps.length ? "／欠=" + gaps.join("・") : "／一連OK"),
  };
}

function fineItem(id: HandoffFineId): HandoffStrengthenItem {
  const why = `${FINE_LABEL[id]}の印が無い`;
  switch (id) {
    case "switch":
      return { id, layer: "free", why, next: "switch_grasp／flow_done_switch を fill 開始で stamp", foundation: "F44" };
    case "place_clear":
      return { id, layer: "free", why, next: "leftover_scan→clear_method→leftover_clean を前客外しで揃える", foundation: "F47" };
    case "place_select":
      return { id, layer: "free", why, next: "flow_done_place／place_select 原子を場所入れ完了で stamp", foundation: "F45" };
    case "conditions":
      return { id, layer: "free", why, next: "flow_done_conditions を条件入れ完了で stamp", foundation: "F45" };
    case "customer_think":
      return { id, layer: "free", why, next: "fill直前 _refreshCustomerThink→customer_think stamp（2.8.202+）", foundation: "F61" };
    case "search":
      return { id, layer: "free", why, next: "search_press／flow_done_search を検索押下で stamp", foundation: "F45" };
    case "fill_done":
      return { id, layer: "free", why, next: "flow_done_fill_done を fill-done で stamp", foundation: "F45" };
    case "send_or_pdf":
      return { id, layer: "human", why, next: "一覧到達後 auto_pdf／batch_customer_done を残す（並べ替え穴も併せて）", foundation: "F62" };
    case "post_send_clear":
      return { id, layer: "free", why, next: "≥2.8.203 runId明示の post_send_clear／handoff_atom_post_send", foundation: "F61" };
    case "ready_next":
      return { id, layer: "free", why, next: "一連完了で ready_next／series_done／handoff_atom_ready", foundation: "F45" };
    case "next_clear":
      return { id, layer: "free", why, next: "次客開始 leftover_scan／flow_atom_ok_next_clear", foundation: "F47" };
    case "designated":
      return { id, layer: "free", why, next: "指定客は designated_lock→designated_done（2.8.201+）", foundation: "F61" };
    case "who_grasp":
      return { id, layer: "free", why, next: "next_customer_grasp／loop_who_grasp／now_customer を fill・完了・次客前で残す（2.8.221+）", foundation: "F44" };
    case "loop_advance":
      return { id, layer: "free", why, next: "series_done 後に loop_advance（完了→次）と loop_phase_grasp を残す（2.8.222）", foundation: "F45" };
    default:
      return { id, layer: "free", why, next: "監査印を残す", foundation: "F62" };
  }
}

/**
 * ★ 2.8.222: 客完了→次客の把握文（BG・page・パネルで再利用）
 */
export function formatLoopAdvance(input: {
  currentName?: string | null;
  nextName?: string | null;
  index?: number;
  total?: number;
}): { summary: string; nextMove: string; whoLine: string } {
  const cur = String(input.currentName || "").trim() || "-";
  const nxt = String(input.nextName || "").trim();
  const idx = Number(input.index) || 0;
  const tot = Number(input.total) || 0;
  const pos = idx > 0 && tot > 0 ? `（${idx}/${tot}）` : "";
  const nextMove = nxt ? "前客の選択を1つずつ外す" : "一括完了";
  return {
    summary: nxt
      ? `客完了→次へ${pos} いま=${cur.slice(0, 16)} 次=${nxt.slice(0, 16)}`
      : `客完了・一括末${pos} いま=${cur.slice(0, 16)}`,
    nextMove,
    whoLine: `いま客=${cur.slice(0, 20)} 次客=${nxt ? nxt.slice(0, 20) : "（末）"}`,
  };
}

/**
 * 幹＋細分化の欠を無料優先で強化計画にする（推測で課題を増やさない・印の有無だけ）。
 */
export function planHandoffStrengthen(
  steps: ReadonlyArray<{ k?: string; d?: string } | string> | null | undefined,
): HandoffStrengthenPlan {
  const trunk = judgeHandoffLoop(atomsFromAuditSteps(steps));
  const fine = fineAtomsFromAuditSteps(steps);
  const fine_gaps = HANDOFF_FINE_ORDER.filter((id) => !fine[id]);
  const items = fine_gaps.map(fineItem);
  // 無料を先・人間を後
  items.sort((a, b) => (a.layer === b.layer ? 0 : a.layer === "free" ? -1 : b.layer === "free" ? 1 : a.layer === "human" ? -1 : 1));
  const ok = trunk.ok && fine_gaps.length === 0;
  const line = ok
    ? "連続客ループ細分化✓ 幹OK・細原子全OK"
    : `連続客ループ強化要 幹欠=${trunk.gaps.join("・") || "なし"}／細欠=${fine_gaps.map((g) => FINE_LABEL[g]).join("・") || "なし"}`;
  const next = items[0]
    ? `[${items[0].foundation}/${items[0].layer}] ${items[0].next}`
    : "維持（連続2客で印を再確認）";
  return { ok, trunk_gaps: trunk.gaps, fine_gaps, items, line, next };
}

/** 複数監査から細原子の出現回数を集計（土台 F62 用） */
export function countFineAtomsAcrossAudits(
  audits: ReadonlyArray<{ steps?: unknown } | null | undefined>,
): { counts: Record<HandoffFineId, number>; runs: number; line: string; weak: HandoffFineId[] } {
  const counts = {} as Record<HandoffFineId, number>;
  for (const id of HANDOFF_FINE_ORDER) counts[id] = 0;
  let runs = 0;
  for (const a of audits) {
    if (!a) continue;
    runs++;
    const fine = fineAtomsFromAuditSteps(Array.isArray(a.steps) ? (a.steps as Array<{ k?: string; d?: string }>) : []);
    for (const id of HANDOFF_FINE_ORDER) {
      if (fine[id]) counts[id]++;
    }
  }
  const weak = HANDOFF_FINE_ORDER.filter((id) => counts[id] === 0);
  const bits = HANDOFF_FINE_ORDER.map((id) => `${FINE_LABEL[id]}${counts[id]}`).join("・");
  return {
    counts,
    runs,
    weak,
    line: runs === 0 ? "連続客細原子: 監査0件" : `連続客細原子 runs=${runs} ${bits}${weak.length ? `／弱0回=${weak.map((w) => FINE_LABEL[w]).join("・")}` : "／弱なし"}`,
  };
}
