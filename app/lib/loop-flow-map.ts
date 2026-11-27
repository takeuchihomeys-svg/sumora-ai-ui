/**
 * お客さん1人ぶんの流れの地図（正本）— 2.8.319 の後の土台強化（失敗の道・2.8.320）
 *
 * なぜ作ったか（竹内さん 2026-11-27「なんで改善する際に前提や流れを理解せずに変更したのか。
 *   根本的な部分を理解すれば④の分かれ目だと理解できる。今後改善する際、根本的な部分を理解して改善できるように
 *   仕組みをつくる。土台を強化する」）。
 *
 * 起きた事: 「全部送付済み／次頁も／0件でもリセットして次のお客さんへ」を手順書に足す時、入れ物（文字の一列・
 *   next が1つ）に合わせて ⑤⑥⑦⑧ と通し番号で書き足した。中身は「④で押す物が無い時の分かれ道」だった。
 *
 * 2.8.320 で足したこと: 正常な流れだけでは、実際に止まった所（リセットが押せない・読み直せない・裏が起き直す・
 *   タブが見えない）を表せなかった。失敗の道を「分かれ道（branch）」として親の手にぶら下げ、
 *   割り込み（interrupt）は「どの段でも起きうる回復の決まり」として別に持つ。
 *
 * この地図の約束:
 *   1. 形は3つ: step（順に行う手）／branch（ある手の場合分け・順に行う手ではない）／join（合流点）。
 *   2. 手順書の一覧の手（④から先）はこの地図から作る（手で書き足さない）。
 *   3. どの分かれ道も客完了（join）に合流し、客完了はリセット（reset_front）へ戻る（「リセットからの流れは同じ」）。
 *      失敗の道（分かれ道）は、もう1回押す・従来の外し・次のお客さんへ飛ばす、のどれかで次の手へ戻る。
 *   4. 各ノードは拡張のコードに実在する目印（evidence）と、点検に残る印（audit）を持つ。無い物は試験が止める。
 *   5. 流れを変える時は、先にこの地図を直す（コードや手順書の文より先に）。道具: scripts/change-premise.ts。
 *
 * 試験: app/lib/__tests__/loop-flow-map.test.ts（形・合流・実在・手順書との一致・失敗の道・割り込み・悪い地図の自己点検）
 */

/** stop＝止まり（ここで一括が止まる。次の手へ行かない・客完了へ合流しない） */
export type FlowKind = "step" | "branch" | "join" | "stop";

/**
 * パネル（拡張の枠の「いま／つぎ」）に出す言葉の段。
 *   2026-11-27 竹内さん「改善したらパネルも改善される仕組みちゃんとつくる／パネルに記載されている文字ちゃんと改善したながれにする」
 *   パネルの言葉は手で別に持たない。この地図の panel から作る（app/lib/bulk-panel-grasp.ts・拡張の写しは scripts/gen-panel-words.ts）。
 */
export const PANEL_PHASE_KEYS = ["reset", "fill", "search", "sort", "list", "all_sent", "next_page", "done"] as const;
export type PanelPhaseKey = (typeof PANEL_PHASE_KEYS)[number];

export type FlowPanel = {
  phase: PanelPhaseKey;
  /** 「いま」に出す言葉 */
  now: string;
  /** 「つぎ」に出す言葉（then の段の要の語 short を必ず含む＝つぎが次の段を指している） */
  next: string;
  /** この段を一言で（前の段の next に入っていなければならない要の語） */
  short: string;
  /** この段の次に来うる段（地図の next でたどれる段だけ） */
  then: PanelPhaseKey[];
  /** 押した時点で「いま」を別の段の言葉へ切り替える（読み直しを待たない）。then のどれか */
  switchTo?: PanelPhaseKey;
};

export type FlowNode = {
  id: string;
  kind: FlowKind;
  /** 短い名前（地図の表示用） */
  label: string;
  /** 手順書に出す文（branch／join／一覧の手の④だけ。他は手順書の別の所にある） */
  playbook?: string;
  /** branch の条件（「どんな時にこの道へ行くか」） */
  when?: string;
  /** branch が属する step の id（branch だけ） */
  parent?: string;
  /** 次に行く所（分かれ道・繰り返しは複数） */
  next: string[];
  /** 拡張のコードに実在する目印 */
  evidence: { file: string; token: string };
  /** 点検（search_audits.steps）に残る印。search-audit.js の KEEP_STEP／RULE_STEP に落ちない物だけ */
  audit: string[];
  /** 補足（例: 最初のお客さんはリセットしない） */
  note?: string;
  /** パネルに出す言葉（段ごと）。1つの手に複数の段（例: 全部送付済み→次ページ）が在ってよい */
  panel?: FlowPanel[];
  /** パネルに専用の言葉を持たない理由（どの段の言葉で出すか）。panel か noPanel のどちらかは必須 */
  noPanel?: string;
  /** この手で押すボタンと「押した・効いた」の把握（2.8.328）。手順書の手の文は pressLine() で地図から作る */
  presses?: FlowPress[];
};

/**
 * 押す物1つの把握（2.8.328 竹内さん「押したら押したってこと理解できるように／それぞれの手順書のところでも押したことの把握」）。
 *   押した（押す関数が実際に呼ばれた）と、効いた（画面が変わった・送れた・頁が進んだ）は別の印。
 *   「積んだ」「列が空いた」は押した証拠にしない。
 */
export type FlowPress = {
  /** 画面のボタンの名前 */
  button: string;
  /** 押した受領の印（search_audits の段の名前） */
  receipt: string[];
  /** 効いた印 */
  effect: string[];
  /** 押せなかった・効かなかった印 */
  fail: string[];
  /** 効いたとみなす画面の変化（手順書の文） */
  effectJa: string;
  /** 効かなかった時の動き（押し直す回数・止める・記録して進む） */
  onFail: string;
  /** 次の手が「効いた」を待ってから進むか（false は記録して進む＝理由を onFail に書く） */
  gate: boolean;
  /** 印を出すコード（目印の語がそのファイルに実在する） */
  evidence: { file: string; token: string };
  /**
   * 手順書（リアプロの録画の場面）のどの手か。fields は録画の欄名（action-playbook の PLAYBOOK_FIELD_JA の鍵）。
   *   when が在る＝その客に要る時だけ行う手（録画に出ない客があるため、録画に無ければ地図から手順書に足す）。
   *   after＝足す時に置く位置（この欄の手の後ろ・無ければ場面の末尾）。
   */
  playbookStep?: { scenes: string[]; fields: string[]; when?: string; after?: string };
};

/**
 * 割り込み: どの段でも起きうる回復の決まり（流れの途中に分岐として置かない）。
 *   resume = 起きた後どこから続けるか。必ず「止まった段へ戻る」か「次のお客さんへ飛ばす」。
 */
