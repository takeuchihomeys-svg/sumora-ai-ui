import Anthropic from "@anthropic-ai/sdk";
import { after } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { maskPII } from "@/app/lib/pii-mask";
import { generateEmbedding } from "@/app/lib/knowledge-utils";
import {
  AIX_STAFF_NOTES,
  AIX_BUTTON_LABELS,
  AIX_LINE_LABELS,
  buildAixStaffNote,
  buildAixLineNote,
  detectPropertyCheckPattern,
  normalizeAixActionKey,
} from "@/app/lib/aix-taxonomy";
import { BRAIN_SKIP_STATUSES } from "@/app/lib/conversation-status";

// ── brain-core: 脳分析の単一実装（single writer）─────────────────────────────
// これまで brain/list と cron/brain-weekly に約250行が copy-paste され、
// 線引きルールのヒューリスティック等が乖離していた。本モジュールが唯一の実装。
//
// 呼び出し元:
//   - line-webhook: 顧客メッセージ受信時（suggested_aix_meta を null に消すのと同じ場所で
//     after() から analyzeAndSaveBrainMeta を fire-and-forget 起動 = イベント駆動再計算）
//   - cron/brain-sweep: webhook の分析が失敗した会話を拾うバックストップ（5分毎）
//   - brain/list は純粋な read のみ（Haiku は一切呼ばない）

const BRAIN_MODEL = "claude-sonnet-5";
// B8(Fable5): maxRetries: 0 — sweep自体がリトライ機構のため、SDKの自動リトライ（デフォルト2回）は
// 最悪 ~45秒/件 × 4件直列 = maxDuration 120秒超過 → cron_run_logs が "running" のまま残る事故の原因だった
// claude-sonnet-5のextended thinking対応: タイムアウト30s→60s（長い会話で思考に時間がかかるため）
// sweep側は MAX_SWEEP_PER_RUN=3 + 並列3 で1ラウンドのみ → 最大60s → maxDuration=120s 内に収まる
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 0, defaultHeaders: { "anthropic-beta": "prompt-caching-2024-07-31" } });

// Statuses that indicate a closed/inactive conversation — excluded from brain analysis
// applying/application/screening は全成約が通過する申込フェーズのため除外（平均42日・169件の学習例あり）
// 定義は conversation-status.ts に集約（既存の import 元互換のため re-export を維持）
export { BRAIN_SKIP_STATUSES };

// Conversations updated within this window are flagged as urgent
export const URGENT_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

export type SuggestedAixMeta = {
  action: string;
  note: string;
  source: string;
  // "optional" は cached 返却パス（stale meta の強制アクション抑制）でのみ設定される
  enforcement_level: "required" | "recommended" | "optional";
  // property_check_result の1キー多義解消: 会話文脈から判定したサブパターン
  // （mgmt_initial_cost / nearby_parking / mgmt_guarantor 等）。判定できた場合、
  // note は「確認した（条件・交渉）」ボタンへの具体的指示になる（aix-taxonomy.ts 参照）
  check_pattern?: string | null;
  closing_strategy?: string;
  template_hint?: string;  // 次に使うべきAIXタブのラベルカテゴリ名（TEMPLATE_HINT_ALLOWED_LABELS の含む判定を通過した値のみ。例: "物件ピックアップした", "1件特にオススメする", "①申込み時フォーマット（連帯保証人）"。トーン説明等の自由記述はゲートで null に落ちる）
  next_steps?: string[];  // ["Step1: 具体的アクション", "Step2: AIXボタン○○を押す", "Step3: 【AIX】○○テンプレートを送る"]
  reply_mode?: "aix" | "auto_reply";  // 'aix'=スタッフがAIXで手動対応 / 'auto_reply'=AI自動返信OK
  // 2択UIフラグ: proposing フェーズで条件トレードオフ質問が来た場合に「AIXで物件追加オススメ」か「テキスト返信」かをスタッフが選ぶ
  two_choice_mode?: boolean;           // 2択UI表示フラグ（物件提案中フェーズで条件トレードオフ質問検出時）
  reply_direction_label?: string;      // 返信方向の要約ラベル（10字以内・two_choice_mode=true時のみ設定。例: 「条件説明」「不安解消」「相場説明」）
  // Chrome拡張フィードバックループ用: 拡張が brain/list API 経由で取得し検索フォームに自動入力する
  property_search_params?: {
    area: string | null;
    floor_plan: string | null;
    rent_max: number | null;
    walk_minutes: number | null;
    move_in_time: string | null;
    preferences: string | null;
    ng_points: string | null;
    ng_properties: Array<{ property_name: string; room_no: string }>;
    search_urgency: string; // "★★★" | "★★" | "★" | "─"
  } | null;
  // generate-reply への指示フィールド（brainにしかわからないDB知識から導く）
  reply_direction?: string | null;   // 返信の方向性を20字以内で
  key_topics?: string[];             // 返信に必ず含める内容（最大3件）
  avoid_topics?: string[];           // 返信で絶対に言及しない内容（最大5件）
  urgency_appropriate?: boolean;     // 危機感・緊急表現が今回適切か
  recommended_tone?: string | null;  // 推奨トーン: "共感的"|"テキパキ"|"慎重"|"明るく前向き"|"普通"
  // ── Step1（analyzeCustomerSituation）廃止に伴う message-local 分析フィールド ──
  // 最新の顧客メッセージ基準で毎回ゼロから再判定される（差分分析モードでも前回値を引き継がない）
  customer_questions?: string[];         // 最新メッセージ内の質問・確認事項（最大5件・各40字）
  repeated_concern?: string | null;      // 会話全体で2回以上登場した繰り返し確認テーマ（20字）
  current_property?: string | null;      // 話題の中心の物件名・号室（実在ゲート通過値のみ・創作はnull）
  condition_change_type?: "area_change" | "rent_change" | "layout_change" | "equip_add" | "condition_relax" | "pickup_request" | "multi" | null;  // 最新メッセージでの条件変更種別
  hesitancy_pattern?: "thinking" | "callback" | "waiting" | "undecided" | "timeline" | null;  // 決断保留パターン
  future_timeline?: string | null;       // 顧客が示した決断・申込タイムライン（会話に実際に出た表現のみ・30字）
  checkpoint_stage?: "hearing" | "proposing" | "viewing" | "applying" | "contract" | null;  // 会話の実態フェーズ
  customer_intent?: "question" | "consultation" | "desire" | "decision" | "positive" | "negative" | "chat" | null;  // 顧客の今回の問い合わせ意図
  latent_intent?: string | null;         // 送信動機・潜在意識の自由記述（なぜ今送ってきたか・表面の裏の不安/期待。20〜50字・根拠なければnull）
  // 鮮度ゲート基準: この分析が見た最新顧客メッセージの created_at。
  // generate-reply 側で「analyzed_msg_ts >= 最新顧客メッセージ」なら T1（fresh）、古ければ T2（stale）判定に使う
  analyzed_msg_ts?: string | null;
  // 直近AIXボタン履歴（最新→旧順・generate-reply RAG文脈強化用）
  last_aix_history?: string | null;
  // ── analyzeConversation → analyzeAndSaveBrainMeta 内部伝搬フィールド ──
  // SOURCE_ACCEPT_RATE 品質ゲートで finalAix が null 化された事実のフラグ。
  // conversation_direction 更新側で detectSignalBasedAixFallback の再実行をスキップし、
  // 抑制済み低品質アクションが suggested_aix_button に復活するバイパス経路を塞ぐ。
  // ※ 初回接触 null 化・そもそも提案なし等の他の null 理由とは明確に区別する（正当な direction 補完は殺さない）
  aix_suppressed_by_accept_rate?: boolean;
  // analyzeConversation 内で detectSignalBasedAixFallback を実行済みか＋その結果（ゲート適用前の値）。
  // direction 更新側の二重実行（6本のDBクエリ×2）を回避するための持ち回り。
  signal_aix_ran?: boolean;
  signal_aix_result?: string | null;
  // LLMの行動選択理由（≤30字）
  reason?: string | null;
  // ai_summary_jsonからの勝ちパターン
  winning_pattern?: string | null;
  // ai_summary_jsonからの感情状態
  customer_emotion?: string | null;
  // 購買シグナル強度（none=一般質問 / soft=1件具体確認 / strong=異カテゴリ2件以上 / peak=申込直前最強）
  // peak は「質問件数」ではなく「発言の質」で判定する。申込許可伺い・物件名指し確定・金額の復唱・
  // 手続き/審査プロセスの具体質問は単独1件でも peak（成約データ分析で判明した盲点シグナル）。
  purchase_signal_level?: "none" | "soft" | "strong" | "peak" | null;
  // M4: 押す／待つの局面軸。purchase_signal_level が「熱量→もっと押す」の一方向しか制御できないため、
  // 「押してはいけない局面」を独立軸で持つ。generate-reply の purchase_signal_level ブロックを
  // "wait" のときゲート（丸ごとスキップ）する。message-local判定のため前回値は引き継がない。
  // "wait"=強推し直後の待ちフェーズ・ネガ文脈直後 / "push"=高熱かつ顧客が迷っている / null=通常
  engagement_stance?: "push" | "wait" | null;
  human_type_label?: string | null;  // 顧客タイプ（winning_patternsのRAGヒット上位から取得。prevMetaで引き継ぎ）
} | null;

// Canonical mapping from AIX action key → staff guidance note
// Keys must match AIX_ACTION_META keys in page.tsx
// 2026-08 AIXボタン種別アナウンス改善: generate-reply の AIX_ACTION_NOTES との二重管理を解消し、
// aix-taxonomy.ts の AIX_STAFF_NOTES を単一ソースとして共有する（文言乖離の構造的防止）。
// ※ STATUS_MEANING にも会話ステータスとして property_search が存在するが、これは意図的な同名
//   （ステータス=条件ヒアリング段階 / アクション=拡張ツールでの物件検索実行）。混同注意。
//   page.tsx の AIX_ACTION_META には同キー追加済み（「物件を探す」・2026-08確認）。
const AIX_BRAIN_NOTES: Record<string, string> = AIX_STAFF_NOTES;

// Case1対策: 顧客が物件条件を能動的に問い合わせた局面（「〜はありますか」「広め」「間取り」
// 「ダブルベッド」「〇LDK」等）の検出用。この局面の正解は property_send
// （まず探す旨を顧客に伝える → 検索 → ピックアップ送付）であり、
// property_search（スタッフ内向きの検索指示のみ・顧客向けアクションなし）ではない。
// detectSignalBasedAixFallback の信号6.5 と analyzeConversation の finalAix 矯正の両方で使用する。
// ※ generate-reply の newConditionRequestNote（T2/T3決定論フォールバック）とも共有するため export（二重定義禁止）
export const PROPERTY_CONDITION_INQUIRY_RE =
  /あります(か|でしょうか)|ありません(か|でしょうか)|ないか|お?部屋.{0,6}(探し|紹介)|物件.{0,6}(探し|紹介)|探して(ほしい|もらえ|ください|いただ)|広め|広い(お?部屋|物件)|間取り|ベッ[ドト]|[0-9０-９][SLDKR]{1,3}|ワンルーム|バス.?トイレ別|ペット可|駐車場|ガレージ|駅.{0,10}(徒歩|近く?|大丈夫)|家賃.{0,4}万|でも大丈夫/;

// 5品質ルール決定論ゲート用定数（analyzeConversation の return 直前で使用）
// recommended_tone の許可値ホワイトリスト（template_hint の TEMPLATE_HINT_ALLOWED_LABELS と同型のフェイルクローズ）
const TONE_ALLOWED = ["共感的", "テキパキ", "慎重", "明るく前向き", "普通"] as const;
// ルール②: 顧客の最終メッセージに費用質問が含まれるかの判定
const COST_QUESTION_RE = /見積|初期費用|総額|いくら|幾ら|費用|金額/;
// ルール③: 顧客を急かす危機感・緊急表現の判定。
// 「すぐ」は「すぐお調べします」等スタッフ自身の行動表現で誤検知するため含めない
export const URGENCY_EXPRESSION_RE = /今なら|今しか|お早め|早い者勝ち|先着|残り\s*[0-9０-９一二三四五]+\s*[件室部戸]|あと\s*[0-9０-９一二三四五]+\s*[件室戸]|埋まって(?:しま|る|い)|なくなる前/;

// Maps raw DB conversation status to a Japanese meaning string injected into the Haiku prompt
const STATUS_MEANING: Record<string, string> = {
  first_reply:             "完全初回（はじめてのお客様・挨拶必須）",
  hearing:                 "条件ヒアリング段階（物件未提案・条件確認中）",
  condition_hearing:       "条件ヒアリング段階（物件未提案・条件確認中）",
  property_search:         "条件ヒアリング段階（物件未提案・条件確認中）",
  proposing:               "物件提案中（物件を送った後・顧客の反応待ち。顧客が興味・内覧希望を示すまで内覧提案はしない）",
  property_recommendation: "物件提案中（物件を送った後・顧客の反応待ち。顧客が興味・内覧希望を示すまで内覧提案はしない）",
  viewing:                 "物件提案中（内覧調整段階）",
  estimate_request:        "物件提案中（見積書依頼段階）",
  availability_check:      "物件提案中（空室確認段階）",
  applying:                "申込・審査中（クロージング段階）",
  application:             "申込・審査中（申込書類収集段階）",
  screening:               "申込・審査中（審査進行中）",
  contract:                "契約済み（成約完了）",
  approved:                "審査通過済み（入居待ち・鍵渡し前）",
};

// RAG化 Phase1: フェーズ→AIXアクション候補マップ（値は AIX_BRAIN_NOTES のキーのみ使用）。
// 前回brain分析のフェーズ（conversation_direction.current_phase）から「今回の局面で関係しそうな
// アクション」を事前に絞り、ai_prompt_rules のアクション連動ルール取得（.in("action_type", ...)）に使う。
// フェーズ遷移直後の1回は旧フェーズ基準で動くため、隣接フェーズのアクションを重複して持たせて実害を最小化
// （例: proposing に viewing_invite を含める）。
const PHASE_ACTION_CANDIDATES: Record<string, string[]> = {
  hearing:   ["condition_hearing", "property_search", "property_send", "followup_revive"],
  proposing: ["property_send", "property_recommendation", "property_search", "acknowledge_check", "property_check_result", "estimate_sheet", "viewing_invite", "followup_revive"],
  viewing:   ["viewing_invite", "meeting_place", "greeting_viewing", "estimate_sheet"],
  applying:  ["application_push", "estimate_sheet", "acknowledge_check"],
};

// convStatus → フェーズの粗い写像（前回フェーズが無い場合のフォールバック）。
// キーは STATUS_MEANING と同一集合（contract / approved / closed_* は BRAIN_SKIP_STATUSES のため到達しない）。
// 未知ステータス・NULL は phaseEstimate=null → 全AIXアクションにフォールバック（取りこぼしゼロ側に倒す）
const STATUS_TO_PHASE: Record<string, string> = {
  first_reply:             "hearing",
  hearing:                 "hearing",
  condition_hearing:       "hearing",
  property_search:         "hearing",
  proposing:               "proposing",
  property_recommendation: "proposing",
  estimate_request:        "proposing",
  availability_check:      "proposing",
  viewing:                 "viewing",
  applying:                "applying",
  application:             "applying",
  screening:               "applying",
};

// Concise AIX capability summary injected into Haiku prompts for action/template reasoning
const AIX_CAPABILITY_MAP = `
【AIXボタン能力マップ】
- viewing_invite: 内覧日程の候補をLINEで提案するメッセージを生成（顧客メッセージに内覧・内見・見学・見に行く等の希望表現があれば選ぶ）
- property_send: 物件ピックアップのカバーメッセージを生成（物件URL送信時）→ 複数件ピックアップ後は必ず1〜2分以内（実測38秒／58秒）に「物件ピックアップ紹介（後続）」を、駅指定・条件外れ告知ありなら「駅周辺物件ピックアップ（後続）」（実測1分33秒）をAI最適化して自発送信する
- estimate_sheet: 見積書を読み取り自動計算+カバーメッセージ生成 → 送付直後（同分〜1分以内）に「【申込誘導】」テンプレートで申込を促す（use_count:10・見積書→申込誘導→申込の3ステップが成約最短ルート）
- application_push: 申込クロージングメッセージ（①申込時フォーマット本体）を生成 → 送信直後（実測32秒〜4分48秒）に「②申込時フォーマット（続き）」を一字一句そのまま自発送信する（AI最適化禁止）
- condition_hearing: 既知条件をスキップした条件ヒアリングを生成
- acknowledge_check: 管理会社への空室確認+見積書依頼を生成
- followup_revive: 追客・再接触メッセージを生成
- property_check_result: 空室確認結果の報告文を生成（「物件確認した」）→ 2番手での申込が可能と判明した場合は+1分30秒で「（2番手・申込）」を顧客名の置換のみで自発送信する。【重要】フリーレント可否・礼金/初期費用の交渉結果・ペット可否・駐車場有無・設備有無など管理会社に確認した結果はすべてこのボタンの「管理会社に確認した」サブパターンで報告する。acknowledge_check で確認を依頼した後に管理会社から回答が届いたら必ず property_check_result を選ぶこと。confirm前に結果を捏造してはいけない。【誤選択防止】顧客が「駐車場付きのお部屋がないか」「駐車場付きで探してほしい」等と言っている場合は property_check_result ではなく property_send を選ぶ（これは現在提案中の物件の設備確認ではなく、新しい設備条件での物件探しの依頼 = equip_add）
- property_recommendation: Vision読み取りで物件紹介文を生成（1件詳細）→ 押下後は「1件特にオススメ」で感情的フォローを追加する（実測1分22秒。原文そのままの送信実績はゼロなので"1件に絞って推す"思想のみ流用し全面リライトする）
- meeting_place: 内覧の待ち合わせ場所案内を生成
- greeting_viewing: 内覧前後の挨拶メッセージを生成
- property_search: お客さんの条件に合う物件を拡張ツールで検索する（適用条件: 最終物件送付から7日以上経過、または送付件数0件。next_steps例:「リアプロ/itandiでエリア×間取りを検索」「家賃上限以下・駅徒歩条件で絞り込み」「検索結果から送付済み物件を除いて候補をピックアップ」）※顧客が今まさに条件を尋ねてきた場合（「〜はありますか」「広めがいい」等）は property_search ではなく property_send を選ぶこと。※弊社TikTok/Instagram等のSNS動画で見た物件に問い合わせてきた場合、内覧希望があればviewing_invite、物件を探している段階ならproperty_searchを選ぶ（弊社TikTok掲載物件は40㎡以上・家賃15万円以上が中心のため、顧客の予算・条件に合わない場合は別エリア・条件での代替提案をnext_stepsに含める）

【aixキー選択の使いどころ基準（迷ったらここを優先）】
- estimate_sheet: 申込到達会話で最も効果実績が高いボタン（applying_pattern の most_effective 最多）。見積書画像が届いた／顧客が物件画像だけを送ってきた（テキストなし・スクショのみ）／顧客が特定物件を気に入った（かつ新条件指定なし）／初期費用・総額を質問してきた時点で迷わず選ぶ
  【重要例外】顧客が同時に路線・駅名・家賃上限・徒歩分数・間取り・広さ等の新しい検索条件を示している場合は、気に入り表現があっても estimate_sheet を選ばない → property_send が正しい（条件変更が主題のサイン）。「家賃は〜万まで」という家賃予算の表明は「初期費用・総額の話題」ではない（家賃予算 ≠ 初期費用）。「○○がいい感じ」+「環状線のみで調べてほしい」「9万以下で探してほしい」等の組み合わせは常に property_send。
- acknowledge_check: 顧客が物件URL・物件名を送ってきて空室/募集状況が未確認の時。確認前に内覧・申込の話へ進めない ※画像のみ送信（テキストなし）の場合は acknowledge_check ではなく estimate_sheet を選ぶこと
- property_check_result: 未完了タスクに「物件確認（空室確認）」があり管理会社から回答が届いた時
- followup_revive: 【時間情報】の最終顧客メッセージが3日以上前で、予約送信済みメッセージが無い時
- property_search: 【物件検索統括】の物件検索推奨度が★★★（7日以上送付なし or 送付0件）の時
- application_push: 内覧完了後・見積送付後に顧客が前向きな時。審査不安の「解消」を先回りする場面でも有効（申込確定の言質は不要）
- viewing_invite / meeting_place / greeting_viewing: 【内覧履歴・予定】を必ず見る。日程未確定→viewing_invite / 確定済み未来→meeting_place / 当日・完了後→greeting_viewing ※viewing_invite は顧客メッセージに内覧希望が示された場合に選ぶ。「内覧行きたいらしいですが」「内覧可能ですか」「見に行きたい」等の間接・伝聞・打診表現も内覧希望として viewing_invite を選ぶこと。スタッフが物件を送った後に顧客が内覧・内見・見学・見に行く等のキーワードで反応した場合も viewing_invite。ただしスタッフが送った物件情報内の「〇月〇日以降内覧可能」「内覧可」等の文言をトリガーにしない（顧客メッセージ内のキーワードのみ対象）。物件送付直後で顧客がまだ反応していない場合は aix:null（何も提案しない）が正解
- 成約の典型順（黄金フロー）: condition_hearing → property_send → property_recommendation → estimate_sheet → viewing_invite → meeting_place → application_push（property_check_result は顧客が物件URLを送ってきた時の割り込みアクションであり順序フローに含めない）
`.trim();

// AIX遷移マップはaix_transition_statsテーブルから動的取得（brain関数内で構築）。
// 旧ハードコード AIX_NEXT_ACTION_MAP は2026-08-27にDB化。

// 返信文体・共感フレーズ・条件変更文脈の恒久ルール（generate-reply の同名ルールと同一の単一基準）
// closing_strategy / next_steps / template_hint がこのルールに反する提案を出さないようにするための静的ブロック。
const REPLY_STYLE_RULES = `
【返信スタイルの恒久ルール（closing_strategy・next_steps の内容もこれに従うこと）】
■ 冒頭挨拶（許可されるのはこの3つのみ）
- 「〇〇さん、お世話になっております！！」（標準・迷ったらこれ）
- 「〇〇さん、お待たせ致しました！！」（お待たせした後・物件や資料をお送りする時）
- 「〇〇さん、いつもありがとうございます！！」（継続的なやりとりで感謝が自然な文脈のみ）
- 完全初回（first_reply）のみ「〇〇さん、はじめまして😊！！…お部屋探しを担当させて頂きます鈴木と申します！！」
- 「ありがとうございます」だけを挨拶代わりの書き出しにするのは禁止。「夜分遅くに失礼致します」は返信時は禁止

■ 共感フレーズの使い分け（AIが最も間違えるポイント）
- 「全然大丈夫です」→ 使ってOK。顧客が「すみません」「申し訳ない」等と恐縮している場合に使う
- 「全然わがままじゃないですよ」「わがままじゃないです」等『わがまま』を含むフレーズ → 顧客自身が「わがままですみません」等と『わがまま』というワードを使った場合のみ使用可。顧客が言っていない場合は絶対に使わない
- どちらにも当てはまらない場合は共感フレーズを入れず、行動宣言に直行する

■ 条件変更・新条件文脈（顧客が「〇〇の条件の部屋はありますか？」「〇〇でも大丈夫です」「環状線のみで調べてほしい」等の新条件・要望を出した場合）
- 返信の型: 挨拶 →（該当時のみ共感）→ 条件を理解した旨 → 物件ピックアップの行動宣言 → 満足いくお部屋が見つかるまでサポートする旨
- AIXアクション: 必ず property_send（AIX【物件ピックアップした】方向）。estimate_sheet・application_push・condition_hearing は選ばない
- 【特別注意】「○○がいい感じ」等の気に入り表現 + 「環状線のみで」「家賃9万以下で」「徒歩7分以内で広め」等の新条件指定が同一メッセージにある場合 → 条件変更が主題。estimate_sheet は絶対に選ばない（property_send が正）
- 【絶対NG】この場面で申込フォーマット・見積書・ヒアリングフォーム等のフォーマット送付／申込誘導CTAを提案すること。aix・template_hint・next_steps にも申込/見積書系を選ばない（正しくは property_search / property_send 方向）
- 【絶対NG】物件提案中（proposing）にお客様が「初期費用を抑えたい」「もっと安くしたい」等のコスト懸念を出した場面で estimate_sheet を選ぶこと（提案済み物件が刺さっていないサイン。正: property_recommendation / property_search で、より初期費用の安いお部屋を再提案する）
- 【絶対NG】お客様が支払い方法を明示的に質問した／「初期費用を払えない」と言った場合を除き、分割払い・クレジット払い等の支払い方法を提案・言及すること（「初期費用を抑えたい」への回答として分割払いを提案するのは絶対禁止）

■ 募集状況確認の文脈（property_check_result / acknowledge_check フェーズ）
- 該当する場面: 顧客が物件URL・物件名・物件資料を送ってきた／「この物件は？」「空きありますか？」「まだ募集中ですか？」等で募集状況を尋ねた段階
- この段階では「空いているかどうか」がまだ管理会社に確認できていない。確認して初めて次（内覧・申込）の話になる
- 返信の型（この4ステップで完結・余分なフレーズを足さない）: ① 挨拶 → ② 物件の募集状況を確認する旨 → ③ 確認でき次第ご連絡する旨 → ④ 終わり（※この4ステップ型は管理会社への空室確認文脈専用。スタッフが物件を送付済みでお客様が受取確認しているだけの場面にはこの型を使わない。その場合は F4 パターン＝「お手隙の際にご査収ください」＋WE DO継続宣言が正解。Haiku が property_check 文脈と F4 文脈を混同して closing_strategy に「確認でき次第ご連絡」を設定しないよう注意すること）
- 【絶対NG】この段階で内覧誘導を含めること。「お気に召されましたら」「ご都合よろしいお日にちに」「ご案内させて頂きます」等の内覧誘導フレーズ・内覧日程の提案・申込誘導は返信文にも closing_strategy / next_steps / template_hint にも入れない
- 【絶対NG】未確認の空室状況・退去日・入居可能日を断言すること
- 内覧・申込の提案は募集状況（空き）が確認できた後（property_check_result で結果を報告した後）に初めて行う

■ AIがやりがちなNG（提案文にも含めない）
- 顧客が言っていない言葉（「わがまま」等）を勝手に使う
- 文脈に合わない共感フレーズを挿入する
- 物件探し文脈で申込・フォーマット関連のCTAを入れる
- 募集状況が未確認の段階で内覧誘導フレーズを付ける（「確認して連絡する」で完結させる）

【AIX必須場面のテキスト回答禁止（ハルシネーション5大禁止領域・最優先）】
以下の質問にはAIが返信文で「答え」を生成することを絶対禁止とする。橋渡し文言（受付宣言）のみで返信を完結させ、aix フィールドには対応ボタンを提案すること。AIがこれらをテキストで返そうとしている場面は必ず「ご確認させて頂きます」系の橋渡し文言に差し替える:
① 空室・募集状況（「空いてますか」「取り扱いありますか」）→ aix: property_check_result。実会話では「募集終了」「申込有り2番手」「タッチの差で埋まった」が頻発しており「空いています」の生成は即事実誤認
② 初期費用・割引額・見積金額 → aix: estimate_sheet。金額は見積書Vision OCRの実数値のみ送信可。「🌟〇〇円割引」等の割引額はスタッフの交渉結果でありAIが数字を作るとクレーム直結
③ 退去予定日・入居可能日・最短入居日 → 橋渡しのみ（「最短のご入居日につきまして管理会社に確認させていただきます」）。審査3日〜10日+契約手続きの実データ回答が正でありAIの楽観約束は引越し手配等の実害
④ 審査進捗・審査通過可能性（「通りますか」「夜職だと厳しいですか」）→ 橋渡しのみ。スタッフ自身が「通過率は過去の滞納に左右されるので分からない」と明言している。「通りそうです」の生成は重大ハルシネーション
⑤ 家賃・管理費・礼金の値下げ交渉の可否と結果 → 橋渡しのみ（「管理会社に値下げ交渉させて頂きます」）。実会話で「家賃減額・礼金減額は考えていないとのこと」と否決された実績があり「安くなります」は期待値誤誘導

■ 物件個別条件・オペレーション情報の断定禁止
- 短期違約金・契約条件（「数ヶ月でも違約金発生しない事ありますか？」）は物件の契約書次第。一般論で答えられそうに見えても断定禁止。回答する場合は「契約書次第ではありますが」の留保を必須とする
- 鍵渡し日時・事務所営業時間・書類受け渡し（「9日12時半以降に鍵受け取り大丈夫ですか」）はスタッフの実スケジュール依存。誤答すると顧客が現地で待ちぼうけになる実害あり。必ず確認の橋渡しで返す
- ガス・電気・水道の手配先や設備有無（「水道出ますか」「エアコンないですよね」）は物件資料・管理会社情報。AIの推測回答は内覧・入居後トラブルになるため禁止
- 申込順位・1番手の審査状況・繰り上がりは日単位で変動する管理会社情報。推測での順位回答は絶対禁止

■ 橋渡し返信の型（AIX押下までのつなぎ・必ずこの構成にする）
挨拶 → 受領のお礼/かしこまりました → 何を確認・作成するかの行動宣言 → 「出来次第/確認出来次第ご連絡させて頂きます」で完結
- 空室確認: 「お部屋お送りいただきありがとうございます😊！！お部屋の募集状況確認させていただきます！！確認出来次第すぐにご連絡させて頂きます😌！！」
- 見積: 「かしこまりました！！最大限割引させて頂いた初期費用の御見積書お送りさせて頂きます😊！！」
- 条件変更: 顧客の言った新条件を必ず復唱してから「〇〇のご条件に合ったお部屋を△△周辺からピックアップしてお送りさせて頂きます😊！！」（エリアの呼び方は顧客が使った表現をそのまま使う）
- 営業時間外の確認系依頼: 「本日管理会社がお休みのため、営業開始次第一番に確認（交渉）させて頂きます！！」

■ 物件指名型初回顧客の特別フロー（condition_hearing禁止）
初回接触でいきなり物件画像・SUUMO URL+見積依頼が来た顧客（「このふたつの物件取り扱いあれば初期費用の見積もり等いただきたいです」）には condition_hearing を挟まないこと。正: 挨拶+担当名乗り+「募集状況確認と最大割引見積を作成して送ります」の橋渡し → property_check_result と estimate_sheet の連結（募集状況+見積書をまとめて1回で報告。申込有り物件は「2番手以降でのお申し込みが可能です」も明示）。URL連投は1件ずつ返さず全件バッチで1回報告

■ 支払い意思つき金額質問は最優先ホットシグナル
「金額によっては即日初期費用払えます」等、支払い意思+金額質問の組み合わせは applying 直前の最ホットリード。urgency を最高にし aix: estimate_sheet をハイライト提案、返信には「お気に召されましたらお申込みでお部屋お抑えします」の申込誘導を必ず添える

■ AIXボタン担当場面マップ（該当場面ではテキスト生成せずこのボタンに委ねる）
- condition_hearing: 初回接触で物件指名（画像/URL）なし・希望条件が2項目以上欠けている漠然相談（「一人暮らしをしたくて」「部屋を探しています」等）。物件画像・SUUMO URL添付があれば property_check_result ルートへ分岐
- property_send: ①ヒアリング完了直後の初回ピックアップ（send_mode: normal・条件追記が来たら最後の条件メッセージを起点にリセット）②提案済み物件への条件変更・緩和・追加要望（widen/alternative・新条件を必ず復唱・気に入り表現と同一メッセージでも条件変更が主題なら estimate_sheet 絶対NG）③内覧終了後・申込宣言なしの当日中の追い提案（new_arrival・お礼+申込導線+新着予告。「新着があります」と物件名を出すのは禁止）
- property_recommendation: property_send直後3〜5分以内のワンセット深掘り紹介（顧客の反応を待たない唯一の連打パターン・自分の送信起点トリガー）。オススメポイント・設備・即入居可否は物件資料画像のVision OCR結果のみ使用可。AIが設備・退去予定を創作すると内覧時トラブル
- property_check_result: 他サイト物件画像・SUUMO URLでの空室/取り扱い確認依頼、同一建物の別部屋確認（「他のお部屋空いてますか」）。部屋番号・申込順位は日単位で変動するため推測回答禁止。15分以内に橋渡し→1〜3時間以内に結果報告、「あった」時は見積書同時送付
- estimate_sheet: 初期費用・見積・金額質問（金額はVision OCR実数値のみ・支払い意思つきは最優先ハイライト+申込誘導CTA）

【申込経験者ルール（最優先戦略転換）】
申込フォーマットを提出した実績がある顧客（2番手・審査落ち・キャンセル含む）は申込の心理障壁が通常顧客の1/3以下。
この顧客タイプに対する戦略転換ルール（黄金フロー例外）:
① ベンチマーク物件（申込→落選した物件）より好条件の物件を提案するとき → viewing_invite ではなく application_push を優先
  訴求文: 「前回のお申込みフォーマットをそのまま使えます！今回は1番手でお部屋を押さえられます！」
② ベンチマーク物件と同じマンションの別号室が新規募集されたとき → 最優先で提案し即申込訴求（内覧スキップ可能・建物を把握済みのため）
③ ベンチマーク物件を超えない物件・顧客持ち込み物件 → estimate_sheet（最大割引見積）+ viewing_invite で内覧接点を再構築
④ 「また別の物件を探しています」という発言は、通常顧客ではhearingのシグナルだが、申込経験者では依然proposingのホット状態として扱う
`.trim();

