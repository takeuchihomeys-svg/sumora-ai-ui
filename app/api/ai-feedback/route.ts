import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { upsertKnowledge, generateEmbedding, buildKnowledgeEmbeddingInput } from "@/app/lib/knowledge-utils";
import Anthropic from "@anthropic-ai/sdk";

// AI盲点フィードバック（ai_feedback_items）
// corpus2skill 週次Opusが「分からない部分・憶測」を質問としてINSERTし、
// TemplateModal の「❓ AI質問」タブで竹内さんが回答 → Opus 4.8 が知識化して
// trigger_action_rules（trigger_keywords を通常n-gramルールとして高confidence保存）/
// ai_prompts（feedback_rule_{id}）+ ai_prompt_rules（FEEDBACK-{id}-{n}）に保存する
// ※旧 MANUAL_RULE: 接頭辞は suggest-next-action の msg.includes() に絶対マッチしないため廃止

export const maxDuration = 60;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "", timeout: 50_000, maxRetries: 1 });


// 改善⑧: suggest-next-action/route.ts の KNOWN_AIX_TYPES と同一のwhitelist。
// Opusが返す未知の action_type をそのまま trigger_action_rules に upsert すると
// suggest-next-action 側で使われない汚染ルールが蓄積するため、
// whitelist外は ai_prompts（一般ルール）へフォールバック保存する。
// ※ suggest-next-action 側のリストを変更した場合はここも同時に更新すること
const KNOWN_AIX_TYPES = new Set([
  "property_send", "viewing_invite", "property_recommendation", "hearing",
  "follow_up", "application", "document_request", "contract", "greeting",
  "property_check_result", "estimate_sheet", "meeting_place",
  "acknowledge_check", "followup_revive", "application_push",
  "condition_hearing", "alternative_send",
]);

// FEEDBACKルールの action_type スコープ用whitelist。
// fetchPromptRules("<action>", ...) を実際に呼んでいるAIXアクション名のみ許可する。
// Opusがこのいずれかを返した場合は ai_prompt_rules.action_type にスコープ付きで保存し、
// それ以外（general / 未知 / null）はグローバル（null）として保存する。
// ※ 全ルールをnull（グローバル）で保存すると全アクションのプロンプトに注入されノイズになるため
const PROMPT_RULE_ACTION_TYPES = new Set([
  "property_check_result", "property_send", "viewing_invite", "estimate_sheet",
  "property_recommendation", "condition_hearing", "greeting_viewing",
  "application_push", "meeting_place", "acknowledge_check", "followup_revive",
]);

type ExtractedRule = {
  rule_text: string;
  save_target: "trigger_action_rules" | "ai_prompts" | "ai_reply_knowledge";
  action_type: string | null;
  trigger_keywords?: string[];
  trigger_example?: string;
};

// GET: pending を最大100件 + answered/applied を直近20件取得
// applied = ルール反映済み（UI でグレーアウト表示用に含める）
// ※ 旧実装は全status混合 limit=50 で、pending が50件を超えると未回答質問が見えなくなっていた。
//   pending 枠を独立させて優先取得し、total_pending も返す（UIで「全◯件」表示に使える）
export async function GET() {
  const [pendingRes, doneRes, pendingCountRes, knowledgeGapCountRes] = await Promise.all([
    supabase
      .from("ai_feedback_items")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("ai_feedback_items")
      .select("*")
      .in("status", ["answered", "applied"])
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("ai_feedback_items")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
    // Tier2承認質問（knowledge_gap）の未回答件数（UIバッジ用サーバカウント）
    supabase
      .from("ai_feedback_items")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .eq("category", "knowledge_gap"),
  ]);

  const error = pendingRes.error ?? doneRes.error;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const items = [...(pendingRes.data ?? []), ...(doneRes.data ?? [])];
  return NextResponse.json({
    ok: true,
    items,
    total_pending: pendingCountRes.count ?? (pendingRes.data ?? []).length,
    total_knowledge_gap_pending: knowledgeGapCountRes.count ?? 0,
  });
}

