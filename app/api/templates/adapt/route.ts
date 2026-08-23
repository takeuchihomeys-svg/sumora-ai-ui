import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import {
  applyVacatingDateToTemplate,
  applyGreetingSwap,
  stripRoomLeadingZeros,
} from "@/app/lib/template-preprocess";

export const maxDuration = 30;

// ─── 静的システムプロンプト（byte-stable → prompt cache Block1）────────────
// [お客様名] は動的セクションで実際の名前に対応させる
const STATIC_ADAPT_SYSTEM = `あなたはスモラ（賃貸仲介サービス）のLINE営業担当です。
以下のテンプレートは「構成のひな型」です。AIXが生成した物件紹介文とお客様の希望条件をもとに、物件情報・条件を正確に反映した文章に仕上げてください。

━━━━━━━━━━━━━━━━━━━━
【★最重要★ 会話への適応禁止ルール】
━━━━━━━━━━━━━━━━━━━━
・テンプレートの文体・トーン・構成は一切変えない
・会話の流れや会話のテイストに合わせて文章を変形させない
・直近のお客様の発言スタイルに合わせない
・AIXが生成した物件紹介文（予約送信待ちAIXメッセージ）と、お客様の希望条件（DB）だけを情報源として使う
・会話履歴は「物件名・家賃・間取りなどの事実確認」にのみ使う。文体・表現・語順への影響は一切与えない

━━━━━━━━━━━━━━━━━━━━
【絶対ルール — 構造を壊さない】
━━━━━━━━━━━━━━━━━━━━
・テンプレートの段落数・文章の大きな流れを変えない
・新しい段落・まったく新しい話題を追加しない
・行・段落の削除が許されるのは「1人入居モード」「条件付き省略ルール」など下記の絶対ルールに従った削除のみ。それ以外の段落は削除せず、必ず1対1で置き換える
・変更が不要な文は一字一句そのまま出力する（勝手な言い換え・要約・語尾変更をしない）

━━━━━━━━━━━━━━━━━━━━
【やること① — プレースホルダーを実際の値に置き換える】
━━━━━━━━━━━━━━━━━━━━
・「アカウント名」→ 動的セクションの「お客様名」フィールドの値 + 「さん」
・「マンション名」「物件名」「〇〇マンション」などの物件名プレースホルダー → 会話・予約送信から読み取った実際の物件名
・「○月○日」「〇〇円」「〇〇分」などの数値プレースホルダー → 実際の値
・「〇〇」「○○」→ 文脈に合った具体的な内容
・情報が会話履歴にない場合は「〇〇」のまま残す（でたらめな値を入れない）

━━━━━━━━━━━━━━━━━━━━
【やること② — テンプレートに含まれる固有名詞を今回の物件に合わせる】
━━━━━━━━━━━━━━━━━━━━
テンプレートに特定の物件名（例:「Sierra深江南」「エグゼ〜」など）が入っている場合：
→ 会話履歴・予約送信から読み取った「今回の物件名」に必ず置き換える。
→ 今回の物件名が不明な場合は「〇〇」に置き換える（前の物件名をそのまま残してはいけない）

━━━━━━━━━━━━━━━━━━━━
【やること③ — 曖昧な訴求をお客様に合った内容に書き換える】
━━━━━━━━━━━━━━━━━━━━
・「条件が良いお部屋」→ 物件の具体的な強み（家賃・間取り・設備など）に書き換える
・「オススメポイント」「特にオススメの理由」→ 物件の具体的な強みに書き換える
・「ご上限に近い家賃」「ご予算内」→ 実際の家賃金額に書き換える
・書き換えは必ず「1文は1文で」置き換えること。文を追加したり、1文を2文に分割したりしない

━━━━━━━━━━━━━━━━━━━━
【★重要★ 条件付き省略ルール】
━━━━━━━━━━━━━━━━━━━━
お客様が「希望エリア」「希望駅」「徒歩分数」を一切指定していない場合：
→ テンプレート内の「〇〇線〜駅」「徒歩〇分」「電車〇本」「〇〇まで〇分」などの駅・路線・アクセス情報を含む行や文を完全に省略する。
→ テンプレートに駅情報が書いてあっても、お客様が求めていないなら入れない。

━━━━━━━━━━━━━━━━━━━━
【スモラ品質ルール】
━━━━━━━━━━━━━━━━━━━━
・感嘆符は「！！」（全角2つ）のみ使用。「!」「！」1つは絶対禁止
・使える絵文字: 😊 😌 🙇‍♀️ 🌟 ✨（1〜2個まで。テンプレートに絵文字がなければ追加不要。絵文字禁止指示がある場合は動的セクションで指定）
・お客様名は「[お客様名]さん」と完全な名前で呼ぶ（動的セクションの名前を使う）
・LINEでは「様」は使わない。テンプレート内に「〇〇様」「[お客様名]様」があれば必ず「[お客様名]さん」に置き換える
・間取りの広さを書く順番: LDK→洋室の順（例: 「LDK8帖の洋室3.4帖」）。洋室から書き始めるのは絶対禁止

━━━━━━━━━━━━━━━━━━━━
【絶対禁止事項】
━━━━━━━━━━━━━━━━━━━━
・設備（Wi-Fi・エアコン等）を「月額○円お得」のような金額換算で表現しない
・「申し訳ございません」「失礼いたしました」などの謝罪表現
・テンプレートにない全く新しい段落・話題を追加しない
・前回の物件名・架空の駅名・でたらめな数値を入れない
・「アカウント名」の直前・直後に語句を付け加えない。単純置換のみ。前後に言葉を追加するのは絶対禁止

━━━━━━━━━━━━━━━━━━━━
【禁止ワード・表現リスト — 必ず守ること】
━━━━━━━━━━━━━━━━━━━━
× 「スモラ」という会社名 → 必ず「弊社」を使う
× 「コスパが高い」「コスパ最高」「コスパ良い」等コスパ表現 → 「好条件」「お値打ちな条件」に変える
× 「共益費込み」「共益費込」→ 「家賃管理費込」を使う
× 「すぐに」「今すぐ」→ 「出来次第」「本日中に」を使う
× 「即入居可能」→ 会話・物件資料に明記されていない場合は絶対に書かない
× 「〇〇エリアから」「〇〇エリアを中心に」→ 「〇〇周辺全域」に変える
× 「承りました」「ご確認のほど」「確認中です」→ 使わない
× 「〇〇とのことですね」「〇〇をご希望ですね」（オウム返し）→ 使わない
× 「スモラにてお取り扱い可能か確認」→ 「募集状況確認させていただきます！！」を使う
× 「ご共有頂き」→ お客様に対しては「お送り頂き」を使う
× 「緊急連絡先設定可」→ 「緊急連絡先でご入居可能」を使う
× 「仲介手数料を割引」→ 「初期費用を最大限割引させていただきます」を使う
× 「少々お待ちください」→ 使わない
× 「まず〜、次に〜」（列挙構成）→ 使わない
× 「**テキスト**」のようなマークダウン太字 → LINEはマークダウン非対応。絶対に使わない
× 「〇〇さんはい！！」「〇〇さんかしこまりました！！」→ 冒頭が「はい！！」「かしこまりました！！」の場合は名前を置かない

━━━━━━━━━━━━━━━━━━━━
【不動産専門知識ルール — 誤ると致命的】
━━━━━━━━━━━━━━━━━━━━
【敷金・礼金・管理費の正しい理解】
・敷金は退去時に返還される預かり金 → 「敷金なしで初期費用が安い」は絶対禁止
・礼金は返還されない費用 → 礼金なしのみ初期費用削減として訴求可
・敷金・礼金が両方0円の場合のみ「敷金礼金なし」と書ける
・管理費は月額費用であり初期費用ではない → 「管理費なしで初期費用を抑えられる」は絶対禁止

【連帯保証人と緊急連絡先の違い — 混同厳禁】
・連帯保証人: 家賃不払い時に支払い義務が発生する法的責任あり。実印+印鑑証明書が必要
・緊急連絡先: 万が一の際に電話が入るだけ。支払い義務は一切なし

【号室番号の表記ルール】
・日本の号室は0から始まらない。「0906号室」等の先頭ゼロは必ず除去すること
× 0906号室 → ○ 906号室

━━━━━━━━━━━━━━━━━━━━
【情報の優先順位】
━━━━━━━━━━━━━━━━━━━━
① 予約送信待ちのAIXメッセージ（物件名・家賃・間取り・オススメポイントを最優先で読む）
② お客様の希望条件（DB）に記載のこだわり・条件を反映
③ 会話履歴（物件名・家賃・間取りなどの事実情報の補完のみ。文体・トーンは変えない）
④ 見つからない場合はそのまま or 「〇〇」のまま残す`;

