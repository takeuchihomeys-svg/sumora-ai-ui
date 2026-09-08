// app/lib/confirmation-context.ts
// G26（2026-09-08 Fable5）: 「確認出来次第ご連絡します」を書いてよいかの単一 verdict。
// 生成（managementNote / confirmationGateNote / gratitudeActionHint）・bridge（buildAixTimingNote）・
// 検査（final-check V5/V6・WE_DO 判定）の三層が同一オブジェクトを参照する（estimate-context.ts と同型）。
// 許可条件（語出現・state・営業時間では解禁しない）:
//   (1) 顧客が「管理会社に聞かないと答えられない物件固有の事実」を質問形で聞いた
//   (2) 直前スタッフ発言に確認対象付きの「確認します」約束がある（未履行→復唱）
//   (3) 鮮度ゲート済み brain action / アクティブタスクが確認系
//   (4) 顧客が特定物件を指名した（URL・物件名・「この物件」）— 質問形が無くても募集状況確認は正しい行動
//   (5) detectAixTiming が property_check_result（applyAixTiming で後付け・route/final-check 双方で同じ pure 関数）
import { CUSTOMER_PROPERTY_REF_RE } from "./line-reply-prompts";

export type ConfirmationSource =
  | "customer_fact_question"
  | "customer_property_nomination"
  | "staff_confirm_promise"
  | "brain_confirm_action"
  | "active_property_check"
  | "aix_property_check_bridge"
  | "customer_self_confirm"
  | "none";

export interface ConfirmationContextVerdict {
  allowed: boolean;
  source: ConfirmationSource;
  /** 返信にリテラルで書く確認対象。allowed=false のとき null */
  object: string | null;
  reason: string;
}

export const CONFIRM_OBJECT_LABELS: Array<[RegExp, string]> = [
  [/空(?:き|いて|室)|募集(?:中|状況|して|出て)|まだ(?:あり|空|募集|残|大丈夫)|埋ま|申込(?:み)?(?:入って|は入|ありま)|番手/, "募集状況"],
  [/入居(?:可能|でき|出来)|いつから(?:住|入)|退去(?:日|予定|はいつ)|引き渡し/, "ご入居可能日"],
  [/ペット|猫|犬|飼育/, "ペット飼育の可否"],
  [/駐車場|駐輪|バイク置/, "駐車場の空き状況"],
  [/保証会社|保証料|審査(?:基準|は通|通り|に通)/, "保証会社・審査条件"],
  [/(?:家賃|賃料|礼金|敷金|初期費用)[^\n]{0,8}(?:交渉|下げ|安く|値引|相談)|フリーレント|値引き|値下げ/, "家賃・条件交渉の可否"],
  [/水道|インターネット|ネット(?:無料|込|代)|Wi-?Fi|ガス|エアコン|設備|楽器|事務所(?:利用|使用)|SOHO|二人入居|ルームシェア|同棲/, "設備・利用条件"],
  [/暗証番号|鍵|カギ|オートロック/, "鍵・現地の入室方法"],
];
const FACT_QUESTION_RE = /ありますか|あります？|ますか|ですか|でしょうか|いかが|どう(?:です|でしょう|なって)|教えて|知りたい|いつ|可能|できます|出来ます|大丈夫|[?？]/;
/** 顧客が「自分で確認します」— final-check CUSTOMER_CONFIRM_RE と同名 */
export const CUSTOMER_SELF_CONFIRM_RE = /確認(?:します|しておきます|して(?:みます|おきます|また|から)|させて(?:頂|いただ)きます|いたします)|見ておきます|見てみます|目を通し/;
const STAFF_CONFIRM_PROMISE_RE = /(?<!ご)確認(?:させて(?:頂|いただ)き|いたし|致し|し)(?:ます|て)|確認(?:でき|出来|し)次第|お調べ(?:して|させて)/;
const STAFF_CONFIRM_OBJECT_RE = /募集状況|空室|空き|管理会社|オーナー|貸主|番手|入居可能|退去|交渉|ペット|駐車場|保証会社|設備|水道|ネット|鍵|暗証番号/;
/** 顧客の物件指名（URL・物件名転記・「この物件」）— CUSTOMER_PROPERTY_REF_RE（prompts）と URL */
const PROPERTY_NOMINATION_RE = new RegExp(`${CUSTOMER_PROPERTY_REF_RE.source}|https?:\\/\\/|物件名|号室|賃料|管理費|[0-9０-９]+(?:件目|つ目|番目)`);
/** 鮮度ゲート済み effectiveAction のうち確認宣言が正しいもの（property_check_result は結果報告フェーズなので含めない） */
export const BRAIN_CONFIRM_ACTIONS: ReadonlySet<string> = new Set(["acknowledge_check"]);
export const CONFIRM_ACTIVE_TASKS: ReadonlySet<string> = new Set(["property_check"]);

