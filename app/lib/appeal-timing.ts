// app/lib/appeal-timing.ts
// 返信・ブレイン・AIX の締めで「申込（お部屋を抑える）の訴求／内覧の訴求／訴求しない」を場面と部屋の状況から決める（純関数・DB 依存なし）。
//
// 2026-10-07 竹内さん（R 10/05 16:46 のスタッフの送信「はい😊！！ ごゆっくりご検討ください！！ お気に召されましたらお申込みしお部屋抑えさせていただきます！！
//   気になる点等出てきましたらいつでもご連絡ください😌！！」を見て）:
//   「どのタイミングでお部屋抑えるっていれてるか どのタイミングで内覧誘導しているか 状況やお部屋の状況によっても違うのでその点もふまえて
//    どのタイミングかどこで訴求しているか またその判断において足りていない部分は（ブレイン）にあるのか ここがあれば返信の訴求のタイミングかなりよくなる」
//   ＋ チンシャン（10/05 物件オススメ「…お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！」→ お客様「いいですね！」・空室）に
//   AI の下書きは「最大限割引させて頂いた初期費用の御見積書を作成しお送りさせて頂きます！！」だけ（内覧の訴求なし）。
//   「なぜ良いですねってきてて、お部屋空室なのに内覧誘導をいれないのか」。
//
// ■ 実送信で測った形（scripts/audit-appeal-timing.ts・2026-06-01〜10-06・人の手打ちの返信 1,527番・YUMA・グループ・申込以降・
//   AI の下書きのままの送信 298番・手打ちの物件の送付 151番を除く。6/1 より前は AI の下書きの記録が無く AI の文と人の文を分けられない）
//   数字はこのファイルの APPEAL_STATS に置き、生成に渡す材料の文にそのまま出す（言い切りの強さを実測に合わせる）。
//   ・手打ちの返信に訴求を入れたのは 133番（申込 50・内覧 83）＝ 9%。応答全体（AIX を含む）では 233番。訴求の多くは AIX の締め。
//     位置は締め（最後の2行）110・本文 23。
//   ・どの場面でも手打ちの返信の訴求は過半数にならない（例外: 見積書後×前向き(評価)×空室 8番で内覧 75%）＝ 返信では**材料として渡す**。
//   ・必須にしてよいのは過半数が守っている形だけ（CLAUDE.md「おかしな文を1通見つけたら」）＝「入れない」側（avoid）:
//       懸念・条件の変更・断り・質問（答えるだけ）・申込誘導の直後・申込の手続きの後・内覧の日にちの調整中／決まった後 → 訴求しない
//       （判定が avoid の 860番でスタッフも入れていない 814番＝95%）
//     必須（must）は「前向き（評価）×今ご内覧頂ける部屋 → 内覧の訴求」だけ（竹内さんの指示＋見積書後の評価で 75%）
//   ・申込（お部屋を抑える）を選ぶ状況（実送信の文を読んで）:
//       まだ内覧できない（退去予定）・お客様がすぐ来られない（予定・出張・遠方）→「お部屋抑えた状態でご内覧」
//       内覧の後（「本日お時間頂きありがとうございました！！ お気に召されましたらお申込しお部屋抑えさせて頂きます」）
//       御見積書を送った後の検討（R 10/05）・他の申込あり・1部屋のみの募集（検討・了承の時）
//     それ以外（今ご内覧頂ける部屋への了承・検討・評価）は内覧の訴求。
//   ・今の AI の下書き（同じ番 436）: 一致 83%・スタッフが入れたのに AI なし 21・スタッフ無しで AI だけ 51（7〜8月の下書きは
//     「かなり好条件ですので…お申込みで」と煽りつきで足す誤りが多い）。9/1 以降（227番）は 10 対 12 で、検討・了承の「扉」の文に
//     「お気に召されましたらいつでもご連絡ください」を書いて訴求が抜ける形（R・きえ・愛乃・けんじじ）が残る。
//   ・入れる時の形（言い回しは実送信の最多の形・創作しない）:
//       内覧 …「お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！」
//       申込 …「お気に召されましたらお申込しお部屋抑えさせて頂きます！！」
//       退去予定の申込 …「内覧前にお部屋が埋まってしまう可能性もございますので、お気に召されましたらお申込しお部屋抑えた状態でご内覧頂く事も出来ます！！」の型
//       （実送信: 「ご内覧前にお部屋が埋まってしまう可能性もございますので…お申込みでお部屋を抑えさせて頂きます」「お部屋抑えた状態でご内覧いただくのをオススメいたします」）
//       1部屋のみ・好条件 …「1部屋のみの募集となりますので、お気に召されましたらお申込しお部屋抑えさせて頂きます！！」の型（部屋数は資料・会話にある時だけ）

import { analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse } from "./reply-context";
import { resolveAckTopicScope } from "./ack-topic-scope";
import { extractCircumstances, validCircumstances, circumstanceDelaysViewing, onlineViewingReason, ONLINE_VIEWING_LINE, holdFirstMinDays, undatedHoldKind, type Circumstance } from "./customer-circumstances";
import { propertyAppealFitEnabled, readAppealReaction, resolvePropertyAppealFit, type AppealFit } from "./property-appeal-fit";
import { decideGapEnabled, decideSignalOf, readDecideGapsInTurn } from "./customer-mindset";
import { headOfFirstMessage, type PickupAppealRow } from "./recommend-cta";

/* ───────────── 検出（実送信の文から訴求を読む・監査とテストが同じ関数を使う） ───────────── */

/** 申込（お部屋を抑える）の訴求の文 */
export const APPLY_APPEAL_RE = /お?申込み?(?:し|で|頂き|いただき|頂いて|いただいて)?[^\n。！!]{0,12}お部屋[^\n。！!]{0,4}(?:抑え|押さえ|確保)|お部屋(?:を)?(?:お?抑え|お?押さえ)(?:させて|致し|いたし|出来|でき|頂|いただ|た状態)|仮押さえ|お申込み?(?:の方)?(?:いかが|如何)|先にお申込|お申込み?(?:も)?(?:承って|受け付けて)/;
/** 内覧の訴求の文（誘いの形だけ。日時を決めた案内・待ち合わせ・「〇日以降ご内覧可能」の説明は数えない） */
export const VIEWING_APPEAL_RE = /ご案内させて(?:頂|いただ)き(?:ます|たく)|お部屋ご案内|ご内覧(?:の方)?(?:いかが|如何)|内覧(?:の方)?(?:いかが|如何)|ご都合(?:の)?よろしいお日にち|ご内覧(?:頂|いただ)け(?:ます|る)|ご内覧(?:でき|出来|可能)(?:です|ます)?(?:ので|ため)|ご内覧(?:も)?(?:承って|させて)|実際にお部屋(?:ご内覧|見て)|ご案内(?:も)?(?:可能|出来|でき)(?:です|ます)?(?:ので|ため)/;
/** 内覧の説明だけ（いつから見られるか・見られない）＝誘いではない */
const VIEWING_INFO_ONLY_RE = /以降(?:に|で)?(?:お部屋)?(?:ご)?内覧|退去予定|内覧(?:不可|出来ない|できない|出来ません|できません)|ご案内(?:が)?(?:出来|でき)(?:ない|ません)/;
/** 日時を決めた案内（内覧調整・確定の文）＝誘いではない */
const VIEWING_SCHEDULED_RE = /[0-9０-９]{1,2}\s*[\/／月]\s*[0-9０-９]{1,2}|[0-9０-９]{1,2}\s*[:：時]\s*[0-9０-９]{0,2}|(?:本日|明日|明後日)[^\n]{0,12}ご案内|ご案内(?:大丈夫|可能な時間)/;
const MEETING_RE = /待ち合わせ|集合場所|現地エントランス/;
/** 申込の手続きに入った文（ここから先は訴求の場面ではない） */
const POST_APPLY_RE = /申込(?:み)?(?:時)?フォーマット|申込書|お申込み?(?:頂き|いただき)ありがとう|審査(?:結果|通過|に通|承認)|ご契約(?:日|金)|重要事項説明|鍵(?:の)?(?:お)?渡し|お申込み?(?:完了|頂きました|いただきました)/;

