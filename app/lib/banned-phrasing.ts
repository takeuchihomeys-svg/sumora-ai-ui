// app/lib/banned-phrasing.ts
// 2026-09-11 竹内方針4・5（統合設計 §2 方針4・5）: 「承知しました」系と「すぐに」の唯一の定義。
//   ・承知いたしました／承知しました／承知致しました は使わない → 「かしこまりました」に置き換える（禁止は維持）
//   ・「すぐに」（約束の副詞）は使わない → 除去する（禁止は維持）
//   生成（few-shot 注入前）・後処理（validateAndClean の末尾）・修正版（final-check の修正ループ）・検査（HASTY_PROMISE）が
//   このファイルの正規表現と関数だけを見る（同じ事実を複数の段が別々に判定しない）。
//   依存ゼロ（他の app/lib/* を import しない）。
//
// 実データ（2026-09-11 測定）:
//   ・承知は正解の送信 11件中 8件が AI 下書き由来・7件は文中の形（「〜とのこと、承知いたしました」）。
//     スタッフは「〜の件かしこまりました」を 7通書いており、1通に「かしこまりました」が2回出るのは 984通中1通
//   ・下書きの「すぐに」はスタッフが 81件中 54件で削除。スタッフ送信 143通に除去を当てると 123通は文として成立し、20通は約束ではない

/** 承知系（文中も含め全て） */
export const SHOCHI_RE = /承知(?:いた|致)?しました/g;

/**
 * 約束の「すぐに／今すぐ」。否定先読みは必ず「に?」の前に置く
 * （後ろに置くと後戻りで「すぐにご入居」の「すぐ」だけが消えて「にご入居」に壊れる）。
 * 残すもの: 希少性の事実文（すぐに埋まる）、すぐにご入居（MOVEIN_DATE_ASSERTION の担当）、すぐにでも・すぐには、玄関入ってすぐ 等
 */
export const HASTY_ADVERB_RE =
  /(?:今)?すぐ(?!に?(?:は|でも|ご?入居|お?引(?:っ)?越|住|埋ま|決ま|なくな|無くな|快適|手前|近く|そば|横|裏))に?(?=(?:お送り|ご連絡|お知らせ|ピックアップ|ご案内|お調べ|確認|動|手配|ご手配|共有|ご提案|ご報告|ご紹介)|[^\n。！!？?]{0,20}?(?:させて(?:頂|いただ)き|いたし|致し|し)ます)/g;
/** 検査用（g なし・lastIndex を持たない） */
export const HASTY_ADVERB_TEST_RE = new RegExp(HASTY_ADVERB_RE.source);

const KASHIKO = "かしこまりました";
/** 行頭の単独「かしこまりました[😊😌]*[！!。、,]*」（対象の無い開口語） */
const HEAD_KASHIKO_RE = /^([ \t　]*)かしこまりました[😊😌]*[！!。、,]*[ \t　]*/;

/** 「承知〜しました」→「かしこまりました」。置換の結果、対象の無い行頭の開口語と文中の対象付きが両方あれば行頭側を削る */
export function normalizeShochi(text: string): { text: string; count: number } {
  const count = (text.match(SHOCHI_RE) ?? []).length;
  if (count === 0) return { text, count: 0 };
  let out = text.replace(SHOCHI_RE, KASHIKO);
  // 開口が「はい」の時は削除しない（はい＋かしこまりましたは受諾と受け止めの2つ）
  const opensWithHai = /^\s*(?:[^\n]{0,14}(?:さん|様)[、,\s]*)?はい/.test(out);
  if (!opensWithHai && (out.match(/かしこまりました/g) ?? []).length >= 2) {
    const lines = out.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = HEAD_KASHIKO_RE.exec(lines[i]);
      if (!m) continue;
      const remainder = lines[i].slice(m[0].length);
      // 文中で対象付きの「かしこまりました」（行頭以外の位置）が他に残る時だけ行頭側を削る
      const others = [...lines.slice(0, i), remainder, ...lines.slice(i + 1)];
      const hasInline = others.some((l) => l.trimStart().indexOf(KASHIKO) > 0);
      if (hasInline) {
        if (remainder.trim()) lines[i] = m[1] + remainder;
        else lines.splice(i, 1);
        out = lines.join("\n").replace(/^\n+/, "");
      }
      break;
    }
  }
  return { text: out, count };
}

/** 約束の「すぐに／今すぐ」を除去し、残った読点を整える */
export function stripHastyAdverb(text: string): { text: string; count: number } {
  const count = (text.match(HASTY_ADVERB_RE) ?? []).length;
  if (count === 0) return { text, count: 0 };
  const out = text
    .replace(HASTY_ADVERB_RE, "")
    .replace(/、{2,}/g, "、")
    .replace(/(^|\n)([ \t　]*)、/g, "$1$2");
  return { text: out, count };
}

/** 方針4・5の決定論置換（生成・後処理・修正版・few-shot 注入の共通入口） */
export function normalizeBannedPhrasing(text: string): { text: string; shochi: number; hasty: number } {
  const a = normalizeShochi(text);
  const b = stripHastyAdverb(a.text);
  return { text: b.text, shochi: a.count, hasty: b.count };
}
