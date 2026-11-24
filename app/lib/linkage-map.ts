// app/lib/linkage-map.ts — 連携の地図（全部の部品の流れを1つの表に・機械が読む元はここだけ・純関数・DB/LLM なし）
//
// 2026-11-15 作業員L（竹内さん 11/15「ちゃんと全部連携できるように。そのためにもそれぞれの土台と統括の精密さがより重要」・KB P0 3041baaa・
//   「地図ちゃんと綺麗に、統括ちゃんと進めれるように」「AIX ツールや LINE 統括の部分との連携も精密に」「従業員への指示の部分も具体的に」）。
//   元の表: conductor-linkage.ts（統括の単位）・conductor-field-links.ts（欄の単位）・delivery-check.ts（書き手まで届いたか）。
//   この地図は流れの単位（お客様の通 → ブレインの読み → 統括 → RAG → 書き手 → 最終チェック → 送った物の記録 → 次の番）で、
//   AIX ツール（条件の読み取り → 候補と🌟 → 送った物 → 反応 → 次の条件）と、LINE ↔ AIX ツールのつなぎ、従業員への指示の流れも同じ細かさで並べる。
//   決まり: 同じ物を別の表やコメントに写さない（人が読む形は formatLinkageMd が作る）。スイッチのコードの既定は手で書かず
//   app/lib/linkage-switch-defaults.ts（scripts/linkage-switch-defaults.ts がソースから読んで作る）を使う。本番の値は brain_switch_versions の最新の行。
//   見張り（毎朝）: linkage-watch-server.runLinkageWatchAndLog を作業員H の朝の1本の cron から呼ぶ（費用0・LLM なし・cron は足さない）。名前は作業員I（統括の判断の表）・H（RAG の選び）・K（物件出し）と揃える（decided・ragPick・toolItem）。

export type LinkFlow = "line" | "aix_tool" | "bridge" | "staff";
export const STAGES = [
  { id: "in", label: "① お客様の通・画像", flow: "line" },
  { id: "read", label: "② ブレインの読み", flow: "line" },
  { id: "conductor", label: "③ 統括", flow: "line" },
  // 2026-11-15 統括役: 作業員I の継ぎ目①〜⑦（番の計画・送った所まで・次の通・AIX のブレイン・送った物の記録・スタッフの画面・途中で変わった時）の行をここに入れる（統括が決める物の名前は combo_order）
  { id: "combo", label: "③ の2 組の段（2通・返信と AIX の組）", flow: "line" },
  { id: "rag", label: "④ RAG（手本・ナレッジ・近い番）", flow: "line" },
  { id: "writer", label: "⑤ 書き手（返信・AIX の1通目と2通目）", flow: "line" },
  { id: "check", label: "⑥ 最終チェック", flow: "line" },
  { id: "sent", label: "⑦ 送った物の記録", flow: "line" },
  { id: "next", label: "⑧ 次の番の材料・物差し・試験", flow: "line" },
  { id: "tool_cond", label: "AIX ツール① お客様の条件の読み取り", flow: "aix_tool" },
  { id: "tool_rank", label: "AIX ツール② 物件の候補と🌟", flow: "aix_tool" },
  { id: "tool_api", label: "AIX ツール③ 拡張が読むサーバーの受け口", flow: "aix_tool" },
  { id: "tool_react", label: "AIX ツール④ お客様の反応 → 次の条件と🌟", flow: "aix_tool" },
  { id: "bridge", label: "つなぎ LINE の統括 ↔ AIX ツール", flow: "bridge" },
  { id: "staff", label: "従業員への指示", flow: "staff" },
] as const;
export type StageId = typeof STAGES[number]["id"];

/** 統括が決める物（作業員I の統括の判断の表と同じ名前で揃える。I の表が main に入ったら I の語彙ファイルに寄せる） */
export const DECIDED_ITEMS = ["focus", "push_strength", "combo_order", "next_send", "writer_roles", "rag_pick"] as const;
export type DecidedItem = typeof DECIDED_ITEMS[number];
export const DECIDED_LABEL: Record<DecidedItem, string> = {
  focus: "重点", push_strength: "一手の強さ（押す・添える・待つ・引く）", combo_order: "返信と AIX の組と順番", next_send: "次に送る物", writer_roles: "書き手に渡す段（文の役目）", rag_pick: "RAG の選び（作業員H）",
};

/** 欄が空でない割合の測り方 */
export type FillSpec =
  | { src: "meta"; path: string }                 // conversations.suggested_aix_meta の道（a.b.c）
  | { src: "digest"; path: string }               // brain_decision_logs.digest の鍵
  | { src: "table"; table: string; col?: string; days: number; where?: Record<string, string> } // 表の直近の行の数（col があればその列が空でない割合）
  | { src: "rag"; name: string }                  // 作業員H の RAG の見張り（空・失敗の割合）につなぐ
  | { src: "none"; why: string };                 // 測れない（理由）

/** 切れていた時にどの穴か（P0 d16cfe1b・fb171011） */
export type GapLayer = "土台" | "連携" | "細かさ";

export type LinkageRow = {
  id: string;
  stage: StageId;
  /** 何をする部品か（日本語1行） */
  name: string;
  /** 作る側（関数・ファイル） */
  producer: string;
  /** 作った物の置き場（meta.xxx / digest.xx / table.col / api:/api/..） */
  key: string;
  /** 読む側（地図の行の id か、部品の名前） */
  readers: string[];
  /** 作る側のスイッチ（全部 on で動く）。[] は常に動く */
  switches: string[];
  /** on とみなす値を決めたスイッチ（例 TURN_READ は log でも動くが meta に入るのは on の時だけ） */
  onWhen?: Record<string, string[]>;
  /** 読む側の親のスイッチ（どれか1つでも off なら読む側が止まっている） */
  readerSwitches: string[];
  fill: FillSpec;
  owner: string;
  /** 切れていた時の穴の種類と次の一手 */
  layer: GapLayer;
  next: string;
  decided?: DecidedItem;
  /** 作業員K の台本の名前（AIX ツールの行） */
  audit?: string;
};

const M = (path: string): FillSpec => ({ src: "meta", path });
const T = (table: string, days: number, col?: string, where?: Record<string, string>): FillSpec => ({ src: "table", table, days, col, where });
/** 2026-11-21 作業員L（統括役の決め・K2 の WATCH_REOPEN_ON_NEW_CUSTOMER）: 見張りの行で読み直した印（verdict_detail.reopened）のある行は前の日・先週との比べから外す */
const REOPEN_OUT: Record<string, string> = { "verdict_detail->reopened": "isnull:" };