export type FlowInterrupt = {
  id: string;
  label: string;
  /** どの段で起きうるか */
  applies: string;
  /** 起きた後の動き */
  resume: string;
  evidence: { file: string; token: string };
  audit: string[];
  /** 実測（いつ・どの回で見えたか） */
  seen: string;
};

/** 一覧の手の番号（①〜は ①②③＝並べ替え。④から先をこの地図が作る） */
const CIRCLED = ["", "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"];

export const LIST_PRESS_FIRST_NO = 4;

export const LOOP_FLOW_NODES: ReadonlyArray<FlowNode> = [
  // ── 1人ぶんの終わりから次の客へ ─────────────────────────────
  {
    id: "reset_front",
    noPanel: "リセットの手（reset）の言葉で出す。押す前の確かめはパネルに別の段を作らない",
    kind: "step",
    label: "押す前にリアプロのタブを確かめ、背面なら前に出す",
    next: ["reset"],
    evidence: { file: "background.js", token: "_bringRealproTabFront(_tab, _ridFront" },
    audit: ["reset_vis", "reset_front"],
    note: "2.8.320: 背面のタブではリセットの押す処理（タイマー）が遅れて押されなかった（#1666）。見え方の印を残す",
  },
  {
    id: "reset",
    panel: [{ phase: "reset", now: "リセットを押す最中", next: "次客の条件をAPIから読み直して入れる", short: "リセット", then: ["fill"] }],
    kind: "step",
    label: "リセットを押す（送付のあと1回）",
    next: ["api_reload", "b_reset_hidden_wait", "b_reset_hidden_stop", "b_reset_late", "b_reset_insure", "b_reset_stop"],
    evidence: { file: "background.js", token: "_postSendResetRealpro" },
    audit: ["reset_press", "reset_settled", "reset_done_gap"],
    presses: [
      {
        button: "リセット",
        receipt: ["reset_press"],
        effect: ["reset_settled"],
        fail: ["reset_stop", "page:reset_press_cancel", "page:reset_press_late_blocked"],
        effectJa: "読み直した画面のフォームが空",
        onFail: "押した印が無い（実際のクリックが呼ばれない）・空にならない時は60〜90秒後に画面を確かめて押し直し1回→それでも空でなければ止める",
        gate: true,
        evidence: { file: "page-script.js", token: "queue_idle_not_fired" },
      },
    ],
    note: "最初のお客さんと前客リセット済みの客は入れる前に押さない（first_customer_no_reset）。空を確かめたら20秒あけてから次の手へ（reset_done_gap）",
  },
  {
    id: "api_reload",
    noPanel: "リセットの「つぎ」（次客の条件をAPIから読み直して入れる）が言う。読み直しだけの段は作らない",
    kind: "step",
    label: "次客の条件をAPIから読み直す",
    next: ["fill", "b_api_skip"],
    evidence: { file: "background.js", token: "_refreshCustomerBeforeSearch" },
    audit: ["customer_api_reload", "api_reload_gap"],
    note: "読めなければ古い条件では検索せずこの客を飛ばす（2.8.318）。読めたら20秒あけてから入れる（api_reload_gap・2026-11-27）",
  },
  {
    id: "fill",
    panel: [{ phase: "fill", now: "条件を入れている最中", next: "検索を押す", short: "条件", then: ["search"] }],
    kind: "step",
    label: "条件を入れる",
    next: ["search"],
    evidence: { file: "page-script.js", token: "fill_done" },
    audit: ["fill_done"],
    note: "入力の終わりに、この回で押せたボタン・押せなかったボタンの数を1行で残す（press_sum）",
    presses: [
      {
        button: "所在地絞り込み",
        receipt: ["page:press_ok_area_open"],
        effect: ["page:area_open_ok"],
        fail: ["page:press_ng_area_open", "page:area_open_fail"],
        effectJa: "所在地の小窓（都道府県・区・町の一覧か確定のボタン）が見えた",
        onFail: "見えなければ、押している最中でない時に押し直す（最大3回・開いた直後9秒の間だけ。開く途中で押すと閉じるため）",
        gate: true,
        evidence: { file: "page-script.js", token: "area_open_ok" },
        playbookStep: { scenes: ["area"], fields: ["所在地絞り込み＋"] },
      },
      {
        button: "駅の設定へ進む",
        receipt: ["page:press_ok_go_station"],
        effect: ["page:go_press_ok"],
        fail: ["page:go_press_fail", "page:station_go_stuck"],
        effectJa: "駅の一覧が見えた",
        onFail: "1.8秒で出なければ押し直す→3回で止める",
        gate: true,
        evidence: { file: "page-script.js", token: "station_go_stuck" },
        playbookStep: { scenes: ["station"], fields: ["駅の設定へ進む"] },
      },
      // 2.8.328 竹内さん「町の選択や管理費・構造の選択は、効いたかを確かめていない ここも順に改善する」
      {
        button: "町（ピンポイント）",
        receipt: ["page:cond_pick_idle"],
        effect: ["page:cond_effect_ok"],
        fail: ["page:press_ng_cond_effect"],
        effectJa: "選んだ町ごとに、小窓の町の印が付いている（押す列が空いてから読み直す）",
        onFail: "付いていない町だけ1回選び直す→それでも付かなければ記録して枠に⚠を出し、確定へ進む（検索は止めない）",
        gate: true,
        evidence: { file: "page-script.js", token: "_townPickedState(" },
        playbookStep: { scenes: ["area"], fields: ["town_code[]"], when: "お客さんに町（ピンポイント）がある時だけ", after: "city_code[]" },
      },
      {
        button: "確定してリストへ",
        receipt: ["page:press_ok_confirm"],
        effect: ["page:confirm_effect_ok"],
        fail: ["page:press_ng_confirm", "page:confirm_effect_retry", "page:confirm_effect_ng"],
        effectJa: "所在地・駅の小窓が閉じた",
        onFail: "6秒で閉じなければ1回押し直す→それでも閉じなければ止める（開いたまま進むと条件が入らない・検索が押せない）",
        gate: true,
        evidence: { file: "page-script.js", token: "_confirmEffectThen(" },
        playbookStep: { scenes: ["area", "station"], fields: ["確定してリストへ"] },
      },
      {
        button: "管理費・共益費込み",
        receipt: ["page:cond_pick_idle"],
        effect: ["page:cond_effect_ok"],
        fail: ["page:press_ng_cond_effect"],
        effectJa: "管理費・共益費込みの欄に印が付いている（押す列が空いてから読み直す）",
        onFail: "1回だけ押し直す→それでも付かなければ記録して枠に⚠を出し、次の欄へ進む（欄が無い時は fee_skip を残して飛ばす）",
        gate: true,
        evidence: { file: "page-script.js", token: "_feeEffect(" },
        playbookStep: { scenes: ["cond"], fields: ["include_common_fee"] },
      },
      {
        button: "構造",
        receipt: ["page:cond_pick_idle"],
        effect: ["page:cond_effect_ok"],
        fail: ["page:press_ng_cond_effect"],
        effectJa: "欲しい構造だけに印が付いている（足りない・余計が0）",
        onFail: "1回だけ選び直す（足りない所を付け、余計を外す）→それでも合わなければ記録して枠に⚠を出し、次の欄へ進む",
        gate: true,
        evidence: { file: "page-script.js", token: "_structureEffect(" },
        playbookStep: { scenes: ["cond"], fields: ["structured_type[]"], when: "お客さんに構造の希望がある時だけ" },
      },
    ],
  },
  {
    id: "search",
    panel: [{ phase: "search", now: "検索を押す最中", next: "並べ替え（検索確認から40〜50秒後）", short: "検索", then: ["sort"] }],
    kind: "step",
    label: "検索を押す（9〜12秒見直してから）",
    next: ["sort"],
    evidence: { file: "page-script.js", token: "search_review_wait" },
    audit: ["dl:search_press_wait"],
    presses: [
      {
        button: "検索",
        receipt: ["page:press_ok_search", "page:search_press_ok"],
        effect: ["page:search_customer_grasp_ok"],
        fail: ["page:press_ng_search", "page:search_customer_grasp_gap"],
        // 検索の手の文に「印刷用PDF」を書かない（拡張の _pbListNext が1手目の PDF の字で一覧の手と見る）
        effectJa: "検索結果の画面（並べ替えの見出し・棟戸の数）が見えた",
        onFail: "見えるまで並べ替えへ進まない（次の撮影・次の手まで45秒あける）",
        gate: true,
        evidence: { file: "page-script.js", token: "search_customer_grasp_ok" },
        playbookStep: { scenes: ["search"], fields: ["検索", "go_search"] },
      },
    ],
  },
  {
    id: "sort",
    panel: [{ phase: "sort", now: "並べ替え最中", next: "物件取得（全部送付済みなら次ページへ）", short: "並べ替え", then: ["list"], switchTo: "list" }],
    kind: "step",
    label: "並べ替え（AD→高→低・①〜③）",
    /** ③の文の末尾に、この文をそのまま載せる（手で要約しない。checkListPlaybookStrength が見張る） */
    playbook: "押した時点で並べ替えは完了。押したあとは15〜20秒あけてから一覧を取る（並べ替えの後はラグがあるため）。ページが読み直されても、読み直した一覧ではもう一度並べ替えず、読み直しのあとも15〜20秒あけてから④物件取得へ進む。パネルは「物件取得最中」（「並べ替え最中」のままにしない）",
    next: ["list_press", "b_zero"],
    evidence: { file: "bulk-dl.js", token: "_sortByAdLikeHuman" },
    audit: ["dl:sort_done", "dl:sort_pressed"],
    presses: [
      {
        button: "高→低",
        receipt: ["dl:sort_pressed"],
        effect: ["dl:press_sort_effect_ok"],
        fail: ["dl:press_ng_sort_effect", "dl:sort_no_hilo"],
        // 2.8.328 竹内さん「押したのが残らないなら、前後の手順と時間差をちゃんとあけて、時間差で並べ替えしたということの認識にすればよい」
        effectJa: "押した時刻から猶予（押した後と読み直し後に15〜20秒）をあけて④に入った＝時間差で並べ替え完了と認識（AD高／AD未は参考に残す）。認識した後は同じ一覧で並べ替えを始めない",
        onFail: "押した時刻が分からない・時間差が短い時は記録して枠に⚠を出して④へ進む（アドレスに出ない並べ替えで押し直すと繰り返すため）",
        gate: true,
        evidence: { file: "bulk-dl.js", token: "_sortTimeRecognized(" },
        playbookStep: { scenes: ["list"], fields: ["高→低", "左の高→低｜span.sort_detail"] },
      },
    ],
    note: "2.8.322 #1668: 高→低のあと sort_lag_grace で終わり、sort_done も物件取得も無かった。完了の文は③に載せる。2.8.324 #1673: 読み直し後の入口が猶予なしで4秒後に物件取得を始めた（猶予は読み直しで消えるため読み直し後にも取る）",
  },
  {
    id: "list_press",
    panel: [{ phase: "list", now: "物件取得最中", next: "全部送付済みなら次ページへ・無ければ客完了", short: "物件取得", then: ["all_sent", "done"] }],
    kind: "step",
    label: "印刷用PDFを押す（④）",
    playbook: "並べ替え後に印刷用PDFを押す（物件取得・1件ずつ）。並べ替え完了（高→低を押したあとの読み直し）を把握してから押す",
    next: ["list_press", "customer_done", "b_all_sent_next", "b_all_sent_last"],
    evidence: { file: "bulk-dl.js", token: "_startAutoPressRun" },
    audit: ["dl:list_flow_grasp"],
    presses: [
      {
        button: "印刷用PDF",
        receipt: ["dl:press_pdf_sum"],
        effect: ["dl:one_send_ms"],
        fail: ["dl:press_ng_pdf", "dl:press_ng_pdf_effect"],
        effectJa: "送り始めて送り終えた（1件ずつ）",
        onFail: "押せなければその物件を飛ばして次へ。送り始めなければ待ちを打ち切って次の物件へ（同じ物件を二度押さない）",
        gate: true,
        evidence: { file: "bulk-dl.js", token: "press_pdf_sum" },
        playbookStep: { scenes: ["list"], fields: ["印刷用PDF"] },
      },
    ],
  },
  // ── 分かれ道（順に行う手ではない）─────────────────────────────
  {
    id: "b_all_sent_next",
    panel: [
      { phase: "all_sent", now: "全部送付済み→次ページへ", next: "次ページ（無ければ客完了→リセット）", short: "送付済み", then: ["next_page", "done"] },
      { phase: "next_page", now: "次ページへ移動中", next: "物件取得（送付済み以外の行）", short: "次ページ", then: ["list"] },
    ],
    kind: "branch",
    label: "この頁が全部送付済み→次へ",
    parent: "list_press",
    when: "この頁の行が全部「送付済み」（押せる行が0）で、次のページがある",
    playbook: "この頁の行が全部「送付済み」なら、印刷用PDFは押さず「次へ」で次のページへ移る（止まらない・all_sent_page）",
    next: ["list_press"],
    evidence: { file: "bulk-dl.js", token: "all_sent_page" },
    audit: ["dl:all_sent_page"],
    presses: [
      {
        button: "次へ",
        receipt: ["dl:press_next"],
        effect: ["dl:press_next_moved"],
        fail: ["dl:press_ng_next", "dl:press_ng_next_page"],
        effectJa: "頁の番号が押した先になった（前の頁の行が消えた）",
        onFail: "前の頁の行が消えるまで待つ。番号が合わなければ記録して枠に⚠を出す（送付済みの行は飛ばす・頁の上限で必ず終わる）",
        gate: true,
        evidence: { file: "bulk-dl.js", token: "press_next_moved" },
        playbookStep: { scenes: ["next"], fields: ["次", "最初前1234次最後"] },
      },
    ],
  },
  {
    id: "b_all_sent_last",
    noPanel: "客完了（done）の言葉で出す",
    kind: "branch",
    label: "次頁も全部送付済み／最後まで→客完了",
    parent: "list_press",
    when: "次のページも全部送付済み。最後のページまで全部送付済みで、次のページが無い",
    playbook: "次のページも全部送付済みなら、また「次へ」。最後のページまで全部送付済みなら新しい物件なしとして客完了（all_sent_done）",
    next: ["customer_done"],
    evidence: { file: "bulk-dl.js", token: "all_sent_done" },
    audit: ["dl:all_sent_done"],
  },
  {
    id: "b_zero",
    noPanel: "客完了（done）の言葉で出す（0件でも客完了と同じ）",
    kind: "branch",
    label: "検索結果0件→客完了",
    parent: "list_press",
    when: "検索結果が0件（0棟0戸・印刷用PDFも0・3回続けて読めた）",
    playbook: "検索結果が0件（0棟0戸）の時も、行が出るのを待ち続けず客完了にする（zero_count0_finish）",
    next: ["customer_done"],
    evidence: { file: "bulk-dl.js", token: "zero_count0_finish" },
    audit: ["dl:zero_count0_finish"],
  },
  {
    id: "b_reset_late",
    noPanel: "リセット（reset）の言葉で出す。押した扱いで先へ進むだけ",
    kind: "branch",
    label: "押す返事が遅れた→押した跡があれば先へ",
    parent: "reset",
    when: "押す処理の返事が時間切れ（press_timeout）だったが、読み直しで押した跡（reset_pressed）が見つかった",
    playbook: "返事が遅れても押した跡があれば押したとして先へ進む（もう1回押さない・従来の外しへ行かない・2.8.315）",
    next: ["api_reload"],
    evidence: { file: "background.js", token: "押した（遅れて・返事は" },
    audit: ["reset_press", "reset_press_late_check"],
  },
  {
    id: "b_reset_insure",
    noPanel: "リセット（reset）の言葉で出す。完了が来ない時は60〜90秒後に確かめ、残りがあれば押し直し1回",
    kind: "branch",
    label: "完了（空の確認）が来ない→さらに60〜90秒後に確かめ・残りなら押し直し1回",
    parent: "reset",
    when: "押した後に空と確かめられない（押せず・押した跡なし・残りが見える）",
    playbook: "完了（空の確認）が来なければ、さらに60〜90秒待ってから画面を撮って読む。空ならリセット完了として次のお客さんへ。残りがあれば押し直しを1回だけ（押し直すのは確かめた後だけ・reset_retry）。押し直して空と確かめられたら完了。",
    next: ["api_reload"],
    evidence: { file: "background.js", token: "reset_insure_wait" },
    audit: ["reset_insure_wait", "reset_stuck_shot", "reset_stuck_grasp", "reset_retry"],
  },
  {
    id: "b_reset_stop",
    noPanel: "リセット（reset）の言葉で出す。止まったことは押した結果の行（✗空を確かめられず止めた）で出す",
    kind: "stop",
    label: "保険の後も空を確かめられない→止める（次のお客さんへ進まない）",
    parent: "reset",
    when: "保険（60〜90秒後の確かめ・押し直し1回）の後も、空と確かめられない",
    playbook: "空を確かめられなければ、次のお客さんへは進まず止める（残りを次の客へ持ち越さない・従来の1つずつ外しへも行かない・reset_stop）。画面は残し、グループに知らせる。",
    next: [],
    evidence: { file: "background.js", token: "_resetStopNotify" },
    audit: ["reset_stop", "reset_stuck_shot", "reset_stuck_grasp"],
  },
  {
    id: "b_reset_hidden_wait",
    noPanel: "リセット（reset）の言葉で出す。待っている事は枠の待ちの行（⏳）と押した結果の行（⚠見えないので押さずに待っている）で出す",
    kind: "branch",
    label: "前に出してもタブが見えない→押さずに見えるまで待つ（知らせる）",
    parent: "reset",
    when: "前に出しても見え方が hidden のまま（Chrome の窓が他のアプリに隠れている）",
    playbook: "前に出してもリアプロのタブが見えなければ、リセットは押さずに一括を止めて待つ。Windows の通知と枠で「Chrome を前に出してください」と知らせ、見えたら自動で続けて押す（強制的に前に出さない・2026-11-27 竹内さん）",
    next: ["reset"],
    evidence: { file: "background.js", token: "reset_hidden_wait" },
    audit: ["reset_hidden_wait", "reset_hidden_visible"],
    note: "見えないタブでは Chrome が待ちの時計を遅くし、人の動きのクリックが120秒たっても押されなかった（#1661・#1666・#1671）。待っている間は段と窓の上限を伸ばし、見張りが固着と見て割り込まないようにする",
  },
  {
    id: "b_reset_hidden_stop",
    noPanel: "リセット（reset）の言葉で出す。止まったことは押した結果の行（✗見えないまま10分たったので止めた）で出す",
    kind: "stop",
    label: "10分待っても見えない→止める（次のお客さんへ進まない）",
    parent: "reset",
    when: "見えるのを10分待っても hidden のまま",
    playbook: "10分待っても見えなければ、リセットは押さずに止める（次のお客さんへ進まない・グループに知らせる・reset_hidden_stuck）",
    next: [],
    evidence: { file: "background.js", token: "reset_hidden_stuck" },
    audit: ["reset_hidden_stuck"],
  },
  {
    id: "b_api_skip",
    noPanel: "リセットの「つぎ」の言葉で出す。飛ばした客は次の客の読み直しへ進む",
    kind: "branch",
    label: "条件を読み直せない→このお客さんを飛ばして次へ",
    parent: "api_reload",
    when: "API から3回読んでも読めない、または読み直した一覧にそのお客さんが居ない",
    playbook: "読めなければ古い条件では検索せず、このお客さんを飛ばして理由を残し、次のお客さんへ（2.8.318・customer_api_reload）",
    next: ["api_reload"],
    evidence: { file: "background.js", token: "AXLX_API_RELOAD_FAILED" },
    audit: ["customer_api_reload"],
    note: "飛ばした客は客完了を通らない（前客の送付後のリセットは済んでいる）。次の客の読み直しへ進む",
  },
  // ── 合流 ──────────────────────────────────────────────────
  {
    id: "customer_done",
    panel: [{ phase: "done", now: "客完了→リセットへ", next: "リセットを押して30〜34秒待つ", short: "客完了", then: ["reset"] }],
    kind: "join",
    label: "客完了→リセットして次のお客さんへ",
    playbook:
      "送付が終わった合図のあと20秒あけてから、リセットを押す。リセットからの流れは同じ：リセット→30〜34秒待って空を確かめる→20秒あけて次のお客さんの条件をAPIから読み直す→20秒あけて入れる→検索。作業が1つ終わったら、次の作業へ行く前に時間をあける（止まりやすいため）。「空とみなして次へ」は使わない（2026-11-27）",
    next: ["reset_front"],
    evidence: { file: "bulk-dl.js", token: "_sendBatchDone" },
    audit: ["post_send_clear", "handoff_loop", "reset_gap"],
    note: "最後のお客さんは完了を待たせず裏でリセットして終わる",
  },
];

