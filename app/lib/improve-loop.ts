/**
 * 弱い所の学習 → 自動改善につながるまでの一連（2026-11-15 竹内さん）
 *
 *   「ここの改善につながるまで一連の流れをちゃんと統括はできるようにする」
 *
 * ★ なぜ要るか（実測）
 *   画像学習・束の画面位置（n≥3 52欄・課題欄も束にある）まで進んでも、
 *   read_count=0 のまま → 自動は改善されない。
 *   統括が「もっと画像を読め」だけ出して、**改善までの残り段階を課題にしなかった**。
 *
 * ★ 一連（番号つき）
 *   1〜5: 学習→自動の連携（`buildLinkPipeline`）
 *   6: 効果確認（最新自動に課題欄が残っていない／減っている）
 *
 * ⚠ 純関数。拡張の再読み込み・自動走行は人がやる（統括は次の一手を名指しする）。
 */
import { buildLinkPipeline, type BundleReflectHint, type LinkPipeline, type LinkStep } from "./bundle-reflect";
import { photoLearnLimitFor } from "./shot-learn-limit";

export type ImproveLoop = LinkPipeline & {
  /** 改善までの全体行 */
  improve_line: string;
  /** 次にやる段階（1〜6） */
  next_n: number | null;
  /** 次にやる課題の種類 */
  next_kind: ImproveTaskKind | null;
};

export type ImproveTaskKind =
  | "photo_learn"
  | "reflect_auto"
  | "need_ext_reload"
  | "need_auto_run"
  | "verify_improve";

export type ImproveTask = {
  kind: ImproveTaskKind;
  what: string;
  why: string;
  cost: string;
  limit?: number;
  order?: "newest" | "time" | "size" | "sequence";
  fields?: string[];
};

/**
 * 一連の流れ（1〜6）を作る。
 *   step6: 拡張が読み・自動が走ったうえで、最新課題欄が空（または減った）か。
 */
export function buildImproveLoop(opt: {
  photoInStorage: number;
  withOps: number;
  screenSolid: number;
  screenAll: number;
  hint: BundleReflectHint;
  /** 最新自動の課題欄（空なら効果あり／未走行なら測れない） */
  challengeFields?: string[];
  /** 課題を測れる状態か（自動が新束のあと走った） */
  canMeasure?: boolean;
}): ImproveLoop {
  const base = buildLinkPipeline({
    photoInStorage: opt.photoInStorage,
    withOps: opt.withOps,
    screenSolid: opt.screenSolid,
    screenAll: opt.screenAll,
    hint: opt.hint,
  });
  const fields = Array.isArray(opt.challengeFields) ? opt.challengeFields.filter(Boolean) : [];
  const canMeasure = opt.canMeasure === true
    || (opt.hint.read_count > 0 && opt.hint.auto_after === true);
  const step6ok = canMeasure && fields.length === 0;
  const step6: LinkStep = {
    n: 6,
    name: "効果確認",
    ok: step6ok,
    detail: !canMeasure
      ? "まだ測れない（拡張が読む→自動1回のあと数字で見る）"
      : (fields.length
        ? `まだ課題あり: ${fields.slice(0, 5).join("・")}`
        : "最新自動に押さず変化・押し直しなし（改善が見える）"),
  };
  const steps = [...base.steps, step6];
  const stuck = steps.find((s) => !s.ok) || null;
  const line = steps.map((s) => `${s.n}.${s.name}${s.ok ? "✓" : "✗"}`).join(" → ")
    + (stuck ? ` ／止: ${stuck.n}.${stuck.name}（${stuck.detail}）` : " ／改善まで完了");

  let next_kind: ImproveTaskKind | null = null;
  if (stuck) {
    if (stuck.n <= 3) next_kind = opt.screenSolid < 3 ? "photo_learn" : "reflect_auto";
    else if (stuck.n === 4) next_kind = "need_ext_reload";
    else if (stuck.n === 5) next_kind = "need_auto_run";
    else if (stuck.n === 6) next_kind = fields.length ? "photo_learn" : "verify_improve";
  }

  return {
    steps,
    bottleneck_n: stuck ? stuck.n : null,
    bottleneck: stuck ? `${stuck.n}.${stuck.name}: ${stuck.detail}` : null,
    line: base.line,
    improve_line: line,
    next_n: stuck ? stuck.n : null,
    next_kind,
  };
}

