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
// - check-reply/route.ts    …… 送信時（スタッフ編集後）の再チェック。自動修正なし（runFinalCheckのみ）

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
  checkpointStage?: string | null; // brain実態フェーズ（conversationStageと乖離時に優先）
  sentPropertiesCount?: number;  // MEDIUM-2: 送付済み物件数（0=未送付）
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
    return ` (${new Date(new Date(iso).getTime() + 9 * 3600000).toISOString().slice(11, 16)} JST)`;
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
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  const days = ["日", "月", "火", "水", "木", "金", "土"];
  return `${jst.getUTCFullYear()}/${jst.getUTCMonth() + 1}/${jst.getUTCDate()}（${days[jst.getUTCDay()]}）${jst.getUTCHours()}:${String(jst.getUTCMinutes()).padStart(2, "0")} JST`;
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
- 住所・集合場所・集合時間の案内 → 違反
- 物件名・家賃・間取りの初出提示 → 違反 / 申込確定文・必要書類リスト → 違反
- 入居可能日・退去日の回答（希望時期を「聞く」のはOK、「答える」のはNG）→ 違反
- 「確認してご連絡します」の約束（AIX【確認します】と二重になる）→ 違反
禁止語彙：少々お待ちください / 申し訳ございません（審査落ち・物件消滅時）/ スモラ（※ただし「弊社の初期費用が安い理由」を説明する文脈で固有名詞として使用している場合は除外）/
名称未設定 / markdown太字 / AIX操作用語（「AIXボタン」等）の顧客向け文への混入 /
冒頭の書き出しとして「ご連絡ありがとうございます」「ご返信ありがとうございます」（お礼は挨拶ではない。冒頭の単独使用は禁止。本文中での自然なお礼はOK。※「〇〇さんご連絡頂きありがとうございます」「ご連絡いただきありがとうございます」等の「頂き/いただき」入りの形は初回返信の必須標準挨拶のため対象外・指摘しない）/
「〇〇さんご希望のご条件に合った〜」等のお客様を主語にした受け身表現（「あなたの条件に合うもの」という受け身姿勢。検出時 code=RULE_VIOLATION で報告）。ただし「〇〇周辺からご条件に合ったお部屋をピックアップして」等、スタッフが能動的に探す行動宣言の一部として使用している場合は対象外

