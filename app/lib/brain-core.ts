import Anthropic from "@anthropic-ai/sdk";
import { after } from "next/server";
import { supabase } from "@/app/lib/supabase";

// ── brain-core: 脳分析の単一実装（single writer）─────────────────────────────
// これまで brain/list と cron/brain-weekly に約250行が copy-paste され、
// 線引きルールのヒューリスティック等が乖離していた。本モジュールが唯一の実装。
//
// 呼び出し元:
//   - line-webhook: 顧客メッセージ受信時（suggested_aix_meta を null に消すのと同じ場所で
//     after() から analyzeAndSaveBrainMeta を fire-and-forget 起動 = イベント駆動再計算）
//   - cron/brain-sweep: webhook の分析が失敗した会話を拾うバックストップ（5分毎）
//   - brain/list は純粋な read のみ（Haiku は一切呼ばない）

const HAIKU = "claude-haiku-4-5-20251001";
// B8(Fable5): maxRetries: 0 — sweep自体がリトライ機構のため、SDKの自動リトライ（デフォルト2回）は
// 最悪 ~45秒/件 × 4件直列 = maxDuration 120秒超過 → cron_run_logs が "running" のまま残る事故の原因だった
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 15_000, maxRetries: 0 });

// Statuses that indicate a closed/inactive conversation — excluded from brain analysis
export const BRAIN_SKIP_STATUSES = ["contract", "closed_won", "closed_lost", "lost"];

// Conversations updated within this window are flagged as urgent
export const URGENT_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

export type SuggestedAixMeta = {
  action: string;
  note: string;
  source: string;
  enforcement_level: "required" | "recommended";
  closing_strategy?: string;
  template_hint?: string;
  next_steps?: string[];  // ["今日: 内覧日調整", "内覧後: 見積書送付", "来週: 申込プッシュ"]
  reply_mode?: "aix" | "auto_reply";  // 'aix'=スタッフがAIXで手動対応 / 'auto_reply'=AI自動返信OK
  // Chrome拡張フィードバックループ用: 拡張が brain/list API 経由で取得し検索フォームに自動入力する
  property_search_params?: {
    area: string | null;
    floor_plan: string | null;
    rent_max: number | null;
    walk_minutes: number | null;
    move_in_time: string | null;
    preferences: string | null;
    ng_points: string | null;
    ng_properties: Array<{ property_name: string; room_no: string }>;
    search_urgency: string; // "★★★" | "★★" | "★" | "─"
  } | null;
} | null;

// Canonical mapping from AIX action key → staff guidance note
// Keys must match AIX_ACTION_META keys in page.tsx
const AIX_BRAIN_NOTES: Record<string, string> = {
  viewing_invite:          "内覧日程の候補を提示してください → AIX【内覧日調整】で日時を選択して送信してください",
  property_send:           "物件URLが揃ったら → AIX【物件ピックアップした】でカバーメッセージを生成して一緒に送ってください",
  estimate_sheet:          "見積書が届いたら → AIX【見積書送る】で読み取って自動計算＋カバーメッセージを生成できます",
  application_push:        "AIX【申込へ！】でクロージングメッセージを生成できます",
  condition_hearing:       "AIX【条件ヒアリング】ボタンで既知情報をスキップした形式で送れます",
  acknowledge_check:       "送信後 → AIX【確認します】で管理会社への空室確認＋見積書依頼を送ってください（宛先は管理会社です）",
  followup_revive:         "AIX【追客する】で再接触メッセージを生成できます",
  property_check_result:   "管理会社から返答が来たら → AIX【物件確認した（募集状況）】で結果報告文を生成してください",
  property_recommendation: "お客様の条件に最も合う1件を特にオススメとしてAIX【物件オススメ】で提案してください",
  meeting_place:           "内覧の日時・物件が確定したら → AIX【待ち合わせ】で待ち合わせ場所の案内を送ってください",
  greeting_viewing:        "内覧前後の挨拶は → AIX【内覧挨拶】でシーンに合わせた挨拶メッセージを生成できます",
  // ※ STATUS_MEANING にも会話ステータスとして property_search が存在するが、これは意図的な同名
  //   （ステータス=条件ヒアリング段階 / アクション=拡張ツールでの物件検索実行）。混同注意。
  //   このキーを提案として活かすには page.tsx の AIX_ACTION_META にも同キーの追加が必要（TODO）。
  property_search:         "お客さんの条件に合う物件をChrome拡張ツール（リアプロ/itandi/レインズ）で検索してください。送付済み物件は候補から除外すること",
};

// Maps raw DB conversation status to a Japanese meaning string injected into the Haiku prompt
const STATUS_MEANING: Record<string, string> = {
  first_reply:             "完全初回（はじめてのお客様・挨拶必須）",
  hearing:                 "条件ヒアリング段階（物件未提案・条件確認中）",
  condition_hearing:       "条件ヒアリング段階（物件未提案・条件確認中）",
  property_search:         "条件ヒアリング段階（物件未提案・条件確認中）",
  proposing:               "物件提案中（物件を送った後・内覧調整段階）",
  property_recommendation: "物件提案中（物件を送った後・内覧調整段階）",
  viewing:                 "物件提案中（内覧調整段階）",
  estimate_request:        "物件提案中（見積書依頼段階）",
  availability_check:      "物件提案中（空室確認段階）",
  applying:                "申込・審査中（クロージング段階）",
  application:             "申込・審査中（申込書類収集段階）",
  screening:               "申込・審査中（審査進行中）",
  contract:                "契約済み（成約完了）",
};

// Concise AIX capability summary injected into Haiku prompts for action/template reasoning
const AIX_CAPABILITY_MAP = `
【AIXボタン能力マップ】
- viewing_invite: 内覧日程の候補をLINEで提案するメッセージを生成
- property_send: 物件ピックアップのカバーメッセージを生成（物件URL送信時）
- estimate_sheet: 見積書を読み取り自動計算+カバーメッセージ生成
- application_push: 申込クロージングメッセージを生成
- condition_hearing: 既知条件をスキップした条件ヒアリングを生成
- acknowledge_check: 管理会社への空室確認+見積書依頼を生成
- followup_revive: 追客・再接触メッセージを生成
- property_check_result: 空室確認結果の報告文を生成
- property_recommendation: Vision読み取りで物件紹介文を生成（1件詳細）
- meeting_place: 内覧の待ち合わせ場所案内を生成
- greeting_viewing: 内覧前後の挨拶メッセージを生成
- property_search: お客さんの条件に合う物件を拡張ツールで検索する（適用条件: 最終物件送付から7日以上経過、または送付件数0件。next_steps例:「リアプロ/itandiでエリア×間取りを検索」「家賃上限以下・駅徒歩条件で絞り込み」「検索結果から送付済み物件を除いて候補をピックアップ」）
`.trim();

