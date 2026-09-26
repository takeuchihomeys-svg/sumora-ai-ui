// app/lib/aix-reply-set.ts
// 2026-09-12 竹内方針「AIX のセットはブレインが判断する」統合設計 段1:
//   AIX をセットするか・どの AIX か・check_pattern・enforcement は **ブレイン（brain-core analyzeConversation）だけ** が決める。
//   この関数（resolveReplyAix）はブレインの判断を読んで、画面・トレーラー・ai_draft_check・プロンプトに載せる形に整えるだけ。
//   場面表 S1〜S7（aix-scene-evidence.ts detectAixSceneEvidence）は判断者ではなく、
//     (a) ブレインへの入力（証拠）
//     (b) 本文の安全（resolveBodySafety: 断言しない・橋渡し文・確認約束の根拠）
//   の2役だけを持つ。場面ヒットから AIX を足すことはしない（学習されない判断を増やさない）。
//
// resolveReplyAix の見る順番
//   1. 下書きを作らない段階（DRAFT_SKIP_STATUSES）・初回返信 → null
//   2. ブレインの判断が今回の顧客発言より古い（T2/T3）・cached → AIX は null（本文の安全は resolveBodySafety で別に返す）
//   3. fresh で action がある → action / check_pattern はブレインの値のまま（判定し直さない）。
//      timing / bridge / forbidden は sceneSafetyRow（決まった AIX から行を引く＋証拠から本文の安全を引く）
//   4. fresh で action='' → null（場面表が AIX を足さない）
//   5. unresolvedBlock（final-check で直せなかった断言）は AIX を選ばない。ブレインに action があれば required に上げ、
//      無ければ stopAutoSend だけを返す（自動送信を止めるのは安全のため）
import { AIX_ACTION_REPLY_DIRECTION, AIX_BUTTON_LABELS, AIX_STAFF_NOTES, availabilityCheckButtonLabel } from "./aix-taxonomy";
import { DRAFT_SKIP_STATUSES } from "./conversation-status";
import { BRIDGE_VACANCY_CHECK, BRIDGE_MOVEIN_CHECK, BRIDGE_SCREENING_CHECK, ASSERTION_REPLACEMENT } from "./scene-patterns";
import {
  AVAILABILITY_URL_RE, AIX_PAYMENT_INTENT_RE, detectAixSceneEvidence, isConfirmationScene,
  type AixSceneEvidence, type SceneEvidenceInput, type SceneId, type PropertyStatusLite,
} from "./aix-scene-evidence";

export type { SceneId, PropertyStatusLite };
/** 本文で書かない範囲（断言検査のコード） */
export type ForbiddenCode = "VACANCY_ASSERTION" | "VIEWING_BEFORE_VACANCY" | "MOVEIN_DATE_ASSERTION" | "SCREENING_ASSURANCE" | "VIEWING_DATETIME" | "MEETING_DETAIL" | "ESTIMATE_AMOUNT" | "INVENTORY_ASSERTION" | "COST_BREAKDOWN";

export type ReplyAix = {
  action: string;
  check_pattern: string | null;
  /** ボタン名（スタッフ向け・プロンプト向け） */
  label: string;
  /** now = この返信と一緒に AIX を送る／after_confirm = 本文は確認宣言、確認後に AIX で結果を送る */
  timing: "now" | "after_confirm";
  enforcement: "recommended" | "required";
  /** 本文に書く橋渡し文（null = AIX 本体が返事） */
  bridge: string | null;
  forbidden: ForbiddenCode[];
  /** プロンプト用の禁止説明文 */
  forbiddenText: string;
  /** 本文の安全の行を引いた場面（証拠。判断ではない） */
  scene: SceneId | null;
  /** 判断者は常にブレイン */
  source: "brain";
  reason_code: string;
  /** 以下はプロンプト注入（buildAixTimingNote）用 */
  chained: string | null;
  urgency: string;
  highlight: boolean;
  extra: string;
  /** スタッフ向け1文 */
  note: string;
};

