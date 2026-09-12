// app/lib/aix-scene-evidence.ts
// 2026-09-12 竹内方針「AIX のセットはブレインが判断する」統合設計 段1:
//   決定論の場面検出（S1〜S7）を「判断」から切り離し、「証拠」だけを返す純関数にする。
//   この関数は AIX を決めない。使い道は2つだけ:
//     (a) ブレインへの入力（brain-core の分析モード判定・段2でプロンプトの証拠欄）
//     (b) 本文の安全（aix-reply-set.ts resolveBodySafety: 断言しない・橋渡し文・確認約束の根拠）
//   AIX をセットするか・どの AIX か・check_pattern はブレイン（brain-core analyzeConversation）だけが決める。
// 検出の中身は 2c86c209 の aix-reply-set.ts detectReplyAixScene から変えずに移設した（期待値も同じ）。
// 依存は scene-patterns / line-reply-prompts の定数 / estimate-context の型だけ（brain-core から import しても循環しない）。
import { isConditionFormMessage } from "./line-reply-prompts";
import type { EstimateContextVerdict } from "./estimate-context";
import {
  allVacancyWordsAreSlots, SLOT_AVAILABILITY_Q_RE, MOVEIN_Q_RE, SCREENING_Q_RE, VIEWING_INTENT_RE, TIME_SPEC_RE, TIME_REQUEST_RE,
} from "./scene-patterns";

export type PropertyStatusLite = "move_out_scheduled" | "occupied" | "vacant" | "unknown";
export type SceneId = "S1_vacancy" | "S2_move_in" | "S3_screening" | "S4_viewing" | "S5_time_spec" | "S6_estimate" | "S7_condition_change" | "application";

export type SceneEvidenceInput = {
  /** 今回の顧客発言（スタッフ文は含めない。未返信の連投全体） */
  latestCustomerTurn: string;
  /** 直前スタッフ発言より後に顧客が画像を送った */
  hasCustomerImage: boolean;
  /** oldest-first */
  recentMessages?: ReadonlyArray<{ sender: string; text?: string | null; isAix?: boolean | null }>;
  /** 直近の AIX 使用（aix_usage_logs） */
  aixHistory?: ReadonlyArray<{ aix_type?: string | null; check_pattern?: string | null }>;
  /** 行動台帳の送付物件数（ledger.facts.propertiesSentCount） */
  sentPropertyCount?: number;
  propertyStatus?: PropertyStatusLite;
  /** isMisumoriContextAppropriate() の verdict（見積判定の単一真実源） */
  estimateVerdict?: EstimateContextVerdict | null;
};

/** 決定論の場面の証拠（判断ではない） */
export type AixSceneEvidence = {
  scene: SceneId;
  /** その場面でスタッフが押すことの多い AIX（候補。決定ではない） */
  candidateAction: string;
  checkPattern: string | null;
  timing: "now" | "after_confirm";
  /** 見積の連結（S1/S2 で見積 declare が同時に成立） */
  chained: string | null;
  reasonCode: string;
  /** 物件を特定した根拠（S1〜S3） */
  propertySpecifiedBy: "image" | "url" | "room_no" | "which_room" | "property_word" | "demonstrative" | null;
  /** S6: 見積は既に約束/送付済みで支払い意思だけが来た */
  echoPayment?: boolean;
  matchedText: string;
};

// ─── 募集状況の質問（旧 route.ts detectAvailabilityCheckContext。route.ts の availabilityCheckNote もこの関数を使う）───
export const AVAILABILITY_URL_RE = /https?:\/\/|suumo|homes\.co\.jp|athome|itandi|rea-?pro|リアプロ|レインズ|ietty|chintai/i;
export const AVAILABILITY_PROPERTY_RE = /マンション|ハイツ|コーポ|レジデンス|ハイム|メゾン|アパート|グランド|シャトー|[0-9０-９]{2,4}\s*号室|(?:この|こちらの|その|さっきの|先ほどの)(?:物件|お?部屋)|物件資料|物件/;
const AVAILABILITY_EXPLICIT_RE = /空(?:き|いて|いている|室)|募集(?:中|状況|して|出て|され)|まだ(?:あり|空|募集|残|大丈夫)|埋ま(?:って|り)|申込(?:み)?(?:入って|は入|ありま)/;
const AVAILABILITY_QUESTION_RE = /ありますか|あります？|ますか|ですか|でしょうか|いかが|どう(?:です|でしょう)|教えて|知りたい|[?？]/;
const AVAILABILITY_EXCLUDE_RE = /見積|初期費用|スモ割|総額|内覧|内見|見学/;

