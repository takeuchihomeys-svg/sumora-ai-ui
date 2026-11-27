// app/lib/auto-itandi-rules.ts — ITANDI の自動の決まり（リアプロの決まりとは別の正本・2026-11-27）
//
// 竹内さん「itandi はちゃんとリアプロとわけてつくる」「リアプロと混ざらないようにちゃんと整理して仕組みつくっておく」。
//   リアプロの決まり（auto-procedure-rules.ts の AUTO_RULES）は page-script.js 用。ITANDI は itandi-page-script.js /
//   itandi-bulk-dl.js 用で、段の名前も点検の仕方も違う。だから、ここで ITANDI だけの一覧を持つ。
//
//   ① 決まりは ITANDI のコードの目印（marker）に結ぶ。目印が消えたら checkItandiRulesInCode が止める。
//   ② 確かめる段（verify）は、ITANDI の点検記録に段が保存されるようになってから付ける。今は保存されていない
//      （直近の ITANDI の点検は古い版の要約だけ・段が無い）→ 各決まりに verify_reason で理由を残す。
//   ③ 手順書の版（rules_v）は、ITANDI の決まりだけで作る版（itandiRulesVersion）。リアプロの版とは別に比べる（rulesVersionFor）。
//
// ⚠ ここにリアプロの決まり（page-script.js・realpro の段名）を入れない（混ざり防止・テストで止める）。

import { AUTO_RULES, AUTO_RULES_REVIEWED_UP_TO, autoRulesVersion, fnv, type RuleScene } from "./auto-procedure-rules";

/**
 * ITANDI の決まりの一覧を見直した拡張の版（リアプロの AUTO_RULES_REVIEWED_UP_TO とは別に管理する・2026-11-27）。
 */
export const ITANDI_RULES_REVIEWED_UP_TO = "2.8.326";

export type ItandiRuleFile = "itandi-page-script.js" | "itandi-bulk-dl.js";

export type ItandiRule = {
  /** 変えない（テストと手順書の印に使う） */
  id: string;
  scene: RuleScene;
  /** 人が読む決まり（手順書に載る文） */
  text: string;
  /** 入った拡張の版（分からなければ null） */
  since: string | null;
  /** ITANDI のコードに必ずある文字（反映の確かめ） */
  marker: string;
  /** marker があるファイル（chrome-extension/ の下） */
  file: ItandiRuleFile;
  /** 確かめる段が無い理由（verify を付けたら空にする） */
  verify_reason: string;
};

const NO_SEGMENT_YET = "ITANDI の点検記録に場面の段（reset_start・location・search_press など）が保存されていない（直近の ITANDI の点検は古い版の要約だけ）。保存の直しと ITANDI の実走の後に、確かめる段を付ける";

