/**
 * 学習したあとに「学習方法そのもの」を学び、よりよい学習へ強化する（2026-11-18 竹内さん）
 *
 *   「学習したあ学習方法もまなんでよりよい学習ができるように学習の強化する仕組みもちゃんと整える」
 *
 * ★ なぜ要るか
 *   同じ photo_learn を何周しても、順番・観点・関所が間違っていれば数字は動かない。
 *   → 効果の前後を見て「どの学び方が効かなかったか」を原子化し、次周の学び方を直す。
 *
 * ⚠ 純関数。推測で弱点を作らない（前後の数字と止まった段階だけ）。
 */

export type LearnMethodId =
  | "order_reload_before_flash"
  | "facet_position_first"
  | "thin_bundle_put"
  | "aim_warm_before_press"
  | "gap_floor_before_nearness"
  | "one_by_one_button"
  | "verify_then_relearn"
  | "site_method_parity";

export type LearnMethodUpgrade = {
  id: LearnMethodId;
  /** 何が悪かったか（学び方） */
  failed_how: string;
  /** 次はどう学ぶか */
  better_how: string;
  /** 根拠（数字） */
  evidence: string;
  priority: number;
  cost: "free" | "ext" | "flash" | "human";
};

export type LearnMethodStrengthen = {
  upgrades: LearnMethodUpgrade[];
  /** 次周の学び方1行 */
  next_method_line: string;
  /** まだ周回が要るか */
  continue_loop: boolean;
  line: string;
  /** 学習力への加点材料（統括根拠用） */
  power_hint: string;
};

export type LearnMethodStrengthenInput = {
  /** 学習前（または前回） */
  before?: {
    pointPct?: number | null;
    aimHitPct?: number | null;
    nearnessScore?: number | null;
    readCount?: number | null;
    shortGapPct?: number | null;
  } | null;
  /** 学習後（今） */
  after: {
    pointPct?: number | null;
    aimHitPct?: number | null;
    nearnessScore?: number | null;
    readCount?: number | null;
    shortGapPct?: number | null;
    reflectOk?: number | null;
  };
  /** 直近に使った学び（photo_learn / need_ext_reload 等） */
  usedKinds?: string[] | null;
  /** 録画→補強ループの停止段階 1〜7 */
  bottleneckN?: number | null;
  /** flash枚を回したか */
  didFlash?: boolean | null;
  /** 未学習がまだあるか */
  unreadNormal?: number | null;
  /** 押した位置の完了線 */
  pointOk?: number;
  /** aim完了線％ */
  aimOk?: number;
};

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 効果の前後と止まった段階から、学び方の強化案を出す。
 */
