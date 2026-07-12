import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "@/app/lib/supabase";

// 改善案打ち合わせフロー:
// 改善案タブ（ai_template_candidates source="improvement"）の候補について、
// 竹内悠馬とOpus 4.8が打ち合わせして実装仕様を固め、
// 確定した仕様を aix_feature_suggestions（status="approved"）へ転送する。
//
// action:
//   "start"    — Opus 4.8 が改善パターンを分析して打ち合わせを開始
//   "chat"     — マルチターンで仕様を詰める
//   "finalize" — 打ち合わせ内容をJSON仕様に落として aix_feature_suggestions に保存

export const maxDuration = 60;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });

const ACTION_LABELS: Record<string, string> = {
  property_send: "物件ピックアップ送り",
  property_check_result: "物件確認結果",
  viewing_invite: "内覧誘導",
  application_push: "申込み促進",
  greeting: "挨拶",
  acknowledge_check: "確認への返答",
  docs_request: "書類案内",
  meeting_place: "待ち合わせ",
  estimate_sheet: "見積書",
};

type ChatMessage = { role: "user" | "assistant"; content: string };

interface CandidateRow {
  id: string;
  action_type: string;
  template_text: string | null;
  original_text: string | null;
  reason: string | null;
  evidence_count: number | null;
}

interface MeetingSpec {
  suggestion_type: "new_button" | "new_picker" | "new_sub_mode" | "new_aix";
  suggested_title: string;
  description: string;
  implementation_notes: string;
  reason: string;
}

const SUGGESTION_TYPES = new Set(["new_button", "new_picker", "new_sub_mode", "new_aix"]);

// Anthropic レスポンスから最初のテキストブロックを取り出す
function extractText(content: Anthropic.ContentBlock[]): string {
  for (const block of content) {
    if (block.type === "text") return block.text.trim();
  }
  return "";
}

// Opus の finalize 出力からJSON仕様を抽出（```json フェンス対応）
function parseSpecJson(text: string): MeetingSpec | null {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as Partial<MeetingSpec>;
    if (!parsed.suggested_title || !parsed.description) return null;
    return {
      suggestion_type: SUGGESTION_TYPES.has(parsed.suggestion_type ?? "")
        ? (parsed.suggestion_type as MeetingSpec["suggestion_type"])
        : "new_button",
      suggested_title: String(parsed.suggested_title).trim(),
      description: String(parsed.description).trim(),
      implementation_notes: String(parsed.implementation_notes ?? "").trim(),
      reason: String(parsed.reason ?? "").trim(),
    };
  } catch {
    return null;
  }
}

// 打ち合わせ共通のシステムプロンプト（chat / finalize 用）
function buildMeetingSystem(candidate: CandidateRow): string {
  const actionLabel = ACTION_LABELS[candidate.action_type] ?? candidate.action_type;
  return `あなたはスモラ賃貸仲介のAIシステム改善の専門家です。竹内悠馬さんと一緒に、以下の改善案の実装仕様を固めています。具体的・実用的な提案をしてください。

【改善案の情報】
アクション: ${actionLabel}
検出件数: ${candidate.evidence_count ?? 1}件
パターンの理由: ${candidate.reason ?? "（なし）"}
パターンテキスト: ${candidate.template_text ?? "（なし）"}`;
}

