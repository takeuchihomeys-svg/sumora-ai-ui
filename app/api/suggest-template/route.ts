import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

export const maxDuration = 60;

// ─── POST /api/suggest-template ──────────────────────────────────────────────
// 会話履歴 + AIXテンプレート一覧から、次に送るべきテンプレートTOP3をAIが選定する。
// [H-08] 改善: templateList を Block2(ephemeral)キャッシュ・AIX-META注入・RAG検索追加。
// generate-reply と同じ raw-fetch パターン（SDK不使用・環境変数キー・空白除去）。
// claude-sonnet-5 の制約: temperature/top_p/top_k は送らない（400になる）。

// ─── リクエスト/レスポンス型 ─────────────────────────────────────────────────
interface SuggestTemplateRequest {
  conversationId?: string;          // AIX-META取得・ログ用途
  conversationState?: string;
  customerName?: string;
  lastCustomerMsg?: string;
  currentAixAction?: string;
  lastAixSentMessage?: string;
  messages: Array<{
    sender: string;
    text: string;
    imageUrl?: string;
    isAix?: boolean;
  }>;
  templates?: Array<{              // DBから取得するためoptional（フォールバック用）
    id: string;
    category: string;
    label: string;
    text: string;
  }>;
}

interface SuggestCandidate {
  templateId: string;
  title: string;
  body: string;
  reason: string;
  rank: number;
}

interface SuggestTemplateResponse {
  ok: boolean;
  candidates: SuggestCandidate[];
  noMatch?: boolean;
  noMatchReason?: string;
  error?: string;
}

// ─── 状態正規化 ──────────────────────────────────────────────────────────────
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

// ─── 会話履歴の整形 ──────────────────────────────────────────────────────────
type Msg = NonNullable<SuggestTemplateRequest["messages"]>[number];
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

// 孤立サロゲート（LINE絵文字等）をU+FFFDに置換
const sanitizeSurrogates = (s: string) =>
  s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");

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