/**
 * 割り込み（どの段でも起きうる回復）。流れの途中の分岐にはしない（どの段から来ても同じ回復をするため）。
 *   実測の回は search_audits の #id。
 */
export const LOOP_INTERRUPTS: ReadonlyArray<FlowInterrupt> = [
  {
    id: "i_sw_restart",
    label: "拡張の裏（サービスワーカー）が起き直した",
    applies: "どの段でも",
    resume: "開いていた回を戻し、止まった段から続ける（前の段の記録は消えない）",
    evidence: { file: "background.js", token: "sw_restart_restored" },
    audit: ["sw_restart_restored"],
    seen: "#1659 #1663 #1666（並べ替え・検索・リセットの途中）",
  },
  {
    id: "i_tab_reload",
    label: "ページの入力の仕組みが応答しない",
    applies: "入力・検索・並べ替えの段",
    resume: "同じ検索画面を読み直して、同じ段から続ける（トップへ戻さない）",
    evidence: { file: "background.js", token: "tab_reload" },
    audit: ["tab_reload"],
    seen: "#1661 #1666",
  },
  {
    id: "i_tab_hidden_stall",
    label: "タブが見えないまま進捗が止まる",
    applies: "押す・入れる・待つの段（背面のタブ）",
    resume: "ウィンドウを元の大きさに戻して前に出し、同じ段へ（戻せなければ理由を残して先へ）",
    evidence: { file: "background.js", token: "tab_hidden_stall" },
    audit: ["tab_hidden_stall"],
    seen: "#1661（180・240・310秒の見張り）",
  },
];

