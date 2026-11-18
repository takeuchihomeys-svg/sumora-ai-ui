/**
 * 設計知見 ↔ 統括Pro 連携（細部まで抜けない）（2026-11-18 竹内さん）
 *
 *   「設計知見と統括proともちゃんと連携できるように細かい部分もちゃんと抜けないようにする」
 *
 * ★ なぜ要るか
 *   RAGで引いただけ・題だけだと連携していない。
 *   引く→要旨で把握→決まりを foundation_gaps/build_next/課題 に落とす→細かい原子まで、
 *   の各段を決定論で測り、欠け段だけ直す。
 *
 * ⚠ 純関数。
 */

import type { ProKbHit, SupervisorProBrainPull } from "./learn-supervisor-pro-rag";

export type KbProLinkStage =
  | "pull"
  | "grasp_insight"
  | "drop_gaps"
  | "drop_tasks"
  | "fine_atoms"
  | "log_memory";

export type KbProLinkGap = {
  id: string;
  stage: KbProLinkStage;
  what: string;
  how: string;
};

export type KbProLinkReport = {
  ok: boolean;
  stages: Array<{ id: KbProLinkStage; ok: boolean; line: string }>;
  gaps: KbProLinkGap[];
  /** Pro / 証拠に載せる1行 */
  line: string;
  /** foundation_gaps に足す行（KBから落とした決まり） */
  from_kb_gaps: string[];
  /** 課題ヒント */
  task_hints: Array<{ kind: string; what: string; why: string }>;
};

export type KbProLinkInput = {
  brainPull?: SupervisorProBrainPull | null;
  /** Pro が書いた不足土台 */
  foundationGaps?: string[] | null;
  buildNext?: string | null;
  pathTo100?: string | null;
  /** meeting */
  today?: string[] | null;
  evidenceLabels?: string[] | null;
  learningTaskKinds?: string[] | null;
  /** 細かい材料が Pro 材料にあるか */
  hasCauseRelearn?: boolean | null;
  hasImproveConstruct?: boolean | null;
  hasAcquireGrasp?: boolean | null;
  hasProThink?: boolean | null;
};

function hitMentions(h: ProKbHit, re: RegExp): boolean {
  return re.test(`${h.title} ${h.insight} ${(h.tags || []).join(" ")}`);
}

/**
 * 設計知見→統括Pro連携の完了線を測る。
 */