// ─── システムプロンプト Block1（byte-stable → prompt caching が効く）──────────
const SELECTION_SYSTEM = `あなたは不動産賃貸仲介『スモラ』のLINE営業テンプレート選定AIです。会話履歴とAIXテンプレート一覧から、次にスタッフが送るべきテンプレートを最大3件、適合度順に選びます。

【選定ルール（優先度順）】

0. 【AIX文最優先ルール】ユーザーメッセージに「スタッフが直前に送ったAIX文」セクションが含まれる場合、それが「スタッフの直前アクション」です。「お客様の最新メッセージ」よりも後に送られた文なので、そのAIX文への自然な続き（補足・クロージング・次ステップ誘導）となるテンプレを最優先で選んでください。お客様の返信への応答テンプレは選ばないこと。

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
  if (messages.length === 0) {
    return NextResponse.json(
      { ok: false, candidates: [], error: "messages required" } satisfies SuggestTemplateResponse,
      { status: 400 },
    );
  }

  // 直近15件に制限 + サロゲート除去
  const recent = messages.slice(-15).map((m) => ({ ...m, text: sanitizeSurrogates(m.text || "") }));
  const history = formatHistory(recent);
  const lastCustomerMsg =
    sanitizeSurrogates(body.lastCustomerMsg || "") ||
    [...recent].reverse().find((m) => m.sender === "customer" && m.text && m.text !== "[画像]")?.text ||
    "";
  const currentState = normalizeState(body.conversationState || "first_reply");
  const lastAixSentMessage = sanitizeSurrogates(body.lastAixSentMessage || "");

  // ── AIX-META: conversationIdでDBからfetch ────────────────────────────────
  type BrainMeta = {
    action?: string;
    closing_strategy?: string;
    reply_direction?: string;
    urgency_appropriate?: string;
    checkpoint_stage?: string;
  };
  let brainMeta: BrainMeta | null = null;
  if (body.conversationId) {
    const { data: convData } = await supabase
      .from("conversations")
      .select("suggested_aix_meta")
      .eq("id", body.conversationId)
      .single();
    if (convData?.suggested_aix_meta) {
      brainMeta = convData.suggested_aix_meta as BrainMeta;
    }
  }

  // ── テンプレート: DBから全件取得（win_rate付き・全ユーザー共通 → Block2キャッシュ可）
  type DbTemplate = {
    id: string;
    category: string | null;
    label: string | null;
    text: string | null;
    win_rate: number | null;
    use_count: number | null;
  };
  const { data: dbTemplates } = await supabase
    .from("templates")
    .select("id, category, label, text, win_rate, use_count")
    .order("category", { ascending: true })
    .order("sort_order", { ascending: true });

  // DBから取れない場合はbody.templatesをフォールバックとして使う
  const templateSource: Array<{ id: string; category: string; label: string; text: string; win_rate: number | null; use_count: number | null }> =
    (dbTemplates && dbTemplates.length > 0)
      ? (dbTemplates as DbTemplate[]).map((t) => ({
          id: String(t.id),
          category: t.category || "",
          label: t.label || "",
          text: sanitizeSurrogates((t.text || "").slice(0, 400)),
          win_rate: t.win_rate,
          use_count: t.use_count,
        }))
      : (body.templates ?? []).map((t) => ({
          id: String(t.id),
          category: t.category || "",
          label: t.label || "",
          text: sanitizeSurrogates((t.text || "").slice(0, 400)),
          win_rate: null,
          use_count: null,
        }));

  if (templateSource.length === 0) {
    return NextResponse.json(
      { ok: false, candidates: [], error: "templates not found" } satisfies SuggestTemplateResponse,
      { status: 400 },
    );
  }

  const templateMap = new Map(templateSource.map((t) => [t.id, t]));

  // Block2用: 全テンプレ一覧テキスト（win_rate付き・同一内容 → キャッシュヒット）
  const templateListText = templateSource
    .map((t) => {
      const stats = t.win_rate != null
        ? ` [勝率${(t.win_rate * 100).toFixed(0)}%/${t.use_count ?? 0}回]`
        : "";
      return `[${t.id}] ${t.category} | ${t.label}${stats} | ${t.text}`;
    })
    .join("\n");

  // ── RAG: AIX-METAを含む文脈でナレッジ検索 ──────────────────────────────
  let ragKnowledgeSection = "";
  if (lastCustomerMsg && process.env.OPENAI_API_KEY) {
    const ragQuery = [
      lastCustomerMsg,
      brainMeta?.action          ? `推奨アクション: ${brainMeta.action}` : "",
      brainMeta?.closing_strategy ? `成約戦略: ${brainMeta.closing_strategy}` : "",
      brainMeta?.reply_direction  ? `返信方向: ${brainMeta.reply_direction}` : "",
    ].filter(Boolean).join(" | ");

    const emb = await generateEmbedding(ragQuery);
    if (emb) {
      const { data: ragRows } = await supabase.rpc("match_reply_knowledge", {
        query_embedding: emb,
        match_threshold: 0.72,
        match_count: 5,
      });
      if (Array.isArray(ragRows) && ragRows.length > 0) {
        ragKnowledgeSection =
          "【参考ナレッジ（RAG）】\n" +
          (ragRows as Array<{ content: string }>).map((r) => `- ${r.content}`).join("\n") +
          "\n\n";
      }
    }
  }

  // ── AIX-META 動的セクション ──────────────────────────────────────────────
  const brainMetaSection = brainMeta
    ? `【AIX戦略（Brain分析）】\n` +
      `推奨アクション: ${brainMeta.action || "-"}\n` +
      `成約戦略: ${brainMeta.closing_strategy || "-"}\n` +
      `返信方向: ${brainMeta.reply_direction || "-"}\n` +
      `緊急度: ${brainMeta.urgency_appropriate || "-"}\n` +
      `チェックポイント: ${brainMeta.checkpoint_stage || "-"}\n\n`
    : "";

  // ── 動的userPrompt（templateListはBlock2キャッシュ済みのため含めない）──
  const userPrompt = [
    brainMetaSection,
    ragKnowledgeSection,
    `【会話履歴】\n${history || "（履歴なし）"}`,
    lastCustomerMsg ? `【お客様の最新メッセージ】\n${lastCustomerMsg}` : "",
    lastAixSentMessage
      ? `【スタッフが直前に送ったAIX文】（お客様メッセージより後・最優先コンテキスト）\n${lastAixSentMessage}`
      : "",
    `【会話ステータス】${currentState}`,
    body.currentAixAction ? `【現在のAIXアクション】${body.currentAixAction}` : "",
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
        "anthropic-beta": "prompt-caching-2024-07-31",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 4000,
        system: [
          // Block1: 選定ルール（byte-stable → prompt cache）
          { type: "text", text: SELECTION_SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } },
          // Block2: 全テンプレ一覧（全ユーザー共通・win_rate付き → prompt cache）
          {
            type: "text",
            text: "【テンプレート一覧（全カテゴリ・勝率付き）】\n" + templateListText,
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
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

    // 捏造ID検証: DBから取得した一覧に存在するIDのみ採用（重複も除去）
    const sortedParsedCandidates = (parsed.candidates ?? []).slice().sort(
      (a, b) => (a.rank ?? 99) - (b.rank ?? 99),
    );
    const seen = new Set<string>();
    const candidates: SuggestCandidate[] = [];
    for (const c of sortedParsedCandidates) {
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
        body: tmpl.text,
        reason: String(c.reason ?? ""),
        rank: candidates.length + 1,
      });
      if (candidates.length >= 3) break;
    }

    const noMatch = candidates.length === 0;

    console.log(
      `[suggest-template] conversationId=${body.conversationId || "-"} state=${currentState}` +
      ` templates=${templateSource.length} rag=${ragKnowledgeSection ? "hit" : "miss"}` +
      ` brainMeta=${brainMeta ? "ok" : "none"} → candidates=${candidates.length} noMatch=${noMatch}`,
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
