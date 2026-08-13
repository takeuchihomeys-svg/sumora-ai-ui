import { NextRequest, NextResponse, after } from "next/server";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { supabase } from "@/app/lib/supabase";
import {
  PHASE_GUIDE,
  GENERATION_SYSTEM,
  SMORA_QUICK_PATTERNS,
  SMORA_RULES,
  REAL_ESTATE_RULES,
  REPLY_CONTENT_RULES,
  CURATED_REPLY_RULES,
  STATE_SEARCH_ALIASES,
} from "@/app/lib/line-reply-prompts";
import { validateAndClean, verifyAmountsAgainstSource } from "@/app/lib/validate-reply";
import { fetchPromptRules } from "@/app/lib/prompt-rules";
import { safeSlice } from "@/app/lib/safe-slice";
import { classifyReplyMode } from "@/app/lib/reply-mode-classifier";
import {
  applyVacatingDateToTemplate,
  applyGreetingSwap,
  stripRoomLeadingZeros,
  type VacatingDate,
} from "@/app/lib/template-preprocess";

// Vercel Functions のタイムアウト上限（秒）— Vision + 2段LLM呼び出しに余裕を持たせる
export const maxDuration = 300;

// ─── モデル定義 ───────────────────────────────────────────────────────────────
// Step1（分析）: Sonnet — 感情・本音・成約戦略の精度重視
function createAnalysisModel() {
  return new ChatAnthropic({
    model: "claude-sonnet-5",
    maxTokens: 2048,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
    clientOptions: { timeout: 45_000 },
  });
}

// Step2（生成）: Sonnet — 品質重視
// 中6: temperature は ai_summary_json.emotion に応じて可変（0.3〜0.5）のためリクエスト毎に生成する
function createGenerationModel(_temperature: number) {
  return new ChatAnthropic({
    model: "claude-sonnet-5",
    maxTokens: 1500,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
    clientOptions: { timeout: 45_000 },
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
  });
}

// 中6: 顧客の温度感 → 生成temperature マッピング
// 前向き/普通/冷めかけ → 0.3 / 不安 → 0.4（少し温かみ・ブレすぎない）/ 未定義 → 0.3
// 完全一致だと「不安と期待が混在」等がマッチしないため includes 判定にする
function emotionTemperature(emotion?: string): number {
  if (emotion?.includes("不安")) return 0.4;
  return 0.3;
}

// ─── 初回挨拶文（greetingNote と冒頭強制置換で共用・二重定義禁止）─────────────
// 「名称未設定」はLINEプロフィール取得失敗時のプレースホルダー。名前として絶対に使わない。
function sanitizeCustomerName(name: string): string {
  if (!name || name === "名称未設定") return "";
  return name;
}
function buildFirstGreeting(customerName: string): string {
  const n = sanitizeCustomerName(customerName);
  return `${n ? `${n}さん、` : ""}はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！`;
}

// ─── f-8: センシティブ案件ゲート（線引き質問#10の回答確定に基づく）──────────────
// クレーム・審査否決・キャンセル/リスケ等はAI不使用（人間判断）の場面。
// 通常AIが生成したドラフトをそのまま送信させないよう、検知時はドラフト冒頭に
// 警告メタを付与してスタッフの手動確認を必須にする（生成自体は参考用に行う）。
const SENSITIVE_CLAIM_RE = /クレーム|苦情|納得(いか|でき)|話が違う|不誠実|誠意を|騙され|詐欺|訴え(る|ます|させ)|弁護士|消費者センター/;
const SENSITIVE_REJECT_RE = /審査[^。！!？?\n]{0,8}(否決|落ち(た(?!ら)|まし|てしまい)|通りませんでした|通らなかった|不承認|NG(でし|になり|だっ)|ダメ(でし|だっ))|否決/;
// ※「キャンセル料」「キャンセルできますか」等の不安系質問は通常AI回答の範囲（hesitancyNote等で対応済み）のため除外し、
//   キャンセル・解約の「意向」とリスケ（日程変更）依頼のみ検知する
const SENSITIVE_CANCEL_RE = /(?:キャンセル|解約|取消|取り消し?|白紙|辞退)(?!料|金|でき|出来|可能)(?:を|は|に|で)?(?:したい|します|させて|お願い|希望|することに|する事に)|なかったことに|見送(?:り(?:たい|ます)|らせて)|やめ(?:たい|ます|ておき|とき)|リスケ|(?:日程|日にち|日時|予定)[^。！!？?\n]{0,6}(?:変更|ずら|延期)/;

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

// ─── AIXボタン誘導ロジック: ドラフトテキスト＋会話状態からスタッフへのメモを生成 ────

// action_type → スタッフ向け誘導メモ（suggest-next-action の結果をこの note に変換する）
const AIX_ACTION_NOTES: Record<string, string> = {
  acknowledge_check: "送信後 → AIX【確認します】で管理会社への空室確認＋見積書依頼を送ってください（宛先は管理会社です）",
  property_send: "物件URLが揃ったら → AIX【物件ピックアップした】でカバーメッセージを生成して一緒に送ってください",
  viewing_invite: "AIX【内覧日調整】ボタンで日時を選択してから送信してください",
  meeting_place: "AIX【待ち合わせ】ボタンで物件住所入り確定メッセージを生成できます",
  estimate_sheet: "見積書が届いたら → AIX【見積書送る】で画像を読み取って自動計算＋カバーメッセージを生成できます",
  application_push: "AIX【申込へ！】でクロージングメッセージを生成できます",
  property_recommendation: "AIX【1件特にオススメする】で1件に絞った詳細訴求文を生成できます",
  greeting_viewing: "AIX【挨拶（内覧前後）】でフォローメッセージを生成してください",
  condition_hearing: "AIX【条件ヒアリング】ボタンで既知情報をスキップした形式で送れます",
  property_check_result: "管理会社・代表・オーナー・近隣月極から回答が来たら → 空室・募集状況はAIX【物件確認した（募集状況）】、保証会社・初期費用交渉・駐車場・ペット可否・退去日・入居可能日などの条件確認はAIX【確認した（条件・交渉）】（check_patternで切替）で結果報告文を生成してください",
  followup_revive: "AIX【追客する】で再接触メッセージを生成できます",
};

