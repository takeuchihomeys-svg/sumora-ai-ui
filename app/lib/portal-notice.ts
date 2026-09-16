// app/lib/portal-notice.ts
// ポータルサイト（SUUMO 以外はオトリ広告がある）について聞かれた時の説明（純関数・DB 依存なし）。
//
// 2026-09-16 竹内（YUYA 事例）「今回ニフティのことでお客さんから聞かれていた。
//   SUUMO以外のポータルサイトはオトリ広告等があるので、このような文を生成する。聞かれた場合」:
//   お客様 15:34「こちらの物件ニフティで価格更新(9/13付)されてたのですが、募集終わってるか専任物件でしょうか？」
//   → 19:35 こちら「お送り頂きました2件…現在募集に出ていないお部屋となっております！！」→ 19:37 お客様「そうですか。。ありがとうございます！」
//   → 19:38 スタッフ（手打ち）「ニフティ等のポータルサイトは終了したお部屋を、お客様ご来店頂く為のオトリ物件として掲載されている場合御座います！！…」
//   さらに 19:40 お客様「SUUMOかホームズで見るのがいちばんおとり物件がすくないですか？」→ 22:05「SUUMO、ホームズがオトリ物件が少ない…」
//
// 実データ（180日・「オトリ」を含む実送信4件）から、聞かれ方で2つの型に分かれる:
//   ①SUUMO 以外のポータルの物件が募集終了だった → オトリの説明＋SUUMO の掲載ルール＋「送って頂ければ確認します」
//   ②どのサイトを見ればよいか → SUUMO・ホームズを勧める
// 文はスタッフの実送信そのまま（創作させない。設計知見「受け止めの一文はスタッフ実文を差し込む」と同じ型）。

