/**
 * 学習土台の欠落点検（2026-11-16）
 *
 * ★ 竹内さん「足りない土台／学習が整っているか／テストするたび改善／必要な仕組みを作る」:
 *   毎回の improve / weak-strengthen / Pro打合せで**同じ番号の土台**を数字で出す。
 *   推測で「整っている」と言わない。完了線と次手をセットにする。
 *
 * ⚠ DB を読む。書くのは呼び出し側（saveImprovement）が決める。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeHumanNearness,
  NEARNESS_ALLOW,
  PRESS_FOLD_MS,
  pressGapsFromRows,
  pressStatNote,
} from "./human-nearness";
import { DAY_MS, LEARN_PERIODS, materialsDays, periodLabelJa, sinceIso } from "./learn-periods";
import { isAutoMode } from "./press-by";
import { fieldHasPosition, mergeAliasPositions, type FieldWithPos } from "./field-name-aliases";
import { summarizeLatestAutoChallenges } from "./latest-learn-loop";
import { auditGuideScreenGraspFromAudits } from "./guide-screen-grasp";
import { auditExtTestImproveLoop } from "./ext-test-improve-loop";
import { evaluateHumanLikeImproveStamp } from "./human-like-improve-loop";
import { evaluateWeakFindStamp, WEAK_FIND_STAMP_REL } from "./weak-find-strengthen";
import { countFineAtomsAcrossAudits, HANDOFF_FINE_ORDER } from "./handoff-loop-ledger";
import { autoRulesVersion, parsePlaybookSeen } from "./auto-procedure-rules";
import { auditRootCauseImproveLoop } from "./root-cause-improve-loop";
import { auditKeepStrengthenLoop } from "./keep-strengthen-loop";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type FoundationItem = {
  id: string;
  ok: boolean;
  /** 完了線つきの現状 */
  line: string;
  /** 足りない時の次の1手 */
  next: string;
  /** 層 */
  layer: "free" | "human" | "cost" | "deploy";
};

export type FoundationAudit = {
  at: string;
  bundle_at: string | null;
  source_rows: number | null;
  screen_solid: number;
  ok_n: number;
  missing_n: number;
  items: FoundationItem[];
  /** 1行要約 */
  summary: string;
};

function countScreen(bundle: unknown): { solid: number; all: number; select: number; checkbox: number; keys: number } {
  const learned = (bundle as { shots?: { learned?: Record<string, unknown[]> } } | null)?.shots?.learned || {};
  let all = 0, solid = 0, select = 0, checkbox = 0;
  for (const list of Object.values(learned)) {
    for (const f of (Array.isArray(list) ? list : []) as Array<{ x?: number; y?: number; n?: number; kind?: string }>) {
      if (typeof f?.x === "number" && typeof f?.y === "number") {
        all++;
        if ((Number(f.n) || 0) >= 3) solid++;
      }
      const k = String(f.kind || "");
      if (k === "select") select++;
      if (k === "checkbox") checkbox++;
    }
  }
  return { keys: Object.keys(learned).length, all, solid, select, checkbox };
}

