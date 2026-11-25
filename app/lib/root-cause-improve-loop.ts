/**
 * F64 根本原因改善ループ（2026-11-24 竹内さん）
 *
 * 「指示のあと表面だけ直して終わり」を禁止する。
 * 完了線は次の全部が揃った時だけ:
 *   ①症状を本番DBで測った（画面の一言だけで決めない）
 *   ②根本原因の型を書いた（材料未達／段の読み違い／先走り印／関所欠 等）
 *   ③その型が再発しない所を直すコード＋テストがある
 *   ④配線スイート（F58）PASS
 *   ⑤本番監査で検証印が出た（例: next_move_premature_block または search確認後の sort）
 *
 * 参照KB: 0ddb2f80（F64表面禁止）／54dfb836（検索前並べ替え関所）／
 *   f633495b（1問当て禁止・深く直す）／d8694791（F58）／d923859f（DB確認）
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type RootCauseKind =
  | "material_missing" // 材料がAI/拡張に届いていない
  | "phase_misread" // 場面・段の読み違い
  | "premature_advance" // 完了前に次タスクへ先走り
  | "gate_missing" // 関所が無い／弱い
  | "stale_state" // 前客・前段の印が残っている
  | "surface_only"; // 表面（文言・1箇所の例外）だけ — 完了不可

export type RootCauseCase = {
  id: string;
  symptom: string;
  /** 本番DBで見た数字・印（無いなら incomplete） */
  dbEvidence: string;
  rootKind: RootCauseKind;
  rootWhy: string;
  fixTarget: string;
  testPath: string;
  /** 実証に必要な監査印（いずれか） */
  verifyAnyOf: string[];
  /**
   * 実証印を認める最小拡張版。これ未満の監査に残った古い印だけで ✓ にしない
   * （連続客: 2.8.225 の loop_advance 1件で 2.8.235 修正を「実証済み」と誤認した抜け）
   */
  minVerifyExtVersion?: string;
};

export type RootCauseLoopInput = {
  cases: RootCauseCase[];
  /** F58 スイートが直近で ok か */
  extTestOk: boolean;
  /** 最新自動監査の step keys（page: / dl: 付き可） */
  latestAuditKeys: string[];
  latestExtVersion: string;
  codeExtVersion: string;
};

export type RootCauseLoopResult = {
  ok: boolean;
  line: string;
  gaps: string[];
  next: string;
  cases: Array<{
    id: string;
    ok: boolean;
    gaps: string[];
  }>;
};

const SURFACE_BAN = /surface_only/;

export function classifyFixAsSurface(rootKind: RootCauseKind, fixTarget: string): boolean {
  if (rootKind === "surface_only") return true;
  // 例外の if 1本・文言だけを疑う目印
  if (/文言|表示だけ|1箇所|例外の if|コメントだけ/i.test(fixTarget)) return true;
  return false;
}

export function caseVerified(
  c: RootCauseCase,
  latestAuditKeys: string[],
  latestExtVersion = "",
): { ok: boolean; gaps: string[] } {
  const gaps: string[] = [];
  if (!c.dbEvidence || /未測|なし|none/i.test(c.dbEvidence)) {
    gaps.push("DB証拠が無い（症状を本番で測っていない）");
  }
  if (SURFACE_BAN.test(c.rootKind) || classifyFixAsSurface(c.rootKind, c.fixTarget)) {
    gaps.push("表面直し扱い（型の根元になっていない）");
  }
  if (!c.testPath) gaps.push("再発防止テストが無い");
  const minV = String(c.minVerifyExtVersion || "").trim();
  const latestV = String(latestExtVersion || "").trim();
  if (minV && (!latestV || latestV < minV)) {
    gaps.push(
      `実証版が足りない（要≥${minV}・今=${latestV || "無し"}／古い監査の印だけでは足りない）`,
    );
  } else if (!c.verifyAnyOf.length) {
    gaps.push("実証印が定義されていない");
  } else {
    const hit = c.verifyAnyOf.some((v) =>
      latestAuditKeys.some((k) => k === v || k.endsWith(":" + v) || k.includes(v)),
    );
    if (!hit) gaps.push(`実証印が無い（要: ${c.verifyAnyOf.join("|")}）`);
  }
  return { ok: gaps.length === 0, gaps };
}

