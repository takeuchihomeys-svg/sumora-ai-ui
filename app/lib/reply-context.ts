// app/lib/reply-context.ts
// 2026-09-09 Fable5: 往復文脈（直前スタッフ発話 × 顧客返答）と顧客メッセージの「実質」を単一 verdict で判定する pure module。
// 生成（generate-reply/route.ts）・検査（final-check.ts）・few-shot（line-reply-prompts.ts）・tpo_debug の四者が
// このファイルの関数と定数だけを参照する（四者同名）。
// 原則: 表層特徴（文字数・感謝語・?）ではなく「定型を剥がした残余」「直前スタッフ発話への応答関係」「fresh brain の抽出結果」の
// 3証拠で判定する。route.ts で1回だけ計算し、TPOゲート／effectiveReplyDirection／tpoNoteForLLM／dynamicBlock／
// final-check（finalCheckCtx / detCtx / postDetCtx）／tpo_debug が同一オブジェクトを参照する（見積 verdict・confirmCtx と同型）。
// 循環 import 禁止: このファイルは他の app/lib/* を import しない。

// ─────────────────────────────────────────────────────────────
// 0. メッセージ単位（page.tsx / bg-async が未返信メッセージを結合する専用区切り）
// ─────────────────────────────────────────────────────────────
/** 未返信メッセージ結合の専用区切り。1通内の改行（"\n"）と「複数通」を区別する（旧 join("\n") の置換） */
export const MSG_SEP = "\n\u2063\n";

