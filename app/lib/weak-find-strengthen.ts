/**
 * F60 弱い所の横断洗い出し→強化ルート（純関数）
 *
 *   竹内さん「今弱い部分ほかにないのか／ちゃんと見つけて強化する仕組みの土台」
 *   竹内さん「今足りていない仕組みはちゃんとあるのか／足りていない部分強化」（2026-11-23）
 *
 * ★ バラバラの測り（手順書・近さ・位置・F57・F58・新束後自動）を1枚に集め、
 *   未達を名指しして次手スクリプトへ振り分ける。推測で弱点を増やさない。
 *
 * ★ 仕組みあり／本番未達を分ける（統括Pro: 仕組みはコードにある・止まっているのは人の手）:
 *   mech.exists=true でも ok=false → 本番未達（再読込・自動・費用が要る）
 *   mech.exists=false → 仕組みそのものが無い（コード・関所を足す）
 *
 * 完了線: findings がすべて ok（測れる物だけ）。測れない物は no_data で ok 扱いしない＝未達。
 */
import { HUMAN_LIKE_IMPROVE_ALLOW } from "./human-like-improve-loop";
import { NEARNESS_ALLOW } from "./human-nearness";
import { DETAIL_DEGREE } from "./learn-improve-mech";

export const WEAK_FIND_STAMP_REL = "memory/weak_find_last.json";

export type WeakSurfaceId =
  | "auto_after_bundle"
  | "playbook_reflect"
  | "playbook_seen"
  | "ad_sort"
  | "nearness_fold"
  | "human_band"
  | "auto_point"
  | "auto_cursor"
  | "f57_phases"
  | "ext_test"
  | "thin_points"
  | "continuous_handoff";

/** 仕組み（関所・スクリプト）があるか／何で止まっているか */
export type WeakMech = {
  /** 直す道具・関所がコードにあるか */
  exists: boolean;
  /** 道具の名前 */
  name: string;
  /** 本番未達の止め（仕組みはあるのに止まる所） */
  blocked: "none" | "human" | "cost" | "code";
};

export type WeakFinding = {
  id: WeakSurfaceId;
  ok: boolean;
  /** P0=本番反映が止まっている／P1=完了線未達／P2=材料薄い */
  severity: "P0" | "P1" | "P2";
  why: string;
  next: string;
  /** 次に回す道具 */
  script: string;
  layer: "free" | "human" | "cost";
  mech: WeakMech;
};

export type WeakFindInput = {
  /** 新束のあと自動が1回以上あるか（F55/F6） */
  autoAfterBundle?: boolean | null;
  /** 手順書のコード↔束↔直近自動が揃っているか */
  playbookReflectOk?: boolean | null;
  playbookReflectWhy?: string | null;
  /**
   * 直近自動の playbook_seen が「あり」かつ決まり版(rv)がコードと一致するか。
   * 旧版の印だけあっても false（統括Pro: 版を渡す関所）。
   */
  playbookSeenRecent?: boolean | null;
  playbookSeenWhy?: string | null;
  /** 直近で ad_sort_hover が守れているか（守れていない回数があれば false） */
  adSortOk?: boolean | null;
  /** 1押下畳みの近さ */
  nearnessScore?: number | null;
  humanBandPct?: number | null;
  /** 直近自動の位置・カーソル% */
  autoPointPct?: number | null;
  autoCursorPct?: number | null;
  /** F57 段印揃い */
  f57Ok?: boolean | null;
  f57Why?: string | null;
  /** F58 スタンプ */
  extTestOk?: boolean | null;
  /** 束 points で n<3 の thin 欄数 */
  thinPointFields?: number | null;
  /** F61/F62 連続客ループ（外す→入れる→検索→送付→外す） */
  continuousHandoffOk?: boolean | null;
  continuousHandoffWhy?: string | null;
};

