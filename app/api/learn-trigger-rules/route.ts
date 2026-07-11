import { NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { normalizeStatus } from "@/app/lib/status-normalize";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";

// Vercel Functions のタイムアウト上限（秒）
export const maxDuration = 60;

// source ごとの重み（採択の質を confidence に反映）
// suggestion_accepted: スタッフが積極的に選択した強シグナル
//   （#24: 2.0だと提案2回採択でルール成立する過剰な正帰還のため1.2に抑制）
// prediction_match:    予測が当たった良いシグナル
// manual:              手動選択ベースライン
// suggestion_dismissed: 却下は弱い負シグナル（0にすると除算で問題）
// prediction_mismatch: 予測外れ
// send_cancelled:      送信キャンセルは最弱シグナル（集計への影響を最小化）
// suggestion_bypassed: 提案を無視して別行動 = 弱い負シグナル
const SOURCE_WEIGHTS: Record<string, number> = {
  suggestion_accepted: 1.2,
  prediction_match: 1.5,
  manual: 1.0,
  suggestion_dismissed: 0.2,
  prediction_mismatch: 0.5,
  send_cancelled: 0.1,
  suggestion_bypassed: 0.2,
};
const DEFAULT_WEIGHT = 1.0;

function sourceWeight(source: string | null | undefined): number {
  return SOURCE_WEIGHTS[source ?? ""] ?? DEFAULT_WEIGHT;
}

// #24 修正D: confidence < 0.4 かつ occurrence_count < 5 の低品質ルールは登録・維持しない
function isLowQualityRule(confidence: number, occurrenceCount: number): boolean {
  return confidence < 0.4 && occurrenceCount < 5;
}

// 日本語テキストから意味のある n-gram を抽出
// ノイズ対策(#24): 2文字断片（「お願」等）が無意味ルール化するため最小3文字
const MIN_NGRAM_LENGTH = 3;

function extractNgrams(text: string): string[] {
  // 記号・スペースを除去
  const cleaned = text.replace(/[。、,.!?！？\s　\[\]【】「」『』（）()0-9０-９]/g, "");
  let result: string[] = [];
  for (let n = 2; n <= 5; n++) {
    for (let i = 0; i <= cleaned.length - n; i++) {
      result.push(cleaned.slice(i, i + n));
    }
  }
  // 2文字以下のn-gramは除外
  result = result.filter((ng) => ng.length >= MIN_NGRAM_LENGTH);
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
  // #24 ノイズ対策: 一般的な挨拶・敬語・語尾（トリガーとして無意味）
  "ございます", "ございまし", "いたします", "いただき", "よろしく",
  "お願い", "お世話", "ありがとう", "よろしくお", "失礼しま",
  "こんにちは", "こんばんは", "はじめまし", "お客様", "させていた",
]);

// n-gram がストップリストのいずれかを含む/含まれる場合も除外
// （例: 「よろしくお願」は「よろしく」を含むので除外）
function isStopNgram(ngram: string): boolean {
  if (STOP_NGRAMS.has(ngram)) return true;
  for (const stop of STOP_NGRAMS) {
    if (stop.length >= 3 && (ngram.includes(stop) || stop.includes(ngram))) return true;
  }
  return false;
}

