import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { upsertKnowledge, generateEmbedding, buildKnowledgeEmbeddingInput } from "@/app/lib/knowledge-utils";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import { safeInsertAiQuestion } from "@/app/lib/ai-feedback-guard";
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

// ============================================================
// Anthropic APIレスポンスのパース堅牢化ヘルパー
// - adaptive thinking 対応: content[0] が thinking ブロックの場合があるため
//   必ず content.find(b => b.type === "text") でテキストを取得する
// - コードフェンス（```json ... ```）を優先的に取り除いてから JSON.parse する
// - parse失敗件数を parseErrors にカウントし cron_run_logs に記録する
// ============================================================

// リクエスト単位のparse失敗カウンタ（POST冒頭でリセット。重複実行ガードにより同時実行はない）
let parseErrors = 0;

function extractTextBlock(content: Anthropic.Message["content"] | undefined): string {
  return content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text?.trim() ?? "";
}

function extractJson(text: string): string {
  // コードフェンス優先
  const m = text.match(/```(?:json)?\n?([\s\S]*?)```/);
  const body = m ? m[1].trim() : text;
  // 本ファイルの全プロンプトはJSON配列を要求するため [ ... ] を抽出
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) return body.slice(start, end + 1);
  return body.trim();
}

// 戻り値: T[] = パース成功（空配列は「モデルが正当に [] を返した」）
//         null = パース失敗（parseErrors にカウント済み。呼び出し元は材料消費等の副作用を避けること）
function parseJsonArray<T>(text: string, label: string): T[] | null {
  if (!text) {
    parseErrors++;
    console.warn(`[corpus2skill] ${label}: textブロックが空（thinkingのみ／max_tokens到達の可能性）`);
    return null;
  }
  const jsonText = extractJson(text);
  try {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) {
      parseErrors++;
      console.warn(`[corpus2skill] ${label}: JSONパース結果が配列でない: ${jsonText.slice(0, 120)}`);
      return null;
    }
    return parsed as T[];
  } catch {
    parseErrors++;
    console.warn(`[corpus2skill] ${label}: JSONパース失敗 (先頭200字): ${jsonText.slice(0, 200)}`);
    return null;
  }
}

// ── synthesizeSkills 用の静的システムプロンプト（prompt cache 対象）──
// 動的データ（フェーズ名・返信例・チェーンシーケンス）は user メッセージに分離する
const SYNTHESIZE_SKILLS_SYSTEM = `あなたは賃貸仲介の営業コーチです。スタッフの実際の返信例を分析し、優秀な担当者が使う普遍的なスキルを抽出します。

ユーザーメッセージには特定フェーズでの過去7日間の返信例が渡されます。各例には3種類のラベルが付いています：
- ✍️ スタッフ手書き → AIを介さずスタッフが自力で書いた返信（最良の教師データ・最も重視する）
- ✅ AIをそのまま使用 → AIが既に習得済みの良いパターン（強化すべき）
- 🔴 AIを修正 → AIがまだ弱いパターン（特に学ぶべき）

この3つのコントラストを活かして「優秀な賃貸営業担当者が使う普遍的なスキル・パターン」を、意味のあるものを全て抽出してください。数は自分で判断してください。

条件：
- 固有名詞・物件名・日時に依存しない、どの顧客にも使える普遍パターンのみ
- 薄い・当たり前すぎるものは除外（本当に価値のあるものだけ）
- 「できる営業担当者は〇〇する」という形式で書く
- ✍️の例からは「スタッフ独自の型・お手本」、🔴の例からは「AIが苦手なこと」、✅の例からは「既に正解しているパターン」として区別して抽出
- 🔴の例で「AI案にあってスタッフが削除した文言」がある場合は、禁止スキルとして抽出しない。代わりに、なぜその文言が削除されたか・どういう顧客状況なら使えるかを考察し、プロンプトや知識の曖昧さを補う質問として skill のリストには含めず、別途フィードバックとして扱う（スキル化しない）
- 「連続対応シーケンス」がある場合は、単発の返信スキルに加えて「空室確認→見積送付」のような複数アクションのセット運用パターンも抽出対象とする

JSON配列のみ返す（説明不要）：
[
  {
    "title": "スキル名（25文字以内）",
    "content": "このスキルの詳細説明と具体的な使い方（200文字以内）",
    "trigger": "このスキルが特に活きる顧客状況の例文（50文字以内）"
  }
]`;

