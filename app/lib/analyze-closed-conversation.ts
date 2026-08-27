import { supabase } from "@/app/lib/supabase";
import { generateEmbedding } from "@/app/lib/knowledge-utils";

// ── 申込/成約/失注確定時の会話全体分析（Opus 4.8）─────────────────────────────────
// conversations.status が applying / closed_won / closed_lost に変わった瞬間に呼ばれ、
// 問い合わせ〜申込/成約（または失注）までの全メッセージを分析してパターンを高品質に蓄積する。
// closed_lost の場合は「なぜ失注したか」の失注パターンを学習する。
// 保存先（6箇所）:
//   A. winning_pattern_logs（確定成約事例・was_correct=true）
//   B. ai_reply_knowledge（成約パターン・importance 9）
//   C. ai_reply_knowledge（転換点・importance 8）
//   D. property_customers.personality_profile（確定プロファイル）
//   E. ai_prompts key=closed_analysis_{conversationId}（重複防止 + 参照用）
//   F. winning_patterns（構造化パターン・RAG検索用・embedding付き）

export type ClosedOutcome = "applying" | "closed_won" | "closed_lost";

export type ClosedAnalysisResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
};

type AnalysisJson = {
  personality_profile?: string;
  winning_pattern?: string;
  turning_point?: string;
  what_worked?: string;
  human_type_label?: string;
  customer_intent?: string;
  staff_reply_intent?: string;
  checkpoint_stage?: string;
};

// Opus 4.8 直接呼び出し（eval-winning-pattern の callSonnet と同パターン）
// ※ Opus 4.8 は temperature 等のサンプリングパラメータを受け付けない（400）ため付けない
async function callOpus(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.replace(/\s/g, "");
  if (!apiKey) return "";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(90_000),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 1400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      console.warn("[analyze-closed] Opus API error:", res.status, await res.text().catch(() => ""));
      return "";
    }
    const data = await res.json() as { content?: Array<{ type?: string; text?: string }> };
    return data.content?.find((b) => b.type === "text")?.text?.trim() || "";
  } catch (e) {
    console.warn("[analyze-closed] Opus呼び出し失敗:", e);
    return "";
  }
}

// 全メッセージを「[顧客] テキスト」形式にフォーマット（各200字・合計8000字上限）
// 上限超過時は先頭3000字（初回問い合わせの文脈）+ 末尾5000字（申込直前の転換点）を残す
function formatMessages(msgs: Array<{ sender: string; text: string }>): string {
  const full = msgs
    .map((m) => `[${m.sender === "customer" ? "顧客" : "スタッフ"}] ${(m.text || "").slice(0, 200)}`)
    .join("\n");
  if (full.length <= 8000) return full;
  return `${full.slice(0, 3000)}\n...(中略)...\n${full.slice(-5000)}`;
}

// ── 成果の書き戻し（学習ループのクローズ）──────────────────────────────
// closed_won / closed_lost 確定時に、その会話で記録済みの未確定行（NULL）へ結果を書き戻す:
//   - closing_strategy_logs.outcome: 'contract'（成約）/ 'lost'（失注）+ outcome_recorded_at
//   - winning_pattern_logs.actual_outcome: 'closed_won' / 'closed_lost' + was_correct（答え合わせ）
// NULL行のみ更新するため冪等（何度呼んでも安全）。
// 呼び出し元: analyzeClosedConversation（手動ステータス変更 + 取りこぼしcron）/ auto-seiyaku cron。
export async function writeBackClosedOutcome(
  conversationId: string,
  outcome: ClosedOutcome
): Promise<void> {
  if (outcome !== "closed_won" && outcome !== "closed_lost") return;
  const isWon = outcome === "closed_won";

  // closing_strategy_logs: outcome 未確定の戦略提案行に成約/失注結果を記録
  const { error: csErr } = await supabase
    .from("closing_strategy_logs")
    .update({
      outcome: isWon ? "contract" : "lost",
      outcome_recorded_at: new Date().toISOString(),
    })
    .eq("conversation_id", conversationId)
    .is("outcome", null);
  if (csErr) console.warn("[closed-outcome] closing_strategy_logs 書き戻し失敗:", csErr.message);

  // winning_pattern_logs: customer-summary の予測行（actual_outcome=NULL）に答え合わせを記録
  // ※ 値は既存データ（analyze-closed の確定insert）と同じステータス文字列に揃える
  const { error: wpErr } = await supabase
    .from("winning_pattern_logs")
    .update({
      actual_outcome: outcome,
      was_correct: isWon,
    })
    .eq("conversation_id", conversationId)
    .is("actual_outcome", null);
  if (wpErr) console.warn("[closed-outcome] winning_pattern_logs 書き戻し失敗:", wpErr.message);
}

