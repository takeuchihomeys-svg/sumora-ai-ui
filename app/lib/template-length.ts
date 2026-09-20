// app/lib/template-length.ts
// AIX テンプレート（AIX の直後に送る2通目）の長さの目安（純関数・実測が根拠）。
//
// 2026-09-20 竹内「AIX テンプレートで、この会話に合った文を生成ボタン押した際に生成される文が長すぎる。
//   実際の成約データや直近の会話をみて改善する」
//   実物（和樹さん・21:21）: 「お送りさせて頂きましたお部屋の中でもジーメゾン泉大津ペルファットが特に
//   和樹さんにオススメのお部屋となります！！／ペット2匹飼育可能となります😊！！／和樹さん達がお気に召された
//   お部屋ご内覧させて頂きますのでお気軽にお申し付けください😌！！」＝ **約100字・4行**
//
// ■ 実測（scripts/audit-template-length.ts・直近120日）
//   生成 vs 実送信（AIX 由来 1,238組）: 全体では 128字 → 128字 で同じだが、**経路別に差がある**:
//     property_recommendation（AIX 本体）201組  生成 **257字** → 実送信 234字
//     property_recommendation（テンプレ）  28組  生成 **190字** → 実送信 175字
//     property_send_widen                 47組  生成 **170字** → 実送信 **112字**（-58字）
//     property_check_result_unavailable   15組  生成 121字 → 実送信 **90字**
//   実送信の2通目 1,419通: 中央値 **120字・4行**
//   **成約した会話の2通目 114通: 中央値 108字・3行**（25% 65 / 75% 140）
//   長さの分布: 0〜60字 19.2% ／ 60〜100字 16.0% ／ **100〜140字 34.3%（最頻）** ／
//               140〜180字 8.3% ／ 180〜240字 6.3% ／ 240字〜 15.8%
//   ＝ **140字未満が69.5%**。
//
// ■ 決めた線
//   目安 100〜140字（最頻の帯・成約データの中央値108字を含む）／上限 180字（実送信の83.8%が収まる）。
//   長い方の裾（240字〜15.8%）は物件を何件も並べる通で、テンプレートの2通目が真似する形ではない
//   （竹内さんが「長すぎる」と言っているのはまさにこの裾に寄っている状態）。
//
// ■ 例外
//   フォームを丸ごと送る種類（条件ヒアリングのフォーム・申込フォーマット）は行数も字数も別物なので
//   長さを縛らない（実測: condition_hearing 中央値113字だが9行・application_push_format 230字）。

/** 長さを縛らない AIX（フォーム・定型の全文を送る物） */
export const LENGTH_FREE_ACTIONS: ReadonlySet<string> = new Set([
  "condition_hearing",          // 条件ヒアリングフォーム（①〜⑧の全文・実測9行）
  "application_push_format",    // 申込フォーマット（記入欄の全文・実測230字）
  "application_format",
  "document_request",
]);

export type LengthGuide = { min: number; target: number; max: number; lines: string };

/** 実送信の分布から決めた目安（全 AIX 共通。種類ごとに散らさないのは「1つの線の方が守られる」ため） */
export const TEMPLATE_LENGTH_GUIDE: LengthGuide = { min: 100, target: 140, max: 180, lines: "3〜5行" };

/** その AIX で長さを縛るか */
export function isLengthGuided(action: string | null | undefined): boolean {
  const a = (action ?? "").trim();
  if (!a) return true; // 種類が分からない時は縛る（長い方に倒さない）
  if (LENGTH_FREE_ACTIONS.has(a)) return false;
  for (const k of LENGTH_FREE_ACTIONS) if (a.startsWith(`${k}_`)) return false;
  return true;
}

/**
 * プロンプトに入れる長さの指示。縛らない種類なら空文字。
 * 設計知見「LLM 呼び出しの出口の型: 長さの上限をプロンプトに書く」。
 */
export function buildLengthNote(action: string | null | undefined): string {
  if (!isLengthGuided(action)) return "";
  const g = TEMPLATE_LENGTH_GUIDE;
  return `【長さ（最優先・実送信の実測）】${g.min}〜${g.target}字・${g.lines}に収める。**${g.max}字を超えたら書き直す**。`
    + `スタッフの実送信2通目は中央値120字・4行、**成約した会話では中央値108字・3行**で、140字未満が69.5%。`
    + `言いたいことを足すのではなく、1通目で済んだことを省いて**次の一歩1つ**だけを書く。`
    + `オススメポイントを箇条書きで並べ直さない（それは1通目の役目）。`;
}

/** 生成後の点検（出口ではなく記録用。長さで本文を切ると文が壊れるので切らない） */
export function checkLength(text: string, action: string | null | undefined): { ok: boolean; len: number; lines: number; over: number } {
  const len = text.length;
  const ln = text.split("\n").filter((x) => x.trim()).length;
  if (!isLengthGuided(action)) return { ok: true, len, lines: ln, over: 0 };
  const over = Math.max(0, len - TEMPLATE_LENGTH_GUIDE.max);
  return { ok: over === 0, len, lines: ln, over };
}
