/**
 * 弱い部分を画像から徹底学習→強化し続ける仕組み（2026-11-16 竹内さん）
 *
 *   「統括の部分画像から学習して弱い部分を徹底的に改善し
 *    弱い部分を強化していく仕組みもあわせてつくるようにする」
 *   「1つずつリアプロのボタンのことを理解すればより強化する／
 *    1つずつそれぞれ強化するようにする」
 *
 * ★ 一連（弱さが残る限り回す）
 *   1. 弱い欄・ボタンを特定 → **1つずつ**順に
 *   2. その1つだけ通常画像から photo_learn（位置・押し方・種類）
 *   3. 全部の1つずつのあと束へ反映（reflect）
 *   4. 拡張が読む → 自動1回 → 効果確認
 *   5. まだ弱ければ 1 へ戻す
 *
 * ⚠ 純関数。DBに書かない・Visionを呼ばない。実行は scripts/weak-strengthen.ts。
 */
import { photoLearnLimitFor } from "./shot-learn-limit";
import { ensureStrengthenAfterLearn, type ImproveTask } from "./improve-loop";
import {
  catalogTargetsOnly,
  preferKnownWeakTargets,
  type ButtonCatalogSite,
} from "./button-catalog-targets";
import { orderItandiButtonsOneByOne, itandiButtonLabel } from "./itandi-buttons";
import { orderRealproButtonsOneByOne, realproButtonLabel } from "./realpro-buttons";

export type WeakStrengthenInput = {
  /** 欄×観点で弱い欄（score < 度） */
  weakFields?: string[];
  /** 最新自動の課題欄 */
  challengeFields?: string[];
  /** 弱点原子の id（point_pct / hand_cs / field:route_id 等） */
  atoms?: string[];
  /** 通常モードの未学習枚数 */
  unreadNormal?: number;
  /** 改善一連の停止段階（1〜6） */
  bottleneck_n?: number | null;
  /** 押した位置％（再現） */
  pointPct?: number | null;
  /** 何周目か（ログ用・省略可） */
  round?: number;
  /**
   * true（既定）: リアプロのボタン／欄を **1つずつ** photo_learn する。
   * false: 旧どおりまとめて1回。
   */
  oneByOne?: boolean;
  /** 1ボタンあたりの画像枚数上限（省略時は統括limitを分割） */
  perButtonLimit?: number;
  /**
   * ★ 2026-11-17: サイト別台帳（realpro / itandi）。混ぜない。
   *   既定 realpro。
   */
  site?: ButtonCatalogSite;
};

export type WeakStrengthenPlan = {
  /** 今回の強化対象欄（弱い＋課題を合流・1つずつ順） */
  targets: string[];
  atoms: string[];
  round: number;
  /** 実行順の課題（photo_learn が対象ごとに分かれる） */
  cycle: ImproveTask[];
  /** 1行サマリ */
  line: string;
  /** 弱さが残っているのでまた回す必要があるか */
  continue_loop: boolean;
  /** 1つずつモードか */
  one_by_one: boolean;
};