async function synthesizeSkills(state: string, examples: Example[], chainSection = ""): Promise<Skill[]> {
  const examplesText = examples.slice(0, 15).map((e, i) => {
    // 改善⑦: 2値→3値ラベル。ai_draftなしの手書き返信を「AIそのまま使用」と誤ラベルしない
    const label = (!e.ai_draft || !e.ai_draft.trim())
      ? "✍️ スタッフ手書き（最良の教師データ）"
      : e.was_ai_modified
        ? "🔴 AIを修正（修正内容から学習）"
        : "✅ AIをそのまま使用（スタッフが承認した良い例）";
    return `
--- 例${i + 1} [${label}] ---
顧客: ${(e.customer_message || "").slice(0, 150)}
${e.ai_draft ? `AI案: ${e.ai_draft.slice(0, 300)}\n` : ""}実際に送った返信: ${e.sent_reply.slice(0, 300)}`;
  }).join("\n");

  const res = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 2000,
    // prompt cache: 静的な抽出指示（SYNTHESIZE_SKILLS_SYSTEM）をキャッシュし、動的データは user に分離
    system: [
      { type: "text", text: SYNTHESIZE_SKILLS_SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
    messages: [{
      role: "user",
      content: `以下は【${state}】フェーズでの過去7日間の返信例です。

${examplesText}
${chainSection}`,
    }],
  });

  return parseJsonArray<Skill>(extractTextBlock(res.content), `synthesizeSkills(${state})`) ?? [];
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

// fallback: 判定できなかった時のカテゴリ。new_aix_picker 提案は "new_picker" を渡す
// （以前は一律 "other" に落ちて改善案タブの「②ピッカー」フィルターに1件も表示されなかった）
function detectCategory(description: string, fallback: string = "other"): string {
  if (description.startsWith("【新ボタン】")) return "new_button";
  if (/新ピッカー|新しいAIXボタン/.test(description)) return "new_picker";
  if (/プロンプト|生成文の改善|ルール追加/.test(description)) return "text_improvement";
  if (/ズレ|乖離/.test(description)) return "mismatch_fix";
  return fallback;
}

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

  // 材料C: 採用/却下フィードバック（テンプレ候補）
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

  // 材料D: 改善案（aix_feature_suggestions）の却下理由・確定仕様
  // ※ aix_feature_suggestions に updated_at カラムがないため created_at で代用
  const [{ data: dismissedSuggestions }, { data: approvedSuggestions }] = await Promise.all([
    // 却下された改善案の理由（同じ案を再提案しないため）
    supabase
      .from("aix_feature_suggestions")
      .select("action_type, description, dismissed_reason")
      .eq("status", "dismissed")
      .not("dismissed_reason", "is", null)
      .gte("created_at", thirtyDaysAgo)
      .limit(10),
    // 確定仕様（approved）= improvement-meeting で詰めた実装ノート（参考情報として渡す）
    supabase
      .from("aix_feature_suggestions")
      .select("action_type, description, implementation_notes")
      .in("status", ["approved", "implemented"])
      .not("implementation_notes", "is", null)
      .gte("created_at", thirtyDaysAgo)
      .limit(10),
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
${e.original_text ? `AI原文: ${(e.original_text as string).replace(/\n/g, " ").slice(0, 250)}\n` : ""}スタッフ編集後: ${(e.template_text ?? "").replace(/\n/g, " ").slice(0, 250)}`
  ).join("\n\n");

  const adoptedSection = (adopted ?? []).map((a) =>
    `- [${a.action_type}] ${a.suggested_title}${a.reason ? `（${a.reason}）` : ""}`
  ).join("\n");

  const dismissedSection = (dismissed ?? []).map((d) =>
    `- [${d.action_type}] ${d.suggested_title} → 却下理由: ${d.dismissed_reason}`
  ).join("\n");

  const dismissedSuggestionsSection = (dismissedSuggestions ?? []).map((s) =>
    `- [${s.action_type ?? "?"}] ${(s.description as string ?? "").slice(0, 80)} → 却下理由: ${s.dismissed_reason as string}`
  ).join("\n");

  const approvedSuggestionsSection = (approvedSuggestions ?? []).map((s) =>
    `- [${s.action_type ?? "?"}] ${(s.description as string ?? "").slice(0, 80)}\n  実装ノート: ${((s.implementation_notes as string) ?? "").slice(0, 200)}`
  ).join("\n");

  const res = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 4000,
    // prompt cache: 静的な提案指示を system 側でキャッシュし、動的な材料データは user に分離
    system: [
      {
        type: "text",
        text: `あなたは賃貸仲介LINE接客のテンプレート・AI機能の品質改善コンサルタントです。実データの編集パターンから改善提案を作ります。

ユーザーメッセージに渡されるデータの分析から、以下の3種類の提案をしてください:
1. **既存テンプレの改訂案**（頻繁に同じ方向に修正されているもの）: reason（なぜ改訂が必要か・何回修正されたか）付きで
2. **新テンプレ案**（繰り返し手入力されているが既存テンプレにない場面）: reason付きで
3. **新AIX/ピッカー案**（毎回同じ固有情報を手入力しているパターン）: template_text には「①何を観察したか（何を毎回手入力しているか）②なぜ改善が必要か（スタッフの手間・AIの精度低下）③期待される効果」を必ず含めた説明文を書き、どんなフォーム/選択肢が必要かも記述する

各提案はJSON配列で（説明文・コードフェンス不要）:
[{"type": "template_revision"|"new_template"|"new_aix_picker", "action_type": "...", "suggested_title": "...", "template_text": "...", "reason": "...", "evidence_count": N}]

根拠の薄い提案は出さないこと。提案がない場合は [] を返す。`,
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
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

### 却下されたAIX改善案と理由（同様の提案を避けること）
${dismissedSuggestionsSection || "（なし）"}

### 確定済みのAIX改善仕様（improvement-meeting で合意済み・参考として）
${approvedSuggestionsSection || "（なし）"}`,
    }],
  });

  // parse失敗（null）時は早期return: 材料A（needsUpdateKeys）を未消費のまま残し、翌週再試行させる
  const proposals = parseJsonArray<TemplateProposal>(extractTextBlock(res.content), "synthesizeTemplateImprovements");
  if (proposals === null) return { candidatesSaved: 0, suggestionsSaved: 0 };

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

      const descriptionText = p.template_text?.trim() || "";
      const { error } = await supabase.from("aix_feature_suggestions").insert({
        suggestion_type: "new_picker",
        action_type: p.action_type ?? null,
        suggested_title: p.suggested_title.trim().slice(0, 60),
        description: descriptionText || null,
        reason: p.reason?.trim() || null,
        evidence_count: Math.max(1, Number(p.evidence_count) || 1),
        status: "pending",
        proposal_category: detectCategory(descriptionText, "new_picker"),
      });
      if (!error) suggestionsSaved++;
      else console.error("[corpus2skill] suggestion insert error:", error.message);
    }
  }

  // 材料A消費: 使用した template_needs_update_* キーを ai_prompts から削除
  // （削除しないと翌週も同じ改訂案が再提案される無限ループになる）
  if ((needsUpdateKeys?.length ?? 0) > 0) {
    const consumedKeys = (needsUpdateKeys ?? []).map((k) => k.key as string);
    await supabase.from("ai_prompts").delete().in("key", consumedKeys);
  }

  return { candidatesSaved, suggestionsSaved };
}

