import { NextRequest, NextResponse } from "next/server";

// ─── POST /api/suggest-template ──────────────────────────────────────────────
// 会話履歴 + AIXテンプレート一覧から、次に送るべきテンプレートTOP3をAIが選定する。
// generate-reply と同じ raw-fetch パターン（SDK不使用・環境変数キー・空白除去）。
// claude-sonnet-5 の制約: temperature/top_p/top_k は送らない（400になる）。
// thinking は省略 = adaptive（このランキングタスクにはそのままでOK）。
// output_config.format (json_schema) で構造化JSON出力を保証（regex抽出不要）。

// ─── リクエスト/レスポンス型 ─────────────────────────────────────────────────
interface SuggestTemplateRequest {
  conversationId?: string;          // ログ用途のみ
  conversationState?: string;       // 生ステータス（サーバー側で5段階に正規化）
  customerName?: string;            // プレースホルダ認識用
  lastCustomerMsg?: string;         // お客様の最新メッセージ（省略時は messages から抽出）
  currentAixAction?: string;        // 現在サジェスト中のAIXアクション（任意）
  messages: Array<{
    sender: string;                 // "staff" | "customer"
    text: string;
    imageUrl?: string;
    isAix?: boolean;
  }>;
  templates: Array<{
    id: string;
    category: string;               // 例: "物件確認した【AIX】"
    label: string;
    text: string;
  }>;
}

interface SuggestCandidate {
  templateId: string;
  title: string;   // = template label（表示用にサーバーが付与）
  body: string;    // サーバーが見たtruncate済み本文（クライアントはSSoTから再解決推奨）
  reason: string;  // 1行日本語: なぜこの状況に合うか
  rank: number;    // 1 | 2 | 3
}

interface SuggestTemplateResponse {
  ok: boolean;
  candidates: SuggestCandidate[];
  noMatch?: boolean;
  noMatchReason?: string;
  error?: string;
}

// ─── 状態正規化（generate-reply の STATE_ALIAS と同一ロジック）──────────────
const ALLOWED_STATES = new Set([
  "first_reply", "hearing", "proposing", "applying", "closed_won",
]);
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

// ─── 会話履歴の整形（generate-reply lines 1537-1588 の簡易版）────────────────
type Msg = SuggestTemplateRequest["messages"][number];
const isImageOnlyMsg = (m: Msg) =>
  m.text === "[画像]" || m.text === "[動画]" || (!m.text && !!m.imageUrl);

function formatHistory(messages: Msg[]): string {
  return messages
    .map((m, i, arr) => {
      const who = m.sender === "customer" ? "お客様" : "スモラ";
      if (m.sender === "staff" && m.isAix) {
        if (isImageOnlyMsg(m)) return `${who}: 【AIX物件提案の資料画像を送付した】`;
        if (m.text) return `${who}: (AI提案)「${m.text}」`;
        return null;
      }
      if (isImageOnlyMsg(m)) {
        if (m.sender === "customer") return `${who}: 【画像を送ってきた】`;
        // スタッフ画像: 前後の文脈テキストからラベルを推定
        const nearby = arr.slice(Math.max(0, i - 5), i + 4).map((x) => x?.text || "").join(" ");
        if (/見積|初期費用|礼金/.test(nearby)) return `${who}: 【見積書を送付した】`;
        if (/確認|空室|空き|募集/.test(nearby)) return `${who}: 【空室確認済み・物件資料を送付した】`;
        return `${who}: 【物件資料を送付した】`;
      }
      if (!m.text) return null;
      return `${who}: ${m.text}`;
    })
    .filter(Boolean)
    .join("\n");
}

// 孤立サロゲート（LINE絵文字等）をU+FFFDに置換してAnthropicへのHTTP 400を防止
const sanitizeSurrogates = (s: string) =>
  s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");