// 実態ベースのフェーズ別推奨テンプレートマップ
// 母集団: closed_won 13会話 / うちAIX使用5会話 / 検出された自発送信14件（顧客返信ゼロでのstaff手動送信）の実測。
// AIXボタン操作は「前半: 成果物配達（AIX自動送信）」と
// 「後半: 締めの1通（スタッフ自発送信テンプレート）」の2フェーズで1セット。後半が成約率に直結する。
// ★use_count を推奨順位に使わないこと: インクリメント経路は page.tsx:4384（TemplateModalから選択して送信）と
//   page.tsx:9323（AIX動線でモーダル経由）の2つだけで、コピペ・手打ち送信は一切カウントされない。
//   実際に成約会話で使われた3本は全て use_count=0。use_count は「モーダル利用率」であって成約寄与ではない。
// ★成約寄与の指標は won_count: analyze-applying が closed_won 会話の自発送信（手打ち含む）と
//   テンプレ本文を突き合わせて自動集計する成約実績。テンプレート推奨で優先するのはこちら。
const PHASE_TEMPLATE_HINTS = `
【AIXボタン後に送るべきテンプレート（next_steps での追撃テンプレの選び方。template_hint にはここの個別テンプレ名ではなく回答形式で指定するラベルカテゴリ名を入れること）】
※運用は2フェーズ1セット: AIXボタン＝成果物配達 → 中央値1分20秒後にテンプレ追撃（顧客返信を待たない・14件中10件が2分以内）。AIXを使用した5会話すべてこの構造（closed_won 13件中3件はAIX未使用で成約＝AIXは成約の必要条件ではない）。
※これは「顧客の無反応を見て追撃した」のではなく、AIXボタン押下と同一オペレーションの一部として締めの1通を手で足す動作。
※追撃には2種類ある: 「AI最適化して送る」（物件事実を含むテンプレ）と「そのまま送る」（定型追撃・編集すると1分以内の追撃速度が落ちる）。必ず区別すること。
※同フェーズで候補が複数ある場合は won_count（成約会話で実際に使われた回数・analyze-applying が自動集計する成約実績）が高いテンプレートを最優先する。
- property_send（複数件ピックアップ後）→ 「物件ピックアップ紹介（後続）」。実測38秒／58秒で顧客返信なしに自発送信。AI最適化必須: 顧客名＋条件スロットに主訴（初期費用を抑えたい・審査が不安 等）を意味置換して差し込む
- property_send（駅指定・希望条件から外れる旨の告知あり）→ 「駅周辺物件ピックアップ（後続）」。実測1分33秒。AI最適化必須: 駅名置換＋「〜のみの募集となります」の断定化リライト
- property_send（ピックアップ全件が即入居可能）→ 「【全件案内可能】」相当文。「審査通過次第ご入居可能」の一括保証でAIXが残した唯一の不安（いつ入れるか）を潰す。実測8分56秒→顧客が2分45秒で物件確定した最強事例あり（原文一致なしの手打ちのため骨格のみ流用）
- property_recommendation（1件詳細）→ 「1件特にオススメ」。実測1分22秒。※原文そのままの送信実績はゼロ。1件に絞って感情的に推す"思想"だけを流用し全面リライトすること
- estimate_sheet（見積書送付直後・同分〜1分以内が必須）→ 「【申込誘導】」。実測33秒／1分06秒。AI最適化必須: 物件名・号室を文中に溶かす（「〇〇901号室の最大限割引させていただいたお見積書をお送りさせて頂きました」）。顧客の申込まで最短2分の実証あり
- application_push で①申込時フォーマット本体を送った直後 → 「②申込時フォーマット（続き）」。実測32秒〜4分48秒。★一字一句そのまま送る（AI最適化禁止）。トリガーは顧客の申込意思表示ではなく「①を送ったこと」そのもの（意思表示は数時間前にあることが多い）。2会話2/2で申込情報の全項目を回収した唯一の再現性100%テンプレ
- property_check_result（2番手での申込が可能と判明）→ 「（2番手・申込）」。実測1分29秒・顧客名の置換のみ。AIXが別物件の見積を送っていても社内進捗（2番手確保済み）を差し込むと顧客の関心が戻り内覧アポに転換する
- 条件ヒアリングAIX後 → 「ヒアリング締め」／「物件探しテンプレート【続き】」。実測1分17秒でそのまま送る（顧客名と関係性の文脈だけ補正）
- viewing_invite / meeting_place（内見確定文）→ 追撃テンプレなし（顧客返信を待つ）。自発送信14件中0件。AIX本文は日時・物件・住所の1対1置換のみ
- 条件に合う物件が現状ゼロ → 「【物件なし】条件変更のご提案」
- 同棲・カップル向けの新着1件 → 「【同棲・カップル向け広め】新着オススメ」
- 該当テンプレが存在しない3型（①申込完了の進捗報告 ②見積送付の報告 ③即入居可の一括保証）は全面手打ちでよい。自発送信14件中5件がこれ。無理に既存テンプレへ寄せないこと

【AI最適化の2分類（物件事実系=「AI最適化して送る」／定型追撃系=「そのまま送る」）】
- AI最適化して送る（物件事実系: 物件名・条件・駅名を差し込む系）: 「物件ピックアップ紹介（後続）」「駅周辺物件ピックアップ（後続）」「1件特にオススメ」「【申込誘導】」「【全件案内可能】」
  → 原文に「〇〇さん」「アカウント名さん」「〇〇駅」等のプレースホルダーが残っており、そのまま送ると顧客に生で飛ぶ事故になる
- そのまま送る（定型追撃系: 申込フォーマット続き系・AI最適化禁止）: 「②申込時フォーマット（続き）」「ヒアリング締め」「（2番手・申込）」
  → 特に「②申込時フォーマット（続き）」はAI最適化を通すと本文が壊れる。generate-reply のテンプレート最適化プロンプトに
    「『お申込フォーマット』『ご本人確認書類』を含む文は出力禁止」という強制置換ゲートがあり、
    このテンプレの中核（本人確認書類の写真依頼）が削除される。文体の好みではなくコード上必須の回避策。

【template_hint に選んではいけないテンプレート】
- 本文に顧客実名・物件名が焼き込まれている10件（他顧客への誤送信事故になるためDBクリーンアップ完了まで禁止）:
  「【新着】」（🐈‍⬛さん）/ YUMAさん / mai.tさん / Mさん / 𝚂𝚊𝚗𝚊.さん / ニアさん / 夏奈さん（レジュールアッシュ梅田AXIA）/ サムティ町合能越寺803号室 / コーポまえだ303号室 / アドバンス難波ラシュレ を含むもの
- 文体が別人格のもの（✅🙏を多用する箇条書き調）
※ テンプレート選択の最優先指標は won_count（成約会話で実際に使われた回数。analyze-applying が closed_won 会話の自発送信とテンプレ本文を突き合わせて自動集計）。won_count が高いものを最優先する。
※ use_count が 0 であることは除外理由にならない。use_count はモーダル利用率であって成約寄与ではない。成約会話で実際に使われた「物件ピックアップ紹介（後続）」「駅周辺物件ピックアップ（後続）」「（2番手・申込）」はいずれも use_count 0（モーダルを通さず手打ちで送られたため計上されていないだけ）。逆に use_count 96 の「1件特にオススメ」は成約会話の自発送信で一度も原文送信されていない。
`.trim();

// template_hint 許可リスト（AIXタブのラベルカテゴリ名・ハードコード）
// Haiku 出力のバリデーションゲートで使用: 出力がこのいずれかの文字列を「含む」場合のみ template_hint として採用する。
// 実測サンプル30件中29件が「プッシュ強め・親身」等の抽象トーン説明で、テンプレピッカーの選択に使えなかったための対策。
// 「①申込」は「①申込み時フォーマット（連帯保証人）」「①申込時フォーマット（緊急連絡先）」「①緊急連絡先・同居人なし」等の
// ①申込系ラベルを含む判定でまとめて許可するための部分文字列（「①申込時」「①申込み時」の表記ゆれ両対応のため「①申込」で切る）。
// export: calc-template-scene-stats cron が hint ラベル別一致率集計（HINT-1）で同じ許可リストを使う
export const TEMPLATE_HINT_ALLOWED_LABELS = [
  "物件ピックアップした",
  "1件特にオススメする",
  "物件確認した（募集状況）",
  "①申込",
  "②申込",
  "①緊急連絡先",
  "内覧日アポ",
  "直近の日にち",
  "申込誘導",
];

// ① 成約・申込到達ステータス（brainが成功事例として読む対象）
// applying は line-webhook が申込フォーム検知で自動セットする機械検証済みシグナル。
// application/screening/contract は旧データの後方互換エイリアス（auto-seiyaku と同一集合 + closed_won）
const SUCCESS_EXAMPLE_STATUSES = ["closed_won", "applying", "application", "screening", "contract"];

// ── 自発送信の決定論的検出 ───────────────────────────────────────────────────
// 「自発送信」= AIXボタン押下後、顧客の返信を待たずにスタッフが手で足した締めの1通。
// 検出定義（成約会話14件の実測に使ったものと同一）:
//   顧客メッセージで区切った staff 連続ブロック内で、
//   is_aix_generated=true の最終メッセージより後にある is_aix_generated=false の staff メッセージ。
// これまで analyze-applying は [AIX]/[スタッフ] ラベルをLLMに渡して推測させていたが、
// is_aix_generated から機械的に確定できるためLLMに確定リストとして渡す（推測をやめさせる）。
export type SelfInitiatedSend = {
  text: string;
  created_at: string | null;
  /** 同一staffブロック内の直前AIXメッセージからの経過秒（実測の中央値は約80秒・14件中10件が120秒以内） */
  seconds_after_aix: number | null;
  /** その直前AIXメッセージの本文（先頭120字。どのAIXボタンへの追撃かを判定する材料） */
  aix_source_text: string;
};

export function extractSelfInitiatedSends(
  msgs: Array<{ sender: string; text: string | null; created_at: string | null; is_aix_generated?: boolean | null }>
): SelfInitiatedSend[] {
  const result: SelfInitiatedSend[] = [];

  // [start, end) は顧客メッセージで挟まれた staff 連続ブロック
  const scanBlock = (start: number, end: number) => {
    let lastAixIdx = -1;
    for (let i = start; i < end; i++) {
      if (msgs[i].is_aix_generated === true) lastAixIdx = i;
    }
    if (lastAixIdx === -1) return; // AIXを含まないブロックは自発送信の定義対象外
    const aix = msgs[lastAixIdx];
    for (let i = lastAixIdx + 1; i < end; i++) {
      const m = msgs[i];
      if (m.is_aix_generated === true) continue;
      if (!(m.text ?? "").trim()) continue;
      const gapSec =
        m.created_at && aix.created_at
          ? Math.round((new Date(m.created_at).getTime() - new Date(aix.created_at).getTime()) / 1000)
          : null;
      result.push({
        text: m.text ?? "",
        created_at: m.created_at,
        seconds_after_aix: gapSec,
        aix_source_text: (aix.text ?? "").slice(0, 120),
      });
    }
  };

  let blockStart = 0;
  for (let i = 0; i <= msgs.length; i++) {
    if (i === msgs.length || msgs[i].sender === "customer") {
      if (i > blockStart) scanBlock(blockStart, i);
      blockStart = i + 1;
    }
  }
  return result;
}

// ── フェーズ検出ヘルパー ─────────────────────────────────────────────────────
// brain分析結果（SuggestedAixMeta）の各フィールドから現在フェーズを推定する。
// conversation_direction の current_phase 更新判定に使用する。
function detectPhaseFromBrainMeta(
  meta: Record<string, unknown>,
  // P7: conversations.status は webhook が機械検証（申込書受領等）で立てる最も信頼できるソース。
  // テキストパターン推定より最優先で参照する
  convStatus?: string | null,
  // 申込経験者フラグ: 申込フォーマット提出実績あり（sent_properties.applicant_rank が存在）
  // または申込以降ステータス（applying/screening/closed_lost）を経験した顧客。
  // 2番手落ち・審査落ち・キャンセルも含む。申込の心理障壁が通常顧客の1/3以下の最ホット層。
  hasApplicationHistory = false,
): "hearing" | "proposing" | "viewing" | "applying" {
  if (convStatus === "applying") return "applying";
  const txt = [meta.action, meta.closing_strategy, meta.next_steps].filter(Boolean).join(" ");
  // 優先1: 審査落ち・再スタート文脈 → hearing（「また探したい」「別の物件」等が共存）
  // フェーズ降格バグ修正: 申込経験者（2番手落ち・審査落ち・キャンセル後に別物件を探す顧客）は
  // 最ホット層であり、「また別の物件を探したい」は hearing シグナルではなく proposing 継続。
  // hearing に降格すると最コールド扱いになり黄金フローが初回ヒアリングからやり直しになるバグがあった。
  if (/再探し|また探|別の物件|審査落/.test(txt)) return hasApplicationHistory ? "proposing" : "hearing";
  // 優先2: 純粋な申込・審査待ち（「再」「また」「別」が共存しない場合のみ）
  // P7修正: 旧 /申込|審査/ は「審査不安」「審査が不安」「審査が心配」等の不安フレーズだけで
  // applying 誤爆していた。/申込/ は単独で有効、/審査/ は不安・心配文脈が共存しない場合のみ有効。
  const isShinsaAnxiety = /審査.{0,10}(不安|心配)/.test(txt);
  const hasApplyingSignal = /申込/.test(txt) || (/審査/.test(txt) && !isShinsaAnxiety);
  if (hasApplyingSignal && !/再|また|別/.test(txt)) return "applying";
  // 優先3: 内覧・内見
  // 診断修正: 「内覧可能」「内覧可」はスタッフ送付の物件情報由来の文言（例:「9月1日以降ご内覧可能」）が
  // LLM出力（closing_strategy等）に反映されたケースであり、顧客の内覧希望ではない → viewing に遷移させない
  if (/内覧(?!可)|内見(?!可)/.test(txt)) return "viewing";
  // 優先4: 物件提案中
  if (/提案|物件/.test(txt)) return "proposing";
  return "hearing";
}

// ── 退去予定/入居中物件の検出（旧 deriveSuggestedAix redirectMoveOut 相当） ────────────
// 退去予定・入居中の物件は現地内覧が不可能なため、viewing_invite（内覧誘導）を提案せず
// application_push（申込で部屋を先押さえ）へ差し替える。
// DBに物件募集状況カラムが無いため、会話メッセージ（スタッフ送付の物件情報を含む）からの
// テキスト検出で判定する。正規表現は app/api/generate-reply/route.ts の MOVE_OUT_PATTERN と
// 完全同一に保つこと（変更時は両方を同時更新）。
// ⚠️ 「退去後」は除外: AIが「退去後すぐにご案内します」と返信すると履歴に残り
//    次回の検出が誤発火するフィードバックループの原因となるため、単独パターンから除外。
// ⚠️ 「入居者」「居住中」は省略: 顧客が現居住状況を話す文脈でも一致してしまうため。
const MOVE_OUT_PATTERN = /退去予定|入居中|[0-9０-９]{1,2}\s*月末?\s*退去|退去[はが]?[0-9０-９]{1,2}\s*月/;

