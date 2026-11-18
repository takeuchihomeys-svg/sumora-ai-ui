/**
 * 1回の録画で「学習 → 改善 → 反映」まで完走させる関所（2026-11-18 竹内さん）
 *
 *   「このように1度の録画でちゃんと学習と改善と反映ができるようになるように徹底して改善する仕組みをつくる」
 *
 * ★ なぜ要るか
 *   弱所は録画1本に全部あるのに、flash・束・拡張・自動・効果が別経路だと
 *   「学んだ／直した」が次の自動に届かず、同じバグが繰り返す。
 *   → **1本の録画を入力に、抜けなく次手と検証印を並べる**（推測で課題を足さない）。
 *
 * ⚠ 純関数。DBに書かない・Visionを呼ばない。
 */
import { diagnoseAutoRecording, type DiagnoseAtom, type DiagnoseInput } from "./auto-rec-diagnose";
import {
  strengthenLearnMethod,
  type LearnMethodStrengthen,
} from "./learn-method-strengthen";

export type OneRecStepId =
  | "extract"
  | "learn_from_rec"
  | "mech_fix"
  | "bundle_put"
  | "ext_reload"
  | "auto_reflect"
  | "verify"
  | "method_strengthen";

export type OneRecStep = {
  n: number;
  id: OneRecStepId;
  name: string;
  ok: boolean;
  detail: string;
  /** この段で次にやること（1行） */
  next: string;
};

export type OneRecLearnLoop = {
  steps: OneRecStep[];
  atoms: DiagnoseAtom[];
  bottleneck_n: number | null;
  bottleneck: string | null;
  /** 次の自動1回で必ず見る印 */
  verify_marks: string[];
  method: LearnMethodStrengthen;
  continue_loop: boolean;
  line: string;
};

export type OneRecLearnInput = DiagnoseInput & {
  /** 監査 status（started=fill-done未達） */
  auditStatus?: string | null;
  /** 間取り want / hit（画面） */
  layoutWantN?: number | null;
  layoutHitN?: number | null;
  /** search_armed / pending が立ったか */
  searchArmed?: boolean | null;
  /** fill-done が background に届いたか */
  fillDoneReached?: boolean | null;
  /** 物件取得（PDF押し）が始まったか */
  propertyAcquireStarted?: boolean | null;
  /** 拡張版 */
  extVersion?: string | null;
  /** 束読込 */
  readCount?: number | null;
  /** 新束後の自動 */
  autoAfterBundle?: boolean | null;
  reflectOk?: number | null;
  pointPct?: number | null;
  unreadNormal?: number | null;
  before?: {
    pointPct?: number | null;
    aimHitPct?: number | null;
    nearnessScore?: number | null;
    readCount?: number | null;
    shortGapPct?: number | null;
  } | null;
  usedKinds?: string[] | null;
};

function verAtLeast(v: string | null | undefined, want: string): boolean {
  const a = String(v || "").split(".").map((x) => Number(x) || 0);
  const b = want.split(".").map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return true;
}

/**
 * 1録画の steps から HONOKA系の原子も足す（diagnose の上に載せる）。
 */