export function flowNode(id: string, nodes: ReadonlyArray<FlowNode> = LOOP_FLOW_NODES): FlowNode | undefined {
  return nodes.find((n) => n.id === id);
}

/** 親の手にぶら下がる分かれ道（地図の並び順） */
export function branchesOf(parentId: string, nodes: ReadonlyArray<FlowNode> = LOOP_FLOW_NODES): FlowNode[] {
  return nodes.filter((n) => (n.kind === "branch" || n.kind === "stop") && n.parent === parentId);
}

/** from から next をたどって to に着けるか */
export function canReach(from: string, to: string, nodes: ReadonlyArray<FlowNode> = LOOP_FLOW_NODES): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop() as string;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = flowNode(id, nodes);
    if (n) for (const x of n.next) stack.push(x);
  }
  return false;
}

/**
 * 地図の形の点検（悪い地図を止める）。問題があれば文の一覧を返す（空なら良い）。
 *   ・id が重ならない／next の行き先が実在する
 *   ・branch は 親（step）・条件（when）・手順書の文・行き先を持つ。親は step
 *   ・どの branch からも 客完了（join）に着き、客完了から reset_front→reset に戻る（リセットからの流れは同じ）
 *   ・最初の手から全部に着ける（行き止まり・孤立が無い）
 *   ・join は 1つだけ
 *   ・割り込みは目印と点検の印を持つ（interrupts は別に検査: checkInterrupts）
 */
