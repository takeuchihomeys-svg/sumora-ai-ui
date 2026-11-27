// app/lib/action-playbook.ts — 動き方の手順書（束から作る純関数・DB を使わない）
//
// 竹内さん「動き方をちゃんと学習して、無駄に計算や API をたたかなくて済むように」
// 「細部までこだわって、ちゃんとした抜けのない手順書をつくれるように」（2026-11-20）。
//
//   束（human_learn_profile.bundle）の `scene_flows` は、場面ごとに「人が実際に押した欄の並び」を持つ。
//   手順書は、その並びを次の形に組み直した、小さくて版の付いた物:
//     ① 値（区名・間取り・数字）は手順から外す（それは「そのお客様の検索の中身」であって手順ではない）
//     ② 欄の名前は人が読む名前にする（PLAYBOOK_FIELD_JA。確かめた名前だけ）
//     ③ 同じ名前が連続したら1つにする（押し直しの二重記録を畳む）
//     ④ 分からない名前は「未分類」として残す（地名か欄か人が確かめる候補・黙って消さない）
//   ⚠ 材料に `site_flow` は使わない（押した要素の名前の集計で、場面の順番にならない＝実測で 287件が場面不明）。
//   ⚠ 順番の数（variants）は束の作り（学習側）の数え方のまま＝区名などの値の違いも数えている。
//     手順書はそれを「値を含む数」と明示する（型の数はまだ決まっていない）。学習側の数え方は変えない
//     （テスト learn-flow-steps が「どの区を選んだか」を残す仕様として固定している）。
//   ⚠ 新しい表は作らない（DB の構造は変えない）。拡張への配り方は竹内さんの OK の後（ここでは作るだけ）。
//   ⚠ 統括（Pro）の判断は入れない。ここは決定論（数えて並べて検査するだけ）。

import { SCENE_JA } from "./learn-flow-steps";
import { AUTO_RULES, RULE_SCENE_JA, RULES_CODE_ONLY, verifyKeysOf, type RuleScene } from "./auto-procedure-rules";
import { ITANDI_AUTO_RULES, rulesReviewedUpToFor, rulesVersionFor } from "./auto-itandi-rules";
import { itandiAliasesOf } from "./itandi-field-aliases";
import { LAG_GRACE_TEXT, RESET_BUTTON_SIZE, RESET_PRESS_WAIT_TEXT, RESET_WAIT_TEXT, SEARCH_REVIEW_TEXT, SORT_AFTER_SEARCH_TEXT } from "./reset-facts";
import { isAllowedMotionFieldName, sanitizeLearnedForSite } from "./human-motion-sanitize";

/** 場面の確かさ: 3回以上の検索で出た＝solid（手順として使える）／1〜2回＝thin（薄い・人が1回確かめる候補） */
export const PLAYBOOK_SOLID_RUNS = 3;
/** 手順に載せる欄の数の上限（長い手順は先頭だけ） */
export const PLAYBOOK_MAX_STEPS = 12;
/**
 * 手順書の作り方の版（欄の名前・値の判定を変えたら上げる。版の印に入る）
 *   3（2026-11-20）: 1手ずつの細部（押す欄・押す位置・開く物）と、自動の決まり（auto-procedure-rules.ts）を載せる。
 *   4（2026-11-20）: 押す位置に source を付けた（その欄で測った／写し）。
 *   5（2026-11-20）: source を field／alias（同じ欄の別名へ写した測った値）／mismatch（開くボタンにチェック欄の位置が写った）の3つに。
 *     4 では alias（賃料上限 等の正しい測り）まで「写し」にしていた。数は positions_alias／positions_mismatch。
 *   6（2026-11-20）: 決まりごとに点検記録で確かめる段（verified_by）を載せ、確かめる印が無い決まりを gaps に出す。
 *   7（2026-11-22）: 一連の流れ（flow_series）を載せる。場面が並ぶだけでは足りず、外し→確定→駅/地域→検索→一覧→次→次客の把握線を1本にする。
 *   8（2026-11-23）: list に AD 並べ替え①②③④を固定で載せる（録画が PDF だけでも抜けない）。
 *   9（2026-11-23）: search に検索把握の手／area に確定してリストへ／clear・switch・pet を extra_guides で載せる（場面なし・薄い録画の穴）。
 *   10（2026-11-23）: 録画が station だけでも area/cond/search/list を薄いガイド場面として scenes に足す（連続客の外し→入れが手順書から抜けない）。
 *   11（2026-11-23）: clear extra_guides を入れる並みに細分化（外す前の名前付き把握→箱ごと1つずつ→駅小窓経由→外し後名確認→入れへ）。
 *   12（2026-11-23）: flow_series 先頭に before_clear（外す前の名前付き把握）。外し後→入れの段が抜けない線。
 *   13（2026-11-23）: clear_then_fill（外し完了→入れ）を一連に明示。物件取得完了→外す→入れ→検索→並び替え→取得→次客の把握線。
 *   14（2026-11-26 竹内さん「1つずつ外すのはボトルネックなので抜く」）: 骨組みの外しを「1つずつ外す」からリセットボタンへ。
 *     flow_series の before_clear／clear_then_fill／after_clear にリセットの印（reset_press／reset_wait／reset_verified 等）、
 *     extra_guides の clear／switch をリセット→30秒以上のラグ待ち→空の確認→入れへ。1つずつ外すのは「リセットが効かない時の最後の保険」だけ。
 */
export const PLAYBOOK_BUILD_V = 26;
// 26（2026-11-27 竹内さん「全部送付済み→次へで次のページ／次ページも全部送付済み・検索結果0件でも、リセットして次のお客さんへ。リセットからの流れは同じ」「アナウンスも手順書とあわせる」）: 一覧の手に ④の場合分け（④の1 全部送付済み→次へ／④の2 次頁も全部送付済み→客完了／④の3 0件→客完了）と ⑤客完了→リセットして次客へ を足した。パネルの言葉も手順書と同じ（PANEL_PHASE_WORDS）。
// 25（2026-11-27 竹内さん「読み直しが失敗したら、古い条件では検索せず、その客を飛ばして理由を残す」）: 次客の条件を読み直せなかったら、古い条件で検索せず飛ばす（拡張 2.8.318・customer_api_reload に理由）。手順書の文もそれに合わせた。
// 24（2026-11-27 竹内さん「リセットは多すぎてバグる・30〜34秒だけに／1人目はリセットしない／検索前10秒／並べ替え40〜50秒＋猶予15秒〜／次客の条件を毎回APIから読み直す」）:
//   ループを簡素にした（拡張 2.8.317）。リセット＝押して30〜34秒待つだけ（空の読み戻し・写真・猶予なし）。最初の客と前客リセット済みの客は入れる前にリセットしない。
//   検索は条件を入れ終えて9〜12秒見直してから。並べ替えは検索確認から40〜50秒・押した後の猶予15〜20秒。
//   次客の条件を拡張ツールからAPIで毎回読み直して空のフォームへ入れる手（next_customer_api_reload）を clear／switch の手に太く入れた。lag_grace_after_reset は廃止。
// 23（2026-11-27 竹内さん「まだ文に無い時間もなおす」）: 裏のリセットの押す待ち（130秒）・並べ替えの窓（待ち＋120秒／入力後150秒）・並べ替えの待ちの印（90秒で古い印）・見張りの再試行（45秒）を文に入れた。
// 22（2026-11-27）: 場面の手順（area／cond／station／list／search／next）に、press（押す前後の人の間など全部の場面に効く決まり）も「この場面に効く決まり」として並べた。
//   これまでは playbook.rules（一覧）にだけ載っていて、場面の手順から辿れなかった。
// 21（2026-11-27 竹内さん「手順書に決まりとして文が無いところは漏れる」）: 追加ガイド clear／switch の手に、空の確認（最大25秒）・写真（2〜4秒の間・撮影最大25秒）・
//   従来の外し（最大125秒）・次の客までの間（8〜25秒・ときどき40〜95秒）を入れ、clear／switch の決まりを追加ガイドに全部つないだ（一覧にしか無かった物を場面から辿れるように）。
// 20（2026-11-27 竹内さん「手順書に抜けが無いか・時間を細かく」）: リセットの押す待ち（最大120秒）と、押した後のラグ猶予（5〜9秒・並べ替え／リセット）を
//   骨組み（before_clear）・追加ガイド（clear の②③）・一覧（AD並べ替えの③）の文に入れた。決まりの一覧に reset_press_late_grasp・lag_grace_after_reset を載せた。
// 19（2026-11-27）: cleanPoints で値データ（147,000円 等）を除外し、points にまだ無い欄は shots.learned の画面位置（source: "screen"）を
//   手順書の positions / detail.aim に活用。ITANDI は itandi-field-aliases で別名も引き当て、rules_up_to をサイト別に分離。
// 15（2026-11-26 竹内さん「手順書これでできてる？」）: itandi の手順書にリアプロ専用の手（並べ替え AD・印刷用PDF・検索の把握）が
//   入っていた。ITANDI は並べ替えが無い（auto-search-plan.ts）。buildPlaybook に site を渡し、itandi では載せない。
//   site を渡さない時（既定）は今までどおり＝リアプロの動きは変えない。
// 16（2026-11-26 竹内さん「まだ残っていることも改善お願い」）: itandi の手順書から、リアプロ用の決まり一覧・一連の流れ・
//   追加ガイド（リセット幅160×30・30秒待ち・確定してリスト）を外し、itandi 用の流れと外し方（チップ・打つ欄・チェック）に替えた。
//   itandi の欄「room_layout:in」を「間取りの欄（チェック）」に。realpro の出力は変えない。
// 17（2026-11-27）: ITANDI_FLOW_SERIES を実際の search_audits.steps 形式（page: 接頭辞＋dl:it_list / dl:it_next / dl:it_handoff /
//   page:search_press）に統一し、PLAYBOOK_FIELD_JA に ITANDI の実在欄（リスト検索・所在地で絞り込み・小窓の確定・rent:lteq 等）を追加。
// 18（2026-11-27）: リアプロ手順書から ITANDI・ゴミ欄（#_r_* / css-* / input / ----- 等）と爆発点（0.5,0.5）を buildPlaybook 入口で除外。
//   list 4手目「④並べ替え後に印刷用PDFを押す」の field 誤判定（「並べ替え」になっていた）を「印刷用PDF」に修正し、
//   list/search/area のガイド手にも実測 aim/opens（高→低・印刷用PDF・検索・確定・所在地開き・one_line/one_station/one_city 集約）を引くようにした。

/**
 * 一連の流れ（客1人）。手順書の場面（area/cond/…）とは別に、「次に進んでよいか」の把握段。
 *   拡張は `page:flow_series_at` / `page:flow_series_ok` を残し、統括・点検が抜けを名指しする。
 */
