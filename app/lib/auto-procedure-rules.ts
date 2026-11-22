// app/lib/auto-procedure-rules.ts — 自動（リアプロ）の動き方の決まり（手順書に載せる正本・2026-11-20）
//
// 竹内さん「改善したのは手順書にちゃんと反映されるようになっているのか」「手順書がちゃんと細かくできるように」
// 「その仕組みもちゃんと作って反映できるように」「ちゃんとテストもして」（2026-11-20 13:40）。
//
//   実測（DB の最新のリアプロの束 id 2532）: 手順書は人の録画の順番と押す位置だけで、
//   拡張で直した自動の決まり（外す順番・確定と検索を決定扱い 等）は1つも載っていなかった。
//   拡張も手順書をページへ渡していなかった（content.js の PUSH_KEYS に無い＝自動は読んでいない）。
//
//   → 決まりはここに1件ずつ置く（正本）。手順書（action-playbook.ts）はここから載せる。
//     ① marker: 拡張のコードに必ずある文字（テストで「コードに入っているか」を確かめる）
//     ② verify: 自動の点検記録（search_audits.steps）で「守れたか」を確かめる形（決定論）
//     ③ 拡張の page-script.js の `_AXLX_RULES_DONE` と id を揃える（テストで食い違いを止める）
//   ⚠ 決まりを足す・変える時: ここ → page-script.js の `_AXLX_RULES_DONE` → テストの順に直す。
//   ⚠ 統括（Pro）の判断は入れない。ここは決まりの一覧と、数えて確かめるだけ。

/**
 * 決まりの一覧を見直した拡張の版（2026-11-20 竹内さん「手順書の重要度と優先度あげる」「改善したら手順書が改善されるように仕組みをちゃんと」）。
 *   拡張（manifest.json）の版を上げたら、この一覧を見直してからここも同じ版にする。
 *   上げ忘れはテスト（auto-procedure-rules.test.ts）が止める＝直したのに手順書が古いまま、を出さない。
 */
export const AUTO_RULES_REVIEWED_UP_TO = "2.8.153";

/** 決まりが効く場面（手順書の場面＋自動だけの場面） */
export type RuleScene = "switch" | "clear" | "area" | "cond" | "pet" | "search" | "press";

export const RULE_SCENE_JA: Record<RuleScene, string> = {
  switch: "お客さんの切り替え",
  clear: "前のお客さんの条件を外す",
  area: "所在地絞り込み",
  cond: "条件（賃料・間取り・徒歩など）",
  pet: "絞り込み条件（ペット）",
  search: "検索を押す",
  press: "押し方（全部の場面）",
};

/** 点検記録の1段（search_audits.steps の形。ページの段は k が "page:" で始まる） */
export type AuditStep = { k?: string | null; d?: string | null; at?: number | null };

export type RuleVerify = {
  /** この段が1つも無ければ「守れていない」（mustNot と一緒なら両方見る） */
  mustHave?: string;
  /** この段が1つでもあれば「守れていない」 */
  mustNot?: string[];
  /** from の段から次の to の段までの時間が ms 以下（全部の組で） */
  maxGap?: { from: string; to: string; ms: number };
  /** この段の d が、この順に出る（含む文字で判定・出ない物は飛ばす） */
  order?: { key: string; seq: string[] };
  /** この段のどれも無い回は no_data（その場面が無かった回を数えない） */
  onlyIf?: string[];
  /** 段がこれより少ない回は no_data（長い回だけで確かめる決まり） */
  minSteps?: number;
  /** どれか1つあれば守れた（無ければ守れていない） */
  mustHaveAny?: string[];
  /** この段が n 回より多ければ守れていない */
  maxCount?: { key: string; n: number };
  /** 段の初めて出た時刻がこの順（出ない物は飛ばす・2つ以上出た回だけ確かめる） */
  seq?: string[];
};

/** 点検記録の段の上限（chrome-extension/search-audit.js の MAX_STEPS と同じ） */
export const AUDIT_MAX_STEPS = 120;

/** verify が見る段の名前（search-audit.js の RULE_STEP／KEEP_STEP に入っていないと上限で落ちる） */
export function verifyKeysOf(v: RuleVerify | undefined): string[] {
  if (!v) return [];
  const keys = [
    v.mustHave, ...(v.mustNot ?? []), v.maxGap?.from, v.maxGap?.to, v.order?.key,
    ...(v.onlyIf ?? []), ...(v.mustHaveAny ?? []), v.maxCount?.key, ...(v.seq ?? []),
  ];
  return [...new Set(keys.filter((k): k is string => typeof k === "string" && k.length > 0))];
}