// メッセージ履歴を Anthropic API の制約（先頭は user）に合わせて正規化
function normalizeHistory(messages: ChatMessage[]): ChatMessage[] {
  const history = messages.filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim());
  if (history[0]?.role === "assistant") {
    history.unshift({ role: "user", content: "この改善案パターンを分析し、実装仕様を一緒に固めてください。" });
  }
  return history;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      action: "start" | "chat" | "finalize";
      candidateId: string;
      messages?: ChatMessage[];
      userMessage?: string;
    };
    const { action, candidateId, messages, userMessage } = body;

    if (!candidateId || !action) {
      return NextResponse.json({ ok: false, error: "action and candidateId required" }, { status: 400 });
    }

    // 対象候補を取得
    const { data: candidate, error: candErr } = await supabase
      .from("ai_template_candidates")
      .select("id, action_type, template_text, original_text, reason, evidence_count")
      .eq("id", candidateId)
      .single<CandidateRow>();

    if (candErr || !candidate) {
      return NextResponse.json({ ok: false, error: candErr?.message ?? "candidate not found" }, { status: 404 });
    }

    // ── action: "start" ── Opus 4.8 が改善パターンを分析
    if (action === "start") {
      // 同じ action_type のスタッフ編集例（最大10件取得・プロンプトには5件まで）
      const { data: examples } = await supabase
        .from("ai_template_candidates")
        .select("original_text, template_text")
        .eq("action_type", candidate.action_type)
        .eq("source", "aix_edit")
        .eq("is_dismissed", false)
        .order("created_at", { ascending: false })
        .limit(10);

      const exampleText = (examples ?? [])
        .slice(0, 5)
        .map((ex, i) => {
          const orig = (ex.original_text ?? "").slice(0, 300);
          const edited = (ex.template_text ?? "").slice(0, 300);
          return `--- 例${i + 1} ---\nAI原文: ${orig || "（なし）"}\nスタッフ編集後: ${edited || "（なし）"}`;
        })
        .join("\n") || "（編集例なし）";

      const actionLabel = ACTION_LABELS[candidate.action_type] ?? candidate.action_type;
      const analysisPrompt = `あなたはスモラ賃貸仲介のAIシステム設計の専門家です。
以下の改善案パターンを分析し、具体的な実装提案を行ってください。

【改善パターン情報】
アクション: ${actionLabel}
検出件数: ${candidate.evidence_count ?? 1}件
パターンの理由: ${candidate.reason ?? "（なし）"}
パターンテキスト: ${candidate.template_text ?? "（なし）"}

【実際のスタッフ編集例（最大5件）】
${exampleText}

以下のフォーマットで回答してください：
1. パターンの要約（何がスタッフによって繰り返し追加されているか）
2. 推奨実装案（ボタン追加・トグル追加・サブモード追加のどれか + 具体的な動作）
3. 確認事項（竹内さんに確認すべき点）`;

      const res = await client.messages.create({
        model: "claude-opus-4-8",
        max_tokens: 1500,
        messages: [{ role: "user", content: analysisPrompt }],
      });
      const message = extractText(res.content);
      return NextResponse.json({ ok: true, message });
    }

    // ── action: "chat" ── マルチターンで仕様を詰める
    if (action === "chat") {
      const history = normalizeHistory(messages ?? []);
      // クライアントは userMessage を messages に含めて送るが、含まれていない場合は追加する
      const last = history[history.length - 1];
      if (userMessage?.trim() && (!last || last.role !== "user" || last.content !== userMessage)) {
        history.push({ role: "user", content: userMessage.trim() });
      }
      if (history.length === 0) {
        return NextResponse.json({ ok: false, error: "userMessage required" }, { status: 400 });
      }

      const res = await client.messages.create({
        model: "claude-opus-4-8",
        max_tokens: 1500,
        system: buildMeetingSystem(candidate),
        messages: history,
      });
      const message = extractText(res.content);
      return NextResponse.json({ ok: true, message });
    }

    // ── action: "finalize" ── 打ち合わせ内容をJSON仕様に落として転送
    if (action === "finalize") {
      const history = normalizeHistory(messages ?? []);
      history.push({
        role: "user",
        content: `今までの打ち合わせ内容をもとに、以下のJSON形式で実装仕様を出力してください。
説明文は不要。JSONのみ出力。
{
  "suggestion_type": "new_button" | "new_picker" | "new_sub_mode" | "new_aix",
  "suggested_title": "ボタン/機能名（15文字以内）",
  "description": "実装仕様の詳細（具体的に何をどこに追加するか）",
  "implementation_notes": "実装担当者へのメモ（どのファイルのどの部分を修正するか）",
  "reason": "なぜこの機能が必要か（1-2文）"
}`,
      });

      const res = await client.messages.create({
        model: "claude-opus-4-8",
        max_tokens: 1200,
        system: buildMeetingSystem(candidate),
        messages: history,
      });
      const spec = parseSpecJson(extractText(res.content));
      if (!spec) {
        return NextResponse.json({ ok: false, error: "仕様JSONの生成に失敗しました。もう一度お試しください。" }, { status: 500 });
      }

      const { error: insErr } = await supabase.from("aix_feature_suggestions").insert({
        suggestion_type: spec.suggestion_type,
        action_type: candidate.action_type,
        suggested_title: spec.suggested_title.slice(0, 60),
        description: spec.description,
        implementation_notes: spec.implementation_notes || null, // 専用カラムに分離（migrate-schemaで追加済み）
        reason: spec.reason || candidate.reason || null,
        evidence_count: Math.max(1, candidate.evidence_count ?? 1),
        status: "approved", // 打ち合わせ済みの確定状態（実装待ち）
      });
      if (insErr) {
        return NextResponse.json({ ok: false, error: insErr.message }, { status: 500 });
      }

      // 元候補を採用済みにして改善案タブから除外
      const { error: updErr } = await supabase
        .from("ai_template_candidates")
        .update({ is_adopted: true })
        .eq("id", candidate.id);
      if (updErr) {
        console.error("[improvement-meeting] candidate update error:", updErr.message);
      }

      return NextResponse.json({ ok: true, spec });
    }

    return NextResponse.json({ ok: false, error: `unknown action: ${action}` }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    console.error("[improvement-meeting] error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
