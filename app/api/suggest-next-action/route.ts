import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "@/app/lib/supabase";

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

export async function POST(req: NextRequest) {
  const { conversation_id, last_aix_action } = await req.json() as { conversation_id: string; last_aix_action?: string | null };
  if (!conversation_id) return NextResponse.json({ action: null, reason: "" });

  const [{ data: conv }, { data: messages }] = await Promise.all([
    supabase.from("conversations")
      .select("status, customer_name, last_sender")
      .eq("id", conversation_id)
      .single(),
    supabase.from("messages")
      .select("sender, text, created_at")
      .eq("conversation_id", conversation_id)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  if (!conv || !messages?.length) return NextResponse.json({ action: null, reason: "" });
  if (SKIP_STATUSES.has(conv.status as string)) return NextResponse.json({ action: null, reason: "" });

  // 物件確認結果（unavailable）の後にお客様が返信 → 代替物件送りへ誘導
  if (last_aix_action === "property_check_result" && conv.last_sender === "customer") {
    return NextResponse.json({ action: "alternative_send", reason: "代替物件を送る", source: "chain_rule" });
  }

  // スタッフが最後に送信 → 3日以上返信なしなら物件送るを誘導
  if (conv.last_sender === "staff") {
    const latestMsg = messages[0]; // order: desc なので最新が先頭
    const daysSince = latestMsg?.created_at
      ? (Date.now() - new Date(latestMsg.created_at as string).getTime()) / (1000 * 60 * 60 * 24)
      : 0;
    if (daysSince >= 3) {
      return NextResponse.json({ action: "property_send", reason: `${Math.floor(daysSince)}日間未返信・追客` });
    }
    return NextResponse.json({ action: null, reason: "" });
  }

  const currentStatus = (conv.status as string) ?? "hearing";
  const statusLabel = STATUS_LABEL[currentStatus] ?? currentStatus;

  // ---- AIXチェーンルール: 直前のAIXアクションから次を提案 ----
  if (last_aix_action) {
    const { data: chainRules } = await supabase
      .from("trigger_action_rules")
      .select("action_type, confidence, occurrence_count")
      .eq("keyword", `AFTER:${last_aix_action}`)
      .gte("confidence", 0.35)
      .gte("occurrence_count", 2)
      .order("confidence", { ascending: false })
      .limit(3);

    if (chainRules?.length) {
      const top = chainRules[0];
      const CHAIN_REASON: Record<string, string> = {
        property_recommendation: "物件送った後のオススメ",
        viewing_invite: "物件提案後・内覧誘導",
        estimate_sheet: "空室確認後・見積書",
        application_push: "内覧後・申込へ",
        meeting_place: "内覧日程を決める",
        property_send: "追加物件を送る",
      };
      return NextResponse.json({
        action: top.action_type,
        reason: CHAIN_REASON[top.action_type as string] ?? `${last_aix_action}の次`,
        source: "chain_rule",
      });
    }
  }

  // ---- トリガールールで即判定（Haiku不要の場合）----
  const lastCustomerMsg = [...messages]
    .reverse()
    .filter((m) => m.sender === "customer" && (m.text as string)?.trim())
    .at(-1)?.text as string ?? "";

  // 物件画像・動画が送られてきた場合は即座に「物件確認した」を提案
  const IMAGE_CHECK_STATUSES = new Set(["first_reply", "hearing", "proposing", "property_recommendation", "availability_check", "condition_hearing"]);
  if ((lastCustomerMsg === "[画像]" || lastCustomerMsg === "[動画]") && IMAGE_CHECK_STATUSES.has(currentStatus)) {
    return NextResponse.json({ action: "property_check_result", reason: "物件画像が送られた", source: "trigger_rule" });
  }

  // 物件URLの送信 or 空室確認の質問 → 物件確認を提案
  const PROPERTY_URL_RE = /athome\.co\.jp|suumo\.jp|homes\.co\.jp|lifull\.com|chintai\.net|reins\.|realestate\.|rakumachi\.jp/i;
  const AVAILABILITY_KEYWORDS = ["まだありますか", "まだありますか", "空いていますか", "空いてますか", "空いてますか", "空室ですか", "空室確認", "空き確認", "まだ空い", "まだ残って", "空室はありますか", "こちらの物件"];
  // 直近3件の顧客メッセージを確認
  const recentCustomerMsgs = [...messages].reverse().filter((m) => m.sender === "customer").slice(0, 3).map((m) => (m.text as string) ?? "");
  const hasPropertyUrl = recentCustomerMsgs.some((t) => PROPERTY_URL_RE.test(t));
  const hasAvailabilityQuestion = AVAILABILITY_KEYWORDS.some((kw) => lastCustomerMsg.includes(kw));
  if ((hasPropertyUrl || hasAvailabilityQuestion) && IMAGE_CHECK_STATUSES.has(currentStatus)) {
    return NextResponse.json({ action: "property_check_result", reason: "物件の空室確認依頼", source: "trigger_rule" });
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

      const top = Object.entries(scores).sort((a, b) => b[1].score - a[1].score)[0];
      // スコアが閾値を超えたら Haiku を呼ばずに即返却
      if (top && top[1].score >= 0.85) {
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
        return NextResponse.json({
          action: top[0],
          reason: ACTION_REASON[top[0]] ?? top[1].topKeyword,
          source: "trigger_rule",
        });
      }
    }
  }

  // ---- 過去パターンデータを取得 ----
  const { data: patternRows } = await supabase
    .from("action_pattern_logs")
    .select("action_type, customer_msg_summary")
    .eq("conversation_status", currentStatus)
    .order("created_at", { ascending: false })
    .limit(60);

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

  const prompt = `あなたは不動産営業AIのアドバイザーです。
${patternSection}## 現在の会話
顧客名: ${conv.customer_name as string}
ステータス: ${statusLabel}

直近の会話（古い順）:
${recentText}

## 指示
上記の過去実績データ（あれば）と現在の会話内容を総合して、スタッフが次に取るべき最適なアクションを1つ選んでください。

選択肢:
- property_check_result: 物件の空室確認結果を報告する（お客様が物件画像・URLを送ってきた・空室確認を依頼された）
- property_send: 物件を送る（条件整理済み・物件を求めている）
- viewing_invite: 内覧を提案する（物件に興味あり）
- application_push: 申込を促す（内覧後・前向き）
- estimate_sheet: 見積書を送る（費用・初期費用の質問）
- meeting_place: 待ち合わせを決める（内覧日時が確定しそう）
- null: 特に次のアクションなし

## 出力形式（JSONのみ。reasonは日本語10文字以内）
{"action": "viewing_invite", "reason": "内覧希望が出た"}`;

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
    return NextResponse.json({ action, reason: result.reason ?? "" });
  } catch {
    return NextResponse.json({ action: null, reason: "" });
  }
}