export type PlaybookFlowPhase = {
  id: string;
  label: string;
  /** 紐づく場面（scene_flows）。無い段もある（外し・次客） */
  scene: string | null;
  /** この段を把握した印（点検記録の k） */
  grasp: string[];
  next: string | null;
};

export const PLAYBOOK_FLOW_SERIES: ReadonlyArray<PlaybookFlowPhase> = [
  /** ★ build_v12: 外す前の把握が一連から抜けていた（after_clear だけだと「外してから」しか測れない） */
  {
    id: "before_clear",
    label: `リセットを押す（送付のあと1回だけ・左の「リセット」→${RESET_PRESS_WAIT_TEXT}→読み直し→${RESET_WAIT_TEXT}待つだけ＝空とみなす。最初のお客さんと前客リセット済みの客は入れる前に押さない）`,
    scene: null,
    // ★ build_v14: 外しは「1つずつ外す」ではなくリセットボタン。押下・待ち・空確認の印を先頭に（旧の外す前把握の印も残す＝古い拡張の記録も拾う）
    grasp: ["reset_press", "reset_wait", "reset_before_fill", "page:guide_clear_grasp", "page:guide_clear_detail", "page:leftover_scan", "page:guide_clear_clean"],
    next: "clear_then_fill",
  },
  {
    id: "clear_then_fill",
    label: "空とみなした→次客の条件をAPIから読み直して入れへ",
    scene: null,
    grasp: ["reset_settled", "customer_api_reload", "reset_verified", "page:clear_then_fill_ok", "page:next_move_grasp", "page:loop_phase_grasp"],
    next: "after_clear",
  },
  {
    id: "after_clear",
    label: "前客のリセット完了（フォームが空）→入れへ",
    scene: null,
    grasp: ["reset_settled", "reset_verified", "page:reset_clean_skip_clear", "page:guide_phase_after_clear", "page:leftover_after_clear", "page:clear_then_fill_ok", "page:clear_done"],
    next: "after_confirm",
  },
  { id: "after_confirm", label: "確定してリストへ（入れた把握）", scene: "area", grasp: ["page:guide_phase_after_confirm"], next: "after_place" },
  { id: "after_station", label: "駅の設定完了", scene: "station", grasp: ["page:guide_phase_after_station"], next: "after_place" },
  { id: "after_area", label: "地域の設定完了", scene: "area", grasp: ["page:guide_phase_after_area"], next: "after_place" },
  { id: "after_place", label: "場所全体のあと", scene: "area", grasp: ["page:guide_phase_after_place"], next: "before_search" },
  { id: "before_search", label: "検索前の照合", scene: "cond", grasp: ["page:guide_phase_before_search", "page:conditions_ready"], next: "after_search" },
  { id: "after_search", label: "検索押下の把握（並べ替えの前）", scene: "search", grasp: ["page:guide_phase_after_search", "dl:search_grasp_gate", "page:search_customer_grasp_ok"], next: "sort_ad" },
  /**
   * ★ 2026-11-23 竹内さん「並べ替えのADの部分だとわかりやすく手順書に」:
   *   検索把握の次は必ず ①並べ替え→②AD→③高→低。印刷用PDFはその後。
   */
  { id: "sort_ad", label: "①並べ替え→②AD→③高→低", scene: "list", grasp: ["dl:sort_head_hover", "dl:sort_ad_hover", "dl:sort_hilo", "dl:sort_done", "dl:sort_menu"], next: "list" },
  { id: "list", label: "一覧・印刷用PDF（並べ替え後）", scene: "list", grasp: ["dl:list_flow_grasp", "page:guide_phase_ok", "dl:auto_pdf_start"], next: "next" },
  { id: "next", label: "次ページ（この頁が全部送付済みなら「次へ」で次のページへ・次頁も全部送付済み／最後まで来たら客完了）", scene: "next", grasp: ["dl:next_flow_grasp"], next: "handoff" },
  { id: "handoff", label: "客完了（送付済みのみ・次頁も全部送付済み・検索結果0件・送って終わり、どれも同じ）→リセットして次客へ（次客の条件は毎回APIから読み直して入れる＝customer_api_reload）", scene: null, grasp: ["dl:handoff_grasp", "flow_handoff_ok", "page:flow_done_ready_next"], next: null },
];

/**
 * itandi の一連の流れ（客1人・2026-11-27 修正）。リアプロの段（確定してリスト・並べ替え・印刷用PDF）は itandi に無いので載せない。
 *   itandi-page-script.js の _itStep は background/search-audit.js の pushPageStep で "page:" が付く。
 *   旧版は "page:" 抜き（"reset_start" 等）になっていたため、実測 search_audits.steps と1件も一致しなかった。
 *   一覧・次ページ・客完了は itandi-bulk-dl.js の _itLiveStep（dl:it_list / dl:it_next / dl:it_handoff）で残す。
 */
export const ITANDI_FLOW_SERIES: ReadonlyArray<PlaybookFlowPhase> = [
  { id: "before_clear", label: "前のお客さんの条件を外す（条件削除のボタンがあれば先に）", scene: null, grasp: ["page:reset_start", "page:reset_confirm"], next: "clear_then_fill" },
  { id: "clear_then_fill", label: "空と読み戻せた→新条件の入れへ", scene: null, grasp: ["page:fill_start"], next: "after_clear" },
  { id: "after_clear", label: "外せた（reset）→入れへ", scene: null, grasp: ["page:reset"], next: "after_confirm" },
  { id: "after_confirm", label: "所在地（区）の設定", scene: "area", grasp: ["page:location"], next: "after_place" },
  { id: "after_station", label: "路線・駅の設定", scene: "station", grasp: ["page:lines_done"], next: "after_place" },
  { id: "after_area", label: "地域の設定", scene: "area", grasp: ["page:location"], next: "after_place" },
  { id: "after_place", label: "場所全体のあと", scene: "area", grasp: ["page:lines_done", "page:location"], next: "before_search" },
  { id: "before_search", label: "検索前の照合（条件）", scene: "cond", grasp: ["page:fill_start"], next: "after_search" },
  { id: "after_search", label: "検索を押す", scene: "search", grasp: ["page:search_press"], next: "list" },
  { id: "list", label: "一覧", scene: "list", grasp: ["dl:it_list"], next: "next" },
  { id: "next", label: "次ページ", scene: "next", grasp: ["dl:it_next"], next: "handoff" },
  { id: "handoff", label: "客完了→次客へ", scene: null, grasp: ["dl:it_handoff"], next: null },
];

/** 一覧場面に必ず載せる AD 並べ替えの手（録画が印刷用PDFだけでも手順書から抜けない） */
export const PLAYBOOK_LIST_AD_SORT_STEPS: ReadonlyArray<string> = [
  `①並べ替えへカーソルを置く（クリックしない・検索確認（把握）から${SORT_AFTER_SEARCH_TEXT}の待ちのあと＝検索後は画面が固まるので早すぎたら追いつけない。待ちは1本だけ。並べ替えの窓は予約で待ち＋120秒、入力が終わったあとは150秒。並べ替えの待ちの印は120秒を過ぎたら古い印として外して張り直す）`,
  "②メニュー内のADへカーソルを置く（クリックしない・一覧のAD列は禁止）。カーソルの動きが途切れたら0.4〜0.9秒あけて1回だけ動かし直す（sort_mouse_retry）",
  `③ADの右の「高→低」（span.sort_detail）だけクリック。押したあと${LAG_GRACE_TEXT}の猶予（ラグ・並べ替えの画面が追いつくまで一覧を取らない）`,
  "④並べ替え後に印刷用PDFを押す（押せる行＝送付済みでない行がある時。押す物が無い時は下の「④の1〜3」＝④の場合分け。順に行う手ではない）",
  // ★ 2.8.319 竹内さん「全部送付済みなら次へで次のページ／次ページも全部送付済み・検索結果0件でも、リセットして次のお客さんへ。リセットからの流れは同じ」
  "④の1（④の場合分け）この頁の行が全部「送付済み」なら、印刷用PDFは押さず「次へ」で次のページへ移る（止まらない・all_sent_page）",
  "④の2（④の場合分け）次のページも全部送付済みなら、また「次へ」。最後のページまで全部送付済みなら新しい物件なしとして客完了（all_sent_done）",
  "④の3（④の場合分け）検索結果が0件（0棟0戸）の時も、行が出るのを待ち続けず客完了にする（zero_count0_finish）",
  "⑤客完了（④で送り終えた・④の1〜3のどれでも）→リセットを押して次のお客さんへ。リセットからの流れは同じ（リセット→30〜34秒待つ→空とみなす→次客の条件をAPIから読み直して入れる→検索）",
];

/**
 * 検索場面に必ず載せる把握の手（録画が「検索を押す」1手だけだと、把握→並べ替えが手順書から抜ける）
 *   ★ 2026-11-23 竹内さん「検索の理解の部分はちゃんとできているのか」
 */
export const PLAYBOOK_SEARCH_GRASP_STEPS: ReadonlyArray<string> = [
  `①条件を入れ終えたら、${SEARCH_REVIEW_TEXT}見直す間をあけてから検索ボタンを押す（検索後は画面が固まるので入れてすぐ押さない・search_review_wait）`,
  "②検索したことを手順書×画面で把握する（並べ替え見出し／棟戸／印刷用PDFが見える。まだ動かない時は次の撮影・次手まで45秒あける）",
  `③把握OKのあと${SORT_AFTER_SEARCH_TEXT}待って並べ替え（AD）へ進む（印刷用PDFは並べ替えの後・把握なしでは並べ替えしない）`,
];

/**
 * 所在地（area）に必ず載せる確定の手（録画が区の欄だけだと「確定してリストへ」が抜ける）
 */
export const PLAYBOOK_AREA_CONFIRM_STEPS: ReadonlyArray<string> = [
  "①所在地絞り込みを開く",
  "②欲しい区（必要なら町）を選ぶ",
  "③確定してリストへを押す（入れた把握のあと条件へ）",
];

/** 条件場面が録画に無い時の薄いガイド（連続客で所在地外しだけで止まらない） */
export const PLAYBOOK_COND_GUIDE_STEPS: ReadonlyArray<string> = [
  "①【毎回・全員】入れる条件は、その客の最新を拡張ツールがAPIから読み直した値（古い手元のコピーでは入れない・customer_api_reload・next_customer_api_reload）。その条件の賃料・間取り・徒歩などを空のフォームへ1つずつ入れる（最初の客も2人目以降も同じ）",
  "②検索前に手順書×画面で入忘れ・外し忘れを確かめる",
  "③揃ったら検索ボタンへ進む（外しだけで終わらない）",
];

