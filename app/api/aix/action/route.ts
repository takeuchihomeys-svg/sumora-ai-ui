import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const MODEL = "claude-sonnet-4-6";

// 全actionに共通する営業スタイル・禁止ワードルール
const SMORA_COMMON_RULES = `
【スモラの営業スタイル — 最重要】
「誘導」とはお客様を考えさせないこと。スタッフが常に先手を打って次のアクションを示す。
→ 物件を送ったら「お気に召されましたらお申込みでお部屋抑えさせて頂きます！！」と次を示す
→ 内覧日が決まったら「ご内覧前に埋まる可能性があるのでお申込みでお部屋抑えることも可能です」と先に伝える
→ お客様がすべきことは最小限（承認・日程を言うだけ）。それ以外はすべてスタッフがやる
この姿勢がお客様の信頼を生み「任せよう」という気持ちを作る。

【禁止ワード】
× 「スモラにてお取り扱い可能か確認」→ 不動産物件はほぼ全て取り扱い可能。確認するのは「募集状況（空室かどうか）」のみ。正しい表現：「募集状況確認させていただきます！！」
× 「ご共有頂き」→ お客様が物件を送ってきた時は「お送り頂き」を使う。「共有」は業者間・スタッフ間で使う言葉
× 「少々お待ちください」→ 上から目線。「何卒よろしくお願い致します😌！！」で締める
× 「仲介手数料を割引・最大限割引させて頂きます」→ 仲介手数料はスモラ2,980円・イエヤス0円と最初から格安・固定。割引するのは「初期費用」全体。正しい表現：「初期費用を最大限割引させていただきます」
× 審査落ち・物件が埋まった等でも謝罪しない（「申し訳ございません」「ご迷惑おかけし」禁止） → 「引き続き〇〇さんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！」のようなサポート継続宣言で返す`.trim();

async function getPhrases(category: string, customerName?: string): Promise<string> {
  const { data } = await supabase
    .from("phrase_dictionary")
    .select("phrase")
    .eq("category", category)
    .order("priority", { ascending: false })
    .limit(15);
  const fallback = customerName || "お客様";
  return (data || []).map((r: { phrase: string }) =>
    `- ${r.phrase.replace(/\{\{customer_name\}\}/g, fallback)}`
  ).join("\n");
}

// 物件オススメの実例（☆つき）を取得してAIの参考文として返す
async function getPropertyExamples(): Promise<string> {
  const { data } = await supabase
    .from("ai_reply_examples")
    .select("sent_reply")
    .in("conversation_state", ["property_recommendation", "proposing"])
    .eq("is_starred", true)
    .order("created_at", { ascending: false })
    .limit(20);
  if (!data || data.length === 0) return "";
  return (data as { sent_reply: string }[])
    .map((r, i) => `【実例${i + 1}】\n${r.sent_reply}`)
    .join("\n\n---\n\n");
}