export function checkFlowMap(nodes: ReadonlyArray<FlowNode> = LOOP_FLOW_NODES): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) out.push(`id が重なっている: ${n.id}`);
    ids.add(n.id);
  }
  for (const n of nodes) {
    for (const x of n.next) if (!ids.has(x)) out.push(`${n.id} の next が実在しない: ${x}`);
    if (!n.evidence || !n.evidence.file || !n.evidence.token) out.push(`${n.id} にコードの目印（evidence）が無い`);
    if (!n.audit.length) out.push(`${n.id} に点検の印（audit）が無い＝何が起きたか残らない`);
    if (n.kind === "stop" && n.next.length) out.push(`${n.id}（止まり）に行き先（next）があってはならない＝ここで止まる`);
    if (n.kind === "branch" || n.kind === "stop") {
      if (!n.parent) { out.push(`${n.id}（${n.kind}）に親の手（parent）が無い＝一列の手に見えてしまう`); continue; }
      const p = flowNode(n.parent, nodes);
      if (!p) out.push(`${n.id} の親 ${n.parent} が実在しない`);
      else if (p.kind !== "step") out.push(`${n.id} の親 ${n.parent} は step ではない`);
      if (!n.when || !n.when.trim()) out.push(`${n.id}（branch）に条件（when）が無い`);
      if (!n.playbook || !n.playbook.trim()) out.push(`${n.id}（branch）に手順書の文（playbook）が無い`);
      if (n.kind === "branch" && !n.next.length) out.push(`${n.id}（branch）の行き先（next）が無い`);
    } else if (n.parent) {
      out.push(`${n.id} は branch ではないのに parent がある`);
    }
  }
  const joins = nodes.filter((n) => n.kind === "join");
  if (joins.length !== 1) out.push(`join（合流点＝客完了）は1つだけ。今は ${joins.length}`);
  const join = joins[0];
  const first = nodes.find((n) => n.kind === "step");
  // 分かれ道は勝手に別の手へ飛ばない。出てよいのは 客完了（合流）・親の手（もう一度）・次のお客さんの読み直し（api_reload）だけ
  for (const b of nodes.filter((n) => n.kind === "branch")) {
    for (const x of b.next) {
      const ok = (join && x === join.id) || x === b.parent || x === "api_reload";
      if (!ok) out.push(`${b.id} の行き先 ${x} は許されない（分かれ道は客完了・親の手・次のお客さんの読み直しへだけ出る）`);
    }
  }
  if (join) {
    if (!join.next.length || !join.next.every((x) => flowNode(x, nodes)?.kind === "step")) {
      out.push(`${join.id}（客完了）の次は step（リセット）でなければならない`);
    }
    if (!join.next.includes("reset_front")) out.push(`${join.id}（客完了）の次はリセット（reset_front）でなければならない（リセットからの流れは同じ）`);
    for (const b of nodes.filter((n) => n.kind === "branch")) {
      if (!canReach(b.id, join.id, nodes)) out.push(`${b.id}（分かれ道）が客完了に合流しない＝リセットして次のお客さんへ行けない`);
    }
    if (first && !canReach(join.id, first.id, nodes)) out.push(`客完了から最初の手（${first.id}）へ戻れない＝ループにならない`);
  }
  if (first) {
    for (const n of nodes) if (!canReach(first.id, n.id, nodes)) out.push(`${n.id} に ${first.id} から着けない（孤立）`);
  }
  return out;
}

