// app/lib/writing-blueprint-patterns.ts — 文の設計図の「場面の型」（段1・決まった処理だけ・LLM なし）
//
// 2026-10-23 計画7（kb-1020-audit の 🔴）: 10/20 の竹内さんの会話の型の決定がコードに無かった。
//   文の設計図（writing-blueprint.ts）の上に「その番に当てはまる型」を決まった処理で見つけて、書く役へ短い1行ずつ渡す。
//   WRITING_BLUEPRINT=on の時だけ（generate-reply の毎回変わる側・設計図の注記の後ろ）。off の時は1文字も変わらない。
//   判断（何を答える・何を約束する・AIX）はブレインのまま。ここは「決まった中身をどう書くか」の型だけ。
//   スタッフしか分からない事（見積の金額・募集状況）は書かない＝AIX で送る（P0）。
//
// 型（決定の id）:
//   continuation         e0e83baa 数分の続きの番＝挨拶・前置き・締めを省いて『かしこまりました！！』＋約束（物件名・階まで具体的に）
//   concrete_condition   1bc5683e 確認の約束・答えにお客様の条件をそのまま（猫を飼う人の『犬のみですか』→『猫飼育可能か』）
//   kasa_promise_only    c0b845e8 『お手隙の際にご査収ください』は送った時だけ（約束だけの番に付けない）＋ fixKasaOnPromiseOnly（出口）
//   timing_knowledge     9b8dbfca 時期の質問に不動産の知識（申込から入居まで約1ヶ月・逆算・探し始め・繁忙期）
//   cost_unpointed       adc4d260 物件を指さない初期費用（送った物件が多い）＝気に入ったお部屋を教えて頂く・管理会社への確認の約束にしない
//   restate_apology      317c7a7c 要望の言い直しで謝った＝『全然大丈夫です』でなく受け入れ＋『ご満足頂けるお部屋が見つかるのが一番』
//   liked_but_mismatch   d9fa213d 気に入った物件に条件が1つ合わない＝並行の2つの手＋期日（明日中）
//   widen_permission     bf2c0517 『〜までなら大丈夫』＝広げる許し（絞らせて頂き と書かない・事情を受け止める・条件の並びを繰り返さない）
//   own_deadline         d9533aad お客様が自分で言った期日（今日中にまた連絡）を返さない＝ごゆっくり＋名前＋何時でもお気軽に
//   mirror_notation      5192922a お客様の書き方に合わせる（お願い致します／いたします）＋ mirrorClosingNotation（出口）
//   （deaa7f9b『ご査収頂きありがとうございます』は reply-context.ts の門（GRATITUDE_FOR_REVIEW）で既に入っている＝ここでは足さない）

import type { ReplyScene } from "./reply-scene";

export type BlueprintPatternId =
  | "continuation" | "concrete_condition" | "kasa_promise_only" | "timing_knowledge" | "cost_unpointed"
  | "restate_apology" | "liked_but_mismatch" | "widen_permission" | "own_deadline" | "mirror_notation";

export const PATTERN_DECISION: Record<BlueprintPatternId, string> = {
  continuation: "e0e83baa", concrete_condition: "1bc5683e", kasa_promise_only: "c0b845e8", timing_knowledge: "9b8dbfca", cost_unpointed: "adc4d260",
  restate_apology: "317c7a7c", liked_but_mismatch: "d9fa213d", widen_permission: "bf2c0517", own_deadline: "d9533aad", mirror_notation: "5192922a",
};

export type PatternMsg = { sender: string; text?: string | null; createdAt?: string | null; isAix?: boolean | null; imageUrl?: string | null };

export type PatternCtx = {
  scene: ReplyScene | null;
  /** 今の番のお客様の文 */
  customerText: string;
  /** 会話（古い順・今の番のお客様の発言を含んでいてもよい） */
  messages?: ReadonlyArray<PatternMsg>;
  /** お客様の希望条件（DB） */
  customerConditions?: string | null;
  /** お客様の呼び名（〇〇） */
  name?: string | null;
  /** この番で何か送る（AIX の本体が今） */
  sentThisTurn?: boolean;
  /** 送った物件の数（台帳） */
  propertiesSentCount?: number;
  /** 今の時刻（試験の再生で上書き・既定 Date.now()） */
  nowMs?: number;
};