export function detectAvailabilityCheckContext(customerMessage: string): boolean {
  const msg = (customerMessage || "").trim();
  if (!msg) return false;
  if (AVAILABILITY_EXCLUDE_RE.test(msg)) return false;
  // 2026-09-12 竹内方針A-3（82e2d5cf）: 「明日ってまだ空いてますか」は内覧枠の質問（scene-patterns の時間枠判定と共有）
  if (allVacancyWordsAreSlots(msg) && !/空(?:き|室)|募集|埋ま|申込/.test(msg)) return false;
  if (AVAILABILITY_EXPLICIT_RE.test(msg)) return true;
  if (AVAILABILITY_URL_RE.test(msg)) return true;
  return AVAILABILITY_PROPERTY_RE.test(msg) && AVAILABILITY_QUESTION_RE.test(msg);
}

// 旧 detectAixTiming の定数（P0 物件指名語・支払い意思・条件変更）
export const AIX_NOMINATION_RE = /空(?:室|き|いて)|取り扱い|募集|ありますか|この(?:物件|お?家|部屋)/;
export const AIX_PAYMENT_INTENT_RE = /払えま|払える|支払えま|即日[^\n]{0,10}(?:払|入金|振り?込)|用意でき|振り?込め|一括で払/;
export const AIX_CONDITION_CHANGE_RE =/(?:もう少し|もっと|さらに)[^\n]{0,12}(?:広|安|大き|新し|駅近|きれい|綺麗|抑え)|(?:上がって|高くて|上げて)も(?:構い|大丈夫|OK|いい)|でも(?:大丈夫|構い|いいです|良いです)|のみで(?:調べ|探し|お願い)|仕切れる|条件[^\n]{0,8}(?:変更|追加|緩和|広げ)/;
/** 物件の特定（号室・「どの部屋」・送付物件への指示語） */
const ROOM_NO_RE = /[0-9０-９]{3,4}\s*号室?/;
const WHICH_ROOM_RE = /どの(?:お?部屋|物件|号室)/;
const DEMONSTRATIVE_RE = /こちら|この|その|そちら|ここ|そこ|さっき|先ほど|先程|送って(?:もらった|頂いた|いただいた|くださった)|お送り(?:頂いた|いただいた)|[①-⑩]|[0-9０-９]+(?:件目|つ目|番目)/;

/** 物件を特定した根拠（null = 特定できない） */
export function propertySpecifiedBy(msg: string, o: { hasCustomerImage: boolean; sentPropertyCount?: number }): AixSceneEvidence["propertySpecifiedBy"] {
  if (o.hasCustomerImage) return "image";
  if (AVAILABILITY_URL_RE.test(msg)) return "url";
  if (ROOM_NO_RE.test(msg)) return "room_no";
  if (WHICH_ROOM_RE.test(msg)) return "which_room";
  if (AVAILABILITY_PROPERTY_RE.test(msg)) return "property_word";
  if ((o.sentPropertyCount ?? 0) > 0 && DEMONSTRATIVE_RE.test(msg)) return "demonstrative";
  return null;
}

/** 物件が特定できるか（S1/S2/S3 の前提） */
export function isPropertySpecified(msg: string, o: { hasCustomerImage: boolean; sentPropertyCount?: number }): boolean {
  return propertySpecifiedBy(msg, o) !== null;
}

export function hasViewingInviteBefore(o: Pick<SceneEvidenceInput, "aixHistory" | "recentMessages">): boolean {
  if ((o.aixHistory ?? []).some((a) => a.aix_type === "viewing_invite")) return true;
  const staff = (o.recentMessages ?? []).filter((m) => m.sender === "staff").slice(-5);
  return staff.some((m) => /ご都合よろしいお日にち|ご内覧可能な日程|内覧日程|ご案内可能(?:な|です)|ご案内させて頂けます/.test(m.text ?? ""));
}

