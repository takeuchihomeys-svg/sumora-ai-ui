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
// - generate-reply/route.ts …… 生成時フルチェック + 警告のみなら自動修正
// - check-reply/route.ts    …… 送信時（スタッフ編集後）の再チェック。自動修正なし

export type CheckPass = "rule_check" | "anomaly_scan" | "context_check";
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
}

export interface FinalCheckContext {
  dbRules?: string;               // ai_prompt_rules の注入文字列（fetchPromptRules の戻り値）
  recentMessages?: Array<{ sender: string; text: string; isAix?: boolean; createdAt?: string }>;
  lastCustomerMessage?: string;   // 顧客の最新メッセージ
  step1Json?: string;             // generate-reply Step1 分析JSON（check-reply では省略可）
  staffSourceText?: string;       // スタッフ由来ソース（AIX原文・希望条件等）
  checkpointFacts?: string;      // conversation_checkpoints 最新summary — 確認済み事実（最高権威）
  customerConditionsDb?: string; // property_customers のDB保存顧客条件
}

// ─── SHA-1（送信時のハッシュ一致判定用。Web Crypto はNode18+/ブラウザ両対応）──
export async function sha1(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── 確証バイアス対策の共通前文（「良いか確認して」は絶対に使わない）──────────
const ADVERSARIAL_PREAMBLE = `この返信文は外部のAIが書いたものです。あなたの仕事は「この文章には必ず誤りが含まれている」
という前提で誤りを探し出すことです。書いた本人は自分の間違いに気づけません。あなたは
赤の他人として、粗探しをする校閲者の目で読んでください。
指摘には必ず本文からの引用（evidence）を付けること。引用できない指摘は出力しないこと。
本当に1件も見つからない場合のみ issues を空配列にしてください。`;

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

// ─── Haiku呼び出し（raw fetch・Vision実装と同パターン・SDK依存なし）────────────
async function callHaiku(prompt: string, timeoutMs: number): Promise<RawIssue[]> {
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").replace(/\s/g, "");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 600,
      temperature: 0,
      output_config: { format: { type: "json_schema", schema: ISSUE_SCHEMA } },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`final-check haiku HTTP ${res.status}`);
  const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text ?? "";
  const parsed = JSON.parse(text) as { issues?: RawIssue[] };
  return Array.isArray(parsed.issues) ? parsed.issues : [];
}

// ─── コンテキスト整形ヘルパー ───────────────────────────────────────────────
function formatHistory(msgs: FinalCheckContext["recentMessages"], limit: number): string {
  if (!msgs || msgs.length === 0) return "（履歴なし）";
  return msgs
    .slice(-limit)
    .map((m) => `${m.sender === "customer" ? "お客様" : "スタッフ"}: ${(m.text || "").slice(0, 300)}`)
    .join("\n");
}

function formatStaffMessages(msgs: FinalCheckContext["recentMessages"], limit: number): string {
  if (!msgs || msgs.length === 0) return "（なし）";
  const staff = msgs.filter((m) => m.sender === "staff").slice(-limit);
  if (staff.length === 0) return "（なし）";
  return staff.map((m) => `スタッフ: ${(m.text || "").slice(0, 300)}`).join("\n");
}

function nowJstString(): string {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  const days = ["日", "月", "火", "水", "木", "金", "土"];
  return `${jst.getUTCFullYear()}/${jst.getUTCMonth() + 1}/${jst.getUTCDate()}（${days[jst.getUTCDay()]}）${jst.getUTCHours()}:${String(jst.getUTCMinutes()).padStart(2, "0")} JST`;
}

