/**
 * サイト共通の学習・改善方法（2026-11-17）
 *
 * ★ 竹内さん「サイト別にこのような形でできるように／今はリアプロだが
 *   itandi改善するときもリアプロのように根本的に改善構築を理解できるように／
 *   学んだ学習方法や改善方法をitandiでも完全に活用できるようにする」:
 *
 *   【混ぜない物】DOM・路線名駅名・ボタン台帳・page-script（サイト専用）
 *   【共通にする物】学習の順番・弱所発見→通常から学ぶ→土台追加→束→拡張→自動→効果確認
 *
 * ⚠ 純関数。DBを触らない。
 */
import { ITANDI_BUTTONS } from "./itandi-buttons";
import { REALPRO_BUTTONS } from "./realpro-buttons";

export type LearnSite = "realpro" | "itandi";

/** リアプロで確立し、itandiでも同じ順番で回す学習方法 */
export const SITE_LEARN_METHOD_STEPS = [
  "①自動録画で弱い所を見つける（latest_auto_challenge）",
  "②通常録画の画像・操作から学ぶ（photo_learn・scene_flows・自動画像は手本にしない）",
  "③足りなければ土台を追加する（F番号・ボタン台帳・関所）",
  "④細部を直して再現（カーソル・押した位置・外し／選び）",
  "⑤束→拡張再読込→自動1回→効果確認（F32/F38/F46）",
  "⑥効果を見て学習方法を直し、また①へ戻す（学び方の強化・完全ループ）",
] as const;

export const SITE_LEARN_METHOD_LINE =
  "サイト共通の学習方法: "
  + SITE_LEARN_METHOD_STEPS.join(" → ")
  + "。DOM・路線駅名・ボタン台帳はサイト別、方法と関所の型は共通。";

export type SiteMethodParityInput = {
  /** supervisor_by_site に載っているサイト */
  sitesWithSupervisor?: string[] | null;
  /** サイト別の記録数 */
  rowsBySite?: Partial<Record<LearnSite, number>> | null;
  /** サイト別 vision 写真到達 */
  visionPhotoBySite?: Partial<Record<LearnSite, number>> | null;
  /** サイト別 通常未学習 */
  normalTodoBySite?: Partial<Record<LearnSite, number>> | null;
  realproButtonsN?: number;
  itandiButtonsN?: number;
};

export type SiteMethodParity = {
  ok: boolean;
  line: string;
  gaps: string[];
  counts: {
    sites_with_supervisor: number;
    realpro_rows: number;
    itandi_rows: number;
    realpro_buttons: number;
    itandi_buttons: number;
    realpro_vision_photo: number;
    itandi_vision_photo: number;
  };
  /** itandi に通常録画が足りない時の要求文 */
  itandi_record_ask: string | null;
};

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
}

/**
 * リアプロで回している型が itandi でも使える状態かを測る。
 * 完了線: 両サイトに統括あり・両台帳あり・方法が共通・itandiに最低限の通常材料があるか明示。
 */
export function measureSiteMethodParity(inp: SiteMethodParityInput = {}): SiteMethodParity {
  const sites = (inp.sitesWithSupervisor || []).map((s) => String(s).trim()).filter(Boolean);
  const hasRp = sites.includes("realpro");
  const hasIt = sites.includes("itandi");
  const rpBtn = n(inp.realproButtonsN) || REALPRO_BUTTONS.length;
  const itBtn = n(inp.itandiButtonsN) || ITANDI_BUTTONS.length;
  const rpRows = n(inp.rowsBySite?.realpro);
  const itRows = n(inp.rowsBySite?.itandi);
  const rpVis = n(inp.visionPhotoBySite?.realpro);
  const itVis = n(inp.visionPhotoBySite?.itandi);
  const itTodo = n(inp.normalTodoBySite?.itandi);

  const gaps: string[] = [];
  if (!hasRp) gaps.push("supervisor_by_site.realproが無い");
  if (!hasIt) gaps.push("supervisor_by_site.itandiが無い");
  if (rpBtn < 10) gaps.push("REALPRO_BUTTONSが薄い");
  if (itBtn < 10) gaps.push("ITANDI_BUTTONSが薄い");
  if (itRows < 30) gaps.push(`itandi記録が少ない（${itRows}件・完了線≥30）`);
  if (hasIt && itRows >= 30 && itVis <= 0 && itTodo <= 0) {
    gaps.push("itandiに写真材料が統括へ届いていない");
  }

  /** 型（台帳・サイト別統括）が揃っていれば方法の移植は可能。材料不足は別途要求。 */
  const structureOk = hasRp && hasIt && rpBtn >= 10 && itBtn >= 10;
  const materialOk = itRows >= 30;
  const ok = structureOk; // 材料不足でも「型はある」＝ok。gapsに材料を残す

  const itandi_record_ask = !materialOk
    ? "ITANDIを通常モードで検索1通し録画する（所在地→路線駅→条件→検索）。リアプロと同じ学習方法①〜⑤を回す材料にする"
    : (itTodo > 0
      ? `ITANDI通常の未学習${itTodo}枚をphoto_learnで読む（先にすでにある画像から）`
      : null);

  const line =
    `サイト学習方法の移植 統括サイト=${sites.length || 0}（RP${hasRp ? "✓" : "✗"}/IT${hasIt ? "✓" : "✗"}）`
    + ` 台帳 RP=${rpBtn} IT=${itBtn}`
    + ` 記録3日相当 RP=${rpRows} IT=${itRows}`
    + ` vision写真 RP=${rpVis} IT=${itVis}`
    + (gaps.length ? ` ／穴: ${gaps.slice(0, 3).join("・")}` : " ／型OK（方法は共通・DOMは別）")
    + `（完了線: 両サイト統括あり・両台帳≥10）`;

  return {
    ok,
    line,
    gaps,
    counts: {
      sites_with_supervisor: sites.length,
      realpro_rows: rpRows,
      itandi_rows: itRows,
      realpro_buttons: rpBtn,
      itandi_buttons: itBtn,
      realpro_vision_photo: rpVis,
      itandi_vision_photo: itVis,
    },
    itandi_record_ask,
  };
}

export function siteLearnMethodEvidence(site?: string | null): { label: string; value: string; guessed: boolean } {
  const s = String(site || "all");
  const focus = s === "itandi"
    ? "今はitandi。リアプロで確立した①〜⑤を同じ順番で回す。ITANDI_BUTTONS・ITANDI路線地図はitandi専用（混ぜない）"
    : s === "realpro"
      ? "今はリアプロ。確立した①〜⑤をitandiでも同じ型で使えるよう、方法と関所を共通化する"
      : "リアプロ／itandiとも同じ学習方法①〜⑤。台帳・DOM・路線駅名だけサイト別";
  return {
    label: "サイト共通の学習方法",
    value: `${SITE_LEARN_METHOD_LINE} ${focus}`,
    guessed: false,
  };
}