export type WeakFindPlan = {
  at: string;
  ok: boolean;
  findings: WeakFinding[];
  /** 未達だけ・severity順 */
  gaps: WeakFinding[];
  line: string;
  next: string;
  /** 仕組み台帳（あり／本番未達／仕組み無し） */
  mech_line: string;
};

const ALLOW = {
  nearnessMin: NEARNESS_ALLOW.scoreMin,
  humanBandMin: NEARNESS_ALLOW.humanBandMinPct,
  pointMin: HUMAN_LIKE_IMPROVE_ALLOW.pointMin,
  cursorMin: DETAIL_DEGREE.CURSOR_OK,
} as const;

function sevRank(s: WeakFinding["severity"]): number {
  return s === "P0" ? 0 : s === "P1" ? 1 : 2;
}

function mech(
  exists: boolean,
  name: string,
  blocked: WeakMech["blocked"],
): WeakMech {
  return { exists, name, blocked };
}

/**
 * 横断の弱い所を名指しし、強化ルートへ振り分ける（純関数・DB不要）。
 */
export function buildWeakFindPlan(
  inp: WeakFindInput,
  nowMs: number = Date.now(),
): WeakFindPlan {
  const findings: WeakFinding[] = [];

  if (inp.autoAfterBundle != null) {
    findings.push({
      id: "auto_after_bundle",
      ok: !!inp.autoAfterBundle,
      severity: "P0",
      why: inp.autoAfterBundle
        ? "新束のあと自動あり"
        : "新束のあと自動が無い（学習・手順書が本番に届いていない）",
      next: "拡張再読込→ポップアップで束取得→自動1回",
      script: "（人）chrome://extensions → 自動1回 → scripts/weak-find.ts",
      layer: "human",
      mech: mech(true, "F6/F55・strengthen-vs-human-loop", inp.autoAfterBundle ? "none" : "human"),
    });
  }

  if (inp.playbookReflectOk != null) {
    findings.push({
      id: "playbook_reflect",
      ok: !!inp.playbookReflectOk,
      severity: "P0",
      why: inp.playbookReflectOk
        ? "手順書の反映揃い"
        : `手順書の反映が揃っていない${inp.playbookReflectWhy ? `（${inp.playbookReflectWhy}）` : ""}`,
      next: "拡張再読込→束取得→自動1回→scripts/check-playbook-reflect.ts",
      script: "scripts/check-playbook-reflect.ts／scripts/attach-playbook.ts --apply",
      layer: "human",
      mech: mech(true, "judgePlaybookReflect／attach-playbook", inp.playbookReflectOk ? "none" : "human"),
    });
  }

  if (inp.playbookSeenRecent != null) {
    findings.push({
      id: "playbook_seen",
      ok: !!inp.playbookSeenRecent,
      severity: "P0",
      why: inp.playbookSeenRecent
        ? "直近自動の playbook_seen が現行決まり版と一致"
        : `playbook_seen 関所未達${inp.playbookSeenWhy ? `（${inp.playbookSeenWhy}）` : "（印なし／版ずれ）"}`,
      next: "拡張≥2.8.199再読込→束取得→自動1回で page:playbook_seen（rv=現行）を残す",
      script: "scripts/check-playbook-reflect.ts",
      layer: "human",
      mech: mech(true, "page:playbook_seen＋rv照合", inp.playbookSeenRecent ? "none" : "human"),
    });
  }

  if (inp.adSortOk != null) {
    findings.push({
      id: "ad_sort",
      ok: !!inp.adSortOk,
      severity: "P1",
      why: inp.adSortOk ? "AD並べ替え守れている" : "ad_sort_hover 未達（sort_hilo 欠など）",
      next: "自動1回で dl:sort_head_hover→sort_ad_hover→sort_hilo を残す。欠ければ sort_legacy 経路を点検",
      script: "scripts/check-playbook-reflect.ts／F58 sort_*",
      layer: "human",
      mech: mech(true, "ad_sort_hover／sort_legacy", inp.adSortOk ? "none" : "human"),
    });
  }

  if (inp.nearnessScore != null) {
    const ok = inp.nearnessScore >= ALLOW.nearnessMin;
    findings.push({
      id: "nearness_fold",
      ok,
      severity: "P1",
      why: ok
        ? `近さ${inp.nearnessScore}≥${ALLOW.nearnessMin}`
        : `近さ${inp.nearnessScore}<${ALLOW.nearnessMin}（1押下畳み）`,
      next: "scripts/human-like-improve.ts（間隔寄せ→再読込→自動→再測）",
      script: "scripts/human-like-improve.ts --plan-only",
      layer: "human",
      mech: mech(true, "F59 human-like-improve／gaps floor", ok ? "none" : "human"),
    });
  }

  if (inp.humanBandPct != null) {
    const ok = inp.humanBandPct >= ALLOW.humanBandMin;
    findings.push({
      id: "human_band",
      ok,
      severity: "P1",
      why: ok
        ? `human帯${inp.humanBandPct}%≥${ALLOW.humanBandMin}%`
        : `human帯${inp.humanBandPct}%<${ALLOW.humanBandMin}%`,
      next: "束 gaps.median_ms を帯内へ・_wardGapPlan 寄せ後に自動1回",
      script: "scripts/human-like-improve.ts --yes-cost（間隔＋必要なら位置）",
      layer: "human",
      mech: mech(true, "F59／_wardGapPlan human帯", ok ? "none" : "human"),
    });
  }

  if (inp.autoPointPct != null) {
    const ok = inp.autoPointPct >= ALLOW.pointMin;
    findings.push({
      id: "auto_point",
      ok,
      severity: "P1",
      why: ok
        ? `自動位置${inp.autoPointPct}%≥${ALLOW.pointMin}%`
        : `自動位置${inp.autoPointPct}%<${ALLOW.pointMin}%`,
      next: "photo_learn（位置）→束 aim→再読込→自動→再測",
      script: "scripts/human-like-improve.ts --yes-cost／scripts/weak-strengthen.ts --yes-cost",
      layer: "cost",
      mech: mech(true, "photo_learn／expandAliasPoints", ok ? "none" : "cost"),
    });
  }

  if (inp.autoCursorPct != null) {
    const ok = inp.autoCursorPct >= ALLOW.cursorMin;
    findings.push({
      id: "auto_cursor",
      ok,
      severity: "P1",
      why: ok
        ? `自動カーソル${inp.autoCursorPct}%≥${ALLOW.cursorMin}%`
        : `自動カーソル${inp.autoCursorPct}%<${ALLOW.cursorMin}%`,
      next: "aim自動引き・_humanPointerClick 必須化のあと自動1回",
      script: "scripts/human-like-improve.ts --plan-only",
      layer: "human",
      mech: mech(true, "aim／_humanPointerClick", ok ? "none" : "human"),
    });
  }

  if (inp.f57Ok != null) {
    findings.push({
      id: "f57_phases",
      ok: !!inp.f57Ok,
      severity: "P1",
      why: inp.f57Ok
        ? "F57 段印揃い"
        : `F57 段印未完${inp.f57Why ? `（${inp.f57Why}）` : ""}`,
      next: "自動1回で guide_phase_* / flow_series の欠段を埋める",
      script: "scripts/check-guide-screen-grasp.ts",
      layer: "human",
      mech: mech(true, "F57 guide_phase／flow_series", inp.f57Ok ? "none" : "human"),
    });
  }

  if (inp.extTestOk != null) {
    findings.push({
      id: "ext_test",
      ok: !!inp.extTestOk,
      severity: "P1",
      why: inp.extTestOk ? "F58 スイート完了" : "F58 未完（落ち・抜けあり）",
      next: "npx tsx scripts/ext-test-improve-loop.ts（--fix で無料抜け）",
      script: "scripts/ext-test-improve-loop.ts",
      layer: "free",
      mech: mech(true, "F58 ext-test-improve-loop", inp.extTestOk ? "none" : "code"),
    });
  }

  if (inp.thinPointFields != null) {
    const ok = inp.thinPointFields <= 8;
    findings.push({
      id: "thin_points",
      ok,
      severity: "P2",
      why: ok
        ? `thin欄${inp.thinPointFields}≤8`
        : `thin欄${inp.thinPointFields}>8（位置票が薄い）`,
      next: "scripts/weak-strengthen.ts --yes-cost で薄い欄を1つずつ",
      script: "scripts/weak-strengthen.ts --yes-cost",
      layer: "cost",
      mech: mech(true, "weak-strengthen／photo_learn", ok ? "none" : "cost"),
    });
  }

  if (inp.continuousHandoffOk != null) {
    findings.push({
      id: "continuous_handoff",
      ok: !!inp.continuousHandoffOk,
      severity: "P0",
      why: inp.continuousHandoffOk
        ? "連続客ループ（F61/F62）揃い"
        : `連続客ループ未達${inp.continuousHandoffWhy ? `（${inp.continuousHandoffWhy}）` : ""}`,
      next: "scripts/handoff-loop-strengthen.ts → 拡張≥2.8.204再読込→連続2客",
      script: "scripts/handoff-loop-strengthen.ts",
      layer: "human",
      mech: mech(true, "F61/F62 handoff-loop-ledger", inp.continuousHandoffOk ? "none" : "human"),
    });
  }

  const gaps = findings
    .filter((f) => !f.ok)
    .sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || a.id.localeCompare(b.id));

  const ok = findings.length > 0 && gaps.length === 0;
  const line = ok
    ? `弱所横断✓ ${findings.length}面すべて完了線内`
    : `弱所横断 未達${gaps.length}/${findings.length} 先頭=${gaps[0]?.id ?? "-"}（${gaps[0]?.severity ?? "-"}）`;
  const next = ok
    ? "週次で scripts/weak-find.ts を再測（鮮度）"
    : `${gaps[0]?.next ?? "再測"} → ${gaps[0]?.script ?? "scripts/weak-find.ts"}`;

  const noMech = gaps.filter((g) => !g.mech.exists);
  const blockedHuman = gaps.filter((g) => g.mech.exists && g.mech.blocked === "human");
  const blockedCost = gaps.filter((g) => g.mech.exists && g.mech.blocked === "cost");
  const blockedCode = gaps.filter((g) => g.mech.exists && g.mech.blocked === "code");
  const mech_line = ok
    ? `仕組み台帳✓ 全${findings.length}面・仕組みあり・本番完了`
    : `仕組み台帳 仕組み無し${noMech.length}／本番未達(人)${blockedHuman.length}／費用${blockedCost.length}／コード${blockedCode.length}` +
      (noMech[0] ? ` 先頭仕組み欠=${noMech[0].id}` : blockedHuman[0] ? ` 先頭人待ち=${blockedHuman[0].id}` : "");

  return {
    at: new Date(nowMs).toISOString(),
    ok,
    findings,
    gaps,
    line,
    next,
    mech_line,
  };
}

/** スタンプから完了線判定（F58 と同じ型） */
export function evaluateWeakFindStamp(stamp: {
  ok?: boolean;
  gaps?: Array<{ id?: string }>;
  line?: string;
  next?: string;
  mech_line?: string;
}): { ok: boolean; line: string; next: string; mech_line: string } {
  const ok = !!stamp.ok && !(stamp.gaps && stamp.gaps.length);
  return {
    ok,
    line: stamp.line || (ok ? "弱所横断✓" : "弱所横断未完"),
    next: stamp.next || (ok ? "週次再測" : "scripts/weak-find.ts"),
    mech_line: stamp.mech_line || (ok ? "仕組み台帳✓" : "仕組み台帳未測"),
  };
}