/** ブレインの判断（suggested_aix_meta / last_brain_meta）。fresh = 今回の顧客発言を見た実分析（cached・optional でない） */
export type BrainAixDecision = {
  action: string | null;
  check_pattern: string | null;
  enforcement_level: string | null;
  note: string | null;
  fresh: boolean;
};

export type ReplyAixInput = SceneEvidenceInput & {
  conversationStatus?: string | null;
  isFirstReply?: boolean;
  /** ブレインの判断（唯一の判断者）。null = ブレインの判断なし（T3） */
  brainDecision?: BrainAixDecision | null;
  /** 生成後だけ: final-check / 後処理で出た断言・AIX 境界コード（AIX は選ばない。記録用） */
  assertionHits?: string[];
  /** 生成後だけ: final-check で直せなかった block コード（enforcement を上げる／自動送信を止めるだけ） */
  unresolvedBlock?: string | null;
};

const VACANCY_FORBID = "空室有無・退去日・入居可能日をテキストで断言すること（実会話では「募集終了」「申込有り2番手」「タッチの差で埋まった」が頻発。「空いています」の生成は即事実誤認）";

type SceneHit = Omit<ReplyAix, "enforcement" | "source" | "note">;

function labelFor(action: string, checkPattern: string | null): string {
  // 2026-09-23: interior_photo → 「物件確認した→室内写真を確認した」（aix-taxonomy と同じ語）
  const avail = action === "property_check_result" ? availabilityCheckButtonLabel(checkPattern) : null;
  if (avail) return avail;
  if (checkPattern === "mgmt_move_in") return "確認した（条件・交渉）→入居可能日";
  if (checkPattern === "vacate_date") return "確認した（条件・交渉）→退去予定日";
  if (checkPattern === "mgmt_guarantor") return "確認した（条件・交渉）→保証会社（審査面）";
  return AIX_BUTTON_LABELS[action] ?? action;
}

function sceneS1(o: SceneEvidenceInput, msg: string, chained: string | null, reason: string): SceneHit {
  return {
    action: "property_check_result", check_pattern: null, label: labelFor("property_check_result", null),
    timing: "after_confirm",
    bridge: chained
      ? "お部屋お送りいただきありがとうございます😊！！お部屋の募集状況確認させて頂き、最大限割引させて頂いた御見積書も合わせてお送りさせて頂きます！！募集状況確認出来次第ご連絡させて頂きます😌！！"
      : (o.hasCustomerImage || AVAILABILITY_URL_RE.test(msg))
        ? "お部屋お送りいただきありがとうございます😊！！お部屋の募集状況確認させて頂きます！！確認出来次第ご連絡させて頂きます😌！！"
        : `${BRIDGE_VACANCY_CHECK}確認出来次第ご連絡させて頂きます😌！！`,
    forbidden: ["VACANCY_ASSERTION", "VIEWING_BEFORE_VACANCY"], forbiddenText: VACANCY_FORBID,
    scene: "S1_vacancy", reason_code: reason, chained,
    urgency: "15分以内に橋渡し→1〜3時間以内に結果報告", highlight: false,
    extra: "URL・物件が複数（連投）の場合は1件ずつ返さず橋渡し1通のみ（バッチ処理・結果は全件まとめて1回で報告）。確認結果（空室・申込あり・募集終了）はスタッフが AIX【物件確認した】で送る。" +
      (chained ? `見積トリガー（${o.estimateVerdict?.trigger}: ${o.estimateVerdict?.reason}）が同時に成立するため、確認完了後に estimate_sheet を連結する（募集状況+見積書をまとめて1回で報告）。` : ""),
  };
}

