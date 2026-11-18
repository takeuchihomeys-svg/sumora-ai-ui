/**
 * 人間として自動化するための「細部改善ループ」土台（2026-11-17 統括Pro）
 *
 *   竹内さん「人間として自動化できるように細部にこだわった改善／仕組みと土台を徹底」
 *
 * ★ なぜ要るか
 *   押した位置・aim・間隔・外しをバラバラに直しても、一連の仕組みが無いと
 *   「直したつもり→測れない→また弱い」が繰り返す。
 *   → 原子を番号付き段階に載せ、統括Proが次手を1つずつ出せるようにする。
 *
 * ★ 段階（無料→費用の順）
 *   1. 弱所を見つける（自動録画の原子）
 *   2. 通常から学ぶ（録画・画像）
 *   3. 土台をそろえる（F15/F16/F28/F29/F49・座標配線）
 *   4. 狙って押して残す（learn_warm→aim有→pointer→rec-point）
 *   5. 度で確かめる（DETAIL_DEGREE）
 *
 * ⚠ 純関数。DBに書かない。
 */
import { DETAIL_DEGREE } from "./learn-improve-mech";

export type HumanDetailStepId =
  | "find_weak"
  | "learn_normal"
  | "foundation"
  | "aim_press_record"
  | "verify_degree";

export type HumanDetailStep = {
  n: number;
  id: HumanDetailStepId;
  name: string;
  ok: boolean;
  detail: string;
};

export type HumanDetailAtom = {
  id: string;
  step: HumanDetailStepId;
  what: string;
  need: string;
  next: string;
  /** free | ext | flash | human */
  cost: "free" | "ext" | "flash" | "human";
};

export type HumanDetailLoop = {
  steps: HumanDetailStep[];
  atoms: HumanDetailAtom[];
  bottleneck_n: number | null;
  bottleneck: string | null;
  line: string;
  /** 度の完了線1行 */
  degree_line: string;
};

export type HumanDetailInput = {
  pointPct?: number | null;
  cursorPct?: number | null;
  aimHitPct?: number | null;
  aimAri?: number | null;
  aimNashi?: number | null;
  learnWarmN?: number | null;
  shortGapPct?: number | null;
  nearnessAllowed?: boolean | null;
  nearnessScore?: number | null;
  visionPhotoOk?: boolean | null;
  fireAtPointWired?: boolean | null;
  /** 拡張版（2.8.86+ で座標配線） */
  extVersion?: string | null;
  changedWithoutClick?: number | null;
  unreadNormal?: number | null;
  autoAfterBundle?: boolean | null;
};

function verAtLeast(v: string | null | undefined, want: string): boolean {
  const a = String(v || "").split(".").map((x) => Number(x) || 0);
  const b = want.split(".").map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}

/**
 * 細部改善ループを組む（純関数）。
 */