// AIXテンプレートモード（isAixTemplate=trueのとき追加される静的セクション）
const AIX_TEMPLATE_MODE_SECTION = `

━━━━━━━━━━━━━━━━━━━━
【🔒 AIXテンプレートモード — 最優先・全ルールより上位】
━━━━━━━━━━━━━━━━━━━━
このテンプレートは「ベース文」です。テキスト全体を書き直すのではなく、テンプレートの各文を1対1で維持しながら、AIXで送った文から読み取った実際の物件情報を差し込む作業をしてください。

【情報源: 必ず「予約送信待ちのAIXメッセージ」から読む】
・物件名 → AIXメッセージに記載の物件名
・間取り・帖数・専有面積 → AIXメッセージから読み取る
・築年数・向き・階数 → AIXメッセージから読み取る
・家賃・初期費用（敷金礼金・礼金の有無） → AIXメッセージから読み取る
・物件の特徴・オススメポイント → AIXメッセージから読み取る（お客様条件や会話から作らない）
・AIXメッセージに記載がない項目はテンプレートのまま残す（でたらめな値を入れない）

【差し込む方法】
・テンプレートの各文の言い回し・語順はそのままにして、値の部分だけをAIXメッセージの値に差し替える
・お客様名プレースホルダー → 動的セクションの「お客様名」 + 「さん」
・「様」→「さん」

【絶対に変えてはいけないもの】
・各文の言い回し・語順・文末表現（テンプレートの文形をそのまま使う）
・文の構成・段落の並び・文数（追加も削除もしない）
・スモラの営業トーン・感嘆符の位置・絵文字

【禁止】
× テンプレートの文を別の言い方に書き換える（意味が同じでも別表現にしない）
× テンプレートにない新しい文・段落を追加する
× AIXメッセージに記載のない物件情報をお客様条件や会話から作り出す
× 会話のテキストや文体を参考にして文を変形させる
━━━━━━━━━━━━━━━━━━━━`;

