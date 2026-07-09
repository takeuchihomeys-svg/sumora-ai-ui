import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { upsertKnowledge, buildKnowledgeEmbeddingInput, generateEmbedding } from "@/app/lib/knowledge-utils";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 60;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "", timeout: 30_000, maxRetries: 1 });

// コンポーネントが省略・大幅再構成された場合（structure変化）の学習ルール抽出
//「なぜこのパーツを省いたか」を学ぶ → カテゴリ=pattern
async function analyzeStructureDiff(
  customerMessage: string,
  aiComponentText: string,
  sentReply: string,
  componentState: string,
  componentName: string,
): Promise<{ skip: boolean; title?: string; rule?: string } | null> {
  try {
    const res = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      messages: [{
        role: "user",
        content: `物件送り文の「${componentName}」をスタッフが省略または大きく変更しました。なぜそうしたか学習ルールを抽出してください。

【AIが生成した「${componentName}」】
${aiComponentText}

【スタッフが実際に送った全文】
${sentReply}

【お客様のメッセージ・状況】
${customerMessage || "不明"}

スキップ条件（以下なら {"skip":true} のみ返す）：
- 文が短すぎて判断できない
- 全文が固有情報（物件名・日付）のみ

学習ルールがある場合：
{"skip":false,"title":"${componentName}構成: [パターン名・30文字以内]","rule":"[どの状況でこのパーツを省く/変えるかの具体ルール・150文字以内]"}

JSONのみ返す。`,
      }],
    });
    const text = res.content[0].type === "text" ? res.content[0].text.trim() : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as { skip: boolean; title?: string; rule?: string };
  } catch {
    return null;
  }
}

// 物件ピックアップした: 特定のコンポーネント（intro/pickup/invite/closing）単位で差分分析
// aiComponentText = AIが生成したそのパーツのテキスト、sentReply = スタッフが送った全文
// Haikuがsentifyの中から該当パーツを特定して比較する
async function analyzeComponentDiff(
  customerMessage: string,
  aiComponentText: string,
  sentReply: string,
  componentState: string, // "property_send_pickup" 等
  componentName: string,  // "ピックアップ行（条件説明）" 等
): Promise<{ skip: boolean; title?: string; rule?: string } | null> {
  try {
    const res = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `物件ピックアップメッセージの「${componentName}」パーツについて、スタッフがAI文案を改善した差分から学習ルールを抽出してください。

【AIが生成した「${componentName}」】
${aiComponentText}

【スタッフが実際に送った全文（この中から「${componentName}」に対応する部分を見つけて比較する）】
${sentReply}

分析手順：
① スタッフの全文の中からAIの「${componentName}」に対応する部分を特定する
② AIの生成と比較して変わった点（言い回し・強調・省略・言葉の選択）を特定する
③ その変化が次回の生成に活かせるルールかを判断する

スキップ条件（以下のみなら {"skip":true}）：
- 物件名・エリア・日時・顧客名などの固有情報だけが違う
- ほぼ同じ（90%以上一致）
- スタッフの文中に対応するパーツが見当たらない

学習ルールがある場合のJSON（スキップ以外）：
{"skip":false,"title":"${componentName}改善: [パターン名・30文字以内]","rule":"[次回から守るべきルール・200文字以内。NG表現→OK表現の対比で書く]"}

JSONのみを返す。説明不要。`,
      }],
    });
    const text = res.content[0].type === "text" ? res.content[0].text.trim() : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as { skip: boolean; title?: string; rule?: string };
  } catch {
    return null;
  }
}