// ─── システムプロンプト（byte-stable — 会話固有情報は含めない）──────────────
const SELECTION_SYSTEM = `あなたは不動産賃貸仲介『スモラ』のLINE営業テンプレート選定AIです。会話履歴とAIXテンプレート一覧から、次にスタッフが送るべきテンプレートを最大3件、適合度順に選びます。

【選定ルール（優先度順）】

1. 【状況分析を先に行う】お客様の最新メッセージ・感情状態（不安・急ぎ・比較検討中・信頼済み等）・会話フェーズ（first_reply=初回接触/hearing=条件ヒアリング/proposing=物件案内中/applying=申込検討）・お客様が本当に求めているもの（物件情報・スケジュール・安心感等）・返信の目的（次のアクションへ誘導・信頼構築・情報提供・クロージング）を内心で特定してから選ぶ。成約への一手（closing_strategy）に合致するテンプレを最上位に。

2. 【パターンラダー・上から先勝ち】最初に一致したものだけ適用:
① キャンセル・辞退・他決の意思表示 → 受諾系のみ（引き止め・アップセル禁止）
② スタッフが「確認します」「空室確認中」等の確認中 → 短い承諾/W系
②' スタッフが直前に「ピックアップしてお送りします」と約束済み＋お客様が感謝・承諾のみ → 短い承諾系のみ。ピックアップ再宣言テンプレは禁止
②'' 会話が締め済みでお客様が締め挨拶・社交辞令のみ → 締め系
②''' 「拝見します」等これから見る未来形の意思表示のみ → 歓迎のみ（感想を聞くテンプレ禁止）
③ 条件変更・エリア拡大・家賃変更の希望 → 即行動宣言テンプレ（質問系テンプレは禁止）
④ 内覧日程が確定している・内覧後 → 内覧系
⑤ 複数物件で比較・迷っている → 判断軸提示系
⑥ 見積書・初期費用の質問 → 作成宣言系のみ
⑦ 設備・条件・審査の詳細質問 → 回答系
⑧ 物件を気に入っている・前向きな反応 → 内覧誘導系
⑨ 検討中・様子見 → 追客系

3. 【AIXカテゴリ整合】各テンプレのカテゴリ名（物件確認した/見積書送る/内覧へ！等）は「スタッフがその作業を完了・実行した直後に送る」前提。履歴上その作業の文脈がないカテゴリは選ばない。例: 空室確認を頼まれていないのに『物件確認した【AIX】』を選ばない。

4. 【反復禁止】直前のスタッフ発言と同じ情報・宣言を繰り返すテンプレは除外。

5. 【事実安全】履歴で確認されていない空室・入居日・物件詳細を断言するテンプレは、該当確認済みの文脈がない限り除外。

6. 【迷い対応】「考えます」「また連絡します」系の返答には、希少性・申込後押し・具体的行動約束を含むテンプレを優先。

7. 該当が3件未満なら少なく返す。1件も適合しなければ no_match=true とし、理由を1行で。捏造ID禁止 — 一覧にあるIDのみ返すこと。

reason は40字以内の日本語で、テンプレの一般的用途ではなく「この状況に合う根拠」を書く（例:「お客様が空室確認の結果待ちで、確認完了を伝える局面のため」）。`;

// ─── 構造化出力スキーマ ──────────────────────────────────────────────────────
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["candidates", "no_match", "no_match_reason"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["templateId", "reason", "rank"],
        properties: {
          templateId: { type: "string" },
          reason: { type: "string" },
          rank: { type: "integer", enum: [1, 2, 3] },
        },
      },
    },
    no_match: { type: "boolean" },
    no_match_reason: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
} as const;

