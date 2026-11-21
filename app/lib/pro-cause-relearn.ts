/**
 * 統括Pro「原因思考・再学習・土台/連携の抜け」徹底（2026-11-18 竹内さん）
 *
 *   「学習の抜け・土台・連携も細かく見て改善」
 *   「実際の人間のように何が原因か、どうやったら改善されるか思考する」
 *   「新しい考え方でもう一度学習して何が原因だったのか、なにを改善するのか全部学習」
 *   「録画とDBから統括Proは徹底的に強化／土台の徹底した強化」
 *
 * ★ なぜ要るか
 *   足りない一覧だけでは「なぜ起きたか」が薄い。人間は症状→原因→直し方で考える。
 *   録画診断・監査DB・土台F・連携印を材料に、原因→改善→再学習を決定論で組む。
 *
 * ⚠ 純関数。推測は hypothesis に「仮定:」付き。数字の無い原因は作らない。
 */

export type CauseLayer = "learn" | "foundation" | "link" | "auto" | "grasp" | "reflect";

export type CauseAtom = {
  id: string;
  layer: CauseLayer;
  /** 何が起きたか（症状） */
  symptom: string;
  /** 何が原因か（DB/録画の根拠付き） */
  cause: string;
  /** どうやったら改善されるか */
  how: string;
  /** 再学習で覚えること */
  relearn: string;
  /** 土台（F番号や台帳） */
  foundation: string;
  evidence: string;
  cost: "free" | "flash" | "ext" | "human";
  /** 推測の時だけ */
  hypothesis?: string;
};

export type CauseRelearnReport = {
  atoms: CauseAtom[];
  /** Pro の foundation_gaps に落とす行 */
  foundation_gaps: string[];
  /** 新しい考え方での再学習要約 */
  relearn_line: string;
  /** 人間らしい思考の順 */
  think_like_human: string[];
  bottleneck: string | null;
  line: string;
  scaffold: string;
};

export type CauseRelearnInput = {
  /** 監査 */
  auditStatus?: string | null;
  auditExt?: string | null;
  filledNull?: boolean | null;
  layoutOps?: number | null;
  searchOps?: number | null;
  /** 診断原子 id */
  diagnoseIds?: string[] | null;
  diagnoseText?: string | null;
  /** 土台 ✗ */
  foundationFails?: Array<{ id: string; line?: string; next?: string }> | null;
  foundationMissingN?: number | null;
  /** 連携 */
  readCount?: number | null;
  autoAfter?: boolean | null;
  reflectOk?: number | null;
  linkPipelineOk?: boolean | null;
  /** 学習 */
  photoTodo?: number | null;
  hasPhotoLearnTask?: boolean | null;
  kindConflictN?: number | null;
  photoVsRecordN?: number | null;
  /** 把握 */
  stuckBeforeAcquire?: boolean | null;
  acquireArmed?: boolean | null;
  sentGrasped?: boolean | null;
  /** 思考欠 */
  thinkMissingN?: number | null;
};

/** 2026-11-21 作業員G: 材料に無い数を 0 と読まない（既定 off・PRO_CAUSE_NULL_STRICT=on）。段A（scripts/search-pro-exam.ts）で確かめる */
export function proCauseNullStrictOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.PRO_CAUSE_NULL_STRICT ?? "").trim().toLowerCase() === "on";
}

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) && x >= 0 ? Math.floor(x) : -1;
}

/**
 * 録画+DB材料から原因→改善→再学習を組む。
 */