// AIドラフトと実送信の差分を比較して学習ルールを抽出
async function analyzeDiff(
  customerMessage: string,
  aiDraft: string,
  sentReply: string,
  conversationState: string,
  componentHint = "",
): Promise<{ skip: boolean; title?: string; rule?: string; category?: string; trigger_example?: string } | null> {
  try {
    const res = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 900,
      messages: [{
        role: "user",
        content: `スタッフが実際に送った返信とAIの下書きを「構成・文の役割」レベルで比較分析し、改善パターンを抽出してください。${componentHint}

【お客様のメッセージ】
${customerMessage || "不明"}

【AIの下書き】
${aiDraft}

【スタッフが実際に送った返信（正解）】
${sentReply}

【フェーズ】${conversationState}

▼ この順番で分析する
① スタッフの返信を1文ずつ分解し、各文の「役割」をラベル付け
   役割ラベル例：[承認][共感][情報提供][提案][申込誘導][確認質問][次アクション][感謝][サポート姿勢]
② AIの下書きも同様に分解・役割付け
③ 役割レベルで比較：削除された役割・追加された役割・順番の変化を特定
④ 「なぜその構成がこのお客様の心理に正解か」を1文で考える

▼ スキップ条件（以下のみなら {"skip":true} のみ返す）
- 固有情報（物件名・金額・日時・住所・顧客名）のみ違う
- 誤字修正のみ（1〜2文字）
- 役割・構成・意図に実質的な差がない（ほぼ同じ）

▼ 学習ルールがある場合のJSON出力
{"skip":false,"title":"差分学習: [構成パターン名（30文字以内・具体的に）]","rule":"[役割レベルのルール。NG構成→OK構成、なぜその順番が正解かの理由を含む。250文字以内]","category":"[pattern=構成テンプレート / style=文体・トーン / phrase=言い回し のいずれかのみ。principle は絶対に選ばないこと]","trigger_example":"[このルールが適用される典型的なお客様メッセージの例文（1〜2文）。お客様が実際に送ってきそうな言葉で書く。ルールの説明文ではなくお客様側のメッセージそのものを書くこと]"}

JSONのみを返す。分析の途中経過は不要。`,
      }],
    });

    const text = res.content[0].type === "text" ? res.content[0].text.trim() : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as { skip: boolean; title?: string; rule?: string; category?: string; trigger_example?: string };
  } catch {
    return null;
  }
}