function sceneS2(cp: string, chained: string | null, reason: string): SceneHit {
  return {
    action: "property_check_result", check_pattern: cp, label: labelFor("property_check_result", cp),
    timing: "after_confirm",
    bridge: `${BRIDGE_MOVEIN_CHECK}確認出来次第ご連絡させて頂きます😌！！`,
    forbidden: ["MOVEIN_DATE_ASSERTION"], forbiddenText: "この物件の入居可能日・退去日を具体的な日付でテキストに書くこと（結果は AIX【確認した（条件・交渉）→入居可能日】で送る）。物件を特定しない一般論（お申込から最短2週間程）は可",
    scene: "S2_move_in", reason_code: reason, chained,
    urgency: "15分以内に橋渡し→管理会社回答後に結果報告", highlight: false, extra: "",
  };
}

function sceneS3(reason: string): SceneHit {
  // 2026-09-15 竹内（YUYA 事例）: 保証会社そのものの質問 → AIX【保証会社について】（物件ごとの会社名・種類の一覧・並行審査）。本文は確認の受付だけ
  if (reason === "guarantor_question" || reason === "brain:guarantor_info") {
    const d = AIX_ACTION_REPLY_DIRECTION.guarantor_info;
    return {
      action: "guarantor_info", check_pattern: null, label: labelFor("guarantor_info", null), timing: "after_confirm",
      bridge: d?.weDo ?? "保証会社確認させて頂きます😊！！",
      forbidden: ["SCREENING_ASSURANCE"], forbiddenText: d?.forbid ?? "保証会社名の記載／審査の通りやすさ・通過の断言／並行審査の提案",
      scene: "S3_screening", reason_code: reason, chained: null,
      urgency: "15分以内に橋渡し→保証会社確認後に AIX【保証会社について】で一覧を案内", highlight: false,
      extra: "物件ごとの保証会社名と種類（独立系＝審査基準が緩い／信販系／信用系）はスタッフが確認して AIX【保証会社について】で送る。本文で会社名・通りやすさを書かない。",
    };
  }
  return {
    action: "property_check_result", check_pattern: "mgmt_guarantor", label: labelFor("property_check_result", "mgmt_guarantor"),
    timing: "after_confirm",
    bridge: BRIDGE_SCREENING_CHECK,
    forbidden: ["SCREENING_ASSURANCE"], forbiddenText: "この物件の審査の通りやすさ・保証会社名・審査通過をテキストで断言すること（結果は AIX【確認した（条件・交渉）→保証会社（審査面）】で送る）",
    scene: "S3_screening", reason_code: reason, chained: null,
    urgency: "15分以内に橋渡し→保証会社確認後に結果報告", highlight: false, extra: "",
  };
}

function sceneS4(reason: string): SceneHit {
  return {
    action: "viewing_invite", check_pattern: null, label: labelFor("viewing_invite", null), timing: "now",
    bridge: AIX_ACTION_REPLY_DIRECTION.viewing_invite.weDo,
    forbidden: ["VIEWING_DATETIME"], forbiddenText: "具体的な内覧候補日時・2択日程提示をAI返信で生成すること（日程はAIX【内覧日調整】専用）。募集状況が未確認の物件への内覧確約",
    scene: "S4_viewing", reason_code: reason, chained: null, urgency: "30分〜1時間以内", highlight: false, extra: "",
  };
}

function sceneS5(reason: string): SceneHit {
  return {
    action: "meeting_place", check_pattern: null, label: labelFor("meeting_place", null), timing: "now",
    bridge: null,
    forbidden: ["VIEWING_DATETIME", "MEETING_DETAIL"], forbiddenText: "内覧日時の確定・住所・集合場所・集合時間をテキストで書くこと（AIX【待ち合わせ】本体が返事になる）",
    scene: "S5_time_spec", reason_code: reason, chained: null, urgency: "顧客発言の直後（実データ 39/41 が直後に AIX）", highlight: false, extra: "",
  };
}

