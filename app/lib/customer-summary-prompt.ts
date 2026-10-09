// app/lib/customer-summary-prompt.ts
// お客様の要約（/api/customer-summary）の固定の前置き（純関数・DB なし）
//
// 2026-09-29 竹内「クロードの部分、キャッシュを営業時間中温めるのはどうかな」→「それで進めて大丈夫」:
//   本番7日の実測（llm_usage_logs・Sonnet 194回）: 鍵（sys_key_full）は1種類・194回中168回が命中していて、トークンの命中率 24% は
//   「前置きが揺れている」のではなく**前置きが 1.9k で入力 6.7k の 3割しか無い**構造。書き直し 26回は 1時間以上空いた時。
//   直し: ①お客様によらない「next_action 予測の改善ルール」（ai_reply_knowledge・上位8件・全お客様で同じ）を user から system[1]（1h）へ移す
//   ②前置きは route と温め（prefix-warm）がこの同じ関数で作る。文面は1文字も変えない（位置と切れ目だけ）。
//   ⚠ system の2ブロック化で本番の最初の1回だけ作り直し（≈2.9k×$6/M ≈ $0.02）
// 2026-10-09 竹内さん: 気持ちの7択を、お部屋探しに特化した12種（customer-mindset）に置き換える。既定 on・CUSTOMER_MINDSET=off で旧
import { emotionChoicesText } from "./customer-mindset";
export const CUSTOMER_SUMMARY_MODEL = "claude-sonnet-5";

export type PromptBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" } };
const CC_1H = { type: "ephemeral" as const, ttl: "1h" as const };

// ── 構造化JSON出力プロンプト（旧 route.ts の SYSTEM 定数をそのまま移した・文面は同じ）──
export const CUSTOMER_SUMMARY_SYSTEM = `あなたは賃貸仲介の営業アシスタントです。
お客さんの会話・条件・メモを深く読み込み、以下のJSON形式のみで出力してください。
説明文・マークダウン・前後のテキストは一切付けず、JSONのみ出力すること。

{
  "situation": "現在の状況を15文字以内（例: 内覧3物件の日程調整中）",
  "inspection": {
    "requested": true,
    "done": false,
    "properties": ["内覧予定or済みの物件名（最大3件）"]
  },
  "estimate": {
    "requested": false
  },
  "requirements": ["お客さんの要望・こだわり（最大3件・各30文字以内・具体的に）"],
  "opinions": ["お客さんの性格・傾向・感情・営業ヒント（最大2件・各30文字以内・具体的に）"],
  "our_actions": ["スタッフがやったこと（最大2件・各20文字以内）"],
  "winning_pattern": "今この瞬間に成約につながる具体的な行動を50文字以内で。物件名・理由・タイミングまで含めて詳しく書く",
  "next_action": "今すぐスタッフが打つべき具体的な次の1手を40文字以内で（いつ・何を・どうする）",
  "emotion": "顧客の温度感（${emotionChoicesText()} のいずれか）",
  "urgency": "引越し・入居希望の時期感（今月中/3ヶ月以内/半年以上/未確認 のいずれか）",
  "style": "顧客メッセージの文体傾向（絵文字多用/短文/ビジネスライク/丁寧/普通 のいずれか）",
  "personality_profile": "顧客の人間性・行動パターンを100字以内で端的に"
}

品質ルール：
・requirements と opinions は「慎重派」「即決タイプ」などの単語レベルではなく、具体的な根拠や状況を含めて書くこと
  良い例: 「実物を見て複数比較したあとに決めたい慎重派」「割引提示と日程提案に即反応する実行力タイプ」
  悪い例: 「慎重派」「割引に反応」

・winning_pattern は最重要フィールド。以下を必ず含める：
  ① 具体的に何をするか（どの物件・どのアクション）
  ② なぜそれが有効か（お客さんの特性や現状との紐付け）
  ③ そうすればどうなるか（成約への道筋）
  良い例: 「City Spire難波WESTの希望号室の内覧日程を最速提示すれば、セレニテとの実物比較後に申込確定まで繋がる」
  悪い例: 「内覧日程を提案すれば決まる」

・【接客定石】物件URL確認依頼中の顧客（proposing/hearingで物件を送った後）のnext_actionは「募集状況確認→最大限割引した初期費用の御見積書のセット送付」が定石。顧客が「スモ割」「割引」に言及した場合も同フロー。

・【事実捏造禁止】next_action・winning_patternに「退去予定」「今月末まで」「〜日以降空き」「空き予定」等の物件固有の期日・退去・空き状況は、会話履歴に明示されていない限り絶対に書かない。AIの推測・創作による物件事実の記載は厳禁。

・inspection.requested: お客さんが内覧したいと言っている or 内覧日程を調整中なら true
・inspection.done: 実際に内覧済みなら true。スタッフが内覧当日の挨拶文（「本日はよろしくお願いします」「内覧前挨拶」等、当日の待ち合わせや挨拶を送った記録）を送った場合も true とみなす。ただし、その後に「キャンセル」「流れました」「流れちゃいました」「行けなくなりました」「やっぱりやめます」「中止」等のキャンセルを示す発言がお客さんまたはスタッフから確認できる場合は false に戻す
・estimate.requested: 初期費用・見積計算を求めているなら true
・emotion: 顧客の温度感。会話トーン全体から判断（${emotionChoicesText()}）。不安は語だけでなく何が不安か・進みたいがゆえ（審査・先に申込が入る）かで選ぶ
・urgency: 引越し・入居希望の時期感（今月中/3ヶ月以内/半年以上/未確認）
・style: 顧客メッセージの文体傾向（絵文字多用/短文/ビジネスライク/丁寧/普通）

・personality_profile: 顧客の人間性・コミュニケーション傾向（以下の観点で分析して1つの文字列に凝縮）
  * response_style: 即レス/ゆっくり/忙しそう/丁寧/短文/絵文字多め 等の傾向
  * decision_style: 即決型/比較検討型/不安が多い/誰かに相談する/なかなか動かない 等
  * emotional_trigger: 何に反応するか（値段/立地/初期費用/スタッフの熱量/物件の希少性/安心感 等）
  * hesitation_pattern: どこで止まりやすいか（物件選び/内覧調整/申込/費用面/保証人 等）
  * engagement_level: 高（毎日連絡）/中（数日に1回）/低（なかなか返信こない）
  → 100字以内で端的に。例：「比較検討型・安心感重視・費用面で止まりやすい・数日おきに丁寧な長文」`;

