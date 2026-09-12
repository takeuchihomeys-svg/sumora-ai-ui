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
    // 2026-09-11 統合設計（経路D）: ASCII 顔文字「m(*_ _)m」「m(_ _)m」を定型判定の前に剥がす
    .replace(/m\([^)\n]{0,6}\)m/g, "")
    .replace(DECOR_RE, "")
    .replace(/[ \t　]+/g, " ")
    .replace(/([！!？?。、，,．.…]|\s)+/g, "$1")
    .trim();
}
const cpLen = (s: string) => Array.from(s.replace(/[\s、。！!？?…]/g, "")).length;

// ─────────────────────────────────────────────────────────────
// 2. 実質判定（Substance）
// ─────────────────────────────────────────────────────────────
// 2026-09-10 Fable5 Sさん事例: "positive"（前向き反応）を追加。
//   旧実装は「アーバネックス気になります」を statement（＝どの CustomerResponseKind にも写像を持たない
//   残余ラベル）に落とし、下流には other としてしか伝わらなかった＝「出口のない kind」。
//   分類体系を増やす時は必ず出口（下流のどの列に落ちるか）を1つ以上定義する。
export type SubstanceKind =
  | "concern" | "question" | "request" | "condition" | "schedule"
  | "decision" | "decline" | "info" | "answer" | "positive" | "statement";

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
  /** 2026-09-10 Fable5 みく事例: 定型（感謝・了承・締め）と待ち句を剥がした残余がゼロ。isAckOnly ⊂ isPureBoilerplate。
   *  「ありがとうございます！確認させていただきます」は isAckOnly=false / isPureBoilerplate=true の中間状態。
   *  brain の抽出結果は「residue の中身」を説明する値なので、これが true の時 brain は STRONG_KIND を足せない */
  isPureBoilerplate: boolean;
  /** 待ち句（検討します／確認します／また連絡します）の検出結果。thinking 分類の唯一の入口。
   *  analyzeSubstance / classifyCustomerResponse / PS_THINKING の鏡写しが同じ語彙を参照する（四者同名） */
  waitSignal: WaitSignal;
}

const STRONG_KINDS: SubstanceKind[] = ["concern", "question", "request", "condition", "schedule", "decision", "decline", "info", "answer"];

/** 純粋な感謝・了承・締め（1文単位）。前置き（ご確認いただき／ご丁寧に／暑い中 等）も吸収
 *  2026-09-11 統合設計（経路D・うえっち事例）: 探索終了のお礼「色々探してもらってありがとうございました」が残余25字の statement に
 *  なり「実質あり」扱いで骨格チェックが行動宣言を要求していた。前置き語に 探して(もらって/頂き)／お探し頂き／親身に・親切に／今まで／
 *  内覧(頂き)（いずれも感謝語の直前のみ）を足し、末尾語に「お世話になりました」を足す。前置きの連結上限は 2→3 */
export const PURE_ACK_SENT_RE =
  /^(?:(?:探して(?:もらって|頂き|いただき|くださり)|お探し(?:頂き|いただき)|(?:親身に|親切に)(?:ご?対応|して)?(?:いただき|頂き|くださり)?|今まで(?=ありがと|有難|お世話)|内覧(?:いただき|頂き)?(?=ありがと|有難)|ご?確認(?:いただき|頂き|して(?:いただき|頂き))?|ご?対応(?:いただき|頂き)?|ご?連絡(?:いただき|頂き)?|お?返事(?:いただき|頂き)?|ご?返信(?:いただき|頂き)?|送って(?:いただき|頂き|くださり)|お送り(?:いただき|頂き)|お調べ(?:いただき|頂き)?|ピックアップ(?:いただき|頂き|して(?:いただき|頂き))?|ご?提案(?:いただき|頂き)?|ご?紹介(?:いただき|頂き)?|ご?案内(?:いただき|頂き)?|ご?説明(?:いただき|頂き)?|(?:お|御)?見積(?:もり|り|書)?(?:を|も)?|物件(?:を|も)?|お部屋(?:を|も)?|お?写真(?:を|も)?|画像(?:を|も)?|資料(?:を|も)?|情報(?:を|も)?|ご丁寧に|丁寧に|詳しく|諸々|暑い中|遅い時間に|夜分に|お忙しい中|早速|早々に?|早急に|迅速に|いつも|本日は|先日は|先ほどは|色々|いろいろ|お手数(?:お)?(?:掛け|かけ)(?:します|しますが)?|こちらこそ|引き続き|今後とも|何卒|どうぞ){0,3}(?:ありがとう(?:ございま(?:す|した))?|有難う(?:ございま(?:す|した))?|感謝(?:します|いたします)?|助かります|嬉しいです|了解(?:です|しました|いたしました|致しました)?|承知(?:しました|いたしました|致しました|です)?|わかりました|分かりました|かしこまりました|(?:よろしく|宜しく)お?(?:ねがい|願い)(?:します|いたします|致します)?|お願い(?:します|いたします|致します)|はい|(?<![A-Za-z])OK(?![A-Za-z])|(?<![A-Za-z])ok(?![A-Za-z])|オッケー(?:です)?|おっけ(?:ー)?(?:です)?|お世話になります|お世話になっております|お世話になりました|失礼(?:します|いたします|致します)|楽しみにしてます|楽しみです|そうなんですね|なるほど|すいません|すみません|はーい|うん)[\s、,！!。]*)+$/;
const CLOSER_SENT_RE = /^(?:では|それでは)?(?:失礼(?:します|いたします|致します)|以上です|よろしくです)[！!。]*$/;
/** 待ち句（検討します／後で確認します／また連絡します）は TPO 所有。実質ではないので残余から除く */
const WAIT_PHRASE_SRC =
  "(?:少し|もう少し|一度|一旦|ゆっくり|じっくり)?(?:検討|考え|相談)(?:させて(?:いただき|頂き|もらい)?ます|します|いたします|致します|してみます|てみます|ます|中です|中で)|(?:後で|あとで|後ほど|のちほど|帰ったら|落ち着いたら|時間(?:が|の)?ある時に|仕事終わりに)?(?:ゆっくり|じっくり)?(?:確認|拝見|見|チェック)(?:させて(?:いただき|頂き|もらい)?ます|します|いたします|致します|ます)|(?:1度|一度|1回|一回|一旦)?(?:確認|拝見|見|チェック)(?:して|し)(?:から|また|改めて|の上で?|次第|、)|(?:後ほど|あとで|また|改めて|再度)?(?:改めて)?(?:ご?連絡|返信|お返事)(?:させて(?:いただき|頂き)?ます|します|いたします|致します)";
const WAIT_PHRASE_RE = new RegExp(WAIT_PHRASE_SRC);
const WAIT_PHRASE_RE_G = new RegExp(WAIT_PHRASE_SRC, "g");

// ─── 2026-09-10 Fable5 みく事例: 待ち句の動詞クラス（thinking 分類の唯一の入口）───
// GOYUKKURI_MIRROR（L1354付近）・CUSTOMER_KAKUNIN_SIGNAL_RE と同じ語彙圏を使う。
// 旧実装は CUST_THINKING_RE だけが「確認／拝見／チェック」を知らず、PS_THINKING（direction 本文は
// 「確認します→ご確認」の鏡写しを明記）に到達できなかった。
export type WaitVerb = "検討" | "確認" | "相談" | "連絡";
export type WaitSignal = { yes: boolean; verb: WaitVerb | null; phrase: string };
const WAIT_VERB_MAP: Array<[WaitVerb, RegExp]> = [
  ["検討", /検討|考え|悩|迷/],
  ["確認", /確認|拝見|チェック|見|目を通/],
  ["相談", /相談|話し合|持ち帰/],
  ["連絡", /ご?連絡|返信|お返事/],
];
export function detectWaitSignal(normalized: string): WaitSignal {
  const m = WAIT_PHRASE_RE.exec(normalized);
  if (!m) return { yes: false, verb: null, phrase: "" };
  const hit = WAIT_VERB_MAP.find(([, re]) => re.test(m[0]));
  return { yes: true, verb: hit ? hit[0] : null, phrase: m[0] };
}

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

/** 譲歩形（「古くても大丈夫」「遠くてもOK」）は懸念ではない（懸念判定の前に行から除く） */
const CONCESSION_RE = /(?:古|遠|狭|暗|高)く(?:て)?も(?:大丈夫|可|OK|ok|いい|良い|構わ|問題|平気)|(?:築年数|築年|広さ|階数)[^\n。！!？?]{0,6}(?:こだわり(?:なし|無し|ありません|ない)|気にしない|問わない|不問)/g;
const KIND_RE: Array<[SubstanceKind, RegExp]> = [
  ["request",   /希望|教えて|内覧|内見|見学|申(?:し)?込|書類|見積|交渉|送って(?:ください|ほしい|欲しい|もらえ|いただけ|頂け)|(?:見|行き|借り|住み|知り|聞き|決め|伺い)たい|してほしい|して欲しい|お願いでき|(?:も|で|を)お?(?:ねがい|願い)(?:します|いたします|致します)|詳細/],
  ["question",  /[?？]|(?:ます|です|でしょう|ません)か(?:[ねぇ]?(?:[。！!、\s]|$))|いつ(?:頃|ごろ|まで|から|に|が|です|でしょ|になり|になる|くらい)|いくら(?!でも)|どこ(?!でも|も)|どちら(?!でも|も)|どの(?:物件|お部屋|方)|どう(?:なり|すれ|いう|やって|でしょ|ですか)|何(?:時|日|円|曜)|なん(?:時|日|じ)/],
  ["schedule",  /明日|明後日|来週|今週|来月|今月|週末|土日|平日|[0-9０-９]{1,2}[月\/][0-9０-９]{1,2}|[0-9０-９]{1,2}日|[月火水木金土日]曜|[0-9０-９]{1,2}[:：.時][0-9０-９]{0,2}|午前|午後|夕方|以降|までに|頃に|ごろ|(?:送ら|送り)(?:せて)?(?:いただき|頂き)?ます/],
  ["condition", /家賃|予算|万円|エリア|駅|線|徒歩|間取り|[1-4１-４](?:LDK|DK|K|R)|ワンルーム|築|向き|設備|オートロック|バストイレ|独立洗面|管理費|共益費|駐車場|ペット|楽器|二人|2人|同棲|ルームシェア|[一-龯ァ-ヶ]{1,6}(?:区|市|町)|市内|市外|区内|付近|周辺|以内|以上|でも大丈夫|このままで|(?:は|が)?NG(?:で|です)/],
  ["decision",  /申(?:し)?込(?:み)?(?:たい|します|お願い|で|させて)|決め(?:ます|たい|ました)|契約(?:したい|します)|押さえ|抑え|進めて|[0-9０-９]{3,4}(?:号室)?でお?(?:ねがい|願い)|号室/],
  ["decline",   /見送|やめ|遠慮|お断り|他で(?:決め|契約)|キャンセル|辞退|白紙|ストップ/],
  ["info",      /住所|勤務先|年収|収入|勤続|保証人|緊急連絡先|保険証|入居(?:日|時期|予定)|退去|引っ?越し|出産|上旬|中旬|下旬|月末|資金|貯め|に決め|にします/],
  // 2026-09-10 Fable5 Sさん事例: 前向き反応。ここで捕まえないと「アーバネックス気になります」(13字) が
  //   L237 の statement（kinds.size===0 が条件）に落ち、classifyCustomerResponse に写像が無く必ず other になる
  ["positive",  /気になり(?:ます|まし)|気になる(?:物件|お部屋)|気に入(?:り|っ|ら)|良さそう|よさそう|いいですね|良いですね|いい感じ|良い感じ|素敵|すてき|好み(?:です|かも)|興味(?:が)?(?:あり|湧)|(?:内見|内覧|見学|下見)[^\n]{0,6}?(?:し?たい|希望|お願い|(?:出来|でき)(?:ます|る|れ|ば)?|可能)|見てみたい|見たいです/],
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
    isPureBoilerplate: true, waitSignal: detectWaitSignal(normalized),
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
  const waitSignal = detectWaitSignal(normalized);
  // 2026-09-10 Fable5: 定型と待ち句を剥がした残余がゼロ（本文に実質ゼロ）。brain のガード基準はこちら
  const isPureBoilerplate = residueLen === 0;
  // 純粋な了承: 全文が定型文のみ（待ち句「検討します」は了承ではないので isAckOnly=false・has=false の中間状態）
  const isAckOnly = isPureBoilerplate && sents.every((s) => isAckSent(s) || (!WAIT_PHRASE_RE.test(s) && cpLen(s) < 2));
  if (isAckOnly) return { ...none("ack_only"), isAckOnly: true };

  const kinds = new Set<SubstanceKind>();
  const concerns: ConcernHit[] = [];
  // 2026-09-11 竹内方針2（統合設計 §5.1・E5-i/j）: 懸念はテンプレート貼り返し（「※審査に不安な事がある方〜」）とフォームラベル
  //   （④【希望築年数】等）を剥がした本文で、話題語とヘッジ語が「同じ行（\n・。！？区切り）」にある時だけ。譲歩形（古くても大丈夫）は先に除く。
  //   旧実装は本文全体で「どこかの不安」×「ラベルの築年・家賃・広さ」を組み合わせ、条件フォームで懸念を3つ同時に立てていた
  const docScope = resolveCustomerDocScope(customerMessage);
  const concernLines = normalizeCustomerText(docScope.body)
    .split(/\n|(?<=[。！!？?])/)
    .map((s) => s.replace(CONCESSION_RE, "").trim())
    .filter(Boolean);
  for (const r of CONCERN_RULES) {
    let phrase: string | null = null;
    for (const line of concernLines) {
      const strong = r.strongRe?.exec(line) ?? null;
      if (strong) { phrase = strong[0]; break; }
      const topic = r.topicRe?.exec(line) ?? null;
      if (topic && CONCERN_HEDGE_RE.test(line)) { phrase = topic[0]; break; }
    }
    if (phrase) concerns.push({ key: r.key, label: r.label, phrase, replyRe: r.replyRe, fix: r.fix });
  }
  if (concerns.length > 0) { kinds.add("concern"); evidence.push(`concern:${concerns.map((c) => c.key).join(",")}`); }
  // 2026-09-11 竹内方針2: 物件送付（URL・物件情報）・申込フォームは「条件」ではない（駅・区・駐車場の語だけで condition が立ち、
  //   CONDITION_CHANGE セルに入って復唱を要求していた。物件送付 20/52・申込フォーム全件）
  const noCondition = docScope.scope === "property_share" || docScope.scope === "application_form";
  for (const [k, re] of KIND_RE) {
    if (k === "condition" && noCondition) continue;
    if (re.test(residue)) { kinds.add(k); evidence.push(`kind:${k}`); }
  }
  if (docScope.scope !== "none") evidence.push(`scope:${docScope.scope}`);
  // 往復文脈: 我々が直前に質問していれば、了承以外の短文は「回答」（「ついてます」「プリウスです」）
  if (opts.staffAskedQuestion && residueLen >= 2 && kinds.size === 0) { kinds.add("answer"); evidence.push("answer:staffAsk"); }
  if (residueLen >= 10 && kinds.size === 0) { kinds.add("statement"); evidence.push(`residue:${residueLen}`); }

  // 2026-09-10 Fable5 Sさん事例: 前向き反応は「実質あり」（＝WE DO を要求する）。
  //   「良さそうですね」(7字) は residueLen<10 で has=false に落ちていた。STRONG_KINDS 自体は触らない
  const has = STRONG_KINDS.some((k) => kinds.has(k)) || kinds.has("positive") || residueLen >= 10;
  return { has, kinds: [...kinds], concerns, isAckOnly: false, residue, residueLen, normalized, units: unitList, evidence, isPureBoilerplate, waitSignal };
}

// ─────────────────────────────────────────────────────────────
// 2-b. BrainScope — brain フィールドの「意味のスコープ」分離
// 2026-09-10 Fable5 みく事例:
//   message-local = このメッセージについての判定 / conversation = 会話全体の方針。
//   分類器（mergeBrainEvidence / classifyCustomerResponse）は message-local しか受け取れない。
//   scope が必須リテラル型なので、conversation-scope 側を渡すとコンパイルエラーになる。
//   根拠: brain-core.ts の各フィールドのプロンプト定義。「message-local リセット10件」のリストは
//   鮮度リセットのリストであって意味スコープのリストではない（repeated_concern / future_timeline /
//   current_property という conversation-scope 3件が混入している）。下流はこれを scope と読み替えていた。
// ─────────────────────────────────────────────────────────────
export type HesitancyPattern = "thinking" | "callback" | "waiting" | "undecided" | "timeline";

/** 「今回のメッセージが何であるか」の判定に使ってよいフィールドだけを持つ */
export type BrainMessageLocal = {
  readonly scope: "message-local";
  /** brain-core「最新メッセージに含まれる質問…過去メッセージの質問は含めない」 */
  customer_questions: string[] | null;
  /** 同「最新メッセージで…述べた懸念…過去メッセージの懸念は含めない」。
   *  ただし差分分析モードで前回値が残りうるため、必ず本文アンカー（anchorBrainConcern）を要求する */
  customer_concern: { topic?: string | null; object?: string | null } | null;
  /** 同「最新メッセージで検索条件の変更・追加・緩和…があったか」 */
  condition_change_type: string | null;
  /** 同「決断を保留するパターンを最新メッセージで示しているか」 */
  hesitancy_pattern: HesitancyPattern | null;
  /** 同「お客様の今回の問い合わせ意図」。定義が広い（negative=懸念・不安）ため
   *  単独で kind を立てない。corroboration（補助証拠）専用 */
  customer_intent: string | null;
};

/** 「返信の方針・禁止事項」に使うが、「今回のメッセージが何であるか」の判定には**使わない** */
export type BrainConversationScope = {
  readonly scope: "conversation";
  /** brain-core「顧客が**会話全体で**繰り返し確認しているテーマ…2回以上登場した話題のみ」。
   *  実データ上位は 初期費用16 / 審査5 / 費用3 ＝賃貸客なら誰でも持つ恒常論点。
   *  **このメッセージが懸念であることを一切示さない** */
  repeated_concern: string | null;
  engagement_stance: "push" | "wait" | null;
  avoid_topics: string[];
  reply_direction: string | null;
  latent_intent: string | null;
  closing_strategy: string | null;
  winning_pattern: string | null;
  current_property: string | null;
  future_timeline: string | null;
  purchase_signal_level: string | null;
  checkpoint_stage: string | null;
};

type RawBrainMeta = Record<string, unknown>;
const HESITANCY_VALUES: readonly string[] = ["thinking", "callback", "waiting", "undecided", "timeline"];
const asHesitancy = (v: unknown): HesitancyPattern | null =>
  typeof v === "string" && HESITANCY_VALUES.includes(v) ? (v as HesitancyPattern) : null;
const asStrArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** brainMeta → message-local。**呼び出し側でフィールドを手で詰めない**（repeated_concern の再混入を構造的に防ぐ唯一の入口） */
export function toBrainMessageLocal(bm: RawBrainMeta | null | undefined): BrainMessageLocal | null {
  if (!bm) return null;
  return {
    scope: "message-local",
    customer_questions: Array.isArray(bm.customer_questions) ? asStrArr(bm.customer_questions) : null,
    customer_concern: (bm.customer_concern as BrainMessageLocal["customer_concern"]) ?? null,
    condition_change_type: (bm.condition_change_type as string | null) ?? null,
    hesitancy_pattern: asHesitancy(bm.hesitancy_pattern),
    customer_intent: (bm.customer_intent as string | null) ?? null,
  };
}

/** brainMeta → conversation-scope。方針・禁止・RAG クエリ用。分類器には**渡せない**（型エラー） */
export function toBrainConversationScope(bm: RawBrainMeta | null | undefined): BrainConversationScope | null {
  if (!bm) return null;
  const st = bm.engagement_stance;
  return {
    scope: "conversation",
    repeated_concern: (bm.repeated_concern as string | null) ?? null,
    engagement_stance: st === "push" || st === "wait" ? st : null,
    avoid_topics: asStrArr(bm.avoid_topics),
    reply_direction: (bm.reply_direction as string | null) ?? null,
    latent_intent: (bm.latent_intent as string | null) ?? null,
    closing_strategy: (bm.closing_strategy as string | null) ?? null,
    winning_pattern: (bm.winning_pattern as string | null) ?? null,
    current_property: (bm.current_property as string | null) ?? null,
    future_timeline: (bm.future_timeline as string | null) ?? null,
    purchase_signal_level: (bm.purchase_signal_level as string | null) ?? null,
    checkpoint_stage: (bm.checkpoint_stage as string | null) ?? null,
  };
}

/** @deprecated 2026-09-10 Fable5: scope を区別しない旧型。BrainMessageLocal / BrainConversationScope に置換済み */
export type BrainLite = BrainMessageLocal | null | undefined;

/** fresh な **message-local** brain のみ補助証拠として合流させる。
 *  2026-09-10 Fable5 みく事例:
 *   ① residue が空（本文に実質ゼロ）の時は brain は STRONG_KIND を足せない。
 *      brain の抽出結果は「residue の中身」を説明する値であって、residue の不在を覆せない。
 *      旧ガードは isAckOnly のみで、待ち句を含む中間状態（residue="" / isAckOnly=false）が素通りしていた。
 *   ② concern は message-local な customer_concern のみ。しかも本文アンカー必須
 *      （customer_concern は鮮度リセット対象外＝差分分析で前回値が残りうる第2の誤爆経路）。
 *   ③ repeated_concern（conversation-scope）と customer_intent（定義が広い）は**加算条件から全廃**。 */
export function mergeBrainEvidence(v: SubstanceVerdict, brain: BrainMessageLocal | null | undefined, brainFresh: boolean): SubstanceVerdict {
  if (!brainFresh || !brain) return v;
  if (v.isPureBoilerplate) {
    return { ...v, evidence: [...v.evidence, `brain.skipped:pure_boilerplate:${v.isAckOnly ? "ack_only" : "wait_only"}`] };
  }
  const kinds = new Set(v.kinds); const evidence = [...v.evidence];
  if ((brain.customer_questions?.length ?? 0) > 0) { kinds.add("question"); evidence.push("brain.customer_questions"); }
  if (brain.condition_change_type && brain.condition_change_type !== "none") { kinds.add("condition"); evidence.push("brain.condition_change_type"); }
  const anchored = anchorBrainConcern(brain.customer_concern, v.normalized);
  if (anchored) { kinds.add("concern"); evidence.push(`brain.customer_concern:${anchored}`); }
  return { ...v, kinds: [...kinds], evidence, has: v.has || STRONG_KINDS.some((k) => kinds.has(k)) };
}

/** brain の懸念が本文に実在するか。topic/object のどちらかが本文に現れる時だけ採用する。
 *  「初期費用の支払い方法」のような長い topic は CUST_CONCERN_OBJECT_RE で対象語に縮約してから照合する。
 *  ※ CUST_CONCERN_OBJECT_RE は後段で定義（この関数は実行時にしか参照しないので TDZ にならない） */