code は次から選ぶこと:
AIX_BOUNDARY_VIEWING（内覧日時の提示）/ AIX_BOUNDARY_ESTIMATE（見積送付文・金額内訳）/
AIX_BOUNDARY_MEETING（住所・集合場所案内）/ AIX_BOUNDARY_PROPERTY（物件名・家賃・間取りの初出提示）/
AIX_BOUNDARY_APPLICATION（申込確定文・書類リスト）/ AIX_BOUNDARY_MOVEIN（入居可能日・退去日の回答）/
AIX_BOUNDARY_PROMISE（「確認してご連絡します」の二重宣言）/
【例外】管理会社への確認が必要な質問（空室状況・審査結果・入居可能日・設備詳細・ペット可否の管理会社判断等）に対する「確認してご連絡します」「管理会社に確認いたします」などは AIX_BOUNDARY_PROMISE に該当しません。
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
OK: 「御見積書を作成してお送りします」「最大限割引させていただいた御見積書を作成しお送りさせて頂きます！！」（金額なし・AIXシートが実際の数字を送る前提の宣言）
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
  const stageBlock = ctx.conversationStage
    ? `[STAGE]\n現在段階: ${ctx.conversationStage}${ctx.sentPropertiesCount !== undefined ? `\n送付済み物件数: ${ctx.sentPropertiesCount}件` : ""}${ctx.checkpointStage && ctx.checkpointStage !== ctx.conversationStage ? `\nフェーズ乖離: brain実態=${ctx.checkpointStage} DB=${ctx.conversationStage}。実態フェーズで判定すること` : ""}\n[/STAGE]\n`
    : "";
  const brainBaselineNote = ctx.brainMeta?.action
    ? `【Brain判定済み】Brain（Sonnet）がaction="${ctx.brainMeta.action}"（enforcement="${ctx.brainMeta.enforcement_level}"）と判定済みです。この判断に沿った返信かどうかを確認すること。絶対ルール違反・禁止語彙・明らかなミスのみ指摘し、Brain判定と整合している内容にはフラグを立てないこと。このアクションと矛盾しない返信内容であればSTAGE_SKIPは発行しないこと。\n\n`
    : "";
  const stable = `${ADVERSARIAL_PREAMBLE}

顧客の最新メッセージと返信文を突き合わせ、以下を検査してください。
1. 質問の取りこぼし：顧客の質問を全て列挙し、返信が各質問に具体的に答えているか。
   1つでも未回答なら missing として指摘（「確認します」だけで理由が無いものも未回答扱い）
   【例外】管理会社への確認が必要な質問（空室状況・審査結果・入居可能日・設備詳細・ペット可否の管理会社判断等）に対する「確認してご連絡します」「確認いたします」「確認して参ります」などの返答は正当な回答とみなし、MISSED_QUESTION を発行しないでください。
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
9. 主語混乱（SUBJECT_CONFUSION）：物件送付後にお客様が確認する場面（顧客が「確認します」等と述べた直後）で、スタッフが「確認でき次第すぐにご連絡させて頂きます」等の表現を使っていれば NG。ただし管理会社への確認（空室確認・交渉中）の文脈は除外。
10. 受け身文体（PASSIVE_ONLY）：全体的に受け身文体（〜いただければ・〜よろしいでしょうか・ご検討ください）のみで締まっていて、スタッフの能動的な行動宣言（〜いたします・〜させて頂きます等）が一切ない場合は NG。

code は次から選ぶこと:
MISSED_QUESTION（質問の取りこぼし）/ STAGE_MISMATCH（段階ミスマッチ）/
DOUBLE_DECLARATION（二重宣言・繰り返し）/ TIME_INVALID（実行不可能な時刻の約束）/
STAGE_SKIP（段階の前倒し）/ STAFF_REQUEST_OMITTED（スタッフ依頼の取りこぼし）/
WE_DO_MISSING（行動宣言なし）/ FILLER_GREETING（フィラー挨拶）/
SUBJECT_CONFUSION（主語混乱・PatternF4）/ PASSIVE_ONLY（受け身文体のみ）
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

【出力例9 - 問題なし（別の質問への確認約束）】
（顧客メッセージ:「駐車場はありますか？」→ 返信:「管理会社にご確認いたします。」）
→ issues: []

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
（内覧キャンセルへの返信: 「承知いたしました。またお気軽にご連絡ください。」）
→ issues: []

【各検査項目の細かい判断基準】

【1. 質問の取りこぼし（MISSED_QUESTION）】
発行しないケース:
- 管理会社への確認が必要な質問（空室状況・審査結果・入居可能日・設備詳細・ペット可否）に対する「確認してご連絡します」
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
発行しないケース:
- 「承知いたしました」「確認いたします」等の短い了解返信は行動宣言として十分
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

【各コードの典型的なfalse positiveと対処】
MISSED_QUESTION の誤発行を避けるべきケース:
- 顧客が複数の質問をしており、返信がその一部に「管理会社確認します」と答えている場合
  → 管理会社確認が必要な質問（空室・審査・ペット可否・設備詳細・入居可能日）は確認宣言のみで十分
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
- 「承知いたしました」「確認いたします」等の短い了解返信は行動宣言として十分なため発行しないこと
- 「いたします」「させて頂きます」が1文でも含まれていれば絶対に発行しないこと
- 短い了解・承認返信（3文以内の短い返信）は対象外として扱うこと
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
  // FP-04: 会話初期（情報源が薄い）は誤block防止のため FABRICATED 系を warning に格下げ
  // FABRICATED_PROPERTY も対象（初回は顧客が書いた物件名の表記ゆれを「写し間違い」と誤blockしやすいため）
  if (isEarlyConversation && (code === "FABRICATED_AMOUNT" || code === "FABRICATED_AVAILABILITY" || code === "FABRICATED_PROPERTY")) {
    return "warning";
  }
  if (pass === "rule_check" && code.startsWith("AIX_BOUNDARY")) return "block";
  if (pass === "anomaly_scan" && (code === "FABRICATED_AMOUNT" || code === "FABRICATED_AVAILABILITY")) return "block";
  if (code === "FABRICATED_PROPERTY" || code === "FABRICATED_DATE") return "block";
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
const BANNED_WORDS_DETERMINISTIC = ["スモラ", "名称未設定", "少々お待ちください", "**"];

// ─── メイン: 決定的プリチェック + 3パス並列チェック ──────────────────────────
// 絶対にthrowしない（全pass失敗でも issues=[] / passes_completed=[] の fail-open 結果を返す）
export async function runFinalCheck(draft: string, ctx: FinalCheckContext, sonnetTimeoutMs = 30000): Promise<CheckResult> {
  const started = Date.now();
  const issues: CheckIssue[] = [];
  const draftNorm = normalizeForMatch(draft);

  // ── HIGH-3: 決定的禁止語彙スキャン（Haiku前・確実に検出）──
  for (const word of BANNED_WORDS_DETERMINISTIC) {
    if (draft.includes(word)) {
      issues.push({
        pass: "rule_check",
        severity: "block",
        code: "BANNED_WORD",
        message: `禁止語彙「${word}」が含まれています`,
        evidence: word,
        suggestion: `「${word}」を削除してください`,
      });
    }
  }

  // ── 時刻ベース決定的チェック: 18時以降の「本日中に」は実行不可能な約束 ──
  for (const sameDayPhrase of ["本日中に", "今日中に", "今日のうちに", "本日のうちに"]) {
    if (draft.includes(sameDayPhrase)) {
      const jstHour = new Date(Date.now() + 9 * 3600 * 1000).getUTCHours();
      if (jstHour >= 18) {
        const idx = draft.indexOf(sameDayPhrase);
        const start = Math.max(0, idx - 10);
        const end = Math.min(draft.length, idx + sameDayPhrase.length + 10);
        issues.push({
          pass: "context_check",
          // LLM版TIME_INVALID（assignSeverity）と対称: 自動送信のみblock・スタッフ確認経路はwarning
          severity: ctx.isAutoSend ? "block" : "warning",
          code: "TIME_INVALID_HONIJITSU",
          message: `18時以降のため「${sameDayPhrase}」は実行不可能な約束です`,
          evidence: draft.slice(start, end),
          // 「ご確認し」を含めない（CONFIRM_PROMISE_REガードに掛かり修正が破棄されるため）
          suggestion: "「明日一番にご連絡させて頂きます」等に変更してください",
        });
      }
      break;
    }
  }

  // ── 3パス並列チェック（rule_check・anomaly_scan=Haiku / context_check=Sonnet）──
  // context_check のみ Sonnet: 10種の複雑な会話理解が必要で誤検知が revision 誤発火に直結するため
  const passes: Array<{ pass: CheckPass; prompt: PromptContent; model: string }> = [
    { pass: "rule_check",    prompt: buildRuleCheckPrompt(draft, ctx),    model: MODEL_CHECK_FAST },
    { pass: "anomaly_scan",  prompt: buildAnomalyScanPrompt(draft, ctx),  model: MODEL_CHECK_FAST },
    { pass: "context_check", prompt: buildContextCheckPrompt(draft, ctx), model: MODEL_CHECK_DEEP },
  ];
  const settled = await Promise.allSettled(passes.map((p) => callSonnet(p.prompt, sonnetTimeoutMs, 2400, p.model)));

  const passesCompleted: CheckPass[] = [];

  settled.forEach((r, i) => {
    const pass = passes[i].pass;
    if (r.status !== "fulfilled") {
      // fail-open: 失敗passは passes_completed に載せず監査ログのみ
      console.warn(`[final-check] ${pass} 失敗（fail-open）:`, r.reason instanceof Error ? r.reason.message : String(r.reason));
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

【接地修正における判断優先順位】
修正内容の根拠は以下の優先順位で選択すること:
1. [RULES]（DBに登録された会社ルール・禁止語彙）— 最優先。社内ルールに反する表現は必ず除去する。
2. [CHECKPOINT]（確認済み事実）— 物件の具体情報はここのみを根拠とする。ここにない数値は書かない。
3. [BRAIN_META]（返信の方向性・フェーズガイド）— トーンや返信の目的はここに従う。
4. 一般的な礼儀・自然な日本語 — 上記に矛盾しない範囲でのみ使用可。

【AIX境界線の再確認】
AIXボタン（物件送付・見積提示・内見日程調整等の具体的なアクション）で対応すべき内容は
テキスト返信に含めてはならない。AIX_BOUNDARY指摘がある場合は当該宣言文を削除し、以下の形で締める:
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
- 「修正後：」「以下修正版です」等の前置きを出力する

修正後の文章のみを出力してください（説明・前置き不要）。`;

