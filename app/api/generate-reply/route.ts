import { NextRequest, NextResponse, after } from "next/server";
import { ChatAnthropic } from "@langchain/anthropic";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { supabase } from "@/app/lib/supabase";
import { generateEmbedding } from "@/app/lib/knowledge-utils";
import {
  PHASE_GUIDE,
  GENERATION_SYSTEM,
  SMORA_QUICK_PATTERNS,
  SMORA_RULES,
  REAL_ESTATE_RULES,
  REPLY_CONTENT_RULES,
  CURATED_REPLY_RULES,
  STATE_SEARCH_ALIASES,
  PHASE_COMMON_FORMAT,
  buildPhaseProhibitionNote,
  type PhaseKey,
  // 2026-09-08 語彙タイミング共有トリガー（prompts / final-check / few-shot / AIX 判定の四者同名）
  FORM_LABEL_RE,
  isConditionFormMessage,
  CUSTOMER_ESTIMATE_INTENT_RE,
  CUSTOMER_ESTIMATE_REQUEST_RE,
  CUSTOMER_COST_QUESTION_RE,
  CUSTOMER_PROPERTY_REF_RE,
  CUSTOMER_ROOM_POSITIVE_RE,
  STAFF_ESTIMATE_PROMISE_RE,
  CUSTOMER_SCREENING_CONCERN_RE,
  CUSTOMER_APPLY_OR_DOC_RE,
} from "@/app/lib/line-reply-prompts";
// 2026-09-08 Fable5: 見積書の文脈判定を単一 verdict に統合（生成 estimateGateNote / AIX detectAixTiming / final-check E5・E10 が共有）
import {
  isMisumoriContextAppropriate,
  countSentProperties,
  buildEstimateGateNote,
  type EstimateContextVerdict,
} from "@/app/lib/estimate-context";
import {
  validateAndClean,
  verifyAmountsAgainstSource,
  enforceCustomerName,
  isPlausiblePersonName,
  stripNonNameChars,
  normalizeCustomerName,
  canonOf,
  // 2026-09-11 竹内方針3: 呼び名の唯一の決定（生成・後処理・検査・check-reply が同じ verdict）
  resolveAddressName,
  type AddressNameVerdict,
} from "@/app/lib/validate-reply";
// 2026-09-12 竹内方針C: 呼び名のサーバー側決定（DB名・履歴・is_aix_generated）。check-reply と同じ関数
import { resolveAddressNameForConversation } from "@/app/lib/address-name-server";
import { runFinalCheck, runFinalCheckWithRevision, runDeterministicChecks, sha1, findUnanchoredConditionEchoes, skeletonBlockCodes, cellElementGaps, type CheckResult, type CheckIssue } from "@/app/lib/final-check";
// 2026-09-08 Fable5 G10/G26/G30: 主語判定・確認約束 verdict・冒頭挨拶の決定論（route / brain-core / final-check で四者同名）
import { MOVE_OUT_PATTERN, classifyMoveOutSubject, moveOutEvidenceText, CURRENT_HOME_MOVEOUT_CLAUSE_RE, isMoveOutReleased, type MoveOutSubject } from "@/app/lib/move-out-context";
import { resolveConfirmationContext, applyAixTiming, findConfirmObject, type ConfirmationContextVerdict } from "@/app/lib/confirmation-context";
// 2026-09-12 竹内方針A: 時間枠の「空いて」判定（断言検査・募集状況判定・AIX 場面判定が共有）
// 2026-09-12 竹内方針「AIX のセットはブレインが判断する」段1: resolveReplyAixDecision はブレインの判断を読むだけ。
//   場面の検出（aix-scene-evidence）は本文の安全（resolveBodySafety）と確認約束の根拠にだけ使う
import {
  resolveReplyAixDecision, resolveBodySafety, confirmationBasisAction, isSceneMappedCode, toSuggestedAixPayload,
  type ReplyAix, type ReplyAixInput, type BodySafety, type BrainAixDecision,
} from "@/app/lib/aix-reply-set";
import { detectAixSceneEvidence, detectAvailabilityCheckContext, AIX_CONDITION_CHANGE_RE } from "@/app/lib/aix-scene-evidence";
import { resolveGreeting, enforceOpening, buildFirstGreeting, buildGreetingNote, computeAlreadyGreetedToday, toGreetingLite, isProgressPushMessage, type GreetingDecision } from "@/app/lib/greeting";
import { fetchGroundTruth } from "@/app/lib/ground-truth";
import { DRAFT_SKIP_STATUSES } from "@/app/lib/conversation-status";
import { safeSlice } from "@/app/lib/safe-slice";
import { classifyReplyMode } from "@/app/lib/reply-mode-classifier";
import {
  applyVacatingDateToTemplate,
  applyGreetingSwap,
  stripRoomLeadingZeros,
  type VacatingDate,
} from "@/app/lib/template-preprocess";
// Step1完全廃止（2026-08）: brain(suggested_aix_meta) が唯一の分析ソース。
// SuggestedAixMeta 型と条件問い合わせ検出 regex は brain-core と共有する（二重定義禁止）
import { PROPERTY_CONDITION_INQUIRY_RE, runBrainAndNotify, type SuggestedAixMeta } from "@/app/lib/brain-core";
import { getCachedPromptRules, getCachedPhrases } from "@/app/lib/prompt-cache";
import { detectBrainTier, buildBrainFetchSpec, type BrainTierResult, type BrainFetchSpec } from "@/app/lib/brain-fetch-spec";
// AIXボタン種別アナウンス統一（2026-08）: スタッフ向けボタン誘導メモは aix-taxonomy.ts の
// AIX_STAFF_NOTES を単一ソースとして brain-core の AIX_BRAIN_NOTES と共有する（文言乖離の構造的防止）
import { AIX_STAFF_NOTES, AIX_BUTTON_LABELS, AIX_LINE_LABELS, AIX_ACTION_REPLY_DIRECTION, buildAixLineNote, normalizeAixActionKey } from "@/app/lib/aix-taxonomy";
// 2026-09-09 Fable5 往復文脈（Turn-Pair）＋実質判定（Substance）: 生成・検査・few-shot・tpo_debug の四者同名（reply-context.ts が単一真実源）
import {
  MSG_SEP, splitMessageUnits, analyzeSubstance, mergeBrainEvidence,
  classifyLastStaffTurn, classifyCustomerResponse, resolveTurnPair,
  buildPairDirection, buildTurnPairNote, fillPairPlaceholders, type PairContext, type SubstanceVerdict,
  // 2026-09-10 Fable5 あみ事例: 持込予告（(A)顧客が送る／(B)我々に送って の分離）と顧客アンカー語彙（生成・検査・修正が同一定数）
  classifyWillSendObject, CUST_WILL_SEND_SELF_PRED, buildVocabAnchorNote,
  // 2026-09-09 Fable5 みく事例: ヘッジゲート・締めポリシー・姿勢（生成・検査・tpo_debug が同一 verdict を参照）
  resolveHedgeAllowance, stripPreemptiveRelax, resolveCloser, predictCloserSignals, computeStanceFlags, buildStanceNote, STAFF_SEARCHED_RE,
  // G32（2026-09-09 Fable5 じゅにあ事例）: 開口語なし（結果報告）の根拠（AIX 確認結果・見積テンプレ）
  STAFF_CONFIRM_REPORT_RE, STAFF_ESTIMATE_RE,
  type HedgeVerdict, type CloserVerdict,
  // 2026-09-10 Fable5 みく事例: brain フィールドの意味スコープ分離（message-local / conversation）と
  //   セル必須要素 × brain 方針の衝突検出（avoid を削る前にセル選択を疑うための記録）
  toBrainMessageLocal, toBrainConversationScope, detectCellConflicts, avoidConflictsWithCell,
  type BrainConversationScope, type CellConflict,
  // 2026-09-11 統合設計（返信生成×最終チェックの衝突解消）: ピックアップ再宣言ゲートの解除判定・必須要素の保護・顧客名スロット・断り語彙の単一真実源
  resolvePickupGate, isCellRequiredSentence, fillNameSlot, CUST_WITHDRAWAL_SRC,
} from "@/app/lib/reply-context";
// 2026-09-09 Fable5 G1 行動台帳（Action Ledger）: 「我々が何をしたか＝done／何をすると言ったか＝promised」を一次証拠（aix_usage_logs > line_tasks > 本文）から
//   1回構築し、生成（【📒 我々の行動台帳】・往復文脈・hedge.searched・締め）・検査（final-check runLedgerChecks）・tpo_debug → reply_context_snapshot が同一オブジェクトを参照
import { buildActionLedger, buildLedgerNote, buildLastStaffAnnotation, applyLedgerAutoFix, type ActionLedger, type LedgerAixRow, type LedgerTask } from "@/app/lib/action-ledger";
// 2026-09-11 竹内方針1〜5（統合設計 §7）: 生成失敗文の文言と「正解例として使えるか」の唯一の判定
import { GENERATION_FAILURE_TEXT, isUsableExampleText, fixExampleWeekdays } from "@/app/lib/example-hygiene";
// 2026-09-11 竹内方針4・5: few-shot 注入前の「承知→かしこまりました」「すぐに除去」（後処理・検査と同じ定義）
import { normalizeBannedPhrasing } from "@/app/lib/banned-phrasing";
// 2026-09-12 竹内方針D: 日本時間の日付・曜日は jst-date の関数だけで計算する（曜日表をプロンプトに渡し LLM に曜日を計算させない）
import { jstParts, jstDateLabel, weekdayTable } from "@/app/lib/jst-date";
/** shadow=計算＋差分ログのみ／inject=生成注入＋検査（既定）／enforce=sentPropertiesCount・aixDone も台帳に統一。ロールバックは ACTION_LEDGER_MODE=shadow */
const ACTION_LEDGER_MODE = (process.env.ACTION_LEDGER_MODE ?? "inject") as "shadow" | "inject" | "enforce";

// Vercel Functions のタイムアウト上限（秒）— Vision + 2段LLM呼び出しに余裕を持たせる
export const maxDuration = 300;

// checkpointNote（確認済み事実セーブポイント）のヘッダー。
// POSTハンドラでの組み立てと buildGenerationMessages 内の抽出（P1: brain戦略存在時も
// チェックポイント部分だけは注入する）の両方で使うため単一定義にする（文字列ドリフト禁止）。
const CHECKPOINT_HEADER = "【会話履歴サマリー（確認済み事実セーブポイント — 長期会話の文脈）】";

// ─── モデル定義 ───────────────────────────────────────────────────────────────
// 分析系（synthesizeCustomerContext 専用）: Sonnet 5（品質重視・要約結果が返信品質に直結するため）
// ※ 旧Step1（analyzeCustomerSituation）は完全廃止済み（2026-08・brain/suggested_aix_meta に一元化）
// - Haiku化は品質劣化リスクあり（synthesize結果がgenerate-replyの文脈として使われるため非推奨）
// - Sonnet 5 は thinking がデフォルト無効だが、明示的に disabled を渡して
//   res.content が常に string で返る（ブロック配列にならない）ことを保証する
function createAnalysisModel() {
  return new ChatAnthropic({
    model: "claude-sonnet-5",
    maxTokens: 2048,
    thinking: { type: "disabled" },
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
    clientOptions: { timeout: 45_000 },
    betas: ["prompt-caching-2024-07-31"],
  });
}

// 生成: Sonnet — 品質重視
// - Sonnet 5 は temperature 等の非デフォルトサンプリングパラメータを受け付けないため渡さない
//   （旧 emotionTemperature 可変化は Sonnet 5 移行後デッドパスだったため Step1 廃止と同時に削除済み）
// - Sonnet 5 は thinking がデフォルト有効（adaptive）のため明示的に無効化する
//   （有効だとストリーミングchunkのcontentがブロック配列になりテキスト取りこぼし・
//    maxTokens=1500 を thinking が食い潰して本文が途切れるリスクがあるため）
function createGenerationModel() {
  return new ChatAnthropic({
    model: "claude-sonnet-5",
    maxTokens: 1500,
    thinking: { type: "disabled" },
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
    // A-14: SDK 既定の再試行（2回）× 45s で全体 deadline を食い潰すため 1 回に制限
    maxRetries: 1,
    clientOptions: { timeout: 45_000 },
    betas: ["prompt-caching-2024-07-31"],
  });
}

// テンプレート最適化モード（templateText指定時）の生成モデル: Claude Sonnet 5
// - Sonnet 5 は temperature 等のサンプリングパラメータ（非デフォルト値）を受け付けないため渡さない
// - thinking は明示的に無効化する（有効だとストリーミングchunkのcontentがブロック配列になり、
//   既存の「typeof chunk.content === "string"」蓄積ロジックがテキストを取りこぼすため）
// - テンプレは長文（物件ピックアップ等）があるため maxTokens は通常生成より広め
function createTemplateOptimizeModel() {
  return new ChatAnthropic({
    model: "claude-sonnet-5",
    maxTokens: 4096,
    thinking: { type: "disabled" },
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
    clientOptions: { timeout: 60_000 },
    betas: ["prompt-caching-2024-07-31"],
  });
}

// ─── 初回挨拶文（greetingNote と冒頭強制置換で共用・二重定義禁止）─────────────
// 「名称未設定」はLINEプロフィール取得失敗時のプレースホルダー。名前として絶対に使わない。
// さらに「H!tom!.M」「ゆき♡」等の記号・数字・絵文字混じりのLINE表示名も名前として使わない
// （実名「Hitomi」と食い違い、final-check が FABRICATED_NAME を出す原因になる）。
// 判定は app/lib/validate-reply.ts の normalizeCustomerName に一元化する（二重定義禁止）。
// G30（2026-09-08 Fable5）: buildFirstGreeting は app/lib/greeting.ts へ移設（resolveGreeting / enforceOpening と同一定義）。
// sanitizeCustomerName は validate-reply の canonOf に一本化（2026-09-12 竹内方針C: resolveAddressName が決めた呼び名を再正規化しない。
//   旧: normalizeCustomerName で「りおなちゃん」→「りおな」になり、nameNote・greetingNote・名前スロットだけスタッフの呼び方から外れていた）
function sanitizeCustomerName(name: string): string {
  return canonOf(name);
}

// ─── 中身のないフレーズの禁止リスト（greetingNote と同じく常時注入・冒頭ルールは greetingNote が正）─────
// line-reply-prompts.ts の【禁止ワード・パターン】を補完する「文体NG」層。
// 実データで頻出した「意味のない共感」「中身のない締め」を潰す。
const NG_PHRASE_NOTE = `\n【🚫 使用禁止フレーズ（文体NG・最優先）】以下は一切書かない。言い換えも禁止。
① 意味のない共感・自己完結の慰め（※「全然大丈夫です」「全然わがままじゃないですよ」の可否は下記【💬 共感フレーズ使い分け】が正）
　× 「わがままなんてとんでもないです」「そんなことありません」「お気になさらないでください」
　× 【🔴 絶対禁止】お客様が使っていない言葉を勝手に使う。特に「わがまま」— お客様自身が「わがまま」と書いていないのに「全然わがままじゃないですよ」「わがままじゃないです」等『わがまま』を含むフレーズを使うことは絶対禁止（お客様は自分をわがままだと思っていないのに、わがまま扱いされたと受け取られる）
　× 文脈に合わない共感フレーズを機械的に挿入する（お客様が恐縮していないのに「全然大丈夫です」を付ける等）
　→ 正: お客様の要望をそのまま受け止めて次の行動宣言に進む（例:「かしこまりました！！〇〇のご条件でお探しさせて頂きます！！」）
② 中身のない締め・丸投げの締め
　× 「何でもお気軽にご相談ください」「何かございましたらお気軽に」「ご不明点があればお気軽に」「お気軽にお申し付けください」
　→ 正: 具体的な次のアクションで締める（例:「ピックアップ出来次第お送りさせて頂きます！！」「ご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます😌！！」）
③ 挨拶代わりのお礼で書き出す
　× 「ありがとうございます！！」「ご連絡ありがとうございます！！」で返信を始める
　→ 正: 【⏰ 挨拶ルール・最優先】の冒頭フレーズ（お世話になっております のみ。お待たせ致しました・いつもありがとうございます は禁止語）から始める
④ 曖昧な安心付与
　× 「ご安心ください」（根拠となる具体的行動を伴わない場合）「大丈夫ですよ」単独
　→ 正: 何をするから安心なのかを行動で示す
⑤ 来阪・来訪タイミングへの言及
　× 「ご来阪までに」「ご来阪の際に」「ご来阪の前に」「今月末のご来阪までに」等、お客様の来阪・訪問時期を参照する表現
　→ 正: 「事前にお部屋をピックアップしてお送りさせて頂きます」「お部屋をご確認いただけます」等、来阪タイミングに言及しない表現を使う
⑥ 過剰な約束の副詞「すぐに」
　× 「すぐに」「今すぐ」「即」を行動宣言に使う（「出次第すぐにお送りします」「すぐにご連絡します」等）
　→ 正: 「出次第お送りさせて頂きます」「募集状況確認出来次第ご連絡させて頂きます」等（副詞なし・確認対象付き）
　→ 理由: 「すぐに」は過度な約束・安っぽい印象を与える
⑦ 形式的な了解フレーズ（具体アクションなし）
　× 「承知いたしました」「承知しました」「承知致しました」は文中も含め使わない → 受け止めは「かしこまりました！！」か「〇〇の件かしこまりました！！」、感謝・了承は「はい！！」（2026-09-11 竹内方針4）
　× 「ご連絡お待ちくださいませ」→ 使わない
　△ 「ご連絡お待ちしております」はお客様が自分から連絡すると予告した時だけ（「明日また連絡します」→「明日のご連絡お待ちしております😊！！」）。依頼・質問への返信・こちらに未実行の約束がある時・条件付きの予告（〜次第・〜あれば）の時は使わない（2026-09-12 竹内方針B）
　× 「かしこまりました！！」単独で終わる返信（具体アクションなし）→ 必ず後続に「〜させて頂きます！！」等の行動宣言を続けること。「かしこまりました！！何卒よろしくお願い致します！！」は不完全
　→ 正（依頼・お願いへの返し）: 「かしこまりました！！〇〇エリアでピックアップさせて頂きます！！」「かしこまりました！！お風呂広めのお部屋を中心にお調べさせて頂きます！！」
　→ 正（感謝・了承への返し）: 「はい😊！！ピックアップ出来次第お送りさせて頂きますので、何卒よろしくお願い致します😌！！」
　→ NG: 「かしこまりました！！何卒よろしくお願い致します！！」（行動宣言なし→WE_DO_MISSING対象）
⑧ 主語逆転（お客様の行為をスタッフが、スタッフの行為をお客様が行う形）— 3動詞の主語を先に決める
　・ご案内＝スタッフ（お客様を現地でご案内する）。× 「ご案内頂けます」「ご案内いただいた（お客様送付物）」　○ 「ご案内させて頂きます」
　・内覧＝お客様（お部屋を見る）。× 「ご内覧させて頂きます」「ご内覧させて頂けます」　○ 「ご内覧頂けます」「ご内覧可能な日程をお知らせください」
　・撮影＝スタッフ（室内を撮って送る）。× 「撮影いただき」「撮影お願いします」「撮影後すぐに」　○ 「撮影してお送りさせて頂きます」「撮影出来次第お送りさせて頂きます」
　・都合＝お客様のもの。× 「ご都合よろしいお日にちをお伝え／お知らせさせて頂きます」（スタッフが伝える物ではない）　○ 「ご都合よろしいお日にち御座いますでしょうか」
　→ 正の組み合わせ: 「お気に召されましたらご都合よろしいお日にち御座いますでしょうか！！ご案内させて頂きます！！」／「お送り頂いた」
⑨ 前提の無い業務語彙（会話履歴に存在しない約束・送付・日程）
　× 履歴に撮影・写真・動画の約束が無いのに「撮影出来次第お送り」／未送付なのに「ご査収ください」「先ほどお送りした御見積書」／日程未確定なのに「本日〇時ご案内」「現地到着」
　→ 正: 直前のスタッフ約束（ピックアップ／募集状況確認／見積作成）をそのまま復唱するWE DO（⭐実例に出てきた業務語彙でも、現在の会話に同じ前提が無ければ真似しない）
⑩ 「確認でき次第ご連絡」の誤用
　× お客様が「確認します」と言った返答に使う（確認の主語はお客様）／確認対象（〇〇の募集状況・内覧可能日・割引可否）を書かない汎用締め
　→ 正: 「お手隙の際にご査収ください！！」（ピックアップ約束が未履行の時だけ「私の方でもオススメできるお部屋ピックアップ出来次第お送りさせて頂きます！！」を続ける）／「（確認対象）の募集状況確認いたします！！確認出来次第ご連絡させて頂きます」
⑪ 履歴に費用・見積の話題が無い場面で「御見積書を作成しお送り」は禁止（物件探しの文脈では常にピックアップ宣言）
⑫ 「〇〇さん」「アカウント名さん」を字面のまま書くのは禁止。名前不明時は呼びかけを省く
⑬ 本人に「様」・フルネーム（身分証・申込書の氏名）は禁止。呼称はスタッフが最初に使った「〇〇さん」のみ
⑭ 「〇〇さんはい！！」「〇〇さんかしこまりました！！」のように開口語の前に名前を置かない
⑮ 「少々お時間頂」「確認中です」「ご確認のほど」「〜とのことですね」「まず〜次に〜」は禁止。「承りました」はお客様が今回伝えた事項を目的語にする時だけ（「内覧のキャンセル承りました」。単独・開口語は不可）（正例: 「出来次第お送りさせて頂きます」「明日一番にご連絡させて頂きます」）
⑯ 顧客が「拝見します」「後で見ます」（未来形）の時に「ご覧頂きありがとうございます」「気になるお部屋はございましたか」（既読・感想前提）は禁止 → 「お手隙の際にご査収ください」
⑯-2 「ご都合よろしいお日にちに」＋スタッフ作業（撮影・確認・お送り・作成・見積）の接続は禁止（お客様の都合をスタッフの作業タイミングに繋げる主語逆転）。「ご都合よろしいお日にちにご案内」は「お気に召されましたら」条件節＋日程を尋ねる疑問形とセットの時のみ（条件なし・疑問形なしの単独締めは内覧の押し付け）`;

// ─── 一時的な状況への言及禁止（常時注入・優先度: NG_PHRASE_NOTEと同列）──────────────
// 過去の会話チェックポイントに「出張中」等が記録されていても、
// 今回のメッセージと関係なく参照・言及することを防ぐ。
const TEMPORARY_SITUATION_NOTE = `\n【🚫 一時的な状況への言及禁止（最優先）】顧客の一時的な状況（出張中・急用・体調不良・忙しい等）は、今回（直近）の顧客メッセージで顧客自身が明示的に言及している場合のみ返信文に含めること。conversation_checkpointや過去履歴に記録されている一時的状況を、現在のメッセージと無関係に参照・言及することは禁止。例：顧客が「ありがとうございます」とだけ送ってきた場合、過去に出張中と記録されていても「出張お忙しい中」等の文言を入れない。`;

// ─── 別件予定の混入禁止（常時注入・優先度: TEMPORARY_SITUATION_NOTEと同列）──────────────
// 会話履歴に複数のアポイント・内覧が記録されていても、直近メッセージと無関係な別件予定を
// 現在の返信文に混入させないようにする。
const SEPARATE_APPOINTMENT_NOTE = `\n【🚫 別件予定の混入禁止（最優先）】複数の内覧・アポイントが会話履歴に記録されていても、直近の顧客メッセージで明示的に言及されていない別件の予定（別日の内覧・別物件のビデオ通話・未確定の次回アポ等）を現在の返信文に含めないこと。例：J's Garden明日の内覧確認メッセージに、別日予定のモンサント旭町ビデオ通話を混入させない。各予定・内覧・アポイントは独立した会話の流れで個別に扱うこと。`;

// ─── 絵文字位置の決定論的ゲート ─────────────────────────────────────────────
// お客様が絵文字を文頭・1行目に使っていた場合、返信も1行目の開き言葉直後に絵文字を配置させる。
// Extended_Pictographic（U+1F300〜）でLINE絵文字を拾う。
const EMOJI_RE = /\p{Extended_Pictographic}/u;

// ── TPO判定 共通ヘルパ（2026-09-08 監査）─────────────────────────────────────
// buildGenerationMessages の isShortAckMsg と route handler の TPO 判定で同一集合を共有する。
// ※ Route Handler のため export しない（Next.js の Route export 型検査に引っかかる）
// 絵文字（ZWJ・VS16・スキントーン含む）・記号連打・空白を除去した実質本文
const stripDecoration = (s: string): string =>
  s.replace(/[\p{Extended_Pictographic}\u200D\uFE0F\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/gu, "")
   .replace(/([！!？?。、，,．.〜～ー…♪]|\s)+/g, "$1");
// UTF-16 単位ではなく code point 単位の実質文字数
const coreLength = (s: string): number => Array.from(stripDecoration(s)).length;
// 疑問形（?なし）: 「契約日はいつになりますか」「鍵は現地で受け取ればいいですか」
// S-1（2026-09-08）: 「いくらでも」「どこでも」は疑問ではなく許容表明。negative lookahead で除外
const IMPLICIT_QUESTION_RE = /(?:ます|です|でしょう|ません)か(?:[ねぇ]?(?:[。！!、\s]|$))|いつ(?:頃|ごろ|まで|から|に|が|です|でしょ|になり|になる|くらい)|いくら(?!でも)|どこ(?!でも|も)|どちら(?!でも|も)|どの(?:物件|お部屋|方)|どう(?:なり|すれ|いう|やって|でしょ)|何(?:時|日|円|曜)|なん(?:時|日|じ)|でいい(?:です)?か|ればいい|ればよい|必要(?:です|でしょう)/;
// 依頼形（?なし）: 「確認お願いします」「送付よろしくお願いします」「してほしい」
const IMPLICIT_REQUEST_RE = /(?:確認|連絡|手配|送付|作成|調整|対応|手続き|予約|変更|追加|案内)[をも]?(?:お願い|おねがい|よろしく)|してほしい|して欲しい|してもらいたい|していただきたい|して頂きたい/;
// 柔らかい断り（isNegativeContext の withdrawalRe と二重化して gratitude/shortAck から確実に外す）
// G10（2026-09-08 Fable5）: 「決まりました／決まったので」の裸一致は「引越しが決まったので探してます」（探索開始）まで断りにしていた。
// 決定語は対象名詞（他社・別の物件・引っ越し先・住む所）付きのみ断りとみなす
const SOFT_DECLINE_RE = /見送(?:らせて|ります|りたい|ろうと)|やめ(?:て|とき|とこ)|遠慮(?:し|させ)|今回は(?:結構|大丈夫|やめ|見送|なし)|お断り|他で(?:決め|契約)|(?:他(?:社|の(?:会社|仲介|業者))|別の(?:会社|仲介|業者|ところ)|(?:他|別)の(?:物件|お?部屋)|引っ?越し先|住む(?:所|ところ|家))(?:で|が|に|は)?決ま(?:りました|ったので|った)/;
// 情報提供・選択確定（復唱＋次工程が必要なので感謝短返しにしない）
const INFO_PROVIDE_RE = /住所|勤務先|年収|来月|今月|上旬|中旬|下旬|月末|[A-Za-zＡ-Ｚａ-ｚ]案|で進めて|で決め|に決め|にします|の方で(?:お願い|進め)/;
// 純感謝・了承語（isGratitudeReplyTPO / isShortAckMsg 共通集合）
// S-1（2026-09-08）: 日本語に \b が無いため境界を lookaround で明示する。
//   英字 OK は前後に英字が無い場合のみ（「TikTok」の tikt"ok" に /i で一致していた）。
//   和語は否定・慣用の続き（よろしくない／どうもうまく／楽しみにしてたのに）を negative lookahead で除外。
const GRATITUDE_POS_RE = /ありがと|感謝|助かり|嬉しい|うれしい|よろしく(?!ない|なかっ|なさそう)|宜しく(?!ない)|おねがい|お願い(?:し|いた|致)|承知|かしこまり|わかりました|分かりました|了解|りょうかい|^はい[！!。]*$|(?<![A-Za-z])OK(?![A-Za-z])|オッケー|おっけ|大丈夫です|楽しみ(?!にして(?:た|い)た(?:のに|んですが))|お任せ|おまかせ|引き続き|どうも(?!うまく|上手く|なら|しても)|サンキュー|ありがたい/i;

// ─── 直前スタッフ約束の検出（2026-09-08 語彙セマンティクス・決定論）────────────────────
// 短い了承語への返信は「直前のスタッフ約束の復唱WE DO」に固定する（promiseEchoNote / tpoNoteForLLM「短い了承」）。
// 検出順は 撮影 → 見積 → 募集状況確認 → ピックアップ → 内覧確定 に固定（複数該当時は最も具体的な約束を優先）。
// 送付完了文（ご査収ください／お送りさせて頂きました）は「約束中」ではないので null。
export function detectStaffPromise(staffText: string): { label: string; echo: string } | null {
  if (!staffText) return null;
  if (/ご査収ください|お送りさせて頂きました|お送りさせていただきました|お送りいたしました|お送りしました|送付いたしました|送付させて頂きました/.test(staffText) && !/次第/.test(staffText)) return null;
  if (/撮影|写真.{0,6}お送り|動画.{0,6}お送り/.test(staffText)) return { label: "室内撮影して送付", echo: "撮影出来次第お送りさせて頂きます！！" };
  // 見積 echo は「作成・お送り」の約束形（STAFF_ESTIMATE_PROMISE_RE）に限る（「見積」の語出現だけでは復唱しない）
  if (STAFF_ESTIMATE_PROMISE_RE.test(staffText)) return { label: "お見積書の作成・送付", echo: "最大限割引しました初期費用のお見積書作成しお送りさせて頂きます！！" };
  if (/募集状況|空室|空き.{0,4}確認/.test(staffText)) return { label: "募集状況の確認", echo: "募集状況確認出来次第ご連絡させて頂きます！！" };
  // 2026-09-11 統合設計（経路B）: echo から名前・エリアの 〇〇 スロットを外す（LLM が字面で書き写し BANNED_WORD〇〇＋NAME_PLACEHOLDER の block を生んでいた）
  if (/ピックアップ|お調べ|お探し|オススメできるお部屋/.test(staffText)) return { label: "条件に合う物件のピックアップ送付", echo: "オススメできるお部屋ピックアップ出来次第お送りさせて頂きます！！" };
  if (/ご案内させて頂きます|内覧/.test(staffText) && /[0-9０-９]{1,2}時/.test(staffText)) return { label: "内覧の実施（日時確定）", echo: "当日何卒よろしくお願い致します！！" };
  return null;
}
// 締めフィラー通（「では失礼します」単独で来ても感謝返しを壊さない）
const CLOSER_ONLY_RE = /^(?:では|それでは)?(?:失礼(?:します|いたします|致します)|以上です|また(?:ご)?連絡(?:します|いたします)|よろしくです)[！!。]*$/;
// 感謝・了承以外の話題（申込意思・日時確定・予算変更・キャンセル等）
const ACK_TOPIC_EXCL_RE = /(家賃|エリア|間取り|物件|条件|変更|広げ|安く|抑え|内覧|見積|申込|キャンセル|予算|[0-9０-９]+(万|円|時|日|階|畳|㎡)|駅近|以内|以上)/;
// 感謝・了承のみの1通（複数通結合時に「中立」として扱い、待ち系TPOの判定を阻害しない）
const TPO_NEUTRAL_ACK_RE = /^(?:ありがとうございます|ありがとうございました|ありがとう|了解です|了解しました|承知しました|わかりました|分かりました|かしこまりました|よろしくお願いします|よろしくお願いいたします|お願いします|はい|OK|ok|おっけーです|\[スタンプ\])[!！。😊😌🙏]*$/;
// A-1（2026-09-08）: スタンプ単独・絵文字のみ・記号のみのメッセージ（LINE sentinel「[スタンプ]」除去後）。短い了承として扱う
const DECOR_ONLY_RE = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\s！!。、〜ー]+$/u;
const STAMP_LINE_RE = /^\s*\[スタンプ\]\s*$/m;
// A-13（2026-09-08）: 不安・関西弁ネガの専用TPO
const ANXIETY_RE = /不安|心配|怖い|大丈夫(?:ですか|でしょうか|かな|やろか)|やけど[！!]|あかん|微妙(?:やな|です|かも)|審査.*(?:通|落)|落ち(?:る|たら)|どうなりますか/;
// A-12（2026-09-08）: リスケ要望は内覧確定締めにしない
const RESCHEDULE_RE = /別日|別の日|変更|ずらし|都合(?:が)?悪|難しく|延期|キャンセル/;
// A-4（2026-09-08）: effectiveReplyDirection が null の時の state 別フォールバック（固定文の廃止）
const STATE_FALLBACK_DIRECTION: Record<string, string> = {
  first_reply: "初回対応。挨拶（システム通知に従う）→顧客メッセージの質問・条件に事実で1文回答→ピックアップ宣言（条件が無ければ「ご希望条件お聞かせ頂けますと幸いです」）。150〜220字",
  hearing: "条件受領中。揃った条件（エリア・家賃）を行動宣言に埋め込んで即ピックアップ宣言。足りない条件の聞き返しは1点まで。100〜180字",
  // 2026-09-10 Fable5 Sさん事例: WE DO 候補を「ピックアップ・交渉・確認」で閉じていたため、正解（内覧のご案内提案）に
  //   到達する言語的経路が消えていた。「〇〇の1文を添えろ」型にせず**選択肢の列挙**にする（創作を誘発しない）
  proposing:
    "商談継続中。顧客の質問・要望を1文で受け止め、具体名詞（エリア・条件）を含む WE DO 宣言を1つだけ添える（物件名・号室・日付は書かない）。" +
    "WE DO は次のいずれか1つを文脈から選ぶ（複数並べない・当てはまるものが無ければ書かない）: " +
    "①内覧のご案内提案（「よろしければ〇〇さんご都合よろしいお日にちにお部屋ご案内させて頂きます😌！！」。**具体的な候補日時は書かない**。候補日時の提示は AIX【内覧日調整】専用） " +
    "②募集状況の確認 ③御見積書の作成・送付 ④ご条件に合うお部屋のピックアップ ⑤家賃・条件の交渉。100〜150字",
  viewing: "内覧調整・内覧後フォロー。日程は確定分をそのまま復唱（新規提案はAIX）。内覧後は感想を受けて見積橋渡しまたは次物件ピックアップ宣言。80〜150字",
  applying: "申込・審査中。書類受領・審査進捗・契約案内のいずれかに直接回答。別物件提案・再ピックアップ・条件ヒアリング禁止。60〜150字",
  closed_won: "成約後サポート。質問に直接回答し「ご入居までしっかりサポートさせて頂きます」で締める。申込打診・ピックアップ・見積・内覧禁止。60〜120字",
  closed_lost: "失注後の再接触。「お世話になっております」→再連絡への感謝1文→以前のご条件を基にしたピックアップ宣言（「改めて」は【📒 行動台帳】に送付実績がある時のみ）→サポート継続宣言。初回挨拶・謝罪・フォーム再送禁止。80〜140字",
};

function buildEmojiPositionNote(customerMessage: string): string {
  if (!customerMessage) return "";
  const firstLine = customerMessage.split(/\n/)[0] ?? "";
  if (EMOJI_RE.test(firstLine)) {
    return `\n【😊 絵文字位置ルール（確定）】お客様のメッセージ1行目に絵文字が使われています。返信の1行目（開き言葉の直後）に絵文字を1つ入れること（例:「はい😊！！」「かしこまりました😊！！」）。絵文字を末尾のみに置くことは禁止。`;
  }
  return "";
}

// ─── 共感フレーズ（「全然大丈夫です」/「全然わがままじゃないですよ」）の決定論的ゲート ─────
// AIが最も間違えるのが「お客様が言っていない言葉（＝わがまま）を勝手に使う」パターン。
// お客様メッセージを正規表現で判定し、使ってよい／絶対禁止をプロンプト側で確定させる。
const CUSTOMER_WAGAMAMA_RE = /わがまま|ワガママ|我儘|我がまま|わがままで|自分勝手/;
const CUSTOMER_APOLOGETIC_RE = /すみません|すいません|すまん|申し訳|恐縮|恐れ入り|ごめん|お手数|ご迷惑|失礼(?:します|しました|いたします)|図々し|厚かまし|注文が多/;

function buildEmpathyPhraseNote(customerMessage: string): string {
  const msg = customerMessage || "";
  const usedWagamama = CUSTOMER_WAGAMAMA_RE.test(msg);
  const apologetic = CUSTOMER_APOLOGETIC_RE.test(msg);

  const head = `\n【💬 共感フレーズ使い分け（確定判定・最優先 — NG_PHRASE_NOTE①およびフェーズ別パターンの例文より上位）】`;

  if (usedWagamama) {
    return `${head}
・お客様が自ら「わがまま」というワードを使っている（確定）。
・→ この場合に限り「全然わがままじゃないですよ😊！！」の使用を許可する（冒頭挨拶の後に置く。挨拶の代わりにはしない）。
・→ 「全然大丈夫です」も使用可。
・ただし共感は1フレーズのみ。共感で終わらせず、必ず条件を受け止めた行動宣言へ直行すること。`;
  }
  if (apologetic) {
    return `${head}
・お客様は「すみません」「申し訳ない」等で恐縮している（確定）。ただし「わがまま」というワードは使っていない（確定）。
・→ 「全然大丈夫です！！」の使用を許可する（恐縮を解く一言として冒頭挨拶の後に置く）。
・→ 【🔴 絶対禁止】「全然わがままじゃないですよ」「わがままじゃないです」等『わがまま』を含むフレーズ。お客様が言っていない言葉を勝手に使うことになるため一切書かない。
・共感は1フレーズのみ。すぐに行動宣言へ進むこと。`;
  }
  return `${head}
・お客様は恐縮・謝罪しておらず、「わがまま」というワードも使っていない（確定）。
・→ 【🔴 絶対禁止】「全然わがままじゃないですよ」「わがままじゃないです」等『わがまま』を含むフレーズ（お客様が言っていない言葉の押し付けになる）。
・→ 「全然大丈夫です」も不要。恐縮していないお客様に使うと文脈に合わない共感になるため書かない。
・→ 正: 共感フレーズを挟まず、お客様の要望をそのまま受け止めて行動宣言に直行する。`;
}

// ─── f-8: センシティブ案件ゲート（線引き質問#10の回答確定に基づく）──────────────
// クレーム・審査否決・キャンセル/リスケ等はAI不使用（人間判断）の場面。
// 通常AIが生成したドラフトをそのまま送信させないよう、検知時はドラフト冒頭に
// 警告メタを付与してスタッフの手動確認を必須にする（生成自体は参考用に行う）。
const SENSITIVE_CLAIM_RE = /クレーム|苦情|納得(いか|でき)|話が違う|不誠実|誠意を|騙され|詐欺|訴え(る|ます|させ)|弁護士|消費者センター/;
const SENSITIVE_REJECT_RE = /審査[^。！!？?\n]{0,8}(否決|落ち(た(?!ら)|まし|てしまい)|通りませんでした|通らなかった|不承認|NG(でし|になり|だっ)|ダメ(でし|だっ))|否決/;
// ※「キャンセル料」「キャンセルできますか」等の不安系質問は通常AI回答の範囲（brainGuidanceNoteの保留パターン対応等で対応済み）のため除外し、
//   キャンセル・解約の「意向」とリスケ（日程変更）依頼のみ検知する
const SENSITIVE_CANCEL_RE = /(?:キャンセル|解約|取消|取り消し?|白紙|辞退)(?!料|金|でき|出来|可能)(?:を|は|に|で)?(?:したい|します|させて|お願い|希望|することに|する事に)|なかったことに|見送(?:り(?:たい|ます)|らせて)|やめ(?:たい|ます|ておき|とき)|リスケ(?:[をはにで])?(?:したい|させて|お願い|希望|お願いし)|(?:日程|日にち|日時|予定)[^。！!？?\n]{0,6}(?:変更|ずら|延期)(?:[をにで])?(?:したい|させて|お願い|希望)/;

function detectSensitiveCase(text: string): string | null {
  if (!text) return null;
  if (SENSITIVE_CLAIM_RE.test(text)) return "クレーム";
  if (SENSITIVE_REJECT_RE.test(text)) return "審査否決";
  if (SENSITIVE_CANCEL_RE.test(text)) return "キャンセル・リスケ";
  return null;
}

// 検知時にドラフト冒頭へ付与する警告メタ（スタッフ向け・送信前に削除する目印）
function buildSensitiveGateNote(customerMessage: string): string {
  const kind = detectSensitiveCase(customerMessage);
  return kind
    ? `【⚠️センシティブ案件: この返信案は参考のみ。送信前に必ず手動確認（${kind}検知）】\n\n`
    : "";
}

// ─── AIXボタン誘導ロジック: brain(suggested_aix_meta) の action からスタッフへのメモを生成 ────
// AIX推薦の判定本体は brain-core（detectSignalBasedAixFallback + Haiku分析）に一元化済み。
// このルートは brain が確定した action をトレーラーに変換するだけ（旧 deriveSuggestedAix は廃止）。

// action_type → スタッフ向け誘導メモ（brain の action / final-check 境界コードをこの note に変換する）
// 2026-08 AIXボタン種別アナウンス改善: aix-taxonomy.ts の AIX_STAFF_NOTES を単一ソース化。
// 「AIX【ボタン名】を押してください: 理由・タイミング」形式で、どのボタンを・なぜ・いつ押すかを明示する。
// 旧マップに無かった property_search もこれで語彙に入る（従来は SUGGESTED_AIX トレーラーで無言脱落していた）。
const AIX_ACTION_NOTES: Record<string, string> = AIX_STAFF_NOTES;

// 旧 AIX_BOUNDARY_TO_ACTION（AIX境界コード→ボタン）は 2026-09-12 竹内方針A で aix-reply-set.ts sceneForCode（場面表の行）に統合

// ─── パターンB: 物件引用への返信判定（プロンプト常時注入・条件付きルール）─────────
const QUOTE_REPLY_JUDGE_NOTE = `
【物件引用への返信判定】
お客様メッセージが「ここ」「こちら」「気になる」「いいですね」「見たい」等を含み、
直近のスタッフメッセージに物件画像（【物件資料を送付した】等の[画像]）または物件名・物件URL送付が含まれる場合、
お客様は直前の物件への興味・内覧希望を示している可能性が高い。
この場合は「気になる物件のURLをお送りください」ではなく、その物件を前提に返信を生成すること。
【⚠️ ただし内覧誘導の前に募集状況を必ずゲートすること】
・当該物件が退去予定・入居中の場合は、現地内覧日程（[日付][時間帯]や2択提示）を絶対に提案しない。
  「退去日以降のご案内」または「お申込みでお部屋を先に押さえてからのご内覧」を案内する。
・退去予定でないことが明らかな空室物件のみ、内覧日程調整の方向で返信してよい。
【💡 リンク（URL）そのものを求められた場合は内覧に飛ばさない】
・お客様が引用先の物件について「リンク教えて」「URL教えて」「この部屋のリンク（URL）ください」等、
  URL自体を求めている場合は、内覧日程調整には誘導しない。
  → 引用先が特定できる物件なら、その物件のURL/詳細を案内する（履歴にURLがあれば再提示）。
  → 「気になる物件のURLをお送りください」という聞き返しは絶対禁止（お客様は既に物件を特定している）。`;

// ─── 物件募集状況（退去予定/入居中）の決定論的検出 ─────────────────────────────
// 会話履歴・お客様メッセージに退去予定/入居中を示す文字列があれば、テキスト依存の条件付きルール
// （line-reply-prompts.ts の MOVE_IN_TIMING_RULE 等）が発火漏れしないよう、確定事実として最優先ブロックを注入する。
// 明示的な propertyStatus（呼び出し側がDB募集状況を渡した場合）はテキスト検出より優先する。
type PropertyStatus = "move_out_scheduled" | "occupied" | "vacant" | "unknown";

// 退去予定・入居中を示すキーワード（現地内覧不可 → 内覧日程提案を禁止すべき状態）
// G10（2026-09-08 Fable5）: 定義は app/lib/move-out-context.ts MOVE_OUT_PATTERN に集約（brain-core.ts・final-check.ts と四者同名）。
// 判定対象テキストは moveOutEvidenceText（スタッフ行全採用／顧客行は現住居の退去句を伏字化し提案物件への言及が残る行のみ）に限定する。
// 顧客は提案物件の退去日を自分から知り得ないため、「今の家は3月末退去予定です」（入居時期情報）を募集状況に誤読しない。

// スタッフが内覧可能日を明示した場合は「退去前」判定を取り消す（誤ブロック防止）
// 直近スタッフ発言で「8/24からご案内」「内覧可能」等が確認できれば退去前制限は解除済みとみなす
// 2026-09-12 竹内方針A-3: 定義は move-out-context.ts isMoveOutReleased（final-check E6 と同じ関数）

function detectPropertyStatus(history: string | null | undefined, customerMessage: string, explicit?: PropertyStatus): PropertyStatus {
  if (explicit && explicit !== "unknown") return explicit;
  const haystack = moveOutEvidenceText(history, customerMessage);
  if (MOVE_OUT_PATTERN.test(haystack)) {
    // 直近5件のスタッフ発言で内覧可能が確認済みなら退去前判定を取り消す
    const recentStaffText = (history ?? "").split("\n")
      .filter(l => l.startsWith("スモラ:"))
      .slice(-5)
      .join("\n");
    if (isMoveOutReleased(recentStaffText)) return "unknown";
    return "move_out_scheduled";
  }
  return explicit ?? "unknown";
}

// 退去予定・入居中と判定された場合に注入する強制ブロック（最優先）
function buildPropertyStatusNote(status: PropertyStatus): string {
  if (status === "move_out_scheduled" || status === "occupied") {
    return `\n【🚨 物件募集状況（確定事実・最優先 — 他のどのルールより上位）】この物件は退去予定/入居中です。現地内覧は退去日の翌日以降のみ可能で、今は現地内覧できません。
・内覧日程（[日付][時間帯]や2択日程提示）は絶対に提案しない。「〇日にご内覧いかがですか」等の現地内覧日の提示も禁止。
・入居可能時期を聞かれたら「ご入居可能日を管理会社に確認しご連絡させて頂きます😊！！」のみ伝える（AIが「クリーニング・鍵交換で2〜3週間」等から日程を自動計算して断定案内することは絶対禁止）。
・内覧・興味を示されたら「退去前のため現在は現地ご案内ができません。退去後ご案内させて頂きます！！お気に召されましたらお申込みでお部屋を先に押さえておくことも可能です😊！！」の方向で返す。`;
  }
  return "";
}

// ─── 募集状況確認文脈の決定論的検出 ───────────────────────────────────────────
// お客様が物件（URL・物件名・物件画像）を送ってきて「この物件は？」「空きありますか？」等と
// 募集状況を尋ねている場面。この段階では「空いているかどうか」がまだ管理会社に確認できていない。
// 空きが未確認のまま内覧誘導（「お気に召されましたら」「ご都合よろしいお日にちに」「ご案内させて頂きます」）
// をするのは順番が逆。確認して初めて次（内覧・申込）の話になる。
// ※ viewingFactNote が常時注入している「内覧に触れる場合は〜のみ許可」を、この文脈では無効化する。
// 2026-09-12 竹内方針A: AVAILABILITY_* と detectAvailabilityCheckContext は app/lib/aix-reply-set.ts へ移設（AIX 場面判定 S1 と同じ定義）

// 募集状況確認文脈で注入する強制ブロック（内覧誘導フレーズの完全禁止＋返信の型を4ステップに固定）
function buildAvailabilityCheckNote(): string {
  return `\n\n【🚨 募集状況確認の文脈（確定・最優先 — フェーズ別パターン・内覧誘導ルールより上位）】
お客様は物件（URL・物件名・物件資料）を示して、その物件の募集状況（空き）を尋ねています。
まだ管理会社に確認しておらず「空いているかどうか」が未確認の段階です。空きが確認できていない段階で内覧の話をするのは順番が逆であり、お客様の信頼を損ないます。確認して初めて次（内覧・申込）の話になります。
【✅ この文脈での返信の型（この4ステップのみ。他の要素を一切足さない）】
① 冒頭挨拶 — 【⏰ 挨拶ルール・最優先】に従う
② 物件の募集状況を確認する旨（例:「こちらのお部屋の募集状況確認させて頂きます！！」）
③ 確認でき次第ご連絡する旨（例:「確認出来次第ご連絡させて頂きます！！」）
④ 終わり（余分なフレーズを足さずここで完結させる）
【🔴 この文脈での絶対NG（一切書かない・言い換えも禁止）】
・「お気に召されましたら」
・「ご都合よろしいお日にちに」
・「ご案内させて頂きます」「お部屋ご案内させて頂きます」等の内覧誘導フレーズ全般
・内覧日程の提案・2択日程提示・「ご内覧いかがでしょうか」
・「お申込みでお部屋を先に押さえておくことも可能です」等の申込誘導
・「空室でした」「現在も募集中です」「〇月〇日退去予定です」等、未確認の募集状況・退去日・入居可能日の断言
・「何卒よろしくお願い致します！！」以外の中身のない締め・追加の勧誘文
※ 本ブロックは【📅 内覧日時の具体的提案は絶対禁止】内の「内覧に触れる場合は『お気に召されましたら〜』のみ許可」より上位。この文脈ではその例外許可も無効とする。
※ 本ブロックは【🏢 管理会社確認が必要な物件固有情報】内の「確認と連絡をセットで約束する文の禁止」より上位。募集状況確認では②＋③（確認する→確認でき次第連絡する）が正しい型。`;
}

// ─── AIXタイミング判定 → 2026-09-12 竹内方針A: app/lib/aix-reply-set.ts（resolveReplyAix / detectReplyAixScene）に一本化 ───
// 旧 detectAixTiming（P0 物件指名／見積／条件変更／内覧）・AIX_BOUNDARY_TO_ACTION・AIX_* 正規表現は場面表（S1〜S7）へ移した。

// AIXタイミング判定結果をプロンプト注入ブロックに変換する
// 2026-09-12 竹内方針「AIX のセットはブレインが判断する」段1: 2つに分ける
//   r（ブレインが決めた AIX・fresh の時だけ）→「どの AIX で送るか」の見出し＋橋渡しの型
//   safety（証拠がある時）→「テキストで物件情報・金額を書かない・橋渡し文」だけ（AIX ボタンの指示は書かない）
function buildAixTimingNote(r: ReplyAix | null, safety: BodySafety | null = null): string {
  if (!r && !safety) return "";
  const src = r
    ? { aix: r.action, label: r.label, chained: r.chained, urgency: r.urgency, highlight: r.highlight, extra: r.extra, forbidden: r.forbiddenText, bridge0: r.bridge }
    : { aix: safety!.candidateAction, label: safety!.label, chained: safety!.chained, urgency: safety!.urgency, highlight: safety!.highlight, extra: safety!.extra, forbidden: safety!.forbiddenText, bridge0: safety!.bridge };
  // ブレインの AIX と証拠の場面がずれている時は、本文の安全（禁止）は証拠の方も足す
  const extraForbid = r && safety && safety.forbiddenText && safety.forbiddenText !== r.forbiddenText ? `／${safety.forbiddenText}` : "";
  const s = {
    ...src,
    forbidden: `${src.forbidden}${extraForbid}`,
    bridge: src.bridge0 ?? AIX_ACTION_REPLY_DIRECTION[src.aix]?.weDo ?? "かしこまりました！！",
  };
  // G26/G7（2026-09-08 Fable5）: 旧固定型「→ 出来次第/確認出来次第ご連絡させて頂きます」は AIX 種別を問わず確認約束を注入していた
  // （創作約束の再生産源）。締めを AIX 種別で分岐し、viewing_invite は日程を尋ねる疑問形のみ（主語逆転の禁止を明記）
  const closer =
    s.aix === "property_check_result" || s.aix === "acknowledge_check"
      ? "「〇〇（確認対象: 募集状況 等）確認出来次第ご連絡させて頂きます」"
    : s.aix === "viewing_invite"
      ? "日程を尋ねる疑問形（「ご都合よろしいお日にち御座いますでしょうか」／「ご内覧可能な日程をお知らせください」）→「ご案内させて頂きます」。日程はお客様が持っているので「お伝え／お知らせさせて頂きます」と書かない。「ご内覧させて頂きます」も禁止（内覧するのはお客様）"
    : s.aix === "estimate_sheet"
      ? "「お送りさせて頂きます」（見積は作成・送付宣言で締める）"
    : "「ピックアップ出来次第お送りさせて頂きます」（この場面に確認対象は無い。「確認出来次第ご連絡」は書かない）";
  const lines = [
    r
      ? `\n\n【🎛 AIXタイミング判定（確定・最優先 — ブレインの判断: この返信はAIX【${s.label}】(${s.aix})ボタンで送る）】`
      : `\n\n【🛡 本文の安全（決定論の証拠・最優先 — 顧客が確認の要る事柄を聞いている）】`,
    `・優先順位: 【🚫 フェーズ絶対禁止】（PHASE_PROHIBITIONS・final-check STATE_REGRESSION / TIMING_VOCAB_MISMATCH で block）に抵触する語彙は、下の橋渡し実例に含まれていても書かない。抵触する場合はピックアップ宣言に置き換える。`,
    r
      ? `この場面ではスタッフがAIX【${s.label}】ボタンを使う運用指示がある。AIが返信文で物件情報・金額・空室状況の「答え」を生成してはいけない。`
      : `AIが返信文で物件情報・金額・空室状況・日程の「答え」を生成してはいけない（確認・送付はスタッフが行う）。`,
    `・返信は橋渡し文言（受付宣言）のみで完結させること。型: 挨拶 → 受領のお礼/かしこまりました → 行動宣言 → ${closer}`,
    `・橋渡し文言の実例（この型に合わせる・文脈に応じて調整）: 「${s.bridge}」`,
    `・絶対禁止: ${s.forbidden}`,
    `・対応スピード目安（スタッフ向け・返信文には書かない）: ${s.urgency}`,
  ];
  if (s.highlight) lines.push("・⚡ 最優先ホットシグナル: この顧客は今この瞬間が最も申込に近い。事務的な定型文ではなく熱量のある受付宣言にすること。");
  if (s.chained) lines.push(`・連結予約: ${s.aix} 完了後に ${s.chained} を続けて実行する運用（橋渡しでは「募集状況確認と最大限割引の御見積書作成」の両方の行動宣言を含めてよい）。`);
  if (s.extra) lines.push(`・${s.extra}`);
  return lines.join("\n");
}

// ─── ai_summary_json の構造化サマリー（customer-summary/route.ts の SummaryJson と互換）──
type ReplySummaryJson = {
  winning_pattern?: string;
  next_action?: string;
  opinions?: string[];
  emotion?: string;
  urgency?: string;
  style?: string;
};


// ─── max_tokens 尻切れ検知（ログのみ・レスポンスには影響させない）─────────────
function warnIfTruncated(stopReason: unknown, inputLength: number): void {
  if (stopReason === "max_tokens" || stopReason === "length") {
    console.warn("[generate-reply] max_tokens truncation detected:", { inputLength, stopReason });
  }
}

// ─── Step1（analyzeCustomerSituation）完全廃止（2026-08）───────────────────────
// 旧Step1のLLM深層分析（Sonnet直列・3〜8秒・Step2並列フェッチをブロック）は
// brain(suggested_aix_meta = SuggestedAixMeta) に一元化した。
// 戦略フィールド（closing_strategy / reply_direction / key_topics / avoid_topics /
// urgency_appropriate / recommended_tone / next_steps / action）と
// 鮮度従属フィールド（customer_questions / repeated_concern / current_property /
// condition_change_type / hesitancy_pattern / future_timeline）は
// brainGuidanceNote（POSTハンドラ内）と conditionChangeNote（buildGenerationMessages内）が
// brainMeta から読む。フォールバックは3層（LLMフォールバックは設けない）:
//   T1（brainMeta fresh）: 全機能。bg-async直列経路（brainMetaDirect）は常にT1が保証される
//   T2（brainMeta stale）: 戦略フィールドのみ採用。message-localは決定論regexで補完
//   T3（brainMeta null）: closingNote（ai_summary_json）＋決定論regex＋console.warn。
//     brain-sweepが5分以内に補填するため次回生成はT1に復帰する
// 不安系キーワード判定は決定論（コード側）に残す — LLM出力に依存させない（旧Step1のリストと同一）
const ANXIETY_KEYWORDS = ["名義", "審査", "保証", "リスク", "キャンセル", "退去", "違約", "トラブル", "詐称", "離婚", "死亡", "ルール", "大丈夫", "問題ない", "失敗", "断られ", "通らな"];



// ─── JST時刻取得（2026-09-12 方針D: jst-date の関数に一本化）─────────────────
function getJSTHour(): number {
  return jstParts().hour;
}
// 0=日, 1=月, ..., 6=土
function getJSTDayOfWeek(): number {
  return jstParts().dow;
}
function getJSTDateString(): string {
  return jstDateLabel();
}

// GENERATION_SYSTEM / SMORA_QUICK_PATTERNS / REAL_ESTATE_RULES は @/app/lib/line-reply-prompts からインポート済み


// 顧客の構造化条件（property_customersのフィールド）— 未取得項目の計算に使う
type CustomerStructured = {
  move_in_time?: string | null;
  rent_max?: number | null;
  desired_area?: string | null;
  walk_minutes?: number | null;
  floor_plan?: string | null;
  initial_cost_limit?: number | null;
  building_age?: number | null;
  other_requests?: string | null;
};

const CONDITION_LABELS: Record<string, string> = {
  move_in_time: "①入居時期",
  rent_max: "②ご希望家賃",
  desired_area: "③エリア・沿線",
  walk_minutes: "④駅徒歩",
  floor_plan: "⑤間取り",
  initial_cost_limit: "⑥初期費用",
  building_age: "⑦築年数",
  other_requests: "⑧その他こだわり",
};

// ── AIX実行済みアクションの再宣言防止（2026-09-01）─────────────────────────────
// スタッフがAIXボタン（空室確認・物件ピックアップ・内覧日調整・待ち合わせ等）を押して
// 実行＋LINE送信まで完了しているのに、generate-reply が「これから確認します」「ピックアップします」と
// 未来形で再宣言してしまうバグを防ぐ。
// 実例(2026-08-31): 日生ロイヤルマンション十三の空室確認をAIX【物件確認した】で実施し結果送信済みなのに、
// 直後の返信が「日生ロイヤルマンション十三につきましては、改めて空室状況確認しご連絡させて頂きます！！」。
// 判定ソースは aix_usage_logs の aix_type / check_pattern の2列のみ。
// （property_names / prop_statuses / estimate_sent は本番でほぼ未投入のため依存しない）
type AixDoneFlags = {
  vacancyCheck: boolean;   // property_check_result: 空室・募集状況の確認済み
  mgmtCheck: boolean;      // check_pattern が mgmt_*: 管理会社への確認済み
  propertySend: boolean;   // property_send / property_recommendation: 物件ピックアップ送付済み
  viewingInvite: boolean;  // viewing_invite: 内覧日程調整の案内済み
  meetingPlace: boolean;   // meeting_place: 待ち合わせ場所の案内済み
  labels: string[];        // プロンプト表示用（例「空室確認（2時間前・結果:募集終了）」）
  /** 2026-09-09 行動台帳（enforce）: 解除条件③（新規ピックアップ依頼）。台帳 recentDone.propertySend で propertySend を上書きする時に再適用する */
  asksNewPickup?: boolean;
  /** 2026-09-11 統合設計（経路F1）: resolvePickupGate の判定理由（tpo_debug.postprocess 用） */
  pickupGateReason?: string;
};

type PromptOverrides = {
  generationSystem?: string;
  quickPatterns?: string;
  realEstateRules?: string;
  smoraRules?: string;
  replyContentRules?: string;
  aixPropertyRecommendationRules?: string;
  aixPropertySendRules?: string;
};

function buildGenerationMessages(
  customerMessage: string,
  customerName: string,
  history: string,
  state: string,
  // Step1廃止（2026-08）: 旧 analysis: string（Step1生JSON）を brain(suggested_aix_meta) 直参照に差し替え。
  // brainFreshForMessage は message-local フィールド（condition_change_type 等）の採用ゲート
  brainMeta: AixGateMeta,
  brainFreshForMessage: boolean,
  knowledge: string,
  examples: string,
  phrases: string,
  customerConditions = "",
  customerSummary = "",
  promptOverrides?: PromptOverrides,
  isFollowUp = false,
  replyHint = "",
  alreadyGreetedToday?: boolean,
  isFirstEverReplyOverride?: boolean,
  viewingNote = "",
  customerStructured?: CustomerStructured,
  dbRules = "",
  summaryJson?: ReplySummaryJson,
  quotedContextNote = "",
  propertyStatus?: PropertyStatus,
  // テンプレート最適化モード: プロンプト最末尾（replyHintNoteと同じ上書きスロット）に注入するブロック。
  // 指定時は replyHint（指定生成モード）を無効化する（templateText が勝つ）
  templateNote = "",
  // H7(Fable5): brain(suggested_aix_meta) の closing_strategy/next_steps ガイダンスブロック
  brainGuidanceNote = "",
  // conversation_direction からの返信方向性ノート
  directionNote = "",
  // 見積書・割引の約束済みフラグ（直前スタッフ返信の割引/見積約束 or aix_usage_logs の estimate_sheet 履歴）。
  // true の場合は「御見積書を作成しお送りします」宣言の再生成を禁止し短い受付文へ切り替える（見積二重宣言の防止）
  estimatePromised = false,
  // importance=10 の principle（DB由来のため dynamicBlock 先頭に注入する）
  topPrinciples: KnowledgeRow[] = [],
  // 直近AIXボタン履歴テキスト（最新→旧順・RAG文脈強化）
  lastAixHistoryText: string | null = null,
  // AIXで実行＋送信済みのアクション種別（再宣言禁止ブロックの生成に使用）
  aixDone: AixDoneFlags | null = null,
  // 場面と返信方針（TPO）独立ブロック。brainMeta 有無に関係なく注入される（2026-09-08）
  tpoGuidanceNote = "",
  // S-2: resolveState().guideKey（PHASE_GUIDE / STAGE_JP / 禁止事項の単一キー）。未指定時は state をそのまま使う
  phaseGuideKey?: PhaseKey,
  // A-5: 条件提示TPO（conditionChangeNote の「ピックアップ宣言禁止」節と衝突するため、条件提示時は差分復唱＋ピックアップ宣言に切替）
  isConditionPresentedFlag = false,
  // 2026-09-08 Fable5: 見積書の文脈判定 verdict（estimateGateNote / detectAixTiming / estimatePromiseAckNote / phaseProhibition の単一真実源）
  estimateVerdict: EstimateContextVerdict | null = null,
  // G26（2026-09-08 Fable5）: 確認約束 verdict（route.ts resolveConfirmationContext）。aixTiming と合成して managementNote / confirmationGateNote に使う
  confirmCtxIn: ConfirmationContextVerdict = { allowed: false, source: "none", object: null, reason: "未計算" },
  // G30（2026-09-08 Fable5）: 冒頭挨拶の決定論結果（route.ts resolveGreeting）。greetingNote にリテラル埋め込み
  greetingDecision?: GreetingDecision,
  // 2026-09-09 Fable5 往復文脈: buildTurnPairNote() の【🔁 往復文脈】ブロック（tpoGuidanceNote より上位）
  turnPairNote = "",
  // 2026-09-09 Fable5: 通単位の配列（MSG_SEP / body.customerMessages）。1通内の改行を「N通」に分割しない
  customerMessageUnits: string[] = [],
  // 2026-09-09 Fable5 みく事例: buildStanceNote() の【🧭 姿勢】ブロック（往復文脈の直後・tpoGuidanceNote より上位）
  stanceNote = "",
  // 2026-09-09 Fable5 みく事例: ヘッジ verdict（budgetInventoryNote の発火を「顧客の疑問形質問」にゲート）
  hedgeVerdict: HedgeVerdict | null = null,
  // 2026-09-09 Fable5 行動台帳: buildLedgerNote() の【📒 我々の行動台帳】ブロック（往復文脈の直前・台帳が往復文脈の前提として先に読まれる）
  actionLedgerNote: string = "",
  // 2026-09-09 Fable5 行動台帳: staffContextNote に付ける直前発言の宣言／実行注記（buildLastStaffAnnotation）
  ledgerAnnotation: string = "",
  // 2026-09-11 統合設計（経路E5）: 台帳の「未履行のピックアップ約束」（ledgerActive 時のみ非 null）。本文 regex の約束検出と AND で使う
  ledgerPickupPromised: boolean | null = null,
  // 2026-09-12 竹内方針「AIX のセットはブレインが判断する」段1: ブレインが決めた AIX（resolveReplyAixDecision・fresh の時だけ非 null）
  aixScenePre: ReplyAix | null = null,
  // 同段1: 証拠から引いた本文の安全（AIX がセットされない時も断言しない・橋渡しを注入する）
  bodySafetyPre: BodySafety | null = null,
): [SystemMessage, HumanMessage] {
  const jstHour = getJSTHour();
  // 生成側の「現在フェーズ」は phaseGuideKey（正規化＋brain補正済み）を唯一の基準にする（生 state との二重基準を廃止）
  const effectivePhase: string = phaseGuideKey ?? state;
  const jstDay = getJSTDayOfWeek();
  const isWeekend = jstDay === 0 || jstDay === 6;

  // 履歴を先に解析（挨拶使用済みか判定するため）
  const historyLines = (history || "").split("\n").filter(Boolean);
  const lastStaffLines = historyLines.filter((l) => l.startsWith("スモラ:"));
  // スタッフ返信が一度もない = 真の初回（お客様への最初の返信）
  // isFirstEverReplyOverride が渡された場合はそちらを優先（AIXメッセージを除外した精度高い判定）
  const isFirstEverReply = isFirstEverReplyOverride !== undefined
    ? isFirstEverReplyOverride
    : lastStaffLines.length === 0;

  // G30（2026-09-08 Fable5）: 挨拶は route.ts resolveGreeting() で決定論確定済み（初回・催促・当日挨拶済み・深夜帯・会話連続中）。
  // LLM に候補から選ばせる旧方式は廃止し、確定した opening をリテラル埋め込みする（G32: お待たせ致しました は禁止語）。
  // 旧「夜分遅くに失礼致します 絶対禁止」は撤廃（22:00〜04:59 は決定論で「夜遅くに失礼します！！」を付与。LLM 自身は書かない）。
  // greetingDecision 未渡し（想定外経路）のみ従来の履歴フォールバック
  const gd = greetingDecision;
  const alreadyGreetedFallback = alreadyGreetedToday !== undefined
    ? alreadyGreetedToday
    : lastStaffLines.some(
        l => l.includes("お世話になっております") ||
             l.includes("はじめまして") ||
             l.includes("ご連絡頂きありがとうございます") ||
             /^スモラ:\s*「?[^\s]{1,10}さん/.test(l)
      );
  // G31（2026-09-09 Fable5 じゅにあ事例）: 挨拶行（接触・約束の事実）＋開口語（顧客メッセージの意味）の二層を greeting.ts buildGreetingNote が decision から生成（四者同名）
  const greetingNote = gd
    ? buildGreetingNote(gd, jstHour)
    : (isFirstEverReply
        ? `\n【⏰ 初回対応ルール・最優先】これはお客様への【はじめての返信】。必ず「${buildFirstGreeting(customerName)}」で始める（一字一句変更・省略禁止）。`
        : alreadyGreetedFallback
          ? `\n【⏰ 挨拶ルール・最優先】本日の会話で冒頭挨拶は既に使用済み。今回は絶対に使わない。「はい！！」「かしこまりました！！」など短い言葉で直接本文から始める。`
          : `\n【⏰ 挨拶ルール・最優先】長い返信・重要な連絡・条件確認の冒頭は「${sanitizeCustomerName(customerName) ? `${sanitizeCustomerName(customerName)}さん` : ""}お世話になっております！！」で固定。「お待たせ致しました」は禁止語。「夜遅くに」「夜分遅くに」は自分で書かない。`);

  const dateNote = `\n【📅 今日の日付（JST・必ず基準にすること）】${getJSTDateString()} — 「明日」「明後日」「今週」などの相対表現や具体的な日付（○日）は全てこの日付を起点に計算すること\n【📅 曜日表（JST・今日から14日分）】${weekdayTable(Date.now(), 14)} — 日付に曜日を付ける時はこの表の曜日をそのまま使う（自分で曜日を計算しない）。表に無い日付には曜日を付けない`;

  const _cleanName = sanitizeCustomerName(customerName);
  // S-5: 呼称ルールを断定形に。名前不明時は例文の「〇〇さん」を読み替える指示を明示（先頭改行で直前ノートとの癒着を防ぐ）
  const nameNote = _cleanName
    ? `\n【お客様の呼称】${_cleanName}さん（この呼び方以外禁止。「様」・フォーム記載のフルネーム・1返信3回以上は不合格。開口語の前に名前を置かない）\n`
    : `\n【お客様名】不明。例文の「〇〇さん」「〇〇さんご希望の」は呼びかけ部分を省いて読み替える。「〇〇さん」を字面で書く・名前を創作する・「名称未設定」を使うのは不合格\n`;
  const conditionsNote = customerConditions
    ? `\n【お客様の希望条件（DB登録済み・必ず考慮すること）】\n${customerConditions}\n⚠️ 上記の数字・金額（家賃・築年数・駅徒歩等）は一文字も変えずにそのまま引用すること。「13万円」を「3万円」に変形する等の誤変換は絶対禁止。条件の重複記載はしない。\n⚠️ 【絶対禁止・打ち合わせ合意ルール】「〇〇さんご希望のご条件に合った〜」「ご条件に合うお部屋」等の受け身表現はエリア名・具体条件と組み合わせても禁止。代わりに「〇〇エリアからオススメできるお部屋」「〇〇エリアから探してお届けします」等の能動表現を使うこと（エリアの呼び方は会話で使われた表現をそのまま使い「全域」等を勝手に付け足さない）。\n⚠️ first_reply（初回返信）の場合: 上記の主要条件（エリア・家賃・間取り）を必ず行動宣言に埋め込んで言及すること。条件への言及がゼロの返信は不合格。`
    : "";
  // conditionsNote が空かつ顧客メッセージにエリア・家賃が含まれる場合のインライン補完
  // route.ts 自体は DB から条件を取得しないため、フロントが customerConditions を渡さなかった
  // ケースをここでフォールバックカバーする（isConditionPresented は後段のTPOブロックで定義）
  const _inlineConditionsMsgForFallback = (customerMessage ?? "").trim();
  const _hasAreaInMsg = /[一-龯ぁ-んァ-ン]{2,}(?:駅|区|市|町|村|周辺|エリア|あたり|付近)/.test(_inlineConditionsMsgForFallback);
  const _hasRentInMsg = /[0-9０-９]+万(?:円|以内|〜|まで|以下|円以内)/.test(_inlineConditionsMsgForFallback);
  const inlineConditionsFallback = (!customerConditions && _hasAreaInMsg && _hasRentInMsg && _inlineConditionsMsgForFallback.length > 0 && _inlineConditionsMsgForFallback.length <= 300)
    ? `\n【⚠️ 顧客が今回のメッセージで直接エリア・家賃条件を提示しています】\nメッセージ: 「${_inlineConditionsMsgForFallback}」\n⇒ このエリア名・家賃帯を必ず返信の行動宣言に具体的に埋め込むこと。例: 「桜川・西九条・九条エリアから6万〜7万5000円以内のお部屋を全てピックアップしてお送りさせて頂きます！！」。「ご条件に合ったお部屋」等の抽象表現は禁止。具体宣言の代わりに「全力でサポート」だけで済ませるのは禁止（具体宣言の後の締めとしては必須）。`
    : "";
  // AIX-META戦略（brainGuidanceNote）が存在する場合、ai_summary全文はbrain側で既に消化済みのため
  // summaryNoteは注入しない（戦略の二重注入・矛盾指示を防ぐ）。AIX-META未生成時のみ従来通り注入する。
  // P1修正: ただし checkpointNote 由来の「確認済み事実セーブポイント」は brain が消化していない
  // 独立情報（長期会話の確定事実）のため、brainGuidanceNote 存在時もチェックポイント部分のみ
  // CHECKPOINT_HEADER を目印に抽出して必ず注入する（T1通常ケースでの事実喪失を防ぐ）。
  const summaryNote = (() => {
    if (!customerSummary) return "";
    if (!brainGuidanceNote.includes("【🧠 AIX-META戦略")) {
      return `\n【このお客さんのAI要約 — 今の状況・次の必須対応を最優先で文案に反映すること。人物像・文体も合わせること】\n${customerSummary}`;
    }
    const idx = customerSummary.indexOf(CHECKPOINT_HEADER);
    if (idx === -1) return "";
    return `\n${customerSummary.slice(idx)}`;
  })();

  // 構造化条件から未取得項目を計算（hearing系フェーズのみプロンプト注入）
  const missingItems = customerStructured
    ? Object.entries(CONDITION_LABELS)
        .filter(([key]) => !customerStructured[key as keyof CustomerStructured])
        .map(([, label]) => label)
    : [];
  const confirmedItems = customerStructured
    ? Object.entries(CONDITION_LABELS)
        .filter(([key]) => !!customerStructured[key as keyof CustomerStructured])
        .map(([, label]) => label)
    : [];
  const missingConditionsNote = (missingItems.length > 0 && (effectivePhase === "hearing" || effectivePhase === "first_reply"))
    ? `\n【📋 条件ヒアリング状況】\n確認済み: ${confirmedItems.length > 0 ? confirmedItems.join(" / ") : "なし"}\n未確認: ${missingItems.join(" / ")}\n※ 確認済み項目は絶対に聞き返さない。未確認項目を自然な流れで1〜2個まで聞く。`
    : "";

  // ① ai_summary_json の winning_pattern / next_action を直接参照して最優先注入
  //    （summaryJson が無い場合のみ旧テキストからの regex 抽出にフォールバック — 後方互換）
  const closingPatternFromSummary = (() => {
    if (summaryJson?.winning_pattern?.trim()) return summaryJson.winning_pattern.trim();
    if (!customerSummary) return "";
    const m = customerSummary.match(/★決まるパターン[：:]\s*(.+)/);
    return m ? m[1].trim() : "";
  })();
  const nextActionFromSummary = (() => {
    if (summaryJson?.next_action?.trim()) return summaryJson.next_action.trim();
    if (!customerSummary) return "";
    const m = customerSummary.match(/🎯次のアクション[：:]\s*(.+)/);
    return m ? m[1].trim() : "";
  })();

  // opinions（顧客の性格・営業ヒント）を構造化してプロンプトに注入
  const opinionsNote = (summaryJson?.opinions && summaryJson.opinions.length > 0)
    ? `\n【👤 お客様の人物像・営業ヒント（AI要約より）】${summaryJson.opinions.join(" / ")}\n→ 返信のトーン・提案の切り口はこの人物像に合わせること`
    : "";

  // フェーズ別の行動指針を取得（phase_guide はコード側 line-reply-prompts.ts を正とする・DBオーバーライドなし）
  // S-2: phaseGuideKey（resolveState 済み）を優先。viewing / closed_lost ガイドがここで初めて到達可能になる
  const phaseGuide = PHASE_GUIDE[effectivePhase] ?? PHASE_GUIDE[state] ?? PHASE_GUIDE["first_reply"];


  // ── Step1廃止（2026-08）: 旧「分析結果から各フィールドを抽出」ブロックの置換 ──────────
  // approachNote（reply_direction+recommended_toneが代替）/ repeatedConcernNote / currentPropertyNote /
  // hesitancyNote / questionsNote(fresh時) / closingStrategyFromAnalysis は
  // brainGuidanceNote（AIX-META戦略・POSTハンドラ内で構築）の message-local 戦術ブロックへ統合済み。
  // ここには ①T2/T3（brain stale / null）用の決定論質問検出フォールバック
  // ②conditionChangeNote（newConditionRequestNote との相互作用があるため残留・発火源を brainMeta に差し替え）のみ残す。

  // T2/T3 決定論フォールバック: brainの分析が最新顧客メッセージ未反映（stale）または brainMeta null の場合、
  // 質問検出を「？/?」文末分割で決定論的に補完する（複数質問注意書き＋不安系キーワード判定のみ）。
  // fresh時（T1）は brainGuidanceNote 側の customer_questions が正のため、ここでは二重注入しない。
  let questionsNote = "";
  // 2026-09-08: T1/T2 排他を廃止し常時実行。brain の customer_questions（T1時）と和集合にする。
  // brain が質問を抽出し損ねた場合（40字×5件キャップ・LLM見落とし）に両側ゼロになる穴を塞ぐ（MISSED_QUESTION 18件の上流）。
  const brainQuestionsForDedup: string[] = brainFreshForMessage ? (brainMeta?.customer_questions ?? []) : [];
  const isCoveredByBrain = (q: string) => brainQuestionsForDedup.some((b) => {
    const bn = b.replace(/\s+/g, "");
    const qn = q.replace(/\s+/g, "");
    return bn.includes(qn.slice(0, 12)) || qn.includes(bn.slice(0, 12));
  });
  {
    const detectedQuestions = ((customerMessage || "").match(/[^？?\n]{2,}?[？?]/g) ?? [])
      .map((q) => q.trim())
      .filter((q) => Boolean(q) && !isCoveredByBrain(q));
    // P3強化: 疑問符なしの質問（「〜か教えてください」「〜でしょうか」等）も決定論で検出する
    // 追加: 「〇〇ですか！」（感嘆符終わり質問）・「179,180円ですか」（数字+円+ですか）も質問として検出する
    const detectedQuestionsNoMark = ((customerMessage || "").match(/[^\n]{4,}(?:か教えて|か知りたい|か気になり|でしょうか|ますでしょうか|か確認|ていただけ|いかがでしょう|ですか[！!])[^\n]*|[\d,，.]+円.*ですか[^\n]*/g) ?? [])
      .map((q) => q.trim())
      .filter((q) => q.length > 4 && !isCoveredByBrain(q) && !detectedQuestions.some((d) => d.includes(q) || q.includes(d)));
    const allDetectedQuestions = [...detectedQuestions, ...detectedQuestionsNoMark];
    if (allDetectedQuestions.length >= 1) {
      const label = allDetectedQuestions.length > 1
        ? "⚠️ 複数質問検出（全て漏れなく答えること・省略禁止。各質問の対象語を本文で復唱し、即答できない場合は「○○につきましては管理会社に確認し本日中にご連絡させて頂きます」形で確認先＋期限を明示）"
        : "⚠️ 質問検出（必ず正面から答えること・「確認します」で逃げることは禁止。即答できない場合は質問対象を復唱し確認先＋期限を明示）";
      questionsNote = `\n【${label}】\n${
        allDetectedQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")
      }`;
    }
    if (allDetectedQuestions.some((q) => ANXIETY_KEYWORDS.some((k) => q.includes(k)))) {
      questionsNote += `\n【🚨 不安系質問検出】お客様はリスク・ルール・契約上の不安を持っている。曖昧・ぼかした回答（「可能性があります」「かもしれません」）は信頼を損なう。不動産ルール・事実・リスクを具体的に説明し、リスクがある場合は正直に伝えた上で必ず代替案をセットで提示すること。`;
    }
  }

  // ③ 条件変更/ピックアップ依頼検出
  // 発火源を Step1 の p.condition_change_type から brainMeta.condition_change_type（鮮度ゲート通過時のみ）に差し替え。
  // stale/null 時は newConditionRequestNote（決定論保険）が主防衛線になる。
  // typeLabel辞書・4ステップ返信の型・禁止CTA・noReproposeNote の文面は実運用で調整済みのため一切変更しない。
  let conditionChangeNote = "";
  const brainConditionChangeType = brainFreshForMessage ? (brainMeta?.condition_change_type ?? null) : null;
  if (brainConditionChangeType) {
        const changeType: string = brainConditionChangeType;
        const typeLabel: Record<string, string> = {
          area_change: "エリア変更",
          rent_change: "家賃変更",
          layout_change: "間取り変更",
          equip_add: "設備・こだわり条件追加",
          condition_relax: "条件緩和（拡大）",
          pickup_request: "物件ピックアップ依頼",
          multi: "複数条件変更",
        };
        const label = typeLabel[changeType] ?? changeType;
        // 既出物件の再提案禁止（全パターン共通）: 新条件が来た＝すでに検討中・提案済みの物件名を再提案してはいけない
        const noReproposeNote = `\n→ ★既出物件の再提案禁止（最優先）: 会話履歴にすでに登場した物件名（検討中・提案済みの物件）を返信に絶対に出さない。既出物件が新条件を満たしていても、その物件名を出して再アピールしてはいけない。「新条件に合うお部屋を新たに探してお送りする」旨のみ伝えること（例:「WICが広めのお部屋でご条件に合うお部屋をピックアップしてお送りさせて頂きます！！」）`;
        // 条件変更文脈での返信の型（全パターン共通・DBナレッジ ada53eac / ee18b61d の構成に準拠）
        // [挨拶] → [条件を理解した旨] → [ピックアップ/お探しする行動宣言] → [満足いく部屋が見つかるまでサポート]
        const conditionChangeShapeNote = `
【✅ 条件変更文脈の返信の型（この4ステップ以外の要素を入れない）】
① 冒頭挨拶 — 【⏰ 挨拶ルール・最優先】に従う（本日初回なら「〇〇さんお世話になっております！！」／挨拶済みなら省略）
①' 共感（該当する場合のみ・任意）— 【💬 共感フレーズ使い分け】の確定判定に従う。お客様が恐縮している場合のみ「全然大丈夫です！！」を置ける。お客様自身が「わがまま」と書いていない限り『わがまま』を含むフレーズは絶対禁止。判定で許可されていない共感フレーズは入れないこと
② 条件を理解した旨 — 「かしこまりました！！」＋ お客様が出した条件を具体的な言葉（エリア名・設備名・家賃・間取り）でそのまま拾う。オウム返しの疑問形（「〇〇をご希望ですね」）は禁止
③ 行動宣言 — お部屋をお探しする／お送りする旨（表現は下記のスタイル指定に従う）
④ サポート継続宣言 — 「〇〇さんがご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます😌！！」の方向で締める
⑤ 禁止 — 実現可能性への言及（難しい・少ない・可能性）・条件緩和・代替案の先回り提案・お客様の自己ヘッジ（難しいと思う・あれば教えて）の復唱（探した後に結果と一緒に報告する）
【🚫 条件変更文脈での絶対禁止CTA（最優先・フェーズ別パターンより上位）】お客様が新しい条件・追加条件を出した場面では、以下を絶対に出力しない：
・申込フォーマット／申込書類の案内／「お申込みでお部屋を先に押さえる」等の申込誘導
・見積書の作成宣言・送付宣言・初期費用の金額提示
・条件ヒアリングフォーム（①入居時期〜⑧その他要望）等のフォーマット送付
・内覧日程の提案・内覧誘導
→ 今のフェーズは「新条件でお部屋を探し直す」段階。CTAは物件をお送りすることのみ。
【🚫 条件変更への解説・評価の禁止（絶対）】お客様の条件変更・追加に対して、その効果・メリット・見通しを解説する文は絶対に書かない。ただ受け入れて「あなたのご条件に合った物件を探す」コミットメントのみ伝える。
・NG:「エリアが広がりましたので、より条件に近いお部屋を見つけやすくなるかと思います」（変更効果の解説・上から目線・可能性の示唆）
・NG:「選択の幅が広がりますので〜見つかります」「選択肢が広がって良かったですね」（お客様の判断を評価する表現）
・NG: 探す前の「少ない状況になりそう」「難しい可能性もあるので条件を変えた提案も」の予測・先回り提案（探した後の過去形結果報告「〜ですと少ない状況でしたので〜まで広げてピックアップさせて頂きました」はAIX物件送付文でのみ可）
・OK:「〇〇も含めて〇〇さんのご希望のご条件に合ったお部屋をピックアップしてお送りさせて頂きます」（承諾＋条件合致コミットメント）${noReproposeNote}`;
        // 拡大・緩和（condition_relax）の場合: ピックアップ宣言 + まだ聞けていない条件を1〜2点確認してよい
        if (changeType === "condition_relax") {
          conditionChangeNote = `\n【🔄 ${label}検出】必ずピックアップ宣言を行うこと。正しい型:「かしこまりました！！[変更後の条件を具体的に反映]で[名前]さんのご希望のご条件に合ったお部屋をピックアップしてお送りさせて頂きます！！」。条件拡大の効果・見通し（「選択肢が広がった」「見つけやすくなる」等）をお客様に解説する文は絶対禁止（行動宣言のみ）。さらに「まだ聞けていない重要条件（間取り・築年数など）」が1〜2点あれば追加確認してよい（すでに分かっている条件は聞き返さない）。${conditionChangeShapeNote}`;
        } else if (isConditionPresentedFlag) {
          // A-5（G-3）: 条件提示TPO（エリア＋家賃をメッセージで提示）と同時発火した場合、
          // 「ピックアップしてお送りは禁止」節は conditionDirection の必須宣言と正面衝突するため出さない。
          // 前回条件との差分復唱を新条件でのピックアップ宣言に埋め込む形に切り替える
          conditionChangeNote = `\n【🔄 ${label}検出（条件提示と同時）】前回条件との差分（変更されたエリア・家賃・設備）を復唱し、場面通知【条件提示】の3行構成（かしこまりました！！→新条件でのピックアップ宣言→締め）に埋め込むこと。追加条件の聞き返しは禁止。${conditionChangeShapeNote}`;
        } else {
          // 条件変更・設備追加・ピックアップ依頼: 追加質問は禁止、追客継続スタイルで完結
          conditionChangeNote = `\n【🔄 ${label}検出（最重要・絶対遵守）】追加条件を聞き返すことは絶対禁止。変更・追加された条件を具体的な言葉（エリア名・設備名）にして、即座に追客継続の行動宣言で完結させること。
【追客継続の正しいスタイル（必ず守る）】
・「お送りしました」「ご査収」等の完了報告は禁止（すぐに物件を送れる状況ではないため）。宣言は未来形「ピックアップさせて頂きます！！ピックアップ出来次第お送りさせて頂きます！！」
・どちらの型（宣言のみ／送付済み）かは【📒 行動台帳】の物件送付件数で決める。「再度」「改めて」「追加で」は送付実績がある時だけ
・送付済みの場合の型: 「かしこまりました！！[エリア]のお部屋で[名前]さんのご条件に合ったお部屋の新着状況随時確認させて頂きオススメ出来るお部屋募集に出次第お送りさせて頂きます！！何卒よろしくお願い致します😊！！」
・ポイント: 「新着状況随時確認」「募集に出次第お送り」のフレーズは送付済み段階で継続的に追い続けている姿勢を伝える${conditionChangeShapeNote}`;
        }
  }

  // スモラの全過去返信を抽出（連続する複数送信は1つにまとめる・スプリット送信対応）
  const allPastStaffMsgs = (() => {
    const segments = history.split(/\n(?=スモラ:|お客様:)/);
    const groups: string[] = [];
    let currentGroup: string[] = [];
    for (const seg of segments) {
      if (seg.startsWith("スモラ:")) {
        currentGroup.push(seg.replace(/^スモラ:\s*/, "").trim());
      } else if (seg.startsWith("お客様:")) {
        if (currentGroup.length > 0) {
          groups.push(currentGroup.join("\n"));
          currentGroup = [];
        }
      }
    }
    if (currentGroup.length > 0) groups.push(currentGroup.join("\n"));
    return groups;
  })();
  // 最後のスモラ返信（スプリット送信は結合済み）
  const lastStaffMsg = allPastStaffMsgs.length > 0 ? allPastStaffMsgs[allPastStaffMsgs.length - 1] : null;

  // 繰り返し防止リスト（直前を除く過去のスモラ返信を列挙）
  const repetitionNote = allPastStaffMsgs.length > 1
    ? `\n【🚫 繰り返し厳禁（スモラが過去に送った内容）— 同じ情報・同じ言い回し・同じ説明を絶対に使わない】\n${
        allPastStaffMsgs.slice(0, -1).slice(-5).map((m, i) =>
          `・${safeSlice(m, 200)}${m.length > 200 ? "…" : ""}`
        ).join("\n")
      }\n→ 特に費用・ルール・フロー説明は「一度伝えた」事実を必ず踏まえ、同じ内容を別の言い方でも繰り返さない。次のアクションに進むこと。`
    : "";

  // ── ピックアップ約束後の感謝返信を決定論的に検出 ──────────────────────────
  // スタッフが直前に「ピックアップしてお送りします」と約束済みのところへ、
  // お客様が「ありがとうございます」「よろしくお願いします」等の短い感謝・承諾のみを返したケース。
  // → AIが同じピックアップ宣言を再生成する二重宣言バグを防ぎ、短い確認文のみに制限する。
  //   実際の物件送付はAIX「物件ピックアップした」で行う（送信後にUIが誘導バナーを表示済み）。
  const trimmedCustomerMsg = (customerMessage || "").trim();
  // 複数メッセージ結合時（\n含む）は後続の感謝文が前の行動シグナルをマスクするため短い感謝チェックを無効化
  const hasMultipleMessages = customerMessage.includes("\n");
  // 2026-09-08: isGratitudeReplyTPO と同一集合（GRATITUDE_POS_RE / IMPLICIT_* / SOFT_DECLINE / ACK_TOPIC_EXCL）に統一。
  // 長さは絵文字除去後の code point 数（🙇‍♂️連打で60字超になる FN を防ぐ）
  // A-4: 複数通結合でも全通が中立の感謝・了承（「ありがとうございます\nよろしくお願いします」）なら二重宣言防止を有効化
  const allPartsNeutralAck =
    hasMultipleMessages &&
    trimmedCustomerMsg.split("\n").map((s) => s.trim()).filter(Boolean).every((p) => TPO_NEUTRAL_ACK_RE.test(p));
  // A-1: スタンプ単独・絵文字のみは「短い了承」として扱う（条件全列挙のピックアップ二重宣言を防ぐ）
  const isDecorOnlyMsgLocal = trimmedCustomerMsg.length > 0 && DECOR_ONLY_RE.test(trimmedCustomerMsg);
  const isShortAckMsg = isDecorOnlyMsgLocal || (
    (!hasMultipleMessages || allPartsNeutralAck) &&
    trimmedCustomerMsg.length > 0 &&
    coreLength(trimmedCustomerMsg) < 60 &&
    GRATITUDE_POS_RE.test(stripDecoration(trimmedCustomerMsg)) &&
    !/[?？]/.test(trimmedCustomerMsg) &&
    !IMPLICIT_QUESTION_RE.test(trimmedCustomerMsg) &&
    !IMPLICIT_REQUEST_RE.test(trimmedCustomerMsg) &&
    !SOFT_DECLINE_RE.test(trimmedCustomerMsg) &&
    !ACK_TOPIC_EXCL_RE.test(trimmedCustomerMsg));
  // 2026-09-11 統合設計（経路E5）: 台帳が有効な時は台帳の未履行約束とも一致する時だけ（本文 regex 単独の約束検出を台帳で絞る）
  const staffPromisedPickup =
    !!lastStaffMsg &&
    /ピックアップ/.test(lastStaffMsg) &&
    /(お送り|送らせて|お届け|送付)/.test(lastStaffMsg) &&
    !lastStaffMsg.includes("ご査収ください") && // 「ご査収ください」= 物件送付済みの完了文なので約束中ではない
    ledgerPickupPromised !== false;
  // 「また物件探してみます」= LLMが「自分で探す・goodbye」と誤解しやすい慣用表現。
  // 実際はスモラへの継続物件提案依頼シグナル。
  const searchAgainSignal =
    /また物件探して|物件探してみ|改めて探して|もう一度探して|引き続き探して/.test(customerMessage);
  const searchAgainNote = searchAgainSignal
    ? `\n【🔍 継続物件探索シグナル検知（最優先指示）】
「また物件探してみます」「また探してみます」等の発言はお客様が自分一人で探すという意味ではない。
スモラへの「引き続き物件を探して送ってほしい」という継続依頼の慣用表現。
→ 必ず「気になるお部屋があればいつでもお知らせください」または「こちらでもピックアップしてお送りしますね！」という積極的な物件提供の姿勢を示すこと。
→ 絶対に「またご連絡をお待ちしております」等、お客様からの連絡を受け身で待つだけの返信を生成しない。
例: 「はい😊！！気になるお部屋があればいつでもお送りください！！こちらでも随時ピックアップしてお送りさせて頂きます😊！！何卒よろしくお願い致します！！」`
    : "";

  const pickupPromiseAckNote = (!isFollowUp && staffPromisedPickup && isShortAckMsg)
    ? `\n【🚫 ピックアップ宣言の繰り返し禁止（最優先・フェーズ別パターン/条件変更検出より上位）】
スタッフは直前の返信で既に「物件をピックアップしてお送りします」と約束済み。今回のお客様のメッセージはその約束に対する感謝・承諾のみ。
→ 「ピックアップしてお送りさせて頂きます」宣言・エリアや家賃等の条件列挙・「初期費用も最大限割引」文を絶対にもう一度生成しない（二重宣言になる）
→ 返信は短い確認文のみ（2行以内・挨拶ルールに従う）。例:「はい😊！！ピックアップ出来次第お送りさせて頂きますので、何卒よろしくお願い致します😌！！」
→ 実際の物件送付はこの後AIX「物件ピックアップした」で行うため、AI返信で物件・条件の話を展開しない`
    : "";

  // ── 見積書・割引の約束済み検出（見積版の二重宣言防止・pickupPromiseAckNote と同型）──────
  // スタッフが直前の返信で「最大限割引した御見積書をお送りします」等を約束済み、
  // またはAIX【見積書送る】で見積書送付済みの場合、AIが同じ作成宣言を再生成する二重宣言を防ぐ。
  // 実際の見積書はAIX【見積書送る】で作成・送付する（estimateGateNote より上位に注入）。
  // 2026-09-08: 注入判定は verdict.mode === "echo_only" に統合（verdict 無し経路は旧 estimatePromised フラグでフォールバック）
  const estimateEchoOnly = estimateVerdict ? estimateVerdict.mode === "echo_only" : estimatePromised;
  const estimatePromiseAckNote = estimateEchoOnly
    ? `\n【🚫 見積書作成宣言の繰り返し禁止（最優先・【💰 見積書カバー文】ゲートより上位）】
スタッフは直前の返信で既に「割引・御見積書の作成/送付」を約束済み（またはAIX【見積書送る】で見積書送付済み）。
→ 「最大限割引させていただいた御見積書を作成しお送りさせて頂きます」等の作成宣言・割引の約束を絶対にもう一度生成しない（二重宣言になる）
→ 返信は短い受付文のみ（例:「はい😊！！確認しご連絡させて頂きます😊！！」）。開口語単独で終わらない。見積・費用の話を新たに展開しない
※ただし例外: お客様が【新しい物件】（URL・物件画像・物件名）を送って初期費用・費用を尋ねた場合はこのブロックを適用しない。新規見積として「最大限割引しました初期費用の御見積書を作成しお送りさせて頂きます！！」の作成宣言を必ず行うこと`
    : "";

  // ── 直前スタッフ約束の復唱（2026-09-08 語彙セマンティクス）──────────────────────────
  // 短い了承語（よろしくお願いします／かしこまりました／はい）は意味的に空なので、LLMが⭐実例の業務語彙
  // （撮影・ご査収・内覧日程）を無文脈で流用しやすい。「直前のスタッフ約束をそのまま復唱するWE DO」を
  // 決定論で1行渡し、約束に無い語彙の持ち出しを禁止する。pickup/estimate 専用ノートが出ている時は二重注入しない。
  const staffPromiseRaw = (!isFollowUp && isShortAckMsg && !pickupPromiseAckNote && !estimatePromiseAckNote)
    ? detectStaffPromise(lastStaffMsg ?? "")
    : null;
  // 2026-09-11 統合設計（経路E5）: ピックアップ約束の復唱は台帳に未履行約束がある時だけ（台帳有効時）。echo の顧客名はここで埋める
  const staffPromise = staffPromiseRaw && /ピックアップ/.test(staffPromiseRaw.label) && ledgerPickupPromised === false
    ? null
    : staffPromiseRaw && /ピックアップ/.test(staffPromiseRaw.label)
      ? { ...staffPromiseRaw, echo: fillNameSlot(`{name}に${staffPromiseRaw.echo}`, sanitizeCustomerName(customerName)) }
      : staffPromiseRaw;
  const promiseEchoNote = staffPromise
    ? `\n【🔁 直前のスタッフ約束の復唱（決定論・最優先）】お客様の最新メッセージは短い了承語で、内容は「直前のスタッフ約束への了承」です。直前の約束: ${staffPromise.label}（未履行）。返信は開口語「はい😊！！」（単独行）＋この約束をそのまま復唱するWE DO 1文（例:「${staffPromise.echo}」）＋締め1文のみ（場面【短い了承】）。撮影・ご査収・内覧日程・申込誘導など、直前の約束に無い業務語彙を新たに持ち出さない。「ご都合よろしいお日にちに」をスタッフ作業に接続しない。`
    : "";

  // ── AIX実行済みアクションの再宣言禁止（汎用版・pickupPromiseAckNote / estimatePromiseAckNote の一般化）──
  // 竹内指示(2026-08-31):「AIXの確認したを押したら、もう確認してるって事やから、ここの部分出ないようにする。
  // 考え方として、別のパターンでも」= 空室確認に限らず、AIXで実行＋送信済みの全アクションに横展開する。
  // 「新しい物件・新規依頼」の解除は呼び出し側（route handler）の aixDone 計算で行うため、
  // ここに到達している時点で「既に実行済み＝再宣言は二重宣言」が確定している。
  const aixDoneAckNote = (() => {
    if (!aixDone) return "";
    const bans: string[] = [];
    if (aixDone.vacancyCheck)
      bans.push("「空室状況を確認します」「改めて確認します」「募集状況を確認しご連絡させて頂きます」等、空室・募集状況の確認を【これから行う】という宣言を書かない（確認済み・結果送信済み）");
    if (aixDone.mgmtCheck)
      bans.push("「管理会社に確認します」「管理会社に問い合わせます」等、管理会社への確認を【これから行う】という宣言を書かない（確認済み・結果送信済み）");
    if (aixDone.propertySend)
      bans.push("「ピックアップしてお送りします」「お部屋をお探しします」「物件をお送りさせて頂きます」等、物件の検索・送付を【これから行う】という宣言を書かない（送付済み）");
    if (aixDone.viewingInvite)
      bans.push("「内覧のご案内をお送りします」「内覧日程を調整します」等、内覧調整を【これから行う】という宣言を書かない（案内済み）");
    if (aixDone.meetingPlace)
      bans.push("「待ち合わせ場所をお送りします」等、待ち合わせ案内を【これから行う】という宣言を書かない（案内済み）");
    if (bans.length === 0) return "";
    return `\n【🚫 AIX実行済みアクションの再宣言禁止（最優先・next_steps/フェーズ別パターン/実例より上位）】
スタッフは既に以下のAIXアクションを実行し、その結果をLINEでお客様に送信済み。
【実行済み】${aixDone.labels.join(" / ")}
→ 実行済みのアクションを「これから行います」と未来形で宣言することは絶対禁止（既にやったことをもう一度やると言う二重宣言になり、お客様に「話を聞いていない」と受け取られる）
${bans.map((b) => `→ ${b}`).join("\n")}
→ 代わりに: 既に送信済みの結果を踏まえて、今回のお客様の反応・懸念に直接答える。添えるべき次の一手が無ければ短い受付文（例:「かしこまりました😊！！」）で締める
※例外: お客様が【新しい物件】（URL・物件画像・まだ確認していない物件名）を新たに挙げた場合、その物件についての確認宣言は正当。上記禁止は既に実行済みの物件・依頼にのみ適用する`;
  })();

  const lastAixLine = lastAixHistoryText
    ? `\n直近AIXアクション履歴（新→旧）: ${lastAixHistoryText} — 最新のアクション直後のお客様メッセージとして、この流れを踏まえて返信を生成すること。`
    : "";
  const staffContextNote = isFollowUp && lastStaffMsg
    ? `\n【⚠️ 最重要：スモラは既にこのお客様メッセージに返信済み】\nスモラが直前に送った内容：「${lastStaffMsg}」${lastAixLine}\n→ お客様はまだ返信していない。これはその【続きのメッセージ】。前の返信で伝えた内容を絶対に繰り返さない。前の返信を踏まえて補足・追加・次のアクション提案など、自然につながる内容を生成すること。`
    : lastStaffMsg
      ? `\n【⚠️ スモラが直前に送った内容（必ず踏まえること）】「${lastStaffMsg}」${lastAixLine}${ledgerAnnotation ? `\n${ledgerAnnotation}` : ""}\n→ この返信の後にお客様が上記メッセージを送った。会話の流れを引き継いで自然な続きを生成すること。`
      : lastAixLine
        ? `\n【⚠️ 直前のAIXアクション情報】${lastAixLine}`
        : "";

  // ⭐実例がある場合: 文体参考として使うが、ルール（禁止ワード・挨拶等）は常に最優先
  // A-10: 実例ゼロ時は「実例外パターン禁止」（ルール8）が充足不能になるため明示的に解除し、PHASE_GUIDE の例文を型として使わせる
  const examplesInstruction = examples
    ? "\n\n【⭐実例の使い方】上記実例は文体・テンポ・絵文字・感嘆符の参考。言い回しの雰囲気を再現すること。ただし実例に「今すぐ」「すぐに」「即入居可能」「お世話になっております（初回時）」等の古いパターンが含まれていても、現行の禁止ルール・挨拶ルールを必ず優先すること。"
    : "\n\n【⭐実例なし】今回は参照できる実例がありません。「⭐実例にない対応パターンは作らない」ルールは適用しない。PHASE_GUIDE の該当パターン例文と場面通知の構成のみを型として使い、業務内容は履歴の事実だけで組み立てること。";

  // 実例があってもQUICK_PATTERNSの核心ルール（挨拶・禁止ワード）は維持する
  // 挨拶状態に応じて QUICK_PATTERNS の冒頭ルールを上書き（greetingNote との競合を解消）
  const baseQuickPatterns = promptOverrides?.quickPatterns ?? SMORA_QUICK_PATTERNS;
  // 冒頭ルール置換ヘルパー: DBオーバーライド文字列の空白・改行・コロン揺れを許容した正規表現でマッチ。
  // 置換対象が見つからない場合はサイレント失敗せず console.warn + 上書きルールを末尾に追記して確実に届ける
  const overrideOpeningRule = (base: string, replacement: string): string => {
    const openingRulePattern = /・\s*冒頭ルール\s*（\s*★\s*重要\s*）\s*[:：][\s\S]*?を使う/;
    if (openingRulePattern.test(base)) {
      return base.replace(openingRulePattern, replacement);
    }
    console.warn("[generate-reply] QUICK_PATTERNS冒頭ルールの置換に失敗（DBオーバーライド文字列にパターン不一致）。上書きルールを末尾に追記します。");
    return `${base}\n${replacement}`;
  };
  // 冒頭ルールの詳細指示は greetingNote（dynamicBlock・【⏰ 挨拶ルール／初回対応ルール・最優先】）に一本化。
  // quickPatterns は静的参照のみ（3バリアント廃止）→ staticBlock が常に同一内容になりキャッシュが毎回効く。
  const effectiveQuickPatterns = overrideOpeningRule(
    baseQuickPatterns,
    "・冒頭ルール（★重要）: 必ず【⏰ 挨拶ルール・最優先】または【⏰ 初回対応ルール・最優先】の指示に従う（挨拶済み/初回/通常の判断は同ブロック参照）"
  );
  // 実例がある場合も冒頭ルール（挨拶・禁止ワード）を維持するためQUICK_PATTERNSは常に注入する
  const quickPatterns = `\n${effectiveQuickPatterns}`;
  const realEstateNote = `\n${promptOverrides?.realEstateRules ?? REAL_ESTATE_RULES}`;
  const smoraRulesNote = `\n${promptOverrides?.smoraRules ?? SMORA_RULES}`;
  // AIXテンプレート最適化モード（templateNote指定時）では通常返信専用の内容規約を注入しない
  // — テンプレはAIX固有の長文・表現が正であり、通常返信の内容制限が品質を壊すため
  // — 通常返信（templateNote=空）のみ適用することで、両者の品質を独立に管理できる
  const replyContentNote = templateNote
    ? ""
    : `\n${promptOverrides?.replyContentRules ?? REPLY_CONTENT_RULES}`;
  const curatedReplyRulesNote = `\n${CURATED_REPLY_RULES}`;
  // AIXルールはgenerate-reply（一般LINE返信）には注入しない（aix/action専用）
  // 管理UIでオーバーライドが明示設定された場合のみ注入
  const aixPropertyRecommendationNote = promptOverrides?.aixPropertyRecommendationRules ? `\n${promptOverrides.aixPropertyRecommendationRules}` : "";
  const aixPropertySendNote = promptOverrides?.aixPropertySendRules ? `\n${promptOverrides.aixPropertySendRules}` : "";

  // 申込フォーム検出（applying フェーズのみ・氏名・緊急連絡先・住所等のキーワード）＋直近の画像なし → 身分証リクエスト注入
  // 法人フォーム（法人名・代表者・登記住所等）もカバー（キーワードは app/lib/application-form-detect.ts と整合させること）
  const isApplicationFormText = /緊急連絡|氏名|フリガナ|生年月日|現住所|住居年数|続柄|勤務先|法人名|代表者|登記住所|法人契約|法人御契約|法人名義/.test(customerMessage);
  // 直近のスタッフ返信以降のお客様メッセージに画像があるかチェック（全履歴ではなく直近のみ）
  const historyLinesForCheck = (history || "").split("\n");
  const lastStaffLineIdx = historyLinesForCheck.map((l, i) => l.startsWith("スモラ:") ? i : -1).filter(i => i >= 0).at(-1) ?? -1;
  const customerLinesAfterLastStaff = historyLinesForCheck.slice(lastStaffLineIdx + 1).filter(l => l.startsWith("お客様:"));
  const hasRecentCustomerImage = customerLinesAfterLastStaff.some(l => l.includes("【画像を送ってきた】"));
  const applicationFormNote = (effectivePhase === "applying" && isApplicationFormText && !hasRecentCustomerImage)
    ? `\n\n【🚨 申込フォーム受取・身分証なし検出】お客様からフォーム（個人情報テキスト）が送られてきたが、身分証明書の写真がない。返信には必ず「身分証明書（運転免許証またはマイナンバーカード）の表裏のお写真もお送りいただけますでしょうか！！」を含めること。フォーム未記入欄（勤務先等）があれば同時に確認する。パターンG-1で対応。`
    : "";

  // 退去予定/入居中を決定論的に検出 → 最優先ブロックを注入（テキスト検出漏れによる誤内覧提案を防止）
  // テンプレートモード（templateNoteが渡されている）では会話履歴テキストから検出しない。
  // 過去会話に「退去予定」「入居中」が含まれていても現在の物件とは無関係な誤検知を防ぐ。
  const resolvedPropertyStatus = templateNote
    ? (propertyStatus && propertyStatus !== "unknown" ? propertyStatus : "unknown")
    : detectPropertyStatus(history, customerMessage, propertyStatus);
  const propertyStatusNote = buildPropertyStatusNote(resolvedPropertyStatus);

  // 募集状況確認文脈（お客様が物件URL・物件名を送ってきた／「空きありますか？」等）の決定論的検出。
  // この文脈では内覧誘導フレーズを完全禁止し、「確認する→確認でき次第連絡する」で完結させる。
  const isAvailabilityCheckContext = detectAvailabilityCheckContext(customerMessage ?? "");
  const availabilityCheckNote = isAvailabilityCheckContext ? buildAvailabilityCheckNote() : "";

  // AIXタイミング判定（AIXタイミングマップ 2026-08）: 顧客メッセージがAIXトリガー条件に該当する場合、
  // 「この場面ではAIXボタンを使う運用指示があり、テキストで物件情報/金額を生成してはいけない」を注入する。
  // テンプレート最適化モード・指定生成モードでは通常返信の文脈判定が成立しないため注入しない。
  // 2026-09-12 竹内方針「AIX のセットはブレインが判断する」段1: 「どの AIX で送るか」はブレインの判断（aixScenePre）だけ。
  //   本文の安全（断言しない・橋渡し）は証拠（bodySafetyPre）で別に注入する（ブレインが AIX なし・stale でも効く）
  const aixTiming = (templateNote || replyHint) ? null : aixScenePre;
  const bodySafety = (templateNote || replyHint) ? null : bodySafetyPre;
  const aixTimingNote = buildAixTimingNote(aixTiming, bodySafety);

  // G26（2026-09-08 Fable5）: 確認約束 verdict に合成（route.ts confirmCtxFinal と同じ pure 関数・同じ根拠 → 三層で同値）
  //   根拠 = 証拠が確認の要る質問（S1/S2/S3）または ブレインの action が property_check_result / acknowledge_check
  const confirmCtx = applyAixTiming(confirmCtxIn, confirmationBasisAction(bodySafety, aixTiming));

  // G26: 管理会社ノートは verdict でゲート。確認対象が無い返信に「確認させて頂きます／確認出来次第ご連絡」を営業時間の説明付きで
  // 無条件注入していた（創作約束の再生産源）。allowed の時のみ、確認対象「${confirmCtx.object}」をリテラルで前置させる
  const managementNote = !confirmCtx.allowed
    ? `\n【管理会社の状況】現在${jstHour}時台（JST）${isWeekend ? "・土日" : ""}。この返信には管理会社への確認対象が存在しない（${confirmCtx.reason}）ため、「確認させて頂きます」「確認出来次第ご連絡」「明日一番でご確認」等の確認約束を書かない（営業時間・曜日の説明も不要）。`
    : isWeekend
      ? `\n【管理会社の状況・必ず守ること】本日は土日。「${confirmCtx.object}」の確認（空室確認）は土日でも可能なので「${confirmCtx.object}確認させて頂きます！！確認出来次第ご連絡させて頂きます！！」と伝えてよい。ただし交渉（フリーレント・値引き・条件変更・審査再挑戦など）は土日不可。交渉が必要な場合は「月曜日一番で管理会社に交渉させて頂きます！！」と伝える。`
      : jstHour >= 18
        ? `\n【管理会社の状況・必ず守ること】現在${jstHour}時台（JST）。18時以降のため管理会社の営業時間が終了している。「${confirmCtx.object}」の確認は「本日は管理会社の営業時間が終了しておりますので、明日一番で${confirmCtx.object}を確認しご連絡させて頂きます！！」と伝える（確認対象「${confirmCtx.object}」を必ず書く）。当日中の回答を約束しない。`
        : jstHour < 9
          ? `\n【管理会社の状況・必ず守ること】現在${jstHour}時台（JST）。管理会社の営業時間前（営業は9時〜18時）。「${confirmCtx.object}」の確認は「本日、管理会社の営業開始後に${confirmCtx.object}を確認し、確認出来次第ご連絡させて頂きます！！」と伝える（確認対象を必ず書く）。営業時間前の即時確認・即時回答を約束しない。`
          : `\n【管理会社の状況】現在${jstHour}時台（JST）。管理会社営業中（平日9時〜18時）。「${confirmCtx.object}確認させて頂きます！！確認出来次第ご連絡させて頂きます！！」と伝えてよい（確認対象「${confirmCtx.object}」を必ず本文に書く。「すぐに」は付けない）。`;

  // G26: 確認約束の決定論ゲート（dynamicBlock 末尾・お客様メッセージ直後に注入）。募集状況確認文脈（availabilityCheckNote）は型自体が確認宣言なので二重注入しない
  const confirmationGateNote = !confirmCtx.allowed && !isAvailabilityCheckContext
    // 2026-09-11 統合設計（経路B/D・🐥事例）: 旧文は TPO に関係なく（生成の 68%）「〇〇周辺全域から〇〇さんに…ピックアップ出来次第」の固定句を
    //   行動宣言として命じ、感謝返し・締めの場面にもピックアップ約束と 〇〇 リテラルを持ち込ませていた。行動宣言は往復文脈にだけ従わせる
    ? `\n\n【🚫 確認約束の禁止（決定論・確認対象なし）】この返信に「確認出来次第ご連絡」「確認しご連絡」「確認の上ご連絡」を書いてはいけない（理由: ${confirmCtx.reason}）。確認する事実が会話に存在しないのに確認を約束するのは創作約束。確認約束は書かない。行動宣言は【🔁 往復文脈】の方向と必須要素だけに従う（感謝返し・締めの場面では行動宣言を足さない）。`
    : confirmCtx.allowed
      ? `\n\n【✅ 確認対象（決定論）】この返信で確認を約束してよい対象は「${confirmCtx.object}」（根拠: ${confirmCtx.reason}）。書く場合は必ず「${confirmCtx.object}確認させて頂きます！！確認出来次第ご連絡させて頂きます！！」のように対象を前置する。「すぐに」は付けない。同じ返信内で確認宣言を二重に書かない。`
      : "";

  // 予算・条件指定の在庫質問（「〇〇円の物件ってありますか」等）の検出。
  // 特定物件の空室確認ではなく「その予算・条件で案内できる物件があるか」の質問。
  // 「確認します」で終わるのは絶対NG — 正直な現状説明＋代替案＋次のアクションが正しい型。
  const BUDGET_INVENTORY_RE = /(?:賃料|家賃|月々?|円以内|万(?:以内|円台|円くら|以下))[^\n]{0,20}(?:物件|お?部屋|もの|ところ)[^\n]{0,30}(?:ありますか|あります？|ありませんか|ございますか|ないですか)/;
  const BUDGET_INVENTORY_SOURCE_RE = /TikTok|tiktok|ティックトック|Instagram|インスタ|SNS|広告|掲載|サイト|スモラ|弊社/;
  // 2026-09-09 Fable5 みく事例: 発火は resolveHedgeAllowance の「顧客の疑問形質問（customerAsked）」にゲート（条件フォーム・条件付き依頼では発火しない）
  const isBudgetInventoryQuestion = !isAvailabilityCheckContext &&
    (!hedgeVerdict || hedgeVerdict.customerAsked.yes) &&
    (BUDGET_INVENTORY_RE.test(customerMessage ?? "") ||
     (BUDGET_INVENTORY_SOURCE_RE.test(customerMessage ?? "") && /ありますか|ございますか/.test(customerMessage ?? "")));
  const budgetInventoryNote = isBudgetInventoryQuestion
    ? `\n\n【🚨 予算・条件指定の在庫質問（確定・最優先）】
お客様は特定物件の空室確認ではなく「その予算・条件で案内できる物件があるか」を聞いています。
【✅ この質問への正しい返信の型】
① その予算・条件で案内できる物件が実際にあるかを正直に伝える（ある/少ない/難しい＋理由。断言せず「傾向として」）
② 難しい場合は「なぜ難しいか」の理由を具体的に説明する（例:「TikTok掲載物件は広さが大きく家賃15万円以上がほとんどとなります！！」）
③ 代替案（別エリア・別条件・別媒体の物件等）を必ずセットで提示する
④ 代替案から具体的に前進できる次のアクション（全件送る・ピックアップする等）を示す。探索宣言（「〇〇さんのご条件でしっかりピックアップしてお送りさせて頂きます」）を同じ返信に必ず入れる。優先順位の聞き返し禁止
【🔴 絶対NG】「確認してご連絡します」のみで終わる → 何も答えていない。信頼を損なう絶対禁止。
【🔴 絶対NG】「確認します→確認でき次第連絡します」の空室確認パターンを使う → これは特定物件の募集状況確認の型であり、この質問には不適切。`
    : "";

  // 内覧日時の具体的提案はAIXの「内覧へ」ボタン専用。generate-replyでは絶対に具体的日時を出さない
  const viewingFactNote = (resolvedPropertyStatus === "move_out_scheduled" || resolvedPropertyStatus === "occupied")
    ? `\n\n【📅 内覧日時について】この物件は退去予定/入居中のため現地内覧はできません。「退去後ご案内させて頂きます」「お申込みでお部屋を先に押さえてからのご内覧も可能です」の方向で返すこと。`
    : isAvailabilityCheckContext
      // 募集状況が未確認の段階では「お気に召されましたら〜ご案内」の例外許可を出さない（内覧誘導は順番が逆）
      ? `\n\n【📅 内覧日時の具体的提案は絶対禁止（最優先）】「〇/〇（木）14:00〜」「直近ですと[日付][時間帯]」「〇〇でご都合いかがでしょうか」のような具体的な内覧候補日時・2択日程提示は絶対に出力しない。[日付][時間帯]プレースホルダーも使用禁止。さらに今回は募集状況が未確認の段階のため、「お気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！」等の内覧誘導フレーズも一切書かない（【🚨 募集状況確認の文脈】が正）。`
      : `\n\n【📅 内覧日時の具体的提案は絶対禁止（最優先）】「〇/〇（木）14:00〜」「直近ですと[日付][時間帯]」「〇〇でご都合いかがでしょうか」のような具体的な内覧候補日時・2択日程提示は絶対に出力しない。内覧の日程調整はAIXの「内覧へ」ボタンのテンプレートで別途行うため、AI返信案には含めない。内覧に触れる場合は「お気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！」のみ許可。[日付][時間帯]プレースホルダーも使用禁止。`;

  // お客様が「内覧したい」を明示した場合: 返信は短い承認文のみ。日程・申込み提案は含めない
  const hasViewingIntent =
    /(内覧|内見|見学).{0,8}(したい|希望|お願い|可能|行き?たい|行ってみ|させてください|でき(ます|そう)|いつ(頃)?)|一度.*見てみ|実際に見てみ|見てみたい/.test(
      customerMessage ?? "",
    );
  const viewingIntentShortReplyNote = hasViewingIntent && resolvedPropertyStatus !== "move_out_scheduled" && resolvedPropertyStatus !== "occupied"
    // G7（2026-09-08 Fable5）: 旧例文「ご都合よろしいお日にちをお伝えさせて頂きます」は主語逆転（都合の持ち主はお客様）。aix-taxonomy viewing_invite.weDo を単一真実源にする
    ? `\n\n【📅 内覧希望への返信は短く（最重要）】お客様が内覧希望を明示しています。返信は「${AIX_ACTION_REPLY_DIRECTION.viewing_invite.weDo}」程度の短い承認文のみにしてください。以下は絶対禁止：① 申込み提案（「先にお申込みでお部屋を押さえることも可能」等）② 内覧を促す誘導文（「お気に召されましたら〜」は不要）③ その他の追加情報 ④「ご都合よろしいお日にちをお伝えさせて頂きます」「お知らせさせて頂きます」（都合の持ち主はお客様。日程は尋ねる形のみ）。内覧日程の詳細はAIX【内覧日調整】から別途送るため、この返信には含めない。`
    : "";

  // 見積書カバー文はAIXの「見積書送る」ボタン専用。generate-replyでは見積書を添付できないため添付済みを装う文面・金額内訳を出さない。
  // 2026-09-08 Fable5: 旧・約900字の禁止列挙（常時注入・staticBlock）を isMisumoriContextAppropriate() の verdict に基づく
  // ポジティブ定義に置換。顧客ごとに変わるため dynamicBlock（aixTimingNote の直前）に注入する。
  const estimateGateNote = buildEstimateGateNote(estimateVerdict);

  // 空室確認結果・入居可能日・保証会社等の物件固有情報はAIXの「物件確認した」系ボタン専用。generate-replyでは管理会社確認前の結果捏造を防ぐ（estimateGateNote と同型の常時注入ゲート）
  const propertyFactGateNote = `\n\n【🏢 管理会社確認が必要な物件固有情報の断言は絶対禁止（最優先）】「空室でした」「現在も募集中と確認できました」「埋まってしまいました」「退去日は〇月〇日です」「〇月〇日からご入居可能です」のような、管理会社に確認した体の結果報告や具体的な退去日・入居可能日の断言は絶対に出力しない。空室状況・退去予定日・入居可能日に加え、この物件の「保証会社名・保証料の金額・審査基準・ペット飼育可否・駐車場の空きと料金・設備の有無・礼金/家賃交渉の結果」も管理会社への確認が必要な確定事実であり、確認前にAIが「この物件の保証会社は〇〇です」「保証料は総賃料の〇%です」等と断言・推測してはいけない。保証会社の役割・審査の一般的な流れ・連帯保証人との違いなどの一般論は即答してよい。物件固有の質問には「〇〇（対象: 募集状況／ご入居可能日／ペット飼育の可否／駐車場の空き状況／保証会社・審査条件 等）確認させて頂きます！！確認出来次第ご連絡させて頂きます！！」の宣言のみ（確認対象を必ず本文に書く。対象の無い「確認しご連絡」は禁止）。確認結果の報告はAIX【確認した（条件・交渉）】（物件確認した系ボタン）で別途生成・送信する。告知事項（事故・トラブル・騒音・心理的瑕疵）の有無、「審査は大丈夫です」等の根拠なし安心も同じく管理会社・保証会社の確認結果が無い限り断言しない。例外：会話履歴内でスタッフが既に伝えた確定情報（退去日・入居可能日・保証会社名等）をそのまま引用する場合のみ言及可。新たな日付・募集状況・保証条件をAIが推測して生成することは禁止。\n・【⚠️ 退去予定の断言禁止】「退去後すぐにご案内できます」「退去後すぐにご内覧いただけます」「〇月以降ご案内可能です」のような退去予定を前提とした案内文は、管理会社から退去予定が確認済みである事実が会話履歴にある場合のみ使用すること。確認していない場合は「空室状況を確認してご連絡させて頂きます😊！！」とし、退去予定を勝手に断定しない。\n・【⚠️ 対象の無い確認約束の禁止】お客様が物件固有の事実を聞いていない返信で「確認しご連絡させて頂きます」「確認出来次第ご連絡」を締めに使うことは禁止（創作約束。final-check CONFIRM_NO_OBJECT で block）。確認事項が実在する場合（【✅ 確認対象（決定論）】が出ている時）は上記の対象付き宣言1文のみ書き、同じ返信内で二重に確認宣言しない。水道代・インターネット・設備の有無など管理会社への確認事項も「設備・利用条件確認させて頂きます」のように対象を書く。\n・【⚠️ スタッフが送った物件画像への「内容確認します」禁止】お客様が画像（物件資料・見積書）を送り返してきた場合、その画像はスタッフが先に送った物件の資料であることが多い。「お送り頂きました画像の内容を確認させて頂きます」「画像を確認しご連絡します」のように、まるで初めて見る資料かのように「内容確認します」と書いてはいけない。お客様の具体的な質問（「ここは誰か住んでいましたか？」等）にはその質問に直接答えるか、分からない場合は「確認いたします！！」とのみ伝える。`;

  // 待ち合わせ確定文はAIXの「待ち合わせ」ボタン専用。generate-replyでは住所・集合場所・集合時間の出力を禁止（propertyFactGateNoteと同型の常時注入ゲート）
  const meetingPlaceGateNote = [
    "🚫【待ち合わせ情報の生成禁止】物件の住所・集合場所・集合時間・待ち合わせ場所の確定文は通常返信に書いてはいけない。",
    "これらはAIX【待ち合わせ】(meeting_place)ボタン専用で生成・送信する。",
    "通常返信では「内覧の詳細についてはご連絡させて頂きます」等の宣言のみ書くこと。",
  ].join("\n");

  const aixOperationNote = [
    "【重要】以下のナレッジには「AIXボタンから送る」「AIXで誘導する」等のスタッフ向け操作指示が含まれる場合があります。",
    "これらはスタッフがどのボタンを押すかの原則であり、お客様へのLINE返信文に書いてはいけません。",
    "「AIXボタンから送る」「内覧へ！ボタンを使う」「申込ボタンで誘導」などの表現はLINE返信文に含めず、",
    "代わりにその話題に関する簡潔な受付・確認文のみ書いてください。",
  ].join("\n");

  // お客様メッセージ自体がリンク（URL）を求めている場合の専用ノート（引用コンテキスト非依存の保険）
  const isLinkRequestMsg = /(リンク|url|ＵＲＬ)\s*(を|の|教え|くださ|ちょうだい|ください|欲し|ほし|送|とか|って)/i.test(customerMessage)
    || /(url|ＵＲＬ|リンク).{0,12}(ありますか|ありますでしょうか|ありませんか|はありますか|もらえ)/i.test(customerMessage)
    || /(この|こちらの|その|これの|さっきの)(部屋|物件|お部屋).{0,6}(リンク|url|ＵＲＬ)/i.test(customerMessage);
  // 写真・画像・動画要求（「URL」という語を含まない要求）も同じゲートで検出する
  const isPhotoRequestMsg = /((室内|内装|間取り|物件)?(写真|画像|動画|フォト))\s*(を|が|は)?\s*(送って|見たい|ありますか|ください|欲しい|URL|url|リンク|見せて|もらえ|拝見)/.test(customerMessage ?? "");
  const linkRequestNote = (isLinkRequestMsg || isPhotoRequestMsg)
    ? `\n\n【🔗 写真/URL要求検出（最優先）】お客様は物件の写真・画像・URLを求めていますが、これらの送付はAIXツール（物件ピックアップした）またはスタッフ操作で行います。
【絶対禁止】返信文に「写真をお送りします」「URLをご案内します」「リンクをお送りします」「〜のURLとなります」等、写真・URLを今すぐ送る・案内するような文言を一切書かない。
・写真・URL・物件リンクが「今から届く」かのような表現も禁止。
・返信文は受付・確認の一言のみ：「確認させて頂きます😊！！」「しばらくお待ちください！！」程度にとどめる（「少々お待ちください」はfinal-check禁止語のため絶対に使わない）。
・物件名・号室は書かない（「お送り頂きました物件」で受ける。写真・URLも書かない。2026-09-11 竹内方針2）。`
    : "";

  // 共感フレーズ（全然大丈夫です／全然わがままじゃないですよ）の確定ゲート — 常時注入
  const empathyPhraseNote = buildEmpathyPhraseNote(customerMessage);

  // 絵文字位置の確定ゲート — お客様1行目に絵文字 → 返信も1行目に配置を強制
  const emojiPositionNote = buildEmojiPositionNote(customerMessage);

  // ─── 2回目締め検出（直前スタッフが締めの文 + 今回お客様がシンプル承認）─────────────
  // 前回の大きな締めフレーズを繰り返すのを防ぐ。短い承認返し+次アクション1行に収める。
  const lastStaffMsgRaw = lastStaffLines.length > 0 ? lastStaffLines[lastStaffLines.length - 1] : "";
  const PRIOR_CLOSING_RE = /全力でサポートさせて頂きます|ご満足頂けるお部屋が見つかるまで|全力でお探しさせて頂きます|何卒よろしくお願い致します|新着が出次第(?:すぐに)?お送り|新着物件が出次第|出次第すぐにお送り/;
  const CUSTOMER_SIMPLE_ACK_RE = /^[\s　]*(ありがとうございます|ありがとうございました|ありがとう|よろしくお願いいたします|よろしくお願い致します|よろしくお願いします|よろしくおねがいいたします|よろしくおねがいします|よろしくおねがい致します|おねがいします|お願いします|楽しみにしています|頑張ります|待っています|お待ちしています|期待してます|了解|わかりました|嬉しいです|御手数ですが)/;
  // G-9: pickupPromiseAckNote（2行以内）と secondClosingNote（3行構成）の行数指示競合を防ぐため、pickup 側発火時は抑制
  const isSecondClosing = !pickupPromiseAckNote && PRIOR_CLOSING_RE.test(lastStaffMsgRaw) && CUSTOMER_SIMPLE_ACK_RE.test(customerMessage.trim());
  const secondClosingNote = isSecondClosing
    ? `\n【🔁 2回目締め検出（最優先・全生成ルールを上書き）】直前スタッフ返信で「全力でサポートさせて頂きます」等の大きな締め文を既に送っている。お客様は「ありがとうございます」「よろしくお願いします」等でシンプルに承認している。
【返信の型（絶対に守る・これ以外は入れない）】
① 冒頭挨拶 — 【⏰ 挨拶ルール・最優先】に従う（1フレーズのみ）
② 短い受け返し 1行 — 「こちらこそよろしくお願い致します！！」「ありがとうございます！！」等
③ 次アクション宣言 1行 — 「新着物件が出次第お送りさせて頂きます！！」等（条件・費用の言及は禁止。「すぐに」は禁止）
【🚫 絶対禁止（最優先）】「全力でサポートさせて頂きます」「ご満足頂けるお部屋が見つかるまで」等の締めフレーズを再度使うこと。3行を超える返信。条件まとめ・費用・長い説明の追加。`
    : "";

  // ─── 内覧日程確定後シンプル締め検出 ────────────────────────────────────────
  // スタッフが内覧日時を確定した後にお客様がシンプル承認 → 余計な詳細を一切出さない
  // 成約データのパターン: 「はい！！本日何卒よろしくお願い致します😊！！」のみ
  // 直近3件のスタッフ発言を結合して検出（1件だけでは見逃す場合がある）
  // 直近3件のスタッフ発言を結合して検出（待ち合わせ確定は複数メッセージにまたがる場合がある）
  const recentStaffText = lastStaffLines.slice(-3).join("\n");
  // A: 日付/スラッシュ形式 + 60文字以内に 案内|内覧|待ち合わせ|エントランス
  // B: 内覧 + ご案内させて頂き
  // C: 「住所:」行（AIXの待ち合わせ確定メッセージに必ず含まれる決定的シグナル）
  const VIEWING_SCHEDULED_STAFF_RE = new RegExp(
    "(?:明日|本日|今日|明後日|[0-9０-９]{1,2}[\\/月][0-9０-９]{1,2}(?:日)?)(?:[^。\\n]{0,60})(?:ご?案内|内覧|内見|お待ち合わせ|待ち合わせ|エントランス)" +
    "|(?:内覧|内見).*(?:ご案内させて頂き|一緒にご案内)" +
    "|住所[:：]\\s*.{5,}"
  );
  // A-12（E-2）: 先頭アンカー付きの了承文型に限定し、リスケ要望（「別日でお願いします」「時間変更お願いします」）は除外
  const CUSTOMER_VIEWING_ACK_RE = /^(?:はい|了解|承知|かしこまり|わかりました|分かりました|大丈夫です|お願いします|よろしくお願い|ありがとう)[^\n]{0,12}$/m;
  const isViewingAppointmentAck = !isSecondClosing
    && VIEWING_SCHEDULED_STAFF_RE.test(recentStaffText)
    && CUSTOMER_VIEWING_ACK_RE.test(customerMessage.trim())
    && !RESCHEDULE_RE.test(customerMessage);
  const viewingAppointmentAckNote = isViewingAppointmentAck
    ? `\n【🤝 内覧日程確定後シンプル締め（最優先・全生成ルールを上書き・以下の全ルールより上位）】スタッフがすでに内覧日時・物件・待ち合わせ場所を確定しており、お客様がシンプルに承認している。詳細はすでに伝達済み。
【返信の型（絶対に守る・これ以外は入れない）】
① 冒頭挨拶 — 【⏰ 挨拶ルール・最優先】に従う（1フレーズのみ）
② 締め 1行 — 内覧が本日なら「本日何卒よろしくお願い致します！！」、それ以外は「〇日何卒よろしくお願い致します！！」
【🚫 絶対禁止（1つも書かない・viewingFactNoteやフェーズ別パターンより本ルールが優先）】
・「ご都合よろしいお日にちにお部屋をご案内させて頂きます」← 日程は確定済みのため完全NG
・「内覧の詳細についてはご連絡させて頂きます」（詳細は確定済み）
・別物件への言及・追加提案
・「全力でサポートさせて頂きます」等の大きな営業締め文
・条件まとめ・費用・次のアクション提案`
    : "";

  // 入居可能時期質問の検出 — 2種類のパターンを検出する
  // ① 「最長いつまで入居を伸ばせますか」型（入居期限延長型）
  // ② 「8月末に入居できますか」「〇月中旬に入居は可能ですか」型（特定月への入居可否型）
  const MOVE_IN_TIMING_RE = /最長.{0,12}(?:いつ|何月|どこまで|伸ばせ|延長|延ばせ)|入居.{0,10}(?:最長|いつまで|延長|伸ばせ|どこまで)|いつ.{0,8}(?:まで|入居)|[0-9０-９一二三四五六七八九十]{1,2}月.{0,12}(?:に入居|まで入居|入居でき|入居は可能|入居間に合)|入居(?:でき|は可能|間に合).{0,8}(?:ます|ますか|でしょうか)/i;
  // 特定月への入居可否型（「〇月末に入居できますか」「8月に入居は可能ですか」等）を別途検出
  const SPECIFIC_MONTH_MOVE_IN_RE = /[0-9０-９一二三四五六七八九十]{1,2}月.{0,12}(?:に入居|まで入居|入居でき|入居は可能|入居間に合)|入居(?:でき|は可能|間に合).{0,8}(?:ます|ますか|でしょうか)/i;
  const isMoveInTimingQuestion = MOVE_IN_TIMING_RE.test(customerMessage);
  const isSpecificMonthMoveIn = SPECIFIC_MONTH_MOVE_IN_RE.test(customerMessage);
  const moveInTimingNote = isMoveInTimingQuestion
    ? isSpecificMonthMoveIn
      ? `\n【🏠 特定月への入居可否質問（確定・最優先）】お客様は「〇月末に入居できますか」「〇月に入居は可能ですか」等、特定の月への入居可否について質問しています。
【✅ 正しい回答方針（必ず守る）】
・即入居可能物件の場合: 「お申込から最短で2週間程でご入居出来ます！！申込後に保証会社審査（3日〜10日）が完了し、ご契約書類の記入と初期費用のご入金が完了次第ご入居頂けます！！」と直接答える
・今日の日付（${getJSTDateString()}）を基準に「〇月末入居が現実的かどうか」を判断して回答する。今日から2週間以内が入居希望日なら「最短で2週間かかるため〇月末は難しい状況です。〇月〜〇月のご入居が理想的な流れとなります！！」と伝える
・退去予定物件の場合は「ご入居可能日を管理会社に確認しご連絡させて頂きます😊！！」のみ（日程の自動計算は絶対禁止）
【🚫 絶対禁止】「お部屋が決まり次第ご連絡いたします」「詳細は改めてご連絡いたします」等の先送り表現。この質問は今この場で答えられる。`
      : `\n【🏠 入居可能時期の質問（確定・最優先）】お客様は「最長いつまで入居を伸ばせますか」「入居はいつまで可能ですか」等の入居タイミングについて質問しています。
【✅ 正しい回答方針（必ず守る）】
・「申込みから1ヶ月間がご入居可能時期の目安」として会話履歴の情報を踏まえて直接伝える（管理会社確認なしで伝えてよい標準情報）
・1ヶ月以降のご入居希望については「管理会社に交渉できる可能性がある」と伝えた上で全力でサポートする旨を添える
【🚫 絶対禁止】「確認させていただきます」「管理会社に確認します」と返すこと → 一手間増えて会話が止まる誤り。この質問は直接回答できる。`
    : "";

  // 新条件・追加要望の決定論的検出（brainが condition_change_type を返さなかった／stale／null の場合の保険）
  // Step1廃止（2026-08）に伴い T2/T3 フォールバック時の主防衛線になるため無条件で維持する。
  // 「〇〇の条件の部屋はありますか？」「〇〇でも大丈夫です」等 → 物件探し文脈。申込・見積書CTAは絶対禁止。
  // PROPERTY_CONDITION_INQUIRY_RE は brain-core と共有の条件問い合わせ検出（shared定数・二重定義禁止）
  const isNewConditionMsg =
    /(?:条件|エリア|家賃|間取り|築年数|駅|徒歩|広さ|収納|ペット|駐車場|オートロック|バストイレ別?|WIC|SIC|日当た|南向き)[^。！!？?\n]{0,24}(?:の(?:お?部屋|物件)|で(?:探|お願|大丈夫)|は(?:あります|ないです|ありません|可能))/i.test(customerMessage)
    || /(?:でも|も)(?:大丈夫|良いです|いいです|平気|構いま|OK|オッケー)/i.test(customerMessage)
    || /(?:もう少し|もっと|さらに)[^。！!？?\n]{0,12}(?:広|安|新し|駅近|抑え|きれい|綺麗)/.test(customerMessage)
    || /(?:ような|みたいな|といった)[^。！!？?\n]{0,8}(?:お?部屋|物件)[^。！!？?\n]{0,12}(?:あります|ないです|ありません)/.test(customerMessage)
    // T2/T3補完: brainのmessage-local分析が使えない時のみ、brain-core共有の条件問い合わせ検出を追加適用する
    // （fresh時はbrainの condition_change_type 判定が正。募集状況確認文脈は availabilityCheckNote が正のため除外）
    || (!brainFreshForMessage && !isAvailabilityCheckContext && PROPERTY_CONDITION_INQUIRY_RE.test(customerMessage));
  const newConditionRequestNote = (isNewConditionMsg && !conditionChangeNote)
    ? `\n【🆕 新条件・追加要望の検出（確定・最優先）】お客様は新しい条件・要望（「〇〇の条件のお部屋はありますか」「〇〇でも大丈夫です」等）を出しています。今のフェーズは「その条件でお部屋を探し直す」段階。
【返信の型（この要素以外を入れない）】
① 冒頭挨拶 — 【⏰ 挨拶ルール・最優先】に従う
②（該当する場合のみ）共感 — 【💬 共感フレーズ使い分け】の判定に従う。許可されていない共感フレーズは入れない
③ 条件を理解した旨 — お客様が出した条件を具体的な言葉でそのまま拾う（オウム返しの疑問形は禁止）
④ 物件ピックアップの行動宣言
⑤ 「〇〇さんがご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます😌！！」で締める
⑥ 禁止：実現可能性への言及（難しい・少ない・可能性）・条件緩和・代替案の先回り提案・お客様の自己ヘッジ（難しいと思う・あれば教えて）の復唱（探した後に結果と一緒に報告する）
【🚫 解説禁止】条件変更・追加の効果やメリットの解説（「エリアが広がりましたので、より条件に近いお部屋を見つけやすくなるかと思います」等）は絶対に書かない。承諾＋「〇〇さんのご希望のご条件に合ったお部屋を探してお送りする」コミットメントのみ。
【🚫 絶対禁止CTA（フェーズ別パターンより上位）】申込フォーマット・申込書類の案内・申込誘導／見積書の作成宣言・送付宣言・初期費用の金額提示／条件ヒアリングフォーム（①〜⑧）等のフォーマット送付／内覧日程の提案。CTAは「お部屋をお送りすること」のみ。`
    : "";

  // templateNote 指定時は指定生成モード（2〜3行制限・物件詳細禁止）を適用しない
  // — テンプレは長文（物件ピックアップ等）が正であり、行数キャップが品質を壊すため
  const replyHintNote = (replyHint && !templateNote)
    ? `\n\n【🔴✨ 指定生成モード（通常の生成ルールをすべて上書き）】
以下の指定内容のみに従い返信を生成すること。フェーズ別の行動パターン・物件送る・ピックアップ・長い説明は一切不要。
【長さ制限（絶対）】2〜3行に収めること。物件詳細・費用・比較・勧誘を書いてはいけない。
【文脈制限（絶対）】過去の会話にある家賃・号室・費用などの数値は今回のメッセージと直接関係ない限り一切使わない。
【本質】お客様のメッセージを一言で受け止め → 指定通りのアクションを宣言 → 完結させる（3ステップのみ）。
指定内容: ${replyHint}`
    : "";

  // knowledge注入フォーマット統一: 空でなければ「## 参照すべき重要ルール」ヘッダーで括る（ただのテキスト連結を防止）
  const knowledgeNote = knowledge
    ? `\n\n## 参照すべき重要ルール（DB学習ナレッジ・セクション順に優先度が高い）${knowledge}`
    : "";

  // 戦略注入のAIX-META一元化（2026-08）:
  // brainGuidanceNote（AIX-META = suggested_aix_meta 由来）が存在する場合、それが全情報を統合した
  // 唯一の戦略指示となるため、closingNote は注入しない（二重注入による戦略の矛盾を防ぐ）。
  // Step1完全廃止（2026-08）: closingNote は brainMeta 完全欠落時（T3）専用フォールバックに縮退。
  // 構成要素は ai_summary_json.winning_pattern / next_action の2つのみ — どちらも過去のbrain実行が
  // property_customers に保存した値のため、Step1なしでも供給が途切れない。
  // 「【🧠 AIX-META戦略」ヘッダー = 実質戦略（action/reply_direction/key_topics/closing_strategy/next_steps）あり。
  // 補助メタのみ（customer_intent・avoid_topics「来阪」等）の場合は false → closingNote/summaryNote を従来通り注入する
  const hasAixMetaStrategy = brainGuidanceNote.includes("【🧠 AIX-META戦略");
  const closingNote = (() => {
    if (hasAixMetaStrategy) return "";
    const parts: string[] = [];
    if (closingPatternFromSummary) parts.push(`この会話の成約ポイント: ${closingPatternFromSummary}`);
    if (nextActionFromSummary) parts.push(`今すぐ打つべき次の一手（スタッフへの行動方針）: ${nextActionFromSummary}`);
    if (parts.length === 0) return "";
    return `【🎯 戦略参考情報（AIX-METAが未生成のため参考として使用）】\n${parts.join("\n")}\n⚠️ 上記はスタッフへの行動方針であり、物件の事実情報ではありません。「退去予定」「空き予定」「〜月末まで」等の具体的な期日・空室情報は、会話履歴やDBで確認された事実でない限りLINEメッセージ本文に断言・創作しないこと。\n`;
  })();
  // P0-2: T3ゼロ戦略フォールバック — brainMeta=null かつ ai_summary_json に
  // winning_pattern/next_action が存在しない場合、summaryNote（顧客サマリー）を根拠に
  // 成約優先の汎用指示を注入する。summaryNote が存在する = 過去の brain 実行結果が DB に
  // 残っているため、summaryNote の内容をベースに AI が戦略を推論できる。
  const closingFallback = !hasAixMetaStrategy && !closingNote && summaryNote
    // 2026-09-10 Fable5 Sさん事例: WE DO 候補に「内覧のご案内提案」を追加（四者同名。STATE_FALLBACK_DIRECTION.proposing と同じ列挙）
    ? `\n【🎯 T3フォールバック戦略（AIX-META未生成・ai_summary参考情報も不在）】\n上記の顧客サマリーの内容に基づき、成約を最優先で誘導すること。具体的なWE DO宣言を1つだけ返信末尾に必ず含める（複数並べない）: ①内覧のご案内提案（「よろしければ〇〇さんご都合よろしいお日にちにお部屋ご案内させて頂きます😌！！」・具体的な候補日時は書かない＝AIX【内覧日調整】専用）②募集状況の確認 ③御見積書の作成・送付 ④ご条件に合うお部屋のピックアップ ⑤申込でお部屋を抑える提案。見積書提示はお客様が費用・見積を質問している場合のみ（費用文脈が無ければ見積書ではなくピックアップ宣言・内覧提案を選ぶ）。\n`
    : "";

  // ── HumanMessage 2-block プロンプトキャッシュ（2026-08）──
  // Block 1（静的ルール群・cache_control: ephemeral）: 顧客共通のルール・ゲート・パターン。
  //   quickPatterns は挨拶状態で 3 バリアントあるが、1 通話中は同じバリアントを再送するためキャッシュが効く。
  //   smoraRulesNote / realEstateNote は promptOverrides で上書き可能だが通常は定数。
  // Block 2（動的・per-customer）: 顧客コンテキスト・会話履歴・お客様メッセージ・実例。
  //   Block 1 のキャッシュを活かすため後ろに置く。
  // 返信文にURLを含めることを常時禁止（URL送信はAIXピッカーorスタッフ手動で行う運用のため）
  const URL_BAN_NOTE = `【🔴 URL送信禁止（常時適用・絶対遵守）】返信文に「https://」「http://」で始まるURLを一切含めない。会話履歴・AIXデータにURLが含まれていても、LINEへの返信文に転記・引用・紹介することは絶対禁止。物件URLや写真URLの送付はAIXの「室内写真を確認した」ピッカーまたはスタッフが手動で行う。`;

  // importance=10 の principle（絶対原則）。DB由来の動的コンテンツのため staticBlock ではなく
  // dynamicBlock 先頭に注入する（staticBlock に入れると行の増減でキャッシュ全体が無効化されるため）
  const topPrinciplesNote = topPrinciples.length > 0
    ? "【📌 絶対原則（importance=10・全顧客共通・常時遵守）】\n" +
      topPrinciples.map((p, i) => `${i + 1}. ${p.title ? `[${p.title}] ` : ""}${p.content}`).join("\n")
    : "";
  const staticBlock = [
    quickPatterns,
    smoraRulesNote,
    realEstateNote,
    curatedReplyRulesNote,
    NG_PHRASE_NOTE,
    TEMPORARY_SITUATION_NOTE,
    SEPARATE_APPOINTMENT_NOTE,
    propertyFactGateNote,
    QUOTE_REPLY_JUDGE_NOTE,
    meetingPlaceGateNote,
    aixOperationNote,
    URL_BAN_NOTE,
  ].filter(Boolean).join("\n");

  // Step1廃止（2026-08）: 旧 currentPropertyNote/repeatedConcernNote/hesitancyNote スロットは
  // brainGuidanceNote の message-local 戦術ブロックへ統合されて消滅。approachNote も
  // reply_direction + recommended_tone（brainGuidanceNote）が代替するため消滅。
  // questionsNote は T2/T3 決定論フォールバック時のみ非空（fresh時は brainGuidanceNote 側が正）。

  // phaseGuide（state 依存の固定テキスト）を独立した humanBlocks[1] に分離（2026-08）
  // state は 5 種類（first_reply/hearing/proposing/applying/closed_won）の固定値のみ →
  // 同じ state のリクエストが連続する間、cache_control がキャッシュリード（約0.1x価格）を発動する。
  // 顧客固有データ（staffContextNote 等）は後続の dynamicBlock に残す。
  // S-2 / A-8 / §4-2: 全フェーズ共通の型（PHASE_COMMON_FORMAT）を先頭に、フェーズ別禁止事項を末尾に連結（state 単位で固定なのでキャッシュは維持される）
  // 2026-09-08: ctx（送付済み物件数）を渡し、proposing 送付済みで「見積書禁止」が誤表示されないようにする（final-check E10 onlyIf と同値）
  const phaseGuideBlock = `${PHASE_COMMON_FORMAT}\n\n【現在の営業フェーズ】${effectivePhase}\n${phaseGuide}${buildPhaseProhibitionNote(effectivePhase, { sentPropertiesCount: estimateVerdict?.sentPropertiesCount ?? 0 })}`;

  // P0-1: viewingNote（クライアントが渡す内覧関連情報）をdynamicBlockに展開する。
  // viewingFactNote（物件退去予定/入居中判定）とセットでお客様メッセージ末尾に配置する。
  const viewingNoteBlock = viewingNote ? `\n\n【内覧情報】${viewingNote}` : "";

  // 複数メッセージ結合時は番号付きで全通への返信を明示し末尾優先バイアスを防ぐ
  // 2026-09-09 Fable5: 旧 split("\n") は1通内の改行を「2通」に分割し「[1通目]ありがとう／[2通目]懸念」→「はい😊！！＋かしこまりました！！」の
  //   分割相槌骨格を誘導していた。通単位（MSG_SEP / customerMessageUnits）でのみ分割する
  const customerMsgLines = splitMessageUnits(customerMessage, customerMessageUnits);
  const customerMsgBlock = !isFollowUp && customerMsgLines.length > 1
    ? `【お客様の最新メッセージ（${customerMsgLines.length}通・1つの流れとして読み、1つの返信を生成すること。通ごとに相槌を打たない）】\n` +
      customerMsgLines.map((line, i) => `[${i + 1}通目] ${line}`).join("\n")
    : `${isFollowUp ? "【参考：お客様の直近メッセージ（既に返信済み）】" : "【お客様の最新メッセージ】"}\n${(customerMessage || "").split(MSG_SEP).join("\n")}`;

  // topPrinciplesNote（DB由来）と replyContentNote（テンプレモードで空文字化）は
  // staticBlock を汚染しないよう dynamicBlock 側に配置する
  const dynamicBlock =`${topPrinciplesNote}${replyContentNote}
${propertyStatusNote}
${actionLedgerNote}${turnPairNote}${stanceNote}${tpoGuidanceNote}${closingNote}${closingFallback}${brainGuidanceNote}${directionNote}${nameNote}${conditionsNote}${inlineConditionsFallback}${missingConditionsNote}${opinionsNote}${summaryNote}${dateNote}${greetingNote}${empathyPhraseNote}${emojiPositionNote}${secondClosingNote}${viewingAppointmentAckNote}${moveInTimingNote}${managementNote}${repetitionNote}${questionsNote}${conditionChangeNote}${newConditionRequestNote}${searchAgainNote}${promiseEchoNote}${pickupPromiseAckNote}${estimatePromiseAckNote}${aixDoneAckNote}
${staffContextNote}
${aixPropertyRecommendationNote}${aixPropertySendNote}
${knowledgeNote}
${phrases}

${quotedContextNote}
【直近の会話履歴（スモラ自身の返信も含む）】この履歴を必ず参照すること。履歴内でお客様が既に答えた質問を再度聞かない。スモラが既に伝えた情報と矛盾しない。
${history || "なし"}

${customerMsgBlock}${applicationFormNote}${viewingFactNote}${viewingNoteBlock}${viewingIntentShortReplyNote}${linkRequestNote}${confirmationGateNote}${availabilityCheckNote}${budgetInventoryNote}${estimateGateNote}${aixTimingNote}

${examples}${examplesInstruction}

↑${isFollowUp ? "スモラは既にこのメッセージに返信済み。前の返信内容を繰り返さず、続きとして自然につながるメッセージを1つ生成すること。" : `スモラの直前返信の流れを踏まえ、${examples ? "⭐実例の文体・テンポ" : "PHASE_GUIDE の例文の文体・テンポ"}を参考にしながら、上記の挨拶ルール・禁止ワードを必ず守って、このメッセージへのスモラらしい返信を1つ生成してください。`}
長さの目安: 承認・了解→2行、条件確認・ヒアリング→3〜4行、物件紹介→フォーマット通り（制限なし）。初回挨拶の「鈴木と申します」を除き、本文中に担当者名（鈴木など）を入れない。${replyHintNote}${templateNote}`;

  // dbRules を SystemMessage に注入（HumanMessage より優先度が高く aix/action と同じ注入経路）
  // 戦略の優先規定（AIX-META一元化）: 指示が競合した場合の解決順を最上位で1行宣言する
  // A-8: tpoGuidanceNote ヘッダ（「AIX-META戦略より上位」）と矛盾していた優先順位宣言に「場面と返信方針」を追加
  const priorityOrderNote = "【指示の優先順位（競合時はこの順で解決すること）】ハードゲート（内覧日時・見積・物件事実制約）> 場面と返信方針（TPO）> AIX-META戦略 > フェーズ別パターン > ai_summary参考情報\n\n";
  const baseSystem = promptOverrides?.generationSystem ?? GENERATION_SYSTEM;
  // ── プロンプトキャッシュ（2026-08）──
  // 全顧客共通の priorityOrderNote + GENERATION_SYSTEM（約8,900字 ≒ 5,000+トークン）を
  // cache_control 付きの先頭ブロックにする（claude-sonnet-5 の最小キャッシュ 1024 トークンを大幅超過）。
  // dbRules は conversation_state × is_first_reply 単位で変化するため後続ブロック（cache_control なし）に分離。
  // 最終チェック指摘後のリトライ再生成（retryMessages = [...messages, ...]）は同一プレフィックスを
  // 再送するため、この cache_control がそのまま伝搬してキャッシュリード（約0.1x価格）になる。
  // 検証は response usage の cache_read_input_tokens で行う。
  const systemBlocks: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" } }> = [
    { type: "text" as const, text: priorityOrderNote + baseSystem, cache_control: { type: "ephemeral", ttl: "1h" } },
  ];
  if (dbRules) systemBlocks.push({ type: "text" as const, text: dbRules, cache_control: { type: "ephemeral", ttl: "1h" } });
  // humanBlocks 3 分割（2026-08 phaseGuide 分離）:
  // [0] staticBlock（全顧客共通ルール・cache_control あり）
  // [1] phaseGuideBlock（state 5 種類の固定テキスト・cache_control あり・state 単位でキャッシュリード）
  // [2] dynamicBlock（顧客固有データ・cache_control なし）
  const humanBlocks: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" } }> = [
    { type: "text" as const, text: staticBlock, cache_control: { type: "ephemeral", ttl: "1h" } },
    { type: "text" as const, text: phaseGuideBlock, cache_control: { type: "ephemeral", ttl: "1h" } },
    { type: "text" as const, text: dynamicBlock },
  ];
  return [new SystemMessage({ content: systemBlocks }), new HumanMessage({ content: humanBlocks })];
}

// ─── 状態解決（S-2 / 2026-09-08 Fable5）────────────────────────────────────────────
// 旧実装は normalizeState が viewing を proposing に畳むため PHASE_GUIDE.viewing が到達不能で、
// TPO 判定は生 state・ガイドは正規化 state の二重基準になり、closed_lost／未知キーが最も危険な
// 「初回挨拶」側（first_reply）に無ログで倒れていた。resolveState が phase / guideKey / searchState の
// 3値を1関数で返し、未知キーのフェイルセーフは「初回挨拶を出さない側」に倒して必ず state:unknown ログを出す。
const ALLOWED_STATES = new Set<string>(["first_reply", "hearing", "proposing", "viewing", "applying", "closed_won", "closed_lost"]);
const STATE_ALIAS: Record<string, string> = {
  condition_hearing: "hearing", property_search: "hearing", searching: "hearing",
  property_recommendation: "proposing", estimate_request: "proposing", availability_check: "proposing",
  initial: "first_reply", new: "first_reply", new_inquiry: "first_reply",
  application: "applying", screening: "applying", contract: "applying",
  lost: "closed_lost", cancelled: "closed_lost", closed: "closed_lost",
  // viewing は独立 state（PHASE_GUIDE.viewing を生かす）
};
// RAG 検索用の5段階（viewing / closed_lost は proposing の実例・知識も引けるよう畳む）
const RAG_PHASE: Record<string, string> = { viewing: "proposing", closed_lost: "proposing" };
// AIX 固有キー（greeting_viewing 等）→ 親フェーズの逆引き（先勝ち・ALLOWED_STATES 自体は除外）
const SEARCH_ALIAS_REVERSE: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [parent, kids] of Object.entries(STATE_SEARCH_ALIASES)) {
    for (const k of kids as string[]) {
      if (ALLOWED_STATES.has(k) || out[k]) continue;
      out[k] = parent;
    }
  }
  return out;
})();

type ResolvedState = { phase: string; guideKey: PhaseKey; searchState: string; raw: string; known: boolean };

function resolveState(
  raw: string | null | undefined,
  opts: { hasStaffMsg: boolean; checkpointStage?: string | null; brainFresh: boolean; conditionPresented?: boolean; conversationId?: string },
): ResolvedState {
  const k = (raw ?? "").trim();
  const aliased = STATE_ALIAS[k] ?? SEARCH_ALIAS_REVERSE[k] ?? k;
  let phase: string;
  let known = true;
  if (!k || !ALLOWED_STATES.has(aliased)) {
    // フェイルセーフは「初回挨拶を出さない」側に倒す（スタッフ発言があれば proposing）
    phase = opts.hasStaffMsg ? "proposing" : "first_reply";
    known = false;
    console.warn(JSON.stringify({ tag: "state:unknown", raw: k || "(empty)", inferred: phase, conversationId: opts.conversationId ?? null }));
  } else {
    phase = aliased;
  }
  let guideKey = phase as PhaseKey;
  // hearing で条件が揃っている → 聞き返し禁止の proposing ガイドへ前倒し（DB status は触らない）
  if (phase === "hearing" && opts.conditionPresented) guideKey = "proposing";
  // brain checkpoint_stage は fresh かつ前進方向のみ採用
  const cs = opts.brainFresh ? (opts.checkpointStage ?? null) : null;
  if (cs === "viewing" && (phase === "proposing" || phase === "hearing")) guideKey = "viewing";
  if (cs === "applying" && phase === "proposing") guideKey = "applying";
  if (cs === "contract" && (phase === "applying" || phase === "proposing")) guideKey = "closed_won";
  return { phase, guideKey, searchState: RAG_PHASE[guideKey] ?? guideKey, raw: k, known };
}
// 後方互換（isFirstReplyGateExempt 等の軽量判定用。ログは resolveState 側で出る）
function normalizeState(k: string): string {
  return resolveState(k, { hasStaffMsg: true, brainFresh: false }).phase;
}

// ─── phrase_dictionary → conversationState マッピング（複数カテゴリ対応）────
const STATE_TO_PHRASE_CATEGORIES: Record<string, string[]> = {
  first_reply: ["hearing_start"],
  hearing:     ["hearing_followup", "condition_summary"],
  proposing:   ["property_recommendation", "urgency_push", "viewing_invite", "estimate_send", "availability_check"],
  applying:    ["application_push", "anxiety_relief", "estimate_start"],
  closed_won:  ["closing_support"],
};

async function fetchPhrases(state: string): Promise<string[]> {
  const categories = STATE_TO_PHRASE_CATEGORIES[state];
  if (!categories || categories.length === 0) return [];

  // 複数カテゴリをまとめて取得・priority 10以上のみ
  const { data } = await supabase
    .from("phrase_dictionary")
    .select("phrase, priority, category")
    .in("category", categories)
    .gte("priority", 10)
    .order("priority", { ascending: false })
    .limit(40);

  if (!data || data.length === 0) return [];

  // コード側で問題フレーズを除外：
  // - {{...}} テンプレート変数（未置換で残るため）
  // - 特定会社名ベタ書き（イエヤス・ギガ等）
  // - 不自然に長い（80字超）
  const BAD_PATTERNS = /\{\{|\}\}|イエヤスなら|ギガ賃貸なら|スモラでは契約内容/;
  return (data as Array<{ phrase: string; priority: number; category: string }>)
    .filter((r) => r.phrase && !BAD_PATTERNS.test(r.phrase) && r.phrase.length <= 80)
    .slice(0, 12)
    .map((r) => r.phrase);
}

// フレーズ集のプロンプト文字列化。
// ⑥二重注入対策: pgvector経路で category=phrase のナレッジが3件以上ヒットした場合は limit=4 に絞って呼ぶ
function formatPhrases(phrases: string[], limit: number): string {
  const use = phrases.slice(0, limit);
  if (use.length === 0) return "";
  return "\n\n【スモラのフレーズ集（参考程度に・⭐実例を最優先すること）】\n" +
    use.map((p) => `「${p}」`).join("　");
}

// ─── ai_summaryがない場合の即席コンテキスト合成（Haiku・並列実行）────────────
async function synthesizeCustomerContext(conditions: string, customerName: string, history?: string): Promise<string> {
  try {
    const historyNote = history
      ? `\n直近の会話:\n${history.split("\n").slice(-10).join("\n")}`
      : "";
    const summaryPrompt = `以下の賃貸希望条件と会話履歴から、お客様の状況を1〜2文で要約してください。
お客様名: ${customerName || "不明"}
条件:
${conditions}${historyNote}

例: 「梅田エリアで1LDK・家賃8万以内を探している。内覧済みで申込を検討中。審査に不安あり。」
要約のみ返答（説明不要）:`;
    const res = await createAnalysisModel().invoke([new HumanMessage(summaryPrompt)]);
    warnIfTruncated(res.response_metadata?.stop_reason, summaryPrompt.length);
    return typeof res.content === "string" ? res.content.trim() : "";
  } catch (err) {
    console.error("[generate-reply] 即席サマリー合成失敗 — サマリーなしで続行:", err);
    return "";
  }
}

// ─── DB取得 ─────────────────────────────────────────────────────────────────
// STATE_SEARCH_ALIASES は @/app/lib/line-reply-prompts からインポート済み

type KnowledgeRow = { id: string; title: string; content: string; category: string; conversation_state: string; importance: number; hypothesis_status?: string; created_at?: string };

function incrementKnowledgeUsage(ids: string[]): void {
  if (!ids.length) return;
  // used_count を +1、last_used_at を更新
  // after(): レスポンス返却後もサーバーレス実行コンテキストが凍結される前に完了を保証
  after(async () => {
    try {
      await supabase.rpc("increment_knowledge_used_count", { p_ids: ids });
    } catch {
      // 使用回数更新の失敗は返信生成に影響させない
    }
  });
}

function logKnowledgeApply(ids: string[], conversationId: string): void {
  if (!ids.length || !conversationId) return;
  // knowledge_apply_log に適用記録（result=pending）
  // C05: source='generate_reply' を付与して aix/action 由来のログと混在しないようスコープ
  // after(): レスポンス返却後もサーバーレス実行コンテキストが凍結される前に完了を保証
  after(async () => {
    try {
      await supabase.from("knowledge_apply_log").insert(
        ids.map(id => ({ knowledge_id: id, conversation_id: conversationId, source: "generate_reply" }))
      );
    } catch {
      // 適用ログの失敗は返信生成に影響させない
    }
  });
}

// 戻り値: text=プロンプト注入用ナレッジ文字列 / phraseHits=category=phrase のヒット件数（fetchPhrases の二重注入削減判定に使用）
async function fetchKnowledge(state: string, customerMessage?: string, analysisContext?: string, conversationId?: string, spec?: BrainFetchSpec, brainMeta?: AixGateMeta | null, lastStaffMessage?: string | null, lastAixHistoryText?: string | null): Promise<{ text: string; phraseHits: number; topPrinciples: KnowledgeRow[] }> {
  const stateAliases = STATE_SEARCH_ALIASES[state] || [state];

  // T1動的選択: spec未指定（後方互換）は全クエリ実行＝従来動作（T2/T3のspecも全enabled）
  const lossEnabled = spec?.lossPatterns.enabled ?? true;
  const lossLimit = spec?.lossPatterns.limit ?? 4;
  const applyingEnabled = spec?.applyingPatterns.enabled ?? true;
  const viewingEnabled = spec?.viewingPatterns.enabled ?? true;
  const adaptEnabled = spec?.adaptRules.enabled ?? true;

  // 失注パターン専用バケット（auto-analyze-losers が category=principle / importance=8 で保存するため、
  // pgvector経路の importance>=9 フィルタ・フォールバック経路の principle 除外の両方から漏れる → 専用クエリで必ず届ける）
  const [{ data: lossPatterns }, { data: topPrinciples }, { data: adaptRules }, { data: applyingPatterns }, { data: viewingPatterns }] = await Promise.all([
    lossEnabled
      ? supabase
          .from("ai_reply_knowledge")
          .select("id, title, content, importance, category")
          .ilike("title", "失注パターン%")
          .neq("hypothesis_status", "rejected")
          .order("importance", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(lossLimit)
      : Promise.resolve({ data: null }),
    // importance=10 の principle を dynamicBlock 先頭（topPrinciplesNote）に注入するため全件取得。
    // importance=9 以下は pgvector criticalVector（RAG最大16件）で供給。
    supabase
      .from("ai_reply_knowledge")
      .select("id, category, title, content, importance")
      .eq("category", "principle")
      .eq("importance", 10)
      .or("hypothesis_status.is.null,hypothesis_status.neq.rejected")
      .order("created_at", { ascending: false })
      .order("id"),
    // HIGH-05: テンプレート修正学習ルール（テンプレ適用→スタッフ編集→送信から学習したパターン）
    adaptEnabled
      ? supabase
          .from("adaptation_improvement_rules")
          .select("rule_text, confidence, category")
          .eq("is_active", true)
          .gte("confidence", 0.7)
          .order("confidence", { ascending: false })
          .limit(5)
      : Promise.resolve({ data: null }),
    // 類似ケース専用バケット（category='applying_pattern' — 申込に至った実例パターン。
    // pgvector経路のバケット・フォールバック経路のcategoryフィルタの両方から漏れるため専用クエリで必ず届ける）
    applyingEnabled
      ? supabase
          .from("ai_reply_knowledge")
          .select("id, title, content, importance, category, conversation_state")
          .eq("category", "applying_pattern")
          .neq("hypothesis_status", "rejected")
          .order("importance", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(3)
      : Promise.resolve({ data: null }),
    // 内見系パターン専用バケット（category='viewing_pattern' — 内見成功実例パターン。
    // pgvector経路のバケット・フォールバック経路のcategoryフィルタの両方から漏れるため専用クエリで必ず届ける）
    viewingEnabled
      ? supabase
          .from("ai_reply_knowledge")
          .select("id, title, content, importance, category, conversation_state")
          .eq("category", "viewing_pattern")
          .neq("hypothesis_status", "rejected")
          .order("importance", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(3)
      : Promise.resolve({ data: null }),
  ]);
  const lossList = (lossPatterns ?? []).filter(p => (p.content ?? "").trim().length > 0);
  const lossIds = lossList.map(p => p.id).filter(Boolean);
  const lossBlock = lossList.length > 0
    ? "【🚫 避けるべき対応（失注実例より）】\n" + lossList.map((p, i) => `${i + 1}. ${p.content}`).join("\n")
    : "";

  // 類似ケース（申込に至った実例パターン）— 展開の参考として別フォーマットで注入
  const applyingList = (applyingPatterns ?? []).filter(p => (p.content ?? "").trim().length > 0);
  const applyingIds = applyingList.map(p => p.id).filter(Boolean);
  const applyingBlock = applyingList.length > 0
    ? "【💡 類似ケース（申込に至った実例パターン — この展開を参考に次の一手を組み立てる・文面の丸写しは禁止）】\n" +
      applyingList.map((p, i) => `${i + 1}. ${p.title ? `[${p.title}] ` : ""}${p.content}`).join("\n")
    : "";

  // 内見成功パターン（内見に至った・案内成功の実例パターン）— 内見局面の展開の参考として注入
  const viewingList = (viewingPatterns ?? []).filter(p => (p.content ?? "").trim().length > 0);
  const viewingIds = viewingList.map(p => p.id).filter(Boolean);
  const viewingBlock = viewingList.length > 0
    ? "【🏠 内見成功パターン（内見に至った・案内成功の実例 — この展開を参考に次の一手を組み立てる・文面の丸写しは禁止）】\n" +
      viewingList.map((p, i) => `${i + 1}. ${p.title ? `[${p.title}] ` : ""}${p.content}`).join("\n")
    : "";

  // pgvector検索（customerMessageがある場合・OPENAI_API_KEYが設定済みの場合）
  if (customerMessage && process.env.OPENAI_API_KEY) {
    // AIX-META潜在意識強化(2026-08-25): customer_intent（7分類）と latent_intent（送信動機・潜在意識の自由記述）を
    // 検索クエリに含め、「negative 審査に落ちる不安」等の心理文脈で関連ナレッジがヒットするようにする
    // property_search_params から検索条件（エリア・間取り・家賃上限・こだわり）をRAGクエリ化
    const psp = brainMeta?.property_search_params;
    const pspText = psp
      ? [psp.area, psp.floor_plan, psp.rent_max ? `家賃${psp.rent_max}円以内` : null, psp.preferences].filter(Boolean).join(" ")
      : null;
    // P0-3/P1-4: checkpoint_stage・repeated_concern・human_type_label・purchase_signal_level・engagement_stance を追加
    // （aix-template-generate・brain-core・aix/action の3経路と対称化。特にpeak/none温度感で申込局面の実例精度向上）
    const brainContext = brainMeta ? [brainMeta.action, brainMeta.closing_strategy, brainMeta.reply_direction, brainMeta.recommended_tone, brainMeta.customer_intent, brainMeta.latent_intent, brainMeta.winning_pattern, brainMeta.customer_emotion, brainMeta.checkpoint_stage ? `フェーズ: ${brainMeta.checkpoint_stage}` : null, brainMeta.repeated_concern ? `繰り返し懸念: ${brainMeta.repeated_concern}` : null, brainMeta.human_type_label ? `人物タイプ: ${brainMeta.human_type_label}` : null, brainMeta.purchase_signal_level ? `温度感: ${brainMeta.purchase_signal_level}` : null, brainMeta.engagement_stance ? `押し引き: ${brainMeta.engagement_stance}` : null, ...(brainMeta.key_topics ?? []), pspText].filter(Boolean).join(" ") : "";
    const lastAixPart = lastAixHistoryText ? `[AIX履歴] ${lastAixHistoryText} ` : "";
    const lastStaffPart = lastStaffMessage ? `[前返信]${safeSlice(lastStaffMessage, 150)} ` : "";
    // TPO場面推定（成約会話パターンのRAGブースト 2026-08-30）
    // ai_reply_knowledge（source='closed_won_analysis'）のconversation_stateラベルと一致させてORDER BY優先
    const tpoLabel = (() => {
      if (!brainMeta) return null;
      const intent = brainMeta.customer_intent ?? "";
      const action = brainMeta.action ?? "";
      const emotion = brainMeta.customer_emotion ?? "";
      const msg = customerMessage ?? "";
      // 1. 申込後説明（state確定・最優先）
      if (state === "applying") return "申込後説明";
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
      // 8. 物件送付後（actionで確実に検出＋従来のlastStaffMessageフォールバック）
      if (
        action === "property_send" ||
        action === "property_recommendation" ||
        action === "estimate_sheet" ||
        (lastStaffMessage && /ピックアップ|お部屋.*送|物件.*(紹介|送付|お送り)/.test(lastStaffMessage))
      ) {
        return "物件送付後";
      }
      // 9. 初回対応（スタッフ発言がまだない＝会話冒頭）
      if (!lastStaffMessage || state === "initial" || state === "new") {
        return "初回対応";
      }
      // 10. 感謝返し（isGratitudeReplyTPOと同じ60字・同じキーワードで統一）
      if (
        msg.length < 60 &&
        !/[?？]|希望|したい|教えて|どうすれば|送って(ください|ほしい|もらえ)|ください(?!ませ)/.test(msg) &&
        /ありがとう|感謝|助かり(ます|ました)|嬉しい|よろしくお願い|宜しくお願い|おねがいします|おねがいいたします|おねがい致します|お願いします|お願いいたします|お願い致します|承知|かしこまり|わかりました|分かりました|了解|楽しみ|お任せ|おまかせ|引き続き/.test(msg)
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
    // brainContextをstate直後に固定（末尾配置だとsafeSlice 2000字制限で切り落とされるリスクがあるため前詰め）
    // tpoLabelをクエリ先頭に明示して成約TPOパターンのembedding類似度を自然ブースト
    const searchQuery = safeSlice(`${tpoLabel ? `[TPO:${tpoLabel}] ` : ""}${state}: ${brainContext ? `[WE_DO文脈]${brainContext} ` : ""}${lastAixPart}${lastStaffPart}[顧客]${customerMessage} ${analysisContext ?? ""}`.trim(), 2000);

    const embedding = await generateEmbedding(searchQuery);
    if (embedding) {
      const { data: vectorResults, error: rpcError } = await supabase.rpc("match_reply_knowledge", {
        query_embedding: embedding,
        // M3(AIX-METAフル活用 2026-08): knowledge.limit（デッドフィールドだった）を正として接続。
        // brainが required+closing_strategy 確信時は spec 側で 60 に削減される（genericナレッジ洪水の抑制）
        match_count: spec?.knowledge?.limit ?? spec?.pgvectorMatchCount ?? 100,
        min_importance: 7,
        boost_state: tpoLabel,
      }) as { data: Array<KnowledgeRow & { similarity: number }> | null; error: { message: string } | null };
      if (rpcError) console.warn("[generate-reply] RPC error:", rpcError.message);

      // 類似度0.5未満のノイズを除外し、importance×similarity×鮮度 の複合スコアで並べ替え
      // （閾値は実例側の0.5と統一 — 0.6だと日本語短文でヒット率が低すぎた）
      // （RPCの similarity 順のままだと importance の低い近似ルールが各バケットの枠を食うため）
      // BUG-01: pgvector経路にも rejected フィルタを追加（フォールバック経路は .neq('hypothesis_status','rejected') 済みだが pgvector 経路だけ欠落していた）
      const filteredResults = (vectorResults ?? [])
        .filter(r => (r.similarity ?? 0) >= 0.5 && r.hypothesis_status !== "rejected")
        .map(r => {
          // 鮮度ファクター（半減期180日）: 古い誤傾向ナレッジより新しい修正ナレッジを優先する
          // created_at 不明時は 180日相当（recencyFactor=0.5）として扱う
          const daysSince = r.created_at
            ? (Date.now() - new Date(r.created_at).getTime()) / (1000 * 60 * 60 * 24)
            : 180;
          const recencyFactor = Math.pow(0.5, daysSince / 180);
          // confirmed（検証済み）ナレッジは +0.05 加点して hypothesis より実質的に優先させる
          const confirmedBonus = r.hypothesis_status === "confirmed" ? 0.05 : 0;
          return { ...r, score: (r.similarity ?? 0.5) * ((r.importance || 5) / 10) * (0.5 + 0.5 * recencyFactor) + confirmedBonus };
        })
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          // confirmed を同スコア内で優先（HIGH-07 pgvector経路対応）
          const aConf = a.hypothesis_status === "confirmed" ? 1 : 0;
          const bConf = b.hypothesis_status === "confirmed" ? 1 : 0;
          return bConf - aConf;
        });
      if (filteredResults.length > 0) {
        // FIX(旧データ競合): 未検証hypothesisがRAG注入プールの62%を占め生成を汚染していたため、
        // hypothesis の混入を各バケット上限の半分までにキャップする（confirmed/legacy(null)は無制限）
        const capHypothesis = <T extends { hypothesis_status?: string }>(rows: T[], limit: number): T[] => {
          const hypCap = Math.floor(limit / 2);
          const out: T[] = [];
          let hypCount = 0;
          for (const r of rows) {
            if (out.length >= limit) break;
            if (r.hypothesis_status === "hypothesis") {
              if (hypCount >= hypCap) continue;
              hypCount++;
            }
            out.push(r);
          }
          return out;
        };
        // ナレッジ洪水対策: 差分学習5件・修正対比5件・絶対ルール8件・パターン5件に上限を削減
        const diffLearned = capHypothesis(filteredResults.filter(r => r.title.includes("差分学習")), 5);
        const correctionPairs = capHypothesis(filteredResults.filter(r => r.title.includes("修正対比")), 5);
        // importance=10 は dynamicBlock 先頭（topPrinciplesNote）に注入済みのため除外。importance=8-9 を RAG で最大16件供給
        // FIX(旧データ競合): 【⚠️絶対ルール】バケットは confirmed（検証済み）限定にする。
        // hypothesis_status が null の行は hypothesis 制度導入前のlegacy（人手キュレーション）として信頼扱いで許可
        const criticalVector = filteredResults.filter(r =>
          r.importance >= 8 && r.importance < 10 && r.category === "principle" &&
          (r.hypothesis_status === "confirmed" || r.hypothesis_status == null)
        ).slice(0, 16);
        const critical = criticalVector;
        // patternバケット一本化: closed_won_analysis（成約実例）はhypothesis制限免除・全体上限8件
        // boost_state + searchQueryのTPOラベルで上位に来た成約パターンが確実に枠に入るようにする
        const patterns = (() => {
          const pool = filteredResults.filter(r => r.category === "pattern" && !r.title.includes("差分学習") && !r.title.includes("修正対比"));
          const out: typeof pool = [];
          let hypCount = 0;
          const hypCap = 3;
          for (const r of pool) {
            if (out.length >= 8) break;
            if (r.hypothesis_status === "hypothesis" && (r as unknown as { source?: string }).source !== "closed_won_analysis") {
              if (hypCount >= hypCap) continue;
              hypCount++;
            }
            out.push(r);
          }
          return out;
        })();
        const phrases = capHypothesis(filteredResults.filter(r => r.category === "phrase"), 6);
        // pgvector経路での applying_pattern: ベクトル類似度ベースの結果を優先し、なければ静的クエリにフォールバック
        // （RPC は category フィルタなし・importance>=7 のため applying_pattern 行は filteredResults に既に含まれる）
        const applyingVector = capHypothesis(filteredResults.filter(r => r.category === "applying_pattern"), 3);
        const effectiveApplyingList = applyingVector.length > 0 ? applyingVector : applyingList;
        const effectiveApplyingIds = applyingVector.length > 0 ? applyingVector.map(r => r.id).filter(Boolean) : applyingIds;
        const effectiveApplyingBlock = effectiveApplyingList.length > 0
          ? "【💡 類似ケース（申込に至った実例パターン — この展開を参考に次の一手を組み立てる・文面の丸写しは禁止）】\n" +
            effectiveApplyingList.map((p, i) => `${i + 1}. ${p.title ? `[${p.title}] ` : ""}${p.content}`).join("\n")
          : "";

        // pgvector経路での viewing_pattern: ベクトル類似度ベースの結果を優先し、なければ静的クエリにフォールバック
        const viewingVector = capHypothesis(filteredResults.filter(r => r.category === "viewing_pattern"), 3);
        const effectiveViewingList = viewingVector.length > 0 ? viewingVector : viewingList;
        const effectiveViewingIds = viewingVector.length > 0 ? viewingVector.map(r => r.id).filter(Boolean) : viewingIds;
        const effectiveViewingBlock = effectiveViewingList.length > 0
          ? "【🏠 内見成功パターン（内見に至った・案内成功の実例 — この展開を参考に次の一手を組み立てる・文面の丸写しは禁止）】\n" +
            effectiveViewingList.map((p, i) => `${i + 1}. ${p.title ? `[${p.title}] ` : ""}${p.content}`).join("\n")
          : "";

        const used = [...diffLearned, ...correctionPairs, ...critical, ...patterns, ...phrases];
        const usedAndLossIds = [...used.map(r => r.id).filter(Boolean), ...lossIds, ...effectiveApplyingIds, ...effectiveViewingIds];
        incrementKnowledgeUsage(usedAndLossIds);
        if (conversationId) logKnowledgeApply(usedAndLossIds, conversationId);

        const sections: string[] = [];
        if (diffLearned.length > 0) {
          sections.push("【🔴 AIが過去に間違えたパターン（最優先・必ず守る）】\n" + diffLearned.map((k, i) => `${i + 1}. ${k.content}`).join("\n"));
        }
        if (correctionPairs.length > 0) {
          sections.push("【🟠 スタッフが修正したポイント（このフェーズ専用）】\n" + correctionPairs.map((k, i) => `${i + 1}. ${k.content}`).join("\n"));
        }
        if (critical.length > 0) {
          sections.push("【⚠️ 絶対ルール】\n" + critical.map((k, i) => `${i + 1}. ${k.content}`).join("\n"));
        }
        if (patterns.length > 0) {
          sections.push("【スモラの営業パターン・原則】\n" + patterns.map((k, i) => `${i + 1}. ${k.content}`).join("\n"));
        }
        if (phrases.length > 0) {
          sections.push("【スモラのフレーズ】\n" + phrases.map(k => `「${k.content}」`).join("　"));
        }
        if (lossBlock) {
          sections.push(lossBlock);
        }
        if (effectiveApplyingBlock) {
          sections.push(effectiveApplyingBlock);
        }
        if (effectiveViewingBlock) {
          sections.push(effectiveViewingBlock);
        }
        // HIGH-05: テンプレート修正学習ルール注入
        if ((adaptRules?.length ?? 0) > 0) {
          sections.push("【📘 テンプレート修正学習ルール（テンプレ活用時の改善パターン — テンプレを使う場合は必ず参照）】\n" +
            (adaptRules as { rule_text: string; category: string }[]).map(r => `・[${r.category}] ${r.rule_text}`).join("\n"));
        }
        return { text: sections.length > 0 ? "\n\n" + sections.join("\n\n") : "", phraseHits: phrases.length, topPrinciples: (topPrinciples ?? []) as KnowledgeRow[] };
      }
    }
  }

  // フォールバック: importance順検索（OPENAI_API_KEY未設定時 or embedding取得失敗時）
  // principle は global/stateSpecific クエリから除外しているため、
  // 【⚠️絶対ルール】には冒頭で取得済みの topPrinciples（category=principle・importance>=9）を使う
  // T1: spec.knowledge.filterTopics（brainのkey_topics由来・1〜3件）がある場合、
  // トピック一致の追加クエリを baseクエリと並走させる（置換ではなく追加＝フェイルオープン）。
  // PostgREST の .or() 構文を壊す文字（, ( ) % \）はトピックから除去する
  const filterTopics = (spec?.knowledge?.filterTopics ?? [])
    .map(t => t.replace(/[,()%\\]/g, "").trim())
    .filter(t => t.length > 0);
  const topicOrClause = filterTopics.length > 0
    ? filterTopics.map(t => `content.ilike.%${t}%`).join(",")
    : null;
  const [{ data: stateDiff }, { data: globalDiff }, { data: correctionPairs }, { data: global }, { data: stateSpecific }, { data: topicMatched }] = await Promise.all([
    // HIGH-07: hypothesis_status を取得してconfirmed優先ソートに使う
    // MED-07: limit を削減（取得後にsliceするため余分フェッチを最小化）
    supabase.from("ai_reply_knowledge").select("id, category, title, content, importance, hypothesis_status")
      .ilike("title", "%差分学習%").gte("importance", 7)
      .in("conversation_state", stateAliases).neq("hypothesis_status", "rejected")
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false }).limit(12),
    supabase.from("ai_reply_knowledge").select("id, category, title, content, importance, hypothesis_status")
      .ilike("title", "%差分学習%").gte("importance", 7).neq("hypothesis_status", "rejected")
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false }).limit(8),
    supabase.from("ai_reply_knowledge").select("id, category, title, content, importance, hypothesis_status")
      .ilike("title", "%修正対比%").in("conversation_state", stateAliases).neq("hypothesis_status", "rejected")
      .order("importance", { ascending: false }).limit(8),
    supabase.from("ai_reply_knowledge").select("id, category, title, content, importance, hypothesis_status")
      .gte("importance", 8)
      .not("title", "ilike", "%差分学習%").not("title", "ilike", "%修正対比%")
      .not("category", "eq", "principle").neq("hypothesis_status", "rejected")
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false }).limit(8),
    supabase.from("ai_reply_knowledge").select("id, category, title, content, importance, hypothesis_status")
      .in("conversation_state", stateAliases).gte("importance", 8)
      .not("title", "ilike", "%差分学習%").not("title", "ilike", "%修正対比%")
      .not("category", "eq", "principle").neq("hypothesis_status", "rejected")
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false }).limit(20),
    // T1: key_topics 一致ナレッジ（importance>=7 に緩和して topic 関連の中重要度ナレッジも拾う）
    topicOrClause
      ? supabase.from("ai_reply_knowledge").select("id, category, title, content, importance, hypothesis_status")
          .gte("importance", 7)
          .or(topicOrClause)
          .not("title", "ilike", "%差分学習%").not("title", "ilike", "%修正対比%")
          .not("category", "eq", "principle").neq("hypothesis_status", "rejected")
          .order("importance", { ascending: false })
          .order("created_at", { ascending: false }).limit(10)
      : Promise.resolve({ data: null }),
  ]);

  // HIGH-07: confirmed を hypothesis より優先してソート
  const sortConfirmedFirst = <T extends { hypothesis_status?: string }>(arr: T[]): T[] =>
    [...arr].sort((a, b) => {
      if (a.hypothesis_status === "confirmed" && b.hypothesis_status !== "confirmed") return -1;
      if (b.hypothesis_status === "confirmed" && a.hypothesis_status !== "confirmed") return 1;
      return 0;
    });

  const stateDiffList = sortConfirmedFirst(stateDiff ?? []);
  const globalDiffDeduped = sortConfirmedFirst((globalDiff ?? []).filter(g => !stateDiffList.some(s => s.content === g.content)));
  // ナレッジ洪水対策: 差分学習は最大5件（pgvector経路と同じ上限）
  const diffLearned = [...stateDiffList, ...globalDiffDeduped].slice(0, 5);

  const correctionList = sortConfirmedFirst(correctionPairs ?? []);
  const stateSpecificList = sortConfirmedFirst(stateSpecific ?? []);
  const globalList = sortConfirmedFirst((global ?? []).filter(g => !stateSpecificList.some(s => s.content === g.content)));
  // T1: トピック一致ナレッジを先頭にマージ（idで重複排除・topic-matched first・非一致は捨てない）
  const topicList = sortConfirmedFirst(topicMatched ?? []);
  const baseAll = [...stateSpecificList, ...globalList];
  const all = topicList.length > 0
    ? [...topicList, ...baseAll.filter(k => !topicList.some(t => t.id === k.id))]
    : baseAll;
  const principlesList = topPrinciples ?? [];
  if (diffLearned.length === 0 && correctionList.length === 0 && all.length === 0 && principlesList.length === 0 && !lossBlock && !applyingBlock && !viewingBlock) return { text: "", phraseHits: 0, topPrinciples: (topPrinciples ?? []) as KnowledgeRow[] };

  // principle は global/stateSpecific クエリで除外済みのため、専用クエリの結果をそのまま使う
  const critical = principlesList;
  const patterns = all.filter(k => (k.importance || 0) >= 7 && k.category === "pattern");
  const phrases  = all.filter(k => k.category === "phrase");

  // 使用追跡（fire-and-forget）
  const usedIds = [
    ...diffLearned,
    ...correctionList.slice(0, 5),
    ...critical.slice(0, 8),
    ...patterns.slice(0, 5),
    ...phrases.slice(0, 6),
  ].map(k => (k as KnowledgeRow).id).filter(Boolean);
  const allFallbackIds = [...usedIds, ...lossIds, ...applyingIds, ...viewingIds];
  incrementKnowledgeUsage(allFallbackIds);
  if (conversationId) logKnowledgeApply(allFallbackIds, conversationId);

  const sections: string[] = [];
  if (diffLearned.length > 0) {
    sections.push("【🔴 AIが過去に間違えたパターン（最優先・必ず守る）】\n" + diffLearned.map((k, i) => `${i + 1}. ${k.content}`).join("\n"));
  }
  if (correctionList.length > 0) {
    sections.push("【🟠 スタッフが修正したポイント（このフェーズ専用）】\n" + correctionList.slice(0, 5).map((k, i) => `${i + 1}. ${k.content}`).join("\n"));
  }
  // importance=10 は dynamicBlock 先頭（topPrinciplesNote）に注入済みのため knowledgeNote への再注入はスキップ
  const criticalFallback = (critical as KnowledgeRow[]).filter(p => (p.importance ?? 10) < 10);
  if (criticalFallback.length > 0) {
    sections.push("【⚠️ 絶対ルール】\n" + criticalFallback.slice(0, 8).map((k, i) => `${i + 1}. ${k.content}`).join("\n"));
  }
  if (patterns.length > 0) {
    sections.push("【スモラの営業パターン・原則】\n" + patterns.slice(0, 5).map((k, i) => `${i + 1}. ${k.content}`).join("\n"));
  }
  if (phrases.length > 0) {
    sections.push("【スモラのフレーズ】\n" + phrases.slice(0, 6).map(k => `「${k.content}」`).join("　"));
  }
  if (lossBlock) {
    sections.push(lossBlock);
  }
  if (applyingBlock) {
    sections.push(applyingBlock);
  }
  if (viewingBlock) {
    sections.push(viewingBlock);
  }
  // HIGH-05: テンプレート修正学習ルール注入
  if ((adaptRules?.length ?? 0) > 0) {
    sections.push("【📘 テンプレート修正学習ルール（テンプレ活用時の改善パターン — テンプレを使う場合は必ず参照）】\n" +
      (adaptRules as { rule_text: string; category: string }[]).map(r => `・[${r.category}] ${r.rule_text}`).join("\n"));
  }
  return { text: sections.length > 0 ? "\n\n" + sections.join("\n\n") : "", phraseHits: Math.min(phrases.length, 6), topPrinciples: (topPrinciples ?? []) as KnowledgeRow[] };
}

// filterByDirection: 返信の方向性フレーズ（最大20字）から助詞を除いた名詞トークンを抽出する
// 例 "内見日程の確認" → ["内見日程", "確認"] / "申込意思の確認" → ["申込意思", "確認"]
function extractDirectionKeywords(direction: string | null): string[] {
  if (!direction) return [];
  return direction.split(/[のをにがはでもとへ]/).map(t => t.trim()).filter(t => t.length >= 2);
}

const ANGLE_LABEL: Record<string, string> = { A: "王道", B: "シンプル", C: "C案", short_direct: "短く直接" };

// ─── few-shot 前提フィルタ（2026-09-08 語彙セマンティクス）──────────────────────────
// 実例は「お客様:/スモラ:」1ペアで表示されるため「前返信＝撮影約束」等の前提が剥がれ、
// 「よろしくお願いします→撮影出来次第お送り」の無文脈マッピングが起きる。
// 現在の会話（直前スタッフ発言＋顧客メッセージ）に前提が無い語彙を含む実例は注入前に落とす。
// final-check.ts runVocabSemanticChecks（V7/V10/V9）と同名の前提条件（三者同名）。minKeep フェイルオープン維持。
function buildPremiseExcludeRe(staffHist: string, customerMessage: string): RegExp | null {
  const parts: string[] = [];
  // 顧客テキストは条件フォームの項目ラベル（⑦初期費用 等）を剥がしてから照合する
  const cust = (customerMessage ?? "").replace(FORM_LABEL_RE, "");
  if (!/撮影|写真|動画|オンライン内見|オンライン内覧/.test(staffHist + "\n" + cust)) parts.push("撮影");
  if (!/【画像】|お送りさせて頂きました|お送りしました|ピックアップしお送り|property_send|ご査収/.test(staffHist)) parts.push("ご査収");
  if (!/[0-9０-９]{1,2}\s*[\/／月]\s*[0-9０-９]{1,2}.{0,10}[0-9０-９]{1,2}時/.test(staffHist)) parts.push("現地到着|到着しております|本日[0-9０-９]{1,2}時");
  // 2026-09-08 見積前提: 顧客の費用質問・特定物件送付・前向き反応・直前スタッフ約束のいずれも無ければ見積語彙入りの実例を落とす
  if (!CUSTOMER_ESTIMATE_INTENT_RE.test(cust) && !CUSTOMER_PROPERTY_REF_RE.test(cust) && !CUSTOMER_ROOM_POSITIVE_RE.test(cust) && !STAFF_ESTIMATE_PROMISE_RE.test(staffHist))
    parts.push("(?:御|お)?見積(?:書|り|もり)?");
  if (!CUSTOMER_SCREENING_CONCERN_RE.test(cust)) parts.push("審査面|保証会社|独立系");
  if (!CUSTOMER_APPLY_OR_DOC_RE.test(cust)) parts.push("申込書類|入居申込書|必要書類|身分証(?:の)?(?:お写真|コピー)");
  return parts.length ? new RegExp(parts.join("|")) : null;
}
// 実例ヘッダー（pgvector経路・フォールバック経路で共通。文体のみ再現・業務内容は現在の会話に従う）
const EXAMPLES_HEADER_NOTE = "— 文体・テンポ・感嘆符・絵文字・長さのみをこの例から再現すること。業務内容（撮影／確認／ご査収／ご案内日時／見積送付 等の約束）は例の丸写し禁止。各例の業務語彙はその会話固有の前提（直前のスタッフ約束・送付済み物件・確定日程）に依存しており、現在の会話履歴に同じ前提が無ければ真似しない（会話内容・文脈は当該顧客の履歴を最優先）。ラベル: 王道=標準スモラスタイル / シンプル=短く簡潔 / C案=別角度アプローチ】\n";
// 前提ラベルは決定論で生成（LLMに選ばせない）。実例本文から「この語彙が成立する前提」を注記する
function derivePremiseLabel(reply: string): string {
  const labels: string[] = [];
  if (/撮影|写真|動画/.test(reply)) labels.push("直前返信で室内撮影・写真送付を約束済み（現在の会話に同じ約束が無ければ真似しない）");
  if (/ご査収|お送りした|お送りさせて頂きました/.test(reply)) labels.push("直前に物件・資料を送付済み");
  if (/現地|到着|本日[0-9０-９]{1,2}時/.test(reply)) labels.push("内覧日時確定済み");
  if (/確認(?:でき|出来)次第/.test(reply)) labels.push("管理会社への確認事項が発生している");
  if (/ご都合よろしいお日にち/.test(reply)) labels.push("特定物件を推した直後");
  if (/見積/.test(reply)) labels.push("お客様が費用・見積を質問／特定物件を送付／内覧後前向き反応のいずれかが会話にある（①〜⑧フォームの⑦初期費用は該当しない）");
  if (/審査面|保証会社/.test(reply)) labels.push("お客様が審査・保証の不安を自ら発言済み");
  if (/申込書類|必要書類|身分証/.test(reply)) labels.push("お客様が申込意思を表明済み");
  return labels.join("・");
}

async function fetchExamples(state: string, customerMessage?: string, lastStaffMessage?: string, analysisContext?: string, spec?: BrainFetchSpec, brainMeta?: AixGateMeta | null, staffHistoryForPremise?: string | null, brainFresh = true): Promise<string> {
  const stateAliases = STATE_SEARCH_ALIASES[state] || [state];
  // 前提フィルタ用のスタッフ履歴（follow-up でなくても直前スタッフ発言を使う）
  const premiseStaffHist = [staffHistoryForPremise ?? "", lastStaffMessage ?? "", brainMeta?.last_aix_history ?? ""].filter(Boolean).join("\n");
  const premiseExcludeRe = buildPremiseExcludeRe(premiseStaffHist, customerMessage ?? "");

  // pgvector 類似検索（OPENAI_API_KEY がある場合のみ・エラー時はフォールバック）
  // follow-up時: 「スモラが送った内容の続き」として検索クエリを構成
  // AIX-META潜在意識強化(2026-08-25): 実例検索クエリにも customer_intent / latent_intent を含める（ナレッジ検索側と同構成）
  // property_search_params から検索条件（エリア・間取り・家賃上限・こだわり）をRAGクエリ化
  const psp = brainMeta?.property_search_params;
  const pspText = psp
    ? [psp.area, psp.floor_plan, psp.rent_max ? `家賃${psp.rent_max}円以内` : null, psp.preferences].filter(Boolean).join(" ")
    : null;
  // 2026-09-10 Fable5 みく事例: few-shot は「今回の場面の文型」を引く検索なので message-local に寄せる。
  //   conversation-scope の repeated_concern / closing_strategy / winning_pattern は外す（NG 文の語彙供給源だった）。
  //   fetchKnowledge 側（方針検索）は conversation-scope のままでよい＝そちらは変更しない
  const brainContext = brainMeta ? [brainMeta.action, brainMeta.reply_direction, brainMeta.recommended_tone, brainMeta.customer_intent, brainMeta.latent_intent, brainMeta.customer_emotion, brainMeta.checkpoint_stage ? `フェーズ: ${brainMeta.checkpoint_stage}` : null, brainMeta.human_type_label ? `人物タイプ: ${brainMeta.human_type_label}` : null, brainMeta.purchase_signal_level ? `温度感: ${brainMeta.purchase_signal_level}` : null, brainMeta.engagement_stance ? `押し引き: ${brainMeta.engagement_stance}` : null, ...(brainMeta.key_topics ?? []), pspText].filter(Boolean).join(" ") : "";
  const lastAixPart = brainMeta?.last_aix_history ? `[AIX履歴] ${brainMeta.last_aix_history} ` : "";
  const lastStaffPart = lastStaffMessage ? `[前返信]${safeSlice(lastStaffMessage, 150)} ` : "";
  // brainContextをstate直後に固定（末尾配置だとsafeSlice 2000字制限で切り落とされるリスクがあるため前詰め）
  // fetchKnowledge（L1264）と同一パターンを適用
  const searchQuery = (customerMessage || lastStaffMessage)
    ? safeSlice(`${state}: ${brainContext ? `[WE_DO文脈]${brainContext} ` : ""}${lastAixPart}${lastStaffPart}[顧客]${customerMessage ?? ""} ${analysisContext ?? ""}`.trim(), 2000)
    : null;

  if (searchQuery && process.env.OPENAI_API_KEY) {
    const embedding = await generateEmbedding(searchQuery);
    if (embedding) {
      const { data: similar, error: rpcError } = await supabase.rpc("match_reply_examples", {
        query_embedding: embedding,
        // 2026-09-11 データ衛生: 生成失敗文・テスト送信を後段で除外する分（+4）を多めに取る
        match_count: (spec?.examples.pgvectorMatchCount ?? 20) + 4,
        filter_states: stateAliases,
      }) as { data: Array<{ customer_message: string; sent_reply: string; conversation_state: string; is_starred: boolean; reply_angle: string | null; customer_intent: string | null; similarity: number }> | null; error: unknown };

      if (!rpcError && similar && similar.length > 0) {
        // 類似度0.5未満は低品質として除外。生成失敗文・テスト送信は正解例にしない（isUsableExampleText）
        const aboveThreshold = similar.filter(ex => ex.similarity >= 0.5 && isUsableExampleText(ex.sent_reply));
        if (aboveThreshold.length > 0) {
        // ★+0.15 に加え、4案から選ばれた実例（reply_angle あり）は+0.1 追加ブースト
        // T1: spec.examples.boostStates（brainが重視するフェーズ）に一致する実例はさらに+0.1
        const boostStates = spec?.examples?.boostStates ?? [];
        const dirKwds = extractDirectionKeywords(spec?.examples?.filterByDirection ?? null);
        const brainIntent = brainMeta?.customer_intent ?? null;
        // S-3: customer_intent は message-local。stale（T2/cached）では intent ブーストを 0.2 → 0.05 に落とす
        const intentBoost = brainFresh ? 0.2 : 0.05;
        const ranked = [...aboveThreshold].sort((a, b) => {
          const scoreA = a.similarity + (a.is_starred ? 0.15 : 0) + (a.reply_angle ? 0.1 : 0) + (boostStates.includes(a.conversation_state) ? 0.1 : 0) + (dirKwds.some(k => (a.sent_reply ?? "").includes(k)) ? 0.05 : 0) + (brainIntent && a.customer_intent === brainIntent ? intentBoost : 0);
          const scoreB = b.similarity + (b.is_starred ? 0.15 : 0) + (b.reply_angle ? 0.1 : 0) + (boostStates.includes(b.conversation_state) ? 0.1 : 0) + (dirKwds.some(k => (b.sent_reply ?? "").includes(k)) ? 0.05 : 0) + (brainIntent && b.customer_intent === brainIntent ? intentBoost : 0);
          return scoreB - scoreA;
        });
        // T1: excludeReplyRe ポストフィルタ（floor付き: 残件が minKeep 未満ならフィルタ放棄＝フェイルオープン）
        const excludeRe = spec?.examples?.excludeReplyRe ?? null;
        const minKeep = spec?.examples?.minKeepAfterExclude ?? 3;
        // 2026-09-08: 現在の会話に前提（撮影約束・送付済み・日程確定）が無い語彙を含む実例を除外（premiseExcludeRe）
        const combinedExclude = (s: string) => (excludeRe?.test(s) ?? false) || (premiseExcludeRe?.test(s) ?? false);
        let kept = ranked;
        if (excludeRe || premiseExcludeRe) {
          const filtered = ranked.filter(ex => !combinedExclude(ex.sent_reply ?? ""));
          kept = filtered.length >= minKeep ? filtered : ranked;
        }
        const sorted = kept.slice(0, 8);

        return "\n\n【⭐ スモラの実際の返信例（状況が最も類似した実例・類似度順）" + EXAMPLES_HEADER_NOTE +
          sorted.map((ex, i) => {
            const angleTag = ex.reply_angle && ex.reply_angle !== "starred" ? `|${ANGLE_LABEL[ex.reply_angle] ?? ex.reply_angle}` : "";
            const premise = derivePremiseLabel(ex.sent_reply ?? "");
            // 2026-09-11 竹内方針4・5（E4-f）: 実例の「承知しました」「すぐに」は注入前に決定論で正規化（DB の本文は書き換えない）
            // 2026-09-12 竹内方針D: 曜日の誤りは日付を正として直す（RPC の戻りに created_at が無いので、食い違う曜日だけ外す）
            return `[例${i + 1}${ex.is_starred ? "⭐" : ""}${angleTag}]${premise ? `\n[前提] ${premise}` : ""}\nお客様: 「${ex.customer_message}」\nスモラ: 「${fixExampleWeekdays(normalizeBannedPhrasing(ex.sent_reply ?? "").text)}」`;
          }).join("\n\n");
        }
      }
    }
  }

  // フォールバック: 全件対象（☆優先・フェーズ一致優先）
  // ⑤ pgvector不発時のフォールバックでは embedding NULL の実例も対象にする
  // （pgvector経路ではRPC側でNULLが当然除外されるが、importance/☆降順のフォールバックで除外する理由はない。
  //   .not("embedding","is",null) を付けると embedding未生成の重要データが永久に参照されない）
  const [{ data: sameStateFull }, { data: allStateFull }] = await Promise.all([
    // 同フェーズ全件: ☆降順 → 新着順
    supabase.from("ai_reply_examples").select("customer_message, sent_reply, conversation_state, is_starred, reply_angle, created_at")
      .in("conversation_state", stateAliases)
      .eq("entry_source", "line_reply")
      .order("is_starred", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(60),
    // 全フェーズ全件: ☆降順 → 新着順
    supabase.from("ai_reply_examples").select("customer_message, sent_reply, conversation_state, is_starred, reply_angle, created_at")
      .eq("entry_source", "line_reply")
      .order("is_starred", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(120),
  ]);

  // 2026-09-11 データ衛生: ☆付きの生成失敗文（hearing の最新☆）がフォールバックの先頭に来ていた → 読む側で除外
  const sameStateList = (sameStateFull ?? []).filter((ex) => isUsableExampleText(ex.sent_reply));
  const allStateList = (allStateFull ?? []).filter(
    (ex) => isUsableExampleText(ex.sent_reply) && !sameStateList.some((s) => s.sent_reply === ex.sent_reply)
  );

  // T1: boostStates（brainが重視するフェーズ）一致を同priority・同☆内の優先基準に追加
  const boostStatesFb = spec?.examples?.boostStates ?? [];
  let fallbackRanked = [
    ...sameStateList.slice(0, 6).map((ex) => ({ ...ex, priority: 1 })),
    ...allStateList.slice(0, 4).map((ex) => ({ ...ex, priority: 2 })),
  ].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.is_starred !== b.is_starred) return a.is_starred ? -1 : 1;
    const aBoost = boostStatesFb.includes(a.conversation_state) ? 1 : 0;
    const bBoost = boostStatesFb.includes(b.conversation_state) ? 1 : 0;
    return bBoost - aBoost;
  });

  // T1: customerMsgKeywords 安定ソートブースト（キーワード一致例を先頭へ・非一致例は捨てない）
  const kwds = spec?.examples?.customerMsgKeywords ?? [];
  if (kwds.length > 0) {
    fallbackRanked = [...fallbackRanked].sort((a, b) => {
      const aHit = kwds.some(k => (a.customer_message ?? "").includes(k)) ? 1 : 0;
      const bHit = kwds.some(k => (b.customer_message ?? "").includes(k)) ? 1 : 0;
      return bHit - aHit; // Array.prototype.sort は安定ソート＝非一致同士の既存順序は保持される
    });
  }

  // filterByDirection: 方向性キーワードが sent_reply に含まれる例を安定ブースト（fail-open: 一致ゼロでもリスト捨てない）
  const dirKwdsFb = extractDirectionKeywords(spec?.examples?.filterByDirection ?? null);
  if (dirKwdsFb.length > 0) {
    fallbackRanked = [...fallbackRanked].sort((a, b) => {
      const aHit = dirKwdsFb.some(k => (a.sent_reply ?? "").includes(k)) ? 1 : 0;
      const bHit = dirKwdsFb.some(k => (b.sent_reply ?? "").includes(k)) ? 1 : 0;
      return bHit - aHit;
    });
  }

  // T1: excludeReplyRe ポストフィルタ（floor付き: 残件が minKeep 未満ならフィルタ放棄＝フェイルオープン）
  const excludeReFb = spec?.examples?.excludeReplyRe ?? null;
  const minKeepFb = spec?.examples?.minKeepAfterExclude ?? 3;
  // 2026-09-08: 前提フィルタ（premiseExcludeRe）をフォールバック経路にも適用
  if (excludeReFb || premiseExcludeRe) {
    const filtered = fallbackRanked.filter(ex => !((excludeReFb?.test(ex.sent_reply ?? "") ?? false) || (premiseExcludeRe?.test(ex.sent_reply ?? "") ?? false)));
    if (filtered.length >= minKeepFb) fallbackRanked = filtered;
  }

  const all = fallbackRanked.slice(0, 8);

  if (all.length === 0) return "";

  return "\n\n【⭐ スモラの実際の返信例（☆をつけた良質な実例）" + EXAMPLES_HEADER_NOTE +
    all.map((ex, i) => {
      const ra = (ex as { reply_angle?: string | null }).reply_angle;
      const angleTag = ra && ra !== "starred" ? `|${ANGLE_LABEL[ra] ?? ra}` : "";
      const premise = derivePremiseLabel(ex.sent_reply ?? "");
      // 2026-09-11 竹内方針4・5: 注入前に承知→かしこまりました・すぐに除去（DB の本文は書き換えない）
      // 2026-09-12 竹内方針D: 曜日の誤りは書いた日（created_at）の暦で、日付を正として直す
      return `[例${i + 1}${angleTag}]${premise ? `\n[前提] ${premise}` : ""}\nお客様: 「${ex.customer_message}」\nスモラ: 「${fixExampleWeekdays(normalizeBannedPhrasing(ex.sent_reply ?? "").text, ex.created_at)}」`;
    }).join("\n\n");
}

// ─── 2026-09-11 竹内方針3: 旧 extractPreferredName（1行目の行頭しか見ない・カタカナ「サン」を敬称に含む）は廃止。
//     呼び名は validate-reply.ts の resolveAddressName が唯一の決定（下の「顧客名の確定」）

// ─── 顧客名のDB取得（fetchDbCustomerNames）は 2026-09-12 竹内方針C で app/lib/address-name-server.ts へ移設（check-reply と共用）

// ─── パターンA: 引用リプライの引用先メッセージ取得（quoted_message_id → line_message_id JOIN）──
// お客様の最新メッセージに quoted_message_id があれば、引用先メッセージを特定して
// 「このメッセージは○○への返信です」というコンテキストをプロンプトに注入する。
// ※ 現在はデータが貯まり始めた段階（webhook保存 + page.tsx line_message_id 書き戻しは実装済み）。
//   引用先が見つからない場合は空文字を返して通常生成にフォールバックする。
async function fetchQuotedContext(conversationId: string): Promise<string> {
  try {
    const { data: lastCustomerMsg } = await supabase
      .from("messages")
      .select("quoted_message_id, text")
      .eq("conversation_id", conversationId)
      .eq("sender", "customer")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const quotedId = (lastCustomerMsg as { quoted_message_id?: string | null } | null)?.quoted_message_id;
    if (!quotedId) return "";

    const { data: quoted } = await supabase
      .from("messages")
      .select("sender, text, image_url")
      .eq("line_message_id", quotedId)
      .maybeSingle();
    if (!quoted) return "";

    const q = quoted as { sender?: string; text?: string | null; image_url?: string | null };
    const senderLabel = q.sender === "staff" ? "スモラ（スタッフ）" : "お客様自身";
    const isImage = !q.text || q.text === "[画像]" || q.text === "[動画]";
    const contentDesc = isImage
      ? "【画像（スタッフ送付なら物件カード・物件資料の可能性が高い）】"
      : `「${safeSlice(String(q.text), 600)}」`;
    // お客様がリンク（URL）そのものを求めているか判定
    const custText = String((lastCustomerMsg as { text?: string | null } | null)?.text ?? "");
    const isLinkRequest = /(リンク|url|ＵＲＬ)\s*(を|の|教え|くださ|ちょうだい|ください|欲し|ほし|送|ちょーだい)?/i.test(custText)
      || /(この|こちらの|その|これの)(部屋|物件|お部屋).{0,6}(リンク|url|ＵＲＬ)/i.test(custText);
    // 写真・画像・動画要求（「URL」という語を含まない要求）も同じゲートで検出する
    const isPhotoRequest = /((室内|内装|間取り|物件)?(写真|画像|動画|フォト))\s*(を|が|は)?\s*(送って|見たい|ありますか|ください|欲しい|URL|url|リンク|見せて|もらえ|拝見)/.test(custText);
    const linkRequestNote = ((isLinkRequest || isPhotoRequest) && q.sender === "staff")
      ? `
【🔗 リンク（URL）要求検出（最優先）】お客様はURLを求めていますが、URLの送付はAIXツール（物件ピックアップした）がスタッフ操作で行います。
【絶対禁止】返信文に「〜のURLとなります」「URLをお送りします」「リンクをご案内します」等、URLを送る・案内するような文言を一切書かない。
→ 返信文は受付・確認の一言のみ：「確認させて頂きます😊！！」「しばらくお待ちください！！」程度にとどめる（「少々お待ちください」はfinal-check禁止語のため絶対に使わない）。
→ 物件名・号室は書かない（「お送り頂きました物件」で受ける。URLも書かない。2026-09-11 竹内方針2）。
→ 「気になる物件のURLをお送りください」の聞き返しは絶対禁止。`
      : "";
    // 2026-09-08: 見積例文は顧客が費用を質問／特定物件を参照している時のみ出す（引用画像だけで見積宣言を誘導しない）
    const quoteEstimateAllowed = CUSTOMER_ESTIMATE_INTENT_RE.test(custText) || CUSTOMER_PROPERTY_REF_RE.test(custText);
    const imageNameSuppressNote = isImage
      ? `
引用した画像がどの物件かはスタッフにしか判断できないため、返信文に物件名・マンション名は絶対に含めないこと（${quoteEstimateAllowed ? "「最大限割引した初期費用の御見積書をご用意します！！」" : "「お送り頂きましたお部屋の募集状況確認させて頂きます！！」"}のように物件名なしで返す${quoteEstimateAllowed ? "" : "。お客様が費用を質問していないため見積書の宣言は書かない"}）。`
      : "";
    return `
【💬 引用リプライ検出（確定事実・最優先文脈）】
お客様の最新メッセージは、${senderLabel}が送ったメッセージ ${contentDesc} への引用（リプライ）です。
お客様は引用先の内容について話している。引用先が物件画像・物件名・物件URLの場合、
その物件への興味として扱い、「気になる物件のURLをお送りください」等の聞き返しは絶対にせず、その物件を前提に返信を生成すること。
ただし内覧日程調整・空室確認の方向で返信するのは、当該物件が退去予定・入居中でない場合に限る。
退去予定・入居中の物件の場合は、現地内覧日程は提案せず「退去日以降のご案内」または「お申込みでお部屋を先に押さえてからのご内覧」を案内すること。${linkRequestNote}${imageNameSuppressNote}`;
  } catch (err) {
    // quoted_message_id カラム未作成環境・クエリ失敗時は通常生成にフォールバック
    console.warn("[generate-reply] 引用コンテキスト取得失敗 — 通常生成で続行:", err);
    return "";
  }
}

// ─── conversationId → ai_summary_json 取得（regex往復の廃止・構造化サマリー直接参照）──
// クライアントが summaryJson を渡さない場合のフォールバック。
// conversations.property_customer_id 経由で property_customers.ai_summary_json を引く
async function fetchSummaryJsonByConversation(conversationId: string): Promise<ReplySummaryJson | null> {
  try {
    const { data: conv } = await supabase
      .from("conversations")
      .select("property_customer_id")
      .eq("id", conversationId)
      .single();
    const pcId = (conv as { property_customer_id?: string | null } | null)?.property_customer_id;
    if (!pcId) return null;
    const { data: pc } = await supabase
      .from("property_customers")
      .select("ai_summary_json")
      .eq("id", pcId)
      .single();
    return ((pc as { ai_summary_json?: ReplySummaryJson | null } | null)?.ai_summary_json) ?? null;
  } catch (err) {
    console.warn("[generate-reply] ai_summary_json取得失敗 — テキストregexフォールバックで続行:", err);
    return null;
  }
}

// ─── テンプレート最適化モード用: DB学習ルール取得 ─────────────────────────────
// 旧 /api/templates/adapt が読んでいた2つのDB注入を引き継ぐ（学習資産を失わない）。
// ① ai_prompts key='template_adapt_rules'（テンプレ最適化の追加ルール）
async function fetchTemplateAdaptRules(): Promise<string> {
  try {
    const { data } = await supabase
      .from("ai_prompts")
      .select("content")
      .eq("key", "template_adapt_rules")
      .single();
    return (data as { content?: string } | null)?.content ?? "";
  } catch (err) {
    console.error("[generate-reply] template_adapt_rules取得失敗 — ルールなしで続行:", err);
    return "";
  }
}

// ② adaptation_improvement_rules（スタッフの最適化後修正から自動学習したカテゴリ別ルール・上位5件）
async function fetchCategoryAdaptationRules(templateCategory: string): Promise<string> {
  try {
    const { data } = await supabase
      .from("adaptation_improvement_rules")
      .select("rule_text, confidence, example_count")
      .eq("category", templateCategory)
      .eq("is_active", true)
      .order("example_count", { ascending: false })
      .order("confidence", { ascending: false })
      .limit(5);
    if (!data || data.length === 0) return "";
    const rules = data as Array<{ rule_text: string; example_count: number }>;
    return `【📚 このテンプレカテゴリで学習した改善ルール — 必ず守ること】
過去にスタッフがAI最適化後に繰り返し修正したパターンです。次回は最初からこのように生成してください。
${rules.map((r, i) => `${i + 1}. ${r.rule_text}（${r.example_count}回確認済み）`).join("\n")}`;
  } catch (err) {
    console.error("[generate-reply] adaptation_improvement_rules取得失敗 — ルールなしで続行:", err);
    return "";
  }
}

// ─── reply_mode ゲート（自動生成経路のみ・enforceReplyModeGate=true時に発火）───
// brain-core が conversations.suggested_aix_meta.reply_mode="aix" を書いた会話は
// AI自動返信禁止。ドラフト生成を中止し、スタッフにLINEグループ通知する。
// H7(Fable5): closing_strategy / next_steps も読む — brain の戦略をドラフト生成プロンプトへ注入し、
// スタッフ向け表示（赤枠）と顧客向けドラフトの戦略を一致させる
// Step1廃止（2026-08）: 型は brain-core の SuggestedAixMeta を共有（二重定義禁止）。
// message-local 戦術フィールド（customer_questions〜future_timeline）と鮮度ゲート基準
// analyzed_msg_ts もこの型経由で generate-reply に届く。
type AixGateMeta = SuggestedAixMeta;

async function fetchReplyModeGate(
  convId: string
): Promise<{ meta: AixGateMeta; lastMeta: Record<string, unknown> | null; customerName: string; conversationDirection: Record<string, unknown> | null; brainAnalyzedAt: string | null } | null> {
  const { data, error: modeErr } = await supabase
    .from("conversations")
    // 2026-09-10 Fable5 Sさん事例: last_brain_meta を T3（suggested_aix_meta=null）の第2ソースにする。
    //   ⚠ 列名は実在するもののみ（status はあるが state は無い／last_brain_meta はあるが brain_meta は無い）。
    //   存在しない列を select するとエラーで全行が返らず静かに0件になる。
    .select("suggested_aix_meta, last_brain_meta, customer_name, conversation_direction, brain_analyzed_at")
    .eq("id", convId)
    .single();
  if (modeErr && modeErr.code !== "PGRST116") {
    // PGRST116（行なし）は従来どおり「ゲート情報なし」= null 扱い。
    // それ以外のDB障害は fail-close: null を返すと AIX専用顧客(reply_mode="aix")へ
    // 自動ドラフトが素通りするため、例外を投げて呼び出し元（POST の try）で
    // draft_pending_at クリア + 500 返却させる（毎分cronの永久リトライも防止）。
    console.error("[gen-reply] reply_mode gate error:", modeErr.message);
    throw new Error("gate_unavailable");
  }
  if (!data) return null;
  return {
    meta: (data.suggested_aix_meta ?? null) as AixGateMeta,
    lastMeta: (data.last_brain_meta ?? null) as Record<string, unknown> | null,
    customerName: (data.customer_name as string) || "",
    conversationDirection: (data.conversation_direction ?? null) as Record<string, unknown> | null,
    brainAnalyzedAt: (data.brain_analyzed_at as string | null) ?? null,
  };
}

async function applyAixGateAndRespond(
  convId: string,
  meta: NonNullable<AixGateMeta>,
  customerName: string
): Promise<Response> {
  // ai_draft IS NULL の場合のみ sentinel 保存（人間編集中は触らない）。
  // .is("ai_draft", null) のアトミッククレームが通知の重複防止を兼ねる
  // （bg-async と cron が同時に来ても通知は1回だけ）。
  // draft_pending_at=null で cron の永久再試行も止まる。
  const { data: claimed, error: claimErr } = await supabase
    .from("conversations")
    .update({ ai_draft: "[AIX誘導中]", draft_pending_at: null, draft_attempted_at: null })
    .eq("id", convId)
    .is("ai_draft", null)
    .select("id");

  // DB障害時: sentinel未設定・pending未クリア・スタッフ通知スキップが黙って起きるため、
  // ログに残しレスポンスに degraded フラグを付けて呼び出し元に伝える
  // （cron が次回リトライで再度ゲートに到達するため処理自体は継続可能）。
  const degraded = Boolean(claimErr);
  if (claimErr) {
    console.error("[generate-reply] aix-gate claim update error:", convId, claimErr.message);
  }

  // 2026-09-12 竹内方針: 売上番長グループへの AIX 指示は「AIX要対応」（brain-core runBrainAndNotify → aix-action-items）に一本化。
  //   旧: ここでも「🔥/🟡 〇〇さん｜ラベル」を通知しており、ブレインの required 通知と二重になっていた → 通知は出さない
  void customerName;

  // ストリーミング呼び出し元のメタ行プロトコル互換（1行JSON+改行）
  return new Response(
    JSON.stringify({
      ok: false,
      reason: "aix_required",
      degraded,
      aix: { action: meta.action ?? null, note: meta.note ?? null },
    }) + "\n",
    { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
  );
}

// ─── POST ────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  }

  type RecentMessage = { sender: string; text: string; imageUrl?: string; createdAt?: string; isAix?: boolean };
  let message: string, state: string, customerName: string, recentMessages: RecentMessage[], customerConditions: string, customerSummary: string, replyHint: string;
  // 呼び出し元から渡された生の名前（多くの経路で LINE表示名そのもの）。
  // 生成には使わず、生成後クリーニングで「本文に混入した表示名」を検出・除去するために保持する。
  let lineDisplayName = "";
  let screenshotBase64: string | undefined, screenshotMediaType: string | undefined;
  let viewingNote = "";
  let customerStructured: CustomerStructured | undefined;
  let bodySummaryJson: ReplySummaryJson | undefined;
  let propertyStatus: PropertyStatus | undefined;
  // conversationId が渡された場合のみ、成功時に ai_draft 保存 + draft_pending_at クリア、
  // 失敗時にも draft_pending_at をクリアする（毎分Cronが永遠に再試行する永続pendingバグの防止）
  let conversationId = "";
  // includeStopReason=true（generate-pending-drafts の品質ゲート用）の場合のみ、
  // 本文の後に <<<STOP_REASON:xxx>>> トレーラーを付加する（UIからの通常呼び出しには影響しない）
  let includeStopReason = false;
  // reply_modeゲート: 自動生成経路（bg-async/cron/generate-draft-bg）のみtrueが渡される。
  // brain(suggested_aix_meta.reply_mode)が"aix"なら自動ドラフト生成を中止する
  let enforceReplyModeGate = false;
  // brain直列アーキテクチャ(2026-08): bg-asyncが直前に brain を直列実行した結果を直接渡してくる。
  // 指定時は fetchReplyModeGate の DB フェッチ（チェックポイントA/B・戦略注入）をスキップして
  // この値をそのまま使う。未指定（null）時は従来どおり DB フェッチ（後方互換）。
  // 注意: 呼び出し時点のスナップショットなので、鮮度は呼び出し元が保証すること
  // （bg-asyncは自分で書いた直後の値を渡すため問題なし）
  let externalBrainGate: {
    meta: AixGateMeta;
    /** 2026-09-10 Fable5: T3（meta=null）時の会話スコープ方針の第2ソース。bg-async 直列経路では常に null */
    lastMeta: Record<string, unknown> | null;
    customerName: string;
    conversationDirection: Record<string, unknown> | null;
    brainAnalyzedAt: string | null;
  } | null = null;
  // アクティブタスク（body指定 or DB自動補完）。property_check中の返信ガード等に使用
  let activeTaskTypes: string[] = [];
  // ─── テンプレート最適化モード（templateText 指定で有効化）───
  // 「AIで最適化」ボタン: generate-reply の品質パイプライン（brain戦略注入 + 全プロンプトスタック +
  // ハードゲート + validateAndClean）をそのまま使い、テンプレを骨格として書き直す
  let templateText = "";
  let templateCategory = "";
  let templateLabel = "";
  let templateFocusPoints: string[] = [];
  let noEmoji = false;
  let soloEntry = false;
  let pendingScheduledMessages: Array<{ text: string | null }> = [];
  let vacatingDate: VacatingDate = null;
  let staffMessagedToday = false;
  let aixSourceMessage = ""; // AIXカテゴリ最適化: AIXが送信したテキストをベースに改善（設定時はAIX最適化モード）
  // S-4: 呼び出し元が DB から算出した「スタッフのテキスト返信が1件でもあるか」（履歴窓20件外の初回判定ズレ防止）。未渡し=undefined
  let hasStaffRepliedFromBody: boolean | undefined;
  // 2026-09-09 Fable5: 通単位の配列（page.tsx / bg-async / bg が MSG_SEP 結合と併せて送る）。未渡しなら MSG_SEP で分割
  let customerMessagesBody: string[] = [];
  try {
    const body = await req.json() as {
      message: string;
      customerMessages?: string[];
      state: string;
      customerName?: string;
      recentMessages?: RecentMessage[];
      customerConditions?: string;
      customerSummary?: string;
      summaryJson?: ReplySummaryJson;
      customerStructured?: CustomerStructured;
      replyHint?: string;
      viewingNote?: string;
      screenshotBase64?: string;
      screenshotMediaType?: string;
      activeTaskTypes?: string[];
      conversationId?: string;
      // reply_modeゲート: 自動生成経路（bg-async/cron/generate-draft-bg）のみtrueを渡す。
      // brain(suggested_aix_meta.reply_mode)が"aix"なら自動ドラフト生成を中止する
      enforceReplyModeGate?: boolean;
      // brain直列実行の結果（conversations.suggested_aix_meta と同形）。bg-asyncのみ渡す。
      // 指定時は fetchReplyModeGate の DB フェッチをスキップしてこの値を使う
      brainMetaDirect?: {
        meta: AixGateMeta;
        customerName?: string;
        conversationDirection?: Record<string, unknown> | null;
        brainAnalyzedAt?: string | null;
      } | null;
      includeStopReason?: boolean;
      propertyStatus?: PropertyStatus;
      // ─── テンプレート最適化モード用フィールド ───
      templateText?: string;        // 指定するとテンプレート最適化モードが有効になる
      templateCategory?: string;    // adaptation_improvement_rules のカテゴリ別学習ルール取得に使用
      templateLabel?: string;       // テンプレート名（プロンプト参考情報）
      templateFocusPoints?: string[]; // 訴求ポイント: ["家賃","初期費用","部屋の条件"]
      conditions?: string[];        // templateFocusPoints の別名（選択チップ配列）
      noEmoji?: boolean;
      soloEntry?: boolean;
      pendingScheduledMessages?: Array<{ text: string | null }>;
      vacatingDate?: { month: number; day: number } | null;
      staffMessagedToday?: boolean;
      aixSourceMessage?: string;    // AIXカテゴリ最適化: AIXが送信したテキストを渡す（設定時は会話全体ではなくこのテキストを改善）
      // S-4: messages count where sender=staff and text not media-only（呼び出し元が DB で算出。初回判定の履歴窓外落ち防止）
      hasStaffReplied?: boolean;
    };
    message = body.message;
    customerMessagesBody = Array.isArray(body.customerMessages)
      ? body.customerMessages.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
    state = body.state;
    conversationId = body.conversationId || "";
    includeStopReason = body.includeStopReason === true;
    enforceReplyModeGate = body.enforceReplyModeGate === true;
    lineDisplayName = (body.customerName || "").trim();
    recentMessages = body.recentMessages || [];
    // 2026-09-11 竹内方針3: 呼び名は下の「顧客名の確定」で resolveAddressName が1回だけ決める（旧 extractPreferredName は廃止）
    customerName = "";
    customerConditions = body.customerConditions || "";
    customerSummary = body.customerSummary || "";
    bodySummaryJson = body.summaryJson;
    customerStructured = body.customerStructured;
    replyHint = body.replyHint || "";
    activeTaskTypes = body.activeTaskTypes ?? [];
    screenshotBase64 = body.screenshotBase64;
    screenshotMediaType = body.screenshotMediaType;
    viewingNote = body.viewingNote || "";
    propertyStatus = body.propertyStatus;
    // テンプレート最適化モードのフィールド
    templateText = body.templateText || "";
    templateCategory = body.templateCategory || "";
    templateLabel = body.templateLabel || "";
    templateFocusPoints = (body.templateFocusPoints ?? body.conditions ?? []).filter(
      (p): p is string => typeof p === "string" && p.length > 0
    );
    noEmoji = body.noEmoji === true;
    soloEntry = body.soloEntry === true;
    pendingScheduledMessages = (body.pendingScheduledMessages ?? []).filter(
      (m) => m && typeof m.text === "string" && m.text.length > 0
    );
    vacatingDate = body.vacatingDate ?? null;
    staffMessagedToday = body.staffMessagedToday === true;
    aixSourceMessage = body.aixSourceMessage || "";
    hasStaffRepliedFromBody = typeof body.hasStaffReplied === "boolean" ? body.hasStaffReplied : undefined;
    externalBrainGate = body.brainMetaDirect
      ? {
          meta: body.brainMetaDirect.meta ?? null,
          lastMeta: null,   // bg-async 直列経路は直前に書いた meta を渡すので第2ソースは不要
          customerName: body.brainMetaDirect.customerName ?? "",
          conversationDirection: body.brainMetaDirect.conversationDirection ?? null,
          brainAnalyzedAt: body.brainMetaDirect.brainAnalyzedAt ?? null,
        }
      : null;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  const isTemplateOptimize = templateText.length > 0;

  // 空メッセージは Vision 呼び出しより前に弾く（無駄な API 課金・待ち時間の防止）
  // テンプレート最適化モードのみ例外: テンプレ送信はスタッフ発信の続きで行われることが多く、
  // お客様の新着メッセージが無いケースが正当。履歴の最後のお客様発言、無ければ合成文脈で代替する
  if (!message) {
    if (isTemplateOptimize) {
      const lastCustomerText = [...recentMessages].reverse().find(
        (m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]"
      )?.text;
      message = lastCustomerText || "（お客様の新着メッセージなし・テンプレート送信の文脈）";
    } else {
      return NextResponse.json({ ok: false, error: "message required" }, { status: 400 });
    }
  }

  // 孤立サロゲート（LINE絵文字等）をU+FFFDに置換してAnthropicへのHTTP 400を防止
  const _sanitizeSurrogates = (s: string) =>
    s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
  message = _sanitizeSurrogates(message);
  recentMessages = recentMessages.map(m => ({ ...m, text: _sanitizeSurrogates(m.text) }));
  aixSourceMessage = _sanitizeSurrogates(aixSourceMessage);
  // A-1: LINE sentinel「[スタンプ]」行を除去してから TPO 判定に回す（スタンプ単独は装飾のみ＝短い了承扱い）。
  //      全行スタンプなら「[スタンプ]」1行を残す（空メッセージ扱いにならないよう TPO_NEUTRAL_ACK_RE / DECOR 判定側で吸収）
  if (!isTemplateOptimize && STAMP_LINE_RE.test(message)) {
    const stripped = message.split("\n").filter((l) => !STAMP_LINE_RE.test(l)).join("\n").trim();
    message = stripped || "😊";
  }
  // A-16: Vision抽出テキスト（「[画像] 」始まり）はスクショ内容としてラベル付け＋端末ステータス等のノイズ除去
  if (!isTemplateOptimize && /^\[画像\] /.test(message)) {
    message = "【スクショ内容】" + message
      .replace(/^\[画像\] /, "")
      .replace(/\d{1,2}:\d{2}\s*(?:5G|4G|LTE)?|1分で完了[^\n]*|お問い合わせ\(無料\)/g, "")
      .trim();
  }

  // テンプレート最適化モード: 旧adaptルートで実績のある前処理をプロンプト組み立て前に適用
  // （退去予定日/内覧可能日の◯月◯日置換 + 挨拶差し替え。共有lib: app/lib/template-preprocess.ts）
  let preprocessedTemplate = "";
  if (isTemplateOptimize) {
    preprocessedTemplate = applyVacatingDateToTemplate(_sanitizeSurrogates(templateText), vacatingDate);
    preprocessedTemplate = applyGreetingSwap(preprocessedTemplate, staffMessagedToday);
  }

  // 初回例外（first_reply exemption）: 真の初回（スタッフの非AIXテキスト返信ゼロ）は
  // reply_mode ゲートをスキップして初回挨拶ドラフト生成を優先する。
  // SUGGESTED_AIX トレーラーの first_reply 例外（初回対応フェーズはAIX誘導不要）と同じ設計意図をゲートにも適用。
  const isFirstReplyGateExempt =
    normalizeState(state || "first_reply") === "first_reply" &&
    !recentMessages.some(
      m => m.sender === "staff" && !m.isAix && m.text && m.text !== "[画像]" && m.text !== "[動画]"
    );

  // ─── メイン try（fail-close 境界）───
  // reply_mode ゲート（チェックポイントA）〜 ai_prompts 取得までの前処理ゾーンも try に含める。
  // ここで例外が起きると従来は draft_pending_at 未クリアの 500 となり毎分cronが永久リトライしていた。
  // catch（本関数末尾）が draft_pending_at クリア + 500 返却を行う。
  // fetchReplyModeGate の DB障害（gate_unavailable throw）もここで fail-close される。
  try {
  // ─── reply_modeゲート チェックポイントA ───
  // meta が既に "aix" ならAnthropic呼び出し前にゼロコストで中止（cron再試行時など）。
  // null（未分析/webhookワイプ直後）はここでは素通しし、チェックポイントBで再確認する。
  // brainMetaDirect 指定時（bg-asyncのbrain直列実行後）は DB フェッチせずその値を使う
  // enforceReplyModeGate=false（手動ボタン）はゲートをスキップ。bg-async/cronのみtrueを渡す設計。
  // 重複フェッチ解消(2026-08): チェックポイントAで取得した gate を後段の brainGate 構築で再利用する
  // （AとbrainGate構築の間に suggested_aix_meta への書き込みは無いためスナップショット再利用は安全。
  //   チェックポイントBの新鮮フェッチは意図的な設計のため対象外）
  let gateFromCheckpointA: Awaited<ReturnType<typeof fetchReplyModeGate>> = null;
  if (enforceReplyModeGate && conversationId && !isTemplateOptimize && !isFirstReplyGateExempt) {
    const gate = externalBrainGate ?? await fetchReplyModeGate(conversationId);
    gateFromCheckpointA = gate;
    if (gate?.meta?.reply_mode === "aix") {
      console.log("[generate-reply] reply_mode=aix → 自動ドラフト中止(A):", conversationId);
      return applyAixGateAndRespond(conversationId, gate.meta, gate.customerName);
    }
  }

  // ─── post_apply / skip_status ガード（手動呼び出しのみ）───
  // is_post_apply=true または DRAFT_SKIP_STATUSES のステータスの会話に対してスタッフが手動で
  // AI生成を実行した場合、draft生成をスキップする。
  // brainMetaDirect 経由（bg-async の brain直列実行後）はすでに bg-async 側でチェック済みのため
  // externalBrainGate !== null の場合はスキップ不要。
  if (conversationId && externalBrainGate === null && !isTemplateOptimize) {
    const { data: convMeta } = await supabase
      .from("conversations")
      .select("is_post_apply, status")
      .eq("id", conversationId)
      .single();
    if (convMeta && (convMeta.is_post_apply || DRAFT_SKIP_STATUSES.has((convMeta.status as string) ?? ""))) {
      console.log("[generate-reply] post_apply or skip_status → ドラフト生成スキップ:", {
        conversationId,
        is_post_apply: convMeta.is_post_apply,
        status: convMeta.status,
      });
      return NextResponse.json({ skipped: true, reason: "post_apply_or_skip_status" });
    }
  }

  // ─── 顧客名の確定（2026-09-11 竹内方針3: 実際に呼んでいる名前のまま・途中で変えない）────────────────
  //   resolveAddressName が唯一の決定（validate-reply.ts）。優先: ①直近スタッフ送信（人間・AIX）の行頭の呼びかけ ②強いつながり
  //   （〇〇さんにオススメ／ご希望）③スタッフの呼び履歴が無い時だけ顧客の名乗り ④DB property_customers ⑤表示名 ⑥""（名前を出さない）。
  //   旧実装は extractPreferredName（1行目しか見ない・カタカナ「サン」で AIX カードの「ネッサンス」から「ネッ」を抽出）→ 表示名 → DB の順で、
  //   page 経路と bg 経路で呼び名が変わっていた（見木: page=響夢／bg=見木）。page / bg どちらでも DB 名を常に引いて1回だけ決める
  //   2026-09-12 竹内方針C: 人間スタッフの呼び名を AIX より優先し、名前の開示（名乗り・申込フォーマット・本人確認書類）の直後の一時切替に
  //   追従しない（元の名前の固定）。DB名・履歴150件（顧客発言・is_aix_generated 込み）の取得は check-reply と同じ関数で行う
  let addressName: AddressNameVerdict = { name: "", source: "none", evidence: "", at: null, aliases: [] };
  {
    let pcName = "", convName = "";
    try {
      const r = await resolveAddressNameForConversation(conversationId, recentMessages, lineDisplayName);
      ({ pcName, convName } = r);
      addressName = { name: r.name, source: r.source, evidence: r.evidence, at: r.at, aliases: r.aliases };
    } catch (e) {
      console.warn("[generate-reply] 呼び名の決定に失敗（窓内の結果で続行）:", e instanceof Error ? e.message : e);
      addressName = resolveAddressName({ messages: recentMessages, displayName: lineDisplayName });
    }
    customerName = addressName.name;
    if (!customerName) {
      console.warn("[generate-reply] 実名として使える呼び名なし（名前なしで生成）:", { conversationId, lineDisplayName, pcName, convName });
    }
  }
  // S-5: 顧客自身が書いた「〇〇様／〇〇さん」（連名者・保証人・家族等）は NAME_MISMATCH の除外リストに入れる
  const allowNamesForCheck: string[] = (() => {
    const out = new Set<string>();
    for (const m of recentMessages) {
      if (m.sender !== "customer" || !m.text) continue;
      for (const mm of m.text.matchAll(/([一-鿿々]{1,4}|[ぁ-んゝゞ]{2,6}|[ァ-ヴヽヾー]{2,6})\s*(?:様|さま|さん)/g)) {
        const n = normalizeCustomerName(mm[1]);
        if (n) out.add(n);
      }
    }
    return [...out].slice(0, 8);
  })();

  // activeTaskTypes の自動補完（Cron等で body.activeTaskTypes が渡されない場合のサーバー側フォールバック）
  // line_tasks から進行中（status=pending）のタスクを検出して補完する。
  // これにより generate-pending-drafts 等がタスク情報を渡し忘れても property_check ガードが効く。
  if (activeTaskTypes.length === 0 && conversationId) {
    try {
      const { data: dbActiveTasks } = await supabase
        .from("line_tasks")
        .select("task_type")
        .eq("conversation_id", conversationId)
        .eq("status", "pending");
      if (dbActiveTasks && dbActiveTasks.length > 0) {
        activeTaskTypes = dbActiveTasks.map((t: { task_type: string }) => t.task_type);
      }
    } catch (err) {
      // DB検出失敗時はガードなしで通常生成を続行（生成自体を止めない）
      console.error("[generate-reply] activeTaskTypes DB補完失敗:", err);
    }
  }
  // 2026-09-09 Fable5 行動台帳用: pending＋completed・直近30日・20件（activeTaskTypes は従来通り pending のみ）。fail-open
  let ledgerTasks: LedgerTask[] = [];
  if (conversationId && !isTemplateOptimize) {
    try {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data } = await supabase
        .from("line_tasks")
        // 2026-09-10 Fable5 Sさん事例: result（確認結果）が NULL の completed は「AIX 送信で機械的に閉じられただけ」で
        //   顧客に報告していない。台帳が confirmation_reported を立てるかの判定に必須の列
        .select("task_type, status, created_at, completed_at, result")
        .eq("conversation_id", conversationId)
        .in("status", ["pending", "completed"])
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(20);
      ledgerTasks = (data ?? []) as LedgerTask[];
    } catch (err) { console.error("[generate-reply] ledger line_tasks 取得失敗:", err); }
  }
  // アクティブタスク状態をreplyHintに反映（動的コンテキスト注入）
  if (activeTaskTypes.includes("property_check")) {
    replyHint = "【募集状況確認中★最重要】現在スタッフが物件の募集状況を確認している最中です。内覧日程・物件提案・見積書の話は絶対にしない。お客様の短い返信（「すいません」「ありがとう」「わかりました」等）には「大丈夫ですよ！！募集状況確認出来次第ご連絡させて頂きます😊！！」のような短い返しのみ行う（確認対象「募集状況」を必ず書く。「すぐに」禁止）。（この指示は property_check タスクがアクティブな場合のみ適用。スタッフが物件送付済みでお客様が受取確認しているだけの場合は対象外）"
      + (replyHint ? "\n" + replyHint : "");
  }

  // スクショがある場合: Sonnet Vision でトーク内容を抽出して replyHint に注入
  if (screenshotBase64) {
    try {
      const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").replace(/\s/g, "");
      const visionRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 1500,
          thinking: { type: "disabled" },
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: (screenshotMediaType ?? "image/jpeg") as "image/jpeg" | "image/png" | "image/webp", data: screenshotBase64 } },
              { type: "text", text: `このLINEトークのスクリーンショットから会話内容を書き出してください。
「お客様: 〇〇」「スタッフ: 〇〇」の形式で時系列順に全て書き出す。
読み取れない場合は「読み取れませんでした」のみ返す。余計な説明不要。` },
            ],
          }],
        }),
      });
      if (visionRes.ok) {
        const visionData = await visionRes.json() as { content?: Array<{ type: string; text?: string }>; stop_reason?: string };
        warnIfTruncated(visionData.stop_reason, screenshotBase64.length);
        const extracted = visionData.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text?.trim() ?? "";
        if (extracted && !extracted.includes("読み取れませんでした")) {
          replyHint = [
            `【📱 スクショから読み取ったトーク内容（最優先の文脈として参照すること）】\n${extracted}`,
            replyHint,
          ].filter(Boolean).join(" / ");
        }
      }
    } catch (err) { console.error("[generate-reply] スクショ読み取り失敗 — 通常生成にフォールバック:", err); }
  }

  // DBカスタムプロンプトを取得（失敗時はハードコード値にフォールバック）
  let promptOverrides: PromptOverrides | undefined;
  try {
    const { data: dbPrompts } = await supabase.from("ai_prompts").select("key, content");
    if (dbPrompts && dbPrompts.length > 0) {
      let generationSystem: string | undefined;
      let quickPatterns: string | undefined;
      let realEstateRules: string | undefined;
      let smoraRules: string | undefined;
      let replyContentRules: string | undefined;
      let aixPropertyRecommendationRules: string | undefined;
      let aixPropertySendRules: string | undefined;
      for (const p of dbPrompts as { key: string; content: string }[]) {
        if (p.key === "generation_system") generationSystem = p.content;
        else if (p.key === "smora_quick_patterns") quickPatterns = p.content;
        else if (p.key === "real_estate_rules") realEstateRules = p.content;
        else if (p.key === "smora_rules") smoraRules = p.content;
        else if (p.key === "reply_content_rules") replyContentRules = p.content;
        else if (p.key === "aix_property_recommendation_rules") aixPropertyRecommendationRules = p.content;
        else if (p.key === "aix_property_send_rules") aixPropertySendRules = p.content;
        // phase_guide_* はコード(line-reply-prompts.ts)を正として使用・DBは無視
      }
      if (generationSystem || quickPatterns || realEstateRules || smoraRules || replyContentRules || aixPropertyRecommendationRules || aixPropertySendRules) {
        promptOverrides = {
          generationSystem,
          quickPatterns,
          realEstateRules,
          smoraRules,
          replyContentRules,
          aixPropertyRecommendationRules,
          aixPropertySendRules,
        };
      }
    }
  } catch (err) { console.error("[generate-reply] ai_prompts取得失敗 — ハードコード値にフォールバック:", err); }

    // S-2: 暫定の state 解決（brain 鮮度・条件提示は未確定なので後段で resolveState を再実行して phaseGuideKey を確定する）
    const hasAnyStaffTextMsg = recentMessages.some((m) => m.sender === "staff" && !!m.text && !/^\s*(?:\[(?:画像|動画|スタンプ|ファイル)\]\s*)+$/.test(m.text));
    const currentState = resolveState(state, { hasStaffMsg: hasAnyStaffTextMsg, brainFresh: false, conversationId }).phase;

    // 画像送付を会話履歴に反映（[画像]をフィルタせず意味のあるラベルに変換）
    // 連続する画像メッセージ（同一sender・同一isAixフラグ）は1エントリにまとめて枚数を _imageCount に記録
    type HistoryMsg = RecentMessage & { _imageCount?: number };
    const isImageOnlyMsg = (m: RecentMessage) =>
      m.text === "[画像]" || m.text === "[動画]" || (!m.text && !!m.imageUrl);
    const history = recentMessages
      .slice(-25)
      .reduce<HistoryMsg[]>((acc, m) => {
        const prev = acc[acc.length - 1];
        if (prev && isImageOnlyMsg(m) && isImageOnlyMsg(prev) && prev.sender === m.sender && !!prev.isAix === !!m.isAix) {
          prev._imageCount = (prev._imageCount || 1) + 1;
        } else {
          acc.push({ ...m });
        }
        return acc;
      }, [])
      .map((m, i, arr) => {
        const who = m.sender === "customer" ? "お客様" : "スモラ";
        const isImageMsg = isImageOnlyMsg(m);
        const imgCount = m._imageCount || 1;

        // AIX（AI提案）由来のスタッフメッセージは明示ラベル付け
        // ※行頭は「スモラ:」のまま維持（isFollowUp判定・過去返信抽出・挨拶判定の正規表現が「スモラ:」依存）
        if (m.sender === "staff" && m.isAix) {
          // AIXで物件を送る時は必ず画像もセット → isAix+画像のみ = AIX物件提案の資料
          if (isImageMsg) return imgCount > 1 ? `${who}: 【AIX物件提案の資料画像を${imgCount}枚送付した】` : `${who}: 【AIX物件提案の資料画像を送付した】`;
          if (m.text && m.imageUrl) return `${who}: (AI提案)【AIX物件提案の資料を送付しながら】「${m.text}」`;
          if (m.text) return `${who}: (AI提案)「${m.text}」`;
          return null;
        }

        if (isImageMsg) {
          if (m.sender === "customer") return imgCount > 1 ? `${who}: 【画像を${imgCount}枚送ってきた】` : `${who}: 【画像を送ってきた】`;
          // 連続スタッフ画像（isAixなし）は枚数のみで表現（前後文脈による判定は単発時のみ）
          if (imgCount > 1) return `${who}: 【画像を${imgCount}枚送付した】`;
          // スタッフの画像: 前後5件のテキストで文脈を判定（見積書はお客様の礼金反応からも判定可能）
          const startIdx = Math.max(0, i - 5);
          const nearbyMsgs = arr.slice(startIdx, i + 4).filter((_, ni) => startIdx + ni !== i);
          const nearby = nearbyMsgs.map((x) => x?.text || "").join(" ");
          if (/見積|初期費用|礼金/.test(nearby)) return `${who}: 【見積書を送付した】`;
          // 「確認します」→画像 の流れ → 空室確認済みとして扱う
          if (/確認|空室|空き|募集/.test(nearby)) return `${who}: 【空室確認済み・物件資料を送付した】`;
          if (/物件|お部屋|ピックアップ|間取り|アパート|マンション|資料/.test(nearby)) return `${who}: 【物件資料を送付した】`;
          return `${who}: 【物件資料・画像を送付した】`;
        }

        // テキスト + 画像が同一メッセージの場合
        if (m.imageUrl && m.text && m.text !== "[画像]") {
          const label = m.sender === "staff" ? "【物件資料を送付しながら】" : "";
          return `${who}: ${label}「${m.text}」`;
        }

        if (!m.text) return null;
        return `${who}: ${m.text}`;
      })
      .filter(Boolean)
      .join("\n");

    // AIXテンプレート最適化モードでは historyから過去のAIXメッセージブロックを除外する
    // → AIXメッセージは複数行にまたがるため、行単位ではなくブロック単位でフィルタする
    const historyForTemplate = aixSourceMessage
      ? history
          .split(/\n(?=(?:スモラ|お客様):)/)
          .filter(seg =>
            !seg.includes("(AI提案)") &&
            !seg.includes("AIX物件提案") &&
            // 直前以外のAIX物件オススメ（🌟始まり）を除外して過去物件の混入を防ぐ
            !(seg.startsWith("スモラ:") && seg.includes("🌟"))
          )
          .join("\n")
      : history;

    // 真の初回判定（冒頭挨拶を強制注入するかどうか）
    // 画像のみは「スタッフが返信した」とみなさないが、AIX経由の返信はカウントする
    // ※ AIXでのみ送信した場合に isFirstEverReply=true のまま残るバグを防ぐ
    // S-4: 「初回か否か」は履歴窓（20件）ではなく DB 事実（body.hasStaffReplied）を優先。未渡しなら従来の推定
    //      メディアのみ（画像・動画・スタンプ・ファイル）のスタッフ送信は「返信済み」に数えない（final-check MEDIA_ONLY_RE と同定義）
    const isFirstEverReplyFromMsgs = typeof hasStaffRepliedFromBody === "boolean"
      ? !hasStaffRepliedFromBody
      : !hasAnyStaffTextMsg;
    const shouldPrependGreeting = isFirstEverReplyFromMsgs && currentState === "first_reply";

    // follow-up検知（履歴末尾がスモラ = 2通目以降の生成）
    const allSpeakersInHistory = [...history.matchAll(/(?:^|\n)(スモラ|お客様):/g)];
    const isFollowUp = allSpeakersInHistory.length > 0 && allSpeakersInHistory[allSpeakersInHistory.length - 1][1] === "スモラ";

    // 最後のスモラメッセージを全文抽出（② の検索クエリ・① の表示用）
    // スプリット送信（連続複数行）を結合した全文を使用。buildGenerationMessages 内の lastStaffMsg と同一ロジック。
    const lastStaffMsgForSearch = (() => {
      const segments = history.split(/\n(?=スモラ:|お客様:)/);
      const groups: string[] = [];
      let cur: string[] = [];
      for (const seg of segments) {
        if (seg.startsWith("スモラ:")) {
          cur.push(seg.replace(/^スモラ:\s*/, "").trim());
        } else if (seg.startsWith("お客様:")) {
          if (cur.length > 0) { groups.push(cur.join("\n")); cur = []; }
        }
      }
      if (cur.length > 0) groups.push(cur.join("\n"));
      return groups.length > 0 ? groups[groups.length - 1] : undefined;
    })();

    // ─── 見積書・割引の「約束済み」検出（見積二重宣言の防止）─────────────────
    // ① aix_usage_logs に estimate_sheet の使用履歴がある（AIXで見積書送付済み）
    // ①' M2: estimate_sent=true のログがある（「物件確認した・物件あった」に見積書を同封して送ったケース。
    //     aix_type は property_check_result のため ① では拾えず、直後の返信で見積書を二重宣言していた）
    // ② 直前スタッフ返信が既に割引・見積書の作成/送付を約束している（イエヤス割提示等）
    // のいずれかなら estimatePromised=true とし、estimatePromiseAckNote 注入＋enforceAixGates の
    // 置換文切替で「御見積書を作成しお送りします」宣言の再生成を止める。判定不能時は従来動作を維持。
    let estimateAlreadySent = false;
    // AIX実行済みアクション再宣言防止(2026-09-01)用の直近ログ。見積判定クエリと並列実行するため
    // DB往復の実時間は従来と同じ（見積側は .or フィルタのDB側評価を維持＝既存セマンティクスを一切変えない）。
    // 2026-09-09 Fable5 行動台帳: 台帳の一次証拠列（sent_at / line_message_id / generated_text / property_names / estimate_sent）まで取得
    type RecentAixRow = LedgerAixRow;
    let recentAixRows: RecentAixRow[] = [];
    if (conversationId && !isTemplateOptimize) {
      try {
        const [estLogsRes, recentAixRes] = await Promise.all([
          supabase
            .from("aix_usage_logs")
            .select("id")
            .eq("conversation_id", conversationId)
            .or("aix_type.eq.estimate_sheet,estimate_sent.is.true")
            .limit(1),
          supabase
            .from("aix_usage_logs")
            .select("aix_type, check_pattern, created_at, sent_at, line_message_id, generated_text, property_names, estimate_sent, template_name")
            .eq("conversation_id", conversationId)
            .order("created_at", { ascending: false })
            .limit(30),
        ]);
        estimateAlreadySent = (estLogsRes.data?.length ?? 0) > 0;
        recentAixRows = (recentAixRes.data ?? []) as RecentAixRow[];
      } catch { /* 判定不能時は従来動作（宣言許可）を維持する */ }
    }
    // 顧客の現在のメッセージが新規見積依頼なら「送付済み」フラグを解除する
    // 過去に送付済みでも、新たに「見積出して」と依頼されたら新規依頼として処理（恒久ブロック防止）
    // 顧客が金額について確認・反応している場合（「179,180円ですか！」「176,180円ですよね？」等の
    // 金額確認質問）も解除する。宣言ブロックより金額質問への回答を優先するため
    const customerAskingAboutPrice = /[¥￥]?[0-9０-９][0-9０-９,，.．]{2,}[\s　]*円/.test(message);
    // 物件URL/物件特定情報つきの費用質問は「新しい物件への新規見積依頼」→ 送付済み/約束済みフラグを解除する
    // （過去の別物件の見積送付・約束が新物件の見積作成宣言を恒久ブロックするのを防ぐ。
    //   例:「この物件の初期費用が知りたいです」＋URL → 会社の定型フローとして必ず見積作成宣言が必要）
    // 2026-09-08 Fable5: 共有 RE（CUSTOMER_PROPERTY_REF_RE / CUSTOMER_COST_QUESTION_RE / STAFF_ESTIMATE_PROMISE_RE）に統一
    const hasPropertyRef = CUSTOMER_PROPERTY_REF_RE.test(message);
    const asksCost = CUSTOMER_COST_QUESTION_RE.test(message.replace(FORM_LABEL_RE, " "));
    const isNewPropertyCostAsk = hasPropertyRef && asksCost;
    if (
      estimateAlreadySent &&
      (CUSTOMER_ESTIMATE_REQUEST_RE.test(message) || customerAskingAboutPrice || isNewPropertyCostAsk)
    ) {
      estimateAlreadySent = false;
    }
    // staffPromisedEstimate にも同じオーバーライド: 直前の約束は別物件のもの＝新物件は新規見積として扱う
    const staffPromisedEstimate =
      !isNewPropertyCostAsk && !!lastStaffMsgForSearch && STAFF_ESTIMATE_PROMISE_RE.test(lastStaffMsgForSearch);
    const estimatePromised = !isTemplateOptimize && (estimateAlreadySent || staffPromisedEstimate);

    // ── AIX実行済みアクションの再宣言防止フラグ（2026-09-01）──────────────────────
    // 「AIXで実行＋LINE送信まで完了したアクションを、AIが未来形で再宣言する」バグを止めるための判定。
    // 対象は直近 AIX_DONE_WINDOW_MS 以内に押されたAIXのみ。それ以前は募集状況・在庫が変わり得るため
    // 再確認宣言は正当な業務であり、恒久ブロックすると「確認します」が永久に言えなくなる（過剰抑制）。
    const AIX_DONE_WINDOW_MS = 72 * 60 * 60 * 1000; // 72時間（週末を挟む商談の1ターンをカバー）
    const aixDone: AixDoneFlags | null = (() => {
      if (isTemplateOptimize || recentAixRows.length === 0) return null;
      const now = Date.now();
      const fresh = recentAixRows.filter((l) => {
        const t = Date.parse(l.created_at ?? "");
        return Number.isFinite(t) && now - t <= AIX_DONE_WINDOW_MS;
      });
      if (fresh.length === 0) return null;

      // ── 解除条件（新規依頼は「未実行」として扱い、正当な宣言を潰さない）──────────
      // ① 新しい物件の提示（URL・画像）→ その物件は未確認なので空室確認宣言は正当
      const hasNewPropertyRef = /https?:\/\/|suumo|homes\.co|athome|chintai|goodrooms/i.test(message) || !!screenshotBase64;
      // ② 明示的な再確認依頼（「まだ空いてますか」「確認してもらえますか」）→ 再確認は正当
      const asksRecheck = /(まだ|再度|改めて)[^\n]{0,8}(空い|募集|ある|残って)|空い(て|ており)ます(か|でしょうか)|(確認|問い合わせ)(して|し)[^\n]{0,6}(ください|下さい|もらえ|頂け|いただけ|ほしい|欲しい)/.test(message);
      // ③ 新規ピックアップ依頼・条件変更 → 新条件での物件送付宣言は正当
      const asksNewPickup =
        AIX_CONDITION_CHANGE_RE.test(message) ||
        /(他(に|の)|別の|違う|もっと|追加で|再度)[^\n]{0,10}(物件|お部屋|部屋|ピックアップ|探し)/.test(message) ||
        /(探して|ピックアップして)[^\n]{0,6}(ください|下さい|もらえ|頂け|いただけ|ほしい|欲しい)/.test(message);
      // ④ 内覧日程の再調整依頼 → 内覧調整宣言は正当
      // 内覧日程再調整 or 顧客が提案済み日時を受諾した場合（例: 「はい大丈夫です！」「その日でお願いします」）
      // 受諾時は viewingInvite=false にしてL944-945の内覧宣言禁止ノートを解除する（返信に日時を含めることが正当になるため）
      const asksNewViewing = /(別の|他の|違う)[^\n]{0,6}(日|日程|候補|時間)|都合が(悪|つかな)/.test(message) ||
        (!!lastStaffMsgForSearch &&
          /[0-9０-９]{1,2}\s*[\/月]\s*[0-9０-９]{1,2}/.test(lastStaffMsgForSearch) &&
          /大丈夫|はい|OK|お願いします|その日で|で大丈夫|承知|かしこまり/.test(message));

      const VACANCY_RELEASE = hasNewPropertyRef || asksRecheck;
      const vacancyCheck = !VACANCY_RELEASE && fresh.some((l) => l.aix_type === "property_check_result");
      const mgmtCheck = !VACANCY_RELEASE && fresh.some((l) => (l.check_pattern ?? "").startsWith("mgmt_"));
      const propertySend =
        !asksNewPickup && fresh.some((l) => l.aix_type === "property_send" || l.aix_type === "property_recommendation");
      const viewingInvite = !asksNewViewing && fresh.some((l) => l.aix_type === "viewing_invite");
      const meetingPlace = fresh.some((l) => l.aix_type === "meeting_place");

      if (!vacancyCheck && !mgmtCheck && !propertySend && !viewingInvite && !meetingPlace) return null;

      const AIX_DONE_LABEL: Record<string, string> = {
        property_check_result: "空室・募集状況の確認",
        property_send: "物件ピックアップ送付",
        property_recommendation: "物件おすすめ送付",
        viewing_invite: "内覧日程の案内",
        meeting_place: "待ち合わせ場所の案内",
      };
      const CHECK_PATTERN_LABEL: Record<string, string> = {
        available: "空室あり",
        unavailable: "募集終了",
        alternative: "代替物件を提案",
        mgmt_availability: "管理会社に空き確認",
        mgmt_move_in: "管理会社に入居時期確認",
        mgmt_initial_cost: "管理会社に初期費用確認",
        mgmt_equipment: "管理会社に設備確認",
        mgmt_parking: "管理会社に駐車場確認",
        mgmt_guarantor: "管理会社に保証人確認",
      };
      // 表示は実際に禁止対象になった種別のみ（禁止していないアクションを並べると
      // 「もう全部やった」という誤読を生み、必要な次の一手まで抑制されるため）
      const shownTypes = new Set<string>();
      if (vacancyCheck || mgmtCheck) shownTypes.add("property_check_result");
      if (propertySend) { shownTypes.add("property_send"); shownTypes.add("property_recommendation"); }
      if (viewingInvite) shownTypes.add("viewing_invite");
      if (meetingPlace) shownTypes.add("meeting_place");
      const labels = fresh
        .filter((l) => l.aix_type && shownTypes.has(l.aix_type))
        .slice(0, 5)
        .map((l) => {
          const base = AIX_DONE_LABEL[l.aix_type ?? ""] ?? l.aix_type ?? "?";
          const hours = Math.max(0, Math.round((now - Date.parse(l.created_at ?? "")) / 3600000));
          const when = hours < 1 ? "1時間以内" : `約${hours}時間前`;
          const result = l.check_pattern ? `・結果:${CHECK_PATTERN_LABEL[l.check_pattern] ?? l.check_pattern}` : "";
          return `${base}（${when}${result}）`;
        });

      return { vacancyCheck, mgmtCheck, propertySend, viewingInvite, meetingPlace, labels, asksNewPickup };
    })();
    if (aixDone) {
      console.log("[generate-reply] AIX実行済み再宣言ブロック適用:", conversationId, JSON.stringify(aixDone));
    }

    if (!process.env.OPENAI_API_KEY) {
      console.warn("[generate-reply] OPENAI_API_KEY not set — pgvector検索無効・フォールバック使用");
    }

    // ── Step1（analyzeCustomerSituation）完全廃止（2026-08）────────────────────
    // 旧: ここで Sonnet による直列分析（3〜8秒・Step2並列フェッチをブロック）を実行していた。
    // brain(suggested_aix_meta) が Step1 の全消費フィールドの上位互換を持つため、
    // DBフェッチ1回（数十ms・fetchReplyModeGate）に置き換える。これにより
    // reply_modeゲートB・brainGuidanceNote・analysisContext・final-check が
    // 全て同一スナップショットを参照する（旧「Step1とbrainの鮮度差」問題が構造的に消える）。
    // brain直列アーキテクチャ: brainMetaDirect 指定時（bg-async経由）は DB 再フェッチをスキップ。
    // bg-async が直前に brain を直列実行して書いた値なので DB と同値（むしろ順序保証つき）＝常にT1（fresh）。
    // 重複フェッチ解消(2026-08): チェックポイントAのスナップショットがあれば再利用（毎分cron積算のDB往復1回削減）
    const brainGate = externalBrainGate ?? gateFromCheckpointA ?? ((conversationId && !isTemplateOptimize)
      ? await fetchReplyModeGate(conversationId)
      : null);
    const brainMeta = brainGate?.meta ?? null;
    // AIX履歴: Brain(suggested_aix_meta.last_aix_history)から取得（Brain がaix_usage_logs を読んで組み立て済み）
    const lastAixHistoryText: string | null = brainMeta?.last_aix_history ?? null;

    // ── AIX-META 鮮度判定 → brain鮮度ティア判定（T1=fresh / T2=stale / T3=null）─────
    // 戦略フィールド（closing_strategy / reply_direction / key_topics / avoid_topics /
    // urgency_appropriate / recommended_tone / next_steps）は差分分析モードでも維持される設計のため
    // staleでも採用する。鮮度従属フィールド（customer_questions / repeated_concern /
    // current_property / condition_change_type / hesitancy_pattern / future_timeline）は
    // 「最新の顧客メッセージ」に従属するため、brainがそのメッセージを見た後の分析でのみ採用する。
    // ⚠ ここは「鮮度」の軸であって「意味スコープ」の軸ではない。repeated_concern / future_timeline /
    // current_property は fresh でも conversation-scope（BrainConversationScope）であり、
    // 「今回のメッセージが何であるか」の判定には使えない（reply-context.ts の toBrainMessageLocal を参照）。
    // cachedモード返却は analyzed_msg_ts が古いまま保存されるためここで自然に弾かれる（追加ロジック不要）。
    // 判定本体は detectBrainTier（brain-fetch-spec.ts）に一元化（旧inline brainFreshForMessage と同値）。
    const lastCustomerMsgAt = [...recentMessages].reverse().find((m) => m.sender === "customer")?.createdAt ?? null;
    const tierResult = detectBrainTier(brainMeta, lastCustomerMsgAt);
    const { brainFreshForMessage } = tierResult;
    // T3（brainMeta完全null: brain失敗・分析未完了）の可視化（P4警告と同型のログ）。
    // 生成自体は closingNote（ai_summary_json）＋決定論regexフォールバックで続行する。
    // brain-sweep が5分以内に補填するため次回生成はT1に復帰する。
    if (tierResult.tier === "T3" && conversationId && !isTemplateOptimize) {
      console.warn("[generate-reply] T3警告: brainMeta null — closingNote(ai_summary)＋決定論regexフォールバックで生成続行:", conversationId);
      console.log(JSON.stringify({tag:"degradation:T3",stage:"detect",conversationId,reason:tierResult.reason,staleAgeMs:tierResult.staleAgeMs??null}));
    }

    // ── S-3: brainMeta の message-local フィールドを鮮度でゲート（2026-09-08 Fable5）──
    // action / reply_direction / key_topics / engagement_stance は「最新メッセージを見て書かれる値」であり、
    // T2（stale）／cached（enforcement_level=optional）／burst（bg-async 中に2通目到着）では前メッセージ向けの
    // 誤誘導になる（null より悪い）。stale 時は null に落として決定論 TPO ＋ STATE_FALLBACK_DIRECTION に委ねる。
    // followup_revive は「顧客返信への生成」では定義上常に stale（追客は無応答時のアクション）。
    const MESSAGE_LOCAL_ACTIONS = new Set(["viewing_invite", "application_push", "meeting_place", "followup_revive", "acknowledge_check", "estimate_sheet", "property_recommendation", "greeting_viewing", "property_check_result"]);
    const isCachedMeta = brainMeta?.source === "cached" || brainMeta?.enforcement_level === "optional";
    const rawAction: string | null = normalizeAixActionKey(brainMeta?.action ?? null);
    const effectiveAction: string | null = (() => {
      if (!rawAction) return null;
      if (rawAction === "followup_revive") return null;
      if (MESSAGE_LOCAL_ACTIONS.has(rawAction) && (!brainFreshForMessage || isCachedMeta)) return null;
      return rawAction;
    })();
    if (rawAction && !effectiveAction && !isTemplateOptimize) {
      console.log(JSON.stringify({ tag: "brain:stale-action-dropped", rawAction, tier: tierResult.tier, cached: isCachedMeta, conversationId }));
    }

    // ── TPO判定 + effective制御値（brainGuidanceNote IIFE外に切り出し 2026-08-30）─────
    // 旧実装は IIFE ローカルだったため finalCheckCtx から参照できず、ファイナルチェックには
    // TPO上書き前の生 brainMeta が渡っていた（過剰指摘・見逃しの原因）。ここで一度だけ計算し
    // LLM注入（brainGuidanceNote）とファイナルチェック（finalCheckCtx）で同一値を共有する。
    // 顧客が今回のメッセージで具体的なエリア・家賃条件を提示しているか判定
    // true の場合は isNegativeContext 等の TPO 誤発動から保護し、条件受け取り返信を強制する
    // ── TPO共通ヘルパ（2026-09-08 誤発動対策 / 監査パッチ）──
    // 話題系（内覧・申込・見積等）: 全TPOで必ず除外。「申し込み」「見たい/行きたい」も依頼として扱う
    const TPO_HARD_REQUEST_RE = /希望|教えて|内覧|内見|見学|申(?:し)?込|書類|初期費用|見積|交渉|送って|(?:見|行き|借り|住み|知り|聞き|決め|伺い)たい/;
    // 文型系（?・ください・いただけ等）。「？」無しの疑問形（〜ますか/ですか/でしょうか）も拾う
    const TPO_SOFT_REQUEST_RE = /[?？]|したい|(?:ます|です|でしょう|ますでしょう)か[ねぇ]?(?:[。！!、\s]|$)|できます|可能です|ください(?!ませ)|もらえ|いただけ|頂け|お願いでき/;
    const TPO_REQUEST_RE = new RegExp(`${TPO_HARD_REQUEST_RE.source}|${TPO_SOFT_REQUEST_RE.source}`);
    // 「時間が欲しい・考えさせて欲しい」型は依頼形でも判断保留（isThinkingMsg で SOFT 除外を免除）
    const TPO_THINK_TIME_REQUEST_RE = /(?:検討|考え|相談)(?:させて(?:ください|下さい|頂|いただ|もらえ)|したい)|(?:お?時間|少し|もう少し|しばらく)(?:を|だけ)?(?:ください|下さい|頂け|いただけ|頂きたい|いただきたい|欲しい|ほしい)|考える時間/;
    // 複数通結合時は各通を個別判定（末尾優先バイアス対策の横展開）
    // 2026-09-09 Fable5: 旧 split("\n") は1通内の改行で分割し、みくの isThinkingMsg を2行目で殺していた → 通単位（MSG_SEP / body.customerMessages）
    const customerMsgUnits = splitMessageUnits(message, customerMessagesBody);
    const tpoMsgParts = customerMsgUnits;
    const everyPart = (pred: (s: string) => boolean) => tpoMsgParts.length > 0 && tpoMsgParts.every(pred);
    // 待ち系（一時保留/検討中）用: 1通以上が該当 かつ 残りは全て中立（感謝・了承のみ）で成立（TPO_NEUTRAL_ACK_RE はモジュールスコープ）
    //   中立判定は装飾（🙇🏻‍♀️ 等）除去後に当てる（FN 対策）
    const anyPartRestNeutral = (pred: (s: string) => boolean) =>
      tpoMsgParts.length > 0 && tpoMsgParts.some(pred) && tpoMsgParts.every((p) => pred(p) || TPO_NEUTRAL_ACK_RE.test(stripDecoration(p).trim()));
    // 直近スタッフ1通（recentMessages は oldest-first → reverse().find で最新）
    const tpoLatestStaff = [...recentMessages].reverse().find((m) => m.sender === "staff") ?? null;
    const tpoLatestStaffText = tpoLatestStaff?.text ?? "";

    // ── 2026-09-09 Fable5 往復文脈: 直前スタッフ発話の分類 → 顧客メッセージの実質判定（1回だけ計算し四者が参照）──
    //   lastStaffTurn: aix_usage_logs（直前スタッフ発言 ±3分）> 本文 regex > brain last_aix_history
    //   substance   : 定型（感謝・了承・締め）と待ち句を剥がした残余に懸念・質問・依頼・条件・予定・決定・断り・情報を当てる。fresh brain は補助証拠
    // ── 2026-09-09 Fable5 G1 行動台帳: 我々が【何をしたか＝done】【何をすると言ったか＝promised】を一次証拠から1回構築。
    //    生成（ledgerNote / staffContextNote 注記 / 往復文脈 / hedge.searched / sentPropertiesCount / aixDone）・検査（finalCheckCtx 3か所）・
    //    tpo_debug → reply_context_snapshot が同一オブジェクトを参照する（四者同名）。shadow モードは計算＋差分ログのみ
    const ledger: ActionLedger = buildActionLedger({
      recentAixRows,
      messages: recentMessages.map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.createdAt, isAix: m.isAix, lineMessageId: null })),
      lineTasks: ledgerTasks,
      lastAixHistory: lastAixHistoryText,
      lastCustomerAt: lastCustomerMsgAt,
    });
    console.info("[ledger]", JSON.stringify({ summary: ledger.summary, facts: { sent: ledger.facts.propertiesSentCount, est: ledger.facts.estimateSent, promised: ledger.facts.pickupPromisedUnfulfilled, redo: ledger.facts.redoAllowed, sinceCust: ledger.facts.propertiesSentSinceCustomerLatest, last: ledger.facts.lastStaffEntry?.kind ?? null }, mode: ACTION_LEDGER_MODE }));
    const ledgerActive = ACTION_LEDGER_MODE !== "shadow" && !isTemplateOptimize;
    const ledgerForCtx: ActionLedger | null = ledgerActive ? ledger : null;
    // Phase2（enforce）: aixDone.propertySend を台帳 recentDone.propertySend（aix_log > line_task > 本文・72h）に統一（解除条件 asksNewPickup は従来通り）
    if (aixDone && ACTION_LEDGER_MODE === "enforce") aixDone.propertySend = !aixDone.asksNewPickup && ledger.facts.recentDone.propertySend;

    const lastStaffTurn = classifyLastStaffTurn(lastStaffMsgForSearch || tpoLatestStaffText, {
      recentAixRows,
      lastStaffAt: tpoLatestStaff?.createdAt ?? null,
      lastAixHistory: lastAixHistoryText,
      ledger: ledgerForCtx,
    });
    const substanceBase = analyzeSubstance(message ?? "", customerMsgUnits, { staffAskedQuestion: lastStaffTurn.kind === "question_to_customer" });
    // 2026-09-10 Fable5 みく事例: brain フィールドを「意味のスコープ」で二分する。
    //   message-local（このメッセージについての判定）だけが分類器に入れる。conversation-scope（会話全体の方針）は
    //   fresh であってもメッセージ単位の証拠にしない。変換はこの2関数だけが入口（フィールドを手詰めしない）
    const brainLocal = toBrainMessageLocal(brainMeta as Record<string, unknown> | null);
    // 2026-09-10 Fable5 Sさん事例（原因D）: brainStrategy（conversation-scope＝返信方針と禁止事項）は
    //   suggested_aix_meta が無い時に last_brain_meta で補填してよい。reply_direction / engagement_stance /
    //   avoid_topics / checkpoint_stage / closing_strategy は「会話全体の方針」であり1メッセージ古くても壊れない。
    //   ⚠ brainLocal（message-local）は**絶対に last_brain_meta から作らない**。customer_questions /
    //     customer_concern / condition_change_type / hesitancy_pattern は「そのメッセージについての判定」で、
    //     別メッセージの判定を流用すると誤爆する（isPureBoilerplate ガードの前提が壊れる）。
    const brainStrategyPrimary = toBrainConversationScope(brainMeta as Record<string, unknown> | null);
    const brainStrategyFallback = brainStrategyPrimary ? null : toBrainConversationScope(brainGate?.lastMeta ?? null);
    const brainStrategy: BrainConversationScope | null = brainStrategyPrimary ?? brainStrategyFallback;
    const brainStrategySource: "suggested_aix_meta" | "last_brain_meta" | "none" =
      brainStrategyPrimary ? "suggested_aix_meta" : brainStrategyFallback ? "last_brain_meta" : "none";
    if (brainStrategySource === "last_brain_meta") {
      console.info("[brain-strategy] T3 fallback: last_brain_meta を conversation-scope 方針として採用", conversationId);
    }
    const brainLocalFresh = brainFreshForMessage && !isCachedMeta;
    const substance: SubstanceVerdict = mergeBrainEvidence(substanceBase, brainLocal, brainLocalFresh);
    console.info("[reply-context]", JSON.stringify({ has: substance.has, kinds: substance.kinds, concerns: substance.concerns.map((c) => c.key), isAckOnly: substance.isAckOnly, staff: lastStaffTurn.kind, staffSource: lastStaffTurn.source, units: customerMsgUnits.length }));

    // G10（2026-09-08 Fable5）: 退去・引越し語の主語（現住居＝入居時期情報／提案物件／部屋探し終了）。
    //   negativeDetail（withdrawal 二重ガード）・isGratitudeReplyTPO・方向性・final-check（FAREWELL_ON_MOVEOUT_INFO）で共有
    const moveOutSubject: MoveOutSubject = classifyMoveOutSubject(message ?? "");
    // G26（2026-09-08 Fable5）: 確認約束 verdict（生成 managementNote/confirmationGateNote・bridge・final-check V5/V6 の三層で同一オブジェクト）。
    //   effectiveAction は鮮度ゲート済み。AIX タイミング判定は後段 applyAixTiming で合成（confirmCtxFinal）
    const confirmCtx: ConfirmationContextVerdict = resolveConfirmationContext({
      customerMessage: message ?? "",
      lastStaffMessage: lastStaffMsgForSearch,
      brainAction: effectiveAction,
      activeTaskTypes,
      // 2026-09-11 §5.2: 会話に実在する物件名（照合専用。生成の文面には出さない＝竹内方針2）
      conversationObjects: { propertyNames: ledger.facts.propertiesSentNames },
    });
    console.info("[confirmCtx]", JSON.stringify({ allowed: confirmCtx.allowed, source: confirmCtx.source, object: confirmCtx.object, moveOutSubject }));

    // ── 条件提示判定（2026-09-08 監査改修）──
    // ①エリア語彙拡張＋ひらがな接頭の誤検出排除 ②家賃以外の金額（初期費用/礼金/年収等）をマスク
    // ③漢数字・接頭語付き裸数字対応 ④既存物件への依頼・質問は条件提示より優先して false
    // ⑤丸数字1個単独では発火しない ⑥抽出値（areas/rent）を露出して effectiveReplyDirection に埋め込む
    const AREA_NAMED_RE = /梅田|なんば|難波|心斎橋|本町|堀江|天王寺|新大阪|京橋|天満|福島|野田|中津|十三|江坂|西九条|九条|桜川|阿波座|谷町|谷四|谷六|谷九|上本町|鶴橋|玉造|森ノ宮|弁天町|大正|住之江|北浜|淀屋橋|肥後橋|四ツ橋|四つ橋|長堀|松屋町|南森町|扇町|都島|野江|関目|蒲生|放出|今里|布施|尼崎|西宮|神戸|三宮|豊中|吹田|茨木|高槻|枚方|寝屋川|守口|門真|東大阪|八尾|堺|北摂|南大阪|北大阪|阪神間|ミナミ|キタ|京都|奈良|兵庫|阿倍野|天六|千里|箕面|池田|伊丹|宝塚|川西|明石|姫路|岸和田|和泉|泉佐野|富田林|大東|四條畷|交野|摂津|生駒|柏原|松原|藤井寺|羽曳野|長居|平野|我孫子|天下茶屋|岸里|玉出|住吉|帝塚山|文の里|田辺|針中野|緑橋|深江橋|高井田|長田|荒本|新石切|野田阪神|千鳥橋|伝法|出来島|千船|杭全|加美|久宝寺|新今宮|動物園前|恵美須|大国町|花園町|北加賀屋|南港|コスモスクエア|中之島|渡辺橋|海老江|新福島|南方|西中島|東三国|東淀川|上新庄|淡路|天神橋|中崎町|大阪城公園|清水|太子橋|千林|大日|古川橋|萱島|香里園|樟葉|くずは|鴻池新田|住道|徳庵|河内永和|俊徳道|長瀬|弥刀|近鉄八尾|河内山本|なかもず|中百舌鳥|新金岡|北花田|三国ヶ丘|堺東|泉ヶ丘|光明池|和泉中央|大阪市内/g;
    // 接頭は漢字/カタカナのみ（「できれば駅近」「この地区」「都市ガス」「新幹線」の誤検出を排除）
    const AREA_SUFFIX_RE = /[一-龯ァ-ヶー]{2,}(?:駅(?!近|チカ)|区|市(?!ガス|場)|町|村|府|県|丁目)|[一-龯ァ-ヶー]{2,}(?<!新幹|回|無|有|配|視|目|直|前|通信|路)線|[一-龯ァ-ヶー]{2,}(?:周辺|エリア|あたり|付近|近辺|界隈|方面|沿線|寄り|圏内)|(?:阪急|阪神|京阪|近鉄|南海|JR)(?:沿線|線|沿い)?/g;
    // 家賃以外の金額（初期費用・礼金・年収等）を先にマスクする
    const NON_RENT_CTX_RE = /(?:初期費用|初期|礼金|敷金|保証金|敷引|保証料|年収|月収|貯金|手数料|仲介|鍵交換|火災保険|清掃費|クリーニング|駐車場|値引|割引|交渉)\s*[はがも:：で]?\s*(?:[0-9０-９]+(?:[,，][0-9０-９]{3})*(?:\.[0-9０-９]+)?|[一二三四五六七八九十]+)\s*(?:万|千)?(?:円)?/g;
    const RENT_PREFIX = "(?:(?:予算|家賃|賃料|上限|max|MAX)[はもが:：]?\\s*)?";
    const RENT_RE = new RegExp(
      RENT_PREFIX + "(?:[0-9０-９]+(?:\\.[0-9０-９]+)?|[一二三四五六七八九十]+)万(?:[0-9０-９一二三四五六七八九]+千?)?(?:円)?(?:以内|〜|~|まで|以下|台|前後|くらい|ぐらい|程度|位|後半|前半)?" +
      "|" + RENT_PREFIX + "[0-9０-９]{2,3}[,，]?[0０]{3}円?(?:以内|まで|以下|前後|くらい)?" +
      "|(?:予算|家賃|賃料|上限|max|MAX)[はもが:：]?\\s*[0-9０-９]+(?:\\.[0-9０-９]+)?",
      "g",
    );
    // 「条件を出している」ことを示す語（依頼文との切り分け）
    const CONDITION_MARKER_RE = /希望|条件|エリア|予算|家賃|間取り|探し|ピックアップ|変更|広げ|絞|抑え|以内|まで|台|くらい|程度|前後|駅近|徒歩|築|階|向き|設備|オートロック|バストイレ|独立洗面|管理費込|共益費込/;
    // 既存物件への依頼・質問（内覧/申込/見積/？）
    const REQUEST_INTENT_RE = /内覧|内見|見学|申込|申し込み|申し込む|契約|審査|見積|書類|持ち物|鍵|入居日|引き渡し|[?？]/;
    // 送付済み物件への言及は条件語があっても条件提示扱いしない
    const EXISTING_PROPERTY_REF_RE = /送って(?:もらった|いただいた|くださった|頂いた)|先日の|先程の|さっきの|この物件|その物件|こちらの物件|上の物件|下の物件|[0-9０-９]+(?:件目|つ目|番目)|[ABCＡＢＣ]の(?:物件|お部屋|方)|の方で/;

    type ConditionDetail = {
      presented: boolean;      // 従来の isConditionPresented（エリア＋家賃 両方 or フォーム）
      areas: string[];         // 抽出エリア（復唱用）
      rent: string | null;     // 抽出家賃（復唱用）
      hasRequest: boolean;     // 依頼・質問併記あり（方向性に「先に回答」を足す）
      changeRequest: boolean;  // エリアのみ/家賃のみ＋条件語（待ち系TPO誤発動からの保護専用・方向性は強制しない）
      reason: string;
    };
    const conditionDetail: ConditionDetail = (() => {
      const msg = (message ?? "").trim().slice(0, 800);
      const none = (reason: string, extra: Partial<ConditionDetail> = {}): ConditionDetail =>
        ({ presented: false, areas: [], rent: null, hasRequest: false, changeRequest: false, reason, ...extra });
      if (msg.length === 0) return none("empty");
      const hasRequest = REQUEST_INTENT_RE.test(msg);
      const refersExisting = EXISTING_PROPERTY_REF_RE.test(msg);
      const hasMarker = CONDITION_MARKER_RE.test(msg);
      // 構造化フォーム: 【〇〇】⇒ / 丸数字2個以上 / 丸数字1個＋条件語
      const circled = (msg.match(/[①②③④⑤⑥⑦⑧⑨⑩]/g) ?? []).length;
      if (/【[^】]{1,12}】\s*[⇒→:：]/.test(msg) || circled >= 2 || (circled === 1 && hasMarker)) {
        return { presented: true, areas: [], rent: null, hasRequest, changeRequest: false, reason: "form" };
      }
      const masked = msg.replace(NON_RENT_CTX_RE, (m) => "＠".repeat(m.length));
      const rent = (masked.match(RENT_RE) ?? [])[0] ?? null;
      const raw = [...(msg.match(AREA_SUFFIX_RE) ?? []), ...(msg.match(AREA_NAMED_RE) ?? [])];
      // 重複・包含（「大阪市」⊂「大阪市内」）を除去し長い方を残す
      const areas = raw.filter((a, i) => raw.indexOf(a) === i && !raw.some((b) => b !== a && b.length > a.length && b.includes(a)));
      const hasArea = areas.length > 0;
      const hasRent = !!rent;
      if (refersExisting) return none("existing_property_ref", { areas, rent, hasRequest });
      if (!(hasArea && hasRent)) {
        const changeRequest = (hasArea || hasRent) && hasMarker && !hasRequest;
        return none(hasArea ? "no_rent" : "no_area", { areas, rent, hasRequest, changeRequest });
      }
      if (hasRequest && !hasMarker) return none("request_over_condition", { areas, rent, hasRequest });
      return { presented: true, areas, rent, hasRequest, changeRequest: false, reason: "area+rent" };
    })();
    // ── S-2: 状態の最終確定（brain 鮮度・条件提示・checkpoint_stage を反映した guideKey / searchState）──
    const resolvedState = resolveState(state, {
      hasStaffMsg: hasAnyStaffTextMsg,
      checkpointStage: brainMeta?.checkpoint_stage ?? null,
      brainFresh: brainFreshForMessage,
      conditionPresented: conditionDetail.presented,
      conversationId,
    });
    const phaseGuideKey: PhaseKey = resolvedState.guideKey;
    const searchState = resolvedState.searchState;
    // 申込中・成約後は条件提示ガードを無効化（申込フォーム内の住所＋家賃で誤発動）。brain fresh で条件変更が立っている時のみ例外
    const isConditionPresented = conditionDetail.presented
      && !((phaseGuideKey === "applying" || phaseGuideKey === "closed_won") && !(brainFreshForMessage && brainMeta?.condition_change_type));
    const isConditionChangeRequest = conditionDetail.changeRequest;

    // ── 2026-09-08 Fable5: 見積書の文脈判定（単一 verdict・1回だけ計算）──────────────────
    // 生成（estimateGateNote / estimatePromiseAckNote / phaseProhibition）・AIX（detectAixTiming）・
    // 検査（final-check E5 / E10）の三層がこの verdict を共有する。state では判定しない。
    // 2026-09-09 Fable5 行動台帳（G31）: 旧 countSentProperties（🌟 regex）と台帳（aix_type 一次証拠）の差分を shadow ログ。enforce で台帳に統一
    const regexSentCount = countSentProperties(recentMessages);
    const sentPropertiesCount = ACTION_LEDGER_MODE === "enforce" && !isTemplateOptimize ? ledger.facts.propertiesSentCount : regexSentCount;
    if (regexSentCount !== ledger.facts.propertiesSentCount) console.info("[ledger-diff]", JSON.stringify({ regexCount: regexSentCount, ledgerCount: ledger.facts.propertiesSentCount, conversationId }));
    const lastStaffIdxForEst =recentMessages.map((m, i) => (m.sender === "staff" ? i : -1)).filter((i) => i >= 0).at(-1) ?? -1;
    const unrepliedCustomerTexts = recentMessages.slice(lastStaffIdxForEst + 1).filter((m) => m.sender === "customer").map((m) => m.text ?? "");
    // 2026-09-10 Fable5 あみ事例: 持込予告は customerResponse 分類より前に必要なため決定論 regex で先に判定する（reply-context と同一定数）
    const willSendObj = classifyWillSendObject(message ?? "");
    const willSendSelf = CUST_WILL_SEND_SELF_PRED(message ?? "");
    const estimateVerdict: EstimateContextVerdict = isMisumoriContextAppropriate({
      customerMessage: message,
      sentPropertiesCount,
      recentCustomerMessages: unrepliedCustomerTexts,
      lastStaffMessage: lastStaffMsgForSearch,
      brainAction: brainMeta?.action ?? null,
      brainMeta,
      brainFresh: brainFreshForMessage,
      phaseKey: phaseGuideKey,
      hasCustomerImage: unrepliedCustomerTexts.some((t) => /【画像を送ってきた】|【画像】|\[画像\]/.test(t)),
      estimatePromised,
      customerWillSendProperty: willSendSelf.yes && (willSendObj === "property" || willSendObj === "unknown"),
      customerWillSendEvidence: willSendSelf.evidence,
    });
    console.info("[estimate-ctx]", estimateVerdict.trigger, estimateVerdict.mode, estimateVerdict.signals.join(","));

    // A-1: 絵文字・記号のみ（スタンプ単独の sentinel 除去後を含む）
    const isDecorOnlyMsg = (message ?? "").trim().length > 0 && (DECOR_ONLY_RE.test((message ?? "").trim()) || /^(?:\[スタンプ\]\s*)+$/.test((message ?? "").trim()));
    // A-13: 不安・関西弁ネガ（isConditionPresented・isViewingCancel の直後・applying より先に評価）
    const isAnxietyMsg = ANXIETY_RE.test(message ?? "") && (message ?? "").length < 200 && !isConditionPresented;

    // ── 感謝返し（2026-09-08 監査改修: ?なし疑問文・依頼形・柔らかい断り・情報提供を除外、実質文字数で判定）──
    const isGratitudeReplyTPO = (() => {
      const raw = (message ?? "").trim();
      if (raw.length === 0) return false;
      // A-6（G-6）: スタッフ返信済みの follow-up 生成では「感謝を受け取る」方向を再注入しない（二重返信防止）
      if (isFollowUp) return false;
      // A-1: スタンプ単独・絵文字のみは短い了承として感謝返しに流す
      if (isDecorOnlyMsg) return true;
      // 2026-09-09 Fable5: 実質あり（条件追加・日程・号室選択・懸念）は感謝返しにしない（「福島区もお願いします」の誤発動 23/131 を根治）
      if (substance.has) return false;
      const core = stripDecoration(raw);
      const len = Array.from(core).length;
      if (len === 0 || len >= 60) return false;
      if (isConditionPresented || isConditionChangeRequest) return false;
      // 「内覧の件、よろしくお願いします」= 手配済み案件への承諾。名詞句「〜の件」を除いてから依頼判定
      const forReq = core.replace(/(?:内覧|内見|見学|お?申込み?|見積(?:書)?|書類|初期費用|契約|審査)の件/g, "");
      if (TPO_REQUEST_RE.test(forReq) || /どうすれば/.test(forReq)) return false;
      if (IMPLICIT_QUESTION_RE.test(core)) return false;
      if (IMPLICIT_REQUEST_RE.test(core)) return false;
      if (SOFT_DECLINE_RE.test(core)) return false;
      if (INFO_PROVIDE_RE.test(core)) return false;
      if (moveOutSubject === "current_home") return false; // G10: 退去時期報告は復唱＋次工程が必要（感謝短返し禁止）
      if (ACK_TOPIC_EXCL_RE.test(forReq)) return false; // 「内覧の件、よろしく」は forReq で名詞句除去済み
      return everyPart((p) => {
        const q = stripDecoration(p);
        return GRATITUDE_POS_RE.test(q) || CLOSER_ONLY_RE.test(q);
      });
    })();

    // ── A-6（G-5）: 「短い了承」ラベル条件と promiseEchoNote 条件の述語統一 ──
    //   buildGenerationMessages 側の promiseEchoNote は isShortAckMsg && !pickupPromiseAckNote && !estimatePromiseAckNote で発火する。
    //   ラベル側も同じ3条件（直前約束あり／ピックアップ約束済みでない／見積約束済みでない）で「短い了承」を立て、それ以外は「感謝返し」に落とす
    // 2026-09-11 統合設計（経路E5）: 台帳が有効な時はピックアップ約束の検出を台帳の未履行約束で絞る（buildGenerationMessages と同じ条件）
    const ledgerPickupOpenForLabel = ACTION_LEDGER_MODE !== "shadow" && !isTemplateOptimize ? ledger.facts.pickupPromisedUnfulfilled : null;
    const shortAckPromiseRaw = detectStaffPromise(lastStaffMsgForSearch ?? "");
    const shortAckPromise = isGratitudeReplyTPO && !isFollowUp && !!shortAckPromiseRaw
      && !(/ピックアップ/.test(shortAckPromiseRaw.label) && ledgerPickupOpenForLabel === false);
    const staffPromisedPickupForLabel = !!lastStaffMsgForSearch
      && /ピックアップ/.test(lastStaffMsgForSearch)
      && /(お送り|送らせて|お届け|送付)/.test(lastStaffMsgForSearch)
      && !lastStaffMsgForSearch.includes("ご査収ください")
      && ledgerPickupOpenForLabel !== false;

    // ── 一時保留（『今動けない状況語』or『後で見る・確認・返信する宣言』に限定。「検討」「考え」は isThinkingMsg に譲る）──
    const isTemporaryLeaveMsg = (() => {
      const msg = (message ?? "").trim();
      if (msg.length === 0 || msg.length >= 80) return false;
      // 2026-09-09 Fable5: 実質あり（予定語のみは可: 「帰ったら見ます」）は一時保留ではない
      if (substance.has && !substance.kinds.every((k) => k === "schedule")) return false;
      if (isConditionPresented || isConditionChangeRequest) return false;
      if (TPO_REQUEST_RE.test(msg)) return false; // 「後日内覧したいです」「Bはまだ空いてますか」等は保留ではない
      // 既読・興味表明は保留ではない（「移動中に見ました！2件目が気になります」）
      if (/見ました|拝見しました|確認しました|確認できました|気になり|気に入|良さそう|よさそう|いいですね/.test(msg)) return false;
      // スタッフへの猶予付与は保留ではない（「確認してからで大丈夫ですよ」）
      if (/で(?:大丈夫|構いません|構わない|OK|オッケー|いいです|結構です)/.test(msg)) return false;
      const explicit = new RegExp([
        "出先|外出中|外出して|移動中|仕事中|勤務中|会議中|接客中|運転中|出張中|電車(?:の中|なので|に乗って)|手が離せ|立て込ん|バタバタ|忙し(?:い|く)(?:ので|ため|て)",
        "(?:後で|あとで|後ほど|のちほど|後日|夜に?|夕方|明日|帰ったら|帰り次第|帰って(?:から|きたら)|落ち着いたら|時間(?:が|の)?(?:ある|空いた)(?:時|とき)に?|ゆっくり)(?:[^、。！!?？\\n]{0,8})?(?:見(?:ま|て|さ|る|よ)|み(?:ます|ておき|とき|る)|拝見|確認|返信|返し|返事|連絡|チェック)",
        "確認(?:次第|出来次第|でき次第)(?:ご|連絡|返信|返事)|確認してから(?:ご?連絡|返信|返事|また|改めて)|見てから(?:ご?連絡|返信)|今は確認|後ほど(?:ご|連絡|返信)",
      ].join("|"));
      return anyPartRestNeutral((p) => explicit.test(p));
    })();

    // ── 検討中（HARD/SOFT 分離＋時間要求型免除。旧 thinkExcl「検討して」は「検討してみます」を殺すデッドコードだった）──
    const isThinkingMsg = (() => {
      const msg = (message ?? "").trim();
      if (msg.length === 0 || msg.length >= 150) return false;
      // 2026-09-09 Fable5: 裸の「検討します」だけが検討中フォロー。懸念・持込予告・質問・条件を含むものは往復文脈（PAIR_MATRIX）へ
      if (substance.has) return false;
      if (isConditionPresented || isConditionChangeRequest) return false;
      // 「相談してから決めたい」「検討した上でお返事します」= 判断保留の定型。HARD の「決めたい」（申込意思）と衝突するため先に除去
      const msgForReq = msg.replace(/(?:相談|検討|考え)(?:して|し|した)?(?:から|上で|後で?|た後で?)(?:決め|お返事|返事|ご?連絡)(?:たい|ます|し|させて)?/g, "");
      if (TPO_HARD_REQUEST_RE.test(msgForReq)) return false;
      if (TPO_SOFT_REQUEST_RE.test(msgForReq) && !TPO_THINK_TIME_REQUEST_RE.test(msgForReq)) return false;
      // スタッフへの検討依頼・比較相談・不安相談・道案内は別TPO（「よろしくお願いします」併記は除外しない）
      if (/(?<!よろしく|宜しく)お願い(?:し|致|いた)|ご検討|検討(?:して|を)(?:ください|下さい|頂|いただ|もらえ|欲しい|ほしい)|検討した結果|道に迷|どちら|どっち|比べ|比較|審査|通るか|落ち(?:る|たら|ない)/.test(msg)) return false;
      // 「〜で/を/と考えてます」は条件・意向表明（「もうちょっと考えます」は救済）
      const thinkRe = /検討(?:します|させて|中です|中で|中なので|してみます|してみる|いたします|致します)|少し検討|考えさせて|(?<![でをはに])(?<!(?<!ちょっ)と)考え(?:てみます|てみる|ます|てます|中|てから)|悩(?:んで|み中)|迷って(?!る場所)|迷います|迷い|どうなのかな|どうかな|考えます|もう少し(?:考|時間|だけ)|時間を(?:ください|下さい|頂|いただ|もらえ)|考える時間|相談(?:して|します|してみ|の上|し(?:てから)?)|持ち帰|決めかね|決められ(?:ない|ず|ません)|決めきれ/;
      return anyPartRestNeutral((p) => thinkRe.test(p) && !/(キャンセル|やめ|断り|他社|他の会社)/.test(p));
    })();

    // ── ネガ文脈（2026-09-08 監査刷新）──
    // ①断り表現を TPO_REQUEST_RE より先に評価（「キャンセルしたいです」到達不能バグ修正）
    // ②brain customer_intent=negative（=懸念・不安）単独判定を廃止し補助証拠に格下げ（不安対応TPOを封殺していた）
    // ③スタッフ側走査を結果報告形・72h以内・代替提案なし・AIX履歴優先に限定 ④isReschedule を前向き日程提案形に限定 ⑤isShortAckOnly 40→80字
    type NegativeDetail = { kind: "withdrawal" | "staff_report" | null; viewingCancel: boolean };
    const negativeDetail: NegativeDetail = (() => {
      const none: NegativeDetail = { kind: null, viewingCancel: false };
      const msg = (message ?? "").trim();
      if (msg.length === 0) return none;
      if (isConditionPresented || isConditionChangeRequest) return none;
      // 2026-09-11 統合設計（経路D）: 断りの語彙は reply-context の CUST_WITHDRAWAL_SRC に一本化（classifyCustomerResponse・resolveClosing と同一定数）
      //   G10（2026-09-08 Fable5）の「退去・解約・引越しは対象名詞必須」、内覧に行けなくなった（isReschedule が先に除外）の規則も同定数に移設済み
      const WITHDRAWAL_SRC = CUST_WITHDRAWAL_SRC;
      const withdrawalRe = new RegExp(WITHDRAWAL_SRC);
      const withdrawalHit = (() => {
        if (!withdrawalRe.test(msg)) return false;
        // G10 二重ガード: 現住居の退去句（「今の家は3月末で解約」等）を除くと断り語が消える → 入居時期情報であって断りではない
        if (moveOutSubject === "current_home" && !withdrawalRe.test(msg.replace(CURRENT_HOME_MOVEOUT_CLAUSE_RE, ""))) return false;
        return true;
      })();
      // 断り句（＋直前の対象名詞「申込の」「内覧」）を除去した残余。残余に質問・依頼が残れば「断り＋質問」なので質問回答パスへ
      const rest = withdrawalHit
        ? msg
            .replace(new RegExp(`(?:お?申(?:し)?込(?:み)?|内覧|内見|見学|見積(?:書)?|契約|予約|審査|お部屋|物件)(?:の|を|は|も)?\\s*(?:${WITHDRAWAL_SRC})`, "g"), "")
            .replace(new RegExp(WITHDRAWAL_SRC, "g"), "")
        : msg;
      // リスケ（キャンセル＋前向きな日程提案）はネガではない。旧 /変更|日に|日程/ は理由説明を誤除外していた
      const isReschedule =
        /キャンセル|延期|ずら|行けなく|伺えなく/.test(msg) &&
        /別日|別の日|改めて|リスケ|日程(?:を|の)?(?:変更|調整|再調整|相談)|(?:来週|今週|明日|明後日|来月|[0-9０-９]{1,2}日|[月火水木金土日]曜)(?:は|に|で|なら|の)?(?:いかが|可能|大丈夫|どう|空い|お願い|希望|都合|変更)/.test(msg);
      if (isReschedule) return none;
      if (TPO_REQUEST_RE.test(rest)) return none;
      if (/また探し|再開|新し(?:い|く)条件|(?:別|他)の(?:物件|お部屋)(?:も|を|は|が|、)?(?:探|見|紹介|お願い|あれ|あり|教え)/.test(rest)) return none;
      if (withdrawalHit) {
        const viewingCancel = /内覧|内見|見学|案内|行けな|伺えな/.test(msg) && !/他社|他の(?:会社|仲介)|決め(?:ました|た)|辞退|解約|退去/.test(msg);
        return { kind: "withdrawal", viewingCancel };
      }
      // スタッフ側走査: 顧客が短い了承のみを返した場合に限定（除外は上流の TPO_REQUEST_RE／再開語で担保済み）
      const isShortAckOnly = msg.length <= 80 && /ありがとう|承知|かしこまり|わかりました|分かりました|了解|残念|そうでしたか|そうですか|仕方|しょうがない|ご縁/.test(msg);
      if (!isShortAckOnly) return none;
      // AIX履歴の最新が「募集終了報告」なら決定論で確定（brain-core L1656: 「最新:<aix_type>(...)(結果:<check_pattern>)」）
      const aixSaysUnavailable = /最新:property_check_result[^\s→]*結果:unavailable/.test(lastAixHistoryText ?? "");
      // 72時間より前のスタッフ発言は固着させない（createdAt 欠落時は従来通り走査）
      const staffAgeMs = tpoLatestStaff?.createdAt ? Date.now() - new Date(tpoLatestStaff.createdAt).getTime() : null;
      if (staffAgeMs !== null && staffAgeMs > 72 * 60 * 60 * 1000) return none;
      // スタッフが同時に代替提案をしている場合はネガではない（顧客は提案への感謝を返している）
      if (/https?:\/\/|代わり|かわり|こちら(?:は|も|など)?(?:いかが|おすすめ|オススメ)|ピックアップ|ご紹介|おすすめ|オススメ/.test(tpoLatestStaffText)) return none;
      // 結果報告形に限定（事前確認宣言・仮定説明・安心材料説明を除外）
      const staffHypothetical = /確認(?:し|いた|させ)|場合|たら|もし|ご安心|ほとんど/.test(tpoLatestStaffText);
      const staffNegResultRe = /否決|不承認|募集終了(?:でした|となって|しており|していました|とのこと|です)|埋まって(?:しまい|おり|いました|しまって)|満室(?:でした|となって|とのこと)|先約|他の方で決まり|申込が入って(?:しまい|おり)|審査.{0,8}(?:通らな|通りません|落ち|NG|見送り|承認が(?:下り|おり)ません|難しい)(?:かった|でした|ました|となり|とのこと|になり|と)/;
      const staffSaysNeg = !staffHypothetical && staffNegResultRe.test(tpoLatestStaffText);
      // ブレイン由来は補助証拠のみ（customer_intent=negative は「懸念・不安」定義であり断りではない）
      const brainCorroborates =
        brainFreshForMessage &&
        lastCustomerMsgAt != null &&
        brainMeta?.engagement_stance === "wait" &&
        brainMeta?.customer_intent === "negative";
      return (aixSaysUnavailable || staffSaysNeg || brainCorroborates) ? { kind: "staff_report", viewingCancel: false } : none;
    })();
    const isNegativeContext = negativeDetail.kind !== null;
    const isViewingCancel = negativeDetail.viewingCancel;

    // ── 強推し直後の了承（2026-09-08 監査FIX: 旧実装はヘッダー「（新→旧順）」の→で split され恒久 false）──
    const isPostStrongRecommendation = (() => {
      // 2026-09-09 Fable5: 実質あり（懸念・質問・条件）は「了承」ではない
      if (isNegativeContext || isConditionPresented || substance.has) return false;
      const msg = (message ?? "").trim();
      // 了承の受け口: 感謝返し OR 「確認・閲覧系の短い了承」（強推し文脈でのみ採用）
      const isViewAck = msg.length > 0 && msg.length < 60 &&
        !TPO_REQUEST_RE.test(msg) &&
        everyPart((p) => /確認(?:して|させて)?(?:み|いただき|頂き)?ます|見て(?:み|おき)ます|拝見(?:し|いたし|致し)ます|チェック(?:して|し)(?:み)?ます|目を通(?:し|させて)/.test(p) || TPO_NEUTRAL_ACK_RE.test(p));
      if (!isGratitudeReplyTPO && !isViewAck) return false;
      if (!brainFreshForMessage) return false; // T2（stale）では last_aix_history が前メッセージ時点
      // 「最新:」ラベル以降を抽出（split 廃止）。property_check_result(結果:available) は前進フェーズのため対象外
      const latestAction = /最新:([^\s→]+)/.exec(lastAixHistoryText ?? "")?.[1] ?? "";
      if (!/^property_recommendation\b/.test(latestAction)) return false;
      // 時間境界: 直近スタッフ1通が AIX 推薦文であること（数日後の別件感謝に PSR が乗る FP を防ぐ）
      if (!tpoLatestStaff) return false;
      const looksLikeRecommendation = /オススメ|おすすめ|お薦め|特に|イチオシ|一押し|こちらの(?:物件|お部屋)|ご検討/.test(tpoLatestStaffText);
      return !!tpoLatestStaff.isAix || looksLikeRecommendation;
    })();

    // ── 2026-09-09 Fable5 往復文脈: 顧客返答の分類 → PAIR_MATRIX の単一 verdict（generate / final-check / tpo_debug で同一オブジェクト）──
    //   あみ（内覧打診→2階懸念）・みく（見積送付→持込予告）は待ち系TPOゼロ発動で AIX_ACTION_REPLY_DIRECTION（内覧誘導禁止／オススメ1件）と
    //   4文字ラベル「物件送付後」が生成文を作っていた。往復ペアで方向性を確定し、override_wait セルは待ち系TPO・AIX action より先に return する
    const customerResponse = classifyCustomerResponse(substance, lastStaffTurn, {
      isThinkingMsg, isTemporaryLeaveMsg, isConditionChangeRequest, isConditionPresented,
      negativeKind: negativeDetail.kind,
      brain: brainLocalFresh ? brainLocal : null,       // conversation-scope は型として渡せない
      // 2026-09-10 Fable5 Sさん事例: 送付済み物件名との照合（物件名のみの短文を前向き反応に昇格させる一次証拠）
      ledger: ledgerForCtx,
    });
    // ── 2026-09-09 Fable5 みく事例: ヘッジ許容（探索済み証拠 > 顧客の疑問形質問 > 禁止）。pairContext より先に計算し PAIR_MATRIX の探索済みセル選択にも使う
    //   生成（latent_intent / winning_pattern / closing_strategy / customer_questions / conditionDirection / 【姿勢】）・検査（final-check runHedgeChecks）・tpo_debug が同一 verdict
    // 生成する返信自体が AIX 物件送付文（成果物添付）＝「こちらの物件」「お送りした」は添付物を指す（台帳ゲートの deliverable 免除と同値）
    const isAixPropertySendMode = !!aixSourceMessage && STAFF_SEARCHED_RE.test(aixSourceMessage);
    // G31/G32: この返信自体が「約束した結果」を届けるか（AIX 物件送付 or 確認結果・見積テンプレを本文に持つ）。resolveOpener の deliverable（開口語なし）根拠
    const isAixCheckResultMode = !!aixSourceMessage && (STAFF_CONFIRM_REPORT_RE.test(aixSourceMessage) || STAFF_ESTIMATE_RE.test(aixSourceMessage));
    const isDeliverableReplyForGreeting = isAixPropertySendMode || isAixCheckResultMode;
    const hedge: HedgeVerdict = resolveHedgeAllowance({
      customerMessage: message ?? "",
      substance,
      staff: lastStaffTurn,
      customer: customerResponse,
      lastStaffText: lastStaffMsgForSearch || tpoLatestStaffText || "",
      lastCustomerAt: lastCustomerMsgAt,
      recentAixRows,
      lastAixHistory: lastAixHistoryText,
      isAixPropertySendMode,
      ledger: ledgerForCtx,
    });
    console.info("[hedge]", JSON.stringify({ allowance: hedge.allowance, searched: hedge.searched, asked: hedge.customerAsked.yes, selfHedge: hedge.customerSelfHedge.yes, statedRelax: hedge.customerStatedRelax.yes }));
    // 2026-09-10 Fable5 Sさん事例: customerName は {viewingOffer} リテラルの生成に必須。
    //   brainCurrentProperty は conversation-scope なので「名前を作る根拠」にはせず corroboration（記録）のみ
    // 2026-09-11 統合設計（経路D）: 直前スタッフ発言より前の顧客発言（断り→スタッフ締め→お礼 の往復で締め verdict を立てる）
    const priorCustomerText = (() => {
      const lastStaffIdx = recentMessages.map((m) => m.sender).lastIndexOf("staff");
      if (lastStaffIdx < 0) return "";
      return [...recentMessages.slice(0, lastStaffIdx)].reverse().find((m) => m.sender === "customer")?.text ?? "";
    })();
    const pairContext: PairContext = resolveTurnPair(lastStaffTurn, customerResponse, substance, lastStaffMsgForSearch || tpoLatestStaffText || "", {
      searched: hedge.searched.yes, ledger: ledgerForCtx,
      customerName: customerName ?? "", brainCurrentProperty: brainStrategy?.current_property ?? null,
      priorCustomerText,
    });
    // ── 2026-09-11 統合設計（経路F1・YUYA/it_0 事例）: aixDone.propertySend（aix_usage_logs 72h 窓）を台帳・往復文脈と整合させる ──
    //   送付後の未履行ピックアップ宣言／顧客の条件変更／ピックアップ宣言を必須要素に持つセルでは「再宣言禁止」にしない。
    //   生成ノート（aixDoneAckNote）・後処理（validateAndClean aixPickupDone）・検査（finalCheckCtx.aixDone）が同じ値を見る（四者同名）。
    //   asksNewPickup（AIX_CONDITION_CHANGE_RE）はログ用に残し、判定は往復文脈 verdict に一本化する
    const pickupGate = resolvePickupGate(!!aixDone?.propertySend, pairContext);
    if (aixDone) {
      if (aixDone.propertySend !== pickupGate.redeclareBlocked) console.info("[pickup-gate]", JSON.stringify({ before: aixDone.propertySend, after: pickupGate.redeclareBlocked, reason: pickupGate.reason }));
      aixDone.propertySend = pickupGate.redeclareBlocked;
      aixDone.pickupGateReason = pickupGate.reason;
      if (!pickupGate.redeclareBlocked) aixDone.labels = aixDone.labels.filter((l) => !/物件(?:ピックアップ|おすすめ)送付/.test(l));
    }
    // 2026-09-10 Fable5: セル必須要素 × brain 方針の衝突。avoid を削る前に「セル選択を疑う」ための記録
    const cellConflicts: CellConflict[] = detectCellConflicts(pairContext, brainStrategy, brainLocalFresh);
    pairContext.conflicts = cellConflicts;
    if (cellConflicts.length) console.warn("[cell-conflict]", JSON.stringify(cellConflicts));
    if (pairContext.cellGuard.concernDemoted) console.warn("[cell-guard]", pairContext.cellGuard.reason);
    const pairDirection = buildPairDirection(pairContext, {
      brainReplyDirection: brainStrategy?.reply_direction ?? null, brainFresh: brainLocalFresh, strategy: brainStrategy,
    });
    // ラベル: tpoNoteForLLM ↔ prompts「■ 場面【…】」↔ final-check WAIT_TPO_RE（after_wait の検討中セルは「検討中フォロー」を含めて WE DO 免除を維持）
    const pairTpoLabel = pairContext.rule ? `${pairContext.rule.tpoLabel}（往復: ${pairContext.summary}。${pairContext.rule.length}）` : null;
    console.info("[turn-pair]", JSON.stringify({ staff: lastStaffTurn.kind, customer: customerResponse.kind, secondary: customerResponse.secondary, object: customerResponse.object, ruleId: pairContext.ruleId, precedence: pairContext.rule?.precedence ?? null }));

    // ── 感謝返しの具体アクションを直前スタッフ発言から決定論で1つ選ぶ（LLM に選ばせない）──
    const gratitudeActionHint: string = (() => {
      const s = tpoLatestStaffText;
      // 2026-09-11 統合設計（経路E5/B）: ピックアップ約束の復唱は台帳に未履行約束がある時だけ（台帳有効時）。顧客名はスロットで埋める
      const pickupOpen = ledgerPickupOpenForLabel !== false;
      if (pickupOpen && /ピックアップ/.test(s) && /(お送り|送らせて|お届け|送付)/.test(s) && !/ご査収/.test(s))
        return "「ピックアップ出来次第お送りさせて頂きます！！」（ピックアップは約束済み。条件列挙・初期費用割引文の再掲禁止）";
      if (/ご査収|お送りしました|お送りさせて頂きました|お送りいたしました|添付/.test(s))
        return pickupOpen
          ? `「お手隙の際にご査収ください😌！！」＋「${fillNameSlot("私の方でも{name}にオススメできるお部屋ピックアップ出来次第お送りさせて頂きます！！", customerName ?? "")}」（主語はスタッフ。「確認でき次第ご連絡」は主語混乱のため禁止）`
          : "「お手隙の際にご査収ください😌！！」（主語はスタッフ。「確認でき次第ご連絡」は主語混乱のため禁止。台帳に無いピックアップ約束を新たに書かない）";
      if (/管理会社|オーナー|交渉|空室確認|募集状況|確認(?:して|させて|いたし)/.test(s)) {
        // G26（2026-09-08 Fable5）: 確認対象を必ずリテラルで書く（対象の無い「確認出来次第ご連絡」は創作約束として final-check で block）
        const obj = findConfirmObject(s) ?? (/交渉/.test(s) ? "家賃・条件交渉の可否" : "募集状況");
        return `「${obj}確認出来次第ご連絡させて頂きます！！」（確認対象「${obj}」を必ず書く。「すぐに」禁止）`;
      }
      if (/見積|御見積|初期費用/.test(s))
        return "「気になる点等ございましたらいつでもお気軽にご連絡ください！！」（「ご検討の程」の再掲は絶対禁止）";
      if (/内覧|内見|ご案内|待ち合わせ/.test(s))
        return "「当日は現地にてお待ちしております！！」（日時または場所を1つだけ復唱）";
      return "「気になる点等出てきましたらいつでもお気軽にご連絡ください！！」";
    })();
    // ── 2026-09-09 Fable5 みく事例: 締め verdict（断り＞成果物＞日程＞検討中＞質問＞セル指定＞具体宣言あり節目）。生成前は「宣言はこれから書く」前提の予測 ──
    //   旧 conditionDirection は3行目を「ピックアップ出来次第…何卒」に固定し「全力でサポート」を禁止語にしていた（正解の伴走締めを構造的に出せず、LLM が禁止された締めの穴をヘッジ文で埋めていた）
    const closerVerdict: CloserVerdict = resolveCloser(
      pairContext,
      predictCloserSignals({ aixSourceText: aixSourceMessage }),
      { customerName: customerName ?? "", isFirstContact: isFirstEverReplyFromMsgs, asksCustomerTask: false, ledger: ledgerForCtx },
    );
    console.info("[closer]", JSON.stringify({ closer: closerVerdict.closer, nanisotsu: closerVerdict.nanisotsu, reason: closerVerdict.reason }));
    // ── 条件提示の方向性（抽出値をリテラル埋め込み・3〜4行構成固定。締めは closerVerdict のリテラル）──
    const conditionDirection: string = (() => {
      const areaTxt = conditionDetail.areas.length ? conditionDetail.areas.join("・") : "（顧客文中のエリア名をそのまま）";
      const rentTxt = conditionDetail.rent ?? "（顧客文中の家賃表記をそのまま）";
      const answerFirst = conditionDetail.hasRequest ? "顧客の質問・依頼が併記されているので、2行目の前に1文で直接回答すること。" : "";
      const closerLines = closerVerdict.text ? closerVerdict.text.split("\n") : [];
      const line3 = closerLines[0] ? `3行目「${closerLines[0]}」（単独行）。` : "3行目は行動宣言で終える（追加締めなし）。";
      const line4 = closerLines[1] ? `4行目「${closerLines[1]}」。` : "";
      return `条件提示（エリア=${areaTxt} / 家賃=${rentTxt}）。3〜4行構成で100〜180字。` +
        `1行目「かしこまりました！！」（単独行）。${answerFirst}` +
        `2行目：「${areaTxt}周辺全域から${rentTxt}」＋顧客が書いた付帯条件（間取り・徒歩分・築年・設備・管理費込 等）を原文の語のまま列挙して「〇〇さんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！」。` +
        line3 + line4 +
        `禁止：2行目の具体宣言の代わりに「ご条件に合ったお部屋」「全力でサポート」「お探しします」等の抽象語だけで済ませること（3行目の締めとしての伴走宣言は必須）／「新着あれば」「日々更新」等の受け身文／「本日中」「なるべく早く」等の時間約束／足りない条件の聞き返し（まず送る）／「〜をご希望ですね」の単体確認文／条件の実現可能性への言及（難しい・厳しい・少ない・可能性・かもしれません）／条件緩和・代替案の先回り提案（条件を1つ変えた場合・優先順位・妥協・〇〇未満まで広げる）／顧客の自己ヘッジ「難しいと思う」「あれば教えて」の復唱。エリア名と家賃表記は必ず原文どおり本文に埋め込むこと`;
    })();
    const effectiveReplyDirection: string | null = (() => {
      if (isConditionPresented) return conditionDirection;
      if (isViewingCancel) return "内覧キャンセルの受け止め（50〜100字）。開口語は「かしこまりました！！」（単独行）。謝罪・残念語禁止。「またご都合の良い日がございましたらいつでもお申し付けください」の1文で別日を軽く開放するのみ。物件追加提案・申込誘導禁止";
      if (negativeDetail.kind === "withdrawal") return "顧客自身の断り・キャンセルの受け止め（50〜110字）。開口語は「かしこまりました！！」（単独行）。2行目「またお部屋探しの際はいつでもお気軽にご連絡ください😊！！」で扉を開け、3行目「この度はありがとうございました！！」で締める。謝罪禁止・「申し訳ございません」「残念ながら」等のネガティブ語禁止・引き留め提案（他にもオススメ〜）禁止・「かしこまりました！！」単独終了禁止";
      if (negativeDetail.kind === "staff_report") return "否決・募集終了報告への短い了承に対する受け止め（50〜110字）。開口語は「はい！！」（感謝・了承に「かしこまりました」は使わない）。2行目は顧客名先頭のサポート継続宣言（「〇〇さんにご満足頂けるお部屋が見つかるまでお部屋探し継続し全力でサポートさせて頂きます😌！！」）。3行目に次の一手を1文（別保証会社でご案内可能なお部屋／新着ピックアップ出来次第お送り）。謝罪・「残念ながら」禁止・会話終了の受け身締め禁止";
      // G10（2026-09-08 Fable5）: 顧客の現住居の退去・引越し時期報告は離脱ではなく入居時期情報。復唱＋逆算した入居時期の確認→探索継続
      if (moveOutSubject === "current_home" && !isConditionPresented && !isConditionChangeRequest)
        return "入居時期情報（お客様ご自身の現住居の退去・引越し時期の報告。探索継続）。開口語「かしこまりました！！」（単独行）→退去時期を復唱して逆算した入居時期を1文で確認（例「〇月末ご退去との事ですので〇月ご入居に向けて」）→ピックアップ宣言 or 未取得条件のヒアリング1問。会話終了・お礼締め・「またお部屋探しの際は」・謝罪禁止。60〜120字";
      // 2026-09-09 Fable5 往復文脈: override_wait セル（懸念・持込予告・質問・条件変更）は待ち系TPO・AIX action より先に確定
      if (pairContext.rule?.precedence === "override_wait" && pairDirection) return pairDirection;
      if (isTemporaryLeaveMsg) return "顧客が今は確認できない・後で連絡すると伝えている。30〜60字の超短文で受け取り、待ちの姿勢を示す。開口語は「はい😊！！」（単独行）一択。「承知いたしました」「ご連絡お待ちくださいませ」禁止。この場面では具体アクション宣言は不要（何も宣言しない）。物件追加・内見誘導・条件ヒアリング・長文説明は一切禁止";
      if (isThinkingMsg) return "検討中の待ちフェーズ。70〜130字の短返し。開口語は「はい😊！！」（単独行）。①「ごゆっくりご検討頂けますと幸いです！！」（命令形「ごゆっくりご検討ください」は不可）②直前送付物への次ステップ1文（「お気に召されましたらご内覧頂けます／お申込しお部屋抑えさせて頂きます」）は必ず入れる③気になる点出てきましたらいつでもお気軽にご連絡ください。「かしこまりました！！」単独終了・申込誘導・希少性煽り（人気のため早めに）・物件追加提案・「ご検討の程よろしく」の再掲は絶対禁止";
      if (isPostStrongRecommendation) return "強推し直後の了承。開口語は「はい😊！！」一択（「かしこまりました」「承知いたしました」禁止）。①感謝を1行で受け取る②直前に推薦したお部屋（物件名は書かず「先ほどのお部屋」。2026-09-11 竹内方針2）をお手隙の際にごゆっくりご確認いただく旨1文③ご内覧・ご不明点はいつでもお申し付けくださいの開放1文④締め。合計50〜110字。他物件の募集確認・新規ピックアップ宣言・別物件の提案・申込誘導・「ご検討の程よろしくお願いします」の再掲は絶対禁止。顧客が「見てみます」（未来形）なら「ご覧頂きありがとう」等の既読扱いも禁止";
      if (isGratitudeReplyTPO) return `感謝を1行で受け取り、次のアクション文を1つだけ添える: ${gratitudeActionHint}。合計40〜130字。開口語は「はい😊！！」（単独行）一択（「かしこまりました」「承知いたしました」禁止）。締めは「何卒よろしくお願い致します！！」。上記以外のアクション・予告のみの進捗テンプレ・条件の再ヒアリング・情報追加は絶対禁止`;
      // A-13: 不安対応（applying より先に評価。謝罪は「ご不安にさせてしまい申し訳ございません」の1文のみ許可）
      if (isAnxietyMsg) return "不安対応（100〜150字）。開口語は「はい😊！！」または受け止め1文から。①不安を1文で受け止める（謝罪が必要な場合のみ「ご不安にさせてしまい申し訳ございません」の1文まで）②具体的な安心材料を1つだけ添える（保証会社通過までキャンセル料なし／独立系保証会社で再審査可／審査3〜10日 等・履歴にある事実のみ）③次アクション1文。「大丈夫ですよ」「ご安心ください」の根拠なし安心づけ禁止";
      // 2026-09-09 Fable5 往復文脈: after_wait セル（内覧受諾・検討中・回答受領・了承）は AIX action より先（brain の正しい reply_direction が L3735 で action に負けて捨てられていた）
      if (pairContext.rule && pairDirection) return pairDirection;
      // A-7 / S-3: brain action が有効（fresh）なら顧客向け方向性に変換して採用（スタッフ操作文は注入しない）
      if (effectiveAction && AIX_ACTION_REPLY_DIRECTION[effectiveAction]) {
        const d = AIX_ACTION_REPLY_DIRECTION[effectiveAction];
        return `${d.direction}。WE DO例:「${d.weDo}」。禁止: ${d.forbid}`;
      }
      // S-3: reply_direction は message-local。fresh の時のみ採用し、stale なら state 別フォールバックへ
      if (brainFreshForMessage && !isCachedMeta && brainMeta?.reply_direction) return brainMeta.reply_direction;
      // 2026-09-10 Fable5 Sさん事例（原因D）: T3（suggested_aix_meta=null）でも last_brain_meta の
      //   conversation-scope な reply_direction は「会話全体の方針」として使える（1メッセージ古くても壊れない）。
      //   brain-sweep が「5分以内に補填する」というコメントは実測 899/900 失敗で虚偽だった。
      if (brainStrategySource === "last_brain_meta" && brainStrategy?.reply_direction) {
        return `${brainStrategy.reply_direction}（※直近の分析結果に基づく会話全体の方針。今回のメッセージの中身は本文から読み取ること）`;
      }
      // A-4: state 別フォールバック（固定文「WE DO宣言を1文添える」の廃止）
      return STATE_FALLBACK_DIRECTION[phaseGuideKey] ?? null;
    })();
    const effectiveKeyTopics: string[] = (() => {
      // S-3: key_topics も message-local。stale/cached では採用しない
      const freshTopics = brainFreshForMessage && !isCachedMeta ? (brainMeta?.key_topics ?? []) : [];
      if (isConditionPresented) {
        return freshTopics.length > 0 ? freshTopics : ["エリア・家賃条件を受け取り即ピックアップ宣言"];
      }
      // 2026-09-09 Fable5 往復文脈: セルの必須要素を「必ず含める内容」に（final-check PAIR_ELEMENT_MISSING と同名）
      if (pairContext.rule) return pairContext.rule.mustInclude.map((m) => m.label);
      if (isNegativeContext) return [];
      if (isTemporaryLeaveMsg) return [];
      if (isThinkingMsg) return [];
      if (isPostStrongRecommendation) return []; // 待ちフェーズ：余計なアクションを足さない
      if (isGratitudeReplyTPO) return freshTopics.slice(0, 1);
      return freshTopics;
    })();
    const effectiveAvoidTopicsBase: string[] = (() => {
      const base = brainMeta?.avoid_topics ?? [];
      if (isConditionPresented) return [...new Set([...base, "条件の再ヒアリング", "見積提案", "申込誘導", "内見誘導", "抽象的なサポート宣言"])];
      if (isViewingCancel) return [...new Set([...base, "物件提案", "見積提案", "申込誘導", "謝罪"])];
      if (negativeDetail.kind === "withdrawal") return [...new Set([...base, "物件提案", "見積提案", "申込誘導", "引き留め", "謝罪"])];
      if (negativeDetail.kind === "staff_report") return [...new Set([...base, "見積提案", "申込誘導", "謝罪"])];
      // 両方 true（「出先なので後ほど検討します」）は thinking の禁止セットも和集合にする
      if (isTemporaryLeaveMsg) return [...new Set([...base, "物件提案", "見積提案", "申込誘導", "条件ヒアリング", "詳細説明", ...(isThinkingMsg ? ["希少性煽り", "内見誘導", "物件追加提案"] : [])])];
      if (isThinkingMsg) return [...new Set([...base, "申込誘導", "希少性煽り", "内見誘導", "物件追加提案", "条件ヒアリング", "検討依頼の繰り返し"])];
      if (isPostStrongRecommendation) return [...new Set([...base, "他物件の募集状況確認", "新規物件ピックアップ", "別物件の提案", "申込誘導", "検討依頼の繰り返し", "初期費用割引の再掲"])];
      if (isGratitudeReplyTPO) return [...new Set([...base, "検討依頼の繰り返し", "中身のない進捗テンプレ", "条件の再ヒアリング"])];
      // A-3: brain action=follow_up 経由の「検討中フォロー」ラベル（tpoNoteForLLM 後段）にも isThinkingMsg と同じ禁止セットを乗せる
      //      S-3: followup_revive は effectiveAction で常に null に落ちるため、ラベル側と同じく rawAction ではなく「検討中フォロー」条件（isThinkingMsg）で担保する
      return base;
    })();
    // 2026-09-09 Fable5 往復文脈: セルの禁止事項（mustNot）を和集合
    const effectiveAvoidTopics: string[] = pairContext.rule
      ? [...new Set([...effectiveAvoidTopicsBase, ...pairContext.rule.mustNot])]
      : effectiveAvoidTopicsBase;
    // 顧客が最新メッセージで自ら言及した語は avoid_topics から除外
    // （stale brain_meta の avoid_topics が現在の質問を封じる逆転を防ぐ）
    // 2026-09-09 Fable5: 往復セルの必須要素と衝突する avoid（ES_WILL_SEND で brain avoid_topics「見積書」が必須要素「御見積書とあわせて」と衝突）も除外
    // 2026-09-10 Fable5 みく事例: 部分文字列一致 → 意味クラス一致（「新規物件ピックアップ」と「再ピックアップ宣言」を衝突と認識する）
    const activeAvoidTopics = effectiveAvoidTopics.filter(t =>
      !(message ?? "").includes(t) && !avoidConflictsWithCell(pairContext, t)
    );
    // TPO場面をLLMに明示（fetchKnowledge内のtpoLabelはRAGのみに使われLLMには届かないため、ここで場面を伝える）
    const tpoNoteForLLM: string | null = (() => {
      if (isConditionPresented) return "条件提示（顧客がエリア・家賃条件を提示。かしこまりました！！→条件を行動宣言に埋め込み→即ピックアップ宣言の3行。100〜180字）";
      // 2026-09-09 Fable5 往復文脈: override_wait セル（提案後の懸念／提案後の検討・持込予告／質問回答／条件変更）は待ち系ラベルより先
      //   ラベルは WAIT_TPO_RE 非該当語のみ（final-check の WE DO 免除を受けない）
      if (pairContext.rule?.precedence === "override_wait" && pairTpoLabel) return pairTpoLabel;
      // G10（2026-09-08 Fable5）: 現住居の退去・引越し時期の報告は入居時期情報（探索継続）。effectiveReplyDirection の同名分岐と対
      if (moveOutSubject === "current_home" && !isConditionPresented && !isConditionChangeRequest && negativeDetail.kind === null) return "入居時期情報（現住居の退去・引越し時期の報告。探索継続）";
      if (isViewingCancel) return "内覧キャンセル（別日開放のみ。物件追加・申込誘導禁止。50〜100字）";
      if (isNegativeContext) return negativeDetail.kind === "withdrawal"
        ? "ネガ文脈（顧客自身の断り・キャンセル。開口語「かしこまりました！！」→扉を開ける1文→お礼で締め。引き留め禁止）"
        : "ネガ文脈（否決・募集終了報告への短い了承。開口語「はい！！」→顧客名先頭のサポート継続宣言→次の一手1文。謝罪禁止）";
      if (isTemporaryLeaveMsg) return "一時保留（顧客が今は確認できない・後で連絡すると宣言。30〜60字の超短返しのみ。「承知いたしました」絶対禁止）";
      if (isThinkingMsg) return "検討中フォロー（顧客がまだ迷っている・判断保留。急かさない。申込誘導・希少性煽り絶対禁止。70〜120字）";
      if (isPostStrongRecommendation) return "強推し直後の了承（1件に絞って推薦済み・顧客が確認/了承中の待ちフェーズ。再ピックアップ宣言・別物件提案は絶対禁止。開口語「はい😊！！」）";
      // 2026-09-08 語彙セマンティクス: 直前スタッフ約束が検出できる短い了承は「短い了承（約束の復唱）」場面に固定
      //（buildGenerationMessages の promiseEchoNote / final-check の WAIT_TPO_RE・GRATITUDE_OPENING と同名）
      // A-6（G-5）: ラベル条件と promiseEchoNote の条件を同一述語 shortAckPromise に統一。
      //   pickupPromiseAckNote / estimatePromiseAckNote が出る場面（ピックアップ約束済み・見積約束済み）は promiseEchoNote が出ないためラベルを「感謝返し」に落とす
      if (shortAckPromise && !staffPromisedPickupForLabel && !estimatePromised) return "短い了承（直前スタッフ約束への了承。開口語「はい😊！！」→直前約束の復唱WE DO 1文→締め。約束に無い業務語彙（撮影・ご査収・内覧日程）を持ち出さない。40〜90字）";
      if (isGratitudeReplyTPO) return "感謝返し（短い了承・感謝メッセージ。開口語「はい😊！！」一択）";
      // A-13（B-6）: 不安対応は applying / brain action ラベルより先に評価（applying 中の「審査落ちたら…」が「申込後説明」に落ちていた）
      if (isAnxietyMsg) return "不安対応（顧客が審査・費用・手続きに不安。まず不安を受け止め、具体的な安心材料を1つだけ添える。100〜150字以内。「大丈夫ですよ」の軽い返しは避ける。謝罪は「ご不安にさせてしまい申し訳ございません」の1文のみ可）";
      // S-3: action は effectiveAction（鮮度ゲート済み）のみ参照。stale action から「内覧調整」「申込打診」ラベルが立たない
      const a = effectiveAction ?? "";
      // A-4: applying は「短い了承」→「申込後説明（本文付き）」の順
      if (phaseGuideKey === "applying") {
        if (isGratitudeReplyTPO) return "短い了承（applying。開口語「はい😊！！」＋履歴にある直近約束（審査結果連絡/書類確認/契約案内）の復唱1文＋締め。40〜90字）";
        return "申込後説明（申込・審査・契約手続き中。書類受領／審査進捗／契約案内のいずれかに直接回答し、別物件提案・再ピックアップ・条件ヒアリング・内覧提案は書かない。60〜150字）";
      }
      // 2026-09-09 Fable5 往復文脈: after_wait セル（内覧調整／検討中フォロー／申込打診／顧客回答の受領 等）は AIX action 由来の4文字ラベルより先
      if (pairContext.rule && pairTpoLabel) return pairTpoLabel;
      if (a === "viewing_invite" || a === "meeting_place") return "内覧調整";
      if (a === "application_push") return "申込打診";
      // 2026-09-09 Fable5: substance.has=false の純粋了承のみ到達するので骨格を持たせる（旧「物件送付後」4文字ラベルは骨格指示ゼロだった）
      if (a === "property_send" || a === "property_recommendation")
        return "物件送付後の了承（開口語「はい😊！！」→直前送付物件をごゆっくりご確認いただく1文→ご不明点・ご内覧はいつでもお申し付けください→締め。40〜100字。「かしこまりました」単独終了不可）";
      if (a === "estimate_sheet") return "費用説明";
      // 内見フェーズ専用TPO（修正率91.3%の原因: viewingに対応するTPO分岐がなかった。S-2 で phaseGuideKey=viewing が到達可能に）
      const msg2 = message ?? "";
      if (phaseGuideKey === "viewing") {
        const isPostView = /どうでした|どうでしたか|気に入|気に入り|申込|決め|考え|いかが|ご感想|雰囲気/.test(msg2);
        if (isPostView) return "内見後クロージング（内見を終えた顧客への返信。感想を1文で聞き、気に入った場合は申込を自然に促す文を添える。100〜150字）";
        return "内見調整（日時・場所の確認・調整。顧客名先頭の簡潔な返し。30〜80字）";
      }
      if (phaseGuideKey === "closed_won") return "成約後サポート（質問に直接回答し「ご入居までしっかりサポートさせて頂きます」で締める。申込打診・ピックアップ・見積・内覧禁止。60〜120字）";
      // 2026-09-09 行動台帳: 「再度／改めて」は台帳に送付実績がある時だけ（ledgerRedo）
      if (phaseGuideKey === "closed_lost") return `失注後の再接触（「お世話になっております」→再連絡への感謝1文→${ledger.facts.redoAllowed ? "改めて" : ""}以前のご条件を基にしたピックアップ宣言→サポート継続宣言。初回挨拶・謝罪・フォーム再送禁止。80〜140字）`;
      // A-4: proposing で action が無い場合は「懸念→条件変換」「進捗催促対応」「商談継続」の3分岐
      if (phaseGuideKey === "proposing" && !a) {
        if (/狭い|暗い|遠い|古い|うるさい|微妙|ちょっと|イマイチ|いまいち|気になる点/.test(msg2) && !TPO_REQUEST_RE.test(msg2)) {
          return `懸念→条件変換（顧客の感想・懸念語を条件語に変換し「かしこまりました！！〇〇（変換後条件）のお部屋を中心に〇〇さんにオススメできるお部屋${ledger.facts.redoAllowed ? "再度" : ""}ピックアップしお送りさせて頂きます！！」。共感文だけの返信は不合格。80〜130字）`;
        }
        // G32: 進捗催促の判定は greeting.ts isProgressPushMessage と同名（了承のみは催促に数えない）
        if (isProgressPushMessage(message, { isAckOnly: substance.isAckOnly })) {
          return "進捗催促対応（「ご連絡遅くなり申し訳御座いません。」＋現状事実1文＋次アクション1文。100〜150字。「お待たせ致しました」「確認中です」禁止）";
        }
        // 2026-09-10 Fable5 Sさん事例: WE DO 候補に内覧のご案内提案を追加（STATE_FALLBACK_DIRECTION.proposing と同じ列挙＝四者同名）
        return "商談継続中の汎用返答。顧客の質問・要望を1文で受け止め、具体的な行動宣言を1つだけ添えて100〜150字で返す（次のいずれか1つ: ①内覧のご案内提案「よろしければ〇〇さんご都合よろしいお日にちにお部屋ご案内させて頂きます😌！！」＝具体的な候補日時は書かない（AIX【内覧日調整】専用）②募集状況の確認 ③御見積書の作成・送付 ④ご条件に合うお部屋のピックアップ ⑤家賃・条件の交渉）。初期費用・家賃交渉の場合は「最大限交渉させて頂きます！！」等の具体表現を使う。抽象的な「確認します」禁止";
      }
      return null;
    })();

    // H7(Fable5) + AIX-META一元化(2026-08) + Step1廃止(2026-08):
    // brainMeta が唯一の戦略指示（＋message-local戦術）としてプロンプトに注入される。
    // AIX-META が存在する場合、buildGenerationMessages 側の closingNote（ai_summary由来の
    // フォールバック戦略）は注入されない（brainGuidanceNote 非空をシグナルとして抑制される）。
    const brainGuidanceNote = (() => {
      if (!brainMeta) return "";
      // S-3: action は鮮度ゲート済みの effectiveAction を基準にする（stale action を「必須」として注入しない）
      const hasAction = !!effectiveAction;
      const hasStrategy = !!(brainMeta.closing_strategy || brainMeta.next_steps?.length);
      const hasExtendedFields = !!(
        brainMeta.reply_direction ||
        brainMeta.key_topics?.length ||
        brainMeta.avoid_topics?.length ||
        brainMeta.urgency_appropriate === false ||
        brainMeta.recommended_tone ||
        brainMeta.template_hint
      );
      // Step1移植: message-local戦術フィールド（鮮度ゲート通過時のみ発火）
      // 2026-09-09 Fable5 みく事例: 未探索（forbid_preemptive）の時は「条件を変えた場合の代替」型の質問を注入しない（brain が顧客の自己ヘッジを質問化していた）
      const RELAX_Q_RE = /条件を?(?:一つ|1つ|ひとつ|どれか)?変え|代替|緩め|難しい場合|優先/;
      const qsRaw = brainFreshForMessage ? (brainMeta.customer_questions ?? []) : [];
      const qs = hedge.allowance === "forbid_preemptive" ? qsRaw.filter((q) => !RELAX_Q_RE.test(q)) : qsRaw;
      const droppedRelaxQ = qsRaw.length !== qs.length;
      const hasTactical = brainFreshForMessage && !!(
        qs.length || brainMeta.repeated_concern || brainMeta.current_property || brainMeta.hesitancy_pattern || brainMeta.customer_intent || brainMeta.latent_intent
      );
      // H2(AIX-METAフル活用 2026-08): property_search_params は brain が property_customers +
      // sent_properties から構築した「この顧客だけの確定事実」。パターン検索（pgvector/DB）では
      // 原理的に供給不能な情報のため、ここがプロンプトへの唯一の供給路。
      // ng_properties（NG確定物件）はDB由来の安定事実だが、stale時は直近NG判定が欠落しうるため
      // message-localフィールドと同じ鮮度ゲートを適用する（古いリストでの「安全」誤認を防ぐ）。
      const psp = brainFreshForMessage ? (brainMeta.property_search_params ?? null) : null;
      const ngProps = (psp?.ng_properties ?? []).filter(p => p?.property_name);
      const hasCustomerFacts = !!(ngProps.length || psp?.preferences || psp?.ng_points);
      if (!hasAction && !hasStrategy && !hasExtendedFields && !hasTactical && !hasCustomerFacts) return "";
      // 実質戦略（action / reply_direction / key_topics / closing_strategy / next_steps）が無い場合は
      // 「補助メタ」ヘッダーにする → buildGenerationMessages 側の hasAixMetaStrategy が false になり
      // summaryNote 全文・closingNote・closingFallback が従来通り注入される（空箱が戦略を殺すバグの修正）
      const hasRealStrategy = hasAction || hasStrategy || (brainFreshForMessage && !isCachedMeta && (!!brainMeta.reply_direction || !!(brainMeta.key_topics?.length)));
      // enforcement_level を強制度文言に反映（型定義済みだが未使用だったフィールドの活用）
      const isRequired = brainMeta.enforcement_level === "required";
      const lines: string[] = [
        hasRealStrategy
          ? `【🧠 AIX-META戦略 — 唯一の戦略指示・最優先で従うこと（AIX-METAが全情報を統合した唯一の戦略指示。フェーズ別パターン・ai_summaryより上位。ハードゲート（内覧日時・見積・物件事実制約）のみこれより上位。強制度: ${isRequired ? "必須（以下の指示に例外なく従う）" : "推奨（原則従うが、顧客の最新メッセージへの応答として不自然になる場合のみ自然さを優先してよい）"}）】`
          : `【🧠 AIX-META補助メタ（戦略指示は未生成。以下は顧客状態の参考情報。返信の方向性は「場面と返信方針」ブロックとAI要約に従うこと）】`,
      ];
      if (brainMeta.note && brainMeta.reply_mode !== 'aix') {
        lines.push(`- 📌 スモラスタイル②WE DO宣言（必須・返信末尾に1文として明示する）: ${brainMeta.note} → このスタッフアクションをお客様向けに「私が〇〇させて頂きます！！」の形に言い換えて返信の最後の1文に含めること（例: 「明日管理会社に交渉させて頂きます！！」「ご希望のお部屋をピックアップしてお送りさせて頂きます！！」「お申込みでお部屋押さえさせて頂きます！！」）。ただしZ/F3/Yパターン等の短い締め返信では追加しない`);
      }
      // winning_pattern + closing_strategy の両方がある場合は1文のWE DO宣言に統合（二重宣言防止）
      // 2026-09-09 Fable5 みく事例: 未探索の時は brain 戦略から代替案・条件緩和の先回り節を剥がしてから注入（顧客⑧の自己ヘッジが closing_strategy に昇格していた）
      const wp = hedge.allowance === "forbid_preemptive" ? stripPreemptiveRelax(brainMeta.winning_pattern) : (brainMeta.winning_pattern ?? "");
      const cs = hedge.allowance === "forbid_preemptive" ? stripPreemptiveRelax(brainMeta.closing_strategy) : (brainMeta.closing_strategy ?? "");
      const relaxGuard = hedge.allowance === "forbid_preemptive" ? "（未探索のため代替案・条件緩和は宣言しない。WE DO はご希望条件そのままのピックアップ宣言1文）" : "";
      if (wp && cs) {
        lines.push(`- 🏆 勝ちパターン×成約戦略: 【勝ちパターン】${wp} ／ 【成約戦略】${cs} → 両者を統合した1アクションをWE DO宣言（「〜させて頂きます！！」形）で今回の返信末尾に1文のみ含めること（WE DO宣言は返信全体で1文・重複禁止）${relaxGuard}`);
      } else if (wp) {
        lines.push("- 🏆 過去の勝ちパターン: " + wp + " → このパターンに沿った具体アクションをWE DO宣言（「〜させて頂きます！！」形）で今回の返信に1文含めること" + relaxGuard);
      }
      // 2026-09-11: 旧「冒頭1文で感情を受け止めよ（例: ご心配なお気持ち、よくわかります）」は共感語全面禁止ルール
      //   （line-reply-prompts ■姿勢・正解返信125件中0件）と矛盾し、禁止語を避けた言い換え「〜気になりますよね」を生んでいた。
      //   スタッフ実送信6,090通中「〜ますよね/ですよね」は3通。感情はトーンにだけ反映し、気持ちの代弁・同調文は書かせない
      if (brainMeta.customer_emotion) lines.push("- 💡 顧客の感情状態: " + brainMeta.customer_emotion + " → トーン（絵文字・言い切りの柔らかさ）にだけ反映する。お客様の気持ちを代弁・同調する文（「〜気になりますよね」「ご心配ですよね」「お気持ちよくわかります」等）は書かない。懸念は条件に取り込んだ行動宣言で応える");
      // ── purchase_signal_level クロージング強度制御 ────────────────────────────
      // none は干渉ゼロ（現行ロジックをそのまま通す）
      // M4: engagement_stance="wait"（強推し直後の待ちフェーズ・ネガ文脈直後）ではブロック全体をスキップする。
      // purchase_signal_level は「熱量が高い→もっと押す」の一方向しか表現できず、
      // ルール⑦（ネガ文脈）・ルール⑧（強推し直後の了承）の局面で希少性訴求・CTA・申込期限の明示が
      // 混入すると離脱率が上がる。押しの強さより局面判定を優先する（"push"/null は従来どおり）。
      // S-3: engagement_stance は message-local。fresh の時のみ「待ち」ゲートを効かせる（stale の wait が押すべき局面を封じない）
      const closingGatedByStance = brainFreshForMessage && !isCachedMeta && brainMeta.engagement_stance === "wait";
      if (closingGatedByStance) {
        lines.push(
          `- ⏸️ 押し引きスタンス: WAIT（待ちの局面）— 強推し直後の了承、またはネガ文脈（断り・キャンセル・否決・募集終了）の直後です。希少性訴求・申込期限の明示・CTA・新規物件提案は今回の返信に一切入れないこと。受け止めと見守りの姿勢で締めること`
        );
      } else if (brainMeta.purchase_signal_level === "peak") {
        lines.push(
          `- 🔥 購買シグナル: PEAK（申込直前最強シグナル）— 入居日の具体日付確定・競合申込者の自発確認・3件以上の連続具体質問・申込許可伺い（「申し込んでもいいですか？」「抑えるだけ抑えててもいいんですか？」）・物件名指し確定（「ここがいいです」「○○に決めます」）・金額の復唱（「○○円ですか😭」）・手続き/審査プロセスの具体質問（保証会社・支払い方法・流れ）のいずれかを検出。今回の返信で完全クロージングフローを発動すること: ①申込期限を明示（顧客の入居希望日から審査2週間＋契約手続きを逆算した事実ベースの期限。例: 「審査・契約手続きに最短でも2週間程かかりますので、○/○ご入居希望の場合は今週中にお申込みいただく必要がございます！！」／入居希望日が不明なら期限文は書かない・日付の創作は禁止）②申込書類リストをセットで案内 ③WE DO宣言でお部屋確保を約束。【希少性煽り禁止】「埋まってしまいます」「人気物件です」「残り1部屋」「一番手確保」等の煽りは成約データ152件で出現0件＝効果なしのため使わない。urgency_appropriate フラグに関係なく発動（PERM-CLOSING-MOVEIN-DATE-001 と同等のクロージング強度）。※申込許可伺い・物件名指し確定を検出した場合は理由説明・追加提案を一切挟まず「かしこまりました！！○○号室お申込みさせていただきます😊！！」の確定宣言＋申込フォーマット＋本人確認書類（表裏）依頼を即返すこと`
        );
      } else if (brainMeta.purchase_signal_level === "strong") {
        lines.push(
          `- 🌡️ 購買シグナル: STRONG（申込前の高熱シグナル）— 設備・入居日・費用等の異カテゴリ確認が2件以上重なっている。前の質問に誠実に回答した上で、CTAを返信末尾に入れること（WE DO宣言と重複しないよう統合すること）。【希少性煽り禁止】「埋まってしまいます」「人気物件です」「残り1部屋」「一番手確保」等の煽り表現は成約データ152件で出現0件＝効果なし。代わりに顧客の入居希望日から逆算した事実ベースの期限を1文添えること（例: 「審査・契約手続きに最短でも2週間程かかりますので、○/○ご入居希望の場合は今週中にお申込みいただく必要がございます！！」）。入居希望日が不明な場合は逆算期限を書かず、期限文なしのCTAのみにすること（日付の創作は禁止）`
        );
      } else if (brainMeta.purchase_signal_level === "soft") {
        lines.push(
          `- 📶 購買シグナル: SOFT（本気検討始まりシグナル）— 具体的な物件・設備・費用の確認質問を1件検出。質問に誠実に答えた後、次への軽いCTA 1文（例: 「気になれば内覧もできますよ！」「お気軽にどうぞ！」）を返信末尾に自然に添えること（pressure ゼロ・押しつけ禁止）`
        );
      }
      if (rawAction && !effectiveAction) {
        // S-3: stale / cached の message-local アクションは「採用しない」ことを明示（無言スキップだと LLM が履歴から同じ行動を再構成する）
        lines.push(`※ brain の推奨アクション（${rawAction}）は前メッセージ時点の判定のため今回は採用しない。最新メッセージへの直接応答を優先`);
      }
      if (hasAction && effectiveAction) {
        // 安全ガード①: brain キャッシュが estimate_sheet のままでも、顧客が同一メッセージで
        // 新しい検索条件（路線・家賃・徒歩・広さ等）を指定していたら property_send 方向に上書き。
        // brain-core.ts 側の例外ルールと二重に守る（stale キャッシュ対策）。
        const latestCustText = effectiveAction === "estimate_sheet"
          ? ([...recentMessages].reverse().find(m => m.sender === "customer" && m.text)?.text ?? "")
          : "";
        const isConditionOverride = effectiveAction === "estimate_sheet" &&
          (/調べてほし[いく]|探してほし[いく]|探して欲[しく]|徒歩[0-9０-９]+分|家賃.{0,6}万|[0-9０-９]+万以下|広め|路線のみ|沿線|環状線|条件.{0,3}絞|条件.{0,3}変[えわ]/.test(latestCustText) ||
          /【[^】]{2,15}】[^。！\n]{0,5}[⇒→＝:：]/.test(latestCustText));
        // 安全ガード③: T1（brainFresh=true）でも、顧客の直近メッセージに費用関連語がない場合は
        // estimate_sheet を注入しない（brain-core の旧 .slice(-3) バグ由来の誤分類残留対策）。
        // 直近3件の顧客メッセージを参照（「よろしくお願いします」のみでも前のメッセージで費用言及があれば許可）。
        // ※ 旧ガード②（stale estimate_sheet）は S-3 の effectiveAction ゲートに統合済み
        const recentCustForEstimate = [...recentMessages]
          .filter(m => m.sender === "customer" && m.text)
          .slice(-3)
          .map(m => m.text || "")
          .join(" ");
        const isEstimateRelevant = effectiveAction === "estimate_sheet" &&
          /見積|初期費用|費用|おいくら|いくら|合計|金額|費用感|敷金|礼金|割引|値引|予算/.test(recentCustForEstimate);
        // T1かつ費用ワードなし → 明示的に抑制（スキップでなく抑制ノートを注入してLLMに作成宣言を禁止させる）
        const isEstimateIrrelevant = effectiveAction === "estimate_sheet" && !isEstimateRelevant;
        if (isConditionOverride || isEstimateIrrelevant) {
          if (isConditionOverride) {
            lines.push(`- 推奨アクション: 物件ピックアップ対応（property_send方向）— お客様が新しい検索条件（路線・家賃・徒歩・間取り・広さ等）を今回のメッセージで指定しているため、見積書の作成宣言をせず条件を受け止めて物件を探す方向で返信すること。AIXで物件送付後に見積対応。`);
          } else if (isEstimateIrrelevant) {
            lines.push(`- ⚠️ 見積アクション保留: brainがestimate_sheetを記録しているが、直近のお客様メッセージに見積・費用関連の語がない。今回の返信に「御見積書」「お見積もり」「最大限割引」等の作成宣言を一切含めないこと。お客様の現在のメッセージ（条件ヒアリング・検索依頼等）にのみ応答すること。`);
          }
        } else {
          // A-7: スタッフ操作文（AIX_STAFF_NOTES「AIX【〇〇】を押してください」）の二重注入を廃止し、顧客向け direction / WE DO / 禁止を注入する
          const dir = AIX_ACTION_REPLY_DIRECTION[effectiveAction];
          lines.push(dir
            ? `- 推奨アクション（${AIX_BUTTON_LABELS[effectiveAction] ?? effectiveAction}）: ${dir.direction}。WE DO例:「${dir.weDo}」。禁止: ${dir.forbid}`
            : `- 推奨アクション: ${AIX_BUTTON_LABELS[effectiveAction] ?? effectiveAction}（この場面に合った受付・宣言文のみ。AIX操作語はお客様向け本文に書かない）`);
          // property_check_result 時は propertyFactGateNote の保証会社名断言禁止を解除して明示を強制
          if (effectiveAction === "property_check_result") {
            lines.push(`- ✅ 保証会社名・審査難度の明示（必須・propertyFactGateNote例外）: 管理会社確認済みの結果報告として、保証会社名と審査難度（「審査通過しやすい」または「審査厳し目」）を必ず1文付加すること。例: 「こちらのお部屋の保証会社は〇〇という比較的審査通過しやすい保証会社となっております！！」または「〇〇という審査やや厳し目の保証会社となります！！」。key_topicsに保証会社名がある場合は必ずその名前を使う。propertyFactGateNoteの「保証会社名断言禁止」はこのアクション時は適用されない`);
          }
        }
      }
      // closing_strategy は winning_pattern との両方がある場合は統合済み（上記）・単独の場合のみ出力
      if (cs && !wp) lines.push(`- 成約戦略: ${cs} → この戦略の核となる1アクションを今回の返信末尾でWE DO宣言（「〜させて頂きます！！」形）として明示すること${relaxGuard}`);
      if (brainMeta.next_steps?.length) {
        lines.push(`- 予定ステップ: ${brainMeta.next_steps.join(" / ")}`);
        lines.push(`  → 今回の返信で実行するのは Step1（${brainMeta.next_steps[0]}）のみ。Step2以降の内容（テンプレ送付・申込誘導・見積提示等）を今回の本文に先取りして書かないこと（フェーズ先走り禁止）`);
      }
      // TPO判定・effective制御値は tpoGuidanceNote（IIFE外・brainMeta有無に依存しない独立ブロック）へ移動（2026-09-08）
      if (brainMeta.urgency_appropriate === false) {
        lines.push("- ⛔ 緊急表現は今回使わない（直近のスタッフ送信で使用済みのため連発は逆効果）:「今なら」「今しか」「残り◯室」「あと◯件」「急いで」「お早めに」「先着」等は一切書かない。代わりに物件の具体的な強み（立地・設備・価格帯）を事実と数字で伝えること（例: 「駅徒歩3分・礼金0・築5年」）");
      }
      if (brainMeta.recommended_tone) {
        // トーン語ラベルだけでは生成LLMに伝わりにくいため、具体的な文体指示に展開して注入する
        const toneGuide: Record<string, string> = {
          "共感的": "冒頭1文で顧客の気持ちを受け止めてから本題に入る（「〜ですよね」等）。急かさない",
          "テキパキ": "前置きを省き結論から書く。1文を短く、要点を先に",
          "慎重": "断定・楽観表現を避け、会話・DBで確認済みの事実のみ正確に伝える",
          "明るく前向き": "ポジティブな言葉で次の一歩を気持ちよく示す（絵文字の扱いは既存ルールに従う）",
          "普通": "通常のスモラトーン",
        };
        const guide = toneGuide[brainMeta.recommended_tone];
        lines.push(`- 推奨トーン: ${brainMeta.recommended_tone}${guide ? `（${guide}）` : ""}`);
      }
      if (brainMeta.template_hint) {
        lines.push(`- 📋 テンプレートヒント: 「${brainMeta.template_hint}」スタイルの返信が最も効果的。このラベルに対応する文体・構成パターンを参考にしつつ、顧客の状況に合わせて自然に書くこと`);
      }
      // brain が今回この戦略を選んだ理由 — 返信方向性を理解して文案品質を上げるために注入
      if (brainMeta.reason) {
        lines.push(`- 💬 戦略選択理由: ${brainMeta.reason}`);
      }
      // ── message-local戦術ブロック（Step1廃止に伴いbrainへ移植した分析・brainFreshForMessage時のみ）──
      if (qs.length >= 1) {
        const qLabel = qs.length > 1
          ? "⚠️ 複数質問検出（全て漏れなく答えること・省略禁止）"
          : "⚠️ 質問検出（必ず正面から答えること・「確認します」で逃げることは禁止）";
        lines.push(`- ${qLabel}:\n${qs.map((q, i) => `  ${i + 1}. ${q}`).join("\n")}`);
      }
      if (droppedRelaxQ) {
        lines.push("- お客様は「条件を変えた場合の代替」を求めているが、まだ探していないので今回は答えない。ご希望条件そのままのピックアップ宣言で応え、代替案はピックアップ結果と一緒に報告する（先回りの「難しい可能性」は禁止）");
      }
      // 不安系キーワード判定は決定論（コード側）に残す — LLM出力に依存させない（旧Step1と同一リスト・ANXIETY_KEYWORDS）
      if (qs.some((q) => ANXIETY_KEYWORDS.some((k) => q.includes(k)))) {
        lines.push("- 🚨 不安系質問検出: お客様はリスク・ルール・契約上の不安を持っている。曖昧・ぼかした回答（「可能性があります」「かもしれません」）は信頼を損なう。不動産ルール・事実・リスクを具体的に説明し、リスクがある場合は正直に伝えた上で必ず代替案をセットで提示すること");
      }
      // 2026-09-10 Fable5 みく事例: repeated_concern は conversation-scope（会話全体で2回以上出た論点）。
      //   「今回のメッセージが懸念だ」という指示に変換しない。本文に実質ゼロ（isPureBoilerplate）の時は一切出さない
      if (brainFreshForMessage && brainStrategy?.repeated_concern && !substance.isPureBoilerplate) {
        lines.push(`- 💭 会話全体を通じた関心事: このお客様は会話全体で「${brainStrategy.repeated_concern}」を繰り返し確認している（※これは会話の論点であって「今回のメッセージが懸念だ」という意味ではない）。今回のメッセージがこの論点に触れている場合に**限り**事実で答える。触れていなければ一切言及しない`);
      }
      if (brainFreshForMessage && brainMeta.current_property) {
        lines.push(brainMeta.condition_change_type
          ? `- 🏠 現在話している物件: ${brainMeta.current_property}（※お客様が新しい条件を追加したため、この既出物件を再提案・再アピールしない。新条件に合うお部屋を新たに探してお送りする旨のみ伝えること）`
          : `- 🏠 現在話している物件: ${brainMeta.current_property} — この物件の文脈で返信すること`);
      }
      // H2: 顧客固有事実（property_search_params）— DBパターン検索では絶対に出てこない情報
      if (ngProps.length) {
        lines.push(`- 🚫 提案禁止物件（この顧客がNG確定済み）: ${ngProps.map(p => `${p.property_name}${p.room_no ? ` ${p.room_no}` : ""}`).join(" / ")} — 言及しない。代わりに顧客のこだわり（${psp?.preferences ?? "ご希望条件"}）に合う別物件を新たに探してお送りする旨をWE DO宣言（「〜させて頂きます！！」形）で伝えること`);
      }
      if (psp?.preferences) {
        lines.push(`- 👍 この顧客に刺さるポイント: ${psp.preferences} — 提案・訴求の切り口はここに寄せる`);
      }
      if (psp?.ng_points) {
        lines.push(`- ⚠️ この顧客の地雷・NGポイント: ${psp.ng_points} — これに該当する提案・話題を出さない`);
      }
      // 物件送付文のエリア名具体化強制（成約パターン frequency:5 — 抽象表現禁止）
      if (effectiveAction === "property_send" && psp?.area) {
        lines.push(`- 🗺️ エリア名の具体化（必須・成約パターン）: 物件送付文には「${psp.area}エリアから」「${psp.area}×${psp.floor_plan ?? "ご希望条件"}のお部屋」のようにエリア名・主要条件を文中に具体的に埋め込むこと。「ご条件に合ったお部屋」「ご希望のご条件に合ったお部屋」という抽象表現は一切書かない。代わりに「${psp.area}エリアからオススメできるお部屋」の形で能動的に表現すること（エリアの呼び方は会話で使われた表現をそのまま使い「全域」等を勝手に付け足さない）`);
      }
      if (psp?.move_in_time && !brainMeta?.future_timeline) {
        lines.push(`- 📅 入居希望時期（brain抽出）: ${psp.move_in_time} — 提案・約束をこの時期に整合させること`);
      }
      // 入居希望日が30日以内なら申込期限を決定論的に明示（成約パターン: 入居タイムライン緊急性付加）
      if (psp?.move_in_time && brainMeta?.urgency_appropriate !== false) {
        const { y: curYear, m: curMonth, d: curDay } = jstParts();
        const mText = psp.move_in_time;
        const mMonthMatch = mText.match(/(\d{1,2})月/);
        if (mMonthMatch) {
          const tMonth = parseInt(mMonthMatch[1], 10);
          const mDayMatch = mText.match(/(\d{1,2})日/);
          const tDay = mDayMatch ? parseInt(mDayMatch[1], 10) : (mText.includes("末") ? 28 : 1);
          const tYear = (tMonth < curMonth || (tMonth === curMonth && tDay < curDay)) ? curYear + 1 : curYear;
          const daysUntil = Math.floor((Date.UTC(tYear, tMonth - 1, tDay) - Date.UTC(curYear, curMonth - 1, curDay)) / 86_400_000);
          if (daysUntil >= 0 && daysUntil <= 30) {
            lines.push(`- ⚡ 申込期限明示（必須・成約パターン）: 入居希望日 ${mText} から逆算すると今週中のお申込みが必要です。「${mText}ご入居希望の場合、今週中にお申込みいただく必要がございます！！審査・契約手続きに最短でも2週間程はかかりますので〜」の形で返信末尾に期限を必ず1文で明示すること`);
          }
        }
      }
      if (psp?.search_urgency) {
        lines.push(`- ⚡ 物件探しの緊急度: ${psp.search_urgency} → 高い（★★★）場合: ピックアップしてお送りする旨をWE DO宣言（「〜させて頂きます！！」形。「すぐに／今すぐ」は書かない）で伝えること / 低い（★以下）場合: 焦らせず次の連絡タイミングをこちらから約束すること`);
      }
      if (brainFreshForMessage && brainMeta.hesitancy_pattern) {
        const hp = brainMeta.hesitancy_pattern;
        const timeline = brainMeta.future_timeline ?? null;
        if (hp === "thinking" || hp === "callback") {
          // 2026-09-09 Fable5: 成約データ反映（検討中系の正解返信に希少性一言・申込促しは0件）
          lines.push(`- 🤔 保留パターン検出（${hp === "thinking" ? "検討中" : "また連絡"}）: 急かさない。「お気軽にご連絡ください」「ごゆっくりご検討ください」だけで終わらないこと。必ず以下を1つ添える: ①お客様が予告した行動を先取りする宣言（「お送り頂けましたら募集状況確認し御見積書とあわせてご連絡させて頂きます」） ②待機中の具体アクション約束（「〇〇さんにオススメできるお部屋出てきましたら随時ピックアップしてお送りさせて頂きます」） ③直前送付物の次ステップ（「お気に召されましたらご内覧／お申込しお部屋抑えさせて頂きます」）。好条件・希少性の一言／申込促しは禁止（検討中系の正解返信に0件）`);
        } else if (hp === "waiting") {
          lines.push("- ⏳ 「少し待って」パターン検出: お客様は決断に踏み出せていない。バリアを取り除くこと: 「保証会社の審査が通過するまでの間はキャンセル料は一切かかりませんのでご安心ください😊！！審査期間中にお部屋のご案内もさせて頂けますので、実際に見てからご判断いただけます！！」のように安心感を先に伝える");
        } else if (hp === "timeline" && timeline) {
          lines.push(`- 📅 タイムライン確定（${timeline}）: お客様がタイムラインを示している。そのタイミングで動く具体アクションを約束する: 「${timeline}に新着物件も含めてピックアップしお送りさせて頂きます😊！！」のように日付・アクションを明示してコミットする`);
        } else if (hp === "undecided") {
          lines.push("- 🔀 物件迷いパターン検出: 複数物件で迷っている。判断軸を提供する: 各物件の具体的な違い（費用・立地・設備）を数字で比較し「初期費用を軸にお選びになられるのはいかがでしょうか」等で決断を後押しする。※比較に使う数字は会話履歴にテキストとして登場した実際の値のみ。履歴にない家賃・費用の数字を推測して比較することは絶対禁止。数字が履歴になければ判断軸提示のみ行う");
        }
      }
      // 顧客意図 (customer_intent): 問い合わせの根本意図に応じた返信モードを指示
      // stale（T2/T3）でも渡す。前回分析でも方向性として有効なため。
      if (brainMeta.customer_intent) {
        const INTENT_GUIDE: Record<string, string> = {
          question:     "質問回答モード ― お客様の疑問に端的に答えるだけ。次アクション催促・送付案内・フォーム提出促しは一切書かない。さらに：customer_questionsに記載の質問のみに答え、無関係な物件名・別物件の空室確認状況・並行審査の言及はavoid_topicsの有無に関わらず一切書かない",
          consultation: "相談応対モード ― 選択肢・アドバイスを提示する。即決プッシュは控える",
          desire:       "願望応対モード ― お客様の希望を受け止め、物件提案・具体化へつなげる",
          decision:     "決定応対モード ― 申込フロー・次ステップをスムーズに案内する",
          positive:     "前向き応対モード ― 気に入り感に乗り、申込提案へ背中を押す",
          negative:     "懸念解消モード ― 不安・懸念を正面から解消してから次へ進む",
          chat:         "雑談応対モード ― 軽い返しで親近感を保つ。長文・次アクション催促は不要",
        };
        const guide = INTENT_GUIDE[brainMeta.customer_intent];
        if (guide) {
          const staleTag = brainFreshForMessage ? "" : "（前回分析値・参考）";
          lines.push(`- 🎯 顧客意図${staleTag}【${brainMeta.customer_intent}】→ ${guide}`);
        }
      }
      // 潜在意識 (latent_intent): brainが推論した「なぜ今このメッセージを送ってきたか」の送信動機。
      // 表面の質問への回答だけでなく、裏にある不安・期待に届く返信を書かせる（message-local分析のため鮮度ゲート必須）
      if (brainFreshForMessage && brainMeta.latent_intent) {
        // 2026-09-09 Fable5: 旧「不安を汲み取る一文」指示が「お気持ち、よくわかります」を生んでいた → 事実か代替案で応える
        // 2026-09-09 Fable5 みく事例: 旧『代替案（条件を変えた再ピックアップ宣言）で応える』がみくの先回りヘッジ締めの生成源。ヘッジ verdict で応え方を切替え、未探索時は代替案節を剥がす
        const li = hedge.allowance === "forbid_preemptive" ? stripPreemptiveRelax(brainMeta.latent_intent) : brainMeta.latent_intent;
        const answerWith = hedge.allowance === "allow_after_search" ? "『事実』か『過去形の結果報告＋実行済み代替』"
          : hedge.allowance === "allow_on_customer_ask" ? "『事実（傾向として）』＋『ご希望条件でのピックアップ宣言』"
          : "『事実』か『ご希望条件そのままでのピックアップ宣言』";
        if (li) lines.push(`- 💭 送信動機・潜在意識: ${li} — この動機には${answerWith}で応える。共感語（お気持ち・ご心配な・お察し・わかります・寄り添う）で応えるのは禁止。推測を「〜が不安なんですよね」と指摘するのも禁止`);
      }
      // H1(AIX-METAフル活用 2026-08): future_timeline を hesitancy_pattern と独立に注入。
      // 旧実装は hp==="timeline" の分岐内でのみ使用しており、hp が thinking/null 等のとき
      // brainが抽出済みのタイムラインがプロンプトに一切届かなかった（入居時期に合わない提案の原因）。
      // hp==="timeline" 時は上の分岐で既に消化済みのため除外（二重注入防止）。
      if (brainFreshForMessage && brainMeta.future_timeline && brainMeta.hesitancy_pattern !== "timeline") {
        lines.push(`- 📅 顧客の決断タイムライン: ${brainMeta.future_timeline} — 返信の提案・約束はこのタイムラインに整合させる（このタイムラインは会話に実際に出た表現。これに合わない前倒し・急かし提案をしない。日付・時期の創作は絶対禁止）`);
      }
      if (tierResult?.tier === "T2") {
        lines.push(`※ brain分析の鮮度が不足（最新メッセージ送信後に分析が追いついていない）。直近メッセージ固有の戦術（hesitancy・customer_questions等）は省略済み。最新メッセージの意図は会話履歴から直接読むこと`);
      }
      // Fix③: checkpoint_stage（brain実態フェーズ）がDB上のstate（currentState）と乖離している場合に明示する
      // S-2: resolveState が guideKey に反映済み（viewing/applying/contract→closed_won の前進補正）なら乖離警告は出さない
      {
        const cs = brainMeta.checkpoint_stage;
        const reflected = !!cs && (phaseGuideKey === cs || (cs === "contract" && phaseGuideKey === "closed_won"));
        if (cs && !reflected && cs !== currentState) {
          lines.push(`- ⚠️ 会話実態フェーズ（brain判定）: ${cs} ※DB上の状態(${currentState})と乖離あり — 実態フェーズを優先すること`);
        }
      }
      lines.push("※これはスタッフへの行動方針であり物件の事実情報ではない。「退去予定」「空き予定」「〜月末まで」等の期日・空室情報は会話履歴やDBで確認された事実のみ本文に書くこと。");
      return lines.join("\n") + "\n";
    })();

    // ── 場面と返信方針（TPO）独立ブロック（2026-09-08）──
    // brainMeta の有無（T1/T2/T3）に関係なく必ず生成プロンプトへ注入する。
    // 旧実装は brainGuidanceNote IIFE 内にあり T3 で消えていた（final-check には tpoLabel が届くため
    // 「生成はTPOなし・チェックはTPOあり」の非対称が発生していた）。
    // 2026-09-09 Fable5 往復文脈ブロック（dynamicBlock で tpoGuidanceNote の直前・ハードゲートの次）。follow-up 生成では注入しない
    // 2026-09-10 Fable5 あみ事例: 【🔤 お客様が言っていない語】（禁止＋正しい代替をリテラルで）。往復文脈ブロックの直後に連結する
    const vocabAnchorNote = isFollowUp || isTemplateOptimize
      ? ""
      : buildVocabAnchorNote(`${message ?? ""}\n${unrepliedCustomerTexts.join("\n")}`, pairContext);
    const turnPairNote = (isFollowUp || isTemplateOptimize ? "" : buildTurnPairNote(pairContext, message ?? "", customerName ?? "", { strategy: brainStrategy, brainFresh: brainLocalFresh })) + vocabAnchorNote;
    // 2026-09-09 Fable5 行動台帳: 【📒 我々の行動台帳】（往復文脈の直前）＋ 直前発言の宣言／実行注記（staffContextNote）。shadow では注入しない
    const actionLedgerNote = isFollowUp || !ledgerActive ? "" : buildLedgerNote(ledger, { customerName: customerName ?? "" });
    const ledgerAnnotation = isFollowUp || !ledgerActive ? "" : buildLastStaffAnnotation(ledger);
    // 2026-09-09 Fable5 みく事例: 【🧭 姿勢】ブロック（ヘッジ判定・条件トークン・締めリテラル・即答・日程提案形・温度）。決定論の値を LLM に選ばせない
    const stanceNote = isFollowUp || isTemplateOptimize ? "" : buildStanceNote(pairContext, hedge, closerVerdict, { customerName: customerName ?? "", customerText: message ?? "" });

    const tpoGuidanceNote = (() => {
      const lines: string[] = [];
      if (tpoNoteForLLM) lines.push(`- 📍 現在の場面: 【${tpoNoteForLLM}】— この場面に合った返し方をすること`);
      // 2026-09-10 Fable5 Sさん事例: WE DO の選択肢に内覧のご案内提案を第1候補として含める（四者同名）
      const fallbackDirection = "顧客の最新メッセージ内の質問・条件・依頼にそれぞれ直接回答し、具体名詞（エリア・条件。物件名・号室・日付は書かない）を含む WE DO 宣言を1つだけ添える（次のいずれか1つ: ①内覧のご案内提案「よろしければ〇〇さんご都合よろしいお日にちにお部屋ご案内させて頂きます😌！！」＝具体的な候補日時は書かない ②募集状況の確認 ③御見積書の作成・送付 ④ご条件に合うお部屋のピックアップ ⑤家賃・条件の交渉）";
      lines.push(`- 🎯 返信の方向性: ${effectiveReplyDirection ?? fallbackDirection}（返信全体をこの1点に収束させる。関係ない話題を足さない）`);
      if (effectiveKeyTopics.length) {
        lines.push(`- ✅ 必ず含める内容（${effectiveKeyTopics.length}件すべて必須）: ${effectiveKeyTopics.join(" / ")}`);
        lines.push("  → 各項目を返信本文で最低1文、明示的に扱うこと。1つでも欠けた返信は不合格。ただし箇条書きの丸写しではなく会話の流れに自然に織り込む");
      }
      if (activeAvoidTopics.length) {
        lines.push(`- 🚫 今回は ${activeAvoidTopics.join(" / ")} には触れない（言い換え・同義語も禁止: 「来阪」なら「大阪にお越し」「お越しの際」等の来訪誘導全般、「見積書」なら「お見積り」「費用のご案内」等も含む）。代わりに「${effectiveReplyDirection ?? fallbackDirection}」の方向性に沿った具体アクション・事実情報で返信を構成すること。本文を書き終えたら各語について自己チェックし、該当する文があれば削除して書き直すこと`);
      }
      if (lines.length === 0) return "";
      return `\n【📍 場面と返信方針 — ハードゲートの次に優先。AIX-META戦略・フェーズ別パターンより上位】\n${lines.join("\n")}\n`;
    })();

    // brain誘導型フェッチ仕様（v1: baseline = 従来動作と同一。T1動的選択は次フェーズ）
    // S-2: RAG（知識・実例・フレーズ）は searchState（viewing/closed_lost は proposing に畳んだ5段階）で引く
    const fetchSpec = buildBrainFetchSpec(brainMeta, searchState, tierResult);
    const analysisContext = fetchSpec.analysisContext;

    // ── T1動的選択の監視ログ（Promise.all 前に spec の発火内容を記録） ──
    if (!isTemplateOptimize) {
      console.log(JSON.stringify({ tag: "step2-spec", tier: tierResult.tier, spec: {
        lossPatterns: fetchSpec.lossPatterns, adaptRules: fetchSpec.adaptRules, applyingPatterns: fetchSpec.applyingPatterns, viewingPatterns: fetchSpec.viewingPatterns,
        // M系T1動的選択の実発火率計測用（AIX-METAフル活用 2026-08）
        filterTopics: fetchSpec.knowledge.filterTopics,
        excludeReplyRe: fetchSpec.examples.excludeReplyRe?.source ?? null,
        boostStates: fetchSpec.examples.boostStates,
        knowledgeLimit: fetchSpec.knowledge.limit,
        analysisContextLen: analysisContext?.length ?? 0,
      } }));
    }

    // ── Step2: 残りを並列実行（実例検索はパターンキーワード付きクエリで実行）
    // 各フェッチはエラーでも生成を止めない（knowledgeなし・実例なしで生成続行）
    const [knowledgeResult, examples, phraseList, autoSummary, dbRules, fetchedSummaryJson, quotedContextNote, templateAdaptRules, categoryAdaptationRules, groundTruth, finalCheckRules] = await Promise.all([
      fetchKnowledge(searchState, message, analysisContext, conversationId, fetchSpec, brainMeta, lastStaffMsgForSearch, lastAixHistoryText)
        .catch((err) => { console.error("[generate-reply] fetchKnowledge失敗 — knowledgeなしで生成続行:", err); return { text: "", phraseHits: 0, topPrinciples: [] as KnowledgeRow[] }; }),
      fetchExamples(searchState, message, isFollowUp ? lastStaffMsgForSearch : undefined, analysisContext, fetchSpec, brainMeta, lastStaffMsgForSearch ?? null, brainFreshForMessage && !isCachedMeta)
        .catch((err) => { console.error("[generate-reply] fetchExamples失敗 — 実例なしで生成続行:", err); return ""; }),
      getCachedPhrases(fetchSpec.phrases.categories)
        .catch((err) => { console.error("[generate-reply] getCachedPhrases失敗 — フレーズなしで生成続行:", err); return [] as string[]; }),
      // ai_summaryがない場合のみ条件テキスト+履歴から即席合成（Haiku・並列なので遅延ゼロ）
      !customerSummary && customerConditions
        ? synthesizeCustomerContext(customerConditions, customerName, history)
        : Promise.resolve(""),
      getCachedPromptRules("generate_reply", {
        conversation_state: currentState,
        is_first_reply: String(isFirstEverReplyFromMsgs ?? false),
      })
        .catch((err) => { console.error("[generate-reply] getCachedPromptRules失敗 — ルールなしで生成続行:", err); return ""; }),
      // 構造化サマリー: body未指定かつconversationIdありならDBから直接取得（regex往復の廃止）
      !bodySummaryJson && conversationId
        ? fetchSummaryJsonByConversation(conversationId)
        : Promise.resolve(null),
      // パターンA: 引用リプライの引用先コンテキスト（quoted_message_id → line_message_id JOIN）
      conversationId
        ? fetchQuotedContext(conversationId)
        : Promise.resolve(""),
      // テンプレート最適化モードのみ: 旧adaptルートのDB学習ルール2種を追加取得
      isTemplateOptimize ? fetchTemplateAdaptRules() : Promise.resolve(""),
      isTemplateOptimize && templateCategory
        ? fetchCategoryAdaptationRules(templateCategory)
        : Promise.resolve(""),
      // 過去の会話セーブポイント + property_customers 条件 — final-check の正解データ兼プロンプト文脈
      // （旧: conversation_checkpoints を ascending limit 3 でインライン取得 → ローリング方式では最古を
      //  取ってしまうため fetchGroundTruth（最新1件 desc）に統一）
      fetchGroundTruth(conversationId),
      // final-check 専用ルール（action_type="final_check"）: 3パス全てに注入して日々改善を反映
      // includeGlobal=false で global共通ルールを除外（生成用ルールの二重注入・プロンプト汚染を防ぐ）
      getCachedPromptRules("final_check", {}, false)
        .catch((err) => { console.error("[generate-reply] getCachedPromptRules(final_check)失敗:", err); return ""; }),
    ]);
    // ── ティア監視ログ ──
    if (!isTemplateOptimize) {
      console.log(JSON.stringify({
        tag: "step2-tier",
        tier: tierResult.tier,
        reason: tierResult.reason,
        staleAgeMs: tierResult.staleAgeMs,
        viaDirect: !!externalBrainGate,
        brainSource: (brainMeta as Record<string, unknown> | null)?.["source"] as string | null ?? null,
        action: brainMeta?.action ?? null,
        conversationId,
      }));
    }
    // Build checkpoint note for prompt injection（ローリング累積方式: 最新1行が確認済み事実の全量）
    const checkpointNote = groundTruth.checkpointFacts
      ? `\n${CHECKPOINT_HEADER}\n${groundTruth.checkpointFacts}`
      : "";
    const resolvedSummary = (customerSummary || autoSummary) + checkpointNote;
    const resolvedSummaryJson = bodySummaryJson ?? fetchedSummaryJson ?? undefined;
    // GAP-3: Cross-table deduplication — dbRules（ai_prompt_rules）と knowledge（ai_reply_knowledge）の
    // 内容重複を除去する。HUMAN-*/FEEDBACK-*がai_prompt_rulesとai_reply_knowledgeの両方に存在する場合、
    // knowledge側から重複エントリを除外してプロンプトへの二重注入を防ぐ。
    const knowledge = (() => {
      if (!dbRules || !knowledgeResult.text) return knowledgeResult.text;
      // dbRulesから個別ルールテキストを抽出（各行は「・{rule_text}」形式）
      const dbRuleTexts = dbRules.split("\n")
        .filter(l => l.startsWith("・"))
        .map(l => l.slice(1).trim())
        .filter(l => l.length >= 15);
      if (dbRuleTexts.length === 0) return knowledgeResult.text;
      // knowledgeの各行を検査し、dbRulesと重複する内容行を除外する
      return knowledgeResult.text.split("\n").filter(line => {
        // 番号付きリスト「1. 」プレフィックスを除去してコンテンツ部分を取得
        const content = line.replace(/^\d+\.\s*/, "").trim();
        if (content.length < 15) return true; // ヘッダー・区切り行等は保持
        return !dbRuleTexts.some(r => content === r || r.includes(content) || content.includes(r));
      }).join("\n");
    })();
    // ⑥ フレーズ二重注入対策: pgvectorナレッジで phrase 系が3件以上ヒットした場合、
    // 汎用フレーズ集は 12 → 4 件に絞る（関連性ゼロのフレーズ大量混入を防ぐ）
    const phrases = formatPhrases(phraseList, knowledgeResult.phraseHits >= 3 ? 4 : 12);


    // JST 当日（0:00〜23:59）で挨拶済み判定（AIX 自動返信も「挨拶済み」に数える。画像/動画のみは除く）。
    // G31: 同一ロジックを greeting.ts computeAlreadyGreetedToday へ移設（check-reply と同関数）。createdAt が無ければ undefined → フォールバック
    const alreadyGreetedToday = computeAlreadyGreetedToday(recentMessages);

    // G32（2026-09-09 Fable5 じゅにあ事例・竹内方針）: 「お待たせ致しました」全廃。挨拶行は接触の事実（初回／催促／当日未挨拶／当日挨拶済み／夜間）、
    // 開口語は顧客メッセージの意味（classifyCustomerResponse）から確定。経過時間は audit にのみ保存し決定に使わない。
    // 生成プロンプト（buildGreetingNote）・後処理（enforceOpening）・final-check ⑦・tpo_debug.greeting の四者同名。
    // 夜間接頭辞は 22:00〜04:59 かつ直前スタッフ発言 60 分以上前のみ。
    const greetingDecision: GreetingDecision = resolveGreeting({
      customerName,
      isFirstEverReply: shouldPrependGreeting,
      alreadyGreetedToday: alreadyGreetedToday ?? false,
      recentMessages,
      jstHour: getJSTHour(),
      isProgressPush: isProgressPushMessage(message, { isAckOnly: substance.isAckOnly }),
      isSubstantive: (t) => analyzeSubstance(t).has,
      customerKind: customerResponse.kind,
      customerSecondary: customerResponse.secondary,
      substanceKinds: substance.kinds,
      isDeliverableReply: isDeliverableReplyForGreeting,
    });
    console.log("[greeting]", greetingDecision.kind, greetingDecision.opener, greetingDecision.reason, `audit.waitedMs=${greetingDecision.audit.waitedMs ?? "-"}`);

    const latestCustomerMsg = [...recentMessages].reverse().find(m => m.sender === "customer");
    const latestStaffMsg = [...recentMessages].reverse().find(m => m.sender === "staff");
    const isAmbiguousReply = !!latestCustomerMsg &&
      /^[\s　]*(ありがとう|ありがとうございます|はい|わかりました|なるほど|そうですね|了解|👍|🙏)[！。!、\s　]*$/.test(latestCustomerMsg.text?.trim() ?? "");
    const hadAggressivePush = !!latestStaffMsg &&
      /(お申込み|お申込|申し込み|お部屋(を)?抑え|お部屋抑えさせ|抑えさせて頂き)/.test(latestStaffMsg.text ?? "");
    if (isAmbiguousReply && hadAggressivePush) {
      replyHint = (replyHint ? replyHint + "\n" : "") +
        "【受け身モード】直前に申込誘導を送りお客様が曖昧な返答をした。今回は追い込まず受け身で締めること。「ご都合のよい日時をお聞かせください！！」等の追い込みは絶対にしない。「お気軽にお申し付けください！！」「いつでもご連絡くださいね！！」等の柔らかい一言で締める。";
    }

    // ─── テンプレート最適化モード: プロンプト最末尾に注入する上書きブロックを構築 ───
    // replyHintNote と同じ「最後に書いたルールが勝つ」スロットに置く。
    // 長さ制限（2〜3行等）はテンプレの長さを優先して解除するが、
    // 内覧日時・見積金額・空室確認結果・待ち合わせ場所の捏造禁止ゲートはそのまま効かせる。
    const templateNote = isTemplateOptimize
      ? (() => {
          const pendingSection = pendingScheduledMessages
            .map((m) => m.text ?? "")
            .filter(Boolean)
            .join("\n\n---\n\n");
          const learnedRulesSection = [templateAdaptRules, categoryAdaptationRules]
            .filter(Boolean)
            .join("\n\n");

          // AIXカテゴリのテンプレート最適化: テンプレートの骨格に従い、AIX物件情報を事実参照として当てはめる
          if (aixSourceMessage) {
            return `\n\n【🟣✨ AIXテンプレート最適化モード（最優先 — 上記すべてのフェーズ別指示・長さ制限を上書き）】
テンプレートの骨格・長さ・構成を厳守しながら、AIX物件情報から事実を抽出して当てはめてください。
「AIXで生成」ボタンと同じ出力は絶対に禁止。テンプレートの構成が正解です。

◆ テンプレート骨格厳守: 【テンプレート原文】の段落数・文体・長さ・トーンを厳密に守ること。これが出力の唯一の骨格
◆ 長さ厳守: テンプレートが短い（5行以内）なら出力も同等の短さにする。AIX文の長さに合わせてはいけない
◆ 事実抽出のみ: 【AIX物件情報】から物件名・家賃・間取り・オススメポイント・特徴などの事実情報のみを抽出し、テンプレートの該当箇所に自然に当てはめる
◆ 過去AIX参照禁止: 会話履歴に他の物件を紹介した過去のAIX送信が含まれていても一切参照しない。物件情報は必ず【AIX物件情報】のみから取る（件数・物件名・金額等を過去のAIX送信と混ぜることを絶対禁止）
◆ AIX構成の持ち込み禁止: AIX文の詳細な段落構成（オススメポイント箇条書き・設備リスト・長い説明文等）はテンプレートにない場合は出力しない
◆ プレースホルダ置換: 「アカウント名」→「${customerName || "〇〇"}さん」。物件名・家賃・間取り等はAIX物件情報から読み取った実際の値に置換する。不明な値は「〇〇」のまま残す（でたらめな値を絶対に入れない）
◆ 挨拶: テンプレートに冒頭挨拶が含まれている場合はそのまま維持する（【⏰ 挨拶ルール】はテンプレート最適化モードでは無視。「お世話になっております」等の挨拶・結び文を削除しない）
◆ 訴求ポイント指定: ${templateFocusPoints.length > 0 ? `スタッフ指定の訴求軸【${templateFocusPoints.join("・")}】を文中で最も強調すること` : "なし"}
◆ 申込フォーム誘導フレーズの強制置換: 「お申込フォーマット」「ご本人確認書類」を含む文は出力禁止。申込案内が必要な場合は「お気に召されましたらお申込みしお部屋押さえさせて頂きます！！」、内覧案内が必要な場合は「お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！」に必ず置き換える。
◆ 捏造禁止ゲート: 内覧日時・見積金額内訳・空室確認結果・待ち合わせ場所の捏造禁止（AIX物件情報にない情報を補完しない）
${noEmoji ? "◆ 絵文字は一切使用しない（テンプレートに絵文字があっても全て削除）\n" : ""}${soloEntry ? "◆ 1人入居モード（厳守）: 同居人・配偶者・同居者・家族構成・入居人数・お子様・子ども・子供・同居・ご家族 を含む行はすべて出力しない（完全に削除）\n" : ""}${templateLabel ? `【テンプレート名】${templateLabel}\n` : ""}${templateCategory ? `【テンプレートカテゴリ】${templateCategory}\n` : ""}【テンプレート原文（出力の骨格・長さ・構成の基準 — これに従うこと）】
${preprocessedTemplate}

【AIX物件情報（事実情報の参照元 — 物件名・家賃・間取り・特徴の事実のみ使う。構成は参照しない）】
${safeSlice(aixSourceMessage, 1500)}
${pendingSection ? `\n【🔑 予約送信待ちのAIXメッセージ】\n${pendingSection}\n` : ""}${learnedRulesSection ? `\n${learnedRulesSection}\n` : ""}
出力は書き直したテンプレート本文のみ。説明・前置き・補足コメントは一切書かない。`;
          }

          return `\n\n【🟠✨ テンプレート最適化モード（最優先 — 上記「長さの目安」・フェーズ別行動パターンを上書き）】
テンプレートをベースに、この顧客の状況に最適化した文章を作成してください。
今回はお客様のメッセージへのゼロからの返信ではなく、下の【テンプレート原文】を「構成の骨格」として、今のお客様・今の会話に完全に合わせて書き直すこと。
◆ 骨格維持: テンプレの段落数・流れ・目的（物件紹介テンプレなら物件を紹介する等）を維持する。長さはテンプレに準じる（「2〜3行」等の行数制限はこのモードでは適用しない。ただし内覧日時・見積金額内訳・空室確認結果・待ち合わせ場所の捏造禁止ゲートは引き続き厳守）
◆ 状況適合: 冒頭に【🎯 最優先指示】がある場合はその方向へ文面を寄せる。お客様の感情状態に合うトーンにする（不安→安心材料を先に、前向き→次アクションを即宣言）
◆ プレースホルダ置換: 「アカウント名」→「${customerName || "〇〇"}さん」。物件名・○月○日・〇〇円・〇〇分などは ①予約送信待ちのAIXメッセージ ②会話履歴 ③お客様の希望条件（DB） の優先順で実際の値に置換する。不明な値は「〇〇」のまま残す（でたらめな値を絶対に入れない）
◆ ハードコード物件名: テンプレ内に特定の物件名が入っていて、今話している物件と違う場合は今回の物件名に必ず差し替える（不明なら「〇〇」。前の物件名を残さない）
◆ 挨拶: テンプレートに冒頭挨拶が含まれている場合はそのまま維持する（【⏰ 挨拶ルール】はテンプレート最適化モードでは無視。「お世話になっております」等の挨拶・結び文を削除しない）
◆ 訴求ポイント指定: ${templateFocusPoints.length > 0 ? `スタッフ指定の訴求軸【${templateFocusPoints.join("・")}】を文中で最も強調すること` : "なし"}
◆ 禁止: テンプレにない新しい質問リストの発明・会話履歴と矛盾する内容・スモラが既に案内済みの情報の繰り返し
◆ 申込フォーム誘導フレーズの強制置換（骨格維持・フェーズ指示より優先）: 「お申込フォーマット」「ご本人確認書類」を含む文は出力禁止。申込案内が必要な場合は「お気に召されましたらお申込みしお部屋押さえさせて頂きます！！」、内覧案内が必要な場合は「お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！」に必ず置き換える。
${noEmoji ? "◆ 絵文字は一切使用しない（テンプレートに絵文字があっても全て削除）\n" : ""}${soloEntry ? "◆ 1人入居モード（厳守）: 同居人・配偶者・同居者・家族構成・入居人数・お子様・子ども・子供・同居・ご家族 を含む行はすべて出力しない（完全に削除）\n" : ""}${templateLabel ? `【テンプレート名】${templateLabel}\n` : ""}${templateCategory ? `【テンプレートカテゴリ】${templateCategory}\n` : ""}【テンプレート原文（前処理済み）】
${preprocessedTemplate}
${pendingSection ? `\n【🔑 予約送信待ちのAIXメッセージ（物件名・家賃・オススメポイントはここから最優先で読む）】\n${pendingSection}\n` : ""}${learnedRulesSection ? `\n${learnedRulesSection}\n` : ""}
出力は書き直したテンプレート本文のみ。説明・前置き・補足コメントは一切書かない。`;
        })()
      : "";

    // テンプレート最適化モードのモード宣言。SystemMessage（cache_control 付き dbRules ブロック）に
    // 連結するとモードの有無でキャッシュが分岐するため、dynamicBlock 末尾（templateNote スロット）に注入する
    const templateSystemNote = isTemplateOptimize
      ? (aixSourceMessage
          ? "\n\n【AIXテンプレート最適化モード】テンプレートの骨格に従い、AIX物件情報から物件の事実を当てはめる。AIX物件オススメと同じ出力形式にしてはいけない。テンプレートが短ければ出力も短くする。詳細ルールはプロンプト末尾の【🟣✨ AIXテンプレート最適化モード】ブロックに従うこと。"
          : "\n\n【テンプレート最適化モード】今回はテンプレートをベースに、この顧客の状況に最適化した文章を作成してください。詳細ルールはプロンプト末尾の【🟠✨ テンプレート最適化モード】ブロックに従うこと。")
      : "";

    // Step1廃止（2026-08）: brainGate / brainMeta / brainGuidanceNote は Step2 並列フェッチの前
    // （旧Step1の位置）で構築済み。ここでは directionNote（現在フェーズの参考情報）のみ組み立てる。
    const phaseLabels: Record<string, string> = {
      hearing: "条件ヒアリング中",
      proposing: "物件提案中",
      viewing: "内覧調整中",
      applying: "申込段階",
    };
    // AIX-META一元化: conversation_direction は戦略指示ではなく「現在フェーズの参考（事実情報）」として注入する
    const convDir = (brainGate?.conversationDirection ?? null) as Record<string, unknown> | null;
    const directionNote = convDir?.current_phase
      ? "【📍 現在フェーズの参考（事実情報 — 戦略指示ではない）】現フェーズ: " + (phaseLabels[String(convDir.current_phase)] ?? String(convDir.current_phase)) +
        " / 次の一手: " + String(convDir.next_staff_action ?? "状況に応じて判断") +
        " / 方針: " + String(convDir.direction_summary ?? "申込まで丁寧にリード") +
        "\n※戦略の判断はAIX-META戦略（存在する場合）を最優先とし、このブロックは現在地把握の参考としてのみ扱うこと。\n"
      : "";

    // Sonnetでストリーミング生成
    // Step1廃止（2026-08）: 旧 analysis（Step1生JSON）の代わりに brainMeta + brainFreshForMessage を渡す
    // ─── 2026-09-12 竹内方針「AIX のセットはブレインが判断する」段1 ───
    //   brainDecision : ブレインの判断（suggested_aix_meta ?? last_brain_meta）。fresh = 今回の顧客発言を見た実分析（cached・optional でない）
    //   replyAixPre   : resolveReplyAixDecision（ブレインの判断を読むだけ）。プロンプト「どの AIX で送るか」・メタ行 suggested_aix に使う
    //   bodySafetyPre : 証拠（detectAixSceneEvidence）から引いた本文の安全。プロンプト注入と確認約束 verdict に使う（初回返信でも注入する＝従来どおり）
    //   生成後は unresolvedBlock を足して同じ関数を呼び直し、トレーラー・ai_draft_check.suggested_aix にする（AIX は選び直さない）
    //   ※ 画面を開くと suggested_aix_meta が null に消される（page.tsx）ため、手動再生成は last_brain_meta（full/incremental の時だけ書かれる実分析）を読む
    const brainDecisionSrc = (brainMeta ?? (brainGate?.lastMeta as SuggestedAixMeta | null) ?? null) as SuggestedAixMeta | null;
    const brainDecision: BrainAixDecision | null = brainDecisionSrc ? (() => {
      const srcTier = detectBrainTier(brainDecisionSrc, lastCustomerMsgAt);
      const fresh = srcTier.brainFreshForMessage && brainDecisionSrc.source !== "cached" && brainDecisionSrc.enforcement_level !== "optional";
      return {
        action: normalizeAixActionKey(brainDecisionSrc.action ?? null) || null,
        check_pattern: (brainDecisionSrc as { check_pattern?: string | null }).check_pattern ?? null,
        enforcement_level: brainDecisionSrc.enforcement_level ?? null,
        note: brainDecisionSrc.note ?? null,
        fresh,
      };
    })() : null;
    const replyAixInput: ReplyAixInput | null = (isTemplateOptimize || templateNote || replyHint) ? null : (() => {
      const historyLinesTm = (history || "").split("\n");
      const lastStaffIdxTm = historyLinesTm
        .map((l: string, i: number) => (l.startsWith("スモラ:") ? i : -1))
        .filter((i: number) => i >= 0)
        .at(-1) ?? -1;
      const hasRecentCustomerImageTm = historyLinesTm
        .slice(lastStaffIdxTm + 1)
        .filter((l: string) => l.startsWith("お客様:"))
        .some((l: string) => l.includes("【画像を送ってきた】"));
      return {
        latestCustomerTurn: message ?? "",
        hasCustomerImage: hasRecentCustomerImageTm,
        recentMessages: recentMessages.map((m) => ({ sender: m.sender, text: m.text ?? "", isAix: m.isAix ?? null })),
        aixHistory: recentAixRows.map((r) => ({ aix_type: r.aix_type ?? null, check_pattern: r.check_pattern ?? null })),
        sentPropertyCount: ledger.facts.propertiesSentCount,
        conversationStatus: currentState ?? null,
        isFirstReply: currentState === "first_reply",
        propertyStatus: detectPropertyStatus(history, message ?? "", propertyStatus),
        estimateVerdict,
        brainDecision,
      };
    })();
    const replyAixPreDecision = replyAixInput ? resolveReplyAixDecision(replyAixInput) : null;
    const replyAixPre: ReplyAix | null = replyAixPreDecision?.aix ?? null;
    const sceneEvidencePre = replyAixInput ? detectAixSceneEvidence(replyAixInput) : null;
    const bodySafetyPre: BodySafety | null = replyAixInput ? resolveBodySafety(sceneEvidencePre, replyAixInput) : null;
    if (replyAixInput && !isTemplateOptimize) {
      console.log(JSON.stringify({
        tag: replyAixPreDecision?.brainStale ? "aix:brain-stale-no-aix" : "aix:brain-decision",
        conversationId, tier: tierResult.tier, brainAction: brainDecision?.action ?? null, fresh: brainDecision?.fresh ?? false,
        setAix: replyAixPre?.action ?? null, sceneEvidence: sceneEvidencePre?.scene ?? null,
      }));
    }
    // 手動生成でブレインの判断が古い時: 生成はブロックせず、ブレインを後ろで起動する（結果は画面のリアルタイム更新で P5 カードに届く）。
    //   bg-async / cron 経路（enforceReplyModeGate=true）は自前でブレインを直列実行するので起動しない。60秒以内に分析済みなら二重起動しない
    if (conversationId && !enforceReplyModeGate && !isTemplateOptimize && replyAixInput && !brainDecision?.fresh
        && !replyAixInput.isFirstReply && !(replyAixInput.conversationStatus && DRAFT_SKIP_STATUSES.has(replyAixInput.conversationStatus))) {
      const analyzedAtMs = brainGate?.brainAnalyzedAt ? new Date(brainGate.brainAnalyzedAt).getTime() : NaN;
      if (Number.isNaN(analyzedAtMs) || Date.now() - analyzedAtMs > 60_000) {
        const convIdForBrain = conversationId;
        after(() => runBrainAndNotify(convIdForBrain).then(() => {}, (e) => console.warn("[generate-reply] stale brain rerun failed:", convIdForBrain, e instanceof Error ? e.message : e)));
      }
    }

    const messages = buildGenerationMessages(
      message, customerName, aixSourceMessage ? historyForTemplate : history, currentState,
      brainMeta, brainFreshForMessage, knowledge, examples, phrases,
      // body.customerConditionsが空のときDBから独自取得したcustomerConditionsDbをフォールバックで使う
      // → 生成側とfinal-check側の条件情報源の非対称を解消
      customerConditions || groundTruth.customerConditionsDb || "",
      resolvedSummary,
      promptOverrides, isFollowUp, replyHint, alreadyGreetedToday,
      isFirstEverReplyFromMsgs, viewingNote, customerStructured, dbRules,
      resolvedSummaryJson, quotedContextNote, propertyStatus, templateSystemNote + templateNote, brainGuidanceNote, directionNote,
      estimatePromised, knowledgeResult.topPrinciples, lastAixHistoryText, aixDone,
      tpoGuidanceNote,
      phaseGuideKey, isConditionPresented,
      estimateVerdict,
      confirmCtx,          // G26: 確認約束 verdict（生成・bridge・final-check の三層同一）
      greetingDecision,    // G30: 冒頭挨拶の決定論結果（リテラル埋め込み）
      turnPairNote,        // 2026-09-09 Fable5: 往復文脈ブロック
      customerMsgUnits,    // 2026-09-09 Fable5: 通単位の配列（[N通目] 表示は通単位のみ）
      stanceNote,          // 2026-09-09 Fable5 みく事例: 【🧭 姿勢】ブロック
      hedge,               // 2026-09-09 Fable5 みく事例: budgetInventoryNote の発火ゲート
      actionLedgerNote,    // 2026-09-09 Fable5 行動台帳: 【📒 我々の行動台帳】ブロック
      ledgerAnnotation,    // 2026-09-09 Fable5 行動台帳: 直前発言の宣言／実行注記
      ledgerActive ? ledger.facts.pickupPromisedUnfulfilled : null, // 2026-09-11 統合設計（経路E5）: 約束検出を台帳で絞る
      replyAixPre,         // 2026-09-12 竹内方針「AIX のセットはブレインが判断する」段1: ブレインが決めた AIX（fresh の時だけ）
      bodySafetyPre,       // 同段1: 証拠から引いた本文の安全
    );

    // ─── reply_modeゲート チェックポイントB（本命）───
    // チェックポイントB: 必ずDBを新鮮フェッチする（キャッシュ再利用禁止）。
    // 理由: bg-asyncでブレインが30sタイムアウト→brainGateDirect=null の場合、
    // AとBの間（Anthropicコール中=5〜15s）にブレインが完了して reply_mode="aix" を書くことがある。
    // Aのスナップショット再利用だとこのケースを取りこぼし、テキストとAIXが両方表示されるバグが起きる。
    // enforceReplyModeGate=false（手動ボタン）はゲートをスキップ。bg-async/cronのみtrueを渡す設計。
    if (enforceReplyModeGate && conversationId && !isTemplateOptimize && !isFirstReplyGateExempt) {
      const freshGateB = await fetchReplyModeGate(conversationId);
      if (freshGateB?.meta?.reply_mode === "aix") {
        console.log("[generate-reply] reply_mode=aix → 自動ドラフト中止(B・新鮮フェッチ):", conversationId);
        return applyAixGateAndRespond(conversationId, freshGateB.meta, freshGateB.customerName);
      }
    }
    if (enforceReplyModeGate && conversationId && !isTemplateOptimize && !isFirstReplyGateExempt) {
      // P4(部分対応): reply_mode が null/undefined のままフェイルオープンするケースの可視化。
      // brain分析が失敗/停滞している可能性が高い場合（meta自体がnull、または brain_analyzed_at が
      // 10分以上前 or 未記録）は警告ログを出す。ブロックはしない（ログのみ・従来動作維持）。
      if (brainGate?.meta?.reply_mode == null) {
        const analyzedAt = brainGate?.brainAnalyzedAt ?? null;
        const analyzedAgeMs = analyzedAt ? Date.now() - new Date(analyzedAt).getTime() : null;
        const brainLikelyStale =
          brainGate?.meta == null || analyzedAgeMs == null || analyzedAgeMs > 10 * 60 * 1000;
        if (brainLikelyStale) {
          console.warn(
            "[generate-reply] P4警告: enforceReplyModeGate=true だが reply_mode 未設定のままフェイルオープン:",
            conversationId,
            `meta=${brainGate?.meta == null ? "null" : "present(no reply_mode)"}`,
            `brain_analyzed_at=${analyzedAt ?? "null"}`
          );
        }
      }
    }

    // テンプレート最適化モードは maxTokens 広めの専用モデル（通常生成は createGenerationModel）
    const genStream = (isTemplateOptimize
      ? createTemplateOptimizeModel()
      : createGenerationModel()
    ).stream(messages);

    // B-2: 品質判定フラグ（自動返信ハードゲート用）
    // is_applying_docs は静的に判定可能なのでここで計算。
    // has_placeholder / is_truncated はストリーミングをバッファしないため、
    // 生成完了後にクライアント側で判定する（サーバーでは常に false を返す）。
    const qualityFlags = {
      has_placeholder: false,  // [日付]等が残っているか（生成後にクライアントで判定）
      is_truncated: false,     // finish_reason=lengthか（生成後にクライアントで判定）
      is_applying_docs: currentState === "applying" && /審査|書類|申込書|保証人/.test(message),
      auto_ok: false,          // 全チェックfalseなら送信OK候補（クライアントで確定）
    };

    // 2026-09-12 竹内方針「AIX のセットはブレインが判断する」段1: replyAixPre / bodySafetyPre は buildGenerationMessages の前で1回だけ計算済み。
    // G26: 確認約束 verdict に合成（buildGenerationMessages 内と同じ pure 関数・同じ根拠 → 三層で同値）
    const confirmCtxFinal: ConfirmationContextVerdict = applyAixTiming(confirmCtx, confirmationBasisAction(bodySafetyPre, replyAixPre));

    // スタッフ向けガイドメモ: brain(AIX-META) の closing_strategy / reply_direction をメタラインで返す。
    // Step1廃止（2026-08）: 両方 null なら過去のbrain実行がDBに残した ai_summary_json.winning_pattern に
    // フォールバック。
    // AIXボタン種別アナウンス改善(2026-08): AIXタイミング判定がヒットした場合は "closing"（ガイドメモ専用）
    // ではなく実ボタンキー＋「AIX【ボタン名】を押してください: 理由」の具体的指示を優先して返す。
    // ※SUGGESTED_AIXトレーラーが後着で同等以上の情報に上書きするため互換性は保たれる
    //  （トレーラーが出ない場合はこのメタ行の値がそのまま表示され続ける＝従来は空白だった箇所）。
    const suggestedAixForMeta = (() => {
      // 2026-09-12 竹内方針A: メタ行も resolveReplyAix の出力をそのまま使う（トレーラー・ai_draft_check と同じ形）
      if (replyAixPre) return toSuggestedAixPayload(replyAixPre);
      const note = brainMeta?.closing_strategy
        || brainMeta?.reply_direction
        || resolvedSummaryJson?.winning_pattern
        || null;
      return note ? { action: "closing", note } : null;
    })();

    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        async start(controller) {
          // 1行目: メタデータJSON（フロントエンドがok確認に使用）
          // テンプレート最適化モードはボディを「最適化テキストのみ」にするためメタ行を出さない
          if (!isTemplateOptimize) {
            controller.enqueue(encoder.encode(
              JSON.stringify({ ok: true, quality: qualityFlags, suggested_aix: suggestedAixForMeta }) + "\n"
            ));
          }
          // 生成完了テキスト（conversationId 指定時の ai_draft 保存用）
          let finalDraftText = "";
          // 最終チェック前のドラフト本文（センシティブ警告メタを含まない・チェック対象テキスト）
          let draftBody = "";
          // 生成のstop_reason（includeStopReason=true時にトレーラーで呼び出し元へ返す）
          let genStopReason: unknown;
          try {
            const genInputLength = messages.reduce(
              (n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0
            );
            // f-8: センシティブ案件（クレーム/審査否決/キャンセル・リスケ）検知時はドラフト冒頭に警告メタを付与
            // ※テンプレート最適化モードは会話への返信生成ではないため付与しない
            const sensitiveGateNote = !isTemplateOptimize ? buildSensitiveGateNote(message) : "";
            // ─── 2026-09-11 統合設計（経路F）: 後処理（validateAndClean）の共通化＋安全弁 ───────────────
            //   ①事前の免除: 選ばれたセルの必須要素／未履行約束の復唱（isCellRequiredSentence）はゲートで削除しない（protect）
            //   ②事後の取り消し: ゲートの削除で新たに骨格系 block（決定論・約0ms）が出たら、取り消せるゲート（ピックアップ再宣言のみ）を外して
            //     もう一度 validateAndClean にかけ、GATE_PAIR_CONFLICT（warning・pass=meta）として記録する。
            //     断言禁止（G6・宅建業法）・内覧候補日時・待ち合わせ確定・物件固有金額・見積書カバー文・分割払い提案は取り消さない
            //   gen1・gen2 の両方が同じ関数を通る（旧実装は applyLedgerAutoFix が gen1 だけだった）
            const postprocessLog: Array<{ gen: number; code: string; introduced: string[]; reverted: string[] }> = [];
            let lastGateEdits: Array<{ rule: string; before: string; after: string | null; reversible: boolean }> = [];
            let lastValidateIssues: string[] = [];
            let genIndex = 0;
            const gateCheckCtx = {
              recentMessages, lastCustomerMessage: message, customerName: customerName || undefined,
              tpoLabel: tpoNoteForLLM ?? undefined, isEarlyConversation: isFirstEverReplyFromMsgs,
              substance, pairContext, hedge, closerVerdict,
              confirmationContext: confirmCtxFinal, activeTaskTypes,
              estimateContext: estimateVerdict, sentPropertiesCount: estimateVerdict.sentPropertiesCount,
              ledger: ledgerForCtx ?? undefined, ledgerStrict: ledgerActive, isDeliverableReply: isAixPropertySendMode,
              nameAliases: addressName.aliases,
            };
            const runValidate = (openingFixed: string, aixGates: boolean): { cleaned: string; issues: string[] } => {
              const vOpts = {
                aixGates, customerName, lineDisplayName, estimatePromised, customerMessage: message, lastStaffMsg: lastStaffMsgForSearch,
                // 2026-09-11 竹内方針3: 呼びかけ位置の別名を確定名に統一（applySurfaceFixes ①）
                nameAliases: addressName.aliases,
                customerConditions: customerConditions || groundTruth.customerConditionsDb || "",
                protect: (s: string) => isCellRequiredSentence(s, pairContext),
                aixVacancyDone: !!(aixDone?.vacancyCheck || aixDone?.mgmtCheck), aixPickupDone: !!aixDone?.propertySend,
              };
              let vr = validateAndClean(openingFixed, vOpts);
              if (aixGates && vr.gateEdits.some((e) => e.reversible)) {
                try {
                  // 多重集合で比較（同じ要素が別に既に欠けていても、ゲートの削除で1件増えたら検知する）
                  // 2026-09-11 竹内方針1: PAIR_ELEMENT_MISSING は info（観測専用）になったので、severity 非依存の cellElementGaps（セル必須要素の欠落ラベル）
                  //   ＋ block で残る骨格系（EMPTY_CLOSER / SPLIT_ACK_REPLY）で比較する（旧 skeletonBlockCodes だけだと安全弁が黙って無効になる・E1-k）
                  const gapCodes = (t: string) => [...cellElementGaps(t, gateCheckCtx), ...skeletonBlockCodes(t, gateCheckCtx)];
                  const beforeCodes = gapCodes(openingFixed);
                  const introduced = gapCodes(vr.cleaned).filter((c) => {
                    const i = beforeCodes.indexOf(c);
                    if (i >= 0) { beforeCodes.splice(i, 1); return false; }
                    return true;
                  });
                  if (introduced.length) {
                    const reverted = vr.gateEdits.filter((e) => e.reversible).map((e) => e.before.trim().slice(0, 40));
                    console.warn("[postprocess] GATE_PAIR_CONFLICT → ピックアップ再宣言ゲートを取り消し:", JSON.stringify({ introduced, reverted }));
                    postprocessLog.push({ gen: genIndex, code: "GATE_PAIR_CONFLICT", introduced: [...new Set(introduced)], reverted });
                    vr = validateAndClean(openingFixed, { ...vOpts, aixPickupDone: false });
                  }
                } catch (e) {
                  console.warn("[postprocess] 安全弁の評価に失敗（ゲート結果のまま続行）:", e instanceof Error ? e.message : e);
                }
              }
              lastGateEdits = vr.gateEdits;
              lastValidateIssues = vr.issues;
              return { cleaned: vr.cleaned, issues: vr.issues };
            };
            /** 行動台帳の決定論自動修正（gen1・gen2 共通。名前不明時は呼びかけごと省く＝「〇〇さん」を本文に書き込まない） */
            const applyLedgerFixToDraft = (body: string): string => {
              if (!ledgerActive || isFollowUp || !body.trim()) return body;
              const fx = applyLedgerAutoFix(body, ledger, { customerMessage: message ?? "", name: customerName ? `${customerName}さん` : "", isDeliverableReply: isAixPropertySendMode });
              if (fx.applied.length) { console.info("[ledger-autofix]", JSON.stringify(fx.applied)); return fx.text; }
              return body;
            };
            // ─── 生成ストリーム消費＋後処理の共通関数 ───────────────────────
            // 1回目生成と「最終チェック指摘フィードバック再生成」（下のリトライループ）の両方で使うため関数化。
            // 挨拶強制置換・validateAndClean・テンプレ後処理のロジックは従来と同一。
            const consumeGeneration = async (
              streamPromise: typeof genStream
            ): Promise<{ body: string; stopReason: unknown }> => {
              let fullText = "";
              let stopReason: unknown;
              // プロンプトキャッシュ効果の観測（コスト最適化の検証基盤）:
              // LangChain の AIMessageChunk は usage_metadata（正規化済み）または
              // response_metadata.usage（Anthropic生形式）にキャッシュ統計を載せる。両方を拾う。
              let cacheUsage: { read: number; write: number; input: number } | null = null;
              for await (const chunk of await streamPromise) {
                // thinking有効時等、content が string ではなくブロック配列で届くケースに対応。
                // text ブロックのみ抽出し、thinking ブロックは本文に混ぜない。
                const text = typeof chunk.content === "string"
                  ? chunk.content
                  : Array.isArray(chunk.content)
                    ? chunk.content
                        .map((b) =>
                          typeof b === "string"
                            ? b
                            : b != null && typeof b === "object" &&
                              (b as { type?: string }).type !== "thinking" &&
                              typeof (b as { text?: unknown }).text === "string"
                              ? (b as { text: string }).text
                              : ""
                        )
                        .join("")
                    : "";
                fullText += text;
                if (chunk.response_metadata?.stop_reason) stopReason = chunk.response_metadata.stop_reason;
                // キャッシュ統計の捕捉: message_start 相当のチャンクに input_tokens とキャッシュ内訳が載る
                const um = (chunk as {
                  usage_metadata?: {
                    input_tokens?: number;
                    input_token_details?: { cache_read?: number; cache_creation?: number };
                  };
                }).usage_metadata;
                if (um && (um.input_tokens ?? 0) > 0) {
                  cacheUsage = {
                    read: um.input_token_details?.cache_read ?? 0,
                    write: um.input_token_details?.cache_creation ?? 0,
                    input: um.input_tokens ?? 0,
                  };
                }
                const rawUsage = (chunk.response_metadata as {
                  usage?: { cache_read_input_tokens?: number; cache_creation_input_tokens?: number; input_tokens?: number };
                } | undefined)?.usage;
                if (!cacheUsage && rawUsage && typeof rawUsage.input_tokens === "number") {
                  cacheUsage = {
                    read: rawUsage.cache_read_input_tokens ?? 0,
                    write: rawUsage.cache_creation_input_tokens ?? 0,
                    input: rawUsage.input_tokens ?? 0,
                  };
                }
              }
              // プロンプトキャッシュ効果の観測ログ（read>0 = キャッシュHIT / write>0 = キャッシュ書込 / どちらも0 = 無効）
              if (cacheUsage) {
                console.log(
                  `[cache:gen-reply] read=${cacheUsage.read}` +
                  ` write=${cacheUsage.write}` +
                  ` input=${cacheUsage.input}` +
                  ` conv=${conversationId}`
                );
              }
              warnIfTruncated(stopReason, genInputLength);
              if (shouldPrependGreeting && !isTemplateOptimize) {
                // 真の初回: 全バッファして冒頭挨拶を強制置換（AIが誤生成しても確実に正しい名前を出す）
                // ※テンプレート最適化モードは常に下の通常バッファ経路（テンプレの構成を挨拶強制置換で壊さない）
                // G30（2026-09-08 Fable5）: 挨拶は resolveGreeting で決定論確定済み。LLM 出力の冒頭挨拶センテンスを
                // 剥がして固定挨拶に置換する（greeting.ts enforceOpening。旧 aiGreetingPattern / greetingSentencePattern を移設）
                const { cleaned: openingFixed, fixes: openingFixes } = enforceOpening(fullText, greetingDecision);
                if (openingFixes.length) console.log("[greeting] enforce:", openingFixes);
                // aixGates: プロンプトのAIXゲート指示をLLMが無視した場合の機械検証（違反文を宣言テンプレに置換）
                // customerName/lineDisplayName: 本文に混入したLINE表示名を確定的に実名へ置換／除去
                const { cleaned, issues } = runValidate(openingFixed, true);
                if (issues.length > 0) console.warn("[validate-reply] issues:", issues);
                // enqueue はここでは行わない: 下の最終チェック（前頭前野モデル）＋センシティブ警告付与後に一括出力する
                return { body: cleaned, stopReason };
              }
              // 非初回: 全テキストをバッファしてから validateAndClean を適用してストリーム出力
              // G32: late_apology（催促）/ 夜間接頭辞は enforceOpening で確定差し込み。
              //      standard / none は LLM が挨拶行・お待たせを書いた時のみ決定論の挨拶行に差し替え（お待たせは常に除去。プロンプト＋final-check に委ねる）
              const { cleaned: openingFixed, fixes: openingFixes } = isTemplateOptimize
                ? { cleaned: fullText, fixes: [] as string[] }
                : enforceOpening(fullText, greetingDecision);
              if (openingFixes.length) console.log("[greeting] enforce:", openingFixes);
              // aixGates: 通常返信ドラフトのみ機械検証。テンプレート最適化はAIX由来の日時・金額が正当なため対象外
              const { cleaned, issues } = runValidate(openingFixed, !isTemplateOptimize);
              if (issues.length > 0) console.warn("[validate-reply] issues:", issues);
              let outText = cleaned;
              // テンプレート最適化モードの後処理: 号室先頭ゼロ除去 + noEmoji時の絵文字除去（旧adaptルート互換）
              if (isTemplateOptimize) {
                outText = stripRoomLeadingZeros(outText);
                // g-7: 金額ハルシネーション機械検証（テンプレ最適化はaixGates対象外のため専用ポストチェック）
                // 【物件固有の金額・数値はAIが画像を見れないため生成禁止】— 出力中の「〜円」が
                // スタッフ由来ソース（AIX物件情報・テンプレ原文・予約送信AIX・会話履歴・希望条件DB）に
                // 実在するか検証し、ソースにない金額は「〇〇円」に置換する（プロンプト指示無視の最終防衛線）
                const amountSource = [
                  aixSourceMessage,
                  preprocessedTemplate,
                  pendingScheduledMessages.map((m) => m.text ?? "").join("\n"),
                  history,
                  customerConditions,
                ].filter(Boolean).join("\n");
                const { cleaned: amountChecked, unmatched } = verifyAmountsAgainstSource(outText, amountSource);
                if (unmatched.length > 0) {
                  console.warn("[validate-reply] template-optimize 金額ソース不一致(〇〇円に置換):", unmatched);
                  outText = amountChecked;
                }
                if (noEmoji) outText = outText.replace(/[😊😌🌟✨]/gu, "");
                // 決定的禁止語彙スキャン（テンプレ最適化は final-check を完全バイパスするため専用の最終防衛線）
                // 「スモラ」のみ決定的置換可能（→「弊社」）。他は構造依存のため警告ログのみ（テンプレ原文由来の可能性があるため自動削除しない）
                if (outText.includes("スモラ")) {
                  console.warn("[validate-reply] template-optimize 禁止語彙「スモラ」検出 → 「弊社」に置換");
                  outText = outText.split("スモラ").join("弊社");
                }
                for (const bannedWord of ["名称未設定", "**", "少々お待ちください"]) {
                  if (outText.includes(bannedWord)) {
                    console.warn(`[validate-reply] template-optimize 禁止語彙検出（要目視確認）: ${bannedWord}`);
                  }
                }
                outText = outText.trim();
              }
              // enqueue はここでは行わない: 下の最終チェック（前頭前野モデル）＋センシティブ警告付与後に一括出力する
              return { body: outText, stopReason };
            };
            // 1回目の生成
            genIndex = 1;
            const gen1 = await consumeGeneration(genStream);
            draftBody = gen1.body;
            genStopReason = gen1.stopReason;
            // 2026-09-09 Fable5 行動台帳: 生成直後の決定論自動修正（Sonnet 不使用）。台帳に実績が無い「再度／改めて／お送りした〇〇／完了形」を
            //   語の削除・未来形置換で正す（final-check 修正ループと同じ applyLedgerAutoFix）。テンプレ最適化・follow-up は対象外
            //   2026-09-11 統合設計: gen1・gen2 共通の applyLedgerFixToDraft（名前不明時に「〇〇さん」を書き込まない）
            draftBody = applyLedgerFixToDraft(draftBody);
            // ─── 最終チェック+接地修正ループ（前頭前野モデル v2 / claude-haiku-4-5）────
            // check1(≤2.5s) → blockあり時のみ 接地修正(≤3.5s) → check2(≤2.5s)。チェックは計2回上限。
            // 修正は checkpoint事実・DBルール・顧客条件に接地し、引用検証を通らない置換は破棄。
            // 修正版は再チェックでblock解消を確認できた場合のみ採用（未検証文は絶対に出さない）。
            // block解消不能時は元ドラフト+block指摘+revision_exhausted のまま返し、
            // スタッフ確認モーダルに委ねる（強制置換なし）。チェック失敗は従来どおり fail-open。
            // トレーラーの finalCheck に revision_count が必ず載る（監査用）。
            let finalCheck: CheckResult | null = null;
            if (isTemplateOptimize && draftBody.trim()) {
              console.log(JSON.stringify({tag:"degradation:fail-open",path:"template-bypass",conversationId}));
            }
            if (!isTemplateOptimize && draftBody.trim()) {
              try {
                // 段階の日本語説明（MEDIUM-2: STAGE_SKIP検出用）
                const STAGE_JP: Record<string, string> = {
                  first_reply: "初回対応（挨拶・条件ヒアリング開始）",
                  hearing: "条件ヒアリング中",
                  proposing: "物件提案・案内中",
                  viewing: "内覧調整・内覧後フォロー中",
                  applying: "申込準備中",
                  closed_won: "成約済み",
                  closed_lost: "失注後の再接触",
                };
                // ng_properties: brainGuidanceNote IIFE内の ngProps と同一ロジック（IIFE外から再導出）
                // brainFreshForMessage ゲートは IIFE側と揃える（stale時は古いリストで「安全」誤認を防ぐ）
                const ngPropertiesForCheck: string[] = brainFreshForMessage
                  ? (brainMeta?.property_search_params?.ng_properties ?? [])
                      .filter((p) => p?.property_name)
                      .map((p) => `${p.property_name}${p.room_no ? ` ${p.room_no}` : ""}`)
                  : [];
                // 1回目チェックと再生成後の2回目チェックで同一コンテキストを使う
                const finalCheckCtx = {
                  dbRules,
                  finalCheckRules: finalCheckRules || undefined,
                  recentMessages,
                  lastCustomerMessage: message,
                  // 2026-09-08 語彙セマンティクス: 送付済み物件数を履歴から決定論で算出（countSentProperties: 見積書画像・地図等は除外）
                  sentPropertiesCount: estimateVerdict.sentPropertiesCount,
                  // 見積書の文脈判定 verdict（生成側と同一オブジェクト → E5 / E10 で参照）
                  estimateContext: estimateVerdict,
                  // Step1廃止（2026-08）: 旧 step1Json（Step1生JSON）→ brainMeta のコンパクトサブセット。
                  // message-local フィールドは鮮度ゲート（brainFreshForMessage）通過時のみ含める
                  // reply_direction / key_topics / avoid_topics は TPO上書き後の effective値を渡す
                  // （生brainMetaを渡すと、TPOで封じたはずの話題をファイナルチェックが要求する逆転が起きる）
                  brainContextJson: brainMeta
                    ? JSON.stringify({
                        closing_strategy: brainMeta.closing_strategy ?? null,
                        reply_direction: effectiveReplyDirection ?? brainMeta.reply_direction ?? null,
                        key_topics: effectiveKeyTopics,
                        avoid_topics: activeAvoidTopics,
                        recommended_tone: brainMeta.recommended_tone ?? null,
                        next_steps: brainMeta.next_steps ?? [],
                        engagement_stance: brainMeta.engagement_stance ?? null,
                        ...(brainFreshForMessage
                          ? {
                              customer_questions: brainMeta.customer_questions ?? [],
                              repeated_concern: brainMeta.repeated_concern ?? null,
                              current_property: brainMeta.current_property ?? null,
                              condition_change_type: brainMeta.condition_change_type ?? null,
                              hesitancy_pattern: brainMeta.hesitancy_pattern ?? null,
                              future_timeline: brainMeta.future_timeline ?? null,
                            }
                          : {}),
                      })
                    : undefined,
                  // お客様の確定名を情報源に含める（anomaly_scan の FABRICATED_NAME 誤検知を防ぐ）
                  staffSourceText: [
                    customerName ? `お客様のお名前: ${customerName}さん` : "",
                    aixSourceMessage,
                    customerConditions,
                  ].filter(Boolean).join("\n") || undefined,
                  checkpointFacts: groundTruth.checkpointFacts,
                  customerConditionsDb: groundTruth.customerConditionsDb,
                  isAutoSend: enforceReplyModeGate,   // HIGH-1/2: 自動送信経路のみ true
                  // S-4: 生成側 shouldPrependGreeting（初回挨拶強制）と同値。開口語チェック／INTRO_REPEAT の初回免除に使う
                  isEarlyConversation: isFirstEverReplyFromMsgs,
                  isAix: true,                        // generate-reply はAIX機能そのもの
                  // S-2: 段階ラベルは phaseGuideKey 基準（TPO・PHASE_GUIDE・final-check で同一キー）
                  conversationStage: STAGE_JP[phaseGuideKey] ?? currentState, // MEDIUM-2
                  phaseKey: phaseGuideKey,
                  // S-5: 顧客名の一貫性チェック（checkNameConsistency）用
                  customerName: customerName || undefined,
                  allowNames: allowNamesForCheck.length ? allowNamesForCheck : undefined,
                  // 2026-09-11 竹内方針3: スタッフが過去に呼んだ名前・顧客の名乗りは block しない（resolveAddressName の aliases）
                  nameAliases: addressName.aliases,
                  brainMeta: brainMeta
                    ? {
                        // S-3: チェック側にも鮮度ゲート済み action を渡す（stale action で STAGE_SKIP 抑制・Brain判定済み免除が効かないように）
                        action: effectiveAction,
                        enforcement_level: (brainMeta.enforcement_level ?? "recommended") as "required" | "recommended",
                        engagement_stance: (brainMeta.engagement_stance ?? null) as "push" | "wait" | null,
                      }
                    : null,
                  checkpointStage: brainMeta?.checkpoint_stage ?? null, // Fix③: brain実態フェーズ（DB stateと乖離検出用）
                  tpoLabel: tpoNoteForLLM ?? undefined, // TPO場面（感謝返し/ネガ文脈/強推し直後 等）をチェック側にも共有
                  ngProperties: ngPropertiesForCheck.length ? ngPropertiesForCheck : undefined,
                  // 2026-09-08 Fable5 G10/G26/G6/G30: 生成側と同一オブジェクトを検査側に渡す（三者同名）。detCtx / postDetCtx にも同じ行を置く
                  moveOutSubject,                                                  // G10
                  confirmationContext: confirmCtxFinal, activeTaskTypes,           // G26
                  aixVacancyDone: !!(aixDone?.vacancyCheck || aixDone?.mgmtCheck), // G6（validateAndClean と同値）
                  greetingKind: greetingDecision.kind, expectedOpening: greetingDecision.openingLine, greetingDecision: toGreetingLite(greetingDecision), // G30/G31
                  substance, pairContext,                                          // 2026-09-09 REPLY_SKELETON（四者同名）
                  hedge, closerVerdict,                                            // 2026-09-09 みく事例: ヘッジゲート・締めポリシー（四者同名）
                  brainStrategy: brainLocalFresh ? brainStrategy : null, cellConflicts, // 2026-09-10 みく事例: 会話スコープ方針・セル衝突（四者同名）
                  ledger: ledgerForCtx ?? undefined, isDeliverableReply: isAixPropertySendMode, ledgerStrict: ledgerActive, // 2026-09-09 行動台帳（生成側と同一オブジェクト・四者同名）
                  // 2026-09-11 統合設計（経路F1）: 後処理ゲートの判断（resolvePickupGate 整合後）。生成ノート・後処理・検査が同じ値
                  aixDone: aixDone ? { propertySend: aixDone.propertySend, vacancyCheck: aixDone.vacancyCheck, mgmtCheck: aixDone.mgmtCheck, pickupGateReason: aixDone.pickupGateReason } : null,
                };
                // センシティブ案件（クレーム/審査否決/キャンセル）は「参考のみ・手動確認必須」の草稿のため
                // チェックのみ実行し、接地修正・フィードバック再生成でドラフトを機械的に触らない
                // （謝罪ニュアンス等を revision が壊すリスク回避＋最大90秒超の無駄コスト削減。指摘の可視化だけで十分）
                const finalCheckStart = Date.now(); // regen込み総予算の基準時刻（5-12）
                const loop = sensitiveGateNote
                  ? { finalDraft: draftBody, finalCheck: await runFinalCheck(draftBody, finalCheckCtx) }
                  : await runFinalCheckWithRevision(draftBody, finalCheckCtx, 90000);
                finalCheck = loop.finalCheck;
                draftBody = loop.finalDraft; // ベスト草稿（成功時=修正版 / 修正不能時=元ドラフト）
                if (finalCheck.revision_count === undefined) finalCheck.revision_count = 0;
                finalCheck.regen_count = 0;
                // ─── 最終チェック問題→フィードバック再生成ループ（最大1リトライ）────
                // 接地修正ループ（runFinalCheckWithRevision内部）を通しても warning 以上の指摘が
                // 残った場合、指摘内容（何が問題か＋どう修正すべきか）を修正指示としてまとめ、
                // 元プロンプト＋1回目ドラフト＋フィードバックで Sonnet に丸ごと再生成させ、
                // 再生成ドラフトに最終チェック（2回目）を再適用する。
                // ・2回目のチェックで問題なければそれを返す
                // ・2回目でも問題が残れば2回目の結果をそのまま返す（無限ループ防止・最大1リトライ）
                // ・再生成の失敗・空生成時は1回目の結果で続行（fail-open）
                // ・regen_count がトレーラー/ai_draft_check に載る（監査用）
                const retryIssues = finalCheck.issues.filter(
                  (it) => it.severity === "block" && it.code !== "UNCHECKED_AUTO_SEND"
                );
                // 2026-09-11 統合設計（D1）: 再生成すると finalCheck が loop2 で丸ごと置換されるため、1回目生成のチェック結果を別に残す
                const firstPass = { issues: finalCheck.pre_revision_issues ?? finalCheck.issues.map((i) => `${i.code}:${i.severity}`), head: draftBody.slice(0, 80) };
                // センシティブ案件は再生成もスキップ（手動確認前提。指摘はトレーラーで可視化される）
                if (retryIssues.length > 0 && !sensitiveGateNote) {
                  try {
                    // 2026-09-11 統合設計（S3・YUYA 事例）: 同じ修正案を重複して渡さない（同じ文を3回貼らせない）
                    const seenRetry = new Set<string>();
                    const retryIssuesDedup = retryIssues.filter((it) => {
                      const k = `${it.code}|${it.suggestion ?? ""}`;
                      if (seenRetry.has(k)) return false;
                      seenRetry.add(k);
                      return true;
                    });
                    const feedback = [
                      "【最終チェック結果のフィードバック】",
                      "あなたが直前に生成した返信ドラフトを最終チェックした結果、以下の問題が見つかりました。",
                      "問題を全て解消した返信を、これまでと同じ指示・同じ条件で最初から書き直してください。",
                      "",
                      "検出された問題:",
                      ...retryIssuesDedup.map((it, i) =>
                        `${i + 1}. ${it.message}` +
                        (it.evidence ? `（該当箇所:「${it.evidence}」）` : "") +
                        (it.suggestion ? ` → 修正方法: ${it.suggestion}` : "")
                      ),
                      "",
                      "注意:",
                      // 2026-09-09 Fable5 往復文脈: 再生成でも骨格（直前発話×顧客返答・必須要素）を落とさない
                      `- 【往復文脈】${pairContext.summary}`,
                      // 2026-09-10 Fable5 Sさん事例: rule=null だと【必須要素】行が丸ごと落ち、regen が
                      //   「何を書けばよいか」の材料を1つも受け取れなかった（修正ループが枯れる第3の経路）。
                      //   null でも WE DO の**選択肢**は渡す（「〇〇の1文を添えろ」型の強制はしない）。
                      //   when が false の要素（この場面に無い要素）は出さない＋{viewingOffer} 等は実値に置換する
                      ...(pairContext.rule
                        ? [`- 【必須要素】${pairContext.rule.mustInclude.filter((m) => !m.when || m.when(pairContext)).map((m, i) => `${i + 1}.${fillPairPlaceholders(m.label, pairContext)}`).join(" ")}（各1文以上。「かしこまりました！！」で終えず行動宣言またはサポート継続宣言で終える）`]
                        // 2026-09-11 統合設計（経路B）: 内覧提案リテラルは {viewingOffer}（顧客名スロット済み・名前不明なら呼びかけなし）
                        : [`- 【WE DO の選択肢】次のいずれか1つだけを文脈から選ぶ（複数並べない）: ①内覧のご案内提案（「${fillPairPlaceholders("{viewingOffer}", pairContext)}」・具体的な候補日時は書かない）②募集状況の確認 ③御見積書の作成・送付 ④ご条件に合うお部屋のピックアップ ⑤条件・家賃の交渉`]),
                      "- 指摘箇所だけを直すのではなく、返信全体を自然な文章として書き直すこと",
                      "- 問題のなかった部分の内容・トーンは維持すること",
                      "- 返信本文のみを出力すること（説明・前置き・修正内容の解説は書かない）",
                    ].join("\n");
                    console.warn(
                      "[generate-reply] 最終チェック指摘あり→フィードバック再生成:",
                      retryIssues.map((it) => it.code).join(",")
                    );
                    const retryMessages = [...messages, new AIMessage(draftBody), new HumanMessage(feedback)];
                    genIndex = 2;
                    const gen2 = await consumeGeneration(
                      createGenerationModel().stream(retryMessages)
                    );
                    if (gen2.body.trim()) {
                      // 2026-09-11 統合設計: gen2 にも gen1 と同じ台帳の決定論自動修正を掛ける（旧実装は gen1 のみ＝非対称）
                      const gen2Body = applyLedgerFixToDraft(gen2.body);
                      // 再生成ドラフトにも最終チェック＋接地修正ループを適用（未チェック文は絶対に出さない）
                      // 予算はループ単位ではなく「check1開始からの総経過時間」から逆算（regen込みで最悪2〜3分に膨らむのを防止。
                      // 全体上限150s − 経過時間、下限20s）
                      const loop2Budget = Math.max(20000, 150000 - (Date.now() - finalCheckStart));
                      const loop2 = await runFinalCheckWithRevision(gen2Body, finalCheckCtx, Math.min(60000, loop2Budget));
                      draftBody = loop2.finalDraft;
                      finalCheck = loop2.finalCheck;
                      finalCheck.regen_count = 1;
                      finalCheck.first_pass_issues = firstPass.issues;
                      finalCheck.first_pass_draft_head = firstPass.head;
                      genStopReason = gen2.stopReason ?? genStopReason;
                      console.log(
                        "[generate-reply] 再生成後チェック:",
                        finalCheck.issues.length === 0 ? "指摘解消" : `指摘残り(${finalCheck.issues.length}件)`
                      );
                    } else {
                      console.warn("[generate-reply] フィードバック再生成が空出力→1回目の結果で続行");
                      console.log(JSON.stringify({tag:"degradation:fail-open",path:"regen-empty",conversationId,blockCount:finalCheck?finalCheck.issues.filter((i)=>i.severity==="block").length:null}));
                    }
                  } catch (regenErr) {
                    console.error("[generate-reply] フィードバック再生成失敗（1回目の結果で続行）:", regenErr);
                    console.log(JSON.stringify({tag:"degradation:fail-open",path:"regen-error",conversationId,blockCount:finalCheck?finalCheck.issues.filter((i)=>i.severity==="block").length:null,error:String(regenErr).slice(0,200)}));
                  }
                }
                // 顧客名の最終防衛線: 接地修正（Haiku）は [CHECKPOINT]/[CONDITIONS]/[RULES] に無い
                // 事実で置換できない仕様のため FABRICATED_NAME を自力で直せない（引用検証で修正ごと破棄される）。
                // 名前だけはDB由来の確定値があるので、修正ループ通過後にコード側で確定的に上書きする。
                const { cleaned: nameFixed, fixes: nameFixes } = enforceCustomerName(draftBody, {
                  customerName,
                  lineDisplayName,
                });
                if (nameFixes.length > 0) {
                  console.warn("[generate-reply] 最終チェック後の顧客名修正:", nameFixes);
                  draftBody = nameFixed;
                  // S-5(f): FABRICATED_NAME の一括削除は、実際に置換した名前（nameFixes の evidence）を含む指摘のみに限定
                  const fixedNames = nameFixes.map((f) => (f.match(/「([^」]+)さん」/)?.[1] ?? "")).filter(Boolean);
                  finalCheck.issues = finalCheck.issues.filter((i) => !(i.code === "FABRICATED_NAME" && fixedNames.some((n) => i.evidence.includes(n))));
                  finalCheck.ok = !finalCheck.issues.some((i) => i.severity === "block");
                }
              } catch (checkErr) {
                // A-2: final-check の例外時も決定論チェック（純関数・LLM不要）だけは必ず実行する（fail-open with deterministic）
                console.error("[generate-reply] final-check失敗（fail-open・決定論チェックのみで続行）:", checkErr);
                console.log(JSON.stringify({tag:"degradation:fail-open",path:"exception",conversationId,error:String(checkErr).slice(0,300)}));
                try {
                  const detCtx = {
                    recentMessages, lastCustomerMessage: message, isAutoSend: enforceReplyModeGate,
                    isEarlyConversation: isFirstEverReplyFromMsgs, tpoLabel: tpoNoteForLLM ?? undefined,
                    phaseKey: phaseGuideKey, customerName: customerName || undefined,
                    allowNames: allowNamesForCheck.length ? allowNamesForCheck : undefined,
                    nameAliases: addressName.aliases,                                // 2026-09-11 竹内方針3
                    sentPropertiesCount: estimateVerdict.sentPropertiesCount,
                    estimateContext: estimateVerdict,
                    moveOutSubject,                                                  // G10
                    confirmationContext: confirmCtxFinal, activeTaskTypes,           // G26
                    aixVacancyDone: !!(aixDone?.vacancyCheck || aixDone?.mgmtCheck), // G6（validateAndClean と同値）
                    greetingKind: greetingDecision.kind, expectedOpening: greetingDecision.openingLine, greetingDecision: toGreetingLite(greetingDecision), // G30/G31
                    substance, pairContext,                                          // 2026-09-09 REPLY_SKELETON（四者同名）
                    hedge, closerVerdict,                                            // 2026-09-09 みく事例: ヘッジゲート・締めポリシー（四者同名）
                    brainStrategy: brainLocalFresh ? brainStrategy : null, cellConflicts, // 2026-09-10 みく事例: 会話スコープ方針・セル衝突
                    ledger: ledgerForCtx ?? undefined, isDeliverableReply: isAixPropertySendMode, ledgerStrict: ledgerActive, // 2026-09-09 行動台帳
                  };
                  const nameRes = enforceCustomerName(draftBody, { customerName, lineDisplayName });
                  draftBody = nameRes.cleaned;
                  const det = runDeterministicChecks(draftBody, detCtx);
                  const degraded: CheckResult = {
                    ok: !det.some((i) => i.severity === "block"),
                    issues: det,
                    passes_completed: [],
                    elapsed_ms: 0,
                    checked_text_hash: await sha1(draftBody.trim()),
                    revision_count: 0,
                    regen_count: 0,
                  };
                  if (enforceReplyModeGate) {
                    degraded.issues.push({ pass: "rule_check", severity: "block", code: "UNCHECKED_AUTO_SEND", message: "LLMチェック未完了のため自動送信不可", evidence: "", suggestion: "手動確認" });
                    degraded.ok = false;
                  }
                  finalCheck = degraded;
                } catch (detErr) {
                  console.error("[generate-reply] 決定論チェックも失敗（チェックなしで続行）:", detErr);
                  finalCheck = null;
                }
              }
            }
            // ─── 優先度1(抜け穴対策): AIX切替検出 ─────────────────────────────
            // 「ドラフトがAIX境界を越えた」= 本来AIXで送るべき場面だったというシグナル。
            // - required切替: revision_exhausted かつ AIX_BOUNDARY_* block 残存
            //   → 壊れたドラフトを ai_draft に保存せず、suggested_aix_button を強制セットし
            //     SUGGESTED_AIX トレーラー（enforcement_level=required）でAIX誘導する
            // - hint: 軽度（warning級 / 修正で解消済み）の AIX_BOUNDARY 指摘
            //   → brain(suggested_aix_meta) が無提案だった場合のフォールバック候補（recommended）にする
            //     （従来 final-check の検出結果は SUGGESTED_AIX に一切反映されていなかった）
            // 2026-09-10 Fable5 Sさん事例（原因E）: revision_exhausted（AIが直せなかった block が残っている）は
            //   自動送信のハードストップにする。壊れたドラフトをそのまま顧客に送らず、スタッフの目に入れる。
            //   ※ 手動経路（enforceReplyModeGate=false）は従来どおり元ドラフト＋指摘表示のまま（強制置換はしない）
            if (!isTemplateOptimize && finalCheck && enforceReplyModeGate && finalCheck.revision_exhausted
                && finalCheck.issues.some((it) => it.severity === "block")
                && !finalCheck.issues.some((it) => it.code === "REVISION_EXHAUSTED_AUTO_SEND")) {
              finalCheck.issues.push({
                pass: "meta", severity: "block", code: "REVISION_EXHAUSTED_AUTO_SEND",
                message: "AIが自動修正を試みても block 指摘が解消できませんでした（revision_exhausted）。自動送信は行わずスタッフ確認に回します",
                evidence: finalCheck.issues.find((it) => it.severity === "block")?.evidence ?? "",
                suggestion: "残っている指摘を手動で直してから送信してください",
              });
              finalCheck.ok = false;
            }
            // 2026-09-12 竹内方針「AIX のセットはブレインが判断する」段1: 生成後も AIX はブレインの判断のまま（断言コードから AIX を選ばない）。
            //   final-check で直せなかった block（unresolvedBlock）は enforcement を required に上げる／自動送信を止める（stopAutoSend）だけ。
            //   ブレインが AIX なしで本文が直せない時は suggested_aix=null（P5.1 の汎用の案内）＋ [AIX誘導中]
            let replyAixPost: ReplyAix | null = replyAixPre;
            let aixBoundaryRequired: { action: string; code: string } | null = null;
            if (!isTemplateOptimize && finalCheck && replyAixInput) {
              const mapped = finalCheck.issues.filter((it) => isSceneMappedCode(it.code));
              const unresolved = finalCheck.revision_exhausted ? mapped.find((it) => it.severity === "block") ?? null : null;
              const post = resolveReplyAixDecision({
                ...replyAixInput,
                assertionHits: mapped.map((it) => it.code),
                unresolvedBlock: unresolved?.code ?? null,
              });
              replyAixPost = post.aix;
              if (post.stopAutoSend && unresolved) {
                aixBoundaryRequired = { action: replyAixPost?.action ?? "", code: unresolved.code };
                if (!replyAixPost) {
                  // ブレインは AIX なし・本文は直せない食い違い（段2で brain_decision_logs.body_block_code に記録する）
                  console.log(JSON.stringify({ tag: "aix:body-block-without-brain-aix", conversationId, code: unresolved.code, brainAction: brainDecision?.action ?? null, fresh: brainDecision?.fresh ?? false }));
                  // 2026-09-12 段2: 同じ会話で最新のブレインの判断の行に body_block_code を残す（ブレインの学習材料・fail-open）
                  const blockCode = unresolved.code;
                  after(async () => {
                    try {
                      const { data: lastDec } = await supabase
                        .from("brain_decision_logs")
                        .select("id")
                        .eq("conversation_id", conversationId)
                        .order("created_at", { ascending: false })
                        .limit(1)
                        .maybeSingle();
                      if (lastDec?.id) await supabase.from("brain_decision_logs").update({ body_block_code: blockCode }).eq("id", lastDec.id);
                    } catch (e) {
                      console.warn("[generate-reply] body_block_code update failed:", conversationId, e instanceof Error ? e.message : e);
                    }
                  });
                }
              }
            }
            // 同一絵文字の重複を決定的に除去（初出のみ残す・EMOJI_RULEの機械的最終防衛線）
            // プロンプト指示だけでは絵文字の個数制御は確率的にしか効かないためコードで保証する。
            // Extended_Pictographic で拾うため許可外絵文字（🥰等）の重複にも効く。
            // ※テンプレート最適化はテンプレ原文の絵文字配置が正当なため対象外
            if (!isTemplateOptimize && draftBody) {
              const seenEmoji = new Set<string>();
              const deduped = draftBody.replace(/\p{Extended_Pictographic}/gu, (e) =>
                seenEmoji.has(e) ? "" : (seenEmoji.add(e), e)
              );
              if (deduped !== draftBody) {
                console.warn("[generate-reply] 同一絵文字の重複を機械除去しました");
                draftBody = deduped;
              }
            }
            // S-5(e): 旧・貪欲正規表現による NAME_MISMATCH ブロック（「私の方でも竹田さん」を別名扱いして block）は廃止。
            //         名前チェックは checkNameConsistency（final-check runDeterministicChecks 内）が初回・recheck・後処理後に同一条件で走る
            // A-14 / §5: システムマーカー（<<<FINAL_CHECK 等）が本文に混入した場合は最終防衛線として除去
            if (!isTemplateOptimize && draftBody && /<<<(?:FINAL|SUGGESTED|STOP)/.test(draftBody)) {
              console.warn("[generate-reply] 本文にシステムマーカー混入 → 除去");
              draftBody = draftBody.replace(/\n?<<<(?:FINAL|SUGGESTED|STOP)[\s\S]*$/, "").trim();
            }
            // AIが返信全体を「」で囲む場合がある → 先頭「末尾」ペアを除去（後処理再検査より前に行う）
            if (!isTemplateOptimize && draftBody.startsWith("「") && draftBody.endsWith("」")) {
              draftBody = draftBody.slice(1, -1).trim();
            }
            // A-3（H-3/H-4）: 後処理（enforceCustomerName・絵文字重複除去・「」除去・マーカー除去）で本文が変わった後に
            //   決定論チェックを再実行し、決定論由来の指摘を最新本文の結果で差し替える（checked_text_hash 更新より前）
            if (!isTemplateOptimize && finalCheck && draftBody) {
              try {
                const DET_CODES_RE = /^(?:BANNED_WORD|THANK_OPENING|GRATITUDE_OPENING|CONDITION_OPENING|EXCLAMATION_OVERUSE|NG_PROPERTY_MENTION|INTRO_REPEAT|WE_DO_MISSING_DET|GENERIC_ONLY_REPLY|REPLY_SKELETON_MISSING|CONCERN_UNADDRESSED|EMPTY_CLOSER|PAIR_ELEMENT_MISSING|SPLIT_ACK_REPLY|FEELING_TEMPLATE|SYMPATHY_ECHO|NAME_|PROMISE_ECHO_MISSING|TIME_INVALID_HONIJITSU|EMOJI_RULE_DET|SYSTEM_MARKER_LEAK|QUOTE_UNBALANCED|NEGATIVE_APOLOGY|HASTY_PROMISE|ESTIMATE_NO_TRIGGER|STATE_REGRESSION|VIEWING_BEFORE_VACANCY|APPLY_WITHOUT_INTENT|POST_APPLY_VIEWING|TENSE_MISMATCH|FEEDBACK_PREMATURE|GOCHOUGO_|CONFIRM_|PHOTO_|JUSHU_|GUIDE_|SASETE_OVERUSE|APPLY_PUSH_NO_INTENT|UNSENT_CLAIM|SELF_HONORIFIC|ECHO_CONFIRM|LIST_STRUCTURE|DOUBLE_KEIGO|FABRICATED_POLICY_DET|FAREWELL_ON_MOVEOUT_INFO|DISCLOSURE_ASSERTION|VACANCY_ASSERTION|MOVEIN_DATE_ASSERTION|SCREENING_ASSURANCE|OPENING_GREETING_|OPENER_MISMATCH|PREEMPTIVE_HEDGE|FABRICATED_SEARCH_REPORT|CONDITION_RELAX_UNASKED|HEDGE_WITHOUT_SEARCH_DECL|SELF_HEDGE_ECHO|CLOSER_MISSING|COMMIT_AFTER_DELIVERABLE|NANISOTSU_MISPLACED|PASSIVE_CLOSER|RESULT_EXCUSE|CONDITION_ECHO_MISSING|SCHEDULE_ASSERT_UNCONFIRMED|FACT_DEFERRED_ANSWER|WIDEN_EXCUSE_REDUNDANT|REASSURANCE_NO_BASIS|URGENCY_NO_INTENT|CONSIDER_PUSH|HUMBLE_WAIT|DONE_PRESUPPOSED_WITHOUT_EVIDENCE|PROMISE_ECHO_MISMATCH|UNPROMPTED_PROPOSAL|CELL_AVOID_CONFLICT|ECHO_FROM_BRAIN_NOT_CUSTOMER|CLOSING_FORWARD_PUSH|TYPO_)/;
                const postDetCtx = {
                  recentMessages, lastCustomerMessage: message, isAutoSend: enforceReplyModeGate,
                  isEarlyConversation: isFirstEverReplyFromMsgs, tpoLabel: tpoNoteForLLM ?? undefined,
                  phaseKey: phaseGuideKey, customerName: customerName || undefined,
                  allowNames: allowNamesForCheck.length ? allowNamesForCheck : undefined,
                  nameAliases: addressName.aliases,                                // 2026-09-11 竹内方針3
                  sentPropertiesCount: estimateVerdict.sentPropertiesCount,
                  estimateContext: estimateVerdict,
                  moveOutSubject,                                                  // G10
                  confirmationContext: confirmCtxFinal, activeTaskTypes,           // G26
                  aixVacancyDone: !!(aixDone?.vacancyCheck || aixDone?.mgmtCheck), // G6（validateAndClean と同値）
                  greetingKind: greetingDecision.kind, expectedOpening: greetingDecision.openingLine, greetingDecision: toGreetingLite(greetingDecision), // G30/G31
                  substance, pairContext,                                          // 2026-09-09 REPLY_SKELETON（四者同名）
                  hedge, closerVerdict,                                            // 2026-09-09 みく事例: ヘッジゲート・締めポリシー（四者同名）
                  brainStrategy: brainLocalFresh ? brainStrategy : null, cellConflicts, // 2026-09-10 みく事例: 会話スコープ方針・セル衝突
                  ledger: ledgerForCtx ?? undefined, isDeliverableReply: isAixPropertySendMode, ledgerStrict: ledgerActive, // 2026-09-09 行動台帳
                  ngProperties: brainFreshForMessage
                    ? (brainMeta?.property_search_params?.ng_properties ?? []).filter((p) => p?.property_name).map((p) => `${p.property_name}${p.room_no ? ` ${p.room_no}` : ""}`)
                    : undefined,
                };
                const postDet = runDeterministicChecks(draftBody, postDetCtx);
                finalCheck.issues = [...finalCheck.issues.filter((i) => !DET_CODES_RE.test(i.code)), ...postDet];
                finalCheck.ok = !finalCheck.issues.some((i) => i.severity === "block");
              } catch (postErr) {
                console.warn("[generate-reply] 後処理後の決定論再検査に失敗（元の結果を維持）:", postErr);
              }
            }
            // 2026-09-11 統合設計（経路F・安全弁）: 後処理ゲートとセル必須要素の衝突で取り消した記録を finalCheck.issues に残す（warning・診断）
            if (!isTemplateOptimize && finalCheck && postprocessLog.length) {
              for (const p of postprocessLog) {
                finalCheck.issues.push({
                  pass: "meta", severity: "warning", code: "GATE_PAIR_CONFLICT",
                  message: `後処理のピックアップ再宣言ゲートが往復文脈の必須要素を削除し骨格系 block（${p.introduced.join("・")}）を作ったため、ゲートを取り消しました（生成${p.gen}回目）`,
                  evidence: p.reverted[0] ?? "",
                  suggestion: "対応不要（診断）。頻発する場合は resolvePickupGate の解除条件と aix_usage_logs の送付記録を確認する",
                });
              }
            }
            // f-8: センシティブ検知時は警告メタを冒頭に付与（空生成時は付与しない・テンプレ最適化は sensitiveGateNote="" ）
            finalDraftText = draftBody && sensitiveGateNote ? sensitiveGateNote + draftBody : draftBody;
            // 送信時の再利用判定キー: スタッフのテキストエリアに入る最終形（trim後）のハッシュに更新する
            // （自動修正・センシティブ警告付与でチェック時テキストと変わるため必ず上書き）
            if (finalCheck) finalCheck.checked_text_hash = await sha1(finalDraftText.trim());
            // 2026-09-11 統合設計（経路G・T4）: check-reply が「同じテキスト×同じ顧客文」なら生成時の3パス結果を再利用する判定キー
            if (finalCheck) finalCheck.context_hash = await sha1((message ?? "").trim());
            // 2026-09-09 Fable5: tpo_debug をトレーラーと ai_draft_check の両方に載せる（page.tsx が save-reply-example へ転送し reply_context_snapshot に保存）
            //   TPO誤発動率・往復ペア・final-check 結果の定量化用。JSONB のため migrate-schema 更新不要
            const tpoDebug: Record<string, unknown> | null = finalCheck && !isTemplateOptimize ? {
              tpo_label: tpoNoteForLLM ?? null,
              tier: tierResult.tier,
              phaseGuideKey, rawState: resolvedState.raw, stateKnown: resolvedState.known,
              rawAction, effectiveAction, isCachedMeta,
              isConditionPresented, isNegativeContext, isThinkingMsg, isTemporaryLeaveMsg, isGratitudeReplyTPO, isPostStrongRecommendation,
              conditionReason: conditionDetail.reason,
              isConditionChangeRequest,
              negativeKind: negativeDetail.kind,
              isViewingCancel,
              moveOutSubject,
              confirmCtx: { allowed: confirmCtxFinal.allowed, source: confirmCtxFinal.source, object: confirmCtxFinal.object },
              greeting: toGreetingLite(greetingDecision), // G32: kind/opener/audit（waitedMs・起点・customerKind）を保存（check-reply が復元・週次 SQL で冒頭差分を集計）
              // 2026-09-11 竹内方針3: 呼び名の決定根拠（JSONB のため migrate-schema 更新不要）
              address_name: { name: addressName.name, source: addressName.source, evidence: addressName.evidence.slice(0, 40), aliases: addressName.aliases.slice(0, 6) },
              // 往復文脈（Turn-Pair）＋実質判定（Substance）
              substance: { has: substance.has, kinds: substance.kinds, concerns: substance.concerns.map((c) => c.key), isAckOnly: substance.isAckOnly, residue: substance.residue.slice(0, 120), evidence: substance.evidence, isPureBoilerplate: substance.isPureBoilerplate, waitSignal: substance.waitSignal },
              turnPair: { staff: lastStaffTurn.kind, staffSource: lastStaffTurn.source, staffEvidence: lastStaffTurn.evidence.slice(0, 60), customer: pairContext.customer.kind, customerSecondary: pairContext.customer.secondary, customerObject: pairContext.customer.object, customerSource: pairContext.customer.source, ruleId: pairContext.ruleId, precedence: pairContext.rule?.precedence ?? null, cellGuard: pairContext.cellGuard,
                // 2026-09-11 統合設計: 締め verdict・質問の形（生成・検査・修正プロンプトと同じ値）
                closing: pairContext.closing, questionForm: pairContext.customer.questionForm ?? null },
              // 2026-09-11 統合設計（経路F）: 後処理の監査（ゲートの削除・置換・取り消し・aixDone の整合結果）。JSONB のため migrate-schema 更新不要
              postprocess: {
                validateIssues: lastValidateIssues.slice(0, 12),
                gateEdits: lastGateEdits.map((e) => ({ rule: e.rule, before: e.before.trim().slice(0, 60), after: e.after, reversible: e.reversible })),
                aixDone: aixDone ? { propertySend: aixDone.propertySend, vacancyCheck: aixDone.vacancyCheck, mgmtCheck: aixDone.mgmtCheck, pickupGateReason: aixDone.pickupGateReason ?? null } : null,
                reverted: postprocessLog.length ? postprocessLog : null,
              },
              // 2026-09-10 Fable5 みく事例: セル×brain方針の衝突・会話スコープ方針・修正前の指摘コード
              cellConflicts,
              brainStrategy: brainStrategy ? { engagement_stance: brainStrategy.engagement_stance, repeated_concern: brainStrategy.repeated_concern, avoid_topics: brainStrategy.avoid_topics } : null,
              // 2026-09-10 Fable5 Sさん事例: 前向き反応の下位種別・資料送付の往復・顧客が指名した物件・方針の出所
              brainStrategySource,
              positive: pairContext.customer.positive,
              materials: pairContext.materials,
              namedProperty: pairContext.namedProperty,
              preRevisionCodes: finalCheck.pre_revision_issues ?? [],
              unanchoredConditionEchoes: finalDraftText
                ? findUnanchoredConditionEchoes(
                    finalDraftText,
                    [message ?? "", ...recentMessages.filter((m) => m.sender === "customer").map((m) => m.text)].join("\n"),
                    `${customerConditions}\n${groundTruth.customerConditionsDb ?? ""}`,
                  )
                : [],
              // 2026-09-09 Fable5 みく事例: ヘッジゲート・締め・姿勢フラグ（save-reply-example が stance_sent_lite をマージし、下書き→送信の遷移行列 SQL に使う）
              hedge: { allowance: hedge.allowance, searched: hedge.searched, customerAsked: hedge.customerAsked.yes, customerSelfHedge: hedge.customerSelfHedge.yes, customerStatedRelax: hedge.customerStatedRelax.yes },
              closer: { kind: closerVerdict.closer, nanisotsu: closerVerdict.nanisotsu, reason: closerVerdict.reason },
              // 2026-09-09 Fable5 行動台帳（JSONB → page.tsx → save-reply-example → reply_context_snapshot に自動転送。週次 SQL で regex vs ledger 差分・再度誤用を集計）
              ledger: {
                summary: ledger.summary, mode: ACTION_LEDGER_MODE,
                facts: { propertiesSentCount: ledger.facts.propertiesSentCount, propertiesSentNames: ledger.facts.propertiesSentNames.slice(0, 6), estimateSent: ledger.facts.estimateSent, pickupPromisedUnfulfilled: ledger.facts.pickupPromisedUnfulfilled, pickupPromisedAt: ledger.facts.pickupPromisedAt, confirmationPromisedUnfulfilled: ledger.facts.confirmationPromisedUnfulfilled, propertiesSentSinceCustomerLatest: ledger.facts.propertiesSentSinceCustomerLatest, redoAllowed: ledger.facts.redoAllowed, lastStaffEntry: ledger.facts.lastStaffEntry ? { kind: ledger.facts.lastStaffEntry.kind, status: ledger.facts.lastStaffEntry.status, source: ledger.facts.lastStaffEntry.source } : null },
                entries: ledger.entries.slice(-6).map((e) => ({ kind: e.kind, status: e.status, at: e.at, source: e.source, confidence: e.confidence, react: e.customerReactionAfter ?? null })),
                regexSentCount,
              },
              stance_draft: finalDraftText ? computeStanceFlags(finalDraftText, pairContext, hedge, { customerName: customerName ?? "", customerText: message ?? "", isFirstContact: isFirstEverReplyFromMsgs }) : null,
              effectiveReplyDirection: (effectiveReplyDirection ?? "").slice(0, 300),
              brainReplyDirection: brainMeta?.reply_direction ?? null,
              brainClosingStrategy: (brainMeta?.closing_strategy ?? "").slice(0, 200) || null,
              brainCustomerQuestions: brainMeta?.customer_questions ?? [],
              lastStaffMsgHead: (lastStaffMsgForSearch ?? "").slice(0, 80),
              finalCheckCodes: finalCheck.issues.map((i) => `${i.code}:${i.severity}`),
              revisionOutcome: finalCheck.revision_exhausted ? "exhausted" : finalCheck.ok ? "ok" : "warn",
              draftHead: (finalDraftText ?? "").trim().slice(0, 200),
            } : null;
            if (finalCheck && tpoDebug) finalCheck.tpo_debug = tpoDebug;
            if (finalDraftText) controller.enqueue(encoder.encode(finalDraftText));
            // FINAL_CHECK トレーラー（メタ行1行目は出力済みのためトレーラーが唯一の伝達手段。
            // クライアントは SUGGESTED_AIX と同様に内部タグとして除去・解析する。STOP_REASON は必ず最後）
            if (!isTemplateOptimize && finalCheck) {
              controller.enqueue(encoder.encode(`\n<<<FINAL_CHECK:${JSON.stringify(finalCheck)}>>>`));
            }
            // ─── Shadow: 分類器ログ（シャドーモード・画面変更なし）───
            // 純ルールベース分類器の結果を reply_mode_shadow_logs に追記するだけ（上書きなし・1行1メッセージ）。
            // 返信内容・SUGGESTED_AIX・レスポンスには一切影響しない（fire-and-forget）。
            // ※テンプレート最適化モードは会話への返信生成ではないためログを残さない（書き込みゲート）
            if (conversationId && message && !isTemplateOptimize) {
              const _shadowClassify = (() => {
                try {
                  // history のスタッフ行プレフィックスは「スモラ:」（route内の履歴フォーマット準拠）
                  const recentStaffMsg = (history || "").split("\n").filter((l: string) => l.startsWith("スモラ:")).slice(-1)[0] || "";
                  const result = classifyReplyMode({
                    customerMessage: message,
                    conversationStatus: currentState || "",
                    recentStaffMessage: recentStaffMsg,
                    recentHistory: history || "",
                  });
                  return supabase
                    .from("reply_mode_shadow_logs")
                    .insert({
                      conversation_id: conversationId,
                      customer_message_preview: message.slice(0, 100),
                      predicted_mode: result.mode,
                      suggested_action: result.suggestedAction,
                      matched_rule: result.matchedRule,
                      confidence: result.confidence,
                      short_draft: result.shortDraft ?? null,
                      decided_at: new Date().toISOString(),
                    })
                    .then(() => {}, () => {}); // fire-and-forget（成功・失敗とも握りつぶす）
                } catch {
                  return Promise.resolve();
                }
              })();
              void _shadowClassify;
            }
            // テンプレート最適化モードはトレーラーを一切付けない（ボディ＝純粋な最適化テキスト）
            if (!isTemplateOptimize) {
              // AIX-META一元化: brain(suggested_aix_meta) が既に action を確定している。
              // 優先度1(抜け穴対策): AIX境界blockが修正不能だった場合のみ final-check 由来の
              // required 提案で override。hint は brain 無提案時のフォールバック。
              // ※ first_reply（初回対応）はAIX誘導不要（初回挨拶が主目的・旧 deriveSuggestedAix の例外を踏襲）
              // ※ AIX_ACTION_NOTES に無い action は語彙外（brain の新語彙等）→ hint フォールバックへ落とす
              // 2026-09-12 竹内方針A: トレーラーは resolveReplyAix（生成後）の出力そのもの。check_pattern・timing・bridge も載せる
              //   ※ 初回返信・下書きを作らない段階は resolveReplyAix が null を返す（旧 first_reply 例外と同じ）
              const suggestedAix = replyAixPost
                ? toSuggestedAixPayload(replyAixPost, { closing_strategy: brainMeta?.closing_strategy ?? null })
                : null;
              if (suggestedAix) {
                controller.enqueue(encoder.encode(`\n<<<SUGGESTED_AIX:${JSON.stringify(suggestedAix)}>>>`));
                // fire-and-forget — closing_strategyが生成されたらログに保存
                if (suggestedAix.closing_strategy && conversationId) {
                  supabase.from("closing_strategy_logs").insert({
                    conversation_id: conversationId,
                    closing_strategy: suggestedAix.closing_strategy,
                    conversation_status: currentState ?? null,
                    source: suggestedAix.source ?? "derive",
                  }).then(() => {}, () => {});
                }
              }
            }
            // includeStopReason=true（generate-pending-drafts）の場合のみ stop_reason トレーラーを付加
            // → 呼び出し元が max_tokens 尻切れを検知して保存をスキップできるようにする
            // ⚠️ 必ず【最後】のトレーラーとして出力する（SUGGESTED_AIX より後）。
            //    以前 STOP_REASON→SUGGESTED_AIX の順で出力していたため、呼び出し元の末尾アンカー抽出が失敗し
            //    タグ入りドラフトが ai_draft に保存されるバグが発生した（2026-07 修正済み）
            if (includeStopReason && !isTemplateOptimize) {
              controller.enqueue(encoder.encode(`\n<<<STOP_REASON:${String(genStopReason ?? "unknown")}>>>`));
            }
            // ✅ 成功時: ai_draft 保存 + draft_pending_at クリア（次のCronでスキップさせる）+ draft_attempted_at クリア（orphanedクエリで拾われないように）
            // ※ draft_updated_at カラムは conversations に存在しないため未使用（追加時はここで更新すること）
            // ※テンプレート最適化モードは conversationId を読み取り専用（summaryJson・引用コンテキスト等）にのみ使用し、
            //   会話の ai_draft を絶対に上書きしない（書き込みゲート）
            if (conversationId && !isTemplateOptimize) {
              // M-3: max_tokens で切れた場合は ai_draft に保存しない（尻切れ文をスタッフがそのまま送信する事故を防止）
              // pending 解除のみ行う（attempted_at は残す＝10分間リトライしない）
              const isTruncated = String(genStopReason ?? "") === "max_tokens";
              if (isTruncated) console.warn("[generate-reply] max_tokens stop: ai_draft保存スキップ", conversationId);
              // ─── 優先度1(抜け穴対策): AIX境界blockが修正不能 → ai_draft をnullクリアしてAIX切替 ───
              // 壊れたドラフト（AIX境界を越えた内容）をスタッフの送信テキストボックスに置かない。
              // 代わりに conversation_direction.suggested_aix_button を強制セットしてAIX側で対応させる。
              // draft_attempted_at は残す＝10分間は同じ境界違反ドラフトを再生成しない。
              if (aixBoundaryRequired) {
                console.warn(
                  "[generate-reply] AIX境界block解消不能 → ai_draftクリア+AIX切替:",
                  conversationId, aixBoundaryRequired.code, "→", aixBoundaryRequired.action
                );
                // 2026-09-12 竹内方針A: どこからも読まれていなかった conversation_direction.suggested_aix_button への書き込みをやめ、
                //   ai_draft="[AIX誘導中]"（P5.1 の誘導が出る）＋ ai_draft_check.suggested_aix（画面のAIXボタン）を保存する。
                //   bg-async は ai_draft IS NULL の時だけ保存するので、このセンチネルを上書きしない
                const { error: gateErr } = await supabase
                  .from("conversations")
                  .update({
                    ai_draft: "[AIX誘導中]",
                    draft_pending_at: null,
                    ai_draft_check: {
                      ...(finalCheck ?? {}),
                      tpo_debug: finalCheck?.tpo_debug ?? null,
                      suggested_aix: replyAixPost ? toSuggestedAixPayload(replyAixPost) : null,
                    },
                  })
                  .eq("id", conversationId);
                if (gateErr) console.error("[generate-reply] AIX切替 ai_draft保存失敗:", conversationId, gateErr.message);
              } else {
              const { error: saveErr } = await supabase
                .from("conversations")
                .update(
                  !isTruncated && finalDraftText.trim()
                    ? { ai_draft: finalDraftText.trim(), draft_pending_at: null, draft_attempted_at: null }
                    : { draft_pending_at: null } // 空生成・尻切れでも pending は解除（永続pending防止）。attempted_at は残す＝10分間リトライしない
                )
                .eq("id", conversationId);
              if (saveErr) console.error("[generate-reply] ai_draft save error:", conversationId, saveErr.message);
              } // ← aixBoundaryRequired else 終端
              // ai_draft_check は別UPDATEで保存（fail-open: カラム未追加環境でも ai_draft 保存を巻き込まない。
              // 監査ログ兼、事前生成ドラフト選択時のクライアント側ハッシュ照合用。
              // AIX切替時（aixBoundaryRequired）は ai_draft が無いためハッシュ照合対象も無く保存しない）
              if (finalCheck && !isTruncated && !aixBoundaryRequired && finalDraftText.trim()) {
                void supabase
                  .from("conversations")
                  // tpo_debug: TPO誤発動率の定量化用（2026-09-08）。JSONBのため migrate-schema 更新不要
                  // 2026-09-09 Fable5: 中身はトレーラー送出前に組み立てた tpoDebug（substance / turnPair / finalCheckCodes / draftHead 等）と同一
                  // 2026-09-12 竹内方針A: suggested_aix（resolveReplyAix の出力）を同梱 → 自動経路・手動経路とも画面で同じ AIX ボタンを出す（JSONB・migrate-schema 更新不要）
                  .update({ ai_draft_check: { ...finalCheck, tpo_debug: finalCheck.tpo_debug ?? null, suggested_aix: replyAixPost ? toSuggestedAixPayload(replyAixPost) : null } })
                  .eq("id", conversationId)
                  .then(({ error: chkErr }) => {
                    if (chkErr) console.warn("[generate-reply] ai_draft_check save error:", conversationId, chkErr.message);
                  });
              }
            }
          } catch (streamErr) {
            console.error("generate-reply stream error:", streamErr);
            // フォールバックテキストを返す（無言クローズだとフロントが空ドラフト表示になるため）
            try {
              // 2026-09-11 データ衛生: 文言の出所は example-hygiene の定数1か所（送信停止・保存停止・学習除外が同じ定数で判定する）
              controller.enqueue(encoder.encode(GENERATION_FAILURE_TEXT));
            } catch { /* controller already closed */ }
            // ストリームを先に閉じてクライアントの generating=true を即解放する
            // Supabaseのクリーンアップは fire-and-forget でバックグラウンド実行
            try { controller.close(); } catch { /* already closed */ }
            if (conversationId && !isTemplateOptimize) {
              void supabase
                .from("conversations")
                .update({ draft_pending_at: null })
                .eq("id", conversationId)
                .then(({ error: clearErr }) => {
                  if (clearErr) console.error("[generate-reply] draft_pending_at clear error:", conversationId, clearErr.message);
                });
            }
            return;
          }
          controller.close();
        },
      }),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "返信生成エラー";
    console.error("generate-reply error:", msg);
    // ❌ 失敗時: draft_pending_at をクリアして永続pendingを防止（毎分Cronの無限再試行対策）
    // ※ draft_attempted_at は意図的に触らない（残す＝10分間はorphanedクエリでリトライされない）
    // ※ draft_error_at カラムは conversations に存在しないためエラー時刻は記録しない（追加時はここで記録すること）
    if (conversationId && !isTemplateOptimize) {
      try {
        await supabase.from("conversations").update({ draft_pending_at: null }).eq("id", conversationId);
      } catch (clearErr) {
        console.error("[generate-reply] draft_pending_at clear error:", conversationId, clearErr);
      }
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
