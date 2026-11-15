/**
 * 通常モードと自動モードを**繰り返して**学習する（2026-11-15 竹内さん）
 *
 *   竹内さん「通常モードの録画でもちゃんと学習できるように 足りない部分強化できるように
 *     通常モードと自動モード繰りかえしていくようにして学習する
 *     そして学習の質も上げれるように設計知見強化する」
 *
 * ★ なぜ「繰り返す」のか
 *   1回の録画だけでは足りない（実測）:
 *     ・通常モードは操作の並び97%・カーソル94%だが、押した位置は74%
 *     ・自動モードは押した位置が **7%**（通常の1/10）
 *     ・`was`（選んだ/外した）は両方 0%（送る所で捨てていた・v2.7.81で修正）
 *
 *   ⚠ **1回直して終わりにしない**。直したら**また録画して数字を見る**。
 *     数字が動かなければ「直し方が違う」と分かる。これを回す。
 *
 * ★ この道具の役目
 *   ・**今どこが弱いか**を実測で出す（通常と自動を並べる）
 *   ・**次に何をすれば弱い所が埋まるか**を順番に出す（費用つき）
 *   ・**前回から良くなったか**を比べる（同じ指摘を繰り返さない）
 *
 * ⚠ 入れるのは数だけ（写真の中身・お客様の情報は入れない）。
 */

/** 1モードの状態 */
export type ModeState = {
  /** 記録の枚数 */
  rows: number;
  /** 操作の並びがある */
  withOps: number;
  /** カーソルが動いている */
  withCursor: number;
  /** 押した位置がある */
  withPoint: number;
  /** 写真から学習した */
  withLearn: number;
  /** 押す前の状態（was）がある */
  withWas: number;
  /** 機械の操作の数（自動モードだけ） */
  autoOps?: number;
  /** 人の操作の数（通常モードだけ） */
  humanOps?: number;
};

/** 比べた結果 */
export type RepeatReport = {
  normal: { pct: { ops: number; cursor: number; point: number; learn: number; was: number }; rows: number };
  auto: { pct: { ops: number; cursor: number; point: number; learn: number; was: number }; rows: number };
  /** ⚠ 自動モードが通常モードより大きく劣る所（差が30ポイント以上） */
  weak: Array<{ key: string; what: string; normal: number; auto: number; gap: number }>;
  /** 人が読む1行 */
  line: string;
};

const pctOf = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

/**
 * 通常モードと自動モードを比べる（純関数）。
 *   ⚠ 「自動モードが劣っている所」を**差の大きい順**に出す（そこが強化する所）。
 */
export function compareModes(normal: ModeState, auto: ModeState): RepeatReport {
  /**
   * ⚠ 壊れた入力（null・undefined）でも落ちないようにする（テストで発覚）。
   */
  const n0: ModeState = normal && typeof normal === "object" ? normal : { rows: 0, withOps: 0, withCursor: 0, withPoint: 0, withLearn: 0, withWas: 0 };
  const a0: ModeState = auto && typeof auto === "object" ? auto : { rows: 0, withOps: 0, withCursor: 0, withPoint: 0, withLearn: 0, withWas: 0 };
  const normalS = n0;
  const autoS = a0;
  const np = {
    ops: pctOf(normalS.withOps, normalS.rows),
    cursor: pctOf(normalS.withCursor, normalS.rows),
    point: pctOf(normalS.withPoint, normalS.rows),
    learn: pctOf(normalS.withLearn, normalS.rows),
    was: pctOf(normalS.withWas, normalS.rows),
  };
  const ap = {
    ops: pctOf(autoS.withOps, autoS.rows),
    cursor: pctOf(autoS.withCursor, autoS.rows),
    point: pctOf(autoS.withPoint, autoS.rows),
    learn: pctOf(autoS.withLearn, autoS.rows),
    was: pctOf(autoS.withWas, autoS.rows),
  };
  const LABEL: Record<string, string> = {
    ops: "操作の並び", cursor: "カーソルの動き", point: "押した位置", learn: "写真から学習", was: "選んだ/外した",
  };
  const weak: Array<{ key: string; what: string; normal: number; auto: number; gap: number }> = [];
  /**
   * ⚠ 比べるのは**両方に記録がある時だけ**（片方が0件だと差の意味が無い）。
   */
  if (normalS.rows > 0 && autoS.rows > 0) {
    for (const k of Object.keys(LABEL)) {
      const nv = np[k as keyof typeof np];
      const av = ap[k as keyof typeof ap];
      const gap = nv - av;
      if (gap >= 30) weak.push({ key: k, what: LABEL[k], normal: nv, auto: av, gap });
    }
    weak.sort((a, b) => b.gap - a.gap);
  }
  const parts: string[] = [];
  parts.push(`通常 ${normalS.rows}枚（操作${np.ops}%・カーソル${np.cursor}%・位置${np.point}%）`);
  parts.push(`自動 ${autoS.rows}枚（操作${ap.ops}%・カーソル${ap.cursor}%・位置${ap.point}%）`);
  if (weak.length) parts.push(`⚠ 自動が劣る ${weak.length}件（一番は「${weak[0].what}」${weak[0].normal}%→${weak[0].auto}%）`);
  else parts.push("大きな差なし");
  return { normal: { pct: np, rows: normalS.rows }, auto: { pct: ap, rows: autoS.rows }, weak, line: parts.join("／") };
}