// ① 成約・申込到達ステータス（brainが成功事例として読む対象）
// applying は line-webhook が申込フォーム検知で自動セットする機械検証済みシグナル。
// application/screening/contract は旧データの後方互換エイリアス（auto-seiyaku と同一集合 + closed_won）
const SUCCESS_EXAMPLE_STATUSES = ["closed_won", "applying", "application", "screening", "contract"];

// ── フェーズ検出ヘルパー ─────────────────────────────────────────────────────
// brain分析結果（SuggestedAixMeta）の各フィールドから現在フェーズを推定する。
// conversation_direction の current_phase 更新判定に使用する。
function detectPhaseFromBrainMeta(meta: Record<string, unknown>): "hearing" | "proposing" | "viewing" | "applying" {
  const txt = [meta.action, meta.closing_strategy, meta.next_steps].filter(Boolean).join(" ");
  if (/申込|審査/.test(txt)) return "applying";
  if (/内覧|内見/.test(txt)) return "viewing";
  if (/提案|物件/.test(txt)) return "proposing";
  return "hearing";
}

/**
 * Calls Claude Haiku with enriched context (last 15 messages, customer conditions,
 * conversation status) and returns a SuggestedAixMeta to cache in conversations.
 *
 * `source` はこの分析の呼び出し経路（"brain" = イベント駆動/sweep）。
 * 品質ゲートは自分自身の経路の採択率（SOURCE_ACCEPT_RATE:{action}:{source}）を読む。
 * （旧実装は analysis_step1 という他コンポーネントのキーを読んでいたバグがあった）
 */