// ============================================================
// AIX生成文 vs 実送信文のズレ分析（週次）
// aix_generate_log と ai_reply_examples を conversation_id でJOINし、
// 30%以上ズレているペアをOpusに渡して改善案を aix_feature_suggestions に登録する
//
// 【修正履歴】aix_usage_logs → aix_generate_log に変更
//   理由: aix_usage_logs.generated_text はスタッフ送信テキスト（編集後）が入るため
//   ai_reply_examples.sent_reply と同じ値になり bigramJaccardDiff ≈ 0 となる。
//   正規テーブルは aix/action/route.ts の finalizeResponse が generated_text を INSERT する
//   aix_generate_log であり、こちらが真の「AIX原文」を持つ。
//   また generated_text が非 NULL の割合が aix_usage_logs では 18.6% に留まるが、
//   aix_generate_log は conversationId のある全アクションで INSERT される。
// ============================================================

// 2文字グラム（bigram）集合を作成
function buildBigramsC2S(s: string): Set<string> {
  const set = new Set<string>();
  const text = s.replace(/\s+/g, "");
  for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2));
  return set;
}
// bigram Jaccard 距離（0=完全一致, 1=完全不一致）
function bigramJaccardDiff(a: string, b: string): number {
  const biA = buildBigramsC2S(a);
  const biB = buildBigramsC2S(b);
  if (biA.size === 0 && biB.size === 0) return 0;
  let intersection = 0;
  for (const g of biA) { if (biB.has(g)) intersection++; }
  const union = biA.size + biB.size - intersection;
  return union === 0 ? 0 : 1 - intersection / union;
}

async function analyzeAixMismatch(): Promise<{ pairsFound: number; suggestionsInserted: number }> {
  // 過去14日のAIX生成文 vs 実送信文のズレを分析
  // aix_generate_log（AIX原文）を使い、ai_reply_examples（実送信）と conversation_id でJOIN する
  const { data: pairs } = await supabase
    .from("aix_generate_log")
    .select("conversation_id, generated_text, action_type, generated_at")
    .gte("generated_at", new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString())
    .not("generated_text", "is", null)
    .not("conversation_id", "is", null)
    .limit(50);

  if (!pairs || pairs.length === 0) {
    console.log("[corpus2skill] analyzeAixMismatch: aix_generate_log データなし → スキップ");
    return { pairsFound: 0, suggestionsInserted: 0 };
  }

  const convIds = pairs.map((p: { conversation_id: string }) => p.conversation_id).filter(Boolean);
  // ai_reply_examples の正しいカラム名を使用（text → sent_reply, aix_type カラムは存在しない）
  const { data: examples } = await supabase
    .from("ai_reply_examples")
    .select("conversation_id, sent_reply")
    .in("conversation_id", convIds)
    .not("sent_reply", "is", null);

  if (!examples || examples.length === 0) {
    console.log("[corpus2skill] analyzeAixMismatch: ai_reply_examples データなし → スキップ");
    return { pairsFound: 0, suggestionsInserted: 0 };
  }

  // Pairを作る
  type MismatchPair = {
    conversation_id: string;
    generated: string;
    sent: string;
    aix_type: string;
    diff_ratio: number;
  };
  const mismatchPairs: MismatchPair[] = [];
  for (const p of pairs) {
    const ex = examples.find((e: { conversation_id: string }) => e.conversation_id === p.conversation_id);
    if (!ex) continue;
    const gen = String((p as { generated_text?: string }).generated_text ?? "");
    const sent = String((ex as { sent_reply?: string }).sent_reply ?? "");
    if (!gen || !sent) continue;
    // bigram Jaccard 距離（日本語の共通文字の誤ヒットを防ぐトークンレベル距離）
    const diffRatio = bigramJaccardDiff(gen, sent);
    if (diffRatio > 0.3) { // 30%以上ズレていたら対象
      mismatchPairs.push({
        conversation_id: p.conversation_id,
        generated: gen.slice(0, 200),
        sent: sent.slice(0, 200),
        aix_type: String((p as { action_type?: string }).action_type ?? ""),
        diff_ratio: diffRatio,
      });
    }
  }

  if (mismatchPairs.length === 0) {
    console.log(`[corpus2skill] analyzeAixMismatch: pairsFound=${pairs.length} 件取得も diffRatio>0.3 ペアなし → スキップ`);
    return { pairsFound: pairs.length, suggestionsInserted: 0 };
  }

  // Opusにズレ原因分析を依頼
  // prompt cache: 静的な分析指示を system 側でキャッシュし、動的なペア一覧は user に分離
  const resp = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 2000,
    system: [
      {
        type: "text",
        text: `ユーザーメッセージにはAIが生成したLINEメッセージと、スタッフが実際に送ったメッセージのペアが渡されます。
ズレの原因を分析して、改善提案を生成してください。

各ペアについて：
1. ズレの原因カテゴリ（picker_missing_info / prompt_issue / button_design / style_preference）
2. 具体的な改善提案（aix_feature_suggestions に登録する改善案文。description には「①何を観察したか ②なぜ改善が必要か ③期待される効果」を必ず含めた3〜4文にする）
3. proposal_category（mismatch_fix または text_improvement または new_button）

JSON配列で返す: [{aix_type, description, implementation_notes, proposal_category}]`,
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    messages: [{ role: "user", content: `ペア一覧:\n${JSON.stringify(mismatchPairs.slice(0, 5), null, 2)}` }],
  });
  // content[0] 直接参照はadaptive thinking時にthinkingブロックを掴むためextractTextBlockに統一
  const proposals = parseJsonArray<{ aix_type?: string; description?: string; implementation_notes?: string; proposal_category?: string }>(
    extractTextBlock(resp.content), "analyzeAixMismatch"
  ) ?? [];

  let suggestionsInserted = 0;
  for (const p of proposals) {
    if (!p.description?.trim()) continue;

    // dedup: 同じ aix_type の pending なズレ修正提案が直近7日以内に既にあれば重複起票しない
    // （週次実行のたびに同じズレが再起票されて改善案タブが埋まるのを防ぐ）
    let dedupQuery = supabase
      .from("aix_feature_suggestions")
      .select("id")
      .eq("suggestion_type", "mismatch_fix")
      .eq("status", "pending")
      .gte("created_at", new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString());
    dedupQuery = p.aix_type ? dedupQuery.eq("action_type", p.aix_type) : dedupQuery.is("action_type", null);
    const { data: existingMismatch } = await dedupQuery.limit(1);
    if (existingMismatch && existingMismatch.length > 0) continue;

    const { error } = await supabase.from("aix_feature_suggestions").insert({
      suggestion_type: "mismatch_fix",
      status: "pending",
      description: p.description.slice(0, 500),
      action_type: p.aix_type ?? null,
      // aix_type から suggested_title を導出（null タイトルによるUI表示崩れを防ぐ）
      suggested_title: `[ズレ修正] ${p.aix_type ?? "unknown"}: ${(p.description ?? "").slice(0, 30)}`,
      implementation_notes: p.implementation_notes?.slice(0, 500) ?? null,
      proposal_category: p.proposal_category ?? "mismatch_fix",
    });
    if (!error) suggestionsInserted++;
  }
  console.log(`[corpus2skill] analyzeAixMismatch: pairsFound=${mismatchPairs.length}, suggestionsInserted=${suggestionsInserted}`);
  return { pairsFound: mismatchPairs.length, suggestionsInserted };
}