export function isPostApplyText(t: string | null | undefined): boolean { return POST_APPLY_RE.test(String(t ?? "")); }

export type AppealPosition = "closing" | "body";
export type DetectedAppeal = { apply: boolean; viewing: boolean; position: AppealPosition | null; line: string };

/** 1通の中の訴求（申込・内覧）と位置（締め＝最後の2行／本文） */
export function detectAppeal(text: string | null | undefined): DetectedAppeal {
  const lines = String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  let apply = false, viewing = false, position: AppealPosition | null = null, line = "";
  lines.forEach((l, i) => {
    const a = APPLY_APPEAL_RE.test(l);
    const v = !MEETING_RE.test(l) && VIEWING_APPEAL_RE.test(l) && !VIEWING_INFO_ONLY_RE.test(l) && !VIEWING_SCHEDULED_RE.test(l);
    if (!a && !v) return;
    if (a) apply = true;
    if (v) viewing = true;
    const pos: AppealPosition = i >= lines.length - 2 ? "closing" : "body";
    if (position !== "closing") position = pos;
    if (!line || pos === "closing") line = l;
  });
  return { apply, viewing, position, line };
}

/** こちらが物件を送る文（ピックアップ・オススメ・御見積書の送付）＝返信ではなく物件の送付（締めは recommend-cta の担当） */
export const PROPERTY_SEND_TEXT_RE = /🌟|オススメポイント|ピックアップさせて(?:頂|いただ)きました|御見積書となります|お見積書(?:を)?お送りさせて(?:頂|いただ)きました|募集に出ました|ご査収ください/;

/* ───────────── 部屋の状況・お客様の温度（会話の文から） ───────────── */

/** 他の申込・審査中・商談中（こちらの文に書いてある時だけ） */
export const COMPETING_RE = /[2２二]番手|申込(?:み)?(?:が)?(?:入っ|入り|有り|あり)|他(?:の)?(?:お客様|方)[^\n。]{0,12}(?:申込|ご検討|内覧)|審査中|商談中/;
/** 部屋が少ない・好条件・人気（こちらの文に書いてある時だけ。煽りの語は足さない＝この語は「書いてあったか」を読むだけ） */
export const SCARCITY_RE = /[1１一]部屋のみ|残り[0-9０-９一二]部屋|すぐに?(?:埋ま|決ま)|人気(?:の|が|物件)|お問い合わせ(?:が)?(?:多|殺到)|好条件|埋まってしまう/;
/** お客様の急ぎ（今月中・すぐ入居 等） */
export const URGENT_RE = /急ぎ|至急|すぐ(?:に)?(?:入居|住|引っ?越)|今月中|今週中|なるべく早|早く(?:入居|引っ?越|住)/;
/** お客様の申込の意思 */
export const CUSTOMER_APPLY_INTENT_RE = /申込(?:み)?(?:したい|します|させて|お願い|で(?:お願い|大丈夫))|申し込みたい|申し込みます|契約(?:したい|します)|ここに(?:します|決め)|(?:部屋|お部屋)(?:を)?(?:抑え|押さえ)て/;
/** お客様の内覧の希望 */
export const CUSTOMER_VIEWING_WISH_RE = /内覧|内見|見に行|見学|見てみたい|見れますか|見られますか/;
/** 評価の語（「いいですね」「気になります」）— 前向きの判定の補助（classifyCustomerResponse の positive が取りこぼす短い評価を拾う） */
export const CUSTOMER_APPRAISAL_RE = /いいですね|良いですね|よいですね|良さそう|よさそう|いい感じ|良い感じ|素敵|気に入り|気に入っ|魅力|綺麗|きれい|最高|ありですね|アリですね|惹かれ|いいかも|良いかも|めっちゃいい|すごくいい/;

/* ───────────── 判定 ───────────── */

/** 直前にこちらが何をしたか（訴求の場面） */
export type AppealScene =
  | "after_recommend"     // 物件オススメ（1件を推した）の後
  | "after_pickup"        // 物件ピックアップ（束）の後
  | "after_estimate"      // 御見積書の後
  | "after_check"         // 物件確認した（募集状況の報告）の後
  | "viewing_adjusting"   // 内覧の日にちの調整中
  | "viewing_confirmed"   // 内覧の日にちが決まった（待ち合わせを送った）・内覧の前
  | "post_viewing"        // 内覧の後
  | "after_apply_push"    // 申込へ！の直後
  | "post_apply"          // 申込の手続きに入った後
  | "other";

/** お客様の今回の発言 */
export type AppealCustomer =
  | "apply_intent" | "viewing_wish" | "positive" | "thinking" | "ack" | "question"
  | "concern" | "condition_change" | "decline" | "other";

/** 主のお部屋の状況 */
export type AppealRoom =
  | "vacant"                 // 退去予定の記載なし（空室扱い）
  | "move_out_not_viewable"  // 退去予定でまだ内覧できない
  | "move_out_viewable"      // 退去予定だが内覧できる日になった
  | "unknown";

export type AppealKind = "apply" | "viewing" | "none";
/** must = 必ず守る（実送信の過半数）／suggest = 材料として渡す（入れるならこの形）／avoid = 入れない（実送信の過半数が入れていない・入れると誤り） */
export type AppealLevel = "must" | "suggest" | "avoid";

