// ─── 最終チェック（前頭前野モデル）───────────────────────────────────────────
// AI生成LINE返信の送信前3重チェック。人間の脳の誤り検出機構をモデルにした3パス並列検査:
//   Pass1 前頭前野（rule_check）  : 会社ルール・AIX境界線との照合
//   Pass2 前帯状回（anomaly_scan）: 事実の出所検証（ハルシネーション検出）
//   Pass3 バグ探し思考（context_check）: 質問取りこぼし・段階ミスマッチ・二重宣言
//
// 設計原則（メタ認知ガード）:
// - LLM（Haiku）は「見つける」だけ。severity判定はコード側の決定的マップが行う
// - evidence（本文からの引用）が無い指摘は破棄する
// - block判定は evidence が本文に実在する場合のみ（誤ブロックはwarningに降格）
// - タイムアウト・API失敗は fail-open（passes_completed に記録して送信は止めない）
//
// 呼び出し元:
// - generate-reply/route.ts …… runFinalCheckWithRevision（チェック+接地修正ループ。最大2チェック）
// - check-reply/route.ts    …… 送信時の再チェック用ルート。2026-09-11 以降、画面からは呼ばない
//                              （スタッフが編集した文はスタッフの判断が正解。チェックはAI生成時のみ＝ハルシネーション防止）

import { checkNameConsistency, ASSERTION_BAN_RULES, findAssertionMatch, PLACEHOLDER_ADDRESS_DET_RE, PLACEHOLDER_NAME_CORE_RE, applySurfaceFixes } from "./validate-reply";
// 2026-09-11 竹内方針1・5: 誤字（warning のみ）・「すぐに」の唯一の定義（後処理と検査が同じ正規表現）
import { detectTypos } from "./typo-check";
import { HASTY_ADVERB_TEST_RE, findUnanchoredUketamawari } from "./banned-phrasing";
// 2026-09-12 竹内方針D: 日本時間の日付・曜日は jst-date の関数だけで計算する
import { jstParts, WEEKDAYS_JA } from "./jst-date";
// 2026-09-08 Fable5 G10/G26/G30: 主語判定・確認約束 verdict・冒頭挨拶（generate-reply / brain-core と四者同名）
import { moveOutEvidenceText, isMoveOutReleased, moveOutRoomMismatch, type MoveOutSubject } from "./move-out-context";
import { resolveConfirmationContext, stripUnbackedConfirmPromise, CONFIRM_PROMISE_SENTENCE_RE, CONFIRM_NEXT_RE as SHARED_CONFIRM_NEXT_RE, SEARCH_CONFIRM_RE, type ConfirmationContextVerdict } from "./confirmation-context";
import { NIGHT_PREFIX, detectOpener, OPENER_JA, normalizeGreetingLite, type GreetingKind, type GreetingDecisionLite } from "./greeting";
import {
  PHASE_PROHIBITIONS,
  FORM_LABEL_RE,
  ESTIMATE_WORD_RE,
  CUSTOMER_ESTIMATE_INTENT_RE,
  CUSTOMER_PROPERTY_REF_RE,
  CUSTOMER_PROPERTY_POSITIVE_RE,
  STAFF_ESTIMATE_PROMISE_RE,
} from "./line-reply-prompts";
// 2026-09-08 Fable5: 見積書の文脈判定 verdict（generate-reply の isMisumoriContextAppropriate() と同一オブジェクト）
import type { EstimateContextVerdict } from "./estimate-context";
// 2026-09-09 Fable5 往復文脈（Turn-Pair）＋実質判定（Substance）: generate-reply と同一オブジェクト（省略時は ctx から再計算）
import {
  analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse, resolveTurnPair, STAFF_KIND_JA, CUSTOMER_KIND_JA, type SubstanceVerdict, type PairContext,
  // 2026-09-09 Fable5 みく事例: ヘッジゲート・締めポリシー・姿勢ギャップ（生成側 route.ts / buildStanceNote と同一関数）
  resolveHedgeAllowance, resolveCloser, deriveCloserSignals, extractEchoTokens, evalConditionEcho, resolveCustomerDocScope, isEchoableScope, classifyScheduleCommitment, resolveAnswerability, detectExcusePhrases,
  CLOSER_TEXT, PRE_PICKUP_HEDGE_RE, SEARCH_REPORT_RE, RELAX_PROPOSAL_RE, PAST_REPORT_RE, SEARCH_DECL_RE, SELF_HEDGE_ECHO_RE, CUST_STATED_RELAX_RE,
  STAFF_ASSERT_SCHEDULE_RE, SCHEDULE_ASK_RE, DEFERRED_ANSWER_RE, NANISOTSU_RE, OPEN_DOOR_RE, WAIT_SOFTLY_RE, RESULT_EXCUSE_RE, DELIVERABLE_RE, redoWord,
  // 2026-09-12 竹内方針B: 顧客の連絡予告（締め resolveCloser と同じ verdict）
  AWAIT_CONTACT_PHRASE_RE, resolveAwaitContact,
  // 2026-09-10 Fable5 あみ事例: 顧客アンカー語彙・持込予告（生成側 buildVocabAnchorNote / PAIR_MATRIX と同一定数）
  fillPairPlaceholders, CUSTOMER_ANCHORED_VOCAB, checkGoyukkuriMirror, CUST_WILL_SEND_SELF_PRED, classifyWillSendObject,
  // 2026-09-10 Fable5 Sさん事例: 前向き反応 → 内覧のご案内提案（[Y]型）と AIX 専用の候補日時確認（[X]型）の分離
  VIEWING_OFFER_SOFT_RE, VIEWING_DATE_ASK_RE, viewingOfferLiteral,
  type HedgeVerdict, type CloserVerdict, type ExcuseFlag,
  // 2026-09-10 Fable5 みく事例: 会話スコープ方針・セル衝突（生成側と同一オブジェクト）
  type BrainConversationScope, type CellConflict,
  // 2026-09-11 統合設計（返信生成×最終チェックの衝突解消）: 回答検出・必須要素判定・免除・例文選択・顧客名スロットの単一真実源
  hasDirectAnswer, PROPOSAL_FORM_RE, mustIncludeSatisfied, isCellRequiredSentence, selectPairExample, fillPairTokens, fillNameSlot, CONFIRM_DECL_WITH_OBJECT_RE,
  type PairMustInclude,
} from "./reply-context";
// 2026-09-09 Fable5 行動台帳: generate-reply と同一オブジェクト（省略時は recentMessages から再計算）。実行前提語ゲート・自動修正は action-ledger の同じ関数
import { buildActionLedger, checkDonePresupposition, applyLedgerAutoFix, COMPLETED_SEND_RE, ATTACHED_DELIVERABLE_RE, type ActionLedger } from "./action-ledger";
// 2026-09-09 Fable5: check-reply 経路（isConditionPresented フラグ無し）でも条件フォームを condition_change に分類する（route.ts conditionDetail reason:'form' と同定義）
import { isConditionFormMessage } from "./line-reply-prompts";

export type CheckPass = "rule_check" | "anomaly_scan" | "context_check" | "meta";
export type CheckSeverity = "block" | "warning" | "info";

export interface CheckIssue {
  pass: CheckPass;
  severity: CheckSeverity;
  code: string;        // "AIX_BOUNDARY_VIEWING" | "FABRICATED_AMOUNT" | "MISSED_QUESTION" | ...
  message: string;     // 日本語・スタッフ向け1文（何が問題か）
  evidence: string;    // 本文からの引用（必須。空なら code ごと破棄）
  suggestion: string;  // 具体的な修正案
}

export interface CheckResult {
  ok: boolean;                    // blockが0件
  issues: CheckIssue[];
  revised_text?: string;          // 自動修正後（generate-reply時のみ）
  passes_completed: CheckPass[];  // fail-open監査: タイムアウトしたpassはここに無い
  elapsed_ms: number;
  checked_text_hash: string;      // sha1(text.trim()) — 送信時の再利用判定キー
  // ── 修正ループ監査（v2追加。ai_draft_check は JSONB カラムなので migrate-schema 更新は不要）──
  revision_count?: number;        // 実行した接地修正の回数（0 or 1）。トレーラーで必ず送出
  revision_exhausted?: boolean;   // 修正を試みてもblockが残った/修正不能 → スタッフ手動確認必須
  // ── フィードバック再生成ループ監査（v3追加・generate-reply側で設定。JSONBのため migrate-schema 更新は不要）──
  regen_count?: number;           // 指摘フィードバック付き再生成の回数（0 or 1）
  // ── 2026-09-09 Fable5 往復文脈: generate-reply が substance / turnPair / finalCheckCodes 等を積む監査用（JSONB。page.tsx が save-reply-example に転送）──
  tpo_debug?: Record<string, unknown> | null;
  /** 2026-09-10 Fable5: 修正ループ実行前（check1）の指摘コード。
   *  最終 CheckResult は recheck で丸ごと置換されるため、revision_count>0 で issues が空になった時に
   *  「何を直したのか」を追える唯一の記録。みく事例は「誤った direction に合わせて1回書き換えて問題解消と表示した」が追跡不能だった */
  pre_revision_issues?: string[];
  // ── 2026-09-11 統合設計（経路G・観測）: JSONB のキー追加のみ（新カラムなし → migrate-schema 更新不要）──
  /** 完了しなかったパスと理由（reina の 183ms 全パス即時失敗のような原因を DB から特定するため） */
  pass_failures?: Array<{ pass: CheckPass; reason: "timeout" | "http" | "max_tokens" | "parse" | "other"; status?: number; ms: number }>;
  /** 完了したパスの所要時間 */
  pass_ms?: Partial<Record<CheckPass, number>>;
  /** 差分再検査が成功したか（runDiffRecheck）。採用判定はこれを見る（passes_completed は check1 から引き継いだ実値） */
  diff_verified?: boolean;
  /** 再生成（regen_count=1）時も1回目生成のチェック結果を残す（pre_revision_issues は loop2 で上書きされるため） */
  first_pass_issues?: string[];
  first_pass_draft_head?: string;
  /** sha1(顧客最新メッセージ)。check-reply が生成時の3パス結果を再利用する判定キー */
  context_hash?: string;
  /** check-reply が生成時の結果を再利用した */
  reused_from_generation?: boolean;
}

export interface FinalCheckContext {
  dbRules?: string;               // ai_prompt_rules の注入文字列（fetchPromptRules の戻り値）
  finalCheckRules?: string;      // action_type="final_check" のルール（全3パスに注入）
                                  // DBで日々改善されたチェック専用ルール。false positive防止・見逃し防止の両方に使う
  recentMessages?: Array<{ sender: string; text: string; isAix?: boolean; createdAt?: string }>;
  lastCustomerMessage?: string;   // 顧客の最新メッセージ
  brainContextJson?: string;      // generate-reply の brain(AIX-META=suggested_aix_meta) コンパクトサブセットJSON
                                  // （旧 step1Json — Step1廃止(2026-08)で brain 由来に差し替え。check-reply では省略可）
  staffSourceText?: string;       // スタッフ由来ソース（AIX原文・希望条件等）
  checkpointFacts?: string;      // conversation_checkpoints 最新summary — 確認済み事実（最高権威）
  customerConditionsDb?: string; // property_customers のDB保存顧客条件
  // v3 追加（Fable5 brain-vs-finalcheck監査 2026-08-14）
  isAutoSend?: boolean;          // HIGH-1/2: 自動送信経路のみ true → 未完走時fail-closed / MISSED_QUESTION昇格
  conversationStage?: string;    // MEDIUM-2: 現在の会話段階（例: "条件ヒアリング中"）
  tpoLabel?: string;             // TPO場面（例: "感謝返し" / "ネガ文脈" / "強推し直後の了承"）。
                                 // generate-reply の tpoNoteForLLM と同一値。context_check の過剰指摘抑制に使用
  checkpointStage?: string | null; // brain実態フェーズ（conversationStageと乖離時に優先）
  sentPropertiesCount?: number;  // MEDIUM-2: 送付済み物件数（0=未送付）。estimate-context.ts countSentProperties() 由来
  /** generate-reply の isMisumoriContextAppropriate() verdict（生成側と同一オブジェクト）。check-reply 経路では省略可（共有 RE でフォールバック） */
  estimateContext?: EstimateContextVerdict | null;
  isAix?: boolean;               // FP-02: AIX機能使用フラグ。false の場合 AIX_BOUNDARY_* コードを除外
  isEarlyConversation?: boolean; // FP-04: 会話初期（情報源が薄い）フラグ。FABRICATED系を warning に格下げ
  /** Brain（suggested_aix_meta）の判定結果。context_check のSTAGE_SKIP抑制に使用 */
  brainMeta?: {
    action: string | null;
    enforcement_level: "required" | "recommended";
  } | null;
  /** 1回目チェック後の照合で「根拠あり」と確認済みの evidence 文字列リスト。2回目チェックで再指摘しない */
  clearedFacts?: string[];
  /** brainMeta.property_search_params.ng_properties から派生したNG確定物件名リスト（"物件名 [号室]" 形式）。本文にこれらが含まれていたらblock */
  ngProperties?: string[];
  // ── S-5 / S-2 / A-8（2026-09-08 Fable5）──
  /** 確定顧客名（normalizeCustomerName 済み or 生値）。checkNameConsistency の基準名 */
  customerName?: string;
  /** 顧客自身が書いた第三者名（連名者・保証人等）。NAME_MISMATCH から除外する */
  allowNames?: string[];
  /** 2026-09-11 竹内方針3: resolveAddressName の aliases（スタッフが過去に呼んだ名前・顧客の名乗り・DB名のトークン）。
   *  呼びかけ位置でも NAME_MISMATCH にしない（後処理 unifyAddressAliases が確定名に統一する） */
  nameAliases?: string[];
  /** 基準時刻（ms）。曜日の誤字判定・TIME_INVALID_HONIJITSU に使う（常設の回帰スクリプトは送信時刻を渡す。既定 Date.now()） */
  now?: number;
  /** generate-reply の resolveState().guideKey（first_reply/hearing/proposing/viewing/applying/closed_won/closed_lost）。STATE_REGRESSION 判定に使用 */
  phaseKey?: string;
  // ── G10 / G26 / G6 / G30（2026-09-08 Fable5）。route.ts は finalCheckCtx / detCtx / postDetCtx の3か所に同じ値を渡す ──
  /** G10: generate-reply classifyMoveOutSubject()（現住居の退去報告を離脱と誤読した会話終了返信を FAREWELL_ON_MOVEOUT_INFO で block） */
  moveOutSubject?: MoveOutSubject;
  /** G26: generate-reply の確認約束 verdict（同一オブジェクト）。check-reply 経路は省略可（ctx から再計算） */
  confirmationContext?: ConfirmationContextVerdict | null;
  activeTaskTypes?: string[];
  /** G6: AIX【物件確認した】(property_check_result) / mgmt_* 完了（route.ts aixDone.vacancyCheck || mgmtCheck）。VACANCY/MOVEIN を免除 */
  aixVacancyDone?: boolean;
  /** G30: resolveGreeting().kind / .opening（OPENING_GREETING_* の対称検査） */
  greetingKind?: GreetingKind;
  expectedOpening?: string;
  /** G31: 挨拶行＋開口語の二層決定（generate-reply は toGreetingLite、check-reply は tpo_debug.greeting 復元）。⑦ の対称検査の正 */
  greetingDecision?: GreetingDecisionLite;
  // ── 2026-09-09 Fable5 往復文脈（REPLY_SKELETON / CONCERN_UNADDRESSED / EMPTY_CLOSER / PAIR_ELEMENT_MISSING / SPLIT_ACK_REPLY）──
  /** 顧客最新メッセージの実質判定。route.ts が1回計算し finalCheckCtx/detCtx/postDetCtx に同一オブジェクトを渡す。check-reply 経路は省略可（再計算） */
  substance?: SubstanceVerdict;
  /** 直前スタッフ発話 × 顧客返答の往復ペア。省略時は recentMessages から再計算 */
  pairContext?: PairContext;
  // ── 2026-09-09 Fable5 みく事例: ヘッジゲート・締めポリシー（route.ts resolveHedgeAllowance / resolveCloser と同一オブジェクト。check-reply 経路は省略可＝再計算）──
  hedge?: HedgeVerdict;
  closerVerdict?: CloserVerdict;
  // ── 2026-09-09 Fable5 行動台帳（Action Ledger）──
  /** route.ts buildActionLedger と同一オブジェクト。check-reply 旧経路は省略可＝recentMessages から再計算（aix_usage_logs 無し・保守的） */
  ledger?: ActionLedger;
  /** 生成中の返信自体が AIX 成果物（物件送付文・見積送付文）＝「こちらの物件」「お送りした」は添付物を指すので免除 */
  isDeliverableReply?: boolean;
  /** true=DONE_PRESUPPOSED_WITHOUT_EVIDENCE / UNSENT_CLAIM を block（generate-reply inject/enforce）。false/省略=warning（check-reply のスタッフ編集文） */
  ledgerStrict?: boolean;
  // ── 2026-09-10 Fable5 みく事例（UNPROMPTED_PROPOSAL / CELL_AVOID_CONFLICT）──
  /** brain の会話スコープ方針（engagement_stance / avoid_topics）。
   *  検査は「今回のメッセージが何か」の判定にはこれを使わない。UNPROMPTED_PROPOSAL の severity と
   *  CELL_AVOID_CONFLICT の警告にのみ使う。check-reply 経路は省略可（severity が warning に落ちるだけ） */
  brainStrategy?: BrainConversationScope | null;
  /** route.ts detectCellConflicts の結果（同一オブジェクト） */
  cellConflicts?: CellConflict[];
  /** 2026-09-11 統合設計（経路F1）: 後処理ゲートの判断（resolvePickupGate 整合後の aixDone）。生成ノート・後処理・検査が同じ値を見る（監査・tpo_debug 用） */
  aixDone?: { propertySend: boolean; vacancyCheck: boolean; mgmtCheck: boolean; pickupGateReason?: string } | null;
}

// ─── SHA-1（送信時のハッシュ一致判定用。Web Crypto はNode18+/ブラウザ両対応）──
export async function sha1(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── 確証バイアス対策の共通前文（「良いか確認して」は絶対に使わない）──────────
const ADVERSARIAL_PREAMBLE = `返信文を以下の観点で確認してください。
明確な根拠（本文からの引用）がある問題のみ指摘してください。
確信が持てない場合・問題がない場合は issues を空配列にしてください。`;

// ─── 構造化出力スキーマ（全pass共通・保証付きJSON）────────────────────────────
const ISSUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["issues"],
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "message", "evidence", "suggestion"],
        properties: {
          code: { type: "string" },
          message: { type: "string" },
          evidence: { type: "string" },
          suggestion: { type: "string" },
        },
      },
    },
  },
} as const;

type RawIssue = { code?: string; message?: string; evidence?: string; suggestion?: string };

// ─── プロンプトキャッシュ用コンテンツブロック（2026-08）─────────────────────────
// Anthropicのプレフィックスキャッシュは「安定部が先頭・動的部が後ろ」の順序が必須。
// 各パスの安定ブロック（チェック基準・code一覧・出力例・DBルール = 全顧客共通）の末尾に
// cache_control を1個置き、動的ブロック（brain判定・draft・会話コンテキスト）を後続に配置する。
// 検証は response usage の cache_read_input_tokens で行う。
type PromptBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" } };
type PromptContent = string | PromptBlock[];

// ─── モデル定数 ─────────────────────────────────────────────────────────────
// rule_check・anomaly_scan・verify・recheck: 明確なルール照合・比較判定のみ → Haiku で十分・高速・低コスト
// context_check: 10種の複雑な会話理解（MISSED_QUESTION 等）→ 誤検知が revision 誤発火に直結するため Sonnet 維持
// runGroundedRevision: 実際に返信文を書き直す → 最高品質が必要なため Sonnet 維持
const MODEL_CHECK_FAST = "claude-haiku-4-5-20251001"; // rule_check / anomaly_scan / verify / recheck
const MODEL_CHECK_DEEP = "claude-sonnet-5";           // context_check（会話理解が複雑）
const MODEL_REVISION   = "claude-sonnet-5";           // 返信文の実際の書き直し

// ─── チェック呼び出し（raw fetch・Vision実装と同パターン・SDK依存なし）────────────
async function callSonnet(prompt: PromptContent, timeoutMs: number, maxTokens = 2400, model = MODEL_CHECK_DEEP): Promise<RawIssue[]> {
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").replace(/\s/g, "");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31" },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      thinking: { type: "disabled" },
      output_config: { format: { type: "json_schema", schema: ISSUE_SCHEMA } },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`final-check ${model} HTTP ${res.status}`);
  const data = await res.json() as { content?: Array<{ type: string; text?: string }>; stop_reason?: string };
  if (data.stop_reason === "max_tokens") throw new Error(`final-check ${model} max_tokens reached`);
  const text = data.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text ?? "";
  let parsed: { issues?: RawIssue[] };
  try {
    parsed = JSON.parse(text) as { issues?: RawIssue[] };
  } catch (e) {
    console.error(`[final-check] callSonnet(${model}) JSON.parse failed:`, e, "raw text:", text.slice(0, 200));
    throw new Error(`final-check ${model} JSON parse failed`);
  }
  return Array.isArray(parsed.issues) ? parsed.issues : [];
}

// ─── コンテキスト整形ヘルパー ───────────────────────────────────────────────
// isAix / createdAt を使って履歴の精度向上（DOUBLE_DECLARATION・AIX区別・時刻ベースの重複検出）
function jstTime(iso: string | undefined): string {
  if (!iso) return "";
  try {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const p = jstParts(t);
    return ` (${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} JST)`;
  } catch { return ""; }
}

function formatHistory(msgs: FinalCheckContext["recentMessages"], limit: number): string {
  if (!msgs || msgs.length === 0) return "（履歴なし）";
  return msgs
    .slice(-limit)
    .map((m) => {
      const label = m.sender === "customer" ? "お客様" : (m.isAix ? "スタッフ[AIX]" : "スタッフ");
      return `${label}${jstTime(m.createdAt)}: ${(m.text || "").slice(0, 600)}`;
    })
    .join("\n");
}

function formatStaffMessages(msgs: FinalCheckContext["recentMessages"], limit: number): string {
  if (!msgs || msgs.length === 0) return "（なし）";
  const staff = msgs.filter((m) => m.sender === "staff").slice(-limit);
  if (staff.length === 0) return "（なし）";
  return staff.map((m) => {
    const label = m.isAix ? "スタッフ[AIX]" : "スタッフ";
    return `${label}${jstTime(m.createdAt)}: ${(m.text || "").slice(0, 600)}`;
  }).join("\n");
}

function nowJstString(): string {
  const p = jstParts();
  return `${p.y}/${p.m}/${p.d}（${WEEKDAYS_JA[p.dow]}）${p.hour}:${String(p.minute).padStart(2, "0")} JST`;
}

// ─── Pass 1: 前頭前野（ルール照合 / rule_check）────────────────────────────────
// プロンプトキャッシュ: 安定部（チェック基準・code一覧・[RULES]・出力例 = 全顧客共通、
// dbRules/finalCheckRules は DB 編集時のみ変化）を先頭ブロック + cache_control、
// 動的部（brain判定・aixNote・draft）を後続ブロックに分離。
function buildRuleCheckPrompt(draft: string, ctx: FinalCheckContext): PromptBlock[] {
  // FP-02: AIX非使用時は AIX_BOUNDARY_* コードを除外する旨を注記
  const aixNote = ctx.isAix === false
    ? "\n【重要】この会話ではAIX機能は使用されていません。AIX_BOUNDARY_* コード（AIX_BOUNDARY_VIEWING, AIX_BOUNDARY_PROMISE 等）は一切発行しないでください。\n"
    : "";
  // FN-005: dbRules 20000字切り捨て警告（旧8000字上限を拡大。Sonnetのコンテキストウィンドウは十分大きい）
  if (ctx.dbRules && ctx.dbRules.length > 20000) {
    console.warn(`[final-check] dbRules truncated: ${ctx.dbRules.length} chars → 20000. Rules beyond 20000 chars are NOT checked.`);
  }
  const dbRulesSliced = (ctx.dbRules || "（DBルールなし — 上記の境界線・禁止語彙のみで照合）").slice(0, 20000);
  // FN-005: finalCheckRules 3000字切り捨て警告
  if (ctx.finalCheckRules && ctx.finalCheckRules.length > 3000) {
    console.warn(`[final-check] finalCheckRules truncated: ${ctx.finalCheckRules.length} chars → 3000. Rules beyond 3000 chars are NOT checked.`);
  }
  const finalCheckRulesSliced = ctx.finalCheckRules ? ctx.finalCheckRules.slice(0, 3000) : null;
  const brainBaselineNote = ctx.brainMeta?.action
    ? `【Brain判定済み】Brain（Sonnet）がaction="${ctx.brainMeta.action}"（enforcement="${ctx.brainMeta.enforcement_level}"）と判定済みです。この判断に沿った返信かどうかを確認すること。絶対ルール違反・禁止語彙・明らかなミスのみ指摘し、Brain判定と整合している内容にはフラグを立てないこと。\n\n`
    : "";
  const stable = `${ADVERSARIAL_PREAMBLE}

以下はこの会社の絶対ルール一覧です。返信文が各ルールに違反していないか、1つずつ照合してください。
特に「通常返信AIは宣言のみ、実行はAIX」の境界線：
- 内覧の具体的な候補日時（「8/7（木）14:00〜」等）を提示 → 違反
- 初期費用の金額・内訳を直接提示（「敷金○万円・礼金○万円・合計○万円」等）→ 違反 / AIX_BOUNDARY_ESTIMATE
  【例外】「御見積書を作成しお送りします」「最大限割引した御見積書をお送りします」等の作成宣言のみ（金額なし）はOK
  ただし顧客の費用質問・見積依頼・特定物件送付・送付済み物件への前向き反応のいずれも無い場合（①〜⑧条件フォームの「⑦初期費用」は項目ラベルであり質問ではない）は state を問わず TIMING_VOCAB_MISMATCH / ESTIMATE_NO_TRIGGER 対象（決定論で判定。LLM側は重複指摘不要）
- 住所・集合場所・集合時間の案内 → 違反
- 物件名・家賃・間取りの初出提示 → 違反 / 申込確定文・必要書類リスト → 違反
- 入居可能日・退去日の回答（希望時期を「聞く」のはOK、「答える」のはNG）→ 違反
- 「確認してご連絡します」の約束（AIX【確認します】と二重になる）→ 違反
禁止語彙：少々お待ちください / 申し訳ございません（審査落ち・物件消滅時）/ スモラ /
名称未設定 / markdown太字 / AIX操作用語（「AIXボタン」等）の顧客向け文への混入 /
冒頭の書き出しとして「ご連絡ありがとうございます」「ご返信ありがとうございます」（お礼は挨拶ではない。冒頭の単独使用は禁止。本文中での自然なお礼はOK。※「〇〇さんご連絡頂きありがとうございます」「ご連絡いただきありがとうございます」等の「頂き/いただき」入りの形は初回返信の必須標準挨拶のため対象外・指摘しない）/
「〇〇さんご希望のご条件に合った〜」等のお客様を主語にした受け身表現（「あなたの条件に合うもの」という受け身姿勢。検出時 code=RULE_VIOLATION で報告）。ただし「〇〇周辺からご条件に合ったお部屋をピックアップして」等、スタッフが能動的に探す行動宣言の一部として使用している場合は対象外

code は次から選ぶこと:
AIX_BOUNDARY_VIEWING（内覧日時の提示）/ AIX_BOUNDARY_ESTIMATE（見積送付文・金額内訳）/
AIX_BOUNDARY_MEETING（住所・集合場所案内）/ AIX_BOUNDARY_PROPERTY（物件名・家賃・間取りの初出提示）/
AIX_BOUNDARY_APPLICATION（申込確定文・書類リスト）/ AIX_BOUNDARY_MOVEIN（入居可能日・退去日の回答）/
AIX_BOUNDARY_PROMISE（「確認してご連絡します」の二重宣言）/
【例外】特定物件（物件名・URL・号室・「この物件」等で対象が特定できる場合）についての管理会社確認が必要な質問（空室状況・審査結果・入居可能日・設備詳細・ペット可否の管理会社判断等）に対する「確認してご連絡します」「管理会社に確認いたします」などは AIX_BOUNDARY_PROMISE に該当しません。ただし特定物件を指していない条件追加（「あと、ペット可能でお願いします」等）への確認宣言はこの例外の対象外（RULE_VIOLATION として指摘してよい。正しくはピックアップ宣言）。
【例外2】お客様が物件の画像・スクリーンショットを送ってきた文脈での「最大限割引させていただいた御見積書をお送りします（見積もり宣言）」と「〇〇周辺からご条件に合った物件をピックアップしてお送りします（ピックアップ宣言）」の組み合わせは AIX_BOUNDARY_PROMISE にも RULE_VIOLATION にも該当しません（物件スクショ受信時の複合宣言は許可）。
AIX_BOUNDARY_DB（[RULES]内の【線引き】マーク付きDBルールへの違反。返信文が制限事実を自ら回答している場合のみ。「確認してご連絡します」等の宣言のみの文は対象外）/
BANNED_WORD（禁止語彙）/ RULE_VIOLATION（その他ルール違反）/
NG_PROPERTY_MENTION（この顧客がNG確定済みの物件名を返信本文に含めている）

[RULES]
${dbRulesSliced}
[/RULES]
${finalCheckRulesSliced ? `[FINAL_CHECK_RULES]\n${finalCheckRulesSliced}\n[/FINAL_CHECK_RULES]` : ""}
【出力例1 - 問題なし】
かぁなさん、お世話になっております！！先ほどご質問いただいた物件ですが、管理会社に空室確認いたします。確認でき次第ご連絡いたしますね！
→ issues: []

【出力例2 - AIX_BOUNDARY_VIEWING 違反】
明日の14時に内見はいかがでしょうか。ご都合いかがですか？
→ issues: [{"code":"AIX_BOUNDARY_VIEWING","summary":"内見日時をAIXを使わずに直接提案している","evidence":"明日の14時に内見はいかがでしょうか","pass":"rule_check"}]

【出力例3 - 問題なし（管理会社確認の正当な返答）】
空室状況について管理会社に確認してご連絡いたします。
→ issues: []

【出力例4 - AIX_BOUNDARY_ESTIMATE 違反（金額内訳の直接提示）】
敷金2ヶ月分・礼金1ヶ月分・保証料家賃の50%で、初期費用の合計は約35万円になります。
→ issues: [{"code":"AIX_BOUNDARY_ESTIMATE","summary":"初期費用の金額内訳をAIXを使わずに直接提示している","evidence":"初期費用の合計は約35万円になります","pass":"rule_check"}]

【出力例4b - 問題なし（作成宣言のみ・金額内訳なし）】
かしこまりました！！最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！
→ issues: []
（理由: 金額・内訳の直接提示ではなく、AIXシートで実際の数字を送る前提の「作成宣言のみ」。AIX_BOUNDARY_ESTIMATEに該当しない）

【出力例5 - AIX_BOUNDARY_PROPERTY 違反】
エクセレント目黒502号室、家賃9万5千円・2LDKのお部屋をご案内できます。
→ issues: [{"code":"AIX_BOUNDARY_PROPERTY","summary":"物件名・家賃・間取りを初出でAIXを使わずに直接提示している","evidence":"エクセレント目黒502号室、家賃9万5千円・2LDK","pass":"rule_check"}]

【出力例6 - AIX_BOUNDARY_APPLICATION 違反】
正式にお申し込みの手続きに進みます。必要書類は身分証明書・収入証明書・保証人の印鑑証明書の3点です。
→ issues: [{"code":"AIX_BOUNDARY_APPLICATION","summary":"申込確定文と必要書類リストをAIXを使わずに直接案内している","evidence":"必要書類は身分証明書・収入証明書・保証人の印鑑証明書の3点です","pass":"rule_check"}]

【出力例7 - AIX_BOUNDARY_MOVEIN 違反】
管理会社より連絡があり、入居可能日は来月の1日からとのことです。
→ issues: [{"code":"AIX_BOUNDARY_MOVEIN","summary":"入居可能日をAIXを使わずに直接回答している","evidence":"入居可能日は来月の1日からとのことです","pass":"rule_check"}]

【出力例8 - AIX_BOUNDARY_MEETING 違反】
当日は品川区大崎1-2-3のコートハウス大崎エントランスに14時にお集まりください。
→ issues: [{"code":"AIX_BOUNDARY_MEETING","summary":"住所・集合場所・集合時間をAIXを使わずに直接案内している","evidence":"品川区大崎1-2-3のコートハウス大崎エントランスに14時にお集まりください","pass":"rule_check"}]

【出力例9 - BANNED_WORD 違反（審査落ち時の禁止語彙）】
今回は審査の結果が通りませんでした。この度は誠に申し訳ございません。
→ issues: [{"code":"BANNED_WORD","summary":"審査落ち時に禁止語彙「申し訳ございません」を使用している","evidence":"申し訳ございません","pass":"rule_check"}]

【出力例10 - 問題なし（内覧の意向確認はOK・具体的な日時なし）】
ご内覧にご興味はおありでしょうか？ご希望でしたらお気軽にお申し付けください。
→ issues: []

【出力例11 - 問題なし（退去日を「聞く」はOK）】
現在のお住まいのご退去予定はいつ頃をお考えでしょうか？
→ issues: []

【AIX境界線チェックの判断基準】
「通常返信AIは宣言のみ・実行はAIX」の原則に基づく境界線の正確な判断:

【初期費用・見積（AIX_BOUNDARY_ESTIMATE）】
OK: 「御見積書を作成してお送りします」「最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！」（金額なし・AIXシートが実際の数字を送る前提の宣言。※ただし顧客の費用質問・見積依頼・特定物件送付・送付済み物件への前向き反応のいずれも無い場合は state を問わず決定論 TIMING_VOCAB_MISMATCH / ESTIMATE_NO_TRIGGER が判定する）
OK: 「初期費用については御見積書にてご案内させていただきます」（案内の予告のみ）
違反: 「敷金○ヶ月分・礼金○ヶ月分・保証料○%で初期費用合計は約○万円です」（金額・内訳の直接提示）
違反: 「初期費用は○万円になります」（具体的な金額の直接提示）

【内覧関連（AIX_BOUNDARY_VIEWING / AIX_BOUNDARY_MEETING）】
OK: 「内覧しませんか？」「内覧をご希望ですか？」「内覧のご要望があればご連絡ください」（意向確認のみ）
違反: 「8月7日（木）14:00〜内覧はいかがでしょうか」（具体的な日時を提示）
OK: 「内覧の際にご連絡いたします」（案内の予告のみ）
違反: 「渋谷区恵比寿2-1-1のエントランスに13時集合でお願いします」（住所・時間の直接案内）

【物件情報（AIX_BOUNDARY_PROPERTY）】
OK: 「条件に合う物件をお探ししています」「新着物件が出ましたらご連絡します」
違反: 「○○マンション101号室・家賃○万円・1LDKの物件があります」（物件名・家賃・間取りの初出提示）
OK: 「先程ご紹介した物件はいかがでしょうか？」（AIXで提示済みの物件への言及）

【申込関連（AIX_BOUNDARY_APPLICATION）】
OK: 「申し込みのお手続きについてご説明します」（手続き案内の予告）
違反: 「申し込みを受け付けました。必要書類は○○・○○・○○の3点です」（確定文・書類リスト）

【入居日関連（AIX_BOUNDARY_MOVEIN）】
OK: 「ご希望のお引越し時期はいつ頃でしょうか？」（希望を聞く）
OK: 「入居可能日について管理会社に確認してご連絡いたします」（確認の約束）
違反: 「入居可能日は○月○日からとなっております」（直接回答）

【禁止語彙の判断】
「少々お待ちください」→ 常に禁止（代替: 「しばらくお待ちください」「少しお時間をいただけますか」）
「申し訳ございません」→ 審査落ち・物件消滅の文脈でのみ禁止（通常の謝罪表現は文脈次第で判断）
「スモラ」→ 常に禁止（会社の別ブランド名。顧客向け文への混入禁止）
「名称未設定」→ 常に禁止（顧客名が不明な場合のシステム文字列の混入）
「**」（アスタリスク2つ）→ 常に禁止（markdownの太字記法。LINEでは表示されず不自然）

【AIX_BOUNDARY_DBの判断】
[RULES]内で「【線引き】」マークが付いているルールに対し、返信文がその制限事実を自ら直接回答・開示している場合のみ AIX_BOUNDARY_DB 違反。
「確認してご連絡いたします」等の確認宣言のみの文は対象外（制限事実を直接開示していないため）。
違反の例: 「この物件はペット不可です」→ 管理会社判断を直接回答しており違反
非違反の例: 「ペット飼育の可否を管理会社に確認いたします」→ 確認宣言のみのため非違反
非違反の例: 「審査については管理会社の判断次第となります」→ 可否を断言していないため非違反

【RULE_VIOLATIONの使い方】
AIX_BOUNDARY_* にもBANNED_WORDにも分類できないが、[RULES]のルールに明確に違反している場合に使用する。
使用例: DBルールに「外国籍のお客様には申告していただく必要があります」とあり、返信が外国籍を一切考慮していない場合など。
明確な根拠（[RULES]内の文章から引用できる内容）がなければ RULE_VIOLATION を発行しないこと。`;
  const ngPropertyNote = ctx.ngProperties?.length
    ? `【🚫 提案禁止物件チェック】以下の物件名がこの返信本文に1文字でも含まれていたら NG_PROPERTY_MENTION（severity: block）として報告してください。物件名を削除・言及を避けるよう suggestion に明記すること。\n禁止物件: ${ctx.ngProperties.join(" / ")}\n\n`
    : "";
  const dynamic = `${ngPropertyNote}${brainBaselineNote}${aixNote}
[REPLY]
${draft}
[/REPLY]`;
  return [
    { type: "text" as const, text: stable, cache_control: { type: "ephemeral", ttl: "1h" } },
    { type: "text" as const, text: dynamic },
  ];
}

