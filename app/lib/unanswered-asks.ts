// app/lib/unanswered-asks.ts — 聞かれたのに答えていない事の照らし（純関数・LLM なし・#814・2026-11-27 作業員A）
//
// 竹内さんの決定 11/12（KB 6d457f12・P1）「こちらから送った部分と相手が送ってきた部分を照らし合わせ、まだ答えていない問い・まだ果たしていない約束を足りていない部分として持つ」。
//   その照らしの土台は exchange-ledger.ts（作業員4・CONDUCTOR_EXCHANGE_LEDGER）にある。ただしあちらの「お客様の問い」は
//   ①1通まるごとを1つの問いと見る ②後に AIX がどれか1つでもあれば答えたと見る ③言葉の重なりだけで答えたと見る、ので
//   「いくらですか」に物件の AIX が来ただけでも答えた扱いになる。ここは問いを文ごとに分け、問いの種類（費用・時期・空き・内覧・場所・手続き・物件）ごとに
//   「答えになっている材料」（金額・日付・空きの言葉・見積の AIX 等）が後のこちらの通にあるかで照らす。確認の約束で返した問いは「約束」として約束の台帳（promise-read）に任せる。
// 1行【まだ答えていない事】= 答え漏れ（前の番までの問い）＋ 果たしていない約束（promise-read.openPromises）。事実の一覧・道の言葉なし・決めるのはブレイン。
// スイッチ: UNANSWERED_ASKS_LINE=on（既定 off）。足した番だけ material_marks.unanswered（件数）。
// 今の番（最後のお客様の塊）の問いは入れない＝ブレインが今の一通として読む（exchange-ledger と同じ線）。

type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});
export const unansweredLineOn = (env: Env = envOf()) => (env.UNANSWERED_ASKS_LINE ?? "").trim().toLowerCase() === "on";

export type AskTopic = "cost" | "when" | "availability" | "viewing" | "place" | "procedure" | "property" | "other";
export const ASK_TOPIC_JA: Record<AskTopic, string> = { cost: "費用", when: "時期・日", availability: "空き・募集", viewing: "内覧", place: "場所", procedure: "手続き・審査", property: "物件の中身", other: "その他" };
export type Ask = { quote: string; topic: AskTopic; at: string };
// withdrawn＝お客様が後で取り消した・了承した（答えなくてよい）／stale＝何通も前の古い問い（1行には入れない・別に数える）
export type AskState = "answered" | "promised" | "open" | "withdrawn" | "stale";
export type AskMsg = { sender: string; text: string | null; created_at: string; is_aix_generated?: boolean | null };
export type AskAix = { aix_type: string; created_at: string; sent_at?: string | null };

const QUESTION_RE = /[?？]|ですか|ますか|でしょうか|ませんか|教えて(?:ください|下さい|頂|いただ)|知りたい|いくら|何(?:時|日|円|階|分|名|件)|いつ|どこ|どれ|どの(?:くらい|位|ぐらい)|どう(?:なり|です|でしょう|すれば)|可能(?:です)?か|できますか|出来ますか/;
// 問いの形でも答えを求めていない物（挨拶・お礼・こちらへの気遣い）
const NOT_ASK_RE = /^(?:お世話になって|ありがとう|よろしく|お疲れ|すみません|失礼)|お元気ですか|いかがお過ごし/;
const TOPIC_RE: Array<[AskTopic, RegExp]> = [
  ["cost", /いくら|費用|初期|家賃|賃料|金額|円|見積|安く|値下|値引|仲介手数料|敷金|礼金|管理費|共益費|更新料|お金/],
  ["availability", /空い|空き|空室|募集|まだあり|まだあります|残って|埋ま|申込(?:が)?入/],
  ["viewing", /内覧|内見|見学|見に行|見れ|見られ/],
  ["procedure", /審査|ブラック|名義|通る|通り(?:ます|やす|づら|にく)|書類|必要な(?:物|もの)|契約|手続|保証|在籍|身分証|住民票/],
  ["place", /どこ|場所|集合|住所|待ち合わせ/],
  ["when", /いつ|何日|何時|[0-9]+時|時半|[0-9]+日|曜日|日程|何曜|期間|どのくらい|どの位|どれくらい|何日前|入居日|入居可能/],
  ["property", /物件|お部屋|部屋|間取り|設備|ペット|駐車|駐輪|バス|トイレ|ネット|オートロック|洗濯|エアコン|日当|階|築|駅|徒歩/],
];
export function topicOf(q: string): AskTopic { for (const [k, re] of TOPIC_RE) if (re.test(q)) return k; return "other"; }

