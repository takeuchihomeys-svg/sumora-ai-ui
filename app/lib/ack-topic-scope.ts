// app/lib/ack-topic-scope.ts
// お客様のお礼・了承だけの番で「どこを読むか（読むべき範囲）」を決める（純関数・DB も fetch も LLM も持たない）。
//
// 2026-10-07 竹内（会話「uran.」10/05）「こんなんも状況読み取れていない。対象となる会話で、どこを読み取る必要があるのか、
//   ここの部分を改善する必要がある。監視部門と協力したら出来るはず　設計知見と協力して足りない部分追加する」:
//   お客様 13:06「あと一人紹介してるので連絡くるかもしれないです」→ スタッフ 13:09「お友達のご紹介ありがとうございます！！
//   ご連絡いただけましたら私の方で迅速に対応させて頂きます😌！！」→ お客様 13:10「よろしくお願いいたします🙇🏼‍♀️」→
//   下書き「はい😊！！引き続きuranさんにオススメできるお部屋を玉造エリア全域からピックアップしてお送りさせて頂きます！！」。
//   43日前（8/23 内覧）で止まっていた物件探しの話題を、友達の紹介の締めのお礼に持ち込んだ。
//
//   出所（scripts/audit-ack-topic-scope.ts で実物を読んだ）:
//     ①ブレインの「会話全体の方針」（winning_pattern・closing_strategy＝4分前の全体分析の『uranさんの物件探しも引き続き全力でサポート』）が
//       generate-reply で「勝ちパターン×成約戦略 → 今回の返信末尾に WE DO 宣言1文」として**必須**で入った（古い話題の注入・穴:G6）
//     ②返信不要の入口（previous-send-note.shouldSkipDraftAfterClosing）は、こちらの締め「ご連絡いただけましたら…対応させて頂きます」を
//       締めと読めず、お客様の「🙇🏼‍♀️」（ZWJ つきの絵文字）でお礼だけとも読めなかった（分類の穴・穴:G1）
//     ③最終チェックは DOUBLE_DECLARATION（warning）を出したが、文体だけの warning は書き直さない決まりで残った
//     ④見張り（line_watch_turns）はこの番を「スタッフが送っていない（na）」で数えず、AI だけが書いた行為（お部屋を探す宣言）は見えていなかった
//
//   読むべき範囲（この関数の答え）:
//     お客様のお礼・了承は「こちらの直前の返事」に対する返事。範囲は【こちらの直前の返事の束】＋【その返事が答えたお客様の番】だけ。
//     それより前（とくに日の空いた前の話題）は今の番の話題ではない。返事は範囲の中の事だけ（範囲にこちらの行為が無ければ、行為を足さない）。
//
//   線（scripts/audit-ack-topic-scope.ts・365日の実送信・グループ会話と YUMA を除く）は ACK_TOPIC_AUDIT に数字を残す。
// テスト: app/lib/__tests__/ack-topic-scope.test.ts（uran. の実物）
import { staffActsOf, type StaffAct } from "./customer-sim-shadow";

export type ScopeMsg = { sender: string; text?: string | null; created_at?: string | null; is_aix_generated?: boolean | null };

/**
 * お客様の「お礼・了承だけ」（1語ずつ当てる）。previous-send-note.isShortAckOnly と同じ語の並びに、
 * ZWJ（U+200D）・肌の色・性別の記号で割れる絵文字（🙇🏼‍♀️ 🙏🏻 🙇‍♂️）を区切りに足した物。
 * uran.「よろしくお願いいたします🙇🏼‍♀️」が isShortAckOnly では ZWJ が語に残って false だった（穴:G1）。
 */
const ACK_TOKEN_RE =
  /^(?:[はハ]い|うん|りょ|了解(?:です|でした|しました)?|承知(?:です|しました|(?:致|いた)しました)?|わかりました|分かりました|かしこまりました|ありがとう(?:ございます|ございました)?|有難う(?:ございます)?|あざす|OK|ok|Ok|オッケー|おっけー|(?:よろしく|宜しく)?お願い(?:します|(?:致|いた)します)|(?:よろしく|宜しく)です|大丈夫(?:です)?|助かります|感謝です|では|それでは)$/;