// 回答をOpus 4.8で解釈して業務ルールを1〜3個抽出する（高品質な永続ルールを生成するため最上位モデルを使用）
async function extractRules(question: string, answer: string): Promise<ExtractedRule[]> {
  const res = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 1500,
    system: `あなたはLINE不動産接客AIの知識管理エージェントです。担当者からの回答を、AIが今後使える業務ルールに変換します。`,
    messages: [{
      role: "user",
      content: `以下はAIが担当者（竹内悠馬さん）に質問した内容と、その回答です。

【AIの質問】
${question}

【竹内さんの回答】
${answer}

この質問と回答から、AIが今後使える業務ルールを1〜3個抽出してください。
各ルールについて:
- rule_text: ルール本文（AIがそのまま参照できる具体的な指示文・300文字以内）
- save_target: 以下の3つから選択
  "ai_prompts" → どんな文脈でも常に守る方針・禁止ルール（例：謝罪禁止、能動表現必須、特定フレーズ禁止）
  "trigger_action_rules" → AIXボタンの発動キーワード条件（特定単語が含まれたらXXXボタン推奨など）
  "ai_reply_knowledge" → 特定場面・状況専用の返信パターン・フレーズ・文章構造（例：「審査落ち連絡の場合は〜」「物件に興味なしと言われた場合は〜」「入居日を尋ねられた場合の返信構造」）
- action_type: 該当AIXボタン名（property_send / viewing_invite / application_push / condition_hearing / estimate_sheet / followup_revive / acknowledge_check / property_check_result / property_recommendation / meeting_place 等）、なければ null
- save_target が "trigger_action_rules" の場合は、trigger_keywords フィールドも必ず付ける。
  trigger_keywords: 顧客メッセージに実際に含まれるであろうキーワード3文字以上の語句を1〜3個（例：「スモ割」「審査通る」「築年数」）。
  ルールの説明文ではなく、顧客がLINEで実際に打つ語句そのものを選ぶこと。
- save_target が "ai_reply_knowledge" の場合は、trigger_example フィールドも必ず付ける。
  trigger_example: このルールが必要になる典型的な顧客メッセージ例（1〜2文・顧客がLINEで実際に送りそうな自然な文体）。
  ルールの説明文ではなく、顧客の発話そのものとして書くこと（例：「内見したいのですが、いつ空いていますか？」）。

JSON配列のみ返してください（説明・コードフェンス不要）:
[{"rule_text": "...", "save_target": "trigger_action_rules"|"ai_prompts"|"ai_reply_knowledge", "action_type": "..."|null, "trigger_keywords": ["..."], "trigger_example": "..."}]`,
    }],
  });

  const text = res.content[0]?.type === "text" ? res.content[0].text.trim() : "";
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as ExtractedRule[];
    return Array.isArray(parsed) ? parsed.filter((r) => r?.rule_text?.trim()).slice(0, 3) : [];
  } catch {
    return [];
  }
}