// ============================================================
// AI盲点フィードバック（週次Opus4.8）
// 材料①: was_accurate=false の gap_analysis（予測が外れた理由 / 直近30日）
// 材料②: suggestion_bypassed / prediction_mismatch（スタッフがAI提案を無視・外れ）
// 材料③: ai_fallback依存度が高いaction（ルール未整備領域）
// 材料④: was_ai_modified=true のAI案vs送信文の対比（AIが誤った事実を述べた根本原因の診断材料）
// 出力: 竹内さんへの質問 → ai_feedback_items（TemplateModal「❓ AI質問」タブで回答）
//   - 根本原因が「知識不足（誤った事実）」→ category=knowledge_gap で正しい事実を質問
//   - 根本原因が「プロンプト・知識の曖昧さ」→ category=prompt_ambiguity で使用条件を質問
// ============================================================

type BlindSpotItem = {
  question: string;
  aix_action?: string | null;
  speculation?: string;
  category?: string;
  evidence?: string;
  confidence?: string;
};

// ②-1 dedup強化用: 記号・空白を除いた文字バイグラム集合を作る（日本語の形態素解析なしで類似キーワード重複を判定するため）
function questionBigrams(text: string): Set<string> {
  const normalized = text
    .replace(/[\s　。、．，！？!?・「」『』【】（）()\[\]■━→①②③❓／/：:｛｝{}]/g, "")
    .slice(0, 200);
  const grams = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i++) grams.add(normalized.slice(i, i + 2));
  return grams;
}