const ACK_SPLIT_RE = /[\s　、,。．.！!？?…♪♡❤〜~ー\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}\u{200D}\u{1F3FB}-\u{1F3FF}]+/gu;
export function isAckOnlyTurn(text: string | null | undefined): boolean {
  const s = String(text ?? "").normalize("NFKC").trim();
  if (!s || [...s].length > 40) return false;
  if (/[?？]/.test(s) || /[\[［【]/.test(s)) return false;
  const tokens = s.split(ACK_SPLIT_RE).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 4) return false;
  return tokens.every((t) => ACK_TOKEN_RE.test(t));
}

/** こちらが「これからする事」の宣言（範囲の中にあれば話題はまだ開いている＝約束の受けの番） */
const PROMISE_ACTS: ReadonlySet<StaffAct> = new Set<StaffAct>(["pickup_promise", "check_promise", "estimate_promise", "phone_promise"]);
/** 行為の型に無い約束（「撮影出来次第すぐにお送り」「結果が出次第ご連絡」「お送りさせて頂きます」）。監査で 62d01e33 の撮影の約束が閉じた範囲に入っていた */
const PENDING_RE = /(?:出来|でき|出|分かり|わかり)次第|次第(?:すぐに)?(?:ご連絡|お送り|ご報告)|確認(?:して|させて|致します|いたします)|ご連絡させて(?:頂|いただ)きます|お送りさせて(?:頂|いただ)きます|ご報告させて(?:頂|いただ)きます|交渉させて(?:頂|いただ)きます/;
/** 物件の話か（範囲の中に物件・内覧・費用・ピックアップの語・画像） */
const PROPERTY_TOPIC_RE = /物件|お部屋|部屋|内覧|内見|見学|見積|初期費用|家賃|ピックアップ|号室|🌟|募集|空室|申込|審査|https?:\/\/|\[画像\]/;
/** お部屋探し（ピックアップ・新着・条件）の話か。範囲がこの話でなければ「お部屋を探す宣言」は範囲の外 */
const SEARCH_TOPIC_RE = /ピックアップ|お探し|探し|探して|新着|募集(?:が)?(?:出|で)|他(?:の|に)(?:物件|お部屋|部屋)|別の(?:物件|お部屋|部屋)|物件(?:あり|ある|無い|ない)|(?:いい|良い)(?:物件|お部屋|部屋)|条件|エリア|家賃|予算|間取り|駅|徒歩|🌟|https?:\/\/|\[画像\]/;
const MEDIA_ONLY_RE = /^\[(?:画像|動画|スタンプ|ファイル)\]$/;
const DAY_MS = 86_400_000;

export type AckTopicScope = {
  /** お客様の最後の番がお礼・了承だけで、その前にこちらの文字の返事がある（この時だけ範囲を決める） */
  applies: boolean;
  reason: "ack_after_staff_reply" | "last_not_customer" | "customer_not_ack" | "no_staff_text_before" | "staff_too_old";
  /** 読むべき範囲①: こちらの直前の返事（束・画像だけの通は除く） */
  staffText: string;
  /** 読むべき範囲②: その返事が答えたお客様の番（無ければ空） */
  topicText: string;
  /** 範囲の中でこちらがした行為 */
  topicActs: StaffAct[];
  /** 範囲の中にこちらの約束（探す・確認・見積・電話）が残っている＝約束の受けの番（この関数は口を出さない） */
  topicOpen: boolean;
  /** 範囲が物件の話か */
  propertyTopic: boolean;
  /** 範囲がお部屋探し（ピックアップ・新着・条件・物件の画像や URL・AIX の送付）の話か */
  searchTopic: boolean;
  /** 範囲の前の発言からの空き（日）。7日以上なら範囲より前は『前の話題』 */
  gapDaysBefore: number | null;
  /** 返事に足してはいけない行為が決まる場面（範囲が閉じている＝こちらの約束なし・物件の話でもない） */
  closedNonPropertyTopic: boolean;
};

const NO = (reason: AckTopicScope["reason"]): AckTopicScope => ({
  applies: false, reason, staffText: "", topicText: "", topicActs: [], topicOpen: false, propertyTopic: false, searchTopic: false, gapDaysBefore: null, closedNonPropertyTopic: false,
});
const P = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);