/**
 * 既知の拡張ボトルネック（検索前並べ替え先走り）の正本ケース。
 * エージェントはこの型で直す（画面の「並び替えが出た」だけ直さない）。
 */
export const ROOT_CAUSE_CANON_CASES: RootCauseCase[] = [
  {
    id: "sort_announce_before_search",
    symptom: "検索ボタン押下前に『つぎ＝並べ替え』が出る／検索前で止まる",
    dbEvidence: "pending", // 実行時に scripts が埋める
    rootKind: "premature_advance",
    rootWhy:
      "conditions_done/place_done 等のタスク切替が、前段の stale な taskNext（並べ替え）を継承して persist していた。" +
      "検索確認（search_press_ok / search_grasped confirmed）前に nextMove=並べ替えを許していた。",
    fixTarget:
      "_guardNextMove + _taskNextForPhase（段ごとの次を強制）／検索未確認なら並べ替えを『検索を押す』に差し戻し",
    testPath: "tests/chrome-extension/search-before-sort-next-guard-v28233.test.js",
    /** 実証は関所印を優先（search_press_ok だけでは表面通過にしない） */
    verifyAnyOf: [
      "next_move_premature_block",
      "page:next_move_premature_block",
      "dl:next_move_premature_block",
    ],
    minVerifyExtVersion: "2.8.233",
  },
  {
    id: "stuck_next_page_on_single_page",
    symptom: "一覧が1ページだけなのに『つぎ＝次ページを押す』で止まる",
    dbEvidence: "pending",
    rootKind: "phase_misread",
    rootWhy:
      "before_next 把握が次ボタンの有無／1ページのみを見ずに nextMove＝次ページを押すを常に出していた。" +
      "リアプロは1ページでも『次』セルが出るが、pager数字が1つだけ／onclick無し＝最終。印 list_page_one_only がDBに0だった。",
    fixTarget:
      "_readPagerState（onlyOnePage）＋_findNextPageElが1ページでnull＋before_nextの次＝物件取得完了→外す＋handoff",
    testPath: "tests/chrome-extension/list-one-page-grasp-v28234.test.js",
    verifyAnyOf: [
      "list_page_one_only",
      "dl:list_page_one_only",
      "page:list_page_one_only",
      "list_no_next_advance",
      "dl:list_no_next_advance",
    ],
    minVerifyExtVersion: "2.8.234",
  },
  {
    id: "continuous_loop_advance_thin",
    symptom: "一連は動くが次客へ移る把握が弱い／loop_advanceがほぼ無い",
    dbEvidence: "pending",
    rootKind: "gate_missing",
    rootWhy:
      "DB直近50で series_done=4・loop_advance=1（同一監査で揃うのは1件のみ）。" +
      "fill-done経路が series_done だけ残し、いま客・次客・次の動き・ループ完了→次へ が欠ける。" +
      "取得完了(_sendBatchDone)も stamp が薄い。古い loop_advance 1件で実証済みと誤認しない。",
    fixTarget:
      "background fill一連でも loop_advance+who+next_move／bulk _stampSeriesToNextCustomer／page axlx-series-handoff",
    testPath: "tests/chrome-extension/continuous-series-next-grasp-v28235.test.js",
    verifyAnyOf: [
      "loop_advance",
      "page:loop_advance",
      "dl:loop_advance",
      "loop_who_grasp",
      "page:loop_who_grasp",
      "dl:loop_who_grasp",
    ],
    minVerifyExtVersion: "2.8.235",
  },
  {
    id: "timeout_without_screen_poll",
    symptom: "タイムアウトだけで止まり、画面照会でなぜ詰まっているか把握していない",
    dbEvidence: "pending",
    rootKind: "gate_missing",
    rootWhy:
      "DB直近40で timeoutOnly=3（fill_timeout 等）・画面照会印が無い監査がある。" +
      "waitForClick／fill_timeout が盲目で打ち切り、詰まり理由と次手が残らない。",
    fixTarget:
      "_screenPollGrasp（待ち中）＋_screenPollThenApiNext（切れ時に画面→API→next_move）／決まり screen_poll_instead_of_timeout",
    testPath: "tests/chrome-extension/screen-poll-instead-of-timeout-v28236.test.js",
    verifyAnyOf: [
      "screen_poll_grasp",
      "page:screen_poll_grasp",
      "screen_poll_api_next",
      "page:screen_poll_api_next",
    ],
    minVerifyExtVersion: "2.8.236",
  },
  {
    id: "clear_mid_stuck_improvements_unused",
    symptom: "外している最中(1/3)で止まり、画面照会・スクショ・最善次手が回らない",
    dbEvidence: "audit #1610 2.8.238 started steps=0／画面は一覧+外し表示／統括:完了→次客穴",
    rootKind: "gate_missing",
    rootWhy:
      "結果一覧では常に listRows>0 のため診断が list 固定→stuck_best_act が list_ready 空振り。" +
      "残カウントが station_code[]/line_id[]（誤名）で常に0。" +
      "画面照会改善は waitForClick 切れ専用で、外し段の沈黙停止では武装されない。",
    fixTarget:
      "_diagnoseStuckScreen の clearFillCtx優先＋station_id/route_id／_armClearStuckWatch／決まり clear_stuck_watch_use_improvements",
    testPath: "tests/chrome-extension/clear-stuck-watch-v28239.test.js",
    verifyAnyOf: [
      "clear_watch_on",
      "page:clear_watch_on",
      "clear_watch_tick",
      "page:clear_watch_tick",
      "stuck_best_act",
      "page:stuck_best_act",
    ],
    minVerifyExtVersion: "2.8.239",
  },
  {
    id: "ad_sort_before_search_results",
    symptom: "検索ボタン押下直後・結果未反映なのにAD並び替えが出て詰まる／検索前にラグ",
    dbEvidence: "自動#1612 2.8.239／竹内さん現場報告：押した瞬間まだ検索されていないのにAD",
    rootKind: "gate_missing",
    rootWhy:
      "search_press_ok で confirmed=true→bulk が AD kick。" +
      "画面照合は tries≥3 で旧一覧でも screenOk。" +
      "条件完了→検索が API取込待ちでラグ。",
    fixTarget:
      "押下=結果待ち／screenOk後だけAD／旧一覧変化必須／fill_doneはAPI非ブロック／決まり search_results_before_ad_sort",
    testPath: "tests/chrome-extension/search-results-before-ad-v28240.test.js",
    verifyAnyOf: [
      "search_results_ready",
      "page:search_results_ready",
      "search_press_wait_results",
      "page:search_press_wait_results",
      "dl:search_press_wait_results",
      "dl:search_customer_screen_ok",
    ],
    minVerifyExtVersion: "2.8.240",
  },
  {
    id: "silence_hang_no_stuck_wiring",
    symptom: "毎回部分で止まり stuck_shot=0・steps=0。止まったらスクショ→次が動かない",
    dbEvidence: "#1612/#1610 started steps=0／直近15件 stuck_shot=0 clear_watch=0",
    rootKind: "gate_missing",
    rootWhy:
      "監視が外し専用・waitForClick切れ専用で沈黙停止に未配線。" +
      "live-flushがgraspを薄い{at,why}で上書きし古い空データが判断を汚す。" +
      "沈黙でも次へ進まずパイプラインが止まる。",
    fixTarget:
      "_armFillSilenceWatch keep武装／3回で次タスク／6回で次客／_forceAuditStepsFlush／旧grasp無効化",
    testPath: "tests/chrome-extension/silence-periodic-advance-v28242.test.js",
    verifyAnyOf: [
      "silence_watch_on",
      "page:silence_watch_on",
      "silence_watch_keep",
      "page:silence_watch_keep",
      "silence_watch_tick",
      "page:silence_watch_tick",
      "silence_task_advance",
      "page:silence_task_advance",
      "stale_grasp_drop",
      "page:stale_grasp_drop",
      "stuck_shot_req",
      "page:stuck_shot_req",
    ],
    minVerifyExtVersion: "2.8.242",
  },
  {
    id: "legacy_ad_collides_screen_ok",
    symptom: "検索結果前にAD／旧legacy経路が新関所とぶつかって止まる・誤進む",
    dbEvidence: "legacy_claude_path と search_results_before_ad が同時存在／結果前AD",
    rootKind: "stale_state",
    rootWhy:
      "2.8.194のlegacy_claude_pathがafterSearchでscreenOk無しにADへ進み、" +
      "2.8.240の結果確認関所と衝突。一覧あり＝結果確認と誤認して旧一覧でも並べ替えた。",
    fixTarget:
      "afterSearchもscreenOk必須／未達はlegacy_blocked_no_screen／通りはscreen_ok_path／決まりlegacy_ad_requires_screen_ok",
    testPath: "tests/chrome-extension/foundation-legacy-subdivide-v28243.test.js",
    verifyAnyOf: [
      "legacy_blocked_no_screen",
      "dl:legacy_blocked_no_screen",
      "screen_ok_path",
      "dl:screen_ok_path",
      "search_results_ready",
      "page:search_results_ready",
    ],
    minVerifyExtVersion: "2.8.243",
  },
  {
    id: "armed_rows_bypass_screen_ok",
    symptom: "武装・行あり・list_visible・sync_pending で結果前にAD",
    dbEvidence: "search_grasp_gate=armed_rows|list_visible|sync_pending と screenOk無しの並び",
    rootKind: "stale_state",
    rootWhy:
      "finishGate(true)がscreenOkを見ずADへ直進。" +
      "_isSearchConfirmGraspがarmed_rows/sync_pendingのwhyを確認扱いにしていた。",
    fixTarget:
      "finishGate一本化でscreenOk必須／armed_*・list_visible・sync_pendingを確認拒否／legacy_blocked_no_screen",
    testPath: "tests/chrome-extension/legacy-collision-inventory-v28244.test.js",
    verifyAnyOf: [
      "legacy_blocked_no_screen",
      "dl:legacy_blocked_no_screen",
      "finishGate:",
      "dl:search_customer_screen_ok",
      "page:search_results_ready",
    ],
    minVerifyExtVersion: "2.8.244",
  },
  {
    id: "armed_grasp_overwrite",
    symptom: "武装・行あり経路が把握whyを汚しscreenOkを上書きし得る／一連で旧入口が残る",
    dbEvidence: "search_grasp_gate=armed_rows|list_visible|sync_pending（2.8.244関所後も呼び出し残）",
    rootKind: "stale_state",
    rootWhy:
      "244でfinishGateはscreenOk必須になったが、markGrasp(armed_rows)/finishGate(true,armed_*)呼び出しが残り、" +
      "良いscreenOk把握を薄いwhyで上書きし得る。統括Pro連携点検で一連の旧残りとして名指し。",
    fixTarget:
      "finishGate(true,armed_*)廃止／確認把握だけAD／無い時はarmed_wait_screen|list_wait_screen（2.8.249）",
    testPath: "tests/chrome-extension/flow-link-legacy-purge-v28249.test.js",
    verifyAnyOf: [
      "armed_wait_screen",
      "dl:armed_wait_screen",
      "list_wait_screen",
      "dl:list_wait_screen",
      "screen_ok_path",
      "dl:screen_ok_path",
      "legacy_blocked_no_screen",
      "dl:legacy_blocked_no_screen",
    ],
    minVerifyExtVersion: "2.8.249",
  },
  {
    id: "foundation_subdivide_auto_reflect",
    symptom: "改善したのに自動に乗らない／細分化が印だけで終わ／古い束・旧graspが残る",
    dbEvidence: "flow_subdivide_needのみ・foundation_gate無し・版ズレで改善未反映",
    rootKind: "gate_missing",
    rootWhy:
      "土台→細分化→自動反映の入口関所が弱く、弱い原子の列挙が次手に落ちない。" +
      "古いgrasp・古い手順書のまま自動が進む。",
    fixTarget:
      "_enforceAutoFoundation（版・invalidate・手順書再読・subdivide_drive・reflect）／沈黙中もdrive",
    testPath: "tests/chrome-extension/foundation-legacy-subdivide-v28243.test.js",
    verifyAnyOf: [
      "foundation_gate",
      "page:foundation_gate",
      "flow_subdivide_drive",
      "page:flow_subdivide_drive",
      "stale_grasp_drop",
      "page:stale_grasp_drop",
    ],
    minVerifyExtVersion: "2.8.243",
  },
  {
    id: "aim_warm_score_gate",
    symptom: "関所配線は通るのに再現55%のまま（cursor59・point47・aim無押し）",
    dbEvidence: "F58✓でも欄×観点55%・位置47%・新束後自動0・learn_warm無しの押し",
    rootKind: "gate_missing",
    rootWhy:
      "配線完了（F58）と人間らしさ再現%を混ぜていた。" +
      "fill入口でaim強制warmが無く、空aimのまま押すとpoint%が上がらない。",
    fixTarget:
      "_enforceAutoFoundationで_learnWarm(true)＋score_gate印（配線≠再現）／foundation_aim_warm",
    testPath: "tests/chrome-extension/foundation-aim-warm-score-gate-v28245.test.js",
    verifyAnyOf: [
      "score_gate",
      "page:score_gate",
      "foundation_aim_warm",
      "page:foundation_aim_warm",
      "learn_warm",
      "page:learn_warm",
    ],
    minVerifyExtVersion: "2.8.245",
  },
  {
    id: "keep_strengthen_stalls",
    symptom: "入口で1回warmして終わり／沈黙中に強化が止まる／次手が消える",
    dbEvidence: "strengthen_loop無し・silence中にaim薄いまま・再現%停滞",
    rootKind: "gate_missing",
    rootWhy:
      "強化がfill入口の一発で終わり、弱さが残っても回らない。" +
      "沈黙tickで細分化だけだとaim再warmが無い。",
    fixTarget:
      "_driveKeepStrengthen（沈黙＋foundation）／strengthen_loop印／F65 keep-strengthen.ts",
    testPath: "tests/chrome-extension/keep-strengthen-loop-v28246.test.js",
    verifyAnyOf: [
      "strengthen_loop",
      "page:strengthen_loop",
      "strengthen_aim_rewarm",
      "page:strengthen_aim_rewarm",
    ],
    minVerifyExtVersion: "2.8.246",
  },
  {
    id: "sort_click_loop_miss_ad",
    symptom: "並べ替えを押す／ホバーループ・ADまで届かず高→低を押せない",
    dbEvidence: "sort_no_ad連発・sort_head_hover反復・画面は下メニューADが見えている",
    rootKind: "phase_misread",
    rootWhy:
      "並べ替えはhoverで下展開・ADはhoverで右展開・高→低だけclickが正本なのに、" +
      "AD探索belowが220pxでメニュー下部のADに届かず失敗→見出しへ戻りループ。" +
      "飛行中の再kickもループに見えた。",
    fixTarget:
      "findAdInOpenMenu＋below560＋waitAdBelowHead／_adSortInFlight／sort_forbid_click／scene_flows把握",
    testPath: "tests/chrome-extension/sort-hover-ad-hilo-v28247.test.js",
    verifyAnyOf: [
      "sort_flow_grasp",
      "dl:sort_flow_grasp",
      "sort_ad_found",
      "dl:sort_ad_found",
      "sort_hilo",
      "dl:sort_hilo",
      "sort_menu_open",
      "dl:sort_menu_open",
    ],
    minVerifyExtVersion: "2.8.247",
  },
  {
    id: "all_sent_no_next_stuck",
    symptom: "送付済みのみ・次頁無しで止まる／外す・次客へ進まない",
    dbEvidence: "auto_pdf_start=no-rows のまま客完了無し・画面は送付済み表記・panel外している最中で停滞",
    rootKind: "premature_advance",
    rootWhy:
      "図面PDFが送付済み表記になると print URL が無く cand=0。" +
      "旧は no-rows で return し _autoFinish／_sendBatchDone に乗らなかった。" +
      "次無し時も客完了が二重経路で series印が薄かった。",
    fixTarget:
      "all_sent_no_press→_autoFinish→_sendBatchDone一本化／旧no-rows停止廃止",
    testPath: "tests/chrome-extension/all-sent-advance-v28248.test.js",
    verifyAnyOf: [
      "all_sent_no_press",
      "dl:all_sent_no_press",
      "all_sent_done",
      "dl:all_sent_done",
      "list_no_next_advance",
      "dl:list_no_next_advance",
      "loop_advance",
      "dl:loop_advance",
    ],
    minVerifyExtVersion: "2.8.248",
  },
];