const norm = (s: string) => String(s ?? "").normalize("NFKC");
const nameOf = (c: PatternCtx) => (c.name && c.name.trim() ? `${c.name.trim()}さん` : "");

// ─── 会話の続き（e0e83baa）──────────────────────────────────────────
/** 前のこちらの送信から今のお客様の番までの分（こちらの送信が無い・時刻が無い時は null） */
export function minutesSinceLastStaff(messages: ReadonlyArray<PatternMsg> | undefined, nowMs = Date.now()): number | null {
  const ms = messages ?? [];
  let lastStaff = -1;
  for (let i = ms.length - 1; i >= 0; i--) if (ms[i].sender === "staff") { lastStaff = i; break; }
  if (lastStaff < 0) return null;
  const staffAt = Date.parse(String(ms[lastStaff].createdAt ?? ""));
  if (!Number.isFinite(staffAt)) return null;
  // 今の番の時刻: こちらの送信の後のお客様の最後の発言（無ければ今）
  let custAt = NaN;
  for (let i = ms.length - 1; i > lastStaff; i--) if (ms[i].sender === "customer") { custAt = Date.parse(String(ms[i].createdAt ?? "")); break; }
  const at = Number.isFinite(custAt) ? custAt : nowMs;
  const d = (at - staffAt) / 60_000;
  return d >= 0 ? d : null;
}
/** 続きの番で型を出すのは、お客様が頼む・聞く番だけ（お礼だけ・了承だけの番は閉じる型のまま） */
const CONTINUATION_ASK_RE = /[?？]|ですか|ますか|でしょうか|空いて|確認|ほしい|欲しい|教えて|調べて|送って|可能|できます|出来ます/;
/** 続きの番の線（分） */
export const CONTINUATION_MAX_MIN = 10;

// ─── お客様の条件をそのまま（1bc5683e）────────────────────────────────
const CONDITION_FAMILIES: Array<{ family: string; touch: RegExp; specifics: Array<[RegExp, string]> }> = [
  { family: "ペット", touch: /ペット|犬|猫|動物|飼育|飼え|飼う/,
    specifics: [[/猫/, "猫飼育可能か"], [/小型犬/, "小型犬飼育可能か"], [/中型犬/, "中型犬飼育可能か"], [/大型犬/, "大型犬飼育可能か"], [/うさぎ|ウサギ/, "うさぎ飼育可能か"], [/犬/, "犬飼育可能か"]] },
  { family: "駐車", touch: /駐車|車|パーキング/, specifics: [[/(?:軽|軽自動車)/, "軽自動車の駐車場の空き"], [/SUV|ハイルーフ|大きい車|大型車/, "お車のサイズで停められる駐車場か"], [/バイク|原付/, "バイク置き場の有無"]] },
  { family: "楽器", touch: /楽器|音|防音/, specifics: [[/ピアノ/, "ピアノ演奏可能か"], [/ギター/, "ギター演奏可能か"], [/楽器/, "楽器演奏可能か"]] },
  { family: "入居人数", touch: /二人|2人|ふたり|同棲|ルームシェア|カップル|子ども|子供/, specifics: [[/ルームシェア/, "ルームシェア可能か"], [/同棲|カップル|彼氏|彼女/, "二人入居可能か"], [/子ども|子供/, "お子様とのご入居可能か"]] },
];
/** お客様の事情の具体の言葉（前のやり取り・条件から）と、今の文がその話題に触れているか */
export function concreteConditionOf(c: PatternCtx): { family: string; phrase: string } | null {
  const now = norm(c.customerText);
  const before = [norm(c.customerConditions ?? ""), ...(c.messages ?? []).filter((m) => m.sender === "customer").map((m) => norm(m.text ?? ""))].join("\n");
  for (const f of CONDITION_FAMILIES) {
    if (!f.touch.test(now)) continue;
    for (const [re, phrase] of f.specifics) {
      if (!re.test(before)) continue;
      // 今の文が既にその具体の言葉で聞いている（猫は飼えますか）時は書く役もそのまま書ける＝出さない
      if (re.test(now)) return null;
      return { family: f.family, phrase };
    }
  }
  return null;
}

