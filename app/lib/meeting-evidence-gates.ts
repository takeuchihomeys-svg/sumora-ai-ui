/**
 * 薄い統括 meeting でも必ず載せる関所（2026-11-18）
 *
 *   本番 site 別 log が「基本統計」だけになる穴:
 *   - foundation_audit / 連携 / 録画→課題→学習方法 / 学習完成 / 課題が条件でスキップ
 *   - supervisor_by_site が Pro 富化前のまま保存される
 *
 * ⚠ 設計知見への自動 INSERT はしない（費用・品質）。KB 候補は evidence 1行のみ。
 */
import type { SupervisorAdvice } from "./learn-supervisor";
import { buildLearnCompleteChain } from "./learn-complete-chain";
import { buildRecChallengeReinforce } from "./rec-challenge-reinforce";
import { ensureGaplessLearnTasks } from "./ensure-gapless-learn";
import { materialsDays, logMemoryDays, LEARN_PERIODS, DAY_MS } from "./learn-periods";
import { buildVisionProLink, type VisionProLink } from "./vision-pro-link";

export type MeetingEvidenceGateContext = {
  site?: string;
  foundationAudit?: {
    ok_n?: number;
    missing_n?: number;
    total?: number;
    summary?: string;
    screen_solid?: number;
    missing?: Array<{ id: string; line?: string; next?: string }>;
    key?: Record<string, { ok?: boolean; line?: string }>;
  } | null;
  bundleReflect?: {
    line?: string;
    bottleneck?: string;
    bottleneck_n?: number;
    read_count?: number;
    auto_after?: boolean;
    screen_solid?: number;
    screen_all?: number;
    photo_in_storage?: number;
  } | null;
  humanLike?: {
    ops?: number;
    withPoint?: number;
    withCursor?: number;
    rows?: number;
    changedWithoutClick?: number;
  } | null;
  improveLoop?: { bottleneck_n?: number | null; improve_line?: string } | null;
  shotGapsNormal?: { todo?: number; total?: number; learnedOk?: number } | null;
  shotGaps?: { todo?: number; total?: number; learnedOk?: number } | null;
  shotBytes?: {
    in_storage?: number;
    n?: number;
    large?: number;
    in_row_b64?: number;
  } | null;
  photoKinds?: Record<string, number> | null;
  imageMatch?: {
    imageFields?: number;
    withScreenPos?: number;
    matched?: number;
  } | null;
  shotRows?: number | null;
};