async function deriveSuggestedAix(
  draftText: string,
  conversationState: string,
  conversationId?: string,
  internalBaseUrl?: string,
  propertyStatus?: PropertyStatus,
  customerMessage?: string,
  analysisAixAction?: string | null,
  analysisAixEnforcement?: "required" | "recommended" | "optional" | null,
  closingStrategy?: string,
): Promise<{ action: string; note: string; source: string; enforcement_level: "required" | "recommended" | "optional"; closing_strategy?: string } | null> {
  // 退去予定/入居中の物件では現地内覧が不可のため viewing_invite（内覧日調整）は提案しない。
  // 代わりに空室確認（acknowledge_check）または申込で先に確保（application_push）を優先する。
  // 初回対応フェーズはAIX誘導不要（初回挨拶が主目的）
  if (conversationState === "first_reply") return null;

  const isMoveOut = propertyStatus === "move_out_scheduled" || propertyStatus === "occupied";
  const redirectMoveOut = (action: string, note: string): { action: string; note: string } => {
    if (isMoveOut && action === "viewing_invite") {
      return {
        action: "application_push",
        note: "退去予定/入居中の物件のため現地内覧は不可 → AIX【申込へ！】でお部屋を先に抑えるクロージング、または AIX【確認します】で退去日・入居可能時期の確認を送ってください",
      };
    }
    return { action, note };
  };
  // ─── Step 0.5: 顧客メッセージから「同一マンション内・別号室/別価格帯の依頼」を検知（★キャッシュ/DBルールより優先）───
  // 例:「こちらの6万台のお部屋はないですか？」= 送った物件の同棟別号室依頼 →【確認します】ではなく物件ピックアップ系AIXを提案する。
  // ※ webhookキャッシュが acknowledge_check を返して本判定を潰さないよう、Step 0 より前に置くこと（移動禁止）
  if (customerMessage && conversationState === "proposing") {
    const conditionChangeReq =
      /([0-9０-９]+\s*万(円)?台|万円?台|(もっと|もう少し)安|安め|安い(お?部屋|物件)|家賃.{0,8}(抑え|低め|下げ)|(別|他|違う)の?(お?部屋|物件)|同じ(マンション|建物|物件))/;
    const requestForm =
      /(ない(です|でしょう)?か|あります|ありませんか|あれば|欲しい|希望|探して|お願い)/;
    if (conditionChangeReq.test(customerMessage) && requestForm.test(customerMessage)) {
      return {
        action: "property_recommendation",
        note: "同じマンション内の別の号室／別価格帯のお部屋をご希望です → AIX【1件特にオススメする】または【物件ピックアップした】で同棟の条件に合う部屋を検索してお送りください（「確認します」は不要です）",
        source: "same_building_regex",
        enforcement_level: "required" as const,
        closing_strategy: closingStrategy || undefined,
      };
    }
  }
  // ─── Step 0.6: 初期費用・見積書の質問を検知（★キャッシュ/DBルールより優先）───
  // 例:「初期費用はいくらですか？内訳も教えてください」→ 見積書本体はAIX【見積書送る】で作成・送付するため、
  // AI返信案が見積書カバー文（「御見積書となります…ご査収ください」）を代弁しないよう最優先でAIX誘導を確定させる。
  // ※ Step 0 のキャッシュが別アクションを返して本判定を潰さないよう、Step 0 より前に置くこと（移動禁止）
  if (customerMessage) {
    const estimateKeyword =
      /(初期費用|見積|スモ割|総額|予算|全部で.{0,6}いくら|費用.{0,6}(内訳|詳細)|いくら.{0,8}(かかる|かかり|です|でしょう))/;
    const estimateRequestForm =
      /(いくら|どの(くらい|位)|内訳|教え|知りたい|いただけ|頂け|ください|下さい|ですか|でしょうか|お願い|？|\?)/;
    // 誤爆ガード①: 内覧希望が主目的のメッセージは見積誘導にしない（viewing_invite系に任せる）
    const viewingReq = /(内覧|内見|見学).{0,4}(したい|希望|でき|いつ|日程|調整)/;
    // 誤爆ガード②: 「もっと初期費用安くなる物件ないですか？」等の別物件依頼はピックアップ系（Step 0.5/Step 1）に任せる
    const otherPropertyReq =
      /(安|抑え)[^。！!？?\n]{0,10}(物件|お?部屋)|(物件|お?部屋)[^。！!？?\n]{0,8}(ない(です|でしょう)?か|あります|ありません)/;
    if (
      estimateKeyword.test(customerMessage) &&
      estimateRequestForm.test(customerMessage) &&
      !viewingReq.test(customerMessage) &&
      !otherPropertyReq.test(customerMessage)
    ) {
      return {
        action: "estimate_sheet",
        note: "初期費用・見積書のご質問です → AIX【見積書送る】で最大限割引した御見積書を作成してお送りください（AI返信案は作成宣言のみ・見積書本体と金額内訳は必ずAIXから送ってください）",
        source: "estimate_regex",
        enforcement_level: "required" as const,
        closing_strategy: closingStrategy || undefined,
      };
    }
  }
  // ─── Step 0.7: 内覧希望を検知 → viewing_invite を最優先で誘導 ───
  // お客様が「内覧したい」等を明示したらAIX【内覧日調整】を確定誘導する
  if (customerMessage) {
    const viewingIntent =
      /(内覧|内見|見学).{0,8}(したい|希望|お願い|可能|行き?たい|行ってみ|させてください|でき(ます|そう)|いつ(頃)?)|一度.*見てみ|実際に見てみ|見てみたい/;
    if (viewingIntent.test(customerMessage)) {
      const redirected = redirectMoveOut(
        "viewing_invite",
        "お客様が内覧希望です → AIX【内覧日調整】で日程候補を送ってください",
      );
      return { ...redirected, source: "viewing_intent_regex", enforcement_level: "required" as const, closing_strategy: closingStrategy || undefined };
    }
  }
  // ─── Step 1: suggest-next-action（DB学習ルール）に問い合わせ（3秒タイムアウト） ───
  if (conversationId && internalBaseUrl) {
    try {
      const res = await fetch(`${internalBaseUrl}/api/suggest-next-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // customer_message を渡すことで、竹内さんがAI質問に回答して学習した
        // trigger_action_rules（human_rule）・キーワード判定が「今まさに来たメッセージ」に対して確実に効く
        // （未指定だとDB保存済みの最新顧客メッセージへのフォールバックとなり、保存遅延時に判定が1通ズレる）
        body: JSON.stringify({ conversation_id: conversationId, customer_message: customerMessage ?? null }),
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = await res.json() as { action?: string | null; reason?: string; source?: string };
        if (data.action && AIX_ACTION_NOTES[data.action]) {
          const redirected = redirectMoveOut(data.action, AIX_ACTION_NOTES[data.action]);
          const baseLevelTrigger: "required" | "recommended" =
            (data.action === "estimate_sheet" || data.action === "property_send" || data.action === "same_building_regex")
              ? "required" : "recommended";
          // trap②: redirectMoveOutがviewing_invite→application_pushに変換した場合はrecommendedに降格
          const enforcementLevelTrigger: "required" | "recommended" =
            (redirected.action !== data.action) ? "recommended" : baseLevelTrigger;
          return {
            ...redirected,
            source: data.source ?? "trigger_rule",
            enforcement_level: enforcementLevelTrigger,
            closing_strategy: closingStrategy || undefined,
          };
        }
      }
    } catch {
      // タイムアウト・ネットワークエラー等は無視してregexフォールバックへ
    }
  }

  // ─── Step 1.5: Step1分析由来のAIX推薦（会話全文・感情・文脈を見たSonnet判断）───
  // 旧Step 2（ドラフト文regexフォールバック）は最弱シグナルだったため削除し、本判定に置き換え
  if (analysisAixAction && AIX_ACTION_NOTES[analysisAixAction]) {
    // analysis_step1 の品質ゲート（採択率30%未満・サンプル10件以上ならスキップ）
    // SOURCE_ACCEPT_RATE:{action}:{source} 行は update-action-confidence cron が毎日更新
    const { data: srcRateRow } = await supabase
      .from("trigger_action_rules")
      .select("confidence, total_occurrence")
      .eq("keyword", `SOURCE_ACCEPT_RATE:${analysisAixAction}:analysis_step1`)
      .eq("action_type", analysisAixAction)
      .maybeSingle();
    const isAnalysisSuppressed = srcRateRow
      && typeof srcRateRow.confidence === "number"
      && typeof srcRateRow.total_occurrence === "number"
      && srcRateRow.total_occurrence >= 10
      && srcRateRow.confidence < 0.3;
    if (!isAnalysisSuppressed) {
      const redirectedAnalysis = redirectMoveOut(analysisAixAction, AIX_ACTION_NOTES[analysisAixAction]);
      const analysisEnfLevel = (redirectedAnalysis.action !== analysisAixAction)
        ? "recommended"  // trap②: redirect発生時はrecommendedに降格
        : (analysisAixEnforcement ?? "optional");
      return {
        ...redirectedAnalysis,
        source: "analysis_step1",
        enforcement_level: analysisEnfLevel,
        closing_strategy: closingStrategy || undefined,
      };
    }
  }
  return null;
}

// ─── パターンB: 物件引用への返信判定（プロンプト常時注入・条件付きルール）─────────
const QUOTE_REPLY_JUDGE_NOTE = `
【物件引用への返信判定】
お客様メッセージが「ここ」「こちら」「気になる」「いいですね」「見たい」等を含み、
直近のスタッフメッセージに物件画像（【物件資料を送付した】等の[画像]）または物件名・物件URL送付が含まれる場合、
お客様は直前の物件への興味・内覧希望を示している可能性が高い。
この場合は「気になる物件のURLをお送りください」ではなく、その物件を前提に返信を生成すること。
【⚠️ ただし内覧誘導の前に募集状況を必ずゲートすること】
・当該物件が退去予定・入居中の場合は、現地内覧日程（[日付][時間帯]や2択提示）を絶対に提案しない。
  「退去日以降のご案内」または「お申込みでお部屋を先に抑えてからのご内覧」を案内する。
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
// ⚠️ 「退去後」は除外: AIが「退去後すぐにご案内します」と返信すると履歴に残り
//    次回の検出が誤発火するフィードバックループの原因となるため、単独パターンから除外。
// ⚠️ 「入居者」「居住中」は省略: 会話内でお客様が現居住状況を話す文脈でも一致してしまうため。
const MOVE_OUT_PATTERN = /退去予定|入居中|[0-9０-９]{1,2}\s*月末?\s*退去|退去[はが]?[0-9０-９]{1,2}\s*月/;

function detectPropertyStatus(history: string, customerMessage: string, explicit?: PropertyStatus): PropertyStatus {
  if (explicit && explicit !== "unknown") return explicit;
  const haystack = `${history}\n${customerMessage}`;
  if (MOVE_OUT_PATTERN.test(haystack)) return "move_out_scheduled";
  return explicit ?? "unknown";
}

// 退去予定・入居中と判定された場合に注入する強制ブロック（最優先）
function buildPropertyStatusNote(status: PropertyStatus): string {
  if (status === "move_out_scheduled" || status === "occupied") {
    return `\n【🚨 物件募集状況（確定事実・最優先 — 他のどのルールより上位）】この物件は退去予定/入居中です。現地内覧は退去日の翌日以降のみ可能で、今は現地内覧できません。
・内覧日程（[日付][時間帯]や2択日程提示）は絶対に提案しない。「〇日にご内覧いかがですか」等の現地内覧日の提示も禁止。
・入居可能時期を聞かれたら「退去後のクリーニング・鍵交換で2〜3週間程かかるため○月下旬頃のご入居となります」の方向で答える（退去月翌月1日入居は言わない）。
・内覧・興味を示されたら「退去前のため現在は現地ご案内ができません。退去後すぐにご案内させて頂きます！！お気に召されましたらお申込みでお部屋を先に抑えておくことも可能です😊！！」の方向で返す。`;
  }
  return "";
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

// ─── Step1: お客様状況の深層分析（Haiku）───────────────────────────────────
const ANALYSIS_SYSTEM = `あなたは賃貸仲介の営業コーチです。
LINEのやりとりから、お客様の状況・感情・本当のニーズを深く分析してください。
JSONのみで返答（説明不要）。`;

async function analyzeCustomerSituation(
  customerMessage: string,
  history: string,
  state: string,
  customerName: string,
  isFollowUp = false
): Promise<string> {
  const prompt = isFollowUp ? `
【営業フェーズ】${state}
【お客様名】${customerName || "不明"}
【直近の会話履歴（スモラが既に返信済み）】
${history || "なし"}
【スモラが返信済みのお客様メッセージ】
${customerMessage}

スモラはこのお客様メッセージに対して既に返信しました。
これから「続きのメッセージ」を生成します。以下をJSONで分析してください：
{
  "closing_strategy": "この続きのメッセージで何をすれば次の成約ステップへ繋がるか、具体的な一手を1行で（例: 内覧日程を2択で提示する / 申込書類を今すぐ催促する / 割引見積を提示してクロージング）",
  "already_covered": "スモラが直前の返信で既に伝えた内容の要約",
  "next_action": "続きとして自然な次のアクション・補足（例：申込を促す、内覧日程を提案、安心感を与えるなど）",
  "approach": "続きメッセージの方針（前の返信の内容を踏まえて何を追加するか・繰り返しNG）",
  "tone": "適切なトーン（例：背中を押す・安心させる・次ステップへ誘導）",
  "questions": ["お客様メッセージ内の質問・確認事項を全て列挙。なければ空配列"],
  "repeated_concern": "履歴を見てお客様が繰り返し聞いているテーマ（例: 費用・審査・キャンセル）。なければnull",
  "current_property": "現在話題にしている物件名・号室（履歴から特定できる場合のみ）。なければnull",
  "hesitancy_pattern": "お客様が「検討します」「また連絡します」「少し待ってほしい」「迷っています」など決断を保留しているか。パターン種別（'thinking'=検討中・'callback'=また連絡・'waiting'=もう少し待って・'undecided'=どちらか迷い・'timeline'=○月に決めたい）、なければnull",
  "future_timeline": "お客様が「○月に」「○日には」など具体的な申込タイムラインを示している場合その内容。なければnull",
  "suggested_aix_action": "次に使うべきAIXアクション。以下から1つ選ぶかnullを返す: viewing_invite（内見案内）/ estimate_sheet（見積書送付）/ property_send（物件送付）/ application_push（申込促進）/ property_check_result（物件確認・条件確認の結果報告 — 空室状況/退去日/入居可能日/保証会社/初期費用交渉/駐車場/ペット可否など管理会社・オーナーへ確認した結果をお客様に報告する場面）/ acknowledge_check（空室確認承知）/ condition_hearing（条件ヒアリング）/ meeting_place（待ち合わせ）/ property_recommendation（物件おすすめ）/ followup_revive（追客）/ greeting_viewing（内見挨拶） — LINEの返信文を送るべき場面はnullとする",
  "aix_reason": "AIXアクションを選んだ理由を1行で（nullの場合は空文字）",
  "aix_enforcement_level": "suggested_aix_actionがnullでない場合のみ回答。required（物件詳細・見積書本体・内覧日時等AIX専用コンテンツが必要）/ recommended（AIXが最善だが通常返信でも可）/ optional（使えるが必須ではない）。null不可"
}` : `
【営業フェーズ】${state}
【お客様名】${customerName || "不明"}
【直近の会話履歴】
${history || "なし"}
【最新メッセージ】
${customerMessage}

以下をJSONで分析してください：
{
  "closing_strategy": "今この会話でどうすれば成約につながるか、具体的な一手を1行で（例: 比較中の物件を引き出して割引見積を提示する / 今すぐ内覧日程を提案する / 申込みを即促す / 書類を催促して審査を進める）",
  "emotion": "お客様の感情状態（例：期待と不安が混在、前向き、迷っているなど）",
  "real_need": "表面の質問の奥にある本当のニーズ・懸念（例：費用が心配で踏み出せない、家族に相談したいなど）",
  "key_insight": "優秀な営業スタッフが気づくべき重要なポイント（例：価格比較をしている、決断を急かされたくないなど）",
  "approach": "このメッセージへの最適な返し方の方針（例：まず共感→動画を送ると約束→内覧への自然な誘導など）",
  "tone": "適切なトーン（例：温かく・余裕を持って・軽く背中を押す）",
  "questions": ["お客様メッセージ内の質問・確認事項を全て列挙（例: [\"審査期間は？\",\"キャンセルできる？\",\"フリーレントある？\"]）。なければ空配列"],
  "repeated_concern": "履歴を見てお客様が繰り返し聞いているテーマ（例: 費用・審査・キャンセル）。なければnull",
  "current_property": "現在話題にしている物件名・号室（履歴から特定できる場合のみ）。なければnull",
  "condition_change_type": "お客様が検索条件を変更・追加・緩和したか、または物件ピックアップ・送付を依頼しているか。該当する場合その種別（'area_change'=エリア変更、'rent_change'=家賃変更、'layout_change'=間取り変更、'equip_add'=設備・収納・こだわり条件の追加（WIC広め・SIC・収納多め・南向き・オートロック等の新しいこだわりを追加）、'condition_relax'=条件緩和、'pickup_request'=物件を送って・ピックアップ依頼・おすすめ、'multi'=複数変更）。なければnull。※すでに検討中の物件があっても、新しい条件を追加したら必ずその種別を返すこと",
  "hesitancy_pattern": "お客様が「検討します」「また連絡します」「少し待ってほしい」「迷っています」など、決断を保留するパターンを示しているか。示している場合はその種別（'thinking'=検討中・'callback'=また連絡・'waiting'=もう少し待って・'undecided'=どちらか迷い・'timeline'=○月に決めたい ）、なければnull",
  "future_timeline": "お客様が「○月に」「○日には」など具体的な決断・申込タイムラインを示している場合その内容。なければnull",
  "suggested_aix_action": "次に使うべきAIXアクション。以下から1つ選ぶかnullを返す: viewing_invite（内見案内）/ estimate_sheet（見積書送付）/ property_send（物件送付）/ application_push（申込促進）/ property_check_result（物件確認・条件確認の結果報告 — 空室状況/退去日/入居可能日/保証会社/初期費用交渉/駐車場/ペット可否など管理会社・オーナーへ確認した結果をお客様に報告する場面）/ acknowledge_check（空室確認承知）/ condition_hearing（条件ヒアリング）/ meeting_place（待ち合わせ）/ property_recommendation（物件おすすめ）/ followup_revive（追客）/ greeting_viewing（内見挨拶） — LINEの返信文を送るべき場面はnullとする",
  "aix_reason": "AIXアクションを選んだ理由を1行で（nullの場合は空文字）",
  "aix_enforcement_level": "suggested_aix_actionがnullでない場合のみ回答。required（物件詳細・見積書本体・内覧日時等AIX専用コンテンツが必要）/ recommended（AIXが最善だが通常返信でも可）/ optional（使えるが必須ではない）。null不可"
}`;

  try {
    const res = await createAnalysisModel().invoke([
      new SystemMessage(ANALYSIS_SYSTEM),
      new HumanMessage(prompt),
    ]);
    warnIfTruncated(res.response_metadata?.stop_reason, prompt.length);
    const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
    const match = text.match(/\{[\s\S]*\}/);
    return match ? match[0] : "";
  } catch (err) {
    console.error("[generate-reply] Step1分析（Haiku）失敗 — 分析なしで生成を続行:", err);
    return "";
  }
}



// ─── JST時刻取得 ─────────────────────────────────────────────────────────────
function getJSTHour(): number {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCHours();
}
// 0=日, 1=月, ..., 6=土
function getJSTDayOfWeek(): number {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCDay();
}
function getJSTDateString(): string {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const m = jst.getUTCMonth() + 1;
  const d = jst.getUTCDate();
  const days = ["日", "月", "火", "水", "木", "金", "土"];
  const dow = days[jst.getUTCDay()];
  return `${m}月${d}日（${dow}）`;
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
  analysis: string,
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
  templateNote = ""
): [SystemMessage, HumanMessage] {
  const jstHour = getJSTHour();
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

  // 本日（JST 9時リセット）の会話で挨拶済みか
  // alreadyGreetedToday が渡された場合はそちらを優先（タイムスタンプ精度が高い）
  // フォールバック: history 全体から判定（createdAt なしの場合）
  const alreadyGreeted = alreadyGreetedToday !== undefined
    ? alreadyGreetedToday
    : lastStaffLines.some(
        l => l.includes("お世話になっております") ||
             l.includes("夜分遅くに失礼") ||
             l.includes("はじめまして") ||
             l.includes("ご連絡頂きありがとうございます") ||
             /^スモラ:\s*「?[^\s]{1,10}さん/.test(l)
      );

  // 【重要】「夜分遅くに失礼致します」はスタッフが先にお客様に連絡するときの言葉。
  // generate-replyは常にお客様からのメッセージへの「返信」なので使用しない。
  // お客様が深夜に連絡してきた場合も「お世話になっております」で返す。
  const greetingNote = alreadyGreeted
    ? `\n【⏰ 挨拶ルール・最優先】本日の会話で冒頭挨拶は既に使用済み。今回は絶対に使わない。「はい！！」「かしこまりました！！」など短い言葉で直接本文から始める。`
    : (state === "first_reply" && isFirstEverReply)
      ? `\n【⏰ 初回対応ルール・最優先】これはお客様への【はじめての返信】。必ず「${buildFirstGreeting(customerName)}」で始める（一字一句変更・省略禁止）。「お世話になっております」「夜分遅くに失礼致します」は絶対禁止。`
      : `\n【⏰ 挨拶ルール・最優先】現在${jstHour}時台（JST）。今回の冒頭は「${sanitizeCustomerName(customerName) ? `${sanitizeCustomerName(customerName)}さんお世話になっております！！` : "お世話になっております！！"}」を使う。「夜分遅くに失礼致します」は返信時には絶対禁止（スタッフから先に連絡するときのみ使う言葉）。`;

  const managementNote = isWeekend
    ? `\n【管理会社の状況・必ず守ること】本日は土日。物件の募集状況確認（空室確認）は土日でも可能なので「確認させていただきます！確認出来次第ご連絡させていただきます！！」と伝えてよい。ただし交渉（フリーレント・値引き・条件変更・審査再挑戦など）は土日不可。交渉が必要な場合は「月曜日一番で管理会社に交渉させていただきます！！」と伝える。`
    : jstHour >= 18
      ? `\n【管理会社の状況・必ず守ること】現在${jstHour}時台（JST）。18時以降のため管理会社の営業時間が終了している。確認が必要な場合は「本日は管理会社の営業時間が終了しておりますので、明日一番でご確認しご連絡させて頂きます！！」と伝える。当日中の回答を約束しない。`
      : jstHour < 9
        ? `\n【管理会社の状況・必ず守ること】現在${jstHour}時台（JST）。管理会社の営業時間前（営業は9時〜18時）。確認が必要な場合は「本日、管理会社の営業開始後に確認し、確認出来次第ご連絡させて頂きます！！」と伝える。営業時間前の即時確認・即時回答を約束しない。`
        : `\n【管理会社の状況】現在${jstHour}時台（JST）。管理会社営業中（平日9時〜18時）。確認が必要な場合は「管理会社に確認させていただきます！！確認出来次第ご連絡させていただきます！！」と伝えてよい。`;

  const dateNote = `\n【📅 今日の日付（JST・必ず基準にすること）】${getJSTDateString()} — 「明日」「明後日」「今週」などの相対表現や具体的な日付（○日）は全てこの日付を起点に計算すること`;

  const _cleanName = sanitizeCustomerName(customerName);
  const nameNote = _cleanName ? `お客様名：${_cleanName}さん` : "お客様名：不明（名前なしで返信すること・「名称未設定」は絶対に使わない）";
  const conditionsNote = customerConditions
    ? `\n【お客様の希望条件（DB登録済み・必ず考慮すること）】\n${customerConditions}\n⚠️ 上記の数字・金額（家賃・築年数・駅徒歩等）は一文字も変えずにそのまま引用すること。「13万円」を「3万円」に変形する等の誤変換は絶対禁止。条件の重複記載はしない。`
    : "";
  const summaryNote = customerSummary
    ? `\n【このお客さんのAI要約 — 今の状況・次の必須対応を最優先で文案に反映すること。人物像・文体も合わせること】\n${customerSummary}`
    : "";

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
  const missingConditionsNote = (missingItems.length > 0 && (state === "hearing" || state === "first_reply" || state === "condition_hearing"))
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
  const phaseGuide = PHASE_GUIDE[state] ?? PHASE_GUIDE["first_reply"];


  // 分析結果から各フィールドを抽出
  let approachNote = "";
  let questionsNote = "";
  let repeatedConcernNote = "";
  let currentPropertyNote = "";
  let hesitancyNote = "";
  let conditionChangeNote = "";
  let closingStrategyFromAnalysis = "";
  if (analysis) {
    try {
      const p = JSON.parse(analysis) as Record<string, unknown>;
      // ② Step1分析の closing_strategy を抽出
      // ※ここでparseに失敗する場合はStep1の出力形式を確認すること
      if (p.closing_strategy && typeof p.closing_strategy === "string") {
        closingStrategyFromAnalysis = p.closing_strategy;
      }
      if (p.approach) approachNote = `\n【今回の返し方】${p.approach}（トーン: ${p.tone || "自然に"}）`;

      // ① 複数質問: 全問答えることを明示 + 不安系質問検出
      if (Array.isArray(p.questions) && (p.questions as string[]).length > 0) {
        const questions = p.questions as string[];
        if (questions.length > 1) {
          questionsNote = `\n【⚠️ 複数質問検出（全て漏れなく答えること・省略禁止）】\n${
            questions.map((q, i) => `${i + 1}. ${q}`).join("\n")
          }`;
        }
        const anxietyKeywords = ["名義", "審査", "保証", "リスク", "キャンセル", "退去", "違約", "トラブル", "詐称", "離婚", "死亡", "ルール", "大丈夫", "問題ない", "失敗", "断られ", "通らな"];
        const isAnxiety = questions.some(q => anxietyKeywords.some(k => q.includes(k)));
        if (isAnxiety) {
          questionsNote += `\n【🚨 不安系質問検出】お客様はリスク・ルール・契約上の不安を持っている。曖昧・ぼかした回答（「可能性があります」「かもしれません」）は信頼を損なう。不動産ルール・事実・リスクを具体的に説明し、リスクがある場合は正直に伝えた上で必ず代替案をセットで提示すること。`;
        }
      }

      // ② 迷いパターン: 根本不安を正面から解消
      if (p.repeated_concern && typeof p.repeated_concern === "string") {
        repeatedConcernNote = `\n【💭 迷いパターン検出】このお客様は「${p.repeated_concern}」について繰り返し確認している。表面的な質問の裏に根本的な不安がある。今回の返信でその不安を正面から・具体的な数字・事実で解消すること。同じ説明の繰り返しはNG — 別の角度・具体例で伝える。`;
      }

      // ④ 物件名追跡
      // ★お客様が新しい条件を追加した場合は、既出物件を再提案しないよう文脈注記を切り替える
      //   （condition_change_type が付いている＝新条件が来た → 既出物件の「文脈で返信」指示は再提案を誘発するため出さない）
      const hasConditionChangeForProperty = typeof p.condition_change_type === "string" && p.condition_change_type.trim().length > 0;
      if (p.current_property && typeof p.current_property === "string") {
        currentPropertyNote = hasConditionChangeForProperty
          ? `\n【🏠 現在話している物件】${p.current_property}（※お客様が新しい条件を追加したため、この既出物件を再提案・再アピールしない。新条件に合うお部屋を新たに探してお送りする旨のみ伝えること）`
          : `\n【🏠 現在話している物件】${p.current_property} — この物件の文脈で返信すること。`;
      }

      // ② 検討/保留パターン: 実データから抽出した対応策を注入
      if (p.hesitancy_pattern && typeof p.hesitancy_pattern === "string") {
        const hp = p.hesitancy_pattern;
        const timeline = p.future_timeline && typeof p.future_timeline === "string" ? p.future_timeline : null;
        if (hp === "thinking" || hp === "callback") {
          hesitancyNote = `\n【🤔 保留パターン検出（${hp === "thinking" ? "検討中" : "また連絡"}）★実データ反映】お客様は一旦保留している。「お気軽にご連絡ください」だけで終わらないこと。必ず以下を1つ添える：①物件の好条件・希少性を一言（「かなり好条件のお部屋ですので」「繁忙期に入ると同様の物件は減ります」等） ②申込促し（「お気に召されましたらお申込みしてお部屋抑えさせて頂きます！！」） ③待機中の具体アクション約束（「新着出次第随時お送りします」）。`;
        } else if (hp === "waiting") {
          hesitancyNote = `\n【⏳ 「少し待って」パターン検出★実データ反映】お客様は決断に踏み出せていない。バリアを取り除くこと：「保証会社の審査が通過するまでの間はキャンセル料は一切かかりませんのでご安心ください😊！！審査期間中にお部屋のご案内もさせて頂けますので、実際に見てからご判断いただけます！！」のように安心感を先に伝える。`;
        } else if (hp === "timeline" && timeline) {
          hesitancyNote = `\n【📅 タイムライン確定（${timeline}）★実データ反映】お客様がタイムラインを示している。そのタイミングで動く具体アクションを約束する：「${timeline}に新着物件も含めてピックアップしお送りさせて頂きます😊！！」のように日付・アクションを明示してコミットする。`;
        } else if (hp === "undecided") {
          hesitancyNote = `\n【🔀 物件迷いパターン検出★実データ反映】複数物件で迷っている。判断軸を提供する：各物件の具体的な違い（費用・立地・設備）を数字で比較し、「初期費用を軸にお選びになられるのはいかがでしょうか」等で決断を後押しする。※比較に使う数字は会話履歴にテキストとして登場した実際の値のみ。履歴にない家賃・費用の数字を推測して比較することは絶対禁止。数字が履歴になければ『初期費用を軸にお選びになられるのはいかがでしょうか』の判断軸提示のみ行う。`;
        }
      }

      // ③ 条件変更/ピックアップ依頼検出
      if (p.condition_change_type && typeof p.condition_change_type === "string") {
        const changeType = p.condition_change_type; // typeof ガードで string に絞り込み済み（as 不要）
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
        // 拡大・緩和（condition_relax）の場合: ピックアップ宣言 + まだ聞けていない条件を1〜2点確認してよい
        if (changeType === "condition_relax") {
          conditionChangeNote = `\n【🔄 ${label}検出】エリア拡大・家賃上限UP等で選択肢が広がった。必ずピックアップ宣言を行うこと。さらに「まだ聞けていない重要条件（間取り・築年数など）」が1〜2点あれば追加確認してよい（すでに分かっている条件は聞き返さない）。${noReproposeNote}`;
        } else {
          // 条件変更・設備追加・ピックアップ依頼: 追加質問は禁止、追客継続スタイルで完結
          conditionChangeNote = `\n【🔄 ${label}検出（最重要・絶対遵守）】追加条件を聞き返すことは絶対禁止。変更・追加された条件を具体的な言葉（エリア名・設備名）にして、即座に追客継続の行動宣言で完結させること。
【追客継続の正しいスタイル（必ず守る）】
・「ピックアップしてお送りします」は禁止（すぐに物件を送れる状況ではないため）
・正しい型: 「かしこまりました！！[エリア]のお部屋で[名前]さんのご条件に合ったお部屋の新着状況随時確認させて頂きオススメ出来るお部屋募集に出次第お送りさせて頂きます！！何卒よろしくお願い致します😊！！」
・ポイント: 「新着状況随時確認」「募集に出次第お送り」のフレーズを使って継続的に追い続けている姿勢を伝える${noReproposeNote}`;
        }
      }
    } catch (e) { console.warn("[generate-reply] Step1 JSON parse failed:", e); }
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
          `・${safeSlice(m, 120)}${m.length > 120 ? "…" : ""}`
        ).join("\n")
      }\n→ 特に費用・ルール・フロー説明は「一度伝えた」事実を必ず踏まえ、同じ内容を別の言い方でも繰り返さない。次のアクションに進むこと。`
    : "";

  // ── ピックアップ約束後の感謝返信を決定論的に検出 ──────────────────────────
  // スタッフが直前に「ピックアップしてお送りします」と約束済みのところへ、
  // お客様が「ありがとうございます」「よろしくお願いします」等の短い感謝・承諾のみを返したケース。
  // → AIが同じピックアップ宣言を再生成する二重宣言バグを防ぎ、短い確認文のみに制限する。
  //   実際の物件送付はAIX「物件ピックアップした」で行う（送信後にUIが誘導バナーを表示済み）。
  const trimmedCustomerMsg = (customerMessage || "").trim();
  const isShortAckMsg =
    trimmedCustomerMsg.length > 0 &&
    trimmedCustomerMsg.length <= 60 &&
    /(ありがとう|宜しく|よろしく|お願いします|お願い致します|お願いいたします|了解|承知|楽しみ)/.test(trimmedCustomerMsg) &&
    !/[?？]/.test(trimmedCustomerMsg) &&
    !/(家賃|エリア|間取り|物件|条件|変更|広げ|安く|抑え|内覧|見積|申込|キャンセル)/.test(trimmedCustomerMsg);
  const staffPromisedPickup =
    !!lastStaffMsg &&
    /ピックアップ/.test(lastStaffMsg) &&
    /(お送り|送らせて|お届け|送付)/.test(lastStaffMsg) &&
    !lastStaffMsg.includes("ご査収ください"); // 「ご査収ください」= 物件送付済みの完了文なので約束中ではない
  const pickupPromiseAckNote = (!isFollowUp && staffPromisedPickup && isShortAckMsg)
    ? `\n【🚫 ピックアップ宣言の繰り返し禁止（最優先・フェーズ別パターン/条件変更検出より上位）】
スタッフは直前の返信で既に「物件をピックアップしてお送りします」と約束済み。今回のお客様のメッセージはその約束に対する感謝・承諾のみ。
→ 「ピックアップしてお送りさせて頂きます」宣言・エリアや家賃等の条件列挙・「初期費用も最大限割引」文を絶対にもう一度生成しない（二重宣言になる）
→ 返信は短い確認文のみ（2行以内・挨拶ルールに従う）。例:「かしこまりました😊！！ピックアップ出来次第お送りさせて頂きますので、何卒よろしくお願い致します😌！！」
→ 実際の物件送付はこの後AIX「物件ピックアップした」で行うため、AI返信で物件・条件の話を展開しない`
    : "";

  const staffContextNote = isFollowUp && lastStaffMsg
    ? `\n【⚠️ 最重要：スモラは既にこのお客様メッセージに返信済み】\nスモラが直前に送った内容：「${lastStaffMsg}」\n→ お客様はまだ返信していない。これはその【続きのメッセージ】。前の返信で伝えた内容を絶対に繰り返さない。前の返信を踏まえて補足・追加・次のアクション提案など、自然につながる内容を生成すること。`
    : lastStaffMsg
      ? `\n【⚠️ スモラが直前に送った内容（必ず踏まえること）】「${lastStaffMsg}」\n→ この返信の後にお客様が上記メッセージを送った。会話の流れを引き継いで自然な続きを生成すること。`
      : "";

  // ⭐実例がある場合: 文体参考として使うが、ルール（禁止ワード・挨拶等）は常に最優先
  const examplesInstruction = examples
    ? "\n\n【⭐実例の使い方】上記実例は文体・テンポ・絵文字・感嘆符の参考。言い回しの雰囲気を再現すること。ただし実例に「今すぐ」「すぐに」「即入居可能」「お世話になっております（初回時）」等の古いパターンが含まれていても、現行の禁止ルール・挨拶ルールを必ず優先すること。"
    : "";

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
  // 冒頭ルールの本文は greetingNote（【⏰ 挨拶ルール／初回対応ルール・最優先】）に一本化。
  // ここでは QUICK_PATTERNS 内の競合する冒頭ルールを greetingNote への参照に置き換えるだけにする（二重定義禁止）。
  const effectiveQuickPatterns = (() => {
    if (alreadyGreeted) {
      // 同日挨拶済み → 「長い返信はお世話になっております」ルールを無効化
      return overrideOpeningRule(
        baseQuickPatterns,
        "・冒頭ルール（★重要・本日挨拶済みのため上書き）: 【⏰ 挨拶ルール・最優先】に従い、返信の長短にかかわらず冒頭挨拶は一切使わない（「お世話になっております」「ありがとうございます」「夜分遅くに」も禁止）"
      );
    }
    if (state === "first_reply" && isFirstEverReply) {
      // 真の初回 → 初回挨拶文は greetingNote の【⏰ 初回対応ルール・最優先】に統一
      return overrideOpeningRule(
        baseQuickPatterns,
        "・冒頭ルール（★重要・初回返信のため上書き）: 冒頭挨拶は【⏰ 初回対応ルール・最優先】に記載の初回挨拶文（「はじめまして😊！！…鈴木と申します！！」）に必ず従う。「お世話になっております」は絶対禁止"
      );
    }
    // 本日初回メッセージ → 短い承認でも必ず「お世話になっております」で始める
    return overrideOpeningRule(
      baseQuickPatterns,
      "・冒頭ルール（★重要・本日初回メッセージのため上書き）: 【⏰ 挨拶ルール・最優先】に従い、返信の長短・内容を問わず必ず「〇〇さんお世話になっております！！」で始める。「かしこまりました！！」「はい！！」単独での書き出しは絶対禁止"
    );
  })();
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
  const applicationFormNote = (state === "applying" && isApplicationFormText && !hasRecentCustomerImage)
    ? `\n\n【🚨 申込フォーム受取・身分証なし検出】お客様からフォーム（個人情報テキスト）が送られてきたが、身分証明書の写真がない。返信には必ず「身分証明書（運転免許証またはマイナンバーカード）の表裏のお写真もお送りいただけますでしょうか！！」を含めること。フォーム未記入欄（勤務先等）があれば同時に確認する。パターンG-1で対応。`
    : "";

  // 退去予定/入居中を決定論的に検出 → 最優先ブロックを注入（テキスト検出漏れによる誤内覧提案を防止）
  // テンプレートモード（templateNoteが渡されている）では会話履歴テキストから検出しない。
  // 過去会話に「退去予定」「入居中」が含まれていても現在の物件とは無関係な誤検知を防ぐ。
  const resolvedPropertyStatus = templateNote
    ? (propertyStatus && propertyStatus !== "unknown" ? propertyStatus : "unknown")
    : detectPropertyStatus(history, customerMessage, propertyStatus);
  const propertyStatusNote = buildPropertyStatusNote(resolvedPropertyStatus);

  // 内覧日時の具体的提案はAIXの「内覧へ」ボタン専用。generate-replyでは絶対に具体的日時を出さない
  const viewingFactNote = (resolvedPropertyStatus === "move_out_scheduled" || resolvedPropertyStatus === "occupied")
    ? `\n\n【📅 内覧日時について】この物件は退去予定/入居中のため現地内覧はできません。「退去後すぐにご案内します」「お申込みでお部屋を先に抑えてからのご内覧も可能です」の方向で返すこと。`
    : `\n\n【📅 内覧日時の具体的提案は絶対禁止（最優先）】「〇/〇（木）14:00〜」「直近ですと[日付][時間帯]」「〇〇でご都合いかがでしょうか」のような具体的な内覧候補日時・2択日程提示は絶対に出力しない。内覧の日程調整はAIXの「内覧へ」ボタンのテンプレートで別途行うため、AI返信案には含めない。内覧に触れる場合は「お気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！」のみ許可。[日付][時間帯]プレースホルダーも使用禁止。`;

  // お客様が「内覧したい」を明示した場合: 返信は短い承認文のみ。日程・申込み提案は含めない
  const hasViewingIntent =
    /(内覧|内見|見学).{0,8}(したい|希望|お願い|可能|行き?たい|行ってみ|させてください|でき(ます|そう)|いつ(頃)?)|一度.*見てみ|実際に見てみ|見てみたい/.test(
      customerMessage ?? "",
    );
  const viewingIntentShortReplyNote = hasViewingIntent && resolvedPropertyStatus !== "move_out_scheduled" && resolvedPropertyStatus !== "occupied"
    ? `\n\n【📅 内覧希望への返信は短く（最重要）】お客様が内覧希望を明示しています。返信は「かしこまりました！！ご都合よろしいお日にちをお伝えさせて頂きます！！」程度の短い承認文のみにしてください。以下は絶対禁止：① 申込み提案（「先にお申込みでお部屋を抑えることも可能」等）② 内覧を促す誘導文（「お気に召されましたら〜」は不要）③ その他の追加情報。内覧日程の詳細はAIX【内覧日調整】から別途送るため、この返信には含めない。`
    : "";

  // 見積書カバー文はAIXの「見積書送る」ボタン専用。generate-replyでは見積書を添付できないため、
  // 添付済みを装う文面・金額内訳をAI返信案に出さない（内覧日時ゲート viewingFactNote と同型の常時注入ゲート）
  const estimateGateNote = `\n\n【💰 見積書カバー文の生成は絶対禁止（最優先）】「〜の御見積書となります」「御見積書をお送りします＋ご査収ください」のような、見積書を既に添付した体のカバーメッセージ・初期費用の金額内訳は絶対に出力しない。見積書本体はAIXの「見積書送る」ボタンで別途作成・添付して送るため、AI返信案には含めない。初期費用・見積の質問への返信は「かしこまりました！！最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！」の作成宣言のみ許可（物件名入りの見積書送付文・金額内訳・見積書に対する「ご査収ください」は書かない）。この物件の家賃・管理費（共益費）・敷金・礼金の実額もAIは物件資料画像を読めないため断言・推測禁止。会話履歴内でスタッフが既に伝えた金額をそのまま引用する場合のみ言及可。それ以外は『確認しご連絡させて頂きます😊！！』または見積書作成宣言で返すこと。敷金・礼金の一般論（通常0〜2ヶ月分等）は可。`;

  // 空室確認結果・入居可能日・保証会社等の物件固有情報はAIXの「物件確認した」系ボタン専用。generate-replyでは管理会社確認前の結果捏造を防ぐ（estimateGateNote と同型の常時注入ゲート）
  const propertyFactGateNote = `\n\n【🏢 管理会社確認が必要な物件固有情報の断言は絶対禁止（最優先）】「空室でした」「現在も募集中と確認できました」「埋まってしまいました」「退去日は〇月〇日です」「〇月〇日からご入居可能です」のような、管理会社に確認した体の結果報告や具体的な退去日・入居可能日の断言は絶対に出力しない。空室状況・退去予定日・入居可能日に加え、この物件の「保証会社名・保証料の金額・審査基準・ペット飼育可否・駐車場の空きと料金・設備の有無・礼金/家賃交渉の結果」も管理会社への確認が必要な確定事実であり、確認前にAIが「この物件の保証会社は〇〇です」「保証料は総賃料の〇%です」等と断言・推測してはいけない。保証会社の役割・審査の一般的な流れ・連帯保証人との違いなどの一般論は即答してよい。物件固有の質問には「確認しご連絡させて頂きます😊！！」の宣言のみ。確認結果の報告はAIX【確認した（条件・交渉）】（物件確認した系ボタン）で別途生成・送信する。例外：会話履歴内でスタッフが既に伝えた確定情報（退去日・入居可能日・保証会社名等）をそのまま引用する場合のみ言及可。新たな日付・募集状況・保証条件をAIが推測して生成することは禁止。\n・【⚠️ 退去予定の断言禁止】「退去後すぐにご案内できます」「退去後すぐにご内覧いただけます」「〇月以降ご案内可能です」のような退去予定を前提とした案内文は、管理会社から退去予定が確認済みである事実が会話履歴にある場合のみ使用すること。確認していない場合は「空室状況を確認してご連絡させて頂きます😊！！」とし、退去予定を勝手に断定しない。\n・【⚠️ 「管理会社に確認してご連絡します」の文章での約束禁止】「管理会社に確認しご連絡させて頂きます」「確認してからご連絡いたします」のように、確認と連絡をセットで約束する文をLINE返信に書いてはいけない。確認が必要な内容はスタッフがAIX【確認します】ボタンで対応する。AI返信では「かしこまりました！！」「確認いたします！！」程度の短い受付のみ書き、「ご連絡させて頂きます」まで続けない。水道代・インターネット・設備の有無など管理会社への確認事項も同様。\n・【⚠️ スタッフが送った物件画像への「内容確認します」禁止】お客様が画像（物件資料・見積書）を送り返してきた場合、その画像はスタッフが先に送った物件の資料であることが多い。「お送り頂きました画像の内容を確認させて頂きます」「画像を確認しご連絡します」のように、まるで初めて見る資料かのように「内容確認します」と書いてはいけない。お客様の具体的な質問（「ここは誰か住んでいましたか？」等）にはその質問に直接答えるか、分からない場合は「確認いたします！！」とのみ伝える。`;

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
  const isLinkRequestMsg = /(リンク|url|ＵＲＬ)\s*(を|の|教え|くださ|ちょうだい|ください|欲し|ほし|送)/i.test(customerMessage)
    || /(この|こちらの|その|これの|さっきの)(部屋|物件|お部屋).{0,6}(リンク|url|ＵＲＬ)/i.test(customerMessage);
  const linkRequestNote = isLinkRequestMsg
    ? `\n\n【🔗 リンク（URL）要求検出（最優先・内覧誘導より上位）】お客様は物件のURL・詳細情報そのものを求めています。内覧日程調整・空室確認へは飛ばさず、対象物件のURL/詳細を案内すること。
・直近の会話で送付済み・話題になっている物件が特定できる場合のみリンク/情報を案内する。履歴にURLがあれば再提示する。
・特定できない場合は「こちらのお部屋ですね！！詳細（募集状況）を確認しご案内させて頂きます😊！！」と物件を確認してから案内する。「気になる物件のURLをお送りください」の聞き返しは禁止。
・対象が退去予定/入居中の物件であれば、その旨を伝えた上で情報を案内し、現地内覧日程は提案しない。`
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

  // ①②統合: closing_strategy（Step1分析）・★決まるパターン・🎯次のアクション（ai_summary）を冒頭に最優先注入
  const closingNote = (() => {
    const parts: string[] = [];
    if (closingStrategyFromAnalysis) parts.push(`AIが判断した成約への一手: ${closingStrategyFromAnalysis}`);
    if (closingPatternFromSummary) parts.push(`この会話の成約ポイント: ${closingPatternFromSummary}`);
    if (nextActionFromSummary) parts.push(`今すぐ打つべき次の一手（スタッフへの行動方針）: ${nextActionFromSummary}`);
    if (parts.length === 0) return "";
    return `【🎯 最優先指示 — フェーズ別パターンより上位・この返信で必ず実行すること】\n${parts.join("\n")}\n⚠️ 上記はスタッフへの行動方針であり、物件の事実情報ではありません。「退去予定」「空き予定」「〜月末まで」等の具体的な期日・空室情報は、会話履歴やDBで確認された事実でない限りLINEメッセージ本文に断言・創作しないこと。\n`;
  })();

  const prompt = `${propertyStatusNote}
${closingNote}${nameNote}${conditionsNote}${missingConditionsNote}${opinionsNote}${summaryNote}${dateNote}${greetingNote}${managementNote}${repetitionNote}${currentPropertyNote}${repeatedConcernNote}${hesitancyNote}${questionsNote}${conditionChangeNote}${pickupPromiseAckNote}
【現在の営業フェーズ】${state}
${phaseGuide}${approachNote}${staffContextNote}
${quickPatterns}
${smoraRulesNote}
${realEstateNote}
${replyContentNote}
${curatedReplyRulesNote}
${aixPropertyRecommendationNote}
${aixPropertySendNote}
${aixOperationNote}
${knowledgeNote}
${phrases}

${QUOTE_REPLY_JUDGE_NOTE}${quotedContextNote}
【直近の会話履歴（スモラ自身の返信も含む）】この履歴を必ず参照すること。履歴内でお客様が既に答えた質問を再度聞かない。スモラが既に伝えた情報と矛盾しない。
${history || "なし"}

${isFollowUp ? "【参考：お客様の直近メッセージ（既に返信済み）】" : "【お客様の最新メッセージ】"}
${customerMessage}${applicationFormNote}${viewingFactNote}${viewingIntentShortReplyNote}${estimateGateNote}${propertyFactGateNote}\n\n${meetingPlaceGateNote}${linkRequestNote}

${examples}${examplesInstruction}

↑${isFollowUp ? "スモラは既にこのメッセージに返信済み。前の返信内容を繰り返さず、続きとして自然につながるメッセージを1つ生成すること。" : "スモラの直前返信の流れを踏まえ、⭐実例の文体・テンポを参考にしながら、上記の挨拶ルール・禁止ワードを必ず守って、このメッセージへのスモラらしい返信を1つ生成してください。"}
長さの目安: 承認・了解→2行、条件確認・ヒアリング→3〜4行、物件紹介→フォーマット通り（制限なし）。初回挨拶の「鈴木と申します」を除き、本文中に担当者名（鈴木など）を入れない。${replyHintNote}${templateNote}`;

  // dbRules を SystemMessage に注入（HumanMessage より優先度が高く aix/action と同じ注入経路）
  const baseSystem = promptOverrides?.generationSystem ?? GENERATION_SYSTEM;
  return [new SystemMessage(dbRules ? baseSystem + dbRules : baseSystem), new HumanMessage(prompt)];
}

const ALLOWED_STATES = new Set([
  "first_reply", "hearing", "proposing", "applying", "closed_won",
  // 旧キーも受け付ける（後方互換）
  "condition_hearing", "property_search", "property_recommendation",
  "viewing", "estimate_request", "availability_check", "application", "screening", "contract",
]);

// 旧ステータスキーを新5段階に正規化
const STATE_ALIAS: Record<string, string> = {
  condition_hearing:       "hearing",
  property_search:         "hearing",
  property_recommendation: "proposing",
  viewing:                 "proposing",
  estimate_request:        "proposing",
  availability_check:      "proposing",
  application:             "applying",
  screening:               "applying",
  contract:                "applying",
};

function normalizeState(k: string): string {
  const resolved = STATE_ALIAS[k] ?? k;
  return ALLOWED_STATES.has(resolved) ? resolved : "first_reply";
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
async function fetchKnowledge(state: string, customerMessage?: string, analysisContext?: string, conversationId?: string): Promise<{ text: string; phraseHits: number }> {
  const stateAliases = STATE_SEARCH_ALIASES[state] || [state];

  // 失注パターン専用バケット（auto-analyze-losers が category=principle / importance=8 で保存するため、
  // pgvector経路の importance>=9 フィルタ・フォールバック経路の principle 除外の両方から漏れる → 専用クエリで必ず届ける）
  const [{ data: lossPatterns }, { data: topPrinciples }, { data: adaptRules }] = await Promise.all([
    supabase
      .from("ai_reply_knowledge")
      .select("id, title, content, importance, category")
      .ilike("title", "失注パターン%")
      .neq("hypothesis_status", "rejected")
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(4),
    // importance>=9 の principle は embedding 検索の取りこぼし（similarity<0.5）に関わらず必ず注入する保証バケット。
    // pgvector経路・フォールバック経路の両方で使う
    supabase
      .from("ai_reply_knowledge")
      .select("id, category, title, content, importance")
      .eq("category", "principle")
      .gte("importance", 8)
      .neq("hypothesis_status", "rejected")
      .order("importance", { ascending: false })
      .limit(5),
    // HIGH-05: テンプレート修正学習ルール（テンプレ適用→スタッフ編集→送信から学習したパターン）
    supabase
      .from("adaptation_improvement_rules")
      .select("rule_text, confidence, category")
      .eq("is_active", true)
      .gte("confidence", 0.7)
      .order("confidence", { ascending: false })
      .limit(5),
  ]);
  const lossList = (lossPatterns ?? []).filter(p => (p.content ?? "").trim().length > 0);
  const lossIds = lossList.map(p => p.id).filter(Boolean);
  const lossBlock = lossList.length > 0
    ? "【🚫 避けるべき対応（失注実例より）】\n" + lossList.map((p, i) => `${i + 1}. ${p.content}`).join("\n")
    : "";

  // pgvector検索（customerMessageがある場合・OPENAI_API_KEYが設定済みの場合）
  if (customerMessage && process.env.OPENAI_API_KEY) {
    const searchQuery = analysisContext
      ? safeSlice(`${state}: ${customerMessage} ${analysisContext}`, 2000)
      : safeSlice(`${state}: ${customerMessage}`, 2000);

    const embedding = await getEmbedding(searchQuery);
    if (embedding) {
      const { data: vectorResults, error: rpcError } = await supabase.rpc("match_reply_knowledge", {
        query_embedding: embedding,
        match_count: 40,
        min_importance: 7,
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
        // ナレッジ洪水対策: 差分学習5件・修正対比5件・絶対ルール8件・パターン5件に上限を削減
        const diffLearned = filteredResults.filter(r => r.title.includes("差分学習")).slice(0, 5);
        const correctionPairs = filteredResults.filter(r => r.title.includes("修正対比")).slice(0, 5);
        // importance>=9 の principle は embedding 検索に漏れても必ず注入する（topPrinciples で保証）
        const criticalVector = filteredResults.filter(r => r.importance >= 8 && r.category === "principle").slice(0, 8);
        const criticalGuaranteed = (topPrinciples ?? []).filter(p => !criticalVector.some(c => c.id === p.id));
        const critical = [...criticalGuaranteed, ...criticalVector.filter(c => !criticalGuaranteed.some(g => g.id === c.id))].slice(0, 8);
        const patterns = filteredResults.filter(r => r.category === "pattern" && !r.title.includes("差分学習") && !r.title.includes("修正対比")).slice(0, 5);
        const phrases = filteredResults.filter(r => r.category === "phrase").slice(0, 6);

        const used = [...diffLearned, ...correctionPairs, ...critical, ...patterns, ...phrases];
        const usedAndLossIds = [...used.map(r => r.id).filter(Boolean), ...lossIds];
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
        // HIGH-05: テンプレート修正学習ルール注入
        if ((adaptRules?.length ?? 0) > 0) {
          sections.push("【📘 テンプレート修正学習ルール（テンプレ活用時の改善パターン — テンプレを使う場合は必ず参照）】\n" +
            (adaptRules as { rule_text: string; category: string }[]).map(r => `・[${r.category}] ${r.rule_text}`).join("\n"));
        }
        return { text: sections.length > 0 ? "\n\n" + sections.join("\n\n") : "", phraseHits: phrases.length };
      }
    }
  }

  // フォールバック: importance順検索（OPENAI_API_KEY未設定時 or embedding取得失敗時）
  // principle は global/stateSpecific クエリから除外しているため、
  // 【⚠️絶対ルール】には冒頭で取得済みの topPrinciples（category=principle・importance>=9）を使う
  const [{ data: stateDiff }, { data: globalDiff }, { data: correctionPairs }, { data: global }, { data: stateSpecific }] = await Promise.all([
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
      .in("conversation_state", stateAliases).gte("importance", 7)
      .not("title", "ilike", "%差分学習%").not("title", "ilike", "%修正対比%")
      .not("category", "eq", "principle").neq("hypothesis_status", "rejected")
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false }).limit(20),
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
  const all = [...stateSpecificList, ...globalList];
  const principlesList = topPrinciples ?? [];
  if (diffLearned.length === 0 && correctionList.length === 0 && all.length === 0 && principlesList.length === 0 && !lossBlock) return { text: "", phraseHits: 0 };

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
  const allFallbackIds = [...usedIds, ...lossIds];
  incrementKnowledgeUsage(allFallbackIds);
  if (conversationId) logKnowledgeApply(allFallbackIds, conversationId);

  const sections: string[] = [];
  if (diffLearned.length > 0) {
    sections.push("【🔴 AIが過去に間違えたパターン（最優先・必ず守る）】\n" + diffLearned.map((k, i) => `${i + 1}. ${k.content}`).join("\n"));
  }
  if (correctionList.length > 0) {
    sections.push("【🟠 スタッフが修正したポイント（このフェーズ専用）】\n" + correctionList.slice(0, 5).map((k, i) => `${i + 1}. ${k.content}`).join("\n"));
  }
  if (critical.length > 0) {
    sections.push("【⚠️ 絶対ルール】\n" + critical.slice(0, 8).map((k, i) => `${i + 1}. ${k.content}`).join("\n"));
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
  // HIGH-05: テンプレート修正学習ルール注入
  if ((adaptRules?.length ?? 0) > 0) {
    sections.push("【📘 テンプレート修正学習ルール（テンプレ活用時の改善パターン — テンプレを使う場合は必ず参照）】\n" +
      (adaptRules as { rule_text: string; category: string }[]).map(r => `・[${r.category}] ${r.rule_text}`).join("\n"));
  }
  return { text: sections.length > 0 ? "\n\n" + sections.join("\n\n") : "", phraseHits: Math.min(phrases.length, 6) };
}

// ─── OpenAI 埋め込み生成（generate-reply 側）────────────────────────────────
async function getEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 6000); // 6秒でタイムアウト
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: safeSlice(text, 2000) }),
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (!res.ok) return null;
    const data = await res.json() as { data?: Array<{ embedding?: number[] }> };
    return data.data?.[0]?.embedding ?? null;
  } catch {
    clearTimeout(tid);
    return null;
  }
}

const ANGLE_LABEL: Record<string, string> = { A: "王道", B: "シンプル", C: "C案", short_direct: "短く直接" };

async function fetchExamples(state: string, customerMessage?: string, lastStaffMessage?: string, analysisContext?: string): Promise<string> {
  const stateAliases = STATE_SEARCH_ALIASES[state] || [state];

  // pgvector 類似検索（OPENAI_API_KEY がある場合のみ・エラー時はフォールバック）
  // follow-up時: 「スモラが送った内容の続き」として検索クエリを構成
  const baseQuery = lastStaffMessage
    ? `${state}: [前返信]${safeSlice(lastStaffMessage, 100)} [顧客]${customerMessage}`
    : customerMessage ? `${state}: ${customerMessage}` : null;
  // 分析で検出したパターン（検討中・URL確認・複数質問等）をクエリに追加して関連例を引く
  const searchQuery = baseQuery && analysisContext
    ? `${baseQuery} パターン: ${analysisContext}`
    : baseQuery;

  if (searchQuery && process.env.OPENAI_API_KEY) {
    const embedding = await getEmbedding(searchQuery);
    if (embedding) {
      const { data: similar, error: rpcError } = await supabase.rpc("match_reply_examples", {
        query_embedding: embedding,
        match_count: 20,
        filter_states: stateAliases,
      }) as { data: Array<{ customer_message: string; sent_reply: string; conversation_state: string; is_starred: boolean; reply_angle: string | null; similarity: number }> | null; error: unknown };

      if (!rpcError && similar && similar.length > 0) {
        // 類似度0.5未満は低品質として除外
        const aboveThreshold = similar.filter(ex => ex.similarity >= 0.5);
        if (aboveThreshold.length > 0) {
        // ★+0.15 に加え、4案から選ばれた実例（reply_angle あり）は+0.1 追加ブースト
        const sorted = [...aboveThreshold].sort((a, b) => {
          const scoreA = a.similarity + (a.is_starred ? 0.15 : 0) + (a.reply_angle ? 0.1 : 0);
          const scoreB = b.similarity + (b.is_starred ? 0.15 : 0) + (b.reply_angle ? 0.1 : 0);
          return scoreB - scoreA;
        }).slice(0, 8);

        return "\n\n【⭐ スモラの実際の返信例（状況が最も類似した実例・類似度順）— 文体・言い回し・感嘆符・絵文字・長さをこの例から忠実に再現すること。文体の参考（会話内容・文脈は当該顧客の履歴を最優先）。ラベル: 王道=標準スモラスタイル / シンプル=短く簡潔 / C案=別角度アプローチ】\n" +
          sorted.map((ex, i) => {
            const angleTag = ex.reply_angle && ex.reply_angle !== "starred" ? `|${ANGLE_LABEL[ex.reply_angle] ?? ex.reply_angle}` : "";
            return `[例${i + 1}${ex.is_starred ? "⭐" : ""}${angleTag}]\nお客様: 「${ex.customer_message}」\nスモラ: 「${ex.sent_reply}」`;
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
    supabase.from("ai_reply_examples").select("customer_message, sent_reply, conversation_state, is_starred, reply_angle")
      .in("conversation_state", stateAliases)
      .eq("entry_source", "line_reply")
      .order("is_starred", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(60),
    // 全フェーズ全件: ☆降順 → 新着順
    supabase.from("ai_reply_examples").select("customer_message, sent_reply, conversation_state, is_starred, reply_angle")
      .eq("entry_source", "line_reply")
      .order("is_starred", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(120),
  ]);

  const sameStateList = sameStateFull ?? [];
  const allStateList = (allStateFull ?? []).filter(
    (ex) => !sameStateList.some((s) => s.sent_reply === ex.sent_reply)
  );

  const all = [
    ...sameStateList.slice(0, 6).map((ex) => ({ ...ex, priority: 1 })),
    ...allStateList.slice(0, 4).map((ex) => ({ ...ex, priority: 2 })),
  ].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.is_starred !== b.is_starred) return a.is_starred ? -1 : 1;
    return 0;
  }).slice(0, 8);

  if (all.length === 0) return "";

  return "\n\n【⭐ スモラの実際の返信例（☆をつけた良質な実例）— 文体・言い回し・感嘆符・絵文字・長さをこの例から忠実に再現すること。文体の参考（会話内容・文脈は当該顧客の履歴を最優先）。ラベル: 王道=標準スモラスタイル / シンプル=短く簡潔 / C案=別角度アプローチ】\n" +
    all.map((ex, i) => {
      const ra = (ex as { reply_angle?: string | null }).reply_angle;
      const angleTag = ra && ra !== "starred" ? `|${ANGLE_LABEL[ra] ?? ra}` : "";
      return `[例${i + 1}${angleTag}]\nお客様: 「${ex.customer_message}」\nスモラ: 「${ex.sent_reply}」`;
    }).join("\n\n");
}

// ─── スタッフが実際に呼んでいた名前を会話履歴から抽出 ────────────────────────
// LINE表示名が短縮・略称の場合（例: "N"）、スタッフが実際に使っていた呼び名を優先する
function extractPreferredName(
  messages: Array<{ sender: string; text?: string | null }>,
  lineDisplayName: string
): string {
  // 部分一致で除外（^先頭一致だと「通過後にオーナー」等が素通りするため含有一致に変更）
  // 「よろし」等の接続表現も除外（「よろしければサさん…」→「よろしければサ」誤抽出防止）
  const NON_NAME_RE = /(お客様|オーナー|大家|管理|業者|保証|担当|スタッフ|弊社|不動産|審査|通過|契約|入居|退去|申込|内覧|皆|各位|こちら|まずは|引き続き|何卒|改めて|よろし|宜し|もしよ|できれば|出来れば|ぜひ|是非)/;
  // 名前の形のみ許可: ひらがな2〜6字 / カタカナ2〜6字 / 漢字1〜4字 / 英字2〜12字（スクリプト混在=「よろしければサ」「頂きサ」等の文断片を排除）
  const NAME_SHAPE_RE = /^[ぁ-ん]{2,6}$|^[ァ-ン]{2,6}$|^[一-鿿々]{1,4}$|^[A-Za-z]{2,12}$/;
  // 動詞・助詞に使われる文字が中間に混ざる候補は文断片とみなして拒否（先頭・末尾は名前でも使われるため対象外）
  const FRAGMENT_CHAR_RE = /[てでにをはがもやかなきしれめとのどこそあいう]/;
  for (const msg of [...messages].reverse()) {
    if (msg.sender !== "staff" || !msg.text) continue;
    // 冒頭の呼びかけのみ対象（文中の「オーナーさん」等の第三者言及は拾わない）
    // {1,8}: 「関さん」等の1文字漢字名も許可（形の妥当性はNAME_SHAPE_REが判定）
    const m = msg.text.match(/^[\s「]*([^\s、。！？\n【】「」（）・]{1,8}?)さん/);
    if (!m) continue;
    const name = m[1];
    if (NON_NAME_RE.test(name)) continue;
    if (name.length > 8) continue;
    // 名前の形（ひらがな/カタカナ/漢字/英字のみ）に一致しない候補は名前ではない
    if (!NAME_SHAPE_RE.test(name)) continue;
    if (name.length >= 3 && FRAGMENT_CHAR_RE.test(name.slice(1, -1))) continue;
    return name;
  }
  // フォールバック: クライアント渡し名にも「よろしければサ」等の汚染が乗り得るためサニタイズ＋末尾「さん」除去（二重さん防止）
  return lineDisplayName
    .replace(/^(もし)?(よろしければ|宜しければ|よければ|できれば|出来れば|ぜひ|是非)/, "")
    .replace(/さん$/, "")
    .trim();
}

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
      : `「${safeSlice(String(q.text), 300)}」`;
    // お客様がリンク（URL）そのものを求めているか判定
    const custText = String((lastCustomerMsg as { text?: string | null } | null)?.text ?? "");
    const isLinkRequest = /(リンク|url|ＵＲＬ)\s*(を|の|教え|くださ|ちょうだい|ください|欲し|ほし|送|ちょーだい)?/i.test(custText)
      || /(この|こちらの|その|これの)(部屋|物件|お部屋).{0,6}(リンク|url|ＵＲＬ)/i.test(custText);
    const linkRequestNote = (isLinkRequest && q.sender === "staff")
      ? `
【🔗 リンク（URL）要求検出（最優先・内覧誘導より上位）】
お客様は引用先の物件のURL・詳細情報そのものを求めています。内覧日程調整・空室確認には飛ばさないこと。
→ 履歴に当該物件のURLがあれば再提示する。無ければ「こちらのお部屋ですね！！詳細（募集状況）を確認しご案内させて頂きます😊！！」と物件を特定した上で募集状況確認へ進む。
→ 「気になる物件のURLをお送りください」という聞き返しは絶対禁止（お客様は既に物件を特定している）。
→ 当該物件が退去予定・入居中の場合は、その旨を伝えた上で情報を案内し、現地内覧日程は提案しない。`
      : "";
    const imageNameSuppressNote = isImage
      ? `
引用した画像がどの物件かはスタッフにしか判断できないため、返信文に物件名・マンション名は絶対に含めないこと（「最大限割引した初期費用の御見積書をご用意します！！」のように物件名なしで返す）。`
      : "";
    return `
【💬 引用リプライ検出（確定事実・最優先文脈）】
お客様の最新メッセージは、${senderLabel}が送ったメッセージ ${contentDesc} への引用（リプライ）です。
お客様は引用先の内容について話している。引用先が物件画像・物件名・物件URLの場合、
その物件への興味として扱い、「気になる物件のURLをお送りください」等の聞き返しは絶対にせず、その物件を前提に返信を生成すること。
ただし内覧日程調整・空室確認の方向で返信するのは、当該物件が退去予定・入居中でない場合に限る。
退去予定・入居中の物件の場合は、現地内覧日程は提案せず「退去日以降のご案内」または「お申込みでお部屋を先に抑えてからのご内覧」を案内すること。${linkRequestNote}${imageNameSuppressNote}`;
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

// ─── POST ────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  }

  type RecentMessage = { sender: string; text: string; imageUrl?: string; createdAt?: string; isAix?: boolean };
  let message: string, state: string, customerName: string, recentMessages: RecentMessage[], customerConditions: string, customerSummary: string, replyHint: string;
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
  // アクティブタスク（body指定 or DB自動補完）。property_check中の返信ガード等に使用
  let activeTaskTypes: string[] = [];
  // ─── テンプレート最適化モード（templateText 指定で有効化）───
  // 「AIで最適化」ボタン: generate-reply の品質パイプライン（Step1分析 + 全プロンプトスタック +
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
  try {
    const body = await req.json() as {
      message: string;
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
    };
    message = body.message;
    state = body.state;
    conversationId = body.conversationId || "";
    includeStopReason = body.includeStopReason === true;
    customerName = body.customerName || "";
    recentMessages = body.recentMessages || [];
    // LINE表示名より会話でスタッフが実際に使った呼び名を優先
    customerName = extractPreferredName(recentMessages, customerName);
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

  // テンプレート最適化モード: 旧adaptルートで実績のある前処理をプロンプト組み立て前に適用
  // （退去予定日/内覧可能日の◯月◯日置換 + 挨拶差し替え。共有lib: app/lib/template-preprocess.ts）
  let preprocessedTemplate = "";
  if (isTemplateOptimize) {
    preprocessedTemplate = applyVacatingDateToTemplate(_sanitizeSurrogates(templateText), vacatingDate);
    preprocessedTemplate = applyGreetingSwap(preprocessedTemplate, staffMessagedToday);
  }

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
  // アクティブタスク状態をreplyHintに反映（動的コンテキスト注入）
  if (activeTaskTypes.includes("property_check")) {
    replyHint = "【募集状況確認中★最重要】現在スタッフが物件の募集状況を確認している最中です。内覧日程・物件提案・見積書の話は絶対にしない。お客様の短い返信（「すいません」「ありがとう」「わかりました」等）には「大丈夫ですよ！！確認でき次第すぐにご連絡させて頂きます！！😊」のような短い返しのみ行う。"
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

  try {
    const currentState = normalizeState(state || "first_reply");

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
    // AIX生成メッセージ・画像のみは「スタッフが返信した」とみなさない
    const isFirstEverReplyFromMsgs = !recentMessages.some(
      m => m.sender === "staff" && !m.isAix && m.text && m.text !== "[画像]" && m.text !== "[動画]"
    );
    const shouldPrependGreeting = isFirstEverReplyFromMsgs && currentState === "first_reply";

    // follow-up検知（履歴末尾がスモラ = 2通目以降の生成）
    const allSpeakersInHistory = [...history.matchAll(/(?:^|\n)(スモラ|お客様):/g)];
    const isFollowUp = allSpeakersInHistory.length > 0 && allSpeakersInHistory[allSpeakersInHistory.length - 1][1] === "スモラ";

    // 最後のスモラメッセージを全文抽出（② の検索クエリ・① の表示用）
    const lastStaffMsgForSearch = (() => {
      const segments = history.split(/\n(?=スモラ:|お客様:)/);
      const seg = [...segments].reverse().find(s => s.startsWith("スモラ:"));
      return seg ? seg.replace(/^スモラ:\s*/, "").trim() : undefined;
    })();

    // ── Step1: 分析を先行実行（検出パターンを実例検索クエリに使うため）
    if (!process.env.OPENAI_API_KEY) {
      console.warn("[generate-reply] OPENAI_API_KEY not set — pgvector検索無効・フォールバック使用");
    }
    const analysis = await analyzeCustomerSituation(message, history, currentState, customerName, isFollowUp);

    // ── 分析結果からパターンキーワードを抽出（実例検索クエリ強化用）
    const analysisContext = (() => {
      try {
        const p = JSON.parse(analysis) as Record<string, unknown>;
        const parts: string[] = [];
        // 返し方の方針
        if (p.approach && typeof p.approach === "string") parts.push(safeSlice(p.approach, 60));
        // 迷い・保留パターン → 検索に使うキーワード化
        const hp = p.hesitancy_pattern;
        if (hp === "thinking")  parts.push("検討します また連絡します ごゆっくり");
        else if (hp === "callback") parts.push("また連絡します 後でご連絡");
        else if (hp === "waiting")  parts.push("少し待ってほしい まだ決めていない キャンセル");
        else if (hp === "undecided") parts.push("どちらにするか迷っています 比較 判断軸");
        else if (hp === "timeline" && p.future_timeline) parts.push(String(p.future_timeline));
        // 複数質問
        if (Array.isArray(p.questions) && (p.questions as string[]).length > 0) {
          parts.push((p.questions as string[]).slice(0, 3).join(" "));
        }
        return parts.length > 0 ? parts.join(" ") : undefined;
      } catch { return undefined; }
    })();

    // ── Step2: 残りを並列実行（実例検索はパターンキーワード付きクエリで実行）
    // 各フェッチはエラーでも生成を止めない（knowledgeなし・実例なしで生成続行）
    const [knowledgeResult, examples, phraseList, autoSummary, dbRules, fetchedSummaryJson, quotedContextNote, templateAdaptRules, categoryAdaptationRules, checkpointsData] = await Promise.all([
      fetchKnowledge(currentState, message, analysisContext, conversationId)
        .catch((err) => { console.error("[generate-reply] fetchKnowledge失敗 — knowledgeなしで生成続行:", err); return { text: "", phraseHits: 0 }; }),
      fetchExamples(currentState, message, isFollowUp ? lastStaffMsgForSearch : undefined, analysisContext)
        .catch((err) => { console.error("[generate-reply] fetchExamples失敗 — 実例なしで生成続行:", err); return ""; }),
      fetchPhrases(currentState)
        .catch((err) => { console.error("[generate-reply] fetchPhrases失敗 — フレーズなしで生成続行:", err); return [] as string[]; }),
      // ai_summaryがない場合のみ条件テキスト+履歴から即席合成（Haiku・並列なので遅延ゼロ）
      !customerSummary && customerConditions
        ? synthesizeCustomerContext(customerConditions, customerName, history)
        : Promise.resolve(""),
      fetchPromptRules("generate_reply", {
        conversation_state: currentState,
        is_first_reply: String(isFirstEverReplyFromMsgs ?? false),
      })
        .catch((err) => { console.error("[generate-reply] fetchPromptRules失敗 — ルールなしで生成続行:", err); return ""; }),
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
      // 過去の会話セーブポイント（チェックポイント）— 長期会話の文脈を補完
      conversationId
        ? (async () => {
            try {
              const { data } = await supabase
                .from("conversation_checkpoints")
                .select("checkpoint_index, summary, key_facts")
                .eq("conversation_id", conversationId)
                .order("checkpoint_index", { ascending: true })
                .limit(3);
              return data ?? [];
            } catch { return []; }
          })()
        : Promise.resolve([]),
    ]);
    // Build checkpoint note for prompt injection
    type CheckpointRow = { checkpoint_index: number; summary: string | null; key_facts: string | null };
    const checkpoints = checkpointsData as CheckpointRow[];
    const checkpointNote = checkpoints.length > 0
      ? `\n【会話履歴サマリー（過去のセーブポイント — 長期会話の文脈）】\n${checkpoints.map((cp) => `■ 第${cp.checkpoint_index}ブロック: ${cp.summary ?? ""}${cp.key_facts ? ` / ${cp.key_facts}` : ""}`).join("\n")}`
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


    // JST 当日（0:00〜23:59）で挨拶済み判定
    // createdAt が含まれるメッセージだけを使用（タイムスタンプなしはフォールバックへ）
    const hasTimestamps = recentMessages.some(m => !!m.createdAt);
    const alreadyGreetedToday = (() => {
      if (!hasTimestamps) return undefined;
      // JST 当日の 0:00〜23:59（UTC換算）
      // JST 0:00 = UTC 前日15:00 なので、JST日付の 0:00 UTC から 9時間引いて実際のUTC境界に変換する
      // （旧実装は Date.UTC(JST日付, 0:00) をそのまま使っており JST 9:00 起点になっていた = JST 0〜9時に当日判定が常にfalse）
      const jst = new Date(Date.now() + 9 * 3600 * 1000);
      const dayStartUtc = Date.UTC(
        jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()
      ) - 9 * 3600 * 1000;
      const jstDayStart = new Date(dayStartUtc);
      const jstDayEnd = new Date(dayStartUtc + 24 * 3600 * 1000 - 1);
      // AIX生成メッセージは「挨拶済み」としてカウントしない（初回挨拶を正しく生成するため）
      return recentMessages.some(m => {
        if (m.sender !== "staff" || m.isAix || !m.createdAt) return false;
        if (!m.text || m.text === "[画像]" || m.text === "[動画]") return false;
        const ts = new Date(m.createdAt);
        return ts >= jstDayStart && ts <= jstDayEnd;
      });
    })();

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
◆ 申込フォーム誘導フレーズの強制置換: 「お申込フォーマット」「ご本人確認書類」を含む文は出力禁止。申込案内が必要な場合は「お気に召されましたらお申込みしお部屋抑えさせて頂きます！！」、内覧案内が必要な場合は「お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！」に必ず置き換える。
◆ 捏造禁止ゲート: 内覧日時・見積金額内訳・空室確認結果・待ち合わせ場所の捏造禁止（AIX物件情報にない情報を補完しない）
${noEmoji ? "◆ 絵文字は一切使用しない（テンプレートに絵文字があっても全て削除）\n" : ""}${soloEntry ? "◆ 1人入居モード（厳守）: 同居人・配偶者・同居者・家族構成・入居人数・お子様・子ども・子供・同居・ご家族 を含む行はすべて出力しない（完全に削除）\n" : ""}${templateLabel ? `【テンプレート名】${templateLabel}\n` : ""}${templateCategory ? `【テンプレートカテゴリ】${templateCategory}\n` : ""}【テンプレート原文（出力の骨格・長さ・構成の基準 — これに従うこと）】
${preprocessedTemplate}

【AIX物件情報（事実情報の参照元 — 物件名・家賃・間取り・特徴の事実のみ使う。構成は参照しない）】
${safeSlice(aixSourceMessage, 1000)}
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
◆ 申込フォーム誘導フレーズの強制置換（骨格維持・フェーズ指示より優先）: 「お申込フォーマット」「ご本人確認書類」を含む文は出力禁止。申込案内が必要な場合は「お気に召されましたらお申込みしお部屋抑えさせて頂きます！！」、内覧案内が必要な場合は「お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！」に必ず置き換える。
${noEmoji ? "◆ 絵文字は一切使用しない（テンプレートに絵文字があっても全て削除）\n" : ""}${soloEntry ? "◆ 1人入居モード（厳守）: 同居人・配偶者・同居者・家族構成・入居人数・お子様・子ども・子供・同居・ご家族 を含む行はすべて出力しない（完全に削除）\n" : ""}${templateLabel ? `【テンプレート名】${templateLabel}\n` : ""}${templateCategory ? `【テンプレートカテゴリ】${templateCategory}\n` : ""}【テンプレート原文（前処理済み）】
${preprocessedTemplate}
${pendingSection ? `\n【🔑 予約送信待ちのAIXメッセージ（物件名・家賃・オススメポイントはここから最優先で読む）】\n${pendingSection}\n` : ""}${learnedRulesSection ? `\n${learnedRulesSection}\n` : ""}
出力は書き直したテンプレート本文のみ。説明・前置き・補足コメントは一切書かない。`;
        })()
      : "";

    // テンプレート最適化モードは SystemMessage 側にもモード宣言を追加（dbRules と同じ注入経路）
    const templateSystemNote = isTemplateOptimize
      ? (aixSourceMessage
          ? "\n\n【AIXテンプレート最適化モード】テンプレートの骨格に従い、AIX物件情報から物件の事実を当てはめる。AIX物件オススメと同じ出力形式にしてはいけない。テンプレートが短ければ出力も短くする。詳細ルールはプロンプト末尾の【🟣✨ AIXテンプレート最適化モード】ブロックに従うこと。"
          : "\n\n【テンプレート最適化モード】今回はテンプレートをベースに、この顧客の状況に最適化した文章を作成してください。詳細ルールはプロンプト末尾の【🟠✨ テンプレート最適化モード】ブロックに従うこと。")
      : "";

    // Sonnetでストリーミング生成
    const messages = buildGenerationMessages(
      message, customerName, aixSourceMessage ? historyForTemplate : history, currentState,
      analysis, knowledge, examples, phrases, customerConditions, resolvedSummary,
      promptOverrides, isFollowUp, replyHint, alreadyGreetedToday,
      isFirstEverReplyFromMsgs, viewingNote, customerStructured, dbRules + templateSystemNote,
      resolvedSummaryJson, quotedContextNote, propertyStatus, templateNote
    );
    // 中6: 顧客の温度感に応じて生成temperatureを可変にする（Step1分析は temperature:0 のまま）
    // ④ Step1で今まさに分析したフレッシュな emotion を最優先し、なければ ai_summary_json.emotion（過去の要約）を使う
    const analysisEmotion = (() => {
      try {
        const p = JSON.parse(analysis) as Record<string, unknown>;
        return typeof p.emotion === "string" && p.emotion ? p.emotion : undefined;
      } catch { return undefined; }
    })();
    const genTemperature = emotionTemperature(analysisEmotion ?? resolvedSummaryJson?.emotion);
    // テンプレート最適化モードは Claude Sonnet 5（temperature非対応のため感情temperatureは適用しない）
    const genStream = (isTemplateOptimize
      ? createTemplateOptimizeModel()
      : createGenerationModel(genTemperature)
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

    // スタッフ向けガイドメモ: Step1分析の closing_strategy をメタラインで返す
    const suggestedAixForMeta = (() => {
      try {
        const p = JSON.parse(analysis) as Record<string, unknown>;
        const note = typeof p.closing_strategy === "string" && p.closing_strategy
          ? p.closing_strategy
          : typeof p.approach === "string" && p.approach
            ? p.approach
            : null;
        return note ? { action: "closing", note } : null;
      } catch { return null; }
    })();

    // Step1分析由来のAIX推薦（deriveSuggestedAix の Step 1.5 で使用）
    // 会話全文・感情・文脈を見たSonnetの判断。aix_reason はログ用途のみで誘導メモには使わない
    const analysisAixAction = (() => {
      try {
        const p = JSON.parse(analysis) as Record<string, unknown>;
        return typeof p.suggested_aix_action === "string" && p.suggested_aix_action
          ? p.suggested_aix_action
          : null;
      } catch { return null; }
    })();

    const analysisAixEnforcement = (() => {
      try {
        const p = JSON.parse(analysis) as Record<string, unknown>;
        const level = p.aix_enforcement_level;
        return (level === "required" || level === "recommended" || level === "optional")
          ? level as "required" | "recommended" | "optional"
          : null;
      } catch { return null; }
    })();

    // Step1分析の closing_strategy（「どうやったら決まるか」の内容）を deriveSuggestedAix に渡す
    const analysisClosingStrategy = (() => {
      try {
        const p = JSON.parse(analysis) as Record<string, unknown>;
        return typeof p.closing_strategy === "string" && p.closing_strategy ? p.closing_strategy : undefined;
      } catch { return undefined; }
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
          // 生成のstop_reason（includeStopReason=true時にトレーラーで呼び出し元へ返す）
          let genStopReason: unknown;
          try {
            const genInputLength = messages.reduce(
              (n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0
            );
            // f-8: センシティブ案件（クレーム/審査否決/キャンセル・リスケ）検知時はドラフト冒頭に警告メタを付与
            // ※テンプレート最適化モードは会話への返信生成ではないため付与しない
            const sensitiveGateNote = !isTemplateOptimize ? buildSensitiveGateNote(message) : "";
            if (shouldPrependGreeting && !isTemplateOptimize) {
              // 真の初回: 全バッファして冒頭挨拶を強制置換（AIが誤生成しても確実に正しい名前を出す）
              // ※テンプレート最適化モードは常に下の通常バッファ経路（テンプレの構成を挨拶強制置換で壊さない）
              let fullText = "";
              for await (const chunk of await genStream) {
                const text = typeof chunk.content === "string" ? chunk.content : "";
                fullText += text;
                if (chunk.response_metadata?.stop_reason) genStopReason = chunk.response_metadata.stop_reason;
              }
              warnIfTruncated(genStopReason, genInputLength);
              // AIの本文先頭が挨拶パターンなら「挨拶センテンスのみ」を正規表現で除去して固定挨拶に置き換え、
              // 挨拶で始まっていなければ全文を本文として保持し先頭に固定挨拶を追加する。
              // （旧実装は改行基準で先頭を捨てていたため、AIが挨拶＋本文を改行なし1行で返すと本文が全消滅していた）
              const trimmedText = fullText.trimStart();
              const aiGreetingPattern = /^(?:「?[^\n]{0,15}(?:さん|様)[、,。\s]*)?(?:はじめまして|初めまして|お世話に|ご連絡|この度|こんにちは|こんばんは|おはよう|夜分遅く)/;
              // 挨拶センテンス1文分（呼びかけ＋挨拶キーワード＋文末「！！」「。」または改行まで）にマッチする
              const greetingSentencePattern = /^(?:「?[^\n！!。]{0,15}(?:さん|様)[、,。\s]*)?(?:はじめまして|初めまして|お世話に|ご連絡|この度|こんにちは|こんばんは|おはよう|夜分遅く|お部屋探し[^！!。\n]{0,30}申します|[^！!。\n]{0,20}と申します)[^！!。\n]{0,40}?(?:[！!。]+|\n)\s*/;
              let bodyPart: string;
              if (aiGreetingPattern.test(trimmedText)) {
                // 冒頭の挨拶センテンスを最大4文まで除去（「はじめまして😊！！」「この度ご連絡〜！！」「〜鈴木と申します！！」等）
                let rest = trimmedText;
                for (let i = 0; i < 4 && greetingSentencePattern.test(rest); i++) {
                  rest = rest.replace(greetingSentencePattern, "");
                }
                bodyPart = rest.trim();
              } else {
                bodyPart = trimmedText.trim();
              }
              // customerName が空の場合は「さん、」部分を除去（「さん、はじめまして」の防止）
              const fixedGreeting = `${buildFirstGreeting(customerName)}\n\n`;
              // 除去後が空（挨拶のみ生成・除去しすぎ）の場合はAI出力をそのまま使う（本文ゼロ防止フォールバック）
              const rawOutput = bodyPart ? fixedGreeting + bodyPart : (trimmedText || fixedGreeting.trim());
              // aixGates: プロンプトのAIXゲート指示をLLMが無視した場合の機械検証（違反文を宣言テンプレに置換）
              const { cleaned, issues } = validateAndClean(rawOutput, { aixGates: true });
              if (issues.length > 0) console.warn("[validate-reply] issues:", issues);
              // f-8: センシティブ検知時は警告メタを冒頭に付与（ai_draft にも保存されスタッフの手動確認を促す）
              const gatedFirstReply = sensitiveGateNote + cleaned;
              controller.enqueue(encoder.encode(gatedFirstReply));
              finalDraftText = gatedFirstReply;
            } else {
              // 非初回: 全テキストをバッファしてから validateAndClean を適用してストリーム出力
              let fullText = "";
              for await (const chunk of await genStream) {
                const text = typeof chunk.content === "string" ? chunk.content : "";
                fullText += text;
                if (chunk.response_metadata?.stop_reason) genStopReason = chunk.response_metadata.stop_reason;
              }
              warnIfTruncated(genStopReason, genInputLength);
              // aixGates: 通常返信ドラフトのみ機械検証。テンプレート最適化はAIX由来の日時・金額が正当なため対象外
              const { cleaned, issues } = validateAndClean(fullText, { aixGates: !isTemplateOptimize });
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
                outText = outText.trim();
              }
              // f-8: センシティブ検知時は警告メタを冒頭に付与（空生成時は付与しない・テンプレ最適化は sensitiveGateNote="" ）
              if (outText && sensitiveGateNote) outText = sensitiveGateNote + outText;
              if (outText) controller.enqueue(encoder.encode(outText));
              finalDraftText = outText;
            }
            // AIXボタン誘導: ドラフト完成後にどのAIXボタンを使うべきか提案（トレーラーとして付加）
            // suggest-next-action（DB学習ルール）を優先し、失敗時はregexにフォールバック
            const internalBaseUrl = process.env.NEXT_PUBLIC_SITE_URL
              ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
            const resolvedStatusForAix = detectPropertyStatus(history, message, propertyStatus);
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
              const suggestedAix = await deriveSuggestedAix(finalDraftText, currentState, conversationId || undefined, internalBaseUrl, resolvedStatusForAix, message, analysisAixAction, analysisAixEnforcement, analysisClosingStrategy);
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
              const { error: saveErr } = await supabase
                .from("conversations")
                .update(
                  !isTruncated && finalDraftText.trim()
                    ? { ai_draft: finalDraftText.trim(), draft_pending_at: null, draft_attempted_at: null }
                    : { draft_pending_at: null } // 空生成・尻切れでも pending は解除（永続pending防止）。attempted_at は残す＝10分間リトライしない
                )
                .eq("id", conversationId);
              if (saveErr) console.error("[generate-reply] ai_draft save error:", conversationId, saveErr.message);
            }
          } catch (streamErr) {
            console.error("generate-reply stream error:", streamErr);
            // フォールバックテキストを返す（無言クローズだとフロントが空ドラフト表示になるため）
            try {
              controller.enqueue(encoder.encode("（AI返信の生成に失敗しました。再生成をお試しください）"));
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