// ─── Pass 2: 前帯状回（異常検知 / anomaly_scan）────────────────────────────────
// プロンプトキャッシュ: 安定部（検査指示・情報源優先順位・code一覧・finalCheckRules・出力例）を
// 先頭ブロック + cache_control、動的部（brain判定・clearedFacts・情報源・draft）を後続に分離。
function buildAnomalyScanPrompt(draft: string, ctx: FinalCheckContext): PromptBlock[] {
  const brainBaselineNote = ctx.brainMeta?.action
    ? `【Brain判定済み】Brain（Sonnet）がaction="${ctx.brainMeta.action}"（enforcement="${ctx.brainMeta.enforcement_level}"）と判定済みです。この判断に沿った返信かどうかを確認すること。絶対ルール違反・禁止語彙・明らかなミスのみ指摘し、Brain判定と整合している内容にはフラグを立てないこと。\n\n`
    : "";
  const clearedFactsNote = ctx.clearedFacts?.length
    ? `【照合済み確認済み】以下の記述はすでに情報源との照合で根拠ありと確認されています。ハルシネーションとして指摘しないこと：\n${ctx.clearedFacts.map(f => `・「${f}」`).join("\n")}\n\n`
    : "";
  const stable = `返信文の中の「事実の主張」をすべて抽出し、それぞれについて「この事実はどこから来たのか」を
下の情報源と照合してください。情報源に根拠がない事実は捏造（ハルシネーション）として必ず指摘してください。
指摘には必ず本文からの引用（evidence）を付けること。引用できない指摘は出力しないこと。
情報源と照合して問題がなければ issues を空配列にしてください。
最優先で疑うもの：
1. 円・万円の金額（家賃・敷金・礼金・初期費用・保証料）— 情報源に同じ数字が無ければ捏造
2. 空室確認の結果（「空室でした」「埋まりました」「〇月〇日から入居可能」）— 管理会社に
   確認した事実が情報源に無ければ捏造
3. 物件名・号室・駅名・路線名 — 情報源と一字一句照合。顧客の条件数字の写し間違い
   （「13〜17万」→「3〜17万」等）も捏造扱い
4. 日付・曜日・時刻 / 顧客の名前（情報源上の名前と一致するか。「名称未設定」は名前ではない）
5. 会社の制度の説明（仲介手数料はブランドで固定: スモラ=2,980円・イエヤス=0円・ギガ賃貸=0円。
   固定なので「仲介手数料を割引」という表現のみ誤り。「初期費用を最大限割引」は正しい制度
   （オーナーから頂く広告料ADを初期費用に還元）なので捏造として指摘しないこと。
   日割家賃: 入居日〜月末の日数分が発生。1日入居は日割家賃なし＝最も安い。2日以降入居は
   日割家賃＋翌月分家賃で約2ヶ月分の支払い。「月末入居が安い」「1日入居は高い」は誤り）

情報源の優先順位（上ほど権威が高い。矛盾したら上を正とする）:
1位 [CHECKPOINTS] — 過去の会話全体から抽出済みの確認済み事実（日付付き・最高権威）
2位 [CUSTOMER_CONDITIONS] — DBに保存された顧客条件
3位 [HISTORY] — 直近の会話履歴（直近10件のみ）
4位 返信文自身の主張（根拠にならない）
返信文が [CHECKPOINTS] または [CUSTOMER_CONDITIONS] と矛盾する場合は必ず捏造として指摘すること。
逆に、返信文の事実が [CHECKPOINTS] に記載されていれば、[HISTORY] に無くても根拠ありとして扱うこと
（[HISTORY] より古い会話の根拠は [CHECKPOINTS] に集約されている）。
[CUSTOMER_CONDITIONS] の数値は単位表記なしの生値の場合がある（例: 170000 = 17万円）。
単位換算して一致するなら捏造ではない。桁違い・別の数字のみ捏造扱い。

code は次から選ぶこと:
FABRICATED_AMOUNT（金額の捏造）/ FABRICATED_AVAILABILITY（空室確認結果の捏造）/
FABRICATED_PROPERTY（物件名・号室・駅名の捏造/写し間違い）/ FABRICATED_DATE（日付・曜日・時刻の捏造）/
FABRICATED_NAME（名前の誤り）/ FABRICATED_POLICY（会社制度の誤説明）
${ctx.finalCheckRules ? `\n[FINAL_CHECK_RULES]\n${ctx.finalCheckRules.slice(0, 2000)}\n[/FINAL_CHECK_RULES]\n` : ""}
【出力例1 - 問題なし】
ご希望の1LDKで家賃7万円以内の物件をお探ししております。
→ issues: []

【出力例2 - FABRICATED_AMOUNT 違反】
（CHECKPOINTSに「家賃6万円」と記録されているが、返信文に「家賃8万円台の物件もご紹介できます」と書かれている場合）
→ issues: [{"code":"FABRICATED_AMOUNT","summary":"CHECKPOINTSに記録された金額と異なる金額を返信に記載している","evidence":"家賃8万円台の物件もご紹介できます","pass":"anomaly_scan"}]

【出力例3 - 問題なし（CHECKPOINTSと一致）】
（CHECKPOINTSに「初期費用20万円以内」と記録されており、返信文に「初期費用は20万円以内でお探しできます」と書かれている場合）
→ issues: []

【出力例4 - FABRICATED_PROPERTY 違反（物件名の号室違い）】
（情報源に「エクセレント目黒502号室」と記録されているが、返信文に「エクセレント目黒503号室」と書かれている場合）
→ issues: [{"code":"FABRICATED_PROPERTY","summary":"物件の号室番号が情報源と異なっている","evidence":"エクセレント目黒503号室","pass":"anomaly_scan"}]

【出力例5 - FABRICATED_DATE 違反（曜日の誤り）】
（実際は木曜日であることが情報源から確認できるのに、返信に「8月7日（金）に内覧はいかがでしょうか」と書かれている場合）
→ issues: [{"code":"FABRICATED_DATE","summary":"日付と曜日が一致していない","evidence":"8月7日（金）","pass":"anomaly_scan"}]

【出力例6 - FABRICATED_NAME 違反（顧客名の誤り）】
（情報源・履歴に顧客名「田中様」と記録されているが、返信に「鈴木様」と書かれている場合）
→ issues: [{"code":"FABRICATED_NAME","summary":"顧客の名前が情報源と異なっている","evidence":"鈴木様","pass":"anomaly_scan"}]

【出力例7 - FABRICATED_POLICY 違反（会社制度の誤説明）】
イエヤスの仲介手数料は通常の半額の0.5ヶ月分になります。
→ issues: [{"code":"FABRICATED_POLICY","summary":"イエヤスの仲介手数料は0円（無料）が正しいが、半額と誤って説明している","evidence":"仲介手数料は通常の半額の0.5ヶ月分","pass":"anomaly_scan"}]

【出力例8 - 問題なし（単位換算して一致する場合）】
（CUSTOMER_CONDITIONSに家賃「170000」（単位なし）と記録されており、返信に「家賃17万円以内でお探しします」と書かれている場合）
→ issues: []

【出力例9 - 問題なし（CHECKPOINTSに根拠がありHISTORYにない場合）】
（CHECKPOINTSに「2024/03/15: 内覧済み・エクセレント目黒502号室」と記録されており、HISTORYには当該記録がないが返信に「先日内覧いただいたエクセレント目黒のお部屋はいかがでしたか？」と書かれている場合）
→ issues: []

【ハルシネーション検出の判断ポイント】
以下は誤検知のため issues: [] にすること:
- 家賃の単位変換: CUSTOMER_CONDITIONSの「170000」は「17万円」と同値。一致するなら捏造でない
- CHECKPOINTSに記載済みの事実: HISTORYにない情報でもCHECKPOINTSに根拠があれば非捏造
- 「初期費用を最大限割引」「AD還元で初期費用を還元」などの制度説明: 会社の正規制度のため捏造でない
- 「1日入居は日割家賃なしで最もお得」という説明: 正しい制度説明のため捏造でない

以下は必ず指摘すること:
- 円単位の金額が情報源の数字と異なる場合（桁違い・数字違いは全て）
- 「空室でした」「埋まっていました」「○月から入居可能」等の空室確認結果（情報源に確認事実がなければ捏造）
- 物件名・号室の一字一句の違い（「502号室」→「503号室」等の写し間違い）
- 「名称未設定」という文字列が顧客名として使われている（実際の名前ではない）
- 会社制度の誤説明（スモラ仲介手数料=2,980円・イエヤス=0円・ギガ賃貸=0円は固定値。「割引」はない）

日割家賃の正しい知識（誤説明の検出に使用）:
- 月初（1日）入居: 日割家賃なし = 最もコストが低い
- 月中〜月末入居: 入居日〜月末の日割家賃 + 翌月分家賃 = 約2ヶ月分の支払いになる
- 「月末入居が安い」「1日入居は高い」はどちらも誤り（FABRICATED_POLICY）

情報源優先順位の適用例:
[CHECKPOINTS] と [HISTORY] が矛盾する場合、CHECKPOINTSを正として判断すること:
- CHECKPOINTSに「家賃15万円以内」 + HISTORYに「13万円以内と言っていた」→ CHECKPOINTSの15万円が正
- CHECKPOINTSに「内覧済み・エクセレント目黒502号室」 + HISTORYにその記録なし→ 内覧済みが正
[CUSTOMER_CONDITIONS] と返信文が矛盾する場合、CUSTOMER_CONDITIONSを正として判断すること:
- CUSTOMER_CONDITIONSに「間取り: 2LDK以上」 + 返信に「1LDKのお部屋を探しています」→ FABRICATED捏造

【FABRICATED系コードの使い分け】
FABRICATED_AMOUNT: 家賃・敷金・礼金・初期費用・保証料など金銭に関する数字の捏造や誤り
FABRICATED_AVAILABILITY: 空室確認結果（「空室でした」「すでに埋まっていました」「○月○日から入居可能」等）の捏造
FABRICATED_PROPERTY: 物件名・号室・駅名・路線名の誤りや写し間違い
FABRICATED_DATE: 日付・曜日・時刻の誤り（日付と曜日の不一致含む）
FABRICATED_NAME: 顧客名・担当者名の誤り（「名称未設定」が顧客名として使われている場合を含む）
FABRICATED_POLICY: 仲介手数料・日割家賃・AD還元など会社固有の制度・ルールの誤説明

【よくある誤検知パターン（issues: []にすべきケース）】
- 「最大限割引」「初期費用を割引」→ 正しい制度説明（AD還元による初期費用還元）のため捏造でない
- 「仲介手数料0円」（イエヤス・ギガ賃貸の場合）→ 正しい制度のため捏造でない
- 「仲介手数料2,980円」（スモラの場合）→ 正しい制度のため捏造でない
- 家賃が CUSTOMER_CONDITIONS の数値と単位換算で一致する場合→ 捏造でない（例: 170000=17万円）
- CHECKPOINTS に記載された確認済み事実と一致する場合→ HISTORY になくても捏造でない
- 【会社標準案内・業界一般知識（情報源に無くても捏造でない）】以下は会社の標準案内文・業界共通知識のため、
  FABRICATED_DATE / FABRICATED_AMOUNT 等を発行しないこと:
  ・「審査（保証会社審査）は3日〜10日程度」/「お申込から最短2週間程でご入居可能」
  ・「保証会社の審査が通過するまでキャンセル料は一切かからない」/「審査に落ちても費用は発生しない」
  ・「保証会社の費用は一般的に総賃料の50%前後（一般論として・物件により異なる旨を添えた説明）」
  ※ただし特定物件の保証料実額・特定物件の入居可能日を断定している場合は従来どおり指摘対象`;
  const dynamic = `${brainBaselineNote}${clearedFactsNote}[CHECKPOINTS]
${(ctx.checkpointFacts || "なし").slice(0, 2000)}
[/CHECKPOINTS]
[CUSTOMER_CONDITIONS]
${(ctx.customerConditionsDb || "なし").slice(0, 1500)}
[/CUSTOMER_CONDITIONS]
[HISTORY]
${formatHistory(ctx.recentMessages, 10)}
[/HISTORY]
[SOURCE]
${(ctx.staffSourceText || "なし").slice(0, 5000)}
[/SOURCE]
[REPLY]
${draft}
[/REPLY]`;
  return [
    { type: "text" as const, text: stable, cache_control: { type: "ephemeral", ttl: "1h" } },
    { type: "text" as const, text: dynamic },
  ];
}

// ─── Pass 3: バグ探し思考（文脈・網羅性 / context_check）──────────────────────
// プロンプトキャッシュ: 安定部（検査項目・code一覧・finalCheckRules・出力例）を先頭ブロック +
// cache_control、動的部（brain判定・現在時刻・STAGE・顧客メッセージ・draft）を後続に分離。
// 旧実装は nowJstString()（毎分変化）が検査項目4の中に埋め込まれておりプレフィックスを
// 毎分無効化していたため、【現在時刻】ブロックとして動的部へ移動した（検査内容は同一）。
function buildContextCheckPrompt(draft: string, ctx: FinalCheckContext): PromptBlock[] {
  // TPO場面（感謝返し・ネガ文脈・強推し直後 等）。生成側が意図的に話題を絞った局面を
  // 「不足」と誤検出しないための文脈（generate-reply の tpoNoteForLLM と同一値）
  const tpoPart = ctx.tpoLabel
    ? `\n場面(TPO): ${ctx.tpoLabel}。この場面に適した返信かどうかで判定すること。この場面で意図的に省かれた要素（新規物件提案・CTA・申込誘導・条件の再ヒアリング等）を「不足」として指摘しないこと`
    : "";
  // 2026-09-09 Fable5 往復文脈: 「この場面で省かれた要素」として必須要素を免除させない
  const pairPart = (() => {
    if (!ctx.lastCustomerMessage) return "";
    const { pair } = resolveReplyContext(ctx);
    // 2026-09-11 統合設計（経路D）: 締め verdict を LLM にも渡す（決定論の isClosedVerdict と同じ値。LLM の WE_DO_MISSING / DOUBLE_DECLARATION が同じ場面認識を持つ）
    const cl = pair.closing ?? { kind: null, evidence: "" };
    const closingLine = `\n締め: ${cl.kind === "farewell" ? "探索終了・お別れのお礼への返し" : cl.kind === "decline" ? "お客様の断りへの返し" : "なし"}${cl.kind ? `（${cl.evidence}）。この場面では行動宣言（ピックアップ・内覧・見積）を足す指摘をしない。直前スタッフ文の再掲や前進提案を削る指摘だけを出す` : ""}`;
    if (!pair.rule) return closingLine;
    // when が false の要素（この場面に無い要素）は出さない＋プレースホルダを実値に置換（生成と同じ）
    const must = pair.rule.mustInclude.filter((m) => !m.when || m.when(pair)).map((m) => fillPairPlaceholders(m.label, pair));
    // 2026-09-11 竹内方針1: 必須要素は「生成の参考情報」。スタッフの実際の返信を優先するため、欠落を LLM に指摘させない
    //   （旧文言「欠けていれば WE_DO_MISSING として指摘すること」は決定論で info に下げた要求の裏口になっていた・V-2）
    return `\n往復文脈: 我々=${STAFF_KIND_JA[pair.staff.kind]}→お客様=${CUSTOMER_KIND_JA[pair.customer.kind]}。必須要素（生成の参考情報）: ${must.join(" / ") || "なし"}（欠落を指摘しない。スタッフの実際の返信はこの要素を含まないことが多い）${closingLine}`;
  })();
  // 2026-09-09 行動台帳: 「我々が実際にしたこと」を段階情報に添える。DOUBLE_DECLARATION の誤発行（条件更新を伴う宣言の再提示）を抑止
  // 2026-09-11 統合設計（経路E1）: 一次証拠は aix_usage_logs > line_tasks > 本文（旧表記は aix_usage_logs のみで誤り）。
  //   免除文の条件は決定論フィルタ（runFinalCheck の DOUBLE_DECLARATION フィルタ）と同じ「約束未履行＋条件変更」（送付件数を条件にしない）
  const ledgerPart = (() => {
    if (!ctx.lastCustomerMessage && !ctx.ledger) return "";
    const l = resolveLedger(ctx);
    return `\n行動台帳（我々が実際にしたこと・一次証拠=aix_usage_logs > line_tasks > スタッフ本文）: ${l.summary}${l.facts.pickupPromisedUnfulfilled ? "\n※ 行動台帳が『ピックアップ約束・未履行』で顧客が条件を変更した場合、絞り込みを反映した宣言の再提示は DOUBLE_DECLARATION ではない（同じ約束の繰り返しではなく更新）" : ""}`;
  })();
  const stageBlock = (ctx.conversationStage || ctx.tpoLabel || pairPart)
    ? `[STAGE]\n現在段階: ${ctx.conversationStage ?? "（不明）"}${ctx.sentPropertiesCount !== undefined ? `\n送付済み物件数: ${sentCountOf(ctx)}件` : ""}${ctx.checkpointStage && ctx.checkpointStage !== ctx.conversationStage ? `\nフェーズ乖離: brain実態=${ctx.checkpointStage} DB=${ctx.conversationStage}。実態フェーズで判定すること` : ""}${ledgerPart}${tpoPart}${pairPart}\n[/STAGE]\n`
    : "";
  const brainBaselineNote = ctx.brainMeta?.action
    ? `【Brain判定済み】Brain（Sonnet）がaction="${ctx.brainMeta.action}"（enforcement="${ctx.brainMeta.enforcement_level}"）と判定済みです。この判断に沿った返信かどうかを確認すること。絶対ルール違反・禁止語彙・明らかなミスのみ指摘し、Brain判定と整合している内容にはフラグを立てないこと。このアクションと矛盾しない返信内容であればSTAGE_SKIPは発行しないこと。\n\n`
    : "";
  const stable = `${ADVERSARIAL_PREAMBLE}

顧客の最新メッセージと返信文を突き合わせ、以下を検査してください。
1. 質問の取りこぼし：顧客の質問を全て列挙し、返信が各質問に具体的に答えているか。
   1つでも未回答なら missing として指摘（「確認します」だけで理由が無いものも未回答扱い）
   【例外】特定物件（物件名・URL・号室・「この物件」等で対象が特定できる）についての管理会社確認が必要な質問（空室状況・審査結果・入居可能日・設備詳細・ペット可否の管理会社判断等）に対する「確認してご連絡します」「確認いたします」「確認して参ります」などの返答は正当な回答とみなし、MISSED_QUESTION を発行しないでください。
   ※この例外は「特定物件が指定されている」場合に限る。特定物件を指していない条件追加（下記11）には適用しない。
2. 段階ミスマッチ：退去予定・入居中物件への内覧提案 / 内覧前なのに感想を聞く /
   キャンセル意思への物件提案 / 既にDBにある条件の聞き返し / 既出物件の再提案
3. 二重宣言：直近のスタッフ送信と同じ約束・お礼・挨拶・説明の繰り返し
   （「ピックアップしてお送りします」の再宣言、同日2回目の挨拶、お礼の二重等）
4. 時刻の妥当性：下の【現在時刻】を基準に、18時以降・営業時間外に「本日中に管理会社へ確認」等の
   実行不可能な約束をしていないか
5. 段階の前倒し：[STAGE] の現在段階より先の段階の行動（物件を1件も送っていないのに内覧打診 /
   条件ヒアリング未完了なのに申込プッシュ等）をしていないか。
   ただし顧客側が先にその段階を要求している場合（顧客が「申し込みたい」と言っている場合等）は指摘しない
6. スタッフ依頼の取りこぼし：[RECENT_STAFF_MESSAGES] の中に、スタッフ（スモラ側）が顧客に対して
   何かを提出・送付・確認するよう依頼したメッセージがあるか確認する。
   顧客の最新メッセージがその依頼を満たしていない場合、かつ返信文がその依頼を改めて促していない場合は
   STAFF_REQUEST_OMITTED として指摘する。
   【例外】スタッフ依頼が何日も前のもので、その後のやりとりで既に解決済みと判断できる場合は指摘しない。
   管理会社への確認が必要な依頼（管理会社側の判断待ち等）は対象外。
7. WE DO宣言（WE_DO_MISSING）：返信テキストに「〜させて頂きます」「〜いたします」「〜します！！」のいずれかの行動宣言形が最低1文含まれているか確認する。一切含まれていない場合は NG。
   【例外】次の場合は対象外: ①内覧キャンセル・保留連絡への3文以内の短い了解返信 ②お客様の締め挨拶・社交辞令（「こちらこそ」「よろしくお願いします」等）への返し ③スタッフが直前にピックアップ約束済みで短い承諾のみ返す場合。
8. フィラー挨拶（FILLER_GREETING）：顧客の最新メッセージが条件変更・条件追加・条件緩和・ピックアップ依頼である場合に限り、返信冒頭の「お世話になっております」「いつもお世話になっております」を NG とする（この場面は「かしこまりました！！」で直接行動宣言に入るのが正）。
   【重要】長い返信・重要な連絡・条件確認の返信、および2回目以降の通常会話での冒頭「〇〇さんお世話になっております！！」は会社標準の書き出しであり指摘しないこと。
9. 主語混乱（SUBJECT_CONFUSION）：物件送付後にお客様が確認する場面（顧客が「確認します」等と述べた直後）で、スタッフが「確認でき次第ご連絡させて頂きます」等の表現を使っていれば NG。ただし管理会社への確認（空室確認・交渉中）の文脈は除外。
10. 受け身文体（PASSIVE_ONLY）：全体的に受け身文体（〜いただければ・〜よろしいでしょうか・ご検討ください）のみで締まっていて、スタッフの能動的な行動宣言（〜いたします・〜させて頂きます等）が一切ない場合は NG。
11. 条件追加の誤ルーティング（CONDITION_ADD_MISROUTED）★重要：顧客の最新メッセージが【特定の物件を名指ししていない条件追加】（「あと、ペット可能でお願いします」「駐車場も必要です」「2LDKでお願いします」「2階以上がいいです」等。物件名・物件URL・号室・「この物件」「あの物件」「さっき送ってもらった物件」等の特定物件参照を含まない）であるにもかかわらず、返信が「管理会社に確認させて頂きます」「確認出来次第ご連絡させて頂きます」等の確認宣言で応じている場合は NG。
   正しい返信は「〇〇条件でお部屋ピックアップさせて頂きます！！ピックアップ出来次第ご連絡させて頂きます！！」の再ピックアップ宣言。特定物件を指していない以上、管理会社に問い合わせる対象が存在しないため確認宣言は誤り。
   【対象外】顧客が物件名・URL・号室・「この物件」等で特定物件を指して条件を尋ねている場合（この場合は管理会社確認が正しい）。

code は次から選ぶこと:
MISSED_QUESTION（質問の取りこぼし）/ STAGE_MISMATCH（段階ミスマッチ）/
DOUBLE_DECLARATION（二重宣言・繰り返し）/ TIME_INVALID（実行不可能な時刻の約束）/
STAGE_SKIP（段階の前倒し）/ STAFF_REQUEST_OMITTED（スタッフ依頼の取りこぼし）/
WE_DO_MISSING（行動宣言なし）/ FILLER_GREETING（フィラー挨拶）/
SUBJECT_CONFUSION（主語混乱・PatternF4）/ PASSIVE_ONLY（受け身文体のみ）/
CONDITION_ADD_MISROUTED（条件追加なのに管理会社確認で返している）
${ctx.finalCheckRules ? `\n[FINAL_CHECK_RULES]\n${ctx.finalCheckRules.slice(0, 2000)}\n[/FINAL_CHECK_RULES]\n` : ""}
【出力例1 - 問題なし（質問に適切に回答）】
（顧客メッセージ:「ペット可の物件はありますか？」→ 返信:「ペット可の物件もございます。条件に合う物件をお探しします。」）
→ issues: []

【出力例2 - MISSED_QUESTION 違反】
（顧客メッセージ:「駐車場付きの物件はありますか？」→ 返信:「新着物件が出ましたらご連絡いたします。」）
→ issues: [{"code":"MISSED_QUESTION","summary":"顧客の駐車場についての質問に回答していない","evidence":"駐車場付きの物件はありますか","pass":"context_check"}]

【出力例3 - 問題なし（管理会社確認が必要な質問）】
（顧客メッセージ:「審査は厳しいですか？」→ 返信:「管理会社に確認してご連絡いたします。」）
→ issues: []

【出力例4 - STAGE_MISMATCH 違反（内覧中物件への内覧提案）】
（顧客が現在の物件を退去予定でなく入居継続中なのに「内覧はいかがでしょうか？」と提案している場合）
→ issues: [{"code":"STAGE_MISMATCH","summary":"退去予定がない入居継続中物件への内覧提案をしている","evidence":"内覧はいかがでしょうか","pass":"context_check"}]

【出力例5 - DOUBLE_DECLARATION 違反（同じ約束の繰り返し）】
（直近スタッフ送信に「物件をピックアップしてお送りします」とあり、返信にも「条件に合う物件をピックアップしてお送りします」と書かれている場合）
→ issues: [{"code":"DOUBLE_DECLARATION","summary":"直近スタッフ送信と同じ「物件をピックアップしてお送りします」という約束を繰り返している","evidence":"条件に合う物件をピックアップしてお送りします","pass":"context_check"}]

【出力例6 - TIME_INVALID 違反（18時以降の実行不可能な約束）】
（現在時刻が19時の場合に「本日中に管理会社へ確認してご連絡いたします」と書かれている場合）
→ issues: [{"code":"TIME_INVALID","summary":"18時以降のため本日中の管理会社確認は実行不可能","evidence":"本日中に管理会社へ確認してご連絡いたします","pass":"context_check"}]

【出力例7 - STAGE_SKIP 違反（物件未送付で内覧打診）】
（物件を1件も送っていない段階なのに「内覧の日程を調整しましょう」と提案している場合）
→ issues: [{"code":"STAGE_SKIP","summary":"物件を送っていない段階で内覧日程の調整を打診している","evidence":"内覧の日程を調整しましょう","pass":"context_check"}]

【出力例8 - 問題なし（顧客が先に申込を要求している場合）】
（顧客が「この物件に申し込みたいです」と言っており、返信が申込手続きの次のステップを案内している場合）
→ issues: []

【出力例9 - 問題なし（特定物件についての確認約束）】
（顧客メッセージ:「この物件、駐車場はありますか？」→ 返信:「管理会社にご確認いたします。」）
→ issues: []

【出力例9-2 - CONDITION_ADD_MISROUTED 違反（特定物件を指していない条件追加に確認宣言で返している）】
（顧客メッセージ:「あと、ペット可能でお願いします」→ 返信:「かしこまりました！！ペット可条件で管理会社に確認させて頂きます！！」）
→ issues: [{"code":"CONDITION_ADD_MISROUTED","summary":"特定物件を指していない条件追加なのに管理会社確認で返している（正しくはピックアップ宣言）","evidence":"ペット可条件で管理会社に確認させて頂きます","pass":"context_check"}]

【出力例10 - STAFF_REQUEST_OMITTED 違反（書類送付依頼の取りこぼし）】
（直近スタッフ送信:「ご本人確認書類として運転免許証またはマイナンバーカードの裏表の写真をお送りください」
 顧客メッセージ: 申込情報を記入して送信したが、書類の写真は未送付
 返信: 「内容確認させて頂きました。申込を進めます。」）
→ issues: [{"code":"STAFF_REQUEST_OMITTED","summary":"スタッフが依頼した本人確認書類の写真が顧客から届いておらず、返信でも再依頼していない","evidence":"内容確認させて頂きました","pass":"context_check"}]

【出力例11 - 問題なし（スタッフ依頼を顧客が既に満たしている場合）】
（直近スタッフ送信:「収入証明書をお送りください」
 顧客メッセージ: 「収入証明書を添付しました」
 返信: 「書類を確認いたします。」）
→ issues: []

【出力例12 - WE_DO_MISSING 違反（行動宣言なし）】
（返信テキスト: 「ありがとうございます。ご希望の条件についてはいかがでしょうか？よろしければご検討ください。」）
→ issues: [{"code":"WE_DO_MISSING","summary":"返信に「いたします」「させて頂きます」等の能動的な行動宣言が一切含まれていない","evidence":"よろしければご検討ください","pass":"context_check"}]

【出力例13 - FILLER_GREETING 違反（条件変更依頼直後のフィラー挨拶）】
（顧客メッセージ: 「やっぱりエリアを広げて探してほしいです」→ 返信テキスト: 「お世話になっております。かしこまりました。物件をお探しいたします。」）
→ issues: [{"code":"FILLER_GREETING","summary":"条件変更依頼への返信冒頭に不要なフィラー挨拶「お世話になっております」が含まれている","evidence":"お世話になっております","pass":"context_check"}]

【出力例13b - 問題なし（2回目以降の通常会話の標準書き出し）】
（顧客メッセージ: 「審査の結果はいつ頃わかりますか？」→ 返信テキスト: 「〇〇さんお世話になっております！！審査結果につきまして確認しご連絡させて頂きます！！」）
→ issues: []

【出力例14 - 問題なし（行動宣言あり）】
（返信テキスト: 「ありがとうございます！条件に合う物件をすぐにお探しいたします！！」）
→ issues: []

【出力例15 - 問題なし（短い了解返信・WE_DO例外）】
（内覧キャンセルへの返信: 「はい😊！！またお気軽にご連絡ください。」）
→ issues: []

【各検査項目の細かい判断基準】

【1. 質問の取りこぼし（MISSED_QUESTION）】
発行しないケース:
- 特定物件（物件名・URL・号室・「この物件」等）についての管理会社確認が必要な質問（空室状況・審査結果・入居可能日・設備詳細・ペット可否）に対する「確認してご連絡します」
  ※特定物件を指していない条件追加（「あと、ペット可能でお願いします」等）への確認宣言はこの例外に含まない（CONDITION_ADD_MISROUTED の対象）
- 顧客が感想や意見を述べただけで質問していない場合
- 返信が該当質問に関する確認の約束を明示している場合
発行するケース:
- 顧客の明確な質問（「○○はできますか？」「○○はいつですか？」等）に全く触れていない場合
- 「確認します」だけで何を確認するかの明示も理由もない場合

【2. 段階ミスマッチ（STAGE_MISMATCH）】
発行しないケース:
- 顧客が自ら「内覧したい」「申し込みたい」と言っている場合（顧客主導の段階前倒し）
- 物件を送付後（STAGE=物件提案済み）に内覧の意向確認をする場合（正当な流れ）
発行するケース:
- 退去が決まっていない・内覧できない状況の物件への内覧提案
- キャンセルを明示した顧客への物件提案の継続
- 内覧前なのに内覧の感想を聞く

【3. 二重宣言（DOUBLE_DECLARATION）】
発行しないケース:
- 内容が実質的に異なる場合（前回は「物件を探します」、今回は「○○区限定で探します」等）
- [STAGE] の行動台帳が『ピックアップ約束・未履行』で顧客が条件を変更・絞り込んだ場合の、絞り込みを反映した宣言の再提示（同じ約束の繰り返しではなく約束の更新）
- 顧客側からの再質問・再確認に応えて繰り返す場合（顧客が促した場合）
- TikTok・SNS動画経由の初回返信で「ご連絡頂きありがとうございます」＋「動画みていただきありがとうございます」の
  お礼が連続する場合（TikTok流入時の必須文言セットであり二重宣言ではない）
発行するケース:
- 直近スタッフ送信と全く同じ約束文・お礼文・挨拶文を繰り返す場合
- 同日に2回以上「よろしくお願いいたします」等の定型挨拶を繰り返す場合

【4. 時刻の妥当性（TIME_INVALID）】
- 「本日中に管理会社へ確認」「今日中にご連絡」等は18時以降であれば実行不可能な約束
- 「明日ご連絡いたします」「後日確認いたします」等は時刻に関わらず有効
- 土日・祝日・深夜に「本日中に」等の同日約束は実行不可能な約束

【5. 段階の前倒し（STAGE_SKIP）】
標準フロー: 条件ヒアリング → 物件提案 → 内覧打診 → 申込検討 → 申込手続き
発行するケース:
- 物件を1件も送っていない段階で内覧の打診（物件提案をスキップしている）
- 物件提案前に申込の手続き案内（複数段階をスキップしている）
発行しないケース:
- 顧客が自ら「申し込みたい」と言っている場合（顧客主導なので違反でない）
- 顧客が「早く内覧したい」と言っており、物件と一緒に内覧提案をする場合

【6. スタッフ依頼の取りこぼし（STAFF_REQUEST_OMITTED）】
発行するケース:
- 直近スタッフ送信に「〇〇をお送りください」「〇〇の写真を送ってください」「〇〇をご提出ください」
  等の顧客への提出・送付・確認依頼があり、顧客の最新メッセージがその依頼を明らかに満たしていない場合
- かつ、返信文がその依頼を改めて促す文章を含んでいない場合
発行しないケース:
- 顧客メッセージ内で書類・写真・情報を既に提供している旨が明示されている場合
- スタッフ依頼が複数日前のもので、その後のやりとりから既に解決済みと見なせる場合
- 依頼内容が管理会社等の外部判断待ちのもの（スタッフが顧客に対して要求していない）
- 依頼の性質上、後日対応でも問題ない場合（「後で送ってください」等の緩い依頼）

【7. WE DO宣言（WE_DO_MISSING）】
発行するケース:
- 返信全体に「いたします」「させて頂きます」「します！！」等の能動的な行動宣言文が1文もない場合
- 「かしこまりました！！」のみで終わる返信（後続に具体アクション文がない場合）も発行対象
  例: 「かしこまりました！！何卒よろしくお願い致します！！」→ 発行すること（行動宣言なし）
発行しないケース:
- 「はい！！」「確認いたします」等の短い了解返信は行動宣言として十分
- 「かしこまりました！！」を含む場合でも、後続に「〜させて頂きます」「〜いたします」「〜します！！」等の具体アクション文が最低1文あれば十分
- 内覧キャンセルへの短い了解返信・締め挨拶への返し・ピックアップ約束後の短い承諾は対象外
- 「いたします」「させて頂きます」が文中に1つでも存在する場合はOK

【8. フィラー挨拶（FILLER_GREETING）】
発行するケース:
- 顧客の最新メッセージが条件変更・条件追加・条件緩和・ピックアップ依頼で、返信冒頭（最初の1〜2文）に
  「いつもお世話になっております」「お世話になっております」が含まれている場合のみ
発行しないケース:
- 顧客の最新メッセージが条件変更・ピックアップ依頼ではない場合（通常会話・質問・報告等）
  → 2回目以降の会話・長い返信・重要な連絡での冒頭「〇〇さんお世話になっております！！」は会社標準の書き出し
- 冒頭以外の箇所に含まれる場合（冒頭のみを確認すること）
- 「お世話様です」等の類似表現は対象外（完全一致のみ）

【9. 主語混乱（SUBJECT_CONFUSION）】
発行するケース:
- 物件送付後に顧客が「確認します」「見てみます」等と述べた直後に、スタッフが「確認でき次第ご連絡させて頂きます」
  「ご確認いただければすぐにご連絡します」等と返信している場合
  （顧客が確認する側なのに、スタッフが「確認でき次第連絡」という主語が逆になっている状況）
発行しないケース:
- 管理会社への確認が文脈として明確な場合（「空室を管理会社に確認でき次第」等）
- 顧客の「確認します」が物件確認ではなく、スケジュール確認等の別の意味の場合

【10. 受け身文体（PASSIVE_ONLY）】
発行するケース:
- 返信全体が「〜いただければ」「〜よろしいでしょうか」「ご検討ください」「お知らせください」等の
  受け身・依頼形のみで構成されており、スタッフが何をするかの能動的宣言が全くない場合
発行しないケース:
- 「いたします」「させて頂きます」等の能動文が1文でもある場合
- 顧客への確認・質問が主目的の返信（条件確認・アンケート等）で受け身が自然な場合

【11. 条件追加の誤ルーティング（CONDITION_ADD_MISROUTED）】
発行するケース:
- 顧客の最新メッセージが特定物件を名指ししていない条件追加（「あと、ペット可能でお願いします」「駐車場も必要です」
  「2LDKでお願いします」「2階以上がいいです」「バストイレ別で」等）であるのに、返信が
  「管理会社に確認させて頂きます」「確認出来次第ご連絡させて頂きます」等の確認宣言になっている場合
  （正しくは「〇〇条件でお部屋ピックアップさせて頂きます！！ピックアップ出来次第ご連絡させて頂きます！！」）
発行しないケース:
- 顧客が物件名・物件URL・号室・「この物件」「あの物件」「さっき送ってもらった物件」等で特定物件を指している場合
  → この場合は管理会社確認が正しい対応
- 返信が既にピックアップ宣言になっている場合
- 顧客メッセージが条件追加ではなく、費用交渉・空室確認・入居可能日等の依頼である場合

【各コードの典型的なfalse positiveと対処】
MISSED_QUESTION の誤発行を避けるべきケース:
- 顧客が複数の質問をしており、返信がその一部に「管理会社確認します」と答えている場合
  → 特定物件についての管理会社確認が必要な質問（空室・審査・ペット可否・設備詳細・入居可能日）は確認宣言のみで十分
  → ただし特定物件を指していない条件追加は対象外（この場合はピックアップ宣言が正解・CONDITION_ADD_MISROUTED を参照）
- 顧客がただ状況を報告しているだけで質問していない場合
  → 「先日内覧してきました」「申込を考えています」等は質問ではない
DOUBLE_DECLARATION の誤発行を避けるべきケース:
- スタッフ送信と顧客メッセージを挟んで同じ内容が出る場合
  → RECENT_STAFF_MESSAGESの直近送信との重複のみを確認。1件前より古いスタッフ送信との重複は基本的に誤検知
- 定型的な締めの挨拶（「よろしくお願いいたします」等）が含まれる場合
  → 毎回の送信に含まれる定型文は二重宣言ではない。「同じ約束」が二重になっている場合のみ指摘
- 同一返信内で「ご連絡頂きありがとうございます」の直後に「動画みていただきありがとうございます」が続く場合
  → TikTok・SNS流入時の必須文言セット。お礼の二重として指摘しない
STAGE_SKIP の誤発行を避けるべきケース:
- [STAGE]が設定されていない場合 → 段階情報なしでSTAGE_SKIPを発行しないこと
- Brain判定で action が内覧・申込などの先の段階を指している場合 → Brain判定と整合しているためSTAGE_SKIPを発行しないこと
STAFF_REQUEST_OMITTED の誤発行を避けるべきケース:
- RECENT_STAFF_MESSAGESに依頼文がなく、返信文だけを根拠に発行しないこと
- 顧客メッセージが「添付しました」「送りました」「写真を送信しました」等の提出完了を示す表現を含む場合は発行しないこと
- スタッフ側の依頼ではなく、顧客側からの申し出（「書類を準備します」等）に対しては発行しないこと
WE_DO_MISSING の誤発行を避けるべきケース:
- 「はい！！」「確認いたします」等の短い了解返信は行動宣言として十分なため発行しないこと
- 「かしこまりました！！」は了解語として認めるが、返信全体に「〜させて頂きます」「〜いたします」「〜します！！」等の具体アクション文が1文もない場合は発行すること（「かしこまりました！！」単独・「かしこまりました！！何卒よろしくお願い致します！！」等は不十分→発行する）
- 「いたします」「させて頂きます」が1文でも含まれていれば絶対に発行しないこと
- 短い了解・承認返信（3文以内の短い返信）であっても「かしこまりました！！」単独は対象外とせず発行すること
FILLER_GREETING の誤発行を避けるべきケース:
- 顧客の最新メッセージが条件変更・条件追加・ピックアップ依頼でない場合は絶対に発行しないこと
  （「お世話になっております」は2回目以降の会話・長文・重要連絡では会社標準の書き出しとして必須使用される）
- 「お世話になっております」が冒頭以外（2文目以降）に含まれる場合は対象外
- 「お世話様でした」等の類似表現は対象外（「お世話になっております」「いつもお世話になっております」の完全一致のみ）
SUBJECT_CONFUSION の誤発行を避けるべきケース:
- 管理会社への確認文脈では発行しないこと（「管理会社に確認でき次第」等は正常）
- 顧客の「確認します」が物件確認以外の意味（日程確認・書類確認等）の場合は発行しないこと
PASSIVE_ONLY の誤発行を避けるべきケース:
- 「いたします」「させて頂きます」が1文でもあれば絶対に発行しないこと
- 条件確認や感謝への短い返信など、受け身が自然な文脈では発行しないこと
CONDITION_ADD_MISROUTED の誤発行を避けるべきケース:
- 顧客メッセージに物件名・URL・号室・「この物件」等の特定物件参照がある場合は絶対に発行しないこと
- 返信が既に「ピックアップさせて頂きます」等の再ピックアップ宣言になっている場合は発行しないこと
- 顧客が条件追加ではなく費用交渉・空室確認・入居可能日を依頼している場合は発行しないこと

【タイムゾーンについての注意】
【現在時刻】は日本標準時（JST・UTC+9）で表示される。
「18時以降」の判定は JST 18:00 以降を指す。日本の営業時間は一般的に9:00-18:00。
深夜（22:00以降）や早朝（7:00以前）の「本日中に」等の約束も実行不可能とみなすこと。`;
  const dynamic = `${brainBaselineNote}【現在時刻】${nowJstString()}
${stageBlock}[CUSTOMER_MESSAGE]
${(ctx.lastCustomerMessage || "（不明）").slice(0, 1500)}
[/CUSTOMER_MESSAGE]
[ANALYSIS]
${(ctx.brainContextJson || "なし").slice(0, 2500)}
[/ANALYSIS]
[RECENT_STAFF_MESSAGES]
${formatStaffMessages(ctx.recentMessages, 5)}
[/RECENT_STAFF_MESSAGES]
[REPLY]
${draft}
[/REPLY]`;
  return [
    { type: "text" as const, text: stable, cache_control: { type: "ephemeral", ttl: "1h" } },
    { type: "text" as const, text: dynamic },
  ];
}