function sceneS6(o: SceneEvidenceInput, msg: string, echoPayment: boolean, reason?: string): SceneHit {
  const payment = AIX_PAYMENT_INTENT_RE.test(msg);
  const v = o.estimateVerdict;
  return {
    action: "estimate_sheet", check_pattern: null, label: labelFor("estimate_sheet", null), timing: "now",
    bridge: echoPayment
      ? "かしこまりました！！お気に召されましたらお申込みでお部屋お押さえさせて頂きます😊！！"
      : "かしこまりました！！最大限割引させて頂いた初期費用の御見積書お送りさせて頂きます😊！！",
    forbidden: ["ESTIMATE_AMOUNT"],
    forbiddenText: echoPayment
      ? "金額・割引額をAIが生成すること／見積作成宣言の繰り返し"
      : "金額・割引額をAIが生成すること（見積書Vision OCRの実数値のみ送信可。割引額はスタッフの交渉結果でありAIが数字を作るとクレーム直結）",
    scene: "S6_estimate", reason_code: reason ?? (echoPayment ? "estimate_echo_payment" : `estimate_${v?.trigger ?? "declare"}`), chained: null,
    urgency: payment || echoPayment ? "10分以内（applying直前の最優先ホットシグナル）" : "2時間以内",
    highlight: payment || echoPayment,
    extra: echoPayment
      ? "見積書は既に約束/送付済みのため作成宣言・割引の約束を繰り返さない（二重宣言防止ルールと整合）。「お気に召されましたらお申込みでお部屋お押さえさせて頂きます」の申込誘導を必ず添える（この申込誘導はこの場面に限り許可）。"
      : (v ? `見積トリガー: ${v.trigger}（${v.reason}）。` : "") + (payment ? "支払い意思+金額質問のため「お気に召されましたらお申込みでお部屋お押さえさせて頂きます」の申込誘導を必ず添える（この申込誘導はこの場面に限り許可）。" : ""),
  };
}

function sceneS7(): SceneHit {
  return {
    action: "property_send", check_pattern: null, label: labelFor("property_send", null), timing: "now",
    bridge: "かしこまりました！！〇〇（顧客の言った新条件を復唱）のご条件に合ったお部屋を△△周辺全域からピックアップしてお送りさせて頂きます😊！！ピックアップ出来次第お送りさせて頂きます！！",
    forbidden: ["INVENTORY_ASSERTION"],
    forbiddenText: "新条件に合う物件の有無を即答すること（在庫ハルシネーション）。「〇〇がいい感じ」等の気に入り表現と同一メッセージでも条件変更が主題のため estimate_sheet 系の見積・申込誘導も絶対NG",
    scene: "S7_condition_change", reason_code: "condition_change", chained: null, urgency: "受付返信→半日以内にピックアップ送付", highlight: false,
    extra: "顧客の言った新条件を必ず復唱すること（実例: 「リビングとベッドを仕切れる1LDK・1DKの間取りや広めの1Kのお部屋を堀江・桜川・大国町周辺全域からピックアップしてお送りさせて頂きます😊！！」）。エリア名自体（駅名・区名・地名）は顧客が使った表現をそのまま使うが、行動宣言では必ず末尾に「周辺全域から」を付ける（「周辺全域」は全フェーズで例外なし必須）。",
  };
}

// 2026-09-15 竹内（ゆうこ事例）: 初期費用の中身の質問（S9）。中身は AIX【初期費用について】で御見積書の内訳を使って送る。
//   ブレインが別の AIX（条件変更の物件ピックアップ 等）を選んでも、本文で費用の中身を説明しない（本文の安全は証拠から足す）
function sceneS9(reason: string): SceneHit {
  const d = AIX_ACTION_REPLY_DIRECTION.cost_breakdown;
  return {
    action: "cost_breakdown", check_pattern: null, label: labelFor("cost_breakdown", null), timing: "now",
    bridge: d?.weDo ?? "ご質問ありがとうございます😊！！",
    forbidden: ["COST_BREAKDOWN"], forbiddenText: d?.forbid ?? "初期費用に含まれる項目の説明・金額",
    scene: "S9_cost_breakdown", reason_code: reason, chained: null, urgency: "30分以内（御見積書を貼って会話を合わせる）", highlight: false,
    extra: "初期費用の中身（含まれる項目・家賃だけで入居できるか・別途かかる費用）は AIX【初期費用について】で御見積書の内訳を使って送る。本文では説明しない（その物件の敷金・礼金は0円かもしれない）。",
  };
}

