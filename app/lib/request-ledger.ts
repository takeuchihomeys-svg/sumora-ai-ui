// app/lib/request-ledger.ts — お客様の連投の「やる事の一覧」（依頼・質問・確認事項を1つずつ）と、その後のこちらの送信での状態（純関数・DB も fetch も持たない）
//
// 2026-10-08 竹内さん「（連投の複数の依頼の取りこぼしは）直す必要がある、これを進める。Claude Code の読み込み方を参考にしたらできるかも。依頼ごと全て把握してるし」
//   ＋「お客さんからたくさんの確認事項を頼まれた場合のリストはどうなっているか、そこも表示されるようになるか」:
//   実物: W23（「カードブラックなので…厳しいかと💦」＋物件 URL 3件）・W51（「日時調整します。初期費用いくらになりますでしょつか？」＝費用を落とした）・
//   969f01（「ここと、ここの頭金おしえてほしいです」に「かしこまりました！！」だけ）・288d47（「見積もり出してもらえますか？あと海外にいて収入証明がない…審査通りますか？」の見積を落とした）。
//   → 連投の束（前のこちらの送信以降の全発言）を読んだら、まず依頼・質問・懸念を1つずつ数えて一覧にする（文の区切りと決まった言い方だけ＝推測しない）。
//     依頼ごとに 中身（お客様の言葉）・種類（費用・空き・内覧・審査・写真・探す・入居・設備・契約条件・その他）・道の目安（返信／約束／AIX）を持つ。
//   状態はこの後のこちらの送信（手打ち・AIX）から毎回組み立てる（保存しない＝ property-thread と同じ考え）:
//     未対応（open）→ 約束した（promised: 「確認させて頂きます」「お送りさせて頂きます」等でその種類に触れた）→ 完了（done: 答えた・AIX で結果を送った）。
//   確認事項は1つずつ別の行（line_tasks は会話×種類で pending が1件にまとまる一意の索引があるため、一覧は別に持つ）。
//   使い道: ①ブレイン「まだ答えていない確認事項」②返信の下書き（返信と約束の項目は全部に一言ずつ）③会話画面の約束のバナーに行で出す ④出口の確かめ（抜けた項目＝ログ・監査）。
//   戻す: REQUEST_LEDGER=off（ブレイン・返信の注記）／NEXT_PUBLIC_REQUEST_LEDGER=off（画面）
// テスト: app/lib/__tests__/request-ledger.test.ts（実物の連投）

export type RequestTopic = "cost" | "vacancy" | "viewing" | "screening" | "photo" | "pickup" | "move_in" | "equipment" | "contract" | "other";
export type RequestRoute = "reply" | "promise" | "aix";
export type RequestStatus = "open" | "promised" | "done";
export type RequestItem = {
  /** お客様の言葉（その文・60字まで） */
  quote: string;
  topic: RequestTopic;
  /** 道の目安（返信で答える／約束の返信→後で AIX／スタッフだけが知る＝AIX） */
  route: RequestRoute;
  /** 言った時刻（ISO・束の最初の通） */
  saidAt: string;
  /** 依頼・質問・懸念 */
  kind: "request" | "question" | "concern";
  /** 先の時期の相談（「来年あたりにその際再度相談させてもらってもいいですか？」）＝会話画面の帯には出すが、一覧の「確認事項 未対応」の数には入れない */
  deferred?: boolean;
};
export type LedgerItem = RequestItem & { status: RequestStatus; doneAt?: string | null; doneBy?: string | null };
export type LedgerMsg = { sender: string; text: string | null | undefined; createdAt: string; isAix?: boolean | null };