// ─── ご査収は送った時だけ（c0b845e8）─────────────────────────────────
const ATTACH_RE = /^\s*\[(?:画像|動画|ファイル)\]|^（室内イメージ）|^https?:\/\/\S+$/;
/** お客様の今の発言の直前のこちらの固まりに資料・AIX（送った物）がある */
export function lastStaffBlockHasAttachment(messages: ReadonlyArray<PatternMsg> | undefined): boolean {
  const ms = messages ?? [];
  let end = ms.length - 1;
  while (end >= 0 && ms[end].sender !== "staff") end--;
  for (let i = end; i >= 0 && ms[i].sender === "staff"; i--) {
    const m = ms[i];
    if (m.imageUrl || m.isAix || ATTACH_RE.test(String(m.text ?? "").trim())) return true;
  }
  return false;
}
const KASA_SENT_RE = /(?:お手隙の際に|お手すきの際に)?\s*ご査収(?:くださ|下さ)い[^\n！!。]*[！!。]*[😊😌]*[！!]*/;
const FUTURE_SEND_RE = /(?:お送り|送付|お届け|作成)(?:させて)?(?:頂|いただ)?き?(?:ます|致します|いたします)(?!か)/;
const PAST_SEND_RE = /(?:お送り|送付|お届け|ピックアップ|作成)(?:させて)?(?:頂|いただ)きました|(?:お送り|送付)(?:致し|いたし)ました|となります|同封/;
/**
 * 約束だけの番（これから作ってお送りする）に付いた「お手隙の際にご査収ください」を外す（出口・決まった処理）。
 *   外す条件（全部）: この番で何も送らない・直前のこちらの固まりに送った物が無い・下書きに「お送りします」の約束があり「お送りしました／となります」が無い
 */
export function fixKasaOnPromiseOnly(draft: string, o: { sentThisTurn?: boolean; messages?: ReadonlyArray<PatternMsg> }): { text: string; changed: string | null } {
  const text = String(draft ?? "");
  if (!text || o.sentThisTurn || !KASA_SENT_RE.test(text)) return { text, changed: null };
  if (lastStaffBlockHasAttachment(o.messages)) return { text, changed: null };
  const rest = text.replace(KASA_SENT_RE, "");
  if (!FUTURE_SEND_RE.test(rest) || PAST_SEND_RE.test(rest)) return { text, changed: null };
  const m = text.match(KASA_SENT_RE)!;
  const next = text.split("\n").map((l) => (KASA_SENT_RE.test(l) ? l.replace(KASA_SENT_RE, "") : l))
    .filter((l, i, arr) => l.trim() || (i > 0 && arr[i - 1].trim())).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!next) return { text, changed: null };
  return { text: next, changed: m[0].trim() };
}

// ─── 時期の質問（9b8dbfca）──────────────────────────────────────────
const TIMING_Q_RE = /(?:いつ(?:頃|ごろ|から|くらい|ぐらい|まで)|何月|何ヶ月前|何か月前|どれ(?:くらい|ぐらい)前|早すぎ|遅すぎ|時期|タイミング)/;
const TIMING_SUBJECT_RE = /探|申込|申し込|引っ越|引越|入居|契約|動き|動け|家賃|繁忙/; // 内覧できる日（物件の空き）は物件の事＝ここでは見ない
const BUSY_SEASON_RE = /繁忙期|閑散期|(?:今|この)(?:の|みたいな)?時期[^。！!？?]{0,12}(?:安|高)|[1-4１-４]月[^。！!？?]{0,10}(?:安|高)/;
export function timingQuestionOf(text: string): "busy_season" | "when" | null {
  const t = norm(text);
  // 条件の記入欄（①【ご入居の時期】⇒…・NFKC で ① は 1 になるので元の文で見る）は質問ではない
  if (/【|[①-⑳]|⇒/.test(String(text ?? ""))) return null;
  if (BUSY_SEASON_RE.test(t)) return "busy_season";
  // その物件の事（ここの入居はいつから）は時期の相談ではない
  if (/ここ|この|こちら|その|そちら/.test(t)) return null;
  if (TIMING_Q_RE.test(t) && TIMING_SUBJECT_RE.test(t) && /[?？]|ですか|ますか|でしょうか|かな|ですかね|べき|良い|いい/.test(t)) return "when";
  return null;
}