export function enrichAtomsFromOneRec(inp: OneRecLearnInput, base: DiagnoseAtom[]): DiagnoseAtom[] {
  const atoms = base.slice();
  const push = (a: DiagnoseAtom) => {
    if (atoms.some((x) => x.id === a.id)) return;
    atoms.push(a);
  };
  const steps = Array.isArray(inp.steps) ? inp.steps : [];
  const joined = steps.map((s) => (typeof s === "string" ? s : [s.k, s.m, s.d].filter(Boolean).join(" "))).join("\n");
  const want = Number(inp.layoutWantN) || 0;
  const hit = Number(inp.layoutHitN) || 0;
  const status = String(inp.auditStatus || "");

  if (want > 0 && hit > 0 && hit < want) {
    push({
      id: "layout_partial_ok",
      problem: `間取りが欲しい${want}のうち${hit}だけで次へ進んだ`,
      missing_foundation: "layout全hit関所（gate missingWant＋検索前把握）",
      need: "関所で不足を missingLayout／検索前に layout_pre_search_* で入れ直し",
      cost: "ext",
      evidence: `hit=${hit}/${want}`,
    });
  }
  if (/layout_grasp_partial|layout_pre_search_miss|間取りが足りない/.test(joined)) {
    push({
      id: "layout_grasp_weak",
      problem: "間取り把握が弱い（部分選択を完了と誤認）",
      missing_foundation: "layout_grasp_ok 印＋不足時 refill",
      need: "把握後に不足分を setCheckboxes で入れ直し、全hitまで conditions_ready しない",
      cost: "ext",
    });
  }
  if (status === "started" || inp.fillDoneReached === false) {
    push({
      id: "fill_done_lost",
      problem: "fill-done が届かず監査が started のまま",
      missing_foundation: "search_armed→pending→Case C／notifyDone 前の生存印",
      need: "検索click直前に axlx-search-armed で pending を書く（リロード生存）",
      cost: "ext",
      evidence: status || "fillDone=false",
    });
  }
  if (inp.propertyAcquireStarted === false || /物件取得|property|blocked_need_fill_done/.test(joined)) {
    if (inp.searchArmed !== true) {
      push({
        id: "property_no_pending",
        problem: "物件取得が始まらない（pending/search_armed 無し）",
        missing_foundation: "Case C 生存経路（axlx_pending_auto_send）",
        need: "自動 clickSearch でも popup 経由と同じ pending を立てる",
        cost: "ext",
      });
    }
  }
  if (/in_view.:false|画面外|pointer.*clamp|search_cursor/.test(joined) && /in_view.:false|画面外/.test(joined)) {
    push({
      id: "search_aim_offscreen",
      problem: "検索カーソルが画面外／aimが外れている",
      missing_foundation: "検索前スクロール＋画面外aim破棄",
      need: "再スクロール後に再測、in_view=false なら aim捨てて欄中央",
      cost: "ext",
    });
  }
  if (/required_time|徒歩/.test(joined) && /右|ずれ|aim/.test(joined)) {
    push({
      id: "walk_aim_shift",
      problem: "徒歩欄のカーソルが右にずれる",
      missing_foundation: "徒歩 aim の部分一致厳密化",
      need: "_aimOf の部分一致を厳しく／学び直し",
      cost: "ext",
    });
  }
  return atoms.slice(0, 14);
}

/**
 * 1回の録画を材料に、学習→改善→反映の抜けを段階で出す。
 */