// ─── severity判定: LLMは見つける・コードが裁く（決定的マップ）────────────────
// HIGH-2(Fable5): 自動送信時のみ MISSED_QUESTION を block に昇格（質問無視の自動送信を防ぐ）
// FP-04: 会話初期は FABRICATED_AMOUNT / FABRICATED_AVAILABILITY を warning に格下げ（偽陽性防止）
// FN-006: context_check の TIME_INVALID を自動送信時のみ block に昇格
function assignSeverity(pass: CheckPass, code: string, isAutoSend = false, isEarlyConversation = false): CheckSeverity {
  // 2026-09-11 竹内方針1: 必須要素・骨格系は観測専用（LLM・差分再検査が同名コードを返しても info。修正ループにも渡らない）
  if (OBSERVE_ONLY_CODES.has(code)) return "info";
  // FP-04: 会話初期（情報源が薄い）は誤block防止のため FABRICATED 系を warning に格下げ
  // FABRICATED_PROPERTY も対象（初回は顧客が書いた物件名の表記ゆれを「写し間違い」と誤blockしやすいため）
  if (isEarlyConversation && (code === "FABRICATED_AMOUNT" || code === "FABRICATED_AVAILABILITY" || code === "FABRICATED_PROPERTY")) {
    return "warning";
  }
  if (pass === "rule_check" && code.startsWith("AIX_BOUNDARY")) return "block";
  if (pass === "anomaly_scan" && (code === "FABRICATED_AMOUNT" || code === "FABRICATED_AVAILABILITY")) return "block";
  if (code === "FABRICATED_PROPERTY" || code === "FABRICATED_DATE") return "block";
  if (code === "NG_PROPERTY_MENTION" || code === "INTRO_REPEAT") return "block"; // プロンプトで block と指示していたが分岐が無く常に warning だった
  // 2026-09-08 §5: 決定論由来の block 級コード（LLM が recheck で同名を返した場合も block を維持）
  if (
    code === "STATE_REGRESSION" || code === "TIMING_VOCAB_MISMATCH" || code === "SYSTEM_MARKER_LEAK" || code === "NAME_PLACEHOLDER" || code === "SYMPATHY_ECHO" ||
    code === "NAME_FULLNAME_LEAK" || code === "VIEWING_BEFORE_VACANCY" || code === "FABRICATED_POLICY_DET" ||
    code === "NEGATIVE_APOLOGY" ||
    // 2026-09-08 Fable5 G6/G26/G10: 宅建業法断言・創作確認約束・退去報告への会話終了は決定論 block（LLM recheck でも維持）
    code === "DISCLOSURE_ASSERTION" || code === "VACANCY_ASSERTION" || code === "MOVEIN_DATE_ASSERTION" || code === "SCREENING_ASSURANCE" ||
    // 2026-09-10 Fable5 あみ事例: 顧客が言っていない語（LLM recheck でも block を維持）
    code === "VOCAB_MIRROR_MISMATCH" ||
    code === "CONFIRM_NO_OBJECT" || code === "FAREWELL_ON_MOVEOUT_INFO" ||
    // 2026-09-10 Fable5 Sさん事例: [X]型（AIX【内覧日調整】専用の候補日時確認）の通常返信混入は決定論 block
    code === "VIEWING_DATE_ASK_WITHOUT_AIX"
  ) return "block";
  if (isAutoSend && pass === "context_check" && code === "MISSED_QUESTION") return "block";
  // FN-006: context_check の TIME_INVALID は自動送信のみ block、スタッフ確認経路は warning
  if (pass === "context_check" && code === "TIME_INVALID") {
    return isAutoSend ? "block" : "warning";
  }
  return "warning";
}

// evidence実在チェック用の正規化（空白差を無視）
function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, "");
}

// HIGH-3(Fable5): 決定的禁止語彙スキャン（LLM前に実行・Haiku見逃しを排除）
// evidenceは本文実在が保証されるのでL283の降格ガード対象外（ループ外で別処理）
const BANNED_WORDS_DETERMINISTIC = [
  "スモラ", "名称未設定", "少々お待ちください", "**",
  // G32（2026-09-09 Fable5 じゅにあ事例・竹内方針）: 「お待たせ」は返信から全廃（自動返信では「待たせた」前提が消える。greeting.ts WAITED_RE と同名）
  "お待たせ致しました", "お待たせいたしました", "お待たせしました",
  "承知いたしました", "承知しました", "承知致しました",
  // 2026-09-12 竹内方針B: 「ご連絡お待ちしております」は禁止語から外し、場面の判定（resolveAwaitContact → AWAIT_CONTACT_MISPLACED）に移した
  "ご連絡お待ちくださいませ", "お待ちくださいませ", "名無し",
  // 2026-09-08 語彙セマンティクス（主語逆転・自敬・宛先逆転・既存文書禁止の決定論化。prompts VOCAB_SEMANTICS と同名）
  "ご内覧させて頂き", "ご内覧させていただき",          // 内覧の主語はお客様
  "ご案内させて頂けます", "ご案内させていただけます",   // 可能形で主語が反転する誤文
  "撮影いただき", "撮影頂き", "撮影していただき",       // 撮影の主語はスタッフ
  "ご共有頂き", "ご共有いただき",                       // 業者間語（prompts で文書禁止済み）
  "ご案内いただいた", "ご案内頂いた",                   // 顧客送付物に「ご案内」
  "お部屋が見つかり次第", "見つかり次第ご連絡",          // prompts で文書禁止済み
  "ご査収いただきありがとう", "ご査収頂きありがとう",   // 未受領物への感謝
  "拝見させて頂", "拝見させていただ",                   // 二重謙譲
  "お伺いさせて頂", "お伺いさせていただ",
  "ご覧になられ",
  "審査させて頂き", "審査させていただき",                // 審査主体は管理会社（「審査を進めさせて」は BANNED_PATTERNS で warning 運用）
  "契約させて頂き", "契約させていただき",
  "のご案内をしております", "番手確認", "物確",          // 管理会社向け文体の混入
  "御見積もりをお願いできます", "お見積もりをお願いできます",
  // 2026-09-08 §5: プレースホルダ・システムマーカー・形式的了解句・誤用語彙・命令形の申込催促・撮影主語逆転
  "〇〇", "○○", "アカウント名", "<<<", ">>>", "[REPLY]", "【AIX-META",
  // 2026-09-12 竹内方針B: 「承りました」は禁止語から外した（目的語の無い形は normalizeBareUketamawari で置換、目的語の照合は UKETAMAWARI_OBJECT_UNANCHORED）
  "ご確認のほど", "確認中です", "確認して参ります",
  "TikTok映え", "インスタ映え", "共益費込", "緊急連絡先設定可", "緊急連絡先可",
  "申し込んでください", "急いでください", "他のお客様も見て", "申し込まないと",
  "撮影して頂け", "撮影していただけ", "ご撮影",
  // 2026-09-08 語彙タイミング: 主語逆転・未発生行為の完了形（どの state でも誤り）
  "審査いたします", "審査致します", "審査を行い",            // 審査主体は管理会社・保証会社
  "重要事項説明させて頂き", "重要事項説明させていただき",     // 宅建士行為・審査前には存在しない
  "交渉させて頂きましたので", "交渉済みですので",             // 交渉が履歴に無い完了形（履歴照合は E10 NEGOTIATED_DONE_BAN）
  "先ほどお送りした御見積書", "先程お送りした御見積書", "先ほどお送りしたお見積書",  // 未送付物の送済み表現（V9 と二重防御）
  "御見積書となります", "お見積書となります", "見積書を同封",   // AIX 送付カバー文（line_reply では書かない）
  "初期費用は家賃の", "家賃の2ヶ月分", "家賃の3ヶ月分",       // 物件未確定の金額断定
  // 2026-09-08 G7/G26/G30（Fable5）— どの文脈でも誤りの形のみ（AIX テンプレ正規文と同型の語は入れない。修正ループ guard でも自動的に効く）
  // 都合の持ち主逆転（V2 GOCHOUGO_REVERSED と二重防御）
  "ご都合よろしいお日にちをお伝え", "ご都合よろしいお日にちお伝え",
  "ご都合よろしいお日にちをお知らせさせて", "ご都合よろしいお日にちお知らせさせて", "ご都合のよい日をお伝えさせて",
  // 顧客の都合→スタッフ作業（V1 GOCHOUGO_STAFF_TASK と二重防御）
  "ご都合よろしいお日にちに撮影", "ご都合よろしいお日にちに確認", "ご都合よろしいお日にちにお送り", "ご都合よろしいお日にちに作成",
  // 内覧・ご案内・撮影の主語逆転
  "ご内覧させて頂け", "ご内覧させていただけ", "ご案内頂けます", "ご案内いただけます",
  "撮影頂け", "撮影して頂き", "撮影お願い", "撮影をお願い",
  // （旧:「〜次第すぐに」8語。2026-09-11 竹内方針5: HASTY_PROMISE（banned-phrasing の HASTY_ADVERB_RE）と10件すべて重複していたので削除）
  // プレースホルダ名の呼びかけ（"名無し" は既存。PLACEHOLDER_ADDRESS_DET_RE と二重防御）
  "権兵衛", "未設定さん", "未設定様", "ゲストさん", "ゲスト様",
];

// ─── 決定論チェック群（runFinalCheck / runDiffRecheck の両方で実行。LLM不要・約0ms）─────────
// 2026-09-08: 修正版に対する再検査欠落（THANK_OPENING等が recheck で見られない）と
// WE_DO_MISSING の LLM 依存（直近2ヶ月で発行0件）を解消するため共通関数化。
const WAIT_TPO_RE = /一時保留|感謝返し|短い了承|強推し直後|ネガ文脈|検討中フォロー|内覧キャンセル|成約後サポート/;
const BOILERPLATE_RE = /かしこまりました|はい|お世話になっております|お待たせ致しました|お待たせいたしました|夜遅くに失礼します|ご連絡遅くなり申し訳(?:御座|ござ)いません|よろしくお願い|宜しくお願い|何卒|全力でサポート|お気軽に[^。！!\n]{0,12}(ください|下さい)|ご満足(頂|いただ)け[^。！!\n]{0,20}|またご連絡|ご連絡お待ち|お待ちしております|引き続き|ありがとうございます|こちらこそ/g;
// A-11: 行動動詞に説明・対応・相談・調整・紹介・割引・進め・撮影・ご連絡・お聞き・伺 を追加（「ご説明させて頂きます」等が WE DO と認識されなかった）
// 2026-09-11 竹内方針1（E1-h）: 語彙の穴を塞ぐ（観測値を歪ませない）。「探させて頂きます」は旧「探さ」が「さ」を食って「させて」に一致しなかった。
//   「お申し込みをさせて」は「申込」にしか一致しなかった
const ACTION_DECL_RE = /(ピックアップ|お送り|送付|お調べ|お探し|探し|探(?=させ)|探さ(?!せ)|確認|ご案内|案内|作成|お作り|交渉|手配|お伝え|お申(?:し)?込(?:み)?|申(?:し)?込(?:み)?|抑え|押さえ|お取り|取り寄せ|お渡し|ご用意|ご提案|提案|ご説明|説明|対応|ご相談|相談|調整|お届け|ご紹介|紹介|割引|進め|撮影|ご連絡|お聞き|伺)[^\n。！!]{0,30}(させて(?:頂|いただ)き|いたし|致し|し)ます/;
// A-11: 裸の「お願い」が「よろしくお願いします」に一致していた（短い了承が GENERIC_ONLY_REPLY block になる）。依頼形のみに限定＋暗黙条件語を追加
const CUSTOMER_REQUEST_RE = /[?？]|お願い(?!(?:いた|致|し)ます|いたします|します)|お願いでき|お願いしたい|希望|したい|ですか|ますか|でしょうか|教えて|ください|もらえ|いただけ|頂け|条件|家賃|エリア|間取り|[0-9０-９]+万|狭い|広い|広め|欲しい|ほしい|必要|がいい|以上|以内|階/;
// 純粋な了承・感謝・締め挨拶のみのメッセージ（25字以内）。tpo 空でも WE DO を免除する
const PURE_ACK_RE = /^(?:ありがとう|有難う|よろしく|宜しく|お願い|了解|わかりました|分かりました|承知|こちらこそ|はい|OK|ok|オッケー|助かります|お世話|失礼|楽しみ|ございます|いたします|します|です|[\s！!。、〜ー😊😌🙇🙏✨🌟🏻♀♂‍️]|m\(_ _\)m)+$/u;
// 2026-09-11 統合設計（経路C）: 旧 EXPLANATORY_RE（語尾に「！!。」を要求＝「となります😊！！」の絵文字で不一致）は廃止。
//   「回答している」の判定は reply-context の hasDirectAnswer が唯一（① REPLY_SKELETON・⑦ WE_DO_MISSING_DET・質問セルの detect が同じ関数）
const ALLOWED_EMOJI = new Set(["😊", "😌", "🌟", "✨"]);
// 顧客の申込意思（申込宣言の前提。V14 の CUSTOMER_APPLY_INTENT_RE より厳密）
const CUSTOMER_APPLY_DECL_RE = /申(?:し)?込(?:み)?(?:たい|します|お願い|で(?:お願い|進め)|させて)|押さえ(?:て|たい)|抑え(?:て|たい)|決め(?:ます|たい|ました)|契約(?:したい|します)/;
// S-4: 生成側 isFirstEverReplyFromMsgs と同一のメディアのみ判定（画像・動画・スタンプのみのスタッフ送信は「返信済み」に数えない）
const MEDIA_ONLY_RE = /^\s*(?:\[(?:画像|動画|スタンプ|ファイル)\]\s*)+$/;
// S-4: 初回挨拶ブロック（「〇〇さん、はじめまして😊！！…鈴木と申します！！\n\n」）を開口語判定の前に剥がす
// G30（2026-09-08 Fable5）: 決定論挨拶（夜間接頭辞・お世話に・ご連絡遅くなり）も開口語判定の前に剥がす（resolveGreeting と同名）
// G32: お待たせ系は禁止語（① BANNED_WORD で block）だが、開口語判定の前に剥がす対象としては維持
const GREETING_BLOCK_RE = /^(?:夜遅くに失礼します[！!]*\s*)?(?:[^\n]{0,12}(?:さん|様)[、,\s]*)?(?:はじめまして|初めまして|この度はご連絡|この度ご連絡|お部屋探しを担当|お部屋探しご担当|お世話になっております|お待たせ(?:致|いた)?しました|ご連絡遅くなり申し訳)[^\n]*\n+/;

// ─── 2026-09-09 Fable5 往復文脈: ctx 解決（generate-reply 経路は同一オブジェクト、check-reply 経路は再計算）─────────
/** 2026-09-09 行動台帳: generate-reply 経路は同一オブジェクト、check-reply 経路は recentMessages から再計算（aix_usage_logs 無し・保守的）。ctx 単位で1回だけ計算 */
const ledgerCache = new WeakMap<FinalCheckContext, ActionLedger>();
function resolveLedger(ctx: FinalCheckContext): ActionLedger {
  if (ctx.ledger) return ctx.ledger;
  const cached = ledgerCache.get(ctx);
  if (cached) return cached;
  const built = buildActionLedger({
    recentAixRows: [],
    messages: (ctx.recentMessages ?? []).map((m) => ({ sender: m.sender, text: m.text, createdAt: m.createdAt, isAix: m.isAix })),
    lastCustomerAt: [...(ctx.recentMessages ?? [])].reverse().find((m) => m.sender === "customer")?.createdAt ?? null,
  });
  ledgerCache.set(ctx, built);
  return built;
}
/** 送付済み物件数の単一参照（台帳があれば台帳、無ければ route/check-reply の sentPropertiesCount、どちらも無ければ再計算） */
function sentCountOf(ctx: FinalCheckContext): number {
  if (ctx.ledger) return ctx.ledger.facts.propertiesSentCount;
  if (ctx.sentPropertiesCount !== undefined) return ctx.sentPropertiesCount;
  return resolveLedger(ctx).facts.propertiesSentCount;
}
function resolveReplyContext(ctx: FinalCheckContext): { sub: SubstanceVerdict; pair: PairContext; hedge: HedgeVerdict; ledger: ActionLedger } {
  const cust = ctx.lastCustomerMessage ?? "";
  const lastStaffMsg = [...(ctx.recentMessages ?? [])].reverse().find((m) => m.sender === "staff" && !MEDIA_ONLY_RE.test(m.text));
  const lastStaff = lastStaffMsg?.text ?? "";
  const ledger = resolveLedger(ctx);
  let sub = ctx.substance, pair = ctx.pairContext;
  if (!sub || !pair) {
    const staff = classifyLastStaffTurn(lastStaff, { ledger });
    sub = sub ?? analyzeSubstance(cust, undefined, { staffAskedQuestion: staff.kind === "question_to_customer" });
    // check-reply 経路は route.ts のフラグが無いので、条件フォーム（①〜⑧／【…】⇒）だけは同定義の isConditionFormMessage で condition_change に寄せる
    // 2026-09-10 Fable5 Sさん事例: 台帳（送付済み物件名・直前スタッフ発言）と顧客名は前向き反応の判定・
    //   {viewingOffer} リテラルの生成に必要なので check-reply 経路でも渡す（生成側と同じ verdict）
    // 2026-09-11 統合設計（経路D）: 直前スタッフ発言より前の顧客発言（断り→締め→お礼 の farewell 判定）も生成側と同じ入力で渡す
    const msgs = ctx.recentMessages ?? [];
    const lastStaffIdx = msgs.map((m) => m.sender).lastIndexOf("staff");
    const priorCustomerText = lastStaffIdx < 0 ? "" : [...msgs.slice(0, lastStaffIdx)].reverse().find((m) => m.sender === "customer")?.text ?? "";
    pair = pair ?? resolveTurnPair(staff, classifyCustomerResponse(sub, staff, { isConditionPresented: isConditionFormMessage(cust), ledger }), sub, lastStaff, { ledger, customerName: ctx.customerName ?? "", priorCustomerText });
  }
  // check-reply 経路（aix_usage_logs 無し）は過去形の直前スタッフ本文だけを探索証拠に採る（保守的＝forbid 寄り）
  const hedge = ctx.hedge ?? resolveHedgeAllowance({
    customerMessage: cust, substance: sub, staff: pair.staff, customer: pair.customer, lastStaffText: pair.lastStaffText,
    lastCustomerAt: [...(ctx.recentMessages ?? [])].reverse().find((m) => m.sender === "customer")?.createdAt ?? null,
    ledger,
  });
  return { sub, pair, hedge, ledger };
}
// ─── 2026-09-11 竹内方針1（統合設計 §2 方針1・§3.1）: 必須要素・骨格系は「観測専用」──────────────────
//   正解777件（下書き→送信576組）で PEM は「編集で解消」26件・「編集で発生」33件、REPLY_SKELETON 24/13、WE_DO 18/17、CONCERN 4/3、GENERIC 4/5。
//   スタッフの判断（編集・送信）と相関が無い＝block の根拠にならない。severity は常に info（tpo_debug の観測用に message/suggestion は残す）。
//   LLM 由来の同名コード（WE_DO_MISSING 等）も assignSeverity で info。修正ループには isRevisable で渡さない（V-1: info に下げるだけでは
//   他の block/warning と一緒に修正 LLM に渡り「要素を足す書き直し」が続いていた）
export const OBSERVE_ONLY_CODES: ReadonlySet<string> = new Set([
  "PAIR_ELEMENT_MISSING", "REPLY_SKELETON_MISSING", "CONCERN_UNADDRESSED", "WE_DO_MISSING_DET", "GENERIC_ONLY_REPLY", "WE_DO_MISSING",
]);
/** 表示はするが修正ループに渡さない warning（足す系・表示のみ。方針1/2） */
const DISPLAY_ONLY_CODES: ReadonlySet<string> = new Set(["CONDITION_ECHO_MISSING", "CLOSER_MISSING", "CELL_AVOID_CONFLICT", "UNCHECKED_AUTO_SEND"]);
/** 修正ループ（runGroundedRevision・差分再検査の対象）へ渡してよい指摘か。warning 経路・block 経路・差分再検査が同じ関数で絞る */
export function isRevisable(i: CheckIssue): boolean {
  if (i.severity === "info") return false;
  if (OBSERVE_ONLY_CODES.has(i.code) || DISPLAY_ONLY_CODES.has(i.code)) return false;
  if (i.code.startsWith("TYPO_")) return false; // 誤字は決定論の自動修正（applySurfaceFixes）だけで直す
  return true;
}
// 「文を足す」修正が正解の骨格系コード（修正ループの長さ上限・evidence 残存プリフィルタから除外する）
// 2026-09-09 Fable5: CLOSER_MISSING も「文を足す」修正（PREEMPTIVE_HEDGE 等の削除系は含めない）
// 2026-09-11 竹内方針1・2: 観測専用コードと CONDITION_ECHO_MISSING（表示のみ）は外す。block で残る足す系は EMPTY_CLOSER / SPLIT_ACK_REPLY だけ
export const SKELETON_CODES = new Set(["EMPTY_CLOSER", "SPLIT_ACK_REPLY", "CLOSER_MISSING"]);
/** 2026-09-09 行動台帳: 決定論置換（applyLedgerAutoFix）で直せるコード。block がこれだけなら Sonnet 修正を呼ばない */
export const LEDGER_FIX_CODES = new Set(["DONE_PRESUPPOSED_WITHOUT_EVIDENCE", "UNSENT_CLAIM", "PROMISE_ECHO_MISMATCH"]);
// 2026-09-11 統合設計（経路C）: 旧 ANSWER_RE は hasDirectAnswer（回答形）＋ PROPOSAL_FORM_RE（提案形）に置換
/** 文単位の「回答／提案」判定（② CONCERN_UNADDRESSED の対応文抽出にも使う） */
const isAnswerOrProposal = (s: string, qf: "request" | "info" | null | undefined): boolean =>
  hasDirectAnswer(s, qf ?? null).form === "answer" || PROPOSAL_FORM_RE.test(s);
const NO_DECL_TPO_RE = /一時保留|強推し直後/;
const CLOSED_TPO_RE = /成約後サポート|内覧キャンセル|顧客自身の断り|失注|ネガ文脈/;
const EMPTY_CLOSER_LINE_RE = /^(?:かしこまりました|承知(?:いた|致)?しました|了解(?:いた|致)?しました|承りました)[😊😌]*[！!。]*$/;
const TRAILING_BOILERPLATE_LINE_RE = /^(?:(?:何卒|引き続き)?(?:よろしく|宜しく)お願い(?:いた|致)?します|全力でサポート[^\n]*|お気軽に[^\n]{0,14}(?:ください|下さい)|ご満足(?:頂|いただ)け[^\n]*|お待ちしております)[😊😌]*[！!。]*$/;
const FEELING_SENTENCE_RE = /お気持ち|わかります|分かります|お察し/;
/** AIへの内部指示の地の文が本文に漏れた行（「コンロサイズの懸念を条件に変換して再ピックアップ宣言する場面です。」等） */
export const META_NARRATION_LINE_RE = /(?:^|\n)[^\n]{0,80}(?:する場面です|の場面です|場面になります|往復文脈|必須要素|行動台帳|WE ?DO宣言)[^\n]*/;
/** お客様の気持ち・懸念を代弁して同調する文（「〜気になりますよね」「ご心配ですよね」）。スタッフ実送信6,090通中3通 */
// 確認の質問（「ペットは飼われていないですよね？」）は対象外にするため疑問符が続くものは除く
export const SYMPATHY_ECHO_RE = /[^\n。！!？?]{0,30}(?:気になり|心配|不安|大変|困り|悩み|迷い|迷われ)[^\n。！!？?]{0,6}(?:ますよね|ですよね)(?![？?])[😊😌🙇]*[！!。]*/;
// 「お待ちしております」型の受け宣言（お送りお待ちしております 等）は WE DO 相当として認める
// 2026-09-11 竹内方針1（E1-h）: 「現地エントランスにてお待ちしております」（待ち合わせの受け宣言）も WE DO 相当
const RECEIVE_DECL_RE = /(?:お電話|ご連絡|お送り|物件|お返事|ご返答|ご来店|お越し|お写真|画像|現地|エントランス)[^\n。！!]{0,12}お待ち(?:して|いたして|致して|し)おります/;
const FEELING_TEMPLATE_PATTERNS: Array<{ re: RegExp; msg: string; sug: string; onlyIfNoAction?: boolean }> = [
  { re: /お気持ち[^\n。]{0,14}(?:わかり|分かり|お察し|理解|存じ)/, msg: "「お気持ち…わかります」型の共感文（成約・正解返信に出現0件）", sug: "共感文を削除し、懸念への事実回答＋懸念を条件に取り込んだ行動宣言に置き換える" },
  { re: /ごゆっくりご検討(?:ください|下さい)/, msg: "「ごゆっくりご検討ください」は命令形（正解は「ごゆっくりご検討頂けますと幸いです」＋次のステップ提示）", sug: "「ごゆっくりご検討頂けますと幸いです！！」に直し、直前送付物への次のステップと顧客予告を先取りして受ける宣言を1文入れる" },
  { re: /ごゆっくり(?:ご検討|ご確認|ご相談)[^\n]*/, msg: "「ごゆっくり〜」だけで行動宣言が無い", sug: "「お気に召されましたら〜」「お送り頂き次第募集状況確認し御見積書とあわせて〜」等を追加", onlyIfNoAction: true },
];

/** 選ばれたセルの必須要素のうち、本文に無いものの fix リテラルを修正案にする。
 *  2026-09-10 Fable5 Sさん事例: ruleId=null だと skelPair.rule が undefined → ハードコードのデフォルト文に
 *  フォールバックし、その文は「ピックアップしてお送りする」しか提示しなかった（内覧提案への道が塞がれる）。
 *  fix は要素ごとのリテラルであり example（別場面の実文）ではない。 */
/** 2026-09-11 統合設計（経路A）: PAIR_ELEMENT_MISSING の修正案の唯一の出所は要素の fix（型で必須）。
 *  example（別顧客の実文・固有名詞・日付）・rule.suggestion へのフォールバックは廃止。名前スロット・トークンは fillPairPlaceholders で実値化 */
export function pairElementSuggestion(m: PairMustInclude, pair: PairContext): string {
  return fillPairPlaceholders(m.fix, pair);
}
function pairFixSuggestion(pair: PairContext, text: string): string | null {
  const seen = new Set<string>();
  const out = (pair.rule?.mustInclude ?? [])
    .filter((m) => (!m.when || m.when(pair)) && !mustIncludeSatisfied(m, text, pair))
    .map((m) => pairElementSuggestion(m, pair))
    .filter((s) => { if (seen.has(s)) return false; seen.add(s); return true; });
  return out.length ? out.join("／") : null;
}

/** 2026-09-11 統合設計（経路D）: 締め・断りの場面か（① REPLY_SKELETON と ⑦ WE_DO_MISSING_DET / GENERIC_ONLY_REPLY と修正プロンプトが同じ関数）。
 *  締めでは「足す」系の指摘を出さず、代わりに「削る」系の CLOSING_FORWARD_PUSH（warning）を出す */
export function isClosedVerdict(pair: PairContext, tpo: string): boolean {
  return (pair.closing?.kind ?? null) !== null || pair.customer.kind === "decline" || CLOSED_TPO_RE.test(tpo);
}