/**
 * 止まっている所から、改善につながる課題を順番に出す。
 *   ⚠ 段階4で止まっているのに photo_learn だけ出さない（学習しても自動に届かない）。
 */
export function improveLoopTasks(opt: {
  loop: ImproveLoop;
  unreadNormal?: number;
  challengeFields?: string[];
  preferNewest?: boolean;
  /** 課題欄のうち、束に x/y がまだ無いもの（学習したのに更新漏れ） */
  missingInBundle?: string[];
}): ImproveTask[] {
  const tasks: ImproveTask[] = [];
  const n = opt.loop.bottleneck_n;
  const fields = (opt.challengeFields || []).slice(0, 8);
  const unread = Math.max(0, Number(opt.unreadNormal) || 0);
  const missing = (opt.missingInBundle || []).filter(Boolean).slice(0, 8);

  // 段階3未満: 束の位置が足りない → 読む／束作り直し
  if (n != null && n <= 3) {
    if (unread > 0) {
      tasks.push({
        kind: "photo_learn",
        what: fields.length
          ? "自動の課題欄を、通常モードの最新画像から読む"
          : "通常モードの画像を読んで画面位置を増やす",
        why: `段階${n}で停止／未学習 ${unread}枚${fields.length ? `／課題 ${fields.slice(0, 4).join("・")}` : ""}`,
        cost: "1枚ごとに Vision の費用（枚数は統括が課題に応じて決める）",
        limit: photoLearnLimitFor({ todo: unread, fieldCount: fields.length }),
        order: opt.preferNewest !== false ? "newest" : "time",
        ...(fields.length ? { fields } : {}),
      });
    }
    tasks.push({
      kind: "reflect_auto",
      what: "学んだ位置を束に載せ直し、反映状態を確かめる",
      why: opt.loop.bottleneck || "束→拡張の手前を確かめる",
      cost: "無料",
    });
  }

  /**
   * ★ 2026-11-15「画像から学習した部分はちゃんと改善して更新」:
   *   全体の段階が4でも、課題欄が束に載っていなければ先に読む／束を更新する。
   *   （拡張に渡しても課題欄が無いと改善にならない）
   */
  if ((n === 4 || n === 5) && missing.length && unread > 0) {
    tasks.push({
      kind: "photo_learn",
      what: "課題なのに束に位置が無い欄を、通常の最新画像から読んで更新する",
      why: `束に未反映: ${missing.slice(0, 5).join("・")}／未学習 ${unread}枚`,
      cost: "1枚ごとに Vision の費用（枚数は統括が課題に応じて決める）",
      limit: photoLearnLimitFor({ todo: unread, fieldCount: missing.length }),
      order: "newest",
      fields: missing,
    });
    tasks.push({
      kind: "reflect_auto",
      what: "課題欄の位置を束に載せ直す",
      why: "画像から読んだ位置を更新してから拡張へ渡す",
      cost: "無料",
    });
  }

  // 段階4: 拡張が読んでいない → 人が再読み込み（学習を足しても改善に繋がらない）
  if (n === 4) {
    tasks.push({
      kind: "need_ext_reload",
      what: "拡張を再読み込みして、最新の束を取り直す（連携完了まで）",
      why: opt.loop.bottleneck || "read_count=0。学んだ画面位置が拡張に届いていないので自動は改善されない",
      cost: "無料（人の手間だけ）",
    });
    tasks.push({
      kind: "reflect_auto",
      what: "拡張が束を読んだか数字で確かめる",
      why: "再読み込みのあと read_count が増えたかを見る",
      cost: "無料",
    });
  }

  // 段階5: 読めたが自動未走行
  if (n === 5) {
    tasks.push({
      kind: "need_auto_run",
      what: "自動モードで1回検索する（新学びが効いているか確かめる）",
      why: opt.loop.bottleneck || "拡張は読んだが、新束のあとの自動走行が無い",
      cost: "無料（人の手間だけ）",
    });
    /**
     * ★ 2026-11-16「弱い部分再び改善／学んだ部分も学習していく」:
     *   自動待ちの間も、課題欄・弱い原子の再学習を止めない（一度読んで終わりにしない）。
     */
    if (unread > 0) {
      const reFields = (fields.length ? fields : missing).slice(0, 8);
      tasks.push({
        kind: "photo_learn",
        what: reFields.length
          ? "弱い欄を通常の最新画像から再強化する（学んだ欄の再学習）"
          : "段階5待ちでも通常画像を読んで強化を続ける",
        why: reFields.length
          ? `段階5待ちでも細かく強化を続ける／対象: ${reFields.slice(0, 5).join("・")}／未学習 ${unread}枚`
          : `段階5・未学習 ${unread}枚（欄が空でも読む課題を止めない）`,
        cost: "1枚ごとに Vision の費用（枚数は統括が課題に応じて決める）",
        limit: photoLearnLimitFor({ todo: unread, fieldCount: reFields.length || 3 }),
        order: "newest",
        ...(reFields.length ? { fields: reFields } : {}),
      });
      tasks.push({
        kind: "reflect_auto",
        what: "再強化した位置を束に載せ直す",
        why: "再学習したら即束へ反映し、自動1回の材料にする",
        cost: "無料",
      });
    }
  }

  // 段階6: 効果確認／まだ課題あり
  if (n === 6 || (n == null && fields.length > 0)) {
    tasks.push({
      kind: "verify_improve",
      what: "最新の自動録画で、課題欄が減ったか数字で確かめる",
      why: fields.length
        ? `まだ課題: ${fields.slice(0, 5).join("・")}`
        : "自動走行後の課題を数える",
      cost: "無料",
    });
    if (fields.length && unread > 0) {
      tasks.push({
        kind: "photo_learn",
        what: "残った課題欄を、通常モードの最新画像から補強する",
        why: `効果確認で残った欄: ${fields.slice(0, 5).join("・")}`,
        cost: "1枚ごとに Vision の費用（枚数は統括が課題に応じて決める）",
        limit: photoLearnLimitFor({ todo: unread, fieldCount: fields.length }),
        order: "newest",
        fields,
      });
    }
  }

  // 全部 OK でも、念のため反映を一度言えるようにする（空でもよい）
  if (n == null && !tasks.length) {
    tasks.push({
      kind: "verify_improve",
      what: "改善までの一連が完了しているか、もう一度数字で確かめる",
      why: opt.loop.improve_line || "連携・効果とも ✓",
      cost: "無料",
    });
  }

  /**
   * ★ 2026-11-16 竹内さん「学んだら強化していくように／そういう仕組みをつくっていくように」:
   *   読む課題だけ出して終わらせない。学んだあとは必ず強化の続きを付ける。
   */
  return ensureStrengthenAfterLearn(tasks, { bottleneck_n: n });
}