export const ITANDI_AUTO_RULES: ReadonlyArray<ItandiRule> = [
  {
    id: "it_reset_before_fill",
    scene: "clear",
    text: "ITANDI は前のお客さんの条件を入れる前に、1つずつ外して空になったのを読み戻す（ITANDI に消すボタンは無い）。空にならない欄が残ったら、そのお客さんの ITANDI は検索しない（前の条件を混ぜない）",
    since: "2.5.46",
    marker: "AXLX_RESET_FAILED",
    file: "itandi-page-script.js",
    verify_reason: NO_SEGMENT_YET,
  },
  {
    id: "it_reset_mixed_note",
    scene: "clear",
    text: "入れた後のチップに前のお客さんの区・駅が混ざっていたら札（reset_fail）を出す。検索は止めず、札で知らせる",
    since: "2.5.46",
    marker: `_itStep("reset_mixed"`,
    file: "itandi-page-script.js",
    verify_reason: NO_SEGMENT_YET,
  },
  {
    id: "it_area_before_cond",
    scene: "area",
    text: "場所（所在地・路線と駅）を先に入れてから、更新日・残りの条件を入れる（条件を並行しない）",
    since: null,
    marker: `_itStep("location"`,
    file: "itandi-page-script.js",
    verify_reason: NO_SEGMENT_YET,
  },
  {
    id: "it_station_miss_recorded",
    scene: "area",
    text: "見つからない路線・駅は黙って飛ばさず、点検に残す（line_miss・stations_missing）",
    since: null,
    marker: `_itStep("line_miss"`,
    file: "itandi-page-script.js",
    verify_reason: NO_SEGMENT_YET,
  },
  {
    id: "it_update_days_first",
    scene: "cond",
    text: "更新日（募集条件の更新 N日以内）を、残りの条件より先に入れる（後で開く欄が、打っている欄から focus を奪わないため）",
    since: null,
    marker: `_itFillUpdateDays(cond, function`,
    file: "itandi-page-script.js",
    verify_reason: NO_SEGMENT_YET,
  },
  {
    id: "it_one_tick_then_wait",
    scene: "cond",
    text: "チェックの条件は1件ずつ人の間を入れて入れ、押し終わるのを待ってから検索を押す",
    since: null,
    marker: `_whenTickIdle(function`,
    file: "itandi-page-script.js",
    verify_reason: NO_SEGMENT_YET,
  },
  {
    id: "it_search_ready_check",
    scene: "search",
    text: "検索は押せる状態（押せないボタン・赤い文が無い）を確かめてから押す",
    since: "2.5.45",
    marker: `_itWaitSearchReady(function`,
    file: "itandi-page-script.js",
    verify_reason: NO_SEGMENT_YET,
  },
  {
    id: "it_search_blocked_no_press",
    scene: "search",
    text: "止める理由（search_blocked）があれば検索は押さず、このお客さんの回を完了として返す",
    since: null,
    marker: `_itStep("search_blocked"`,
    file: "itandi-page-script.js",
    verify_reason: NO_SEGMENT_YET,
  },
  {
    id: "it_guide_no_search",
    scene: "search",
    text: "案内モード（検索はスタッフが押す）の時は、自動で検索を押さない。入力の途中で案内に切り替わった時も押さない",
    since: null,
    marker: `_itStep("guide_mode"`,
    file: "itandi-page-script.js",
    verify_reason: NO_SEGMENT_YET,
  },
  {
    id: "it_breath_before_search",
    scene: "search",
    text: "検索を押す前に、人が条件を見直す間を時々入れる（10%で0.9〜2.6秒・3%で2.6〜5.5秒）。押すのは今までどおり",
    since: null,
    marker: "検索の前に一息",
    file: "itandi-page-script.js",
    verify_reason: NO_SEGMENT_YET,
  },
  {
    id: "it_watchdog_stop",
    scene: "switch",
    text: "1800秒で動かなくなったら完了を返す。遅れて動く続きが、次のお客さんの入力と重ならないようにする",
    since: null,
    marker: `_itStep("watchdog"`,
    file: "itandi-page-script.js",
    verify_reason: NO_SEGMENT_YET,
  },
  {
    id: "it_dup_fill_ignored",
    scene: "switch",
    text: "同じ入力の依頼が重なったら、2回目は入れ直さず点検に残す（dup_fill）",
    since: null,
    marker: `_itStep("dup_fill"`,
    file: "itandi-page-script.js",
    verify_reason: NO_SEGMENT_YET,
  },
  {
    id: "it_list_next_handoff",
    scene: "list",
    text: "一覧（dl:it_list）を見てから、次のページ（dl:it_next）へ送り、送り終わりを dl:it_handoff で残す",
    since: null,
    marker: `"dl:it_next"`,
    file: "itandi-bulk-dl.js",
    verify_reason: NO_SEGMENT_YET,
  },
  {
    id: "it_list_no_rows_stop",
    scene: "list",
    text: "15秒たっても一覧の行が出なければ、このお客さんは止めて送り終わりに残す（no_rows_15s）",
    since: null,
    marker: `"no_rows_15s"`,
    file: "itandi-bulk-dl.js",
    verify_reason: NO_SEGMENT_YET,
  },
  {
    id: "it_learn_reflect_gate",
    scene: "switch",
    text: "ITANDI でも入力・案内開始の前に ITANDI 専用の手順書・学習位置（site=itandi）を取得・反映し終えてから前客クリアへ進む",
    since: "2.8.312",
    marker: "_itEnsureLearnReflectedForFill",
    file: "itandi-page-script.js",
    verify_reason: NO_SEGMENT_YET,
  },
  {
    id: "it_learn_aim_pointer",
    scene: "press",
    text: "ITANDI のボタン・検索押下は _itLearnPosOf で学習済みの画面位置を引き、AxlxPointerUi.moveToEl({ aim }) に渡して実際のカーソル位置へ反映する",
    since: "2.8.312",
    marker: "_itLearnPosOf(names)",
    file: "itandi-page-script.js",
    verify_reason: NO_SEGMENT_YET,
  },
  {
    id: "it_serial_numeric_input",
    scene: "cond",
    text: "ITANDI の賃料・面積・徒歩・築年数などの数値欄は _itSerialType で1欄ずつ直列に入力し、全数値欄＋チェック完了を待ってから検索可否を判定する",
    since: "2.8.312",
    marker: "_itSerialType",
    file: "itandi-page-script.js",
    verify_reason: NO_SEGMENT_YET,
  },
];

/** ITANDI の決まりの版（id と文が変われば変わる）。ITANDI の手順書だけの版 */
export function itandiRulesVersion(rules: ReadonlyArray<ItandiRule> = ITANDI_AUTO_RULES): string {
  return fnv(JSON.stringify([rules.map((r) => [r.id, r.scene, r.text, r.since]), ITANDI_RULES_REVIEWED_UP_TO, "itandi"]));
}

