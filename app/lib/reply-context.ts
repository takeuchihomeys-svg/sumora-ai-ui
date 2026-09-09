// app/lib/reply-context.ts
// 2026-09-09 Fable5: 往復文脈（直前スタッフ発話 × 顧客返答）と顧客メッセージの「実質」を単一 verdict で判定する pure module。
// 生成（generate-reply/route.ts）・検査（final-check.ts）・few-shot（line-reply-prompts.ts）・tpo_debug の四者が
// このファイルの関数と定数だけを参照する（四者同名）。
// 原則: 表層特徴（文字数・感謝語・?）ではなく「定型を剥がした残余」「直前スタッフ発話への応答関係」「fresh brain の抽出結果」の
// 3証拠で判定する。route.ts で1回だけ計算し、TPOゲート／effectiveReplyDirection／tpoNoteForLLM／dynamicBlock／
// final-check（finalCheckCtx / detCtx / postDetCtx）／tpo_debug が同一オブジェクトを参照する（見積 verdict・confirmCtx と同型）。
// 循環 import 禁止: このファイルは他の app/lib/* を runtime import しない（action-ledger は type-only）。
// 2026-09-09 Fable5 行動台帳: action-ledger.ts → reply-context.ts の一方向 runtime 依存。ここは `import type` のみ（TDZ 回避）
import type { ActionLedger } from "./action-ledger";

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
  ["condition", /家賃|予算|万円|エリア|駅|線|徒歩|間取り|[1-4１-４](?:LDK|DK|K|R)|ワンルーム|築|向き|設備|オートロック|バストイレ|独立洗面|管理費|共益費|駐車場|ペット|楽器|二人|2人|同棲|ルームシェア|[一-龯ァ-ヶ]{1,6}(?:区|市|町)|市内|市外|区内|付近|周辺|以内|以上|でも大丈夫|このままで|(?:は|が)?NG(?:で|です)/],
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
  | "viewing_invite" | "property_send" | "pickup_declared" | "estimate_send" | "question_to_customer"
  | "confirmation_promise" | "condition_ask" | "check_result" | "apply_push" | "other";
export type StaffTurn = { kind: StaffTurnKind; source: "ledger" | "aix_log" | "aix_history" | "regex" | "none"; evidence: string };
export type AixRow = { aix_type: string | null; check_pattern?: string | null; created_at: string | null };

const AIX_TO_STAFF: Record<string, StaffTurnKind> = {
  viewing_invite: "viewing_invite", meeting_place: "viewing_invite",
  property_send: "property_send", property_recommendation: "property_send",
  estimate_sheet: "estimate_send", property_check_result: "check_result",
  application_push: "apply_push", condition_hearing: "condition_ask", acknowledge_check: "confirmation_promise",
};
// ── 共有正規表現（2026-09-09 Fable5 行動台帳: action-ledger.ts が import する。生成・検査・台帳が同じ定数を参照＝四者同名）──
export const STAFF_ESTIMATE_RE = /御見積書|お見積書|お見積り|見積書|初期費用.{0,12}[0-9０-９,，]+円/;
export const STAFF_ESTIMATE_WORD_RE = /(?:御|お)?見積(?:書|り|もり)/;
export const STAFF_ESTIMATE_DECL_RE = /(?:御|お)?見積(?:書|り|もり)[^\n。]{0,40}?(?:作成|お送り|お出し)[^\n。]{0,16}(?:させて(?:頂|いただ)きます|いたします|致します|します)|(?:御|お)?見積(?:書|り|もり)[^\n。]{0,12}(?:出来|でき)次第/;
export const STAFF_VIEWING_INVITE_RE = /(?:ご内覧|内覧|内見|ご案内).{0,25}(?:如何|いかが|ご都合)|ご都合(?:の)?よろしいお日にち|ご案内可能です|[0-9０-９]{1,2}[:：時][0-9０-９]{0,2}.{0,12}(?:ご案内|案内可能)/;
export const STAFF_APPLY_PUSH_RE = /お申込み?(?:し|で)お部屋(?:を)?(?:抑え|押さえ)|お申込み?(?:頂け|いただけ)ます/;
export const STAFF_QUESTION_RE = /(?:でしょうか|ますか|ですか|ございますか|御座いますか|お聞かせ(?:ください|頂け|いただけ)|教えて(?:頂け|いただけ|ください))[！!？?😊😌]*$/;
export const STAFF_CONDITION_ASK_RE = /お部屋お探し中|ご希望(?:の)?条件|①【ご入居の時期】|ご希望のエリア|条件(?:を)?お聞かせ/;
export const STAFF_CONFIRM_PROMISE_RE = /(?:確認|お調べ)(?:させて(?:頂|いただ)き|いたし|致し|し)[^\n。！!]{0,25}(?:ご連絡|お送り|お伝え)|(?:確認|撮影)(?:出来|でき)次第/;
export const STAFF_CONFIRM_DECL_RE = /(?:確認|お調べ|問い合わせ)(?:させて(?:頂|いただ)き|いたし|致し|し)[^\n。！!]{0,25}(?:ご連絡|お送り|お伝え)|(?:確認|撮影)(?:出来|でき)次第/;
export const STAFF_CONFIRM_REPORT_RE = /確認(?:しました|いたしました|致しました)(?:ところ|所)|とのこと(?:で|です|でした)|募集(?:中|終了|ございません|御座いません|ありません)(?:でした|です|とのこと)/;
export const STAFF_NON_PROPERTY_RE = /待ち合わせ|集合場所|地図|申込書|申込み?時フォーマット|フォーマット|必要書類|身分証/;
/** 宣言（未来形）: ピックアップ…します／お送りさせて頂きます／出来次第。※ 実行の証拠にしない（「お部屋探し全力でサポート」の締め文は宣言に数えない） */
export const STAFF_PICKUP_DECL_RE = /(?:ピックアップ|お探し|お部屋探し(?!全力))[^\n。]{0,40}?(?:させて(?:頂|いただ)きます|いたします|致します|します)|(?:ピックアップ|お探し)[^\n。]{0,12}(?:出来|でき)次第/;
/** 実行（過去形・成果物）。旧 STAFF_PROPERTY_SEND_RE から裸の「号室」「万円」を除外（「9万以内」「見積本文の号室」を送付と誤判定しない） */
export const STAFF_PROPERTIES_DONE_RE = /🌟|ご査収ください|お送り(?:させて(?:頂|いただ)き|いたし|致し|し)ました|送らせて(?:頂|いただ)きました|ピックアップ(?:させて(?:頂|いただ)き|いたし|致し|し)ました|見つかりませんでした|少ない状況でした/;
/** 未送付なのに「再度／改めて／追加で／別の物件」（検査 DONE_PRESUPPOSED_WITHOUT_EVIDENCE と同名） */
export const REDO_CLAIM_RE = /(?:再度|改めて|もう一度|追加で|(?:別|他)の(?:物件|お部屋)|新たな(?:物件|お部屋))[^\n。]{0,24}(?:ピックアップ|お探し|お送り|ご提案|ご紹介|お届け)/;
/** 裸の「号室」「万円」（台帳が送付実績を持つ時／台帳なし の時だけ送付扱い） */
const STAFF_BARE_PROPERTY_RE = /[0-9０-９]{2,4}号室|[0-9０-９.．]+万円/;
/** action-ledger の LedgerKind → StaffTurnKind（action-ledger 側 LEDGER_TO_STAFF と同値。type-only 依存を守るため文字列キーで持つ） */
const LEDGER_KIND_TO_STAFF: Record<string, StaffTurnKind> = {
  pickup_declared: "pickup_declared", properties_sent: "property_send", estimate_declared: "estimate_send", estimate_sent: "estimate_send",
  viewing_invited: "viewing_invite", meeting_place_sent: "viewing_invite", question_asked: "question_to_customer",
  confirmation_promised: "confirmation_promise", confirmation_reported: "check_result", condition_asked: "condition_ask", application_guided: "apply_push",
};