// バイグラムJaccard類似度が0.4以上なら「類似キーワードが重複する同種の質問」とみなす
function isSimilarQuestion(a: string, b: string): boolean {
  const ga = questionBigrams(a);
  const gb = questionBigrams(b);
  if (ga.size === 0 || gb.size === 0) return false;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  const union = ga.size + gb.size - inter;
  return union > 0 && inter / union >= 0.4;
}

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

  // ④ was_ai_modified=true のAI案vs送信文の対比（直近30日）
  // AIが誤った事実（例: 日割家賃の計算方向）を述べてスタッフが修正した例を根本原因診断の材料にする
  // AIX生成文（viewing_invite, application_push等）を除外しLINE返信AI由来のみ対象にする
  const { data: modifiedExamples } = await supabase
    .from("ai_reply_examples")
    .select("customer_message, ai_draft, sent_reply, conversation_state")
    .eq("was_ai_modified", true)
    .not("ai_draft", "is", null)
    .not("sent_reply", "is", null)
    .eq("entry_source", "line_reply")
    .gte("created_at", thirtyDaysAgo)
    .order("created_at", { ascending: false })
    .limit(12);

  // ⑤ 使用数が多いのに win_rate が低いテンプレート（成果起点の盲点）
  // use_count>=3 で「よく使われている」かつ win_rate<0.15（成約まで15%未満）のものを抽出
  const { data: lowConvTemplates } = await supabase
    .from("templates")
    .select("label, category, use_count, win_rate")
    .gte("use_count", 3)
    .lt("win_rate", 0.15)
    .not("win_rate", "is", null)
    .order("use_count", { ascending: false })
    .limit(8);

  // ⑥ テンプレート候補の却下理由（よく却下されるパターンを盲点質問化）
  const { data: dismissedCandidates } = await supabase
    .from("ai_template_candidates")
    .select("action_type, suggested_title, dismissed_reason")
    .eq("is_dismissed", true)
    .not("dismissed_reason", "is", null)
    .gte("created_at", thirtyDaysAgo)
    .limit(15);

  const hasMaterial = (gapLogs?.length ?? 0) > 0 || (bypassed?.length ?? 0) > 0 || (fallbackRules?.length ?? 0) > 0 || (modifiedExamples?.length ?? 0) > 0 || (lowConvTemplates?.length ?? 0) > 0 || (dismissedCandidates?.length ?? 0) > 0;
  if (!hasMaterial) {
    console.log("[corpus2skill] 盲点発見: 材料なしのためスキップ");
    return { questionsSaved: 0 };
  }

  // 改善⑩: 既知情報（既存corpus2skillスキル・回答済みQ&A）をOpusに渡して既知の再質問を防ぐ
  const [{ data: knownSkills }, { data: answeredItems }] = await Promise.all([
    supabase
      .from("ai_reply_knowledge")
      .select("title")
      .like("title", "[corpus2skill]%")
      .order("created_at", { ascending: false })
      .limit(40),
    supabase
      .from("ai_feedback_items")
      .select("question")
      .in("status", ["answered", "applied"])
      .order("created_at", { ascending: false })
      .limit(30),
  ]);
  const knownSkillsSection = (knownSkills ?? [])
    .map((s) => `- ${((s.title as string) ?? "").replace("[corpus2skill] ", "")}`)
    .join("\n");
  const answeredSection = (answeredItems ?? [])
    .map((a) => `- ${((a.question as string) ?? "").replace(/\n/g, " ").slice(0, 200)}`)
    .join("\n");

  const gapSection = (gapLogs ?? []).map((g, i) =>
    `【${i + 1}】予測: ${g.predicted_action} → 実際: ${g.actual_aix_type ?? "不明"}\n外れた理由: ${(g.gap_analysis as string).replace(/\n/g, " ").slice(0, 200)}`
  ).join("\n\n");

  const bypassedSection = (bypassed ?? []).map((b, i) =>
    `【${i + 1}】status=${b.conversation_status} source=${b.source}${b.suggestion_source ? ` 提案経路=${b.suggestion_source}` : ""}${b.customer_msg_summary ? `\n顧客メッセージ要約: ${(b.customer_msg_summary as string).replace(/\n/g, " ").slice(0, 150)}` : ""}`
  ).join("\n\n");

  const fallbackSection = (fallbackRules ?? []).map((f) =>
    `- ${f.keyword}（発生${f.occurrence_count ?? 0}回・採択率${typeof f.confidence === "number" ? Math.round(f.confidence * 100) : "?"}%）`
  ).join("\n");

  const modifiedSection = (modifiedExamples ?? []).map((m, i) =>
    `【${i + 1}】state=${m.conversation_state ?? "不明"}
顧客: ${((m.customer_message as string) ?? "").replace(/\n/g, " ").slice(0, 120)}
AI案: ${((m.ai_draft as string) ?? "").replace(/\n/g, " ").slice(0, 400)}
スタッフが実際に送った文: ${((m.sent_reply as string) ?? "").replace(/\n/g, " ").slice(0, 400)}`
  ).join("\n\n");

  const lowConvSection = (lowConvTemplates ?? []).map((t) =>
    `- [${t.category ?? "?"}]「${t.label}」使用${t.use_count ?? 0}回・成約率${Math.round((t.win_rate as number) * 100)}%`
  ).join("\n");

  const dismissedCandidatesSection = (dismissedCandidates ?? []).map((d) =>
    `- [${(d.action_type as string | null) ?? "?"}]「${(d.suggested_title as string | null) ?? ""}」→ 却下理由: ${d.dismissed_reason as string}`
  ).join("\n");

  const res = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 3000,
    // prompt cache: 静的な質問生成指示を system 側でキャッシュし、動的な材料データは user に分離
    system: [
      {
        type: "text",
        text: `あなたはLINE不動産接客AIの「盲点発見エージェント」です。AIが正確に理解できていない業務パターンを発見し、担当者への的確な質問を作ります。

ユーザーメッセージに渡されるデータを分析して、AIが正確に理解できていない業務パターンを発見し、
担当者（竹内悠馬さん）への質問を生成してください。

■ 既知は出すな（重要）
データ内の「学習済みスキル」「回答済み質問」でカバー済みの内容は既知として扱い、質問を生成しないこと。
本当に未知の盲点だけを質問化する。

■ 根本原因の診断（最重要タスク）
「AI案 vs 実際の送信文」の対比では、単なる言い回しの違いは無視し、以下の2種類の根本原因を診断すること:
1. 知識不足（knowledge_gap）: AIが明らかに間違った事実・数字・因果関係を述べ、スタッフが事実レベルで訂正している場合
   （例: 日割家賃・初期費用の計算方法、審査の仕組み、契約手続きの順序など賃貸実務の事実）
   → その事実の「正しい説明」を竹内さんに質問する。回答がそのままルール化されるので、事実を確認する形の質問にする
2. プロンプト・知識の曖昧さ（prompt_ambiguity）: 知識自体は正しいがAIが使う場面・条件を誤解している場合
   → どういう条件・顧客状況でその表現/対応を使うべきかを質問する

■ question フィールドの形式（必ず以下のテンプレートをそのまま使うこと・全体で最大400字）

❓【AIX: {aix_action}】{簡潔な問い（1行・最大40字）}

{状況説明: 差分行のみ・最大100字}

【AI案】{AIが推奨する改善案・最大100字}

→ ①この案で採用  ②現状維持  ③条件つき採用（自由記述）

テンプレートのルール:
- AIXボタン由来でない場合、見出しは ❓【通常返信】{簡潔な問い} とする
- 状況説明では AI案 vs 実際の送信文の全文対比引用を禁止。違いがある行（差分行）だけを最大150字で引用する
- 「プロンプトのどこが曖昧か」のような、スタッフが答えられない自由記述質問は禁止
- 必ず【AI案】としてAIが推奨する改善案を1つ具体的に提示し、スタッフは3択（①②③）から選ぶだけにする
- 最終行の3択（→ ①この案で採用  ②現状維持  ③条件つき採用（自由記述））は一字一句そのまま必ず含める
- 質問文全体（見出し〜3択行まで）を400字以内に収める

以下の形式でJSON配列を出力してください（最大5件・説明文・コードフェンス不要）:
[{
  "question": "上記テンプレートで記述した質問全文（最大400字・改行を含んでよい）",
  "aix_action": "AIXボタン由来の場合のみ設定: viewing_invite|estimate_sheet|property_send|property_recommendation|property_check_result|condition_hearing|meeting_place|application_push|greeting_viewing|followup_revive|acknowledge_check。通常返信由来なら null",
  "speculation": "AIの憶測・仮説（「〜ではないかと思われますが...」形式）",
  "category": "knowledge_gap|prompt_ambiguity|new_flow|missing_keyword|weak_scene|new_aix_needed|low_conversion|general",
  "evidence": "根拠となったデータの要約（件数・パターン・AIが述べた誤り）",
  "confidence": "high|medium|low"
}]

良い質問の例（question フィールドにはこの形式で記述する）:
- （knowledge_gap 例・通常返信由来）
  ❓【通常返信】日割家賃は入居日が早いほど高い？安い？

  AI案が「入居日が早いほど日割家賃は少ない」と書き、スタッフが逆方向に訂正した例が3件ありました。

  【AI案】日割家賃＝月額家賃÷当月日数×（入居日から月末までの日数）。入居日が早いほど高くなる、と覚え直す。

  → ①この案で採用  ②現状維持  ③条件つき採用（自由記述）

- （weak_scene 例・AIX由来）
  ❓【AIX: application_push】「審査が不安」発言時は申込誘導より安心トーク優先？

  「審査が不安」発言へのAI予測（ヒアリング継続）が週3回外れています。差分行:「審査については弊社でサポートします」→スタッフは保証会社の説明を追加。

  【AI案】「審査が不安」と言われたら、まず保証会社のサポート体制を伝えて安心させ、その後に必要書類の確認へ進む。

  → ①この案で採用  ②現状維持  ③条件つき採用（自由記述）

悪い質問の例（避ける）:
- 「AIをどう改善しますか？」（抽象的すぎる）
- 「営業方針は？」（業務と無関係）
- 「この言い回しでいいですか？」（事実でも条件でもない単なる文体差。文体差は質問化しない）
- 「プロンプトのどの部分が曖昧だと思いますか？」（スタッフが答えられない質問は禁止）
- AI案と送信文を全文引用して対比する長文質問（差分行のみ・最大150字に制限）

必須チェック: 全質問を400字以内に収めること。必ず【AI案】と3択行（→ ①この案で採用  ②現状維持  ③条件つき採用（自由記述））を含めること。
全文対比引用・自由記述のみの質問は出さないこと。根拠の薄い質問は出さないこと。質問がない場合は [] を返す。`,
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    messages: [{
      role: "user",
      content: `【AIの予測が外れた場面（gap_analysis）】
${gapSection || "（なし）"}

【スタッフがAIの提案を無視して別行動した場面】
${bypassedSection || "（なし）"}

【Sonnetフォールバック依存度が高い場面（ルール未整備領域）】
${fallbackSection || "（なし）"}

【スタッフがAIの返信案を修正して送った場面（AI案 vs 実際の送信文）】
${modifiedSection || "（なし）"}

【使用数が多いのに成約率が低いテンプレート・アクション（成果データ）】
${lowConvSection || "（なし）"}

【テンプレート候補の却下理由（このパターンは不要とスタッフが判断）】
${dismissedCandidatesSection || "（なし）"}

【既に学習済みのスキル（既知 — これらと重複する質問は出さない）】
${knownSkillsSection || "（なし）"}

【過去に回答済みの質問（既知 — 同じ・類似の質問を出さない）】
${answeredSection || "（なし）"}`,
    }],
  });

  const parsed = parseJsonArray<BlindSpotItem>(extractTextBlock(res.content), "discoverBlindSpots") ?? [];

  let questionsSaved = 0;
  const VALID_CATEGORIES = ["knowledge_gap", "prompt_ambiguity", "new_flow", "missing_keyword", "weak_scene", "new_aix_needed", "low_conversion", "general", "aix_boundary"];
  const VALID_CONFIDENCE = ["high", "medium", "low"];
  const VALID_AIX_ACTIONS = Object.keys(ACTION_TO_CATEGORY);

  for (const item of parsed.slice(0, 5)) {
    if (!item?.question?.trim()) continue;
    // ③: 質問文は400字以内（プロンプトで指示済み。超過時は安全マージン500字でハード切り詰め）
    const question = item.question.trim().slice(0, 500);
    const category = (VALID_CATEGORIES.includes(item.category ?? "") ? item.category : "general") as string;
    const rawAction = item.aix_action?.trim() || null;
    const aixAction = rawAction && VALID_AIX_ACTIONS.includes(rawAction) ? rawAction : null;

    // dedup強化(②-1): 先頭50字一致 → aix_action + category + 類似キーワード（バイグラムJaccard類似度）で判定
    // pending/answered/applied を対象（回答済みの質問が翌週再起票されるのを防ぐ）
    const { data: sameCategoryItems } = await supabase
      .from("ai_feedback_items")
      .select("question, aix_action")
      .in("status", ["pending", "answered", "applied"])
      .eq("category", category)
      .order("created_at", { ascending: false })
      .limit(50);
    const isDup = (sameCategoryItems ?? []).some((ex) => {
      const exAction = (ex.aix_action as string | null) ?? null;
      // aix_action が両方設定済みで異なる場合のみ別質問として扱う（片方null時は同一領域とみなして類似判定）
      const actionMatches = exAction === aixAction || exAction === null || aixAction === null;
      return actionMatches && isSimilarQuestion(question, (ex.question as string) ?? "");
    });
    if (isDup) {
      console.log(`[corpus2skill] 類似質問が既存のためスキップ: ${question.slice(0, 40)}`);
      continue;
    }

    // H-1: 直接INSERTではなく起票ガード（pending 60件上限 + aix_action×category 2件キャップ）経由で起票する
    const inserted = await safeInsertAiQuestion({
      question,
      speculation: item.speculation?.trim() || null,
      category,
      evidence: item.evidence?.trim() || null,
      confidence: VALID_CONFIDENCE.includes(item.confidence ?? "") ? item.confidence : "medium",
      entry_source: "line_reply",
      aix_action: aixAction,
    });
    if (inserted) questionsSaved++;
    else console.warn("[corpus2skill] feedback item 起票スキップ（上限またはINSERT失敗）");
  }

  return { questionsSaved };
}

