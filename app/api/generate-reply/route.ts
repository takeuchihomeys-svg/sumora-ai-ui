import { NextRequest, NextResponse } from "next/server";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { supabase } from "@/app/lib/supabase";
import {
  EMOJI_RULE,
  STYLE_RULE,
  PHASE_GUIDE,
  GENERATION_SYSTEM,
  SMORA_QUICK_PATTERNS,
  REAL_ESTATE_RULES,
} from "@/app/lib/line-reply-prompts";

// ─── モデル定義 ───────────────────────────────────────────────────────────────
// Step1（分析）: Haiku — 速度重視
const analysisModel = new ChatAnthropic({
  model: "claude-haiku-4-5-20251001",
  maxTokens: 1024,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
});

// Step2（生成）: Sonnet — 品質重視
const generationModel = new ChatAnthropic({
  model: "claude-sonnet-4-6",
  maxTokens: 800,
  temperature: 0.3,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
});

// EMOJI_RULE / STYLE_RULE は @/app/lib/line-reply-prompts からインポート済み

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
    const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
    const match = text.match(/\{[\s\S]*\}/);
    return match ? match[0] : "";
  } catch {
    return "";
  }
}



// ─── JST時刻取得 ─────────────────────────────────────────────────────────────
function getJSTHour(): number {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCHours();
}
// JST 9:00 AM リセット基準時刻（UTC）を返す
// 9時以降なら今日の0:00 UTC、9時前なら昨日の0:00 UTC（= JST 9:00 AM の直前のリセット点）
function getGreetingSessionStart(): Date {
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const h = jstNow.getUTCHours();
  const y = jstNow.getUTCFullYear();
  const mo = jstNow.getUTCMonth();
  const d = jstNow.getUTCDate();
  return h >= 9
    ? new Date(Date.UTC(y, mo, d, 0, 0, 0, 0))
    : new Date(Date.UTC(y, mo, d - 1, 0, 0, 0, 0));
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


type PromptOverrides = {
  generationSystem?: string;
  quickPatterns?: string;
  phaseGuide?: Record<string, string>;
  realEstateRules?: string;
  replyContentRules?: string;
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
  alreadyGreetedToday?: boolean
): [SystemMessage, HumanMessage] {
  const jstHour = getJSTHour();
  const jstDay = getJSTDayOfWeek();
  const isWeekend = jstDay === 0 || jstDay === 6;

  // 履歴を先に解析（挨拶使用済みか判定するため）
  const historyLines = (history || "").split("\n").filter(Boolean);
  const lastStaffLines = historyLines.filter((l) => l.startsWith("スモラ:"));
  // スタッフ返信が一度もない = 真の初回（お客様への最初の返信）
  const isFirstEverReply = lastStaffLines.length === 0;

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
      ? `\n【⏰ 初回対応ルール・最優先】これはお客様への【はじめての返信】。必ず「〇〇さん、はじめまして😊！！この度ご連絡頂きありがとうございます！！お部屋探しを担当させて頂きます鈴木と申します！！」の形式で始める。「お世話になっております」「夜分遅くに失礼致します」は絶対禁止。`
      : `\n【⏰ 挨拶ルール・最優先】現在${jstHour}時台（JST）。今回の冒頭は「〇〇さんお世話になっております！！」を使う。「夜分遅くに失礼致します」は返信時には絶対禁止（スタッフから先に連絡するときのみ使う言葉）。`;

  const managementNote = isWeekend
    ? `\n【管理会社の状況・必ず守ること】本日は土日。物件の募集状況確認（空室確認）は土日でも可能なので「確認させていただきます！確認出来次第ご連絡させていただきます！！」と伝えてよい。ただし交渉（フリーレント・値引き・条件変更・審査再挑戦など）は土日不可。交渉が必要な場合は「月曜日一番で管理会社に交渉させていただきます！！」と伝える。`
    : jstHour >= 18
      ? `\n【管理会社の状況・必ず守ること】現在${jstHour}時台（JST）。18時以降のため管理会社の営業時間が終了している。確認が必要な場合は「本日は管理会社の営業時間が終了しておりますので、明日一番でご確認しご連絡させて頂きます！！」と伝える。当日中の回答を約束しない。`
      : `\n【管理会社の状況】現在${jstHour}時台（JST）。管理会社営業中（平日〜18時）。確認が必要な場合は「管理会社に確認させていただきます！！確認出来次第ご連絡させていただきます！！」と伝えてよい。`;

  const dateNote = `\n【📅 今日の日付（JST・必ず基準にすること）】${getJSTDateString()} — 「明日」「明後日」「今週」などの相対表現や具体的な日付（○日）は全てこの日付を起点に計算すること`;

  const nameNote = customerName ? `お客様名：${customerName}さん` : "お客様名：不明";
  const conditionsNote = customerConditions
    ? `\n【お客様の希望条件（DB登録済み・必ず考慮すること）】\n${customerConditions}`
    : "";
  const summaryNote = customerSummary
    ? `\n【このお客さんのAI要約 — 今の状況・次の必須対応を最優先で文案に反映すること。人物像・文体も合わせること】\n${customerSummary}`
    : "";

  // ① ai_summaryの「★決まるパターン」行を抽出して最優先注入
  const closingPatternFromSummary = (() => {
    if (!customerSummary) return "";
    const m = customerSummary.match(/★決まるパターン[：:]\s*(.+)/);
    return m ? m[1].trim() : "";
  })();

  // フェーズ別の行動指針を取得（DBオーバーライド優先）
  const phaseGuide = promptOverrides?.phaseGuide?.[state] ?? PHASE_GUIDE[state] ?? PHASE_GUIDE["first_reply"];


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
        const typeLabel: Record<string, string> = {
          area_change: "エリア変更",
          rent_change: "家賃変更",
          layout_change: "間取り変更",
          condition_relax: "条件緩和",
          pickup_request: "物件ピックアップ依頼",
          multi: "複数条件変更",
        };
        const label = typeLabel[p.condition_change_type as string] ?? (p.condition_change_type as string);
        conditionChangeNote = `\n【🔄 ${label}検出（最重要・絶対遵守）】追加条件を聞き返すことは絶対禁止。変更内容を具体的なエリア名・数字で言葉にして、即座に行動宣言する。「ピックアップします」「お送りします」で2〜3行で完結させること。`;
      }
    } catch { /* ignore */ }
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
          `・${m.slice(0, 120)}${m.length > 120 ? "…" : ""}`
        ).join("\n")
      }\n→ 特に費用・ルール・フロー説明は「一度伝えた」事実を必ず踏まえ、同じ内容を別の言い方でも繰り返さない。次のアクションに進むこと。`
    : "";

  const staffContextNote = isFollowUp && lastStaffMsg
    ? `\n【⚠️ 最重要：スモラは既にこのお客様メッセージに返信済み】\nスモラが直前に送った内容：「${lastStaffMsg}」\n→ お客様はまだ返信していない。これはその【続きのメッセージ】。前の返信で伝えた内容を絶対に繰り返さない。前の返信を踏まえて補足・追加・次のアクション提案など、自然につながる内容を生成すること。`
    : lastStaffMsg
      ? `\n【⚠️ スモラが直前に送った内容（必ず踏まえること）】「${lastStaffMsg}」\n→ この返信の後にお客様が上記メッセージを送った。会話の流れを引き継いで自然な続きを生成すること。`
      : "";

  // ⭐実例がある場合: より強い指示に変更
  const examplesInstruction = examples
    ? "\n\n【🔴 最重要】上記⭐実例が唯一の文体基準。実例の言い回し・感嘆符(！！)・絵文字・長さをそのまま再現すること。phrase_dictやパターン集より実例を最優先。"
    : "";

  // 実例がある場合はQUICK_PATTERNSを省略（実例を真の最優先にする・競合を排除）
  // 挨拶状態に応じて QUICK_PATTERNS の冒頭ルールを上書き（greetingNote との競合を解消）
  const baseQuickPatterns = promptOverrides?.quickPatterns ?? SMORA_QUICK_PATTERNS;
  const effectiveQuickPatterns = (() => {
    if (alreadyGreeted) {
      // 同日挨拶済み → 「長い返信はお世話になっております」を「挨拶なし」に置き換え
      return baseQuickPatterns.replace(
        /・冒頭ルール（★重要）:[\s\S]*?を使う/,
        "・冒頭ルール（★重要・本日挨拶済みのため上書き）: 返信の長短にかかわらず【冒頭挨拶は一切使わない】。「はい！！」「かしこまりました！！」または直接本文から始める。「お世話になっております」「ありがとうございます」「夜分遅くに」は絶対禁止"
      );
    }
    if (state === "first_reply" && isFirstEverReply) {
      // 真の初回 → 「お世話になっております」を「ご連絡頂きありがとうございます」に置き換え
      return baseQuickPatterns.replace(
        /・冒頭ルール（★重要）:[\s\S]*?を使う/,
        "・冒頭ルール（★重要・初回返信のため上書き）: 必ず「〇〇さんご連絡頂きありがとうございます😊！！お部屋探しを担当させて頂きます鈴木と申します！！」の形式で始める。「お世話になっております」は絶対禁止"
      );
    }
    // 本日初回メッセージ → 短い承認でも必ず「お世話になっております」で始める
    return baseQuickPatterns.replace(
      /・冒頭ルール（★重要）:[\s\S]*?を使う/,
      "・冒頭ルール（★重要・本日初回メッセージのため上書き）: 返信の長短・内容・承認・条件受け取りを問わず【必ず「〇〇さんお世話になっております！！」で始める】。「かしこまりました！！」「はい！！」単独での書き出しは絶対禁止。必ず先頭に挨拶を置くこと"
    );
  })();
  const quickPatterns = examples ? "" : `\n${effectiveQuickPatterns}`;
  const realEstateNote = `\n${promptOverrides?.realEstateRules ?? REAL_ESTATE_RULES}`;
  const replyContentNote = promptOverrides?.replyContentRules ? `\n${promptOverrides.replyContentRules}` : "";

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

  const replyHintNote = replyHint
    ? `\n\n【🔴✨ 指定生成モード（通常の生成ルールをすべて上書き）】