/** 録画場面が無い決まり専用の手（clear / switch / pet）。scenes には載せず extra_guides へ */
export type PlaybookExtraGuide = {
  id: string;
  label: string;
  steps: ReadonlyArray<string>;
  rules: ReadonlyArray<string>;
};

/** リセットで空にする今の形では載せない「1つずつ外す」の決まり（最後の保険の話だけ残す・試験 playbook-reset-skeleton が見張る） */
const RETIRED_ONE_BY_ONE: ReadonlySet<string> = new Set(["clear_one_by_one", "clear_per_panel", "ward_clear_one"]);

export const PLAYBOOK_EXTRA_GUIDES: ReadonlyArray<PlaybookExtraGuide> = [
  {
    id: "clear",
    label: "前客のリセット（場面なし・決まりから／1つずつ外さない）",
    steps: [
      "①送付が終わったら完了の小窓を閉じる（1つずつ外さない・箱ごとに開けて外す手は使わない）",
      `②左の「リセット」ボタン（${RESET_BUTTON_SIZE}）を人が押す形で押す（値は直接書き換えない）。${RESET_PRESS_WAIT_TEXT}`,
      `③ページの読み直しを待ち、ラグがあるので${RESET_WAIT_TEXT}人の間で待つ。待つだけ（2.8.317・竹内さん「30〜34秒のところだけでリセットすれば改善」）。空かの読み戻し・写真・猶予は置かない`,
      "④押して待ったら、フォームは空になっているとみなす（竹内さん「リセットしたら必ず空になっている」・reset_settled）。リセットは各客の送付のあと1回だけ（最初のお客さん・前客のリセットが済んだ客は、入れる前にも押さない＝first_customer_no_reset）",
      "⑤すぐ次客の条件を拡張ツールのAPIから読み直して（古い手元のコピーは使わない・失敗は2秒・4秒あけて最大3回・customer_api_reload）、空のフォームへそのまま入れる（next_customer_api_reload）",
      "⑥押せない・例外の時だけ：スクショを撮る→画面を読む（残り・小窓・読み込み中）→リセットをもう1回押す（reset_retry_insurance）。それでもだめな時だけ最後の保険として従来の外しへ（従来の外しは最大125秒・外す前後は残りを名前付きで1つずつ言う）",
    ],
    rules: [...new Set(["reset_replaces_clear", "reset_between_customers", "reset_empty_is_enough", "first_customer_no_reset", "next_customer_api_reload", "reset_retry_insurance", "clear_single_owner", "clear_detail_grasp", "clear_then_fill_gate", "reset_press_late_grasp", ...AUTO_RULES.filter((r) => r.scene === "clear" && !RETIRED_ONE_BY_ONE.has(r.id)).map((r) => r.id)])],
  },
  {
    id: "switch",
    label: "次客への切り替え（場面なし・決まりから）",
    steps: [
      "①手順書を読む（playbook_seen）",
      "②次のお客さんに切り替える（次の客までの間は8〜25秒・ときどき40〜95秒の人の間。リセットが成功した客は資料を見る間（1.8〜13秒）を置かない）",
      `③前客のリセット（送付のあと1回・左の「リセット」→${RESET_WAIT_TEXT}待つだけ＝空とみなす）。順は「前客の送付→リセット→次客の条件をAPIから読み直す→空のフォームへ入れる→検索」を守る（1つずつ外さない。最初のお客さんはリセットしない）`,
      "④【最重要】次のお客さんの条件は、毎回、拡張ツールからAPIで最新を読み込み直して入れ直す（古いコピーで入れない・失敗は2秒・4秒あけて最大3回・全部だめな時は古い条件では検索せず、このお客さんを飛ばして理由を残す（2.8.318））。これを毎回やることでループが安定する（竹内さん・2026-11-27「かなり重要」。印: customer_api_reload＝何回目で読めたか・条件が更新されていたか）",
    ],
    rules: [...new Set(["playbook_read", "reset_between_customers", "next_customer_api_reload", "first_customer_no_reset", "series_handoff_order", ...AUTO_RULES.filter((r) => r.scene === "switch").map((r) => r.id)])],
  },
  {
    id: "pet",
    label: "ペット条件（場面なし・決まりから）",
    steps: [
      "①絞り込み条件を開く",
      "②ペット相談など必要な欄だけ押す",
      "③確定してリストへを押してから検索へ",
    ],
    rules: ["pet_confirm"],
  },
];

/**
 * itandi 用の追加ガイド（外し・切り替え）。リアプロの「リセット→30秒待ち」とは別の手。
 *   itandi-page-script.js の _itResetForm／_itClearOnce の順（打つ欄→チェック→チップ×）に合わせる。
 *   ペット（pet）の場面は itandi では載せていない（itandi のペット条件の手をまだ確かめていない）。
 */
export const ITANDI_EXTRA_GUIDES: ReadonlyArray<PlaybookExtraGuide> = [
  {
    id: "clear",
    label: "前のお客さんの条件を外す（itandi・場面なし）",
    steps: [
      "①条件削除のボタンがあれば先に押す（無い画面が普通）",
      "②打つ欄（家賃・面積・駅徒歩・築年数など）を空にする",
      "③間取り・構造・設備のチェックを外す",
      "④所在地・路線/駅のチップを、×で1つずつ外す（外すたびに並びが変わるので、押す時に読み直す）",
      "⑤空と読み戻して、残りを名前付きで確かめる（空なら成功＝reset）",
      "⑥残るなら、もう1回だけ外す。それでも残る時は、このお客さんの itandi は飛ばす（AXLX_RESET_FAILED・前の条件が混ざった検索はしない）",
    ],
    rules: [],
  },
  {
    id: "switch",
    label: "次客への切り替え（itandi・場面なし）",
    steps: [
      "①次のお客さんに切り替える",
      "②前のお客さんの条件を外す（上の手順）",
      "③【毎回】次のお客さんの条件を、拡張ツールからAPIで最新を読み直す（古い手元のコピーでは入れない・失敗は2秒・4秒あけて最大3回・customer_api_reload）",
      "④空と確かめてから、読み直した新しい条件を入れる（fill_start）",
    ],
    rules: ["next_customer_api_reload"],
  },
];

/** 点検記録の段から、一連の流れのどこまで把握できたかを決める（純関数） */
export function judgeFlowSeriesProgress(
  steps: ReadonlyArray<{ k?: string } | string | null | undefined>,
  series: ReadonlyArray<PlaybookFlowPhase> = PLAYBOOK_FLOW_SERIES,
): {
  reached: string[];
  last: string | null;
  missing: string[];
  ok: boolean;
  why: string;
} {
  const keys = new Set<string>();
  for (const s of steps) {
    if (typeof s === "string") keys.add(s);
    else if (s && typeof s === "object" && typeof s.k === "string") keys.add(s.k);
  }
  const reached: string[] = [];
  for (const ph of series) {
    if (ph.grasp.some((g) => keys.has(g))) reached.push(ph.id);
  }
  const last = reached.length ? reached[reached.length - 1] : null;
  const missing = series.map((p) => p.id).filter((id) => !reached.includes(id));
  const ok = reached.includes("after_search") || reached.includes("sort_ad") || reached.includes("list") || reached.includes("handoff");
  const why = last
    ? `一連の流れ: 最後に把握した段=${last}（到達 ${reached.length}/${series.length}・未達 ${missing.slice(0, 4).join("・")}${missing.length > 4 ? "…" : ""}）`
    : `一連の流れ: どの段の把握印も無い（未達 ${series.map((p) => p.id).slice(0, 5).join("・")}…）`;
  return { reached, last, missing, ok, why };
}
/** 束がこれより古いと検査で「古い」と出す（束は夜に作り直す想定） */
export const PLAYBOOK_STALE_MS = 36 * 60 * 60 * 1000;

/**
 * 欄の名前 → 人が読む名前（リアプロの実際の欄名・実測で出た物だけ）。
 *   ⚠ ここに無い名前は「未分類」になる（推測で増やさない）。増やす時は実データの欄名を見てから。
 */
export const PLAYBOOK_FIELD_JA: Record<string, string> = {
  "所在地絞り込み＋": "所在地絞り込みを開く",
  "沿線・駅絞り込み＋": "沿線・駅絞り込みを開く",
  "city_code[]": "区の欄（チェック）",
  "town_code[]": "町字の欄（チェック）",
  "route_id[]": "沿線の欄（チェック）",
  "station_id[]": "駅の欄（チェック）",
  "駅の設定へ進む": "駅の設定へ進む",
  "沿線の設定へ戻る": "沿線の設定へ戻る",
  "transportation_id": "交通手段（徒歩など）",
  "required_time": "徒歩の分数",
  "rental_cost1": "賃料（下限）",
  "rental_cost2": "賃料（上限）",
  "structured_date": "築年数",
  "room_layout_id[]": "間取りの欄（チェック）",
  "update_date": "更新日",
  "include_common_fee": "管理費込みの欄",
  "確定してリストへ": "確定してリストへ",
  "検索": "検索を押す",
  "go_search": "検索を押す",
  // 2026-11-20 実測（自動 run_mwofi2sn_jbec の shot_ops に出た欄名）
  "絞り込み条件＋": "絞り込み条件を開く",
  "eq_rm[]": "ペットの欄（チェック）",
  "ペット相談": "ペット相談の欄（チェック）",
  "square_meter_l": "面積（下限）",
  "印刷用PDF": "印刷用PDFを押す",
  "次": "次のページへ",
  // 2026-11-23 実測: next 場面の欄名がページャー文言の連結で出る
  "最初前1234次最後": "次のページへ",
  "並べ替え": "並べ替えへカーソル（押さない）",
  "並び替え": "並べ替えへカーソル（押さない）",
  "AD": "ADへカーソル（押さない・一覧列禁止）",
  "高→低": "高→低を押す",
  "左の高→低｜span.sort_detail": "高→低（span.sort_detail）を押す",
  // 2026-11-26 itandi の実測（束の欄名）: 間取りのチェック欄（chrome-extension/itandi-form-guard.js の FILTER_ROWS で「間取り」）
  "room_layout:in": "間取りの欄（チェック）",
  // 2026-11-27 itandi 実データ（human_learn_profile #2824 / itandi-form-guard.js）の確定済み欄名
  "リスト検索": "検索を押す（ITANDI）",
  "所在地で絞り込み": "所在地で絞り込みを開く",
  "路線・駅で絞り込み": "路線・駅で絞り込みを開く",
  "小窓の確定": "小窓の確定を押す",
  "rent:lteq": "賃料（上限）",
  "rent:gteq": "賃料（下限）",
  "floor_area_amount:gteq": "面積（下限）",
  "floor_area_amount:lteq": "面積（上限）",
  "station_walk_minutes:lteq": "駅徒歩（上限）",
  "building_age:lteq": "築年数（上限）",
  "building_name:match": "建物名検索",
  "keyword": "キーワード検索",
  "structure_type:in": "構造の欄（チェック）",
  "option_id:all_in": "設備・条件の欄（チェック）",
  "offer_conditions_updated_at:gteq": "募集条件更新日",
  "敷金なし": "敷金なしの欄（チェック）",
  "礼金なし": "礼金なしの欄（チェック）",
  "物件資料": "物件資料を開く",
  "物件資料🔍SUUMO": "物件資料を開く",
};

