import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 300;

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  timeout: 120_000,
  maxRetries: 1,
});

const KNOWN_ACTION_TYPES = new Set([
  "property_send",
  "viewing_invite",
  "property_recommendation",
  "hearing",
  "follow_up",
  "application",
  "document_request",
  "contract",
  "greeting",
  "property_check_result",
  "estimate_sheet",
  "meeting_place",
  "acknowledge_check",
  "followup_revive",
  "application_push",
  "condition_hearing",
  "alternative_send",
  "generate_reply",
]);

type OpusJudge = "deactivate" | "keep" | "elevate" | "merge";

interface OpusResult {
  rule_key: string;
  judge: OpusJudge;
  reason: string;
  action_type_correction: string | null;
  merge_with_key: string | null;
  merged_text: string | null;
}

interface FeedbackRule {
  rule_key: string;
  rule_text: string;
  action_type: string | null;
  priority: number | null;
  created_at: string;
}

async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const runLogId = await startCronLog("rule-organize");

  try {
    // Step 1: Fetch all active non-permanent FEEDBACK-* rules
    const { data: rulesData, error: rulesErr } = await supabase
      .from("ai_prompt_rules")
      .select("rule_key, rule_text, action_type, priority, created_at")
      .like("rule_key", "FEEDBACK-%")
      .eq("is_active", true)
      .or("is_permanent.is.null,is_permanent.eq.false")
      .order("created_at", { ascending: true });

    if (rulesErr) {
      console.error("[rule-organize] fetch rules failed:", rulesErr.message);
      await finishCronLog(runLogId, false, undefined, rulesErr.message);
      return NextResponse.json({ ok: false, error: rulesErr.message }, { status: 500 });
    }

    const rules = (rulesData ?? []) as FeedbackRule[];

    // Step 2: Early return if no rules
    if (rules.length === 0) {
      await finishCronLog(runLogId, true, { total: 0, deactivated: 0, elevated: 0, merged: 0, kept: 0 });
      return NextResponse.json({ ok: true, total: 0, deactivated: 0, elevated: 0, merged: 0, kept: 0 });
    }

    // Build lookup maps
    const ruleMap = new Map<string, FeedbackRule>();
    for (const r of rules) {
      ruleMap.set(r.rule_key, r);
    }

    // Step 3: Batch classify with Opus (up to 30 rules at a time)
    const BATCH_SIZE = 30;
    const allOpusResults: OpusResult[] = [];

    for (let i = 0; i < rules.length; i += BATCH_SIZE) {
      const batch = rules.slice(i, i + BATCH_SIZE);

      const rulesList = batch
        .map((r, idx) =>
          `${idx + 1}. rule_key: ${r.rule_key}\n   action_type: ${r.action_type ?? "null"}\n   priority: ${r.priority ?? "null"}\n   rule_text: ${r.rule_text}`
        )
        .join("\n\n");

      const prompt = `あなたはLINE不動産接客AIのプロンプトルール管理エージェントです。

以下のFEEDBACK-*ルール一覧を分析し、各ルールの処理判定を行ってください。

## 判定基準

**deactivate（自動無効化）:**
- 他のルールと実質的に重複している（rule_keyを明示）
- 意味がない・抽象的すぎて適用不可能
- スコープが完全にズレている（viewing_invite専用なのにglobal等）

**elevate（永続ルール昇格候補）:**
- 時間・状況を問わず普遍的に正しいルール
- 業務の根幹（謝罪禁止・表現禁止・必須フォーマット等）
- 1年後も変わらないと確信できるもの

**keep（保持）:**
- 適切にスコープされている
- action_type_correctionで正しいスコープを指定する
- nullのままでよいものはnullを指定

**merge（統合）:**
- 2件が同じ趣旨だが異なる表現
- merge_with_key: 統合先のrule_key
- merged_text: 統合後の推奨テキスト（300字以内）

## ルール一覧
${rulesList}

## 出力形式
JSON配列のみ返してください:
[{"rule_key":"...","judge":"deactivate"|"keep"|"elevate"|"merge","reason":"1行","action_type_correction":"string|null","merge_with_key":"string|null","merged_text":"string|null"}]`;

      try {
        const response = await client.messages.create({
          model: "claude-opus-4-8",
          max_tokens: 4096,
          messages: [{ role: "user", content: prompt }],
        });

        const rawText =
          response.content[0]?.type === "text" ? response.content[0].text : "";

        // Step 4: Parse Opus response
        const jsonMatch = rawText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
          console.error("[rule-organize] Opus JSON parse failed, batch starting at index:", i, "raw:", rawText.slice(0, 200));
          continue;
        }

        const parsed = JSON.parse(jsonMatch[0]) as OpusResult[];
        // Filter to only rules in our fetched list
        for (const result of parsed) {
          if (ruleMap.has(result.rule_key)) {
            allOpusResults.push(result);
          }
        }
      } catch (e) {
        console.error("[rule-organize] Opus call failed for batch at index:", i, (e as Error)?.message);
      }
    }

    // Step 5: Execute decisions
    let deactivated = 0;
    let elevated = 0;
    let merged = 0;
    let kept = 0;

    // Track processed merge pairs to avoid duplicate questions
    const processedMergePairs = new Set<string>();

    for (const result of allOpusResults) {
      const rule = ruleMap.get(result.rule_key);
      if (!rule) continue;

      switch (result.judge) {
        case "deactivate": {
          const { error: deactErr } = await supabase
            .from("ai_prompt_rules")
            .update({ is_active: false, updated_at: new Date().toISOString() })
            .eq("rule_key", result.rule_key);
          if (deactErr) {
            console.error("[rule-organize] deactivate failed:", result.rule_key, deactErr.message);
          } else {
            deactivated++;
          }
          break;
        }

        case "keep": {
          // Update action_type if correction is provided and valid and differs from current
          if (
            result.action_type_correction !== null &&
            result.action_type_correction !== rule.action_type &&
            KNOWN_ACTION_TYPES.has(result.action_type_correction)
          ) {
            const { error: keepErr } = await supabase
              .from("ai_prompt_rules")
              .update({ action_type: result.action_type_correction, updated_at: new Date().toISOString() })
              .eq("rule_key", result.rule_key);
            if (keepErr) {
              console.error("[rule-organize] keep update action_type failed:", result.rule_key, keepErr.message);
            }
          }
          kept++;
          break;
        }

        case "elevate": {
          const question =
            `[rule_elevate:${result.rule_key}] このルールを恒久ルール（永久適用）に昇格しますか？\n\n【ルール内容】\n${rule.rule_text}\n\n「はい」→ 恒久ルールになり絶対厳守として全アクションに注入されます。`;
          const { error: elevErr } = await supabase.from("ai_feedback_items").insert({
            question,
            status: "pending",
            category: "rule_review",
          });
          if (elevErr) {
            console.error("[rule-organize] elevate insert failed:", result.rule_key, elevErr.message);
          } else {
            elevated++;
          }
          break;
        }

        case "merge": {
          if (!result.merge_with_key || !result.merged_text) {
            kept++;
            break;
          }

          // Build canonical pair key (sorted) to avoid duplicate questions for both members
          const pairKey = [result.rule_key, result.merge_with_key].sort().join("::");
          if (processedMergePairs.has(pairKey)) {
            // The other side of this pair already inserted the question
            break;
          }
          processedMergePairs.add(pairKey);

          const mergeWithRule = ruleMap.get(result.merge_with_key);
          const mergeWithText = mergeWithRule ? mergeWithRule.rule_text : "(ルール不明)";

          const question =
            `[rule_merge:${result.rule_key}:${result.merge_with_key}] 以下2件のルールが重複しています。統合しますか？\n\n【ルール1】\n${rule.rule_text}\n\n【ルール2】\n${mergeWithText}\n\n【統合案】\n${result.merged_text}`;
          const { error: mergeErr } = await supabase.from("ai_feedback_items").insert({
            question,
            status: "pending",
            category: "rule_review",
          });
          if (mergeErr) {
            console.error("[rule-organize] merge insert failed:", result.rule_key, mergeErr.message);
          } else {
            merged++;
          }
          break;
        }

        default:
          kept++;
          break;
      }
    }

    // Rules not returned by Opus count as kept
    const processedKeys = new Set(allOpusResults.map(r => r.rule_key));
    const unprocessed = rules.filter(r => !processedKeys.has(r.rule_key)).length;
    kept += unprocessed;

    // Step 6: Return summary
    const summary = {
      ok: true,
      total: rules.length,
      deactivated,
      elevated,
      merged,
      kept,
    };

    await finishCronLog(runLogId, true, summary);
    return NextResponse.json(summary);
  } catch (e) {
    console.error("[rule-organize]", e);
    await finishCronLog(runLogId, false, undefined, e instanceof Error ? e.message : String(e));
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return POST(req);
}