export const TOPIC_JA: Record<RequestTopic, string> = {
  cost: "費用・見積", vacancy: "空き・募集状況", viewing: "内覧", screening: "審査・保証", photo: "写真・動画",
  pickup: "物件を探す", move_in: "入居の時期", equipment: "設備", contract: "契約条件", other: "その他",
};
const TOPIC_RE: Array<[RequestTopic, RegExp]> = [
  ["screening", /審査|ブラック|保証人|滞納|在籍|夜職|収入証明|通(?:る|ら|り)(?:ます|そう|やす|にく)/],
  ["pickup", /(?:他|ほか|別)(?:に|の).{0,10}(?:物件|お部屋|部屋|ところ|とこ)|探して|ピックアップ|紹介して|(?:物件|お部屋|部屋)[^。\n]{0,8}出して(?:貰|もら|ほし|欲し)|(?:物件|お部屋|ところ|とこ)(?:は|って|が|も)?(?:あったり|ありますか|ありませんか|ないですか|無いですか|あったら|あれば)/],
  ["cost", /初期費用|費用|御?見積|頭金|いくら|金額|お値段|値下|安く(?:なり|でき|なら)|家賃.{0,6}(?:下が|安く)/],
  ["photo", /写真|動画|画像.{0,4}(?:もら|送|頂)/],
  ["viewing", /内覧|内見|見学|見に行|現地/],
  ["vacancy", /空(?:い|き)て|空室|空き状況|募集|まだ(?:あり|ある)|埋ま|取り?扱い|申込.{0,4}入っ/],
  ["move_in", /入居|引っ?越|いつから|最短/],
  ["equipment", /駐車場|駐輪|ペット|ネット|Wi-?Fi|エアコン|洗濯|設備|トイレ|温水|浴室|追い焚き|モニター|水道|オートロック|宅配|バス.?トイレ|風呂|キッチン|コンロ|畳|収納/],
  ["contract", /礼金|敷金|保証会社|管理会社|更新料|フリーレント|仲介手数料|契約/],
];
/** 依頼・質問の形（文の終わり・決まった言い方） */
const ASK_RE = /[？?]|(?:行き|見|伺い|内見し|内覧し)たいです|(?:ます|です|でしょう|ません|ません|ある|いける|行ける|できる|出来る)か(?:ね|な)?[。！!〜…\s]*$|教えて|おしえて|知りたい|欲しい|ほしい|頂け(?:ます|ません)|いただけ(?:ます|ません)|もらえ(?:ます|ません)|(?:可能|大丈夫)(?:です|でしょう)?か|ください|下さい|お願い(?:します|致します|いたします|できますか)/;
/** 懸念（審査が不安・高い 等）＝質問の形でなくても項目にする */
const CONCERN_RE = /厳しい|不安|心配|無理かも|難しいかも|通らない|高い(?:です|な|かも)/;
/** 依頼でも質問でもない定型（お礼・了承・締め） */
const FORMULA_ONLY_RE = /^(?:[^\n]{0,12}(?:さん|様))?(?:ありがとうございます|ありがとうございました|有難うございます|かしこまりました|承知(?:しました|いたしました|致しました)|了解(?:です|しました)?|わかりました|分かりました|よろしくお願い(?:します|致します|いたします)|宜しくお願い(?:します|致します)|お願いします|助かります|大丈夫です|はい)[！!。〜\s😊🙇🙏✨]*$/u;