/** 手順の1手の細部（押す欄・学んだ押す位置・押すと開く物） */
export type PlaybookStep = {
  /** 人が読む名前 */
  step: string;
  /** 押す欄の名前（束の名前・飾りを落とした物） */
  field: string;
  /** 学んだ押す位置（要素の中の割合／screen は画面全体の割合）。学んでいなければ null。source は PositionSource（mismatch は solid にしない） */
  aim: { x: number; y: number; n: number; confidence: "solid" | "thin"; source: PositionSource } | null;
  /** 押すと開く物（人が確かめて学んだ物だけ）。無ければ null */
  opens: string | null;
};

/** 手順書に載せる自動の決まり（auto-procedure-rules.ts の写し） */
export type PlaybookRule = {
  id: string;
  scene: RuleScene;
  scene_label: string;
  text: string;
  since: string | null;
  kb: string | null;
  /** 点検記録で確かめる段（無ければ空＝コードにあるかだけ確かめる） */
  verified_by: string[];
};

/** 場面の手順の1件（束の scene_flows を手順書の形にしたもの） */
export type PlaybookScene = {
  scene: string;
  /** 人が読む名前（SCENE_JA） */
  label: string;
  /** この場面が出た検索の数 */
  runs: number;
  /** 人の操作の数（畳んだ後） */
  ops: number;
  /** 一番よく出る順番（人が読む名前・値は外す・先頭 PLAYBOOK_MAX_STEPS 件） */
  steps: string[];
  /** 操作と操作の間（中央値 ms） */
  gap_ms: number | null;
  /** 順番の数（束の数え方のまま＝区名などの値の違いも含む） */
  variants: number;
  /** 手順から外した値の数（区名・間取り・数字など）＝検査用 */
  values_dropped: number;
  /** 分からない欄の名前（未分類・地名か欄か人が確かめる候補） */
  unknown: string[];
  confidence: "solid" | "thin";
  /** 1手ずつの細部（steps と同じ順・同じ数） */
  detail: PlaybookStep[];
  /** この場面に効く自動の決まり（id） */
  rules: string[];
};

/** 押す位置の1件（束の points の欄ごと・人が押した位置の票） */
export type PlaybookPosition = {
  field: string;
  n: number;
  w: string | null;
  x: number | null;
  y: number | null;
  confidence: "solid" | "thin";
  /** field: この名前で測った／alias: 同じ欄の別名へ写した測った値／screen: 写真学習の画面位置／mismatch: 開くボタンにチェック欄の位置が写った */
  source: PositionSource;
};

/** 開く欄の1件（束の opens・押すと何が開くか） */
export type PlaybookOpen = {
  field: string;
  opens: string | null;
  n: number;
  /** 推測のまま（人が開いて確かめていない） */
  guessed: boolean;
};

export type Playbook = {
  v: 1;
  /** 作り方の版 */
  build_v: number;
  /** 版（内容のハッシュ・同じ束＝同じ版） */
  version: string;
  /** 元にした束の作成時刻 */
  based_on: string;
  /** 場面の手順（束の順のまま） */
  scenes: PlaybookScene[];
  /**
   * 一連の流れ（客1人）。場面の並びとは別に「外し→確定→場所→検索→一覧→次→次客」の把握線。
   *   拡張は flow_series_at 印で今どこかを残す。
   */
  flow_series: PlaybookFlowPhase[];
  /** まだ1件も学んでいない場面（人が1回通して録る候補） */
  missing: string[];
  /** 押す位置の確かさ（全体の数） */
  points: { solid: number; thin: number };
  /** 押す位置の一覧（欄ごと・票の多い順。学んだ物を全部載せる） */
  positions: PlaybookPosition[];
  /** positions のうち同じ欄の別名へ写した数（測った値そのもの） */
  positions_alias: number;
  /** positions のうち開くボタンにチェック欄の位置が写った数（そのまま使えない） */
  positions_mismatch: number;
  /** 押すと開く欄の数（人が確かめて学んだ物だけ＝推測は数えない） */
  opens_known: number;
  /** 押すと開く欄の一覧（推測の印つき・全部載せる） */
  opens: PlaybookOpen[];
  /** 推測のまま・票0の開く欄の数 */
  opens_guessed: number;
  /** 束の `next`（押す順番の並び・次のページ送りではない）の数。次のページ送りは場面 next で判定する */
  next_n: number;
  /** ITANDI の押す順番（site_flow.itandi だけから作る・リアプロでは空）。リアプロの流れとは混ぜない */
  itandi_flow: Array<{ from: string; to: string; n: number }>;
  /** 足りない所・迷い・分からない欄（人が確かめる文） */
  gaps: string[];
  /** 自動の決まり（全部・場面つき） */
  rules: PlaybookRule[];
  /** 自動の決まりの版（拡張の点検記録 playbook_seen の rv と突き合わせる） */
  rules_v: string;
  /**
   * ★ 2.8.297 この手順書を作ったコードの「手順書の見直しの上限」（AUTO_RULES_REVIEWED_UP_TO）。
   *   実測 2026-11-25 22:00〜22:24: 本番（main・2.8.154）が束を作り直し、手元で揃えた新しい手順書（2.8.296・91件）を
   *   古い版（23件）で上書きした。版が付いていないと「新しい手順書を古いコードが潰す」のを書く側も読む側も見分けられない。
   *   → 作った版を持たせ、書く側（bundle-write-prepare）は新しい手順書を古いコードで上書きしない。
   *   無い（古い手順書）は "0" 扱い＝何にも勝たない。手順書の版（version）の計算には入れない。
   */
  rules_up_to?: string;
  /**
   * 録画場面が無い決まり専用の手（clear / switch / pet）。
   *   scenes に無理に載せると場面の並びが崩れるので別枠。
   */
  extra_guides: PlaybookExtraGuide[];
  /**
   * どのサイトの手順書か（2026-11-26）。itandi は決まり一覧・リアプロの一連の流れ・追加ガイドを載せない。
   *   無い（古い手順書）は realpro 扱い。
   */
  site?: "realpro" | "itandi";
};

type SceneFlowLike = {
  scene?: string;
  runs?: number;
  ops?: number;
  steps?: unknown[];
  gap_ms?: number | null;
  variants?: number;
};

type BundleLike = {
  generated_at?: string | null;
  scene_flows?: SceneFlowLike[] | null;
  points?: Record<string, { n?: number; w?: unknown; x?: unknown; y?: unknown }> | null;
  opens?: Record<string, { opens?: unknown; n?: unknown; guessed?: unknown }> | null;
  next?: Record<string, unknown> | null;
  /** サイトごとの押す順番（{ itandi: [{n,from,to}] } / { realpro: [...] }）。2026-11-27: 読むのは scope のキーだけ */
  site_flow?: Record<string, unknown> | null;
  /** 写真学習で集めた画面上の位置（points に無い欄・特に ITANDI の補完に使う） */
  shots?: {
    learned?: Record<string, Array<{ name?: unknown; kind?: unknown; n?: unknown; x?: unknown; y?: unknown }>> | null;
  } | null;
};

/** FNV-1a（32bit）の16進。版の印に使う（暗号ではない） */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 欄の名前の前後の飾り（画面の位置・タグ名）を落とす。sceneOfOp と同じ考え方 */
export function cleanPlaybookName(raw: string): string {
  return String(raw ?? "")
    .replace(/^(左の|右の|上の|下の|中央の)/, "")
    .replace(/｜[^｜]*$/, "")
    // Vision／学習印「🧠88通す」が付いたままだと FIELD_JA に当たらず未分類になる（実測: 印刷用PDF🧠88通す）
    .replace(/🧠\d+通す$/u, "")
    .trim();
}

/**
 * 値（お客様の検索の中身）かどうか。手順からは外す。
 *   区・市・郡・町・村の名前（大阪市西区・千林町 など）／間取り（2K・3LDK・ワンルーム）／数字・単位。
 *   ⚠ 「確定してリストへ」「沿線・駅絞り込み＋」のような欄の名前は当てない（末尾が区・市などでも、欄の語を含むなら欄）。
 */
export function isPlaybookValue(raw: string): boolean {
  const n = cleanPlaybookName(raw);
  if (!n) return false;
  if (PLAYBOOK_FIELD_JA[n]) return false;
  if (/^(ワンルーム|メゾネット|\d+[KDRSL]+)$/i.test(n)) return true;
  if (/^\d+(\.\d+)?(万円|万|分|㎡|年)?$/.test(n)) return true;
  // 金額・割合の選択肢（例: 「…初回総賃料50％月額1.5％」）は値
  if (/[％%]|円|万/.test(n) && /[0-9０-９]/.test(n)) return true;
  if (n.length <= 14 && /[区市郡町村]$/.test(n) && !/[＋]|検索|設定|リスト|絞り込み|一覧/.test(n)) return true;
  return false;
}

/**
 * 操作の並び（束の steps）→ 手順（人が読む名前）。純関数。
 *   値を外す → 欄の名前を読める形に → 同じ名前の連続を1つに。分からない名前は「未分類」として残す。
 */
export function normalizePlaybookSteps(steps: ReadonlyArray<string>): {
  steps: string[];
  /** steps と同じ順の欄の名前（飾りを落とした物） */
  fields: string[];
  unknown: string[];
  values_dropped: number;
} {
  const out: string[] = [];
  const fields: string[] = [];
  const unknown: string[] = [];
  let values_dropped = 0;
  for (const raw of steps) {
    const n = cleanPlaybookName(String(raw ?? ""));
    if (!n) continue;
    if (isPlaybookValue(n)) { values_dropped++; continue; }
    const label = PLAYBOOK_FIELD_JA[n];
    let item: string;
    if (label) item = label;
    else {
      item = `未分類（${n.slice(0, 40)}）`;
      if (!unknown.includes(n)) unknown.push(n.slice(0, 40));
    }
    if (out[out.length - 1] !== item) { out.push(item); fields.push(n); }
  }
  return { steps: out, fields, unknown, values_dropped };
}

type PosIndex = Map<string, { x: number; y: number; n: number; source: PositionSource }>;
type OpenIndex = Map<string, string>;