function textSimilarity(a: string, b: string): number {
  const s1 = a.replace(/\s+/g, "");
  const s2 = b.replace(/\s+/g, "");
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  // 文字レベルLCS（Dice係数）— 旧実装は j がループをまたいでリセットされず不正確だった
  const la = [...s1], lb = [...s2];
  const m = la.length, n = lb.length;
  // メモリ節約のため1次元DP
  const dp = new Array(n + 1).fill(0);
  let prev = 0;
  for (let i = 1; i <= m; i++) {
    prev = 0;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = la[i - 1] === lb[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  const lcs = dp[n];
  return (2 * lcs) / (m + n); // Dice係数
}

// 修正量に応じて importance を変動（save-reply-example と統一）
// sim < 0.4 = 大幅修正 → 9 / 0.4〜0.65 = 中程度 → 8 / 0.65〜 = 微修正 → 7
function diffImportance(sim: number): number {
  if (sim < 0.4) return 9;
  if (sim < 0.65) return 8;
  return 7;
}

// ── モジュールレベル定数（コンポーネント学習・ポジティブ強化で共用）──
const STATE_LEARNABLE: Record<string, string[]> = {
  property_send:                    ["intro", "pickup", "invite", "calendar", "closing"],
  property_send_new_arrival:        ["intro", "pickup", "invite", "calendar", "closing"],
  property_send_widen:              ["intro", "widen_note", "pickup", "invite", "closing"],
  viewing_invite:                   ["greeting", "situation", "invite", "closing"],
  application_push:                 ["movein_date", "appeal", "cta", "invite", "reassurance", "closing"],
  application_push_push:            ["greeting", "appeal", "cta", "reassurance", "closing"],
  application_push_confirm:         ["greeting", "confirmation", "closing"],
  application_push_docs_request:    ["greeting", "doc_list", "cta", "closing"],
  acknowledge_check:                ["greeting", "property_info", "estimate_request", "closing"],
  // 全アクション網羅（ポジティブ強化・差分学習の抜け防止）
  property_recommendation:          ["intro", "recommendation", "appeal", "invite", "closing"],
  property_check_result:            ["intro", "result", "calendar", "invite", "closing"],
  property_check_result_available:  ["intro", "result", "calendar", "invite", "closing"],
  property_check_result_unavailable:["intro", "result", "closing"],
  property_check_result_alternative:["intro", "result", "invite", "closing"],
  condition_hearing:                ["greeting", "intro", "cta", "closing"],
  meeting_place:                    ["greeting", "confirmation", "location", "closing"],
  estimate_sheet:                   ["greeting", "estimate_note", "invite", "closing"],
  followup_revive:                  ["greeting", "reminder", "invite", "cta", "closing"],
  // F05: followup_revive の states に含まれるが STATE_LEARNABLE に未定義だったエントリ
  hearing:                          ["greeting", "questions", "proposal", "closing"],
  proposing:                        ["greeting", "recommendation", "appeal", "invite", "closing"],
  // MED-10: ACTION_TO_STATE にあるが STATE_LEARNABLE に抜けていたエントリ
  greeting_viewing:                 ["greeting", "reminder", "closing"],
  property_check_result_vacate_date:       ["greeting", "result", "calendar", "invite", "closing"],
  property_check_result_mgmt_guarantor:    ["greeting", "result", "invite", "closing"],
  property_check_result_mgmt_move_in:      ["greeting", "result", "closing"],
  property_check_result_mgmt_initial_cost: ["greeting", "result", "invite", "closing"],
};

const COMPONENT_NAMES: Record<string, string> = {
  intro:            "挨拶文",
  pickup:           "ピックアップ行（条件説明）",
  invite:           "内覧誘導文",
  calendar:         "内覧可能日時の記載（直近ですと〜ご案内可能です）",
  closing:          "締め文",
  greeting:         "挨拶文",
  situation:        "状況・背景説明",
  appeal:           "物件アピール文",
  cta:              "申込み後押し文",
  reassurance:      "不安解消・フォロー一言（保証会社審査〜キャンセル料なし等）",
  movein_date:      "入居日安心（〇月〇日のご入居で問題ございません！！）",
  property_info:    "物件・確認内容の記載",
  estimate_request: "最大限割引した初期費用の御見積もり依頼",
  recommendation:   "おすすめ物件の紹介文",
  result:           "物件確認結果（空室あり/満室等）",
  confirmation:     "日程・内容の確認文",
  location:         "待ち合わせ場所の案内",
  reminder:         "久しぶり連絡・状況確認文",
  estimate_note:    "見積書の補足説明文",
  doc_list:         "必要書類リスト",
  widen_note:       "条件広げ説明文",
};

// 【textSimilarity 案C】数字・肯否変化がある場合のみ true（意味的変化の有無を低コストで判定）
// 言い回しが変わっても数字・Yes/Noが同じなら意味的に同じとみなす
function hasSemanticChange(a: string, b: string): boolean {
  const numsA = a.match(/\d+/g) ?? [];
  const numsB = b.match(/\d+/g) ?? [];
  if (JSON.stringify(numsA) !== JSON.stringify(numsB)) return true;
  const negA = (a.match(/(?:できません|ございません|ありません|いません|しません|ません)/g) ?? []).length;
  const negB = (b.match(/(?:できません|ございません|ありません|いません|しません|ません)/g) ?? []).length;
  return negA !== negB;
}

// 【textSimilarity 案B】グレーゾーン（sim 0.7〜0.95）のみ Haiku で意味的同一性を判定
// 「大倉さんご都合如何」vs「はいかが」など言い回し差分の誤学習を防止
async function isMeaningfullySame(aiText: string, sentText: string): Promise<boolean> {
  try {
    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 50,
      messages: [{ role: "user", content:
        `以下2つの文章は意味・意図が実質的に同じですか？言い回しが違うだけかどうか判断してください。\n【A】${aiText.slice(0, 400)}\n【B】${sentText.slice(0, 400)}\nJSONのみ: {"same": true}または{"same": false}`,
      }],
    });
    const text = res.content[0].type === "text" ? res.content[0].text.trim() : "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return false;
    const parsed = JSON.parse(match[0]) as { same: boolean };
    return parsed.same === true;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const runLogId = await startCronLog("analyze-diffs");
  // ?limit=N で件数を指定可能（デフォルト30・最大200）
  // maxDuration=60秒 / 1件あたり約2秒 → 30件が上限目安
  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 30, 200) : 30;

  // 未処理の差分を取得（is_starred順で重要な学習から処理）
  const { data: examples, error: examplesError } = await supabase
    .from("ai_reply_examples")
    .select("id, customer_message, ai_draft, sent_reply, conversation_state, is_starred, ai_components, reply_angle")
    .eq("was_ai_modified", true)
    .is("diff_analyzed_at", null)
    .not("ai_draft", "is", null)
    .not("sent_reply", "is", null)
    .order("is_starred", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);

  // DBエラーを空配列として握りつぶさず、明示的にエラーを返す
  if (examplesError) {
    return NextResponse.json({ ok: false, error: examplesError.message }, { status: 500 });
  }

  if (!examples || examples.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, learned: 0, message: "処理対象なし" });
  }

  let processed = 0;
  let learned = 0;
  const now = new Date().toISOString();

  for (const ex of examples) {
    const { id, customer_message, ai_draft, sent_reply, conversation_state, is_starred, ai_components, reply_angle } = ex as {
      id: string;
      customer_message: string;
      ai_draft: string;
      sent_reply: string;
      conversation_state: string;
      is_starred: boolean;
      ai_components: Record<string, string> | null;
      reply_angle: string | null;
    };

    // 完全一致はスキップ（構成が同じなので学習不要）
    if ((ai_draft ?? "").trim() === (sent_reply ?? "").trim()) {
      await supabase.from("ai_reply_examples").update({ diff_analyzed_at: now }).eq("id", id);
      processed++;
      continue;
    }

    // 分割送信っぽい場合（sentReplyがaiDraftの40%未満かつ類似度50%以上）はスキップ
    const sim = textSimilarity((ai_draft ?? "").trim(), (sent_reply ?? "").trim());
    const likelySplit = (sent_reply ?? "").trim().length < (ai_draft ?? "").trim().length * 0.4 && sim >= 0.5;
    if (likelySplit) {
      await supabase.from("ai_reply_examples").update({ diff_analyzed_at: now }).eq("id", id);
      processed++;
      continue;
    }

    // 【textSimilarity 案C+B】グレーゾーン（sim 0.7〜0.95）かつ意味的変化なし → Haiku で確認 → 誤学習スキップ
    // 数字・肯否変化のない言い回し差分（如何→いかが等）を誤学習させない
    if (sim >= 0.7 && sim < 0.95 && !hasSemanticChange(ai_draft ?? "", sent_reply ?? "")) {
      const same = await isMeaningfullySame(ai_draft ?? "", sent_reply ?? "");
      if (same) {
        // 意味的に同じ = AIが実質正解 → コンポーネントをポジティブ強化してスキップ
        if (ai_components) {
          const posLearnList = STATE_LEARNABLE[conversation_state] ?? [];
          for (const comp of posLearnList.slice(0, 3)) {
            if (!(ai_components as Record<string, string>)[comp]) continue;
            const { data: posRules } = await supabase
              .from("ai_reply_knowledge")
              .select("id, importance")
              .eq("conversation_state", `${conversation_state}_${comp}`)
              .order("apply_count", { ascending: false })
              .limit(2);
            for (const rule of posRules ?? []) {
              const imp = (rule.importance as number) ?? 7;
              if (imp < 9) {
                await supabase.from("ai_reply_knowledge")
                  .update({ importance: Math.min(9, imp + 1) }).eq("id", rule.id);
              }
            }
          }
        }
        await supabase.from("ai_reply_examples").update({ diff_analyzed_at: now }).eq("id", id);
        processed++;
        continue;
      }
    }

    // コンポーネント単位の2層学習
    // reply_angle="component_diff:pickup(phrase),invite(structure)" などが対象
    if (ai_components && reply_angle?.startsWith("component_diff:")) {
      const rawChanged = reply_angle.replace("component_diff:", "").split(",");

      // 新フォーマット "pickup(phrase)" / 旧フォーマット "pickup" に対応
      type CompChange = { comp: string; changeType: "phrase" | "structure" };
      const parsedChanges: CompChange[] = rawChanged.map(c => {
        const m = c.match(/^(\w+)\((\w+)\)$/);
        return m
          ? { comp: m[1], changeType: m[2] as "phrase" | "structure" }
          : { comp: c, changeType: "phrase" as const }; // 旧フォーマットはphrase扱い
      });

      // STATE_LEARNABLE / COMPONENT_NAMES はモジュールレベルで定義済み
      const learnableList = STATE_LEARNABLE[conversation_state] ?? STATE_LEARNABLE["property_send"] ?? [];
      const learnableSet = new Set(learnableList);
      const learnableChanges = parsedChanges.filter(({ comp }) => learnableSet.has(comp));

      if (learnableChanges.length === 0) {
        // 固有情報コンポーネントのみ変化 → 学習不要
        await supabase.from("ai_reply_examples").update({ diff_analyzed_at: now }).eq("id", id);
        processed++;
        continue;
      }

      // ── 誤差学習: 変化したコンポーネントをタイプ別に分析（最大2件）──
      const learnableChangedNames = new Set(learnableChanges.map(c => c.comp));
      for (const { comp, changeType } of learnableChanges.slice(0, 2)) {
        const aiCompText = (ai_components as Record<string, string>)[comp] ?? "";
        if (!aiCompText || aiCompText.length < 5) continue;
        const compState = `${conversation_state}_${comp}`;
        const compName = COMPONENT_NAMES[comp] ?? comp;

        // phrase=文字変化（言い回し）/ structure=パターン変化（省略・構成変更）
        const compResult = changeType === "structure"
          ? await analyzeStructureDiff(customer_message, aiCompText, sent_reply, compState, compName)
          : await analyzeComponentDiff(customer_message, aiCompText, sent_reply, compState, compName);

        if (compResult && !compResult.skip && compResult.title && compResult.rule) {
          const embInput = buildKnowledgeEmbeddingInput({
            trigger_example: customer_message,
            rule: compResult.rule,
            conversation_state: compState,
          });
          const embedding = await generateEmbedding(embInput);
          const imp = is_starred ? Math.min(9, diffImportance(sim) + 1) : diffImportance(sim);
          const upsertResult = await upsertKnowledge(supabase, {
            title: compResult.title,
            content: compResult.rule,
            // structure変化 → pattern（構成ルール） / phrase変化 → phrase（言い回しルール）
            category: changeType === "structure" ? "pattern" : "phrase",
            importance: imp,
            conversation_state: compState,
            source_example_id: id,
            ...(embedding ? { embedding } : {}),
          });
          if (upsertResult === "inserted" || upsertResult === "merged") learned++;
        }
      }

      // ── 予測スコア: 変化しなかったコンポーネントのルールをブースト ──
      // 「AIの予測どおりだった」コンポーネント → 最多適用ルールの importance +1（穴3修正: 盲目的な直近2件→apply_count順）
      const correctComponents = learnableList.filter(c =>
        (ai_components as Record<string, string>)[c] && !learnableChangedNames.has(c),
      );
      for (const comp of correctComponents.slice(0, 2)) {
        const compState = `${conversation_state}_${comp}`;
        const { data: rules } = await supabase
          .from("ai_reply_knowledge")
          .select("id, importance")
          .eq("conversation_state", compState)
          .order("apply_count", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(2);
        for (const rule of rules ?? []) {
          const imp = (rule.importance as number) ?? 7;
          if (imp < 9) {
            await supabase
              .from("ai_reply_knowledge")
              .update({ importance: Math.min(9, imp + 1) })
              .eq("id", rule.id);
          }
        }
      }

      await supabase.from("ai_reply_examples").update({ diff_analyzed_at: now }).eq("id", id);
      processed++;
      continue; // 通常の full-message analyzeDiff はスキップ
    }

    const result = await analyzeDiff(customer_message, ai_draft, sent_reply, conversation_state);

    // AI呼び出し失敗時も diff_analyzed_at をマークして「試行済み」扱いにする
    // （マークしないと毎日同じレコードを拾い続け、常に失敗するレコードでキューが詰まるため）
    if (result === null) {
      console.error(`[analyze-diffs] analyzeDiff failed for example id=${id} — marking diff_analyzed_at to prevent infinite retry`);
      await supabase.from("ai_reply_examples").update({ diff_analyzed_at: now }).eq("id", id);
      processed++;
      continue;
    }

    if (!result.skip && result.title && result.rule) {
      // principle は diff 由来ルールの「絶対ルール」昇格を防ぐため許可しない（#4）
      const ALLOWED_CATEGORIES = new Set(["pattern", "style", "phrase"]);
      const rawCategory = (result.category ?? "pattern").split("=")[0].trim();
      const safeCategory = ALLOWED_CATEGORIES.has(rawCategory) ? rawCategory : "pattern";
      // #21: 検索クエリ（顧客メッセージ）と意味空間を揃えるため trigger_example を優先して embedding 化
      const embeddingInput = buildKnowledgeEmbeddingInput({
        trigger_example: result.trigger_example,
        rule: result.rule,
        conversation_state: conversation_state ?? "proposing",
      });
      const embedding = await generateEmbedding(embeddingInput);
      // ☆つき or 大幅修正ほど importance を上げる
      const baseImp = diffImportance(sim);
      const imp = is_starred ? Math.min(9, baseImp + 1) : baseImp;

      const upsertResult = await upsertKnowledge(supabase, {
        title: result.title,
        content: result.rule,
        category: safeCategory,
        importance: imp,
        conversation_state: conversation_state ?? "proposing",
        source_example_id: id,
        ...(embedding ? { embedding } : {}),
      });

      if (upsertResult === "inserted") {
        learned++;
      } else if (upsertResult === "merged") {
        console.log(`[analyze-diffs] 既存ルール強化: "${result.title}"`);
        learned++;
      } else {
        console.log(`[analyze-diffs] スキップ（重複）: "${result.title}"`);
      }

      // F02: importance>=8 かつ pattern ルールを adaptation_improvement_rules にも同期
      // LINE/AIX修正からの学習をテンプレート修正学習ルールとして両方のAIに届ける
      if ((upsertResult === "inserted" || upsertResult === "merged") && imp >= 8 && safeCategory === "pattern" && result.rule) {
        const adaptCategory = conversation_state ?? "general";
        const adaptConfidence = imp >= 9 ? 0.9 : 0.75;
        const ruleKey = result.rule.slice(0, 50).replace(/[%_\\]/g, "\\$&");
        const { data: existingAdapt } = await supabase
          .from("adaptation_improvement_rules")
          .select("id, example_count, confidence")
          .eq("category", adaptCategory)
          .ilike("rule_text", `${ruleKey}%`)
          .limit(1).maybeSingle();
        if (existingAdapt) {
          await supabase.from("adaptation_improvement_rules").update({
            example_count: (existingAdapt.example_count as number) + 1,
            confidence: Math.min(Math.max(Number(existingAdapt.confidence), adaptConfidence) + 0.02, 0.99),
            last_triggered_at: now, is_active: true,
          }).eq("id", existingAdapt.id);
        } else {
          await supabase.from("adaptation_improvement_rules").insert({
            category: adaptCategory, rule_text: result.rule,
            confidence: adaptConfidence, example_count: 1, is_active: true, last_triggered_at: now,
          });
        }
      }
    }

    await supabase.from("ai_reply_examples").update({ diff_analyzed_at: now }).eq("id", id);
    processed++;
  }

  // ── ポジティブ強化 A: was_ai_used=true（AIそのまま送信）→ コンポーネントルールをブースト ──
  // スタッフが修正せず送信 = AI予想が正解 = 各コンポーネントのルールを強化する
  // was_ai_modified=false かつ ai_components あり のレコードが対象（最大20件）
  {
    const { data: usedExamples } = await supabase
      .from("ai_reply_examples")
      .select("id, conversation_state, ai_components")
      .eq("was_ai_modified", false)
      .eq("was_ai_used", true)
      .is("diff_analyzed_at", null)
      .not("ai_components", "is", null)
      .order("created_at", { ascending: false })
      .limit(20);

    for (const ue of usedExamples ?? []) {
      const ueState = ue.conversation_state as string;
      const ueComps = ue.ai_components as Record<string, string>;
      const ueLearnList = STATE_LEARNABLE[ueState] ?? [];
      for (const comp of ueLearnList.slice(0, 3)) {
        if (!ueComps[comp]) continue;
        const compState = `${ueState}_${comp}`;
        const { data: posRules } = await supabase
          .from("ai_reply_knowledge")
          .select("id, importance")
          .eq("conversation_state", compState)
          .order("apply_count", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(2);
        for (const rule of posRules ?? []) {
          const imp = (rule.importance as number) ?? 7;
          if (imp < 9) {
            await supabase.from("ai_reply_knowledge")
              .update({ importance: Math.min(9, imp + 1) }).eq("id", rule.id);
          }
        }
      }
      await supabase.from("ai_reply_examples")
        .update({ diff_analyzed_at: now }).eq("id", ue.id);
    }
  }

  // 学習済みナレッジのembeddingを即座にバックフィル
  if (learned > 0) {
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
      ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");
    void fetch(`${baseUrl}/api/backfill-embeddings`, {
      method: "POST",
      headers: cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {},
    }).catch(() => {});
  }

  // ── stale decay: 90日間 used_count=0 のルールを自動 rejected に ──
  // apply_count>=5 判定(RPC)だけでは使われないまま放置されたルールは永遠に残る。
  // 一度も使われず90日経過 → 実運用に合わない可能性が高い → hypothesis_status=rejected
  // MED-02: correct_count>0 のルールは decay 対象外（一度でも正しく使われた実績あり = まだ有効）
  // S04: apply_count>0 条件追加 — 一度も検索でヒットしていないルールは除外。
  //      greeting_viewing / property_check_result_vacate_date 等の稀少ステートは90日以内に
  //      発火チャンスがなく rejected 化する恐れがあるため、apply 実績のあるルールのみを対象とする。
  try {
    const staleThreshold = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    await supabase
      .from("ai_reply_knowledge")
      .update({ hypothesis_status: "rejected" })
      .lte("importance", 8)                          // importance=9以外を対象（F09: update-knowledgeの物理削除範囲と統一）
      .eq("used_count", 0)                          // 一度も使われていない
      .eq("correct_count", 0)                       // MED-02: 正答実績があるルールは除外
      .gt("apply_count", 0)                         // S04: apply実績がないルールは対象外（稀少ステート保護）
      .lt("created_at", staleThreshold)             // 90日以上前に作成
      .neq("hypothesis_status", "confirmed")        // 確認済みは除外
      .neq("hypothesis_status", "rejected");        // 既にrejectは除外
  } catch { /* decay 失敗は無視して処理完了を返す */ }

  // ── F06: importance=9 の放置ルールを 180 日で soft-delete ──
  // importance=9 は通常の stale decay（lt("importance", 8)）と物理削除（update-knowledge cron）の
  // 両方から除外されるため、際限なく蓄積する。180日未使用なら rejected へ。
  try {
    const staleThreshold180 = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
    await supabase
      .from("ai_reply_knowledge")
      .update({ hypothesis_status: "rejected" })
      .eq("importance", 9)
      .eq("used_count", 0)
      .eq("correct_count", 0)
      .gt("apply_count", 0)                         // BUG-03: 90日decayと同様、apply実績ゼロは除外
      .lt("created_at", staleThreshold180)
      .neq("hypothesis_status", "confirmed")
      .neq("hypothesis_status", "rejected");
  } catch { /* ignore */ }

  // ── ポジティブ強化 B: correct_count >= 3 のルールを importance 昇格 ──
  // S02: learned>0 → (learned+processed)>0 に緩和
  // AI精度が高い期間（was_ai_modified=false ばかりでlearned=0）でも確認済みルールが昇格されるようになる
  // 二重実行防止: 2回目は processed=0 になるためスキップされる
  if ((learned + processed) > 0) try {
    const { data: correctRules } = await supabase
      .from("ai_reply_knowledge")
      .select("id, importance")
      .gte("correct_count", 3)
      .lt("importance", 9)
      .neq("hypothesis_status", "rejected")
      .order("correct_count", { ascending: false })
      .limit(50);
    for (const rule of correctRules ?? []) {
      await supabase.from("ai_reply_knowledge")
        .update({ importance: Math.min(9, (rule.importance as number) + 1) })
        .eq("id", rule.id);
    }
  } catch { /* ignore */ }

  // ── ポジティブ強化 C: 過去30日の変更率（mod_rate）でステート単位スコア調整 ──
  // S02: learned>0 → (learned+processed)>0 に緩和（閑散期でもスコア調整が機能する）
  // 変更率 <= 20% = AIが当たり続けている → 上位ルール +1
  // 変更率 >= 70% = AIが外れ続けている → 下位ルール -1
  if ((learned + processed) > 0) try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: examples30 } = await supabase
      .from("ai_reply_examples")
      .select("conversation_state, was_ai_modified")
      .gte("created_at", thirtyDaysAgo)
      .not("ai_draft", "is", null);

    if (examples30 && examples30.length >= 10) {
      const stateStats = new Map<string, { total: number; modified: number }>();
      for (const row of examples30) {
        const s = row.conversation_state as string;
        if (!s) continue;
        const st = stateStats.get(s) ?? { total: 0, modified: 0 };
        st.total++;
        if (row.was_ai_modified) st.modified++;
        stateStats.set(s, st);
      }
      for (const [state, stats] of stateStats) {
        if (stats.total < 5) continue; // データ少なすぎる場合はスキップ
        const modRate = stats.modified / stats.total;
        // S03: .like('${state}%') → .in([state, ...compStates]) で兄弟ステートへの誤ブースト/降格を防止
        const compStates = (STATE_LEARNABLE[state] ?? []).map(c => `${state}_${c}`);
        const matchStates = [state, ...compStates];
        if (modRate <= 0.2) {
          // AIが当たり続けている → 上位ルールを +1
          const { data: topRules } = await supabase
            .from("ai_reply_knowledge")
            .select("id, importance")
            .in("conversation_state", matchStates)
            .lt("importance", 9)
            .neq("hypothesis_status", "rejected")
            .order("apply_count", { ascending: false })
            .limit(3);
          for (const rule of topRules ?? []) {
            await supabase.from("ai_reply_knowledge")
              .update({ importance: Math.min(9, (rule.importance as number) + 1) })
              .eq("id", rule.id);
          }
        } else if (modRate >= 0.7) {
          // AIが外れ続けている → 下位ルールを -1
          const { data: lowRules } = await supabase
            .from("ai_reply_knowledge")
            .select("id, importance")
            .in("conversation_state", matchStates)
            .gt("importance", 5)
            .neq("hypothesis_status", "confirmed")
            .order("apply_count", { ascending: true })
            .limit(3);
          for (const rule of lowRules ?? []) {
            await supabase.from("ai_reply_knowledge")
              .update({ importance: Math.max(5, (rule.importance as number) - 1) })
              .eq("id", rule.id);
          }
        }
      }
    }
  } catch { /* ignore */ }

  // ── 確認済みルール → ai_prompt_rules 自動同期 ──
  // importance>=8 かつ hypothesis_status='confirmed' のルールをプロンプトルールとして自動登録
  let synced = 0;
  try {
    const { data: confirmedRules } = await supabase
      .from("ai_reply_knowledge")
      .select("id, title, content, conversation_state")
      .eq("hypothesis_status", "confirmed")
      .gte("importance", 8)
      .limit(100);

    if (confirmedRules && confirmedRules.length > 0) {
      const upserts = confirmedRules.map((r) => ({
        rule_key: `LEARN-${r.id as string}`,
        action_type: "generate_reply",
        condition_key: r.conversation_state ? "conversation_state" : null,
        condition_value: (r.conversation_state as string | null) ?? null,
        rule_text: (r.content as string).slice(0, 500),
        reason: `ai_reply_knowledge自動昇格: ${(r.title as string).slice(0, 100)}`,
        priority: 8,
        is_active: true,
      }));
      const { error: upsertError } = await supabase
        .from("ai_prompt_rules")
        .upsert(upserts, { onConflict: "rule_key" });
      if (!upsertError) synced = confirmedRules.length;
    }

    // rejected ルールは ai_prompt_rules でも非アクティブ化
    const { data: rejectedRules } = await supabase
      .from("ai_reply_knowledge")
      .select("id")
      .eq("hypothesis_status", "rejected")
      .limit(100);
    if (rejectedRules && rejectedRules.length > 0) {
      const keys = rejectedRules.map((r) => `LEARN-${r.id as string}`);
      await supabase.from("ai_prompt_rules")
        .update({ is_active: false })
        .in("rule_key", keys);
    }
  } catch { /* ignore - プロンプトルール同期失敗はメイン処理を止めない */ }

  await finishCronLog(runLogId, true, { processed, learned, synced });
  return NextResponse.json({ ok: true, processed, learned, synced, message: `${processed}件処理・${learned}件学習・${synced}件ルール同期` });
}

export async function GET(req: NextRequest) {
  // Vercel Cron からの呼び出しを CRON_SECRET で認証（#15）
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== "Bearer " + cronSecret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return POST(req);
}