// 2026-09-15 竹内（H 事例）: お客様が電話で話したい（S10）。「電話をかける」ボタン（LINEコール）と案内文は AIX【電話をかける】で送る。
//   本文は受付の一文だけ（電話番号・「こちらからお電話します」「〇時にお電話します」を作らない）
function sceneS10(reason: string): SceneHit {
  const d = AIX_ACTION_REPLY_DIRECTION.phone_call;
  return {
    action: "phone_call", check_pattern: null, label: labelFor("phone_call", null), timing: "now",
    bridge: d?.weDo ?? "お電話大丈夫です😊！！",
    forbidden: [], forbiddenText: d?.forbid ?? "電話番号・折り返しの時刻の記載",
    scene: "S10_phone_request", reason_code: reason, chained: null, urgency: "10分以内（お客様が電話を待っている）", highlight: true,
    extra: "「電話をかける」ボタンと案内文は AIX【電話する → 電話をかける】で送る（お客様がボタンから公式LINEに電話できる）。本文で電話番号・折り返しの時刻を作らない。",
  };
}

// 2026-09-23 竹内「室内の写真が欲しいといわれたら AIX の物件確認したの室内写真確認したのピッカーから送る形」:
//   S11（室内の写真・動画・URL の依頼／送った物件の別の部屋・間取り）。写真・室内イメージURL・間取り図はスタッフが AIX【物件確認した→室内写真を確認した】
//   のピッカーから手元の物を送る。timing は now（旧 genericRow は property_check_result を一律 after_confirm にしていたため
//   「室内写真確認させて頂きます！！確認出来次第ご連絡」の矛盾文が出ていた）。
//   bridge は受付の一文の**例**（固定文ではない）。実送信365日（検出28通）: 室内イメージURL／画像 13・撮影して送る 2・建築中等の理由付き 2・
//   根拠なしの「ご用意出来ていない」断定 0 → 本文で写真の有無・撮影の約束を作らない。物件固有の理由が会話にある時はそれを優先してよい
function sceneS11(reason: string): SceneHit {
  return {
    action: "property_check_result", check_pattern: "interior_photo", label: labelFor("property_check_result", "interior_photo"), timing: "now",
    bridge: "かしこまりました😊！！室内のお写真お送りさせて頂きます！！",
    forbidden: [],
    forbiddenText: "写真・動画の有無の断定（「ご用意出来ていない」「ございません」。建築中・退去前など物件固有の理由が会話にある時だけ可）／撮影の約束の創作（「私の方で撮影し」「撮影してお送り」）／URL・物件名・号室の記載／「確認出来次第ご連絡」「確認させて頂きます」（確認する物は無い）",
    scene: "S11_other_room", reason_code: reason, chained: null,
    urgency: "受付返信→手元の写真・室内イメージURL をすぐピッカーから送る", highlight: false,
    extra: "写真・室内イメージURL・間取り図は AIX【物件確認した→室内写真を確認した】でスタッフが手元の物を物件名とあわせて送る。本文は受付の一文（例: 「室内のお写真お送りさせて頂きます」）で完結し、写真の有無・撮影に行くか・URL を本文で決めない（手元に無い時の撮影・理由の説明はスタッフが決める）。",
  };
}

function genericRow(action: string, cp: string | null, reason: string): SceneHit {
  return {
    action, check_pattern: cp, label: labelFor(action, cp),
    timing: action === "property_check_result" ? "after_confirm" : "now",
    bridge: null, forbidden: [], forbiddenText: AIX_ACTION_REPLY_DIRECTION[action]?.forbid ?? "",
    scene: null, reason_code: reason, chained: null, urgency: "", highlight: false, extra: "",
  };
}

