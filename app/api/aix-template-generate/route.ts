import { NextRequest, NextResponse, after } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { generateEmbedding } from "@/app/lib/knowledge-utils";
import { stripRoomLeadingZeros } from "@/app/lib/template-preprocess";
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
// AIX-META（suggested_aix_meta）の型は brain-core を単一ソースとして参照（type-only importのためランタイム依存なし）
import type { SuggestedAixMeta } from "@/app/lib/brain-core";

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
・冒頭挨拶: 通常は「（実名）さんお世話になっております！！」。本日すでにスタッフが送信済みの場合は「お待たせ致しました！！」
・長すぎない。3〜7文程度でテンポよく
・「させて頂きます」「頂きます」を自然に多用する（スモラの文体の核心）
・締めは「お手隙の際にご査収ください😌！！」等で圧を下げる（絵文字禁止時は絵文字なしで）
・内覧後のシーンで感想を聞かない（「御礼+申込宣言+いつでもご連絡ください」の宣言形で締める）
・スモラの基本構成: ①直接の呼びかけ・位置づけ → ②スタッフの行動宣言（WE DO）→ ③柔らかい締め。お客様がすべきことは最小限にする

━━━━━━━━━━━━━━━━━━━━
【禁止ワード・表現】
━━━━━━━━━━━━━━━━━━━━
× 「スモラ」という会社名 → 「弊社」
× 「コスパ」表現 → 「好条件」「お値打ちな条件」
× 「共益費込み」→「家賃管理費込」
× 「即入居可能」→ 会話に明記がなければ絶対に書かない
× 「承りました」「ご確認のほど」「確認中です」「少々お待ちください」
× 「〇〇とのことですね」等のオウム返し
× 「ご共有頂き」→ お客様には「お送り頂き」
× 「仲介手数料を割引」→「初期費用を最大限割引させていただきます」
× マークダウン太字（**）等の記法（LINEは非対応）
× 謝罪の多用（「申し訳ございません」の連発）
× 敷金を初期費用削減として訴求（敷金は返還される預かり金）
× 号室の先頭ゼロ（0906号室 → 906号室）
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
type RecommendationScenario = "compare" | "new_listing" | "alternative" | "followup_single" | "first";

/** 訴求シナリオ判定の材料となる「この会話の物件送付事実」（今回送信分は含めない） */
type PropertySendFacts = {
  /** 今回のAIX送信より「前」に物件を送付した回数 */
  priorSentPropertyCount: number;
  /** うち「まとめ送付」（property_send＝複数物件を一度に送るAIX）の回数 */
  priorBulkSendCount: number;
  /** うち「1件送付」（property_recommendation＝1件だけ送るAIX）の回数 */
  priorSingleSendCount: number;
  /** 直近の物件送付からの経過時間（時間）。送付実績なしは null */
  hoursSinceLastSend: number | null;
};

// 「お送りした中でも」は“複数の中から選んだ”という事実の宣言。1週間以上前の送付を
// 「中でも」で引き合いに出すのは文脈が切れており、お客様側の記憶とも合わない。
const COMPARE_FRAME_STALE_HOURS = 24 * 7;

/**
 * 「お送りした中でも〜」（比較選択フレーム）を事実として使ってよいかを判定する。
 * 竹内の判断軸: 送った物件が1件のみなら“中でも”ではなく「新着/新たな1件」として紹介するのが正。
 *  - まとめ送付（property_send）が1回でもあれば複数物件を送っている＝比較可能
 *  - 1件送付（property_recommendation）だけの場合は2回以上でようやく「複数送った」と言える
 */
function canUseCompareFrame(f: PropertySendFacts): boolean {
  if (f.priorBulkSendCount === 0 && f.priorSingleSendCount < 2) return false;
  if (f.hoursSinceLastSend !== null && f.hoursSinceLastSend > COMPARE_FRAME_STALE_HOURS) return false;
  return true;
}

