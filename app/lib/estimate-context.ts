// app/lib/estimate-context.ts
// 見積書（御見積）の作成宣言が「今の文脈で適切か」を 1 箇所で判定する共通モジュール（2026-09-08 Fable5）。
// route.ts（detectAixTiming / estimateGateNote / sentPropertiesCount）・final-check.ts（E5 / E10）・
// brain-core.ts（信号0.96・1）が同じ verdict を参照し、生成側と検証側の判断ズレを無くす。
//
// 根本原則: 見積もりは「この顧客が今、特定の物件の費用を知りたがっている証拠」が会話文脈に実在する時にだけ
// 使う行動であり、state（first_reply〜applying）や語の出現（⑦初期費用ラベル・初回テンプレの「最大限割引」）では
// 決して判定しない。
//
// 判定の優先順位（上ほど強い）
//   0. ハード禁止: closed_won ／ brain.avoid_topics に「見積」（顧客の明示依頼があれば依頼が勝つ）
//   1. customer_estimate_request : 顧客が見積書そのものを依頼（送付済みでも再依頼なら再解禁）
//   2. staff_promise_echo(既送付) : 見積が送付済み/約束済みで新規依頼が無い → 復唱・受付のみ
//   3. customer_cost_question    : 顧客が費用・初期費用・総額・いくら・スモ割を質問
//   4. customer_sent_property    : 顧客が URL・画像・号室付き物件名を送付（暗黙の見積依頼）
//   5. after_property_sent       : スタッフ物件送付済み ∧ 顧客が特定物件に前向き反応（条件変更が主題なら不可）
//   6. staff_promise_echo(直前約束): 直前スタッフが見積約束 → 復唱のみ
//   7. none                      : 条件フォーム受信・条件変更依頼・雑談・短い了承 → ピックアップ宣言/受付文に置換

import {
  CUSTOMER_COST_QUESTION_RE,
  CUSTOMER_ESTIMATE_REQUEST_RE,
  CUSTOMER_PROPERTY_REF_RE,
  CUSTOMER_PROPERTY_POSITIVE_RE,
  CUSTOMER_CONDITION_CHANGE_RE,
  STAFF_ESTIMATE_PROMISE_RE,
  FORM_LABEL_RE,
  isConditionFormMessage,
} from "./line-reply-prompts";
import type { SuggestedAixMeta } from "./brain-core";

export type HistoryMessage = { sender: string; text: string; createdAt?: string; isAix?: boolean };

export type EstimateTrigger =
  | "customer_estimate_request"
  | "customer_cost_question"
  | "customer_sent_property"
  | "after_property_sent"
  | "staff_promise_echo"
  | "none";

export type EstimateMode = "declare" | "echo_only" | "forbid";

export type EstimateContextVerdict = {
  /** true = 見積語彙を書いてよい（declare または echo_only） */
  appropriate: boolean;
  /** declare = 新規作成宣言OK / echo_only = 約束の復唱・受付文のみ / forbid = 見積語彙を一切書かない */
  mode: EstimateMode;
  trigger: EstimateTrigger;
  /** forbid 時に見積語彙が出た場合の final-check 重大度（物件未送付・条件フォーム = block、送付済み = warning） */
  severity: "block" | "warning";
  reason: string;
  /** 判定根拠となった顧客発言・スタッフ発言の一致部分（プロンプト・note 用の引用） */
  evidence: string | null;
  sentPropertiesCount: number;
  /** 判定根拠トレース（console.info / final-check note 用） */
  signals: string[];
};

export type EstimateContextInput = {
  /** 顧客の最新メッセージ本文（未加工。内部で FORM_LABEL_RE を剥がす） */
  customerMessage: string;
  /** countSentProperties(recentMessages) の値（ブレイン由来ではなく履歴の決定論算出） */
  sentPropertiesCount: number;
  /** 直前スタッフ返信より後の顧客メッセージ（未返信バースト・oldest-first・最新を含んでよい） */
  recentCustomerMessages: string[];
  /** 直前スタッフ返信本文（復唱判定用） */
  lastStaffMessage?: string | null;
  /** brainMeta.action（"estimate_sheet" 等）。fresh でない場合は無視される */
  brainAction?: string | null;
  /** brainMeta 本体（customer_questions / customer_intent / current_property / condition_change_type / avoid_topics / enforcement_level） */
  brainMeta?: NonNullable<SuggestedAixMeta> | null;
  /** route.ts の brainFreshForMessage（analyzed_msg_ts >= 最新顧客 msg）。false なら brain 由来シグナルを使わない */
  brainFresh?: boolean;
  /** resolveState().guideKey（closed_won 判定にのみ使用。state で解禁判定はしない） */
  phaseKey?: string | null;
  /** 直前スタッフ返信以降に顧客が画像を送っているか（条件フォーム画像は除外される） */
  hasCustomerImage?: boolean;
  /** aix_usage_logs の estimate_sheet 送付済み or 直前スタッフ約束（route.ts estimatePromised） */
  estimatePromised?: boolean;
};

