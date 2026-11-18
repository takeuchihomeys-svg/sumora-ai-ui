/**
 * 学習期間・学習構築の細部関所（2026-11-18 竹内さん）
 *
 *   「学習期間学習の構築部分にぬけのないように徹底した細部へのこだわりが必要」
 *
 * ★ なぜ要るか
 *   期間が揃っていても、土台点検・RAGログ・F番号が別窓だと Pro が誤判断する。
 *   構築（課題関所・solid復元・反映一連）も期間と同じ正本で測る。
 *
 * ⚠ 純関数。
 */

import { DAY_MS, LEARN_PERIODS, periodLabelJa } from "./learn-periods";

export type PeriodAlignGap = {
  id: string;
  what: string;
  expected: string;
  actual: string;
  how: string;
  facet: "period" | "construct" | "detail";
};

export type LearnPeriodConstructReport = {
  periods: {
    materials: string;
    commands: string;
    history: string;
    bundleFresh: string;
    foundationOps: string;
    foundationAudit: string;
    normalFresh: string;
    logMemory: string;
  };
  gaps: PeriodAlignGap[];
  /** 構築細部の完了線 */
  construct_marks: Array<{ id: string; ok: boolean; line: string }>;
  line: string;
  next_line: string;
};

export type LearnPeriodConstructInput = {
  /** 呼び出し側が使っている日数（実測） */
  used?: {
    daysOps?: number | null;
    daysAudit?: number | null;
    shotLearnDays?: number | null;
    auditWindowMs?: number | null;
    logMemoryDays?: number | null;
    commandsDays?: number | null;
  } | null;
  /** 構築印 */
  screenSolid?: number | null;
  photoLearnTask?: boolean | null;
  unreadNormal?: number | null;
  autoAfter?: boolean | null;
  readCount?: number | null;
  reflectOk?: number | null;
  kbProLinkOk?: boolean | null;
  fineLearnAvg?: number | null;
};

/** 正本から日数（端数切り上げしない・割り切れる前提） */
export function learnPeriodDays(key: keyof typeof LEARN_PERIODS): number {
  const ms = LEARN_PERIODS[key];
  return Math.round(ms / DAY_MS);
}

/**
 * 学習期間・構築の細部抜けを測る。
 */
