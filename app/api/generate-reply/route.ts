import { NextRequest, NextResponse } from "next/server";
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
import { validateAndClean } from "@/app/lib/validate-reply";
import { fetchPromptRules } from "@/app/lib/prompt-rules";
import { safeSlice } from "@/app/lib/safe-slice";

// Vercel Functions のタイムアウト上限（秒）— Vision + 2段LLM呼び出しに余裕を持たせる
export const maxDuration = 60;

// ─── モデル定義 ───────────────────────────────────────────────────────────────
// Step1（分析）: Sonnet — 感情・本音・成約戦略の精度重視
const analysisModel = new ChatAnthropic({
  model: "claude-sonnet-4-6",
  maxTokens: 1536, // 1024だと分析JSONが尻切れになりJSON.parse失敗するリスクがあるため引き上げ
  temperature: 0,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
  clientOptions: { timeout: 45_000 },
});

// Step2（生成）: Sonnet — 品質重視
// 中6: temperature は ai_summary_json.emotion に応じて可変（0.3〜0.5）のためリクエスト毎に生成する
function createGenerationModel(temperature: number) {
  return new ChatAnthropic({
    model: "claude-sonnet-4-6",
    maxTokens: 1500,
    temperature,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
    clientOptions: { timeout: 45_000 },
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
function buildFirstGreeting(customerName: string): string {
  return `${customerName ? `${customerName}さん、` : ""}はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！`;
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
  property_check_result: "管理会社から回答が来たら → AIX【物件確認した】で結果報告文を生成してください",
  followup_revive: "AIX【追客する】で再接触メッセージを生成できます",
};

async function deriveSuggestedAix(
  draftText: string,
  conversationState: string,
  conversationId?: string,
  internalBaseUrl?: string,
  propertyStatus?: PropertyStatus,
): Promise<{ action: string; note: string } | null> {
  // 退去予定/入居中の物件では現地内覧が不可のため viewing_invite（内覧日調整）は提案しない。
  // 代わりに空室確認（acknowledge_check）または申込で先に確保（application_push）を優先する。
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
  // ─── Step 0: webhook が先行計算したキャッシュを確認（最速パス・ネットワーク呼び出し不要）───
  if (conversationId) {
    try {
      const { data: convCache } = await supabase
        .from("conversations")
        .select("suggested_next_aix")
        .eq("id", conversationId)
        .maybeSingle();
      const cached = (convCache as { suggested_next_aix?: string | null } | null)?.suggested_next_aix;
      if (cached && AIX_ACTION_NOTES[cached]) {
        return redirectMoveOut(cached, AIX_ACTION_NOTES[cached]);
      }
    } catch { /* DBエラーは無視して次のステップへ */ }
  }

  // ─── Step 1: suggest-next-action（DB学習ルール）に問い合わせ（3秒タイムアウト） ───
  if (conversationId && internalBaseUrl) {
    try {
      const res = await fetch(`${internalBaseUrl}/api/suggest-next-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId }),
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = await res.json() as { action?: string | null; reason?: string };
        if (data.action && AIX_ACTION_NOTES[data.action]) {
          return redirectMoveOut(data.action, AIX_ACTION_NOTES[data.action]);
        }
      }
    } catch {
      // タイムアウト・ネットワークエラー等は無視してregexフォールバックへ
    }
  }

  // ─── Step 2: regexフォールバック（suggest-next-actionが何も返さなかった場合） ───
  const d = draftText;

  // ① 確認系 → acknowledge_check（管理会社への連絡）
  if (/確認(させていただき|させて|出来|でき|しま)/.test(d)) {
    return {
      action: "acknowledge_check",
      note: "送信後 → AIX【確認します】ボタンで管理会社への空室確認＋見積書依頼を送ってください（宛先は管理会社です）",
    };
  }
  // ② 日程プレースホルダーあり → viewing_invite（退去予定物件では申込/確認へリダイレクト）
  if (/\[日付\]|\[時間帯\]|\[日時\]/.test(d)) {
    return redirectMoveOut(
      "viewing_invite",
      "⚠️ AIX【内覧日調整】ボタンで日時を選択してから送信してください（空欄のまま送らないでください）",
    );
  }
  // ③ ピックアップ・物件送付系 → property_send
  if (/ピックアップ|お送りします|物件(を|の資料|情報)/.test(d)) {
    return {
      action: "property_send",
      note: "物件URLが揃ったら → AIX【物件ピックアップした】でカバーメッセージを生成して一緒に送ってください",
    };
  }
  // ④ 申込前向き → application_push (confirm)
  if (/申し込み|申込(みま|ます)|決めます|お願いします/.test(d)) {
    return {
      action: "application_push",
      note: "申込の意思が確認できます → AIX【申込へ！】→ confirmモードで確定文を即送信してください",
    };
  }
  // ⑤ 申込迷い系 → application_push (push)
  if (/検討|迷って|どうしよう|もう少し/.test(d)) {
    return {
      action: "application_push",
      note: "AIX【申込へ！】→ pushモードで背中を押すメッセージを生成できます",
    };
  }
  // ⑥ 内覧後フォロー → greeting_viewing
  if (conversationState === "viewing" || /いかがでしたか|いかがでした|感想|内覧(はいかが|後)/.test(d)) {
    return {
      action: "greeting_viewing",
      note: "内覧後フォロー → AIX【挨拶（内覧後）】で結果に応じたフォローメッセージを生成してください",
    };
  }
  // ⑦ 見積書案内 → estimate_sheet
  if (/見積書|初期費用|費用のご案内|金額/.test(d)) {
    return {
      action: "estimate_sheet",
      note: "見積書が届いたら → AIX【見積書送る】で画像を読み取って自動計算＋カバーメッセージを生成できます（OCR対応）",
    };
  }
  // ⑧ 待ち合わせ確定 → meeting_place
  if (/お待ちして|現地で|エントランス|お会いしま/.test(d)) {
    return {
      action: "meeting_place",
      note: "AIX【待ち合わせ】ボタンで物件住所入り確定メッセージを生成できます",
    };
  }
  // ⑨ ヒアリング誘導 → condition_hearing
  if (conversationState === "first_reply" || conversationState === "hearing") {
    if (/条件|ご希望|間取り|エリア|予算/.test(d)) {
      return {
        action: "condition_hearing",
        note: "条件ヒアリングが必要な場合 → AIX【条件ヒアリング】ボタンで既知情報をスキップした形式で送れます",
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
const MOVE_OUT_PATTERN = /退去予定|退去後|入居中|居住中|入居者|[0-9０-９]{1,2}\s*月末?\s*退去|退去[はが]?[0-9０-９]{1,2}\s*月/;

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
  "future_timeline": "お客様が「○月に」「○日には」など具体的な申込タイムラインを示している場合その内容。なければnull"
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
  "condition_change_type": "お客様が検索条件を変更・追加・緩和したか、または物件ピックアップ・送付を依頼しているか。該当する場合その種別（'area_change'=エリア変更、'rent_change'=家賃変更、'layout_change'=間取り変更、'condition_relax'=条件緩和、'pickup_request'=物件を送って・ピックアップ依頼・おすすめ、'multi'=複数変更）。なければnull",
  "hesitancy_pattern": "お客様が「検討します」「また連絡します」「少し待ってほしい」「迷っています」など、決断を保留するパターンを示しているか。示している場合はその種別（'thinking'=検討中・'callback'=また連絡・'waiting'=もう少し待って・'undecided'=どちらか迷い・'timeline'=○月に決めたい ）、なければnull",
  "future_timeline": "お客様が「○月に」「○日には」など具体的な決断・申込タイムラインを示している場合その内容。なければnull"
}`;

  try {
    const res = await analysisModel.invoke([
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
  propertyStatus?: PropertyStatus
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
      : `\n【⏰ 挨拶ルール・最優先】現在${jstHour}時台（JST）。今回の冒頭は「〇〇さんお世話になっております！！」を使う。「夜分遅くに失礼致します」は返信時には絶対禁止（スタッフから先に連絡するときのみ使う言葉）。`;

  const managementNote = isWeekend
    ? `\n【管理会社の状況・必ず守ること】本日は土日。物件の募集状況確認（空室確認）は土日でも可能なので「確認させていただきます！確認出来次第ご連絡させていただきます！！」と伝えてよい。ただし交渉（フリーレント・値引き・条件変更・審査再挑戦など）は土日不可。交渉が必要な場合は「月曜日一番で管理会社に交渉させていただきます！！」と伝える。`
    : jstHour >= 18
      ? `\n【管理会社の状況・必ず守ること】現在${jstHour}時台（JST）。18時以降のため管理会社の営業時間が終了している。確認が必要な場合は「本日は管理会社の営業時間が終了しておりますので、明日一番でご確認しご連絡させて頂きます！！」と伝える。当日中の回答を約束しない。`
      : jstHour < 9
        ? `\n【管理会社の状況・必ず守ること】現在${jstHour}時台（JST）。管理会社の営業時間前（営業は9時〜18時）。確認が必要な場合は「本日、管理会社の営業開始後に確認し、確認出来次第ご連絡させて頂きます！！」と伝える。営業時間前の即時確認・即時回答を約束しない。`
        : `\n【管理会社の状況】現在${jstHour}時台（JST）。管理会社営業中（平日9時〜18時）。確認が必要な場合は「管理会社に確認させていただきます！！確認出来次第ご連絡させていただきます！！」と伝えてよい。`;

  const dateNote = `\n【📅 今日の日付（JST・必ず基準にすること）】${getJSTDateString()} — 「明日」「明後日」「今週」などの相対表現や具体的な日付（○日）は全てこの日付を起点に計算すること`;

  const nameNote = customerName ? `お客様名：${customerName}さん` : "お客様名：不明";
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
      if (p.current_property && typeof p.current_property === "string") {
        currentPropertyNote = `\n【🏠 現在話している物件】${p.current_property} — この物件の文脈で返信すること。`;
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
          hesitancyNote = `\n【🔀 物件迷いパターン検出★実データ反映】複数物件で迷っている。判断軸を提供する：各物件の具体的な違い（費用・立地・設備）を数字で比較し、「初期費用を軸にお選びになられるのはいかがでしょうか」等で決断を後押しする。`;
        }
      }

      // ③ 条件変更/ピックアップ依頼検出
      if (p.condition_change_type && typeof p.condition_change_type === "string") {
        const changeType = p.condition_change_type; // typeof ガードで string に絞り込み済み（as 不要）
        const typeLabel: Record<string, string> = {
          area_change: "エリア変更",
          rent_change: "家賃変更",
          layout_change: "間取り変更",
          condition_relax: "条件緩和（拡大）",
          pickup_request: "物件ピックアップ依頼",
          multi: "複数条件変更",
        };
        const label = typeLabel[changeType] ?? changeType;
        // 拡大・緩和（condition_relax）の場合: ピックアップ宣言 + まだ聞けていない条件を1〜2点確認してよい
        if (changeType === "condition_relax") {
          conditionChangeNote = `\n【🔄 ${label}検出】エリア拡大・家賃上限UP等で選択肢が広がった。必ずピックアップ宣言を行うこと。さらに「まだ聞けていない重要条件（間取り・築年数など）」が1〜2点あれば追加確認してよい（すでに分かっている条件は聞き返さない）。`;
        } else {
          // 条件変更・ピックアップ依頼: 追加質問は禁止、即行動宣言で完結
          conditionChangeNote = `\n【🔄 ${label}検出（最重要・絶対遵守）】追加条件を聞き返すことは絶対禁止。変更内容を具体的なエリア名・数字で言葉にして、即座に行動宣言する。「ピックアップします」「お送りします」で完結させること。`;
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
  const replyContentNote = `\n${promptOverrides?.replyContentRules ?? REPLY_CONTENT_RULES}`;
  const curatedReplyRulesNote = `\n${CURATED_REPLY_RULES}`;
  // AIXルールはgenerate-reply（一般LINE返信）には注入しない（aix/action専用）
  // 管理UIでオーバーライドが明示設定された場合のみ注入
  const aixPropertyRecommendationNote = promptOverrides?.aixPropertyRecommendationRules ? `\n${promptOverrides.aixPropertyRecommendationRules}` : "";
  const aixPropertySendNote = promptOverrides?.aixPropertySendRules ? `\n${promptOverrides.aixPropertySendRules}` : "";

  // 申込フォーム検出（applying フェーズのみ・氏名・緊急連絡先・住所等のキーワード）＋直近の画像なし → 身分証リクエスト注入
  const isApplicationFormText = /緊急連絡|氏名|フリガナ|生年月日|現住所|住居年数|続柄|勤務先/.test(customerMessage);
  // 直近のスタッフ返信以降のお客様メッセージに画像があるかチェック（全履歴ではなく直近のみ）
  const historyLinesForCheck = (history || "").split("\n");
  const lastStaffLineIdx = historyLinesForCheck.map((l, i) => l.startsWith("スモラ:") ? i : -1).filter(i => i >= 0).at(-1) ?? -1;
  const customerLinesAfterLastStaff = historyLinesForCheck.slice(lastStaffLineIdx + 1).filter(l => l.startsWith("お客様:"));
  const hasRecentCustomerImage = customerLinesAfterLastStaff.some(l => l.includes("【画像を送ってきた】"));
  const applicationFormNote = (state === "applying" && isApplicationFormText && !hasRecentCustomerImage)
    ? `\n\n【🚨 申込フォーム受取・身分証なし検出】お客様からフォーム（個人情報テキスト）が送られてきたが、身分証明書の写真がない。返信には必ず「身分証明書（運転免許証またはマイナンバーカード）の表裏のお写真もお送りいただけますでしょうか！！」を含めること。フォーム未記入欄（勤務先等）があれば同時に確認する。パターンG-1で対応。`
    : "";

  // 退去予定/入居中を決定論的に検出 → 最優先ブロックを注入（テキスト検出漏れによる誤内覧提案を防止）
  const resolvedPropertyStatus = detectPropertyStatus(history, customerMessage, propertyStatus);
  const propertyStatusNote = buildPropertyStatusNote(resolvedPropertyStatus);

  // 退去予定物件では「内覧可能日時あり」でも現地内覧日を提案させない（viewingFactNote を上書き）
  const viewingFactNote = (resolvedPropertyStatus === "move_out_scheduled" || resolvedPropertyStatus === "occupied")
    ? `\n\n【📅 内覧日時について】この物件は退去予定/入居中のため現地内覧はできません。内覧可能日時が渡されていても現地内覧日程は提案せず、[日付][時間帯]プレースホルダーも使用禁止。「退去後すぐにご案内します」「お申込みでお部屋を先に抑えてからのご内覧も可能です」の方向で返すこと。`
    : viewingNote
    ? `\n\n【📅 内覧可能日時（確定事実）】\n${viewingNote}\n※ 内覧を提案する場合はこの日時のみ使用。[日付][時間帯]はこの内容で必ず置き換えること。`
    : `\n\n【📅 内覧日時について】内覧可能日時の情報がないため、[日付][時間帯]プレースホルダーは使用禁止。内覧を提案する場合は「ご都合のよい日時をお聞かせください！！」等の表現に置き換えること。架空の日時・曜日は絶対に記載しない。`;

  // お客様メッセージ自体がリンク（URL）を求めている場合の専用ノート（引用コンテキスト非依存の保険）
  const isLinkRequestMsg = /(リンク|url|ＵＲＬ)\s*(を|の|教え|くださ|ちょうだい|ください|欲し|ほし|送)/i.test(customerMessage)
    || /(この|こちらの|その|これの|さっきの)(部屋|物件|お部屋).{0,6}(リンク|url|ＵＲＬ)/i.test(customerMessage);
  const linkRequestNote = isLinkRequestMsg
    ? `\n\n【🔗 リンク（URL）要求検出（最優先・内覧誘導より上位）】お客様は物件のURL・詳細情報そのものを求めています。内覧日程調整・空室確認へは飛ばさず、対象物件のURL/詳細を案内すること。
・直近の会話で送付済み・話題になっている物件が特定できる場合のみリンク/情報を案内する。履歴にURLがあれば再提示する。
・特定できない場合は「こちらのお部屋ですね！！詳細（募集状況）を確認しご案内させて頂きます😊！！」と物件を確認してから案内する。「気になる物件のURLをお送りください」の聞き返しは禁止。
・対象が退去予定/入居中の物件であれば、その旨を伝えた上で情報を案内し、現地内覧日程は提案しない。`
    : "";

  const replyHintNote = replyHint
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
    if (nextActionFromSummary) parts.push(`今すぐ打つべき次の一手: ${nextActionFromSummary}`);
    if (parts.length === 0) return "";
    return `【🎯 最優先指示 — フェーズ別パターンより上位・この返信で必ず実行すること】\n${parts.join("\n")}\n`;
  })();

  const prompt = `${propertyStatusNote}
${closingNote}${nameNote}${conditionsNote}${missingConditionsNote}${opinionsNote}${summaryNote}${dateNote}${greetingNote}${managementNote}${repetitionNote}${currentPropertyNote}${repeatedConcernNote}${hesitancyNote}${questionsNote}${conditionChangeNote}
【現在の営業フェーズ】${state}
${phaseGuide}${approachNote}${staffContextNote}
${quickPatterns}
${smoraRulesNote}
${realEstateNote}
${replyContentNote}
${curatedReplyRulesNote}
${aixPropertyRecommendationNote}
${aixPropertySendNote}
${knowledgeNote}
${phrases}

${QUOTE_REPLY_JUDGE_NOTE}${quotedContextNote}
【直近の会話履歴（スモラ自身の返信も含む）】この履歴を必ず参照すること。履歴内でお客様が既に答えた質問を再度聞かない。スモラが既に伝えた情報と矛盾しない。
${history || "なし"}

${isFollowUp ? "【参考：お客様の直近メッセージ（既に返信済み）】" : "【お客様の最新メッセージ】"}
${customerMessage}${applicationFormNote}${viewingFactNote}${linkRequestNote}

${examples}${examplesInstruction}

↑${isFollowUp ? "スモラは既にこのメッセージに返信済み。前の返信内容を繰り返さず、続きとして自然につながるメッセージを1つ生成すること。" : "スモラの直前返信の流れを踏まえ、⭐実例の文体・テンポを参考にしながら、上記の挨拶ルール・禁止ワードを必ず守って、このメッセージへのスモラらしい返信を1つ生成してください。"}
長さの目安: 承認・了解→2行、条件確認・ヒアリング→3〜4行、物件紹介→フォーマット通り（制限なし）。初回挨拶の「鈴木と申します」を除き、本文中に担当者名（鈴木など）を入れない。${replyHintNote}`;

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
    const res = await analysisModel.invoke([new HumanMessage(summaryPrompt)]);
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
  // fire-and-forget: used_count を +1、last_used_at を更新
  supabase.rpc("increment_knowledge_used_count", { p_ids: ids }).then(() => {}, () => {});
}

function logKnowledgeApply(ids: string[], conversationId: string): void {
  if (!ids.length || !conversationId) return;
  // fire-and-forget: knowledge_apply_log に適用記録（result=pending）
  // C05: source='generate_reply' を付与して aix/action 由来のログと混在しないようスコープ
  supabase.from("knowledge_apply_log").insert(
    ids.map(id => ({ knowledge_id: id, conversation_id: conversationId, source: "generate_reply" }))
  ).then(() => {}, () => {});
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
      .order("is_starred", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(60),
    // 全フェーズ全件: ☆降順 → 新着順
    supabase.from("ai_reply_examples").select("customer_message, sent_reply, conversation_state, is_starred, reply_angle")
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
  const NON_NAME_RE = /(お客様|オーナー|大家|管理|業者|保証|担当|スタッフ|弊社|不動産|審査|通過|契約|入居|退去|申込|内覧|皆さ|各位|こちら|まずは|引き続き|何卒|改めて)/;
  for (const msg of [...messages].reverse()) {
    if (msg.sender !== "staff" || !msg.text) continue;
    // 冒頭の呼びかけのみ対象（文中の「オーナーさん」等の第三者言及は拾わない）
    const m = msg.text.match(/^[\s「]*([^\s、。！？\n【】「」（）・]{2,8}?)さん/);
    if (!m) continue;
    const name = m[1];
    if (NON_NAME_RE.test(name)) continue;
    if (!name) continue;
    const hasJp = /[ぁ-んァ-ン一-鿿]/.test(name);
    const hasLatin = /[a-zA-Z]/.test(name);
    if (hasJp && hasLatin) continue;
    return name;
  }
  // フォールバック: LINE表示名末尾の「さん」を除去してから返す（二重さん防止）
  return lineDisplayName.replace(/さん$/, "");
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
    return `
【💬 引用リプライ検出（確定事実・最優先文脈）】
お客様の最新メッセージは、${senderLabel}が送ったメッセージ ${contentDesc} への引用（リプライ）です。
お客様は引用先の内容について話している。引用先が物件画像・物件名・物件URLの場合、
その物件への興味として扱い、「気になる物件のURLをお送りください」等の聞き返しは絶対にせず、その物件を前提に返信を生成すること。
ただし内覧日程調整・空室確認の方向で返信するのは、当該物件が退去予定・入居中でない場合に限る。
退去予定・入居中の物件の場合は、現地内覧日程は提案せず「退去日以降のご案内」または「お申込みでお部屋を先に抑えてからのご内覧」を案内すること。${linkRequestNote}`;
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
    // アクティブタスク状態をreplyHintに反映（動的コンテキスト注入）
    if (body.activeTaskTypes?.includes("property_check")) {
      replyHint = "【募集状況確認中★最重要】現在スタッフが物件の募集状況を確認している最中です。内覧日程・物件提案・見積書の話は絶対にしない。お客様の短い返信（「すいません」「ありがとう」「わかりました」等）には「大丈夫ですよ！！確認でき次第すぐにご連絡させて頂きます！！😊」のような短い返しのみ行う。"
        + (replyHint ? "\n" + replyHint : "");
    }
    screenshotBase64 = body.screenshotBase64;
    screenshotMediaType = body.screenshotMediaType;
    viewingNote = body.viewingNote || "";
    propertyStatus = body.propertyStatus;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  // 空メッセージは Vision 呼び出しより前に弾く（無駄な API 課金・待ち時間の防止）
  if (!message) return NextResponse.json({ ok: false, error: "message required" }, { status: 400 });

  // 孤立サロゲート（LINE絵文字等）をU+FFFDに置換してAnthropicへのHTTP 400を防止
  const _sanitizeSurrogates = (s: string) =>
    s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
  message = _sanitizeSurrogates(message);
  recentMessages = recentMessages.map(m => ({ ...m, text: _sanitizeSurrogates(m.text) }));

  // スクショがある場合: Sonnet Vision でトーク内容を抽出して replyHint に注入
  if (screenshotBase64) {
    try {
      const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").replace(/\s/g, "");
      const visionRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1500,
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
        const visionData = await visionRes.json() as { content?: Array<{ text: string }>; stop_reason?: string };
        warnIfTruncated(visionData.stop_reason, screenshotBase64.length);
        const extracted = visionData.content?.[0]?.text?.trim() ?? "";
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
    const [knowledgeResult, examples, phraseList, autoSummary, dbRules, fetchedSummaryJson, quotedContextNote] = await Promise.all([
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
    ]);
    const resolvedSummary = customerSummary || autoSummary;
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

    // Sonnetでストリーミング生成
    const messages = buildGenerationMessages(
      message, customerName, history, currentState,
      analysis, knowledge, examples, phrases, customerConditions, resolvedSummary,
      promptOverrides, isFollowUp, replyHint, alreadyGreetedToday,
      isFirstEverReplyFromMsgs, viewingNote, customerStructured, dbRules,
      resolvedSummaryJson, quotedContextNote, propertyStatus
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
    const genStream = createGenerationModel(genTemperature).stream(messages);

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

    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        async start(controller) {
          // 1行目: メタデータJSON（フロントエンドがok確認に使用）
          controller.enqueue(encoder.encode(
            JSON.stringify({ ok: true, quality: qualityFlags, suggested_aix: suggestedAixForMeta }) + "\n"
          ));
          // 生成完了テキスト（conversationId 指定時の ai_draft 保存用）
          let finalDraftText = "";
          // 生成のstop_reason（includeStopReason=true時にトレーラーで呼び出し元へ返す）
          let genStopReason: unknown;
          try {
            const genInputLength = messages.reduce(
              (n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0
            );
            if (shouldPrependGreeting) {
              // 真の初回: 全バッファして冒頭挨拶を強制置換（AIが誤生成しても確実に正しい名前を出す）
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
              const { cleaned, issues } = validateAndClean(rawOutput);
              if (issues.length > 0) console.warn("[validate-reply] issues:", issues);
              controller.enqueue(encoder.encode(cleaned));
              finalDraftText = cleaned;
            } else {
              // 非初回: 全テキストをバッファしてから validateAndClean を適用してストリーム出力
              let fullText = "";
              for await (const chunk of await genStream) {
                const text = typeof chunk.content === "string" ? chunk.content : "";
                fullText += text;
                if (chunk.response_metadata?.stop_reason) genStopReason = chunk.response_metadata.stop_reason;
              }
              warnIfTruncated(genStopReason, genInputLength);
              const { cleaned, issues } = validateAndClean(fullText);
              if (issues.length > 0) console.warn("[validate-reply] issues:", issues);
              if (cleaned) controller.enqueue(encoder.encode(cleaned));
              finalDraftText = cleaned;
            }
            // AIXボタン誘導: ドラフト完成後にどのAIXボタンを使うべきか提案（トレーラーとして付加）
            // suggest-next-action（DB学習ルール）を優先し、失敗時はregexにフォールバック
            const internalBaseUrl = process.env.NEXT_PUBLIC_SITE_URL
              ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
            const resolvedStatusForAix = detectPropertyStatus(history, message, propertyStatus);
            const suggestedAix = await deriveSuggestedAix(finalDraftText, currentState, conversationId || undefined, internalBaseUrl, resolvedStatusForAix);
            if (suggestedAix) {
              controller.enqueue(encoder.encode(`\n<<<SUGGESTED_AIX:${JSON.stringify(suggestedAix)}>>>`));
            }
            // includeStopReason=true（generate-pending-drafts）の場合のみ stop_reason トレーラーを付加
            // → 呼び出し元が max_tokens 尻切れを検知して保存をスキップできるようにする
            // ⚠️ 必ず【最後】のトレーラーとして出力する（SUGGESTED_AIX より後）。
            //    以前 STOP_REASON→SUGGESTED_AIX の順で出力していたため、呼び出し元の末尾アンカー抽出が失敗し
            //    タグ入りドラフトが ai_draft に保存されるバグが発生した（2026-07 修正済み）
            if (includeStopReason) {
              controller.enqueue(encoder.encode(`\n<<<STOP_REASON:${String(genStopReason ?? "unknown")}>>>`));
            }
            // ✅ 成功時: ai_draft 保存 + draft_pending_at クリア（次のCronでスキップさせる）+ draft_attempted_at クリア（orphanedクエリで拾われないように）
            // ※ draft_updated_at カラムは conversations に存在しないため未使用（追加時はここで更新すること）
            if (conversationId) {
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
            // ❌ 失敗時: draft_pending_at をクリアして永続pendingを防止
            // ※ draft_attempted_at は意図的に触らない（残す＝10分間はorphanedクエリでリトライされない）
            // ※ draft_error_at カラムは conversations に存在しないためエラー時刻は記録しない（追加時はここで記録すること）
            if (conversationId) {
              const { error: clearErr } = await supabase
                .from("conversations")
                .update({ draft_pending_at: null })
                .eq("id", conversationId);
              if (clearErr) console.error("[generate-reply] draft_pending_at clear error:", conversationId, clearErr.message);
            }
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
    if (conversationId) {
      try {
        await supabase.from("conversations").update({ draft_pending_at: null }).eq("id", conversationId);
      } catch (clearErr) {
        console.error("[generate-reply] draft_pending_at clear error:", conversationId, clearErr);
      }
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