export async function GET(req: NextRequest) {
  // Vercel Cron は GET でリクエストするため、CRON_SECRET 認証後に POST へ委譲する
  // （GETエクスポートがないと毎週 405 Method Not Allowed で一度も実行されない）
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return POST(req);
}

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  // 学習ヘルスモニタリング用の実行記録（morning-report が cron_run_logs を読んで状態を報告する）
  const runLogId = await startCronLog("corpus2skill");

  // 20分以内に実行中のcorpus2skillジョブがあればスキップ（重複実行防止）
  const { data: running } = await supabase
    .from("cron_run_logs")
    .select("id")
    .eq("cron_name", "corpus2skill")
    .is("ok", null)
    .neq("id", runLogId)  // 自分自身は除外
    .gt("started_at", new Date(Date.now() - 20 * 60 * 1000).toISOString())
    .limit(1);
  if (running?.length) {
    await finishCronLog(runLogId, false, undefined, "already running - skipped");
    return NextResponse.json({ ok: false, error: "already running" }, { status: 409 });
  }

  // parse失敗カウンタをリクエスト開始時にリセット（サーバレスのモジュールスコープ残留対策）
  parseErrors = 0;

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

  // ②-1: pending 30日超のAI質問を expired に自動更新（滞留による窒息を防ぐ・corpus2skill実行時に毎回実行）
  // ※ aix_boundary（線引き質問）は人間回答が必須の学習ループ起点のため失効対象から除外する
  try {
    const thirtyDaysAgoForExpire = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: expiredRows, error: expireError } = await supabase
      .from("ai_feedback_items")
      .update({ status: "expired" })
      .eq("status", "pending")
      .neq("category", "aix_boundary")
      .lt("created_at", thirtyDaysAgoForExpire)
      .select("id");
    if (expireError) console.warn("[corpus2skill] pending期限切れ更新失敗:", expireError.message);
    else console.log(`[corpus2skill] pending 30日超のAI質問を expired 化: ${expiredRows?.length ?? 0}件`);
  } catch (e) {
    console.error("[corpus2skill] pending期限切れ更新失敗:", e);
  }

  // P2・P3・examplesフェッチ・AIXズレ分析をすべて並列実行（順次では300秒を超過するため）
  const [templateImprovements, blindSpots, examplesResult, mismatchResult] = await Promise.all([
    synthesizeTemplateImprovements().catch((e) => {
      console.error("[corpus2skill] テンプレ改善タスク失敗:", e);
      return { candidatesSaved: 0, suggestionsSaved: 0 };
    }),
    discoverBlindSpots().catch((e) => {
      console.error("[corpus2skill] 盲点発見タスク失敗:", e);
      return { questionsSaved: 0 };
    }),
    (async () => {
      // ── brain-as-learning-curator: 未処理キュー10件以上ならbrainが選別した高品質例を優先使用 ──
      try {
        const { count: queueCount } = await supabase
          .from("brain_learning_queue")
          .select("id", { count: "exact", head: true })
          .eq("processed_by_corpus2skill", false)
          .gte("quality_score", 6);
        if ((queueCount ?? 0) >= 10) {
          const { data: queueRows } = await supabase
            .from("brain_learning_queue")
            .select("id, conversation_id")
            .eq("processed_by_corpus2skill", false)
            .gte("quality_score", 6)
            .order("quality_score", { ascending: false })
            .order("created_at", { ascending: false })
            .limit(30);
          const convIds = (queueRows ?? []).map((q) => q.conversation_id as string).filter(Boolean);
          if (convIds.length > 0) {
            const { data, error } = await supabase
              .from("ai_reply_examples")
              .select("id, conversation_id, created_at, sent_reply, ai_draft, conversation_state, customer_message, was_ai_modified")
              .in("conversation_id", convIds)
              .not("sent_reply", "is", null)
              .eq("entry_source", "line_reply")
              .order("created_at", { ascending: false })
              .limit(200);
            // JOIN結果が3件未満（synthesizeSkillsの最小単位未満）ならフォールバックへ
            if (!error && data && data.length >= 3) {
              console.log(`[corpus2skill] brain_learning_queue モード: queue=${convIds.length}件 → examples=${data.length}件`);
              return { data, error: null, queueIds: (queueRows ?? []).map((q) => q.id as string) };
            }
          }
        }
      } catch (e) {
        console.warn("[corpus2skill] brain_learning_queue 取得失敗（rawフォールバック）:", e instanceof Error ? e.message : String(e));
      }
      // フォールバック: 従来の生 ai_reply_examples クエリ（後方互換）
      const raw = await supabase
        .from("ai_reply_examples")
        .select("id, conversation_id, created_at, sent_reply, ai_draft, conversation_state, customer_message, was_ai_modified")
        .gte("created_at", since)
        .not("sent_reply", "is", null)
        // AIX生成文を除外しLINE返信AI由来のみ対象にする（entry_source で明示的に区分）
        .eq("entry_source", "line_reply")
        .order("created_at", { ascending: false })
        .limit(200);
      return { data: raw.data, error: raw.error, queueIds: [] as string[] };
    })(),
    analyzeAixMismatch().catch((e) => {
      console.error("[corpus2skill] AIXズレ分析失敗:", e);
      return { pairsFound: 0, suggestionsInserted: 0 };
    }),
  ]);
  console.log(`[corpus2skill] テンプレ改善: candidates=${templateImprovements.candidatesSaved} suggestions=${templateImprovements.suggestionsSaved}`);
  console.log(`[corpus2skill] 盲点発見: questions=${blindSpots.questionsSaved}`);
  console.log(`[corpus2skill] AIXズレ分析: pairsFound=${mismatchResult.pairsFound}, suggestionsInserted=${mismatchResult.suggestionsInserted}`);

  const { data: examples, queueIds } = examplesResult as { data: Example[] | null; queueIds: string[] };

  if (!examples || examples.length === 0) {
    await finishCronLog(runLogId, true, {
      reason: "no examples found",
      degraded,
      parse_errors: parseErrors,
      templateCandidatesSaved: templateImprovements.candidatesSaved,
      aixSuggestionsSaved: templateImprovements.suggestionsSaved,
      feedbackQuestionsSaved: blindSpots.questionsSaved,
      mismatchPairsFound: mismatchResult.pairsFound,
      mismatchSuggestionsInserted: mismatchResult.suggestionsInserted,
    });
    return NextResponse.json({
      ok: false,
      reason: "no examples found",
      degraded,
      parse_errors: parseErrors,
      templateCandidatesSaved: templateImprovements.candidatesSaved,
      aixSuggestionsSaved: templateImprovements.suggestionsSaved,
      feedbackQuestionsSaved: blindSpots.questionsSaved,
      mismatchPairsFound: mismatchResult.pairsFound,
      mismatchSuggestionsInserted: mismatchResult.suggestionsInserted,
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

  // フェーズ別synthesizeSkillsをPromise.allで並列実行（順次だと300秒を超過するため）
  const stateEntries = [...byState.entries()].filter(([, exs]) => exs.length >= 3);
  const skillsByState = await Promise.all(
    stateEntries.map(async ([state, stateExamples]) => {
      console.log(`[corpus2skill] ${state}: ${stateExamples.length}件からスキル合成開始`);
      const skills = await synthesizeSkills(state, stateExamples, chainSection).catch((e) => {
        console.error(`[corpus2skill] ${state} 合成失敗:`, e);
        return [] as Skill[];
      });
      return { state, skills };
    })
  );

  try {
    for (const { state, skills } of skillsByState) {
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

        if (result.result === "inserted") totalInserted++;
        else if (result.result === "merged") totalMerged++;
      }
    }
  } catch (e) {
    await finishCronLog(runLogId, false, undefined, e instanceof Error ? e.message : String(e));
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }

  // brain_learning_queue 消費マーク（キューモードで実行した場合のみ・失敗しても処理は成功扱い）
  if (queueIds.length > 0) {
    const { error: markErr } = await supabase
      .from("brain_learning_queue")
      .update({ processed_by_corpus2skill: true, updated_at: new Date().toISOString() })
      .in("id", queueIds);
    if (markErr) console.warn("[corpus2skill] brain_learning_queue 消費マーク失敗:", markErr.message);
    else console.log(`[corpus2skill] brain_learning_queue 消費: ${queueIds.length}件`);
  }
  console.log(`[corpus2skill] 完了: inserted=${totalInserted}, merged=${totalMerged}, degraded=${degraded}, parse_errors=${parseErrors}`);
  if (totalInserted === 0 && totalMerged === 0) {
    console.warn(`[corpus2skill] 0件生成 — examplesProcessed=${examples.length}, parse_errors=${parseErrors}${parseErrors > 0 ? "（parse失敗の可能性）" : ""}`);
  }
  await finishCronLog(runLogId, true, {
    inserted: totalInserted,
    merged: totalMerged,
    parse_errors: parseErrors,
    degraded,
    examplesProcessed: examples.length,
    templateCandidatesSaved: templateImprovements.candidatesSaved,
    aixSuggestionsSaved: templateImprovements.suggestionsSaved,
    feedbackQuestionsSaved: blindSpots.questionsSaved,
    mismatchPairsFound: mismatchResult.pairsFound,
    mismatchSuggestionsInserted: mismatchResult.suggestionsInserted,
  });
  return NextResponse.json({
    ok: true,
    inserted: totalInserted,
    merged: totalMerged,
    parse_errors: parseErrors,
    degraded,
    examplesProcessed: examples.length,
    templateCandidatesSaved: templateImprovements.candidatesSaved,
    aixSuggestionsSaved: templateImprovements.suggestionsSaved,
    feedbackQuestionsSaved: blindSpots.questionsSaved,
    mismatchPairsFound: mismatchResult.pairsFound,
    mismatchSuggestionsInserted: mismatchResult.suggestionsInserted,
  });
}