/** お客様の1通から問いの文だけ（文ごとに分ける） */
export function customerAsksOf(text: string | null | undefined, at: string): Ask[] {
  const t = String(text ?? "").normalize("NFKC").replace(/h\s*ttps?\s*:\s*\/\/[^\n]*/g, "").trim();
  if (!t || /^\[(?:画像|動画|スタンプ)\]$/.test(t)) return [];
  const sentences = t.split(/(?<=[。!?？！\n])/).map((s) => s.trim()).filter(Boolean);
  const out: Ask[] = [];
  for (const s of sentences) {
    if (s.length < 3 || NOT_ASK_RE.test(s) || !QUESTION_RE.test(s)) continue;
    out.push({ quote: s.slice(0, 60), topic: topicOf(s), at });
  }
  return out;
}

// 答えになっている材料（こちらの通の文）
const EVIDENCE: Record<AskTopic, RegExp> = {
  cost: /[0-9,]+円|[0-9.]+万|お見積|費用(?:は|が|として)|無料|かかりません|かからない|ゼロ|0円|ヶ月分/,
  when: /[0-9]+(?:月|日|時|日間|営業日|週間|ヶ月|か月)|明日|明後日|今週|来週|本日|今日|曜日|即入居|入居可/,
  availability: /空いて|空室|募集中|募集(?:が)?終了|募集(?:して)?おり|埋まって|申込(?:が)?入っ|ご紹介可能|ご紹介出来|まだ(?:ござい|あり)|終了して/,
  viewing: /内覧|内見|ご案内|見学|ご覧/,
  place: /集合|現地|住所|駅|改札|前で|お待ち(?:して|致)/,
  procedure: /審査|書類|身分証|保証会社|契約|在籍|住民票|源泉|必要(?:な|と)/,
  property: /./, // 物件の中身は言葉の重なりで見る（下の overlaps）
  other: /./,
};
const AIX_ANSWERS: Record<AskTopic, RegExp> = {
  cost: /estimate/,
  when: /viewing|schedule|move_in/,
  availability: /check_result|vacancy|property_check/,
  viewing: /viewing/,
  place: /viewing|meeting|access/,
  procedure: /apply|application|screening|document|guarantor/,
  property: /property_|check_result/,
  other: /$^/,
};
// はい・いいえで答える問い（「可能ですか」「行けますか」「ありますか」）と、その答えの言葉。答えはすぐ後のこちらの通に出る（竹内さんの「はい！！」）
const YESNO_ASK_RE = /可能(?:です)?か|できますか|出来ますか|いけますか|行けますか|大丈夫(?:です|でしょう)か|ありますか|あります(?:でしょう)?か|ございますか|難しい(?:です|でしょう)?か|でしょうか|ですかね|ますか/;
const YESNO_ANS_RE = /^(?:はい|いいえ|可能|大丈夫|出来|できま|行けま|いけま|ございま|ありま|難し|申し訳|残念)|可能です|大丈夫です|ご案内(?:出来|でき|可能)|難しい|出来かね|できかね|不可|ございません|ありません/; // 2026-11-27 目で読んだ20件: 「ありがとうございます」の「ございます」を答えと読んでいた（q070）ので外した // 「かしこまりました」「承知」は受け取りの言葉で答えではない（exchange-ledger の試験の型: ペットの問いに「かしこまりました！！家賃7万円で…」）
const PROMISE_RE = /確認(?:して|させて|致し|いたし|します|しま)|お調べ|調べて|お問い?合わせ|問い合わせ|折り返し|改めて(?:ご連絡|お送り|お伝え)|分かり次第|わかり次第|判明次第|確認が取れ次第/;
// 2026-11-27（統括役の頼み・当たり 38.9% の直し）: 電話・画像・動画で返した番は答えた扱い（竹内さんは文で答えずに電話の AIX・写真で返す）
const MEDIA_TOPICS: ReadonlySet<AskTopic> = new Set<AskTopic>(["cost", "availability", "property", "other"]);
// お客様が後で取り消した・了承した（「やっぱり大丈夫です」「分かりました」）＝答えなくてよい
const WITHDRAW_RE = /やっぱり(?:大丈夫|いい|なし|やめ)|^大丈夫です|結構です|キャンセル|取り消|取りやめ|なしで|やめ(?:ます|とき|てお)|見送|他社(?:で|に)?(?:決|契約)|決まりました|解決しました|分かりました|わかりました|了解(?:です|しました)|承知しました|理解しました/;
/** 何通も前の古い問いの線: 後にお客様の塊が2つ以上来た・こちらが4通以上送った */
export const STALE_CUSTOMER_BLOCKS = 2, STALE_OURS = 4;
// 重なりに数えない言葉: 挨拶・へりくだり＋どの通にも出る言葉（2026-11-27 目で読んだ20件: 「夜職なのですが可能ですか」に挨拶の通の「可能」で重なっていた q070）
const COURTESY = /させて|頂き|致し|お送り|ご確認|こちら|お世話|よろしく|ありがとう|ござい|でしょう|ですか|ますか|ください|下さい|いただ|教えて|^可能$|^大丈夫$|^確認$|^案内$|^物件$|^部屋$|^お部屋$|^連絡$|^ご連絡$|^担当$/;
const kw = (t: string) => (t.match(/[一-龠ァ-ヶー]{2,}/g) ?? []).filter((k) => !COURTESY.test(k));
const overlaps = (a: string, b: string) => kw(a).some((k) => b.includes(k));