以下の指定内容のみに従い返信を生成すること。フェーズ別の行動パターン・物件送る・ピックアップ・長い説明は一切不要。
【長さ制限（絶対）】2〜3行に収めること。物件詳細・費用・比較・勧誘を書いてはいけない。
【文脈制限（絶対）】過去の会話にある家賃・号室・費用などの数値は今回のメッセージと直接関係ない限り一切使わない。
【本質】お客様のメッセージを一言で受け止め → 指定通りのアクションを宣言 → 完結させる（3ステップのみ）。
指定内容: ${replyHint}`
    : "";

  // ①②統合: closing_strategy（Step1分析）と★決まるパターン（ai_summary）を冒頭に最優先注入
  const closingNote = (() => {
    const parts: string[] = [];
    if (closingStrategyFromAnalysis) parts.push(`AIが判断した成約への一手: ${closingStrategyFromAnalysis}`);
    if (closingPatternFromSummary) parts.push(`この会話の成約ポイント: ${closingPatternFromSummary}`);
    if (parts.length === 0) return "";
    return `【🎯 最優先指示 — フェーズ別パターンより上位・この返信で必ず実行すること】\n${parts.join("\n")}\n`;
  })();

  const prompt = `
${closingNote}${nameNote}${conditionsNote}${summaryNote}${dateNote}${greetingNote}${managementNote}${repetitionNote}${currentPropertyNote}${repeatedConcernNote}${hesitancyNote}${questionsNote}${conditionChangeNote}
【現在の営業フェーズ】${state}
${phaseGuide}${approachNote}${staffContextNote}