export type AppealTimingInput = {
  scene: AppealScene;
  customer: AppealCustomer;
  room: AppealRoom;
  /** こちらの文に「1部屋のみ・好条件・人気・埋まってしまう」がある */
  scarcity?: boolean;
  /** こちらの文に「1部屋のみ（の募集）」がある（部屋数を文に書いてよい時だけ） */
  onlyOneRoom?: boolean;
  /** 他の申込・審査中・商談中 */
  competing?: boolean;
  /** お客様が急いでいる（今月中・すぐ入居） */
  urgent?: boolean;
  /** 御見積書を送ってある（この部屋・直近7日） */
  estimateSent?: boolean;
  /** お客様がすぐには内覧に来られない（予定が詰まっている・出張・遠方）— 今回の発言から */
  viewingDelayed?: boolean;
  /** お客様が内覧の予約を取り消した（今回の発言） */
  viewingCancelled?: boolean;
  /**
   * すぐ来られない理由の型（2026-10-08 竹内さん②③④）:
   *   fixed＝出張中（日付なし）・遠方・「〇日以降」が7日以上先（竹内さんの決定どおり先に抑える提案）／
   *   busy＝予定が詰まって・しばらく（日付なし）／short＝今週は無理・来週出張・伺えない 等（刺さり具合で抑える提案か内覧調整・撮影かを分ける）
   */
  delayKind?: "fixed" | "busy" | "short" | null;
  /** 主のお部屋の刺さり具合（property-appeal-fit・採点＋お客様の反応） */
  appealFit?: AppealFit | null;
  /** 刺さり具合を読んだお部屋（🌟の見出し「建物名 号室」・読めなければ null） */
  appealFitLabel?: string | null;
  /** 出張中・遠方＝オンライン内見も伝えてよい（2026-10-08 竹内さん「出張中ならオンライン内見も対応可能と伝える」・APPEAL_ONLINE_VIEWING=off で付けない） */
  onlineViewing?: "business_trip" | "remote" | null;
  /** お礼・了承の番で、読むべき範囲（こちらの直前の返事＋それが答えたお客様の番）が物件の話でも約束でもなく閉じている（ack-topic-scope の closedNonPropertyTopic） */
  topicClosed?: boolean;
  /** 前回こちらが訴求してからの時間（時間）。null＝訴求していない（監査・画面の表示用。判定には使わない） */
  hoursSinceLastAppeal?: number | null;
  /** 前回の訴求の種類 */
  lastAppealKind?: "apply" | "viewing" | null;
};

export type AppealTimingVerdict = {
  kind: AppealKind;
  level: AppealLevel;
  /** 入れるならこの形（実送信の最多の形）。kind=none の時は空 */
  line: string;
  /** 判断の理由（ログ・画面・監査） */
  reason: string;
  /** 実送信の率（この場面で人の手打ちの返信がその訴求を入れた割合・%）。無ければ null */
  staffRate: number | null;
  /** 生成・ブレインに渡す1行（空なら何も足さない） */
  note: string;
};

export const APPEAL_LINES = {
  viewing: "お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！",
  viewing_accept: "かしこまりました😊！！ お部屋ご案内させて頂きます！！",
  viewing_reschedule: "別日でも内覧調整可能ですので、お気に召されましたらお部屋ご案内させていただきます😊！！",
  apply: "お気に召されましたらお申込しお部屋抑えさせて頂きます！！",
  apply_hold_then_view: "ご内覧前にお部屋が埋まってしまう可能性もございますので、お気に召されましたらお申込しお部屋抑えた状態でご内覧頂く事も出来ます！！",
  apply_scarce: "1部屋のみの募集となりますので、お気に召されましたらお申込しお部屋抑えさせて頂きます！！",
} as const;

/**
 * 実送信の率（人の手打ちの返信・2026-06-01〜10-06・scripts/audit-appeal-timing.ts STATS=1）。
 * 鍵は `${scene}|${customer}`・値は [件数, 申込%, 内覧%]。件数 6 未満の場面は載せない（線を引けない）。
 * ⚠ 監査を回し直したらこの表を書き換える（文の強さはこの数字で決まる）
 */
export const APPEAL_STATS: Record<string, [number, number, number]> = {
  "after_apply_push|other": [21, 5, 0],
  "after_apply_push|question": [30, 3, 0],
  "after_check|ack": [12, 8, 0],
  "after_check|condition_change": [6, 0, 0],
  "after_check|other": [32, 9, 3],
  "after_check|question": [73, 4, 0],
  "after_check|viewing_wish": [16, 6, 25],
  "after_estimate|ack": [37, 8, 3],
  "after_estimate|condition_change": [10, 10, 0],
  "after_estimate|decline": [7, 0, 0],
  "after_estimate|other": [87, 0, 3],
  "after_estimate|positive": [8, 0, 75],
  "after_estimate|question": [195, 3, 3],
  "after_estimate|thinking": [21, 10, 10],
  "after_estimate|viewing_wish": [44, 7, 25],
  "after_pickup|ack": [7, 0, 14],
  "after_pickup|other": [7, 0, 14],
  "after_pickup|question": [19, 0, 5],
  "after_recommend|ack": [18, 11, 28],
  "after_recommend|concern": [9, 0, 0],
  "after_recommend|other": [44, 2, 7],
  "after_recommend|positive": [6, 0, 17],
  "after_recommend|question": [84, 2, 2],
  "after_recommend|thinking": [19, 11, 11],
  "after_recommend|viewing_wish": [18, 22, 28],
  "other|ack": [58, 0, 3],
  "other|concern": [10, 0, 0],
  "other|condition_change": [101, 0, 0],
  "other|other": [117, 1, 2],
  "other|question": [156, 2, 3],
  "other|thinking": [10, 10, 20],
  "other|viewing_wish": [17, 6, 18],
  "post_viewing|ack": [17, 12, 0],
  "post_viewing|other": [38, 0, 3],
  "post_viewing|question": [27, 0, 0],
  "viewing_adjusting|other": [9, 11, 11],
  "viewing_adjusting|question": [12, 0, 17],
  "viewing_confirmed|ack": [12, 8, 8],
  "viewing_confirmed|other": [20, 5, 5],
  "viewing_confirmed|question": [10, 0, 10],
  "viewing_confirmed|viewing_wish": [6, 0, 17],
};

function stat(scene: AppealScene, customer: AppealCustomer): [number, number, number] | null {
  return APPEAL_STATS[`${scene}|${customer}`] ?? null;
}

const none = (level: AppealLevel, reason: string, note: string, staffRate: number | null = null): AppealTimingVerdict =>
  ({ kind: "none", level, line: "", reason, staffRate, note });

/** 物件を見せた後（訴求が意味を持つ場面） */
const SHOWN_SCENES: ReadonlySet<AppealScene> = new Set(["after_recommend", "after_pickup", "after_estimate", "after_check", "post_viewing"]);

/**
 * 訴求の要否と種類。
 *  ① 入れない（avoid・実送信の過半数が入れていない）: 申込の手続き以降・申込誘導の直後・懸念・条件の変更・断り・質問（答えるだけ）・
 *     内覧の日にちの調整中／決まった後（その部屋の内覧の誘い直しはしない）
 *  ② 申込の意思 → 受ける（後押しの文は重ねない）
 *  ③ 内覧の希望: 空室 → 受ける（「お部屋ご案内させて頂きます」・日時の候補は AIX【内覧へ！】）／まだ内覧できない・すぐ来られない → 申込（抑えた状態でご内覧）
 *  ④ 前向き（評価）・検討・了承（物件を見せた後）:
 *       申込 … まだ内覧できない（退去予定）／すぐ来られない／内覧の後／他の申込・1部屋のみ・好条件／御見積書の後の検討・了承
 *       内覧 … それ以外（今ご内覧頂ける部屋）
 *  ⑤ 内覧の取り消し → 別日のご案内
 * 返信では**どれも必須にしない**（must は使わない）: 手打ちの返信に訴求を入れた割合は最多の場面でも 3〜5 割（APPEAL_STATS）。
 */