/** 問い1つを、その後のこちらの通・AIX で照らす */
export function askStateOf(ask: Ask, laterOurs: ReadonlyArray<{ text: string }>, laterAix: ReadonlyArray<{ aix_type: string }>): AskState {
  if (laterAix.some((a) => AIX_ANSWERS[ask.topic].test(a.aix_type) || a.aix_type === "phone_call")) return "answered";
  // 2026-11-27 目で読んだ20件: 「[画像]」で答えた扱いが 8/20 で中身が読めない。画像が答えになる種類だけにする（時期・手続き・場所・内覧の問いは画像では答えた扱いにしない）。通話は種類を問わない
  if (laterOurs.slice(0, 2).some((m) => /\[通話リクエスト\]|電話をかける|お電話(?:させて|致し|いたし|でご説明|にて)/.test(String(m.text ?? "")))) return "answered";
  if (MEDIA_TOPICS.has(ask.topic) && laterOurs.slice(0, 2).some((m) => /\[画像\]|\[動画\]/.test(String(m.text ?? "")))) return "answered";
  // はい・いいえの問いは、すぐ後のこちらの通がはい・いいえの言葉で始まる／含む（約束だけの通は除く）なら答えた
  if (YESNO_ASK_RE.test(ask.quote) && laterOurs[0]) { const t0 = String(laterOurs[0].text ?? "").normalize("NFKC").trim().replace(/^(?:[^\n！!。]{0,12}(?:さん|様)[、,]?\s*)?(?:お世話になっております[！!。]*\s*)?(?:(?:ご連絡|ご返信)?(?:頂き|いただき)?ありがとうございます[😊！!。]*\s*)?/u, ""); if (YESNO_ANS_RE.test(t0) && !(PROMISE_RE.test(t0) && t0.length < 40)) return "answered"; }
  for (const m of laterOurs) {
    const t = String(m.text ?? "").normalize("NFKC");
    // 費用・時期・空きは答えの形（金額・日付・空きの言葉）があれば答えた。ほかは問いの言葉と重なる事も要る
    const ev = ask.topic === "property" || ask.topic === "other" ? overlaps(ask.quote, t)
      : EVIDENCE[ask.topic].test(t) && (ask.topic === "cost" || ask.topic === "when" || ask.topic === "availability" || overlaps(ask.quote, t));
    if (!ev) continue;
    // 「確認して改めてご連絡」は答えではなく約束。ただし金額・日付を書いた上での一言は答え
    const newNums = (t.match(/[0-9]+/g) ?? []).filter((n) => !ask.quote.normalize("NFKC").includes(n));
    if (!PROMISE_RE.test(t) || ((ask.topic === "cost" || ask.topic === "when") && newNums.length > 0)) return "answered";
  }
  if (laterOurs.some((m) => PROMISE_RE.test(String(m.text ?? "")))) return "promised";
  return "open";
}

