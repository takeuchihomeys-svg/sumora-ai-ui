import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const MODEL = "claude-sonnet-4-6";

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
    .limit(12);
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

// 物件オススメ関連のknowledgeを取得
async function getPropertyKnowledge(): Promise<string> {
  const { data } = await supabase
    .from("ai_reply_knowledge")
    .select("category, title, content, importance")
    .in("conversation_state", ["property_recommendation", "proposing"])
    .gte("importance", 7)
    .order("importance", { ascending: false })
    .limit(15);
  if (!data || data.length === 0) return "";
  return (data as { category: string; title: string; content: string }[])
    .map((r) => `[${r.category}] ${r.title}: ${r.content}`)
    .join("\n");
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
    const { action, account, customer_name, image_url, image_urls, condition_image_url, customer_conditions, extra_input, parsed_estimate, recent_messages, check_pattern, vacating_note } = body;

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
物件資料の画像を読み取り、お客様の希望条件に合わせた訴求力のあるオススメ物件メッセージを作成してください。

【出力フォーマット — 必ずこの構成で出力すること】

🌟[物件名]（部屋番号がある場合は半角スペースを空けて記載）

[お客様名]さんにかなりオススメ出来るお部屋となります！！

（オススメポイント）
・管理費込[金額]円（管理費が別の場合は「家賃[金額]円・管理費[金額]円（合計[金額]円）」の形式）
・間取り：[間取り名]（[各部屋の広さ詳細。例：洋室6帖・洋室4.5帖・DK7帖]）
・[路線名]「[駅名]」徒歩[X]分（2駅ある場合は「・[路線名2]「[駅名2]」徒歩[X]分」も追記）
・[特徴1（ペット可・駐車場・インターネット無料・バルコニーなど）]
・[特徴2（築年・セキュリティ・最上階・礼金0円など）]

[お客様の条件（家賃・広さ・駅・こだわり）との合致点を1〜2文で強調するアピール文。例：「礼金0円キャンペーン中で初期費用抑えられます！！」や「ご希望家賃内でインターネット無料のX帖のお部屋とかなり条件が良く[お客様名]さんにオススメ出来るお部屋となります！！」など。お客様条件より広さや家賃が劣る場合は「〜より一回り狭くなってしまいますが、〜の条件はかなりオススメ出来るお部屋となります😊！！」と正直に伝えながら強みを前面に出す]

[間取り・立地・設備の詳細説明を1〜2文で補足。お客様名を入れて「[お客様名]さんにかなりオススメ出来るお部屋となります！！」で締める]

[お客様名]さんお気に召されましたら、ご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！

【フォーマットルール】
・物件名は先頭に必ず🌟をつける（🌟の後に半角スペースは入れない）
・[お客様名]は必ず実際の名前に置き換える（「さん」付け）
・「！！」（全角感嘆符2つ）を使用する（スモラスタイル）
・絵文字は 😊 のみ・1個まで・締め文または軽いフォロー文にのみ使用
・数字は具体的に（「63,000円」「徒歩7分」「6帖」など）
・（オススメポイント）の項目は画像から読み取れる情報で3〜5項目
・お客様条件が渡されている場合は、アピール文で必ず条件と物件を照らし合わせて言及する
・退去予定がある場合は最後に「〇月末退居予定のため、お気に召されましたらお申込みでお部屋抑えさせて頂きます😌！！」を追加
・「お手隙の際にご査収ください」は使わない

{{examples}}

{{knowledge}}

{{phrases}}`;

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
      const userText = `${name}へのオススメ物件メッセージを作成してください。${conditionsText ? `\n\nお客様の希望条件:\n${conditionsText}` : ""}${extra_input ? `\n追加情報: ${extra_input}` : ""}`;

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

      const summaryNote = customerSummary
        ? `\n\n【このお客さんの人物像・特徴（AI要約）— 文体・トーン・アプローチに必ず反映すること】\n${customerSummary}`
        : "";

      const sendSystem = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
物件をピックアップしてお客さんに送る際の導入メッセージを1つだけ作成してください。

【スタッフの営業時間】10:00〜19:00

【作成ルール】
・「[お客様名]さんお待たせ致しました！！ご希望のご条件に合ったお部屋ピックアップしお送りさせて頂きます😊！！」で自然に始める
・カレンダー情報が渡されている場合は必ず内覧可能日時をアナウンスする：
  - 「予定なし」の日 → 終日ご案内可能（例：「16日(月)は終日ご案内可能です！！」）
  - 予定がある日 → 予定と予定の間・予定終了後で2時間以上空きがある時間帯を案内（例：「17日(火)は14:00〜」）
  - 予定で埋まっている日（空きが2時間未満）→ その日は案内できないと伝える
  - 直近3日のうち案内できる日・時間帯を「直近ですと\n[日付]([曜日]) [時間帯]\n[日付]([曜日]) [時間帯]\nご案内可能です！！」の形式で案内する（案内できる日のみ記載）
  - 3日間すべて埋まっている場合は「来週ご案内できる日程をご連絡させていただきます！！」と伝える
・退去予定・案内できない物件情報が渡されている場合は「〇〇は[退去予定/時期]となりますのでお部屋ご案内出来ない形となります！！」と明確に伝える（複数ある場合は全て伝える）
・締めは「[お客様名]さんお気に召されましたらお日にちにご案内させて頂きます😊！！」
・感嘆符は「！！」（スモラスタイル）
・LINEでそのまま送れる完成文のみ出力（解説・候補複数は禁止）
・絵文字は 😊 のみ・1〜2個まで`;

      const userParts: string[] = [`${name}への物件ピックアップ送付メッセージを作成してください。`];
      if (calendarData) userParts.push(`\n\n【直近3日のカレンダー予定（営業時間10:00〜19:00内の空き時間を計算して案内すること）】\n${calendarData}`);
      if (vacatingInfo) userParts.push(`\n\n【退去予定・案内不可の物件情報（必ず全て伝えること）】\n${vacatingInfo}`);
      if (summaryNote) userParts.push(summaryNote);

      message_text = await callClaude(sendSystem, userParts.join(""));

    // ── 🔍 内覧へ！ ──────────────────────────────────────────────
    } else if (action === "viewing_invite") {
      const system = `あなたは賃貸仲介サービス「スモラ」のLINE営業アシスタントです。
今の会話の流れを読み取り、内覧へ自然に誘導するLINEメッセージを1つだけ作成してください。

【作成ルール】
・会話履歴がある場合は、送った物件への反応・お客様の状況を踏まえて訴求する
・物件への反応が良い場合は「ぜひご内覧を！」と背中を押す
・「ご都合よろしいお日にちはございますか？」など日程調整の投げかけで締める
・感嘆符は「！！」を使う（スモラスタイル）
・LINEでそのまま送れる完成文のみ出力（解説・候補複数は禁止）

【絵文字ルール — 最重要・必ず守ること】
▼ 使ってよい絵文字はこの5つだけ：😊 😌 🙇‍♀️ 🌟 ✨
▼ 上記以外は一切禁止
▼ 絵文字は1〜2個まで

【スモラの言葉・表現（参考）】
${phraseText || "なし"}`;

      message_text = await callClaude(system, `${name}への内覧お誘いメッセージ。${extra_input ? `候補日時: ${extra_input}` : ""}${recentHistory}`);

    // ── ✋ 申込へ！ ──────────────────────────────────────────────
    } else if (action === "application_push") {
      // ☆つき申込実例を取得
      const { data: applyExamples } = await supabase
        .from("ai_reply_examples")
        .select("customer_message, sent_reply")
        .in("conversation_state", ["applying", "application", "screening", "contract"])
        .eq("is_starred", true)
        .order("created_at", { ascending: false })
        .limit(8);

      const examplesText = (applyExamples || []).length > 0
        ? "\n\n【⭐ スモラの実際の申込後押し例（文体・テンポ・感嘆符・絵文字をこれに合わせる）】\n" +
          (applyExamples as { customer_message: string; sent_reply: string }[])
            .map((r, i) => `[例${i + 1}]\nお客様:「${r.customer_message}」\nスモラ:「${r.sent_reply}」`)
            .join("\n\n")
        : "";

      const system = `あなたは賃貸仲介サービス「スモラ」のLINE営業アシスタントです。
今の会話の流れを読み取り、申込を自然に後押しするLINEメッセージを1つだけ作成してください。

【作成ルール】
・会話履歴がある場合は、お客様が興味を持っている物件・状況を踏まえて訴求する
・申込のメリット（お部屋を押さえられる・他に取られる前に）を自然に伝える
・繁忙期や退去予定がある場合は緊急性を持たせる
・感嘆符は「！！」（スモラスタイル）
・LINEでそのまま送れる完成文のみ出力（解説・候補複数は禁止）

【絵文字ルール — 最重要・必ず守ること】
▼ 使ってよい絵文字：😊 😌 🙇‍♀️ 🌟 ✨ のみ（他は全禁止）
▼ 絵文字は1〜2個まで。😊😌 → 背中を押す・締めの一言
▼ 感嘆符は「！！」（スモラスタイル）

【スモラの言葉・表現】
${phraseText || "なし"}${examplesText}`;

      message_text = await callClaude(system, `${name}への申込後押しメッセージ。${extra_input ? `補足: ${extra_input}` : ""}${recentHistory}`);

    // ── ✅ 物件確認した ──────────────────────────────────────────────
    } else if (action === "property_check_result") {
      const pattern = check_pattern as "available" | "alternative" | "unavailable";
      const customerSummary = body.customer_summary as string | undefined;

      const PATTERN_INSTRUCTION: Record<string, string> = {
        available:   "物件を確認した結果「空室あり・入居可能」でした。お待たせしたお礼と空室報告をして、内見日程の調整へ自然に誘導してください。",
        alternative: "物件を確認した結果「満室でしたが、同じマンションまたは近隣で別のお部屋が募集中」でした。残念な気持ちに寄り添いつつ、別の選択肢への期待感をもたせて内見誘導で締めてください。",
        unavailable: "物件を確認した結果「満室・空きなし」でした。お待たせしたお詫びをしつつ、引き続き物件探しを続けることを伝え、前向きな雰囲気で締めてください。",
      };

      // 実例・knowledgeを並列取得
      const [{ data: checkExamples }, { data: checkKnowledge }] = await Promise.all([
        supabase
          .from("ai_reply_examples")
          .select("customer_message, sent_reply")
          .in("conversation_state", ["proposing", "availability_check", "property_recommendation"])
          .eq("is_starred", true)
          .order("created_at", { ascending: false })
          .limit(8),
        supabase
          .from("ai_reply_knowledge")
          .select("category, content")
          .in("conversation_state", ["proposing", "availability_check"])
          .gte("importance", 8)
          .order("importance", { ascending: false })
          .limit(8),
      ]);

      const examplesText = (checkExamples || []).length > 0
        ? "\n\n【⭐ スモラの実際の送信例（文体・感嘆符・絵文字をこれに合わせる）】\n" +
          (checkExamples as { customer_message: string; sent_reply: string }[])
            .map((r, i) => `[例${i + 1}]\nお客様:「${r.customer_message}」\nスモラ:「${r.sent_reply}」`)
            .join("\n\n")
        : "";

      const knowledgeText = (checkKnowledge || []).length > 0
        ? "\n\n【スモラのノウハウ（必ず従うこと）】\n" +
          (checkKnowledge as { category: string; content: string }[])
            .map((r) => `・[${r.category}] ${r.content}`)
            .join("\n")
        : "";

      const summaryNote = customerSummary
        ? `\n\n【このお客さんの人物像・特徴（AI要約）— 文体・トーン・アプローチに必ず反映すること】\n${customerSummary}`
        : "";

      const checkSystem = `あなたは賃貸仲介サービス「スモラ」のLINE営業担当です。
物件確認の結果をお客さんに報告するLINEメッセージを1つだけ作成してください。

【作成ルール】
・「大変お待たせいたしました！！」で始める
・画像（物件資料）が添付されている場合は物件名・間取りなどを読み取って言及する
・会話履歴がある場合はその流れを踏まえた自然な報告文にする
・感嘆符は「！！」（スモラスタイル）
・LINEでそのまま送れる完成文のみ出力（解説・候補複数は禁止）

【絵文字ルール — 最重要・必ず守ること】
▼ 使ってよい絵文字：😊 😌 🙇‍♀️ 🌟 ✨ のみ（他は全禁止）
▼ 絵文字は1〜2個まで${knowledgeText}${examplesText}`;

      const instruction = PATTERN_INSTRUCTION[pattern] ?? PATTERN_INSTRUCTION.unavailable;
      const userText = `${name}への物件確認報告メッセージを作成してください。\n\n${instruction}${summaryNote}${recentHistory}`;

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