/** 2026-09-09 Fable5: 返信骨格チェック（受け止め→回答/代替→行動宣言→締め）。生成側 buildTurnPairNote / PAIR_MATRIX と同名 */
function runSkeletonChecks(text: string, ctx: FinalCheckContext): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const tpo = ctx.tpoLabel ?? "";
  const { sub, pair, ledger } = resolveReplyContext(ctx);
  const pairHint = `【往復文脈】${pair.summary}。`;
  // 2026-09-09 行動台帳: suggestion の「再度」は送付実績がある時だけ（検査側 suggestion が禁止語の供給源にならないように。生成側 {redo} と同じ関数）
  const redo = redoWord(ledger);
  const head = text.trim().slice(0, 30); // evidence は必ず返信本文由来（顧客文を evidence にすると修正ループが回らない）
  const weDoBase = stripUnbackedConfirmPromise(text, getConfirmVerdict(ctx));
  const residue = weDoBase.replace(BOILERPLATE_RE, "");
  const hasAction = ACTION_DECL_RE.test(residue) || RECEIVE_DECL_RE.test(weDoBase);
  const sentences = weDoBase.split(/(?<=[。！!\n])/).map((s) => s.trim()).filter(Boolean);
  // 2026-09-11 統合設計（経路C）: 回答判定は hasDirectAnswer（依頼形の質問なら行動宣言も回答）＋提案形
  const qf = pair.customer.questionForm ?? null;
  const joinedForAnswer = sentences.filter((s) => !FEELING_SENTENCE_RE.test(s)).join("\n");
  const hasAnswer = hasDirectAnswer(joinedForAnswer, qf).yes || PROPOSAL_FORM_RE.test(joinedForAnswer);
  // 2026-09-11 統合設計（経路D）: 締め verdict（① と ⑦ で共有）
  const isClosed = isClosedVerdict(pair, tpo);

  // ① REPLY_SKELETON_MISSING — 実質があるのに「回答／提案」も「行動宣言」も無い
  //   2026-09-11 竹内方針1: 観測専用（info）。スタッフの実文と相関が無い（編集で解消24／発生13）
  if (!sub.isAckOnly && !isClosed && !hasAction && !hasAnswer) {
    issues.push({ pass: "context_check", severity: "info", code: "REPLY_SKELETON_MISSING",
      message: `顧客メッセージに${sub.kinds.join("・") || "実質的な内容"}があるのに、返信に「回答／提案」も「次に何をするかの行動宣言」もありません（受け止め・了承・共感のみ）。${pairHint}`,
      evidence: head,
      // 2026-09-11 統合設計（経路A/B）: 〇〇／△△ を含むリテラルを出さない（セルの fix を最優先）
      suggestion: pairFixSuggestion(pair, text) ?? (sub.concerns.length
        ? `懸念（${sub.concerns.map((c) => c.label).join("・")}）に事実で答え、「${sub.concerns.map((c) => c.fix).join("、")}${redo}ピックアップしてお送りさせて頂きます」の形で1文宣言する`
        : sub.kinds.includes("schedule")
          ? "顧客が予告した行動（後日送る・相談する）を先取りして受ける宣言（「お送り頂き次第募集状況確認し御見積書とあわせてご連絡させて頂きます」）＋直前送付物への次のステップを1文ずつ入れる"
          : "顧客メッセージの固有名詞（エリア・物件名・条件・日付）をそのままの語で復唱し、次の一手を1文だけ宣言する") });
  }

  // ② CONCERN_UNADDRESSED — 懸念語に対応する語が「回答文 or 行動宣言文」に無い（共感文でのオウム返しは対応に数えない）
  //   2026-09-11 竹内方針1: 観測専用（info）。場面が条件変更（condition_change＝条件フォーム・条件の宣言）の時は出さない
  //   （条件フォームの①〜⑧を懸念と誤認した偽陽性が 26/45。場面の判定が「出さない」を決める）
  if (sub.concerns.length > 0 && !isClosed && pair.customer.kind !== "condition_change") {
    const addressed = sentences.filter((s) => ACTION_DECL_RE.test(s) || RECEIVE_DECL_RE.test(s) || isAnswerOrProposal(s, qf)).join("\n");
    const unaddressed = sub.concerns.filter((c) => !c.replyRe.test(addressed));
    if (unaddressed.length > 0) {
      issues.push({ pass: "context_check", severity: "info", code: "CONCERN_UNADDRESSED",
        message: `顧客の懸念「${unaddressed.map((c) => `${c.label}（${c.phrase}）`).join("、")}」に対する回答・代替案・別候補の宣言が返信にありません。${pairHint}`,
        evidence: head,
        suggestion: unaddressed.map((c) => `「${c.fix}${redo}ピックアップしてお送りさせて頂きます」`).join("／") });
    }
  }

  // ③ EMPTY_CLOSER — 「かしこまりました！！」等で終わり、かつ行動宣言が無い
  {
    const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
    while (lines.length > 1 && TRAILING_BOILERPLATE_LINE_RE.test(lines[lines.length - 1])) lines.pop();
    const last = lines[lines.length - 1] ?? "";
    if (EMPTY_CLOSER_LINE_RE.test(last) && !hasAction) {
      issues.push({ pass: "context_check", severity: "block", code: "EMPTY_CLOSER",
        message: `返信が「${last}」で終わっており、その後に次の行動宣言がありません（正解返信で「かしこまりました」終わりは0件）。${pairHint}`,
        evidence: last,
        // 2026-09-10 Fable5 Sさん事例: 選ばれたセルの fix リテラルを最優先（汎用文言はピックアップ以外の道を塞ぐ）
        suggestion: pairFixSuggestion(pair, text)
          ?? "了解句の直後に、顧客の懸念・予定・条件をそのままの語で復唱した一人称の行動宣言を1文足す" });
    }
  }

  // ④ PAIR_ELEMENT_MISSING — 行列セルの必須要素（when で場面に無い要素は評価しない）
  //   2026-09-11 統合設計（経路A）: 修正案は要素の fix だけ（example＝別顧客の実文へのフォールバックは廃止）。同一修正案は1回だけ出す
  //   2026-09-11 竹内方針1: 実際のスタッフの返信を優先する。m.severity・precedence に関係なく常に info（観測専用・書き直しを強制しない）。
  //   正解777件で PEM は「編集で解消」26件・「編集で発生」33件＝スタッフの判断と相関なし。後処理ゲートの安全弁は cellElementGaps（severity 非依存）が担う
  const seenPairSug = new Set<string>();
  for (const m of pair.rule?.mustInclude ?? []) {
    if (m.when && !m.when(pair)) continue;
    if (!mustIncludeSatisfied(m, text, pair)) {
      const sug = pairElementSuggestion(m, pair);
      const dupSug = seenPairSug.has(sug);
      seenPairSug.add(sug);
      issues.push({ pass: "context_check", severity: "info", code: "PAIR_ELEMENT_MISSING",
        message: `往復文脈（${STAFF_KIND_JA[pair.staff.kind]}→${CUSTOMER_KIND_JA[pair.customer.kind]}）の必須要素「${fillPairPlaceholders(m.label, pair)}」がありません`,
        evidence: head, suggestion: dupSug ? "（上と同じ修正で満たされる）" : sug });
    }
  }

  // ④' 2026-09-11 統合設計（経路D・うえっち事例）: CLOSING_FORWARD_PUSH — 締め・断りの場面での前進提案は「削る」指示だけにする
  //    （成約の締め返信 5/5 件に具体的な行動宣言なし。足す系の指摘は isClosed で出さない＝逆向きの指示が同時に出ない）
  if (isClosed) {
    const push = sentences.find((s) => NEW_PICKUP_DECL_RE.test(s) || VIEWING_OFFER_SOFT_RE.test(s) || /(?:御|お)?見積書?[^\n]{0,20}(?:作成|お送り)|お申込/.test(s) ||
      /ピックアップ[^\n。！!]{0,24}(?:させて(?:頂|いただ)き|いたし|致し)ます/.test(s));
    if (push) issues.push({ pass: "context_check", severity: "warning", code: "CLOSING_FORWARD_PUSH",
      message: `締め・断りの場面で前進提案が入っています（成約の締め返信 5/5 件に具体的な行動宣言なし）。${pairHint}`,
      evidence: push.slice(0, 40), suggestion: "この文を削除する（文を足さない）" });
  }

  // ⑤ SPLIT_ACK_REPLY — 「はい😊！！…かしこまりました！！」の分割相槌
  {
    const residueLen = residue.replace(/[\s！!。、😊😌🌟✨]/g, "").length;
    if (/^はい[😊😌]*[！!]/.test(text.replace(GREETING_BLOCK_RE, "").trimStart()) && /かしこまりました[😊😌]*[！!]*\s*$/.test(text.trim()) && residueLen < 40) {
      issues.push({ pass: "context_check", severity: "block", code: "SPLIT_ACK_REPLY",
        message: "「はい😊！！」で始まり「かしこまりました！！」で終わる分割相槌型（各通に個別に返事しているだけで中身がない）", evidence: head,
        suggestion: "開口語は1つにし、受け止め→回答/対処→対象付き行動宣言→締めの1つの流れに書き直す" });
    }
  }

  // ⑥-0 SYMPATHY_ECHO（block）— 気持ちの代弁・同調文。共感語を禁止した結果の言い換え（「〜気になりますよね」）もここで止める
  {
    const echo = text.match(SYMPATHY_ECHO_RE);
    if (echo) issues.push({ pass: "rule_check", severity: "block", code: "SYMPATHY_ECHO",
      message: "お客様の気持ちを代弁・同調する文です（スタッフ実送信6,090通中3通・共感語は正解返信で0件）",
      evidence: echo[0].trim(), suggestion: "この1文を削除する（代わりの文は足さない。懸念は条件に取り込んだ行動宣言で応える）" });
  }
  // ⑥ FEELING_TEMPLATE（warning）— 共感テンプレ・命令形の検討促し・「はい😊！！」開始
  for (const p of FEELING_TEMPLATE_PATTERNS) {
    if (p.onlyIfNoAction && (hasAction || hasAnswer || (pair.rule?.precedence === "after_wait" && pair.customer.kind === "thinking"))) continue;
    const m = text.match(p.re);
    if (m) issues.push({ pass: "rule_check", severity: "warning", code: "FEELING_TEMPLATE", message: p.msg, evidence: m[0], suggestion: p.sug });
  }
  {
    const body = text.replace(GREETING_BLOCK_RE, "").trimStart();
    // 「はい」は受諾・Yes/No回答の開口語。懸念・条件変更に「はい」で入り、かつ回答文が無い場合のみ警告（成約実例「はい！！こちらの2物件は礼金が〜」は回答ありなので可）
    const concernLike = pair.customer.kind === "concern" || pair.customer.kind === "condition_change";
    if (/^はい[😊😌]*[！!]/.test(body) && concernLike && !hasAnswer && sub.has) {
      issues.push({ pass: "rule_check", severity: "warning", code: "FEELING_TEMPLATE",
        message: `「はい😊！！」開始ですが、顧客は懸念・条件を送っています（「はい」は受諾・Yes/No回答の開口語。正解返信では4%）。${pairHint}`,
        evidence: body.slice(0, 8), suggestion: `「${ctx.customerName ? `${ctx.customerName}さん` : ""}お世話になっております！！」または受け止め1文から始める` });
    }
  }

  // ⑦ 2026-09-10 Fable5 Sさん事例: VIEWING_DATE_ASK_WITHOUT_AIX —
  //    [X]型「ご都合よろしいお日にち御座いますでしょうか」は候補日時を提示した直後に置く
  //    AIX【内覧日調整】専用の確認疑問文（n=51 のうち 96% が具体日時とセット・47/51 が aix=viewing_invite）。
  //    [Y]型「よろしければ〜ご案内させて頂きます」（n=443・条件節あり 414）は通常返信で可＝置換先。
  {
    const m = text.match(VIEWING_DATE_ASK_RE);
    const hasConcreteDate = /[0-9０-９]{1,2}[\/／月][0-9０-９]{1,2}|[0-9０-９]{1,2}[:：時]|[月火水木金土日]曜|本日|明日|明後日/.test(text);
    const viewingAixDone = ledger.facts.viewingInvited || ledger.facts.meetingPlaceSent || pair.staff.kind === "viewing_invite";
    if (m && !hasConcreteDate && !viewingAixDone && !ctx.isDeliverableReply) {
      issues.push({ pass: "context_check", severity: "block", code: "VIEWING_DATE_ASK_WITHOUT_AIX",
        message: `「${m[0]}」は候補日時を提示した直後に置く AIX【内覧日調整】専用の文型です（正解51件中49件が具体日時とセット）。本文に候補日時が無く、内覧打診の実績も台帳にありません。${pairHint}`,
        evidence: m[0],
        suggestion: `「${viewingOfferLiteral(pair.customerName || ctx.customerName || "", pair.namedProperty.matchedSent, pair.namedProperty.count)}」の宣言形に置き換える（候補日時の提示は AIX【内覧日調整】専用）` });
    }
  }

  // ⑧ 2026-09-10 Fable5 Sさん事例: VIEWING_OFFER_NAME_ECHO —
  //    内覧のご案内は物件非依存のアクション。成約データの物件名復唱率は 61%/39% で、
  //    内覧提案の文では非復唱（「お部屋」で受ける）が正解側。同一行に物件名を復唱していたら warning。
  {
    const nm = pair.namedProperty.asWritten;
    if (nm && pair.customer.kind === "positive") {
      const line = text.split("\n").find((l) => VIEWING_OFFER_SOFT_RE.test(l) && l.includes(nm));
      if (line) {
        issues.push({ pass: "context_check", severity: "warning", code: "VIEWING_OFFER_NAME_ECHO",
          message: `内覧のご案内提案の文に物件名「${nm}」を復唱しています。内覧は物件非依存のアクションなので「お部屋」で受けます。${pairHint}`,
          evidence: line.slice(0, 60),
          suggestion: `「${nm}」を削り「${viewingOfferLiteral(pair.customerName || ctx.customerName || "", pair.namedProperty.matchedSent, pair.namedProperty.count)}」にする（物件名の復唱は見積作成・募集状況確認・申込の時だけ）` });
      }
    }
  }
  return issues;
}

// ─── 2026-09-10 Fable5 みく事例: 余計な行動宣言（UNPROMPTED_PROPOSAL）・セル衝突（CELL_AVOID_CONFLICT）・
//     顧客も DB も書いていない条件語の復唱（ECHO_FROM_BRAIN_NOT_CUSTOMER・shadow） ───

/** 新規の探索・提案宣言（実行済み含意語つき／なし の両方） */
const NEW_PICKUP_DECL_RE = new RegExp(
  `(?:中心に|条件に合|優先して|新たに|改めて|再度|別(?:の|物件))[^\\n。！!]{0,30}(?:お調べ|ピックアップ|お探し|探さ)[^\\n。！!]{0,20}(?:させて(?:頂|いただ)き|いたし|致し)ます` +
  `|(?:オススメ|おすすめ|お勧め)(?:できる|出来る)[^\\n。！!]{0,16}(?:お部屋|物件)[^\\n。！!]{0,24}(?:お調べ|ピックアップ|お探し)[^\\n。！!]{0,16}(?:させて(?:頂|いただ)き|いたし|致し)ます`
);

/** 2026-09-10 Fable5 みく事例:
 *  顧客が条件・要望・懸念を1文字も書いていない（residue="" ＝ isPureBoilerplate）のに、
 *  返信が新規の探索・提案を宣言している。決定論チェック12系統に「余計な行動宣言」を見る項目が
 *  1つも無かった（REPLY_SKELETON_MISSING は「足りない」方向専用）。修正は削除のみ。
 *  データ根拠: 顧客メッセージが実質ゼロの生成 473件のうち通常返信 209件。そのうち「再ピックアップ宣言／条件復唱」は 3件で、
 *  3件とも人が全面書き換え・そのまま送信 0件。逆方向（residue 空なのに新規提案が正解）は 0件 ＝削除のみで直る。 */
export function runProposalChecks(text: string, ctx: FinalCheckContext): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const { sub, pair } = resolveReplyContext(ctx);
  if (!sub.isPureBoilerplate) return issues;                       // 顧客が実質を書いている＝提案は文脈内
  const waitSaid = ctx.brainStrategy?.engagement_stance === "wait";
  const avoidSaid = (ctx.brainStrategy?.avoid_topics ?? []).some((t) => /新規.{0,6}ピックアップ|再ピックアップ|別物件|物件提案/.test(t));
  for (const s of text.split(/(?<=[。！!\n])/).map((x) => x.trim()).filter(Boolean)) {
    if (!NEW_PICKUP_DECL_RE.test(s)) continue;
    // 免除①: 選ばれたセルがまさにこの文を要求している／免除②: 未履行約束の復唱
    //   2026-09-11 統合設計: isCellRequiredSentence（後処理ゲートの protect・DOUBLE_DECLARATION フィルタと同じ関数）
    if (isCellRequiredSentence(s, pair)) continue;
    issues.push({
      pass: "context_check", severity: waitSaid || avoidSaid ? "block" : "warning",
      code: "UNPROMPTED_PROPOSAL",
      message: `お客様のメッセージは定型（お礼・待ち句）のみで、条件・要望・懸念が1文字もありません（residue=""）。それなのに新規の探索・提案を宣言しています` +
        `${waitSaid ? "（brain: engagement_stance=wait ＝今は待つ局面）" : ""}${avoidSaid ? "（brain: avoid_topics に新規物件ピックアップ）" : ""}`,
      evidence: s.slice(0, 60),
      suggestion: "この1文を削除する（足すべき文は無い）。受け止め1文＋扉を開ける1文で完結させる",
    });
  }
  return issues;
}

/** セル必須要素 × brain 方針の正面衝突（warning・診断専用。修正ループ対象外） */
export function runCellConflictChecks(_text: string, ctx: FinalCheckContext): CheckIssue[] {
  const conflicts = ctx.cellConflicts ?? ctx.pairContext?.conflicts ?? [];
  return conflicts.map((c) => ({
    pass: "context_check" as const, severity: "warning" as const, code: "CELL_AVOID_CONFLICT",
    message: c.message,
    evidence: `${c.ruleId}／${c.element}`,          // evidence は本文由来でなくてよい（修正対象ではなく診断）
    suggestion: "この返信を直すのではなく、セル選択（往復ペアの customer.kind）が正しいかを tpo_debug で確認する。brain の方針と必須要素が正面衝突している時は、たいていセル選択の方が誤っている",
  }));
}

/** 顧客が一度も書いておらず、DB 条件（property_search_params）にも無い条件語の復唱。
 *  2026-09-10 Fable5: 母数不足（turnPair 経路のログ 22〜24件・該当生成 3件）のため shadow（tpo_debug 記録のみ）で開始。
 *  2週間の発火率と「その語を人が削除したか」を SQL で見てから warning 昇格を判断する。 */
export const UNANCHORED_CONDITION_MODE: "shadow" | "warning" =
  (process.env.UNANCHORED_CONDITION_MODE as "shadow" | "warning") ?? "shadow";

const CONDITION_ECHO_WORDS = ["築浅", "広め", "初期費用", "駅近", "1階", "エレベーター", "南向き", "オートロック", "独立洗面", "駐車場", "ペット", "角部屋", "バストイレ別"];

export function findUnanchoredConditionEchoes(reply: string, customerAllText: string, dbConditions: string): string[] {
  const src = `${customerAllText}\n${dbConditions}`;
  return CONDITION_ECHO_WORDS.filter((w) => reply.includes(w) && !src.includes(w));
}

export function runUnanchoredConditionChecks(text: string, ctx: FinalCheckContext): CheckIssue[] {
  const hits = findUnanchoredConditionEchoes(
    text,
    [ctx.lastCustomerMessage ?? "", ...(ctx.recentMessages ?? []).filter((m) => m.sender === "customer").map((m) => m.text)].join("\n"),
    ctx.customerConditionsDb ?? "",
  );
  if (hits.length === 0 || UNANCHORED_CONDITION_MODE === "shadow") return [];
  return [{ pass: "rule_check", severity: "warning", code: "ECHO_FROM_BRAIN_NOT_CUSTOMER",
    message: `お客様も DB 条件も書いていない条件語「${hits.join("・")}」を復唱しています（brain の会話全体の論点から持ち込まれた可能性）`,
    evidence: hits[0], suggestion: `「${hits.join("・")}」を削除する（お客様が書いた語だけを復唱する）` }];
}

export function runDeterministicChecks(text: string, ctx: FinalCheckContext): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const tpo = ctx.tpoLabel ?? "";

  // ① 禁止語彙（G32: お待たせ系は削除案を decision 付きで出す）
  const BANNED_WORD_SUGGESTION: Record<string, string> = {
    "お待たせ致しました": "この文節を削除。挨拶行は【⏰ 挨拶ルール】の決定（当日未挨拶→「〇〇さんお世話になっております！！」／当日挨拶済み→なし）、開口語は顧客メッセージの意味（依頼・条件→「かしこまりました！！」／了承→「はい😊！！」／結果報告→本題・名前行）に従う",
  };
  BANNED_WORD_SUGGESTION["お待たせいたしました"] = BANNED_WORD_SUGGESTION["お待たせ致しました"];
  BANNED_WORD_SUGGESTION["お待たせしました"] = BANNED_WORD_SUGGESTION["お待たせ致しました"];
  // 2026-09-11 竹内方針4（E4-g）: 承知系は「削除」ではなく「かしこまりました」に置換（既定の「削除してください」は文中の承知で文を壊す）
  for (const w of ["承知いたしました", "承知しました", "承知致しました"])
    BANNED_WORD_SUGGESTION[w] = "「かしこまりました」に置換（文中の「〜とのこと、承知いたしました」も「〜の件かしこまりました」）";
  // 2026-09-11 統合設計（M8）: PS_POSITIVE の fix「ご査収頂きありがとうございます」は資料送付×顧客が見た証拠（materials.thanksAllowed）の時だけ
  //   正解（成約 45 件）。同じ verdict の時は BANNED_WORD「ご査収頂きありがとう」を免除する（生成の必須要素と検査の禁止語の正面衝突を解消）
  const thanksAllowed = /ご査収(?:頂|いただ)きありがとう/.test(text) && !!ctx.lastCustomerMessage && resolveReplyContext(ctx).pair.materials.thanksAllowed;
  for (const word of BANNED_WORDS_DETERMINISTIC) {
    if (thanksAllowed && /ご査収(?:頂|いただ)きありがとう/.test(word)) continue;
    if (text.includes(word)) {
      issues.push({ pass: "rule_check", severity: "block", code: "BANNED_WORD", message: `禁止語彙「${word}」が含まれています`, evidence: word, suggestion: BANNED_WORD_SUGGESTION[word] ?? `「${word}」を削除してください` });
    }
  }

  // ② 18時以降 or 土日の「本日中に」（顧客への依頼文「本日中にご返信頂けますと」は除外）
  //   A-11: 依頼文で break していたため後続の同日約束語が検査されなかった → continue に修正
  for (const sameDayPhrase of ["本日中に", "今日中に", "今日のうちに", "本日のうちに"]) {
    const idx = text.indexOf(sameDayPhrase);
    if (idx === -1) continue;
    const after = text.slice(idx + sameDayPhrase.length, idx + sameDayPhrase.length + 20);
    if (/頂けます|いただけます|ください|お願い/.test(after)) continue;
    const { hour: jstHour, dow: jstDay } = jstParts(ctx.now ?? Date.now());
    const isWeekend = jstDay === 0 || jstDay === 6;
    if (jstHour >= 18 || isWeekend) {
      issues.push({
        pass: "context_check",
        severity: ctx.isAutoSend ? "block" : "warning",
        code: "TIME_INVALID_HONIJITSU",
        message: `${isWeekend ? "土日" : "18時以降"}のため「${sameDayPhrase}」は実行不可能な約束です`,
        evidence: text.slice(Math.max(0, idx - 10), Math.min(text.length, idx + sameDayPhrase.length + 10)),
        suggestion: isWeekend ? "「週明け一番にご連絡させて頂きます」等に変更してください" : "「明日一番にご連絡させて頂きます」等に変更してください",
      });
    }
    break;
  }

  // S-4: 初回返信（生成側が挨拶ブロックを強制挿入する）では開口語チェックを免除。
  //      2回目以降は挨拶ブロック→名前行（「お客様」は名前ではない）→絵文字 の順に剥がしてから先頭を判定する
  const isFirstReply = !!ctx.isEarlyConversation;
  const openingHead = (() => {
    const s = text.trimStart()
      .replace(GREETING_BLOCK_RE, "")
      .replace(/^(?![^\n]{0,12}お客様)[^\n]{0,12}(?:さん|様)[、,！!\s]*/, "")
      .replace(/^[\s！!、。😊😌🙇✨🌟]+/, "");
    return s;
  })();
  // TPO 連動の開口語修正案（CONDITION_OPENING と矛盾する修正案を出さない）
  const openingSuggestion = /条件提示|内覧キャンセル|顧客自身の断り/.test(tpo) ? "冒頭を「かしこまりました！！」に変更"
    : /感謝|了承|保留|検討中|強推し/.test(tpo) ? "冒頭を「はい😊！！」に変更"
    : "冒頭を「お世話になっております！！」に変更";

  // ③ NG③違反: 「ありがとうございます」書き出し（名前行・絵文字を剥がしてから判定。感謝返しTPO・初回返信は除外）
  if (!isFirstReply && !/感謝返し|強推し直後/.test(tpo)) {
    const head = openingHead.slice(0, 30);
    const thankRe = /^(?:(?:ご(?:連絡|返信|回答|返答|確認|質問|要望)|お忙しい中|早速の?(?:ご)?返信|お写真)[^\n]{0,12}?)?(?:ありがとう|有難う|有り難う)(?:ございます|御座います)/;
    if (thankRe.test(head) && !/(頂き|いただき)/.test(head.slice(0, head.search(/ありがとう|有難う|有り難う/) + 1))) {
      issues.push({
        pass: "rule_check", severity: "warning", code: "THANK_OPENING",
        message: "返信が「ありがとうございます」で始まっています（NG③違反）。「お世話になっております！！」「はい😊！！」「かしこまりました！！」等から始めてください",
        evidence: text.trimStart().slice(0, 20),
        suggestion: openingSuggestion,
      });
    }
  }

  // ⑦ G32（2026-09-09 Fable5）: 冒頭の対称検査。generate-reply（toGreetingLite）／check-reply（tpo_debug.greeting 復元 or 再計算）が渡す
  //    GreetingDecisionLite を唯一の正とする。旧 ctx（greetingKind/expectedOpening）は normalizeGreetingLite で吸収。
  //    「お待たせ」の可否は ① BANNED_WORD が block 済み（時間根拠は廃止）。ここでは挨拶行と開口語の一致だけを見る
  const gdl: GreetingDecisionLite | null = ctx.greetingDecision
    ?? (ctx.greetingKind ? normalizeGreetingLite({ kind: ctx.greetingKind, opening: ctx.expectedOpening ?? "" }) : null);
  if (gdl && !isFirstReply && gdl.kind !== "first") {
    const headRaw = text.trimStart();
    const head = headRaw.slice(0, 80);
    const expected = gdl.openingLine.trim();
    const hasLateApology = /ご連絡遅くなり申し訳/.test(head);
    const hasStandard = /お世話になっております|いつもありがとうございます/.test(head);
    const hasNight = /夜(?:分)?遅くに失礼/.test(head);
    const expectsNight = !!gdl.nightPrefix;
    // 7-a 確定挨拶行（late_apology／夜間接頭辞）で始まっていない
    if ((gdl.kind === "late_apology" || expectsNight) && expected && !headRaw.startsWith(expected)) {
      issues.push({ pass: "rule_check", severity: ctx.isAutoSend ? "block" : "warning", code: "OPENING_GREETING_MISMATCH",
        message: `冒頭は「${expected}」で始める決定です（${gdl.kind}: ${gdl.reason}）が、本文の冒頭が異なります`,
        evidence: head.slice(0, 30), suggestion: `先頭行を「${expected}」に置き換える（その後に改行して本文）` });
    }
    // 7-b 進捗催促（late_apology）以外で謝罪行から始めている（催促の実質が無い謝罪は禁止: PHASE_COMMON_FORMAT）
    if (hasLateApology && gdl.kind !== "late_apology") {
      issues.push({ pass: "rule_check", severity: "warning", code: "OPENING_GREETING_UNEXPECTED",
        message: "お客様は結果を催促していないのに「ご連絡遅くなり申し訳御座いません」で始めています",
        evidence: head.slice(0, 30), suggestion: gdl.kind === "standard" ? `「${expected}」に変更` : "謝罪行を削除し開口語または本題から始める" });
    }
    // 7-c 当日挨拶済み（none）なのに定型挨拶行
    if (gdl.kind === "none" && hasStandard) {
      issues.push({ pass: "rule_check", severity: "warning", code: "OPENING_GREETING_UNEXPECTED",
        message: "本日の会話で冒頭挨拶は既に使用済みなのに定型挨拶で始めています",
        evidence: head.slice(0, 30), suggestion: `挨拶行を削除し ${gdl.opener === "none" ? "本題" : OPENER_JA[gdl.opener]} から始める` });
    }
    // 7-d 夜間挨拶はお客様への返信に入れない（2026-09-12 竹内。後処理 banned-phrasing.stripNightGreeting で除去済みのはず）
    if (hasNight) {
      issues.push({ pass: "rule_check", severity: ctx.isAutoSend ? "block" : "warning", code: "OPENING_GREETING_UNEXPECTED",
        message: "お客様への返信に「夜遅くに／夜分遅くに失礼」は入れません",
        evidence: head.slice(0, 30), suggestion: "夜間挨拶の一文を削除" });
    }
    void expectsNight; void NIGHT_PREFIX;
    // 7-e 開口語（挨拶行・名前行を剥がした先頭）が decision の許容集合の外（enforceOpener と同名。無い場合は指摘しない＝足さない）
    const op = detectOpener(openingHead);
    if (op && !gdl.openerAllowed.includes(op.opener)) {
      issues.push({ pass: "rule_check", severity: "warning", code: "OPENER_MISMATCH",
        message: `開口語「${op.match.trim()}」はこの場面の許容（${gdl.openerAllowed.map((k) => OPENER_JA[k]).join("／")}）にありません（${gdl.openerReason}）`,
        evidence: openingHead.slice(0, 20), suggestion: gdl.opener === "none" ? "開口語を削除して本題から始める" : `開口語を ${OPENER_JA[gdl.opener]} に変更` });
    }
  }

  // ③' 開口語の決定論チェック（場面ラベルごとに開口語を1択に固定。修正版 recheck でも同一関数で走る。初回返信は免除）
  if (!isFirstReply) {
    const head = openingHead.slice(0, 12);
    if (/感謝返し|短い了承|強推し直後|一時保留|検討中フォロー/.test(tpo) && !/^はい/.test(head)) {
      issues.push({ pass: "rule_check", severity: "warning", code: "GRATITUDE_OPENING", message: "感謝・了承・保留の場面の開口語は「はい😊！！」一択です（「かしこまりました」「承知いたしました」「ありがとうございます」で始めない）", evidence: text.trimStart().slice(0, 20), suggestion: "冒頭を「はい😊！！」（単独行）に変更" });
    }
    if (/条件提示|内覧キャンセル|顧客自身の断り/.test(tpo) && !/^かしこまりました/.test(head)) {
      issues.push({ pass: "rule_check", severity: "warning", code: "CONDITION_OPENING", message: "条件提示・断り受け止めの場面の開口語は「かしこまりました！！」一択です", evidence: text.trimStart().slice(0, 20), suggestion: "冒頭を「かしこまりました！！」（単独行）に変更" });
    }
  }

  // ③''-0 G30（2026-09-08 Fable5）: プレースホルダ名の派生形（「名無しの権兵衛さん」「ゲスト01さん」）の呼びかけは block。
  //   ctx.customerName 自体がプレースホルダ派生なら空名扱いにして checkNameConsistency の基準名にしない（UI の || "名無し" デフォルト対策）
  {
    const m = text.match(PLACEHOLDER_ADDRESS_DET_RE);
    if (m) issues.push({ pass: "rule_check", severity: "block", code: "NAME_PLACEHOLDER",
      message: `プレースホルダ名の呼びかけ「${m[0]}」が含まれています（顧客名不明時は呼びかけを省略する）`,
      evidence: m[0], suggestion: `「${m[0]}」と直後の助詞を削除し、名前なしで書く` });
    if (ctx.customerName && PLACEHOLDER_NAME_CORE_RE.test(ctx.customerName)) {
      console.warn("[final-check] customerName がプレースホルダ派生のため空扱い:", ctx.customerName);
      ctx = { ...ctx, customerName: "" };
    }
  }

  // ③'' S-5: 顧客名の一貫性（プレースホルダ／別名混在／フルネーム＋様／回数超過）— 初回・recheck・check-reply・後処理後で同一関数
  for (const n of checkNameConsistency(text, ctx.customerName ?? "", { isAutoSend: ctx.isAutoSend, allowNames: ctx.allowNames, aliases: ctx.nameAliases })) {
    issues.push({ pass: "rule_check", severity: n.severity, code: n.code, message: n.message, evidence: n.evidence, suggestion: n.suggestion });
  }

  // ④ 「！！」過剰（A-11: 5回以上は無条件 warning・7回以上かつ自動送信は block）
  const exclamCount = (text.match(/！！/g) ?? []).length;
  if (exclamCount >= 5) {
    issues.push({ pass: "rule_check", severity: exclamCount >= 7 && ctx.isAutoSend ? "block" : "warning", code: "EXCLAMATION_OVERUSE", message: `「！！」が${exclamCount}回使用されています（${text.length}字に対して過剰。上限3回）`, evidence: `「！！」×${exclamCount}回`, suggestion: "「！！」を「！」に変えるか文を短縮してください（「！！」は1返信3回以内）" });
  }

  // ⑤ NG確定物件の言及（決定論・block）
  for (const p of ctx.ngProperties ?? []) {
    const core = p.replace(/\s*\[.*?\]\s*$/, "").trim();
    if (core.length >= 2 && text.includes(core)) {
      issues.push({ pass: "rule_check", severity: "block", code: "NG_PROPERTY_MENTION", message: `提案禁止物件「${core}」に言及しています`, evidence: core, suggestion: `「${core}」への言及を削除してください` });
    }
  }

  // ⑥ 自己紹介の再生成（2回目以降の会話で「はじめまして」「〇〇と申します」）
  //    S-4: route の isFirstEverReplyFromMsgs と同条件（メディアのみのスタッフ送信は履歴に数えない）＋初回免除
  const hasStaffHistory = !isFirstReply && (ctx.recentMessages ?? []).some(
    (m) => m.sender === "staff" && !!(m.text || "").trim() && !MEDIA_ONLY_RE.test(m.text || ""),
  );
  if (hasStaffHistory) {
    const m = text.match(/はじめまして|担当(?:させて頂き|させていただき|いたし|致し)ます[^。\n]{1,10}と申します|と申します/);
    if (m) {
      issues.push({ pass: "context_check", severity: "block", code: "INTRO_REPEAT", message: "既にやり取りのある顧客に対して自己紹介・初回挨拶を再生成しています", evidence: m[0], suggestion: "「○○さん お世話になっております！！」から始めてください" });
    }
  }

  // ⑦ 具体アクション欠落（WE_DO_MISSING_DET）／汎用のみ返信（GENERIC_ONLY_REPLY）
  //   定型句を除去した残りに「行動動詞＋宣言語尾」が1文も無ければ発行。待ち系TPOは除外。
  //   A-11: tpo が空でも純粋な了承文（25字以内）への返信は免除／説明文が1文以上あれば info に格下げ／GENERIC は残量<25字で判定
  const cust = ctx.lastCustomerMessage ?? "";
  const custIsPureAck = cust.trim().length > 0 && cust.trim().length <= 25 && PURE_ACK_RE.test(cust.trim());
  // 2026-09-09 Fable5 往復文脈: 免除は「純粋な了承（sub.isAckOnly / custIsPureAck）」と「待ち系TPO かつ 実質なし」のみ（実質ありなら待ち系ラベルでも検査する）
  const { sub: skelSub, pair: skelPair } = resolveReplyContext(ctx);
  // 2026-09-11 統合設計（経路D）: 締め・断り（isClosedVerdict）では「足す」系を出さない（① と同じ関数。成約の締め正解 5/5 が block になっていた）
  const closedSkel = isClosedVerdict(skelPair, tpo);
  if (!skelSub.isAckOnly && !custIsPureAck && !closedSkel && !(WAIT_TPO_RE.test(tpo) && !skelSub.has)) {
    // G26（2026-09-08 Fable5）: 根拠の無い「確認出来次第ご連絡」を WE DO に数えない（WE_DO_MISSING を確認約束で回避するインセンティブを消す）
    const weDoBase = stripUnbackedConfirmPromise(text, getConfirmVerdict(ctx));
    const residue = weDoBase.replace(BOILERPLATE_RE, "");
    const hasActionDecl = ACTION_DECL_RE.test(residue) || RECEIVE_DECL_RE.test(weDoBase);
    // sub.has が主、CUSTOMER_REQUEST_RE は後方互換の従
    const customerAsked = skelSub.has || CUSTOMER_REQUEST_RE.test(cust);
    if (!hasActionDecl) {
      const sig = deriveCloserSignals(text);
      const residueLen = residue.replace(/[\s！!。、😊😌🌟✨]/g, "").length;
      // 2026-09-09 Fable5: GENERIC_ONLY は「具体宣言なしの全力サポート締め」（あやさん型）に限定。それ以外は WE_DO_MISSING_DET
      const isGenericOnly = sig.usedCommit && !sig.hasConcreteDeclaration;
      // 感謝・挨拶の「ございます！」を説明文に数えない（あやさん型が info に降格していた）。GENERIC_ONLY は説明文があっても降格しない
      // 2026-09-11 統合設計（経路C・ﾓﾓｶ/𝒮 事例）: 旧 EXPLANATORY_RE は「となります😊！！」の絵文字で不一致・「予定しております／流れになります／
      //   ございません」を知らず、正しく答えた返信を block していた。hasDirectAnswer（定型句を剥がしてから判定）に統一し、
      //   質問に答えている時は info に下げる（質問セル＝回答だけを求める。次工程の要求は PAIR_ELEMENT_MISSING 側で担保）
      // 2026-09-11 竹内方針1: 観測専用（info）。スタッフの実文と相関が無い（WE_DO 編集で解消18／発生17・GENERIC 4/5）。
      //   判定材料（回答形・説明文・残量）は message に残して tpo_debug で観測する
      const ans = hasDirectAnswer(text, skelPair.customer.questionForm ?? null);
      const hasExplanation = customerAsked && !isGenericOnly && ans.form === "answer";
      void residueLen; void hasExplanation;
      issues.push({
        pass: "context_check",
        severity: "info",
        code: isGenericOnly ? "GENERIC_ONLY_REPLY" : "WE_DO_MISSING_DET",
        message: (isGenericOnly
          ? "「全力でサポート」が具体宣言（エリア・条件を復唱したピックアップ/確認宣言）の代わりになっている（あやさん型の汎用返信）"
          : "具体的な行動宣言（ピックアップ/確認/交渉/お送り/ご案内 等＋対象）が1文もありません") + `【往復文脈】${skelPair.summary}`,
        evidence: text.trim().slice(0, 30),
        // 2026-09-10 Fable5 Sさん事例: 旧実装は rule.example（別場面の実文）を suggestion に使い、
        //   rule=null の時はピックアップ以外の道が無い汎用文にフォールバックしていた（内覧提案が消える経路）。
        //   選ばれたセルの fix リテラル優先 → 無ければ WE DO の「選択肢」を列挙する（1文を足せと命じない）
        // 2026-09-11 統合設計（経路A/B）: 〇〇／△△ のリテラルを出さない。内覧提案は {viewingOffer}（顧客名スロット済み）で渡す
        suggestion: pairFixSuggestion(skelPair, text) ?? (isGenericOnly
          ? "顧客メッセージのエリア・条件をそのままの語で復唱したピックアップ宣言を先に置き、全力サポートはその後の締めとしてだけ残す"
          : `顧客メッセージの固有名詞を復唱し、次の一手を1つだけ宣言する。候補: 内覧のご案内提案（「${fillPairPlaceholders("{viewingOffer}", skelPair)}」・具体日時は書かない）／募集状況の確認／御見積書の作成／ご条件に合うお部屋のピックアップ`),
      });
    }
  }

  // ⑧ 語彙セマンティクス（主語・方向・前提の履歴照合）— 初回・recheck の両方で走る
  issues.push(...runVocabSemanticChecks(text, ctx));

  // ⑧' G6 宅建業法: 管理会社確認前の断言禁止（告知事項・空室・入居可能日）＋根拠なし審査安心（初回・recheck・後処理後の全経路で走る）
  issues.push(...runAssertionBanChecks(text, ctx));

  // ⑨ §5 追加チェック（文脈付き禁止パターン・マーカー漏れ・絵文字・約束復唱・見積文脈外・退去前内覧・申込意思・時制・確定後再質問・フェーズ禁止）
  issues.push(...runDeterministicExtras(text, ctx));

  // ⑩ 2026-09-09 Fable5 往復文脈: 返信骨格（REPLY_SKELETON_MISSING / CONCERN_UNADDRESSED / EMPTY_CLOSER / PAIR_ELEMENT_MISSING / SPLIT_ACK_REPLY / FEELING_TEMPLATE）
  issues.push(...runSkeletonChecks(text, ctx));

  // ⑪ 2026-09-09 Fable5 みく事例: ヘッジゲート（PREEMPTIVE_HEDGE / FABRICATED_SEARCH_REPORT / CONDITION_RELAX_UNASKED / HEDGE_WITHOUT_SEARCH_DECL / SELF_HEDGE_ECHO）
  //    ・締めポリシー（CLOSER_MISSING / COMMIT_AFTER_DELIVERABLE / NANISOTSU_MISPLACED / PASSIVE_CLOSER / RESULT_EXCUSE）
  //    ・姿勢ギャップ（CONDITION_ECHO_MISSING / SCHEDULE_ASSERT_UNCONFIRMED / FACT_DEFERRED_ANSWER / 煽り・受け身5種）
  issues.push(...runHedgeChecks(text, ctx), ...runCloserChecks(text, ctx), ...runStanceChecks(text, ctx));
  // ⑪'' 2026-09-12 竹内方針B: 「ご連絡お待ちしております」「承りました」の場面（AWAIT_CONTACT_MISPLACED / UKETAMAWARI_OBJECT_UNANCHORED）
  issues.push(...runAwaitUketamawariChecks(text, ctx));
  // ⑪' 2026-09-10 Fable5 あみ事例: 顧客が言っていない語（UNANCHORED_VOCAB / VOCAB_MIRROR_MISMATCH）
  issues.push(...runVocabAnchorChecks(text, ctx));

  // ⑫ 2026-09-09 Fable5 行動台帳（DONE_PRESUPPOSED_WITHOUT_EVIDENCE / UNSENT_CLAIM / PROMISE_ECHO_MISMATCH）
  issues.push(...runLedgerChecks(text, ctx));

  // ⑬ 2026-09-10 Fable5 みく事例: 余計な行動宣言（UNPROMPTED_PROPOSAL）・セル衝突（CELL_AVOID_CONFLICT）・
  //    顧客も DB も書いていない条件語（ECHO_FROM_BRAIN_NOT_CUSTOMER・shadow 既定）
  issues.push(...runProposalChecks(text, ctx), ...runCellConflictChecks(text, ctx), ...runUnanchoredConditionChecks(text, ctx));

  // ⑭ 2026-09-11 統合設計（M13・YUYA/Aoi/慶次/yt 事例）: 同じ下書きに「足す」系 block がある時、NANISOTSU_MISPLACED（何卒を削れ）は info に落とす。
  //    本文が空になると resolveCloser が「具体宣言なし→何卒なし」に反転する順序依存で、セル（PD_CONDITION_CHANGE nanisotsu:true）と逆の指示になるため
  if (issues.some((i) => i.severity === "block" && ADD_TYPE_CODES.has(i.code)))
    for (const i of issues) if (i.code === "NANISOTSU_MISPLACED") i.severity = "info";

  // ⑮ 2026-09-11 竹内方針1（統合設計 §4）: 誤字（TYPO_*）。後処理 applySurfaceFixes の自動修正の後に残ったものだけが出る（warning・block しない・修正ループ対象外）
  issues.push(...runTypoChecks(text, ctx));

  return issues;
}
/** 誤字の検出（warning）。evidence は一致した文字列、suggestion は置換後の文字列 */
export function runTypoChecks(text: string, ctx: FinalCheckContext): CheckIssue[] {
  return detectTypos(text, { customerName: ctx.customerName ?? "", now: ctx.now }).map((h) => ({
    pass: "rule_check" as const, severity: "warning" as const, code: h.code,
    message: `誤字の可能性「${h.evidence === "\n" ? "\\n" : h.evidence}」`,
    evidence: h.evidence,
    suggestion: h.fixed === null ? "誤字を直してください（置換先は文脈で判断）" : `「${h.fixed === "\n" ? "（改行）" : h.fixed}」に直す`,
  }));
}
/** 「文を足す」系の骨格 block（M13 の判定・GATE_PAIR_CONFLICT の安全弁が参照） */
const ADD_TYPE_CODES = new Set(["REPLY_SKELETON_MISSING", "EMPTY_CLOSER", "PAIR_ELEMENT_MISSING", "WE_DO_MISSING_DET", "GENERIC_ONLY_REPLY"]);