/**
 * 押す位置の出どころ:
 *   field    … この名前で測った位置（同じ値の名前が他に無い）
 *   alias    … 同じ欄の別名へ写した位置（rental_cost2 ↔ 賃料上限 等・field-name-aliases.ts の展開）。測った値そのもの
 *   mismatch … 開くボタン（〜絞り込み＋）に、箱の中のチェック欄の位置が写った物（押す物の形が違う＝そのまま使えない）
 *   実測（2026-11-20 束 2532）: city_code[]・所在地絞り込み・左の所在地絞り込み＋｜span が全部 n=1238 (0.5,0.5) checkbox。
 *     FIELD_NAME_ALIASES で city_code[] と 所在地絞り込み（開くボタン）が同じ組になっているため。沿線・駅も同じ。
 */
export type PositionSource = "field" | "alias" | "mismatch" | "screen";
const SOURCE_RANK: Record<PositionSource, number> = { field: 4, alias: 3, screen: 2, mismatch: 1 };

function pointSignature(p: { n?: number; x?: unknown; y?: unknown; w?: unknown }): string {
  return `${p.n}|${p.x}|${p.y}|${String(p.w ?? "")}`;
}

/** 箱を開くボタンの名前か（〜絞り込み＋・〜絞り込み・〜を絞り込み） */
function isOpenerName(name: string): boolean {
  const n = cleanPlaybookName(name);
  return /＋$|\+$|絞り込み$/.test(n);
}

/** 同じ値（票・x・y・種類）を持つ名前の数 */
function signatureCounts(points: BundleLike["points"]): Map<string, number> {
  const count = new Map<string, number>();
  for (const p of Object.values(points ?? {})) {
    if (!p || (Number(p.n) || 0) < 1) continue;
    const s = pointSignature(p);
    count.set(s, (count.get(s) ?? 0) + 1);
  }
  return count;
}

function sourceOf(name: string, p: { n?: number; x?: unknown; y?: unknown; w?: unknown }, counts: Map<string, number>): PositionSource {
  if ((counts.get(pointSignature(p)) ?? 0) < 2) return "field";
  if (isOpenerName(name) && String(p.w ?? "") === "checkbox") return "mismatch";
  return "alias";
}

function indexPositions(points: BundleLike["points"]): PosIndex {
  const entries = Object.entries(points ?? {}).filter(([, p]) => (Number(p?.n) || 0) >= 1 && typeof p?.x === "number" && typeof p?.y === "number");
  const counts = signatureCounts(points);
  const m: PosIndex = new Map();
  for (const [k, p] of entries) {
    const n = Number(p.n) || 0;
    const source = sourceOf(k, p, counts);
    const key = cleanPlaybookName(k);
    const cur = m.get(key);
    const better = !cur || SOURCE_RANK[source] > SOURCE_RANK[cur.source] || (cur.source === source && cur.n < n);
    if (better) m.set(key, { x: p.x as number, y: p.y as number, n, source });
  }
  // route_id[] / station_id[] / city_code[] が直接無ければ、実際の選択ラベル（label.one_line / label.one_station / label.one_city）から要素内位置をまとめる
  const aggDefs: Array<{ target: string; re: RegExp }> = [
    { target: "route_id[]", re: /label\.one_line(?:[^a-zA-Z0-9_]|$)/ },
    { target: "station_id[]", re: /label\.one_station(?:[^a-zA-Z0-9_]|$)/ },
    { target: "city_code[]", re: /label\.one_city(?:[^a-zA-Z0-9_]|$)/ },
  ];
  for (const { target, re } of aggDefs) {
    if (m.has(target)) continue;
    let sumN = 0, sumX = 0, sumY = 0;
    for (const [k, p] of entries) {
      if (isOpenerName(k) || !re.test(k)) continue;
      const pn = Math.min(50, Number(p.n) || 0);
      if (pn <= 0) continue;
      sumN += pn;
      sumX += (p.x as number) * pn;
      sumY += (p.y as number) * pn;
    }
    if (sumN > 0) {
      m.set(target, {
        x: Math.round((sumX / sumN) * 100) / 100,
        y: Math.round((sumY / sumN) * 100) / 100,
        n: sumN,
        source: "alias",
      });
    }
  }
  return m;
}

type ScreenPosCandidate = { field: string; n: number; w: string | null; x: number; y: number; aliasKeys: string[] };

/** 同一座標・同票の別名複製群から人が読みやすい代表名1つを選ぶための優先スコア */
function screenFieldRepScore(name: string, n: number, sp: number, alreadyExists: boolean): number {
  const key = cleanPlaybookName(name);
  const notExisting = alreadyExists ? -5000 : 2000;
  const inJa = PLAYBOOK_FIELD_JA[key] ? 1000 : 0;
  const hasJa = /[ぁ-んァ-ヶ一-龠]/.test(key) ? 200 : 0;
  const notArrayName = /\[\]$/.test(key) ? -400 : 0;
  const lenScore = Math.min(30, key.length >= 2 ? key.length * 3 : 0);
  const noPipe = name.includes("｜") ? 0 : 50;
  const noOpenerNoise = /^(?:路線|駅|分)$/.test(key) ? -80 : 0;
  return notExisting + inJa + hasJa + notArrayName + lenScore + noPipe + noOpenerNoise + sp * 10 + Math.min(n, 500) * 0.01;
}

/** 写真学習（shots.learned）から、points に無い欄の画面上位置を拾う（form > modal > result、高 n 優先、同一座標コピー統合） */
function collectScreenLearnedPositions(
  shots: BundleLike["shots"],
  siteKind: "realpro" | "itandi",
  existingKeys: ReadonlySet<string> = new Set(),
): ScreenPosCandidate[] {
  const learned = sanitizeLearnedForSite(shots?.learned, siteKind).learned;
  if (!learned) return [];
  const screenPrio = (sc: string) => (sc === "form" ? 3 : sc === "modal" ? 2 : sc === "result" ? 1 : 0);
  const order = [...Object.keys(learned)].sort((a, b) => screenPrio(b) - screenPrio(a));
  const best = new Map<string, { field: string; n: number; w: string | null; x: number; y: number; sp: number }>();
  for (const sc of order) {
    const list = learned[sc];
    if (!Array.isArray(list)) continue;
    const sp = screenPrio(sc);
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      const rawName = String(it.name ?? "").trim();
      if (!rawName) continue;
      if (!isAllowedMotionFieldName(rawName, siteKind)) continue;
      const key = cleanPlaybookName(rawName);
      if (!key) continue;
      if (!PLAYBOOK_FIELD_JA[key] && isPlaybookValue(rawName)) continue;
      const n = Math.min(500, Number(it.n) || 0);
      if (n < 1) continue;
      if (typeof it.x !== "number" || !Number.isFinite(it.x) || typeof it.y !== "number" || !Number.isFinite(it.y)) continue;
      const w = typeof it.kind === "string" && it.kind ? it.kind : null;
      const prev = best.get(key);
      if (!prev || sp > prev.sp || (sp === prev.sp && n > prev.n)) {
        best.set(key, { field: rawName, n, w, x: it.x, y: it.y, sp });
      }
    }
  }
  // 同一座標・同票（別名展開由来の複製）は代表1件だけを positions に出し、別名キー一覧も lookup 用に保持する
  const byCoord = new Map<string, Array<{ key: string; field: string; n: number; w: string | null; x: number; y: number; sp: number }>>();
  for (const [key, v] of best.entries()) {
    const sig = `${v.x.toFixed(3)}|${v.y.toFixed(3)}|${v.n}`;
    const grp = byCoord.get(sig) ?? [];
    grp.push({ key, ...v });
    byCoord.set(sig, grp);
  }
  const deduped: ScreenPosCandidate[] = [];
  for (const grp of byCoord.values()) {
    grp.sort((a, b) => screenFieldRepScore(b.field, b.n, b.sp, existingKeys.has(b.key)) - screenFieldRepScore(a.field, a.n, a.sp, existingKeys.has(a.key)));
    const rep = grp[0];
    deduped.push({
      field: rep.field,
      n: rep.n,
      w: rep.w,
      x: rep.x,
      y: rep.y,
      aliasKeys: grp.map((g) => g.key),
    });
  }
  return deduped.sort((a, b) => b.n - a.n).slice(0, 120);
}

/** 束の opens を同じく引けるようにする（人が確かめた物だけ・推測は入れない） */
function indexOpens(opens: BundleLike["opens"]): OpenIndex {
  const m: OpenIndex = new Map();
  for (const [k, o] of Object.entries(opens ?? {})) {
    if (o?.guessed === true || !(Number(o?.n) > 0) || typeof o?.opens !== "string") continue;
    m.set(cleanPlaybookName(k), o.opens);
  }
  return m;
}

/** 手順書の場面 → 効く自動の決まり（同じ場面の物＋press＝押す前後の人の間・全部の場面に効く。2026-11-27 竹内さん「決まりとして文が無いところは漏れる」→ 場面ごとに並べる） */
function rulesForScene(scene: string): string[] {
  return AUTO_RULES.filter((r) => r.scene === scene || r.scene === "press").map((r) => r.id);
}

/** 場面の手順 → 手順書の場面（値を外す・名前を読める形に・件数で上限・1手ずつの細部） */
export function playbookSceneOf(
  f: SceneFlowLike,
  pos: PosIndex = new Map(),
  opn: OpenIndex = new Map(),
  aliasesFn?: (field: string) => ReadonlyArray<string>,
): PlaybookScene {
  const scene = String(f.scene ?? "other");
  const runs = Number(f.runs) || 0;
  const norm = normalizePlaybookSteps((Array.isArray(f.steps) ? f.steps : []).map((x) => String(x)));
  const steps = norm.steps.slice(0, PLAYBOOK_MAX_STEPS);
  const detail: PlaybookStep[] = steps.map((step, i) => {
    const field = norm.fields[i] ?? "";
    let p = pos.get(field);
    if (!p && aliasesFn && field) {
      for (const al of aliasesFn(field)) {
        const cand = pos.get(cleanPlaybookName(al));
        if (cand) { p = cand; break; }
      }
    }
    return {
      step,
      field,
      aim: p ? { x: p.x, y: p.y, n: p.n, confidence: p.source !== "mismatch" && p.n >= PLAYBOOK_SOLID_RUNS ? "solid" : "thin", source: p.source } : null,
      opens: opn.get(field) ?? null,
    };
  });
  return {
    scene,
    label: (SCENE_JA as Record<string, string>)[scene] ?? scene,
    runs,
    ops: Number(f.ops) || 0,
    steps,
    gap_ms: typeof f.gap_ms === "number" && Number.isFinite(f.gap_ms) ? f.gap_ms : null,
    variants: Number(f.variants) || 0,
    values_dropped: norm.values_dropped,
    unknown: norm.unknown,
    confidence: runs >= PLAYBOOK_SOLID_RUNS ? "solid" : "thin",
    detail,
    rules: rulesForScene(scene),
  };
}