/** 証拠（場面）→ 本文の安全の行（橋渡し・禁止・急ぎ度）。AIX の決定には使わない */
function rowForEvidence(e: AixSceneEvidence, o: SceneEvidenceInput): SceneHit {
  const msg = (o.latestCustomerTurn || "").trim();
  switch (e.scene) {
    case "S1_vacancy": return sceneS1(o, msg, e.chained, e.reasonCode);
    case "S2_move_in": return sceneS2(e.checkPattern ?? "mgmt_move_in", e.chained, e.reasonCode);
    case "S3_screening": return sceneS3(e.reasonCode);
    case "S4_viewing": return sceneS4(e.reasonCode);
    case "S5_time_spec": return sceneS5(e.reasonCode);
    case "S6_estimate": return sceneS6(o, msg, !!e.echoPayment, e.reasonCode);
    case "S7_condition_change": return sceneS7();
    case "S9_cost_breakdown": return sceneS9(e.reasonCode);
    case "S10_phone_request": return sceneS10(e.reasonCode);
    case "S11_other_room": return sceneS11(e.reasonCode);
    default: return genericRow(e.candidateAction, e.checkPattern, e.reasonCode);
  }
}

/** 断言・AIX 境界コード → 置き換える文・禁止の行（旧 route.ts AIX_BOUNDARY_TO_ACTION）。**AIX を選ぶ用途には使わない** */
export function sceneForCode(code: string, o: SceneEvidenceInput): SceneHit | null {
  const estimateDeclare = !!o.estimateVerdict && o.estimateVerdict.mode === "declare";
  switch (code) {
    case "VACANCY_ASSERTION":
    case "VIEWING_BEFORE_VACANCY":
    case "AIX_BOUNDARY_PROMISE":
      return { ...sceneS1(o, o.latestCustomerTurn ?? "", null, `code:${code}`), bridge: ASSERTION_REPLACEMENT.VACANCY_ASSERTION, chained: null };
    case "MOVEIN_DATE_ASSERTION":
    case "AIX_BOUNDARY_MOVEIN":
      // 入居日の答えは退去予定の物件でも mgmt_move_in（aix-scene-evidence S2 と同じ。vacate_date は内覧解禁日の案内）
      return { ...sceneS2("mgmt_move_in", estimateDeclare ? "estimate_sheet" : null, `code:${code}`), bridge: ASSERTION_REPLACEMENT.MOVEIN_DATE_ASSERTION };
    case "SCREENING_ASSURANCE":
      return { ...sceneS3(`code:${code}`), bridge: ASSERTION_REPLACEMENT.SCREENING_ASSURANCE };
    case "AIX_BOUNDARY_VIEWING": return sceneS4(`code:${code}`);
    case "AIX_BOUNDARY_MEETING": return sceneS5(`code:${code}`);
    case "AIX_BOUNDARY_ESTIMATE": return sceneS6(o, o.latestCustomerTurn ?? "", false);
    case "AIX_BOUNDARY_PROPERTY": return sceneS7();
    case "AIX_BOUNDARY_APPLICATION":
      return {
        action: "application_push", check_pattern: null, label: labelFor("application_push", null), timing: "now",
        bridge: AIX_ACTION_REPLY_DIRECTION.application_push?.weDo ?? null, forbidden: [], forbiddenText: AIX_ACTION_REPLY_DIRECTION.application_push?.forbid ?? "",
        scene: "application", reason_code: `code:${code}`, chained: null, urgency: "", highlight: false, extra: "",
      };
    default: return null;
  }
}

/** AIX_BOUNDARY / 断言コードのうち場面表に行があるもの（final-check の直せなかった block を自動送信停止に回す対象） */
export function isSceneMappedCode(code: string): boolean {
  return sceneForCode(code, { latestCustomerTurn: "", hasCustomerImage: false }) !== null;
}

/**
 * 決まった AIX（ブレインの action / check_pattern）から本文の安全の行を引く。
 * 証拠が同じ AIX を指していればその行（橋渡し文が顧客発言に合う）、違えば AIX 自体の行。
 * action / check_pattern は呼び出し側（ブレイン）の値で上書きする＝判定し直さない。
 */