/** 2026-09-11 統合設計（経路F・安全弁）: 決定論チェックのうち骨格系 block のコードだけを返す（約0ms）。
 *  route の後処理（validateAndClean）の前後で比較し、ゲートの削除で新たに骨格系 block が出たら取り消せるゲートを外す */
export function skeletonBlockCodes(text: string, ctx: FinalCheckContext): string[] {
  return runDeterministicChecks(text, ctx).filter((i) => i.severity === "block" && SKELETON_CODES.has(i.code)).map((i) => i.code);
}
/** 2026-09-11 竹内方針1（統合設計 §2 方針1(d)・E1-k）: 選ばれたセルの必須要素のうち、本文で満たされていないもののラベル（多重集合）。
 *  severity に依存しない（PAIR_ELEMENT_MISSING を info に下げても、後処理ゲートが必須要素文を消したことを検知できる）。
 *  route の GATE_PAIR_CONFLICT 安全弁が validateAndClean の前後で比較する（skeletonBlockCodes と併用） */
export function cellElementGaps(text: string, ctx: FinalCheckContext): string[] {
  if (!ctx.lastCustomerMessage) return [];
  const { pair } = resolveReplyContext(ctx);
  return (pair.rule?.mustInclude ?? [])
    .filter((m) => (!m.when || m.when(pair)) && !mustIncludeSatisfied(m, text, pair))
    .map((m) => `CELL:${m.label}`);
}

// ─── 2026-09-09 Fable5 行動台帳検査（A: 実行前提語 / B: 約束未履行なのに完了形 / C: 既送付無視）。生成側 buildLedgerNote と同じ checkDonePresupposition ───
function runLedgerChecks(text: string, ctx: FinalCheckContext): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const { ledger } = resolveReplyContext(ctx);
  // 2026-09-11 統合設計（経路B）: 名前不明時に「〇〇さん」を修正案へ入れない（呼びかけごと省く）
  const name = ctx.customerName ? `${ctx.customerName}さん` : "";
  // 成果物添付＝物件ラベル・見積書・URL の実体がある時（完了形動詞だけの「ピックアップさせて頂きました」は添付ではない）
  const isDeliverable = ctx.isDeliverableReply ?? ATTACHED_DELIVERABLE_RE.test(text);
  const hint = `【行動台帳】${ledger.summary}。`;
  // 証拠の質: generate-reply 経路（ledgerStrict）は block。台帳を渡していない check-reply 旧経路（スタッフ編集文）は warning
  const strict = ctx.ledgerStrict ?? !!ctx.ledger;
  for (const h of checkDonePresupposition(text, ledger, { customerMessage: ctx.lastCustomerMessage ?? "", name, isDeliverableReply: isDeliverable })) {
    if (h.exempt) continue;
    const severity: CheckSeverity = h.severity === "warning" || !strict ? "warning" : "block";
    issues.push({ pass: "context_check", severity, code: h.code,
      message: `${h.label}ですが、台帳に該当する実行記録がありません（必要: ${h.requiresLabel}）。${hint}`,
      evidence: h.evidence,
      suggestion: `「${h.sentence}」→「${h.fixed || "（文ごと削除）"}」に置換（他の文は触らない。台帳に無い事実を書き足さない）` });
  }
  // B. 宣言のみ・未履行なのに完了形
  if (ledger.facts.pickupPromisedUnfulfilled && ledger.facts.propertiesSentCount === 0 && !isDeliverable) {
    const m = text.match(COMPLETED_SEND_RE);
    if (m) issues.push({ pass: "context_check", severity: "warning", code: "PROMISE_ECHO_MISMATCH",
      message: `直前の「ピックアップしてお送りします」宣言はまだ履行されていない（物件送付0件）のに完了形で書いています。${hint}`,
      evidence: m[0], suggestion: `「${m[0]}」→「ピックアップ出来次第お送りさせて頂きます」に置換` });
  }
  // 送付済み×条件変更で「既送付物件に触れろ」と強制するチェック（旧 SENT_IGNORED）は、成約データにない
  // 「選択肢として残しつつ」等の創作文を誘発するため廃止（2026-09-09）。台帳に無い文は足させない。
  return issues;
}

/** 2026-09-09 行動台帳: 修正ループの指示に台帳の根拠と「台帳に無い事実を書かない」制約を添える（decorate は台帳系コードのみ） */
export function decorateFixInstruction(issue: CheckIssue, ledger: ActionLedger): CheckIssue {
  if (!LEDGER_FIX_CODES.has(issue.code)) return issue;
  return { ...issue, suggestion: `${issue.suggestion ?? ""}。根拠=行動台帳: ${ledger.summary}。禁止: 台帳に無い送付・確認・案内の事実を新たに書く／文を追加する。許可: 語の削除・「出来次第お送りさせて頂きます」への置換` };
}

// ─── 2026-09-09 Fable5 みく事例: ヘッジゲート検査（生成側 resolveHedgeAllowance と同一 verdict）───────────
function runHedgeChecks(text: string, ctx: FinalCheckContext): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const { hedge } = resolveReplyContext(ctx);
  const hint = `【ヘッジ判定】${hedge.summary}。`;
  const name = ctx.customerName ? `${ctx.customerName}さん` : "";
  const supportCloser = CLOSER_TEXT.commit_until_found(ctx.customerName ?? "");
  const sentences = text.split(/(?<=[。！!\n])/).map((s) => s.trim()).filter(Boolean);
  const hasSearchDecl = SEARCH_DECL_RE.test(text);
  const customerRelaxed = hedge.customerStatedRelax.yes || CUST_STATED_RELAX_RE.test(ctx.lastCustomerMessage ?? "");
  // ヘッジ語を含む節（読点区切り）が過去形か（「少ない状況になる可能性がございますので、〜ピックアップさせて頂きました」の後半に引きずられない）
  const clauseIsPast = (s: string, m: string) => {
    const clause = s.split(/[、,]/).find((c) => c.includes(m)) ?? s;
    return PAST_REPORT_RE.test(clause);
  };
  const seen = new Set<string>();
  for (const s of sentences) {
    const h = s.match(PRE_PICKUP_HEDGE_RE);
    if (h && !seen.has("PH")) {
      if (hedge.allowance === "forbid_preemptive") {
        seen.add("PH");
        issues.push({ pass: "context_check", severity: "block", code: "PREEMPTIVE_HEDGE",
          message: `まだ探していない段階で条件の実現可能性を先回りしてヘッジしています（正解返信2618件中0件・頼りがいを削ぐ）。${hint}`,
          evidence: h[0], suggestion: `この文を削除し、ご希望条件をそのまま復唱したピックアップ宣言の後に「${supportCloser}」で締める（代替案はピックアップ結果と一緒に報告する）` });
      } else if (hedge.allowance === "allow_after_search" && !clauseIsPast(s, h[0])) {
        seen.add("PH");
        issues.push({ pass: "context_check", severity: "block", code: "PREEMPTIVE_HEDGE",
          message: `探索済みですが未来形の予測で書かれています（正解は過去形の結果報告のみ）。${hint}`,
          evidence: h[0], suggestion: "未来形の予測を削り、実際に広げた条件（台帳・履歴にあるものだけ）を「〜のご条件ですと合うお部屋が少ない状況でしたので、〜まで広げてピックアップさせて頂きました！！」の過去形で書く" });
      } else if (hedge.allowance === "allow_on_customer_ask" && !hasSearchDecl) {
        seen.add("PH");
        issues.push({ pass: "context_check", severity: "block", code: "HEDGE_WITHOUT_SEARCH_DECL",
          message: `お客様の直接質問への傾向回答はよいが、探索宣言がセットになっていません。${hint}`,
          evidence: h[0], suggestion: `「傾向として〜が多いですが、${name ? `${name}の` : ""}ご条件でしっかりピックアップしてお送りさせて頂きます！！」の形にする` });
      }
    }
    const r = s.match(SEARCH_REPORT_RE);
    if (r && hedge.allowance !== "allow_after_search" && !seen.has("FS")) {
      seen.add("FS");
      issues.push({ pass: "context_check", severity: "block", code: "FABRICATED_SEARCH_REPORT",
        message: `物件送付（AIX）の実績が無いのに「探した結果」として書いています。${hint}`,
        evidence: r[0], suggestion: "結果報告を削除し、ピックアップ宣言（未来形）に戻す。結果はAIX物件送付文で報告する" });
    }
    const x = s.match(RELAX_PROPOSAL_RE);
    if (x && !seen.has("CR")) {
      const exempt = (hedge.allowance === "allow_after_search" && clauseIsPast(s, x[0])) || hedge.allowance === "allow_on_customer_ask" || customerRelaxed;
      if (!exempt) {
        seen.add("CR");
        issues.push({ pass: "context_check", severity: "block", code: "CONDITION_RELAX_UNASKED",
          message: `お客様が緩和条件を述べていないのに条件緩和・代替案を先回りで提案しています${hedge.customerSelfHedge.yes ? `（顧客の自己ヘッジ「${hedge.customerSelfHedge.evidence}」を戦略に昇格させない）` : ""}。${hint}`,
          evidence: x[0], suggestion: `この文を削除し、ご希望条件そのままのピックアップ宣言→「${supportCloser}」で締める。緩和が必要かはピックアップ結果で示す` });
      }
    }
  }
  if (hedge.customerSelfHedge.yes) {
    const e = text.match(SELF_HEDGE_ECHO_RE);
    if (e) issues.push({ pass: "rule_check", severity: "warning", code: "SELF_HEDGE_ECHO",
      message: `お客様の自己ヘッジに同意・復唱しています（正解は復唱せず条件そのままで探す宣言）。${hint}`, evidence: e[0], suggestion: `同意文を削除し、「${supportCloser}」で締める` });
  }
  return issues;
}

// ─── 2026-09-09 Fable5: 締め検査（生成側 resolveCloser と同一関数）─────────────────────────────
function runCloserChecks(text: string, ctx: FinalCheckContext): CheckIssue[] {
  const out: CheckIssue[] = [];
  const { pair } = resolveReplyContext(ctx);
  const sig = deriveCloserSignals(text);
  const opts = { customerName: ctx.customerName ?? "", isFirstContact: !!ctx.isEarlyConversation, asksCustomerTask: sig.asksCustomerTask };
  // 生成前予測（ctx.closerVerdict）は下書きに成果物・日程が現れた時点で無効。none 予測も下書きで再判定する
  const v = ctx.closerVerdict && ctx.closerVerdict.closer !== "none" && !sig.deliverableAttached && !sig.scheduleFixed ? ctx.closerVerdict : resolveCloser(pair, sig, opts);
  const head = text.trim().slice(0, 30);
  if (sig.usedCommit && sig.deliverableAttached)
    out.push({ pass: "context_check", severity: "warning", code: "COMMIT_AFTER_DELIVERABLE", message: "成果物送付時に全力サポート締めを重ねている（正解 property_send 系0件）", evidence: text.match(/[^\n]*全力でサポート[^\n]*/)?.[0] ?? "全力でサポート", suggestion: "締めを「お手隙の際にご査収ください😌！！」のみにする" });
  if (sig.usedNanisotsu && !v.nanisotsu)
    out.push({ pass: "context_check", severity: "warning", code: "NANISOTSU_MISPLACED", message: `この場面で何卒は冗長（${v.reason}）。AI生成26% vs 正解14%`, evidence: text.match(NANISOTSU_RE)?.[0] ?? "何卒", suggestion: "「何卒よろしくお願い致します」行を削除" });
  if (v.closer === "commit_until_found" && !sig.usedCommit)
    out.push({ pass: "context_check", severity: "warning", code: "CLOSER_MISSING", message: "節目の具体宣言の後に伴走宣言が無い（スタッフ編集で全力サポート追加8件／削除0件）", evidence: head, suggestion: `最終行に「${v.text}」を追加` });
  if (sig.hasResultExcuse && sig.deliverableAttached && pair.customer.kind === "condition_change")
    out.push({ pass: "rule_check", severity: "warning", code: "RESULT_EXCUSE", message: "お客様主導の条件変更に「少ない状況でしたので広げました」の言い訳行（AIX widen でスタッフが2/2削除）", evidence: text.match(RESULT_EXCUSE_RE)?.[0] ?? head, suggestion: "言い訳行を削り、広げた条件を含む復唱＋ご査収のみにする" });
  if ((sig.usedOpenDoor || sig.usedWait) && (v.closer === "commit_until_found" || v.closer === "receive_check"))
    out.push({ pass: "context_check", severity: "warning", code: "PASSIVE_CLOSER", message: "我々が動く場面で受け身締め（いつでもお気軽に／ごゆっくり）", evidence: text.match(OPEN_DOOR_RE)?.[0] ?? text.match(WAIT_SOFTLY_RE)?.[0] ?? head, suggestion: `締めを「${v.text || CLOSER_TEXT[v.closer](opts.customerName)}」に置換` });
  return out;
}

// ─── 2026-09-12 竹内方針B: 「ご連絡お待ちしております」「承りました」の場面検査（修正版のプリスキャンも同じ関数）─────────
//   ・AWAIT_CONTACT_MISPLACED: 顧客の連絡予告が無い（resolveAwaitContact＝締めと同じ verdict）のに、依頼・質問・条件への返信か
//     未履行のピックアップ約束がある場面で「ご連絡お待ちしております」。warning（根拠は下書き削除 3/3 件＝n が少ないので block にしない）
//   ・UKETAMAWARI_OBJECT_UNANCHORED: 「内覧のキャンセル承りました」等の目的語が顧客の直近の発言に無い（SHIGI 事例）。
//     スタッフ実送信6通（直近の顧客発言3件で照合）で偽陽性0 → block
export function runAwaitUketamawariChecks(text: string, ctx: FinalCheckContext): CheckIssue[] {
  const out: CheckIssue[] = [];
  const aw = text.match(AWAIT_CONTACT_PHRASE_RE);
  if (aw && ctx.lastCustomerMessage) {
    const { pair, sub, ledger } = resolveReplyContext(ctx);
    const ac = pair.awaitContact ?? resolveAwaitContact({ customerMessage: sub.normalized, substance: sub, ledger });
    const asks = sub.kinds.includes("request") || sub.kinds.includes("question") || sub.kinds.includes("condition");
    if (!ac.allowed && (asks || ledger.facts.pickupPromisedUnfulfilled))
      out.push({ pass: "context_check", severity: "warning", code: "AWAIT_CONTACT_MISPLACED",
        message: `お客様は自分から連絡すると言っていない${asks ? "（依頼・質問への返信）" : "（未履行のピックアップ約束がある＝次に動くのはスタッフ）"}のに「ご連絡お待ちしております」（スタッフは依頼・質問の場面で 3/3 件削除）`,
        evidence: aw[0], suggestion: "この行を削除し、こちらの行動宣言で終える" });
  }
  const hay = [ctx.lastCustomerMessage ?? "", lastCustomerTexts(ctx, 3)].join("\n");
  const u = findUnanchoredUketamawari(text, hay);
  if (u)
    out.push({ pass: "context_check", severity: "block", code: "UKETAMAWARI_OBJECT_UNANCHORED",
      message: `「${u.object}」をお客様は伝えていないのに「${u.evidence}」（承りましたの目的語はお客様が今回伝えた事項だけ）`,
      evidence: u.evidence, suggestion: `「${u.evidence}」の行を削除する（お客様が伝えた事項だけを「〜承りました」の目的語にする）` });
  return out;
}

// ─── 2026-09-10 Fable5 あみ事例: 顧客アンカー語彙（生成側 buildVocabAnchorNote と同一テーブル）───
//   「顧客が一言も言っていないのに使うと文脈が壊れる語」を検出し、必ず正しい代替リテラルを suggestion で返す。
function runVocabAnchorChecks(text: string, ctx: FinalCheckContext): CheckIssue[] {
  const out: CheckIssue[] = [];
  const { pair } = resolveReplyContext(ctx);
  const cust = ctx.lastCustomerMessage ?? "";
  const custHist = lastCustomerTexts(ctx, 3);
  const staffPrev = lastStaffTexts(ctx, 1);
  // 免除の探索範囲: 顧客の最新＋直近3件＋直前スタッフ発言（スタッフが「ご家族でご相談ください」と言った後の復唱を潰さない）
  const anchorHay = `${cust}\n${custHist}\n${staffPrev}`;
  const vctx = { reply: text, customerText: cust, lastCustomerTexts: custHist, lastStaffText: staffPrev, pair };
  for (const v of CUSTOMER_ANCHORED_VOCAB) {
    const m = text.match(v.re);
    if (!m) continue;
    const anchored = v.requires.test(anchorHay);
    const forbidden = v.forbidWhen ? v.forbidWhen(vctx) : false;
    if (anchored && !forbidden) continue;
    out.push({ pass: "context_check", severity: v.severity, code: "UNANCHORED_VOCAB",
      message: `${forbidden ? "この場面では使えない語" : "お客様が一言も言っていない語"}「${m[0]}」を使っています。${v.why}`,
      evidence: m[0], suggestion: v.replace });
  }
  const g = checkGoyukkuriMirror(text, `${cust}\n${custHist}`);
  if (g && !g.ok) {
    out.push({ pass: "context_check", severity: g.expected ? "block" : "warning", code: "VOCAB_MIRROR_MISMATCH",
      message: g.expected
        ? `「ごゆっくり${g.used}」ですが、お客様が言ったのは「${g.expected.replace("ご", "")}」です（後続語は顧客の動詞の鏡写しが正解 33件中 31件=94%）`
        : `「ごゆっくり${g.used}」ですが、お客様は間を置く行動（検討する・確認する・相談する・見る）を一言も言っていません（「ごゆっくり」正解 33件中 31件は顧客の該当語あり）`,
      evidence: `ごゆっくり${g.used}`,
      suggestion: g.expected ? `「ごゆっくり${g.expected}頂けますと幸いです😊！！」に直す` : "「ごゆっくり〜」の行を削除し、その位置に行動宣言（募集状況確認・ピックアップ等）を置く" });
  }
  return out;
}

// ─── 2026-09-09 Fable5: 姿勢ギャップ検査（編集400件の上位: 具体復唱101・決め打ち22・可否保留11・煽り/受け身18）───────
const EXCUSE_META: Record<ExcuseFlag, { code: string; sev: CheckSeverity; msg: string; sug: string }> = {
  widen_excuse: { code: "WIDEN_EXCUSE_REDUNDANT", sev: "warning", msg: "お客様が自分で広げた条件を「少ない状況でしたので広げました」と言い訳している", sug: "その1文を削除し、広げた結果（エリア・条件の列挙）だけ渡して「お手隙の際にご査収ください😌！！」" },
  reassurance_no_basis: { code: "REASSURANCE_NO_BASIS", sev: "warning", msg: "根拠となる事実文の無い「ご安心ください」", sug: "削除し、事実（〜となります）か行動宣言に置き換える" },
  urgency: { code: "URGENCY_NO_INTENT", sev: "warning", msg: "申込意思・割引見積の無い段階での希少性煽り（急かし削除7件）", sug: "煽り語を削除。見積送付後・前向き反応後にのみ「お気に召されましたらお部屋埋まってしまう前に〜」" },
  consider_push: { code: "CONSIDER_PUSH", sev: "warning", msg: "「ご検討ください」で顧客に委ねて終えている", sug: "「気になる物件がございましたらいつでもお気軽にお送りください！！お送りいただき次第募集状況確認させて頂きます！！」型の受け宣言に置換" },
  humble_wait: { code: "HUMBLE_WAIT", sev: "warning", msg: "「〜いただけますと幸いです／少々お時間」の受け身のお願い", sug: "こちらの行動宣言（〜させて頂きます）に置換" },
};
function runStanceChecks(text: string, ctx: FinalCheckContext): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const { sub, pair } = resolveReplyContext(ctx);
  const tpo = ctx.tpoLabel ?? "";
  const cust = ctx.lastCustomerMessage ?? "";
  const head = text.trim().slice(0, 30);
  // ① 条件復唱率（拡張101件）
  // 2026-09-11 竹内方針2（統合設計 §2 方針2(b)）: 復唱を見るのは条件フォーム・自由記述の条件の時だけ（resolveCustomerDocScope＝生成の stanceNote と同じ関数）。
  //   物件送付・申込フォームは復唱しない（正解 0/18・0/4）。物件名・建物名・所在階・住所・日付はトークンにしない。
  //   severity は warning（表示のみ・修正ループ対象外）。絞り込み後も復唱ゼロの正解が 14/119（単発）・23/147（本番同等）残り、
  //   条件フォームの 21% はエリアも数値も復唱しない＝block の根拠にならない。「ご条件に合った」はスタッフ正解の 60% が使うので禁止しない
  void sub;
  const docScope = resolveCustomerDocScope(cust);
  if (isEchoableScope(docScope) && !CLOSED_TPO_RE.test(tpo) && !NO_DECL_TPO_RE.test(tpo)) {
    const echo = evalConditionEcho(text, docScope.tokens);
    if (echo.expected.length >= 2 && echo.ratio < 0.5) {
      const area = docScope.areaWords.slice(0, 3).join("・");
      issues.push({ pass: "context_check", severity: "warning", code: "CONDITION_ECHO_MISSING",
        message: `お客様の条件${echo.expected.length}件中${echo.echoed.length}件しか復唱していません（表示のみ）`, evidence: head,
        suggestion: `${area ? `お客様のエリア表記（${area}）を「${area}周辺全域から」の形で入れる。` : ""}家賃・間取りは入れてよい（${echo.missing.slice(0, 4).join("・")}）。物件名・号室・階・住所・日付は入れない` });
    }
  }
  // ② 決め打ち断定（断定削除22件）
  const commit = classifyScheduleCommitment(cust, pair.lastStaffText);
  if ((commit === "customer_asking" || commit === "staff_proposing") && STAFF_ASSERT_SCHEDULE_RE.test(text) && !SCHEDULE_ASK_RE.test(text)) {
    issues.push({ pass: "context_check", severity: ctx.isAutoSend ? "block" : "warning", code: "SCHEDULE_ASSERT_UNCONFIRMED",
      message: "お客様が日時を確定していないのに確定形で締めている（正解: 「はい！！ご案内可能です😊！！」＋「〜お待ち合わせ如何でしょうか！！」）",
      evidence: text.match(STAFF_ASSERT_SCHEDULE_RE)?.[0] ?? head, suggestion: "「〜で何卒よろしくお願い致します」を「〜お待ち合わせ如何でしょうか😊！！」に、質問形の返しには冒頭に「はい！！お部屋ご案内可能です😊！！」" });
  }
  // ③ 可否即答（断定追加11件）
  const fact = resolveAnswerability(cust);
  if (fact && DEFERRED_ANSWER_RE.test(text) && !text.includes(fact.answer.replace(/[！!]+$/, "").slice(0, 10))) {
    issues.push({ pass: "context_check", severity: "warning", code: "FACT_DEFERRED_ANSWER",
      message: `即答できる既知事実（${fact.key}）を「確認します」に逃がしている（正解は言い切り＋次の一手）`,
      evidence: text.match(DEFERRED_ANSWER_RE)?.[0] ?? head, suggestion: `「${fact.answer}」と言い切り、続けて「${fact.next || "次の一手（見積・内見）を宣言"}」` });
  }
  // ④ 保険・受け身・煽り語（18件）
  for (const e of detectExcusePhrases(text, pair, extractEchoTokens(cust))) {
    const m = EXCUSE_META[e.flag];
    const sev: CheckSeverity = (e.flag === "urgency" && ctx.isAutoSend) ? "block" : m.sev;
    issues.push({ pass: "rule_check", severity: sev, code: m.code, message: m.msg, evidence: e.evidence, suggestion: m.sug });
  }
  return issues;
}

// ─── G6 宅建業法: 管理会社確認前の断言禁止（2026-09-08 Fable5）──────────────────────────
// 告知事項・空室状況・入居可能日は「管理会社確認の結果」を持つ情報源が無い限り断言禁止。審査は根拠なし安心禁止。
// 宅建業法47条（重要事項の不告知・誤認）リスクのため severity は isAutoSend に関係なく常に block。
// 定義（正規表現・置換文）は validate-reply.ts ASSERTION_BAN_RULES と同一定数（後処理置換とチェックの対称性）。
// 免除は「情報源あり」の3経路のみ。顧客が日付・空室を言っただけでは免除しない（顧客発言は情報源ではない）:
//   ① ctx.aixVacancyDone — AIX【物件確認した】/ mgmt_* 完了（空室・入居日のみ。告知・審査は対象外）
//   ② スタッフ直近3件（AIX送付文含む）に確認結果報告（rule.staffConfirmedRe: 「管理会社に確認しましたところ空室」等）
//   ③ AIX 結果送信フロー（ctx.isAix or brainMeta.action=property_check_result）で staffSourceText に対象語（rule.sourceRe）
function runAssertionBanChecks(text: string, ctx: FinalCheckContext): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const staffRecent = lastStaffTexts(ctx, 3);
  const source = ctx.staffSourceText ?? "";
  const aixResultFlow = !!ctx.isAix || ctx.brainMeta?.action === "property_check_result";
  for (const r of ASSERTION_BAN_RULES) {
    // 2026-09-12 竹内方針A-3: 一致判定は後処理置換と同じ findAssertionMatch（exclude＝時間枠の空いて・キャンセルのトラブル）
    const m = findAssertionMatch(r, text);
    if (!m) continue;
    const exemptBy =
      r.exemptOnAixVacancyDone && ctx.aixVacancyDone ? "aixVacancyDone"
      : r.staffConfirmedRe.test(staffRecent) ? "staffConfirmed"
      : aixResultFlow && r.sourceRe.test(source) ? "staffSource"
      : null;
    if (exemptBy) {
      // 監査用に info で残す（UI は block のみ止める）。clearedFacts と同様に2回目チェックでも再指摘しない
      issues.push({ pass: "rule_check", severity: "info", code: `${r.code}_EXEMPT`, message: `${r.msg}（免除: ${exemptBy}）`, evidence: m[0], suggestion: "確認済み情報の伝達として許容" });
      continue;
    }
    issues.push({ pass: "rule_check", severity: "block", code: r.code, message: r.msg, evidence: m[0], suggestion: r.sug });
  }
  return issues;
}

// ─── §5 追加決定論チェック（2026-09-08 Fable5）────────────────────────────────────────
type BannedPattern = { re: RegExp; code: string; msg: string; sug: string; onlyTpo?: RegExp; histRe?: RegExp; blockAlways?: boolean;
  /** 履歴（allHist）に一致すれば免除（例: 見積送付済みなら金額言及可） */
  skipIfHistRe?: RegExp };
