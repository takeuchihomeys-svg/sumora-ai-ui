// app/lib/sent-shape.ts
// 実送信の「形」（締めに何卒を付けるか・改行の入れ方）を材料にする（純関数・DB 依存なし）。
//
// 2026-09-21 竹内:
//   「何卒よろしくお願い致します！！ で文終わる場面と、いれない場面あるから
//     そこの違いもちゃんと学習する違いを」
//   「文の改行している場所を実際の送っている文から特徴把握して改善する」
//
// ■ 実測（scripts/audit-opening-closing-newline.ts・直近180日・スタッフ実送信 12,093通）
//
//   【何卒よろしくお願い致します】全体 660/12,093 = 5.5%。場面でまったく違う:
//     64.3%  90/140   内覧の待ち合わせ（日時・場所が確定した連絡）
//     22.6% 168/743   ピックアップの約束
//      9.0%  99/1100  短い返し
//      8.5%  69/813   内覧の案内
//      6.8%  38/555   確認の約束
//      4.3%  17/399   見積書
//      3.7%  23/627   申込
//      1.3%  12/945   物件・書類の送付（ご査収）
//      0.2%   2/1132  物件カード
//      0.0%   0/4347  画像・URLのみ
//   入れる時は **86.1% が最終行**（本文の途中に置かない）。
//
//   【改行】全体: 行数の中央値 2行 ／ 1行の長さ 中央値 17字・上位25% 34字・上位10% 55字
//     2行以上の文の 66.3% が**空行で段落を分けている**。
//     場面別（行数 / 空行 / 1行の字数・すべて中央値）:
//       物件カード          9行 / 3 / 21字
//       内覧の待ち合わせ    5行 / 1 / 20字
//       見積書・ご査収      4行 / 1〜2 / 18〜20字
//       内覧の案内・確認・ピックアップ 3行 / 1 / 25〜33字
//       短い返し            2行 / 0 / 17字
//
// ■ 渡し方
//   設計知見「上書きの指示は最後に置く」「禁止にしてよいのは実送信がほぼ0の形だけ」に従い、
//   userPrompt の最後に**実測の数字そのもの**を渡す（「付けろ」「付けるな」とは書かない）。
//   0.0〜1.3% の場面だけは「付けない」と言い切ってよい（実送信がほぼ0だから）。

/** 返信の種類（実送信を数えた時とまったく同じ分け方＝四者同名） */
export type SentKind =
  | "画像・URLのみ" | "物件カード" | "見積書" | "物件・書類の送付（ご査収）"
  | "内覧の待ち合わせ" | "内覧の案内" | "ピックアップの約束" | "確認の約束"
  | "申込" | "短い返し" | "その他";

/**
 * 返信の種類を本文から決める。
 * ⚠ 監査（scripts/audit-opening-closing-newline.ts の kindOf）と**同じ順番・同じ条件**にすること。
 *   順番を変えると、下の率が測った物と違う母集団に当たる。
 */