/** ポータルの呼び名（お客様の URL・本文から判定）。SUUMO・ホームズは「オトリが少ない」側 */
//   ※ 語の判定は URL を除いた本文に当てる（ニフティの URL に含まれる「homesf_」「suumof_」を
//     ホームズ・SUUMO と読み違えないため。お客様が使っているのはあくまでニフティ）
const PORTALS: ReadonlyArray<{ key: string; label: string; trusted: boolean; url: RegExp; word: RegExp }> = [
  { key: "suumo", label: "SUUMO", trusted: true, url: /suumo\.jp/i, word: /(?<![A-Za-z])SUUMO(?![A-Za-z])|スーモ/i },
  { key: "homes", label: "ホームズ", trusted: true, url: /homes\.co\.jp/i, word: /(?<![A-Za-z])HOME'?S(?![A-Za-z])|ホームズ|ライフル/i },
  { key: "nifty", label: "ニフティ", trusted: false, url: /myhome\.nifty\.com|nifty\.com/i, word: /ニフティ|(?<![A-Za-z])nifty(?![A-Za-z])/i },
  { key: "athome", label: "アットホーム", trusted: false, url: /athome\.co\.jp/i, word: /アットホーム|(?<![A-Za-z])at\s?home(?![A-Za-z])/i },
  { key: "pitat", label: "ピタットハウス", trusted: false, url: /pitat\.com/i, word: /ピタット/i },
  { key: "chintai_ex", label: "賃貸EX", trusted: false, url: /chintai-ex\.jp/i, word: /賃貸EX/i },
  { key: "canary", label: "カナリー", trusted: false, url: /canary-app\.jp|canary\.jp/i, word: /カナリー|(?<![A-Za-z])canary(?![A-Za-z])/i },
];
const stripUrls = (s: string) => s.replace(/https?:\/\/\S+/g, " ");

export type PortalNoticeKind = "otori_explain" | "which_site" | "none";
export type PortalNoticeVerdict = {
  kind: PortalNoticeKind;
  /** 文に入れるポータルの呼び名（「ニフティ」など。SUUMO 以外で一番新しく使われた物） */
  portalLabel: string | null;
  reason: string;
};

type Msg = { sender?: string | null; text?: string | null };

/** お客様がどのポータルを使っているか（新しい順・SUUMO 以外を優先して返す） */
export function detectCustomerPortals(messagesOldestFirst: ReadonlyArray<Msg>): { untrusted: string[]; trusted: string[] } {
  const untrusted: string[] = [];
  const trusted: string[] = [];
  for (const m of [...messagesOldestFirst].reverse()) {
    if (m.sender !== "customer") continue;
    const t = m.text ?? "";
    if (!t.trim()) continue;
    const body = stripUrls(t);
    for (const p of PORTALS) {
      if (!p.url.test(t) && !p.word.test(body)) continue;
      const bucket = p.trusted ? trusted : untrusted;
      if (!bucket.includes(p.label)) bucket.push(p.label);
    }
  }
  return { untrusted, trusted };
}

/** 「どのサイトを見ればよいか」の質問（SUUMO・ホームズが良いか） */
const WHICH_SITE_RE = /(?:どの|どこの|何の|どちらの)(?:サイト|アプリ|ポータル)|(?:サイト|アプリ|ポータル)[^\n]{0,10}(?:どれ|どこ|どちら|良い|いい|おすすめ|オススメ)|(?:で|が)?(?:見る|探す)(?:の)?(?:が)?(?:いちばん|一番|最も)/;
/** オトリ・掲載についての疑問（載っているのに募集終了・見落とし・専任・価格更新） */
const OTORI_DOUBT_RE = /オトリ|おとり|囮|見落と|載って(?:る|いる|ます)|掲載(?:されて|が|は|中|期間)|価格更新|更新(?:日|され)|専任(?:物件|媒介)?|即入居|まだ(?:出て|ある|あり)/;
/** 募集終了を伝えた（こちらの直前の発言） */
const UNAVAILABLE_TOLD_RE = /募集(?:に)?(?:出ていない|出ておりません|終了|されていない|しておりません)|埋まって|申込(?:が)?入って/;

/**
 * ポータルについて聞かれた場面か。
 *   which_site: 「SUUMOかホームズで見るのが一番オトリが少ないか」のような質問
 *   otori_explain: SUUMO 以外のポータルの物件について「載っているのに終了なのか」の疑問
 *     （こちらが募集終了を伝えた直後、お客様がお礼・受け止めだけの時も＝実送信はそこで補足している）
 */
export function resolvePortalQuestion(o: {
  customerText: string | null | undefined;
  messages?: ReadonlyArray<Msg>;
  /** 直前のこちらの発言（募集終了を伝えたか） */
  lastStaffText?: string | null;
}): PortalNoticeVerdict {
  const t = (o.customerText ?? "").trim();
  const portals = detectCustomerPortals(o.messages ?? []);
  const portalLabel = portals.untrusted[0] ?? null;
  if (!t) return { kind: "none", portalLabel, reason: "no_customer_text" };
  const mentionsPortal = PORTALS.some((p) => p.url.test(t) || p.word.test(stripUrls(t)));
  if (WHICH_SITE_RE.test(t) && (mentionsPortal || /オトリ|おとり|囮/.test(t))) {
    return { kind: "which_site", portalLabel, reason: "which_site_question" };
  }
  const toldUnavailable = UNAVAILABLE_TOLD_RE.test(o.lastStaffText ?? "");
  if (OTORI_DOUBT_RE.test(t) && (mentionsPortal || toldUnavailable)) {
    // SUUMO しか使っていない時はこの説明（SUUMO 以外はオトリ）に当たらない
    if (!portalLabel && !/オトリ|おとり|囮/.test(t)) return { kind: "none", portalLabel, reason: "suumo_only" };
    return { kind: "otori_explain", portalLabel, reason: toldUnavailable ? "doubt_after_unavailable" : "portal_doubt" };
  }
  return { kind: "none", portalLabel, reason: "no_signal" };
}

/** ①SUUMO 以外のポータルの物件が募集終了だった時の説明（スタッフの実送信そのまま・ポータル名だけ差し替え） */
export function buildOtoriExplain(portalLabel: string | null): string {
  const p = portalLabel ?? "ニフティ";
  return [
    `${p}等のポータルサイトは終了したお部屋を、お客様ご来店頂く為のオトリ物件として掲載されている場合御座います！！`,
    "SUUMOですと掲載のルールが厳しく、実際募集されている物件が掲載されております（2週間毎の更新となりますので掲載終了している場合御座います）",
    "",
    `${p}等で募集されているお部屋もお送り頂きますと、募集状況確認させて頂きますので、お気軽にお送りの程よろしくお願い致します😌！！`,
  ].join("\n");
}
/** ②どのサイトを見ればよいかの質問への回答（スタッフの実送信そのまま） */
export const WHICH_SITE_ANSWER = [
  "SUUMO、ホームズがオトリ物件が少ないポータルサイトとなります！！",
  "それ以外のポータルサイトではオトリ物件や、募集終了しているお部屋がそのまま掲載されている可能性が高いです。",
  "SUUMOが最もオトリ物件が少ないので、SUUMOでお部屋を見て頂くを推奨させて頂きます😊！！",
].join("\n");

/** 既にその主旨が書かれているか（二重に足さない） */
const NOTICE_PRESENT_RE = /オトリ|おとり物件|掲載のルール|ポータルサイト/;

/**
 * 生成した返信にポータルの説明を足す（無ければ足す・あれば触らない）。
 * 説明はスタッフの実送信そのままなので、LLM に書かせず決定論で入れる。
 */
export function ensurePortalNotice(text: string, verdict: PortalNoticeVerdict): string {
  const t = (text ?? "").trim();
  if (verdict.kind === "none") return text ?? "";
  if (NOTICE_PRESENT_RE.test(t)) return text ?? "";
  const notice = verdict.kind === "which_site" ? WHICH_SITE_ANSWER : buildOtoriExplain(verdict.portalLabel);
  if (!t) return notice;
  return `${t}\n\n${notice}`;
}