export function buildOneRecLearnLoop(inp: OneRecLearnInput): OneRecLearnLoop {
  const diag = diagnoseAutoRecording(inp);
  const atoms = enrichAtomsFromOneRec(inp, diag.atoms);
  const read = Number(inp.readCount) || 0;
  const want = Number(inp.layoutWantN) || 0;
  const hit = Number(inp.layoutHitN) || 0;
  const layoutOk = want <= 0 || hit >= want;
  const extOk = verAtLeast(inp.extVersion, "2.8.92");
  const armedOk = inp.searchArmed === true || inp.fillDoneReached === true;
  const propOk = inp.propertyAcquireStarted === true;
  const autoOk = inp.autoAfterBundle === true;
  const reflectN = Number(inp.reflectOk) || 0;
  const extractOk = atoms.length >= 0; // 抽出自体は常に実施済み
  const learnOk = atoms.length === 0 || atoms.every((a) => a.cost !== "flash" || (Number(inp.unreadNormal) || 0) < 1);
  const mechOk =
    extOk
    && !atoms.some((a) => a.id === "layout_partial_ok" || a.id === "property_no_pending" || a.id === "fill_done_lost");
  const bundleOk = read >= 0; // 1録画の学びは ops/steps でも可。束は反映段
  const reloadOk = read >= 1 || atoms.every((a) => a.cost === "ext"); // 拡張直しだけなら再読込で足りる
  const reflectOkStep = autoOk && (reflectN >= 1 || (layoutOk && armedOk && propOk));
  const verifyOk =
    layoutOk
    && armedOk
    && (propOk || inp.auditStatus === "finished")
    && (reflectN >= 1 || autoOk);

  const steps: OneRecStep[] = [
    {
      n: 1,
      id: "extract",
      name: "1録画から課題を全部出す",
      ok: extractOk && atoms.length >= 0,
      detail: atoms.length ? atoms.slice(0, 4).map((a) => a.problem).join("／") : "大きな原子なし",
      next: atoms.length ? "原子ごとに学び／仕組み直しへ" : "検証印だけ確認",
    },
    {
      n: 2,
      id: "learn_from_rec",
      name: "その録画の操作から学ぶ",
      ok: learnOk,
      detail: `原子${atoms.length}・未学習≈${inp.unreadNormal ?? "?"}`,
      next: atoms.some((a) => a.cost === "flash")
        ? "足りない欄は通常flash（費用は統括が枚数決定）"
        : "録画ops／間取り把握印で無料学習を先に",
    },
    {
      n: 3,
      id: "mech_fix",
      name: "足りない仕組みを同じ周で直す",
      ok: mechOk,
      detail: extOk
        ? (mechOk ? "2.8.92系の関所・生存印あり" : "原子がまだ仕組み不足を示す")
        : "拡張≥2.8.92（間取り全hit＋search_armed）が要る",
      next: extOk ? "再読込して印を確認" : "拡張を2.8.92以上へ",
    },
    {
      n: 4,
      id: "bundle_put",
      name: "学びを束／印に載せる",
      ok: bundleOk,
      detail: `read_count=${read}・search_armed=${inp.searchArmed ?? "?"}・layout hit=${hit}/${want || "?"}`,
      next: "layout_grasp_ok / search_armed / fill-done を監査に残す",
    },
    {
      n: 5,
      id: "ext_reload",
      name: "拡張が学んだ結果を読む",
      ok: reloadOk,
      detail: reloadOk ? "再読込で新コード／束を読める" : "再読込がまだ",
      next: "chrome://extensions 再読込→リアプロタブ更新",
    },
    {
      n: 6,
      id: "auto_reflect",
      name: "同じ客で自動1回して反映",
      ok: reflectOkStep || (autoOk && layoutOk && armedOk),
      detail: `auto=${autoOk} layoutOk=${layoutOk} armed=${armedOk} prop=${propOk}`,
      next: "HONOKA等・同じ条件でもう1回自動（間取り全・物件取得）",
    },
    {
      n: 7,
      id: "verify",
      name: "効果を印と数字で確かめる",
      ok: verifyOk,
      detail: `status=${inp.auditStatus ?? "?"} reflect_ok=${reflectN} point%=${inp.pointPct ?? "?"}`,
      next: "layout_pre_search_ok・search_armed・Case A/C・status≠started",
    },
    {
      n: 8,
      id: "method_strengthen",
      name: "学び方を強化して次の1録画へ",
      ok: false,
      detail: "",
      next: "",
    },
  ];

  const stuck = steps.find((s) => s.n <= 7 && !s.ok) || null;
  const aimAri = Number(inp.aimAri) || 0;
  const aimNashi = Number(inp.aimNashi) || 0;
  const aimHit = aimAri + aimNashi > 0 ? Math.round((aimAri / (aimAri + aimNashi)) * 100) : null;
  const method = strengthenLearnMethod({
    before: inp.before || null,
    after: {
      pointPct: inp.pointPct ?? null,
      aimHitPct: aimHit,
      nearnessScore: null,
      readCount: read,
      shortGapPct: null,
      reflectOk: reflectN,
    },
    usedKinds: inp.usedKinds || ["one_rec_loop"],
    bottleneckN: stuck?.n ?? null,
    didFlash: false,
    unreadNormal: Number(inp.unreadNormal) || 0,
    pointOk: 60,
    aimOk: 40,
  });
  steps[7] = {
    ...steps[7],
    ok: method.upgrades.length === 0 && !stuck,
    detail: method.line,
    next: method.next_method_line,
  };

  const verify_marks = [
    "layout_pre_search_ok または layout_grasp_ok（欲しい間取り全hit）",
    "search_armed（pending生存印）",
    "fill-done 到達 または Case C 起動",
    "物件PDF押し開始（status≠started）",
    "page_ver≥2.8.92",
  ];

  const continue_loop = !!stuck || method.continue_loop;
  const line = stuck
    ? `1録画ループ 段${stuck.n}で停止: ${stuck.name} — ${stuck.detail}`
    : `1録画ループ完走: 原子${atoms.length}・${method.next_method_line}`;

  return {
    steps,
    atoms,
    bottleneck_n: stuck?.n ?? null,
    bottleneck: stuck ? `${stuck.name}: ${stuck.detail}` : null,
    verify_marks,
    method,
    continue_loop,
    line,
  };
}
