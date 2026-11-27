/**
 * F58 拡張テスト→抜け発見→改善ループ（2026-11-22）
 *
 * 竹内さん「テストの部分も土台強化する／改善したらテストちゃんと行って／
 * 改善するところ見つかれば改善するようにする仕組み」
 *
 * 完了線:
 *   ①決め打ちスイートを実行した（鮮度あり）
 *   ②全部 PASS
 *   ③配線抜け（決まり版・RULE_STEP・RULES_DONE 食い違い）が 0
 * → 抜けがあれば次手を名指し。無料の配線抜けは scripts/ext-test-improve-loop.ts --fix で直す。
 *
 * ⚠ 本番監査印（F57）とは別。ここは「コード配線の抜けをテストで塞ぐ土台」。
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  AUTO_RULES,
  AUTO_RULES_REVIEWED_UP_TO,
  checkRulesInCode,
  compareExtVersion,
} from "./auto-procedure-rules";

export type ExtTestCase = {
  id: string;
  /** リポジトリ相対パス */
  path: string;
  /** 人が読む用途 */
  why: string;
};

/** 検索→把握→並べ替えまわりの必須スイート（改善後は必ずここを通す） */
export const EXT_TEST_IMPROVE_SUITE: ExtTestCase[] = [
  {
    id: "sort_head_buried",
    path: "tests/chrome-extension/sort-head-buried-v28197.test.js",
    why: "並べ替え見出し埋もれ（sort_no_head→PDF飛ばし）",
  },
  {
    id: "playbook_ad_sort_clear",
    path: "app/lib/__tests__/playbook-ad-sort-clear.test.ts",
    why: "手順書に①並べ替え→②AD→③高→低が載る",
  },
  {
    id: "playbook_search_extra_guides",
    path: "app/lib/__tests__/playbook-search-extra-guides.test.ts",
    why: "build_v9: 検索把握①②③・area確定・extra_guides(clear/switch/pet)",
  },
  {
    id: "playbook_build_v9_wiring",
    path: "tests/chrome-extension/playbook-build-v9-wiring.test.js",
    why: "build_v9 定数・F58組込の配線抜け防止",
  },
  {
    id: "action_playbook",
    path: "app/lib/__tests__/action-playbook.test.ts",
    why: "手順書の作り・検査・flow_series（デグレ防止）",
  },
  {
    id: "search_customer_grasp_gaps",
    path: "tests/chrome-extension/search-customer-grasp-gaps-v28196.test.js",
    why: "客検索把握の抜け10＋証拠表＋RULE_STEP",
  },
  {
    id: "search_customer_screen_grasp",
    path: "tests/chrome-extension/search-customer-screen-grasp-v28195.test.js",
    why: "画面把握の配線（≥2.8.195）",
  },
  {
    id: "sort_legacy_claude",
    path: "tests/chrome-extension/sort-legacy-claude-v28194.test.js",
    why: "Claude時代の並べ替え回帰防止",
  },
  {
    id: "sort_gate_insurance",
    path: "tests/chrome-extension/sort-gate-insurance-v28193.test.js",
    why: "強制は保険・本線は細分化",
  },
  {
    id: "sort_cursor_after_search",
    path: "tests/chrome-extension/sort-cursor-after-search-v28191.test.js",
    why: "検索後→並べ替えカーソル",
  },
  {
    id: "guide_screen_f57",
    path: "tests/chrome-extension/guide-screen-f57-v28187.test.js",
    why: "F57 段印の配線",
  },
  {
    id: "auto_procedure_rules",
    path: "app/lib/__tests__/auto-procedure-rules.test.ts",
    why: "決まり一覧×コード×RULE_STEP×版",
  },
  {
    id: "search_customer_grasp_f57",
    path: "app/lib/__tests__/search-customer-grasp-f57.test.ts",
    why: "F57 after_search が客検索印を数える",
  },
  {
    id: "human_like_audit",
    path: "app/lib/__tests__/human-like-audit.test.ts",
    why: "人間らしさ点検（直書き0・click→change・カーソル／位置・合格線）",
  },
  {
    id: "human_nearness",
    path: "app/lib/__tests__/human-nearness.test.ts",
    why: "人間との近さ（間隔・短間隔≤12%・human帯・機械連打は不合格）",
  },
  {
    id: "human_like_wiring",
    path: "tests/chrome-extension/human-like-wiring.test.js",
    why: "人間らしさ配線（logNormal・一息・カーソル・F58組込）",
  },
  {
    id: "human_like_improve_loop",
    path: "app/lib/__tests__/human-like-improve-loop.test.ts",
    why: "人間らしさ未達の改善周回計画（gaps書込→photo_learn→再測）",
  },
  {
    id: "human_like_gap_pace",
    path: "tests/chrome-extension/human-like-gap-pace-v28198.test.js",
    why: "束の人の間隔で区/selectレーン寄せ（≥2.8.198）",
  },
  {
    id: "weak_find_strengthen",
    path: "app/lib/__tests__/weak-find-strengthen.test.ts",
    why: "F60 弱所横断（見つけて強化ルートへ振り分ける土台）",
  },
  {
    id: "customer_search_think",
    path: "app/lib/__tests__/customer-search-think.test.ts",
    why: "客ごと思考（決定論）＋改善検証完了線（F55+手順書版）",
  },
  {
    id: "handoff_loop_ledger",
    path: "app/lib/__tests__/handoff-loop-ledger.test.ts",
    why: "連続客ループ台帳（外す→入れる→検索→送付→送付後外し→次客可）",
  },
  {
    id: "search_before_sort_next_guard",
    path: "tests/chrome-extension/search-before-sort-next-guard-v28233.test.js",
    why: "検索確認前の並べ替えnext拒否（根本関所・2.8.233）",
  },
  {
    id: "root_cause_improve_loop",
    path: "app/lib/__tests__/root-cause-improve-loop.test.ts",
    why: "F64 根本原因改善ループ（表面直し禁止・実証印まで）",
  },
  {
    id: "list_one_page_grasp",
    path: "tests/chrome-extension/list-one-page-grasp-v28234.test.js",
    why: "1ページのみ把握→次ページで止まらず外すへ（2.8.234）",
  },
  {
    id: "continuous_series_next_grasp",
    path: "tests/chrome-extension/continuous-series-next-grasp-v28235.test.js",
    why: "一連完了→次客で loop_advance／who／next_move 必須（2.8.235）",
  },
  {
    id: "screen_poll_instead_of_timeout",
    path: "tests/chrome-extension/screen-poll-instead-of-timeout-v28236.test.js",
    why: "タイムアウトの代わりに画面照会→API次手（2.8.236）",
  },
  {
    id: "screen_task_grasp_arch",
    path: "tests/chrome-extension/screen-task-grasp-arch-v28237.test.js",
    why: "画面照会3層＋タスク切替ごとにscreen_task_grasp（2.8.237）",
  },
  {
    id: "stuck_shot_best_act",
    path: "tests/chrome-extension/stuck-shot-best-act-v28238.test.js",
    why: "詰まり時スクショ→原因→拡張が最善次手（2.8.238）",
  },
  {
    id: "clear_stuck_watch",
    path: "tests/chrome-extension/clear-stuck-watch-v28239.test.js",
    why: "外し途中停止でも画面照会・スクショ・最善次手を活用（2.8.239）",
  },
  {
    id: "search_results_before_ad",
    path: "tests/chrome-extension/search-results-before-ad-v28240.test.js",
    why: "検索結果表示後だけAD／押下直後AD禁止／条件→検索ラグ削減（2.8.240）",
  },
  {
    id: "silence_stale_wiring",
    path: "tests/chrome-extension/silence-stale-wiring-v28241.test.js",
    why: "沈黙監視＋古いgrasp無効化の配線（2.8.241）",
  },
  {
    id: "silence_periodic_advance",
    path: "tests/chrome-extension/silence-periodic-advance-v28242.test.js",
    why: "沈黙定期照会→次タスク/次客／武装keep／強制flush（2.8.242）",
  },
  {
    id: "foundation_legacy_subdivide",
    path: "tests/chrome-extension/foundation-legacy-subdivide-v28243.test.js",
    why: "土台関所＋細分化駆動＋旧legacy衝突をscreenOkで止める（2.8.243）",
  },
  {
    id: "legacy_collision_inventory",
    path: "tests/chrome-extension/legacy-collision-inventory-v28244.test.js",
    why: "昔経路×新関所の衝突インベントリ（armed_rows等・2.8.244）",
  },
  {
    id: "foundation_aim_warm_score_gate",
    path: "tests/chrome-extension/foundation-aim-warm-score-gate-v28245.test.js",
    why: "再現55%対策: fill入口aim強制warm＋配線≠再現score_gate（2.8.245）",
  },
  {
    id: "keep_strengthen_loop",
    path: "tests/chrome-extension/keep-strengthen-loop-v28246.test.js",
    why: "強化継続: 沈黙中もaim再warm＋細分化・strengthen_loop（2.8.246／F65）",
  },
  {
    id: "sort_hover_ad_hilo",
    path: "tests/chrome-extension/sort-hover-ad-hilo-v28247.test.js",
    why: "並べ替えhover→AD→高→低（クリックループ止め・2.8.247）",
  },
  {
    id: "all_sent_advance",
    path: "tests/chrome-extension/all-sent-advance-v28248.test.js",
    why: "送付済み・次無しでも客完了へ進む／旧no-rows停止とsort_legacy廃止（2.8.248）",
  },
  {
    id: "flow_link_legacy_purge",
    path: "tests/chrome-extension/flow-link-legacy-purge-v28249.test.js",
    why: "一連・連携の旧武装入口パージ（armed_rows把握上書き廃止・2.8.249／統括Pro協力）",
  },
  {
    id: "pipeline_silence_screen_strengthen",
    path: "tests/chrome-extension/pipeline-silence-screen-strengthen-v28250.test.js",
    why: "一連停止→画面把握→強化（一覧・AD・送付のpipeline_silence・2.8.250）",
  },
];