const BANNED_PATTERNS: BannedPattern[] = [
  { re: /コスパ/, code: "BANNED_WORD", msg: "「コスパ」表現は禁止", sug: "「好条件」「お値打ちな条件」に変更" },
  { re: /仲介手数料[^\n。]{0,8}割引/, code: "FABRICATED_POLICY_DET", msg: "仲介手数料は固定（割引不可）", sug: "「初期費用を最大限割引」に変更", blockAlways: true },
  // G6: 旧 /即入居可能/ 行は MOVEIN_DATE_ASSERTION（「即」head・block）が包含するため削除（二重指摘防止）
  // G26/G7: 「すぐに」約束は文脈に関係なく誤り（HASTY_PROMISE を block 固定。bridge 実例からも除去済み）
  // 2026-09-11 竹内方針5: 正規表現は banned-phrasing の HASTY_ADVERB_RE（後処理 stripHastyAdverb と同じ定義）。旧正規表現は「すぐに手配／共有」「すぐご案内」を取りこぼしていた
  { re: HASTY_ADVERB_TEST_RE, code: "HASTY_PROMISE", msg: "「すぐに／今すぐ」の過度な約束", sug: "「すぐに」を削除（例：確認出来次第ご連絡させて頂きます／退去後ご案内させて頂きます）", blockAlways: true },
  { re: /少々お時間(?:頂|いただ|頂戴)/, code: "BANNED_WORD", msg: "曖昧な時間表現", sug: "「明日一番に〜させて頂きます」等の具体タイミングに変更" },
  { re: /(?:とのことですね|をご希望ですね)/, code: "ECHO_CONFIRM", msg: "オウム返しの単体確認文", sug: "条件は行動宣言の修飾として埋め込む" },
  { re: /まず[^\n。]{0,20}次に/, code: "LIST_STRUCTURE", msg: "「まず〜次に〜」の列挙構成", sug: "行動宣言1文に統合" },
  { re: /ご(?:入居|検討|内覧|確認|来店|来社|契約|利用|移転)され(?:る|ます|た|て)/, code: "DOUBLE_KEIGO", msg: "二重敬語「ご〜される」", sug: "「ご入居の場合」「ご検討のタイミング」等に変更" },
  { re: /^[^\n]{1,12}さん[、,\s]*(?:はい|かしこまりました)/m, code: "NAME_BEFORE_OPENING", msg: "開口語の前に名前を置かない（「〇〇さんはい！！」は禁止）", sug: "「はい😊！！」単独行で始める" },
  { re: /審査を進めさせて/, code: "BANNED_WORD", msg: "審査の主体は管理会社（「審査を進め」はスタッフ常用句だが要確認）", sug: "「お申込み手続きを進めさせて頂きます」に変更" },
  { re: /申し訳(?:ございません|ありません|御座いません)|ご迷惑(?:を)?おかけ|残念ながら|大変恐縮ですが/, code: "NEGATIVE_APOLOGY", msg: "ネガ文脈（否決・募集終了・断り）での謝罪・ネガ語は禁止", sug: "謝罪・ネガ語を削除し「ご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます」等のサポート継続宣言に変更（呼びかけは確定名のみ）", onlyTpo: /ネガ文脈|内覧キャンセル|顧客自身の断り/, histRe: /否決|審査(?:落ち|に通らな|の結果)|募集(?:終了|停止)|埋まって|他社で決め|キャンセル/, blockAlways: true },
  // 2026-09-08 語彙タイミング: 見積書提示前の初期費用金額断定（見積送付済みなら免除）
  { re: /初期費用(?:は|が)?[^\n。]{0,6}(?:約|およそ|大体|だいたい)?[0-9０-９]{1,3}(?:万|,000)円?(?:程度|ほど|くらい|前後)/, code: "COST_ASSERTION_NO_ESTIMATE", msg: "見積書提示前の初期費用金額の断定（物件ごとに礼金・保証料が異なる）", sug: "「お部屋が決まりましたら最大限割引したお見積書をお送りします」に変更", skipIfHistRe: /見積書(?:を)?お送り(?:させて(?:頂|いただ)きました|しました)|ご査収/, blockAlways: false },
];

function runDeterministicExtras(text: string, ctx: FinalCheckContext): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const tpo = ctx.tpoLabel ?? "";
  const cust = ctx.lastCustomerMessage ?? "";
  const staffHist = lastStaffTexts(ctx, 6);
  const custHist = lastCustomerTexts(ctx, 4);
  const allHist = `${staffHist}\n${custHist}\n${cust}`;
  const sevAuto = (): CheckSeverity => (ctx.isAutoSend ? "block" : "warning");
  const push = (pass: CheckPass, severity: CheckSeverity, code: string, message: string, evidence: string, suggestion: string) =>
    issues.push({ pass, severity, code, message, evidence, suggestion });

  // E1 文脈付き禁止パターン（NEGATIVE_APOLOGY は onlyTpo でネガ文脈限定 → 不安対応の1文謝罪と競合しない）
  for (const p of BANNED_PATTERNS) {
    if (p.onlyTpo && !p.onlyTpo.test(tpo) && !(p.histRe && p.histRe.test(allHist))) continue;
    if (p.skipIfHistRe && p.skipIfHistRe.test(allHist)) continue;
    const m = text.match(p.re);
    if (m) push("rule_check", p.blockAlways ? "block" : sevAuto(), p.code, p.msg, m[0], p.sug);
  }
  // E2 システムマーカー漏れ・「」不均衡
  const marker = text.match(/<<<[^\n]{0,20}|>>>|\[AIX誘導中\]|__SHOWN__|\{\s*"[a-z_]+"\s*:/);
  if (marker) push("rule_check", "block", "SYSTEM_MARKER_LEAK", "システム用マーカー・JSONが本文に混入しています", marker[0], "マーカー以降を削除");
  // 内部指示の地の文（「〜する場面です」等）が本文に漏れた行。スタッフ実送信6,090通中0件
  const metaLine = text.match(META_NARRATION_LINE_RE);
  if (metaLine) push("rule_check", "block", "SYSTEM_MARKER_LEAK", "AIへの内部指示（場面の説明）が本文に混入しています", metaLine[0].trim(), "この行を削除");
  if ((text.match(/「/g) ?? []).length !== (text.match(/」/g) ?? []).length)
    push("rule_check", "warning", "QUOTE_UNBALANCED", "「」の対応が取れていません（返信全体を括った名残）", text.slice(0, 20), "不要な「」を削除");
  // E3 絵文字ルール（😊😌🌟✨のみ・合計2個以内・同一絵文字1回）
  const emojis = (text.match(/\p{Extended_Pictographic}/gu) ?? []).filter((e) => !/[！!？?©®™]/.test(e));
  const disallowed = emojis.filter((e) => !ALLOWED_EMOJI.has(e));
  if (emojis.length > 2 || disallowed.length > 0 || new Set(emojis).size !== emojis.length)
    push("rule_check", "warning", "EMOJI_RULE_DET", `絵文字が${emojis.length}個（許可外: ${disallowed.join("") || "なし"}／重複: ${new Set(emojis).size !== emojis.length ? "あり" : "なし"}）`, emojis.join(""), "😊😌🌟✨のみ・合計2個以内・同一絵文字は1回");
  // E4 短い了承なのに直前約束の復唱 WE DO が無い（WAIT 免除とは独立に評価）
  //    G26: 根拠の無い確認約束は復唱 WE DO に数えない（verdict は生成側と同一）
  //    2026-09-11 統合設計（経路E5/B・🐥事例）: 旧実装は tpo に「短い了承」があるだけで発火し（「感謝返し（短い了承・感謝メッセージ）」にも一致）、
  //    台帳に約束が無くても「〇〇ピックアップ出来次第お送り」を足せと指示していた（〇〇 リテラルの供給源・UNPROMPTED_PROPOSAL と逆向き）。
  //    台帳に未履行の約束がある時だけ発火し、suggestion は約束種別から顧客名スロット済みで組む
  {
    const { pair: pe, ledger: le } = resolveReplyContext(ctx);
    const kind = le.facts.pickupPromisedUnfulfilled ? "pickup" : pe.staff.kind === "confirmation_promise" || le.facts.confirmationPromisedUnfulfilled ? "confirmation" : null;
    if (/^短い了承/.test(tpo) && kind && !ACTION_DECL_RE.test(stripUnbackedConfirmPromise(text, getConfirmVerdict(ctx)).replace(BOILERPLATE_RE, "")))
      push("context_check", sevAuto(), "PROMISE_ECHO_MISSING", "短い了承の場面ですが、台帳にある未履行の約束の復唱がありません", text.trim().slice(0, 30),
        kind === "pickup"
          ? fillPairPlaceholders("「{name}にオススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！」を1文復唱する", pe)
          : "直前スタッフ発言の確認約束を対象語のまま「〜確認出来次第ご連絡させて頂きます！！」の1文で復唱する");
  }
  // E5 見積書の文脈外持ち出し（2026-09-08 Fable5 verdict 一本化）
  //   生成側と同じ verdict（isMisumoriContextAppropriate）を参照。verdict 無し（check-reply 経路）は共有 RE でフォールバック。
  //   解禁は「顧客の費用質問／見積依頼／特定物件送付／送付済み物件への前向き反応／直前スタッフ約束の復唱」のみ（state 非依存）。
  //   物件未送付・条件フォームは isAutoSend に関係なく block（UI が止めるのは block のみ）。
  {
    const v = ctx.estimateContext ?? null;
    let allowed: boolean;
    let sev: "block" | "warning";
    let why: string;
    if (v) {
      allowed = v.mode !== "forbid";
      sev = v.severity;
      why = `${v.reason}（trigger=${v.trigger} / ${v.signals.join(",")}）`;
    } else {
      const custForEst = customerTextsForBan(ctx);
      const staffRecent = lastStaffTexts(ctx, 2);
      const sentN = sentCountOf(ctx); // 2026-09-09 行動台帳に統一
      // 2026-09-10 Fable5 あみ事例: 顧客の物件持込「予告」（まだ届いていない）も業務フロー上の解禁条件
      //   （届き次第 募集状況確認＋最大限割引の御見積書。estimate-context の customer_will_send_property と同一判定）
      const wsFallback = CUST_WILL_SEND_SELF_PRED(cust);
      const wsObj = classifyWillSendObject(cust);
      allowed =
        CUSTOMER_ESTIMATE_INTENT_RE.test(custForEst) ||
        CUSTOMER_PROPERTY_REF_RE.test(custForEst) ||
        (wsFallback.yes && wsObj !== "condition" && wsObj !== "document") ||
        (sentN > 0 && CUSTOMER_PROPERTY_POSITIVE_RE.test(custForEst)) ||
        STAFF_ESTIMATE_PROMISE_RE.test(staffRecent);
      sev = sentN === 0 ? "block" : "warning";
      why = "お客様の費用質問・見積依頼・特定物件送付・持込予告・前向き反応・直前スタッフ約束のいずれも無い";
    }
    if (ESTIMATE_RE.test(text) && !allowed) {
      push("context_check", sev === "block" ? "block" : sevAuto(), "ESTIMATE_NO_TRIGGER",
        `${why}のに御見積書の作成・送付を宣言しています（⑦初期費用は項目ラベル）`,
        firstSentenceAround(text, ESTIMATE_RE), "ピックアップ宣言または短い受付文に置き換える");
    }
    // echo_only なのに新規作成宣言形 → 二重宣言
    if (v?.mode === "echo_only" && /見積(?:書|り|もり)?[^\n。]{0,12}(?:作成して|作成し|作成いたし|お作りし)/.test(text)) {
      push("context_check", sevAuto(), "ESTIMATE_REPEAT_PROMISE",
        "見積書は既に約束／送付済みなのに新規の作成宣言を繰り返しています",
        firstSentenceAround(text, ESTIMATE_RE), "「お見積書はお送りさせて頂きますね」の復唱または短い受付文に変更");
    }
  }
  // E6 退去予定・入居中物件への内覧誘導
  //    G10（2026-09-08 Fable5）: 判定対象は moveOutEvidenceText（スタッフ行全採用／顧客行は現住居の退去句を伏字化し提案物件への言及が残る行のみ）。
  //    顧客の「今の家は3月末退去予定です」（入居時期情報）で提案物件を退去予定扱いにしない（route.ts detectPropertyStatus と同名）
  const moveOutHist = moveOutEvidenceText(
    `${staffHist}\n${custHist.split("\n").filter(Boolean).map((l) => `お客様:${l}`).join("\n")}`, cust,
  );
  // 2026-09-12 竹内方針A-3（60b75de8）:
  //   ・検索宣言「ご内覧可能なお部屋探させて頂きます」は内覧誘導ではない（な/る＋お部屋・物件 を除外）
  //   ・直近スタッフ5件で内覧可が明示済みなら解除（route.ts detectPropertyStatus と同じ isMoveOutReleased）
  //   ・退去予定の根拠の号室と本文の号室が別なら適用しない（会話単位の情報をメッセージ判定に使わない）
  if (/退去予定|[0-9０-９]{1,2}月退去|退去後|入居中|退去前/.test(moveOutHist) &&
      /(?:ご都合よろしい|今週末|いつでも)[^\n。]{0,15}ご案内|内覧(?:でき|出来|可能)(?!ません|ない|次第|な(?:お部屋|物件)|る(?:お部屋|物件))/.test(text) &&
      !/以降(?:に|は)?(?:ご案内|ご内覧)|退去後(?:に)?ご案内|先に(?:抑|押さ)え/.test(text) &&
      !isMoveOutReleased(lastStaffTexts(ctx, 5)) &&
      !moveOutRoomMismatch(moveOutHist, text))
    push("context_check", "block", "VIEWING_BEFORE_VACANCY", "退去予定・入居中物件に対して現時点での内覧誘導をしています", firstSentenceAround(text, /ご案内|内覧/), "「[退去予定日]以降にご案内可能」または「お申込みで先に押さえてからご内覧」に変更");
  // E6' G10 現住居の退去・引越し報告（探索継続）に対する会話終了返信（離脱と誤読）
  if (ctx.moveOutSubject === "current_home" &&
      /またお部屋探しの際は|この度はありがとうございました|ご縁があり|またのご縁|またの機会|お気をつけて|お元気で/.test(text))
    push("context_check", "block", "FAREWELL_ON_MOVEOUT_INFO",
      "お客様の現住居の退去・引越し報告（入居時期情報）を離脱と誤読し、会話終了の返信をしています",
      firstSentenceAround(text, /またお部屋探し|この度は|ご縁|またの機会|お気をつけて|お元気で/),
      "退去時期を復唱し「〇月ご入居に間に合うようピックアップさせて頂きます」の探索継続宣言に変更");
  // E7 意思確認前の申込宣言／申込後の内覧・写真提案
  if (/お申込(?:み)?(?:を)?(?:入れ|させて(?:頂|いただ)き|いたし)ま/.test(text) && !CUSTOMER_APPLY_DECL_RE.test(`${custHist}\n${cust}`) && !/申込/.test(tpo))
    push("context_check", sevAuto(), "APPLY_WITHOUT_INTENT", "お客様の申込意思が履歴に無いのに申込を入れる宣言をしています", firstSentenceAround(text, /お申込/), "「お気に召されましたらお申込みでお部屋押さえさせて頂きます」の条件付き提案に変更");
  if (/申込後説明|申込打診/.test(tpo) && /(?:内覧|ご案内)(?:を)?(?:お勧め|オススメ|いかが)|物件(?:の)?写真(?:を)?お送り/.test(text))
    push("context_check", "warning", "POST_APPLY_VIEWING", "申込フェーズで内覧・物件写真の提案をしています", firstSentenceAround(text, /内覧|ご案内|写真/), "審査・書類・見積の案内に置き換える");
  // E8 時制ミス／感想先取り
  if (/(?:拝見|確認|見て)(?:します|させて(?:頂|いただ)きます|みます|おきます)/.test(cust) && /ご覧(?:頂|いただ)きありがとう|ご確認(?:頂|いただ)きありがとう/.test(text))
    push("context_check", sevAuto(), "TENSE_MISMATCH", "お客様はこれから見る（未来形）のに見終わった扱いにしています", firstSentenceAround(text, /ご覧|ご確認/), "「お手隙の際にご査収ください」に変更");
  if (/気になるお部屋(?:は)?(?:ございました|ありました)|いかがでしたか|ご感想/.test(text) && !/見ました|拝見しました|確認しました|見てきました|内覧(?:しました|してきました)|気に入|良さそう|いいですね|微妙|狭い|遠い|どうでした/.test(cust))
    push("context_check", sevAuto(), "FEEDBACK_PREMATURE", "お客様がまだ見ていない・反応していない段階で感想を聞いています", firstSentenceAround(text, /気になる|いかが|ご感想/), "感想確認を削除しWE DO継続宣言に変更");
  // E9 スタッフが確定日時を提示済みの後の「ご都合よろしいお日にち」再質問
  if (GOCHOUGO_RE.test(text) && /[0-9０-９]{1,2}[\/／月][0-9０-９]{1,2}[^\n]{0,14}(?:ご案内|お待ち|でお願い|確定|決定)|(?:ご案内|内覧)(?:日|の日程)(?:は|が)?[^\n]{0,8}(?:確定|決ま)/.test(lastStaffTexts(ctx, 2)))
    push("context_check", sevAuto(), "GOCHOUGO_AFTER_FIXED", "内覧日時が確定済みなのに再度「ご都合よろしいお日にち」を尋ねています", firstSentenceAround(text, GOCHOUGO_RE), "確定日時をそのまま書く");
  // E10 フェーズ別禁止事項（生成側 PHASE_PROHIBITIONS と同一定義 — A-8・2026-09-08 語彙タイミング拡張）
  //   state × 顧客トリガー（FORM_LABEL_RE 除去後の顧客直近4件＋最新）× 直前スタッフ約束（直近2件）で解禁判定。
  //   語彙タイミング ban は code TIMING_VOCAB_MISMATCH、従来の state 逆行 ban は STATE_REGRESSION（両方 assignSeverity で block 維持）。
  const def = ctx.phaseKey ? PHASE_PROHIBITIONS[ctx.phaseKey as keyof typeof PHASE_PROHIBITIONS] : undefined;
  if (def) {
    const custAll = customerTextsForBan(ctx);
    const staffRecent = lastStaffTexts(ctx, 2);
    const v = ctx.estimateContext ?? null;
    for (const b of def.bans) {
      // 見積 ban は verdict 一本化: forbid 以外はスキップ（E5 が担当）。forbid でも severity は verdict に従う
      const isEstimateBan = b.code === "TIMING_VOCAB_MISMATCH" && b.re.source === ESTIMATE_RE.source;
      if (isEstimateBan && v) {
        if (v.mode !== "forbid") continue;
        const m = text.match(b.re);
        if (!m) continue;
        push("rule_check", v.severity === "block" ? "block" : sevAuto(), "TIMING_VOCAB_MISMATCH",
          `【${def.label}】${b.why}: 「${m[0]}」（${v.reason}）`, m[0], b.fix);
        continue;
      }
      if (b.onlyIf && !b.onlyIf({ sentPropertiesCount: sentCountOf(ctx) })) continue;
      const m = text.match(b.re);
      if (!m) continue;
      if (b.allowIfCustomerAsked && /他(の|にも)?(物件|お部屋)|別の(物件|お部屋)|申(し)?込(み)?(たい|します|お願い)|内覧(したい|お願い)|見てみたい/.test(cust)) continue;
      if (b.allowIfCustomerRe && b.allowIfCustomerRe.test(custAll)) continue;
      if (b.allowIfStaffRe && b.allowIfStaffRe.test(staffRecent)) continue;
      push("rule_check", b.severity === "block" ? "block" : sevAuto(), b.code ?? "STATE_REGRESSION", `【${def.label}】${b.why}: 「${m[0]}」`, m[0], b.fix);
    }
  }
  return issues;
}

// ─── 語彙タイミング（E5/E10）用ヘルパー（2026-09-08）────────────────────────────────
// prompts.ts ESTIMATE_WORD_RE と同一定数（E10 の見積 ban 判定は b.re.source 比較で行うため）
const ESTIMATE_RE = ESTIMATE_WORD_RE;
/** 顧客側テキスト（直近4件＋最新）。条件フォームの項目ラベル（⑦初期費用 等）を除去してから照合する */
function customerTextsForBan(ctx: FinalCheckContext): string {
  return `${lastCustomerTexts(ctx, 4)}\n${ctx.lastCustomerMessage ?? ""}`.replace(FORM_LABEL_RE, "");
}

// ─── 語彙セマンティクス（主語・方向・前提）決定論チェック（2026-09-08 Fable5）─────────────
// 「撮影出来次第お送り」「ご都合よろしいお日にちに撮影」等の誤用は、文脈非依存の禁止語では捕捉できない
// （語そのものは正しい場面で使われる）。会話履歴（直近スタッフ発言・顧客発言）と照合して前提の有無を判定する。
// 生成側 prompts VOCAB_SEMANTICS / few-shot 前提フィルタ（route.ts fetchExamples）と同名の条件（三者同名）。
// recentMessages は oldest-first（route.ts と同順）。直近N件は必ず slice(-N) で取る。
const GOCHOUGO_RE = /ご都合(?:の)?(?:よろしい|宜しい|良い|よい)(?:お)?(?:日にち|日|お?時間|タイミング)/;
const STAFF_TASK_AFTER_GOCHOUGO_RE = /ご都合(?:の)?(?:よろしい|宜しい|良い|よい)(?:お)?(?:日にち|日)に[^。！!\n]{0,12}?(撮影|確認|お送り|送付|作成|お見積|見積|ピックアップ|お調べ)/;
const GOCHOUGO_REVERSED_RE = /ご都合(?:の)?(?:よろしい|宜しい|良い|よい)(?:お)?(?:日にち|日)(?:を|は)?[^。！!\n]{0,6}?(?:お伝え|お知らせ)(?:させて(?:頂|いただ)き|いたし|致し|し)ま/;
const GOCHOUGO_GUIDE_RE = /ご都合(?:の)?(?:よろしい|宜しい|良い|よい)(?:お)?(?:日にち|日)に[^。！!\n]{0,12}?(?:ご案内|ご内覧|内覧)/;
const CONDITION_CLAUSE_RE = /お気に召|気に入って|気になる|ご希望(?:でしたら|の際|があれば)|よろしければ/;
const QUESTION_FORM_RE = /(?:でしょうか|ますか|ございますか|御座いますか|お知らせください|お聞かせください|教えて(?:ください|頂け|いただけ))/;
const CUSTOMER_DATE_RE = /(?:[0-9０-９]{1,2}\s*[\/／月]\s*[0-9０-９]{1,2}|[0-9０-９]{1,2}日|[0-9０-９]{1,2}時|明日|明後日|今日|本日|今週|来週|週末|土日|平日|午前|午後|以降|(?:月|火|水|木|金|土|日)曜)/;
const CUSTOMER_CONFIRM_RE = /確認(?:します|しておきます|して(?:みます|おきます|また|から)|させて(?:頂|いただ)きます|いたします)|見ておきます|見てみます|目を通し/;
// G26（2026-09-08 Fable5）: confirmation-context.ts と同一定数（四者同名: 生成・bridge・検査・修正ループ guard）
const CONFIRM_NEXT_RE = SHARED_CONFIRM_NEXT_RE;
// CONFIRM_OBJECT_LABELS（confirmation-context.ts）のラベル語と整合させる（ご入居可能日・ペット・駐車場・保証会社・設備・鍵・交渉）
const CONFIRM_OBJECT_RE = /募集状況|空室|空き|内覧可能|内見可能|割引|番手|管理会社|貸主|オーナー|入居可能|ご入居可能日|退去|審査|暗証番号|条件|可否|ペット|駐車場|保証会社|設備|鍵|交渉|(?:について|の件|を)確認/;
const PHOTO_RE = /撮影/;
// A-11: スタッフ側前提から「写真」単独を外す（「物件写真を送付しました」は撮影約束ではない）
const PHOTO_PREMISE_RE = /撮影|動画|オンライン内見|オンライン内覧|ビデオ通話|室内(?:を)?(?:撮|見せ)|写真(?:を)?(?:撮|撮影)/;
const CUSTOMER_PHOTO_WANT_RE = /写真|動画|撮影|オンライン|内見(?:でき|出来)ません|行けな|遠方|見に行けな/;
const SATSUEI_SUBST_RE = /(?:内見|内覧|見)(?:したい|に行きたい|できますか|出来ますか|は?できない|は?出来ない|はできないんですか)/;
// 2026-09-09 行動台帳: 旧 SENT_CLAIM_RE（V9）は action-ledger DONE_PRESUPPOSING_VOCAB.prior_sent_claim（同名 code UNSENT_CLAIM）に統合。写真のみ従来の staffHist 判定を残す
const SENT_PHOTO_CLAIM_RE = /(?:先ほど|先程|先日)?お送り(?:させて(?:頂|いただ)い|し)た(?:お)?写真/;
const JUSHU_RE = /ご査収/;
const SELF_HONORIFIC_RE = /ご確認(?:した|しました)(?:通り|とおり|ところ)/;
const GUIDE_POSSIBLE_RE = /ご案内可能です/;
const GUIDE_DATE_RE = /[0-9０-９]{1,2}\s*[\/／月]\s*[0-9０-９]{1,2}|[0-9０-９]{1,2}[:：時]/;
const SASETE_RE = /させて(?:頂|いただ)/g;
const APPLY_PUSH_RE = /お申込みで(?:お部屋)?(?:抑え|押さえ)|お申込みという形/;
const CUSTOMER_APPLY_INTENT_RE = /申込|申し込|申請|決め|押さえ|抑え|内覧(?:しました|に行きました|行ってきました)|見てきました/;

function lastStaffTexts(ctx: FinalCheckContext, n: number): string {
  // oldest-first 前提。直近 n 件のスタッフ発言を結合（AIX 送付文も含む）
  return (ctx.recentMessages ?? []).filter((m) => m.sender === "staff").slice(-n).map((m) => m.text).join("\n");
}
function lastCustomerTexts(ctx: FinalCheckContext, n: number): string {
  return (ctx.recentMessages ?? []).filter((m) => m.sender !== "staff").slice(-n).map((m) => m.text).join("\n");
}
/** G26: 確認約束 verdict。generate-reply 経路は同一オブジェクト（ctx.confirmationContext）、check-reply 経路は ctx から再計算（厳格側に倒れる） */
function getConfirmVerdict(ctx: FinalCheckContext): ConfirmationContextVerdict {
  return ctx.confirmationContext ?? resolveConfirmationContext({
    customerMessage: ctx.lastCustomerMessage ?? "",
    lastStaffMessage: lastStaffTexts(ctx, 1),
    brainAction: ctx.brainMeta?.action ?? null,
    activeTaskTypes: ctx.activeTaskTypes ?? null,
    conversationObjects: { propertyNames: resolveLedger(ctx).facts.propertiesSentNames },
  });
}
/** 2026-09-11 §5.2（E5-m・V5/V6）: 確認宣言の対象語が会話に実在するか。宣言文（「〇〇確認させて頂きます」）と「確認出来次第」の2文を1組で読み、
 *  対象語のトークンが顧客の未返信発言・直近の会話・台帳の送付済み物件名のどれかにあれば、その対象語を返す（無ければ null） */
const CONFIRM_GENERIC_TOKEN_RE = /^(?:募集状況|空室状況|空室|状況|確認|初期費用|費用|お部屋|物件|ご内覧|内覧|管理会社|オーナー|貸主|ご連絡|お見積書|御見積書|見積書|見積|可否|条件|詳細|お送り|のご案内|ご案内)$/;
function replyAnchoredConfirmObject(text: string, ctx: FinalCheckContext): string | null {
  const phrases: string[] = [];
  for (const m of text.matchAll(new RegExp(CONFIRM_DECL_WITH_OBJECT_RE.source, "g"))) phrases.push(m[1]);
  for (const m of text.matchAll(/([^\n。！!]{2,30}?)(?:を|の)?(?:管理会社(?:様)?に)?確認(?:でき|出来|し)次第/g)) phrases.push(m[1]);
  if (phrases.length === 0) return null;
  const hay = [
    ctx.lastCustomerMessage ?? "",
    ...(ctx.recentMessages ?? []).map((m) => m.text),
    ...resolveLedger(ctx).facts.propertiesSentNames,
  ].join("\n").normalize("NFKC");
  for (const p of phrases) {
    const tokens = (p.normalize("NFKC").match(/[0-9]{1,2}月[0-9]{1,2}日|[0-9]{1,2}\/[0-9]{1,2}|[0-9]{2,4}|[一-龯々ァ-ヶーA-Za-z]{2,}/g) ?? [])
      .filter((t) => !CONFIRM_GENERIC_TOKEN_RE.test(t));
    const hit = tokens.find((t) => hay.includes(t) || (/^[0-9]{1,2}月[0-9]{1,2}日$/.test(t) && hay.includes(t.replace(/月/, "/").replace(/日$/, ""))));
    if (hit) return p.trim();
  }
  return null;
}
function firstSentenceAround(text: string, re: RegExp): string {
  const m = text.match(re);
  if (!m || m.index === undefined) return text.slice(0, 40);
  const start = Math.max(0, text.lastIndexOf("\n", m.index), text.lastIndexOf("。", m.index));
  const endCandidates = [text.indexOf("\n", m.index), text.indexOf("。", m.index)].filter((i) => i >= 0);
  const end = endCandidates.length ? Math.min(...endCandidates) : text.length;
  return text.slice(start, end).trim() || text.slice(0, 40);
}

