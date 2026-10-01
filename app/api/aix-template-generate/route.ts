import { NextRequest, NextResponse, after } from "next/server";
import { supabase } from "@/app/lib/supabase";
// 2026-09-29 API 費用の調査: 名札を付ける（llm-alt-provider は system の先頭の語で既に "aix_template" と見なしている＝同じ名前なので回し方は変わらない）
import { sumoraLlmMarks } from "@/app/lib/llm-usage-recorder";
import { resolveBrainMetaForGeneration, BRAIN_META_RESTORE_COLUMNS, type BrainMetaRow } from "@/app/lib/brain-meta-load";
import { generateEmbedding } from "@/app/lib/knowledge-utils";
import { AIX_BUTTON_LABELS } from "@/app/lib/aix-taxonomy";
import { safeSlice } from "@/app/lib/safe-slice";
// 本番LINE返信AI（generate-reply）と共有のプロンプトセクション（単一ソース・二重定義禁止）
import {
  SMORA_COMMON_RULES,
  SMORA_RULES,
  REAL_ESTATE_RULES,
  CURATED_REPLY_RULES,
  SMORA_QUICK_PATTERNS,
  STATE_SEARCH_ALIASES,
} from "@/app/lib/line-reply-prompts";
// generate-reply と同じDB学習資産（絶対原則・失注パターン・フレーズ辞書・DB学習ルール）
import {
  getCachedTopPrinciples,
  getCachedLossPatterns,
  getCachedPhrases,
  getCachedPromptRules,
  resolvePhraseCategories,
} from "@/app/lib/prompt-cache";
import { normalizeStatus } from "@/app/lib/status-normalize";
// 顧客名の妥当性判定（generate-reply と同一ソース — LINE表示名を実名として使わないゲート）
import { stripNonNameChars, isPlausiblePersonName } from "@/app/lib/validate-reply";
// 2026-09-18 竹内（𝒮 さん事例）: 1件しか送っていないなら比較の言い方を書かない／まだ内覧できない部屋は申込誘導
import { fixRecommendClosing, buildRecommendClosingNote } from "@/app/lib/recommend-closing";
// 2026-09-21 竹内「複数物件送った中では『お送りさせて頂きましたお部屋の中でも〜』／新着物件なら新着物件の言い回し」
//   判定・ガイド・禁止表現・検査は app/lib/recommendation-frame.ts に集約（AIX ボタン本体と同じ物を見る）
import {
  canUseCompareFrame, resolveRecommendationScenario, detectFrameViolation, isExampleFrameCompatible,
  RECOMMENDATION_SCENARIO_LABELS, RECOMMENDATION_SCENARIO_GUIDES, RECOMMENDATION_FORBIDDEN_OPENINGS,
  COMPARE_FRAME_RE, NEW_LISTING_FRAME_RE,
  type RecommendationScenario, type PropertySendFacts,
} from "@/app/lib/recommendation-frame";
// 2026-09-18 物件の状況（送った件数・退去予定・内覧可否）はブレインの判断を1つの関数から読む（aix/action と同じ物）
import { resolvePropertySendState, describePropertySendState } from "@/app/lib/property-send-state";
// 2026-09-18 竹内「テンプレートよくわからん文生成される」: ブレインの判断の整形と渡し方を返信生成と揃える
import { buildBrainStrategyNote, describeBrainStrategyNote } from "@/app/lib/brain-strategy-note";
// 2026-09-18 出口の決定論を返信生成・AIX 本体と揃える（テンプレートには1つも通っていなかった）
import { stripWaited } from "@/app/lib/greeting";
// 2026-09-20 竹内「結果を届ける AIX では『お待たせ致しました』を許す」: 場面の判定を一本化（四者同名）
// 2026-09-27 竹内さん決定で上書き: AIX でも使わない（許す一覧は空＝全部落とす・手本も置き換えて見せる）
import { isWaitedAllowed, neutralizeWaitedInExample } from "@/app/lib/waited-scope";
// 2026-09-20 竹内「AIX テンプレート、AIX の内容との関係性での生成が重要」: 直前の1通目を読んで2通目の材料にする
import { buildAixChainNote, foreignRoomsInSecond } from "@/app/lib/aix-chain-note";
// 2026-09-20 竹内「生成される文が長すぎる」: 長さの目安を実測から渡す＋生成後に記録する
import { buildLengthNote, checkLength } from "@/app/lib/template-length";
// 2026-09-20 竹内: 禁止語の整形（夜間挨拶・承知→かしこまりました・挨拶の重複）を返信生成・AIX 本体と同じ関数で
import { normalizeBannedPhrasing } from "@/app/lib/banned-phrasing";
// 2026-09-20 竹内「AI の作業メモは下書き欄に絶対入れない」: 返信生成・AIX 本体と同じ関数をテンプレートにも
import { isNotACustomerReply, stripMetaNarration } from "@/app/lib/meta-narration";
import { isGroupConversationName } from "@/app/lib/line-target";
// 2026-09-21 竹内「付けるかはブレインが判断する／お客さんの反応見て刺さっているなら誘導する」
import { resolveCtaGuidance } from "@/app/lib/cta-guidance";
import { resolveRecommendCta, readCustomerReaction, setRecommendClosing, buildSecondMessageCtaNote, pickupForFirstMessage, headOfFirstMessage, hasClosingKind, type RecommendCtaDecision, type PickupLookupRow } from "@/app/lib/recommend-cta";
// お客様の反応の分類は返信生成・往復文脈と同じ関数（四者同名）
import { analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse } from "@/app/lib/reply-context";
import { stripVagueQuantifier } from "@/app/lib/vague-quantifier";
import { stripPropertyNameFromPickupLine } from "@/app/lib/pickup-line";
// 2026-10-01 竹内「全域にする・AIX にもあてる」
import { polishConditionEcho } from "@/app/lib/condition-echo-polish";
import { stripRepeatedThanksLines } from "@/app/lib/property-send-match";
import { stripUnfoundedSelectionClaim, SELECTION_CLAIM_NOTE } from "@/app/lib/selection-claim";
import { extractPropertyLabels } from "@/app/lib/action-ledger";
// AIX-META（suggested_aix_meta）の型は brain-core を単一ソースとして参照（type-only importのためランタイム依存なし）
import type { SuggestedAixMeta } from "@/app/lib/brain-core";
import { applyDailyGreeting } from "@/app/lib/daily-greeting";
import { staffSentTodayFromDb } from "@/app/lib/daily-greeting-server";
// 2026-09-27 竹内: テスト用の会話（YUMA）は学習に入れない（一覧は test-conversations.ts の1か所）
import { isTestConversation } from "@/app/lib/test-conversations";
// 2026-09-30 竹内「2通目の言い回しが AI くさい。実際使っている言い回しが出るように／場面で違う／資料も読み取ったのを渡す」:
//   物件オススメの直後の2通目は、場面ごとの実送信の実物（second-message-scene）で形を決め、AI だけが書く言い回し（second-message-style）を出口で見る
import { buildSecondSceneNote, buildSecondMaterialNote, secondSceneOf, leakedExampleFacts, unfoundedCostClaim, pickPickupSecondTarget, type SecondMaterialRow, type PickupPushRow } from "@/app/lib/second-message-scene";
import { findAiPhrases, ensureOneEmoji, fixMissingNi } from "@/app/lib/second-message-style";
import { dedupeRepeatedEmoji } from "@/app/lib/emoji-repeat";
import { fixAdjectiveNakaguro } from "@/app/lib/first-message-style";
import { resolveTemplateSentMessage } from "@/app/lib/aix-template-source";
import { isTestModeAllowed } from "@/app/lib/llm-test-mode";
// 2026-10-01 竹内「見積書や他のよく使うAIXテンプレートの部分も改善する」: 見積書の直後の2通目の形・締め・検査（スタッフが書いた2通目 132通から）
import { isEstimateCard, estimatePropertiesOf, resolveEstimateClosing, buildEstimateSecondNote, findEstimateSecondProblems, ensureEstimateClosing, type EstimateClosing } from "@/app/lib/estimate-second-message";
// 2026-10-01: 今ご内覧頂けるか・退去予定の一文は、1通目（aix/action）と同じ関数・同じ材料で決める
import { resolveRecommendViewable, ensureVacatingLine, mentionsVacating, tidyVacatingAndClosing, type RecommendViewable } from "@/app/lib/recommend-viewable";

export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/aix-template-generate
//
// AIXテンプレート一覧の「✨ この会話に合った文を生成」ボタン用API。
// 現在選択中のAIXボタン種別（action_type）＋会話コンテキスト（顧客名・条件・直近
// メッセージ）をもとに、generate-reply（本番LINE返信AI）と同等の品質スタックで
// AIXボタンの「送付後の橋渡し文（カバーメッセージ）」を Claude Sonnet で生成する。
//
// 品質スタック（2026-08-28 generate-reply 同等化）:
//   ① 共有プロンプトセクション: SMORA_COMMON_RULES / SMORA_RULES / REAL_ESTATE_RULES /
//      CURATED_REPLY_RULES / SMORA_QUICK_PATTERNS（line-reply-prompts.ts 単一ソース）
//   ② DB学習資産: 絶対原則（importance>=8 principle）・失注パターン・ai_prompt_rules・
//      phrase_dictionary（prompt-cache 経由・generate-reply と同一キャッシュ）
//   ③ RAG: winning_patterns + ai_reply_knowledge（バケット別スコアリング）+
//      ai_reply_examples（⭐実例 — 文体・テンポの忠実な再現）
//   ④ Brain戦略（suggested_aix_meta）: 検索ベクトル強化 + 生成方向性の注入
//   ⑤ AIX専用実例バケット: pgvector（match_aix_reply_examples）を主軸に、会話ごとに異なる
//      実例を類似度で引く（2026-08-31 RAG一本化）。actionType固定の直クエリは「同じボタンなら
//      全員同じ実例」になりテンプレ感の温床だったため、⭐スター付き最優秀2件のみ残して縮小。
//
// ※ GENERATION_SYSTEM（通常返信専用システム）は意図的に注入しない。
//   GENERATION_SYSTEM は「見積書カバー文・確認結果報告等はAIX専用のため通常返信では
//   生成禁止」と定めるが、本APIはまさにそのAIX側の担当であり、丸ごと注入すると
//   アクション別ガイド（estimate_sheet の定型カバー文等）と正面衝突する。
//   AIX側で共有すべき営業スタイル・禁止ワードの核は SMORA_COMMON_RULES
//   （aix/action と同じ）＋下記の読み替えノートでカバーする。
//
// 設計原則（責務分離）:
//   AIX = 構造化コンテンツ（金額・空室・日程・物件名）の正 / このAPI = 橋渡し文のみ。
//   金額・空室状況・内覧日程・物件名・号室をLLMに創作させることは絶対禁止
//   （5大ハルシネーション事故の根絶）。会話履歴・予約送信AIXメッセージに実際に
//   記載がある事実のみ言及可能とする。
// ─────────────────────────────────────────────────────────────────────────────

// ─── 指示の優先順位＋共有ルールの読み替え（システム先頭・最上位）────────────
const PRIORITY_ORDER_NOTE = `【指示の優先順位（競合時はこの順で解決すること）】
ハルシネーション絶対禁止 > 役割の境界（橋渡し文のみ） > アクション別の書き方ガイド・訴求シナリオ指示 > Brain戦略 > DB学習ナレッジ・共有ルール > 実例の文体
※ 訴求シナリオ指示（後述の【シナリオ: 〜】）の禁止制約（比較表現禁止・既送付前提表現禁止等）は必ず守ること。ただし冒頭の具体的なフレーズは⭐実例の文体から学び、毎回異なる言い回しで書くこと（テンプレっぽさをなくす）。

【共有ルールの読み替え（重要）】
以下の共有ルール・実例には「通常AI返信では〜は生成禁止（AIXボタン専用）」という記述が含まれる。
あなたはその【AIX側】の橋渡し文を生成する担当である。したがって「AIX専用」とされている文面
（見積書カバー文「〜の御見積書となります」等）は、指定されたAIXボタン種別の担当範囲であれば生成してよい。
逆に、構造化データ（金額・空室状況・内覧日程・物件名・号室）の創作禁止はこのAPIでも絶対に適用される。`;

// ─── 静的システムプロンプト（byte-stable → prompt cache）─────────────────────
const STATIC_GEN_SYSTEM = `あなたはスモラ（賃貸仲介サービス）のLINE営業担当です。
AIXボタンで送付した（または送付予定の）構造化メッセージ（物件情報・見積書・空室確認結果など）に添える「橋渡し文（カバーメッセージ）」を、現在の会話の流れ・お客様の状況に合わせて1通だけ生成してください。

━━━━━━━━━━━━━━━━━━━━
【役割の境界 — 最重要】
━━━━━━━━━━━━━━━━━━━━
・金額・空室状況・内覧日程・入居可能日・物件詳細などの事実データは「AIXの構造化メッセージ」が正。あなたはその前後をつなぐ橋渡し文だけを書く
・橋渡し文の目的: お客様への呼びかけ→送付物の位置づけ説明→お客様の状況に合わせた一言→CTA（行動喚起）→柔らかい締め

━━━━━━━━━━━━━━━━━━━━
【🚫 ハルシネーション絶対禁止 — 全ルールより上位】
━━━━━━━━━━━━━━━━━━━━
・金額（初期費用・家賃・割引額・節約額）: 会話履歴または予約送信AIXメッセージに実際に記載がある値のみ書ける。記載がなければ金額は一切書かない
・空室状況の断定（「空いてます」「募集中です」「募集終了です」等）: 会話履歴に確認結果の記載がなければ書かない
・内覧日程・日付・曜日・時間の提案や創作: 絶対禁止（日程提示はAIX内覧日調整ボタンの担当領域）
・物件名・号室: 会話履歴または予約送信AIXメッセージに登場するもののみ使用可。創作・使い回しは絶対禁止
・お客様の希望条件・会話に出ていない駅名・路線・設備・築年数を事実のように書かない
・迷ったら固有の事実には触れず、汎用的な橋渡し表現にとどめる

━━━━━━━━━━━━━━━━━━━━
【スモラ品質ルール】
━━━━━━━━━━━━━━━━━━━━
・感嘆符は「！！」（全角2つ）のみ使用。「!」「！」1つは絶対禁止
・使える絵文字: 😊 😌 🙇‍♀️ 🌟 ✨（1〜2個まで。絵文字禁止指示がある場合は一切使わない）
・お客様の呼び方は「（実名）さん」。LINEでは「様」は絶対に使わない
　🚨 このプロンプト内の「〇〇」「○○」は説明用の伏せ字であり、名前・数値そのものではない。本文にはこれらの記号を絶対に書かない。呼びかけには【お客様情報】の「お客様名」に書かれた実名だけを使う。実名が「不明」と書かれている場合は呼びかけごと省略し、名前を出さずに書き出す
・冒頭挨拶: 通常は「（実名）さんお世話になっております！！」。本日すでにスタッフが送信済みの場合は挨拶行なし（名前行のみ「（実名）さん」または本題から）。「お待たせ致しました」は禁止語
・長すぎない。3〜7文程度でテンポよく
・「させて頂きます」「頂きます」を自然に多用する（スモラの文体の核心）
・締めは「お手隙の際にご査収ください😌！！」等で圧を下げる（絵文字禁止時は絵文字なしで）
・内覧後のシーンで感想を聞かない（「御礼+申込宣言+いつでもご連絡ください」の宣言形で締める）
・スモラの基本構成: ①直接の呼びかけ・位置づけ → ②スタッフの行動宣言（WE DO）→ ③柔らかい締め。お客様がすべきことは最小限にする

━━━━━━━━━━━━━━━━━━━━
【禁止ワード・表現】
━━━━━━━━━━━━━━━━━━━━
× 「スモラ」という会社名 → 「弊社」
× 「コスパ」表現 → 「好条件」
× 「共益費込み」→「家賃管理費込」
× 「即入居可能」→ 会話に明記がなければ絶対に書かない
× 「承りました」「ご確認のほど」「確認中です」「少々お待ちください」
× 「〇〇とのことですね」等のオウム返し
× 「ご共有頂き」→ お客様には「お送り頂き」
× 「仲介手数料を割引」→「初期費用を最大限割引させていただきます」
× マークダウン太字（**）等の記法（LINEは非対応）
× 謝罪の多用（「申し訳ございません」の連発）
× 敷金を初期費用削減として訴求（敷金は返還される預かり金）
× 号室の表記の書き換え（資料の「0906号室」「005B」は先頭の0・英字もそのまま）
× 「〇〇さん」「○○さん」「[名前]さん」等の伏せ字・プレースホルダーをそのまま本文に書く（実名に置換するか、名前不明なら呼びかけごと省略する）

━━━━━━━━━━━━━━━━━━━━
【文章構造の原則 — LINEで読める形にする】
━━━━━━━━━━━━━━━━━━━━
・1つの文に「設備」「立地」「費用」「おすすめ理由」を全部詰め込まない。訴求は必ず段落に分けて書く
・以下の段落構成で組み立てる（各段落は空行で区切る。該当する材料がない段落は丸ごと省略する）
　1段落目: 冒頭の呼びかけ＋挨拶／今回何をお送りしたかの宣言（1〜2文）
　2段落目: 物件の設備・間取り・広さ等の訴求（お客様の希望条件に合う点を優先。1〜2文）
　3段落目: 立地・アクセスの訴求（駅徒歩・エリア。材料があれば。1文）
　4段落目: 費用面の訴求（礼金・フリーレント・初期費用。材料があれば。1文）
　5段落目: CTA（内覧誘導または申込誘導）＋柔らかい締め（1〜2文）
・1段落は原則2文まで。3文以上になったら段落を割る
・読点で延々とつなげた長文（「〜で〜で〜と立地も良く〜」）は禁止。文を切って段落に分ける

━━━━━━━━━━━━━━━━━━━━
【訴求ポイントの選び方（何を書くかの優先順位）】
━━━━━━━━━━━━━━━━━━━━
・書ける材料が複数あるときは「お客様の希望条件・NG条件・潜在動機に直結するもの」から順に選ぶ。会話に出ていない軸を主役にしない
・優先順位: ①お客様が明示的に挙げた条件（設備・間取り・エリア・家賃上限）②潜在的な不安を解消する事実（費用・審査・入居時期）③その他の付加価値（立地・築年数等）
・費用の制約（家賃上限・初期費用を抑えたい・貯金が少ない等）が会話や希望条件に出ている場合、礼金0円・フリーレント・初期費用の割引など費用面のメリットが材料にあれば必ず1つ言及する（敷金は預かり金なので費用削減として訴求しない）
・立地（駅徒歩）だけを訴求して終わらせない。設備・費用の材料があるのに使わないのは訴求漏れ
・逆に材料がない項目を埋めるために事実を創作することは絶対禁止（ハルシネーション禁止が最上位）

━━━━━━━━━━━━━━━━━━━━
【根拠→結論の整合性（重要ルール）】
━━━━━━━━━━━━━━━━━━━━
・メリット・結論を述べるときは必ずその根拠となる物件の具体的な特徴を先に書く
  NG: 「初期費用を抑えられます」→ なぜ抑えられるかが不明
  OK: 「礼金0円なので初期費用をかなり抑えられます！」
  NG: 「駅近で便利です」→ 具体的データなし
  OK: 「○○駅まで徒歩△分なので通勤も楽です」
  NG: 「広めのお部屋です」→ 根拠なし
  OK: 「○○㎡あるので家具もゆったり置けます」
・根拠のない結論・メリット訴求は書かない（物件データに根拠がないなら言及しない）
・同じ結論フレーズ（「かなりオススメ出来るお部屋となります」等）を1通の中で繰り返さない（使うなら1回だけ）

━━━━━━━━━━━━━━━━━━━━
【出力】
━━━━━━━━━━━━━━━━━━━━
生成した本文のみを出力する。説明・前置き・補足コメント・選択肢の提示は一切書かない。`;

