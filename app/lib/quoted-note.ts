// app/lib/quoted-note.ts
// 引用返信を「生成に渡す文」にする所だけを集めた純関数（DB を触らない＝テストが自己完結する）。
// DB から引用先を引くのは quoted-context.ts（この型を受け取る）。
//
// 2026-09-21 竹内「引用とあれば引用先の画像を読み取れるように。こっちが送った画像なら deepseek で
//   読み取れるようになってるはずなので、そこで読み取ってちゃんとした文を生成できるようにする」
import type { ImageKind } from "@/app/lib/property-image-read";

export type QuotedContext = {
  /** 引用したお客様の発言 */
  customerText: string;
  quotedSender: "staff" | "customer";
  /** 引用先の本文（中身の分からない画像なら null） */
  quotedText: string | null;
  isImage: boolean;
  /** 引用先の画像がスタッフの送った物件資料・見積書なら、その物件（「robot home 太子橋 101号室」）。分からなければ null */
  propertyLabel: string | null;
  /** 引用先がこちらの物件資料なら、そこに書いてある条件（読み取りの写し）。無ければ空 */
  detailLines: string[];
  /** 読み取った画像の種類（property / estimate / document / other）。読んでいなければ null */
  detailKind: ImageKind | null;
};

/**
 * 資料の読み取りを材料として渡す文。
 *
 * ⚠ ここは**入口**（材料を足す）で、本文を書き換える出口ではない。それでも守る線が3つある:
 *   ① 読み取りは誤読する（実測で住所・面積・礼金の誤読が出た）ので、**金額・住所・駅徒歩・面積は
 *      そもそも読み取りに入れていない**（property-image-read の PROPERTY_IMAGE_DETAIL_PROMPT）
 *   ② 資料に**書いてある事**は断定して答えてよい（スタッフの実送信は「はい！！別途駐車場費用が必要となります」
 *      のように即答している。資料を読む質問44件のうち、確認を挟まずに答えたのが33件＝75%）
 *   ③ 書いて**いない**事は作らない。「確認させて頂きます」で受ける（これが今までの正しい形）
 */
export function formatQuotedDetailBlock(lines: string[], propertyLabel: string | null): string {
  if (lines.length === 0) return "";
  const head = propertyLabel ? `お送りした資料（${propertyLabel}）に書いてある事` : "お送りした資料に書いてある事";
  return `【📄 ${head}（送った時の読み取り）】
${lines.map((l) => `・${l}`).join("\n")}
→ この中にお客様が聞いている事があれば、**確認を挟まずその場で答えてよい**（「はい！！〇〇となります😊！！」の形）。
→ 資料の書き方（記号・括弧・略語・「/」区切り）はそのまま写さず、お客様への言い方に直して書く。
→ 上に**無い**事は資料に書かれていない。作らずに「確認させて頂きます」で受ける。
→ 金額・初期費用・住所・駅徒歩・専有面積はここに載せていないので、本文に書かない（金額は御見積書で送る）。`;
}

/**
 * 引用先が何だったかの説明。
 * ⚠ 引用先が**お客様の送った画像**の時、messages.text は Vision の書き起こし（"[画像] <写っていた文字>"）で、
 *   これは**お客様の発言ではない**（設計知見「画像の読み取り文はお客様の発言ではない」）。
 *   そのまま「」で囲むと、広告のスクショに書いてある条件を本人が言ったように読まれる。
 */
export function describeQuotedTarget(q: QuotedContext): string {
  if (q.isImage) {
    return q.propertyLabel ? `【画像（こちらが送った物件資料・${q.propertyLabel}）】` : "【画像（スタッフ送付なら物件カード・物件資料の可能性が高い）】";
  }
  const t = (q.quotedText ?? "").trim();
  const m = t.match(/^\[(?:画像|動画)\]\s*([\s\S]*)$/);
  if (m) return `【画像（写っていた文字: ${m[1].replace(/\n/g, " ").slice(0, 200)}）※画像の読み取りであってお客様の発言ではない】`;
  return `「${t.slice(0, 600)}」`;
}

/**
 * 返信生成に入れる引用の説明（generate-reply）。
 * 旧 fetchQuotedContext（generate-reply の中）をここに移した。ブレイン・AIX・返信生成が
 * **同じ関数**で引用を見るようにするため（設計知見「四者同名」）。
 *
 * @param linkOrPhotoRequest お客様が URL・写真そのものを求めている（送るのは AIX の仕事）
 * @param estimateAllowed    費用の質問・物件の指名がある（引用画像だけで見積の宣言をさせない）
 */