export function classifyLastStaffTurn(
  lastStaffText: string | null | undefined,
  opts: { recentAixRows?: AixRow[]; lastStaffAt?: string | null; lastAixHistory?: string | null; windowMs?: number; ledger?: ActionLedger | null } = {},
): StaffTurn {
  const text = (lastStaffText ?? "").trim();
  const windowMs = opts.windowMs ?? 3 * 60 * 1000;
  // ⓪ 行動台帳（一次証拠を統合済み）: 直前スタッフ発言 ±3分に対応するエントリ
  const le = opts.ledger?.facts.lastStaffEntry ?? null;
  if (le) {
    const k = LEDGER_KIND_TO_STAFF[le.kind];
    if (k) return { kind: k, source: "ledger", evidence: `${le.kind}/${le.status}/${le.source}=${le.evidence.slice(0, 40)}` };
  }
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
  // ② 本文の決定論。優先: 見積 > 内覧打診 > 申込打診 > 条件ヒアリング > 質問（末尾行） > 確認約束 > 【宣言】 > 【実行】
  //   （条件ヒアリングは「ご希望条件お聞かせください」の疑問形を含むため質問より先に判定する）
  if (text) {
    const lastLine = text.split("\n").filter(Boolean).slice(-1)[0] ?? "";
    if (STAFF_ESTIMATE_RE.test(text) && /となります|ご査収|お送り|作成/.test(text)) return { kind: "estimate_send", source: "regex", evidence: text.match(STAFF_ESTIMATE_RE)![0] };
    if (STAFF_VIEWING_INVITE_RE.test(text)) return { kind: "viewing_invite", source: "regex", evidence: text.match(STAFF_VIEWING_INVITE_RE)![0] };
    if (STAFF_APPLY_PUSH_RE.test(text)) return { kind: "apply_push", source: "regex", evidence: text.match(STAFF_APPLY_PUSH_RE)![0] };
    if (STAFF_CONDITION_ASK_RE.test(text)) return { kind: "condition_ask", source: "regex", evidence: text.match(STAFF_CONDITION_ASK_RE)![0] };
    if (STAFF_QUESTION_RE.test(lastLine)) return { kind: "question_to_customer", source: "regex", evidence: lastLine.slice(-30) };
    if (STAFF_CONFIRM_PROMISE_RE.test(text) && !STAFF_PICKUP_DECL_RE.test(text)) return { kind: "confirmation_promise", source: "regex", evidence: text.match(STAFF_CONFIRM_PROMISE_RE)![0] };
    // 2026-09-09 Fable5 みく事例: 宣言（未来形）を実行より先に判定。みく 10:40「ピックアップしてお送りさせて頂きます」はここ。
    //   DELIVERABLE_RE（🌟・号室・ました）があれば宣言ではなく成果物送付
    if (STAFF_PICKUP_DECL_RE.test(text) && !DELIVERABLE_RE.test(text)) return { kind: "pickup_declared", source: "regex", evidence: text.match(STAFF_PICKUP_DECL_RE)![0].slice(0, 40) };
    if (STAFF_PROPERTIES_DONE_RE.test(text)) return { kind: "property_send", source: "regex", evidence: text.match(STAFF_PROPERTIES_DONE_RE)![0] };
    // 裸の「号室」「万円」は台帳が送付実績を持つ時のみ送付扱い（台帳なし＝従来互換）
    if (STAFF_BARE_PROPERTY_RE.test(text) && (!opts.ledger || opts.ledger.facts.propertiesSentCount > 0)) return { kind: "property_send", source: "regex", evidence: text.match(STAFF_BARE_PROPERTY_RE)![0] };
  }
  // ③ 本文が無い（画像のみ等）→ brain の last_aix_history「最新:xxx」。台帳が「送付0件」の時は property_send を採らない（前日 AIX の誤帰属防止）
  const m = /最新:([a-z_]+)/.exec(opts.lastAixHistory ?? "");
  if (m && AIX_TO_STAFF[m[1]] && !(AIX_TO_STAFF[m[1]] === "property_send" && opts.ledger && opts.ledger.facts.propertiesSentCount === 0)) return { kind: AIX_TO_STAFF[m[1]], source: "aix_history", evidence: m[0] };
  // ④ 本文が無くても台帳が未履行約束を持つ
  if (opts.ledger?.facts.pickupPromisedUnfulfilled) return { kind: "pickup_declared", source: "ledger", evidence: "ledger:pickupPromisedUnfulfilled" };
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
/** 条件の宣言形（間取り・家賃上限・エリア＋探す/お願い）。語の出現（「駅で待ち合わせ」の「駅」）では発火しない */
// 2026-09-09 行動台帳（みく 11:45）: エリア限定「大阪の市内付近でお願いします」・NG 追加「京都・尼崎はNGで」も条件の宣言形
const CUST_CONDITION_STATEMENT_RE = /[1-4１-４](?:LDK|DK|K|R)|ワンルーム|[0-9０-９.．]+万(?:円)?(?:以内|以下|まで|台|くらい|位|前後|程度)|(?:家賃|予算|間取り|条件|エリア|築|徒歩)[^\n]{0,20}(?:で|は|を|に)[^\n]{0,12}(?:探|お願い|希望|変|広げ|絞|追加|変更|お伝え)|(?:周辺(?:全域)?|市内|市外|区内|付近|沿線)(?:で|から|に)[^\n]{0,20}(?:探|お願い|希望|絞|限定)|(?:は|が)NG(?:で|です)|(?:は|が)?(?:なし|無し|除外|以外)で(?:お願い|希望)/;

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
  // ②' 2026-09-09 Fable5: 条件の宣言形（「2LDKで探してまして」「阿波座・本町で2LDK 17万以内でお願いします」）は flag/brain が無い経路
  //    （check-reply / final-check 再計算）でも condition_change に寄せる。断り・質問・懸念・前向き・日程・決定が同居する時は付けない
  if (!found.has("condition_change") && !found.has("decline") && !found.has("question") && !found.has("concern") && !found.has("positive")
    && sub.kinds.includes("condition") && !sub.kinds.includes("schedule") && !sub.kinds.includes("decision") && CUST_CONDITION_STATEMENT_RE.test(raw)) {
    put("condition_change", "regex:condition_statement");
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
/** 締めの種別（2026-09-09 Fable5 みく事例）。resolveCloser / CLOSER_TEXT / PAIR_MATRIX.closer / final-check runCloserChecks / stance_draft が同名 */
export type CloserKind = "commit_until_found" | "receive_check" | "open_door" | "wait_softly" | "none";
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
  /** セル既定の締め。resolveCloser で 断り＞成果物＞日程 が優先される。省略=resolveCloser の既定 */
  closer?: CloserKind;
  /** closer 直後に「何卒よろしくお願い致します！！」を付けるか（省略=false） */
  nanisotsu?: boolean;
  /** このセルで先回りヘッジ（探索後の結果報告）を許すか。省略=false（resolveHedgeAllowance の verdict が最終決定） */
  hedgeAllowed?: boolean;
  /** 2026-09-09 行動台帳: 送付実績の有無で example を出し分ける（buildTurnPairNote が ledger.facts.propertiesSentCount で選ぶ） */
  exampleBySent?: { none: string; sent: string };
};

const DECL_TAIL = "(?:させて(?:頂|いただ)き|いたし|致し)ます";

export const PAIR_MATRIX: PairRule[] = [
  // ── 2026-09-09 Fable5 みく事例: 条件ヒアリング→条件フォーム／条件回答。旧実装は rule=null で汎用指示に落ち、
  //    latent_intent「代替案で応える」＋ conditionDirection「全力でサポート禁止」の穴を LLM が先回りヘッジで埋めていた ──
  { id: "CA_CONDITION", staff: "condition_ask", customer: "condition_change", precedence: "override_wait",
    tpoLabel: "条件提示（条件ヒアリングへの条件フォーム／条件回答）",
    direction: "我々の条件ヒアリングに対しお客様が条件（フォーム／箇条書き）を返した。①「かしこまりました😊！！」単独行 ②お客様の言葉のままエリア・家賃・間取り・付帯条件（築年・設備・広さ・徒歩）を復唱した「〇〇さんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！」宣言1文（数字・条件を一文字も変えない） ③締め「〇〇さんがご満足頂くお部屋が見つかるまでお部屋探し全力でサポートさせて頂きます😌！！」 ④「何卒よろしくお願い致します！！」。100〜180字",
    mustInclude: [
      { label: "条件を復唱したピックアップ宣言（エリア／家賃／間取りのいずれかを含む）", detect: new RegExp(`(?:周辺|全域|沿線|以内|万|LDK|DK|[0-9０-９]K|ワンルーム)[^\\n]{0,80}ピックアップ[^\\n。！!]{0,24}${DECL_TAIL}`) },
      { label: "見つかるまで伴走する締め", detect: /全力で(?:お部屋探し)?サポート|ご満足(?:頂|いただ)(?:く|ける)お部屋が(?:見つかる|みつかる)まで/ },
    ],
    mustNot: ["未着手条件への「難しい可能性」「少ない状況」等の実現可能性の予測", "「条件を1つ変えた場合のご提案」「優先順位をお聞かせ」等の条件緩和の先回り提案", "お客様の自己ヘッジ（難しいと思う・あれば教えて）の復唱・同意", "条件を単体で確認する文", "見積書・募集状況確認・審査の先回り", "「新着あれば」等の受け身文", "物件名・号室の創作"],
    example: "かしこまりました😊！！\n\n梅田まで1本で行ける沿線周辺全域から9万以内・1LDK・カウンターキッチン希望・築10年以内でみくさんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！\n\nみくさんがご満足頂くお部屋が見つかるまでお部屋探し全力でサポートさせて頂きます😌！！\n何卒よろしくお願い致します！！",
    length: "100〜180字", closer: "commit_until_found", nanisotsu: true },

  // ── 2026-09-09 Fable5 みく事例（行動台帳）: 宣言のみ（未送付）段階での条件絞り込み／NG追加。
  //    旧実装は staff=other → ANY_CONDITION_CHANGE の「再ピックアップ宣言」に落ち「再度」が出た ──
  { id: "PD_CONDITION_CHANGE", staff: "pickup_declared", customer: "condition_change", precedence: "override_wait",
    tpoLabel: "条件絞り込み（ピックアップ約束中・まだ1件も送っていない）",
    direction: "我々は直前に「〇〇の条件でピックアップしてお送りします」と宣言しただけで、物件はまだ1件も送っていない（台帳: {ledger}）。お客様がその宣言に条件の追加/絞り込み（エリア限定・NG等）を重ねた。①「かしこまりました😊！！」単独行 ②追加条件を「〇〇に絞らせて頂き」の肯定形で受け（NGは「京都・尼崎を除き」ではなく「大阪市内に絞らせて頂き」に変換。NG名は復唱しない）、直前宣言の条件を数字・語を一字も変えずに復唱した未来形のピックアップ宣言1文 ③「〇〇さんにオススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！」の履行約束1文 ④締め。初回の宣言をまだ実行していないので「再度／改めて／新たに／追加で／別の」は一切使わない。100〜180字",
    mustInclude: [
      { label: "絞り込みを肯定形で反映した条件復唱のピックアップ宣言（未来形）", detect: new RegExp(`(?:に絞(?:らせて|って)|エリアで|エリアから|周辺(?:全域)?から|市内|中心に)[^\\n]{0,80}ピックアップ[^\\n。！!]{0,24}${DECL_TAIL}`) },
      { label: "前回条件の復唱（エリア／家賃／間取りのいずれか）", detect: /(?:周辺|全域|沿線|以内|万|LDK|DK|[0-9０-９]K|ワンルーム|築|徒歩)/ },
      { label: "履行約束「ピックアップ出来次第お送り」", detect: /(?:ピックアップ|見つかり|見つけ)(?:出来|でき)?次第[^\n]{0,12}お送り/ },
    ],
    mustNot: ["実行済みを含意する語（再度・改めて・もう一度・新たに・追加で・別の・こちらの・先ほどお送りした）— 送付0件", "送付済み物件への言及・「〇〇も選択肢に」", "「〜をお届けします」等の抽象締め（未来形宣言＋出来次第お送りで統一）", "NG語の羅列（京都・尼崎はNGで）の復唱", "実現可能性の予測（難しい・少ない・可能性）", "条件緩和・代替案の先回り提案", "条件の聞き返し", "直前宣言の条件の数字・語の改変", "全力サポート締めの二重化（直前発言で既に言っている）"],
    example: "かしこまりました😊！！\n\n大阪市内に絞らせて頂き、梅田まで1本で行ける沿線・9万以内・1LDK・カウンターキッチン希望・築10年以内でみくさんにオススメできるお部屋をピックアップさせて頂きます！！\n\nみくさんにオススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！何卒よろしくお願い致します！！",
    length: "100〜180字", closer: "commit_until_found", nanisotsu: true },
  // 直前発言の CA_CONDITION は必ず全力サポートを含むため resolveCloser の priorCommit で none＋何卒に落ちる＝みく 11:48 実送信と一致

  { id: "PD_ACK", staff: "pickup_declared", customer: "ack_only", precedence: "after_wait",
    tpoLabel: "短い了承（ピックアップ約束への了承）",
    direction: "我々のピックアップ宣言にお客様が「よろしくお願いします」等の了承のみを返した。開口語「はい😊！！」→「〇〇さんにオススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！」の履行約束復唱1文のみ。台帳: {ledger}。実行済み語禁止。40〜80字",
    mustInclude: [{ label: "履行約束の復唱", detect: /(?:ピックアップ|見つかり)(?:出来|でき)?次第[^\n]{0,12}お送り/ }],
    mustNot: ["実行済み含意語（再度・改めて・追加で）", "条件の再列挙", "全力サポート・何卒の再掲", "新規の業務語彙（撮影・ご査収・内覧日程）"],
    example: "はい😊！！\nみくさんにオススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！",
    length: "40〜80字", closer: "none", nanisotsu: false },

  { id: "PD_QUESTION", staff: "pickup_declared", customer: "question", precedence: "override_wait",
    tpoLabel: "質問（ピックアップ約束中）",
    direction: "ピックアップ約束中（未送付・台帳: {ledger}）にお客様が質問した。①質問に履歴の事実で直接回答1文（分からなければ「確認しご連絡」対象付き）②「〇〇さんにオススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！」の履行約束1文。実行済み語禁止。80〜160字",
    mustInclude: [{ label: "質問への直接回答", detect: /となります|です|ございます|可能|傾向/ }, { label: "履行約束の復唱", detect: /(?:ピックアップ|見つかり)(?:出来|でき)?次第[^\n]{0,12}お送り/ }],
    mustNot: ["実行済み含意語", "「こちらの物件」等の指示語", "条件の聞き返し"],
    example: "トイレと洗面所別のお部屋につきましては、設備分家賃が高くなる傾向がございます！！(3,000円～5,000円程）\n\nトイレ・洗面所別のご条件も含めてあやさんにオススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！何卒よろしくお願い致します！！",
    length: "80〜160字", closer: "none", nanisotsu: true },

  { id: "ANY_CONDITION_CHANGE", staff: "*", customer: "condition_change", precedence: "override_wait",
    tpoLabel: "条件変更（エリア・家賃・間取り・設備の追加/変更）",
    direction: "お客様が条件の追加/変更を伝えた（台帳: {ledger}）。①「かしこまりました！！」②新条件を復唱した{redo}ピックアップ宣言1文 ③伴走締め。聞き返し禁止。台帳が物件送付0件なら実行済み含意語（再度・改めて・追加で・別の）を使わず「ピックアップ出来次第お送りさせて頂きます」を添える。90〜160字",
    mustInclude: [
      { label: "新条件を復唱した{redo}ピックアップ宣言", detect: new RegExp(`(?:周辺|全域|沿線|以内|万|LDK|DK|[0-9０-９]K|ワンルーム|造|向き|階|徒歩|築)[^\\n]{0,80}ピックアップ[^\\n。！!]{0,24}${DECL_TAIL}`) },
    ],
    mustNot: ["実現可能性の予測（難しい・少ない・可能性）", "条件緩和・代替案の先回り提案", "「少ない状況でしたので広げました」の言い訳（探していない）", "聞き返し", "再送宣言", "台帳に送付実績が無いのに「再度」「改めて」「新たに」「追加で」「別の」を付ける"],
    example: "かしこまりました！！\n2LDKのご条件で、枚方・高槻・吹田・守口・門真・鶴見区周辺全域から瑞希さんにオススメ出来るお部屋新たにピックアップしてお送りさせて頂きます😌！！\n瑞希さんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！",
    exampleBySent: {
      none: "かしこまりました😊！！\n〇〇に絞らせて頂き、〇〇のご条件で〇〇さんにオススメできるお部屋をピックアップさせて頂きます！！\n〇〇さんにオススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！",
      sent: "かしこまりました！！\n2LDKのご条件で、枚方・高槻・吹田・守口・門真・鶴見区周辺全域から瑞希さんにオススメ出来るお部屋新たにピックアップしてお送りさせて頂きます😌！！\n瑞希さんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！",
    },
    length: "90〜160字", closer: "commit_until_found", nanisotsu: false },

  { id: "VI_CONCERN", staff: "viewing_invite", customer: "concern", precedence: "override_wait",
    tpoLabel: "提案後の懸念（内覧打診への懸念返答）",
    direction: "我々の内覧打診に対し顧客が物件の懸念（{object}）を返した。①「〇〇さんお世話になっております！！」または「ご要望お聞かせ頂きありがとうございます😊！！」型の受け止め1文（共感語禁止）②履歴にある事実で答えられる時のみ事実回答1文（無ければ省略）③懸念を条件語に変換した再ピックアップ宣言1文（{fix}）④内覧は「お気に召されましたらいつでも」の開放のみで押さない⑤締め。120〜200字",
    mustInclude: [
      { label: "懸念対象の復唱（例: お子様との階段の上り下り）", detect: /階段|[0-9０-９]+階|1階|１階|エレベーター|お子様|新生児|お風呂|広め|築|家賃|初期費用|審査/ },
      { label: "懸念→条件変換の再ピックアップ宣言", detect: new RegExp(`(?:中心に|条件に合|優先して).{0,40}(?:ピックアップ|お調べ|お探し|探さ|お送り).{0,30}${DECL_TAIL}`) },
    ],
    mustNot: ["「お気持ち、よくわかります」等の共感フレーズ", "「かしこまりました！！」で終える", "「はい😊！！」開始", "内覧日程の再提案・候補日時", "申込誘導・希少性煽り", "「2階でも大丈夫」等の根拠なし安心づけ", "懸念を質問で返す"],
    example: "あみさんお世話になっております！！\nご要望お聞かせ頂きありがとうございます😊！！\n新生児のお子様との階段の上り下りはご負担になりますので、1階またはエレベーター付きのお部屋を中心にあみさんにオススメできるお部屋再度ピックアップしお送りさせて頂きます！！\nこちらのお部屋も含めお気に召されましたらいつでもご内覧頂けますので、あみさんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます😌！！",
    length: "120〜200字", closer: "commit_until_found", nanisotsu: false },

  { id: "VI_POSITIVE", staff: "viewing_invite", customer: "positive", precedence: "after_wait",
    tpoLabel: "内覧調整（内覧打診への前向き返答）",
    direction: "内覧受付。候補日時は AIX 内覧日調整で送るため本文は受付＋「ご都合よろしいお日にち御座いますでしょうか」の確認のみ。既に候補日を出している場合は日時確定の復唱のみ。40〜90字",
    mustInclude: [{ label: "受付語", detect: /かしこまりました/ }, { label: "日程確認 or 確定復唱", detect: /ご都合|お日にち|[0-9０-９]{1,2}[/／月][0-9０-９]{1,2}|[0-9０-９]{1,2}時/ }],
    mustNot: ["申込誘導", "別物件提案", "募集未確認物件への内覧確約"],
    example: "かしこまりました！！\nお部屋ご案内させていただきます！！\nタクミさんご都合よろしいお日にち御座いますでしょうか😊！！",
    length: "40〜90字", closer: "none", nanisotsu: false },

  { id: "VI_THINKING", staff: "viewing_invite", customer: "thinking", precedence: "after_wait",
    tpoLabel: "検討中フォロー（内覧打診後）",
    direction: "急かさない受け止め＋内覧の扉を開けたまま待つ。「はい😊！！」→「ごゆっくりご検討頂けますと幸いです！！」→「ご内覧出来ますので、気になる点出てきましたらいつでもお気軽にご連絡ください😌！！」。70〜120字",
    mustInclude: [{ label: "急かさない受け止め", detect: /ごゆっくり/ }, { label: "内覧の扉を開ける1文", detect: /内覧|いつでも/ }],
    mustNot: ["希少性煽り", "申込誘導", "物件追加提案", "「かしこまりました」開口語"],
    example: "はい😊！！\nごゆっくりご検討頂けますと幸いです！！\nご内覧出来ますので、あいさん気になる点出てきましたらいつでもお気軽にご連絡ください😌！！",
    length: "70〜120字", closer: "open_door", nanisotsu: false },

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
    length: "120〜220字", closer: "open_door", nanisotsu: false },

  { id: "ES_THINKING", staff: "estimate_send", customer: "thinking", precedence: "after_wait",
    tpoLabel: "検討中フォロー（見積送付後）",
    direction: "急かさない受け止め＋次工程（内覧／申込）の開放1文。「はい😊！！ごゆっくりご確認頂けますと幸いです！！」→「お部屋お気に召されましたら実際にご案内させて頂きますのでいつでもお気軽にご連絡ください😌！！」。70〜130字",
    mustInclude: [{ label: "急かさない受け止め", detect: /ごゆっくり/ }, { label: "次工程の開放（内覧／申込／不明点）", detect: /お気に召され|ご不明|ご不安|いつでも/ }],
    mustNot: ["申込催促・希少性煽り", "別物件提案", "初期費用割引の再掲", "「かしこまりました」開口語"],
    example: "愛乃さん、お世話になっております！！\nはい😊！！ごゆっくりご確認頂けますと幸いです！！\nお部屋お気に召されましたら、実際にお部屋ご案内させて頂きますのでいつでもお気軽にご連絡ください😌！！",
    length: "70〜130字", closer: "wait_softly", nanisotsu: false },

  { id: "ES_CONCERN", staff: "estimate_send", customer: "concern", precedence: "override_wait",
    tpoLabel: "提案後の懸念（見積への懸念）",
    direction: "見積への懸念（{object}）に事実で理由を1文説明（礼金がかかる等・履歴にある事実のみ）→初期費用を抑えられる別物件を探す宣言。共感語不要。90〜150字",
    mustInclude: [
      { label: "高い理由の事実説明", detect: /礼金|敷金|仲介|保証|(?:となります|かかります|高くなって)/ },
      { label: "初期費用を抑えた別物件を探す宣言", detect: new RegExp("(?:初期費用|費用|家賃).{0,15}(?:抑え|安い|抑えられ).{0,30}(?:探|ピックアップ|お調べ)") },
    ],
    mustNot: ["値引き確約", "共感語のみ", "申込誘導"],
    example: "はい！！\nこちらの2物件は、礼金がかかりますので初期費用高くなってしまいます。\n別物件で初期費用抑えられるオススメ出来るお部屋探させて頂きます！！\n何卒よろしくお願い致します😌！！",
    length: "90〜150字", closer: "commit_until_found", nanisotsu: true },

  { id: "ES_POSITIVE", staff: "estimate_send", customer: "positive", precedence: "after_wait",
    tpoLabel: "申込打診（見積送付後の前向き返答）",
    direction: "申込でお部屋を抑える宣言＋（履歴にある事実のみ）保証会社審査通過までキャンセル料なし等の事実1文。煽り禁止。80〜160字",
    mustInclude: [{ label: "申込でお部屋を抑える宣言", detect: /お申込.{0,15}(?:抑え|押さえ)/ }],
    mustNot: ["「埋まってしまいます」等の煽り", "書類リスト生成", "未確認の退去日・入居可能日の断言"],
    example: "竹田さんお世話になっております！！\nはい！お申込しお部屋を抑える事可能です！！保証会社の審査が通過するまではキャンセル料一切かかりません！！\n竹田さん問題なければお申込しお部屋抑えさせて頂きます😌！！",
    length: "80〜160字", closer: "none", nanisotsu: false },

  { id: "PS_CONCERN", staff: "property_send", customer: "concern", precedence: "override_wait",
    tpoLabel: "提案後の懸念（物件送付後）",
    direction: "送付物件への懸念（{object}）を条件に変換し再ピックアップ宣言。「ご要望お聞かせ頂きありがとうございます😊！！」→「{fix}〇〇さんにオススメできるお部屋お調べさせて頂きます！！」→サポート継続。共感文だけは不合格。90〜150字",
    mustInclude: [
      { label: "懸念→条件語の復唱（広め／1階／初期費用抑えめ等）", detect: /広め|広い|1階|１階|エレベーター|抑え|近い|新し|静か|明る|築浅|保証会社/ },
      { label: "再ピックアップ宣言", detect: new RegExp(`(?:中心に|条件に合|優先して).{0,30}(?:お調べ|ピックアップ|お探し|探さ).{0,30}${DECL_TAIL}`) },
    ],
    mustNot: ["「お気持ちよくわかります」等の共感語", "送付物件の擁護・説得", "内覧誘導・申込誘導", "「かしこまりました！！」単独終了", "「はい😊！！」開始"],
    example: "あみさんお世話になっております！！\nご要望お聞かせ頂きありがとうございます😊！！\nお風呂広めのお部屋を中心にあみさんにオススメできるお部屋お調べさせて頂きます！！\nあみさんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！",
    length: "90〜150字", closer: "commit_until_found", nanisotsu: false },

  { id: "PS_THINKING", staff: "property_send", customer: "thinking", precedence: "after_wait",
    tpoLabel: "検討中フォロー（物件送付後）",
    direction: "急かさない受け止め＋随時ピックアップ宣言 or 内覧の扉を開ける1文。「はい😊！！」→「ごゆっくりご検討（ご相談）頂けますと幸いです！！」→「ご条件に合うお部屋出てきましたら随時ピックアップしてお送りさせて頂きます」or「気になる点出てきましたらいつでもお気軽にご連絡ください」。70〜130字",
    mustInclude: [{ label: "急かさない受け止め", detect: /ごゆっくり|ご相談|ご検討/ }, { label: "随時ピックアップ宣言 or 扉を開ける1文", detect: /随時|出てきましたら|出次第|いつでも|内覧/ }],
    mustNot: ["申込誘導", "希少性煽り（人気のため早めに等）", "「かしこまりました！！」単独終了", "検討依頼の繰り返し（ご検討の程〜）"],
    example: "お世話になっております！！\nかしこまりました！！ごゆっくりご相談頂けますと幸いです😊！！\nまたrさんにオススメできるお部屋出てきましたら随時ピックアップしてお送りさせて頂きます！！",
    length: "70〜130字", closer: "wait_softly", nanisotsu: false },

  { id: "PS_WILL_SEND", staff: "property_send", customer: "will_send_later", precedence: "override_wait",
    tpoLabel: "提案後の検討・持込予告（物件送付後）",
    direction: "急かさない受け止め＋顧客が送る／相談する行動を先取りして受ける宣言（条件に合う部屋が出たら随時ピックアップ／送って頂いた物件は募集状況確認）。90〜150字",
    mustInclude: [
      { label: "急かさない受け止め", detect: /ごゆっくり|ご相談|ご検討/ },
      { label: "先取りの行動宣言（随時ピックアップ or 募集状況確認）", detect: /(?:随時|出次第|出てきましたら|お送り頂き次第|お送り頂けましたら|届き次第).{0,30}(?:ピックアップ|お送り|確認)/ },
    ],
    mustNot: ["申込誘導", "希少性煽り", "「かしこまりました！！」単独終了"],
    example: "お世話になっております！！\nかしこまりました！！ごゆっくりご相談頂けますと幸いです😊！！\nまたrさんにオススメできるお部屋出てきましたら随時ピックアップしてお送りさせて頂きますので、気になる点出てきましたらいつでもお気軽にご連絡ください！！",
    length: "90〜150字", closer: "open_door", nanisotsu: false },

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
    length: "100〜160字", closer: "none", nanisotsu: false },

  { id: "PS_CONDITION_CHANGE", staff: "property_send", customer: "condition_change", precedence: "override_wait",
    tpoLabel: "条件変更（物件送付後）",
    direction: "我々は既に物件を送っている（台帳: {ledger}）。差分条件の復唱＋新条件で{redo}ピックアップ宣言（未来形・まだ探していない。送付済みなので「新たに」「改めて」「引き続き」「〇〇も含めて」が使える）＋送付済み物件（{sentNames}）は「並行して選択肢に残しつつ」の1文（台帳に物件名がある時のみ）＋伴走締め。実現可能性の予測・「少ない状況でしたので」の言い訳は禁止。110〜180字",
    mustInclude: [
      { label: "新条件の復唱", detect: /(?:区|駅|線|万円|万以内|万|以下|以内|階|広め|築|LDK|DK|[0-9０-９]K|ワンルーム|徒歩|周辺)/ },
      { label: "{redo}ピックアップ宣言（送付済み前提なので再度／新たに／別の候補 可）", detect: new RegExp(`ピックアップ.{0,20}${DECL_TAIL}`) },
    ],
    mustNot: ["条件の聞き返し", "送付済み物件の再送宣言", "実現可能性の予測（難しい・少ない・可能性）", "条件緩和・代替案の先回り提案", "「少ない状況でしたので広げました」の言い訳（探していない）"],
    example: "かしこまりました！！\n2LDKのご条件で、枚方・高槻・吹田・守口・門真・鶴見区周辺全域から瑞希さんにオススメ出来るお部屋新たにピックアップしてお送りさせて頂きます😌！！\n瑞希さんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！",
    length: "110〜180字", closer: "commit_until_found", nanisotsu: false },

  // 探索済み（aix_usage_logs に顧客最新以降の property_send 系がある／AIX物件送付文生成中）の時だけ resolveTurnPair が選ぶ結果報告セル
  { id: "PS_CONDITION_CHANGE_SEARCHED", staff: "property_send", customer: "condition_change", precedence: "override_wait",
    tpoLabel: "条件変更後の再ピックアップ結果報告（探索済み）",
    direction: "新条件で実際にピックアップした結果を送る。「〇〇のご条件ですと合うお部屋が少ない状況でしたので、△△まで広げてピックアップさせて頂きました」の過去形＋実行済み代替のみ可。締めはご査収",
    mustInclude: [{ label: "結果報告（過去形）", detect: /ピックアップ(?:させて(?:頂|いただ)き|いたし|致し)ました|募集(?:ございません|御座いません)でした/ }],
    mustNot: ["未来形の予測（〜可能性がございます）", "全力サポート・何卒の締め"],
    example: "慶次さんお待たせ致しました！！\n北区・福島区・西区周辺全域から探させていただいたのですが、以前お送りさせていただいたお部屋以外の新着物件募集ございませんでした。\nメロディーハイム九条203号室も好条件のお部屋となりますので並行して選択肢に残しつつ、新着物件が出次第ピックアップしてお送りさせていただきます！！",
    length: "100〜180字", closer: "receive_check", nanisotsu: false, hedgeAllowed: true },

  { id: "QC_ANSWER", staff: "question_to_customer", customer: "*", precedence: "after_wait",
    tpoLabel: "顧客回答の受領",
    direction: "我々の質問への回答を受領し、その回答を前提にした次工程（見積作成／内覧調整／ピックアップ）を宣言。回答内容への評価コメントは書かない。60〜120字",
    mustInclude: [
      { label: "受領語", detect: /かしこまりました|ありがとうございます/ },
      { label: "回答を前提にした次工程宣言", detect: new RegExp(`(?:御見積書|お見積書|内覧|ピックアップ|確認|ご案内).{0,30}${DECL_TAIL}`) },
    ],
    mustNot: ["回答内容への評価コメント", "同じ質問の再確認"],
    example: "かしこまりました！！\n初期費用も最大限割引させていただいたお見積書作成しお送りさせていただきます😊！！",
    length: "60〜120字", closer: "none", nanisotsu: false },

  { id: "CP_ACK", staff: "confirmation_promise", customer: "ack_only", precedence: "after_wait",
    tpoLabel: "短い了承（直前スタッフ約束への了承）",
    direction: "既存「短い了承」（promiseEchoNote）と同一。開口語「はい😊！！」→直前約束の復唱WE DO 1文→締め。40〜90字",
    mustInclude: [{ label: "直前約束の復唱WE DO", detect: /(?:確認出来次第|出来次第|次第).{0,20}(?:ご連絡|お送り)/ }],
    mustNot: ["約束に無い業務語彙（撮影・ご査収・内覧日程）"],
    example: "はい😊！！\n募集状況確認出来次第ご連絡させて頂きます！！",
    length: "40〜90字", closer: "none", nanisotsu: false },

  { id: "ANY_DECLINE", staff: "*", customer: "decline", precedence: "after_wait",
    tpoLabel: "ネガ文脈（顧客自身の断り）",
    direction: "既存 withdrawal direction をそのまま採用",
    mustInclude: [{ label: "扉を開ける1文", detect: /またお部屋探しの際|いつでも/ }],
    mustNot: ["引き留め提案", "謝罪"],
    example: "かしこまりました！！\nまたお部屋探しの際はいつでもお気軽にご連絡ください😊！！\nこの度はありがとうございました！！",
    length: "50〜110字", closer: "none", nanisotsu: false },

  { id: "ANY_QUESTION", staff: "*", customer: "question", precedence: "override_wait",
    tpoLabel: "質問回答",
    direction: "質問に事実で直接回答→次工程宣言（直前スタッフ種別が不明でも質問は必ず答える）。100〜160字",
    mustInclude: [{ label: "直接回答 or 確認宣言", detect: /(?:となります|ございます|可能です|問題ございません|かかります|(?:出来|でき)ます)|確認させて(?:頂|いただ)き/ }],
    mustNot: ["質問返し", "根拠なし断言"],
    example: "はい！かなり入ってくる可能性は低くなります！換気フィルターの定期的な清掃、防虫フィルターを設置行いますと虫の侵入を防ぐ事が出来ます！！\n内装の色味についてはブラウン基調となります！",
    length: "100〜160字", closer: "none", nanisotsu: false },

  { id: "ANY_CONCERN", staff: "*", customer: "concern", precedence: "override_wait",
    tpoLabel: "提案後の懸念",
    direction: "PS_CONCERN と同じ骨格（直前スタッフ種別 other/check_result でも懸念は必ず『事実回答＋条件変換した再ピックアップ』）。{fix}",
    mustInclude: [
      { label: "懸念対象の復唱", detect: /階|お風呂|家賃|初期費用|審査|駅|築|広|日当たり|駐車場|治安|お子様|新生児/ },
      { label: "再ピックアップ or 安心材料の事実", detect: new RegExp(`(?:ピックアップ|お調べ|お探し|探さ).{0,30}${DECL_TAIL}|多数ございます|可能です`) },
    ],
    mustNot: ["共感フレーズ", "「かしこまりました！！」単独終了", "「はい😊！！」開始"],
    example: "かしこまりました😊！！\n夜職・ブラックでもご入居できるお部屋は多数ございますので、審査に通りやすい保証会社中心にお部屋ピックアップさせて頂きます！！\nご不安な点も含めて全力でサポートさせて頂きますので、何卒よろしくお願い致します😌！！",
    length: "100〜160字", closer: "commit_until_found", nanisotsu: true },

  { id: "ANY_WILL_SEND", staff: "*", customer: "will_send_later", precedence: "override_wait",
    tpoLabel: "提案後の検討・持込予告",
    direction: "PS_WILL_SEND と同じ骨格。顧客が予告した行動を先取りして受ける宣言を必ず1文。90〜160字",
    mustInclude: [{ label: "先取りの行動宣言", detect: /(?:随時|出次第|出てきましたら|お送り頂き次第|お送り頂けましたら|届き次第).{0,30}(?:ピックアップ|お送り|確認|ご連絡)/ }],
    mustNot: ["申込誘導", "希少性煽り", "「かしこまりました！！」単独終了"],
    example: "お世話になっております！！\nかしこまりました！！ごゆっくりご相談頂けますと幸いです😊！！\nまた〇〇さんにオススメできるお部屋出てきましたら随時ピックアップしてお送りさせて頂きますので、気になる点出てきましたらいつでもお気軽にご連絡ください！！",
    length: "90〜160字", closer: "open_door", nanisotsu: false },
];