/** 複数通の配列化。units（body.customerMessages 配列）があればそれを優先し、無ければ MSG_SEP で分割（旧 "\n" では分割しない） */
export function splitMessageUnits(raw: string | null | undefined, units?: unknown): string[] {
  if (Array.isArray(units) && units.length > 0) {
    const arr = units.map((s) => String(s ?? "").trim()).filter(Boolean);
    if (arr.length > 0) return arr;
  }
  return (raw ?? "").split(MSG_SEP).map((s) => s.trim()).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────
// 1. 正規化
// ─────────────────────────────────────────────────────────────
const DECOR_RE =
  /m\(_ _\)m|\(\s*_\s*_\s*\)|[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]|[♪♡★☆〜～]/gu;
const MEDIA_TOKEN_RE = /\[(?:画像|動画|スタンプ|ファイル|位置情報)\]/g;
const SENT_SPLIT_RE = /(?<=[。！!？?])|\n/;

export function normalizeCustomerText(raw: string | null | undefined): string {
  return (raw ?? "")
    .split(MSG_SEP).join("\n")
    .replace(MEDIA_TOKEN_RE, " ")
    .replace(DECOR_RE, "")
    .replace(/[ \t　]+/g, " ")
    .replace(/([！!？?。、，,．.…]|\s)+/g, "$1")
    .trim();
}
const cpLen = (s: string) => Array.from(s.replace(/[\s、。！!？?…]/g, "")).length;

// ─────────────────────────────────────────────────────────────
// 2. 実質判定（Substance）
// ─────────────────────────────────────────────────────────────
export type SubstanceKind =
  | "concern" | "question" | "request" | "condition" | "schedule"
  | "decision" | "decline" | "info" | "answer" | "statement";

export type ConcernKey =
  | "floor" | "old" | "price" | "far" | "narrow" | "dark" | "screening"
  | "noise_safety" | "family" | "equipment" | "pet_parking" | "timing";

export interface ConcernHit {
  key: ConcernKey;
  label: string;
  /** 顧客文中の一致語（ログ・メッセージ用。final-check の evidence には使わない） */
  phrase: string;
  /** 返信側でこの懸念に「答えた／代替を出した」と認める語 */
  replyRe: RegExp;
  /** 懸念→条件語への変換ヒント（決定論リテラル。LLM に選ばせない） */
  fix: string;
}

export interface SubstanceVerdict {
  /** 強い実質（concern/question/request/condition/schedule/decision/decline/info/answer）が1つでもある */
  has: boolean;
  kinds: SubstanceKind[];
  concerns: ConcernHit[];
  /** 全通が感謝・了承・スタンプ・締めのみ */
  isAckOnly: boolean;
  /** 定型（感謝・了承・締め）文と待ち句を剥がした残余 */
  residue: string;
  residueLen: number;
  normalized: string;
  /** 通単位（MSG_SEP / 配列） */
  units: string[];
  evidence: string[];
}

const STRONG_KINDS: SubstanceKind[] = ["concern", "question", "request", "condition", "schedule", "decision", "decline", "info", "answer"];

/** 純粋な感謝・了承・締め（1文単位）。前置き（ご確認いただき／ご丁寧に／暑い中 等）も吸収 */
export const PURE_ACK_SENT_RE =
  /^(?:(?:ご?確認(?:いただき|頂き|して(?:いただき|頂き))?|ご?対応(?:いただき|頂き)?|ご?連絡(?:いただき|頂き)?|お?返事(?:いただき|頂き)?|ご?返信(?:いただき|頂き)?|送って(?:いただき|頂き|くださり)|お送り(?:いただき|頂き)|お調べ(?:いただき|頂き)?|ピックアップ(?:いただき|頂き|して(?:いただき|頂き))?|ご?提案(?:いただき|頂き)?|ご?紹介(?:いただき|頂き)?|ご?案内(?:いただき|頂き)?|ご?説明(?:いただき|頂き)?|(?:お|御)?見積(?:もり|り|書)?(?:を|も)?|物件(?:を|も)?|お部屋(?:を|も)?|お?写真(?:を|も)?|画像(?:を|も)?|資料(?:を|も)?|情報(?:を|も)?|ご丁寧に|丁寧に|詳しく|諸々|暑い中|遅い時間に|夜分に|お忙しい中|早速|早々に?|早急に|迅速に|いつも|本日は|先日は|先ほどは|色々|いろいろ|お手数(?:お)?(?:掛け|かけ)(?:します|しますが)?|こちらこそ|引き続き|今後とも|何卒|どうぞ){0,2}(?:ありがとう(?:ございま(?:す|した))?|有難う(?:ございま(?:す|した))?|感謝(?:します|いたします)?|助かります|嬉しいです|了解(?:です|しました|いたしました|致しました)?|承知(?:しました|いたしました|致しました|です)?|わかりました|分かりました|かしこまりました|(?:よろしく|宜しく)お?(?:ねがい|願い)(?:します|いたします|致します)?|お願い(?:します|いたします|致します)|はい|(?<![A-Za-z])OK(?![A-Za-z])|(?<![A-Za-z])ok(?![A-Za-z])|オッケー(?:です)?|おっけ(?:ー)?(?:です)?|お世話になります|お世話になっております|失礼(?:します|いたします|致します)|楽しみにしてます|楽しみです|そうなんですね|なるほど|すいません|すみません|はーい|うん)[\s、,！!。]*)+$/;
const CLOSER_SENT_RE = /^(?:では|それでは)?(?:失礼(?:します|いたします|致します)|以上です|よろしくです)[！!。]*$/;
/** 待ち句（検討します／後で確認します／また連絡します）は TPO 所有。実質ではないので残余から除く */
const WAIT_PHRASE_SRC =
  "(?:少し|もう少し|一度|一旦|ゆっくり|じっくり)?(?:検討|考え|相談)(?:させて(?:いただき|頂き|もらい)?ます|します|いたします|致します|してみます|てみます|ます|中です|中で)|(?:後で|あとで|後ほど|のちほど|帰ったら|落ち着いたら|時間(?:が|の)?ある時に|仕事終わりに)?(?:ゆっくり|じっくり)?(?:確認|拝見|見|チェック)(?:させて(?:いただき|頂き|もらい)?ます|します|いたします|致します|ます)|(?:1度|一度|1回|一回|一旦)?(?:確認|拝見|見|チェック)(?:して|し)(?:から|また|改めて|の上で?|次第|、)|(?:後ほど|あとで|また|改めて|再度)?(?:改めて)?(?:ご?連絡|返信|お返事)(?:させて(?:いただき|頂き)?ます|します|いたします|致します)";
const WAIT_PHRASE_RE = new RegExp(WAIT_PHRASE_SRC);
const WAIT_PHRASE_RE_G = new RegExp(WAIT_PHRASE_SRC, "g");

export const CONCERN_HEDGE_RE =
  /不安|心配|迷(?:い|う|って|います|ってます|っちゃ)|悩(?:み|んで|む|ましい)|どう(?:なの)?かな|どうかな|どうなんでしょう|気になっ?(?:て|ちゃ|ります)|微妙|難し(?:い|く|そう)|厳し(?:い|く|そう)|きつ(?:い|く|そう)|怖(?:い|く)|大丈夫(?:なの)?(?:です|でしょう)?か|ネック|引っかか|懸念|かなと|かなぁ|かな(?:[。…！!、\s]|$)|ですかね|ですよね[…。]|💦/mu;

type ConcernRule = { key: ConcernKey; label: string; strongRe?: RegExp; topicRe?: RegExp; replyRe: RegExp; fix: string };
// strongRe: それ自体が評価（古い/高い/狭い/ブラック）→ 単独で懸念成立
// topicRe : 話題語（2階/審査/新生児）→ CONCERN_HEDGE_RE（迷う/不安/どうなのかな…）が同時にあるときのみ懸念
export const CONCERN_RULES: ConcernRule[] = [
  { key: "floor", label: "階数・階段",
    topicRe: /[0-9０-９一二三四五六七八九十]+階|階段|エレベーター|上の階|上階|最上階|階数/,
    replyRe: /[0-9０-９一二三]階|低層|階段|エレベーター|下の階|階数|階部分|階の(?:お)?部屋/,
    fix: "1階またはエレベーター付きのお部屋を中心に" },
  { key: "old", label: "築年数・古さ",
    strongRe: /古(?:い|さ|め|くて|そう)|老朽|ボロ/, topicRe: /築年|築[0-9０-９]+年|築古/,
    replyRe: /築|リノベ|リフォーム|内装|新し|設備|綺麗|きれい|キレイ|外観|室内/,
    fix: "築浅のお部屋を中心に" },
  { key: "price", label: "家賃・費用の高さ",
    strongRe: /高(?:い|め|さ|くて|すぎ|過ぎ)|予算(?:オーバー|超え|を超|より)|オーバー|(?:払|支払)え(?:る|な)/,
    topicRe: /初期費用|家賃|費用|予算|礼金|敷金|保証料/,
    replyRe: /家賃|初期費用|割引|抑え|費用|万円|礼金|敷金|安|交渉|フリーレント/,
    fix: "初期費用・家賃を抑えられるお部屋を中心に" },
  { key: "far", label: "駅距離・立地",
    strongRe: /遠(?:い|さ|め|くて|そう)/, topicRe: /駅から|徒歩[0-9０-９]+分|距離|アクセス|通勤|通学|立地/,
    replyRe: /徒歩|駅|分|近|アクセス|エリア|バス|通勤|通学|立地|沿線/,
    fix: "駅徒歩〇分以内のお部屋を中心に" },
  { key: "narrow", label: "広さ・狭さ",
    strongRe: /狭(?:い|さ|め|くて|そう)|手狭/, topicRe: /広さ|[0-9０-９.]+(?:㎡|平米)|[0-9０-９.]+(?:帖|畳)|間取り/,
    replyRe: /広(?:い|め|さ|く)|㎡|平米|帖|畳|間取り|ゆとり|LDK|DK/,
    fix: "広めのお部屋を中心に" },
  { key: "dark", label: "日当たり・暗さ",
    strongRe: /暗(?:い|さ|め|くて|そう)/, topicRe: /日当たり|採光|北向き|日が入|窓/,
    replyRe: /日当たり|南向き|明る|採光|向き|窓|角部屋/,
    fix: "南向き・日当たりの良いお部屋を中心に" },
  { key: "screening", label: "審査・属性",
    strongRe: /ブラック|夜職|水商売|無職|生活保護|債務整理|自己破産|滞納|審査(?:が)?(?:不安|心配|通る|通ら|落ち)/,
    topicRe: /審査|保証会社|保証人|収入|年収|個人事業主|フリーランス|外国籍|名義|勤続/,
    replyRe: /審査|保証会社|保証人|通り|柔軟|問題(?:ございません|ありません)|ご入居(?:出来|でき)|実績|多数/,
    fix: "審査に通りやすい保証会社のお部屋を中心に" },
  { key: "noise_safety", label: "騒音・治安",
    strongRe: /うるさ|騒音|治安(?:が)?(?:悪|心配|不安)/, topicRe: /治安|防犯|線路|大通り|夜道/,
    replyRe: /治安|防犯|オートロック|静か|騒音|防音|環境/,
    fix: "オートロック付き・静かな環境のお部屋を中心に" },
  { key: "family", label: "家族構成（子供・高齢者）",
    topicRe: /新生児|赤ちゃん|乳児|子供|子ども|お子|妊娠|出産|二人暮らし|三人暮らし|高齢|介護/,
    replyRe: /お子|赤ちゃん|新生児|ご家族|子育て|ベビー|ご出産|[0-9０-９一]階|エレベーター|広め|広い|ファミリー/,
    fix: "お子様とのお住まいに向いたお部屋（1階またはエレベーター付き・広め）を中心に" },
  { key: "equipment", label: "設備（風呂・キッチン等）",
    topicRe: /お風呂|風呂|浴室|浴槽|バス|キッチン|トイレ|洗面|収納|クローゼット|ベランダ|洗濯|独立|ユニット/,
    replyRe: /お風呂|風呂|浴室|浴槽|バス|キッチン|トイレ|洗面|収納|クローゼット|ベランダ|設備|広め|セパレート|独立/,
    fix: "設備条件（お風呂広め等）に合うお部屋を中心に" },
  { key: "pet_parking", label: "ペット・駐車場",
    topicRe: /ペット|猫|犬|駐車場|バイク|自転車|駐輪/,
    replyRe: /ペット|猫|犬|駐車場|バイク|駐輪|飼育|可/,
    fix: "ペット飼育可・駐車場付きのお部屋を中心に" },
  { key: "timing", label: "時期・埋まる不安",
    strongRe: /間に合(?:わ|い|う)|埋ま(?:っ|る|り)/, topicRe: /入居(?:時期|日)|退去|引越し(?:時期|日)|いつまで|期限/,
    replyRe: /入居|退去|時期|日程|間に合|抑え|押さえ|申込|キャンセル料|審査期間/,
    fix: "お申込みでお部屋を抑えた上で" },
];

const KIND_RE: Array<[SubstanceKind, RegExp]> = [
  ["request",   /希望|教えて|内覧|内見|見学|申(?:し)?込|書類|見積|交渉|送って(?:ください|ほしい|欲しい|もらえ|いただけ|頂け)|(?:見|行き|借り|住み|知り|聞き|決め|伺い)たい|してほしい|して欲しい|お願いでき|(?:も|で|を)お?(?:ねがい|願い)(?:します|いたします|致します)|詳細/],
  ["question",  /[?？]|(?:ます|です|でしょう|ません)か(?:[ねぇ]?(?:[。！!、\s]|$))|いつ(?:頃|ごろ|まで|から|に|が|です|でしょ|になり|になる|くらい)|いくら(?!でも)|どこ(?!でも|も)|どちら(?!でも|も)|どの(?:物件|お部屋|方)|どう(?:なり|すれ|いう|やって|でしょ|ですか)|何(?:時|日|円|曜)|なん(?:時|日|じ)/],
  ["schedule",  /明日|明後日|来週|今週|来月|今月|週末|土日|平日|[0-9０-９]{1,2}[月\/][0-9０-９]{1,2}|[0-9０-９]{1,2}日|[月火水木金土日]曜|[0-9０-９]{1,2}[:：.時][0-9０-９]{0,2}|午前|午後|夕方|以降|までに|頃に|ごろ|(?:送ら|送り)(?:せて)?(?:いただき|頂き)?ます/],
  ["condition", /家賃|予算|万円|エリア|駅|線|徒歩|間取り|[1-4１-４](?:LDK|DK|K|R)|ワンルーム|築|向き|設備|オートロック|バストイレ|独立洗面|管理費|共益費|駐車場|ペット|楽器|二人|2人|同棲|ルームシェア|[一-龯ァ-ヶ]{1,6}(?:区|市|町)|周辺|以内|以上|でも大丈夫|このままで/],
  ["decision",  /申(?:し)?込(?:み)?(?:たい|します|お願い|で|させて)|決め(?:ます|たい|ました)|契約(?:したい|します)|押さえ|抑え|進めて|[0-9０-９]{3,4}(?:号室)?でお?(?:ねがい|願い)|号室/],
  ["decline",   /見送|やめ|遠慮|お断り|他で(?:決め|契約)|キャンセル|辞退|白紙|ストップ/],
  ["info",      /住所|勤務先|年収|収入|勤続|保証人|緊急連絡先|保険証|入居(?:日|時期|予定)|退去|引っ?越し|出産|上旬|中旬|下旬|月末|資金|貯め|に決め|にします/],
];

export function analyzeSubstance(
  customerMessage: string | null | undefined,
  units?: string[],
  opts: { staffAskedQuestion?: boolean } = {},
): SubstanceVerdict {
  const normalized = normalizeCustomerText(customerMessage);
  const unitList = units && units.length ? units : splitMessageUnits(customerMessage);
  const evidence: string[] = [];
  const none = (why: string): SubstanceVerdict => ({
    has: false, kinds: [], concerns: [], isAckOnly: true, residue: "", residueLen: 0, normalized, units: unitList, evidence: [why],
  });
  if (!normalized) return none("empty");
  if (/^(?:\[スタンプ\]\s*)+$/.test((customerMessage ?? "").trim())) return none("decor_only");

  // 証拠1: 定型（感謝・了承・締め）文と待ち句を剥がした残余
  const sents = normalized.split(SENT_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  const isAckSent = (s: string) => PURE_ACK_SENT_RE.test(s) || CLOSER_SENT_RE.test(s);
  // 句読点なしの1文（「見積もりありがとうございます 1度確認してまた改めて連絡します」）は待ち句を剥がした後にも定型判定を当てる
  const residue = sents
    .filter((s) => !isAckSent(s))
    .map((s) => s.replace(WAIT_PHRASE_RE_G, "").replace(/^[\s、。！!]+|[\s、。！!]+$/g, ""))
    .filter((s) => Array.from(s).length >= 2 && !isAckSent(s))
    .join(" ");
  const residueLen = cpLen(residue);
  // 純粋な了承: 全文が定型文のみ（待ち句「検討します」は了承ではないので isAckOnly=false・has=false の中間状態）
  const isAckOnly = residueLen === 0 && sents.every((s) => isAckSent(s) || (!WAIT_PHRASE_RE.test(s) && cpLen(s) < 2));
  if (isAckOnly) return { ...none("ack_only"), isAckOnly: true };

  const kinds = new Set<SubstanceKind>();
  const concerns: ConcernHit[] = [];
  const hedge = CONCERN_HEDGE_RE.test(normalized);
  for (const r of CONCERN_RULES) {
    const strong = r.strongRe?.exec(normalized) ?? null;
    const topic = r.topicRe?.exec(normalized) ?? null;
    if (strong || (topic && hedge)) {
      concerns.push({ key: r.key, label: r.label, phrase: (strong ?? topic)![0], replyRe: r.replyRe, fix: r.fix });
    }
  }
  if (concerns.length > 0) { kinds.add("concern"); evidence.push(`concern:${concerns.map((c) => c.key).join(",")}`); }
  for (const [k, re] of KIND_RE) if (re.test(residue)) { kinds.add(k); evidence.push(`kind:${k}`); }
  // 往復文脈: 我々が直前に質問していれば、了承以外の短文は「回答」（「ついてます」「プリウスです」）
  if (opts.staffAskedQuestion && residueLen >= 2 && kinds.size === 0) { kinds.add("answer"); evidence.push("answer:staffAsk"); }
  if (residueLen >= 10 && kinds.size === 0) { kinds.add("statement"); evidence.push(`residue:${residueLen}`); }

  const has = STRONG_KINDS.some((k) => kinds.has(k)) || residueLen >= 10;
  return { has, kinds: [...kinds], concerns, isAckOnly: false, residue, residueLen, normalized, units: unitList, evidence };
}

/** fresh brain のみ補助証拠として合流させる（stale は渡さない） */
export type BrainLite = {
  customer_questions?: string[] | null;
  customer_intent?: string | null;
  condition_change_type?: string | null;
  repeated_concern?: string | null;
  hesitancy_pattern?: string | null;
  customer_concern?: { topic?: string | null; object?: string | null } | null;
} | null | undefined;

export function mergeBrainEvidence(v: SubstanceVerdict, brain: BrainLite, brainFresh: boolean): SubstanceVerdict {
  if (!brainFresh || !brain || v.isAckOnly) return v;
  const kinds = new Set(v.kinds); const evidence = [...v.evidence];
  if ((brain.customer_questions?.length ?? 0) > 0) { kinds.add("question"); evidence.push("brain.customer_questions"); }
  if (brain.condition_change_type && brain.condition_change_type !== "none") { kinds.add("condition"); evidence.push("brain.condition_change_type"); }
  if (brain.repeated_concern || brain.customer_intent === "negative" || brain.customer_concern?.topic) {
    kinds.add("concern");
    evidence.push(`brain.${brain.customer_concern?.topic ? "customer_concern" : brain.repeated_concern ? "repeated_concern" : "intent:negative"}`);
  }
  return { ...v, kinds: [...kinds], evidence, has: v.has || STRONG_KINDS.some((k) => kinds.has(k)) };
}

// ─────────────────────────────────────────────────────────────
// 3. 直前スタッフ発話の分類（StaffTurn）
// ─────────────────────────────────────────────────────────────
export type StaffTurnKind =
  | "viewing_invite" | "property_send" | "estimate_send" | "question_to_customer"
  | "confirmation_promise" | "condition_ask" | "check_result" | "apply_push" | "other";
export type StaffTurn = { kind: StaffTurnKind; source: "aix_log" | "aix_history" | "regex" | "none"; evidence: string };
export type AixRow = { aix_type: string | null; check_pattern?: string | null; created_at: string | null };

const AIX_TO_STAFF: Record<string, StaffTurnKind> = {
  viewing_invite: "viewing_invite", meeting_place: "viewing_invite",
  property_send: "property_send", property_recommendation: "property_send",
  estimate_sheet: "estimate_send", property_check_result: "check_result",
  application_push: "apply_push", condition_hearing: "condition_ask", acknowledge_check: "confirmation_promise",
};
const STAFF_ESTIMATE_RE = /御見積書|お見積書|お見積り|見積書|初期費用.{0,12}[0-9０-９,，]+円/;
const STAFF_VIEWING_INVITE_RE = /(?:ご内覧|内覧|内見|ご案内).{0,25}(?:如何|いかが|ご都合)|ご都合(?:の)?よろしいお日にち|ご案内可能です|[0-9０-９]{1,2}[:：時][0-9０-９]{0,2}.{0,12}(?:ご案内|案内可能)/;
const STAFF_APPLY_PUSH_RE = /お申込み?(?:し|で)お部屋(?:を)?(?:抑え|押さえ)|お申込み?(?:頂け|いただけ)ます/;
const STAFF_QUESTION_RE = /(?:でしょうか|ますか|ですか|ございますか|御座いますか|お聞かせ(?:ください|頂け|いただけ)|教えて(?:頂け|いただけ|ください))[！!？?😊😌]*$/;
const STAFF_CONDITION_ASK_RE = /お部屋お探し中|ご希望(?:の)?条件|①【ご入居の時期】|ご希望のエリア|条件(?:を)?お聞かせ/;
const STAFF_CONFIRM_PROMISE_RE = /(?:確認|お調べ)(?:させて(?:頂|いただ)き|いたし|致し|し)[^\n。！!]{0,25}(?:ご連絡|お送り|お伝え)|(?:確認|撮影)(?:出来|でき)次第/;
const STAFF_PROPERTY_SEND_RE = /🌟|ピックアップ(?:させて頂きました|させていただきました|いたしました|しました)|ご査収ください|お送りさせて頂きました|お送りさせていただきました|号室|[0-9０-９.．]+万円/;

export function classifyLastStaffTurn(
  lastStaffText: string | null | undefined,
  opts: { recentAixRows?: AixRow[]; lastStaffAt?: string | null; lastAixHistory?: string | null; windowMs?: number } = {},
): StaffTurn {
  const text = (lastStaffText ?? "").trim();
  const windowMs = opts.windowMs ?? 3 * 60 * 1000;
  // ① 一次証拠: aix_usage_logs。直前スタッフ発言の送信時刻 ±3分の行のみ紐付ける（古いAIX行を手打ち発言に誤帰属させない）
  const at = Date.parse(opts.lastStaffAt ?? "");
  if (Number.isFinite(at)) {
    const hit = (opts.recentAixRows ?? []).find((r) => {
      const t = Date.parse(r.created_at ?? "");
      return Number.isFinite(t) && Math.abs(t - at) <= windowMs && !!r.aix_type && !!AIX_TO_STAFF[r.aix_type];
    });
    if (hit) {
      let kind = AIX_TO_STAFF[hit.aix_type as string];
      if (kind === "check_result" && STAFF_ESTIMATE_RE.test(text)) kind = "estimate_send";
      return { kind, source: "aix_log", evidence: `${hit.aix_type}${hit.check_pattern ? "/" + hit.check_pattern : ""}@${hit.created_at}` };
    }
  }
  // ② 本文の決定論。優先: 見積 > 内覧打診 > 申込打診 > 条件ヒアリング > 質問（末尾行） > 確認約束 > 物件送付
  //   （条件ヒアリングは「ご希望条件お聞かせください」の疑問形を含むため質問より先に判定する）
  if (text) {
    const lastLine = text.split("\n").filter(Boolean).slice(-1)[0] ?? "";
    if (STAFF_ESTIMATE_RE.test(text) && /となります|ご査収|お送り|作成/.test(text)) return { kind: "estimate_send", source: "regex", evidence: text.match(STAFF_ESTIMATE_RE)![0] };
    if (STAFF_VIEWING_INVITE_RE.test(text)) return { kind: "viewing_invite", source: "regex", evidence: text.match(STAFF_VIEWING_INVITE_RE)![0] };
    if (STAFF_APPLY_PUSH_RE.test(text)) return { kind: "apply_push", source: "regex", evidence: text.match(STAFF_APPLY_PUSH_RE)![0] };
    if (STAFF_CONDITION_ASK_RE.test(text)) return { kind: "condition_ask", source: "regex", evidence: text.match(STAFF_CONDITION_ASK_RE)![0] };
    if (STAFF_QUESTION_RE.test(lastLine)) return { kind: "question_to_customer", source: "regex", evidence: lastLine.slice(-30) };
    if (STAFF_CONFIRM_PROMISE_RE.test(text)) return { kind: "confirmation_promise", source: "regex", evidence: text.match(STAFF_CONFIRM_PROMISE_RE)![0] };
    if (STAFF_PROPERTY_SEND_RE.test(text)) return { kind: "property_send", source: "regex", evidence: text.match(STAFF_PROPERTY_SEND_RE)![0] };
  }
  // ③ 本文が無い（画像のみ等）→ brain の last_aix_history「最新:xxx」
  const m = /最新:([a-z_]+)/.exec(opts.lastAixHistory ?? "");
  if (m && AIX_TO_STAFF[m[1]]) return { kind: AIX_TO_STAFF[m[1]], source: "aix_history", evidence: m[0] };
  return { kind: "other", source: text ? "regex" : "none", evidence: "" };
}

// ─────────────────────────────────────────────────────────────
// 4. 顧客返答の分類（CustomerResponse）
// ─────────────────────────────────────────────────────────────
export type CustomerResponseKind =
  | "concern" | "positive" | "thinking" | "will_send_later" | "question" | "decline" | "condition_change" | "answer" | "ack_only" | "other";
export type CustomerResponse = {
  kind: CustomerResponseKind;
  secondary: CustomerResponseKind[];
  /** 懸念の対象語（2階／お風呂／家賃…）。無ければ null */
  object: string | null;
  evidence: string;
  source: "regex" | "flag" | "brain";
};
export type CustomerResponseFlags = {
  isThinkingMsg?: boolean; isTemporaryLeaveMsg?: boolean;
  isConditionChangeRequest?: boolean; isConditionPresented?: boolean;
  negativeKind?: "withdrawal" | "staff_report" | null;
  brain?: BrainLite; // fresh のみ
};
const PRIORITY: CustomerResponseKind[] = ["decline", "condition_change", "question", "concern", "will_send_later", "thinking", "positive", "answer", "ack_only", "other"];
const CUST_DECLINE_RE = /見送(?:らせて|ります|りたい|ろうと)|やめ(?:て|とき|とこ)|遠慮(?:し|させ)|今回は(?:結構|大丈夫|やめ|見送|なし)|お断り|他で(?:決め|契約)|キャンセル(?:で|し|お願い)/;
const CUST_QUESTION_RE = /[?？]|(?:ます|です|でしょう|ません)か(?:ね|ねぇ)?(?:[。！!、]|$)|いくら(?!でも)|いつ(?:頃|ごろ|まで|から|に)|可能でしょうか|教えて(?:ください|頂け|いただけ|もらえ)/;
const CUST_CONCERN_OBJECT_RE = /[0-9０-９]+階|階段|エレベーター|お風呂|浴室|浴槽|家賃|初期費用|礼金|敷金|審査|保証会社|駅(?:から|まで)?(?:遠|距離|徒歩)|築(?:年|古)|日当たり|広さ|間取り|駐車場|周辺|治安|騒音|新生児|赤ちゃん|子供|お子|ペット|外観|内装/;
/** 「気になる物件を後で送る」型（持込予告）。単なる「また連絡します」（callback）は thinking に流す */
const CUST_WILL_SEND_RE = /(?:明日|明日以降|後日|また|改めて|後ほど|次回|週末|来週|見つけたら|あれば|出てきたら|気になる).{0,24}?(?:送らせて|お送り|送り(?:ます|させて)|送ります|共有(?:し|させて))|(?:気になる|候補|物件|お部屋).{0,15}(?:何件|いくつ|数件|複数).{0,20}(?:送|共有)/;
const CUST_CALLBACK_RE = /(?:後ほど|あとで|また|改めて|後日|次回|確認して|見てから).{0,16}?(?:ご?連絡|返信|お返事)(?:させて|いたし|します|致し)/;
const CUST_THINKING_RE = /検討(?:します|させて|いたします|致します|中|してみ)|考え(?:ます|てみ|させて|中)|相談(?:して|し|させて)|持ち帰|決めかね|決められ(?:ない|ず|ません)|時間を(?:ください|下さい|頂|いただ)|迷います|迷い|どうなのかな|どうかな/;
const CUST_POSITIVE_RE = /気に入|良さそう|よさそう|いいですね|素敵|ぜひ|是非|進めて|申(?:し)?込(?:み)?(?:たい|します|お願い|で)|内覧(?:したい|お願い|希望|行き)|見に行き|大丈夫だと思います|問題ない/;

export function classifyCustomerResponse(sub: SubstanceVerdict, staff: StaffTurn, flags: CustomerResponseFlags = {}): CustomerResponse {
  const raw = sub.normalized;
  const lines = raw.split("\n").map((s) => s.trim()).filter(Boolean);
  const found = new Map<CustomerResponseKind, string>();
  const put = (k: CustomerResponseKind, ev: string) => { if (!found.has(k)) found.set(k, ev); };
  if (sub.isAckOnly) {
    return { kind: "ack_only", secondary: [], object: null, evidence: raw.slice(0, 30), source: "regex" };
  }
  // ① 上位フラグ（route.ts 計算済み。同名述語を二重実装しない）
  if (flags.negativeKind === "withdrawal") put("decline", "flag:withdrawal");
  if (flags.isConditionChangeRequest || flags.isConditionPresented) put("condition_change", flags.isConditionPresented ? "flag:isConditionPresented" : "flag:isConditionChangeRequest");
  // ② 行ごとの決定論。「感謝1行＋懸念1行」は最も強い1行で決める（末尾優先／先頭優先を両方避ける）
  for (const p of lines) {
    if (PURE_ACK_SENT_RE.test(p)) { put("ack_only", p); continue; }
    if (CUST_DECLINE_RE.test(p)) put("decline", p);
    if (CUST_QUESTION_RE.test(p)) put("question", p);
    if (sub.concerns.length > 0 && (CONCERN_HEDGE_RE.test(p) || sub.concerns.some((c) => p.includes(c.phrase)))) put("concern", p);
    if (CUST_WILL_SEND_RE.test(p)) put("will_send_later", p);
    if (CUST_THINKING_RE.test(p) || CUST_CALLBACK_RE.test(p) || flags.isThinkingMsg) put("thinking", p);
    if (CUST_POSITIVE_RE.test(p)) put("positive", p);
  }
  // ③ 往復文脈: スタッフが直前に質問していれば、了承以外の短文は「回答」（「ついてます」「今無事終わりました」）
  const nonAckFound = [...found.keys()].filter((k) => k !== "ack_only");
  if (staff.kind === "question_to_customer" && nonAckFound.length === 0 && sub.residueLen >= 2) put("answer", "staffAsk:question");
  // ④ brain（fresh のみ）は補助証拠: regex が拾えなかった懸念・質問・条件変更を追加するだけで regex を上書きしない
  const b = flags.brain;
  if (b) {
    if (!found.has("concern") && (b.customer_intent === "negative" || !!b.repeated_concern || b.hesitancy_pattern === "concern" || !!b.customer_concern?.topic)) put("concern", `brain:${b.customer_concern?.topic ?? b.customer_intent ?? b.hesitancy_pattern ?? "repeated_concern"}`);
    if (!found.has("question") && (b.customer_questions?.length ?? 0) > 0) put("question", `brain:customer_questions[${b.customer_questions!.length}]`);
    if (!found.has("condition_change") && b.condition_change_type && b.condition_change_type !== "none") put("condition_change", `brain:condition_change_type=${b.condition_change_type}`);
  }
  // ⑤ 「迷います」「どうかな」は対象語（階・お風呂・家賃…）があれば concern、無ければ thinking
  if (found.has("concern") && found.has("thinking") && !CUST_CONCERN_OBJECT_RE.test(raw) && sub.concerns.length === 0) found.delete("concern");
  if (found.has("concern") && sub.concerns.length > 0) found.delete("thinking"); // 対象付きの迷いは懸念が主
  // ⑥ 一時保留（出先なので後で見ます）は「後で送る予告」ではない
  if (flags.isTemporaryLeaveMsg && !found.has("will_send_later") && !found.has("concern") && !found.has("question")) put("other", "flag:isTemporaryLeaveMsg");

  // ack_only は残余がある時は主分類にしない（「ありがとう＋702号室お願いします」は了承ではない）
  const ordered = PRIORITY.filter((k) => found.has(k) && k !== "ack_only");
  const primary: CustomerResponseKind = ordered[0] ?? (sub.residueLen >= 2 ? "other" : "ack_only");
  const secondary = ordered.slice(1);
  const ev = found.get(primary) ?? "";
  const objectMatch = raw.match(CUST_CONCERN_OBJECT_RE);
  return { kind: primary, secondary, object: objectMatch ? objectMatch[0] : null, evidence: ev, source: ev.startsWith("brain:") ? "brain" : ev.startsWith("flag:") ? "flag" : "regex" };
}

// ─────────────────────────────────────────────────────────────
// 5. PAIR_MATRIX（staff × customer → 方向指示・必須要素・禁止・成約実例）
// ─────────────────────────────────────────────────────────────
export type PairPrecedence = "override_wait" | "after_wait";
export type PairRule = {
  id: string;
  staff: StaffTurnKind | "*";
  customer: CustomerResponseKind | "*";
  precedence: PairPrecedence;
  /** tpoNoteForLLM ↔ few-shot「■ 場面【…】」↔ final-check の同名ラベル */
  tpoLabel: string;
  direction: string;
  mustInclude: { label: string; detect: RegExp }[];
  mustNot: string[];
  example: string;
  length: string;
};

const DECL_TAIL = "(?:させて(?:頂|いただ)き|いたし|致し)ます";

export const PAIR_MATRIX: PairRule[] = [
  { id: "VI_CONCERN", staff: "viewing_invite", customer: "concern", precedence: "override_wait",
    tpoLabel: "提案後の懸念（内覧打診への懸念返答）",
    direction: "我々の内覧打診に対し顧客が物件の懸念（{object}）を返した。①「〇〇さんお世話になっております！！」または「ご要望お聞かせ頂きありがとうございます😊！！」型の受け止め1文（共感語禁止）②履歴にある事実で答えられる時のみ事実回答1文（無ければ省略）③懸念を条件語に変換した再ピックアップ宣言1文（{fix}）④内覧は「お気に召されましたらいつでも」の開放のみで押さない⑤締め。120〜200字",
    mustInclude: [
      { label: "懸念対象の復唱（例: お子様との階段の上り下り）", detect: /階段|[0-9０-９]+階|1階|１階|エレベーター|お子様|新生児|お風呂|広め|築|家賃|初期費用|審査/ },
      { label: "懸念→条件変換の再ピックアップ宣言", detect: new RegExp(`(?:中心に|条件に合|優先して).{0,40}(?:ピックアップ|お調べ|お探し|探さ|お送り).{0,30}${DECL_TAIL}`) },
    ],
    mustNot: ["「お気持ち、よくわかります」等の共感フレーズ", "「かしこまりました！！」で終える", "「はい😊！！」開始", "内覧日程の再提案・候補日時", "申込誘導・希少性煽り", "「2階でも大丈夫」等の根拠なし安心づけ", "懸念を質問で返す"],
    example: "あみさんお世話になっております！！\nご要望お聞かせ頂きありがとうございます😊！！\n新生児のお子様との階段の上り下りはご負担になりますので、1階またはエレベーター付きのお部屋を中心にあみさんにオススメできるお部屋再度ピックアップしお送りさせて頂きます！！\nこちらのお部屋も含めお気に召されましたらいつでもご内覧頂けますので、あみさんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます😌！！",
    length: "120〜200字" },

  { id: "VI_POSITIVE", staff: "viewing_invite", customer: "positive", precedence: "after_wait",
    tpoLabel: "内覧調整（内覧打診への前向き返答）",
    direction: "内覧受付。候補日時は AIX 内覧日調整で送るため本文は受付＋「ご都合よろしいお日にち御座いますでしょうか」の確認のみ。既に候補日を出している場合は日時確定の復唱のみ。40〜90字",
    mustInclude: [{ label: "受付語", detect: /かしこまりました/ }, { label: "日程確認 or 確定復唱", detect: /ご都合|お日にち|[0-9０-９]{1,2}[/／月][0-9０-９]{1,2}|[0-9０-９]{1,2}時/ }],
    mustNot: ["申込誘導", "別物件提案", "募集未確認物件への内覧確約"],
    example: "かしこまりました！！\nお部屋ご案内させていただきます！！\nタクミさんご都合よろしいお日にち御座いますでしょうか😊！！",
    length: "40〜90字" },

  { id: "VI_THINKING", staff: "viewing_invite", customer: "thinking", precedence: "after_wait",
    tpoLabel: "検討中フォロー（内覧打診後）",
    direction: "急かさない受け止め＋内覧の扉を開けたまま待つ。「はい😊！！」→「ごゆっくりご検討頂けますと幸いです！！」→「ご内覧出来ますので、気になる点出てきましたらいつでもお気軽にご連絡ください😌！！」。70〜120字",
    mustInclude: [{ label: "急かさない受け止め", detect: /ごゆっくり/ }, { label: "内覧の扉を開ける1文", detect: /内覧|いつでも/ }],
    mustNot: ["希少性煽り", "申込誘導", "物件追加提案", "「かしこまりました」開口語"],
    example: "はい😊！！\nごゆっくりご検討頂けますと幸いです！！\nご内覧出来ますので、あいさん気になる点出てきましたらいつでもお気軽にご連絡ください😌！！",
    length: "70〜120字" },

  { id: "ES_WILL_SEND", staff: "estimate_send", customer: "will_send_later", precedence: "override_wait",
    tpoLabel: "提案後の検討・持込予告（見積送付後）",
    direction: "我々の見積送付に対し顧客が「検討する＋気になる物件を後日送る」と返した。①「〇〇さんお世話になっております！！」②「はい😊！！ごゆっくりご検討頂けますと幸いです！！」（急かさない）③送ってもらう物件を先取りして受ける宣言（お送り頂き次第募集状況確認＋最大限割引の御見積書とあわせてご連絡）④直前の見積物件は「お気に召されましたらお申込しお部屋抑えさせて頂きます」で扉を開けたまま⑤締め。120〜220字",
    mustInclude: [
      { label: "見積の検討を急かさない1文", detect: /ごゆっくり|ご検討|ご確認/ },
      { label: "後日送られる物件を先取りして受ける宣言（募集状況確認）", detect: /(?:お送り|送って|いつでも)(?:頂|いただ|ください).{0,40}(?:募集状況|確認)|募集状況.{0,20}確認/ },
      { label: "その物件の見積も出す宣言", detect: /(?:御見積書|お見積書|見積).{0,25}(?:作成|お送り|ご用意|あわせて|ご連絡)/ },
    ],
    mustNot: ["申込催促・希少性煽り（人気のため早めに等）", "こちらからの新規1件推し宣言（顧客が自分で送ると言っている）", "「かしこまりました！！」単独終了", "「ごゆっくりご検討ください」だけの締め"],
    example: "みくさんお世話になっております！！\nはい😊！！ごゆっくりご検討頂けますと幸いです！！\n気になるお部屋ございましたらお送りください！！お送り頂き次第募集状況確認させて頂き、最大限割引させて頂いた初期費用の御見積書とあわせてご連絡させて頂きます！！\nエストレーラ305号室もお気に召されましたらお申込しお部屋抑えさせて頂きますので、いつでもお気軽にご連絡ください😌！！",
    length: "120〜220字" },

  { id: "ES_THINKING", staff: "estimate_send", customer: "thinking", precedence: "after_wait",
    tpoLabel: "検討中フォロー（見積送付後）",
    direction: "急かさない受け止め＋次工程（内覧／申込）の開放1文。「はい😊！！ごゆっくりご確認頂けますと幸いです！！」→「お部屋お気に召されましたら実際にご案内させて頂きますのでいつでもお気軽にご連絡ください😌！！」。70〜130字",
    mustInclude: [{ label: "急かさない受け止め", detect: /ごゆっくり/ }, { label: "次工程の開放（内覧／申込／不明点）", detect: /お気に召され|ご不明|ご不安|いつでも/ }],
    mustNot: ["申込催促・希少性煽り", "別物件提案", "初期費用割引の再掲", "「かしこまりました」開口語"],
    example: "愛乃さん、お世話になっております！！\nはい😊！！ごゆっくりご確認頂けますと幸いです！！\nお部屋お気に召されましたら、実際にお部屋ご案内させて頂きますのでいつでもお気軽にご連絡ください😌！！",
    length: "70〜130字" },

  { id: "ES_CONCERN", staff: "estimate_send", customer: "concern", precedence: "override_wait",
    tpoLabel: "提案後の懸念（見積への懸念）",
    direction: "見積への懸念（{object}）に事実で理由を1文説明（礼金がかかる等・履歴にある事実のみ）→初期費用を抑えられる別物件を探す宣言。共感語不要。90〜150字",
    mustInclude: [
      { label: "高い理由の事実説明", detect: /礼金|敷金|仲介|保証|(?:となります|かかります|高くなって)/ },
      { label: "初期費用を抑えた別物件を探す宣言", detect: new RegExp("(?:初期費用|費用|家賃).{0,15}(?:抑え|安い|抑えられ).{0,30}(?:探|ピックアップ|お調べ)") },
    ],
    mustNot: ["値引き確約", "共感語のみ", "申込誘導"],
    example: "はい！！\nこちらの2物件は、礼金がかかりますので初期費用高くなってしまいます。\n別物件で初期費用抑えられるオススメ出来るお部屋探させて頂きます！！\n何卒よろしくお願い致します😌！！",
    length: "90〜150字" },

  { id: "ES_POSITIVE", staff: "estimate_send", customer: "positive", precedence: "after_wait",
    tpoLabel: "申込打診（見積送付後の前向き返答）",
    direction: "申込でお部屋を抑える宣言＋（履歴にある事実のみ）保証会社審査通過までキャンセル料なし等の事実1文。煽り禁止。80〜160字",
    mustInclude: [{ label: "申込でお部屋を抑える宣言", detect: /お申込.{0,15}(?:抑え|押さえ)/ }],
    mustNot: ["「埋まってしまいます」等の煽り", "書類リスト生成", "未確認の退去日・入居可能日の断言"],
    example: "竹田さんお世話になっております！！\nはい！お申込しお部屋を抑える事可能です！！保証会社の審査が通過するまではキャンセル料一切かかりません！！\n竹田さん問題なければお申込しお部屋抑えさせて頂きます😌！！",
    length: "80〜160字" },

  { id: "PS_CONCERN", staff: "property_send", customer: "concern", precedence: "override_wait",
    tpoLabel: "提案後の懸念（物件送付後）",
    direction: "送付物件への懸念（{object}）を条件に変換し再ピックアップ宣言。「ご要望お聞かせ頂きありがとうございます😊！！」→「{fix}〇〇さんにオススメできるお部屋お調べさせて頂きます！！」→サポート継続。共感文だけは不合格。90〜150字",
    mustInclude: [
      { label: "懸念→条件語の復唱（広め／1階／初期費用抑えめ等）", detect: /広め|広い|1階|１階|エレベーター|抑え|近い|新し|静か|明る|築浅|保証会社/ },
      { label: "再ピックアップ宣言", detect: new RegExp(`(?:中心に|条件に合|優先して).{0,30}(?:お調べ|ピックアップ|お探し|探さ).{0,30}${DECL_TAIL}`) },
    ],
    mustNot: ["「お気持ちよくわかります」等の共感語", "送付物件の擁護・説得", "内覧誘導・申込誘導", "「かしこまりました！！」単独終了", "「はい😊！！」開始"],
    example: "あみさんお世話になっております！！\nご要望お聞かせ頂きありがとうございます😊！！\nお風呂広めのお部屋を中心にあみさんにオススメできるお部屋お調べさせて頂きます！！\nあみさんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！",
    length: "90〜150字" },

  { id: "PS_THINKING", staff: "property_send", customer: "thinking", precedence: "after_wait",
    tpoLabel: "検討中フォロー（物件送付後）",
    direction: "急かさない受け止め＋随時ピックアップ宣言 or 内覧の扉を開ける1文。「はい😊！！」→「ごゆっくりご検討（ご相談）頂けますと幸いです！！」→「ご条件に合うお部屋出てきましたら随時ピックアップしてお送りさせて頂きます」or「気になる点出てきましたらいつでもお気軽にご連絡ください」。70〜130字",
    mustInclude: [{ label: "急かさない受け止め", detect: /ごゆっくり|ご相談|ご検討/ }, { label: "随時ピックアップ宣言 or 扉を開ける1文", detect: /随時|出てきましたら|出次第|いつでも|内覧/ }],
    mustNot: ["申込誘導", "希少性煽り（人気のため早めに等）", "「かしこまりました！！」単独終了", "検討依頼の繰り返し（ご検討の程〜）"],
    example: "お世話になっております！！\nかしこまりました！！ごゆっくりご相談頂けますと幸いです😊！！\nまたrさんにオススメできるお部屋出てきましたら随時ピックアップしてお送りさせて頂きますので、何卒よろしくお願い致します！！",
    length: "70〜130字" },

  { id: "PS_WILL_SEND", staff: "property_send", customer: "will_send_later", precedence: "override_wait",
    tpoLabel: "提案後の検討・持込予告（物件送付後）",
    direction: "急かさない受け止め＋顧客が送る／相談する行動を先取りして受ける宣言（条件に合う部屋が出たら随時ピックアップ／送って頂いた物件は募集状況確認）。90〜150字",
    mustInclude: [
      { label: "急かさない受け止め", detect: /ごゆっくり|ご相談|ご検討/ },
      { label: "先取りの行動宣言（随時ピックアップ or 募集状況確認）", detect: /(?:随時|出次第|出てきましたら|お送り頂き次第|お送り頂けましたら|届き次第).{0,30}(?:ピックアップ|お送り|確認)/ },
    ],
    mustNot: ["申込誘導", "希少性煽り", "「かしこまりました！！」単独終了"],
    example: "お世話になっております！！\nかしこまりました！！ごゆっくりご相談頂けますと幸いです😊！！\nまたrさんにオススメできるお部屋出てきましたら随時ピックアップしてお送りさせて頂きますので、何卒よろしくお願い致します！！",
    length: "90〜150字" },

  { id: "PS_QUESTION", staff: "property_send", customer: "question", precedence: "override_wait",
    tpoLabel: "質問回答（物件送付後）",
    direction: "質問に履歴・知識にある事実のみで直接回答（不明なら「〇〇を管理会社に確認させて頂きます」＋対象復唱）→回答を前提にした次工程1文。100〜160字",
    mustInclude: [
      { label: "直接回答 or 対象を復唱した確認宣言", detect: /(?:となります|ございます|可能です|問題ございません|かかります|(?:出来|でき)ます)|確認させて(?:頂|いただ)き/ },
      // 「〜させて頂き、〜がオススメです」の提案形も次工程として認める（成約実例 rさん）
      { label: "次工程の宣言 or 提案", detect: new RegExp(`${DECL_TAIL}|させて(?:頂|いただ)き[、,]|(?:オススメ|おすすめ|お勧め)(?:です|致します|いたします)`) },
    ],
    mustNot: ["宅建業法上の根拠なし断言（空室・告知事項・入居可能日）", "質問で質問を返す"],
    example: "rさんお世話になっております！！\nスプランディッド難波WESTⅡのような好条件のお部屋はすぐに埋まってしまう可能性が高いお部屋となります！！\nお気に召されたお部屋を一度弊社撮影またはオンライン内見をさせて頂き、お部屋を抑えた状態で9月13日以降にご内覧頂くのがオススメです😊！！",
    length: "100〜160字" },

  { id: "PS_CONDITION_CHANGE", staff: "property_send", customer: "condition_change", precedence: "override_wait",
    tpoLabel: "条件変更（物件送付後）",
    direction: "既存 conditionDirection を使う。差分条件の復唱＋新条件で再ピックアップ宣言＋送付済み物件は選択肢として残す1文。110〜180字",
    mustInclude: [
      { label: "新条件の復唱", detect: /(?:区|駅|線|万円|万以内|以下|階|広め|築)/ },
      { label: "再ピックアップ宣言", detect: new RegExp(`ピックアップ.{0,20}${DECL_TAIL}`) },
    ],
    mustNot: ["条件の聞き返し", "送付済み物件の再送宣言"],
    example: "慶次さんお待たせ致しました！！\n北区・福島区・西区周辺全域から探させていただいたのですが、以前お送りさせていただいたお部屋以外の新着物件募集ございませんでした。\nメロディーハイム九条203号室も好条件のお部屋となりますので並行して選択肢に残しつつ、新着物件が出次第ピックアップしてお送りさせていただきます！！",
    length: "110〜180字" },

  { id: "QC_ANSWER", staff: "question_to_customer", customer: "*", precedence: "after_wait",
    tpoLabel: "顧客回答の受領",
    direction: "我々の質問への回答を受領し、その回答を前提にした次工程（見積作成／内覧調整／ピックアップ）を宣言。回答内容への評価コメントは書かない。60〜120字",
    mustInclude: [
      { label: "受領語", detect: /かしこまりました|ありがとうございます/ },
      { label: "回答を前提にした次工程宣言", detect: new RegExp(`(?:御見積書|お見積書|内覧|ピックアップ|確認|ご案内).{0,30}${DECL_TAIL}`) },
    ],
    mustNot: ["回答内容への評価コメント", "同じ質問の再確認"],
    example: "かしこまりました！！\n初期費用も最大限割引させていただいたお見積書作成しお送りさせていただきます😊！！",
    length: "60〜120字" },

  { id: "CP_ACK", staff: "confirmation_promise", customer: "ack_only", precedence: "after_wait",
    tpoLabel: "短い了承（直前スタッフ約束への了承）",
    direction: "既存「短い了承」（promiseEchoNote）と同一。開口語「はい😊！！」→直前約束の復唱WE DO 1文→締め。40〜90字",
    mustInclude: [{ label: "直前約束の復唱WE DO", detect: /(?:確認出来次第|出来次第|次第).{0,20}(?:ご連絡|お送り)/ }],
    mustNot: ["約束に無い業務語彙（撮影・ご査収・内覧日程）"],
    example: "はい😊！！\n募集状況確認出来次第ご連絡させて頂きます！！\n何卒よろしくお願い致します！！",
    length: "40〜90字" },

  { id: "ANY_DECLINE", staff: "*", customer: "decline", precedence: "after_wait",
    tpoLabel: "ネガ文脈（顧客自身の断り）",
    direction: "既存 withdrawal direction をそのまま採用",
    mustInclude: [{ label: "扉を開ける1文", detect: /またお部屋探しの際|いつでも/ }],
    mustNot: ["引き留め提案", "謝罪"],
    example: "かしこまりました！！\nまたお部屋探しの際はいつでもお気軽にご連絡ください😊！！\nこの度はありがとうございました！！",
    length: "50〜110字" },

  { id: "ANY_QUESTION", staff: "*", customer: "question", precedence: "override_wait",
    tpoLabel: "質問回答",
    direction: "質問に事実で直接回答→次工程宣言（直前スタッフ種別が不明でも質問は必ず答える）。100〜160字",
    mustInclude: [{ label: "直接回答 or 確認宣言", detect: /(?:となります|ございます|可能です|問題ございません|かかります|(?:出来|でき)ます)|確認させて(?:頂|いただ)き/ }],
    mustNot: ["質問返し", "根拠なし断言"],
    example: "はい！かなり入ってくる可能性は低くなります！換気フィルターの定期的な清掃、防虫フィルターを設置行いますと虫の侵入を防ぐ事が出来ます！！\n内装の色味についてはブラウン基調となります！",
    length: "100〜160字" },

  { id: "ANY_CONCERN", staff: "*", customer: "concern", precedence: "override_wait",
    tpoLabel: "提案後の懸念",
    direction: "PS_CONCERN と同じ骨格（直前スタッフ種別 other/check_result でも懸念は必ず『事実回答＋条件変換した再ピックアップ』）。{fix}",
    mustInclude: [
      { label: "懸念対象の復唱", detect: /階|お風呂|家賃|初期費用|審査|駅|築|広|日当たり|駐車場|治安|お子様|新生児/ },
      { label: "再ピックアップ or 安心材料の事実", detect: new RegExp(`(?:ピックアップ|お調べ|お探し|探さ).{0,30}${DECL_TAIL}|多数ございます|可能です`) },
    ],
    mustNot: ["共感フレーズ", "「かしこまりました！！」単独終了", "「はい😊！！」開始"],
    example: "かしこまりました😊！！\n夜職・ブラックでもご入居できるお部屋は多数ございますので、審査に通りやすい保証会社中心にお部屋ピックアップさせて頂きます！！\nご不安な点も含めて全力でサポートさせて頂きますので、何卒よろしくお願い致します😌！！",
    length: "100〜160字" },

  { id: "ANY_WILL_SEND", staff: "*", customer: "will_send_later", precedence: "override_wait",
    tpoLabel: "提案後の検討・持込予告",
    direction: "PS_WILL_SEND と同じ骨格。顧客が予告した行動を先取りして受ける宣言を必ず1文。90〜160字",
    mustInclude: [{ label: "先取りの行動宣言", detect: /(?:随時|出次第|出てきましたら|お送り頂き次第|お送り頂けましたら|届き次第).{0,30}(?:ピックアップ|お送り|確認|ご連絡)/ }],
    mustNot: ["申込誘導", "希少性煽り", "「かしこまりました！！」単独終了"],
    example: "お世話になっております！！\nかしこまりました！！ごゆっくりご相談頂けますと幸いです😊！！\nまた〇〇さんにオススメできるお部屋出てきましたら随時ピックアップしてお送りさせて頂きますので、何卒よろしくお願い致します！！",
    length: "90〜160字" },
];

export const STAFF_KIND_JA: Record<StaffTurnKind, string> = {
  viewing_invite: "内覧打診", property_send: "物件送付", estimate_send: "見積書送付", question_to_customer: "お客様への質問",
  confirmation_promise: "確認の約束", condition_ask: "条件ヒアリング", check_result: "募集状況の確認結果報告", apply_push: "申込打診", other: "その他",
};
export const CUSTOMER_KIND_JA: Record<CustomerResponseKind, string> = {
  concern: "物件への懸念", positive: "前向き", thinking: "検討中", will_send_later: "後日物件を送る予告", question: "質問",
  decline: "断り", condition_change: "条件変更", answer: "質問への回答", ack_only: "了承のみ", other: "その他",
};

// ─────────────────────────────────────────────────────────────
// 6. PairContext（単一 verdict）
// ─────────────────────────────────────────────────────────────
export interface PairContext {
  staff: StaffTurn;
  customer: CustomerResponse;
  substance: SubstanceVerdict;
  rule: PairRule | null;
  ruleId: string | null;
  /** LLM 注入・修正指示・tpo_debug にそのまま使える1行要約 */
  summary: string;
  lastStaffText: string;
}

export function resolveTurnPair(staff: StaffTurn, customer: CustomerResponse, substance: SubstanceVerdict, lastStaffText: string): PairContext {
  const rule =
    PAIR_MATRIX.find((r) => r.staff === staff.kind && r.customer === customer.kind) ??
    PAIR_MATRIX.find((r) => r.staff === "*" && r.customer === customer.kind) ??
    PAIR_MATRIX.find((r) => r.staff === staff.kind && r.customer === "*") ??
    null;
  const summary =
    `${STAFF_KIND_JA[staff.kind]} → ${CUSTOMER_KIND_JA[customer.kind]}` +
    (customer.secondary.length ? `＋${customer.secondary.map((k) => CUSTOMER_KIND_JA[k]).join("・")}` : "") +
    (substance.concerns.length ? `（懸念: ${substance.concerns.map((c) => `${c.label}「${c.phrase}」`).join("、")}）` : "") +
    (customer.object && !substance.concerns.length ? `（対象: ${customer.object}）` : "");
  return { staff, customer, substance, rule, ruleId: rule?.id ?? null, summary, lastStaffText: lastStaffText ?? "" };
}

/** 方向指示文（決定論リテラル）。{object}/{fix} を実値に置換し、fresh brain の reply_direction は末尾に「参考」で添える */
export function buildPairDirection(pair: PairContext, opts: { brainReplyDirection?: string | null; brainFresh: boolean }): string | null {
  if (!pair.rule) return null;
  const object = pair.customer.object ?? pair.substance.concerns[0]?.phrase ?? "";
  const fix = pair.substance.concerns.map((c) => c.fix).join("、") || "ご希望条件のお部屋を中心に";
  const dir = pair.rule.direction.replace(/\{object\}/g, object).replace(/\{fix\}/g, fix);
  const must = pair.rule.mustInclude.map((m, i) => `${i + 1}.${m.label}`).join(" ");
  const ref = opts.brainFresh && opts.brainReplyDirection ? ` brain方向性（参考）:「${opts.brainReplyDirection}」` : "";
  return `${dir}。必須要素: ${must}。禁止: ${pair.rule.mustNot.join("／")}${ref}`;
}

/** dynamicBlock に注入する【往復文脈】ブロック（tpoGuidanceNote より上位・ハードゲートの次） */
export function buildTurnPairNote(pair: PairContext, customerMessage: string, customerName: string): string {
  const staffJa = STAFF_KIND_JA[pair.staff.kind];
  const custJa = CUSTOMER_KIND_JA[pair.customer.kind];
  const object = pair.customer.object ?? pair.substance.concerns[0]?.phrase ?? "";
  const fix = pair.substance.concerns.map((c) => c.fix).join("、");
  const lines: string[] = [];
  lines.push("【🔁 往復文脈 — 最上位（「場面と返信方針」より上位・ハードゲートの次）】");
  lines.push(`この返信は「我々が直前に送った〈${staffJa}〉」に対して、お客様が「〈${custJa}〉${object ? `（対象: ${object}）` : ""}」を返してきた、その返しである。単発メッセージへの相槌ではない。`);
  lines.push(`- 我々の直前発言（${staffJa}／根拠: ${pair.staff.source}${pair.staff.evidence ? "=" + pair.staff.evidence.slice(0, 40) : ""}）: 「${pair.lastStaffText.replace(/\s+/g, " ").slice(0, 160)}」`);
  lines.push(`- お客様の返答（${custJa}${pair.customer.secondary.length ? " ＋ " + pair.customer.secondary.map((k) => CUSTOMER_KIND_JA[k]).join("・") : ""}）: 「${customerMessage.split(MSG_SEP).join(" ／ ").replace(/\s+/g, " ").slice(0, 200)}」`);
  if (pair.rule) {
    lines.push(`- → この返信の役割: ${pair.rule.direction.replace(/\{object\}/g, object).replace(/\{fix\}/g, fix || "ご希望条件のお部屋を中心に")}`);
    lines.push("- 必須要素（それぞれ本文で1文以上・欠けたら不合格）:");
    pair.rule.mustInclude.forEach((m, i) => lines.push(`  ${["①", "②", "③", "④", "⑤"][i] ?? i + 1} ${m.label}`));
    lines.push(`- 禁止: ${pair.rule.mustNot.join(" / ")}`);
    lines.push(`- 型（成約実例。文体・テンポ・構成を踏襲し、固有名詞・エリア・物件名は今回の会話の事実に置換。顧客名は「${customerName || "〇〇"}さん」）:`);
    lines.push(`「${pair.rule.example}」`);
  } else {
    lines.push("- → この返信の役割: 直前発言の流れを引き継ぎ、お客様の返答の中身に直接答えてから次の行動を宣言する");
  }
  lines.push("- 構成規則: お客様の返答が複数行・複数通でも【1つの流れ】として扱う。行ごとに「はい😊！！」「かしこまりました！！」と個別に相槌を打つ分割返答は禁止。開口語は1つ、本文は「受け止め1文→回答/代替1文→行動宣言1文→締め1文」、最後は「かしこまりました！！」で終えず行動宣言またはサポート継続宣言で終える。");
  return lines.join("\n") + "\n\n";
}
