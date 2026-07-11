import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "@/app/lib/supabase";
import { normalizeStatus } from "@/app/lib/status-normalize";

export const maxDuration = 30;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 15_000 });

// ラベル参照は normalizeStatus() 適用後のみ行うため、正規化後に到達しうるキーだけ持つ
// （contract/lost/closed_* は SKIP_STATUSES で先に除外され、旧名は normalizeStatus で吸収される）
const STATUS_LABEL: Record<string, string> = {
  hearing: "ヒアリング中",
  proposing: "物件提案中",
  applying: "申込手続き中",
};

const SKIP_STATUSES = new Set(["contract", "lost", "closed_won", "closed_lost"]);

// 高3: 既知 aix_type の正規リスト（ホワイトリスト）。
// サブモードログ（%_submode 等）から生成された汚染ルールを提案に使わないため、
// trigger_action_rules 参照時はこのリストに含まれる action_type のみ採用する
const KNOWN_AIX_TYPES = new Set([
  "property_send", "viewing_invite", "property_recommendation",
  // ※ hearing / follow_up / application / document_request / contract / greeting は
  //   UI未実装の旧名（AixModalに対応ボタンなし）。DBルール（trigger_action_rules）から
  //   action_type として来る可能性があるため削除はしない
  "hearing", "follow_up", "application", "document_request", "contract", "greeting",
  "property_check_result", "estimate_sheet", "meeting_place",
  "acknowledge_check", "followup_revive", "application_push",
  // ※ alternative_send もUI未実装の旧名。提案時は property_send + send_mode:"alternative" に
  //   変換して返す（下の available===false 分岐参照）。DBルール由来で残存する可能性があるため削除はしない
  "condition_hearing", "alternative_send",
]);

// アクション別の初期化パラメータ（クライアントのAIXモーダル初期状態に引き継ぐ）
const ACTION_PARAMS: Record<string, { check_pattern?: string; send_mode?: string }> = {
  property_check_result: { check_pattern: "available" },
  property_send: { send_mode: "normal" },
  property_recommendation: { send_mode: "pickup" },
  viewing_invite: { send_mode: "normal" },
};