export function runVocabSemanticChecks(text: string, ctx: FinalCheckContext): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const cust = ctx.lastCustomerMessage ?? "";
  const staffHist = lastStaffTexts(ctx, 6);
  const custHist = lastCustomerTexts(ctx, 4);
  const blockOrWarn = (b: boolean): CheckSeverity => (b ? "block" : "warning");

  // V1 ご都合よろしいお日にち＋スタッフ作業（撮影・確認・お送り…）— 都合の持ち主逆転
  if (STAFF_TASK_AFTER_GOCHOUGO_RE.test(text)) {
    issues.push({ pass: "rule_check", severity: "block", code: "GOCHOUGO_STAFF_TASK",
      message: "「ご都合よろしいお日にちに」をスタッフ側の作業（撮影・確認・お送り等）に接続しています。お客様の都合はお客様の行為（内覧）にのみ使います",
      evidence: firstSentenceAround(text, STAFF_TASK_AFTER_GOCHOUGO_RE),
      suggestion: "「ご都合よろしいお日にちに」を削除し「撮影出来次第お送りさせて頂きます」「確認出来次第ご連絡させて頂きます」等スタッフ主語の文にする" });
  }
  // V2 ご都合よろしいお日にちをお伝えさせて頂きます — 主語逆転
  if (GOCHOUGO_REVERSED_RE.test(text)) {
    issues.push({ pass: "rule_check", severity: "block", code: "GOCHOUGO_REVERSED",
      message: "お客様の都合をスタッフが「お伝え／お知らせ」する形になっています（主語逆転）",
      evidence: firstSentenceAround(text, GOCHOUGO_REVERSED_RE),
      suggestion: "「ご都合よろしいお日にち御座いますでしょうか！！」に変更" });
  }
  // V3 条件節も疑問形も無い「ご都合よろしいお日にちにご案内」— 内覧の押し付け／未送付での内覧誘導
  if (GOCHOUGO_GUIDE_RE.test(text)) {
    const sent = firstSentenceAround(text, GOCHOUGO_GUIDE_RE);
    const hasCondition = CONDITION_CLAUSE_RE.test(sent);
    const hasQuestion = QUESTION_FORM_RE.test(text);
    // A-11: sentPropertiesCount の実値のみで判定（履歴の「物件」「お部屋」語は約束文にも出るため根拠にしない）。2026-09-09 行動台帳に統一
    const noPropertySent = sentCountOf(ctx) === 0;
    if (noPropertySent) {
      issues.push({ pass: "context_check", severity: "block", code: "GUIDE_BEFORE_PROPERTY",
        message: "物件を1件も送っていない段階で内覧案内を宣言しています（順番が逆）",
        evidence: sent, suggestion: "内覧誘導文を削除し「ピックアップ出来次第お送りさせて頂きます」に変更" });
    } else if (!hasCondition && !hasQuestion) {
      issues.push({ pass: "rule_check", severity: blockOrWarn(!!ctx.isAutoSend), code: "GOCHOUGO_NO_CONDITION",
        message: "「ご都合よろしいお日にちにご案内」がお客様の選択条件（お気に召されましたら）も日程質問も無く単独で置かれています（内覧の押し付け・会話が進まない）",
        evidence: sent,
        suggestion: "「お気に召されましたらご都合よろしいお日にち御座いますでしょうか！！ご案内させて頂きます😊！！」に変更" });
    }
  }
  // V4 お客様が候補日・確定日を伝えた後の「ご都合よろしいお日にち」再質問
  //    A-11: 日付語＋意向語（希望・行けます・大丈夫・お願い 等）の共起を要求（「明日確認します」等の単なる日付言及で誤発火していた）
  const custDateIntent = CUSTOMER_DATE_RE.test(cust) && /希望|行け|伺え|大丈夫|お願い|空い|都合|なら|でお願い|がいい|にし/.test(cust);
  if (GOCHOUGO_RE.test(text) && custDateIntent && !/(?:以降|または|又は|か)[^。\n]{0,20}ご都合/.test(text)) {
    issues.push({ pass: "context_check", severity: blockOrWarn(!!ctx.isAutoSend), code: "GOCHOUGO_AFTER_DATE",
      message: "お客様が既に日程（候補日・確定日）を伝えているのに再度「ご都合よろしいお日にち」を尋ねています",
      evidence: firstSentenceAround(text, GOCHOUGO_RE),
      suggestion: "お客様の伝えた日をそのまま復唱し「〇日でご都合よろしいお時間御座いますでしょうか」または確定日時の宣言に変更" });
  }
  // V5/V6 確認約束の主語・対象（G26 2026-09-08 Fable5: verdict は生成側 resolveConfirmationContext と同一オブジェクト。
  //    旧 V6 は「本文か顧客文に対象語があれば可」の語出現判定＋warning だったため、顧客「よろしくお願いします」への
  //    「確認出来次第ご連絡」（創作約束）が素通りしていた。verdict.allowed=false は CONFIRM_NO_OBJECT を block に昇格）
  // 2026-09-11 §5.2（E5-m）: 物件を探す約束（「お部屋確認でき次第お送り」）は確認約束から除く（ピックアップ宣言として扱う）
  const textForConfirm = text.replace(new RegExp(`[^\\n。！!]*${SEARCH_CONFIRM_RE.source}[^\\n。！!]*`, "g"), "");
  const confirmHitRe = CONFIRM_NEXT_RE.test(textForConfirm) ? CONFIRM_NEXT_RE : CONFIRM_PROMISE_SENTENCE_RE.test(textForConfirm) ? CONFIRM_PROMISE_SENTENCE_RE : null;
  if (confirmHitRe) {
    const verdict = getConfirmVerdict(ctx);
    const confirmSentence = firstSentenceAround(textForConfirm, confirmHitRe);
    // 「〇〇確認させて頂きます！！\n確認出来次第ご連絡させて頂きます！！」の2文を1組で読む（直前の行も対象の記載とみなす）
    const confirmPair = (() => {
      const idx = textForConfirm.indexOf(confirmSentence);
      const before = idx > 0 ? textForConfirm.slice(0, idx).split(/[\n。]/).filter((s) => s.trim()).slice(-1)[0] ?? "" : "";
      return `${before}\n${confirmSentence}`;
    })();
    // A-11: 管理会社確認文脈（「管理会社に確認でき次第」「募集状況確認出来次第」）は主語奪取から免除
    const isMgmtConfirmCtx = /管理会社|オーナー|貸主|募集状況|空室|空き|番手|入居可能|退去/.test(confirmPair);
    if ((verdict.source === "customer_self_confirm" || CUSTOMER_CONFIRM_RE.test(cust)) && !isMgmtConfirmCtx && !verdict.allowed) {
      issues.push({ pass: "context_check", severity: "block", code: "CONFIRM_SUBJECT_THEFT",
        message: "お客様が「確認します」と言っています。確認の主語はお客様であり、スタッフの「確認でき次第ご連絡」は主語混乱です",
        evidence: confirmSentence,
        // 2026-09-11 統合設計（経路B）: 〇〇 リテラルを出さない（名前は確定名のみ・無ければ呼びかけなし）
        suggestion: `「お手隙の際にご査収ください！！」に変更（確認の主語はお客様）${ctx.lastCustomerMessage && resolveReplyContext(ctx).ledger.facts.pickupPromisedUnfulfilled ? `。未履行のピックアップ約束があれば「${fillNameSlot("私の方でも{name}にオススメできるお部屋ピックアップ出来次第お送りさせて頂きます！！", ctx.customerName ?? "")}」を続ける` : ""}` });
    } else if (!verdict.allowed) {
      // 2026-09-11 §5.2（E5-m）: 返信に書いた確認対象が会話に実在する（敷金礼金なしのお部屋・86、87…番・8月7日のご内覧・クレール元町203号室 等）なら
      //   創作約束ではない → block せず info（reply_anchored_object）。対象が会話に無い確認約束は従来どおり block
      const anchored = replyAnchoredConfirmObject(textForConfirm, ctx);
      if (anchored) {
        issues.push({ pass: "context_check", severity: "info", code: "CONFIRM_NO_OBJECT",
          message: `確認対象「${anchored.slice(0, 24)}」が会話に実在するため許容（reply_anchored_object・${verdict.reason}）`,
          evidence: confirmSentence, suggestion: "対象語が会話にある確認約束として許容" });
      } else {
        issues.push({ pass: "context_check", severity: "block", code: "CONFIRM_NO_OBJECT",
          message: `確認対象が会話文脈に存在しないのに確認を約束しています（創作約束・${verdict.reason}）`,
          evidence: confirmSentence,
          suggestion: "確認約束文を削除する（直前スタッフ発言に約束があればその対象語のままの復唱に置き換える。新しい約束・固有名詞は足さない）" });
      }
    } else if (verdict.object && !CONFIRM_OBJECT_RE.test(confirmPair)) {
      issues.push({ pass: "rule_check", severity: ctx.isAutoSend ? "block" : "warning", code: "CONFIRM_OBJECT_UNSTATED",
        message: `確認対象「${verdict.object}」が確認約束の文に書かれていません`,
        evidence: confirmSentence,
        suggestion: `「${verdict.object}確認させて頂きます！！確認出来次第ご連絡させて頂きます！！」のように対象を前置する` });
    }
  }
  // V7 前提の無い「撮影」— 履歴（スタッフ約束 or 顧客希望）に撮影・写真・動画が無い
  if (PHOTO_RE.test(text) && !PHOTO_PREMISE_RE.test(staffHist) && !CUSTOMER_PHOTO_WANT_RE.test(custHist + "\n" + cust)) {
    issues.push({ pass: "context_check", severity: "block", code: "PHOTO_NO_PREMISE",
      message: "会話履歴に撮影・写真・動画の約束もお客様の希望も無いのに「撮影」を持ち出しています（実例の文脈外流用）",
      evidence: firstSentenceAround(text, PHOTO_RE),
      suggestion: "「撮影」を含む文を削除し、直前のスタッフ約束があればその対象語のままの復唱に変更する（新しい約束・固有名詞は足さない）" });
  }
  // V8 お客様の「内見したい」を撮影・動画送付に置き換え
  if (PHOTO_RE.test(text) && SATSUEI_SUBST_RE.test(cust) && !/(?:内覧|内見)(?:不可|できません|出来ません|が難しい)/.test(text)) {
    issues.push({ pass: "context_check", severity: "block", code: "PHOTO_REPLACES_VIEWING",
      message: "お客様は自分で内覧したいと言っています。スタッフの撮影・動画送付に置き換えず「ご案内させて頂きます」で受けてください",
      evidence: firstSentenceAround(text, PHOTO_RE),
      suggestion: "「開始次第お部屋ご案内させて頂きます！！」に変更（内覧不可の場合のみ理由を添えて代替提案）" });
  }
  // V9 未送付物を送済みとして言及 — 2026-09-09 行動台帳: 見積・物件は runLedgerChecks（prior_sent_claim → UNSENT_CLAIM）に統合。写真（台帳外）のみ従来判定
  {
    const m = text.match(SENT_PHOTO_CLAIM_RE);
    if (m && !/写真|画像/.test(staffHist)) {
      issues.push({ pass: "context_check", severity: "block", code: "UNSENT_CLAIM",
        message: "まだ送っていない写真を「先ほどお送りした」と送済み扱いにしています",
        evidence: m[0], suggestion: "「撮影出来次第お写真お送りさせて頂きます」の未来形に変更" });
    }
  }
  // V10 未送付での「ご査収」（2026-09-09 行動台帳: 物件送付0件 かつ 見積未送付 かつ この返信が成果物添付でない）
  {
    const lf = resolveLedger(ctx).facts;
    const isDeliverable = ctx.isDeliverableReply ?? ATTACHED_DELIVERABLE_RE.test(text);
    if (JUSHU_RE.test(text) && sentCountOf(ctx) === 0 && !lf.estimateSent && !isDeliverable && !/【画像】|お送りさせて頂きました|お送りしました|送付しました|見積/.test(staffHist)) {
      issues.push({ pass: "context_check", severity: "warning", code: "JUSHU_BEFORE_SEND",
        message: "何も送っていない段階で「ご査収ください」と書いています（査収＝受け取って確認する行為）",
        evidence: firstSentenceAround(text, JUSHU_RE), suggestion: "「ご査収」を削除し送付宣言（〜お送りさせて頂きます）に変更" });
    }
  }
  // V11 自敬表現
  if (SELF_HONORIFIC_RE.test(text)) {
    issues.push({ pass: "rule_check", severity: "warning", code: "SELF_HONORIFIC",
      message: "自分の確認行為に「ご」を付けています（自敬表現）",
      evidence: firstSentenceAround(text, SELF_HONORIFIC_RE), suggestion: "「確認しましたところ」に変更" });
  }
  // V12 日時なしの「ご案内可能です」
  if (GUIDE_POSSIBLE_RE.test(text) && !GUIDE_DATE_RE.test(firstSentenceAround(text, GUIDE_POSSIBLE_RE))) {
    issues.push({ pass: "rule_check", severity: "warning", code: "GUIDE_POSSIBLE_NO_DATE",
      message: "日時を示さない「ご案内可能です」は上から目線・丸投げの締めです（日時列挙直後のみ可）",
      evidence: firstSentenceAround(text, GUIDE_POSSIBLE_RE),
      suggestion: "「お気に召されましたらご都合よろしいお日にち御座いますでしょうか！！ご案内させて頂きます」に変更" });
  }
  // V13 させて頂く過剰（4回以上）
  const saseteCount = (text.match(SASETE_RE) ?? []).length;
  if (saseteCount >= 4) {
    issues.push({ pass: "rule_check", severity: "warning", code: "SASETE_OVERUSE",
      message: `「させて頂きます」が${saseteCount}回あります（上限3回）`,
      evidence: `させて頂く×${saseteCount}`, suggestion: "ご連絡・確認・サポート・ピックアップは「いたします」に言い換える" });
  }
  // V14 内覧・申込意思の無い顧客への即申込誘導
  //     A-11: 条件節付き（「お気に召されましたら〜押さえ」）・物件送付後TPO は免除
  const applyPushSentence = APPLY_PUSH_RE.test(text) ? firstSentenceAround(text, APPLY_PUSH_RE) : "";
  const applyPushConditional = CONDITION_CLAUSE_RE.test(applyPushSentence);
  if (APPLY_PUSH_RE.test(text) && !applyPushConditional && !/強推し直後|物件送付後/.test(ctx.tpoLabel ?? "") && !CUSTOMER_APPLY_INTENT_RE.test(custHist + "\n" + cust)) {
    issues.push({ pass: "context_check", severity: "warning", code: "APPLY_PUSH_NO_INTENT",
      message: "お客様が内覧済み・申込意思を示した履歴が無いのに「お申込みで押さえ」を提案しています",
      evidence: firstSentenceAround(text, APPLY_PUSH_RE), suggestion: "直前のお客様アクションに対応するWE DO（ピックアップ／内覧日程調整／募集状況確認）に変更" });
  }
  return issues;
}

// ─── メイン: 決定的プリチェック + 3パス並列チェック ──────────────────────────
// 絶対にthrowしない（全pass失敗でも issues=[] / passes_completed=[] の fail-open 結果を返す）
// ─── 2026-09-11 統合設計（経路G）: パスのタイムアウトを締切（deadlineAt）連動にし、落ちたパスだけ1回再送する ───
//   旧実装は固定 30s。loop2（予算60s）で1回タイムアウトすると 60000−30005 < 修正枠30000 となり、修正が1回も走らず
//   revision_exhausted が確定していた（it_0・🐥 事例）。回数上限は上げない（同じ材料での再送のみ）
export type RunCheckOpts = {
  /** 1パスの上限（従来の sonnetTimeoutMs） */
  timeoutMs?: number;
  /** このチェック全体の締切（epoch ms）。あればパスのタイムアウトは残り時間から配分する */
  deadlineAt?: number;
  /** 落ちたパス（タイムアウト / 5xx / 529）を1回だけ再送するか（既定 true） */
  retry?: boolean;
  /** パスごとのモデル上書き（check-reply は context_check を Haiku で走らせる） */
  passModels?: Partial<Record<CheckPass, string>>;
};
const PASS_CAP_MS: Record<Exclude<CheckPass, "meta">, number> = { rule_check: 20000, anomaly_scan: 15000, context_check: 25000 };
/** パスのタイムアウト配分。1回目は min(パス上限, max(10s, 残り×0.55))、再送は残り全部（ともに残り時間以内） */
export function passTimeoutMs(pass: CheckPass, remainMs: number, attempt: 0 | 1, capMs = 30000): number {
  const cap = Math.min(capMs, pass === "meta" ? capMs : PASS_CAP_MS[pass]);
  const t = attempt === 0 ? Math.min(cap, Math.max(10000, Math.floor(remainMs * 0.55))) : Math.min(cap, remainMs);
  return Math.max(0, Math.min(t, remainMs));
}
const isRetryableFailure = (e: unknown) => /timeout|aborted|\b5\d\d\b|529|overloaded/i.test(e instanceof Error ? `${e.name} ${e.message}` : String(e));
function classifyFailure(e: unknown): { reason: "timeout" | "http" | "max_tokens" | "parse" | "other"; status?: number } {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  if (/timeout|aborted/i.test(msg)) return { reason: "timeout" };
  const http = /HTTP (\d{3})/.exec(msg);
  if (http) return { reason: "http", status: Number(http[1]) };
  if (/max_tokens/.test(msg)) return { reason: "max_tokens" };
  if (/parse/i.test(msg)) return { reason: "parse" };
  return { reason: "other" };
}

export async function runFinalCheck(draft: string, ctx: FinalCheckContext, optsOrTimeout: number | RunCheckOpts = 30000): Promise<CheckResult> {
  const started = Date.now();
  const issues: CheckIssue[] = [];
  const draftNorm = normalizeForMatch(draft);
  const o: RunCheckOpts = typeof optsOrTimeout === "number" ? { timeoutMs: optsOrTimeout } : optsOrTimeout;
  const cap = o.timeoutMs ?? 30000;
  // 締切が無ければ従来どおり「1パス cap まで」（check-reply の 2300ms 等）
  const deadline = o.deadlineAt ?? started + cap + 500;
  const remain = () => deadline - Date.now() - 500;

  // ── 決定論チェック群（禁止語・本日中・THANK_OPENING・！！過剰・NG物件・自己紹介再生成・具体アクション欠落）──
  issues.push(...runDeterministicChecks(draft, ctx));

  // ── 3パス並列チェック（rule_check・anomaly_scan=Haiku / context_check=Sonnet）──
  // context_check のみ Sonnet: 10種の複雑な会話理解が必要で誤検知が revision 誤発火に直結するため
  const passes: Array<{ pass: CheckPass; prompt: PromptContent; model: string }> = [
    { pass: "rule_check",    prompt: buildRuleCheckPrompt(draft, ctx),    model: o.passModels?.rule_check ?? MODEL_CHECK_FAST },
    { pass: "anomaly_scan",  prompt: buildAnomalyScanPrompt(draft, ctx),  model: o.passModels?.anomaly_scan ?? MODEL_CHECK_FAST },
    { pass: "context_check", prompt: buildContextCheckPrompt(draft, ctx), model: o.passModels?.context_check ?? MODEL_CHECK_DEEP },
  ];
  const t0 = Date.now();
  const passMs: Partial<Record<CheckPass, number>> = {};
  const timed = (i: number, attempt: 0 | 1) => {
    const p = passes[i];
    const s = Date.now();
    return callSonnet(p.prompt, passTimeoutMs(p.pass, remain(), attempt, cap), 2400, p.model).then((v) => { passMs[p.pass] = Date.now() - s; return v; });
  };
  const settled: PromiseSettledResult<RawIssue[]>[] = await Promise.allSettled(passes.map((_, i) => timed(i, 0)));
  // 落ちたパスだけ同じプロンプトで1回再送（タイムアウト / 5xx / 529 のみ。残り 4s 未満なら再送しない）
  if (o.retry !== false) {
    const idx = settled.map((r, i) => (r.status === "rejected" && isRetryableFailure(r.reason) ? i : -1)).filter((i) => i >= 0);
    if (idx.length && remain() >= 4000) {
      console.warn("[final-check] 失敗パスを1回再送:", idx.map((i) => passes[i].pass).join(","));
      const again = await Promise.allSettled(idx.map((i) => timed(i, 1)));
      idx.forEach((i, k) => { if (again[k].status === "fulfilled") settled[i] = again[k]; });
    }
  }
  const passFailures: NonNullable<CheckResult["pass_failures"]> = [];

  const passesCompleted: CheckPass[] = [];

  settled.forEach((r, i) => {
    const pass = passes[i].pass;
    if (r.status !== "fulfilled") {
      // fail-open: 失敗passは passes_completed に載せず監査ログ＋pass_failures に記録
      console.warn(`[final-check] ${pass} 失敗（fail-open）:`, r.reason instanceof Error ? r.reason.message : String(r.reason));
      passFailures.push({ pass, ...classifyFailure(r.reason), ms: Date.now() - t0 });
      return;
    }
    passesCompleted.push(pass);
    for (const raw of r.value) {
      const evidence = (raw.evidence ?? "").trim();
      if (!evidence) continue; // 引用のない指摘は破棄（メタ認知ガード）
      const code = (raw.code ?? "UNKNOWN").trim() || "UNKNOWN";
      let severity = assignSeverity(pass, code, ctx.isAutoSend, ctx.isEarlyConversation);
      // block は evidence が本文に実在する場合のみ（実在しない引用での誤ブロックを防ぐ）
      if (severity === "block" && !draftNorm.includes(normalizeForMatch(evidence))) severity = "warning";
      issues.push({
        pass,
        severity,
        code,
        message: (raw.message ?? "").trim() || code,
        evidence,
        suggestion: (raw.suggestion ?? "").trim(),
      });
    }
  });

  // ── 2026-09-09 行動台帳: DOUBLE_DECLARATION の決定論フィルタ。台帳が「ピックアップ約束・未履行」で顧客が条件を変更した時、
  //    絞り込みを反映した宣言の再提示は二重宣言ではない（みく事例の直接機序: この warning → 修正ループが suggestion の「再度」を挿入していた）──
  //    2026-09-11 統合設計（M16）: 一般化。evidence の文が選ばれたセルのアクティブな必須要素を満たす（isCellRequiredSentence）時も除去する
  //    （生成が必須要素として書いた文を LLM が「二重宣言」と呼び、修正ループが消させる逆向きの指示を作らない）
  if (ctx.lastCustomerMessage && issues.some((i) => i.code === "DOUBLE_DECLARATION")) {
    const { pair: p0, ledger: l0 } = resolveReplyContext(ctx);
    const promiseUpdate = l0.facts.pickupPromisedUnfulfilled && (p0.customer.kind === "condition_change" || p0.customer.secondary.includes("condition_change"));
    for (let i = issues.length - 1; i >= 0; i--) {
      if (issues[i].code !== "DOUBLE_DECLARATION") continue;
      if (promiseUpdate || isCellRequiredSentence(issues[i].evidence, p0)) issues.splice(i, 1);
    }
  }

  // ── 部分未完走警告（2パス未満の場合は常に通知・自動送信時はblock）──
  if (passesCompleted.length < 2) {
    issues.push({
      pass: "meta",
      severity: ctx.isAutoSend ? "block" : "warning",
      code: "PARTIALLY_UNCHECKED",
      message: "チェックが一部完走しませんでした。送信前に内容を目視確認してください。",
      evidence: `完走パス: ${passesCompleted.join(", ") || "なし"}`,
      suggestion: "送信前に内容を目視確認してください",
    });
  }

  // ── HIGH-1: 自動送信時のfail-closed（チェック未完走なら自動送信を絶対に通さない）──
  // スタッフ確認経路（isAutoSend=false）は fail-open のまま（送信を止めない）
  if (ctx.isAutoSend && passesCompleted.length < 3) {
    issues.push({
      pass: "rule_check",
      severity: "block",
      code: "UNCHECKED_AUTO_SEND",
      message: `チェックが完了しませんでした（${passesCompleted.length}/3パス）`,
      evidence: "",
      suggestion: "スタッフが内容を確認してから送信してください",
    });
  }

  return {
    ok: !issues.some((i) => i.severity === "block"),
    issues,
    passes_completed: passesCompleted,
    elapsed_ms: Date.now() - started,
    checked_text_hash: await sha1(draft.trim()),
    ...(passFailures.length ? { pass_failures: passFailures } : {}),
    pass_ms: passMs,
  };
}

// ─── Sonnetによる修正プロンプト（外科的修正 or 全体書き直しをSonnetが判断）──────
// H5(Fable5): 静的指示（役割・修正方針・絶対ルール）をBlock1(ephemeral)に分離し
// 動的部分（issues・checkpoint・draft）をBlock2に配置してキャッシュHIT率を上げる。
const SONNET_REVISION_STATIC = `あなたは不動産会社のLINE返信文の校閲・修正担当です。

【🚫 打ち合わせ合意・最高優先度ルール（全AIの臨機応変判断より優先・例外なし）】
「〇〇さんご希望のご条件に合った〜」「ご条件に合うお部屋」等の受け身表現は絶対禁止。
エリア名・個人名・具体条件との組み合わせでも禁止。この形式を「維持する」という指示は存在しない。
修正時は必ず能動表現（例:「〇〇エリアからオススメできるお部屋」「〇〇エリアから探してお届けします」）に変換すること。
★エリア名の呼び方は元の文・会話で使われた表現をそのまま維持する。会話で使われていない「全域」等の修飾語を修正時に勝手に付け足すことは絶対禁止（例:「日本橋周辺エリア」を「日本橋周辺全域」に変えない）。

以下の問題が検出されました。修正した返信文を作成してください。

【修正方針の判断】
- 問題が特定の1〜2箇所の表現・語句にある場合 → その箇所だけを修正し、他は一字も変えない
- 問題が文章全体の方向性・構成・トーンに及ぶ場合 → 全体を書き直す
- どちらが適切か問題の内容を見て判断してください

【絶対ルール】
1. [CHECKPOINT][CONDITIONS][RULES]にない新しい事実（金額・日付・物件名・号室・空室状況等）を追加しない
2. 修正後も自然な日本語のLINEメッセージとして成立させる
3. AIX_BOUNDARY_* の指摘 → 具体的な情報を削除し「改めてご連絡いたします」等に置き換える
4. FABRICATED_* の指摘 → 該当の主張を削除（[CHECKPOINT]に正しい事実があれば置き換え可）
5. [RULES]の禁止語彙・禁止表現を使わない
6. MISSED_QUESTION / STAGE_MISMATCH 指摘がある場合は [CUSTOMER_MESSAGE] の内容を正確に読み取り、
   顧客が実際に聞いていること・伝えていることに沿った返信に全体を書き直す。
   「見積書を作成します」等の宣言を顧客が求めていないのに入れないこと。

【骨格系 block（EMPTY_CLOSER / SPLIT_ACK_REPLY）の修正ルール】
★ この節は [ISSUES] に EMPTY_CLOSER か SPLIT_ACK_REPLY がある時だけ適用する。それ以外の指摘の修正では文を足さない（必須要素の有無は修正の対象ではない。スタッフの実際の返信を優先する）。
★ [REVISION_MODE] がある時はこの節より [REVISION_MODE] に従う（締め・断り＝文を足さず削るだけ／質問への回答＝③行動宣言と自己検証(b)は任意）。
EMPTY_CLOSER / SPLIT_ACK_REPLY は「文を削る」のではなく「文を足す」修正（この2コードの時だけ、元ドラフトより長くなってよい）。
1. [PAIR_CONTEXT] を最初に読む。返信は「スタッフが直前に送った内容」に対する「お客様の返答」への応答であり、直前発言の続きとして噛み合っていなければならない。各通に個別に相槌を打つ構成にしない。
2. 4要素をこの順で必ず含める（②③のどちらかが欠けたら不合格）: ①受け止め1文（「（[CUSTOMER_NAME] の名前）さんお世話になっております！！」（名前不明なら呼びかけなし）or「かしこまりました！！」＋懸念・予定の固有名詞復唱。共感テンプレ禁止）②回答 or 受け1文（懸念→履歴にある事実 or 対応方針／後日連絡の予告→急かさない＋先取りして受ける／質問→直接回答）③次の行動宣言1文（一人称・対象付き。対象はお客様の懸念・予定・条件の固有名詞）④締め1文（「かしこまりました！！」「ごゆっくりご検討ください！！」を最終行にしない）。
3. 禁止: 「はい😊！！」開始（Yes/No質問を除く）／「お気持ち」を含む文／「ごゆっくりご検討ください」（命令形）／「すぐに」／申込催促・希少性煽り／懸念を質問で返す。
4. 出力前の自己検証: (a)[SUBSTANCE] の懸念語に対応する語（階数→1階・エレベーター、狭い→広め、審査→保証会社）が②③にあるか (b)③に「〜させて頂きます」の一人称宣言があるか (c)最終行が了解句単独でないか。1つでも NO なら書き直す。
5. [BRAIN_META].reply_direction / key_topics は③の内容として反映。avoid_topics と衝突しても回答と行動宣言は削らず表現だけ調整。

【接地修正における判断優先順位】
修正内容の根拠は以下の優先順位で選択すること:
1. [RULES]（DBに登録された会社ルール・禁止語彙）— 最優先。社内ルールに反する表現は必ず除去する。
2. [CHECKPOINT]（確認済み事実）— 物件の具体情報はここのみを根拠とする。ここにない数値は書かない。
3. [BRAIN_META]（返信の方向性・フェーズガイド）— トーンや返信の目的はここに従う。
4. 一般的な礼儀・自然な日本語 — 上記に矛盾しない範囲でのみ使用可。

【AIX境界線の再確認】
AIXボタン（物件送付・見積提示・内見日程調整等の具体的なアクション）で対応すべき内容は
テキスト返信に含めてはならない。AIX_BOUNDARY指摘がある場合は当該宣言文を削除し、以下の形で締める（ただし [PAIR_CONTEXT] の必須要素を満たす文は削除しない）:
- 「〇〇の物件をお送りします」→ 宣言部分を削除。「何卒よろしくお願い致します😌！！」等の締め文のみ残す
- 「見積もりをお送りします」→ 宣言部分を削除。締め文のみ残す
- 「〇〇号室の空室状況をお調べします」→ 宣言部分を削除。締め文のみ残す
テキスト返信はあくまで顧客への言葉のやり取りのみに限定すること。

【スモラスタイル】
- 短文・読みやすい構成を維持する（1段落3〜4行以内を目安）
- 体言止めは自然な流れなら使用可（ただし敬体を基本とする）
- 語尾は敬体（〜です・〜ます・〜いたします）で統一
- 絵文字は新たに追加しない。原文にある絵文字（😊😌🌟✨）は保持する。同一絵文字が2回以上あれば2回目以降を削除する
- 「〜いたします」「〜させて頂きます」等の行動宣言文（WE DO文体）は削除・受け身化・簡略化しない（スモラ文体の核のため維持する）
- 【絶対禁止】個人名・エリア名・具体条件の有無を問わず「〇〇さんご希望のご条件に合った〜」「ご条件に合うお部屋」等の受け身表現は使わない。必ず「〇〇エリアからオススメできるお部屋」等の能動表現に変換する（エリア名は元の文の表現を維持し「全域」等を付け足さない）

【接地修正の禁止パターン】
以下の変更は「接地修正」ではなく「意味の変質」であり絶対に行わない:
- 顧客が聞いていない話題を新たに追加する
- CHECKPOINT/CONDITIONS/RULESに存在しない事実を推測で補う
- 「申し訳ありません」等の謝罪を問題がない文脈で挿入する
- 既存の提案・宣言（「〜いたします」等）を無断で削除する
- 冒頭の感謝・挨拶文（「ご条件お送り頂きありがとう御座います😊！！」等）を削除・省略する（全体書き直しの場合も必ず先頭に残す）
- 修正対象の指摘箇所以外の文体・構成を変える
- [ACTION_LEDGER] に記録が無い送付・確認・案内を完了扱いにする語（再度／改めて／先ほどお送りした／こちらの物件）を残す、または新たに書く
- 「修正後：」「以下修正版です」等の前置きを出力する

修正後の文章のみを出力してください（説明・前置き不要）。`;

function buildSonnetRevisionPrompt(draft: string, issues: CheckIssue[], ctx: FinalCheckContext): PromptBlock[] {
  const brainNote = ctx.brainContextJson
    ? `\n[BRAIN_META]（返信の目指すべき方向性・修正後もこの方向性を維持すること）\n${ctx.brainContextJson}\n[/BRAIN_META]\n`
    : "";
  const customerMsgNote = ctx.lastCustomerMessage
    ? `\n[CUSTOMER_MESSAGE]（この返信の宛先：顧客の最新メッセージ。MISSED_QUESTION/STAGE_MISMATCH指摘の修正はこの内容に沿って行うこと）\n${ctx.lastCustomerMessage.slice(0, 1500)}\n[/CUSTOMER_MESSAGE]\n`
    : "";
  // 2026-09-09 Fable5 往復文脈: 骨格系 block の修正は「直前スタッフ発話 × 顧客返答」と「懸念語」を見て文を足す
  // 2026-09-11 統合設計（経路A/B/C/D・S2）: 修正プロンプトは生成と同じ verdict を見る。
  //   ・必須要素は when でアクティブなものだけ・プレースホルダを実値化（旧: when 無視・{redo}/{object} 未置換）
  //   ・例文は selectPairExample（生成と同じ前提ゲート・exampleBySent・顧客名スロット）。前提不成立で fallback も無ければ例文を渡さない
  //   ・[REVISION_MODE]: 締め・断り＝削るだけ／質問への回答＝行動宣言は任意
  //   ・[CUSTOMER_NAME]: 修正 LLM に確定名を渡す（旧: 名前を渡さず、静的文の「〇〇さんお世話に」をそのまま書かせていた）
  const pairNote = (() => {
    if (!ctx.lastCustomerMessage) return "";
    const { sub, pair } = resolveReplyContext(ctx);
    const mode = isClosedVerdict(pair, ctx.tpoLabel ?? "") ? "closing" : pair.customer.kind === "question" ? "answer" : "default";
    const modeNote =
      mode === "closing" ? "[REVISION_MODE] 締め／断り: 骨格系の修正ルールは適用しない。文は足さず、前進提案（ピックアップ・内覧・見積・申込）と直前スタッフ文の再掲の削除だけを行う。\n"
      : mode === "answer" ? "[REVISION_MODE] 質問への回答: 骨格系ルールの③行動宣言と自己検証(b)は任意。回答文（〜となります／〜でございます／〜しております／〜ございません）があれば合格。\n"
      : "";
    if (sub.isAckOnly && !pair.rule) return modeNote;
    const must = pair.rule
      ? pair.rule.mustInclude.filter((m) => !m.when || m.when(pair)).map((m, i) => `${i + 1}.${fillPairPlaceholders(m.label, pair)}`).join(" ") || "（この場面で必須の要素なし）"
      : "（該当セルなし: 受け止め→回答/代替→行動宣言→締め）";
    const ex = pair.rule ? selectPairExample(pair, ctx.lastCustomerMessage) : null;
    const exLine = ex?.text ? `型（成約実例・前提${ex.premiseOk ? "成立" : "不成立＝骨格のみ参照し文は使わない"}）: 「${ex.text}」\n` : "";
    return `\n${modeNote}[PAIR_CONTEXT]（往復文脈: ${pair.summary}）\n直前スタッフ発言: 「${pair.lastStaffText.replace(/\s+/g, " ").slice(0, 160)}」\n場面の要素（参考情報。EMPTY_CLOSER／SPLIT_ACK_REPLY の修正時だけ使う・欠落を理由に文を足さない）: ${must}\n${pair.rule ? `禁止: ${pair.rule.mustNot.map((x) => fillPairTokens(x, pair)).join("／")}\n${exLine}` : ""}[/PAIR_CONTEXT]\n[SUBSTANCE]（顧客メッセージの実質: has=${sub.has} kinds=${sub.kinds.join(",") || "なし"}${sub.concerns.length ? ` 懸念=${sub.concerns.map((c) => `${c.label}「${c.phrase}」→${c.fix}`).join("／")}` : ""}）\n[/SUBSTANCE]\n`;
  })();
  const nameNote = `\n[CUSTOMER_NAME] ${ctx.customerName ? `${ctx.customerName}さん` : "不明（呼びかけは書かない。「〇〇さん」と書かない）"}\n`;
  // 修正案が同じ指摘は1回だけ渡す（同じ文を3回貼らせない: YUYA 事例）
  const seenSug = new Set<string>();
  const issuesForPrompt = issues.filter((i) => {
    const k = `${i.code}|${i.suggestion ?? ""}`;
    if (seenSug.has(k)) return false;
    seenSug.add(k);
    return true;
  });
  const historyNote = ctx.recentMessages?.length
    ? `\n[HISTORY]（直近会話履歴・最新5件）\n${formatHistory(ctx.recentMessages, 5)}\n[/HISTORY]\n`
    : "";
  // 2026-09-09 行動台帳: 修正時に「我々が実際にしたこと」を渡し、台帳に無い行為を「再度／改めて／先ほどお送りした」の前提にさせない
  const ledgerNote = (ctx.lastCustomerMessage || ctx.ledger)
    ? `\n[ACTION_LEDGER]（我々が実際にしたこと。ここに無い行為を「再度／改めて／先ほどお送りした」等の前提にしない）\n${resolveLedger(ctx).summary}\n[/ACTION_LEDGER]\n`
    : "";
  const dynamic = `[ISSUES]
${issuesForPrompt.map((i) => `- [${i.code}] ${i.message}（該当箇所:「${i.evidence}」${i.suggestion ? ` / 修正案: ${i.suggestion}` : ""}）`).join("\n")}
[/ISSUES]
${nameNote}${customerMsgNote}${pairNote}${ledgerNote}${historyNote}${brainNote}
[CHECKPOINT]（確認済み事実・最高権威）
${(ctx.checkpointFacts || "なし").slice(0, 2000)}
[/CHECKPOINT]

[CONDITIONS]（DB保存の顧客条件）
${(ctx.customerConditionsDb || "なし").slice(0, 1500)}
[/CONDITIONS]

[RULES]（会社ルール）
${(ctx.dbRules || "なし").slice(0, 20000)}
[/RULES]

[ORIGINAL_DRAFT]
${draft}
[/ORIGINAL_DRAFT]`;
  return [
    { type: "text" as const, text: SONNET_REVISION_STATIC, cache_control: { type: "ephemeral", ttl: "1h" } },
    { type: "text" as const, text: dynamic },
  ];
}

// ─── Sonnet自動修正（外科的修正 or 全体書き直しをSonnetが判断。失敗は null = fail-open）──
// null を返す条件: API失敗/タイムアウト/尻切れ/無変更/破壊的書き換え。
// 呼び出し元は null のとき元ドラフトを維持する（修正失敗で送信フローは絶対に止めない）。
export async function runGroundedRevision(
  draft: string,
  issues: CheckIssue[],
  ctx: FinalCheckContext,
  timeoutMs = 15000,
): Promise<string | null> {
  try {
    const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").replace(/\s/g, "");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31" },
      body: JSON.stringify({
        model: MODEL_REVISION,
        max_tokens: Math.max(2000, Math.ceil(draft.length * 2.5)),
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: buildSonnetRevisionPrompt(draft, issues, ctx) }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { content?: Array<{ type: string; text?: string }>; stop_reason?: string };
    if (data.stop_reason === "max_tokens") return null;
    let revised = (data.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text ?? "").trim();
    // 「修正後：」「【修正版】」等の前置き文を除去
    revised = revised.replace(/^(?:修正後[：:]\s*|【修正版[^】]*】\s*|以下(?:が|は)修正\S*\s*|修正した(?:返信)?文[：:]\s*)[\n]*/u, "").trim();
    if (!revised || revised === draft.trim()) return null;
    // AIX違反の大量削除で正当に短くなるケースを救済（下限を20%に緩和）
    // 2026-09-09 Fable5: 骨格系（SKELETON_CODES）は「文を足す」修正が正解＝元の40字が150字前後になるのが正常。上限を max(2倍, 400字) に
    const needsGrowth = issues.some((i) => SKELETON_CODES.has(i.code));
    const maxLen = needsGrowth ? Math.max(draft.length * 2, 400) : draft.length * 2;
    if (revised.length < draft.length * 0.2 || revised.length > maxLen) return null;
    return revised;
  } catch {
    return null;
  }
}

// ─── チェック+接地修正ループ ──────────────────────────────────────────────────
// 反復上限はループカウンタで強制（チェック実行は最大 MAX_CHECK_ITERATIONS 回）。
// 上限を増やす場合は時間予算(10s)を必ず再計算すること。
export const MAX_CHECK_ITERATIONS = 2; // check1 + (接地修正 + check2) = 計2チェック上限

const REVISION_MS = 15000;  // 修正SonnetのタイムアウトMs（Haiku 6000ms → Sonnet 15000ms）
const RECHECK_MS = 15000;   // Sonnet差分再チェック用（旧8000ms → Sonnet向け15000msに拡大）

// AIX_BOUNDARY_PROMISE 衝突対策（決定的・約0ms）:
// 修正プロンプト絶対ルール5の定型句「確認して改めてご連絡いたします」等が修正で新規挿入されると、
// AIX【確認します】との二重宣言（AIX_BOUNDARY_PROMISE = block）を warning 修正が生み出してしまう。
// 「元ドラフトに無く修正後に出現した」場合のみ修正を破棄する（元から含まれる場合は check1 で検査済み）。
// スタッフの約束文のみ捕捉。顧客への依頼句「ご確認後にご連絡ください」等は対象外
// G26（2026-09-08 Fable5）: confirmation-context.ts CONFIRM_PROMISE_SENTENCE_RE と同一定数（四者同名）
const CONFIRM_PROMISE_RE = CONFIRM_PROMISE_SENTENCE_RE;
/** 2026-09-11 統合設計（M14）: 確認約束が verdict で許可されている、または直前スタッフ発言が確認約束（CP_ACK の必須要素「確認出来次第ご連絡」）の時は
 *  「修正で新たに確認約束を足したら破棄」ガードを外す（必須要素を足した正しい修正まで捨てていた） */
function confirmPromiseOk(ctx: FinalCheckContext): boolean {
  if (getConfirmVerdict(ctx).allowed) return true;
  return !!ctx.lastCustomerMessage && resolveReplyContext(ctx).pair.staff.kind === "confirmation_promise";
}

export interface RevisionLoopResult {
  finalDraft: string;      // テキストボックスに入れるベスト草稿
  finalCheck: CheckResult; // finalDraft に対応するチェック結果（revision_count を必ず含む）
}

