import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { generateEmbedding } from "@/app/lib/knowledge-utils";
import { startCronLog, finishCronLog } from "@/app/lib/cron-logger";
import { extractSelfInitiatedSends } from "@/app/lib/brain-core";
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

// 会話全文を「[顧客] / [AIX:種別] / [スタッフ] テキスト」形式にフォーマット（各200字・合計8000字上限）
// is_aix_generated=true かつ aix_type あり → [AIX:estimate_sheet] 等の確定ラベル
// is_aix_generated=true かつ aix_type なし → [AIX]（種別不明）
// 上限超過時は先頭3000字（問い合わせの文脈）+ 末尾5000字（申込直前の転換点）を残す
function formatMessages(msgs: Array<{ sender: string; text: string; is_aix_generated?: boolean | null; aix_type?: string | null }>): string {
  const full = msgs
    .map((m) => {
      let label: string;
      if (m.sender === "customer") {
        label = "顧客";
      } else if (m.is_aix_generated) {
        label = m.aix_type ? `AIX:${m.aix_type}` : "AIX";
      } else {
        label = "スタッフ";
      }
      return `[${label}] ${(m.text || "").slice(0, 200)}`;
    })
    .join("\n");
  if (full.length <= 8000) return full;
  return `${full.slice(0, 3000)}\n...(中略)...\n${full.slice(-5000)}`;
}

