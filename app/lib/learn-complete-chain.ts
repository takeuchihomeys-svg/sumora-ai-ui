/**
 * 学習期間・土台・つながり・一連の完成線（2026-11-18 竹内さん）
 *
 *   「学習期間／土台とつながりと一連の動きを完成させる／統括Pro」
 *
 * ★ 4本柱（全部✓で完成）
 *   1. 学習期間 … materials 窓で動き・監査・写真が揃う
 *   2. 土台 … 主要F（F1/F6/F31/F32/F33/F34）が測れ・欠が名指し
 *   3. つながり … 束→拡張読込→自動使用の連携段
 *   4. 一連 … improve_loop 1〜6（学習→反映→効果）
 *
 * ⚠ 純関数。
 */

import { buildLearnPeriodConstruct, type LearnPeriodConstructInput } from "./learn-period-construct";

export type CompletePillar = {
  id: "period" | "foundation" | "link" | "series";
  name: string;
  ok: boolean;
  line: string;
  next: string;
};

export type LearnCompleteChainReport = {
  pillars: CompletePillar[];
  ok: boolean;
  done_n: number;
  total_n: number;
  bottleneck: string | null;
  line: string;
  next_line: string;
  path_to_complete: string;
};

export type LearnCompleteChainInput = {
  period?: LearnPeriodConstructInput | null;
  /** 土台 */
  foundationMissingN?: number | null;
  foundationOkN?: number | null;
  foundationTotalN?: number | null;
  keyFoundationFails?: string[] | null;
  /** つながり（F32 / bundleReflect） */
  linkBottleneckN?: number | null;
  linkLine?: string | null;
  readCount?: number | null;
  autoAfter?: boolean | null;
  screenSolid?: number | null;
  /** 一連（improve_loop） */
  improveBottleneckN?: number | null;
  improveLine?: string | null;
};

/**
 * 4本柱の完成度を測る。
 */
export function buildLearnCompleteChain(inp: LearnCompleteChainInput): LearnCompleteChainReport {
  const period = buildLearnPeriodConstruct(inp.period || {});
  const periodOk = period.gaps.filter((g) => g.facet === "period").length === 0
    && period.construct_marks.find((m) => m.id === "period_aligned")?.ok !== false;

  const missF = Number(inp.foundationMissingN);
  const okF = Number(inp.foundationOkN);
  const totF = Number(inp.foundationTotalN);
  const keyFails = (inp.keyFoundationFails || []).filter(Boolean);
  const foundationOk = Number.isFinite(missF)
    ? missF === 0 || (keyFails.length === 0 && missF < 5)
    : false;
  const foundationLine = Number.isFinite(totF)
    ? `土台 ${Number.isFinite(okF) ? okF : "?"}/${totF} ✓／欠${Number.isFinite(missF) ? missF : "?"}${keyFails.length ? `／重要欠:${keyFails.slice(0, 4).join("・")}` : ""}`
    : `土台 未測${keyFails.length ? `／重要欠:${keyFails.slice(0, 4).join("・")}` : ""}`;

  const solid = Number(inp.screenSolid);
  const read = Number(inp.readCount);
  const linkBn = inp.linkBottleneckN ?? null;
  const linkOk = linkBn == null
    && (!(Number.isFinite(solid) && solid < 30))
    && (inp.autoAfter === true || (Number.isFinite(read) && read >= 1 && inp.autoAfter !== false));
  // より厳密: solid≥30 かつ read≥1 かつ auto_after
  const linkStrictOk = (Number.isFinite(solid) ? solid >= 30 : false)
    && (Number.isFinite(read) ? read >= 1 : false)
    && inp.autoAfter === true;
  const linkDone = linkStrictOk || (linkOk && linkBn == null && Number.isFinite(solid) && solid >= 30);
  const linkLine = inp.linkLine
    || `連携 solid=${Number.isFinite(solid) ? solid : "?"} read=${Number.isFinite(read) ? read : "?"} auto=${inp.autoAfter === true ? "✓" : inp.autoAfter === false ? "✗" : "?"} bn=${linkBn ?? "無"}`;

  const impBn = inp.improveBottleneckN ?? null;
  const seriesOk = impBn == null;
  const seriesLine = inp.improveLine
    || (impBn != null ? `一連 止=段階${impBn}` : "一連 完了/未測");

  const pillars: CompletePillar[] = [
    {
      id: "period",
      name: "学習期間",
      ok: periodOk,
      line: period.line,
      next: periodOk ? "維持（材料3日で揃え）" : period.next_line,
    },
    {
      id: "foundation",
      name: "土台",
      ok: foundationOk && Number.isFinite(totF) && totF > 0,
      line: foundationLine,
      next: keyFails[0]
        ? `重要欠 ${keyFails[0]} を完了線まで埋める`
        : (missF > 0 ? `欠${missF}を上から1本` : "foundation-audit を載せる"),
    },
    {
      id: "link",
      name: "つながり",
      ok: linkDone,
      line: linkLine,
      next: Number.isFinite(solid) && solid < 30
        ? "画面位置 solid を履歴から復元（F1/F33）"
        : (Number.isFinite(read) && read < 1
          ? "拡張再読込で束を読む（read_count）"
          : (inp.autoAfter !== true ? "自動1回（F6）" : "連携段を再測")),
    },
    {
      id: "series",
      name: "一連の動き",
      ok: seriesOk && !!inp.improveLine,
      line: seriesLine,
      next: impBn != null
        ? `improve_loop 段階${impBn}の次手（photo_learn/再読込/自動/効果）`
        : "一連の印を束に載せる",
    },
  ];

  const done_n = pillars.filter((p) => p.ok).length;
  const total_n = pillars.length;
  const ok = done_n === total_n;
  const stuck = pillars.find((p) => !p.ok) || null;
  const bottleneck = stuck ? `${stuck.name}: ${stuck.line}` : null;
  const line = ok
    ? `学習完成: 期間・土台・つながり・一連 すべて✓（${done_n}/${total_n}）`
    : `学習完成: ${done_n}/${total_n} ✓／止=${stuck?.name}／${stuck?.line || ""}`;
  const next_line = stuck?.next || "維持: 4本柱を毎回測る";
  const path_to_complete = pillars
    .filter((p) => !p.ok)
    .map((p, i) => `${i + 1}.${p.name}:${p.next}`)
    .join(" → ")
    || "完成済み→自動1回で効果確認のみ";

  return {
    pillars,
    ok,
    done_n,
    total_n,
    bottleneck,
    line,
    next_line,
    path_to_complete,
  };
}