// ─── 物件を指さない初期費用（adc4d260）──────────────────────────────────
const COST_Q_RE = /初期費用|初期|見積|総額|費用|いくら/;
const POINTER_RE = /[0-9]+枚目|[0-9]+件目|物件の|[0-9]{1,2}\/[0-9]{1,2}|この|こちら|ここ|その|そちら|あの|先程|さっき|先ほど|号室|[ァ-ヶー]{3,}|[一-龯]{2,}(?:マンション|ハイツ|レジデンス|コーポ|荘)|[0-9]{3,4}/;
export const COST_UNPOINTED_MIN_SENT = 3;
export function isUnpointedCost(c: PatternCtx): boolean {
  const t = norm(c.customerText);
  if (!COST_Q_RE.test(t) || POINTER_RE.test(t) || t.length > 60) return false;
  if (!/いくら|どれ(?:くらい|ぐらい)|どの(?:くらい|ぐらい)|[?？]|ですか|ますか|でしょうか|教えて|知りたい/.test(t) || /分割|カード|支払/.test(t)) return false; // 金額を聞く番だけ
  return (c.propertiesSentCount ?? 0) >= COST_UNPOINTED_MIN_SENT;
}

// ─── 要望の言い直しで謝る（317c7a7c）──────────────────────────────────
const APOLOGY_RE = /(?:何度も|何回も|度々|たびたび|しつこく|コロコロ|ころころ|わがまま|ワガママ)?[^。！!]{0,6}(?:すみません|すいません|ごめんなさい|申し訳)/;
const REQUEST_RE = /エリア|駅|側|方面|沿線|家賃|万|間取り|LDK|[0-9１-９]K|築|広さ|畳|条件|考えて|希望|探して|変えて|やっぱり|やはり/;
export function isRestateApology(text: string): boolean {
  const t = norm(text);
  return APOLOGY_RE.test(t) && REQUEST_RE.test(t);
}

// ─── 気に入ったが条件が1つ合わない（d9fa213d）────────────────────────────
const LIKED_RE = /めっちゃ(?:いい|良い)|すごく(?:いい|良い)|とても(?:いい|良い)|気に入|(?:いい|良い|素敵|好き)(?:んです|んだ|ですけど|けど|のですが|んですが)|理想/;
const OBSTACLE_RE = /引っかか|ひっかか|(?<![ァ-ヶ])ネック(?![ァ-ヶ])|合わな|だけが|厳し|難し|(?:けど|けれど|ですが|のですが|んですが)[^。！!]{0,20}(?:入居|家賃|駅|遠|狭|高|時期|日|予算|駐車)/;
export function likedButMismatchOf(text: string): string | null {
  const t = norm(text);
  if (!LIKED_RE.test(t) || !OBSTACLE_RE.test(t)) return null;
  const k = /入居(?:可能)?日|入居(?:時期)?/.test(t) ? "入居可能日" : /家賃|予算|高/.test(t) ? "家賃" : /駅|遠/.test(t) ? "駅からの距離" : /狭|広さ/.test(t) ? "広さ" : /駐車/.test(t) ? "駐車場" : "合わない条件";
  return k;
}