// ── P5: 成約データ（applying_pattern 26件・全件importance=9）由来の信号ベースAIX決定 ────────
// suggested_aix_button の 1-b 分岐（非viewingフェーズ）で brainAix（Haiku提案）が null だった場合の
// フォールバック。旧実装はフェーズ決定論のみで、成約に最も効いた estimate_sheet /
// acknowledge_check / followup_revive / property_search が 1-b 分岐から構造的に絶対出なかった。
// AIX_CAPABILITY_MAP / PHASE_TEMPLATE_HINTS に「条件」としてプロンプト記載済みだが
// コード未実装だった判定をここで決定論的に実装する。
// 優先順は applying_pattern の成約実績順（estimate_sheet ライン最優先）。
// 失敗時は null を返し、既存のフェーズ別デフォルトに落ちる（既存ロジックを壊さない）。
async function detectSignalBasedAixFallback(
  conversationId: string,
  propertyCustomerId: string | null,
  newPhase: "hearing" | "proposing" | "viewing" | "applying",
): Promise<string | null> {
  try {
    const [msgsRes, aixRes, scheduledRes, tasksRes, pcRes, rulesRes] = await Promise.all([
      supabase
        .from("messages")
        .select("sender, text, created_at, is_aix_generated, image_type")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(10),
      supabase
        .from("aix_usage_logs")
        .select("aix_type, created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("scheduled_messages")
        .select("id")
        .eq("conversation_id", conversationId)
        .eq("status", "pending")
        .limit(1),
      supabase
        .from("line_tasks")
        .select("task_type")
        .eq("conversation_id", conversationId)
        .eq("status", "pending")
        .limit(5),
      propertyCustomerId
        ? supabase
            .from("property_customers")
            .select("last_property_sent_at, property_send_count")
            .eq("id", propertyCustomerId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      // 信号5.5/8用（brain一本化）: trigger_action_rules のDB学習ルールを並列取得。
      // suggest-next-action API への HTTP fetch ではなく supabase 直読み
      // （このファイルは webhook after() / brain-sweep cron から呼ばれるため往復ホップを増やさない）。
      // 用途分離: 通常キーワードルールのみ（category は DBトリガーが keyword から自動分類）。
      // 旧 NOT LIKE 6連チェーンは BOUNDARY% / TEMPLATE_HINT_ACCEPT_RATE:% の除外漏れがあり、
      // category 1条件に置換して構造的に解消（suggest-next-action と同パターン）。
      supabase
        .from("trigger_action_rules")
        .select("action_type, keyword, confidence, occurrence_count")
        .eq("category", "keyword_rule")
        .gte("confidence", 0.65)
        .gte("occurrence_count", 1)
        .or(`conversation_status.is.null,conversation_status.eq.${newPhase}`)
        .order("confidence", { ascending: false })
        .order("occurrence_count", { ascending: false })
        .order("keyword", { ascending: true })
        .limit(200),
    ]);

    type MsgRow = { sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; image_type: string | null };
    const msgs = (msgsRes.data ?? []) as MsgRow[];
    const lastCustomer = msgs.find((m) => m.sender === "customer") ?? null;
    const lastStaff = msgs.find((m) => m.sender !== "customer") ?? null;
    const custText = lastCustomer?.text ?? "";
    const usedAixTypes = ((aixRes.data ?? []) as { aix_type: string | null }[])
      .map((l) => l.aix_type)
      .filter((t): t is string => Boolean(t));
    const hasPendingScheduled = (scheduledRes.data?.length ?? 0) > 0;
    const pendingTaskTypes = ((tasksRes.data ?? []) as { task_type: string }[]).map((t) => t.task_type);
    const pc = pcRes.data as { last_property_sent_at: string | null; property_send_count: number | null } | null;
    // DB学習ルール（信号5.5/8で使用）: 旧名 alternative_send は property_send に正規化し、
    // AIX_BRAIN_NOTES に存在するアクション（=suggested_aix_button として描画可能なボタン）のみ採用する
    type RuleRow = { action_type: string; keyword: string; confidence: number | null; occurrence_count: number | null };
    const dbRules = ((rulesRes.data ?? []) as RuleRow[])
      .map((r) => ({ ...r, action_type: r.action_type === "alternative_send" ? "property_send" : r.action_type }))
      .filter((r) =>
        typeof r.keyword === "string" && r.keyword.length >= 2 &&
        typeof r.action_type === "string" && Boolean(AIX_BRAIN_NOTES[r.action_type]));

    // 信号0.97（同棟別号室依頼 — brain一本化: deriveSuggestedAix Step 0.5 を移植）:
    // proposing フェーズで「こちらの6万台のお部屋はないですか？」「もっと安い部屋ありませんか」等、
    // 送付済み物件の同一マンション内・別号室/別価格帯の依頼 → property_recommendation。
    // 【確認します】（acknowledge_check・信号4）ではなく物件ピックアップ系が正解の局面のため、
    // 信号4より前（最優先）で評価する。
    if (newPhase === "proposing") {
      const conditionChangeReq =
        /([0-9０-９]+\s*万(円)?台|万円?台|(もっと|もう少し)安|安め|安い(お?部屋|物件)|家賃.{0,8}(抑え|低め|下げ)|(別|他|違う)の?(お?部屋|物件)|同じ(マンション|建物|物件))/;
      const requestForm =
        /(ない(です|でしょう)?か|あります|ありませんか|あれば|欲しい|希望|探して|お願い)/;
      if (conditionChangeReq.test(custText) && requestForm.test(custText)) {
        return "property_recommendation";
      }
    }

    // 信号0.9（コスト懸念 — 信号1より先に評価）: 「初期費用を抑えたい」「もっと安くしたい」等は
    // 金額の質問ではなく“提案済み物件が刺さっていない”サイン → estimate_sheet ではなく
    // より初期費用の安い物件の再提案（property_recommendation）が正解。
    // 信号1の /見積|初期費用/ 部分一致がコスト懸念表明まで estimate_sheet に吸い込む誤爆を防ぐ。
    // ※ brain一本化: deriveSuggestedAix Step 0.55 と同一regexに統一（「費用をかけられない/かけたくない」も検知）
    const costConcern =
      (/(初期費用|費用|家賃)[^。！!？?\n]{0,8}(抑え|安く|下げ|かけ(られ|たく)な)|(抑え|安く)[^。！!？?\n]{0,6}(たい|入居)/.test(custText)) &&
      !/(いくら|内訳|どの(くらい|位)|教え)/.test(custText);
    if (costConcern) return "property_recommendation";

    // 信号2: 最終顧客メッセージに申込・入居の意思表示 AND フェーズが proposing/applying → application_push
    // （元の信号1→2→3 の順から、信号3を信号1より先に評価する並びに変更。信号2の優先度は従来通り信号3より上位）
    // ※「申込書類は？」「入居条件を教えて」等の情報収集系質問では誤発火しないよう、
    //   意思表示形（〜したい・します・希望・を決め・の意思・を考え）のみ検出する。
    if (/申込(したい|します|しま|の意思|を決|を考え)|入居(したい|します|希望|を決め)/.test(custText) && (newPhase === "proposing" || newPhase === "applying")) {
      return "application_push";
    }

    // 信号3（見積送付済み — 信号1より先に評価）: 最終スタッフメッセージが見積書送付
    // （estimate_sheet 完了直後・顧客未返信）→ acknowledge_check
    // 直近AIXが estimate_sheet で、最終メッセージがスタッフ側（AIX生成）＝見積送付済みで顧客返信待ちの局面。
    // ※信号1より後に置くと、送付済みでも custText の「見積」部分一致で estimate_sheet を二重提案してしまう。
    if (
      lastStaff?.is_aix_generated &&
      usedAixTypes[0] === "estimate_sheet" &&
      (!lastCustomer || lastStaff.created_at > lastCustomer.created_at)
    ) {
      return "acknowledge_check";
    }

    // 信号0.96（見積・初期費用の明示質問 — brain一本化: deriveSuggestedAix Step 0.6 を移植）:
    // 「初期費用いくらですか」「お見積りいただけますか」等の明示的な依頼 → estimate_sheet。
    // 信号1（/見積|初期費用/ の部分一致）より精密な判定を先に効かせる。
    // 誤爆ガード①: 内覧希望が主目的のメッセージは信号0.95（viewing_invite）に任せる。
    // 誤爆ガード②: 「もっと安い物件ないですか」等の別物件依頼はピックアップ系（信号0.97/0.9）に任せる。
    // ※ コスト懸念（信号0.9）・見積送付済み（信号3）を先に除外する並び順を変えないこと。
    {
      const estimateKeyword =
        /(初期費用|見積|スモ割|総額|予算|全部で.{0,6}いくら|費用.{0,6}(内訳|詳細)|いくら.{0,8}(かかる|かかり|です|でしょう))/;
      const estimateRequestForm =
        /(いくら|どの(くらい|位)|内訳|教え|知りたい|いただけ|頂け|ください|下さい|ですか|でしょうか|お願い|？|\?)/;
      const viewingReq = /(内覧|内見|見学).{0,4}(したい|希望|でき|いつ|日程|調整)/;
      const otherPropertyReq =
        /(安|抑え)[^。！!？?\n]{0,10}(物件|お?部屋)|(物件|お?部屋)[^。！!？?\n]{0,8}(ない(です|でしょう)?か|あります|ありません)/;
      if (
        estimateKeyword.test(custText) &&
        estimateRequestForm.test(custText) &&
        !viewingReq.test(custText) &&
        !otherPropertyReq.test(custText)
      ) {
        return "estimate_sheet";
      }
    }

    // 信号0.95（内覧希望 — 信号1より先に評価。内覧希望は見積話題より局面が進んでいるため優先）:
    // 最終スタッフ返信以降の顧客メッセージ（未返信バースト）に内覧・内見・見学の希望表現 → viewing_invite
    // 「内覧行きたいらしいですが可能ですか？」等の間接・伝聞表現も対象。
    // ※「内覧可」「内覧済」「9月1日以降ご内覧可能です」等の物件情報文言は、
    //   希望表現サフィックス（したい/行きたい/希望/〜ですか等）を必須にすることでマッチしない。
    // ※スタッフメッセージは対象外（customer 送信のみを結合して判定）。
    // ※URL併記かつ空室確認未起票の場合は「確認前に内覧の話へ進めない」ルールに従い
    //   ここでは返さず信号4（acknowledge_check）へ流す。
    const recentCustText =
      msgs
        .filter((m) => m.sender === "customer" && (!lastStaff || m.created_at > lastStaff.created_at))
        .map((m) => m.text ?? "")
        .join("\n") || custText;
    // ※否定形（「したくない」「行きたくない」「希望はありません」等）は negative lookahead で除外。
    const viewingWish =
      /(内覧|内見|見学)[^。！!？?\n]{0,12}(したい|したく(?!ない|ありません)|行きたい|いきたい|行きたく(?!ない|ありません)|希望(?!(は|も)?(ない|ありません|しない|しません))|お願いし)/.test(recentCustText) ||
      /(内覧|内見|見学)[^。！!？?\n]{0,12}(可能|でき|出来)[^。！!？?\n]{0,6}(ですか|ますか|でしょうか)/.test(recentCustText) ||
      /見に(行|い)きたい/.test(recentCustText);
    if (
      viewingWish &&
      !(/https?:\/\//.test(recentCustText) && !pendingTaskTypes.includes("property_check"))
    ) {
      // 退去予定/入居中物件では現地内覧不可 → 申込誘導へ差し替え（旧 redirectMoveOut 相当）。
      // 「退去予定」情報は通常スタッフが物件情報として送るため、顧客だけでなく
      // スタッフ送信を含む直近10件（msgs）全体で検出する。
      const moveOutDetected = MOVE_OUT_PATTERN.test(msgs.map((m) => m.text ?? "").join("\n"));
      return moveOutDetected ? "application_push" : "viewing_invite";
    }

    // 信号1（成約実績最多ライン）: 最終顧客メッセージに見積・初期費用の話題 → estimate_sheet
    // applying_pattern の most_effective 最多。見積書→申込誘導→申込の3ステップが成約最短ルート。
    // （コスト懸念＝信号0.9・見積送付済み＝信号3 は上で先に除外済み）
    if (/見積|初期費用/.test(custText)) return "estimate_sheet";

    // 信号TikTok（弊社SNS動画流入 → property_search）:
    // 弊社TikTok/Instagramの動画で物件に興味を持って問い合わせてきた顧客。
    // 内覧希望がある場合は信号0.95で viewing_invite に拾われているため、ここは物件検索フェーズを想定。
    // ※見積・初期費用の話は信号1（estimate_sheet）が先に拾う。
    // ※viewing/applyingフェーズでは物件検索は不要なため除外。
    if (
      /TikTok|tiktok|ティックトック|ティクトック/.test(custText) &&
      newPhase !== "viewing" && newPhase !== "applying"
    ) {
      return "property_search";
    }

    // 信号3.5（画像のみ送信対策）: 顧客がテキストなしで画像だけを送ってきた → estimate_sheet
    // messages 上は "[画像]" プレースホルダーで保存される。実運用では見積書スクショ送付が最多のため
    // estimate_sheet を返す。※必ず信号4（URL判定→acknowledge_check）より先に評価すること。
    // 監査FIX(2026-08-20): messages.image_type（Vision分類・未分類はnull）がある場合は事実ベースで分岐。
    // 物件系画像（物件写真/間取り図）→ 空室確認が正解。null/estimate/other は従来通り estimate_sheet。
    if (/^\[画像\]/.test(custText)) {
      const it = lastCustomer?.image_type;
      if (it === "property_photo" || it === "floor_plan") {
        return "acknowledge_check";
      }
      return "estimate_sheet";
    }

    // 信号4（AIX_CAPABILITY_MAP記載・コード未実装だった条件）:
    // 顧客が物件URL・「空きありますか」等を送ってきて空室確認タスクが未起票 → acknowledge_check
    // （確認前に内覧・申込の話へ進めないルール。property_check タスクが既にあれば回答待ちなので出さない）
    if (
      /https?:\/\/|空きあり|空いてます|まだ募集|募集中ですか|この物件/.test(custText) &&
      !pendingTaskTypes.includes("property_check")
    ) {
      return "acknowledge_check";
    }

    // 信号5（PHASE_TEMPLATE_HINTS/AIX_CAPABILITY_MAP記載・コード未実装だった条件）:
    // 未完了タスクに物件確認（空室確認）があり、その後に管理会社回答系のスタッフ動線に入る局面 → property_check_result
    if (pendingTaskTypes.includes("property_check") && usedAixTypes[0] === "acknowledge_check") {
      return "property_check_result";
    }

    // 信号5.5（竹内さん回答由来ルール — brain一本化: suggest-next-action の human_rule 相当を直読み移植）:
    // ai-feedback/route.ts が「この場合はこのAIXを使う」という竹内さんの回答を
    // confidence 0.95 / occurrence_count 10 の trigger_action_rules として保存する。
    // 人間が明示的に教えたルールは時間ヒューリスティック（信号6/7）より優先して発火させる。
    if (custText) {
      const humanHit = dbRules.find(
        (r) =>
          (r.confidence ?? 0) >= 0.95 && (r.confidence ?? 0) <= 1 &&
          (r.occurrence_count ?? 0) >= 10 &&
          custText.includes(r.keyword),
      );
      if (humanHit) return humanHit.action_type;
    }

    // 信号6: 最終顧客メッセージから3日以上沈黙 AND 物件提案済み AND 予約送信なし → followup_revive
    // （AIX_CAPABILITY_MAP「最終顧客メッセージが3日以上前で予約送信済みメッセージが無い時」の実装）
    const propertyProposed =
      usedAixTypes.some((t) => t === "property_send" || t === "property_recommendation") ||
      newPhase === "proposing" ||
      newPhase === "applying";
    if (lastCustomer && !hasPendingScheduled && propertyProposed) {
      const silentDays = Math.floor((Date.now() - new Date(lastCustomer.created_at).getTime()) / 86_400_000);
      if (silentDays >= 3) return "followup_revive";
    }

    // 信号6.5（Case1対策・信号7より優先）:
    // 最終顧客メッセージが物件条件の問い合わせ（「〜はありますか」「広め」「間取り」「ダブルベッド」「〇LDK」等）
    // → property_send。「まず物件を探す旨をお客さんに伝える → 検索 → ピックアップ送付」が正しい動線であり、
    // property_search（顧客への一次返信アクションを持たないスタッフ内向き指示）を出してはいけない局面。
    if (
      (newPhase === "hearing" || newPhase === "proposing") &&
      lastCustomer &&
      PROPERTY_CONDITION_INQUIRY_RE.test(custText)
    ) {
      return "property_send";
    }

    // 信号7（AIX_CAPABILITY_MAP「物件検索推奨度★★★」条件のコード実装）:
    // 最終物件送付から7日以上経過 or 送付0件 → property_search（hearing/proposing のみ）
    if ((newPhase === "hearing" || newPhase === "proposing") && pc !== null && propertyCustomerId) {
      const lastSentIso = pc?.last_property_sent_at ?? null;
      const daysSinceLastSend = lastSentIso
        ? Math.floor((Date.now() - new Date(lastSentIso).getTime()) / 86_400_000)
        : null;
      const unansweredSendCount = pc?.property_send_count ?? 0;
      // 連続未返信送付2件以上は「顧客が反応していない」局面なので検索提案しない（★─ 条件）
      if (unansweredSendCount < 2 && (daysSinceLastSend === null || daysSinceLastSend >= 7)) {
        return "property_search";
      }
    }

    // 信号8（学習キーワードルール — brain一本化: suggest-next-action の trigger_rule 相当を直読み移植）:
    // 上のハードコード信号がどれもマッチしなかった場合の最終フォールバック。
    // 最終顧客メッセージに含まれるキーワードごとに confidence（0-1クランプ・汚染値防御）を
    // アクション別に合算し、合計 0.85 以上の最上位アクションを採用する（suggest-next-action と同閾値）。
    // マッチなしなら従来通り null → フェーズ別デフォルトに落ちる（既存ロジックを壊さない）。
    if (custText) {
      const scores: Record<string, number> = {};
      for (const r of dbRules) {
        if (!custText.includes(r.keyword)) continue;
        scores[r.action_type] = (scores[r.action_type] ?? 0) + Math.min(r.confidence ?? 0, 1);
      }
      const top = Object.entries(scores)
        .filter(([, score]) => score >= 0.85)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      if (top) return top[0];
    }

    return null;
  } catch (e) {
    console.warn("[brain-core] detectSignalBasedAixFallback failed (fallback to phase default):",
      conversationId, e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Calls Claude Haiku with enriched context (last 15 messages, customer conditions,
 * conversation status) and returns a SuggestedAixMeta to cache in conversations.
 *
 * `source` はこの分析の呼び出し経路（"brain" = イベント駆動/sweep）。
 * 品質ゲートは自分自身の経路の採択率（SOURCE_ACCEPT_RATE:{action}:{source}）を読む。
 * （旧実装は analysis_step1 という他コンポーネントのキーを読んでいたバグがあった）
 */
export async function analyzeConversation(
  conversationId: string,
  isUrgent: boolean,
  convStatus: string | null,
  propertyCustomerId: string | null,
  source: string = "brain",
  // B2/H6(Fable5): 呼び出し元（analyzeAndSaveBrainMeta）が conversations から取得したフラグ。
  // auto_send_enabled=false の会話に auto_reply を提案しない・is_flagged はスタッフ要対応なので aix 強制
  // RAG化 Phase1: prevPhase / prevAix は前回brain分析のキャッシュ値（conversation_direction）。
  // フェーズ・AIX候補は Sonnet 実行後にしか確定しないため、ルール事前フィルタには前回値を事前シグナルとして使う
  // インクリメンタル分析 Phase1: mode=full/incremental の切替・prevMeta=前回フル分析結果（差分更新の起点）・
  // totalMsgCount=呼び出し元で取得済みの総メッセージ数（30件強制リフレッシュ判定用）
  opts?: { autoSendEnabled?: boolean; isHot?: boolean; isFlagged?: boolean; prevPhase?: string | null; prevAix?: string | null; customerName?: string; mode?: "full" | "incremental"; prevMeta?: SuggestedAixMeta; totalMsgCount?: number },
): Promise<SuggestedAixMeta> {
  // RAG化 Phase1: 前回フェーズ（無ければ convStatus からの粗い推定）でアクション候補を絞る。
  // フェーズ不明・未知フェーズ時は全AIXアクションにフォールバック（フィルタ無効化 = 取りこぼしゼロ側）
  const phaseEstimate = opts?.prevPhase ?? (convStatus ? STATUS_TO_PHASE[convStatus] ?? null : null);
  const actionCandidates = [...new Set([
    ...(phaseEstimate ? PHASE_ACTION_CANDIDATES[phaseEstimate] ?? Object.keys(AIX_BRAIN_NOTES) : Object.keys(AIX_BRAIN_NOTES)),
    ...(opts?.prevAix && AIX_BRAIN_NOTES[opts.prevAix] ? [opts.prevAix] : []),
  ])];
  const isIncremental = opts?.mode === "incremental" && !!opts?.prevMeta;
  // Fetch last 30 messages and customer conditions in parallel
  // limit 30→15: checkpoint（RAG検索含む）が古い会話をカバーするため、直近15件で十分。
  // CPが機能する前は30件必要だったが、CP+RAG実装後は前半15件はCPと重複するだけ → トークン削減。
  // count: "exact" は総メッセージ数のプロンプト注入用（B3）
  const [msgResult, pcResult, examplesResult, checkpointsResult, sentPropsResult, promptRulesResult, knowledgePrinciplesResult, templatesResult, boundaryPromptRulesResult, boundaryTriggerRulesResult, contractKnowledgeResult, contractExamplesResult, aixLogsResult, scheduledMsgsResult, openTasksResult, viewingsResult, viewingHistoryResult, applyingPatternsResult, winningPatternsResult, actionRulesResult, transitionStatsResult] = await Promise.all([
    supabase
      .from("messages")
      // 監査FIX(2026-08-20): quoted_message_id（物件カード引用リプライの判別）と
      // image_type（Vision分類・「全画像=見積書」盲目仮定の解消）を追加取得
      .select("sender, text, created_at, line_message_id, is_aix_generated, quoted_message_id, image_type", { count: "exact" })
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(isIncremental ? 15 : 15),
    propertyCustomerId
      ? supabase
          .from("property_customers")
          .select("desired_area, floor_plan, rent_min, rent_max, move_in_time, preferences, ng_points, walk_minutes, last_property_sent_at, property_send_count, ai_summary, ai_summary_json, personality_profile, pet, floor_area_min, floor_area_max, commute_station, commute_minutes, area_mode, initial_cost_limit, building_age, other_requests")
          .eq("id", propertyCustomerId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // Recent starred reply examples for this conversation (context for Haiku)
    // インクリメンタル時もフェッチ（安定知識としてプロンプトキャッシュで再利用）
    supabase
      .from("ai_reply_examples")
      .select("sent_reply, is_starred")
      .eq("conversation_id", conversationId)
      .eq("is_starred", true)
      .order("created_at", { ascending: false })
      .limit(3),
    // 最新CPのみ1件取得（RAG検索で古いCPを必要に応じて補完する）
    supabase
      .from("conversation_checkpoints")
      .select("checkpoint_index, summary, key_facts, conversation_stage, message_count_at_creation")
      .eq("conversation_id", conversationId)
      .order("checkpoint_index", { ascending: false })
      .limit(1),
    // Sent properties for this customer (duplicate/history awareness)
    propertyCustomerId
      ? supabase
          .from("sent_properties")
          // 監査FIX(2026-08-20): 募集状況・番手・家賃・顧客反応を追加取得
          // （current_property / urgency_appropriate をテキスト推測ではなくDB事実で接地させる）
          .select("property_name, room_no, sent_at, rent, recruitment_status, applicant_rank, customer_reaction")
          .eq("property_customer_id", propertyCustomerId)
          .order("sent_at", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: null }),
    // Global permanent operator rules (apply to all conversations, no pgvector needed)
    // B4(Fable5): limit 10→20 — 本番で恒久ルールがちょうど10行に達しており、11個目から無言欠落する状態だった
    supabase
      .from("ai_prompt_rules")
      .select("rule_text, priority")
      .eq("is_active", true)
      .eq("is_permanent", true)
      .is("action_type", null)
      .order("priority", { ascending: false })
      .order("id", { ascending: true })
      .limit(20),
    // Confirmed top-importance principles (importance >= 9, no pgvector needed)
    // B11(Fable5): .neq は NULL 行を除外する（SQL <> セマンティクス）→ .or で NULL 許容に。
    // created_at 降順タイブレークで同 importance 内の選抜を決定的にする
    supabase
      .from("ai_reply_knowledge")
      .select("content, importance")
      .eq("category", "principle")
      .gte("importance", 9)
      .or("hypothesis_status.is.null,hypothesis_status.neq.rejected")
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(10),
    // templates: match_templates RAGに移行済み。バルクフェッチ廃止。
    // 旧: won_count 上位5件を全会話共通で注入 → キャッシュ破棄の原因かつ文脈無関係。
    // 新: 会話コンテキスト（フェーズ・戦略・人間性）に近いテンプレを match_templates RAGで取得。
    // このプレースホルダーは Promise.all のインデックスを崩さないために残す。
    Promise.resolve({ data: [] }),
    // 線引きルール: BOUNDARY-* rules that define when to use AIX vs auto-reply
    // B4(Fable5): limit 15→40 — 本番に31行あり、旧limitでは線引きルールの半分以上が無言欠落していた。
    // 線引きルールは reply_mode（aix/auto_reply）判定の根幹のため全件注入する
    supabase
      .from("ai_prompt_rules")
      .select("rule_key, action_type, rule_text")
      .like("rule_key", "BOUNDARY-%")
      .eq("is_active", true)
      .order("priority", { ascending: false })
      .order("id", { ascending: true })
      .limit(40),
    supabase
      .from("trigger_action_rules")
      .select("keyword, action_type, rule_text")
      .like("keyword", "BOUNDARY%")
      .gte("confidence", 0.5)
      .order("keyword", { ascending: true })
      .limit(10),
    // 成約パターン（distilled）: RAG化により match_winning_patterns に移行済み。
    // 以前は ai_reply_knowledge category='pattern' を4件バルクフェッチしていたが、
    // winning_patterns テーブルへの移行 + RAGベクトル検索で会話コンテキスト最適なパターンを取得する。
    // このクエリは削除しプレースホルダーで置き換え（Promise.all のインデックスを崩さないため）
    Promise.resolve({ data: [] }),
    // 成約・申込到達の会話の実際の優良返信（success × starred × line_reply）
    // FK: ai_reply_examples.conversation_id → conversations.id（migrate-schema L681）で inner join
    supabase
      .from("ai_reply_examples")
      .select("sent_reply, conversation_state, conversations!inner(status)")
      .in("conversations.status", SUCCESS_EXAMPLE_STATUSES)
      .eq("is_starred", true)
      .eq("entry_source", "line_reply")
      .not("sent_reply", "is", null)
      .order("created_at", { ascending: false })
      .limit(8),
    // ② この会話で使われたAIXアクション履歴（メッセージ単位の厳密ラベル用）
    // check_pattern: property_check_result の確認結果（unavailable=募集なし等）。
    // 「物件確認した」だけでなく「結果どうだったか」を last_aix_history に含めるため取得
    supabase
      .from("aix_usage_logs")
      // M1: property_names / prop_statuses = スタッフが「物件確認した」で入力した物件別の空き状況。
      // check_pattern（代表1値）では失われる「3件中1件だけ空室」の粒度をbrainに渡すため取得する
      // M2: estimate_sent / prop_cost_notes = 御見積書の同封有無と見積書OCRの費用情報。
      // 「見積書を送った」「割引が少ない/クリーニング代が必要/初期費用が高い」までbrainに渡す
      .select("aix_type, line_message_id, sent_at, created_at, template_name, check_pattern, property_names, prop_statuses, estimate_sent, prop_cost_notes")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(30),
    // H6(Fable5): 予約送信済みメッセージ（pending）— 追客提案が予約済み送信と重複するのを防ぐ
    supabase
      .from("scheduled_messages")
      .select("text, scheduled_at")
      .eq("conversation_id", conversationId)
      .eq("status", "pending")
      .order("scheduled_at", { ascending: true })
      .limit(5),
    // H6(Fable5): この会話の未完了タスク — next_steps を実際の保留作業に接地させる
    // 監査FIX(2026-08-20): status=pending 限定をやめ直近タスク全体を取得（limit 8）。
    // 完了済みタスクの result（空室確認の回答: available/taken/second_position/move_out_planned）を
    // urgency_appropriate / property_check_result の事実根拠として注入するため
    supabase
      .from("line_tasks")
      .select("task_type, status, created_at, result, result_note, resolved_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(8),
    // H6(Fable5): 内覧予定/完了 — 次アクション判断の核となるシグナル
    supabase
      .from("viewings")
      .select("viewing_date, viewing_time, status")
      .eq("conversation_id", conversationId)
      .order("viewing_date", { ascending: false })
      .limit(3),
    // viewing_history（is_primary=true）を優先参照 — viewingsの後継テーブル
    supabase
      .from("viewing_history")
      .select("scheduled_date, scheduled_time, status, property_name, property_address")
      .eq("conversation_id", conversationId)
      .order("scheduled_date", { ascending: false })
      .limit(3),
    // applying_pattern: RAG化により match_reply_knowledge に統合済み。
    // ai_reply_knowledge category='applying_pattern' は match_reply_knowledge RPC が
    // 全カテゴリ対象でベクトル検索するため、バルクフェッチは不要。プレースホルダーで置き換え。
    Promise.resolve({ data: [] }),
    // winning_patterns: RAG化（match_winning_patterns）に移行済み。プレースホルダー。
    Promise.resolve({ data: [] }),
    // RAG化 Phase1: アクション連動ルール（is_permanent 不問・BOUNDARY-* は上の別枠で全件取得済み）。
    // 従来の恒久ルール枠は action_type IS NULL 必須のため、action_type 付きルール
    // （HUMAN-*/FEEDBACK-*/IMPLEMENT-*/LEARN-AIX-* 等）は brain に構造的に一切届いていなかった。
    // priority >= 4 は decay（ai-feedback の90日 demote → priority 2 を除外）との整合（prompt-rules.ts と同基準）。
    // action_type='generate_reply'（返信文面ポリシー）は brain の管轄外のため候補に含めない
    // （actionCandidates は AIX_BRAIN_NOTES キー由来の固定文字列のみ → .in() インジェクション懸念なし）
    supabase
      .from("ai_prompt_rules")
      .select("rule_key, action_type, rule_text, priority, condition_key, condition_value")
      .eq("is_active", true)
      .in("action_type", actionCandidates)
      .not("rule_key", "like", "BOUNDARY-%")
      .gte("priority", 4)
      .order("priority", { ascending: false })
      .order("updated_at", { ascending: false, nullsFirst: false })
      .limit(15),
  // aix_transition_stats: AIX遷移マップ（成約会話の実測データ・DB動的）
  supabase
    .from("aix_transition_stats")
    .select("from_aix_type, to_aix_type, count")
    .order("count", { ascending: false }),
  ]);

  const { data: messages, error, count: totalMessageCount } = msgResult;
  if (error || !messages || messages.length === 0) {
    console.warn("[brain-core] analyzeConversation abort: msgs fetch failed or empty", conversationId, "error:", error?.message ?? "none");
    return null;
  }
  // H5(Fable5): 全メッセージが画像/添付のみ（テキスト0件）の場合は分析しない。
  // 「（画像/添付）×N」だけを読んだHaikuの当てずっぽう提案がキャッシュされるのを防ぐ
  if (messages.every((m) => !m.text)) {
    console.warn("[brain-core] analyzeConversation abort: all messages have no text", conversationId);
    return null;
  }

  // フロントエンド（page.tsx）と同じ first_reply 判定を brain 側にも適用して一本化。
  // hearing + スタッフの非AIX返信ゼロ → first_reply として分析（既にフェッチ済みメッセージを使うため追加DBクエリなし）
  const hasAnyRealStaffMsg = messages.some(m => m.sender === "staff" && !m.is_aix_generated);
  if (convStatus === "hearing" && !hasAnyRealStaffMsg) {
    convStatus = "first_reply";
  }

  // AIXアクションのメッセージ単位ラベル解決
  // 1) line_message_id 完全一致（P4以降のログ・直近30日で97%カバー）
  // 2) 旧ログ fallback: is_aix_generated=true × sent_at ±3分
  type AixLog = { aix_type: string | null; line_message_id: string | null; sent_at: string | null; created_at: string; template_name?: string | null; check_pattern?: string | null; property_names?: string[] | null; prop_statuses?: string[] | null; estimate_sent?: boolean | null; prop_cost_notes?: string[] | null };
  const aixLogs = (aixLogsResult.data ?? []) as AixLog[];
  // AIX遷移マップ（DB動的）: from_aix_type → [{to, count}] 降順
  const aixTransitionMap: Record<string, Array<{ to: string; count: number }>> = {};
  for (const row of (transitionStatsResult.data ?? []) as { from_aix_type: string; to_aix_type: string; count: number }[]) {
    if (!aixTransitionMap[row.from_aix_type]) aixTransitionMap[row.from_aix_type] = [];
    aixTransitionMap[row.from_aix_type].push({ to: row.to_aix_type, count: row.count });
  }
  const aixTypeByLmid = new Map<string, string>();
  for (const l of aixLogs) {
    if (l.line_message_id && l.aix_type) aixTypeByLmid.set(l.line_message_id, l.aix_type);
  }
  const aixLogsNoLmid = aixLogs.filter((l) => !l.line_message_id && l.aix_type);

  // Reverse so the history reads oldest → newest
  // B3(Fable5): 各行に日付（M/D）を付与 — 旧実装は created_at を取得しながらプロンプトから捨てており、
  // Haiku が「5分前の返信」と「12日間沈黙」を区別できず followup_revive 判断が原理的に不可能だった
  const typedMessages = messages as Array<{ sender: string; text: string | null; created_at: string; line_message_id: string | null; is_aix_generated: boolean | null; quoted_message_id: string | null; image_type: string | null }>;
  // 監査FIX(2026-08-20): 画像種別ラベル（Vision分類済みの場合のみ）と引用リプライ注釈を履歴に付与。
  // 引用先が取得ウィンドウ内にあれば先頭30字を添える → 「物件カードへの引用=その物件が話題の中心」を事実化
  const IMAGE_TYPE_LABEL: Record<string, string> = { estimate: "見積書", floor_plan: "間取り図", property_photo: "物件写真", id_document: "本人確認書類", other: "その他画像" };
  const msgByLmid = new Map<string, { text: string | null }>();
  for (const m of typedMessages) {
    if (m.line_message_id) msgByLmid.set(m.line_message_id, { text: m.text });
  }
  const history = [...typedMessages]
    .reverse()
    .map((m) => {
      let senderLabel = "顧客";
      if (m.sender === "staff") {
        const exact = m.line_message_id ? aixTypeByLmid.get(m.line_message_id) : undefined;
        const fuzzy = (!exact && m.is_aix_generated)
          ? aixLogsNoLmid.find((l) => Math.abs(new Date(l.sent_at ?? l.created_at).getTime() - new Date(m.created_at).getTime()) < 3 * 60 * 1000)?.aix_type
          : undefined;
        const aixType = exact ?? fuzzy;
        senderLabel = aixType ? `AIX:${aixType}` : (m.is_aix_generated ? "AIX" : "スタッフ");
      }
      const dateLabel = new Date(m.created_at).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", timeZone: "Asia/Tokyo" });
      const imageTag = m.image_type && IMAGE_TYPE_LABEL[m.image_type] && /^\[画像\]/.test(m.text ?? "")
        ? `（画像種別: ${IMAGE_TYPE_LABEL[m.image_type]}）` : "";
      const quoted = m.quoted_message_id ? msgByLmid.get(m.quoted_message_id) : undefined;
      const quoteTag = m.quoted_message_id
        ? `（引用返信${quoted?.text ? `→「${quoted.text.replace(/\n/g, " ").slice(0, 30)}」` : ""}）` : "";
      return `[${senderLabel} ${dateLabel}] ${quoteTag}${m.text ?? "（画像/添付）"}${imageTag}`;
    })
    .join("\n");

  // セーブポイントRAG検索: 現在の会話コンテキストに関連する古いCPを類似検索
  // RAG化 Phase2: 同じ embedding を再利用して ai_reply_knowledge の類似ナレッジも検索する
  // （match_reply_knowledge・OpenAI追加コストゼロ・追加レイテンシはRPC1本分のみ）。
  // embedding 失敗・OPENAI_API_KEY 未設定・RPC エラー時は RAG 部分が空になるだけで、
  // 既存の静的保証バケット（principle/成約パターン/applying_pattern）のみで従来同様に動作する。
  let ragCheckpoints: Array<{ checkpoint_index: number; summary: string | null; key_facts: unknown; conversation_stage: string | null; similarity?: number }> = [];
  type RagKnowledgeRow = { title: string | null; content: string | null; category: string | null; conversation_state: string | null; importance: number | null; similarity: number };
  let ragKnowledgeRaw: RagKnowledgeRow[] = [];
  let ragWinningPatterns: Array<{ situation: string | null; pattern: string; closing_action: string | null; human_type_label: string | null; outcome_type: string; notes: string | null; win_rate: number | null; importance: number; customer_intent: string | null; staff_reply_intent: string | null; checkpoint_stage: string | null; similarity: number }> = [];
  let ragTemplates: Array<{ id: string; category: string | null; label: string | null; win_rate: number | null; use_count: number | null; won_count: number | null; similarity: number }> = [];
  // RAG: incremental mode でも実行する（winning_patterns / templates は毎回必要）。
  // checkpoint RAG のみ非incremental 限定（古い会話セーブポイントの検索は差分分析では不要）。
  if (process.env.OPENAI_API_KEY) {
    // RAGクエリ: 顧客人間性プロファイル + 前回戦略 + フェーズ を中心に構築。
    // 「よろしくお願いします」等の短いメッセージよりも personality_profile の方が
    // winning_patterns.situation（人間性ベース）との embedding 類似度が高い。
    type PcForRag = { personality_profile?: string | null; preferences?: string | null; ai_summary?: string | null };
    const pcForRag = (pcResult.data as PcForRag | null);
    // P0-3/4: winning_pattern と customer_intent を追加。
    // generate-reply 側は 2026-08-25 強化済みで両フィールドを RAG クエリに含めているが、
    // brain-core 側の prevMetaCtx が欠落していたため非対称になっていた。
    // winning_pattern → match_winning_patterns の命中精度向上
    // customer_intent → match_reply_knowledge の意図別ナレッジ命中率向上
    // AIX-META全フィールドをprevMetaCtxに統合（latent_intent/customer_emotion/actionを追加）
    const prevMetaCtx = opts?.prevMeta
      ? [
          opts.prevMeta.action,
          opts.prevMeta.closing_strategy,
          opts.prevMeta.reply_direction,
          opts.prevMeta.winning_pattern,
          opts.prevMeta.customer_intent,
          opts.prevMeta.latent_intent,
          opts.prevMeta.customer_emotion,
          (opts.prevMeta as Record<string, unknown>).checkpoint_stage,
          // 他3経路（aix/action・aix-template-generate・generate-reply）と対称化
          opts.prevMeta.purchase_signal_level ? `温度感: ${opts.prevMeta.purchase_signal_level}` : null,
          opts.prevMeta.engagement_stance ? `押し引き: ${opts.prevMeta.engagement_stance}` : null,
          opts.prevMeta.repeated_concern ? `繰り返し懸念: ${opts.prevMeta.repeated_concern}` : null,
          opts.prevMeta.human_type_label ? `人物タイプ: ${opts.prevMeta.human_type_label}` : null,
        ].filter(Boolean).join(" ")
      : "";
    const recentCustomerMsgs = typedMessages
      .filter(m => m.sender === "customer" && m.text)
      .slice(-3)
      .map(m => m.text)
      .join(" ");
    // TPOラベル推定: AIX-METAから場面を特定してRAGクエリに明示（成約TPOパターン命中精度向上）
    const lastCustomerMsg = typedMessages.filter(m => m.sender === "customer" && m.text).slice(-1)[0]?.text ?? "";
    const tpoHint = (() => {
      const intent = opts?.prevMeta?.customer_intent ?? "";
      const action = opts?.prevMeta?.action ?? "";
      const emotion = opts?.prevMeta?.customer_emotion ?? "";
      const msg = lastCustomerMsg ?? "";
      const lastStaffMsg = typedMessages.filter(m => m.sender === "staff" && m.text).slice(-1)[0]?.text ?? null;
      // 1. 申込後説明（state確定・最優先）
      if (convStatus === "applying") return "申込後説明";
      // 2. 拒否対応（ネガティブ意図は他条件より優先）
      if (intent === "negative" || /やめ(とき)?ます|キャンセル|他(で|の会社)|見送り/.test(msg)) {
        return "拒否対応";
      }
      // 3. 不安対応（審査・費用・契約への不安）
      if (/不安|心配|審査.*(通|落)|落ち(る|たら)|大丈夫でしょうか/.test(msg) || /不安|心配|anxious|worried/.test(emotion)) {
        return "不安対応";
      }
      // 4. 内覧調整（実際のaction値: viewing_invite / meeting_place）
      if (
        action === "viewing_invite" ||
        action === "meeting_place" ||
        /内覧|内見|見学|現地|待ち合わせ/.test(msg)
      ) {
        return "内覧調整";
      }
      // 5. 申込前クロージング（顧客側から申込意思・決断の表明）
      if (/申(し)?込(み)?(たい|します|お願い)|契約したい|決め(ます|ました)|ここにします/.test(msg)) {
        return "申込前クロージング";
      }
      // 6. 申込打診（AI側から申込を打診するアクション）
      if (action === "application_push") return "申込打診";
      // 7. 費用説明（初期費用・見積に関する質問）
      if (/初期費用|見積|敷金|礼金|仲介手数料|保証(会社|料)|家賃.*(いくら|交渉)|費用.*(いくら|どのくらい|教えて)|総額/.test(msg)) {
        return "費用説明";
      }
      // 8. 物件送付後（actionで確実に検出＋従来のlastStaffMsgフォールバック）
      if (
        action === "property_send" ||
        action === "property_recommendation" ||
        action === "estimate_sheet" ||
        (lastStaffMsg && /ピックアップ|お部屋.*送|物件.*(紹介|送付|お送り)/.test(lastStaffMsg))
      ) {
        return "物件送付後";
      }
      // 9. 初回対応（スタッフ発言がまだない＝会話冒頭）
      if (!lastStaffMsg || convStatus === "initial" || convStatus === "new") {
        return "初回対応";
      }
      // 10. 感謝返し（明示的な感謝表現のみ。「了解です」等の誤マッチを防止）
      if (
        intent === "positive" &&
        msg.length < 40 &&
        /ありがとう|ありがとございます|感謝|助かり(ます|ました)|嬉しい/.test(msg)
      ) {
        return "感謝返し";
      }
      // 11. 検討中フォロー（相談意図・迷い・フォロー系アクション）
      if (
        intent === "consultation" ||
        action === "follow_up" ||
        action === "followup_revive" ||
        /検討|迷って|考え(て|させて)|悩んで/.test(msg)
      ) {
        return "検討中フォロー";
      }
      return null;
    })();
    const ragQueryInput = [
      tpoHint ? `[TPO:${tpoHint}]` : null,           // TPO場面明示（成約パターン命中精度向上）
      pcForRag?.personality_profile,                   // 顧客の人間性（winning_patterns.situation と近い）
      // P1-3: ai_summary（決まるパターン・人物像）をRAGクエリに追加。SELECTしているのに未使用だったデッドフィールドを解消
      pcForRag?.ai_summary?.slice(0, 200) ?? null,    // AIによる顧客プロファイル分析
      pcForRag?.preferences,                           // 希望・こだわり条件
      prevMetaCtx,                                     // AIX-META: アクション・戦略・意図・感情
      convStatus,                                      // 現在の会話フェーズ
      recentCustomerMsgs.slice(0, 200),                // 直近顧客メッセージ
    ].filter(Boolean).join(" ").slice(0, 1500);
    if (ragQueryInput.trim()) {
      try {
        const qEmb = await generateEmbedding(ragQueryInput);
        if (qEmb) {
            const [cpRes, knRes] = await Promise.all([
              // checkpoint RAG: 非incremental + propertyCustomerId がある場合のみ
              // （差分分析では古い会話構造の検索は不要）
              (!isIncremental && propertyCustomerId)
                ? supabase.rpc("match_conversation_checkpoints", {
                    conversation_id_param: conversationId,
                    query_embedding: qEmb,
                    match_count: 6,
                    min_similarity: 0.5,
                  })
                : Promise.resolve({ data: null }),
              // match_reply_knowledge: incremental でも実行（原則・知識は毎回必要）
              supabase.rpc("match_reply_knowledge", {
                query_embedding: qEmb,
                match_count: 30,
                min_importance: 8,
                boost_state: tpoHint ?? null,
              }),
            ]);
            ragCheckpoints = ((cpRes as { data: unknown }).data ?? []) as typeof ragCheckpoints;
            ragKnowledgeRaw = ((knRes as { data: unknown }).data ?? []) as RagKnowledgeRow[];

            // winning_patterns RAG: incremental でも実行（人間性ベースのクロージング戦略は毎回必要）
            const [wpRagResult, tplRagResult] = await Promise.all([
              supabase.rpc("match_winning_patterns", {
                query_embedding: qEmb,
                match_count: 9,
                min_importance: 8,
              }),
              // templates RAG: 会話フェーズ・戦略に最も近いテンプレを取得（バルクフェッチ廃止）
              supabase.rpc("match_templates", {
                query_embedding: qEmb,
                match_count: 8,
              }),
            ]);
            ragWinningPatterns = ((wpRagResult.data ?? []) as Array<{
              situation: string | null;
              pattern: string;
              closing_action: string | null;
              human_type_label: string | null;
              outcome_type: string;
              notes: string | null;
              win_rate: number | null;
              importance: number;
              customer_intent: string | null;
              staff_reply_intent: string | null;
              checkpoint_stage: string | null;
              similarity: number;
            }>).filter((w) => w.similarity >= 0.5);
            // RAGソフトブースト: 現在のcheckpoint_stageと一致するパターンを先頭に並び替える
            // embedding類似度で取得済みの結果を、フェーズ一致パターンが前に来るよう再ソートするのみ
            const currentStage = (opts?.prevMeta?.checkpoint_stage as string | null | undefined) ?? null;
            if (currentStage) {
              ragWinningPatterns = [
                ...ragWinningPatterns.filter(w => w.checkpoint_stage === currentStage),
                ...ragWinningPatterns.filter(w => w.checkpoint_stage !== currentStage),
              ];
            }
            // templates RAG: 類似度 0.4 以上、won_count 降順でソート（成約実績を最優先）
            ragTemplates = ((tplRagResult.data ?? []) as typeof ragTemplates)
              .filter((t) => t.similarity >= 0.4)
              .sort((a, b) => (b.won_count ?? 0) - (a.won_count ?? 0));
          }
      } catch {
        // RAG失敗は無視・静的バケットのみで動作継続（既存方針）
      }
    }
  }

  // aix_action_attribution: 各アクションの成約勝率（action_type別・usage_count加重平均）
  // brain が「どのアクションが成約につながるか」を実測データで知った上で推奨できるようにする
  let actionWinRates: Array<{ action_type: string; avg_win_rate: number; total_usage: number }> = [];
  try {
    const { data: awrData } = await supabase
      .from("aix_action_attribution")
      .select("action_type, win_rate, usage_count")
      .not("win_rate", "is", null)
      .order("win_rate", { ascending: false });
    if (awrData && awrData.length > 0) {
      // action_typeごとに usage_count 加重平均を計算（期間・テンプレ別の行を集約）
      const grouped = new Map<string, { totalWinRate: number; totalUsage: number }>();
      for (const row of awrData as Array<{ action_type: string | null; win_rate: number | null; usage_count: number | null }>) {
        if (!row.action_type) continue;
        const key = row.action_type;
        const wr = Number(row.win_rate ?? 0);
        const uc = Number(row.usage_count ?? 1) || 1;
        if (!grouped.has(key)) grouped.set(key, { totalWinRate: 0, totalUsage: 0 });
        const g = grouped.get(key)!;
        g.totalWinRate += wr * uc;
        g.totalUsage += uc;
      }
      actionWinRates = Array.from(grouped.entries())
        .map(([action_type, { totalWinRate, totalUsage }]) => ({
          action_type,
          avg_win_rate: totalUsage > 0 ? totalWinRate / totalUsage : 0,
          total_usage: totalUsage,
        }))
        .filter((r) => r.avg_win_rate > 0)
        .sort((a, b) => b.avg_win_rate - a.avg_win_rate)
        .slice(0, 8);
    }
  } catch {
    // 取得失敗時は空のまま（フェイルセーフ・プロンプト注入をスキップするだけ）
  }

  // B3(Fable5): 今日の日付・最終顧客メッセージからの経過日数・総メッセージ数をプロンプト冒頭に注入。
  // これが無いと Haiku は経過時間を知り得ず、closing_strategy に架空の日付を創作していた
  const lastCustomerMsg = typedMessages.find((m) => m.sender === "customer"); // messagesは新しい順
  const daysSinceLastCustomerMsg = lastCustomerMsg
    ? Math.floor((Date.now() - new Date(lastCustomerMsg.created_at).getTime()) / 86_400_000)
    : null;
  const todayStr = new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
  const timingText = `\n【時間情報】今日: ${todayStr} / 最終顧客メッセージ: ${daysSinceLastCustomerMsg !== null ? `${daysSinceLastCustomerMsg}日前` : "不明"} / 総メッセージ数: ${totalMessageCount ?? typedMessages.length}件（履歴は直近${typedMessages.length}件のみ表示）`;

  // Build customer conditions context
  type PC = { desired_area?: string | null; floor_plan?: string | null; rent_min?: number | null; rent_max?: number | null; move_in_time?: string | null; preferences?: string | null; ng_points?: string | null; walk_minutes?: number | null; last_property_sent_at?: string | null; property_send_count?: number | null; ai_summary?: string | null; ai_summary_json?: Record<string, unknown> | null; personality_profile?: string | null; pet?: boolean | null; floor_area_min?: number | null; floor_area_max?: number | null; commute_station?: string | null; commute_minutes?: number | null; area_mode?: string | null; initial_cost_limit?: number | null; building_age?: number | null; other_requests?: string | null } | null;
  const pc = (pcResult.data ?? null) as PC;
  const condParts: string[] = [];
  if (pc?.desired_area) condParts.push(`エリア: ${pc.desired_area}`);
  if (pc?.area_mode && pc.area_mode !== "auto") condParts.push(`エリアモード: ${pc.area_mode === "ward" ? "市区町村優先" : pc.area_mode === "station" ? "駅・路線優先" : pc.area_mode === "both" ? "市区町村+駅両方" : pc.area_mode}`);
  if (pc?.floor_plan) condParts.push(`間取り: ${pc.floor_plan}`);
  if (pc?.rent_min) condParts.push(`家賃下限: ${Math.floor((pc.rent_min as number) / 10000)}万`);
  if (pc?.rent_max) condParts.push(`家賃上限: ${Math.floor((pc.rent_max as number) / 10000)}万`);
  if (pc?.floor_area_min || pc?.floor_area_max) {
    const areaMin = pc.floor_area_min ? `${pc.floor_area_min}㎡以上` : "";
    const areaMax = pc.floor_area_max ? `${pc.floor_area_max}㎡以下` : "";
    condParts.push(`広さ: ${[areaMin, areaMax].filter(Boolean).join("〜")}`);
  }
  if (pc?.walk_minutes) condParts.push(`駅徒歩: ${pc.walk_minutes}分以内`);
  if (pc?.commute_station) condParts.push(`通勤先: ${pc.commute_station}${pc.commute_minutes ? `（${pc.commute_minutes}分以内）` : ""}`);
  if (pc?.move_in_time) condParts.push(`入居: ${pc.move_in_time}`);
  if (pc?.pet != null) condParts.push(`ペット: ${pc.pet ? "可" : "不可"}`);
  if (pc?.initial_cost_limit) condParts.push(`初期費用上限: ${Math.floor((pc.initial_cost_limit as number) / 10000)}万`);
  if (pc?.building_age) condParts.push(`築年数: ${pc.building_age}年以内`);
  if (pc?.preferences) condParts.push(`希望: ${pc.preferences}`);
  if (pc?.ng_points) condParts.push(`NG条件: ${pc.ng_points}`);
  if (pc?.other_requests) condParts.push(`その他要望: ${pc.other_requests}`);
  const condText = condParts.length > 0 ? `\n顧客条件: ${condParts.join(" / ")}` : "";

  // 【顧客プロファイル】ai_summary_json（emotion/urgency/style/personality_profile）由来。
  // 顧客ごとに変わるため必ず userPrompt 側に注入する（system側に入れると prompt caching が壊れる）
  let profileText = "";
  const aiSummary = pc?.ai_summary_json ?? null;
  if (aiSummary && typeof aiSummary === "object") {
    const summaryStr = (key: string): string | null => {
      const v = (aiSummary as Record<string, unknown>)[key];
      return typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null;
    };
    const emotion = summaryStr("emotion");
    const urgency = summaryStr("urgency");
    const style = summaryStr("style");
    // 人間性: Opus確定版の長期プロファイル（personality_profileカラム）を優先、なければai_summary_json内のもの
    const personality = (pc?.personality_profile && pc.personality_profile.trim())
      ? pc.personality_profile.trim().slice(0, 300)
      : summaryStr("personality_profile");
    const profileLines: string[] = [];
    if (emotion) profileLines.push(`- 温度感: ${emotion}（前向き/不安/冷めかけ/普通）`);
    if (urgency) profileLines.push(`- 時期感: ${urgency}（今月中/3ヶ月以内/半年以上/未確認）`);
    if (style) profileLines.push(`- 文体: ${style}（絵文字多用/短文/ビジネスライク/丁寧/普通）`);
    if (personality) profileLines.push(`- 人間性: ${personality}`);
    if (profileLines.length > 0) {
      profileText = `\n【顧客プロファイル（ai_summary由来・参考）】\n${profileLines.join("\n")}\n→ closing_strategy・next_steps はこの顧客プロファイルを反映した内容にすること\n→ 不安タイプ→強引に押さない / urgency高い→スピード感を前面に出す 等`;
    }
  }

  // 【顧客の会話ストーリー】ai_summary全文（テキスト版）。プロファイル(JSON由来)とは別に、
  // 顧客の全文脈（経緯・今の状況・次の必須対応）を戦略決定の材料として注入する
  const aiSummaryFullRaw = (pc?.ai_summary ?? "").trim();
  const aiSummaryFullText = aiSummaryFullRaw.length > 1500 ? aiSummaryFullRaw.slice(0, 1500) : aiSummaryFullRaw;
  const aiSummaryNote = aiSummaryFullText
    ? `\n【顧客の会話ストーリー（ai_summary全文・必ず読むこと）】\n${aiSummaryFullText}\n→ この顧客の全文脈を踏まえてclosing_strategy・next_stepsを決定すること\n`
    : "";

  const statusMeaning = convStatus && STATUS_MEANING[convStatus] ? STATUS_MEANING[convStatus] : (convStatus ?? "");
  const statusText = convStatus ? `\n現在のステータス: ${statusMeaning}` : "";

  // Recent starred examples (good replies) for this customer
  const examples = (examplesResult.data ?? []) as Array<{ sent_reply: string | null; is_starred: boolean | null }>;
  const examplesText = examples.length > 0
    ? `\n過去のスタッフ優良返信例:\n${examples.map((e) => `- ${e.sent_reply ?? ""}`).join("\n")}`
    : "";

  // key_facts は jsonb 配列（{type, value}[]）で返る — 文字列連結すると [object Object] になるため value を整形する
  type CheckpointFact = { type?: string; value?: string };
  type Checkpoint = { checkpoint_index: number; summary: string | null; key_facts: CheckpointFact[] | null; conversation_stage: string | null };
  const latestCheckpoint = ((checkpointsResult.data ?? []) as Checkpoint[])[0] ?? null;
  const checkpointFactsLine = Array.isArray(latestCheckpoint?.key_facts)
    ? (latestCheckpoint!.key_facts as CheckpointFact[]).map((f) => f?.value ?? "").filter(Boolean).join(" / ")
    : "";
  // RAG検索で引き出した関連CP（最新CP以外・類似度順 → checkpoint_index昇順で時系列表示）
  const latestIdx = latestCheckpoint?.checkpoint_index ?? -1;
  const uniqueRagCps = ragCheckpoints
    .filter(cp => cp.checkpoint_index !== latestIdx && (cp.summary ?? "").trim())
    .sort((a, b) => a.checkpoint_index - b.checkpoint_index);
  const ragCpText = uniqueRagCps.length > 0
    ? "\n\n【過去の関連セーブデータ（現在の会話に関係する古い事実）】\n" +
      uniqueRagCps.map(cp => "■ セーブ #" + cp.checkpoint_index + ":\n" + (cp.summary ?? "").slice(0, 1000)).join("\n---\n")
    : "";
  const checkpointText = latestCheckpoint?.summary
    ? "\n【会話セーブデータ（最新・確認済み事実の全量・最重要。ここに書かれた金額/物件/日付と矛盾する提案をしない）】\n" + latestCheckpoint.summary + (checkpointFactsLine ? "\n主要事実: " + checkpointFactsLine : "") + ragCpText
    : "";

  // Sent properties — what has already been proposed to this customer
  // 監査FIX(2026-08-20): 募集状況・番手・家賃・顧客反応（構造化済みの行のみ）を注釈として付与。
  // urgency_appropriate（「残り1室」等の緊急表現の事実根拠）と current_property の接地に使う
  type SentProp = { property_name: string; room_no: string; sent_at: string; rent: number | null; recruitment_status: string | null; applicant_rank: number | null; customer_reaction: string | null };
  const RECRUIT_LABEL: Record<string, string> = { open: "募集中", move_out_planned: "退去予定", occupied: "入居中", closed: "募集終了" };
  const REACTION_LABEL: Record<string, string> = { interested: "興味あり", rejected: "見送り", no_response: "反応なし" };
  const sentProps = ((sentPropsResult.data ?? []) as SentProp[]);
  let sentPropsText = sentProps.length > 0
    ? `\n【すでに送付済みの物件（${sentProps.length}件）】\n${sentProps.map((p) => {
        const facts = [
          p.rent != null ? `家賃${p.rent.toLocaleString()}円` : "",
          p.recruitment_status ? `募集状況:${RECRUIT_LABEL[p.recruitment_status] ?? p.recruitment_status}` : "",
          p.applicant_rank != null ? `${p.applicant_rank}番手` : "",
          p.customer_reaction ? `顧客反応:${REACTION_LABEL[p.customer_reaction] ?? p.customer_reaction}` : "",
        ].filter(Boolean).join("・");
        return `- ${p.property_name} ${p.room_no}（${new Date(p.sent_at).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })}送付${facts ? `・${facts}` : ""}）`;
      }).join("\n")}\n※上記の物件は絶対に再提案しないこと（顧客が明示的に再リクエストした場合を除く。例外: 顧客が申込→落選した物件と同一マンションの別号室が新規募集された場合は、最優先で提案し申込訴求すること。申込経験のある建物は建物の印象・共用部・立地を把握済みのため内覧スキップ可能）。property_send・property_recommendation の候補から必ず除外すること。`
    : "";

  // 申込経験者: ベンチマーク物件の注入
  // applicant_rank が入っている物件 = 顧客が実際に申込んだ（番手がついた）物件。
  // この物件の条件を基準線として、新規提案の訴求方法（申込プッシュ vs 内覧誘導）を切り替えさせる。
  const benchmarkProps = sentProps.filter((p) => p.applicant_rank != null);
  if (benchmarkProps.length > 0) {
    const bm = benchmarkProps[0]; // 最初の申込物件をベンチマークとする
    sentPropsText += `\n\n【ベンチマーク物件（顧客が申込→落選した物件）】\n`;
    sentPropsText += `${bm.property_name ?? "（物件名不明）"} ${bm.room_no ?? ""}: `;
    sentPropsText += `${bm.applicant_rank}番手で申込→落選済み。\n`;
    sentPropsText += `この物件の条件が顧客の基準線。\n`;
    sentPropsText += `新規提案物件を比較し: 上回る場合は application_push（内覧スキップ可）/ 下回る場合は estimate_sheet+viewing_invite を選ぶこと。\n`;
    sentPropsText += `顧客は申込フォーマット記入・書類提出を経験済み。申込の心理障壁が大幅に低下している。`;
  }

  // ── 物件検索統括コンテキスト ─────────────────────────────────────────
  // sent_properties + property_customers から「物件検索の全体像」を動的に組み立てて注入する。
  // 脳が property_search / property_send の使い分け（検索すべきか・送付を控えるべきか）を
  // 判断できるようにするための統括ブロック。propertyCustomerId が無い会話ではスキップ。
  //
  // TODO(P2): Chrome拡張フィードバックループ
  //   脳の suggested_aix_meta に property_search_params を追加し、
  //   Chrome拡張が起動時にWebAppのbrain/list APIからこれを取得して
  //   検索フォームに自動入力できるようにする
  //   必要なフィールド: { area, floor_plan, rent_max, walk_minutes, ng_properties: sent_properties }
  //
  // TODO(P2): 物件評価API
  //   /api/evaluate-property POST を新設。候補物件のスペックをbodyで受け取り、
  //   お客さんの条件とsent_propertiesを照合してスコア（0-100）とNG理由を返す
  //   Chrome拡張のscore-overlay.jsがこれを呼んでリアルタイムスコア表示に使う
  //
  // TODO(P3): 物件在庫連携
  //   Chrome拡張がリアプロ/itandi/レインズの検索結果を /api/property-inventory POST で
  //   サーバーに送信し、brain-core.tsがその在庫データを見て「今日オススメできる物件」を
  //   特定してChrome拡張に返す。完全自律物件選定の実現
  let propertySearchText = "";
  if (pc) {
    // sentCount: sent_properties の直近10件クエリ結果（10件で頭打ちのため「以上」表記）
    const sentCount = sentProps.length;
    // daysSinceLastSend: last_property_sent_at 優先、無ければ sent_properties の最新 sent_at
    const lastSentIso = pc.last_property_sent_at ?? sentProps[0]?.sent_at ?? null;
    const daysSinceLastSend = lastSentIso
      ? Math.floor((Date.now() - new Date(lastSentIso).getTime()) / 86_400_000)
      : null;
    // property_send_count = 連続未返信送付数（顧客が反応するとUI側で0にリセットされる）
    const unansweredSendCount = pc.property_send_count ?? 0;
    // 物件検索推奨度（★の数）:
    //   ─   : 連続未返信送付2件以上 → お客さんが反応していない。property_send は控える
    //   ★★★: 7日以上送付なし or 送付0件 → 今すぐ property_search を提案
    //   ★★ : 3-6日 → property_send または property_search を検討
    //   ★  : 3日未満 → 様子見
    let searchPriority: string;
    if (unansweredSendCount >= 2) {
      searchPriority = "─（送付済みがあり返信待ち → property_sendは控える）";
    } else if (daysSinceLastSend === null || daysSinceLastSend >= 7) {
      searchPriority = "★★★（7日以上送付なし → 今すぐproperty_searchを提案）";
    } else if (daysSinceLastSend >= 3) {
      searchPriority = "★★（3-6日 → property_sendまたはproperty_searchを検討）";
    } else {
      searchPriority = "★（3日未満 → 様子見）";
    }
    propertySearchText = `
【物件検索統括】
送付済み件数: ${sentCount}件${sentCount >= 10 ? "以上" : ""}
最終送付: ${daysSinceLastSend !== null ? `${daysSinceLastSend}日前` : "まだ送付なし"}
連続未返信送付: ${unansweredSendCount}件（2件以上 = お客さんが反応していない）
検索条件:
  エリア: ${pc.desired_area ?? "未設定"}${pc.area_mode && pc.area_mode !== "auto" ? `（モード: ${pc.area_mode}）` : ""}
  間取り: ${pc.floor_plan ?? "未設定"}
  家賃上限: ${pc.rent_max ? `${Math.floor((pc.rent_max as number) / 10000)}万円` : "未設定"}${pc.rent_min ? `（下限: ${Math.floor((pc.rent_min as number) / 10000)}万円）` : ""}
  広さ: ${pc.floor_area_min || pc.floor_area_max ? `${pc.floor_area_min ? `${pc.floor_area_min}㎡以上` : ""}${pc.floor_area_max ? `〜${pc.floor_area_max}㎡` : ""}` : "未設定"}
  駅徒歩: ${pc.walk_minutes ? `${pc.walk_minutes}分以内` : "未設定"}
  通勤先: ${pc.commute_station ? `${pc.commute_station}${pc.commute_minutes ? `（${pc.commute_minutes}分以内）` : ""}` : "未設定"}
  入居時期: ${pc.move_in_time ?? "未設定"}
  ペット: ${pc.pet != null ? (pc.pet ? "可" : "不可") : "未設定"}
  初期費用上限: ${pc.initial_cost_limit ? `${Math.floor((pc.initial_cost_limit as number) / 10000)}万円` : "未設定"}
  築年数: ${pc.building_age ? `${pc.building_age}年以内` : "未設定"}
  希望条件: ${pc.preferences ?? "未設定"}
  その他要望: ${pc.other_requests ?? "未設定"}
物件検索推奨度: ${searchPriority}`;
  }

  type PromptRule = { rule_text: string; priority: number };
  const promptRules = (promptRulesResult.data ?? []) as PromptRule[];
  const promptRulesText = promptRules.length > 0
    ? `\n【絶対ルール（オペレーター設定）】\n${promptRules.map((r) => `- ${r.rule_text}`).join("\n")}`
    : "";

  // RAG化 Phase1: アクション連動ルール（現局面候補のAIXアクションに紐づく ai_prompt_rules）。
  // 会話依存（前回フェーズでフィルタ済み）のため必ず userPrompt 側に注入する
  // （system側に入れると prompt caching が会話ごとにミスして Sonnet コストが跳ね上がる）
  type ActionRule = { rule_key: string; action_type: string | null; rule_text: string; priority: number | null; condition_key: string | null; condition_value: string | null };
  const actionRules = ((actionRulesResult.data ?? []) as ActionRule[])
    // condition_key 付きルールは conversation_state 一致のみ許可（brain は他の条件コンテキストを持たない）
    .filter((r) => !r.condition_key || (r.condition_key === "conversation_state" && r.condition_value === convStatus))
    // 恒久グローバル枠（promptRules）と本文重複するものは除外
    .filter((r) => !promptRules.some((p) => p.rule_text === r.rule_text));
  const actionRulesText = actionRules.length > 0
    ? `\n【アクション別ルール（現局面候補: ${actionCandidates.join("/")}）】\n${actionRules.map((r) => `- [${r.action_type}] ${r.rule_text}`).join("\n")}`
    : "";

  type KnowledgePrinciple = { content: string; importance: number };
  const knowledgePrinciples = (knowledgePrinciplesResult.data ?? []) as KnowledgePrinciple[];
  const knowledgeText = knowledgePrinciples.length > 0
    ? `\n【重要原則】\n${knowledgePrinciples.map((k) => `- ${k.content}`).join("\n")}`
    : "";

  // Templates RAG: 会話コンテキストに最も近いテンプレを match_templates RAGで取得（バルクフェッチ廃止）
  // バルクフェッチ（won_count 全体上位5件）は文脈無関係。RAGにより「内覧中の会話→内覧系テンプレ」が自然に浮上する。
  const templatesText = ragTemplates.length > 0
    ? `\n【テンプレート候補（RAG検索・この会話のフェーズ・戦略に類似したもの・won_count降順）】\n${ragTemplates.slice(0, 5).map((t) => `- ${t.category}: ${t.label} (成約実績${t.won_count ?? 0}回, モーダル経由${t.use_count ?? 0}回)`).join("\n")}\n※won_count は closed_won 会話の自発送信とテンプレ本文の突き合わせで集計した成約実績。template_hint は上記フェーズ別推奨マップに従い、この会話に合ったテンプレを won_count が高い順に選ぶこと。`
    : "";

  // Boundary rules — when AIX is required vs auto-reply is allowed
  type BoundaryRule = { rule_key?: string; keyword?: string; action_type: string | null; rule_text: string };
  const boundaryRulesFromPrompts = (boundaryPromptRulesResult.data ?? []) as BoundaryRule[];
  const boundaryRulesFromTrigger = (boundaryTriggerRulesResult.data ?? []) as BoundaryRule[];
  const allBoundaryRules = [...boundaryRulesFromPrompts, ...boundaryRulesFromTrigger];
  const boundaryText = allBoundaryRules.length > 0
    ? `\n【線引きルール（AIX必須 vs 自動返信OK）】\n${allBoundaryRules.map((r) => {
        const aix = r.action_type && r.action_type !== 'generate_reply' ? `→ AIX: ${r.action_type}` : '→ 自動返信禁止';
        return `- ${r.rule_text} ${aix}`;
      }).join("\n")}`
    : "";

  // ── 成約パターン注入 ─────────────────────────────────────────────
  // 過去に closed_won（成約）に至った会話から学習したパターンと実返信例。
  // データが無ければ空文字（ブロックごとスキップ）。
  type ContractKnowledge = { title: string | null; content: string | null; importance: number | null };
  const contractKnowledge = (contractKnowledgeResult.data ?? []) as ContractKnowledge[];

  type ContractExample = {
    sent_reply: string | null;
    conversation_state: string | null;
    conversations: { status: string | null } | { status: string | null }[] | null;
  };
  // 成約/申込到達の別（[成約]=closed_won / [申込到達]=applying等）をラベル化
  const outcomeOf = (e: ContractExample): string => {
    const st = Array.isArray(e.conversations) ? e.conversations[0]?.status : e.conversations?.status;
    return st === "closed_won" ? "成約" : "申込到達";
  };
  const rawContractExamples = (contractExamplesResult.data ?? []) as ContractExample[];
  // 現在のステータスと同じ段階の返信例を優先し、最大3件・各100字に切り詰め
  const stateMatched = rawContractExamples.filter((e) => e.conversation_state === convStatus);
  const stateOthers = rawContractExamples.filter((e) => e.conversation_state !== convStatus);
  const contractExamples = [...stateMatched, ...stateOthers].slice(0, 3);

  const contractKnowledgeLines = contractKnowledge
    .map((k) => `- ${(k.title ?? "").slice(0, 40)}: ${(k.content ?? "").replace(/\n/g, " ").slice(0, 600)}`)
    .join("\n");
  const contractExampleLines = contractExamples
    .map((e) => `- [${outcomeOf(e)}] (${e.conversation_state ?? "不明"}段階) 「${(e.sent_reply ?? "").replace(/\n/g, " ").slice(0, 250)}」`)
    .join("\n");

  // 安定部分（成功法則のみ）→ キャッシュブロックに含める
  const contractPatternsText = contractKnowledge.length > 0
    ? `\n【成約・申込到達パターン（過去に契約/申込に至った会話から学習・参考）】${contractKnowledgeLines ? `\n■ 成功法則・転換点:\n${contractKnowledgeLines}` : ""}\n※現在の会話がこれらのパターンに近い場合、closing_strategy と next_steps は成約パターンの流れに沿って提案すること。`
    : "";
  // 会話フェーズ依存（convStatus でソート済み返信例）→ customerSpecificText に追加
  const contractExamplesPhaseText = contractExamples.length > 0
    ? `\n【成約した会話の実際の返信例（現フェーズ:${convStatus}優先）】\n${contractExampleLines}`
    : "";

  // 優先度2(抜け穴対策): applying_pattern（成約タイミング実績）— aix 選択の明示的判断材料
  type ApplyingPattern = { title: string | null; content: string | null; importance: number | null };
  const applyingPatternKnowledge = (applyingPatternsResult.data ?? []) as ApplyingPattern[];
  const applyingPatternsText = applyingPatternKnowledge.length > 0
    ? `\n【申込到達パターン（applying_pattern・どの場面でどのAIXボタンが効いたかの実績）】\n${applyingPatternKnowledge.map((k) => {
        const title = (k.title ?? "").replace(/\n/g, " ").slice(0, 40);
        // action_flow と key_success_factors を優先抽出して1500字上限で届ける（従来200字では action_flow が欠落）
        let summary: string;
        try {
          const p = JSON.parse(k.content ?? "{}") as Record<string, unknown>;
          const structured = {
            customer_profile: p.customer_profile,
            situation: p.situation_at_key_moment,
            action_flow: p.action_flow,
            turning_point: p.turning_point,
            key_success_factors: p.key_success_factors,
          };
          summary = JSON.stringify(structured).replace(/\n/g, " ");
          if (summary.length > 1500) summary = summary.slice(0, 1500);
        } catch {
          summary = (k.content ?? "").replace(/\n/g, " ").slice(0, 1000);
        }
        return `- ${title}: ${summary}`;
      }).join("\n")}\n※aix キーの選択は、現在の会話が上記パターンのどの「場面」に該当するかを最優先の判断材料にすること。同じ場面なら実績のあるAIXボタン（特に見積書→申込誘導の estimate_sheet ライン）を選ぶ。`
    : "";

  // RAG化 Phase2: 類似ナレッジの選抜。
  // 設計方針: 2レイヤー構造
  //   静的キャッシュ層: principle（importance>=9）・applying_pattern → 全会話共通・キャッシュで低コスト
  //   動的RAG層: 今の会話に類似した成約パターン（contractKnowledge）を含む全カテゴリ → 顧客別に最適化
  // ※ contractKnowledge は静的上位4件をキャッシュで届けつつ、RAGでも除外しない（顧客固有の関連パターンを追加注入）
  // ※この処理は knowledgePrinciples / applyingPatternKnowledge の定義後に置くこと（未定義参照防止）
  const ragAlreadyInjected = new Set<string>([
    ...knowledgePrinciples.map((k) => k.content),
    ...applyingPatternKnowledge.map((k) => k.content ?? ""),
  ]);
  const isAixStateMatch = (state: string | null): boolean =>
    !!state && actionCandidates.some((c) => state === c || state.startsWith(c + "_"));
  const ragKnowledge = ragKnowledgeRaw
    .filter((k) => k.similarity >= 0.55 && !!k.content && !ragAlreadyInjected.has(k.content as string))
    .sort((a, b) => {
      const aAix = isAixStateMatch(a.conversation_state) ? 1 : 0;
      const bAix = isAixStateMatch(b.conversation_state) ? 1 : 0;
      return (bAix - aAix) || (b.similarity - a.similarity);
    })
    .slice(0, 8);
  const ragKnowledgeText = ragKnowledge.length > 0
    ? `\n【関連ナレッジ（この会話に類似する過去の学習・RAG検索）】\n${ragKnowledge.map((k) => `- [${k.category ?? "knowledge"}${k.conversation_state ? `/${k.conversation_state}` : ""}] ${(k.title ?? "").replace(/\n/g, " ").slice(0, 40)}: ${(k.content ?? "").replace(/\n/g, " ").slice(0, 1200)}`).join("\n")}\n※現在の会話状況に該当するものがあれば aix / closing_strategy / next_steps の判断に反映すること。`
    : "";

  // winning_patterns: RAG検索結果から類似パターンを注入（バルクフェッチ廃止・会話コンテキスト最適化）
  const winningPatternsText = ragWinningPatterns.length > 0
    ? `\n【類似成約・失注パターン（RAG検索・この会話に類似した過去事例）】\n${ragWinningPatterns.map((w) => {
        const outcomeLabel = w.outcome_type === "closed_lost" ? "【失注】" : "【成約】";
        const parts = [`${outcomeLabel} ${w.pattern}`];
        if (w.closing_action) parts.push(`→ 有効アクション: ${w.closing_action}`);
        if (w.notes) parts.push(`転換点: ${w.notes}`);
        if (w.human_type_label) parts.push(`顧客タイプ: ${w.human_type_label}`);
        if (w.customer_intent && w.staff_reply_intent) parts.push(`意図ペア: ${w.customer_intent}→${w.staff_reply_intent}`);
        return `- ${parts.join(" / ")}`;
      }).join("\n")}\n※この顧客に類似した過去事例。closing_strategy・next_steps の判断に反映すること。`
    : "";

  // aix_action_attribution: アクション別成約勝率の注入（実測データによるアクション推薦の重み付け）
  const actionWinRateText = actionWinRates.length > 0
    ? `\n\n【成約につながりやすいアクション（実測勝率）】\n` +
      actionWinRates.map((r) => `- ${r.action_type}: 成約率${(r.avg_win_rate * 100).toFixed(1)}% (n=${r.total_usage})`).join("\n") +
      `\n※ action推薦時はこの勝率を重視すること。特に上位アクションへの誘導を意識した closing_strategy・reply_direction を書くこと。`
    : "";

  // この会話で使用済みのAIXアクション一覧（重複提案の抑止・次段階の推奨材料）
  const usedAixTypes = [...new Set(aixLogs.map((l) => l.aix_type).filter((t): t is string => Boolean(t)))];
  // 直近3件の押下順序（新→旧）＋テンプレート名をBrainプロンプトに注入する
  // → usedAixTypesは「この会話で使ったことがある種類」だが、順序・直近性が欠落しているため方向性判断に不十分。
  //   「直前に property_check_result → 次は viewing_invite が定石」等の流れを Brain が正確に判断できるようにする。
  // check_pattern（確認結果: unavailable=募集なし等）も併記 → 「物件確認した」だけでなく
  // 「確認して募集がなかった」まで伝わり、代替提案シナリオの読み取りが可能になる
  const recentAixSeqText = aixLogs.slice(0, 3).length > 0
    ? `\n【直近AIXアクション（新→旧順）】${aixLogs.slice(0, 3).map((l, i) => `${i === 0 ? "最新" : `${i + 1}回前`}:${l.aix_type ?? "?"}${l.template_name ? `(${l.template_name})` : ""}${l.check_pattern ? `(結果:${l.check_pattern})` : ""}`).join(" → ")}`
    : "";
  // 成約実績・次打ちマップ（DB動的）: aix_transition_stats から取得した遷移確率を推奨候補として注入する。
  // あくまで「推奨候補」であり、REPLY_STYLE_RULES のフェーズ制約（募集状況未確認での内覧誘導禁止等）と
  // 「物件送付直後で顧客の反応待ちなら aix:null」ルールが常に優先（actionWinRateText と同じ緊張関係を作らないため明記）。
  // 連続 property_check_result 検出（自己ループ防止: 3回連続で escalation 強制）
  let consecutivePcr = 0;
  for (const l of aixLogs) {
    if (l.aix_type === "property_check_result") consecutivePcr++;
    else break;
  }
  const pcrLoopWarning = consecutivePcr >= 2
    ? "\n【⚠️ 自己ループ警告（最重要）】property_check_result が直近" + consecutivePcr + "回連続しています。同じ物件の確認を繰り返しても会話が前進しません。次のアクションは必ず viewing_invite（内覧誘導）または estimate_sheet（見積書）にエスカレーションしてください。property_check_result の再選択は絶対禁止です。"
    : "";
  const lastAixType = aixLogs[0]?.aix_type ?? null;
  const transitions = lastAixType ? (aixTransitionMap[lastAixType] ?? []) : [];
  const nextActionMapText = lastAixType && transitions.length > 0
    ? `\n【成約実績・次打ちマップ】直近AIXが ${lastAixType} の場合、成約会話では${transitions.slice(0, 3).map(t => `${t.to}が${t.count}回`).join("・")}。※推奨候補。会話の実態（顧客の返信内容・フェーズ制約・募集状況未確認での内覧誘導禁止）と「物件送付直後で顧客の反応待ちなら aix:null」ルールが常に優先。`
    : "";
  const aixHistoryText = (usedAixTypes.length > 0 || pcrLoopWarning)
    ? `${recentAixSeqText}${nextActionMapText}${pcrLoopWarning}\n【会話全体で使用済みのAIXアクション】${usedAixTypes.join(" / ")}\n※既に使用済みのアクションを再提案する場合は理由が必要。原則は次の段階のアクションを提案すること。ただし物件送付直後で顧客の反応がまだ無い場合は aix:null（何も提案しない）が正解。顧客の反応を待たずに viewing_invite 等へ先走らないこと。`
    : pcrLoopWarning;

  // H6(Fable5): 予約送信・未完了タスク・内覧予定を注入（重複提案防止・next_steps の接地）
  type ScheduledMsg = { text: string | null; scheduled_at: string };
  const scheduledMsgs = (scheduledMsgsResult.data ?? []) as ScheduledMsg[];
  const scheduledText = scheduledMsgs.length > 0
    ? `\n【予約送信済みメッセージ（送信待ち${scheduledMsgs.length}件）】\n${scheduledMsgs.map((s) => `- ${new Date(s.scheduled_at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" })}送信予定: ${(s.text ?? "（画像）").replace(/\n/g, " ").slice(0, 120)}`).join("\n")}\n※これらと重複する追客・送信提案はしないこと。`
    : "";

  // 監査FIX(2026-08-20): 直近タスク全体から pending（未完了）と result付き完了タスク（空室確認の回答事実）を分離
  type OpenTask = { task_type: string; status: string; created_at: string; result: string | null; result_note: string | null; resolved_at: string | null };
  const allTasks = (openTasksResult.data ?? []) as OpenTask[];
  const openTasks = allTasks.filter((t) => t.status === "pending").slice(0, 5);
  const taskLabel: Record<string, string> = { property_check: "物件確認（空室確認）", property_send: "物件送付" };
  const TASK_RESULT_LABEL: Record<string, string> = { available: "空室あり（申込可）", taken: "申込済み・埋まった", second_position: "2番手（先行申込あり）", move_out_planned: "退去予定（募集前）" };
  const resolvedWithResult = allTasks.filter((t) => t.status !== "pending" && t.result).slice(0, 3);
  const checkResultsText = resolvedWithResult.length > 0
    ? `\n【空室確認の回答結果（確定事実）】\n${resolvedWithResult.map((t) => `- ${taskLabel[t.task_type] ?? t.task_type}: ${TASK_RESULT_LABEL[t.result ?? ""] ?? t.result}${t.result_note ? `（${t.result_note.slice(0, 60)}）` : ""}`).join("\n")}\n※「募集終了」「申込済み」となった物件について「募集状況を確認します」と言ってはならない（確認済みの確定事実。再言及は誤情報になる）`
    : "";
  // M1: AIX「物件確認した」でスタッフが入力した物件別の空き状況（aix_usage_logs.property_names / prop_statuses）。
  // line_tasks 由来の checkResultsText は「タスク単位の代表1値」しか持たないため、
  // 「3件確認して1件だけ空室」のような物件粒度の確定事実はここでしか供給できない。
  // 同じ物件が複数回確認されている場合は最新ログ（aixLogs は created_at 降順）の状態を採用する。
  const PROP_STATUS_LABEL: Record<string, string> = {
    available: "空室あり（申込可）",
    unavailable: "募集終了",
    vacating: "退去予定（空室予定）",
    alternative: "代替提案物件",
  };
  const propStatusByName = new Map<string, string>();
  for (const l of aixLogs) {
    const names = l.property_names ?? [];
    const statuses = l.prop_statuses ?? [];
    if (!Array.isArray(names) || names.length === 0) continue;
    for (let i = 0; i < names.length; i++) {
      const name = (names[i] ?? "").trim();
      const status = (statuses[i] ?? "").trim();
      if (!name || !status) continue;
      if (!propStatusByName.has(name)) propStatusByName.set(name, status); // 降順なので初出＝最新
    }
  }
  const propAvailabilityText = propStatusByName.size > 0
    ? `\n【物件別空き状況（確定事実・再確認宣言は絶対禁止）】\n${[...propStatusByName.entries()]
        .slice(0, 10)
        .map(([name, status]) => `- ${name}: ${PROP_STATUS_LABEL[status] ?? status}`)
        .join("\n")}\n※上記で「募集終了」の物件について「募集状況を確認します」と言ってはならない`
    : "";

  // M2: 送付済み御見積書の費用情報（aix_usage_logs.estimate_sent / prop_cost_notes）。
  // 「見積書はもう送ってある」「その物件は割引が少なく初期費用が高い」という確定事実が無いと、
  // brain は estimate_sheet を再提案し、返信は「御見積書を作成しお送りします」と二重宣言してしまう。
  const estimateSentLog = aixLogs.find((l) => l.estimate_sent === true);
  const costNotes = aixLogs
    .flatMap((l) => (Array.isArray(l.prop_cost_notes) ? l.prop_cost_notes : []))
    .map((n) => (n ?? "").trim())
    .filter(Boolean);
  const uniqueCostNotes = [...new Set(costNotes)].slice(0, 5);
  const estimateInfoText = estimateSentLog
    ? `\n【御見積書 送付済み（確定事実）】\n- ${new Date(estimateSentLog.sent_at ?? estimateSentLog.created_at).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", timeZone: "Asia/Tokyo" })}に御見積書を同封して送付済み（AIX: ${estimateSentLog.aix_type ?? "?"}）${
        uniqueCostNotes.length > 0 ? `\n【送付済み御見積書の費用情報】\n${uniqueCostNotes.map((n) => `- ${n}`).join("\n")}` : ""
      }\n※「御見積書を作成してお送りします」等の再宣言は禁止（既に送付済み）。費用について聞かれたら上記の金額を根拠に答えること。`
    : "";

  const tasksText = (openTasks.length > 0
    ? `\n【この会話の未完了タスク】${openTasks.map((t) => taskLabel[t.task_type] ?? t.task_type).join(" / ")}\n※next_steps はこれらの未完了タスクを考慮すること。`
    : "") + checkResultsText + propAvailabilityText + estimateInfoText;

  type Viewing = { viewing_date: string; viewing_time: string | null; status: string | null; property_name?: string | null; property_address?: string | null };
  // viewing_history（is_primaryを含む全件）を優先・存在しなければviewingsにフォールバック
  type ViewingHistoryRow = { scheduled_date: string; scheduled_time: string | null; status: string | null; property_name?: string | null; property_address?: string | null };
  const viewingHistoryRows = (viewingHistoryResult.data ?? []) as ViewingHistoryRow[];
  const viewings: Viewing[] = viewingHistoryRows.length > 0
    ? viewingHistoryRows.map(h => ({ viewing_date: h.scheduled_date, viewing_time: h.scheduled_time, status: h.status, property_name: h.property_name ?? null, property_address: h.property_address ?? null }))
    : (viewingsResult.data ?? []) as Viewing[];
  const viewingStatusLabel: Record<string, string> = { scheduled: "予定", done: "完了", cancelled: "キャンセル" };
  let viewingsText = viewings.length > 0
    ? `\n【内覧履歴・予定】${viewings.map((v) => {
        let s = `${v.viewing_date}${v.viewing_time ? ` ${String(v.viewing_time).slice(0, 5)}` : ""}（${viewingStatusLabel[v.status ?? ""] ?? v.status ?? "予定"}）`;
        if (v.property_name) s += ` 物件: ${v.property_name}`;
        if (v.property_address) s += ` 住所: ${v.property_address}`;
        return s;
      }).join(" / ")}`
    : "";
  // 内覧済み顧客の特別扱い（修正5）: 完了内覧がある顧客は対面済み＝申込プッシュ優先
  const completedViewings = viewings.filter((v) =>
    v.status === "completed" || v.status === "done" || v.status === "完了"
  );
  if (completedViewings.length > 0) {
    viewingsText += `\n【内覧済み顧客・重要】\n`;
    viewingsText += `この顧客はスタッフと対面済み（内覧完了: ${completedViewings.length}回）。\n`;
    viewingsText += `対面経験により: ①他社への並行問い合わせが実質終了している ②信頼関係が形成済み ③申込への心理障壁が対面前より大幅に低下。\n`;
    viewingsText += `次の対応指針: 提案物件が条件に合えば viewing_invite より application_push を優先。物件への反応が薄い場合も「弊社で引き続き探す」前提で関係維持。`;
  }

  // H6(Fable5): ホット顧客・スタッフ要対応フラグ
  const flagParts: string[] = [];
  if (opts?.isHot) flagParts.push("ホット顧客（成約意欲高・プッシュ強めOK）");
  if (opts?.isFlagged) flagParts.push("スタッフ要対応フラグあり（自動返信不可・必ずスタッフ対応）");
  const flagsText = flagParts.length > 0 ? `\n【フラグ】${flagParts.join(" / ")}` : "";

  // H4(Fable5): 会話に依存しない静的ブロック（能力マップ・線引きルール・恒久ルール等）を system に分離し
  // prompt caching（ephemeral）を適用。brain-sweep は5分毎バッチのため入力コストを約40-60%削減できる。
  // ※ contractExamplesPhaseText / actionRulesText は convStatus 依存のため user 側（cache無し）に残す
  // キャッシュ2ブロック分割: staticBrainSystem（完全静的・1h）と dynamicBrainSystem（DB由来・5m）を分離。
  // 毎日の学習cronで promptRules / knowledgePrinciples / boundaryRules が更新されても
  // 静的ブロック（15K+トークン）のプレフィックスキャッシュは生き残る。
  const staticBrainSystem = `あなたはスモラAI。与えられた会話履歴を読んで、スタッフが次にすべき1アクションを20字以内で答えてください。必ずJSON形式のみで返してください。

${AIX_CAPABILITY_MAP}

${REPLY_STYLE_RULES}

${PHASE_TEMPLATE_HINTS}

【日付の厳守】closing_strategy・next_steps には会話に実際に出た物件名・日付のみ使用（推測日付の創作禁止）。

回答形式（JSONのみ・説明文・コードブロック不要）:
{"action": "スタッフが次にすべき具体的なアクション（20字以内）", "reason": "その理由（30字以内）", "aix": "上記能力マップのキー1つ。該当なし・物件送付直後等で顧客の反応待ちの場合は null（null は正当な出力であり、無理に何かを提案しない）", "closing_strategy": "この顧客が契約に至るための具体的な戦略を1〜2文で。必ず「〜させて頂きます」「〜する」の行動宣言形で書く（例: 「今日中にご希望条件の物件をピックアップしてお送りします」）。情報提供・受け身文体は禁止。※条件変更（condition_change_type非null）時は変更後の具体条件名（エリア・駅・家賃・設備等）を必ず明記し「その条件で全力ピックアップします」の行動宣言形にすること（「ご希望の条件」「ご希望のご条件」等の抽象表現は禁止）", "template_hint": "次に使うべきAIXテンプレートのラベルカテゴリ名を正確に入れる。必ず次のいずれかの文字列を使うこと（他の表現は禁止）: '物件ピックアップした'（property_send・複数件ピックアップ後）/ '1件特にオススメする'（property_recommendation・1件詳細後）/ '物件確認した（募集状況）'（property_check_result・空室確認の結果報告）/ '申込誘導'（estimate_sheet送付直後・同分〜1分以内の申込促進テンプレート）/ ①申込系ラベル（application_push時。'①申込み時フォーマット（連帯保証人）'・'①申込時フォーマット（緊急連絡先）'・'①緊急連絡先・同居人なし' 等を正確に）/ '内覧日アポ'（内覧日程の打診）/ '直近の日にち'（直近日程の提案）。どのラベルにも当てはまらない場合はnull。トーン説明・文体の感想・フリーテキスト（'プッシュ強め・親身' 等）は絶対に入れない", "next_steps": ["Step1（今すぐ）: 具体的アクション。※条件変更（condition_change_type非null）時のStep1は必ず「変更後の具体条件名（エリア・駅・家賃・設備等を明記）でChrome拡張を使って物件を再検索する」を含めること", "Step2: AIXボタン○○を押す", "Step3: 物件事実系（物件ピックアップ紹介（後続）・駅周辺物件ピックアップ（後続）・1件特にオススメ・【申込誘導】・【全件案内可能】）は『【AIX】○○をAI最適化して送る（AIXクラスター完了1〜2分後・顧客返信を待たない）』、定型追撃系（②申込時フォーマット（続き）・ヒアリング締め・（2番手・申込））は『【AIX】○○をそのまま送る（1分以内・編集不要・AI最適化禁止）』の書式でテンプレートまでセットで提示"], "reply_mode": "aixまたはauto_reply。auto_replyはAIが人の確認なしで送信する。線引きルール該当時・金額/契約/入居日/内覧日程の確定に関わる時・判断に迷う時は必ずaix。雑談や単純な質問への一般返信のみauto_reply", "two_choice_mode": "true または false（boolean）。以下の全条件が揃う場合 true: checkpoint_stage='proposing' かつ 送付済み物件が1件以上ある かつ 顧客の最新メッセージが条件に関するトレードオフ質問（例: '築年数は古くなりますか？' '家賃5万円台だとこの条件は難しいですか？' 'ユニットバスOKでもいいですが室内洗濯機は難しいですか？' '5.5万と6.2万の違いは何ですか？' 'この価格は妥当ですか？'等・現在提案中の物件の条件・価格・設備について納得・比較・トレードオフの判断を求める質問）かつ 顧客が明示的に拒否・離脱していない。→ true の場合、AIXで条件に合う物件を追加オススメするか、テキストで相場や理由を説明するかをスタッフが2択で判断する場面。trueにならないケース: 顧客が「この物件の空室はありますか？」等の募集状況確認をしている場合 / 顧客が新しい検索条件を追加している場合（condition_change_type非null）/ aix=viewing_invite・application_push等の確定アクションがある場合。不明な場合は false に倒す", "reply_direction_label": "two_choice_mode=true の場合のみ設定。返信する場合の方向性を10字以内の日本語で（例: '条件説明' '相場説明' '不安解消' '内覧誘導' '価格の根拠説明'）。two_choice_mode=false の場合は必ずnull", "ai_summary": "この顧客の全文脈ストーリー（経緯・現状・次の必須対応）を200字以内で書く。顧客を知らない人でも状況が分かる詳しさで。", "ai_summary_json": {"situation": "現在状況を15字以内（例: 内覧3物件の日程調整中）", "requirements": ["顧客の要望・こだわり（最大3件・各30字以内・具体的に）"], "opinions": ["顧客の性格・傾向（最大2件・各30字以内・具体的に）"], "winning_pattern": "成約につながる具体的行動を50字以内で。物件名・理由・タイミングを含む。必ず「〜する」「〜させて頂く」の行動宣言形で書く。受け身文体は禁止。※条件変更直後（condition_change_type非null時）は「変更後条件の具体名+全力ピックアップ宣言」の構成が成約につながる（成約データから検証済み）。「ご希望のご条件」等の抽象表現ではなく変更後の具体条件名（エリア・駅・間取り・こだわり等）を明記すること。", "next_action": "今すぐスタッフが打つべき次の1手を40字以内で", "emotion": "前向き/不安/冷めかけ/普通 のいずれか", "urgency": "今月中/3ヶ月以内/半年以上/未確認 のいずれか", "style": "絵文字多用/短文/ビジネスライク/丁寧/普通 のいずれか", "personality_profile": "顧客の人間性・行動パターンを100字以内で", "purchase_signal_level": "none/soft/strong/peak のいずれか。none=購買シグナルなし（挨拶・一般質問・雑談のみ、customer_intent=chat/null含む）/ soft=設備・費用・間取り・審査等の具体的な物件確認質問が1件=本気検討始まりシグナル（customer_questions が1件以上かつ具体的内容）/ strong=異カテゴリ2件以上の質問が重なっている（設備→入居日・費用→審査等）または複数物件の同時比較=申込前の高熱シグナル（customer_questions が2件以上かつ異カテゴリ、またはhesitancy_pattern=undecided）/ peak=申込直前最強シグナル。以下のいずれか1つでも該当したら質問件数に関係なく必ず peak にすること（成約データ分析で判明した盲点シグナル。1件しか質問がなくても soft/strong に落とさない）: ①申込許可伺い=「申し込んでもいいですか？」「一度お申し込みして内覧行きたいです」「抑えるだけ抑えててもいいんですか？」「申し込みするだけして通れば進みたい」「見学して決める形になりますが、それでも申し込みできますか？」等、申込の可否・許可を顧客側から伺ってきた ②物件名指し確定=「待ってください！！ここがいいです！」「○○に決めます」「○○で申請したいと思います」「やはり○○の物件にしようかな」等、特定物件を名指しで選んだ ③金額そのものの復唱=「153,200円ですか😭」「18万ですか😭」「4万台で、お願いします」等、見積・費用の金額をそのまま復唱してきた（落胆の絵文字を伴っても離脱ではなく最終障壁が価格のみのサイン） ④手続き・審査プロセスの具体質問=「保証会社はどこになりますか？」「クレジット払いは可能ですか？どのような流れになりますか」「必要書類は何ですか」等、買う前提の手続き質問 ⑤入居日逆算質問=「いつ入居なりそうですか？」「ここの入居はいつからいけるんですか？」「最長はいつまで伸ばせますか？」 ⑥入居日が具体的な日付・曜日・月で確定している ⑦他の申込者の有無を顧客側から自発的に確認している ⑧customer_questions が3件以上の連続具体質問。判断できない場合は none"}, "reply_direction": "返信の方向性を20字以内で。必ず『〜する』の行動方針形で書く（例: '申込みを前に進める' '内覧日を確定する' '不安を解消して継続する' '物件提案を再開する'）。brainにしかわからないDB知識（内覧履歴・送付済み物件・成約パターン・未完了タスク）から導く。必須フィールド・nullは避ける", "key_topics": ["返信本文に必ず含める実質的内容（最大3件・各30字以内）。挨拶・定型文・トーン指示・抽象的方針は書かない（それらは reply_direction / recommended_tone の役割）。具体的な情報・アクションのみ（例: '本人確認書類送付の催促' '申込みで物件を抑える提案' '空室確認結果の報告'）。該当なければ空配列 []"], "avoid_topics": ["返信で絶対に言及しない語・話題（最大5件・各20字以内）。'来阪' は常に含める。顧客が質問していない費用の話題・直前スタッフ送信で使用済みの緊急表現・文脈に合わないCTA等（例: ['来阪', '見積書', '初期費用']）。理由説明・トーン説明は書かず、禁止する語そのものを書く"], "urgency_appropriate": "true または false（boolean値で出力）。直近のスタッフ送信メッセージ1〜2件（[スタッフ] / [AIX:xxx]）に顧客を急かす危機感・緊急表現（ルール③の表現リスト参照）が含まれていれば false、含まれていなければ true", "recommended_tone": "次の5つの文字列のうち1つだけを正確に出力（組み合わせ・修飾・他の表現は禁止）: '共感的'（顧客が不安・悩んでいる時）/ 'テキパキ'（忙しそうな顧客・手続き系の返信）/ '慎重'（費用・審査・契約等の重要事項を扱う時）/ '明るく前向き'（物件が見つかった・内覧確定等の好機）/ '普通'（どれにも当てはまらない場合）", "customer_questions": ["顧客の最新メッセージに含まれる質問・確認事項を全て列挙（最大5件・各40字以内・質問の意図が分かる形で）。過去メッセージの質問は含めない。質問がなければ空配列 []"], "repeated_concern": "顧客が会話全体で繰り返し確認しているテーマを短句で（例: '費用' '審査' 'キャンセル'）。会話履歴・前回セーブデータで2回以上登場した話題のみ。なければnull", "current_property": "現在話題の中心になっている物件名・号室（例: 'ライオンズ渋谷401'）。会話履歴または【送付済み物件】に実際に登場した表記を一字一句そのまま使う（創作・言い換え・要約禁止）。特定できなければnull", "condition_change_type": "顧客の最新メッセージで検索条件の変更・追加・緩和、または物件ピックアップ依頼があったか。次のいずれか1つの文字列のみ: 'area_change'（エリア変更）/ 'rent_change'（家賃変更）/ 'layout_change'（間取り変更）/ 'equip_add'（設備・収納・こだわり条件の追加。WIC広め・SIC・南向き・オートロック・駐車場付き・ガレージ・ペット可等。【重要】「駐車場付きのお部屋がないか」「駐車場付きで探して」等は equip_add。現在提案中の物件の設備確認ではなく、新しい設備条件での物件探しの依頼 → aix は property_send が正解。絶対に property_check_result・acknowledge_check を選ばないこと）/ 'condition_relax'（条件緩和・拡大）/ 'pickup_request'（物件を送って・ピックアップ依頼・おすすめ依頼）/ 'multi'（複数変更）。なければnull。※すでに検討中の物件があっても新しい条件を追加したら必ず種別を返す。※【お客様の希望条件】（DB登録済み条件）と同じ内容の再言及は変更ではない", "hesitancy_pattern": "顧客が決断を保留するパターンを最新メッセージで示しているか。'thinking'（検討します）/ 'callback'（また連絡します）/ 'waiting'（少し待ってほしい）/ 'undecided'（複数物件で迷い）/ 'timeline'（○月に決めたい）のいずれか1つ。なければnull", "future_timeline": "顧客が示した具体的な決断・申込タイムライン（例: '9月上旬'）。会話に実際に出た表現のみ（推測日付の創作禁止）。urgencyフィールドと矛盾させない。なければnull", "checkpoint_stage": "会話の実態フェーズ。hearing(ヒアリング中)・proposing(物件提案中)・applying(申込検討中〜申込書提出)・contract(契約済み)のいずれか。conversations.statusやconversation_checkpointsの内容、メッセージの文脈を総合して判断。判断できない場合はnull。", "customer_intent": "お客様の今回の問い合わせ意図。次のいずれか1つ: question(疑問・確認質問―答えるだけでOK) / consultation(相談・アドバイス求め―選択肢提示) / desire(希望・条件・要望の表明―受け止め→提案) / decision(申込・内見・決定の意思表示―次ステップ案内) / positive(物件や提案への前向き反応―背中を押す) / negative(懸念・不安・否定的反応―解消してから次へ) / chat(雑談・一言―軽い返し)。当てはまるものがなければnull。※条件変更ルール（最重要）:最新メッセージにエリア・家賃・間取り・こだわり等の変更・追加・緩和が明示されている場合は、他のintent種別との競合に関係なく必ずdesireに設定すること（condition_change_typeと同一判定基準。フェイルクローズはnullではなくdesireに倒すこと）", "latent_intent": "お客様の送信動機・潜在意識の推論（20〜50字の自由記述）。次の3視点を総合して1文で言語化する: ①なぜ今このタイミングでこのメッセージを送ってきたのか（背景・きっかけ）を推測する ②表面的な質問の裏にある本当の懸念・不安・期待を推測する（例: 築年数を聞く→きれいな部屋への期待 / 初期費用を聞く→予算ギリギリの不安 / 審査を遠回しに確認→審査に落ちる不安） ③会話パターンから心理状態を読む（沈黙後の突然の質問→他社比較・状況変化の可能性 / 返信が短くなった→温度低下や多忙 / 同じ質問の繰り返し→説明が腹落ちしていない不安）。会話履歴に根拠がなく推測できない場合はnull（創作禁止）。※条件変更時の補足（condition_change_type非null時）:latent_intentには「複数回条件を変更しているが物件探しへの意欲は本物。変更を歓迎し新条件で即動くスタンスを明示することで信頼が積み重なり成約につながる」という趣旨を含めること", "engagement_stance": "今この局面で「押す」べきか「待つ」べきかの姿勢。'push' / 'wait' / null のいずれか1つだけを出力する。'wait'（押してはいけない局面）= ①直前AIXアクションが property_recommendation または property_check_result であり、顧客の最新メッセージが感謝・了承のみ（60字未満・質問・要望・懸念なし）の場合（ルール⑧の局面＝強推し直後の待ちフェーズ）／②直前スタッフ発言または直近3メッセージ以内の顧客発言に「断り」「キャンセル」「できません」「否決」「募集終了」「申し訳」「残念」「難し」等のネガワードがある直後（ルール⑦の局面）。'push'（背中を押すべき局面）= purchase_signal_level が 'strong' または 'peak' であり、かつ顧客がまだ迷っている・質問を重ねている（hesitancy_pattern が非null、または customer_questions が1件以上）場合。上記いずれにも当てはまらない場合は null（デフォルト）。判断に迷ったら null に倒す。※'wait' を出した場合、返信側では購買シグナル強度によるクロージング指示（希少性訴求・CTA・申込期限の明示）が全て無効化される。押しの強さより局面判定が優先される設計であり、'wait' と 'push' を同時に成立させてはならない（ルール⑦・⑧が成立するなら purchase_signal_level が peak でも必ず 'wait'）"}

【差分分析モード】userプロンプトに【前回の分析結論】がある場合、それを仮説として参照してよい。新着メッセージが前回結論を変えない場合は前回結論をほぼ維持してJSON出力してよい。ただし申込・内見確定・キャンセル・条件変更・フェーズ遷移のシグナルがあれば前回結論を破棄して再判断すること。JSONは常に全フィールド完全出力（ai_summary/ai_summary_json含む）。ただし customer_questions・repeated_concern・current_property・condition_change_type・hesitancy_pattern・future_timeline・key_topics・customer_intent・latent_intent・engagement_stance の10フィールド（message-local分析）は前回結論を引き継がず、必ず今回の新着メッセージから毎回ゼロから再判定すること（前回の質問リスト・保留パターン・前回の物件名や日付を含む必須内容の再掲は禁止）。purchase_signal_level は累積シグナル（message-localではない）。前回値を継承しつつ今回の新着メッセージのシグナルで更新すること（soft→strong への昇圧はするが、strong→none への突然の降格は禁止。会話全体でシグナルを積み上げる設計）。key_topicsは今回のメッセージ文脈から本当に必要な内容のみ。前回送った物件の空き日付・案内可能日など文脈が変わった情報は絶対に引き継がない。

【reply_direction / key_topics / avoid_topics / urgency_appropriate / recommended_tone 判断ルール（5品質ルール）】
以下の5ルールを厳守して新フィールドに反映すること。判定に迷ったら各ルールの「迷った時」の指示に従う:

ルール①（稀少物件）: スタッフ送信の物件情報・チェックポイント・DB事実に「残り1部屋」「残り僅か」「あと1件」「1件のみ」「他にも検討中の方がいる」等の稀少性を示す記述がある場合 → key_topics に「申込みで物件を抑える提案」を追加し、reply_direction を「申込みを前に進める」にする（成約最短ルートを優先）。注意: 顧客側の発言（「1件だけ見たい」等）や既に申込済みの物件は稀少性の根拠にしない。迷った時: 稀少性が事実として確認できなければ適用しない。

ルール②（費用質問なし）: 顧客の最終メッセージに費用への質問（「見積書」「見積り」「初期費用」「総額」「いくら」「幾ら」「費用」「金額」のいずれか）が含まれない場合 → avoid_topics に「見積書」「初期費用」を追加する（顧客が聞いていない費用情報を自発的に話題にしない）。逆に顧客が費用を明示的に質問している場合・過去の費用質問にまだ回答していない場合は、絶対に avoid_topics に費用系の語を入れない（質問に答えないのは致命的な失礼）。また見積送付そのものが今回の推奨アクションの場合も入れない。迷った時: 追加しない側に倒す（コード側でも強制されるため過剰適用しない）。

ルール③（緊急表現使用済み）: 直近のスタッフ送信メッセージ（[スタッフ] または [AIX:xxx] の最新1〜2件・概ね3日以内のもの）に、顧客を急かす表現 —「今なら」「今しか」「お早めに」「早い者勝ち」「先着」「残り◯室」「あと◯件」「埋まってしまう」「なくなる前に」— のいずれかが含まれる場合 → urgency_appropriate=false にする（同じ危機感表現の連発は逆効果で信頼を失う）。注意: スタッフ自身の行動を表す「すぐお調べします」「すぐ確認します」等は緊急表現ではない（顧客を急かしていない）。迷った時: その表現が顧客を急かす目的かどうかで判定する。

ルール④（未完了依頼の催促）: 直近のスタッフ送信メッセージに顧客への依頼（「〜を送ってください」「〜をご確認ください」「〜をお願いします」「〜をご共有ください」「〜を教えてください」等）があり、かつその依頼より後の顧客メッセージ・画像送信に該当する提出・回答がまだ無い場合 → key_topics に「[依頼内容の名詞]の確認・催促」を具体的に追加する（例: 「本人確認書類送付の催促」「内覧希望日の回答確認」。催促しないと会話が止まる）。注意: 顧客が既に対応済みの依頼を催促するのは二重催促で失礼 — 依頼以降の顧客メッセージを必ず確認してから判定する。迷った時: 対応済みか不明なら「◯◯のご状況の確認」のような柔らかい表現にする。

ルール⑤（来阪表現禁止・常時）: avoid_topics には必ず「来阪」を含める。顧客が大阪在住か否かを問わず常時適用する（大阪以外在住の顧客への「来阪ください」は失礼であり、スモラのブランドルール上絶対禁止。コード側でも強制されるがLLM出力でも必ず含めること）。

ルール⑥（感謝・了承への返し方）: 顧客の最新メッセージが感謝・了承のみ（「ありがとうございます」「よろしくお願いします」「わかりました」「了解」「承知」「かしこまりました」等、60字未満かつ質問・要望・懸念を含まない）の場合 → reply_direction を「感謝を1行で受け取り、既に完了した・または今から実行する具体アクションを1つだけ添える（合計50〜130字）。中身のない進捗テンプレ・条件の再ヒアリングで埋めない」にする。**aix フィールドは null にする（直前と同じAIXアクションを繰り返さない・感謝返し場面でスタッフがAIXボタンを押す必要はない）**。成約会話の実データでは感謝返しへの物件提案・見積提案は68%含まれており悪反応は1.6%のみ — 物件提案そのものは禁じない。禁じるべきは「予告だけで実体のない進捗テンプレ（急いで進めております等）」「条件の再ヒアリング（予算・間取りの再質問）」「検討依頼の繰り返し」。avoid_topics にこれらを追加する。直前スタッフ発言に既に「ご検討ください」がある場合は特に厳守（繰り返しはしつこさになる）。迷った時: メッセージに質問・要求が1つでもあればこのルールを適用しない。

ルール⑦（ネガ文脈の感謝には営業を一切乗せない）: 直前スタッフ発言または直近顧客発言に「断り」「キャンセル」「できません」「否決」「募集終了」「申し訳」「残念」「難し」等が含まれる場合 → reply_direction を「受け止めのみ（50〜110字）」にする。avoid_topics に「物件提案」「見積提案」「申込誘導」を追加する。key_topics は空にする。成約会話分析でこの文脈での営業は最も高い離脱率につながっている。迷った時: ネガワードが直近3メッセージ以内にあれば適用する。

ルール⑧（強推し直後の了承には再推奨しない）: 直前AIXアクションが property_recommendation または property_check_result（空き確認済み）であり、かつ顧客の最新メッセージが感謝・了承のみ（「かしこまりました」「ありがとうございます」等、60字未満・質問・要望なし）の場合 → reply_direction を「感謝を1行で受け取り、検討を見守る待ちの姿勢で締める（50〜110字）」にする。aix は null にする（直前と同じAIXアクションを繰り返さない）。avoid_topics に「他物件の募集状況確認」「新規物件ピックアップ」「別物件の提案」「申込誘導」を追加する。key_topics は空にする。根拠: 強く1件を推した直後にさらに推す・別物件を探すと「しつこさ」になり離脱率が上がる。顧客が了承した時点でボールは顧客側にある。待つことが最善。迷った時: 直近AIX履歴に property_recommendation/property_check_result があり顧客が感謝・了承を返したら必ず適用する。

（共通品質基準）reply_direction は返信全体をその1点に収束させる軸であり key_topics と矛盾させない。avoid_topics と key_topics に同じ話題を入れない（矛盾した場合は key_topics を優先し avoid_topics から外す）。

【message-local分析ルール（customer_questions〜future_timelineの6フィールド）】
- この6フィールドは必ず「最新の顧客メッセージ」を基準に判定する。数日前のメッセージの質問・保留表現を今回の結果に含めない
- condition_change_type と hesitancy_pattern は確信が持てない場合 null に倒す（誤検出は誤った返信テンプレートを強制発火させるため、フェイルクローズが正しい）
- current_property は号室まで分かる場合は号室まで書く。複数物件が話題の場合は最新メッセージで言及された1件のみ
- customer_questions は件数に関係なく（1件でも）適切に検出・列挙する。以下の質問タイプを必ず customer_questions に含める:
  ① 物件の一般的な傾向・相場感（「築年数は古くなりますか？」「この家賃だと駅近は難しいですか？」等）
  ② 契約・審査・費用の仕組みに関する質問（「保証会社はどこですか？」「礼金って何ですか？」等）
  ③ 弊社のサービス・仕組みに関する質問（「なぜ初期費用が安いのですか？」等）
  ④ 物件の具体的な情報確認（「この物件の空室状況は？」「退去日はいつですか？」等）
  ⑤ お客様が「〜ますか？」「〜でしょうか？」「〜かな」「〜教えてください」「〜知りたい」等で締める文
  ① ③はAIが直接答えてよい一般知識質問（確認不要）、④は管理会社確認が必要な個別情報質問として分類`;

  // DB由来の動的system部分（promptRules / knowledgePrinciples / boundaryRules）。
  // 各テキストは非空時に先頭 \n 付きで生成されるため trim してから結合する。
  // 学習cronによる日次更新でここだけキャッシュが破棄される（5m TTL）。
  const dynamicBrainSystem = [promptRulesText, knowledgeText, boundaryText]
    .map((t) => t.trim())
    .filter(Boolean)
    .join("\n\n");

  // インクリメンタル分析: 前回の分析結論をコンテキストとして注入
  const prevMetaText = opts?.prevMeta ? (() => {
    const pm = opts.prevMeta!;
    const parts: string[] = ["【前回の分析結論（差分更新の起点として参照）】"];
    if (pm.action) parts.push(`推奨アクション: ${pm.action}`);
    if (pm.note) parts.push(`ノート: ${pm.note}`);
    if (pm.closing_strategy) parts.push(`クロージング戦略: ${pm.closing_strategy}`);
    if (pm.template_hint) parts.push(`テンプレートヒント: ${pm.template_hint}`);
    if (pm.next_steps?.length) parts.push(`次のステップ: ${pm.next_steps.join(" / ")}`);
    if (pm.reply_mode) parts.push(`返信モード: ${pm.reply_mode}`);
    // 4フィールド: incremental分析で前回の返信方向・禁止トピックのコンテキストを維持
    // （注入しないと差分モードのたびにゼロから再推論され方向性が揺れる）
    // ※ key_topics は message-local リセット対象のため注入しない（前回の物件名・日付が汚染するバグ防止）
    if (pm.reply_direction) parts.push(`返信の方向性: ${pm.reply_direction}`);
    if (pm.avoid_topics?.length) parts.push(`言及禁止: ${pm.avoid_topics.join(" / ")}`);
    if (pm.urgency_appropriate === false) parts.push("緊急表現: 前回判定で使用不可（直近スタッフ送信で使用済み）");
    if (pm.recommended_tone) parts.push(`推奨トーン: ${pm.recommended_tone}`);
    if (pm.purchase_signal_level && ["soft", "strong", "peak"].includes(pm.purchase_signal_level)) parts.push(`購買シグナル（前回蓄積）: ${pm.purchase_signal_level}（この強度は維持・または新着メッセージのシグナルで更新すること。none に戻さない限りリセット禁止）`);
    const pmNgProps = (pm.property_search_params as { ng_properties?: Array<{ property_name: string; room_no: string }> } | null)?.ng_properties;
    if (pmNgProps?.length) {
      const ngNames = pmNgProps.map((p) => p.property_name + (p.room_no ? " " + p.room_no : "")).join("、");
      parts.push("NG物件（前回確定・再提案禁止）: " + ngNames + "（この情報はリセット禁止。必ず引き継ぐこと）");
    }
    const pmNgPoints = (pm.property_search_params as { ng_points?: string } | null)?.ng_points;
    if (pmNgPoints) parts.push("NG条件（前回確定）: " + pmNgPoints + "（この情報はリセット禁止）");
    if (pm.human_type_label) parts.push("顧客タイプ（前回確定）: " + pm.human_type_label + "（この情報はリセット禁止。顧客の本質的な性格・行動パターンを示す。必ず引き継ぐこと）");
    return parts.join("\n") + "\n\n";
  })() : "";

  // プロンプトキャッシュ設計:
  //   system[0]（ephemeral 1h）= ハードコード定数のみ（完全静的・学習cronの影響を受けない）
  //   system[1]（ephemeral 5m）= DB由来の恒久ルール（promptRules / knowledgePrinciples / boundaryRules）
  //   user[0] stableKnowledge = 現在空。DB動的データは全て user[1] へ移動済み。
  //     ・contractPatterns / applyingPatterns → バルクフェッチ廃止・match_reply_knowledge RAGが全カテゴリ検索
  //     ・winningPatterns → match_winning_patterns RAGに移行（会話コンテキスト最適化）
  //     ・templates → match_templates RAGに移行（会話フェーズ最適化・use_count/won_count更新でのキャッシュ破棄解消）
  //   user[1] customerSpecific（cache無し）= 上記DB動的データ + 顧客固有データ + 会話履歴
  const stableKnowledgeText = ``;
  const customerSpecificText = `${prevMetaText}${winningPatternsText}${actionWinRateText}${templatesText}${actionRulesText}${contractExamplesPhaseText}${statusText}${timingText}${flagsText}${aixHistoryText}${condText}${profileText}${aiSummaryNote}${scheduledText}${tasksText}${viewingsText}${examplesText}${checkpointText}${ragKnowledgeText}${sentPropsText}${propertySearchText}

会話履歴（[AIX:xxx 日付]=AIXツールxxxで送信済み / [AIX 日付]=AIX送信(種別不明) / [スタッフ 日付]=手動送信 / [顧客 日付]=顧客メッセージ）:
${history}`;

  const maskedStableText = maskPII(stableKnowledgeText, [opts?.customerName]);
  const userContent = [
    // 空のtextブロックはAPIエラーになるため、安定知識が空の場合はブロックごと省略
    ...(maskedStableText.trim()
      ? [{ type: "text" as const, text: maskedStableText, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } }]
      : []),
    { type: "text" as const, text: maskPII(customerSpecificText, [opts?.customerName]) },
  ];

  try {
    const response = await client.messages.create({
      model: BRAIN_MODEL,
      max_tokens: 4000,
      thinking: { type: "disabled" },
      system: [
        // ブロック[0]: 完全静的（冒頭指示・AIX_CAPABILITY_MAP・REPLY_STYLE_RULES・PHASE_TEMPLATE_HINTS・JSONスキーマ等）→ 1h キャッシュ
        {
          type: "text" as const,
          text: staticBrainSystem,
          cache_control: { type: "ephemeral" as const, ttl: "1h" as const },
        },
        // ブロック[1]: DB由来動的部分（promptRules + knowledge + boundary）→ 5m キャッシュ
        // 学習cronで更新されてもブロック[0]のプレフィックスキャッシュは無傷。
        // 空のtextブロックはAPIエラーになるため、空の場合はブロックごと省略。
        ...(dynamicBrainSystem
          ? [{
              type: "text" as const,
              text: dynamicBrainSystem,
              cache_control: { type: "ephemeral" as const, ttl: "5m" as const },
            }]
          : []),
      ],
      messages: [{ role: "user", content: userContent }],
    });

    // キャッシュHIT/MISS ログ（Vercelログで確認可能・コスト診断用）
    const usageAny = response.usage as unknown as Record<string, number>;
    const cacheRead = usageAny.cache_read_input_tokens ?? 0;
    const cacheCreation = usageAny.cache_creation_input_tokens ?? 0;
    const inputTokens = response.usage.input_tokens ?? 0;
    if (cacheRead > 0) {
      console.log(`[brain-core] cache HIT  conv=${conversationId} read=${cacheRead} input=${inputTokens}`);
    } else {
      console.log(`[brain-core] cache MISS conv=${conversationId} created=${cacheCreation} input=${inputTokens}`);
    }

    // claude-sonnet-5 はextended thinkingを使うためcontent[0]がthinking型になることがある
    // content.find()でtextブロックを確実に取得する
    const raw = response.content.find((c) => c.type === "text")?.text ?? "";
    // M2(Fable5): 最初の { 〜 最後の } を抽出（旧 non-greedy 正規表現は最初の } で切れる罠があった）
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace <= firstBrace) {
      console.warn("[brain-core] analyzeConversation abort: Claude returned no JSON", conversationId,
        "stop_reason:", response.stop_reason,
        "content_len:", response.content.length,
        "content[0]_type:", response.content[0]?.type ?? "undefined",
        "raw:", raw.slice(0, 300));
      return null;
    }
    const jsonMatch = [raw.slice(firstBrace, lastBrace + 1)];

    const parsed = JSON.parse(jsonMatch[0]) as {
      action?: string;
      reason?: string;
      aix?: string | null;
      closing_strategy?: string;
      template_hint?: string;
      next_steps?: string[];
      reply_mode?: "aix" | "auto_reply";
      two_choice_mode?: boolean;
      reply_direction_label?: string | null;
      reply_direction?: string | null;
      key_topics?: string[];
      avoid_topics?: string[];
      urgency_appropriate?: boolean;
      recommended_tone?: string | null;
      customer_questions?: string[];
      repeated_concern?: string | null;
      current_property?: string | null;
      condition_change_type?: string | null;
      hesitancy_pattern?: string | null;
      future_timeline?: string | null;
      checkpoint_stage?: "hearing" | "proposing" | "viewing" | "applying" | "contract" | null;
      customer_intent?: "question" | "consultation" | "desire" | "decision" | "positive" | "negative" | "chat" | null;
      latent_intent?: string | null;
      // M4: 押す／待つの局面軸（enumゲートで "push" | "wait" 以外は null に落とす）
      engagement_stance?: string | null;
    };

    // brain-core統合: ai_summary + ai_summary_json をproperty_customersに保存（fire-and-forget）
    // これにより customer-summary 別プロセスが不要になる（Sonnet 5 1回で両方を生成）
    const brainSummaryText = (typeof (parsed as Record<string, unknown>).ai_summary === "string")
      ? ((parsed as Record<string, unknown>).ai_summary as string).trim().slice(0, 2000)
      : "";
    const brainSummaryJson = (typeof (parsed as Record<string, unknown>).ai_summary_json === "object" && (parsed as Record<string, unknown>).ai_summary_json !== null)
      ? (parsed as Record<string, unknown>).ai_summary_json
      : null;
    if (propertyCustomerId && (brainSummaryText || brainSummaryJson)) {
      after(async () => {
        try {
          await supabase
            .from("property_customers")
            .update({
              ...(brainSummaryText ? { ai_summary: brainSummaryText } : {}),
              ...(brainSummaryJson ? { ai_summary_json: brainSummaryJson } : {}),
              ai_summary_at: new Date().toISOString(),
            })
            .eq("id", propertyCustomerId);
        } catch (e) {
          console.warn("[brain-core] ai_summary save failed:", propertyCustomerId, e instanceof Error ? e.message : e);
        }
      });
    }

    // Use a canonical action key from AIX_BRAIN_NOTES if Haiku returned one we recognise.
    // If the aix value is unknown or null, fall back to empty string so the row still gets saved.
    // 2026-08 AIXボタン種別アナウンス改善: 完全一致だけでなく normalizeAixActionKey で
    // 語彙近傍の出力（"acknowledge_result"・日本語ラベル・「AIX【見積書送る】で〜」等）も
    // 正準キーへ正規化する。従来はこれらが全て action=""（ボタン特定不能）に落ちていた。
    let finalAix: string | null = normalizeAixActionKey(parsed.aix);
    // Case1対策（決定論的矯正・プロンプト任せにしない）:
    // suggested_aix_button は brainAix（Haiku提案）＞ signalAix の優先構造のため、
    // プロンプト側の「送付0件→property_search」誘導で Haiku が property_search を返すと
    // detectSignalBasedAixFallback の信号6.5 に到達しない。顧客が直近3日以内に物件条件を
    // 能動的に問い合わせている場合はコード側で property_send に矯正する。
    // 3日制限は、7日沈黙後の正当な property_search 提案（信号7・★★★）を壊さないため。
    if (
      finalAix === "property_search" &&
      lastCustomerMsg?.text &&
      daysSinceLastCustomerMsg !== null &&
      daysSinceLastCustomerMsg <= 3 &&
      PROPERTY_CONDITION_INQUIRY_RE.test(lastCustomerMsg.text)
    ) {
      finalAix = "property_send";
    }
    // 構造化条件フォーム送信対策（決定論的矯正）:
    // 顧客が【ご希望の家賃】⇒〇万 / 【初期費用の限度額】⇒〇万 等の整理済みヒアリングシートを送付した場合、
    // Haiku が「初期費用」を見積書依頼と誤認して estimate_sheet を返すことがある。
    // 【〇〇】⇒ 形式の構造化フォームは物件条件の伝達であり property_send が正解。
    // また hearing フェーズの初回条件問い合わせも同様に矯正する（PROPERTY_CONDITION_INQUIRY_RE）。
    if (
      finalAix === "estimate_sheet" &&
      lastCustomerMsg?.text &&
      daysSinceLastCustomerMsg !== null &&
      daysSinceLastCustomerMsg <= 3 &&
      (/【[^】]{2,15}】[^。！\n]{0,5}[⇒→＝:：]/.test(lastCustomerMsg.text) ||
        (PROPERTY_CONDITION_INQUIRY_RE.test(lastCustomerMsg.text) &&
          !/(見積|総額|いくら|内訳|費用.{0,6}(教|知|詳|いくら)|？|\?)/.test(lastCustomerMsg.text)))
    ) {
      finalAix = "property_send";
    }
    // 画像のみ送信対策（決定論的矯正・プロンプト任せにしない）:
    // 顧客がテキストなしで画像だけを送ってきた場合（messages上は "[画像]" プレースホルダー）、
    // Haiku には画像の中身が見えないため acknowledge_check（物件画像想定）へ倒れがちだが、
    // 実運用では見積書スクショ送付が最多。直近3日以内の画像のみ送信で、
    // finalAix が acknowledge_check または null の場合は estimate_sheet に矯正する。
    // ※クオリティゲート（採択率<30%抑制）の前に置くこと。後に置くと矯正がゲートを素通りする。
    // 監査FIX(2026-08-20): messages.image_type（Vision分類）が物件系画像（物件写真/間取り図）を
    // 示す場合は矯正しない（acknowledge_check=空室確認が正解の局面。盲目仮定は未分類時のみ適用）
    if (
      (finalAix === "acknowledge_check" || finalAix === null) &&
      lastCustomerMsg?.text &&
      /^\[画像\]/.test(lastCustomerMsg.text) &&
      daysSinceLastCustomerMsg !== null &&
      daysSinceLastCustomerMsg <= 3 &&
      lastCustomerMsg.image_type !== "property_photo" &&
      lastCustomerMsg.image_type !== "floor_plan"
    ) {
      finalAix = "estimate_sheet";
    }
    // AIXボタン種別アナウンス改善(2026-08): LLMがボタンを特定できなかった場合、
    // 信号ベース決定論（detectSignalBasedAixFallback）でボタン種別を判定して action を埋める。
    // 従来この判定結果は conversation_direction.suggested_aix_button のみに使われ、
    // suggested_aix_meta.action は ""（note=LLM生文字列）のまま保存されていたため、
    // ホット会話（内覧希望・金額質問・空室確認依頼）でスタッフに「どのボタンを押すか」が
    // 一切届かない構造だった（実会話調査: きえ/ひろろ/reina 全件で meta 空白のまま手打ち対応）。
    // ここで判定することで後段の内覧誤提案ガード・品質ゲート・first_reply例外は従来どおり全て適用される。
    // 二重実行回避(2026-08): この判定の実行済みフラグと結果を meta 経由で
    // analyzeAndSaveBrainMeta の conversation_direction 更新へ持ち回る（再実行=6クエリの重複を解消）
    let signalAixRan = false;
    let signalAixResult: string | null = null;
    if (finalAix === null) {
      const fallbackPhase = ((): "hearing" | "proposing" | "viewing" | "applying" => {
        const cs = typeof parsed.checkpoint_stage === "string" ? parsed.checkpoint_stage : null;
        if (cs === "hearing" || cs === "proposing" || cs === "viewing" || cs === "applying") return cs;
        if (phaseEstimate === "hearing" || phaseEstimate === "proposing" || phaseEstimate === "viewing" || phaseEstimate === "applying") return phaseEstimate;
        return "proposing";
      })();
      const signalAix = await detectSignalBasedAixFallback(conversationId, propertyCustomerId, fallbackPhase);
      signalAixRan = true;
      signalAixResult = signalAix && AIX_BRAIN_NOTES[signalAix] ? signalAix : null;
      if (signalAixResult) finalAix = signalAixResult;
    }
    // 内覧誤提案ガード（決定論的矯正・プロンプト任せにしない）:
    // viewing_invite は「顧客の反応」が前提のアクション。①最終メッセージがスタッフ送信
    // （＝物件送付・返信直後で顧客の反応待ち）、または②最終物件送付以降に顧客メッセージが
    // 無い場合は提案しない（finalAix=null）。顧客が返信すれば webhook 経由の再分析で
    // このガードを通過し、正当な viewing_invite は従来どおり提案される。
    // スタッフ送信の物件情報内「〇月〇日以降ご内覧可能」等の文言がLLM出力経由で
    // viewing_invite に収束する誤爆もここで吸収する。
    if (finalAix === "viewing_invite") {
      const lastMsgIsCustomer = typedMessages[0]?.sender === "customer"; // messagesは新しい順
      const lastPropSendLog = aixLogs.find(
        (l) => l.aix_type === "property_send" || l.aix_type === "property_recommendation",
      ) ?? null; // aixLogsは created_at 降順 → find = 最新の物件送付ログ
      const lastPropertySentAt = [pc?.last_property_sent_at, lastPropSendLog ? (lastPropSendLog.sent_at ?? lastPropSendLog.created_at) : null]
        .filter((t): t is string => Boolean(t))
        .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
        .pop() ?? null;
      const customerRespondedAfterSend = !lastPropertySentAt ||
        Boolean(lastCustomerMsg && new Date(lastCustomerMsg.created_at).getTime() > new Date(lastPropertySentAt).getTime());
      if (!lastMsgIsCustomer || !customerRespondedAfterSend) {
        finalAix = null;
      } else if (MOVE_OUT_PATTERN.test(typedMessages.map((m) => m.text ?? "").join("\n"))) {
        // 退去予定/入居中物件では現地内覧不可（旧 redirectMoveOut 相当）:
        // Haiku 提案がガードを通過して viewing_invite に確定する場合でも、
        // 会話履歴（スタッフ送付の物件情報を含む直近15件）に退去予定/入居中の記述があれば
        // 申込で部屋を先押さえする application_push へ差し替える。
        finalAix = "application_push";
      }
    }
    // Quality gate: suppress AIX suggestions with < 30% acceptance rate over 10+ samples.
    // FIX(Fable5 #3): 自経路の採択率キー（:brain 等）を読む。旧実装は :analysis_step1 固定で
    // 他コンポーネントの統計をゲートに使っており、脳の自己修正が一度も機能していなかった。
    // 採択率は後段の enforcement_level 降格ゲートでも再利用するため外側スコープに保持する
    let acceptRateOcc = 0;
    let acceptRateConf = 1;
    // ゲート抑制フラグ: 「品質ゲートによる null」を他の null 理由（初回接触 null 化・提案なし）と
    // 明確に区別して meta で伝搬する。analyzeAndSaveBrainMeta の direction 更新側は
    // このフラグが true の場合のみ detectSignalBasedAixFallback を丸ごとスキップし、
    // 抑制済み低品質アクションの suggested_aix_button への復活（ゲートバイパス）を塞ぐ。
    let aixSuppressedByAcceptRate = false;
    if (finalAix) {
      const { data: rateData } = await supabase
        .from("trigger_action_rules")
        .select("confidence, total_occurrence")
        .eq("keyword", `SOURCE_ACCEPT_RATE:${finalAix}:${source}`)
        .eq("action_type", finalAix)
        .maybeSingle();
      if (rateData) {
        acceptRateOcc = (rateData.total_occurrence as number | null) ?? 0;
        acceptRateConf = (rateData.confidence as number | null) ?? 1;
        if (acceptRateOcc >= 10 && acceptRateConf < 0.3) {
          finalAix = null;
          aixSuppressedByAcceptRate = true;
        }
      }
    }
    // B2(Fable5): reply_mode のフェイルクローズ強制（コード側で決定的に上書き — プロンプト任せにしない）
    // 旧実装は線引きルール0件時に Haiku が auto_reply へ倒れる「安全側でない」デフォルトだった
    let replyMode: "aix" | "auto_reply" | undefined =
      (parsed.reply_mode === "aix" || parsed.reply_mode === "auto_reply") ? parsed.reply_mode : undefined;
    if (finalAix) replyMode = "aix";                       // AIX提案がある時点でスタッフ操作前提
    if (!boundaryText) replyMode = "aix";                  // 線引きルール取得失敗/0件時はフェイルクローズ
    if (opts?.autoSendEnabled === false) replyMode = "aix"; // auto_send無効の会話に auto_reply を提案しない
    // 診断修正: isFlagged によるフェイルクローズは削除。line-webhook が受信毎に is_flagged=true を
    // 立てるため実質全未返信会話で発動し、条件として形骸化していた（他3条件のフェイルクローズは維持）

    // 初回例外: スタッフのテキスト送信がまだ1件も無い会話（真の初回）は
    // reply_mode と AIX提案を出さない。generate-reply の初回挨拶ドラフト生成が最優先。
    // generate-reply/route.ts の deriveSuggestedAix first_reply 例外と同じ設計意図。
    // auto_send_enabled=NULL → ?? false でフェイルクローズしてしまうバグの根本対処でもある。
    //
    // 抜け穴対策(P2): 旧判定は !is_aix_generated 限定だったため、スタッフがAIXボタン「だけ」で
    // 対応してきた会話（見積送付・申込プッシュまでAIXで進んだ深いファネル）が永久に「真の初回」と
    // 誤判定され、reply_mode が書かれず自動ドラフトゲートを素通りしていた。
    // AIX送信も「スタッフが対応開始した証拠」として扱う。
    // [画像]/[動画] を除外するのは generate-reply 側の初回判定（isFirstReplyGateExempt）との定義統一。
    const hasStaffEngagement = typedMessages.some(
      m => m.sender === "staff" && m.text && m.text !== "[画像]" && m.text !== "[動画]"
    );
    if (!hasStaffEngagement && !isIncremental) {
      finalAix = null;
      replyMode = undefined;
    }

    // template_hint バリデーションゲート: AIXタブのラベルカテゴリ名（許可リストの含む判定）のみ通す。
    // 実測でHaikuが「プッシュ強め・親身」等の抽象トーン説明を返しており（30件中29件）、
    // テンプレピッカーの選択に使えないため、許可リスト非一致は null に落とす（フェイルクローズ）。
    const rawTemplateHint = (parsed.template_hint ?? "").trim();
    let templateHint =
      rawTemplateHint && TEMPLATE_HINT_ALLOWED_LABELS.some((label) => rawTemplateHint.includes(label))
        ? rawTemplateHint
        : undefined;

    // HINT-1 自己修正ゲート: hint ラベル別の実選択一致率（calc-template-scene-stats が週次で
    // TEMPLATE_HINT_ACCEPT_RATE:<ラベル> として trigger_action_rules に書き込む）を読み、
    // 10件以上の実績で一致率30%未満のラベルは提示を抑制する（SOURCE_ACCEPT_RATE ゲートと同型のフェイルオープン設計）。
    if (templateHint) {
      const hintLabel = TEMPLATE_HINT_ALLOWED_LABELS.find((l) => templateHint!.includes(l));
      if (hintLabel) {
        const { data: hintRate } = await supabase
          .from("trigger_action_rules")
          .select("confidence, total_occurrence")
          .eq("action_type", "template_hint")
          .eq("keyword", `TEMPLATE_HINT_ACCEPT_RATE:${hintLabel}`)
          .maybeSingle();
        const occ = (hintRate?.total_occurrence as number | null) ?? 0;
        const conf = (hintRate?.confidence as number | null) ?? 1;
        if (occ >= 10 && conf < 0.3) templateHint = undefined; // 実選択一致率30%未満のラベルは提示を抑制
      }
    }

    // 低採択率アクション降格ゲート: 採択率35%未満（10件以上の実績）のアクションは
    // required → recommended へ自動降格する（例: application_push 30% / mgmt_check_submode 0%）。
    // SOURCE_ACCEPT_RATE:{action}:{source} の取得値（上のゲートで保持済み）を再利用し追加クエリなし。
    // 30%未満は上の完全抑制ゲートで finalAix=null 済みのため、実効帯域は 30〜35%。
    // 例外: meeting_place は内覧フェーズが scheduling / confirmed_future 相当の間は降格しない
    // （日程調整中〜確定済み未来の待ち合わせ案内は文脈上必須のため）。
    let enforcementLevel: "required" | "recommended" = isUrgent ? "required" : "recommended";
    if (finalAix && enforcementLevel === "required" && acceptRateOcc >= 10 && acceptRateConf < 0.35) {
      let protectedMeetingPlace = false;
      if (finalAix === "meeting_place") {
        // analyzeAndSaveBrainMeta の viewingPhaseDetail 分岐と同型の決定論でフェーズを導出
        const nowJstGate = new Date(Date.now() + 9 * 3600 * 1000);
        const todayJstGate = `${nowJstGate.getUTCFullYear()}-${String(nowJstGate.getUTCMonth() + 1).padStart(2, "0")}-${String(nowJstGate.getUTCDate()).padStart(2, "0")}`;
        const upcomingViewing = viewings
          .filter(v => (v.status === "scheduled" || v.status == null) && v.viewing_date >= todayJstGate)
          .sort((a, b) => a.viewing_date.localeCompare(b.viewing_date))[0] ?? null;
        const hasPastViewing = viewings.some(
          v => v.status === "done" || (v.status !== "cancelled" && v.viewing_date < todayJstGate)
        );
        const viewingPhaseGate: "today" | "confirmed_future" | "after_viewing" | "scheduling" =
          upcomingViewing
            ? (upcomingViewing.viewing_date === todayJstGate ? "today" : "confirmed_future")
            : (hasPastViewing ? "after_viewing" : "scheduling");
        protectedMeetingPlace = viewingPhaseGate === "scheduling" || viewingPhaseGate === "confirmed_future";
      }
      if (!protectedMeetingPlace) enforcementLevel = "recommended";
    }

    // ── 5新フィールド決定論ゲート（finalAix矯正群・reply_modeフェイルクローズと同型 — プロンプト任せにしない）──

    // reply_direction: 20字上限をコード強制（超過はLLM逸脱）
    const replyDirection = typeof parsed.reply_direction === "string" && parsed.reply_direction.trim()
      ? parsed.reply_direction.trim().slice(0, 20)
      : null;

    // key_topics: 文字列のみ・空要素/重複除去・最大3件・各40字
    const keyTopics = Array.from(new Set(
      (Array.isArray(parsed.key_topics) ? parsed.key_topics : [])
        .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
        .map((t) => t.trim().slice(0, 40))
    )).slice(0, 3);

    // avoid_topics: ルール⑤（来阪・常時）+ ルール②（費用質問なし）をコード側で決定論的に強制
    const avoidSet = new Set(
      (Array.isArray(parsed.avoid_topics) ? parsed.avoid_topics : [])
        .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
        .map((t) => t.trim().slice(0, 20))
    );
    avoidSet.add("来阪"); // ルール⑤: ブランド絶対ルール（LLM出力に依存しない）
    avoidSet.delete("ご来阪"); // 来阪に正規化（generate-reply側で言い換え禁止を指示するため1語で足りる）
    // 【〇〇】⇒形式の構造化フォーム（条件ヒアリングシート）は費用の質問ではない。
    // 「初期費用の限度額⇒20万」等がCOST_QUESTION_REにマッチしても費用質問扱いにしない。
    const isStructuredIntakeForm = !!(lastCustomerMsg?.text &&
      /【[^】]{2,15}】[^。！\n]{0,5}[⇒→＝:：]/.test(lastCustomerMsg.text));
    const customerAskedCost = !!(lastCustomerMsg?.text &&
      COST_QUESTION_RE.test(lastCustomerMsg.text) &&
      !isStructuredIntakeForm);
    if (customerAskedCost) {
      // 顧客が費用を明示的に質問 → LLMが誤って入れた費用系avoidを除去（質問に答えない方が致命的）
      ["見積書", "見積り", "初期費用", "総額", "費用"].forEach((t) => avoidSet.delete(t));
    } else if (finalAix !== "estimate_sheet" && !keyTopics.some((t) => /見積|費用/.test(t))) {
      // ルール②: 費用質問なし・見積送付アクションでもない → 自発的な費用話題を禁止
      avoidSet.add("見積書");
      avoidSet.add("初期費用");
    }
    // 来阪を必ず先頭固定で残して最大5件（末尾sliceで来阪が落ちるのを防ぐ）
    const avoidTopics = ["来阪", ...Array.from(avoidSet).filter((t) => t !== "来阪")].slice(0, 5);

    // ルール③: 直近スタッフ送信1〜2件（72時間以内・画像/動画プレースホルダ除外）に
    // 緊急表現があれば urgency_appropriate=false を決定論的に強制（LLM出力より優先）。
    // regex不検出時のみLLM判断を採用し、欠落時は true（緊急表現の証拠が無い状態）へフォールバック。
    // フェイルオープン懸念はこの決定論ゲートで解消される（デフォルト反転は不要）。
    const recentStaffTexts = typedMessages // 新しい順
      .filter((m) => m.sender === "staff" && m.text && m.text !== "[画像]" && m.text !== "[動画]"
        && Date.now() - new Date(m.created_at).getTime() <= 72 * 3600 * 1000)
      .slice(0, 2)
      .map((m) => m.text as string);
    const staffUsedUrgency = recentStaffTexts.some((t) => URGENCY_EXPRESSION_RE.test(t));
    const urgencyAppropriate = staffUsedUrgency
      ? false
      : (typeof parsed.urgency_appropriate === "boolean" ? parsed.urgency_appropriate : true);

    // recommended_tone: 許可値ホワイトリスト（含む判定で正規化・不一致は null＝トーン行を注入しない。
    // template_hint の TEMPLATE_HINT_ALLOWED_LABELS ゲートと同型のフェイルクローズ）
    const rawTone = typeof parsed.recommended_tone === "string" ? parsed.recommended_tone.trim() : "";
    const recommendedTone = TONE_ALLOWED.find((t) => rawTone.includes(t)) ?? null;

    // ── Step1移植フィールドの決定論ゲート（5新フィールドゲートと同型 — プロンプト任せにしない）──
    const CONDITION_CHANGE_TYPES = new Set(["area_change", "rent_change", "layout_change", "equip_add", "condition_relax", "pickup_request", "multi"]);
    const HESITANCY_PATTERNS = new Set(["thinking", "callback", "waiting", "undecided", "timeline"]);

    // customer_questions: 文字列のみ・空要素/重複除去・最大5件・各40字（key_topicsゲートと同型）
    const customerQuestions = Array.from(new Set(
      (Array.isArray(parsed.customer_questions) ? parsed.customer_questions : [])
        .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
        .map((q) => q.trim().slice(0, 40))
    )).slice(0, 5);

    // repeated_concern: 20字上限
    const repeatedConcern = typeof parsed.repeated_concern === "string" && parsed.repeated_concern.trim()
      ? parsed.repeated_concern.trim().slice(0, 20)
      : null;

    // current_property 実在ゲート: 会話履歴 or 送付済み物件リストに登場した名前のみ通す
    // （創作物件名はnullに落とすフェイルクローズ。誤った物件文脈での返信強制は事故になるため）
    const rawCurrentProperty = typeof parsed.current_property === "string" ? parsed.current_property.trim().slice(0, 40) : "";
    const propertyNameCore = rawCurrentProperty.replace(/\s*[0-9０-９]{1,4}(号室?)?$/, "").trim(); // 号室部を除いた棟名
    const currentProperty = rawCurrentProperty && propertyNameCore &&
      (history.includes(propertyNameCore) ||
       sentProps.some((s) => s.property_name.includes(propertyNameCore) || rawCurrentProperty.includes(s.property_name)))
      ? rawCurrentProperty
      : null;

    // enum ゲート（許可リスト不一致は null フェイルクローズ — template_hintゲートと同型）
    const conditionChangeType = (typeof parsed.condition_change_type === "string" && CONDITION_CHANGE_TYPES.has(parsed.condition_change_type))
      ? parsed.condition_change_type as NonNullable<SuggestedAixMeta>["condition_change_type"]
      : null;
    const hesitancyPattern = (typeof parsed.hesitancy_pattern === "string" && HESITANCY_PATTERNS.has(parsed.hesitancy_pattern))
      ? parsed.hesitancy_pattern as NonNullable<SuggestedAixMeta>["hesitancy_pattern"]
      : null;

    // future_timeline: 30字上限（timeline分岐以外でも検索クエリに使うため単独保持）
    const futureTimeline = typeof parsed.future_timeline === "string" && parsed.future_timeline.trim()
      ? parsed.future_timeline.trim().slice(0, 30)
      : null;

    // checkpoint_stage: enum ゲート（許可リスト不一致は null フェイルクローズ）
    const CHECKPOINT_STAGES = new Set(["hearing", "proposing", "viewing", "applying", "contract"]);
    const checkpointStage = (typeof parsed.checkpoint_stage === "string" && CHECKPOINT_STAGES.has(parsed.checkpoint_stage))
      ? parsed.checkpoint_stage as NonNullable<SuggestedAixMeta>["checkpoint_stage"]
      : null;

    // customer_intent: enum ゲート
    const CUSTOMER_INTENTS = new Set(["question", "consultation", "desire", "decision", "positive", "negative", "chat"]);
    const customerIntent = (typeof parsed.customer_intent === "string" && CUSTOMER_INTENTS.has(parsed.customer_intent))
      ? parsed.customer_intent as NonNullable<SuggestedAixMeta>["customer_intent"]
      : null;

    // 条件変更検出時はcustomer_intentを決定論的にdesireに強制（LLM見落とし対策）
    const customerIntentFinal: NonNullable<SuggestedAixMeta>["customer_intent"] | null = conditionChangeType !== null ? "desire" : customerIntent;

    // M4: engagement_stance — enum ゲート（許可リスト不一致は null フェイルクローズ）。
    // "wait" は generate-reply の purchase_signal_level クロージング指示を丸ごと無効化する強い信号のため、
    // 誤値・自由記述は必ず null（＝現行動作維持）に倒す。
    const ENGAGEMENT_STANCES = new Set(["push", "wait"]);
    const engagementStance = (typeof parsed.engagement_stance === "string" && ENGAGEMENT_STANCES.has(parsed.engagement_stance))
      ? parsed.engagement_stance as NonNullable<SuggestedAixMeta>["engagement_stance"]
      : null;

    // latent_intent: 送信動機・潜在意識の自由記述（60字上限・空文字/enum誤混入はnullフェイルクローズ）
    const latentIntent = (typeof parsed.latent_intent === "string" && parsed.latent_intent.trim() && !CUSTOMER_INTENTS.has(parsed.latent_intent.trim()))
      ? parsed.latent_intent.trim().slice(0, 60)
      : null;

    // winning_pattern: ai_summary_json から抽出。取得できなかった場合は warn で可視化
    const winningPattern = ((brainSummaryJson as Record<string, unknown> | null)?.winning_pattern as string) ?? null;
    if (!winningPattern && brainSummaryJson !== null) console.warn("[brain-core] winning_pattern not found in ai_summary_json:", conversationId);

    // human_type_label: winningPatternが一致するRAGパターンから取得。なければ上位パターンの値を使う
    const humanTypeLabel: string | null =
      ragWinningPatterns.find((w) => w.pattern === winningPattern && w.human_type_label)?.human_type_label
      ?? ragWinningPatterns[0]?.human_type_label
      ?? null;

    // ── 2択UIフラグ決定論ゲート ────────────────────────────────────────────────────
    // 成約データ分析（closed_won 15件 n=7の条件トレードオフ局面）より:
    //   proposingフェーズで条件トレードオフ質問 → property_send/recommendation が最多成約（5件）
    //   vs テキスト返信（相場説明・比較説明）で成約（2件）
    // スタッフが「AIXで物件追加オススメ」か「テキスト返信（方向性ラベル付き）」の2択で判断する場面を検出する
    // 条件トレードオフ質問の正規表現（現在提案中の物件の条件・価格・設備について納得・比較・トレードオフの判断を求める質問）
    const TRADEOFF_QUESTION_RE =
      /築年数.{0,15}(古|どう|気になる|問題|大丈夫|基準|影響)|古.{0,10}(どう|問題|大丈夫|気になる)|リノベ|ユニットバス|バスト(?:イレ|レ)一緒|設備.{0,15}(どう|どんな|どれ|変わ|なくな|難し)|[0-9０-９万]+(円)?(台|以下|だと|の部屋).{0,20}(難し|厳し|無理|ないです|ありませ)|家賃.{0,10}(安く|下げ|抑え).{0,15}(設備|広|築|駅)|狭く(なって|てもいい|ても)|間取り.{0,10}妥協|妥協.{0,10}(すると|したら|すれば)|なぜ.{0,5}(高い|安い|この値段)|なんで.{0,5}(高い|安い)|価格.{0,10}(違い|差|同じ|なぜ)|差は何|何が違う|この物件.{0,5}(高い|安い|妥当|なぜ)|相場.{0,15}(どう|いくら|教え|知りたい)|[0-9０-９\.]+万.{0,5}と.{0,5}[0-9０-９\.]+万.{0,10}(違い|差)/;
    // 決定論ゲート: LLM出力も参考にするが、コード側で最終判定する
    const llmTwoChoiceMode = typeof parsed.two_choice_mode === "boolean" ? parsed.two_choice_mode : false;
    const isTwoChoiceMode: boolean = (
      // 必須条件1: proposingフェーズ（物件提案中）
      checkpointStage === "proposing" &&
      // 必須条件2: 送付済み物件が1件以上ある
      sentProps.length > 0 &&
      // 必須条件3: 条件トレードオフ質問パターン OR LLMがtrueと判定
      !!lastCustomerMsg?.text && (TRADEOFF_QUESTION_RE.test(lastCustomerMsg.text) || llmTwoChoiceMode) &&
      // 除外条件: 新条件追加はcondition_change_type経由で処理（2択ではなく物件探しが正解）
      conditionChangeType === null &&
      // 除外条件: 内覧確定・申込誘導等の確定アクションがある場合は2択不要
      finalAix !== "viewing_invite" && finalAix !== "application_push" && finalAix !== "meeting_place" &&
      // 除外条件: 顧客が明示的に離脱・拒否していない
      customerIntentFinal !== "negative"
    );
    // reply_direction_label: 10字以内。LLM出力を優先、なければ customer_intent から補完
    const rawRdLabel = typeof parsed.reply_direction_label === "string" ? parsed.reply_direction_label.trim() : "";
    const replyDirectionLabel: string | undefined = isTwoChoiceMode
      ? (rawRdLabel.slice(0, 10) || ((): string => {
          if (customerIntentFinal === "question") return "条件説明";
          if (customerIntentFinal === "consultation") return "相場説明";
          if (customerIntentFinal === "negative") return "不安解消";
          return "条件説明";
        })())
      : undefined;

    // ── AIXボタン種別アナウンス組み立て（2026-08）──────────────────────────────
    // property_check_result の1キー多義解消: 直近会話文脈から check_pattern（初期費用交渉・
    // 近隣月極・保証会社等）を判定し、「物件確認した（募集状況）」と「確認した（条件・交渉）」の
    // どちらのUIボタンをどのサブパターンで押すべきかを note で具体的に明示する。
    const checkKind = finalAix === "property_check_result"
      ? detectPropertyCheckPattern(typedMessages.slice(0, 8).map((m) => m.text ?? "").join("\n"))
      : null;
    // finalAix=null時のnote改善: 従来はLLM生文字列（parsed.action）がそのまま note に入り
    // 「ボタン特定不能なフリーテキスト」表示になっていた。既知ボタンへ写像できる場合は
    // 参考ボタン名を明示した具体的指示に整形する（actionは""のまま＝強制はしない）。
    const freeTextAixKey = !finalAix ? normalizeAixActionKey(parsed.action) : null;
    const staffNote = finalAix
      ? buildAixStaffNote(finalAix, checkKind)
      : freeTextAixKey
        ? `（参考）AIX【${AIX_BUTTON_LABELS[freeTextAixKey] ?? freeTextAixKey}】での対応が候補です。${(parsed.action ?? "").trim()}`.trim()
        : (parsed.action ?? "");

    // finalAix が解決できなかった場合は reply_mode を auto_reply に戻す（最終上書き）。
    // action="" のまま reply_mode="aix" にすると generate-reply のゲートで自動ドラフトが
    // 中止され（ai_draft="[AIX誘導中]"）、押すべきAIXボタンも無いためスタッフが手詰まりになる。
    if (!finalAix) replyMode = "auto_reply";

    return {
      action: finalAix ?? "",
      note: staffNote,
      check_pattern: checkKind?.check_pattern ?? null,
      source,
      enforcement_level: enforcementLevel,
      closing_strategy: parsed.closing_strategy || undefined,
      template_hint: templateHint,
      next_steps: Array.isArray(parsed.next_steps) && parsed.next_steps.length > 0 ? parsed.next_steps : undefined,
      reply_mode: replyMode,
      two_choice_mode: isTwoChoiceMode || undefined,
      reply_direction_label: replyDirectionLabel,
      // Chrome拡張フィードバックループ: 検索フォーム自動入力用の構造化パラメータ（TODO(P2)対応）
      property_search_params: pc ? {
        area: pc.desired_area ?? null,
        floor_plan: pc.floor_plan ?? null,
        rent_max: pc.rent_max ?? null,
        walk_minutes: pc.walk_minutes ?? null,
        move_in_time: pc.move_in_time ?? null,
        preferences: pc.preferences ?? null,
        ng_points: pc.ng_points ?? null,
        ng_properties: sentProps.map((s) => ({ property_name: s.property_name, room_no: s.room_no })),
        search_urgency: (() => {
          // propertySearchText（物件検索統括ブロック）の searchPriority と同一ロジックの★のみ版
          if ((pc.property_send_count ?? 0) >= 2) return "─";
          const lastSentIso = pc.last_property_sent_at ?? sentProps[0]?.sent_at ?? null;
          const daysSince = lastSentIso
            ? Math.floor((Date.now() - new Date(lastSentIso).getTime()) / 86_400_000)
            : null;
          if (daysSince === null || daysSince >= 7) return "★★★";
          if (daysSince >= 3) return "★★";
          return "★";
        })(),
      } : null,
      reply_direction: replyDirection,
      key_topics: keyTopics,
      avoid_topics: avoidTopics,
      urgency_appropriate: urgencyAppropriate,
      recommended_tone: recommendedTone,
      customer_questions: customerQuestions,
      repeated_concern: repeatedConcern,
      current_property: currentProperty,
      condition_change_type: conditionChangeType,
      hesitancy_pattern: hesitancyPattern,
      future_timeline: futureTimeline,
      checkpoint_stage: checkpointStage,
      customer_intent: customerIntentFinal,
      latent_intent: latentIntent,
      // 内部伝搬: SOURCE_ACCEPT_RATE ゲート抑制の事実と、1回目の signalAix 結果の持ち回り
      // （analyzeAndSaveBrainMeta の direction 更新でのバイパス防止＋二重実行回避に使用）
      aix_suppressed_by_accept_rate: aixSuppressedByAcceptRate || undefined,
      signal_aix_ran: signalAixRan || undefined,
      signal_aix_result: signalAixResult,
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 30) : null,
      winning_pattern: winningPattern,
      customer_emotion: ((brainSummaryJson as Record<string, unknown> | null)?.emotion as string) ?? null,
      purchase_signal_level: ((brainSummaryJson as Record<string, unknown> | null)?.purchase_signal_level as "none" | "soft" | "strong" | "peak" | null) ?? null,
      // M4: 押す／待つの局面軸。generate-reply の purchase_signal_level ブロックのゲートに使う
      engagement_stance: engagementStance,
      human_type_label: humanTypeLabel,
      // 鮮度ゲートの基準: 今回の分析が見た最新顧客メッセージのcreated_at。
      // cachedモード返却時はこの値が古いまま残るため、generate-reply側で自動的にstale判定される
      analyzed_msg_ts: lastCustomerMsg?.created_at ?? null,
      // 直近AIXアクション履歴文字列（generate-reply RAG文脈強化用・recentAixSeqText組み立て済み）
      last_aix_history: recentAixSeqText || null,
    };
  } catch (e) {
    console.warn(`[brain-core] Haiku analysis failed: conv=${conversationId}`, e instanceof Error ? e.message : e);
    return null;
  }
}

// ── 会話チェックポイント（セーブデータ）作成 ──────────────────────────────────
// 脳分析成功後に after() で fire-and-forget 起動。final-check anomaly_scan の
// 正解データ（ground truth）になるため「会話に明記された事実のみ・日付付き」が絶対条件。
// ローリング累積方式: 最新1行が常に現在の確認済み事実の全量（前回分を引き継いで更新）。
const MESSAGES_PER_CHECKPOINT = 15;  // 前回作成時から15件以上増えたら新規作成
const CHECKPOINT_MIN_MESSAGES = 11;  // 総メッセージ数 > 10 で初回作成

// フル分析スキップ判定: 10メッセージに1回のフル分析（それ以外はキャッシュ返却）
const FULL_ANALYSIS_EVERY_N_MESSAGES = 10;
const FULL_REFRESH_EVERY_N_MESSAGES = 30;  // フル分析から30件で強制フルリフレッシュ（アンカリング防止）
const INCREMENTAL_MIN_RECENT = 5;           // incremental差分窓の最低件数
const INCREMENTAL_MAX_MESSAGES = 40;        // incremental差分窓の最大件数
// フル分析昇格語: 商談の重大な転換点（申込/契約/審査/キャンセル/他社流出）のみ
// これらはlast_brain_metaが古くなるリスクが高いためfull分析が必要
const FULL_BYPASS_RE = /申込|申し込|入居(したい|します|希望)|契約|審査|キャンセル|やめ(ます|ました)|他(社|の不動産|で決)|必要書類|保証人/;

// インクリメンタル昇格語: 急ぎではあるがincremental（前回結論+新着）で十分対応できる語
// 「今日/明日/お願いします/内覧/見積」等の日常的な商談語はcachedをスキップするが
// fullではなくincrementalで対応（コスト削減の核心）
const INCREMENTAL_BYPASS_RE = /内見|内覧|見学|見に行|決め(ます|ました|たい)|急ぎ|至急|別の(物件|部屋)|検討します|また連絡|連絡します|少し待って|迷って|悩んで|保留|保留中|考えさせて|考え中|後で|後ほど|検討中|初期費用|見積|費用感|諸費用|仲介手数料|敷金|礼金|保証料|かしこまり|ありがとうございます|ありがとうございました|よろしくお願いします|よろしくお願いいたします|承知しました|わかりました|了解しました/;

function formatJstDateShort(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

// H3(Fable5): checkpoint 生成の静的命令を system に分離し prompt caching を適用。
// 動的部分（prevSummary・historyText・カウント）のみ user メッセージに残す。
const CHECKPOINT_STATIC_SYSTEM = `あなたは不動産賃貸仲介のLINE会話の記録係です。会話の「セーブデータ」（チェックポイント）を作成してください。
このセーブデータは後で返信AIの事実確認（ハルシネーション検査）の正解データとして使われます。
会話に書かれていない事実を1つでも書くと、誤った返信が「正しい」と判定される事故になります。

絶対ルール:
- 会話に明記された事実のみ書く。推測・補完・一般知識での穴埋めは禁止
- 各事実に日付と出所を必ず付ける（例:「家賃12〜15万（8/3顧客提示）」）
- 金額・物件名・部屋番号・駅名・路線名・日付は一字一句そのまま写す（丸め・単位変換・言い換え禁止）
- 前回セーブデータの事実は、新しい会話で更新・撤回されていない限りそのまま引き継ぐ。
  更新された場合は新しい値のみ残す（例: 家賃上限が変わったら新値だけ・旧値は書かない）
- 解決した【未解決事項】は【確認済み事実】へ移す（例: 空室確認の回答が来たら結果を事実として記録）

重要度による圧縮ルール（前回セーブデータが長い場合に適用）:
- 永久保持（絶対に省略しない）: 家賃・初期費用・物件名・部屋番号・駅名・入居日・内覧日・申込状況・顧客の決断・キャンセル理由
- 圧縮して保持（1行に要約可）: AIXアクション履歴・スタッフが送った物件の本数・空室確認の結果
- 省略可（成約に無関係な細部）: 雑談・天気の話・「ありがとうございます」等の定型返答・すでに解決した細かい質問
→ 前回セーブデータが長くなった場合は、上記優先度に従って圧縮しつつ全量を引き継ぐこと。重要事実は絶対に落とさない。

JSON形式のみで返答（説明・コードブロック不要）:
{
  "summary": "【確認済み事実】家賃: 12〜15万（8/3顧客提示）/ エリア: 渋谷・恵比寿（8/3顧客）/ 入居希望: 9月上旬（8/3顧客）\\n【AIX使用済み】viewing_invite: 8/5送付 / property_send: 8/7 3件\\n【未解決事項】空室確認: ライオンズ渋谷401（問い合わせ中）/ 内覧日程: 調整中",
  "key_facts": [
    {"type": "confirmed_fact", "value": "家賃12〜15万（8/3顧客提示）"},
    {"type": "aix_sent", "value": "viewing_invite 8/5送付"},
    {"type": "unresolved", "value": "ライオンズ渋谷401 空室確認中"}
  ],
  "stage": "hearing"
}
stage は hearing/proposing/applying/contract のいずれか。
該当事実の無いセクション行は省略可。key_facts の type は confirmed_fact/aix_sent/unresolved の3種のみ。`;

function buildCheckpointUserContent(
  prevSummary: string | null, historyText: string, total: number, shown: number, startOffset: number,
): string {
  return `【前回のセーブデータ】
${prevSummary ? prevSummary.slice(0, 3500) : "（なし・今回が最初のセーブ）"}

【新しい会話（全${total}件のうち${startOffset + 1}〜${startOffset + shown}件目・日付付き。スタッフ(AIX)=AIツールで送信済み）】
${historyText}`;
}

export async function maybeCreateCheckpoint(conversationId: string, customerName?: string): Promise<void> {
  try {
    // 1) 総メッセージ数 + 最新チェックポイントを並列取得
    const [countRes, cpRes] = await Promise.all([
      supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", conversationId),
      supabase
        .from("conversation_checkpoints")
        .select("checkpoint_index, message_count_at_creation, summary")
        .eq("conversation_id", conversationId)
        .order("checkpoint_index", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (countRes.error || cpRes.error) {
      console.warn("[checkpoint] precheck failed:", conversationId,
        countRes.error?.message ?? cpRes.error?.message);
      return; // 最新CPが読めない状態で書くと index 衝突・事実退行の恐れ → 何もしない
    }
    const total = countRes.count ?? 0;
    if (total < CHECKPOINT_MIN_MESSAGES) return;
    const last = cpRes.data as
      { checkpoint_index: number; message_count_at_creation: number; summary: string } | null;
    if (last && total - last.message_count_at_creation < MESSAGES_PER_CHECKPOINT) return;

    // 2) 前回以降の新規メッセージ（最大40件・昇順）
    // 前回チェックポイント位置から昇順 range で取る。直近40件を desc で取る旧方式だと、
    // 前回以降に40件超溜まった場合に「前回位置〜40件窓の間」のメッセージが前回サマリーにも
    // 履歴にも載らず、事実が永久に落ちる（ローリング累積の約束違反）。
    // 40件超残っている場合は今回は先頭40件のみ処理し、message_count_at_creation を
    // 実際にカバーした位置までしか進めないことで、次回呼び出しで残りに追いつく。
    const newSinceLast = last ? total - last.message_count_at_creation : total;
    const startOffset = last?.message_count_at_creation ?? 0;
    const take = Math.min(newSinceLast, 40);
    const { data: msgs, error: msgErr } = await supabase
      .from("messages")
      .select("sender, text, created_at, is_aix_generated")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .range(startOffset, startOffset + take - 1);
    if (msgErr || !msgs || msgs.length === 0) return;

    const historyText = msgs
      .map((m) => {
        const role = m.sender === "customer" ? "顧客" : (m.is_aix_generated ? "スタッフ(AIX)" : "スタッフ");
        return `${role} ${formatJstDateShort(m.created_at as string)}: ${(m.text ?? "").slice(0, 600)}`;
      })
      .join("\n");

    // 3) Haiku（モジュール共有 client: timeout 60s（共有client） / maxRetries 0 — fire-and-forget なので失敗放置でOK）
    const userContent = buildCheckpointUserContent(last?.summary ?? null, historyText, total, msgs.length, startOffset);
    const response = await client.messages.create({
      model: BRAIN_MODEL,
      max_tokens: 1500,
      thinking: { type: "disabled" },
      system: [{ type: "text", text: CHECKPOINT_STATIC_SYSTEM, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } }],
      messages: [{ role: "user", content: maskPII(userContent, [customerName]) }],
    });
    // analyzeConversation と同じ content.find() で thinking ブロック対策
    const raw = response.content.find((c) => c.type === "text")?.text ?? "";
    const fb = raw.indexOf("{");
    const lb = raw.lastIndexOf("}");
    if (fb === -1 || lb <= fb) {
      if (raw === "") {
        console.warn("[brain-core] maybeCreateCheckpoint: Claude returned empty text", conversationId);
      }
      return;
    }
    const parsed = JSON.parse(raw.slice(fb, lb + 1)) as {
      summary?: string;
      key_facts?: Array<{ type: string; value: string }>;
      stage?: string;
    };
    if (!parsed.summary || !parsed.summary.trim()) return;
    const stage = ["hearing", "proposing", "applying", "contract"].includes(parsed.stage ?? "")
      ? (parsed.stage as string) : null;

    // 4) INSERT（並走時の UNIQUE 違反 23505 は「相手が先に書いた」= 正常）
    const { error: insErr } = await supabase.from("conversation_checkpoints").insert({
      conversation_id: conversationId,
      checkpoint_index: (last?.checkpoint_index ?? 0) + 1,
      // total ではなく「実際にサマリーへ取り込んだ位置」まで進める。
      // 40件超のバックログや count 後に届いたメッセージは次回の窓で確実にカバーされる
      message_count_at_creation: startOffset + msgs.length,
      summary: parsed.summary.slice(0, 2000),
      key_facts: Array.isArray(parsed.key_facts) ? parsed.key_facts.slice(0, 20) : [],
      conversation_stage: stage,
    });
    if (insErr && insErr.code !== "23505") {
      console.error("[checkpoint] insert failed:", conversationId, insErr.message);
    }
    // embedding生成（RAG検索用・失敗しても無視でOK）
    if (!insErr) {
      const embedding = await generateEmbedding(parsed.summary);
      if (embedding) {
        await supabase.from("conversation_checkpoints")
          .update({ embedding })
          .eq("conversation_id", conversationId)
          .eq("checkpoint_index", (last?.checkpoint_index ?? 0) + 1);
      }
    }
  } catch (e) {
    console.warn("[checkpoint] failed (fire-and-forget):", conversationId,
      e instanceof Error ? e.message : e);
  }
}

/**
 * 会話1件の脳分析を実行して conversations.suggested_aix_meta + brain_analyzed_at を書き込む。
 * webhook（顧客メッセージ受信直後）と brain-sweep cron（バックストップ）から呼ばれる。
 * 分析対象外（クローズ済み等）や分析失敗時は何も書かない（meta は null のまま → sweep が再試行）。
 */
export async function analyzeAndSaveBrainMeta(conversationId: string): Promise<boolean> {
  const { data: conv, error: selectError } = await supabase
    .from("conversations")
    .select("id, status, updated_at, property_customer_id, auto_send_enabled, line_status, is_hot, is_flagged, conversation_direction, brain_full_analyzed_at, brain_full_msg_count, brain_deep_analyzed_at, brain_deep_msg_count, last_brain_meta, customer_name, is_post_apply")
    .eq("id", conversationId)
    .maybeSingle();
  if (selectError) {
    // B10(Fable5): 旧実装はエラーを握り潰し「会話が存在しない」と区別不能だった
    console.error("[brain-core] conversations select failed:", conversationId, selectError.message);
    return false;
  }
  if (!conv) return false;

  const status = (conv.status as string | null) ?? null;
  if (status && BRAIN_SKIP_STATUSES.includes(status)) return false;
  // 申込以降バッジあり（スタッフが手動マーク）→ 別ツールで管理中のため分析不要
  if ((conv as unknown as Record<string, unknown>).is_post_apply === true) return false;

  // H6(Fable5): ブロック済み/フォロー解除の顧客は分析しない（Haiku浪費 + 無意味な提案の防止）
  const lineStatus = (conv.line_status as string | null) ?? null;
  if (lineStatus === "blocked" || lineStatus === "unfollowed") return false;

  // B5(Fable5): stale-write 対策のウォーターマーク。連続メッセージで分析A→Bが並走した場合、
  // 古い方（msg2を含まない解析）が後着で勝つのを防ぐ — 書き込み時に updated_at 一致を条件にする
  const watermark = conv.updated_at as string;

  // Skip判定: 10メッセージに1回のフル分析（それ以外はキャッシュ返却でSonnetコスト削減）
  const convData = conv as unknown as Record<string, unknown>;
  const lastFullAt = convData?.brain_full_analyzed_at ? new Date(convData.brain_full_analyzed_at as string) : null;
  const lastFullCount = (convData?.brain_full_msg_count as number | null) ?? 0;
  const cachedMeta = (convData?.last_brain_meta ?? null) as Record<string, unknown> | null;
  const customerName = (convData?.customer_name as string | null) ?? undefined;

  // メッセージ総数を取得
  const { count: totalMsgCount, error: countErr } = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("conversation_id", conversationId);
  if (countErr) {
    // DB不調時に count=0 扱いで needsFull=true になり、全会話で最高コストのfull分析
    // （max_tokens 4000 + 21クエリ）が毎回走るのを防ぐ。brain_analyzed_at だけ打刻して
    // sweep の30分バックオフに乗せる（brain_full_msg_count は書かない = 0汚染防止）
    console.error("[brain-core] messages count query failed:", conversationId, countErr.message);
    await supabase
      .from("conversations")
      .update({ brain_analyzed_at: new Date().toISOString() })
      .eq("id", conversationId);
    return false;
  }

  // 最新顧客メッセージ（緊急キーワード判定用）
  const { data: latestMsg, error: latestMsgErr } = await supabase
    .from("messages")
    .select("text, created_at")
    .eq("conversation_id", conversationId)
    .eq("sender", "customer")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestMsgErr) {
    // latestText="" 誤判定（bypass判定スキップ）や hoursSinceLastMsg=Infinity による
    // 不要なfull昇格を防ぐ。countErr と同じくバックオフ打刻のみで中断
    console.error("[brain-core] latest customer message query failed:", conversationId, latestMsgErr.message);
    await supabase
      .from("conversations")
      .update({ brain_analyzed_at: new Date().toISOString() })
      .eq("id", conversationId);
    return false;
  }

  const latestText = latestMsg?.text ?? "";
  const latestMsgAt = latestMsg?.created_at ? new Date(latestMsg.created_at) : null;
  const hoursSinceLastMsg = latestMsgAt && lastFullAt
    ? (latestMsgAt.getTime() - lastFullAt.getTime()) / (1000 * 60 * 60)
    : Infinity;

  const msgsSinceLastFull = (totalMsgCount ?? 0) - lastFullCount;
  const hoursSinceLastFull = lastFullAt
    ? (Date.now() - lastFullAt.getTime()) / (1000 * 60 * 60)
    : Infinity;

  const isFullBypass = FULL_BYPASS_RE.test(latestText);
  const isIncrementalBypass = !isFullBypass && (INCREMENTAL_BYPASS_RE.test(latestText) || PROPERTY_CONDITION_INQUIRY_RE.test(latestText));

  // 3段階モード判定: full / incremental / cached
  const msgsSinceDeep = (totalMsgCount ?? 0) - ((convData?.brain_deep_msg_count as number | null) ?? 0);
  const needsFull =
    !cachedMeta ||
    (totalMsgCount ?? 0) < 11 ||
    isFullBypass ||                                              // 申込/契約/審査/キャンセルは必ずfull
    hoursSinceLastFull >= 24 ||
    hoursSinceLastMsg >= 24 ||
    msgsSinceDeep >= FULL_REFRESH_EVERY_N_MESSAGES;

  const analysisMode: "full" | "incremental" | "cached" =
    needsFull ? "full" :
    (isIncrementalBypass || msgsSinceLastFull >= FULL_ANALYSIS_EVERY_N_MESSAGES) ? "incremental" :
    "cached";

  if (analysisMode === "cached") {
    // キャッシュ返却パス（Sonnet呼び出しなし・required通知は runBrainAndNotify 側で抑制）
    // stale meta: enforcement_level を "optional" に落として強制アクションを抑制
    // 型注釈を明示: Record spread による型チェックすり抜けを塞ぐ（"optional" は SuggestedAixMeta の union に定義済み）
    const cachedResult: NonNullable<SuggestedAixMeta> = {
      ...(cachedMeta as NonNullable<SuggestedAixMeta>),
      source: "cached",
      enforcement_level: "optional",
    };
    await supabase
      .from("conversations")
      .update({ suggested_aix_meta: cachedResult, brain_analyzed_at: new Date().toISOString() })
      .eq("id", conversationId)
      .eq("updated_at", watermark);
    return true;
  }

  const isUrgent = Date.now() - new Date(watermark).getTime() <= URGENT_WINDOW_MS;
  // RAG化 Phase1: 前回brain分析のフェーズ・AIX候補（conversation_direction に前回書き込んだ値）を
  // ルール事前フィルタ用の事前シグナルとして渡す（Sonnet 実行前にフェーズは確定できないため）
  const prevDir = ((conv as unknown as Record<string, unknown>).conversation_direction ?? null) as Record<string, unknown> | null;
  // 直近AIXボタン履歴（last_aix_history）は analyzeConversation 内の aixLogs（30件取得）から
  // recentAixSeqText として組み立て済み・meta.last_aix_history に格納されて返る（L2467）。
  // 以前ここで aix_usage_logs を3件再取得して同フィールドを上書きしていたが、
  // 同一ソース・同一フォーマットの完全重複クエリだったため削除（2026-09-02）

  const meta = await analyzeConversation(
    conversationId,
    isUrgent,
    status,
    (conv.property_customer_id as string | null) ?? null,
    "brain",
    {
      autoSendEnabled: conv.auto_send_enabled === false ? false : undefined,
      isHot: (conv.is_hot as boolean | null) ?? false,
      isFlagged: (conv.is_flagged as boolean | null) ?? false,
      prevPhase: typeof prevDir?.current_phase === "string" ? (prevDir.current_phase as string) : null,
      prevAix: typeof prevDir?.suggested_aix_button === "string" ? (prevDir.suggested_aix_button as string) : null,
      customerName,
      prevMeta: cachedMeta as SuggestedAixMeta ?? null,
      mode: analysisMode,
      totalMsgCount: totalMsgCount ?? 0,
    },
  );
  if (!meta) {
    // H3(Fable5): 失敗時も brain_analyzed_at を記録 → sweep の30分バックオフに使用。
    // これが無いと決定的に失敗する会話が5分毎に永久リトライされ（最大288 Haiku呼び出し/日/行）、
    // 新しい順ソートのため10件のスタック失敗で sweep 全体が飢餓状態になっていた
    await supabase
      .from("conversations")
      .update({ brain_analyzed_at: new Date().toISOString() })
      .eq("id", conversationId)
      .eq("updated_at", watermark);
    return false;
  }

  // incremental分析の結果は source を brain_incremental にする（full は analyzeConversation の source をそのまま使用）
  // last_aix_history は meta に含まれている（analyzeConversation L2467 で recentAixSeqText を格納済み）
  const metaToWrite = { ...meta, ...(analysisMode === "incremental" ? { source: "brain_incremental" } : {}) };
  const { data: writtenRows, error } = await supabase
    .from("conversations")
    .update({
      suggested_aix_meta: metaToWrite,
      brain_analyzed_at: new Date().toISOString(),
      is_hot: true,
      ...(analysisMode === "full" ? {
        brain_deep_analyzed_at: new Date().toISOString(),
        brain_deep_msg_count: totalMsgCount ?? 0,
      } : {}),
      // incrementalとfull両方でbrain_full_*を更新（次回のSkip/incremental判定に使う）
      brain_full_analyzed_at: new Date().toISOString(),
      brain_full_msg_count: totalMsgCount ?? 0,
      last_brain_meta: metaToWrite,
    })
    .eq("id", conversationId)
    .eq("updated_at", watermark) // B5: 会話が進んでいたら古い解析は静かに no-op（sweep が補填する）
    .select("id"); // no-op（0行マッチ）を偽陽性なく検知するために追加
  if (error) {
    // B10(Fable5): スキーマ変更後の型不一致等、恒常的なDB障害を診断可能にする
    console.error("[brain-core] suggested_aix_meta update failed:", conversationId, error.message);
  }
  // actuallyWritten: 実際に1行以上書き込めた場合のみ true（no-op は false）
  // Supabase は 0行マッチでも error=null を返すため writtenRows?.length で判定する
  const actuallyWritten = !error && (writtenRows?.length ?? 0) > 0;
  if (!actuallyWritten && !error) {
    // B5ウォーターマーク競合: autoUpgradeToHot 等が分析中に updated_at を更新したため no-op になった。
    // suggested_aix_meta は書けなかったが sweep の30分バックオフ用に brain_analyzed_at のみ打刻。
    // watermark 条件なし（会話が進んでいても打刻してよい）・25分以内の打刻は上書きしない。
    console.warn("[brain-core] analyzeAndSaveBrainMeta: watermark mismatch (no-op), stamping brain_analyzed_at only:", conversationId);
    await supabase
      .from("conversations")
      .update({ brain_analyzed_at: new Date().toISOString() })
      .eq("id", conversationId)
      .or(`brain_analyzed_at.is.null,brain_analyzed_at.lt.${new Date(Date.now() - 25 * 60 * 1000).toISOString()}`);
  }
  // 脳分析成功時のみチェックポイント作成を fire-and-forget 起動（レスポンスを遅らせない）
  if (actuallyWritten) {
    // brain_decision_logs: Brain判断を記録（fail-open: エラーがあってもメイン処理を止めない）
    try {
      const metaObj = meta as Record<string, unknown>;
      await supabase.from("brain_decision_logs").insert({
        conversation_id: conversationId,
        suggested_action: typeof metaObj.action === "string" ? metaObj.action : null,
        suggested_reply_mode: typeof metaObj.reply_mode === "string" ? metaObj.reply_mode : null,
        suggested_next_steps: Array.isArray(metaObj.next_steps) ? metaObj.next_steps : null,
        enforcement_level: typeof metaObj.enforcement_level === "string" ? metaObj.enforcement_level : null,
        conversation_status: status,
        source: "brain_core",
      });
    } catch (e) {
      console.warn("[brain-core] brain_decision_logs insert failed:", conversationId,
        e instanceof Error ? e.message : String(e));
    }
    // ── brain_learning_queue: 学習キュレーター登録（fire-and-forget・awaitしない）──
    // enforcement_level → quality_score: required=8 / recommended=6、incremental分析は-2。
    // score >= 5 のみ登録（低品質対話からの学習を防止）。conversation_id UNIQUE upsert で重複防止。
    // supabase-js は reject しないため .then() のみで安全（メインフローを一切ブロックしない）。
    {
      const m = meta as Record<string, unknown>;
      const baseScore = m.enforcement_level === "required" ? 8 : m.enforcement_level === "recommended" ? 6 : 4;
      const qualityScore = baseScore - (analysisMode === "incremental" ? 2 : 0);
      if (qualityScore >= 5) {
        const patternTags = [
          typeof m.hesitancy_pattern === "string" ? `hesitancy:${m.hesitancy_pattern}` : null,
          typeof m.checkpoint_stage === "string" ? `stage:${m.checkpoint_stage}` : null,
          typeof m.recommended_tone === "string" ? `tone:${m.recommended_tone}` : null,
          typeof m.action === "string" && m.action ? `action:${m.action}` : null,
        ].filter((t): t is string => t !== null);
        void supabase
          .from("brain_learning_queue")
          .upsert({
            conversation_id: conversationId,
            quality_score: qualityScore,
            pattern_tags: patternTags,
            brain_context: {
              action: m.action ?? null,
              enforcement_level: m.enforcement_level ?? null,
              checkpoint_stage: m.checkpoint_stage ?? null,
              hesitancy_pattern: m.hesitancy_pattern ?? null,
              reply_mode: m.reply_mode ?? null,
              template_hint: m.template_hint ?? null,
              repeated_concern: m.repeated_concern ?? null,
              recommended_tone: m.recommended_tone ?? null,
              urgency_appropriate: m.urgency_appropriate ?? null,
              analysis_mode: analysisMode,
              conversation_status: status,
            },
            novelty_signal: typeof m.repeated_concern === "string" ? m.repeated_concern : null,
            processed_by_corpus2skill: false,
            updated_at: new Date().toISOString(),
          }, { onConflict: "conversation_id" })
          .then(({ error: qErr }) => {
            if (qErr) console.warn("[brain-core] brain_learning_queue upsert failed:", conversationId, qErr.message);
          });
      }
    }
    // ── conversation_direction フェーズ変化検知と更新 ─────────────────────────
    // brain分析が成功した場合のみ実行。フェーズ変化が無い場合・スタッフ手動修正中はスキップ。
    // 失敗しても fire-and-forget なのでメインフローへの影響なし。
    try {
      // STEP A: applying_pattern カテゴリの最重要ナレッジを取得
      const { data: applyingPatterns } = await supabase
        .from("ai_reply_knowledge")
        .select("id, title, content")
        .eq("category", "applying_pattern")
        .gte("importance", 8)
        .order("importance", { ascending: false })
        .limit(1);
      const bestPattern = applyingPatterns?.[0] ?? null;

      // STEP B: brain分析結果からフェーズを推定
      // P7: conversations.status（webhookが機械検証で立てる）を最優先ソースとして渡す
      // 申込経験者判定: ①現ステータスが申込以降（applying/screening/closed_lost）
      // ②sent_properties に applicant_rank が存在（申込フォーマット提出実績。2番手・審査落ち含む）
      // → hearing 降格を抑止して proposing 維持（最ホット顧客の最コールド扱いバグ防止）
      let hasApplicationHistory = ["applying", "screening", "closed_lost"].includes(status ?? "");
      const phasePropertyCustomerId = (conv.property_customer_id as string | null) ?? null;
      if (!hasApplicationHistory && phasePropertyCustomerId) {
        const { count: rankCount } = await supabase
          .from("sent_properties")
          .select("*", { count: "exact", head: true })
          .eq("property_customer_id", phasePropertyCustomerId)
          .not("applicant_rank", "is", null);
        hasApplicationHistory = (rankCount ?? 0) > 0;
      }
      const newPhase = detectPhaseFromBrainMeta(meta as Record<string, unknown>, status, hasApplicationHistory);

      // STEP C: 既存 conversation_direction を取得（conv には conversation_direction を select 済み）
      const convAsRecord = conv as unknown as Record<string, unknown>;
      const existingDir = (convAsRecord?.conversation_direction ?? null) as Record<string, unknown> | null;

      // STEP D: スキップ判定
      // P1バグ修正(抜け穴対策): 旧条件は「フェーズが変わった時だけ」更新していたため、
      // viewing フェーズ内のサブフェーズ遷移（confirmed_future → today → after_viewing）と
      // is_hot が日付の経過だけでは絶対に更新されなかった（内覧当日のホット表示・
      // greeting_viewing 提案・内覧後フォロー遷移が構造的に死んでいた）。
      // viewing はフェーズ変化が無くても常時再計算する。
      const phaseChanged = existingDir?.current_phase !== newPhase;
      if (!existingDir?.manually_overridden && (phaseChanged || newPhase === "viewing")) {
        // STEP E: 新しい direction を構築して UPDATE
        const phaseOrder = ["hearing", "proposing", "viewing", "applying"];
        const newIdx = phaseOrder.indexOf(newPhase);
        const metaRecord = meta as Record<string, unknown>;

        // 改善1/2/3: viewing フェーズは内覧予定テーブルを参照して細かいサブフェーズを決定
        // suggested_aix_button / viewing_scheduled_at / viewing_phase_detail を動的に設定する
        type ViewingRow = { viewing_date: string; viewing_time: string | null; status: string | null };
        let viewingScheduledAt: string | null = null;
        let viewingPhaseDetail: "today" | "after_viewing" | "scheduling" | "confirmed_future" | null = null;
        // 診断修正(内覧バナー誤表示): 顧客の反応待ち中は viewing_invite を出さないため null を許容
        let suggAixButton: string | null;
        let isHot = false;

        // JST 今日の日付を YYYY-MM-DD で取得（UTC+9 を手動計算）
        // viewing 分岐と全フェーズ共通の calendar_events is_hot 補完の両方で使用
        const nowJst = new Date(Date.now() + 9 * 3600 * 1000);
        const todayJst = `${nowJst.getUTCFullYear()}-${String(nowJst.getUTCMonth() + 1).padStart(2, "0")}-${String(nowJst.getUTCDate()).padStart(2, "0")}`;

        // P6(抜け穴対策): brain(Haiku)が提案し品質ゲートを通過したAIXアクション（meta.action）を
        // 決定論デフォルトより優先する統一規則。viewing だけは内覧テーブル由来の決定論を最優先
        // （確実なデータソースのため）。これにより成約実績最多の estimate_sheet や
        // acknowledge_check / followup_revive / property_search 等も suggested_aix_button に
        // 出現可能になる（旧実装はフェーズ決定論のみで、これらのボタンは構造的に絶対出なかった）。
        const brainAix = typeof metaRecord.action === "string" && metaRecord.action && AIX_BRAIN_NOTES[metaRecord.action]
          ? (metaRecord.action as string)
          : null;

        if (newPhase === "viewing") {
          // viewing_history を優先取得・存在しなければviewingsにフォールバック（後方互換）
          const { data: historyRaw } = await supabase
            .from("viewing_history")
            .select("scheduled_date, scheduled_time, status, property_name, property_address")
            .eq("conversation_id", conversationId)
            .order("scheduled_date", { ascending: false })
            .limit(10);
          const allViewings: ViewingRow[] = historyRaw && historyRaw.length > 0
            ? historyRaw.map(h => ({ viewing_date: h.scheduled_date, viewing_time: h.scheduled_time, status: h.status }))
            : await supabase
                .from("viewings")
                .select("viewing_date, viewing_time, status")
                .eq("conversation_id", conversationId)
                .order("viewing_date", { ascending: false })
                .limit(10)
                .then(r => (r.data ?? []) as ViewingRow[]);

          // 最も近い未来・今日の scheduled 内覧（昇順ソートして最初の1件）
          // P8修正(抜け穴対策): status=null の未来内覧も upcoming として扱う。
          // 旧条件（status === "scheduled" 必須）では status 未設定の未来内覧が
          // upcoming にも past（過去日付条件）にも入らず「scheduling」へ落ち、
          // 日程確定済みなのに viewing_invite（日程調整）を再提案していた。
          const upcomingViewing = allViewings
            .filter(v => (v.status === "scheduled" || v.status == null) && v.viewing_date >= todayJst)
            .sort((a, b) => a.viewing_date.localeCompare(b.viewing_date))[0] ?? null;

          // 最も最近の過去内覧（done または scheduled で過去日付・cancelled は除外）
          const pastViewing = allViewings
            .filter(v => v.status === "done" || (v.status !== "cancelled" && v.viewing_date < todayJst))
            .sort((a, b) => b.viewing_date.localeCompare(a.viewing_date))[0] ?? null;

          if (upcomingViewing) {
            // 内覧日確定あり（今日または未来）
            const vDate = upcomingViewing.viewing_date;
            const vTime = upcomingViewing.viewing_time ? String(upcomingViewing.viewing_time).slice(0, 5) : null;
            viewingScheduledAt = vTime ? `${vDate}T${vTime}:00+09:00` : `${vDate}T00:00:00+09:00`;
            if (vDate === todayJst) {
              // 内覧当日 → greeting_viewing（当日挨拶）
              viewingPhaseDetail = "today";
              suggAixButton = "greeting_viewing";
              isHot = true;
            } else {
              // 内覧日確定・未来 → meeting_place（待ち合わせ案内）
              viewingPhaseDetail = "confirmed_future";
              suggAixButton = "meeting_place";
            }
          } else if (pastViewing) {
            // 内覧済み → greeting_viewing（内覧後フォロー）
            const vDate = pastViewing.viewing_date;
            const vTime = pastViewing.viewing_time ? String(pastViewing.viewing_time).slice(0, 5) : null;
            viewingScheduledAt = vTime ? `${vDate}T${vTime}:00+09:00` : `${vDate}T00:00:00+09:00`;
            viewingPhaseDetail = "after_viewing";
            suggAixButton = "greeting_viewing";
          } else {
            // 内覧日未確定 → 原則 viewing_invite（日程調整）。
            // ただし顧客の直近メッセージに「待ち合わせ場所変更」シグナルがある場合は
            // meeting_place を優先する（Case2対策: 内覧がチャット上でのみ確定し
            // viewings/viewing_history に未登録だと空テーブル→scheduling に落ち、
            // 場所変更依頼に viewing_invite を誤提案していた）。
            // brainAix が meeting_place の場合も同様に尊重する（viewing 分岐は従来
            // brainAix を一切参照せずHaikuの正解を潰していた）。
            const { data: recentCustMsgs } = await supabase
              .from("messages")
              .select("text")
              .eq("conversation_id", conversationId)
              .eq("sender", "customer")
              .order("created_at", { ascending: false })
              .limit(3);
            const recentText = (recentCustMsgs ?? []).map((m) => m.text ?? "").join("\n");
            // シグナル: ①場所・待ち合わせの明示的変更 ②移動困難+代替場所提案の組み合わせ
            // （単なる「間に合わない」だけでは発動しない＝内覧キャンセルと混同しないため②はAND条件）
            const placeChangeSignal =
              /(場所|待ち合わせ|集合).{0,10}(変更|変え)/.test(recentText) ||
              /(駅|口).{0,6}(でもいい|の方が|に変更|でお願い)/.test(recentText) ||
              (/(行けな|行くの間に合|間に合いそうにな|間に合わな|来られな|来れな|向かえな)/.test(recentText) &&
                /(の方でもいい|でもいいですか|でも大丈夫|に変更|でお願い|はどうですか)/.test(recentText));
            if (brainAix === "meeting_place" || placeChangeSignal) {
              viewingPhaseDetail = "confirmed_future";
              suggAixButton = "meeting_place";
            } else {
              // 診断修正(内覧バナー誤表示): viewing_invite は「顧客の反応」が前提のアクション。
              // 最終メッセージがスタッフ送信（物件送付直後・返信直後＝顧客の反応待ち）の場合は
              // 何も提案しない（null）。顧客が返信すれば webhook 経由の再分析でガードを通過し、
              // 正当な viewing_invite は従来どおり提案される
              // 退去予定/入居中検出（旧 redirectMoveOut 相当）のため text も取得し、
              // スタッフ送信を含む直近10件で判定する（limit 1 → 10 に拡張）
              const { data: lastMsgRows } = await supabase
                .from("messages")
                .select("sender, text")
                .eq("conversation_id", conversationId)
                .order("created_at", { ascending: false })
                .limit(10);
              // 退去予定/入居中物件では現地内覧不可 → 申込誘導へ差し替え
              const schedMoveOut = MOVE_OUT_PATTERN.test(
                (lastMsgRows ?? []).map((m) => m.text ?? "").join("\n"),
              );
              viewingPhaseDetail = "scheduling";
              suggAixButton = lastMsgRows?.[0]?.sender === "customer"
                ? (schedMoveOut ? "application_push" : "viewing_invite")
                : null;
            }
          }

        } else {
          // P5(成約データ反映): brainAix（Haiku提案・品質ゲート通過済み）が無い場合、
          // フェーズ決定論デフォルトに落ちる前に applying_pattern 由来の信号ベース判定を挟む。
          // 優先順位: brainAix > 信号ベース（成約実績順） > フェーズ別デフォルト。
          // 既存の決定論（viewing の内覧テーブル最優先・brainAix 優先）は一切変えない。
          // 品質ゲートバイパス対策(2026-08): analyzeConversation が SOURCE_ACCEPT_RATE ゲートで
          // finalAix を抑制した場合、ここでの fallback 再実行が同じ低品質アクションを
          // suggested_aix_button に復活させていた（スタッフへの低品質誘導）。
          // ゲート抑制時は fallback を丸ごとスキップし suggested_aix_button を書かない。
          // ※ 初回接触 null 化・提案なし等の他の null 理由は従来どおり fallback で補完する。
          const aixSuppressed = metaRecord.aix_suppressed_by_accept_rate === true;
          // 二重実行回避: analyzeConversation 側で fallback 実行済みなら、その結果（ゲート適用前の値）を
          // 持ち回りで再利用する（6本のDBクエリ×2 → ×1）。未実行時（Haiku提案がガードで null 化された
          // ケース等）のみ従来どおり再実行する。
          const carriedSignalAix: string | null | undefined = metaRecord.signal_aix_ran === true
            ? (typeof metaRecord.signal_aix_result === "string" && AIX_BRAIN_NOTES[metaRecord.signal_aix_result]
                ? (metaRecord.signal_aix_result as string)
                : null)
            : undefined; // undefined = 1回目未実行 → 再実行が必要
          if (aixSuppressed) {
            suggAixButton = null;
          } else {
            const signalAix = brainAix
              ? null
              : carriedSignalAix !== undefined
                ? carriedSignalAix
                : await detectSignalBasedAixFallback(
                    conversationId,
                    (conv.property_customer_id as string | null) ?? null,
                    newPhase,
                  );
            if (newPhase === "applying") {
              suggAixButton = brainAix ?? signalAix ?? "application_push";
            } else if (newPhase === "proposing") {
              suggAixButton = brainAix ?? signalAix ?? "property_send";
            } else {
              suggAixButton = brainAix ?? signalAix ?? "condition_hearing";
            }
          }
        }

        // calendar_events から今日この会話に紐づく内覧予定を確認 → is_hot 補完
        // viewings テーブルで today が検出されなかった場合でも calendar 側に当日予定があれば is_hot = true。
        // 優先度3(抜け穴対策): 旧実装は viewing フェーズ限定だったため、フェーズ誤判定で
        // applying 等になった当日内覧顧客がホット化しなかった。全フェーズで補完する。
        if (!isHot) {
          try {
            const todayStartUTC = new Date(`${todayJst}T00:00:00+09:00`).toISOString();
            const todayEndUTC = new Date(`${todayJst}T23:59:59+09:00`).toISOString();
            const { data: calToday } = await supabase
              .from("calendar_events")
              .select("id")
              .eq("conversation_id", conversationId)
              .eq("event_type", "viewing")
              .gte("start_at", todayStartUTC)
              .lte("start_at", todayEndUTC)
              .limit(1);
            if ((calToday?.length ?? 0) > 0) isHot = true;
          } catch {
            // calendar_events が取得できなくても処理を続行
          }
        }

        const newDirection = {
          template_id: bestPattern?.id ?? null,
          pattern_title: bestPattern?.title ?? "デフォルト道筋",
          approach_mode: (newPhase === "applying" || newPhase === "viewing") ? "active" : "watchful",
          direction_summary: String(metaRecord.closing_strategy ?? "申込まで丁寧にリード"),
          current_phase: newPhase,
          phases_plan: phaseOrder.map((ph, i) => ({
            phase: ph,
            label: ["条件ヒアリング", "物件提案", "内覧調整", "申込"][i],
            staff_action: ["希望条件を確認", "条件に合う物件を提案", "内覧日程を調整", "申込書類を案内"][i],
            status: i < newIdx ? "done" : i === newIdx ? "current" : "pending",
          })),
          next_staff_action: (() => {
            const raw = Array.isArray(metaRecord.next_steps)
              ? String((metaRecord.next_steps as string[])[0] ?? "")
              : String(metaRecord.next_steps ?? "");
            const src = raw.trim() || "状況を確認して次の一手を判断";
            if (/申込/.test(src)) return "お客さんの懸念点を確認しながら、申込書類の準備について自然に案内する";
            if (/内覧/.test(src)) return "物件の空き状況や他の問い合わせ状況を伝えながら、内覧日程を提案する";
            if (/物件/.test(src)) return "希望条件に合う物件を絞り込みながら、具体的な物件情報を送る";
            return src;
          })(),
          suggested_aix_button: suggAixButton,
          viewing_scheduled_at: viewingScheduledAt,
          viewing_phase_detail: viewingPhaseDetail,
          is_hot: isHot,
          matched_at: (existingDir?.matched_at as string | undefined) ?? new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        await supabase
          .from("conversations")
          .update({ conversation_direction: newDirection })
          .eq("id", conversationId);
      }
    } catch (dirErr) {
      console.warn("[brain-core] conversation_direction update failed:", conversationId,
        dirErr instanceof Error ? dirErr.message : dirErr);
    }

    try {
      after(() => maybeCreateCheckpoint(conversationId, customerName));
    } catch {
      // リクエストコンテキスト外（テスト/スクリプト実行）では after() が使えないためフォールバック
      void maybeCreateCheckpoint(conversationId, customerName).catch(() => {});
    }
  }
  return actuallyWritten; // 実際に書き込んだ時だけ true（偽陽性の根本修正）
}

// ── brain直列アーキテクチャ（2026-08）────────────────────────────────────────
// 呼び出し元:
//   - generate-draft-bg-async: after() の入り口で await → 返却スナップショットを
//     generate-reply の brainMetaDirect に直接渡す（DB再フェッチ・書き込み競合の解消）
//   - line-webhook: bg-async がステータス起因でdraft生成ごとスキップする会話
//     （申込以降）のみ、従来どおり webhook 側で実行（required通知の消滅防止）

// AIXアクション日本語ラベル（required通知のリッチ化用・旧line-webhook L43から移設）
export const AIX_LABEL_JP: Record<string, string> = {
  property_recommendation: "物件オススメ送信",
  property_send: "物件を送る",
  viewing_invite: "内覧誘導",
  application_push: "申込促進",
  property_check_result: "物件確認",
  estimate_sheet: "見積書送付",
  meeting_place: "待ち合わせ確定",
  acknowledge_check: "反応確認",
  followup_revive: "追客フォロー",
  condition_hearing: "条件ヒアリング",
};

/** generate-reply の fetchReplyModeGate 返却値と同形のスナップショット */
export type BrainGateSnapshot = {
  meta: SuggestedAixMeta;
  customerName: string;
  conversationDirection: Record<string, unknown> | null;
  brainAnalyzedAt: string | null;
};

/**
 * 脳分析 → meta保存 → enforcement_level==="required" ならスタッフグループ通知 →
 * 保存直後の gate スナップショットを返す。
 *
 * 返り値の契約:
 *   - 分析が成功した場合のみスナップショットを返す（呼び出し元は generate-reply の
 *     brainMetaDirect にそのまま渡してよい = 自分で今書いた値なので鮮度保証あり）
 *   - 分析失敗・対象外・DB読み取り失敗は null → 呼び出し元は brainMetaDirect を渡さず
 *     従来の generate-reply 側 DBフェッチにフォールバックすること
 *     （チェックポイントBの「Step1後の再確認」で brain-sweep の補填を拾える余地を残す）
 */
export async function runBrainAndNotify(conversationId: string, msgText?: string): Promise<BrainGateSnapshot | null> {
  let analyzed = false;
  try {
    analyzed = await analyzeAndSaveBrainMeta(conversationId);
  } catch (e) {
    console.warn("[brain-core] runBrainAndNotify analyze failed:", conversationId, e instanceof Error ? e.message : e);
  }
  if (!analyzed) return null;

  const { data: row, error } = await supabase
    .from("conversations")
    .select("suggested_aix_meta, customer_name, conversation_direction, brain_analyzed_at, is_hot")
    .eq("id", conversationId)
    .maybeSingle();
  if (error || !row) {
    if (error) console.warn("[brain-core] runBrainAndNotify snapshot read failed:", conversationId, error.message);
    return null;
  }

  const snapshot: BrainGateSnapshot = {
    meta: (row.suggested_aix_meta ?? null) as SuggestedAixMeta,
    customerName: (row.customer_name as string | null) ?? "",
    conversationDirection: (row.conversation_direction ?? null) as Record<string, unknown> | null,
    brainAnalyzedAt: (row.brain_analyzed_at as string | null) ?? null,
  };

  // B5ウォーターマーク競合ケース: analyzeAndSaveBrainMeta が true を返しても、分析中に会話が
  // 進んでいた場合は書き込みが no-op になり meta は null（webhookワイプ後）のまま。
  // その meta-null スナップショットを返すと呼び出し元が brainMetaDirect として渡してしまい、
  // generate-reply のチェックポイントB再フェッチ（sweep補填を拾う余地）まで潰れるため null を返す
  // （契約どおり「有効な分析結果がある時のみスナップショット」に統一。notify も meta が無ければ不要）。
  if (!snapshot.meta) return null;

  // 以下3つはスナップショット返却に不要 → fire-and-forget で 90s race budget を節約
  // is_hot格上げ通知（brain完了後に鈴木メンション送信）
  if (msgText) {
    void (async () => {
      try {
        const { notifySuzukiReply } = await import("@/app/lib/notify-suzuki");
        await notifySuzukiReply(supabase as any, conversationId, msgText);
      } catch (e) {
        console.warn("[brain-core] notifySuzukiReply failed:", e instanceof Error ? e.message : e);
      }
    })();
  }

  // 物件条件ブレイン信号: brain が条件変化 or ヒアリング/提案フェーズを検出したら runConditionBrain を起動
  // line-webhook after() F を廃止し、brain 分析結果を起点とした信号制御に統一
  if (
    msgText &&
    msgText.length >= 5 &&
    (snapshot.meta.condition_change_type !== null ||
      snapshot.meta.checkpoint_stage === "hearing" ||
      snapshot.meta.checkpoint_stage === "proposing")
  ) {
    void (async () => {
      try {
        const { runConditionBrain } = await import("@/app/lib/property-brain-core");
        await runConditionBrain(conversationId, msgText);
      } catch (e) {
        console.warn("[brain-core] condition brain signal:", e instanceof Error ? e.message : e);
      }
    })();
  }

  // required 通知（旧line-webhook brain after() から移設。全件通知は通知疲れのため required のみ）
  void (async () => {
    try {
      const meta = snapshot.meta;
      // source === "cached" の場合は required通知をスキップ（キャッシュ返却のたびに同じ通知が再送される二重通知防止）
      if (meta && meta.enforcement_level === "required" && meta.source !== "cached") {
        const customerName = snapshot.customerName || "お客様";
        const isHot = (row as Record<string, unknown>).is_hot === true;
        const sigLevel = meta.purchase_signal_level ?? "";
        const urgencyEmoji = (isHot || sigLevel === "strong" || sigLevel === "peak" || meta.action === "estimate_sheet") ? "🔥" : "🔴";
        const shortLabel = AIX_LINE_LABELS[meta.action ?? ""] ?? meta.action ?? "対応";
        const actionNote = buildAixLineNote(meta.action ?? "", (meta as Record<string, unknown>).check_pattern as string | null);
        const lines = [
          `${urgencyEmoji} ${customerName}さん｜${shortLabel}`,
          actionNote,
        ];
        // property_search: 条件サマリーを3行目に追加
        if (meta.action === "property_search" && meta.property_search_params) {
          const p = meta.property_search_params as Record<string, unknown>;
          const parts = [p.area, p.floor_plan, p.rent_max ? `${p.rent_max}万円まで` : null].filter(Boolean);
          if (parts.length > 0) lines.push((parts as string[]).join(" / "));
        }

        const baseUrl =
          process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ??
          (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
        await fetch(`${baseUrl}/api/notify-group`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: lines.join("\n") }),
          signal: AbortSignal.timeout(5_000),
        });
      }
    } catch (e) {
      // 通知失敗は分析成功を無効化しない（スナップショットはそのまま返す）
      console.warn("[brain-core] runBrainAndNotify notify failed:", conversationId, e instanceof Error ? e.message : e);
    }
  })();

  // ブレインのaction判断時にカレンダーへ直接登録（テキスト解析不要・通知失敗の影響を受けない fire-and-forget）
  if (conversationId && snapshot.meta.action) {
    void createCalendarEventFromBrainAction(conversationId, snapshot.meta.action, snapshot.customerName || null)
      .catch((e) => console.error("[brain-core] calendar from brain action failed:", e));
  }

  return snapshot;
}

/**
 * ブレインが判断した AIX action からカレンダーイベントを直接登録する。
 * COMMITMENT_RE + Haiku のテキスト解析に頼らず、ブレインの判断をそのままタスク化する。
 * 同日・同会話・同種の未完了イベントが既にある場合は重複登録しない
 * （ブレインは同一会話・同日に複数回発火しうるため必須のガード）。
 */
async function createCalendarEventFromBrainAction(
  conversationId: string,
  action: string,
  customerName: string | null,
): Promise<void> {
  const ACTION_CALENDAR_MAP: Record<string, { eventType: string; daysFromNow: number; label: string }> = {
    estimate_sheet:  { eventType: "estimate_sheet",  daysFromNow: 0, label: "御見積書送付" },
    property_send:   { eventType: "property_send",   daysFromNow: 0, label: "物件ピックアップ送付" },
    property_search: { eventType: "property_send",   daysFromNow: 0, label: "物件ピックアップ" },
    viewing_invite:  { eventType: "viewing",         daysFromNow: 0, label: "内覧調整" },
    phone:           { eventType: "phone",           daysFromNow: 0, label: "電話連絡" },
    follow_up:       { eventType: "follow_up",       daysFromNow: 1, label: "フォローアップ" },
  };
  const cfg = ACTION_CALENDAR_MAP[action];
  if (!cfg) return;

  // JSTでの今日/明日を算出
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const targetDate = new Date(jstNow.getTime() + cfg.daysFromNow * 86400000);
  const dateStr = targetDate.toISOString().slice(0, 10); // YYYY-MM-DD
  const startAt = `${dateStr}T10:00:00+09:00`;

  const title = customerName ? `${customerName} ${cfg.label}` : cfg.label;

  try {
    // 同日・同会話・同種イベントが既に存在する場合は重複登録しない
    const { data: existing } = await supabase
      .from("calendar_events")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("event_type", cfg.eventType)
      .gte("start_at", `${dateStr}T00:00:00+09:00`)
      .lte("start_at", `${dateStr}T23:59:59+09:00`)
      .eq("is_done", false)
      .limit(1);
    if (existing && existing.length > 0) return; // 既存あり → スキップ

    await supabase.from("calendar_events").insert({
      title,
      event_type: cfg.eventType,
      customer_name: customerName,
      conversation_id: conversationId,
      start_at: startAt,
      all_day: true,
      notes: `[Brain AIX] action=${action}`,
    });
  } catch (e) {
    console.warn("[brain-core] createCalendarEventFromBrainAction failed:", conversationId, e instanceof Error ? e.message : e);
  }
}