// aix_settings からシステムプロンプトを取得（なければデフォルト）
async function getAixSystemPrompt(key: string, defaultValue: string): Promise<string> {
  const { data } = await supabase
    .from("aix_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  return data?.value ?? defaultValue;
}

// 物件オススメ関連のknowledgeを取得（差分学習ルール優先）
async function getPropertyKnowledge(): Promise<string> {
  const [{ data: diffLearned }, { data: stateKnowledge }] = await Promise.all([
    // ① 差分学習ルール（最優先）
    supabase.from("ai_reply_knowledge")
      .select("title, content")
      .ilike("title", "%差分学習%")
      .gte("importance", 7)
      .order("created_at", { ascending: false })
      .limit(15),
    // ② フェーズ別ナレッジ
    supabase.from("ai_reply_knowledge")
      .select("category, title, content")
      .in("conversation_state", ["property_recommendation", "proposing"])
      .gte("importance", 7)
      .not("title", "ilike", "%差分学習%")
      .order("importance", { ascending: false })
      .limit(12),
  ]);
  const parts: string[] = [];
  if ((diffLearned?.length ?? 0) > 0)
    parts.push("【🔴 過去の修正パターン（必ず守る）】\n" + diffLearned!.map(r => `・${r.title}: ${r.content}`).join("\n"));
  if ((stateKnowledge?.length ?? 0) > 0)
    parts.push("【物件オススメのノウハウ】\n" + (stateKnowledge as { category: string; title: string; content: string }[]).map(r => `・${r.content}`).join("\n"));
  return parts.join("\n\n");
}

async function callClaude(system: string, user: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Claude error: ${await res.text()}`);
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || "";
}

async function callClaudeVision(system: string, content: unknown[]): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) throw new Error(`Claude Vision error: ${await res.text()}`);
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || "";
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, account, customer_name, image_url, image_urls, condition_image_url, customer_conditions, extra_input, parsed_estimate, recent_messages, check_pattern, vacating_note, calendar_info, viewing_done, vacancy_status, has_estimate, move_out_date } = body;

    // 直近の会話履歴テキスト（viewing_invite・application_push で使用）
    const recentHistory = Array.isArray(recent_messages) && recent_messages.length > 0
      ? "\n\n【直近の会話履歴（この流れを踏まえて文を作ること）】\n" +
        (recent_messages as Array<{ sender: string; text: string }>)
          .filter((m) => m.text && m.text !== "[画像]" && m.text !== "[動画]")
          .slice(-20)
          .map((m) => `${m.sender === "customer" ? "お客様" : "スモラ"}: ${m.text}`)
          .join("\n")
      : "";

    const name = customer_name ? `${customer_name}さん` : "お客様";

    // phrase_dictionary 取得（物件オススメ・内覧・申込のみ）
    const phraseCategoryMap: Record<string, string> = {
      property_recommendation: "property_recommendation",
      viewing_invite: "viewing_invite",
      application_push: "application_push",
    };
    const phraseCategory = phraseCategoryMap[action];
    const phraseText = phraseCategory ? await getPhrases(phraseCategory, customer_name) : "";

    let message_text = "";
    let parsed_estimate_result = null;

    // ── 🏠 物件オススメ ───────────────────────────────────────────
    if (action === "property_recommendation") {
      if (!image_url) throw new Error("物件資料画像が必要です");

      // 実例・knowledge・DBプロンプトを並列取得
      const DEFAULT_PROP_SYSTEM = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
物件資料の画像を読み取り、訴求力のあるオススメ物件メッセージを作成してください。

【出力フォーマット — 必ずこの構成で出力すること】

🌟[物件名]（部屋番号がある場合は半角スペースを空けて記載）

[お客様名]さんにかなりオススメ出来るお部屋となります！！

（オススメポイント）
・家賃[金額]円（管理費別の場合は「家賃[金額]円・管理費[金額]円（合計[金額]円）」の形式）
・間取り：[間取り名]（[LDKの広さ]、[洋室1の広さ]・[洋室2の広さ]…の順で記載）
・[路線名]「[駅名]」徒歩[X]分（お客様の希望徒歩分数以内なら記載。例：お客様が徒歩15分以内希望→13分でも記載OK。2駅ある場合は両方記載）
・[物件固有の強み（築年・ペット可・インターネット無料・敷金礼金0円・駐車場あり・セキュリティ設備など。お客様の希望条件に合った特徴を優先して選ぶ）]
・[さらにあれば追加（最大5項目まで）]

[物件の家賃・間取り・築年など主な魅力を1文でシンプルにまとめるサマリー文。「家賃管理費込[金額]円の[間取り]、[築年]築の築浅物件となります！！」など]

[間取りの各部屋の広さを描写（LDK○帖と開放感のあるリビングに、洋室○帖・洋室○帖と各室広々〜など）。続けて設備はオススメポイントに書いていない特徴的なもの2〜3項目のみを記載して「設備面も充実しております！！」で締める。全設備を列挙しない。]

[締め文 — 以下の条件で使い分ける]
・「退去予定日:」としてユーザーメッセージに日付が明示されている場合：その日付をそのまま使い「[明示された日付]退去予定のため、[明示された日付]以降にご内覧可能です！！」（画像から読み直し絶対禁止）
・退去予定が画像から読み取れる場合（日付未明示）：「○月末退去予定のため、○月○日以降にご内覧可能です！！」
・退去予定がない場合：「[お客様名]さんお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！」

【フォーマットルール — 必ず全て守ること】
・物件名は先頭に必ず🌟をつける（🌟の後に半角スペースは入れない）
・[お客様名]は必ず実際の名前に置き換える（「さん」付け）・呼び方は最初から最後まで一貫して変えない
・「！！」（全角感嘆符2つ）を使用する（スモラスタイル）・「！」1つは使わない
・絵文字は 😊 のみ・最大1個まで・なくてもよい
・数字は具体的に（「63,000円」「徒歩7分」「6帖」など）
・（オススメポイント）は4〜5項目厳守。お客様の希望条件に合った特徴を優先して選ぶ。6項目以上は絶対禁止
・間取りの広さはLDK→洋室の順で書く（洋室から始めない）
・お客様の条件より家賃・広さが劣る物件の場合は「〜より一回り狭くなってしまいますが、〜の点がかなりオススメ出来るお部屋となります！！」と正直に伝えながら強みを前面に出す
・「！！」（全角感嘆符2つ）を積極的に使う（スモラスタイル）

【絶対禁止ルール】
・バルコニー付きはオススメポイントに書かない（全物件共通のため）
・オススメポイントに書いた内容を設備説明パートで重複させない（例：インターネット無料をオススメポイントで書いたら設備説明では省く）
・お客様の希望徒歩分数を超える駅情報はオススメポイントに書かない（希望条件が不明な場合は徒歩10分以内のみ）
・お客様の条件は「どの特徴を強調するか」の判断に使う。ただし「ご希望の○○以内で〜」「ご希望エリアで〜」など条件をそのまま言葉として繰り返す表現は使わない（条件を踏まえて訴求するが、条件の復唱はしない）
・曖昧な情報を書かない（駐車場が空きナシなら明記しない・「空き待ちのご相談も可能」などの曖昧な言い方禁止）
・「お手隙の際にご査収ください」は使わない
・「ご希望条件に合致しており」「ご希望の〇〇をしっかり満たしており」「ご条件がクリアしており」などの確認文は使わない（条件を踏まえて訴求するが、条件の確認・復唱はしない）
・「家具家電付きプランあり（月額+〇〇円）」はオススメポイントに書かない（本体の家賃と混乱するため）
・設備説明パートで全設備を列挙しない。オススメポイントに書いていない特徴的なもの2〜3項目のみ

{{examples}}

{{knowledge}}

{{phrases}}

${SMORA_COMMON_RULES}`;

      // フォーマット固定: DEFAULT_PROP_SYSTEM を直接使用（DBで上書きしない）
      const [examples, knowledge] = await Promise.all([
        getPropertyExamples(),
        getPropertyKnowledge(),
      ]);

      // {{examples}} {{knowledge}} {{phrases}} を実データに置換
      const system = DEFAULT_PROP_SYSTEM
        .replace("{{examples}}", examples ? `【スモラの実際の物件オススメ文（実例）】\n${examples}` : "")
        .replace("{{knowledge}}", knowledge ? `【物件オススメ時のノウハウ】\n${knowledge}` : "")
        .replace("{{phrases}}", phraseText ? `【よく使うフレーズ】\n${phraseText}` : "");

      const conditionsText = customer_conditions as string | undefined;
      // move_out_date が渡された場合は明示注入（画像OCR誤読防止）
      const moveOutNote = move_out_date
        ? `\n\n【退去予定日（必ずこの日付をそのまま使うこと・画像から読み直し禁止）】\n${move_out_date}`
        : "";
      const userText = `${name}へのオススメ物件メッセージを作成してください。${conditionsText ? `\n\nお客様の希望条件:\n${conditionsText}` : ""}${extra_input ? `\n追加情報: ${extra_input}` : ""}${moveOutNote}`;

      const content = [
        { type: "text", text: userText },
        ...(condition_image_url ? [{ type: "image", source: { type: "url", url: condition_image_url } }] : []),
        { type: "image", source: { type: "url", url: image_url } },
      ];

      message_text = await callClaudeVision(system, content);

    // ── 💰 見積書送る ─────────────────────────────────────────────
    } else if (action === "estimate_sheet") {
      let estimate = parsed_estimate;

      if (!estimate) {
        if (!image_url) throw new Error("見積書画像が必要です");

        const ocrSystem = `見積書画像から以下の項目をJSONで抽出してください。
数値は整数のみ（円・¥・カンマは除く）。不明な項目は0または空文字。
{
  "property_name": "物件名（マンション名のみ、号室は含めない）",
  "room_number": "号室番号のみ（例: 502）",
  "rent": 月額家賃（整数）,
  "total": 初期費用合計（割引後・整数）,
  "discount": 割引額（なければ0）,
  "commission": 仲介手数料税抜（なければ0）,
  "commission_tax": 仲介手数料消費税（なければ0）
}`;

        const raw = await callClaudeVision(ocrSystem, [
          { type: "text", text: "この見積書から指定の項目を抽出してください。" },
          { type: "image", source: { type: "url", url: image_url } },
        ]);

        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          try { estimate = JSON.parse(match[0]); } catch { estimate = {}; }
        } else {
          estimate = {};
        }
      }

      // アカウント名マッピング
      const ACCOUNT_NAMES: Record<string, string> = {
        sumora: "スモラ",
        ieyasu: "イエヤス",
        giga:   "ギガ賃貸",
      };
      const accountName = ACCOUNT_NAMES[String(account || "sumora")] ?? "スモラ";

      // 固定フォーマットでテキスト生成（estimate/page.tsx の generateLineText と同じロジック）
      const est = estimate as Record<string, unknown>;
      const propertyName = String(est.property_name || "");
      const roomNumber   = String(est.room_number   || "");
      const total        = Number(est.total          || 0);
      const discount     = Number(est.discount       || 0);
      const rent         = Number(est.rent           || 0);
      const commission   = Number(est.commission     || 0);
      const commTax      = Number(est.commission_tax || 0);

      const standardCommission = Math.round(rent * 1.1);
      const actualCommission   = commission + commTax;
      const savings = Math.max(0, standardCommission - actualCommission + discount);

      const parts: string[] = [];

      if (propertyName || roomNumber) {
        const roomSuffix = roomNumber ? ` ${roomNumber}号室` : "";
        parts.push(`【${propertyName}${roomSuffix}】`);
        parts.push("");
      }

      if (discount > 0) {
        parts.push("初期費用さらに");
        parts.push(`🌟${discount.toLocaleString()}円割引させて頂き`);
        parts.push(`初期費用：${total.toLocaleString()}円`);
      } else if (total > 0) {
        parts.push(`初期費用：${total.toLocaleString()}円`);
      }

      parts.push("");

      if (savings > 0) {
        parts.push(`${accountName}なら一般的な不動産業者より${savings.toLocaleString()}円節約出来ます！！`);
        parts.push("");
      }

      parts.push("※ご入居日によって日割家賃が発生致します。");

      message_text = parts.join("\n");
      parsed_estimate_result = estimate;

    // ── 📤 物件送る ──────────────────────────────────────────────
    } else if (action === "property_send") {
      const calendarData = body.calendar_info ? String(body.calendar_info) : null;
      const vacatingInfo = vacating_note ? String(vacating_note) : null;
      const customerSummary = body.customer_summary as string | undefined;
      const sendMode = body.send_mode === "application" ? "application" : "viewing";

      const summaryNote = customerSummary
        ? `\n\n【このお客さんのAI要約 — 今の状況・次の必須対応を最優先で文案に反映すること。人物像・文体も合わせること】\n${customerSummary}`
        : "";

      // 物件送るの実例を取得（property_send + proposing 両方から）
      const { data: sendExamples } = await supabase
        .from("ai_reply_examples")
        .select("sent_reply")
        .in("conversation_state", ["property_send", "proposing"])
        .eq("is_starred", true)
        .or("sent_reply.ilike.%ピックアップ%,sent_reply.ilike.%お待たせ致しました%")
        .order("created_at", { ascending: false })
        .limit(5);

      const sendExamplesText = (sendExamples || []).length > 0
        ? "\n\n【スモラの実際の物件送付メッセージ例 — 文体・言い回し・構成を必ずこれに合わせること】\n" +
          (sendExamples as { sent_reply: string }[])
            .map((r, i) => `[例${i + 1}]\n${r.sent_reply}`)
            .join("\n\n")
        : "";

      const conditionsInfo = customer_conditions ? String(customer_conditions) : null;
      const conditionsRule = conditionsInfo
        ? `・お客様の希望条件が渡されている場合は、冒頭の「ご希望のご条件に合ったお部屋」の部分を具体化する
  例：「九条周辺・家賃6万円以下・1Kのご条件に合ったお部屋ピックアップさせて頂きました😊！！」
  条件から主なポイント（エリア・家賃・間取り等）を自然に組み込む`
        : `・「ご希望のご条件に合ったお部屋ピックアップさせて頂きました😊！！」で冒頭を続ける`;

      const sendSystem = sendMode === "application"
        ? `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
物件をピックアップしてお客さんに送る際の導入メッセージを1つだけ作成してください。
このお客さんは内覧より先にお申込みで部屋を確保することを優先する流れです。

${SMORA_COMMON_RULES}

【構成（この順番で作ること）】
①「[お客様名]さんお待たせ致しました！！」で始める
②${conditionsRule.replace(/^・/, "")}
③退去予定・案内できない物件がある場合：「◎〇〇マンション\n[退去予定/時期]となりますのでお部屋ご案内出来ない形となります！！」（複数あれば全て列挙）
④「お気に召されましたらそのままお申込みでお部屋を抑えることが可能です！！」
⑤最終行：「お手隙の際にご査収ください😌！！」を単独で置く

・感嘆符は「！！」（スモラスタイル）・LINEでそのまま送れる完成文のみ出力・絵文字は 😊 😌 のみ・1〜2個まで${sendExamplesText}`
        : `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
物件をピックアップしてお客さんに送る際の導入メッセージを1つだけ作成してください。

${SMORA_COMMON_RULES}

【構成（この順番で作ること）】
①「[お客様名]さんお待たせ致しました！！」で始める
②${conditionsRule.replace(/^・/, "")}
③退去予定・案内できない物件がある場合：「◎〇〇マンション\n[退去予定/時期]となりますのでお部屋ご案内出来ない形となります！！」（複数あれば全て列挙）
④内覧誘導：「[お客様名]さんお気に召されましたらお日にちにご案内させて頂きます😊！！」
⑤カレンダー情報がある場合は④の後に内覧日時を縦並びで追加：
  「直近ですと
  M/D（曜日）HH:MM〜HH:MM
  M/D（曜日）HH:MM〜HH:MM
  ご案内可能です！！」（案内できる日のみ・3日間すべて不可なら「来週ご案内できる日程をご連絡させていただきます！！」）
⑥最終行：「お手隙の際にご査収ください😌！！」を単独で置く

・感嘆符は「！！」（スモラスタイル）・LINEでそのまま送れる完成文のみ出力・絵文字は 😊 😌 のみ・1〜2個まで${sendExamplesText}`;

      const userParts: string[] = [`${name}への物件ピックアップ送付メッセージを作成してください。`];
      if (conditionsInfo) userParts.push(`\n\n【お客様の希望条件（冒頭に自然に組み込むこと）】\n${conditionsInfo}`);
      if (calendarData) userParts.push(`\n\n【直近3日の内覧可能時間帯（calendar_events+daily_tasks合算済み・この情報をそのまま使うこと）】\n${calendarData}`);
      if (vacatingInfo) userParts.push(`\n\n【退去予定・案内不可の物件情報（必ず全て伝えること）】\n${vacatingInfo}`);
      if (summaryNote) userParts.push(summaryNote);

      message_text = await callClaude(sendSystem, userParts.join(""));

    // ── 🔍 内覧へ！ ──────────────────────────────────────────────
    } else if (action === "viewing_invite") {
      const calendarNote = calendar_info ? String(calendar_info) : null;
      const system = `あなたは賃貸仲介サービス「スモラ」のLINE営業アシスタントです。
今の会話の流れを読み取り、内覧へ自然に誘導するLINEメッセージを1つだけ作成してください。

${SMORA_COMMON_RULES}

【作成ルール】
・会話履歴がある場合は、送った物件への反応・お客様の状況を踏まえて訴求する
・物件への反応が良い場合は「ぜひご内覧を！」と背中を押す
${calendarNote ? `・直近の内覧可能日時が提供されている場合、必ず以下フォーマットで日時を含めること：
  「直近ですと」の後に改行し、各日を1行ずつ「M/D（曜日）HH:MM〜HH:MM」形式で列挙
  例:
  直近ですと
  6/15（月）15:00〜17:00
  6/16（火）12:00〜14:00
  ご案内出来ます！！
・複数スロットがある日は最初の1つのみ使う
・案内不可の日は記載しない
・締めは「ご都合よろしいお日にちはいかがでしょうか？」` : `・「ご都合よろしいお日にちはございますか？」など日程調整の投げかけで締める`}
・感嘆符は「！！」を使う（スモラスタイル）
・LINEでそのまま送れる完成文のみ出力（解説・候補複数は禁止）

【絵文字ルール — 最重要・必ず守ること】
▼ 使ってよい絵文字はこの5つだけ：😊 😌 🙇‍♀️ 🌟 ✨
▼ 上記以外は一切禁止
▼ 絵文字は1〜2個まで

【スモラの言葉・表現（参考）】
${phraseText || "なし"}`;

      const calendarPart = calendarNote
        ? `\n\n【直近の内覧可能日時（案内可能な日のみ・1行1日形式）】\n${calendarNote}`
        : extra_input ? `候補日時: ${extra_input}` : "";
      message_text = await callClaude(system, `${name}への内覧お誘いメッセージ。${calendarPart}${recentHistory}`);

    // ── ✋ 申込へ！ ──────────────────────────────────────────────
    } else if (action === "application_push") {
      // ☆つき申込実例を取得（application_pushステートを優先）
      const { data: applyExamples } = await supabase
        .from("ai_reply_examples")
        .select("customer_message, sent_reply")
        .in("conversation_state", ["application_push", "applying", "application", "screening", "contract"])
        .eq("is_starred", true)
        .order("conversation_state", { ascending: true })
        .order("created_at", { ascending: false })
        .limit(8);

      const examplesText = (applyExamples || []).length > 0
        ? "\n\n【⭐ スモラの実際の申込後押し例（文体・テンポ・感嘆符・絵文字をこれに合わせる）】\n" +
          (applyExamples as { customer_message: string; sent_reply: string }[])
            .map((r, i) => `[例${i + 1}]\nお客様:「${r.customer_message}」\nスモラ:「${r.sent_reply}」`)
            .join("\n\n")
        : "";

      // 4パターン: (見積書あり/なし) × (空室/退去予定)
      const isVacant = vacancy_status === "vacant";
      const isScheduled = vacancy_status === "scheduled";
      const hasEst = has_estimate === true;
      const moveOut = move_out_date ? move_out_date : "●月●日";

      let templateLines: string[] = [];
      if (hasEst) {
        templateLines.push("[物件名]の最大限割引しました初期費用の御見積書となります！！");
      }
      if (isScheduled) {
        templateLines.push(`お部屋は${moveOut}退去の為ご内覧はまだ出来ないお部屋となります！！`);
        templateLines.push(`お気に召されましたらお申込しお部屋抑えさせて頂きます😌！！`);
      } else {
        templateLines.push(`空室ですので${name}さんご都合よろしいお日にちにご案内させて頂きます！！`);
        templateLines.push(`ご条件がよくお申込みが入る可能性が高いお部屋となります。`);
        templateLines.push(`${name}さんお気に召されましたらお申込し一度お部屋抑えた状態でご内覧いただくのがオススメです😌！！`);
      }
      const template = templateLines.join("\n");

      const system = `あなたは賃貸仲介サービス「スモラ」のLINE営業アシスタントです。
以下のテンプレートを使って、会話履歴から物件名を特定し、完成したLINEメッセージを1つだけ出力してください。

【テンプレート】
${template}

【穴埋めルール】
・「[物件名]」→ 会話履歴に登場する物件名（わからなければ「こちらのお部屋」に置換）
・お客様名は既にテンプレートに入っているのでそのまま使う
・テンプレートの文言・改行・絵文字は変えない
・LINEでそのまま送れる完成文のみ出力（解説・候補複数は禁止）

【スモラの言葉・表現】
${phraseText || "なし"}${examplesText}`;

      message_text = await callClaude(system, `物件名を会話から特定してテンプレートを完成させてください。${extra_input ? `補足: ${extra_input}` : ""}${recentHistory}`);

    // ── ✅ 物件確認した ──────────────────────────────────────────────
    } else if (action === "property_check_result") {
      const pattern = check_pattern as "available" | "alternative" | "unavailable";
      const customerSummary = body.customer_summary as string | undefined;

      // 各パターンの実データ由来お手本（DBに☆つき実例が少ないため直書き）
      const PATTERN_EXAMPLES: Record<string, string> = {
        available: `[パターン例: 空室あり・内覧誘導]
スモラ:「お待たせいたしました！！
〇〇（物件名）空室確認取れました😊！！
ぜひご内覧させていただきたいのですが
直近ですと
6/15（月）15:00〜17:00
6/16（火）12:00〜14:00
ご案内可能です！！
〇〇さんご都合いかがでしょうか😌！！」`,
        alternative: `[パターン例: 満室・代替案あり]
スモラ:「お待たせいたしました！！
確認させていただきました物件のお部屋全て募集が終了しており大変申し訳ございません🙇‍♀️！！
ただAPRILE南森町は一回り広い33.62㎡のお部屋が募集中です！！
こちらのお部屋〇〇さんお気に召されましたらご案内させていただきます！！
ご都合いかがでしょうか😊！！」`,
        unavailable: `[パターン例: 満室・空きなし]
スモラ:「お待たせいたしました！！
大変申し訳ございません🙇‍♀️！！
ご確認の物件は現在募集に出ていないお部屋となっております！！
引き続き〇〇さんのご希望に合うお部屋をピックアップさせていただきます！！
新着で出次第すぐにお送りさせていただきます😌！！」`,
      };

      const calendarNote = (pattern === "available" && calendar_info) ? String(calendar_info) : null;

      const PATTERN_INSTRUCTION: Record<string, string> = {
        available: calendarNote
          ? `物件を確認した結果「空室あり・入居可能」でした。お待たせしたお礼と空室報告をしたあと、提供された内覧可能日時を以下フォーマットで含めてください：
「直近ですと
M/D（曜日）HH:MM〜HH:MM
M/D（曜日）HH:MM〜HH:MM
ご案内可能です！！」
案内不可の日は除外。締めは「ご都合いかがでしょうか😌！！」`
          : "物件を確認した結果「空室あり・入居可能」でした。お待たせしたお礼と空室報告をして、内覧日程の調整へ自然に誘導してください。",
        alternative: "物件を確認した結果「満室でしたが別のお部屋が募集中」でした。お詫びしつつ代替案への期待感を持たせて内覧誘導で締めてください。",
        unavailable: "物件を確認した結果「満室・空きなし」でした。お詫びしつつ引き続き物件探しを続けることを伝え、前向きな雰囲気で締めてください。",
      };

      // knowledgeとDB実例（☆なしも含む）を並列取得
      const [{ data: checkExamples }, { data: checkKnowledge }] = await Promise.all([
        supabase
          .from("ai_reply_examples")
          .select("customer_message, sent_reply")
          .in("conversation_state", ["availability_check"])
          .order("is_starred", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(6),
        supabase
          .from("ai_reply_knowledge")
          .select("category, content")
          .in("conversation_state", ["proposing", "availability_check"])
          .gte("importance", 8)
          .order("importance", { ascending: false })
          .limit(6),
      ]);

      // 見積書・物件ピックアップ系はフィルタして結果報告に近いものだけ残す
      const relevantKeywords = ["空室", "募集終了", "満室", "お待たせ", "確認", "案内", "退去"];
      const filteredExamples = (checkExamples || []).filter((r) =>
        relevantKeywords.some((kw) => r.sent_reply?.includes(kw))
      );

      const examplesText = filteredExamples.length > 0
        ? "\n\n【スモラの実際の送信例（文体・感嘆符・絵文字をこれに合わせる）】\n" +
          filteredExamples
            .slice(0, 4)
            .map((r, i) => `[実例${i + 1}]\nスモラ:「${r.sent_reply}」`)
            .join("\n\n")
        : "";

      const knowledgeText = (checkKnowledge || []).length > 0
        ? "\n\n【スモラのノウハウ（必ず従うこと）】\n" +
          (checkKnowledge as { category: string; content: string }[])
            .map((r) => `・[${r.category}] ${r.content}`)
            .join("\n")
        : "";

      const summaryNote = customerSummary
        ? `\n\n【このお客さんのAI要約 — 今の状況・次の必須対応を最優先で文案に反映すること。人物像・文体も合わせること】\n${customerSummary}`
        : "";

      const patternExample = PATTERN_EXAMPLES[pattern] ?? PATTERN_EXAMPLES.unavailable;

      const checkSystem = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
物件確認の結果をお客さんに報告するLINEメッセージを1つだけ作成してください。

${SMORA_COMMON_RULES}

【作成ルール】
・「お待たせいたしました！！」で始める
・画像（物件資料）が添付されている場合は物件名・間取りなどを読み取って言及する
・会話履歴がある場合はその流れを踏まえた自然な報告文にする
・感嘆符は「！！」（スモラスタイル）
・LINEでそのまま送れる完成文のみ出力（解説・候補複数は禁止）

【絵文字ルール — 最重要・必ず守ること】
▼ 使ってよい絵文字：😊 😌 🙇‍♀️ 🌟 ✨ のみ（他は全禁止）
▼ 絵文字は1〜2個まで

【このパターンのお手本（スモラ実データ由来・文体・構成をこれに合わせる）】
${patternExample}${knowledgeText}${examplesText}`;

      const instruction = PATTERN_INSTRUCTION[pattern] ?? PATTERN_INSTRUCTION.unavailable;
      const calendarPart = calendarNote
        ? `\n\n【内覧可能日時（1日1行で含めること・案内不可の日は除外）】\n${calendarNote}`
        : "";
      const userText = `${name}への物件確認報告メッセージを作成してください。\n\n${instruction}${calendarPart}${summaryNote}${recentHistory}`;

      if (image_url) {
        const content = [
          { type: "text", text: userText },
          { type: "image", source: { type: "url", url: image_url } },
        ];
        message_text = await callClaudeVision(checkSystem, content);
      } else {
        message_text = await callClaude(checkSystem, userText);
      }

    } else {
      return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      message_text,
      ...(parsed_estimate_result ? { parsed_estimate: parsed_estimate_result } : {}),
    });
  } catch (err) {
    console.error("[aix/action]", err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