export const STAFF_KIND_JA: Record<StaffTurnKind, string> = {
  viewing_invite: "内覧打診", property_send: "物件送付", pickup_declared: "ピックアップ約束（宣言のみ・まだ送っていない）", estimate_send: "見積書送付", question_to_customer: "お客様への質問",
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
  /** 2026-09-09 行動台帳（route.ts で1回構築・生成/検査/締め/ヘッジが同一参照）。check-reply 旧経路は null */
  ledger: ActionLedger | null;
  /** {redo} 置換値: 送付実績あり→「再度」／なし→「」 */
  redo: string;
}

/** {redo}: 台帳に物件送付実績がある時だけ「再度」。生成 direction／検査 label／final-check suggestion が同じ関数 */
export function redoWord(ledger: ActionLedger | null | undefined): string { return ledger && ledger.facts.propertiesSentCount > 0 ? "再度" : ""; }

export function resolveTurnPair(
  staff: StaffTurn, customer: CustomerResponse, substance: SubstanceVerdict, lastStaffText: string,
  opts: { searched?: boolean; ledger?: ActionLedger | null } = {},
): PairContext {
  // 2026-09-09 Fable5: 同一セルに「未探索（宣言型）」と「探索済み（結果報告型・hedgeAllowed）」がある時は resolveHedgeAllowance の searched で選ぶ
  // 「探索済み」＝顧客最新発言より後の送付（hedgeAllowed セル選択）。全期間の propertiesSentCount は {redo} 用で混同しない
  const searched = !!opts.searched || !!opts.ledger?.facts.propertiesSentSinceCustomerLatest;
  const exact = PAIR_MATRIX.filter((r) => r.staff === staff.kind && r.customer === customer.kind);
  const rule =
    (searched ? exact.find((r) => r.hedgeAllowed) : exact.find((r) => !r.hedgeAllowed)) ??
    exact[0] ??
    PAIR_MATRIX.find((r) => r.staff === "*" && r.customer === customer.kind) ??
    PAIR_MATRIX.find((r) => r.staff === staff.kind && r.customer === "*") ??
    null;
  const summary =
    `${STAFF_KIND_JA[staff.kind]} → ${CUSTOMER_KIND_JA[customer.kind]}` +
    (customer.secondary.length ? `＋${customer.secondary.map((k) => CUSTOMER_KIND_JA[k]).join("・")}` : "") +
    (substance.concerns.length ? `（懸念: ${substance.concerns.map((c) => `${c.label}「${c.phrase}」`).join("、")}）` : "") +
    (customer.object && !substance.concerns.length ? `（対象: ${customer.object}）` : "") +
    (opts.ledger ? `｜台帳: ${opts.ledger.summary}` : "");
  return { staff, customer, substance, rule, ruleId: rule?.id ?? null, summary, lastStaffText: lastStaffText ?? "", ledger: opts.ledger ?? null, redo: redoWord(opts.ledger) };
}