export function sceneSafetyRow(action: string, checkPattern: string | null, o: SceneEvidenceInput, evidence: AixSceneEvidence | null): SceneHit {
  const msg = (o.latestCustomerTurn || "").trim();
  let row: SceneHit;
  if (evidence && evidence.candidateAction === action && (action !== "property_check_result" || !checkPattern || checkPattern === evidence.checkPattern)) {
    row = rowForEvidence(evidence, o);
  } else if (action === "property_check_result") {
    row = checkPattern === "mgmt_move_in" || checkPattern === "vacate_date" ? sceneS2(checkPattern, null, `brain:${action}`)
      : checkPattern === "mgmt_guarantor" ? sceneS3(`brain:${action}`)
      : checkPattern === "interior_photo" ? sceneS11(`brain:${action}`)
      : genericRow(action, checkPattern, `brain:${action}`);
  } else if (action === "viewing_invite") row = sceneS4(`brain:${action}`);
  else if (action === "meeting_place") row = sceneS5(`brain:${action}`);
  else if (action === "estimate_sheet") row = sceneS6(o, msg, o.estimateVerdict?.mode === "echo_only", `brain:${action}`);
  else if (action === "property_send") row = sceneS7();
  else if (action === "application_push") row = sceneForCode("AIX_BOUNDARY_APPLICATION", o)!;
  else if (action === "cost_breakdown") row = sceneS9(`brain:${action}`);
  else if (action === "guarantor_info") row = sceneS3(`brain:${action}`);
  else if (action === "phone_call") row = sceneS10(`brain:${action}`);
  else row = genericRow(action, checkPattern, `brain:${action}`);
  return { ...row, action, check_pattern: checkPattern, label: labelFor(action, checkPattern) };
}

function staffNoteFor(r: Omit<ReplyAix, "note">): string {
  const base = r.check_pattern
    ? `AIX【${r.label}】（check_pattern=${r.check_pattern}）を押してください`
    : (AIX_STAFF_NOTES[r.action] ?? `AIX【${r.label}】を押してください`);
  const parts = [r.timing === "after_confirm" ? `この返信は確認宣言のみ。確認後は AIX【${r.label}】で結果を送ってください` : base];
  if (r.timing === "after_confirm") parts.push(base);
  if (r.urgency) parts.push(`対応目安: ${r.urgency}`);
  if (r.chained) parts.push(`見積依頼も同時に来ています → 確認完了後にAIX【${AIX_BUTTON_LABELS[r.chained] ?? r.chained}】を連結して送付してください`);
  return parts.join(" ／ ");
}

const REQUIRED_PREFIX = "最終チェックで直せない指摘が残りました。この内容は AIX から送ってください";

export type ReplyAixDecision = {
  /** ブレインが決めた AIX（表示・トレーラー・ai_draft_check 用の形）。null = AIX をセットしない */
  aix: ReplyAix | null;
  /** 直せなかった断言がある → 自動送信を止める（[AIX誘導中]）。AIX の選択とは別 */
  stopAutoSend: boolean;
  /** 読んだブレインの判断が古い／cached だった（ログ用） */
  brainStale: boolean;
};