export type OpenAsk = Ask & { state: AskState; oursAfter: number };
/** 前の番まで（最後のこちらの通より前）のお客様の問いを照らす。days 日まで・turns 個のお客様の塊まで */
export function unansweredAsks(o: { msgs: ReadonlyArray<AskMsg>; aix: ReadonlyArray<AskAix>; nowMs: number; days?: number; turns?: number }): OpenAsk[] {
  const sinceMs = o.nowMs - (o.days ?? 7) * 864e5, turns = o.turns ?? 4;
  const asc = [...o.msgs].filter((m) => { const t = Date.parse(m.created_at); return t <= o.nowMs && t >= sinceMs; }).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const lastStaffAt = [...asc].reverse().find((m) => m.sender === "staff")?.created_at ?? "";
  // 後ろからお客様の塊を数え、turns 個より前は見ない
  let blocks = 0, startAt = "";
  for (let i = asc.length - 1; i >= 0; i--) if (asc[i].sender === "customer" && (i === 0 || asc[i - 1].sender !== "customer")) { blocks++; if (blocks > turns) { startAt = asc[i].created_at; break; } }
  const out: OpenAsk[] = [];
  for (const m of asc) {
    if (m.sender !== "customer" || m.created_at >= lastStaffAt || (startAt && m.created_at <= startAt)) continue;
    for (const a of customerAsksOf(m.text, m.created_at)) {
      const laterOurs = asc.filter((x) => x.sender === "staff" && x.created_at > a.at).map((x) => ({ text: String(x.text ?? "") }));
      const laterAix = o.aix.filter((x) => (x.sent_at ?? x.created_at) > a.at && Date.parse(x.sent_at ?? x.created_at) <= o.nowMs);
      let state = askStateOf(a, laterOurs, laterAix);
      const firstOurAt = asc.find((x) => x.sender === "staff" && x.created_at > a.at)?.created_at ?? "";
      const laterCust = asc.filter((x, i) => x.sender === "customer" && x.created_at > a.at && (i === 0 || asc[i - 1].sender !== "customer"));
      if (state === "open" && firstOurAt && asc.some((x) => x.sender === "customer" && x.created_at > firstOurAt && WITHDRAW_RE.test(String(x.text ?? "").normalize("NFKC").trim()))) state = "withdrawn";
      if (state === "open" && (laterCust.length >= STALE_CUSTOMER_BLOCKS || laterOurs.length >= STALE_OURS)) state = "stale";
      out.push({ ...a, state, oursAfter: laterOurs.length });
    }
  }
  // 同じ種類の問いが続いたら新しい方だけ（「いくら？」「費用は？」の重ね）
  const latest = new Map<string, OpenAsk>();
  for (const x of out) latest.set(x.topic === "other" || x.topic === "property" ? x.quote : x.topic, x);
  return [...latest.values()];
}

const hm = (iso: string) => { const d = new Date(Date.parse(iso) + 9 * 36e5); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
export type OpenPromiseLike = { kindJa: string; sentence: string; at: string; overdue: boolean };
/** 【まだ答えていない事】の1行（事実の一覧・道の言葉なし）。何も無ければ空文字 */
export function unansweredLine(asks: ReadonlyArray<OpenAsk>, promises: ReadonlyArray<OpenPromiseLike>, max = 4): string {
  const open = asks.filter((a) => a.state === "open");
  const items = [
    ...open.map((a) => `お客様の問い（${ASK_TOPIC_JA[a.topic]}）「${a.quote.slice(0, 30)}」（${hm(a.at)}・その後こちらは${a.oursAfter}通）`),
    ...promises.map((p) => `こちらの約束（${p.kindJa}）「${p.sentence.slice(0, 26)}」（${hm(p.at)}${p.overdue ? "・期限を過ぎた" : ""}）`),
  ].slice(0, max);
  if (!items.length) return "";
  return `まだ答えていない事（前の番まで・事実の一覧。今の番で答えるか、AIX で送るか、まだ触れないかは決めるのはあなた）: ${items.join("／")}`;
}
