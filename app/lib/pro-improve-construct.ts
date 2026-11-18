/**
 * 統括Pro「改善する仕組みを構築し、自動へ反映する」志向（2026-11-18 竹内さん）
 *
 *   「学習してから、どう強化するか／どのような仕組みがあれば改善されるか／
 *    何か足りていないか／何を補強するか／改善する仕組みを作っていく／
 *    次どのようにしていくか構築できるように／反映できるように／
 *    構築するために統括Proは何を志向するか／ちゃんと自動モード」
 *
 * ★ なぜ要るか
 *   足りない→強化→改善の骨格だけでは「仕組みを作る・次を構築する・自動に載せる」が薄い。
 *   Pro が毎回この志向で build_next / path_to_100 を書くための決定論台帳。
 *
 * ⚠ 純関数。推測で弱点を増やさない。
 */

export type ImproveConstructStage =
  | "learn"
  | "missing"
  | "strengthen_how"
  | "mechanism"
  | "construct"
  | "reflect_bundle"
  | "ext_reload"
  | "auto_run"
  | "measure";

export type ImproveConstructGap = {
  id: string;
  stage: ImproveConstructStage;
  /** 何が足りない／何を補強するか */
  what: string;
  /** どんな仕組みがあれば改善されるか */
  mechanism: string;
  /** どう構築するか */
  construct: string;
  /** 自動モードへの反映 */
  reflect_auto: string;
  cost: "free" | "flash" | "ext" | "human";
};

export type ProOrientationAim = {
  id: string;
  /** 志向（Proが常に向く方向） */
  aim: string;
  /** 自動モードでの完了の見方 */
  auto_done: string;
};

export type ImproveConstructReport = {
  /** Proが構築のために志向すること */
  orientations: ProOrientationAim[];
  /** 改善構築の段（必ずこの順） */
  stages: Array<{ id: ImproveConstructStage; label: string; done_line: string }>;
  gaps: ImproveConstructGap[];
  /** 次に構築する1手 */
  next_construct: string;
  /** 自動へ反映する1手 */
  next_reflect: string;
  /** path_to_100 用の短い順 */
  path_line: string;
  line: string;
  scaffold: string;
};

export type ImproveConstructInput = {
  /** 学習材料があるか */
  learnedOk?: number | null;
  photoTodo?: number | null;
  hasPhotoLearnTask?: boolean | null;
  /** 束→拡張 */
  readCount?: number | null;
  /** 新束後の自動 */
  autoAfter?: boolean | null;
  reflectOk?: number | null;
  /** 土台欠 */
  foundationMissingN?: number | null;
  /** 把握印（送付済・armed 等） */
  acquireArmed?: boolean | null;
  acquireSentGrasped?: boolean | null;
  stuckBeforeAcquire?: boolean | null;
  /** Pro思考骨格の欠件数 */
  thinkMissingN?: number | null;
  /** 仕組み一覧に載っているか（表示だけでなく適用） */
  mechanismApplied?: boolean | null;
};

const ORIENTATIONS: ProOrientationAim[] = [
  {
    id: "o_learn_first",
    aim: "まず実データで学習する（推測で仕組みを増やさない）",
    auto_done: "学び印が束に残り、拡張が読める",
  },
  {
    id: "o_missing",
    aim: "何が足りないか・何を補強するかを層で名指しする",
    auto_done: "missing が foundation_gaps / weak_fixes に落ちている",
  },
  {
    id: "o_how",
    aim: "どう強化するかを具体手（flash/関所/拡張/人）で書く",
    auto_done: "strengthen / how が課題 kind に対応している",
  },
  {
    id: "o_mechanism",
    aim: "どのような仕組みがあれば改善されるかを先に定義する（完了線付き）",
    auto_done: "F番号または台帳の完了線が測れる",
  },
  {
    id: "o_construct",
    aim: "改善する仕組みを構築する（表示だけで終わらせない）",
    auto_done: "build_next が実装・配線・テストまで落ちている",
  },
  {
    id: "o_next",
    aim: "次にどう構築するかを1手で出せる",
    auto_done: "path_to_100 の先頭が無料の構築手",
  },
  {
    id: "o_reflect",
    aim: "構築したら必ず自動モードへ反映し効果を数字で見る",
    auto_done: "束→再読込→自動1回→F31/F32/F43/aim/把握印",
  },
];

const STAGES: ImproveConstructReport["stages"] = [
  { id: "learn", label: "学習", done_line: "材料が束／課題に載った" },
  { id: "missing", label: "足りない把握", done_line: "欠が層付きで列挙された" },
  { id: "strengthen_how", label: "どう強化", done_line: "how が具体手になった" },
  { id: "mechanism", label: "仕組み定義", done_line: "完了線付き仕組みが名指し" },
  { id: "construct", label: "構築", done_line: "コード・台帳・関所ができた" },
  { id: "reflect_bundle", label: "束反映", done_line: "新束に学びが残る" },
  { id: "ext_reload", label: "拡張読込", done_line: "read_count≥1" },
  { id: "auto_run", label: "自動1回", done_line: "新束後の自動走行あり" },
  { id: "measure", label: "効果測定", done_line: "F31/F32/F43・把握印で改善を確認" },
];

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
}

/**
 * 改善構築の欠と次手を組む。
 */