export async function POST(req: NextRequest) {
  let body: { conversation_id?: string; last_aix_action?: string | null; available?: boolean | null; customer_message?: string | null };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { conversation_id, last_aix_action: clientLastAixAction, available, customer_message } = body;
  if (!conversation_id) return NextResponse.json({ action: null, reason: "" });

  // 会話を先に取得（property_customers への紐付けは conversations.property_customer_id 経由で辿る）
  const { data: conv } = await supabase.from("conversations")
    .select("status, customer_name, last_sender, property_customer_id")
    .eq("id", conversation_id)
    .maybeSingle();

  if (!conv) return NextResponse.json({ action: null, reason: "" });
  if (SKIP_STATUSES.has(conv.status as string)) return NextResponse.json({ action: null, reason: "" });

  // メッセージ・顧客（property_customer_id で引く）・採択率（毎日 update-action-confidence cron が更新）
  // ・成約貢献率（calc-aix-attribution cron が毎週計算・直近1ヶ月分）を並列取得
  // ※ 改善6: 成約貢献率は Sonnet フォールバックだけでなくチェーンルール・キーワードルールにも効かせるため、ここで一度だけ取得する
  const [{ data: messages }, { data: customer }, { data: acceptanceRows }, { data: attributionRows }, { data: accuracyRows }, { data: submodeRows }, { data: chainStatsRow }, { data: chainTransRow }, { data: sceneInsightsRow }, { data: sourceRateRows }] = await Promise.all([
    supabase.from("messages")
      .select("sender, text, image_url, created_at")
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: false })
      .limit(10),
    conv.property_customer_id
      ? supabase.from("property_customers")
          .select("preferences, other_requests, move_in_time, ai_summary")
          .eq("id", conv.property_customer_id as string)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("trigger_action_rules")
      .select("action_type, confidence")
      .eq("keyword", "SUGGESTION_ACCEPT_RATE"),
    supabase.from("aix_action_attribution")
      .select("action_type, win_rate, usage_count")
      .gte("period_start", new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10))
      .order("period_start", { ascending: false })
      .limit(50),
    // 中1: 予測精度（next_action_logs.was_accurate 率 / update-action-confidence cron が毎日更新）
    supabase.from("trigger_action_rules")
      .select("action_type, confidence, total_occurrence")
      .eq("keyword", "PREDICTION_ACCURACY"),
    // H2: サブモード予測の採択率（update-action-confidence cron が毎日更新）
    // フロントに sub_mode_stats として渡し、ピッカーのサブモードデフォルト選択に使う
    supabase.from("trigger_action_rules")
      .select("keyword, confidence, total_occurrence")
      .like("keyword", "SUBMODE_ACCEPT:%")
      .gte("total_occurrence", 3)
      .limit(50),
    // CHAIN-1: AIX→テンプレ チェーン統計（calc-template-scene-stats cron が週1更新）
    // recommended[`${status}|${aix_type}`] → このAIXの後に最もよく送信されたテンプレID
    supabase.from("ai_prompts")
      .select("content")
      .eq("key", "aix_template_chain_stats")
      .maybeSingle(),
    // CHAIN-2: テンプレ連続送信の遷移統計（calc-template-scene-stats cron が週1更新）
    // transitions[template_id] → { next: 次に最もよく送られるテンプレID, count }
    supabase.from("ai_prompts")
      .select("content")
      .eq("key", "template_chain_transitions")
      .maybeSingle(),
    // CHAIN-3: 営業シーン別インサイト（analyze-template-chains cron が週1更新・Opus 4.8 のシーン名付け）
    // 提案アクションの aix_type と一致するパターンの description を scene_hint として添付する
    supabase.from("ai_prompts")
      .select("content")
      .eq("key", "template_scene_insights")
      .maybeSingle(),
    // 中5: 提案経路別採択率（SOURCE_ACCEPT_RATE:{action_type}:{source} / update-action-confidence cron が毎日更新）
    // keyword_hardcode 経由の採択率が低い（30%未満・10件以上）アクションのキーワード判定をスキップする
    supabase.from("trigger_action_rules")
      .select("keyword, confidence, total_occurrence")
      .like("keyword", "SOURCE_ACCEPT_RATE:%")
      .limit(200),
  ]);

  // CHAIN-1: 推奨テンプレマップをパース（status特定 → 全status共通 の順でフォールバック）
  let chainRecommended: Record<string, string> = {};
  try {
    const parsed = JSON.parse((chainStatsRow?.content as string | undefined) ?? "{}") as { recommended?: Record<string, string> };
    if (parsed.recommended && typeof parsed.recommended === "object") chainRecommended = parsed.recommended;
  } catch { /* 統計未生成・壊れたJSONは無視（recommended_template_id は null になる） */ }

  // CHAIN-2: テンプレ連続送信の遷移マップをパース
  let chainTransitions: Record<string, { next: string; count: number }> = {};
  try {
    const parsedTrans = JSON.parse((chainTransRow?.content as string | undefined) ?? "{}") as { transitions?: Record<string, { next: string; count: number }> };
    if (parsedTrans.transitions && typeof parsedTrans.transitions === "object") chainTransitions = parsedTrans.transitions;
  } catch { /* 統計未生成・壊れたJSONは無視（recommended_template_sequence は先頭1件のみになる） */ }

  // CHAIN-3: シーン別インサイトをパース（提案アクションの aix_type 一致で scene_hint を引く）
  let sceneInsights: Array<{ pattern_name?: string; description?: string; aix_type?: string }> = [];
  try {
    const parsedInsights = JSON.parse((sceneInsightsRow?.content as string | undefined) ?? "{}") as {
      scene_insights?: Array<{ pattern_name?: string; description?: string; aix_type?: string }>;
    };
    if (Array.isArray(parsedInsights.scene_insights)) sceneInsights = parsedInsights.scene_insights;
  } catch { /* 統計未生成・壊れたJSONは無視（scene_hint は null になる） */ }

  // H2: SUBMODE_ACCEPT:{action_type}_submode → { rate, n } のマップ（提案レスポンスに添付）
  const subModeStats = Object.fromEntries(
    ((submodeRows ?? []) as { keyword: string; confidence: number | null; total_occurrence: number | null }[])
      .filter((r) => typeof r.confidence === "number")
      .map((r) => [
        r.keyword.replace("SUBMODE_ACCEPT:", ""),
        { rate: r.confidence as number, n: r.total_occurrence ?? 0 },
      ])
  );

  const acceptanceRateMap = Object.fromEntries(
    (acceptanceRows || []).map((r) => [r.action_type as string, r.confidence as number])
  );

  // 採択率が 30% 未満のアクションは抑制する
  // ※ confidence が null の場合は「データなし」として抑制しない（null < 0.3 は true になるため typeof ガード必須）
  function shouldSuppressAction(actionType: string | null | undefined): boolean {
    if (!actionType) return false;
    const rate = acceptanceRateMap[actionType];
    return typeof rate === "number" && rate < 0.3;
  }

  // 中5: 提案経路別採択率マップ（"{action_type}:{source}" → { rate, samples }）
  const sourceRateMap: Record<string, { rate: number; samples: number }> = {};
  for (const r of (sourceRateRows ?? []) as { keyword: string; confidence: number | null; total_occurrence: number | null }[]) {
    if (typeof r.confidence !== "number") continue;
    sourceRateMap[r.keyword.replace("SOURCE_ACCEPT_RATE:", "")] = { rate: r.confidence, samples: r.total_occurrence ?? 0 };
  }
  // 中5: この経路（source）経由の提案の採択率が 30% 未満（サンプル10件以上）なら、
  // その判定をスキップして次の判定にフォールスルーさせる（アクション全体の抑制ではなく経路単位）
  function isLowSourceRate(actionType: string | null | undefined, source: string): boolean {
    if (!actionType) return false;
    const entry = sourceRateMap[`${actionType}:${source}`];
    return !!entry && entry.samples >= 10 && entry.rate < 0.3;
  }

  // aix_action_attribution: action_type別に直近1ヶ月の win_rate を平均
  const attrMap: Record<string, { totalWinRate: number; count: number }> = {};
  for (const row of (attributionRows ?? []) as { action_type: string; win_rate: number | null; usage_count: number | null }[]) {
    if (row.win_rate == null) continue;
    const a = row.action_type;
    const m = attrMap[a] ?? { totalWinRate: 0, count: 0 };
    m.totalWinRate += row.win_rate;
    m.count += 1;
    attrMap[a] = m;
  }
  const avgWinRateMap: Record<string, number> = {};
  for (const [a, m] of Object.entries(attrMap)) avgWinRateMap[a] = m.totalWinRate / m.count;
  const winRateValues = Object.values(avgWinRateMap);
  const overallAvgWinRate = winRateValues.length
    ? winRateValues.reduce((s, v) => s + v, 0) / winRateValues.length
    : null;

  // 改善6: 成約貢献率が全体平均の半分未満のアクションは lowWinRate（候補が他にあればランク下げ・除外）
  // ※ データがないアクション（avgWinRateMap 未登録）は「実績不明」として低評価しない
  function isLowWinRate(actionType: string | null | undefined): boolean {
    if (!actionType || overallAvgWinRate == null) return false;
    const rate = avgWinRateMap[actionType];
    return typeof rate === "number" && rate < overallAvgWinRate / 2;
  }

  // 中1: 予測精度（PREDICTION_ACCURACY）が40%未満かつサンプル5件以上のアクションはランク下げ
  // ※ データ不足（total_occurrence < 5 または行なし）は「実績不明」として低評価しない
  const accuracyMap: Record<string, { accuracy: number; samples: number }> = {};
  for (const row of (accuracyRows ?? []) as { action_type: string; confidence: number | null; total_occurrence: number | null }[]) {
    if (row.confidence == null) continue;
    accuracyMap[row.action_type] = { accuracy: row.confidence, samples: row.total_occurrence ?? 0 };
  }
  function isLowAccuracy(actionType: string | null | undefined): boolean {
    if (!actionType) return false;
    const entry = accuracyMap[actionType];
    return !!entry && entry.samples >= 5 && entry.accuracy < 0.4;
  }

  if (!messages?.length) return NextResponse.json({ action: null, reason: "" });

  // CHAIN-1: property_check_result 分岐でも参照するため、正規化ステータスはここで確定する
  const currentStatus = normalizeStatus((conv.status as string) ?? "hearing");
  const statusLabel = STATUS_LABEL[currentStatus] ?? currentStatus;

  // CHAIN-1: このAIXアクションの後に最もよく使われるテンプレIDを返す（統計なしは null）
  const recommendedTemplateFor = (actionType: string | null | undefined): string | null => {
    if (!actionType) return null;
    return chainRecommended[`${currentStatus}|${actionType}`] ?? chainRecommended[`*|${actionType}`] ?? null;
  };

  // CHAIN-2: 「このAIXではAを送ってからBを続けて送るのが定番」の連続シーケンスを導出する。
  // 先頭は CHAIN-1 の recommended_template_id、以降は template_chain_transitions を辿る（最大3件・循環防止・count>=2 のみ）。
  const recommendedSequenceFor = (actionType: string | null | undefined): Array<{ id: string; seq: number }> | null => {
    const first = recommendedTemplateFor(actionType);
    if (!first) return null;
    const seq: Array<{ id: string; seq: number }> = [{ id: first, seq: 1 }];
    const visited = new Set<string>([first]);
    let cur = first;
    while (seq.length < 3) {
      const t = chainTransitions[cur];
      if (!t || t.count < 2 || visited.has(t.next)) break;
      seq.push({ id: t.next, seq: seq.length + 1 });
      visited.add(t.next);
      cur = t.next;
    }
    return seq;
  };

  // 返却レスポンスに付与するテンプレ推奨フィールド（単発ID＋連続シーケンス＋シーンヒント）をまとめて組み立てる
  // CHAIN-3: 提案アクションの aix_type と一致する scene_insight の description を scene_hint として添付
  const templateRec = (actionType: string | null | undefined) => ({
    recommended_template_id: recommendedTemplateFor(actionType),
    recommended_template_sequence: recommendedSequenceFor(actionType),
    scene_hint: actionType
      ? (sceneInsights.find((s) => s.aix_type === actionType)?.description ?? null)
      : null,
    // 中1: このアクションの予測一致率（next_action_logs.was_accurate 集計 / データ不足時は null）
    prediction_accuracy: actionType ? (accuracyMap[actionType]?.accuracy ?? null) : null,
  });

  // クライアントが last_aix_action を持っていない場合はDB（aix_usage_logs）から補完
  // ※古すぎるログでチェーンルールが誤発火しないよう直近24時間に限定
  let last_aix_action: string | null = clientLastAixAction ?? null;
  if (!last_aix_action) {
    try {
      const { data: latestAix } = await supabase
        .from("aix_usage_logs")
        .select("aix_type")
        .eq("conversation_id", conversation_id)
        .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      last_aix_action = (latestAix?.aix_type as string | null) ?? null;
    } catch (e) {
      // テーブル未作成等のエラーは無視してクライアント値のみ使用（ログだけ残す）
      console.error("[suggest-next-action] aix_usage_logs 補完に失敗:", e);
    }
  }

  // 直近の顧客画像URL（messages は created_at 降順なので find で最新が取れる）
  const lastCustomerImageUrl = (messages ?? [])
    .find((m) => m.sender === "customer" && (m.image_url as string))
    ?.image_url as string | undefined;

  // アクション返却時に付与する params を組み立てる
  const buildParams = (actionType: string | null | undefined) => ({
    ...(actionType ? (ACTION_PARAMS[actionType] ?? {}) : {}),
    ...(lastCustomerImageUrl ? { imageUrl: lastCustomerImageUrl } : {}),
  });

  // 物件確認結果の後にお客様が返信 → available フィールドで分岐
  // ※ available が true/false で確定している場合はこのフェーズで必ず判定を完結させる
  //   （フォールスルーすると汎用チェーンルールが同じ状態に二重マッチして提案が揺れるため）
  if (last_aix_action === "property_check_result" && conv.last_sender === "customer") {
    if (available === true) {
      // 空室あり → 見積書または内覧誘導（両方抑制時は提案なしで確定）
      const nextAction = !shouldSuppressAction("estimate_sheet") ? "estimate_sheet"
        : !shouldSuppressAction("viewing_invite") ? "viewing_invite"
        : null;
      if (!nextAction) return NextResponse.json({ action: null, reason: "" });
      return NextResponse.json({ action: nextAction, reason: nextAction === "estimate_sheet" ? "空室確認後・見積書" : "空室確認後・内覧へ", source: "chain_rule", params: buildParams(nextAction), acceptanceRate: acceptanceRateMap[nextAction] ?? null, sub_mode_stats: subModeStats, ...templateRec(nextAction) });
    }
    if (available === false) {
      // 空室なしが明示された場合のみ → 代替物件送りへ誘導（抑制時は提案なしで確定）
      // ※ "alternative_send" はAixModalに存在しないactionTypeのため、
      //   property_send + send_mode:"alternative"（代替物件モード）に変換して返す
      if (shouldSuppressAction("property_send")) return NextResponse.json({ action: null, reason: "" });
      return NextResponse.json({ action: "property_send", reason: "代替物件を送る", source: "chain_rule", params: { ...buildParams("property_send"), send_mode: "alternative" }, acceptanceRate: acceptanceRateMap["property_send"] ?? null, sub_mode_stats: subModeStats, ...templateRec("property_send") });
    }
    // available が undefined/null（クライアント未送信）の場合のみ後続フェーズにフォールスルー
  }

  // ---- トリガールール即判定のために最新顧客メッセージを事前抽出 ----
  // チェーンルールより前に置くことで、顧客の明示的意図でチェーンルールをスキップできる
  const lastCustomerMsg = ((customer_message ?? "").trim())
    || ((messages.find((m) => m.sender === "customer" && (m.text as string)?.trim())?.text as string) ?? "");
  // 顧客が内覧・申込・費用等を明示的に意図している場合はチェーンルールをスキップ
  const EXPLICIT_CUSTOMER_INTENT_RE = /内覧|内見|見に行|みに行|みにいき|見学|申込|申し込|費用|初期費用|見積|決めます|でお願いでき|でお願いします|明日.*時|あした.*時|今日.*時|本日.*時/;
  const hasExplicitCustomerIntent = conv.last_sender === "customer" && EXPLICIT_CUSTOMER_INTENT_RE.test(lastCustomerMsg);

  // ---- AIXチェーンルール: 直前のAIXアクションから次を提案 ----
  // ※ staff early return より前に置くことで送信直後にも発火する（Fable5 S-1修正）
  if (last_aix_action && !hasExplicitCustomerIntent) {
    // フェーズ特定ルール ("AFTER:{action}|{phase}") と汎用ルール ("AFTER:{action}") を1クエリで取得し、コードで振り分け
    const phaseSpecificKeyword = `AFTER:${last_aix_action}|${currentStatus}`;
    const genericKeyword = `AFTER:${last_aix_action}`;

    const { data: allChainRules } = await supabase
      .from("trigger_action_rules")
      .select("action_type, confidence, occurrence_count, keyword")
      .in("keyword", [phaseSpecificKeyword, genericKeyword])
      .gte("confidence", 0.35)
      .gte("occurrence_count", 2)
      // confidence 同値タイで返却順が不定にならないよう occurrence_count → action_type で決定的に並べる
      .order("confidence", { ascending: false })
      .order("occurrence_count", { ascending: false })
      .order("action_type", { ascending: true })
      .limit(6);

    // 高3: 既知 aix_type ホワイトリスト外（%_submode 等の汚染ルール）を除外
    const knownChainRules = (allChainRules || []).filter((r) => KNOWN_AIX_TYPES.has(r.action_type as string));
    // フェーズ特定を優先、なければ汎用にフォールバック
    const phaseChain = knownChainRules.filter((r) => r.keyword === phaseSpecificKeyword);
    const chainRules = phaseChain.length ? phaseChain : knownChainRules.filter((r) => r.keyword === genericKeyword);

    if (chainRules?.length) {
      const CHAIN_REASON: Record<string, string> = {
        property_recommendation: "物件送った後のオススメ",
        viewing_invite: "物件提案後・内覧誘導",
        estimate_sheet: "空室確認後・見積書",
        application_push: "内覧後・申込へ",
        meeting_place: "内覧日程を決める",
        property_send: "追加物件を送る",
      };
      // 抑制対象をスキップして最初の非抑制アクションを採用
      // 改善6: 成約貢献率が全体平均の半分未満（lowWinRate）の候補はランク下げ。他に候補がなければ従来通り採用
      // 中1: 予測精度40%未満（lowAccuracy）の候補も同様にランク下げ
      const nonSuppressed = chainRules.filter((r) => !shouldSuppressAction(r.action_type as string));
      const validChainRule = nonSuppressed.find((r) => !isLowWinRate(r.action_type as string) && !isLowAccuracy(r.action_type as string)) ?? nonSuppressed[0];
      if (validChainRule) {
        return NextResponse.json({
          action: validChainRule.action_type,
          reason: CHAIN_REASON[validChainRule.action_type as string] ?? `${last_aix_action}の次`,
          source: "chain_rule",
          params: buildParams(validChainRule.action_type as string),
          acceptanceRate: acceptanceRateMap[validChainRule.action_type as string] ?? null,
          sub_mode_stats: subModeStats,
          ...templateRec(validChainRule.action_type as string),
        });
      }
    }
  }

  // スタッフが最後に送信 → チェーンルール未マッチなら3日以上経過時のみ追客
  if (conv.last_sender === "staff") {
    const latestMsg = messages[0]; // order: desc なので最新が先頭
    const daysSince = latestMsg?.created_at
      ? (Date.now() - new Date(latestMsg.created_at as string).getTime()) / (1000 * 60 * 60 * 24)
      : 0;
    if (daysSince >= 3) {
      if (shouldSuppressAction("property_send")) {
        return NextResponse.json({ action: null, reason: "" });
      }
      return NextResponse.json({ action: "property_send", reason: `${Math.floor(daysSince)}日間未返信・追客`, source: "followup_rule", params: buildParams("property_send"), acceptanceRate: acceptanceRateMap["property_send"] ?? null, sub_mode_stats: subModeStats, ...templateRec("property_send") });
    }
    return NextResponse.json({ action: null, reason: "" });
  }

  // ---- トリガールールで即判定（Haiku不要の場合）----
  // lastCustomerMsg はチェーンルールブロック前に抽出済み

  // 入居日を指定して見積書再送を要求 → 見積書送る（「待ち合わせ」と誤判定しないよう最優先でチェック）
  // 中5: keyword_hardcode 経由の採択率が低い場合はこのトリガーをスキップして次の判定へ
  if (lastCustomerMsg.includes("入居") &&
      (lastCustomerMsg.includes("出して") || lastCustomerMsg.includes("で出し") || lastCustomerMsg.includes("見積")) &&
      !isLowSourceRate("estimate_sheet", "keyword_hardcode")) {
    // 状態は確定しているので、抑制時はフォールスルーせず提案なしで確定（P8誤提案防止）
    if (shouldSuppressAction("estimate_sheet")) return NextResponse.json({ action: null, reason: "" });
    return NextResponse.json({ action: "estimate_sheet", reason: "入居日指定・見積書再送", source: "keyword_hardcode", params: buildParams("estimate_sheet"), acceptanceRate: acceptanceRateMap["estimate_sheet"] ?? null, sub_mode_stats: subModeStats, ...templateRec("estimate_sheet") });
  }

  // 物件画像・動画・物件URL・空室確認の質問 → 「物件確認した」を提案
  // ※ currentStatus は正規化済みのため hearing / proposing の2値でカバーできる
  //   （first_reply/condition_hearing→hearing, property_recommendation/availability_check→proposing）
  const PROPERTY_CHECK_STATUSES = new Set(["hearing", "proposing"]);
  const PROPERTY_URL_RE = /athome\.co\.jp|suumo\.jp|homes\.co\.jp|lifull\.com|chintai\.net|reins\.|realestate\.|rakumachi\.jp/i;
  const AVAILABILITY_KEYWORDS = ["まだありますか", "空いていますか", "空いてますか", "空室ですか", "空室確認", "空き確認", "まだ空い", "まだ残って", "空室はありますか", "こちらの物件"];
  const hasPropertyMedia = lastCustomerMsg.includes("[画像]") || lastCustomerMsg.includes("[動画]");
  // 直近3件（messages は降順なので先頭3件）の顧客メッセージにURLがあるか確認
  const recentCustomerMsgs = messages.filter((m) => m.sender === "customer").slice(0, 3).map((m) => (m.text as string) ?? "");
  const hasPropertyUrl = recentCustomerMsgs.some((t) => PROPERTY_URL_RE.test(t));
  const hasAvailabilityQuestion = AVAILABILITY_KEYWORDS.some((kw) => lastCustomerMsg.includes(kw));
  // スモ割/割引キーワード（スモラの初期費用最大限割引サービス）
  // 物件URL/画像と同時 → property_check_result（先に空室確認が必要・確認後に見積のセット運用）
  // 単独（物件は前回送付済み等）→ 下の estimate_sheet キーワード判定に合流して見積書を提案
  const SMOWARI_RE = /スモ割|割引後|割引使え|割引でき|スモ割使|スモ割適用|スモ割確認/;
  const hasSmowariKeyword = SMOWARI_RE.test(lastCustomerMsg);
  // 中5: keyword_hardcode 経由の採択率が低い場合はこのトリガーをスキップして次の判定へ
  if ((hasPropertyMedia || hasPropertyUrl || hasAvailabilityQuestion) && PROPERTY_CHECK_STATUSES.has(currentStatus) &&
      !isLowSourceRate("property_check_result", "keyword_hardcode")) {
    if (shouldSuppressAction("property_check_result")) return NextResponse.json({ action: null, reason: "" });
    return NextResponse.json({ action: "property_check_result", reason: hasSmowariKeyword ? "スモ割は空室確認から" : hasPropertyMedia ? "物件画像が送られた" : "物件の空室確認依頼", source: "keyword_hardcode", params: buildParams("property_check_result"), acceptanceRate: acceptanceRateMap["property_check_result"] ?? null, sub_mode_stats: subModeStats, ...templateRec("property_check_result") });
  }

  // S-5: 費用・内覧・申込キーワード即判定（DBルール不要・Haiku流入削減）
  // 各判定は「申込 > 内覧 > 日程確定 > 費用」の優先順で early-exit（複数マッチ時の揺れを防止）。
  // マッチしたのに採択率で抑制された場合もフォールスルーせず null で確定させる（P8誤提案防止）。
  // 中5: keyword_hardcode 経由の採択率が低い（30%未満・10件以上）アクションは null を返し、
  //      呼び出し側でこのトリガーをスキップして次の判定へフォールスルーさせる
  const keywordHit = (actionType: string, reason: string): NextResponse | null => {
    if (isLowSourceRate(actionType, "keyword_hardcode")) return null;
    if (shouldSuppressAction(actionType)) return NextResponse.json({ action: null, reason: "" });
    return NextResponse.json({ action: actionType, reason, source: "keyword_hardcode", params: buildParams(actionType), acceptanceRate: acceptanceRateMap[actionType] ?? null, sub_mode_stats: subModeStats, ...templateRec(actionType) });
  };
  // 申込: 「申込みたい」（送り仮名違い）「決めます」「決めたい」「こちらで申」もカバー（最も後工程＝最優先）
  if (/申し込み.*たい|申込.*したい|申込.*希望|申込みたい|入居申込|決めます|決めたい|こちらで申/.test(lastCustomerMsg)) {
    const hit = keywordHit("application_push", "申込意向を検出");
    if (hit) return hit;
  }
  // 内覧: 「内見」（内覧より多い表記）「見学」「現地確認」もカバー
  if (/内覧|内見|見学.*したい|見学.*希望|見学.*できますか|現地.*確認|現地.*見た|見に行|みに行|みにいき/.test(lastCustomerMsg)) {
    const hit = keywordHit("viewing_invite", "内覧希望を検出");
    if (hit) return hit;
  }
  // 日程確定 → meeting_place（「◯曜◯時」「◯月◯日」「AM/PM/午前/午後」「明日/今日+時刻」+ 確定系の言い回し）
  if ((/[月火水木金土日]曜.*[0-9０-９時]|[0-9０-９]+月[0-9０-９]+日|AM|PM|午前|午後|明日|あした|今日|本日/.test(lastCustomerMsg)) &&
      /いかがでしょう|で大丈夫|でお願い|伺います|行きます|行けます|確定|来られ|来れ/.test(lastCustomerMsg)) {
    const hit = keywordHit("meeting_place", "日程確定の意向を検出");
    if (hit) return hit;
  }
  // スモ割/割引 単独言及（物件URL/画像なし＝上の property_check_result 判定を通過してきた場合）も見積書へ
  if (/費用|初期費用|いくら/.test(lastCustomerMsg) || hasSmowariKeyword) {
    const hit = keywordHit("estimate_sheet", hasSmowariKeyword ? "スモ割・割引見積の依頼" : "費用に関する質問を検出");
    if (hit) return hit;
  }

  if (lastCustomerMsg) {
    // conversation_status が NULL（全フェーズ共通）またはこのフェーズ限定のルールのみ取得
    const { data: triggerRules } = await supabase
      .from("trigger_action_rules")
      .select("action_type, keyword, confidence, occurrence_count, conversation_status")
      .gte("confidence", 0.65)
      .gte("occurrence_count", 1)
      .or(`conversation_status.is.null,conversation_status.eq.${currentStatus}`)
      // confidence 同値タイで limit(500) の取得セットが揺れないよう決定的に並べる
      .order("confidence", { ascending: false })
      .order("occurrence_count", { ascending: false })
      .order("keyword", { ascending: true })
      .limit(500);

    if (triggerRules?.length) {
      // 高3: 既知 aix_type ホワイトリスト外（%_submode 等の汚染ルール）を除外
      const knownTriggerRules = triggerRules.filter((r) => KNOWN_AIX_TYPES.has(r.action_type as string));
      // キーワードが含まれるルールをスコアリング
      const scores: Record<string, { score: number; topKeyword: string; topConf: number }> = {};
      for (const rule of knownTriggerRules) {
        const kw = rule.keyword as string;
        if (lastCustomerMsg.includes(kw)) {
          const a = rule.action_type as string;
          const conf = rule.confidence as number;
          if (!scores[a] || conf > scores[a].topConf) {
            scores[a] = {
              score: (scores[a]?.score ?? 0) + conf,
              topKeyword: kw,
              topConf: conf,
            };
          } else {
            scores[a].score += conf;
          }
        }
      }

      const ACTION_REASON: Record<string, string> = {
        property_send: "物件希望が来た",
        viewing_invite: "内覧希望が出た",
        application_push: "申込意欲あり",
        estimate_sheet: "費用の質問あり",
        meeting_place: "日程が決まりそう",
        property_check: "物件確認依頼",
        property_check_result: "物件画像が送られた",
        property_recommendation: "物件提案タイミング",
      };
      // スコア降順で並べて、抑制対象をスキップして最初の非抑制アクションを返却
      // （同スコア時は topConf 降順 → action_type 昇順で決定的にタイブレーク）
      // 中1: 予測精度40%未満（isLowAccuracy）のアクションはスコアを0.8倍に減衰して順位付け
      //      （完全スキップではなく減衰。閾値0.85判定は減衰前の生スコアで行う）
      const decayedScore = (actionType: string, score: number) => (isLowAccuracy(actionType) ? score * 0.8 : score);
      const sortedScores = Object.entries(scores).sort(
        (a, b) => decayedScore(b[0], b[1].score) - decayedScore(a[0], a[1].score) || b[1].topConf - a[1].topConf || a[0].localeCompare(b[0])
      );
      // 改善6: 成約貢献率が全体平均の半分未満（lowWinRate）の候補はランク下げ。他に候補がなければ従来通り採用
      // 中1: 予測精度40%未満（lowAccuracy）の候補も同様にランク下げ
      const eligibleScores = sortedScores.filter(([actionType, s]) => s.score >= 0.85 && !shouldSuppressAction(actionType));
      const topValid = eligibleScores.find(([actionType]) => !isLowWinRate(actionType) && !isLowAccuracy(actionType)) ?? eligibleScores[0];
      if (topValid) {
        return NextResponse.json({
          action: topValid[0],
          reason: ACTION_REASON[topValid[0]] ?? topValid[1].topKeyword,
          source: "trigger_rule",
          params: buildParams(topValid[0]),
          acceptanceRate: acceptanceRateMap[topValid[0]] ?? null,
          sub_mode_stats: subModeStats,
          ...templateRec(topValid[0]),
        });
      }
    }
  }

  // ---- ステータス既定アクション（P8 Haiku流入削減）----
  // applying（申込手続き中）はキーワード・DBルール不一致でも次アクションが自明なため決定的に返す。
  // 採択率が30%を下回れば shouldSuppressAction が自動的に抑制する（自己修正）。
  if (currentStatus === "applying") {
    if (shouldSuppressAction("application_push")) return NextResponse.json({ action: null, reason: "" });
    return NextResponse.json({ action: "application_push", reason: "申込手続きを進める", source: "status_rule", params: buildParams("application_push"), acceptanceRate: acceptanceRateMap["application_push"] ?? null, sub_mode_stats: subModeStats, ...templateRec("application_push") });
  }

  // ---- P8フォールバック（Sonnet 4.6 AI判断）----
  // ガード①: 会話履歴が5件未満の場合はデータ不足のためAI判断をスキップ
  // （少ない情報で幻覚ガイドに従い誤ったアクションを提案するリスクを防ぐ）
  if ((messages?.length ?? 0) < 5) {
    return NextResponse.json({ action: null, reason: "" });
  }

  // ---- UIで管理しているAIXロジック＋過去パターンデータ＋フロー運用ガイドを並列取得 ----
  // ※成約貢献率（aix_action_attribution）は冒頭の並列取得で取得済み（attrMap / avgWinRateMap を再利用）
  const [{ data: aixLogicRows }, { data: patternRows }, { data: flowGuideRow }] = await Promise.all([
    supabase.from("ai_prompts")
      .select("key, content")
      .like("key", "aix_logic_%"),
    supabase.from("action_pattern_logs")
      .select("action_type, customer_msg_summary")
      .eq("conversation_status", currentStatus)
      .order("created_at", { ascending: false })
      .limit(60),
    // aix_flow_guide（analyze-aix-flow cron の学習成果）
    supabase.from("ai_prompts")
      .select("content")
      .eq("key", "aix_flow_guide")
      .maybeSingle(),
  ]);

  const aixFlowGuide = ((flowGuideRow?.content as string | undefined) ?? "").trim();

  const aixLogicSection = (aixLogicRows ?? [])
    .map((r) => (r.content as string))
    .join("\n\n---\n\n");

  // アクション頻度集計
  const freq: Record<string, number> = {};
  for (const row of patternRows ?? []) {
    const a = row.action_type as string;
    freq[a] = (freq[a] ?? 0) + 1;
  }
  const totalPatterns = Object.values(freq).reduce((s, n) => s + n, 0);

  // ガード②（中6で緩和）: フロー運用ガイドが未学習（空）でも、過去パターンデータが
  // 3件以上あれば system プロンプトの基礎フロー知識のみで Sonnet を実行する。
  // ガイドも過去パターンも無い場合のみAI判断をスキップ
  if (!aixFlowGuide && totalPatterns < 3) {
    return NextResponse.json({ action: null, reason: "" });
  }

  // 上位3アクションを頻度付きで表示
  const topActions = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([action, count]) => {
      const pct = Math.round((count / totalPatterns) * 100);
      return `- ${action}: ${count}件 (${pct}%)`;
    })
    .join("\n");

  // 具体的な過去例（最新5件）
  const examples = (patternRows ?? [])
    .filter((r) => (r.customer_msg_summary as string)?.trim())
    .slice(0, 5)
    .map((r) => `  顧客:「${(r.customer_msg_summary as string).slice(0, 60)}」→ ${r.action_type}`)
    .join("\n");

  // created_at から相対時刻（X分前/X時間前/X日前）を計算
  const relativeTime = (createdAt: string | null | undefined): string => {
    if (!createdAt) return "";
    const diffMs = Date.now() - new Date(createdAt).getTime();
    if (diffMs < 0) return "たった今";
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "たった今";
    if (mins < 60) return `${mins}分前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}時間前`;
    return `${Math.floor(hours / 24)}日前`;
  };

  const recentText = [...messages]
    .reverse()
    .map((m) => {
      const rel = relativeTime(m.created_at as string | null | undefined);
      return `[${m.sender === "staff" ? "スタッフ" : "顧客"}${rel ? ` ${rel}` : ""}] ${(m.text as string) || "(画像)"}`;
    })
    .join("\n");

  const patternSection = totalPatterns >= 3
    ? `## 過去の実績データ（ステータス「${statusLabel}」のとき、実際に取られたアクション）
アクション頻度:
${topActions}

具体的な過去例:
${examples || "  (なし)"}

`
    : "";

  const aixLogicGuide = aixLogicSection
    ? `## 各AIXボタンの発動条件（管理UIで設定済み）\n${aixLogicSection}\n\n`
    : "";

  // JST現在日時（YYYY/M/D H:MM形式）
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const jstNowStr = `${jstNow.getUTCFullYear()}/${jstNow.getUTCMonth() + 1}/${jstNow.getUTCDate()} ${jstNow.getUTCHours()}:${String(jstNow.getUTCMinutes()).padStart(2, "0")}`;

  // 顧客コンテキスト（property_customers の希望条件・要望・入居時期・AIサマリー）
  const customerContext = [
    customer?.preferences ? `希望条件: ${customer.preferences as string}` : "",
    customer?.other_requests ? `その他要望: ${customer.other_requests as string}` : "",
    customer?.move_in_time ? `入居時期: ${customer.move_in_time as string}` : "",
    customer?.ai_summary ? `サマリー: ${customer.ai_summary as string}` : "",
  ].filter(Boolean).join("\n");

  // aix_action_attribution: 冒頭で集計済みの avgWinRateMap（action_type別・直近1ヶ月の win_rate 平均）を使用
  const attributionLines = Object.entries(avgWinRateMap)
    .map(([a, avgWinRate]) => ({ action: a, avgWinRate }))
    .filter((e) => e.avgWinRate > 0)
    .sort((a, b) => b.avgWinRate - a.avgWinRate)
    .slice(0, 5)
    .map((e) => `- ${e.action}: 成約貢献率 ${Math.round(e.avgWinRate * 100)}%`);
  const attributionSection = attributionLines.length
    ? `## 成約貢献率（直近1ヶ月の実績）\n${attributionLines.join("\n")}\n\n`
    : "";

  // 中1: 予測精度が低い（40%未満・サンプル5件以上）アクションを警告として注入
  const lowAccuracyLines = Object.entries(accuracyMap)
    .filter(([actionType]) => isLowAccuracy(actionType))
    .map(([a, v]) => `- ${a}: 予測一致率 ${Math.round(v.accuracy * 100)}%（${v.samples}件）`);
  const accuracySection = lowAccuracyLines.length
    ? `## 予測精度が低いアクション（直近30日実績・提案は慎重に。他に妥当な候補があればそちらを優先）\n${lowAccuracyLines.join("\n")}\n\n`
    : "";

  // フロー運用ガイドは「## 指示」やJSON出力指示より前に注入する（後置するとフォーマット遵守が弱まる）
  // 改善15: analyze-aix-flow の出力上限（800字指示・max_tokens 1000）と整合させて末尾切れを防ぐ
  // 中6: ガイド未学習（空）の場合はセクション自体を省略（過去パターン + 基礎フロー知識で判断）
  const flowGuideSection = aixFlowGuide
    ? `## AIXフロー運用ガイド（学習済み）
${aixFlowGuide.slice(0, 1000)}

`
    : "";

  const prompt = `あなたは不動産営業AIのアドバイザーです。
現在日時（JST）: ${jstNowStr}
${customerContext ? customerContext + "\n" : ""}${aixLogicGuide}${flowGuideSection}${attributionSection}${accuracySection}${patternSection}## 現在の会話
顧客名: ${conv.customer_name as string}
ステータス: ${statusLabel}
直前のAIXアクション: ${last_aix_action || "なし"}
顧客の最新メッセージ: ${lastCustomerMsg ? `「${lastCustomerMsg.slice(0, 200)}」` : "(なし)"}

直近の会話（古い順）:
${recentText}

## 指示
上記の「各AIXボタンの発動条件」「AIXフロー運用ガイド」と過去実績データを参照して、スタッフが次に取るべき最適なアクションを1つ選んでください。

選択肢:
- property_check_result: 物件の空室確認結果を報告する
- property_send: 物件を送る
- viewing_invite: 内覧を提案する
- application_push: 申込を促す
- estimate_sheet: 見積書を送る
- meeting_place: 待ち合わせを決める
- property_recommendation: 物件オススメを送る
- null: 特に次のアクションなし

## 出力形式（JSONのみ。reasonは日本語10文字以内）
{"action": "viewing_invite", "reason": "内覧希望が出た"}`;

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      temperature: 0,
      // 営業フロー基礎知識をハードコード（DBの学習ガイドに全依存しないフォールバック知識）
      system: "不動産賃貸営業の基本フロー: ヒアリング → 物件提案 → 内覧 → 見積 → 申込 の順で顧客を次のステップへ進める。",
      messages: [{ role: "user", content: prompt }],
    });

    const text = ((message.content[0] as { type: string; text: string }).text ?? "").trim();
    const match = text.match(/\{[^}]+\}/);
    if (!match) return NextResponse.json({ action: null, reason: "" });

    const result = JSON.parse(match[0]) as { action: string | null; reason?: string };
    // AIが "null" を文字列で返すケースを null に正規化
    const action = (!result.action || result.action === "null") ? null : result.action;
    if (!action) return NextResponse.json({ action: null, reason: result.reason ?? "" });
    // Sonnet が提案したアクションも採択率が 30% 未満なら抑制
    if (shouldSuppressAction(action)) return NextResponse.json({ action: null, reason: "" });
    return NextResponse.json({ action, reason: result.reason ?? "", source: "ai_fallback", params: buildParams(action), acceptanceRate: acceptanceRateMap[action] ?? null, sub_mode_stats: subModeStats, ...templateRec(action) });
  } catch (e) {
    console.error("[suggest-next-action] Sonnet 呼び出しに失敗:", e);
    return NextResponse.json({ action: null, reason: "" });
  }
}
