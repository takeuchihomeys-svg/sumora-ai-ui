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
//   ⚠ 決まりを足す・変える時: ここ → page-script.js の `_AXLX_RULES_DONE` →（bulk-dl なら目印も）→ テストの順に直す。
//   ⚠ 重要な自動の動き（AD並び替えなど）を直したら、必ずここに1件載せる。載せないと
//     checkRulesInCode／auto-procedure-rules.test／統括Pro の手順書反映が落ちる（抜け防止）。
//   ⚠ 統括（Pro）の判断は入れない。ここは決まりの一覧と、数えて確かめるだけ。

/**
 * 決まりの一覧を見直した拡張の版（2026-11-20 竹内さん「手順書の重要度と優先度あげる」「改善したら手順書が改善されるように仕組みをちゃんと」）。
 *   拡張（manifest.json）の版を上げたら、この一覧を見直してからここも同じ版にする。
 *   上げ忘れはテスト（auto-procedure-rules.test.ts）が止める＝直したのに手順書が古いまま、を出さない。
 */
export const AUTO_RULES_REVIEWED_UP_TO = "2.8.312";

/** 決まりが効く場面（手順書の場面＋自動だけの場面） */
export type RuleScene = "switch" | "clear" | "area" | "cond" | "pet" | "search" | "list" | "press";