export function anchorBrainConcern(
  cc: BrainMessageLocal["customer_concern"], normalized: string,
): string | null {
  for (const c of [cc?.object, cc?.topic]) {
    if (!c || Array.from(c).length < 2) continue;
    if (normalized.includes(c)) return c;
    const tok = c.match(CUST_CONCERN_OBJECT_RE)?.[0];
    if (tok && normalized.includes(tok)) return tok;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 3. 直前スタッフ発話の分類（StaffTurn）
// ─────────────────────────────────────────────────────────────
export type StaffTurnKind =
  | "viewing_invite" | "property_send" | "pickup_declared" | "estimate_send" | "question_to_customer"
  | "confirmation_promise" | "condition_ask" | "check_result" | "apply_push"
  /** 2026-09-11 統合設計（経路D/E2）: 断り・探索終了を受けてスタッフが扉を開けた締め文（「またお部屋探しの際は…この度はありがとうございました」） */
  | "farewell_ack"
  | "other";
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
/** 2026-09-11 統合設計（経路D）: スタッフの締め文（断り・探索終了を受けて扉を開けた）。classifyLastStaffTurn ②・resolveClosing・ANY_FAREWELL が同じ定数 */
export const STAFF_FAREWELL_RE = /またお(?:部屋探し|引越し|引っ越し)[^\n]{0,12}(?:際|機会)|この度はありがとうございました/;
/** 宣言（未来形）: ピックアップ…します／お送りさせて頂きます／出来次第。※ 実行の証拠にしない（「お部屋探し全力でサポート」の締め文は宣言に数えない）
 *  2026-09-10 Fable5 あみ事例: 13:24「新着でオススメできるお部屋出次第お送りさせていただきます」を取りこぼしていた
 *  （→ staff=other → ANY_WILL_SEND 誤選択）。「オススメできるお部屋…お送りします」「出次第お送り」を宣言に含める。
 *  ※ 過去形・成果物（DELIVERABLE_RE / STAFF_PROPERTIES_DONE_RE）は呼び出し側で先に判定されるので送付済みを宣言に誤判定しない */
export const STAFF_PICKUP_DECL_RE =
  /(?:ピックアップ|お探し|お部屋探し(?!全力))[^\n。]{0,40}?(?:させて(?:頂|いただ)きます|いたします|致します|します)|(?:ピックアップ|お探し)[^\n。]{0,12}(?:出来|でき)次第|(?:オススメ|おすすめ|お勧め)(?:(?:出来|でき)る|の)?[^\n。]{0,12}(?:お部屋|物件)[^\n。]{0,24}?(?:お送り|ご紹介|ご提案)[^\n。]{0,12}(?:させて(?:頂|いただ)きます|いたします|致します|します)|(?:新着|募集|出|見つかり)(?:が)?(?:出)?次第[^\n。]{0,20}(?:お送り|ご連絡|ご紹介)/;
/** 実行（過去形・成果物）。旧 STAFF_PROPERTY_SEND_RE から裸の「号室」「万円」を除外（「9万以内」「見積本文の号室」を送付と誤判定しない） */
export const STAFF_PROPERTIES_DONE_RE = /🌟|ご査収ください|お送り(?:させて(?:頂|いただ)き|いたし|致し|し)ました|送らせて(?:頂|いただ)きました|ピックアップ(?:させて(?:頂|いただ)き|いたし|致し|し)ました|見つかりませんでした|少ない状況でした/;
/** 未送付なのに「再度／改めて／追加で／別の物件」（検査 DONE_PRESUPPOSED_WITHOUT_EVIDENCE と同名） */
export const REDO_CLAIM_RE = /(?:再度|改めて|もう一度|追加で|(?:別|他)の(?:物件|お部屋)|新たな(?:物件|お部屋))[^\n。]{0,24}(?:ピックアップ|お探し|お送り|ご提案|ご紹介|お届け)/;
/** 裸の「号室」「万円」（台帳が送付実績を持つ時／台帳なし の時だけ送付扱い） */
const STAFF_BARE_PROPERTY_RE = /[0-9０-９]{2,4}号室|[0-9０-９.．]+万円/;
// ─── 2026-09-10 Fable5 Sさん事例: 「顧客に送られたメッセージ」と「社内の記帳行」を分ける ───
/** 顧客に実際に送られたメッセージの証拠であるソース。
 *  line_task は「社内タスクの完了記録」であって顧客への送信ではない（本文カラムを持たず、
 *  完了通知先は社内グループ）。直前スタッフ発言の根拠にしてはならない。
 *  action-ledger.ts が runtime import する（定義はこの1か所）。 */
export const LEDGER_OUTBOUND_SOURCES: ReadonlySet<string> = new Set(["aix_log", "staff_text", "aix_history"]);

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
  //    2026-09-10 Fable5 Sさん事例: 社内の記帳行（line_task）は「顧客に送られたメッセージ」ではないので
  //    ここで確定させない（①aix_usage_logs / ②本文 regex に進ませる）。⓪は台帳の single point of failure
  const le = opts.ledger?.facts.lastStaffEntry ?? null;
  if (le && LEDGER_OUTBOUND_SOURCES.has(le.source)) {
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
  // ② 本文の決定論。優先: 締め > 見積 > 内覧打診 > 申込打診 > 条件ヒアリング > 質問（末尾行） > 確認約束 > 【宣言】 > 【実行】
  //   （条件ヒアリングは「ご希望条件お聞かせください」の疑問形を含むため質問より先に判定する）
  if (text) {
    // 2026-09-11 統合設計（経路D/E2・うえっち事例）: 締め文を最初に判定。旧実装は締め文が regex に当たらず③の7日前 AIX 履歴で check_result になっていた
    const fw = text.match(STAFF_FAREWELL_RE);
    if (fw) return { kind: "farewell_ack", source: "regex", evidence: fw[0] };
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
  // ③ 本文も時刻も無い時だけ → brain の last_aix_history「最新:xxx」。台帳が「送付0件」の時は property_send を採らない（前日 AIX の誤帰属防止）
  //   2026-09-11 統合設計（経路E2）: 旧実装は本文があって regex が外れた時にも時刻制限なしで発火し、7日前の AIX 種別を直前発言として確定させていた
  //   （台帳④「aix 行もスタッフ本文も無い時だけ」と非対称）。本文があれば other に落とす
  const m = !text && !Number.isFinite(at) ? /最新:([a-z_]+)/.exec(opts.lastAixHistory ?? "") : null;
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
export type CustomerResponseSource = "regex" | "flag" | "brain";
type CustomerResponseBase = {
  secondary: CustomerResponseKind[];
  evidence: string;
  source: CustomerResponseSource;
  /** 2026-09-10 Fable5 Sさん事例: 前向き反応の下位種別。kind!=="positive" の時は null。
   *  生成 direction・検査 mustInclude・tpo_debug・学習が同じ verdict を参照する（四者同名） */
  positive: PositiveVerdict | null;
  /** 2026-09-11 統合設計（経路C）: 質問の形。request=我々の行動を求める依頼形（行動宣言が回答）／info=事実を尋ねる。質問でない時は null */
  questionForm?: QuestionForm | null;
};
/** 2026-09-10 Fable5: concern だけ object を **非 null 必須**にする。
 *  「懸念（）」と空括弧でレンダリングされる状態＝懸念の対象が本文に存在しない状態を、型として作れなくする */
export type CustomerResponse =
  | (CustomerResponseBase & { kind: "concern"; object: string })
  | (CustomerResponseBase & { kind: Exclude<CustomerResponseKind, "concern">; object: string | null });
export type CustomerResponseFlags = {
  isThinkingMsg?: boolean; isTemporaryLeaveMsg?: boolean;
  isConditionChangeRequest?: boolean; isConditionPresented?: boolean;
  negativeKind?: "withdrawal" | "staff_report" | null;
  /** fresh の message-local のみ。conversation-scope は型として渡せない */
  brain?: BrainMessageLocal | null;
};
const PRIORITY: CustomerResponseKind[] = ["decline", "condition_change", "question", "concern", "will_send_later", "thinking", "positive", "answer", "ack_only", "other"];
const CUST_DECLINE_RE = /見送(?:らせて|ります|りたい|ろうと)|やめ(?:て|とき|とこ)|遠慮(?:し|させ)|今回は(?:結構|大丈夫|やめ|見送|なし)|お断り|他で(?:決め|契約)|キャンセル(?:で|し|お願い)/;
// ─── 2026-09-11 統合設計（経路D）: 断りの語彙を一本化（旧 route.ts negativeDetail の WITHDRAWAL_SRC を移設）───
//   route.ts negativeDetail・classifyCustomerResponse（route のフラグが無い check-reply 経路）・resolveClosing が同じ定数を参照する
export const CUST_WITHDRAWAL_SRC = [
  "お?断り(?:ました|させて(?:頂|いただ)|をいただ|します|したい|いたします)",
  "キャンセル(?:で|を|に|させて|し|の)?.{0,10}(?:したい|します|しました|になり|お願い|ください|いただ|頂|たいです)",
  "見送(?:り|ら)(?:たい|ます|せて|になり)",
  "辞退(?:したい|します|しました|させて|いたします)",
  "白紙(?:に戻|になり)",
  "(?:他社|他の(?:会社|仲介|業者|不動産)|別の(?:会社|仲介|業者|不動産)|他のところ|別のところ|知人|友人|親戚|自分)(?:で|に|の紹介で|さん.{0,6}で?)(?:契約|申込|決め|決まり|見つけ)",
  "(?:他|別)の(?:物件|お部屋)(?:で|に)(?:決め|決まり|契約|申込)",
  "やめ(?:とき|てお|ておき|ることにし|ようと思い)?ます",
  "やめ(?:ました|ることに)",
  // G10（2026-09-08 Fable5）: 退去・解約・引越しは対象名詞を必須にする（顧客の現住居の退去・引越し動機は離脱ではなく入居時期情報）
  "(?:お?申(?:し)?込(?:み)?|ご?契約|内覧|内見|予約|審査)(?:の|を|は|も)?\\s*(?:解約|取り下げ|取りやめ|取り消し|やめ|なし)(?:で|を|に|したい|します|お願い|させて|ください|になり)?",
  "(?:そちら|その|この|こちらの|ご?提案(?:いただい|頂い)た|送って(?:もらった|いただいた|頂いた))(?:の)?(?:物件|お?部屋)(?:は|を|も|の)?[^\\n。]{0,10}?(?:辞退|やめ|見送|なし|キャンセル|結構です|大丈夫です)",
  "引っ?越し先(?:が|は|も)?(?:決ま|見つか)",
  "(?:お?部屋探し|物件探し|お?家探し|引っ?越し|転居)(?:自体|の話|の件|は|を|が|も)?\\s*(?:なくな|無くな|中止|白紙|取りやめ|取り止め|やめ|辞め|見送|延期)",
  "お世話になりました",
  "諦め(?:ます|ました|ようと)",
  "(?:今回は|一旦)(?:見送|なしで|遠慮|保留に)",
  "破談",
  // 内覧・来店に行けなくなった（別日提案が無ければ内覧キャンセル。提案付きは route の isReschedule が先に除外）
  "(?:行け|伺え|来れ|行くことができ|行く事ができ|行くことが出来|行く事が出来)なく(?:なり|なっ)",
].join("|");
export const CUST_WITHDRAWAL_RE = new RegExp(CUST_WITHDRAWAL_SRC);
/** 断り語と同居していても「日程変更・再開・依頼」なら断りではない（route isReschedule / 再開語と同趣旨の簡易版。フラグの無い経路のみで使う） */
const CUST_NOT_WITHDRAWAL_RE = /別日|別の日|改めて|リスケ|日程|延期|また探し|再開|新し(?:い|く)条件|[?？]/;
/** 顧客自身が会話を締めるお礼（お世話になりました／今までありがとう／ご縁が無かった） */
const CUST_FAREWELL_SELF_RE = /お世話になりました|今までありがとう|今まで有難う|ご縁が(?:なかった|無かった)/;

// ─── 2026-09-11 統合設計（経路C）: 「回答している」の単一定義（final-check ①④⑦・質問セルの detect・修正プロンプトが同じ関数）───
//   語彙は人の実送信 n=519 の回答文から採る。絵文字の後置は一致に影響しない（語尾の句読点を要求しない）。
const ANSWER_FORM_SRC =
  "(?:と|に)なります|となっております|でございます|(?:ございます|御座います)|(?:ございません|御座いません)|おります|おりません|でした" +
  "|予定(?:して|で|と|です)|程度|程(?:です|となり|で)|くらい(?:です|となり)|大丈夫です|可能(?:です|となり|でございます)" +
  "|かかります|かかりません|(?:出来|でき)ます|出来かねます|(?:頂|いただ)けます|流れ(?:です|となり|になり|で)|形(?:です|となり)|と思われます|(?:の|な)ため|ので";
export const ANSWER_FORM_RE = new RegExp(ANSWER_FORM_SRC, "u");
/** 提案形（回答ではないが「回答／提案」として骨格を満たす）。REPLY_SKELETON ① の補助 */
export const PROPOSAL_FORM_RE = /オススメ|おすすめ|お勧め|ご提案|傾向|一般的に|目安/;
/** 回答判定の前に剥がす定型句（「ありがとうございます」の「ございます」で回答扱いにしない） */
const ANSWER_BOILERPLATE_RE = /ありがとう(?:ございま(?:す|した)|御座います)|お世話になっております|お待ちしております|(?:何卒)?(?:よろしく|宜しく)お願い(?:いた|致)?します/g;
/** 対象語の無い先送り（「確認出来次第改めてご連絡」だけ）は回答に数えない */
const DEFERRAL_ONLY_RE = /(?:改めて|確認(?:出来|でき)次第|分かり次第|わかり次第)[^\n。！!]{0,12}ご連絡/;
export const CONFIRM_DECL_WITH_OBJECT_RE = /([^\n。！!、]{2,24}?)(?:を|について(?:は)?)?(?:管理会社(?:様)?に)?確認させて(?:頂|いただ)き/;

export type QuestionForm = "request" | "info";
export type AnswerVerdict = { yes: boolean; form: "answer" | "request_decl" | "confirm_decl" | null; evidence: string };

export function hasDirectAnswer(text: string, questionForm: QuestionForm | null | undefined): AnswerVerdict {
  const body = (text ?? "").replace(ANSWER_BOILERPLATE_RE, "");
  const sentences = body.split(/(?<=[。！!？?\n])/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    // 対象なしの先送りは回答ではない（「確認出来次第改めてご連絡させて頂きます」だけの返信の正しい検出を残す）
    if (DEFERRAL_ONLY_RE.test(s) && !ANSWER_FORM_RE.test(s.replace(DEFERRAL_ONLY_RE, ""))) continue;
    if (ANSWER_FORM_RE.test(s)) return { yes: true, form: "answer", evidence: s.slice(0, 40) };
  }
  if (questionForm === "request") {
    // 2026-09-11 竹内方針1: 対象の無い先送り（「確認出来次第改めてご連絡させて頂きます」）だけの文は依頼への回答に数えない
    const declRe = new RegExp(`[^\\n。！!]{0,40}${DECL_TAIL}`);
    const deferralDeclRe = new RegExp(`${DEFERRAL_ONLY_RE.source}[^\\n。！!]{0,6}${DECL_TAIL}`);
    for (const s of sentences) {
      if (DEFERRAL_ONLY_RE.test(s) && !declRe.test(s.replace(deferralDeclRe, ""))) continue;
      const d = s.match(declRe);
      if (d) return { yes: true, form: "request_decl", evidence: d[0].slice(-40) };
    }
  }
  const c = body.match(CONFIRM_DECL_WITH_OBJECT_RE);
  if (c && c[1].replace(/[\s、]/g, "").length >= 2) return { yes: true, form: "confirm_decl", evidence: c[0].slice(-40) };
  return { yes: false, form: null, evidence: "" };
}

/** 依頼形の質問（我々の行動を求める）: 慶次「北区、福島区ではやはりいい条件の物件はないですか？」 */
// 2026-09-11 竹内方針1（§3.2・E1-c）: 有無（「〜ありますか」「他は無さそう」）・費用（「初期費用いくら」「安くできる」）も依頼形。
//   スタッフはこれらに「かしこまりました！！」＋ピックアップ宣言／御見積書作成の宣言で答える（費用質問74件中42件が見積宣言型・金額回答は5件）
const CUST_REQUEST_QUESTION_RE =
  /(?:探して|出して|作って|送って|調べて|確認して|交渉して)(?:頂|いただ|もら|くれ)[^\n？?]{0,8}か|(?:物件|お部屋|部屋|見積|割引|交渉)[^\n？?]{0,16}(?:(?:可能|できます|出来ます)(?:でしょう)?か|(?:ない|あります|ございます)(?:です|でしょう)?か)|(?:で|は|って|とか)?(?:あります|ない|無い|なさそう|無さそう)(?:です|でしょう)?か|他は|ほかは|初期費用[^\n]{0,8}(?:いくら|教え)|見積(?:もり)?[^\n]{0,6}(?:出|頂|いただ)|安く(?:でき|なり)|抑え(?:られ|る)(?:こと)?(?:は)?(?:でき|可能)/;
export function classifyQuestionForm(normalized: string): QuestionForm {
  return CUST_REQUEST_QUESTION_RE.test(normalized ?? "") ? "request" : "info";
}
const CUST_QUESTION_RE = /[?？]|(?:ます|です|でしょう|ません)か(?:ね|ねぇ)?(?:[。！!、]|$)|いくら(?!でも)|いつ(?:頃|ごろ|まで|から|に)|可能でしょうか|教えて(?:ください|頂け|いただけ|もらえ)/;
const CUST_CONCERN_OBJECT_RE = /[0-9０-９]+階|階段|エレベーター|お風呂|浴室|浴槽|家賃|初期費用|礼金|敷金|審査|保証会社|駅(?:から|まで)?(?:遠|距離|徒歩)|築(?:年|古)|日当たり|広さ|間取り|駐車場|周辺|治安|騒音|新生児|赤ちゃん|子供|お子|ペット|外観|内装/;
// ─── 2026-09-10 Fable5 あみ事例: 「顧客が自分で送る」(A) と「我々に送ってほしい」(B) を分離する ───
// 旧 CUST_WILL_SEND_RE は `気になる.{0,24}お送り` を含み「気になる物件あればお送りください」(B) にも一致していた。
// (B) は 203件・(A) は 28件で語彙が完全に別（随時ピックアップ: B 9件 / A 0件、募集状況確認: A 21% / B 1.5%）。
/** (B) 顧客が「我々に送って」と依頼する形。will_send_later からは必ず除外する */
export const CUST_ASKS_US_TO_SEND_RE =
  /(?:お送り|送って|共有して|見せて|教えて)(?:ください|下さい|頂け|いただけ|もらえ|くれ|欲しい|ほしい|お願い)/;
/** (A) 顧客が「自分が送る」と予告する形（一人称の授受表現のみ。成約データ n=9 全件に一致） */
const CUST_WILL_SEND_RE =
  /送らせて(?:頂|いただ|もら)|お送りさせて(?:頂|いただ)|(?:送|共有)りま?す(?:ね|ので|よ)?|送ります|送っても(?:いい|良い|大丈夫|宜しい|よろしい)|お送りしても(?:いい|良い|大丈夫)|共有(?:させて(?:頂|いただ)|します)|送らせてください/;
/** 顧客が「送っていいですか」と許可を求めた（受け口「いつでもお送りください」を返す条件。成約 2/9 はこの形） */
export const CUST_SEND_PERMISSION_RE =
  /送っても(?:いい|良い|大丈夫|宜しい|よろしい)|送らせて(?:もらっ|頂い|いただい)ても(?:いい|良い|大丈夫)|送らせてください|送っていい|送らせて(?:もらって|頂いて|いただいて)(?:いい|良い|大丈夫)/;

/** 予告された物の種類。要素④の中身と見積予告の要否を決める唯一の分岐軸（state 非依存） */
export type WillSendObject = "property" | "condition" | "document" | "unknown";
const WS_DOCUMENT_RE = /書類|身分証|免許|保険証|通帳|源泉|在籍|申込書|住民票|印鑑証明/;
const WS_PROPERTY_RE = /物件|お?部屋|マンション|ハイツ|コーポ|レジデンス|号室|スクショ|スクリーンショット|写真|画像|URL|リンク|スーモ|suumo|ホームズ|候補|間取り図/i;
const WS_CONDITION_RE = /条件|ご希望|希望条件|エリア|家賃|予算|要望/;
export function classifyWillSendObject(customerText: string): WillSendObject {
  const t = normalizeCustomerText(customerText);
  const line = t.split("\n").map((s) => s.trim()).filter(Boolean).find((p) => CUST_WILL_SEND_RE.test(p)) ?? t;
  if (WS_DOCUMENT_RE.test(line)) return "document";
  if (WS_PROPERTY_RE.test(line)) return "property";
  if (WS_CONDITION_RE.test(line)) return "condition";
  return "unknown"; // 既定は物件フロー（成約 n=9 中 8件が物件）
}

/** (A) 持込予告か（(B)依頼形は除外）。route.ts の estimate 入力・final-check E5 フォールバックが同一判定を使う */
export function CUST_WILL_SEND_SELF_PRED(text: string): { yes: boolean; evidence: string | null } {
  const t = normalizeCustomerText(text);
  const line = t.split("\n").map((s) => s.trim()).filter(Boolean)
    .find((p) => CUST_WILL_SEND_RE.test(p) && !CUST_ASKS_US_TO_SEND_RE.test(p));
  return { yes: !!line, evidence: line ? line.slice(0, 40) : null };
}
const CUST_CALLBACK_RE = /(?:後ほど|あとで|また|改めて|後日|次回|確認して|見てから).{0,16}?(?:ご?連絡|返信|お返事)(?:させて|いたし|します|致し)/;
const CUST_THINKING_RE = /検討(?:します|させて|いたします|致します|中|してみ)|考え(?:ます|てみ|させて|中)|相談(?:して|し|させて)|持ち帰|決めかね|決められ(?:ない|ず|ません)|時間を(?:ください|下さい|頂|いただ)|迷います|迷い|どうなのかな|どうかな/;
// ─────────────────────────────────────────────────────────────
// 2026-09-10 Fable5 Sさん事例: 前向き反応（positive）の3層。
//  T1 appraisal        = 我々が送った物件・見積への評価。単独では前向きにしない（要 staff=資料送付系）
//  T2 viewing_explicit = 内見意思の明示（単独で最強・成約プール n=169・最頻）
//  T3 named_only       = 物件名のみの短文（n=868 と最大だが誤検出源）。台帳の送付済み物件名と
//                        一致した時だけ appraisal 相当に昇格させる
// 「気になります」＝「内見したいの婉曲表現」は 2026-09-09 の業務フローギャップ分析で
// hidden business rule として特定済み・未実装だったもの。ここで初めて実装する。
// ─────────────────────────────────────────────────────────────
export type PositiveKind = "viewing_explicit" | "appraisal";
export type PositiveVerdict = {
  kind: PositiveKind;
  /** 発火した実テキスト（tpo_debug / direction の {positiveEvidence}） */
  evidence: string;
  /** 昇格経路（regex / ledger_named） */
  source: "regex" | "ledger_named";
};

/** T2: 内見意思の明示（成約プール n=169 / ★56）。単独で positive 確定・question より上位。
 *  成約実文「条件など含め好条件で気になるのですが内見などはできますか？？」を取るため 6字までの介在を許す */
export const CUST_VIEWING_INTENT_RE =
  /(?:内見|内覧|見学|下見)[^\n]{0,6}?(?:し?たい|希望|お願い|(?:出来|でき)(?:ます|る|れ|ば)?|可能|させて(?:頂|いただ)き)|見てみたい|見たいです|拝見したい|オンライン(?:内覧|内見)|見に行き/;

/** T1: 我々が送った物件・見積への評価（成約プール 気になる88 / 良さそう26 / いい感じ27 / 興味17 / これがいい11 / 一番7 / あり3）。
 *  ⚠ 単独では positive にしない。直前スタッフ発言が資料送付系（MATERIALS_SENT_STAFF_KINDS）の時だけ発火する。
 *  ⚠ CONCERN_HEDGE_RE にも「気になっ?(?:て|ちゃ|ります)」があるが、あちらは concerns[] が立っている時だけ
 *     有効（CONCERN_RULES の topicRe を要求）。物件名に topicRe は当たらないので競合しない。 */
export const CUST_POSITIVE_APPRAISAL_RE =
  /気になり(?:ます|まし)|気になる(?:物件|お部屋)|気に入(?:り|っ|ら)|良さそう|よさそう|いいですね|良いですね|いい感じ|良い感じ|素敵|すてき|好み(?:です|かも)|好きです|興味(?:が)?(?:あり|湧)|(?:これ|こちら|ここ|それ|そちら)(?:が|に)(?:いい|良い|しま|決め)|(?:一番|1番|特に)[^\n]{0,8}(?:気に|良|いい|好み)|あり(?:だと|かな)です?/;

/** T3: 物件名のみの短文（3〜24字・記号のみ）。台帳の送付済み物件名と一致した時だけ採る */
const CUST_NAME_ONLY_RE = /^[ぁ-んァ-ヶ一-龥A-Za-zＡ-Ｚａ-ｚ0-9０-９・ー\s]{3,24}[!！]*$/;

/** 弱シグナル（単独では前向き扱いしない。実装では採らない＝記録・将来分析用） */
export const CUST_POSITIVE_WEAK_RE = /検討(?:し)?たい|前向きに|候補に(?:入れ|し)|候補として/;

/** T1 が「我々が送ったものへの評価」になる直前スタッフ種別 */
export const MATERIALS_SENT_STAFF_KINDS: ReadonlySet<StaffTurnKind> =
  new Set<StaffTurnKind>(["property_send", "estimate_send", "check_result", "viewing_invite"]);

/** 物件名の照合キー。号室を落とした core と、先頭のブランド名ブロック（カナ/英字3字以上）の両方を返す。
 *  実データ: 我々が「アーバネックス谷町四丁目1102号室」を送り、顧客は「アーバネックス」とだけ書く */
export function propertyMatchKeys(name: string): string[] {
  const core = (name ?? "").replace(/\s*[0-9０-９]{1,4}\s*号室\s*$/, "").replace(/\s+/g, "").trim();
  const keys = new Set<string>();
  if (Array.from(core).length >= 3) keys.add(core);
  const head = core.match(/^[ァ-ヶーA-Za-zＡ-Ｚａ-ｚ]{3,}/)?.[0];
  if (head && Array.from(head).length >= 3) keys.add(head);
  return [...keys];
}

/** 前向き反応の判定（生成 direction・検査 mustInclude・tpo_debug・学習が同じ verdict を参照） */
export function resolvePositive(
  sub: SubstanceVerdict,
  staff: StaffTurn,
  ledger: ActionLedger | null,
): PositiveVerdict | null {
  const raw = sub.normalized;
  const lines = raw.split("\n").map((s) => s.trim()).filter(Boolean);
  const v = lines.find((p) => CUST_VIEWING_INTENT_RE.test(p));
  if (v) return { kind: "viewing_explicit", evidence: v.slice(0, 40), source: "regex" };
  if (!MATERIALS_SENT_STAFF_KINDS.has(staff.kind)) return null;   // ← T1 の必須ゲート
  const a = lines.find((p) => CUST_POSITIVE_APPRAISAL_RE.test(p));
  if (a) return { kind: "appraisal", evidence: a.slice(0, 40), source: "regex" };
  // T3: 「アーバネックス」等の物件名のみ。台帳の送付済み物件名と一致する時だけ（誤検出源なので単独では採らない）
  const sentNames = ledger?.facts.propertiesSentNames ?? [];
  const named = lines.find((p) => CUST_NAME_ONLY_RE.test(p) &&
    sentNames.some((n) => propertyMatchKeys(n).some((k) => p.includes(k))));
  if (named) return { kind: "appraisal", evidence: named.slice(0, 40), source: "ledger_named" };
  return null;
}

/** @deprecated 2026-09-10 Fable5: 旧 CUST_POSITIVE_RE は「気になる」を1語も知らなかった。
 *  判定は resolvePositive（下位種別＋staff ゲート付き）が行う。この定数は互換のための語彙合成のみ */
export const CUST_POSITIVE_RE = new RegExp(
  `${CUST_VIEWING_INTENT_RE.source}|${CUST_POSITIVE_APPRAISAL_RE.source}` +
  `|ぜひ|是非|進めて|申(?:し)?込(?:み)?(?:たい|します|お願い|で)|大丈夫だと思います|問題ない`,
);
/** 条件の宣言形（間取り・家賃上限・エリア＋探す/お願い）。語の出現（「駅で待ち合わせ」の「駅」）では発火しない */
// 2026-09-09 行動台帳（みく 11:45）: エリア限定「大阪の市内付近でお願いします」・NG 追加「京都・尼崎はNGで」も条件の宣言形
const CUST_CONDITION_STATEMENT_RE = /[1-4１-４](?:LDK|DK|K|R)|ワンルーム|[0-9０-９.．]+万(?:円)?(?:以内|以下|まで|台|くらい|位|前後|程度)|(?:家賃|予算|間取り|条件|エリア|築|徒歩)[^\n]{0,20}(?:で|は|を|に)[^\n]{0,12}(?:探|お願い|希望|変|広げ|絞|追加|変更|お伝え)|(?:周辺(?:全域)?|市内|市外|区内|付近|沿線)(?:で|から|に)[^\n]{0,20}(?:探|お願い|希望|絞|限定)|(?:は|が)NG(?:で|です)|(?:は|が)?(?:なし|無し|除外|以外)で(?:お願い|希望)/;

export function classifyCustomerResponse(
  sub: SubstanceVerdict, staff: StaffTurn,
  flags: CustomerResponseFlags & { ledger?: ActionLedger | null } = {},
): CustomerResponse {
  const raw = sub.normalized;
  const lines = raw.split("\n").map((s) => s.trim()).filter(Boolean);
  const found = new Map<CustomerResponseKind, string>();
  const put = (k: CustomerResponseKind, ev: string) => { if (!found.has(k)) found.set(k, ev); };
  if (sub.isAckOnly) {
    return { kind: "ack_only", secondary: [], object: null, evidence: raw.slice(0, 30), source: "regex", positive: null };
  }
  // 2026-09-10 Fable5 Sさん事例: 前向き反応の下位種別（T1 評価語は直前が資料送付系の時だけ／T2 内見明示は無条件）
  const positive = resolvePositive(sub, staff, flags.ledger ?? null);
  // ① 上位フラグ（route.ts 計算済み。同名述語を二重実装しない）
  if (flags.negativeKind === "withdrawal") put("decline", "flag:withdrawal");
  if (flags.isConditionChangeRequest || flags.isConditionPresented) put("condition_change", flags.isConditionPresented ? "flag:isConditionPresented" : "flag:isConditionChangeRequest");
  // ② 行ごとの決定論。「感謝1行＋懸念1行」は最も強い1行で決める（末尾優先／先頭優先を両方避ける）
  for (const p of lines) {
    if (PURE_ACK_SENT_RE.test(p)) { put("ack_only", p); continue; }
    if (CUST_DECLINE_RE.test(p)) put("decline", p);
    // 2026-09-11 統合設計（経路D）: route のフラグ（negativeKind）が無い経路（check-reply / final-check 再計算）でも
    //   断り語彙（CUST_WITHDRAWAL_RE＝route と同一定数）で decline を立てる。フラグがある経路は route の判定（リスケ除外等）を尊重する
    else if (flags.negativeKind === undefined && CUST_WITHDRAWAL_RE.test(p) && !CUST_NOT_WITHDRAWAL_RE.test(p)) put("decline", p);
    if (CUST_QUESTION_RE.test(p)) put("question", p);
    if (sub.concerns.length > 0 && (CONCERN_HEDGE_RE.test(p) || sub.concerns.some((c) => p.includes(c.phrase)))) put("concern", p);
    // (B)「あればお送りください」は我々への依頼であって持込予告ではない
    if (CUST_WILL_SEND_RE.test(p) && !CUST_ASKS_US_TO_SEND_RE.test(p)) put("will_send_later", p);
    // 2026-09-10 Fable5: 待ち句は analyzeSubstance と同じ語彙で判定する。CUST_THINKING_RE には
    //   「確認／拝見／チェック／見ます」が1語も無く、WAIT_PHRASE_SRC・CUSTOMER_KAKUNIN_SIGNAL_RE とだけ乖離していた
    if (CUST_THINKING_RE.test(p) || CUST_CALLBACK_RE.test(p) || WAIT_PHRASE_RE.test(p) || flags.isThinkingMsg) put("thinking", p);
  }
  if (positive) put("positive", `${positive.kind}:${positive.evidence}`);
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
    // ④-a 懸念は message-local な customer_concern のみ。かつ本文アンカー必須。
    //     repeated_concern（会話全体で2回以上のテーマ）と customer_intent==="negative"（定義=懸念・不安）は加算条件から全廃
    const anchoredConcern = anchorBrainConcern(b.customer_concern, raw);
    if (!found.has("concern") && anchoredConcern) put("concern", `brain:customer_concern=${anchoredConcern}`);
    if (!found.has("question") && (b.customer_questions?.length ?? 0) > 0) put("question", `brain:customer_questions[${b.customer_questions!.length}]`);
    if (!found.has("condition_change") && b.condition_change_type && b.condition_change_type !== "none") put("condition_change", `brain:condition_change_type=${b.condition_change_type}`);
    // ④-b 旧実装の `b.hesitancy_pattern === "concern"` は HESITANCY_PATTERNS に存在しない値で**永久に false**（死んだ条件）。
    //     正しい値 thinking / callback / undecided は一切使われていなかった。thinking 側に合流させる
    if (!found.has("thinking") && (b.hesitancy_pattern === "thinking" || b.hesitancy_pattern === "callback" || b.hesitancy_pattern === "undecided")) {
      put("thinking", `brain:hesitancy_pattern=${b.hesitancy_pattern}`);
    }
  }
  // ⑤ 「迷います」「どうかな」は対象語（階・お風呂・家賃…）があれば concern、無ければ thinking
  //   2026-09-10 Fable5: 安全網を「thinking が同時に立っていること」から切り離す
  //   （旧実装は found.has("thinking") を発火条件にしていたため、thinking が立たない brain 単独誤爆を落とせなかった）
  const concernObject: string | null = raw.match(CUST_CONCERN_OBJECT_RE)?.[0] ?? sub.concerns[0]?.phrase ?? null;
  if (found.has("concern") && !concernObject) found.delete("concern");        // 対象語ゼロの懸念は成立しない
  if (found.has("concern") && sub.concerns.length > 0) found.delete("thinking"); // 対象付きの迷いは懸念が主
  // ⑤' 2026-09-10 Fable5: 「送っていいですか」は回答を要する質問ではなく持込予告（正解は受け口＋業務フロー宣言）。
  //    他に本物の質問行が無い時だけ question を落とす（「送っていいですか？あと初期費用はいくら？」は question を残す）
  if (found.has("question") && found.has("will_send_later") && CUST_SEND_PERMISSION_RE.test(raw)
    && !lines.some((p) => CUST_QUESTION_RE.test(p) && !CUST_SEND_PERMISSION_RE.test(p))) found.delete("question");
  // ⑥ 一時保留（出先なので後で見ます）は「後で送る予告」ではない
  if (flags.isTemporaryLeaveMsg && !found.has("will_send_later") && !found.has("concern") && !found.has("question")) put("other", "flag:isTemporaryLeaveMsg");

  // ack_only は残余がある時は主分類にしない（「ありがとう＋702号室お願いします」は了承ではない）
  let ordered = PRIORITY.filter((k) => found.has(k) && k !== "ack_only");
  // ⑦ 2026-09-10 Fable5 Sさん事例: 内見意思の明示は疑問形でも「質問」ではなく「内覧受付」。
  //    成約実文「条件など含め好条件で気になるのですが内見などはできますか？？」
  //      →「はい！！〇〇さんご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！」（回答文ではなく提案）
  //    PRIORITY 自体は動かさない（decline / condition_change / concern には負けたままにする）
  if (positive?.kind === "viewing_explicit" && found.has("positive")
      && !found.has("decline") && !found.has("concern") && !found.has("condition_change")) {
    ordered = ["positive", ...ordered.filter((k) => k !== "positive")];
  }
  const primary: CustomerResponseKind =
    ordered[0] ?? (sub.residueLen >= 2 ? "other" : sub.waitSignal.yes ? "thinking" : "ack_only");
  const secondary = ordered.slice(1);
  const ev = found.get(primary) ?? "";
  const source: CustomerResponseSource = ev.startsWith("brain:") ? "brain" : ev.startsWith("flag:") ? "flag" : "regex";
  const positiveOut = primary === "positive" || secondary.includes("positive") ? positive : null;
  // 2026-09-11 統合設計（経路C）: 質問の形（依頼形なら行動宣言が回答）。質問を含まない時は null
  const questionForm: QuestionForm | null = primary === "question" || secondary.includes("question") ? classifyQuestionForm(raw) : null;
  if (primary === "concern") {
    // 型上 object: string が必須＝上の ⑤ で保証済み（non-null assertion は仕様の表明）
    return { kind: "concern", object: concernObject!, secondary, evidence: ev, source, positive: positiveOut, questionForm };
  }
  return { kind: primary, secondary, object: concernObject, evidence: ev, source, positive: positiveOut, questionForm };
}

// ─────────────────────────────────────────────────────────────
// 5. PAIR_MATRIX（staff × customer → 方向指示・必須要素・禁止・成約実例）
// ─────────────────────────────────────────────────────────────
export type PairPrecedence = "override_wait" | "after_wait";
/** 締めの種別（2026-09-09 Fable5 みく事例）。resolveCloser / CLOSER_TEXT / PAIR_MATRIX.closer / final-check runCloserChecks / stance_draft が同名 */
export type CloserKind = "commit_until_found" | "receive_check" | "open_door" | "wait_softly" | "await_contact" | "none";

// ─── 2026-09-10 Fable5: 持込予告の業務フロー語（生成 direction・検査 mustInclude・few-shot・修正 fix が同一定数を参照）───
// 「送られてきたら募集状況確認＋最大限割引した初期費用の御見積書」は、直前に我々が何をしたか（state）に関係なく同一。
// 分岐軸は sendObject（顧客が何を送ると予告したか）だけ。
/** ④-a 送られた物件の募集状況（空室状況）を確認する宣言。成約 6/9・「募集状況を確認させて頂きます」n=75 */
export const WILL_SEND_RECEIVE_CHECK_RE =
  /(?:募集状況|空室状況|空き状況|募集状況等)[^\n。！!]{0,8}(?:を|の)?確認(?:させて(?:頂|いただ)き|いたし|致し|し)/;
/** ④-b 最大限割引した初期費用の御見積書の「予告」。まだ物件は届いていない（見積本体ではない）。「最大限割引した見積」n=352 */
export const WILL_SEND_ESTIMATE_FORECAST_RE =
  /(?:最大限|最大)割引[^\n。！!]{0,24}(?:御|お)?見積|(?:御|お)?見積(?:書|り|もり)?[^\n。！!]{0,24}(?:お送り|ご連絡|あわせて|併せて|ご用意|作成)/;
/** ④-c 予告の対象が「条件」の時の探索宣言（成約 [9]） */
export const WILL_SEND_CONDITION_SEARCH_RE =
  /(?:条件に合(?:った|う)|ご条件(?:で|に沿|に合))[^\n。！!]{0,20}(?:お部屋|物件)[^\n。！!]{0,16}(?:探さ|お探し|ピックアップ)/;
/** ③ 受け口（顧客が「送っていいですか」と許可を求めた時のみ）。「いつでも送ってください」n=4 */
export const WILL_SEND_ACCEPT_RE =
  /(?:いつでも|ございましたら|見つかりましたら|出てきましたら)[^\n。！!]{0,16}(?:お送りください|お送り(?:頂|いただ)け|送ってください)/;
/** 予告文脈で物件フロー（募集状況確認＋見積予告）を要求する条件 */
export const isPropertyForecast = (p: PairContext): boolean => p.sendObject === "property" || p.sendObject === "unknown";

// ─────────────────────────────────────────────────────────────
// 内覧のご案内提案（2026-09-10 Fable5 Sさん事例）
//  [Y] 「〜ご都合よろしいお日にちにご案内させて頂きます」 n=443
//      具体日時あり 40/443(9%) / 条件節あり 414/443(93%) / aix=viewing_invite わずか2
//      → 日時を出さない意思表明。**通常返信（brain不在T3含む）で可**。竹内の指摘の正解形。
//  [X] 「〜ご都合よろしいお日にち御座いますでしょうか」 n=51
//      具体日時あり 49/51(96%) / aix=viewing_invite 47/51
//      → 候補日時提示の直後の確認疑問文。**AIX【内覧日調整】専用。通常返信で書かせてはならない**。
//  表層文字列が同じでも、疑問形か宣言形か・条件節の有無・具体日時の同伴で業務上の意味と権限が反転する。
//  禁止と許可を同じ語で管理すると必ずどちらかを潰すので regex レベルで分離する。
// ─────────────────────────────────────────────────────────────
/** [Y] 通常返信で許可される内覧のご案内提案（条件節付き・日時を出さない） */
export const VIEWING_OFFER_SOFT_RE =
  /(?:よろしければ|宜しければ|お気に召され(?:ましたら|た)|お気に召し(?:ましたら)|ご希望(?:で)?(?:あれば|ございましたら|御座いましたら))[^\n]{0,48}?(?:ご案内|ご内覧|ご覧)(?:させて(?:頂|いただ)き|いたし|致し)ます/;
/** [X] AIX【内覧日調整】専用。通常返信では block（final-check VIEWING_DATE_ASK_WITHOUT_AIX） */
export const VIEWING_DATE_ASK_RE =
  /ご都合(?:の)?よろしい(?:お日にち|日)[^\n]{0,16}(?:御座います|ございます|ありますでしょうか|でしょうか)/;
/** 条件節なしの裸型（正解 14/443＝7%・禁止形）。JS の可変長 lookbehind は部分一致で回避されるため、
 *  条件節の有無は VIEWING_OFFER_SOFT_RE との併用（isBareViewingOffer）で判定する */
export const VIEWING_OFFER_BARE_RE = /[^\n]{0,8}さんご都合(?:の)?よろしいお日にちに/;
export function isBareViewingOffer(text: string): boolean {
  return VIEWING_OFFER_BARE_RE.test(text ?? "") && !VIEWING_OFFER_SOFT_RE.test(text ?? "");
}

/** [Y] の実文型リテラル（創作禁止・この2つから選ぶ）。
 *  条件節の選択規則（実測 お気に召されましたら≈250x / よろしければ 51件=全体1%）:
 *   顧客が特定物件を指名して前向き表明済み → 「よろしければ」（仮定の「お気に召されましたら」は不自然）
 *   未指名・複数提案中                     → 「お気に召されましたら」（多数派・より安全）
 *  スタッフ実送信（Sさん）がまさに前者の判断。 */
export function viewingOfferLiteral(customerName: string, named: boolean, count = 1): string {
  // 2026-09-11 統合設計（経路B）: 名前不明時は呼びかけごと省く（旧「〇〇さん」フォールバックは BANNED_WORD〇〇＋NAME_PLACEHOLDER の block を供給していた）
  const n = customerName ? `${customerName}さん` : "";
  const obj = count >= 2 ? `${count}部屋` : "お部屋";
  return named
    ? `よろしければ${n}ご都合よろしいお日にちに${obj}ご案内させて頂きます😌！！`
    : `${n}お気に召されましたらご都合よろしいお日にちに${obj}ご案内させて頂きます😊！！`;
}

/** ご査収への感謝（全正解 5,881件中 45件＝0.8%。低頻度・高精度の**条件発火句**） */
export const GRATITUDE_FOR_REVIEW_RE = /ご査収(?:いただき|頂き)ありがとうございます/;
export const GRATITUDE_FOR_REVIEW_LITERAL = "ご査収頂きありがとうございます😊！！";
/** 直前スタッフ発言が資料送付か（実テキスト＝記帳行ではなく本文の文字列そのもの） */
export const STAFF_MATERIALS_SENT_RE =
  /ご査収(?:ください|下さい)|お送り(?:させて(?:頂|いただ)き|いたし|致し|し)ました|送らせて(?:頂|いただ)きました|同封(?:させて(?:頂|いただ)き|いたし|致し)ました|添付(?:させて(?:頂|いただ)き|いたし|致し)ました/;

/** 顧客が指名した物件（台帳の送付済み物件名との照合が一次証拠。brain current_property は corroboration のみ） */
export type NamedPropertyVerdict = {
  /** 顧客が書いた表記そのまま（表記揺れを直さない。実データ KANOASIA→KANOACIA / konon神崎川 のまま受けた例あり） */
  asWritten: string | null;
  /** 台帳の送付済み物件名と一致したか（一次証拠） */
  matchedSent: boolean;
  /** brain conversation-scope の current_property と一致したか（記録のみ・判定には使わない） */
  brainAgrees: boolean;
  /** 顧客が指名した件数（2件以上なら「それぞれ／N部屋」で受ける） */
  count: number;
};

export function resolveNamedProperty(
  sub: SubstanceVerdict, ledger: ActionLedger | null, brainCurrentProperty?: string | null,
): NamedPropertyVerdict {
  const text = sub.normalized;
  const hits: string[] = [];
  for (const n of ledger?.facts.propertiesSentNames ?? []) {
    const k = propertyMatchKeys(n).find((key) => text.includes(key));
    if (k) hits.push(k);
  }
  const uniqHits = [...new Set(hits)];
  const brainKeys = brainCurrentProperty ? propertyMatchKeys(brainCurrentProperty) : [];
  return {
    asWritten: uniqHits[0] ?? null,
    matchedSent: uniqHits.length > 0,
    brainAgrees: brainKeys.some((k) => uniqHits.some((h) => h.includes(k) || k.includes(h))),
    count: uniqHits.length,
  };
}

/** 「ご査収頂きありがとうございます」の唯一のゲート（AND・片方だけでは出さない）。
 *  実測: 資料送付あり×顧客ありがとう n=14 → 発火3（21%・最高）／「ありがとう」だけ 1,346件中23件（1.7%） */
export type MaterialsVerdict = {
  staffSent: boolean; staffEvidence: string;
  customerSaw: boolean; customerEvidence: string;
  thanksAllowed: boolean;
};
export function resolveMaterialsContext(
  lastStaffText: string, sub: SubstanceVerdict,
  ledger: ActionLedger | null, positive: PositiveVerdict | null, named: NamedPropertyVerdict,
): MaterialsVerdict {
  const m = (lastStaffText ?? "").match(STAFF_MATERIALS_SENT_RE);
  const le = ledger?.facts.lastStaffEntry ?? null;
  const byLedger = !!le && le.status === "done" && (le.kind === "properties_sent" || le.kind === "estimate_sent");
  const staffSent = !!m || byLedger;
  const thanks = sub.normalized.match(/ありがとう|有難う|感謝/);
  // 「その資料を見たことの証拠」= ありがとう / T1 の感想語 / 特定物件名の指名
  const customerSaw = !!thanks || !!positive || named.matchedSent;
  return {
    staffSent, staffEvidence: m?.[0] ?? (byLedger ? `ledger:${le!.kind}` : ""),
    customerSaw, customerEvidence: thanks?.[0] ?? positive?.evidence ?? named.asWritten ?? "",
    thanksAllowed: staffSent && customerSaw,
  };
}

export type PairMustInclude = {
  label: string;
  detect: RegExp;
  /** 2026-09-11 統合設計（経路C）: pair を要する判定（回答形・依頼形）。あれば detect より優先（mustIncludeSatisfied が唯一の評価入口） */
  detectFn?: (text: string, pair: PairContext) => boolean;
  /** false を返す時はこの要素を direction にも検査にも出さない（例: 条件を送る予告に見積予告を要求しない） */
  when?: (pair: PairContext) => boolean;
  /** 省略時は precedence 由来（override_wait=block / after_wait=warning） */
  severity?: "block" | "warning";
  /** PAIR_ELEMENT_MISSING の修正案リテラル（**必須**）。2026-09-11 統合設計（経路A）: 旧実装は省略時に rule.suggestion → rule.example
   *  （別顧客の実文・固有名詞・日付）へフォールバックし、修正ループに他顧客の内容を流し込んでいた。型で必須にしてフォールバックを消す。
   *  リテラル内の名詞・数値・日付は verdict 由来のトークン（{name}/{object}/{fix}/{redo}/{viewingOffer}/{namedProperty}）のみ */
  fix: string;
  /** 2026-09-10 Fable5: 必須要素が「A or B」の選択肢を持つ時、brain avoid と衝突する側を**除外**して
   *  残る側をリテラルで指名する。文を足す指示ではなく選択肢を削る指示なので、創作を誘発しない */
  preferWhenAvoid?: Array<{ avoid: RegExp; use: string }>;
};
export type PairRule = {
  id: string;
  staff: StaffTurnKind | "*";
  customer: CustomerResponseKind | "*";
  precedence: PairPrecedence;
  /** tpoNoteForLLM ↔ few-shot「■ 場面【…】」↔ final-check の同名ラベル */
  tpoLabel: string;
  direction: string;
  mustInclude: PairMustInclude[];
  mustNot: string[];
  example: string;
  /** その example が成立する前提（例:「顧客が『家族と相談する』と言った場合」）。省略=セル条件そのものが前提 */
  examplePremise?: string;
  /** 顧客メッセージ（normalizeCustomerText 後）がこれに一致しない時、example をそのまま出さない */
  exampleRequires?: RegExp;
  /** 前提不成立時に出す前提節を削った短縮版。省略時は「型のみ提示・文はそのまま使わない」注記付きで example を出す */
  exampleFallback?: string;
  // 2026-09-11 統合設計（経路A）: 旧 `suggestion`（PAIR_ELEMENT_MISSING の修正案フォールバック）は削除。修正案は要素ごとの fix（必須）だけ
  length: string;
  /** 2026-09-11 統合設計（経路D）: 締め verdict（resolveClosing）が farewell の時だけ選ぶセル。通常の staff×customer 探索から除外する */
  closingOnly?: boolean;
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
/** 2026-09-11 竹内方針1（§3.2・E1-e）: 条件を復唱した探索宣言（スタッフ実文の語彙「〜探してお届けします」「ご提案させて頂きます」「探させて頂きます」も含む）。
 *  CA_CONDITION / ANY_CONDITION_CHANGE / PD_CONDITION_CHANGE / PS_CONDITION_CHANGE が共有 */
const CONDITION_SEARCH_DECL_RE = new RegExp(
  "(?:周辺|全域|沿線|以内|万|LDK|DK|[0-9０-９]K|ワンルーム|エリア|付近|駅|区|市|㎡|築|徒歩|造|向き|階)[^\\n]{0,120}(?:ピックアップ|探さ|探(?=させ)|お探しさせ|お届け|ご提案)" +
  "|ご?条件に合(?:った|う)(?:お部屋|物件)[^\\n。！!]{0,10}(?:ピックアップ|探さ|探(?=させ))");
const SEARCH_VERB_RE = /ピックアップ|探さ|探(?=させ)|お探しさせ|お届け|ご提案/;
/** 条件の復唱（検査 CONDITION_ECHO と同じ evalConditionEcho・resolveCustomerDocScope を使う）＋探索宣言 */
function conditionEchoDeclared(t: string, p: PairContext): boolean {
  if (CONDITION_SEARCH_DECL_RE.test(t)) return true;
  if (!SEARCH_VERB_RE.test(t)) return false;
  const scope = resolveCustomerDocScope(p.substance.normalized);
  return scope.tokens.length > 0 && evalConditionEcho(t, scope.tokens).echoed.length > 0;
}
/** 2026-09-11 竹内方針1（§3.2）: 懸念セルの探索宣言。前置き（中心に／条件に合／優先して）を要求しない（「エレベーター付き…の条件で…ピックアップ」
 *  「初期費用抑えてのご入居が可能なお部屋探させていただきます」「随時確認させて頂き…出次第お送り」を取りこぼしていた・7/8→2/8） */
const CONCERN_SEARCH_DECL_RE = new RegExp(
  `(?:ピックアップ|お探しさせ|探さ|探(?=させ)|お調べ|ご紹介|随時確認)[^\\n。！!]{0,30}(?:(?:させて(?:頂|いただ)き|いたし|致し)ます|出次第|出来次第)`);
/** 懸念対象の復唱: 固定語リストをやめ、analyzeSubstance が拾った懸念の replyRe（洗濯・駅から遠い・広さ等も含む）で判定する */
function concernEchoed(t: string, p: PairContext): boolean {
  // 懸念が本文から立っていない（brain 由来の concern 分類）時だけ旧来の固定語で判定する
  if (p.substance.concerns.length === 0) return CUST_CONCERN_OBJECT_FALLBACK_RE.test(t);
  return p.substance.concerns.some((c) => c.replyRe.test(t));
}
const CUST_CONCERN_OBJECT_FALLBACK_RE = /階|お風呂|家賃|初期費用|審査|駅|築|広|日当たり|駐車場|治安|お子様|新生児|エレベーター/;
/** 2026-09-11 竹内方針1（§3.2・E1-f）: 前向きセルの「次の一手を1つ」（ご案内／募集状況・空室の確認／見積の作成／回答形） */
const NEXT_MOVE_RE = new RegExp(
  `${VIEWING_OFFER_SOFT_RE.source}|ご案内${DECL_TAIL}|(?:募集状況|空室状況|内覧可能か)[^\\n。！!]{0,20}(?:確認|お調べ)|見積[^\\n。！!]{0,24}(?:作成|お送り|ご用意)`);

/** 2026-09-11 統合設計: 必須要素の充足判定（runSkeletonChecks ④・pairFixSuggestion・runProposalChecks 免除①・後処理ゲート免除が同じ関数） */
export function mustIncludeSatisfied(m: PairMustInclude, text: string, pair: PairContext): boolean {
  return m.detectFn ? m.detectFn(text, pair) : m.detect.test(text);
}
/** 質問セルの「直接回答」要素（hasDirectAnswer が唯一の判定。detect は後方互換の語彙表示用） */
// 2026-09-11 竹内方針1（§3.2・E1-c/d）: 対象付き行動宣言は質問の形に関係なく回答と認める（hasDirectAnswer(t,"request")）。
//   現行の依頼形判定では 174/228、request 扱いなら 226/228 の正解が満たす（スタッフは有無・費用の質問にも宣言で答える）
export const DIRECT_ANSWER_DETECT: Pick<PairMustInclude, "detect" | "detectFn"> = {
  detect: ANSWER_FORM_RE,
  detectFn: (t: string) => hasDirectAnswer(t, "request").yes,
};
/** 質問への回答の fix（名詞・数値・日付を含まない型指示）。2026-09-11 竹内方針1: スタッフ実文の4型（物件名は入れない） */
const ANSWER_FIX =
  "質問の種類で型を選ぶ（物件名・建物名は書かない）。①事実の質問: [CHECKPOINT]・履歴にある事実だけで「〜となります！！／〜可能です！！」の1文で答えて終える（次工程を足さない）" +
  "②費用の質問: 金額は答えず「かしこまりました！！」＋「最大限割引させて頂いた初期費用の御見積書作成しお送りさせて頂きます😊！！」" +
  "③有無・依頼の質問: 「かしこまりました！！」＋お客様の語のままのエリア・条件で「〜で{name}にオススメ出来るお部屋ピックアップしてお送りさせて頂きます！！」" +
  "④事実が無い: 「お送り頂きました物件の（質問の対象語）確認させて頂きます！！」（空室・告知事項・入居可能日は断言しない）";
/** 免除①②の共有: 選ばれたセルのアクティブな必須要素を満たす文／未履行ピックアップ約束の復唱文。
 *  runProposalChecks（UNPROMPTED_PROPOSAL）・validate-reply enforceAixGates（ピックアップ再宣言ゲート）・DOUBLE_DECLARATION フィルタが同じ関数 */
export function isCellRequiredSentence(s: string, pair: PairContext): boolean {
  const actives = (pair.rule?.mustInclude ?? []).filter((m) => !m.when || m.when(pair));
  if (actives.some((m) => mustIncludeSatisfied(m, s, pair))) return true;
  return !!pair.ledger?.facts.pickupPromisedUnfulfilled && /(?:ピックアップ|見つかり)(?:出来|でき)?次第/.test(s);
}

export const PAIR_MATRIX: PairRule[] = [
  // ── 2026-09-09 Fable5 みく事例: 条件ヒアリング→条件フォーム／条件回答。旧実装は rule=null で汎用指示に落ち、
  //    latent_intent「代替案で応える」＋ conditionDirection「全力でサポート禁止」の穴を LLM が先回りヘッジで埋めていた ──
  { id: "CA_CONDITION", staff: "condition_ask", customer: "condition_change", precedence: "override_wait",
    tpoLabel: "条件提示（条件ヒアリングへの条件フォーム／条件回答）",
    // 2026-09-11 竹内方針1（§3.2・E1-e）: スタッフ実文（n=18・中央129字）の型に合わせる。「見つかるまで伴走する締め」は 3/18 しか書かないので必須から削除・closer は none
    direction: "我々の条件ヒアリングに対しお客様が条件（フォーム／箇条書き）を返した。①「ご条件お送り頂きありがとうございます😊！！」または「かしこまりました！！」 ②お客様の言葉のままエリア・家賃・間取りを復唱したピックアップ宣言1文（物件名・建物名は書かない。「〜周辺全域から{name}にオススメできるお部屋ピックアップさせて頂きます！！」） ③任意「ピックアップ出来次第お送りさせて頂きます！！」 ④任意「何卒よろしくお願い致します！！」。96〜143字",
    mustInclude: [
      { label: "条件を復唱したピックアップ宣言（エリア／家賃／間取りのいずれかを含む）", detect: CONDITION_SEARCH_DECL_RE, detectFn: conditionEchoDeclared,
        fix: "お客様のメッセージにあるエリア・家賃・間取りをその語のまま（数字・語を変えない）並べ、「〜周辺全域から{name}にオススメできるお部屋ピックアップさせて頂きます！！」の1文にする（条件語を足さない・物件名は書かない）" },
    ],
    mustNot: ["未着手条件への「難しい可能性」「少ない状況」等の実現可能性の予測", "「条件を1つ変えた場合のご提案」「優先順位をお聞かせ」等の条件緩和の先回り提案", "お客様の自己ヘッジ（難しいと思う・あれば教えて）の復唱・同意", "条件を単体で確認する文", "見積書・募集状況確認・審査の先回り", "「新着あれば」等の受け身文", "物件名・号室の創作"],
    // 2026-09-11 竹内方針1: 実送信から伴走締めの1行を削除しただけ（文は足さない）
    example: "かしこまりました😊！！\n\n梅田まで1本で行ける沿線周辺全域から9万以内・1LDK・カウンターキッチン希望・築10年以内でみくさんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！\n何卒よろしくお願い致します！！",
    length: "96〜143字", closer: "none", nanisotsu: true },

  // ── 2026-09-09 Fable5 みく事例（行動台帳）: 宣言のみ（未送付）段階での条件絞り込み／NG追加。
  //    旧実装は staff=other → ANY_CONDITION_CHANGE の「再ピックアップ宣言」に落ち「再度」が出た ──
  { id: "PD_CONDITION_CHANGE", staff: "pickup_declared", customer: "condition_change", precedence: "override_wait",
    // 2026-09-11 統合設計（経路E1）: 「まだ1件も送っていない」を固定文で持たない（2回目以降のピックアップ宣言で台帳「送付N件」と自己矛盾した）。
    //   ラウンドの文言は pickupRound(ledger) → {pickupRoundNote} の1関数から作る
    tpoLabel: "条件絞り込み（ピックアップ約束中）",
    direction: "我々は直前に「〇〇の条件でピックアップしてお送りします」と宣言しただけで、その宣言はまだ履行していない（{pickupRoundNote}／台帳: {ledger}）。お客様がその宣言に条件の追加/絞り込み（エリア限定・NG等）を重ねた。①「かしこまりました😊！！」単独行 ②追加条件を「〇〇に絞らせて頂き」の肯定形で受け（NGは「京都・尼崎を除き」ではなく「大阪市内に絞らせて頂き」に変換。NG名は復唱しない）、直前宣言の条件を数字・語を一字も変えずに復唱した未来形のピックアップ宣言1文 ③任意「{name}にオススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！」の履行約束1文 ④締め。直前の宣言をまだ実行していないので「再度／改めて／新たに／追加で／別の」は一切使わない。100〜180字",
    mustInclude: [
      // 2026-09-11 統合設計（経路C・YUYA 事例）: 追加条件をエリア以外（「家賃は管理費込みで〜のご条件として」）で受けた正しい宣言を取りこぼしていた → 「ご条件として／で」「込みで」を許す
      // 2026-09-11 竹内方針1: スタッフ実文の「〜付近から…ご条件に合ったお部屋ピックアップ」も満たす（CONDITION_SEARCH_DECL_RE／evalConditionEcho と共有）
      { label: "絞り込みを肯定形で反映した条件復唱のピックアップ宣言（未来形）", detect: new RegExp(`(?:に絞(?:らせて|って)|エリアで|エリアから|周辺(?:全域)?から|市内|中心に|ご?条件(?:として|で|にて)|込みで)[^\\n]{0,120}ピックアップ[^\\n。！!]{0,24}${DECL_TAIL}`),
        detectFn: (t, p) => new RegExp(`(?:に絞(?:らせて|って)|エリアで|エリアから|周辺(?:全域)?から|市内|中心に|ご?条件(?:として|で|にて)|込みで)[^\\n]{0,120}ピックアップ[^\\n。！!]{0,24}${DECL_TAIL}`).test(t) || conditionEchoDeclared(t, p),
        fix: "お客様が追加した条件を「〜に絞らせて頂き」の肯定形で受け（NG名は復唱しない）、直前宣言の条件を一字も変えずに復唱した「〜で{name}にオススメできるお部屋をピックアップさせて頂きます！！」の1文にする" },
      { label: "前回条件の復唱（エリア／家賃／間取りのいずれか）", detect: /(?:周辺|全域|沿線|以内|万|LDK|DK|[0-9０-９]K|ワンルーム|築|徒歩)/,
        fix: "直前スタッフ宣言にあるエリア／家賃／間取りの語をそのまま1つ以上含める（直前宣言に無い条件語は足さない）" },
      // 2026-09-11 竹内方針1（§3.2）: 「履行約束（ピックアップ出来次第お送り）」はスタッフ実文 3/8 → 必須から削除（direction ③ は任意）
    ],
    mustNot: ["実行済みを含意する語（再度・改めて・もう一度・新たに・追加で・別の・こちらの・先ほどお送りした）— 直前の宣言は未履行（{pickupRoundNote}）", "送付済み物件への言及・「〇〇も選択肢に」", "「〜をお届けします」等の抽象締め（未来形宣言＋出来次第お送りで統一）", "NG語の羅列（京都・尼崎はNGで）の復唱", "実現可能性の予測（難しい・少ない・可能性）", "条件緩和・代替案の先回り提案", "条件の聞き返し", "直前宣言の条件の数字・語の改変", "全力サポート締めの二重化（直前発言で既に言っている）"],
    example: "かしこまりました😊！！\n\n大阪市内に絞らせて頂き、梅田まで1本で行ける沿線・9万以内・1LDK・カウンターキッチン希望・築10年以内でみくさんにオススメできるお部屋をピックアップさせて頂きます！！\n\nみくさんにオススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！何卒よろしくお願い致します！！",
    length: "100〜180字", closer: "commit_until_found", nanisotsu: true },
  // 直前発言の CA_CONDITION は必ず全力サポートを含むため resolveCloser の priorCommit で none＋何卒に落ちる＝みく 11:48 実送信と一致

  { id: "PD_ACK", staff: "pickup_declared", customer: "ack_only", precedence: "after_wait",
    tpoLabel: "短い了承（ピックアップ約束への了承）",
    direction: "我々のピックアップ宣言にお客様が「よろしくお願いします」等の了承のみを返した。開口語「はい😊！！」→「{name}にオススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！」の履行約束復唱1文のみ。台帳: {ledger}。実行済み語禁止。40〜80字",
    // 2026-09-11 竹内方針1（§3.2）: 「出次第／で次第／出来次第」も履行約束（スタッフ実文の表記。欠落 14→9）
    mustInclude: [{ label: "履行約束の復唱", detect: /(?:出|で|出来|でき)次第[^\n]{0,12}(?:お送り|ご連絡)/,
      fix: "「{name}にオススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！」を1文入れる" }],
    mustNot: ["実行済み含意語（再度・改めて・追加で）", "条件の再列挙", "全力サポート・何卒の再掲", "新規の業務語彙（撮影・ご査収・内覧日程）"],
    example: "はい😊！！\nみくさんにオススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！",
    length: "40〜80字", closer: "none", nanisotsu: false },

  { id: "PD_QUESTION", staff: "pickup_declared", customer: "question", precedence: "override_wait",
    tpoLabel: "質問（ピックアップ約束中）",
    direction: "ピックアップ約束中（{pickupRoundNote}・台帳: {ledger}）にお客様が質問した。①質問に履歴の事実で直接回答1文（分からなければ「確認しご連絡」対象付き）②任意で「{name}にオススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！」。実行済み語禁止。80〜160字",
    // G32: 依頼形の質問（「〜で探して頂けますか」）への「探させて頂きます」も回答として認識する
    // 2026-09-11 統合設計（経路C）: 裸の /です|いたします/ は「お願いいたします」にも一致して甘すぎた → hasDirectAnswer（依頼形なら行動宣言を回答とみなす）に統一
    // 2026-09-11 竹内方針1（§3.2・E1-c）: 「履行約束の復唱」はスタッフ実文 2/26 → 必須から削除（direction ② は任意）
    mustInclude: [
      { label: "質問への直接回答", ...DIRECT_ANSWER_DETECT, fix: ANSWER_FIX },
    ],
    mustNot: ["実行済み含意語", "「こちらの物件」等の指示語", "条件の聞き返し"],
    example: "トイレと洗面所別のお部屋につきましては、設備分家賃が高くなる傾向がございます！！(3,000円～5,000円程）\n\nトイレ・洗面所別のご条件も含めてあやさんにオススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！何卒よろしくお願い致します！！",
    examplePremise: "お客様が設備（トイレ・洗面所別）の費用差を質問した場合",
    exampleRequires: /トイレ|洗面|設備|別|家賃(?:は|が|って)/,
    length: "80〜160字", closer: "none", nanisotsu: true },

  // ── 2026-09-10 Fable5 あみ事例: ピックアップ宣言のみ（未送付）の段階で、顧客が「気になる物件を自分で送る」と予告した ──
  //    直前 13:24 に「出次第お送りします」と宣言済み＝我々の探索宣言の繰り返しは重複。主軸は顧客が送ってくる物件を受ける宣言。
  { id: "PD_WILL_SEND", staff: "pickup_declared", customer: "will_send_later", precedence: "override_wait",
    tpoLabel: "持込予告（ピックアップ約束中）",
    direction: "我々は直前に「オススメできるお部屋が出次第お送りします」と宣言しただけで、その宣言はまだ履行していない（{pickupRoundNote}／台帳: {ledger}）。お客様は『こちらでも気になる物件を見つけたら送ります』と予告した。①開口語「はい😊！！」②「気になるお部屋ございましたらいつでもお送りください！！」の受け口1文 ③【核】お送り頂きました物件の募集状況を確認し、最大限割引した初期費用の御見積書とあわせてご連絡する宣言1文。直前で既にピックアップを宣言しているので「随時ピックアップしてお送りします」は書かない（重複）。お客様は『相談する』とも『検討する』とも言っていないので「ごゆっくりご相談／ご検討」は書かない。80〜160字",
    mustInclude: [
      { label: "送られた物件の募集状況を確認する宣言", detect: WILL_SEND_RECEIVE_CHECK_RE, when: isPropertyForecast,
        fix: "「お送り頂きました物件の募集状況確認させて頂きます！！」を1文入れる" },
      { label: "最大限割引した初期費用の御見積書の予告", detect: WILL_SEND_ESTIMATE_FORECAST_RE, when: isPropertyForecast,
        fix: "「最大限割引しました初期費用の御見積書とあわせてご連絡させて頂きます！！」を続ける" },
      { label: "ご条件に合うお部屋を探す宣言", detect: WILL_SEND_CONDITION_SEARCH_RE, when: (p) => p.sendObject === "condition",
        fix: "「ご条件お送りいただきましたら条件に合ったお部屋探させて頂きます😊！！」を1文入れる" },
    ],
    mustNot: ["「随時ピックアップしてお送りします」（直前13:24で宣言済み＝重複。かつ (A) 場面の正解 0/246）", "顧客が言っていない「ご相談」（(A) 正解 28件中 0件）", "顧客が言っていない「ごゆっくり」「ご検討」", "実行済み含意語（再度・改めて・追加で・別の）— 直前の宣言は未履行（{pickupRoundNote}）", "申込誘導・希少性煽り", "「かしこまりました！！」単独終了"],
    example: "はい😊！！\n気になるお部屋ございましたらいつでもお送りください！！\nお送り頂きました物件の募集状況確認させて頂き、最大限割引しました初期費用の御見積書とあわせてご連絡させて頂きます！！",
    examplePremise: "お客様が『気になる物件を後日送る』と予告した場合（このセルの条件そのもの）",
    length: "80〜160字", closer: "none", nanisotsu: false },

  { id: "ANY_CONDITION_CHANGE", staff: "*", customer: "condition_change", precedence: "override_wait",
    tpoLabel: "条件変更（エリア・家賃・間取り・設備の追加/変更）",
    // 2026-09-11 竹内方針1（§3.2・E1-e）: 初回返信×条件フォームの実文（n=59）は「挨拶→ご条件お礼→条件復唱の探索宣言（86%）→全力サポート（58%）→
    //   初期費用も最大限割引（51%）→何卒」。初回は探索宣言か全力サポートのどちらかで満たす
    direction: "お客様が条件の追加/変更を伝えた（台帳: {ledger}）。①「かしこまりました！！」（初回返信は挨拶→「ご条件お送り頂きありがとうございます😊！！」）②新条件をお客様の語のまま復唱した{redo}ピックアップ宣言1文（物件名・建物名は書かない）③初回返信は「全力でサポートさせて頂きます」「初期費用も最大限割引させて頂き、費用を出来る限り抑えさせて頂きます」→何卒。聞き返し禁止。台帳が物件送付0件なら実行済み含意語（再度・改めて・追加で・別の）を使わない。90〜160字",
    mustInclude: [
      // 2026-09-11 統合設計（経路C・じゅにあ事例）: 「平野区も含めて…ピックアップ」を取りこぼしていた（区・市・駅・線 が語彙外）
      // 2026-09-11 竹内方針1: 「〜探してお届けします」「ご提案させて頂きます」（スタッフ実文）も探索宣言。初回返信は全力サポート宣言でも満たす
      { label: "新条件を復唱した{redo}ピックアップ宣言", detect: CONDITION_SEARCH_DECL_RE,
        detectFn: (t, p) => conditionEchoDeclared(t, p) || (!p.lastStaffText.trim() && /全力で(?:お部屋探し)?サポート/.test(t)),
        fix: "お客様のメッセージの新条件をその語のまま復唱し「〜で{name}にオススメ出来るお部屋{redo}ピックアップしてお送りさせて頂きます！！」の1文にする（条件語を足さない・変えない・物件名は書かない）" },
    ],
    mustNot: ["実現可能性の予測（難しい・少ない・可能性）", "条件緩和・代替案の先回り提案", "「少ない状況でしたので広げました」の言い訳（探していない）", "聞き返し", "再送宣言", "台帳に送付実績が無いのに「再度」「改めて」「新たに」「追加で」「別の」を付ける"],
    example: "かしこまりました！！\n2LDKのご条件で、枚方・高槻・吹田・守口・門真・鶴見区周辺全域から瑞希さんにオススメ出来るお部屋新たにピックアップしてお送りさせて頂きます😌！！\n瑞希さんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！",
    exampleBySent: {
      none: "かしこまりました😊！！\n〇〇に絞らせて頂き、〇〇のご条件で〇〇さんにオススメできるお部屋をピックアップさせて頂きます！！\n〇〇さんにオススメ出来るお部屋ピックアップ出来次第お送りさせて頂きます！！",
      sent: "かしこまりました！！\n2LDKのご条件で、枚方・高槻・吹田・守口・門真・鶴見区周辺全域から瑞希さんにオススメ出来るお部屋新たにピックアップしてお送りさせて頂きます😌！！\n瑞希さんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！",
    },
    examplePremise: "物件を1件以上送付済みの場合（未送付は exampleBySent.none 側が選ばれる）",
    length: "90〜160字", closer: "commit_until_found", nanisotsu: false },

  { id: "VI_CONCERN", staff: "viewing_invite", customer: "concern", precedence: "override_wait",
    tpoLabel: "提案後の懸念（内覧打診への懸念返答）",
    // 2026-09-10 Fable5: 完成文のリテラル（「ご要望お聞かせ頂きありがとうございます😊！！」）を direction から除去
    //   （example 側にのみ残し、examplePremise / exampleRequires の前提ゲートを効かせる）
    direction: "我々の内覧打診に対し顧客が物件の懸念（{object}）を返した。①お客様が使った語のままの受け止め1文（共感語禁止・開口語は置かない）②履歴にある事実で答えられる時のみ事実回答1文（無ければ省略）③懸念を条件語に変換した再ピックアップ宣言1文④内覧は「お気に召されましたらいつでも」の開放のみで押さない⑤締め。120〜200字",
    mustInclude: [
      { label: "懸念（{object}）対象の復唱", detect: /階段|[0-9０-９]+階|1階|１階|エレベーター|お子様|新生児|お風呂|広め|築|家賃|初期費用|審査/, detectFn: concernEchoed,
        fix: "お客様が挙げた懸念対象「{object}」をそのままの語で1文に入れる（お客様が書いていない語は足さない）" },
      { label: "懸念→条件変換の再ピックアップ宣言", detect: CONCERN_SEARCH_DECL_RE,
        fix: "「{fix}{name}にオススメできるお部屋{redo}ピックアップしお送りさせて頂きます！！」の形で1文だけ宣言する" },
    ],
    mustNot: ["「お気持ち、よくわかります」等の共感フレーズ", "「かしこまりました！！」で終える", "「はい😊！！」開始", "内覧日程の再提案・候補日時", "申込誘導・希少性煽り", "「2階でも大丈夫」等の根拠なし安心づけ", "懸念を質問で返す"],
    example: "あみさんお世話になっております！！\nご要望お聞かせ頂きありがとうございます😊！！\n新生児のお子様との階段の上り下りはご負担になりますので、1階またはエレベーター付きのお部屋を中心にあみさんにオススメできるお部屋再度ピックアップしお送りさせて頂きます！！\nこちらのお部屋も含めお気に召されましたらいつでもご内覧頂けますので、あみさんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます😌！！",
    examplePremise: "新生児のお子様＋階段の懸念が出た場合",
    exampleRequires: /階段|[0-9０-９]+階|エレベーター|新生児|赤ちゃん|お子/,
    length: "120〜200字", closer: "commit_until_found", nanisotsu: false },

  { id: "VI_POSITIVE", staff: "viewing_invite", customer: "positive", precedence: "after_wait",
    tpoLabel: "内覧調整（内覧打診への前向き返答）",
    direction: "内覧受付。候補日時は AIX 内覧日調整で送るため本文は受付＋「ご都合よろしいお日にち御座いますでしょうか」の確認のみ。既に候補日を出している場合は日時確定の復唱のみ。40〜90字",
    mustInclude: [
      { label: "受付語", detect: /かしこまりました/, fix: "「かしこまりました！！」を単独行で置く" },
      { label: "日程確認 or 確定復唱", detect: /ご都合|お日にち|[0-9０-９]{1,2}[/／月][0-9０-９]{1,2}|[0-9０-９]{1,2}時/,
        fix: "候補日時を出していなければ「{name}ご都合よろしいお日にち御座いますでしょうか😊！！」、出していれば直前スタッフ発言の日時をそのまま復唱する（日時を作らない）" },
    ],
    mustNot: ["申込誘導", "別物件提案", "募集未確認物件への内覧確約"],
    example: "かしこまりました！！\nお部屋ご案内させていただきます！！\nタクミさんご都合よろしいお日にち御座いますでしょうか😊！！",
    length: "40〜90字", closer: "none", nanisotsu: false },

  // ── 2026-09-10 Fable5 Sさん事例: 物件送付・強推し後の前向き反応。
  //    最頻の営業局面でありながら PAIR_MATRIX に1セルも無く、rule=null → 汎用 direction に落ちていた。
  //    precedence は override_wait（after_wait だと isGratitudeReplyTPO 分岐に先取りされ、
  //    「お手隙の際にご査収ください」＋ピックアップという別場面の hint に上書きされる）。
  { id: "PS_POSITIVE", staff: "property_send", customer: "positive", precedence: "override_wait",
    tpoLabel: "前向き反応（物件送付後・内覧のご案内提案）",
    // 2026-09-11 竹内方針1・2（§3.2・E1-f）: スタッフ実文に合わせ「ご査収感謝」（1/14）「開口語かしこまりました」（3/14）を必須から削除。
    //   要素は「次の一手を1つ」だけ（ご案内／募集状況・空室の確認／見積の作成／回答形）。物件名は入れない（{namedProperty}→「お部屋」）
    direction:
      "我々が送ったお部屋に対してお客様が前向きな反応（{positiveEvidence}）を返した。" +
      "次の一手を1つだけ（お客様が内見したいと明言した時は「お部屋ご案内させて頂きます😊！！」／新しい物件が送られた時は「募集状況と初期費用、管理会社に確認させて頂きます」／見積の作成）。" +
      "内覧のご案内は物件非依存なので「お部屋」で受け、物件名・建物名は書かない。" +
      "具体的な候補日時は書かない（候補日時の提示は AIX【内覧日調整】専用）。60〜130字",
    mustInclude: [
      { label: "次の一手を1つだけ（ご案内／募集状況の確認／御見積書の作成 のいずれか1つ）",
        detect: NEXT_MOVE_RE,
        detectFn: (t) => NEXT_MOVE_RE.test(t) || hasDirectAnswer(t, null).form === "answer",
        preferWhenAvoid: [{ avoid: /内覧|内見|ご案内|来店|来阪/,
          use: "「お部屋の募集状況確認させて頂きます！！」（内覧提案は brain が避けよと言っているので書かない）" }],
        fix: "お客様が内見したいと明言していれば「お部屋ご案内させて頂きます😊！！」、評価だけなら「{viewingOffer}」／費用・見積の話が出ている時のみ「お部屋の初期費用お見積書お送りさせて頂きます！！」" },
    ],
    mustNot: [
      "お客様の感想そのものへのお礼（「〇〇気になって頂きありがとうございます」型。成約データ 0/5,881 件）",
      "内覧のご案内提案をする時の物件名の復唱（内覧は物件非依存。「お部屋」で受ける）",
      "具体的な候補日時・曜日の提示（AIX【内覧日調整】専用）",
      "「ご都合よろしいお日にち御座いますでしょうか」の疑問形（候補日時を出した直後の AIX 専用文型・96%が日時とセット）",
      "条件節なしの裸「〇〇さんご都合よろしいお日にちに」（正解 14/443＝7%）",
      "申込誘導・希少性煽り（「埋まってしまいます」）",
      "「かしこまりました！！」単独終了",
      "次の一手を2つ以上並べること",
    ],
    // 2026-09-11 竹内方針1: 「ご査収頂きありがとうございます」の1行を削除（スタッフ実文 1/14。文は足さない）
    example: "かしこまりました！！\nよろしければ〇〇さんご都合よろしいお日にちにお部屋ご案内させて頂きます😌！！",
    examplePremise: "我々が送ったお部屋にお客様が前向きな評価（気になる・良さそう）を返した場合",
    exampleRequires: /ありがとう|有難う|気になり|気に入|良さそう|よさそう|いいですね|素敵|いい感じ/,
    exampleFallback: "かしこまりました！！\n{viewingOffer}",
    length: "60〜130字", closer: "none", nanisotsu: false },

  // ── 募集状況の確認結果報告後の前向き反応。check_result は PAIR_MATRIX に1セルも無い「孤児 StaffTurnKind」だった ──
  { id: "CR_POSITIVE", staff: "check_result", customer: "positive", precedence: "override_wait",
    tpoLabel: "前向き反応（募集状況報告後・内覧のご案内提案）",
    // 2026-09-11 竹内方針1（§3.2・E1-f）: 要素は「次の一手を1つ」だけ（条件節付き [Y] 型はスタッフ実文 0/7・内見の明言には「お部屋ご案内させて頂きます」）
    direction: "我々が募集状況の確認結果を報告した後、お客様が前向きな反応（{positiveEvidence}）を返した。次の一手を1つ（内見したいと明言していれば「お部屋ご案内させて頂きます😊！！」、それ以外は内覧のご案内提案・具体日時なし）。募集状況の再確認は宣言しない（報告済み）。60〜120字",
    mustInclude: [
      { label: "次の一手を1つ（内覧のご案内）", detect: NEXT_MOVE_RE,
        detectFn: (t) => NEXT_MOVE_RE.test(t) || hasDirectAnswer(t, null).form === "answer",
        fix: "お客様が内見したいと明言していれば「お部屋ご案内させて頂きます😊！！」、それ以外は「{viewingOffer}」" },
    ],
    mustNot: ["募集状況の再確認宣言（報告済み）", "具体的な候補日時の提示（AIX 専用）", "「ご都合よろしいお日にち御座いますでしょうか」", "申込誘導", "「かしこまりました！！」単独終了"],
    example: "かしこまりました😊！！\nよろしければ〇〇さんご都合よろしいお日にちにお部屋ご案内させて頂きます😌！！",
    examplePremise: "募集状況が『ご紹介可能』で報告済みの場合",
    length: "60〜120字", closer: "none", nanisotsu: false },

  { id: "VI_THINKING", staff: "viewing_invite", customer: "thinking", precedence: "after_wait",
    tpoLabel: "検討中フォロー（内覧打診後）",
    direction: "急かさない受け止め＋内覧の扉を開けたまま待つ。「はい😊！！」→「ごゆっくりご検討頂けますと幸いです！！」→「ご内覧出来ますので、気になる点出てきましたらいつでもお気軽にご連絡ください😌！！」。70〜120字",
    mustInclude: [
      { label: "急かさない受け止め（顧客が使った動詞をそのまま鏡写しにする）", detect: /ごゆっくり/, when: hasGoyukkuriMirrorVerb,
        fix: "顧客が『検討します』なら「ごゆっくりご検討頂けますと幸いです😊！！」／『確認します』なら「ごゆっくりご確認頂けますと幸いです😊！！」" },
      { label: "内覧の扉を開ける1文", detect: /内覧|いつでも/,
        fix: "「ご内覧出来ますので、気になる点出てきましたらいつでもお気軽にご連絡ください😌！！」を1文入れる" },
    ],
    mustNot: ["希少性煽り", "申込誘導", "物件追加提案", "「かしこまりました」開口語", "顧客が言っていない動詞での「ごゆっくり〇〇」"],
    example: "はい😊！！\nごゆっくりご検討頂けますと幸いです！！\nご内覧出来ますので、あいさん気になる点出てきましたらいつでもお気軽にご連絡ください😌！！",
    examplePremise: "お客様が『検討します／考えます』と明言した場合",
    exampleRequires: /検討|考え|悩|迷/,
    length: "70〜120字", closer: "open_door", nanisotsu: false },

  { id: "ES_WILL_SEND", staff: "estimate_send", customer: "will_send_later", precedence: "override_wait",
    tpoLabel: "提案後の検討・持込予告（見積送付後）",
    direction: "我々の見積送付に対しお客様が「気になる物件を後日送る」と返した。①開口語「はい😊！！」②（お客様が『検討する』『確認する』と自分で言った時だけ）その動詞をそのまま鏡写しにした「ごゆっくりご〇〇頂けますと幸いです！！」③【核】お送り頂いた物件は募集状況確認＋最大限割引した初期費用の御見積書をあわせてご連絡する宣言1文 ④直前の見積物件は「お気に召されましたらお申込しお部屋抑えさせて頂きます」で扉を開けたまま。120〜220字",
    mustInclude: [
      { label: "お送り頂いた物件の募集状況を確認する宣言", detect: WILL_SEND_RECEIVE_CHECK_RE,
        fix: "「お送り頂きました物件の募集状況確認させて頂きます！！」を1文入れる" },
      { label: "最大限割引した初期費用の御見積書をあわせて送る予告", detect: WILL_SEND_ESTIMATE_FORECAST_RE,
        fix: "「最大限割引させて頂いた初期費用の御見積書とあわせてご連絡させて頂きます！！」を続ける" },
    ],
    mustNot: ["申込催促・希少性煽り", "こちらからの新規1件推し宣言（顧客が自分で送ると言っている）", "「随時ピックアップしてお送りします」（我々が探して送る宣言。この場面の正解 246件中 0件）", "顧客が言っていない「ご相談」", "「かしこまりました！！」単独終了"],
    // 2026-09-11 竹内方針2: 他顧客の物件名（エストレーラ305号室）の行を削除（文は足さない）
    example: "みくさんお世話になっております！！\nはい😊！！ごゆっくりご検討頂けますと幸いです！！\n気になるお部屋ございましたらお送りください！！お送り頂き次第募集状況確認させて頂き、最大限割引させて頂いた初期費用の御見積書とあわせてご連絡させて頂きます！！",
    examplePremise: "お客様が『検討します』と明言し、かつ直前に見積書を送った物件が存在する場合",
    exampleRequires: /検討|考え|悩|迷|持ち帰/,
    exampleFallback: "はい😊！！\n気になるお部屋ございましたらお送りください！！お送り頂き次第募集状況確認させて頂き、最大限割引させて頂いた初期費用の御見積書とあわせてご連絡させて頂きます！！",
    length: "120〜220字", closer: "open_door", nanisotsu: false },

  { id: "ES_THINKING", staff: "estimate_send", customer: "thinking", precedence: "after_wait",
    tpoLabel: "検討中フォロー（見積送付後）",
    direction: "急かさない受け止め＋次工程（内覧／申込）の開放1文。「はい😊！！ごゆっくりご確認頂けますと幸いです！！」→「お部屋お気に召されましたら実際にご案内させて頂きますのでいつでもお気軽にご連絡ください😌！！」。70〜130字",
    mustInclude: [
      { label: "急かさない受け止め（顧客が使った動詞をそのまま鏡写しにする）", detect: /ごゆっくり/, when: hasGoyukkuriMirrorVerb,
        fix: "顧客が『確認します』なら「ごゆっくりご確認頂けますと幸いです😊！！」／『検討します』なら「ごゆっくりご検討頂けますと幸いです😊！！」" },
      { label: "次工程の開放（内覧／申込／不明点）", detect: /お気に召され|ご不明|ご不安|いつでも/,
        fix: "「お部屋お気に召されましたら、実際にお部屋ご案内させて頂きますのでいつでもお気軽にご連絡ください😌！！」を1文入れる" },
    ],
    mustNot: ["申込催促・希少性煽り", "別物件提案", "初期費用割引の再掲", "「かしこまりました」開口語"],
    example: "愛乃さん、お世話になっております！！\nはい😊！！ごゆっくりご確認頂けますと幸いです！！\nお部屋お気に召されましたら、実際にお部屋ご案内させて頂きますのでいつでもお気軽にご連絡ください😌！！",
    examplePremise: "お客様が『確認します／拝見します』と言った場合",
    exampleRequires: /確認|拝見|見(?:て|ま)|目を通/,
    exampleFallback: "はい😊！！\nお部屋お気に召されましたら、実際にお部屋ご案内させて頂きますのでいつでもお気軽にご連絡ください😌！！",
    length: "70〜130字", closer: "wait_softly", nanisotsu: false },

  { id: "ES_CONCERN", staff: "estimate_send", customer: "concern", precedence: "override_wait",
    tpoLabel: "提案後の懸念（見積への懸念）",
    direction: "見積への懸念（{object}）に事実で理由を1文説明（礼金がかかる等・履歴にある事実のみ）→初期費用を抑えられる別物件を探す宣言。共感語不要。90〜150字",
    mustInclude: [
      { label: "高い理由の事実説明", detect: /礼金|敷金|仲介|保証|(?:となります|かかります|高くなって)/,
        fix: "送付した見積書にある項目（礼金・敷金・仲介手数料・保証料のうち履歴にあるものだけ）を挙げて「〜がかかりますので初期費用高くなってしまいます」の1文で理由を説明する（履歴に無い項目・金額は書かない）" },
      { label: "初期費用を抑えた別物件を探す宣言", detect: new RegExp("(?:初期費用|費用|家賃).{0,15}(?:抑え|安い|抑えられ).{0,30}(?:探|ピックアップ|お調べ)"),
        fix: "「別物件で初期費用抑えられるオススメ出来るお部屋探させて頂きます！！」を1文入れる" },
    ],
    mustNot: ["値引き確約", "共感語のみ", "申込誘導"],
    example: "こちらの2物件は、礼金がかかりますので初期費用高くなってしまいます。\n別物件で初期費用抑えられるオススメ出来るお部屋探させて頂きます！！\n何卒よろしくお願い致します😌！！",
    examplePremise: "礼金が発生する物件で初期費用の高さを指摘された場合",
    exampleRequires: /高|礼金|敷金|初期費用|予算/,
    length: "90〜150字", closer: "commit_until_found", nanisotsu: true },

  { id: "ES_POSITIVE", staff: "estimate_send", customer: "positive", precedence: "after_wait",
    tpoLabel: "申込打診（見積送付後の前向き返答）",
    direction: "申込でお部屋を抑える宣言＋（履歴にある事実のみ）保証会社審査通過までキャンセル料なし等の事実1文。煽り禁止。80〜160字",
    mustInclude: [{ label: "申込でお部屋を抑える宣言", detect: /お申込.{0,15}(?:抑え|押さえ)/,
      fix: "「{name}問題なければお申込しお部屋抑えさせて頂きます😌！！」を1文入れる" }],
    mustNot: ["「埋まってしまいます」等の煽り", "書類リスト生成", "未確認の退去日・入居可能日の断言"],
    example: "竹田さんお世話になっております！！\nはい！お申込しお部屋を抑える事可能です！！保証会社の審査が通過するまではキャンセル料一切かかりません！！\n竹田さん問題なければお申込しお部屋抑えさせて頂きます😌！！",
    length: "80〜160字", closer: "none", nanisotsu: false },

  { id: "PS_CONCERN", staff: "property_send", customer: "concern", precedence: "override_wait",
    tpoLabel: "提案後の懸念（物件送付後）",
    // 2026-09-10 Fable5: 完成文のリテラル（「ご要望お聞かせ頂きありがとうございます😊！！」「〜お調べさせて頂きます！！」）を
    //   direction から除去（example 側にのみ残し前提ゲートを効かせる）。direction は無条件に注入されるため second-order の生成源だった
    direction: "送付物件への懸念（{object}）を、お客様が使った語のまま条件に変換し、その条件で{redo}ピックアップする宣言。開口語は置かず受け止め1文から入る。共感文だけは不合格。90〜150字",
    mustInclude: [
      { label: "懸念（{object}）→条件語の復唱", detect: /広め|広い|1階|１階|エレベーター|抑え|近い|新し|静か|明る|築浅|保証会社/,
        detectFn: (t, p) => /広め|広い|1階|１階|エレベーター|抑え|近い|新し|静か|明る|築浅|保証会社/.test(t) || concernEchoed(t, p),
        fix: "お客様が挙げた懸念対象「{object}」を条件語に変換した「{fix}」を1文に入れる（お客様が書いていない条件語は足さない）" },
      // 2026-09-11 竹内方針1（§3.2）: 前置き「中心に|条件に合|優先して」を必須にしない（スタッフ実文 7/8 を取りこぼしていた）
      { label: "{redo}ピックアップ宣言", detect: CONCERN_SEARCH_DECL_RE,
        fix: "「{fix}{name}にオススメできるお部屋お調べさせて頂きます！！」の形で1文だけ宣言する" },
    ],
    mustNot: ["「お気持ちよくわかります」等の共感語", "送付物件の擁護・説得", "内覧誘導・申込誘導", "「かしこまりました！！」単独終了", "「はい😊！！」開始"],
    example: "あみさんお世話になっております！！\nご要望お聞かせ頂きありがとうございます😊！！\nお風呂広めのお部屋を中心にあみさんにオススメできるお部屋お調べさせて頂きます！！\nあみさんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！",
    examplePremise: "お風呂の広さの懸念が出た場合",
    exampleRequires: /風呂|浴室|浴槽|広|狭/,
    length: "90〜150字", closer: "commit_until_found", nanisotsu: false },

  { id: "PS_THINKING", staff: "property_send", customer: "thinking", precedence: "after_wait",
    tpoLabel: "検討中フォロー（物件送付後）",
    direction: "急かさない受け止め＋随時ピックアップ宣言 or 内覧の扉を開ける1文。「はい😊！！」→「ごゆっくりご〇〇頂けますと幸いです！！」（〇〇はお客様が使った動詞の鏡写し＝検討します→ご検討／確認します→ご確認／相談してみます→ご相談。お客様が言っていない語は使わない）→「ご条件に合うお部屋出てきましたら随時ピックアップしてお送りさせて頂きます」or「気になる点出てきましたらいつでもお気軽にご連絡ください」。70〜130字",
    mustInclude: [
      { label: "急かさない受け止め（顧客が使った動詞をそのまま鏡写しにする）", detect: /ごゆっくり/, when: hasGoyukkuriMirrorVerb,
        fix: "顧客が『検討します』なら「ごゆっくりご検討頂けますと幸いです😊！！」／『確認します』なら「ごゆっくりご確認頂けますと幸いです😊！！」／『相談してみます』なら「ごゆっくりご相談頂けますと幸いです😊！！」" },
      { label: "随時ピックアップ宣言 or 扉を開ける1文", detect: /随時|出てきましたら|出次第|いつでも|内覧/,
        preferWhenAvoid: [{ avoid: /新規.{0,6}ピックアップ|再ピックアップ|別物件|物件提案/,
          use: "「お部屋お気に召されましたら、実際にお部屋ご案内させて頂きますのでいつでもお気軽にご連絡ください😌！！」（＝扉を開ける側を選ぶ。随時ピックアップ側は brain が避けよと言っているので書かない）" }],
        fix: "brain が新規ピックアップを避けよと言っていれば「お部屋お気に召されましたら、実際にお部屋ご案内させて頂きますのでいつでもお気軽にご連絡ください😌！！」、それ以外は「また{name}にオススメできるお部屋出てきましたら随時ピックアップしてお送りさせて頂きます！！」のどちらか1文" },
    ],
    mustNot: ["申込誘導", "希少性煽り（人気のため早めに等）", "「かしこまりました！！」単独終了", "検討依頼の繰り返し（ご検討の程〜）", "顧客が言っていない動詞での「ごゆっくり〇〇」（相談と言っていないのに『ご相談』等）"],
    example: "お世話になっております！！\nかしこまりました！！ごゆっくりご相談頂けますと幸いです😊！！\nまた〇〇さんにオススメできるお部屋出てきましたら随時ピックアップしてお送りさせて頂きます！！",
    examplePremise: "お客様が『（誰かに）相談してみます』と明言した場合（rさん実例）。相談の言及が無い場面でこの文を出すと文脈が壊れる",
    exampleRequires: /相談|話し合|家族|旦那|主人|妻|嫁|親|同居|友人|彼氏|彼女|二人で|2人で/,
    // 2026-09-10 Fable5 みく事例: 旧 fallback は「随時ピックアップしてお送りさせて頂きます」を含み、
    //   avoid_topics に新規ピックアップがある会話では example 自体が禁止語の供給源になっていた。
    //   VI_THINKING / ES_THINKING の成約実文と同型の「扉を開ける」型に差し替える
    exampleFallback: "はい😊！！\nごゆっくりご確認頂けますと幸いです！！\nお部屋お気に召されましたら、実際にお部屋ご案内させて頂きますのでいつでもお気軽にご連絡ください😌！！",
    length: "70〜130字", closer: "wait_softly", nanisotsu: false },

  { id: "PS_WILL_SEND", staff: "property_send", customer: "will_send_later", precedence: "override_wait",
    tpoLabel: "提案後の持込予告（物件送付後）",
    direction: "我々が物件を送った後、お客様が「気になる物件を（後日）送る」と予告した。①開口語「はい！！」または「かしこまりました！！」②（お客様が『送っていいですか』と許可を求めた時だけ）「気になるお部屋ございましたらいつでもお送りください😊！！」③【核】お送り頂き次第の業務フロー1文＝募集状況確認＋最大限割引した初期費用の御見積書。我々が探して送る話（随時ピックアップ）はこの場面では書かない。90〜160字",
    mustInclude: [
      { label: "送られた物件の募集状況を確認する宣言", detect: WILL_SEND_RECEIVE_CHECK_RE, when: isPropertyForecast,
        fix: "「お送りいただき次第、募集状況を確認させて頂きます！！」を1文入れる" },
      { label: "最大限割引した初期費用の御見積書の予告", detect: WILL_SEND_ESTIMATE_FORECAST_RE, when: isPropertyForecast, severity: "warning",
        fix: "「最大限割引しました初期費用の御見積書もあわせてお送りさせて頂きます！！」を続ける" },
      { label: "ご条件に合うお部屋を探す宣言", detect: WILL_SEND_CONDITION_SEARCH_RE, when: (p) => p.sendObject === "condition",
        fix: "「ご条件お送りいただきましたら条件に合ったお部屋探させて頂きます😊！！」を1文入れる" },
      { label: "送付の受け口", detect: WILL_SEND_ACCEPT_RE, when: (p) => CUST_SEND_PERMISSION_RE.test(p.substance.normalized), severity: "warning",
        fix: "「気になるお部屋ございましたらいつでもお送りください😊！！」を先に置く" },
    ],
    mustNot: ["「随時ピックアップしてお送りします」（我々が探す宣言。顧客が物件を送った直後の正解 246件中 0件・(B)場面専用の語彙）", "顧客が『相談』と言っていないのに「ご相談」（正解 (A) 28件中 0件）", "顧客が『検討』『確認』と言っていないのに「ごゆっくり」", "申込誘導", "希少性煽り", "「かしこまりました！！」単独終了"],
    example: "はい😊！！\n気になる物件がございましたらいつでもお気軽にお送りください！！\nお送りいただき次第、募集状況を確認させて頂きます！！最大限割引しました初期費用の御見積書もあわせてお送りさせて頂きます！！",
    examplePremise: "お客様が『気になる物件を後日送る』と予告した場合（このセルの条件そのもの）",
    length: "90〜160字", closer: "open_door", nanisotsu: false },

  { id: "PS_QUESTION", staff: "property_send", customer: "question", precedence: "override_wait",
    tpoLabel: "質問回答（物件送付後）",
    // 2026-09-11 竹内方針1（§3.2・E1-d）: 事実回答で終える実文（8/65）が block されていた → 「次工程」は必須から削除（任意）
    direction: "質問に履歴・知識にある事実のみで直接回答（不明なら「お送り頂きました物件の（対象語）確認させて頂きます」。物件名は書かない）。次工程の1文は任意。100〜160字",
    mustInclude: [
      // 2026-09-11 統合設計（経路C）: 回答判定は hasDirectAnswer（ANSWER_FORM_RE・依頼形の行動宣言・対象付き確認宣言）に統一
      { label: "直接回答 or 対象を復唱した確認宣言", ...DIRECT_ANSWER_DETECT, fix: ANSWER_FIX },
    ],
    mustNot: ["宅建業法上の根拠なし断言（空室・告知事項・入居可能日）", "質問で質問を返す"],
    // 2026-09-11 竹内方針2: 他顧客の物件名（スプランディッド難波WESTⅡのような）と日付（9月13日以降に）を削除（文は足さない）
    example: "〇〇さんお世話になっております！！\n好条件のお部屋はすぐに埋まってしまう可能性が高いお部屋となります！！\nお気に召されたお部屋を一度弊社撮影またはオンライン内見をさせて頂き、お部屋を抑えた状態でご内覧頂くのがオススメです😊！！",
    examplePremise: "人気物件の押さえ方を質問され、撮影・オンライン内見の運用が履歴にある場合",
    exampleRequires: /内覧|内見|見(?:たい|に行)|押さえ|抑え|埋ま|人気/,
    length: "100〜160字", closer: "none", nanisotsu: false },

  { id: "PS_CONDITION_CHANGE", staff: "property_send", customer: "condition_change", precedence: "override_wait",
    tpoLabel: "条件変更（物件送付後）",
    direction: "我々は既に物件を送っている（台帳: {ledger}）。差分条件の復唱＋新条件で{redo}ピックアップ宣言（未来形・まだ探していない。送付済みなので「新たに」「改めて」が使える）＋伴走締め。送付済み物件への言及・「選択肢に残しつつ」等の台帳にない文は足さない。実現可能性の予測・「少ない状況でしたので」の言い訳は禁止。110〜180字",
    mustInclude: [
      { label: "新条件の復唱", detect: /(?:区|駅|線|万円|万以内|万|以下|以内|階|広め|築|LDK|DK|[0-9０-９]K|ワンルーム|徒歩|周辺)/,
        fix: "お客様のメッセージの新条件（区・駅・線・家賃・間取り等）をその語のまま1文に入れる" },
      { label: "{redo}ピックアップ宣言（送付済み前提なので再度／新たに／別の候補 可）", detect: new RegExp(`ピックアップ.{0,20}${DECL_TAIL}`),
        fix: "「〜のご条件で{name}にオススメ出来るお部屋{redo}ピックアップしてお送りさせて頂きます😌！！」の1文にする（条件語はお客様の語のまま）" },
    ],
    mustNot: ["条件の聞き返し", "送付済み物件の再送宣言", "実現可能性の予測（難しい・少ない・可能性）", "条件緩和・代替案の先回り提案", "「少ない状況でしたので広げました」の言い訳（探していない）"],
    example: "かしこまりました！！\n2LDKのご条件で、枚方・高槻・吹田・守口・門真・鶴見区周辺全域から瑞希さんにオススメ出来るお部屋新たにピックアップしてお送りさせて頂きます😌！！\n瑞希さんにご満足頂けるお部屋が見つかるまで全力でサポートさせて頂きます！！",
    examplePremise: "物件送付済み（＝『新たに』が使える）場合",
    length: "110〜180字", closer: "commit_until_found", nanisotsu: false },

  // 探索済み（aix_usage_logs に顧客最新以降の property_send 系がある／AIX物件送付文生成中）の時だけ resolveTurnPair が選ぶ結果報告セル
  { id: "PS_CONDITION_CHANGE_SEARCHED", staff: "property_send", customer: "condition_change", precedence: "override_wait",
    tpoLabel: "条件変更後の再ピックアップ結果報告（探索済み）",
    direction: "新条件で実際にピックアップした結果を送る。「〇〇のご条件ですと合うお部屋が少ない状況でしたので、△△まで広げてピックアップさせて頂きました」の過去形＋実行済み代替のみ可。締めはご査収",
    mustInclude: [{ label: "結果報告（過去形）", detect: /ピックアップ(?:させて(?:頂|いただ)き|いたし|致し)ました|募集(?:ございません|御座いません)でした/,
      fix: "実際にピックアップした結果を過去形で1文報告する（「〜ピックアップさせて頂きました」／無ければ「新着物件募集ございませんでした」。台帳に無い件数・物件名は書かない）" }],
    mustNot: ["未来形の予測（〜可能性がございます）", "全力サポート・何卒の締め"],
    // 2026-09-11 竹内方針2: 他顧客の物件名（メロディーハイム九条203号室）と「選択肢に残しつつ」（PS_CONDITION_CHANGE の禁止文）を削除（文は足さない）
    example: "慶次さんお世話になっております！！\n北区・福島区・西区周辺全域から探させていただいたのですが、以前お送りさせていただいたお部屋以外の新着物件募集ございませんでした。\n新着物件が出次第ピックアップしてお送りさせていただきます！！",
    length: "100〜180字", closer: "receive_check", nanisotsu: false, hedgeAllowed: true },

  { id: "QC_ANSWER", staff: "question_to_customer", customer: "*", precedence: "after_wait",
    tpoLabel: "顧客回答の受領",
    direction: "我々の質問への回答を受領し、その回答を前提にした次工程（見積作成／内覧調整／ピックアップ）を宣言。回答内容への評価コメントは書かない。60〜120字",
    mustInclude: [
      { label: "受領語", detect: /かしこまりました|ありがとうございます/, fix: "「かしこまりました！！」を単独行で置く" },
      { label: "回答を前提にした次工程宣言", detect: new RegExp(`(?:御見積書|お見積書|内覧|ピックアップ|確認|ご案内).{0,30}${DECL_TAIL}`),
        fix: "お客様の回答を前提にした次工程を1文（費用・見積の回答なら「初期費用も最大限割引させていただいたお見積書作成しお送りさせていただきます😊！！」、条件の回答なら「お伺いしたご条件でオススメできるお部屋ピックアップしてお送りさせて頂きます😊！！」）" },
    ],
    mustNot: ["回答内容への評価コメント", "同じ質問の再確認"],
    example: "かしこまりました！！\n初期費用も最大限割引させていただいたお見積書作成しお送りさせていただきます😊！！",
    examplePremise: "お客様の回答が費用・見積に関するもので、estimate verdict が declare の場合",
    exampleRequires: /初期費用|費用|見積|いくら|金額|割引/,
    exampleFallback: "かしこまりました！！\nお伺いしたご条件でオススメできるお部屋ピックアップしてお送りさせて頂きます😊！！",
    length: "60〜120字", closer: "none", nanisotsu: false },

  // ── 孤児 StaffTurnKind の解消: check_result × 任意（ANY_QUESTION 等の `* × customer` より後に効く） ──
  { id: "CR_ANY", staff: "check_result", customer: "*", precedence: "after_wait",
    tpoLabel: "確認結果報告後の応答",
    direction: "我々が募集状況の確認結果を報告した直後の返し。報告済みの内容を再宣言せず、お客様の返答の中身に直接答えてから次の一手を1つだけ宣言する。60〜130字",
    mustInclude: [{ label: "次の一手 or 直接回答",
      detect: new RegExp(`(?:となります|ございます|可能です|(?:出来|でき)ます)|${VIEWING_OFFER_SOFT_RE.source}|(?:ピックアップ|お調べ|ご案内|お送り)(?:させて(?:頂|いただ)き|いたし|致し)ます`), severity: "warning",
      // 2026-09-11 統合設計（経路C）: 回答部分は hasDirectAnswer にそろえる（提案・行動宣言は従来どおり）
      detectFn: (t, p) => hasDirectAnswer(t, p.customer.questionForm ?? null).yes || VIEWING_OFFER_SOFT_RE.test(t) ||
        new RegExp(`(?:ピックアップ|お調べ|ご案内|お送り)(?:させて(?:頂|いただ)き|いたし|致し)ます`).test(t),
      fix: "報告した募集状況を前提にした次の一手（内覧のご案内提案／別候補のピックアップ）を1文だけ宣言する" }],
    mustNot: ["募集状況の再確認宣言（報告済み）", "具体的な候補日時の提示（AIX 専用）"],
    example: "かしこまりました！！\n〇〇さんお気に召されましたらご都合よろしいお日にちにご案内させて頂きます😊！！",
    length: "60〜130字", closer: "none", nanisotsu: false },

  { id: "CP_ACK", staff: "confirmation_promise", customer: "ack_only", precedence: "after_wait",
    tpoLabel: "短い了承（直前スタッフ約束への了承）",
    direction: "既存「短い了承」（promiseEchoNote）と同一。開口語「はい😊！！」→直前約束の復唱WE DO 1文→締め。40〜90字",
    mustInclude: [{ label: "直前約束の復唱WE DO", detect: /(?:確認出来次第|出来次第|次第).{0,20}(?:ご連絡|お送り)/,
      fix: "直前スタッフ発言の約束を対象語のまま「〜確認出来次第ご連絡させて頂きます！！」の1文で復唱する（直前発言に無い対象語は書かない）" }],
    mustNot: ["約束に無い業務語彙（撮影・ご査収・内覧日程）"],
    example: "はい😊！！\n募集状況確認出来次第ご連絡させて頂きます！！",
    length: "40〜90字", closer: "none", nanisotsu: false },

  { id: "ANY_DECLINE", staff: "*", customer: "decline", precedence: "after_wait",
    tpoLabel: "ネガ文脈（顧客自身の断り）",
    direction: "既存 withdrawal direction をそのまま採用",
    mustInclude: [{ label: "扉を開ける1文", detect: /またお部屋探しの際|いつでも/,
      fix: "「またお部屋探しの際はいつでもお気軽にご連絡ください😊！！」を1文入れる" }],
    mustNot: ["引き留め提案", "謝罪"],
    example: "かしこまりました！！\nまたお部屋探しの際はいつでもお気軽にご連絡ください😊！！\nこの度はありがとうございました！！",
    length: "50〜110字", closer: "none", nanisotsu: false },

  // ── 2026-09-11 統合設計（経路D・うえっち事例）: 締め（探索終了・お別れのお礼）。resolveClosing が farewell の時だけ選ぶ（closingOnly）。
  //    成約の締め正解 5/5 件に具体的な行動宣言（ピックアップ・内覧・見積）が無い＝足す系の骨格チェックは適用しない。
  //    example は成約★（舞桜）の実文から氏名を除いたもの。フォールバック文は作らない
  { id: "ANY_FAREWELL", staff: "*", customer: "ack_only", closingOnly: true, precedence: "after_wait",
    tpoLabel: "締め（探索終了・お別れのお礼）",
    direction: "お客様が探索終了・お別れのお礼を返した締めの場面。①受け止め1文（こちらこそ／とんでもございません／ご報告頂きありがとうございます）②直前スタッフがまだ扉を開ける文を送っていない時だけ扉の1文。物件・内覧・見積・申込の前進提案、直前スタッフ文の再掲は書かない",
    mustInclude: [{ label: "扉を開ける1文", detect: /いつでも|またの機会|またお(?:部屋探し|引越し|引っ越し)/, severity: "warning",
      when: (p) => !STAFF_FAREWELL_RE.test(p.lastStaffText),
      fix: "「またお引越しの機会がございましたらいつでもお気軽にご連絡ください！！」を1文入れる" }],
    mustNot: ["物件ピックアップ・内覧・見積・申込の提案", "引き留め", "直前スタッフの扉文・全力サポート文の再掲"],
    example: "ご報告頂きありがとうございます！！\nまたお引越しの機会がございましたらいつでもお気軽にご連絡ください！！",
    examplePremise: "お客様が他で決まった／探索を終えた報告をした場合",
    exampleRequires: /決め|契約|見送|見つか|なくなり|無くなり/,
    length: "直前スタッフが締め済みなら20〜60字、未締めなら80〜130字", closer: "none", nanisotsu: false },

  { id: "ANY_QUESTION", staff: "*", customer: "question", precedence: "override_wait",
    tpoLabel: "質問回答",
    direction: "質問に事実で直接回答→次工程宣言（直前スタッフ種別が不明でも質問は必ず答える）。100〜160字",
    // 2026-09-11 統合設計（経路C・ﾓﾓｶ事例）: 「1時間程度を予定しております」「流れになります」「ございません」を回答と認識できず block していた
    mustInclude: [{ label: "直接回答 or 確認宣言", ...DIRECT_ANSWER_DETECT, fix: ANSWER_FIX }],
    mustNot: ["質問返し", "根拠なし断言"],
    example: "はい！かなり入ってくる可能性は低くなります！換気フィルターの定期的な清掃、防虫フィルターを設置行いますと虫の侵入を防ぐ事が出来ます！！\n内装の色味についてはブラウン基調となります！",
    examplePremise: "虫の侵入・内装色を質問された場合",
    exampleRequires: /虫|換気|内装|色|フィルター/,
    length: "100〜160字", closer: "none", nanisotsu: false },

  { id: "ANY_CONCERN", staff: "*", customer: "concern", precedence: "override_wait",
    tpoLabel: "提案後の懸念",
    direction: "PS_CONCERN と同じ骨格（直前スタッフ種別 other/check_result でも懸念は必ず『事実回答＋条件変換した再ピックアップ』）。{fix}",
    mustInclude: [
      { label: "懸念対象の復唱", detect: /階|お風呂|家賃|初期費用|審査|駅|築|広|日当たり|駐車場|治安|お子様|新生児/, detectFn: concernEchoed,
        fix: "お客様が挙げた懸念対象「{object}」をそのままの語で1文に入れる（お客様が書いていない語は足さない）" },
      { label: "再ピックアップ or 安心材料の事実", detect: new RegExp(`${CONCERN_SEARCH_DECL_RE.source}|多数ございます|可能です`),
        fix: "お客様の懸念を条件語に変換し「〜を中心に{name}にオススメできるお部屋{redo}ピックアップしお送りさせて頂きます！！」の形で1文だけ宣言する（条件語はお客様の懸念から導けるものだけ）" },
    ],
    mustNot: ["共感フレーズ", "「かしこまりました！！」単独終了", "「はい😊！！」開始"],
    example: "かしこまりました😊！！\n夜職・ブラックでもご入居できるお部屋は多数ございますので、審査に通りやすい保証会社中心にお部屋ピックアップさせて頂きます！！\nご不安な点も含めて全力でサポートさせて頂きますので、何卒よろしくお願い致します😌！！",
    examplePremise: "審査・夜職・ブラックの不安を口にした場合",
    exampleRequires: /審査|保証|ブラック|夜職|水商売|滞納|無職|生活保護/,
    length: "100〜160字", closer: "commit_until_found", nanisotsu: true },

  { id: "ANY_WILL_SEND", staff: "*", customer: "will_send_later", precedence: "override_wait",
    tpoLabel: "持込予告",
    direction: "お客様が『自分で気になる物件（または条件）を送る』と予告した。PD_WILL_SEND と同じ骨格。①開口語「はい😊！！」②【核】お送り頂き次第の業務フロー1文（物件＝募集状況確認＋最大限割引の御見積書／条件＝条件に合うお部屋を探す）。我々が探して送る話（随時ピックアップ）・お客様が言っていない「ご相談」「ご検討」は書かない。80〜160字",
    mustInclude: [
      { label: "送られた物件の募集状況を確認する宣言", detect: WILL_SEND_RECEIVE_CHECK_RE, when: isPropertyForecast,
        fix: "「お送り頂きました物件の募集状況確認させて頂きます！！」を1文入れる" },
      { label: "最大限割引した初期費用の御見積書の予告", detect: WILL_SEND_ESTIMATE_FORECAST_RE, when: isPropertyForecast,
        fix: "「最大限割引しました初期費用の御見積書とあわせてご連絡させて頂きます！！」を続ける" },
      { label: "ご条件に合うお部屋を探す宣言", detect: WILL_SEND_CONDITION_SEARCH_RE, when: (p) => p.sendObject === "condition",
        fix: "「ご条件お送りいただきましたら条件に合ったお部屋探させて頂きます😊！！」を1文入れる" },
    ],
    mustNot: ["「随時ピックアップしてお送りします」（(B)『我々に送って』場面専用の語彙。(A) では正解 0/246）", "顧客が言っていない「ご相談」", "顧客が言っていない「ごゆっくり」「ご検討」", "申込誘導", "希少性煽り", "「かしこまりました！！」単独終了"],
    example: "お世話になっております！！\nはい😊！！\n気になるお部屋ございましたらいつでもお送りください！！\nお送り頂きました物件の募集状況確認させて頂き、最大限割引しました初期費用の御見積書とあわせてご連絡させて頂きます！！",
    examplePremise: "お客様が『気になる物件を後日送る』と予告した場合（このセルの条件そのもの）",
    length: "80〜160字", closer: "none", nanisotsu: false },

  // ── ワイルドカード: 残る positive セル（pickup_declared / condition_ask / confirmation_promise / apply_push / other）──
  //    ANY_OTHER / ANY_ANSWER は作らない。other は「証拠が何も立たなかった」ことの指紋であり、
  //    そこにセルを与えると mustInclude が全会話に流れ込む（証拠の不在が検出不能になる）。
  { id: "ANY_POSITIVE", staff: "*", customer: "positive", precedence: "override_wait",
    tpoLabel: "前向き反応",
    // 2026-09-11 竹内方針1（§3.2・E1-f）: 要素は「次の一手を1つ」だけ（開口語の必須は削除。スタッフ実文の「ご案内させて頂きます」「募集状況と初期費用、管理会社に確認」も認める）
    direction: "お客様が前向きな反応（{positiveEvidence}）を返した。次の一手を1つだけ（内見したいと明言していれば「お部屋ご案内させて頂きます😊！！」／内覧のご案内提案／募集状況の確認／御見積書の作成）。物件名・建物名は書かない。具体的な候補日時は書かない。60〜130字",
    mustInclude: [
      { label: "次の一手を1つだけ（ご案内／募集状況の確認／御見積書の作成）", detect: NEXT_MOVE_RE,
        detectFn: (t) => NEXT_MOVE_RE.test(t) || hasDirectAnswer(t, null).form === "answer",
        fix: "お客様が内見したいと明言していれば「お部屋ご案内させて頂きます😊！！」、それ以外は「{viewingOffer}」" },
    ],
    mustNot: ["具体的な候補日時の提示（AIX 専用）", "「ご都合よろしいお日にち御座いますでしょうか」", "条件節なしの裸「〇〇さんご都合よろしいお日にちに」", "申込誘導", "希少性煽り", "「かしこまりました！！」単独終了"],
    example: "かしこまりました😊！！\n〇〇さんお気に召されましたらご都合よろしいお日にちにご案内させて頂きます😊！！",
    length: "60〜130字", closer: "none", nanisotsu: false },
];

export const STAFF_KIND_JA: Record<StaffTurnKind, string> = {
  viewing_invite: "内覧打診", property_send: "物件送付", pickup_declared: "ピックアップ約束（宣言のみ・未履行）", estimate_send: "見積書送付", question_to_customer: "お客様への質問",
  confirmation_promise: "確認の約束", condition_ask: "条件ヒアリング", check_result: "募集状況の確認結果報告", apply_push: "申込打診",
  farewell_ack: "締めの挨拶（扉を開けた）", other: "その他",
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
  /** 2026-09-10 Fable5: 顧客が「送る」と予告した物の種類（will_send_later 以外は "unknown"） */
  sendObject: WillSendObject;
  /** 2026-09-10 Fable5: 証拠ゼロの懸念セルを棄却した記録（tpo_debug / final-check が参照） */
  cellGuard: CellGuard;
  /** セル必須要素 × brain 方針の衝突。route.ts が detectCellConflicts で埋める */
  conflicts: CellConflict[];
  /** 2026-09-10 Fable5: 直前に資料を送ったか／顧客がそれを見た証拠があるか（ご査収感謝の唯一のゲート） */
  materials: MaterialsVerdict;
  /** 顧客が指名した物件（台帳の送付済み物件名との照合が一次証拠。brain current_property は corroboration のみ） */
  namedProperty: NamedPropertyVerdict;
  /** 顧客名（{viewingOffer} リテラルの生成に必要） */
  customerName: string;
  /** 2026-09-11 統合設計（経路D）: 締め verdict（断り・探索終了のお礼）。生成（ANY_FAREWELL/ANY_DECLINE）・検査（isClosedVerdict）・修正プロンプト（REVISION_MODE=closing）・tpo_debug が同じ値 */
  closing: ClosingVerdict;
  /** 2026-09-12 竹内方針B: 顧客が自分から連絡すると予告したか（「ご連絡お待ちしております」の唯一のゲート）。
   *  resolveTurnPair が resolveAwaitContact で1回だけ計算し、締め（resolveCloser）・検査（AWAIT_CONTACT_MISPLACED）が同じ値を見る。
   *  旧 snapshot・テストの手組み PairContext では省略可（省略＝予告なし） */
  awaitContact?: AwaitContactVerdict;
}

// ─────────────────────────────────────────────────────────────
// 6-a. 締め verdict（2026-09-11 統合設計・経路D）
//   成約の締め正解 5/5 件に具体的な行動宣言が無い。締めの場面を表す verdict が無かったため、
//   決定論検査（WE_DO_MISSING_DET / GENERIC_ONLY_REPLY / REPLY_SKELETON_MISSING）が「行動宣言を足せ」と block し、
//   LLM の DOUBLE_DECLARATION が「短く」と指示する矛盾が起きていた（うえっち事例・修正回数切れ）
// ─────────────────────────────────────────────────────────────
export type ClosingVerdict = {
  kind: "decline" | "farewell" | null;
  source: "customer_decline" | "customer_farewell" | "staff_farewell" | "prior_decline" | null;
  evidence: string;
};
export const NO_CLOSING: ClosingVerdict = { kind: null, source: null, evidence: "" };
/** 締め verdict の唯一の判定。decline は往復分類（customer.kind）に従う（route のリスケ除外等を尊重）。
 *  farewell は「定型のお礼だけ」かつ ①直前スタッフ文が締め文 ②1つ前の顧客発言が断り ③顧客文そのものが「お世話になりました／今まで／ご縁」のいずれか。
 *  「本日は内覧ありがとうございました」は ack_only にはなるが farewell にはならない（内覧後の前進場面を締めにしない） */
export function resolveClosing(
  sub: SubstanceVerdict, customer: Pick<CustomerResponse, "kind">, lastStaffText: string, priorCustomerText = "",
): ClosingVerdict {
  if (customer.kind === "decline") return { kind: "decline", source: "customer_decline", evidence: sub.normalized.slice(0, 30) };
  const self = sub.normalized.match(CUST_FAREWELL_SELF_RE);
  if (self && (sub.isAckOnly || !sub.has)) return { kind: "farewell", source: "customer_farewell", evidence: self[0] };
  if (!sub.isAckOnly) return NO_CLOSING;
  const sf = (lastStaffText ?? "").match(STAFF_FAREWELL_RE);
  if (sf) return { kind: "farewell", source: "staff_farewell", evidence: sf[0] };
  const prior = normalizeCustomerText(priorCustomerText);
  if (prior && (CUST_WITHDRAWAL_RE.test(prior) || CUST_DECLINE_RE.test(prior)) && !CUST_NOT_WITHDRAWAL_RE.test(prior))
    return { kind: "farewell", source: "prior_decline", evidence: "直前の顧客発言が断り" };
  return NO_CLOSING;
}

export type CellGuard = {
  /** 懸念セルを棄却して降格したか（証拠ゼロの concern） */
  concernDemoted: boolean;
  demotedFrom: CustomerResponseKind | null;
  demotedTo: CustomerResponseKind | null;
  reason: string | null;
};

/** {redo}: 台帳に物件送付実績がある時だけ「再度」。生成 direction／検査 label／final-check suggestion が同じ関数 */
export function redoWord(ledger: ActionLedger | null | undefined): string { return ledger && ledger.facts.propertiesSentCount > 0 ? "再度" : ""; }

export function resolveTurnPair(
  staff: StaffTurn, customer: CustomerResponse, substance: SubstanceVerdict, lastStaffText: string,
  opts: { searched?: boolean; ledger?: ActionLedger | null; customerName?: string; brainCurrentProperty?: string | null;
    /** 2026-09-11 統合設計（経路D）: 直前スタッフ発言より前の顧客発言（断り→スタッフ締め→お礼 の往復で farewell を立てる） */
    priorCustomerText?: string | null } = {},
): PairContext {
  // 2026-09-09 Fable5: 同一セルに「未探索（宣言型）」と「探索済み（結果報告型・hedgeAllowed）」がある時は resolveHedgeAllowance の searched で選ぶ
  // 「探索済み」＝顧客最新発言より後の送付（hedgeAllowed セル選択）。全期間の propertiesSentCount は {redo} 用で混同しない
  const searched = !!opts.searched || !!opts.ledger?.facts.propertiesSentSinceCustomerLatest;

  // 2026-09-10 Fable5 みく事例: 懸念セルは「懸念の対象語が本文に実在する」時だけ引く。
  // customer.object===null かつ substance.concerns===[] は「懸念の証拠が本文に一切ない」ことの決定的な指紋であり、
  // 従来はその状態でも PS_CONCERN が選ばれ direction が「懸念（）」と空括弧でレンダリングされていた。
  // classifyCustomerResponse 側は型で保証済みだが、check-reply 経路・古い snapshot 復元経路のための二重防護。
  const concernUnanchored =
    customer.kind === "concern" && !customer.object && substance.concerns.length === 0;
  const effectiveKind: CustomerResponseKind = concernUnanchored
    ? (substance.waitSignal.yes ? "thinking" : substance.isPureBoilerplate ? "ack_only" : "other")
    : customer.kind;
  const cellGuard: CellGuard = concernUnanchored
    ? { concernDemoted: true, demotedFrom: "concern", demotedTo: effectiveKind,
        reason: `懸念の対象語ゼロ（object=null / concerns=[] / residue="${substance.residue.slice(0, 20)}"）` }
    : { concernDemoted: false, demotedFrom: null, demotedTo: null, reason: null };
  if (concernUnanchored) console.warn("[turn-pair] concern demoted:", cellGuard.reason, "→", effectiveKind);
  // summary 以降は effectiveKind を使う（tpo_debug に降格の事実が残る）
  const custForCtx: CustomerResponse =
    concernUnanchored
      ? { kind: effectiveKind as Exclude<CustomerResponseKind, "concern">, object: null,
          secondary: customer.secondary, evidence: customer.evidence, source: customer.source, positive: customer.positive,
          questionForm: customer.questionForm ?? null }
      : customer;

  // 2026-09-11 統合設計（経路D）: 締め verdict が立つ時はセル探索より先に確定（CR_ANY 等の「次の一手を宣言」セルを締めに当てない）
  const closing = resolveClosing(substance, custForCtx, lastStaffText ?? "", opts.priorCustomerText ?? "");
  // 2026-09-12 竹内方針B: 顧客の連絡予告（締め・検査が同じ verdict を見る）
  const awaitContact = resolveAwaitContact({ customerMessage: substance.normalized, priorCustomerText: opts.priorCustomerText ?? "", substance, ledger: opts.ledger ?? null });
  const pool = PAIR_MATRIX.filter((r) => !r.closingOnly);
  const exact = pool.filter((r) => r.staff === staff.kind && r.customer === effectiveKind);
  const rule =
    closing.kind === "farewell" ? (PAIR_MATRIX.find((r) => r.id === "ANY_FAREWELL") ?? null)
    : closing.kind === "decline" ? (PAIR_MATRIX.find((r) => r.id === "ANY_DECLINE") ?? null)
    : (searched ? exact.find((r) => r.hedgeAllowed) : exact.find((r) => !r.hedgeAllowed)) ??
      exact[0] ??
      pool.find((r) => r.staff === "*" && r.customer === effectiveKind) ??
      pool.find((r) => r.staff === staff.kind && r.customer === "*") ??
      null;
  const summary =
    `${STAFF_KIND_JA[staff.kind]} → ${CUSTOMER_KIND_JA[effectiveKind]}` +
    (custForCtx.secondary.length ? `＋${custForCtx.secondary.map((k) => CUSTOMER_KIND_JA[k]).join("・")}` : "") +
    (substance.concerns.length ? `（懸念: ${substance.concerns.map((c) => `${c.label}「${c.phrase}」`).join("、")}）` : "") +
    (custForCtx.object && !substance.concerns.length ? `（対象: ${custForCtx.object}）` : "") +
    (closing.kind ? `｜締め: ${closing.kind === "farewell" ? "探索終了・お別れのお礼" : "断り"}（${closing.evidence}）` : "") +
    (opts.ledger ? `｜台帳: ${opts.ledger.summary}` : "");
  // 2026-09-10 Fable5: 予告の対象（物件／条件／書類）。要素④の中身と見積予告の要否を決める唯一の分岐軸（state 非依存）
  const sendObject: WillSendObject =
    effectiveKind === "will_send_later" || custForCtx.secondary.includes("will_send_later")
      ? classifyWillSendObject(substance.normalized) : "unknown";
  // 2026-09-10 Fable5 Sさん事例: 物件名の指名（台帳照合が一次証拠）と資料送付の往復（ご査収感謝のゲート）
  const namedProperty = resolveNamedProperty(substance, opts.ledger ?? null, opts.brainCurrentProperty ?? null);
  const materials = resolveMaterialsContext(lastStaffText ?? "", substance, opts.ledger ?? null, custForCtx.positive, namedProperty);
  return { staff, customer: custForCtx, substance, rule, ruleId: rule?.id ?? null, summary,
           lastStaffText: lastStaffText ?? "", ledger: opts.ledger ?? null, redo: redoWord(opts.ledger),
           sendObject, cellGuard, conflicts: [],
           materials, namedProperty, customerName: opts.customerName ?? "", closing, awaitContact };
}

/** {object}/{fix}/{redo}/{ledger}/{sentNames} の置換（生成・検査・note の三者が同じ関数）。
 *  2026-09-10 Fable5: 旧実装の `|| "ご希望条件のお部屋を中心に"` は「懸念の実体がゼロの時にこそ汎用の条件復唱文を供給する」
 *  仕様で、LLM がその空欄を brain の repeated_concern と過去条件で埋める入口になっていた。廃止する。 */
// ─── 2026-09-11 統合設計（経路B）: 顧客名スロット ───────────────────────────────
//   {name} と「〇〇さん」を同じ規則で埋める（生成ノート・検査 suggestion・修正ループ・後処理 validateAndClean が同じ関数）。
//   aix-template-generate の fixNamePlaceholderAddress と同じ挙動: 名前不明なら呼びかけ＋直結助詞ごと削除。
//   名前以外の 〇〇 スロット（エリア・条件・動詞）は自動で埋めない（BANNED_WORD〇〇 の block はそのまま残す）
const NAME_SLOT_RE = /(?:\{name\}|[〇○]{2,}\s*(?:さん|サン|様|さま))([、,]?[ 　]*)([のがにをへ])?/g;
export function fillNameSlot(text: string, customerName: string | null | undefined): string {
  const n = (customerName ?? "").trim();
  let hit = false;
  const out = (text ?? "").replace(NAME_SLOT_RE, (_m, tail: string, particle: string | undefined) => {
    hit = true;
    if (n) return `${n}さん${tail}${particle ?? ""}`;
    // 名前不明: 呼びかけごと削除。直結した助詞も落とす（「〇〇さんにオススメ」→「オススメ」）。読点で離れた助詞は次の文の一部なので残す
    return tail === "" ? "" : (particle ?? "");
  });
  return hit ? out.replace(/^[、,　 ]+/gm, "") : out;
}

// ─── 2026-09-11 統合設計（経路E1）: ピックアップのラウンド（PD_* の「まだ1件も送っていない」相当の文言の唯一の出所）───
export type PickupRound = { round: "first" | "next"; sentBefore: number; promiseOpen: boolean; note: string };
export function pickupRound(ledger: ActionLedger | null | undefined): PickupRound {
  const n = ledger?.facts.propertiesSentCount ?? 0, open = !!ledger?.facts.pickupPromisedUnfulfilled;
  return n === 0
    ? { round: "first", sentBefore: 0, promiseOpen: open, note: "物件はまだ1件も送っていない" }
    : { round: "next", sentBefore: n, promiseOpen: open, note: `物件は${n}件送付済み・その後の新しいピックアップ宣言は未履行` };
}

// ─── 2026-09-11 統合設計（経路F1・YUYA/it_0 事例）: ピックアップ再宣言ゲートの唯一の解除判定 ───
//   aixDone.propertySend（aix_usage_logs 72h 窓）だけで「送付済み＝再宣言禁止」にすると、送付後にスタッフが出した
//   新しいピックアップ宣言・顧客の条件変更に対する必須要素（PD_* / ANY_CONDITION_CHANGE）まで後処理が削除していた。
//   生成ノート（aixDoneAckNote）・後処理（enforceAixGates）・検査（finalCheckCtx.aixDone）が同じ値を見る
export type PickupGateVerdict = { redeclareBlocked: boolean; reason: string };
export function resolvePickupGate(aixPropertySendRecent: boolean, pair: PairContext): PickupGateVerdict {
  if (!aixPropertySendRecent) return { redeclareBlocked: false, reason: "72h以内のAIX物件送付なし" };
  const f = pair.ledger?.facts;
  const sentAt = Date.parse(f?.lastPropertiesSentAt ?? ""), promAt = Date.parse(f?.pickupPromisedAt ?? "");
  if (f?.pickupPromisedUnfulfilled && (!Number.isFinite(sentAt) || (Number.isFinite(promAt) && promAt > sentAt)))
    return { redeclareBlocked: false, reason: `送付後の未履行ピックアップ宣言（${f.pickupPromisedAt ?? "時刻不明"}）` };
  if (pair.customer.kind === "condition_change" || pair.customer.secondary.includes("condition_change"))
    return { redeclareBlocked: false, reason: "顧客の条件変更（往復文脈 verdict）" };
  if ((pair.rule?.mustInclude ?? []).some((m) => (!m.when || m.when(pair)) && /ピックアップ/.test(m.label)))
    return { redeclareBlocked: false, reason: `セル ${pair.ruleId} がピックアップ宣言を必須要素に持つ` };
  return { redeclareBlocked: true, reason: "AIX送付済み・新規依頼なし" };
}

/** 2026-09-11 統合設計（経路A/S2）: 生成（buildTurnPairNote）と修正プロンプトが同じ前提ゲートで example を選ぶ唯一の関数。
 *  前提不成立で fallback も無い時は text=null（修正経路には例文を渡さない） */
export function selectPairExample(pair: PairContext, customerMessage: string): { text: string | null; raw: string | null; premiseOk: boolean } {
  const r = pair.rule;
  if (!r) return { text: null, raw: null, premiseOk: false };
  if (r.exampleBySent) {
    const raw = (pair.ledger?.facts.propertiesSentCount ?? 0) > 0 ? r.exampleBySent.sent : r.exampleBySent.none;
    return { text: fillPairPlaceholders(raw, pair), raw, premiseOk: true };
  }
  const premiseOk = !r.exampleRequires || r.exampleRequires.test(normalizeCustomerText(customerMessage));
  const raw = premiseOk ? r.example : (r.exampleFallback ?? null);
  return { text: raw ? fillPairPlaceholders(raw, pair) : null, raw, premiseOk };
}

/** トークン置換のみ（{object}/{fix}/{redo}/{ledger}/{sentNames}/{positiveEvidence}/{namedProperty}/{viewingOffer}/{pickupRoundNote}）。
 *  mustNot（禁止パターンの引用「〇〇さんご都合…」の意味を変えない）はこちらだけを通す。{name} は fillNameSlot が助詞ごと扱う */
export function fillPairTokens(s: string, pair: PairContext): string {
  const object = pair.customer.kind === "concern" ? pair.customer.object : (pair.substance.concerns[0]?.phrase ?? "");
  // fix は「顧客が書いた対象語」から決定論で導く（成約データに無い文を作らないため、汎用フォールバックは持たない）
  const fixFromObject = (o: string): string =>
    CONCERN_RULES.find((r) => r.strongRe?.test(o) || r.topicRe?.test(o))?.fix ?? "";
  const fix = pair.substance.concerns.map((c) => c.fix).join("、") || (object ? fixFromObject(object) : "");
  assertPlaceholder(s, "{object}", object, pair);
  assertPlaceholder(s, "{fix}", fix, pair);
  return s
    .replace(/\{object\}/g, object).replace(/\{fix\}/g, fix)
    .replace(/\{redo\}/g, pair.redo)
    .replace(/\{ledger\}/g, pair.ledger?.summary ?? "記録なし")
    // 2026-09-11 竹内方針2（E3-e/f）: 物件名・建物名は生成の文面に出さない（照合用の事実 propertiesSentNames / namedProperty は内部に残す）。
    //   号室付き物件名を含む下書き 204件のうち 42件（21%）をスタッフが削除・別物件に変更した
    .replace(/\{sentNames\}/g, "送付済みのお部屋")
    // 2026-09-10 Fable5 Sさん事例。{viewingOffer} は常に非空リテラル（assertPlaceholder は掛けない）
    // 2026-09-11 竹内方針2: 顧客の前向き反応の引用からも物件名は外す（「〇〇気になります」→「お部屋気になります」）
    .replace(/\{positiveEvidence\}/g, pair.namedProperty.asWritten
      ? (pair.customer.positive?.evidence ?? "").split(pair.namedProperty.asWritten).join("お部屋")
      : (pair.customer.positive?.evidence ?? ""))
    .replace(/\{namedProperty\}/g, "お部屋")
    .replace(/\{viewingOffer\}/g, viewingOfferLiteral(pair.customerName, pair.namedProperty.matchedSent, pair.namedProperty.count))
    .replace(/\{pickupRoundNote\}/g, pickupRound(pair.ledger).note);
}
/** {object}/{fix}/{redo}/{ledger}/… の置換＋顧客名スロット（生成・検査・note の三者が同じ関数）。
 *  example / exampleFallback / direction / fix / label は全部これを通す */
export function fillPairPlaceholders(s: string, pair: PairContext): string {
  return fillNameSlot(fillPairTokens(s, pair), pair.customerName);
}

/** 開発時アサート: 証拠が無いのにセルが選ばれた瞬間に落ちる。本番は console.error + tpo_debug 行きにする */
function assertPlaceholder(tpl: string, token: string, value: string, pair: PairContext): void {
  if (!tpl.includes(token) || value) return;
  const msg = `[pair-placeholder] ${token} が空のまま ${pair.ruleId} をレンダリングしようとした` +
    `（customer=${pair.customer.kind} object=${(pair.customer as { object?: string | null }).object ?? "null"}` +
    ` concerns=${pair.substance.concerns.length} residue="${pair.substance.residue.slice(0, 20)}"）`;
  if (process.env.NODE_ENV !== "production") throw new Error(msg);
  console.error(msg);
}

/** 方向指示文（決定論リテラル）。{object}/{fix}/{redo}/{ledger} を実値に置換し、fresh brain の reply_direction は末尾に「参考」で添える */
export function buildPairDirection(
  pair: PairContext,
  opts: { brainReplyDirection?: string | null; brainFresh: boolean; strategy?: BrainConversationScope | null },
): string | null {
  if (!pair.rule) return null;
  const dir = fillPairPlaceholders(pair.rule.direction, pair);
  // 2026-09-10 Fable5: when が false の要素（この場面に無い要素）は direction にも出さない
  const avoids = opts.brainFresh ? (opts.strategy?.avoid_topics ?? []) : [];
  const must = pair.rule.mustInclude.filter((m) => !m.when || m.when(pair)).map((m, i) => {
    const pick = m.preferWhenAvoid?.find((p) => avoids.some((t) => p.avoid.test(t)));
    return `${i + 1}.${fillPairPlaceholders(m.label, pair)}${pick ? `【この場面では必ず → ${pick.use}】` : ""}`;
  }).join(" ");
  const ref = opts.brainFresh && opts.brainReplyDirection ? ` brain方向性（参考）:「${opts.brainReplyDirection}」` : "";
  return `${dir}。必須要素: ${must}。禁止: ${pair.rule.mustNot.map((x) => fillPairTokens(x, pair)).join("／")}${ref}`;
}

/** dynamicBlock に注入する【往復文脈】ブロック（tpoGuidanceNote より上位・ハードゲートの次） */
export function buildTurnPairNote(
  pair: PairContext, customerMessage: string, customerName: string,
  opts: { strategy?: BrainConversationScope | null; brainFresh?: boolean } = {},
): string {
  const staffJa = STAFF_KIND_JA[pair.staff.kind];
  const custJa = CUSTOMER_KIND_JA[pair.customer.kind];
  const object = pair.customer.object ?? pair.substance.concerns[0]?.phrase ?? "";
  const avoids = opts.brainFresh === false ? [] : (opts.strategy?.avoid_topics ?? []);
  const lines: string[] = [];
  lines.push("【🔁 往復文脈 — 最上位（「場面と返信方針」より上位・ハードゲートの次）】");
  lines.push(`この返信は「我々が直前に送った〈${staffJa}〉」に対して、お客様が「〈${custJa}〉${object ? `（対象: ${object}）` : ""}」を返してきた、その返しである。単発メッセージへの相槌ではない。`);
  lines.push(`- 我々の直前発言（${staffJa}／根拠: ${pair.staff.source}${pair.staff.evidence ? "=" + pair.staff.evidence.slice(0, 40) : ""}）: 「${pair.lastStaffText.replace(/\s+/g, " ").slice(0, 160)}」`);
  // 2026-09-09 行動台帳: 「我々が既にしたこと」を往復文脈の前提として明示（宣言≠実行）
  // 2026-09-11 統合設計（経路E1）: 「約束の維持」注記は送付件数ではなく未履行約束の有無で出す（2回目以降の宣言でも同じ）
  if (pair.ledger) lines.push(`- 我々が既にしたこと（行動台帳・確定事実）: ${pair.ledger.summary}${pair.ledger.facts.pickupPromisedUnfulfilled ? ` → 直前の宣言はまだ履行していない（${pickupRound(pair.ledger).note}）。この返信は『約束の維持』であって『やり直し』ではない` : ""}`);
  lines.push(`- お客様の返答（${custJa}${pair.customer.secondary.length ? " ＋ " + pair.customer.secondary.map((k) => CUSTOMER_KIND_JA[k]).join("・") : ""}）: 「${customerMessage.split(MSG_SEP).join(" ／ ").replace(/\s+/g, " ").slice(0, 200)}」`);
  if (pair.rule) {
    lines.push(`- → この返信の役割: ${fillPairPlaceholders(pair.rule.direction, pair)}`);
    lines.push("- 必須要素（それぞれ本文で1文以上・欠けたら不合格）:");
    const actives = pair.rule.mustInclude.filter((m) => !m.when || m.when(pair));
    actives.forEach((m, i) => {
      const pick = m.preferWhenAvoid?.find((p) => avoids.some((t) => p.avoid.test(t)));
      lines.push(`  ${["①", "②", "③", "④", "⑤"][i] ?? i + 1} ${fillPairPlaceholders(m.label, pair)}${pick ? `【この場面では必ず → ${pick.use}】` : ""}`);
    });
    lines.push(`- 禁止: ${pair.rule.mustNot.map((x) => fillPairTokens(x, pair)).join(" / ")}`);
    // 2026-09-11 統合設計（経路C/Q3）: 質問セルでは回答の形の語彙を生成にも渡す（生成と検査が同じ語彙を見る）
    if (pair.customer.kind === "question") {
      lines.push(`- 回答の形（検査はこの形で「回答している」と判定する）: 「〜となります／〜でございます／〜しております／〜ございません／〜予定です」${pair.customer.questionForm === "request" ? "。この質問は我々の行動を求める依頼形なので「かしこまりました！！」＋依頼の語を復唱した行動宣言が回答になる" : ""}`);
    }
    // 2026-09-10 Fable5 あみ事例: example は「ある前提が成立していた場面の実文」。前提が今回成立していないなら文をそのまま渡さない
    // 2026-09-11 統合設計（経路A/B）: 選択は selectPairExample（修正プロンプトと同じ前提ゲート）。顧客名スロットも埋める
    const sel = selectPairExample(pair, customerMessage);
    const ex = sel.text ?? fillPairPlaceholders(pair.rule.example, pair);
    const nameHint = customerName ? `顧客名は「${customerName}さん」` : "顧客名不明: 呼びかけは書かない";
    if (pair.rule.examplePremise && !sel.premiseOk) {
      lines.push(`- 型（⚠ この成約実例は【${pair.rule.examplePremise}】の場面のもので、今回のお客様のメッセージにはその前提が**無い**。骨格（開口語→受け→行動宣言→締めの並びと文体）だけを真似し、文はそのまま使わない。前提に依存する語（ご相談・ご検討・随時ピックアップ等）は1語も持ち込まない）:`);
    } else if (pair.rule.examplePremise) {
      // 2026-09-11 竹内方針2（E3-e）: 旧文言「物件名は今回の会話の事実に置換」は物件名を書けという指示になっていた
      lines.push(`- 型（成約実例。前提【${pair.rule.examplePremise}】は今回も成立している。文体・テンポ・構成を踏襲し、エリアは今回のお客様の表記に置換。物件名・号室は書かない（「お送り頂きました物件」で受ける）。${nameHint}）:`);
    } else {
      lines.push(`- 型（成約実例。文体・テンポ・構成を踏襲し、エリアは今回のお客様の表記に置換。物件名・号室は書かない（「お送り頂きました物件」で受ける）。${nameHint}）:`);
    }
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
  await_contact: () => "ご連絡お待ちしております😊！！",
  none: () => "",
};

// ─── 2026-09-12 竹内方針B: 「ご連絡お待ちしております」は顧客が自分から連絡すると予告した時だけ ─────────────────
//   スタッフ手打ち 6,107通中12通。10通は顧客の連絡予告の直後、2通は顧客側が次に動く場面（お待ちいただけますか／予告の後の了承）。
//   依頼・質問の直後は0通（下書きにあっても 3/3 件削除）。条件付きの予告（〜次第・〜あれば）の後は 0/11 件で、
//   代わりに「〜ましたらお気軽にご連絡ください」と条件をなぞって返していた。検討・相談してから連絡 は 4/13 件（既定の wait_softly のまま）。
/** 顧客が自分から連絡すると言っている */
export const CUSTOMER_WILL_CONTACT_RE =
  /(?:ご?連絡|れんらく|お?返事|返信)(?:は|を)?(?:させて(?:頂|いただ|もら)(?:い|き)?ます|させてもらいます|します|いたします|致します|入れます|する(?=[ねよのかわ！!。\s〜ー]|$))/;
/** 条件付きの予告（決まり次第・分かったら・何かあれば 連絡します） */
export const CONDITIONAL_CONTACT_RE = /(?:次第|あれば|ありましたら|(?:決まっ|分かっ|わかっ|でき|出来)たら|際(?:に|は))[^。！!\n]{0,8}(?:ご?連絡|れんらく|お?返事|返信)/;
/** 検討・相談・確認してから連絡（検討中の待ち句＝wait_softly の担当） */
const THINK_THEN_CONTACT_RE = /(?:検討|考え|相談|確認|見て|拝見)(?:して|し)?(?:から|また|改めて|の上で?|次第)[^。！!\n]{0,6}(?:ご?連絡|れんらく|お?返事|返信)/;
/** 顧客が「待って」と依頼（「1日ほどお待ちいただけますか」） */
const CUSTOMER_WAIT_REQUEST_RE = /(?:お待ち|待って)(?:いただけ|頂け|もらえ|ください|下さい|て(?:ください|下さい|もらえ))/;
/** 本文の「ご連絡お待ちしております」（検査・stance が同じ定義を見る） */
export const AWAIT_CONTACT_PHRASE_RE = /ご連絡(?:の程)?(?:を)?お待ちしております/;
const CONTACT_TIMING_RE = /本日|今日|明日|明後日|今週中|来週|週末|[月火水木金土日]曜(?:日)?|帰宅後|[0-9０-９]{1,2}月(?:中旬|上旬|下旬|頃|中)?/;
export type AwaitContactVerdict = {
  /** 「ご連絡お待ちしております」で締めてよい */
  allowed: boolean;
  /** 条件付きの予告（〜次第・〜あれば）。締めは条件をなぞる open_door */
  conditional: boolean;
  /** 条件付きの予告の条件部分を「〜ましたら」にした語（「決まりましたら」）。作れない時は null */
  conditionEcho: string | null;
  /** 顧客の文の時期（「明日」→「明日のご連絡お待ちしております」）。無ければ null */
  timingEcho: string | null;
  reason: string;
};
export const NO_AWAIT_CONTACT: AwaitContactVerdict = { allowed: false, conditional: false, conditionEcho: null, timingEcho: null, reason: "" };
/** 条件部分を「〜ましたら」に言い換える（決まり次第→決まりましたら／分かったら→分かりましたら／何かあれば→何かございましたら） */
function conditionEchoOf(text: string): string | null {
  const m = /([一-龯ぁ-んァ-ヶー]{0,6}?)(次第|あれば|ありましたら|(?:決まっ|分かっ|わかっ|でき|出来)たら)/.exec(text);
  if (!m) return null;
  const stem = m[1], tail = m[2];
  if (tail === "あれば" || tail === "ありましたら") return `${/^(?:何か|なにか)$/.test(stem) || !stem ? "何か" : stem}ございましたら`;
  if (tail === "次第") {
    if (!stem || /[をがはに]$/.test(stem)) return null;
    return `${stem}ましたら`;
  }
  const past = tail.replace(/ったら$/, "りましたら").replace(/(でき|出来)たら$/, "$1ましたら");
  return `${stem}${past}`;
}
/**
 * 顧客が自分から連絡すると予告したか（締めの唯一の判定）。allowed は次のどちらかで、どちらもスタッフ側に未履行のピックアップ約束が無いこと:
 *   (a) 今回の顧客発言が条件の付かない連絡予告で、依頼・質問・条件を含まない（検討してから連絡 は除く）／顧客が「お待ちいただけますか」と頼んだ
 *   (b) 今回が了承・お礼だけで、1つ前の顧客発言が連絡予告か「お待ちいただけ」の依頼
 */
export function resolveAwaitContact(input: {
  customerMessage: string; priorCustomerText?: string | null; substance: Pick<SubstanceVerdict, "kinds" | "isAckOnly">; ledger?: ActionLedger | null;
}): AwaitContactVerdict {
  const cur = (input.customerMessage ?? "").replace(/\r/g, "");
  const prior = (input.priorCustomerText ?? "").replace(/\r/g, "");
  const kinds = input.substance.kinds ?? [];
  const hasAsk = kinds.includes("request") || kinds.includes("question") || kinds.includes("condition");
  const pickupOpen = !!input.ledger?.facts.pickupPromisedUnfulfilled;
  const timingOf = (s: string): string | null => { const t = CONTACT_TIMING_RE.exec(s)?.[0] ?? null; return t === "今日" ? "本日" : t; };
  const isPlainWillContact = (s: string) => CUSTOMER_WILL_CONTACT_RE.test(s) && !CONDITIONAL_CONTACT_RE.test(s) && !THINK_THEN_CONTACT_RE.test(s);
  if (CONDITIONAL_CONTACT_RE.test(cur) && CUSTOMER_WILL_CONTACT_RE.test(cur) && !THINK_THEN_CONTACT_RE.test(cur) && !hasAsk)
    return { allowed: false, conditional: true, conditionEcho: conditionEchoOf(cur), timingEcho: null, reason: "条件付きの連絡予告（0/11件）→条件をなぞって「〜ましたらお気軽にご連絡ください」" };
  if (pickupOpen) return { ...NO_AWAIT_CONTACT, reason: "スタッフ側に未履行のピックアップ約束がある（待つのはお客様）" };
  if (CUSTOMER_WAIT_REQUEST_RE.test(cur))
    return { allowed: true, conditional: false, conditionEcho: null, timingEcho: timingOf(cur), reason: "顧客が「お待ちいただけますか」と依頼（ハル事例）" };
  if (isPlainWillContact(cur) && !hasAsk)
    return { allowed: true, conditional: false, conditionEcho: null, timingEcho: timingOf(cur), reason: "顧客が自分から連絡すると予告（スタッフ実送信12件中10件）" };
  if (input.substance.isAckOnly && prior && (isPlainWillContact(prior) || CUSTOMER_WAIT_REQUEST_RE.test(prior)))
    return { allowed: true, conditional: false, conditionEcho: null, timingEcho: timingOf(prior), reason: "連絡予告の後の了承（次に動くのはお客様）" };
  return NO_AWAIT_CONTACT;
}
/** await_contact の締め文（時期があれば「明日のご連絡お待ちしております」） */
export function awaitContactCloserText(v: AwaitContactVerdict | null | undefined): string {
  return `${v?.timingEcho ? v.timingEcho + "の" : ""}ご連絡お待ちしております😊！！`;
}
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
  const mk = (closer: CloserKind, nanisotsu: boolean, reason: string, bodyOverride?: string): CloserVerdict => {
    // セルが nanisotsu を明示（PD_CONDITION_CHANGE＝みく 11:48 実送信は直前の何卒に続けて何卒）する時は直前の何卒で抑制しない
    const n = nanisotsu && (!priorNanisotsu || pair.rule?.nanisotsu === true);
    const body = bodyOverride ?? CLOSER_TEXT[closer](name);
    return { closer, nanisotsu: n, text: [body, n ? NANISOTSU_TEXT : ""].filter(Boolean).join("\n"), reason };
  };
  const ac = pair.awaitContact ?? NO_AWAIT_CONTACT;
  if (c === "decline") return mk("none", false, "断り→扉1文で終える（引き留め・謝罪・サポート宣言なし）");
  // 2026-09-10 Fable5: 持込予告はセルが締めを持つ（PD/ANY=none：受け宣言で終える／ES=open_door：直前の見積物件の扉を開ける）。
  //   本文の「最大限割引した御見積書」は未来形の予告であって成果物添付ではないため deliverableAttached より先に判定する
  if (c === "will_send_later") return mk(pair.rule?.closer ?? "open_door", pair.rule?.nanisotsu ?? false, "持込予告→先取り宣言で終える（セル指定）");
  if (sig.deliverableAttached) return mk("receive_check", false, "成果物添付→ご査収一択（正解674件／property_send 系で全力・何卒は0件）");
  if (sig.scheduleFixed) return mk("none", false, "日程確定・打診→疑問形/確定文で終える（断定削除22件・何卒削除26件の型）");
  // 2026-09-12 竹内方針B: 顧客の連絡予告（resolveAwaitContact）。検討中（wait_softly）より先に判定する
  if (ac.allowed) return mk("await_contact", false, ac.reason, awaitContactCloserText(ac));
  if (ac.conditional)
    return mk("open_door", false, ac.reason, `${ac.conditionEcho ?? "気になる点出てきましたら"}いつでもお気軽にご連絡ください😌！！`);
  if (c === "thinking") return mk("wait_softly", false, "検討中→ごゆっくり＋扉。急かし禁止");
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
/** 間取りの大文字化（2ldk→2LDK）。顧客文・下書きの両方にかける */
const upperLayout = (s: string) => s.replace(/([1-4１-４])\s*(ldk|sldk|dk|k|r)(?![a-zA-Z])/gi, (_m, n: string, l: string) => `${n}${l.toUpperCase()}`);
export const ECHO_TOKEN_RE = /[0-9.〜~]+(?:万円?以内|万円?|万以内|円|帖|畳|㎡|平米|分以内|分|年以内|年|階|月|日|時)|[1-4](?:LDK|DK|K|R)|ワンルーム|[一-龯ァ-ヶー]{1,8}(?:駅|線|区|市|町)|カウンターキッチン|対面キッチン|独立洗面|バストイレ別|オートロック|ペット可?|駐車場|鉄筋|RC|木造|鉄骨|フリーレント|敷金|礼金|南向き|角部屋/g;

// ─── 2026-09-11 竹内方針2（統合設計 §2 方針2・§5.1）: 顧客文書の場面を決める唯一の関数 ─────────────────
//   復唱（生成の stanceNote・検査 CONDITION_ECHO・学習 echo_ratio・PAIR 必須要素）と懸念判定（analyzeSubstance）が同じ verdict を見る。
//   ・物件送付（URL・物件情報の貼付・スクショ書き起こし）と申込フォームは復唱しない（正解の復唱 0/18・0/4）→ tokens=[]
//   ・物件名・建物名・号室・所在階・住所・日付は復唱トークンにしない（物件名を入れ間違える危険・スタッフの復唱率 9%）
/** 条件フォーム（①〜⑧／【…】⇒）。line-reply-prompts は本定義を再 export する（循環 import 禁止のため定義はこちら） */
export function isConditionFormMessage(msg: string): boolean {
  const m = (msg ?? "").trim().slice(0, 800);
  const circled = (m.match(/[①②③④⑤⑥⑦⑧⑨⑩]/g) ?? []).length;
  return /【[^】]{1,12}】\s*[⇒→:：]/.test(m) || circled >= 2;
}
/** スタッフのフォームテンプレートの貼り返し（顧客が末尾ごと返してくる・90件中41件）。懸念判定・復唱の前に剥がす */
export const TEMPLATE_ECHO_RE = /_{5,}[\s\S]*$|※\s*審査に不安な事がある方[^\n]*|審査面柔軟にサポートさせて頂きます[！!]?|【お部屋お探し中！?】|（[^）\n]{0,20}ご希望のお部屋探しご条件）/g;
const APPLICATION_FORM_STRONG_RE = /お申込者様記入欄|記入欄|緊急連絡先欄|連帯保証人欄/;
const APPLICATION_FORM_FIELD_RE = /生年月日|勤続年数|年収|勤務先(?:名|住所)?|現住所|緊急連絡先/g;
const PROPERTY_SHARE_RE = /https?:\/\/|物件名[：:]|号室|問い合わせ番号|お問合せ番号|賃貸(?:住宅)?情報|管理費\s*[0-9０-９]|階建|by SUUMO|LIFULL|suumo|homes\.co|athome|canary|smocca|スマイティ|【画像】|\[画像\]/i;
const CONDITION_WORD_RE = /家賃|予算|万円|エリア|駅|線|徒歩|間取り|[1-4１-４](?:LDK|DK|K|R)|ワンルーム|築|向き|設備|オートロック|バストイレ|独立洗面|駐車場|ペット|[一-龯]{1,6}(?:区|市|町)|付近|周辺|以内|以上/i;
export type CustomerDocScope = "application_form" | "condition_form" | "property_share" | "condition_freeform" | "none";
export type CustomerDocScopeVerdict = {
  scope: CustomerDocScope;
  /** テンプレート貼り返しとフォームラベルを剥がした本文（懸念判定・復唱が共有） */
  body: string;
  /** 復唱対象トークン（物件送付・申込フォームでは空） */
  tokens: string[];
  /** お客様のエリア表記（周辺・付近・駅・沿線を除いた語） */
  areaWords: string[];
};
const PREF_START_RE = /^(?:北海道|東京都|京都府|大阪府|[一-龯]{2,3}県)/;
const PLACE_TOKEN_RE = /(?:駅|線|区|市|町)$/;
/** 地名トークンの部分一致キー（「大阪市平野区加美駅」→ 大阪・平野・加美）。駅・線・区・市・町を除いた2字以上 */
function placeKeys(token: string): string[] {
  return token.split(/(?<=[市区町駅線])/).map((s) => s.replace(/(?:駅|線|区|市|町)$/, "")).filter((s) => s.length >= 2);
}
export function resolveCustomerDocScope(customerText: string | null | undefined): CustomerDocScopeVerdict {
  const raw = (customerText ?? "").split(MSG_SEP).join("\n");
  const body = raw.replace(TEMPLATE_ECHO_RE, "").replace(FORM_LABEL_RE, " ");
  const appFields = new Set(raw.match(APPLICATION_FORM_FIELD_RE) ?? []).size;
  let scope: CustomerDocScope;
  if (APPLICATION_FORM_STRONG_RE.test(raw) || appFields >= 2) scope = "application_form";
  else if (isConditionFormMessage(raw)) scope = "condition_form";
  else if (PROPERTY_SHARE_RE.test(raw)) scope = "property_share";
  else if (CONDITION_WORD_RE.test(toHalfWidth(body))) scope = "condition_freeform";
  else scope = "none";
  if (scope === "application_form" || scope === "property_share" || scope === "none") return { scope, body, tokens: [], areaWords: [] };
  const t = upperLayout(toHalfWidth(body));
  const tokens: string[] = [];
  for (const m of t.matchAll(ECHO_TOKEN_RE)) {
    const tok = m[0];
    const after = t.slice((m.index ?? 0) + tok.length, (m.index ?? 0) + tok.length + 6);
    if (/[0-9]+(?:年(?!以内)|月|日|時)$/.test(tok)) continue;                          // 日付・年・時刻（スタッフの復唱率 9%）
    if (/階$/.test(tok) && !/^(?:以上|以下|以外|希望|より上)/.test(after)) continue;   // 所在階（条件用法33件に対し所在階357件）
    if (/[ァ-ヶー]{2,}/.test(tok) && PLACE_TOKEN_RE.test(tok)) continue;             // カタカナ建物名＋町・駅（ビオラコート幸町 等）
    if (PREF_START_RE.test(tok)) continue;                                            // 都道府県から始まる住所の連結
    if (/^[0-9.,〜~]+円$/.test(tok)) continue;                                        // 万の付かない「N円」（物件の賃料・管理費表記）
    tokens.push(tok);
  }
  // エリア表記: 条件フォームは「エリア・駅」欄の値、自由記述は地名トークン
  const areaWords = new Set<string>();
  if (scope === "condition_form") {
    for (const m of raw.matchAll(/(?:エリア|駅)[^】\n]{0,10}】?\s*[⇒→:：]\s*([^\n]+)/g))
      for (const w of m[1].split(/[、,・/／\s]+/)) {
        const k = w.replace(/(?:周辺|付近|全域|沿線|エリア|方面|あたり|辺り)+$/, "").replace(/(?:駅|線)$/, "").trim();
        if (k.length >= 2 && !/^[0-9]/.test(k)) areaWords.add(k);
      }
  }
  for (const tok of tokens) if (PLACE_TOKEN_RE.test(tok)) for (const k of placeKeys(tok)) areaWords.add(k);
  return { scope, body, tokens: [...new Set(tokens)], areaWords: [...areaWords] };
}
/** 互換ラッパー（旧 API）。場面判定とトークンのフィルタは resolveCustomerDocScope が唯一 */
export function extractEchoTokens(customerText: string): string[] {
  return resolveCustomerDocScope(customerText).tokens;
}
export type EchoVerdict = { expected: string[]; echoed: string[]; missing: string[]; ratio: number };
/** 復唱の評価。地名は部分一致（「加美駅周辺」で「平野区加美駅」を満たす）・間取りは大文字化して比較 */
export function evalConditionEcho(draft: string, tokens: string[]): EchoVerdict {
  const d = upperLayout(toHalfWidth(draft ?? ""));
  const echoed = tokens.filter((k) => d.includes(k) || (PLACE_TOKEN_RE.test(k) && placeKeys(k).some((p) => d.includes(p))));
  const missing = tokens.filter((k) => !echoed.includes(k));
  return { expected: tokens, echoed, missing, ratio: tokens.length ? echoed.length / tokens.length : 1 };
}
/** 復唱を要求してよい場面か（条件フォーム・自由記述の条件だけ。検査・生成・PAIR 必須要素が同じ関数） */
export function isEchoableScope(v: CustomerDocScopeVerdict): boolean {
  return v.scope === "condition_form" || v.scope === "condition_freeform";
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
    sig.hasPrePickupHedge ? "preemptive_hedge" : sig.usedCommit ? "commit_until_found" : sig.usedReceive ? "receive_check" : sig.usedWait ? "wait_softly" : AWAIT_CONTACT_PHRASE_RE.test(text) ? "await_contact" : sig.usedOpenDoor ? "open_door" : sig.usedNanisotsu || sig.scheduleFixed ? "none" : "other";
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
    closer_kind: sig.hasPrePickupHedge ? "preemptive_hedge" : sig.usedCommit ? "commit_until_found" : sig.usedReceive ? "receive_check" : sig.usedWait ? "wait_softly" : AWAIT_CONTACT_PHRASE_RE.test(text ?? "") ? "await_contact" : sig.usedOpenDoor ? "open_door" : sig.usedNanisotsu || sig.scheduleFixed ? "none" : "other",
    has_commit: sig.usedCommit, has_nanisotsu: sig.usedNanisotsu,
    hedge_kind: sig.hasPrePickupHedge ? "preemptive" : SEARCH_REPORT_RE.test(text) ? "search_report" : RELAX_PROPOSAL_RE.test(text) ? "relax_proposal" : null,
    echo_ratio: Math.round(echo.ratio * 100) / 100, echo_missing: echo.missing,
    emoji_count: (text.match(EMOJI_RE) ?? []).length, exclaim_count: (text.match(/！！|!!/g) ?? []).length, char_len: sig.bodyLen,
  };
}

/** dynamicBlock【姿勢】ブロック（往復文脈ブロックの直後・tpoGuidanceNote より上位）。決定論の値をリテラルで渡し LLM に選ばせない */
export function buildStanceNote(pair: PairContext, hedge: HedgeVerdict, closer: CloserVerdict, opts: { customerName: string; customerText: string }): string {
  // 2026-09-11 統合設計（経路B）: 名前不明時に「〇〇さん」を生成ノートへ書かない（呼びかけごと省く）
  const name = opts.customerName ? `${opts.customerName}さん` : "";
  // 2026-09-11 竹内方針2: 復唱の指示は条件フォーム・自由記述の条件の時だけ（物件送付・申込フォームで物件属性・個人情報を「一字も変えずに」埋め込ませていた）
  const docScope = resolveCustomerDocScope(opts.customerText);
  const tokens = isEchoableScope(docScope) ? docScope.tokens : [];
  const fact = resolveAnswerability(opts.customerText);
  const sched = classifyScheduleCommitment(opts.customerText, pair.lastStaffText);
  const L: string[] = ["【🧭 姿勢 — 「見つかるまで伴走する頼れる担当者」（往復文脈の次・場面通知より上位）】"];
  if (hedge.allowance === "forbid_preemptive")
    L.push(`- 🚫 ヘッジ判定（${hedge.summary}）: 「難しい可能性」「少ない状況」「条件を1つ変えた場合」「優先順位をお聞かせ」等の実現可能性への言及・条件緩和の先回り提案は絶対禁止。まだ探していないので結果は語れない${hedge.customerSelfHedge.yes ? `。お客様の「${hedge.customerSelfHedge.evidence}」は復唱・同意しない（代替案はピックアップ結果と一緒に報告する）` : ""}`);
  else if (hedge.allowance === "allow_after_search")
    L.push(`- ✅ ヘッジ判定（${hedge.summary}）: 「〇〇のご条件ですと合うお部屋が少ない状況でしたので、△△まで広げてピックアップさせて頂きました」の過去形＋実行済み代替のみ可。未来形の予測は禁止。締めは「お手隙の際にご査収ください😌！！」`);
  else
    L.push(`- ✅ ヘッジ判定（${hedge.summary}）: 傾向を「傾向として〜が多いですが」と1文で正直に答えてよい。必ず「${name ? `${name}の` : ""}ご条件でしっかりピックアップしてお送りさせて頂きます！！」の探索宣言を同じ返信に入れる。優先順位の聞き返しは禁止（まず探す）`);
  if (isEchoableScope(docScope) && (docScope.areaWords.length > 0 || tokens.length >= 2))
    L.push(`- 📌 条件の復唱（任意）: エリアはお客様の表記のまま${docScope.areaWords.length ? `「${docScope.areaWords.slice(0, 3).join("・")}周辺全域から」の形` : "「（エリア）周辺全域から」の形"}。家賃・間取りは入れてよい（必須ではない）${tokens.some((t) => !/(?:駅|線|区|市|町)$/.test(t)) ? `: ${tokens.filter((t) => !/(?:駅|線|区|市|町)$/.test(t)).slice(0, 6).join("・")}` : ""}。物件名・建物名・号室・階・住所・日付は書かない`);
  L.push(closer.text
    ? `- 🔚 締め（最終行に置く。行動宣言の代わりにしない）: 「${closer.text.replace(/\n/g, "」＋「")}」（${closer.reason}）`
    : `- 🔚 締め: 追加の締め文なし（${closer.reason}）。「全力でサポート」「何卒よろしく」を足さない`);
  if (fact) L.push(`- ✅ 即答: 「${fact.answer}」と言い切る（「確認させて頂きます」に逃がさない）${fact.next ? `→続けて「${fact.next}」` : ""}`);
  if (sched === "customer_asking" || sched === "staff_proposing")
    L.push(`- 🗓 日程は提案形: お客様が日時を確定していない。「はい！！お部屋ご案内可能です😊！！」→日付・時刻・場所を数字で→「〜お待ち合わせ如何でしょうか！！」。「〜で何卒よろしくお願い致します」の決め打ち禁止`);
  L.push("- 🌡 温度: 😊😌は2個以内・！！は3回以内。「ご安心ください」「ご検討ください」「恐縮ですが」「〜いただけますと幸いです」「少々お時間」で終えず、こちらの行動宣言で終える。" + (name ? `呼称は「${name}」` : "お客様名は不明のため呼びかけは書かない"));
  L.push("- 🕰 急かさない: 「埋まってしまう前に」「お早めに」は見積送付後・お客様の前向き反応後のみ");
  return L.join("\n") + "\n\n";
}

// ─────────────────────────────────────────────────────────────
// 10. 顧客アンカー語彙（2026-09-10 Fable5 あみ事例）— 「顧客が言っていないのに使うと文脈が壊れる語」。
//     生成（buildVocabAnchorNote）・検査（final-check runVocabAnchorChecks）・修正（suggestion）が同一テーブルを参照する。
//     根拠: 「ごゆっくりご相談」正解 n=2 / 顧客が『相談』と明言 2件（100%）。「ご相談」を含む正解 23件のうち
//     顧客が物件を送ると言った場面は 0件。顧客が物件を送った直後の正解 246件中「随時ピックアップ」0件。
//     設計上の注意: 禁止語を足すと LLM は同義語に逃げる（「ご検討」を締めで抑制した結果「ご相談」に逃げた）。
//     したがって replace に正しい代替をリテラルで必ず持たせる。
// ─────────────────────────────────────────────────────────────
export type VocabAnchorCtx = { reply: string; customerText: string; lastCustomerTexts: string; lastStaffText: string; pair: PairContext | null };
export type VocabAnchor = {
  key: string;
  /** 返信側に現れる語 */
  re: RegExp;
  /** 顧客側（最新＋直近顧客発言＋直前スタッフ発言）にこれが無ければ「顧客が言っていない語」 */
  requires: RegExp;
  /** requires を満たしていても不可な文脈 */
  forbidWhen?: (c: VocabAnchorCtx) => boolean;
  severity: "block" | "warning";
  why: string;
  /** 必ずリテラルの代替を渡す（禁止だけを足すと同義語に逃げる） */
  replace: string;
  /** 生成側 note で「書かない語」として提示する見出し */
  label: string;
};

export const CUSTOMER_SOUDAN_SIGNAL_RE =
  /相談|話し合|打ち合わせ|家族|ご家族|旦那|主人|奥さん|妻|嫁|夫|親|両親|母|父|同居|友人|友達|彼氏|彼女|二人で|2人で|皆で|みんなで/;
export const CUSTOMER_KENTOU_SIGNAL_RE = /検討|考え|悩|迷|持ち帰|決めかね|決められ/;
export const CUSTOMER_KAKUNIN_SIGNAL_RE = /確認|チェック|見て(?:み|から|おき)|拝見|目を通/;
export const CUSTOMER_ASKS_CONTINUOUS_PICKUP_RE =
  /(?:また|引き続き|今後|次|新着|出たら|出てきたら|あれば|ありましたら)[^\n]{0,16}(?:ご紹介|紹介|ピックアップ|探し|お願い|送っ|教えて)|条件のあう物件|新しい(?:物件|お部屋)/;

export const CUSTOMER_ANCHORED_VOCAB: VocabAnchor[] = [
  { key: "goyukkuri_soudan", label: "ごゆっくりご相談", re: /ごゆっくりご相談/, requires: CUSTOMER_SOUDAN_SIGNAL_RE, severity: "block",
    why: "「ごゆっくりご相談頂けますと幸いです」は、お客様が『（誰かに）相談してみます』と明言した時だけの文（正解 n=2／2件とも顧客が相談と明言＝100%）。相談の言及が無い場面での使用は正解データに0件",
    replace: "お客様が『検討します』と言っているなら「ごゆっくりご検討頂けますと幸いです😊！！」／『確認します』なら「ごゆっくりご確認頂けますと幸いです😊！！」／どちらも言っていないなら「ごゆっくり〜」の行ごと削除して行動宣言に置き換える" },

  { key: "gosoudan_any", label: "ご相談（ご相談ください以外）", re: /ご相談(?!ください|下さい)/, requires: CUSTOMER_SOUDAN_SIGNAL_RE, severity: "warning",
    why: "「ご相談」はお客様が相談・家族・同居人等に言及した時のみ（正解 23件の直前顧客メッセージは全件が相談・質問の持ちかけ。顧客が物件を送ると言った場面は 0件）",
    replace: "「ご相談」→「ご連絡」に置換する（末尾クローザーは「いつでもお気軽にご連絡ください😌！！」が正解 n=113。「ご相談ください」は n=11 で AI 使用 7件中 6件が無根拠・5件が人に削除された）" },

  { key: "zuiji_pickup_on_will_send", label: "随時ピックアップしてお送りします",
    re: /随時[^\n]{0,8}ピックアップ|出次第[^\n]{0,10}ピックアップ|出てきましたら[^\n]{0,12}ピックアップ/,
    requires: CUSTOMER_ASKS_CONTINUOUS_PICKUP_RE, severity: "block",
    forbidWhen: (c) => c.pair?.customer.kind === "will_send_later" || (c.pair?.customer.secondary.includes("will_send_later") ?? false),
    why: "「随時ピックアップしてお送りします」は『我々が探して送る』宣言で、(B)『我々に送って』と依頼された場面の語彙（9/203）。お客様が『自分で物件を送る』と言った場面の正解 246件中 0件。直前にピックアップ宣言済みなら重複でもある",
    replace: "この1文を削除し、「お送り頂きました物件の募集状況確認させて頂き、最大限割引しました初期費用の御見積書とあわせてご連絡させて頂きます！！」に置き換える" },

  { key: "gokazoku", label: "ご家族", re: /ご家族(?:様)?/, requires: /家族|旦那|主人|妻|嫁|夫|子供|子ども|お子|同居|両親|親|息子|娘/, severity: "warning",
    why: "お客様が家族構成に言及していないのに「ご家族」を出すと事実の創作になる",
    replace: "「ご家族」を削除し「〇〇さん」に一本化する" },

  { key: "gokentou", label: "ご検討頂けますと／ごゆっくりご検討", re: /ご検討(?:頂|いただ)け(?:ます|れば)|ごゆっくりご検討/, requires: CUSTOMER_KENTOU_SIGNAL_RE, severity: "warning",
    why: "「ご検討」はお客様が『検討します／考えます／悩んでいます』と言った時のミラー（ごゆっくりご検討 正解 21件中 20件=95%が顧客の該当語あり）",
    replace: "お客様が『送ります』と言っているだけなら検討促しは不要。行を削除し受け宣言（募集状況確認＋御見積書）に置き換える" },
];

/** 「ごゆっくり」の後続語は顧客の動詞の鏡写し（正解 33件中 31件=94%・例外2件のみ） */
const GOYUKKURI_USED_RE = /ごゆっくり(ご(?:検討|確認|相談|覧))/;
const GOYUKKURI_MIRROR: Array<{ verb: RegExp; expect: string }> = [
  { verb: CUSTOMER_KENTOU_SIGNAL_RE, expect: "ご検討" },
  { verb: CUSTOMER_KAKUNIN_SIGNAL_RE, expect: "ご確認" },
  { verb: /相談|話し合/, expect: "ご相談" },
  { verb: /見(?:させて|ま)|拝見|眺め|目を通/, expect: "ご覧" },
];
/** PAIR_MATRIX の「ごゆっくり」必須要素ゲート: お客様が間を置く行動（検討／確認／相談／見る）を言っている時だけ要求する */
export function hasGoyukkuriMirrorVerb(pair: PairContext): boolean {
  return GOYUKKURI_MIRROR.some((r) => r.verb.test(pair.substance.normalized));
}
export type GoyukkuriVerdict = { used: string; expected: string | null; ok: boolean };
export function checkGoyukkuriMirror(reply: string, customerAll: string): GoyukkuriVerdict | null {
  const m = reply.match(GOYUKKURI_USED_RE);
  if (!m) return null;
  const used = m[1];
  const hit = GOYUKKURI_MIRROR.find((r) => r.verb.test(customerAll));
  const expected = hit ? hit.expect : null;
  return { used, expected, ok: expected != null && expected === used };
}

/** 生成側に「使える語／使えない語＋正しい代替」をリテラルで渡す。禁止だけを渡すと同義語に逃げる（ご検討→ご相談） */
export function buildVocabAnchorNote(customerAll: string, pair: PairContext | null): string {
  const lines: string[] = ["\n\n【🔤 お客様が言っていない語（この返信で書いてはいけない語と、その代わりに書く語）】"];
  for (const v of CUSTOMER_ANCHORED_VOCAB) {
    const anchored = v.requires.test(customerAll);
    const forbidden = v.forbidWhen ? v.forbidWhen({ reply: "", customerText: customerAll, lastCustomerTexts: "", lastStaffText: "", pair }) : false;
    if (anchored && !forbidden) continue;
    lines.push(`・「${v.label}」系は書かない — ${v.why}\n  → 代わりに: ${v.replace}`);
  }
  const hit = GOYUKKURI_MIRROR.find((r) => r.verb.test(customerAll));
  lines.push(hit
    ? `・「ごゆっくり」を使うなら後続語は必ず「${hit.expect}」（お客様の言葉の鏡写し）`
    : "・お客様は「検討する／確認する／相談する／見る」のいずれも言っていない → 「ごゆっくり〜」自体を書かない");
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────
// 11. セル必須要素 × brain 方針の衝突検出（2026-09-10 Fable5 みく事例）
//     旧 route.ts の解消は `m.label.includes(t)`（日本語ラベルの部分文字列一致）で avoid 側を削るだけだった。
//     「新規物件ピックアップ」と「再ピックアップ宣言」は部分文字列一致しないので衝突と認識されず、
//     プロンプトに「✅ 再ピックアップ宣言 必須」と「🚫 新規物件ピックアップ禁止」が同居し、
//     しかも禁止行の文面自体が「代わりに ${effectiveReplyDirection} の方向性に沿え」と誤った direction を指し直していた。
//     方針: avoid は従来どおり削る（プロンプト内矛盾を作らない）が、**削った事実を必ず記録し検査で warning にする**。
//           セルを自動で切り替えることはしない（決定を2つに増やさない）。
// ─────────────────────────────────────────────────────────────
export type CellConflictKind = "avoid_vs_must" | "stance_wait_vs_proposal";
export type CellConflict = {
  kind: CellConflictKind;
  ruleId: string;
  element: string;
  brainValue: string;
  message: string;
};

/** 意味クラス。必須要素ラベルと avoid_topics の**両方をこの表で正規化してから**突き合わせる */
const CONFLICT_CLASSES: Array<{ id: string; element: RegExp; avoid: RegExp }> = [
  { id: "new_pickup", element: /ピックアップ宣言|お調べ|お探し|探す宣言|新規[^。]{0,6}提案/,
    avoid: /新規.{0,6}ピックアップ|再ピックアップ|別物件|他物件|物件提案|別のお部屋/ },
  { id: "estimate", element: /見積/, avoid: /見積/ },
  { id: "viewing",  element: /内覧|ご案内/, avoid: /内見|内覧|ご案内/ },
  { id: "apply",    element: /申込/, avoid: /申込/ },
  { id: "vacancy",  element: /募集状況|空室/, avoid: /募集状況|空室/ },
];
/** engagement_stance="wait"（今は待つ局面）で出してはいけない要素クラス */
const PROPOSAL_CLASSES = new Set(["new_pickup", "viewing", "apply"]);

export function detectCellConflicts(
  pair: PairContext, strategy: BrainConversationScope | null | undefined, brainFresh: boolean,
): CellConflict[] {
  if (!brainFresh || !strategy || !pair.rule) return [];
  const out: CellConflict[] = [];
  for (const m of pair.rule.mustInclude.filter((x) => !x.when || x.when(pair))) {
    const cls = CONFLICT_CLASSES.find((c) => c.element.test(m.label));
    if (!cls) continue;
    for (const t of strategy.avoid_topics) {
      if (!cls.avoid.test(t)) continue;
      out.push({ kind: "avoid_vs_must", ruleId: pair.rule.id, element: m.label, brainValue: t,
        message: `セル ${pair.rule.id} の必須要素「${m.label}」が brain avoid_topics「${t}」と正面衝突（意味クラス: ${cls.id}）。avoid を削る前にセル選択を疑う` });
    }
    if (strategy.engagement_stance === "wait" && PROPOSAL_CLASSES.has(cls.id)) {
      out.push({ kind: "stance_wait_vs_proposal", ruleId: pair.rule.id, element: m.label, brainValue: "wait",
        message: `brain の engagement_stance="wait"（今は待つ局面）なのに、セル ${pair.rule.id} が「${m.label}」（新規提案・押し）を必須にしている` });
    }
  }
  return out;
}

/** avoid を除外すべきか（旧 route.ts の `m.label.includes(t)` の置換。意味クラスで判定する） */
export function avoidConflictsWithCell(pair: PairContext, topic: string): boolean {
  if (!pair.rule) return false;
  return pair.rule.mustInclude.filter((m) => !m.when || m.when(pair)).some((m) => {
    const cls = CONFLICT_CLASSES.find((c) => c.element.test(m.label));
    return !!cls && cls.avoid.test(topic);
  });
}
