// app/lib/aix-jev.ts
// ブレインの判定部品: 「今この会話でどの AIX ボタンか」「物件確認したなら何を確認するピッカーか」を Jev（System One）に選ばせる。
//
// 2026-09-23 竹内「AIX でどのピッカーを選択するかの部分は Jev で強化できるかな」「ここに Jev をつかう。
//   ピッカーどれ選ぶかの判断は状況によって変わるけど、Jev がブレインの一部にいてそこから選択するのが一番質上がる気がする」
//
// ── 何を Jev に聞き、何を聞かないか ──
//   ピッカーには2種類の中身が混ざっている:
//     ・「何を確認したか」（室内写真・入居可能日・初期費用・保証会社・駐車場・ペット・設備・別の部屋）
//        → お客様が何を求めたかで決まる＝会話から当てられる＝Jev に聞く（check_topic）
//     ・「確認の結果」（物件あった／なかった／別の部屋が募集してた／専任だった）
//        → 現場の事実。会話からは分からない＝Jev には聞かない（スタッフが選ぶ）
//   AIX の種類（next_aix）も同じく会話から当てられるので聞く。正解は aix_usage_logs（押した AIX・check_pattern）。
//
// ── 原則 ──
//   ・AIX の要否・種類・ピッカーは**ブレインだけ**が決める。ここはブレインが使う部品で、直接 UI や通知には出さない。
//   ・最初は影の運用（jev_shadow_logs に記録するだけ）。scripts/eval-jev-aix.ts で正答率を測り、
//     上回った判定だけブレインの決定論に繋ぐ（確率の線: 例 0.8 以上は決定論でセット・0.5〜0.8 は2択・以下は無し）。
//   ・state は**仮名化した後**の文だけ入れる（呼び出し側の責任。ここは純関数）。
//   ・Jev は state を「データ」として読む。指示文で誘導しない（質問文と選択肢の説明で決める）。
import { AIX_BUTTON_LABELS } from "./aix-taxonomy";
import { jevSystemOne, type JevAnswer, type JevQuestion, type JevResult } from "./jev-client";

// ─── 選択肢: AIX ボタン ────────────────────────────────────────────────────────
// AIX_BUTTON_LABELS（app/lib/aix-taxonomy.ts）の全キー＋ none。説明は「どういう場面で押すか」（Jev の criteria）。
export const JEV_AIX_OPTIONS: Record<string, string> = {
  none:                    "スタッフの操作は要らない。返信文だけで足りる、または返す必要が無い",
  acknowledge_check:       "お客様が特定の物件の空室・募集状況を聞き、これから管理会社に確認すると伝える場面",
  property_check_result:   "管理会社・手元の資料で確認した結果（募集状況・入居可能日・室内写真・条件）をお客様に報告する場面",
  property_send:           "お客様の条件に合う物件をスタッフが選んで送る（ピックアップして届ける）場面",
  property_recommendation: "特定の物件を勧める文を、物件資料の画像から作って送る場面",
  estimate_sheet:          "お客様が気に入った物件の初期費用の見積書を作って送る場面（物件が届いた・見積を頼まれた）",
  viewing_invite:          "内覧の日程を調整する場面（内覧したい・日程の希望が出た）",
  meeting_place:           "内覧当日の待ち合わせ場所・時間を案内する場面",
  greeting_viewing:        "内覧の前後の挨拶（当日の朝・内覧のお礼）",
  condition_hearing:       "希望条件（エリア・家賃・間取り・入居時期）をまだ聞けていない初回の場面",
  application_push:        "お客様が申込の意思を示し、申込の手続き・必要書類を案内する場面",
  followup_revive:         "返信が途絶えたお客様に追客する場面",
  property_search:         "条件から物件を検索する場面",
  cost_explain:            "初期費用の安さを不審に思われた・安い理由を聞かれ、仕組みを説明する場面",
  cost_breakdown:          "初期費用の中身（何が含まれるか・家賃だけで入居できるか）を聞かれ、見積書の内訳で答える場面",
  phone_call:              "お客様が電話で話したいと言い、電話をかける案内をする場面",
  phone_followup:          "電話が終わった後のまとめを送る場面",
  guarantor_info:          "保証会社の名前・種類・並行審査について聞かれた場面",
};