// 申込ケース分析の静的指示ブロック（cache_control でキャッシュ。動的データは user に分離）
const ANALYZE_APPLYING_SYSTEM = `以下の申込到達会話から成功ケースを構造化してください。

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
  ・AIXボタンで複数物件ピックアップ送付後、顧客返信を待たずに「物件ピックアップ紹介（後続）」「駅周辺物件ピックアップ（後続）」等で顧客名・条件を差し込んだ追撃を送った（[AIX]行の直後に[スタッフ]行が続くパターン・中央値1分20秒・14件中10件が2分以内）
  ・AIXで1件詳細を紹介した直後、顧客返信を待たずに「1件特にオススメ」相当の文で1件に絞り申込・内覧を促した（実測1分22秒・原文コピペではなく全面リライトが実態）
  ・AIXで送った物件が全件即入居可能な場合に「審査通過次第ご入居可能」の一括保証を自発送信した（AIXが残す唯一の不安＝いつ入れるか を潰す動作。実測8分56秒→顧客が2分45秒で物件確定）
  ・AIXで見積書を送付した直後（同分〜1分以内）、顧客返信を待たずに「申込誘導」テンプレートで「最大限割引させていただいたお見積書。ご費用面お気に召されましたらお申込みさせていただきます」と促した（見積書→申込誘導→申込の3ステップが成約最短ルート・顧客が2分で申込した実績あり）
  ・「確認します」等の受付宣言後、顧客の返信がないまま8〜136分後（＝管理会社確認等の実作業時間）にAIXクラスターを起動して成果物を配達した（逆方向パターン・成約リードタイムの実体。宣言→調査→配達の流れをstaff_actionとして必ず記録する）

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
  ※ template_send として記録すべき典型ケース（上記【自発送信（機械抽出済みの確定リスト）】と突き合わせて分類する）:
    A. 物件ピックアップ（複数件）のAIX送信後38秒〜1分33秒、顧客返信ゼロ → 「物件ピックアップ紹介（後続）」／駅指定なら「駅周辺物件ピックアップ（後続）」（顧客名＋条件スロットをAI最適化で意味置換）
    B. 見積書AIXメッセージの33秒〜1分06秒後、顧客返信ゼロ → 「【申込誘導】」（物件名・号室を文中に溶かす）
    C. application_push で①申込時フォーマット本体を送った直後 +32秒〜4分48秒 → 「②申込時フォーマット（続き）」をセット送信（一字一句そのまま送る定型追撃・AI最適化禁止）。★トリガーは顧客の申込意思表示ではなく「①を送ったこと」そのもの（意思表示は数時間前にあることが多く、それをトリガーと誤読しないこと）
    D. 条件ヒアリングAIXの+1分17秒後、顧客返信ゼロ → 「ヒアリング締め」系追撃（「上記お部屋探しフォーマットお送りいただけましたら…」）
    E. property_check_result で2番手申込が可能と判明 → +1分29秒で「（2番手・申込）」（顧客名の置換のみ）。AIXが別物件の話をしていても社内進捗を差し込んで関心を戻す動作
    F. 該当テンプレが無い完全カスタム型（申込完了の進捗報告／見積送付の報告／即入居可の一括保証）も自発送信として記録する。14件中5件がこれで、テンプレ化候補として価値が高い
  ※ テンプレ骨格との一致（「オススメ出来るお部屋」「お申込し抑えさせて頂きます」「ご査収ください」等の定型句）が判定材料
  ※ is_aix_generated=trueのAIX本体メッセージ自体（物件画像・見積書等）はtemplate_sendではない
  ※ 顧客返信後のレスポンスもtemplate_sendではない（「顧客返信なし＝自発送信」が本質条件）
  ※ viewing_invite / meeting_place（内見日程・待ち合わせ確定）の直後には追撃を送らないのが正解パターン（自発送信14件中0件）。ここにtemplate_sendを捏造しないこと
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

async function callSonnet(systemPrompt: string, userPrompt: string): Promise<ApplyingAnalysis | null> {
  try {
    const res = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 3000,
      system: [
        { type: "text", text: systemPrompt, cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      messages: [{ role: "user", content: userPrompt }],
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

// ── テンプレート成約実績（won_count）の集計 ─────────────────────────────────
// closed_won 会話の自発送信メッセージ（is_aix_generated=false のスタッフ送信）と
// templates.text を突き合わせ、マッチしたテンプレートの won_count を +1 する。
// マッチ条件（空白・改行を除去した正規化文字列で比較）:
//   1) 完全マッチ: テンプレート本文の先頭30文字がスタッフ送信文に含まれる
//   2) 部分一致: テンプレート本文の連続50文字（10文字刻みの窓）がスタッフ送信文に含まれる
//      → 先頭に「〇〇さん」等のプレースホルダーがあり顧客名に置換されたケースを拾う
// 冪等性: learnFromConversation の学習成功後（learned_at 更新の直前）にのみ呼ばれるため
// 会話あたり最大1回。同一会話内で複数メッセージにマッチしても1テンプレート+1のみ（1成約=1カウント）。
function normalizeForTemplateMatch(s: string): string {
  return (s || "").replace(/\s+/g, "");
}

async function countTemplateWins(
  convId: string,
  msgs: Array<{ sender: string; text: string; is_aix_generated: boolean | null }>
): Promise<void> {
  // スタッフの自発送信候補: 顧客以外（=スタッフ）かつ AIX自動送信でないメッセージ
  // （staff 判定は既存コードの慣例 sender !== "customer" に合わせる）
  const staffSends = msgs
    .filter((m) => m.sender !== "customer" && m.is_aix_generated !== true)
    .map((m) => normalizeForTemplateMatch(m.text))
    .filter((t) => t.length >= 30);
  if (staffSends.length === 0) return;

  const { data: tmplRows, error: tmplErr } = await supabase
    .from("templates")
    .select("id, label, text, won_count");
  if (tmplErr) {
    console.warn(`[analyze-applying] won_count集計: templates取得失敗 (${convId}):`, tmplErr.message);
    return;
  }
  const templates = (tmplRows ?? []) as Array<{
    id: string; label: string | null; text: string | null; won_count: number | null;
  }>;

  for (const tmpl of templates) {
    const norm = normalizeForTemplateMatch(tmpl.text ?? "");
    if (norm.length < 30) continue; // 短すぎるテンプレは誤マッチ源になるため対象外

    // 1) 完全マッチ: テンプレ本文の先頭30文字がスタッフ送信文に含まれる
    const head = norm.slice(0, 30);
    let matched = staffSends.some((s) => s.includes(head));

    // 2) 部分一致: テンプレ本文の連続50文字がスタッフ送信文に含まれる（10文字刻みでスライド）
    if (!matched && norm.length >= 50) {
      outer:
      for (const s of staffSends) {
        for (let i = 0; i + 50 <= norm.length; i += 10) {
          if (s.includes(norm.slice(i, i + 50))) { matched = true; break outer; }
        }
      }
    }
    if (!matched) continue;

    const { error: updErr } = await supabase
      .from("templates")
      .update({ won_count: (tmpl.won_count ?? 0) + 1 })
      .eq("id", tmpl.id);
    if (updErr) console.warn(`[analyze-applying] won_count更新失敗 (template=${tmpl.label}):`, updErr.message);
    else console.log(`[analyze-applying] won_count +1: 「${tmpl.label}」(会話 ${convId})`);
  }
}

type ConvResult = { learned: boolean; skipped?: string; error?: string };

// 1会話分の学習処理。成功（または学習対象外としてスキップ確定）時のみ learned_at を更新する。
async function learnFromConversation(conv: { id: string; customer_name: string | null; status: string }): Promise<ConvResult> {
  // 1. 会話の全メッセージ（[画像]は一旦残す。AIX画像送信はプレースホルダとして学習に使う）
  const { data: msgRows, error: msgErr } = await supabase
    .from("messages")
    .select("sender, text, created_at, is_aix_generated, line_message_id")
    .eq("conversation_id", conv.id)
    .neq("text", "[動画]")
    .not("text", "is", null)
    .order("created_at", { ascending: true });
  if (msgErr) return { learned: false, error: `messages取得失敗: ${msgErr.message}` };
  const rawMsgs = (msgRows ?? []) as Array<{ sender: string; text: string; created_at: string | null; is_aix_generated: boolean | null; line_message_id: string | null }>;

  // AIX画像送信（is_aix_generated=true の [画像]）は [AIX画像送信] に変換して残す
  // 一般スタッフ・顧客の画像（is_aix_generated=false の [画像]）は除外
  const msgs = rawMsgs
    .filter((m) => !(m.text === "[画像]" && m.is_aix_generated !== true))
    .map((m) => ({
      ...m,
      text: (m.is_aix_generated && m.text === "[画像]") ? "[AIX画像送信]" : m.text,
    }));

  // aix_usage_logs からAIXボタン種別を確定（LLM推測ではなく記録値を使う）
  const { data: aixLogRows } = await supabase
    .from("aix_usage_logs")
    .select("aix_type, line_message_id, created_at")
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: false })
    .limit(50);
  const aixLogs = (aixLogRows ?? []) as Array<{ aix_type: string | null; line_message_id: string | null; created_at: string }>;

  // line_message_id 完全一致でAIXタイプを確定。lmidなし時は ±3分 fuzzy マッチ
  const aixTypeByLmid = new Map<string, string>();
  for (const l of aixLogs) {
    if (l.line_message_id && l.aix_type) aixTypeByLmid.set(l.line_message_id, l.aix_type);
  }
  const aixLogsNoLmid = aixLogs.filter((l) => !l.line_message_id && l.aix_type);

  const msgsWithAixType = msgs.map((m) => {
    if (!m.is_aix_generated) return { ...m, aix_type: null as string | null };
    const exact = m.line_message_id ? aixTypeByLmid.get(m.line_message_id) : undefined;
    const fuzzy = !exact
      ? (aixLogsNoLmid.find((l) =>
          m.created_at
            ? Math.abs(new Date(l.created_at).getTime() - new Date(m.created_at!).getTime()) < 3 * 60 * 1000
            : false
        )?.aix_type ?? undefined)
      : undefined;
    return { ...m, aix_type: (exact ?? fuzzy ?? null) as string | null };
  });

  // 会話が短すぎる場合は学習価値なし → learned_at を付けて確定スキップ（無限再試行防止）
  if (msgs.length < 3) {
    await supabase.from("conversations").update({ learned_at: new Date().toISOString() }).eq("id", conv.id);
    return { learned: false, skipped: "too_few_messages" };
  }

  // 旧世代自動返信会話の除外（カレン・はるか型）:
  // staff返信が顧客送信の10秒以内（実例: 6〜8秒）に返るループで、全メッセージ is_aix_generated=false。
  // 「確認して明日までにご報告します」等の汎用文の機械応答であり、成功パターンの学習母集団に混ぜると
  // ノイズになるため会話ごと確定スキップする（learned_at を付けて再試行しない）。
  const hasAixMessage = msgs.some((m) => m.is_aix_generated === true);
  if (!hasAixMessage) {
    let staffReplies = 0;
    let rapidReplies = 0;
    for (let i = 1; i < msgs.length; i++) {
      const cur = msgs[i];
      const prev = msgs[i - 1];
      if (cur.sender !== "customer" && prev.sender === "customer" && cur.created_at && prev.created_at) {
        staffReplies += 1;
        const gapMs = new Date(cur.created_at).getTime() - new Date(prev.created_at).getTime();
        if (gapMs >= 0 && gapMs <= 10_000) rapidReplies += 1;
      }
    }
    // 顧客→staff の応答が3回以上あり、その半数以上が10秒以内 → 旧世代自動返信ループと判定
    if (staffReplies >= 3 && rapidReplies / staffReplies >= 0.5) {
      await supabase.from("conversations").update({ learned_at: new Date().toISOString() }).eq("id", conv.id);
      return { learned: false, skipped: "legacy_auto_reply_loop" };
    }
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

  // 自発送信（AIX直後・顧客返信ゼロでスタッフが手で足した締めの1通）を is_aix_generated から機械抽出。
  // LLMに推測させず確定リストとして渡すことで template_send の付け漏れ／誤付与を防ぐ。
  const selfSends = extractSelfInitiatedSends(msgs);
  const selfSendsText =
    selfSends.length > 0
      ? selfSends
          .map(
            (s, i) =>
              `${i + 1}. [直前AIXの${s.seconds_after_aix !== null ? `${s.seconds_after_aix}秒後` : "直後"}]\n` +
              `   直前のAIX本文: ${s.aix_source_text}\n` +
              `   自発送信された本文: ${(s.text || "").slice(0, 200)}`
          )
          .join("\n")
          .slice(0, 3000)
      : "（この会話では自発送信は検出されませんでした）";

  // 3. Sonnet で成功ケースをケースフロー形式に構造化（動的データのみ user に渡す）
  const userPrompt = `以下は問い合わせから申込到達（status=${conv.status}）まで進んだ実際の会話です