// ─── Pass 1: 前頭前野（ルール照合 / rule_check）────────────────────────────────
function buildRuleCheckPrompt(draft: string, ctx: FinalCheckContext): string {
  return `${ADVERSARIAL_PREAMBLE}

以下はこの会社の絶対ルール一覧です。返信文が各ルールに違反していないか、1つずつ照合してください。
特に「通常返信AIは宣言のみ、実行はAIX」の境界線：
- 内覧の具体的な候補日時（「8/7（木）14:00〜」等）を提示 → 違反
- 見積書の送付文・金額内訳 → 違反 / 住所・集合場所・集合時間の案内 → 違反
- 物件名・家賃・間取りの初出提示 → 違反 / 申込確定文・必要書類リスト → 違反
- 入居可能日・退去日の回答（希望時期を「聞く」のはOK、「答える」のはNG）→ 違反
- 「確認してご連絡します」の約束（AIX【確認します】と二重になる）→ 違反
禁止語彙：少々お待ちください / 申し訳ございません（審査落ち・物件消滅時）/ スモラ /
名称未設定 / markdown太字 / AIX操作用語（「AIXボタン」等）の顧客向け文への混入

code は次から選ぶこと:
AIX_BOUNDARY_VIEWING（内覧日時の提示）/ AIX_BOUNDARY_ESTIMATE（見積送付文・金額内訳）/
AIX_BOUNDARY_MEETING（住所・集合場所案内）/ AIX_BOUNDARY_PROPERTY（物件名・家賃・間取りの初出提示）/
AIX_BOUNDARY_APPLICATION（申込確定文・書類リスト）/ AIX_BOUNDARY_MOVEIN（入居可能日・退去日の回答）/
AIX_BOUNDARY_PROMISE（「確認してご連絡します」の二重宣言）/ BANNED_WORD（禁止語彙）/ RULE_VIOLATION（その他ルール違反）

[RULES]
${(ctx.dbRules || "（DBルールなし — 上記の境界線・禁止語彙のみで照合）").slice(0, 8000)}
[/RULES]
[REPLY]
${draft}
[/REPLY]`;
}

// ─── Pass 2: 前帯状回（異常検知 / anomaly_scan）────────────────────────────────
function buildAnomalyScanPrompt(draft: string, ctx: FinalCheckContext): string {
  return `${ADVERSARIAL_PREAMBLE}

返信文の中の「事実の主張」をすべて抽出し、それぞれについて「この事実はどこから来たのか」を
下の情報源と照合してください。どの情報源にも根拠が無い事実は、AIの捏造（ハルシネーション）です。
最優先で疑うもの：
1. 円・万円の金額（家賃・敷金・礼金・初期費用・保証料）— 情報源に同じ数字が無ければ捏造
2. 空室確認の結果（「空室でした」「埋まりました」「〇月〇日から入居可能」）— 管理会社に
   確認した事実が情報源に無ければ捏造
3. 物件名・号室・駅名・路線名 — 情報源と一字一句照合。顧客の条件数字の写し間違い
   （「13〜17万」→「3〜17万」等）も捏造扱い
4. 日付・曜日・時刻 / 顧客の名前（情報源上の名前と一致するか。「名称未設定」は名前ではない）
5. 会社の制度の説明（仲介手数料は2,980円固定。「手数料割引」は誤り。日割家賃は入居日が
   遅いほど安い）

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

[CHECKPOINTS]
${(ctx.checkpointFacts || "なし").slice(0, 2000)}
[/CHECKPOINTS]
[CUSTOMER_CONDITIONS]
${(ctx.customerConditionsDb || "なし").slice(0, 1000)}
[/CUSTOMER_CONDITIONS]
[HISTORY]
${formatHistory(ctx.recentMessages, 10)}
[/HISTORY]
[SOURCE]
${(ctx.staffSourceText || "なし").slice(0, 3000)}
[/SOURCE]
[REPLY]
${draft}
[/REPLY]`;
}