export function buildImproveConstruct(inp: ImproveConstructInput): ImproveConstructReport {
  const learned = n(inp.learnedOk);
  const todo = n(inp.photoTodo);
  const read = n(inp.readCount);
  const missF = n(inp.foundationMissingN);
  const thinkM = n(inp.thinkMissingN);
  const reflect = n(inp.reflectOk);

  const gaps: ImproveConstructGap[] = [];
  const push = (g: ImproveConstructGap) => {
    if (gaps.some((x) => x.id === g.id)) return;
    gaps.push(g);
  };

  if (todo > 0 && inp.hasPhotoLearnTask !== true) {
    push({
      id: "g_learn_task",
      stage: "learn",
      what: `未学習${todo}があるのに学習課題が無い`,
      mechanism: "photo_learn 課題生成の関所（材料があるのに出さない禁止）",
      construct: "決定論 learning_tasks に photo_learn を必ず載せる",
      reflect_auto: "課題実行→束更新→拡張再読込→自動1回",
      cost: "free",
    });
  }
  if (thinkM > 0 || missF > 0) {
    push({
      id: "g_missing_named",
      stage: "missing",
      what: `足りない把握が薄い（思考欠${thinkM || 0}／土台欠${missF || 0}）`,
      mechanism: "pro-think missing → foundation_gaps への落とし",
      construct: "欠を層付きで foundation_gaps に書き、補強対象を1つに絞る",
      reflect_auto: "欠が埋まった欄だけ自動で効果が測れる印を残す",
      cost: "free",
    });
  }
  if (inp.stuckBeforeAcquire === true || inp.acquireArmed === false) {
    push({
      id: "g_armed_mech",
      stage: "mechanism",
      what: "物件取得の armed／送付済み把握の仕組みが空",
      mechanism: "acquire_grasp 台帳（wait_fill→armed→sent→press→次頁）と完了線",
      construct: "把握印を progress/steps に残し、開始前と送付済詰まりを分離",
      reflect_auto: "自動1回で acq_armed / acq_sent_* が残ること",
      cost: "ext",
    });
  }
  if (inp.acquireSentGrasped === false) {
    push({
      id: "g_sent_grasp",
      stage: "strengthen_how",
      what: "送付済みを『送った』と把握する力が弱い",
      mechanism: "sent_loaded→sent_marked→all_sent（飛ばし≠失敗）",
      construct: "除外件数を台帳に残し次頁／客完了へ連携",
      reflect_auto: "全部送付済でも status が進み、0件送信を失敗扱いしない",
      cost: "ext",
    });
  }
  if (inp.mechanismApplied !== true) {
    push({
      id: "g_mech_apply",
      stage: "construct",
      what: "改善の仕組みが『表示』だけで適用・構築に落ちていない疑い",
      mechanism: "LEARN_MECHANISMS と build_next / F番号の対応表",
      construct: "仕組み1つ＝完了線1つ＋自動反映手1つで実装する",
      reflect_auto: "仕組み適用後に自動走行で完了線を測る",
      cost: "free",
    });
  }
  if (learned > 0 && read < 1) {
    push({
      id: "g_reflect_read",
      stage: "ext_reload",
      what: "学んだのに拡張が読んでいない",
      mechanism: "束→拡張読込関所（read_count）",
      construct: "再読込＋ポップアップ取込を build_next の必須段にする",
      reflect_auto: "read_count≥1 のあと自動1回",
      cost: "ext",
    });
  }
  if (inp.autoAfter !== true) {
    push({
      id: "g_auto_after",
      stage: "auto_run",
      what: "新束／新仕組みのあとの自動1回が無い",
      mechanism: "needs_auto／verify_improve 一連",
      construct: "構築完了の出口に自動1回手配を必ず付ける",
      reflect_auto: "自動1回→効果数字（point/aim/把握印）",
      cost: "human",
    });
  }
  if (reflect < 1 && (learned > 0 || read >= 1)) {
    push({
      id: "g_measure",
      stage: "measure",
      what: "反映の効果印（learn_reflect_ok 等）が無い",
      mechanism: "F31/F32/F43 の完了線",
      construct: "自動 steps に reflect_ok／aim有を残す配線を維持",
      reflect_auto: "reflect_ok≥1 かつ aim有≥1 で改善済みと数える",
      cost: "ext",
    });
  }

  const first = gaps[0] || null;
  const next_construct = first
    ? `構築: ${first.construct}（仕組み: ${first.mechanism}）`
    : "維持: 欠が無ければ完了線の測定だけ続ける";
  const next_reflect = first
    ? `自動反映: ${first.reflect_auto}`
    : "自動反映: 次回の改善でも束→再読込→自動1回→測定";

  const path_line = [
    "①足りないを名指し",
    "②仕組み（完了線）を定義",
    "③構築（コード/台帳/関所）",
    "④束反映",
    "⑤拡張再読込",
    "⑥自動1回",
    "⑦数字で効果",
  ].join("→");

  const scaffold = [
    `志向${ORIENTATIONS.length}: ${ORIENTATIONS.slice(0, 3).map((o) => o.aim).join("／")}`,
    `構築欠${gaps.length}: ${gaps.slice(0, 3).map((g) => g.what).join("／") || "大きな欠なし"}`,
    `次構築: ${next_construct}`,
    `次反映: ${next_reflect}`,
  ].join(" ｜ ");

  const line = first
    ? `改善構築: 止=${first.stage}:${first.what}／次=${first.construct.slice(0, 60)}`
    : `改善構築: 欠なし／${path_line}`;

  return {
    orientations: ORIENTATIONS,
    stages: STAGES,
    gaps: gaps.slice(0, 10),
    next_construct,
    next_reflect,
    path_line,
    line,
    scaffold: scaffold.slice(0, 700),
  };
}