export async function POST(req?: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req ? (req.headers as Headers).get("authorization") : null;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  // 学習ヘルスモニタリング用の実行記録（morning-report が cron_run_logs を読んで状態を報告する）
  const runLogId = await startCronLog("learn-trigger-rules");
  // 高6: order なしだと limit(3000) がDB任意順の3000件になるため、直近90日窓 + created_at 降順で「最新の3000件」を確定させる
  const NINETY_DAYS_AGO = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();

  // action_pattern_logs から全データ取得（source で重み付け + created_at で鮮度減衰）
  // 高3: サブモードログ（viewing_invite_submode 等）は customer_msg_summary にモードキーが入っており n-gram を汚染するため除外
  const { data: logs } = await supabase
    .from("action_pattern_logs")
    .select("action_type, customer_msg_summary, source, created_at")
    .not("customer_msg_summary", "is", null)
    .not("action_type", "like", "%_submode")
    .gte("created_at", NINETY_DAYS_AGO)
    .order("created_at", { ascending: false })
    .limit(3000);

  if (!logs?.length) {
    await finishCronLog(runLogId, true, { learned: 0, reason: "no logs" });
    return NextResponse.json({ ok: true, learned: 0 });
  }

  // action_type ごとにテキストをグループ化（source重み付き）
  type WeightedText = { text: string; weight: number };
  const byAction: Record<string, WeightedText[]> = {};
  const allTexts: WeightedText[] = [];

  for (const log of logs) {
    const action = log.action_type as string;
    const text = ((log.customer_msg_summary as string) ?? "").trim();
    if (!text || text.length < 3) continue;
    // 案3: 鮮度重み付け — ログの経過日数で指数減衰（30日で重み半減）。古い行動パターンの影響を自然に薄める
    const ageDays = (Date.now() - new Date(log.created_at as string).getTime()) / (1000 * 60 * 60 * 24);
    const decayFactor = Math.pow(0.5, ageDays / 30);
    const weight = sourceWeight(log.source as string | null) * decayFactor;
    byAction[action] ??= [];
    byAction[action].push({ text, weight });
    allTexts.push({ text, weight });
  }

  // 全テキストの n-gram 重み付きカウント（母数）
  const totalNgramCount: Record<string, number> = {};
  for (const { text, weight } of allTexts) {
    const seen = new Set<string>();
    for (const ngram of extractNgrams(text)) {
      if (!seen.has(ngram)) {
        totalNgramCount[ngram] = (totalNgramCount[ngram] ?? 0) + weight;
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

    for (const { text, weight } of texts) {
      const seen = new Set<string>();
      for (const ngram of extractNgrams(text)) {
        if (!seen.has(ngram)) {
          actionNgramCount[ngram] = (actionNgramCount[ngram] ?? 0) + weight;
          seen.add(ngram);
        }
      }
    }

    for (const [ngram, weightedCount] of Object.entries(actionNgramCount)) {
      if (isStopNgram(ngram)) continue;
      const total = totalNgramCount[ngram] ?? weightedCount;
      const confidence = weightedCount / total;

      // 信頼度60%以上 & 重み付きスコア3以上 & 3文字以上
      if (confidence >= 0.6 && weightedCount >= 3 && ngram.length >= MIN_NGRAM_LENGTH) {
        rulesToUpsert.push({
          action_type: action,
          keyword: ngram,
          // DBカラムはINTEGERのため丸め（confidence計算は丸め前の重み付き値で実施済み）
          occurrence_count: Math.round(weightedCount),
          total_occurrence: Math.round(total),
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

  // ── #24 修正D: 蓄積済みノイズルールの定期削除 ──
  let cleaned = 0;

  // 1) confidence閾値割れ（confidence < 0.4 かつ occurrence_count < 5）の既存ルールを削除
  // 高5: SUGGESTION_ACCEPT_RATE（update-action-confidence cron が管理する採択率行）と
  //      AFTER:%（チェーンルール）は n-gram ルールではないため cleanup 対象から保護する
  // 中1: PREDICTION_ACCURACY（予測精度行）も同様に保護（低精度の行こそ isLowAccuracy の判定材料になるため）
  // 中5: SOURCE_ACCEPT_RATE:%（提案経路別採択率行）も保護（低採択率の行こそ isLowSourceRate の判定材料になるため）
  // 案1: MANUAL_RULE:%（竹内さん確認済み手動ルール・旧形式の残存行）と
  //      SUBMODE_ACCEPT:%（サブモード採択率行。低採択率の行こそデフォルト判定材料になるため）も保護
  {
    const { data: lowRules } = await supabase
      .from("trigger_action_rules")
      .select("keyword")
      .lt("confidence", 0.4)
      .lt("occurrence_count", 5)
      .not("keyword", "eq", "SUGGESTION_ACCEPT_RATE")
      .not("keyword", "eq", "PREDICTION_ACCURACY")
      .not("keyword", "like", "AFTER:%")
      .not("keyword", "like", "SOURCE_ACCEPT_RATE:%")
      .not("keyword", "like", "MANUAL_RULE:%")
      .not("keyword", "like", "SUBMODE_ACCEPT:%");
    if (lowRules?.length) {
      const { error } = await supabase
        .from("trigger_action_rules")
        .delete()
        .lt("confidence", 0.4)
        .lt("occurrence_count", 5)
        .not("keyword", "eq", "SUGGESTION_ACCEPT_RATE")
        .not("keyword", "eq", "PREDICTION_ACCURACY")
        .not("keyword", "like", "AFTER:%")
        .not("keyword", "like", "SOURCE_ACCEPT_RATE:%")
        .not("keyword", "like", "MANUAL_RULE:%")
        .not("keyword", "like", "SUBMODE_ACCEPT:%");
      if (!error) cleaned += lowRules.length;
    }
  }

  // 2) 過去に蓄積した 2文字以下・ストップリスト該当キーワードのルールを削除
  {
    const { data: allRules } = await supabase
      .from("trigger_action_rules")
      .select("keyword")
      .not("keyword", "like", "AFTER:%")
      .limit(5000);
    const noiseKeywords = [
      ...new Set(
        (allRules ?? [])
          .map((r) => r.keyword as string)
          // 案1: MANUAL_RULE:%（手動ルール）と SUBMODE_ACCEPT:%（サブモード採択率）はノイズ削除から保護
          .filter((k) => !k.startsWith("MANUAL_RULE:") && !k.startsWith("SUBMODE_ACCEPT:") && (k.length < MIN_NGRAM_LENGTH || isStopNgram(k)))
      ),
    ];
    for (let i = 0; i < noiseKeywords.length; i += 200) {
      const chunk = noiseKeywords.slice(i, i + 200);
      const { error } = await supabase
        .from("trigger_action_rules")
        .delete()
        .in("keyword", chunk);
      if (!error) cleaned += chunk.length;
    }
  }

  for (const rule of sorted) {
    // #24 修正D: 低品質ルールは upsert 対象外
    if (isLowQualityRule(rule.confidence, rule.occurrence_count)) continue;
    const { error } = await supabase.from("trigger_action_rules").upsert(
      { ...rule, updated_at: new Date().toISOString() },
      { onConflict: "action_type,keyword" }
    );
    if (!error) learned++;
  }

  // ── AIXチェーンパターン学習: 直前のAIX → 次のAIX ──
  // 高3: サブモードログ（%_submode）は実際のAIX遷移ではないため集計から除外
  // 高6: 直近90日窓 + created_at 降順で「最新の3000件」を確定させる
  const { data: chainLogs } = await supabase
    .from("action_pattern_logs")
    .select("action_type, previous_action_type, conversation_status, source, created_at")
    .not("previous_action_type", "is", null)
    .not("action_type", "like", "%_submode")
    .gte("created_at", NINETY_DAYS_AGO)
    .order("created_at", { ascending: false })
    .limit(3000);

  // 高4: 却下・キャンセル・バイパス系は「実際に取られた遷移」ではないためチェーン学習から除外
  const CHAIN_EXCLUDED_SOURCES = new Set(["suggestion_dismissed", "send_cancelled", "suggestion_bypassed", "prediction_bypassed"]);

  // 中4: 汎用チェーン（AFTER:{prev}）に加え、フェーズ特定チェーン（AFTER:{prev}|{status}）も集計する。
  // suggest-next-action はフェーズ特定キーワードを優先参照するため、生成しないと常に空になる。
  // status は suggest-next-action 側の参照キー（normalizeStatus 適用後）と揃える
  const chainCount: Record<string, Record<string, number>> = {};
  const prevTotal: Record<string, number> = {};
  const phaseChainCount: Record<string, Record<string, number>> = {};
  const phasePrevTotal: Record<string, number> = {};
  for (const log of chainLogs ?? []) {
    if (CHAIN_EXCLUDED_SOURCES.has((log.source as string) ?? "")) continue;
    const prev = log.previous_action_type as string;
    const curr = log.action_type as string;
    if (!prev || !curr) continue;
    // 案3: 鮮度重み付け — チェーン遷移も経過日数で指数減衰（30日で半減）
    const ageDays = (Date.now() - new Date(log.created_at as string).getTime()) / (1000 * 60 * 60 * 24);
    const decayFactor = Math.pow(0.5, ageDays / 30);
    chainCount[prev] ??= {};
    chainCount[prev][curr] = (chainCount[prev][curr] ?? 0) + decayFactor;
    prevTotal[prev] = (prevTotal[prev] ?? 0) + decayFactor;

    const rawStatus = ((log.conversation_status as string | null) ?? "").trim();
    if (rawStatus) {
      const phaseKey = `${prev}|${normalizeStatus(rawStatus)}`;
      phaseChainCount[phaseKey] ??= {};
      phaseChainCount[phaseKey][curr] = (phaseChainCount[phaseKey][curr] ?? 0) + decayFactor;
      phasePrevTotal[phaseKey] = (phasePrevTotal[phaseKey] ?? 0) + decayFactor;
    }
  }

  let chainLearned = 0;
  // 汎用チェーン（AFTER:{prev}）とフェーズ特定チェーン（AFTER:{prev}|{status}）を同じ閾値で upsert
  // フェーズ特定は母数がフェーズで絞られるため汎用より高 confidence になりやすい
  const chainGroups: Array<{ counts: Record<string, Record<string, number>>; totals: Record<string, number> }> = [
    { counts: chainCount, totals: prevTotal },
    { counts: phaseChainCount, totals: phasePrevTotal },
  ];
  for (const { counts, totals } of chainGroups) {
    for (const [prevKey, nexts] of Object.entries(counts)) {
      for (const [action, count] of Object.entries(nexts)) {
        const total = totals[prevKey] ?? count;
        const confidence = Math.round((count / total) * 1000) / 1000;
        // #24 修正D: 低品質ルール（confidence < 0.4 かつ count < 5）は upsert 対象外
        // 案3: count は鮮度減衰済みの重み付き値（float）。閾値判定は減衰後の値で行い、DBのINTEGERカラムには丸めて保存
        if (confidence >= 0.3 && count >= 2 && !isLowQualityRule(confidence, count)) {
          const { error } = await supabase.from("trigger_action_rules").upsert(
            { action_type: action, keyword: `AFTER:${prevKey}`, occurrence_count: Math.round(count), total_occurrence: Math.round(total), confidence, updated_at: new Date().toISOString() },
            { onConflict: "action_type,keyword" }
          );
          if (!error) { learned++; chainLearned++; }
        }
      }
    }
  }

  await finishCronLog(runLogId, true, { learned, chain_learned: chainLearned, cleaned, total_candidates: rulesToUpsert.length });
  return NextResponse.json({
    ok: true,
    learned,
    chain_learned: chainLearned,
    cleaned,
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
export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = (req.headers as Headers).get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return POST(req);
}
