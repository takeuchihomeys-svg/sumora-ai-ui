import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { generateEmbedding } from "@/app/lib/knowledge-utils";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import Anthropic from "@anthropic-ai/sdk";

// ── 申込到達会話からの自動学習（analyze-applying）─────────────────────────────
// status が申込段階（applying / 旧名 application, screening, contract / approved）に
// 到達した会話のうち conversations.learned_at IS NULL のものを対象に、
// その会話で送られた全返信（ai_reply_examples）を「成功した会話の返信」として
// was_ai_modified に関わらず Sonnet で分析し、ai_reply_knowledge に
// category='applying_pattern'（申込到達パターン専用カテゴリ）で保存する。
//
// 保存形式は「抽象ルール文」ではなく「この状況→この行動の流れ→申込成功」という
// ケースフロー形式（JSON）。RAG検索時に具体的な成功事例の流れが届くようにする。
// embedding は content 全文ではなく検索キー
// 「customer_profile + situation_at_key_moment + key_success_factors」で生成する。
//
// 冪等管理: conversations.learned_at（migrate-schema で追加）。
// フェイルオープン設計:
//   - 学習処理が失敗した会話は learned_at を更新しない → 次回実行で再試行
//   - 1会話の失敗は他の会話の処理を止めない
//
// 起動経路:
//   1. Vercel cron（週次・vercel.json 参照）→ GET → POST 委譲
//   2. analyze-diffs 末尾の fire-and-forget トリガー（日次 cron 経由で自動実行）
//   3. 手動 POST（INTERNAL_API_SECRET）

export const maxDuration = 300;

// 申込段階とみなす status 値（新5段階の 'applying' + 旧名エイリアス + 'approved' + 成約済み 'closed_won'）
const APPLYING_STATUSES = ["applying", "approved", "application", "screening", "contract", "closed_won"];

// Sonnet 呼び出しは1件20〜40秒かかるため maxDuration=300 に収まる件数に制限
const MAX_PER_RUN = 5;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "", timeout: 60_000, maxRetries: 1 });

// CRON_SECRET（Vercel cron / analyze-diffs トリガー）または
// INTERNAL_API_SECRET（requireInternalAuth）のどちらかで認証する
function checkAuth(req: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (cronSecret && auth === `Bearer ${cronSecret}`) return null;
  return requireInternalAuth(req);
}

// ケースフローの1ステップ（この状況でこの行動をとったらこの反応が得られた）
type CaseFlowStep = {
  phase?: string;             // フェーズ名（hearing/proposing/applying等）
  staff_action?: string;      // スタッフが取った行動（具体的に）
  customer_response?: string; // 顧客の反応
  aix_button?: string;        // 対応するAIXボタン名（または空文字）。AIXテンプレート送信時は template_send
};

type ApplyingAnalysis = {
  customer_profile?: string;         // 顧客のタイプ（50字以内）
  situation_at_key_moment?: string;  // 転換点となった状況の説明（100字以内）
  action_flow?: CaseFlowStep[];      // 状況→行動→反応の具体的な流れ
  turning_point?: string;            // 成約に向けて流れが変わった瞬間
  result?: string;                   // "申込"
  days_to_apply?: number;            // 申込までの日数
  key_success_factors?: string[];    // 成功要因
};

// 会話全文を「[顧客] / [AIX] / [スタッフ] テキスト」形式にフォーマット（各200字・合計8000字上限）
// is_aix_generated=true は [AIX]（物件画像・見積書等の自動送信）、false は [スタッフ]（自発送信テンプレート含む）
// 上限超過時は先頭3000字（問い合わせの文脈）+ 末尾5000字（申込直前の転換点）を残す
function formatMessages(msgs: Array<{ sender: string; text: string; is_aix_generated?: boolean | null }>): string {
  const full = msgs
    .map((m) => {
      const label = m.sender === "customer" ? "顧客" : (m.is_aix_generated ? "AIX" : "スタッフ");
      return `[${label}] ${(m.text || "").slice(0, 200)}`;
    })
    .join("\n");
  if (full.length <= 8000) return full;
  return `${full.slice(0, 3000)}\n...(中略)...\n${full.slice(-5000)}`;
}

