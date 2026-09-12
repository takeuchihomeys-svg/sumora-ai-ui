// app/lib/aix-reply-set.ts
// 2026-09-12 竹内方針A: 「この返信は AIX で送る／確認後に AIX で結果を送る」場面の判定を1関数（resolveReplyAix）にまとめる。
// 生成（プロンプト注入 buildAixTimingNote）・メタ行 suggested_aix・SUGGESTED_AIX トレーラー・ai_draft_check.suggested_aix・
// 後処理の断言置換文（ASSERTION_REPLACEMENT）が同じ出力を見る。段と段のあいだに優先順位ルールを足さない。
// 旧 route.ts detectAixTiming（P0 物件指名／見積／条件変更／内覧の4分岐）と AIX_BOUNDARY_TO_ACTION の写像はここへ移した。
//
// 判定の順番（1つの関数の中の場面表。「上から順に見る」）
//   1. 下書きを作らない段階（DRAFT_SKIP_STATUSES）→ null
//   2. 初回返信 → null
//   3. 決定論の場面検出（SCENES の順）
//   4. 場面が無く、断言コード（assertionHits）がある → そのコードが属する行（source='assertion'）
//   5. それでも無ければ brain の推定を recommended で使う（source='brain'。check_pattern は detectPropertyCheckPattern で判定し直す）
//   6. unresolvedBlock（final-check で直せなかった block）があれば enforcement='required'
// 場面表の並び: 既存の優先度（物件指名 > 見積 > 条件変更 > 内覧）を保ったまま S2/S3/S5 を差し込んだ。
//   S1 空室 → S2 入居日 → S3 審査 → S6 見積 → S7 条件変更 → S5 日時の指定 → S4 内覧希望
//   （S5 を S4 より先に見るのは「木曜13時に内覧予約お願いします」＋viewing_invite 送付済み＝待ち合わせの場面だから）
import { isConditionFormMessage } from "./line-reply-prompts";
import type { EstimateContextVerdict } from "./estimate-context";
import { AIX_ACTION_REPLY_DIRECTION, AIX_BUTTON_LABELS, AIX_STAFF_NOTES, detectPropertyCheckPattern } from "./aix-taxonomy";
import { DRAFT_SKIP_STATUSES } from "./conversation-status";
import {
  allVacancyWordsAreSlots, SLOT_AVAILABILITY_Q_RE, MOVEIN_Q_RE, SCREENING_Q_RE, VIEWING_INTENT_RE, TIME_SPEC_RE, TIME_REQUEST_RE,
  BRIDGE_VACANCY_CHECK, BRIDGE_MOVEIN_CHECK, BRIDGE_SCREENING_CHECK, ASSERTION_REPLACEMENT,
} from "./scene-patterns";

export type PropertyStatusLite = "move_out_scheduled" | "occupied" | "vacant" | "unknown";
export type SceneId = "S1_vacancy" | "S2_move_in" | "S3_screening" | "S4_viewing" | "S5_time_spec" | "S6_estimate" | "S7_condition_change" | "application";
/** 本文で書かない範囲（断言検査のコード） */
export type ForbiddenCode = "VACANCY_ASSERTION" | "VIEWING_BEFORE_VACANCY" | "MOVEIN_DATE_ASSERTION" | "SCREENING_ASSURANCE" | "VIEWING_DATETIME" | "MEETING_DETAIL" | "ESTIMATE_AMOUNT" | "INVENTORY_ASSERTION";

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
  scene: SceneId | null;
  source: "scene" | "assertion" | "brain";
  reason_code: string;
  /** 以下はプロンプト注入（buildAixTimingNote）用 */
  chained: string | null;
  urgency: string;
  highlight: boolean;
  extra: string;
  /** スタッフ向け1文 */
  note: string;
};

export type ReplyAixInput = {
  /** 今回の顧客発言（スタッフ文は含めない） */
  latestCustomerTurn: string;
  /** 直前スタッフ発言より後に顧客が画像を送った */
  hasCustomerImage: boolean;
  /** oldest-first */
  recentMessages?: ReadonlyArray<{ sender: string; text?: string | null; isAix?: boolean | null }>;
  /** 直近の AIX 使用（aix_usage_logs） */
  aixHistory?: ReadonlyArray<{ aix_type?: string | null; check_pattern?: string | null }>;
  /** 行動台帳の送付物件数（ledger.facts.propertiesSentCount） */
  sentPropertyCount?: number;
  conversationStatus?: string | null;
  isFirstReply?: boolean;
  propertyStatus?: PropertyStatusLite;
  /** isMisumoriContextAppropriate() の verdict（見積判定の単一真実源） */
  estimateVerdict?: EstimateContextVerdict | null;
  /** brain の推定（数ある入力の1つ） */
  brainCandidate?: { action?: string | null; check_pattern?: string | null; note?: string | null } | null;
  /** 生成後だけ: final-check / 後処理で出た断言・AIX 境界コード */
  assertionHits?: string[];
  /** 生成後だけ: final-check で直せなかった block コード */
  unresolvedBlock?: string | null;
};