// ─── 送付済み物件数（route.ts 3箇所のインライン式・check-reply を統合）──────────────
// 一次証拠: 🌟物件紹介テンプレ／【画像】／URL／送付完了形／ご査収／「〇〇 402号室」形の物件名
// 除外: 見積書画像・待ち合わせ地図・申込フォーマット・必要書類（物件ではない送付物）
const STAFF_PROPERTY_SENT_RE = /🌟|【画像】|\[画像\]|https?:\/\/|お送りさせて頂きました|お送りいたしました|お送りしました|送らせて頂きました|ご査収|[0-9０-９]{2,4}号室/;
const STAFF_NON_PROPERTY_SEND_RE = /(?:御|お)?見積(?:書|り|もり)|待ち合わせ|集合場所|地図|申込書|申込み?時フォーマット|フォーマット|必要書類|身分証/;

export function countSentProperties(history: HistoryMessage[]): number {
  return history.filter((m) => {
    if (m.sender !== "staff") return false;
    const t = m.text ?? "";
    return STAFF_PROPERTY_SENT_RE.test(t) && !STAFF_NON_PROPERTY_SEND_RE.test(t);
  }).length;
}

export function stripFormLabels(text: string): string {
  return (text ?? "").replace(FORM_LABEL_RE, " ");
}

function firstMatch(re: RegExp, text: string): string | null {
  const m = text.match(re);
  return m ? m[0].slice(0, 40) : null;
}

const COST_WORD_RE = /初期費用|費用|総額|いくら|見積|敷金|礼金|金額|価格|スモ割|イエヤス割/;