/**
 * 古い順の会話から、お客様のお礼・了承の番の「読むべき範囲」を決める。
 * opts.customerAckOnly を渡すとそれを使う（呼び出し側の analyzeSubstance.isAckOnly 等）。無ければ isAckOnlyTurn。
 */
export function resolveAckTopicScope(
  messagesOldestFirst: ReadonlyArray<ScopeMsg>,
  opts: { customerAckOnly?: boolean; maxStaffAgeHours?: number } = {},
): AckTopicScope {
  const m = messagesOldestFirst;
  const n = m.length;
  if (!n || m[n - 1].sender !== "customer") return NO("last_not_customer");
  let i = n - 1;
  const turn: ScopeMsg[] = [];
  while (i >= 0 && m[i].sender === "customer") { turn.unshift(m[i]); i--; }
  const turnText = turn.map((x) => String(x.text ?? "")).join("\n");
  const ack = opts.customerAckOnly ?? isAckOnlyTurn(turnText);
  if (!ack) return NO("customer_not_ack");
  // こちらの直前の返事の束（お客様の番の手前まで）
  const staff: ScopeMsg[] = [];
  while (i >= 0 && m[i].sender !== "customer") { staff.unshift(m[i]); i--; }
  const staffTexts = staff.map((x) => String(x.text ?? "").trim()).filter((t) => t && !MEDIA_ONLY_RE.test(t));
  if (!staffTexts.length) return NO("no_staff_text_before");
  const lastStaffAt = P(staff[staff.length - 1]?.created_at);
  const turnAt = P(turn[0]?.created_at);
  const maxH = opts.maxStaffAgeHours ?? 72;
  if (Number.isFinite(lastStaffAt) && Number.isFinite(turnAt) && turnAt - lastStaffAt > maxH * 3600_000) return NO("staff_too_old");
  // その返事が答えたお客様の番
  const topic: ScopeMsg[] = [];
  while (i >= 0 && m[i].sender === "customer") { topic.unshift(m[i]); i--; }
  const topicText = topic.map((x) => String(x.text ?? "")).join("\n").trim();
  // 範囲の前の発言からの空き
  const prevAt = i >= 0 ? P(m[i].created_at) : NaN;
  const rangeStart = P((topic[0] ?? staff[0])?.created_at);
  const gapDaysBefore = Number.isFinite(prevAt) && Number.isFinite(rangeStart) ? Math.round(((rangeStart - prevAt) / DAY_MS) * 10) / 10 : null;
  const staffText = staffTexts.join("\n");
  const acts = staffActsOf(staffText);
  const topicOpen = [...acts].some((a) => PROMISE_ACTS.has(a)) || PENDING_RE.test(staffText);
  const propertyTopic = PROPERTY_TOPIC_RE.test(staffText) || PROPERTY_TOPIC_RE.test(topicText) || staff.some((x) => x.is_aix_generated === true);
  const searchTopic = SEARCH_TOPIC_RE.test(staffText) || SEARCH_TOPIC_RE.test(topicText) || staff.some((x) => x.is_aix_generated === true)
    || acts.has("pickup_promise") || acts.has("pickup_done");
  return {
    applies: true, reason: "ack_after_staff_reply", staffText, topicText, topicActs: [...acts], topicOpen, propertyTopic, searchTopic, gapDaysBefore,
    closedNonPropertyTopic: !topicOpen && !propertyTopic,
  };
}

/** 生成（generate-reply の recentMessages）の形から決める。ACK_TOPIC_SCOPE=off で常に「当てない」 */
export function ackTopicScopeFromRecent(recent: ReadonlyArray<{ sender: string; text?: string | null; createdAt?: string | null; isAix?: boolean | null }>): AckTopicScope {
  if (process.env.ACK_TOPIC_SCOPE === "off") return NO("customer_not_ack");
  return resolveAckTopicScope(recent.map((m) => ({ sender: m.sender, text: m.text ?? null, created_at: m.createdAt ?? null, is_aix_generated: m.isAix ?? null })));
}