// 動作:
//   check1 → 指摘0件: そのまま返す
//         → warningのみ: 予算ガード → 接地修正1回 → 決定的プリスキャン → 差分再チェック
//           （Check1のissueを引き継ぎ、修正版で解決済みか+新規問題の有無を1パスで検証）。
//           「差分検証完走・block 0件・warning非悪化」を全て満たした修正版のみ採用し、
//           finalCheck も recheck に差し替える（checked_text_hash / evidence を finalDraft と整合させる）。
//           棄却・失敗・予算不足時は元ドラフト + check1 にフォールバック（元ドラフトは block 0件で
//           送信可能なため revision_exhausted は立てない）。未検証テキストは絶対に finalDraft にしない。
//         → blockあり: 接地修正 → 再チェック。block 0件になった修正版のみ「クリーン」として採用。
//           block減少なら修正版を revision_exhausted 付きで採用。改善なし/修正不能/再チェック
//           未完走なら元ドラフト + check1 を revision_exhausted 付きで返す（強制置換はしない）。
// 絶対にthrowしない（runFinalCheck / runGroundedRevision がともに fail-open のため）。

// ─── FABRICATED_* 誤検知照合（Check1後・修正前）─────────────────────────────────
// Check1でFABRICATED_*が出たとき、情報源と照合して「本当にハルシネーションか」を確認する。
// 根拠ありと確認されたものをclearedFactsに入れ、Check2でその記述を再指摘しないようにする。
// fail-open: 照合失敗時は元のissuesをそのまま返す（false positiveを許容する側）。

// プロンプトキャッシュ用静的システム指示（verifyFabricatedIssues 全呼び出しで共通）。
// 動的な情報源テキスト（checkpointFacts・customerConditionsDb・history・staffSourceText・targets）
// は user メッセージ側に置く（cache_control なし）。
const VERIFY_INSTRUCTIONS = `以下の各記述について、情報源に根拠があるかどうかを確認してください。

情報源の優先順位（高い順）:
1. CHECKPOINTS（確認済み事実セーブポイント）— 最優先。会話中にスタッフが確認した物件情報・条件。
2. CUSTOMER_CONDITIONS — 顧客DBに登録された条件。
3. HISTORY — 最近の会話履歴。
4. SOURCE — スタッフが提供した情報テキスト。

has_basis 判定ルール:
- has_basis=true: いずれかの情報源の中にその記述を裏付ける根拠（事実・記録・顧客発言）がある場合
- has_basis=false: どの情報源にも根拠がない場合（捏造・ハルシネーション・LLMが勝手に生成した事実）

注意:
- 「〇月末入居可能」「〇号室が空いている」「家賃〇〇万円」等の具体的な数値・日付は情報源に明記されている場合のみ has_basis=true
- 「申込から2週間で入居可能」等の一般的な不動産知識は情報源記載なしでも has_basis=true と判定してよい
- 会話内でお客様が発言した内容は HISTORY の根拠になる

【照合優先ソース一覧】
has_basis 判定は以下の信頼度順で根拠を探すこと:
1. CHECKPOINTS（スタッフ確認済み事実・DBルール記載）— 最も強い根拠。ここにあれば即 has_basis=true。
2. SOURCE（スタッフが今回の返信のために提供した情報テキスト）— 直接的な情報源。
3. HISTORY（会話文脈でお客様または担当者が言及した事実）— 発言内容は根拠として有効。
4. AI生成推測・一般知識のみ — 具体的な数値・固有名詞は根拠なし（has_basis=false）。
   ただし業界共通の一般知識（審査期間の目安・礼金の説明等）は has_basis=true 可。

【FABRICATED判定の厳格基準】
has_basis=false と判定するのは「情報源に存在しない具体的事実を断定した表現」のみ:
- NG（has_basis=false）: 情報源に記載のない家賃・号室・空室状況・入居可能日を具体的に明示
- NG（has_basis=false）: スタッフも顧客も言及していない物件名・設備・条件を確定事実として述べている
- OK（has_basis=true）: 「ご希望に合う物件を探します」→ 約束・姿勢の表明であり事実の捏造ではない
- OK（has_basis=true）: 「審査には1〜2週間かかります」→ 業界一般知識・情報源記載なしでも可
- OK（has_basis=true）: 「先ほどおっしゃっていた〇〇の件」→ HISTORY に該当発言があれば可

【偽陽性回避の判断例】
以下のケースはFABRICATEDではなく「接地済み表現」として扱いhas_basis=trueとすること:
- スタッフが会話の直前のターンで実際に伝えた内容を返信で言及している場合
- 顧客自身が今回または過去の会話で述べた希望条件・状況を返信で繰り返している場合
- 会話文脈から明らかに共有されている前提（例: 既に内見済みの物件名、既に提示済みの家賃）
- 「〜と伺っております」「〜とおっしゃっていた」等の引用表現（情報源への言及を明示している場合）
- 顧客が自ら名乗った名前・連絡先・家族構成などをスタッフ返信で繰り返す場合

【出力フォーマット仕様】
results 配列に各記述の照合結果を返す:
- evidence: 照合した記述（入力の記述テキストをそのまま返す）
- has_basis: true（いずれかの情報源に根拠あり）/ false（どの情報源にも根拠なし・捏造）

JSON スキーマに従って出力すること。説明文・前置きは不要。結果のみを出力する。`;

const VERIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["evidence", "has_basis"],
        properties: {
          evidence: { type: "string" },
          has_basis: { type: "boolean" },
        },
      },
    },
  },
};

async function verifyFabricatedIssues(
  issues: CheckIssue[],
  ctx: FinalCheckContext,
  timeoutMs: number
): Promise<{ confirmed: CheckIssue[]; clearedFacts: string[] }> {
  const targets = issues.filter(
    (i) => i.pass === "anomaly_scan" && i.code.startsWith("FABRICATED_") && i.evidence
  );
  if (targets.length === 0) return { confirmed: issues, clearedFacts: [] };

  // プロンプトキャッシュ（2026-08）:
  // 静的指示（VERIFY_INSTRUCTIONS）を system ブロックに分離し cache_control を付与。
  // 動的な情報源テキスト・targets は user メッセージに残す（cache_control なし）。
  const dynamicPrompt = `情報源:
[CHECKPOINTS]
${(ctx.checkpointFacts || "なし").slice(0, 2000)}
[/CHECKPOINTS]
[CUSTOMER_CONDITIONS]
${(ctx.customerConditionsDb || "なし").slice(0, 1500)}
[/CUSTOMER_CONDITIONS]
[HISTORY]
${formatHistory(ctx.recentMessages, 10)}
[/HISTORY]
[SOURCE]
${(ctx.staffSourceText || "なし").slice(0, 5000)}
[/SOURCE]

確認する記述（返信文中の表現）:
${targets.map((i, idx) => `${idx + 1}. 「${i.evidence}」`).join("\n")}

各記述について has_basis=true（情報源に根拠あり）/ false（根拠なし・捏造）を判定してください。`;

  try {
    const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").replace(/\s/g, "");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31" },
      body: JSON.stringify({
        model: MODEL_CHECK_FAST,
        max_tokens: 800,
        thinking: { type: "disabled" },
        output_config: { format: { type: "json_schema", schema: VERIFY_SCHEMA } },
        system: [{ type: "text", text: VERIFY_INSTRUCTIONS, cache_control: { type: "ephemeral", ttl: "1h" } }],
        messages: [{ role: "user", content: dynamicPrompt }],
      }),
    });
    if (!res.ok) throw new Error(`verify HTTP ${res.status}`);
    const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
    const text = data.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text ?? "";
    const parsed = JSON.parse(text) as { results?: Array<{ evidence: string; has_basis: boolean }> };
    const results = parsed.results ?? [];

    const clearedEvidences = new Set(
      results.filter((r) => r.has_basis).map((r) => r.evidence)
    );
    const clearedFacts = targets
      .filter((i) => clearedEvidences.has(i.evidence))
      .map((i) => i.evidence);
    const confirmed = issues.filter(
      (i) => !(i.pass === "anomaly_scan" && i.code.startsWith("FABRICATED_") && clearedEvidences.has(i.evidence))
    );
    return { confirmed, clearedFacts };
  } catch (e) {
    console.warn("[final-check] verifyFabricatedIssues failed (fail-open):", e);
    return { confirmed: issues, clearedFacts: [] };
  }
}

// ─── 差分再チェック（recheck v2: Check1結果を引き継ぐ差分検証・1パス）────────────
// 修正版に対するrecheckは、フル3パス再スキャンではなく「Check1のissue一覧 + 修正後ドラフト +
// clearedFacts」だけを渡す差分検証プロンプト1回に置き換える。
// - LLMは「未解決/部分的/revisionで新発生」のissueのみ返す（解決済みは返さない）
// - severity は従来どおりコード側 assignSeverity が決定的に付与（LLM生出力に severity は無い）
// - 成功時は passes_completed に全3パスを記録する（Check1のissueは全3パス由来であり、
//   差分検証はそれら全てを再検証するため。採用条件 fullyVerified / UNCHECKED_AUTO_SEND との互換用）
// - 失敗時は passes_completed=[] を返す → 呼び出し元の採用条件が落ち、元ドラフト+check1に
//   フォールバックする（fail-open。従来の挙動と同じ）

// 2026-09-11 竹内方針1（V-3）: 観測専用コード（PAIR_ELEMENT_MISSING / REPLY_SKELETON_MISSING / CONCERN_UNADDRESSED /
//   WE_DO_MISSING(_DET) / GENERIC_ONLY_REPLY）と表示のみの CONDITION_ECHO_MISSING / CLOSER_MISSING は再検査 LLM が発行できるコードから外す
const DIFF_RECHECK_CODES = `AIX_BOUNDARY_VIEWING / AIX_BOUNDARY_ESTIMATE / AIX_BOUNDARY_MEETING / AIX_BOUNDARY_PROPERTY /
AIX_BOUNDARY_APPLICATION / AIX_BOUNDARY_MOVEIN / AIX_BOUNDARY_PROMISE / AIX_BOUNDARY_DB /
BANNED_WORD / RULE_VIOLATION / FABRICATED_AMOUNT / FABRICATED_AVAILABILITY / FABRICATED_PROPERTY /
FABRICATED_DATE / FABRICATED_NAME / FABRICATED_POLICY / MISSED_QUESTION / STAGE_MISMATCH /
DOUBLE_DECLARATION / TIME_INVALID / STAGE_SKIP / FILLER_GREETING / PASSIVE_ONLY /
SUBJECT_CONFUSION / CONDITION_ADD_MISROUTED / STAFF_REQUEST_OMITTED / NG_PROPERTY_MENTION /
THANK_OPENING / GRATITUDE_OPENING / CONDITION_OPENING / EXCLAMATION_OVERUSE / INTRO_REPEAT /
NAME_MISMATCH / NAME_PLACEHOLDER / NAME_OVERUSE / NAME_FULLNAME_LEAK / NAME_BEFORE_OPENING / PROMISE_ECHO_MISSING / TIME_INVALID_HONIJITSU /
EMOJI_RULE_DET / SYSTEM_MARKER_LEAK / QUOTE_UNBALANCED / NEGATIVE_APOLOGY / HASTY_PROMISE / ESTIMATE_NO_TRIGGER / ESTIMATE_REPEAT_PROMISE / TIMING_VOCAB_MISMATCH / STATE_REGRESSION /
VIEWING_BEFORE_VACANCY / APPLY_WITHOUT_INTENT / POST_APPLY_VIEWING / TENSE_MISMATCH / FEEDBACK_PREMATURE / GOCHOUGO_AFTER_FIXED /
ECHO_CONFIRM / LIST_STRUCTURE / DOUBLE_KEIGO / FABRICATED_POLICY_DET / GOCHOUGO_STAFF_TASK / GOCHOUGO_REVERSED / GOCHOUGO_NO_CONDITION /
GOCHOUGO_AFTER_DATE / GUIDE_BEFORE_PROPERTY / CONFIRM_SUBJECT_THEFT / CONFIRM_NO_OBJECT / PHOTO_NO_PREMISE / PHOTO_REPLACES_VIEWING /
UNSENT_CLAIM / JUSHU_BEFORE_SEND / SELF_HONORIFIC / GUIDE_POSSIBLE_NO_DATE / SASETE_OVERUSE / APPLY_PUSH_NO_INTENT /
CONFIRM_OBJECT_UNSTATED / FAREWELL_ON_MOVEOUT_INFO / DISCLOSURE_ASSERTION / VACANCY_ASSERTION / MOVEIN_DATE_ASSERTION / SCREENING_ASSURANCE /
OPENING_GREETING_MISMATCH / OPENING_GREETING_UNEXPECTED / OPENER_MISMATCH /
EMPTY_CLOSER / SPLIT_ACK_REPLY / FEELING_TEMPLATE / SYMPATHY_ECHO /
PREEMPTIVE_HEDGE / FABRICATED_SEARCH_REPORT / CONDITION_RELAX_UNASKED / HEDGE_WITHOUT_SEARCH_DECL / SELF_HEDGE_ECHO /
COMMIT_AFTER_DELIVERABLE / NANISOTSU_MISPLACED / PASSIVE_CLOSER / RESULT_EXCUSE /
SCHEDULE_ASSERT_UNCONFIRMED / FACT_DEFERRED_ANSWER / WIDEN_EXCUSE_REDUNDANT / REASSURANCE_NO_BASIS / URGENCY_NO_INTENT / CONSIDER_PUSH / HUMBLE_WAIT /
DONE_PRESUPPOSED_WITHOUT_EVIDENCE / PROMISE_ECHO_MISMATCH /
UNANCHORED_VOCAB / VOCAB_MIRROR_MISMATCH /
VIEWING_DATE_ASK_WITHOUT_AIX / VIEWING_OFFER_NAME_ECHO`;

function buildDiffRecheckPrompt(revised: string, check1Issues: CheckIssue[], ctx: FinalCheckContext): string {
  const issuesJson = JSON.stringify(
    check1Issues.map((i) => ({ code: i.code, message: i.message, evidence: i.evidence, suggestion: i.suggestion })),
    null,
    1,
  );
  const clearedFactsNote = ctx.clearedFacts?.length
    ? `\n【照合済み確認済み】以下の記述はすでに情報源との照合で根拠ありと確認されています。問題として指摘しないこと：\n${ctx.clearedFacts.map((f) => `・「${f}」`).join("\n")}\n`
    : "";
  return `あなたは修正後の文章の検証担当者です。
元の返信文に対して以下の問題（Check1）が検出され、自動修正が行われました。
修正後のドラフトを検証してください。
${clearedFactsNote}
【Check1で検出された問題一覧】
${issuesJson}

【修正後のドラフト】
[REPLY]
${revised}
[/REPLY]

以下を判定してください：
1. 各issueについて「解決済み / 未解決 / 部分的に解決」を判定する
2. revisionによって新たに発生した問題があれば指摘する（既存issueのコード体系を使う。code は次から選ぶこと:
${DIFF_RECHECK_CODES}）

返却ルール:
- 「未解決」「部分的に解決」および「revisionで新たに発生」した問題のみを issues として返却する
  （未解決/部分的の場合は元の code を維持すること）
- 解決済みのものは返却不要
- evidence は必ず修正後ドラフト本文からの引用にすること。引用できない指摘は出力しない
- すべて解決済みで新規問題も無ければ issues を空配列にする`;
}

// 新規発生issueの pass 推定: 元issueに同一codeがあればそのpassを引き継ぎ、なければcode体系から決定
function inferDiffIssuePass(code: string, check1Issues: CheckIssue[]): CheckPass {
  const orig = check1Issues.find((i) => i.code === code);
  if (orig && orig.pass !== "meta") return orig.pass;
  if (code.startsWith("FABRICATED_")) return "anomaly_scan";
  if (code === "MISSED_QUESTION" || code === "STAGE_MISMATCH" || code === "DOUBLE_DECLARATION" ||
      code === "STAGE_SKIP" || code.startsWith("TIME_INVALID") || code === "WE_DO_MISSING" ||
      code === "FILLER_GREETING" || code === "PASSIVE_ONLY" || code === "SUBJECT_CONFUSION" ||
      code === "CONDITION_ADD_MISROUTED" || code === "STAFF_REQUEST_OMITTED" ||
      code === "INTRO_REPEAT" || code === "WE_DO_MISSING_DET" || code === "GENERIC_ONLY_REPLY" ||
      code === "REPLY_SKELETON_MISSING" || code === "CONCERN_UNADDRESSED" || code === "EMPTY_CLOSER" || code === "PAIR_ELEMENT_MISSING" || code === "SPLIT_ACK_REPLY" ||
      code === "PREEMPTIVE_HEDGE" || code === "FABRICATED_SEARCH_REPORT" || code === "CONDITION_RELAX_UNASKED" || code === "HEDGE_WITHOUT_SEARCH_DECL" ||
      code === "CLOSER_MISSING" || code === "COMMIT_AFTER_DELIVERABLE" || code === "NANISOTSU_MISPLACED" || code === "PASSIVE_CLOSER" || code === "CONDITION_ECHO_MISSING" ||
      code === "SCHEDULE_ASSERT_UNCONFIRMED" || code === "FACT_DEFERRED_ANSWER" ||
      code === "PROMISE_ECHO_MISSING" || code === "ESTIMATE_NO_TRIGGER" || code === "ESTIMATE_REPEAT_PROMISE" || code === "COST_ASSERTION_NO_ESTIMATE" || code === "VIEWING_BEFORE_VACANCY" ||
      code === "APPLY_WITHOUT_INTENT" || code === "POST_APPLY_VIEWING" || code === "TENSE_MISMATCH" ||
      code === "FEEDBACK_PREMATURE" || code === "GOCHOUGO_AFTER_FIXED" || code === "GOCHOUGO_AFTER_DATE" ||
      code === "GUIDE_BEFORE_PROPERTY" || code === "CONFIRM_SUBJECT_THEFT" || code === "PHOTO_NO_PREMISE" ||
      code === "PHOTO_REPLACES_VIEWING" || code === "UNSENT_CLAIM" || code === "JUSHU_BEFORE_SEND" ||
      code === "APPLY_PUSH_NO_INTENT" || code === "CONFIRM_NO_OBJECT" || code === "FAREWELL_ON_MOVEOUT_INFO" ||
      code === "DONE_PRESUPPOSED_WITHOUT_EVIDENCE" || code === "PROMISE_ECHO_MISMATCH" ||
      code === "VIEWING_DATE_ASK_WITHOUT_AIX" || code === "VIEWING_OFFER_NAME_ECHO") return "context_check";
  return "rule_check"; // AIX_BOUNDARY_* / BANNED_WORD / RULE_VIOLATION / 不明code
}

const DIFF_RECHECK_MAX_TOKENS = 1000; // フル再スキャン（2400）の半分以下

async function runDiffRecheck(
  revised: string,
  check1Issues: CheckIssue[],
  ctx: FinalCheckContext,
  timeoutMs = 15000,
  /** 2026-09-11 統合設計（経路G・M18）: check1 で実際に完了したパス。成功時の passes_completed はこれを引き継ぐ
   *  （旧実装は常に全3パスとして返し、check1 で context_check がタイムアウトしても UNCHECKED_AUTO_SEND が消える洗浄になっていた） */
  carriedPasses?: CheckPass[],
): Promise<CheckResult> {
  const started = Date.now();
  const issues: CheckIssue[] = [];
  const draftNorm = normalizeForMatch(revised);

  // ── 決定的チェックは修正版にも常時適用（runFinalCheck と完全同一セット。LLM不要・約0ms）──
  issues.push(...runDeterministicChecks(revised, ctx));

  // 差分検証の対象: meta（PARTIALLY_UNCHECKED）/ UNCHECKED_AUTO_SEND はテキスト修正で
  // 解消できないissueなので除外（従来もrevision対象から除外していたものと同じ）
  // 2026-09-11 竹内方針1（V-3）: 観測専用コード（必須要素・骨格系）は再検査 LLM に「未解決」として再発行させない
  const targets = check1Issues.filter((i) => i.pass !== "meta" && i.code !== "UNCHECKED_AUTO_SEND" && !OBSERVE_ONLY_CODES.has(i.code));

  try {
    const raw = await callSonnet(buildDiffRecheckPrompt(revised, targets, ctx), timeoutMs, DIFF_RECHECK_MAX_TOKENS, MODEL_CHECK_FAST);
    for (const r of raw) {
      const evidence = (r.evidence ?? "").trim();
      if (!evidence) continue; // 引用のない指摘は破棄（メタ認知ガード・runFinalCheckと同一）
      const code = (r.code ?? "UNKNOWN").trim() || "UNKNOWN";
      const pass = inferDiffIssuePass(code, targets);
      let severity = assignSeverity(pass, code, ctx.isAutoSend, ctx.isEarlyConversation);
      // block は evidence が修正後本文に実在する場合のみ（誤ブロック防止・runFinalCheckと同一）
      if (severity === "block" && !draftNorm.includes(normalizeForMatch(evidence))) severity = "warning";
      issues.push({
        pass,
        severity,
        code,
        message: (r.message ?? "").trim() || code,
        evidence,
        suggestion: (r.suggestion ?? "").trim(),
      });
    }
    // 成功: Check1 の issue を全て再検証済み。passes_completed は check1 で実際に完了したパスを引き継ぐ（diff_verified で採用判定）
    const carried: CheckPass[] = carriedPasses ?? ["rule_check", "anomaly_scan", "context_check"];
    if (ctx.isAutoSend && carried.filter((p) => p !== "meta").length < 3 && !issues.some((i) => i.code === "UNCHECKED_AUTO_SEND")) {
      issues.push({ pass: "rule_check", severity: "block", code: "UNCHECKED_AUTO_SEND",
        message: `チェックが完了しませんでした（${carried.length}/3パス・修正版も未完了パスは再検査していない）`, evidence: "",
        suggestion: "スタッフが内容を確認してから送信してください" });
    }
    return {
      ok: !issues.some((i) => i.severity === "block"),
      issues,
      passes_completed: carried,
      elapsed_ms: Date.now() - started,
      checked_text_hash: await sha1(revised.trim()),
      diff_verified: true,
    };
  } catch (e) {
    // fail-open: passes_completed=[] を返す → 呼び出し元の採用条件（全パス完走）が落ち、
    // 元ドラフト + check1 にフォールバックする（未検証テキストは絶対に採用されない）
    console.warn("[final-check] runDiffRecheck failed (fail-open):", e instanceof Error ? e.message : String(e));
    return {
      ok: false,
      issues,
      passes_completed: [],
      elapsed_ms: Date.now() - started,
      checked_text_hash: await sha1(revised.trim()),
      diff_verified: false,
    };
  }
}

export async function runFinalCheckWithRevision(
  draft: string,
  ctx: FinalCheckContext,
  budgetMs = 90000,  // check1(≤30s) + verify(≤8s) + revision(≤15s) + recheck(≤15s) = 68s + 22sバッファ（呼び出し元は90s/60sを渡す）
): Promise<RevisionLoopResult> {
  const started = Date.now();
  let checkIterations = 0;

  // ── チェック1回目: フルチェック ──
  // 2026-09-11 統合設計（経路G）: 締切を「予算 − 修正枠（REVISION_MS+RECHECK_MS）− 1s」にし、パスが1回タイムアウトしても修正枠が必ず残るようにする。
  //   予算が修正枠に満たない時（loop2 の下限 20s 等）は最低 15s をチェックに使う（修正はどのみち走らない）
  const checkDeadline = started + Math.max(budgetMs - (REVISION_MS + RECHECK_MS) - 1000, Math.min(budgetMs - 1000, 15000));
  const check1 = await runFinalCheck(draft, ctx, { deadlineAt: checkDeadline });
  checkIterations++;
  check1.revision_count = 0;
  // 2026-09-10 Fable5: 最終 CheckResult は recheck で丸ごと置換されるため、修正前の指摘をここで保存する
  const preRevisionIssues = check1.issues.map((i) => `${i.code}:${i.severity}`);
  check1.pre_revision_issues = preRevisionIssues;
  if (check1.issues.length === 0) return { finalDraft: draft, finalCheck: check1 };

  // ── FABRICATED_* 照合検証: 本当にハルシネーションかを確認し clearedFacts を構築 ──
  const fabricatedIssues = check1.issues.filter(
    (i) => i.pass === "anomaly_scan" && i.code.startsWith("FABRICATED_") && i.evidence
  );
  let ctxForRecheck = ctx;
  // 2026-09-11 統合設計（経路G）: 照合（7s）は実行後も修正枠が残る時だけ（同じ修正枠の枯渇を防ぐ）
  if (fabricatedIssues.length > 0 && budgetMs - (Date.now() - started) > 8000 + REVISION_MS + RECHECK_MS) {
    const { confirmed, clearedFacts } = await verifyFabricatedIssues(fabricatedIssues, ctx, 7000);
    // issuesを「確認済みハルシネーション」のみに絞り込む
    check1.issues = confirmed;
    if (clearedFacts.length > 0) {
      ctxForRecheck = { ...ctx, clearedFacts };
      console.log("[final-check] clearedFacts:", clearedFacts);
    }
    if (check1.issues.length === 0) return { finalDraft: draft, finalCheck: check1 };
  }

  const blocks1 = check1.issues.filter((i) => i.severity === "block");

  // タイムアウト起因のみの場合はテキスト修正で解消できないのでスキップ（revision_exhaustedを立てない）
  if (blocks1.length > 0 && blocks1.every((b) => b.code === "UNCHECKED_AUTO_SEND")) {
    return { finalDraft: draft, finalCheck: check1 };
  }

  // ── warningのみ: 接地修正1回 + フル再チェック（未検証テキストは絶対に finalDraft にしない）──
  // blockが無いので送信は元々止まらない。よって迷ったら常に「検証済みベースラインの元ドラフト」側に倒す。
  if (blocks1.length === 0) {
    // (1) 予算ガード: 残り時間が 修正+再チェック に満たなければ修正自体をスキップ
    //     （warningは送信を止めないので、未検証の修正版を出すより修正しない方が安全）
    if (budgetMs - (Date.now() - started) < REVISION_MS + RECHECK_MS) {
      return { finalDraft: draft, finalCheck: check1 };
    }

    // (2) 接地修正（失敗/ガード違反は null = fail-open）
    const draftNormW = normalizeForMatch(draft);
    const passableWarnIssues = check1.issues.filter(
      (i) => i.code !== "UNCHECKED_AUTO_SEND" &&
        // 2026-09-10 Fable5: CELL_AVOID_CONFLICT は診断専用（本文を直しても解消しない）＝修正ループに渡さない
        // 2026-09-11 竹内方針1（V-1）: 観測専用・表示のみ・誤字・info は isRevisable で除外（「要素を足す書き直し」を修正 LLM に渡さない）
        isRevisable(i) &&
        (!i.evidence || draftNormW.includes(normalizeForMatch(i.evidence)))
    );
    if (passableWarnIssues.length === 0) return { finalDraft: draft, finalCheck: check1 };
    // 2026-09-09 行動台帳: 台帳系 warning の修正指示に根拠と制約を添える
    const ledgerW = resolveLedger(ctx);
    const revisedRaw = await runGroundedRevision(draft, passableWarnIssues.map((i) => decorateFixInstruction(i, ledgerW)), ctx, REVISION_MS);
    if (!revisedRaw) return { finalDraft: draft, finalCheck: check1 };
    // 2026-09-11 統合設計（経路B/N3）: 修正版にも顧客名スロットを決定論で適用
    // 2026-09-11 竹内方針1・3・4・5: 生成の後処理と同じ applySurfaceFixes（別名の統一・承知→かしこまりました・すぐに除去・誤字・名前スロット）。
    //   下の禁止語プリスキャンで「承知」を含む修正版を丸ごと捨てていた（E4）のを、置換で救う
    const revised = applySurfaceFixes(revisedRaw, { customerName: ctx.customerName ?? "", aliases: ctx.nameAliases, now: ctx.now }).text;

    // (3) 決定的プリスキャン（約0ms）: 禁止語彙、および修正で新規挿入された
    //     「確認して…ご連絡」系の句（AIX_BOUNDARY_PROMISE と正面衝突）を検出したら即破棄
    if (BANNED_WORDS_DETERMINISTIC.some((w) => revised.includes(w))) {
      return { finalDraft: draft, finalCheck: check1 };
    }
    // 2026-09-12 竹内方針B: 禁止語から外した2語は、初回検査と同じ場面判定で block になる修正版だけを捨てる
    if (runAwaitUketamawariChecks(revised, ctx).some((i) => i.severity === "block")) {
      return { finalDraft: draft, finalCheck: check1 };
    }
    if (!confirmPromiseOk(ctx) && CONFIRM_PROMISE_RE.test(revised) && !CONFIRM_PROMISE_RE.test(draft)) {
      return { finalDraft: draft, finalCheck: check1 };
    }

    // (4) 差分再チェック（check1 + recheck = 計2チェックで MAX_CHECK_ITERATIONS=2 と整合）
    //     Check1のissue一覧を引き継ぎ、修正版で「解決済みか・新規問題が無いか」だけを1パスで検証
    const recheck = await runDiffRecheck(revised, check1.issues, ctxForRecheck, RECHECK_MS, check1.passes_completed);
    checkIterations++;

    // (5) 採用条件は3つのAND:
    //     a. 差分検証が完走（diff_verified。passes_completed は check1 から引き継いだ実値）
    //     b. block 0件（warning修正がblock級違反を新規挿入していないこと）
    //     c. warning件数が check1 以下（非悪化）
    const fullyVerified = recheck.diff_verified === true;
    const recheckHasBlock = recheck.issues.some((i) => i.severity === "block");
    const warnings1 = check1.issues.filter((i) => i.severity === "warning").length;
    const warningsR = recheck.issues.filter((i) => i.severity === "warning").length;
    const warn1Codes = new Set(check1.issues.filter((i) => i.severity === "warning").map((i) => i.code));
    const hasNewWarnType = recheck.issues.filter((i) => i.severity === "warning").some((i) => !warn1Codes.has(i.code));

    if (fullyVerified && !recheckHasBlock && warningsR <= warnings1 && !hasNewWarnType) {
      // 採用: finalCheck も recheck に差し替える（checked_text_hash・evidence・ok が
      // finalDraft=修正版と整合し、送信時ハッシュ再利用の穴と監査不整合を同時に塞ぐ）
      recheck.revised_text = revised;
      recheck.revision_count = 1;
      recheck.pre_revision_issues = preRevisionIssues;
      return { finalDraft: revised, finalCheck: recheck };
    }

    // 棄却: 元ドラフト + check1（revision_count=0）にフォールバック。
    // recheckでblockが出ても元ドラフトは block 0件で送信可能なため revision_exhausted は立てない
    return { finalDraft: draft, finalCheck: check1 };
  }

  // ── blockあり: 修正 → 再チェック（ループカウンタで上限強制）──
  let bestDraft = draft;
  let bestCheck: CheckResult = check1;
  let currentDraft = draft;
  let currentCheck: CheckResult = check1;
  let revisionCount = 0;

  while (checkIterations < MAX_CHECK_ITERATIONS) {
    const blocks = currentCheck.issues.filter((i) => i.severity === "block");
    if (blocks.length === 0) break; // 成功: blockが消えた

    // 時間予算: 残りが 修正+再チェック に満たなければ修正せず即スタッフ確認へ
    if (budgetMs - (Date.now() - started) < REVISION_MS + RECHECK_MS) break;

    const draftNormB = normalizeForMatch(currentDraft);
    const passableBlockIssues = currentCheck.issues.filter(
      (i) => i.code !== "UNCHECKED_AUTO_SEND" &&
        // 2026-09-11 竹内方針1（V-1）: block と一緒に観測専用・表示のみ・誤字の指摘を修正 LLM へ渡さない（同じ isRevisable）
        isRevisable(i) &&
        (!i.evidence || draftNormB.includes(normalizeForMatch(i.evidence)))
    );
    if (passableBlockIssues.length === 0) break;
    // 2026-09-09 行動台帳: block が台帳系（再度／お送りした／完了形）だけなら決定論置換（applyLedgerAutoFix）で直す（Sonnet 15s 節約・意味の変質ゼロ）。
    //   他の block が混在する時は Sonnet 修正に台帳の根拠・制約を添える
    const ledgerB = resolveLedger(ctx);
    const blocksOnly = passableBlockIssues.filter((i) => i.severity === "block");
    const allLedger = blocksOnly.length > 0 && blocksOnly.every((i) => LEDGER_FIX_CODES.has(i.code));
    let revised: string | null;
    if (allLedger) {
      // 2026-09-11 統合設計（経路B）: 名前不明時に「〇〇さん」を本文へ書き込まない（DECL は name="" なら呼びかけごと省く）
      const r = applyLedgerAutoFix(currentDraft, ledgerB, { customerMessage: ctx.lastCustomerMessage ?? "", name: ctx.customerName ? `${ctx.customerName}さん` : "", isDeliverableReply: ctx.isDeliverableReply });
      revised = r.applied.length ? r.text : null;
      if (revised) console.log("[final-check] ledger-autofix:", r.applied);
    } else {
      revised = await runGroundedRevision(currentDraft, passableBlockIssues.map((i) => decorateFixInstruction(i, ledgerB)), ctx, REVISION_MS);
    }
    if (!revised) break; // 修正失敗/ガード違反 → give up gracefully
    // 2026-09-11 統合設計（経路B/N3）: 修正版にも顧客名スロットを決定論で適用（修正 LLM が「〇〇さん」を書いても BANNED_WORD にしない）
    // 2026-09-11 竹内方針1・3・4・5: 生成の後処理と同じ applySurfaceFixes（fillNameSlot を含む）
    revised = applySurfaceFixes(revised, { customerName: ctx.customerName ?? "", aliases: ctx.nameAliases, now: ctx.now }).text;
    // CONFIRM_PROMISE_RE ガード（blockパス・warningパスと対称）。確認約束が verdict で許可されている／直前スタッフが確認約束の時は外す（M14）
    if (!confirmPromiseOk(ctx) && CONFIRM_PROMISE_RE.test(revised) && !CONFIRM_PROMISE_RE.test(currentDraft)) break;

    // 決定的プリフィルタ: block evidence が1つも消えていない修正は無効（再チェック2.5sを節約）
    // 2026-09-09 Fable5: 骨格系 block（evidence=本文冒頭）は追加型修正で evidence が残るのが正常 → プリフィルタ対象から除外
    const revisedNorm = normalizeForMatch(revised);
    const deletableBlocks = blocks.filter((b) => b.evidence && !SKELETON_CODES.has(b.code));
    if (deletableBlocks.length > 0 && deletableBlocks.every((b) => revisedNorm.includes(normalizeForMatch(b.evidence)))) break;

    // ── チェック2回目: 差分再チェック（Check1のissueを引き継ぎ修正版を検証。未検証の文章は絶対に出さない）──
    const recheck = await runDiffRecheck(revised, currentCheck.issues, ctxForRecheck, RECHECK_MS, currentCheck.passes_completed);
    checkIterations++;
    recheck.revised_text = revised;

    // FN-003: 採用条件は差分検証の完走確認（2026-09-11: diff_verified。passes_completed は check1 の実値を引き継ぐ）
    const verified = recheck.diff_verified === true;
    if (!verified) break; // 差分再チェック失敗 → 修正版は未検証なので不採用（fail-open）
    revisionCount++;

    // 2026-09-11 統合設計（経路G・M18）: UNCHECKED_AUTO_SEND は「改善したか」の比較から除外する（テキスト修正で解消しないため。
    //   旧実装は recheck 側から消えるので、何も直っていない修正も「改善」として採用されうる洗浄になっていた）
    const realBlocks = (r: CheckResult) => r.issues.filter((i) => i.severity === "block" && i.code !== "UNCHECKED_AUTO_SEND").length;
    if (realBlocks(recheck) < realBlocks(currentCheck)) {
      // 改善（0件=クリーン / 減少=部分改善）→ 修正版がベスト草稿
      bestDraft = revised;
      bestCheck = recheck;
    }
    // 改善なし（同数以上）→ best は据え置き（元ドラフトをスタッフに見せる）
    currentDraft = revised;
    currentCheck = recheck;
  }

  bestCheck.revision_count = revisionCount;
  bestCheck.pre_revision_issues = preRevisionIssues;
  if (bestCheck.issues.some((i) => i.severity === "block")) {
    bestCheck.revision_exhausted = true; // blockが残った → スタッフ手動確認必須
  }
  return { finalDraft: bestDraft, finalCheck: bestCheck };
}
