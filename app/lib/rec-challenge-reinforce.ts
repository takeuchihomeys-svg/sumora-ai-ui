/**
 * 録画 → 課題発見 → 改善学習 → 足りない仕組みの補強（2026-11-18 竹内さん）
 *
 *   「録画して課題見つけて改善と学習してたりていない仕組みは補強する仕組みを作る」
 *   統括Pro: ①自動弱点→②通常flash→③土台追加→④束載せ→⑤拡張再読込→⑥自動1回→⑦効果確認
 *   竹内さん追加: ⑧学習方法を効果で直して①へ戻す（完全ループ）
 *
 * ★ なぜ要るか
 *   diagnose / human-detail / weak-strengthen / improve-loop が別々だと、
 *   「弱所は分かった・写真は読んだ」で止まり、足りない仕組み（aim配線・読込関所）が残る。
 *   → 1本の段階で課題と仕組み不足を同時に次手化し、学び方自体も周回で強化する。
 *
 * ⚠ 純関数。DBに書かない・Visionを呼ばない。実行は scripts / 統括根拠。
 */
import { diagnoseAutoRecording, type DiagnoseAtom, type DiagnoseInput } from "./auto-rec-diagnose";
import { buildHumanDetailLoop, type HumanDetailInput, type HumanDetailLoop } from "./human-detail-loop";
import { ensureStrengthenAfterLearn, type ImproveTask, type ImproveTaskKind } from "./improve-loop";
import { DETAIL_DEGREE } from "./learn-improve-mech";
import {
  strengthenLearnMethod,
  type LearnMethodStrengthen,
} from "./learn-method-strengthen";

export type RecChallengeStepId =
  | "find_challenge"
  | "learn_normal"
  | "reinforce_mech"
  | "bundle_put"
  | "ext_reload"
  | "auto_run"
  | "verify"
  | "method_strengthen";

export type RecChallengeStep = {
  n: number;
  id: RecChallengeStepId;
  name: string;
  ok: boolean;
  detail: string;
};

export type MechGap = {
  id: string;
  /** 足りない仕組み */
  what: string;
  /** どう補強するか */
  how: string;
  /** 既にコードにあるか（版・配線印） */
  coded: boolean;
  cost: "free" | "ext" | "flash" | "human";
};

export type RecChallengeReinforce = {
  steps: RecChallengeStep[];
  diagnose_atoms: DiagnoseAtom[];
  mech_gaps: MechGap[];
  tasks: ImproveTask[];
  bottleneck_n: number | null;
  bottleneck: string | null;
  line: string;
  detail_loop: HumanDetailLoop;
  /** 学習方法そのものの強化 */
  method: LearnMethodStrengthen;
  /** 未達なら①へ戻して周回 */
  continue_loop: boolean;
};