export function resolveAppealTiming(i: AppealTimingInput): AppealTimingVerdict {
  const st = stat(i.scene, i.customer);
  const rateOf = (k: "apply" | "viewing") => (st ? (k === "apply" ? st[1] : st[2]) : null);
  const rateTxt = (k: "apply" | "viewing") => { const r = rateOf(k); return r !== null ? `（この場面で人が入れた割合 ${r}%）` : ""; };
  const anyRate = st ? st[1] + st[2] : null;
  const avoidTxt = anyRate !== null ? `（実送信でこの場面に訴求を入れたのは ${anyRate}%）` : "";

  // ① 入れない
  if (i.scene === "post_apply") return none("avoid", "申込の手続きに入った後", "【訴求のタイミング】申込の手続きに入っている。内覧・申込の訴求は書かない。");
  // 2026-10-07（uran. 10/05「よろしくお願いいたします🙇🏼‍♀️」＝友達の紹介の締めへのお礼）: 今の番の話題が物件ではなく閉じている時は、
  //   43日前の内覧の続きの申込の訴求を持ち込まない（読むべき範囲は app/lib/ack-topic-scope.ts・同じ判定を使う）
  if (i.topicClosed) return none("avoid", "お礼の番・今の話題は物件ではない（範囲が閉じている）", "【訴求のタイミング】お客様のお礼・了承は、こちらの直前の返事（物件の話ではない）への返事。内覧・申込の訴求は書かない。");
  if (i.customer === "decline" && i.viewingCancelled) {
    return {
      kind: "viewing", level: "suggest", line: APPEAL_LINES.viewing_reschedule, staffRate: rateOf("viewing"),
      reason: "内覧の取り消し＝別日のご案内",
      note: `【訴求のタイミング】お客様は内覧の予約を取り消した。受け止めて、入れるなら別日のご案内「${APPEAL_LINES.viewing_reschedule}」の形（申込の後押しは書かない）。`,
    };
  }
  if (i.customer === "decline") return none("avoid", "お客様が断った", `【訴求のタイミング】お客様は見送り・断りを伝えている。内覧・申込の訴求は書かない${avoidTxt}。`);
  if (i.customer === "concern") return none("avoid", "お客様の懸念", `【訴求のタイミング】お客様は懸念を伝えている。懸念に答えるだけで、内覧・申込の訴求は書かない${avoidTxt}。`);
  if (i.customer === "condition_change") return none("avoid", "条件の変更", `【訴求のタイミング】お客様は条件を変えている。新しい条件で探す事だけ書き、今の部屋の内覧・申込の訴求は書かない${avoidTxt}。`);
  if (i.scene === "after_apply_push" && i.customer !== "apply_intent") return none("avoid", "申込へ！の直後", `【訴求のタイミング】直前に申込のご案内を送っている。もう一度の申込・内覧の訴求は書かない${avoidTxt}。`);

  const cannotViewSoon = i.room === "move_out_not_viewable" || Boolean(i.viewingDelayed);
  // 2026-10-08 竹内さん「出張中ならオンライン内見も対応可能と伝える。これは実際の LINE にある言い回し」: すぐ来られない理由が出張中・遠方の時だけ、抑える提案に添える
  const onlineTxt = i.viewingDelayed && i.onlineViewing
    ? `${i.onlineViewing === "business_trip" ? "出張中" : "遠方"}のお客様なので、オンライン内見も対応可能と伝える（竹内さんの実送信の形「${ONLINE_VIEWING_LINE}」）。`
    : "";

  // ② 申込の意思 → 受ける
  if (i.customer === "apply_intent") {
    return none("avoid", "お客様が申込の意思を伝えた", "【訴求のタイミング】お客様は申込の意思を伝えている。後押し・内覧の誘いは書かず、受け止めて手続き（申込フォーマット＝AIX）に進む。");
  }

  // 2026-10-08 竹内さん②③④: すぐ来られない（今週は無理・予定が詰まって・来週出張 等）は、かなり刺さっている時だけ先に抑える提案。
  //   そうでなければ抑える提案は入れず、来られる日以降で内覧調整（AIX）／予定が詰まっている時は室内を撮影して送る（AIX）→ 気に入って頂けたら抑える。
  //   出張中（日付なし）・遠方・7日以上先（delayKind=fixed）と退去予定は今まで通り。戻す: PROPERTY_APPEAL_FIT=off
  const fitGated = Boolean(i.viewingDelayed) && i.room !== "move_out_not_viewable" && (i.delayKind === "busy" || i.delayKind === "short") && propertyAppealFitEnabled()
    && (i.customer === "viewing_wish" || i.customer === "positive" || i.customer === "thinking" || i.customer === "ack" || i.customer === "other" || i.scene === "viewing_adjusting");
  if (fitGated) {
    const fit = i.appealFit ?? null;
    const delayJa = i.delayKind === "busy" ? "予定が詰まっている" : "今週・近いうちは来られない";
    const fitJa = (i.appealFitLabel ? `（${i.appealFitLabel}）` : "") + (fit ? `${fit.level === "strong" ? "かなり刺さっている" : fit.level === "medium" ? "刺さり具合はそこそこ" : fit.level === "weak" ? "あまり刺さっていない" : "刺さり具合は分からない"}（${fit.why}）` : "刺さり具合は分からない");
    if (fit?.level === "strong") {
      return {
        kind: "apply", level: "suggest", line: APPEAL_LINES.apply_hold_then_view, staffRate: rateOf("apply"),
        reason: `すぐ来られない（${i.delayKind}）・かなり刺さっている`,
        note: `【訴求のタイミング】お客様は${delayJa}が、この物件は${fitJa}。内覧の日時より先に、入れるなら申込の訴求「${APPEAL_LINES.apply_hold_then_view}」の型${rateTxt("apply")}。`
          + (i.delayKind === "busy" ? "抑える提案の後に、室内を撮影してお送りする（撮影して送るのは AIX・返信は「一度室内撮影しお送りさせて頂きます」の約束まで）。" : "")
          + "日時のない内覧の誘いは書かない。押し付けない（お気に召されましたら）。" + onlineTxt,
      };
    }
    return none("suggest", `すぐ来られない（${i.delayKind}）・${fit?.level ?? "unknown"}＝抑える提案は入れない`,
      `【訴求のタイミング】お客様は${delayJa}。この物件は${fitJa}なので、お部屋を抑える提案（申込の訴求）は入れない。`
      + (i.delayKind === "busy"
        ? "基本は室内を撮影してお送りし（撮影して送るのは AIX）、お気に召されてからお部屋を抑える順。返信は「一度室内撮影しお送りさせて頂きます」の約束まで（撮った・送ったとは書かない）。"
        : "来られる日以降で内覧調整（候補日は AIX【内覧調整】で出す・返信に日時を書かない）。")
      + onlineTxt);
  }

  // ③ 内覧の希望
  if (i.customer === "viewing_wish") {
    if (cannotViewSoon) {
      const why = i.room === "move_out_not_viewable" ? "このお部屋は退去予定で**まだご内覧頂けない**" : "お客様はすぐには内覧に来られない";
      return {
        kind: "apply", level: "suggest", line: APPEAL_LINES.apply_hold_then_view, staffRate: rateOf("apply"),
        reason: `内覧の希望・${i.room === "move_out_not_viewable" ? "まだ内覧できない部屋（退去予定）" : "すぐ来られない"}`,
        note: `【訴求のタイミング】お客様は内覧を希望しているが、${why}。内覧の日時を約束せず、入れるなら申込の訴求「${APPEAL_LINES.apply_hold_then_view}」の型${rateTxt("apply")}。`
          + "（実送信: 見られない・来られない部屋の内覧の希望には「お部屋抑えた状態でご内覧」をスタッフが書いている）" + onlineTxt,
      };
    }
    if (i.scene === "viewing_confirmed") {
      return none("avoid", "内覧の日にちが決まっている部屋への追加の希望", "【訴求のタイミング】内覧の日にちは決まっている。追加のお部屋は「〇日にこちらのお部屋もご案内させて頂きます」と受けるだけ（誘いの文は重ねない）。");
    }
    return {
      kind: "viewing", level: "suggest", line: APPEAL_LINES.viewing_accept, staffRate: rateOf("viewing"),
      reason: "内覧の希望（今ご内覧頂ける部屋）＝受ける",
      note: `【訴求のタイミング】お客様は内覧を希望している。受けるなら「${APPEAL_LINES.viewing_accept}」の形${rateTxt("viewing")}。日時の候補はスタッフが AIX【内覧へ！】で出す担当（返信で日時を作らない）。申込の一文は書かない。`,
    };
  }

  // 内覧の日にちの調整中／決まった後
  if (i.scene === "viewing_confirmed" || i.scene === "viewing_adjusting") {
    if (i.viewingDelayed && i.scene === "viewing_adjusting") {
      return {
        kind: "apply", level: "suggest", line: APPEAL_LINES.apply_hold_then_view, staffRate: rateOf("apply"),
        reason: "内覧の調整中・お客様がしばらく来られない",
        note: `【訴求のタイミング】お客様はしばらく内覧に来られない。入れるなら「${APPEAL_LINES.apply_hold_then_view}」の型（実送信: 「後半になりますとお部屋埋まってしまう可能性…お部屋を抑えた状態で」）。日時は作らない。${onlineTxt}`,
      };
    }
    return none("avoid", i.scene === "viewing_confirmed" ? "内覧の日にちが決まっている" : "内覧の日にちの調整中",
      i.scene === "viewing_confirmed"
        ? `【訴求のタイミング】内覧の日にちは決まっている（待ち合わせを送った後）。その部屋の「ご都合よろしいお日にちにご案内」の誘い直し・申込の後押しは書かない${avoidTxt}。`
        : `【訴求のタイミング】内覧の日にちを調整している最中。日程の返事・質問に答え、新しい申込・内覧の訴求は足さない${avoidTxt}。`);
  }

  // 質問 → 答えるだけ
  if (i.customer === "question") return none("avoid", "質問＝答えるだけ", `【訴求のタイミング】お客様は質問している。質問に答えるだけで、内覧・申込の訴求は足さない${avoidTxt}。`);

  if (!SHOWN_SCENES.has(i.scene)) return none("suggest", "物件を見せた後の場面ではない", "");

  // ④ 前向き・検討・了承（物件を見せた後）
  if (i.customer === "positive" || i.customer === "thinking" || i.customer === "ack") {
    const afterEstimate = i.scene === "after_estimate";
    const applyWhy = i.room === "move_out_not_viewable" ? "まだ内覧できない部屋（退去予定）＝見に行くではなく先に抑える"
      : i.viewingDelayed ? "お客様がすぐには内覧に来られない"
      : i.scene === "post_viewing" ? "内覧の後"
      // 前向き（評価）は内覧（実送信: 見積書後の評価 8番で内覧 75%・申込 0%）。他の申込・1部屋のみで申込に替えるのは検討・了承の時だけ
      : i.competing && i.customer !== "positive" ? "他の申込・審査中がある"
      : i.onlyOneRoom && i.customer !== "positive" ? "1部屋のみの募集（こちらの文に書いてある）"
      : afterEstimate && i.customer === "thinking" ? "御見積書を送った後の検討（R 10/05 の形）"
      : null;
    const kind: "apply" | "viewing" = applyWhy ? "apply" : "viewing";
    const line = kind === "viewing" ? APPEAL_LINES.viewing
      : cannotViewSoon ? APPEAL_LINES.apply_hold_then_view
      : i.onlyOneRoom && i.customer !== "positive" ? APPEAL_LINES.apply_scarce
      : APPEAL_LINES.apply;
    const why = applyWhy ?? (i.customer === "positive" ? "前向きな反応・今ご内覧頂ける部屋" : "今ご内覧頂ける部屋");
    const custJa = i.customer === "positive" ? "前向きな反応（評価）" : i.customer === "thinking" ? "検討します" : "了承・お礼";
    // 必須は「前向き（評価）×今ご内覧頂ける部屋」だけ（2026-10-07 竹内さん チンシャン「なぜ良いですねってきてて、お部屋空室なのに内覧誘導をいれないのか」
    //   ＋実送信: 見積書後の評価 8番で内覧 75%・申込 0%）。物件オススメ後の評価は 6番で内覧 17%（件数が少なく竹内さんの指示で必須に・要確認）
    const must = i.customer === "positive" && kind === "viewing";
    return {
      kind, level: must ? "must" : "suggest", line, staffRate: rateOf(kind),
      reason: `${custJa}・${why}`,
      note: (must
        ? `【訴求のタイミング（必ず）】お客様は${custJa}で、このお部屋は今ご内覧頂ける。締めに内覧の訴求「${line}」を必ず1文入れる${rateTxt(kind)}。`
        : `【訴求のタイミング】お客様は${custJa}。${why}。締めに1文入れるなら${kind === "apply" ? "申込（お部屋を抑える）" : "内覧"}の訴求「${line}」の形${rateTxt(kind)}。`)
        + (kind === "apply" ? "日時のない内覧の誘い（ご都合よろしいお日にち）は書かない。" : "申込の一文は書かない。")
        + (i.customer === "thinking" ? "「ごゆっくりご検討ください」で受け止めた後に置く。急かさない（この1文は扉の文で、禁止している申込の催促・申込誘導には当たらない）。" : "")
        + (i.customer === "positive" ? "御見積書の約束・送付を書く時も、締めの訴求を落とさない。" : "")
        + (kind === "apply" && i.viewingDelayed ? onlineTxt : "")
        + "煽り（埋まってしまう前に・残り1部屋・好条件）は会話・資料に書いてある時だけ。",
    };
  }

  return none("suggest", "その他", "");
}

