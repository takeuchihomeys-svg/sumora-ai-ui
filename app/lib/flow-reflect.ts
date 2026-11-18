/**
 * 録画の流れ（場面）→弱い段の強化→自動反映（2026-11-17）
 *
 * ★ 竹内さん「流れの部分も把握弱い部分録画から強化して改善したのを自動モードに反映」:
 *   人の scene_flows（area/station/cond/search）を完了段に写し、
 *   弱い場面を強化サイクルに載せ、自動の flow_done_* / learn_flow_reflect_* で測る。
 *
 * ⚠ 純関数。DBに書かない。
 */
import type { FlowScene } from "./learn-flow-steps";
import { SCENE_JA } from "./learn-flow-steps";
import type { ImproveTask } from "./improve-loop";

/** 完了理解台帳の段（F45） */
export type FlowPhase = "switch" | "place" | "conditions" | "search" | "fill_done" | "ready_next";

/** 録画の場面 → 完了段 */
export const SCENE_TO_PHASE: Partial<Record<FlowScene, FlowPhase>> = {
  area: "place",
  station: "place",
  cond: "conditions",
  search: "search",
};

export type SceneFlowLike = {
  scene?: string;
  steps?: string[];
  n?: number;
};

export type FlowWeakItem = {
  scene: FlowScene;
  phase: FlowPhase;
  reason: "missing" | "thin" | "auto_gap";
  stepsN: number;
  line: string;
};

/** 束の場面手順から弱い流れを拾う */
export function findWeakFlowFromRecordings(opt: {
  sceneFlows?: SceneFlowLike[] | null;
  sceneMissing?: string[] | null;
  /** 自動監査に flow_done_* が無い段 */
  autoFlowGaps?: FlowPhase[];
}): FlowWeakItem[] {
  const flows = Array.isArray(opt.sceneFlows) ? opt.sceneFlows : [];
  const byScene = new Map<string, SceneFlowLike>();
  for (const f of flows) {
    const sc = String(f?.scene || "").trim();
    if (!sc) continue;
    const prev = byScene.get(sc);
    const n = Array.isArray(f.steps) ? f.steps.length : Number(f.n) || 0;
    if (!prev || n > (Array.isArray(prev.steps) ? prev.steps!.length : Number(prev.n) || 0)) {
      byScene.set(sc, f);
    }
  }
  const missing = new Set((opt.sceneMissing || []).map((s) => String(s).trim()).filter(Boolean));
  const autoGaps = new Set(opt.autoFlowGaps || []);
  const out: FlowWeakItem[] = [];
  const watch: FlowScene[] = ["area", "station", "cond", "search"];
  for (const sc of watch) {
    const phase = SCENE_TO_PHASE[sc];
    if (!phase) continue;
    const row = byScene.get(sc);
    const stepsN = row && Array.isArray(row.steps) ? row.steps.length : Number(row?.n) || 0;
    if (missing.has(sc) || !row) {
      out.push({
        scene: sc,
        phase,
        reason: "missing",
        stepsN: 0,
        line: `録画に${SCENE_JA[sc]}の手本が無い → 自動の${phase}が弱くなる`,
      });
      continue;
    }
    /** 検索は1手で足りる。所在地・駅・条件は2手未満を薄いと見る */
    const thinNeed = sc === "search" ? 1 : 2;
    if (stepsN < thinNeed) {
      out.push({
        scene: sc,
        phase,
        reason: "thin",
        stepsN,
        line: `録画の${SCENE_JA[sc]}が薄い（steps=${stepsN}）→ 強化して自動へ`,
      });
    }
    if (autoGaps.has(phase)) {
      out.push({
        scene: sc,
        phase,
        reason: "auto_gap",
        stepsN,
        line: `録画はあるが自動に flow_done_${phase} が無い → 反映一連を回す`,
      });
    }
  }
  // 重複 scene を1つに（reason優先: missing > auto_gap > thin）
  const rank = { missing: 0, auto_gap: 1, thin: 2 };
  const best = new Map<string, FlowWeakItem>();
  for (const w of out) {
    const k = w.scene;
    const prev = best.get(k);
    if (!prev || rank[w.reason] < rank[prev.reason]) best.set(k, w);
  }
  return [...best.values()];
}

/** 弱い流れ → 強化課題（無料の need_auto を必ず付ける） */
export function buildFlowReflectCycle(weak: FlowWeakItem[], opt: { unreadNormal?: number } = {}): {
  weak: FlowWeakItem[];
  cycle: ImproveTask[];
  line: string;
  needs_auto: boolean;
} {
  const unread = Math.max(0, Number(opt.unreadNormal) || 0);
  const cycle: ImproveTask[] = [];
  if (!weak.length) {
    return { weak, cycle, line: "流れ弱さなし（録画→自動反映は測れる）", needs_auto: false };
  }
  const scenes = weak.map((w) => w.scene);
  if (unread > 0 && weak.some((w) => w.reason === "missing" || w.reason === "thin")) {
    cycle.push({
      kind: "photo_learn",
      what: "流れの弱い場面を通常録画から強化する",
      why: weak.slice(0, 4).map((w) => w.line).join("／"),
      cost: "1枚ごとに Vision の費用（枚数は統括が課題に応じて決める）",
      limit: Math.min(24, Math.max(6, unread)),
      order: "newest",
      fields: scenes.slice(0, 6),
    });
  }
  cycle.push({
    kind: "need_auto_run",
    what: "自動1回で流れ反映印（learn_flow_reflect_* / flow_done_*）を確認する",
    why: `弱い場面: ${scenes.join("・")} → 束→拡張→自動で印が付くまで needs_auto`,
    cost: "無料（人の手間だけ）",
  });
  return {
    weak,
    cycle,
    line: `流れ強化 ${weak.length}場面（${scenes.join("・")}）→ ${cycle.map((t) => t.kind).join("→")}`,
    needs_auto: true,
  };
}

/** 自動の steps 文字列から欠けている完了段を拾う */
export function autoFlowGapsFromStepsBlob(blob: string): FlowPhase[] {
  const s = String(blob || "");
  const phases: FlowPhase[] = ["place", "conditions", "search", "fill_done", "ready_next"];
  const gaps: FlowPhase[] = [];
  for (const p of phases) {
    if (new RegExp(`flow_done_${p}`).test(s)) continue;
    // fill開始すら無い回は全部 gap にしない（測れない）
    if (!/fill_start|fill_begin|flow_done_|flow_gap_/.test(s) && p !== "place") continue;
    gaps.push(p);
  }
  return gaps;
}