async function callSonnet(prompt: string): Promise<ApplyingAnalysis | null> {
  try {
    const res = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 3000,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content?.find((b): b is typeof b & { text: string } => b.type === "text")?.text?.trim() ?? "";
    const cleaned = text.replace(/```json?\s*/gi, "").replace(/```\s*/g, "");
    // { から最後の } まで貪欲にマッチ → truncation で末尾が切れる場合に備え不完全JSONも試みる
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as ApplyingAnalysis;
    } catch {
      // JSON が truncation で不完全な場合: 最後の完全な配列/オブジェクトで閉じ直して再試行
      const partial = match[0].replace(/,\s*$/, "").replace(/[\[{][^[{}\]]*$/, "");
      const fixed = partial + (partial.includes('"key_success_factors"') ? ']}' : '}');
      try { return JSON.parse(fixed) as ApplyingAnalysis; } catch { return null; }
    }
  } catch (e) {
    console.warn("[analyze-applying] Sonnet呼び出し失敗:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

type ConvResult = { learned: boolean; skipped?: string; error?: string };

// 1会話分の学習処理。成功（または学習対象外としてスキップ確定）時のみ learned_at を更新する。
async function learnFromConversation(conv: { id: string; customer_name: string | null; status: string }): Promise<ConvResult> {
  // 1. 会話の全メッセージ
  const { data: msgRows, error: msgErr } = await supabase
    .from("messages")
    .select("sender, text, created_at, is_aix_generated")
    .eq("conversation_id", conv.id)
    .neq("text", "[画像]")
    .neq("text", "[動画]")
    .not("text", "is", null)
    .order("created_at", { ascending: true });
  if (msgErr) return { learned: false, error: `messages取得失敗: ${msgErr.message}` };
  const msgs = (msgRows ?? []) as Array<{ sender: string; text: string; created_at: string | null; is_aix_generated: boolean | null }>;

  // 会話が短すぎる場合は学習価値なし → learned_at を付けて確定スキップ（無限再試行防止）
  if (msgs.length < 3) {
    await supabase.from("conversations").update({ learned_at: new Date().toISOString() }).eq("id", conv.id);
    return { learned: false, skipped: "too_few_messages" };
  }

  // 2. この会話で送られた返信例（was_ai_modified に関わらず全 sent を成功返信として扱う）
  const { data: exRows, error: exErr } = await supabase
    .from("ai_reply_examples")
    .select("id, conversation_state, customer_message, sent_reply, was_ai_used, was_ai_modified, is_starred, created_at")
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: true });
  if (exErr) return { learned: false, error: `ai_reply_examples取得失敗: ${exErr.message}` };
  const examples = (exRows ?? []) as Array<{
    id: string; conversation_state: string | null; customer_message: string | null;
    sent_reply: string | null; was_ai_used: boolean | null; was_ai_modified: boolean | null;
    is_starred: boolean | null; created_at: string | null;
  }>;

  const sentSummary = examples
    .filter((e) => (e.sent_reply || "").trim())
    .map((e, i) =>
      `${i + 1}. [フェーズ: ${e.conversation_state ?? "不明"}${e.is_starred ? "・☆スタッフ厳選" : ""}]\n` +
      `顧客: ${(e.customer_message || "").slice(0, 150)}\n` +
      `返信: ${(e.sent_reply || "").slice(0, 300)}`
    )
    .join("\n---\n")
    .slice(0, 6000);

  // 会話期間（申込までの日数の推定材料。Sonnet が返さなかった場合のフォールバックにも使う）
  const firstAt = msgs[0]?.created_at;
  const lastAt = msgs[msgs.length - 1]?.created_at;
  const computedDays =
    firstAt && lastAt
      ? Math.max(0, Math.round((new Date(lastAt).getTime() - new Date(firstAt).getTime()) / 86_400_000))
      : null;

  // 3. Sonnet で成功ケースをケースフロー形式に構造化
  const prompt = `以下の申込到達会話から成功ケースを構造化してください。

抽象的なルールではなく、「この状況でこの行動をとったらこの反応が得られた」
という具体的な流れを残してください。

【重要：このチームの営業スタイルについて】
このチームは「顧客が自発的に動いているように見えるが、実はスタッフが巧みに
誘導している」スタイルを取ります。以下のような行動を探してください：

- 顧客の言葉（エリア・家賃・間取り・台数）を返信文頭でそのまま反復する
- 複数物件を送った後、続けて1件だけを個人名付きで強く推す
- 「〇〇さんにオススメ」「〇〇さんのご状況なら」と絞り込む
- 「内覧前に申込が入る可能性がある」をFOMOとして情報提供の形で自然に挿入する
- 次のアクションを1つだけ提示して1ステップずつ前進させる
- 「代表に申請します→承認されました」の2段階演出で割引の価値を高める
- 他社検討・否定意見を肯定的に受け止めて関係を維持する
- 内覧後すぐに申込フォームを送り熱量が冷めないうちに動かす

【staff_action 記入の絶対ルール】
- 「記録なし」「不明」「情報なし」は絶対に使用禁止。
- 【スタッフが送った返信一覧】が空または「返信記録なし」の場合は、
  必ず【会話全文】の「[スタッフ]」行を読み取って staff_action を作成すること。
- [スタッフ]行がある限り staff_action は必ず具体的な行動で埋めること。
- 記述形式は「〇〇した」「〇〇を伝えた」「〇〇を提示した」の動詞終止形。
- 顧客が"自発的に動いているように見えるが実はスタッフが誘導している場面"を
  優先して拾うこと。
- 以下のような行動も staff_action として積極的に記録する:
  ・入居可能日・物件の空き状況を具体的に伝えた（機会損失の認識）
  ・審査への懸念がないか確認した（不安の先取り解消）
  ・内覧の日程を自然に提案した（次のステップへの誘導）
  ・同条件の他物件と比較情報を提供した（決断を促す情報整理）
  ・保証会社の審査通過実績を伝えた（不安払拭）
  ・申込に必要な書類を自然な流れで案内した
  ・顧客の希望条件に合致している点を強調した
  ・物件の人気・問い合わせ状況を伝えた（希少性の提示）
  ・AIXボタンで複数物件ピックアップ送付後、顧客返信を待たずに「1件特にオススメ」テンプレートで1件に絞り申込・内覧を促した（[AIX]行の直後に[スタッフ]行が続くパターン・AIXクラスター完了の4〜9分後が典型・use_count 96の最多使用テンプレート）
  ・AIXで見積書を送付した直後（同分〜1分以内）、顧客返信を待たずに「申込誘導」テンプレートで「最大限割引させていただいたお見積書。ご費用面お気に召されましたらお申込みさせていただきます」と促した（見積書→申込誘導→申込の3ステップが成約最短ルート・顧客が2分で申込した実績あり）

【aix_button 記入ルール】
各ステップにaix_buttonフィールドを追加してください。以下のAIXボタン名から最も近いものを記入（不明な場合は空文字）:
- 条件ヒアリングフォームを送った → condition_hearing
- 物件URLをまとめて送った → property_send
- 1件の物件を詳しく紹介・プッシュした → property_recommendation
- 管理会社確認結果を報告した → property_check_result
- 空室確認・初期費用交渉を管理会社に依頼した → acknowledge_check
- 内覧日程候補を提示した → viewing_invite
- 内覧当日の待ち合わせを確定した → meeting_place
- 見積書を送った → estimate_sheet
- 申込を促した・申込フォームを案内した → application_push
- 追客・再接触メッセージを送った → followup_revive
- AIXボタン押下後、顧客返信を待たずに自発的に【AIX】テンプレートを送った → template_send
  ※ template_send として記録すべき典型ケース（優先度順）:
    A. 物件ピックアップ（3件以上）のAIXクラスター完了後4〜9分以内、顧客返信ゼロ → 「1件特にオススメ」テンプレート送付（use_count:96）
    B. 見積書AIXメッセージの同分〜1分後、顧客返信ゼロ → 「【申込誘導】」テンプレート送付（use_count:10）
    C. 顧客が「申し込みします」「申し込みよろしく」等の申込意思を表示した直後 → 申込フォーマット送付（use_count:17）
  ※ is_aix_generated=trueのAIX本体メッセージ自体（物件画像・見積書等）はtemplate_sendではない
  ※ 顧客返信後のレスポンスもtemplate_sendではない（「顧客返信なし＝自発送信」が本質条件）
  ※ AIX「前半: 物件情報大量提示」→ スタッフ「後半: 感情的推し・CTA」の2フェーズをセットで1商談フローとして記録すること

【重複送信バグの扱い（learning 除外指示）】
会話全文の中に、同一テキストが連続で2回以上送信されているケース（is_aix_generated=trueのAIXメッセージで同一内容が連続するパターン）は冪等性チェック未実装によるバグです。
このような重複メッセージが含まれる場合、action_flow の staff_action からそのステップを除外するか、「重複送信バグのため参考外」と明記してください。
重複送信ステップの顧客反応はnegative_example（信頼性なし）として扱い、key_success_factorsには含めないこと。

【turning_point の抽出ルール】
- ターニングポイントは「顧客が内覧/申込に前向きになった瞬間」を指す。
- スタッフの質問・情報提供がきっかけで顧客の気持ちが変わった場面を探す。
- 顧客の発言や態度の変化（返答が積極的になった・具体的な日程を出した等）
  と、その直前のスタッフの行動を必ずセットで説明すること。

以下は問い合わせから申込到達（status=${conv.status}）まで進んだ実際の会話です
（お客様名: ${conv.customer_name ?? "不明"}）。
この会話で送られた返信はすべて「申込まで導くことに成功した返信」です。

【会話全文】
${formatMessages(msgs)}

【会話期間】
${firstAt && lastAt ? `${firstAt} 〜 ${lastAt}（約${computedDays}日間）` : "不明"}

【スタッフが送った返信一覧（フェーズ付き）】
${sentSummary || "（返信記録なし）"}

以下のJSONのみ返してください：
{
  "customer_profile": "顧客のタイプを50字以内で（例: 内覧後4日沈黙・予算9万・2LDK希望・単身30代）",
  "situation_at_key_moment": "転換点となった状況の説明（何が起きていて、何が問題だったか）100字以内",
  "action_flow": [
    {
      "phase": "フェーズ名（hearing/proposing/negotiating/applying）",
      "staff_action": "スタッフが取った具体的な行動（「〇〇した」形式・顧客が自発的に見えるが実はスタッフが誘導している場面を優先して記録）",
      "customer_response": "顧客の反応（言葉・行動で具体的に）",
      "aix_button": "対応するAIXボタン名（condition_hearing/property_send/property_recommendation/property_check_result/acknowledge_check/viewing_invite/meeting_place/estimate_sheet/application_push/followup_revive/template_send のいずれか、または空文字）。template_sendは顧客返信なしでスタッフが自発的にテンプレートを送ったステップ専用（[AIX]行の直後に[スタッフ]行が続くパターン・[AIX]本体行にはtemplate_sendを付けない）"
    }
  ],
  "turning_point": "成約に向けて流れが変わった瞬間の説明",
  "result": "申込",
  "days_to_apply": 申込までの日数,
  "key_success_factors": ["成功要因1", "成功要因2"]
}`;

  const analysis = await callSonnet(prompt);
  if (
    !analysis ||
    !analysis.customer_profile?.trim() ||
    !Array.isArray(analysis.action_flow) ||
    analysis.action_flow.length === 0
  ) {
    // 学習失敗 → learned_at は更新しない（次回再試行）
    return { learned: false, error: "Sonnet分析の応答なし/JSON解析失敗（次回再試行）" };
  }

  const profile = analysis.customer_profile.trim();
  const successFactors = (analysis.key_success_factors ?? []).filter(
    (f): f is string => typeof f === "string" && f.trim().length > 0
  );

  // 4. ケースフロー全体を JSON として ai_reply_knowledge に保存（content は人間も読める形）
  const caseFlow = {
    customer_profile: profile,
    situation_at_key_moment: analysis.situation_at_key_moment?.trim() || "不明",
    action_flow: analysis.action_flow,
    turning_point: analysis.turning_point?.trim() || "不明",
    result: analysis.result?.trim() || "申込",
    days_to_apply: typeof analysis.days_to_apply === "number" ? analysis.days_to_apply : computedDays,
    key_success_factors: successFactors,
  };
  const content = JSON.stringify(caseFlow, null, 2);

  // embedding はケース検索キー（プロフィール + 転換点の状況 + 成功要因）で生成する
  const searchKey = `${caseFlow.customer_profile} ${caseFlow.situation_at_key_moment} ${successFactors.join(" ")}`.trim();
  const embedding = await generateEmbedding(searchKey).catch(() => null);
  const { error: kErr } = await supabase.from("ai_reply_knowledge").insert({
    category: "applying_pattern",
    title: `申込ケース: ${profile.slice(0, 40)}`.slice(0, 100),
    content,
    importance: 9,
    conversation_state: "applying",
    personality_tags: profile,
    ...(embedding ? { embedding: JSON.stringify(embedding) } : {}),
  });
  if (kErr) {
    // 保存失敗 → learned_at は更新しない（次回再試行）
    return { learned: false, error: `ai_reply_knowledge insert失敗: ${kErr.message}` };
  }

  // 5. ☆つき例を「特に重要な成功例」として application_success=true でマーク（失敗しても学習成功扱い）
  const starredIds = examples.filter((e) => e.is_starred).map((e) => e.id);
  if (starredIds.length > 0) {
    const { error: flagErr } = await supabase
      .from("ai_reply_examples")
      .update({ application_success: true })
      .in("id", starredIds);
    if (flagErr) console.warn("[analyze-applying] application_success更新失敗:", flagErr.message);
  }

  // 6. 学習完了 → learned_at を記録（冪等ガード）
  const { error: doneErr } = await supabase
    .from("conversations")
    .update({ learned_at: new Date().toISOString() })
    .eq("id", conv.id);
  if (doneErr) console.warn("[analyze-applying] learned_at更新失敗:", doneErr.message);

  return { learned: true };
}

export async function POST(req: NextRequest) {
  const authError = checkAuth(req);
  if (authError) return authError;

  const runLogId = await startCronLog("analyze-applying");
  try {
    // 処理対象: 申込段階の status かつ learned_at 未設定の会話
    const { data: convs, error: convErr } = await supabase
      .from("conversations")
      .select("id, customer_name, status")
      .in("status", APPLYING_STATUSES)
      .is("learned_at", null)
      .order("updated_at", { ascending: false })
      .limit(50);
    if (convErr) {
      await finishCronLog(runLogId, false, undefined, convErr.message);
      return NextResponse.json({ ok: false, error: convErr.message }, { status: 500 });
    }

    const pending = (convs ?? []) as Array<{ id: string; customer_name: string | null; status: string }>;
    const targets = pending.slice(0, MAX_PER_RUN);

    let learned = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const conv of targets) {
      try {
        const result = await learnFromConversation(conv);
        if (result.learned) learned += 1;
        else if (result.skipped) skipped += 1;
        else {
          failed += 1;
          if (result.error) errors.push(`${conv.id}: ${result.error}`);
        }
      } catch (e) {
        // フェイルオープン: 1会話の失敗は他の会話の処理を止めない（learned_at 未更新 → 次回再試行）
        failed += 1;
        errors.push(`${conv.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const summary = {
      candidates: pending.length,
      learned,
      skipped,
      failed,
      deferred: Math.max(0, pending.length - targets.length), // 次回実行に持ち越し
    };
    await finishCronLog(runLogId, true, { ...summary, errors: errors.slice(0, 5) });
    return NextResponse.json({ ok: true, ...summary, errors: errors.slice(0, 5) });
  } catch (e) {
    console.error("[analyze-applying]", e);
    await finishCronLog(runLogId, false, undefined, e instanceof Error ? e.message : String(e));
    return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}

// GET: Vercel Cron は GET でリクエストするため、認証チェック後 POST へ委譲
export async function GET(req: NextRequest) {
  const authError = checkAuth(req);
  if (authError) return authError;
  return POST(req);
}