/* ───────────── 会話から入力を作る（ブレイン・返信・監査が同じ関数で読む） ───────────── */

export type AppealMsg = { sender: string; text: string | null; createdAt: string };
export type AppealAixLog = { aixType: string | null; at: string };

const SCENE_BY_AIX: Record<string, AppealScene> = {
  property_recommendation: "after_recommend",
  property_send: "after_pickup",
  estimate_sheet: "after_estimate",
  property_check_result: "after_check",
  viewing_invite: "viewing_adjusting",
  meeting_place: "viewing_confirmed",
  greeting_viewing: "post_viewing",
  application_push: "after_apply_push",
};
/** 内覧の後のこちらの文（「本日はお時間頂きありがとうございました」「ご内覧ありがとうございました」） */
export const POST_VIEWING_STAFF_RE = /本日は?(?:お時間|ご内覧)[^\n。！!]{0,10}ありがとうございました|ご内覧(?:頂き|いただき)?ありがとうございました/;
/** お客様がすぐには内覧に来られない */
export const VIEWING_DELAYED_RE = /予定(?:が)?(?:詰ま|埋ま|合わ|立た)|(?:内覧|内見|見)に?(?:は)?(?:行けない|行けません|伺えない|伺うことができ)|出張中|遠方|(?:東京|県外|地方)(?:在住|に住)|しばらく(?:行け|伺え)|今週は(?:内覧に)?行けない/;
/** お客様が内覧の予約を取り消した */
export const VIEWING_CANCEL_RE = /(?:内覧|内見)[^\n]{0,20}(?:キャンセル|取り消|行けなく)|(?:見に)?行けなくなっ/;
/** こちらが物件を見せた文（主のお部屋の状況を読む元） */
const PROPERTY_SHOWN_RE = /🌟|号室|オススメ(?:出来|でき)る|ご査収|御見積書|お見積書|募集中/;