/** 割り込みの形の点検（目印・点検の印・回復の決まりが在るか） */
export function checkInterrupts(list: ReadonlyArray<FlowInterrupt> = LOOP_INTERRUPTS): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const i of list) {
    if (ids.has(i.id)) out.push(`割り込みの id が重なっている: ${i.id}`);
    ids.add(i.id);
    if (!i.evidence || !i.evidence.file || !i.evidence.token) out.push(`${i.id} にコードの目印（evidence）が無い`);
    if (!i.audit.length) out.push(`${i.id} に点検の印（audit）が無い`);
    if (!i.resume || !i.resume.trim()) out.push(`${i.id} に起きた後の動き（resume）が無い`);
    if (!i.applies || !i.applies.trim()) out.push(`${i.id} にどの段で起きるか（applies）が無い`);
  }
  return out;
}

/** 地図の panel を段の順に並べた平らな一覧（どの手の言葉かも持つ） */
export function panelPhases(
  nodes: ReadonlyArray<FlowNode> = LOOP_FLOW_NODES,
): Array<FlowPanel & { nodeId: string }> {
  const out: Array<FlowPanel & { nodeId: string }> = [];
  for (const n of nodes) for (const p of n.panel || []) out.push({ ...p, nodeId: n.id });
  const rank = (k: string) => PANEL_PHASE_KEYS.indexOf(k as PanelPhaseKey);
  return out.sort((a, b) => rank(a.phase) - rank(b.phase));
}

/** パネルの言葉（段→いま／つぎ）。bulk-panel-grasp.ts の PANEL_PHASE_WORDS はこれ（手で別に持たない） */
export function panelPhaseWords(
  nodes: ReadonlyArray<FlowNode> = LOOP_FLOW_NODES,
): Record<PanelPhaseKey, { now: string; next: string }> {
  const out = {} as Record<PanelPhaseKey, { now: string; next: string }>;
  for (const p of panelPhases(nodes)) out[p.phase] = { now: p.now, next: p.next };
  return out;
}

/** 拡張の写し（chrome-extension/bulk-panel-grasp.js と page-script.js の生成部分）の本文。scripts/gen-panel-words.ts が書き、試験が一致を見る */
export function renderPanelWordsJs(
  nodes: ReadonlyArray<FlowNode> = LOOP_FLOW_NODES,
  varName: string = "PANEL_PHASE_WORDS",
): string {
  const w = panelPhaseWords(nodes);
  const lines = PANEL_PHASE_KEYS.map(
    (k, i) =>
      `    ${k}: { now: ${JSON.stringify(w[k].now)}, next: ${JSON.stringify(w[k].next)} }${i < PANEL_PHASE_KEYS.length - 1 ? "," : ""}`,
  );
  return [`  var ${varName} = {`, ...lines, "  };"].join("\n");
}

/**
 * パネルの言葉を持つ手から、次に「パネルの言葉を持つ手」へ着く手（途中の手はパネルの言葉を持たない物だけ通る）。
 *   分かれ道は親の手の場合分けなので、兄弟の分かれ道の行き先（例: 全部送付済み→次へ の兄弟＝最後まで全部送付済み→客完了）も含める。
 *   ただの到達（canReach）では、検索から客完了までも「着ける」ことになり、飛ばした流れを見逃す。
 */
function panelNeighbors(startId: string, nodes: ReadonlyArray<FlowNode>): Set<string> {
  const hit = new Set<string>();
  const seen = new Set<string>();
  const stack: string[] = [startId];
  let isStart = true;
  while (stack.length) {
    const id = stack.pop() as string;
    const n = flowNode(id, nodes);
    if (!n) continue;
    if (!isStart && n.panel && n.panel.length) { hit.add(id); continue; }
    isStart = false;
    if (seen.has(id)) continue;
    seen.add(id);
    const outs = [...n.next];
    if (n.kind === "branch" && n.parent) for (const s of branchesOf(n.parent, nodes)) if (s.id !== id) outs.push(...s.next);
    for (const x of outs) stack.push(x);
  }
  return hit;
}

/**
 * パネルの言葉の点検（流れを変えたのにパネルの言葉が古いまま、を止める・2026-11-27）。
 *   ・どの手（step／branch／join）も panel か noPanel（理由）を持つ＝手を足したらパネルをどうするか決めさせる
 *   ・段は8つ全部あり、重ならない。「いま」の言葉も、「つぎ」の要の語（short）も重ならない（古い言葉が別の段に残らない）
 *   ・各段の「つぎ」は then の段の要の語を含む＝つぎが次の段を指している
 *   ・then の段は、地図の next で「パネルの言葉を持たない手だけを通って」着ける手の言葉（地図に無い道・飛ばした流れを言わない）
 *   ・段の輪が閉じる（reset から全部に着き、done は reset へ戻る＝客完了→リセットへ戻る）
 *   ・switchTo は then の1つ（並べ替えは押した時点で物件取得の言葉へ）
 */
export function checkPanelWords(nodes: ReadonlyArray<FlowNode> = LOOP_FLOW_NODES): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const hasPanel = !!(n.panel && n.panel.length);
    const hasNo = !!(n.noPanel && n.noPanel.trim());
    if (!hasPanel && !hasNo) out.push(`${n.id} にパネルの言葉（panel）も、持たない理由（noPanel）も無い＝流れを足してパネルを決めていない`);
    if (hasPanel && hasNo) out.push(`${n.id} は panel と noPanel の両方を持っている`);
  }
  const ps = panelPhases(nodes);
  const byKey = new Map<string, FlowPanel & { nodeId: string }>();
  for (const p of ps) {
    if (byKey.has(p.phase)) out.push(`パネルの段 ${p.phase} が重なっている`);
    byKey.set(p.phase, p);
  }
  for (const k of PANEL_PHASE_KEYS) if (!byKey.has(k)) out.push(`パネルの段 ${k} が地図に無い`);
  const seenNow = new Map<string, string>();
  const seenShort = new Map<string, string>();
  for (const p of ps) {
    if (!p.now.trim() || !p.next.trim()) out.push(`${p.phase} の いま／つぎ が空`);
    if (p.now === p.next) out.push(`${p.phase} の いま と つぎ が同じ言葉`);
    if (seenNow.has(p.now)) out.push(`「${p.now}」が ${seenNow.get(p.now)} と ${p.phase} で同じ＝古い言葉が別の段に残る`);
    seenNow.set(p.now, p.phase);
    if (!p.short.trim()) out.push(`${p.phase} に要の語（short）が無い`);
    if (seenShort.has(p.short)) out.push(`要の語「${p.short}」が ${seenShort.get(p.short)} と ${p.phase} で重なる`);
    seenShort.set(p.short, p.phase);
    if (!p.then.length) out.push(`${p.phase} に次の段（then）が無い`);
    for (const t of p.then) {
      const tp = byKey.get(t);
      if (!tp) { out.push(`${p.phase} の then ${t} が地図に無い`); continue; }
      if (!p.next.includes(tp.short)) out.push(`${p.phase} の「つぎ」(${p.next}) に、次の段 ${t} の要の語「${tp.short}」が無い＝つぎが次を指していない`);
      if (tp.nodeId !== p.nodeId && !panelNeighbors(p.nodeId, nodes).has(tp.nodeId)) {
        out.push(`${p.phase}（${p.nodeId}）から ${t}（${tp.nodeId}）へ、パネルの言葉を持たない手だけを通る地図の道が無い＝地図に無い流れをパネルが言っている`);
      }
    }
    if (p.switchTo && !p.then.includes(p.switchTo)) out.push(`${p.phase} の switchTo ${p.switchTo} は then に無い`);
    // 切り替えの約束は手順書の文にも書く（パネルの言葉を直したのに手順書の文が古いまま、を止める）
    if (p.switchTo) {
      const node = flowNode(p.nodeId, nodes);
      const to = byKey.get(p.switchTo);
      const pb = node?.playbook || "";
      if (to && !pb.includes(`「${to.now}」`)) out.push(`${p.nodeId} の手順書の文に、切り替え先のパネルの言葉「${to.now}」が無い`);
      if (!pb.includes(`「${p.now}」`)) out.push(`${p.nodeId} の手順書の文に、切り替え前のパネルの言葉「${p.now}」（のままにしない）が無い`);
    }
  }
  // 輪: reset から全部に着き、done から reset へ戻る
  if (byKey.has("reset")) {
    const seen = new Set<string>();
    const stack: string[] = ["reset"];
    while (stack.length) {
      const k = stack.pop() as string;
      if (seen.has(k)) continue;
      seen.add(k);
      for (const t of byKey.get(k)?.then || []) stack.push(t);
    }
    for (const k of PANEL_PHASE_KEYS) if (byKey.has(k) && !seen.has(k)) out.push(`パネルの段 ${k} に reset からたどり着けない（孤立）`);
    if (byKey.has("done") && !byKey.get("done")!.then.includes("reset")) out.push("done の次は reset でなければならない（客完了→リセットへ戻る）");
  }
  return out;
}