// ─── 共有ルールブロック（generate-reply / aix/action と同一ソース・byte-stable）──
const SHARED_RULES_SYSTEM = [
  `━━━━━━━━━━━━━━━━━━━━
【以下は本番LINE返信AIと共有のスモラルール（橋渡し文にも適用）】
━━━━━━━━━━━━━━━━━━━━`,
  SMORA_COMMON_RULES,
  SMORA_RULES,
  REAL_ESTATE_RULES,
  CURATED_REPLY_RULES,
  `【スモラの実返信パターン集の使い方】以下は実際のやりとりから抽出した文体・言い回しの参考。橋渡し文の役割（構造化データはAIXが正）と競合する部分は役割の境界を優先すること。
${SMORA_QUICK_PATTERNS}`,
].join("\n\n");

// ─── アクション別ガイド（正準キー: aix-taxonomy.ts の AIX_BUTTON_LABELS 準拠）──
const ACTION_GUIDES: Record<string, string> = {
  property_send:
    "物件ピックアップ送付の橋渡し文。名前呼びかけ→お探しした物件をお送りする旨→お客様の希望条件との合致点に軽く触れる→「お気に召されましたらご都合よろしいお日にちにご案内させて頂きます」等のCTA→ご査収の締め。物件の具体的スペックはAIX/会話に記載がある範囲のみ。上記の希望条件（エリア・間取り・家賃・設備等）と物件情報の合致点を最低2つ本文で具体的に言及すること。エリア・間取りが希望と異なる物件の場合は提案する理由（広さ重視のため等・会話履歴に根拠がある場合のみ）を1文添えること。",
  property_recommendation:
    "1件を特にオススメする橋渡し文。「（お客様の実名）さんにかなりオススメ出来るお部屋」のように実名で呼びかけて特別感を演出し（伏せ字のまま書かない）、希望条件とのパーソナライズに触れる。冒頭の入り方・比較表現の可否・CTA強度は後続の【訴求シナリオ】指示に必ず従う（比較選択型/代替新規提案型/初回提案型で全く異なる）。デメリットが会話上明らかな場合は先に開示して即メリットで転換。スペック・金額は会話/AIXに記載がある範囲のみ。上記の希望条件（エリア・間取り・家賃・設備等）と物件情報の合致点を最低2つ本文で具体的に言及すること。エリア・間取りが希望と異なる物件の場合は提案する理由（広さ重視のため等・会話履歴に根拠がある場合のみ）を1文添えること。",
  property_check_result:
    "管理会社等への確認結果を報告する際の橋渡し文。確認結果の中身（空室・金額・日付）はAIXの構造化メッセージが正なので断定して書かない。「確認結果をご報告いたします」の位置づけと次のアクション誘導のみを書く。",
  estimate_sheet:
    "見積書送付の橋渡し文。定型フレーズ「最大限割引しました初期費用の御見積書となります！！」を含める。金額は会話/AIXに記載がある値のみ（創作は絶対禁止・なければ金額は書かない）。CTAは「お気に召されましたらお申込みしお部屋抑えさせて頂きます！！」または内覧誘導。締めは「お手隙の際にご査収ください😌！！」。",
  viewing_invite:
    "内覧への誘導文。具体的な候補日時・曜日は絶対に書かない（日程提示はAIX内覧日調整の担当）。「ご都合よろしいお日にちにご案内させて頂きます」の形で相手に委ねる。",
  meeting_place:
    "内覧待ち合わせに関する橋渡し文。日時・住所などの確定情報はAIXが正なので創作しない。",
  greeting_viewing:
    "内覧当日・前後の挨拶/フォロー文。内覧後は感想を聞かず「御礼+申込サポート宣言+いつでもご連絡ください」で締める。",
  condition_hearing:
    "お部屋探し条件のヒアリング文。会話から既に判明している条件は聞き直さず、未取得の条件だけ軽く尋ねる。質問攻めにしない（2〜3項目まで）。",
  application_push:
    "申込へのクロージング文。前向きな反応を受けて「お申込みしお部屋抑えさせて頂きます」へ誘導。過度な圧はかけず、締めで圧を下げる。",
  followup_revive:
    "返信が止まったお客様への再接触文。責めない・重くしない。近況伺い+お手伝いできる旨+返信ハードルを下げる一言。",
  acknowledge_check:
    "確認依頼への受付宣言文。「募集状況確認させていただきます！！」の宣言のみ。確認結果・空室状況を先取りして書かない。",
};

// ─── 即2: purchase_signal_level → CTA強度ガイド（brain-core の4段階定義に対応）──
// brainが判定した購買シグナル強度をCTAの強さに翻訳して生成指示に含める
const SIGNAL_CTA_GUIDES: Record<string, string> = {
  peak: "申込直前の最強シグナル — 申込への具体的CTA（お部屋を抑える宣言）を明確に入れる",
  strong: "具体的検討シグナル — 次の一歩（内覧・申込）を積極的に促す",
  soft: "軽い興味段階 — CTAは軽めにして質問・提案で終える",
  none: "一般質問段階 — 売り込みCTAは入れない",
};

// ─── purchase_signal_level → 訴求シナリオのCTA強度を上書きする指示 ──────────────
// 「1件特にオススメ」は温度感に関係なく同じ強度の文面になっていた（2026-08-31）。
// シナリオ既定のCTA強度（比較選択型=中/初回提案型=軽め）より購買シグナルを優先させる。
// ※ engagement_stance='wait'（押してはいけない局面）のときは適用しない（brain-core M4 と同ゲート）
const SIGNAL_CTA_OVERRIDE: Record<string, string> = {
  peak: "🔥 購買シグナル peak（申込直前）— シナリオ既定のCTA強度より優先: 「お気に召されましたらお申込みしお部屋を抑えさせて頂きます！！」系の申込直結CTAを必ず入れる。内覧誘導だけで終わらせない",
  strong: "🔥 購買シグナル strong（具体的検討中）— シナリオ既定のCTA強度より1段強く: 内覧または申込のどちらに進むかを明示し、次の一歩を能動的に促す",
};

// ─── 「1件特にオススメ」（property_recommendation）の訴求シナリオ分岐 ─────────
// 同じ「1件オススメ」ボタンでも会話の流れによって訴求文脈が5種類あり、
// 冒頭・訴求構造・CTA強度が全く異なる（2026-08-29 / 08-31 / 09-01 訴求ずれ事故の恒久対策）:
//   compare         = 複数物件を送付済み → その中から1件に絞って推す（比較選択型）
//   new_listing     = 新たに募集に出た1件を単独で案内する（新着型）
//   alternative     = 指定物件が募集なし → 代わりの1件を新規提案（代替新規提案型）
//   followup_single = 送付実績はあるが「中でも」と言えるほどの複数はない → 新たな1件として提案（追加提案型）
//   first           = まだ何も送っていない → 初めての1件提案（初回提案型）
// フロントのピッカー選択（pickupType）→ 直前の空室確認結果（check_pattern）→
// この会話の物件送付実績（aix_usage_logs）の順でルールベース判定する（LLM推論任せにしない）。
//
// 【設計思想 — 他の状況適応パターンにも共通で適用する考え方】
// AIXの文面の「冒頭フレーム」は事実の宣言である（＝送った/送っていない・新着である/ない・
// 条件を広げた/広げていない）。したがって冒頭フレームは検証可能な事実
// （送付ログの件数・種別・鮮度、直前の空室確認結果、スタッフのピッカー選択）から
// **ルールベースで確定**させ、LLMには「そのフレームの中でどう書くか（文体・訴求点）」だけを任せる。
// 事実に反する冒頭（1件しか送っていないのに「これまでお送りした中でも」）は
// 顧客からの信頼を最も損なう事故であり、シナリオごとに
// 「使ってよい冒頭」と「絶対に使わない冒頭（リテラル文字列）」の両方を明示する。
// この構造は property_send の送付文脈（初回/継続/新着/条件広げ）にも同型で適用済み。
// 2026-09-21: 判定・ガイド・禁止表現・検査は app/lib/recommendation-frame.ts に出した。
//   ここにしか無かったため **AIX ボタン本体（aix/action）では1つも効いていなかった**
//   （実測: 生成ログ693件中シナリオが決まっていたのは74件＝10.7%）。両方の経路が同じ物を見る。
//   ※ 上の設計思想のコメントも recommendation-frame.ts に持っていってある。
// ピッカー種別に応じた補足ニュアンス（シナリオガイドに追記）
const PICKUP_TYPE_NOTES: Record<string, string> = {
  "新着1件": "※新着で出たばかりの物件。鮮度（新着ですぐ動いた方がよい旨）を訴求してよい（会話履歴と矛盾しない範囲で）",
  "条件広げピックアップ": "※ご希望条件を少し広げてお探しした物件。その旨に軽く触れてよい",
};

// ─── property_send（物件ピックアップ）の送付文脈ガイド ──────────────────────────
// 同じ「物件ピックアップした」ボタンでも、初回か継続かで冒頭・訴求構造が変わる
const PROPERTY_SEND_CONTEXT_GUIDE: Record<string, string> = {
  first: `【初回物件送付】まだ物件をお送りしていないお客様への初めてのピックアップ。
・希望条件との適合を前面に出す（冒頭の具体的な言い回しは⭐実例の文体から学んで多様に書くこと）
・🚫「先日お送りした」「以前ご紹介した」等、既送付を前提にした表現は絶対禁止`,
  followup: `【継続物件送付（追加ピックアップ）】既に物件をお送りしたことがあるお客様への追加提案。
・前回との連続性（追加で探してきた感）を伝える（冒頭の具体的な言い回しは⭐実例の文体から学んで多様に書くこと）
・前回と重複しない新しい提案であることを伝える`,
  new_listing: `【新着物件】新着で出た物件を即案内する文脈。
・「新着」「出たばかり」という鮮度を冒頭で明確に伝える（具体的な言い回しは⭐実例の文体から学んで多様に書くこと）
・「人気で早く決まることが多い」等の動機付けを添えてよい（煽りにならない範囲で）`,
  expand: `【条件広げ物件】希望条件を少し広げてお探しした物件。
・条件を少し広げてお探ししたことを素直に伝える（冒頭の具体的な言い回しは⭐実例の文体から学んで多様に書くこと）
・条件を広げてもお客様が重視しているポイント（具体名で書く）は守れていると伝える`,
};

// 送付文脈キー → 埋め込み検索用の日本語ラベル（RAGクエリに載せて実例を文脈別に散らす）
const PROPERTY_SEND_CONTEXT_LABELS: Record<string, string> = {
  first: "初回物件送付（まだ物件を送っていないお客様への初めてのピックアップ）",
  followup: "継続物件送付（既に物件を送付済みのお客様への追加ピックアップ）",
  new_listing: "新着物件の即案内（出たばかりの物件・鮮度訴求）",
  expand: "条件広げ物件送付（希望条件を少し広げてお探しした物件）",
};

function resolvePropertySendContext(args: {
  pickupType: string | null | undefined;
  priorSentPropertyCount: number;
}): string {
  if (args.pickupType === "新着まとめ" || args.pickupType === "新着1件") return "new_listing";
  if (args.pickupType === "条件広げまとめ" || args.pickupType === "条件広げピックアップ") return "expand";
  if (args.pickupType === "初回まとめ") return "first";
  if (args.pickupType === "継続まとめ" || args.pickupType === "継続ピックアップ") return "followup";
  // ピッカー情報なし: 送付実績から推定
  return args.priorSentPropertyCount === 0 ? "first" : "followup";
}

// check_pattern（物件確認結果）→ 日本語ラベル（シナリオ判定事実の注入用）
const CHECK_PATTERN_LABELS: Record<string, string> = {
  available: "空室あり（募集中）",
  alternative: "指定のお部屋は満室・同じ建物の別のお部屋なら募集あり",
  unavailable: "募集終了（満室・空きなし）",
  exclusive: "専任物件のためご紹介不可",
  move_in_date: "入居可能日を確認した",
  interior_photo: "室内写真を確認した",
  other_room_check: "別のお部屋について確認した",
};

// ─── リクエスト型 ────────────────────────────────────────────────────────────
type GenerateRequestBody = {
  actionType?: string | null;       // 正準キー（property_send 等）。null時はactionCategoryのみで生成
  actionCategory?: string;          // 選択中のAIXカテゴリ名（例: 物件ピックアップした【AIX】）
  conversationId?: string;
  customerName?: string;
  conversationState?: string;
  recentMessages?: Array<{ sender: string; text: string; imageUrl?: string; isAix?: boolean; rawCreatedAt?: string }>;
  customerConditions?: string;
  noEmoji?: boolean;
  pendingScheduledMessages?: Array<{ text: string | null }>;
  staffMessagedToday?: boolean;
  // 「1件特にオススメ」シナリオ判定用（property_recommendation のみ使用）
  pickupType?: string | null;          // AIXピッカーで選択したピックアップ種別（代替ピックアップ等）
  lastAixCheckPattern?: string | null; // この会話の直近 property_check_result の結果生値（unavailable等）
  // お客様プロフィール（AI分析: 決まるパターン・人物像）— property_customers.ai_summary
  customerSummary?: string | null;
  /**
   * 2026-09-20 竹内「AIX テンプレート、AIX の内容との関係性での生成が重要」:
   * **直前に AIX で送った本文（1通目）**。画面の postAixContext.sentMessage をそのまま渡す。
   * これが無いと AI は会話履歴だけを頼りに書き、1通目で既に言ったことを繰り返す
   * （設計知見「AI が『材料が無い』と言い出したら、それは出口ではなく入口の問題」＝見積書の2通目と同じ構造）。
   * 実測（scripts/audit-aix-chain-coherence.ts・90日・1,419組）では**スタッフはほぼ繰り返さない**:
   *   1通目「ピックアップしました」33.3% → 2通目で未来形 0.2% ／ ご査収の重ね 3.1% ／ 挨拶の重ね 2.0%
   */
  sentMessage?: string | null;
  /** 2026-10-01: sentMessage の出どころ（post_aix＝送った直後の画面／history＝会話の履歴の最後の AIX）。ログ用 */
  sentMessageSource?: string | null;
  /**
   * 2026-10-01: テンプレート一覧の「訴求方法を選択する！！」（🏃内覧に誘う＝viewing／🚀申込へ押し込む＝apply）。
   * 押している時は物件オススメの2通目の締めをこれにする（刺さり具合の判定 resolveRecommendCta よりスタッフの選択が先）
   */
  ctaPreference?: "viewing" | "apply" | null;
};

const STATE_LABEL: Record<string, string> = {
  first_reply: "初回応対", condition_hearing: "条件ヒアリング",
  property_search: "物件探し中", property_recommendation: "物件提案中",
  viewing: "内覧調整", estimate_request: "見積依頼",
  availability_check: "空室確認", application: "申込中",
  screening: "審査中", contract: "契約中", closed_won: "成約済み",
};

// ─── 相対時刻ラベル生成（会話履歴の各メッセージに付与）──────────────────────
function relativeTimeLabel(isoStr: string | undefined, nowMs: number): string {
  if (!isoStr) return "";
  const diffMs = nowMs - new Date(isoStr).getTime();
  const diffH = diffMs / 3600000;
  if (diffH < 0.5) return "（たった今）";
  if (diffH < 2) return "（約1〜2時間前）";
  if (diffH < 12) return "（今日）";
  if (diffH < 36) return "（昨日）";
  const diffD = Math.round(diffH / 24);
  return `（${diffD}日前）`;
}

// ─── 伏せ字プレースホルダーの決定論ガード（生成後・最終防衛線）─────────────────
// プロンプト内の説明用伏せ字「〇〇」をモデルが本文へそのまま転記する事故の恒久対策
// （2026-09-01: 「〇〇さんにかなりオススメ出来るお部屋となります」が実送信文面に出た）。
// 実名があれば置換し、名前不明なら呼びかけごと削除する。
// 削除時は名前に直結した助詞（「〇〇さんのお引越し」の「の」）も落とす — 残すと
// 「のお引越し…」という壊れた文になる（validate-reply の enforceCustomerName と同方針）。
const NAME_PLACEHOLDER_ADDRESS_RE = /[〇○]{2,}\s*(?:さん|サン|様|さま)([、,]?[ 　]*)([のがにをへ])?/g;
function fixNamePlaceholderAddress(text: string, name: string): { text: string; fixed: boolean } {
  let fixed = false;
  const out = text.replace(NAME_PLACEHOLDER_ADDRESS_RE, (_m, tail: string, particle: string | undefined) => {
    fixed = true;
    const p = particle ?? "";
    if (name) return `${name}さん${tail}${p}`;
    // 読点・空白が無い＝助詞が名前に直結している場合のみ助詞も落とす
    return tail === "" ? "" : p;
  });
  // 呼びかけ削除で行頭に残った読点・空白を整理
  return { text: fixed ? out.replace(/^[、,　 ]+/gm, "") : out, fixed };
}

// ─── ナレッジ使用テレメトリ（generate-reply の incrementKnowledgeUsage と同実装）───
// used_count を +1、last_used_at を更新。
// after(): レスポンス返却後もサーバーレス実行コンテキストが凍結される前に完了を保証
function incrementKnowledgeUsage(ids: string[]): void {
  if (!ids.length) return;
  after(async () => {
    try {
      await supabase.rpc("increment_knowledge_used_count", { p_ids: [...new Set(ids)] });
    } catch {
      // 使用回数更新の失敗は生成に影響させない
    }
  });
}

// ─── RAG: ai_reply_knowledge のスコアリング・バケット整形 ─────────────────────
// generate-reply の fetchKnowledge と同じ複合スコア（similarity × importance × 鮮度）＋
// バケット分割（差分学習/修正対比/絶対ルール/パターン/フレーズ）の縮約版。
type KnowledgeHit = {
  id: string;
  title: string;
  content: string;
  category: string;
  importance: number;
  hypothesis_status?: string | null;
  created_at?: string;
  similarity: number;
};