/** shot_key から連続録画 run（`run_...`）を抜く */
export function shotKeyRunId(shotKey: string | null | undefined): string | null {
  const m = String(shotKey || "").match(/\/(run_[^/]+)\//);
  return m ? m[1] : null;
}

/** `shot_learn` がエラー無しで入っているか */
export function isShotLearnOk(sl: unknown): boolean {
  if (sl == null) return false;
  if (typeof sl !== "object") return false;
  const o = sl as Record<string, unknown>;
  if (o.error != null && o.error !== false && o.error !== "") return false;
  return true;
}

/** 場面または flow_step がある学習（scene が other 以外 or flow_step あり） */
export function shotLearnHasSceneFlow(sl: unknown): boolean {
  if (!isShotLearnOk(sl)) return false;
  const o = sl as { scene?: string; flow_step?: string };
  const scene = String(o.scene || "").trim().toLowerCase();
  if (scene && scene !== "other") return true;
  return !!String(o.flow_step || "").trim();
}

export function countSeqCoveredRuns(
  rows: Array<{ shot_key?: string | null; shot_learn?: unknown }>,
  minLearned = 5,
  minRatio = 0.25,
  minMilestoneLearned = 12,
): number {
  const runSet = new Map<string, { total: number; learned: number; scenes: Set<string> }>();
  for (const r of rows) {
    const run = shotKeyRunId(r.shot_key);
    if (!run) continue;
    const cur = runSet.get(run) || { total: 0, learned: 0, scenes: new Set<string>() };
    cur.total++;
    if (isShotLearnOk(r.shot_learn)) {
      cur.learned++;
      const sc = String((r.shot_learn as { scene?: string } | null)?.scene || "").trim().toLowerCase();
      if (sc && sc !== "other") cur.scenes.add(sc);
    }
    runSet.set(run, cur);
  }
  let seqCoveredRuns = 0;
  for (const v of runSet.values()) {
    const byRatio = v.learned >= minLearned && v.learned / v.total >= minRatio;
    const byMilestones = v.learned >= minMilestoneLearned && v.scenes.size >= 2;
    if (byRatio || byMilestones) seqCoveredRuns++;
  }
  return seqCoveredRuns;
}

export type ChallengeLearnBundle = {
  points?: Record<string, { x?: number; y?: number; n?: number }> | null;
  shots?: { learned?: Record<string, FieldWithPos[] | unknown[]> } | null;
} | null;

/** 束の points / shots.learned に載っている欄名（xy あり） */
export function collectBundleFieldSets(bundle: ChallengeLearnBundle): { points: Set<string>; learned: Set<string> } {
  const points = new Set<string>();
  const learned = new Set<string>();
  const pts = bundle?.points;
  if (pts && typeof pts === "object") {
    for (const [k, v] of Object.entries(pts)) {
      if (typeof v?.x === "number" && typeof v?.y === "number") points.add(k);
    }
  }
  const learnedObj = bundle?.shots?.learned;
  if (learnedObj && typeof learnedObj === "object") {
    for (const list of Object.values(learnedObj)) {
      const arr = Array.isArray(list) ? list : [];
      for (const f of mergeAliasPositions(arr as FieldWithPos[])) {
        const name = String(f?.name ?? "").trim();
        if (!name) continue;
        if (typeof f.x === "number" && typeof f.y === "number") learned.add(name);
      }
    }
  }
  return { points, learned };
}

export type ChallengeLearnCompleteAudit = {
  ok: boolean;
  line: string;
  next: string;
  challengeN: number;
  normalTodo: number;
  missingPoints: string[];
  missingLearned: string[];
};

/**
 * F54 課題欄の学習完全化（純関数）:
 *   課題欄が束の points と shots.learned の両方に xy で載り、通常の未学習が 0。
 */
export function auditChallengeLearnComplete(opt: {
  challengeFields?: string[];
  bundle?: ChallengeLearnBundle;
  normalUnlearned?: number;
}): ChallengeLearnCompleteAudit {
  const fields = [...new Set((opt.challengeFields || []).map(String).map((s) => s.trim()).filter(Boolean))];
  const normalTodo = Math.max(0, Number(opt.normalUnlearned) || 0);
  const { points: havePts, learned: haveLearned } = collectBundleFieldSets(opt.bundle ?? null);
  const missingPoints = fields.filter((f) => !fieldHasPosition(f, havePts));
  const missingLearned = fields.filter((f) => !fieldHasPosition(f, haveLearned));
  const fieldsOk = fields.length === 0 || (missingPoints.length === 0 && missingLearned.length === 0);
  const ok = fieldsOk && normalTodo === 0;
  const missTxt = [
    missingPoints.length ? `points欠${missingPoints.slice(0, 4).join("・")}` : "",
    missingLearned.length ? `learned欠${missingLearned.slice(0, 4).join("・")}` : "",
    normalTodo > 0 ? `通常未学習${normalTodo}` : "",
  ].filter(Boolean).join(" ");
  const line =
    `課題学習完全 課題欄=${fields.length} points欠=${missingPoints.length} learned欠=${missingLearned.length} 通常未学習=${normalTodo}`
    + `（完了線: 課題欄は points∧learned 両方・通常未学習=0）`
    + (missTxt ? `／${missTxt}` : "");
  const next = ok
    ? "維持（課題欄→通常学習→束 points+learned→自動で確認）"
  : missingPoints.length || missingLearned.length
      ? `photo_learn／weak-strengthen で ${[...new Set([...missingPoints, ...missingLearned])].slice(0, 6).join("・")} を束へ`
      : normalTodo > 0
        ? "scripts/shot-learn.ts --mode=normal で未学習を読む→束作り直し"
        : "自動の最新課題を確認→通常から学習";
  return { ok, line, next, challengeN: fields.length, normalTodo, missingPoints, missingLearned };
}

export type AutoReflectVerifiedAudit = {
  ok: boolean;
  line: string;
  next: string;
  readCount: number;
  autoAfter: number;
  reflectOk: number;
  flowReflectOk: number;
  aimYes: number;
};

/**
 * F55 自動モードへの反映確認（純関数・F6+F31+F43+F46 統合）:
 *   read≥1・新束後自動≥1・（learn_reflect_ok|learn_flow_reflect_ok|aim有）のいずれか≥1。
 */
export function auditAutoReflectVerified(opt: {
  readCount?: number;
  autoAfterBundle?: number;
  reflectOk?: number;
  flowReflectOk?: number;
  aimYes?: number;
}): AutoReflectVerifiedAudit {
  const readCount = Math.max(0, Number(opt.readCount) || 0);
  const autoAfter = Math.max(0, Number(opt.autoAfterBundle) || 0);
  const reflectOk = Math.max(0, Number(opt.reflectOk) || 0);
  const flowReflectOk = Math.max(0, Number(opt.flowReflectOk) || 0);
  const aimYes = Math.max(0, Number(opt.aimYes) || 0);
  const readOk = readCount >= 1;
  const autoOk = autoAfter >= 1;
  const markOk = reflectOk >= 1 || flowReflectOk >= 1 || aimYes >= 1;
  const ok = readOk && autoOk && markOk;
  const stop = !readOk ? "read" : !autoOk ? "auto" : !markOk ? "reflect印" : "";
  const line =
    `自動反映確認 read=${readCount} 新束後自動=${autoAfter} reflect_ok=${reflectOk} flow_reflect=${flowReflectOk} aim有=${aimYes}`
    + `（完了線: read≥1・新束後自動≥1・reflect|flow_reflect|aim有≥1）`
    + (stop ? `／止=${stop}` : "");
  const next = ok
    ? "維持（次の束でも拡張再読込→自動1回→印を確認）"
    : !readOk
      ? "拡張再読込→ポップアップで学習再取得（read_count≥1）"
      : !autoOk
        ? "自動/AIXで1回検索（新束より後）"
        : "2.8.78+再読込→自動1回（learn_reflect_ok / learn_flow_reflect_ok / aim有）";
  return { ok, line, next, readCount, autoAfter, reflectOk, flowReflectOk, aimYes };
}

/**
 * ★ F63 2026-11-23: 手順書決まり版の反映関所（attach≠拡張読込の抜けを測る）
 *   完了線: DB rules_v＝コード ∧ 自動 playbook_seen rv＝コード ∧ read≥1
 */
export function auditPlaybookRulesReflect(opt: {
  codeRulesV: string;
  dbRulesV?: string | null;
  seenRulesV?: string | null;
  readCount?: number;
}): { ok: boolean; line: string; next: string } {
  const code = String(opt.codeRulesV || "");
  const db = opt.dbRulesV != null ? String(opt.dbRulesV) : "";
  const seen = opt.seenRulesV != null ? String(opt.seenRulesV) : "";
  const read = Math.max(0, Number(opt.readCount) || 0);
  const dbOk = !!db && !!code && db === code;
  const seenOk = !!seen && !!code && seen === code;
  const readOk = read >= 1;
  const ok = dbOk && seenOk && readOk;
  const stop = !dbOk ? "DB≠コード" : !seenOk ? "自動既読≠コード" : !readOk ? "read=0" : "";
  return {
    ok,
    line: `F63 手順書版反映 DB=${db || "-"} 自動既読=${seen || "-"} コード=${code || "-"} read=${read}`
      + `（完了線: DB=コード ∧ playbook_seen rv=コード ∧ read≥1）`
      + (stop ? `／止=${stop}` : ""),
    next: ok
      ? "維持（attach のたびに generated_at 上げ→再読込→自動1回）"
      : !dbOk
        ? "attach-playbook --apply（generated_at も上げる・read_count=0）"
        : "拡張≥2.8.206再読込→自動1回（rules_v ずれで強制取込）→check-playbook-reflect",
  };
}

/** ★ F56 純関数: 発見(F53/F54)→強化(F15/F28/F29)→自動反映(F55)の統括Pro完走責任 */
export function auditProReflectResponsibility(opt: {
  f53Ok?: boolean;
  f54Ok?: boolean;
  f55Ok?: boolean;
  f15Ok?: boolean;
  f28Ok?: boolean;
  f29Ok?: boolean;
  f54Next?: string;
  f28Next?: string;
}): { ok: boolean; done: number; total: number; missing: string[]; line: string; next: string } {
  const gates = [
    { name: "連続画像F53", ok: !!opt.f53Ok },
    { name: "課題完全F54", ok: !!opt.f54Ok },
    { name: "反映実証F55", ok: !!opt.f55Ok },
    { name: "aim(F15)", ok: !!opt.f15Ok },
    { name: "間隔(F28)", ok: !!opt.f28Ok },
    { name: "近さ(F29)", ok: !!opt.f29Ok },
  ];
  const done = gates.filter((g) => g.ok).length;
  const missing = gates.filter((g) => !g.ok).map((g) => g.name);
  const ok = done === gates.length;
  const line =
    `統括Pro完走責任 ${done}/${gates.length}✓`
    + (missing.length ? `（未: ${missing.join("・")}）` : "（発見→構築→強化→自動反映まで完走）")
    + `（完了線: F53∧F54∧F55∧F15∧F28∧F29 すべて✓）`;
  const next = ok
    ? "維持（次の録画も連続学習→改善→反映まで完走）"
    : !opt.f55Ok
      ? "最優先: 拡張2.8.101再読込→自動1回でF55/F15/F28/F29を本番実証"
      : (opt.f54Next || opt.f28Next || "未達土台を上から順に潰して自動1回で再確認");
  return { ok, done, total: gates.length, missing, line, next };
}

export type FoundationSite = "realpro" | "itandi" | "all";

/** 本番DBから土台を点検する（site指定でリアプロ／itandiを分けて測れる） */
export async function auditLearnFoundations(
  sb: SupabaseClient,
  opt: { daysOps?: number; daysAudit?: number; site?: FoundationSite } = {},
): Promise<FoundationAudit> {
  const daysOps = opt.daysOps ?? materialsDays();
  const daysAudit = opt.daysAudit ?? materialsDays();
  const site: FoundationSite = opt.site === "itandi" || opt.site === "realpro" ? opt.site : "all";
  /**
   * ★ 2026-11-17: 印ベースのF（F39〜F48）は拡張がサイト別に残す。
   *   site=all の既定計測は realpro（今の印の主戦場）。
   *   site=itandi なら itandi の監査だけで測る（無い＝足りない土台として見える）。
   */
  const markSite: "realpro" | "itandi" = site === "itandi" ? "itandi" : "realpro";
  const sinceOps = new Date(Date.now() - daysOps * DAY_MS).toISOString();
  const sinceAudit = new Date(Date.now() - daysAudit * DAY_MS).toISOString();
  const items: FoundationItem[] = [];

  const profileScope = site === "all" ? "all" : site;
  let { data: prof } = await sb
    .from("human_learn_profile")
    .select("created_at, source_rows, read_count, read_at, bundle")
    .eq("scope", profileScope)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  // サイト別scopeの束が無い時は all を読む（supervisor_by_site は all 束にある）
  if (!prof && site !== "all") {
    const { data: profAll } = await sb
      .from("human_learn_profile")
      .select("created_at, source_rows, read_count, read_at, bundle")
      .eq("scope", "all")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    prof = profAll;
  }
  const sc = countScreen(prof?.bundle);
  const readOk = (Number(prof?.read_count) || 0) > 0;

  items.push({
    id: "F1_screen_pos",
    ok: sc.solid >= 30,
    line: `束の画面位置 solid=${sc.solid}（完了線≥30） select=${sc.select} checkbox=${sc.checkbox}`,
    next: sc.solid >= 30 ? "本番freshで消さない（learned引き継ぎ）" : "手元 reflect で復元",
    layer: "free",
  });
  items.push({
    id: "F2_ext_read",
    ok: readOk,
    line: `拡張が束を読んだ read_count=${prof?.read_count ?? 0}`,
    next: readOk ? "自動1回へ" : "拡張再読込→ポップアップで学習再取得",
    layer: "human",
  });

  let opsN = 0, wasN = 0, csN = 0, gN = 0;
  for (let i = 0; i < 3000; i += 1000) {
    const { data } = await sb
      .from("human_motion_learn")
      .select("shot_ops")
      .gte("created_at", sinceOps)
      .order("created_at", { ascending: false })
      .range(i, i + 999);
    if (!data?.length) break;
    for (const r of data) {
      const ops = Array.isArray(r.shot_ops) ? (r.shot_ops as Array<Record<string, unknown>>) : [];
      for (const o of ops) {
        opsN++;
        if (typeof o.was === "boolean") wasN++;
        if (typeof o.cs === "string" && o.cs) csN++;
        if (typeof o.g === "number") gN++;
      }
    }
    if (data.length < 1000) break;
  }

  items.push({
    id: "F3_toggle_was_now",
    ok: wasN > 0,
    line: `外し/選び was付き ${wasN}/${opsN}（完了線≥1・理想はcheckbox過半）`,
    next: wasN > 0 ? "比率を上げる" : "2.8.37再読込後、通常で区or間取りの外しを1回録画（was明示送信）",
    layer: "human",
  });
  items.push({
    id: "F4_hand_cs",
    ok: csN > 0,
    line: `手の形 cs付き ${csN}/${opsN}（完了線≥1）`,
    next: csN > 0 ? "維持" : "2.8.37再読込＋通常でボタン1回録画（cs明示送信）",
    layer: "human",
  });

  /** F11: 間取り・所在地・駅沿線の「label押し」原子が録画に残っているか */
  let layoutLabel = 0, cityLabel = 0, stationLike = 0;
  for (let i = 0; i < 2000; i += 1000) {
    const { data } = await sb
      .from("human_motion_learn")
      .select("shot_ops")
      .eq("mode", "normal")
      .gte("created_at", sinceOps)
      .order("created_at", { ascending: false })
      .range(i, i + 999);
    if (!data?.length) break;
    for (const r of data) {
      for (const o of (Array.isArray(r.shot_ops) ? (r.shot_ops as Array<Record<string, unknown>>) : [])) {
        const f = String(o.f || "");
        if (/room_layout|間取|｜label/.test(f) && /(LDK|DK|K｜|間取|room_layout)/.test(f)) layoutLabel++;
        if (/one_city|所在地絞り込み|確定してリスト|大阪市.+区/.test(f)) cityLabel++;
        if (/station_id|route_id|one_line|沿線・駅|駅名/.test(f)) stationLike++;
      }
    }
    if ((data?.length || 0) < 1000) break;
  }
  const areaAtomsOk = layoutLabel > 0 && cityLabel > 0;
  items.push({
    id: "F11_area_toggle_atoms",
    ok: areaAtomsOk,
    line: `場所原子 間取りlabel系=${layoutLabel} 所在地系=${cityLabel} 駅沿線系=${stationLike}（完了線: 間取り+所在地≥1）`,
    next: stationLike > 0
      ? "自動で前客外し→客条件だけを1回確認"
      : "駅・沿線の通常録画を1回足す（原子が空）／自動は label押し・軸違い関所を2.8.37で強化済",
    layer: "human",
  });

  /** F12: 連続客切替のボトルネック原子（fill/batch timeout・stalled） */
  let fillTo = 0, batchTo = 0, stalledN = 0, auditN = 0;
  {
    const { data: sa } = await sb
      .from("search_audits")
      .select("cause_key,status")
      .gte("created_at", sinceAudit)
      .limit(400);
    for (const a of sa || []) {
      auditN++;
      const ck = String(a.cause_key || "").toLowerCase();
      if (/fill_timeout/.test(ck)) fillTo++;
      else if (/batch_timeout/.test(ck)) batchTo++;
      else if (/stalled/.test(ck)) stalledN++;
    }
  }
  const switchOk = fillTo + batchTo < 5 && stalledN < 20;
  items.push({
    id: "F12_continuous_switch",
    ok: switchOk,
    line: `連続切替原子 fill_timeout=${fillTo} batch_timeout=${batchTo} stalled=${stalledN}（標本${auditN}・完了線: fill+batch<5 かつ stalled<20）`,
    next: switchOk
      ? "維持・連続2客で再測"
      : "2.8.40再読込→連続2客自動（前客外し徹底／fill_timeout時のfillRunning解除）",
    layer: "human",
  });

  /** F13: 統括Proが実際に使えているか（Abort 60s が usedPro=false の主因だった） */
  let proUsedN = 0, proMissN = 0, proAbortN = 0;
  {
    const { data: logs } = await sb
      .from("learn_supervisor_log")
      .select("meeting,created_at")
      .gte("created_at", sinceAudit)
      .order("created_at", { ascending: false })
      .limit(30);
    for (const row of logs || []) {
      const ev = Array.isArray((row.meeting as { evidence?: Array<{ label?: string; value?: string }> })?.evidence)
        ? (row.meeting as { evidence: Array<{ label?: string; value?: string }> }).evidence
        : [];
      // 札は「統括Pro」単独か「統括Proまとめ」（変バグ（統括Pro）は別）
      const proEv = ev.find((e) => /^(統括Pro|統括Proまとめ)$/.test(String(e.label || "").trim()));
      const v = String(proEv?.value || "");
      if (!v) continue;
      if (/未使用|exception:|aborted|TimeoutError/i.test(v)) {
        proMissN++;
        if (/aborted|TimeoutError|timeout_ms=/i.test(v)) proAbortN++;
      } else {
        proUsedN++;
      }
    }
  }
  const proOk = proAbortN === 0 && (proUsedN > 0 || proMissN === 0);
  items.push({
    id: "F13_supervisor_pro_used",
    ok: proOk,
    line: `統括Pro used≈${proUsedN} miss=${proMissN} abort/timeout=${proAbortN}（完了線: abort=0 かつ used≥1 or miss=0）`,
    next: proOk
      ? "維持"
      : "SUPERVISOR_PRO_TIMEOUT_MS=180000 反映後に scripts/supervisor-pro.ts --meet=… で再測",
    layer: "free",
  });

  /**
   * F14〜F25: 沿線・駅外しの計測土台（2026-11-17 統括Pro）
   *   Pro生:「stClearWas/lnClearWas…0→1になる計測を最優先」「via_next/cursor/line_clear が全部0で区別不能」
   */
  let stClearCursor = 0, stThenLine = 0, stReselect = 0;
  let stViaNext = 0, lineAfterSt = 0, stClearBegin = 0;
  let orderOkN = 0, orderBadN = 0, orderSample = 0;
  {
    const { data: sa2 } = await sb
      .from("search_audits")
      .select("steps,ext_version,mode")
      .gte("created_at", sinceAudit)
      .order("created_at", { ascending: false })
      .limit(40);
    for (const a of sa2 || []) {
      const steps = Array.isArray(a.steps) ? a.steps : [];
      const joined = steps.map((s) => (typeof s === "string" ? s : JSON.stringify(s)));
      const idxOf = (re: RegExp) => {
        for (let i = 0; i < joined.length; i++) if (re.test(joined[i])) return i;
        return -1;
      };
      for (const j of joined) {
        if (/station_clear_cursor/i.test(j)) stClearCursor++;
        if (/station_then_line_clear/i.test(j)) stThenLine++;
        if (/station_reselect/i.test(j)) stReselect++;
        if (/station_clear_via_next/i.test(j)) stViaNext++;
        if (/line_clear_after_station/i.test(j)) lineAfterSt++;
        if (/station_place_clear_begin/i.test(j)) stClearBegin++;
      }
      const iBegin = idxOf(/station_place_clear_begin|station_clear_via_next/);
      const iSt = idxOf(/station_clear_cursor/);
      const iBack = idxOf(/station_clear_back_line|沿線の設定へ戻る/);
      const iLn = idxOf(/line_clear_after_station|station_then_line_clear/);
      // 録画正本: via/begin → 駅外し → 沿線の設定へ戻る → 沿線外し
      if (iSt >= 0 && iLn >= 0) {
        orderSample++;
        const backOk = iBack < 0 || (iSt < iBack && iBack < iLn);
        if (iSt < iLn && (iBegin < 0 || iBegin < iSt) && backOk) orderOkN++;
        else orderBadN++;
      } else if (iBegin >= 0 && iSt >= 0) {
        orderSample++;
        if (iBegin < iSt) orderOkN++;
        else orderBadN++;
      }
    }
  }
  const clearAtomN = stClearCursor + stThenLine + stViaNext + lineAfterSt + stClearBegin;
  const clearOk = stReselect === 0 || clearAtomN > 0;
  items.push({
    id: "F14_station_clear_cursor",
    ok: clearOk && (stReselect === 0 || clearAtomN > 0),
    line: `駅外し原子 cursor=${stClearCursor} 駅→沿線=${stThenLine} via=${stViaNext} line後=${lineAfterSt} begin=${stClearBegin} reselect=${stReselect}（完了線: reselect時は外し原子≥1）`,
    next: clearOk
      ? "連続2客で station_clear_via_next → station_clear_cursor → line_clear_after_station が出るか"
      : "2.8.46再読込→続き客駅検索。外しは駅の設定へ経由（沿線直外し禁止）",
    layer: "human",
  });

  /** F23: 沿線画面からの外しは「駅の設定へ進む」経由＋録画正本「沿線の設定へ戻る」 */
  let stBackLine = 0;
  {
    const { data: saBack } = await sb
      .from("search_audits")
      .select("steps")
      .gte("created_at", sinceAudit)
      .order("created_at", { ascending: false })
      .limit(40);
    for (const a of saBack || []) {
      for (const s of (Array.isArray(a.steps) ? a.steps : [])) {
        const j = typeof s === "string" ? s : JSON.stringify(s);
        if (/station_clear_back_line|沿線の設定へ戻る/i.test(j)) stBackLine++;
      }
    }
  }
  const viaOk = stReselect === 0 || stViaNext + stClearBegin > 0 || (stClearCursor > 0 && (lineAfterSt > 0 || stBackLine > 0));
  items.push({
    id: "F23_station_clear_via_next",
    ok: viaOk,
    line: `駅外し経由 via_next=${stViaNext} begin=${stClearBegin} back(沿線の設定へ戻る)=${stBackLine}（完了線: 駅作業時は via/begin≥1 または cursor+戻る/line後）`,
    next: viaOk
      ? "維持（F24で 駅→戻る→沿線 の順）"
      : "2.8.48再読込→続き客。監査に station_clear_via_next と station_clear_back_line（沿線の設定へ戻る）",
    layer: "human",
  });

  /** F24: 順序 経由/begin → 駅外し → 沿線外し */
  const orderOk = orderSample === 0 ? false : orderBadN === 0 && orderOkN > 0;
  items.push({
    id: "F24_station_clear_order",
    ok: orderOk,
    line: `外し順 OK=${orderOkN} NG=${orderBadN} 標本=${orderSample}（完了線: 標本≥1 かつ NG=0）`,
    next: orderOk
      ? "維持"
      : orderSample === 0
        ? "2.8.46で連続駅客1回（via→駅→沿線の3原子を出す）"
        : "順序NG: 沿線を駅より先に外していないか page-script 状態機械を確認",
    layer: "human",
  });

  /** F25: 録画opsで駅/沿線の外し(was)と選び・手の形(cs)を区別できる */
  let stClearWas = 0, lnClearWas = 0, stHasWas = 0, stHasCs = 0, stOpsN = 0, lnOpsN = 0;
  {
    const { data: opsRows } = await sb
      .from("human_motion_learn")
      .select("shot_ops,mode")
      .gte("created_at", sinceOps)
      .order("created_at", { ascending: false })
      .limit(120);
    for (const r of opsRows || []) {
      for (const o of (Array.isArray(r.shot_ops) ? r.shot_ops as Array<Record<string, unknown>> : [])) {
        const f = String(o.f || o.t || "");
        const cls = String(o.cls || o.c || "");
        const blob = f + " " + cls;
        const isSt = /one_station|station_id|駅/.test(blob) && !/駅の設定/.test(blob);
        const isLn = /one_line|route_id|沿線/.test(blob) && !/駅の設定/.test(blob);
        if (!isSt && !isLn) continue;
        if (isSt) {
          stOpsN++;
          if (typeof o.was === "boolean") stHasWas++;
          if (o.was === true) stClearWas++;
          if (typeof o.cs === "string" && o.cs) stHasCs++;
        }
        if (isLn) {
          lnOpsN++;
          if (o.was === true) lnClearWas++;
        }
      }
    }
  }
  const wasOk = stClearWas + lnClearWas >= 1 && stHasWas >= 1;
  items.push({
    id: "F25_station_line_ops_was",
    ok: wasOk,
    line: `駅/沿線ops外し計測 stClearWas=${stClearWas} lnClearWas=${lnClearWas} stHasWas=${stHasWas} stHasCs=${stHasCs}（stOps=${stOpsN} lnOps=${lnOpsN}・完了線: ClearWas≥1 かつ HasWas≥1）`,
    next: wasOk
      ? "維持・csも≥1へ（手の形）"
      : "API(cs/was通す)デプロイ＋2.8.46再読込→通常or自動で駅/沿線の外し1回録画（was=trueがDBに残る）",
    layer: "deploy",
  });

  /**
   * F26: 操作間隔の自然さ（2026-11-17 統括Pro「間隔の自然さを測る指標」）
   *   人間実測: p50≈1005・CV≈0.64・topShare≈10%。
   *   機械的: 同一バケット偏り大・CVが極端に低い／高い。
   */
  let gapHumanN = 0, gapAutoN = 0, gapHumanCv = 0, gapAutoCv = 0, gapAutoTopShare = 0, gapAutoP50 = 0;
  let gapNote = "";
  {
    /**
     * 数え方（2026-11-19）: click/tap/key のみ・site で絞る・行をまたいで重複除去・
     * 300ms 以内の click/tap を1押下に畳み、塊の先頭どうしの差を間隔にする（pressGapsFromRows）。
     */
    // 輪の重複を除くと1行あたりの新しい操作は1件前後 → F28/F29 と同じ幅（2頁）で読む
    const gapRows: Array<{ mode?: unknown; install_id?: unknown; shot_ops?: unknown }> = [];
    for (let i = 0; i < 2000; i += 1000) {
      const { data } = await sb
        .from("human_motion_learn")
        .select("mode,install_id,shot_ops")
        .eq("site", markSite)
        .gte("created_at", sinceOps)
        .order("created_at", { ascending: false })
        .range(i, i + 999);
      if (!data?.length) break;
      for (const r of data) gapRows.push(r);
      if (data.length < 1000) break;
    }
    const st = pressGapsFromRows(gapRows, (r, o) => {
      const isAutoMode = /aix|auto/i.test(String(r.mode || ""));
      const by = String(o.by || "");
      return by === "auto" || (isAutoMode && by !== "human") ? "auto" : "human";
    });
    // 完了線は従来どおり（0 < g < 20000 だけ）
    const hGaps: number[] = (st.human?.gaps || []).filter((g) => g > 0 && g < 20000);
    const aGaps: number[] = (st.auto?.gaps || []).filter((g) => g > 0 && g < 20000);
    gapNote = `${pressStatNote("自動", st.auto)}／${pressStatNote("人間", st.human)}`;
    const cvOf = (arr: number[]) => {
      if (arr.length < 5) return 0;
      const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
      if (!mean) return 0;
      const v = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / arr.length;
      return Math.sqrt(v) / mean;
    };
    const topShareOf = (arr: number[]) => {
      if (!arr.length) return 0;
      const b: Record<number, number> = {};
      for (const g of arr) {
        const k = Math.round(g / 50) * 50;
        b[k] = (b[k] || 0) + 1;
      }
      const top = Object.values(b).sort((x, y) => y - x)[0] || 0;
      return top / arr.length;
    };
    gapHumanN = hGaps.length;
    gapAutoN = aGaps.length;
    gapHumanCv = Math.round(cvOf(hGaps) * 100) / 100;
    gapAutoCv = Math.round(cvOf(aGaps) * 100) / 100;
    gapAutoTopShare = Math.round(topShareOf(aGaps) * 100) / 100;
    if (aGaps.length) {
      const s = aGaps.slice().sort((x, y) => x - y);
      gapAutoP50 = s[Math.floor(s.length * 0.5)] || 0;
    }
  }
  // 完了線: 自動opsがまだ無い時は人間側CVが人間らしい(0.35〜1.1)なら土台OK扱いせず「自動走行待ち」
  const gapOk =
    gapAutoN >= 30
      ? gapAutoCv >= 0.4 && gapAutoCv <= 1.2 && gapAutoTopShare <= 0.22
      : false;
  items.push({
    id: "F26_gap_humanlike",
    ok: gapOk,
    line: `間隔自然さ 自動n=${gapAutoN} CV=${gapAutoCv} p50=${gapAutoP50} topShare=${Math.round(gapAutoTopShare * 100)}%／人間n=${gapHumanN} CV=${gapHumanCv}（完了線: 自動≥30かつCV0.4〜1.2かつtop≤22%・click/tap/keyのみ・site絞り・重複除去・${PRESS_FOLD_MS}ms内click/tapを1押下に畳み: ${gapNote}）`,
    next: gapOk
      ? "維持"
      : gapAutoN < 30
        ? "2.8.47再読込→自動1回（opsにgが残ること・API/録画経路）"
        : "sigma広め・固定レンジ禁止を確認（駅外し・retry・bulk-dl）",
    layer: "human",
  });

  /**
   * ★ 2026-11-17 統括Pro「操作種別とカーソル有無を記録する土台」:
   *   op_path_* が監査 steps に残ること。無いと直接入力の優先順位がコード推測だけになる。
   */
  let pathCursorN = 0, pathNocursorN = 0, pathRetryN = 0, pathDirectMissN = 0, pathSample = 0;
  {
    const { data: saPath } = await sb
      .from("search_audits")
      .select("steps")
      .gte("created_at", sinceAudit)
      .order("created_at", { ascending: false })
      .limit(30);
    for (const a of saPath || []) {
      for (const s of (Array.isArray(a.steps) ? a.steps : [])) {
        const j = typeof s === "string" ? s : JSON.stringify(s);
        if (!/op_path_/.test(j)) continue;
        pathSample++;
        if (/op_path_text_cursor|op_path_text_move|op_path_select/.test(j)) pathCursorN++;
        if (/op_path_text_nocursor|op_path_direct/.test(j)) pathNocursorN++;
        if (/op_path_retry/.test(j)) pathRetryN++;
        if (/op_path_direct_miss/.test(j)) pathDirectMissN++;
      }
    }
  }
  items.push({
    id: "F27_op_path_kind",
    ok: pathSample >= 1 && pathNocursorN <= Math.max(2, Math.floor(pathCursorN * 0.25)),
    line: `操作経路 op_path標本=${pathSample} cursor系=${pathCursorN} nocursor/direct=${pathNocursorN} retry=${pathRetryN} miss=${pathDirectMissN}（完了線: ≥1 かつ nocursor≤cursorの1/4）`,
    next: pathSample === 0
      ? "2.8.50再読込→自動1回（賃料・徒歩・テキスト入力で op_path_* が出るか）"
      : pathNocursorN > Math.max(2, Math.floor(pathCursorN * 0.25))
        ? "op_path_text_nocursor / direct_miss の欄をカーソル経路へ"
        : "維持",
    layer: "human",
  });

  /** F28: 自動の**動作間**（click/tap/key）で g<400 が多すぎないか */
  let autoFastN = 0, autoGapN = 0;
  let autoGapNote = "";
  {
    /**
     * 数え方（2026-11-19）: site で絞り・行をまたいで重複除去・
     * 300ms 以内の click/tap を1押下に畳んだ塊の先頭どうしの差（pressGapsFromRows）。
     */
    const rowsAll: Array<{ mode?: unknown; install_id?: unknown; shot_ops?: unknown }> = [];
    for (let i = 0; i < 2000; i += 1000) {
      const { data } = await sb
        .from("human_motion_learn")
        .select("shot_ops,mode,install_id")
        .eq("site", markSite)
        .gte("created_at", sinceOps)
        .order("created_at", { ascending: false })
        .range(i, i + 999);
      if (!data?.length) break;
      for (const r of data) rowsAll.push(r);
      if (data.length < 1000) break;
    }
    const st = pressGapsFromRows(rowsAll, (r) => (/aix|auto/i.test(String(r.mode || "")) ? "auto" : null));
    for (const g of st.auto?.gaps || []) {
      autoGapN++;
      if (g > 0 && g < 400) autoFastN++;
    }
    autoGapNote = pressStatNote("自動", st.auto);
  }
  const autoFastPct = autoGapN ? Math.round((autoFastN / autoGapN) * 1000) / 10 : 0;
  items.push({
    id: "F28_auto_gap_floor",
    ok: autoGapN >= 30 && autoFastPct <= 12,
    line: `自動短間隔(動作間) g<400 = ${autoFastN}/${autoGapN}（${autoFastPct}%・完了線≤12%・標本≥30・click/tap/keyのみ・重複除去・${PRESS_FOLD_MS}ms内click/tapを1押下に畳み: ${autoGapNote}）`,
    next: autoGapN < 30
      ? "2.8.50再読込→自動1回（ops.gが残ること）"
      : autoFastPct > 12
        ? "固定450-1000帯・humanRand下限・_uiGapMin を確認（change直後の短gは測らない）"
        : "維持",
    layer: "human",
  });

  /**
   * ★ 2026-11-17 統括Pro「近さ加重スコア＋許可線をFとして固定／束に接続」:
   *   通常 vs 自動の差分を1本で測る。許可線: 近さ≥70・短間隔≤12%・human帯≥50%。
   */
  let nearLine = "近さ未計測";
  let nearOk = false;
  {
    const rowsAll: Array<{ mode?: unknown; install_id?: unknown; shot_ops?: unknown }> = [];
    for (let i = 0; i < 2000; i += 1000) {
      const { data } = await sb
        .from("human_motion_learn")
        .select("shot_ops,mode,install_id")
        .eq("site", markSite)
        .gte("created_at", sinceOps)
        .order("created_at", { ascending: false })
        .range(i, i + 999);
      if (!data?.length) break;
      for (const r of data) rowsAll.push(r);
      if (data.length < 1000) break;
    }
    // 重複除去・1押下に畳む（自動も通常も同じ畳み方）
    const st = pressGapsFromRows(rowsAll, (r) => {
      if (isAutoMode(r.mode)) return "auto";
      if (String(r.mode || "").toLowerCase() === "normal") return "normal";
      return null;
    });
    const normalGaps = st.normal?.gaps || [];
    const autoGaps = st.auto?.gaps || [];
    const note = `重複除去・${PRESS_FOLD_MS}ms内click/tapを1押下に畳み: ${pressStatNote("自動", st.auto)}／${pressStatNote("通常", st.normal)}`;
    if (normalGaps.length >= 30 && autoGaps.length >= 30) {
      const n = computeHumanNearness({ normalGaps, autoGaps });
      nearOk = n.allowed;
      nearLine = `${n.line}（${note}）`;
    } else {
      nearLine = `標本不足 通常g=${normalGaps.length} 自動g=${autoGaps.length}（各≥30で測る・${note}）`;
    }
  }
  items.push({
    id: "F29_human_nearness",
    ok: nearOk,
    line: nearLine,
    next: nearOk
      ? "維持・録画→束→自動→再測を週次で回す"
      : `許可線未達（近さ≥${NEARNESS_ALLOW.scoreMin}・短間隔≤${NEARNESS_ALLOW.fast400MaxPct}%・human帯≥${NEARNESS_ALLOW.humanBandMinPct}%）→ 2.8.50再読込→自動1回→ scripts/human-nearness.ts`,
    layer: "human",
  });

  /**
   * ★ 2026-11-17 統括Pro「駅を外すと選ぶを区別する土台」＋竹内さん録画:
   *   通常正本SEQ: 沿線→駅の設定へ→駅外し→沿線の設定へ戻る→沿線。
   *   監査に intent_clear/select と go_without_line（エラー防止）が残ること。
   */
  let intentClearN = 0, intentSelectN = 0, goNoLineN = 0, backLineN = 0, viaNextN = 0;
  {
    const { data: saSt } = await sb
      .from("search_audits")
      .select("steps")
      .gte("created_at", sinceAudit)
      .order("created_at", { ascending: false })
      .limit(40);
    for (const a of saSt || []) {
      for (const s of (Array.isArray(a.steps) ? a.steps : [])) {
        const j = typeof s === "string" ? s : JSON.stringify(s);
        if (/station_intent_clear|line_intent_clear/.test(j)) intentClearN++;
        if (/station_intent_select|line_intent_select/.test(j)) intentSelectN++;
        if (/station_go_without_line|station_clear_blocked_no_line/.test(j)) goNoLineN++;
        if (/station_clear_back_line|沿線の設定へ戻る/.test(j)) backLineN++;
        if (/station_clear_via_next/.test(j)) viaNextN++;
      }
    }
  }
  items.push({
    id: "F30_station_clear_vs_select",
    ok: intentClearN >= 1 && intentSelectN >= 1 && viaNextN + backLineN >= 1,
    line: `駅外し/選び区別 clear意図=${intentClearN} select意図=${intentSelectN} via=${viaNextN} back=${backLineN} 沿線無し阻止=${goNoLineN}（完了線: clear≥1 かつ select≥1 かつ via|back≥1）`,
    next: intentClearN + intentSelectN === 0
      ? "2.8.51再読込→続き客駅検索（外し→選び）。監査に station_intent_clear/select"
      : viaNextN + backLineN === 0
        ? "外しは駅の設定へ→駅外し→沿線の設定へ戻る（正本SEQ）"
        : "維持",
    layer: "human",
  });

  /**
   * ★ 2026-11-17 学習→自動の反映経路:
   *   束の station scene_flows に「駅の設定へ進む／沿線の設定へ戻る」が載っているか、
   *   自動監査に learn_reflect_ok / learn_station_flow_hit が残るか。
   */
  let stationTransitInBundle = false;
  let stationStepsN = 0;
  {
    const steps = Array.isArray(prof?.bundle?.scene_flows)
      ? (prof!.bundle as { scene_flows?: Array<{ scene?: string; steps?: string[] }> }).scene_flows || []
      : [];
    for (const f of steps) {
      if (String(f.scene || "") !== "station") continue;
      const st = Array.isArray(f.steps) ? f.steps : [];
      stationStepsN = st.length;
      if (st.some((x) => /駅の設定へ進む|沿線の設定へ戻る|one_station|one_line/.test(String(x)))) {
        stationTransitInBundle = true;
      }
    }
  }
  let reflectOkN = 0, reflectGapN = 0, stationFlowHitN = 0;
  {
    const { data: saRf } = await sb
      .from("search_audits")
      .select("steps")
      .gte("created_at", sinceAudit)
      .order("created_at", { ascending: false })
      .limit(40);
    for (const a of saRf || []) {
      for (const s of (Array.isArray(a.steps) ? a.steps : [])) {
        const j = typeof s === "string" ? s : JSON.stringify(s);
        if (/learn_reflect_ok/.test(j)) reflectOkN++;
        if (/learn_reflect_gap/.test(j)) reflectGapN++;
        if (/learn_station_flow_hit/.test(j)) stationFlowHitN++;
      }
    }
  }
  items.push({
    id: "F31_learn_reflect_station",
    ok: stationTransitInBundle && (reflectOkN + stationFlowHitN >= 1),
    line: `学習→自動反映 束station遷移=${stationTransitInBundle ? "あり" : "無し"} stepsN=${stationStepsN} reflect_ok=${reflectOkN} flow_hit=${stationFlowHitN} gap=${reflectGapN}（完了線: 束に遷移あり かつ 自動でok/hit≥1）`,
    next: !stationTransitInBundle
      ? "human-learn-profile 再生成（sceneOfOp駅遷移＋録画steps優先マージ）→拡張で束取り直し"
      : reflectOkN + stationFlowHitN === 0
        ? "2.8.53再読込→自動1回（learn_reflect_ok / learn_station_flow_hit）"
        : "維持",
    layer: "free",
  });

  /** F15: カーソル aim有比率（押した位置・人間らしさ） */
  let aimYesN = 0, aimNoN = 0;
  {
    const { data: sa3 } = await sb
      .from("search_audits")
      .select("steps")
      .gte("created_at", sinceAudit)
      .order("created_at", { ascending: false })
      .limit(20);
    for (const a of sa3 || []) {
      for (const s of (Array.isArray(a.steps) ? a.steps : [])) {
        const j = typeof s === "string" ? s : JSON.stringify(s);
        if (!/cursor_aim/.test(j)) continue;
        if (/aim有/.test(j)) aimYesN++;
        else if (/aim無/.test(j)) aimNoN++;
      }
    }
  }
  const aimTotal = aimYesN + aimNoN;
  const aimPct = aimTotal ? Math.round((aimYesN / aimTotal) * 100) : 0;
  items.push({
    id: "F15_cursor_aim_hit",
    ok: aimTotal === 0 ? false : aimPct >= 40,
    line: `カーソルaim aim有=${aimYesN} aim無=${aimNoN}（${aimPct}%・完了線≥40%・標本${aimTotal}）`,
    next: aimPct >= 40
      ? "維持・70%へ（束のaim読込＋2.8.43）"
      : "2.8.43再読込→ポップアップで束取得→自動1回（aim無だらけなら束未読／learn_warm確認）",
    layer: "human",
  });

  /** F16: 検索開始時に束を温めているか（aim有0の主因だった空キャッシュ） */
  let warmN = 0, warmEmpty = 0;
  {
    const { data: sa4 } = await sb
      .from("search_audits")
      .select("steps")
      .gte("created_at", sinceAudit)
      .order("created_at", { ascending: false })
      .limit(20);
    for (const a of sa4 || []) {
      for (const s of (Array.isArray(a.steps) ? a.steps : [])) {
        const j = typeof s === "string" ? s : JSON.stringify(s);
        if (!/learn_warm/.test(j)) continue;
        warmN++;
        if (/points=0\b/.test(j)) warmEmpty++;
      }
    }
  }
  items.push({
    id: "F16_learn_warm",
    ok: warmN > 0 && warmEmpty === 0,
    line: `束温め learn_warm=${warmN} 空束=${warmEmpty}（完了線: ≥1 かつ空=0）`,
    next: warmN === 0
      ? "2.8.43再読込→自動1回（fill先頭で learn_warm 強制）"
      : warmEmpty > 0
        ? "ポップアップで学習再取得→points>0を確認"
        : "維持",
    layer: "human",
  });

  /** F17: 自動操作に was/cs が付いているか（100%への記録土台） */
  let autoOps = 0, autoWas = 0, autoCs = 0;
  for (let i = 0; i < 2000; i += 1000) {
    const { data } = await sb
      .from("human_motion_learn")
      .select("shot_ops")
      .gte("created_at", sinceOps)
      .order("created_at", { ascending: false })
      .range(i, i + 999);
    if (!data?.length) break;
    for (const r of data) {
      for (const o of (Array.isArray(r.shot_ops) ? (r.shot_ops as Array<Record<string, unknown>>) : [])) {
        if (o.by !== "auto") continue;
        autoOps++;
        if (typeof o.was === "boolean") autoWas++;
        if (typeof o.cs === "string" && o.cs) autoCs++;
      }
    }
    if (data.length < 1000) break;
  }
  const autoCsPct = autoOps ? Math.round((autoCs / autoOps) * 100) : 0;
  items.push({
    id: "F17_auto_ops_cs_was",
    ok: autoOps === 0 ? false : autoCsPct >= 50 && autoWas > 0,
    line: `自動ops cs=${autoCs}/${autoOps}(${autoCsPct}%) was=${autoWas}（完了線: cs≥50% かつ was≥1）`,
    next: autoOps === 0
      ? "2.8.43再読込→録画ONで自動1回（by=autoが残るか）"
      : autoWas === 0
        ? "外し/選び1回（CustomEvent腕上げ→was）"
        : "cs比率を上げる",
    layer: "human",
  });

  /** F18: fill途中の段が監査に残っているか（完走前停止でも none を防ぐ） */
  let progN = 0, emptyStepsN = 0, auditSample = 0;
  {
    const { data: sa5 } = await sb
      .from("search_audits")
      .select("steps,status,cause_key")
      .gte("created_at", sinceAudit)
      .order("created_at", { ascending: false })
      .limit(40);
    for (const a of sa5 || []) {
      auditSample++;
      const steps = Array.isArray(a.steps) ? a.steps : [];
      if (steps.length === 0) emptyStepsN++;
      for (const s of steps) {
        const j = typeof s === "string" ? s : JSON.stringify(s);
        if (/fill_progress/.test(j)) progN++;
      }
    }
  }
  items.push({
    id: "F18_fill_progress_steps",
    ok: emptyStepsN < 15 && (progN > 0 || emptyStepsN === 0),
    line: `途中段 fill_progress=${progN} steps空=${emptyStepsN}/${auditSample}（完了線: 空<15 かつ progress≥1 or 空=0）`,
    next: progN === 0
      ? "2.8.44再読込→自動1回（途中で fill_progress が出るか）"
      : emptyStepsN >= 15
        ? "fill-done到達と progress 中継を点検"
        : "維持",
    layer: "free",
  });

  /**
   * ★ 録画から改善する民の土台（F19〜F22）
   *   自動だけ溜まっても通常の手本が無い／キーが欠ける／写真が未読だと回らない。
   */
  let norm24 = 0, normOps24 = 0, normWas24 = 0, normCs24 = 0, normHuman24 = 0, normPf24 = 0, normOpened24 = 0;
  {
    /** F19: 通常録画の鮮度は normalFreshMs（1日）。材料3日窓とは別枠 */
    const sinceFresh = sinceIso(LEARN_PERIODS.normalFreshMs);
    const { data: nr } = await sb
      .from("human_motion_learn")
      .select("shot_ops,point_fields,shot_key")
      .eq("mode", "normal")
      .gte("created_at", sinceFresh)
      .order("created_at", { ascending: false })
      .limit(200);
    for (const r of nr || []) {
      if (!r.shot_key) continue;
      norm24++;
      const sops = Array.isArray(r.shot_ops) ? (r.shot_ops as Array<Record<string, unknown>>) : [];
      if (sops.length) normOps24++;
      if (r.point_fields && typeof r.point_fields === "object" && Object.keys(r.point_fields as object).length) normPf24++;
      for (const o of sops) {
        if (typeof o.was === "boolean") normWas24++;
        if (typeof o.cs === "string" && o.cs) normCs24++;
        if (o.by === "human") normHuman24++;
        if (typeof o.opened === "string" && o.opened) normOpened24++;
      }
    }
  }
  const freshLabel = periodLabelJa(LEARN_PERIODS.normalFreshMs);
  items.push({
    id: "F19_normal_recording_fresh",
    ok: norm24 >= 5 && normOps24 >= 3,
    line: `通常録画${freshLabel} 画像=${norm24} shot_ops付=${normOps24}（完了線: 画像≥5 かつ ops付≥3）`,
    next: norm24 < 5
      ? "通常モードで検索1回＋録画ON（手本を足す）"
      : "リアプロタブを再読込してから録画（古いcontentだとops欠ける）",
    layer: "human",
  });
  items.push({
    id: "F20_rec_ops_keys",
    ok: (normCs24 > 0 || csN > 0) && (normWas24 > 0 || wasN > 0),
    line: `録画キー 通常cs=${normCs24} was=${normWas24} byH=${normHuman24}／全体cs=${csN} was=${wasN}（完了線: cs≥1 かつ was≥1）`,
    next: (normCs24 === 0 && csN === 0)
      ? "API(cs通す)をデプロイ＋拡張2.8.44／タブ再読込後に録画1回"
      : "通常で区or間取りの外し1回（was）",
    layer: "deploy",
  });
  items.push({
    id: "F21_rec_point_fields",
    ok: normPf24 >= 1 || sc.solid >= 30,
    line: `押す位置 point_fields付き通常${freshLabel}=${normPf24}／束solid=${sc.solid}（完了線: 通常≥1 or solid≥30）`,
    next: normPf24 >= 1 || sc.solid >= 30
      ? "維持"
      : "通常モードでボタンを数回押して録画（point_fieldsが残るか）",
    layer: "human",
  });
  items.push({
    id: "F22_rec_opened_dropdown",
    ok: normOpened24 > 0,
    line: `プルダウン展開 opened付き=${normOpened24}（完了線≥1）`,
    next: normOpened24 > 0
      ? "維持"
      : "API(opened通す)デプロイ後、通常で賃料などselectを1回録画",
    layer: "deploy",
  });

  items.push({
    id: "F5_gap_ms",
    ok: opsN === 0 ? false : gN > opsN * 0.3,
    line: `操作間隔 g付き ${gN}/${opsN}`,
    next: "録画側で g を落とさない",
    layer: "free",
  });

  const { data: audits } = await sb
    .from("search_audits")
    .select("created_at, status, mode, cause_key")
    .gte("created_at", sinceAudit)
    .order("created_at", { ascending: false })
    .limit(120);
  const bundleAt = Date.parse(String(prof?.created_at || 0));
  const afterBundle = (audits || []).filter((a) => {
    const t = Date.parse(String(a.created_at));
    return t > bundleAt && /aix|auto|brain_aix/i.test(String(a.mode || ""));
  });
  items.push({
    id: "F6_auto_after_bundle",
    ok: afterBundle.length > 0,
    line: `新束のあとの自動走行 ${afterBundle.length}件（完了線≥1）`,
    next: afterBundle.length ? "効果を数字確認" : "自動/AIXで1回検索",
    layer: "human",
  });

  /**
   * ★ 2026-11-17 統括Pro＋竹内「なんで連携できていない／土台追加」:
   *   録画→束→拡張→自動反映→終わりの合図 の一連を1本の土台で測る（F32）。
   */
  {
    let stepsNonEmpty = 0, stepsSample = 0, progressDbN = 0;
    const { data: saPipe } = await sb
      .from("search_audits")
      .select("steps")
      .gte("created_at", sinceAudit)
      .order("created_at", { ascending: false })
      .limit(40);
    for (const a of saPipe || []) {
      stepsSample++;
      const st = Array.isArray(a.steps) ? a.steps : [];
      if (st.length > 0) stepsNonEmpty++;
      for (const s of st) {
        const j = typeof s === "string" ? s : JSON.stringify(s);
        if (/fill_progress|page:learn_reflect|page:fill_begin/.test(j)) progressDbN++;
      }
    }
    const stepsRate = stepsSample > 0 ? stepsNonEmpty / stepsSample : 0;
    const { fetchBundleReflectHint, buildLinkPipeline } = await import("@/app/lib/bundle-reflect");
    const hintPipe = await fetchBundleReflectHint(sb, { scope: "all" });
    const pipe = buildLinkPipeline({
      photoInStorage: Number((prof?.bundle as { shots?: { in_storage?: number } } | null)?.shots?.in_storage) || norm24,
      withOps: opsN,
      screenSolid: sc.solid,
      screenAll: sc.select + sc.checkbox + sc.solid,
      hint: hintPipe,
      full: true,
      stationTransit: stationTransitInBundle,
      learnReflectHit: reflectOkN + stationFlowHitN >= 1,
      stepsNonEmptyRate: stepsRate,
    });
    items.push({
      id: "F32_link_pipeline",
      ok: pipe.bottleneck_n == null,
      line: `連携一連 ${pipe.line}／progress痕跡=${progressDbN}（完了線: 8段すべて✓）`,
      next: pipe.bottleneck ? `止: ${pipe.bottleneck}` : "維持",
      layer: "free",
    });
  }

  let unreadN = 0;
  {
    const { data: u } = await sb
      .from("human_motion_learn")
      .select("shot_learn")
      .eq("mode", "normal")
      .not("shot_key", "is", null)
      .gte("created_at", sinceOps)
      .limit(500);
    unreadN = (u || []).filter((r) => !r.shot_learn).length;
  }
  items.push({
    id: "F7_unread_photos",
    ok: unreadN < 50,
    line: `未学習通常写真（標本500） ${unreadN}（完了線<50）`,
    next: unreadN < 50 ? "週次で消化" : "shot-learn / weak-strengthen --yes-cost",
    layer: "cost",
  });

  const { data: cmds } = await sb
    .from("automation_commands")
    .select("status")
    .gte("created_at", sinceIso(LEARN_PERIODS.commandsMs))
    .limit(200);
  const pending = (cmds || []).filter((c) => c.status === "pending").length;
  const done = (cmds || []).filter((c) => c.status === "done").length;
  items.push({
    id: "F8_commands_flow",
    ok: pending < 10 && done > 0,
    line: `指示 pending=${pending} done=${done}（pending完了線<10）`,
    next: pending >= 10 ? "拡張を自動/AIXで稼働（滞留消化）" : "維持",
    layer: "human",
  });

  const cause: Record<string, number> = {};
  for (const a of audits || []) {
    const k = String(a.cause_key || a.status || "?");
    cause[k] = (cause[k] || 0) + 1;
  }
  const stalled = cause["stalled:realpro:none"] || 0;
  const pet = cause["condition_drift:realpro:pet:missing"] || 0;
  items.push({
    id: "F9_stalled_signal",
    ok: stalled < 10,
    line: `stalled:realpro:none=${stalled}（完了線<10）`,
    next: "終わりの合図（fill-done/steps）経路を直す",
    layer: "free",
  });
  items.push({
    id: "F10_pet_condition",
    ok: pet < 3,
    line: `pet:missing=${pet}（完了線<3）`,
    next: "ペット可の見える化→チェック→検索前検証",
    layer: "free",
  });

  /**
   * ★ 2026-11-17 統括Proを全体の脳に: Pro が毎回判断できる材料が束・ログに揃っているか。
   *   完了線: foundation_auditあり・主要Fキー≥6・統括ログ24hにPro根拠あり・vision連携行あり。
   */
  {
    const fa = (prof?.bundle as { foundation_audit?: { key?: Record<string, unknown>; summary?: string } } | null)?.foundation_audit;
    const keyN = fa?.key && typeof fa.key === "object" ? Object.keys(fa.key).length : 0;
    const hasFa = !!(fa && (fa.summary || keyN > 0));
    const { data: logRows } = await sb
      .from("learn_supervisor_log")
      .select("meeting,created_at,scope")
      .in("scope", site !== "all" ? [markSite, "all"] : ["all", "realpro", "itandi"])
      .gte("created_at", sinceAudit)
      .order("created_at", { ascending: false })
      .limit(80);
    let proInLog = 0;
    for (const r of logRows || []) {
      const ev = Array.isArray((r.meeting as { evidence?: Array<{ label?: string }> } | null)?.evidence)
        ? (r.meeting as { evidence: Array<{ label?: string }> }).evidence
        : [];
      if (ev.some((e) => /統括Pro|足りない土台/.test(String(e.label || "")))) proInLog++;
    }
    const supEv = Array.isArray((prof?.bundle as { supervisor?: { meeting?: { evidence?: Array<{ label?: string }> } } } | null)?.supervisor?.meeting?.evidence)
      ? (prof!.bundle as { supervisor: { meeting: { evidence: Array<{ label?: string }> } } }).supervisor.meeting.evidence
      : [];
    const hasVision = supEv.some((e) => /画像学習→統括Pro|学習APIの役割/.test(String(e.label || "")));
    const hasMech = supEv.some((e) => /学習の仕組み/.test(String(e.label || "")));
    const okBrain = hasFa && keyN >= 6 && proInLog >= 1 && hasVision && hasMech;
    items.push({
      id: "F34_pro_brain_ready",
      ok: okBrain,
      line: `統括Pro脳材料 fa=${hasFa ? "有" : "無"} key=${keyN} ログPro=${proInLog} vision=${hasVision ? "✓" : "✗"} 仕組み=${hasMech ? "✓" : "✗"}（完了線: fa・key≥6・ログPro≥1・vision・仕組み）`,
      next: !hasFa || keyN < 6
        ? "束に foundation_audit を載せる（profile / patch）"
        : proInLog < 1
          ? "supervisor-pro --save（Pro根拠をログへ・同束でもPro新規は更新）"
          : !hasVision || !hasMech
            ? "束の統括根拠に vision / 学習の仕組み を残す"
            : "維持",
      layer: "free",
    });

    /**
     * ★ F37 2026-11-17: 統括Proが設計知見RAGで学習・決まりを引いているか
     *   完了線: 直近2日の統括ログに「統括Pro RAG」かつ件数≥1、設計知見埋め込みが現行の95%以上。
     */
    let ragHitN = 0;
    let ragOkN = 0;
    {
      let qRag = sb
        .from("learn_supervisor_log")
        .select("meeting")
        .gte("created_at", sinceOps);
      if (site !== "all") qRag = qRag.eq("scope", markSite);
      const { data: logsRag } = await qRag
        .order("created_at", { ascending: false })
        .limit(120);
      for (const row of logsRag || []) {
        const ev = (row.meeting as { evidence?: Array<{ label?: string; value?: string }> } | null)
          ?.evidence || [];
        for (const e of ev) {
          if (!/統括Pro RAG/.test(String(e.label || ""))) continue;
          ragHitN++;
          if (/RAG [1-9]\d*件/.test(String(e.value || ""))) ragOkN++;
        }
      }
    }
    const { count: kbCur } = await sb
      .from("system_design_thinking")
      .select("id", { count: "exact", head: true })
      .eq("is_current", true);
    const { count: kbEmb } = await sb
      .from("system_design_thinking")
      .select("id", { count: "exact", head: true })
      .eq("is_current", true)
      .not("embedding", "is", null);
    const kbN = kbCur ?? 0;
    const embN = kbEmb ?? 0;
    const embPct = kbN ? Math.round((embN / kbN) * 100) : 0;
    const okRag = ragOkN >= 1 && embPct >= 95;
    items.push({
      id: "F37_pro_rag_brain",
      ok: okRag,
      line: `統括Pro RAG引き ログRAG成功=${ragOkN}/${ragHitN} 設計知見埋め込み=${embN}/${kbN}（${embPct}%）`
        + `（完了線: ログにRAG≥1件成功・埋め込み≥95%）`,
      next: embPct < 95
        ? "scripts/kb-embed.ts で埋め込みを埋める"
        : ragOkN < 1
          ? "supervisor-pro --save（RAG配線後の判断をログへ）"
          : "維持",
      layer: "free",
    });
  }

  /**
   * ★ 2026-11-17 竹内さん「学習・改善はデータベースに入るようになっているのか」＋統括Pro:
   *   学習の**保管**（shot_learn・束solid・統括ログ）と、**自動への反映印**（F31）は別。
   *   保管が生きているかを1本の土台で測る（消える／書けない穴を見逃さない）。
   */
  {
    const sinceShot = sinceIso(LEARN_PERIODS.materialsMs);
    const sinceLog = sinceIso(LEARN_PERIODS.logMemoryMs);
    const { count: shotLearnN } = await sb
      .from("human_motion_learn")
      .select("id", { count: "exact", head: true })
      .not("shot_learn", "is", null)
      .gte("created_at", sinceShot);
    const { count: logN } = await sb
      .from("learn_supervisor_log")
      .select("id", { count: "exact", head: true })
      .gte("created_at", sinceLog);
    // 2026-11-21 作業員G（#588 ②・LEARN_HISTORY_SLIM=on の時だけ）: F33・F35 は束の shots.learned だけを数える → 束を丸ごと読まない（5行＋12行）
    const slimHist = (await import("./learn-bundle-preserve")).learnHistorySlimOn();
    const histSel = slimHist ? "created_at,source_rows,learned:bundle->shots->learned" : "created_at,bundle,source_rows";
    const histRow = (r: Record<string, unknown>) => (slimHist ? { ...r, bundle: { shots: { learned: r.learned } } } : r) as { created_at?: string; source_rows?: number; bundle?: unknown };
    const { data: last2raw } = await sb
      .from("human_learn_profile")
      .select(histSel)
      .eq("scope", "all")
      .order("created_at", { ascending: false })
      .limit(5);
    const solidOf = (b: unknown) => {
      const learned = (b as { shots?: { learned?: unknown } } | null)?.shots?.learned;
      let solid = 0;
      if (learned && typeof learned === "object") {
        for (const list of Object.values(learned as Record<string, unknown>)) {
          for (const f of Array.isArray(list) ? list : []) {
            const rec = f as { x?: unknown; y?: unknown; n?: unknown };
            if (typeof rec?.x === "number" && typeof rec?.y === "number" && (Number(rec.n) || 0) >= 3) solid++;
          }
        }
      }
      return solid;
    };
    const last2 = ((last2raw || []) as unknown as Array<Record<string, unknown>>).map(histRow);
    const solids = last2.map((r) => solidOf(r.bundle));
    const latestSolid = solids[0] ?? 0;
    const hadSolid = solids.some((n) => n >= 30);
    const wiped = latestSolid === 0 && hadSolid && solids.slice(1).some((n) => n >= 30);
    const slN = shotLearnN ?? 0;
    const lgN = logN ?? 0;
    const okPersist = slN >= 50 && latestSolid >= 30 && lgN >= 1 && !wiped;
    items.push({
      id: "F33_learn_db_persist",
      ok: okPersist,
      line: `学習DB保管 shot_learn${periodLabelJa(LEARN_PERIODS.materialsMs)}=${slN} 最新束solid=${latestSolid} 統括ログ${periodLabelJa(LEARN_PERIODS.logMemoryMs)}=${lgN}`
        + (wiped ? " ⚠履歴にsolidありなのに最新0（消失）" : "")
        + `（完了線: shot_learn≥50・solid≥30・ログ≥1・消失なし）`,
      next: wiped
        ? "束の学習引き継ぎ（直近20件）を確認／freshで消さない"
        : latestSolid < 30
          ? "弱い強化反映 or 履歴からlearned復元"
          : slN < 50
            ? "shot-learn / weak-strengthen で通常画像を書く"
            : lgN < 1
              ? "supervisor-pro --save で統括ログを残す"
              : "維持",
      layer: wiped || latestSolid < 30 ? "free" : "cost",
    });

    /**
     * ★ F35 2026-11-17: 消す書き込みの抜け穴監視
     *   直近12件で solid≥30 → 直後 solid=0 が1回でもあれば「拒否ゲート未効／未デプロイ」。
     *   完了線: その連鎖0 かつ 最新 solid≥30（履歴に良い束がある時）。
     */
    const { data: last12raw } = await sb
      .from("human_learn_profile")
      .select(histSel)
      .eq("scope", "all")
      .order("created_at", { ascending: false })
      .limit(12);
    const last12 = ((last12raw || []) as unknown as Array<Record<string, unknown>>).map(histRow);
    const solidSeq = last12.map((r) => ({
      at: String(r.created_at || ""),
      rows: Number(r.source_rows) || 0,
      solid: solidOf(r.bundle),
    }));
    /**
     * ★ 2026-11-17: 「今も消す書き込みが起きているか」＝**最新行が消失か**だけ見る。
     *   復元後に窓内の旧消失（例: 96→0→96）を数えると、関所が効いているのに永遠に✗になる。
     *   窓12の合計は参考表示。完了線: 最新が消失でない・履歴良い時は最新solid≥30。
     */
    let wipeEvents = 0;
    for (let i = 0; i < solidSeq.length - 1; i++) {
      // 新しい→古い: i が新、i+1 が旧。旧≥30 で新=0 なら消失書き込み
      if (solidSeq[i + 1].solid >= 30 && solidSeq[i].solid === 0) wipeEvents++;
    }
    const latestSolidNow = solidSeq[0]?.solid ?? 0;
    const wipeAtHead = solidSeq.length >= 2
      && solidSeq[1].solid >= 30
      && latestSolidNow === 0;
    const histGood = solidSeq.some((x) => x.solid >= 30);
    const okWipeGate = !wipeAtHead && (!histGood || latestSolidNow >= 30);
    items.push({
      id: "F35_wipe_write_gate",
      ok: okWipeGate,
      line: `消す書き込みゲート 最新消失=${wipeAtHead ? 1 : 0}（窓12合計=${wipeEvents}）最新solid=${latestSolidNow}`
        + `（完了線: 最新が消失でない・履歴良い時は最新solid≥30）`,
      next: wipeAtHead
        ? "learn-bundle-preserve の拒否を全書き込み経路へ／本番デプロイ確認"
        : latestSolidNow < 30 && histGood
          ? "履歴からlearned復元（tmp-restore-link-bundle）"
          : "維持",
      layer: wipeAtHead || (latestSolidNow < 30 && histGood) ? "free" : "cost",
    });

    /**
     * ★ F36 2026-11-17 統括Pro「抜けが後から出る構造原因＝書き込み関所が無い」:
     *   **最新の重い再生成**が solid≥30 か preserved_learned（過去の消失束に引きずられない）。
     *   直近3件の重い違反数は参考表示。完了線: 最新が関所通過 かつ 直近消失0。
     */
    let latestHeavyOk = true;
    let latestHeavyNote = "重い再生成なし";
    let heavyBadRecent = 0;
    let heavyRecentN = 0;
    for (const row of last12 || []) {
      const rowsN = Number(row.source_rows) || 0;
      if (rowsN < 5000) continue;
      const sol = solidOf(row.bundle);
      const preserved = !!(row.bundle as { shots?: { preserved_learned?: boolean } } | null)?.shots?.preserved_learned;
      const pass = sol >= 30 || preserved;
      if (heavyRecentN === 0) {
        latestHeavyOk = pass;
        latestHeavyNote = `最新重い rows=${rowsN} solid=${sol} preserved=${preserved}`;
      }
      if (heavyRecentN < 3) {
        heavyRecentN++;
        if (!pass) heavyBadRecent++;
      }
      if (heavyRecentN >= 3) break;
    }
    const okPathGate = latestHeavyOk && !wipeAtHead;
    items.push({
      id: "F36_write_path_gate",
      ok: okPathGate,
      line: `書き込み関所 ${latestHeavyNote} 直近重い違反=${heavyBadRecent}/${Math.max(heavyRecentN, 1)} 最新消失=${wipeAtHead ? 1 : 0}`
        + `（完了線: 最新の重い再生成が solid≥30|preserved かつ最新が消失でない）`,
      next: !okPathGate
        ? "全insertに inheritLinkFoundations／learn-write-path-gate テスト／本番デプロイ"
        : "維持（新経路追加時は関所テストを先に通す）",
      layer: !okPathGate ? "free" : "cost",
    });
  }

  /**
   * ★ F38 2026-11-17 竹内さん「学習しても改善されない／拡張への反映」:
   *   束 solid≥30 かつ拡張読込(read≥1) かつ 新束後の自動≥1 で「反映一連」完了。
   *   読むだけで終わっている時（needs_auto）を ✗ として手配に載せる。
   */
  {
    const readN = Number(prof?.read_count) || 0;
    const autoN = afterBundle.length;
    const okReflect = sc.solid >= 30 && readN >= 1 && autoN >= 1;
    items.push({
      id: "F38_improve_reflect_chain",
      ok: okReflect,
      line: `改善反映一連 solid=${sc.solid} read=${readN} 新束後自動=${autoN}`
        + `（完了線: solid≥30・read≥1・新束後自動≥1）`,
      next: okReflect
        ? "維持（次の束でも自動1回で効果確認）"
        : sc.solid < 30
          ? "弱い強化／履歴からlearned復元"
          : readN < 1
            ? "拡張を再読込（popup開く／自動モード開始）"
            : "自動モードで1回検索（読む→使うの切れ目を塞ぐ）",
      layer: "human",
    });
  }

  /**
   * ★ F39 2026-11-17 竹内さん「場当たりより根本の仕組み」＋統括Pro:
   *   パネル開いたら負債→確定清算（_axPanelDebt）。
   *   完了線: 直近自動監査に panel_debt_open と panel_settle_ok（または modal_confirm）が両方ある。
   */
  {
    let openN = 0;
    let settleN = 0;
    let confirmN = 0;
    const { data: panelAudits } = await sb
      .from("search_audits")
      .select("steps,ext_version,mode")
      .eq("site", markSite)
      .in("mode", ["brain_aix", "aix", "auto"])
      .order("created_at", { ascending: false })
      .limit(40);
    for (const a of panelAudits || []) {
      const steps = Array.isArray(a.steps) ? a.steps : [];
      const joined = steps.map((s) => {
        if (typeof s === "string") return s;
        const o = s as { k?: string; t?: string };
        return String(o.k || o.t || "");
      }).join("|");
      if (/panel_debt_open/.test(joined)) openN++;
      if (/panel_settle_ok|panel_debt_clear/.test(joined)) settleN++;
      if (/modal_confirm|pet_panel_confirm|clear_panel_confirm/.test(joined)) confirmN++;
    }
    const okPanel = openN >= 1 && (settleN >= 1 || confirmN >= 1);
    items.push({
      id: "F39_panel_debt_settle",
      ok: okPanel,
      line: `パネル負債→確定清算 open=${openN} settle=${settleN} confirm=${confirmN}`
        + `（完了線: 自動監査に open≥1 かつ settle/confirm≥1）`,
      next: okPanel
        ? "維持（場当たり必押を増やさず負債清算を通す）"
        : "拡張2.8.66再読込→自動1回（panel_debt_open / panel_settle_ok を監査で確認）",
      layer: "free",
    });
  }

  /**
   * ★ F40 2026-11-17 竹内さん「路線画面ほかの構造把握／把握力が足りない」:
   *   画面 kind（line_list/station_list/ward_list）を読んでから外す・入れる。
   *   完了線: 直近自動監査に screen_grasp がある。
   */
  {
    let graspN = 0;
    let wrongN = 0;
    const { data: graspAudits } = await sb
      .from("search_audits")
      .select("steps,mode")
      .eq("site", markSite)
      .in("mode", ["brain_aix", "aix", "auto"])
      .order("created_at", { ascending: false })
      .limit(40);
    for (const a of graspAudits || []) {
      const steps = Array.isArray(a.steps) ? a.steps : [];
      const joined = steps.map((s) => {
        if (typeof s === "string") return s;
        const o = s as { k?: string; t?: string };
        return String(o.k || o.t || "");
      }).join("|");
      if (/screen_grasp/.test(joined)) graspN++;
      if (/wrong_screen|screen_reopen_after_clear/.test(joined)) wrongN++;
    }
    const okGrasp = graspN >= 1;
    items.push({
      id: "F40_screen_grasp",
      ok: okGrasp,
      line: `画面把握 screen_grasp=${graspN} wrong/reopen印=${wrongN}`
        + `（完了線: 自動監査に screen_grasp≥1）`,
      next: okGrasp
        ? "維持（誤画面操作を screen_grasp で止める）"
        : "拡張2.8.69再読込→自動1回（screen_grasp: station=line_list|station_list）",
      layer: "free",
    });
  }

  /**
   * ★ F41 2026-11-17 統括Pro「done印が録画に残っていない／ボタン理解を終わらせる」:
   *   選ぶ済/外す済/押す済・理解台帳が shot_ops に残る（2.8.76+）。
   */
  {
    let doneN = 0;
    let ledgerN = 0;
    /** 済印の直近確認は logMemoryMs（把握用短窓）。材料3日と混ぜない */
    const sinceDone = sinceIso(LEARN_PERIODS.logMemoryMs);
    const { data: doneRows } = await sb
      .from("human_motion_learn")
      .select("shot_ops,ext_version,mode,install_id")
      .eq("site", markSite)
      // 済印は自動（aix）の記録にだけ付く。normal を混ぜると通常の行で先頭が埋まり 0 になる
      .in("mode", ["aix", "auto", "brain_aix"])
      .gte("created_at", sinceDone)
      .order("created_at", { ascending: false })
      // 済印は直近の行ほど輪から落ちている（実測: 最初に出るのが先頭から約176行目）→ 300行読む
      .limit(300);
    // 写真ごとに直前の操作の輪を丸ごと入れているので、行をまたいで重複を除いて数える
    const seenDone = new Set<string>();
    for (const r of doneRows || []) {
      const inst = r.install_id == null ? "" : String(r.install_id);
      for (const o of Array.isArray(r.shot_ops) ? r.shot_ops : []) {
        const oo = o as { f?: string; t?: unknown; k?: unknown };
        const f = String(oo.f || "");
        const isDone = /選ぶ済:|外す済:|押す済:|_done_select|_done_clear|_press_ok/.test(f);
        const isLedger = /理解台帳|btn_understand/.test(f);
        if (!isDone && !isLedger) continue;
        if (Number.isFinite(Number(oo.t))) {
          const key = `${inst}|${Number(oo.t)}|${String(oo.k ?? "")}|${f}`;
          if (seenDone.has(key)) continue;
          seenDone.add(key);
        }
        if (isDone) doneN++;
        if (isLedger) ledgerN++;
      }
    }
    const okDone = doneN >= 1;
    items.push({
      id: "F41_button_done_marks",
      ok: okDone,
      line: `ボタン理解済印 done印=${doneN} 理解台帳=${ledgerN}`
        + `（完了線: shot_opsに選ぶ済/外す済/押す済≥1・2.8.76+再読込後・自動(aix/auto/brain_aix)の直近${(doneRows || []).length}行・重複除去済み）`,
      next: okDone
        ? "維持（済印で弱いボタンを測る）"
        : "拡張2.8.76再読込→自動1回（選ぶ済:station_id[] / 理解台帳）",
      layer: "human",
    });
  }

  /**
   * ★ F42 2026-11-17 統括Pro「台帳外ゴミを課題に出さない関所」:
   *   1DK・区名・路線名の生値を photo_learn 対象にしない（catalogTargetsOnly）。
   *   完了線: 関所関数が課題を台帳正名だけに落とせる。
   */
  {
    let gateOk = false;
    let sample = "";
    try {
      const { catalogTargetsOnly } = await import("./button-catalog-targets");
      const catSite = markSite;
      const raw = catSite === "itandi"
        ? ["1DK", "大阪市北区", "大阪メトロ御堂筋線", "search", "ゴミXYZ", "room_layout:in"]
        : ["1DK", "大阪市北区", "大阪市高速軌道御堂筋線", "確定してリストへ", "ゴミXYZ"];
      const kept = catalogTargetsOnly(raw, catSite);
      const hasLayout = catSite === "itandi"
        ? kept.includes("room_layout:in")
        : kept.includes("room_layout_id[]");
      const hasCity = catSite === "itandi"
        ? kept.includes("city_radio")
        : kept.includes("city_code[]");
      const hasRoute = catSite === "itandi"
        ? kept.includes("line_checkbox")
        : kept.includes("route_id[]");
      const hasConfirm = catSite === "itandi"
        ? kept.includes("search") || kept.includes("modal_confirm")
        : kept.includes("確定してリストへ");
      const noGarbage = !kept.some((k) => /ゴミ|XYZ|1DK|大阪市北区|御堂筋線/.test(k));
      gateOk = hasLayout && hasCity && hasRoute && hasConfirm && noGarbage;
      sample = `${catSite}:` + kept.slice(0, 6).join("・");
    } catch (e) {
      gateOk = false;
      sample = String((e as Error)?.message || e).slice(0, 60);
    }
    items.push({
      id: "F42_catalog_targets_gate",
      ok: gateOk,
      line: `台帳関所 catalogTargetsOnly(${markSite}) ${gateOk ? "✓" : "✗"} → ${sample || "-"}`
        + `（完了線: 値・区名・路線名を欄に写し台帳外を落とす・サイト別台帳）`,
      next: gateOk
        ? "維持（weak-strengthen は台帳正名のみ・サイト混ぜない）"
        : "app/lib/button-catalog-targets.ts と realpro/itandi-buttons を確認",
      layer: "free",
    });
  }

  /**
   * ★ F43 2026-11-17 竹内さん「改善したら自動モードに連動」＋統括Pro:
   *   新束後の自動に learn_reflect_ok が残ること（読むだけ・aim無のまま完了を ✗）。
   *   完了線: 新束後の自動監査に learn_reflect_ok≥1 かつ aim有≥1。
   */
  {
    let okLink = false;
    let reflectOkN = 0;
    let aimYesN = 0;
    let aimNoN = 0;
    let gateN = 0;
    const bundleAt = typeof prof?.created_at === "string" ? prof.created_at : null;
    if (bundleAt) {
      const { data: linkAud } = await sb
        .from("search_audits")
        .select("steps,ext_version,mode,created_at")
        .eq("site", markSite)
        .in("mode", ["brain_aix", "aix", "auto"])
        .gte("created_at", bundleAt)
        .order("created_at", { ascending: false })
        .limit(20);
      for (const a of linkAud || []) {
        const steps = Array.isArray(a.steps) ? a.steps : [];
        const joined = steps.map((s) => {
          if (typeof s === "string") return s;
          const o = s as { k?: string; d?: string };
          return `${o.k || ""} ${o.d || ""}`;
        }).join("|");
        if (/learn_reflect_ok/.test(joined)) reflectOkN++;
        if (/learn_reflect_gate/.test(joined)) gateN++;
        if (/aim有/.test(joined)) aimYesN++;
        if (/aim無/.test(joined)) aimNoN++;
      }
    }
    okLink = reflectOkN >= 1 && aimYesN >= 1;
    items.push({
      id: "F43_improve_to_auto_link",
      ok: okLink,
      line: `改善→自動連動 reflect_ok=${reflectOkN} gate=${gateN} aim有=${aimYesN} aim無=${aimNoN}`
        + `（完了線: 新束後自動に learn_reflect_ok≥1 かつ aim有≥1）`,
      next: okLink
        ? "維持（次の改善でも reflect_ok→aim有 を確認）"
        : "2.8.78再読込＋リアプロタブ再読込→popup→自動1回（印がstepsから消えないこと）",
      layer: "human",
    });
  }

  /**
   * ★ F44 2026-11-17 竹内さん「次客が溜まって乗り換え・強制更新のあと壊れる」＋統括Pro:
   *   handoff 原子（owner_mismatch / no_fill_start / tab_reload / supersede）が測れること。
   *   完了線: 直近自動に handoff 異常が減り、reload_skip_other_fill / force_clear_skip が効く版≥2.8.79。
   */
  {
    let ownerN = 0, noFillN = 0, reloadN = 0, superN = 0, skipN = 0, v279 = 0;
    const { data: hoAud } = await sb
      .from("search_audits")
      .select("steps,ext_version,mode,result")
      .eq("site", markSite)
      .in("mode", ["brain_aix", "aix", "auto"])
      .order("created_at", { ascending: false })
      .limit(40);
    for (const a of hoAud || []) {
      const v = String(a.ext_version || "");
      const isV279 = /^2\.8\.(79|[89]\d|[1-9]\d{2,})/.test(v);
      if (isV279) v279++;
      const steps = Array.isArray(a.steps) ? a.steps : [];
      const joined = steps.map((s) => {
        if (typeof s === "string") return s;
        const o = s as { k?: string; d?: string };
        return `${o.k || ""} ${o.d || ""}`;
      }).join("|") + "|" + String(a.result || "");
      // ★ 2026-11-18: 完了線「2.8.79以降の自動で owner/no_fill=0」と一致させ、旧版(2.8.31等)は合否に混ぜない
      if (isV279) {
        if (/owner_mismatch/.test(joined)) ownerN++;
        if (/no_fill_start|NO_FILL_START/.test(joined)) noFillN++;
        if (/tab_reload/.test(joined)) reloadN++;
        if (/supersede/.test(joined)) superN++;
        if (/reload_skip_other_fill|force_clear_skip|fill_started_inferred/.test(joined)) skipN++;
      }
    }
    const harm = ownerN + noFillN;
    const okHandoff = v279 >= 1 && harm === 0;
    items.push({
      id: "F44_next_customer_handoff",
      ok: okHandoff,
      line: `次客handoff v279+=${v279} owner=${ownerN} no_fill=${noFillN} reload=${reloadN} supersede=${superN} skip印=${skipN}`
        + `（完了線: 2.8.79以降の自動で owner/no_fill=0）`,
      next: okHandoff
        ? "維持（次客連続でも force_clear_skip / reload_skip を確認）"
        : "2.8.79再読込＋リアプロタブ再読込→次客が溜まった状態で自動連続2客",
      layer: "human",
    });
  }

  /**
   * ★ F45 2026-11-17 竹内さん「完了したら次客／何が完了か理解／手順を1つずつ」＋統括Pro:
   *   flow_done_* / flow_understand_ledger / series_done が自動監査に残ること。
   *   完了線: 2.8.80以降の自動で place+conditions+search+fill_done+ready_next の印≥1。
   */
  {
    let v280 = 0, placeN = 0, condN = 0, searchN = 0, fillN = 0, readyN = 0, ledgerN = 0, seriesN = 0, gapN = 0;
    const { data: flAud } = await sb
      .from("search_audits")
      .select("steps,ext_version,mode")
      .eq("site", markSite)
      .in("mode", ["brain_aix", "aix", "auto"])
      .order("created_at", { ascending: false })
      .limit(40);
    for (const a of flAud || []) {
      const v = String(a.ext_version || "");
      if (/^2\.8\.(8\d|[9]\d|[1-9]\d{2,})/.test(v) || v === "2.8.80") v280++;
      const steps = Array.isArray(a.steps) ? a.steps : [];
      const joined = steps.map((s) => {
        if (typeof s === "string") return s;
        const o = s as { k?: string; d?: string };
        return `${o.k || ""} ${o.d || ""}`;
      }).join("|");
      if (/flow_done_place/.test(joined)) placeN++;
      if (/flow_done_conditions/.test(joined)) condN++;
      if (/flow_done_search/.test(joined)) searchN++;
      if (/flow_done_fill_done/.test(joined)) fillN++;
      if (/flow_done_ready_next|series_done/.test(joined)) { readyN++; seriesN++; }
      if (/flow_understand_ledger/.test(joined)) ledgerN++;
      if (/flow_gap_/.test(joined)) gapN++;
    }
    const okFlow = v280 >= 1 && placeN >= 1 && condN >= 1 && searchN >= 1 && fillN >= 1 && readyN >= 1;
    items.push({
      id: "F45_flow_completion_ledger",
      ok: okFlow,
      line: `完了理解台帳 v280+=${v280} place=${placeN} cond=${condN} search=${searchN} fill=${fillN} ready=${readyN} ledger=${ledgerN} series=${seriesN} gap=${gapN}`
        + `（完了線: 2.8.80以降で place〜ready_next 各≥1）`,
      next: okFlow
        ? "維持（連続2客で series_done→次客切替を確認）"
        : "2.8.80再読込＋リアプロタブ再読込→自動1客完走で flow_done_* を確認→連続2客",
      layer: "human",
    });
  }

  /**
   * ★ F46 2026-11-17 竹内さん「流れの弱い部分を録画から強化→自動に反映」:
   *   learn_flow_reflect_ok / now_customer が自動監査に残ること。
   *   完了線: 2.8.81以降で learn_flow_reflect_ok≥1 かつ now_customer≥1。
   */
  {
    let v281 = 0, flowRefOk = 0, flowRefGap = 0, nowCust = 0;
    const { data: frAud } = await sb
      .from("search_audits")
      .select("steps,ext_version,mode")
      .eq("site", markSite)
      .in("mode", ["brain_aix", "aix", "auto"])
      .order("created_at", { ascending: false })
      .limit(40);
    for (const a of frAud || []) {
      const v = String(a.ext_version || "");
      if (/^2\.8\.(81|8[2-9]|9\d|[1-9]\d{2,})/.test(v) || v === "2.8.81") v281++;
      const steps = Array.isArray(a.steps) ? a.steps : [];
      const joined = steps.map((s) => {
        if (typeof s === "string") return s;
        const o = s as { k?: string; d?: string };
        return `${o.k || ""} ${o.d || ""}`;
      }).join("|");
      if (/learn_flow_reflect_ok/.test(joined)) flowRefOk++;
      if (/learn_flow_reflect_gap/.test(joined)) flowRefGap++;
      if (/now_customer/.test(joined)) nowCust++;
    }
    const okFr = v281 >= 1 && flowRefOk >= 1 && nowCust >= 1;
    items.push({
      id: "F46_flow_record_to_auto",
      ok: okFr,
      line: `録画流れ→自動 v281+=${v281} flow_reflect_ok=${flowRefOk} gap=${flowRefGap} now_customer=${nowCust}`
        + `（完了線: 2.8.81以降で reflect_ok≥1 かつ now_customer≥1）`,
      next: okFr
        ? "維持（weak-strengthen の流れF46→自動1回で印を確認）"
        : "2.8.81再読込＋リアプロタブ再読込→自動1回で learn_flow_reflect_* / now_customer を確認",
      layer: "human",
    });
  }

  /**
   * ★ F47 2026-11-17 統括Pro徹底「全流れ地図／ボタン・外し／細分化強化の仕組み」:
   *   flow_map_ledger + flow_subdivide_* + clear_method_* + line_station_map が自動監査に残ること。
   *   既存 F45/F46/F41/地図を活用し、弱い原子だけ次手にする（新規地図を増やさない）。
   *   完了線: 2.8.84以降で flow_map_ledger≥1 かつ (flow_subdivide_need|ok)≥1 かつ clear_method or line_station_map≥1。
   */
  {
    let v284 = 0, mapLed = 0, subN = 0, clearN = 0, lsMap = 0, btnLed = 0;
    const { data: fmAud } = await sb
      .from("search_audits")
      .select("steps,ext_version,mode")
      .eq("site", markSite)
      .in("mode", ["brain_aix", "aix", "auto"])
      .order("created_at", { ascending: false })
      .limit(40);
    for (const a of fmAud || []) {
      const v = String(a.ext_version || "");
      if (/^2\.8\.(84|8[5-9]|9\d|[1-9]\d{2,})/.test(v) || v === "2.8.84") v284++;
      const steps = Array.isArray(a.steps) ? a.steps : [];
      const joined = steps.map((s) => {
        if (typeof s === "string") return s;
        const o = s as { k?: string; d?: string };
        return `${o.k || ""} ${o.d || ""}`;
      }).join("|");
      if (/flow_map_ledger/.test(joined)) mapLed++;
      if (/flow_subdivide_(need|ok)/.test(joined)) subN++;
      if (/clear_method_/.test(joined)) clearN++;
      if (/line_station_map/.test(joined)) lsMap++;
      if (/btn_understand_ledger/.test(joined)) btnLed++;
    }
    const okFm = v284 >= 1 && mapLed >= 1 && subN >= 1 && (clearN >= 1 || lsMap >= 1);
    items.push({
      id: "F47_flow_map_subdivide",
      ok: okFm,
      line: `全流れ地図細分化 v284+=${v284} map_ledger=${mapLed} subdivide=${subN} clear_method=${clearN} line_station_map=${lsMap} btn_ledger=${btnLed}`
        + `（完了線: 2.8.84以降で map_ledger≥1・subdivide≥1・clear|line_map≥1）`,
      next: okFm
        ? "維持（flow_subdivide_need の弱い原子を1つずつREALPRO_BUTTONS順で強化）"
        : "2.8.84再読込＋リアプロタブ再読込→自動1回で flow_map_ledger / flow_subdivide_* / clear_method_* を確認",
      layer: "human",
    });
  }

  /**
   * ★ F48 2026-11-17 竹内さん「この考え方をかなり大切にする」＋統括Pro:
   *   脳として機能する＝弱点がすぐ分かる／改善に必要が分かる／強化の仕方が分かる／
   *   土台を追加できる／録画からも学べる。材料が揃っているかを測る。
   *   完了線: F34脳材料✓ かつ F46|scene反映の印≥1 かつ（F47 map_ledger|subdivide≥1 または F45 ledger≥1）。
   */
  {
    const f34 = items.find((x) => x.id === "F34_pro_brain_ready");
    const f45 = items.find((x) => x.id === "F45_flow_completion_ledger");
    const f46 = items.find((x) => x.id === "F46_flow_record_to_auto");
    const f47 = items.find((x) => x.id === "F47_flow_map_subdivide");
    const brainMat = !!f34?.ok;
    /** ★ 録画学習路は F46 必須（F45だけでは「録画→自動」が回っていない） */
    const recLearn = !!f46?.ok;
    const mapVis = !!f47?.ok;
    const flowVis = !!f45?.ok;
    const okBrain = brainMat && recLearn && mapVis && flowVis;
    items.push({
      id: "F48_pro_brain_loop",
      ok: okBrain,
      line: `統括Pro脳ループ 脳材料=${brainMat ? "✓" : "✗"} 録画学習路(F46)=${recLearn ? "✓" : "✗"} 地図細分化(F47)=${mapVis ? "✓" : "✗"} 完了台帳(F45)=${flowVis ? "✓" : "✗"}`
        + `（完了線: F34∧F45∧F46∧F47 すべて✓＝弱点がすぐ分かり録画から学べる）`,
      next: okBrain
        ? "維持（weak_fixes→build_next→自動1回→効果確認を脳の指揮で回す）"
        : "2.8.85再読込＋タブ再読込→自動1回で now_customer/learn_flow_reflect/flow_map_ledger を監査に残す→F46/F47/F48",
      layer: "human",
    });
  }

  /**
   * ★ F49 2026-11-17 統括Pro: 写真→統括連携の数え方が事実と矛盾しない関所。
   *   実測: 束 in_storage=9923・通常学べ1799 なのに vision_link 段1「写真が無い」
   *   （サイト別に shot_bytes/photo_kinds 未配線）。
   *   完了線: 束に写真があるなら vision 段1✓。学べがあるなら段3（種類|画像欄）も✓。
   */
  {
    const bWrap = prof?.bundle as {
      shots?: { in_storage?: number; kinds?: Record<string, number> };
      bundle_reflect?: { photo_in_storage?: number };
    } | null;
    const shots = bWrap?.shots;
    const inStore =
      Number(shots?.in_storage)
      || Number(bWrap?.bundle_reflect?.photo_in_storage)
      || 0;
    const kindsBundle = shots?.kinds ? Object.values(shots.kinds).reduce((a, b) => a + (Number(b) || 0), 0) : 0;
    type Vpl = {
      counts?: { photo_in_storage?: number; learned_ok?: number; photo_kinds_n?: number; image_fields?: number };
      bottleneck_n?: number | null;
    };
    const bySite = (prof?.bundle as {
      supervisor_by_site?: Record<string, { meeting?: { vision_pro_link?: Vpl } }>;
      supervisor?: { meeting?: { vision_pro_link?: Vpl } };
    } | null);
    const vpl =
      (site === "itandi"
        ? bySite?.supervisor_by_site?.itandi?.meeting?.vision_pro_link
        : bySite?.supervisor_by_site?.realpro?.meeting?.vision_pro_link)
      || bySite?.supervisor_by_site?.[markSite]?.meeting?.vision_pro_link
      || bySite?.supervisor?.meeting?.vision_pro_link
      || null;
    const c = vpl?.counts || null;
    const photoVis = Number(c?.photo_in_storage) || 0;
    const learnedVis = Number(c?.learned_ok) || 0;
    const kindsVis = (Number(c?.photo_kinds_n) || 0) + (Number(c?.image_fields) || 0);
    const step1Ok = inStore <= 0 || photoVis > 0;
    const step3Ok = learnedVis <= 0 || kindsVis > 0;
    const okVis = step1Ok && step3Ok;
    items.push({
      id: "F49_vision_photo_reach",
      ok: okVis,
      line: `写真→統括到達(${markSite}) 束in_storage=${inStore} vision写真=${photoVis} 学べ=${learnedVis} 種類|欄=${kindsVis}`
        + ` 段1=${step1Ok ? "✓" : "✗"} 段3=${step3Ok ? "✓" : "✗"}`
        + (kindsBundle > 0 && kindsVis <= 0 && learnedVis > 0 ? " ⚠束に種類あるがvision未到達" : "")
        + `（完了線: 束に写真があるならvision写真>0／学べがあるなら種類|欄>0）`,
      next: okVis
        ? "維持（photo_learn→材料→突合→Pro）"
        : !step1Ok
          ? "サイト別統括へ shot_bytes を渡す／束再生成（vision段1の誤報を止める）"
          : "サイト別へ photo_kinds / image_match を渡す（段3材料到達）",
      layer: "free",
    });
  }

  /**
   * ★ F50 2026-11-17 竹内さん「学んだ学習方法をitandiでも完全に活用」＋統括Pro:
   *   リアプロで確立した①〜⑤の型が itandi でも使えるか（台帳・サイト別統括・記録）。
   *   DOM・路線駅名は混ぜない。方法と関所の型だけ共通。
   */
  {
    const { measureSiteMethodParity } = await import("./site-learn-method");
    const { REALPRO_BUTTONS } = await import("./realpro-buttons");
    const { ITANDI_BUTTONS } = await import("./itandi-buttons");
    // ★ 移植関所は常に scope=all の束で両サイト統括を見る（サイト別scopeだと片方しか無い）
    let allBundle = prof?.bundle;
    if (site !== "all") {
      const { data: allProf } = await sb
        .from("human_learn_profile")
        .select("bundle")
        .eq("scope", "all")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (allProf?.bundle) allBundle = allProf.bundle;
    }
    const by = (allBundle as {
      supervisor_by_site?: Record<string, { meeting?: { vision_pro_link?: { counts?: { photo_in_storage?: number } } } }>;
      source?: { sites?: string[]; rows?: number };
    } | null);
    const sitesSup = Object.keys(by?.supervisor_by_site || {});
    let rpRows = 0, itRows = 0;
    {
      const sinceMat = sinceIso(LEARN_PERIODS.materialsMs);
      const { count: cRp } = await sb.from("human_motion_learn").select("id", { count: "exact", head: true }).eq("site", "realpro").gte("created_at", sinceMat);
      const { count: cIt } = await sb.from("human_motion_learn").select("id", { count: "exact", head: true }).eq("site", "itandi").gte("created_at", sinceMat);
      rpRows = cRp ?? 0;
      itRows = cIt ?? 0;
    }
    const rpVis = Number(by?.supervisor_by_site?.realpro?.meeting?.vision_pro_link?.counts?.photo_in_storage) || 0;
    const itVis = Number(by?.supervisor_by_site?.itandi?.meeting?.vision_pro_link?.counts?.photo_in_storage) || 0;
    const parity = measureSiteMethodParity({
      sitesWithSupervisor: sitesSup.length ? sitesSup : (by?.source?.sites || []),
      rowsBySite: { realpro: rpRows, itandi: itRows },
      visionPhotoBySite: { realpro: rpVis, itandi: itVis },
      realproButtonsN: REALPRO_BUTTONS.length,
      itandiButtonsN: ITANDI_BUTTONS.length,
    });
    items.push({
      id: "F50_site_method_parity",
      ok: parity.ok,
      line: parity.line + `（計測site=${site}/印=${markSite}）`,
      next: parity.ok
        ? (parity.itandi_record_ask || "維持（方法は共通・DOM/台帳はサイト別）")
        : (parity.gaps[0] || "サイト別統括と両台帳をそろえる"),
      layer: parity.itandi_record_ask ? "human" : "free",
    });
  }

  /**
   * ★ F51 2026-11-17 統括Pro「人間として自動化／細部改善の仕組みと土台を徹底」:
   *   弱所→学ぶ→土台→狙って押して残す→度で確かめる、の5段が測れること。
   */
  {
    const { buildHumanDetailLoop } = await import("./human-detail-loop");
    const { DETAIL_DEGREE } = await import("./learn-improve-mech");
    const f15 = items.find((x) => x.id === "F15_cursor_aim_hit");
    const f16 = items.find((x) => x.id === "F16_learn_warm");
    const f28 = items.find((x) => x.id === "F28_auto_gap_floor");
    const f29 = items.find((x) => x.id === "F29_human_nearness");
    const f49 = items.find((x) => x.id === "F49_vision_photo_reach");
    const f6 = items.find((x) => x.id === "F6_auto_after_bundle");
    // aim有/無は F15 行から抜く
    let aimAri = 0, aimNashi = 0;
    {
      const m = String(f15?.line || "").match(/aim有=(\d+).*aim無=(\d+)/);
      if (m) { aimAri = Number(m[1]) || 0; aimNashi = Number(m[2]) || 0; }
    }
    let warmN = 0;
    {
      const m = String(f16?.line || "").match(/learn_warm=(\d+)/);
      if (m) warmN = Number(m[1]) || 0;
    }
    let shortPct: number | null = null;
    {
      const m = String(f28?.line || "").match(/（([\d.]+)%/);
      if (m) shortPct = Number(m[1]);
    }
    let nearScore: number | null = null;
    let nearOk = !!f29?.ok;
    {
      const m = String(f29?.line || "").match(/近さ(\d+)点/);
      if (m) nearScore = Number(m[1]);
    }
    // 直近拡張版
    let extVer: string | null = null;
    {
      const { data: verRows } = await sb
        .from("search_audits")
        .select("ext_version")
        .eq("site", markSite)
        .order("created_at", { ascending: false })
        .limit(5);
      for (const r of verRows || []) {
        const v = String((r as { ext_version?: string }).ext_version || "");
        if (/^2\.\d+\.\d+/.test(v)) { extVer = v; break; }
      }
    }
    const loop = buildHumanDetailLoop({
      aimAri,
      aimNashi,
      learnWarmN: warmN,
      shortGapPct: shortPct,
      nearnessAllowed: nearOk,
      nearnessScore: nearScore,
      visionPhotoOk: !!f49?.ok,
      fireAtPointWired: true, // コード側は 2.8.86+ で配線済。版で確認
      extVersion: extVer,
      autoAfterBundle: !!f6?.ok,
      pointPct: null,
      cursorPct: null,
    });
    // 仕組みOK＝5段が組める＋度の線がある。完了＝bottleneckなし
    const mechOk = loop.steps.length === 5 && loop.degree_line.includes(String(DETAIL_DEGREE.POINT_OK));
    const doneOk = loop.bottleneck_n == null;
    const measurable = (aimAri + aimNashi) > 0 || warmN > 0 || !!extVer;
    items.push({
      id: "F51_human_detail_loop",
      ok: mechOk && measurable && (doneOk || loop.bottleneck_n! >= 3),
      line: `人間細部ループ ${loop.line.slice(0, 160)}／版=${extVer || "?"}／原子${loop.atoms.length}`
        + `（完了線: 5段✓＝弱所→学ぶ→土台→狙って残す→度／仕組みは測れること）`,
      next: doneOk
        ? "維持（細部原子を1つずつ回す）"
        : (loop.atoms[0]?.next || loop.bottleneck || "拡張再読込→自動1回→F15/F16/F28/F49を数字で見る"),
      layer: loop.bottleneck_n != null && loop.bottleneck_n <= 3 ? "free" : "human",
    });
  }

  /**
   * ★ F52 2026-11-17 竹内さん「地域と駅はどちらか／混ざると検索できない」＋統括Pro:
   *   自動監査に place_mixed / extraStation+extraWard / AREA_MIX が残らないこと。
   */
  {
    let mixN = 0, xorOkN = 0, sample = 0;
    const { data: saPlace } = await sb
      .from("search_audits")
      .select("steps,ext_version,created_at")
      .eq("site", markSite)
      .order("created_at", { ascending: false })
      .limit(40);
    for (const r of saPlace || []) {
      sample++;
      const steps = Array.isArray(r.steps) ? (r.steps as Array<{ k?: string; m?: string }>) : [];
      const joined = steps.map((s) => `${s.k || ""} ${s.m || ""}`).join(" ");
      if (/place_mixed|地域と駅が同時|area_ok_by=both|AREA_MIX/.test(joined)) mixN++;
      else if (/place_side_clear|area_ok_by=ward|area_ok_by=station|gate_ward_clear|gate_station_defer/.test(joined)) xorOkN++;
    }
    const okXor = sample >= 3 && mixN === 0;
    items.push({
      id: "F52_place_xor",
      ok: okXor,
      line: `地域↔駅排他(${markSite}) 標本${sample} 混在印=${mixN} 片側印=${xorOkN}`
        + `（完了線: 直近自動で place_mixed/both=0・どちらか一方）`,
      next: okXor
        ? "維持（関所で混在を止める）"
        : "2.8.88再読込→自動1回。混在時は area_mode の反対側を外してから検索",
      layer: "human",
    });
  }

  /**
   * ★ F53 2026-11-18 統括Pro「画像の連続流れ学習→一連理解→改善」:
   *   連続録画 run 単位で shot_learn が scene/flow に載り、束に image_flows／result 画面があるか。
   */
  {
    const sinceMat = sinceIso(LEARN_PERIODS.materialsMs);
    const { data: imgRows } = await sb
      .from("human_motion_learn")
      .select("shot_key, shot_learn")
      .eq("site", markSite)
      .eq("shot_taken", true)
      .gte("shot_w", 800)
      .gte("created_at", sinceMat)
      .order("created_at", { ascending: false })
      .limit(500);
    const rows = (imgRows || []) as Array<{ shot_key?: string | null; shot_learn?: unknown }>;
    let learnedN = 0;
    let sceneN = 0;
    let resultScreenN = 0;
    for (const r of rows) {
      if (!isShotLearnOk(r.shot_learn)) continue;
      learnedN++;
      if (shotLearnHasSceneFlow(r.shot_learn)) sceneN++;
      const screen = String((r.shot_learn as { screen?: string } | null)?.screen || "");
      if (screen === "result") resultScreenN++;
    }
    const seqCoveredRuns = countSeqCoveredRuns(rows);
    const bWrap = prof?.bundle as {
      image_flows?: { seq_learned_runs?: number };
      screen_flow?: Record<string, unknown>;
    } | null;
    const bundleSeqRuns = Number(bWrap?.image_flows?.seq_learned_runs) || 0;
    const hasResultScreen = !!(bWrap?.screen_flow?.result) || resultScreenN > 0;
    const okF53 =
      sceneN >= 5 && seqCoveredRuns >= 1 && bundleSeqRuns >= 1 && hasResultScreen;
    const sampleN = rows.length;
    items.push({
      id: "F53_image_seq_flow",
      ok: okF53,
      line: `画像連続流れ(${markSite}) 標本${sampleN} learned=${learnedN} scene|flow=${sceneN} result画面=${resultScreenN}`
        + ` 連続カバーラン=${seqCoveredRuns} 束seq_runs=${bundleSeqRuns} result束=${hasResultScreen ? "✓" : "✗"}`
        + `（完了線: scene≥5・連続ラン≥1・束seq≥1・result画面）`,
      next: okF53
        ? "維持（連続画像→scene/flow→束 image_flows）"
        : `scripts/shot-learn.ts --site=${markSite} --mode=normal --order=sequence --limit=35 で連続ラン読み取り→束作り直し`,
      layer: okF53 ? "free" : learnedN < 30 ? "cost" : "free",
    });
  }

  /**
   * ★ F54 2026-11-18 竹内さん「課題の学習を完全にする」:
   *   自動の課題欄が束 points と shots.learned の両方に載り、通常の未学習が残らない。
   */
  {
    const { data: autoMotion } = await sb
      .from("human_motion_learn")
      .select("created_at,mode,shot_key,shot_ops,shot_taken,shot_learn,site,ext_version")
      .eq("site", markSite)
      .in("mode", ["aix", "auto", "brain_aix"])
      .gte("created_at", sinceOps)
      .order("created_at", { ascending: false })
      .limit(100);
    const ch = summarizeLatestAutoChallenges((autoMotion || []) as never, { hours: 72 });
    const { catalogTargetsOnly } = await import("./button-catalog-targets");
    const chFields = catalogTargetsOnly(ch.fields || [], markSite);
    const sinceMatF54 = sinceIso(LEARN_PERIODS.materialsMs);
    let normalTodo = 0;
    {
      const { data: normRows } = await sb
        .from("human_motion_learn")
        .select("shot_learn,shot_taken,shot_w,mode")
        .eq("site", markSite)
        .eq("mode", "normal")
        .eq("shot_taken", true)
        .gte("shot_w", 800)
        .gte("created_at", sinceMatF54)
        .order("created_at", { ascending: false })
        .limit(400);
      for (const r of normRows || []) {
        if (!isShotLearnOk(r.shot_learn)) normalTodo++;
      }
    }
    const f54 = auditChallengeLearnComplete({
      challengeFields: chFields,
      bundle: (prof?.bundle ?? null) as ChallengeLearnBundle,
      normalUnlearned: normalTodo,
    });
    items.push({
      id: "F54_challenge_learn_complete",
      ok: f54.ok,
      line: `${f54.line}／最新自動課題${chFields.length}件`,
      next: f54.next,
      layer: f54.ok ? "free" : f54.normalTodo > 0 ? "cost" : "human",
    });
  }

  /**
   * ★ F55 2026-11-18 竹内さん「自動モードへの反映もちゃんとできるようにする」:
   *   F6+F31+F43+F46 を統合: read≥1・新束後自動≥1・本番監査の反映印≥1。
   */
  {
    const bundleAt = typeof prof?.created_at === "string" ? prof.created_at : null;
    let reflectOkN = 0, flowReflectOkN = 0, aimYesN2 = 0;
    if (bundleAt) {
      const { data: rfAud } = await sb
        .from("search_audits")
        .select("steps,mode,created_at")
        .eq("site", markSite)
        .in("mode", ["brain_aix", "aix", "auto"])
        .gte("created_at", bundleAt)
        .order("created_at", { ascending: false })
        .limit(25);
      for (const a of rfAud || []) {
        const steps = Array.isArray(a.steps) ? a.steps : [];
        const joined = steps.map((s) => {
          if (typeof s === "string") return s;
          const o = s as { k?: string; d?: string };
          return `${o.k || ""} ${o.d || ""}`;
        }).join("|");
        if (/learn_reflect_ok/.test(joined)) reflectOkN++;
        if (/learn_flow_reflect_ok/.test(joined)) flowReflectOkN++;
        if (/aim有/.test(joined)) aimYesN2++;
      }
    }
    const f55 = auditAutoReflectVerified({
      readCount: Number(prof?.read_count) || 0,
      autoAfterBundle: afterBundle.length,
      reflectOk: reflectOkN,
      flowReflectOk: flowReflectOkN,
      aimYes: aimYesN2,
    });
    items.push({
      id: "F55_auto_reflect_verified",
      ok: f55.ok,
      line: f55.line,
      next: f55.next,
      layer: f55.ok ? "free" : "human",
    });
  }

  /**
   * ★ F56 2026-11-18 竹内さん「発見→構築→強化→自動モードに反映されるまで統括Proが責任もって完走」:
   *   連続画像(F53)・課題欄学習(F54)・自動反映(F55)・aim(F15)・短間隔(F28)・近さ(F29)の統合完了責任。
   */
  {
    const f53 = items.find((x) => x.id === "F53_image_seq_flow");
    const f54 = items.find((x) => x.id === "F54_challenge_learn_complete");
    const f55 = items.find((x) => x.id === "F55_auto_reflect_verified");
    const f15 = items.find((x) => x.id === "F15_cursor_aim_hit");
    const f28 = items.find((x) => x.id === "F28_auto_gap_floor");
    const f29 = items.find((x) => x.id === "F29_human_nearness");
    const f56 = auditProReflectResponsibility({
      f53Ok: f53?.ok,
      f54Ok: f54?.ok,
      f55Ok: f55?.ok,
      f15Ok: f15?.ok,
      f28Ok: f28?.ok,
      f29Ok: f29?.ok,
      f54Next: f54?.next,
      f28Next: f28?.next,
    });
    items.push({
      id: "F56_pro_reflect_responsibility",
      ok: f56.ok,
      line: f56.line,
      next: f56.next,
      layer: !f55?.ok ? "human" : "free",
    });
  }

  /**
   * ★ F57 2026-11-22 竹内さん「手順書＋画面照会を細部まで／改善時に段ごとの完了線で仕組み化」:
   *   コード配線だけでは完了にしない。search_audits の段印が必須段すべて揃って初めて✓。
   */
  {
    const { data: graspAud } = await sb
      .from("search_audits")
      .select("steps,mode,ext_version,created_at")
      .eq("site", markSite)
      .in("mode", ["brain_aix", "aix", "auto", "brain_staff", "staff"])
      .order("created_at", { ascending: false })
      .limit(12);
    const f57 = auditGuideScreenGraspFromAudits(
      (graspAud || []).map((a) => ({
        steps: a.steps,
        mode: a.mode,
        ext_version: a.ext_version,
      })),
    );
    items.push({
      id: "F57_guide_screen_grasp",
      ok: f57.improve_complete,
      line: f57.line,
      next: f57.next,
      layer: f57.improve_complete ? "free" : "human",
    });
  }

  /**
   * ★ F58 2026-11-22 竹内さん「テストの部分も土台強化／改善したらテストちゃんと／抜け見つかれば改善する仕組み」:
   *   拡張の必須スイート＋配線抜けスキャンのスタンプ。未実行・失敗・抜け残りは未完。
   */
  {
    const f58 = auditExtTestImproveLoop(process.cwd());
    items.push({
      id: "F58_ext_test_improve_loop",
      ok: f58.ok,
      line: f58.line,
      next: f58.next,
      layer: "free",
    });
  }

  /**
   * ★ F59 2026-11-23: 人間らしさ未達の改善周回（測る→gaps→photo→再測）のスタンプ。
   */
  {
    const p = join(process.cwd(), "memory/human_like_improve_last.json");
    let ok = false;
    let line = "F59 人間らしさ改善スタンプ無し（scripts/human-like-improve.ts --plan-only）";
    let next = "npx tsx --env-file=.env.local scripts/human-like-improve.ts --plan-only";
    if (existsSync(p)) {
      try {
        const stamp = JSON.parse(readFileSync(p, "utf8"));
        const ev = evaluateHumanLikeImproveStamp(stamp);
        ok = ev.ok;
        line = `F59 ${ev.line}`;
        next = ev.next;
      } catch {
        line = "F59 スタンプが読めない";
      }
    }
    items.push({ id: "F59_human_like_improve_loop", ok, line, next, layer: ok ? "free" : "human" });
  }

  /**
   * ★ F60 2026-11-23 竹内さん「弱い部分ほかにないのか／見つけて強化する仕組みの土台」:
   *   手順書・近さ・位置・F57・F58・新束後自動を横断で洗い、未達を強化ルートへ振り分ける。
   */
  {
    const p = join(process.cwd(), WEAK_FIND_STAMP_REL);
    let ok = false;
    let line = "F60 弱所横断スタンプ無し（scripts/weak-find.ts）";
    let next = "npx tsx --env-file=.env.local scripts/weak-find.ts";
    if (existsSync(p)) {
      try {
        const stamp = JSON.parse(readFileSync(p, "utf8"));
        const ageH = stamp.at ? (Date.now() - new Date(stamp.at).getTime()) / 3600_000 : 999;
        const ev = evaluateWeakFindStamp(stamp);
        ok = ev.ok && ageH <= 36;
        line = ageH > 36 ? `F60 スタンプ古い（${Math.round(ageH)}h） ${ev.line}` : `F60 ${ev.line}`;
        next = ageH > 36 ? "npx tsx --env-file=.env.local scripts/weak-find.ts（鮮度）" : ev.next;
      } catch {
        line = "F60 スタンプが読めない";
      }
    }
    items.push({ id: "F60_weak_find_strengthen", ok, line, next, layer: ok ? "free" : "human" });
  }

  /**
   * ★ F61 2026-11-23 竹内さん「連続客で外して入れて検索送付を繰り返せるか／抜け土台」:
   *   台帳＋background の runId 明示 stamp＋page leftover／post_send。実走印は再読込後。
   */
  {
    const ledgerOk = existsSync(join(process.cwd(), "app/lib/handoff-loop-ledger.ts"));
    let bg = "";
    let pageSrc = "";
    try {
      bg = readFileSync(join(process.cwd(), "chrome-extension/background.js"), "utf8");
      pageSrc = readFileSync(join(process.cwd(), "chrome-extension/page-script.js"), "utf8");
    } catch { /* */ }
    const wireOk =
      /function _postSendClearRealpro\(customerId, auditRunId\)/.test(bg)
      && /handoff_loop/.test(bg)
      && /leftover_scan/.test(pageSrc)
      && /__axlxPostSendClearP/.test(pageSrc);
    let v203 = 0, leftN = 0, postN = 0, readyN = 0, loopN = 0;
    const { data: cAud } = await sb
      .from("search_audits")
      .select("steps,ext_version,mode")
      .eq("site", markSite)
      .in("mode", ["brain_aix", "aix", "auto"])
      .order("created_at", { ascending: false })
      .limit(40);
    for (const a of cAud || []) {
      const v = String(a.ext_version || "");
      if (/^2\.8\.(20[3-9]|2[1-9]\d|[3-9]\d{2,})/.test(v)) v203++;
      const steps = Array.isArray(a.steps) ? a.steps : [];
      const joined = steps.map((s) => {
        if (typeof s === "string") return s;
        const o = s as { k?: string; d?: string };
        return `${o.k || ""} ${o.d || ""}`;
      }).join("|");
      if (/leftover_clean|leftover_done_F57|leftover_scan/.test(joined)) leftN++;
      if (/post_send_clear|handoff_atom_post_send|flow_atom_ok_post_send/.test(joined)) postN++;
      if (/ready_next|series_done|handoff_atom_ready|flow_done_ready_next/.test(joined)) readyN++;
      if (/handoff_loop/.test(joined)) loopN++;
    }
    const measureOk = v203 >= 1 && leftN >= 1 && postN >= 1 && readyN >= 1;
    const ok = ledgerOk && wireOk && measureOk;
    items.push({
      id: "F61_continuous_customer_handoff_loop",
      ok,
      line: `F61 連続客ループ 配線=${wireOk ? "✓" : "✗"} 台帳=${ledgerOk ? "✓" : "✗"} v203+=${v203} leftover=${leftN} post_send=${postN} ready=${readyN} handoff_loop=${loopN}`
        + `（完了線: ≥2.8.203自動で leftover∧post_send∧ready 各≥1）`,
      next: ok
        ? "維持（連続2客で細原子F62を確認）"
        : !wireOk || !ledgerOk
          ? "handoff-loop-ledger と background post_send(runId)／handoff_loop stamp を揃える"
          : "拡張≥2.8.204再読込→連続2客自動→監査 leftover／post_send_clear／ready_next",
      layer: measureOk ? "free" : "human",
    });
  }

  /**
   * ★ F62 2026-11-23 竹内さん「穴の部分を細分化してとことん強化」:
   *   連続客12細原子の出現を数え、0回の原子を強化次手にする。
   *   完了線: ≥2.8.204 自動で必須6原子（switch/place_clear/search/fill_done/post_send/ready）が各≥1。
   */
  {
    const { data: fAud } = await sb
      .from("search_audits")
      .select("steps,ext_version,mode")
      .eq("site", markSite)
      .in("mode", ["brain_aix", "aix", "auto"])
      .order("created_at", { ascending: false })
      .limit(40);
    const recent = (fAud || []).filter((a) => /^2\.8\.(20[4-9]|2[1-9]\d|[3-9]\d{2,})/.test(String(a.ext_version || "")));
    const pool = recent.length ? recent : (fAud || []).slice(0, 25);
    const tallied = countFineAtomsAcrossAudits(pool);
    const must = ["switch", "place_clear", "search", "fill_done", "post_send_clear", "ready_next"] as const;
    const mustOk = must.every((id) => (tallied.counts[id] || 0) >= 1);
    const has204 = recent.length >= 1;
    const ok = has204 && mustOk;
    const weakTop = tallied.weak.slice(0, 5).join("・") || "なし";
    items.push({
      id: "F62_continuous_handoff_subdivide",
      ok,
      line: `F62 連続客細分化 ${tallied.line}／必須6=${mustOk ? "✓" : "✗"} v204+=${recent.length} 原子数=${HANDOFF_FINE_ORDER.length}`
        + `（完了線: ≥2.8.204で switch・place_clear・search・fill_done・post_send・ready 各≥1）`,
      next: ok
        ? `維持（弱0回=${weakTop} を1つずつ強化）`
        : `scripts/handoff-loop-strengthen.ts → 拡張≥2.8.204再読込→連続2客／弱=${weakTop}`,
      layer: ok ? "free" : "human",
    });
  }

  /**
   * ★ F63 2026-11-23: 手順書 attach 後に拡張が旧版のまま止まる抜けを関所化。
   *   DB実測: コード/DBは e0b8837b でも自動既読 4c266b56・read=0 → 「改善済み」にしない。
   */
  {
    const codeV = autoRulesVersion();
    const dbRv = (() => {
      try {
        const pb = (prof as { bundle?: { playbook?: { rules_v?: string } } } | null)?.bundle?.playbook;
        return pb?.rules_v ? String(pb.rules_v) : null;
      } catch { return null; }
    })();
    let seenRv: string | null = null;
    try {
      const { data: seenAud } = await sb
        .from("search_audits")
        .select("steps,mode,created_at")
        .eq("site", markSite)
        .in("mode", ["brain_aix", "aix", "auto"])
        .order("created_at", { ascending: false })
        .limit(12);
      for (const a of seenAud || []) {
        const steps = Array.isArray(a.steps) ? a.steps : [];
        for (const s of steps) {
          const k = typeof s === "string" ? "" : String((s as { k?: string })?.k || "");
          const d = typeof s === "string" ? s : String((s as { d?: string })?.d || "");
          if (!/playbook_seen/i.test(`${k} ${d}`)) continue;
          const parsed = parsePlaybookSeen(d) || parsePlaybookSeen(`${k} ${d}`);
          if (parsed?.rules_v) { seenRv = String(parsed.rules_v); break; }
        }
        if (seenRv) break;
      }
    } catch { /* 監査が読めなくても F63 は欠として出す */ }
    const f63 = auditPlaybookRulesReflect({
      codeRulesV: codeV,
      dbRulesV: dbRv,
      seenRulesV: seenRv,
      readCount: Number(prof?.read_count) || 0,
    });
    items.push({
      id: "F63_playbook_rules_reflect",
      ok: f63.ok,
      line: f63.line,
      next: f63.next,
      layer: f63.ok ? "free" : "human",
    });
  }

  /**
   * ★ F64 2026-11-24 竹内さん「表面の改善ばかりで根本的でない／完了まで試行／統括pro×設計知見」:
   *   症状をDBで測る→根本の型→関所コード＋テスト→F58→本番実証印。表面文言だけは完了にしない。
   */
  {
    const f64 = auditRootCauseImproveLoop(process.cwd());
    items.push({
      id: "F64_root_cause_improve_loop",
      ok: f64.ok,
      line: f64.line,
      next: f64.next,
      layer: "free",
    });
  }

  /**
   * ★ F65 2026-11-24 竹内さん「強化していくようにする」:
   *   入口1回で終わらせず、沈黙中もaim再warm＋細分化。スタンプが次手を名指しし続ける。
   */
  {
    const f65 = auditKeepStrengthenLoop(process.cwd());
    items.push({
      id: "F65_keep_strengthen_loop",
      ok: f65.ok,
      line: f65.line,
      next: f65.next,
      layer: f65.ok ? "free" : "human",
    });
  }

  const ok_n = items.filter((x) => x.ok).length;
  const missing_n = items.length - ok_n;
  const missIds = items.filter((x) => !x.ok).map((x) => x.id.replace(/^F\d+_/, "")).slice(0, 4);
  return {
    at: new Date().toISOString(),
    bundle_at: typeof prof?.created_at === "string" ? prof.created_at : null,
    source_rows: typeof prof?.source_rows === "number" ? prof.source_rows : null,
    screen_solid: sc.solid,
    ok_n,
    missing_n,
    items,
    summary: `土台(${site}/印${markSite}) ${ok_n}/${items.length} ✓／欠 ${missing_n}` + (missIds.length ? `（${missIds.join("・")}…）` : ""),
  };
}

/** コンソール用に整形 */
export function formatFoundationAudit(a: FoundationAudit): string[] {
  const lines = [
    `■ 学習土台 ${a.summary}`,
    `  束 ${a.bundle_at ?? "-"} rows=${a.source_rows ?? "-"} solid=${a.screen_solid}`,
  ];
  for (const f of a.items) {
    lines.push(`  ${f.ok ? "✓" : "✗"} ${f.id}: ${f.line}`);
    if (!f.ok) lines.push(`     → [${f.layer}] ${f.next}`);
  }
  return lines;
}

/**
 * ★ 2026-11-17 竹内さん「統括は土台を理解して統括できるように」:
 *   点検の全文は長いので、統括・Pro に渡す**圧縮形**にする。
 *   キー土台（近さ・駅反映・連携一連・steps）は必ず残す。
 */
export type FoundationForSupervisor = {
  ok_n: number;
  missing_n: number;
  total: number;
  summary: string;
  screen_solid: number;
  /** 欠けている土台（最大12） */
  missing: Array<{ id: string; line: string; next: string; layer: string }>;
  /** 重要土台の現状（欠けていても載せる） */
  key: Record<string, { ok: boolean; line: string }>;
};

const KEY_FOUNDATION_IDS = [
  "F29_human_nearness",
  "F30_station_clear_vs_select",
  "F31_learn_reflect_station",
  "F32_link_pipeline",
  "F33_learn_db_persist",
  "F34_pro_brain_ready",
  "F35_wipe_write_gate",
  "F36_write_path_gate",
  "F37_pro_rag_brain",
  "F38_improve_reflect_chain",
  "F39_panel_debt_settle",
  "F40_screen_grasp",
  "F41_button_done_marks",
  "F42_catalog_targets_gate",
  "F43_improve_to_auto_link",
  "F44_next_customer_handoff",
  "F45_flow_completion_ledger",
  "F46_flow_record_to_auto",
  "F47_flow_map_subdivide",
  "F48_pro_brain_loop",
  "F49_vision_photo_reach",
  "F50_site_method_parity",
  "F51_human_detail_loop",
  "F52_place_xor",
  "F53_image_seq_flow",
  "F54_challenge_learn_complete",
  "F55_auto_reflect_verified",
  "F56_pro_reflect_responsibility",
  "F57_guide_screen_grasp",
  "F58_ext_test_improve_loop",
  "F59_human_like_improve_loop",
  "F60_weak_find_strengthen",
  "F61_continuous_customer_handoff_loop",
  "F62_continuous_handoff_subdivide",
  "F63_playbook_rules_reflect",
  "F64_root_cause_improve_loop",
  "F65_keep_strengthen_loop",
  "F6_auto_after_bundle",
  "F14_station_clear_cursor",
  "F18_fill_progress_steps",
  "F9_stalled_signal",
  "F28_auto_gap_floor",
  "F4_hand_cs",
  "F8_commands_flow",
  "F27_op_path_kind",
] as const;

export function compactFoundationForSupervisor(a: FoundationAudit): FoundationForSupervisor {
  const byId = new Map(a.items.map((i) => [i.id, i]));
  const key: FoundationForSupervisor["key"] = {};
  for (const id of KEY_FOUNDATION_IDS) {
    const it = byId.get(id);
    if (it) key[id] = { ok: it.ok, line: it.line.slice(0, 220) };
  }
  const missing = a.items
    .filter((i) => !i.ok)
    .slice(0, 12)
    .map((i) => ({
      id: i.id,
      line: i.line.slice(0, 180),
      next: i.next.slice(0, 120),
      layer: i.layer,
    }));
  return {
    ok_n: a.ok_n,
    missing_n: a.missing_n,
    total: a.items.length,
    summary: a.summary,
    screen_solid: a.screen_solid,
    missing,
    key,
  };
}

type EvidenceLine = { label: string; value: string; guessed?: boolean };

/**
 * 手元で再点検した結果で、束の統括根拠の「学習土台点検（F番号）」「土台 Fxx」を置き換える。
 * 本番の束の根拠は本番の点検の数え方で書かれており、Pro の axes はこの行から数字を取るため、
 * 再点検を foundation_audit に入れるだけでは Pro に古い数字（例: F28 70.6%）が残る。
 */
export function refreshFoundationEvidence(
  evidence: EvidenceLine[],
  a: FoundationAudit,
  siteTag = "",
): EvidenceLine[] {
  const c = compactFoundationForSupervisor(a);
  const summary: EvidenceLine = {
    label: "学習土台点検（F番号）",
    value: `${siteTag}${c.summary}` + (c.missing.length
      ? `／欠: ${c.missing.slice(0, 6).map((x) => x.id.replace(/^F\d+_/, "")).join("・")}`
      : "／欠なし"),
    guessed: c.missing_n > 0,
  };
  const keyLine = (id: string): EvidenceLine => ({
    label: `土台 ${id}`,
    value: `${c.key[id].ok ? "✓" : "✗"} ${c.key[id].line}`,
    guessed: !c.key[id].ok,
  });
  const seen = new Set<string>();
  const out = evidence.map((e) => {
    if (e.label === summary.label) { seen.add(e.label); return summary; }
    const m = /^土台 (F\d+_\w+)$/.exec(e.label);
    if (m && c.key[m[1]]) { seen.add(e.label); return keyLine(m[1]); }
    return e;
  });
  if (!seen.has(summary.label)) out.push(summary);
  for (const id of Object.keys(c.key)) {
    if (!seen.has(`土台 ${id}`)) out.push(keyLine(id));
  }
  return out;
}