/** 決定論の場面の証拠（生成前・生成後・ブレインで同じ）。AIX は決めない */
export function detectAixSceneEvidence(o: SceneEvidenceInput): AixSceneEvidence | null {
  const msg = (o.latestCustomerTurn || "").trim();
  if (!msg && !o.hasCustomerImage) return null;
  const v = o.estimateVerdict ?? null;
  const estimateDeclare = !!v && v.mode === "declare";
  // 条件フォームのみ（trigger=none）は金額・指名判定を行わない
  if (isConditionFormMessage(msg) && !estimateDeclare) return null;

  const specBy = propertySpecifiedBy(msg, { hasCustomerImage: o.hasCustomerImage, sentPropertyCount: o.sentPropertyCount });
  const specified = specBy !== null;
  const slotQuestion = SLOT_AVAILABILITY_Q_RE.test(msg);
  const ev = (e: Omit<AixSceneEvidence, "matchedText" | "propertySpecifiedBy"> & { propertySpecifiedBy?: AixSceneEvidence["propertySpecifiedBy"] }): AixSceneEvidence =>
    ({ propertySpecifiedBy: null, ...e, matchedText: msg.slice(0, 120) });

  // S1 空室確認: 旧 P0（画像/URL＋指名語、URLのみ・画像のみ）＋ 文字だけの空室質問で物件が特定できる場合
  const hasPropertyUrl = AVAILABILITY_URL_RE.test(msg);
  if (o.hasCustomerImage || hasPropertyUrl) {
    const urlOnly = hasPropertyUrl && msg.replace(/https?:\/\/\S+/g, "").trim().length <= 10;
    const imageOnly = o.hasCustomerImage && msg.length <= 10;
    if ((AIX_NOMINATION_RE.test(msg) && !slotQuestion) || urlOnly || imageOnly) {
      return ev({ scene: "S1_vacancy", candidateAction: "property_check_result", checkPattern: null, timing: "after_confirm", chained: estimateDeclare ? "estimate_sheet" : null, reasonCode: "property_nomination", propertySpecifiedBy: specBy });
    }
  }
  // S2 入居日（物件あり）/ S3 審査（物件あり）: 「この物件の〜ですか？」は募集状況の質問形にも当たるので、文字だけの S1 より先に見る
  if (MOVEIN_Q_RE.test(msg) && specified) {
    const cp = o.propertyStatus === "move_out_scheduled" ? "vacate_date" : "mgmt_move_in";
    return ev({ scene: "S2_move_in", candidateAction: "property_check_result", checkPattern: cp, timing: "after_confirm", chained: estimateDeclare ? "estimate_sheet" : null, reasonCode: "move_in_question", propertySpecifiedBy: specBy });
  }
  if (SCREENING_Q_RE.test(msg) && specified) {
    return ev({ scene: "S3_screening", candidateAction: "property_check_result", checkPattern: "mgmt_guarantor", timing: "after_confirm", chained: null, reasonCode: "screening_question", propertySpecifiedBy: specBy });
  }
  if (!slotQuestion && specified && detectAvailabilityCheckContext(msg)) {
    return ev({ scene: "S1_vacancy", candidateAction: "property_check_result", checkPattern: null, timing: "after_confirm", chained: estimateDeclare ? "estimate_sheet" : null, reasonCode: "availability_question", propertySpecifiedBy: specBy });
  }

  // S6 見積（verdict が declare の時のみ。語出現では出さない）
  if (estimateDeclare) {
    return ev({ scene: "S6_estimate", candidateAction: "estimate_sheet", checkPattern: null, timing: "now", chained: null, reasonCode: `estimate_${v?.trigger ?? "declare"}`, echoPayment: false });
  }
  if (v?.mode === "echo_only" && AIX_PAYMENT_INTENT_RE.test(msg)) {
    return ev({ scene: "S6_estimate", candidateAction: "estimate_sheet", checkPattern: null, timing: "now", chained: null, reasonCode: "estimate_echo_payment", echoPayment: true });
  }

  // S7 条件変更
  if (AIX_CONDITION_CHANGE_RE.test(msg)) {
    return ev({ scene: "S7_condition_change", candidateAction: "property_send", checkPattern: null, timing: "now", chained: null, reasonCode: "condition_change" });
  }

  // S5 日時の指定（viewing_invite を送った後の「9/9の15時からお願いします」）
  if (TIME_SPEC_RE.test(msg) && TIME_REQUEST_RE.test(msg) && hasViewingInviteBefore(o)) {
    return ev({ scene: "S5_time_spec", candidateAction: "meeting_place", checkPattern: null, timing: "now", chained: null, reasonCode: "time_spec_after_viewing_invite" });
  }

  // S4 内覧希望（退去予定/入居中は現地内覧不可のため対象外）
  if ((VIEWING_INTENT_RE.test(msg) || slotQuestion) && o.propertyStatus !== "move_out_scheduled" && o.propertyStatus !== "occupied") {
    return ev({ scene: "S4_viewing", candidateAction: "viewing_invite", checkPattern: null, timing: "now", chained: null, reasonCode: slotQuestion ? "viewing_slot_question" : "viewing_intent" });
  }
  return null;
}

