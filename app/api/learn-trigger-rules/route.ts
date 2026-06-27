import { NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";

// 日本語テキストから意味のある n-gram を抽出
function extractNgrams(text: string): string[] {
  // 記号・スペースを除去
  const cleaned = text.replace(/[。、,.!?！？\s　\[\]【】「」『』（）()0-9０-９]/g, "");
  const result: string[] = [];
  for (let n = 2; n <= 5; n++) {
    for (let i = 0; i <= cleaned.length - n; i++) {
      result.push(cleaned.slice(i, i + n));
    }
  }
  return result;
}

// 助詞・助動詞など意味を持たない文字列を除外
const STOP_NGRAMS = new Set([
  "です", "ます", "した", "して", "しま", "ませ", "あり", "あり",
  "いま", "いる", "いて", "おり", "ので", "のは", "ので", "ます",
  "です", "だと", "だっ", "から", "けど", "けれ", "ども", "って",
  "てい", "てく", "てし", "ても", "でき", "でし", "でも", "とい",
  "とき", "とな", "とも", "なの", "なっ", "など", "に関", "ので",
  "のか", "のこ", "のよ", "はあ", "はい", "はな", "ほし", "まし",
  "まで", "もし", "もの", "やっ", "よう", "より", "られ", "りが",
  "るか", "ると", "るの", "れが", "れた", "れて", "れる", "わか",
  "をお", "をし", "んが", "んだ", "んで", "んな",
]);

export async function POST() {
  // action_pattern_logs から全データ取得
  const { data: logs } = await supabase
    .from("action_pattern_logs")
    .select("action_type, customer_msg_summary")
    .not("customer_msg_summary", "is", null)
    .limit(3000);

  if (!logs?.length) return NextResponse.json({ ok: true, learned: 0 });

  // action_type ごとにテキストをグループ化
  const byAction: Record<string, string[]> = {};
  const allTexts: string[] = [];

  for (const log of logs) {
    const action = log.action_type as string;
    const text = ((log.customer_msg_summary as string) ?? "").trim();
    if (!text || text.length < 3) continue;
    byAction[action] ??= [];
    byAction[action].push(text);
    allTexts.push(text);
  }

  // 全テキストの n-gram カウント（母数）
  const totalNgramCount: Record<string, number> = {};
  for (const text of allTexts) {
    const seen = new Set<string>();
    for (const ngram of extractNgrams(text)) {
      if (!seen.has(ngram)) {
        totalNgramCount[ngram] = (totalNgramCount[ngram] ?? 0) + 1;
        seen.add(ngram);
      }
    }
  }

  // 各アクションで distinctive な n-gram を算出
  const rulesToUpsert: {
    action_type: string;
    keyword: string;
    occurrence_count: number;
    total_occurrence: number;
    confidence: number;
  }[] = [];

  for (const [action, texts] of Object.entries(byAction)) {
    const actionNgramCount: Record<string, number> = {};

    for (const text of texts) {
      const seen = new Set<string>();
      for (const ngram of extractNgrams(text)) {
        if (!seen.has(ngram)) {
          actionNgramCount[ngram] = (actionNgramCount[ngram] ?? 0) + 1;
          seen.add(ngram);
        }
      }
    }

    for (const [ngram, count] of Object.entries(actionNgramCount)) {
      if (STOP_NGRAMS.has(ngram)) continue;
      const total = totalNgramCount[ngram] ?? count;
      const confidence = count / total;

      // 信頼度60%以上 & 3件以上出現 & 2文字以上
      if (confidence >= 0.6 && count >= 3 && ngram.length >= 2) {
        rulesToUpsert.push({
          action_type: action,
          keyword: ngram,
          occurrence_count: count,
          total_occurrence: total,
          confidence: Math.round(confidence * 1000) / 1000,
        });
      }
    }
  }

  // アクション別に上位150件ずつ取得（全体で一括カットするとマイナーアクションが0件になるため）
  const PER_ACTION_LIMIT = 150;
  const byActionSorted: typeof rulesToUpsert = [];
  const actionGroups: Record<string, typeof rulesToUpsert> = {};
  for (const r of rulesToUpsert) {
    actionGroups[r.action_type] ??= [];
    actionGroups[r.action_type].push(r);
  }
  for (const group of Object.values(actionGroups)) {
    group.sort((a, b) => b.confidence - a.confidence);
    byActionSorted.push(...group.slice(0, PER_ACTION_LIMIT));
  }
  const sorted = byActionSorted;
  let learned = 0;

  for (const rule of sorted) {
    const { error } = await supabase.from("trigger_action_rules").upsert(
      { ...rule, updated_at: new Date().toISOString() },
      { onConflict: "action_type,keyword" }
    );
    if (!error) learned++;
  }

  // ── AIXチェーンパターン学習: 直前のAIX → 次のAIX ──
  const { data: chainLogs } = await supabase
    .from("action_pattern_logs")
    .select("action_type, previous_action_type")
    .not("previous_action_type", "is", null)
    .limit(3000);

  const chainCount: Record<string, Record<string, number>> = {};
  const prevTotal: Record<string, number> = {};
  for (const log of chainLogs ?? []) {
    const prev = log.previous_action_type as string;
    const curr = log.action_type as string;
    if (!prev || !curr) continue;
    chainCount[prev] ??= {};
    chainCount[prev][curr] = (chainCount[prev][curr] ?? 0) + 1;
    prevTotal[prev] = (prevTotal[prev] ?? 0) + 1;
  }

  let chainLearned = 0;
  for (const [prev, nexts] of Object.entries(chainCount)) {
    for (const [action, count] of Object.entries(nexts)) {
      const total = prevTotal[prev] ?? count;
      const confidence = Math.round((count / total) * 1000) / 1000;
      if (confidence >= 0.3 && count >= 2) {
        const { error } = await supabase.from("trigger_action_rules").upsert(
          { action_type: action, keyword: `AFTER:${prev}`, occurrence_count: count, total_occurrence: total, confidence, updated_at: new Date().toISOString() },
          { onConflict: "action_type,keyword" }
        );
        if (!error) { learned++; chainLearned++; }
      }
    }
  }

  return NextResponse.json({
    ok: true,
    learned,
    chain_learned: chainLearned,
    total_candidates: rulesToUpsert.length,
    by_action: Object.fromEntries(
      Object.keys(byAction).map((a) => [
        a,
        sorted.filter((r) => r.action_type === a).length,
      ])
    ),
  });
}

// GET: Vercel cronから呼ばれる → 学習を実行
export async function GET() {
  return POST();
}