export function buildLearnPeriodConstruct(inp: LearnPeriodConstructInput = {}): LearnPeriodConstructReport {
  const matDays = learnPeriodDays("materialsMs");
  const cmdDays = learnPeriodDays("commandsMs");
  const histDays = learnPeriodDays("historyMs");
  const used = inp.used || {};
  const gaps: PeriodAlignGap[] = [];
  const push = (g: PeriodAlignGap) => {
    if (gaps.some((x) => x.id === g.id)) return;
    gaps.push(g);
  };

  if (used.daysOps != null && used.daysOps !== matDays) {
    push({
      id: "ops_window",
      what: "動き（ops）の点検窓が材料期間と違う",
      expected: `${matDays}日`,
      actual: `${used.daysOps}日`,
      how: "foundation-audit / 呼び出しを LEARN_PERIODS.materialsMs に揃える",
      facet: "period",
    });
  }
  if (used.daysAudit != null && used.daysAudit !== matDays) {
    push({
      id: "audit_window",
      what: "監査の点検窓が材料期間と違う",
      expected: `${matDays}日`,
      actual: `${used.daysAudit}日`,
      how: "daysAudit を materials と同じ日数にする（別窓禁止）",
      facet: "period",
    });
  }
  if (used.shotLearnDays != null && used.shotLearnDays !== matDays) {
    push({
      id: "shot_window",
      what: "写真学習の窓が材料期間と違う",
      expected: `${matDays}日`,
      actual: `${used.shotLearnDays}日`,
      how: "shot_learn / human-learn-profile の写真窓を materials に揃える",
      facet: "period",
    });
  }
  if (used.commandsDays != null && used.commandsDays !== cmdDays) {
    push({
      id: "cmd_window",
      what: "指示の見張り窓が正本と違う",
      expected: `${cmdDays}日`,
      actual: `${used.commandsDays}日`,
      how: "commandsMs 正本に揃える",
      facet: "period",
    });
  }
  if (used.logMemoryDays != null && used.logMemoryDays > histDays) {
    push({
      id: "log_too_wide",
      what: "統括ログ記憶が履歴枠より広い",
      expected: `≤${histDays}日`,
      actual: `${used.logMemoryDays}日`,
      how: "log_memory は historyMs 以内",
      facet: "period",
    });
  }
  if (used.auditWindowMs != null && used.auditWindowMs !== LEARN_PERIODS.materialsMs) {
    push({
      id: "audit_ms",
      what: "監査集計 sinceMs が materialsMs と違う",
      expected: periodLabelJa(LEARN_PERIODS.materialsMs),
      actual: periodLabelJa(used.auditWindowMs),
      how: "summarizeAudits の sinceMs を LEARN_PERIODS.materialsMs にする",
      facet: "period",
    });
  }

  const solid = Number(inp.screenSolid);
  const unread = Number(inp.unreadNormal) || 0;
  const read = Number(inp.readCount);
  const construct_marks: LearnPeriodConstructReport["construct_marks"] = [];
  const mark = (id: string, ok: boolean, line: string) => construct_marks.push({ id, ok, line });

  mark(
    "period_aligned",
    gaps.filter((g) => g.facet === "period").length === 0,
    gaps.filter((g) => g.facet === "period").length === 0
      ? `期間揃え✓ 材料${matDays}日`
      : `期間ずれ${gaps.filter((g) => g.facet === "period").length}`,
  );
  mark(
    "solid_or_restore",
    !(Number.isFinite(solid) && solid < 30),
    Number.isFinite(solid) && solid < 30
      ? `画面位置 solid=${solid}（要復元・完了線≥30）`
      : `画面位置 ok/未測 solid=${Number.isFinite(solid) ? solid : "?"}`,
  );
  mark(
    "photo_task_gate",
    !(unread > 0 && inp.photoLearnTask !== true),
    unread > 0 && inp.photoLearnTask !== true
      ? `未学習${unread}なのに photo_learn 課題なし`
      : `photo_learn関所 ok（未学習=${unread}）`,
  );
  mark(
    "reflect_chain",
    !(Number.isFinite(read) && read >= 1 && inp.autoAfter === false),
    Number.isFinite(read) && read >= 1 && inp.autoAfter === false
      ? `read=${read}なのに新束後自動なし`
      : `反映一連 ${inp.autoAfter === true ? "自動済" : "未測/待ち"}`,
  );
  mark(
    "kb_pro_detail",
    inp.kbProLinkOk !== false,
    inp.kbProLinkOk === false ? "設計知見↔Pro連携に細部の欠け" : "KB↔Pro連携 ok/未測",
  );
  if (inp.fineLearnAvg != null) {
    const avg = Number(inp.fineLearnAvg);
    mark(
      "fine_facet",
      avg >= 70,
      `欄×観点平均${avg}%（完了線≥70）`,
    );
    if (avg < 70) {
      push({
        id: "fine_avg",
        what: "欄×観点の細部学習が完了線未満",
        expected: "≥70%",
        actual: `${avg}%`,
        how: "足りない観点だけ photo_learn／位置・外し・場面を分ける",
        facet: "detail",
      });
    }
  }

  for (const m of construct_marks) {
    if (m.ok) continue;
    if (m.id === "solid_or_restore") {
      push({
        id: "c_solid",
        what: m.line,
        expected: "solid≥30",
        actual: String(solid),
        how: "履歴から learned を継ぐ（F33/F35）→束反映",
        facet: "construct",
      });
    }
    if (m.id === "photo_task_gate") {
      push({
        id: "c_photo_task",
        what: m.line,
        expected: "photo_learn 課題あり",
        actual: "なし",
        how: "ensure-gapless-learn 関所を通す",
        facet: "construct",
      });
    }
    if (m.id === "reflect_chain") {
      push({
        id: "c_reflect",
        what: m.line,
        expected: "自動1回あり",
        actual: "auto_after=false",
        how: "need_auto_run → F6/F31/F43 で測る",
        facet: "construct",
      });
    }
  }

  const periods = {
    materials: periodLabelJa(LEARN_PERIODS.materialsMs),
    commands: periodLabelJa(LEARN_PERIODS.commandsMs),
    history: periodLabelJa(LEARN_PERIODS.historyMs),
    bundleFresh: periodLabelJa(LEARN_PERIODS.bundleFreshMs),
    foundationOps: `${matDays}日`,
    foundationAudit: `${matDays}日`,
    normalFresh: periodLabelJa(LEARN_PERIODS.normalFreshMs),
    logMemory: periodLabelJa(LEARN_PERIODS.logMemoryMs),
  };

  const first = gaps[0] || null;
  const line = first
    ? `学習期間・構築: 止=${first.id}:${first.what}／欠${gaps.length}`
    : `学習期間・構築: 期間揃え✓・構築印${construct_marks.filter((m) => m.ok).length}/${construct_marks.length}`;
  const next_line = first
    ? `${first.how}（期待 ${first.expected}／実際 ${first.actual}）`
    : "維持: 期間正本と構築関所を毎回測る";

  return {
    periods,
    gaps: gaps.slice(0, 12),
    construct_marks,
    line,
    next_line,
  };
}
