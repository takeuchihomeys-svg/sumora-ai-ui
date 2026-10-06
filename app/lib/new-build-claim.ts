// app/lib/new-build-claim.ts（純関数・DB/LLM なし）
// 「新築」と書いてよいのは新築で未入居の時だけ。築年が1年以上前と分かる「YYYY年M月築の新築」を「築浅」に直す（出口）・根拠の無い「新築」に注意（出口・注意だけ）。
//
// 2026-10-06 17:42 竹内（会話「ゆなまる」・AIX テンプレート「1件特にオススメする」→会話に合った文・aix_generate_log f87c0c12）:
//   生成文「ゆなまるさんこちらのお部屋如何でしょうか！！\n2025年5月築の新築、谷町四丁目まで乗り換え1回で通える立地となります😊！！」
//   「新築とは新築で未入居の場合、新築となる。今回の物件は新築ではない」
//   出所: 直前の物件オススメ（AIX・9d8391ed）は「・2025年5月築で築年数浅く」と正しく書いていた。会話を合わせる生成が「築年数浅く」を「新築」に言い換えた。
// ■ 実態（scripts/audit-new-build-claim.ts・スタッフの送信 365日）
//   「YYYY年M月築」の言い方は「で築年数浅く」167通・「の築浅物件」17通が主。「の新築」は 23通（うち AIX 以外の手打ちも 2024年築・2025年築に 11通）。
//   ＝スタッフも1年以上前の建物を「新築」と書いた事がある。竹内さんの決まり（未入居の時だけ）を正とし、AI の文で直す（人の送信は直さない）。
// ■ 決め（誤削除0の線）
//   - 直すのは「YYYY年M月築の新築」「YYYY年築の新築」の形だけ（築年が文の中にある＝本文だけで1年以上前と言い切れる）。
//     言い切れる線: 月まである時は基準日の年月との差が13か月以上（月末に建った場合でも12か月を超える）、年だけの時はその年の12月から13か月以上。
//     12か月以内（未入居か資料で分からない）は触らない。
//   - 語は「新築」→「築浅」。後ろに物件・マンション・アパート・の・のお部屋 が無い時は「築浅物件」（スタッフの「YYYY年M月築の築浅物件」17通の形）。
//   - 築年の無い「新築」は本文だけでは決められない → 呼び出し側が資料（新築・未入居の札）を持つ時だけ注意（findUnsupportedNewBuild）。

/** 基準日（JST）の年・月 */
function jstYm(nowMs: number): { y: number; m: number } {
  const d = new Date(nowMs + 9 * 3_600_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}

const CLAIM_RE = /((?:19|20)\d{2})年(?:([01]?\d)月)?築(?:の|で|、)?新築(物件|マンション|アパート|の|のお部屋|となり|です)?/g;

export type NewBuildFix = { text: string; fixed: Array<{ from: string; to: string; months: number }> };

/** 「YYYY年M月築の新築」で築年が13か月以上前の物を「築浅」に直す */
export function fixStaleNewBuildClaim(text: string, nowMs: number = Date.now()): NewBuildFix {
  const s = String(text ?? "");
  if (!s.includes("新築")) return { text: s, fixed: [] };
  const now = jstYm(nowMs);
  const fixed: NewBuildFix["fixed"] = [];
  const out = s.replace(CLAIM_RE, (all, ys: string, ms: string | undefined, tail: string | undefined) => {
    const y = parseInt(ys, 10);
    const m = ms ? parseInt(ms, 10) : 12;
    if (!(m >= 1 && m <= 12)) return all;
    const months = (now.y - y) * 12 + (now.m - m);
    if (months < 13) return all;
    const head = all.slice(0, all.indexOf("新築"));
    const suffix = tail ?? "";
    const word = /^(?:物件|マンション|アパート|の)/.test(suffix) ? "築浅" : "築浅物件";
    const to = `${head.replace(/(?:の|で|、)$/, "")}の${word}${suffix}`;
    fixed.push({ from: all, to, months });
    return to;
  });
  return { text: out, fixed };
}

/** 築年の無い「新築」（固有名詞「新築マンション〇〇」の様な物も含む）を本文が書いたか。資料が新築（未入居）でない時の注意に使う */
const BARE_NEW_RE = /新築(?!物件のみ|時|同様|当時)/;
export function findUnsupportedNewBuild(text: string, material: { newBuild: boolean | null; buildYm?: { y: number; m: number | null } | null }): string | null {
  const s = String(text ?? "");
  if (!BARE_NEW_RE.test(s)) return null;
  if (material.newBuild !== false) return null; // 資料が新築・分からない時は言わない
  return "「新築」と書いていますが、資料は新築（未入居）ではありません。築年が新しいだけなら「築浅」「YYYY年M月築で築年数浅く」にしてください";
}
