import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "@/app/lib/supabase";
import { normalizeStatus } from "@/app/lib/status-normalize";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const STATUS_LABEL: Record<string, string> = {
  hearing: "ヒアリング中",
  proposing: "物件提案中",
  viewing: "内覧調整中",
  application: "申込手続き中",
  contract: "契約済み",
  lost: "失注",
  // 追加ステータス（実DB値）
  first_reply: "初回対応中",
  condition_hearing: "条件ヒアリング中",
  property_recommendation: "物件提案中",
  availability_check: "空き確認中",
  estimate_request: "見積依頼中",
  applying: "申込手続き中",
  closed_won: "契約成立",
  closed_lost: "失注",
};

const SKIP_STATUSES = new Set(["contract", "lost", "closed_won", "closed_lost"]);

// アクション別の初期化パラメータ（クライアントのAIXモーダル初期状態に引き継ぐ）
const ACTION_PARAMS: Record<string, { check_pattern?: string; send_mode?: string }> = {
  property_check_result: { check_pattern: "available" },
  property_send: { send_mode: "normal" },
  property_recommendation: { send_mode: "pickup" },
  viewing_invite: { send_mode: "normal" },
};

export async function POST(req: NextRequest) {
  const { conversation_id, last_aix_action: clientLastAixAction, available } = await req.json() as { conversation_id: string; last_aix_action?: string | null; available?: boolean | null };
  if (!conversation_id) return NextResponse.json({ action: null, reason: "" });

  // 会話・メッセージ・顧客・採択率（毎日 update-action-confidence cron が更新）を並列取得
  const [{ data: conv }, { data: messages }, { data: customer }, { data: acceptanceRows }] = await Promise.all([
    supabase.from("conversations")
      .select("status, customer_name, last_sender")
      .eq("id", conversation_id)
      .single(),
    supabase.from("messages")
      .select("sender, text, image_url, created_at")
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase.from("property_customers")
      .select("conditions, ai_summary")
      .eq("conversation_id", conversation_id)
      .maybeSingle(),
    supabase.from("trigger_action_rules")
      .select("action_type, confidence")
      .eq("keyword", "SUGGESTION_ACCEPT_RATE"),
  ]);

  const acceptanceRateMap = Object.fromEntries(
    (acceptanceRows || []).map((r) => [r.action_type as string, r.confidence as number])
  );

  // 採択率が 30% 未満のアクションは抑制する
  function shouldSuppressAction(actionType: string | null | undefined): boolean {
    if (!actionType) return false;
    const rate = acceptanceRateMap[actionType];
    return rate !== undefined && rate < 0.3;
  }

  if (!conv || !messages?.length) return NextResponse.json({ action: null, reason: "" });
  if (SKIP_STATUSES.has(conv.status as string)) return NextResponse.json({ action: null, reason: "" });

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
  if (last_aix_action === "property_check_result" && conv.last_sender === "customer") {
    if (available === true) {
      // 空室あり → 見積書または内覧誘導
      const nextAction = !shouldSuppressAction("estimate_sheet") ? "estimate_sheet"
        : !shouldSuppressAction("viewing_invite") ? "viewing_invite"
        : null;
      if (nextAction) {
        return NextResponse.json({ action: nextAction, reason: nextAction === "estimate_sheet" ? "空室確認後・見積書" : "空室確認後・内覧へ", source: "chain_rule", params: buildParams(nextAction), acceptanceRate: acceptanceRateMap[nextAction] ?? null });
      }
    } else {
      // available === false または未指定（unavailable / 不明）→ 代替物件送りへ誘導
      if (!shouldSuppressAction("alternative_send")) {
        return NextResponse.json({ action: "alternative_send", reason: "代替物件を送る", source: "chain_rule", params: buildParams("alternative_send"), acceptanceRate: acceptanceRateMap["alternative_send"] ?? null });
      }
    }
  }

  const currentStatus = normalizeStatus((conv.status as string) ?? "hearing");
  const statusLabel = STATUS_LABEL[currentStatus] ?? currentStatus;

  // ---- AIXチェーンルール: 直前のAIXアクションから次を提案 ----
  // ※ staff early return より前に置くことで送信直後にも発火する（Fable5 S-1修正）
  if (last_aix_action) {
    // フェーズ特定ルール ("AFTER:{action}|{phase}") と汎用ルール ("AFTER:{action}") を1クエリで取得し、コードで振り分け
    const phaseSpecificKeyword = `AFTER:${last_aix_action}|${currentStatus}`;
    const genericKeyword = `AFTER:${last_aix_action}`;

    const { data: allChainRules } = await supabase
      .from("trigger_action_rules")
      .select("action_type, confidence, occurrence_count, keyword")
      .in("keyword", [phaseSpecificKeyword, genericKeyword])
      .gte("confidence", 0.35)
      .gte("occurrence_count", 2)
      .order("confidence", { ascending: false })
      .limit(6);

    // フェーズ特定を優先、なければ汎用にフォールバック
    const phaseChain = (allChainRules || []).filter((r) => r.keyword === phaseSpecificKeyword);
    const chainRules = phaseChain.length ? phaseChain : (allChainRules || []).filter((r) => r.keyword === genericKeyword);

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
      const validChainRule = chainRules.find((r) => !shouldSuppressAction(r.action_type as string));
      if (validChainRule) {
        return NextResponse.json({
          action: validChainRule.action_type,
          reason: CHAIN_REASON[validChainRule.action_type as string] ?? `${last_aix_action}の次`,
          source: "chain_rule",
          params: buildParams(validChainRule.action_type as string),
          acceptanceRate: acceptanceRateMap[validChainRule.action_type as string] ?? null,
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
      return NextResponse.json({ action: "property_send", reason: `${Math.floor(daysSince)}日間未返信・追客`, params: buildParams("property_send"), acceptanceRate: acceptanceRateMap["property_send"] ?? null });
    }
    return NextResponse.json({ action: null, reason: "" });
  }

  // ---- トリガールールで即判定（Haiku不要の場合）----
  const lastCustomerMsg = [...messages]
    .reverse()
    .filter((m) => m.sender === "customer" && (m.text as string)?.trim())
    .at(-1)?.text as string ?? "";

  // 入居日を指定して見積書再送を要求 → 見積書送る（「待ち合わせ」と誤判定しないよう最優先でチェック）
  const DATE_ENTRY_ESTIMATE_RE = /\d+[\/月]\d+[日]?.*入居|入居.*\d+[\/月]\d+[日]?/;
  if ((DATE_ENTRY_ESTIMATE_RE.test(lastCustomerMsg) || lastCustomerMsg.includes("入居")) &&
      (lastCustomerMsg.includes("出して") || lastCustomerMsg.includes("出してほしい") || lastCustomerMsg.includes("で出し") || lastCustomerMsg.includes("見積"))) {
    if (!shouldSuppressAction("estimate_sheet")) {
      return NextResponse.json({ action: "estimate_sheet", reason: "入居日指定・見積書再送", source: "trigger_rule", params: buildParams("estimate_sheet"), acceptanceRate: acceptanceRateMap["estimate_sheet"] ?? null });
    }
  }

  // 物件画像・動画が送られてきた場合は即座に「物件確認した」を提案
  const IMAGE_CHECK_STATUSES = new Set(["first_reply", "hearing", "proposing", "property_recommendation", "availability_check", "condition_hearing"]);
  if ((lastCustomerMsg.includes("[画像]") || lastCustomerMsg.includes("[動画]")) && IMAGE_CHECK_STATUSES.has(currentStatus)) {
    if (!shouldSuppressAction("property_check_result")) {
      return NextResponse.json({ action: "property_check_result", reason: "物件画像が送られた", source: "trigger_rule", params: buildParams("property_check_result"), acceptanceRate: acceptanceRateMap["property_check_result"] ?? null });
    }
  }

  // 物件URLの送信 or 空室確認の質問 → 物件確認を提案
  const PROPERTY_URL_RE = /athome\.co\.jp|suumo\.jp|homes\.co\.jp|lifull\.com|chintai\.net|reins\.|realestate\.|rakumachi\.jp/i;
  const AVAILABILITY_KEYWORDS = ["まだありますか", "空いていますか", "空いてますか", "空室ですか", "空室確認", "空き確認", "まだ空い", "まだ残って", "空室はありますか", "こちらの物件"];
  // 直近3件の顧客メッセージを確認（昇順化後の末尾3件＝最新3件）
  const recentCustomerMsgs = [...messages].reverse().filter((m) => m.sender === "customer").slice(-3).map((m) => (m.text as string) ?? "");
  const hasPropertyUrl = recentCustomerMsgs.some((t) => PROPERTY_URL_RE.test(t));
  const hasAvailabilityQuestion = AVAILABILITY_KEYWORDS.some((kw) => lastCustomerMsg.includes(kw));
  if ((hasPropertyUrl || hasAvailabilityQuestion) && IMAGE_CHECK_STATUSES.has(currentStatus)) {
    if (!shouldSuppressAction("property_check_result")) {
      return NextResponse.json({ action: "property_check_result", reason: "物件の空室確認依頼", source: "trigger_rule", params: buildParams("property_check_result"), acceptanceRate: acceptanceRateMap["property_check_result"] ?? null });
    }
  }

  // S-5: 費用・内覧・申込キーワード即判定（DBルール不要・Haiku流入削減）
  if (/費用|初期費用|いくら/.test(lastCustomerMsg)) {
    if (!shouldSuppressAction("estimate_sheet")) {
      return NextResponse.json({ action: "estimate_sheet", reason: "費用に関する質問を検出", source: "keyword_trigger", params: buildParams("estimate_sheet"), acceptanceRate: acceptanceRateMap["estimate_sheet"] ?? null });
    }
  }
  // 内覧: 「内見」（内覧より多い表記）「見学」「現地確認」もカバー
  if (/内覧|内見|見学.*したい|見学.*希望|見学.*できますか|現地.*確認|現地.*見た/.test(lastCustomerMsg)) {
    if (!shouldSuppressAction("viewing_invite")) {
      return NextResponse.json({ action: "viewing_invite", reason: "内覧希望を検出", source: "keyword_trigger", params: buildParams("viewing_invite"), acceptanceRate: acceptanceRateMap["viewing_invite"] ?? null });
    }
  }
  // 申込: 「申込みたい」（送り仮名違い）「決めます」「決めたい」「こちらで申」もカバー
  if (/申し込み.*たい|申込.*したい|申込.*希望|申込みたい|入居申込|決めます|決めたい|こちらで申/.test(lastCustomerMsg)) {
    if (!shouldSuppressAction("application_push")) {
      return NextResponse.json({ action: "application_push", reason: "申込意向を検出", source: "keyword_trigger", params: buildParams("application_push"), acceptanceRate: acceptanceRateMap["application_push"] ?? null });
    }
  }
  // 日程確定 → meeting_place（「◯曜◯時」「◯月◯日」「AM/PM/午前/午後」+ 確定系の言い回し）
  if (/[月火水木金土日]曜.*[0-9０-９時]|[0-9０-９]+月[0-9０-９]+日|AM|PM|午前|午後/.test(lastCustomerMsg) &&
      /いかがでしょう|で大丈夫|でお願い|伺います|行きます|確定|来られ|来れ/.test(lastCustomerMsg)) {
    if (!shouldSuppressAction("meeting_place")) {
      return NextResponse.json({ action: "meeting_place", reason: "日程確定の意向を検出", source: "keyword_trigger", params: buildParams("meeting_place"), acceptanceRate: acceptanceRateMap["meeting_place"] ?? null });
    }
  }

  if (lastCustomerMsg) {
    // conversation_status が NULL（全フェーズ共通）またはこのフェーズ限定のルールのみ取得
    const { data: triggerRules } = await supabase
      .from("trigger_action_rules")
      .select("action_type, keyword, confidence, occurrence_count, conversation_status")
      .gte("confidence", 0.65)
      .gte("occurrence_count", 1)
      .or(`conversation_status.is.null,conversation_status.eq.${currentStatus}`)
      .order("confidence", { ascending: false })
      .limit(500);

    if (triggerRules?.length) {
      // キーワードが含まれるルールをスコアリング
      const scores: Record<string, { score: number; topKeyword: string; topConf: number }> = {};
      for (const rule of triggerRules) {
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
      const sortedScores = Object.entries(scores).sort((a, b) => b[1].score - a[1].score);
      const topValid = sortedScores.find(([actionType, s]) => s.score >= 0.85 && !shouldSuppressAction(actionType));
      if (topValid) {
        return NextResponse.json({
          action: topValid[0],
          reason: ACTION_REASON[topValid[0]] ?? topValid[1].topKeyword,
          source: "trigger_rule",
          params: buildParams(topValid[0]),
          acceptanceRate: acceptanceRateMap[topValid[0]] ?? null,
        });
      }
    }
  }

  // ---- UIで管理しているAIXロジック＋過去パターンデータ＋フロー運用ガイドを並列取得 ----
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

  const recentText = [...messages]
    .reverse()
    .map((m) => `[${m.sender === "staff" ? "スタッフ" : "顧客"}] ${(m.text as string) || "(画像)"}`)
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

  // 顧客コンテキスト（property_customers の条件・AIサマリー）
  const customerContext = [
    customer?.conditions ? `条件: ${customer.conditions as string}` : "",
    customer?.ai_summary ? `サマリー: ${customer.ai_summary as string}` : "",
  ].filter(Boolean).join("\n");

  const prompt = `あなたは不動産営業AIのアドバイザーです。
現在日時（JST）: ${jstNowStr}
${customerContext ? customerContext + "\n" : ""}${aixLogicGuide}${patternSection}## 現在の会話
顧客名: ${conv.customer_name as string}
ステータス: ${statusLabel}

直近の会話（古い順）:
${recentText}

## 指示
上記の「各AIXボタンの発動条件」と過去実績データを参照して、スタッフが次に取るべき最適なアクションを1つ選んでください。

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
{"action": "viewing_invite", "reason": "内覧希望が出た"}`
    + (aixFlowGuide ? "\n\n【AIXフロー運用ガイド（学習済み）】\n" + aixFlowGuide.slice(0, 500) : "");

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 80,
      messages: [{ role: "user", content: prompt }],
    });

    const text = ((message.content[0] as { type: string; text: string }).text ?? "").trim();
    const match = text.match(/\{[^}]+\}/);
    if (!match) return NextResponse.json({ action: null, reason: "" });

    const result = JSON.parse(match[0]) as { action: string | null; reason?: string };
    // AIが "null" を文字列で返すケースを null に正規化
    const action = (!result.action || result.action === "null") ? null : result.action;
    if (!action) return NextResponse.json({ action: null, reason: result.reason ?? "" });
    // Haiku が提案したアクションも採択率が 30% 未満なら抑制
    if (shouldSuppressAction(action)) return NextResponse.json({ action: null, reason: "" });
    return NextResponse.json({ action, reason: result.reason ?? "", params: buildParams(action), acceptanceRate: acceptanceRateMap[action] ?? null });
  } catch (e) {
    console.error("[suggest-next-action] Haiku 呼び出しに失敗:", e);
    return NextResponse.json({ action: null, reason: "" });
  }
}
