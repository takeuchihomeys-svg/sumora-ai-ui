import { NextRequest, NextResponse } from "next/server";
import Anthropic, { APIError } from "@anthropic-ai/sdk";
import {
  SYSTEM_OVERVIEW,
  BUSINESS_RULES,
  KNOWLEDGE_FORMAT,
  DISCUSSION_QUALITY_GUIDE,
  fetchActiveKnowledgeSection,
  phaseLabel,
} from "@/app/lib/discuss-context";

export const maxDuration = 90;

// 質問コンテキストを system prompt に毎ターン埋め込む
// （以前は初回ターンのみ user メッセージとして注入していたが、クライアント側 state に保存されず
//   2ターン目以降で質問コンテキストが消失するバグがあったため system 側に移設）
// システム全体像・業務ルール・ナレッジDBフォーマットは app/lib/discuss-context.ts に集約。
function buildSystemPrompt(params: {
  question: string;
  speculation?: string | null;
  evidence?: string | null;
  phase?: string | null;
  importance?: number | null;
  knowledgeSection?: string;
  isFirstTurn?: boolean;
}): string {
  const phaseStr = params.phase ? phaseLabel(params.phase) : null;

  // evidence と speculation を名前付きブロックで提示（メタデータ重複を避ける）
  const contextLines: string[] = [];
  if (phaseStr || params.importance != null) {
    contextLines.push(`フェーズ: ${phaseStr ?? "未指定"}　重要度: ${params.importance ?? "?"}点`);
  }
  if (params.evidence) {
    contextLines.push(`■ AIがこのルールを使おうとした具体的な場面\n${params.evidence}`);
  }
  if (params.speculation) {
    contextLines.push(`■ AIの憶測・背景\n${params.speculation}`);
  }
  const contextBlock = contextLines.join("\n\n");

  // 第1ターン強制フォーマット（isFirstTurn のときのみ注入）
  const firstTurnInstruction = params.isFirstTurn ? `
---

【第1ターン 必須フォーマット — この返信でのみ適用・厳守すること】

最初の返信は以下の2段構成で必ず始めること：

第1段「私の理解：」
- 上記の【AIの憶測・背景】【AIがこのルールを使おうとした具体的な場面】【今回の議題】を統合して、
  AIが今どう理解しているかを2〜3行で要約する
- 「私はこのルールを○○の場面で○○のように使うものと理解しています」という形式
- 業務ルール・既存ナレッジと照らして気になる点があれば1行で添える

第2段「確認：」
- 竹内さんが「はい」または「いいえ（〜の場合は違います）」で答えられる1行の質問で締める
- 複数の疑問点がある場合は最も核心的な1つに絞る
- 選択肢列挙は絶対禁止

例（形式のみ参考）：
「私の理解：○○という場面でAIが△△するかどうか迷っているルールと理解しています。
確認：□□のときは必ず使う、という方向で合っていますか？」

❌ 絶対禁止: 長い背景説明・経緯の再掲・選択肢を並べる・質問文をそのまま読み上げる
✅ 必須: 「私の理解：」→「確認：」の2段で始め、竹内さんが即答できる形にする
` : "";

  return `あなたは不動産AIアシスタント「スモラAI」のルール調整担当です。
竹内さん（スタッフ）と対話しながら、AIの返信ルールを正確に定義することが仕事です。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【今回の議題 ── まずここを把握してから動く】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${params.question}
${contextBlock ? `\n${contextBlock}` : ""}

---

${DISCUSSION_QUALITY_GUIDE}
${firstTurnInstruction}
---

${SYSTEM_OVERVIEW}

■ 「ルール」とは何か
- ai_reply_knowledge テーブルに保存された返信知識（ルール）
- 形式：「○○という状況のとき、△△のように返信する」というナレッジ
- 週次学習ループでAIが新しいルールを自動生成し、矛盾チェックした上で竹内さんに承認を求める

${KNOWLEDGE_FORMAT}

---

${BUSINESS_RULES}
${params.knowledgeSection ? `\n---\n\n${params.knowledgeSection}\n` : ""}
---

■ この打ち合わせ機能について
- 最終的には①新ルール採用・②既存ルール維持・③場面で使い分け のどれかを決める
- 業務ルール・承認済みルールと矛盾する提案があれば必ず指摘する
- 実際のナレッジ更新は竹内さんが画面上の回答ボタンで行うため、あなた自身が更新するとは言わない

LINEのような短い返信で、分かりやすく会話してください。`;
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY が設定されていません" }, { status: 500 });
  }

  let body: {
    item_id: string;
    question: string;
    speculation?: string | null;
    evidence?: string | null;
    phase?: string | null;
    importance?: number | null;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    user_message: string;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "リクエストボディの解析に失敗しました" }, { status: 400 });
  }

  const { question, speculation, evidence, phase, importance, messages, user_message } = body;

  if (!question || !user_message) {
    return NextResponse.json({ ok: false, error: "question と user_message は必須です" }, { status: 400 });
  }

  // 承認済みナレッジTOPを取得（失敗しても打ち合わせは続行）
  const knowledgeSection = await fetchActiveKnowledgeSection(phase);

  // 会話履歴が空 = 初回ターン（第1ターン強制フォーマットを注入するために検出）
  const isFirstTurn = !messages || messages.length === 0;

  // 過去の会話履歴に今回のユーザーメッセージを追加
  // （質問コンテキストは system prompt に毎ターン含まれるため、履歴への注入は不要）
  const conversationMessages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...(messages ?? []),
    { role: "user", content: user_message },
  ];

  // Sonnet は 10-20s で返答するため timeout:25s × maxRetries:2 (最大3試行) を考慮し maxDuration:90s
  const client = new Anthropic({ apiKey, timeout: 25_000, maxRetries: 2 });

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
      system: buildSystemPrompt({ question, speculation, evidence, phase, importance, knowledgeSection, isFirstTurn }),
      messages: conversationMessages,
    });

    const reply =
      response.content
        .filter((block) => block.type === "text")
        .map((block) => (block as { type: "text"; text: string }).text)
        .join("") || "";

    return NextResponse.json({ ok: true, reply });
  } catch (err: unknown) {
    console.error("[ai-question-discuss] Claude API エラー:", err instanceof Error ? err.message : err);
    // 529 overloaded_error: Anthropic API 過負荷時はユーザーに分かりやすく伝える
    if (err instanceof APIError && err.status === 529) {
      return NextResponse.json(
        { ok: false, error: "AIが混雑中です。少し時間をおいてから再度送信してください。" },
        { status: 503 }
      );
    }
    const message = err instanceof Error ? err.message : "不明なエラー";
    return NextResponse.json({ ok: false, error: `AI呼び出しに失敗しました: ${message}` }, { status: 500 });
  }
}