export function isMisumoriContextAppropriate(input: EstimateContextInput): EstimateContextVerdict {
  const signals: string[] = [];
  const raw = input.customerMessage ?? "";
  const isForm = isConditionFormMessage(raw);
  const msg = stripFormLabels(raw);
  // 未返信バースト（直近2件＋最新）。過去の別件費用質問を拾わないため 2 件に限定
  const burst = [...(input.recentCustomerMessages ?? []).slice(-2), raw].map(stripFormLabels).join("\n");
  const lastStaff = input.lastStaffMessage ?? "";
  const sent = input.sentPropertiesCount ?? 0;
  const fresh = input.brainFresh ?? false;
  const bm = fresh ? (input.brainMeta ?? null) : null;
  const brainAction = fresh ? (input.brainAction ?? bm?.action ?? null) : null;
  const base = { sentPropertiesCount: sent, signals };

  // ── 決定論シグナル ──
  const asksEstimate = CUSTOMER_ESTIMATE_REQUEST_RE.test(burst);
  const asksCost = CUSTOMER_COST_QUESTION_RE.test(burst);
  // 条件フォーム画像は「物件送付」ではない。フォームでない時のみ画像・URL・号室を物件参照とみなす
  const hasPropertyRef = !isForm && (CUSTOMER_PROPERTY_REF_RE.test(msg) || !!input.hasCustomerImage);
  const isConditionChange =
    CUSTOMER_CONDITION_CHANGE_RE.test(msg) || (!!bm && bm.condition_change_type != null);
  const rePositive = CUSTOMER_PROPERTY_POSITIVE_RE.test(msg);
  const staffPromisedNow = STAFF_ESTIMATE_PROMISE_RE.test(lastStaff);
  const estimatePromised = !!input.estimatePromised || staffPromisedNow;

  // ── ブレイン補強シグナル（fresh 時のみ） ──
  const brainCostQuestion =
    !!bm &&
    (bm.customer_questions ?? []).some((q) => COST_WORD_RE.test(q)) &&
    (bm.customer_intent === "question" || bm.customer_intent === "consultation" || bm.customer_intent == null);
  const brainSaysEstimate = brainAction === "estimate_sheet" && bm?.enforcement_level !== "optional";
  const brainAvoidsEstimate = !!bm && (bm.avoid_topics ?? []).some((t) => /見積/.test(t));
  const brainPositive =
    !!bm && !!bm.current_property &&
    (bm.customer_intent === "positive" || bm.customer_intent === "decision" || bm.customer_intent === "desire");

  if (isForm) signals.push("msg:condition_form");
  if (asksEstimate) signals.push("re:estimate_request");
  if (asksCost) signals.push("re:cost_question");
  if (hasPropertyRef) signals.push("re:property_ref");
  if (isConditionChange) signals.push(`msg:condition_change${bm?.condition_change_type ? `=${bm.condition_change_type}` : ""}`);
  if (rePositive) signals.push("re:property_positive");
  if (staffPromisedNow) signals.push("staff:promise");
  if (input.estimatePromised) signals.push("aix:estimate_sent_or_promised");
  if (brainCostQuestion) signals.push("brain:customer_questions~cost");
  if (brainSaysEstimate) signals.push("brain:action=estimate_sheet");
  if (brainAvoidsEstimate) signals.push("brain:avoid_topics~見積");
  if (brainPositive) signals.push("brain:current_property×intent");
  signals.push(`sent=${sent}`);

  // 0. ハード禁止
  if (input.phaseKey === "closed_won") {
    return { ...base, appropriate: false, mode: "forbid", trigger: "none", severity: "block", reason: "成約後は見積提案しない", evidence: null };
  }
  if (brainAvoidsEstimate && !asksEstimate && !asksCost) {
    return { ...base, appropriate: false, mode: "forbid", trigger: "none", severity: sent === 0 ? "block" : "warning", reason: "brain avoid_topics に見積（顧客の明示依頼なし）", evidence: null };
  }

  // 1. 顧客の見積依頼（送付済みでも新規依頼は再解禁）
  if (asksEstimate) {
    return { ...base, appropriate: true, mode: "declare", trigger: "customer_estimate_request", severity: "warning", reason: "お客様が見積書を明示的に依頼", evidence: firstMatch(CUSTOMER_ESTIMATE_REQUEST_RE, burst) };
  }

  // 2. 見積送付済み／約束済みで新規依頼なし → 復唱・受付のみ（二重宣言防止）。
  //    ただし「新しい物件 ＋ 費用質問」は別物件の新規依頼として 3./4. に流す
  if (estimatePromised && !(hasPropertyRef && asksCost)) {
    return { ...base, appropriate: true, mode: "echo_only", trigger: "staff_promise_echo", severity: "warning", reason: "見積書は既に約束／送付済み（復唱・短い受付文のみ・再宣言不可）", evidence: firstMatch(STAFF_ESTIMATE_PROMISE_RE, lastStaff) };
  }

  // 3. 費用質問
  if (asksCost) {
    return { ...base, appropriate: true, mode: "declare", trigger: "customer_cost_question", severity: "warning", reason: hasPropertyRef ? "特定物件（URL/画像）＋費用質問" : "お客様が費用・初期費用・総額を質問", evidence: firstMatch(CUSTOMER_COST_QUESTION_RE, burst) };
  }
  if (brainCostQuestion && !isForm) {
    return { ...base, appropriate: true, mode: "declare", trigger: "customer_cost_question", severity: "warning", reason: "brain.customer_questions が費用質問と判定", evidence: (bm!.customer_questions ?? []).find((q) => COST_WORD_RE.test(q)) ?? null };
  }

  // 4. 顧客の特定物件送付（暗黙の見積依頼。成約データ: hearing/first_reply の早期正例は全てこれ）
  if (hasPropertyRef && !isConditionChange) {
    return { ...base, appropriate: true, mode: "declare", trigger: "customer_sent_property", severity: "warning", reason: "お客様が特定物件（URL・画像・号室）を送付", evidence: firstMatch(CUSTOMER_PROPERTY_REF_RE, msg) ?? "【画像】" };
  }

  // 5. スタッフ物件送付後の前向き反応（条件変更が主題・条件フォームは除外）
  if (sent > 0 && !isConditionChange && !isForm) {
    if (rePositive || brainPositive || brainSaysEstimate) {
      return { ...base, appropriate: true, mode: "declare", trigger: "after_property_sent", severity: "warning", reason: rePositive || brainPositive ? "送付済み物件にお客様が前向き反応" : "brain action=estimate_sheet（送付済み物件あり）", evidence: firstMatch(CUSTOMER_PROPERTY_POSITIVE_RE, msg) ?? bm?.current_property ?? null };
    }
  }
  if (brainSaysEstimate && sent === 0) signals.push("brain:estimate_sheet rejected (未送付・質問なし)");

  // 6. 直前スタッフ約束の復唱のみ（2. で estimatePromised=false のまま到達したケース）
  if (staffPromisedNow) {
    return { ...base, appropriate: true, mode: "echo_only", trigger: "staff_promise_echo", severity: "warning", reason: "直前スタッフが見積約束済み（復唱のみ・再宣言不可）", evidence: firstMatch(STAFF_ESTIMATE_PROMISE_RE, lastStaff) };
  }

  // 7. 該当なし
  const reason = isForm
    ? "条件フォーム受信（費用質問なし）→ ピックアップ宣言"
    : isConditionChange
      ? "条件変更依頼が主題（費用質問なし）→ 新条件復唱＋ピックアップ宣言"
      : sent === 0
        ? "物件未送付・費用質問なし → ピックアップ宣言"
        : "送付済みだが前向き反応・費用質問なし → 短い受付文";
  return { ...base, appropriate: false, mode: "forbid", trigger: "none", severity: isForm || sent === 0 ? "block" : "warning", reason, evidence: null };
}