export function evaluateRootCauseImproveLoop(input: RootCauseLoopInput): RootCauseLoopResult {
  const gaps: string[] = [];
  const caseResults: RootCauseLoopResult["cases"] = [];

  if (!input.extTestOk) gaps.push("F58拡張テスト未PASS（配線の抜けが残る）");

  const code = String(input.codeExtVersion || "");
  const latest = String(input.latestExtVersion || "");
  if (!latest) gaps.push("最新監査の ext_version が無い");
  else if (code && latest < code) {
    gaps.push(`拡張版が古い latest=${latest} < code=${code}（再読込→自動1回が必要）`);
  }

  const cases = input.cases.length ? input.cases : ROOT_CAUSE_CANON_CASES;
  let allCaseOk = true;
  for (const c of cases) {
    const r = caseVerified(c, input.latestAuditKeys || [], latest);
    caseResults.push({ id: c.id, ok: r.ok, gaps: r.gaps });
    if (!r.ok) {
      allCaseOk = false;
      gaps.push(`[${c.id}] ${r.gaps.join("／")}`);
    }
  }

  const ok = gaps.length === 0 && allCaseOk && !!input.extTestOk;
  const next = ok
    ? "維持（次の症状も同じ型でDB→根本→テスト→実証）"
    : gaps[0] || "根本原因ループ未完了";

  return {
    ok,
    gaps,
    next,
    line: ok
      ? `根本改善✓ 症例${caseResults.length}・F58✓・版=${latest}`
      : `根本改善✗ ${gaps.slice(0, 3).join("／")}`.slice(0, 220),
    cases: caseResults,
  };
}