export function buildHumanDetailLoop(inp: HumanDetailInput): HumanDetailLoop {
  const d = DETAIL_DEGREE;
  const pointPct = inp.pointPct ?? null;
  const cursorPct = inp.cursorPct ?? null;
  const aimAri = Number(inp.aimAri) || 0;
  const aimNashi = Number(inp.aimNashi) || 0;
  const aimSample = aimAri + aimNashi;
  const aimHitPct = inp.aimHitPct != null
    ? inp.aimHitPct
    : (aimSample > 0 ? Math.round((aimAri / aimSample) * 100) : null);
  const warmN = Number(inp.learnWarmN) || 0;
  const shortPct = inp.shortGapPct ?? null;
  const visionOk = inp.visionPhotoOk === true;
  const wired = inp.fireAtPointWired === true || verAtLeast(inp.extVersion, "2.8.86");
  const direct = Number(inp.changedWithoutClick) || 0;
  const unread = Number(inp.unreadNormal) || 0;
  const autoAfter = inp.autoAfterBundle === true;

  const atoms: HumanDetailAtom[] = [];
  const push = (a: HumanDetailAtom) => {
    if (atoms.some((x) => x.id === a.id)) return;
    atoms.push(a);
  };

  // ① 弱所
  const weakPoint = pointPct != null && pointPct < d.POINT_OK;
  const weakAim = aimHitPct != null && aimHitPct < 40;
  const weakGap = shortPct != null && shortPct > 12;
  const weakNear = inp.nearnessAllowed === false;
  const weakDirect = direct > 0;
  const findOk = !(weakPoint || weakAim || weakGap || weakNear || weakDirect);
  if (weakPoint) {
    push({
      id: "atom:point_pct",
      step: "find_weak",
      what: `押した位置${pointPct}%（要≥${d.POINT_OK}）`,
      need: "欄ごとの実座標が point_fields に残る",
      next: "aim_press_record で _fireAt→axlx-rec-point → 自動1回で測る",
      cost: "ext",
    });
  }
  if (weakAim) {
    push({
      id: "atom:aim_hit",
      step: "find_weak",
      what: `aim有${aimHitPct ?? 0}%（要≥40・有${aimAri}/無${aimNashi}）`,
      need: "learn_warm後に _aimOf が学んだ位置を返す",
      next: "fill先頭で learn_warm 強制→drain時に aim 再引き",
      cost: "ext",
    });
  }
  if (weakGap || weakNear) {
    push({
      id: "atom:gap_near",
      step: "find_weak",
      what: `間隔短${shortPct ?? "?"}％／近さ${inp.nearnessScore ?? "?"}${inp.nearnessAllowed === false ? "未達" : ""}`,
      need: "操作と操作の間（click同士）が人帯。click→changeの短間隔は測らない",
      next: "F28/F29の計測を動作間に限定＋_uiGapMin厳守",
      cost: "free",
    });
  }
  if (weakDirect) {
    push({
      id: "atom:direct_write",
      step: "find_weak",
      what: `直書き疑い${direct}件`,
      need: "カーソル→開く→押す（value直書き禁止）",
      next: "changedWithoutClick 欄を通常録画から学ぶ",
      cost: "human",
    });
  }

  // ② 学ぶ
  const learnOk = unread < 50 || visionOk;
  if (unread >= 50 && !visionOk) {
    push({
      id: "atom:learn_photos",
      step: "learn_normal",
      what: `未学習通常≈${unread}・写真→統括未達`,
      need: "F49で写真がvisionに届き flash が位置を読める",
      next: "デプロイ後に束再生成→vision段1✓→弱い欄のflash",
      cost: "flash",
    });
  }

  // ③ 土台
  const foundationOk = visionOk && wired && warmN >= 0; // warmは印が後から付く
  if (!visionOk) {
    push({
      id: "atom:f49_vision",
      step: "foundation",
      what: "F49 写真→統括到達が未達",
      need: "サイト別 shot_bytes/photo_kinds が vision_pro_link に届く",
      next: "本番デプロイ→束再生成（freshは位置落ち注意）",
      cost: "free",
    });
  }
  if (!wired) {
    push({
      id: "atom:fireat_point",
      step: "foundation",
      what: "_fireAt→point 座標配線が未確認",
      need: "拡張≥2.8.86 で axlx-rec-point が録画に届く",
      next: "拡張再読込→自動1回",
      cost: "ext",
    });
  }

  // ④ 狙って押して残す
  const aimPressOk = wired && (aimHitPct == null || aimHitPct >= 40) && (pointPct == null || pointPct >= d.POINT_OK * 0.7);
  if (wired && (warmN < 1 || weakAim)) {
    push({
      id: "atom:warm_aim",
      step: "aim_press_record",
      what: `learn_warm=${warmN}・aim有不足`,
      need: "押しの直前に束が温まり aim が付く",
      next: "反映関所のあと・drain直前に aim 再引き",
      cost: "ext",
    });
  }

  // ⑤ 確かめる
  const degreeOk =
    (pointPct == null || pointPct >= d.POINT_OK)
    && (cursorPct == null || cursorPct >= d.CURSOR_OK)
    && direct === 0
    && autoAfter;
  if (!degreeOk) {
    push({
      id: "atom:verify",
      step: "verify_degree",
      what: "DETAIL_DEGREE 未達または新束後自動なし",
      need: `直書き0・カーソル≥${d.CURSOR_OK}・位置≥${d.POINT_OK}・新束後自動1回`,
      next: "自動1回→ foundation-audit / supervisor-pro で数字確認",
      cost: "human",
    });
  }

  const steps: HumanDetailStep[] = [
    {
      n: 1,
      id: "find_weak",
      name: "弱所を見つける",
      ok: findOk,
      detail: findOk
        ? "押した位置・aim・間隔・直書きに大きな弱所なし"
        : atoms.filter((a) => a.step === "find_weak").map((a) => a.what).slice(0, 3).join("／") || "弱所あり",
    },
    {
      n: 2,
      id: "learn_normal",
      name: "通常から学ぶ",
      ok: learnOk,
      detail: learnOk ? "学習材料の栓なし" : "写真→統括または未学習が多い",
    },
    {
      n: 3,
      id: "foundation",
      name: "土台をそろえる",
      ok: visionOk && wired,
      detail: `F49=${visionOk ? "✓" : "✗"} 座標配線=${wired ? "✓" : "✗"}`,
    },
    {
      n: 4,
      id: "aim_press_record",
      name: "狙って押して残す",
      ok: aimPressOk,
      detail: `aim有=${aimHitPct ?? "?"}% warm=${warmN} 位置=${pointPct ?? "?"}%`,
    },
    {
      n: 5,
      id: "verify_degree",
      name: "度で確かめる",
      ok: degreeOk,
      detail: `カーソル${cursorPct ?? "?"}%・位置${pointPct ?? "?"}%・直書き${direct}・新束後自動=${autoAfter ? "✓" : "✗"}`,
    },
  ];

  const stuck = steps.find((s) => !s.ok) || null;
  const line = steps.map((s) => `${s.n}.${s.name}${s.ok ? "✓" : "✗"}`).join(" → ")
    + (stuck ? ` ／止: ${stuck.n}.${stuck.name}（${stuck.detail}）` : " ／細部改善ループ完了");

  const degree_line =
    `度: カーソル≥${d.CURSOR_OK}・押した位置≥${d.POINT_OK}・直書き0`
    + (cursorPct != null ? `／今カーソル${cursorPct}%` : "")
    + (pointPct != null ? `・位置${pointPct}%` : "");

  return {
    steps,
    atoms: atoms.slice(0, 12),
    bottleneck_n: stuck ? stuck.n : null,
    bottleneck: stuck ? `${stuck.n}.${stuck.name}: ${stuck.detail}` : null,
    line,
    degree_line,
  };
}