export function buildCauseRelearn(inp: CauseRelearnInput): CauseRelearnReport {
  const atoms: CauseAtom[] = [];
  const push = (a: CauseAtom) => {
    if (atoms.some((x) => x.id === a.id)) return;
    atoms.push(a);
  };

  const status = String(inp.auditStatus || "");
  const diag = new Set((inp.diagnoseIds || []).map(String));
  const joined = String(inp.diagnoseText || "");
  const fails = inp.foundationFails || [];
  // 2026-11-21 作業員G（統括Pro 段A で見つけた）: Number(null) は 0 なので、材料に数が無い時も「読んだ数 0」「反映 0」として
  //   c_read0（拡張が束を読んでいない）・c_no_reflect_mark を作っていた（凍結10件のうち5件。read=2・read=14 の時も「読んでいない」）。
  //   「数字の無い原因は作らない」の決まりどおり、無い数は -1（分からない）にする。既定 off（PRO_CAUSE_NULL_STRICT=on）
  const nn = proCauseNullStrictOn() ? (v: unknown) => (v == null || v === "" ? -1 : n(v)) : n;
  const missF = nn(inp.foundationMissingN);
  const todo = nn(inp.photoTodo);
  const read = nn(inp.readCount);
  const reflect = nn(inp.reflectOk);
  const layoutOps = n(inp.layoutOps);
  const searchOps = n(inp.searchOps);

  // ── 物件未取得（開始前）: DB実測型 ──
  if ((status === "started" || status === "abandoned") && (inp.filledNull === true || layoutOps === 0)) {
    push({
      id: "c_before_acquire",
      layer: "auto",
      symptom: `物件が取得されない／監査が ${status || "未完了"} のまま`,
      cause: "送付済み詰まりではなく取得開始前（fill-done/search_armed/Case C 未達）",
      how: "検索click直前に armed 生存印→fill-done→送付済把握→PDF押しの順を印で追う",
      relearn: "未取得の原因は『開始前』と『送付済詰まり』を分けて学習する",
      foundation: "F45完了理解台帳／acquire_grasp.armed",
      evidence: `status=${status} filledNull=${inp.filledNull} layoutOps=${layoutOps} searchOps=${searchOps} ext=${inp.auditExt || "?"}`,
      cost: "ext",
    });
  }
  if (diag.has("property_path_break") || /blocked_need_fill_done|fill_done_gap/.test(joined)) {
    push({
      id: "c_path_break",
      layer: "link",
      symptom: "検索後に物件取得連携が切れる",
      cause: "axlx-search-armed→pending→Case C の連携抜け",
      how: "search_armed を content/bulk-dl 両方に残し、リロード後も Case C で開始",
      relearn: "連携抜けは『印が残ったか』で原因を学習する（画面文だけで決めない）",
      foundation: "F32 link_pipeline／F6 auto_after_bundle",
      evidence: `diagnose=${[...diag].join(",")}`,
      cost: "ext",
    });
  }
  if (diag.has("sent_stuck_misread") || diag.has("sent_ungrasped")) {
    push({
      id: "c_sent_misread",
      layer: "grasp",
      symptom: "送付済みで詰まった／把握できていないように見える",
      cause: "送付済みを失敗と誤認、または sent 把握印が無い",
      how: "sent_loaded→marked→all_sent。飛ばしは数えて次頁／客完了へ",
      relearn: "送付済み＝送ったと把握。0件送信≠失敗を学習する",
      foundation: "acquire_grasp sent段",
      evidence: `diagnose=${[...diag].filter((d) => /sent/.test(d)).join(",")}`,
      cost: "ext",
    });
  }

  // ── 学習の抜け ──
  if (todo > 0 && inp.hasPhotoLearnTask !== true) {
    push({
      id: "c_photo_task_gap",
      layer: "learn",
      symptom: `未学習${todo}があるのに学べ課題が無い`,
      cause: "photo_learn 課題生成の関所未通過（材料はあるのに課題に落ちない）",
      how: "決定論 learning_tasks に photo_learn を必ず載せる",
      relearn: "学習の抜け＝材料不足ではなく関所未通過のことがある",
      foundation: "F49 写真→統括到達／課題関所",
      evidence: `todo=${todo} hasPhotoLearnTask=false`,
      cost: "free",
    });
  }
  if ((inp.kindConflictN || 0) > 0) {
    push({
      id: "c_kind_conflict",
      layer: "learn",
      symptom: `写真内種類衝突${inp.kindConflictN}`,
      cause: "同じ欄が写真で種類揺れ（細部再読が未完）",
      how: "衝突欄を2枚以上再読。既知selectは種類再判定せず位置へ",
      relearn: "衝突は『読め枚数』ではなく『欄×観点の細部』不足として学習する",
      foundation: "F51 人間細部ループ",
      evidence: `kindConflictN=${inp.kindConflictN}`,
      cost: "flash",
    });
  }
  if ((inp.photoVsRecordN || 0) > 0) {
    push({
      id: "c_vs_record",
      layer: "learn",
      symptom: `記録≠写真${inp.photoVsRecordN}`,
      cause: "操作記録と写真読みの取り違え（select/click等）",
      how: "食い違い欄を突合。既知selectは記録を正として位置学習へ",
      relearn: "記録と写真の食い違いは種類の再学習ではなく正本の決め方を学習する",
      foundation: "F20/F21 操作材料",
      evidence: `photoVsRecordN=${inp.photoVsRecordN}`,
      cost: "free",
    });
  }

  // ── 土台の抜け（F番号） ──
  for (const f of fails.slice(0, 10)) {
    const id = String(f.id || "").slice(0, 40);
    if (!id) continue;
    push({
      id: `c_f_${id}`,
      layer: "foundation",
      symptom: `土台✗ ${id}`,
      cause: String(f.line || "完了線未達").slice(0, 160),
      how: String(f.next || "欠Fを優先順で埋める").slice(0, 160),
      relearn: `土台 ${id} の完了線と次手を覚え、症状が出てからではなく先に測る`,
      foundation: id,
      evidence: String(f.line || "").slice(0, 120),
      cost: /flash|photo|Vision|枚/.test(String(f.next || "")) ? "flash"
        : /再読込|拡張|印/.test(String(f.next || "")) ? "ext"
          : /人|録画|need_human/.test(String(f.next || "")) ? "human"
            : "free",
    });
  }
  if (missF > 0 && fails.length === 0) {
    push({
      id: "c_foundation_n",
      layer: "foundation",
      symptom: `土台欠 ${missF}`,
      cause: "foundation_audit の欠が名指し項目として届いていない可能性",
      how: "欠Fの items を Pro axes / foundation_gaps に落とす",
      relearn: "土台は件数だけでなく id×完了線×次手で学習する",
      foundation: "F番号一式",
      evidence: `missing_n=${missF}`,
      cost: "free",
    });
  }

  // ── 連携・反映 ──
  if (read === 0) {
    push({
      id: "c_read0",
      layer: "link",
      symptom: "学んだ束を拡張が読んでいない（read_count=0）",
      cause: "束→拡張読込の連携切れ（再読込／取込未実施）",
      how: "拡張再読込→ポップアップ取込→read_count≥1を確認してから自動",
      relearn: "学べ済み≠現場改善。連携の完了線は read_count",
      foundation: "F38 improve_reflect_chain／F6",
      evidence: "read_count=0",
      cost: "ext",
    });
  }
  if (inp.autoAfter === false) {
    push({
      id: "c_no_auto_after",
      layer: "reflect",
      symptom: "新束後の自動1回が無い",
      cause: "効果確認段が手配されていない",
      how: "構築・学習の出口に自動1回＋verify_improve を必ず付ける",
      relearn: "改善の完了は自動の数字で学習する",
      foundation: "F6／F31／F43",
      evidence: "auto_after=false",
      cost: "human",
    });
  }
  if (reflect === 0 && (read >= 1 || todo === 0)) {
    push({
      id: "c_no_reflect_mark",
      layer: "reflect",
      symptom: "learn_reflect_ok 等の効果印が無い",
      cause: "反映印が steps に残っていない／消えている",
      how: "自動 steps に reflect_ok・aim有を残す（F43完了線）",
      relearn: "反映は印で測る。読んだだけでは改善済みにしない",
      foundation: "F31／F43",
      evidence: `reflectOk=${reflect} read=${read}`,
      cost: "ext",
    });
  }
  if (inp.linkPipelineOk === false) {
    push({
      id: "c_link_pipe",
      layer: "link",
      symptom: "連携パイプライン未達",
      cause: "束→拡張→自動のどこかの段が欠けている",
      how: "F32 の段を1つずつ印で確認し、欠け段だけ直す",
      relearn: "連携は全体ではなく段ごとの原因で学習する",
      foundation: "F32",
      evidence: "linkPipelineOk=false",
      cost: "free",
    });
  }
  if ((inp.thinkMissingN || 0) > 0) {
    push({
      id: "c_think_to_gaps",
      layer: "foundation",
      symptom: `思考欠${inp.thinkMissingN}が foundation_gaps に落ちていない疑い`,
      cause: "pro_think.missing → foundation_gaps の落としが無い",
      how: "missing を層付きで foundation_gaps に書き、補強対象を1つに絞る",
      relearn: "考える能力の欠は土台欠として再学習する",
      foundation: "pro-think→foundation_gaps",
      evidence: `thinkMissingN=${inp.thinkMissingN}`,
      cost: "free",
    });
  }
  if (inp.stuckBeforeAcquire === true || inp.acquireArmed === false) {
    push({
      id: "c_armed_empty",
      layer: "grasp",
      symptom: "acquire_grasp の armed 段が空",
      cause: "取得タイミングの把握台帳が埋まっていない",
      how: "armed印を progress/steps に残す（ensureAcquireGraspEvidence＋拡張）",
      relearn: "把握力は台帳の段で学習・強化する",
      foundation: "acquire_grasp／F45",
      evidence: `stuckBefore=${inp.stuckBeforeAcquire} armed=${inp.acquireArmed}`,
      cost: "ext",
    });
  }

  const think_like_human = [
    "①症状: 画面・監査・数字で何が起きているか",
    "②原因: DBと録画で何が欠けているか（推測は仮定）",
    "③層: 学習／土台／連携／把握／反映のどれか",
    "④どう改善: 具体手（関所・flash・拡張・人）",
    "⑤再学習: 同じ型が他客で再発しないよう覚える",
    "⑥土台: F番号・完了線を先に埋める",
    "⑦自動: 束→再読込→自動1回→印で効果",
  ];

  const foundation_gaps = atoms.slice(0, 8).map((a) =>
    `${a.foundation}: 原因=${a.cause.slice(0, 60)}／改善=${a.how.slice(0, 60)}`
  );

  const first = atoms[0] || null;
  const relearn_line = first
    ? `再学習: ${first.relearn}／原因=${first.cause.slice(0, 50)}／改善=${first.how.slice(0, 50)}`
    : "再学習: 大きな原因原子なし（完了線の測定を続ける）";

  const scaffold = [
    `人間思考: ${think_like_human.slice(0, 3).join(" ")}`,
    `原因原子${atoms.length}: ${atoms.slice(0, 4).map((a) => a.id).join("・") || "—"}`,
    relearn_line,
    `土台gaps${foundation_gaps.length}`,
  ].join(" ｜ ");

  const line = first
    ? `原因再学習: ${first.symptom} ← ${first.cause.slice(0, 50)} → ${first.how.slice(0, 40)}`
    : "原因再学習: 欠なし";

  return {
    atoms: atoms.slice(0, 12),
    foundation_gaps,
    relearn_line,
    think_like_human,
    bottleneck: first ? `${first.layer}:${first.symptom}` : null,
    line,
    scaffold: scaffold.slice(0, 700),
  };
}