export function buildQuotedReplyNote(
  q: QuotedContext | null,
  opts: { linkOrPhotoRequest: boolean; estimateAllowed: boolean },
): string {
  if (!q) return "";
  const senderLabel = q.quotedSender === "staff" ? "スモラ（スタッフ）" : "お客様自身";
  const contentDesc = describeQuotedTarget(q);
  const linkRequestNote = (opts.linkOrPhotoRequest && q.quotedSender === "staff")
    ? `
【🔗 リンク（URL）要求検出（最優先）】お客様はURLを求めていますが、URLの送付はAIXツール（物件ピックアップした）がスタッフ操作で行います。
【絶対禁止】返信文に「〜のURLとなります」「URLをお送りします」「リンクをご案内します」等、URLを送る・案内するような文言を一切書かない。
→ 返信文は受付・確認の一言のみ：「確認させて頂きます😊！！」「しばらくお待ちください！！」程度にとどめる（「少々お待ちください」はfinal-check禁止語のため絶対に使わない）。
→ 物件名・号室は書かない（「お送り頂きました物件」で受ける。URLも書かない。2026-09-11 竹内方針2）。
→ 「気になる物件のURLをお送りください」の聞き返しは絶対禁止。`
    : "";
  // 2026-09-08: 見積例文は顧客が費用を質問／特定物件を参照している時のみ出す（引用画像だけで見積宣言を誘導しない）
  // 2026-09-21: 「どの物件か分からないから名前を書くな」は**もう本当ではない**（記録で物件に直せている）。
  //   それでも名前を書かせないのは、**読み取った名前が誤っている事がある**から（実測: 実送信の「RISING Maison 本町橋」が
  //   「RIHGII Saison 3F田」、「スプランディッド堀江」が「スプラディッド郷正」として記録されていた）。
  //   スタッフの実送信でも、引用への返信で物件名を書くのは少数（直近120日133件）。
  const imageNameSuppressNote = q.isImage
    ? `
引用した画像の物件名は読み取りのため誤っている事がある。返信文に物件名・マンション名は書かないこと（${opts.estimateAllowed ? "「最大限割引した初期費用の御見積書をご用意します！！」" : "「お送り頂きましたお部屋の募集状況確認させて頂きます！！」"}のように物件名なしで返す${opts.estimateAllowed ? "" : "。お客様が費用を質問していないため見積書の宣言は書かない"}）。`
    : "";
  const detail = formatQuotedDetailBlock(q.detailLines, q.propertyLabel);
  return `
【💬 引用リプライ検出（確定事実・最優先文脈）】
お客様の最新メッセージは、${senderLabel}が送ったメッセージ ${contentDesc} への引用（リプライ）です。
お客様は引用先の内容について話している。引用先が物件画像・物件名・物件URLの場合、
その物件への興味として扱い、「気になる物件のURLをお送りください」等の聞き返しは絶対にせず、その物件を前提に返信を生成すること。
ただし内覧日程調整・空室確認の方向で返信するのは、当該物件が退去予定・入居中でない場合に限る。
退去予定・入居中の物件の場合は、現地内覧日程は提案せず「退去日以降のご案内」または「お申込みでお部屋を先に押さえてからのご内覧」を案内すること。${linkRequestNote}${imageNameSuppressNote}${detail ? `\n\n${detail}` : ""}`;
}

/** AIX に入れる引用の説明（どの物件の話か・短い形） */
export function formatQuotedContextBlock(q: QuotedContext | null): string {
  if (!q) return "";
  const who = q.quotedSender === "staff" ? "スタッフ（こちら）" : "お客様自身";
  const what = q.isImage && q.propertyLabel ? `物件資料・見積書の画像（${q.propertyLabel}）` : describeQuotedTarget(q);
  const detail = formatQuotedDetailBlock(q.detailLines, q.propertyLabel);
  return `【💬 引用返信（確定事実・どの物件の話かの最優先の手がかり）】
お客様の発言「${q.customerText.replace(/\n/g, " ").slice(0, 120)}」は、${who}が送った${what}への引用返信です。
${q.propertyLabel ? `「こちら」「この物件」「〇階」は ${q.propertyLabel}（と同じ建物）を指す。会話の他の物件（以前に紹介した物件・号室）と取り違えないこと。` : "「こちら」「この物件」は引用先の内容を指す。会話の他の物件と取り違えないこと。"}${detail ? `\n\n${detail}` : ""}`;
}