/**
 * 束 → 手順書（純関数。同じ束からは同じ版）
 * site: 'itandi' なら、リアプロ専用の手（並べ替え AD・印刷用PDF・検索の把握）を載せない（ITANDI は並べ替えが無い）。
 *       それ以外（未指定・realpro・all）は従来どおり。
 */
export function buildPlaybook(bundle: BundleLike, site?: string | null): Playbook {
  const realproHands = String(site ?? "") !== "itandi";
  const siteKind: "realpro" | "itandi" = realproHands ? "realpro" : "itandi";
  // itandi は自動の決まり（AUTO_RULES）・リアプロの一連の流れ・追加ガイドを載せない（リアプロの拡張用の一覧で、itandi のページは使っていない）
  const ruleIdsFor = (ids: ReadonlyArray<string>): string[] => (realproHands ? [...ids] : []);
  // 入口防御: ゴミ欄名・値セル・他サイト要素・旧バグの爆発点（n>5000 かつ 0.5,0.5）を手順書から完全に除外する
  const cleanPoints: NonNullable<BundleLike["points"]> = {};
  for (const [k, p] of Object.entries(bundle.points ?? {})) {
    if (!p || !isAllowedMotionFieldName(k, siteKind)) continue;
    if (!PLAYBOOK_FIELD_JA[cleanPlaybookName(k)] && isPlaybookValue(k)) continue;
    const rawN = Number(p.n) || 0;
    if (rawN > 5000 && p.x === 0.5 && p.y === 0.5) continue;
    cleanPoints[k] = rawN > 500 ? { ...p, n: 500 } : p;
  }
  const cleanOpens: NonNullable<BundleLike["opens"]> = {};
  for (const [k, o] of Object.entries(bundle.opens ?? {})) {
    if (!o || !isAllowedMotionFieldName(k, siteKind)) continue;
    cleanOpens[k] = o;
  }
  const posIdx = indexPositions(cleanPoints);
  const existingKeys = new Set([
    ...Object.keys(cleanPoints).map((k) => cleanPlaybookName(k)),
    ...posIdx.keys(),
  ]);
  const screenPositions: PlaybookPosition[] = [];
  for (const sp of collectScreenLearnedPositions(bundle.shots, siteKind, existingKeys)) {
    const key = cleanPlaybookName(sp.field);
    for (const ak of sp.aliasKeys) {
      const cur = posIdx.get(ak);
      if (!cur || cur.source === "mismatch") {
        posIdx.set(ak, { x: sp.x, y: sp.y, n: sp.n, source: "screen" });
      }
    }
    if (!existingKeys.has(key)) {
      existingKeys.add(key);
      screenPositions.push({
        field: sp.field,
        n: sp.n,
        w: sp.w,
        x: sp.x,
        y: sp.y,
        confidence: sp.n >= PLAYBOOK_SOLID_RUNS ? "solid" : "thin",
        source: "screen",
      });
    }
  }
  const openIdx = indexOpens(cleanOpens);
  const siteAliasFn = siteKind === "itandi" ? itandiAliasesOf : undefined;
  const lookupAim = (field: string, aliases: ReadonlyArray<string> = []): PlaybookStep["aim"] => {
    const siteAls = siteAliasFn ? siteAliasFn(field) : [];
    const keys = [field, cleanPlaybookName(field), ...aliases, ...aliases.map(cleanPlaybookName), ...siteAls, ...siteAls.map(cleanPlaybookName)];
    for (const k of keys) {
      if (!k) continue;
      const p = posIdx.get(k);
      if (p) {
        return {
          x: p.x,
          y: p.y,
          n: p.n,
          confidence: p.source !== "mismatch" && p.n >= PLAYBOOK_SOLID_RUNS ? "solid" : "thin",
          source: p.source,
        };
      }
    }
    return null;
  };
  const lookupOpens = (field: string, aliases: ReadonlyArray<string> = []): string | null => {
    const keys = [field, cleanPlaybookName(field), ...aliases, ...aliases.map(cleanPlaybookName)];
    for (const k of keys) {
      if (!k) continue;
      const o = openIdx.get(k);
      if (o) return o;
    }
    return null;
  };
  const scenes = (Array.isArray(bundle.scene_flows) ? bundle.scene_flows : [])
    .filter((f) => f && typeof f.scene === "string" && f.scene !== "other")
    .map((f) => playbookSceneOf(f, posIdx, openIdx, siteAliasFn));
  // itandi の場面には、リアプロの自動の決まりを付けない（場面の決まりは rulesForScene＝AUTO_RULES 由来）
  if (!realproHands) for (const s of scenes) s.rules = [];
  const learned = new Set(scenes.map((s) => s.scene));
  const gapsEarly: string[] = [];
  /**
   * ★ 2.8.208 / build_v10: 録画が薄い束でも連続客に必要な場面を scenes に足す（missing 判定の前）。
   */
  const injectGuideSceneEarly = (
    scene: string,
    steps: ReadonlyArray<string>,
    ruleIds: ReadonlyArray<string>,
    why: string,
  ) => {
    if (scenes.some((s) => s.scene === scene)) return;
    const detail: PlaybookStep[] = steps.map((step) => {
      const fGuess = step.indexOf("印刷用PDF") >= 0 ? "印刷用PDF"
        : step.indexOf("高→低") >= 0 ? "左の高→低｜span.sort_detail"
        : step.indexOf("確定してリストへ") >= 0 ? "確定してリストへ"
        : step.indexOf("所在地絞り込みを開く") >= 0 ? "所在地絞り込みを開く"
        : step.indexOf("検索ボタン") >= 0 ? "検索"
        : step.indexOf("区") >= 0 && scene === "area" ? "city_code[]"
        : String(step).slice(0, 28);
      const als = fGuess === "所在地絞り込みを開く" ? ["所在地絞り込み＋", "所在地絞り込み"]
        : fGuess === "印刷用PDF" ? ["印刷用PDF｜a.print", "印刷用PDF｜img"]
        : [];
      return {
        step,
        field: fGuess,
        aim: lookupAim(fGuess, als),
        opens: lookupOpens(fGuess, als),
      };
    });
    scenes.push({
      scene,
      label: (SCENE_JA as Record<string, string>)[scene] ?? scene,
      runs: 0,
      ops: 0,
      steps: [...steps].slice(0, PLAYBOOK_MAX_STEPS),
      gap_ms: null,
      variants: 0,
      values_dropped: 0,
      unknown: [],
      confidence: "thin",
      detail: detail.slice(0, PLAYBOOK_MAX_STEPS),
      rules: ruleIdsFor(ruleIds),
    });
    learned.add(scene);
    gapsEarly.push(why);
  };
  // 所在地の「確定してリストへ」はリアプロの画面の手（itandi には確定の段が無い）→ realpro だけ
  if (realproHands) {
    injectGuideSceneEarly(
      "area",
      PLAYBOOK_AREA_CONFIRM_STEPS,
      ["guide_phase_checkpoints", "guide_clear_fill_gate"],
      "所在地場面: 録画が無いため①開く→②区→③確定 を薄いガイド場面として手順書に足した",
    );
  }
  injectGuideSceneEarly(
    "cond",
    PLAYBOOK_COND_GUIDE_STEPS,
    ["guide_clear_fill_gate", "continuous_customer_loop", "next_customer_api_reload"],
    "条件場面: 録画が無いため①条件入れ→②照合→③検索へ を薄いガイド場面として手順書に足した（外しだけで終わらない）",
  );
  // 検索・一覧の手（並べ替え AD・印刷用PDF）はリアプロだけ。itandi には並べ替えが無いので載せない
  if (realproHands) {
    injectGuideSceneEarly(
      "search",
      PLAYBOOK_SEARCH_GRASP_STEPS,
      ["search_decide", "search_customer_screen_grasp", "search_to_sort_cursor"],
      "検索場面: 録画が無いため①検索→②把握→③並べ替えへ を薄いガイド場面として手順書に足した",
    );
    injectGuideSceneEarly(
      "list",
      PLAYBOOK_LIST_AD_SORT_STEPS,
      ["ad_sort_hover", "sort_head_buried_find", "search_to_sort_cursor", "guide_list_next_flow"],
      "一覧場面: 録画が無いため①並べ替え→②AD→③高→低→④PDF を薄いガイド場面として手順書に足した",
    );
  }
  // other（場面が決まらない操作）は「学んでいない場面」ではないので外す
  const missing = Object.keys(SCENE_JA).filter((k) => k !== "other" && !learned.has(k));

  // 押す位置: 束の points（＋写真学習 shots.learned の補完）を欄ごとに載せる（票1以上・票の多い順）。数は solid/thin で数える
  const sigCounts = signatureCounts(cleanPoints);
  const positions: PlaybookPosition[] = Object.entries(cleanPoints)
    .map(([field, p]) => {
      const n = Number(p?.n) || 0;
      return {
        field,
        n,
        w: typeof p?.w === "string" ? p.w : null,
        x: typeof p?.x === "number" && Number.isFinite(p.x) ? p.x : null,
        y: typeof p?.y === "number" && Number.isFinite(p.y) ? p.y : null,
        confidence: (n >= PLAYBOOK_SOLID_RUNS ? "solid" : "thin") as "solid" | "thin",
        source: sourceOf(field, p ?? {}, sigCounts),
      };
    })
    .filter((p) => p.n >= 1)
    .concat(screenPositions)
    .sort((a, b) => b.n - a.n);
  const solid = positions.filter((p) => p.confidence === "solid").length;
  const thin = positions.filter((p) => p.confidence === "thin").length;
  const aliasCopies = positions.filter((p) => p.source === "alias").length;
  const mismatches = positions.filter((p) => p.source === "mismatch").length;

  // 開く欄: 人が確かめて学んだ物（n≥1 かつ推測でない）だけを「知っている」と数える。推測は別に数える
  const opens: PlaybookOpen[] = Object.entries(cleanOpens)
    .map(([field, o]) => ({
      field,
      opens: typeof o?.opens === "string" ? o.opens : null,
      n: Number(o?.n) || 0,
      guessed: o?.guessed === true,
    }))
    .sort((a, b) => b.n - a.n);
  const opens_known = opens.filter((o) => !o.guessed && o.n > 0).length;
  const opens_guessed = opens.length - opens_known;
  // 2026-11-27: 束の next は「次に押す欄」の並び（押す順番）で、次のページ送りの記録ではない（リアプロ・ITANDI とも）。
  //   次のページは場面 next（人が押した記録）でだけ判定する。
  const next_n = Object.keys(bundle.next ?? {}).length;
  // ITANDI の押す順番は ITANDI 自身の site_flow.itandi だけから作る（リアプロの site_flow は読まない＝混ざり防止）
  const itandi_flow: Array<{ from: string; to: string; n: number }> = siteKind === "itandi"
    ? ((Array.isArray(bundle.site_flow?.itandi) ? bundle.site_flow?.itandi : []) as Array<{ from?: unknown; to?: unknown; n?: unknown }>)
      .filter((e) => e && typeof e.from === "string" && typeof e.to === "string")
      .map((e) => ({ from: String(e.from).split("｜")[0], to: String(e.to).split("｜")[0], n: Number(e.n) || 0 }))
    : [];

  const gaps: string[] = [...gapsEarly];
  if (!positions.length) gaps.push("押す位置が1つも無い（束の points が空）");
  if (mismatches) {
    const names = positions.filter((p) => p.source === "mismatch").map((p) => cleanPlaybookName(p.field)).slice(0, 4);
    gaps.push(`押す位置 ${positions.length}件のうち ${mismatches}件は、開くボタンに箱の中のチェック欄の位置が写った物（${names.join("・")}）＝別名の組（field-name-aliases.ts）でボタンとチェック欄が同じ組になっている`);
  }
  if (opens_guessed) gaps.push(`開く欄 ${opens_guessed}件は推測のまま（人が開いて確かめていない・数に入れない）`);
  if (!learned.has("next")) gaps.push(`次のページ送り（場面 next）はまだ学んでいない${next_n ? `（束の next は押す順番の${next_n}件で、次のページ送りの記録ではない）` : ""}`);
  if (siteKind === "itandi" && !itandi_flow.length) gaps.push("ITANDI の押す順番（site_flow.itandi）がまだ無い");
  if (!scenes.length) gaps.push("場面の手順が1つも無い（まだ学んでいない）");
  for (const s of scenes) {
    if (s.confidence === "thin") gaps.push(`${s.label}：検索${s.runs}回だけ（3回未満・人が1回通して確かめる候補）`);
    // 順番の数が0は「数えていない」（束の欠け）。0通りとは読まない
    if (s.runs > 0 && s.variants === 0) gaps.push(`${s.label}：順番の数が束に入っていない（0と書かれている・学習側の欠けの疑い）`);
    // 順番の数は値（区名など）の違いも数えている＝「迷い」と言い切れない
    if (s.variants >= 2) gaps.push(`${s.label}：順番${s.variants}通り（区名・間取りなど値の違いを含む数・型の数はまだ確かめていない）`);
    if (s.unknown.length) gaps.push(`${s.label}：欄の名前が分からないもの（${s.unknown.join("・")}）・地名か欄かを人が確かめる`);
  }
  if (missing.length) gaps.push(`まだ学んでいない場面：${missing.map((k) => (SCENE_JA as Record<string, string>)[k]).join("・")}`);
  for (const s of scenes) {
    const noAim = s.detail.filter((d) => !d.aim).map((d) => d.step);
    if (noAim.length) gaps.push(`${s.label}：押す位置を学んでいない手 ${noAim.length}件（${noAim.slice(0, 4).join("・")}）`);
    const badAim = s.detail.filter((d) => d.aim?.source === "mismatch").map((d) => d.step);
    if (badAim.length) gaps.push(`${s.label}：押す位置がボタンとチェック欄の取り違えの手 ${badAim.length}件（${badAim.slice(0, 4).join("・")}）`);
    const thinAim = s.detail.filter((d) => d.aim && d.aim.source !== "mismatch" && d.aim.confidence === "thin").map((d) => d.step);
    if (thinAim.length) gaps.push(`${s.label}：押す位置の票が3回未満の手 ${thinAim.length}件（${thinAim.slice(0, 4).join("・")}）`);
  }

  // 自動の決まり（拡張で直した物）。人の手本の場面が無い所（前客の外し・ペット等）も決まりは載せる
  // 2026-11-27: ITANDI は ITANDI だけの決まり（auto-itandi-rules.ts）を載せる。リアプロの決まりは載せない（混ざり防止）
  const rules: PlaybookRule[] = realproHands ? AUTO_RULES.map((r) => ({
    id: r.id, scene: r.scene, scene_label: RULE_SCENE_JA[r.scene], text: r.text, since: r.since, kb: r.kb,
    verified_by: verifyKeysOf(r.verify),
  })) : ITANDI_AUTO_RULES.map((r) => ({
    id: r.id, scene: r.scene, scene_label: RULE_SCENE_JA[r.scene], text: r.text, since: r.since, kb: null,
    verified_by: [],
  }));
  const rules_v = rulesVersionFor(siteKind);
  // 2026-11-27: ITANDI の決まりは、確かめる段がまだ保存されていない（理由は auto-itandi-rules.ts の verify_reason）
  if (!realproHands) {
    gaps.push(`itandi の自動の決まり ${rules.length}件は、点検の段がまだ保存されず確かめられない（保存の直しと ITANDI の実走が要る）`);
  }
  // 2026-11-27: 確かめ方が無い決まりは、理由つきの例外（RULES_CODE_ONLY）以外を抜けとして出す（リアプロの決まりだけ）
  const unverified = realproHands ? rules.filter((r) => !r.verified_by.length && !RULES_CODE_ONLY[r.id]).map((r) => r.id) : [];
  if (unverified.length) {
    gaps.push(`自動の決まり ${rules.length}件のうち ${unverified.length}件は点検記録で確かめる印が無い（コードにあるかだけ・${unverified.slice(0, 6).join("・")}${unverified.length > 6 ? ` 他${unverified.length - 6}` : ""}）`);
  }
  const ruleOnly = [...new Set(rules.map((r) => r.scene))].filter((sc) => sc !== "press" && !learned.has(sc));
  if (ruleOnly.length) {
    gaps.push(`人の手本（録画の場面）がまだ無く、自動の決まりだけの場面：${ruleOnly.map((sc) => RULE_SCENE_JA[sc]).join("・")}`);
  }

  // 一連の流れ: itandi は itandi 用の段（点検の印が実際に出る物だけ）。リアプロは従来どおり
  const flowSeries = realproHands ? PLAYBOOK_FLOW_SERIES : ITANDI_FLOW_SERIES;
  const flow_series = flowSeries.map((p) => ({ ...p, grasp: [...p.grasp] }));
  // 一連の流れに紐づく場面が薄い／無い時は gaps に出す（場面の並びだけ見て「流れOK」と誤解しない）
  for (const ph of flow_series) {
    if (!ph.scene) continue;
    const sc = scenes.find((s) => s.scene === ph.scene);
    if (!sc) gaps.push(`一連の流れ「${ph.label}」に紐づく場面 ${ph.scene} が手順に無い`);
    else if (sc.confidence === "thin") gaps.push(`一連の流れ「${ph.label}」の場面 ${sc.label} が薄い（検索${sc.runs}回）`);
  }
  // 点検の印が1つも無い段は「把握できない」と明示する（itandi の検索・一覧・次客は拡張の印がまだ無い）
  const noMark = flow_series.filter((p) => !p.grasp.length).map((p) => p.label);
  if (noMark.length) gaps.push(`一連の流れのうち点検の印が無い段（把握できない）：${noMark.join("・")}`);
  if (!flow_series.length) gaps.push("一連の流れ（flow_series）が空");

  /**
   * ★ 2026-11-23: list 場面に AD 並べ替えの手を必ず載せる。
   *   録画が印刷用PDFだけだと手順書から並べ替えが抜け、自動が PDF 直行する。
   */
  for (const sc of scenes) {
    if (sc.scene !== "list" || !realproHands) continue;
    // 固定ガイド（①〜③）が無い時だけ足す。FIELD_JA の「並べ替え」文言だけでは足りない
    const hasAdGuide = sc.steps.some((t) => /①並べ替え|②メニュー内のAD|③ADの右の/.test(String(t || "")));
    if (hasAdGuide) continue;
    const rest = sc.steps.filter((t) => !/印刷用PDF|並べ替え|高→低|^AD$|①|②|③|④/.test(String(t || "")));
    // AD 手を先頭に・上限は PLAYBOOK_MAX_STEPS（長い録画手順で溢れない）
    sc.steps = PLAYBOOK_LIST_AD_SORT_STEPS.concat(rest).slice(0, PLAYBOOK_MAX_STEPS);
    const guideDetail: PlaybookStep[] = PLAYBOOK_LIST_AD_SORT_STEPS.map((step) => {
      // ★ 「④並べ替え後に印刷用PDFを押す」は「並べ替え」にも一致するため印刷用PDFを先に判定する
      // ★ 2.8.319 ④の1〜3（送付済み→次へ／0件）と⑤（客完了→リセット）は印刷用PDFの欄ではない。先に分ける
      const f = /^④の/.test(step) ? "次へ" : /^⑤/.test(step) ? "リセット"
        : step.indexOf("印刷用PDF") >= 0 ? "印刷用PDF"
        : step.indexOf("高→低") >= 0 ? "左の高→低｜span.sort_detail"
        : step.indexOf("AD") >= 0 ? "AD"
        : step.indexOf("並べ替え") >= 0 ? "並べ替え"
        : "印刷用PDF";
      const als = f === "印刷用PDF" ? ["印刷用PDF｜a.print", "印刷用PDF｜img"] : [];
      return {
        step,
        field: f,
        aim: lookupAim(f, als),
        opens: lookupOpens(f, als),
      };
    });
    sc.detail = guideDetail
      .concat(sc.detail.filter((d) => !/①並べ替え|②メニュー|③AD|④並べ替え後|印刷用PDF/.test(d.step)))
      .slice(0, PLAYBOOK_MAX_STEPS);
    // 固定ガイドで PDF を載せるので、学習印付き PDF の未分類は落とす
    sc.unknown = sc.unknown.filter((u) => !/^印刷用PDF/.test(cleanPlaybookName(u)));
    if (!sc.rules.includes("ad_sort_hover")) {
      sc.rules = ["ad_sort_hover", "sort_head_buried_find", "search_to_sort_cursor"].concat(sc.rules);
    }
    gaps.push("一覧場面: 録画に並べ替え手が薄いため、①並べ替え→②AD→③高→低→④PDF を手順書に固定で載せた");
  }

  /**
   * ★ 2026-11-23: search 場面に検索把握の手を必ず載せる。
   *   録画が「検索を押す」1手だけだと、把握→並べ替えが手順書から抜ける。
   */
  for (const sc of scenes) {
    if (sc.scene !== "search" || !realproHands) continue;
    const hasSearchGuide = sc.steps.some((t) => /①条件が揃ったら検索|②検索したことを手順書|③把握OKのあと並べ替え/.test(String(t || "")));
    if (hasSearchGuide) continue;
    const oldSearchAim = sc.detail.find((d) => /検索/.test(d.step))?.aim ?? null;
    const rest = sc.steps.filter((t) => !/検索を押す|^検索$|①条件|②検索した|③把握OK/.test(String(t || "")));
    const restDetail = sc.detail.filter((d) => rest.includes(d.step));
    sc.steps = PLAYBOOK_SEARCH_GRASP_STEPS.concat(rest).slice(0, PLAYBOOK_MAX_STEPS);
    const guideDetail: PlaybookStep[] = PLAYBOOK_SEARCH_GRASP_STEPS.map((step, i) => {
      const f = step.indexOf("検索ボタン") >= 0 ? "検索" : "検索把握";
      return {
        step,
        field: f,
        aim: i === 0 ? (oldSearchAim ?? lookupAim("検索", ["左の検索｜span", "検索"])) : null,
        opens: i === 0 ? lookupOpens("検索", ["左の検索｜span", "検索"]) : null,
      };
    });
    sc.detail = guideDetail.concat(restDetail).slice(0, PLAYBOOK_MAX_STEPS);
    for (const rid of ["search_decide", "search_customer_screen_grasp", "search_to_sort_cursor"] as const) {
      if (!sc.rules.includes(rid)) sc.rules = [rid, ...sc.rules];
    }
    gaps.push("検索場面: 録画が薄いため、①検索押す→②手順書×画面で把握→③並べ替えへ を手順書に固定で載せた");
  }

  /**
   * ★ 2026-11-23: area 場面に「確定してリストへ」を必ず載せる。
   *   録画の手（押す位置つき）は残し、欠けた開く／確定だけ足す（全部差し替えない＝aim を消さない）。
   */
  for (const sc of scenes) {
    if (sc.scene !== "area" || !realproHands) continue;
    const hasConfirm = sc.steps.some((t) => /確定してリストへ/.test(String(t || "")));
    const hasOpen = sc.steps.some((t) => /所在地絞り込みを開く|所在地絞り込み/.test(String(t || "")));
    if (hasConfirm && hasOpen) continue;
    const prepend: PlaybookStep[] = [];
    const append: PlaybookStep[] = [];
    if (!hasOpen) {
      prepend.push({
        step: PLAYBOOK_AREA_CONFIRM_STEPS[0],
        field: "所在地絞り込みを開く",
        aim: lookupAim("所在地絞り込みを開く", ["所在地絞り込み＋", "所在地絞り込み", "左の所在地絞り込み＋｜div.one_slide_searc", "左の所在地絞り込み＋｜span"]),
        opens: lookupOpens("所在地絞り込みを開く", ["所在地絞り込み＋", "所在地絞り込み"]),
      });
    }
    if (!hasConfirm) {
      // 確定の押す位置が束にあれば載せる（aim を消さない方針）
      const confField = "確定してリストへ";
      const confPos = positions.find((p) => p.field === confField || p.field.indexOf("確定してリストへ") >= 0) || null;
      append.push({
        step: PLAYBOOK_AREA_CONFIRM_STEPS[2],
        field: confField,
        aim: lookupAim(confField) ?? (confPos
          ? { x: confPos.x ?? 0.5, y: confPos.y ?? 0.5, n: confPos.n, confidence: confPos.confidence, source: confPos.source }
          : null),
        opens: lookupOpens(confField),
      });
    }
    sc.steps = prepend.map((d) => d.step).concat(sc.steps).concat(append.map((d) => d.step)).slice(0, PLAYBOOK_MAX_STEPS);
    sc.detail = prepend.concat(sc.detail).concat(append).slice(0, PLAYBOOK_MAX_STEPS);
    gaps.push(
      !hasConfirm && !hasOpen
        ? "所在地場面: 録画に開く・確定が薄いため、所在地絞り込みを開く／確定してリストへ を手順書に足した"
        : !hasConfirm
          ? "所在地場面: 録画に確定手が薄いため、確定してリストへ を手順書に足した"
          : "所在地場面: 録画に開く手が薄いため、所在地絞り込みを開く を手順書に足した",
    );
  }

  /** 録画場面が無い clear / switch / pet は extra_guides に載せる（scenes は崩さない） */
  const guideSrc = realproHands ? PLAYBOOK_EXTRA_GUIDES : ITANDI_EXTRA_GUIDES;
  const extra_guides: PlaybookExtraGuide[] = guideSrc.map((g) => ({
    id: g.id,
    label: g.label,
    steps: [...g.steps],
    rules: [...g.rules],
  }));
  for (const g of extra_guides) {
    gaps.push(`場面なし「${g.label}」: 録画が無いため①②③を extra_guides に載せた`);
  }

  const body = JSON.stringify({
    build_v: PLAYBOOK_BUILD_V,
    site: siteKind,
    scenes,
    flow_series: flow_series.map((p) => p.id),
    missing,
    points: { solid, thin },
    positions,
    opens,
    next_n,
    itandi_flow,
    rules_v,
    extra_guides: extra_guides.map((g) => g.id),
  });
  return {
    v: 1,
    build_v: PLAYBOOK_BUILD_V,
    site: siteKind,
    version: fnv1a(body),
    based_on: String(bundle.generated_at ?? ""),
    scenes,
    flow_series,
    missing,
    points: { solid, thin },
    positions,
    positions_alias: aliasCopies,
    positions_mismatch: mismatches,
    opens_known,
    opens,
    opens_guessed,
    next_n,
    itandi_flow,
    gaps,
    rules,
    rules_v,
    rules_up_to: rulesReviewedUpToFor(siteKind),
    extra_guides,
  };
}