// ─── 選択肢: 物件確認したの「何を確認するか」 ─────────────────────────────────
export const JEV_CHECK_TOPIC_OPTIONS: Record<string, string> = {
  none:           "物件確認したの場面ではない",
  availability:   "特定の物件の空室・募集状況（まだ募集しているか）",
  interior_photo: "室内の写真・動画・室内イメージURL を見たい",
  other_room:     "同じ建物の別の部屋・別の間取りがあるか",
  move_in_date:   "いつから入居できるか・退去予定日・入居可能日",
  initial_cost:   "初期費用・礼金・敷金・家賃の交渉（安くできないか）",
  guarantor:      "保証会社・保証人・審査の条件",
  parking:        "駐車場・駐輪場・近隣の月極駐車場",
  pet:            "ペットを飼えるか",
  equipment:      "設備（エアコン・ネット・ガス・洗濯機置き場など）",
  proxy:          "代理契約・名義（本人以外が契約できるか）",
};

/** aix_usage_logs.check_pattern → Jev の topic（答え合わせ用）。結果のピッカー（available 等）は availability に寄せる */
export const CHECK_PATTERN_TO_TOPIC: Record<string, string> = {
  available: "availability", unavailable: "availability", alternative: "availability", exclusive: "availability",
  mgmt_availability: "availability",
  interior_photo: "interior_photo",
  other_room_check: "other_room",
  move_in_date: "move_in_date", mgmt_move_in: "move_in_date", vacate_date: "move_in_date",
  mgmt_initial_cost: "initial_cost",
  mgmt_guarantor: "guarantor",
  mgmt_parking: "parking", nearby_parking: "parking",
  mgmt_pet: "pet",
  mgmt_equipment: "equipment",
  mgmt_proxy: "proxy",
};

/** Jev の topic → ブレインが suggested_aix_meta.check_pattern に入れる値（結果のピッカーは null＝スタッフが選ぶ） */
export const TOPIC_TO_CHECK_PATTERN: Record<string, string | null> = {
  none: null,
  availability: null,
  interior_photo: "interior_photo",
  other_room: "other_room_check",
  move_in_date: "mgmt_move_in",
  initial_cost: "mgmt_initial_cost",
  guarantor: "mgmt_guarantor",
  parking: "mgmt_parking",
  pet: "mgmt_pet",
  equipment: "mgmt_equipment",
  proxy: "mgmt_proxy",
};

/** 「何を確認したか」のピッカー（会話から当てられる）。結果のピッカーは含めない */
export const TOPIC_CHECK_PATTERNS = new Set(Object.keys(CHECK_PATTERN_TO_TOPIC).filter((p) => CHECK_PATTERN_TO_TOPIC[p] !== "availability"));

// ─── state ────────────────────────────────────────────────────────────────────
export type JevStateMessage = { sender: string; text: string | null | undefined; createdAt?: string | null; isAix?: boolean };
export type JevStateInput = {
  /** 仮名化済みの直近の会話（古い→新しい） */
  messages: ReadonlyArray<JevStateMessage>;
  status?: string | null;
  /** こちらが送った物件の数（ledger 等から） */
  sentPropertyCount?: number | null;
  /** 見積書を送った後か */
  estimateSent?: boolean | null;
  /** 直前に押した AIX（aix_usage_logs） */
  lastAixType?: string | null;
  /** 何通まで入れるか（既定 8） */
  limit?: number;
};