export const LINKAGE_MAP: readonly LinkageRow[] = [
  // ① お客様の通・画像
  { id: "in.messages", stage: "in", name: "お客様の通を受けて保存する（LINE の受け口）", producer: "app/api/line-webhook", key: "messages", readers: ["read.brain"], switches: [], readerSwitches: [], fill: T("messages", 1), owner: "統括役", layer: "土台", next: "受け口のログを見る" },
  { id: "in.image_link", stage: "in", name: "お客様の画像を送った物件・号室に結び付けてブレインの材料にする", producer: "app/lib/customer-image-link（作業員H）", key: "材料: お客様の画像の結び付け", readers: ["read.brain", "bridge.image_pref"], switches: ["CUSTOMER_IMAGE_LINK"], readerSwitches: [], fill: T("customer_image_records", 7, "link_kind") /* 11/21 L #480: 画像1枚ごとの記録の結び付けの種類（送った物件・号室） */, owner: "作業員H", layer: "連携", next: "11/20 既定 on（k1119-imgroute-a）・結び付けた数を digest に残す" },
  // 2026-11-21 作業員G（竹内さん 11/21「画像の把握の部分を細かく」）: 画像の把握の表 memory/image_understanding_map.md の行を地図にも置く
  { id: "in.image_label", stage: "in", name: "お客様の画像を受け取った時に Vision で読み、種類の見出し（物件の資料・ポータル・広告・写真・見積書・書類・物件以外）を付ける", producer: "line-webhook → image-label.classifyCustomerImage（IMAGE_LABEL_1115）・id-document-guard", key: "messages.text（[画像] 【見出し】＋書き起こし）・messages.image_type", readers: ["in.image_link", "in.own_property", "in.customer_sent_pref", "read.brain"], switches: ["IMAGE_LABEL_1115"], readerSwitches: [], fill: T("customer_image_records", 7, "kind") /* 11/21 L #480: 画像1枚ごとの種類の見出し */, owner: "作業員G", layer: "土台", next: "-" },
  { id: "in.own_property", stage: "in", name: "お客様の画像の物件名・号室を取り出し、こちらが送った物件と照合する（同じ部屋・同じ建物・分からない）", producer: "own-property-server → own-property-match（extractScreenshotProperty・matchOwnProperty）", key: "材料: お客様が送ってきた物件のうち、こちらが送った物件", readers: ["read.brain", "writer.reply", "in.image_link"], switches: [], readerSwitches: [], fill: T("customer_image_records", 7, "ours_property_name") /* 11/21 L #480: こちらが送った物件と照合できた割合 */, owner: "作業員G", layer: "土台", next: "ポータルの見出しの取り出し（in.portal_title）を試験で on" },
  { id: "in.portal_title", stage: "in", name: "ポータルの画面（SUUMO・HOME'S）の見出しから物件名（と号室）を取る・他社の画面は同じ部屋と言い切らない", producer: "own-property-match.portalTitleProperty（OWN_PROPERTY_PORTAL_TITLE）", key: "ScreenshotProperty（via=portal_title）", readers: ["in.own_property", "in.image_link"], switches: ["OWN_PROPERTY_PORTAL_TITLE"], readerSwitches: [], fill: T("customer_image_records", 7, "name_via") /* 11/21 L #480: 物件名を見出しから取った（name_via=portal_title）割合 */, owner: "作業員G", layer: "細かさ", next: "ブレインの組の試験（q096,q174,q179,q325,q326,q330,q359,q419）で悪化0なら既定 on" },
  { id: "in.image_record", stage: "in", name: "お客様の画像1枚ごとの読み（種類・物件・照合・関連・聞いている事）を記録に残す（書き起こし・文・宛名は入れない）", producer: "customer-image-record-server（CUSTOMER_IMAGE_RECORD）← line-webhook の画像の後処理", key: "customer_image_records", readers: ["物件ごとの記録（property-thread・まだつないでいない）", "監査 audit-image-understanding"], switches: ["CUSTOMER_IMAGE_RECORD"], readerSwitches: [], fill: T("customer_image_records", 7), owner: "作業員G", layer: "土台", next: "on にして1週間の行を読む → property-thread の「お客様が送ってきた」へつなぐ（③）" },
  { id: "in.customer_sent_pref", stage: "in", name: "お客様が自分で送ってきた物件（画像・URL）の値を🌟の順位付けの好みの参考へ", producer: "customer-sent-property（CUSTOMER_SENT_PROPERTY）", key: "材料: お客様が自分で送ってきた物件（好みの参考）", readers: ["tool_rank.star"], switches: ["CUSTOMER_SENT_PROPERTY"], readerSwitches: [], fill: T("customer_image_records", 7, "property_name") /* 11/21 L #480: お客様が送ってきた物件の名前が読めた割合（好みの参考の元） */, owner: "作業員G・作業員K", layer: "連携", next: "-" },

  // ② ブレインの読み
  { id: "read.brain", stage: "read", name: "返信か AIX か・依頼ごとの道を決める（本質の帯）", producer: "app/lib/brain-core.ts", key: "meta.turn_contract", readers: ["conductor.focus", "writer.reply", "conductor.aix_desk"], switches: [], readerSwitches: [], fill: M("turn_contract"), owner: "統括役", layer: "土台", next: "TURN_CONTRACT_BRAIN を確かめる" },
  { id: "read.mindset", stage: "read", name: "お客様の状態（12の状態）・不安の向き・迷い・決め手の残り", producer: "brain（mindset・CUSTOMER_MINDSET）", key: "meta.customer_mindset", readers: ["writer.aix_second", "conductor.brief"], switches: ["CUSTOMER_MINDSET"], readerSwitches: [], fill: M("customer_mindset"), owner: "作業員21", layer: "細かさ", next: "12の状態の細分化（設計図 段1）を on にする試験" },
  { id: "read.turn_read", stage: "read", name: "一通の読み（主の要件・従・潜在）", producer: "brain（TURN_READ）", key: "meta.turn_read", readers: ["conductor.compose_plan"], switches: ["TURN_READ"], onWhen: { TURN_READ: ["on"] }, readerSwitches: ["COMPOSE_SENTENCE_PLAN"], fill: M("turn_read"), owner: "作業員14", layer: "細かさ", next: "TURN_READ=on の試験" },
  { id: "read.seven", stage: "read", name: "竹内さんの7つの欄と潜在の4欄", producer: "brain（BRAIN_SEVEN_FIELDS）", key: "meta.seven_read", readers: ["conductor.compose_plan"], switches: ["BRAIN_SEVEN_FIELDS"], readerSwitches: ["COMPOSE_SENTENCE_PLAN"], fill: M("seven_read"), owner: "作業員10", layer: "細かさ", next: "試験で on" },
  { id: "read.latent_five", stage: "read", name: "潜在の5段と下の種類", producer: "brain（LATENT_FIVE・LATENT_SUBKINDS）", key: "meta.latent_five", readers: ["conductor.compose_plan"], switches: ["LATENT_FIVE"], readerSwitches: ["COMPOSE_SENTENCE_PLAN"], fill: M("latent_five"), owner: "作業員J", layer: "細かさ", next: "作業員J の束1の試験" },
  { id: "read.now_later", stage: "read", name: "今の番の出力と後で果たす物を分ける", producer: "brain（BRAIN_NOW_LATER_FIRST）", key: "meta.now_vs_later", readers: ["conductor.brief"], switches: ["BRAIN_NOW_LATER_FIRST"], readerSwitches: [], fill: M("now_vs_later"), owner: "作業員16", layer: "連携", next: "試験で on" },
  { id: "read.ref", stage: "read", name: "お客様の言葉が指す物（どの物件・どの通）を解く", producer: "brain-core（REF_RESOLVE）", key: "meta.ref_resolve", readers: ["read.brain", "staff.ref_needs"], switches: ["REF_RESOLVE"], readerSwitches: [], fill: M("ref_resolve"), owner: "作業員16", layer: "土台", next: "試験で on" },
  { id: "read.uptake", stage: "read", name: "こちらの直前の送信の受け取られ方（刺さった点）", producer: "brain（BRAIN_OUR_SEND_UPTAKE）", key: "meta.our_send_uptake", readers: ["conductor.brief", "bridge.hooked_to_tool"], switches: ["BRAIN_OUR_SEND_UPTAKE"], readerSwitches: [], fill: M("our_send_uptake"), owner: "作業員16", layer: "連携", next: "刺さった点を AIX ツールの🌟へ渡す配線（bridge.hooked_to_tool）" },
  { id: "read.depth", stage: "read", name: "読む深さ（浅い・普通・深い）", producer: "brain-depth（BRAIN_DEPTH_V2）", key: "meta.brain_depth", readers: ["conductor.allocation"], switches: [], readerSwitches: ["CONDUCTOR_ALLOCATION"], fill: M("brain_depth"), owner: "作業員4", layer: "細かさ", next: "BRAIN_DEPTH_V2 の試験" },
  { id: "read.on_hand", stage: "read", name: "手元の材料（スタッフが確かめた結果・送れる候補・見積の金額）", producer: "material-on-hand（MATERIAL_ON_HAND）", key: "meta.material_on_hand", readers: ["conductor.brief", "sent.task_result"], switches: ["MATERIAL_ON_HAND"], readerSwitches: [], fill: M("material_on_hand"), owner: "作業員22", layer: "土台", next: "試験で shadow" },
  { id: "read.facts", stage: "read", name: "事実の帳面（いつ・どこから）と帳面の食い違い", producer: "customer-fact-ledger（FACT_LEDGER_THREE）", key: "材料: 確かな事実の帳面", readers: ["read.brain"], switches: [], readerSwitches: [], fill: T("customer_fact_ledger", 7) /* 2026-11-21 作業員K2: L の表に fill だけ書き足し（統括役の決め (b)）・#479 の「物件ごとの事実の食い違い」の元。前の注（作業員L）: 材料の塊（meta に残らない） */, owner: "作業員1", layer: "土台", next: "FACT_LEDGER_THREE の試験" },
  { id: "read.situation_now", stage: "read", name: "今の状況の記録（送った事・確認した事・前の項目と答えたか・開いている約束・要件・この番で送った所まで・食い違い・id 付き）", producer: "situation-now.buildSituationNow（BRAIN_SITUATION_NOW）＋要件は作業員M の ask-ledger", key: "meta.situation_now", readers: ["next.situation_grasp", "conductor.brief"], switches: ["BRAIN_SITUATION_NOW"], readerSwitches: [], fill: M("situation_now.sent"), owner: "作業員L（要件は作業員M・next_send は作業員I）", layer: "土台", next: "11/18 既定 shadow（記録だけ）・ASK_LEDGER も shadow 以上で要件の欄が入る・書き手と AIX に渡すのは試験の後" },
  { id: "read.timeline", stage: "read", name: "時系列の帳面（お客様の時の言葉を言った日で直した日付・カレンダーの内覧と約束の予定）", producer: "situation-timeline（BRAIN_SITUATION_TIMELINE）", key: "meta.situation_now.timeline", readers: ["read.brain", "next.situation_grasp"], switches: ["BRAIN_SITUATION_TIMELINE"], readerSwitches: [], fill: M("situation_now.timeline"), owner: "作業員L", layer: "土台", next: "11/15 既定 on（16問×3回で悪化0）・次は書き手・AIX・最終チェックが同じ関数を読む" },
  // 2026-11-23 作業員L（統括役の決め・明日の夜の組の前の確かめ）: スイッチに地図の行が無く、試験の「当たる問題だけ積む」（exam-filled）が当たりを選べなかった
  { id: "read.timeline_wide", stage: "read", name: "時系列の帳面の時の言葉を窓の外のお客様の発言40通からも（入居の時期など）", producer: "brain-core（SITUATION_TIMELINE_WIDE・お客様の発言 40通を1回読む）", key: "meta.situation_now.timeline.words", readers: ["read.brain", "conductor.brief"] /* 2026-11-24 作業員A（#674）: BRIEF_READ_EXTRA=on で指示書の extra.time_words */, switches: ["SITUATION_TIMELINE_WIDE"], readerSwitches: [], fill: M("situation_now.timeline.words"), owner: "作業員L", layer: "連携", next: "既定 off。試験の組み直し（exam-situation-now）は窓 20通のまま＝書き手の段では効かない。ブレインの段で off/on" },
  { id: "read.sent_full", stage: "read", name: "送った物件の件数の切れの直し（取得20件→重複除けで18〜19件・新しい順に詳しく・前は短く）", producer: "sent-props-text（SENT_PROPS_FULL）", key: "材料: すでに送付済みの物件", readers: ["read.brain"], switches: ["SENT_PROPS_FULL"], readerSwitches: [], fill: T("sent_properties", 7, "property_name") /* 2026-11-21 作業員K2: fill だけ書き足し・#479 の「物件ごとの事実（何を送ったか）」の元 */, owner: "作業員L", layer: "土台", next: "11/18 既定 count（見出しの件数だけ全部）・on（それより前の行）は試験の版" },
  { id: "read.exchange", stage: "read", name: "前に送った文の中身の照らし合わせ（聞いた・約束・誘い・送った物件・伝えた事実・AIX と、お客様が答えたか）", producer: "exchange-ledger.buildExchangeLedger（our-part-types）", key: "材料: やり取りの照らし合わせの残り", readers: ["read.brain", "conductor.intake"], switches: ["CONDUCTOR_EXCHANGE_LEDGER_BRAIN"], readerSwitches: [], fill: M("situation_now.our_items") /* 11/21 L #481: 照らし合わせの残りは今の状況の記録の our_items に入る */, owner: "作業員4・作業員L", layer: "連携", next: "作ってあるのに off＝situation_now の 済んだ事・未確定の事 に同じ関数で入れる（作業員I の継ぎ目⑤と同じ欄）" },
  { id: "read.overdue_promises", stage: "read", name: "期限を過ぎて果たしていないこちらの約束（種類・約束した日・期限・何日過ぎたか）", producer: "promise-drop-watch-server.overduePromisesFor・conductor-overdue-promises.overduePromisesLine", key: "材料: 期限を過ぎたこちらの約束", readers: ["conductor.intake"], switches: ["CONDUCTOR_OVERDUE_PROMISES"], readerSwitches: [], fill: T("cron_run_logs", 1, "result_json", { cron_name: "promise-drop-watch" }) /* 11/21 L #481: 同じ線の朝の数え（promise-drop-watch）の記録 */, owner: "作業員N・作業員L", layer: "連携", next: "既定 on（作業員G 11/21）。使われたかは判断の記録の digest の op（#659・audit-overdue-use の conductor_use:overdue_promises:*）" },
  // 2026-11-23 作業員L（統括役の頼み・作業員A の統括の受け持ち表「決めに行く」の持つの段）: 申込予測（apply-readiness・決まった計算）が番ごとに作られ、ブレインの入力に入っているか。
  //   数えは見張りの行の materials.brain.blocks.chars.applyReadiness（ブレインの入力に入った字数・0 は控えない）。分母は7日の見張りの番（ブレインの走らない番も入る＝割合は低めに出る）
  { id: "read.apply_readiness", stage: "read", name: "申込予測（申込が近い合図の数・点数・段＝決まった計算）をブレインの入力に", producer: "apply-readiness.detectApplyReadiness・buildApplyReadinessBrainNote（brain-core の番ごと）", key: "材料: 申込の近さ（ブレインの入力の applyReadiness の塊）", readers: ["read.brain"], switches: [], readerSwitches: [], fill: T("line_watch_turns", 7, "materials->brain->blocks->chars->applyReadiness", REOPEN_OUT), owner: "作業員L", layer: "連携", next: "書き手の側（generate-reply の applyReadinessNote・申込が近い時だけ）は見張りの行に控えが無い＝届いたかを測る口が無い" },
  { id: "read.estimate_records", stage: "read", name: "送った御見積書の記録（物件・号室・初期費用・前の見積の金額）", producer: "estimate-records-block（BRAIN_ESTIMATE_RECORDS）", key: "材料: 送った御見積書（記録）", readers: ["read.brain"], switches: ["BRAIN_ESTIMATE_RECORDS"], readerSwitches: [], fill: T("estimate_records", 7) /* 2026-11-21 作業員K2: fill だけ書き足し・#479 の「物件ごとの事実の初期費用（前の見積の金額）」の元。前の注: AIX【見積書送る】37回/30日は estimate_sent が立たない */, owner: "作業員L", layer: "連携", next: "試験で悪化0を確かめて on" },
  { id: "read.material_clash", stage: "read", name: "材料どうしの食い違いの見張り（記録だけ）", producer: "material-clash（BRAIN_MATERIAL_CLASH）", key: "meta.material_clash", readers: ["next.measure", "conductor.brief"] /* #674: BRIEF_READ_EXTRA=on で extra.clash */, switches: ["BRAIN_MATERIAL_CLASH"], readerSwitches: [], fill: M("material_clash"), owner: "作業員L", layer: "連携", next: "本番で shadow（プロンプトは変えない）" },
  // 2026-11-24 作業員A（#675 の続き・統括役の決め）: ブレインの入力だけだった材料（32行）を1本の口で統括の指示書に（名前・字数・要点24字・LLM の入力は変えない）
  { id: "read.material_index", stage: "read", name: "材料の目録（その番のブレインの入力に有った材料の名前・字数・要点）", producer: "conductor-material-index.buildMaterialIndex（brain-core・CONDUCTOR_MATERIAL_INDEX）", key: "meta.conductor_brief.extra.materials", readers: ["conductor.brief"], switches: ["CONDUCTOR_MATERIAL_INDEX", "MATERIAL_INDEX_GAP"], readerSwitches: [], fill: M("conductor_brief.extra.materials"), owner: "作業員A", layer: "連携", next: "既定 on（記録だけ）。本番で目録が入った番と判断の記録の書き込みの時間を朝に見る（効き目は統括が目録を判断に使う部品を作ってから）" },
  { id: "read.judge_basis", stage: "read", name: "判断の根拠のメモ（深さ・重点・優先・順番・目的）", producer: "brain（BRAIN_JUDGE_BASIS）", key: "meta.judge_basis_rec", readers: ["next.measure", "conductor.brief"] /* #674: on の時の meta.judge_basis は aim が前から読む・shadow の rec は BRIEF_READ_EXTRA=on で extra.basis */, switches: ["BRAIN_JUDGE_BASIS"], readerSwitches: [], fill: M("judge_basis_rec"), owner: "作業員L", layer: "細かさ", next: "--majority で悪化0を確かめてから shadow（11/15 試験で本質の道 7→4）" },

  { id: "read.route_map", stage: "read", name: "申込までの地図の駅（決定論の位置）", producer: "apply-route-map（APPLY_ROUTE_MAP）", key: "材料: 申込までの地図", readers: ["read.brain"], switches: ["APPLY_ROUTE_MAP"], readerSwitches: [], fill: M("apply_route.node") /* 11/21 L #481: 作業員M の APPLY_ROUTE_RECORD（既定 on）が meta に駅を残す */, owner: "作業員7", layer: "土台", next: "地図の駅を状況の記録の欄に" },
  { id: "read.route_substate", stage: "read", name: "駅の中の細かい状態（送った・反応待ち・刺さらず・候補切れ）", producer: "apply-route-map（APPLY_ROUTE_SUBSTATE）", key: "材料: 駅の中の状態", readers: ["read.brain"], switches: ["APPLY_ROUTE_SUBSTATE"], readerSwitches: [], fill: M("apply_route.substate") /* 11/21 L #481: 同じく駅の中の状態 */, owner: "作業員7", layer: "細かさ", next: "束5 の試験（設計図 追記2）" },
  { id: "read.aims_after", stage: "read", name: "道の後に目的・中期を決まった計算で（TURN_AIMS_AFTER・返信の番だけ）", producer: "turn-aims-after.metaWithTurnAimsAfter（generate-reply の中で作る）", key: "書き手の受け渡し（conductor-handoff の decided）", readers: ["conductor.compose_plan"], switches: ["TURN_AIMS_AFTER"], readerSwitches: ["CONDUCTOR_HANDOFF"], fill: M("turn_aims_after") /* 11/21 L: 作業員M の APPLY_ROUTE_RECORD（既定 on）が同じ計算（deriveTurnAimsAfter）で meta に残す */, owner: "作業員7", layer: "連携", next: "届いた数を [turn-aims-after] のログから数える（状況の記録に入れる）" },
  { id: "read.topic_state", stage: "read", name: "話題の済み・開き（答えていない問い）", producer: "conductor-topic-state（CONDUCTOR_TOPIC_STATE）", key: "材料: 話題", readers: ["read.brain"], switches: ["CONDUCTOR_TOPIC_STATE"], readerSwitches: [], fill: M("material_marks.topic_state") /* 11/21 L: 材料の1行を足した印（字数・数だけ・既定 on） */, owner: "作業員4", layer: "細かさ", next: "試験で on" },
  { id: "read.fact_ledger3", stage: "read", name: "事実の帳面3つ（一次・まとめ・食い違い）", producer: "customer-fact-ledger（FACT_LEDGER_THREE）", key: "材料: 確かな事実の帳面", readers: ["read.brain"], switches: ["FACT_LEDGER_THREE"], readerSwitches: [], fill: T("customer_fact_ledger", 7) /* 2026-11-21 作業員K2: fill だけ書き足し・#479 の「物件ごとの事実の食い違い」の元 */, owner: "作業員1", layer: "土台", next: "状況の記録の元に" },
  { id: "read.now_fulfillable", stage: "read", name: "今果たせる約束（手元に結果がある約束）", producer: "situation-now（SITUATION_NOW_FULFILLABLE）", key: "材料: 今果たせる約束", readers: ["read.brain"], switches: ["SITUATION_NOW_FULFILLABLE"], readerSwitches: [], fill: M("material_marks.now_fulfillable") /* 11/21 L: 材料の1行を足した印（字数・数だけ・既定 on） */, owner: "作業員1", layer: "連携", next: "約束の完了の結び付けとつなぐ" },
  { id: "read.staff_hand", stage: "read", name: "スタッフの手元（確かめた結果・送れる候補）", producer: "staff-hand（BRAIN_STAFF_HAND）", key: "材料: スタッフの手元", readers: ["read.brain"], switches: ["BRAIN_STAFF_HAND"], readerSwitches: [], fill: T("property_pickups", 7, undefined, { status: "pending" }) /* 2026-11-21 作業員K2: fill だけ書き足し・#479 の「なぜ選んだか（送れる候補）」の元 */, owner: "作業員22", layer: "土台", next: "案A の結果とつなぐ" },
  { id: "read.promise_read", stage: "read", name: "約束の読み（1つにした読み手）", producer: "promise-read（PROMISE_READ_UNIFIED）", key: "材料: 約束", readers: ["read.brain","writer.aix_second"], switches: ["PROMISE_READ_UNIFIED"], readerSwitches: [], fill: M("situation_now.promises_open") /* 11/21 L #481: 約束の読みの元の事実（送った事の約束の行）が今の状況の記録の開いている約束に入る */, owner: "作業員25", layer: "連携", next: "約束の読み手が7つある（line-watch-turn・promise-read・second-message-materials・aix-second-link・customer-fact-ledger・override-demote・promise-queue）＝1つに" },
  { id: "read.ack_confirm", stage: "read", name: "了承の番は約束を果たす AIX の道のまま（ACK_CONFIRM_AIX_PATH）", producer: "repeat-brain-align", key: "材料: 今の番の1行", readers: ["read.brain"], switches: ["ACK_CONFIRM_AIX_PATH"], readerSwitches: [], fill: M("material_marks.ack_confirm") /* 11/21 L: 材料の1行を足した印（字数・数だけ・既定 on） */, owner: "作業員D", layer: "連携", next: "材料の食い違い（q091）の直し" },
  { id: "read.promise_order", stage: "read", name: "約束を果たす順（promise-queue・PROMISE_FULFIL_ORDER はコードに無い名前）", producer: "promise-queue", key: "材料: 約束の順", readers: ["read.brain"], switches: [], readerSwitches: [], fill: T("aix_action_items", 7, undefined, { resolution_note: "like:rule:promise_queue%" }) /* 11/21 L #481: 約束の並びが立てた次の要対応 */, owner: "作業員7", layer: "細かさ", next: "-" },
  { id: "staff.overdue", stage: "staff", name: "期日を過ぎた約束の知らせ（AIX_OVERDUE_REMIND）", producer: "aix-overdue-remind", key: "通知", readers: ["スタッフ"], switches: ["AIX_OVERDUE_REMIND"], readerSwitches: [], fill: T("cron_run_logs", 7, "result_json->overdue_sent", { cron_name: "staff-todo-list" }) /* 2026-11-21 作業員M（#482）: staff-todo-list の便のうち知らせ直しを送った便の割合（AIX_OVERDUE_REMIND=on の時だけ入る） */, owner: "作業員1", layer: "連携", next: "約束の id と結んだ期日で知らせる" },
  { id: "staff.promise_drop", stage: "staff", name: "約束の取りこぼしの見張り（ピックアップ・確認を約束して期限を過ぎても物件・確認の結果が届いていない会話・1日1回）", producer: "promise-drop-watch（PROMISE_DROP_WATCH・既定は記録だけ）", key: "cron_run_logs.promise-drop-watch（朝 5:25 の数え）・staff-todo-list の promise_drop_sent（送った便）", readers: ["スタッフ"], switches: ["PROMISE_DROP_WATCH"], onWhen: { PROMISE_DROP_WATCH: ["on", "shadow", ""] }, readerSwitches: [], fill: T("cron_run_logs", 2, "result_json", { cron_name: "promise-drop-watch" }) /* 2026-11-21 作業員L（#435）: 朝の数えの記録（記録だけの間も入る）。送ったかは staff-todo-list の result_json の promise_drop_sent */, owner: "作業員L", layer: "連携", next: "竹内さんの OK の後に PROMISE_DROP_WATCH=on（グループに出す）" },
  // ③ 統括
  { id: "conductor.intake", stage: "conductor", name: "入口の統括（表→背景→重点・近い番）", producer: "conductor-intake（CONDUCTOR_INTAKE）", key: "meta.conductor_intake", readers: ["conductor.focus"], switches: ["CONDUCTOR_INTAKE"], readerSwitches: [], fill: M("conductor_intake"), owner: "作業員4", layer: "連携", next: "shadow を本番で" },
  { id: "conductor.lessons", stage: "conductor", name: "統括の学び（試験と本番の外れの型となぜ）を入口の統括に", producer: "conductor-lessons-server.loadConductorLessons（CONDUCTOR_LESSONS・既定 shadow＝記録だけ）", key: "meta.conductor_lessons（読んだ学びの id・digest の ls）", readers: ["conductor.intake"], switches: ["CONDUCTOR_LESSONS"], readerSwitches: [], fill: M("conductor_lessons.ids"), owner: "作業員L・作業員H", layer: "連携", next: "本番は今の行が10未満の間は読まない・似ている度合い 0.62 未満は読まない（CONDUCTOR_LESSONS_MIN_SIM）。試験は1行から" },
  { id: "conductor.focus", stage: "conductor", name: "重点（この番で一番大切にする事）", producer: "conductor-focus（CONDUCTOR_FOCUS）", key: "meta.conductor_focus", readers: ["conductor.compose_plan", "writer.reply"], switches: ["CONDUCTOR_FOCUS"], readerSwitches: ["COMPOSE_SENTENCE_PLAN"], fill: M("conductor_focus"), owner: "作業員5", layer: "連携", next: "重点が書き手で使われたかの印（decided-use）", decided: "focus" },
  { id: "conductor.near", stage: "conductor", name: "近い竹内さんの番の意見", producer: "conductor-near（CONDUCTOR_NEAR_OPINION）", key: "meta.near_opinion", readers: ["read.brain", "conductor.compose_plan"], switches: ["CONDUCTOR_NEAR_OPINION"], readerSwitches: ["COMPOSE_DECIDED"], fill: M("near_opinion"), owner: "作業員4", layer: "連携", next: "COMPOSE_DECIDED の試験" },
  { id: "conductor.check_order", stage: "conductor", name: "判断の順番の型と場面×状態の優先の行", producer: "check-order-wire（CHECK_ORDER_TABLE）", key: "meta.check_order", readers: ["conductor.allocation", "conductor.brief"], switches: ["CHECK_ORDER_TABLE"], readerSwitches: [], fill: M("check_order"), owner: "作業員16・作業員I", layer: "細かさ", next: "作業員I の統括の判断の表とこの行を1つに" },
  { id: "conductor.allocation", stage: "conductor", name: "番ごとの部品の配分（深さ・費用の上限）", producer: "conductor-allocation（CONDUCTOR_ALLOCATION）", key: "meta.conductor_allocation", readers: ["next.measure"], switches: ["CONDUCTOR_ALLOCATION"], readerSwitches: [], fill: M("conductor_allocation"), owner: "作業員22", layer: "連携", next: "shadow を本番で" },
  { id: "conductor.brief", stage: "conductor", name: "統括の指示書（具体の一覧・疑いの印・確かさ）", producer: "conductor-brief（CONDUCTOR_BRIEF）", key: "meta.conductor_brief", readers: ["writer.reply", "conductor.compose_roles"], switches: ["CONDUCTOR_BRIEF"], readerSwitches: ["COMPOSE_BRIEF_ROLES"], fill: M("conductor_brief"), owner: "作業員22", layer: "連携", next: "shadow を本番で", decided: "push_strength" },
  { id: "conductor.combo", stage: "conductor", name: "何通・どの順・各通の受け持ち（返信と AIX の組）", producer: "conductor-combine（CONDUCTOR_COMBINE）", key: "meta.two_message_plan", readers: ["writer.reply", "writer.aix_second"], switches: ["CONDUCTOR_COMBINE"], readerSwitches: [], fill: M("two_message_plan"), owner: "作業員7", layer: "連携", next: "違う番の planFromMeta を直してから on（aix_second の宿題）", decided: "combo_order" },
  { id: "conductor.aims", stage: "conductor", name: "この番の目的・中期の狙い・仕込み", producer: "turn-aims-after（TURN_AIMS_AFTER・既定 on）＝道が決まった後の状態の表の狙い（旧のブレインの欄 BRAIN_TURN_AIMS は凍結・既定 off）", key: "meta.turn_aims_after（文の統括へは conductor-handoff が metaWithTurnAimsAfter で渡す）", readers: ["conductor.compose_plan"], switches: ["TURN_AIMS_AFTER"], readerSwitches: ["CONDUCTOR_HANDOFF"], fill: M("turn_aims_after") /* 2026-11-23 作業員L（統括役の頼み・作業員A の受け持ち表）: 作り手を凍結した BRAIN_TURN_AIMS から既定 on の TURN_AIMS_AFTER に */, owner: "作業員7", layer: "連携", next: "全体の統括（お客様ごとの計画）に束ねる" },
  { id: "conductor.our_side", stage: "conductor", name: "こちら側の帳面（開いている約束・送った物件・見積・内覧）を文へ", producer: "conductor-our-side（OUR_SIDE_TO_COMPOSE）", key: "meta.our_side_note", readers: ["conductor.compose_plan"], switches: ["OUR_SIDE_TO_COMPOSE"], readerSwitches: ["COMPOSE_SENTENCE_PLAN"], fill: M("our_side_note"), owner: "作業員4", layer: "連携", next: "試験で on" },
  { id: "conductor.aix_desk", stage: "conductor", name: "AIX の統括（どのボタン×ピッカー・差し戻し）", producer: "aix-commander（AIX_DESK_COMMAND）", key: "meta.aix_desk", readers: ["read.brain", "writer.aix_first"], switches: ["AIX_DESK_COMMAND"], readerSwitches: [], fill: M("aix_desk"), owner: "作業員1・作業員I", layer: "連携", next: "-" , decided: "next_send" },
  { id: "conductor.compose_plan", stage: "conductor", name: "文の統括の1文ずつの設計図（役目・何を・どうやって）", producer: "compose-sentence-plan（COMPOSE_SENTENCE_PLAN）", key: "書き手の注記: 設計図", readers: ["writer.reply"], switches: ["COMPOSE_SENTENCE_PLAN"], readerSwitches: [], fill: T("line_watch_turns", 7, "materials->reply->compose_plan", REOPEN_OUT) /* 2026-11-21 作業員M（#483）: WATCH_COMPOSE_PLAN（11/21 から既定 on・=off で止める）の控え */, owner: "作業員10", layer: "連携", next: "書き手で使われたかの印", decided: "writer_roles" },
  { id: "conductor.compose_roles", stage: "conductor", name: "指示書の欄を文の役目ごとに書き手へ", producer: "compose-brief-roles（COMPOSE_BRIEF_ROLES）", key: "書き手の注記: 役目ごと", readers: ["writer.reply"], switches: ["COMPOSE_BRIEF_ROLES"], readerSwitches: [], fill: T("line_watch_turns", 7, "materials->reply->compose_plan->note->roles", REOPEN_OUT) /* 2026-11-21 作業員M（#483）: 役目ごとの注記の控え（WATCH_COMPOSE_PLAN・既定 on） */, owner: "作業員22", layer: "連携", next: "CONDUCTOR_BRIEF と一緒に試験", decided: "writer_roles" },
  { id: "conductor.delivery", stage: "conductor", name: "決めた事が書き手まで届いたかの記録", producer: "delivery-check（DELIVERY_CHECK）", key: "meta.delivery_check", readers: ["next.measure"], switches: ["DELIVERY_CHECK"], readerSwitches: [], fill: M("delivery_check"), owner: "作業員22", layer: "連携", next: "shadow を本番で（記録だけ）" },

  // ④ RAG
  { id: "rag.reply_examples", stage: "rag", name: "返信の手本（ai_reply_examples）を場面で引く", producer: "generate-reply の手本の RAG", key: "書き手の材料: 手本", readers: ["writer.reply"], switches: [], readerSwitches: [], fill: { src: "rag", name: "reply_examples" }, owner: "作業員H", layer: "土台", next: "作業員H の RAG の見張りとつなぐ", decided: "rag_pick" },
  { id: "rag.knowledge", stage: "rag", name: "ナレッジ（ai_reply_knowledge）を引く", producer: "generate-reply のナレッジの RAG", key: "書き手の材料: ナレッジ", readers: ["writer.reply", "read.brain"], switches: [], readerSwitches: [], fill: { src: "rag", name: "knowledge" }, owner: "作業員H", layer: "土台", next: "作業員H の RAG の見張りとつなぐ", decided: "rag_pick" },
  { id: "rag.takeuchi", stage: "rag", name: "竹内さんの手本（match_takeuchi_compose）", producer: "takeuchi-compose の RAG", key: "書き手の材料: 竹内さんの手本", readers: ["writer.reply"], switches: [], readerSwitches: [], fill: { src: "rag", name: "takeuchi_compose" }, owner: "作業員H", layer: "土台", next: "作業員H の RAG の見張りとつなぐ", decided: "rag_pick" },
  { id: "rag.winning", stage: "rag", name: "勝ちパターン（winning_patterns）", producer: "brain-core の勝ちパターン", key: "meta.winning_pattern", readers: ["writer.reply", "writer.aix_second"], switches: [], readerSwitches: [], fill: M("winning_pattern"), owner: "作業員H", layer: "土台", next: "-", decided: "rag_pick" },
  { id: "rag.aix_examples", stage: "rag", name: "AIX の手本（AIX の文の手本・カード）", producer: "aix-template-generate の手本", key: "AIX の書き手の材料", readers: ["writer.aix_second"], switches: [], readerSwitches: [], fill: { src: "rag", name: "aix_examples" }, owner: "作業員H", layer: "土台", next: "作業員H の RAG の見張りとつなぐ", decided: "rag_pick" },
  { id: "rag.near_focus", stage: "rag", name: "近い番の重点（conductor_turn_vectors・match_conductor_focus）", producer: "conductor-focus-server", key: "meta.conductor_focus.near", readers: ["conductor.focus"], switches: ["CONDUCTOR_FOCUS"], readerSwitches: [], fill: M("conductor_focus.near"), owner: "作業員5・作業員H", layer: "連携", next: "-", decided: "rag_pick" },

  // ⑤ 書き手
  { id: "writer.reply", stage: "writer", name: "返信の文を書く（本質の帯・設計図・手本）", producer: "app/api/generate-reply", key: "下書き（suggested_reply）", readers: ["check.final"], switches: [], readerSwitches: [], fill: T("line_watch_turns", 7, "draft_first") /* 2026-11-22 作業員M: 番ごとの最初の下書き（見張りの行） */, owner: "作業員9", layer: "土台", next: "決めた事が文で使われたかの印（decided-use）" },
  { id: "writer.situation", stage: "writer", name: "書き手への今の状況（時の言葉の日付・これからの内覧・開いている約束・確かめた結果）", producer: "situation-now.situationWriterNote（SITUATION_WRITER_NOTE）", key: "書き手の注記: 今の状況", readers: ["writer.reply"], switches: ["SITUATION_WRITER_NOTE", "BRAIN_SITUATION_NOW"], readerSwitches: [], fill: T("line_watch_turns", 7, "materials->reply->compose_plan->note->situation") /* 2026-11-22 作業員M: 書き手への注記の控え（WATCH_COMPOSE_PLAN・既定 on／中身は SITUATION_WRITER_NOTE=on の時だけ） */, owner: "作業員L", layer: "連携", next: "11/18 既定 on（下書きまで10問×2回で悪化0）" },
  { id: "writer.timeline_promises", stage: "writer", name: "書き手への今の状況に、時系列の帳面の約束（その日の約束・カレンダーの終日の【必ず】）も", producer: "situation-now.situationWriterNote（SITUATION_WRITER_TIMELINE_PROMISES）", key: "書き手の注記: 今の状況の約束の行（数は meta.situation_now.timeline.promises）", readers: ["writer.reply"], switches: ["SITUATION_WRITER_TIMELINE_PROMISES"], readerSwitches: ["SITUATION_WRITER_NOTE"], fill: M("situation_now.timeline.promises"), owner: "作業員L", layer: "連携", next: "既定 off。試験の組み直しはカレンダーの【必ず】を今の is_done で読む＝後で済みの約束はその番でも済みに見える（効く問題が 319問中6問）" },
  { id: "writer.aix_first", stage: "writer", name: "AIX の1通目（テンプレート・ピッカーの文）", producer: "app/api/aix/action", key: "aix_usage_logs.generated_text", readers: ["sent.aix_usage"], switches: [], readerSwitches: [], fill: T("aix_usage_logs", 7, "generated_text"), owner: "作業員1", layer: "土台", next: "-" },
  { id: "writer.aix_second", stage: "writer", name: "AIX の2通目（✨・材料→訴求の判断→書き手→締め）", producer: "app/api/aix-template-generate", key: "AIX の2通目の文", readers: ["sent.aix_usage"], switches: ["SECOND_MSG_MATERIALS", "AIX_SECOND_APPEAL_JUDGE"], readerSwitches: [], fill: T("aix_generate_log", 7, "generated_text", { "conditions_snapshot->>source": "aix-template-generate" }) /* 2026-11-22 作業員M: 2通目（テンプレートの生成）は aix_generate_log に1行ずつ残っている（9/18 から） */, owner: "作業員25", layer: "連携", next: "2通目に届いていない欄（NOT_YET_TO_AIX_SECOND）を順に" },

  // ⑥ 最終チェック
  { id: "check.final", stage: "check", name: "送る前の確かめ・書き直し（誤った事実・決まりの線だけ）", producer: "app/lib/final-check.ts", key: "最終チェックの記録", readers: ["sent.messages"], switches: [], readerSwitches: [], fill: { src: "none", why: "最終チェックの結果は llm_usage_logs と画面だけ" }, owner: "作業員9", layer: "連携", next: "決めた事を最終チェックが消した印（decided-use の check_dropped）" },

  // ⑦ 送った物の記録
  { id: "sent.messages", stage: "sent", name: "スタッフが送った文（書き手 takeuchi／employee）", producer: "send-line-message", key: "messages.staff_writer", readers: ["next.measure", "read.brain"], switches: [], readerSwitches: [], fill: T("messages", 1, "staff_writer", { sender: "staff" }), owner: "統括役", layer: "土台", next: "-" },
  { id: "sent.aix_usage", stage: "sent", name: "送った AIX（種類・ピッカー・物件名・状態）", producer: "log-aix-usage", key: "aix_usage_logs", readers: ["next.ledger", "tool_react.sent_props"], switches: [], readerSwitches: [], fill: T("aix_usage_logs", 7, "property_names"), owner: "作業員1", layer: "土台", next: "-" },
  { id: "sent.images", stage: "sent", name: "送った物件の画像と物件の結び付け", producer: "send-line-message（画像）", key: "sent_image_properties", readers: ["in.image_link", "tool_react.sent_props"], switches: [], readerSwitches: [], fill: T("sent_image_properties", 7), owner: "作業員H", layer: "土台", next: "-" },
  { id: "sent.image_role", stage: "sent", name: "送る画像のうち見積書に役目（image_details.kind=estimate）を先に付ける", producer: "estimate-image-role（AIX_ESTIMATE_IMAGE_ROLE）", key: "image_details.kind", readers: ["in.image_link", "引用の読み（image-detail-store）"], switches: ["AIX_ESTIMATE_IMAGE_ROLE"], readerSwitches: [], fill: T("image_details", 7, "kind"), owner: "作業員H・作業員G", layer: "土台", next: "60日で役目も物件も無い送った画像 582枚（AIX 491）の中身を分ける" },
  { id: "sent.image_facts", stage: "sent", name: "送った資料の画像の中身の読み（家賃・管理費・敷礼・間取り・面積・駅徒歩・築年・現況）を送った物件の行へ", producer: "sent-image-record → sent_image_properties.facts／sent-props-text（SENT_IMAGE_FACTS_TO_BRAIN）", key: "sent_image_properties.facts → 材料: すでに送付済みの物件", readers: ["read.brain"], switches: ["SENT_IMAGE_FACTS_TO_BRAIN"], readerSwitches: [], fill: T("sent_image_properties", 7, "facts"), owner: "作業員L", layer: "連携", next: "11/21 既定 on（試験 L1120-sipfacts-a/b 悪化0）→ 本番でブレインに届いた番を数える" },
  { id: "sent.image_rooms", stage: "sent", name: "送った資料の画像の部屋ごとの帖数（LDK・洋室）を facts.rooms に残す", producer: "property-image-read（IMAGE_READ_ROOMS）", key: "sent_image_properties.facts.rooms", readers: ["sent.image_facts"], switches: ["IMAGE_READ_ROOMS"], readerSwitches: ["SENT_IMAGE_FACTS_TO_BRAIN"], fill: T("sent_image_properties", 7, "facts->rooms") /* 2026-11-22 L #486: IMAGE_READ_ROOMS が off の間は 0（on にした後の届き方の物差し） */, owner: "作業員L", layer: "細かさ", next: "作業員L の試験" },
  { id: "sent.estimate", stage: "sent", name: "送った御見積書の金額", producer: "fill-estimate", key: "estimate_records", readers: ["read.brain", "read.on_hand"], switches: [], readerSwitches: [], fill: T("estimate_records", 7), owner: "見積書の担当", layer: "土台", next: "-" },
  { id: "sent.task_result", stage: "sent", name: "物件確認の結果をタスクに付ける（案A）", producer: "TASK_RESULT_FROM_AIX（作業員H）", key: "line_tasks.result", readers: ["read.on_hand", "staff.task"], switches: ["TASK_RESULT_FROM_AIX"], readerSwitches: ["MATERIAL_ON_HAND"], fill: T("line_tasks", 14, "result"), owner: "作業員H", layer: "連携", next: "試験で on・結果がブレインの手元の材料に戻るか" },

  // ⑧ 次の番
  { id: "next.ledger", stage: "next", name: "行動台帳（したこと・宣言しただけのこと）を次の番の材料に", producer: "action-ledger", key: "材料: 行動台帳", readers: ["read.brain"], switches: [], readerSwitches: [], fill: { src: "none", why: "材料の塊" }, owner: "作業員4", layer: "土台", next: "-" },
  { id: "next.decision_log", stage: "next", name: "判断の記録（digest）＝毎晩の見張り・試験の問題の元", producer: "brain-core（brain_decision_logs）", key: "brain_decision_logs.digest", readers: ["next.measure"], switches: [], readerSwitches: [], fill: T("brain_decision_logs", 1, "digest"), owner: "統括役", layer: "土台", next: "-" },
  { id: "next.situation_grasp", stage: "next", name: "現状把握の物差し（ブレインが持っていた今 × その番の DB の事実・欄ごと）", producer: "scripts/audit-situation-grasp（試験の答案×問題の台帳の写し×録音の入力）", key: "cron_run_logs（situation-grasp）", readers: ["next.measure"], switches: [], readerSwitches: [], fill: T("cron_run_logs", 8, undefined, { cron_name: "situation-grasp" }), owner: "作業員L", layer: "土台", next: "本番の番にも当てる（材料の有無を digest に残す）" },
  { id: "sent.promise_close", stage: "sent", name: "約束と果たした通の結び付け（どの約束をどの通で果たしたか・detail.closed_by）", producer: "promise-close-link（sent-facts.upsertFacts の後・PROMISE_CLOSE_LINK）", key: "sent_facts.detail.closed_by", readers: ["read.brain", "staff.aix_notice"], switches: ["PROMISE_CLOSE_LINK"], readerSwitches: [], fill: T("sent_facts", 7, "detail->closed_by", { status: "promised" }) /* 2026-11-22 L #486・#567: 約束の行のうち閉じた印（detail.closed_by）がある割合（7日: 102行中 30）。全部の結び方は scripts/audit-promise-close */, owner: "作業員L", layer: "土台", next: "既定 on（記録だけ・11/15）。1週間の見本で確かめてから読む側7つを closed_by に揃える" },
  { id: "next.measure", stage: "next", name: "物差し・試験・弱い所の台帳（判断の根拠・届き・食い違いを数える）", producer: "scripts/judge-basis-score・audit-material-clash・brain-exam", key: "試験の答案・cron_run_logs", readers: [], switches: [], readerSwitches: [], fill: { src: "none", why: "道具" }, owner: "作業員8・作業員I・作業員L", layer: "細かさ", next: "-" },
  { id: "next.provider_fit", stage: "next", name: "相手（OpenAI・DeepSeek）の使い方の表の版ごとの物差し（キャッシュの当たり・欄の欠け・長さの比・竹内さんの文との近さ・言ってはいけない事・時間切れと Claude への戻り）", producer: "scripts/audit-provider-fit.ts（app/lib/provider-profile.ts の版）", key: "quality_daily（metric=provider_fit:<版>:<物差し>）", readers: ["next.measure"], switches: [], readerSwitches: [], fill: T("quality_daily", 7, "value", { metric: "provider_fit:rows" }) /* 2026-11-24 作業員L（#670 の子・竹内さん「GPT の性質に合わせるのを徹底する仕組み」） */, owner: "作業員L", layer: "連携", next: "版を上げる時は前の版と同じ問題で比べ、悪化0なら DEFAULT_VERSIONS を替える" },

  // AIX ツール（作業員K）
  { id: "tool_cond.writers", stage: "tool_cond", name: "条件を書く5つの経路（format・p4・brain_bridge・condition_brain・path_c）", producer: "property_condition_history の書き手", key: "property_condition_history", readers: ["tool_cond.arbiter", "tool_rank.judge"], switches: [], readerSwitches: [], fill: T("property_condition_history", 7), owner: "作業員K", layer: "土台", next: "-", audit: "audit-condition-write-arbiter" },
  { id: "tool_cond.arbiter", stage: "tool_cond", name: "自動の書き手どうしの取り合いの関所", producer: "condition-write-arbiter（CONDITION_WRITE_ARBITER）", key: "property_customers の条件", readers: ["tool_rank.judge", "tool_api.customers"], switches: ["CONDITION_WRITE_ARBITER"], readerSwitches: [], fill: { src: "none", why: "止めた数は audit-condition-write-arbiter で数える" }, owner: "作業員K", layer: "連携", next: "-", audit: "audit-condition-write-arbiter" },
  { id: "tool_rank.judge", stage: "tool_rank", name: "物件ごとに通す・保留・外すと点（judgeProperty）", producer: "property-brain.judgeProperty", key: "property_pickups.reason_codes", readers: ["tool_rank.star"], switches: [], readerSwitches: [], fill: T("property_pickups", 7, "reason_codes"), owner: "作業員K", layer: "細かさ", next: "-", audit: "audit-prop-brain-score" },
  { id: "tool_rank.star", stage: "tool_rank", name: "🌟（一番オススメ）の並べ方（rankStarCandidates・star-rank-pickup）", producer: "recommend-star-rank.rankStarCandidates", key: "property_pickups の🌟", readers: ["tool_api.pickups", "writer.aix_first"], switches: [], readerSwitches: [], fill: { src: "none", why: "🌟の当たりは audit-prop-brain-score で数える" }, owner: "作業員K", layer: "細かさ", next: "-", audit: "audit-prop-brain-score" },
  { id: "tool_rank.pickup_rank", stage: "tool_rank", name: "ピックアップの説明文に AD を補い🌟を付ける（pickup-rank）", producer: "pickup-rank", key: "property_pickups", readers: ["tool_api.pickups"], switches: [], readerSwitches: [], fill: T("property_pickups", 7), owner: "作業員K", layer: "土台", next: "-", audit: "audit-prop-brain-score" },
  { id: "tool_api.customers", stage: "tool_api", name: "拡張が読むお客様の条件の受け口", producer: "/api/property-customers", key: "api:/api/property-customers", readers: ["拡張（Cursor の担当）"], switches: [], readerSwitches: [], fill: { src: "none", why: "受け口（呼ばれた数は Vercel のログ）" }, owner: "作業員K", layer: "土台", next: "-" },
  { id: "tool_api.learn", stage: "tool_api", name: "拡張が読む人の動きの学び（human-learn-profile）", producer: "/api/human-learn-profile・human-learn-brain", key: "human_learn_profile", readers: ["拡張（Cursor の担当）"], switches: ["HUMAN_LEARN_PROFILE_GUARD"], readerSwitches: [], fill: T("human_learn_profile", 30), owner: "作業員H・作業員K", layer: "土台", next: "-" },
  { id: "tool_api.snapshots", stage: "tool_api", name: "拡張の画面の写し（extension-snapshots）", producer: "/api/extension-snapshots", key: "extension_snapshots", readers: ["next.measure"], switches: [], readerSwitches: [], fill: T("extension_snapshots", 7), owner: "作業員K", layer: "土台", next: "-" },
  { id: "tool_api.pickups", stage: "tool_api", name: "売上サポの候補（property-pickups）を画面と AIX へ", producer: "/api/property-pickups", key: "property_pickups", readers: ["writer.aix_first", "read.brain"], switches: [], readerSwitches: [], fill: T("property_pickups", 7), owner: "作業員K", layer: "土台", next: "-" },
  { id: "tool_react.sent_props", stage: "tool_react", name: "送った物件・🌟の記録（recommendation_snapshots・sent_properties）", producer: "AIX の物件送付", key: "recommendation_snapshots", readers: ["tool_rank.star", "read.brain"], switches: [], readerSwitches: [], fill: T("recommendation_snapshots", 14), owner: "作業員K", layer: "土台", next: "-", audit: "audit-prop-brain-score" },
  { id: "tool_react.customer_sent", stage: "tool_react", name: "お客様が送ってきた物件・好みの画像を条件の欄へ", producer: "customer-image-link・画像の3つの型（H-14）", key: "property_customers の要望の欄", readers: ["tool_rank.judge"], switches: ["CUSTOMER_IMAGE_LINK", "CUSTOMER_IMAGE_TASTE_WANTS"], readerSwitches: [], fill: { src: "none", why: "要望の欄の書き足しは property_condition_history の writer で数える" }, owner: "作業員H・作業員K", layer: "連携", next: "-" },

  // つなぎ LINE ↔ AIX ツール
  { id: "bridge.condition", stage: "bridge", name: "LINE のブレインが読んだ条件の言い直しを AIX ツールの条件へ（brain_bridge）", producer: "brain-core の条件の書き戻し", key: "property_condition_history（writer=brain_bridge）", readers: ["tool_cond.arbiter"], switches: [], readerSwitches: ["CONDITION_WRITE_ARBITER"], fill: T("property_condition_history", 7, undefined, { source_message_id: "like:brain_bridge:%" }), owner: "作業員K", layer: "連携", next: "-", audit: "audit-condition-write-arbiter" },
  { id: "bridge.hooked_to_tool", stage: "bridge", name: "刺さった点・気持ちを AIX ツールの🌟の重みへ", producer: "hook-points（SENT_HOOK_POINTS）← line-webhook-text.resolvePropertyReference", key: "sent_properties.customer_hook_points", readers: ["tool_rank.star"], switches: ["BRAIN_OUR_SEND_UPTAKE"], readerSwitches: [], fill: T("sent_properties", 7, "customer_hook_points") /* 2026-11-22 作業員M: 11/21 に K2 が配線（hook-points・SENT_HOOK_POINTS 既定 on・引用の返信の時に送った物件へ刺さった点）。🌟の重み（SENT_HOOK_WEIGHT）は既定 off */, owner: "作業員K・作業員L", layer: "連携", next: "全体の統括（お客様ごとの計画）の「送る物件の方針」から🌟へ渡す" },
  { id: "bridge.image_pref", stage: "bridge", name: "好みの画像の特徴を AIX ツールの要望の欄へ", producer: "H-14（画像の3つの型）", key: "property_customers の要望の欄", readers: ["tool_rank.judge"], switches: ["CUSTOMER_IMAGE_LINK", "CUSTOMER_IMAGE_TASTE_WANTS"], readerSwitches: [], fill: T("property_condition_history", 7, undefined, { source_message_id: "like:image_taste%" }) /* 2026-11-22 作業員M: 書き手 image_taste の条件の書き足し */, owner: "作業員H・作業員K・作業員G", layer: "連携", next: "11/21 作業員G: 書くのは CUSTOMER_IMAGE_TASTE_WANTS（既定 off）。60日で好みの手本の画像の番は0〜少数＝要る範囲は image_understanding_map.md の C6" },
  { id: "bridge.tool_to_brain", stage: "bridge", name: "AIX ツールで送った物と結果を LINE のブレインの次の番の材料へ", producer: "sent_properties・property-told・送った束", key: "材料: 送った束・この発言が指す送った事", readers: ["read.brain"], switches: [], readerSwitches: [], fill: T("sent_properties", 7, "property_name") /* 2026-11-22 作業員M: ブレインが読む送った物件の記録（read.sent_full と同じ元） */, owner: "作業員4・作業員K", layer: "連携", next: "-" },

  // 従業員への指示
  { id: "staff.aix_notice", stage: "staff", name: "AIX要対応の通知（グループへ〇〇さん宛て）", producer: "aix-action-items", key: "aix_action_items", readers: ["スタッフ"], switches: [], readerSwitches: [], fill: T("aix_action_items", 7), owner: "作業員1", layer: "細かさ", next: "指示の欄（何を・どの物件の何を・いつまで・なぜ・終わったら何を記録）を足す" },
  { id: "staff.task", stage: "staff", name: "line_tasks（物件確認・タスクの作り方）", producer: "line-tasks の作り方", key: "line_tasks", readers: ["スタッフ", "sent.task_result"], switches: [], readerSwitches: [], fill: T("line_tasks", 14, "result_note"), owner: "作業員H", layer: "細かさ", next: "同上" },
  { id: "staff.todo_cron", stage: "staff", name: "スタッフのやる事の一覧（staff-todo-list の cron）", producer: "app/api/cron/staff-todo-list", key: "cron_run_logs（staff-todo-list）", readers: ["スタッフ"], switches: [], readerSwitches: [], fill: T("cron_run_logs", 7, undefined, { cron_name: "staff-todo-list" }) /* 2026-11-21 作業員M（#482）: 便ごとに1行書くようにした */, owner: "統括役", layer: "細かさ", next: "同上" },
  { id: "staff.ref_needs", stage: "staff", name: "人に回す段の注記（物件名・号室が要る：ref_needs_name/room）", producer: "CONDUCTOR_STAFF_CHECK", key: "meta.ref_resolve.needs", readers: ["スタッフ"], switches: ["CONDUCTOR_STAFF_CHECK"], readerSwitches: [], fill: M("ref_resolve"), owner: "作業員16", layer: "細かさ", next: "-" },
  { id: "staff.condition_suggest", stage: "staff", name: "AIX ツールの画面の「条件の更新の案」", producer: "property-conditions の案", key: "条件の更新の案", readers: ["スタッフ"], switches: [], readerSwitches: [], fill: T("line_watch_turns", 7, "materials->brain->condition_suggest", REOPEN_OUT) /* 2026-11-21 作業員M（#482）: 条件の書き込みの仲裁で止めた欄を見張りの行に印（画面に出すのは aix_feature_suggestions の案が通ってから） */, owner: "作業員K", layer: "細かさ", next: "-" },
];

