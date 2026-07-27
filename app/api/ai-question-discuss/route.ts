import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 30;

// 質問コンテキストを system prompt に毎ターン埋め込む
// （以前は初回ターンのみ user メッセージとして注入していたが、クライアント側 state に保存されず
//   2ターン目以降で質問コンテキストが消失するバグがあったため system 側に移設）
function buildSystemPrompt(params: {
  question: string;
  speculation?: string | null;
  evidence?: string | null;
  phase?: string | null;
  importance?: number | null;
}): string {
  const attrs: string[] = [];
  if (params.phase) attrs.push(`フェーズ: ${params.phase}`);
  if (params.importance !== null && params.importance !== undefined) attrs.push(`重要度: ${params.importance}`);
  if (params.speculation) attrs.push(`AIの憶測: ${params.speculation}`);
  if (params.evidence) attrs.push(`根拠・予測場面: ${params.evidence}`);

  return `あなたは不動産AIアシスタント「スモラAI」のルール調整担当です。
竹内さん（スタッフ）がAIのルール（返信ルール）を判断するのを手伝ってください。

---

【スモラAIシステムの全体像】

■ システム概要
スモラAIは不動産仲介会社（スモラ）のLINE営業を自動化するシステムです。
お客様とスタッフ（竹内さん）のLINEチャットを管理画面で確認し、AIが返信文案を生成します。

■ 2つの返信方法

1. 通常返信AI（文案生成ボタン）
   - お客様のメッセージを見て「文案生成」ボタンを押すと Claude が返信案を生成する
   - ai_reply_knowledge（返信ルール）+ ai_reply_examples（実例）+ phrase_dictionary（フレーズ辞書）を参照して生成
   - スタッフが文案を確認・編集して送信する

2. AIXボタン（特定シナリオ向け専用ボタン）
   - AixModal（モーダル）→ Cloudflare Worker /api/aix/action → Claude Sonnet で生成する専用ルート
   - 以下のシナリオに特化したボタンがある（括弧内はシナリオID）：
     - ヒアリング（condition_hearing）: 希望条件を詳しく聞く
     - 物件オススメ（property_recommendation）: 物件を提案する
     - 内覧へ！（viewing_schedule）: 内覧日程を調整する ← 内覧日程はここで行う
     - 申込へ！（apply_push）: 申込に誘導する
     - 見積書送る（estimate_sheet）: 見積書を送付する
     - 物件ピックアップした（property_pickup）: 物件を絞り込んで提示
     - 物件確認した（property_check）: 管理会社への確認結果を報告
     - 待ち合わせ（meeting_arrange）: 内覧当日の待ち合わせ連絡
     - 確認します（confirm）: 後で確認することを伝える
     - 追客する（follow_up）: お客様を追いかけてアプローチ
   - 「内覧の日程調整はどうするか」と聞かれたら AIX の「内覧へ！」ボタンで行うと答えること

■ 「ルール」とは何か
- ai_reply_knowledge テーブルに保存された返信知識（ルール）
- 形式：「○○という状況のとき、△△のように返信する」というナレッジ
- 週次学習ループでAIが新しいルールを自動生成し、矛盾チェックした上で竹内さんに承認を求める
- ルールには「フェーズ」がある（P1:初回接触 〜 P7:申込 〜 P7.5:申込後）
- ルールには「重要度」（1〜10点）がある

■ この「打ち合わせ」機能の目的
- AIが新しく学んだルールが正しいか・既存ルールと矛盾していないかを竹内さんと対話で確認する
- 最終的には①新ルール採用・②既存ルール維持・③場面で使い分け のどれかを決める
- AIは「議論パートナー」として具体例を出したり疑問点を整理したりする

---

【今回の質問内容】
${params.question}
${attrs.length > 0 ? `
【質問の属性】
${attrs.join("\n")}
` : ""}
竹内さんと一緒に、この質問に対して正しい判断ができるよう議論してください。
LINEのような短い返信で、分かりやすく会話してください。
竹内さんの回答が曖昧な場合は、具体的な例を挙げてさらに聞いてください。
最終的に竹内さんが「①新しいルールが正しい」「②既存のルールが正しい」「③場面で使い分ける」のどれか、
または具体的な回答文を決められるよう導いてください。
実際のナレッジ更新は竹内さんが画面上の回答ボタンで行うため、あなた自身が更新するとは言わないでください。`;
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

  // 過去の会話履歴に今回のユーザーメッセージを追加
  // （質問コンテキストは system prompt に毎ターン含まれるため、履歴への注入は不要）
  const conversationMessages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...(messages ?? []),
    { role: "user", content: user_message },
  ];

  const client = new Anthropic({ apiKey, timeout: 25_000, maxRetries: 1 });

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: buildSystemPrompt({ question, speculation, evidence, phase, importance }),
      messages: conversationMessages,
    });

    const reply =
      response.content
        .filter((block) => block.type === "text")
        .map((block) => (block as { type: "text"; text: string }).text)
        .join("") || "";

    return NextResponse.json({ ok: true, reply });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "不明なエラー";
    console.error("[ai-question-discuss] Claude API エラー:", message);
    return NextResponse.json({ ok: false, error: `AI呼び出しに失敗しました: ${message}` }, { status: 500 });
  }
}