export async function analyzeClosedConversation(
  conversationId: string,
  outcome: ClosedOutcome
): Promise<ClosedAnalysisResult> {
  const dedupeKey = `closed_analysis_${conversationId}`;

  // 0. 成果の書き戻し（学習ループのクローズ）
  // 分析がスキップ/失敗しても outcome の書き戻しは必ず実行する（冪等なので再実行も安全）
  await writeBackClosedOutcome(conversationId, outcome);

  // 1. 重複防止チェック（同一会話の再分析防止）
  const { data: existing } = await supabase
    .from("ai_prompts")
    .select("key")
    .eq("key", dedupeKey)
    .maybeSingle();
  if (existing) {
    return { ok: true, skipped: true, reason: "already_analyzed" };
  }

  // 2. 全メッセージ + 顧客基本情報を取得
  const { data: conv } = await supabase
    .from("conversations")
    .select("property_customer_id, suggested_aix_meta, last_brain_meta")
    .eq("id", conversationId)
    .maybeSingle();
  type ConvRow = { property_customer_id?: string | null; suggested_aix_meta?: Record<string, unknown> | null; last_brain_meta?: Record<string, unknown> | null };
  const pcId = (conv as ConvRow | null)?.property_customer_id ?? null;
  const purchaseSignalLevel = (
    (conv as ConvRow | null)
      ?.suggested_aix_meta?.purchase_signal_level as string | null
  ) ?? null;
  const checkpointStageFromMeta = (
    (conv as ConvRow | null)?.last_brain_meta?.checkpoint_stage as string | null
  ) ?? null;

  const { data: msgRows, error: msgErr } = await supabase
    .from("messages")
    .select("sender, text, created_at")
    .eq("conversation_id", conversationId)
    .neq("text", "[画像]")
    .neq("text", "[動画]")
    .not("text", "is", null)
    .order("created_at", { ascending: true });
  if (msgErr) {
    return { ok: false, error: `messages取得失敗: ${msgErr.message}` };
  }
  const msgs = (msgRows ?? []) as Array<{ sender: string; text: string }>;
  if (msgs.length < 3) {
    return { ok: true, skipped: true, reason: "too_few_messages" };
  }

  let customerInfo = "";
  if (pcId) {
    const { data: pc } = await supabase
      .from("property_customers")
      .select("customer_name, desired_area, rent_min, rent_max, floor_plan, move_in_time, preferences, ng_points, other_requests")
      .eq("id", pcId)
      .maybeSingle();
    if (pc) {
      const c = pc as {
        customer_name?: string | null; desired_area?: string | null;
        rent_min?: number | null; rent_max?: number | null;
        floor_plan?: string | null; move_in_time?: string | null;
        preferences?: string | null; ng_points?: string | null; other_requests?: string | null;
      };
      const rentStr = (c.rent_min || c.rent_max)
        ? `${c.rent_min ? Math.floor(c.rent_min / 10000) + "万〜" : "〜"}${c.rent_max ? Math.floor(c.rent_max / 10000) + "万" : ""}`
        : null;
      customerInfo = [
        c.desired_area && `希望エリア: ${c.desired_area}`,
        rentStr && `家賃: ${rentStr}`,
        c.floor_plan && `間取り: ${c.floor_plan}`,
        c.move_in_time && `入居時期: ${c.move_in_time}`,
        c.preferences && `こだわり: ${c.preferences}`,
        c.ng_points && `NG条件: ${c.ng_points}`,
        c.other_requests && `その他希望: ${c.other_requests}`,
      ].filter(Boolean).join("\n");
    }
  }

  const outcomeLabel = outcome === "closed_won" ? "成約" : outcome === "closed_lost" ? "失注" : "申込";
  const isLost = outcome === "closed_lost";

  // 3. Opus 4.8 で分析（失注の場合は失注要因の分析に切り替える）
  const lostInstruction = isLost
    ? `

※ この会話は失注（成約に至らなかった）会話です。なぜ失注したかのパターンを分析してください。
- winning_pattern には「失注の主要因・避けるべき対応パターン」を記載する
- turning_point には「顧客の態度が後ろ向きに変わった瞬間・きっかけ」を記載する
- what_worked には「スタッフが本来取るべきだった対応（改善案）」を記載する`
    : "";

  const prompt = `あなたは賃貸仲介営業の${isLost ? "失注" : "成約"}分析の専門家です。
以下は問い合わせから${outcomeLabel}までの実際の会話全文です。${lostInstruction}

【会話全文】
${formatMessages(msgs)}

【顧客基本情報】
${customerInfo || "（登録情報なし）"}

以下をJSONで返してください：

{
  "personality_profile": "この顧客の人間性・行動パターンを100字以内で。response_style（即レス/ゆっくり等）・decision_style（即決/比較検討/不安が多い等）・emotional_trigger（何で動いたか）・hesitation_pattern（どこで止まったか）・engagement_level（高/中/低）を含めること",
  "winning_pattern": "この顧客タイプで${outcomeLabel}に至った${isLost ? "主要因・避けるべき対応パターン" : "決め手・勝ち筋"}を50字以内で",
  "turning_point": "会話の中で顧客の態度が${isLost ? "後ろ向き" : "前向き"}に変わった瞬間・きっかけを1〜2文で",
  "what_worked": "${isLost ? "スタッフが本来取るべきだった対応（改善案・具体的に）" : "スタッフが取った行動のうち最も効果があったもの（具体的に）"}",
  "human_type_label": "このタイプの顧客を一言で表すラベル（例：安心重視・慎重派、費用最優先・即決型、比較検討・背中押し型 等）",
  "customer_intent": "転換点（態度が変わった瞬間）での顧客メッセージの意図（question/consultation/desire/decision/positive/negative/chat のいずれか）",
  "staff_reply_intent": "その転換点でスタッフが実際に取ったアプローチ（empathy/inform/propose/guide/reassure/push/confirm のいずれか）",
  "checkpoint_stage": "hearing/proposing/viewing/applying/contract のいずれか。会話の成約時点でのフェーズを判定する。hearing=条件ヒアリング中, proposing=物件提案中, viewing=内覧調整中, applying=申込手続き中, contract=契約完了"
}`;

  const rawText = await callOpus(prompt);
  if (!rawText) {
    return { ok: false, error: "Opus応答なし" };
  }

  let result: AnalysisJson = {};
  try {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (match) result = JSON.parse(match[0]) as AnalysisJson;
  } catch {
    // fall through
  }
  if (!result.winning_pattern || !result.personality_profile) {
    return { ok: false, error: "分析JSONの解析に失敗（保存せず終了・cronで再試行可能）" };
  }

  const label = result.human_type_label || "タイプ不明";

  // 4-E. ai_prompts に保存（重複防止 + 参照用）— 最初に書いて多重実行を防ぐ
  await supabase.from("ai_prompts").upsert({
    key: dedupeKey,
    label: `成約分析: ${label}（${outcomeLabel}）`,
    content: JSON.stringify({
      outcome,
      analyzed_at: new Date().toISOString(),
      message_count: msgs.length,
      ...result,
    }),
    updated_at: new Date().toISOString(),
  }, { onConflict: "key" });

  // 4-A. winning_pattern_logs に確定事例として INSERT
  // 失注（closed_lost）の場合は was_correct=false（勝ちパターンとして参照されないようにする）
  const { error: logErr } = await supabase.from("winning_pattern_logs").insert({
    conversation_id: conversationId,
    customer_id: pcId,
    predicted_pattern: result.winning_pattern,
    actual_outcome: outcome,
    was_correct: !isLost, // 申込/成約は確定 true・失注は false
    personality_profile: result.personality_profile,
  });
  if (logErr) console.warn("[analyze-closed] winning_pattern_logs insert失敗:", logErr.message);

  // 人間性ベースの pgvector 類似検索（customer-summary の fetchWinningPatterns）で
  // 引けるように personality_profile を embedding 化して付与
  const embedding = await generateEmbedding(result.personality_profile).catch(() => null);
  const embeddingField = embedding ? { embedding: JSON.stringify(embedding) } : {};

  // 4-B. ai_reply_knowledge: 高品質パターン（importance 9）
  // 失注の場合は「避けるべきパターン」として明示し、正例と混同されないようにする
  const { error: kErr1 } = await supabase.from("ai_reply_knowledge").insert({
    category: "pattern",
    title: `[${isLost ? "失注分析" : "成約分析"}] ${label}`.slice(0, 100),
    content: isLost
      ? `【失注パターン・避けるべき対応】${result.winning_pattern}\n---\n後ろ向きになった転換点: ${result.turning_point ?? ""}\n取るべきだった対応: ${result.what_worked ?? ""}`
      : `${result.winning_pattern}\n---\n転換点: ${result.turning_point ?? ""}\n効果: ${result.what_worked ?? ""}`,
    importance: 9,
    personality_tags: result.personality_profile,
    conversation_state: "applying",
    ...embeddingField,
  });
  if (kErr1) console.warn("[analyze-closed] ai_reply_knowledge(成約分析) insert失敗:", kErr1.message);

  // 4-C. ai_reply_knowledge: 転換点（importance 8）
  const { error: kErr2 } = await supabase.from("ai_reply_knowledge").insert({
    category: "pattern",
    title: `[${isLost ? "失注転換点" : "転換点"}] ${label}`.slice(0, 100),
    content: isLost
      ? `【失注の転換点】${result.turning_point ?? ""}\n→ 取るべきだった対応: ${result.what_worked ?? ""}`
      : `${result.turning_point ?? ""}\n→ ${result.what_worked ?? ""}`,
    importance: 8,
    personality_tags: result.personality_profile,
    conversation_state: "proposing",
    ...embeddingField,
  });
  if (kErr2) console.warn("[analyze-closed] ai_reply_knowledge(転換点) insert失敗:", kErr2.message);

  // 4-D. property_customers に確定プロファイルを UPDATE
  if (pcId) {
    const { error: pcErr } = await supabase
      .from("property_customers")
      .update({ personality_profile: result.personality_profile })
      .eq("id", pcId);
    if (pcErr) console.warn("[analyze-closed] property_customers update失敗:", pcErr.message);
  }

  // 4-F. winning_patterns: 構造化パターン（RAG検索用）
  // embedding は personality_profile + winning_pattern を結合してベクトル化

  // AIX シーケンス取得（notes / closing_action 強化に使用）
  const { data: aixLogs } = await supabase
    .from("aix_usage_logs")
    .select("aix_type")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  const aixTypes = (aixLogs ?? []).map((r: { aix_type: string }) => r.aix_type);
  const aixSequenceString = aixTypes.length > 0 ? aixTypes.join(" → ") : null;
  const aixTerminalAction = aixTypes.length > 0 ? aixTypes[aixTypes.length - 1] : null;

  // closing_action を AIX ターミナルアクションで強化（what_worked が主、AIX が補足）
  const closingActionBase = result.what_worked ?? null;
  const closingAction = (() => {
    if (!aixSequenceString) return closingActionBase;
    const terminalLabel =
      aixTerminalAction === "application_push"
        ? "申込へのAIX誘導シーケンス完了"
        : aixTerminalAction === "estimate_sheet"
        ? "見積書送付シーケンス完了"
        : aixTerminalAction === "property_recommendation"
        ? "物件提案シーケンス完了"
        : `AIXシーケンス完了(${aixTerminalAction})`;
    const aixSuffix = `${terminalLabel}: ${aixSequenceString}`;
    return closingActionBase ? `${closingActionBase} / ${aixSuffix}` : aixSuffix;
  })();

  const wpEmbedText = [result.personality_profile, result.winning_pattern].filter(Boolean).join(" / ");
  const wpEmbedding = await generateEmbedding(wpEmbedText).catch(() => null);
  const { error: wpInsertErr } = await supabase.from("winning_patterns").insert({
    situation: result.personality_profile?.slice(0, 200) ?? null,
    pattern: isLost
      ? `【失注パターン】${result.winning_pattern}`
      : result.winning_pattern,
    closing_action: closingAction,
    human_type_label: label,
    outcome_type: outcome,
    notes: [
      result.turning_point ?? null,
      purchaseSignalLevel ? `[signal:${purchaseSignalLevel}]` : null,
      aixSequenceString ? `[aix:${aixSequenceString}]` : null,
    ].filter(Boolean).join(" / ") || null,
    source_conversation_id: conversationId,
    embedding: wpEmbedding ? JSON.stringify(wpEmbedding) : null,
    importance: isLost ? 8 : 9,
    customer_intent: result.customer_intent ?? null,
    staff_reply_intent: result.staff_reply_intent ?? null,
    checkpoint_stage: checkpointStageFromMeta,
  });
  if (wpInsertErr) console.warn("[analyze-closed] winning_patterns insert失敗:", wpInsertErr.message);

  // 4-G. aix_transition_stats: 成約会話のAIX遷移を蓄積（AIX_NEXT_ACTION_MAP動的更新）
  // 失注は含めない（成約パターンのみ蓄積）
  if (!isLost && aixTypes.length >= 2) {
    for (let i = 0; i < aixTypes.length - 1; i++) {
      const { error: trErr } = await supabase.rpc("increment_aix_transition", {
        p_from: aixTypes[i],
        p_to: aixTypes[i + 1],
      });
      if (trErr) console.warn("[analyze-closed] aix_transition_stats upsert失敗:", trErr.message);
    }
  }

  return { ok: true };
}