function uniq(xs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of xs) {
    const s = String(x || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * 弱い部分の強化サイクルを組む。
 *   既定はリアプロのボタン／欄を **1つずつ** 理解して強化する。
 */
export function buildWeakStrengthenPlan(inp: WeakStrengthenInput): WeakStrengthenPlan {
  const oneByOne = inp.oneByOne !== false;
  const site: ButtonCatalogSite = inp.site === "itandi" ? "itandi" : "realpro";
  const siteJa = site === "itandi" ? "ITANDI" : "リアプロ";
  const weak = uniq(inp.weakFields || []);
  const challenge = uniq(inp.challengeFields || []);
  const atoms = uniq(inp.atoms || []);
  /**
   * ★ 土台: 台帳正名だけ残す（1DK・区名単体・路線名の生値は欄に写すか落とす）。
   *   実測の弱い欄（駅・間取・区）を先頭に優先。
   */
  const cataloged = catalogTargetsOnly([...weak, ...challenge], site);
  const preferred = preferKnownWeakTargets(cataloged, site);
  const ordered =
    oneByOne
      ? (site === "itandi" ? orderItandiButtonsOneByOne(preferred) : orderRealproButtonsOneByOne(preferred))
      : preferred;
  const targets = ordered.slice(0, 12);
  const unread = Math.max(0, Number(inp.unreadNormal) || 0);
  const bn = inp.bottleneck_n ?? null;
  const round = Math.max(1, Number(inp.round) || 1);
  const pointPct = inp.pointPct == null ? null : Number(inp.pointPct);

  const cycle: ImproveTask[] = [];
  const needPhoto =
    unread > 0 &&
    (targets.length > 0 ||
      atoms.some((a) => /point_pct|field:|hand_cs|fine_avg/.test(a)) ||
      (pointPct != null && pointPct < 60));

  if (needPhoto && targets.length > 0 && oneByOne) {
    const totalBudget = photoLearnLimitFor({
      todo: unread,
      fieldCount: targets.length,
    });
    const per =
      Math.max(4, Math.min(
        Number(inp.perButtonLimit) || Math.ceil(totalBudget / targets.length),
        15,
      ));
    targets.forEach((id, i) => {
      const label = site === "itandi" ? itandiButtonLabel(id) : realproButtonLabel(id);
      cycle.push({
        kind: "photo_learn",
        what: `${siteJa}「${label}」を1つ理解して強化する（${i + 1}/${targets.length}）`,
        why: `周回${round}・1つずつ／台帳正名のみ／このボタンだけ位置・押し方・種類を学ぶ／未学習通常 ${unread}枚`,
        cost: "1枚ごとに Vision の費用（枚数は統括が課題に応じて決める）",
        limit: per,
        order: "newest",
        fields: [id],
      });
    });
  } else if (needPhoto) {
    const whyBits = [
      `周回${round}`,
      targets.length ? `対象: ${targets.slice(0, 6).join("・")}` : "弱い原子・位置%から",
      unread ? `未学習通常 ${unread}枚` : null,
      atoms.length ? `原子: ${atoms.slice(0, 4).join("・")}` : null,
      pointPct != null && pointPct < 60 ? `押した位置${pointPct}%（要≥60）` : null,
    ].filter(Boolean);
    cycle.push({
      kind: "photo_learn",
      what: targets.length
        ? "弱い欄を通常画像から徹底学習する（位置・押し方・観点）"
        : "弱い原子・位置不足を通常画像から徹底学習する",
      why: whyBits.join("／"),
      cost: "1枚ごとに Vision の費用（枚数は統括が課題に応じて決める）",
      limit: photoLearnLimitFor({
        todo: unread,
        fieldCount: Math.max(targets.length, atoms.length || 1),
      }),
      order: "newest",
      ...(targets.length ? { fields: targets.slice(0, 8) } : {}),
    });
  }

  // 学んだら強化の続きを必ず付ける（1つずつの photo_learn のあとに1回だけ）
  let withStrengthen = ensureStrengthenAfterLearn(cycle, { bottleneck_n: bn });

  if (!withStrengthen.length) {
    if (bn === 5) {
      withStrengthen = ensureStrengthenAfterLearn(
        [{
          kind: "need_auto_run",
          what: "自動モードで1回検索する（弱い部分強化の効果を見る）",
          why: "束は読めた。自動で使わないと弱さの改善を測れない",
          cost: "無料（人の手間だけ）",
        }],
        { bottleneck_n: 5 },
      );
    } else if (targets.length > 0) {
      withStrengthen = [{
        kind: "verify_improve",
        what: "弱い欄が残っていないか数字で確かめる",
        why: `対象: ${targets.slice(0, 5).join("・")}／未学習0または段階完了寄り`,
        cost: "無料",
      }];
    }
  }

  const continue_loop =
    targets.length > 0 ||
    atoms.length > 0 ||
    (pointPct != null && pointPct < 60) ||
    (bn != null && bn < 6) ||
    withStrengthen.some((t) => t.kind === "photo_learn");

  const photoN = withStrengthen.filter((t) => t.kind === "photo_learn").length;
  const line =
    `弱い強化 周回${round}: ${oneByOne ? "1つずつ" : "まとめて"}${targets.length}欄` +
    (photoN > 1 ? `（photo×${photoN}）` : "") +
    (atoms.length ? `・原子${atoms.length}` : "") +
    ` → ${withStrengthen.map((t) => t.kind).join("→") || "なし"}` +
    (continue_loop ? " ／弱さ残→また回す" : " ／一旦完了線");

  return {
    targets,
    atoms,
    round,
    cycle: withStrengthen,
    line,
    continue_loop,
    one_by_one: oneByOne,
  };
}