export const RULE_SCENE_JA: Record<RuleScene, string> = {
  switch: "お客さんの切り替え",
  clear: "前のお客さんの条件を外す",
  area: "所在地絞り込み",
  cond: "条件（賃料・間取り・徒歩など）",
  pet: "絞り込み条件（ペット）",
  search: "検索を押す",
  list: "検索結果（物件の取得・並び替え）",
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

/**
 * 点検記録で確かめられない決まりの「理由つきの例外」（2026-11-27 抜け防止）。
 *   ここに無い決まりで verify が空のものは、テスト（playbook-gap-baseline.test.ts）が止める＝確かめ方を作るか、理由を書く。
 *   理由は「なぜ点検記録に段が出ないか」を一言で。手順書の抜け一覧（gaps）には出さない（理由つきで受け入れた物）。
 */
export const RULES_CODE_ONLY: Readonly<Record<string, string>> = {
  no_reset_button: "リセットボタンを押さない、という「押さなかった」事は段に残らない（押したら _doReset の段が出るので、コードの目印で守りを見る）",
  hidden_work_no_pause: "画面に見えない作業（学習の取り込み・確かめ）の段は点検記録に出さない設計（迷い・停止の段で守れたかは見えない）",
  audit_rule_evidence: "点検記録そのものの作り方の決まり（段を落とす時の守り）。確かめる対象が点検の仕組み自身なので、段では確かめない",
  human_fixed_waits_routed: "固定の待ち時間を人の間（_hd）に通す決まり。待ち時間は段に残らないので、目印（コードの呼び方）で見る",
  human_fixed_waits_routed_bulk: "一括の固定の待ち時間を人の間（_hd）に通す決まり。待ち時間は段に残らないので、目印（コードの呼び方）で見る",
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
  file: "page-script.js" | "search-audit.js" | "bulk-dl.js" | "background.js";
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
    text: "検索・入力の最中（ページ内の _doReset）はリセットボタンを押さない（押すと読み直しで入力が消える）。リセットを押してよいのは background の2点だけ：送付完了の後（reset_between_customers）と、一括で条件を入れる前（reset_before_fill）。どちらかで空と確かめられたら外す工程はやらない（reset_replaces_clear）",
    since: "2.8.107",
    kb: null,
    marker: "自動は「リセット」ボタンを押さない",
    file: "page-script.js",
  },
  {
    id: "clear_per_panel",
    scene: "clear",
    text: "通常はリセットで空にする（reset_replaces_clear）。最後の保険（リセットが押せない・空にならない時だけ・reset_fallback）で外す時は、箱ごと（間取り → 絞り込み条件（ペット）→ 所在地 → 残り）に、箱を開ける → 1つずつカーソルで外す → 確定 → 次の箱。全部の箱を先に開けない",
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
    verify: {
      onlyIf: ["page:sel_one_press"],
      mustHaveAny: ["page:sel_one_press"],
    },
  },
  {
    id: "checkbox_settle",
    scene: "press",
    text: "チェックは押した後 0.6秒まで反映を待つ。押し直す時はカーソルの押す動き付きで1回だけ",
    since: "2.8.136",
    kb: null,
    marker: "return _settleChk(600)",
    file: "page-script.js",
    verify: {
      onlyIf: ["page:toggle_late_ok", "page:toggle_repress", "page:toggle_direct"],
      mustHaveAny: ["page:toggle_late_ok", "page:toggle_repress", "page:toggle_direct"],
    },
  },
  {
    id: "ward_pace",
    scene: "area",
    text: "区は人の速さで1つずつ（速い50%・迷い44%・停止6%）",
    since: "2.8.109",
    kb: "5022ab57",
    marker: "function _wardGapPlan",
    file: "page-script.js",
    verify: {
      onlyIf: ["page:ward_pace"],
      mustHaveAny: ["page:ward_pace"],
    },
  },
  {
    id: "pick_pace",
    scene: "cond",
    text: "駅・沿線・町字・間取りの2つ目からは、前に押した時刻＋人の押す間隔で押す",
    since: null,
    kb: "eda23c77",
    marker: "function _pickGapPlan",
    file: "page-script.js",
    verify: {
      onlyIf: ["page:pick_pace"],
      mustHaveAny: ["page:pick_pace"],
    },
  },
  {
    id: "playbook_read",
    scene: "switch",
    text: "自動は入力を始める時に手順書を読み、読んだ印（手順書の版・決まりの数・拡張に無い決まり）を点検記録に残す。手順書と拡張の版がずれていたら playbook_behind（どちらが古いか・版）を1段足す",
    since: "2.8.137",
    kb: null,
    marker: "function _auditPlaybookSeen()",
    file: "page-script.js",
    verify: { mustHave: "page:playbook_seen", mustNot: ["page:playbook_none", "page:playbook_behind"] },
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
    text: "通常はリセットで空にする。最後の保険（リセットが押せない・空にならない時だけ・reset_fallback）で外す時は、前のお客さんの間取り・ペットなどのチェックも入れる時と同じく1つずつ外す（まとめて積まない）。カーソルで押して外れたのを確かめてから次へ",
    since: "2.8.147",
    kb: null,
    marker: "入れる時と同じく1つずつ: 送る→カーソルで押す",
    file: "page-script.js",
    verify: { onlyIf: ["page:clear_one"], mustHave: "page:clear_one_done" },
  },
  {
    id: "clear_single_owner",
    scene: "clear",
    text: "外しは同時に1つだけ。リセット（送付後のリセット＝最大260秒）が走っていれば、次のお客さんの入力は終わるまで待ってから押す（60秒で終わらなければ止めて引き継ぐ）。引き継いだ古いリセット・外しは押すのをやめる。最後の保険で1つずつ外す時（reset_fallback）も同時に1つだけ",
    since: "2.8.147",
    kb: null,
    marker: "外しは同時に1つだけ。引き継いだら古い外しは止める",
    file: "page-script.js",
    verify: { onlyIf: ["page:post_send_wait"], mustHaveAny: ["page:post_send_wait_done", "page:post_send_cancel"] },
  },
  {
    id: "search_to_sort_cursor",
    scene: "list",
    text: "検索を押した把握をトリガーに、検索確認の時刻から30〜36秒（2.8.292・経過した分は引く・残りは最低50ms）の人間ランダム待ちのあと並べ替えへカーソル移動する（旧「1秒以降」は廃止）。見る間キャンセルで _autoPdfSig を固着させない。印: dl:sort_cursor_wait / sort_cursor_go / sort_menu",
    since: "2.8.191",
    kb: "92413949",
    marker: "_scheduleSortCursorAfterSearch",
    file: "bulk-dl.js",
    verify: {
      onlyIf: ["dl:search_to_sort", "dl:sort_cursor_wait", "dl:after_search"],
      mustHaveAny: ["dl:sort_cursor_go", "dl:sort_menu", "dl:sort_head_hover"],
    },
  },
  {
    id: "search_confirm_then_wait_sort",
    scene: "list",
    text: "並べ替えは検索ボタン押下の確認（search_press_ok／search_customer_grasp_ok／screenOk）が取れてから。確認時刻から30秒以上空けて sort_cursor へ（2.8.292・録画で確かめた人の間は36秒。1〜3.5秒は旧で、物件の表示が追いつかなかった）。並べ替えの待ちの間は一覧の描き直しから押し始めない（wait_sort_cursor）。並べ替えに失敗したら並びのまま押す前に30〜36秒待って最初からもう1回（sort_failed_wait_retry・2.8.293）。click直前の意図印・armed直後の旧一覧では並べ替えない。印: search_grasp_intent_only / sort_gate_need_confirm / search_confirm_gap / sort_cursor_wait",
    since: "2.8.207",
    kb: null,
    marker: "_isSearchConfirmGrasp",
    file: "bulk-dl.js",
    verify: {
      onlyIf: ["dl:sort_cursor_go", "dl:sort_menu", "dl:search_to_sort"],
      mustHaveAny: [
        "page:search_press_ok",
        "page:search_customer_grasp_ok",
        "page:guide_phase_after_search",
        "dl:search_grasp_gate",
        "dl:search_customer_screen_ok",
        "dl:sort_cursor_wait",
        "dl:search_confirm_gap",
      ],
    },
  },
  {
    id: "false_complete_next_gate",
    scene: "list",
    text: "把握→次へは『意図』と『完了』を分ける。click直前・armedは意図のみ（search_grasp_intent_only）。after_search完了・guide_phase_ok・screenOkは押下確認後だけ。誤った完了印で次段（並べ替え）に移らない",
    since: "2.8.207",
    kb: null,
    marker: "search_grasp_intent_only",
    file: "page-script.js",
    verify: {
      onlyIf: ["page:search_grasp_intent_only"],
      mustHaveAny: [
        "page:search_press_ok",
        "page:search_customer_grasp_ok",
        "page:guide_phase_after_search",
        "dl:search_grasp_gate",
        "dl:sort_gate_need_confirm",
      ],
    },
  },
  {
    id: "list_modal_not_sidebar",
    scene: "list",
    text: "条件モーダル判定は one_station/one_line/one_city とモーダル固有見出しだけ。左サイド常時の「所在地」単体でモーダル中と誤らない",
    since: "2.8.192",
    kb: "92413949",
    marker: "_hasSortHeadVisible",
    file: "bulk-dl.js",
    verify: {
      onlyIf: ["dl:sort_cursor_wait", "dl:after_search"],
      mustHaveAny: ["dl:sort_gate_main", "dl:sort_gate_reclassify", "dl:sort_cursor_go", "dl:sort_menu"],
    },
  },
  {
    id: "sort_gate_main_insurance",
    scene: "list",
    text: "並べ替えへは関所で細分化: sort_gate_check→main|reclassify|wait_modal|wait_fill|wait_rows。誤検知は再分類で本線続行。保険(sort_cursor_insurance)は本線が5回待っても進まない時の1回だけ",
    since: "2.8.193",
    kb: "92413949",
    marker: "_gateSortCursorReady",
    file: "bulk-dl.js",
    verify: {
      onlyIf: ["dl:sort_gate_check", "dl:sort_cursor_wait", "dl:after_search"],
      mustHaveAny: ["dl:sort_gate_main", "dl:sort_gate_reclassify", "dl:sort_cursor_go", "dl:sort_menu"],
    },
  },
  {
    id: "search_customer_screen_grasp",
    scene: "list",
    text: "お客さんで検索したことを手順書×画面で把握する: 押下確認後に基準画面を取り、変化または試行進みで search_customer_grasp_ok。click直前では画面照合しない（旧一覧の誤screenOk禁止）。客番号を把握に紐づけ、確認後に並べ替え本線へ",
    since: "2.8.195",
    kb: "92413949",
    marker: "_verifyCustomerSearchScreenGrasp",
    file: "page-script.js",
    verify: {
      onlyIf: ["page:guide_phase_after_search", "page:search_customer_grasp_intent", "dl:after_search"],
      mustHaveAny: ["page:search_customer_grasp_ok", "page:guide_phase_after_search_screen", "dl:search_customer_screen_ok", "dl:sort_cursor_go", "dl:sort_menu"],
    },
  },
  {
    id: "search_grasp_reload_resume",
    scene: "list",
    text: "検索click→リロードで画面照合タイマーが死んでも、新ページで sync 意図把握を読み reload_resume で画面照会を再開。Case C でも一覧証拠があれば search_customer_screen_ok に昇格",
    since: "2.8.196",
    kb: "92413949",
    marker: "reload_resume",
    file: "page-script.js",
    verify: {
      onlyIf: ["page:search_grasp_reload_resume", "dl:after_search", "page:search_customer_grasp_intent"],
      mustHaveAny: ["page:search_customer_grasp_ok", "dl:search_customer_screen_ok", "dl:sort_cursor_go", "dl:sort_menu"],
    },
  },
  {
    id: "sort_head_buried_find",
    scene: "list",
    text: "検索把握後の並べ替えで『並べ替え』が見つからない（sort_no_head）を防ぐ。巨大main_table文言に埋もれても含む一致＋最短要素で見出しを掴み、失敗時は見出しが見えるなら再試行してから物件取得へ進む",
    since: "2.8.197",
    kb: "92413949",
    marker: "_findSortHeadEl",
    file: "bulk-dl.js",
    verify: {
      // 途中の sort_no_head 再試行印は残るので mustNot は付けない。完了は head_hover/done/hilo
      onlyIf: ["dl:sort_menu", "dl:sort_cursor_go", "dl:after_search"],
      mustHaveAny: ["dl:sort_head_hover", "dl:sort_done", "dl:sort_hilo", "dl:sort_retry_before_pdf", "dl:flow_atom_ok_sort_menu"],
    },
  },
  {
    id: "sort_head_aim_toori_fallback",
    scene: "list",
    text: "並べ替え見出しaim: 短い『並べ替え』学習が無い時は束の棟戸｜div.under 座標を①見出しの保険に使う（③高→低の別名にはしない・330797cb）。旧falseHeadがunderを全除外しsort_head_aim_warm=0→sort_no_headでPDFへ飛んでいた。印: sort_head_aim_warm→sort_head_aim_hit/scroll→sort_head_hover",
    since: "2.8.218",
    kb: "330797cb",
    marker: "_pickSortHeadAimFromPoints",
    file: "bulk-dl.js",
    verify: {
      onlyIf: ["dl:sort_menu", "dl:sort_aim_warm", "dl:sort_no_head"],
      mustHaveAny: ["dl:sort_head_aim_warm", "dl:sort_head_aim_hit", "dl:sort_head_hover", "dl:sort_done"],
    },
  },
  {
    id: "legacy_ad_requires_screen_ok",
    scene: "list",
    text: "screenOk無しADを全経路で禁止。legacy_claude_pathに加えarmed_rows/armed_list/list_visible/sync_pending/pending_armed/memもfinishGateでscreenOk必須（2.8.244一本化）。未達はlegacy_blocked_no_screen",
    since: "2.8.244",
    kb: "18cce5a8",
    marker: "finishGate:",
    file: "bulk-dl.js",
    verify: {
      onlyIf: [
        "dl:legacy_blocked_no_screen",
        "dl:search_grasp_gate",
        "dl:search_customer_screen_ok",
        "page:search_results_ready",
      ],
      mustHaveAny: [
        "dl:legacy_blocked_no_screen",
        "dl:search_grasp_gate",
        "dl:search_customer_screen_ok",
        "page:search_results_ready",
      ],
    },
  },
  {
    id: "auto_foundation_subdivide_reflect",
    scene: "press",
    text: "自動開始で土台関所: 版印・古いgrasp捨て・手順書強制再読・弱い原子を細分化焦点（flow_subdivide_drive）・learn反映。沈黙中も細分化を回す。古い衝突経路のまま進まない",
    since: "2.8.243",
    kb: "71cc70f0",
    marker: "_enforceAutoFoundation",
    file: "page-script.js",
    verify: {
      onlyIf: [
        "page:foundation_gate",
        "page:flow_subdivide_drive",
        "page:flow_subdivide_need",
        "page:flow_subdivide_ok",
        "page:stale_grasp_drop",
      ],
      mustHaveAny: [
        "page:foundation_gate",
        "page:flow_subdivide_drive",
        "page:flow_subdivide_need",
        "page:flow_subdivide_ok",
      ],
    },
  },
  {
    id: "foundation_aim_warm_score_gate",
    scene: "press",
    text: "再現55%の主因（cursor59・point47）は関所配線とは別。fill入口でaim強制warm＋score_gate（配線≠再現）を残す。F58✓でも再読込前は点数が動かない",
    since: "2.8.245",
    kb: "9c63b277",
    marker: "score_gate",
    file: "page-script.js",
    verify: {
      onlyIf: [
        "page:score_gate",
        "page:foundation_aim_warm",
        "page:learn_warm",
        "page:foundation_gate",
      ],
      mustHaveAny: [
        "page:score_gate",
        "page:foundation_aim_warm",
        "page:learn_warm",
      ],
    },
  },
  {
    id: "keep_strengthen_loop",
    scene: "press",
    text: "強化は入口1回で終わらせない。沈黙中もaim再warm＋細分化を回し strengthen_loop 印で次手を残す（F65）。弱さが残る限り続ける",
    since: "2.8.246",
    kb: "ee4755c4",
    marker: "_driveKeepStrengthen",
    file: "page-script.js",
    verify: {
      onlyIf: [
        "page:strengthen_loop",
        "page:strengthen_aim_rewarm",
        "page:flow_subdivide_drive",
        "page:foundation_gate",
      ],
      mustHaveAny: [
        "page:strengthen_loop",
        "page:strengthen_aim_rewarm",
      ],
    },
  },
  {
    id: "search_armed_kick_sort",
    scene: "list",
    text: "検索を押したら必ず armed（AJAXでも）。並べ替え kick は検索確認後だけ（armed直後の旧一覧ではしない）。pending/sync があればこの一覧だけ自動ON。止まって「0件選択中」にしない",
    since: "2.8.190",
    kb: "92413949",
    marker: "_kickSortAfterSearch",
    file: "bulk-dl.js",
    verify: {
      onlyIf: ["dl:search_armed", "dl:search_to_sort", "page:search_armed"],
      mustHaveAny: ["dl:search_to_sort", "dl:sort_menu", "dl:sort_hilo", "dl:sort_done"],
    },
  },
  {
    // 2.8.299: 人の間（わざとの停止・迷い・押す前の間）は「止まり」ではない。見張りが数えないための印を立てる
    id: "intent_wait_not_stall",
    scene: "press",
    text: "人の間（手を止める・迷い・押す前の間）はわざとの待ち。待つ前に印（window.__axlxIntentWait）を立て、列の20秒見張りと沈黙135秒の見張り（スクショ→画面把握→次の手）は印の間は止まりと数えない（印は予定の終わり＋3秒で切れる）。予定を15秒超えた時だけ本物の止まり（fill_pause_force）。点検は予定と実際の秒（fill_pause／fill_resume）",
    since: "2.8.299",
    kb: null,
    marker: "function _intentWaitMark(",
    file: "page-script.js",
    verify: {
      onlyIf: ["page:fill_resume", "page:fill_pause_force"],
      mustHaveAny: ["page:fill_pause"],
    },
  },
  {
    // 2.8.302: 手を止める長さは毎回ちがう（4〜11秒・中央6.5秒）。6秒に固めない
    id: "hand_pause_range",
    scene: "press",
    text: "手を止める間は4〜11秒で毎回ちがう（中央6.5秒・対数正規）。手の動きの既定の上限は6秒のまま、停止だけ11秒まで（drift の maxMs）。区・select の最中は長い停止を入れない（区の間隔は別の決まり）",
    since: "2.8.302",
    kb: null,
    marker: "function _handPauseMs()",
    file: "page-script.js",
    verify: {
      onlyIf: ["page:fill_pause", "page:fill_resume"],
      mustHaveAny: ["page:fill_pause", "page:fill_resume"],
    },
  },
  {
    id: "human_fixed_waits_routed",
    scene: "press",
    text: "押す前・押した後の人の間（検索の前のパネル清算350・ペット欄の確認350と280・再試行450）は固定の数字にせず _hd（人の間・基準の0.8〜1.5倍）を通す。固定だと毎回同じ間になり機械的に見える。",
    since: "2.8.303",
    kb: null,
    marker: "setTimeout(clickSearch, _hd(350))",
    file: "page-script.js",
  },
  {
    id: "human_fixed_waits_routed_bulk",
    scene: "press",
    text: "一括（bulk-dl）の押す前・送る前の間（並べ替えの再試行1600・ホバー後120/200/140・並べ替えの開始500/450・チェック後の送付400・1件送付の間80）も _hd を通す。固定の数字の待ちを残さない。",
    since: "2.8.303",
    kb: null,
    marker: "setTimeout(go, _hd(200))",
    file: "bulk-dl.js",
  },
  {
    id: "ext_behind_notice",
    scene: "switch",
    text: "拡張が本番の最新版より古い時（再読み込みの忘れ）は、ポップアップの上に案内を出し、客ごとの記録に ext_behind を1段残す。自動では再読み込みしない（読み込み元のファイルが最新とは限らないため）。",
    since: "2.8.304",
    kb: null,
    marker: "var _extBehind =",
    file: "background.js",
    verify: {
      onlyIf: ["ext_behind"],
      mustHaveAny: ["ext_behind"],
    },
  },
  {
    id: "reset_replaces_clear",
    scene: "clear",
    text: "リセットと、最後の保険（リセットが押せない時だけ）の「1つずつ外す」はぶつけない。順番は固定：①リセットを押して空と読み戻す（送付後 reset_between_customers／一括・単発の入力前 reset_before_fill。単発は iframe がリロードで消えても background が autoFillAfter で自動入力を引き継ぐ）②空と確かめられたら外す工程（clear_stage・post_send_clear・clear_then_fill_ok の待ち）は行わず、そのまま新条件を入れる ③リセットが押せない・空にならない・数が増えた（外れた証拠）時だけ、従来の1つずつ外すを代わりに使う（reset_fallback）。リセットは入力の最中には押さない（入力が消える）。案内モード中（normal）はリセットを押さない（2.8.310）",
    since: "2.8.305",
    kb: "265a1cca",
    marker: "reset_replaces_clear",
    file: "background.js",
    verify: {
      onlyIf: ["reset_press"],
      mustHaveAny: ["reset_verified", "reset_fallback", "reset_retry"],
    },
  },
  {
    id: "series_handoff_order",
    scene: "switch",
    text: "連続のお客さんのループ（一括）。各お客さんの流れ：①入力前：ページが空か読む（前の回のリセットが途中なら残りを待つ・空でなければもう1回リセットして空を確認。すでに空なら押さない）②次客の条件を拡張ツールのAPI（/api/property-customers・キャッシュなし）から読み直して入力（読めない時は今までの条件で続ける）③検索→確認の時刻から30〜36秒待って並べ替え→物件取得→送付 ④送付が終わったら、完了の小窓を閉じてリセットを押し、読み直しを待ち、30秒以上（30〜34秒）人の間で待ってから空を確認し、空の画面を1枚撮る。空ならリセット成功＝1つずつ外す工程は行わない・資料を見る間も置かない（件数が増えなくても空なら成功・数は記録だけ）⑤次のお客さんがいれば①へ戻る（リセットは各客の最後に1回・次客の①は通常すでに空なので押さない）。最後のお客さんは完了を待たせず裏でリセットして終わる。リセットが押せない・空にならない時だけ、従来の1つずつ外しと資料を見る間（1.8〜13秒）を代わりに使う（reset_fallback）。読み直し（②）はリセットと空の確認より後。印: reset_verified／reset_before_fill／look_skip／bulk_pos／handoff_loop",
    since: "2.8.306",
    kb: "265a1cca",
    marker: "var customer = await _refreshCustomerBeforeSearch(customer, site);",
    file: "background.js",
    verify: {
      onlyIf: ["handoff_loop"],
      mustHaveAny: ["reset_before_fill", "reset_verified", "reset_fallback", "handoff_loop"],
    },
  },
  {
    id: "reset_empty_is_enough",
    scene: "clear",
    text: "リセットを押した後、フォームが空と読み戻せたらリセット成功とする。該当件数が増えたかは記録（reset_count_same）だけに残し、増えなくても1つずつ外しに回さない（外しがボトルネックにならないように・2.8.307）。ページ側にも『きれい』の印（axlx_reset_clean）を付け、前客の外し（小窓を開いて確かめる）を省く。空にならない・押せない時だけ従来の外しへ",
    since: "2.8.307",
    kb: "265a1cca",
    marker: "reset_empty_is_enough",
    file: "background.js",
    verify: {
      onlyIf: ["reset_count_same"],
      mustHaveAny: ["reset_verified"],
    },
  },
  {
    id: "reset_success_skips_look",
    scene: "switch",
    text: "一括で送付後のリセットが成功した客は、『資料を見る間（1.8〜13秒）』を置かない。リセット後の待ち（30秒以上）・空の確認・撮影までの間が、すでに人の間になっているため。リセットが使えなかった客・最後のお客さんだけ従来どおり置く。印: look_skip",
    since: "2.8.307",
    kb: "265a1cca",
    marker: "reset_success_skips_look",
    file: "background.js",
    verify: {
      onlyIf: ["look_skip"],
      mustHaveAny: ["look_skip"],
    },
  },
  {
    id: "reset_retry_insurance",
    scene: "clear",
    text: "リセットが空にならない・押せない・例外の時は、すぐ従来の1つずつ外しへ行かず、1回だけ保険を入れる：①画面を1枚撮る（reset_stuck_shot）②画面を読む（reset_stuck_grasp＝空か・残り・読み込み中）③じつは空だった（確認が遅れただけ）なら成功（reset_stuck_recovered）④空でなければリセットをもう1回押して空を確かめる（reset_retry）⑤それでもだめな時だけ従来の外しへ（reset_fallback）。送付後のリセットと入力前のリセットの両方に効く。off・タブなし・入力の最中・ストップ要求の時は何もしない。待ちの上限（260秒）は2回目の前に張り直す。並べ替え側の保険（本線5回待ち→1回だけ強制・失敗→30〜36秒待って最初から・135秒沈黙→スクショ→画面把握→最善の次手）と同じ考え方",
    since: "2.8.308",
    kb: "f3d2c5b1",
    marker: "_resetWithInsurance(",
    file: "background.js",
    verify: {
      onlyIf: ["reset_retry"],
      mustHaveAny: ["reset_stuck_shot", "reset_verified", "reset_fallback"],
    },
  },
  {
    id: "task_gate_no_forced_refetch",
    scene: "search",
    text: "タスクが切り替わるたびの「手順書API取り直し」（task_api_refresh）は、いつも強制で重い束を取り直さない。強制にするのはポップアップを開いた時（src=popup_open）とページ起動で束が空・古い時（src=boot_need）だけ。検索前とタスク切替の関所は gate 判定（更新直後・手順書欠・needs_auto・束が薄い時だけ強制）で、普段は版だけ確かめて「取らず」で通す。旧は受け口がページ側の force を無視して毎回 true にしており、版確認を飛ばして scope=realpro / itandi を各最大40秒で取っていた（関所は8秒で切れて先へ進むが裏の取得は走り続け、1人あたり関所が複数回・サーバーへ追い打ち）。関所の結果は task_api_refresh_res（timeout／取らず／取込）と task_transition_gate で監査に残す（2.8.309 から保持）",
    since: "2.8.309",
    kb: "f3d2c5b1",
    marker: 'src === "boot_need"',
    file: "background.js",
    verify: {
      onlyIf: ["page:task_api_refresh"],
      mustHaveAny: ["page:task_api_refresh_res"],
    },
  },  {
    id: "ad_sort_hover",
    scene: "list",
    text: "検索把握のあと物件取得の前に必ずAD並べ替え: ①「並べ替え」へカーソル（クリックしない）②メニュー内の「AD」へカーソル（クリックしない・一覧のAD列は禁止）③AD右のspan.sort_detail「高→低」だけクリック。URL直禁止。カーソルはforceOneCursorで1本。印: sort_head_hover→sort_ad_hover→sort_hilo/sort_done",
    since: "2.8.169",
    kb: "42310121",
    marker: "findSortDetailByRec",
    file: "bulk-dl.js",
    // リトライで途中の sort_no_* が残っても、最後に高→低まで行けば守れた
    verify: {
      onlyIf: ["dl:sort_head_hover", "dl:sort_ad_hover", "dl:sort_hilo", "dl:sort_no_head", "dl:sort_no_ad", "dl:sort_no_hilo", "dl:sort_ad_wrong", "dl:sort_menu", "dl:sort_failed", "dl:sort_done", "dl:sort_flow_grasp", "dl:sort_forbid_click"],
      mustHave: "dl:sort_hilo",
      mustNot: ["dl:sort_failed", "dl:sort_ad_wrong", "dl:sort_forbid_click"],
    },
  },
  {
    id: "sort_hover_no_click_loop",
    scene: "list",
    text: "並べ替えは押すループ禁止。①hover並べ替えで下展開 ②hover ADで右に高→低 ③高→低だけclick。ADはメニュー下部まで探す（below560・findAdInOpenMenu）。飛行中の再kick禁止。通常録画scene_flowsも把握。印: sort_flow_grasp／sort_menu_open／sort_ad_found／sort_skip_inflight／sort_forbid_click",
    since: "2.8.247",
    kb: "c349c299",
    marker: "findAdInOpenMenu",
    file: "bulk-dl.js",
    verify: {
      onlyIf: [
        "dl:sort_flow_grasp",
        "dl:sort_menu_open",
        "dl:sort_ad_found",
        "dl:sort_skip_inflight",
        "dl:sort_forbid_click",
        "dl:sort_flow_from_rec",
        "dl:sort_head_hover",
        "dl:sort_ad_hover",
        "dl:sort_hilo",
      ],
      mustHaveAny: [
        "dl:sort_flow_grasp",
        "dl:sort_ad_found",
        "dl:sort_hilo",
        "dl:sort_menu_open",
      ],
      mustNot: ["dl:sort_forbid_click"],
    },
  },
  {
    id: "all_sent_advance_no_stuck",
    scene: "list",
    text: "送付済みのみ／押せるPDF0／次頁無しでも止まらない。all_sent_no_press→_autoFinish→_sendBatchDone一本化→外す→次客。旧 no-rows return と客完了二重送信は廃止。印: all_sent_no_press／all_sent_done／list_no_next_advance",
    since: "2.8.248",
    kb: "9cff6130",
    marker: "all_sent_no_press",
    file: "bulk-dl.js",
    verify: {
      onlyIf: [
        "dl:all_sent_no_press",
        "dl:all_sent_done",
        "dl:all_sent_page",
        "dl:list_no_next_advance",
        "dl:list_page_one_only",
      ],
      mustHaveAny: [
        "dl:all_sent_no_press",
        "dl:all_sent_done",
        "dl:all_sent_page",
        "dl:list_no_next_advance",
      ],
    },
  },
  {
    id: "armed_grasp_no_overwrite",
    scene: "search",
    text: "一連・連携の旧残り廃止。armed_rows／list_visible／sync_pending／pending_armed で markGrasp→finishGate(true) しない。確認把握(screenOk)だけADへ。無い時は armed_wait_screen／list_wait_screen で待つ（把握 why を汚さない）",
    since: "2.8.249",
    kb: "d9480296",
    marker: "armed_wait_screen",
    file: "bulk-dl.js",
    verify: {
      onlyIf: [
        "dl:armed_wait_screen",
        "dl:list_wait_screen",
        "dl:legacy_blocked_no_screen",
        "dl:search_grasp_gate",
      ],
      mustHaveAny: [
        "dl:armed_wait_screen",
        "dl:list_wait_screen",
        "dl:legacy_blocked_no_screen",
        "dl:screen_ok_path",
      ],
      mustNot: [
        "dl:search_grasp_gate:armed_rows",
        "dl:search_grasp_gate:list_visible",
        "dl:search_grasp_gate:sync_pending",
        "dl:search_grasp_gate:pending_armed",
      ],
    },
  },
  {
    id: "pipeline_silence_screen_strengthen",
    scene: "list",
    text: "一連で止まったら画面把握→強化。fill沈黙はfill終了で外れるため、一覧・AD・送付は pipeline_silence で照会・スクショ・最善次手・strengthen_loop を回す。印: pipeline_silence_on／tick／pipeline_screen_grasp／strengthen_loop",
    since: "2.8.250",
    kb: null,
    marker: "pipeline_silence_tick",
    file: "bulk-dl.js",
    verify: {
      onlyIf: [
        "dl:pipeline_silence_tick",
        "dl:pipeline_silence_on",
        "page:pipeline_silence_tick",
        "page:pipeline_screen_grasp",
        "page:strengthen_loop",
      ],
      mustHaveAny: [
        "dl:pipeline_silence_tick",
        "page:pipeline_silence_tick",
        "page:pipeline_screen_grasp",
        "page:strengthen_loop",
        "page:stuck_shot_req",
      ],
    },
  },
  {
    id: "timeout_record_strengthen_bridge",
    scene: "list",
    text: "タイムアウト／長時間沈黙では録画(stuck_shot)→動かす部分強化(strengthen_loop)→次へ橋渡し(timeout_bridge)。一覧固着は bulk が並べ替え／客完了へつなぐ。印: timeout_bridge_on／timeout_bridge_next／timeout_bridge_recv／timeout_bridge_kick／stuck_shot_req",
    since: "2.8.256",
    kb: null,
    marker: "_bridgeTimeoutRecordStrengthen",
    file: "page-script.js",
    verify: {
      onlyIf: [
        "page:timeout_bridge_on",
        "page:timeout_bridge_next",
        "dl:timeout_bridge_recv",
        "dl:timeout_bridge_kick",
        "page:stuck_shot_req",
        "page:strengthen_loop",
      ],
      mustHaveAny: [
        "page:timeout_bridge_on",
        "page:timeout_bridge_next",
        "dl:timeout_bridge_recv",
        "dl:timeout_bridge_kick",
        "page:stuck_shot_req",
      ],
    },
  },
  {
    id: "station_clear_continue_after_stations",
    scene: "clear",
    text: "外しはリセットで空にする（reset_replaces_clear）。駅を外したあとで止めない。沿線へ戻る／reopen／残0なら完了して次の外し（区・町等）へ続行。wrong_screen待ちの無限待機禁止。印: station_clear_continue／station_back_force_try／station_clear_reopen_after／station_clear_back_line",
    since: "2.8.257",
    kb: null,
    marker: "station_clear_continue",
    file: "page-script.js",
    verify: {
      onlyIf: [
        "page:station_clear_cursor",
        "page:station_clear_continue",
        "page:station_back_force_try",
        "page:station_clear_reopen_after",
        "page:station_clear_back_line",
        "page:station_back_wrong_screen",
      ],
      mustHaveAny: [
        "page:station_clear_continue",
        "page:station_clear_back_line",
        "page:station_clear_reopen_after",
        "page:station_back_force_try",
        "page:line_clear_after_station",
      ],
      mustNot: [],
    },
  },
  {
    id: "send_bar_beside_customer_panel",
    scene: "list",
    text: "検索結果（estate）では「物件送る」枠を必ず出す。お客様パネルと重なる時は左隣へ。印: send_bar_show／dock=beside-wrap",
    since: "2.8.258",
    kb: null,
    marker: "_placeSendBarVisible",
    file: "bulk-dl.js",
    verify: {
      onlyIf: ["dl:send_bar_show"],
      mustHaveAny: ["dl:send_bar_show"],
    },
  },
  {
    id: "send_bar_above_customer_panel",
    scene: "list",
    text: "物件送る枠(#axlx-bar)の z-index をお客様パネルより上(…647)。パネルが広い時は左余白不足→画面下(bottom-left)。既存 wrap の MAX z-index は 645 へ下げる。印: send_bar_dock／send_bar_zfix／send_bar_show",
    since: "2.8.260",
    kb: null,
    marker: "send_bar_dock",
    file: "bulk-dl.js",
    verify: {
      onlyIf: ["dl:send_bar_dock", "dl:send_bar_zfix", "dl:send_bar_show"],
      mustHaveAny: ["dl:send_bar_show", "dl:send_bar_dock", "dl:send_bar_zfix"],
    },
  },
  {
    id: "estate_stuck_recover_after_search",
    scene: "list",
    text: "検索結果(estate)に行があるのに並べ替え・送付が進まない固着を検知し、物件送る枠再表示＋並べ替えkick＋steps flush。枠に版表示(vX.Y.Z)。印: estate_stuck_recover／bulk_alive／send_bar_show",
    since: "2.8.261",
    kb: null,
    marker: "estate_stuck_recover",
    file: "bulk-dl.js",
    verify: {
      onlyIf: ["dl:estate_stuck_recover", "dl:bulk_alive"],
      mustHaveAny: ["dl:estate_stuck_recover", "dl:bulk_alive", "dl:send_bar_show", "dl:sort_cursor_go"],
    },
  },
  {
    id: "panel_snap_right_and_send_bar_force",
    scene: "list",
    text: "estateではお客様パネルを右ドックへ戻す（中央放置禁止）。物件送る枠が無い／隠れている時は左下へ強制表示。印: panel_snap_right／send_bar_force／send_bar_missing／send_bar_show",
    since: "2.8.262",
    kb: null,
    marker: "panel_snap_right",
    file: "bulk-dl.js",
    verify: {
      onlyIf: ["dl:panel_snap_right", "dl:send_bar_force", "dl:send_bar_missing"],
      mustHaveAny: ["dl:send_bar_show", "dl:send_bar_force", "dl:panel_snap_right"],
    },
  },
  {
    id: "page_displayed_before_sort",
    scene: "press",
    text: "検索click直前の画面基準を残し、結果ページが表示（変化または押下後settle）されてからだけ並べ替え。旧一覧のdom_inferで先に並べ替えない。検索見直し待ちは短く。印: search_press_baseline／page_display_wait／page_displayed_ok／sort_gate_need_page",
    since: "2.8.263",
    kb: null,
    marker: "_pageDisplayedAfterThisSearch",
    file: "bulk-dl.js",
    verify: {
      onlyIf: [
        "page:search_press_baseline",
        "dl:page_display_wait",
        "dl:page_displayed_ok",
        "dl:sort_gate_need_page",
        "dl:search_press_wait_results",
      ],
      mustHaveAny: [
        "page:search_press_baseline",
        "dl:page_displayed_ok",
        "dl:search_customer_screen_ok",
        "page:search_results_ready",
      ],
    },
  },
  {
    id: "search_nav_pending_light_scan",
    scene: "press",
    text: "検索を押してからリアプロが新しいページへ移るまで（サーバー応答待ち）は古い一覧が残る。この間は結果と認めず並べ替えを始めない（beforeunload で移動中）。新しいページは読み込み完了で結果、同じページは目印（件数・PDF）が変わった時か6秒以上だけ。画面の判定はページ全文を作らない軽い走査。印: page_nav_pending／page_display_wait_load／nav_timing",
    since: "2.8.264",
    kb: null,
    marker: "_isNavPending",
    file: "bulk-dl.js",
    verify: {
      onlyIf: [
        "dl:page_nav_pending",
        "page:page_nav_pending",
        "dl:page_display_wait_load",
      ],
      mustHaveAny: [
        "dl:page_displayed_ok",
        "dl:search_customer_screen_ok",
        "page:search_results_ready",
      ],
    },
  },
  {
    id: "bulk_handoff_watch_resume",
    scene: "switch",
    text: "一括の送付完了の後も、画面（bulk-dl）が15秒ごとに裏へ「いまどの段か」を聞いて枠に出す。裏のループが消えた・段が上限を過ぎて動かない・裏がまだ送付完了を待っている時は、画面が裏へ「次へ進める」を指示する。裏は進み（axlx_bulk_queue）を storage.session に残し、済んだ客の次から同じ関数で続ける。一括中は20秒ごとに裏を起こし続ける。印: bulk_phase／handoff_watch／handoff_kick／bulk_kick",
    since: "2.8.265",
    kb: "613e31d9",
    marker: "_armHandoffWatch",
    file: "bulk-dl.js",
    verify: {
      onlyIf: [
        "dl:handoff_watch_arm",
      ],
      mustHaveAny: [
        "dl:handoff_watch",
        "dl:handoff_watch_end",
        "bulk_phase",
      ],
    },
  },
  {
    id: "bulk_stale_prev_lock", scene: "switch",
    text: "一括で前のお客さんの送付完了まで済んだ後に、そのお客さんの一連の鍵（axlx_pipeline_job）が残っていても、次のお客さんを10分待たせて見送らない。この一括で送付完了まで済んだお客さん（axlx_bulk_queue.sentCids）の鍵だけを古い鍵として外して進む。送付の途中で切れたお客さんの鍵は外さない。印: stale_prev_lock_dropped",
    since: "2.8.266",
    kb: "0f430756",
    marker: "_bulkStaleLockCid",
    file: "background.js",
    verify: {
      onlyIf: [
        "stale_prev_lock_dropped",
      ],
      mustHaveAny: [
        "fill_progress",
        "fill_done",
      ],
    },
  },
  {
    /**
     * ★ 2.8.282 実測 #1640（2026-11-25 13:14・v2.8.281）: 一括が4段のまま41分止まり、finished も error も付かず started で残った。
     *   原因は `chrome.tabs.sendMessage(axlx-switch-customer)` の返事に上限が無く、underbar.js の非同期の返事が来ないと
     *   Promise が永久に解決しないこと（段は autofill＝見回りの進める対象外なので誰も起こさない）。
     */
    id: "bulk_switch_no_forever_wait",
    scene: "switch",
    text: "一括でお客さんを切り替える時（axlx-switch-customer）、返事を30秒で打ち切る。返事が来ない時は「応答が無い」と同じ扱いで1回だけ読み直してやり直し、だめなら地域を決めて直接入力する（永久に待たない）。条件を入れる段が上限を1分過ぎて、ページも入力を始めていない時は、そのお客さんをもう一度回す。印: switch_timeout／autofill_dead_kick",
    since: "2.8.282",
    kb: "613e31d9",
    marker: "_SWITCH_SEND_TIMEOUT_MS",
    file: "background.js",
    verify: {
      mustHaveAny: [
        "switch_timeout",
        "autofill_dead_kick",
        "popup_fallback",
      ],
    },
  },
  {
    /**
     * ★ 2.8.283 竹内さん「1人目が終わると次の人が済んだと誤判定され3人目に飛ぶ」:
     *   続ける位置を「何人目」の番号だけで持つと、引き継がれた古いループの遅れた書き込み・二重の続きで1人飛ぶ。
     *   → 片付いた客の id（handledCids）を別に持ち、続ける位置は未処理の最初の客より先へ行かせない。完了の書き込みは世代確認の後。
     *   最後の客の後は「全件完了」を1通だけ知らせて正常に終わる。
     */
    id: "bulk_no_skip_customer",
    scene: "switch",
    text: "一括で次のお客さんへ続ける位置は、まだ片付いていない最初のお客さんより先へ行かせない（handledCids）。handledCids が無い古いキューは sentCids を片付いた客として同じ上限を掛ける。引き継がれた古いループが遅れて完了を書き戻さない。全員が済んだら『全件完了』を1通だけ知らせて終わる。止めた・引き継いだ回はその場で stopped として閉じ（bulk_ended）、1人ごとの位置を bulk_pos で残す。印: kick_clamp／stale_done_skip／bulk_all_done／bulk_pos",
    since: "2.8.283",
    kb: "a762496e",
    marker: "_bulkClampStart",
    file: "background.js",
    verify: {
      mustHaveAny: [
        "kick_clamp",
        "stale_done_skip",
        "bulk_all_done",
        "bulk_phase",
      ],
    },
  },
  {
    /**
     * ★ 2.8.284 竹内さん「条件はずしはかなりむずかしくバグやエラーが多い。人間のようにリセットボタンに切り替える。
     *   リセット→待機→画面照会→空と確認してから新しいお客さんの拡張ツール API を動かす」＋Ajax の件数待ち・完了小窓を閉じる。
     *   2.8.107 で戻した理由は「入力中の自動がリセットで消えた」＝今回は送付完了の後の1点だけ・入力中は断る・空にならなければ従来の外しへ。
     */
    id: "reset_between_customers",
    scene: "clear",
    text: "送付が終わったら、完了の小窓を閉じてリセットを押し、ページの読み直しを待ち、ラグがあるので30秒以上（2.8.292・30〜34秒・3回に分けて）人の間で待ってから、フォームがすべて空か読み戻して確かめる。該当物件の数（○戸）がリセット前より増えたかは記録（reset_count_same）だけで、空なら増えなくても成功（2.8.307）。空なら写真を1枚撮って（記録のみ）次のお客さんを入れる。押す先は人が押した形（左の「リセット」の文字・幅160×高さ30＝2.8.287）を先に探し、無ければ div.reset_button・文字の順。値は直接書き換えず人の動きで押す。空にならない・押せない時は、スクショと画面把握のうえリセットをもう1回押し（reset_retry_insurance）、それでもだめな時だけ従来の1つずつ外すへ戻る。検索を押す前は Ajax（jQuery.active・読み込み表示・件数の表示）が落ち着くのを最大5秒待つ。人がリセットを押した時（拡張の押下と分けて人の押下だけ）も拡張が把握し、その画面の自動を止めて一覧を押さず、次のお客さんの条件入力はそこから30秒以上あける（2.8.294）。印: reset_press（押した先）／reset_wait／reset_verified／reset_shot／reset_not_empty／reset_fallback／ajax_settle／human_reset_press／human_reset_wait",
    since: "2.8.284",
    kb: "265a1cca",
    marker: "_postSendResetRealpro",
    file: "background.js",
    verify: {
      mustHaveAny: [
        "reset_press",
        "reset_verified",
        "reset_not_empty",
        "reset_fallback",
      ],
    },
  },
  {
    /**
     * ★ 2.8.295 竹内さん「並べ替えやリセット、そして新しいお客さんの条件を拡張ツールのAPIから入れなおすところのあいだで
     *   別の作業入って邪魔されないように」→ 邪魔しない窓（axlx_quiet）1つで3つの間を守る。
     */
    id: "quiet_window_no_interrupt",
    scene: "switch",
    text: "並べ替え（検索確認→30〜36秒→並べ替え→読み直し→押し始め）・リセット（送付後のリセット→30秒以上の待機→空の確認）・次のお客さんまでの間・次客の条件入力（fill-done まで）の間は、邪魔しない窓（1つの印・上限で必ず切れる）を立てる。窓の間は、ウェブアプリからの別のお客さんの検索・すぐ拾う指示・写真のためのタブ切替・「検索条件を表示」の押し直し・並べ替え中の案内の戻し・前の回の続きの印を見送り、見送った事を点検に残す。並べ替えの待ちは見張りが固着と取り違えない（待ちの印が古い時だけ外して張り直す）。前客の入力待ちの間は同じ客をもう1本回さない。裏が起き直してリセットの途中で切れた時は、次の回がリセットから30秒以上待ってから条件を入れる。印: quiet_on／quiet_off／quiet_defer／quiet_inherit／reset_clear_marks／dl:sort_wait_stale_reset",
    since: "2.8.295",
    kb: null,
    marker: "_quietSet(\"reset\"",
    file: "background.js",
    verify: {
      onlyIf: ["reset_press"],
      mustHaveAny: ["quiet_on", "dl:quiet_on"],
    },
  },
  {
    /**
     * ★ 2.8.296 竹内さん「何で次のお客さんの条件入れる前にリセットおしていないのか」→「昔の外す部分がボトルネックでリセットを押しに行っていない」
     *   実測（監査 #1654・#1656）: リセットは送付が終わった客の後だけ。前客が0件・時間切れ／一括の最初の客／裏が起き直した回は
     *   リセットの段が無く、ページ側の古い「1つずつ外す」（58秒・やり直し2回）で入力に入っていた。
     */
    id: "reset_before_fill",
    scene: "clear",
    text: "一括の各お客さんの条件を入れる前に、必ずページが空かを読み戻して確かめる。空ならリセットは押さない（二重に押さない）。空でなければリセットを押し、30秒以上の人の間で待ってから空を確かめる（送付後のリセットと同じ手順・邪魔しない窓 reset）。入力の最中は押さない。押せない・空にならない時だけページ側の従来の1つずつ外すへ任せる。印: reset_before_fill（すでに空／空でない→押す／空にできず）",
    since: "2.8.296",
    kb: null,
    marker: "_resetBeforeFill(",
    file: "background.js",
    verify: {
      onlyIf: ["bulk_pos"],
      mustHaveAny: ["reset_before_fill"],
    },
  },
  {
    id: "sort_head_recover_no_table_scroll",
    scene: "list",
    text: "並べ替えは head=Y になるまで待つ（wait_head）。表 scrollIntoView 禁止。見出し0は scroll0・ドック退避・DOM合成aim・elementFromPoint。棟戸 under も見出し候補。印: sort_gate_wait_head／sort_head_scroll0／sort_head_recover／sort_head_point／sort_head_hover",
    since: "2.8.259",
    kb: null,
    marker: "sort_gate_wait_head",
    file: "bulk-dl.js",
    verify: {
      onlyIf: [
        "dl:sort_no_head",
        "dl:sort_gate_wait_head",
        "dl:sort_head_scroll0",
        "dl:sort_head_recover",
        "dl:sort_panel_clear",
        "dl:sort_head_hover",
        "dl:sort_head_point",
      ],
      mustHaveAny: [
        "dl:sort_head_hover",
        "dl:sort_head_recover",
        "dl:sort_head_point",
        "dl:sort_done",
        "dl:sort_gate_wait_head",
      ],
    },
  },
  {
    id: "station_grasp_like_guide",
    scene: "area",
    text: "自動・AIXでも通常案内と同じく、指定駅（primary_stations）と指定沿線（primary_route_ids）を先にそろえてから沿線→駅を選ぶ。案内だけが光って自動が弱い状態にしない",
    since: "2.8.161",
    kb: "fd2ac6ad",
    marker: "_applyGuideLikeStationGrasp",
    file: "page-script.js",
    verify: {
      onlyIf: ["page:station_grasp_like_guide", "page:station_route_from_map", "page:station_no_route"],
      mustHaveAny: ["page:station_grasp_like_guide", "page:station_route_from_map"],
      mustNot: ["page:station_no_route"],
    },
  },
  {
    id: "guide_plan_link",
    scene: "area",
    text: "通常の光る把握と同じ手順表（realpro-guide-plan）を自動の page にも載せ、未了欄と指定駅の次手を同じ土台で読む。学習位置が薄い時でも条件→手順表→画面の今で把握する",
    since: "2.8.162",
    kb: "8cc85478",
    marker: "_guideLikeFormGrasp",
    file: "page-script.js",
    verify: {
      onlyIf: ["page:guide_plan_linked", "page:guide_plan_miss"],
      mustHave: "page:guide_plan_linked",
      mustNot: ["page:guide_plan_miss"],
    },
  },
  {
    id: "guide_clear_fill_gate",
    scene: "clear",
    text: "【外しの部分は、リセットで空と確かめられた回は行わない（reset_replaces_clear）。入れる側の「1つずつ」は今まで通り】外す時も入れる時も、手順表×画面照合で入れ忘れ・外し忘れを言葉にする。同種の場所（駅→駅）でも続き客は前客を外す。検索前に1回直してから conditions_ready",
    since: "2.8.163",
    kb: "ad1e1176",
    marker: "_guideLikeClearGrasp",
    file: "page-script.js",
    verify: {
      onlyIf: ["page:guide_clear_grasp", "page:guide_fill_gate"],
      mustHaveAny: ["page:guide_clear_grasp", "page:guide_fill_gate"],
    },
  },
  {
    id: "guide_list_next_flow",
    scene: "list",
    text: "一覧・次ページも手順書の list/next 場面と画面（行・次ボタン・AD順）を照合してから進む。条件モーダル（駅・沿線・所在地）中は並べ替え／送付しない（照合NGで止める）。AD後も次ページへ。客完了時 handoff を残し、次客の切替で flow_handoff_ok / ready_next として読む",
    since: "2.8.170",
    kb: "b3b5e14c",
    marker: "_guideLikeListFlowGrasp",
    file: "bulk-dl.js",
    verify: {
      onlyIf: ["dl:list_flow_grasp", "dl:next_flow_grasp", "dl:handoff_grasp", "flow_handoff_ok", "dl:list_flow_block", "dl:sort_blocked", "dl:sort_abort"],
      mustHaveAny: ["dl:list_flow_grasp", "dl:next_flow_grasp", "dl:handoff_grasp", "flow_handoff_ok", "dl:list_flow_block", "dl:sort_blocked", "dl:sort_abort"],
    },
  },
  {
    id: "guide_phase_checkpoints",
    scene: "area",
    text: "手順表×画面照合を外し完了直後（after_clear・外忘れだけ）・確定してリストへ閉じた後（after_confirm・入れた1つずつ）・駅後・地域後・場所後・検索前・検索押下後（after_search→AD並び替え前）で1つずつ行う。次客は通常リセット（reset_between_customers）→空の確認→新条件。最後の保険で外す時だけ（reset_fallback）外し→きれい確認→外し忘れ1つずつ→新条件。抜けは guide_phase_one。駅0・区0は次へ進まない。検索把握なしではAD並び替えしない",
    since: "2.8.177",
    kb: "530bb1f3",
    marker: "_guideLikeAfterConfirmCheck",
    file: "page-script.js",
    verify: {
      onlyIf: ["page:guide_phase_after_clear", "page:guide_phase_after_confirm", "page:guide_phase_after_station", "page:guide_phase_after_area", "page:guide_phase_after_place", "page:guide_phase_before_search", "page:guide_phase_after_search", "page:guide_phase_one", "page:guide_phase_ok", "page:guide_phase_gap", "page:guide_phase_block", "dl:search_grasp_gate", "dl:sort_blocked"],
      mustHaveAny: ["page:guide_phase_after_clear", "page:guide_phase_after_confirm", "page:guide_phase_after_station", "page:guide_phase_after_area", "page:guide_phase_after_place", "page:guide_phase_before_search", "page:guide_phase_after_search", "page:guide_phase_one", "page:guide_phase_ok", "dl:search_grasp_gate"],
    },
  },
  {
    id: "flow_series_grasp",
    scene: "press",
    text: "外しはリセットで空にする（reset_replaces_clear）。手順書の一連の流れ（flow_series: 外し→確定→場所→検索→一覧→次→次客）を段ごとに把握する。各段で page:flow_series_at を残し、場面の並びだけ見て流れ完了としない。検索把握なしでは一覧ADへ進まない",
    since: "2.8.182",
    kb: "38ed0d15",
    marker: "_noteFlowSeriesAt",
    file: "page-script.js",
    verify: {
      onlyIf: ["page:flow_series_at", "page:flow_series_ok", "page:flow_series_gap"],
      mustHaveAny: ["page:flow_series_at", "page:flow_series_ok"],
    },
  },
  {
    id: "flow_series_order_gate",
    scene: "clear",
    text: "外しはリセットで空にする（reset_replaces_clear）。拡張が一連の順番を徹底理解する。客開始で flow_series_plan（何段・何順）を残し、各段で flow_series_order（N/M）を言う。前段抜けは flow_series_gap。before_clear 無しで after_clear／入れへ進まない（_requireFlowSeriesUpTo）",
    since: "2.8.210",
    kb: "d45560bf",
    marker: "_graspFlowSeriesOrder",
    file: "page-script.js",
    verify: {
      onlyIf: ["page:flow_series_plan", "page:flow_series_order", "page:flow_series_gap", "page:leftover_scan"],
      mustHaveAny: ["page:flow_series_plan", "page:flow_series_order", "page:flow_series_at"],
    },
  },
  {
    id: "continuous_customer_loop",
    scene: "switch",
    text: "外しはリセットで空にする（reset_replaces_clear）。連続客は外す→客ごと思考→入れる→検索→送付→送付後外し→次客可を1人ずつ完了してから次へ。失敗でも customer_think／post_send_clear／handoff_loop の印を残す（測れない穴を作らない）",
    since: "2.8.205",
    kb: "0a5b99dd",
    marker: "_refreshCustomerThink",
    file: "background.js",
    verify: {
      onlyIf: ["customer_think", "post_send_clear", "handoff_loop", "handoff_atom_post_send", "series_done"],
      mustHaveAny: ["customer_think", "post_send_clear", "handoff_loop", "series_done"],
    },
  },
  {
    id: "clear_then_fill_gate",
    scene: "clear",
    text: "リセット（または最後の保険の外し）のあと、clear_done → guide_phase_after_clear（台帳×画面）→ clear_then_fill_ok で新条件の入れへ。空でなければ clear_then_fill_gap→リセットを再実行（保険の外しの時は外し再実行）。完了後は next_move_grasp（新条件を1つずつ入れる）で次へ移行する。所在地だけ空にして fill に進まない／完了扱いにしない",
    since: "2.8.208",
    kb: "98581439",
    marker: "clear_then_fill_ok",
    file: "page-script.js",
    verify: {
      onlyIf: ["page:clear_done", "page:guide_phase_after_clear", "page:switch_grasp"],
      mustHaveAny: ["page:clear_then_fill_ok", "page:clear_then_fill_gap", "page:fill_start", "page:leftover_clean", "page:next_move_grasp"],
    },
  },
  {
    id: "one_task_complete_before_next",
    scene: "clear",
    text: "外しはリセットで空にする（reset_replaces_clear）。1つずつタスク完了してから次へ。before_clear未達でclear_then_fillに進まない（印だけ補完禁止）。未達ならguide_clearで把握し直し→再関所。dirtyなら再外し。完了時one_task_done。未完了はone_task_incomplete／one_task_gate_block",
    since: "2.8.225",
    kb: "6a1a665b",
    marker: "one_task_gate_block",
    file: "page-script.js",
    verify: {
      onlyIf: [
        "page:one_task_gate_block",
        "page:one_task_done",
        "page:one_task_incomplete",
        "page:clear_then_fill_ok",
        "page:flow_series_gap",
        "page:flow_series_order",
      ],
      mustHaveAny: [
        "page:one_task_done",
        "page:one_task_gate_block",
        "page:one_task_incomplete",
        "page:clear_then_fill_ok",
        "page:clear_then_fill_gap",
        "page:flow_series_order",
      ],
    },
  },
  {
    id: "samekind_clear_before_fill",
    scene: "clear",
    text: "外しはリセットで空にする（reset_replaces_clear）。同種（駅→駅・地域→地域）でも先に外す。入れ直しだけで飛ばさない。台帳のみ残も memOnly で小窓を開く。フォーム展開後 leftover_rescan_after_form。前客cid違いの同種は ForceClearSameKind。要約は『同種でも先に外す』",
    since: "2.8.220",
    kb: "6fa718ba",
    marker: "sameKindMustClear",
    file: "page-script.js",
    verify: {
      onlyIf: ["page:leftover_scan", "page:force_clear_place", "page:leftover_rescan_after_form"],
      mustHaveAny: [
        "page:leftover_scan",
        "page:leftover_rescan_after_form",
        "page:leftover_force_same_stations",
        "page:leftover_force_same_wards",
        "page:force_clear_place",
        "page:clear_then_fill_ok",
      ],
    },
  },
  {
    id: "next_customer_move_one_by_one",
    scene: "search",
    text: "【外しの部分は、リセットで空と確かめられた回は行わない（reset_replaces_clear）。入れる側の「1つずつ」は今まで通り】次のお客さんと次の動きを把握してから進む。fill開始で next_customer_grasp／next_move_grasp／guide_phase_one。家賃など条件は _runBasicOneByOne で cond_one_grasp→1欄→cond_one_ok（同時に次欄へ飛ばない）。外しも名前付き1つずつ（clear_detail_grasp・3f4749d9）",
    since: "2.8.219",
    kb: "3f4749d9",
    marker: "_graspNextCustomerAndMove",
    file: "page-script.js",
    verify: {
      onlyIf: ["page:fill_start", "page:now_customer", "page:cond_one_grasp", "page:next_customer_grasp"],
      mustHaveAny: ["page:next_customer_grasp", "page:next_move_grasp", "page:cond_one_ok", "page:guide_phase_one"],
    },
  },
  {
    id: "customer_loop_one_by_one",
    scene: "search",
    text: "外しはリセットで空にする（reset_replaces_clear）。物件取得完了→外す→新条件入れ→検索→並び替え→物件取得→次客を1段ずつ理解する。loop_phase_grasp／loop_who_grasp／loop_task_list／loop_advanceでいま客・次客・いま段・次段・タスク一覧・完了→次へを残す。並べ替えもループ段。BG一括もseries_done後にloop_advance。手順書flow_seriesにclear_then_fillを含む",
    since: "2.8.222",
    kb: "62c86c80",
    marker: "_graspCustomerLoopPhase",
    file: "page-script.js",
    verify: {
      onlyIf: ["page:loop_phase_grasp", "page:loop_who_grasp", "page:loop_task_list", "page:loop_advance", "page:next_customer_grasp", "page:flow_done_ready_next", "dl:handoff_grasp", "dl:loop_phase_req"],
      mustHaveAny: [
        "page:loop_phase_grasp",
        "page:loop_who_grasp",
        "page:loop_task_list",
        "page:loop_advance",
        "page:next_customer_grasp",
        "page:next_move_grasp",
        "page:flow_series_at",
        "dl:handoff_grasp",
        "dl:loop_phase_req",
        "loop_advance",
      ],
    },
  },
  {
    id: "loop_sort_grasp_and_cursor_keep",
    scene: "list",
    text: "並べ替えはループの1タスク。sort開始でloop_phase_grasp(sort)／next_move／sort_ad。完了でlist段。飛行中cancelは今座標を残し中心からやり直さない（cursor_resume／pointer_cancel）。完了してから次タスクへ",
    since: "2.8.226",
    kb: "6c008add",
    marker: "axlx-loop-phase-req",
    file: "bulk-dl.js",
    verify: {
      onlyIf: ["dl:sort_menu", "dl:loop_phase_req", "page:loop_phase_grasp", "dl:sort_done", "dl:sort_abort", "page:cursor_resume", "dl:pointer_cancel"],
      mustHaveAny: [
        "dl:loop_phase_req",
        "page:loop_phase_grasp",
        "page:loop_task_list",
        "page:next_move_grasp",
        "dl:sort_done",
        "page:one_task_done",
        "dl:pointer_cancel",
        "page:cursor_resume",
      ],
    },
  },
  {
    id: "now_action_clear_then_fill",
    scene: "clear",
    text: "外しはリセットで空にする（reset_replaces_clear）。いまの行動をパネルに出す。外している最中なら『外す』、終わったら『新しい条件を入れる』。同一客・初回きれいでForceClear全部外しループを回さない（place_keep）。客切替・残・送付後ギャップの時だけ外す",
    since: "2.8.227",
    kb: "f1ceec94",
    marker: "_publishNowAction",
    file: "page-script.js",
    verify: {
      onlyIf: ["page:now_action", "page:place_keep", "page:place_redo", "page:leftover_scan"],
      mustHaveAny: [
        "page:now_action",
        "page:place_keep",
        "page:place_redo",
        "page:next_move_grasp",
        "page:loop_phase_grasp",
      ],
    },
  },
  {
    id: "task_grasp_now_done_next",
    scene: "clear",
    text: "外しはリセットで空にする（reset_replaces_clear）。1つ1つのタスクで『いま行っている／完了した／次に必要な動き』を把握する。外す（間取り含む）も入れるも task_now→task_done→task_next。箱ごと（間取り→ペット→区）に完了してから次へ。完了していないのに次へ進まない（one_task と併用）",
    since: "2.8.228",
    kb: "e7082bae",
    marker: "_publishTaskGrasp",
    file: "page-script.js",
    verify: {
      onlyIf: [
        "page:task_now",
        "page:task_done",
        "page:task_next",
        "page:clear_one",
        "page:clear_stage",
        "page:cond_one_grasp",
        "page:one_task_done",
      ],
      mustHaveAny: [
        "page:task_now",
        "page:task_done",
        "page:task_next",
        "page:one_task_done",
        "page:next_move_grasp",
        "page:now_action",
        "page:clear_one_done",
        "page:cond_one_ok",
      ],
    },
  },
  {
    id: "clear_method_api_grasp_transition",
    scene: "clear",
    text: "外しはリセットで空にする（reset_replaces_clear）。次タスクへ移る前に、API手順書（human-learn-profile束の外し方・flow_series）で外し方を把握する。検索のsearch_graspと同型で session＋axlx-task-grasped に残す。clear_method_ledgerで外し方理解を測り、薄い時はclear_method_gap。外し完了→入れはtask_transition_graspを残してから進む",
    since: "2.8.229",
    kb: "3c9d1894",
    marker: "_graspClearMethodFromPlaybook",
    file: "page-script.js",
    verify: {
      onlyIf: [
        "page:clear_method_api_grasp",
        "page:clear_method_api_miss",
        "page:clear_method_ledger",
        "page:task_transition_grasp",
        "page:leftover_scan",
        "page:clear_then_fill_ok",
        "dl:task_transition_grasp",
      ],
      mustHaveAny: [
        "page:clear_method_api_grasp",
        "page:clear_method_ledger",
        "page:clear_method_ok",
        "page:clear_method_gap",
        "page:task_transition_grasp",
        "page:next_move_grasp",
        "dl:task_transition_grasp",
      ],
    },
  },
  {
    id: "task_api_refresh_before_next",
    scene: "clear",
    text: "【外しの部分は、リセットで空と確かめられた回は行わない（reset_replaces_clear）。入れる側の「1つずつ」は今まで通り】次のタスクへ行く前に、手順書が薄い・無い時は human-learn-profile をAPI取込してから把握する（検索前の束取込と同型）。_graspBeforeNextTaskThen が関所。外し→入れは取込→把握→task_transition_gate を残してから進む。場所完了・条件完了・入れ開始／完了・次客渡しも弱い段として同じAPI把握を行う。把握弱くても印付きで進む（search_grasp_infer 同型）",
    since: "2.8.230",
    kb: "64f4da9d",
    marker: "_graspBeforeNextTaskThen",
    file: "page-script.js",
    verify: {
      onlyIf: [
        "page:task_api_refresh",
        "page:task_transition_gate",
        "page:task_transition_gate_weak",
        "page:task_transition_grasp",
        "page:clear_then_fill_ok",
        "page:fill_start",
        "page:place_ready",
        "page:conditions_ready",
      ],
      mustHaveAny: [
        "page:task_transition_gate",
        "page:task_transition_gate_weak",
        "page:task_api_refresh",
        "page:task_transition_grasp",
        "page:next_move_grasp",
        "page:clear_method_api_grasp",
        "page:clear_method_ledger",
      ],
    },
  },
  {
    id: "guide_phase_task_link",
    scene: "search",
    text: "【外しの部分は、リセットで空と確かめられた回は行わない（reset_replaces_clear）。入れる側の「1つずつ」は今まで通り】手順書×画面照会（guide_phase）の各段完了を、必ず task_now／task_done／task_next に落とす。照合だけの印で止めない。場所後・所在地・駅・検索前・外し後・検索後・一覧（list_start/before_next/after_next/handoff）で guide_task_link を残し、次にすることを同時に把握する",
    since: "2.8.231",
    kb: "0b023093",
    marker: "_linkGuidePhaseToTask",
    file: "page-script.js",
    verify: {
      onlyIf: [
        "page:guide_phase_ok",
        "page:guide_phase_after_place",
        "page:guide_phase_before_search",
        "page:guide_phase_after_search",
        "page:guide_phase_after_clear",
        "dl:list_flow_grasp",
        "page:guide_task_link",
        "dl:guide_task_link",
      ],
      mustHaveAny: [
        "page:guide_task_link",
        "page:task_now",
        "page:task_done",
        "page:task_next",
        "page:next_move_grasp",
        "dl:guide_task_link",
        "dl:list_flow_grasp",
      ],
    },
  },
  {
    id: "task_change_api_every",
    scene: "clear",
    text: "タスク段が変わるたびに拡張は human-learn-profile API取込経路を必ず通す（手元に手順書があっても飛ばさない）。BGゲートが新鮮なら skipped でも印 task_api_refresh を残す。幹段（clear_then_fill・fill_start・handoff・clear）は force、他は soft。取込後に把握→task_transition_gate→次へ。手順照合(guide_task_link)のあとも同じThenで次につながる",
    since: "2.8.232",
    kb: "c87e11d3",
    marker: "_graspBeforeNextTaskThen",
    file: "page-script.js",
    verify: {
      onlyIf: [
        "page:task_api_refresh",
        "page:task_api_refresh_res",
        "page:task_transition_gate",
        "page:task_transition_gate_weak",
        "page:guide_task_link",
        "page:clear_then_fill_ok",
        "page:place_ready",
        "page:fill_start",
      ],
      mustHaveAny: [
        "page:task_api_refresh",
        "page:task_api_refresh_res",
        "page:task_transition_gate",
        "page:task_transition_gate_weak",
        "page:task_transition_grasp",
        "page:next_move_grasp",
      ],
    },
  },
  {
    id: "search_before_sort_next_guard",
    scene: "search",
    text: "検索確認（search_grasped confirmed／search_press_ok）前は nextMove＝並べ替えを出さない。conditions_done・place_done 等のタスク切替は段ごとの正しい次（検索を押す等）を強制し、前段の stale な並べ替えを persist しない。拒否時は印 next_move_premature_block。根本は表面文言ではなく関所＋段正本",
    since: "2.8.233",
    kb: "54dfb836",
    marker: "_guardNextMove",
    file: "page-script.js",
    verify: {
      onlyIf: [
        "page:conditions_ready",
        "page:place_ready",
        "page:task_transition_grasp",
        "page:next_move_grasp",
        "page:next_move_premature_block",
        "dl:next_move_premature_block",
      ],
      mustHaveAny: [
        "page:next_move_premature_block",
        "page:search_press_ok",
        "page:guide_phase_after_search",
        "page:next_move_grasp",
        "dl:next_move_premature_block",
      ],
    },
  },
  {
    id: "list_one_page_grasp_advance",
    scene: "list",
    text: "一覧が1ページのみの時は『1ページのみ』と把握し、次ページを押すで止まらない。td.pagerの数字が1つだけ／次にonclick無し＝最終。物件を見終わったら次＝物件取得完了→外す（handoff）。印 list_page_one_only／list_no_next_advance。見た目の『次』セルに騙されない",
    since: "2.8.234",
    kb: "1522940d",
    marker: "_readPagerState",
    file: "bulk-dl.js",
    verify: {
      onlyIf: [
        "dl:list_flow_grasp",
        "dl:next_flow_grasp",
        "dl:list_page_one_only",
        "page:list_page_one_only",
        "dl:list_no_next_advance",
        "dl:list_flow_grasp",
      ],
      mustHaveAny: [
        "dl:list_page_one_only",
        "page:list_page_one_only",
        "dl:list_no_next_advance",
        "dl:handoff_grasp",
        "page:task_next",
        "dl:next_flow_grasp",
      ],
    },
  },
  {
    id: "continuous_series_next_grasp",
    scene: "clear",
    text: "外しはリセットで空にする（reset_replaces_clear）。一連（外す→入れ→検索→取得）完了から次客へ移る時は必ず loop_advance＋loop_who_grasp＋next_customer_grasp＋next_move_grasp を残す。series_done だけ残して次客把握が欠ける抜けを禁止。取得完了は _stampSeriesToNextCustomer／axlx-series-handoff。fill一連の series_done 経路でも同型印",
    since: "2.8.235",
    kb: "cccd00ca",
    marker: "_stampSeriesToNextCustomer",
    file: "bulk-dl.js",
    verify: {
      onlyIf: [
        "page:loop_advance",
        "dl:loop_advance",
        "page:loop_who_grasp",
        "dl:loop_who_grasp",
        "page:next_customer_grasp",
        "dl:handoff_grasp",
        "page:next_move_grasp",
      ],
      mustHaveAny: [
        "page:loop_advance",
        "dl:loop_advance",
        "page:loop_who_grasp",
        "dl:loop_who_grasp",
        "page:next_move_grasp",
        "page:next_customer_grasp",
        "dl:handoff_grasp",
      ],
    },
  },
  {
    id: "screen_poll_instead_of_timeout",
    scene: "press",
    text: "盲目のタイムアウト打ち切りを禁止。待ちのあいだ時間をあけて画面照会（screen_poll_grasp）し、切れ／fill_timeout時は画面で詰まり理由を把握→API取込→next_move_graspしてから次へ／諦める（_screenPollThenApiNext）。timeoutOnlyで画面印0の抜けを止める",
    since: "2.8.236",
    kb: "27e91369",
    marker: "_screenPollThenApiNext",
    file: "page-script.js",
    verify: {
      onlyIf: [
        "page:screen_poll_grasp",
        "page:screen_poll_api_next",
      ],
      mustHaveAny: [
        "page:screen_poll_grasp",
        "page:screen_poll_api_next",
      ],
    },
  },
  {
    id: "screen_task_grasp_every_transition",
    scene: "switch",
    text: "画面照会はスクショVisionではない。3層: A=DOM照会（guide_phase/screen_poll/screen_task_grasp）B=API手順書取込（task_api_refresh）C=スクショは学習用。タスク切替ごとに必ずA→B（_graspBeforeNextTaskThenがscreen_task_graspを先に残す）",
    since: "2.8.237",
    kb: "27e91369",
    marker: "screen_task_grasp",
    file: "page-script.js",
    verify: {
      onlyIf: [
        "page:screen_task_grasp",
        "page:task_api_refresh",
        "page:screen_poll_grasp",
      ],
      mustHaveAny: [
        "page:screen_task_grasp",
        "page:task_api_refresh",
      ],
    },
  },
  {
    id: "stuck_shot_then_best_act",
    scene: "press",
    text: "タイムアウト／詰まり時はスクショ依頼（stuck_shot_req）＋DOM原因把握→API→拡張が最善次手を1回実行（stuck_best_act）。回復できたら再試行（stuck_recover_retry）。印だけで同じ失敗に落ちる抜けを禁止",
    since: "2.8.238",
    kb: "b152f03b",
    marker: "_actBestNextFromStuck",
    file: "page-script.js",
    verify: {
      onlyIf: [
        "page:stuck_shot_req",
        "page:stuck_best_act",
        "page:stuck_recover_retry",
        "page:screen_poll_api_next",
      ],
      mustHaveAny: [
        "page:stuck_shot_req",
        "page:stuck_best_act",
      ],
    },
  },
  {
    id: "clear_stuck_watch_use_improvements",
    scene: "clear",
    text: "外しはリセットで空にする（reset_replaces_clear）。外している最中で止まっても画面照会・スクショ・最善次手を使う。結果一覧でも外し中はlistよりform/残りを優先（誤診list_ready空振り禁止）。残カウントはstation_id[]/route_id[]。外し段はsilence_watch（旧clear_watch）で定期に照会→次手",
    since: "2.8.239",
    kb: "079c57d5",
    marker: "_armClearStuckWatch",
    file: "page-script.js",
    verify: {
      onlyIf: [
        "page:silence_watch_on",
        "page:silence_watch_tick",
        "page:stuck_best_act",
        "page:screen_poll_api_next",
        "page:now_action",
      ],
      mustHaveAny: [
        "page:silence_watch_on",
        "page:silence_watch_tick",
        "page:stuck_best_act",
      ],
    },
  },
  {
    id: "search_results_before_ad_sort",
    scene: "press",
    text: "検索ボタン押下だけではAD並び替えに進まない。結果画面の変化（screenOk）を確認してから並べ替え。押下直後のつぎは「検索結果の表示を待つ」。条件完了→検索はAPI待ちで止めない",
    since: "2.8.240",
    kb: "56189e63",
    marker: "search_results_ready",
    file: "page-script.js",
    verify: {
      onlyIf: [
        "page:search_results_ready",
        "page:search_press_wait_results",
        "page:next_move_premature_block",
        "dl:search_press_wait_results",
        "dl:search_customer_screen_ok",
      ],
      mustHaveAny: [
        "page:search_results_ready",
        "page:search_press_wait_results",
        "dl:search_press_wait_results",
        "dl:search_customer_screen_ok",
      ],
    },
  },
  {
    id: "silence_stuck_watch_and_flush",
    scene: "press",
    text: "沈黙停止でも全段で定期に画面照会→スクショ→最善次手。武装済みは計をリセットしない。3回未回復で次タスク、6回で次客。沈黙tickごとにsteps強制flush",
    since: "2.8.242",
    kb: "d2f56bec",
    marker: "_forceAuditStepsFlush",
    file: "page-script.js",
    verify: {
      onlyIf: [
        "page:silence_watch_on",
        "page:silence_watch_keep",
        "page:silence_watch_tick",
        "page:silence_task_advance",
        "page:silence_stuck_escalate",
        "page:stuck_shot_req",
        "page:stuck_best_act",
      ],
      mustHaveAny: [
        "page:silence_watch_on",
        "page:silence_watch_tick",
        "page:silence_task_advance",
        "page:stuck_shot_req",
      ],
    },
  },
  {
    id: "stale_grasp_invalidate_fresh_only",
    scene: "press",
    text: "古い検索把握印（TTL切れ・旧pageVer・別客・薄い上書き残骸）は使わず捨てる。fill開始で必ずinvalidate。live-flushは完全な印を薄い{at,why}で上書きしない",
    since: "2.8.241",
    kb: "4e466a5c",
    marker: "_invalidateStaleSearchGrasp",
    file: "page-script.js",
    verify: {
      onlyIf: [
        "page:stale_grasp_drop",
        "dl:stale_grasp_drop",
        "page:silence_watch_on",
      ],
      mustHaveAny: [
        "page:stale_grasp_drop",
        "dl:stale_grasp_drop",
      ],
    },
  },
  {
    id: "post_send_clear_grasp",
    scene: "clear",
    text: "客完了→次へ。先に送付後のリセット（reset_between_customers）を押して空と確かめる（reset_replaces_clear）。リセットで空なら送付後外しはやらない。リセットが押せない・空にならない時だけ送付後外しを実行し把握する。post_send_clear開始でguide_clear_grasp／loop_phase。skippedを外しOKと偽らない。未完了はpost_send_clear_gap＋次客で強制外す。取得完了はlist_done→clear（fillと誤らない）。leftover_scan開始でもclear段を把握",
    since: "2.8.224",
    kb: "366a97cd",
    marker: "__axlxPostSendClearP",
    file: "page-script.js",
    verify: {
      onlyIf: ["post_send_clear", "page:post_send_clear", "page:guide_clear_grasp", "page:loop_phase_grasp", "page:leftover_scan"],
      mustHaveAny: [
        "post_send_clear",
        "page:post_send_clear",
        "page:guide_clear_grasp",
        "page:next_move_grasp",
        "page:loop_phase_grasp",
        "post_send_clear_gap",
        "handoff_atom_post_send",
        "dl:handoff_grasp",
      ],
    },
  },
  {
    id: "clear_detail_grasp",
    scene: "clear",
    text: "リセットの前にも、外すのと同じ細かさで台帳×画面の残りを名前付きで1つずつ言う（guide_clear_grasp／guide_phase_one）。件数の「残:区・町」だけで終わらない。リセット後（空の読み戻し）も名前付きで残0を確かめてから入れへ。最後の保険で外す時（reset_fallback・リセットが押せない・空にならない時だけ）も、外す前後に同じ名前付きの確認をする",
    since: "2.8.209",
    kb: null,
    marker: "_listLeftoverNamedItems",
    file: "page-script.js",
    verify: {
      onlyIf: ["page:guide_clear_grasp", "page:guide_clear_detail", "page:leftover_scan"],
      mustHaveAny: ["page:guide_clear_grasp", "page:guide_clear_detail", "page:guide_phase_one", "page:guide_clear_clean"],
    },
  },
  {
    id: "place_xor_grasp",
    scene: "area",
    text: "所在地絞り込みと沿線・駅絞り込みは並行して入れない（どちらか一方）。fill開始で place_xor_plan、決定後 place_xor で1本把握し負け軸を消す。検索前 place_xor_gate。混在は place_xor_violation／関所エラー",
    since: "2.8.215",
    kb: "55b31a4a",
    marker: "_axApplyPlaceXor",
    file: "page-script.js",
    verify: {
      onlyIf: ["page:place_xor", "page:place_xor_plan", "page:location", "page:place_mixed", "page:place_xor_gate"],
      mustHaveAny: ["page:place_xor", "page:place_xor_plan", "page:location"],
    },
  },
  {
    id: "learn_reflect_before_reset",
    scene: "switch",
    text: "検索画面での自動入力は、まず最新の学習束・手順書（_ensureLearnReflectedForFill）を取り込み・反映し終えてから _doReset（前客クリア）へ進む。取り込みとリセットを並走させない",
    since: "2.8.312",
    kb: null,
    marker: "_startResetAfterReflect",
    file: "page-script.js",
    verify: {
      onlyIf: ["page:learn_reflect_gate", "page:fill_start"],
      mustHaveAny: ["page:learn_reflect_gate", "page:learn_reflect_ok", "page:learn_reflect_gap"],
    },
  },
  {
    id: "notify_done_clears_queue",
    scene: "press",
    text: "完了・エラー・門止めの notifyDone が呼ばれた瞬間、残りのクリックキュー（clearClickQueue）を必ず破棄して停止後の誤クリックや遅れ発火を根絶する",
    since: "2.8.312",
    kb: null,
    marker: `if (typeof clearClickQueue === "function") clearClickQueue();`,
    file: "page-script.js",
    verify: {
      onlyIf: ["fill_done"],
      mustHaveAny: ["fill_done"],
    },
  },
];