【直近の会話履歴（スモラ自身の返信も含む）】
${history || "なし"}
${quickPatterns}
${realEstateNote}
${replyContentNote}
${knowledge}
${phrases}

${isFollowUp ? "【参考：お客様の直近メッセージ（既に返信済み）】" : "【お客様の最新メッセージ】"}
${customerMessage}${applicationFormNote}

${examples}${examplesInstruction}

↑${isFollowUp ? "スモラは既にこのメッセージに返信済み。前の返信内容を繰り返さず、続きとして自然につながるメッセージを1つ生成すること。" : "スモラの直前返信の流れを踏まえ、⭐実例の文体・言い回しを最優先で忠実に再現しながら、このメッセージへのスモラらしい返信を1つ生成してください。"}
長さの目安: 承認・了解→2行、条件確認・ヒアリング→3〜4行、物件紹介→フォーマット通り（制限なし）。絶対に担当者名（鈴木など）を入れない。${replyHintNote}`;

  return [new SystemMessage(promptOverrides?.generationSystem ?? GENERATION_SYSTEM), new HumanMessage(prompt)];
}

// ─── Intent分類（Haiku）──────────────────────────────────────────────────────
const ALLOWED_INTENTS = new Set([
  "condition_share", "consult_property_search", "estimate_request",
  "like_property", "dislike_property", "viewing_request", "application_interest",
  "search_more_properties", "conditions_complete", "conditions_incomplete",
  "property_available", "property_unavailable", "screening_passed", "screening_failed", "other",
]);

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

async function classifyIntent(message: string, state: string, history: string): Promise<string> {
  const system = `賃貸仲介LINE営業のintent分類器。以下のintent_keyのどれか1つをJSONで返す。