export const ROOT_CAUSE_LOOP_STAMP_REL = "memory/root_cause_improve_last.json";
export const ROOT_CAUSE_LOOP_FRESH_MS = 48 * 60 * 60 * 1000;

export type RootCauseLoopStamp = {
  at: string;
  ok: boolean;
  line: string;
  next: string;
  gaps: string[];
  cases: RootCauseLoopResult["cases"];
  latest_ext_version: string;
  code_ext_version: string;
  ext_test_ok: boolean;
  audit_keys_n: number;
};

/** F64 用: スタンプ鮮度＋完了線 */
export function auditRootCauseImproveLoop(cwd = process.cwd()): {
  ok: boolean;
  line: string;
  next: string;
} {
  const p = join(cwd, ROOT_CAUSE_LOOP_STAMP_REL);
  if (!existsSync(p)) {
    return {
      ok: false,
      line: "F64 根本改善スタンプ無し（scripts/root-cause-improve-loop.ts）",
      next: "npx tsx --env-file=.env.local scripts/root-cause-improve-loop.ts",
    };
  }
  try {
    const stamp = JSON.parse(readFileSync(p, "utf8")) as RootCauseLoopStamp;
    const age = stamp.at ? Date.now() - new Date(stamp.at).getTime() : 999e12;
    if (age > ROOT_CAUSE_LOOP_FRESH_MS) {
      return {
        ok: false,
        line: `F64 スタンプ古い（${Math.round(age / 3600_000)}h） ${String(stamp.line || "").slice(0, 80)}`,
        next: "npx tsx --env-file=.env.local scripts/root-cause-improve-loop.ts（鮮度）",
      };
    }
    return {
      ok: !!stamp.ok,
      line: `F64 ${String(stamp.line || "").slice(0, 160)}`,
      next: stamp.ok
        ? "維持（次の症状も DB→根本→テスト→実証）"
        : String(stamp.next || "根本改善ループ未完了").slice(0, 120),
    };
  } catch {
    return {
      ok: false,
      line: "F64 スタンプが読めない",
      next: "npx tsx --env-file=.env.local scripts/root-cause-improve-loop.ts",
    };
  }
}