/** 地図の全部のスイッチの名前（作る側＋読む側・並べ替えて重なりなし） */
export function mapSwitchNames(rows: ReadonlyArray<LinkageRow> = LINKAGE_MAP): string[] {
  return [...new Set(rows.flatMap((r) => [...r.switches, ...r.readerSwitches]))].sort();
}

// ── 状態の決め方 ──────────────────────────────────────────────
export type SwitchState = { name: string; value: string; from: "prod" | "default" | "unknown"; on: boolean };
export type RowStatus = "connected" | "broken" | "parent_off" | "sparse" | "unknown";
export const STATUS_LABEL: Record<RowStatus, string> = { connected: "つながっている", broken: "切れている", parent_off: "親が off", sparse: "空が多い", unknown: "測れない" };
export type RowResult = { id: string; status: RowStatus; why: string; fill: number | null; fillN: number | null; offSwitches: string[]; offReaders: string[] };

/** スイッチの値 → on か（off・0・false・なし・空は off） */
export const isOnValue = (v: string) => !["off", "0", "false", "なし", "", "?"].includes(v.trim().toLowerCase());

/**
 * 本番の値（brain_switch_versions の最新の行の K=V）とコードの既定から、スイッチの今の状態を決める。
 * 本番の記録は SWITCH_PREFIXES の頭の名前だけ入る＝記録に無い名前は、頭が記録の範囲ならコードの既定、範囲の外なら unknown（既定で見る）。
 */