/** {object}/{fix}/{redo}/{ledger}/{sentNames} の置換（生成・検査・note の三者が同じ関数） */
export function fillPairPlaceholders(s: string, pair: PairContext): string {
  const object = pair.customer.object ?? pair.substance.concerns[0]?.phrase ?? "";
  const fix = pair.substance.concerns.map((c) => c.fix).join("、") || "ご希望条件のお部屋を中心に";
  return s
    .replace(/\{object\}/g, object).replace(/\{fix\}/g, fix)
    .replace(/\{redo\}/g, pair.redo)
    .replace(/\{ledger\}/g, pair.ledger?.summary ?? "記録なし")
    .replace(/\{sentNames\}/g, pair.ledger?.facts.propertiesSentNames.join("・") || "送付済み物件");
}

/** 方向指示文（決定論リテラル）。{object}/{fix}/{redo}/{ledger} を実値に置換し、fresh brain の reply_direction は末尾に「参考」で添える */
export function buildPairDirection(pair: PairContext, opts: { brainReplyDirection?: string | null; brainFresh: boolean }): string | null {
  if (!pair.rule) return null;
  const dir = fillPairPlaceholders(pair.rule.direction, pair);
  const must = pair.rule.mustInclude.map((m, i) => `${i + 1}.${fillPairPlaceholders(m.label, pair)}`).join(" ");
  const ref = opts.brainFresh && opts.brainReplyDirection ? ` brain方向性（参考）:「${opts.brainReplyDirection}」` : "";
  return `${dir}。必須要素: ${must}。禁止: ${pair.rule.mustNot.join("／")}${ref}`;
}