/** 検査側・修正ループ guard 共用: 本文中の「確認…ご連絡…ます」約束文（顧客依頼「ご確認後ご連絡ください」は除外） */
export const CONFIRM_PROMISE_SENTENCE_RE = /(?<!ご)確認(?:でき|出来|し|後|の上|次第)?[^\n。]{0,20}?ご連絡(?:させて(?:頂|いただ)き|いたし|致し|し)ます/;
export const CONFIRM_NEXT_RE = /確認(?:でき|出来|し)次第/;

export function findConfirmObject(text: string): string | null {
  for (const [re, label] of CONFIRM_OBJECT_LABELS) if (re.test(text)) return label;
  return null;
}

export function resolveConfirmationContext(input: {
  customerMessage: string;
  /** 直前スタッフ発言（route.ts lastStaffMsgForSearch / final-check lastStaffTexts(ctx,1)） */
  lastStaffMessage?: string | null;
  /** 鮮度ゲート済み action（route.ts effectiveAction）。stale な rawAction は渡さない */
  brainAction?: string | null;
  activeTaskTypes?: readonly string[] | null;
}): ConfirmationContextVerdict {
  const cust = (input.customerMessage || "").trim();
  const staff = (input.lastStaffMessage || "").trim();
  const custObject = findConfirmObject(cust);

  if (CUSTOMER_SELF_CONFIRM_RE.test(cust) && !(custObject && FACT_QUESTION_RE.test(cust))) {
    return { allowed: false, source: "customer_self_confirm", object: null, reason: "顧客が自分で確認すると言っている（確認の主語は顧客）" };
  }
  if (custObject && FACT_QUESTION_RE.test(cust)) {
    return { allowed: true, source: "customer_fact_question", object: custObject, reason: `顧客が「${custObject}」を質問` };
  }
  if (PROPERTY_NOMINATION_RE.test(cust)) {
    return { allowed: true, source: "customer_property_nomination", object: custObject ?? "募集状況", reason: "顧客が特定物件を指名（募集状況確認が次工程）" };
  }
  if (staff && STAFF_CONFIRM_PROMISE_RE.test(staff) && STAFF_CONFIRM_OBJECT_RE.test(staff)) {
    return { allowed: true, source: "staff_confirm_promise", object: findConfirmObject(staff) ?? "募集状況", reason: "直前スタッフ発言の確認約束を復唱" };
  }
  if (input.brainAction && BRAIN_CONFIRM_ACTIONS.has(input.brainAction)) {
    return { allowed: true, source: "brain_confirm_action", object: custObject ?? "募集状況", reason: `brain action=${input.brainAction}` };
  }
  if ((input.activeTaskTypes ?? []).some((t) => CONFIRM_ACTIVE_TASKS.has(t))) {
    return { allowed: true, source: "active_property_check", object: "募集状況", reason: "property_check タスクがアクティブ" };
  }
  return { allowed: false, source: "none", object: null, reason: "確認対象が会話文脈に存在しない" };
}

/** detectAixTiming の結果を verdict に合成する pure 関数（route の生成側・final-check 側で同じ値になる） */
export function applyAixTiming(v: ConfirmationContextVerdict, aix: string | null | undefined): ConfirmationContextVerdict {
  if (v.allowed || v.source === "customer_self_confirm") return v;
  if (aix === "property_check_result" || aix === "acknowledge_check") {
    return { allowed: true, source: "aix_property_check_bridge", object: "募集状況", reason: `AIXタイミング判定=${aix}（橋渡し文の確認宣言）` };
  }
  return v;
}

/** 根拠の無い「確認…ご連絡」「確認出来次第」を含む文を本文から除く（WE_DO 判定用。allowed=true なら無変換） */
export function stripUnbackedConfirmPromise(text: string, verdict: ConfirmationContextVerdict): string {
  if (verdict.allowed) return text;
  return text
    .replace(new RegExp(CONFIRM_PROMISE_SENTENCE_RE.source, "g"), "")
    .replace(/[^\n。！!]*確認(?:でき|出来|し)次第[^\n。！!]*/g, "");
}