/**
 * 会話（古い順でなくてもよい）と AIX の記録から、今回のお客様の発言に対する訴求の入力を作る。
 * customerKind は classifyCustomerResponse の kind（返信生成と同じ関数で決めた物）を渡す。
 */
export function buildAppealInput(o: {
  msgs: ReadonlyArray<AppealMsg>;
  aixLogs: ReadonlyArray<AppealAixLog>;
  customerKind: string | null | undefined;
  /** 内覧の段階（viewing-flow の resolveViewingFlow().stage）。渡されれば場面の判定に使う */
  viewingStage?: string | null;
  /** 主のお部屋がまだ内覧できない（ブレインの notViewable が分かっていれば・こちらが正） */
  notViewable?: boolean | null;
  nowMs?: number;
  /** 主のお部屋の採点の行（property_pickups・recommend-cta.pickupForFirstMessage で選んだ物）。無ければ反応だけで刺さりを読む */
  pickup?: PickupAppealRow | null;
}): AppealTimingInput {
  const msgs = [...o.msgs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  // 今回のお客様の連投（最後のこちらの文の後）
  let k = msgs.length - 1;
  while (k >= 0 && msgs[k].sender !== "customer") k--;
  let s = k;
  while (s > 0 && msgs[s - 1].sender === "customer") s--;
  const turn = k >= 0 ? msgs.slice(s, k + 1) : [];
  const turnText = turn.map((m) => m.text ?? "").filter((t) => t && !/^\[/.test(t)).join("\n");
  const turnStart = turn.length ? Date.parse(turn[0].createdAt) : (o.nowMs ?? Date.now());
  const before = msgs.slice(0, Math.max(0, s));
  const staffBefore = before.filter((m) => m.sender !== "customer");
  const staff7 = staffBefore.filter((m) => Date.parse(m.createdAt) > turnStart - 7 * 86400_000);
  const staffText7 = staff7.map((m) => m.text ?? "").join("\n");
  const cust14 = msgs.filter((m) => m.sender === "customer" && Date.parse(m.createdAt) > turnStart - 14 * 86400_000).map((m) => m.text ?? "").join("\n");

  // 場面: 直近（72時間）にこちらが物件・見積書を見せた出来事（AIX の記録か、記録が無ければ物件の文）を一番新しい物で取り、
  //   それが内覧の後・待ち合わせより新しければその場面（別のお部屋の話）。内覧の後は 14 日まで・申込以降は期間を問わず先に見る
  const logs = [...o.aixLogs].filter((l) => l.aixType && Date.parse(l.at) < turnStart).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const recentLog = logs.find((l) => Date.parse(l.at) > turnStart - 72 * 3600_000 && SCENE_BY_AIX[l.aixType ?? ""]) ?? null;
  const recentShownLog = recentLog && !/^(?:meeting_place|viewing_invite|greeting_viewing|application_push)$/.test(recentLog.aixType ?? "") ? recentLog : null;
  const recentShownMsg = [...staff7].reverse().find((m) => Date.parse(m.createdAt) > turnStart - 72 * 3600_000 && PROPERTY_SHOWN_RE.test(m.text ?? "")) ?? null;
  const sceneFromText = (t: string): AppealScene | null =>
    /御見積書|お見積書|初期費用[:：]/.test(t) ? "after_estimate"
    : /ピックアップさせて(?:頂|いただ)きました/.test(t) ? "after_pickup"
    : /🌟|オススメ(?:出来|でき)る/.test(t) ? "after_recommend"
    : /確認(?:しました|させて(?:頂|いただ)きました)[^\n]{0,20}募集中|現在募集中/.test(t) ? "after_check"
    : null;
  const shownCands: Array<{ scene: AppealScene; at: number }> = [];
  if (recentShownLog) shownCands.push({ scene: SCENE_BY_AIX[recentShownLog.aixType ?? ""], at: Date.parse(recentShownLog.at) });
  if (recentShownMsg) { const sc = sceneFromText(recentShownMsg.text ?? ""); if (sc) shownCands.push({ scene: sc, at: Date.parse(recentShownMsg.createdAt) }); }
  // 同じ送付の AIX の記録と文が両方ある時は記録を採る（3分以内は同じ出来事）
  shownCands.sort((a, b) => b.at - a.at);
  const latestShown = shownCands.length >= 2 && Math.abs(shownCands[0].at - shownCands[1].at) <= 3 * 60_000 && recentShownLog
    ? { scene: SCENE_BY_AIX[recentShownLog.aixType ?? ""], at: Date.parse(recentShownLog.at) }
    : shownCands[0] ?? null;
  const lastPostViewingText = [...staffBefore].reverse().find((m) => POST_VIEWING_STAFF_RE.test(m.text ?? "")) ?? null;
  const greetLog = logs.find((l) => l.aixType === "greeting_viewing") ?? null;
  const postViewAt = Math.max(lastPostViewingText ? Date.parse(lastPostViewingText.createdAt) : 0, greetLog ? Date.parse(greetLog.at) : 0);
  const meetingAt = logs.find((l) => l.aixType === "meeting_place")?.at ?? null;
  const meetingMs = meetingAt ? Date.parse(meetingAt) : 0;
  let scene: AppealScene = "other";
  if (staffBefore.some((m) => isPostApplyText(m.text))) scene = "post_apply";
  else if (latestShown && latestShown.at > Math.max(postViewAt, meetingMs)) scene = latestShown.scene;
  else if (o.viewingStage === "done" || (postViewAt > 0 && postViewAt > turnStart - 14 * 86400_000)) scene = "post_viewing";
  else if (o.viewingStage === "confirmed" || o.viewingStage === "date_agreed" || (meetingMs > turnStart - 14 * 86400_000 && meetingMs > postViewAt)) scene = "viewing_confirmed";
  else if (latestShown) scene = latestShown.scene;
  else if (recentLog) scene = SCENE_BY_AIX[recentLog.aixType ?? ""];
  else if (o.viewingStage === "proposing") scene = "viewing_adjusting";
  else if (/御見積書|お見積書|初期費用[:：]/.test(staffText7)) scene = "after_estimate";

  // お客様
  const ck = String(o.customerKind ?? "");
  let customer: AppealCustomer;
  if (CUSTOMER_APPLY_INTENT_RE.test(turnText)) customer = "apply_intent";
  else if (ck === "decline") customer = "decline";
  else if (ck === "concern") customer = "concern";
  else if (ck === "condition_change") customer = "condition_change";
  else if (CUSTOMER_VIEWING_WISH_RE.test(turnText) && !VIEWING_CANCEL_RE.test(turnText) && (ck === "positive" || ck === "question" || ck === "other" || ck === "answer")) customer = "viewing_wish";
  else if (ck === "positive" || (CUSTOMER_APPRAISAL_RE.test(turnText) && (ck === "ack_only" || ck === "other" || ck === "answer"))) customer = "positive";
  else if (ck === "thinking") customer = "thinking";
  else if (ck === "ack_only") customer = "ack";
  else if (ck === "question") customer = "question";
  else customer = "other";
  const viewingCancelled = VIEWING_CANCEL_RE.test(turnText);
  if (viewingCancelled && customer !== "apply_intent") customer = "decline";

  // 部屋: 直近にこちらが物件を見せた文（主のお部屋）に退去予定があるか
  let room: AppealRoom = "vacant";
  const lastShown = [...staff7].reverse().find((m) => PROPERTY_SHOWN_RE.test(m.text ?? "")) ?? null;
  const shownText = lastShown?.text ?? "";
  if (typeof o.notViewable === "boolean") room = o.notViewable ? "move_out_not_viewable" : /退去予定/.test(shownText) ? "move_out_viewable" : "vacant";
  else if (/退去予定|退去前/.test(shownText)) {
    const m = shownText.match(/([0-9０-９]{1,2})\s*[月\/／]\s*([0-9０-９]{1,2})?\s*日?\s*(?:末|中旬|下旬|上旬)?\s*(?:退去予定|退去)/);
    if (m) {
      const month = Number(m[1].normalize("NFKC"));
      const now = new Date(turnStart + 9 * 3600_000);
      const nowMonth = now.getUTCMonth() + 1;
      const monthsAhead = (month - nowMonth + 12) % 12;
      const day = m[2] ? Number(m[2].normalize("NFKC")) : 31;
      room = monthsAhead < 6 && (monthsAhead > 0 || day >= now.getUTCDate()) ? "move_out_not_viewable" : "move_out_viewable";
    } else room = "move_out_not_viewable";
  }

  // 2026-10-08 竹内さん②③④: すぐ来られない理由の型と、主のお部屋の刺さり具合（採点＋お客様の反応）
  const valid = validCircumstances(extractCircumstances(msgs.filter((m) => m.sender === "customer" && Date.parse(m.createdAt) > turnStart - 60 * 86400_000), turnStart), turnStart);
  const delayKind = resolveDelayKind(turnText, valid, turnStart);
  const shownAt = lastShown ? Date.parse(lastShown.createdAt) : null;
  const appealFit = shownAt != null && propertyAppealFitEnabled()
    ? resolvePropertyAppealFit({
      pickup: o.pickup ?? null,
      reaction: readAppealReaction(msgs.filter((m) => m.sender === "customer" && Date.parse(m.createdAt) > shownAt).map((m) => ({ text: m.text, createdAt: m.createdAt })), { sentAt: lastShown?.createdAt ?? null }),
      // 2026-10-09 決める寸前の印（「〇〇なら決める」＝決まった計算で強いのはこの言い方だけ・customer-mindset.decideSignalOf）
      decideSignal: decideGapEnabled() ? decideSignalOf(readDecideGapsInTurn({ text: msgs.filter((m) => m.sender === "customer" && Date.parse(m.createdAt) > shownAt).map((m) => String(m.text ?? "")).join("\n") })) : null,
    })
    : null;

  // 前回の訴求（表示用）
  let lastAt: number | null = null; let lastKind: "apply" | "viewing" | null = null;
  for (const m of staffBefore) {
    const ap = detectAppeal(m.text);
    if (ap.apply || ap.viewing) { lastAt = Date.parse(m.createdAt); lastKind = ap.apply ? "apply" : "viewing"; }
  }
  return {
    scene, customer, room,
    scarcity: SCARCITY_RE.test(shownText),
    onlyOneRoom: /[1１一]部屋のみ/.test(shownText),
    competing: COMPETING_RE.test(staffText7),
    urgent: URGENT_RE.test(cust14),
    estimateSent: /御見積書|お見積書|初期費用[:：]/.test(staffText7) || logs.some((l) => l.aixType === "estimate_sheet" && Date.parse(l.at) > turnStart - 7 * 86400_000),
    // 2026-10-08 把握「お客様の事情」: 今の発言の決まった言い方に加え、前の発言の「〇日以降なら来られる」（2日より先）・遠方・しばらく来られない（鮮度つき）も
    //   すぐ来られないに数える（customer-circumstances.ts・APPEAL_CIRCUMSTANCES=off で今の発言だけ）
    viewingDelayed: VIEWING_DELAYED_RE.test(turnText) || circumstanceDelaysViewing(valid, turnStart) || delayKind === "short" || delayKind === "busy",
    delayKind,
    appealFit,
    appealFitLabel: ((h) => (h ? h.name + " " + h.room + "号室" : null))(headOfFirstMessage(shownText)),
    viewingCancelled,
    onlineViewing: onlineViewingOf(turnText, msgs, turnStart),
    topicClosed: ((sc) => sc.closedNonPropertyTopic && !POST_VIEWING_STAFF_RE.test(sc.staffText) && !/内覧|ご案内|お部屋/.test(sc.staffText))(
      resolveAckTopicScope(msgs.map((m) => ({ sender: m.sender, text: m.text, created_at: m.createdAt })))),
    hoursSinceLastAppeal: lastAt !== null ? Math.round((turnStart - lastAt) / 3600_000) : null,
    lastAppealKind: lastKind,
  };
}

/**
 * すぐ来られない理由の型（2026-10-08 竹内さん②③④）。無ければ null。
 *   fixed … 出張中（日付なし）・遠方・「〇日以降」が7日以上先（今まで通り先に抑える提案＝竹内さんの決定 a8bfe733・e6a9b05e）
 *   busy  … 予定が詰まって・しばらく・当分（日付なし）
 *   short … 今週は無理・来週出張・伺えない・行けない（今の発言）
 */
export function resolveDelayKind(turnText: string, valid: ReadonlyArray<Circumstance>, nowMs: number): "fixed" | "busy" | "short" | null {
  const t = String(turnText ?? "").normalize("NFKC");
  const from = valid.find((c) => c.kind === "available_from" && c.fromDayMs != null);
  if (from?.fromDayMs != null && Math.round((from.fromDayMs - nowMs) / 86400_000) >= holdFirstMinDays()) return "fixed";
  if (valid.some((c) => c.kind === "remote") || /遠方|(?:東京|県外|地方)(?:在住|に住)/.test(t)) return "fixed";
  const soon = valid.filter((c) => c.kind === "cannot_come_soon");
  if (soon.some((c) => undatedHoldKind(c.quote) === "business_trip") || (/出張中/.test(t) && !/来週|再来週|来月|[0-9]{1,2}日/.test(t))) return "fixed";
  if (soon.some((c) => undatedHoldKind(c.quote) === "busy") || /予定(?:が)?(?:詰ま|埋ま|立た)|しばらく|当分/.test(t)) return "busy";
  if (soon.some((c) => c.thisTurn) || VIEWING_DELAYED_RE.test(t) || /今週は?[^。\n]{0,6}(?:無理|難し|厳し|行けな)|出張[^。\n]{0,10}(?:行け|伺え|厳し|無理|難し)/.test(t)) return "short";
  return null;
}

/** 出張中・遠方（今の発言の決まった言い方か、前の発言のお客様の事情）。APPEAL_ONLINE_VIEWING=off で null */
export function onlineViewingOf(turnText: string, msgs: ReadonlyArray<AppealMsg>, turnStart: number, env: Record<string, string | undefined> = process.env): "business_trip" | "remote" | null {
  if ((env.APPEAL_ONLINE_VIEWING ?? "").trim().toLowerCase() === "off") return null;
  const t = String(turnText ?? "").normalize("NFKC");
  if (/出張中|出張で[^。\n]{0,8}(?:行け|伺え|厳し|無理|難し)/.test(t)) return "business_trip";
  if (/遠方|(?:東京|県外|地方)(?:在住|に住)/.test(t)) return "remote";
  return onlineViewingReason(validCircumstances(extractCircumstances(msgs.filter((m) => m.sender === "customer" && Date.parse(m.createdAt) > turnStart - 60 * 86400_000), turnStart), turnStart), env);
}

/** 画面・ログ用の短い説明（「見積書後×検討します×空室 → 申込（材料）」） */
export function describeAppeal(i: AppealTimingInput, v: AppealTimingVerdict): string {
  const ja: Record<string, string> = {
    after_recommend: "物件オススメ後", after_pickup: "ピックアップ後", after_estimate: "見積書後", after_check: "物件確認した後",
    viewing_adjusting: "内覧調整中", viewing_confirmed: "内覧決定後", post_viewing: "内覧後", after_apply_push: "申込へ！直後", post_apply: "申込以降", other: "その他",
    apply_intent: "申込の意思", viewing_wish: "内覧希望", positive: "前向き", thinking: "検討", ack: "了承", question: "質問",
    concern: "懸念", condition_change: "条件変更", decline: "断り",
    vacant: "空室", move_out_not_viewable: "退去予定(まだ見られない)", move_out_viewable: "退去予定(見られる)", unknown: "不明",
  };
  const k = v.kind === "apply" ? "申込" : v.kind === "viewing" ? "内覧" : "なし";
  const lv = v.level === "avoid" ? "入れない" : v.level === "must" ? "必須" : "材料";
  return `${ja[i.scene]}×${ja[i.customer]}×${ja[i.room]} → ${k}（${lv}）`;
}

/* ───────────── 生成・ブレインへの渡し方（入口だけ。本文を書き換える出口は作らない） ───────────── */

/** APPEAL_TIMING=off で全部止まる（ブレインの材料・返信の材料・方向への追記） */
export function appealTimingEnabled(): boolean {
  return (process.env.APPEAL_TIMING ?? "").trim().toLowerCase() !== "off";
}

/**
 * 返信生成のプロンプトに入れる1行。行頭は「- 」（万一本文に混ざっても stripMetaNarration が落とす形・apply-readiness と同じ）。
 * note が空（材料なし）なら空文字。
 */
export function buildAppealReplyNote(v: AppealTimingVerdict | null | undefined): string {
  if (!v || !v.note) return "";
  return `- ${v.note.replace(/\s*\n\s*/g, " ")}`;
}

/** ブレインの材料（毎回変わる側＝user 側に置く）。note が空なら空文字 */
export function buildAppealBrainText(i: AppealTimingInput, v: AppealTimingVerdict): string {
  if (!v.note) return "";
  return `\n【訴求のタイミング（会話から決定論で読んだ材料・reply_direction の締めに反映する）】${describeAppeal(i, v)}\n${v.note}`;
}

/**
 * ブレインが決定論で作った返信の方向（2段の約束の返信など）に、必須の訴求を1文足す。
 * 足すのは level=must の時だけ（材料の時は足さない＝実送信の過半数が書いていない形を必須にしない）。
 * 既に方向に内覧・申込の訴求の語がある時は足さない。
 */
export function withAppealDirection(direction: string | null, v: AppealTimingVerdict | null | undefined): string | null {
  if (!direction || !v || v.level !== "must" || !v.line) return direction;
  // 既に誘いの形がある時だけ足さない（「内覧の日時のご希望など」等の語には反応しない＝2段の約束の方向の定型文に「内覧」の語がある）
  if (detectAppeal(direction).apply || detectAppeal(direction).viewing) return direction;
  return `${direction}。締めに${v.kind === "viewing" ? "内覧" : "申込"}の訴求「${v.line}」を1文入れる（お客様は前向き・今ご内覧頂けるお部屋）`;
}

/**
 * 会話と AIX の記録から、今回のお客様の発言に対する訴求を決める（ブレイン用・お客様の反応の分類も返信生成と同じ関数で行う）。
 */
export function resolveAppealFromConversation(o: {
  msgs: ReadonlyArray<AppealMsg>;
  aixLogs: ReadonlyArray<AppealAixLog>;
  viewingStage?: string | null;
  notViewable?: boolean | null;
  pickup?: PickupAppealRow | null;
}): { input: AppealTimingInput; verdict: AppealTimingVerdict } | null {
  const msgs = [...o.msgs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  let k = msgs.length - 1;
  if (k < 0 || msgs[k].sender !== "customer") return null; // 最後がこちらの発言（お客様の反応待ち）なら決めない
  let s = k;
  while (s > 0 && msgs[s - 1].sender === "customer") s--;
  const turnText = msgs.slice(s, k + 1).map((m) => m.text ?? "").filter((t) => t && !/^\[/.test(t)).join("\n");
  if (!turnText.trim()) return null;
  const prevStaff = [...msgs.slice(0, s)].reverse().find((m) => m.sender !== "customer" && (m.text ?? "").trim() && !/^\[/.test(m.text ?? "")) ?? null;
  const staffTurn = classifyLastStaffTurn(prevStaff?.text ?? "", { lastStaffAt: prevStaff?.createdAt ?? null });
  const sub = analyzeSubstance(turnText, undefined, { staffAskedQuestion: staffTurn.kind === "question_to_customer" });
  const cr = classifyCustomerResponse(sub, staffTurn, { recentStaffText: prevStaff?.text ?? "" });
  const input = buildAppealInput({ msgs, aixLogs: o.aixLogs, customerKind: cr.kind, viewingStage: o.viewingStage ?? null, notViewable: o.notViewable ?? null, pickup: o.pickup ?? null });
  return { input, verdict: resolveAppealTiming(input) };
}

/**
 * AIX の2通目の CTA（cta-guidance）を部屋の状況に合わせる: まだ内覧できない部屋（退去予定）なのに内覧の誘いになっていたら申込（抑えた状態でご内覧）に替える。
 * 実送信: 退去予定の部屋の誘導は申込 34 vs 内覧 9（recommend-closing の実測）・内覧の希望でも「お部屋抑えた状態でご内覧」。
 */
export function adjustCtaForRoom<T extends { mode: string; kind: "viewing" | "apply" | null; note: string; reason: string }>(g: T, notViewable: boolean | null | undefined): T {
  if (!notViewable || g.mode === "none" || g.kind !== "viewing") return g;
  return {
    ...g,
    kind: "apply",
    note: `【CTA（誘い）】このお部屋は退去予定で**まだご内覧頂けない**。誘うなら内覧ではなく申込の訴求「${APPEAL_LINES.apply_hold_then_view}」の型（日時のない「ご都合よろしいお日にちにご案内」は書かない）。押し付けず1文だけ。`,
    reason: `${g.reason} / room=move_out_not_viewable→apply`,
  };
}