export function strengthenLearnMethod(inp: LearnMethodStrengthenInput): LearnMethodStrengthen {
  const before = inp.before || {};
  const after = inp.after || {};
  const used = new Set((inp.usedKinds || []).map(String));
  const bn = inp.bottleneckN ?? null;
  const pointOk = inp.pointOk ?? 60;
  const aimOk = inp.aimOk ?? 40;
  const upgrades: LearnMethodUpgrade[] = [];
  const push = (u: LearnMethodUpgrade) => {
    if (upgrades.some((x) => x.id === u.id)) return;
    upgrades.push(u);
  };

  const pointA = num(after.pointPct);
  const pointB = num(before.pointPct);
  const aimA = num(after.aimHitPct);
  const readA = num(after.readCount) ?? 0;
  const readB = num(before.readCount);
  const nearA = num(after.nearnessScore);
  const shortA = num(after.shortGapPct);
  const flash = inp.didFlash === true || used.has("photo_learn");
  const reloaded = used.has("need_ext_reload");
  const unread = Math.max(0, Number(inp.unreadNormal) || 0);

  // flashしたのに位置が動かず、かつ読込0 → 学びの順番が間違い
  if (flash && readA < 1 && (pointA == null || pointA < pointOk)) {
    push({
      id: "order_reload_before_flash",
      failed_how: "画像を読んでから拡張読込を後回しにした（または読ませないまままた読んだ）",
      better_how: "次周は先に拡張再読込→束取込→自動1回。flashは読込後に残課題だけ",
      evidence: `read=${readA} point=${pointA ?? "?"} flash済`,
      priority: 0,
      cost: "ext",
    });
  }

  // 読込0のまま止まっているのに flash ばかり → 関所優先へ方法変更
  if ((bn === 5 || readA < 1) && flash && !reloaded) {
    push({
      id: "order_reload_before_flash",
      failed_how: "段階5（拡張が束を読む）なのに学び方が flash 偏重",
      better_how: "学習方法の順番: 関所（再読込）→自動→効果。材料は既にあれば flash を止めて関所へ",
      evidence: `bottleneck=${bn} read=${readA}`,
      priority: 0,
      cost: "ext",
    });
  }

  // 位置％が低く aim も0 → 観点を位置優先に
  if ((pointA != null && pointA < pointOk) && (aimA == null || aimA < aimOk)) {
    push({
      id: "facet_position_first",
      failed_how: "欄の種類・全文読みに寄って、押す位置の観点が後回し",
      better_how: "欄×観点は position を最優先。n≥1 thin で束載せ→aim引きの材料にする",
      evidence: `point=${pointA}% aim有%=${aimA ?? 0}`,
      priority: 1,
      cost: "flash",
    });
    push({
      id: "thin_bundle_put",
      failed_how: "読んでも束に thin 位置が載らない／拡張が使えない",
      better_how: "flash後は必ず reflect（F33/F36）。solid待ちで止めず n≥1 も載せる",
      evidence: `point=${pointA}%`,
      priority: 1,
      cost: "free",
    });
    push({
      id: "aim_warm_before_press",
      failed_how: "押しの前に learn_warm／aim 再引きが無い学び方",
      better_how: "自動の学び方: warm印→aim有→押す。aim無の押しは学習成功と数えない",
      evidence: `aim有%=${aimA ?? 0}`,
      priority: 2,
      cost: "ext",
    });
  }

  // 近さ未達・短間隔大 → 間隔の学びを先に
  if (shortA != null && shortA > 12) {
    push({
      id: "gap_floor_before_nearness",
      failed_how: "近さ点だけ見て、動作間の間隔床を学ぶ順番が後",
      better_how: "短間隔%を先に潰す学び（gap floor厳守の自動走行）→その後で近さを測る",
      evidence: `短間隔${shortA}% 近さ${nearA ?? "?"}`,
      priority: 2,
      cost: "ext",
    });
  }

  // 効果が無いのにまた同じ flash → 1つずつ／効果確認後に再学習
  const pointDelta =
    pointA != null && pointB != null ? pointA - pointB : null;
  if (flash && pointDelta != null && pointDelta <= 0 && (pointA ?? 0) < pointOk) {
    push({
      id: "one_by_one_button",
      failed_how: "まとめて読んで効果が0（または下がった）",
      better_how: "ボタン／欄を1つずつ学び、1つごとに束反映→自動で効果を見る",
      evidence: `point ${pointB}→${pointA}（Δ${pointDelta}）`,
      priority: 1,
      cost: "flash",
    });
    push({
      id: "verify_then_relearn",
      failed_how: "効果確認前に次の学習へ進んだ",
      better_how: "verify（F31/F32・point・aim）で数字が出てから、残課題だけ再学習",
      evidence: `reflect_ok=${after.reflectOk ?? 0}`,
      priority: 0,
      cost: "free",
    });
  }

  // 読込は増えたが反映印なし
  if (readA >= 1 && (readB == null || readB < 1) && (Number(after.reflectOk) || 0) < 1) {
    push({
      id: "verify_then_relearn",
      failed_how: "拡張は読んだが反映印まで学びの成功条件にしていない",
      better_how: "学び成功の定義を reflect_ok≥1 かつ aim有≥1 に上げる",
      evidence: `read ${readB ?? 0}→${readA} reflect_ok=${after.reflectOk ?? 0}`,
      priority: 1,
      cost: "free",
    });
  }

  upgrades.sort((a, b) => a.priority - b.priority);
  const top = upgrades.slice(0, 5);
  const stillWeak =
    (pointA != null && pointA < pointOk)
    || (aimA != null && aimA < aimOk)
    || readA < 1
    || (shortA != null && shortA > 12)
    || (bn != null && bn <= 7)
    || unread > 50;
  const continue_loop = stillWeak || top.length > 0;

  const next_method_line = top.length
    ? `次の学び方: ${top.slice(0, 3).map((u) => u.better_how).join(" → ")}`
    : "次の学び方: 現行①〜⑤を維持（効果が出ている）";

  const line = top.length
    ? `学習方法の強化 ${top.length}件: ` + top.slice(0, 3).map((u) => u.failed_how).join("／")
      + (continue_loop ? " ／周回継続" : " ／一旦完了")
    : `学習方法の強化: 大きな修正なし` + (continue_loop ? "（まだ数値未達→周回）" : "／完了");

  const power_hint = top.length
    ? `学び方を効果で直す（${top.map((u) => u.id).slice(0, 3).join("・")}）`
    : "学び方は効果確認済み";

  return {
    upgrades: top,
    next_method_line,
    continue_loop,
    line,
    power_hint,
  };
}

/** サイト共通①〜⑤のあとに付ける「⑥学び方を効果で直してまた回す」 */
export const LEARN_METHOD_LOOP_STEP =
  "⑥効果を見て学習方法を直し、また①へ戻す（学び方の強化）";