// ─── 広げる許し（bf2c0517）──────────────────────────────────────────
const WIDEN_RE = /(?:まで|ぐらい|くらい|程度|以内)(?:なら|でも|であれば)[^。！!]{0,4}(?:大丈夫|全然|問題(?:ない|ありません|無い)|OK|ok|オッケー|いけ|構いません|平気|許容)|でも(?:大丈夫|構いません|OK|ok|いいです|良いです)/;
const WIDEN_TOPIC_RE = /駅|徒歩|分|万|家賃|築|畳|広さ|㎡|エリア|周辺|市|区|町|沿線|線|間取り|LDK|[0-9]K|車|距離/;
export function isWidenPermission(text: string): boolean { const t = norm(text); return WIDEN_RE.test(t) && WIDEN_TOPIC_RE.test(t) && !/何時|時間|[0-9]{1,2}:[0-9]{2}|[0-9]{1,2}時/.test(t); }
const OWN_SITUATION_RE = /(?:今|現在)(?:は)?[^。！!]{1,16}(?:に住んで|住み|なので|在住|に住)/;

// ─── お客様が自分で言った期日（d9533aad）─────────────────────────────────
const OWN_DEADLINE_RE = /(今日中|本日中|今日|本日|今夜|後ほど|後程|あとで|後で)[^。！!？?]{0,14}(?:連絡|返信|お返事|ご連絡|返事|お伝え|報告)(?:します|しますね|致します|いたします|させて|入れます|しますー)/;
export function ownDeadlineOf(text: string): string | null {
  const m = norm(text).match(OWN_DEADLINE_RE);
  return m ? m[1] : null;
}

// ─── 書き方に合わせる（5192922a）──────────────────────────────────────
/** お客様の「お願い致します／いたします」（今の番から古い方へ・最初に見つかった物） */
export function customerOnegaiForm(c: Pick<PatternCtx, "customerText" | "messages">): "kanji" | "kana" | null {
  const texts = [c.customerText, ...[...(c.messages ?? [])].reverse().filter((m) => m.sender === "customer").slice(0, 4).map((m) => m.text ?? "")];
  for (const raw of texts) {
    const t = norm(raw);
    const k = /お願い致し/.test(t), h = /お願いいたし/.test(t);
    if (k && !h) return "kanji";
    if (h && !k) return "kana";
  }
  return null;
}
/** 下書きの締め「お願い致します／いたします」をお客様の書き方にそろえる（出口・決まった処理） */
export function mirrorClosingNotation(draft: string, form: "kanji" | "kana" | null): { text: string; changed: string | null } {
  const text = String(draft ?? "");
  if (!form || !text) return { text, changed: null };
  const from = form === "kanji" ? /お願いいたします/g : /お願い致します/g;
  const to = form === "kanji" ? "お願い致します" : "お願いいたします";
  if (!from.test(text)) return { text, changed: null };
  from.lastIndex = 0;
  return { text: text.replace(from, to), changed: `→${to}` };
}

// ─── まとめ ─────────────────────────────────────────────────────────
export type PatternHit = { id: BlueprintPatternId; line: string };

