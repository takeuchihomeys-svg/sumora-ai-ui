import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { upsertKnowledge, generateEmbedding, buildKnowledgeEmbeddingInput } from "@/app/lib/knowledge-utils";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
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

// ============================================================
// AI盲点フィードバック（週次Opus4.8）
// 材料①: was_accurate=false の gap_analysis（予測が外れた理由 / 直近30日）
// 材料②: suggestion_bypassed / prediction_mismatch（スタッフがAI提案を無視・外れ）
// 材料③: ai_fallback依存度が高いaction（ルール未整備領域）
// 出力: 竹内さんへの質問 → ai_feedback_items（TemplateModal「❓ AI質問」タブで回答）
// ============================================================

type BlindSpotItem = {
  question: string;
  speculation?: string;
  category?: string;
  evidence?: string;
  confidence?: string;
};

async function discoverBlindSpots(): Promise<{ questionsSaved: number }> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // ① was_accurate=false の gap_analysis（外れた理由、直近30日）
  const { data: gapLogs } = await supabase
    .from("next_action_logs")
    .select("gap_analysis, validated_at, actual_aix_type, predicted_action")
    .eq("was_accurate", false)
    .not("gap_analysis", "is", null)
    .gte("validated_at", thirtyDaysAgo)
    .limit(30);

  // ② suggestion_bypassed / prediction_mismatch（無視・外れ）
  const { data: bypassed } = await supabase
    .from("action_pattern_logs")
    .select("conversation_status, customer_msg_summary, source, suggestion_source")
    .in("source", ["suggestion_bypassed", "prediction_mismatch"])
    .gte("created_at", thirtyDaysAgo)
    .limit(30);

  // ③ ai_fallback頻度（ルールの穴）
  const { data: fallbackRules } = await supabase
    .from("trigger_action_rules")
    .select("keyword, action_type, confidence, occurrence_count")
    .like("keyword", "SOURCE_ACCEPT_RATE:%:ai_fallback")
    .order("occurrence_count", { ascending: false })
    .limit(10);

  const hasMaterial = (gapLogs?.length ?? 0) > 0 || (bypassed?.length ?? 0) > 0 || (fallbackRules?.length ?? 0) > 0;
  if (!hasMaterial) {
    console.log("[corpus2skill] 盲点発見: 材料なしのためスキップ");
    return { questionsSaved: 0 };
  }

  const gapSection = (gapLogs ?? []).map((g, i) =>
    `【${i + 1}】予測: ${g.predicted_action} → 実際: ${g.actual_aix_type ?? "不明"}\n外れた理由: ${(g.gap_analysis as string).replace(/\n/g, " ").slice(0, 200)}`
  ).join("\n\n");

  const bypassedSection = (bypassed ?? []).map((b, i) =>
    `【${i + 1}】status=${b.conversation_status} source=${b.source}${b.suggestion_source ? ` 提案経路=${b.suggestion_source}` : ""}${b.customer_msg_summary ? `\n顧客メッセージ要約: ${(b.customer_msg_summary as string).replace(/\n/g, " ").slice(0, 150)}` : ""}`
  ).join("\n\n");

  const fallbackSection = (fallbackRules ?? []).map((f) =>
    `- ${f.keyword}（発生${f.occurrence_count ?? 0}回・採択率${typeof f.confidence === "number" ? Math.round(f.confidence * 100) : "?"}%）`
  ).join("\n");

  const res = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 3000,
    system: `あなたはLINE不動産接客AIの「盲点発見エージェント」です。AIが正確に理解できていない業務パターンを発見し、担当者への的確な質問を作ります。`,
    messages: [{
      role: "user",
      content: `以下のデータを分析して、AIが正確に理解できていない業務パターンを発見し、
担当者（竹内悠馬さん）への質問を生成してください。

【AIの予測が外れた場面（gap_analysis）】
${gapSection || "（なし）"}

【スタッフがAIの提案を無視して別行動した場面】
${bypassedSection || "（なし）"}

【Sonnetフォールバック依存度が高い場面（ルール未整備領域）】
${fallbackSection || "（なし）"}

以下の形式でJSON配列を出力してください（最大5件・説明文・コードフェンス不要）:
[{
  "question": "竹内さんへの質問（具体的に・1〜2文）",
  "speculation": "AIの憶測・仮説（「〜ではないかと思われますが...」形式）",
  "category": "new_flow|missing_keyword|weak_scene|new_aix_needed|general",
  "evidence": "根拠となったデータの要約（件数・パターン）",
  "confidence": "high|medium|low"
}]

良い質問の例:
- 「お客様が『審査が不安』と言った場合、どのような対応をするのが正しいですか？AIは現在『ヒアリング継続』と予測していますが、週3回外れています」
- 「物件URLと『スモ割』が同時に来た時のフローはどうなりますか？AIは憶測で対応しています」

悪い質問の例（避ける）:
- 「AIをどう改善しますか？」（抽象的すぎる）
- 「営業方針は？」（業務と無関係）

根拠の薄い質問は出さないこと。質問がない場合は [] を返す。`,
    }],
  });

  const text = res.content[0]?.type === "text" ? res.content[0].text.trim() : "";
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return { questionsSaved: 0 };

  let parsed: BlindSpotItem[] = [];
  try {
    parsed = JSON.parse(match[0]) as BlindSpotItem[];
  } catch {
    return { questionsSaved: 0 };
  }
  if (!Array.isArray(parsed)) return { questionsSaved: 0 };

  let questionsSaved = 0;
  const VALID_CATEGORIES = ["new_flow", "missing_keyword", "weak_scene", "new_aix_needed", "general"];
  const VALID_CONFIDENCE = ["high", "medium", "low"];

  for (const item of parsed.slice(0, 5)) {
    if (!item?.question?.trim()) continue;
    const question = item.question.trim();

    // dedup: question の先頭50字が一致する pending があればスキップ（同じ質問を何度も出さない）
    const escapedKey = question.slice(0, 50).replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    const { data: existing } = await supabase
      .from("ai_feedback_items")
      .select("id")
      .eq("status", "pending")
      .ilike("question", `${escapedKey}%`)
      .limit(1);
    if (existing && existing.length > 0) continue;

    const { error } = await supabase.from("ai_feedback_items").insert({
      question,
      speculation: item.speculation?.trim() || null,
      category: VALID_CATEGORIES.includes(item.category ?? "") ? item.category : "general",
      evidence: item.evidence?.trim() || null,
      confidence: VALID_CONFIDENCE.includes(item.confidence ?? "") ? item.confidence : "medium",
      status: "pending",
    });
    if (!error) questionsSaved++;
    else console.error("[corpus2skill] feedback item insert error:", error.message);
  }

  return { questionsSaved };
}

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  // 学習ヘルスモニタリング用の実行記録（morning-report が cron_run_logs を読んで状態を報告する）
  const runLogId = await startCronLog("corpus2skill");

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // 案4: 知識ライフサイクル管理 — 4週間使われていない corpus2skill 由来スキルを importance 9→7→5 と段階降格
  // importance < 7 になると generate-reply の match_reply_knowledge（min_importance=7）で自然に除外される
  // ※ ai_reply_knowledge に source / updated_at カラムは無いため、title 接頭辞 "[corpus2skill]" と
  //   created_at（4週間以上前に作成）+ last_used_at（NULL or 4週間以上未使用）で「古い未使用スキル」を判定する
  let degraded = 0;
  try {
    const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();
    const { data: staleSkills } = await supabase
      .from("ai_reply_knowledge")
      .select("id, importance")
      .like("title", "[corpus2skill]%")
      .lte("created_at", fourWeeksAgo)
      .or(`last_used_at.is.null,last_used_at.lte.${fourWeeksAgo}`)
      .gte("importance", 7); // importance < 7 はすでに降格済み（除外対象）

    for (const skill of staleSkills ?? []) {
      const newImportance = Math.max(1, (skill.importance as number) - 2); // 9→7→5 と2段階ずつ降格
      const { error } = await supabase
        .from("ai_reply_knowledge")
        .update({ importance: newImportance })
        .eq("id", skill.id);
      if (!error) degraded++;
    }
    console.log(`[corpus2skill] 古いスキル降格: ${degraded}件`);
  } catch (e) {
    console.error("[corpus2skill] スキル降格失敗:", e);
  }

  // P2: テンプレート品質改善タスク（テンプレ編集差分・AIX編集・採用/却下フィードバックを材料に週次提案）
  // ai_reply_examples の有無に関係なく実行する（材料が無ければ内部でスキップ）
  let templateImprovements = { candidatesSaved: 0, suggestionsSaved: 0 };
  try {
    templateImprovements = await synthesizeTemplateImprovements();
    console.log(`[corpus2skill] テンプレ改善: candidates=${templateImprovements.candidatesSaved} suggestions=${templateImprovements.suggestionsSaved}`);
  } catch (e) {
    console.error("[corpus2skill] テンプレ改善タスク失敗:", e);
  }

  // AI盲点フィードバック: 予測外れ・提案無視・fallback依存のデータから竹内さんへの質問を生成
  let blindSpots = { questionsSaved: 0 };
  try {
    blindSpots = await discoverBlindSpots();
    console.log(`[corpus2skill] 盲点発見: questions=${blindSpots.questionsSaved}`);
  } catch (e) {
    console.error("[corpus2skill] 盲点発見タスク失敗:", e);
  }

  const { data: examples } = await supabase
    .from("ai_reply_examples")
    .select("id, conversation_id, created_at, sent_reply, ai_draft, conversation_state, customer_message, was_ai_modified")
    .gte("created_at", since)
    .not("sent_reply", "is", null)
    .order("created_at", { ascending: false })
    .limit(200) as { data: Example[] | null };

  if (!examples || examples.length === 0) {
    await finishCronLog(runLogId, true, {
      reason: "no examples found",
      degraded,
      templateCandidatesSaved: templateImprovements.candidatesSaved,
      aixSuggestionsSaved: templateImprovements.suggestionsSaved,
      feedbackQuestionsSaved: blindSpots.questionsSaved,
    });
    return NextResponse.json({
      ok: false,
      reason: "no examples found",
      degraded,
      templateCandidatesSaved: templateImprovements.candidatesSaved,
      aixSuggestionsSaved: templateImprovements.suggestionsSaved,
      feedbackQuestionsSaved: blindSpots.questionsSaved,
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

  console.log(`[corpus2skill] 完了: inserted=${totalInserted}, merged=${totalMerged}, degraded=${degraded}`);
  await finishCronLog(runLogId, true, {
    inserted: totalInserted,
    merged: totalMerged,
    degraded,
    examplesProcessed: examples.length,
    templateCandidatesSaved: templateImprovements.candidatesSaved,
    aixSuggestionsSaved: templateImprovements.suggestionsSaved,
    feedbackQuestionsSaved: blindSpots.questionsSaved,
  });
  return NextResponse.json({
    ok: true,
    inserted: totalInserted,
    merged: totalMerged,
    degraded,
    examplesProcessed: examples.length,
    templateCandidatesSaved: templateImprovements.candidatesSaved,
    aixSuggestionsSaved: templateImprovements.suggestionsSaved,
    feedbackQuestionsSaved: blindSpots.questionsSaved,
  });
}