export function buildKbProLink(inp: KbProLinkInput): KbProLinkReport {
  const bp = inp.brainPull || null;
  const hits = bp?.kb_hits || [];
  const gapsOut: KbProLinkGap[] = [];
  const push = (g: KbProLinkGap) => {
    if (gapsOut.some((x) => x.id === g.id)) return;
    gapsOut.push(g);
  };

  const labels = (inp.evidenceLabels || []).map(String);
  const todayJoined = (inp.today || []).join(" ");
  const taskKinds = new Set((inp.learningTaskKinds || []).map(String));
  const proGaps = (inp.foundationGaps || []).join(" ");
  const arrange = `${inp.buildNext || ""} ${inp.pathTo100 || ""}`;

  const pullOk = !!(bp?.ok && hits.length > 0);
  const graspOk = pullOk && hits.every((h) => String(h.insight || "").trim().length >= 20)
    && (/統括Pro把握|知見/.test(labels.join(" ")) || /把握:/.test(todayJoined));
  const dropGapsOk = pullOk && (
    (inp.foundationGaps || []).length > 0
    || /足りない土台|foundation/.test(labels.join(" "))
    || arrange.length > 10
  );
  const dropTasksOk = pullOk && (
    taskKinds.has("photo_learn")
    || taskKinds.has("need_auto_run")
    || taskKinds.has("need_ext_reload")
    || taskKinds.has("reflect_auto")
    || taskKinds.has("build_foundation")
    || /次に学ぶ事|learning_tasks/.test(labels.join(" ") + todayJoined)
  );
  const fineOk = !!(
    inp.hasCauseRelearn
    && inp.hasImproveConstruct
    && inp.hasProThink
  );
  const logOk = !!(bp?.log_memory && bp.log_memory.length > 0);

  if (!pullOk) {
    push({
      id: "kb_pull",
      stage: "pull",
      what: "設計知見RAGが0件／失敗",
      how: "F37: searchKb/keyword_lite を直し、meet議題を問いへ載せる",
    });
  }
  if (pullOk && !graspOk) {
    push({
      id: "kb_grasp",
      stage: "grasp_insight",
      what: "引いたが要旨把握が薄い（題だけ／把握行なし）",
      how: "統括Pro把握に id8＋insight を残し、todayを『把握:』で始める",
    });
  }
  if (pullOk && !dropGapsOk) {
    push({
      id: "kb_drop_gaps",
      stage: "drop_gaps",
      what: "知見が foundation_gaps / build_next に落ちていない",
      how: "kb_hits の決まりを土台欠・次手に必ず1行ずつ落とす",
    });
  }
  if (pullOk && !dropTasksOk) {
    push({
      id: "kb_drop_tasks",
      stage: "drop_tasks",
      what: "知見が学習課題（photo_learn/反映/自動）に落ちていない",
      how: "決まりに対応する課題 kind を learning_tasks に載せる",
    });
  }
  if (!fineOk) {
    push({
      id: "kb_fine",
      stage: "fine_atoms",
      what: "細かい材料（原因再学習・改善構築・思考骨格）が Pro 材料に揃っていない",
      how: "ensureCauseRelearn / ensureImproveConstruct / ensureProThink を必ず通す",
    });
  }
  if (!logOk) {
    push({
      id: "kb_log",
      stage: "log_memory",
      what: "統括ログ記憶が無い（把握→改善の連続が切れる）",
      how: "learn_supervisor_log 直近を log_memory に継ぐ",
    });
  }

  /** KBから落とす土台・課題ヒント（細部） */
  const from_kb_gaps: string[] = [];
  const task_hints: Array<{ kind: string; what: string; why: string }> = [];
  for (const h of hits.slice(0, 6)) {
    if (hitMentions(h, /solid|画面位置|消失|preserve|引き継/)) {
      from_kb_gaps.push(`${h.id8}: 画面位置solidを履歴から継ぎ、消す書き込みを拒否（F33/F35）`);
      task_hints.push({
        kind: "reflect_auto",
        what: "履歴の画面位置を束に復元し反映する",
        why: `知見${h.id8}: ${h.title.slice(0, 40)}`,
      });
    }
    if (hitMentions(h, /photo_learn|画像学習|未学習|読む課題/)) {
      from_kb_gaps.push(`${h.id8}: 未学習があるのにphoto_learn課題を出さない禁止`);
      task_hints.push({
        kind: "photo_learn",
        what: "通常モードの画像を読んで弱い所を強化する",
        why: `知見${h.id8}: ${h.insight.slice(0, 60)}`,
      });
    }
    if (hitMentions(h, /反映|自動1回|read_count|一連|F31|F6|F38|F43/)) {
      from_kb_gaps.push(`${h.id8}: 束→拡張再読込→自動1回→効果確認まで一連`);
      task_hints.push({
        kind: "need_auto_run",
        what: "自動モードで1回検索し効果を数字で見る",
        why: `知見${h.id8}`,
      });
    }
    if (hitMentions(h, /原因|再学習|足りない→強化|改善する仕組み|志向/)) {
      from_kb_gaps.push(`${h.id8}: 原因→改善を再学習し仕組みを構築して自動へ`);
    }
    if (hitMentions(h, /送付済|acquire|取得タイミング|把握/)) {
      from_kb_gaps.push(`${h.id8}: 送付済み把握と取得タイミング連携`);
    }
  }
  // Pro gaps と重複しすぎない
  const uniqGaps = from_kb_gaps.filter((g, i, a) => a.indexOf(g) === i).slice(0, 8);
  const uniqHints = task_hints.filter((t, i, a) =>
    a.findIndex((x) => x.kind === t.kind && x.what.slice(0, 20) === t.what.slice(0, 20)) === i
  ).slice(0, 6);

  // すでに課題にある物はヒントから外す
  const hintsFiltered = uniqHints.filter((t) => !taskKinds.has(t.kind));

  const stages: KbProLinkReport["stages"] = [
    { id: "pull", ok: pullOk, line: pullOk ? `RAG ${hits.length}件（${bp?.line || "ok"}）` : "RAG 0件" },
    { id: "grasp_insight", ok: graspOk, line: graspOk ? "要旨で把握✓" : "要旨把握薄い" },
    { id: "drop_gaps", ok: dropGapsOk, line: dropGapsOk ? "土台/次手へ落下✓" : "gaps未落下" },
    { id: "drop_tasks", ok: dropTasksOk, line: dropTasksOk ? "課題へ落下✓" : "課題未落下" },
    { id: "fine_atoms", ok: fineOk, line: fineOk ? "細かい材料✓" : "細かい材料欠け" },
    { id: "log_memory", ok: logOk, line: logOk ? `ログ記憶${bp?.log_memory.length}` : "ログ記憶0" },
  ];

  const ok = stages.every((s) => s.ok);
  const line = ok
    ? `設計知見↔統括Pro連携✓（引く→把握→土台→課題→細部→ログ）`
    : `設計知見↔統括Pro連携: 止=${stages.find((s) => !s.ok)?.id}／欠${gapsOut.length}／${stages.filter((s) => !s.ok).map((s) => s.id).join("・")}`;

  // Pro gaps に既にある文言は from_kb から薄くする
  const fromFiltered = uniqGaps.filter((g) => !proGaps.includes(g.slice(0, 24)));

  return {
    ok,
    stages,
    gaps: gapsOut.slice(0, 8),
    line,
    from_kb_gaps: fromFiltered,
    task_hints: hintsFiltered,
  };
}