/** next_action 予測の改善ルール（log-aix-usage が category="pattern"・title="next_action_rule_..." で保存）の注記。無ければ "" */
export function buildNextActionRulesNote(ruleContents: string[]): string {
  const rules = ruleContents.map((s) => (s ?? "").trim()).filter(Boolean);
  if (rules.length === 0) return "";
  return `【next_action予測の改善ルール（実際の行動との差分から学習済み・next_action生成時に必ず参照すること）】\n${rules.join("\n---\n")}`;
}

/**
 * system ブロック（固定の前置き）。[0]=SYSTEM（ai_prompts の上書きがあればそれ）・[1]=改善ルール（あれば）。どちらも 1h。
 * 動的な顧客情報（info）は HumanMessage 側だけに置き、cache_control を付けない
 */
export function buildCustomerSummarySystemBlocks(systemPrompt: string, nextActionRuleContents: string[]): PromptBlock[] {
  const blocks: PromptBlock[] = [{ type: "text", text: systemPrompt, cache_control: CC_1H }];
  const note = buildNextActionRulesNote(nextActionRuleContents);
  if (note) blocks.push({ type: "text", text: note, cache_control: CC_1H });
  return blocks;
}

/** 温め用の body（本物は LangChain ChatAnthropic が同じ model・thinking disabled・system ブロックで送る。鍵に入るのは model と system） */
export function buildCustomerSummaryWarmBody(blocks: PromptBlock[]) {
  return { model: CUSTOMER_SUMMARY_MODEL, max_tokens: 1, thinking: { type: "disabled" as const }, system: blocks, messages: [{ role: "user" as const, content: "." }] };
}