/**
 * 待ちの見える化（2.8.325・竹内さん 2026-11-27「待機中や待機している時間もちゃんとボックスに表示／ボックスにも細かく何しているか表示」）。
 *   待ちは「いま」の行の中に、残りの秒数つきで出す（拡張の枠の #axlx-wait）。言葉は地図が正本。
 *   拡張の写し（bulk-dl.js・background.js の WAIT_WORDS）は scripts/gen-panel-words.ts が作る。
 */
export type FlowWait = {
  id: string;
  /** どの手の中で起きる待ちか */
  nodeId: string;
  /** 枠に出す言葉（何を待っているか。秒数は枠が後ろに付ける） */
  label: string;
  minMs: number;
  maxMs: number;
};

export const LOOP_WAITS: ReadonlyArray<FlowWait> = [
  { id: "search_to_sort", nodeId: "sort", label: "検索の結果が画面に出きるまで待っている（並べ替えは検索確認から40〜50秒後）", minMs: 40000, maxMs: 50000 },
  { id: "sort_lag", nodeId: "sort", label: "高→低を押したあと、並べ替えの画面が追いつくまで待っている", minMs: 15000, maxMs: 20000 },
  { id: "sort_resume_lag", nodeId: "sort", label: "読み直したあと、並べ替えの画面が追いつくまで待っている", minMs: 15000, maxMs: 20000 },
  { id: "reset_settle", nodeId: "reset", label: "リセットを押して、画面が空になるまで待っている（30〜34秒）", minMs: 30000, maxMs: 34000 },
  { id: "reset_hidden", nodeId: "b_reset_hidden_wait", label: "リアプロのタブが見えないので、リセットを押さずに待っている（Chrome を前に出してください）", minMs: 600000, maxMs: 600000 },
  { id: "reset_insure", nodeId: "b_reset_insure", label: "完了の通知が来ないので、さらに60〜90秒待ってから画面を確かめている", minMs: 60000, maxMs: 90000 },
  // 2026-11-27 竹内さん「完了の20秒以降にリセットする」「作業ごとに完了してから20秒あける」
  { id: "reset_gap", nodeId: "reset_front", label: "送付が終わったので、20秒あけてからリセットへ進んでいる", minMs: 20000, maxMs: 20000 },
  { id: "reset_done_gap", nodeId: "reset", label: "リセットで空を確かめたので、20秒あけてから次のお客さんの条件を読み直している", minMs: 20000, maxMs: 20000 },
  { id: "api_reload_gap", nodeId: "api_reload", label: "条件を読み直したので、20秒あけてから入れている", minMs: 20000, maxMs: 20000 },
];

/** 拡張の写し（WAIT_WORDS）の本文。id → 枠に出す言葉 */
export function renderWaitWordsJs(varName: string = "WAIT_WORDS", waits: ReadonlyArray<FlowWait> = LOOP_WAITS): string {
  const lines = waits.map((w, i) => `    ${w.id}: ${JSON.stringify(w.label)}${i < waits.length - 1 ? "," : ""}`);
  return [`  var ${varName} = {`, ...lines, "  };"].join("\n");
}

/** 待ちの点検: id が重ならない・どの手にあるか（地図に在る）・言葉が空でない・秒数が正しい */
export function checkWaits(waits: ReadonlyArray<FlowWait> = LOOP_WAITS, nodes: ReadonlyArray<FlowNode> = LOOP_FLOW_NODES): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const w of waits) {
    if (ids.has(w.id)) out.push(`待ちの id が重なっている: ${w.id}`);
    ids.add(w.id);
    if (!flowNode(w.nodeId, nodes)) out.push(`${w.id} の手（${w.nodeId}）が地図に無い＝どの手の待ちか分からない`);
    if (!w.label || !w.label.trim()) out.push(`${w.id} の言葉（label）が無い＝枠に何を待っているか出せない`);
    if (!(w.minMs > 0) || !(w.maxMs >= w.minMs)) out.push(`${w.id} の秒数が正しくない（min=${w.minMs} max=${w.maxMs}）`);
  }
  return out;
}

/**
 * 手順書の一覧の手のうち ④から先（④・④の場合分け・⑤客完了）を、地図から作る。
 *   ・④ の文に「押す物が無い時は下の『④の1〜n』＝④の場合分け。順に行う手ではない」を自動で入れる
 *   ・branch は「④の k（④の場合分け）」。通し番号は付けない
 *   ・join は次の通し番号（⑤）
 */