export function switchStateOf(name: string, prod: Record<string, string> | null, defaults: Record<string, string>, recordedPrefixes: ReadonlyArray<string>): SwitchState {
  if (prod && name in prod) return { name, value: prod[name], from: "prod", on: isOnValue(prod[name]) };
  const def = defaults[name] ?? "?";
  const covered = prod != null && recordedPrefixes.some((p) => name.startsWith(p));
  return { name, value: def, from: covered ? "default" : "unknown", on: isOnValue(def) };
}

export const SPARSE_BELOW = 0.3;
/** 1行の状態（fills は行の id → {rate, n}・rate は 0〜1） */
export function rowStatus(row: LinkageRow, sw: (name: string) => SwitchState, fills: Record<string, { rate: number | null; n: number } | undefined>): RowResult {
  const onOf = (s: string) => { const st = sw(s); const want = row.onWhen?.[s]; return want ? want.includes(st.value.trim().toLowerCase()) : st.on; };
  const offSwitches = row.switches.filter((s) => !onOf(s));
  const offReaders = row.readerSwitches.filter((s) => !sw(s).on);
  const f = fills[row.id];
  const fill = f?.rate ?? null, fillN = f?.n ?? null;
  const base = { id: row.id, fill, fillN, offSwitches, offReaders };
  if (offSwitches.length) return { ...base, status: "parent_off", why: `作る側のスイッチが off: ${offSwitches.join("・")}` };
  if (row.producer.startsWith("（無い）")) return { ...base, status: "broken", why: "作る側（配線）が無い" };
  if (offReaders.length) return { ...base, status: "broken", why: `作る側は動いているが読む側が off: ${offReaders.join("・")}` };
  if (!row.readers.length && row.stage !== "next") return { ...base, status: "broken", why: "読む側が無い" };
  if (row.fill.src === "rag") return { ...base, status: "unknown", why: "RAG の空・失敗の割合は作業員H の RAG の見張りから（まだつないでいない）" };
  if (row.fill.src === "none") return { ...base, status: "unknown", why: row.fill.why };
  if (fill == null || fillN == null) return { ...base, status: "unknown", why: "本番の記録を読めなかった" };
  if (fillN === 0) return { ...base, status: "broken", why: "本番の直近の記録に1行も無い" };
  if (fill === 0) return { ...base, status: "broken", why: `作る側は on なのに本番の記録で欄が全部空（0/${fillN}）` };
  if (fill < SPARSE_BELOW) return { ...base, status: "sparse", why: `欄が空でない割合 ${Math.round(fill * 100)}%（${fillN} 行）` };
  return { ...base, status: "connected", why: `欄が空でない割合 ${Math.round(fill * 100)}%（${fillN} 行）` };
}