function resolveRecommendationScenario(args: {
  actionType: string | null | undefined;
  pickupType: string | null | undefined;
  checkPattern: string | null | undefined;
  facts: PropertySendFacts;
}): RecommendationScenario | null {
  if (args.actionType !== "property_recommendation") return null;
  const f = args.facts;
  const hasPrior = f.priorSentPropertyCount > 0;
  // 比較フレームが使えないときの受け皿（送付実績があるなら「初回」も嘘になるため追加提案型へ）
  const nonCompareFallback: RecommendationScenario = hasPrior ? "followup_single" : "first";
  // ① フロントのピッカー選択が最優先（スタッフが明示的に選んだシナリオ）
  if (args.pickupType === "代替ピックアップ") return "alternative";
  // 新着は「新たに募集に出た1件」の宣言。過去の送付実績の有無に関係なく新着フレームが正
  if (args.pickupType === "新着1件" || args.pickupType === "新着まとめ") return "new_listing";
  if (args.pickupType === "新規ピックアップ" || args.pickupType === "初回まとめ") return nonCompareFallback;
  if (args.pickupType === "条件広げピックアップ" || args.pickupType === "条件広げまとめ") return nonCompareFallback;
  // 「継続ピックアップ」＝送付済みの中から1件を推す意図。比較できる実体がなければ降格する
  if (args.pickupType === "継続ピックアップ" || args.pickupType === "継続まとめ") {
    return canUseCompareFrame(f) ? "compare" : nonCompareFallback;
  }
  // ② ピッカー情報なし: 直前の空室確認結果から推定（募集なし/別の部屋なら代替提案の文脈）
  if (args.checkPattern === "unavailable" || args.checkPattern === "alternative") return "alternative";
  // ③ 物件送付実績から推定（比較表現は「複数送った」事実がある場合のみ許可）
  if (!hasPrior) return "first";
  return canUseCompareFrame(f) ? "compare" : "followup_single";
}

const RECOMMENDATION_SCENARIO_LABELS: Record<RecommendationScenario, string> = {
  compare: "比較選択型（送付済みの複数物件の中から1件を推す）",
  new_listing: "新着型（新たに募集に出た1件を単独で案内する）",
  alternative: "代替新規提案型（指定物件が募集なし→代わりの1件を新規提案）",
  followup_single: "追加提案型（送付実績はあるが比較できる複数はない→新たな1件として提案）",
  first: "初回提案型（初めての1件提案）",
};

// ─── 冒頭フレーム検出（実例フィルタ・生成後ガードで共用する単一ソース）──────────
// 「既に送った複数物件の中から選んだ」ことを宣言する言い回し
const COMPARE_FRAME_RE = /(お送り|ご紹介|送らせて|送付|お渡し)[^。！\n]{0,20}(中でも|中から)/;
// 「新たに募集が出た」ことを宣言する言い回し
const NEW_LISTING_FRAME_RE = /(新着で|新着物件|募集に出ました|募集にでました|募集でました|募集が出ました)/;

const COMPARE_FRAME_FORBIDDEN = [
  "これまでお送りさせて頂いたお部屋の中でも",
  "お送りさせて頂きましたお部屋の中でも",
  "お送りした中でも",
  "ご紹介したお部屋の中でも",
  "〜の中から選ばせて頂いた",
];
const NEW_LISTING_FRAME_FORBIDDEN = [
  "新着で1件オススメ出来るお部屋が募集に出ました",
  "新着で〜が募集に出ました",
  "新着物件",
];

// シナリオごとの「絶対に使ってはいけない冒頭表現」（プロンプトへリテラルで明示する）
const RECOMMENDATION_FORBIDDEN_OPENINGS: Record<RecommendationScenario, string[]> = {
  compare: NEW_LISTING_FRAME_FORBIDDEN,
  new_listing: COMPARE_FRAME_FORBIDDEN,
  alternative: [...COMPARE_FRAME_FORBIDDEN, ...NEW_LISTING_FRAME_FORBIDDEN],
  followup_single: [...COMPARE_FRAME_FORBIDDEN, ...NEW_LISTING_FRAME_FORBIDDEN],
  first: [...COMPARE_FRAME_FORBIDDEN, ...NEW_LISTING_FRAME_FORBIDDEN],
};