/** FNV-1a（32bit）の16進（版の印・暗号ではない） */
export function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 決まりの版（id と文が変われば変わる）。手順書と拡張の点検記録で突き合わせる */
export function autoRulesVersion(rules: ReadonlyArray<AutoRule> = AUTO_RULES): string {
  // 2.8.302: 見直しの印（AUTO_RULES_REVIEWED_UP_TO）も指紋に入れる。印だけ上げても手順書の版が変わり、
  //   作り直し（refreshPlaybookIfStale）が必ず起きる＝「版を上げたのに DB が古いまま」を防ぐ
  return fnv(JSON.stringify([rules.map((r) => [r.id, r.scene, r.text, r.since]), AUTO_RULES_REVIEWED_UP_TO]));
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
export function checkRulesInCode(files: {
  pageScript: string;
  searchAudit: string;
  manifestJson: string;
  /** bulk-dl.js（AD並び替えなど一覧側の決まり）。無いと bulk-dl の決まりは飛ばす */
  bulkDl?: string;
  /** background.js（連続客・客ごと思考など）。無いと background の決まりは飛ばす */
  background?: string;
}, rules: ReadonlyArray<AutoRule> = AUTO_RULES): string[] {
  const issues: string[] = [];
  for (const r of rules) {
    const src = r.file === "page-script.js" ? files.pageScript
      : r.file === "search-audit.js" ? files.searchAudit
      : r.file === "background.js" ? (files.background ?? "")
      : (files.bulkDl ?? "");
    if (r.file === "bulk-dl.js" && !files.bulkDl) {
      issues.push(`決まり ${r.id} は bulk-dl.js の目印が要るが、点検にファイルが渡っていない`);
      continue;
    }
    if (r.file === "background.js" && !files.background) {
      issues.push(`決まり ${r.id} は background.js の目印が要るが、点検にファイルが渡っていない`);
      continue;
    }
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