// ─── 募集状況の質問（旧 route.ts detectAvailabilityCheckContext をここへ移設。route.ts の availabilityCheckNote もこの関数を使う）───
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
const AIX_NOMINATION_RE = /空(?:室|き|いて)|取り扱い|募集|ありますか|この(?:物件|お?家|部屋)/;
const AIX_PAYMENT_INTENT_RE = /払えま|払える|支払えま|即日[^\n]{0,10}(?:払|入金|振り?込)|用意でき|振り?込め|一括で払/;
export const AIX_CONDITION_CHANGE_RE =/(?:もう少し|もっと|さらに)[^\n]{0,12}(?:広|安|大き|新し|駅近|きれい|綺麗|抑え)|(?:上がって|高くて|上げて)も(?:構い|大丈夫|OK|いい)|でも(?:大丈夫|構い|いいです|良いです)|のみで(?:調べ|探し|お願い)|仕切れる|条件[^\n]{0,8}(?:変更|追加|緩和|広げ)/;
/** 物件の特定（号室・「どの部屋」・送付物件への指示語） */
const ROOM_NO_RE = /[0-9０-９]{3,4}\s*号室?/;
const WHICH_ROOM_RE = /どの(?:お?部屋|物件|号室)/;
const DEMONSTRATIVE_RE = /こちら|この|その|そちら|ここ|そこ|さっき|先ほど|先程|送って(?:もらった|頂いた|いただいた|くださった)|お送り(?:頂いた|いただいた)|[①-⑩]|[0-9０-９]+(?:件目|つ目|番目)/;

const VACANCY_FORBID = "空室有無・退去日・入居可能日をテキストで断言すること（実会話では「募集終了」「申込有り2番手」「タッチの差で埋まった」が頻発。「空いています」の生成は即事実誤認）";

/** 物件が特定できるか（S1/S2/S3 の前提） */
export function isPropertySpecified(msg: string, o: { hasCustomerImage: boolean; sentPropertyCount?: number }): boolean {
  if (o.hasCustomerImage || AVAILABILITY_URL_RE.test(msg) || ROOM_NO_RE.test(msg) || WHICH_ROOM_RE.test(msg)) return true;
  if (AVAILABILITY_PROPERTY_RE.test(msg)) return true;
  return (o.sentPropertyCount ?? 0) > 0 && DEMONSTRATIVE_RE.test(msg);
}

type SceneHit = Omit<ReplyAix, "enforcement" | "source" | "note"> & { note?: string };

function labelFor(action: string, checkPattern: string | null): string {
  if (checkPattern === "mgmt_move_in") return "確認した（条件・交渉）→入居可能日";
  if (checkPattern === "vacate_date") return "確認した（条件・交渉）→退去予定日";
  if (checkPattern === "mgmt_guarantor") return "確認した（条件・交渉）→保証会社（審査面）";
  return AIX_BUTTON_LABELS[action] ?? action;
}

