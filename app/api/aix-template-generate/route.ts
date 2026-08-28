import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { generateEmbedding } from "@/app/lib/knowledge-utils";
import { stripRoomLeadingZeros } from "@/app/lib/template-preprocess";
import { AIX_BUTTON_LABELS } from "@/app/lib/aix-taxonomy";

export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/aix-template-generate
//
// AIXテンプレート一覧の「✨ この会話に合った文を生成」ボタン用API。
// 現在選択中のAIXボタン種別（action_type）＋会話コンテキスト（顧客名・条件・直近
// メッセージ）をもとに、winning_patterns / ai_reply_knowledge をRAGで引き、
// AIXボタンの「送付後の橋渡し文（カバーメッセージ）」を Claude Sonnet で生成する。
//
// 設計原則（責務分離）:
//   AIX = 構造化コンテンツ（金額・空室・日程・物件名）の正 / このAPI = 橋渡し文のみ。
//   金額・空室状況・内覧日程・物件名・号室をLLMに創作させることは絶対禁止
//   （5大ハルシネーション事故の根絶）。会話履歴・予約送信AIXメッセージに実際に
//   記載がある事実のみ言及可能とする。
// ─────────────────────────────────────────────────────────────────────────────

// ─── 静的システムプロンプト（byte-stable → prompt cache）─────────────────────
const STATIC_GEN_SYSTEM = `あなたはスモラ（賃貸仲介サービス）のLINE営業担当です。
AIXボタンで送付した（または送付予定の）構造化メッセージ（物件情報・見積書・空室確認結果など）に添える「橋渡し文（カバーメッセージ）」を、現在の会話の流れ・お客様の状況に合わせて1通だけ生成してください。

━━━━━━━━━━━━━━━━━━━━
【役割の境界 — 最重要】
━━━━━━━━━━━━━━━━━━━━
・金額・空室状況・内覧日程・入居可能日・物件詳細などの事実データは「AIXの構造化メッセージ」が正。あなたはその前後をつなぐ橋渡し文だけを書く
・橋渡し文の目的: お客様への呼びかけ→送付物の位置づけ説明→お客様の状況に合わせた一言→CTA（行動喚起）→柔らかい締め

━━━━━━━━━━━━━━━━━━━━
【🚫 ハルシネーション絶対禁止 — 全ルールより上位】
━━━━━━━━━━━━━━━━━━━━
・金額（初期費用・家賃・割引額・節約額）: 会話履歴または予約送信AIXメッセージに実際に記載がある値のみ書ける。記載がなければ金額は一切書かない
・空室状況の断定（「空いてます」「募集中です」「募集終了です」等）: 会話履歴に確認結果の記載がなければ書かない
・内覧日程・日付・曜日・時間の提案や創作: 絶対禁止（日程提示はAIX内覧日調整ボタンの担当領域）
・物件名・号室: 会話履歴または予約送信AIXメッセージに登場するもののみ使用可。創作・使い回しは絶対禁止
・お客様の希望条件・会話に出ていない駅名・路線・設備・築年数を事実のように書かない
・迷ったら固有の事実には触れず、汎用的な橋渡し表現にとどめる

━━━━━━━━━━━━━━━━━━━━
【スモラ品質ルール】
━━━━━━━━━━━━━━━━━━━━
・感嘆符は「！！」（全角2つ）のみ使用。「!」「！」1つは絶対禁止
・使える絵文字: 😊 😌 🙇‍♀️ 🌟 ✨（1〜2個まで。絵文字禁止指示がある場合は一切使わない）
・お客様名は「〇〇さん」と呼ぶ。LINEでは「様」は絶対に使わない
・冒頭挨拶: 通常は「〇〇さんお世話になっております！！」。本日すでにスタッフが送信済みの場合は「お待たせ致しました！！」
・長すぎない。3〜7文程度でテンポよく
・締めは「お手隙の際にご査収ください😌！！」等で圧を下げる（絵文字禁止時は絵文字なしで）
・内覧後のシーンで感想を聞かない（「御礼+申込宣言+いつでもご連絡ください」の宣言形で締める）

━━━━━━━━━━━━━━━━━━━━
【禁止ワード・表現】
━━━━━━━━━━━━━━━━━━━━
× 「スモラ」という会社名 → 「弊社」
× 「コスパ」表現 → 「好条件」「お値打ちな条件」
× 「共益費込み」→「家賃管理費込」
× 「即入居可能」→ 会話に明記がなければ絶対に書かない
× 「承りました」「ご確認のほど」「確認中です」「少々お待ちください」
× 「〇〇とのことですね」等のオウム返し
× 「ご共有頂き」→ お客様には「お送り頂き」
× 「仲介手数料を割引」→「初期費用を最大限割引させていただきます」
× マークダウン太字（**）等の記法（LINEは非対応）
× 謝罪の多用（「申し訳ございません」の連発）
× 敷金を初期費用削減として訴求（敷金は返還される預かり金）
× 号室の先頭ゼロ（0906号室 → 906号室）

━━━━━━━━━━━━━━━━━━━━
【出力】
━━━━━━━━━━━━━━━━━━━━
生成した本文のみを出力する。説明・前置き・補足コメント・選択肢の提示は一切書かない。`;