const RECOMMENDATION_SCENARIO_GUIDES: Record<RecommendationScenario, string> = {
  compare: `【シナリオ: 比較選択型】既にお送りした複数物件の中から1件を特に推す文脈。
・送付済みリストとの相対比較で「この1件が頭抜けている」特別感を演出する（冒頭の具体的な言い回しは⭐実例の文体から学んで多様に書くこと）
・CTAは内覧誘導または申込誘導（中程度の強度）
・🚫「新着で〜募集に出ました」等、新たに募集が出たことを宣言する表現は使わない（既送付物件からの選定であり新着の宣言は事実と異なる）
・ただし会話履歴に「複数物件を送った形跡」が見当たらない場合は比較表現は使わないこと`,
  new_listing: `【シナリオ: 新着型】新たに募集に出た物件を1件だけ単独でご案内する文脈。過去に何件お送りしていても、この1件は「新しく募集に出た1件」として紹介する。
・冒頭は「新着で1件（お客様の実名）さんにオススメ出来るお部屋が募集に出ました！！」のように“新たに募集が出た1件である”ことを宣言する（名前は実名に置き換える。言い回しは⭐実例の文体から学んで多様に書くこと）
・🚫「これまでお送りさせて頂いたお部屋の中でも」「お送りした中でも」「〜の中から」等、既送付物件の中から絞り込んだことを前提にする比較表現は絶対禁止（今回は新着1件の紹介であり比較対象が存在しない）
・新着＝早く動いた方がよいという鮮度をCTAに乗せてよい（煽りにならない範囲で）
・CTAは内覧誘導または申込誘導（中〜強）`,
  alternative: `【シナリオ: 代替新規提案型】お客様が指定/希望された物件が募集終了（空室なし）だったため、代わりの1件を新規にご提案する文脈。
・🚫「お送りさせて頂きましたお部屋の中でも」「〜の中から」等、複数物件の送付済みを前提にした比較・絞り込み表現は絶対禁止（事実と異なる訴求になる）
・🚫 新着だと確認できていないため「新着で」「募集に出ました」と断定しない
・前置きせず即物件紹介に入る（冒頭の具体的な言い回しは⭐実例の文体から学んで多様に書くこと）
・適合性訴求を全面に出す（希望物件が叶わなかった穴を埋める提案であることを意識）
・締めは強めの申込CTA（希望物件を逃した直後のため、良い代替は早く押さえるご提案が合理的）`,
  followup_single: `【シナリオ: 追加提案型】これまでにも物件をお送りしているが、今回は「送った中から選ぶ」文脈ではなく、新たに1件をご提案する文脈（送付済みが実質1件のみ等で比較対象が存在しない）。
・🚫「お送りした中でも」「これまでお送りさせて頂いたお部屋の中でも」等、複数送付済みの中から絞り込んだ体の表現は絶対禁止（比較できるだけの複数を送っていないため事実と異なる）
・🚫 新着だと確認できていないため「新着で」「募集に出ました」と断定しない
・「追加でお探しした1件」「改めてご提案する1件」として希望条件との適合を前面に出す（冒頭の言い回しは⭐実例の文体から学んで多様に書くこと）
・CTAは内覧誘導寄りの中程度`,
  first: `【シナリオ: 初回提案型】まだ物件をお送りしていないお客様への初めての1件提案。
・🚫「お送りした中でも」「先日の物件」等、既送付を前提にした表現は絶対禁止
・🚫 新着だと確認できていないため「新着で」「募集に出ました」と断定しない
・希望条件との適合を紹介する（冒頭の具体的な言い回しは⭐実例の文体から学んで多様に書くこと）
・CTAは内覧誘導寄りの軽め〜中程度（まず反応を見る）`,
};

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
      `[例${i + 1}${ex.is_starred ? "⭐" : ""}${ex.aix_action ? "・AIX橋渡し文実例" : ""}]\nお客様: 「${safeSlice(ex.customer_message ?? "", 200)}」\nスモラ: 「${safeSlice(ex.sent_reply, 600)}」`
    ).join("\n\n");
}

function buildExamplesSection(rows: ExampleHit[]): string {
  return formatExamplesSection(rankExamples(rows).slice(0, 6));
}