/** dynamicBlock に注入する【往復文脈】ブロック（tpoGuidanceNote より上位・ハードゲートの次） */
export function buildTurnPairNote(pair: PairContext, customerMessage: string, customerName: string): string {
  const staffJa = STAFF_KIND_JA[pair.staff.kind];
  const custJa = CUSTOMER_KIND_JA[pair.customer.kind];
  const object = pair.customer.object ?? pair.substance.concerns[0]?.phrase ?? "";
  const lines: string[] = [];
  lines.push("【🔁 往復文脈 — 最上位（「場面と返信方針」より上位・ハードゲートの次）】");
  lines.push(`この返信は「我々が直前に送った〈${staffJa}〉」に対して、お客様が「〈${custJa}〉${object ? `（対象: ${object}）` : ""}」を返してきた、その返しである。単発メッセージへの相槌ではない。`);
  lines.push(`- 我々の直前発言（${staffJa}／根拠: ${pair.staff.source}${pair.staff.evidence ? "=" + pair.staff.evidence.slice(0, 40) : ""}）: 「${pair.lastStaffText.replace(/\s+/g, " ").slice(0, 160)}」`);
  // 2026-09-09 行動台帳: 「我々が既にしたこと」を往復文脈の前提として明示（宣言≠実行）
  if (pair.ledger) lines.push(`- 我々が既にしたこと（行動台帳・確定事実）: ${pair.ledger.summary}${pair.ledger.facts.pickupPromisedUnfulfilled && pair.ledger.facts.propertiesSentCount === 0 ? " → 直前の宣言はまだ履行していない。この返信は『約束の維持』であって『やり直し』ではない" : ""}`);
  lines.push(`- お客様の返答（${custJa}${pair.customer.secondary.length ? " ＋ " + pair.customer.secondary.map((k) => CUSTOMER_KIND_JA[k]).join("・") : ""}）: 「${customerMessage.split(MSG_SEP).join(" ／ ").replace(/\s+/g, " ").slice(0, 200)}」`);
  if (pair.rule) {
    lines.push(`- → この返信の役割: ${fillPairPlaceholders(pair.rule.direction, pair)}`);
    lines.push("- 必須要素（それぞれ本文で1文以上・欠けたら不合格）:");
    pair.rule.mustInclude.forEach((m, i) => lines.push(`  ${["①", "②", "③", "④", "⑤"][i] ?? i + 1} ${fillPairPlaceholders(m.label, pair)}`));
    lines.push(`- 禁止: ${pair.rule.mustNot.join(" / ")}`);
    lines.push(`- 型（成約実例。文体・テンポ・構成を踏襲し、固有名詞・エリア・物件名は今回の会話の事実に置換。顧客名は「${customerName || "〇〇"}さん」）:`);
    const ex = pair.rule.exampleBySent ? (pair.ledger && pair.ledger.facts.propertiesSentCount > 0 ? pair.rule.exampleBySent.sent : pair.rule.exampleBySent.none) : pair.rule.example;
    lines.push(`「${ex}」`);
  } else {
    lines.push("- → この返信の役割: 直前発言の流れを引き継ぎ、お客様の返答の中身に直接答えてから次の行動を宣言する");
  }
  lines.push("- 構成規則: お客様の返答が複数行・複数通でも【1つの流れ】として扱う。行ごとに「はい😊！！」「かしこまりました！！」と個別に相槌を打つ分割返答は禁止。開口語は1つ、本文は「受け止め1文→回答/代替1文→行動宣言1文→締め1文」、最後は「かしこまりました！！」で終えず行動宣言またはサポート継続宣言で終える。");
  return lines.join("\n") + "\n\n";
}

// ─────────────────────────────────────────────────────────────
// 7. ヘッジ許容（2026-09-09 Fable5 みく事例）— 生成（route latent_intent / winning_pattern / conditionDirection / customer_questions）
//    ・検査（final-check runHedgeChecks）・buildStanceNote・tpo_debug の四者がこの verdict だけを参照する。state 非依存・証拠のみ。
//    証拠: 正解2618件中 先回りヘッジ0件。「少ない/難しい」15例中14例は探索後の過去形結果報告＋実行済み代替＋ご査収締め。
// ─────────────────────────────────────────────────────────────
export type HedgeAllowance = "forbid_preemptive" | "allow_after_search" | "allow_on_customer_ask";
export interface HedgeVerdict {
  allowance: HedgeAllowance;
  searched: { yes: boolean; source: "aix_log" | "aix_mode" | "staff_text" | "aix_history" | "none"; evidence: string };
  customerAsked: { yes: boolean; evidence: string };
  customerSelfHedge: { yes: boolean; evidence: string };
  customerStatedRelax: { yes: boolean; evidence: string };
  summary: string;
}
export interface HedgeContextInput {
  customerMessage: string;
  substance: SubstanceVerdict;
  staff: StaffTurn;
  customer: CustomerResponse;
  lastStaffText: string;
  lastCustomerAt?: string | null;
  recentAixRows?: AixRow[];
  lastAixHistory?: string | null;
  /** 生成する返信自体が AIX 物件送付文（aixSourceMessage が結果報告形） */
  isAixPropertySendMode?: boolean;
  /** 2026-09-09 行動台帳（あれば searched の第1判定） */
  ledger?: ActionLedger | null;
}
const AIX_SEARCH_TYPES = new Set(["property_send", "property_recommendation", "property_send_new_arrival", "property_send_widen"]);
/** スタッフ本文の「探した結果」（過去形のみ。未来形「探します」は含めない） */
export const STAFF_SEARCHED_RE = /(?:探させて(?:頂|いただ)いた|お探しした|ピックアップ(?:させて(?:頂|いただ)き|いたし|致し|し)ました|募集(?:ございません|御座いません|ありません)でした|少ない状況でした|見つかりませんでした|ご査収ください)/;
const FEAS_TOPIC_RE = /難し|厳し|無理|きつ|可能|見つか|探せ|探して(?:もらえ|いただけ|頂け)|あり(?:ます|ません)|ござい|いけ|どう(?:です|でしょう|なん)|大丈夫/;
const INTERROGATIVE_END_RE = /(?:ますか|ですか|でしょうか|ますでしょうか|ませんか|ないですか|ますかね|ですかね|ますよね|でしょうかね)[!！]*[?？]?\s*$|[?？]\s*$/;
/** 条件付き依頼（質問ではない）: 「あれば教えてください」「変えた場合にあれば」 */
export const CONDITIONAL_REQUEST_RE = /(?:あれば|ありましたら|あったら|出てきたら|出たら|見つかれば|場合(?:は|に|には)?)[^\n]{0,24}(?:教えて|お願い|ください|下さい|頂け|いただけ|もらえ)/;
export const CUST_SELF_HEDGE_RE = /(?:難しい|厳しい|無理|贅沢|わがまま|欲張り|高望み)(?:と(?:は)?思|かと|かも|ですよね|ですかね|ですが|でしょうが|かな|なら|であれば|ようでしたら|場合)|(?:一つ|1つ|ひとつ|どれか|何か|いずれか)[^\n]{0,6}(?:条件|項目)[^\n]{0,4}(?:変え|緩め|外し|妥協|削)(?:た|る)?(?:場合|なら|ても|時)/;
export const CUST_STATED_RELAX_RE = /(?:でも|も)(?:大丈夫|良い|いい|平気|構いま|OK|オッケー|可)|(?:広げて|上げて|下げて|緩めて|外して)(?:も)?(?:大丈夫|いい|良い|ください|下さい|お願い|構いま|OK|欲しい|ほしい)|まで(?:なら|は|でも)?(?:大丈夫|出せ|OK|可能|いけ)|(?:広げ|緩め)(?:ます|たい|て(?:ほしい|欲しい|探))/;