/** Jev に渡す state（JSON）。個人情報は呼び出し側で仮名化済みの前提 */
export function buildJevState(input: JevStateInput): Record<string, unknown> {
  const limit = input.limit ?? 8;
  const msgs = input.messages.slice(-limit).map((m) => ({
    who: m.sender === "customer" ? "お客様" : m.isAix ? "スタッフ（AIX）" : "スタッフ",
    text: String(m.text ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
  })).filter((m) => m.text.length > 0);
  return {
    conversation: msgs,
    latest_customer_message: [...msgs].reverse().find((m) => m.who === "お客様")?.text ?? "",
    status: input.status ?? null,
    properties_sent_by_staff: input.sentPropertyCount ?? null,
    estimate_sent: input.estimateSent ?? null,
    last_aix_pressed: input.lastAixType ?? null,
  };
}

// ─── questions ────────────────────────────────────────────────────────────────
export function buildAixJevQuestions(): Record<string, JevQuestion> {
  return {
    next_aix: {
      type: "choice",
      instructions: "latest_customer_message と conversation を読み、スタッフが今押すべき AIX ボタンを1つ選ぶ",
      criteria: JEV_AIX_OPTIONS,
    },
    check_topic: {
      type: "choice",
      instructions: "お客様が今、物件について何の確認を求めているか（物件確認したの場面でなければ none）",
      criteria: JEV_CHECK_TOPIC_OPTIONS,
    },
    photo_request: {
      type: "noul",
      instructions: "latest_customer_message は、室内の写真・動画・室内イメージURL を送ってほしいという依頼か",
      criteria: { true: "写真・動画・URL を見たい・送ってほしい", false: "それ以外（写真を送ってきた・お礼・別の話題）" },
    },
  };
}

// ─── answers → ブレインが使う形 ───────────────────────────────────────────────
export type AixJevDecision = {
  aix: string;                 // JEV_AIX_OPTIONS のキー（none を含む）
  aixProb: number;             // 選んだ AIX の確率
  aixConfidence: number | null;
  aixProbabilities: Record<string, number>;
  checkTopic: string;          // JEV_CHECK_TOPIC_OPTIONS のキー
  checkTopicProb: number;
  checkPattern: string | null; // suggested_aix_meta.check_pattern に入れる値（結果のピッカーは null）
  photoRequestProb: number | null;
};

function choiceOf(a: JevAnswer | undefined): { choice: string; prob: number; confidence: number | null; probabilities: Record<string, number> } | null {
  if (!a || a.type !== "choice" || typeof a.choice !== "string") return null;
  const probabilities = a.probabilities ?? {};
  const prob = typeof probabilities[a.choice] === "number" ? probabilities[a.choice] : 1;
  return { choice: a.choice, prob, confidence: typeof a.confidence === "number" ? a.confidence : null, probabilities };
}

export function parseAixJevAnswers(answers: Record<string, JevAnswer> | null | undefined): AixJevDecision | null {
  const aix = choiceOf(answers?.next_aix);
  if (!aix || !(aix.choice in JEV_AIX_OPTIONS)) return null;
  const topic = choiceOf(answers?.check_topic);
  const checkTopic = topic && topic.choice in JEV_CHECK_TOPIC_OPTIONS ? topic.choice : "none";
  const photo = answers?.photo_request;
  return {
    aix: aix.choice, aixProb: aix.prob, aixConfidence: aix.confidence, aixProbabilities: aix.probabilities,
    checkTopic, checkTopicProb: topic?.prob ?? 0,
    checkPattern: aix.choice === "property_check_result" ? (TOPIC_TO_CHECK_PATTERN[checkTopic] ?? null) : null,
    photoRequestProb: photo && photo.type === "noul" && typeof photo.noul === "number" ? photo.noul : null,
  };
}

// ─── 呼び出し ─────────────────────────────────────────────────────────────────
export type AixJevEvaluation = { decision: AixJevDecision; raw: JevResult };

/**
 * Jev に AIX とピッカーを選ばせる。鍵が無い・失敗は null（ブレインは今までどおり）。
 * ⚠ state の文は仮名化済みで渡す（pii-pseudonym）。申込以降の会話は呼ばない（呼び出し側で post-apply を見る）。
 */
export async function evaluateAixWithJev(
  input: JevStateInput & { conversationId?: string | null; timeoutMs?: number; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch },
): Promise<AixJevEvaluation | null> {
  const raw = await jevSystemOne({
    state: buildJevState(input), questions: buildAixJevQuestions(),
    action: "aix_picker", conversationId: input.conversationId ?? null, timeoutMs: input.timeoutMs, env: input.env, fetchImpl: input.fetchImpl,
  });
  if (!raw) return null;
  const decision = parseAixJevAnswers(raw.answers);
  return decision ? { decision, raw } : null;
}

/** 影の運用の1行（jev_shadow_logs）。ブレインの判断と並べて後で答え合わせする */
export type JevShadowRow = {
  conversation_id: string;
  customer_msg_at: string | null;
  brain_action: string | null;
  brain_check_pattern: string | null;
  jev_action: string;
  jev_action_prob: number;
  jev_check_topic: string;
  jev_check_topic_prob: number;
  jev_check_pattern: string | null;
  jev_photo_request_prob: number | null;
  jev_confidence: number | null;
  jev_model: string;
  jev_ms: number;
  answers: Record<string, unknown>;
};

export function toShadowRow(conversationId: string, customerMsgAt: string | null, brain: { action?: string | null; check_pattern?: string | null } | null, ev: AixJevEvaluation): JevShadowRow {
  const d = ev.decision;
  return {
    conversation_id: conversationId, customer_msg_at: customerMsgAt,
    brain_action: brain?.action ?? null, brain_check_pattern: brain?.check_pattern ?? null,
    jev_action: d.aix, jev_action_prob: d.aixProb, jev_check_topic: d.checkTopic, jev_check_topic_prob: d.checkTopicProb,
    jev_check_pattern: d.checkPattern, jev_photo_request_prob: d.photoRequestProb, jev_confidence: d.aixConfidence,
    jev_model: ev.raw.model, jev_ms: ev.raw.ms, answers: ev.raw.answers as Record<string, unknown>,
  };
}

/** 影の運用: 記録だけ（失敗しても投げない） */
export async function recordJevShadow(sb: { from: (t: string) => any }, row: JevShadowRow): Promise<void> {
  try {
    const { error } = await sb.from("jev_shadow_logs").insert(row);
    if (error) console.warn("[jev-shadow] insert failed:", error.message);
  } catch (e) {
    console.warn("[jev-shadow] insert failed:", e instanceof Error ? e.message : String(e));
  }
}

// ─── ボタンが決まった後: そのボタンのピッカーを Jev が選ぶ ──────────────────────
// 2026-09-23 竹内「AIX のボタンの中でどのピッカーを選ぶのか判断する形。AIX ボタンのところはもう既存で選択されているので、
//   そこから AIX ボタンのそれぞれのピッカーの種類・内容を Jev が分かっていればどのボタンを押すべきか判断できる」
//
// ボタンごとのピッカー（AixModal.tsx の実物・aix_usage_logs の列名で持つ）:
//   ・物件確認した   check_pattern … 「何を確認したか」（JEV_CHECK_TOPIC_OPTIONS）。結果（あった／なかった）は会話から分からないのでスタッフ
//   ・物件ピックアップした send_mode … 新規／新着／条件を広げた／代替
//   ・申込へ！       app_sub_mode … 申込誘導／申込確定／フォーマット／書類依頼
//   ・物件オススメ   send_mode … 新着／条件を広げた（物件ピックアップしたと同じ語）
// 質問はボタンごとに1つ（選択肢が狭いほど当たる）。state に「押すボタン」を入れて、その中から選ばせる。
export type PickerField = "check_pattern" | "send_mode" | "app_sub_mode";

export const AIX_PICKER_CATALOG: Record<string, { field: PickerField; question: string; options: Record<string, string> }> = {
  property_check_result: {
    field: "check_pattern",
    question: "AIX【物件確認した】を押す。お客様が求めている確認は何か（結果のあった／なかったは聞かない）",
    options: JEV_CHECK_TOPIC_OPTIONS,
  },
  property_send: {
    field: "send_mode",
    question: "AIX【物件ピックアップした】を押す。今回送る物件はどのモードか",
    options: {
      normal:      "新規物件: 希望条件に合う物件を（初めて、または通常どおり）ピックアップして送る",
      new_arrival: "新着物件: 以前に物件を送った後、新しく出た物件を追加で送る（継続の追客）",
      widen:       "条件を広げた: 希望どおりの物件が無く、エリア・家賃・間取りなどを広げて探した物件を送る",
      alternative: "代替: 気に入っていた物件が満室・紹介不可だったので、代わりの物件を送る",
    },
  },
  property_recommendation: {
    field: "send_mode",
    question: "AIX【物件オススメ】を押す。今回勧める物件はどのモードか",
    options: {
      normal:      "通常: 希望条件に合う物件を勧める",
      new_arrival: "新着物件: 以前に物件を送った後、新しく出た物件を勧める",
      widen:       "条件を広げた: 希望どおりの物件が無く、条件を広げて探した物件を勧める",
    },
  },
  application_push: {
    field: "app_sub_mode",
    question: "AIX【申込へ！】を押す。今の場面はどれか",
    options: {
      push:         "申込誘導: 内覧の後などに、申込を後押しするメッセージを送る（まだ申込を決めていない）",
      confirm:      "申込確定: お客様が申込を決めたので、確定のご連絡と次の手順を送る",
      format:       "フォーマット: 申込書（記入フォーマット）を送る（申込に進む・記入項目を案内する）",
      docs_request: "書類依頼: 申込に不足している書類（本人確認書類・収入証明など）を確認・依頼する",
    },
  },
};

/** そのボタンにピッカーがあるか */
export function hasPickerQuestion(aixType: string | null | undefined): boolean {
  return !!aixType && aixType in AIX_PICKER_CATALOG;
}

export function buildPickerQuestion(aixType: string): JevQuestion | null {
  const c = AIX_PICKER_CATALOG[aixType];
  if (!c) return null;
  return { type: "choice", instructions: c.question, criteria: c.options };
}

export type PickerJevDecision = {
  aixType: string;
  field: PickerField;
  picker: string;                 // 選択肢のキー（check_pattern の時は topic。suggested の値は pickerValue）
  pickerValue: string | null;     // aix_usage_logs／suggested_aix_meta に入れる値（availability は null＝スタッフが結果を選ぶ）
  prob: number;
  confidence: number | null;
  probabilities: Record<string, number>;
};

export function parsePickerJevAnswer(aixType: string, answer: JevAnswer | undefined): PickerJevDecision | null {
  const c = AIX_PICKER_CATALOG[aixType];
  const a = choiceOf(answer);
  if (!c || !a || !(a.choice in c.options)) return null;
  const pickerValue = c.field === "check_pattern" ? (TOPIC_TO_CHECK_PATTERN[a.choice] ?? null) : a.choice;
  return { aixType, field: c.field, picker: a.choice, pickerValue, prob: a.prob, confidence: a.confidence, probabilities: a.probabilities };
}

/**
 * ボタンが決まっている時、そのピッカーを Jev に選ばせる。ピッカーの無いボタン・鍵なし・失敗は null。
 * ⚠ state の文は仮名化済みで渡す。
 */
export async function evaluatePickerWithJev(
  input: JevStateInput & { aixType: string; conversationId?: string | null; timeoutMs?: number; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch },
): Promise<{ decision: PickerJevDecision; raw: JevResult } | null> {
  const q = buildPickerQuestion(input.aixType);
  if (!q) return null;
  const state = { ...buildJevState(input), chosen_aix_button: AIX_BUTTON_LABELS[input.aixType] ?? input.aixType };
  const raw = await jevSystemOne({
    state, questions: { picker: q },
    action: `picker:${input.aixType}`, conversationId: input.conversationId ?? null, timeoutMs: input.timeoutMs, env: input.env, fetchImpl: input.fetchImpl,
  });
  if (!raw) return null;
  const decision = parsePickerJevAnswer(input.aixType, raw.answers.picker);
  return decision ? { decision, raw } : null;
}

// 設計知見「同じ事実を2か所に置かない」: 選択肢が AIX_BUTTON_LABELS とずれたら起動時に気付く
for (const k of Object.keys(AIX_BUTTON_LABELS)) {
  if (!(k in JEV_AIX_OPTIONS)) throw new Error(`aix-jev: AIX_BUTTON_LABELS の「${k}」が JEV_AIX_OPTIONS に無い`);
}