// ─── アクション別ガイド（正準キー: aix-taxonomy.ts の AIX_BUTTON_LABELS 準拠）──
const ACTION_GUIDES: Record<string, string> = {
  property_send:
    "物件ピックアップ送付の橋渡し文。名前呼びかけ→お探しした物件をお送りする旨→お客様の希望条件との合致点に軽く触れる→「お気に召されましたらご都合よろしいお日にちにご案内させて頂きます」等のCTA→ご査収の締め。物件の具体的スペックはAIX/会話に記載がある範囲のみ。",
  property_recommendation:
    "1件に絞ったオススメの橋渡し文。「〇〇さんにかなりオススメ出来るお部屋」の特別感を演出し、希望条件とのパーソナライズに触れる。デメリットが会話上明らかな場合は先に開示して即メリットで転換。CTAは内覧誘導または申込誘導。スペック・金額は会話/AIXに記載がある範囲のみ。",
  property_check_result:
    "管理会社等への確認結果を報告する際の橋渡し文。確認結果の中身（空室・金額・日付）はAIXの構造化メッセージが正なので断定して書かない。「確認結果をご報告いたします」の位置づけと次のアクション誘導のみを書く。",
  estimate_sheet:
    "見積書送付の橋渡し文。定型フレーズ「最大限割引しました初期費用の御見積書となります！！」を含める。金額は会話/AIXに記載がある値のみ（創作は絶対禁止・なければ金額は書かない）。CTAは「お気に召されましたらお申込みしお部屋抑えさせて頂きます！！」または内覧誘導。締めは「お手隙の際にご査収ください😌！！」。",
  viewing_invite:
    "内覧への誘導文。具体的な候補日時・曜日は絶対に書かない（日程提示はAIX内覧日調整の担当）。「ご都合よろしいお日にちにご案内させて頂きます」の形で相手に委ねる。",
  meeting_place:
    "内覧待ち合わせに関する橋渡し文。日時・住所などの確定情報はAIXが正なので創作しない。",
  greeting_viewing:
    "内覧当日・前後の挨拶/フォロー文。内覧後は感想を聞かず「御礼+申込サポート宣言+いつでもご連絡ください」で締める。",
  condition_hearing:
    "お部屋探し条件のヒアリング文。会話から既に判明している条件は聞き直さず、未取得の条件だけ軽く尋ねる。質問攻めにしない（2〜3項目まで）。",
  application_push:
    "申込へのクロージング文。前向きな反応を受けて「お申込みしお部屋抑えさせて頂きます」へ誘導。過度な圧はかけず、締めで圧を下げる。",
  followup_revive:
    "返信が止まったお客様への再接触文。責めない・重くしない。近況伺い+お手伝いできる旨+返信ハードルを下げる一言。",
  acknowledge_check:
    "確認依頼への受付宣言文。「募集状況確認させていただきます！！」の宣言のみ。確認結果・空室状況を先取りして書かない。",
};

// ─── リクエスト型 ────────────────────────────────────────────────────────────
type GenerateRequestBody = {
  actionType?: string | null;       // 正準キー（property_send 等）。null時はactionCategoryのみで生成
  actionCategory?: string;          // 選択中のAIXカテゴリ名（例: 物件ピックアップした【AIX】）
  conversationId?: string;
  customerName?: string;
  conversationState?: string;
  recentMessages?: Array<{ sender: string; text: string; imageUrl?: string; isAix?: boolean }>;
  customerConditions?: string;
  noEmoji?: boolean;
  pendingScheduledMessages?: Array<{ text: string | null }>;
  staffMessagedToday?: boolean;
};

