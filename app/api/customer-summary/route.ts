import { NextRequest, NextResponse } from "next/server";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
// 2026-09-29 API 費用の調査: 要約の Sonnet（7日で198回・$4.8）が llm_usage_logs で名前なしだった → 名札と会話 ID だけ付ける（動きは変えない）
import { sumoraLlmMarks } from "@/app/lib/llm-usage-recorder";
import { supabase } from "@/app/lib/supabase";
import { generateEmbedding } from "@/app/lib/knowledge-utils";
// 2026-09-27 竹内: テスト用の会話（YUMA）は学習に入れない（一覧は test-conversations.ts の1か所）
import { isTestConversation } from "@/app/lib/test-conversations";
import { buildCustomerSummarySystemBlocks } from "@/app/lib/customer-summary-prompt";
import { loadCustomerSummaryPrefixInputs } from "@/app/lib/customer-summary-prompt-server";

function getModel(conversationId?: string | null) {
  return new ChatAnthropic({
    model: "claude-sonnet-5",
    // 2026-09-29 Sonnet 5.5 との比べ（scripts/eval-sonnet55.ts）: 12項目の JSON は Sonnet 5 で 488〜596 トークン（上限 600 にほぼ届く）、
    //   5.5 は少し長く 8件中5件が 600 で切れて JSON が読めなかった（読めないと summaryJson={} のまま保存される＝黙って壊れる）。
    //   上限は払う額に入らない（出した分だけ）ので 900 に上げる
    maxTokens: 900,
    // Sonnet 5 は thinking 省略時に adaptive がデフォルトON → maxTokens 600 が thinking に全消費され
    // JSON本文が空になるリスクがあるため明示的に無効化する（generate-reply と同パターン）
    thinking: { type: "disabled" },
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.replace(/\s/g, ""),
    // 2026-09-14: LangChain の既定は再試行6回（7回送信）・タイムアウトは SDK 既定の10分。AIX 送信のたびに呼ばれるので絞る
    maxRetries: 2,
    // 印のヘッダは出口（llm-usage-recorder）が取り除くので Anthropic には届かない（reply-generation-model と同じ渡し方）
    clientOptions: { timeout: 45_000, defaultHeaders: sumoraLlmMarks("customer_summary", conversationId) },
  });
}

// ── 構造化JSON出力プロンプト ──────────────────────────────────────────────
// 2026-09-29 竹内「クロードの部分、キャッシュを営業時間中温める」: SYSTEM 定数と固定の前置きの組み立ては app/lib/customer-summary-prompt.ts へ
//   （文面は同じ。温め prefix-warm が同じ関数で前置きを作る＝1文字もずれない）。材料の読み込みは customer-summary-prompt-server.ts

// ── 文字列類似度（bigram Dice係数）— 人間性プロファイル同士の部分一致スコアリング用 ──
function bigrams(s: string): Set<string> {
  const t = s.replace(/[\s・、。/／]/g, "");
  const set = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}
function diceSimilarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