/** 下書きの行為のうち、読むべき範囲に無い物（範囲が閉じていて物件の話でもない時だけ数える） */
export function outOfTopicActs(draft: string | null | undefined, scope: AckTopicScope): StaffAct[] {
  if (!scope.applies || !scope.closedNonPropertyTopic) return [];
  const have = new Set(scope.topicActs);
  return [...staffActsOf(draft ?? "")].filter((a) => !have.has(a));
}

/**
 * 生成の材料（入口）。範囲が閉じていて物件の話でもない時だけ1行を返す（それ以外は空＝今までどおり）。
 * ⚠ 本文（範囲の文）は引用しない（設計知見 55686a40「本文を引用して渡すと写す」）。話題の種類と、足さない事だけを書く。
 */
export function buildAckTopicNote(scope: AckTopicScope): string {
  if (!scope.applies || !scope.closedNonPropertyTopic) return "";
  const gap = scope.gapDaysBefore !== null && scope.gapDaysBefore >= 7 ? `（その前の話題は${Math.round(scope.gapDaysBefore)}日前で、今の話題ではない）` : "";
  return [
    "【📍 今の番の読むべき範囲（決定論）】",
    `- お客様の今回の発言はお礼・了承だけで、こちらの直前の返事（とそれが答えたお客様の発言）への返事。この範囲の話題はこちらの直前の返事で閉じている${gap}`,
    "- ⛔ 範囲の外の話題（前のお部屋探し・ピックアップ・内覧・見積書・確認の約束など）を今回の返事に持ち込まない。ブレインの戦略・勝ちパターンの WE DO 宣言も今回は入れない",
    // 実送信（この場面 38番）: 返さない 7・AIX だけ 2・文字 29（うち範囲の中だけ 23＝「はい😊！！／6/29 当日、何卒よろしくお願い致します！！」型が中心。
    //   紹介の場面 97962e93 も「良いお部屋でお引越し出来ますようサポートさせて頂きます！！…何卒よろしく」と紹介の話題の中で締めた）
    "- 返事は受け（開口語＋この範囲の話題への一言まで＋締め）にする。新しい予定・作業の宣言は書かない",
  ].join("\n");
}

/**
 * 監査の数字（scripts/audit-ack-topic-scope.ts・2026-10-07・365日・グループ会話と YUMA を除く）。
 * コードの判断はこの数字に依る。線を変える時は監査を回し直して書き換える。
 */
export const ACK_TOPIC_AUDIT = {
  date: "2026-10-07",
  /** 返事を数えた期間（6/1〜・5月までは AI の自動返信の文が staff に混ざる）。返事＝最初のまとまり（10分・30分＝見張りと同じ） */
  from: "2026-06-01",
  /** 範囲が決まったお礼・了承の番 */
  scopedTurns: 633,
  /** 閉じた・物件以外（closedNonPropertyTopic）: 返さない 7・AIX だけ 2・文字 29（範囲の中だけ 23・外の行為を足した 6＝探す宣言 3・待ち合わせ 2・申込書類 1） */
  closedNonProperty: { n: 38, none: 7, aixOnly: 2, text: 29, inTopic: 23, outOfTopic: 6, pickup: 3 },
  /** 範囲がお部屋探しの話（searchTopic）: 文字 329 のうち外の行為 136（送付の体 60・金額 39…）＝ここは口を出さない */
  searchTopic: { n: 460, text: 329, outOfTopic: 136, pickup: 25 },
  /** 前の話題から7日以上空いた番（uran. を含む）は 2番だけ（返さない 1・AIX だけ 1）＝線は引けないので「閉じた・物件以外」で当てる */
  gap7: { n: 2 },
  /**
   * 止めた判断（2026-10-07）:
   *  ①本文から消す出口にしない — スタッフも閉じた・物件以外の番で 6/29 は行為を足す（誤削除0にならない）。自動送信だけ止める（auto-reply-dispatch）
   *  ②下書きを作らない（返信不要）にしない — この場面のスタッフは 29/38（76%）が文字で返す（過半数が返す）
   *  ③previous-send-note.isShortAckOnly に ZWJ を足さない — お礼の番は 627→728 に増えるが、増えた分で返信不要の入口が止める番は 2・どちらもスタッフは返していた
   */
} as const;
