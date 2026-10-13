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
/**
 * 2026-10-13 竹内さん（ゆなまる）「ここの部分答えているのに、なぜか残り続けている。こちらから送った事は認識していないのか？」:
 *   直近30日の帯に残る項目（未対応 131・約束済み 11）を目で読み（scripts/audit-request-ledger-open-now.ts）、答え済みの取りこぼしの型だけ足した（cover v2）:
 *   ①種類の読み違い「他のところで見積もり…安くなる」は他社の話（探すではなく費用）・「もう少し候補見たいです」は探す
 *   ②答えの語の不足: 契約の段取り（申込・書類・本人確認）／審査（緊急連絡先・在籍・保護者・代理契約、審査を出しての依頼には「お申込み」）／
 *     探す（お部屋探し・ご紹介・ご説明）／駐車場（パーキング）
 *   ③結果の形: 御見積書（初期費用：N円・御見積書となります）は持ち込み・空き・費用の答え／「お送り頂きました〇〇…」の AIX は持ち込み・空きの答え／
 *     電話で済んだ（「先程はお電話ありがとうございました」）は前の項目を全部済み／種類の無い質問は直後の最初の AIX でも答え
 *   戻す: REQUEST_LEDGER_COVER_V2=off（サーバー）／NEXT_PUBLIC_REQUEST_LEDGER_COVER_V2=off（会話画面の帯）
 */