// ─── 生成側プロンプト注入ノート ──────────────────────────────────────────────
// 旧 estimateGateNote（約900字の禁止列挙・常時注入・staticBlock）を verdict 依存のポジティブ定義に置換。
// 毎リクエスト変わるため dynamicBlock に置く（cache 対象外）。
export function buildEstimateGateNote(v: EstimateContextVerdict | null): string {
  const common =
    "\n\n【💰 見積書の文脈判定（決定論・事実）】\n" +
    "見積書本体（金額内訳・「〜の御見積書となります」「ご査収ください」「同封させて頂きました」等の添付済みカバー文）は AIX【見積書送る】専用。AI返信では絶対に生成しない。家賃・敷金・礼金・仲介手数料の実額もスタッフが履歴で既に伝えた数字の引用以外は断言・推測禁止。分割払い・カード払いの提案はお客様が支払い方法を質問した時のみ。";
  if (!v) {
    return common + "\n→ 判定不能: 見積・御見積・お見積の語を書かず、ピックアップ宣言または受付文で返す。";
  }
  const facts =
    `\n・送付済み物件数: ${v.sentPropertiesCount}件` +
    `\n・お客様の費用質問: ${v.trigger === "customer_cost_question" ? `あり『${v.evidence ?? ""}』` : "なし"}` +
    `\n・お客様の見積依頼: ${v.trigger === "customer_estimate_request" ? `あり『${v.evidence ?? ""}』` : "なし"}` +
    `\n・お客様の特定物件提示（URL/画像/号室）: ${v.trigger === "customer_sent_property" ? `あり『${v.evidence ?? ""}』` : "なし"}` +
    `\n・物件送付後の前向き反応: ${v.trigger === "after_property_sent" ? `あり『${v.evidence ?? ""}』` : "なし"}` +
    `\n・スタッフの見積約束: ${v.trigger === "staff_promise_echo" ? `済み『${v.evidence ?? ""}』` : "未"}`;
  if (v.mode === "declare") {
    return (
      common + facts +
      `\n→ 判定: 【許可】${v.reason}。作成宣言「かしこまりました！！最大限割引させて頂いた御見積書を作成しお送りさせて頂きます！！」を1回だけ書く（2回以上・過去形「お送りしました」・物件名入りカバー文・金額は禁止）。` +
      (v.trigger === "customer_sent_property" ? "物件送付への返信のため「お部屋の募集状況確認させて頂きます」を先に置き、見積作成宣言を続ける（順序固定）。" : "") +
      "\n【見積書作成宣言を使ってよい文脈はこの4つのみ】①お客様が費用・初期費用・総額・いくらを質問 ②お客様が見積を依頼 ③お客様が特定物件（URL・画像・号室）を送付 ④スタッフ送付物件にお客様が前向き反応"
    );
  }
  if (v.mode === "echo_only") {
    return (
      common + facts +
      `\n→ 判定: 【復唱のみ】${v.reason}。「お見積書はお送りさせて頂きますね」等の約束復唱、または「はい😊！！確認しご連絡させて頂きます😊！！」の短い受付文のみ。新規の作成宣言（作成して／作成し／作成いたし）・所要時間の再提示・割引の再約束は禁止（ESTIMATE_REPEAT_PROMISE）。`
    );
  }
  return (
    common + facts +
    `\n→ 判定: 【不許可】${v.reason}。「見積書／御見積／お見積／見積もり／最大限割引した御見積書」の語を一切書かない（TIMING_VOCAB_MISMATCH で ${v.severity}）。` +
    "「初期費用も最大限割引させて頂き〇〇さんのお引越しにかかる費用を出来る限り抑えさせて頂きます」の訴求宣言だけは可。" +
    "\n代わりに: 条件受領→「〇〇周辺全域から〇〇さんご希望の〔条件〕のお部屋を全てピックアップしてお送りさせて頂きます」／短い了承→直前約束の復唱／質問→回答。お客様の今回のメッセージにだけ応答し、過去の費用話題を蒸し返さない。"
  );
}