export function resolveHedgeAllowance(ctx: HedgeContextInput): HedgeVerdict {
  const cust = normalizeCustomerText(ctx.customerMessage);
  const lines = cust.split("\n").map((s) => s.trim()).filter(Boolean);
  const isNewCondition = ctx.customer.kind === "condition_change" || ctx.customer.secondary.includes("condition_change") || ctx.substance.kinds.includes("condition");
  let searched: HedgeVerdict["searched"] = { yes: false, source: "none", evidence: "" };
  const custAt = Date.parse(ctx.lastCustomerAt ?? "");
  const aixHit = Number.isFinite(custAt)
    ? (ctx.recentAixRows ?? []).find((r) => !!r.aix_type && AIX_SEARCH_TYPES.has(r.aix_type) && Date.parse(r.created_at ?? "") >= custAt)
    : undefined;
  // 2026-09-09 行動台帳: 顧客最新以降の物件送付（aix_log > line_task > 本文）を第1判定にする（台帳が無い check-reply 旧経路は従来フォールバック）
  if (ctx.ledger?.facts.propertiesSentSinceCustomerLatest) {
    const ev = [...ctx.ledger.entries].reverse().find((e) => e.kind === "properties_sent" && e.status === "done");
    searched = { yes: true, source: "aix_log", evidence: `ledger:${ev?.source ?? "?"}=${(ev?.evidence ?? "").slice(0, 40)}` };
  }
  else if (aixHit) searched = { yes: true, source: "aix_log", evidence: `${aixHit.aix_type}@${aixHit.created_at}` };
  else if (ctx.isAixPropertySendMode) searched = { yes: true, source: "aix_mode", evidence: "aix_property_send" };
  else if (!isNewCondition && ctx.staff.kind === "property_send" && STAFF_SEARCHED_RE.test(ctx.lastStaffText)) searched = { yes: true, source: "staff_text", evidence: ctx.lastStaffText.match(STAFF_SEARCHED_RE)![0] };
  else if (!isNewCondition && !ctx.lastStaffText.trim() && !(ctx.ledger && ctx.ledger.facts.propertiesSentCount === 0)) {
    const m = /最新:(property_send|property_recommendation|property_send_widen|property_send_new_arrival)\b/.exec(ctx.lastAixHistory ?? "");
    if (m) searched = { yes: true, source: "aix_history", evidence: m[0] };
  }
  // pickup_declared は未来形＝ searched=false 固定（宣言を実行の証拠にしない）
  if (ctx.staff.kind === "pickup_declared" && searched.source === "staff_text") searched = { yes: false, source: "none", evidence: "" };
  const askLine = lines.find((p) => FEAS_TOPIC_RE.test(p) && INTERROGATIVE_END_RE.test(p) && !CONDITIONAL_REQUEST_RE.test(p) && !PURE_ACK_SENT_RE.test(p));
  const customerAsked = { yes: !!askLine, evidence: askLine ?? "" };
  const selfLine = lines.find((p) => CUST_SELF_HEDGE_RE.test(p) || (CONDITIONAL_REQUEST_RE.test(p) && FEAS_TOPIC_RE.test(p)));
  const customerSelfHedge = { yes: !!selfLine, evidence: selfLine ? (selfLine.match(CUST_SELF_HEDGE_RE)?.[0] ?? selfLine.match(CONDITIONAL_REQUEST_RE)?.[0] ?? selfLine).slice(0, 40) : "" };
  const relaxLine = lines.find((p) => CUST_STATED_RELAX_RE.test(p) && !CONDITIONAL_REQUEST_RE.test(p));
  const customerStatedRelax = { yes: !!relaxLine, evidence: relaxLine ? relaxLine.match(CUST_STATED_RELAX_RE)![0] : "" };
  const allowance: HedgeAllowance = searched.yes ? "allow_after_search" : customerAsked.yes ? "allow_on_customer_ask" : "forbid_preemptive";
  const summary =
    allowance === "allow_after_search" ? `探索済み（${searched.source}=${searched.evidence.slice(0, 40)}）→ 過去形の結果報告＋実行済み代替のみ可`
    : allowance === "allow_on_customer_ask" ? `顧客が直接質問「${customerAsked.evidence.slice(0, 40)}」→ 傾向を正直に＋探索宣言セット`
    : `未探索${customerSelfHedge.yes ? `・顧客の自己ヘッジ「${customerSelfHedge.evidence}」は復唱しない` : ""}→ 実現可能性の言及・条件緩和の先回り提案は禁止（条件そのままでピックアップ宣言→伴走締め）`;
  return { allowance, searched, customerAsked, customerSelfHedge, customerStatedRelax, summary };
}

/** brain 戦略文から代替案・条件緩和の先回り節を落とす（forbid_preemptive の時だけ route が注入前に通す）。全節が落ちたら "" */
const RELAX_STRATEGY_SEG_RE = /代替案|代替(?:の)?(?:ご提案|提案|物件)|条件(?:を)?(?:1つ|一つ|ひとつ|どれか|少し)?(?:変え|緩め|広げ|見直|緩和)|未満まで|以上は難し|優先順位|妥協|難しい場合|厳しい場合|(?:少し|やや)?難し(?:い|く)/;
export function stripPreemptiveRelax(text: string | null | undefined): string {
  if (!text) return "";
  return text.split(/(?<=[。！!])|[、／/]/).map((s) => s.trim()).filter((s) => s && !RELAX_STRATEGY_SEG_RE.test(s)).join("、").replace(/、([。！!])/g, "$1");
}

// ─────────────────────────────────────────────────────────────
// 8. 締め（closer）ポリシー — 正解2618件の締め統計（全力サポート192件は hearing86/proposing84/first_reply13 に集中・property_send 系1件、
//    ご査収674件、何卒 14%（AI生成26%）、断定削除22件は「〜で何卒」→「如何でしょうか」）。生成・検査・few-shot・学習が同じ関数を参照。
// ─────────────────────────────────────────────────────────────
export const CONCRETE_DECL_RE = new RegExp(
  `(?:周辺|全域|エリア|沿線|以内|万円|万以内|LDK|DK|[0-9０-９]K|ワンルーム|徒歩|築|[0-9０-９]+(?:帖|畳|㎡)|ペット|管理費|条件|募集状況|物件|お部屋|新着|号室)[^\\n]{0,60}(?:ピックアップ|確認|お調べ|お送り|作成|ご連絡|交渉|随時|ご案内)[^\\n。！!]{0,24}${DECL_TAIL}`,
);
export const COMMIT_CLOSER_RE = /全力で(?:お部屋探し)?(?:サポート|お部屋探しサポート)|ご満足(?:頂|いただ)(?:く|ける)お部屋が(?:見つかる|みつかる)まで/;
export const NANISOTSU_RE = /何卒(?:よろしく|宜しく)お願い(?:致します|いたします|します)/;
export const OPEN_DOOR_RE = /いつでもお気軽に(?:ご連絡|お送り|お知らせ|ご相談|お申し付け)ください|お待ちしております/;
export const WAIT_SOFTLY_RE = /ごゆっくりご(?:検討|相談|確認)(?:ください|頂けますと|いただけますと)/;
export const RECEIVE_CHECK_RE = /ご査収ください|お手隙の際にご確認ください|ご確認(?:頂|いただ)けますと幸いです/;
/** 成果物添付＝物件・見積書・結果報告（締めは receive_check 一択） */
export const DELIVERABLE_RE = /🌟|[0-9０-９]{2,4}号室|御見積書|お見積書|見積書同封|ピックアップ(?:させて(?:頂|いただ)き|いたし|致し)ました|お送りさせて(?:頂|いただ)きました|現在募集中となります/;
/** 内覧日時が確定・打診で終わる */
export const SCHEDULE_FIXED_RE = /[0-9０-９]{1,2}[:：時][0-9０-９]{0,2}[^\n]{0,24}(?:ご案内|お待ち合わせ|如何|いかが)|現地(?:エントランス)?(?:に|で)?お待ち合わせ/;
/** 先回りヘッジ（正解0/2618） */
export const PRE_PICKUP_HEDGE_RE = /(?:難し|厳し|少な|限られ|希少|見つかり(?:にくい|づらい|にくく)|ハードル|ご希望に(?:沿|添)えない)[^\n。！!]{0,14}(?:可能性|かもしれ|かと(?:思|存じ)|と思われ|恐れ|場合も|こともござ|ケースも|状況(?:です|となり|かと|になり)|見込み|ようです)|(?:少し|やや|なかなか|正直|かなり)(?:難し|厳し)(?:い|く)(?:です|なり|かと|状況|ため)|条件を(?:1つ|一つ|ひとつ|少し|1点)?(?:変え|緩め|広げ|見直)(?:た|る)場合|(?:どれか|いずれか)(?:1つ|一つ)?(?:を)?(?:緩め|妥協)|優先順位(?:を|も)?(?:お聞かせ|教えて|ご検討)/;
/** 探した結果の報告形（過去形）。allow_after_search でのみ可 */
export const SEARCH_REPORT_RE = /(?:少ない状況|募集(?:ございません|御座いません|ありません)|見つかりません|探させて(?:頂|いただ)いた|お探しした|探し(?:ました|た)(?:が|のですが|ところ))(?:でした|の(?:ため|で)|が|のですが)?/;
export const RELAX_PROPOSAL_RE = /(?:条件|エリア|家賃|ご予算|間取り|広さ|築年数?|駅(?:距離|徒歩)|徒歩|優先(?:順位|度))[^\n。！!]{0,10}(?:を)?(?:1つ|一つ|ひとつ|どれか|少し|若干)?(?:変え|緩め|広げ|見直|妥協|外し|調整)[^\n。！!]{0,24}(?:場合|ご提案|代替|あわせて|併せて|セット|ご検討|いかが|お聞かせ|教えて|優先)|代替案|(?:優先順位|ご優先)(?:を)?(?:お聞かせ|教えて|ご教示|伺)|(?:妥協|見直し)(?:いただ|頂)/;
export const PAST_REPORT_RE = /(?:でした|ございませんでした|御座いませんでした|ませんでした|させて(?:頂|いただ)きました|いたしました|致しました)/;
export const SEARCH_DECL_RE = /(?:ピックアップ|お探し|探さ|探し)[^\n。！!]{0,30}(?:させて(?:頂|いただ)き|いたし|致し|し)ます/;
export const SELF_HEDGE_ECHO_RE = /(?:難しい|厳しい)と(?:は)?(?:思|存じ|の事|のこと)|おっしゃる(?:通り|とおり)|確かに[^\n。！!]{0,12}(?:難し|厳し|少な)/;
/** 結果報告型の言い訳行（AIX widen でスタッフが2/2削除。成果物添付時に warning） */
export const RESULT_EXCUSE_RE = /少ない状況(?:でした|となります|の)ので|募集(?:が)?(?:ございませんでした|少ない状況)/;
/** 顧客への依頼（書類・フォーム）で終える返信 → お手数＋何卒 */
export const ASKS_CUSTOMER_TASK_RE = /(?:お送り|ご記入|ご入力|ご返信|お知らせ|ご確認)(?:いただけ|頂け)ます(?:と|でしょうか)|お手数(?:お)?(?:かけ|掛け)/;

export const CLOSER_TEXT: Record<CloserKind, (name: string) => string> = {
  commit_until_found: (n) => `${n ? n + "さんが" : ""}ご満足頂くお部屋が見つかるまでお部屋探し全力でサポートさせて頂きます😌！！`,
  receive_check: () => "お手隙の際にご査収ください😌！！",
  open_door: () => "気になる点出てきましたらいつでもお気軽にご連絡ください😌！！",
  wait_softly: () => "ごゆっくりご検討頂けますと幸いです😊！！気になる点出てきましたらいつでもお気軽にご連絡ください！！",
  none: () => "",
};
export const NANISOTSU_TEXT = "何卒よろしくお願い致します！！";