export function renderListPressSteps(
  nodes: ReadonlyArray<FlowNode> = LOOP_FLOW_NODES,
  firstNo: number = LIST_PRESS_FIRST_NO,
): string[] {
  const press = nodes.find((n) => n.id === "list_press");
  if (!press) throw new Error("list_press が地図に無い");
  const no = CIRCLED[firstNo] || String(firstNo);
  const brs = branchesOf(press.id, nodes);
  const range = brs.length ? `${no}の1〜${brs.length}` : "";
  const steps: string[] = [];
  // 押す物の「押したことの把握」は、その手の文の後ろに地図から付ける（手順書に手で書かない）
  const sfx = (id: string) => pressLinesOf(id, nodes).map((t) => `。${t}`).join("");
  steps.push(
    `${no}${press.playbook}` +
      (brs.length
        ? `（押せる行＝送付済みでない行がある時。押す物が無い時は下の「${range}」＝${no}の場合分け。順に行う手ではない）`
        : "") +
      sfx(press.id),
  );
  brs.forEach((b, i) => steps.push(`${no}の${i + 1}（${no}の場合分け）${b.playbook}${sfx(b.id)}`));
  const join = nodes.find((n) => n.kind === "join");
  if (join && join.playbook) {
    const jno = CIRCLED[firstNo + 1] || String(firstNo + 1);
    steps.push(`${jno}客完了（${brs.length ? `${no}で送り終えた・${range}のどれでも` : `${no}で送り終えた`}）→${join.playbook}${sfx("reset")}`);
  }
  return steps;
}

/**
 * 改善した中身が、手順書の手に載っているか（2026-11-27 竹内さん「改善する際、手順書の部分を細かく徹底的に強化」）。
 *   決まりを1行足すだけでは足りない。③は地図の「並べ替えは完了」の文をそのまま含む。
 *   ④は地図の「物件取得」の文をそのまま含む。どちらかを手順書から消すと、ここが止める。
 */
export function checkListPlaybookStrength(
  steps: readonly string[],
  nodes: ReadonlyArray<FlowNode> = LOOP_FLOW_NODES,
): string[] {
  const out: string[] = [];
  const sort = flowNode("sort", nodes);
  const press = flowNode("list_press", nodes);
  const s3 = steps.find((s) => s.startsWith("③"));
  const s4 = steps.find((s) => s.startsWith("④") && !s.startsWith("④の"));
  if (!sort?.playbook) out.push("sort に手順書の完了の文（playbook）が無い");
  else if (!s3 || !s3.includes(sort.playbook)) out.push("③に地図の「並べ替えは完了」の文が無い（コードだけ直して手順書が古いまま）");
  if (!press?.playbook) out.push("list_press に手順書の文（playbook）が無い");
  else if (!s4 || !s4.includes(press.playbook)) out.push("④に地図の物件取得の文が無い（コードだけ直して手順書が古いまま）");
  if (s3 && !/高→低/.test(s3)) out.push("③に高→低が無い");
  if (s4 && !/順に行う手ではない/.test(s4)) out.push("④が、場合分けは順に行う手ではない、と言っていない");
  const blob = steps.join("\n");
  for (const w of ["並べ替えは完了", "読み直した一覧", "④物件取得", "物件取得最中", "並べ替え最中"]) {
    if (!blob.includes(w)) out.push(`手順書の一覧に「${w}」が無い`);
  }
  return out;
}

// ── 押したことの把握（2.8.328）─────────────────────────────────────

/** ボタンを押す手（押す物が無い手＝読み直し・客完了・止まり は除く）。ここに挙げた手は presses が必須 */
export const PRESS_REQUIRED_NODES: ReadonlyArray<string> = ["reset", "fill", "search", "sort", "list_press", "b_all_sent_next"];

/** 手順書に載せる「押したことの把握」の1文（地図から作る。手で書かない） */
export function pressLine(p: FlowPress): string {
  return `押したことの把握（${p.button}）: 押した＝${p.receipt.join("・")}／効いた＝${p.effectJa}（${p.effect.join("・")}）／効かない時＝${p.onFail}`
    + (p.gate ? "。効いたのを見てから次の手へ" : "");
}

/** その手の押す物の文（手順書の手の末尾に付ける） */
export function pressLinesOf(nodeId: string, nodes: ReadonlyArray<FlowNode> = LOOP_FLOW_NODES): string[] {
  return (flowNode(nodeId, nodes)?.presses || []).map(pressLine);
}

/**
 * 押す物の形の点検（悪い地図を止める）:
 *   ・押す手に presses が在る ・受領／効いた／失敗の印が在る ・押した印と効いた印が同じでない（押した≠効いた）
 *   ・効いたを待たない（gate=false）なら、効かない時の文に「記録」がある（黙って進まない）
 */
export function checkPresses(nodes: ReadonlyArray<FlowNode> = LOOP_FLOW_NODES): string[] {
  const out: string[] = [];
  for (const id of PRESS_REQUIRED_NODES) {
    const n = flowNode(id, nodes);
    if (!n) { out.push(`押す手 ${id} が地図に無い`); continue; }
    if (!n.presses || !n.presses.length) out.push(`${id} はボタンを押す手なのに押す物（presses）が無い＝押したか分からない`);
  }
  for (const n of nodes) {
    for (const p of n.presses || []) {
      const tag = `${n.id}「${p.button}」`;
      if (!p.receipt.length) out.push(`${tag} に押した受領の印が無い`);
      if (!p.effect.length) out.push(`${tag} に効いた印が無い（押した＝効いた、と取り違える）`);
      if (!p.fail.length) out.push(`${tag} に押せなかった・効かなかった印が無い`);
      if (p.receipt.some((r) => p.effect.includes(r))) out.push(`${tag} の押した印と効いた印が同じ（押した≠効いた）`);
      if (!p.effectJa.trim()) out.push(`${tag} に効いたとみなす画面の変化（effectJa）が無い`);
      if (!p.onFail.trim()) out.push(`${tag} に効かない時の動き（onFail）が無い`);
      if (!p.gate && !/記録/.test(p.onFail)) out.push(`${tag} は効いたのを待たないのに、効かない時に記録すると書いていない（黙って進む）`);
      if (!p.evidence || !p.evidence.file || !p.evidence.token) out.push(`${tag} にコードの目印が無い`);
      // リセットは録画の場面が無い（手順書のリセットの手に直接載せる）。それ以外は手順書の手と結ぶ
      if (!p.playbookStep && n.id !== "reset") out.push(`${tag} が手順書の手と結ばれていない（playbookStep が無い＝手の文に把握が載らない）`);
      if (p.playbookStep) {
        if (!p.playbookStep.scenes.length || !p.playbookStep.fields.length) out.push(`${tag} の playbookStep に場面か欄名が無い`);
        if (p.playbookStep.after && !p.playbookStep.when) out.push(`${tag} は毎回の手なのに after がある（after は録画に無い時に足す要る時だけの手の置き場所）`);
      }
    }
  }
  return out;
}

/** 手順書の手に、地図の押す物の文がそのまま載っているか（コードだけ直して手順書が古いまま、を止める） */
export function checkPressPlaybook(playbookText: string, nodes: ReadonlyArray<FlowNode> = LOOP_FLOW_NODES): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    for (const p of n.presses || []) {
      if (!playbookText.includes(pressLine(p))) out.push(`手順書に ${n.id}「${p.button}」の押したことの把握の文が無い`);
    }
  }
  return out;
}