/** 道（a.b.c）で値を取り、空でないか */
export function nonEmptyAt(obj: unknown, path: string): boolean {
  let v: unknown = obj;
  for (const k of path.split(".")) { if (!v || typeof v !== "object") return false; v = (v as Record<string, unknown>)[k]; }
  if (v == null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}
/** meta の並び → 行ごとの空でない割合（src=meta の行だけ） */
export function metaFills(metas: ReadonlyArray<unknown>, rows: ReadonlyArray<LinkageRow> = LINKAGE_MAP): Record<string, { rate: number; n: number }> {
  const out: Record<string, { rate: number; n: number }> = {};
  for (const r of rows) {
    if (r.fill.src !== "meta") continue;
    const path = r.fill.path;
    const n = metas.length, hit = metas.filter((m) => nonEmptyAt(m, path)).length;
    out[r.id] = { rate: n ? hit / n : 0, n };
  }
  return out;
}

// ── 人が読む形 ──────────────────────────────────────────────
export type WatchReport = { at: string; results: RowResult[]; prevBroken: number | null; switches: Record<string, SwitchState> };
const stageLabel = (s: StageId) => STAGES.find((x) => x.id === s)?.label ?? s;
const isCut = (s: RowStatus) => s === "broken" || s === "parent_off" || s === "sparse";

/** 毎朝の拾い上げの1行（切れている行の数・先週から増えた／減った） */
export function summaryLine(rep: Pick<WatchReport, "results" | "prevBroken">): string {
  const by = (s: RowStatus) => rep.results.filter((r) => r.status === s).length;
  const cut = by("broken");
  const diff = rep.prevBroken == null ? "先週の記録なし" : `先週 ${rep.prevBroken} → ${cut}（${cut - rep.prevBroken >= 0 ? "+" : ""}${cut - rep.prevBroken}）`;
  return `連携の地図: 切れている ${cut}行・親が off ${by("parent_off")}行・空が多い ${by("sparse")}行・つながっている ${by("connected")}行・測れない ${by("unknown")}行（全 ${rep.results.length}）｜${diff}`;
}

/** 人が読む md（切れている行を一番上に・段ごとに行を並べる） */
export function formatLinkageMd(rep: WatchReport, rows: ReadonlyArray<LinkageRow> = LINKAGE_MAP): string {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const res = new Map(rep.results.map((r) => [r.id, r]));
  const on = (r: LinkageRow) => { const all = [...r.switches]; if (!all.length) return "常に動く"; return all.map((s) => { const st = rep.switches[s]; return st ? `${s}=${st.value}${st.from === "prod" ? "（本番）" : st.from === "default" ? "（既定）" : "（本番の記録の外・既定）"}` : s; }).join("・"); };
  const pct = (x: RowResult | undefined) => (x && x.fill != null ? `${Math.round(x.fill * 100)}%（${x.fillN}行）` : "-");
  const out: string[] = [`# 連携の地図（${rep.at}）`, "", summaryLine(rep), ""];
  const cuts = rep.results.filter((r) => isCut(r.status)).sort((a, b) => ["broken", "parent_off", "sparse"].indexOf(a.status) - ["broken", "parent_off", "sparse"].indexOf(b.status));
  out.push("## 切れている行（直す順）", "", "| 状態 | 段 | 部品 | 穴 | なぜ | 次の一手 | 持ち主 |", "|---|---|---|---|---|---|---|");
  for (const x of cuts) { const r = byId.get(x.id)!; out.push(`| ${STATUS_LABEL[x.status]} | ${stageLabel(r.stage)} | ${r.name} | ${r.layer} | ${x.why} | ${r.next} | ${r.owner} |`); }
  for (const st of STAGES) {
    const rs = rows.filter((r) => r.stage === st.id);
    if (!rs.length) continue;
    out.push("", `## ${st.label}`, "", "| 部品 | 作る側 → 読む側 | 本番で on か | 欄が空でない割合 | 状態 | 持ち主 |", "|---|---|---|---|---|---|");
    for (const r of rs) {
      const x = res.get(r.id);
      const readers = r.readers.map((id) => byId.get(id)?.name.slice(0, 18) ?? id).join("・") || "（無し）";
      out.push(`| ${r.name}${r.decided ? `〔統括: ${DECIDED_LABEL[r.decided]}〕` : ""}${r.audit ? `〔台本 ${r.audit}〕` : ""} | ${r.producer}（${r.key}）→ ${readers} | ${on(r)} | ${pct(x)} | ${x ? STATUS_LABEL[x.status] : "-"} | ${r.owner} |`);
    }
  }
  return out.join("\n");
}