// ─── Pass 3: バグ探し思考（文脈・網羅性 / context_check）──────────────────────
function buildContextCheckPrompt(draft: string, ctx: FinalCheckContext): string {
  return `${ADVERSARIAL_PREAMBLE}

顧客の最新メッセージと返信文を突き合わせ、以下を検査してください。
1. 質問の取りこぼし：顧客の質問を全て列挙し、返信が各質問に具体的に答えているか。
   1つでも未回答なら missing として指摘（「確認します」だけで理由が無いものも未回答扱い）
2. 段階ミスマッチ：退去予定・入居中物件への内覧提案 / 内覧前なのに感想を聞く /
   キャンセル意思への物件提案 / 既にDBにある条件の聞き返し / 既出物件の再提案
3. 二重宣言：直近のスタッフ送信と同じ約束・お礼・挨拶・説明の繰り返し
   （「ピックアップしてお送りします」の再宣言、同日2回目の挨拶、お礼の二重等）
4. 時刻の妥当性：現在 ${nowJstString()} 。18時以降・営業時間外に「本日中に管理会社へ確認」等の
   実行不可能な約束をしていないか

code は次から選ぶこと:
MISSED_QUESTION（質問の取りこぼし）/ STAGE_MISMATCH（段階ミスマッチ）/
DOUBLE_DECLARATION（二重宣言・繰り返し）/ TIME_INVALID（実行不可能な時刻の約束）

[CUSTOMER_MESSAGE]
${(ctx.lastCustomerMessage || "（不明）").slice(0, 1500)}
[/CUSTOMER_MESSAGE]
[ANALYSIS]
${(ctx.step1Json || "なし").slice(0, 2500)}
[/ANALYSIS]
[RECENT_STAFF_MESSAGES]
${formatStaffMessages(ctx.recentMessages, 5)}
[/RECENT_STAFF_MESSAGES]
[REPLY]
${draft}
[/REPLY]`;
}

// ─── severity判定: LLMは見つける・コードが裁く（決定的マップ）────────────────
function assignSeverity(pass: CheckPass, code: string): CheckSeverity {
  if (pass === "rule_check" && code.startsWith("AIX_BOUNDARY")) return "block";
  if (pass === "anomaly_scan" && (code === "FABRICATED_AMOUNT" || code === "FABRICATED_AVAILABILITY")) return "block";
  return "warning";
}

// evidence実在チェック用の正規化（空白差を無視）
function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, "");
}

// ─── メイン: 3パス並列チェック ─────────────────────────────────────────────
// 絶対にthrowしない（全pass失敗でも issues=[] / passes_completed=[] の fail-open 結果を返す）
export async function runFinalCheck(draft: string, ctx: FinalCheckContext): Promise<CheckResult> {
  const started = Date.now();
  const passes: Array<{ pass: CheckPass; prompt: string }> = [
    { pass: "rule_check", prompt: buildRuleCheckPrompt(draft, ctx) },
    { pass: "anomaly_scan", prompt: buildAnomalyScanPrompt(draft, ctx) },
    { pass: "context_check", prompt: buildContextCheckPrompt(draft, ctx) },
  ];
  const settled = await Promise.allSettled(passes.map((p) => callHaiku(p.prompt, 2500)));

  const issues: CheckIssue[] = [];
  const passesCompleted: CheckPass[] = [];
  const draftNorm = normalizeForMatch(draft);

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
      let severity = assignSeverity(pass, code);
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

  return {
    ok: !issues.some((i) => i.severity === "block"),
    issues,
    passes_completed: passesCompleted,
    elapsed_ms: Date.now() - started,
    checked_text_hash: await sha1(draft.trim()),
  };
}

// ─── 自動修正（generate-reply時のみ・warningのみの場合に限る）─────────────────
// 失敗・タイムアウト・破壊的書き換えは null を返す（呼び出し元は元ドラフトを維持）
export async function runAutoRevision(draft: string, issues: CheckIssue[]): Promise<string | null> {
  try {
    const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").replace(/\s/g, "");
    const prompt = `以下のLINE返信文について、指摘された問題点のみを修正してください。
以下の指摘のみを修正し、それ以外は一字も変えないこと。
修正後の全文のみを出力すること（説明・前置き・引用符は一切不要）。

[指摘]
${issues.map((i) => `- ${i.message}（該当箇所: 「${i.evidence}」${i.suggestion ? ` / 修正案: ${i.suggestion}` : ""}）`).join("\n")}
[/指摘]
[返信文]
${draft}
[/返信文]`;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(4000),
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 1500,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { content?: Array<{ type: string; text?: string }>; stop_reason?: string };
    if (data.stop_reason === "max_tokens") return null; // 尻切れ修正文は使わない
    const revised = (data.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text ?? "").trim();
    if (!revised) return null;
    // 破壊的書き換えガード: 元の50%未満・200%超は「指摘のみ修正」から逸脱しているとみなし破棄
    if (revised.length < draft.length * 0.5 || revised.length > draft.length * 2) return null;
    return revised;
  } catch {
    return null;
  }
}