/** サイトごとの決まりの版（手順書の rules_v を比べる時に使う）。realpro と all はリアプロの版 */
export function rulesVersionFor(site: string | null | undefined): string {
  return String(site ?? "") === "itandi" ? itandiRulesVersion() : autoRulesVersion();
}

/** サイトごとの見直し上限版（rules_up_to）。ITANDI は独立の ITANDI_RULES_REVIEWED_UP_TO を返す */
export function rulesReviewedUpToFor(site: string | null | undefined): string {
  return String(site ?? "") === "itandi" ? ITANDI_RULES_REVIEWED_UP_TO : AUTO_RULES_REVIEWED_UP_TO;
}

/**
 * ITANDI の決まりと ITANDI のコードの食い違いを数える（純関数）。
 *   目印が無い・id が重なる・リアプロの決まりと id が重なる（混ざり）・verify_reason が空、を止める。
 *   manifest / searchAudit が渡された時は、_AXLX_ITANDI_PAGE_VER・_AXLX_ITANDI_RULES_DONE・点検段の保存も検査する。
 */
export function checkItandiRulesInCode(
  files: { itandiPage: string; itandiBulk: string; manifestVersion?: string; searchAudit?: string },
  rules: ReadonlyArray<ItandiRule> = ITANDI_AUTO_RULES,
): string[] {
  const issues: string[] = [];
  const realproIds = new Set(AUTO_RULES.map((r) => r.id));
  const seen = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.id)) issues.push(`ITANDI の決まり id が重なっている: ${r.id}`);
    seen.add(r.id);
    if (realproIds.has(r.id)) issues.push(`ITANDI の決まり ${r.id} がリアプロの決まりと同じ id（混ざり）`);
    if (!String(r.verify_reason ?? "").trim() && !(r as { verify?: unknown }).verify) {
      issues.push(`ITANDI の決まり ${r.id} に確かめる段が無い理由が無い`);
    }
    const src = r.file === "itandi-page-script.js" ? files.itandiPage : files.itandiBulk;
    if (!src.includes(r.marker)) issues.push(`ITANDI の決まり ${r.id} の目印が ${r.file} に無い（直しが消えた／一覧が古い）`);
  }
  const doneMatch = files.itandiPage.match(/_AXLX_ITANDI_RULES_DONE\s*=\s*\[([\s\S]*?)\]/);
  if (!doneMatch) {
    issues.push("itandi-page-script.js に _AXLX_ITANDI_RULES_DONE が無い（手順書との突き合わせが書かれていない）");
  } else {
    const doneIds = Array.from(doneMatch[1].matchAll(/"([^"]+)"/g)).map((m) => m[1]);
    const doneSet = new Set(doneIds);
    for (const id of seen) {
      if (!doneSet.has(id)) issues.push(`ITANDI の決まり ${id} が itandi-page-script.js の _AXLX_ITANDI_RULES_DONE に無い`);
    }
    for (const id of doneIds) {
      if (!seen.has(id)) issues.push(`itandi-page-script.js の _AXLX_ITANDI_RULES_DONE に未知の id: ${id}`);
    }
  }
  const pvMatch = files.itandiPage.match(/_AXLX_ITANDI_PAGE_VER\s*=\s*"([^"]+)"/);
  if (!pvMatch) {
    issues.push("itandi-page-script.js に _AXLX_ITANDI_PAGE_VER が無い");
  } else if (files.manifestVersion && pvMatch[1] !== files.manifestVersion) {
    issues.push(`itandi-page-script.js の _AXLX_ITANDI_PAGE_VER (${pvMatch[1]}) が manifest (${files.manifestVersion}) と食い違い`);
  }
  if (files.manifestVersion && ITANDI_RULES_REVIEWED_UP_TO !== files.manifestVersion) {
    issues.push(`ITANDI_RULES_REVIEWED_UP_TO (${ITANDI_RULES_REVIEWED_UP_TO}) が manifest (${files.manifestVersion}) と食い違い`);
  }
  if (!files.itandiPage.includes("axlx-guide-live-flush")) {
    issues.push("itandi-page-script.js にリアルタイム段保存（axlx-guide-live-flush）が無い");
  }
  if (!files.itandiPage.includes("playbook_seen")) {
    issues.push("itandi-page-script.js に手順書読込確認（playbook_seen）が無い");
  }
  if (files.searchAudit) {
    for (const stepName of ["page:playbook_seen", "page:playbook_behind", "page:playbook_none", "page:page_ver"]) {
      if (!files.searchAudit.includes(stepName.replace(/^page:/, "")) && !files.searchAudit.includes("playbook_")) {
        issues.push(`search-audit.js に ${stepName} の保存設定が無い`);
      }
    }
  }
  return issues;
}