export type AutoRule = {
  /** 変えない（拡張の _AXLX_RULES_DONE と揃える） */
  id: string;
  scene: RuleScene;
  /** 人が読む決まり（手順書に載る文） */
  text: string;
  /** 入った拡張の版（前からある決まりは null） */
  since: string | null;
  /** 元の設計知見（id8）。無ければ null */
  kb: string | null;
  /** 拡張のコードに必ずある文字（反映の確かめ） */
  marker: string;
  /** marker があるファイル（chrome-extension/ の下） */
  file: "page-script.js" | "search-audit.js";
  /** 点検記録で確かめる形（無ければ「コードにあるか」だけ） */
  verify?: RuleVerify;
};

export const AUTO_RULES: AutoRule[] = [
  {
    id: "order_human",
    scene: "search",
    text: "人の手順どおり 所在地 → 確定してリストへ → 条件 → 検索 の順に押す。途中で止まっても検索まで進める",
    since: null,
    kb: "bbfcae84",
    marker: "stall_complete_search",
    file: "page-script.js",
    verify: { seq: ["page:flow_done_place", "page:flow_done_conditions", "page:flow_done_search"] },
  },
  {
    id: "area_before_cond",
    scene: "area",
    text: "所在地を全部そろえて確定してから条件へ進む（所在地と条件を並行しない）",
    since: null,
    kb: "71eba123",
    marker: "場所のあとで条件を1つずつ入れる（並行しない）",
    file: "page-script.js",
    verify: { seq: ["page:area_all_done", "page:conditions_ready"] },
  },
  {
    id: "no_reset_button",
    scene: "clear",
    text: "リセットボタンは押さない。前のお客さんの条件はカーソルで1つずつ外す",
    since: "2.8.107",
    kb: null,
    marker: "自動は「リセット」ボタンを押さない",
    file: "page-script.js",
  },
  {
    id: "clear_per_panel",
    scene: "clear",
    text: "外す時は箱ごと（間取り → 絞り込み条件（ペット）→ 所在地 → 残り）。箱を開ける → 1つずつカーソルで外す → 確定 → 次の箱。全部の箱を先に開けない",
    since: "2.8.135",
    kb: null,
    marker: "_stage('input[name=\"eq_rm[]\"]:checked'",
    file: "page-script.js",
    verify: { order: { key: "page:clear_stage", seq: ["room_layout_id", "eq_rm", "city_code"] } },
  },
  {
    id: "no_hidden_press",
    scene: "press",
    text: "押す物は全部カーソルを動かしてから押す（見えない欄をカーソル無しで押さない）",
    since: "2.8.135",
    kb: null,
    marker: "見える欄が無くカーソル無しで押した",
    file: "page-script.js",
    verify: { mustNot: ["page:hidden_press"] },
  },
  {
    id: "pet_confirm",
    scene: "pet",
    text: "ペットを選んだ・外した後は 確定してリストへ を押す",
    since: null,
    kb: "1de1e224",
    marker: "pet_panel_confirm",
    file: "page-script.js",
    verify: { onlyIf: ["page:pet_panel_confirm", "page:pet_panel_confirm_miss"], mustNot: ["page:pet_panel_confirm_miss"] },
  },
  {
    id: "confirm_decide",
    scene: "press",
    text: "確定してリストへ は決定の押下（長い迷い・手を止めるを入れない）",
    since: "2.8.136",
    kb: null,
    marker: "選び終えて確定するのは決定の押下",
    file: "page-script.js",
    verify: { maxGap: { from: "page:modal_confirm", to: "page:confirm_press_ok", ms: 6000 } },
  },
  {
    id: "search_decide",
    scene: "search",
    text: "検索は条件を見直した後（1〜2秒）、迷い・手を止めるを入れずに押す",
    since: "2.8.135",
    kb: null,
    marker: "label: \"click:検索\", strictLo: true, sigma: 0.55, decide: true",
    file: "page-script.js",
    verify: { maxGap: { from: "page:search_cursor", to: "page:search_armed", ms: 4500 } },
  },
  {
    id: "walk_presearch",
    scene: "search",
    text: "検索の前に徒歩と分数を確かめ、合っていれば待たずに押す（ずれていれば直してから）",
    since: "2.8.135",
    kb: "71eba123",
    marker: "検索前 徒歩+分数 OK（待たずに押す）",
    file: "page-script.js",
    verify: { maxGap: { from: "page:walk_seal_ok", to: "page:search_armed", ms: 3000 } },
  },
  {
    id: "hidden_work_no_pause",
    scene: "switch",
    text: "画面に見えない作業（学習の取り込み・確かめ）には迷い・手を止めるを入れない",
    since: "2.8.135",
    kb: null,
    marker: "if (item && (!item.el || item.decide)) return 0;",
    file: "page-script.js",
  },
  {
    id: "select_one_press",
    scene: "cond",
    text: "プルダウンの欄は1回押して開く（カーソルが欄の上にあれば押し直さない）",
    since: "2.8.136",
    kb: null,
    marker: "sel_one_press",
    file: "page-script.js",
  },
  {
    id: "checkbox_settle",
    scene: "press",
    text: "チェックは押した後 0.6秒まで反映を待つ。押し直す時はカーソルの押す動き付きで1回だけ",
    since: "2.8.136",
    kb: null,
    marker: "return _settleChk(600)",
    file: "page-script.js",
  },
  {
    id: "ward_pace",
    scene: "area",
    text: "区は人の速さで1つずつ（速い50%・迷い44%・停止6%）",
    since: "2.8.109",
    kb: "5022ab57",
    marker: "function _wardGapPlan",
    file: "page-script.js",
  },
  {
    id: "pick_pace",
    scene: "cond",
    text: "駅・沿線・町字・間取りの2つ目からは、前に押した時刻＋人の押す間隔で押す",
    since: null,
    kb: "eda23c77",
    marker: "function _pickGapPlan",
    file: "page-script.js",
  },
  {
    id: "playbook_read",
    scene: "switch",
    text: "自動は入力を始める時に手順書を読み、読んだ印（手順書の版・決まりの数・拡張に無い決まり）を点検記録に残す",
    since: "2.8.137",
    kb: null,
    marker: "function _auditPlaybookSeen()",
    file: "page-script.js",
    verify: { mustHave: "page:playbook_seen", mustNot: ["page:playbook_none"] },
  },
  {
    id: "one_cursor",
    scene: "press",
    text: "カーソルは1つだけ（拡張の2か所で位置を共有して順番に動かす・本物のマウスと同時に出さない・人が本物を動かしたらそこから続ける）。形と色はスタッフの PC（Windows）の標準で、手・矢印・I はページが出す形に合わせる",
    since: "2.8.138",
    kb: null,
    marker: "function _auditOneCursor()",
    file: "page-script.js",
    verify: { mustHave: "page:cursor_one", mustNot: ["page:cursor_two", "page:cursor_old"] },
  },
  {
    id: "audit_one_progress",
    scene: "switch",
    text: "点検記録の進み具合は最後の1つだけ残す（一連の後半を記録から押し出さない）",
    since: "2.8.136",
    kb: null,
    marker: "進捗の印は最後の1つだけ残す",
    file: "search-audit.js",
    verify: { onlyIf: ["fill_progress"], maxCount: { key: "fill_progress", n: 1 } },
  },
  {
    id: "audit_keep_reason",
    scene: "switch",
    text: "点検記録が長くなっても、回の始まり・入力の終わり・所在地を区で代替した理由は落とさない。人が押した検索の回は、次の回が始まるか6分で区切りとして閉じる（止まりと数えない）",
    since: "2.8.143",
    kb: null,
    marker: "回の始まり・終わり・代替の理由は残し",
    file: "search-audit.js",
    verify: { minSteps: AUDIT_MAX_STEPS - 20, mustHave: "begin" },
  },
  {
    id: "ward_detail_skip",
    scene: "area",
    text: "区を選んだ後「詳細な地域の設定へ進む」が押せる状態（Y）にならない時は、町まで進むのをやめ、欲しい区が全部入っているか確かめて（足りない区はカーソルで1つずつ押して）「確定してリストへ」を押す。選び直した区が外れたままならもう1回だけ押す",
    since: "2.8.144",
    kb: null,
    marker: "町まで進めない時は区をそろえて確定",
    file: "page-script.js",
    verify: { onlyIf: ["page:ward_btn_y_timeout"], mustHaveAny: ["page:ward_detail_skip", "page:next_step"] },
  },
  {
    id: "audit_rule_evidence",
    scene: "switch",
    text: "決まりを守れたかの確かめに使う印（手順書を読んだ印・カーソル1つの印・段の完了など）は、点検記録が上限に達しても同じ種類を最低1つ残す。記録が空の回・先頭が落ちた回・人が押した検索の回は「守れていない」と数えない",
    since: "2.8.145",
    kb: null,
    marker: "普通の段より後に落とし、落とす時も同じ種類の段を最低1つ残す",
    file: "search-audit.js",
  },
  {
    id: "ward_clear_one",
    scene: "clear",
    text: "前のお客さんの区・町は、まとめて押さず1区ずつ外す。小窓の一覧の中で見えない所にある区は一覧を送って見せてからカーソルで押し、外れたのを確かめてから次の区へ。見えない区は直接押さない（何が隠しているかを点検に残し、小窓を開き直して外す）",
    since: "2.8.146",
    kb: null,
    marker: "1区ずつ: 小窓の一覧を送って見せる→カーソルで押す→外れたか確かめる→次",
    file: "page-script.js",
    verify: { onlyIf: ["page:ward_clear_one"], mustHave: "page:ward_clear_one_done" },
  },
  {
    id: "clear_one_by_one",
    scene: "clear",
    text: "前のお客さんの間取り・ペットなどのチェックも、入れる時と同じく1つずつ外す（まとめて積まない）。カーソルで押して外れたのを確かめてから次へ",
    since: "2.8.147",
    kb: null,
    marker: "入れる時と同じく1つずつ: 送る→カーソルで押す",
    file: "page-script.js",
    verify: { onlyIf: ["page:clear_one"], mustHave: "page:clear_one_done" },
  },
  {
    id: "clear_single_owner",
    scene: "clear",
    text: "外しは同時に1つだけ。送付後の外しが走っていれば、次のお客さんの入力は終わるまで待ってから外す（60秒で終わらなければ止めて引き継ぐ）。引き継いだ古い外しは押すのをやめる",
    since: "2.8.147",
    kb: null,
    marker: "外しは同時に1つだけ。引き継いだら古い外しは止める",
    file: "page-script.js",
    verify: { onlyIf: ["page:post_send_wait"], mustHaveAny: ["page:post_send_wait_done", "page:post_send_cancel"] },
  },
];