export type RecChallengeInput = DiagnoseInput & HumanDetailInput & {
  /** 束の solid 画面位置欄数 */
  screenSolid?: number | null;
  /** 束の thin(n≥1) 含む位置欄数 */
  screenAll?: number | null;
  /** 拡張の束読込回数 */
  readCount?: number | null;
  /** 新束後の自動走行あり */
  autoAfterBundle?: boolean | null;
  /** 拡張版（2.8.86+ で axlx-rec-point 配線） */
  extVersion?: string | null;
  /** 未学習通常枚数 */
  unreadNormal?: number | null;
  /** 画像にあるが押していない欄数（材料） */
  imageButNotPressed?: number | null;
  /** reflect_ok / flow_hit */
  reflectOk?: number | null;
  flowHit?: number | null;
  /** 前回の数字（学び方の前後比較） */
  before?: {
    pointPct?: number | null;
    aimHitPct?: number | null;
    nearnessScore?: number | null;
    readCount?: number | null;
    shortGapPct?: number | null;
  } | null;
  /** 直近に使った学び kind */
  usedKinds?: string[] | null;
  didFlash?: boolean | null;
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
 * 足りない仕組みを列挙（コード有無と「効いているか」を分ける）。
 */
export function findMechGaps(inp: RecChallengeInput): MechGap[] {
  const gaps: MechGap[] = [];
  const push = (g: MechGap) => {
    if (gaps.some((x) => x.id === g.id)) return;
    gaps.push(g);
  };
  const codedPoint = inp.fireAtPointWired === true || verAtLeast(inp.extVersion, "2.8.86");
  const read = Number(inp.readCount) || 0;
  const solid = Number(inp.screenSolid) || 0;
  const all = Number(inp.screenAll) || solid;
  const aimAri = Number(inp.aimAri) || 0;
  const aimNashi = Number(inp.aimNashi) || 0;
  const pointPct = inp.pointPct ?? null;
  const reflectOk = Number(inp.reflectOk) || 0;

  if (pointPct != null && pointPct < DETAIL_DEGREE.POINT_OK) {
    push({
      id: "mech:aim_press_record",
      what: "押した位置を残す仕組み（aim_press_record／point_fields）",
      how: codedPoint
        ? "配線はある。learn_warm→aim有→自動1回で point_fields を残す（再読込が関所）"
        : "拡張に _fireAt→axlx-rec-point を足してから自動1回",
      coded: codedPoint,
      cost: "ext",
    });
  }
  if (aimNashi > 0 && aimAri === 0) {
    push({
      id: "mech:learn_warm_aim",
      what: "学んだ位置で狙う仕組み（learn_warm→aim）",
      how: "束再取得→fill先頭 warm→押し直前に aim 再引き",
      coded: codedPoint,
      cost: "ext",
    });
  }
  if (read < 1) {
    push({
      id: "mech:bundle_read",
      what: "束→拡張読込の仕組み（read_count）",
      how: "拡張再読込→ポップアップで束取込（学習しても読まないと効かない）",
      coded: true,
      cost: "ext",
    });
  }
  if (all < 1 && (Number(inp.imageButNotPressed) || 0) > 0) {
    push({
      id: "mech:bundle_thin",
      what: "画像位置を束に載せる仕組み（n≥1 thin）",
      how: "通常flashで位置を読み、F33/F36関所経由で束へ（solidは連携完了の数え用）",
      coded: true,
      cost: "flash",
    });
  }
  if (inp.autoAfterBundle !== true && read >= 1) {
    push({
      id: "mech:auto_after",
      what: "新束後に自動で測る仕組み",
      how: "自動モードで1回検索→F31/F32・point_pct・aim有を数字で見る",
      coded: true,
      cost: "human",
    });
  }
  if (read >= 1 && reflectOk < 1 && inp.autoAfterBundle === true) {
    push({
      id: "mech:reflect_ok",
      what: "学習反映印の仕組み（learn_reflect_ok）",
      how: "束の駅遷移と自動の ok/hit が付くまで手順を直す",
      coded: true,
      cost: "ext",
    });
  }
  if (inp.nearnessAllowed === false) {
    push({
      id: "mech:gap_floor",
      what: "動作間の間隔床（短間隔を人帯へ）",
      how: "click同士の gap floor を厳守。旧自動データが残る間は新版走行だけで再測",
      coded: verAtLeast(inp.extVersion, "2.8.90"),
      cost: "ext",
    });
  }
  /**
   * ★ 2026-11-18 HONOKA: 間取り全hit＋search_armed は 2.8.92+。
   *   効いているかは自動1回の印で測る（版が古いだけでは「揃えば完了」を壊さない）。
   *   1録画完走の次手は one-rec-learn-loop 根拠に載せる。
   */
  if (verAtLeast(inp.extVersion, "2.8.92") && inp.autoAfterBundle !== true) {
    push({
      id: "mech:one_rec_reflect",
      what: "1録画→学習→改善→反映の一連",
      how: "直近自動の原子を one-rec-learn-loop で次手化。verify印が出るまで同じ客で再走",
      coded: true,
      cost: "human",
    });
  }
  return gaps.slice(0, 12);
}

/**
 * 録画課題→学習→仕組み補強の一連を組む。
 */
export function buildRecChallengeReinforce(inp: RecChallengeInput): RecChallengeReinforce {
  const detail = buildHumanDetailLoop(inp);
  const diag = diagnoseAutoRecording(inp);
  const mech = findMechGaps(inp);

  const unread = Math.max(0, Number(inp.unreadNormal) || 0);
  const read = Number(inp.readCount) || 0;
  const solid = Number(inp.screenSolid) || 0;
  const all = Number(inp.screenAll) || solid;
  const imageMat = Number(inp.imageButNotPressed) || 0;
  const pointPct = inp.pointPct ?? null;
  const aimAri = Number(inp.aimAri) || 0;
  const aimNashi = Number(inp.aimNashi) || 0;
  const aimHit = aimAri + aimNashi > 0 ? Math.round((aimAri / (aimAri + aimNashi)) * 100) : null;

  const findOk = diag.atoms.length === 0 && detail.steps[0]?.ok === true;
  const learnOk = unread < 50 || imageMat === 0 || all >= 30;
  /** 仕組み補強: 未配線が無く、aim無ばかりでもない（読込関所は⑤で測る） */
  const reinforceOk =
    mech.filter((g) => !g.coded).length === 0
    && !(aimNashi > 0 && aimAri === 0 && read >= 1);
  const bundleOk = all >= 1 || solid >= 1;
  const reloadOk = read >= 1;
  const autoOk = inp.autoAfterBundle === true;
  const verifyOk =
    reloadOk
    && autoOk
    && (Number(inp.reflectOk) || 0) >= 1
    && (pointPct == null || pointPct >= DETAIL_DEGREE.POINT_OK)
    && (aimHit == null || aimHit >= 40);

  const steps: RecChallengeStep[] = [
    {
      n: 1,
      id: "find_challenge",
      name: "録画から課題を見つける",
      ok: findOk,
      detail: findOk
        ? "大きな課題原子なし"
        : (diag.atoms.slice(0, 3).map((a) => a.problem).join("／") || detail.bottleneck || "課題あり"),
    },
    {
      n: 2,
      id: "learn_normal",
      name: "通常から改善学習",
      ok: learnOk,
      detail: `未学習≈${unread}・画像材料${imageMat}・束位置 solid${solid}/all${all}`,
    },
    {
      n: 3,
      id: "reinforce_mech",
      name: "足りない仕組みを補強",
      ok: reinforceOk,
      detail: mech.length
        ? mech.slice(0, 3).map((g) => `${g.what}${g.coded ? "(コード有)" : "(未配線)"}`).join("／")
        : "仕組みギャップなし",
    },
    {
      n: 4,
      id: "bundle_put",
      name: "束に載せる",
      ok: bundleOk,
      detail: bundleOk ? `位置欄 solid${solid}/all${all}` : "束に位置が無い（flash→F33/F36）",
    },
    {
      n: 5,
      id: "ext_reload",
      name: "拡張が束を読む",
      ok: reloadOk,
      detail: reloadOk ? `read_count=${read}` : "read_count=0 → 再読込＋ポップアップで束取込",
    },
    {
      n: 6,
      id: "auto_run",
      name: "自動1回で使う",
      ok: autoOk,
      detail: autoOk ? "新束後の自動あり" : "自動1回がまだ（効果を測れない）",
    },
    {
      n: 7,
      id: "verify",
      name: "効果を数字で確かめる",
      ok: verifyOk,
      detail: `reflect_ok=${inp.reflectOk ?? 0} aim有%=${aimHit ?? "?"} 位置%=${pointPct ?? "?"}`,
    },
    {
      n: 8,
      id: "method_strengthen",
      name: "学習方法を強化してまた回す",
      ok: false, // method2 で差し替え
      detail: "",
    },
  ];

  // ①〜⑦の止を見て学び方を直す
  const stuckEarly = steps.find((s) => s.n <= 7 && !s.ok) || null;
  const method2 = strengthenLearnMethod({
    before: inp.before || null,
    after: {
      pointPct,
      aimHitPct: aimHit,
      nearnessScore: inp.nearnessScore ?? null,
      readCount: read,
      shortGapPct: inp.shortGapPct ?? null,
      reflectOk: Number(inp.reflectOk) || 0,
    },
    usedKinds: inp.usedKinds || (unread === 0 && imageMat > 0 ? ["photo_learn"] : null),
    bottleneckN: stuckEarly?.n ?? null,
    didFlash: inp.didFlash ?? (unread === 0 && pointPct != null && pointPct < 60),
    unreadNormal: unread,
    pointOk: DETAIL_DEGREE.POINT_OK,
    aimOk: 40,
  });
  steps[7] = {
    n: 8,
    id: "method_strengthen",
    name: "学習方法を強化してまた回す",
    ok: method2.upgrades.length === 0 && verifyOk,
    detail: method2.line,
  };

  const stuck = steps.find((s) => !s.ok) || null;
  const tasks: ImproveTask[] = [];
  const pushTask = (t: ImproveTask) => {
    if (tasks.some((x) => x.kind === t.kind && x.what === t.what)) return;
    tasks.push(t);
  };

  if (stuck?.id === "find_challenge" || stuck?.id === "learn_normal") {
    if (unread > 0 || imageMat > 0) {
      pushTask({
        kind: "photo_learn",
        what: "録画の課題欄・弱い位置を通常画像から読む",
        why: diag.atoms[0]
          ? `${diag.atoms[0].problem} → ${diag.atoms[0].need}`
          : `材料${imageMat}／未学習${unread}`,
        cost: "1枚ごとに Vision の費用（枚数は統括が課題に応じて決める）",
        order: "newest",
      });
    }
  }
  if (stuck?.id === "reinforce_mech" || mech.some((g) => !g.coded)) {
    const uncoded = mech.filter((g) => !g.coded);
    pushTask({
      kind: "reflect_auto",
      what: uncoded[0]
        ? `仕組み補強: ${uncoded[0].what}`
        : `仕組み補強: ${mech[0]?.what || "aim/読込"}`,
      why: (uncoded[0] || mech[0])?.how || "足りない仕組みを先にそろえる",
      cost: "無料〜拡張",
    });
  }
  if (stuck?.id === "bundle_put" || (!bundleOk && imageMat > 0)) {
    pushTask({
      kind: "photo_learn",
      what: "画像位置を読んで束に n≥1 thin で載せる",
      why: `束位置不足／画像材料${imageMat}`,
      cost: "1枚ごとに Vision の費用",
      order: "newest",
    });
    pushTask({
      kind: "reflect_auto",
      what: "学んだ位置を束に載せ直す（F33/F36関所）",
      why: "読んだだけで終わらせない",
      cost: "無料",
    });
  }
  if (stuck?.id === "ext_reload" || read < 1) {
    pushTask({
      kind: "need_ext_reload",
      what: "拡張を再読み込みして最新の束を取り直す",
      why: "read_count=0。学習・仕組みがあっても拡張が読まないと課題は消えない",
      cost: "無料（人の手間だけ）",
    });
  }
  if (stuck?.id === "auto_run" || stuck?.id === "ext_reload" || !autoOk) {
    pushTask({
      kind: "need_auto_run",
      what: "自動モードで1回検索する（課題が減ったか測る）",
      why: "録画→課題→学習→仕組みの効果は自動1回の数字でしか見えない",
      cost: "無料（人の手間だけ）",
    });
  }
  pushTask({
    kind: "verify_improve",
    what: "F31/F32・point_pct・aim有・近さを数字で確かめる",
    why: stuck ? `止: ${stuck.n}.${stuck.name}` : "一連完了の確認",
    cost: "無料",
  });

  const withStrengthen = ensureStrengthenAfterLearn(tasks, {
    bottleneck_n: stuck ? Math.min(stuck.n, 6) : null,
  });

  // 仕組みギャップをタスクの先頭寄りに残す（photoだけの課題にしない）
  const mechFirst = [...withStrengthen];
  if (mech.some((g) => g.id === "mech:bundle_read") && !mechFirst.some((t) => t.kind === "need_ext_reload")) {
    mechFirst.unshift({
      kind: "need_ext_reload" as ImproveTaskKind,
      what: "拡張再読込→束取込（仕組み: 束読込）",
      why: "反映関所が開かないと aim有・押した位置は上がらない",
      cost: "無料（人の手間だけ）",
    });
  }

  // 学び方の強化を次手に載せる（flash偏重を関所優先へ）
  if (method2.upgrades.some((u) => u.id === "order_reload_before_flash")) {
    if (!mechFirst.some((t) => t.kind === "need_ext_reload")) {
      mechFirst.unshift({
        kind: "need_ext_reload",
        what: "学び方修正: 先に拡張再読込（flashより関所優先）",
        why: method2.upgrades.find((u) => u.id === "order_reload_before_flash")!.better_how,
        cost: "無料（人の手間だけ）",
      });
    }
  }
  if (method2.upgrades.some((u) => u.id === "verify_then_relearn")) {
    if (!mechFirst.some((t) => t.kind === "verify_improve" && /学び成功/.test(t.what))) {
      mechFirst.push({
        kind: "verify_improve",
        what: "学び成功の定義を上げてから残課題だけ再学習",
        why: method2.next_method_line,
        cost: "無料",
      });
    }
  }

  const continue_loop = method2.continue_loop || stuck != null;
  const line = steps.map((s) => `${s.n}.${s.name}${s.ok ? "✓" : "✗"}`).join(" → ")
    + (stuck
      ? ` ／止: ${stuck.n}.${stuck.name}（${stuck.detail}）`
      : " ／録画課題→補強→学び方強化の完全ループ完了")
    + (continue_loop && stuck ? ` ／${method2.next_method_line}` : "");

  return {
    steps,
    diagnose_atoms: diag.atoms,
    mech_gaps: mech,
    tasks: mechFirst.slice(0, 12),
    bottleneck_n: stuck ? stuck.n : null,
    bottleneck: stuck ? `${stuck.n}.${stuck.name}: ${stuck.detail}` : null,
    line,
    detail_loop: detail,
    method: method2,
    continue_loop,
  };
}