function buildSonnetRevisionPrompt(draft: string, issues: CheckIssue[], ctx: FinalCheckContext): PromptBlock[] {
  const brainNote = ctx.brainContextJson
    ? `\n[BRAIN_META]（返信の目指すべき方向性・修正後もこの方向性を維持すること）\n${ctx.brainContextJson}\n[/BRAIN_META]\n`
    : "";
  const customerMsgNote = ctx.lastCustomerMessage
    ? `\n[CUSTOMER_MESSAGE]（この返信の宛先：顧客の最新メッセージ。MISSED_QUESTION/STAGE_MISMATCH指摘の修正はこの内容に沿って行うこと）\n${ctx.lastCustomerMessage.slice(0, 1500)}\n[/CUSTOMER_MESSAGE]\n`
    : "";
  const historyNote = ctx.recentMessages?.length
    ? `\n[HISTORY]（直近会話履歴・最新5件）\n${formatHistory(ctx.recentMessages, 5)}\n[/HISTORY]\n`
    : "";
  const dynamic = `[ISSUES]
${issues.map((i) => `- [${i.code}] ${i.message}（該当箇所:「${i.evidence}」${i.suggestion ? ` / 修正案: ${i.suggestion}` : ""}）`).join("\n")}
[/ISSUES]
${customerMsgNote}${historyNote}${brainNote}
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
    if (revised.length < draft.length * 0.2 || revised.length > draft.length * 2) return null;
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
const CONFIRM_PROMISE_RE = /確認[^\n。]{0,20}ご連絡(?:いた|させて頂)(?!ください)/;

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

const DIFF_RECHECK_CODES = `AIX_BOUNDARY_VIEWING / AIX_BOUNDARY_ESTIMATE / AIX_BOUNDARY_MEETING / AIX_BOUNDARY_PROPERTY /
AIX_BOUNDARY_APPLICATION / AIX_BOUNDARY_MOVEIN / AIX_BOUNDARY_PROMISE / AIX_BOUNDARY_DB /
BANNED_WORD / RULE_VIOLATION / FABRICATED_AMOUNT / FABRICATED_AVAILABILITY / FABRICATED_PROPERTY /
FABRICATED_DATE / FABRICATED_NAME / FABRICATED_POLICY / MISSED_QUESTION / STAGE_MISMATCH /
DOUBLE_DECLARATION / TIME_INVALID / STAGE_SKIP`;

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
      code === "STAGE_SKIP" || code.startsWith("TIME_INVALID")) return "context_check";
  return "rule_check"; // AIX_BOUNDARY_* / BANNED_WORD / RULE_VIOLATION / 不明code
}

const DIFF_RECHECK_MAX_TOKENS = 1000; // フル再スキャン（2400）の半分以下

async function runDiffRecheck(
  revised: string,
  check1Issues: CheckIssue[],
  ctx: FinalCheckContext,
  timeoutMs = 15000,
): Promise<CheckResult> {
  const started = Date.now();
  const issues: CheckIssue[] = [];
  const draftNorm = normalizeForMatch(revised);

  // ── 決定的チェックは修正版にも常時適用（runFinalCheckと同一。LLM不要・約0ms）──
  for (const word of BANNED_WORDS_DETERMINISTIC) {
    if (revised.includes(word)) {
      issues.push({
        pass: "rule_check",
        severity: "block",
        code: "BANNED_WORD",
        message: `禁止語彙「${word}」が含まれています`,
        evidence: word,
        suggestion: `「${word}」を削除してください`,
      });
    }
  }
  for (const sameDayPhrase of ["本日中に", "今日中に", "今日のうちに", "本日のうちに"]) {
    if (revised.includes(sameDayPhrase)) {
      const jstHour = new Date(Date.now() + 9 * 3600 * 1000).getUTCHours();
      if (jstHour >= 18) {
        const idx = revised.indexOf(sameDayPhrase);
        const start = Math.max(0, idx - 10);
        const end = Math.min(revised.length, idx + sameDayPhrase.length + 10);
        issues.push({
          pass: "context_check",
          // LLM版TIME_INVALID（assignSeverity）と対称: 自動送信のみblock・スタッフ確認経路はwarning
          severity: ctx.isAutoSend ? "block" : "warning",
          code: "TIME_INVALID_HONIJITSU",
          message: `18時以降のため「${sameDayPhrase}」は実行不可能な約束です`,
          evidence: revised.slice(start, end),
          // 「ご確認し」を含めない（CONFIRM_PROMISE_REガードに掛かり修正が破棄されるため）
          suggestion: "「明日一番にご連絡させて頂きます」等に変更してください",
        });
      }
      break;
    }
  }

  // 差分検証の対象: meta（PARTIALLY_UNCHECKED）/ UNCHECKED_AUTO_SEND はテキスト修正で
  // 解消できないissueなので除外（従来もrevision対象から除外していたものと同じ）
  const targets = check1Issues.filter((i) => i.pass !== "meta" && i.code !== "UNCHECKED_AUTO_SEND");

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
    // 成功: Check1（全3パス由来）のissueを全て再検証済み → 互換のため全3パス完走として記録
    return {
      ok: !issues.some((i) => i.severity === "block"),
      issues,
      passes_completed: ["rule_check", "anomaly_scan", "context_check"],
      elapsed_ms: Date.now() - started,
      checked_text_hash: await sha1(revised.trim()),
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
  const check1 = await runFinalCheck(draft, ctx);
  checkIterations++;
  check1.revision_count = 0;
  if (check1.issues.length === 0) return { finalDraft: draft, finalCheck: check1 };

  // ── FABRICATED_* 照合検証: 本当にハルシネーションかを確認し clearedFacts を構築 ──
  const fabricatedIssues = check1.issues.filter(
    (i) => i.pass === "anomaly_scan" && i.code.startsWith("FABRICATED_") && i.evidence
  );
  let ctxForRecheck = ctx;
  if (fabricatedIssues.length > 0 && budgetMs - (Date.now() - started) > 8000) {
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
        (!i.evidence || draftNormW.includes(normalizeForMatch(i.evidence)))
    );
    if (passableWarnIssues.length === 0) return { finalDraft: draft, finalCheck: check1 };
    const revised = await runGroundedRevision(draft, passableWarnIssues, ctx, REVISION_MS);
    if (!revised) return { finalDraft: draft, finalCheck: check1 };

    // (3) 決定的プリスキャン（約0ms）: 禁止語彙、および修正で新規挿入された
    //     「確認して…ご連絡」系の句（AIX_BOUNDARY_PROMISE と正面衝突）を検出したら即破棄
    if (BANNED_WORDS_DETERMINISTIC.some((w) => revised.includes(w))) {
      return { finalDraft: draft, finalCheck: check1 };
    }
    if (CONFIRM_PROMISE_RE.test(revised) && !CONFIRM_PROMISE_RE.test(draft)) {
      return { finalDraft: draft, finalCheck: check1 };
    }

    // (4) 差分再チェック（check1 + recheck = 計2チェックで MAX_CHECK_ITERATIONS=2 と整合）
    //     Check1のissue一覧を引き継ぎ、修正版で「解決済みか・新規問題が無いか」だけを1パスで検証
    const recheck = await runDiffRecheck(revised, check1.issues, ctxForRecheck);
    checkIterations++;

    // (5) 採用条件は3つのAND:
    //     a. 差分検証が完走（成功時 passes_completed に全3パスが記録される。失敗時は空=不採用）
    //     b. block 0件（warning修正がblock級違反を新規挿入していないこと）
    //     c. warning件数が check1 以下（非悪化）
    const allPasses: CheckPass[] = ["rule_check", "anomaly_scan", "context_check"];
    const fullyVerified = allPasses.every((p) => recheck.passes_completed.includes(p));
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
        (!i.evidence || draftNormB.includes(normalizeForMatch(i.evidence)))
    );
    if (passableBlockIssues.length === 0) break;
    const revised = await runGroundedRevision(currentDraft, passableBlockIssues, ctx, REVISION_MS);
    if (!revised) break; // 修正失敗/ガード違反 → give up gracefully
    // CONFIRM_PROMISE_RE ガード（blockパス・warningパスと対称）
    if (CONFIRM_PROMISE_RE.test(revised) && !CONFIRM_PROMISE_RE.test(currentDraft)) break;

    // 決定的プリフィルタ: block evidence が1つも消えていない修正は無効（再チェック2.5sを節約）
    const revisedNorm = normalizeForMatch(revised);
    if (blocks.filter((b) => b.evidence).every((b) => revisedNorm.includes(normalizeForMatch(b.evidence)))) break;

    // ── チェック2回目: 差分再チェック（Check1のissueを引き継ぎ修正版を検証。未検証の文章は絶対に出さない）──
    const recheck = await runDiffRecheck(revised, currentCheck.issues, ctxForRecheck);
    checkIterations++;
    recheck.revised_text = revised;

    // FN-003: 採用条件は差分検証の完走確認（成功時 passes_completed に全3パス記録・失敗時は空）
    const allPasses: CheckPass[] = ["rule_check", "anomaly_scan", "context_check"];
    const verified = allPasses.every((p) => recheck.passes_completed.includes(p));
    if (!verified) break; // 差分再チェック失敗 → 修正版は未検証なので不採用（fail-open）
    revisionCount++;

    const newBlocks = recheck.issues.filter((i) => i.severity === "block");
    if (newBlocks.length < blocks.length) {
      // 改善（0件=クリーン / 減少=部分改善）→ 修正版がベスト草稿
      bestDraft = revised;
      bestCheck = recheck;
    }
    // 改善なし（同数以上）→ best は据え置き（元ドラフトをスタッフに見せる）
    currentDraft = revised;
    currentCheck = recheck;
  }

  bestCheck.revision_count = revisionCount;
  if (bestCheck.issues.some((i) => i.severity === "block")) {
    bestCheck.revision_exhausted = true; // blockが残った → スタッフ手動確認必須
  }
  return { finalDraft: bestDraft, finalCheck: bestCheck };
}