/** FNV-1a（32bit）の16進（版の印・暗号ではない） */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 決まりの版（id と文が変われば変わる）。手順書と拡張の点検記録で突き合わせる */
export function autoRulesVersion(rules: ReadonlyArray<AutoRule> = AUTO_RULES): string {
  return fnv(JSON.stringify(rules.map((r) => [r.id, r.scene, r.text, r.since])));
}

export type RuleJudge = {
  id: string;
  /** ok=守れた／ng=守れていない／no_data=この記録では確かめられない（その場面が無い・段が無い） */
  result: "ok" | "ng" | "no_data";
  why: string;
};

/**
 * コード（拡張のファイルの中身）と決まりの一覧の食い違いを数える（純関数）。
 *   テストと、統括Pro に渡す反映の点検（playbook-reflect-server）が同じ物を使う＝テストを回し忘れても統括Pro で出る。
 */
export function checkRulesInCode(files: { pageScript: string; searchAudit: string; manifestJson: string }, rules: ReadonlyArray<AutoRule> = AUTO_RULES): string[] {
  const issues: string[] = [];
  for (const r of rules) {
    const src = r.file === "page-script.js" ? files.pageScript : files.searchAudit;
    if (!src.includes(r.marker)) issues.push(`決まり ${r.id} の目印が ${r.file} に無い（直しが消えた／一覧が古い）`);
  }
  // 確かめに使う段が点検記録の上限で落ちないか（search-audit.js の KEEP_STEP／RULE_STEP）
  const keepRe = readRegexVar(files.searchAudit, "KEEP_STEP");
  const ruleRe = readRegexVar(files.searchAudit, "RULE_STEP");
  if (!keepRe || !ruleRe) issues.push("search-audit.js の KEEP_STEP／RULE_STEP が読めない");
  else {
    for (const r of rules) {
      const lost = verifyKeysOf(r.verify).filter((k) => !keepRe.test(k) && !ruleRe.test(k));
      if (lost.length) issues.push(`決まり ${r.id} の確かめに使う段（${lost.join("・")}）が search-audit.js の RULE_STEP に無い（記録の上限で落ちる）`);
    }
  }
  const m = files.pageScript.match(/var _AXLX_RULES_DONE = \[([\s\S]*?)\];/);
  const done = m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : [];
  const ids = rules.map((r) => r.id);
  const lack = ids.filter((id) => !done.includes(id));
  const extra = done.filter((id) => !ids.includes(id));
  if (!m) issues.push("拡張に _AXLX_RULES_DONE が無い");
  else {
    if (lack.length) issues.push(`一覧にあって拡張の _AXLX_RULES_DONE に無い: ${lack.join("・")}`);
    if (extra.length) issues.push(`拡張にあって一覧（AUTO_RULES）に無い: ${extra.join("・")}（手順書に載らない）`);
  }
  let ver = "";
  try { ver = String(JSON.parse(files.manifestJson).version ?? ""); } catch { /* 下で出す */ }
  if (!ver) issues.push("manifest.json の版が読めない");
  else if (compareExtVersion(AUTO_RULES_REVIEWED_UP_TO, ver) !== 0) {
    issues.push(`拡張の版 ${ver} に対して決まりの一覧は ${AUTO_RULES_REVIEWED_UP_TO} までしか見直していない（直した事が手順書に載っていない恐れ）`);
  }
  return issues;
}