condition_share, consult_property_search, estimate_request, like_property, dislike_property,
viewing_request, application_interest, search_more_properties, conditions_complete,
conditions_incomplete, property_available, property_unavailable, screening_passed, screening_failed, other
必ず {"intent_key":"..."} のみ返すこと。`;

  try {
    const res = await analysisModel.invoke([
      new SystemMessage(system),
      new HumanMessage(`state: ${state}\n履歴:\n${history || "なし"}\nメッセージ: ${message}`),
    ]);
    const text = typeof res.content === "string" ? res.content : "";
    const match = text.match(/\{[\s\S]*?\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as { intent_key?: string };
      const intent = parsed.intent_key || "other";
      return ALLOWED_INTENTS.has(intent) ? intent : "other";
    }
    return "other";
  } catch {
    return "other";
  }
}

// ─── phrase_dictionary → conversationState マッピング（複数カテゴリ対応）────
const STATE_TO_PHRASE_CATEGORIES: Record<string, string[]> = {
  first_reply: ["hearing_start"],
  hearing:     ["hearing_followup", "condition_summary"],
  proposing:   ["property_recommendation", "urgency_push", "viewing_invite", "estimate_send", "availability_check"],
  applying:    ["application_push", "anxiety_relief", "estimate_start"],
  closed_won:  ["closing_support"],
};

async function fetchPhrases(state: string): Promise<string> {
  const categories = STATE_TO_PHRASE_CATEGORIES[state];
  if (!categories || categories.length === 0) return "";

  // 複数カテゴリをまとめて取得・priority 10以上のみ
  const { data } = await supabase
    .from("phrase_dictionary")
    .select("phrase, priority, category")
    .in("category", categories)
    .gte("priority", 10)
    .order("priority", { ascending: false })
    .limit(40);

  if (!data || data.length === 0) return "";

  // コード側で問題フレーズを除外：
  // - {{...}} テンプレート変数（未置換で残るため）
  // - 特定会社名ベタ書き（イエヤス・ギガ等）
  // - 不自然に長い（80字超）
  const BAD_PATTERNS = /\{\{|\}\}|イエヤスなら|ギガ賃貸なら|スモラでは契約内容/;
  const filtered = (data as Array<{ phrase: string; priority: number; category: string }>)
    .filter((r) => r.phrase && !BAD_PATTERNS.test(r.phrase) && r.phrase.length <= 80)
    .slice(0, 12);

  if (filtered.length === 0) return "";

  return "\n\n【スモラのフレーズ集（参考程度に・⭐実例を最優先すること）】\n" +
    filtered.map((r) => `「${r.phrase}」`).join("　");
}

// ─── ai_summaryがない場合の即席コンテキスト合成（Haiku・並列実行）────────────
async function synthesizeCustomerContext(conditions: string, customerName: string, history?: string): Promise<string> {
  try {
    const historyNote = history
      ? `\n直近の会話:\n${history.split("\n").slice(-10).join("\n")}`
      : "";
    const res = await analysisModel.invoke([
      new HumanMessage(`以下の賃貸希望条件と会話履歴から、お客様の状況を1〜2文で要約してください。
お客様名: ${customerName || "不明"}
条件:
${conditions}${historyNote}