export interface CloserSignals {
  hasConcreteDeclaration: boolean; deliverableAttached: boolean; scheduleFixed: boolean;
  usedCommit: boolean; usedNanisotsu: boolean; usedOpenDoor: boolean; usedWait: boolean; usedReceive: boolean;
  hasPrePickupHedge: boolean; hasResultExcuse: boolean; asksCustomerTask: boolean; bodyLen: number;
}
export function deriveCloserSignals(text: string): CloserSignals {
  const t = (text ?? "").replace(/\r/g, "");
  return {
    hasConcreteDeclaration: CONCRETE_DECL_RE.test(t), deliverableAttached: DELIVERABLE_RE.test(t), scheduleFixed: SCHEDULE_FIXED_RE.test(t),
    usedCommit: COMMIT_CLOSER_RE.test(t), usedNanisotsu: NANISOTSU_RE.test(t), usedOpenDoor: OPEN_DOOR_RE.test(t),
    usedWait: WAIT_SOFTLY_RE.test(t), usedReceive: RECEIVE_CHECK_RE.test(t),
    hasPrePickupHedge: PRE_PICKUP_HEDGE_RE.test(t), hasResultExcuse: RESULT_EXCUSE_RE.test(t),
    asksCustomerTask: ASKS_CUSTOMER_TASK_RE.test(t), bodyLen: Array.from(t.replace(/\s/g, "")).length,
  };
}
/** 生成前の予測（下書きが無い時）。宣言は「これから書く」前提で true */
export function predictCloserSignals(opts: { aixSourceText?: string | null; willAttachDeliverable?: boolean; willFixSchedule?: boolean }): Pick<CloserSignals, "hasConcreteDeclaration" | "deliverableAttached" | "scheduleFixed"> {
  const a = opts.aixSourceText ?? "";
  return { hasConcreteDeclaration: true, deliverableAttached: !!opts.willAttachDeliverable || DELIVERABLE_RE.test(a), scheduleFixed: !!opts.willFixSchedule || SCHEDULE_FIXED_RE.test(a) };
}
export interface CloserVerdict { closer: CloserKind; nanisotsu: boolean; text: string; reason: string }

/** 優先順位: 断り > 成果物添付 > 日程確定 > 検討中/後日送付 > 質問回答 > セル指定 > 具体宣言あり節目 > 依頼 > 事務往復 > none */
export function resolveCloser(
  pair: PairContext,
  sig: Pick<CloserSignals, "hasConcreteDeclaration" | "deliverableAttached" | "scheduleFixed">,
  opts: { customerName: string; isFirstContact?: boolean; asksCustomerTask?: boolean; ledger?: ActionLedger | null },
): CloserVerdict {
  const name = opts.customerName || "";
  const c = pair.customer.kind, s = pair.staff.kind;
  // 2026-09-09 行動台帳: 本文欠落時の保険（直前がピックアップ宣言で台帳 evidence に「全力」があれば直前で伴走締め済み）
  const ledger = opts.ledger ?? pair.ledger;
  const priorCommit = COMMIT_CLOSER_RE.test(pair.lastStaffText ?? "") ||
    (!!ledger && pair.staff.kind === "pickup_declared" && /全力/.test(ledger.facts.lastStaffEntry?.evidence ?? ""));
  const priorNanisotsu = NANISOTSU_RE.test(pair.lastStaffText ?? "");
  const mk = (closer: CloserKind, nanisotsu: boolean, reason: string): CloserVerdict => {
    // セルが nanisotsu を明示（PD_CONDITION_CHANGE＝みく 11:48 実送信は直前の何卒に続けて何卒）する時は直前の何卒で抑制しない
    const n = nanisotsu && (!priorNanisotsu || pair.rule?.nanisotsu === true);
    const body = CLOSER_TEXT[closer](name);
    return { closer, nanisotsu: n, text: [body, n ? NANISOTSU_TEXT : ""].filter(Boolean).join("\n"), reason };
  };
  if (c === "decline") return mk("none", false, "断り→扉1文で終える（引き留め・謝罪・サポート宣言なし）");
  if (sig.deliverableAttached) return mk("receive_check", false, "成果物添付→ご査収一択（正解674件／property_send 系で全力・何卒は0件）");
  if (sig.scheduleFixed) return mk("none", false, "日程確定・打診→疑問形/確定文で終える（断定削除22件・何卒削除26件の型）");
  if (c === "thinking") return mk("wait_softly", false, "検討中→ごゆっくり＋扉。急かし禁止");
  if (c === "will_send_later") return mk("open_door", false, "後日送付予告→先取り宣言の後に扉のみ");
  if (c === "question" && s !== "condition_ask") return mk("none", false, "質問回答で終える（質問系988件中926件が何卒なし）");
  const ruleCloser = pair.rule?.closer;
  if (ruleCloser && ruleCloser !== "commit_until_found") return mk(ruleCloser, pair.rule?.nanisotsu ?? false, `PAIR_MATRIX ${pair.ruleId} の closer 指定`);
  // s === "condition_ask" は「ヒアリング回答（answer / condition_change）」を含む
  const milestone = c === "condition_change" || c === "concern" || s === "condition_ask" || !!opts.isFirstContact || ruleCloser === "commit_until_found";
  if (milestone && sig.hasConcreteDeclaration) {
    if (priorCommit) return mk("none", pair.rule?.nanisotsu ?? true, "直前で全力サポート済み→約束宣言＋何卒のみ（PRIOR_CLOSING_RE）");
    // 何卒＝「お願いの入口」（初回・ヒアリング回答＝フォーム受領・顧客への依頼）のみ。進行中の条件変更（瑞希例）は付けない
    const nanisotsu = pair.rule?.nanisotsu ?? (!!opts.isFirstContact || s === "condition_ask" || !!opts.asksCustomerTask);
    return mk("commit_until_found", nanisotsu, "具体宣言を伴う節目→見つかるまで伴走宣言（hearing86/proposing84/first_reply13）");
  }
  if (milestone && !sig.hasConcreteDeclaration) return mk("none", false, "節目だが具体宣言が無い→締めより先に具体宣言が必要（GENERIC_ONLY 予防）");
  if (opts.asksCustomerTask) return mk("none", true, "顧客への依頼（書類等）→お手数おかけしますが何卒（慶次例）");
  if (c === "ack_only" && s === "confirmation_promise") return mk("none", false, "進行中の事務往復→約束復唱のみ（何卒削除26件の型）");
  return mk("none", false, "既定: 行動宣言で終える");
}

// ─────────────────────────────────────────────────────────────
// 9. 姿勢（stance）— 編集400件の上位ギャップ（具体復唱101・絵文字89/49・何卒50・決め打ち22・可否保留11・伴走欠落8・煽り9・受け身語18）
//    生成（buildStanceNote）・検査（final-check runStanceChecks）・学習（save-reply-example stance_sent_lite）が同一関数を参照
// ─────────────────────────────────────────────────────────────
/** 条件フォームの項目ラベル（「⑦【初期費用の限度額】⇒」「⑦初期費用」「【初期費用】⇒」）。顧客発言を照合する前に必ず除去する（ラベル語で費用トリガー判定しない）。
 *  line-reply-prompts.ts は本定義を再 export する（循環 import 禁止のため定義はこちら） */
export const FORM_LABEL_RE = /[①-⑩]\s*(?:【[^】\n]{0,20}】|(?:ご?入居時期|ご?希望家賃|家賃|間取り|築年数|ご?希望エリア|エリア(?:・駅)?|駅徒歩|初期費用(?:の限度額|の上限)?|その他(?:ご?希望|条件)?))\s*[⇒→:：]?|【[^】\n]{0,20}】\s*[⇒→:：]/g;
const toHalfWidth = (s: string) => s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/位内/g, "以内");
export const ECHO_TOKEN_RE = /[0-9.〜~]+(?:万円?以内|万円?|万以内|円|帖|畳|㎡|平米|分以内|分|年以内|年|階|月|日|時)|[1-4](?:LDK|DK|K|R)|ワンルーム|[一-龯ァ-ヶー]{1,8}(?:駅|線|区|市|町)|カウンターキッチン|対面キッチン|独立洗面|バストイレ別|オートロック|ペット可?|駐車場|鉄筋|RC|木造|鉄骨|フリーレント|敷金|礼金|南向き|角部屋/g;
export function extractEchoTokens(customerText: string): string[] {
  const t = toHalfWidth((customerText ?? "").split(MSG_SEP).join("\n").replace(FORM_LABEL_RE, ""));
  return [...new Set(t.match(ECHO_TOKEN_RE) ?? [])];
}
export type EchoVerdict = { expected: string[]; echoed: string[]; missing: string[]; ratio: number };
export function evalConditionEcho(draft: string, tokens: string[]): EchoVerdict {
  const d = toHalfWidth(draft ?? "");
  const echoed = tokens.filter((k) => d.includes(k));
  const missing = tokens.filter((k) => !echoed.includes(k));
  return { expected: tokens, echoed, missing, ratio: tokens.length ? echoed.length / tokens.length : 1 };
}

// 日程の確定度（決め打ち断定22件）
const DATETIME_TOKEN_RE = /[0-9０-９]{1,2}[\/月][0-9０-９]{1,2}|[0-9０-９]{1,2}日|[月火水木金土日]曜|[0-9０-９]{1,2}[:：時][0-9０-９]{0,2}|本日|明日|明後日/;
const CUSTOMER_FIX_RE = /(?:で|に)(?:お願い|大丈夫|OK|オッケー|行け|伺え|可能です|問題ない)|でお願いします|にします|で(?:大丈夫|いい)です/;
const CUSTOMER_ASK_RE = /可能でしょうか|可能ですか|空いて|大丈夫ですか|行けますか|いけますか|できますか|どうですか/;
export type ScheduleCommitment = "customer_fixed" | "customer_asking" | "staff_proposing" | "none";
export function classifyScheduleCommitment(customerText: string, lastStaffText: string): ScheduleCommitment {
  const c = toHalfWidth(customerText ?? "");
  if (!DATETIME_TOKEN_RE.test(c) && !DATETIME_TOKEN_RE.test(lastStaffText ?? "")) return "none";
  if (DATETIME_TOKEN_RE.test(c) && CUSTOMER_FIX_RE.test(c) && !CUSTOMER_ASK_RE.test(c)) return "customer_fixed";
  if (CUSTOMER_ASK_RE.test(c)) return "customer_asking";
  return "staff_proposing";
}
export const STAFF_ASSERT_SCHEDULE_RE = /(?:[0-9０-９]{1,2}[\/／月][0-9０-９]{1,2}|[0-9０-９]{1,2}[:：時][0-9０-９]{0,2}|本日|明日|[月火水木金土日]曜)[^\n]{0,60}(?:お待ち合わせ|現地|エントランス)[^\n]{0,10}(?:で|にて)[^\n]{0,6}(?:何卒)?よろしくお願い|ご案内させて(?:頂|いただ)きます[！!]*$/m;
export const SCHEDULE_ASK_RE = /(?:如何|いかが)でしょうか/;

// 即答してよい既知事実（正解実例に出現した断定のみ。ASSERTION_BAN 対象＝告知・空室・入居日・審査は含めない）
export const KNOWN_FACT_ANSWERS: Array<{ key: string; ask: RegExp; answer: string; next: string }> = [
  { key: "remote_contract", ask: /(?:写真|画像)(?:だけ|のみ)[^\n]{0,24}(?:契約|申込)|(?:内見|内覧)(?:せず|なし|が難しい|できない|行けない)[^\n]{0,24}(?:契約|申込|決め)/, answer: "写真やお部屋の詳細情報のみでご契約可能です！！", next: "オンライン内見や室内の撮影もご対応させて頂きます😊！！" },
  { key: "osaka_all", ask: /(?:大阪|府内|他のエリア|どこでも)[^\n]{0,12}(?:対応|探せ|扱え|可能)/, answer: "大阪府域の物件全てご対応可能です！！", next: "気になるお部屋お送り頂けましたら募集状況確認と御見積書作成しお送りさせて頂きます😌！！" },
  { key: "card_pay", ask: /クレジット|カード払い|カードで/, answer: "初期費用のクレジットカード払い対応しております！！", next: "" },
  { key: "second_apply", ask: /(?:申込|申し込み)(?:入って|済み|が入って)[^\n]{0,12}(?:でも|も)?(?:申込|申し込め|可能)/, answer: "2番手以降でのお申込みが可能です！！", next: "" },
];
export const DEFERRED_ANSWER_RE = /(?:社内|上司|担当|管理会社)?(?:で|に)?(?:確認|お調べ)(?:させて(?:頂|いただ)き|いたし|致し)ます/;
export function resolveAnswerability(customerText: string) { return KNOWN_FACT_ANSWERS.find((f) => f.ask.test(customerText ?? "")) ?? null; }