const STATE_LABEL: Record<string, string> = {
  first_reply: "初回応対", condition_hearing: "条件ヒアリング",
  property_search: "物件探し中", property_recommendation: "物件提案中",
  viewing: "内覧調整", estimate_request: "見積依頼",
  availability_check: "空室確認", application: "申込中",
  screening: "審査中", contract: "契約中", closed_won: "成約済み",
};

// ─── POST ────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let body: GenerateRequestBody;
  try {
    body = await req.json() as GenerateRequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const {
    actionType,
    actionCategory,
    conversationId,
    customerName,
    conversationState,
    recentMessages,
    customerConditions,
    noEmoji,
    pendingScheduledMessages,
    staffMessagedToday,
  } = body;

  if (!actionType && !actionCategory) {
    return NextResponse.json({ ok: false, error: "actionType or actionCategory is required" }, { status: 400 });
  }

  const actionLabel = (actionType && AIX_BUTTON_LABELS[actionType]) || actionCategory || "AIXメッセージ";
  const actionGuide = (actionType && ACTION_GUIDES[actionType]) || "";

  // ── Brain戦略（AIX-META）: あれば方向性として利用 ────────────────────────
  type BrainMeta = { action?: string; closing_strategy?: string; reply_direction?: string; checkpoint_stage?: string };
  const convResult = conversationId
    ? await supabase.from("conversations").select("suggested_aix_meta").eq("id", conversationId).single()
    : { data: null };
  const brainMeta = (convResult.data as { suggested_aix_meta?: BrainMeta } | null)?.suggested_aix_meta ?? null;

  // ── RAG: winning_patterns + ai_reply_knowledge ───────────────────────────
  let winningSection = "";
  let knowledgeSection = "";
  if (process.env.OPENAI_API_KEY) {
    const recentCustomerMsgs = (recentMessages ?? [])
      .filter((m) => m.sender === "customer" && m.text && m.text !== "[画像]" && m.text !== "[動画]")
      .slice(-3)
      .map((m) => m.text)
      .join(" ");
    const ragQuery = [
      `AIXアクション: ${actionLabel}`,
      customerConditions ? `希望条件: ${customerConditions.slice(0, 200)}` : "",
      brainMeta?.closing_strategy ? `成約戦略: ${brainMeta.closing_strategy}` : "",
      conversationState ? `フェーズ: ${STATE_LABEL[conversationState] ?? conversationState}` : "",
      recentCustomerMsgs.slice(0, 200),
    ].filter(Boolean).join(" | ").slice(0, 1000);

    try {
      const emb = await generateEmbedding(ragQuery);
      if (emb) {
        const [wpRes, knRes] = await Promise.all([
          supabase.rpc("match_winning_patterns", {
            query_embedding: emb,
            match_count: 6,
            min_importance: 8,
          }),
          supabase.rpc("match_reply_knowledge", {
            query_embedding: emb,
            match_threshold: 0.72,
            match_count: 4,
          }),
        ]);
        type WpRow = { situation: string | null; pattern: string; closing_action: string | null; notes: string | null; similarity: number };
        const wpRows = ((wpRes.data ?? []) as WpRow[]).filter((w) => w.similarity >= 0.5).slice(0, 5);
        if (wpRows.length > 0) {
          winningSection =
            `━━━━━━━━━━━━━━━━━━━━\n【過去の成約パターン（似た状況で効いた戦い方 — トーン・構成の参考にする）】\n━━━━━━━━━━━━━━━━━━━━\n` +
            wpRows.map((w) => {
              const parts = [
                w.situation ? `状況: ${w.situation}` : "",
                `パターン: ${w.pattern}`,
                w.closing_action ? `クロージング: ${w.closing_action}` : "",
                w.notes ? `補足: ${w.notes}` : "",
              ].filter(Boolean).join(" / ");
              return `・${parts}`;
            }).join("\n") + "\n\n";
        }
        const knRows = (knRes.data ?? []) as Array<{ content: string | null }>;
        if (Array.isArray(knRows) && knRows.length > 0) {
          knowledgeSection =
            `━━━━━━━━━━━━━━━━━━━━\n【参考ナレッジ（状況に合った過去の知見）】\n━━━━━━━━━━━━━━━━━━━━\n` +
            knRows.filter((r) => r.content).map((r) => `・${r.content}`).join("\n") + "\n\n";
        }
      }
    } catch {
      // RAG失敗は無視して生成継続（既存方針: adapt/brain-coreと同じ）
    }
  }

  // ── コンテキスト整形 ─────────────────────────────────────────────────────
  const history = (recentMessages ?? [])
    .slice(-15)
    .map((m) => {
      const who = m.sender === "customer" ? "お客様" : (m.isAix ? "スモラ(AIX送信)" : "スモラ");
      if (m.text === "[画像]" || m.text === "[動画]") return `${who}: 【画像・資料を送付】`;
      if (!m.text) return null;
      return `${who}: ${m.text}`;
    })
    .filter(Boolean)
    .join("\n");

  const pendingSection = (pendingScheduledMessages ?? [])
    .map((m) => m.text ?? "").filter(Boolean).join("\n\n---\n\n");

  const stateLabel = STATE_LABEL[conversationState || ""] || conversationState || "不明";

  const brainMetaSection = brainMeta
    ? `━━━━━━━━━━━━━━━━━━━━\n【🧠 Brain戦略 — 生成の方向性】\n━━━━━━━━━━━━━━━━━━━━\n` +
      `成約戦略: ${brainMeta.closing_strategy || "-"}\n` +
      `返信方向: ${brainMeta.reply_direction || "-"}\n` +
      `チェックポイント: ${brainMeta.checkpoint_stage || "-"}\n\n`
    : "";

  const userPrompt = [
    `━━━━━━━━━━━━━━━━━━━━\n【今回生成する橋渡し文】\n━━━━━━━━━━━━━━━━━━━━`,
    `・AIXボタン種別: ${actionLabel}`,
    actionGuide ? `・この種別の書き方: ${actionGuide}` : "",
    "",
    brainMetaSection,
    winningSection,
    knowledgeSection,
    `━━━━━━━━━━━━━━━━━━━━\n【お客様情報】\n━━━━━━━━━━━━━━━━━━━━`,
    `・お客様名: ${customerName || "〇〇"}さん`,
    `・現在のフェーズ: ${stateLabel}`,
    customerConditions ? `・希望条件（DB）: ${customerConditions}` : "",
    staffMessagedToday ? `・本日すでにスタッフが送信済み（冒頭は「お待たせ致しました！！」系にする）` : "",
    noEmoji ? `・絵文字禁止モード: 絵文字を一切使わないこと` : "",
    "",
    pendingSection
      ? `━━━━━━━━━━━━━━━━━━━━\n【🔑 予約送信待ちのAIXメッセージ（物件名・金額など事実の唯一の追加ソース）】\n━━━━━━━━━━━━━━━━━━━━\n${pendingSection}\n`
      : "",
    `━━━━━━━━━━━━━━━━━━━━\n【会話履歴（事実確認と流れの把握に使う）】\n━━━━━━━━━━━━━━━━━━━━\n${history || "なし"}`,
    "",
    `この会話の流れ・お客様の状況に合った「${actionLabel}」の橋渡し文を1通生成してください。金額・空室状況・日程・物件名は上記の会話履歴/AIXメッセージに記載がある事実のみ使い、なければ言及しないこと。出力は本文のみ。`,
  ].filter(Boolean).join("\n");

  // ── Anthropic API (Claude Sonnet + prompt cache) ─────────────────────────
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").replace(/\s/g, "");
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(55_000),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1024,
        system: [
          {
            type: "text",
            text: STATIC_GEN_SYSTEM,
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[aix-template-generate] Anthropic error ${res.status}:`, errText.slice(0, 300));
      return NextResponse.json({ ok: false, error: `AI生成エラー: ${res.status}` }, { status: 500 });
    }

    const data = await res.json() as { content?: Array<{ type: string; text?: string }> };
    let text = data.content?.find((b) => b.type === "text")?.text?.trim() ?? "";
    if (!text) {
      return NextResponse.json({ ok: false, error: "empty result" }, { status: 500 });
    }
    text = stripRoomLeadingZeros(text);

    console.log(
      `[aix-template-generate] action=${actionType || actionCategory || "-"}` +
      ` rag_wp=${winningSection ? "hit" : "miss"} rag_kn=${knowledgeSection ? "hit" : "miss"} brainMeta=${brainMeta ? "ok" : "none"}`,
    );

    return NextResponse.json({ ok: true, text });
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI生成エラー";
    console.error("[aix-template-generate] error:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