// ─── POST ────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
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
  } = body;

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
  let resolvedCustomerName = isPlausiblePersonName(customerName)
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
        [pcName, convName].map((n) => stripNonNameChars(n)).find((n) => isPlausiblePersonName(n)) ?? "";
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
      ? supabase.from("conversations").select("suggested_aix_meta").eq("id", conversationId).single()
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
  const brainMeta = (convResult.data as { suggested_aix_meta?: BrainMeta } | null)?.suggested_aix_meta ?? null;

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
  const propertySendFacts: PropertySendFacts = {
    priorSentPropertyCount,
    priorBulkSendCount,
    priorSingleSendCount,
    hoursSinceLastSend,
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
  const isExampleFrameCompatible = (text: string | null | undefined): boolean => {
    if (!recommendationScenario || !text) return true;
    const hasCompare = COMPARE_FRAME_RE.test(text);
    const hasNewListing = NEW_LISTING_FRAME_RE.test(text);
    if (recommendationScenario === "compare") return !hasNewListing;
    if (recommendationScenario === "new_listing") return !hasCompare;
    return !hasCompare && !hasNewListing; // alternative / followup_single / first
  };

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

    try {
      const emb = await generateEmbedding(ragQuery);
      if (emb) {
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
            query_embedding: emb,
            match_count: 40,
            min_importance: 7,
          }),
          // ⭐実例（スタッフの実返信）— 文体・テンポ再現の最重要ソース（generate-reply の fetchExamples と同RPC）
          supabase.rpc("match_reply_examples", {
            query_embedding: emb,
            match_count: 20,
            filter_states: stateAliases,
          }),
          // AIX専用pgvector検索（match_reply_examplesとは別RPC・entry_source IN ('aix_template','aix_action')）
          // match_reply_examples は entry_source='line_reply' ハードコードのためAIX実例が永遠に
          // ヒットしない → 専用RPCで過去の【AIX】テンプレート続き文・橋渡し文実例を類似検索する
          //（同一actionは+0.05ブースト）
          // 実例の主経路になったため母集団を 10 → 15 に拡大（dedupe後も6件を埋められるように）
          supabase.rpc("match_aix_reply_examples", {
            query_embedding: emb,
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
          ...starPool.filter((e) => isExampleFrameCompatible(e.sent_reply)),
          ...starPool.filter((e) => !isExampleFrameCompatible(e.sent_reply)),
        ].slice(0, 2);
        aixStarSeedCount = tierA.length;
        const tierB = aixVecRows.map(r => ({ ...r, aix_action: null, outcome_status: r.outcome_status ?? null }));
        const tierD = lineVecRows.map(r => ({ ...r, aix_action: null, outcome_status: null }));

        // 成約アウトカム還流: closed_won 実例を AIX系の先頭に昇格（成約実績ある実例を few-shot の最初に）
        // Array.sort は stable のため同一 outcome 内では tierA > tierB の優先順が維持される
        const outcomeRank = (s: string | null) =>
          s === "closed_won" ? 0 : s === "applied" ? 1 : s === "viewing" ? 2 : 3;
        // 訴求シナリオと冒頭フレームが一致する実例を最優先（不一致でも文体参考として残すが後ろに置き警告を付ける）
        const frameRank = (t: string | null) => (isExampleFrameCompatible(t) ? 0 : 1);
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
            (isExampleFrameCompatible(ex.sent_reply) ? "" : " ⚠️今回の訴求シナリオとは冒頭フレームが異なる実例") +
            ` ---\n` +
            `[お客様の状況] 「${safeSlice(ex.customer_message ?? "", 200)}」\n` +
            `[実際に送った続き文] 「${safeSlice(ex.sent_reply ?? "", 600)}」` +
            (isExampleFrameCompatible(ex.sent_reply)
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

  const brainMetaSection = brainMeta
    ? `━━━━━━━━━━━━━━━━━━━━\n【🧠 Brain戦略 — 生成の方向性】\n━━━━━━━━━━━━━━━━━━━━\n` +
      (isStaleMeta
        ? `⚠️ この戦略は最新の顧客メッセージ到着前の分析。会話履歴と矛盾する場合は会話履歴を優先すること\n`
        : "") +
      (actionType && brainMeta.action && brainMeta.action !== actionType
        ? `⚠️ Brainは別アクション（${AIX_BUTTON_LABELS[brainMeta.action] ?? brainMeta.action}）推奨時点の戦略。今回のボタン種別（${actionLabel}）と矛盾する指示は無視すること\n`
        : "") +
      `成約戦略: ${brainMeta.closing_strategy || "-"}\n` +
      (brainMeta.winning_pattern
        ? `・この顧客の成約に効く行動パターン: ${brainMeta.winning_pattern}\n  → 今回のメッセージにこのパターンを応用すること\n`
        : "") +
      (brainMeta.human_type_label
        ? `・顧客タイプ: ${brainMeta.human_type_label}\n`
        : "") +
      `返信方向: ${brainMeta.reply_direction || "-"}\n` +
      `チェックポイント: ${brainMeta.checkpoint_stage || "-"}\n` +
      (brainMeta.reason ? `Brainの判断理由: ${brainMeta.reason}\n` : "") +
      (brainMeta.template_hint ? `Brainのテンプレヒント（推奨カテゴリ）: ${brainMeta.template_hint}\n` : "") +
      (brainMeta.customer_emotion ? `顧客感情: ${brainMeta.customer_emotion}\n` : "") +
      (brainMeta.recommended_tone ? `推奨トーン: ${brainMeta.recommended_tone}\n` : "") +
      (brainMeta.purchase_signal_level
        ? `購買シグナル強度: ${brainMeta.purchase_signal_level}${SIGNAL_CTA_GUIDES[brainMeta.purchase_signal_level] ? `（${SIGNAL_CTA_GUIDES[brainMeta.purchase_signal_level]}）` : ""}\n`
        : "") +
      // M4: 押す／待つの局面軸。wait のときは購買シグナルによるCTA強化を打ち消す
      (brainMeta.engagement_stance
        ? `局面スタンス: ${brainMeta.engagement_stance}${brainMeta.engagement_stance === "wait" ? "（今は押してはいけない局面 — 申込・内覧の強いCTAは入れず、不安解消と情報提供にとどめる）" : "（押してよい局面 — 次の一歩を明確に促す）"}\n`
        : "") +
      (brainMeta.current_property ? `注目物件: ${brainMeta.current_property}\n` : "") +
      (brainMeta.latent_intent ? `潜在動機（裏の不安）: ${brainMeta.latent_intent}\n  → この動機・不安を解消する訴求を最低1つ本文に含めること（例: 審査落ち不安→審査通りやすいお部屋と伝える / 費用不安→初期費用の安さを強調）\n` : "") +
      (brainMeta.future_timeline ? `入居希望タイムライン: ${brainMeta.future_timeline}\n` : "") +
      (brainMeta.key_topics?.length
        ? `必ず含める主要トピック: ${brainMeta.key_topics.join("・")}\n`
        : "") +
      (brainMeta.repeated_concern
        ? `繰り返し出ている懸念（橋渡し文で必ず拾う）: ${brainMeta.repeated_concern}\n`
        : "") +
      (brainMeta.urgency_appropriate === false
        ? `緊急・煽り表現（「早い者勝ち」「お早めに」等）は使用禁止（この会話では不適切と判定済み）\n`
        : "") +
      (brainMeta.customer_questions?.length
        ? `お客様が質問していること（橋渡し文で拾う）:\n${brainMeta.customer_questions.map(q => `  ・${q}`).join("\n")}\n`
        : "") +
      (brainMeta.avoid_topics?.length
        ? `禁止話題（絶対に触れない）: ${brainMeta.avoid_topics.join("・")}\n`
        : "") +
      (brainMeta.last_aix_history && (Array.isArray(brainMeta.last_aix_history) ? brainMeta.last_aix_history.length > 0 : brainMeta.last_aix_history.length > 0)
        ? `直前のAIX履歴: ${Array.isArray(brainMeta.last_aix_history) ? brainMeta.last_aix_history.join(" → ") : brainMeta.last_aix_history}\n`
        : "") +
      (ngPropLabels.length
        ? `再提案禁止物件（既に送付済み・NG — 絶対に再度オススメしない）: ${ngPropLabels.join("、")}\n`
        : "") +
      `※Brain戦略の各項目（行動パターン・潜在動機等）は本文中でそのままラベル名を転記しない。訴求の判断根拠として使い、物件特徴と結びつけた言い方にする。\n` +
      "\n"
    : "";

  // preferences が string の場合は配列化、null/undefined の場合は空配列
  // （string を配列スプレッドすると1文字ずつ分解され「広 / め / ・ / 綺 / 麗」になるバグ防止 — ragQuery側と同処理）
  const userPromptPrefsRaw = brainMeta?.property_search_params?.preferences;
  const prefList = Array.isArray(userPromptPrefsRaw)
    ? userPromptPrefsRaw
    : typeof userPromptPrefsRaw === "string" && userPromptPrefsRaw
    ? [userPromptPrefsRaw]
    : [];

  const userPrompt = [
    `━━━━━━━━━━━━━━━━━━━━\n【今回生成する橋渡し文】\n━━━━━━━━━━━━━━━━━━━━`,
    `・AIXボタン種別: ${actionLabel}`,
    actionGuide ? `・この種別の書き方: ${actionGuide}` : "",
    // 「1件特にオススメ」の訴求シナリオ（冒頭・比較表現の可否・CTA強度を決定する最優先指示）
    recommendationScenario
      ? `・訴求シナリオ（禁止制約はこちらを優先・冒頭フレーズは⭐実例の文体から多様に学ぶこと）:\n${RECOMMENDATION_SCENARIO_GUIDES[recommendationScenario]}${pickupType && PICKUP_TYPE_NOTES[pickupType] ? `\n${PICKUP_TYPE_NOTES[pickupType]}` : ""}`
      : "",
    // 冒頭フレームは事実の宣言。シナリオごとに使ってはいけない表現をリテラルで明示する
    recommendationScenario
      ? `・🚫 このシナリオで絶対に使ってはいけない冒頭表現（1文字でも該当したらやり直し）: ${RECOMMENDATION_FORBIDDEN_OPENINGS[recommendationScenario].map((p) => `「${p}」`).join(" / ")}`
      : "",
    // 「物件ピックアップした」の送付文脈（初回 / 継続 / 新着 / 条件広げ）
    actionType === "property_send"
      ? (() => {
          const ctx = resolvePropertySendContext({ pickupType, priorSentPropertyCount });
          return `・送付文脈（この種別の書き方より優先）:\n${PROPERTY_SEND_CONTEXT_GUIDE[ctx]}\n・文脈判定に使った事実: ピックアップ種別=${pickupType ?? "不明"} / 今回より前の物件送付回数=${priorSentPropertyCount}回`;
        })()
      : "",
    signalCtaOverride
      ? `・CTA強度の上書き（購買シグナル優先 — アクション種別の書き方より優先）: ${signalCtaOverride}`
      : "",
    recommendationScenario
      ? `・シナリオ判定に使った事実: ${[
          pickupType ? `ピックアップ種別=${pickupType}` : "",
          effectiveCheckPattern ? `直前の物件確認結果=${CHECK_PATTERN_LABELS[effectiveCheckPattern] ?? effectiveCheckPattern}` : "",
          `今回より前にこの会話で物件を送付した回数=${priorSentPropertyCount}回（まとめ送付${priorBulkSendCount}回 / 1件送付${priorSingleSendCount}回）`,
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
    winningSection,
    knowledgeSection,
    actionBucketSection,
    `━━━━━━━━━━━━━━━━━━━━\n【現在の状況】\n━━━━━━━━━━━━━━━━━━━━`,
    jstContextNote,
    elapsedLabel ? `お客様の最終返信から: ${elapsedLabel}` : "",
    "",
    `━━━━━━━━━━━━━━━━━━━━\n【お客様情報】\n━━━━━━━━━━━━━━━━━━━━`,
    // 🚨 伏せ字（〇〇）をプロンプトに入れない。入れるとそのまま本文へ転記される（2026-09-01 事故）
    resolvedCustomerName
      ? `・お客様名: ${resolvedCustomerName}さん\n  → 呼びかけは必ずこの実名を使う。「〇〇さん」「○○さん」「お客様」等の伏せ字・一般名詞で呼ぶことは絶対禁止`
      : `・お客様名: 取得できていない（実名不明）\n  → 名前で呼びかけないこと。「〇〇さん」等の伏せ字を書くことは絶対禁止。冒頭は名前なしで「お世話になっております！！」「お待たせ致しました！！」から始める`,
    `・現在のフェーズ: ${stateLabel}`,
    customerSummary
      ? `・お客様プロフィール（AI分析・決まるパターン）: ${customerSummary}\n  → このお客様に刺さる訴求軸（例: 審査通りやすさ・費用の安さ・設備・立地等）を読み取り、物件の特徴と結びつけた訴求に使うこと`
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
    resolvedCustomerConditions || brainMeta?.property_search_params
      ? `※顧客希望条件に合致するポイントを訴求する際は「（物件の具体的特徴）なので条件に合います」という形で物件のデータを根拠として示すこと。条件名だけを羅列しない。\n※訴求は【文章構造の原則】の段落構成に沿って、設備・立地・費用を別々の段落に分けて書くこと（1文に詰め込まない）。特に費用制約（家賃上限・初期費用を抑えたい）がある場合、礼金0円・フリーレント等の費用面メリットが会話/AIXメッセージに記載されていれば必ず1つ言及すること。`
      : "",
    staffMessagedToday ? `・本日すでにスタッフが送信済み（冒頭は「お待たせ致しました！！」系にする。「お世話になっております」の再使用は禁止）` : "",
    noEmoji ? `・絵文字禁止モード: 絵文字を一切使わないこと` : "",
    "",
    pendingSection
      ? `━━━━━━━━━━━━━━━━━━━━\n【🔑 予約送信待ちのAIXメッセージ（物件名・金額など事実の唯一の追加ソース）】\n━━━━━━━━━━━━━━━━━━━━\n${pendingSection}\n`
      : "",
    `━━━━━━━━━━━━━━━━━━━━\n【会話履歴（事実確認と流れの把握に使う）】\n━━━━━━━━━━━━━━━━━━━━\nこの履歴を必ず参照すること。履歴内でお客様が既に答えた質問を再度聞かない。スモラが既に伝えた情報と矛盾しない・同じ内容を繰り返さない。\n${history || "なし"}`,
    "",
    examplesSection,
    phrasesSection,
    `この会話の流れ・お客様の状況に合った「${actionLabel}」の橋渡し文を1通生成してください。金額・空室状況・日程・物件名は上記の会話履歴/AIXメッセージに記載がある事実のみ使い、なければ言及しないこと。⭐実例の文体・テンポを忠実に再現すること。` +
    `\n【必ず守る2点】①訴求は1文に詰め込まず、設備／立地／費用を空行で区切った段落に分けて書く（【文章構造の原則】の段落構成に従う）。②呼びかけは${
      resolvedCustomerName ? `「${resolvedCustomerName}さん」の実名のみ` : "省略（名前を書かない）"
    }。「〇〇さん」等の伏せ字を本文に書いた時点でやり直し。\n${
      recommendationScenario
        ? `訴求シナリオは「${RECOMMENDATION_SCENARIO_LABELS[recommendationScenario]}」。禁止制約（比較表現禁止等）とCTA強度は必ず守ること。冒頭の言い回しは⭐実例の文体を参考に毎回変化させること（固定フレーズを繰り返さない）。`
        : ""
    }出力は本文のみ。`,
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
    const systemBlocks: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" } }> = [
      {
        type: "text",
        text: `${PRIORITY_ORDER_NOTE}\n\n${STATIC_GEN_SYSTEM}\n\n${SHARED_RULES_SYSTEM}`,
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ];
    if (dbKnowledgeBlock) {
      systemBlocks.push({
        type: "text",
        text: dbKnowledgeBlock,
        cache_control: { type: "ephemeral", ttl: "1h" },
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

    const first = await callClaude(userPrompt);
    if (!first.ok) {
      return NextResponse.json({ ok: false, error: `AI生成エラー: ${first.status}` }, { status: 500 });
    }
    let text = first.text;
    if (!text) {
      return NextResponse.json({ ok: false, error: "empty result" }, { status: 500 });
    }
    text = stripRoomLeadingZeros(text);

    // 伏せ字「〇〇さん」の決定論修正（実名に置換 / 名前不明なら呼びかけごと削除）
    const nameFix = fixNamePlaceholderAddress(text, resolvedCustomerName);
    if (nameFix.fixed) {
      console.warn(
        `[aix-template-generate] 伏せ字の呼びかけ「〇〇さん」を検出 → ${resolvedCustomerName ? `「${resolvedCustomerName}さん」に置換` : "呼びかけごと削除"}`,
      );
      text = nameFix.text;
    }

    // ── 訴求フレーム違反の決定論ガード（生成後チェック＋1回だけ再生成）──────────
    // 「1件しか送っていないのに“これまでお送りした中でも”」「新着でないのに“募集に出ました”」は
    // 顧客からの信頼を最も損なう事実齟齬。プロンプト指示だけに委ねず出力を検査して弾く。
    // 判定材料は aix_usage_logs の事実のみ（LLM推論に依存しない）。
    const detectFrameViolation = (t: string): string | null => {
      if (!recommendationScenario) return null;
      if (recommendationScenario !== "compare" && COMPARE_FRAME_RE.test(t)) {
        return "既送付物件の中から選んだ体の比較表現（「お送りした中でも」等）— この会話では複数物件を送った事実がない";
      }
      if (recommendationScenario === "compare" && NEW_LISTING_FRAME_RE.test(t)) {
        return "新たに募集が出たと断定する表現（「新着で」「募集に出ました」等）— 今回は既送付物件からの選定";
      }
      return null;
    };
    let frameRetried = false;
    const violation = detectFrameViolation(text);
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
        const retryText = fixNamePlaceholderAddress(stripRoomLeadingZeros(retry.text), resolvedCustomerName).text;
        // 再生成が違反を解消していれば採用。まだ違反していれば初回結果を維持する
        if (!detectFrameViolation(retryText)) text = retryText;
        else console.warn("[aix-template-generate] frame violation 再生成後も未解消 — 初回結果を返却");
      }
    }

    console.log(
      `[aix-template-generate] action=${actionType || actionCategory || "-"}` +
      ` rag_wp=${winningSection ? "hit" : "miss"} rag_kn=${knowledgeSection ? "hit" : "miss"}` +
      ` rag_ex=${examplesSection ? "hit" : "miss"} phrases=${phraseList.length}` +
      ` principles=${topPrinciples.length} loss=${lossPatterns.length} dbRules=${dbRulesGeneric ? "ok" : "none"} dbRulesAction=${dbRulesAction ? "ok" : "none"}` +
      ` brainMeta=${brainMeta ? "ok" : "none"} brainAction=${brainMeta?.action || "-"} ragQueryLen=${ragQueryLength}` +
      ` actionBucket=${actionBucketCategory ? `${actionBucketCategory}:${actionBucketRows.length}` : "-"}` +
      ` aix_ex=${unifiedAixExCount} unified_ex=${unifiedExCount} aixVec=${aixVecHitCount} starSeed=${aixStarSeedCount}` +
      ` knUsedIds=${knowledgeUsedIds.length}` +
      ` scenario=${recommendationScenario ?? "-"} pickup=${pickupType ?? "-"}` +
      ` checkPat=${effectiveCheckPattern ?? "-"}${checkIsStale ? "(stale)" : ""}` +
      ` sentProps=${sentPropertyLogCount} priorProps=${priorSentPropertyCount}(bulk=${priorBulkSendCount},single=${priorSingleSendCount})${currentSendAlreadyLogged ? "(self-excluded)" : ""}` +
      ` lastSendH=${hoursSinceLastSend === null ? "-" : Math.round(hoursSinceLastSend)} compareOk=${recommendationScenario ? canUseCompareFrame(propertySendFacts) : "-"} frameRetry=${frameRetried ? "on" : "off"}` +
      ` signal=${brainMeta?.purchase_signal_level ?? "-"} stance=${brainMeta?.engagement_stance ?? "-"} ctaOverride=${signalCtaOverride ? "on" : "off"}` +
      ` name=${resolvedCustomerName ? "ok" : "none"} namePassed=${customerName ? "yes" : "no"} namePlaceholderFix=${nameFix.fixed ? "on" : "off"}`,
    );

    // M1: ナレッジ使用テレメトリ（レスポンス返却後に fire-and-forget — 生成成功時のみカウント）
    incrementKnowledgeUsage(knowledgeUsedIds);

    return NextResponse.json({ ok: true, text });
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI生成エラー";
    console.error("[aix-template-generate] error:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