/** `var NAME = /…/;` の形の正規表現をファイルの中身から読む（読めなければ null） */
function readRegexVar(src: string, name: string): RegExp | null {
  const m = src.match(new RegExp(`var ${name} = /(.+)/([a-z]*);`));
  if (!m) return null;
  try { return new RegExp(m[1], m[2]); } catch { return null; }
}

/** 版の比べ（"2.8.137" の形・a<b なら負） */
export function compareExtVersion(a: string, b: string): number {
  const x = a.split(".").map((p) => Number(p) || 0), y = b.split(".").map((p) => Number(p) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; }
  return 0;
}

/**
 * 1回の自動の点検記録で、決まりを守れたかを確かめる（純関数・決定論）。
 *   ⚠ no_data は「守れた」ではない（その場面が無かった・記録の段が無い）。数える時に ok と混ぜない。
 *   ⚠ extVersion（その回の拡張の版）が決まりの入った版より前なら no_data（直す前の回を「守れていない」と数えない）。
 */
export function judgeRulesOnAudit(
  steps: ReadonlyArray<AuditStep>,
  rules: ReadonlyArray<AutoRule> = AUTO_RULES,
  extVersion: string | null = null,
): RuleJudge[] {
  const list = (Array.isArray(steps) ? steps : [])
    .filter((s) => s && typeof s.k === "string")
    .map((s) => ({ k: String(s.k), d: s.d == null ? "" : String(s.d), at: Number(s.at) || 0 }))
    .sort((a, b) => a.at - b.at);
  const has = (k: string) => list.some((s) => s.k === k);
  // 上限まで溜まって回の始まり（begin）が落ちた回は、先頭の段（手順書を読んだ印など）も落ちている
  const headLost = list.length >= AUDIT_MAX_STEPS - 20 && !has("begin");
  return rules.map((r): RuleJudge => {
    const v = r.verify;
    if (!v) return { id: r.id, result: "no_data", why: "点検記録での確かめ方が無い（コードにあるかだけ確かめる）" };
    if (!list.length) return { id: r.id, result: "no_data", why: "記録が空（始まっていない回）" };
    if (extVersion && r.since && /^\d+(\.\d+)*$/.test(extVersion) && compareExtVersion(extVersion, r.since) < 0) {
      return { id: r.id, result: "no_data", why: `この回の拡張 ${extVersion} は決まり（${r.since}〜）より前` };
    }
    if (v.onlyIf && !v.onlyIf.some(has)) return { id: r.id, result: "no_data", why: `${v.onlyIf.join("・")} が無い（その場面が無かった回）` };
    if (v.minSteps && list.length < v.minSteps) return { id: r.id, result: "no_data", why: `段が ${list.length}（${v.minSteps} 未満の短い回）` };
    if (v.mustHave && !has(v.mustHave)) {
      if (headLost && v.mustHave !== "begin") return { id: r.id, result: "no_data", why: `${v.mustHave} が無いが、記録の先頭が上限で落ちた回（begin も無い）` };
      return { id: r.id, result: "ng", why: `${v.mustHave} が無い` };
    }
    if (v.mustHaveAny && !v.mustHaveAny.some(has)) {
      return { id: r.id, result: "ng", why: `${v.mustHaveAny.join("・")} のどれも無い` };
    }
    if (v.maxCount) {
      const c = list.filter((s) => s.k === v.maxCount!.key).length;
      if (c > v.maxCount.n) return { id: r.id, result: "ng", why: `${v.maxCount.key} が ${c}回（${v.maxCount.n}回まで）` };
    }
    if (v.seq) {
      const firsts = v.seq.map((k) => ({ k, at: list.find((s) => s.k === k)?.at })).filter((x): x is { k: string; at: number } => typeof x.at === "number");
      if (firsts.length < 2) return { id: r.id, result: "no_data", why: `${v.seq.join("→")} のうち出たのが ${firsts.length}つ` };
      for (let i = 1; i < firsts.length; i++) {
        if (firsts[i].at < firsts[i - 1].at) return { id: r.id, result: "ng", why: `順番が違う（${firsts[i].k} が ${firsts[i - 1].k} より先）` };
      }
      if (!v.mustNot && !v.maxGap && !v.order) return { id: r.id, result: "ok", why: `順番どおり（${firsts.map((x) => x.k.replace(/^page:/, "")).join("→")}）` };
    }
    if (v.mustNot) {
      const hit = list.filter((s) => v.mustNot!.includes(s.k));
      if (hit.length) return { id: r.id, result: "ng", why: `${hit[0].k} が ${hit.length}回（${hit[0].d.slice(0, 40)}）` };
      return { id: r.id, result: "ok", why: `${v.mustNot.join("・")} が 0回` };
    }
    if (v.maxGap) {
      const { from, to, ms } = v.maxGap;
      const gaps: number[] = [];
      for (let i = 0; i < list.length; i++) {
        if (list[i].k !== from) continue;
        const j = list.findIndex((s, idx) => idx > i && s.k === to);
        if (j < 0) continue;
        gaps.push(list[j].at - list[i].at);
      }
      if (!gaps.length) return { id: r.id, result: "no_data", why: `${from}→${to} の組が無い` };
      const worst = Math.max(...gaps);
      return worst <= ms
        ? { id: r.id, result: "ok", why: `${gaps.length}回・一番長い ${worst}ms（≤${ms}）` }
        : { id: r.id, result: "ng", why: `${gaps.length}回のうち一番長い ${worst}ms（>${ms}）` };
    }
    if (v.order) {
      const seen = list.filter((s) => s.k === v.order!.key).map((s) => s.d);
      if (!seen.length) return { id: r.id, result: "no_data", why: `${v.order.key} が無い（外す物が無かった回）` };
      const idx = seen.map((d) => v.order!.seq.findIndex((x) => d.includes(x))).filter((i) => i >= 0);
      for (let i = 1; i < idx.length; i++) {
        if (idx[i] < idx[i - 1]) return { id: r.id, result: "ng", why: `順番が違う（${seen.join(" → ").slice(0, 80)}）` };
      }
      return { id: r.id, result: "ok", why: `順番どおり（${seen.length}段）` };
    }
    if (v.mustHave || v.mustHaveAny || v.maxCount) return { id: r.id, result: "ok", why: "確かめた段がそろっている" };
    return { id: r.id, result: "no_data", why: "確かめ方が空" };
  });
}