（お客様名: ${conv.customer_name ?? "不明"}）。
この会話で送られた返信はすべて「申込まで導くことに成功した返信」です。

【会話全文】
${formatMessages(msgsWithAixType)}

【自発送信（機械抽出済みの確定リスト・推測禁止）】
以下は is_aix_generated の切り替わりから決定論的に抽出した「AIXボタン押下後、顧客の返信を待たずに
スタッフが手で送った締めの1通」です。判定ロジックは「顧客メッセージで区切ったスタッフ連続ブロック内で、
最後の[AIX]メッセージより後にある[スタッフ]メッセージ」。
・ここに挙がっている送信は必ず action_flow のステップとして記録し、aix_button="template_send" を付けること。
・ここに無いステップに aix_button="template_send" を付けないこと（推測で増やさない）。
・「直前のAIX本文」を読んでどのAIXボタンへの追撃かを判断し、staff_action に「AIXで〇〇を送った直後、
  顧客返信を待たずに△△を送った」という形で必ず経過時間つきで記録すること。
${selfSendsText}

【会話期間】
${firstAt && lastAt ? `${firstAt} 〜 ${lastAt}（約${computedDays}日間）` : "不明"}

【スタッフが送った返信一覧（フェーズ付き）】
${sentSummary || "（返信記録なし）"}`;

  const analysis = await callSonnet(ANALYZE_APPLYING_SYSTEM, userPrompt);
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

  // 5.5 closed_won（成約）会話のみ: 自発送信メッセージとテンプレート本文を突き合わせて
  // won_count（成約実績）を集計。learned_at 更新の直前に置くことで会話あたり最大1回を保証
  // （Sonnet失敗時の再試行では learned_at 未更新のままここに到達しないため二重カウントしない）。
  // 集計失敗しても学習成功扱い（フェイルオープン）。
  if (conv.status === "closed_won") {
    try {
      await countTemplateWins(conv.id, msgs);
    } catch (e) {
      console.warn("[analyze-applying] won_count集計失敗:", e instanceof Error ? e.message : String(e));
    }
  }

  // 6. 学習完了 → learned_at を記録（冪等ガード）
  // 更新失敗時は learned: false を返して次回再処理させる（learned: true を返すと重複学習になる）
  const { error: doneErr } = await supabase
    .from("conversations")
    .update({ learned_at: new Date().toISOString() })
    .eq("id", conv.id);
  if (doneErr) {
    console.warn("[analyze-applying] learned_at更新失敗:", doneErr.message);
    return { learned: false, error: `learned_at更新失敗: ${doneErr.message}` };
  }

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