function gateNum(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** learn-supervisor と同じ photoReach（0 ?? 穴を塞ぐ） */
export function photoReachFromGateCtx(ctx?: MeetingEvidenceGateContext | null): number {
  if (!ctx) return 0;
  const sb = ctx.shotBytes;
  const sgN = ctx.shotGapsNormal;
  const sg = ctx.shotGaps;
  const br = ctx.bundleReflect;
  return Math.max(
    gateNum(sb?.in_storage),
    gateNum(sb?.n),
    gateNum(br?.photo_in_storage),
    gateNum(sgN?.total),
    gateNum(sgN?.learnedOk) + gateNum(sgN?.todo),
    gateNum(sg?.learnedOk) + gateNum(sg?.todo),
    gateNum(ctx.shotRows),
  );
}

function hasLabel(ev: Array<{ label?: string }>, re: RegExp): boolean {
  return ev.some((e) => re.test(String(e.label || "")));
}

/** 束 JSON から Pro／関所用の材料を抜く */
export function buildBundleForProMeet(raw: Record<string, unknown>): Record<string, unknown> {
  const b = raw || {};
  const src = (b.source && typeof b.source === "object") ? (b.source as Record<string, unknown>) : {};
  let shots: Record<string, unknown> = (b.shots && typeof b.shots === "object")
    ? (b.shots as Record<string, unknown>)
    : { total: src.rows, with_ops: src.with_ops, kinds: {} };
  if (!gateNum(shots.in_storage)) {
    const br = (b.bundle_reflect && typeof b.bundle_reflect === "object")
      ? (b.bundle_reflect as { photo_in_storage?: number })
      : undefined;
    const stored = gateNum(br?.photo_in_storage);
    if (stored) shots = { ...shots, in_storage: stored, kinds: shots.kinds ?? {} };
  }
  const shotBytesRaw = b.shot_bytes && typeof b.shot_bytes === "object"
    ? (b.shot_bytes as Record<string, unknown>)
    : null;
  const shot_bytes = shotBytesRaw ?? (gateNum(shots.in_storage) || gateNum(shots.total)
    ? {
      in_storage: gateNum(shots.in_storage),
      n: gateNum(shots.total) || gateNum(shots.in_storage),
      large: gateNum(shots.large),
      in_row_b64: gateNum(shots.in_row_b64),
    }
    : undefined);
  const photo_kinds = (shots.kinds && typeof shots.kinds === "object")
    ? shots.kinds
    : (b.photo_kinds && typeof b.photo_kinds === "object" ? b.photo_kinds : undefined);
  return {
    weak: b.weak,
    learn_plan: b.learn_plan,
    points: b.points,
    shots,
    shot_bytes,
    photo_kinds,
    image_match: b.image_match,
    shot_rows: gateNum(b.shot_rows) || gateNum(shots.total) || undefined,
    shot_gaps_normal: b.shot_gaps_normal,
    shot_gaps: b.shot_gaps,
    foundation_audit: b.foundation_audit,
    bundle_reflect: b.bundle_reflect,
    human_like: b.human_like,
    human_nearness: b.human_nearness,
    screen_flow: b.screen_flow,
    image_flows: b.image_flows,
    scene_flows: b.scene_flows,
  };
}

/** superviseLearn の入力から関所 ctx を作る */
export function meetingGateContextFromSupervisorInput(
  inp: Record<string, unknown>,
  site?: string,
): MeetingEvidenceGateContext {
  const fa = inp.foundation_audit;
  const br = inp.bundle_reflect;
  const hl = inp.human_like;
  const il = inp.improve_loop;
  const gn = inp.shot_gaps_normal;
  const g = inp.shot_gaps;
  const shots = inp.shots && typeof inp.shots === "object" ? (inp.shots as Record<string, unknown>) : null;
  const sbIn = inp.shot_bytes && typeof inp.shot_bytes === "object"
    ? (inp.shot_bytes as Record<string, unknown>)
    : null;
  const shotBytes = sbIn
    ? {
      in_storage: gateNum(sbIn.in_storage),
      n: gateNum(sbIn.n),
      large: gateNum(sbIn.large),
      in_row_b64: gateNum(sbIn.in_row_b64),
    }
    : (shots && (gateNum(shots.in_storage) || gateNum(shots.total))
      ? {
        in_storage: gateNum(shots.in_storage),
        n: gateNum(shots.total) || gateNum(shots.in_storage),
        large: gateNum(shots.large),
        in_row_b64: gateNum(shots.in_row_b64),
      }
      : null);
  const pk = inp.photo_kinds;
  const photoKinds = pk && typeof pk === "object"
    ? Object.fromEntries(
      Object.entries(pk as Record<string, unknown>)
        .map(([k, v]) => [k, Number(v) || 0])
        .filter(([, n]) => gateNum(n) > 0),
    )
    : (shots?.kinds && typeof shots.kinds === "object"
      ? Object.fromEntries(
        Object.entries(shots.kinds as Record<string, unknown>)
          .map(([k, v]) => [k, Number(v) || 0])
          .filter(([, n]) => gateNum(n) > 0),
      )
      : null);
  const im = inp.image_match;
  const imageMatch = im && typeof im === "object"
    ? {
      imageFields: gateNum((im as { imageFields?: unknown }).imageFields),
      withScreenPos: gateNum((im as { withScreenPos?: unknown }).withScreenPos),
      matched: gateNum((im as { matched?: unknown }).matched),
    }
  : null;
  const parseGaps = (x: unknown) => {
    if (!x || typeof x !== "object") return null;
    const o = x as Record<string, unknown>;
    return {
      todo: Number(o.todo) || 0,
      total: Number(o.total) || 0,
      learnedOk: Number(o.learnedOk ?? o.learned_ok) || 0,
    };
  };
  return {
    site: site || String(inp.site || "all"),
    foundationAudit: fa && typeof fa === "object" ? (fa as MeetingEvidenceGateContext["foundationAudit"]) : null,
    bundleReflect: br && typeof br === "object" ? (br as MeetingEvidenceGateContext["bundleReflect"]) : null,
    humanLike: hl && typeof hl === "object" ? (hl as MeetingEvidenceGateContext["humanLike"]) : null,
    improveLoop: il && typeof il === "object" ? (il as MeetingEvidenceGateContext["improveLoop"]) : null,
    shotGapsNormal: parseGaps(gn),
    shotGaps: parseGaps(g),
    shotBytes: shotBytes && (shotBytes.in_storage || shotBytes.n) ? shotBytes : null,
    photoKinds: photoKinds && Object.keys(photoKinds).length ? photoKinds : null,
    imageMatch,
    shotRows: gateNum(inp.shot_rows) || gateNum(shots?.total) || null,
  };
}

/**
 * 薄い meeting でも土台・完成・録画学習・連携・課題・KB候補を必ず載せる。
 */
export function ensureMeetingEvidenceGates(
  adv: SupervisorAdvice,
  ctx?: MeetingEvidenceGateContext | null,
): SupervisorAdvice {
  const meeting = {
    ...(adv.meeting || { today: [] as string[], agenda: [], questions: [], evidence: [] as Array<{ label: string; value: string; guessed?: boolean }> }),
  };
  const ev = [...(meeting.evidence || [])];
  const siteTag = ctx?.site && ctx.site !== "all" ? `［${ctx.site}］` : "";

  // ── 学習土台点検（要約） ──
  if (!hasLabel(ev, /学習土台点検（F番号）/)) {
    const fa = ctx?.foundationAudit;
    if (fa && (String(fa.summary || "").length || (fa.total ?? 0) > 0 || (fa.missing_n ?? 0) > 0)) {
      const miss = (fa.missing || []).slice(0, 6).map((x) => String(x.id || "").replace(/^F\d+_/, ""));
      ev.push({
        label: "学習土台点検（F番号）",
        value: `${siteTag}${fa.summary || `✓${fa.ok_n ?? 0}／欠${fa.missing_n ?? 0}`}`
          + (miss.length ? `／欠: ${miss.join("・")}` : "／欠なし"),
        guessed: (fa.missing_n ?? 0) > 0,
      });
    } else {
      ev.push({
        label: "学習土台点検（F番号）",
        value: `${siteTag}未取得（foundation_audit未渡し）→ auditLearnFoundations を profile 経由で渡す`,
        guessed: true,
      });
    }
  }

  // ── 学習→自動の連携 ──
  if (!hasLabel(ev, /学習→自動の連携/)) {
    const br = ctx?.bundleReflect;
    if (br?.line) {
      ev.push({
        label: "学習→自動の連携",
        value: `${siteTag}${br.line}`,
        guessed: (br.read_count ?? 0) <= 0 || br.auto_after !== true,
      });
    } else {
      ev.push({
        label: "学習→自動の連携",
        value: `${siteTag}bundle_reflect未渡し／F1_screen_solid・read_countを測る（solid=0でも関所は残す）`,
        guessed: true,
      });
    }
  }
  if (!hasLabel(ev, /連携のボトルネック/) && ctx?.bundleReflect?.bottleneck) {
    ev.push({
      label: "連携のボトルネック",
      value: String(ctx.bundleReflect.bottleneck),
      guessed: true,
    });
  }

  // ── F38 / F32: 新束後自動=0 を証拠に明示 ──
  {
    const fa0 = ctx?.foundationAudit;
    const key0 = fa0?.key || {};
    const f38 = key0.F38_improve_reflect_chain as { ok?: boolean; line?: string; next?: string } | undefined;
    const f32 = key0.F32_link_pipeline as { ok?: boolean; line?: string; next?: string } | undefined;
    if (!hasLabel(ev, /土台 F38/) && f38?.line) {
      ev.push({
        label: "土台 F38_improve_reflect_chain",
        value: `${siteTag}${f38.ok ? "✓" : "✗"} ${f38.line}${f38.ok ? "" : `／次=${f38.next || "自動1回"}`}`,
        guessed: f38.ok !== true,
      });
    }
    if (!hasLabel(ev, /F32_link_pipeline|連携一連/) && f32?.line) {
      ev.push({
        label: "土台 F32_link_pipeline",
        value: `${siteTag}${f32.ok ? "✓" : "✗"} ${f32.line}${f32.ok ? "" : `／止=${f32.next || ""}`}`,
        guessed: f32.ok !== true,
      });
    }
    const br0 = ctx?.bundleReflect;
    if (!hasLabel(ev, /段5.*自動で使う|新束後自動=0/) && br0 && br0.read_count && br0.read_count >= 1 && br0.auto_after !== true) {
      ev.push({
        label: "連携・段5『自動で使う』",
        value: `${siteTag}read=${br0.read_count}・新束後自動=0（学習済みだが現場未使用）`,
        guessed: true,
      });
    }
  }

  // ── 録画→課題→学習→仕組み補強 ＋ 学習方法の強化 ──
  if (!hasLabel(ev, /録画→課題→学習→仕組み補強|1録画→学習→改善→反映/)) {
    const hl = ctx?.humanLike;
    const br = ctx?.bundleReflect;
    const fa = ctx?.foundationAudit;
    const key = fa?.key || {};
    const f6 = key.F6_auto_after_bundle;
    const f29 = key.F29_human_nearness;
    const f49 = key.F49_vision_photo_reach;
    const photoReachPre = photoReachFromGateCtx(ctx);
    const visionPhotoOk = f49?.ok === true || photoReachPre > 0;
    const pointPct = hl && (hl.rows ?? 0) > 0 && hl.withPoint != null
      ? Math.round((hl.withPoint / hl.rows!) * 100)
      : null;
    const cursorPct = hl && (hl.rows ?? 0) > 0 && hl.withCursor != null
      ? Math.round((hl.withCursor / hl.rows!) * 100)
      : null;
    try {
      const rcr = buildRecChallengeReinforce({
        pointPct,
        cursorPct,
        aimAri: 0,
        aimNashi: 0,
        learnWarmN: 0,
        shortGapPct: null,
        nearnessAllowed: f29?.ok === true,
        nearnessScore: null,
        visionPhotoOk,
        fireAtPointWired: true,
        changedWithoutClick: hl?.changedWithoutClick ?? null,
        autoAfterBundle: f6?.ok === true || br?.auto_after === true,
        readCount: br?.read_count ?? null,
        screenSolid: br?.screen_solid ?? fa?.screen_solid ?? null,
        humanLike: hl && (hl.ops ?? 0) > 0
          ? {
              withPoint: hl.withPoint ?? 0,
              withCursor: hl.withCursor ?? 0,
              rows: hl.rows ?? 0,
              changedWithoutClick: hl.changedWithoutClick ?? 0,
            }
          : null,
      });
      ev.push({
        label: "録画→課題→学習→仕組み補強",
        value: rcr.line
          + (rcr.mech_gaps[0] ? `／仕組み: ${rcr.mech_gaps[0].what}` : "")
          + (rcr.bottleneck ? `／止: ${rcr.bottleneck}` : ""),
        guessed: rcr.bottleneck_n != null,
      });
      if (!hasLabel(ev, /学習方法の強化|1録画の学び方強化/)) {
        ev.push({
          label: "学習方法の強化（効果で直して周回）",
          value: rcr.method.line + "／" + rcr.method.next_method_line
            + (rcr.continue_loop ? "／完全ループ継続" : "／ループ完了"),
          guessed: rcr.method.upgrades.length > 0,
        });
      }
      // 設計知見候補（自動 INSERT しない）
      if (!hasLabel(ev, /設計知見候補（学び方強化）/) && rcr.method.upgrades.length > 0) {
        const top = rcr.method.upgrades.slice(0, 2).map((u) => `${u.id}:${u.better_how.slice(0, 48)}`).join("・");
        ev.push({
          label: "設計知見候補（学び方強化）",
          value: `kb-insert手動候補／${top}／根拠: ${rcr.method.upgrades[0].evidence.slice(0, 80)}`,
          guessed: true,
        });
      }
    } catch {
      ev.push({
        label: "録画→課題→学習→仕組み補強",
        value: `${siteTag}関所で組み立て失敗→human_like・bundle_reflect・foundation_audit を渡す`,
        guessed: true,
      });
    }
  } else if (!hasLabel(ev, /学習方法の強化|1録画の学び方強化/)) {
    ev.push({
      label: "学習方法の強化（効果で直して周回）",
      value: `${siteTag}録画ループ根拠あり・学び方行のみ補完（⑧学び方強化を Pro 議題に載せる）`,
      guessed: true,
    });
  }

  meeting.evidence = ev;

  // ── 学習完成 4本柱 ──
  const fa = ctx?.foundationAudit;
  const br = ctx?.bundleReflect;
  const keyFailIds = (fa?.missing || [])
    .map((x) => String(x.id || ""))
    .filter((id) => /F1_|F6_|F31_|F32_|F33_|F34_|F37_|F38_|F43_/.test(id));
  let adv2: SupervisorAdvice = { ...adv, meeting };
  if (!hasLabel(ev, /学習完成（期間・土台・つながり・一連）/)) {
    const matD = materialsDays();
    const complete = buildLearnCompleteChain({
      period: {
        used: {
          daysOps: matD,
          daysAudit: matD,
          shotLearnDays: matD,
          auditWindowMs: LEARN_PERIODS.materialsMs,
          logMemoryDays: logMemoryDays(),
          commandsDays: Math.round(LEARN_PERIODS.commandsMs / DAY_MS),
        },
        screenSolid: fa?.screen_solid ?? br?.screen_solid ?? null,
        autoAfter: br?.auto_after ?? null,
        readCount: br?.read_count ?? null,
      },
      foundationMissingN: fa?.missing_n ?? null,
      foundationOkN: fa?.ok_n ?? null,
      foundationTotalN: fa?.total ?? null,
      keyFoundationFails: keyFailIds,
      linkLine: br?.bottleneck || br?.line || null,
      readCount: br?.read_count ?? null,
      autoAfter: br?.auto_after ?? null,
      screenSolid: fa?.screen_solid ?? br?.screen_solid ?? null,
      improveBottleneckN: ctx?.improveLoop?.bottleneck_n ?? null,
      improveLine: ctx?.improveLoop?.improve_line ?? null,
    });
    const ev2 = [...(meeting.evidence || [])];
    ev2.unshift({
      label: "学習完成の道筋",
      value: complete.path_to_complete,
      guessed: !complete.ok,
    });
    ev2.unshift({
      label: "学習完成（期間・土台・つながり・一連）",
      value: complete.line + (complete.ok ? "" : `／次=${complete.next_line}`),
      guessed: !complete.ok,
    });
    for (const p of complete.pillars) {
      ev2.push({
        label: `学習完成・${p.name}`,
        value: `${p.ok ? "✓" : "✗"} ${p.line}${p.ok ? "" : `／次=${p.next}`}`,
        guessed: !p.ok,
      });
    }
    meeting.evidence = ev2;
    adv2 = { ...adv, meeting };
    if (!complete.ok && complete.bottleneck) {
      const agenda = [...(meeting.agenda || [])];
      if (!agenda.some((a) => /学習期間・土台・つながり・一連/.test(String(a.topic || "")))) {
        agenda.unshift({
          priority: 0,
          topic: "学習期間・土台・つながり・一連を完成させる",
          why: complete.bottleneck,
          decide: complete.path_to_complete,
        });
        meeting.agenda = agenda.slice(0, 8);
        adv2 = { ...adv2, meeting };
      }
    }
  }

  // ── learning_tasks が空／photo_learn 欠落なら ensure-gapless-learn ──
  const tasks = [...(meeting.learning_tasks || [])];
  const photoReachForTasks = photoReachFromGateCtx(ctx);
  const learnedForTasks = ctx?.shotGapsNormal?.learnedOk ?? ctx?.shotGaps?.learnedOk ?? 0;
  const needPhotoTask = photoReachForTasks > 0 && learnedForTasks === 0
    && !tasks.some((t) => t.kind === "photo_learn");
  const sealed = ensureGaplessLearnTasks({
    tasks,
    unreadNormal: ctx?.shotGapsNormal?.todo ?? ctx?.shotGaps?.todo ?? 0,
    weakFields: [],
    kindConflictFields: [],
    screenSolid: fa?.screen_solid ?? br?.screen_solid ?? null,
    readCount: br?.read_count ?? null,
    autoAfter: br?.auto_after ?? null,
    reflectOk: null,
    bottleneckN: ctx?.improveLoop?.bottleneck_n ?? null,
    photoReach: photoReachForTasks,
    learnedOk: learnedForTasks,
  });
  const kindsBefore = new Set(tasks.map((t) => t.kind));
  const gapAdded = sealed.some((t) => !kindsBefore.has(t.kind)) || !tasks.length;
  if (gapAdded && sealed.length) {
    meeting.learning_tasks = sealed;
    const agenda = [...(meeting.agenda || [])];
    if (!agenda.some((a) => /次に学ぶ事/.test(String(a.topic || "")))) {
      agenda.push({
        priority: 1,
        topic: "次に学ぶ事（統括が決めた順・抜け止め関所）",
        why: sealed.map((t, i) => `${i + 1}. ${t.what}（${t.cost}）`).join(" / "),
        decide: sealed[0].what,
      });
      meeting.agenda = agenda.slice(0, 8);
    }
    adv2 = { ...adv2, meeting };
  }

  // ── 画像学習→統括Pro連携（薄い meeting / vision_pro_link 無しでも必ず） ──
  const photoReach = photoReachFromGateCtx(ctx);
  const learnedOkN = ctx?.shotGapsNormal?.learnedOk ?? ctx?.shotGaps?.learnedOk ?? 0;
  const todoN = ctx?.shotGapsNormal?.todo ?? ctx?.shotGaps?.todo ?? 0;
  const photoKindsN = ctx?.photoKinds
    ? Object.values(ctx.photoKinds).reduce((a, b) => a + (Number(b) || 0), 0)
    : 0;
  const kindsVis = photoKindsN + gateNum(ctx?.imageMatch?.imageFields);
  const meetingVision = { ...(adv2.meeting || meeting) };
  let vpl = (meetingVision as { vision_pro_link?: VisionProLink }).vision_pro_link;
  const step1MustOk = photoReach > 0;
  const step1Broken = vpl != null && step1MustOk && vpl.steps[0]?.ok === false;
  const hasPhotoLearnTaskNow = (meetingVision.learning_tasks || []).some((t) => t.kind === "photo_learn");
  /** photo_learn を今足した／段5が誤報のまま → 必ず立て直す */
  const step5BrokenVsTask = vpl != null
    && hasPhotoLearnTaskNow
    && vpl.steps[4]?.ok === false;
  const needsVisionEvidence = !hasLabel(meetingVision.evidence || [], /画像学習→統括Pro連携/);
  const needsVpl = !vpl || step1Broken || step5BrokenVsTask || needPhotoTask;

  if (needsVisionEvidence || needsVpl) {
    const hasPhotoLearnTask = hasPhotoLearnTaskNow;
    vpl = buildVisionProLink({
      photoInStorage: photoReach,
      learnedOk: learnedOkN || gateNum(vpl?.counts.learned_ok),
      todo: todoN || gateNum(vpl?.counts.todo),
      photoKindsN: photoKindsN || gateNum(vpl?.counts.photo_kinds_n),
      imageFields: ctx?.imageMatch?.imageFields ?? vpl?.counts.image_fields ?? 0,
      withScreenPos: ctx?.imageMatch?.withScreenPos ?? vpl?.counts.with_screen_pos ?? 0,
      matched: ctx?.imageMatch?.matched ?? vpl?.counts.matched ?? 0,
      hasPhotoLearnTask,
      usedPro: vpl?.counts.used_pro ?? null,
    });
    (meetingVision as { vision_pro_link?: VisionProLink }).vision_pro_link = vpl;
    const evVis = [...(meetingVision.evidence || [])];
    if (needsVisionEvidence) {
      evVis.unshift({
        label: "画像学習→統括Pro連携",
        value: vpl.line,
        guessed: vpl.bottleneck_n != null,
      });
    } else {
      const i = evVis.findIndex((e) => /^画像学習→統括Pro連携$/.test(String(e.label || "")));
      if (i >= 0) {
        evVis[i] = { ...evVis[i], value: vpl.line, guessed: vpl.bottleneck_n != null };
      }
    }
    if (!hasLabel(evVis, /画像学習の役割（flash/)) {
      evVis.unshift({
        label: "画像学習の役割（flash/Pro）",
        value: `読む=${vpl.roles.flash_model}／まとめる=${vpl.roles.pro_model}／関所=決定論。混ぜない`,
        guessed: false,
      });
    }
    meetingVision.evidence = evVis;
    adv2 = { ...adv2, meeting: meetingVision };
  } else if (vpl) {
    (meetingVision as { vision_pro_link?: VisionProLink }).vision_pro_link = vpl;
    adv2 = { ...adv2, meeting: meetingVision };
  }

  {
    const step1Ok = step1MustOk || (vpl?.steps[0]?.ok === true);
    const step3Ok = learnedOkN <= 0 || kindsVis > 0 || (vpl?.steps[2]?.ok === true);
    const note = photoReach > 0
      ? `／DB写真≈${photoReach}枚・段1を✗にしない`
      : "";
    const f49Line = `${siteTag}束写真≈${photoReach} vision=${vpl?.counts.photo_in_storage ?? photoReach}`
      + ` 学べ=${learnedOkN} 種類|欄=${kindsVis} 段1=${step1Ok ? "✓" : "✗"} 段3=${step3Ok ? "✓" : "✗"}${note}`;
    const evF49 = [...(adv2.meeting?.evidence || meetingVision.evidence || [])];
    const staleIdx = evF49.findIndex((e) => {
      const lab = String(e.label || "");
      if (!/写真→統括到達|F49_vision_photo_reach|土台 F49/.test(lab)) return false;
      const val = String(e.value || "");
      return photoReach > 0 && (/束in_storage=0\b|束写真≈0\b|vision=0\b/.test(val) || /vision写真=0\b/.test(val));
    });
    if (staleIdx >= 0) {
      evF49[staleIdx] = { ...evF49[staleIdx], value: f49Line, guessed: photoReach > 0 && !step1Ok };
    } else if (!hasLabel(evF49, /写真→統括到達|F49_vision_photo_reach/)) {
      evF49.push({
        label: "写真→統括到達",
        value: f49Line,
        guessed: photoReach > 0 && !step1Ok,
      });
    }
    adv2 = {
      ...adv2,
      meeting: { ...(adv2.meeting || meetingVision), evidence: evF49 },
    };
  }

  const finalEv = (adv2.meeting?.evidence || []).slice(0, 110);
  const finalMeeting = {
    ...(adv2.meeting || meeting),
    evidence: finalEv,
    ...((adv2.meeting as { vision_pro_link?: VisionProLink })?.vision_pro_link
      ? { vision_pro_link: (adv2.meeting as { vision_pro_link?: VisionProLink }).vision_pro_link }
      : (meetingVision as { vision_pro_link?: VisionProLink }).vision_pro_link
        ? { vision_pro_link: (meetingVision as { vision_pro_link?: VisionProLink }).vision_pro_link }
        : {}),
  };
  return {
    ...adv2,
    meeting: finalMeeting,
  };
}