/** ブレインの判断を読んで、画面・本文に載せる形に整える（唯一の判断者はブレイン） */
export function resolveReplyAixDecision(o: ReplyAixInput): ReplyAixDecision {
  const none = { aix: null, stopAutoSend: false, brainStale: false };
  if (o.conversationStatus && DRAFT_SKIP_STATUSES.has(o.conversationStatus)) return none;
  if (o.isFirstReply) return none;

  const unresolved = !!(o.unresolvedBlock && isSceneMappedCode(o.unresolvedBlock));
  const d = o.brainDecision ?? null;
  const brainStale = !d?.fresh;
  const rawAction = d?.fresh ? (d.action ?? "").trim() : "";
  if (!rawAction || !AIX_STAFF_NOTES[rawAction]) {
    // 古い判断・cached・ブレインが AIX なし・語彙外 → AIX はセットしない（場面表が AIX を足さない）
    return { aix: null, stopAutoSend: unresolved, brainStale };
  }

  const evidence = detectAixSceneEvidence(o);
  let hit: SceneHit;
  if (rawAction === "acknowledge_check") {
    // acknowledge_check（管理会社宛て）は顧客向けの下書きにセットしない → S1 の property_check_result にまとめる（表示の変換）
    hit = { ...sceneS1(o, o.latestCustomerTurn ?? "", null, "brain:acknowledge_check"), bridge: ASSERTION_REPLACEMENT.VACANCY_ASSERTION };
  } else {
    hit = sceneSafetyRow(rawAction, d?.check_pattern ?? null, o, evidence);
  }
  const enforcement: ReplyAix["enforcement"] = unresolved || d?.enforcement_level === "required" ? "required" : "recommended";
  const r: Omit<ReplyAix, "note"> = { ...hit, enforcement, source: "brain" };
  const baseNote = d?.note?.trim() ? d.note.trim() : staffNoteFor(r);
  return { aix: { ...r, note: unresolved ? `${REQUIRED_PREFIX} ／ ${baseNote}` : baseNote }, stopAutoSend: unresolved, brainStale };
}

/** 互換: AIX だけを返す（生成前・生成後で同じ関数） */
export function resolveReplyAix(o: ReplyAixInput): ReplyAix | null {
  return resolveReplyAixDecision(o).aix;
}

// ─── 本文の安全（AIX の判断とは別。証拠で動く）───
export type BodySafety = {
  scene: SceneId;
  /** 証拠が指す候補の AIX（締めの型の選択にだけ使う。AIX のセットには使わない） */
  candidateAction: string;
  label: string;
  bridge: string | null;
  forbidden: ForbiddenCode[];
  forbiddenText: string;
  /** テキストで物件情報・金額・空室状況の答えを書かない */
  noPropertyInfoInText: boolean;
  /** 確認約束を認める根拠（S1/S2/S3 = 確認が要る質問） */
  confirmationBasis: "property_check_result" | null;
  urgency: string;
  chained: string | null;
  highlight: boolean;
  extra: string;
};

/**
 * 証拠（顧客が空室・入居日・審査・内覧・見積などを聞いた）から、本文の安全だけを返す。
 * AIX がセットされない時（ブレインが '' ・ stale）でも「断言しない＋確認いたします」の橋渡しと禁止事項を注入するため。
 */
export function resolveBodySafety(evidence: AixSceneEvidence | null, o: SceneEvidenceInput): BodySafety | null {
  if (!evidence) return null;
  const row = rowForEvidence(evidence, o);
  return {
    scene: evidence.scene, candidateAction: evidence.candidateAction, label: row.label,
    bridge: row.bridge, forbidden: row.forbidden, forbiddenText: row.forbiddenText,
    noPropertyInfoInText: true,
    confirmationBasis: isConfirmationScene(evidence) ? "property_check_result" : null,
    urgency: row.urgency, chained: row.chained, highlight: row.highlight, extra: row.extra,
  };
}

/** 確認約束 verdict（applyAixTiming）に渡す根拠の AIX。本文の安全（確認が要る質問）＋ブレインの action のどちらか */
export function confirmationBasisAction(safety: BodySafety | null, aix: ReplyAix | null): string | null {
  if (safety?.confirmationBasis) return safety.confirmationBasis;
  if (aix && (aix.action === "property_check_result" || aix.action === "acknowledge_check")) return aix.action;
  return null;
}

/** 画面・DB に載せる形（ai_draft_check.suggested_aix / SUGGESTED_AIX トレーラー / メタ行） */
export function toSuggestedAixPayload(r: ReplyAix, extra?: { closing_strategy?: string | null }) {
  return {
    action: r.action,
    check_pattern: r.check_pattern,
    timing: r.timing,
    bridge: r.bridge,
    note: r.note,
    source: "brain" as const,
    scene: r.scene,
    reason_code: r.reason_code,
    enforcement_level: r.enforcement,
    closing_strategy: extra?.closing_strategy || undefined,
  };
}