// ─── RAG用embedding生成 ──────────────────────────────────────────────────────
async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      signal: AbortSignal.timeout(8_000),
      headers: {
        Authorization: "Bearer " + (process.env.OPENAI_API_KEY ?? "").replace(/\s/g, ""),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 2000) }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { data?: Array<{ embedding?: number[] }> };
    return data.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

// ─── リクエスト型 ────────────────────────────────────────────────────────────
type AdaptRequestBody = {
  templateText: string;
  templateCategory?: string;
  customerName?: string;
  conversationId?: string;          // AIX-META取得用
  conversationState?: string;
  recentMessages?: Array<{ sender: string; text: string; imageUrl?: string }>;
  customerConditions?: string;
  noEmoji?: boolean;
  soloEntry?: boolean;
  pendingScheduledMessages?: Array<{ text: string | null }>;
  vacatingDate?: { month: number; day: number } | null;
  staffMessagedToday?: boolean;
};

// ─── POST ────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let body: AdaptRequestBody;
  try {
    body = await req.json() as AdaptRequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const {
    templateText,
    templateCategory,
    customerName,
    conversationId,
    conversationState,
    recentMessages,
    customerConditions,
    noEmoji,
    soloEntry,
    pendingScheduledMessages,
    vacatingDate,
    staffMessagedToday,
  } = body;

  if (!templateText) {
    return NextResponse.json({ ok: false, error: "templateText is required" }, { status: 400 });
  }

  // テンプレート前処理（退去予定日・挨拶差し替え）
  let processedTemplateText = applyVacatingDateToTemplate(templateText, vacatingDate);
  processedTemplateText = applyGreetingSwap(processedTemplateText, staffMessagedToday ?? false);

  const isAixTemplate = templateCategory?.includes("【AIX】") ?? false;

  // ── 並列取得: AIX-META + 学習済みルール + 追加ルール ────────────────────
  type BrainMeta = {
    action?: string;
    closing_strategy?: string;
    reply_direction?: string;
    urgency_appropriate?: string;
    checkpoint_stage?: string;
  };

  const [convResult, dbRuleResult, learnedRulesResult] = await Promise.all([
    conversationId
      ? supabase.from("conversations").select("suggested_aix_meta").eq("id", conversationId).single()
      : Promise.resolve({ data: null }),
    supabase.from("ai_prompts").select("content").eq("key", "template_adapt_rules").single(),
    templateCategory
      ? supabase
          .from("adaptation_improvement_rules")
          .select("rule_text, confidence, example_count")
          .eq("category", templateCategory)
          .eq("is_active", true)
          .order("example_count", { ascending: false })
          .order("confidence", { ascending: false })
          .limit(5)
      : Promise.resolve({ data: null }),
  ]);

  const brainMeta = (convResult.data as { suggested_aix_meta?: BrainMeta } | null)?.suggested_aix_meta ?? null;
  const extraRules = (dbRuleResult.data as { content?: string } | null)?.content ?? "";
  const learnedRules = learnedRulesResult.data as Array<{ rule_text: string; example_count: number }> | null;

  // ── RAG: templateCategory + 最新顧客メッセージ + AIX-META で知識検索 ──────
  let ragSection = "";
  if (process.env.OPENAI_API_KEY) {
    const lastCustomerMsg = (recentMessages ?? [])
      .filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]")
      .slice(-1)[0]?.text ?? "";

    const ragQuery = [
      templateCategory ? `テンプレートカテゴリ: ${templateCategory}` : "",
      lastCustomerMsg ? `顧客メッセージ: ${lastCustomerMsg}` : "",
      brainMeta?.action          ? `推奨アクション: ${brainMeta.action}` : "",
      brainMeta?.closing_strategy ? `成約戦略: ${brainMeta.closing_strategy}` : "",
    ].filter(Boolean).join(" | ");

    if (ragQuery) {
      const emb = await generateEmbedding(ragQuery);
      if (emb) {
        const { data: ragRows } = await supabase.rpc("match_reply_knowledge", {
          query_embedding: emb,
          match_threshold: 0.72,
          match_count: 4,
        });
        if (Array.isArray(ragRows) && ragRows.length > 0) {
          ragSection =
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `【参考ナレッジ（状況に合った過去の知見）】\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            (ragRows as Array<{ content: string }>).map((r) => `・${r.content}`).join("\n") + "\n\n";
        }
      }
    }
  }

  // ── テキスト整形 ─────────────────────────────────────────────────────────
  const history = (recentMessages ?? [])
    .slice(-15)
    .map((m) => {
      const who = m.sender === "customer" ? "お客様" : "スモラ";
      if (m.text === "[画像]" || m.text === "[動画]") return `${who}: 【画像・資料を送付】`;
      if (!m.text) return null;
      return `${who}: ${m.text}`;
    })
    .filter(Boolean)
    .join("\n");

  const STATE_LABEL: Record<string, string> = {
    first_reply: "初回応対", condition_hearing: "条件ヒアリング",
    property_search: "物件探し中", property_recommendation: "物件提案中",
    viewing: "内覧調整", estimate_request: "見積依頼",
    availability_check: "空室確認", application: "申込中",
    screening: "審査中", contract: "契約中", closed_won: "成約済み",
  };
  const stateLabel = STATE_LABEL[conversationState || ""] || conversationState || "不明";

  const pendingSection = (pendingScheduledMessages ?? [])
    .map((m) => m.text ?? "").filter(Boolean).join("\n\n---\n\n");

  const recentCustomerRequests = (recentMessages ?? [])
    .filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]")
    .slice(-3).map((m) => m.text).join(" / ");

  // ── Block2（準静的・カテゴリ共通）: 学習済みルール + 追加ルール ─────────
  const learnedRulesText = (learnedRules && learnedRules.length > 0)
    ? `━━━━━━━━━━━━━━━━━━━━\n` +
      `【📚 このカテゴリで学習した改善ルール — 必ず守ること】\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `過去にスタッフがAI最適化後に繰り返し修正したパターンです。\n` +
      learnedRules.map((r, i) => `${i + 1}. ${r.rule_text}（${r.example_count}回確認済み）`).join("\n") + "\n\n"
    : "";

  // ── AIX-META セクション（動的）────────────────────────────────────────────
  const brainMetaSection = brainMeta
    ? `━━━━━━━━━━━━━━━━━━━━\n` +
      `【🧠 Brain戦略（AIX-META）— テンプレート適応の方向性】\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `推奨アクション: ${brainMeta.action || "-"}\n` +
      `成約戦略: ${brainMeta.closing_strategy || "-"}\n` +
      `返信方向: ${brainMeta.reply_direction || "-"}\n` +
      `緊急度: ${brainMeta.urgency_appropriate || "-"}\n` +
      `チェックポイント: ${brainMeta.checkpoint_stage || "-"}\n\n`
    : "";

  // ── 動的ユーザープロンプト ───────────────────────────────────────────────
  const userPrompt = [
    brainMetaSection,
    ragSection,
    learnedRulesText,
    extraRules ? `━━━━━━━━━━━━━━━━━━━━\n【追加ルール】\n━━━━━━━━━━━━━━━━━━━━\n${extraRules}\n\n` : "",
    `━━━━━━━━━━━━━━━━━━━━\n【お客様情報】\n━━━━━━━━━━━━━━━━━━━━`,
    `・お客様名: ${customerName || "〇〇"}さん（テンプレートの「アカウント名」「[お客様名]」はこの名前に置き換える）`,
    `・現在のフェーズ: ${stateLabel}`,
    customerConditions ? `・希望条件（DB）: ${customerConditions}` : "",
    noEmoji ? `・絵文字禁止モード: テンプレートに絵文字があっても全て削除すること` : "",
    "",
    pendingSection
      ? `━━━━━━━━━━━━━━━━━━━━\n【🔑 予約送信待ちのAIXメッセージ（物件名・家賃・オススメポイントはここから読む）】\n━━━━━━━━━━━━━━━━━━━━\n${pendingSection}\n`
      : "",
    `【お客様の希望条件確認（条件の事実把握のみ — 文体・語調への影響は一切なし）】\n${recentCustomerRequests || "なし"}`,
    "",
    `【会話履歴（物件情報の事実確認のみ — 文体・表現への影響は一切なし）】\n${history || "なし"}`,
    "",
    `━━━━━━━━━━━━━━━━━━━━\n【置き換えるテンプレート】\n━━━━━━━━━━━━━━━━━━━━\n${processedTemplateText}`,
    "",
    soloEntry
      ? `━━━━━━━━━━━━━━━━━━━━\n【1人入居モード — 厳守】以下のキーワードを含む行はすべて出力しない（完全に削除）：同居人・配偶者・同居者・家族構成・入居人数・お子様・子ども・子供・同居・ご家族\n━━━━━━━━━━━━━━━━━━━━\n`
      : "",
    `出力は置き換え後のテキストのみ。説明・前置き・補足コメントは一切書かない。`,
  ].filter(Boolean).join("\n");

  // ── Anthropic API (raw fetch + prompt cache 2層) ─────────────────────────
  const staticSystem = STATIC_ADAPT_SYSTEM + (isAixTemplate ? AIX_TEMPLATE_MODE_SECTION : "");
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").replace(/\s/g, "");

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(28_000),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: [
          // Block1: 全ユーザー共通の静的ルール（isAixTemplate + noEmoji で数バリアント）
          {
            type: "text",
            text: staticSystem,
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[templates/adapt] Anthropic error ${res.status}:`, errText.slice(0, 300));
      return NextResponse.json({ ok: false, error: `AI最適化エラー: ${res.status}` }, { status: 500 });
    }

    const data = await res.json() as {
      content?: Array<{ type: string; text?: string }>;
    };
    let adapted = data.content?.find((b) => b.type === "text")?.text?.trim() ?? templateText;
    adapted = stripRoomLeadingZeros(adapted);

    console.log(
      `[templates/adapt] category=${templateCategory || "-"} brainMeta=${brainMeta ? "ok" : "none"}` +
      ` rag=${ragSection ? "hit" : "miss"} aix=${isAixTemplate}`,
    );

    return NextResponse.json({ ok: true, adapted });
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI最適化エラー";
    console.error("[templates/adapt] error:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