function sceneS1(o: ReplyAixInput, msg: string, estimateDeclare: boolean, reason: string): SceneHit {
  const chained = estimateDeclare ? "estimate_sheet" : null;
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

function sceneS2(o: ReplyAixInput, estimateDeclare: boolean, reason: string): SceneHit {
  const cp = o.propertyStatus === "move_out_scheduled" ? "vacate_date" : "mgmt_move_in";
  return {
    action: "property_check_result", check_pattern: cp, label: labelFor("property_check_result", cp),
    timing: "after_confirm",
    bridge: `${BRIDGE_MOVEIN_CHECK}確認出来次第ご連絡させて頂きます😌！！`,
    forbidden: ["MOVEIN_DATE_ASSERTION"], forbiddenText: "この物件の入居可能日・退去日を具体的な日付でテキストに書くこと（結果は AIX【確認した（条件・交渉）→入居可能日】で送る）。物件を特定しない一般論（お申込から最短2週間程）は可",
    scene: "S2_move_in", reason_code: reason, chained: estimateDeclare ? "estimate_sheet" : null,
    urgency: "15分以内に橋渡し→管理会社回答後に結果報告", highlight: false, extra: "",
  };
}

function sceneS3(reason: string): SceneHit {
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

function sceneS6(o: ReplyAixInput, msg: string, echoPayment: boolean): SceneHit {
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
    scene: "S6_estimate", reason_code: echoPayment ? "estimate_echo_payment" : `estimate_${v?.trigger ?? "declare"}`, chained: null,
    urgency: payment || echoPayment ? "10分以内（applying直前の最優先ホットシグナル）" : "2時間以内",
    highlight: payment || echoPayment,
    extra: echoPayment
      ? "見積書は既に約束/送付済みのため作成宣言・割引の約束を繰り返さない（二重宣言防止ルールと整合）。「お気に召されましたらお申込みでお部屋お押さえさせて頂きます」の申込誘導を必ず添える（この申込誘導はこの場面に限り許可）。"
      : `見積トリガー: ${v?.trigger}（${v?.reason}）。` + (payment ? "支払い意思+金額質問のため「お気に召されましたらお申込みでお部屋お押さえさせて頂きます」の申込誘導を必ず添える（この申込誘導はこの場面に限り許可）。" : ""),
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

function hasViewingInviteBefore(o: ReplyAixInput): boolean {
  if ((o.aixHistory ?? []).some((a) => a.aix_type === "viewing_invite")) return true;
  const staff = (o.recentMessages ?? []).filter((m) => m.sender === "staff").slice(-5);
  return staff.some((m) => /ご都合よろしいお日にち|ご内覧可能な日程|内覧日程|ご案内可能(?:な|です)|ご案内させて頂けます/.test(m.text ?? ""));
}

/** 決定論の場面検出（生成前・生成後で同じ）。旧 detectAixTiming の後継 */
export function detectReplyAixScene(o: ReplyAixInput): SceneHit | null {
  const msg = (o.latestCustomerTurn || "").trim();
  if (!msg && !o.hasCustomerImage) return null;
  const v = o.estimateVerdict ?? null;
  const estimateDeclare = !!v && v.mode === "declare";
  // 条件フォームのみ（trigger=none）は金額・指名判定を行わない
  if (isConditionFormMessage(msg) && !estimateDeclare) return null;

  const specified = isPropertySpecified(msg, { hasCustomerImage: o.hasCustomerImage, sentPropertyCount: o.sentPropertyCount });
  const slotQuestion = SLOT_AVAILABILITY_Q_RE.test(msg);

  // S1 空室確認: 旧 P0（画像/URL＋指名語、URLのみ・画像のみ）＋ 文字だけの空室質問で物件が特定できる場合
  const hasPropertyUrl = AVAILABILITY_URL_RE.test(msg);
  if (o.hasCustomerImage || hasPropertyUrl) {
    const urlOnly = hasPropertyUrl && msg.replace(/https?:\/\/\S+/g, "").trim().length <= 10;
    const imageOnly = o.hasCustomerImage && msg.length <= 10;
    if ((AIX_NOMINATION_RE.test(msg) && !slotQuestion) || urlOnly || imageOnly) return sceneS1(o, msg, estimateDeclare, "property_nomination");
  }
  // S2 入居日（物件あり）/ S3 審査（物件あり）: 「この物件の〜ですか？」は募集状況の質問形にも当たるので、文字だけの S1 より先に見る
  if (MOVEIN_Q_RE.test(msg) && specified) return sceneS2(o, estimateDeclare, "move_in_question");
  if (SCREENING_Q_RE.test(msg) && specified) return sceneS3("screening_question");
  if (!slotQuestion && specified && detectAvailabilityCheckContext(msg)) return sceneS1(o, msg, estimateDeclare, "availability_question");

  // S6 見積（verdict が declare の時のみ。語出現では出さない）
  if (estimateDeclare) return sceneS6(o, msg, false);
  if (v?.mode === "echo_only" && AIX_PAYMENT_INTENT_RE.test(msg)) return sceneS6(o, msg, true);

  // S7 条件変更
  if (AIX_CONDITION_CHANGE_RE.test(msg)) return sceneS7();

  // S5 日時の指定（viewing_invite を送った後の「9/9の15時からお願いします」）
  if (TIME_SPEC_RE.test(msg) && TIME_REQUEST_RE.test(msg) && hasViewingInviteBefore(o)) return sceneS5("time_spec_after_viewing_invite");

  // S4 内覧希望（退去予定/入居中は現地内覧不可のため対象外）
  if ((VIEWING_INTENT_RE.test(msg) || slotQuestion) && o.propertyStatus !== "move_out_scheduled" && o.propertyStatus !== "occupied") {
    return sceneS4(slotQuestion ? "viewing_slot_question" : "viewing_intent");
  }
  return null;
}

/** 断言・AIX 境界コード → 場面表の行（旧 route.ts AIX_BOUNDARY_TO_ACTION を統合）。告知事項は専用 AIX が無いので行なし */
export function sceneForCode(code: string, o: ReplyAixInput): SceneHit | null {
  const estimateDeclare = !!o.estimateVerdict && o.estimateVerdict.mode === "declare";
  switch (code) {
    case "VACANCY_ASSERTION":
    case "VIEWING_BEFORE_VACANCY":
    case "AIX_BOUNDARY_PROMISE":
      return { ...sceneS1(o, o.latestCustomerTurn ?? "", false, `code:${code}`), bridge: ASSERTION_REPLACEMENT.VACANCY_ASSERTION, chained: null };
    case "MOVEIN_DATE_ASSERTION":
    case "AIX_BOUNDARY_MOVEIN":
      return { ...sceneS2(o, estimateDeclare, `code:${code}`), bridge: ASSERTION_REPLACEMENT.MOVEIN_DATE_ASSERTION };
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

/** AIX_BOUNDARY / 断言コードのうち場面表に行があるもの */
export function isSceneMappedCode(code: string): boolean {
  return sceneForCode(code, { latestCustomerTurn: "", hasCustomerImage: false }) !== null;
}

function staffNoteFor(r: Omit<ReplyAix, "note">): string {
  const base = r.check_pattern
    ? `AIX【${r.label}】（check_pattern=${r.check_pattern}）を押してください`
    : (AIX_STAFF_NOTES[r.action] ?? `AIX【${r.label}】を押してください`);
  const parts = [r.timing === "after_confirm" ? `この返信は確認宣言のみ。確認後は AIX【${r.label}】で結果を送ってください` : base];
  if (r.timing === "after_confirm") parts.push(base);
  if (r.urgency) parts.push(`対応目安: ${r.urgency}`);
  if (r.chained) parts.push(`見積依頼も同時に来ています → 確認完了後にAIX【${AIX_BUTTON_LABELS[r.chained] ?? r.chained}】を連結して送付してください`);
  if (r.enforcement === "required") parts.unshift("最終チェックで直せない指摘が残りました。この内容は AIX から送ってください");
  return parts.join(" ／ ");
}

/** 「AIX で送る場面」の唯一の判定。生成前（assertionHits/unresolvedBlock なし）と生成後（あり）で同じ関数を呼ぶ */
export function resolveReplyAix(o: ReplyAixInput): ReplyAix | null {
  if (o.conversationStatus && DRAFT_SKIP_STATUSES.has(o.conversationStatus)) return null;
  if (o.isFirstReply) return null;

  let hit: SceneHit | null = detectReplyAixScene(o);
  let source: ReplyAix["source"] = "scene";
  if (!hit) {
    for (const c of o.assertionHits ?? []) {
      const h = sceneForCode(c, o);
      if (h) { hit = h; source = "assertion"; break; }
    }
  }
  if (!hit && o.unresolvedBlock) {
    const h = sceneForCode(o.unresolvedBlock, o);
    if (h) { hit = h; source = "assertion"; }
  }
  if (!hit && o.brainCandidate?.action && AIX_STAFF_NOTES[o.brainCandidate.action]) {
    const a = o.brainCandidate.action;
    // acknowledge_check（管理会社宛て）は顧客向けの下書きにセットしない → S1 の property_check_result にまとめる
    if (a === "acknowledge_check") {
      hit = { ...sceneS1(o, o.latestCustomerTurn ?? "", false, "brain:acknowledge_check"), bridge: ASSERTION_REPLACEMENT.VACANCY_ASSERTION };
    } else {
      const kind = a === "property_check_result" ? detectPropertyCheckPattern((o.latestCustomerTurn ?? "").trim()) : null;
      const cp = kind?.check_pattern ?? null;
      hit = {
        action: a, check_pattern: cp, label: labelFor(a, cp),
        timing: a === "property_check_result" ? "after_confirm" : "now",
        bridge: null, forbidden: [], forbiddenText: AIX_ACTION_REPLY_DIRECTION[a]?.forbid ?? "",
        scene: null, reason_code: `brain:${a}`, chained: null, urgency: "", highlight: false, extra: "",
        note: o.brainCandidate.note ?? undefined,
      };
    }
    source = "brain";
  }
  if (!hit) return null;
  const enforcement: ReplyAix["enforcement"] = o.unresolvedBlock && sceneForCode(o.unresolvedBlock, o) ? "required" : "recommended";
  const { note: hitNote, ...rest } = hit;
  const r: Omit<ReplyAix, "note"> = { ...rest, enforcement, source };
  return { ...r, note: source === "brain" && hitNote ? hitNote : staffNoteFor(r) };
}

/** 画面・DB に載せる形（ai_draft_check.suggested_aix / SUGGESTED_AIX トレーラー / メタ行） */
export function toSuggestedAixPayload(r: ReplyAix, extra?: { closing_strategy?: string | null }) {
  return {
    action: r.action,
    check_pattern: r.check_pattern,
    timing: r.timing,
    bridge: r.bridge,
    note: r.note,
    source: r.source === "scene" ? "aix_reply_set" : r.source === "assertion" ? "final_check_assertion" : "brain",
    scene: r.scene,
    reason_code: r.reason_code,
    enforcement_level: r.enforcement,
    closing_strategy: extra?.closing_strategy || undefined,
  };
}