// POST: { id, answer, choice? } → user_answer保存 + Sonnetで知識化 + status="answered"に更新
// choice: 'new' = 新ルール採用, 'old' = 既存ルール維持, undefined = 既存動作維持（安全側）
export async function POST(req: NextRequest) {
  const body = await req.json() as { id?: string; answer?: string; choice?: 'new' | 'old' | 'remove' | 'keep' };
  const id = body.id;
  const answer = body.answer?.trim();
  const choice = body.choice;
  if (!id || !answer) {
    return NextResponse.json({ ok: false, error: "id and answer required" }, { status: 400 });
  }

  const { data: item, error: fetchError } = await supabase
    .from("ai_feedback_items")
    .select("id, question, status, category, evidence")
    .eq("id", id)
    .single();
  if (fetchError || !item) {
    return NextResponse.json({ ok: false, error: "item not found" }, { status: 404 });
  }

  // autoJudge・checkContradiction が question 先頭に埋め込む [knowledge_id:UUID] を抽出。
  // 存在する場合は回答後に当該ナレッジを confirmed 昇格 + HUMAN-* priority=10 で即時反映する（closed-loop）。
  const knowledgeIdMatch = (item.question as string).match(/\[knowledge_id:([0-9a-f-]{36})\]/i);
  const linkedKnowledgeId = knowledgeIdMatch ? knowledgeIdMatch[1] : null;

  // question または evidence から旧 confirmed のIDを抽出（Step1: checkContradiction が埋め込む）
  const oldKnowledgeIdMatch = (item.question ?? '').match(/\[old_knowledge_id:([^\]]+)\]/);
  const oldKnowledgeId = oldKnowledgeIdMatch?.[1] ?? null;

  // 知識化（失敗しても回答自体は保存する）
  let rules: ExtractedRule[] = [];
  try {
    rules = await extractRules(item.question as string, answer);
  } catch (e) {
    console.error("[ai-feedback] ルール抽出失敗:", e);
  }

  const appliedRules: string[] = [];
  const promptRuleTexts: Array<{ text: string; actionType: string | null }> = [];

  for (const rule of rules) {
    const ruleText = rule.rule_text.trim();
    const keywords = (rule.trigger_keywords ?? [])
      .map((k) => (k ?? "").trim())
      .filter((k) => k.length >= 3)
      .slice(0, 3);
    const actionType = rule.action_type?.trim() ?? "";
    // ai_prompt_rules 保存時のスコープ: 既知AIXアクションならスコープ付き、それ以外はグローバル（null）
    const scopedActionType = PROMPT_RULE_ACTION_TYPES.has(actionType) ? actionType : null;

    // 改善⑧: whitelist外の action_type は trigger_action_rules を汚染するため
    // ai_prompts（一般ルール）へフォールバック保存する
    if (rule.save_target === "trigger_action_rules" && actionType && !KNOWN_AIX_TYPES.has(actionType)) {
      console.warn(`[ai-feedback] whitelist外のaction_type "${actionType}" → trigger_action_rules をスキップし ai_prompts へフォールバック保存`);
      promptRuleTexts.push({ text: ruleText, actionType: scopedActionType });
      continue;
    }

    // ── save_target === 'ai_reply_knowledge': 特定場面専用の返信パターンを知識DBに保存 ──
    // ai_prompts（静的テキストルール）ではなく ai_reply_knowledge（pgvector検索）へ保存することで、
    // generate-reply の fetchKnowledge が類似顧客メッセージにヒットした際に自動注入される。
    // -gr コピー（generate_reply スコープ重複保存）は不要（pgvector 経由で既に参照されるため）。
    if (rule.save_target === "ai_reply_knowledge") {
      try {
        // embedding は顧客メッセージに近い意味空間で生成するため trigger_example を優先する。
        // ruleText（ルール説明文）はAI視点の指示文であり顧客メッセージとの類似度が低く
        // generate-reply の pgvector 検索でヒットしにくいため、trigger_example を第一候補とする。
        const embSourceText = rule.trigger_example?.trim() || ruleText;
        const embInput = buildKnowledgeEmbeddingInput({ content: embSourceText });
        const embedding = embInput ? await generateEmbedding(embInput) : null;
        const result = await upsertKnowledge(supabase, {
          title: ruleText.slice(0, 30) + (ruleText.length > 30 ? "..." : ""),
          content: ruleText,
          category: "principle",
          importance: 8,
          ...(embedding ? { embedding } : {}),
        });
        // upsertKnowledge は hypothesis_status / promoted_by を設定しないため、
        // 挿入・マージどちらの場合も confirmed + human_feedback を上書きする
        if (result.result !== "skipped" && result.id) {
          await supabase.from("ai_reply_knowledge").update({
            hypothesis_status: "confirmed",
            promoted_by: "human_feedback",
            promoted_at: new Date().toISOString(),
          }).eq("id", result.id);
        }
        if (result.result !== "skipped") {
          appliedRules.push(`[ai_reply_knowledge:${result.result}] ${ruleText.slice(0, 50)}`);
        }
      } catch (e) {
        console.error("[ai-feedback] ai_reply_knowledge upsert失敗:", e);
      }
      continue; // ai_prompts / trigger_action_rules パスはスキップ
    }

    if (rule.save_target === "trigger_action_rules" && actionType && keywords.length > 0) {
      // 竹内さん確認済みルール → 実際の発動キーワードを通常のn-gramルールとして保存
      // （旧 MANUAL_RULE:接頭辞は顧客メッセージの msg.includes() に絶対マッチしないため廃止）
      // confidence 0.95 / occurrence_count 10 = learn-trigger-rules のクリーンアップで絶対に削除されない
      let savedKeywords = 0;
      for (const keyword of keywords) {
        const { error } = await supabase.from("trigger_action_rules").upsert({
          keyword: keyword.slice(0, 200),
          action_type: actionType,
          confidence: 0.95,
          occurrence_count: 10,
          updated_at: new Date().toISOString(),
        }, { onConflict: "action_type,keyword" });
        if (!error) savedKeywords++;
        else console.error("[ai-feedback] trigger_action_rules upsert error:", error.message);
      }
      if (savedKeywords > 0) appliedRules.push(`[${actionType}] ${ruleText}（キーワード: ${keywords.join("・")}）`);
      // trigger_action_rules に保存したルールも返信内容として ai_prompt_rules に記録する
      // （キーワード→AIX発動のマッピングだけでは「どう返すか」が失われるため）
      promptRuleTexts.push({ text: ruleText, actionType: scopedActionType });
    } else {
      // 一般ルール（キーワード抽出できなかった trigger ルールも情報を失わずこちらへ）
      promptRuleTexts.push({ text: ruleText, actionType: scopedActionType });
    }
  }

  if (promptRuleTexts.length > 0) {
    const { error } = await supabase.from("ai_prompts").upsert({
      key: `feedback_rule_${id}`,
      label: `盲点フィードバック回答（${new Date().toISOString().slice(0, 10)}）`,
      content: `【竹内さん確認済みルール】${item.question}\n→回答: ${answer}\n\n抽出ルール:\n${promptRuleTexts.map((r) => `- ${r.text}`).join("\n")}`,
      updated_at: new Date().toISOString(),
    }, { onConflict: "key" });
    if (!error) appliedRules.push(...promptRuleTexts.map((r) => r.text));
    else console.error("[ai-feedback] ai_prompts upsert error:", error.message);

    // ai_prompt_rules にも保存 → fetchPromptRules 経由で generate-reply / AIX に実際に注入される
    // （ai_prompts の feedback_rule_{id} は generate-reply の固定キーwhitelist外で参照されないため）
    for (let i = 0; i < promptRuleTexts.length; i++) {
      const { error: ruleError } = await supabase.from("ai_prompt_rules").upsert({
        rule_key: `FEEDBACK-${id}-${i + 1}`,
        // Opusが既知AIXアクションを返した場合はスコープ付きで保存（全アクションへのノイズ注入を防止）。
        // 受け側の fetchPromptRules は .or(`action_type.eq.${actionType},action_type.is.null`) で
        // 取得するため、スコープ付きルールは該当アクションのプロンプトにのみ注入される
        action_type: promptRuleTexts[i].actionType,
        condition_key: null,
        condition_value: null,
        rule_text: promptRuleTexts[i].text,
        reason: `AI盲点質問への竹内さん回答（${new Date().toISOString().slice(0, 10)}）: ${item.question}`.slice(0, 500),
        priority: 8,
        is_active: true,
        source_feedback_item_id: id,
        updated_at: new Date().toISOString(),
      }, { onConflict: "rule_key" });
      if (ruleError) console.error("[ai-feedback] ai_prompt_rules upsert error:", ruleError.message);

      // AIXスコープ付きFEEDBACKルールは generate-reply にも注入する
      // （viewing_invite等のルールは LINE文案生成の同フェーズでも有効なため）
      if (!ruleError && promptRuleTexts[i].actionType !== null) {
        await supabase.from("ai_prompt_rules").upsert({
          rule_key: `FEEDBACK-${id as string}-${i + 1}-gr`,
          action_type: "generate_reply",
          condition_key: null,
          condition_value: null,
          rule_text: promptRuleTexts[i].text,
          reason: `AI盲点質問generate-replyコピー（${new Date().toISOString().slice(0, 10)}）: ${item.question as string}`.slice(0, 500),
          priority: 7,   // 元の priority=8 より低く（AIX側と重複するため）
          is_active: true,
          source_feedback_item_id: id,
          updated_at: new Date().toISOString(),
        }, { onConflict: "rule_key" });
      }
    }
  }

  // ── Closed-loop: 特定 knowledge_id に紐づいた質問への回答 → choice に基づき knowledge を分岐処理 ──
  // autoJudge / checkContradiction が [knowledge_id:UUID] を question に埋め込む。
  //
  // choice === 'new': 新ルール採用 → linkedKnowledgeId を confirmed・oldKnowledgeId を rejected
  // choice === 'old': 既存ルール正しい → linkedKnowledgeId を rejected（confirmed昇格しない）
  // choice === undefined: 既存動作を維持（安全側 = 無条件に confirmed）
  if (linkedKnowledgeId) {
    try {
      const { data: knowledgeRow } = await supabase
        .from("ai_reply_knowledge")
        .select("id, title, content, conversation_state, importance, hypothesis_status")
        .eq("id", linkedKnowledgeId)
        .single();

      if (knowledgeRow) {
        const currentImportance = (knowledgeRow.importance as number) ?? 7;

        if (choice === 'old') {
          // ── 既存ルールが正しい: 新 hypothesis を rejected に ──
          const { data: oldChoiceData, error: oldChoiceErr } = await supabase
            .from("ai_reply_knowledge")
            .update({
              hypothesis_status: "rejected",
              rejection_reason: "ai_feedback: existing confirmed rule is correct",
            })
            .eq("id", linkedKnowledgeId)
            .in("hypothesis_status", ["hypothesis", "confirmed"]) // auto_judge等で先にconfirmed化されていてもrejectできるように
            .select("id");
          if (!oldChoiceErr) {
            if (!oldChoiceData || oldChoiceData.length === 0) {
              console.warn(`[ai-feedback] choice=old: reject更新0件（${linkedKnowledgeId} は既にrejected済み等の可能性）`);
            } else {
              appliedRules.push(`[REJECT-${linkedKnowledgeId}] hypothesis rejected (old confirmed rule is correct)`);
            }
          } else {
            console.error("[ai-feedback] choice=old: hypothesis rejected update 失敗:", oldChoiceErr.message);
          }

          // choice='old': hypothesis を rejected にするのみ。RAGがフィルタするため ai_prompt_rules への書き込みは不要。
        } else {
          // ── choice === 'new' または undefined（既存動作: confirmed 昇格） ──
          // 1. confirmed 昇格・importance を min(10, max(現在値, 9)) に引き上げ
          // safety guard: choice='old' と対称に hypothesis のみを対象にする
          // （rejected ナレッジが別回答で誤って復活するのを防ぐ）
          const { error: upgradeError } = await supabase
            .from("ai_reply_knowledge")
            .update({ hypothesis_status: "confirmed", importance: Math.min(10, Math.max(currentImportance, 9)) })
            .eq("id", linkedKnowledgeId)
            .eq("hypothesis_status", "hypothesis"); // ガード: hypothesis 以外は触らない
          if (upgradeError) {
            console.error("[ai-feedback] confirmed昇格 update 失敗:", upgradeError.message);
            // DB更新失敗時は後続処理をスキップして不整合を防ぐ
            throw new Error(`[ai-feedback] confirmed昇格失敗: ${upgradeError.message}`);
          }

          // 2. oldKnowledgeId がある場合 → 旧ルールを rejected に
          //    choice === 'new': 明示的な置き換え
          //    choice === undefined（自由記述回答）: 新仮説がconfirmed化されるため、
          //    旧confirmedも暗黙的にrejectして「矛盾するconfirmed 2件の共存」を防ぐ
          if (oldKnowledgeId) {
            const isImplicit = choice !== 'new';
            if (isImplicit) {
              console.warn(`[ai-feedback] choice未指定（自由記述回答）: 旧ナレッジ ${oldKnowledgeId} を暗黙的にrejectします`);
            }
            const { error: oldRejectErr } = await supabase
              .from("ai_reply_knowledge")
              .update({
                hypothesis_status: "rejected",
                rejection_reason: isImplicit
                  ? "implicit_new: replaced by free-form answer"
                  : "ai_feedback: replaced by newer rule",
              })
              .eq("id", oldKnowledgeId)
              .in("hypothesis_status", ["hypothesis", "confirmed"]); // confirmed昇格前後どちらでもrejectできるように
            if (!oldRejectErr) {
              appliedRules.push(`[REJECT-${oldKnowledgeId}] old rule rejected (${isImplicit ? "implicit_new" : "replaced by new"})`);
            } else {
              console.error("[ai-feedback] oldKnowledgeId rejected update 失敗:", oldRejectErr.message);
            }
          }

          // 3. confirmed昇格のみ。RAGにより自動参照されるためai_prompt_rulesへの書き込みは不要。
          // 旧ナレッジに紐づく過去のFEEDBACK-*ルールを無効化（矛盾注入防止）
          // ※ rule_key は FEEDBACK-{ai_feedback_items.id}-{n} 形式のため、
          //   oldKnowledgeId（ai_reply_knowledge.id）を LIKE マッチさせても永久に0件になる。
          //   生成元フィードバックIDを source_feedback_item_id で追跡し、正確にクリーンアップする。
          //   oldFeedbackItemIds: checkContradiction が [knowledge_id:UUID] を question に埋め込む仕様を利用し、
          //   oldKnowledgeId をその knowledge_id として持つ feedback item を逆引きして特定する。
          if (oldKnowledgeId) {
            const { data: oldFeedbackItems } = await supabase
              .from("ai_feedback_items")
              .select("id")
              .like("question", `%[knowledge_id:${oldKnowledgeId}]%`);
            if (oldFeedbackItems && oldFeedbackItems.length > 0) {
              const oldFeedbackItemIds = oldFeedbackItems.map((r: { id: string }) => r.id as string);
              await supabase.from("ai_prompt_rules")
                .update({ is_active: false })
                .in("source_feedback_item_id", oldFeedbackItemIds);
            }
          }
          appliedRules.push(`[CONFIRMED-${linkedKnowledgeId}] knowledge confirmed → RAGで自動参照`);
        }
      }
    } catch (e) {
      console.error("[ai-feedback] closed-loop knowledge confirm 失敗:", e);
      // ナレッジ昇格失敗時は status='applied' にせず pending のまま維持して再回答可能にする
      return NextResponse.json(
        { ok: false, error: "ナレッジ昇格処理に失敗しました。もう一度お試しください。" },
        { status: 500 }
      );
    }
  }

  // ── Feedback Rule 再確認: [feedback_rule_key:FEEDBACK-xxx] への回答処理 ──
  const feedbackRuleKeyMatch = (item.question as string).match(/\[feedback_rule_key:(FEEDBACK-[^\]]+)\]/);
  const linkedFeedbackRuleKey = feedbackRuleKeyMatch?.[1] ?? null;

  if (linkedFeedbackRuleKey) {
    try {
      if (choice === 'remove') {
        // ❌ 間違い → is_active=false に無効化
        const { error: deactivateErr } = await supabase
          .from("ai_prompt_rules")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("rule_key", linkedFeedbackRuleKey);
        if (!deactivateErr) {
          appliedRules.push(`[DEACTIVATE:${linkedFeedbackRuleKey}] 再確認で誤りと判定 → is_active=false`);
          console.log(`[ai-feedback] ${linkedFeedbackRuleKey} を無効化しました`);
        } else {
          console.error("[ai-feedback] FEEDBACK-* deactivate 失敗:", deactivateErr.message);
        }
      } else {
        // ✅ 正しい（choice='keep' または自由回答）→ 維持
        appliedRules.push(`[CONFIRM:${linkedFeedbackRuleKey}] 再確認で正しいと確認 → 維持`);
      }
    } catch (e) {
      console.error("[ai-feedback] feedback_rule_key 処理失敗:", e);
    }
  }

  // knowledge_gap（AIが誤った事実を述べた → 竹内さんが正しい事実を回答）は
  // ai_prompt_rules（150字ルール）だけでは弱いため、ai_reply_knowledge の principle としても保存する。
  // item.question は「AIが〜と誤回答しました」等のメタ文のため embedding が意味空間ズレ。
  // 正しい知識内容（answer）を embedding 化して顧客の類似質問に pgvector でヒットさせる
  // ※ linkedKnowledgeId がある場合は上の closed-loop で既に knowledge を confirmed 化済みのためスキップ
  // GAP-9: extractRulesでpolicy型ルール（FEEDBACK-*）を作成済みの場合は二重注入防止のためスキップ。
  // promptRuleTexts>0 = Opusがai_prompt_rulesへ保存と判断した = knowledge_gap側の保存は冗長になる。
  if (item.category === "knowledge_gap" && !linkedKnowledgeId && promptRuleTexts.length === 0) {
    try {
      const embInput = buildKnowledgeEmbeddingInput({ content: answer });
      const embedding = embInput ? await generateEmbedding(embInput) : null;
      const result = await upsertKnowledge(supabase, {
        title: `[盲点回答] ${(item.question as string).slice(0, 40)}`,
        content: `【竹内さん確認済みの正しい知識】\n質問: ${item.question}\n正しい説明: ${answer}${promptRuleTexts.length > 0 ? `\n\n要点:\n${promptRuleTexts.map((r) => `- ${r.text}`).join("\n")}` : ""}`,
        category: "principle",
        importance: 9,
        ...(embedding ? { embedding } : {}),
      });
      if (result.result !== "skipped") appliedRules.push(`[knowledge_gap→principle知識化: ${result.result}]`);
    } catch (e) {
      console.error("[ai-feedback] knowledge_gap の principle 保存失敗:", e);
    }
  }

  // FEEDBACK-* 優先度decayロジック（削除なし・demoteのみ）
  // 90日超のFEEDBACK-*は priority を 2 に下げてアクティブを維持
  // （たまにしか使わないルールも消さずに残し、プロンプト注入の重みだけ下げる）
  try {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data: staleFeedbackRules } = await supabase
      .from("ai_prompt_rules")
      .select("id, priority")
      .like("rule_key", "FEEDBACK-%")
      .eq("is_active", true)
      .lt("created_at", ninetyDaysAgo)
      .gt("priority", 2);

    if (staleFeedbackRules && staleFeedbackRules.length > 0) {
      await supabase
        .from("ai_prompt_rules")
        .update({ priority: 2 })
        .in("id", staleFeedbackRules.map((r: { id: string }) => r.id as string));
      console.log(`[ai-feedback] FEEDBACK-* ${staleFeedbackRules.length}件をpriority=2にdemote`);
    }
  } catch (e) {
    console.error("[ai-feedback] FEEDBACK-* demoteチェック失敗:", e);
  }

  const { error: updateError } = await supabase
    .from("ai_feedback_items")
    .update({
      user_answer: answer,
      status: "applied",
      applied_rule: appliedRules.length > 0 ? appliedRules.join(" / ").slice(0, 500) : null,
      answered_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (updateError) return NextResponse.json({ ok: false, error: updateError.message }, { status: 500 });
  return NextResponse.json({ ok: true, rulesApplied: appliedRules.length });
}

// DELETE: { id, dismissedReason? } → status="dismissed"（理由があれば dismissed_reason に保存してAIの学習材料にする）
export async function DELETE(req: NextRequest) {
  const body = await req.json() as { id?: string; dismissedReason?: string };
  const { id, dismissedReason } = body;
  if (!id) {
    return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  }

  const { error } = await supabase
    .from("ai_feedback_items")
    .update({
      status: "dismissed",
      ...(dismissedReason?.trim() ? { dismissed_reason: dismissedReason.trim() } : {}),
    })
    .eq("id", id);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