function buildKnowledgeSections(rows: KnowledgeHit[]): { text: string; usedIds: string[] } {
  const scored = rows
    .filter((r) => (r.similarity ?? 0) >= 0.5 && r.hypothesis_status !== "rejected" && (r.content ?? "").trim().length > 0)
    .map((r) => {
      // 鮮度ファクター（半減期180日）: 古い誤傾向ナレッジより新しい修正ナレッジを優先
      const daysSince = r.created_at
        ? (Date.now() - new Date(r.created_at).getTime()) / (1000 * 60 * 60 * 24)
        : 180;
      const recencyFactor = Math.pow(0.5, daysSince / 180);
      const confirmedBonus = r.hypothesis_status === "confirmed" ? 0.05 : 0;
      return { ...r, score: (r.similarity ?? 0.5) * ((r.importance || 5) / 10) * (0.5 + 0.5 * recencyFactor) + confirmedBonus };
    })
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { text: "", usedIds: [] };

  const diffLearned = scored.filter((r) => r.title?.includes("差分学習")).slice(0, 4);
  const correctionPairs = scored.filter((r) => r.title?.includes("修正対比")).slice(0, 3);
  // 絶対ルールは confirmed / legacy(null) のみ（未検証hypothesisの混入を防ぐ — generate-reply と同方針）
  const critical = scored.filter((r) =>
    r.category === "principle" && (r.importance ?? 0) >= 8 &&
    (r.hypothesis_status === "confirmed" || r.hypothesis_status == null)
  ).slice(0, 8);
  const patterns = scored.filter((r) => r.category === "pattern" && !r.title?.includes("差分学習") && !r.title?.includes("修正対比")).slice(0, 4);
  const phrases = scored.filter((r) => r.category === "phrase").slice(0, 4);

  const sections: string[] = [];
  if (diffLearned.length > 0) {
    sections.push("【🔴 AIが過去に間違えたパターン（最優先・必ず守る）】\n" + diffLearned.map((k, i) => `${i + 1}. ${k.content}`).join("\n"));
  }
  if (correctionPairs.length > 0) {
    sections.push("【🟠 スタッフが修正したポイント】\n" + correctionPairs.map((k, i) => `${i + 1}. ${k.content}`).join("\n"));
  }
  if (critical.length > 0) {
    sections.push("【⚠️ 絶対ルール（状況関連・DB学習）】\n" + critical.map((k, i) => `${i + 1}. ${k.content}`).join("\n"));
  }
  if (patterns.length > 0) {
    sections.push("【スモラの営業パターン・原則】\n" + patterns.map((k, i) => `${i + 1}. ${k.content}`).join("\n"));
  }
  if (phrases.length > 0) {
    sections.push("【スモラのフレーズ】\n" + phrases.map((k) => `「${k.content}」`).join("　"));
  }
  // M1: 注入したナレッジのidを収集（incrementKnowledgeUsage テレメトリ用）
  const usedIds = [...diffLearned, ...correctionPairs, ...critical, ...patterns, ...phrases]
    .map((k) => k.id)
    .filter(Boolean);
  return { text: sections.join("\n\n"), usedIds };
}

// ─── セクションラッパー（RAG本経路とH3フォールバック経路で共有・二重定義禁止）───
function wrapKnowledgeSection(knText: string): string {
  return `━━━━━━━━━━━━━━━━━━━━\n【参照すべき重要ルール（DB学習ナレッジ・セクション順に優先度が高い）】\n━━━━━━━━━━━━━━━━━━━━\n${knText}\n\n`;
}
function wrapExamplesSection(exText: string): string {
  return `━━━━━━━━━━━━━━━━━━━━\n${exText}\n\n【⭐実例の使い方】上記実例は文体・テンポ・絵文字・感嘆符の参考。言い回しの雰囲気を再現すること。ただし実例に「今すぐ」「即入居可能」等の禁止パターンが含まれていても、現行の禁止ルール・挨拶ルール・ハルシネーション禁止を必ず優先すること。\n\n`;
}

// ─── RAG: ai_reply_examples（⭐実例）の整形 ──────────────────────────────────
type ExampleHit = {
  customer_message: string;
  sent_reply: string;
  conversation_state: string;
  is_starred: boolean;
  reply_angle: string | null;
  aix_action?: string | null;   // match_aix_reply_examples 由来の実例のみセットされる
  outcome_status?: string | null; // match_aix_reply_examples 由来の実例のみセットされる（成約還流）
  similarity: number;
};

// similarity閾値フィルタ＋⭐/reply_angleブーストの複合スコアで降順ランキング
// （line_reply実例は0.5 / AIX実例は多様性が高いため0.45に緩和して呼び出す）
function rankExamples(rows: ExampleHit[], minSimilarity = 0.5): ExampleHit[] {
  return rows
    .filter((ex) => (ex.similarity ?? 0) >= minSimilarity && (ex.sent_reply ?? "").trim().length > 0)
    .sort((a, b) => {
      const scoreA = a.similarity + (a.is_starred ? 0.15 : 0) + (a.reply_angle ? 0.1 : 0);
      const scoreB = b.similarity + (b.is_starred ? 0.15 : 0) + (b.reply_angle ? 0.1 : 0);
      return scoreB - scoreA;
    });
}

// ランキング済み実例リストをプロンプトセクション文字列に整形（並び順は保持する）
function formatExamplesSection(ranked: ExampleHit[]): string {
  if (ranked.length === 0) return "";
  return "【⭐ スモラの実際の返信例（状況が類似した実例・類似度順）— 文体・言い回し・感嘆符・絵文字・テンポをこの例から忠実に再現すること。構成・内容は橋渡し文の役割（構造化データはAIXが正）を最優先】\n" +
    ranked.map((ex, i) =>
      `[例${i + 1}${ex.is_starred ? "⭐" : ""}${ex.aix_action ? "・AIX橋渡し文実例" : ""}]\nお客様: 「${safeSlice(ex.customer_message ?? "", 200)}」\nスモラ: 「${safeSlice(neutralizeWaitedInExample(ex.sent_reply), 600)}」`
    ).join("\n\n");
}

function buildExamplesSection(rows: ExampleHit[]): string {
  return formatExamplesSection(rankExamples(rows).slice(0, 6));
}