export type PlaybookSeen = {
  version: string | null;
  rules_v: string | null;
  /** 手順書の決まりの数 */
  rules: number;
  /** そのうち拡張に入っている数 */
  have: number;
  /** 手順書にあって拡張に無い決まり（拡張が古い。先頭2つ＋残りの数） */
  missing: string[];
  missing_more: number;
  /** 拡張にあって手順書に無い決まり（手順書が古い） */
  extra: string[];
  extra_more: number;
  scenes: number;
  hands: number;
};

/**
 * 拡張が点検記録に残す「手順書を読んだ印」（page:playbook_seen）を読む。
 *   形: v=… rv=… 決まり=有る/全部 無い=a,b,+N 手順書に無い=c,+N 場面=n 手=n（page-script.js の _auditPlaybookSeen）
 */
export function parsePlaybookSeen(d: string | null | undefined): PlaybookSeen | null {
  const s = String(d ?? "");
  if (!s) return null;
  const pick = (k: string) => { const m = s.match(new RegExp(`(?:^| )${k}=([^ ]+)`)); return m ? m[1] : null; };
  const list = (v: string | null) => {
    const parts = v && v !== "-" ? v.split(",").filter(Boolean) : [];
    const more = parts.filter((p) => /^\+\d+$/.test(p)).reduce((a, p) => a + Number(p.slice(1)), 0);
    return { ids: parts.filter((p) => !/^\+\d+$/.test(p)), more };
  };
  const nums = (pick("決まり") ?? "").match(/^(\d+)\/(\d+)$/);
  const miss = list(pick("無い"));
  const extra = list(pick("手順書に無い"));
  return {
    version: pick("v"),
    rules_v: pick("rv"),
    have: nums ? Number(nums[1]) : 0,
    rules: nums ? Number(nums[2]) : 0,
    missing: miss.ids,
    missing_more: miss.more,
    extra: extra.ids,
    extra_more: extra.more,
    scenes: Number(pick("場面")) || 0,
    hands: Number(pick("手")) || 0,
  };
}