/** 確認が要る質問の場面（本文で「確認いたします」を認める根拠） */
export function isConfirmationScene(e: AixSceneEvidence | null | undefined): boolean {
  return !!e && (e.scene === "S1_vacancy" || e.scene === "S2_move_in" || e.scene === "S3_screening");
}

/**
 * お客様から物件確認（募集状況・入居日・審査）の依頼があったか。
 * 2026-09-12 竹内「物件確認したもお客さんから物件確認の依頼があった場合となる」:
 *   物件確認タスク（→ AIX「物件確認した」）の自動作成はこの判定が true の時だけ。
 *   旧: こちらが物件ピックアップ/物件オススメを送った直後に「次の工程」として自動作成 → 60日で 396件中 371件がこれ（依頼なし）。
 * 見るのは「スタッフが今応えようとしている顧客の発言」＝末尾のスタッフ発言を除いた、最後の顧客発言のまとまりだけ（古い依頼で再作成しない）。
 * 判定は本文の安全と同じ detectAixSceneEvidence / isConfirmationScene（S1 空室・S2 入居日・S3 審査）を使う（四者同名）。
 */
export function customerRequestedPropertyCheck(o: {
  /** oldest-first */
  recentMessages: ReadonlyArray<{ sender: string; text?: string | null }>;
  /** 送付物件数（省略時は URL を含むスタッフ発言数で近似。「こちら」「2件目」等の指示語を物件の特定として認めるため） */
  sentPropertyCount?: number;
}): boolean {
  const msgs = [...o.recentMessages];
  while (msgs.length && msgs[msgs.length - 1].sender !== "customer") msgs.pop();
  const turn: string[] = [];
  let hasCustomerImage = false;
  for (let i = msgs.length - 1; i >= 0 && msgs[i].sender === "customer"; i--) {
    const t = (msgs[i].text ?? "").trim();
    if (/^\[画像\]/.test(t)) hasCustomerImage = true;
    else if (t) turn.unshift(t);
  }
  if (!turn.length && !hasCustomerImage) return false;
  const text = turn.join("\n");
  const sentPropertyCount = o.sentPropertyCount
    ?? o.recentMessages.filter((m) => m.sender === "staff" && /https?:\/\//.test(m.text ?? "")).length;
  // ① 募集状況・入居日・審査の質問（本文の安全と同じ判定）
  if (isConfirmationScene(detectAixSceneEvidence({ latestCustomerTurn: text, hasCustomerImage, sentPropertyCount }))) return true;
  if (isConditionFormMessage(text)) return false;
  const specBy = propertySpecifiedBy(text, { hasCustomerImage, sentPropertyCount });
  // ② お客様が物件そのもの（画像・URL・号室）を送ってきた → 募集状況の確認と御見積書が業務の流れ（竹内 2026-09-10）
  if (specBy === "image" || specBy === "url" || specBy === "room_no") return true;
  // ③ 物件を指して（この物件・こちら・2件目 等）初期費用・見積・内覧・確認を頼んだ
  const pointsAtProperty = specBy === "which_room" || specBy === "demonstrative" || SPECIFIC_PROPERTY_RE.test(text);
  return pointsAtProperty && PROPERTY_REQUEST_RE.test(text);
}
/** 特定の物件を指す語（「物件」「マンション」単独の探索依頼は含めない） */
const SPECIFIC_PROPERTY_RE = /(?:この|こちらの|その|さっきの|先ほどの)(?:物件|お?部屋)|物件資料/;
/** 物件についての依頼語 */
const PROPERTY_REQUEST_RE = /確認(?:して|お願い|頂け|いただけ|でき|出来)|知りたい|教えて|いくら|初期費用|見積|内覧|内見|見学|住所|気にな/;