// ─── POST ────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  // 2026-10-01 YUMA の DeepSeek テストで見つけた穴（静かに壊れる・開発サーバだけ）: この経路は Claude を fetch で直に呼ぶのに、
  //   返信生成・AIX 本体・ブレインにある「包みの付け直し」（ensureLlmFetchChainInDev・willRouteAlt）を通していなかった。
  //   Next の resetFetch で包みが外れると、LLM_TEST_MODE=deepseek-all でも Claude に行き、llm_usage_logs にも残らない（10/01 の約25回が記録0）。
  //   本番（NODE_ENV=production）ではどちらも何もしない
  await (await import("@/app/lib/llm-usage-recorder")).ensureLlmFetchChainInDev().catch(() => {});
  try { (await import("@/app/lib/llm-alt-provider")).willRouteAlt("aix_template"); } catch { /* 判定だけ・失敗しても生成は続ける */ }
  let body: GenerateRequestBody;
  try {
    body = await req.json() as GenerateRequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const {
    actionType,
    actionCategory,
    conversationId,
    customerName,
    conversationState,
    recentMessages,
    customerConditions,
    noEmoji,
    pendingScheduledMessages,
    staffMessagedToday,
    pickupType,
    lastAixCheckPattern,
    customerSummary,
    sentMessageSource,
    ctaPreference,
  } = body;
  // 2026-09-20 竹内「AIX テンプレート、AIX の内容との関係性での生成が重要」: 直前に送った1通目
  // 2026-10-01 竹内「✨この会話に合った文を生成のところをこの改善したようにする」: 画面が渡さない時（古い画面・後から開いた時）は、
  //   今の会話の履歴の最後の AIX（選んだ種類と同じ形の時だけ）を1通目として使う（画面と同じ関数 aix-template-source.ts）
  const sentFallback = resolveTemplateSentMessage({ actionType, postAixSent: body.sentMessage ?? null, recent: recentMessages ?? [] });
  const sentMessage = sentFallback.text;
  console.log(JSON.stringify({ tag: "aix-template-generate:sent-message", actionType: actionType ?? null, source: body.sentMessage ? (sentMessageSource ?? "post_aix") : sentFallback.source, len: (sentMessage ?? "").length, ctaPreference: ctaPreference ?? null }));

  // 2026-09-22 竹内「今日初めてじゃないときはお世話になっておりますはつかわない」: 画面の判定（AIX テンプレートは false 固定だった）に頼らず DB でも見る
  const staffSentToday = !!staffMessagedToday || await staffSentTodayFromDb(conversationId as string | undefined);

  if (!actionType && !actionCategory) {
    return NextResponse.json({ ok: false, error: "actionType or actionCategory is required" }, { status: 400 });
  }

  // ── 顧客名の確定（generate-reply と同一の妥当性ゲート + DBフォールバック）──────
  // 🚨 2026-09-01 バグ: 呼び出し元（TemplateModal → page.tsx の extractPreferredName）は
  // 「会話履歴でスタッフが呼んでいた名前 → LINE表示名」の2段でしか名前を解決しておらず、
  // 表示名が記号・絵文字のみ（「⭐」等）だと空文字が渡ってくる。本APIにはDBフォールバックが
  // 無かったため、そのまま `〇〇さん` という伏せ字がプロンプトに入り、生成文にも
  // 「〇〇さんにかなりオススメ出来る」と伏せ字のまま出力されていた。
  // generate-reply と同じく property_customers.customer_name → conversations.customer_name を
  // 辿って実名を復元し、いずれも実名の形でなければ「名前なし」で生成する（誤名で呼ぶより安全）。
  // 2026-09-21 竹内（黒明様お部屋探し）: LINE グループの表示名（【グループ】…）は人の名前ではないので呼び名に使わない
  let resolvedCustomerName = isGroupConversationName(customerName)
    ? ""
    : isPlausiblePersonName(customerName)
    ? (customerName ?? "").trim()
    : (() => {
        const stripped = stripNonNameChars(customerName ?? "");
        return isPlausiblePersonName(stripped) ? stripped : "";
      })();

  // ── customerConditions ground-truth フォールバック ─────────────────────────
  // body.customerConditions が空のとき、conversations → property_customers を辿って
  // 希望条件をDBから復元する（generate-reply と同方針。未紐付け会話の条件ゼロ生成を防ぐ）
  let resolvedCustomerConditions = customerConditions || "";
  if (conversationId && (!resolvedCustomerConditions.trim() || !resolvedCustomerName)) {
    const { data: convLink } = await supabase
      .from("conversations")
      .select("property_customer_id, customer_name")
      .eq("id", conversationId)
      .maybeSingle();
    const convName = ((convLink as { customer_name?: string | null } | null)?.customer_name ?? "").trim();
    let pcName = "";
    if (convLink?.property_customer_id) {
      const { data: pc } = await supabase
        .from("property_customers")
        .select("customer_name, desired_area, floor_plan, rent_max, walk_minutes, move_in_time, preferences, ng_points, other_requests")
        .eq("id", convLink.property_customer_id)
        .maybeSingle();
      if (pc) {
        pcName = ((pc as { customer_name?: string | null }).customer_name ?? "").trim();
        if (!resolvedCustomerConditions.trim()) {
          resolvedCustomerConditions = [
            pc.desired_area ? "エリア: " + pc.desired_area : "",
            pc.floor_plan ? "間取り: " + pc.floor_plan : "",
            pc.rent_max ? "家賃上限: " + Math.floor(pc.rent_max / 10000) + "万円" : "",
            pc.walk_minutes ? "駅徒歩: " + pc.walk_minutes + "分以内" : "",
            pc.move_in_time ? "入居希望: " + pc.move_in_time : "",
            pc.preferences ? "希望: " + pc.preferences : "",
            pc.ng_points ? "NG条件: " + pc.ng_points : "",
            pc.other_requests ? "その他: " + pc.other_requests : "",
          ].filter(Boolean).join(" / ").slice(0, 1000);
        }
      }
    }
    if (!resolvedCustomerName) {
      // property_customers（スタッフが実名に修正できる列）→ conversations（LINE表示名由来）の順
      resolvedCustomerName =
        [pcName, isGroupConversationName(convName) ? "" : convName].map((n) => stripNonNameChars(n)).find((n) => isPlausiblePersonName(n)) ?? "";
      if (!resolvedCustomerName) {
        console.warn("[aix-template-generate] 実名として使える顧客名なし（名前なしで生成）:", {
          conversationId, passed: customerName ?? "", pcName, convName,
        });
      }
    }
  }

  const actionLabel = (actionType && AIX_BUTTON_LABELS[actionType]) || actionCategory || "AIXメッセージ";
  const actionGuide = (actionType && ACTION_GUIDES[actionType]) || "";

  // 5段階正規化ステート（実例/フレーズ検索のエイリアス解決に使用）
  const normalizedState = normalizeStatus(conversationState || "hearing");

  // M4: 申込誘導・内覧誘導のアクション専用ナレッジバケット
  // （generate-reply の applying_pattern / viewing_pattern 専用バケットと同方針 —
  //   pgvector経路のバケットから漏れるため専用クエリで必ず届ける）
  const actionBucketCategory =
    actionType === "application_push"
      ? "applying_pattern"
      : actionType === "viewing_invite" || actionType === "greeting_viewing"
        ? "viewing_pattern"
        : null;

  // ── JST現在時刻 ─────────────────────────────────────────────────────────
  const nowJst = new Date(Date.now() + 9 * 3600 * 1000);
  const jstHour = nowJst.getUTCHours();
  const jstMinute = nowJst.getUTCMinutes();
  const jstDayNames = ["日", "月", "火", "水", "木", "金", "土"];
  const jstDayOfWeek = jstDayNames[nowJst.getUTCDay()];
  const jstDateStr = `${nowJst.getUTCMonth() + 1}/${nowJst.getUTCDate()}(${jstDayOfWeek})`;
  const jstTimeStr = `${jstHour}時${jstMinute < 10 ? "0" : ""}${jstMinute}分`;

  // 管理会社営業時間外かどうか（9時前・18時以降）
  const isMgmtOutOfHours = jstHour < 9 || jstHour >= 18;
  const isLateNight = jstHour >= 21;
  const jstContextNote = `現在: ${jstDateStr} ${jstTimeStr}（JST）` +
    (isMgmtOutOfHours ? " ※管理会社営業時間外（即日確認を約束しない）" : "") +
    (isLateNight ? " ※深夜帯（冒頭に「夜分に失礼いたします！！」を検討）" : "");

  // ── 最終顧客メッセージからの経過時間 ──────────────────────────────────────
  const lastCustomerMsg = (recentMessages ?? [])
    .filter(m => m.sender === "customer" && m.rawCreatedAt)
    .slice(-1)[0];
  let elapsedLabel = "";
  if (lastCustomerMsg?.rawCreatedAt) {
    const diffMs = Date.now() - new Date(lastCustomerMsg.rawCreatedAt).getTime();
    const diffHours = diffMs / 3600000;
    if (diffHours < 1) elapsedLabel = "即レス文脈（1時間以内）";
    else if (diffHours < 8) elapsedLabel = "当日内（数時間後）";
    else if (diffHours < 30) elapsedLabel = "翌日以内";
    else if (diffHours < 72) elapsedLabel = "2〜3日後（追客文脈）";
    else elapsedLabel = "3日以上経過（追客文脈・返信ハードルを下げる）";
  }

  // ── Brain戦略（AIX-META）: あれば方向性として利用 ────────────────────────
  // 即2: ローカル独自定義を廃止し brain-core の SuggestedAixMeta を単一ソースとして参照
  // （型乖離バグの再発防止 — 過去に rent_max 円/万円ズレ・ng_properties デッドコードが同因で発生）。
  // DB内の旧世代 meta に残る形状（preferences: string[] / last_aix_history: string[] /
  // ng_properties: string[]）のみ Legacy 差分として上書き許容する。
  type BrainMetaPsp = {
    area?: string | null;
    floor_plan?: string | null;
    rent_max?: number | null;             // ※ brain-core は円単位の生値で格納（表示時は万円に変換）
    walk_minutes?: number | null;
    move_in_time?: string | null;
    preferences?: string | string[] | null;  // brain-core（SuggestedAixMeta）は string | null・旧metaは string[]
    ng_points?: string | null;
    ng_properties?: Array<string | { property_name: string; room_no?: string | null }>;
    search_urgency?: string;
    [key: string]: unknown;
  };
  type BrainMeta = Omit<NonNullable<SuggestedAixMeta>, "last_aix_history" | "property_search_params"> & {
    last_aix_history?: string | string[] | null;  // brain-core は string | null・旧metaは string[]
    property_search_params?: BrainMetaPsp | null;
  };

  // ── 並列フェッチ①: Brain戦略 + DB学習資産（generate-reply と同一キャッシュ経由）──
  // 各フェッチはエラーでも生成を止めない（資産なしで生成続行 — generate-reply と同方針）
  const [convResult, topPrinciples, lossPatterns, phraseList, dbRulesGeneric, dbRulesAction, actionBucketRes, aixTemplateExRes, aixUsageLogsRes] = await Promise.all([
    conversationId
      ? supabase.from("conversations").select(BRAIN_META_RESTORE_COLUMNS).eq("id", conversationId).single()
      : Promise.resolve({ data: null }),
    getCachedTopPrinciples().catch((err) => { console.error("[aix-template-generate] topPrinciples失敗:", err); return []; }),
    getCachedLossPatterns().catch((err) => { console.error("[aix-template-generate] lossPatterns失敗:", err); return []; }),
    getCachedPhrases(resolvePhraseCategories(normalizedState)).catch((err) => { console.error("[aix-template-generate] phrases失敗:", err); return [] as string[]; }),
    getCachedPromptRules("generate_reply", { conversation_state: normalizedState })
      .catch((err) => { console.error("[aix-template-generate] promptRules失敗:", err); return ""; }),
    // 即1: LEARN-AIXルール配線 — aix-weekly-learning / analyze-diffs が action_type=AIXアクション別に
    // 蓄積する編集差分学習ルール（LEARN-AIX-*）＋アクション専用FEEDBACK等を注入する。
    // includeGlobal=false のため上の generate_reply フェッチ（action_type='generate_reply' OR NULL）とは
    // 取得行が排他 → 重複注入なし。includeLearnAix=true で LEARN-AIX-* の除外を解除。
    actionType
      ? getCachedPromptRules(actionType, { conversation_state: normalizedState }, false, true)
          .catch((err) => { console.error("[aix-template-generate] promptRules(action)失敗:", err); return ""; })
      : Promise.resolve(""),
    // M4: アクション専用ナレッジバケット（application_push → applying_pattern / 内覧系 → viewing_pattern）
    actionBucketCategory
      ? supabase
          .from("ai_reply_knowledge")
          .select("id, title, content, importance")
          .eq("category", actionBucketCategory)
          .neq("hypothesis_status", "rejected")
          .order("importance", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(4)
      : Promise.resolve({ data: null }),
    // A-1: ⭐スター付き【AIX】テンプレート実例のみ（entry_source='aix_template' + 同一 aix_action）
    // 実例の主経路は pgvector（match_aix_reply_examples）に一本化したが、⭐は
    // 「スタッフが明示的に最優秀と認定した採用実績」でありベクトル類似度では拾えないため
    // 最大2件だけ固定シードとして残す（2026-08-31 limit 6 → ⭐限定2件に縮小）
    // 2026-09-01: 母集団を8件に拡大し、訴求シナリオと冒頭フレームが一致する⭐を優先して
    // 2件に絞る（⭐の大半が「お送りした中でも〜」始まりで新着型の生成を汚染していたため）
    actionType
      ? supabase
          .from("ai_reply_examples")
          .select("customer_message, sent_reply, conversation_state, is_starred, reply_angle, aix_action, outcome_status")
          .eq("entry_source", "aix_template")
          .eq("aix_action", actionType)
          .eq("is_starred", true)
          .order("created_at", { ascending: false })
          .limit(8)
      : Promise.resolve({ data: null }),
    // ※ A-2（entry_source='aix_action' の actionType固定直クエリ）は削除。
    //    全員同じ実例セットになりテンプレ感の原因だったため match_aix_reply_examples で代替（2026-08-31）
    // シナリオ判定用: この会話のAIX使用ログ（物件送付実績・直前の空室確認結果）
    // フロントの pickupType / lastAixCheckPattern が来ない場合（リロード後・別導線）のDBフォールバック
    // property_send でも送付回数ベースの角度分岐に使用する（初回まとめ / 継続まとめ判定）
    conversationId && (actionType === "property_recommendation" || actionType === "property_send")
      ? supabase
          .from("aix_usage_logs")
          .select("aix_type, check_pattern, send_keyword, created_at")
          .eq("conversation_id", conversationId)
          .in("aix_type", ["property_send", "property_recommendation", "property_check_result"])
          .order("created_at", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: null }),
  ]);
  // 2026-09-13 監査 抜け1: 下書きを表示すると suggested_aix_meta が消えるため、✨ を押す時点ではほぼ常にブレインの判断なしだった。
  //   表示で消えただけ（控えが最新のお客様発言を見た本分析）なら last_brain_meta から戻す
  const brainMeta = conversationId
    ? ((await resolveBrainMetaForGeneration(conversationId, (convResult.data ?? null) as BrainMetaRow | null, "aix-template-generate")).meta as BrainMeta | null)
    : null;

  // 汎用ルール（generate_reply+global）とアクション別ルール（LEARN-AIX-*含む）を結合
  const dbRules = [dbRulesGeneric, dbRulesAction].filter(Boolean).join("\n");

  // ── 「1件特にオススメ」訴求シナリオ判定（compare / alternative / first）──────
  type AixUsageLogRow = { aix_type: string | null; check_pattern: string | null; send_keyword?: string | null; created_at: string };
  const aixUsageLogs = (aixUsageLogsRes?.data ?? []) as AixUsageLogRow[];
  // created_at 降順（新しい順）で取得済み
  const propertyLogs = aixUsageLogs.filter(
    (l) => l.aix_type === "property_send" || l.aix_type === "property_recommendation"
  );
  const sentPropertyLogCount = propertyLogs.length;
  // 🚨 今回送信した property_recommendation 自身が既に aix_usage_logs に入っている。
  // AixModal → onAfterSend → log-aix-usage は post_aix テンプレ生成より先に走るため、
  // 生の件数をそのまま使うと「送付実績1回」＝ compare 判定になり、1件しか送っていない
  // 会話でも「お送りさせて頂きましたお部屋の中でも〇〇が〜」という事実と異なる比較表現が
  // 生成されていた（2026-08-31 訴求ずれ事故）。今回送信分を差し引いた「事前送付回数」で判定する。
  const CURRENT_SEND_WINDOW_MS = 30 * 60 * 1000;
  const newestPropertyLog = propertyLogs[0];
  const currentSendAlreadyLogged = Boolean(
    newestPropertyLog &&
    newestPropertyLog.aix_type === "property_recommendation" &&
    Date.now() - new Date(newestPropertyLog.created_at).getTime() < CURRENT_SEND_WINDOW_MS
  );
  // 今回送信分を除いた「事前送付ログ」— 件数だけでなく種別（まとめ/1件）と鮮度も見る。
  // 「お送りした中でも」は“複数の中から選んだ”事実の宣言なので、実質1件しか送っていない
  // 会話では使えない（＝新着/追加提案として紹介するのが正）。
  const priorPropertyLogs = currentSendAlreadyLogged ? propertyLogs.slice(1) : propertyLogs;
  const priorSentPropertyCount = priorPropertyLogs.length;
  const priorBulkSendCount = priorPropertyLogs.filter((l) => l.aix_type === "property_send").length;
  const priorSingleSendCount = priorPropertyLogs.filter((l) => l.aix_type === "property_recommendation").length;
  const hoursSinceLastSend = priorPropertyLogs.length > 0
    ? (Date.now() - new Date(priorPropertyLogs[0].created_at).getTime()) / 3600000
    : null;
  // 2026-09-18 竹内（𝒮 さん事例）「今の状況はブレインが分かっているんやから、それと AIX のところリンクさせて」:
  //   状況（送った物件の件数・退去予定・内覧可否）はブレインの判断を1つの関数から読む＝AIX（aix/action）と同じ物。
  //   ※上の priorSentPropertyCount は「AIX の送付**回数**」。ここで使うのは「送った**物件の件数**」で別物。
  //     まとめ送付1回で5件送っていても回数は1なので、回数で比較の言い方を落とすと事実と合わない。
  const recommendState = resolvePropertySendState({
    brainMeta,
    recentMessages: Array.isArray(recentMessages) ? recentMessages as Array<{ sender?: string | null; text?: string | null }> : [],
    fallbackSentCount: priorSentPropertyCount,
  });
  const propertySendFacts: PropertySendFacts = {
    priorSentPropertyCount,
    priorBulkSendCount,
    priorSingleSendCount,
    hoursSinceLastSend,
    // 訴求シナリオ（比較フレームが使えるか・送付実績があるか）もブレインの件数で決める
    brainSentPropertyCount: recommendState.sentSource === "brain" ? recommendState.sentPropertyCount : null,
  };
  // 直近の property_check_result の結果。ただし確認より後に物件送付AIXが2件以上ある場合は
  // 既に別の文脈へ進んでいるため無効化（古い「募集なし」で代替シナリオに誤爆しない）。
  // ※ 送付1件は許容: 代替フローでは「確認(募集なし)→代替物件AIX送信→橋渡し文生成」の順になるため
  let dbLastCheckPattern: string | null = null;
  let checkIsStale = false;
  {
    let sendsAfterCheck = 0;
    for (const l of aixUsageLogs) {
      if (l.aix_type === "property_check_result") {
        dbLastCheckPattern = l.check_pattern;
        checkIsStale = sendsAfterCheck >= 2;
        break;
      }
      if (l.aix_type === "property_send" || l.aix_type === "property_recommendation") sendsAfterCheck++;
    }
  }
  const effectiveCheckPattern = checkIsStale ? null : (lastAixCheckPattern ?? dbLastCheckPattern);
  // 改善1-d: 直近の property_send/recommendation ログからスタッフ入力キーワードを取得
  // aix/action 時にDBへ保存済み。続き文の ragQuery 先頭に注入して実例検索の命中精度を上げる
  const dbSendKeyword = (
    aixUsageLogs.find(
      (l) => (l.aix_type === "property_send" || l.aix_type === "property_recommendation") && l.send_keyword
    )?.send_keyword ?? null
  );
  const recommendationScenario = resolveRecommendationScenario({
    actionType,
    pickupType,
    checkPattern: effectiveCheckPattern,
    facts: propertySendFacts,
  });

  // ── 実例の冒頭フレーム互換判定 ──────────────────────────────────────────────
  // ⭐実例（ai_reply_examples / entry_source='aix_template'）の大半が
  // 「お送りさせて頂きましたお部屋の中でも〜」で始まるため、新着型・初回提案型でも
  // モデルがその冒頭をそのまま引き写す（実例によるフレーム汚染）。
  // シナリオと矛盾するフレームの実例は後段で並び順を落とし、警告ラベルを付けて注入する。
  // 判定は app/lib/recommendation-frame.ts（AIX ボタン本体と同じ物）
  const exampleFrameOk = (text: string | null | undefined): boolean =>
    isExampleFrameCompatible(text, recommendationScenario);

  // 温度感（purchase_signal_level）による訴求シナリオのCTA強度上書き。
  // engagement_stance='wait'（押してはいけない局面）は brain-core M4 と同じゲートで無効化する
  const signalCtaOverride =
    brainMeta?.engagement_stance === "wait"
      ? ""
      : SIGNAL_CTA_OVERRIDE[brainMeta?.purchase_signal_level ?? ""] ?? "";

  // M4: アクション専用バケットの整形（申込誘導=💡applying / 内覧誘導=🏠viewing）
  type ActionBucketRow = { id: string; title: string | null; content: string; importance: number };
  const actionBucketRows = ((actionBucketRes?.data ?? []) as ActionBucketRow[])
    .filter((r) => (r.content ?? "").trim().length > 0);
  const actionBucketSection = actionBucketRows.length > 0
    ? `━━━━━━━━━━━━━━━━━━━━\n` +
      (actionBucketCategory === "applying_pattern"
        ? "【💡 申込に至った実例パターン（この展開を参考に橋渡し文を組み立てる・文面の丸写しは禁止）】"
        : "【🏠 内見に至った・案内成功の実例パターン（この展開を参考に橋渡し文を組み立てる・文面の丸写しは禁止）】") +
      `\n━━━━━━━━━━━━━━━━━━━━\n` +
      actionBucketRows.map((p, i) => `${i + 1}. ${p.title ? `[${p.title}] ` : ""}${p.content}`).join("\n") + "\n\n"
    : "";

  // A: AIX実例行の型（4経路統合の直クエリ結果キャストで使用）
  type AixExampleRow = {
    customer_message: string | null;
    sent_reply: string | null;
    conversation_state: string | null;
    is_starred: boolean | null;
    reply_angle: string | null;
    aix_action: string | null;
    outcome_status: string | null;
  };

  // M1: 注入した ai_reply_knowledge の id を収集（レスポンス後に used_count テレメトリ）
  const knowledgeUsedIds: string[] = [...actionBucketRows.map((r) => r.id).filter(Boolean)];

  // ── 並列フェッチ②: RAG（winning_patterns + ai_reply_knowledge + ai_reply_examples）──
  let winningSection = "";
  let knowledgeSection = "";
  let examplesSection = "";
  let ragQueryLength = 0;
  let aixVecHitCount = 0;   // match_aix_reply_examples のヒット数（テレメトリ用）
  let aixStarSeedCount = 0; // ⭐直クエリ（A-1）で取得した固定シード実例数（テレメトリ用）
  let unifiedAixExCount = 0;   // 4経路統合後のAIX系実例件数（テレメトリ用）
  let unifiedExCount = 0;      // 4経路統合後の実例総数（テレメトリ用）
  if (process.env.OPENAI_API_KEY) {
    const recentCustomerMsgs = (recentMessages ?? [])
      .filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]")
      .slice(-3)
      .map((m) => m.text)
      .join(" ");
    // AIX-META全フィールド（action / closing_strategy / reply_direction / checkpoint_stage）を
    // 検索ベクトルに含める（brain-coreのprevMeta 5フィールド注入と同じ設計思想）
    // H1: property_search_params → 希望条件テキスト化（preferences は brain-core 側が string の場合もあるため両対応）
    const psp = brainMeta?.property_search_params;
    const pspPrefs = psp
      ? (Array.isArray(psp.preferences) ? psp.preferences.join("・") : (psp.preferences ?? ""))
      : "";
    const pspText = psp
      ? [
          psp.area ? `エリア: ${psp.area}` : null,
          psp.floor_plan ? `間取り: ${psp.floor_plan}` : null,
          psp.walk_minutes ? `駅徒歩: ${psp.walk_minutes}分以内` : null,
          psp.move_in_time,
          psp.rent_max ? `家賃${psp.rent_max}円以下` : null,
          pspPrefs,
        ].filter(Boolean).join("・")
      : "";
    // 改善1-d: スタッフ入力キーワードを ragQuery 先頭に注入（実例の命中軸をキーワードで強化）
    const kwPrefix = dbSendKeyword ? `【伝えたいこと】${dbSendKeyword} ` : "";
    const ragQuery = [
      kwPrefix,
      `AIXアクション: ${actionLabel}`,
      // 実例検索の主軸をpgvectorに一本化したため、同一actionType内での「文脈の違い」
      // （初回/継続/新着/条件広げ・訴求シナリオ）を検索ベクトルに載せて実例を会話ごとに散らす
      actionType === "property_send"
        ? `送付文脈: ${PROPERTY_SEND_CONTEXT_LABELS[resolvePropertySendContext({ pickupType, priorSentPropertyCount })]}`
        : "",
      recommendationScenario ? `訴求シナリオ: ${RECOMMENDATION_SCENARIO_LABELS[recommendationScenario]}` : "",
      pickupType ? `ピックアップ種別: ${pickupType}` : "",
      actionType === "property_send" || actionType === "property_recommendation"
        ? `事前の物件送付回数: ${priorSentPropertyCount}回（${priorSentPropertyCount === 0 ? "初回送付" : "継続送付"}）`
        : "",
      resolvedCustomerConditions ? `希望条件: ${resolvedCustomerConditions.slice(0, 200)}` : "",
      brainMeta?.action && AIX_BUTTON_LABELS[brainMeta.action]
        ? `Brain推奨アクション: ${AIX_BUTTON_LABELS[brainMeta.action]}`
        : "",
      brainMeta?.closing_strategy ? `成約戦略: ${brainMeta.closing_strategy}` : "",
      brainMeta?.reply_direction ? `返信方向: ${brainMeta.reply_direction}` : "",
      brainMeta?.checkpoint_stage ? `フェーズ詳細: ${brainMeta.checkpoint_stage}` : "",
      brainMeta?.customer_emotion ? `顧客感情: ${brainMeta.customer_emotion}` : "",
      brainMeta?.latent_intent ? `潜在動機: ${brainMeta.latent_intent}` : "",
      brainMeta?.current_property ? `注目物件: ${brainMeta.current_property}` : "",
      // H1: 顧客インテント・成功パターン・キートピック等を検索ベクトルに追加
      // （generate-reply の brainContext と同構成 — winning_patterns / knowledge の命中精度向上）
      brainMeta?.customer_intent ? `顧客インテント: ${brainMeta.customer_intent}` : "",
      brainMeta?.winning_pattern ? `成功パターン: ${brainMeta.winning_pattern}` : "",
      brainMeta?.key_topics?.length ? `キートピック: ${brainMeta.key_topics.join("・")}` : "",
      brainMeta?.recommended_tone ? `推奨トーン: ${brainMeta.recommended_tone}` : "",
      brainMeta?.human_type_label ? `人物タイプ: ${brainMeta.human_type_label}` : "",
      brainMeta?.repeated_concern ? `繰り返し懸念: ${brainMeta.repeated_concern}` : "",
      // P0-3: 購入意欲・押し引きスタンスをembeddingに乗せる（申込打診・内覧誘導の実例精度向上）
      brainMeta?.purchase_signal_level ? `温度感: ${brainMeta.purchase_signal_level}` : "",
      brainMeta?.engagement_stance ? `押し引き: ${brainMeta.engagement_stance}` : "",
      // P1-2: 顧客プロファイル（AI分析）をRAGクエリに追加（設計知見③の「二重接続」完成）
      customerSummary ? `顧客プロファイル: ${customerSummary.slice(0, 200)}` : "",
      pspText ? `希望条件: ${pspText}` : "",
      // 直前に何のAIXを送ったかは続き文の実例検索に直結する文脈（generate-reply の [AIX履歴] と同形式）
      ...(brainMeta?.last_aix_history ? [`[AIX履歴]${String(brainMeta.last_aix_history).slice(0, 100)}`] : []),
      conversationState ? `フェーズ: ${STATE_LABEL[conversationState] ?? conversationState}` : "",
      recentCustomerMsgs.slice(0, 200),
    ].filter(Boolean).join(" | ").slice(0, 2000);
    ragQueryLength = ragQuery.length;
    // 2026-09-13 AIX-META × RAG 監査: 問いは「探す文書と同じ構成」にする。上の ragQuery（AIX-META・プロファイル 約20項目）は
    //   成功パターン（人物像＋パターンで埋め込み）にだけ使い、ナレッジ・実例（state＋顧客発言で埋め込み・戦略語なし）は
    //   キーワード＋state＋顧客発言の問いで引く（本番の問いで戦略語入りの問いは実例・ナレッジの精度を下げていた: 0.636→0.666 / 0.485→0.525）
    const docQuery = recentCustomerMsgs.trim()
      ? `${kwPrefix}${normalizedState}: [顧客]${recentCustomerMsgs.slice(0, 600)}`.slice(0, 2000)
      : ragQuery;

    try {
      const [emb, docEmbRaw] = await Promise.all([
        generateEmbedding(ragQuery),
        docQuery === ragQuery ? Promise.resolve(null) : generateEmbedding(docQuery),
      ]);
      const docEmb = docEmbRaw ?? emb;
      if (emb && docEmb) {
        const stateAliases = STATE_SEARCH_ALIASES[normalizedState] ?? [normalizedState];
        const [wpRes, knRes, exRes, aixExRes] = await Promise.all([
          supabase.rpc("match_winning_patterns", {
            query_embedding: emb,
            // H2: メタデータ再ランキングの母集団を確保するため 6→10 に拡大
            match_count: 10,
            min_importance: 8,
          }),
          // generate-reply の fetchKnowledge と同構成（match_count拡大 + importance/similarity/鮮度スコアリング）
          supabase.rpc("match_reply_knowledge", {
            query_embedding: docEmb,
            match_count: 40,
            min_importance: 7,
          }),
          // ⭐実例（スタッフの実返信）— 文体・テンポ再現の最重要ソース（generate-reply の fetchExamples と同RPC）
          supabase.rpc("match_reply_examples", {
            query_embedding: docEmb,
            match_count: 20,
            filter_states: stateAliases,
          }),
          // AIX専用pgvector検索（match_reply_examplesとは別RPC・entry_source IN ('aix_template','aix_action')）
          // match_reply_examples は entry_source='line_reply' ハードコードのためAIX実例が永遠に
          // ヒットしない → 専用RPCで過去の【AIX】テンプレート続き文・橋渡し文実例を類似検索する
          //（同一actionは+0.05ブースト）
          // 実例の主経路になったため母集団を 10 → 15 に拡大（dedupe後も6件を埋められるように）
          supabase.rpc("match_aix_reply_examples", {
            query_embedding: docEmb,
            match_count: 15,
            filter_action: actionType ?? null,
          }),
        ]);
        // H2: RPCが返すメタデータ列（checkpoint_stage / customer_intent / win_rate / human_type_label）を型に追加
        // （match_winning_patterns はこれらを既に返却している — brain-core の ragWinningPatterns 型と同構成）
        type WpRow = {
          situation: string | null;
          pattern: string;
          closing_action: string | null;
          notes: string | null;
          checkpoint_stage?: string | null;
          customer_intent?: string | null;
          win_rate?: number | null;
          human_type_label?: string | null;
          similarity: number;
        };
        // H2: similarity フィルタ後、brainMeta とのメタデータ一致＋win_rate で複合スコア再ランキング
        const wpRows = ((wpRes.data ?? []) as WpRow[])
          .filter((w) => w.similarity >= 0.5)
          .map((w) => ({
            ...w,
            score: (w.similarity ?? 0)
              + (brainMeta?.checkpoint_stage && w.checkpoint_stage === brainMeta.checkpoint_stage ? 0.12 : 0)
              + (brainMeta?.customer_intent && w.customer_intent === brainMeta.customer_intent ? 0.15 : 0)
              + (w.win_rate ?? 0) * 0.1,
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 6);
        if (wpRows.length > 0) {
          winningSection =
            `━━━━━━━━━━━━━━━━━━━━\n【過去の成約パターン（似た状況で効いた戦い方 — トーン・構成の参考にする）】\n━━━━━━━━━━━━━━━━━━━━\n` +
            wpRows.map((w) => {
              const parts = [
                w.situation ? `状況: ${w.situation}` : "",
                w.human_type_label ? `顧客タイプ: ${w.human_type_label}` : "",
                `パターン: ${w.pattern}`,
                w.closing_action ? `クロージング: ${w.closing_action}` : "",
                w.notes ? `補足: ${w.notes}` : "",
              ].filter(Boolean).join(" / ");
              return `・${parts}`;
            }).join("\n") + "\n\n";
        }
        const kn = buildKnowledgeSections((knRes.data ?? []) as KnowledgeHit[]);
        if (kn.text) {
          knowledgeSection = wrapKnowledgeSection(kn.text);
          knowledgeUsedIds.push(...kn.usedIds);
        }
        // AIX橋渡し文実例（pgvector）: 多様性が高いため閾値を0.45に緩和（⭐+0.15ブーストは共通）
        aixVecHitCount = ((aixExRes.data ?? []) as ExampleHit[]).length;
        // pgvectorがAIX実例の主経路。⭐直クエリ（最大2件）と合わせて6件枠を埋めるため 4 → 8 に拡大
        const aixVecRows = rankExamples((aixExRes.data ?? []) as ExampleHit[], 0.45).slice(0, 8);
        const lineVecRows = rankExamples((exRes.data ?? []) as ExampleHit[]).slice(0, 6);

        // 【3経路統合】優先タイア: ①⭐直クエリaix_template（固定シード最大2件） >
        // ②pgvector AIX（主経路・会話ごとに変動） > ③pgvector line_reply
        // AIX系最大6件・line系最大2件・全体横断dedupe
        const toUnifiedEx = (r: { customer_message?: string | null; sent_reply?: string | null; is_starred?: boolean | null; aix_action?: string | null; outcome_status?: string | null }) =>
          ({ customer_message: r.customer_message ?? null, sent_reply: r.sent_reply ?? null, is_starred: r.is_starred ?? null, aix_action: r.aix_action ?? null, outcome_status: r.outcome_status ?? null });
        // ⭐固定シード: 訴求シナリオと冒頭フレームが一致するものを優先し最大2件に絞る
        const starPool = ((aixTemplateExRes?.data ?? []) as AixExampleRow[]).map(toUnifiedEx);
        const tierA = [
          ...starPool.filter((e) => exampleFrameOk(e.sent_reply)),
          ...starPool.filter((e) => !exampleFrameOk(e.sent_reply)),
        ].slice(0, 2);
        aixStarSeedCount = tierA.length;
        const tierB = aixVecRows.map(r => ({ ...r, aix_action: null, outcome_status: r.outcome_status ?? null }));
        const tierD = lineVecRows.map(r => ({ ...r, aix_action: null, outcome_status: null }));

        // 成約アウトカム還流: closed_won 実例を AIX系の先頭に昇格（成約実績ある実例を few-shot の最初に）
        // Array.sort は stable のため同一 outcome 内では tierA > tierB の優先順が維持される
        const outcomeRank = (s: string | null) =>
          s === "closed_won" ? 0 : s === "applied" ? 1 : s === "viewing" ? 2 : 3;
        // 訴求シナリオと冒頭フレームが一致する実例を最優先（不一致でも文体参考として残すが後ろに置き警告を付ける）
        const frameRank = (t: string | null) => (exampleFrameOk(t) ? 0 : 1);
        const sortedTierABC = [...tierA, ...tierB].sort(
          (a, b) =>
            frameRank(a.sent_reply) - frameRank(b.sent_reply) ||
            outcomeRank(a.outcome_status) - outcomeRank(b.outcome_status)
        );

        const seenUnified = new Set<string>();
        const unifiedAix: { customer_message: string | null; sent_reply: string | null; is_starred: boolean | null; aix_action: string | null; outcome_status: string | null }[] = [];
        const unifiedLine: { customer_message: string | null; sent_reply: string | null; is_starred: boolean | null; aix_action: string | null; outcome_status: string | null }[] = [];
        for (const ex of sortedTierABC) {
          const key = (ex.sent_reply ?? "").trim();
          if (!key || seenUnified.has(key)) continue;
          seenUnified.add(key);
          if (unifiedAix.length < 6) unifiedAix.push(ex);
        }
        for (const ex of tierD) {
          const key = (ex.sent_reply ?? "").trim();
          if (!key || seenUnified.has(key)) continue;
          seenUnified.add(key);
          if (unifiedLine.length < 2) unifiedLine.push(ex);
        }
        const unified = [...unifiedAix, ...unifiedLine];
        unifiedAixExCount = unifiedAix.length;
        unifiedExCount = unified.length;
        if (unified.length > 0) {
          const unifiedText = unified.map((ex, i) =>
            `--- 実例${i + 1}${ex.is_starred ? " ⭐" : ""}${ex.outcome_status === "closed_won" ? " 🏆成約" : ex.outcome_status === "applied" ? " 📝申込" : ""}${ex.aix_action && ex.aix_action !== actionType ? ` (AIX:${ex.aix_action})` : ""}` +
            (exampleFrameOk(ex.sent_reply) ? "" : " ⚠️今回の訴求シナリオとは冒頭フレームが異なる実例") +
            ` ---\n` +
            `[お客様の状況] 「${safeSlice(ex.customer_message ?? "", 200)}」\n` +
            `[実際に送った続き文] 「${safeSlice(neutralizeWaitedInExample(ex.sent_reply), 600)}」` +
            (exampleFrameOk(ex.sent_reply)
              ? ""
              : `\n[⚠️注意] この実例の冒頭は今回の訴求シナリオでは事実と異なるため絶対に流用しない。文体・テンポ・絵文字の使い方のみ参考にすること。`)
          ).join("\n\n");
          // 強指示: AIX実例に「忠実に再現」を付ける（旧aixExamplesSectionの弱指示「参考に」から強化）
          examplesSection =
            "━━━━━━━━━━━━━━━━━━━━\n" +
            "【⭐ 実際に送った続き文の実例（AIX橋渡し文・文体再現の最重要ソース）】\n" +
            "━━━━━━━━━━━━━━━━━━━━\n" +
            "文体・テンポ・絵文字・感嘆符・構成をこの実例から忠実に再現すること。" +
            "固有の事実（金額・物件名・日程）は今回の会話履歴/AIXメッセージに記載があるもののみ使うこと（実例からの持ち込みは絶対禁止）。\n\n" +
            unifiedText + "\n\n";
        }
      }
    } catch {
      // RAG失敗は無視して生成継続（既存方針: adapt/brain-coreと同じ）
    }
  }

  // ── H3: RAGフォールバック（OPENAI_API_KEY未設定・embedding失敗・RPC空振り時）──────
  // generate-reply の fetchKnowledge / fetchExamples のフォールバック経路と同方針。
  // pgvector不発でも実例・重要ナレッジをゼロにせず文体再現力を維持する。
  if (!examplesSection || !knowledgeSection) {
    try {
      const fbStates = Array.from(new Set([
        ...(STATE_SEARCH_ALIASES[normalizedState] ?? [normalizedState]),
        ...(conversationState ? [conversationState] : []),
      ]));
      // B: フォールバック実例はAIX実績を優先する4段リトライ
      //   ⓪ entry_source='aix_template' + aix_action=actionType（【AIX】テンプレート続き文の実績・本命）
      //   ① entry_source='aix_action' + aix_action=actionType（同一AIXボタンの橋渡し文実績）
      //   ② entry_source='aix_action' のみ（アクション不問のAIX橋渡し文実績）
      //   ③ entry_source='line_reply'（従来 — 通常返信の実例で文体だけでも維持）
      const fetchFallbackExamples = async () => {
        const selectCols = "customer_message, sent_reply, conversation_state, is_starred, reply_angle";
        if (actionType) {
          const r0 = await supabase
            .from("ai_reply_examples")
            .select(selectCols)
            .eq("entry_source", "aix_template")
            .eq("aix_action", actionType)
            .order("is_starred", { ascending: false })
            .order("created_at", { ascending: false })
            .limit(6);
          if ((r0.data?.length ?? 0) > 0) return r0;
          const r1 = await supabase
            .from("ai_reply_examples")
            .select(selectCols)
            .eq("entry_source", "aix_action")
            .eq("aix_action", actionType)
            .order("is_starred", { ascending: false })
            .order("created_at", { ascending: false })
            .limit(6);
          if ((r1.data?.length ?? 0) > 0) return r1;
        }
        const r2 = await supabase
          .from("ai_reply_examples")
          .select(selectCols)
          .eq("entry_source", "aix_action")
          .order("is_starred", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(6);
        if ((r2.data?.length ?? 0) > 0) return r2;
        return supabase
          .from("ai_reply_examples")
          .select(selectCols)
          .in("conversation_state", fbStates)
          .eq("entry_source", "line_reply")
          .order("is_starred", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(6);
      };
      const [fbExRes, fbKnRes] = await Promise.all([
        !examplesSection ? fetchFallbackExamples() : Promise.resolve({ data: null }),
        !knowledgeSection
          ? supabase
              .from("ai_reply_knowledge")
              .select("id, title, content, category, importance, hypothesis_status, created_at")
              .gte("importance", 8)
              .neq("hypothesis_status", "rejected")
              .order("importance", { ascending: false })
              .order("id", { ascending: true })
              .limit(20)
          : Promise.resolve({ data: null }),
      ]);
      if (!examplesSection && (fbExRes.data?.length ?? 0) > 0) {
        // similarity 0.5 を付与して既存の整形ロジック（閾値0.5・⭐ブースト順位付け）を通す
        const fbRows = (fbExRes.data as Array<Omit<ExampleHit, "similarity">>).map((ex) => ({ ...ex, similarity: 0.5 }));
        const exText = buildExamplesSection(fbRows);
        if (exText) examplesSection = wrapExamplesSection(exText);
      }
      if (!knowledgeSection && (fbKnRes.data?.length ?? 0) > 0) {
        const fbRows = (fbKnRes.data as Array<Omit<KnowledgeHit, "similarity">>).map((k) => ({ ...k, similarity: 0.5 }));
        const kn = buildKnowledgeSections(fbRows);
        if (kn.text) {
          knowledgeSection = wrapKnowledgeSection(kn.text);
          knowledgeUsedIds.push(...kn.usedIds);
        }
      }
    } catch (err) {
      console.error("[aix-template-generate] RAGフォールバック失敗（資産なしで生成続行）:", err);
    }
  }

  // ── フレーズ辞書（phrase_dictionary — generate-reply と同一キャッシュ）────────
  const phrasesSection = phraseList.length > 0
    ? `【スモラのフレーズ集（参考程度に・⭐実例を最優先すること）】\n` +
      phraseList.slice(0, 10).map((p) => `「${p}」`).join("　") + "\n\n"
    : "";

  // ── コンテキスト整形 ─────────────────────────────────────────────────────
  const nowMs = Date.now();
  const history = (recentMessages ?? [])
    .slice(-15)
    .map((m) => {
      const who = m.sender === "customer" ? "お客様" : (m.isAix ? "スモラ(AIX送信)" : "スモラ");
      const timeLabel = relativeTimeLabel(m.rawCreatedAt, nowMs);
      if (m.text === "[画像]" || m.text === "[動画]") return `${who}${timeLabel}: 【画像・資料を送付】`;
      if (!m.text) return null;
      return `${who}${timeLabel}: ${m.text}`;
    })
    .filter(Boolean)
    .join("\n");

  const pendingSection = (pendingScheduledMessages ?? [])
    .map((m) => m.text ?? "").filter(Boolean).join("\n\n---\n\n");

  const stateLabel = STATE_LABEL[conversationState || ""] || conversationState || "不明";

  // ── 即2: AIX-META 鮮度・整合ゲート ────────────────────────────────────────
  // analyzed_msg_ts（brainが分析時点で見ていた最新顧客メッセージの時刻）より新しい顧客
  // メッセージが届いている場合、戦略は古い前提 → 警告付き注入で会話履歴を優先させる
  // （generate-reply の T1/T2 判定と同じ基準・比較相手はフロントから来た最新の会話履歴）
  const isStaleMeta = Boolean(
    brainMeta?.analyzed_msg_ts &&
    lastCustomerMsg?.rawCreatedAt &&
    new Date(lastCustomerMsg.rawCreatedAt).getTime() > new Date(brainMeta.analyzed_msg_ts).getTime()
  );

  // 即2: ng_properties は brain-core が property_search_params 配下に格納する
  // （旧デッドコード: トップレベル brainMeta.ng_properties 参照は永久に発火しなかった）。
  // 旧世代metaの string[] 形状もフォールバックで拾う
  const ngPropsRaw = brainMeta?.property_search_params?.ng_properties ?? [];
  const ngPropLabels = ngPropsRaw
    .map((p) => typeof p === "string" ? p : `${p.property_name}${p.room_no ? ` ${p.room_no}` : ""}`)
    .filter((s) => s.trim().length > 0);

  // 2026-09-18 竹内「テンプレートよくわからん文生成される」:
  //   旧実装は同じ brainMeta を**生で・「必ず入れろ」と強制**して渡していた（返信生成にある安全装置が1つも無かった）。
  //   ・古い判断でも鮮度従属フィールドをそのまま注入 ・repeated_concern は「必ず拾う」
  //   ・latent_intent は「最低1つ本文に含めること」 ・winning_pattern（＝スタッフの行動計画）を生で「応用しろ」
  //   さらに repeated_concern は brain-core が20字で機械的に切っており、実データの20字ちょうど5件は全部
  //   途中で切れていた（「契約書類・手続きの確認（引き落とし口座書」）。それを「必ず拾え」と渡していた。
  //   → 整形と渡し方を brain-strategy-note.ts に1本化し、返信生成と同じ扱いに揃える（四者同名）
  const brainMetaSection = buildBrainStrategyNote(brainMeta, {
    fresh: !isStaleMeta,
    otherActionLabel: actionType && brainMeta?.action && brainMeta.action !== actionType
      ? (AIX_BUTTON_LABELS[brainMeta.action] ?? brainMeta.action)
      : null,
    actionLabel,
    ngPropertyLabels: ngPropLabels,
    signalGuides: SIGNAL_CTA_GUIDES,
  });

  // preferences が string の場合は配列化、null/undefined の場合は空配列
  // （string を配列スプレッドすると1文字ずつ分解され「広 / め / ・ / 綺 / 麗」になるバグ防止 — ragQuery側と同処理）
  const userPromptPrefsRaw = brainMeta?.property_search_params?.preferences;
  const prefList = Array.isArray(userPromptPrefsRaw)
    ? userPromptPrefsRaw
    : typeof userPromptPrefsRaw === "string" && userPromptPrefsRaw
    ? [userPromptPrefsRaw]
    : [];

  // 2026-09-20 竹内「AIX テンプレート、AIX の内容との関係性での生成が重要」:
  //   直前に AIX で送った1通目を材料として渡す。実測（scripts/audit-aix-chain-coherence.ts・90日・1,419組）で
  //   スタッフは1通目を見て2通目を書いており、重複はほぼ0（未来形0.2%／ご査収の重ね3.1%／挨拶の重ね2.0%）。
  //   渡していなかったので、AI は会話履歴だけを頼りに書いて1通目と噛み合わない文を作れてしまっていた。
  // 物件オススメの直後の2通目は、形を second-message-scene が決める → 1通目との関係（重ねない物）だけを渡す
  // 2026-10-01: ピックアップの後に推す物件が決まった時も同じ（下で pickupPush が決まったら作り直す）
  // 見積書の直後の2通目も「続きの一言・見立て・CTA 8.8%」の全種類の平均の段落は渡さない（形は estimate-second-message）
  let aixChainNote = buildAixChainNote(sentMessage, { recommendScene: actionType === "property_recommendation" || (actionType === "estimate_sheet" && isEstimateCard(sentMessage)) });
  if (aixChainNote) {
    console.log(JSON.stringify({ tag: "aix-template-generate:chain-note", actionType, len: (sentMessage ?? "").length }));
  }

  // 2026-09-20 竹内「生成される文が長すぎる。実際の成約データや直近の会話をみて改善する」:
  //   このプロンプトには**長さの指示が1つも無かった**（設計知見「長さの上限をプロンプトに書く」）。
  //   実測（scripts/audit-template-length.ts・120日）: property_recommendation は 生成257字 → 実送信234字、
  //   property_send_widen は 生成170字 → 実送信112字。実送信2通目の中央値は120字・4行で、
  //   **成約した会話では108字・3行**、140字未満が69.5%。
  const lengthNote = buildLengthNote(actionType);

  // ── 2026-09-21 竹内「付けるかはブレインが判断する。お客さんの反応見て刺さっているなら、誘導する」──
  //   CTA の有無をプロンプトの言葉で釣ろうとすると振り子になる（0%→31%→38%）。
  //   **お客様の直近の発言の分類**（返信生成と同じ classifyCustomerResponse）と AIX の種類で決める。
  //   実測（scripts/audit-cta-trigger.ts・1,424組）: positive 30.6%（成約では60%）／concern 3.2%／
  //   condition_change 1.1% ／ AIX 別は 待ち合わせ50% 内覧日調整49% 申込へ29% 見積書22% …
  //   物件ピックアップ3% ヒアリング0%。
  //   ⚠ purchase_signal_level は使わない（設計知見「peak は申込しそうではなく申込したを言っていた」）。
  const ctaGuidance = (() => {
    try {
      const list = Array.isArray(recentMessages) ? recentMessages : [];
      const lastCust = [...list].reverse().find((m) => m.sender === "customer" && (m.text ?? "").trim());
      if (!lastCust) return null;
      const idx = list.lastIndexOf(lastCust);
      const prevStaff = [...list.slice(0, idx)].reverse().find((m) => m.sender === "staff" && (m.text ?? "").trim());
      const staffTurn = classifyLastStaffTurn(prevStaff?.text ?? "", { lastStaffAt: prevStaff?.rawCreatedAt ?? null });
      const sub = analyzeSubstance(lastCust.text ?? "", undefined, { staffAskedQuestion: staffTurn.kind === "question_to_customer" });
      const cr = classifyCustomerResponse(sub, staffTurn);
      const g = resolveCtaGuidance({ customerKind: cr.kind, positiveKind: cr.positive?.kind ?? null, action: actionType });
      console.log(JSON.stringify({ tag: "aix-template-generate:cta", actionType, customerKind: cr.kind, positive: cr.positive?.kind ?? null, mode: g.mode, ctaKind: g.kind, reason: g.reason }));
      return g;
    } catch (e) {
      console.warn("[aix-template-generate] cta guidance failed:", e instanceof Error ? e.message : e);
      return null;
    }
  })();

  // ── 2026-09-30 竹内「1件オススメは特にオススメ。刺さる→内覧誘導／刺さりそうだが退去予定→退去予定と伝えて申込誘導／
  //   そこまで刺さらなそう→お手隙の際にご査収ください」: 1通目と同じ関数（app/lib/recommend-cta.ts）で締めを決める。
  //   採点は1通目の物件（見出しの建物名・号室）に当たる行だけ使う。読めなければ「ご査収」に倒れる（押しすぎない）。
  //   ⚠ 上の ctaGuidance（一般の CTA 率）とは別の請求として二重に入れない: 物件オススメの時はこちらだけを渡す
  let recCta: RecommendCtaDecision | null = null;
  // 2026-09-30 竹内「資料もちゃんとよみとった方がよいなら、読みとったのを AIX テンプレートの部分にも渡す」:
  //   1通目の物件に当たる売上サポの行（採点と同じ行）から、資料の現況・駅・築年・敷金礼金・ご希望に合う点を読む（AD・点数は渡さない）
  let materialRow: SecondMaterialRow | null = null;
  // 2026-10-01 竹内さん了承「実送信の形に合わせる」(b): 物件ピックアップ（複数）の直後の2通目も、物件オススメの2通目と同じ形にする。
  //   推す物件は売上サポで送った行（送った印つき）の並びの先頭（=送った画像の1枚目・👑が先頭）。行が2件以上読めない時は今まで通り
  let pickupPush: PickupPushRow | null = null;
  if (actionType === "property_send" && (sentMessage ?? "").trim() && conversationId) {
    try {
      const sinceIso = new Date(Date.now() - 2 * 3600_000).toISOString();
      const { data } = await supabase.from("property_pickups")
        .select("id, rank, recommended, score, verdict, reason_codes, created_at, image_analysis, property_name, room_no, terms, location, equipment, sent_at")
        .eq("conversation_id", conversationId).gte("sent_at", sinceIso).order("sent_at", { ascending: false }).limit(20);
      // 2026-10-01 竹内「送った資料の1枚目が一番オススメの物件にする形 1枚目の👑」: 送った画像の1枚目＝AIX【物件ピックアップした】の記録（picker_choices.first_pickup_id）
      let firstSentId: number | null = null;
      try {
        const { data: lg } = await supabase.from("aix_usage_logs").select("picker_choices, created_at")
          .eq("conversation_id", conversationId).eq("aix_type", "property_send").gte("created_at", sinceIso).order("created_at", { ascending: false }).limit(1);
        const v = (lg?.[0]?.picker_choices as { first_pickup_id?: unknown } | null | undefined)?.first_pickup_id;
        if (typeof v === "number" && Number.isInteger(v)) firstSentId = v;
      } catch { /* 記録が読めなければ画面の並びの先頭 */ }
      pickupPush = pickPickupSecondTarget((data ?? []) as PickupPushRow[], { firstSentId });
      console.log(JSON.stringify({ tag: "aix-template-generate:pickup-push", rows: (data ?? []).length, firstSentId, target: pickupPush ? `${pickupPush.property_name} ${pickupPush.room_no}` : null, byFirstSent: !!pickupPush && pickupPush.id === firstSentId }));
    } catch (e) {
      console.warn("[aix-template-generate] pickup-push failed:", e instanceof Error ? e.message : e);
    }
  }
  const pickupPushLabel = pickupPush?.property_name && pickupPush.room_no ? `${pickupPush.property_name} ${String(pickupPush.room_no).replace(/号室$/, "")}号室` : null;
  // 物件オススメ（またはピックアップで推す物件が決まった）の直後の2通目か（形は second-message-scene が決める）
  const isRecSecond = !!(sentMessage ?? "").trim() && (actionType === "property_recommendation" || !!pickupPushLabel);
  if (pickupPushLabel) aixChainNote = buildAixChainNote(sentMessage, { recommendScene: true });
  // 退去予定（まだご内覧頂けない）: 1通目の本文の退去予定日 → 資料の現況 → ブレインの判断 の順（ブレインの判断は会話全体の物で、別の物件の事がある）
  //   2026-10-01: 1通目（aix/action）と同じ関数 resolveRecommendViewable で決める（判定を2か所に持たない）
  let secondViewable: RecommendViewable = { notViewable: recommendState.notViewable, viewableFrom: recommendState.viewableFrom, line: null, source: "brain" };
  let secondNotViewable = recommendState.notViewable;
  let secondViewableFrom: string | null = recommendState.viewableFrom;
  if (actionType === "property_recommendation" || pickupPushLabel) {
    try {
      let pickup: PickupLookupRow | null = pickupPush as PickupLookupRow | null;
      if (pickupPush) materialRow = pickupPush;
      const head = pickupPush ? null : headOfFirstMessage(sentMessage);
      if (conversationId && head) {
        const { data } = await supabase.from("property_pickups").select("property_name, room_no, verdict, reason_codes, created_at, terms, location, equipment")
          .eq("conversation_id", conversationId).eq("room_no", head.room).order("created_at", { ascending: false }).limit(20);
        pickup = pickupForFirstMessage((data ?? []) as PickupLookupRow[], head);
        materialRow = (pickup as SecondMaterialRow | null) ?? null;
      }
      if (isRecSecond) {
        // ピックアップの1通目は複数の物件の宣言なので、退去予定日は推す物件の資料だけから読む
        secondViewable = resolveRecommendViewable({ text: pickupPush ? null : sentMessage, material: materialRow, brain: { notViewable: recommendState.notViewable, viewableFrom: recommendState.viewableFrom } });
        secondNotViewable = secondViewable.notViewable;
        secondViewableFrom = secondViewable.viewableFrom;
      }
      recCta = resolveRecommendCta({
        pickup,
        reaction: readCustomerReaction(Array.isArray(recentMessages) ? recentMessages : []),
        notViewable: secondNotViewable,
      });
      console.log(JSON.stringify({ tag: "aix-template-generate:recommend-cta", kind: recCta.kind, appeal: recCta.appeal, notViewable: recCta.notViewable, reason: recCta.reason, pickupFound: !!pickup, firstHasSame: hasClosingKind(sentMessage, recCta.kind) }));
    } catch (e) {
      console.warn("[aix-template-generate] recommend-cta failed:", e instanceof Error ? e.message : e);
    }
  }
  // 2026-10-01: テンプレート一覧の「訴求方法を選択する！！」を押している時は、その締め（内覧に誘う／申込へ押し込む）にする。
  //   刺さり具合の判定（resolveRecommendCta）はスタッフが選んでいない時の決め方＝スタッフの選択が先
  if (recCta && (ctaPreference === "viewing" || ctaPreference === "apply") && recCta.kind !== ctaPreference) {
    console.log(JSON.stringify({ tag: "aix-template-generate:recommend-cta-staff", from: recCta.kind, to: ctaPreference }));
    recCta = { ...recCta, kind: ctaPreference, appeal: "strong", reason: `スタッフが画面で「${ctaPreference === "viewing" ? "内覧に誘う" : "申込へ押し込む"}」を選んだ` };
  }

  // ── 2026-09-30 竹内「2通目の言い回しが AI くさい」: 物件オススメの直後の2通目の形（場面ごとの実送信の実物）と資料の事実 ──
  //   出所は「手本が届いていない」ではなく「最後に置いた指示が実送信の形と逆」だった（見立て・要点を1つ・続きの一言・呼びかけ35%）。
  //   この場面では、1通目用・AIX 全種類の平均から作った指示（buildLengthNote・この種別の書き方・シナリオの演出の指示・段落構成・フレーズ集）を渡さず、
  //   場面の形を1か所（second-message-scene）から渡す（設計知見「同じ事実について書くなと書けを別の場所から渡さない」）
  const secondPropertyLabel = pickupPushLabel ?? (() => { const h = headOfFirstMessage(sentMessage); return h ? `${h.name} ${h.room}号室` : null; })();
  // ピックアップの後は「複数の中で1件」の場面（送ったばかりの複数の資料から推す）
  // 2026-10-01: 1通目が既に「1件新着で…募集に出ました」と新着を伝えている時は、2通目は新着の宣言も「お送りさせて頂きましたお部屋の中でも」も重ねず、
  //   1件だけの形（「◯◯ 号室が〜、◯◯さんにかなりオススメ出来るお部屋となります！！」）にする（ローカル生成で新着の1通目の後に比較の書き出しが付いた）
  const firstDeclaresNew = !pickupPushLabel && /新着/.test(sentMessage ?? "") && /募集に(?:出|で)ました/.test(sentMessage ?? "");
  const secondScene = pickupPushLabel ? "compare" as const : firstDeclaresNew ? "single" as const : secondSceneOf(recommendationScenario);
  // 2通目の出口（別の物件の号室が出ていないか）で「1通目の物件」として見る文。ピックアップの後は推す物件だけ
  const secondFirstForCheck = pickupPushLabel ? `🌟${pickupPushLabel}` : sentMessage;
  const secondMaterialNote = isRecSecond ? buildSecondMaterialNote(materialRow) : "";
  const secondSceneNote = isRecSecond
    ? buildSecondSceneNote({
        scene: secondScene,
        vacating: secondNotViewable,
        name: resolvedCustomerName,
        propertyLabel: secondPropertyLabel,
        sentCount: recommendState.sentSource === "brain" ? recommendState.sentPropertyCount : null,
        vacatingLine: secondViewable.line,
        firstMentionsVacating: pickupPushLabel ? false : mentionsVacating(sentMessage),
      })
    : "";
  if (isRecSecond) {
    console.log(JSON.stringify({ tag: "aix-template-generate:second-scene", scene: secondScene, pickupPush: pickupPushLabel, scenario: recommendationScenario, vacating: secondNotViewable, viewableSource: secondViewable.source, vacatingLine: secondViewable.line, material: !!secondMaterialNote }));
  }

  // ── 2026-10-01 竹内「物件オススメのところが改善されたように、見積書や他のよく使うAIXテンプレートの部分も改善する」──
  //   見積書の直後の2通目: スタッフが書いた2通目（132通）の形を最後に1か所（estimate-second-message）から渡す。
  //   直す前は YUMA の生成 6/6 が申込の誘い（この種別の書き方「CTAは申込」＋最後の CTA の注記「申込が中心」＋ブレインの「申込へ導く」）・
  //   「本当に良いお部屋ですよね」のような評する一文（長さの注記「スタッフが書いているのは自分の見立て」）だった。
  //   この場面では長さの注記・この種別の書き方・CTA 強度の上書き・段落構成・フレーズ集・⭐実例（AI の下書きのまま送った申込の締め）・一般の CTA 率を渡さない
  const isEstimateSecond = actionType === "estimate_sheet" && isEstimateCard(sentMessage);
  let estimateClosing: EstimateClosing = "receipt";
  let estimateSecondNote = "";
  if (isEstimateSecond) {
    let viewed = false;
    try {
      if (conversationId) {
        // 内覧の段階: 見積書のお部屋（建物名）で AIX【待ち合わせ場所】（内覧の確定）か内覧前後の挨拶を送っていれば「内覧の後」（feedback_viewing_flow_stages）。
        //   会話全体で見ると別のお部屋の内覧（YUMA: レオパレス天満）で「内覧の後」になってしまう（10/01 のローカル生成で 8/8 が内覧の後だった）→ 建物名で結ぶ
        const buildings = estimatePropertiesOf(sentMessage).map((p) => p.replace(/[s　]*[0-9０-９A-Za-z-]{1,6}(?:号室)?$/, "").trim()).filter((b) => b.length >= 2);
        const { data } = await supabase.from("aix_usage_logs").select("generated_text, property_names").eq("conversation_id", conversationId)
          .in("aix_type", ["meeting_place", "greeting_viewing"]).not("sent_at", "is", null).order("created_at", { ascending: false }).limit(20);
        viewed = buildings.length > 0 && ((data ?? []) as Array<{ generated_text: string | null; property_names: string[] | null }>)
          .some((r) => buildings.some((b) => (r.generated_text ?? "").includes(b) || (r.property_names ?? []).some((n) => String(n ?? "").includes(b))));
      }
    } catch { /* 読めない時は内覧の前として扱う（ご査収に倒れる側） */ }
    const reaction = readCustomerReaction(Array.isArray(recentMessages) ? recentMessages : []);
    const dec = resolveEstimateClosing({ ctaPreference, viewed, reactionKind: reaction?.kind ?? null });
    estimateClosing = dec.closing;
    estimateSecondNote = buildEstimateSecondNote({ name: resolvedCustomerName, properties: estimatePropertiesOf(sentMessage), closing: dec.closing, staffSentToday });
    console.log(JSON.stringify({ tag: "aix-template-generate:estimate-second", closing: dec.closing, reason: dec.reason, viewed, reaction: reaction?.kind ?? null, props: estimatePropertiesOf(sentMessage).length }));
  }
  // 形を最後に1か所から渡す2通目（物件オススメ・見積書）。この時は1通目用・全種類の平均の指示を渡さない
  const fixedSecond = isRecSecond || isEstimateSecond;

  const userPrompt = [
    `━━━━━━━━━━━━━━━━━━━━\n【今回生成する橋渡し文】\n━━━━━━━━━━━━━━━━━━━━`,
    `・AIXボタン種別: ${actionLabel}`,
    fixedSecond ? "" : lengthNote,
    actionGuide && !fixedSecond ? `・この種別の書き方: ${actionGuide}` : "",
    // 「1件特にオススメ」の訴求シナリオ（冒頭・比較表現の可否・CTA強度を決定する最優先指示）
    recommendationScenario && !isRecSecond
      ? `・訴求シナリオ（禁止制約はこちらを優先・冒頭フレーズは⭐実例の文体から多様に学ぶこと）:\n${RECOMMENDATION_SCENARIO_GUIDES[recommendationScenario]}${pickupType && PICKUP_TYPE_NOTES[pickupType] ? `\n${PICKUP_TYPE_NOTES[pickupType]}` : ""}`
      : "",
    // 冒頭フレームは事実の宣言。シナリオごとに使ってはいけない表現をリテラルで明示する
    recommendationScenario
      ? `・🚫 このシナリオで絶対に使ってはいけない冒頭表現（1文字でも該当したらやり直し）: ${RECOMMENDATION_FORBIDDEN_OPENINGS[recommendationScenario].map((p) => `「${p}」`).join(" / ")}`
      : "",
    // 2026-09-18 竹内「実際生成された文のように質高いのかな？」: 出口で落とすだけでなく書かせない
    SELECTION_CLAIM_NOTE,
    // 2026-09-18 竹内（𝒮 さん事例）: ブレインが知っている状況（送付済み件数・まだ内覧できるか）を
    //   そのまま文の指示にする。「物件1件しか送っていない場合は お送りした中でも の部分はいれない」
    // 物件オススメの直後の2通目では渡さない（締めは recommend-cta・比較の言い方の可否は場面の形が決める＝同じ事を2か所から言わない）
    actionType === "property_recommendation" && !isRecSecond
      ? buildRecommendClosingNote({
          sentPropertyCount: recommendState.sentPropertyCount,
          notViewable: recommendState.notViewable,
          viewableFrom: recommendState.viewableFrom,
        })
      : "",
    // 「物件ピックアップした」の送付文脈（初回 / 継続 / 新着 / 条件広げ）。推す物件が決まった2通目（isRecSecond）では渡さない（形は second-message-scene）
    actionType === "property_send" && !isRecSecond
      ? (() => {
          const ctx = resolvePropertySendContext({ pickupType, priorSentPropertyCount });
          return `・送付文脈（この種別の書き方より優先）:\n${PROPERTY_SEND_CONTEXT_GUIDE[ctx]}\n・文脈判定に使った事実: ピックアップ種別=${pickupType ?? "不明"} / 今回より前の物件送付回数=${priorSentPropertyCount}回`;
        })()
      : "",
    signalCtaOverride && !fixedSecond
      ? `・CTA強度の上書き（購買シグナル優先 — アクション種別の書き方より優先）: ${signalCtaOverride}`
      : "",
    recommendationScenario
      ? `・シナリオ判定に使った事実: ${[
          pickupType ? `ピックアップ種別=${pickupType}` : "",
          effectiveCheckPattern ? `直前の物件確認結果=${CHECK_PATTERN_LABELS[effectiveCheckPattern] ?? effectiveCheckPattern}` : "",
          `今回より前にこの会話で物件を送付した回数=${priorSentPropertyCount}回（まとめ送付${priorBulkSendCount}回 / 1件送付${priorSingleSendCount}回）`,
          recommendState.sentSource === "brain" ? `この会話でお送りした物件の件数=${recommendState.sentPropertyCount}件（ブレインの行動台帳）` : "",
          hoursSinceLastSend !== null ? `直近の物件送付から${Math.round(hoursSinceLastSend)}時間経過` : "",
          priorSentPropertyCount === 0
            ? "→ 今回が初めての物件送付。既送付を前提にした比較・絞り込み表現は事実と異なるため絶対禁止"
            : canUseCompareFrame(propertySendFacts)
            ? "→ 複数物件を送付済みのため「お送りした中でも」の比較表現が事実として成立する"
            : "→ 送った物件が実質1件のみ（または送付から日数が空いている）ため「お送りした中でも」等の比較表現は事実と異なる。新たな1件として紹介すること",
        ].filter(Boolean).join(" / ")}`
      : "",
    "",
    brainMetaSection,
    // 見積書の直後の2通目では渡さない（成約パターン・ナレッジは返信の材料で、40〜110字の定型の文には関係しない・長い材料が形を崩す）
    isEstimateSecond ? "" : winningSection,
    isEstimateSecond ? "" : knowledgeSection,
    actionBucketSection,
    `━━━━━━━━━━━━━━━━━━━━\n【現在の状況】\n━━━━━━━━━━━━━━━━━━━━`,
    jstContextNote,
    elapsedLabel ? `お客様の最終返信から: ${elapsedLabel}` : "",
    "",
    `━━━━━━━━━━━━━━━━━━━━\n【お客様情報】\n━━━━━━━━━━━━━━━━━━━━`,
    // 🚨 伏せ字（〇〇）をプロンプトに入れない。入れるとそのまま本文へ転記される（2026-09-01 事故）
    resolvedCustomerName
      ? `・お客様名: ${resolvedCustomerName}さん\n  → 呼びかけは必ずこの実名を使う。「〇〇さん」「○○さん」「お客様」等の伏せ字・一般名詞で呼ぶことは絶対禁止`
      : `・お客様名: 取得できていない（実名不明）\n  → 名前で呼びかけないこと。「〇〇さん」等の伏せ字を書くことは絶対禁止。冒頭は名前なしで「お世話になっております！！」から始める（本日送信済みなら挨拶行なしで本題から。「お待たせ致しました」は禁止語）`,
    `・現在のフェーズ: ${stateLabel}`,
    customerSummary
      ? `・お客様プロフィール（AI分析・決まるパターン）: ${customerSummary}${isRecSecond ? "" : "\n  → このお客様に刺さる訴求軸（例: 審査通りやすさ・費用の安さ・設備・立地等）を読み取り、物件の特徴と結びつけた訴求に使うこと"}`
      : "",
    resolvedCustomerConditions
      ? `・希望条件（DB）: ${resolvedCustomerConditions}\n⚠️ 上記の数字・金額（家賃・築年数・駅徒歩等）は一文字も変えずにそのまま引用すること。「13万円」を「3万円」に変形する等の誤変換は絶対禁止。`
      : "・希望条件: 未取得（条件合致の断定表現は使わず、会話履歴に出た事実のみで訴求すること）",
    brainMeta?.property_search_params
      ? `・希望条件（会話由来・最新・優先）: ${
          [
            brainMeta.property_search_params.area ? `エリア希望: ${brainMeta.property_search_params.area}` : "",
            brainMeta.property_search_params.floor_plan ? `間取り希望: ${brainMeta.property_search_params.floor_plan}` : "",
            brainMeta.property_search_params.walk_minutes ? `駅徒歩${brainMeta.property_search_params.walk_minutes}分以内` : "",
            // brain-core は rent_max を円単位の生値で格納 → 万円に変換（「90000万円」等の異常値防止）
            brainMeta.property_search_params.rent_max ? `家賃上限${Math.floor((brainMeta.property_search_params.rent_max ?? 0) / 10000)}万円` : "",
            brainMeta.property_search_params.move_in_time ? `入居希望${brainMeta.property_search_params.move_in_time}` : "",
            ...prefList,
          ].filter(Boolean).join(" / ")
        }（DB条件より優先して参照すること）`
      : "",
    brainMeta?.property_search_params?.ng_points
      ? `・NG条件（絶対にこれらを物件の魅力・合致点として言及しない）: ${brainMeta.property_search_params.ng_points}`
      : "",
    (resolvedCustomerConditions || brainMeta?.property_search_params) && !fixedSecond
      ? `※顧客希望条件に合致するポイントを訴求する際は「（物件の具体的特徴）なので条件に合います」という形で物件のデータを根拠として示すこと。条件名だけを羅列しない。\n※訴求は【文章構造の原則】の段落構成に沿って、設備・立地・費用を別々の段落に分けて書くこと（1文に詰め込まない）。特に費用制約（家賃上限・初期費用を抑えたい）がある場合、礼金0円・フリーレント等の費用面メリットが会話/AIXメッセージに記載されていれば必ず1つ言及すること。`
      : "",
    staffSentToday && isRecSecond ? `・本日すでにスタッフが送信済み（挨拶の行は書かない。「お世話になっております」・「お待たせ致しました」は禁止）` : staffSentToday ? `・本日すでにスタッフが送信済み（挨拶行なし。名前行のみ「〇〇さん」または本題から始める。「お世話になっております」の再使用・「お待たせ致しました」は禁止）` : "",
    noEmoji ? `・絵文字禁止モード: 絵文字を一切使わないこと` : "",
    "",
    pendingSection
      ? `━━━━━━━━━━━━━━━━━━━━\n【🔑 予約送信待ちのAIXメッセージ（物件名・金額など事実の唯一の追加ソース）】\n━━━━━━━━━━━━━━━━━━━━\n${pendingSection}\n`
      : "",
    `━━━━━━━━━━━━━━━━━━━━\n【会話履歴（事実確認と流れの把握に使う）】\n━━━━━━━━━━━━━━━━━━━━\nこの履歴を必ず参照すること。履歴内でお客様が既に答えた質問を再度聞かない。スモラが既に伝えた情報と矛盾しない・同じ内容を繰り返さない。\n${history || "なし"}`,
    "",
    // 見積書の直後の2通目: ⭐実例は AI の下書きのまま送った申込の締めが混ざる → スタッフが書いた実物（estimateSecondNote）だけを見せる
    isEstimateSecond ? "" : examplesSection,
    // フレーズ集（phrase_dictionary）は「これ以上ない条件のお部屋です」等の評する言い回しが並ぶ → 物件オススメの直後の2通目では渡さない（形は実物で渡す）
    fixedSecond ? "" : phrasesSection,
    fixedSecond
      ? `この会話の流れ・お客様の状況に合った「${actionLabel}」の直後の2通目を1通生成してください。金額・空室状況・日程・物件名は上記の会話履歴/AIXメッセージに記載がある事実のみ使い、なければ言及しないこと。出力は本文のみ。`
      : `この会話の流れ・お客様の状況に合った「${actionLabel}」の橋渡し文を1通生成してください。金額・空室状況・日程・物件名は上記の会話履歴/AIXメッセージに記載がある事実のみ使い、なければ言及しないこと。⭐実例の文体・テンポを忠実に再現すること。` +
    // 2026-09-20 竹内「残る差もテストして改善する」:
    //   ②は「呼びかけるなら実名で」という意味だが、LLM は「毎回呼びかける」と読んでいた
    //   （YUMA の2通目で名前呼びかけ100%・実送信の2通目は35.1%）。
    //   2通目（sentMessage あり）の時だけ「入れる場合は」に変える。1通目の文言は変えない。
    `\n【必ず守る2点】①訴求は1文に詰め込まず、設備／立地／費用を空行で区切った段落に分けて書く（【文章構造の原則】の段落構成に従う）。②呼びかけ${
      sentMessage ? "を入れる場合は" : "は"
    }${
      resolvedCustomerName ? `「${resolvedCustomerName}さん」の実名のみ` : "省略（名前を書かない）"
    }。「〇〇さん」等の伏せ字を本文に書いた時点でやり直し。\n${
      recommendationScenario
        ? `訴求シナリオは「${RECOMMENDATION_SCENARIO_LABELS[recommendationScenario]}」。禁止制約（比較表現禁止等）とCTA強度は必ず守ること。冒頭の言い回しは⭐実例の文体を参考に毎回変化させること（固定フレーズを繰り返さない）。`
        : ""
    }出力は本文のみ。`,
    // 2026-09-20 竹内「実際の成約データや直近の文のようになっているか確認」:
    //   2通目（AIX の直後に送るテンプレ）の指示は**最後に置く**。
    //   ここより前には「【文章構造の原則】5段落構成（5段落目=CTA）」「この種別の書き方（CTA は…）」
    //   「CTA強度の上書き」「【必ず守る2点】①段落構成に従う」と、**1通目用の骨格が何重にも入っている**。
    //   YUMA で測ると申込の誘導が 100%（実送信8.8%）になり、前に置いた上書きは効かなかった。
    //   設計知見「同じ事実について書くなと書けを別の場所から渡さない」→ 最後に1回だけ明示して上書きする。
    aixChainNote,
    // 物件オススメの直後の2通目: 資料の事実 → 場面の形（実送信の実物）→ 締め の順で最後に置く
    secondMaterialNote,
    secondSceneNote,
    // CTA の有無は**お客様の反応と AIX の種類**で決める（実測・cta-guidance）。最後に置くのは上と同じ理由
    recCta
      ? buildSecondMessageCtaNote(recCta, { firstMessage: sentMessage, viewableFrom: isRecSecond ? secondViewableFrom : recommendState.viewableFrom })
      : isEstimateSecond ? "" : (ctaGuidance?.note ?? ""),
    // 見積書の直後の2通目の形・締め（最後に1か所）
    estimateSecondNote,
  ].filter(Boolean).join("\n");

  // ── DB学習資産の第2システムブロック（TTLキャッシュ内はbyte-stable → prompt cache対象）──
  const dbKnowledgeBlock = [
    topPrinciples.length > 0
      ? "【📌 絶対原則（DB学習・全顧客共通・常時遵守）】\n" +
        topPrinciples.map((p, i) => `${i + 1}. ${p.title ? `[${p.title}] ` : ""}${p.content}`).join("\n")
      : "",
    lossPatterns.length > 0
      ? "【🚫 避けるべき対応（失注実例より）】\n" +
        lossPatterns.map((p, i) => `${i + 1}. ${p.content}`).join("\n")
      : "",
    dbRules ? dbRules.trim() : "",
  ].filter(Boolean).join("\n\n");

  // ── Anthropic API (Claude Sonnet + prompt cache) ─────────────────────────
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").replace(/\s/g, "");
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
  }

  try {
    // 2026-09-17 竹内（AIX キャッシュ点検）: この経路は3日に1回程度しか呼ばれず（llm_usage_logs: 3日で1件・
    // cache_write_1h 74,644・cache_read 0）、1h TTL は書き込み料（×2）だけ払って一度も読まれない純損だった。
    // 5m にして書き込み料を ×1.25 に下げる（同一リクエスト内の frame violation 再生成では読まれる）。
    // 呼び出し頻度が上がったら cache_write_1h と cache_read の比で再判定する（1h の損益分岐は hit 率 53%）。
    const systemBlocks: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" } }> = [
      {
        type: "text",
        text: `${PRIORITY_ORDER_NOTE}\n\n${STATIC_GEN_SYSTEM}\n\n${SHARED_RULES_SYSTEM}`,
        cache_control: { type: "ephemeral", ttl: "5m" },
      },
    ];
    if (dbKnowledgeBlock) {
      systemBlocks.push({
        type: "text",
        text: dbKnowledgeBlock,
        cache_control: { type: "ephemeral", ttl: "5m" },
      });
    }

    const callClaude = async (prompt: string): Promise<{ ok: true; text: string } | { ok: false; status: number }> => {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: AbortSignal.timeout(55_000),
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31",
          ...sumoraLlmMarks("aix_template"),
        },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 1024,
          // claude-sonnet-5はthinking省略時adaptiveがデフォルト有効 → max_tokens 1024を
          // thinkingが消費して橋渡し文が途切れるのを防ぐ（generate-replyと同設定）
          thinking: { type: "disabled" },
          system: systemBlocks,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => "");
        console.error(`[aix-template-generate] Anthropic error ${r.status}:`, errText.slice(0, 300));
        return { ok: false, status: r.status };
      }
      const d = await r.json() as { content?: Array<{ type: string; text?: string }> };
      return { ok: true, text: d.content?.find((b) => b.type === "text")?.text?.trim() ?? "" };
    };

    // 2026-10-01: 手元のテストだけ、組み立てた system／user の全文をファイルに書き出す（設計知見「最後に置いた指示が勝つ」＝全文を読んで確かめる）。
    //   AIX_PROMPT_DUMP_DIR を起動コマンドに付けた時だけ・本番（Vercel）では isTestModeAllowed が false で動かない
    if (process.env.AIX_PROMPT_DUMP_DIR && isTestModeAllowed(process.env)) {
      try {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(`${process.env.AIX_PROMPT_DUMP_DIR}/template-${actionType ?? "none"}-${Date.now()}.txt`,
          `===== SYSTEM =====\n${systemBlocks.map((b) => b.text).join("\n\n----- (block) -----\n\n")}\n\n===== USER =====\n${userPrompt}`);
      } catch (e) { console.warn("[aix-template-generate] prompt dump failed:", e instanceof Error ? e.message : e); }
    }
    const first = await callClaude(userPrompt);
    if (!first.ok) {
      return NextResponse.json({ ok: false, error: `AI生成エラー: ${first.status}` }, { status: 500 });
    }
    let text = first.text;
    if (!text) {
      return NextResponse.json({ ok: false, error: "empty result" }, { status: 500 });
    }
    // 2026-09-27 竹内さん「資料の文字はそのまま」: 号室の先頭ゼロ除去（stripRoomLeadingZeros）はやめた

    // 伏せ字「〇〇さん」の決定論修正（実名に置換 / 名前不明なら呼びかけごと削除）
    const nameFix = fixNamePlaceholderAddress(text, resolvedCustomerName);
    if (nameFix.fixed) {
      console.warn(
        `[aix-template-generate] 伏せ字の呼びかけ「〇〇さん」を検出 → ${resolvedCustomerName ? `「${resolvedCustomerName}さん」に置換` : "呼びかけごと削除"}`,
      );
      text = nameFix.text;
    }

    // ── 2通目の出口（2026-09-30 YUMA の実送信テスト: 物件オススメ → 2通目で 4回中4回おかしな文が届いた）──────────
    //   ① 作業メモ・渡した指示の復唱（「【2通目】お客様が選びやすい形で、ひとこと添える。…」「…橋渡し文を書きます。／---／本文」）
    //   ② 1通目と別の物件の話（1通目 203号室 → 2通目「ファーストフィオーレ難波ウエスト901号室は…」）
    //   どちらも入口（aix-chain-note）では止まらなかった。ここで検査して1回だけ作り直し、直らなければ本文として返さない（入力欄に入れない）。
    //   検査は純関数（meta-narration.ts isNotACustomerReply・aix-chain-note.ts foreignRoomsInSecond）。1通目が無い生成は今まで通り
    if (sentMessage) {
      const secondProblem = (t: string): string | null => {
        const cleaned = stripMetaNarration(t).text;
        if (!cleaned.trim() || isNotACustomerReply(cleaned)) return "お客様に送る本文ではなく、作業メモや指示の復唱になっている";
        // 別の号室を見るのは物件オススメ（1通目が1件の物件）の時だけ。物件ピックアップは1通目の本文に全部の物件名が出ない
        //   （画像で複数送り、2通目で「お送りした中でも特に◯◯ 302号室が」と1件を推すのが実送信の形＝scripts/audit-second-message-exit.ts で 699組中17組が1通目に無い号室）
        const foreign = isRecSecond ? foreignRoomsInSecond(cleaned, secondFirstForCheck) : [];
        if (foreign.length > 0) return `1通目に無い物件（${foreign.map((r) => `${r}号室`).join("・")}）の話が入っている`;
        return null;
      };
      const problem = secondProblem(text);
      if (problem) {
        console.warn(JSON.stringify({ tag: "aix-template-generate:second-retry", actionType, problem, head: text.slice(0, 80) }));
        const retry = await callClaude(
          userPrompt +
          `\n\n━━━━━━━━━━━━━━━━━━━━\n【🚨 作り直し（前回の出力は使えない）】\n━━━━━━━━━━━━━━━━━━━━\n` +
          `前回の出力は「${problem}」ため使えません。\n` +
          `・お客様にそのまま送る本文だけを書く。見出し（【…】）・区切り線・自分の作業の説明・ここに書かれた指示の言い回しは書かない。\n` +
          `・物件の話をするなら、直前に送った1通目の物件だけ。会話履歴にある別の物件の名前・号室・金額は出さない。\n` +
          `出力は本文のみ。`,
        );
        const retryText = retry.ok && retry.text ? fixNamePlaceholderAddress(retry.text, resolvedCustomerName).text : "";
        const still = retryText ? secondProblem(retryText) : "作り直しに失敗した";
        if (still) {
          console.error(JSON.stringify({ tag: "aix-template-generate:second-blocked", actionType, problem: still, head: (retryText || text).slice(0, 80) }));
          return NextResponse.json({
            ok: false,
            error: `2通目の文を作れませんでした（${still}・送信欄には入れていません）。もう一度生成してください。`,
          }, { status: 200 });
        }
        text = retryText;
      }
    }

    // ── 2通目の言い回しの出口（2026-09-30 竹内「言い回しが AI くさい。208号室など号室だけのところいれへんし、強みですなどもいれていない」）──
    //   AI だけが書いてスタッフが書かない言い回し（強みです・ならでは・珍しい・好条件です・お値打ち・魅力です・かと思います・号室だけで呼ぶ 等）と、
    //   手本の物件名・駅・金額の持ち込みを検査し、当たれば1回だけ作り直す。本文は書き換えない（言い回しの置き換えは文を壊す）。
    //   線: scripts/audit-second-message-phrasing.ts（365日・実送信の2通目 477組）でこの検査に当たる実送信は 0 ＝ 誤って作り直しになる数 0。
    //   作り直しても残った時は、当たりの少ない方を返して warn を残す（入力欄で人が読んで送る。止めはしない）
    if (isRecSecond) {
      const allowed = `${sentMessage ?? ""}\n${secondMaterialNote}\n${pickupPushLabel ?? ""}`;
      const styleHits = (t: string) => {
        const cost = unfoundedCostClaim(t, materialRow, sentMessage);
        return [...findAiPhrases(t).map((h) => `「${h.match}」`), ...leakedExampleFacts(t, allowed).map((f) => `手本の「${f}」`), ...(cost ? [`「${cost}」（資料では敷金か礼金があるお部屋）`] : [])];
      };
      const hits = styleHits(text);
      if (hits.length > 0) {
        console.warn(JSON.stringify({ tag: "aix-template-generate:second-style-retry", hits, head: text.slice(0, 80) }));
        const retry = await callClaude(
          userPrompt +
          `\n\n━━━━━━━━━━━━━━━━━━━━\n【🚨 作り直し（前回の出力はスタッフが書かない言い回しだった）】\n━━━━━━━━━━━━━━━━━━━━\n` +
          `前回の出力:\n${text}\n\n` +
          `この中の ${hits.join("・")} は、スタッフの実際の2通目には1通も無い書き方です。\n` +
          `・言い回しを言い換えるのではなく、【この2通目の形】の実物と同じ形で最初から書き直す。\n` +
          `・物件は建物名から書く（号室だけで呼ばない）。理由は事実をつないで「かなりオススメ出来るお部屋となります！！」で結ぶ。\n` +
          `出力は本文のみ。`,
        );
        const retryText = retry.ok && retry.text ? fixNamePlaceholderAddress(retry.text, resolvedCustomerName).text : "";
        const still = retryText ? styleHits(retryText) : hits;
        if (retryText && still.length < hits.length && !isNotACustomerReply(stripMetaNarration(retryText).text)
          && foreignRoomsInSecond(retryText, secondFirstForCheck).length === 0) {
          text = retryText;
        }
        if (still.length > 0) console.warn(JSON.stringify({ tag: "aix-template-generate:second-style-left", hits: still, head: (retryText || text).slice(0, 80) }));
      }
    }

    // ── 見積書の直後の2通目の出口（2026-10-01）: 申込の誘い（決めた締めが申込でない時）・評する一文・総額の言い直し・号室だけの呼び方 ──
    //   当たれば1回だけ作り直す（本文は書き換えない）。線: scripts/audit-estimate-second.ts（365日・スタッフが書いた2通目 132通）で
    //   評する一文 0・号室だけ 0・総額の言い直し 3（2%）・申込 23（17%＝竹内さんの決まり「見積書の後は申込へではない」で入れた検査）
    if (isEstimateSecond) {
      const hits = findEstimateSecondProblems(text, { closing: estimateClosing, first: sentMessage });
      if (hits.length > 0) {
        console.warn(JSON.stringify({ tag: "aix-template-generate:estimate-second-retry", hits, head: text.slice(0, 80) }));
        const retry = await callClaude(
          userPrompt +
          `

━━━━━━━━━━━━━━━━━━━━
【🚨 作り直し（前回の出力はこの場面のスタッフの2通目の形ではない）】
━━━━━━━━━━━━━━━━━━━━
` +
          `前回の出力:
${text}

` +
          `この中の ${hits.map((h) => `「${h.match}」`).join("・")} は、この場面でスタッフが書かない文です` +
          `（${hits.map((h) => ({ apply: "申込の誘いは書かない", eval: "物件を評する・気持ちの文は書かない", amount: "金額は1通目の御見積書が正なので言い直さない", room: "号室だけで呼ばない" } as Record<string, string>)[h.key] ?? "").join("・")}）。
` +
          `・【この2通目の形】の実物と同じ形で最初から書き直す。出力は本文のみ。`,
        );
        const retryText = retry.ok && retry.text ? fixNamePlaceholderAddress(retry.text, resolvedCustomerName).text : "";
        const still = retryText ? findEstimateSecondProblems(retryText, { closing: estimateClosing, first: sentMessage }) : hits;
        if (retryText && still.length < hits.length && !isNotACustomerReply(stripMetaNarration(retryText).text)) text = retryText;
        if (still.length > 0) console.warn(JSON.stringify({ tag: "aix-template-generate:estimate-second-left", hits: still, head: (retryText || text).slice(0, 80) }));
      }
    }

    // ── 訴求フレーム違反の決定論ガード（生成後チェック＋1回だけ再生成）──────────
    // 「1件しか送っていないのに“これまでお送りした中でも”」「新着でないのに“募集に出ました”」は
    // 顧客からの信頼を最も損なう事実齟齬。プロンプト指示だけに委ねず出力を検査して弾く。
    // 判定材料は aix_usage_logs の事実のみ（LLM推論に依存しない）。
    // 検査は app/lib/recommendation-frame.ts（AIX ボタン本体と同じ物）
    let frameRetried = false;
    const violation = detectFrameViolation(text, recommendationScenario);
    if (violation && recommendationScenario) {
      frameRetried = true;
      console.warn(`[aix-template-generate] frame violation scenario=${recommendationScenario}: ${violation} → 再生成`);
      const retryPrompt =
        userPrompt +
        `\n\n━━━━━━━━━━━━━━━━━━━━\n【🚨 再生成指示（前回の出力が訴求シナリオに違反）】\n━━━━━━━━━━━━━━━━━━━━\n` +
        `前回の生成文は「${violation}」を含んでおり、この会話の事実と異なります。\n` +
        `訴求シナリオ「${RECOMMENDATION_SCENARIO_LABELS[recommendationScenario]}」の冒頭フレームを厳守し、該当表現を一切使わずに書き直してください。\n` +
        `禁止表現: ${RECOMMENDATION_FORBIDDEN_OPENINGS[recommendationScenario].map((p) => `「${p}」`).join(" / ")}\n` +
        `出力は本文のみ。`;
      const retry = await callClaude(retryPrompt);
      if (retry.ok && retry.text) {
        const retryText = fixNamePlaceholderAddress(retry.text, resolvedCustomerName).text;
        // 再生成が違反を解消していれば採用。まだ違反していれば初回結果を維持する
        if (!detectFrameViolation(retryText, recommendationScenario)) text = retryText;
        else console.warn("[aix-template-generate] frame violation 再生成後も未解消 — 初回結果を返却");
      }
    }

    // ── 出口の掃除（2026-09-18 竹内「テンプレートよくわからん文生成される」）──────────────
    // 返信生成（generate-reply）と AIX 本体（aix/action）には、竹内さんとの積み重ねで作った出口の決定論が
    // 通っているのに、**テンプレート生成には1つも通っていなかった**（入口だけ直しても生成後の癖が残る）。
    // 本番検証で出た実例と実データ（365日・スタッフ実送信）:
    //   ・「お待たせ致しました」… greeting.ts で**禁止語**として全廃済み（返信では stripWaited で除去・
    //      final-check で block）なのに、テンプレートでは素通りして出ていた
    //   ・「前回お送りしたお部屋と重複しないよう」… 実送信 0件
    //   ・「ぜひ見比べてご検討ください」… 「見比べ」実送信 1件
    // 既にある純関数をここにも配る（設計知見「同じ判定は同じ関数・入口は1つ」）。
    {
      // 2026-09-20 竹内（差分調査・「結果を届ける AIX では許す」）:
      //   この語は**場面によって正誤が正反対**だった。実測（60日・生成と実送信が両方ある1,805件）で
      //   スタッフがどうしたかを経路別に数えると、見積書送る 残21/消0/**足16**・物件確認した（申込あり）
      //   残0/消0/**足7**・物件ピックアップ 残66/消6/足6 に対し、内覧日調整は 残1/**消14**/足0。
      //   ＝「待たせた作業の結果を届ける」場面では正しい文で、無条件に消すと**スタッフが手で足し直す**。
      //   判定は waited-scope.isWaitedAllowed に一本化（AIX 本体・テスト・監査が同じ物を見る）。
      // 2026-09-27 竹内さん決定で上書き: AIX でも「お待たせ致しました」は使わない → 許す一覧は空で、ここは常に落とす。
      if (!isWaitedAllowed(actionType)) {
        const waited = stripWaited(text);
        if (waited.removed > 0) {
          console.log(JSON.stringify({ tag: "aix-template-generate:strip-waited", actionType, removed: waited.removed }));
          text = waited.text;
        }
      }
      // 2026-09-20 竹内「実際の成約データや直近の文のようになっているか確認」:
      //   YUMA の検証で「**夜分に失礼いたします！！**」「**承知いたしました！！**」が出た。どちらも禁止語で、
      //   返信生成・AIX 本体（aix/action の finalize）には normalizeBannedPhrasing が通っているのに、
      //   **テンプレート生成には配られていなかった**（設計知見「出口の決定論も同じ関数で全経路に配る」）。
      //   中身: 夜間挨拶の除去／承知→かしこまりました／約束の「すぐに」除去／単独の承りました／挨拶の重複。
      //   2通目はお客様への返信なので夜間挨拶は残さない（keepNightGreeting: false）。
      // ── 2026-09-20 竹内「生成される文に抜けやエラーがないかも合わせて確認」──────────────
      //   16通の検証で **AI の思考過程がそのまま**出た:
      //   「今回1番手申込中（203号室）で…2通目は、営業ではなく**申込・審査状況への配慮**を優先すべき場面です。
      //     今回のブリッジ文（…」
      //   竹内さんの絶対ルール「AI の作業メモは下書き欄に絶対入れない」に反する。
      //   返信生成（applySurfaceFixes）と AIX 本体（finalize）には isNotACustomerReply / stripMetaNarration が
      //   通っているのに、**テンプレート生成には配られていなかった**（normalizeBannedPhrasing と同じ漏れ）。
      {
        const meta = stripMetaNarration(text);
        if (meta.removed.length > 0) {
          console.log(JSON.stringify({ tag: "aix-template-generate:meta-narration-removed", actionType, removed: meta.removed.map((r) => r.slice(0, 60)) }));
          text = meta.text;
        }
        // LINE はマークダウンを解釈しない（プロンプトでも禁止しているが守られない時がある）
        const noBold = text.replace(/\*\*/g, "");
        if (noBold !== text) {
          console.log(JSON.stringify({ tag: "aix-template-generate:markdown-stripped", actionType }));
          text = noBold;
        }
        // 全部が作業メモだった時は**本文として返さない**（画面のエラー表示に出す＝入力欄には入れない）
        if (!text.trim() || isNotACustomerReply(text)) {
          console.error(JSON.stringify({ tag: "aix-template-generate:not-a-reply", actionType, head: text.slice(0, 80) }));
          return NextResponse.json({
            ok: false,
            error: `お客様への返信になっていません（送信欄には入れていません）。もう一度生成してください。\n${text.trim().slice(0, 200)}`,
          }, { status: 200 });
        }
      }
      {
        const banned = normalizeBannedPhrasing(text, { keepNightGreeting: false });
        if (banned.night || banned.shochi || banned.hasty || banned.uketamawari || banned.greetDup) {
          console.log(JSON.stringify({
            tag: "aix-template-generate:banned-phrasing-fixed", actionType,
            night: banned.night, shochi: banned.shochi, hasty: banned.hasty,
            uketamawari: banned.uketamawari, greetDup: banned.greetDup,
          }));
          text = banned.text;
        }
      }
      // 「複数の物件について」等、物件名を並べた直後の数のまとめ語（a🤫 事例）
      const vague = stripVagueQuantifier(text);
      if (vague.removed.length > 0) {
        console.log(JSON.stringify({ tag: "aix-template-generate:vague-quantifier", removed: vague.removed }));
        text = vague.text;
      }
      // ピックアップの宣言行に物件名を入れない（✩ さん事例）。物件を送る系の文だけが対象
      if (actionType === "property_send" || actionType === "property_recommendation") {
        const convNames = extractPropertyLabels(
          (Array.isArray(recentMessages) ? recentMessages : [])
            .filter((m) => m.sender === "staff").map((m) => m.text ?? "").join("\n"),
        );
        const picked = stripPropertyNameFromPickupLine(text, convNames);
        if (picked.removed.length > 0) {
          console.log(JSON.stringify({ tag: "aix-template-generate:pickup-line", removed: picked.removed }));
          text = picked.text;
        }
        const echoPolished = polishConditionEcho(text, { includeReports: true });
        if (echoPolished.applied.length) text = echoPolished.text;
      }
      // こちらが確かめていない選び方の主張（「重複しないよう選定しております」＝実送信0件・
      //   スタッフが書くのは逆の「重複しますが」9件だけ）
      const claim = stripUnfoundedSelectionClaim(text);
      if (claim.removed.length > 0) {
        console.log(JSON.stringify({ tag: "aix-template-generate:selection-claim", removed: claim.removed }));
        text = claim.text;
      }
      // 根拠のないお礼の行（直近のお客様の発言に紐づかないお礼）
      const thanks = stripRepeatedThanksLines(text);
      if (thanks.removed > 0) {
        console.log(JSON.stringify({ tag: "aix-template-generate:repeated-thanks", removed: thanks.removed }));
        text = thanks.text;
      }
    }

    // 2026-09-18 竹内（𝒮 さん事例）「状況に合わせて、物件申込誘導するのと、物件1件しか送っていない場合は
    //   お送りさせて頂いたお部屋の中でもの部分はいれない」:
    //   ①送った物件が1件以下なら比較の言い方を落とす（実データ179件すべて2件以上送っている時だけ）
    //   ②まだ内覧できないお部屋（退去予定・解禁日が明日以降）は内覧誘導ではなく申込誘導（実データ 34 vs 9）
    {
      // 生成後の本文に退去予定が書かれている場合もあるため、本文も材料に入れて状況を取り直す
      const exitState = resolvePropertySendState({
        brainMeta,
        recentMessages: Array.isArray(recentMessages) ? recentMessages as Array<{ sender?: string | null; text?: string | null }> : [],
        extraText: text,
        fallbackSentCount: priorSentPropertyCount,
      });
      // 見積書の直後の2通目は締めを estimate-second-message が決める（ブレインの「まだ内覧できない」は会話全体の判断で、見積書のお部屋の事とは限らない＝内覧の誘いを申込に替えない）
      const closing = isEstimateSecond ? { text, applied: [] as string[] } : fixRecommendClosing(text, {
        sentPropertyCount: exitState.sentPropertyCount,
        notViewable: exitState.notViewable,
      });
      if (closing.applied.length > 0) {
        console.log(JSON.stringify({ tag: "aix-template-generate:recommend-closing", applied: closing.applied, state: describePropertySendState(exitState) }));
        text = closing.text;
      }
      // 2026-09-30: 締めを刺さり具合の3つに揃える（1通目が既に同じ締めなら重ねない＝何もしない）。
      //   消すのは「定型だけの最後の段落」だけ・無ければ足す（recommend-cta.ts）
      // 2026-10-01: 退去予定の一文の字を決まった形に戻す・同じ行に続けて書いた締めの文を次の段落に分ける（1通目と同じ関数・文は消さない）
      if (isRecSecond) {
        const tidy = tidyVacatingAndClosing(text, secondViewable);
        if (tidy.applied.length > 0) { console.log(JSON.stringify({ tag: "aix-template-generate:second-vacating-tidy", applied: tidy.applied })); text = tidy.text; }
      }
      // 2026-10-01 竹内さん了承(a): 1通目が同じ締めでも2通目に締めを付ける（実送信: 1通目に締め20組→2通目にも締め17・同じ種類10）
      if (recCta) {
        const cta = setRecommendClosing(text, recCta.kind);
        if (cta.applied.length > 0) {
          console.log(JSON.stringify({ tag: "aix-template-generate:recommend-cta-closing", kind: recCta.kind, applied: cta.applied }));
          text = cta.text;
        }
      }
    }

    console.log(
      `[aix-template-generate] action=${actionType || actionCategory || "-"}` +
      ` rag_wp=${winningSection ? "hit" : "miss"} rag_kn=${knowledgeSection ? "hit" : "miss"}` +
      ` rag_ex=${examplesSection ? "hit" : "miss"} phrases=${phraseList.length}` +
      ` principles=${topPrinciples.length} loss=${lossPatterns.length} dbRules=${dbRulesGeneric ? "ok" : "none"} dbRulesAction=${dbRulesAction ? "ok" : "none"}` +
      ` ${describeBrainStrategyNote(brainMeta, { fresh: !isStaleMeta })} brainAction=${brainMeta?.action || "-"} ragQueryLen=${ragQueryLength}` +
      ` actionBucket=${actionBucketCategory ? `${actionBucketCategory}:${actionBucketRows.length}` : "-"}` +
      ` aix_ex=${unifiedAixExCount} unified_ex=${unifiedExCount} aixVec=${aixVecHitCount} starSeed=${aixStarSeedCount}` +
      ` knUsedIds=${knowledgeUsedIds.length}` +
      ` scenario=${recommendationScenario ?? "-"} pickup=${pickupType ?? "-"}` +
      ` checkPat=${effectiveCheckPattern ?? "-"}${checkIsStale ? "(stale)" : ""}` +
      ` sentProps=${sentPropertyLogCount} priorProps=${priorSentPropertyCount}(bulk=${priorBulkSendCount},single=${priorSingleSendCount})${currentSendAlreadyLogged ? "(self-excluded)" : ""}` +
      ` state=${describePropertySendState(recommendState)}` +
      ` lastSendH=${hoursSinceLastSend === null ? "-" : Math.round(hoursSinceLastSend)} compareOk=${recommendationScenario ? canUseCompareFrame(propertySendFacts) : "-"} frameRetry=${frameRetried ? "on" : "off"}` +
      ` signal=${brainMeta?.purchase_signal_level ?? "-"} stance=${brainMeta?.engagement_stance ?? "-"} ctaOverride=${signalCtaOverride ? "on" : "off"}` +
      ` name=${resolvedCustomerName ? "ok" : "none"} namePassed=${customerName ? "yes" : "no"} namePlaceholderFix=${nameFix.fixed ? "on" : "off"}`,
    );

    // M1: ナレッジ使用テレメトリ（レスポンス返却後に fire-and-forget — 生成成功時のみカウント）
    // 2026-09-27 竹内: テスト用の会話（YUMA）はナレッジの使用回数に入れない
    if (!isTestConversation(conversationId as string | undefined)) incrementKnowledgeUsage(knowledgeUsedIds);

    // 2026-09-18 竹内「テンプレートよくわからん文生成される」:
    //   テンプレート生成は **aix_generate_log に1行も残していなかった**（AIX 本体 aix/action は残している）。
    //   そのため「何が生成されたか」を後から追えず、週次の学習も原因の調査もできなかった
    //   （設計知見「未対応の分岐は静かにデータを消す — その形が DB に何件あるかで見つける」）。
    //   status は 'generated' にして、既存の used/discarded の集計（aix-weekly-learning・morning-report）を汚さない。
    //   材料（ブレインの鮮度・訴求シナリオ・物件の状況）も残して、後から原因を1行で追えるようにする。
    if (conversationId) {
      after(async () => {
        try {
          await supabase.from("aix_generate_log").insert({
            action_type: actionType ?? actionCategory ?? null,
            conversation_id: conversationId,
            status: "generated",
            generated_text: text.slice(0, 2000),
            conditions_snapshot: {
              source: "aix-template-generate",
              brain: describeBrainStrategyNote(brainMeta, { fresh: !isStaleMeta }),
              brain_action: brainMeta?.action ?? null,
              scenario: recommendationScenario ?? null,
              pickup_type: pickupType ?? null,
              property_state: describePropertySendState(recommendState),
              action_category: actionCategory ?? null,
              conversation_state: conversationState ?? null,
            },
          });
        } catch (e) {
          console.error("[aix-template-generate] aix_generate_log insert failed:", e);
        }
      });
    }

    // 物件オススメの直後の2通目: 絵文字が1つも無ければ最後の「！！」の直前に 😊（実送信で絵文字なしは 11%・位置は文末が 86%。足すだけ）
    // 2026-10-01: 資料から退去予定と分かっていて、1通目も2通目も退去予定に触れていない → 決まった一文を締めの直前に入れる（足すだけ・1通目と同じ関数）
    if (isRecSecond && (pickupPushLabel || !mentionsVacating(sentMessage))) {
      const vl = ensureVacatingLine(text, secondViewable);
      if (vl.added) { console.log(JSON.stringify({ tag: "aix-template-generate:second-vacating-line-added", line: secondViewable.line })); text = vl.text; }
    }
    if (isRecSecond) {
      // 「YUMAさんかなりオススメ出来る」→「YUMAさんにかなりオススメ出来る」（実送信 814 対 3）
      const ni = fixMissingNi(text);
      if (ni.fixed > 0) { console.log(JSON.stringify({ tag: "aix-template-generate:second-ni-fixed", fixed: ni.fixed })); text = ni.text; }
      // 2026-10-01 竹内「上の『浅く・』を直す」（YUMA の2通目「築年数浅く・バス・トイレ別」）: 「〜く・」→「〜く、」（1通目と同じ関数・語は消さない）
      const fa = fixAdjectiveNakaguro(text);
      if (fa.changed > 0) { console.log(JSON.stringify({ tag: "aix-template-generate:second-adj-nakaguro", changed: fa.changed })); text = fa.text; }
    }
    if (isRecSecond && !noEmoji) {
      const em = ensureOneEmoji(text);
      if (em.added) { console.log(JSON.stringify({ tag: "aix-template-generate:second-emoji-added" })); text = em.text; }
    }
    // 見積書の直後の2通目: 決めた締めの文が無ければ足す（足すだけ・消さない）
    if (isEstimateSecond) {
      const ec = ensureEstimateClosing(text, estimateClosing);
      if (ec.added) { console.log(JSON.stringify({ tag: "aix-template-generate:estimate-closing-added", closing: estimateClosing })); text = ec.text; }
    }
    // 2026-10-01 竹内「同じ絵文字を2重で使っているが実際していない。もう一つの絵文字を使うか省いている」:
    //   文末の同じ絵文字の2回目以降は、誘導の締めなら外し・他は 😌／😊 の未使用の方に替える（実送信で同じ絵文字だけは 4.0%・emoji-repeat.ts）
    if (!noEmoji) {
      const dr = dedupeRepeatedEmoji(text);
      if (dr.changes.length) { console.log(JSON.stringify({ tag: "aix-template-generate:emoji-repeat-fixed", changes: dr.changes })); text = dr.text; }
    }
    // 2026-09-22 竹内: 今日すでにこちらが送っていれば、冒頭の「お世話になっております」を落とす（AIX 本体の finalize と同じ関数）
    if (staffSentToday) {
      const daily = applyDailyGreeting(text, { staffSentToday: true, greetingPhrase: "", name: "" });
      if (daily.action === "removed") {
        console.log(JSON.stringify({ tag: "aix-template-generate:daily-greeting-removed", actionType, conversationId }));
        text = daily.text;
      }
    }
    // 2026-09-20 竹内「生成される文が長すぎる」: 長さを**記録する**（切らない）。
    //   出口で切ると文の途中で終わって壊れるので、ここでは測ってログに残すだけ。
    //   指示（buildLengthNote）が効いているかを後から scripts/audit-template-length.ts で追える。
    {
      const lc = checkLength(text, actionType);
      if (!lc.ok) {
        console.warn(JSON.stringify({ tag: "aix-template-generate:too-long", actionType, len: lc.len, lines: lc.lines, over: lc.over }));
      } else {
        console.log(JSON.stringify({ tag: "aix-template-generate:length", actionType, len: lc.len, lines: lc.lines }));
      }
    }

    return NextResponse.json({ ok: true, text });
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI生成エラー";
    console.error("[aix-template-generate] error:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