/**
 * 手順書（DB の束）と、コードの決まりと、拡張の読んだ印を突き合わせる（純関数）。
 *   統括Pro・点検スクリプトが同じ物を使う。ok=false の時の why を、そのまま人に見せる。
 */
export function judgePlaybookReflect(input: {
  /** DB の束の手順書（無ければ null） */
  playbook: { build_v?: number; rules_v?: string; rules?: Array<{ id?: string }>; scenes?: Array<{ steps?: unknown[]; detail?: unknown[] }> } | null;
  /** 今の作り方の版（action-playbook.ts の PLAYBOOK_BUILD_V） */
  buildV: number;
  /** 直近の自動の点検記録の印（新しい順。無ければ空） */
  seen: Array<PlaybookSeen | "none">;
  rules?: ReadonlyArray<AutoRule>;
}): { ok: boolean; why: string[]; facts: string[] } {
  const rules = input.rules ?? AUTO_RULES;
  const codeV = autoRulesVersion(rules);
  const why: string[] = [];
  const facts: string[] = [];
  const pb = input.playbook;
  if (!pb) why.push("DB の手順書が無い");
  else {
    const ids = (pb.rules ?? []).map((r) => String(r?.id ?? "")).filter(Boolean);
    const lack = rules.map((r) => r.id).filter((id) => !ids.includes(id));
    facts.push(`手順書: 作り方 ${pb.build_v ?? "-"}・決まり ${ids.length}件（版 ${pb.rules_v ?? "-"}）・コードの決まり ${rules.length}件（版 ${codeV}）`);
    if ((Number(pb.build_v) || 0) < input.buildV) why.push(`手順書の作り方が古い（${pb.build_v ?? "-"} < ${input.buildV}）`);
    if (!ids.length) why.push("手順書に自動の決まりが1つも無い");
    else if (pb.rules_v !== codeV) why.push(`手順書の決まりの版が古い（手順書 ${pb.rules_v ?? "-"}・コード ${codeV}）`);
    if (ids.length && lack.length) why.push(`手順書に無い決まり ${lack.length}件（${lack.slice(0, 4).join("・")}）`);
    const badDetail = (pb.scenes ?? []).filter((s) => !Array.isArray(s.detail) || s.detail.length !== (s.steps ?? []).length).length;
    if (badDetail) why.push(`1手ずつの細部が無い場面 ${badDetail}件`);
  }
  if (!input.seen.length) why.push("自動の点検記録に「手順書を読んだ印」がまだ無い（2.8.137 以降で1回自動を回すと出る）");
  else {
    const last = input.seen[0];
    if (last === "none") why.push("直近の自動で手順書が届いていない（playbook_none）");
    else {
      facts.push(`直近の自動が読んだ手順書: 版 ${last.version ?? "-"}・決まり ${last.have}/${last.rules}・場面 ${last.scenes}・手 ${last.hands}`);
      if (last.rules_v && last.rules_v !== codeV) why.push(`自動が読んだ手順書の決まりの版が古い（${last.rules_v}・コード ${codeV}）`);
      if (last.missing.length || last.missing_more) why.push(`手順書にあって拡張に無い決まり（拡張が古い）: ${last.missing.join("・")}${last.missing_more ? ` 他${last.missing_more}` : ""}`);
      if (last.extra.length || last.extra_more) why.push(`拡張にあって手順書に無い決まり（手順書が古い）: ${last.extra.join("・")}${last.extra_more ? ` 他${last.extra_more}` : ""}`);
    }
  }
  return { ok: why.length === 0, why, facts };
}
