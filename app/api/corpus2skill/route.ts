import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { upsertKnowledge, generateEmbedding, buildKnowledgeEmbeddingInput } from "@/app/lib/knowledge-utils";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 300;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "", timeout: 120_000, maxRetries: 1 });

const STATE_NORMALIZE: Record<string, string> = {
  condition_hearing: "hearing", property_search: "hearing",
  property_recommendation: "proposing", viewing: "proposing",
  estimate_request: "proposing", availability_check: "proposing",
  application: "applying", screening: "applying", contract: "applying",
};

// AIXアクション → テンプレートカテゴリ変換
// ※ app/api/ai-template-candidates/route.ts の ACTION_TO_CATEGORY と一致させること
const ACTION_TO_CATEGORY: Record<string, string> = {
  property_send: "物件ピックアップした【AIX】",
  property_recommendation: "物件オススメ【AIX】",
  property_check_result: "物件確認した【AIX】",
  viewing_invite: "内覧へ！【AIX】",
  application_push: "申込へ！【AIX】",
  meeting_place: "内覧【AIX】",
  condition_hearing: "ヒアリング【AIX】",
  estimate_sheet: "見積書送る【AIX】",
  greeting_viewing: "内覧【AIX】",
  followup_revive: "追客【AIX】",
  acknowledge_check: "確認します【AIX】",
};

type Example = {
  id: string;
  conversation_id: string | null;
  created_at: string;
  sent_reply: string;
  ai_draft: string | null;
  conversation_state: string;
  customer_message: string;
  was_ai_modified: boolean;
};

type Skill = {
  title: string;
  content: string;
  trigger?: string;
};

async function synthesizeSkills(state: string, examples: Example[], chainSection = ""): Promise<Skill[]> {
  const examplesText = examples.slice(0, 15).map((e, i) => {
    const label = e.was_ai_modified
      ? "🔴 スタッフがAIを改善（AIがまだ弱いパターン）"
      : "✅ AIをそのまま使用（スタッフが承認した良い例）";
    return `
--- 例${i + 1} [${label}] ---
顧客: ${(e.customer_message || "").slice(0, 150)}
${e.ai_draft ? `AI案: ${e.ai_draft.slice(0, 300)}\n` : ""}実際に送った返信: ${e.sent_reply.slice(0, 300)}`;
  }).join("\n");

  const res = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 2000,
    temperature: 0,
    system: `あなたは賃貸仲介の営業コーチです。スタッフの実際の返信例を分析し、優秀な担当者が使う普遍的なスキルを抽出します。`,
    messages: [{
      role: "user",
      content: `以下は【${state}】フェーズでの過去7日間の返信例です。

${examplesText}
${chainSection}
各例には2種類のラベルが付いています：
- ✅ AIをそのまま使用 → AIが既に習得済みの良いパターン（強化すべき）
- 🔴 スタッフがAIを改善 → AIがまだ弱いパターン（特に学ぶべき）

この2つのコントラストを活かして「優秀な賃貸営業担当者が使う普遍的なスキル・パターン」を、意味のあるものを全て抽出してください。数は自分で判断してください。

条件：
- 固有名詞・物件名・日時に依存しない、どの顧客にも使える普遍パターンのみ
- 薄い・当たり前すぎるものは除外（本当に価値のあるものだけ）
- 「できる営業担当者は〇〇する」という形式で書く
- 🔴の例からは「AIが苦手なこと」、✅の例からは「既に正解しているパターン」として区別して抽出
- 「連続対応シーケンス」がある場合は、単発の返信スキルに加えて「空室確認→見積送付」のような複数アクションのセット運用パターンも抽出対象とする

JSON配列のみ返す（説明不要）：
[
  {
    "title": "スキル名（25文字以内）",
    "content": "このスキルの詳細説明と具体的な使い方（200文字以内）",
    "trigger": "このスキルが特に活きる顧客状況の例文（50文字以内）"
  }
]`,
    }],
  });

  const text = res.content[0].type === "text" ? res.content[0].text.trim() : "";
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    return JSON.parse(match[0]) as Skill[];
  } catch {
    return [];
  }
}

// ============================================================
// P2: テンプレート品質改善タスク（週次Opus4.8）
// 材料A: template_needs_update_*（頻繁に手修正されるテンプレ / analyze-template-modifications が蓄積）
// 材料B: aix_edit 候補（AIX生成後にスタッフが編集したパターン / evidence_count順）
// 材料C: 過去の採用/却下フィードバック（良い提案の見本 / 出すべきでないパターン）
// 出力: template_revision / new_template → ai_template_candidates (source="opus_weekly")
//       new_aix_picker → aix_feature_suggestions
// ============================================================

