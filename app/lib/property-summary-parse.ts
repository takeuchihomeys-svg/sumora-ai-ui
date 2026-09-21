// app/lib/property-summary-parse.ts
// LINE に送る物件の説明文から、家賃などの数値を取り出す（純関数・DB 依存なし）。
//
// 2026-09-21 竹内「あとちゃんと物件を読み取ることできてるんかな？拡張ツールで物件検索するさい」
//
// ■ 実測（scripts/audit-extension-read-quality.ts・直近60日・物件21,134件）
//     物件名   100%（質 98.8%・「物件」という既定値が 1.1%）
//     間取り   96.4%（リアプロ）
//     AD       33.7%
//     **家賃    0.0%（リアプロ 20,854件中 0件）**
//     **徒歩    0.0%（1件も無い）**
//
// ■ なぜ家賃が 0% なのか
//   拡張（bulk-dl.js）は同じセルの文字を2つの場所で使っている:
//     buildPropertySummary … rentText を**そのまま**説明文に入れる → LINE には家賃が出ている
//     buildPropertyData    … `/(\d+)万/` で数値にする → **「58,000円」「¥58,000」に当たらない**
//   ＝ 「読み取れていない」のではなく「**数値にする所だけ**が万表記しか見ていない」。
//   だから LINE の表示にも、オススメ順の判定（説明文をそのまま LLM に渡している）にも家賃は効いている。
//   抜けているのは**構造化して残す側**だけ。
//
// ■ ここでやること
//   説明文は merge-pdfs に**そのまま届いている**ので、サーバー側で数値にして sent_properties に残す。
//   拡張を触らない＝再読み込みが要らない（設計知見「拡張の再読み込みを待たない」）。
//
// ■ ⚠ 実物の説明文を DB に持っていないので、形は bulk-dl.js の buildPropertySummary から起こした:
//     【N】物件名
//     （家賃のセルの文字そのまま）
//     （間取りのセルの文字そのまま）
//     敷Nヶ月 礼Nヶ月
//     （「徒歩」か「駅」を含むセルの文字そのまま）
//     AD Nヶ月
//   形が違っても壊れないように、**行の位置ではなく中身で探す**／**ありえない値は捨てる**。

/** 家賃として妥当な範囲（円）。外れた値は読み違いなので捨てる */
export const RENT_MIN = 20_000;
export const RENT_MAX = 500_000;

/**
 * 説明文から家賃（円）を取り出す。読めなければ null。
 *
 * 対応する書き方（拡張が拾うセルの文字がそのまま入っている）:
 *   「58,000円」「¥58,000」「5.8万円」「5.8万」「58000円」
 * ⚠ 1行に管理費が並ぶことがある（「58,000円 管理費5,000円」）ので**最初の金額**を採る。
 * ⚠ 物件名の行（1行目）は見ない。名前に数字が入る物件があるため。
 */
export function parseRentFromSummary(summary: string | null | undefined): number | null {
  const lines = String(summary ?? "").split("\n").slice(1);
  for (const line of lines) {
    const t = line.replace(/[，,]/g, "").replace(/[０-９．]/g, (c) =>
      c === "．" ? "." : String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    // 「5.8万」系を先に見る（「万」がある時は円より優先）
    const man = t.match(/(\d+(?:\.\d+)?)\s*万/);
    if (man) {
      const v = Math.round(parseFloat(man[1]) * 10_000);
      if (v >= RENT_MIN && v <= RENT_MAX) return v;
      continue;
    }
    const yen = t.match(/¥\s*(\d+)|(\d+)\s*円/);
    if (yen) {
      const v = parseInt(yen[1] ?? yen[2], 10);
      if (v >= RENT_MIN && v <= RENT_MAX) return v;
    }
  }
  return null;
}

/** 徒歩分数として妥当な範囲 */
export const WALK_MAX = 60;

/**
 * 説明文から徒歩分数を取り出す。読めなければ null。
 * ⚠ 拡張の buildPropertyData は「徒歩」を含むセルしか見ていないが、
 *   説明文の方は「徒歩」が無ければ「駅」を含むセルを入れているので、こちらの方が当たる。
 */
export function parseWalkMinutesFromSummary(summary: string | null | undefined): number | null {
  const t = String(summary ?? "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const m = t.match(/徒歩\s*(\d+)\s*分/);
  if (!m) return null;
  const v = parseInt(m[1], 10);
  return v > 0 && v <= WALK_MAX ? v : null;
}