/** その番に当てはまる型（決まった処理）と書く役への1行 */
export function detectBlueprintPatterns(c: PatternCtx): PatternHit[] {
  const out: PatternHit[] = [];
  const t = norm(c.customerText);
  const nm = nameOf(c);
  const gap = minutesSinceLastStaff(c.messages, c.nowMs ?? Date.now());
  const deadline = ownDeadlineOf(t);
  const widen = isWidenPermission(t);
  const liked = likedButMismatchOf(t);
  const apology = isRestateApology(t);
  if (gap !== null && gap <= CONTINUATION_MAX_MIN && t.length <= 120 && CONTINUATION_ASK_RE.test(t) && !deadline && !apology && !liked) {
    out.push({ id: "continuation", line: `会話の続きの番（前の返信から${Math.max(1, Math.round(gap))}分）: 名前・お世話になっております・お礼の重ね・締めの言葉を省き、『かしこまりました！！』＋約束（または答え）の1〜2文。約束の中身は物件名・階など具体的に（例: 〇〇の12階の募集状況確認させて頂きます！！）` });
  }
  const cc = concreteConditionOf(c);
  if (cc) out.push({ id: "concrete_condition", line: `お客様の事情（${cc.family}）を把握している事を伝える: 確認の約束・答えは『${cc.phrase}』とお客様の条件の言葉で具体的に書く（『ペット飼育の可否』『ご条件』等の一般の言葉に丸めない）` });
  if (!c.sentThisTurn && (c.scene === "cost" || COST_Q_RE.test(t))) out.push({ id: "kasa_promise_only", line: "御見積書を作ってお送りする約束の番＝まだ何も送っていない。『お手隙の際にご査収ください』は書かない（送った時だけの締め）" });
  const tq = timingQuestionOf(t);
  if (tq === "when") out.push({ id: "timing_knowledge", line: "時期の質問＝今の状況を整理し不動産の知識で答える（確認の約束にしない）: ①お申込みからご入居まで1ヶ月以内がほとんど②お客様の予定から逆算した申込の時期（約1ヶ月前）と理由（審査・契約手続きがスムーズ）③部屋探しを始める・再開する目安（その少し前）をオススメ" });
  if (tq === "busy_season") out.push({ id: "timing_knowledge", line: "時期・繁忙期の質問＝一般の知識で答える（確認の約束にしない）: 1〜3月は4月入居に向けた繁忙期で家賃・礼金が上がりやすく条件の良いお部屋はすぐ埋まる傾向・入居日が決まっていなければ今の時期に探すのがオススメ。特定の物件の家賃が下がるとは言い切らない" });
  if (isUnpointedCost(c)) out.push({ id: "cost_unpointed", line: `物件を指さない初期費用の質問（送ったお部屋 ${c.propertiesSentCount}件）: 管理会社への確認の約束にしない。『お気に召されたお部屋の最大限割引しました初期費用御見積しお送りさせて頂きます！！』で気に入ったお部屋を教えて頂く（オススメの1件の見積はスタッフが AIX で送る・金額は書かない）` });
  if (apology) out.push({ id: "restate_apology", line: `要望を言い直して謝っている: 『全然大丈夫です』で返さず、要望を受けて条件に反映した約束→『${nm}ご満足頂けるお部屋が見つかるのが一番ですのでご要望等出てきましたらいつでもお気軽にご連絡ください😊！！』→締め` });
  if (liked) out.push({ id: "liked_but_mismatch", line: `気に入ったお部屋に条件が1つ合わない（${liked}）: ご査収頂きありがとうございます＋かしこまりました→並行して①${liked}が合うお部屋を重点的にピックアップ②気に入ったお部屋に近い好条件のお部屋を徹底的にお調べ→期日（明日中）にご連絡→締め。申込を急かさない` });
  if (widen) out.push({ id: "widen_permission", line: `『〜までなら大丈夫』は条件を広げる許し: 『絞らせて頂き』と書かず『〜まで広げて』と書く。${OWN_SITUATION_RE.test(t) ? "お客様が話した事情（今の住まい等）を一言受け止める。" : ""}少し前に言った条件の並びを全部繰り返さない` });
  if (deadline) out.push({ id: "own_deadline", line: `お客様が自分で期日を言った（${deadline}）: その期日を繰り返さない（『本日のご連絡お待ちしております』は圧）。『はい😊！！ごゆっくりご確認頂けますと幸いです！！${nm}気になる点出てきましたら何時でもお気軽にご連絡ください😊！！』＋締め` });
  const form = customerOnegaiForm(c);
  if (form) out.push({ id: "mirror_notation", line: `お客様の書き方に合わせる: お客様は『お願い${form === "kanji" ? "致します』（漢字）→締めも『致します』" : "いたします』（ひらがな）→締めも『いたします』"}` });
  return out;
}

export const PATTERN_NOTE_MAX = 900;
/** 書く役への注記（型が無ければ ""）。設計図の注記の後ろに足す */
export function buildBlueprintPatternNote(c: PatternCtx): string {
  const hits = detectBlueprintPatterns(c);
  if (!hits.length) return "";
  let text = `\n【🧩 この番の型（竹内さんの決定）】\n${hits.map((h) => `- ${h.line}`).join("\n")}`;
  if (text.length > PATTERN_NOTE_MAX) text = text.slice(0, PATTERN_NOTE_MAX - 1) + "…";
  return text;
}