export async function analyzeConversation(
  conversationId: string,
  isUrgent: boolean,
  convStatus: string | null,
  propertyCustomerId: string | null,
  source: string = "brain",
  // B2/H6(Fable5): 呼び出し元（analyzeAndSaveBrainMeta）が conversations から取得したフラグ。
  // auto_send_enabled=false の会話に auto_reply を提案しない・is_flagged はスタッフ要対応なので aix 強制
  opts?: { autoSendEnabled?: boolean; isHot?: boolean; isFlagged?: boolean },
): Promise<SuggestedAixMeta> {
  // Fetch last 30 messages and customer conditions in parallel
  // H5(Fable5): limit 15→30 — 会話あたりメッセージ数の中央値は25件。checkpoints が0行（書き込み側未実装）の間、
  // limit 15 だと中央値会話の前半を完全に忘れるため引き上げ。count: "exact" は総メッセージ数のプロンプト注入用（B3）
  const [msgResult, pcResult, examplesResult, checkpointsResult, sentPropsResult, promptRulesResult, knowledgePrinciplesResult, templatesResult, boundaryPromptRulesResult, boundaryTriggerRulesResult, contractKnowledgeResult, contractExamplesResult, aixLogsResult, scheduledMsgsResult, openTasksResult, viewingsResult] = await Promise.all([
    supabase
      .from("messages")
      .select("sender, text, created_at, line_message_id, is_aix_generated", { count: "exact" })
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(30),
    propertyCustomerId
      ? supabase
          .from("property_customers")
          .select("desired_area, floor_plan, rent_min, rent_max, move_in_time, preferences, ng_points, walk_minutes, last_property_sent_at, property_send_count")
          .eq("id", propertyCustomerId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // Recent starred reply examples for this conversation (context for Haiku)
    supabase
      .from("ai_reply_examples")
      .select("sent_reply, is_starred")
      .eq("conversation_id", conversationId)
      .eq("is_starred", true)
      .order("created_at", { ascending: false })
      .limit(3),
    // Latest 2 checkpoints for long-conversation context
    supabase
      .from("conversation_checkpoints")
      .select("checkpoint_index, summary, key_facts, conversation_stage")
      .eq("conversation_id", conversationId)
      .order("checkpoint_index", { ascending: false })
      .limit(2),
    // Sent properties for this customer (duplicate/history awareness)
    propertyCustomerId
      ? supabase
          .from("sent_properties")
          .select("property_name, room_no, sent_at")
          .eq("property_customer_id", propertyCustomerId)
          .order("sent_at", { ascending: false })
          .limit(10)
      : Promise.resolve({ data: null }),
    // Global permanent operator rules (apply to all conversations, no pgvector needed)
    // B4(Fable5): limit 10→20 — 本番で恒久ルールがちょうど10行に達しており、11個目から無言欠落する状態だった
    supabase
      .from("ai_prompt_rules")
      .select("rule_text, priority")
      .eq("is_active", true)
      .eq("is_permanent", true)
      .is("action_type", null)
      .order("priority", { ascending: false })
      .limit(20),
    // Confirmed top-importance principles (importance >= 9, no pgvector needed)
    // B11(Fable5): .neq は NULL 行を除外する（SQL <> セマンティクス）→ .or で NULL 許容に。
    // created_at 降順タイブレークで同 importance 内の選抜を決定的にする
    supabase
      .from("ai_reply_knowledge")
      .select("content, importance")
      .eq("category", "principle")
      .gte("importance", 9)
      .or("hypothesis_status.is.null,hypothesis_status.neq.rejected")
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(3),
    // Top templates by win_rate for context (brain uses these to recommend best template)
    // B1(Fable5): 旧 .like("category", "AIX%") は前方一致で、実カテゴリ「見積書送る【AIX】」等に
    // 一度もマッチしていなかった（本番0件を実測確認 = このデータソースは死んでいた）。
    // use_count>=3 で「1回使用でwin_rate 100%」の統計ノイズを排除、nullsFirst:false でNULL win_rateを後ろへ
    supabase
      .from("templates")
      .select("category, label, win_rate, use_count")
      .like("category", "%【AIX】%")
      .gte("use_count", 3)
      .order("win_rate", { ascending: false, nullsFirst: false })
      .limit(5),
    // 線引きルール: BOUNDARY-* rules that define when to use AIX vs auto-reply
    // B4(Fable5): limit 15→40 — 本番に31行あり、旧limitでは線引きルールの半分以上が無言欠落していた。
    // 線引きルールは reply_mode（aix/auto_reply）判定の根幹のため全件注入する
    supabase
      .from("ai_prompt_rules")
      .select("rule_key, action_type, rule_text")
      .like("rule_key", "BOUNDARY-%")
      .eq("is_active", true)
      .order("priority", { ascending: false })
      .limit(40),
    supabase
      .from("trigger_action_rules")
      .select("keyword, action_type, rule_text")
      .like("keyword", "BOUNDARY%")
      .gte("confidence", 0.5)
      .limit(10),
    // 成約パターン（distilled）: notify-viewing / analyze-closed-conversation が書く高価値ナレッジ
    // （既存の principle クエリは category='principle' のみで、これら pattern 行は拾えない）
    supabase
      .from("ai_reply_knowledge")
      .select("title, content, importance")
      .eq("category", "pattern")
      // B11(Fable5): NULL 許容（.neq は hypothesis_status IS NULL の行を除外してしまう）
      .or("hypothesis_status.is.null,hypothesis_status.neq.rejected")
      .or("title.ilike.成約パターン%,title.ilike.[成約分析]%,title.ilike.[転換点]%")
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(4),
    // 成約・申込到達の会話の実際の優良返信（success × starred × line_reply）
    // FK: ai_reply_examples.conversation_id → conversations.id（migrate-schema L681）で inner join
    supabase
      .from("ai_reply_examples")
      .select("sent_reply, conversation_state, conversations!inner(status)")
      .in("conversations.status", SUCCESS_EXAMPLE_STATUSES)
      .eq("is_starred", true)
      .eq("entry_source", "line_reply")
      .not("sent_reply", "is", null)
      .order("created_at", { ascending: false })
      .limit(8),
    // ② この会話で使われたAIXアクション履歴（メッセージ単位の厳密ラベル用）
    supabase
      .from("aix_usage_logs")
      .select("aix_type, line_message_id, sent_at, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(30),
    // H6(Fable5): 予約送信済みメッセージ（pending）— 追客提案が予約済み送信と重複するのを防ぐ
    supabase
      .from("scheduled_messages")
      .select("text, scheduled_at")
      .eq("conversation_id", conversationId)
      .eq("status", "pending")
      .order("scheduled_at", { ascending: true })
      .limit(5),
    // H6(Fable5): この会話の未完了タスク — next_steps を実際の保留作業に接地させる
    supabase
      .from("line_tasks")
      .select("task_type, created_at")
      .eq("conversation_id", conversationId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(5),
    // H6(Fable5): 内覧予定/完了 — 次アクション判断の核となるシグナル
    supabase
      .from("viewings")
      .select("viewing_date, viewing_time, status")
      .eq("conversation_id", conversationId)
      .order("viewing_date", { ascending: false })
      .limit(3),
  ]);

  const { data: messages, error, count: totalMessageCount } = msgResult;
  if (error || !messages || messages.length === 0) return null;
  // H5(Fable5): 全メッセージが画像/添付のみ（テキスト0件）の場合は分析しない。
  // 「（画像/添付）×N」だけを読んだHaikuの当てずっぽう提案がキャッシュされるのを防ぐ
  if (messages.every((m) => !m.text)) return null;

  // AIXアクションのメッセージ単位ラベル解決
  // 1) line_message_id 完全一致（P4以降のログ・直近30日で97%カバー）
  // 2) 旧ログ fallback: is_aix_generated=true × sent_at ±3分
  type AixLog = { aix_type: string | null; line_message_id: string | null; sent_at: string | null; created_at: string };
  const aixLogs = (aixLogsResult.data ?? []) as AixLog[];
  const aixTypeByLmid = new Map<string, string>();
  for (const l of aixLogs) {
    if (l.line_message_id && l.aix_type) aixTypeByLmid.set(l.line_message_id, l.aix_type);
  }
  const aixLogsNoLmid = aixLogs.filter((l) => !l.line_message_id && l.aix_type);

  // Reverse so the history reads oldest → newest
  // B3(Fable5): 各行に日付（M/D）を付与 — 旧実装は created_at を取得しながらプロンプトから捨てており、
  // Haiku が「5分前の返信」と「12日間沈黙」を区別できず followup_revive 判断が原理的に不可能だった
  const typedMessages = messages as Array<{ sender: string; text: string | null; created_at: string; line_message_id: string | null; is_aix_generated: boolean | null }>;
  const history = [...typedMessages]
    .reverse()
    .map((m) => {
      let senderLabel = "顧客";
      if (m.sender === "staff") {
        const exact = m.line_message_id ? aixTypeByLmid.get(m.line_message_id) : undefined;
        const fuzzy = (!exact && m.is_aix_generated)
          ? aixLogsNoLmid.find((l) => Math.abs(new Date(l.sent_at ?? l.created_at).getTime() - new Date(m.created_at).getTime()) < 3 * 60 * 1000)?.aix_type
          : undefined;
        const aixType = exact ?? fuzzy;
        senderLabel = aixType ? `AIX:${aixType}` : (m.is_aix_generated ? "AIX" : "スタッフ");
      }
      const dateLabel = new Date(m.created_at).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", timeZone: "Asia/Tokyo" });
      return `[${senderLabel} ${dateLabel}] ${m.text ?? "（画像/添付）"}`;
    })
    .join("\n");

  // B3(Fable5): 今日の日付・最終顧客メッセージからの経過日数・総メッセージ数をプロンプト冒頭に注入。
  // これが無いと Haiku は経過時間を知り得ず、closing_strategy に架空の日付を創作していた
  const lastCustomerMsg = typedMessages.find((m) => m.sender === "customer"); // messagesは新しい順
  const daysSinceLastCustomerMsg = lastCustomerMsg
    ? Math.floor((Date.now() - new Date(lastCustomerMsg.created_at).getTime()) / 86_400_000)
    : null;
  const todayStr = new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" });
  const timingText = `\n【時間情報】今日: ${todayStr} / 最終顧客メッセージ: ${daysSinceLastCustomerMsg !== null ? `${daysSinceLastCustomerMsg}日前` : "不明"} / 総メッセージ数: ${totalMessageCount ?? typedMessages.length}件（履歴は直近${typedMessages.length}件のみ表示）`;

  // Build customer conditions context
  type PC = { desired_area?: string | null; floor_plan?: string | null; rent_min?: number | null; rent_max?: number | null; move_in_time?: string | null; preferences?: string | null; ng_points?: string | null; walk_minutes?: number | null; last_property_sent_at?: string | null; property_send_count?: number | null } | null;
  const pc = (pcResult.data ?? null) as PC;
  const condParts: string[] = [];
  if (pc?.desired_area) condParts.push(`エリア: ${pc.desired_area}`);
  if (pc?.floor_plan) condParts.push(`間取り: ${pc.floor_plan}`);
  if (pc?.rent_max) condParts.push(`家賃上限: ${Math.floor((pc.rent_max as number) / 10000)}万`);
  if (pc?.walk_minutes) condParts.push(`駅徒歩: ${pc.walk_minutes}分以内`);
  if (pc?.move_in_time) condParts.push(`入居: ${pc.move_in_time}`);
  if (pc?.preferences) condParts.push(`希望: ${pc.preferences}`);
  const condText = condParts.length > 0 ? `\n顧客条件: ${condParts.join(" / ")}` : "";

  const statusMeaning = convStatus && STATUS_MEANING[convStatus] ? STATUS_MEANING[convStatus] : (convStatus ?? "");
  const statusText = convStatus ? `\n現在のステータス: ${statusMeaning}` : "";

  // Recent starred examples (good replies) for this customer
  const examples = (examplesResult.data ?? []) as Array<{ sent_reply: string | null; is_starred: boolean | null }>;
  const examplesText = examples.length > 0
    ? `\n過去のスタッフ優良返信例:\n${examples.map((e) => `- ${e.sent_reply ?? ""}`).join("\n")}`
    : "";

  // Checkpoint summaries for long-conversation context (セーブポイント)
  type Checkpoint = { checkpoint_index: number; summary: string | null; key_facts: string | null; conversation_stage: string | null };
  const checkpoints = ((checkpointsResult.data ?? []) as Checkpoint[]).reverse(); // oldest first
  const checkpointText = checkpoints.length > 0
    ? `\n【過去の会話まとめ（セーブポイント）】\n${checkpoints.map((cp) => `■ ブロック${cp.checkpoint_index}: ${cp.summary ?? ""}${cp.key_facts ? ` / ${cp.key_facts}` : ""}`).join("\n")}`
    : "";

  // Sent properties — what has already been proposed to this customer
  type SentProp = { property_name: string; room_no: string; sent_at: string };
  const sentProps = ((sentPropsResult.data ?? []) as SentProp[]);
  const sentPropsText = sentProps.length > 0
    ? `\n【すでに送付済みの物件（${sentProps.length}件）】\n${sentProps.map((p) => `- ${p.property_name} ${p.room_no}（${new Date(p.sent_at).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })}送付）`).join("\n")}`
    : "";

  // ── 物件検索統括コンテキスト ─────────────────────────────────────────
  // sent_properties + property_customers から「物件検索の全体像」を動的に組み立てて注入する。
  // 脳が property_search / property_send の使い分け（検索すべきか・送付を控えるべきか）を
  // 判断できるようにするための統括ブロック。propertyCustomerId が無い会話ではスキップ。
  //
  // TODO(P2): Chrome拡張フィードバックループ
  //   脳の suggested_aix_meta に property_search_params を追加し、
  //   Chrome拡張が起動時にWebAppのbrain/list APIからこれを取得して
  //   検索フォームに自動入力できるようにする
  //   必要なフィールド: { area, floor_plan, rent_max, walk_minutes, ng_properties: sent_properties }
  //
  // TODO(P2): 物件評価API
  //   /api/evaluate-property POST を新設。候補物件のスペックをbodyで受け取り、
  //   お客さんの条件とsent_propertiesを照合してスコア（0-100）とNG理由を返す
  //   Chrome拡張のscore-overlay.jsがこれを呼んでリアルタイムスコア表示に使う
  //
  // TODO(P3): 物件在庫連携
  //   Chrome拡張がリアプロ/itandi/レインズの検索結果を /api/property-inventory POST で
  //   サーバーに送信し、brain-core.tsがその在庫データを見て「今日オススメできる物件」を
  //   特定してChrome拡張に返す。完全自律物件選定の実現
  let propertySearchText = "";
  if (pc) {
    // sentCount: sent_properties の直近10件クエリ結果（10件で頭打ちのため「以上」表記）
    const sentCount = sentProps.length;
    // daysSinceLastSend: last_property_sent_at 優先、無ければ sent_properties の最新 sent_at
    const lastSentIso = pc.last_property_sent_at ?? sentProps[0]?.sent_at ?? null;
    const daysSinceLastSend = lastSentIso
      ? Math.floor((Date.now() - new Date(lastSentIso).getTime()) / 86_400_000)
      : null;
    // property_send_count = 連続未返信送付数（顧客が反応するとUI側で0にリセットされる）
    const unansweredSendCount = pc.property_send_count ?? 0;
    // 物件検索推奨度（★の数）:
    //   ─   : 連続未返信送付2件以上 → お客さんが反応していない。property_send は控える
    //   ★★★: 7日以上送付なし or 送付0件 → 今すぐ property_search を提案
    //   ★★ : 3-6日 → property_send または property_search を検討
    //   ★  : 3日未満 → 様子見
    let searchPriority: string;
    if (unansweredSendCount >= 2) {
      searchPriority = "─（送付済みがあり返信待ち → property_sendは控える）";
    } else if (daysSinceLastSend === null || daysSinceLastSend >= 7) {
      searchPriority = "★★★（7日以上送付なし → 今すぐproperty_searchを提案）";
    } else if (daysSinceLastSend >= 3) {
      searchPriority = "★★（3-6日 → property_sendまたはproperty_searchを検討）";
    } else {
      searchPriority = "★（3日未満 → 様子見）";
    }
    propertySearchText = `
【物件検索統括】
送付済み件数: ${sentCount}件${sentCount >= 10 ? "以上" : ""}
最終送付: ${daysSinceLastSend !== null ? `${daysSinceLastSend}日前` : "まだ送付なし"}
連続未返信送付: ${unansweredSendCount}件（2件以上 = お客さんが反応していない）
検索条件:
  エリア: ${pc.desired_area ?? "未設定"}
  間取り: ${pc.floor_plan ?? "未設定"}
  家賃上限: ${pc.rent_max ? `${pc.rent_max}円` : "未設定"}
  入居時期: ${pc.move_in_time ?? "未設定"}
  駅徒歩: ${pc.walk_minutes ? `${pc.walk_minutes}分以内` : "未設定"}
  希望条件: ${pc.preferences ?? "未設定"}
物件検索推奨度: ${searchPriority}`;
  }

  type PromptRule = { rule_text: string; priority: number };
  const promptRules = (promptRulesResult.data ?? []) as PromptRule[];
  const promptRulesText = promptRules.length > 0
    ? `\n【絶対ルール（オペレーター設定）】\n${promptRules.map((r) => `- ${r.rule_text}`).join("\n")}`
    : "";

  type KnowledgePrinciple = { content: string; importance: number };
  const knowledgePrinciples = (knowledgePrinciplesResult.data ?? []) as KnowledgePrinciple[];
  const knowledgeText = knowledgePrinciples.length > 0
    ? `\n【重要原則】\n${knowledgePrinciples.map((k) => `- ${k.content}`).join("\n")}`
    : "";

  // Top-performing AIX templates (for template_hint context)
  type TopTemplate = { category: string | null; label: string | null; win_rate: number | null; use_count: number | null };
  const topTemplates = (templatesResult.data ?? []) as TopTemplate[];
  const templatesText = topTemplates.length > 0
    ? `\n【高成約率テンプレート（参考）】\n${topTemplates.map((t) => `- ${t.category}: ${t.label} (成約率: ${((t.win_rate ?? 0) * 100).toFixed(0)}%, ${t.use_count ?? 0}回使用)`).join("\n")}`
    : "";

  // Boundary rules — when AIX is required vs auto-reply is allowed
  type BoundaryRule = { rule_key?: string; keyword?: string; action_type: string | null; rule_text: string };
  const boundaryRulesFromPrompts = (boundaryPromptRulesResult.data ?? []) as BoundaryRule[];
  const boundaryRulesFromTrigger = (boundaryTriggerRulesResult.data ?? []) as BoundaryRule[];
  const allBoundaryRules = [...boundaryRulesFromPrompts, ...boundaryRulesFromTrigger];
  const boundaryText = allBoundaryRules.length > 0
    ? `\n【線引きルール（AIX必須 vs 自動返信OK）】\n${allBoundaryRules.map((r) => {
        const aix = r.action_type && r.action_type !== 'generate_reply' ? `→ AIX: ${r.action_type}` : '→ 自動返信禁止';
        return `- ${r.rule_text} ${aix}`;
      }).join("\n")}`
    : "";

  // ── 成約パターン注入 ─────────────────────────────────────────────
  // 過去に closed_won（成約）に至った会話から学習したパターンと実返信例。
  // データが無ければ空文字（ブロックごとスキップ）。
  type ContractKnowledge = { title: string | null; content: string | null; importance: number | null };
  const contractKnowledge = (contractKnowledgeResult.data ?? []) as ContractKnowledge[];

  type ContractExample = {
    sent_reply: string | null;
    conversation_state: string | null;
    conversations: { status: string | null } | { status: string | null }[] | null;
  };
  // 成約/申込到達の別（[成約]=closed_won / [申込到達]=applying等）をラベル化
  const outcomeOf = (e: ContractExample): string => {
    const st = Array.isArray(e.conversations) ? e.conversations[0]?.status : e.conversations?.status;
    return st === "closed_won" ? "成約" : "申込到達";
  };
  const rawContractExamples = (contractExamplesResult.data ?? []) as ContractExample[];
  // 現在のステータスと同じ段階の返信例を優先し、最大3件・各100字に切り詰め
  const stateMatched = rawContractExamples.filter((e) => e.conversation_state === convStatus);
  const stateOthers = rawContractExamples.filter((e) => e.conversation_state !== convStatus);
  const contractExamples = [...stateMatched, ...stateOthers].slice(0, 3);

  const contractKnowledgeLines = contractKnowledge
    .map((k) => `- ${(k.title ?? "").slice(0, 40)}: ${(k.content ?? "").replace(/\n/g, " ").slice(0, 150)}`)
    .join("\n");
  const contractExampleLines = contractExamples
    .map((e) => `- [${outcomeOf(e)}] (${e.conversation_state ?? "不明"}段階) 「${(e.sent_reply ?? "").replace(/\n/g, " ").slice(0, 100)}」`)
    .join("\n");

  const contractPatternsText = (contractKnowledge.length > 0 || contractExamples.length > 0)
    ? `\n【成約・申込到達パターン（過去に契約/申込に至った会話から学習・参考）】${contractKnowledgeLines ? `\n■ 成功法則・転換点:\n${contractKnowledgeLines}` : ""}${contractExampleLines ? `\n■ 成約した会話の実際の返信例:\n${contractExampleLines}` : ""}\n※現在の会話がこれらのパターンに近い場合、closing_strategy と next_steps は成約パターンの流れに沿って提案すること。`
    : "";

  // この会話で使用済みのAIXアクション一覧（重複提案の抑止・次段階の推奨材料）
  const usedAixTypes = [...new Set(aixLogs.map((l) => l.aix_type).filter((t): t is string => Boolean(t)))];
  const aixHistoryText = usedAixTypes.length > 0
    ? `\n【この会話で使用済みのAIXアクション】${usedAixTypes.join(" / ")}\n※既に使用済みのアクションを再提案する場合は理由が必要。原則は次の段階のアクションを提案すること。`
    : "";

  // H6(Fable5): 予約送信・未完了タスク・内覧予定を注入（重複提案防止・next_steps の接地）
  type ScheduledMsg = { text: string | null; scheduled_at: string };
  const scheduledMsgs = (scheduledMsgsResult.data ?? []) as ScheduledMsg[];
  const scheduledText = scheduledMsgs.length > 0
    ? `\n【予約送信済みメッセージ（送信待ち${scheduledMsgs.length}件）】\n${scheduledMsgs.map((s) => `- ${new Date(s.scheduled_at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" })}送信予定: ${(s.text ?? "（画像）").replace(/\n/g, " ").slice(0, 60)}`).join("\n")}\n※これらと重複する追客・送信提案はしないこと。`
    : "";

  type OpenTask = { task_type: string; created_at: string };
  const openTasks = (openTasksResult.data ?? []) as OpenTask[];
  const taskLabel: Record<string, string> = { property_check: "物件確認（空室確認）", property_send: "物件送付" };
  const tasksText = openTasks.length > 0
    ? `\n【この会話の未完了タスク】${openTasks.map((t) => taskLabel[t.task_type] ?? t.task_type).join(" / ")}\n※next_steps はこれらの未完了タスクを考慮すること。`
    : "";

  type Viewing = { viewing_date: string; viewing_time: string | null; status: string | null };
  const viewings = (viewingsResult.data ?? []) as Viewing[];
  const viewingStatusLabel: Record<string, string> = { scheduled: "予定", done: "完了", cancelled: "キャンセル" };
  const viewingsText = viewings.length > 0
    ? `\n【内覧履歴・予定】${viewings.map((v) => `${v.viewing_date}${v.viewing_time ? ` ${String(v.viewing_time).slice(0, 5)}` : ""}（${viewingStatusLabel[v.status ?? ""] ?? v.status ?? "予定"}）`).join(" / ")}`
    : "";

  // H6(Fable5): ホット顧客・スタッフ要対応フラグ
  const flagParts: string[] = [];
  if (opts?.isHot) flagParts.push("ホット顧客（成約意欲高・プッシュ強めOK）");
  if (opts?.isFlagged) flagParts.push("スタッフ要対応フラグあり（自動返信不可・必ずスタッフ対応）");
  const flagsText = flagParts.length > 0 ? `\n【フラグ】${flagParts.join(" / ")}` : "";

  // H4(Fable5): 会話に依存しない静的ブロック（能力マップ・線引きルール・恒久ルール等）を system に分離し
  // prompt caching（ephemeral）を適用。brain-sweep は5分毎バッチのため入力コストを約40-60%削減できる。
  // ※ contractPatternsText は convStatus 依存の並べ替えがあるため user 側に残す
  const systemText = `あなたはスモラAI。与えられた会話履歴を読んで、スタッフが次にすべき1アクションを20字以内で答えてください。必ずJSON形式のみで返してください。

${AIX_CAPABILITY_MAP}${promptRulesText}${knowledgeText}${boundaryText}${templatesText}

【日付の厳守】closing_strategy・next_steps には会話に実際に出た物件名・日付のみ使用（推測日付の創作禁止）。

回答形式（JSONのみ・説明文・コードブロック不要）:
{"action": "スタッフが次にすべき具体的なアクション（20字以内）", "reason": "その理由（30字以内）", "aix": "上記能力マップのキー1つ、該当なしならnull", "closing_strategy": "この顧客が契約に至るための具体的な戦略を1〜2文で", "template_hint": "このお客さんに合うテンプレートのトーン・スタイルのヒント（20字以内、例：丁寧語・プッシュ弱め）", "next_steps": ["Step1（今すぐ）: 具体的アクション", "Step2（次回）: 具体的アクション", "Step3（その次）: 具体的アクション"], "reply_mode": "aixまたはauto_reply。auto_replyはAIが人の確認なしで送信する。線引きルール該当時・金額/契約/入居日/内覧日程の確定に関わる時・判断に迷う時は必ずaix。雑談や単純な質問への一般返信のみauto_reply"}`;

  const userPrompt = `${statusText}${timingText}${flagsText}${aixHistoryText}${condText}${scheduledText}${tasksText}${viewingsText}${examplesText}${checkpointText}${sentPropsText}${propertySearchText}${contractPatternsText}

会話履歴（[AIX:xxx 日付]=AIXツールxxxで送信済み / [AIX 日付]=AIX送信(種別不明) / [スタッフ 日付]=手動送信 / [顧客 日付]=顧客メッセージ）:
${history}`;

  try {
    const response = await client.messages.create({
      model: HAIKU,
      max_tokens: 512,
      system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userPrompt }],
    });

    const raw = response.content[0].type === "text" ? response.content[0].text : "";
    // M2(Fable5): 最初の { 〜 最後の } を抽出（旧 non-greedy 正規表現は最初の } で切れる罠があった）
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace <= firstBrace) return null;
    const jsonMatch = [raw.slice(firstBrace, lastBrace + 1)];

    const parsed = JSON.parse(jsonMatch[0]) as {
      action?: string;
      reason?: string;
      aix?: string | null;
      closing_strategy?: string;
      template_hint?: string;
      next_steps?: string[];
      reply_mode?: "aix" | "auto_reply";
    };

    // Use a canonical action key from AIX_BRAIN_NOTES if Haiku returned one we recognise.
    // If the aix value is unknown or null, fall back to empty string so the row still gets saved.
    let finalAix = parsed.aix && AIX_BRAIN_NOTES[parsed.aix] ? parsed.aix : null;
    // Quality gate: suppress AIX suggestions with < 30% acceptance rate over 10+ samples.
    // FIX(Fable5 #3): 自経路の採択率キー（:brain 等）を読む。旧実装は :analysis_step1 固定で
    // 他コンポーネントの統計をゲートに使っており、脳の自己修正が一度も機能していなかった。
    if (finalAix) {
      const { data: rateData } = await supabase
        .from("trigger_action_rules")
        .select("confidence, total_occurrence")
        .eq("keyword", `SOURCE_ACCEPT_RATE:${finalAix}:${source}`)
        .eq("action_type", finalAix)
        .maybeSingle();
      if (rateData) {
        const occ = (rateData.total_occurrence as number | null) ?? 0;
        const conf = (rateData.confidence as number | null) ?? 1;
        if (occ >= 10 && conf < 0.3) finalAix = null;
      }
    }
    // B2(Fable5): reply_mode のフェイルクローズ強制（コード側で決定的に上書き — プロンプト任せにしない）
    // 旧実装は線引きルール0件時に Haiku が auto_reply へ倒れる「安全側でない」デフォルトだった
    let replyMode: "aix" | "auto_reply" | undefined =
      (parsed.reply_mode === "aix" || parsed.reply_mode === "auto_reply") ? parsed.reply_mode : undefined;
    if (finalAix) replyMode = "aix";                       // AIX提案がある時点でスタッフ操作前提
    if (!boundaryText) replyMode = "aix";                  // 線引きルール取得失敗/0件時はフェイルクローズ
    if (opts?.autoSendEnabled === false) replyMode = "aix"; // auto_send無効の会話に auto_reply を提案しない
    if (opts?.isFlagged) replyMode = "aix";                // スタッフ要対応フラグ済み

    // 初回例外: スタッフの非AIXテキスト返信がまだ無い会話（真の初回）は
    // reply_mode と AIX提案を出さない。generate-reply の初回挨拶ドラフト生成が最優先。
    // generate-reply/route.ts の deriveSuggestedAix first_reply 例外と同じ設計意図。
    // auto_send_enabled=NULL → ?? false でフェイルクローズしてしまうバグの根本対処でもある。
    const hasStaffNonAixText = typedMessages.some(
      m => m.sender === "staff" && !m.is_aix_generated && m.text
    );
    if (!hasStaffNonAixText) {
      finalAix = null;
      replyMode = undefined;
    }

    return {
      action: finalAix ?? "",
      note: finalAix ? AIX_BRAIN_NOTES[finalAix] : (parsed.action ?? ""),
      source,
      enforcement_level: isUrgent ? "required" : "recommended",
      closing_strategy: parsed.closing_strategy || undefined,
      template_hint: parsed.template_hint || undefined,
      next_steps: Array.isArray(parsed.next_steps) && parsed.next_steps.length > 0 ? parsed.next_steps : undefined,
      reply_mode: replyMode,
      // Chrome拡張フィードバックループ: 検索フォーム自動入力用の構造化パラメータ（TODO(P2)対応）
      property_search_params: pc ? {
        area: pc.desired_area ?? null,
        floor_plan: pc.floor_plan ?? null,
        rent_max: pc.rent_max ?? null,
        walk_minutes: pc.walk_minutes ?? null,
        move_in_time: pc.move_in_time ?? null,
        preferences: pc.preferences ?? null,
        ng_points: pc.ng_points ?? null,
        ng_properties: sentProps.map((s) => ({ property_name: s.property_name, room_no: s.room_no })),
        search_urgency: (() => {
          // propertySearchText（物件検索統括ブロック）の searchPriority と同一ロジックの★のみ版
          if ((pc.property_send_count ?? 0) >= 2) return "─";
          const lastSentIso = pc.last_property_sent_at ?? sentProps[0]?.sent_at ?? null;
          const daysSince = lastSentIso
            ? Math.floor((Date.now() - new Date(lastSentIso).getTime()) / 86_400_000)
            : null;
          if (daysSince === null || daysSince >= 7) return "★★★";
          if (daysSince >= 3) return "★★";
          return "★";
        })(),
      } : null,
    };
  } catch (e) {
    console.warn(`[brain-core] Haiku analysis failed: conv=${conversationId}`, e instanceof Error ? e.message : e);
    return null;
  }
}