/**
 * 手順書の検査（純関数）。抜けがあれば文で返す（空＝問題なし）。
 *   ⚠ 「問題なし」は「この検査では見つからない」という意味。手順が正しいとは言わない。
 */
/**
 * 束の手順書が古ければ（作り方の版が下・決まりの版がコードと違う・無い）作り直した写しを返す（元の束は変えない）。
 *   API が拡張へ渡す時に使う＝決まりを直してデプロイしたら、次に束を書く前でも拡張は新しい手順書を読む。
 */
export function refreshPlaybookIfStale(bundle: Record<string, unknown> | null | undefined, site?: string | null): {
  bundle: Record<string, unknown> | null | undefined; refreshed: boolean; why: string | null;
} {
  if (!bundle || typeof bundle !== "object") return { bundle, refreshed: false, why: null };
  const pb = bundle.playbook as Partial<Playbook> | null | undefined;
  let why: string | null = null;
  if (!pb || typeof pb !== "object") why = "手順書が無い";
  else if ((Number(pb.build_v) || 0) < PLAYBOOK_BUILD_V) why = `作り方が古い（${pb.build_v ?? "-"}→${PLAYBOOK_BUILD_V}）`;
  else if (pb.rules_v !== rulesVersionFor(site ?? pb.site)) why = `決まりの版が古い（${pb.rules_v ?? "-"}→${rulesVersionFor(site ?? pb.site)}）`;
  if (!why) return { bundle, refreshed: false, why: null };
  const copy: Record<string, unknown> = { ...bundle };
  copy.playbook = buildPlaybook(copy as never, site);
  return { bundle: copy, refreshed: true, why };
}