// 保険・受け身・煽り語
export type ExcuseFlag = "widen_excuse" | "reassurance_no_basis" | "urgency" | "consider_push" | "humble_wait";
const URGENCY_RE = /埋まっ?て?(?:しまう|しまい)前に|お早めに|残り(?:わずか|[0-9０-９]+部屋)|人気(?:のため|物件のため)|かなり条件のいい|早い者勝ち/;
const REASSURANCE_RE = /ご安心(?:ください|下さい)/;
const FACT_SENT_RE = /(?:となります|でございます|可能です|大丈夫です|問題ございません|とのことです)[！!。]/;
const CONSIDER_PUSH_RE = /(?<!ごゆっくり)ご検討(?:ください|下さい)|ご検討(?:のほど|の程)/;
const HUMBLE_WAIT_RE = /(?:いただけ|頂け)ますと幸いです(?!😊)|恐縮ですが|恐れ入りますが|少々お時間/;
const HUMBLE_WAIT_OK_RE = /ごゆっくりご(?:検討|相談|確認)(?:頂け|いただけ)ますと幸いです/;
export function detectExcusePhrases(text: string, pair: PairContext, customerEchoTokens: string[]): Array<{ flag: ExcuseFlag; evidence: string }> {
  const out: Array<{ flag: ExcuseFlag; evidence: string }> = [];
  const w = RESULT_EXCUSE_RE.exec(text);
  if (w && pair.customer.kind === "condition_change" && customerEchoTokens.some((k) => text.slice(w.index, w.index + 80).includes(k))) out.push({ flag: "widen_excuse", evidence: w[0] });
  const r = REASSURANCE_RE.exec(text);
  if (r && !FACT_SENT_RE.test(text.slice(0, r.index))) out.push({ flag: "reassurance_no_basis", evidence: r[0] });
  const u = URGENCY_RE.exec(text);
  const urgencyOk = pair.customer.kind === "positive" || pair.substance.kinds.includes("decision") || pair.staff.kind === "estimate_send";
  if (u && !urgencyOk) out.push({ flag: "urgency", evidence: u[0] });
  const c = CONSIDER_PUSH_RE.exec(text); if (c) out.push({ flag: "consider_push", evidence: c[0] });
  const h = HUMBLE_WAIT_RE.exec(text);
  if (h && !HUMBLE_WAIT_OK_RE.test(text.slice(Math.max(0, h.index - 14), h.index + 16))) out.push({ flag: "humble_wait", evidence: h[0] });
  return out;
}

const EMOJI_RE = /[\p{Extended_Pictographic}]/gu;
export interface StanceFlags {
  closer_kind: CloserKind | "preemptive_hedge" | "other";
  closer_expected: CloserKind; closer_reason: string;
  hedge_allowance: HedgeAllowance; hedge_kind: "preemptive" | "search_report" | "relax_proposal" | null;
  has_commit: boolean; has_nanisotsu: boolean; nanisotsu_expected: boolean;
  echo_ratio: number; echo_missing: string[];
  schedule_commitment: ScheduleCommitment; schedule_assert_unconfirmed: boolean;
  fact_deferred: string | null;
  excuse_flags: ExcuseFlag[];
  emoji_count: number; exclaim_count: number; char_len: number;
}
/** 下書き（route tpo_debug.stance_draft）・検査（final-check）が同じ関数で計算する。送信文側は pair 非依存の computeStanceLite */
export function computeStanceFlags(text: string, pair: PairContext, hedge: HedgeVerdict, opts: { customerName: string; customerText: string; isFirstContact?: boolean }): StanceFlags {
  const sig = deriveCloserSignals(text);
  const v = resolveCloser(pair, sig, { customerName: opts.customerName, isFirstContact: opts.isFirstContact, asksCustomerTask: sig.asksCustomerTask });
  const tokens = extractEchoTokens(opts.customerText);
  const echo = evalConditionEcho(text, tokens);
  const sched = classifyScheduleCommitment(opts.customerText, pair.lastStaffText);
  const fact = resolveAnswerability(opts.customerText);
  const closer_kind: StanceFlags["closer_kind"] =
    sig.hasPrePickupHedge ? "preemptive_hedge" : sig.usedCommit ? "commit_until_found" : sig.usedReceive ? "receive_check" : sig.usedWait ? "wait_softly" : sig.usedOpenDoor ? "open_door" : sig.usedNanisotsu || sig.scheduleFixed ? "none" : "other";
  return {
    closer_kind, closer_expected: v.closer, closer_reason: v.reason,
    hedge_allowance: hedge.allowance,
    hedge_kind: sig.hasPrePickupHedge ? "preemptive" : SEARCH_REPORT_RE.test(text) ? "search_report" : RELAX_PROPOSAL_RE.test(text) ? "relax_proposal" : null,
    has_commit: sig.usedCommit, has_nanisotsu: sig.usedNanisotsu, nanisotsu_expected: v.nanisotsu,
    echo_ratio: Math.round(echo.ratio * 100) / 100, echo_missing: echo.missing,
    schedule_commitment: sched,
    schedule_assert_unconfirmed: (sched === "customer_asking" || sched === "staff_proposing") && STAFF_ASSERT_SCHEDULE_RE.test(text) && !SCHEDULE_ASK_RE.test(text),
    fact_deferred: fact && DEFERRED_ANSWER_RE.test(text) && !text.includes(fact.answer.replace(/[！!]+$/, "").slice(0, 10)) ? fact.key : null,
    excuse_flags: detectExcusePhrases(text, pair, tokens).map((e) => e.flag),
    emoji_count: (text.match(EMOJI_RE) ?? []).length,
    exclaim_count: (text.match(/！！|!!/g) ?? []).length,
    char_len: sig.bodyLen,
  };
}

/** 送信文側の軽量版（save-reply-example。pair/hedge は再構築できないので締め種別・復唱率・温度のみ）。stance_draft との遷移行列 SQL 用 */
export interface StanceLite {
  closer_kind: StanceFlags["closer_kind"];
  has_commit: boolean; has_nanisotsu: boolean; hedge_kind: StanceFlags["hedge_kind"];
  echo_ratio: number; echo_missing: string[]; emoji_count: number; exclaim_count: number; char_len: number;
}
export function computeStanceLite(text: string, customerText: string): StanceLite {
  const sig = deriveCloserSignals(text);
  const echo = evalConditionEcho(text, extractEchoTokens(customerText));
  return {
    closer_kind: sig.hasPrePickupHedge ? "preemptive_hedge" : sig.usedCommit ? "commit_until_found" : sig.usedReceive ? "receive_check" : sig.usedWait ? "wait_softly" : sig.usedOpenDoor ? "open_door" : sig.usedNanisotsu || sig.scheduleFixed ? "none" : "other",
    has_commit: sig.usedCommit, has_nanisotsu: sig.usedNanisotsu,
    hedge_kind: sig.hasPrePickupHedge ? "preemptive" : SEARCH_REPORT_RE.test(text) ? "search_report" : RELAX_PROPOSAL_RE.test(text) ? "relax_proposal" : null,
    echo_ratio: Math.round(echo.ratio * 100) / 100, echo_missing: echo.missing,
    emoji_count: (text.match(EMOJI_RE) ?? []).length, exclaim_count: (text.match(/！！|!!/g) ?? []).length, char_len: sig.bodyLen,
  };
}

/** dynamicBlock【姿勢】ブロック（往復文脈ブロックの直後・tpoGuidanceNote より上位）。決定論の値をリテラルで渡し LLM に選ばせない */
export function buildStanceNote(pair: PairContext, hedge: HedgeVerdict, closer: CloserVerdict, opts: { customerName: string; customerText: string }): string {
  const name = opts.customerName ? `${opts.customerName}さん` : "〇〇さん";
  const tokens = extractEchoTokens(opts.customerText);
  const fact = resolveAnswerability(opts.customerText);
  const sched = classifyScheduleCommitment(opts.customerText, pair.lastStaffText);
  const L: string[] = ["【🧭 姿勢 — 「見つかるまで伴走する頼れる担当者」（往復文脈の次・場面通知より上位）】"];
  if (hedge.allowance === "forbid_preemptive")
    L.push(`- 🚫 ヘッジ判定（${hedge.summary}）: 「難しい可能性」「少ない状況」「条件を1つ変えた場合」「優先順位をお聞かせ」等の実現可能性への言及・条件緩和の先回り提案は絶対禁止。まだ探していないので結果は語れない${hedge.customerSelfHedge.yes ? `。お客様の「${hedge.customerSelfHedge.evidence}」は復唱・同意しない（代替案はピックアップ結果と一緒に報告する）` : ""}`);
  else if (hedge.allowance === "allow_after_search")
    L.push(`- ✅ ヘッジ判定（${hedge.summary}）: 「〇〇のご条件ですと合うお部屋が少ない状況でしたので、△△まで広げてピックアップさせて頂きました」の過去形＋実行済み代替のみ可。未来形の予測は禁止。締めは「お手隙の際にご査収ください😌！！」`);
  else
    L.push(`- ✅ ヘッジ判定（${hedge.summary}）: 傾向を「傾向として〜が多いですが」と1文で正直に答えてよい。必ず「${name}のご条件でしっかりピックアップしてお送りさせて頂きます！！」の探索宣言を同じ返信に入れる。優先順位の聞き返しは禁止（まず探す）`);
  if (tokens.length >= 2)
    L.push(`- 📌 お客様の条件トークン（この語を一文字も変えずに行動宣言へ埋め込む。「ご条件に合った」「ご希望の」で置き換えない）: ${tokens.join("・")}`);
  L.push(closer.text
    ? `- 🔚 締め（最終行に置く。行動宣言の代わりにしない）: 「${closer.text.replace(/\n/g, "」＋「")}」（${closer.reason}）`
    : `- 🔚 締め: 追加の締め文なし（${closer.reason}）。「全力でサポート」「何卒よろしく」を足さない`);
  if (fact) L.push(`- ✅ 即答: 「${fact.answer}」と言い切る（「確認させて頂きます」に逃がさない）${fact.next ? `→続けて「${fact.next}」` : ""}`);
  if (sched === "customer_asking" || sched === "staff_proposing")
    L.push(`- 🗓 日程は提案形: お客様が日時を確定していない。「はい！！お部屋ご案内可能です😊！！」→日付・時刻・場所を数字で→「〜お待ち合わせ如何でしょうか！！」。「〜で何卒よろしくお願い致します」の決め打ち禁止`);
  L.push("- 🌡 温度: 😊😌は2個以内・！！は3回以内。「ご安心ください」「ご検討ください」「恐縮ですが」「〜いただけますと幸いです」「少々お時間」で終えず、こちらの行動宣言で終える。呼称は「〇〇さん」");
  L.push("- 🕰 急かさない: 「埋まってしまう前に」「お早めに」は見積送付後・お客様の前向き反応後のみ");
  return L.join("\n") + "\n\n";
}