export function requestLedgerCoverV2On(): boolean {
  let v = "";
  try { v = `${process.env.NEXT_PUBLIC_REQUEST_LEDGER_COVER_V2 ?? ""}|${process.env.REQUEST_LEDGER_COVER_V2 ?? ""}`; } catch { v = ""; }
  return !/\boff\b/i.test(v);
}
const PICKUP_RE_V2 = /(?:他|ほか|別)(?:に|の).{0,10}(?:物件|お部屋|部屋|ところ(?!で)|とこ(?![ろで]))|探して|ピックアップ|紹介して|(?:物件|お部屋|部屋)[^。\n]{0,8}出して(?:貰|もら|ほし|欲し)|(?:物件|お部屋|ところ|とこ)(?:は|って|が|も)?(?:あったり|ありますか|ありませんか|ないですか|無いですか|あったら|あれば)|候補.{0,4}(?:見たい|欲しい|ほしい|ください|下さい|頂|いただ)/;
function topicOf(s: string): RequestTopic {
  const v2 = requestLedgerCoverV2On();
  for (const [t, re] of TOPIC_RE) if ((v2 && t === "pickup" ? PICKUP_RE_V2 : re).test(s)) return t;
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
/** cover v2: 聞かれた語の言い換え（スタッフの答えの語） */
//   礼金・仲介手数料・敷金の交渉の結果は語を繰り返さない（fecda03f「サウスパーク管理会社に交渉させていただきましたが…減額は考えていない」）
const NEGOTIATION_RESULT = "|減額|交渉させて(?:頂|いただ)きました";
const ITEM_WORD_ALIAS: Record<string, string> = { 駐車場: "駐車場|パーキング|お車", 礼金: `礼金${NEGOTIATION_RESULT}`, 仲介手数料: `仲介手数料${NEGOTIATION_RESULT}`, 敷金: `敷金${NEGOTIATION_RESULT}` };
/** 審査を出して・申込したい＝依頼（答えは「お申込みさせて頂きます」）。「申込通りますか」（通るかの質問）は当てない */
const APPLY_REQ_RE = /審査(?:を|も)?(?:掛|かけ|出し|だし|に出|お願い|して)|申(?:し)?込み?(?:したい|させて|お願い|して(?:ほし|欲し|もら|貰|いただ|頂))/;
function coverReOf(x: RequestItem): RegExp {
  const v2 = requestLedgerCoverV2On();
  const q = x.quote.normalize("NFKC");
  if (x.topic === "equipment" || x.topic === "contract") {
    const words = [...new Set(q.match(ITEM_WORD_RE) ?? [])];
    if (words.length) return new RegExp(words.map((w) => (v2 && ITEM_WORD_ALIAS[w]) || w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"));
  }
  if (!v2) return COVER_RE[x.topic];
  if (x.topic === "contract" && /契約|書類|必要な(?:もの|物)/.test(q)) return new RegExp(`${COVER_RE.contract.source}|お?申(?:し)?込|書類|本人確認|フォーマット|手続き`);
  if (x.topic === "screening") return new RegExp(`${COVER_RE.screening.source}|緊急連絡先|在籍|保護者|代理契約|連帯保証${APPLY_REQ_RE.test(q) ? "|お?申(?:し)?込" : ""}`);
  if (x.topic === "pickup") return new RegExp(`${COVER_RE.pickup.source}|お部屋探し|ご紹介|ご説明させて`);
  return COVER_RE[x.topic];
}
/** cover v2: 御見積書の結果（AIX の「初期費用：N円」・手打ちの「御見積書となります／お送りさせて頂きました」）＝持ち込み・空き・費用の答え */
const ESTIMATE_RESULT_RE = /初期費用[：:]\s*[0-9,，]+円|[御お]見積書(?:と|に)なります|[御お]見積書(?:を|も)?(?:同封|お送りさせて(?:頂|いただ)きました)/;
/** cover v2: 物件確認の結果の AIX（「お送り頂きました〇〇…確認させて頂き／募集／可能」） */
const PROPERTY_CHECK_RESULT_RE = /お送り(?:頂|いただ)きました[^\n]{0,40}(?:確認させて(?:頂|いただ)き|募集|可能|出来ない|できない|お部屋となります)|お送り(?:頂|いただ)きました[^\n]{0,40}\n[^\n]{0,60}(?:募集|可能|出来ない|できない|お部屋となります)/;
/** cover v2: 電話で済んだ（その前の項目は電話で答えた） */
//   会って話した（「本日お時間頂きありがとうございました」「本日はご内覧お越しいただきありがとうございました」）も同じ＝その場で答えた
const PHONE_DONE_RE = /お電話(?:頂き|いただき)?(?:誠に)?ありがとうございました|お電話にて(?:お伝え|ご説明|お話)させて(?:頂|いただ)きました|本日は?(?:お時間|ご内覧(?:お越し)?)(?:頂|いただ)き(?:誠に)?ありがとうございました/;
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
      const v2 = requestLedgerCoverV2On();
      let firstStaff = true;
      for (let k = j; k < sorted.length && items.some((x) => x.status !== "done"); k++) {
        const m = sorted[k];
        if (m.sender === "customer") continue;
        const t = String(m.text ?? "").normalize("NFKC");
        if (!t.trim() || /^\[(?:画像|動画|スタンプ|ファイル)\]$/.test(t.trim())) continue;
        const isFirst = firstStaff; firstStaff = false;
        const sents = t.split(/\n+|(?<=[。！!？?])/).map((z) => z.trim()).filter(Boolean);
        // cover v2: 電話・対面で済んだ → この束の残りは済み。ただし同じ通でその項目に約束の形で触れた物（「先ほどはお電話…管理会社に確認させていただきます」）は下の通常の判定（約束済み）
        if (v2 && !m.isAix && PHONE_DONE_RE.test(t)) {
          for (const x of items) {
            if (x.status === "done") continue;
            const hit = x.topic === "other" ? [] : sents.filter((z) => coverReOf(x).test(z));
            if (hit.length && PROMISE_RE.test(hit.join("\n"))) { if (x.status === "open") { x.status = "promised"; x.doneBy = "約束の返信"; } continue; }
            x.status = "done"; x.doneAt = m.createdAt; x.doneBy = "電話・対面";
          }
          continue;
        }
        // cover v2: 申込のフォーマット（【お申込者様記入欄】の項目の並び）は答えではない（a3cc571e「申込通りますかね?」が欄の「緊急連絡先」で済みになった）
        if (v2 && /【お申込者様記入欄】|^\s*①【/.test(t)) continue;
        const estimateResult = v2 && ESTIMATE_RESULT_RE.test(t);
        const checkResult = v2 && !!m.isAix && PROPERTY_CHECK_RESULT_RE.test(t);
        for (const x of items) {
          if (x.status === "done") continue;
          if (x.topic === "other") {
            if (!m.isAix || (v2 && isFirst && !/^\[通話リクエスト\]/.test(t.trim()))) { x.status = "done"; x.doneAt = m.createdAt; x.doneBy = m.isAix ? "AIX" : "返信"; }
            continue;
          }
          if ((estimateResult && (x.topic === "vacancy" || x.topic === "cost")) || (checkResult && x.topic === "vacancy")) {
            x.status = "done"; x.doneAt = m.createdAt; x.doneBy = m.isAix ? "AIX" : "返信"; continue;
          }
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
  o: { windowDays?: number; brainByConv?: Record<string, unknown> } = {},
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
    // 2026-10-13 P0「判断はすべてブレイン基準」: ブレインの判断（suggested_aix_meta.request_status）があればそれを使う（無い・古い所だけ決定論の網）
    const led = applyBrainRequestStatus(buildRequestLedger(msgs, nowMs, o), o.brainByConv?.[id], msgs);
    const n = led.filter((x) => x.status === "open" && (keepDeferred || !x.deferred)).length;
    if (n > 0) out[id] = n;
  }
  return out;
}


// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-13 竹内さんの決定（P0 絶対ルール 9eb6aa9c「判断はすべてブレイン基準。決定論の計算は候補を拾う網に下げ、済み・まだ・どの一手かはブレインが文を読んで決める」）:
//   確認事項の「済み／まだ／取り下げ」はブレインが毎回の判断の中で文を読んで決める（追加の LLM 呼び出しは無し・出力が少し増えるだけ）。
//   ここ（buildRequestLedger）は候補を拾う網＝候補の一覧と網の見立てを作るだけ。画面の帯・一覧のバッジはブレインの判断をそのまま使い、
//   ブレインの判断が無い項目・ブレインが「まだ」と言った後にこちらが送った項目だけ網の見立てを出す（applyBrainRequestStatus）。
//   戻す: REQUEST_STATUS_BRAIN=off（ブレインに聞かない）／NEXT_PUBLIC_REQUEST_STATUS_BRAIN=off（画面・バッジがブレインの判断を使わない）
// ─────────────────────────────────────────────────────────────────────────────
export type BrainRequestState = "done" | "promised" | "open" | "withdrawn";
export type BrainRequestStatusItem = { key: string; status: BrainRequestState; via: string | null };
/** suggested_aix_meta.request_status に保存する形。at＝ブレインが読んだ最後の通の時刻 */
export type BrainRequestStatus = { at: string; items: BrainRequestStatusItem[] };
export type RequestCandidate = { id: string; key: string; item: LedgerItem };

/** 候補の鍵（時刻は表記の揺れ「+00:00」「Z」をそろえる＝ブレインの保存と画面・バッジの読み込みで同じ鍵になる） */
export const requestKey = (x: Pick<RequestItem, "saidAt" | "quote">): string => {
  const t = Date.parse(x.saidAt);
  return `${Number.isFinite(t) ? new Date(t).toISOString() : x.saidAt}|${x.quote}`;
};

export function requestStatusBrainOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  // 10/13: 比べる試し（分かれた4件でブレイン3・網1／Claude は4件とも正しい）を受けて既定 on。REQUEST_STATUS_BRAIN=off で前の注記（網の「まだ答えていない確認事項」）
  return (env.REQUEST_STATUS_BRAIN ?? "").trim().toLowerCase() !== "off" && requestLedgerEnabled(env);
}
function requestStatusBrainUiOn(): boolean {
  let v = "";
  try { v = String(process.env.NEXT_PUBLIC_REQUEST_STATUS_BRAIN ?? ""); } catch { v = ""; }
  return v.trim().toLowerCase() !== "off";
}

/** ブレインに見せる候補（網が拾った依頼・質問・懸念。直近の物から最大 max 件・古い順に r1..）。網の見立ても添える（ブレインはそれを上書きしてよい） */
export function requestCandidatesForBrain(ledger: ReadonlyArray<LedgerItem>, o: { max?: number } = {}): RequestCandidate[] {
  const max = o.max ?? 10;
  const picked = [...ledger].sort((a, b) => Date.parse(a.saidAt) - Date.parse(b.saidAt)).slice(-max);
  return picked.map((item, n) => ({ id: `r${n + 1}`, key: requestKey(item), item }));
}

const NET_JA: Record<RequestStatus, string> = { open: "まだ", promised: "約束済み", done: "済み" };
/** ブレインの材料に足す一覧＋出力の指示（候補が無ければ空文字） */
export function buildRequestStatusAsk(cands: ReadonlyArray<RequestCandidate>): string {
  if (!cands.length) return "";
  const fmt = (iso: string) => { const d = new Date(Date.parse(iso) + 9 * 3600_000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
  return `【お客様の確認事項の候補（決定論の網が拾った物・状態はあなたが会話を読んで決める）】
${cands.map((c) => `${c.id}. ${fmt(c.item.saidAt)} ${TOPIC_JA[c.item.topic]}「${c.item.quote}」（網の見立て: ${NET_JA[c.item.status]}${c.item.doneBy ? `・${c.item.doneBy}` : ""}）`).join("\n")}
→ 出力の JSON に次の "request_status" を足す。鍵は r1〜r${cands.length} の ${cands.length} 個すべて（済みの物も省かない・鍵を消さない）。値は「状態|手段」（状態＝done/promised/open/withdrawn、手段＝返信/AIX/電話・対面/内覧の確定/取り下げ。open は手段なし）:
  "request_status": {${cands.map((c) => `"${c.id}": ""`).join(", ")}}
  - done＝こちらがその問いに答えた・結果を送った（手打ちの返信・AIX・電話や内覧の場で話した・内覧の日が決まった等、手段は問わない。言い回しが違っても中身で答えていれば done）
  - promised＝「確認させて頂きます」等の約束だけで、結果はまだ送っていない／open＝まだ触れていない／withdrawn＝お客様が「もう大丈夫です」等で取り下げた・別の流れで要らなくなった
  - 網の見立ては語の一致で作った目安。文を読んで違えば直す（網が「まだ」でも答えていれば done、網が「済み」でも別の話で触れただけなら open）`;
}

/** ブレインの出力を整える（候補に無い id・型の外れた値は落とす）。候補が無い・出力が無ければ null */
export function normalizeBrainRequestStatus(raw: unknown, cands: ReadonlyArray<RequestCandidate>, at: string): BrainRequestStatus | null {
  // 形は2つ受ける: 表 {"r1": "done|返信"}（今の指示）／並び [{id, status, via}]（前の指示）
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    raw = Object.entries(raw as Record<string, unknown>).map(([id, v]) => {
      if (v && typeof v === "object") return { id, ...(v as Record<string, unknown>) };
      const [status, via] = String(v ?? "").split(/[|｜]/).map((z) => z.trim());
      return { id, status, via: via ?? null };
    });
  }
  if (!cands.length || !Array.isArray(raw)) return null;
  const byId = new Map(cands.map((c) => [c.id, c.key]));
  const items: BrainRequestStatusItem[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    if (!r || typeof r !== "object") continue;
    const key = byId.get(String(r.id ?? "").trim());
    const st = String(r.status ?? "").trim().toLowerCase();
    if (!key || !["done", "promised", "open", "withdrawn"].includes(st) || items.some((x) => x.key === key)) continue;
    const via = typeof r.via === "string" && r.via.trim() && r.via.trim() !== "null" ? r.via.trim().slice(0, 12) : null;
    items.push({ key, status: st as BrainRequestState, via });
  }
  return items.length ? { at, items } : null;
}

function asBrainStatus(v: unknown): BrainRequestStatus | null {
  if (!v || typeof v !== "object") return null;
  const o = v as { at?: unknown; items?: unknown };
  if (typeof o.at !== "string" || !Array.isArray(o.items)) return null;
  return { at: o.at, items: (o.items as BrainRequestStatusItem[]).filter((x) => x && typeof x.key === "string" && typeof x.status === "string") };
}

/**
 * 網の一覧にブレインの判断を当てる（画面の帯・一覧のバッジ）。
 *   ・ブレインが判断した項目はブレインの状態（done/withdrawn＝済み・promised・open）
 *   ・ただしブレインが「済み」以外を言った後にこちら（スタッフ・AIX）が送っていたら、その送信はブレインがまだ読んでいない＝網の見立て（古い時だけ決定論）
 *   ・ブレインの判断が無い項目は網の見立て
 */
export function applyBrainRequestStatus(ledger: ReadonlyArray<LedgerItem>, brainRaw: unknown, msgs: ReadonlyArray<LedgerMsg>, o: { ui?: boolean } = {}): LedgerItem[] {
  const brain = asBrainStatus(brainRaw);
  if (!brain || (o.ui !== false && !requestStatusBrainUiOn())) return [...ledger];
  const at = Date.parse(brain.at);
  const staffAfter = Number.isFinite(at) && msgs.some((m) => m.sender !== "customer" && Date.parse(m.createdAt) > at && String(m.text ?? "").trim() && !/^\[(?:画像|動画|スタンプ|ファイル)\]$/.test(String(m.text ?? "").trim()));
  const by = new Map(brain.items.map((x) => [x.key, x]));
  return ledger.map((x) => {
    const b = by.get(requestKey(x));
    if (!b) return x;
    if (b.status === "done" || b.status === "withdrawn") return { ...x, status: "done" as RequestStatus, doneBy: `ブレイン:${b.via ?? (b.status === "withdrawn" ? "取り下げ" : "済み")}` };
    if (staffAfter) return x; // ブレインの「まだ」の後にこちらが送った＝その送信は網で見る
    return { ...x, status: b.status === "promised" ? "promised" as RequestStatus : "open" as RequestStatus, doneBy: b.status === "promised" ? "ブレイン:約束済み" : null };
  });
}