export function classifySentKind(text: string | null | undefined): SentKind {
  const t = (text ?? "");
  if (/^\[画像\]|^https?:\/\//.test(t.trim())) return "画像・URLのみ";
  // ⚠ 見積書は物件カードより先に見る。見積書の本文は「【ハイツカトレア B 202号室】」で始まるので、
  //   物件カードを先に当てると見積書が全部そちらに入る（テスト K3 で気付いた）。
  if (/御見積書|初期費用：|初期費用さらに/.test(t)) return "見積書";
  if (/🌟|【[^】\n]{2,28}\s*[0-9０-９]{2,4}\s*号?室?】/u.test(t)) return "物件カード";
  if (/ご査収/.test(t)) return "物件・書類の送付（ご査収）";
  if (/現地エントランス|お待ち合わせ|集合場所/.test(t)) return "内覧の待ち合わせ";
  if (/ご案内させて(?:頂|いただ)き|ご内覧/.test(t)) return "内覧の案内";
  if (/ピックアップ(?:させて|し)/.test(t)) return "ピックアップの約束";
  if (/確認(?:させて|して|致し|いたし)/.test(t)) return "確認の約束";
  if (/お申込|申込フォーム|記入欄/.test(t)) return "申込";
  if (t.replace(/\s/g, "").length <= 60) return "短い返し";
  return "その他";
}

/** 実測の「何卒」率（%）。数字はそのままプロンプトに出す（根拠を隠さない） */
export const NANITOZO_RATE: Record<SentKind, number> = {
  "内覧の待ち合わせ": 64.3,   //  90/140
  "ピックアップの約束": 22.6, // 168/743
  "その他": 11.1,             // 143/1293
  "短い返し": 9.0,            //  99/1100
  "内覧の案内": 8.5,          //  69/813
  "確認の約束": 6.8,          //  38/555
  "申込": 3.7,                //  23/627
  "見積書": 2.0,              //  17/861
  "物件・書類の送付（ご査収）": 1.3, // 12/945
  "物件カード": 0.3,          //   2/671
  "画像・URLのみ": 0.0,       //   0/4347
};
/** 実送信がほぼ0＝「付けない」と言い切ってよい線（設計知見「禁止にしてよいのは実送信がほぼ0の形だけ」） */
export const NANITOZO_NEAR_ZERO = 2.0;
/** 入れるなら最終行（実測 86.1%） */
export const NANITOZO_LAST_LINE_RATE = 86.1;

/** 実測の改行の型（中央値） */
export type ShapeStat = { lines: number; blanks: number; lineChars: number };
export const SHAPE: Record<SentKind, ShapeStat> = {
  "物件カード": { lines: 11, blanks: 5, lineChars: 25 },
  "見積書": { lines: 6, blanks: 2, lineChars: 18 },
  "内覧の待ち合わせ": { lines: 5, blanks: 1, lineChars: 20 },
  "物件・書類の送付（ご査収）": { lines: 4, blanks: 2, lineChars: 18 },
  "内覧の案内": { lines: 3, blanks: 1, lineChars: 26 },
  "ピックアップの約束": { lines: 3, blanks: 1, lineChars: 33 },
  "確認の約束": { lines: 3, blanks: 1, lineChars: 25 },
  "申込": { lines: 3, blanks: 1, lineChars: 8 },
  "その他": { lines: 3, blanks: 1, lineChars: 21 },
  "短い返し": { lines: 2, blanks: 0, lineChars: 17 },
  "画像・URLのみ": { lines: 1, blanks: 0, lineChars: 4 },
};
/** 1行が長くなりすぎる線（実送信の上位10%＝55字。ここを超えたら切る場所を探す） */
export const LINE_CHARS_P90 = 55;
/** 2行以上の文で空行を使う割合（実測） */
export const BLANK_LINE_RATE = 66.3;

/**
 * これから書く返信の「形」を材料として渡す文。
 * 種類が決められない（本文がまだ無い）時は、これから書く内容の見込みを kind で受ける。
 *
 * ⚠ 「付けろ」「付けるな」とは書かない。**実測の数字を出して選ばせる**。
 *   実送信がほぼ0（2%未満）の場面だけ「付けない」と言い切る。
 */
export function buildSentShapeNote(kind: SentKind): string {
  const rate = NANITOZO_RATE[kind];
  const s = SHAPE[kind];
  const nanitozo = rate < NANITOZO_NEAR_ZERO
    ? `この場面の実送信で「何卒よろしくお願い致します」を付けるのは **${rate}%**（ほぼ0）。**付けない**。`
    : `この場面の実送信で「何卒よろしくお願い致します」を付けるのは **${rate}%**`
      + `（全体は5.5%。一番高いのは内覧の待ち合わせ64.3%、次がピックアップの約束22.6%）。`
      + `${rate >= 50 ? "付ける方が普通。" : "付けない方が普通。"}`
      + `付けるなら**最終行に1行**（実送信の86.1%が最終行。本文の途中に置かない）。`;
  return `\n\n【最後に確認：実送信の形に合わせる】この返信は「${kind}」。${nanitozo}`
    + `改行: 実送信の中央値は **${s.lines}行**`
    + `${s.blanks > 0 ? `・段落の区切りに空行を${s.blanks}つ` : "・空行なし"}`
    + `・1行 **${s.lineChars}字**前後。`
    + `1行が${LINE_CHARS_P90}字を超えたら、意味の切れ目（「〜となります」「〜ので」「〜ため」の後）で改行して分ける。`
    + `1文ずつ改行し、話題が変わる所で空行を入れる（2行以上の文の${BLANK_LINE_RATE}%が空行で段落を分けている）。`;
}

/**
 * 書く前（＝どの種類になるかまだ決まっていない時）に渡す材料。
 *
 * ⚠ 種類を当てにいかない。実測の表をそのまま渡して**モデルに選ばせる**。
 *   （書く前に種類を当てる関数を作ると、外れた時に間違った数字を渡すことになる。
 *     設計知見「汚れた材料は渡さない方がまし」）
 */
export function buildSentShapeNoteAll(): string {
  const order: SentKind[] = ["内覧の待ち合わせ", "ピックアップの約束", "短い返し", "内覧の案内", "確認の約束", "申込", "見積書", "物件・書類の送付（ご査収）", "物件カード"];
  const table = order.map((k) => `${k} ${NANITOZO_RATE[k]}%`).join(" ／ ");
  return `\n\n【最後に確認：実送信の形】`
    + `①「何卒よろしくお願い致します」は実送信 全体の5.5%しか付いていない。書こうとしている内容で決める: ${table}。`
    + `付けるなら**最終行に1行だけ**（実送信の86.1%が最終行。本文の途中に置かない）。`
    + `物件カード・ご査収・画像だけの送付には**付けない**（実送信ほぼ0）。`
    + `② 改行: 1行は **17字前後**（長くても${LINE_CHARS_P90}字）。1文ごとに改行する。`
    + `${LINE_CHARS_P90}字を超える行は意味の切れ目（「〜となります」「〜ので」「〜ため」の後）で分ける。`
    + `話題が変わる所は**空行**で段落を分ける（2行以上の実送信の${BLANK_LINE_RATE}%が空行を使っている）。`
    + `全体の行数は中央値2行・上位25%で4行（短い返しは2行・約束や案内は3行・見積書6行・物件カード11行）。`;
}

/** 出来上がった文が実測の形から外れていないか（検査だけ・本文は書き換えない） */
export type ShapeCheck = { kind: SentKind; lines: number; longLines: string[]; hasNanitozo: boolean; nanitozoAtEnd: boolean; rate: number };
export function checkSentShape(text: string | null | undefined): ShapeCheck {
  const t = (text ?? "").replace(/\r/g, "");
  const kind = classifySentKind(t);
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  const longLines = lines.filter((l) => l.replace(/\s/g, "").length > LINE_CHARS_P90);
  const re = /何卒(?:よろしく|宜しく)お願い(?:致します|いたします|します)/;
  const hasNanitozo = re.test(t);
  return {
    kind, lines: lines.length, longLines, hasNanitozo,
    nanitozoAtEnd: hasNanitozo && lines.length > 0 && re.test(lines[lines.length - 1]),
    rate: NANITOZO_RATE[kind],
  };
}