type TemplateProposal = {
  type: "template_revision" | "new_template" | "new_aix_picker";
  action_type?: string;
  suggested_title?: string;
  template_text?: string;
  reason?: string;
  evidence_count?: number;
};

async function synthesizeTemplateImprovements(): Promise<{ candidatesSaved: number; suggestionsSaved: number }> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // 材料A: テンプレ編集差分（ai_prompts の template_needs_update_* キーを消費）
  const { data: needsUpdateKeys } = await supabase
    .from("ai_prompts")
    .select("key, content")
    .like("key", "template_needs_update_%")
    .limit(20);

  // 材料A補足: 対象テンプレの本文を引く（Opusに「何が頻繁に直されているか」の実体を渡す）
  const needsUpdateIds = (needsUpdateKeys ?? [])
    .map((k) => {
      try { return (JSON.parse(k.content as string) as { template_id?: string }).template_id ?? null; }
      catch { return null; }
    })
    .filter((v): v is string => !!v);
  let needsUpdateTemplates: Array<{ id: string; category: string; label: string; text: string }> = [];
  if (needsUpdateIds.length > 0) {
    const { data } = await supabase
      .from("templates")
      .select("id, category, label, text")
      .in("id", needsUpdateIds);
    needsUpdateTemplates = (data ?? []) as typeof needsUpdateTemplates;
  }

  // 材料B: AIX編集候補（過去30日・evidence_count順）
  const { data: aixEdits } = await supabase
    .from("ai_template_candidates")
    .select("action_type, suggested_title, original_text, template_text, evidence_count, reason")
    .eq("source", "aix_edit")
    .gte("created_at", thirtyDaysAgo)
    .order("evidence_count", { ascending: false })
    .limit(30);

  // 材料C: 採用/却下フィードバック
  const [{ data: adopted }, { data: dismissed }] = await Promise.all([
    supabase
      .from("ai_template_candidates")
      .select("suggested_title, reason, action_type")
      .eq("is_adopted", true)
      .limit(20),
    supabase
      .from("ai_template_candidates")
      .select("suggested_title, dismissed_reason, action_type")
      .eq("is_dismissed", true)
      .not("dismissed_reason", "is", null)
      .limit(20),
  ]);

  const hasMaterial = (needsUpdateKeys?.length ?? 0) > 0 || (aixEdits?.length ?? 0) > 0;
  if (!hasMaterial) {
    console.log("[corpus2skill] テンプレ改善: 材料なしのためスキップ");
    return { candidatesSaved: 0, suggestionsSaved: 0 };
  }

  const needsUpdateSection = (needsUpdateKeys ?? []).map((k) => {
    const templateId = k.key.replace("template_needs_update_", "");
    const t = needsUpdateTemplates.find((x) => x.id === templateId);
    return `- ${k.content}${t ? `\n  テンプレ名: ${t.label}（${t.category}）\n  本文: ${t.text.replace(/\n/g, " ").slice(0, 200)}` : ""}`;
  }).join("\n");

  const aixEditsSection = (aixEdits ?? []).map((e, i) =>
    `【${i + 1}】action=${e.action_type} evidence_count=${e.evidence_count ?? 1}${e.reason ? ` reason=${e.reason}` : ""}
${e.original_text ? `AI原文: ${(e.original_text as string).replace(/\n/g, " ").slice(0, 250)}\n` : ""}スタッフ編集後: ${(e.template_text as string).replace(/\n/g, " ").slice(0, 250)}`
  ).join("\n\n");

  const adoptedSection = (adopted ?? []).map((a) =>
    `- [${a.action_type}] ${a.suggested_title}${a.reason ? `（${a.reason}）` : ""}`
  ).join("\n");

  const dismissedSection = (dismissed ?? []).map((d) =>
    `- [${d.action_type}] ${d.suggested_title} → 却下理由: ${d.dismissed_reason}`
  ).join("\n");

  const res = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 4000,
    temperature: 0,
    system: `あなたは賃貸仲介LINE接客のテンプレート・AI機能の品質改善コンサルタントです。実データの編集パターンから改善提案を作ります。`,
    messages: [{
      role: "user",
      content: `---
## 【テンプレート品質改善タスク】

### 頻繁に修正されているテンプレート（要改訂）
${needsUpdateSection || "（なし）"}

### AIX生成後にスタッフが編集したパターン（上位30件）
${aixEditsSection || "（なし）"}

### 過去の採用例（良い提案の見本）
${adoptedSection || "（なし）"}

### 過去の却下例と理由（出すべきでないパターン）
${dismissedSection || "（なし）"}

上記の分析から、以下の3種類の提案をしてください:
1. **既存テンプレの改訂案**（頻繁に同じ方向に修正されているもの）: reason（なぜ改訂が必要か・何回修正されたか）付きで
2. **新テンプレ案**（繰り返し手入力されているが既存テンプレにない場面）: reason付きで
3. **新AIX/ピッカー案**（毎回同じ固有情報を手入力しているパターン）: どんなフォームが必要か

各提案はJSON配列で（説明文・コードフェンス不要）:
[{"type": "template_revision"|"new_template"|"new_aix_picker", "action_type": "...", "suggested_title": "...", "template_text": "...", "reason": "...", "evidence_count": N}]

根拠の薄い提案は出さないこと。提案がない場合は [] を返す。`,
    }],
  });

  const text = res.content[0]?.type === "text" ? res.content[0].text.trim() : "";
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return { candidatesSaved: 0, suggestionsSaved: 0 };

  let proposals: TemplateProposal[] = [];
  try {
    proposals = JSON.parse(match[0]) as TemplateProposal[];
  } catch {
    return { candidatesSaved: 0, suggestionsSaved: 0 };
  }
  if (!Array.isArray(proposals)) return { candidatesSaved: 0, suggestionsSaved: 0 };

  let candidatesSaved = 0;
  let suggestionsSaved = 0;

  for (const p of proposals) {
    if (!p?.type || !p.suggested_title?.trim()) continue;

    if (p.type === "template_revision" || p.type === "new_template") {
      if (!p.template_text?.trim()) continue;
      const actionType = p.action_type ?? "unknown";
      const category = ACTION_TO_CATEGORY[actionType] ?? "その他【AIX】";
      const textBody = p.template_text.trim();

      // 重複チェック: 同カテゴリ・先頭50文字一致の未却下候補があればスキップ
      const escapedKey = textBody.slice(0, 50).replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
      const { data: existing } = await supabase
        .from("ai_template_candidates")
        .select("id")
        .eq("category", category)
        .eq("is_dismissed", false)
        .ilike("template_text", `${escapedKey}%`)
        .limit(1);
      if (existing && existing.length > 0) continue;

      const { error } = await supabase.from("ai_template_candidates").insert({
        action_type: actionType,
        category,
        suggested_title: `${p.type === "template_revision" ? "[改訂案] " : ""}${p.suggested_title.trim().slice(0, 40)}`,
        template_text: textBody,
        conversation_id: null,
        source: "opus_weekly",
        reason: p.reason?.trim() || null,
        evidence_count: Math.max(1, Number(p.evidence_count) || 1),
      });
      if (!error) candidatesSaved++;
      else console.error("[corpus2skill] candidate insert error:", error.message);
    } else if (p.type === "new_aix_picker") {
      // 重複チェック: 同タイトルの pending 提案があればスキップ
      const { data: existing } = await supabase
        .from("aix_feature_suggestions")
        .select("id")
        .eq("status", "pending")
        .eq("suggested_title", p.suggested_title.trim())
        .limit(1);
      if (existing && existing.length > 0) continue;

      const { error } = await supabase.from("aix_feature_suggestions").insert({
        suggestion_type: "new_picker",
        action_type: p.action_type ?? null,
        suggested_title: p.suggested_title.trim().slice(0, 60),
        description: p.template_text?.trim() || null,
        reason: p.reason?.trim() || null,
        evidence_count: Math.max(1, Number(p.evidence_count) || 1),
        status: "pending",
      });
      if (!error) suggestionsSaved++;
      else console.error("[corpus2skill] suggestion insert error:", error.message);
    }
  }

  return { candidatesSaved, suggestionsSaved };
}

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // P2: テンプレート品質改善タスク（テンプレ編集差分・AIX編集・採用/却下フィードバックを材料に週次提案）
  // ai_reply_examples の有無に関係なく実行する（材料が無ければ内部でスキップ）
  let templateImprovements = { candidatesSaved: 0, suggestionsSaved: 0 };
  try {
    templateImprovements = await synthesizeTemplateImprovements();
    console.log(`[corpus2skill] テンプレ改善: candidates=${templateImprovements.candidatesSaved} suggestions=${templateImprovements.suggestionsSaved}`);
  } catch (e) {
    console.error("[corpus2skill] テンプレ改善タスク失敗:", e);
  }

  const { data: examples } = await supabase
    .from("ai_reply_examples")
    .select("id, conversation_id, created_at, sent_reply, ai_draft, conversation_state, customer_message, was_ai_modified")
    .gte("created_at", since)
    .not("sent_reply", "is", null)
    .order("created_at", { ascending: false })
    .limit(200) as { data: Example[] | null };

  if (!examples || examples.length === 0) {
    return NextResponse.json({
      ok: false,
      reason: "no examples found",
      templateCandidatesSaved: templateImprovements.candidatesSaved,
      aixSuggestionsSaved: templateImprovements.suggestionsSaved,
    });
  }

  // ── 連続対応シーケンス抽出（チェーンパターン学習用）──────────────────────
  // 同一 conversation_id の連続レコードをシーケンスとしてグループ化し、
  // created_at の差が24時間超のギャップで分割（別日の対応は別シーケンス扱い）
  const byConversation = new Map<string, Example[]>();
  for (const ex of examples) {
    if (!ex.conversation_id) continue;
    const group = byConversation.get(ex.conversation_id) ?? [];
    group.push(ex);
    byConversation.set(ex.conversation_id, group);
  }
  const GAP_MS = 24 * 60 * 60 * 1000;
  const chainSequences: Example[][] = [];
  for (const group of byConversation.values()) {
    // 取得は created_at 降順のため昇順に並べ直してから分割する
    const sorted = [...group].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    let current: Example[] = [];
    for (const ex of sorted) {
      const prev = current[current.length - 1];
      if (prev && new Date(ex.created_at).getTime() - new Date(prev.created_at).getTime() > GAP_MS) {
        // 2件以上の連続対応のみチェーンパターンとして採用
        if (current.length >= 2) chainSequences.push(current);
        current = [];
      }
      current.push(ex);
    }
    if (current.length >= 2) chainSequences.push(current);
  }
  // Opusプロンプト肥大防止のため最大20シーケンス
  const limitedSequences = chainSequences.slice(0, 20);
  const chainSection = limitedSequences.length > 0 ? `
## 連続対応シーケンス（同一顧客への複数アクションのセット・チェーンパターン抽出用）
${limitedSequences.map((g) =>
  `【会話 ${g[0].conversation_id?.slice(-6)}】\n` +
  g.map((e, i) => `  ${i + 1}. [${e.conversation_state}] 顧客:「${(e.customer_message ?? "").slice(0, 50)}」→ 送信:「${(e.sent_reply ?? "").slice(0, 80)}」`).join("\n")
).join("\n\n")}
` : "";

  // 正規化されたフェーズ別にグループ化
  const byState = new Map<string, Example[]>();
  for (const ex of examples) {
    const state = STATE_NORMALIZE[ex.conversation_state] ?? ex.conversation_state ?? "hearing";
    const arr = byState.get(state) ?? [];
    arr.push(ex);
    byState.set(state, arr);
  }

  let totalInserted = 0;
  let totalMerged = 0;

  for (const [state, stateExamples] of byState) {
    if (stateExamples.length < 3) {
      console.log(`[corpus2skill] ${state}: ${stateExamples.length}件のためスキップ（3件以上必要）`);
      continue;
    }

    console.log(`[corpus2skill] ${state}: ${stateExamples.length}件からスキル合成開始`);

    let skills: Skill[];
    try {
      skills = await synthesizeSkills(state, stateExamples, chainSection);
    } catch (e) {
      console.error(`[corpus2skill] ${state} 合成失敗:`, e);
      continue;
    }

    for (const skill of skills) {
      if (!skill.title || !skill.content || skill.content.length < 20) continue;

      const embeddingInput = buildKnowledgeEmbeddingInput({
        trigger_example: skill.trigger,
        content: skill.content,
        conversation_state: state,
      });
      const embedding = await generateEmbedding(embeddingInput).catch(() => null);

      const result = await upsertKnowledge(supabase, {
        title: `[corpus2skill] ${skill.title}`,
        content: skill.content,
        category: "pattern",
        importance: 9,
        conversation_state: state,
        ...(embedding ? { embedding } : {}),
        ...(skill.trigger ? { trigger_example: skill.trigger } : {}),
      });

      if (result === "inserted") totalInserted++;
      else if (result === "merged") totalMerged++;
    }
  }

  console.log(`[corpus2skill] 完了: inserted=${totalInserted}, merged=${totalMerged}`);
  return NextResponse.json({
    ok: true,
    inserted: totalInserted,
    merged: totalMerged,
    examplesProcessed: examples.length,
    templateCandidatesSaved: templateImprovements.candidatesSaved,
    aixSuggestionsSaved: templateImprovements.suggestionsSaved,
  });
}