// ─── POST ────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  // generate-reply line 1364 と同じガード
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { ok: false, candidates: [], error: "ANTHROPIC_API_KEY not set" } satisfies SuggestTemplateResponse,
      { status: 500 },
    );
  }

  let body: SuggestTemplateRequest;
  try {
    body = await req.json() as SuggestTemplateRequest;
  } catch {
    return NextResponse.json(
      { ok: false, candidates: [], error: "Invalid request body" } satisfies SuggestTemplateResponse,
      { status: 400 },
    );
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const templates = Array.isArray(body.templates) ? body.templates : [];
  if (messages.length === 0) {
    return NextResponse.json(
      { ok: false, candidates: [], error: "messages required" } satisfies SuggestTemplateResponse,
      { status: 400 },
    );
  }
  if (templates.length === 0) {
    return NextResponse.json(
      { ok: false, candidates: [], error: "templates required" } satisfies SuggestTemplateResponse,
      { status: 400 },
    );
  }

  // 直近15件に制限 + サロゲート除去
  const recent = messages.slice(-15).map((m) => ({ ...m, text: sanitizeSurrogates(m.text || "") }));

  // テンプレ本文を400字にtruncate（ペイロード上限）+ ID→テンプレのマップ（捏造ID検証用）
  const truncated = templates.map((t) => ({
    id: String(t.id),
    category: t.category || "",
    label: t.label || "",
    text: sanitizeSurrogates((t.text || "").slice(0, 400)),
  }));
  const templateMap = new Map(truncated.map((t) => [t.id, t]));

  const history = formatHistory(recent);
  const lastCustomerMsg =
    sanitizeSurrogates(body.lastCustomerMsg || "") ||
    [...recent].reverse().find((m) => m.sender === "customer" && m.text && m.text !== "[画像]")?.text ||
    "";
  const currentState = normalizeState(body.conversationState || "first_reply");

  const templateList = truncated
    .map((t) => `[${t.id}] ${t.category} | ${t.label} | ${t.text}`)
    .join("\n");

  const userPrompt = [
    `【会話履歴】\n${history || "（履歴なし）"}`,
    lastCustomerMsg ? `【お客様の最新メッセージ】\n${lastCustomerMsg}` : "",
    `【会話ステータス】${currentState}`,
    body.currentAixAction ? `【現在サジェスト中のAIXアクション】${body.currentAixAction}` : "",
    `【テンプレート一覧】\n${templateList}`,
  ].filter(Boolean).join("\n\n");

  try {
    const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").replace(/\s/g, "");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        // claude-sonnet-5: temperature等のサンプリングパラメータ禁止・thinking省略=adaptive。
        // adaptive thinking は max_tokens に含まれるため 2000 では途中打ち切りリスクあり → 4000 に余裕を持たせる
        max_tokens: 4000,
        // システムプロンプトはbyte-stableな定数 → prompt caching が効く
        system: [
          { type: "text", text: SELECTION_SYSTEM, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: userPrompt }],
        output_config: {
          format: { type: "json_schema", schema: OUTPUT_SCHEMA },
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[suggest-template] Anthropic API error ${res.status}:`, errText.slice(0, 500));
      return NextResponse.json(
        { ok: false, candidates: [], error: `Anthropic API error: ${res.status}` } satisfies SuggestTemplateResponse,
        { status: 500 },
      );
    }

    const data = await res.json() as {
      content?: Array<{ type: string; text?: string }>;
      stop_reason?: string;
    };

    if (data.stop_reason === "refusal") {
      console.warn(`[suggest-template] refusal (conversationId=${body.conversationId || "-"})`);
      return NextResponse.json(
        { ok: false, candidates: [], error: "AI refused the request" } satisfies SuggestTemplateResponse,
        { status: 500 },
      );
    }

    const rawText = data.content?.find((b) => b.type === "text")?.text ?? "";
    let parsed: {
      candidates?: Array<{ templateId?: string; reason?: string; rank?: number }>;
      no_match?: boolean;
      no_match_reason?: string | null;
    };
    try {
      parsed = JSON.parse(rawText);
    } catch {
      console.error("[suggest-template] JSON parse failed:", rawText.slice(0, 300), "stop_reason:", data.stop_reason);
      return NextResponse.json(
        { ok: false, candidates: [], error: "AI response parse failed" } satisfies SuggestTemplateResponse,
        { status: 500 },
      );
    }

    // 捏造ID検証: 送信したテンプレ一覧に存在するIDのみ採用（重複も除去）
    const seen = new Set<string>();
    const candidates: SuggestCandidate[] = [];
    for (const c of parsed.candidates ?? []) {
      const id = String(c.templateId ?? "");
      const tmpl = templateMap.get(id);
      if (!tmpl || seen.has(id)) {
        if (id && !tmpl) console.warn(`[suggest-template] 捏造ID除外: ${id}`);
        continue;
      }
      seen.add(id);
      candidates.push({
        templateId: id,
        title: tmpl.label,
        body: tmpl.text, // truncate済み本文（クライアントはローカルSSoTから再解決推奨）
        reason: String(c.reason ?? ""),
        rank: candidates.length + 1, // 除外後に1..3で振り直し
      });
      if (candidates.length >= 3) break;
    }

    const noMatch = candidates.length === 0 && (parsed.no_match === true || (parsed.candidates ?? []).length === 0);

    console.log(
      `[suggest-template] conversationId=${body.conversationId || "-"} state=${currentState} templates=${truncated.length} → candidates=${candidates.length} noMatch=${noMatch}`,
    );

    const response: SuggestTemplateResponse = {
      ok: true,
      candidates,
      ...(noMatch
        ? { noMatch: true, noMatchReason: parsed.no_match_reason || "適切なテンプレートが見つかりませんでした" }
        : {}),
    };
    return NextResponse.json(response);
  } catch (err) {
    console.error("[suggest-template] API呼び出し失敗:", err);
    return NextResponse.json(
      { ok: false, candidates: [], error: err instanceof Error ? err.message : "unknown error" } satisfies SuggestTemplateResponse,
      { status: 500 },
    );
  }
}