export type ExtTestRunItem = {
  id: string;
  path: string;
  ok: boolean;
  ms: number;
  detail: string;
};

export type ExtTestFinding = {
  id: string;
  layer: "free" | "human" | "deploy";
  gap: string;
  next: string;
  /** --fix で直せるなら true */
  fixable: boolean;
};

export type ExtTestLoopStamp = {
  at: string;
  suite_n: number;
  pass_n: number;
  fail_n: number;
  ok: boolean;
  line: string;
  next: string;
  runs: ExtTestRunItem[];
  findings: ExtTestFinding[];
  fixed: string[];
  manifest_ver: string;
  rules_reviewed: string;
};

export const EXT_TEST_LOOP_STAMP_REL = "memory/ext_test_improve_loop_last.json";

/** スタンプの鮮度（この時間より古い＝未実行扱い） */
export const EXT_TEST_LOOP_FRESH_MS = 48 * 60 * 60 * 1000;

function cmpVerStr(a: string, b: string): number {
  // auto-procedure-rules の compareExtVersion は string 版
  return compareExtVersion(a, b);
}

/** 配線抜けを決定論で洗い出す（DB・LLM 無し） */
export function scanExtWiringFindings(root = process.cwd()): ExtTestFinding[] {
  const findings: ExtTestFinding[] = [];
  const ext = join(root, "chrome-extension");
  const read = (f: string) => readFileSync(join(ext, f), "utf8");
  let manifestVer = "";
  try {
    manifestVer = String(JSON.parse(read("manifest.json")).version || "");
  } catch {
    findings.push({
      id: "manifest_unreadable",
      layer: "human",
      gap: "manifest.json が読めない",
      next: "chrome-extension/manifest.json を確かめる",
      fixable: false,
    });
    return findings;
  }

  // ディスクから読む（--fix 直後もモジュール定数の古さを踏まない）
  let reviewedOnDisk = AUTO_RULES_REVIEWED_UP_TO;
  try {
    const rulesSrc = readFileSync(join(root, "app", "lib", "auto-procedure-rules.ts"), "utf8");
    const rm = rulesSrc.match(/export const AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/);
    if (rm) reviewedOnDisk = rm[1];
  } catch { /* keep import */ }
  if (cmpVerStr(reviewedOnDisk, manifestVer) !== 0) {
    findings.push({
      id: "rules_reviewed_stale",
      layer: "free",
      gap: `決まり見直し版 ${reviewedOnDisk} ≠ 拡張 ${manifestVer}`,
      next: `AUTO_RULES_REVIEWED_UP_TO を ${manifestVer} に上げる（決まりを見直してから）`,
      fixable: true,
    });
  }

  const page = read("page-script.js");
  // 人間らしさ配線（間隔・待ち・一息）が消えたらすぐ見つける
  let humanWait = "";
  try {
    humanWait = read("human-wait.js");
  } catch {
    findings.push({
      id: "human_wait_missing",
      layer: "deploy",
      gap: "chrome-extension/human-wait.js が無い",
      next: "human-wait.js を戻す（logNormalDelay の正本）",
      fixable: false,
    });
  }
  if (humanWait && !/logNormalDelay/.test(humanWait)) {
    findings.push({
      id: "human_wait_lognormal_gone",
      layer: "free",
      gap: "human-wait.js に logNormalDelay が無い",
      next: "対数正規の待ちを戻す（機械的な固定待ちにしない）",
      fixable: false,
    });
  }
  if (!/logNormalDelay/.test(page) || !/AxlxHumanWait/.test(page)) {
    findings.push({
      id: "human_like_page_wait_gone",
      layer: "free",
      gap: "page-script が AxlxHumanWait/logNormalDelay を使っていない",
      next: "人間らしい間隔の呼び出しを戻す",
      fixable: false,
    });
  }
  if (!/一息/.test(page) && !/createPacer/.test(page)) {
    findings.push({
      id: "human_like_breath_gone",
      layer: "free",
      gap: "page-script に一息／pacer が無い（ひたすら動き続ける形）",
      next: "検索決定後・区切りの一息を戻す",
      fixable: false,
    });
  }

  /** ★ F64/2.8.233: 検索前並べ替えの根本関所が消えたらすぐ見つける */
  if (!/function _guardNextMove\(/.test(page) || !/next_move_premature_block/.test(page)) {
    findings.push({
      id: "search_before_sort_guard_gone",
      layer: "free",
      gap: "_guardNextMove／next_move_premature_block が無い（検索前並べ替えが再発する）",
      next: "2.8.233 の検索確認関所を戻す（表面文言だけでは不可）",
      fixable: false,
    });
  }
  if (!/function _taskNextForPhase\(/.test(page) || !/conditions_done:\s*"検索を押す"/.test(page)) {
    findings.push({
      id: "task_next_phase_map_gone",
      layer: "free",
      gap: "段ごとの次（_taskNextForPhase）が無い／conditions_done→検索を押すが無い",
      next: "stale な並べ替え継承を止める段正本を戻す",
      fixable: false,
    });
  }
  /** ★ F64/2.8.234: 1ページのみ把握が消えたらすぐ見つける */
  let bulk = "";
  try {
    bulk = read("bulk-dl.js");
  } catch {
    findings.push({
      id: "bulk_dl_missing",
      layer: "deploy",
      gap: "bulk-dl.js が読めない",
      next: "chrome-extension/bulk-dl.js を確かめる",
      fixable: false,
    });
  }
  if (bulk && (!/function _readPagerState\(/.test(bulk) || !/list_page_one_only/.test(bulk))) {
    findings.push({
      id: "list_one_page_grasp_gone",
      layer: "free",
      gap: "_readPagerState／list_page_one_only が無い（1ページで次ページ止まりが再発）",
      next: "2.8.234 の1ページのみ把握を戻す",
      fixable: false,
    });
  }
  if (page && (!/function _screenPollThenApiNext\(/.test(page) || !/screen_poll_grasp/.test(page))) {
    findings.push({
      id: "screen_poll_timeout_gone",
      layer: "free",
      gap: "_screenPollThenApiNext／screen_poll_grasp が無い（盲目timeoutが再発）",
      next: "2.8.236 の画面照会付き待ちを戻す",
      fixable: false,
    });
  }
  if (bulk && !/function _stampSeriesToNextCustomer\(/.test(bulk)) {
    findings.push({
      id: "continuous_series_stamp_gone",
      layer: "free",
      gap: "_stampSeriesToNextCustomer が無い（一連→次客の loop_advance 欠が再発）",
      next: "2.8.235 の一連→次客把握を戻す",
      fixable: false,
    });
  }
  let bgSrc = "";
  try {
    bgSrc = read("background.js");
  } catch { /* */ }
  if (bgSrc && !/fill一連完了→次へ/.test(bgSrc)) {
    findings.push({
      id: "bg_series_loop_advance_gone",
      layer: "free",
      gap: "background の fill一連 series_done 経路に loop_advance が無い",
      next: "series_done とセットで loop_advance／who／next_move を戻す",
      fixable: false,
    });
  }

  const m = page.match(/var _AXLX_RULES_DONE = \[([\s\S]*?)\];/);
  const done = m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : [];
  const ids = AUTO_RULES.map((r) => r.id);
  const lack = ids.filter((id) => !done.includes(id));
  const extra = done.filter((id) => !ids.includes(id));
  if (lack.length || extra.length) {
    findings.push({
      id: "rules_done_mismatch",
      layer: "free",
      gap:
        (lack.length ? `一覧にあって拡張に無い: ${lack.join("・")}` : "") +
        (lack.length && extra.length ? " ／ " : "") +
        (extra.length ? `拡張にあって一覧に無い: ${extra.join("・")}` : ""),
      next: "AUTO_RULES と _AXLX_RULES_DONE を揃える（marker がある id は DONE に足す）",
      fixable: true,
    });
  }

  const files = {
    pageScript: page,
    bulkDl: read("bulk-dl.js"),
    searchAudit: read("search-audit.js"),
    manifestJson: read("manifest.json"),
    background: read("background.js"),
  };
  const issues = checkRulesInCode(files).filter((issue) => {
    // モジュール定数が古くてもディスク版が揃っていれば「見直し版」警告は捨てる
    if (/までしか見直していない/.test(issue) && cmpVerStr(reviewedOnDisk, manifestVer) === 0) {
      return false;
    }
    // RULES_DONE 食い違いは上で別 finding にしている
    if (/_AXLX_RULES_DONE/.test(issue) || /一覧にあって拡張|_AXLX_RULES_DONE と/.test(issue)) {
      return false;
    }
    return true;
  });
  for (const issue of issues.slice(0, 12)) {
    const isRuleStep = /RULE_STEP|KEEP_STEP/.test(issue);
    findings.push({
      id: "rules_in_code_" + String(findings.length),
      layer: isRuleStep ? "free" : "human",
      gap: issue.slice(0, 200),
      next: isRuleStep
        ? "search-audit.js の KEEP_STEP/RULE_STEP に足りない段を足す"
        : "決まりの marker / コードを揃える",
      fixable: isRuleStep,
    });
  }

  for (const t of EXT_TEST_IMPROVE_SUITE) {
    if (!existsSync(join(root, t.path))) {
      findings.push({
        id: "suite_missing_" + t.id,
        layer: "human",
        gap: `必須テストが無い: ${t.path}`,
        next: `${t.why} のテストを復元する`,
        fixable: false,
      });
    }
  }

  // ★ 2.8.202: 客ごと思考の配線
  try {
    const bg = read("background.js");
    const ct = read("content.js");
    const pageSrc = read("page-script.js");
    if (!/customer-search-think\.js|_refreshCustomerThink|customer_think/.test(bg)) {
      findings.push({
        id: "customer_think_bg",
        layer: "free",
        gap: "background に客ごと思考（_refreshCustomerThink）が無い",
        next: "background.js で fill 直前に _refreshCustomerThink を呼ぶ",
        fixable: false,
      });
    }
    if (!/axlx_customer_think/.test(ct)) {
      findings.push({
        id: "customer_think_push",
        layer: "free",
        gap: "content.js PUSH_KEYS に axlx_customer_think が無い",
        next: "PUSH_KEYS に axlx_customer_think を足す",
        fixable: false,
      });
    }
    if (!/__axlxCustomerThink|customer_think_apply/.test(pageSrc)) {
      findings.push({
        id: "customer_think_page",
        layer: "free",
        gap: "page-script が客ごと思考を適用していない",
        next: "__axlxCustomerThink を leftover に合流する",
        fixable: false,
      });
    }
    // ★ 2.8.203: 連続客・送付後外しの監査印（runId 明示・見送りでも stamp）
    // 2.8.328: 送付後の外し（_postSendClearRealpro）は消した。送付後はリセット（_postSendClearOrReset）の runId 明示を見る
    if (!/async function _postSendClearOrReset\(customerId, auditRunId\)/.test(bg)) {
      findings.push({
        id: "post_send_runid",
        layer: "free",
        gap: "_postSendClearOrReset が auditRunId を受け取っていない（印が消える穴）",
        next: "runId を明示渡しし、見送りでも post_send_clear を stamp（2.8.328）",
        fixable: false,
      });
    }
    if (!/handoff_loop/.test(bg) || !/series_done/.test(bg)) {
      findings.push({
        id: "handoff_loop_stamp",
        layer: "free",
        gap: "background に handoff_loop／series_done の監査印が無い",
        next: "送付後外しの後に handoff_loop と series_done を stamp",
        fixable: false,
      });
    }
    if (!/leftover_scan/.test(pageSrc) || /__axlxPostSendClearP/.test(pageSrc)) {
      findings.push({
        id: "handoff_loop_page",
        layer: "free",
        gap: "page に leftover_scan が無い、または消した送付後の外し（__axlxPostSendClearP）が戻っている",
        next: "leftover_scan を戻す（送付後の1つずつ外しは 2.8.328 で消した・戻さない）",
        fixable: false,
      });
    }
  } catch {
    /* ignore */
  }

  return findings;
}

export function evaluateExtTestLoop(input: {
  runs: ExtTestRunItem[];
  findings: ExtTestFinding[];
  fixed?: string[];
  manifest_ver: string;
  rules_reviewed: string;
  at?: string;
}): ExtTestLoopStamp {
  const pass_n = input.runs.filter((r) => r.ok).length;
  const fail_n = input.runs.length - pass_n;
  const open = input.findings.filter((f) => !(input.fixed || []).includes(f.id));
  const ok = fail_n === 0 && open.length === 0 && input.runs.length > 0;
  const failIds = input.runs.filter((r) => !r.ok).map((r) => r.id);
  const line = ok
    ? `拡張テスト改善ループ✓ suite=${pass_n}/${input.runs.length} 抜け0 版=${input.manifest_ver}`
    : `拡張テスト改善ループ未完 fail=${fail_n} 抜け=${open.length}` +
      (failIds.length ? ` 落ち=${failIds.slice(0, 4).join("・")}` : "") +
      (open.length ? ` 次=${open[0].id}` : "");
  const next = ok
    ? "拡張を直したら scripts/ext-test-improve-loop.ts を再実行（鮮度を保つ）"
    : fail_n > 0
      ? `落ちたテストを直す: ${failIds[0]} → 再実行`
      : open[0]
        ? `${open[0].next}${open[0].fixable ? "（--fix 可）" : ""}`
        : "スイートを実行する: npx tsx scripts/ext-test-improve-loop.ts";

  return {
    at: input.at || new Date().toISOString(),
    suite_n: input.runs.length,
    pass_n,
    fail_n,
    ok,
    line,
    next,
    runs: input.runs,
    findings: input.findings,
    fixed: input.fixed || [],
    manifest_ver: input.manifest_ver,
    rules_reviewed: input.rules_reviewed,
  };
}

export function readExtTestLoopStamp(root = process.cwd()): ExtTestLoopStamp | null {
  const p = join(root, EXT_TEST_LOOP_STAMP_REL);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ExtTestLoopStamp;
  } catch {
    return null;
  }
}

export function writeExtTestLoopStamp(stamp: ExtTestLoopStamp, root = process.cwd()): string {
  const p = join(root, EXT_TEST_LOOP_STAMP_REL);
  mkdirSync(join(root, "memory"), { recursive: true });
  writeFileSync(p, JSON.stringify(stamp, null, 2), "utf8");
  return p;
}

/** F58 用: スタンプ鮮度＋完了線 */
export function auditExtTestImproveLoop(root = process.cwd(), now = Date.now()): {
  ok: boolean;
  line: string;
  next: string;
  stamp: ExtTestLoopStamp | null;
} {
  const stamp = readExtTestLoopStamp(root);
  if (!stamp) {
    return {
      ok: false,
      line: "拡張テスト改善ループ: 未実行（スタンプ無し）",
      next: "npx tsx scripts/ext-test-improve-loop.ts （落ちたら直す・抜けは --fix）",
      stamp: null,
    };
  }
  const age = now - Date.parse(stamp.at);
  const fresh = Number.isFinite(age) && age >= 0 && age <= EXT_TEST_LOOP_FRESH_MS;
  if (!fresh) {
    return {
      ok: false,
      line: `拡張テスト改善ループ: スタンプ古い（${stamp.at}） fail=${stamp.fail_n} 抜け=${stamp.findings.length}`,
      next: "改善後は必ず npx tsx scripts/ext-test-improve-loop.ts を再実行",
      stamp,
    };
  }
  if (!stamp.ok) {
    return {
      ok: false,
      line: stamp.line,
      next: stamp.next,
      stamp,
    };
  }
  return {
    ok: true,
    line: stamp.line,
    next: stamp.next,
    stamp,
  };
}

/** 無料配線抜けの自動直し（決め打ち・安全なものだけ） */
export function applyFreeExtWiringFixes(root = process.cwd()): string[] {
  const fixed: string[] = [];
  const findings = scanExtWiringFindings(root);
  const byId = new Map(findings.map((f) => [f.id, f]));

  // 1) 決まり見直し版を manifest に合わせる
  if (byId.has("rules_reviewed_stale")) {
    const man = JSON.parse(
      readFileSync(join(root, "chrome-extension", "manifest.json"), "utf8"),
    ) as { version?: string };
    const ver = String(man.version || "");
    const rulesPath = join(root, "app", "lib", "auto-procedure-rules.ts");
    let src = readFileSync(rulesPath, "utf8");
    const next = src.replace(
      /export const AUTO_RULES_REVIEWED_UP_TO = "[^"]+";/,
      `export const AUTO_RULES_REVIEWED_UP_TO = "${ver}";`,
    );
    if (next !== src) {
      writeFileSync(rulesPath, next, "utf8");
      fixed.push("rules_reviewed_stale");
    }
  }

  // 2) RULES_DONE に足りない id を足す（marker がコードにあるものだけ）
  if (byId.has("rules_done_mismatch")) {
    const pagePath = join(root, "chrome-extension", "page-script.js");
    let page = readFileSync(pagePath, "utf8");
    const m = page.match(/var _AXLX_RULES_DONE = \[([\s\S]*?)\];/);
    if (m) {
      const done = [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
      const lack = AUTO_RULES.map((r) => r.id).filter((id) => !done.includes(id));
      const addable: string[] = [];
      for (const id of lack) {
        const rule = AUTO_RULES.find((r) => r.id === id);
        if (!rule) continue;
        const fileSrc = readFileSync(join(root, "chrome-extension", rule.file), "utf8");
        if (fileSrc.includes(rule.marker)) addable.push(id);
      }
      if (addable.length) {
        const insert = addable.map((id) => `    "${id}",`).join("\n");
        // 配列の閉じの前に足す
        page = page.replace(
          /var _AXLX_RULES_DONE = \[([\s\S]*?)\];/,
          (all, body: string) => {
            const trimmed = String(body).replace(/\s*$/, "");
            const needComma = /"[a-z_]+"\s*$/.test(trimmed) && !/,\s*$/.test(trimmed);
            return `var _AXLX_RULES_DONE = [${trimmed}${needComma ? "," : ""}\n${insert}\n  ];`;
          },
        );
        writeFileSync(pagePath, page, "utf8");
        fixed.push("rules_done_mismatch");
      }
    }
  }

  return fixed;
}