/**
 * 学んだら強化（仕組み）: `photo_learn` のあとに強化の続きを必ず付ける。
 *   反映 →（段階に応じて）拡張再読込 → 自動1回 → 効果確認
 *   ⚠ 学んだだけで課題リストが終わるのを防ぐ（純関数）。
 */
export function ensureStrengthenAfterLearn(
  tasks: ImproveTask[],
  opt?: { bottleneck_n?: number | null },
): ImproveTask[] {
  const list = Array.isArray(tasks) ? [...tasks] : [];
  const has = (k: ImproveTaskKind) => list.some((t) => t && t.kind === k);
  if (!has("photo_learn")) return list;

  const bn = opt?.bottleneck_n ?? null;
  const pushIf = (t: ImproveTask) => {
    if (!has(t.kind)) list.push(t);
  };

  pushIf({
    kind: "reflect_auto",
    what: "学んだ内容を束に載せ直し、反映状態を確かめる（学んだら強化）",
    why: "読んだだけで終わらせない。束→拡張へ渡す手前まで進める",
    cost: "無料",
  });
  if (bn == null || bn === 4 || bn <= 3) {
    pushIf({
      kind: "need_ext_reload",
      what: "拡張を再読み込みして、学んだ束を取り直す（学んだら強化）",
      why: "学んでも拡張が読まないと自動は強化されない",
      cost: "無料（人の手間だけ）",
    });
  }
  if (bn == null || bn === 4 || bn === 5 || bn <= 3) {
    pushIf({
      kind: "need_auto_run",
      what: "自動モードで1回検索する（学んだら強化・効果を見る）",
      why: "束を読んだあとに自動で使い、強化できたかを測る",
      cost: "無料（人の手間だけ）",
    });
  }
  pushIf({
    kind: "verify_improve",
    what: "最新自動で課題が減ったか数字で確かめる（学んだら強化・完了判定）",
    why: "強化できたかは数字で見る。推測で終わらせない",
    cost: "無料",
  });
  return list;
}