/**
 * 「次にやる事」を順番に出す（統括が決める材料）。
 *   ⚠ 費用の安い順（0円が先）。
 *   ⚠ 各項目に「何%になれば効いたと言えるか」を付ける（効いたかを測れる形）。
 */
export function repeatTasks(r: RepeatReport): Array<{ key: string; what: string; why: string; how: string; cost: string; target: string }> {
  /**
   * ⚠ 壊れた入力（null）でも落ちないようにする（テストで発覚）。
   */
  if (!r || typeof r !== "object" || !r.normal || !r.auto) return [];
  const out: Array<{ key: string; what: string; why: string; how: string; cost: string; target: string }> = [];
  for (const w of r.weak) {
    if (w.key === "point") {
      out.push({
        key: "auto_point", what: "自動モードで押した位置が記録されていない",
        why: `通常 ${w.normal}% / 自動 ${w.auto}%`,
        how: "自動の時に「押した位置」を残す（pointer-ui の tap から記録へ）",
        cost: "0円", target: `自動を ${w.normal}% に近づける（まず50%以上）`,
      });
    } else if (w.key === "cursor") {
      out.push({
        key: "auto_cursor", what: "自動モードでカーソルの動きが記録されていない",
        why: `通常 ${w.normal}% / 自動 ${w.auto}%`,
        how: "押す前にカーソルを動かす（mousemove を出す）",
        cost: "0円", target: `自動を ${w.normal}% に近づける（まず50%以上）`,
      });
    } else if (w.key === "was") {
      out.push({
        key: "was", what: "「選んだ/外した」が記録されていない",
        why: `通常 ${w.normal}% / 自動 ${w.auto}%`,
        how: "押す前の checked を送る（v2.7.81 で修正済み・録画し直して確かめる）",
        cost: "0円", target: "50%以上",
      });
    } else if (w.key === "learn") {
      out.push({
        key: "learn", what: "写真から学習できていない",
        why: `通常 ${w.normal}% / 自動 ${w.auto}%`,
        how: "写真から学ぶを回す（同じ画面は1枚・読める大きさだけ）",
        cost: "1枚0.17円", target: "80%以上",
      });
    } else if (w.key === "ops") {
      out.push({
        key: "ops", what: "操作の並びが記録されていない",
        why: `通常 ${w.normal}% / 自動 ${w.auto}%`,
        how: "記録の経路を確かめる（`shot_ops` が届いているか）",
        cost: "0円", target: "90%以上",
      });
    }
  }
  // 差は小さいが絶対に低い物（両方とも低い）
  if (r.normal.pct.learn < 50 || r.auto.pct.learn < 50) {
    if (!out.some((x) => x.key === "learn")) {
      out.push({
        key: "learn_all", what: "写真から学習できている枚数が少ない",
        why: `通常 ${r.normal.pct.learn}% / 自動 ${r.auto.pct.learn}%`,
        how: "写真から学ぶを回す（同じ画面は1枚・読める大きさだけ）",
        cost: "1枚0.17円", target: "80%以上",
      });
    }
  }
  return out;
}

/**
 * ★ 2026-11-15「学習の質も上げられるように」: **1枚あたり何個の欄を読めたか**。
 *   ⚠ 枚数だけ増えても中身が薄ければ意味がない（実測: 通常は1枚19.7個）。
 */
export function learnQuality(rows: ReadonlyArray<{ learned: boolean; fields: number; shot_w: number }>): {
  learnedN: number;
  total: number;
  fields: number;
  perShot: number;
  emptyShots: number;
  bigShots: number;
  line: string;
} {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === "object");
  const learned = list.filter((r) => r.learned);
  const fields = learned.reduce((s, r) => s + (Number(r.fields) || 0), 0);
  const emptyShots = learned.filter((r) => (Number(r.fields) || 0) === 0).length;
  const bigShots = list.filter((r) => Number(r.shot_w) >= 800).length;
  const perShot = learned.length ? Math.round((fields / learned.length) * 10) / 10 : 0;
  const parts: string[] = [];
  parts.push(`学習 ${learned.length}/${list.length}枚・欄 ${fields}個・1枚 ${perShot}個`);
  if (emptyShots > 0) parts.push(`⚠ 読んだのに欄0が ${emptyShots}枚`);
  if (list.length > 0 && bigShots / list.length < 0.5) parts.push(`⚠ 大きい写真が少ない（${bigShots}/${list.length}）`);
  return { learnedN: learned.length, total: list.length, fields, perShot, emptyShots, bigShots, line: parts.join("／") };
}