例: 「梅田エリアで1LDK・家賃8万以内を探している。内覧済みで申込を検討中。審査に不安あり。」
要約のみ返答（説明不要）:`),
    ]);
    return typeof res.content === "string" ? res.content.trim() : "";
  } catch {
    return "";
  }
}

// ─── DB取得 ─────────────────────────────────────────────────────────────────
// 新5段階ステートと旧ステートの対応（両方で検索してデータ漏れを防ぐ）
const STATE_SEARCH_ALIASES: Record<string, string[]> = {
  first_reply: ["first_reply"],
  hearing:     ["hearing", "condition_hearing", "property_search"],
  proposing:   ["proposing", "property_recommendation", "viewing", "estimate_request", "availability_check", "property_send"],
  applying:    ["applying", "application", "screening", "contract", "application_push"],
  closed_won:  ["closed_won"],
};

type KnowledgeRow = { id: string; title: string; content: string; category: string; conversation_state: string; importance: number };

function incrementKnowledgeUsage(ids: string[]): void {
  if (!ids.length) return;
  // fire-and-forget: used_count を +1、last_used_at を更新
  supabase.rpc("increment_knowledge_used_count", { p_ids: ids }).then(() => {}, () => {});
}

async function fetchKnowledge(state: string, customerMessage?: string, analysisContext?: string): Promise<string> {
  const stateAliases = STATE_SEARCH_ALIASES[state] || [state];

  // pgvector検索（customerMessageがある場合・OPENAI_API_KEYが設定済みの場合）
  if (customerMessage && process.env.OPENAI_API_KEY) {
    const searchQuery = analysisContext
      ? `${state}: ${customerMessage} ${analysisContext}`.slice(0, 2000)
      : `${state}: ${customerMessage}`.slice(0, 2000);

    const embedding = await getEmbedding(searchQuery);
    if (embedding) {
      const { data: vectorResults } = await supabase.rpc("match_reply_knowledge", {
        query_embedding: embedding,
        match_count: 40,
        min_importance: 7,
      }) as { data: Array<KnowledgeRow & { similarity: number }> | null };

      if (vectorResults && vectorResults.length > 0) {
        const diffLearned = vectorResults.filter(r => r.title.includes("差分学習")).slice(0, 20);
        const correctionPairs = vectorResults.filter(r => r.title.includes("修正対比")).slice(0, 8);
        const critical = vectorResults.filter(r => r.importance >= 9 && r.category === "principle").slice(0, 15);
        const patterns = vectorResults.filter(r => r.category === "pattern" && !r.title.includes("差分学習") && !r.title.includes("修正対比")).slice(0, 8);
        const phrases = vectorResults.filter(r => r.category === "phrase").slice(0, 6);

        const used = [...diffLearned, ...correctionPairs, ...critical, ...patterns, ...phrases];
        incrementKnowledgeUsage(used.map(r => r.id).filter(Boolean));

        const sections: string[] = [];
        if (diffLearned.length > 0) {
          sections.push("【🔴 AIが過去に間違えたパターン（最優先・必ず守る）】\n" + diffLearned.map(k => `・${k.content}`).join("\n"));
        }
        if (correctionPairs.length > 0) {
          sections.push("【🟠 スタッフが修正したポイント（このフェーズ専用）】\n" + correctionPairs.map(k => `・${k.content}`).join("\n"));
        }
        if (critical.length > 0) {
          sections.push("【⚠️ 絶対ルール】\n" + critical.map(k => `・${k.content}`).join("\n"));
        }
        if (patterns.length > 0) {
          sections.push("【スモラの営業パターン・原則】\n" + patterns.map(k => `・${k.content}`).join("\n"));
        }
        if (phrases.length > 0) {
          sections.push("【スモラのフレーズ】\n" + phrases.map(k => `「${k.content}」`).join("　"));
        }
        return sections.length > 0 ? "\n\n" + sections.join("\n\n") : "";
      }
    }
  }

  // フォールバック: importance順検索（OPENAI_API_KEY未設定時 or embedding取得失敗時）
  const [{ data: stateDiff }, { data: globalDiff }, { data: correctionPairs }, { data: global }, { data: stateSpecific }] = await Promise.all([
    supabase.from("ai_reply_knowledge").select("id, category, title, content, importance")
      .ilike("title", "%差分学習%").gte("importance", 7)
      .in("conversation_state", stateAliases)
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false }).limit(15),
    supabase.from("ai_reply_knowledge").select("id, category, title, content, importance")
      .ilike("title", "%差分学習%").gte("importance", 7)
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false }).limit(10),
    supabase.from("ai_reply_knowledge").select("id, category, title, content, importance")
      .ilike("title", "%修正対比%").in("conversation_state", stateAliases)
      .order("importance", { ascending: false }).limit(20),
    supabase.from("ai_reply_knowledge").select("id, category, title, content, importance")
      .gte("importance", 8)
      .not("title", "ilike", "%差分学習%").not("title", "ilike", "%修正対比%")
      .not("category", "eq", "principle")
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false }).limit(20),
    supabase.from("ai_reply_knowledge").select("id, category, title, content, importance")
      .in("conversation_state", stateAliases).gte("importance", 7)
      .not("title", "ilike", "%差分学習%").not("title", "ilike", "%修正対比%")
      .not("category", "eq", "principle")
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false }).limit(24),
  ]);

  const stateDiffList = stateDiff || [];
  const globalDiffDeduped = (globalDiff || []).filter(g => !stateDiffList.some(s => s.content === g.content));
  const diffLearned = [...stateDiffList, ...globalDiffDeduped].slice(0, 20);

  const stateSpecificList = stateSpecific || [];
  const globalList = (global || []).filter(g => !stateSpecificList.some(s => s.content === g.content));
  const all = [...stateSpecificList, ...globalList];
  if (diffLearned.length === 0 && (correctionPairs?.length ?? 0) === 0 && all.length === 0) return "";

  const critical = all.filter(k => (k.importance || 0) >= 9 && k.category === "principle");
  const patterns = all.filter(k => (k.importance || 0) >= 7 && k.category === "pattern");
  const phrases  = all.filter(k => k.category === "phrase");

  // 使用追跡（fire-and-forget）
  const usedIds = [
    ...diffLearned,
    ...(correctionPairs?.slice(0, 8) ?? []),
    ...critical.slice(0, 15),
    ...patterns.slice(0, 8),
    ...phrases.slice(0, 6),
  ].map(k => (k as KnowledgeRow).id).filter(Boolean);
  incrementKnowledgeUsage(usedIds);

  const sections: string[] = [];
  if (diffLearned.length > 0) {
    sections.push("【🔴 AIが過去に間違えたパターン（最優先・必ず守る）】\n" + diffLearned.map(k => `・${k.content}`).join("\n"));
  }
  if ((correctionPairs?.length ?? 0) > 0) {
    sections.push("【🟠 スタッフが修正したポイント（このフェーズ専用）】\n" + correctionPairs!.slice(0, 8).map(k => `・${k.content}`).join("\n"));
  }
  if (critical.length > 0) {
    sections.push("【⚠️ 絶対ルール】\n" + critical.slice(0, 15).map(k => `・${k.content}`).join("\n"));
  }
  if (patterns.length > 0) {
    sections.push("【スモラの営業パターン・原則】\n" + patterns.slice(0, 8).map(k => `・${k.content}`).join("\n"));
  }
  if (phrases.length > 0) {
    sections.push("【スモラのフレーズ】\n" + phrases.slice(0, 6).map(k => `「${k.content}」`).join("　"));
  }
  return sections.length > 0 ? "\n\n" + sections.join("\n\n") : "";
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
      body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 2000) }),
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (!res.ok) return null;
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0]?.embedding ?? null;
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
    ? `${state}: [前返信]${lastStaffMessage.slice(0, 100)} [顧客]${customerMessage}`
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

        return "\n\n【⭐ スモラの実際の返信例（状況が最も類似した実例・類似度順）— 文体・言い回し・感嘆符・絵文字・長さをこの例から忠実に再現すること。これが最優先の文体基準。ラベル: 王道=標準スモラスタイル / シンプル=短く簡潔 / C案=別角度アプローチ】\n" +
          sorted.map((ex, i) => {
            const angleTag = ex.reply_angle && ex.reply_angle !== "starred" ? `|${ANGLE_LABEL[ex.reply_angle] ?? ex.reply_angle}` : "";
            return `[例${i + 1}${ex.is_starred ? "⭐" : ""}${angleTag}]\nお客様: 「${ex.customer_message}」\nスモラ: 「${ex.sent_reply}」`;
          }).join("\n\n");
        }
      }
    }
  }

  // フォールバック: 全件対象（☆優先・フェーズ一致優先）
  const [{ data: sameStateFull }, { data: allStateFull }] = await Promise.all([
    // 同フェーズ全件: ☆降順 → 新着順
    supabase.from("ai_reply_examples").select("customer_message, sent_reply, conversation_state, is_starred, reply_angle")
      .in("conversation_state", stateAliases)
      .not("embedding", "is", null)
      .order("is_starred", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(60),
    // 全フェーズ全件: ☆降順 → 新着順
    supabase.from("ai_reply_examples").select("customer_message, sent_reply, conversation_state, is_starred, reply_angle")
      .not("embedding", "is", null)
      .order("is_starred", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(120),
  ]);

  const sameStateList = sameStateFull || [];
  const allStateList = (allStateFull || []).filter(
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

  return "\n\n【⭐ スモラの実際の返信例（☆をつけた良質な実例）— 文体・言い回し・感嘆符・絵文字・長さをこの例から忠実に再現すること。これが最優先の文体基準。ラベル: 王道=標準スモラスタイル / シンプル=短く簡潔 / C案=別角度アプローチ】\n" +
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
  // 名前ではなくスキップすべき語句
  const SKIP_RE = /^(お客様|皆|全|各|担当|スタッフ|こちら|弊社|管理|オーナー|業者|まずは|引き続き|何卒|改めて)/;
  for (const msg of [...messages].reverse()) {
    if (msg.sender !== "staff" || !msg.text) continue;
    const matches = [...msg.text.matchAll(/([^\s、。！？\n【】「」（）・]{2,8}?)さん/g)];
    for (const m of [...matches].reverse()) {
      const name = m[1];
      if (SKIP_RE.test(name)) continue;
      // LINE表示名より長い（より詳細な）名前が見つかれば採用
      return name;
    }
  }
  return lineDisplayName;
}

// ─── POST ────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  }

  type RecentMessage = { sender: string; text: string; imageUrl?: string; createdAt?: string };
  let message: string, state: string, customerName: string, recentMessages: RecentMessage[], customerConditions: string, customerSummary: string, replyHint: string;
  let screenshotBase64: string | undefined, screenshotMediaType: string | undefined;
  try {
    const body = await req.json() as {
      message: string;
      state: string;
      customerName?: string;
      recentMessages?: RecentMessage[];
      customerConditions?: string;
      customerSummary?: string;
      replyHint?: string;
      screenshotBase64?: string;
      screenshotMediaType?: string;
    };
    message = body.message;
    state = body.state;
    customerName = body.customerName || "";
    recentMessages = body.recentMessages || [];
    // LINE表示名より会話でスタッフが実際に使った呼び名を優先
    customerName = extractPreferredName(recentMessages, customerName);
    customerConditions = body.customerConditions || "";
    customerSummary = body.customerSummary || "";
    replyHint = body.replyHint || "";
    screenshotBase64 = body.screenshotBase64;
    screenshotMediaType = body.screenshotMediaType;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  // スクショがある場合: Sonnet Vision でトーク内容を抽出して replyHint に注入
  if (screenshotBase64) {
    try {
      const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").replace(/\s/g, "");
      const visionRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 800,
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
        const visionData = await visionRes.json() as { content?: Array<{ text: string }> };
        const extracted = visionData.content?.[0]?.text?.trim() ?? "";
        if (extracted && !extracted.includes("読み取れませんでした")) {
          replyHint = [
            `【📱 スクショから読み取ったトーク内容（最優先の文脈として参照すること）】\n${extracted}`,
            replyHint,
          ].filter(Boolean).join(" / ");
        }
      }
    } catch { /* スクショ読み取り失敗時は無視して通常生成 */ }
  }

  if (!message) return NextResponse.json({ ok: false, error: "message required" }, { status: 400 });

  // DBカスタムプロンプトを取得（失敗時はハードコード値にフォールバック）
  let promptOverrides: PromptOverrides | undefined;
  try {
    const { data: dbPrompts } = await supabase.from("ai_prompts").select("key, content");
    if (dbPrompts && dbPrompts.length > 0) {
      const phaseGuide: Record<string, string> = {};
      let generationSystem: string | undefined;
      let quickPatterns: string | undefined;
      let realEstateRules: string | undefined;
      let replyContentRules: string | undefined;
      for (const p of dbPrompts as { key: string; content: string }[]) {
        if (p.key === "generation_system") generationSystem = p.content;
        else if (p.key === "smora_quick_patterns") quickPatterns = p.content;
        else if (p.key === "real_estate_rules") realEstateRules = p.content;
        else if (p.key === "reply_content_rules") replyContentRules = p.content;
        else if (p.key.startsWith("phase_guide_")) phaseGuide[p.key.slice("phase_guide_".length)] = p.content;
      }
      if (generationSystem || quickPatterns || realEstateRules || replyContentRules || Object.keys(phaseGuide).length > 0) {
        promptOverrides = {
          generationSystem,
          quickPatterns,
          realEstateRules,
          replyContentRules,
          phaseGuide: Object.keys(phaseGuide).length > 0 ? phaseGuide : undefined,
        };
      }
    }
  } catch { /* use hardcoded fallback */ }

  try {
    const currentState = normalizeState(state || "first_reply");

    // 画像送付を会話履歴に反映（[画像]をフィルタせず意味のあるラベルに変換）
    const history = recentMessages
      .slice(-25)
      .map((m, i, arr) => {
        const who = m.sender === "customer" ? "お客様" : "スモラ";
        const isImageMsg = m.text === "[画像]" || m.text === "[動画]" || (!m.text && !!m.imageUrl);

        if (isImageMsg) {
          if (m.sender === "customer") return `${who}: 【画像を送ってきた】`;
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
        if (p.approach && typeof p.approach === "string") parts.push(p.approach.slice(0, 60));
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
    const [detectedIntent, knowledge, examples, phrases, autoSummary] = await Promise.all([
      classifyIntent(message, currentState, history),
      fetchKnowledge(currentState, message, analysisContext),
      fetchExamples(currentState, message, isFollowUp ? lastStaffMsgForSearch : undefined, analysisContext),
      fetchPhrases(currentState),
      // ai_summaryがない場合のみ条件テキスト+履歴から即席合成（Haiku・並列なので遅延ゼロ）
      !customerSummary && customerConditions
        ? synthesizeCustomerContext(customerConditions, customerName, history)
        : Promise.resolve(""),
    ]);
    const resolvedSummary = customerSummary || autoSummary;

    // JST 9時リセット基準で今日の挨拶済み判定
    // createdAt が含まれるメッセージだけを使用（タイムスタンプなしはフォールバックへ）
    const greetingStart = getGreetingSessionStart();
    const hasTimestamps = recentMessages.some(m => !!m.createdAt);
    const alreadyGreetedToday = hasTimestamps
      ? recentMessages.some(m =>
          m.sender === "staff" &&
          m.createdAt &&
          new Date(m.createdAt) >= greetingStart &&
          m.text && m.text !== "[画像]" && m.text !== "[動画]" &&
          (
            m.text.includes("お世話になっております") ||
            m.text.includes("夜分遅くに失礼") ||
            m.text.includes("はじめまして") ||
            m.text.includes("ご連絡頂きありがとうございます") ||
            /^[^\s]{1,10}さん/.test(m.text)
          )
        )
      : undefined;

    // Sonnetでストリーミング生成
    const messages = buildGenerationMessages(
      message, customerName, history, currentState,
      analysis, knowledge, examples, phrases, customerConditions, resolvedSummary,
      promptOverrides, isFollowUp, replyHint, alreadyGreetedToday
    );
    const genStream = generationModel.stream(messages);

    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        async start(controller) {
          // 1行目: メタデータJSON（フロントエンドがok確認に使用）
          controller.enqueue(encoder.encode(
            JSON.stringify({ ok: true, detected_intent: detectedIntent }) + "\n"
          ));
          try {
            for await (const chunk of await genStream) {
              const text = typeof chunk.content === "string" ? chunk.content : "";
              if (text) controller.enqueue(encoder.encode(text));
            }
          } catch (streamErr) {
            console.error("generate-reply stream error:", streamErr);
          }
          controller.close();
        },
      }),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "返信生成エラー";
    console.error("generate-reply error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