function splitSentences(text: string): string[] {
  return String(text ?? "")
    .split(/\n+|(?<=[。！!？?])/)
    .map((s) => s.trim())
    .filter((s) => s && /[\p{L}\p{N}]/u.test(s) && !/^https?:\/\//.test(s) && !/^\[(?:画像|動画|スタンプ|ファイル|位置情報)/.test(s) && !/^by (?:SUUMO|LIFULL|HOME'S|athome)/i.test(s))
    // ポータルの画面の文字（「- 無料 最新の空室状況を知りたい」等のボタン）はお客様の依頼ではない
    .filter((s) => !/^[-・*]\s|無料|カンタン|お気に入り|お問い?合わせ(?:先|する)|ボタン|\(Check /.test(s));
}
function topicOf(s: string): RequestTopic {
  for (const [t, re] of TOPIC_RE) if (re.test(s)) return t;
  return "other";
}
/** 道の目安（返信で答えられる物／約束→AIX／スタッフだけが知る物）。最後に決めるのはブレイン（aix-catalog の順番） */
export function routeOf(topic: RequestTopic): RequestRoute {
  switch (topic) {
    case "cost": case "vacancy": case "pickup": case "photo": return "promise";
    case "viewing": return "aix";
    case "screening": case "move_in": case "other": return "reply";
    case "equipment": case "contract": return "promise"; // 資料にあれば返信（contract-terms / equipment-answer が先に答える）
  }
}

/**
 * 先の時期の相談（2026-10-08 竹内さん⑤「来年あたりにまた相談 等は確認事項 未対応のバッジの数に入れない（会話画面の帯だけ）」）。
 *   実物 7beca4f5 10/05「来年あたりを一旦考えていますので、その際再度相談させてもらってもいいですか？😭」
 */
//   「改めて見積書お願いします」「再度お願いします」は今の依頼＝当てない（先の時期の語＋相談・連絡の形だけ）
export const DEFERRED_RE = /(?:来年|再来年|来月|再来月|年明け|落ち着い(?:たら|て)|時期が(?:来|近づ)|その際|その時|またの機会)[^。\n]{0,24}(?:相談|連絡|お声がけ|探し(?:て|始め))/;

/** 束の文から依頼・質問・懸念を1つずつ（同じ種類が同じ束に2つあれば2行・ただし同じ言葉の重複は1つ）。申込の書類・条件のフォームは読まない */
export function splitRequests(bundle: ReadonlyArray<string>, saidAt: string): RequestItem[] {
  const out: RequestItem[] = [];
  const texts = bundle.map((t) => String(t ?? "").normalize("NFKC"));
  if (texts.some((t) => /①|【ご入居の時期】|生年月日|携帯番号|勤務先(?:名|所在地)|フリガナ/.test(t))) return out;
  // 物件の URL・画像（持ち込み）は束で1行（「この物件の募集状況と御見積書」が要る）
  const brought = texts.filter((t) => /https?:\/\//.test(t)).length + texts.filter((t) => /^\s*\[画像\][^\n]*(?:物件|賃料|家賃|間取り|SUUMO|ホームズ|アットホーム)/.test(t)).length;
  for (const t of texts) {
    // 画像・ファイルの書き起こし（ポータル・資料の画面の文字）は依頼ではない（物件の持ち込みとして上で数える）
    if (/^\s*\[(?:画像|動画|ファイル)\]/.test(t)) continue;
    for (const s of splitSentences(t)) {
      if (FORMULA_ONLY_RE.test(s)) continue;
      const isAsk = ASK_RE.test(s);
      const isConcern = !isAsk && CONCERN_RE.test(s);
      if (!isAsk && !isConcern) continue;
      const topic = topicOf(s);
      // 「よろしくお願いします」を含むだけの文・中身の種類が無いお願い（「お願いします🙇」）は項目にしない
      if (topic === "other" && !/[？?]|か[。！!]*$|教えて|おしえて|知りたい/.test(s)) continue;
      const quote = s.slice(0, 60);
      if (out.some((x) => x.quote === quote)) continue;
      out.push({ quote, topic, route: routeOf(topic), saidAt, kind: isConcern ? "concern" : /[？?]|か(?:ね|な)?[。！!〜…\s]*$/.test(s) ? "question" : "request", ...(DEFERRED_RE.test(s) ? { deferred: true } : {}) });
    }
  }
  if (brought > 0 && !out.some((x) => x.topic === "vacancy" || x.topic === "cost")) {
    out.push({ quote: `お送り頂いた物件（${brought}件）`, topic: "vacancy", route: "promise", saidAt, kind: "request" });
  }
  return out;
}

/** その種類に触れたか（こちらの文） */
const COVER_RE: Record<RequestTopic, RegExp> = {
  cost: /御?見積|お見積|初期費用|費用|[0-9,，]+円|割引|お安く/,
  vacancy: /募集|空室|空き|埋ま|お申込み?が入|現況|ご案内可能|確認させて|確認(?:でき|出来)次第/,
  viewing: /内覧|内見|ご案内|お日にち|日程|現地|お待ち合わせ/,
  screening: /審査|保証|通過|ブラック|お仕事面|サポートさせて/,
  photo: /写真|動画|撮影|室内|イメージ/,
  pickup: /ピックアップ|お探し|探させ|お調べ|新着|🌟|お部屋.{0,10}お送り/,
  move_in: /入居|お引越|引越し|[0-9]+月|[0-9]+日/,
  equipment: /駐車場|駐輪|ペット|ネット|エアコン|洗濯|設備|オートロック|宅配|バス|風呂|キッチン|コンロ|畳|収納|確認させて/,
  contract: /礼金|敷金|保証会社|管理会社|更新料|フリーレント|仲介手数料|契約|確認させて/,
  other: /./,
};
/** 設備・契約条件はお客様が聞いた語そのもの（駐車場とペットを1つの「設備」にまとめない）。他の種類は種類の語 */
const ITEM_WORD_RE = /駐車場|駐輪|ペット|ネット|Wi-?Fi|エアコン|洗濯|オートロック|宅配|バス.?トイレ|風呂|キッチン|コンロ|畳|収納|礼金|敷金|保証会社|管理会社|更新料|フリーレント|仲介手数料/g;
function coverReOf(x: RequestItem): RegExp {
  if (x.topic === "equipment" || x.topic === "contract") {
    const words = [...new Set(x.quote.normalize("NFKC").match(ITEM_WORD_RE) ?? [])];
    if (words.length) return new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"));
  }
  return COVER_RE[x.topic];
}
const PROMISE_RE = /(?:確認|お調べ|お探し|交渉|作成|撮影|ピックアップ)[^\n。！!]{0,12}(?:させて(?:頂|いただ)きます|致します|いたします)|(?:でき|出来)次第|お送りさせて(?:頂|いただ)きます|ご連絡させて(?:頂|いただ)きます/;
/** AIX の送信が結果を送ったか（約束ではなく答え） */
const RESULT_RE = /御見積書(?:と|を|になります|となります|同封)|お見積書(?:と|を|お送りさせていただきました)|募集中(?:と|で)|募集終了|現在募集|🌟|室内(?:写真|イメージ)|【お待ち合わせ場所】|直近ですと|ご案内(?:出来|でき|可能)/;

/**
 * 会話（古い順）から、直近 windowDays 日の連投の一覧と状態を組み立てる。
 *   状態: その束の後のこちらの送信を順に見て、種類に触れた手打ちの約束→promised・答え→done、AIX の結果→done。
 */
export function buildRequestLedger(msgs: ReadonlyArray<LedgerMsg>, nowMs: number, o: { windowDays?: number } = {}): LedgerItem[] {
  const win = (o.windowDays ?? 14) * 86_400_000;
  const sorted = [...msgs].filter((m) => Number.isFinite(Date.parse(m.createdAt))).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const out: LedgerItem[] = [];
  let i = 0;
  while (i < sorted.length) {
    if (sorted[i].sender !== "customer") { i++; continue; }
    let j = i; const bundle: string[] = [];
    while (j < sorted.length && sorted[j].sender === "customer") { bundle.push(String(sorted[j].text ?? "")); j++; }
    const saidAt = sorted[i].createdAt;
    if (nowMs - Date.parse(saidAt) <= win) {
      const items: LedgerItem[] = splitRequests(bundle, saidAt).map((x) => ({ ...x, status: "open" as RequestStatus, doneAt: null, doneBy: null }));
      for (let k = j; k < sorted.length && items.some((x) => x.status !== "done"); k++) {
        const m = sorted[k];
        if (m.sender === "customer") continue;
        const t = String(m.text ?? "").normalize("NFKC");
        if (!t.trim() || /^\[(?:画像|動画|スタンプ|ファイル)\]$/.test(t.trim())) continue;
        const sents = t.split(/\n+|(?<=[。！!？?])/).map((z) => z.trim()).filter(Boolean);
        for (const x of items) {
          if (x.status === "done") continue;
          if (x.topic === "other") { if (!m.isAix) { x.status = "done"; x.doneAt = m.createdAt; x.doneBy = "返信"; } continue; }
          const cover = coverReOf(x);
          const hit = sents.filter((z) => cover.test(z));
          if (!hit.length) continue;
          // その項目に触れた文が約束の形か（同じ通で別の項目に答えていても、この項目の文で見る）
          const hitText = hit.join("\n");
          // AIX は結果の形（御見積書・募集中・🌟…）なら約束の語があっても完了（「確認させて頂きました」の後の結果）
          const isResult = m.isAix ? RESULT_RE.test(hitText) || !PROMISE_RE.test(hitText) : !PROMISE_RE.test(hitText);
          if (isResult) { x.status = "done"; x.doneAt = m.createdAt; x.doneBy = m.isAix ? "AIX" : "返信"; }
          else if (x.status === "open") { x.status = "promised"; x.doneBy = m.isAix ? "AIX（約束）" : "約束の返信"; }
        }
      }
      out.push(...items);
    }
    i = j;
  }
  return out;
}

/** 今の束（最後のこちらの送信の後）の一覧だけ */
export function currentTurnRequests(msgs: ReadonlyArray<LedgerMsg>): RequestItem[] {
  const sorted = [...msgs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  let s = sorted.length; while (s > 0 && sorted[s - 1].sender === "customer") s--;
  if (s >= sorted.length) return [];
  return splitRequests(sorted.slice(s).map((m) => String(m.text ?? "")), sorted[s].createdAt);
}

export function requestLedgerEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.REQUEST_LEDGER ?? "").trim().toLowerCase() !== "off";
}

const ROUTE_JA: Record<RequestRoute, string> = { reply: "返信で答える", promise: "約束の返信→後で AIX（資料にあれば返信）", aix: "AIX" };
/**
 * ブレインに渡す注記: 今の束の一覧（2つ以上の時）＋前の束でまだ答えていない確認事項（未対応・約束済み）。無ければ空文字
 */
export function buildRequestLedgerNote(ledger: ReadonlyArray<LedgerItem>, current: ReadonlyArray<RequestItem>, o: { env?: Record<string, string | undefined> } = {}): string {
  if (!requestLedgerEnabled(o.env)) return "";
  const parts: string[] = [];
  if (current.length >= 2) {
    parts.push(`【お客様の依頼の一覧（今回の連投・${current.length}件・決定論で数えた）】\n${current.map((x, n) => `${n + 1}. ${TOPIC_JA[x.topic]}「${x.quote}」→ 目安: ${ROUTE_JA[x.route]}`).join("\n")}\n→ 全部の項目に道を付ける（返信で答える／約束の返信／AIX）。返信の下書きは返信と約束の項目に全部一言ずつ触れる（AIX の項目は約束の一文で受ける）。1つだけ答えて他を落とさない。`);
  }
  const curQuotes = new Set(current.map((x) => x.quote));
  const pending = ledger.filter((x) => x.status !== "done" && !curQuotes.has(x.quote) && x.topic !== "other");
  if (pending.length) {
    parts.push(`【まだ答えていない確認事項（前の連投・こちらの送信で結果を伝えていない物）】\n${pending.slice(0, 6).map((x) => `- ${TOPIC_JA[x.topic]}「${x.quote}」（${x.status === "promised" ? "約束済み・結果待ち" : "未対応"}）`).join("\n")}`);
  }
  return parts.join("\n\n");
}

/** 下書きが今の束の項目（返信・約束の道）に触れているか。触れていない項目を返す（出口の確かめ・ログ用。本文は書き換えない） */
export function uncoveredRequests(current: ReadonlyArray<RequestItem>, draft: string): RequestItem[] {
  const t = String(draft ?? "").normalize("NFKC");
  return current.filter((x) => x.topic !== "other" && !coverReOf(x).test(t) && !(x.topic === "vacancy" && /確認させて|確認(?:でき|出来)次第/.test(t)));
}

/**
 * 会話の一覧のバッジ「確認事項 未対応 N」（2026-10-08 竹内さん「それにする。今のお客さんから」）。
 *   会話ごとの発言（直近 windowDays 日・古い順でなくてよい）から、会話画面の帯と同じ buildRequestLedger の未対応（open）を数える。
 *   0 の会話は入れない。読む範囲（申込前・直近14日に発言がある会話）は呼ぶ側（/api/request-ledger/counts）が決める
 */
export function countOpenRequestsByConversation(
  rows: ReadonlyArray<{ conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated?: boolean | null }>,
  nowMs: number,
  o: { windowDays?: number } = {},
): Record<string, number> {
  const by = new Map<string, LedgerMsg[]>();
  for (const r of rows) {
    const arr = by.get(r.conversation_id) ?? [];
    arr.push({ sender: r.sender, text: r.text, createdAt: r.created_at, isAix: !!r.is_aix_generated });
    by.set(r.conversation_id, arr);
  }
  const out: Record<string, number> = {};
  for (const [id, msgs] of by) {
    // 先の時期の相談は数に入れない（会話画面の帯には出す）。戻す REQUEST_LEDGER_DEFERRED_BADGE=off
    const keepDeferred = (typeof process !== "undefined" ? process.env?.REQUEST_LEDGER_DEFERRED_BADGE ?? "" : "").toLowerCase() === "off";
    const n = buildRequestLedger(msgs, nowMs, o).filter((x) => x.status === "open" && (keepDeferred || !x.deferred)).length;
    if (n > 0) out[id] = n;
  }
  return out;
}