export function checkPlaybook(pb: Playbook, nowMs: number = Date.now()): string[] {
  const issues: string[] = [];
  if (!pb.scenes.length) issues.push("場面が0（手順書が空）");
  // 学んだ押す位置が手順書に全部入っているか（入れ忘れ・数の食い違いの網）
  if (pb.positions.length !== pb.points.solid + pb.points.thin) issues.push("押す位置の数が合わない（一覧と数）");
  if (pb.opens_known + pb.opens_guessed !== pb.opens.length) issues.push("開く欄の数が合わない（一覧と数）");
  if (pb.positions.some((p) => p.x == null || p.y == null)) issues.push("押す位置に座標の無い物がある（押せない）");
  for (const s of pb.scenes) {
    if (!(s.scene in SCENE_JA)) issues.push(`場面の名前が知らない物：${s.scene}`);
    if (!s.steps.length) issues.push(`${s.label}：手順が空`);
    for (const st of s.steps) {
      // 値（間取り・区名の形）が手順に残っていないか
      if (/\d+[KDLS]+/.test(st) || /[区市郡]$/.test(st)) issues.push(`${s.label}：値が手順に残っている（${st}）`);
    }
    if (s.unknown.length) issues.push(`${s.label}：未分類の欄 ${s.unknown.length}件`);
    if (s.runs > 0 && s.variants === 0) issues.push(`${s.label}：順番の数が0（束の欠けの疑い・0と読まない）`);
  }
  // 自動の決まり（拡張で直した物）が手順書に入っているか・コードの決まりと同じ版か
  if ((Number(pb.build_v) || 0) < PLAYBOOK_BUILD_V) issues.push(`作り方が古い（build_v=${pb.build_v}・今は ${PLAYBOOK_BUILD_V}）`);
  // 2026-11-27: 決まりはサイトごと（リアプロ＝AUTO_RULES・ITANDI＝ITANDI_AUTO_RULES）。空は両方で無い＝抜け。版もサイトごとに比べる
  if (!Array.isArray(pb.rules) || !pb.rules.length) issues.push("自動の決まりが手順書に入っていない");
  else if (pb.rules_v !== rulesVersionFor(pb.site)) issues.push(`自動の決まりの版が古い（手順書 ${pb.rules_v}・コード ${rulesVersionFor(pb.site)}）`);
  if (!Array.isArray(pb.flow_series) || pb.flow_series.length < 5) {
    issues.push("一連の流れ（flow_series）が無い／短すぎる（外し→検索→一覧→次客の把握線が無い）");
  } else {
    const ids = pb.flow_series.map((p) => p.id);
    for (const need of ["before_clear", "clear_then_fill", "after_clear", "after_confirm", "after_search", "list", "handoff"]) {
      if (!ids.includes(need)) issues.push(`一連の流れに必須段が無い: ${need}`);
    }
    const bi = ids.indexOf("before_clear");
    const ai = ids.indexOf("after_clear");
    if (bi >= 0 && ai >= 0 && bi > ai) issues.push("一連の流れ: before_clear が after_clear より後（順番抜け）");
    const cti = ids.indexOf("after_clear");
    const fi = ids.indexOf("after_confirm");
    if (cti >= 0 && fi >= 0 && cti > fi) issues.push("一連の流れ: after_clear が after_confirm より後（外す→入れの順抜け）");
  }
  for (const s of pb.scenes) {
    if (!Array.isArray(s.detail) || s.detail.length !== s.steps.length) issues.push(`${s.label}：1手ずつの細部が手順と合わない`);
  }
  const based = Date.parse(pb.based_on);
  if (!Number.isFinite(based)) issues.push("束の作成時刻が読めない");
  else if (nowMs - based > PLAYBOOK_STALE_MS) issues.push(`束が古い（作成から ${Math.round((nowMs - based) / 3600000)} 時間）`);
  return issues;
}