// 高5: 成約パターン検索を「人間性・行動パターン中心」に再設計
// 方針（竹内）: 人間はパターンでだいたい動きが決まっている。家賃・エリア・間取りは2の次。
// 「今の顧客がどういう人間か」（コミュニケーションスタイル・迷い方・決断の仕方）が似ている
// 過去の成約事例を引き、「この人タイプには何が刺さったか」を winning_pattern に反映する。
//
// 段階1: personality_profile（前回サマリーの人間性プロファイル）で pgvector 類似検索
//        （profileが無い初回顧客は従来の条件テキストで代用）
// 段階2: 段階1が3件未満なら winning_pattern_logs の was_correct=true（実際に当たった予測）から
//        人間性プロファイルの文字列類似度（bigram Dice）で上位3件を補完
// フォールバック: どちらも0件なら従来の最新5件
async function fetchWinningPatterns(
  personalityProfile: string,
  conditionQueryText: string
): Promise<Array<{ content: string }>> {
  const results: Array<{ content: string }> = [];
  // [成約分析]/[転換点] は analyze-closed-conversation（Opus 4.8）が申込/成約時に書く高価値ナレッジ
  const isWonTitle = (t: string) => /成約パターン|決まった|closed_won|成約分析|転換点/i.test(t);

  // ── 段階1: 人間性プロファイルで pgvector 類似検索（match_reply_knowledge RPC）──
  const queryText = personalityProfile || conditionQueryText;
  if (queryText && process.env.OPENAI_API_KEY) {
    const embedding = await generateEmbedding(queryText);
    if (embedding) {
      const { data: vectorHits, error: rpcError } = await supabase.rpc("match_reply_knowledge", {
        query_embedding: embedding,
        match_count: 8,
        min_importance: 7,
      }) as {
        data: Array<{ content: string; category: string; title: string; importance: number; similarity: number }> | null;
        error: { message: string } | null;
      };
      if (rpcError) console.warn("[customer-summary] match_reply_knowledge RPC error:", rpcError.message);
      const patterns = (vectorHits ?? [])
        .filter(r => (r.category === "pattern" || r.category === "applying_pattern") && (r.similarity ?? 0) >= 0.5)
        // 成約系タイトル（成約パターン/決まった/closed_won）を優先、同格なら類似度順
        .sort((a, b) => {
          const aWon = isWonTitle(a.title ?? "") ? 1 : 0;
          const bWon = isWonTitle(b.title ?? "") ? 1 : 0;
          if (aWon !== bWon) return bWon - aWon;
          return (b.similarity ?? 0) - (a.similarity ?? 0);
        })
        .slice(0, 5);
      results.push(...patterns.map(p => ({ content: p.content })));
    }
  }

  // ── 段階2: 3件未満なら winning_pattern_logs の「実際に当たった予測」を人間性類似で補完 ──
  if (personalityProfile && results.length < 3) {
    const { data: logs } = await supabase
      .from("winning_pattern_logs")
      .select("customer_id, predicted_pattern, personality_profile")
      .eq("was_correct", true)
      .order("created_at", { ascending: false })
      .limit(50);
    const logRows = (logs ?? []) as Array<{
      customer_id: string | null;
      predicted_pattern: string;
      personality_profile: string | null;
    }>;

    // personality_profile 未保存の旧レコードは property_customers.ai_summary_json から補完
    const missingIds = [...new Set(
      logRows.filter(l => !l.personality_profile && l.customer_id).map(l => l.customer_id as string)
    )];
    const profileByCustomer = new Map<string, string>();
    if (missingIds.length > 0) {
      const { data: pcs } = await supabase
        .from("property_customers")
        .select("id, ai_summary_json")
        .in("id", missingIds);
      for (const pc of (pcs ?? []) as Array<{ id: string; ai_summary_json: SummaryJson | null }>) {
        const prof = pc.ai_summary_json?.personality_profile;
        if (prof) profileByCustomer.set(pc.id, prof);
      }
    }

    const scored = logRows
      .map(l => {
        const prof = l.personality_profile
          ?? (l.customer_id ? profileByCustomer.get(l.customer_id) : undefined)
          ?? "";
        return { prof, pattern: l.predicted_pattern, score: prof ? diceSimilarity(personalityProfile, prof) : 0 };
      })
      .filter(l => l.score >= 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    results.push(...scored.map(l => ({
      content: `【人間性が似た顧客で実際に当たった一手】人間性: ${l.prof} → 当たった一手: ${l.pattern}`,
    })));
  }

  if (results.length > 0) return results;

  // フォールバック: 従来通り最新5件（[成約分析]/[転換点] タイトルも対象に含める）
  // L139のベクトル検索側と同様に applying_pattern も対象に含める
  const { data } = await supabase
    .from("ai_reply_knowledge")
    .select("content")
    .in("category", ["pattern", "applying_pattern"])
    .or("title.ilike.成約パターン_%,title.ilike.[成約分析]%,title.ilike.[転換点]%")
    .order("created_at", { ascending: false })
    .limit(5);
  return (data as Array<{ content: string }> | null) ?? [];
}

const STATUS_LABEL: Record<string, string> = {
  new_inquiry:     "新規問い合わせ",
  hot:             "毎日物件出し中",
  property_search: "物件探し中",
  pending:         "検討中",
};

// ai_summary_json のスキーマ定義
export type SummaryJson = {
  situation?: string;
  inspection?: { requested?: boolean; done?: boolean; properties?: string[] };
  estimate?: { requested?: boolean };
  requirements?: string[];
  opinions?: string[];
  our_actions?: string[];
  winning_pattern?: string;
  next_action?: string;
  emotion?: string;
  urgency?: string;
  style?: string;
  personality_profile?: string;
};

// JSON → テキスト変換（generate-reply の ★決まるパターン抽出との後方互換を維持）
function jsonToText(j: SummaryJson): string {
  const lines: string[] = [];

  if (j.situation) lines.push(`・${j.situation}`);

  if (j.inspection) {
    const parts: string[] = [];
    if (j.inspection.requested) parts.push(j.inspection.done ? "希望あり・実施済み" : "希望あり・未実施");
    else parts.push("希望なし");
    if (j.inspection.properties && j.inspection.properties.length > 0) {
      parts.push(j.inspection.properties.join("・"));
    }
    lines.push(`・内覧: ${parts.join(" → ")}`);
  }

  if (j.requirements && j.requirements.length > 0) {
    lines.push(`・要望: ${j.requirements.join(" / ")}`);
  }

  if (j.opinions && j.opinions.length > 0) {
    lines.push(`・意見: ${j.opinions.join(" / ")}`);
  }

  if (j.our_actions && j.our_actions.length > 0) {
    lines.push(`・アクション: ${j.our_actions.join(" → ")}`);
  }

  if (j.estimate?.requested) {
    lines.push(`・見積依頼: あり`);
  }

  if (j.emotion) {
    lines.push(`・顧客温度感: ${j.emotion}`);
  }

  if (j.urgency) {
    lines.push(`・入居希望時期: ${j.urgency}`);
  }

  if (j.style) {
    lines.push(`・文体傾向: ${j.style}`);
  }

  if (j.personality_profile) {
    lines.push(`・人間性プロファイル: ${j.personality_profile}`);
  }

  if (j.winning_pattern) {
    lines.push(`★決まるパターン: ${j.winning_pattern}`);
  }

  if (j.next_action) {
    lines.push(`🎯次のアクション: ${j.next_action}`);
  }

  return lines.join("\n");
}

type SummaryRequest = {
  customer_id?:         string;
  customer_name?:       string;
  status?:              string;
  desired_area?:        string | null;
  floor_plan?:          string | null;
  floor_area_min?:      number | null;
  rent_min?:            number | null;
  rent_max?:            number | null;
  walk_minutes?:        number | null;
  move_in_time?:        string | null;
  building_age?:        number | null;
  initial_cost_limit?:  number | null;
  preferences?:         string | null;
  ng_points?:           string | null;
  other_requests?:      string | null;
  property_memo?:       string | null;
  property_send_count?: number | null;
  additional_conditions?: string | null;
  last_message?:        string | null;
  last_message_sender?: string | null;
  conversation_id?:     string | null;
  fetch_from_db?:       boolean;
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as SummaryRequest;

    // fetch_from_db: webhook などから customer_id のみ渡す場合 → DBから全データ取得
    let c: SummaryRequest = body;
    if (body.fetch_from_db && body.customer_id) {
      const { data: dbC } = await supabase
        .from("property_customers")
        .select("customer_name, status, desired_area, floor_plan, floor_area_min, rent_min, rent_max, walk_minutes, move_in_time, building_age, initial_cost_limit, preferences, ng_points, other_requests, property_memo, property_send_count, additional_conditions, ai_summary_at")
        .eq("id", body.customer_id)
        .single();
      if (dbC) {
        c = { ...body, ...(dbC as Partial<SummaryRequest & { ai_summary_at?: string }>) };

        // スロットリング: 2時間以内に生成済みなら会話件数チェック
        const summaryAt = (dbC as Record<string, unknown>).ai_summary_at as string | null;
        if (summaryAt) {
          const ageMs = Date.now() - new Date(summaryAt).getTime();
          if (ageMs < 2 * 60 * 60 * 1000) {
            // 直近の新着メッセージ数を確認（3件未満ならスキップ）
            if (body.conversation_id) {
              const { count } = await supabase
                .from("messages")
                .select("id", { count: "exact", head: true })
                .eq("conversation_id", body.conversation_id)
                .gt("created_at", summaryAt);
              if ((count ?? 0) < 3) {
                const { data: existing } = await supabase
                  .from("property_customers")
                  .select("ai_summary, ai_summary_json")
                  .eq("id", body.customer_id)
                  .single();
                return NextResponse.json({
                  summary: existing?.ai_summary ?? "",
                  summaryJson: existing?.ai_summary_json ?? null,
                  cached: true,
                });
              }
            } else {
              // conversation_id なしのスロットリングは1時間
              if (ageMs < 1 * 60 * 60 * 1000) {
                const { data: existing } = await supabase
                  .from("property_customers")
                  .select("ai_summary, ai_summary_json")
                  .eq("id", body.customer_id)
                  .single();
                return NextResponse.json({
                  summary: existing?.ai_summary ?? "",
                  summaryJson: existing?.ai_summary_json ?? null,
                  cached: true,
                });
              }
            }
          }
        }
      }
    }

    // 固定の前置きの材料（プロンプト管理UIの上書き or コード定数・next_action 改善ルール）。温めと同じ関数（2026-09-29）
    const prefixInputs = await loadCustomerSummaryPrefixInputs();

    // 会話履歴を取得
    let conversationHistory = "";
    if (c.conversation_id) {
      const { data: msgs } = await supabase
        .from("messages")
        .select("sender, text, created_at")
        .eq("conversation_id", c.conversation_id)
        .neq("text", "[画像]")
        .neq("text", "[動画]")
        .not("text", "is", null)
        .order("created_at", { ascending: false })
        .limit(30);
      if (msgs && msgs.length > 0) {
        const lines = (msgs as Array<{ sender: string; text: string }>)
          .reverse()
          // 顧客メッセージは300字（ニーズ・感情の把握に重要）、スタッフメッセージは150字（送信済み内容のため据え置き）
          .map((m) => {
            const isCustomer = m.sender === "customer";
            return `${isCustomer ? "お客さん" : "スタッフ"}: ${(m.text || "").slice(0, isCustomer ? 300 : 150)}`;
          })
          .join("\n");
        conversationHistory = `\n\n【直近の会話履歴】\n${lines}`;
      }
    }

    const rentStr = (c.rent_min || c.rent_max)
      ? `${c.rent_min ? Math.floor(c.rent_min / 10000) + "万〜" : "〜"}${c.rent_max ? Math.floor(c.rent_max / 10000) + "万" : ""}`
      : null;

    // 高5: personality_profile を取得（人間性ベース成約パターン検索の主クエリ）
    // 1. まず property_customers.personality_profile（申込/成約時に Opus 4.8 が確定した版）を優先
    // 2. なければ ai_summary_json.personality_profile（前回サマリーの推測版）を使う
    let priorPersonalityProfile = "";
    let profileIsConfirmed = false;
    if (c.customer_id) {
      const { data: prevRow } = await supabase
        .from("property_customers")
        .select("ai_summary_json, personality_profile")
        .eq("id", c.customer_id)
        .single();
      const row = prevRow as { ai_summary_json?: SummaryJson | null; personality_profile?: string | null } | null;
      const confirmedProfile = row?.personality_profile?.trim() ?? "";
      if (confirmedProfile) {
        priorPersonalityProfile = confirmedProfile;
        profileIsConfirmed = true;
      } else {
        priorPersonalityProfile = row?.ai_summary_json?.personality_profile?.trim() ?? "";
      }
    }

    // 中2: 顧客プロフィール（条件・こだわり）→ 成約パターン類似検索の副次クエリ（personality_profile が無い初回顧客用・先頭200字）
    const patternQueryText = [
      c.desired_area   && `エリア:${c.desired_area}`,
      c.floor_plan     && `間取り:${c.floor_plan}`,
      rentStr          && `家賃:${rentStr}`,
      c.move_in_time   && `入居:${c.move_in_time}`,
      c.preferences,
      c.other_requests,
      c.ng_points      && `NG:${c.ng_points}`,
    ].filter(Boolean).join(" ").slice(0, 200);

    // 過去の成約パターン（pgvector類似検索）・内覧DB事実 を並列取得
    // （next_action 改善ルールは全お客様共通なので prefixInputs → system[1]（1h キャッシュ）へ移した・2026-09-29）
    const [learnedPatterns, viewingsRes] = await Promise.all([
      fetchWinningPatterns(priorPersonalityProfile, patternQueryText)
        .catch((err) => { console.warn("[customer-summary] fetchWinningPatterns失敗:", err); return [] as Array<{ content: string }>; }),
      // 中4: 内覧事実のDB突合（property_customers に内覧日時カラムは存在しないため viewings テーブルを参照）
      c.conversation_id
        ? supabase
            .from("viewings")
            .select("viewing_date, status")
            .eq("conversation_id", c.conversation_id)
            .order("viewing_date", { ascending: false })
            .limit(5)
        : Promise.resolve({ data: null }),
    ]);

    // 高5: 人間性プロファイル注入。確定版（Opus分析）は信頼度が高いため推測版と区別して表示する
    const personalityProfileNote = priorPersonalityProfile
      ? (profileIsConfirmed
          ? `\n\n【確定済み人間性プロファイル（Opus分析）】\n${priorPersonalityProfile}\n※ 申込/成約時に確定した高信頼プロファイル。personality_profile 生成時はこれを土台にすること。`
          : `\n\nこの顧客の人間性プロファイル（前回AI推測）: ${priorPersonalityProfile}`)
      : "";

    // 高5: 人間性中心の成約パターン注入（家賃・エリアより「どんな人が・何で決めたか」を重視させる）
    const learnedPatternsNote = learnedPatterns.length > 0
      ? `\n\n【参考: 似た人間性タイプで成約した事例】\n${
          learnedPatterns.map(p => p.content).join("\n---\n")
        }${personalityProfileNote}\n\n↑ 家賃・エリアより「どんな人が・何で決めたか」のパターンを重視して winning_pattern を生成すること。`
      : personalityProfileNote;

    // 中4: viewings に確定レコードがあれば inspection の確定値としてプロンプトに注入
    // （status='done' → done=true 確定 / 'scheduled' → requested=true 確定。なければ従来のキーワード判定のまま）
    const viewingRows = ((viewingsRes as { data: Array<{ viewing_date: string; status: string }> | null }).data ?? []);
    const doneViewing = viewingRows.find(v => v.status === "done");
    const scheduledViewing = viewingRows.find(v => v.status === "scheduled");
    const inspectionFactNote = doneViewing
      ? `\n\n【内覧ステータス（DB確定値・会話からの推測より必ず優先）】内覧は実施済み（${doneViewing.viewing_date}）。inspection.requested と inspection.done は必ず true にすること。`
      : scheduledViewing
        ? `\n\n【内覧ステータス（DB確定値・会話からの推測より必ず優先）】内覧予定が登録済み（${scheduledViewing.viewing_date}・未実施）。inspection.requested は必ず true。実施済みと確認できる会話がない限り inspection.done は false のままにすること。`
        : "";

    const info = [
      `名前: ${c.customer_name}`,
      `ステータス: ${STATUS_LABEL[c.status ?? ""] ?? c.status}`,
      c.desired_area         && `希望エリア: ${c.desired_area}`,
      c.floor_plan           && `間取り: ${c.floor_plan}`,
      c.floor_area_min       && `広さ: ${c.floor_area_min}㎡以上`,
      rentStr                && `家賃: ${rentStr}`,
      c.walk_minutes         && `駅徒歩: ${c.walk_minutes}分以内`,
      c.move_in_time         && `入居時期: ${c.move_in_time}`,
      c.building_age         && `築年数: ${c.building_age}年以内`,
      c.initial_cost_limit   && `初期費用: ${Math.floor(c.initial_cost_limit / 10000)}万以内`,
      c.preferences          && `こだわり: ${c.preferences}`,
      c.ng_points            && `NG条件: ${c.ng_points}`,
      c.other_requests       && `その他希望: ${c.other_requests}`,
      c.property_memo        && `社内メモ: ${c.property_memo}`,
      c.property_send_count != null && `物件送付回数: ${c.property_send_count}回`,
      c.additional_conditions && `追加・変更履歴:\n${c.additional_conditions}`,
      c.last_message         && `最後のメッセージ（${c.last_message_sender === "customer" ? "お客さん" : "スタッフ"}）:「${c.last_message}」`,
    ].filter(Boolean).join("\n") + learnedPatternsNote + inspectionFactNote + conversationHistory;

    // prompt cache: 静的なシステムプロンプト（SYSTEM 定数 or ai_prompts の上書き）＋全お客様共通の改善ルールを
    // system の2ブロック + cache_control（1h）でキャッシュする（buildCustomerSummarySystemBlocks・温めと同じ関数）。
    // 動的な顧客情報（info）は HumanMessage 側のみに置き、絶対に cache_control を付けない。
    const res = await getModel(c.conversation_id ?? null).invoke([
      new SystemMessage({ content: buildCustomerSummarySystemBlocks(prefixInputs.systemPrompt, prefixInputs.nextActionRuleContents) }),
      new HumanMessage(info),
    ]);

    const rawText = typeof res.content === "string" ? res.content : JSON.stringify(res.content);

    // JSON抽出
    let summaryJson: SummaryJson = {};
    try {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) summaryJson = JSON.parse(match[0]) as SummaryJson;
    } catch {
      // JSON解析失敗時は空オブジェクト
    }

    // テキスト変換（generate-reply との後方互換）
    const summary = jsonToText(summaryJson) || rawText.trim();

    if (c.customer_id) {
      await supabase.from("property_customers").update({
        ai_summary: summary,
        ai_summary_json: summaryJson,
        ai_summary_at: new Date().toISOString(),
      }).eq("id", c.customer_id);

      // next_action 予測をログに保存（差分学習の基準点）
      // 2026-09-27 竹内: テスト用の会話（YUMA）は予測の答え合わせ（next_action・winning_pattern）に入れない
      const isTestConv = isTestConversation(c.conversation_id ?? null);
      if (summaryJson.next_action && !isTestConv) {
        supabase.from("next_action_logs").insert({
          customer_id: c.customer_id,
          conversation_id: c.conversation_id ?? null,
          predicted_action: summaryJson.next_action,
        }).then(() => {}, () => {});
      }

      // 中1: winning_pattern 予測をログに保存（週次 eval-winning-pattern cron が成約/失注結果と突合して答え合わせ）
      // conversation_id は NOT NULL のため、会話に紐付く予測のみ記録する
      if (summaryJson.winning_pattern && c.conversation_id && !isTestConv) {
        supabase.from("winning_pattern_logs").insert({
          conversation_id: c.conversation_id,
          customer_id: c.customer_id,
          predicted_pattern: summaryJson.winning_pattern,
          // 高5: 予測時点の人間性プロファイルを一緒に保存（人間性類似の成約事例検索・段階2で使用）
          personality_profile: summaryJson.personality_profile ?? null,
          actual_outcome: null,
          was_correct: null,
        }).then(() => {}, () => {});
      }
    }

    return NextResponse.json({ summary, summaryJson });
  } catch (e) {
    console.error("customer-summary error:", e);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