// ── 会話チェックポイント（セーブデータ）作成 ──────────────────────────────────
// 脳分析成功後に after() で fire-and-forget 起動。final-check anomaly_scan の
// 正解データ（ground truth）になるため「会話に明記された事実のみ・日付付き」が絶対条件。
// ローリング累積方式: 最新1行が常に現在の確認済み事実の全量（前回分を引き継いで更新）。
const MESSAGES_PER_CHECKPOINT = 15;  // 前回作成時から15件以上増えたら新規作成
const CHECKPOINT_MIN_MESSAGES = 11;  // 総メッセージ数 > 10 で初回作成

function formatJstDateShort(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

function buildCheckpointPrompt(
  prevSummary: string | null, historyText: string, total: number, shown: number,
): string {
  return `あなたは不動産賃貸仲介のLINE会話の記録係です。会話の「セーブデータ」（チェックポイント）を作成してください。
このセーブデータは後で返信AIの事実確認（ハルシネーション検査）の正解データとして使われます。
会話に書かれていない事実を1つでも書くと、誤った返信が「正しい」と判定される事故になります。

絶対ルール:
- 会話に明記された事実のみ書く。推測・補完・一般知識での穴埋めは禁止
- 各事実に日付と出所を必ず付ける（例:「家賃12〜15万（8/3顧客提示）」）
- 金額・物件名・部屋番号・駅名・路線名・日付は一字一句そのまま写す（丸め・単位変換・言い換え禁止）
- 前回セーブデータの事実は、新しい会話で更新・撤回されていない限りそのまま引き継ぐ。
  更新された場合は新しい値のみ残す（例: 家賃上限が変わったら新値だけ・旧値は書かない）
- 解決した【未解決事項】は【確認済み事実】へ移す（例: 空室確認の回答が来たら結果を事実として記録）

【前回のセーブデータ】
${prevSummary ? prevSummary.slice(0, 1500) : "（なし・今回が最初のセーブ）"}

【新しい会話（全${total}件中の直近${shown}件・日付付き。スタッフ(AIX)=AIツールで送信済み）】
${historyText}

JSON形式のみで返答（説明・コードブロック不要）:
{
  "summary": "【確認済み事実】家賃: 12〜15万（8/3顧客提示）/ エリア: 渋谷・恵比寿（8/3顧客）/ 入居希望: 9月上旬（8/3顧客）\\n【AIX使用済み】viewing_invite: 8/5送付 / property_send: 8/7 3件\\n【未解決事項】空室確認: ライオンズ渋谷401（問い合わせ中）/ 内覧日程: 調整中",
  "key_facts": [
    {"type": "confirmed_fact", "value": "家賃12〜15万（8/3顧客提示）"},
    {"type": "aix_sent", "value": "viewing_invite 8/5送付"},
    {"type": "unresolved", "value": "ライオンズ渋谷401 空室確認中"}
  ],
  "stage": "hearing"
}
stage は hearing/proposing/applying/contract のいずれか。
該当事実の無いセクション行は省略可。key_facts の type は confirmed_fact/aix_sent/unresolved の3種のみ。`;
}

export async function maybeCreateCheckpoint(conversationId: string): Promise<void> {
  try {
    // 1) 総メッセージ数 + 最新チェックポイントを並列取得
    const [countRes, cpRes] = await Promise.all([
      supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", conversationId),
      supabase
        .from("conversation_checkpoints")
        .select("checkpoint_index, message_count_at_creation, summary")
        .eq("conversation_id", conversationId)
        .order("checkpoint_index", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (countRes.error || cpRes.error) {
      console.warn("[checkpoint] precheck failed:", conversationId,
        countRes.error?.message ?? cpRes.error?.message);
      return; // 最新CPが読めない状態で書くと index 衝突・事実退行の恐れ → 何もしない
    }
    const total = countRes.count ?? 0;
    if (total < CHECKPOINT_MIN_MESSAGES) return;
    const last = cpRes.data as
      { checkpoint_index: number; message_count_at_creation: number; summary: string } | null;
    if (last && total - last.message_count_at_creation < MESSAGES_PER_CHECKPOINT) return;

    // 2) 前回以降の新規メッセージ（最大40件・昇順に直す）
    const newSinceLast = last ? total - last.message_count_at_creation : total;
    const { data: msgsDesc, error: msgErr } = await supabase
      .from("messages")
      .select("sender, text, created_at, is_aix_generated")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(Math.min(newSinceLast, 40));
    if (msgErr || !msgsDesc || msgsDesc.length === 0) return;
    const msgs = [...msgsDesc].reverse();

    const historyText = msgs
      .map((m) => {
        const role = m.sender === "customer" ? "顧客" : (m.is_aix_generated ? "スタッフ(AIX)" : "スタッフ");
        return `${role} ${formatJstDateShort(m.created_at as string)}: ${(m.text ?? "").slice(0, 300)}`;
      })
      .join("\n");

    // 3) Haiku（モジュール共有 client: timeout 15s / maxRetries 0 — fire-and-forget なので失敗放置でOK）
    const prompt = buildCheckpointPrompt(last?.summary ?? null, historyText, total, msgs.length);
    const response = await client.messages.create({
      model: HAIKU,
      max_tokens: 700,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = response.content[0]?.type === "text" ? response.content[0].text : "";
    const fb = raw.indexOf("{");
    const lb = raw.lastIndexOf("}");
    if (fb === -1 || lb <= fb) return;
    const parsed = JSON.parse(raw.slice(fb, lb + 1)) as {
      summary?: string;
      key_facts?: Array<{ type: string; value: string }>;
      stage?: string;
    };
    if (!parsed.summary || !parsed.summary.trim()) return;
    const stage = ["hearing", "proposing", "applying", "contract"].includes(parsed.stage ?? "")
      ? (parsed.stage as string) : null;

    // 4) INSERT（並走時の UNIQUE 違反 23505 は「相手が先に書いた」= 正常）
    const { error: insErr } = await supabase.from("conversation_checkpoints").insert({
      conversation_id: conversationId,
      checkpoint_index: (last?.checkpoint_index ?? 0) + 1,
      message_count_at_creation: total,
      summary: parsed.summary.slice(0, 2000),
      key_facts: Array.isArray(parsed.key_facts) ? parsed.key_facts.slice(0, 20) : [],
      conversation_stage: stage,
    });
    if (insErr && insErr.code !== "23505") {
      console.error("[checkpoint] insert failed:", conversationId, insErr.message);
    }
  } catch (e) {
    console.warn("[checkpoint] failed (fire-and-forget):", conversationId,
      e instanceof Error ? e.message : e);
  }
}

/**
 * 会話1件の脳分析を実行して conversations.suggested_aix_meta + brain_analyzed_at を書き込む。
 * webhook（顧客メッセージ受信直後）と brain-sweep cron（バックストップ）から呼ばれる。
 * 分析対象外（クローズ済み等）や分析失敗時は何も書かない（meta は null のまま → sweep が再試行）。
 */
export async function analyzeAndSaveBrainMeta(conversationId: string): Promise<boolean> {
  const { data: conv, error: selectError } = await supabase
    .from("conversations")
    .select("id, status, updated_at, property_customer_id, auto_send_enabled, line_status, is_hot, is_flagged, conversation_direction")
    .eq("id", conversationId)
    .maybeSingle();
  if (selectError) {
    // B10(Fable5): 旧実装はエラーを握り潰し「会話が存在しない」と区別不能だった
    console.error("[brain-core] conversations select failed:", conversationId, selectError.message);
    return false;
  }
  if (!conv) return false;

  const status = (conv.status as string | null) ?? null;
  if (status && BRAIN_SKIP_STATUSES.includes(status)) return false;

  // H6(Fable5): ブロック済み/フォロー解除の顧客は分析しない（Haiku浪費 + 無意味な提案の防止）
  const lineStatus = (conv.line_status as string | null) ?? null;
  if (lineStatus === "blocked" || lineStatus === "unfollowed") return false;

  // B5(Fable5): stale-write 対策のウォーターマーク。連続メッセージで分析A→Bが並走した場合、
  // 古い方（msg2を含まない解析）が後着で勝つのを防ぐ — 書き込み時に updated_at 一致を条件にする
  const watermark = conv.updated_at as string;

  const isUrgent = Date.now() - new Date(watermark).getTime() <= URGENT_WINDOW_MS;
  const meta = await analyzeConversation(
    conversationId,
    isUrgent,
    status,
    (conv.property_customer_id as string | null) ?? null,
    "brain",
    {
      autoSendEnabled: (conv.auto_send_enabled as boolean | null) ?? false,
      isHot: (conv.is_hot as boolean | null) ?? false,
      isFlagged: (conv.is_flagged as boolean | null) ?? false,
    },
  );
  if (!meta) {
    // H3(Fable5): 失敗時も brain_analyzed_at を記録 → sweep の30分バックオフに使用。
    // これが無いと決定的に失敗する会話が5分毎に永久リトライされ（最大288 Haiku呼び出し/日/行）、
    // 新しい順ソートのため10件のスタック失敗で sweep 全体が飢餓状態になっていた
    await supabase
      .from("conversations")
      .update({ brain_analyzed_at: new Date().toISOString() })
      .eq("id", conversationId)
      .eq("updated_at", watermark);
    return false;
  }

  const { error } = await supabase
    .from("conversations")
    .update({ suggested_aix_meta: meta, brain_analyzed_at: new Date().toISOString() })
    .eq("id", conversationId)
    .eq("updated_at", watermark); // B5: 会話が進んでいたら古い解析は静かに no-op（sweep が補填する）
  if (error) {
    // B10(Fable5): スキーマ変更後の型不一致等、恒常的なDB障害を診断可能にする
    console.error("[brain-core] suggested_aix_meta update failed:", conversationId, error.message);
  }
  // 脳分析成功時のみチェックポイント作成を fire-and-forget 起動（レスポンスを遅らせない）
  if (!error) {
    // ── conversation_direction フェーズ変化検知と更新 ─────────────────────────
    // brain分析が成功した場合のみ実行。フェーズ変化が無い場合・スタッフ手動修正中はスキップ。
    // 失敗しても fire-and-forget なのでメインフローへの影響なし。
    try {
      // STEP A: applying_pattern カテゴリの最重要ナレッジを取得
      const { data: applyingPatterns } = await supabase
        .from("ai_reply_knowledge")
        .select("id, title, content")
        .eq("category", "applying_pattern")
        .gte("importance", 8)
        .order("importance", { ascending: false })
        .limit(1);
      const bestPattern = applyingPatterns?.[0] ?? null;

      // STEP B: brain分析結果からフェーズを推定
      const newPhase = detectPhaseFromBrainMeta(meta as Record<string, unknown>);

      // STEP C: 既存 conversation_direction を取得（conv には conversation_direction を select 済み）
      const convAsRecord = conv as unknown as Record<string, unknown>;
      const existingDir = (convAsRecord?.conversation_direction ?? null) as Record<string, unknown> | null;

      // STEP D: スキップ判定
      if (!existingDir?.manually_overridden && existingDir?.current_phase !== newPhase) {
        // STEP E: 新しい direction を構築して UPDATE
        const phaseOrder = ["hearing", "proposing", "viewing", "applying"];
        const newIdx = phaseOrder.indexOf(newPhase);
        const metaRecord = meta as Record<string, unknown>;
        const newDirection = {
          template_id: bestPattern?.id ?? null,
          pattern_title: bestPattern?.title ?? "デフォルト道筋",
          approach_mode: (newPhase === "applying" || newPhase === "viewing") ? "active" : "watchful",
          direction_summary: String(metaRecord.closing_strategy ?? "申込まで丁寧にリード"),
          current_phase: newPhase,
          phases_plan: phaseOrder.map((ph, i) => ({
            phase: ph,
            label: ["条件ヒアリング", "物件提案", "内覧調整", "申込"][i],
            staff_action: ["希望条件を確認", "条件に合う物件を提案", "内覧日程を調整", "申込書類を案内"][i],
            status: i < newIdx ? "done" : i === newIdx ? "current" : "pending",
          })),
          next_staff_action: String(metaRecord.next_steps ?? "状況を確認して次の一手を判断"),
          matched_at: (existingDir?.matched_at as string | undefined) ?? new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        await supabase
          .from("conversations")
          .update({ conversation_direction: newDirection })
          .eq("id", conversationId);
      }
    } catch (dirErr) {
      console.warn("[brain-core] conversation_direction update failed:", conversationId,
        dirErr instanceof Error ? dirErr.message : dirErr);
    }

    try {
      after(() => maybeCreateCheckpoint(conversationId));
    } catch {
      // リクエストコンテキスト外（テスト/スクリプト実行）では after() が使えないためフォールバック
      void maybeCreateCheckpoint(conversationId).catch(() => {});
    }
  }
  return !error;
}
