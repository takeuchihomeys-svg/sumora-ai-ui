import { NextRequest, NextResponse } from "next/server";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { supabase } from "@/app/lib/supabase";

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
  temperature: 0.7,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
});

// ─── スタイルルール（共通） ──────────────────────────────────────────────────
const EMOJI_RULE = `絵文字: 😊 😌 🌟 ✨ の4つのみ・1〜2個まで・文末か区切りのみ`.trim();

const STYLE_RULE = `感嘆符「！」または「！！」を文脈で使い分け / 「〇〇さん」で呼ぶ / 物件紹介以外は箇条書き禁止 / 1つの返信案のみ`.trim();

// ─── Step1: お客様状況の深層分析（Haiku）───────────────────────────────────
const ANALYSIS_SYSTEM = `あなたは賃貸仲介の営業コーチです。
LINEのやりとりから、お客様の状況・感情・本当のニーズを深く分析してください。
JSONのみで返答（説明不要）。`;

async function analyzeCustomerSituation(
  customerMessage: string,
  history: string,
  state: string,
  customerName: string
): Promise<string> {
  const prompt = `
【営業フェーズ】${state}
【お客様名】${customerName || "不明"}
【直近の会話履歴】
${history || "なし"}
【最新メッセージ】
${customerMessage}

以下をJSONで分析してください：
{
  "emotion": "お客様の感情状態（例：期待と不安が混在、前向き、迷っているなど）",
  "real_need": "表面の質問の奥にある本当のニーズ・懸念（例：費用が心配で踏み出せない、家族に相談したいなど）",
  "key_insight": "優秀な営業スタッフが気づくべき重要なポイント（例：価格比較をしている、決断を急かされたくないなど）",
  "approach": "このメッセージへの最適な返し方の方針（例：まず共感→動画を送ると約束→内覧への自然な誘導など）",
  "tone": "適切なトーン（例：温かく・余裕を持って・軽く背中を押す）"
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

// ─── フェーズ別行動指針 ──────────────────────────────────────────────────────
const PHASE_GUIDE: Record<string, string> = {
  first_reply: `▶ 今すべきこと: 挨拶 + 条件ヒアリング開始
初回例: 「〇〇さん初めまして😊！！この度ご連絡頂きありがとうございます！！〇〇さんがご満足頂くお部屋が見つかるまでお部屋探し全力でサポートさせて頂きます！！」
2回目以降: 「〇〇さん、お世話になっております😊！！」で始める
※ 担当者名（鈴木など固有名詞）は絶対に文案に入れない
※ 条件フォームを送る場合: ①入居時期 ②家賃 ③間取り ④築年数 ⑤エリア・駅 ⑥駅徒歩 ⑦初期費用 ⑧その他 の形式で送る`,
  hearing: `▶ 会話の状況を判断して以下の3パターンのどれかで対応する。

【パターンA】条件がまだ届いていない・「探してます」だけの段階
→ 挨拶 + 条件フォームを送る（①入居時期 ②家賃 ③間取り ④築年数 ⑤エリア・駅 ⑥駅徒歩 ⑦初期費用 ⑧その他 の形式）
例: 「〇〇さんお世話になっております！！お部屋探しのお手伝いさせて頂きます😊！！まずはご希望の条件を教えていただけますでしょうか！①入居時期 ②ご希望家賃 ③間取り...」

【パターンB】条件の一部しか届いていない・追加で確認が必要な段階
→ 受け取りに感謝 + 足りない条件を「1点だけ」確認する（複数聞かない）
例: 「〇〇さんありがとうございます！！ご希望エリアも教えていただけますでしょうか😊！！」

【パターンC】条件が十分に揃った・ピックアップできる段階
→ 感謝 + 本日中にピックアップ宣言。即アクションを示す
例: 「〇〇さんありがとうございます！！ご希望条件よりオススメ出来る物件ピックアップし本日中にお送りさせて頂きます😊！！」

※ 初回連絡なら「初めまして」、2回目以降は「お世話になっております」
※ 絶対に複数の質問を一度にしない（1点だけ）`,
  proposing: `▶ 会話の状況を判断して以下のパターンで対応する。

【パターンA】スタッフが既に物件画像・資料を送付済みの場合（履歴に「【物件資料を送付した】」「【物件資料・画像を送付した】」がある）
→ 画像をもう一度送ったり、物件情報を文章で紹介し直したりしない
→ お客様の反応・感想を受けて内覧/申込へ自然に誘導する
→ 「空室確認して画像を送った」流れなら「ご確認いただけましたでしょうか😊！！お気に召されましたらお申込みでお部屋を抑えさせて頂きます！！」などで締める

【パターンB】これから物件を紹介する場合（まだ画像を送っていない）
→ 物件紹介フォーマットで詳しく紹介：
🌟[物件名] [部屋番号]
・[間取り]（[㎡]）
・[築年]築
・管理費込み[金額]円
・[最寄り駅] 徒歩[分]分
・[特記事項]
[物件の魅力を数字で2〜3文]
[退去予定・申込促し・内覧案内で締める]

※ 退去予定物件は「〜退去予定のため、お気に召されましたらお申込みしてお部屋抑えさせていただきます😌！」と添える
※ 履歴を必ず確認してパターンAかBか正しく判断すること`,
  applying: `▶ 今すべきこと: 内覧調整または申込手続き案内。具体的に・安心感を与えながら前進させる。
内覧日程提示例:
「かしこまりました😊！
3/20 11:00~17:00
3/21 11:00,15:00
上記お日にちにてご内覧可能ですが、〇〇さんご都合いかがでしょうか😌！」
内覧確定・住所案内例:
「かしこまりました😊！
3/20 11:00
[物件名]
[住所]
現地にてお待ち合わせでお願い致します😌！」
申込促し: 「ご内覧日先になりますので、お申込みでお部屋抑えておいた方が確実ですがいかがでしょうか！」
申込完了: 「[物件名]のお申し込み完了しております😊！！明日1番手でお申し込み完了しているかの確認させていただきます！！」`,
  closed_won: `▶ 今すべきこと: 入居準備のサポート。感謝と次のステップを伝える。
例: 「〇〇さん、この度はありがとうございます😊！入居準備につきましても何かございましたらお気軽にご連絡ください😌！」`,
};

// ─── Step2: LINE返信生成（Sonnet）──────────────────────────────────────────
const GENERATION_SYSTEM = `あなたはスモラ（賃貸仲介）のLINE営業担当です。
お客様へのLINE返信を1つだけ生成してください。

【最優先ルール — 必ず守ること】
1. 長さは状況に応じて調整する
   ・挨拶・承認・アクション宣言 → 2〜3行で簡潔に
   ・条件ヒアリング・フェーズ確認 → 3〜5行
   ・物件紹介 → フォーマット通りに詳しく（10行以上も可）
2. ${EMOJI_RULE}
   ・✅ は物件の強調ポイント・確認済み事項に使用可（例: 「敷金礼金なし✅」「4月入居可能✅」）
3. ${STYLE_RULE}
4. お客様が言ったことは繰り返さない → 次のアクションへ直行
5. スモラが前回言ったことは繰り返さない → 一貫性を保ちながら前進
6. 「させて頂きます」「頂きます」を自然に多用する（スモラの文体の核心）

【禁止ワード・パターン】
× 「承りました」「ご確認のほど」「確認中です」
× 「〇〇とのことですね」「〇〇をご希望ですね」（オウム返し）
× 「まず〜、次に〜」（列挙構成）
× 築浅・広い・駅近（曖昧表現）→ 2024年築・32㎡・本町駅徒歩5分（数字で）
× お客様名が「不明」の場合は名前を絶対に推測・創作しない → 名前なしで返信する
× 担当者名（鈴木・山田など固有の人名）を文案に絶対に入れない → スタッフが自分で入れる
× 「お手隙の際にご査収ください」は使わない

【会話履歴の読み方】
「スモラ:」= 自分の過去の返信 / 「お客様:」= お客様のメッセージ
【画像】スモラが物件資料・見積書を送付した場合はその旨が記録されている`;

// ─── フェーズ別スモラ返信パターン（buildGenerationMessages で注入）─────────
const SMORA_QUICK_PATTERNS = `
【スモラの実際の返信パターン（実例から抽出）】
・冒頭（2回目以降）: 「〇〇さんお世話になっております！！」または「〇〇さんお待たせいたしました！！」（必ずこれで始める）
・冒頭（初回）: 「〇〇さん初めまして😊！！この度ご連絡頂きありがとうございます！！」
・承認・了解: 「かしこまりました！」または「かしこまりました😊！」で即アクション宣言（余計な説明しない）
・条件受け取り: 「〇〇さんお世話になっております！！頂きましたご条件よりオススメできる物件ピックアップし、本日中にお送りさせて頂きます😊！」
・条件追加: 「ご条件追加頂きありがとうございます😊！そちらのエリアも含めて本日中にはご提案させて頂きます！引き続きよろしくお願いいたします😌！」
・見積り依頼受付: 「かしこまりました！\nお見積り作成させて頂きます！少々お待ちください！」（「少々お待ちください」は今すぐ動く場合にのみ使う）
・物件紹介の締め: 「お気に召されましたら、お申込みしてお部屋抑えさせていただきます😌！」
・アクション約束: 「本日中に〜させて頂きますので、引き続きよろしくお願いいたします😌！」
・要望不明時: 「〇〇さん、ご確認頂きありがとうございます😊！お部屋探しにあたるご要望更にお伝え頂けましたら、お探しさせて頂く材料として参考にさせて頂きます！」
・入居条件交渉: 「工事の進捗次第かとは思いますが、現時点での明言は避けさせて頂きます！ただお申し込み後に、工事進捗次第で早めに入居させてもらうよう交渉する事は可能でございます😌！」
・内覧日程提示: 「かしこまりました😊！\n[日付] [時間帯]\n[日付] [時間]\n上記お日にちにてご内覧可能ですが、〇〇さんご都合いかがでしょうか😌！」
・内覧確定・住所案内: 「かしこまりました😊！\n[日付] [時間]\n[物件名]\n[住所]\n現地にてお待ち合わせでお願い致します😌！」
・内覧前申込促し: 「ご内覧日先になりますので、お申込みでお部屋抑えておいた方が確実ですがいかがでしょうか！」
・2番手申込対応: 「ご確認させて頂きましたが、別で1件お申込み入っておりましたので2番手でのお申込み受付となります😌！」
・申込完了通知: 「[物件名]のお申し込み完了しております😊！！本日管理会社お休みでしたので明日1番手でお申し込み完了しているかの確認させていただきます！！」
・在庫なし正直回答: 「現状ですとご紹介させて頂いた物件で全てとなりますので、新着情報継続してご確認させて頂き、良い物件出ましたら随時ご案内させて頂きます✅！」
・他社が優位な場合: 「他社様でご契約いただくのが間違いなく最善かと存じます！」（誠実さを見せる）
・謝罪への返し（軽め）: 「全然です😊！！としきさんがご満足頂くお部屋でお引越し頂くのが1番ですので、ご要望や気になるお部屋等出てきましたらいつでもお気軽にご連絡ください！！」
・謝罪への返し（丁寧）: 「いえいえ、とんでもございません！こちらこそ何卒よろしくお願い申し上げます！」
・複数物件一覧フォーマット: 「✅[物件名]：[駅名] 徒歩[分]分、[目的地]まで自転車で[分]分」（1件1行で比較しやすく）
・迷っている時の判断軸提示: 「ご条件似ているお部屋が多いとは存じますので、初期費用を軸にこの3件の中からお選びになられるのはいかがでしょうか😌！」
・通勤ストレス共感: 「私も[路線名]で通勤していたことがありますが、あれだけでかなり疲弊してしまうくらい混雑していますよね…」（個人体験で共感を示す）
・繁忙期緊急性: 「ただ今繁忙期の為お部屋すぐ埋まってしまいます！お気に召されましたらお早めにお申込みいただくがオススメです😌！」
・退去前物件の内覧案内: 「[日付]退去予定の為ご内覧は[日付]以降可能となります！！お気に召されましたら、お申込しお部屋を抑えてからご内覧頂く事も可能です😊！！」
・電話アポ提案: 「ただ今2〜3分ほどお電話のお時間よろしいでしょうか😌！」
・電話時間確定: 「かしこまりました！それでは[時間]頃に改めてこちらからご連絡させて頂きます😌！」
・駐車場サイズ確認: 「駐車場のサイズの問題がございますので、事前にお車の車種をお伺いしてもよろしいでしょうか😌！」`.trim();

function buildGenerationMessages(
  customerMessage: string,
  customerName: string,
  history: string,
  state: string,
  analysis: string,
  knowledge: string,
  examples: string,
  phrases: string
): [SystemMessage, HumanMessage] {
  const nameNote = customerName ? `お客様名：${customerName}さん` : "お客様名：不明";

  // フェーズ別の行動指針を取得
  const phaseGuide = PHASE_GUIDE[state] || PHASE_GUIDE["first_reply"];

  // ⭐実例がある場合の強調指示
  const examplesHeader = examples
    ? "\n\n【最優先】上記の⭐実例の文体・長さ・感嘆符(！！)・絵文字の使い方をそのまま再現すること。"
    : "";

  // 分析結果から方針のみ抽出
  let approachNote = "";
  if (analysis) {
    try {
      const p = JSON.parse(analysis) as Record<string, string>;
      if (p.approach) approachNote = `\n【今回の返し方】${p.approach}（トーン: ${p.tone || "自然に"}）`;
    } catch { /* ignore */ }
  }

  // スモラの直前返信を履歴から抽出（文脈の引き継ぎに使用）
  const historyLines = (history || "").split("\n").filter(Boolean);
  const lastStaffLines = historyLines.filter((l) => l.startsWith("スモラ:"));
  const lastStaffMsg = lastStaffLines.length > 0 ? lastStaffLines[lastStaffLines.length - 1].replace(/^スモラ:\s*/, "") : null;
  const staffContextNote = lastStaffMsg
    ? `\n【⚠️ スモラが直前に送った内容（必ず踏まえること）】「${lastStaffMsg}」\n→ この返信の後にお客様が上記メッセージを送った。会話の流れを引き継いで自然な続きを生成すること。`
    : "";

  // ⭐実例がある場合: より強い指示に変更
  const examplesInstruction = examples
    ? "\n\n【🔴 最重要】上記⭐実例が唯一の文体基準。実例の言い回し・感嘆符(！！)・絵文字・長さをそのまま再現すること。phrase_dictやパターン集より実例を最優先。"
    : "";

  const prompt = `
${nameNote}
【現在の営業フェーズ】${state}
${phaseGuide}${approachNote}${staffContextNote}

【直近の会話履歴（スモラ自身の返信も含む）】
${history || "なし"}
${SMORA_QUICK_PATTERNS}
${knowledge}
${phrases}

【お客様の最新メッセージ】
${customerMessage}

${examples}${examplesInstruction}

↑スモラの直前返信の流れを踏まえ、⭐実例の文体・言い回しを最優先で忠実に再現しながら、このメッセージへのスモラらしい返信を1つ生成してください。
長さの目安: 承認・了解→2行、条件確認・ヒアリング→3〜4行、物件紹介→フォーマット通り（制限なし）。絶対に担当者名（鈴木など）を入れない。`;

  return [new SystemMessage(GENERATION_SYSTEM), new HumanMessage(prompt)];
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

// ─── DB取得 ─────────────────────────────────────────────────────────────────
// 新5段階ステートと旧ステートの対応（両方で検索してデータ漏れを防ぐ）
const STATE_SEARCH_ALIASES: Record<string, string[]> = {
  first_reply: ["first_reply"],
  hearing:     ["hearing", "condition_hearing", "property_search"],
  proposing:   ["proposing", "property_recommendation", "viewing", "estimate_request", "availability_check"],
  applying:    ["applying", "application", "screening", "contract"],
  closed_won:  ["closed_won"],
};

async function fetchKnowledge(state: string): Promise<string> {
  const stateAliases = STATE_SEARCH_ALIASES[state] || [state];

  const [{ data: global }, { data: stateSpecific }] = await Promise.all([
    // 全体共通ナレッジ: importance8以上を優先（golden知識231件を活用）
    supabase.from("ai_reply_knowledge").select("category, title, content, importance")
      .is("conversation_state", null).gte("importance", 7)
      .order("importance", { ascending: false }).limit(12),
    // state別ナレッジ: importance7以上を優先
    supabase.from("ai_reply_knowledge").select("category, title, content, importance")
      .in("conversation_state", stateAliases).gte("importance", 7)
      .order("importance", { ascending: false }).limit(15),
  ]);

  const all = [...(stateSpecific || []), ...(global || [])];
  if (all.length === 0) return "";

  // importance 9以上は「絶対ルール」として最優先（差分学習由来の高品質ルール）
  const critical = all.filter((k) => (k.importance || 0) >= 9);
  const patterns = all.filter((k) => (k.importance || 0) >= 7 && (k.importance || 0) < 9 && (k.category === "pattern" || k.category === "principle"));
  const phrases  = all.filter((k) => k.category === "phrase");

  const sections: string[] = [];
  if (critical.length > 0) {
    sections.push("【⚠️ 絶対ルール（必ず守る）】\n" + critical.slice(0, 8).map((k) => `・${k.content}`).join("\n"));
  }
  if (patterns.length > 0) {
    sections.push("【スモラの営業パターン・原則】\n" + patterns.slice(0, 7).map((k) => `・${k.content}`).join("\n"));
  }
  if (phrases.length > 0) {
    sections.push("【スモラのフレーズ】\n" + phrases.slice(0, 7).map((k) => `「${k.content}」`).join("　"));
  }
  return sections.length > 0 ? "\n\n" + sections.join("\n\n") : "";
}

async function fetchExamples(state: string): Promise<string> {
  const stateAliases = STATE_SEARCH_ALIASES[state] || [state];

  const [{ data: starredSameState }, { data: starredAllState }] = await Promise.all([
    // ⭐ 同フェーズの☆つき（最新30件）
    supabase.from("ai_reply_examples").select("customer_message, sent_reply, conversation_state")
      .in("conversation_state", stateAliases).eq("is_starred", true)
      .order("created_at", { ascending: false }).limit(30),
    // ⭐ 全フェーズの☆つき（言葉遣い・文体を全体から学習）
    supabase.from("ai_reply_examples").select("customer_message, sent_reply, conversation_state")
      .eq("is_starred", true)
      .order("created_at", { ascending: false }).limit(50),
  ]);

  const sameStateList = starredSameState || [];
  const allStateList  = (starredAllState || []).filter(
    (ex) => !sameStateList.some((s) => s.sent_reply === ex.sent_reply)
  );

  // 同フェーズ☆ → 全フェーズ☆の優先順で最大25件（非☆は使わない）
  const all = [
    ...sameStateList.map((ex) => ({ ...ex, priority: 1 })),
    ...allStateList.slice(0, 10).map((ex) => ({ ...ex, priority: 2 })),
  ].sort((a, b) => a.priority - b.priority).slice(0, 25);

  if (all.length === 0) return "";

  return "\n\n【⭐ スモラの実際の返信例（☆をつけた良質な実例）— 文体・言い回し・感嘆符・絵文字・長さをこの例から忠実に再現すること。これが最優先の文体基準】\n" +
    all.map((ex, i) =>
      `[例${i + 1}]\nお客様: 「${ex.customer_message}」\nスモラ: 「${ex.sent_reply}」`
    ).join("\n\n");
}

// ─── POST ────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  }

  type RecentMessage = { sender: string; text: string; imageUrl?: string };
  let message: string, state: string, customerName: string, recentMessages: RecentMessage[];
  try {
    const body = await req.json() as {
      message: string;
      state: string;
      customerName?: string;
      recentMessages?: RecentMessage[];
    };
    message = body.message;
    state = body.state;
    customerName = body.customerName || "";
    recentMessages = body.recentMessages || [];
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  if (!message) return NextResponse.json({ ok: false, error: "message required" }, { status: 400 });

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
          // スタッフの画像: 前後3件のテキストで文脈を判定
          const nearbyMsgs = arr.slice(Math.max(0, i - 3), i + 2).filter((_, ni) => ni !== (Math.min(i, 3)));
          const nearby = nearbyMsgs.map((x) => x?.text || "").join(" ");
          if (/見積|初期費用/.test(nearby)) return `${who}: 【見積書を送付した】`;
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

    // 並列実行: intent分類 + 状況分析 + 知識取得 + 実例取得 + フレーズ取得
    const [detectedIntent, analysis, knowledge, examples, phrases] = await Promise.all([
      classifyIntent(message, currentState, history),
      analyzeCustomerSituation(message, history, currentState, customerName),
      fetchKnowledge(currentState),
      fetchExamples(currentState),
      fetchPhrases(currentState),
    ]);

    // Sonnetでストリーミング生成
    const messages = buildGenerationMessages(
      message, customerName, history, currentState,
      analysis, knowledge, examples, phrases
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
