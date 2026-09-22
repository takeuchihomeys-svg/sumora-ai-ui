// ブレインが掴んだ「今回の具体」を、場面の型が当たった時にも生成へ届ける（純関数・DB 依存なし）
//
// 2026-09-23 竹内「実際のスタッフの文の生成との間でブレインの部分にギャップがあると思うからそこも埋めたい」
//
// 【見つけたギャップ】generate-reply の effectiveReplyDirection は早い者勝ちの if-else で、
//   ブレインの reply_direction は 11番目（条件提示・内覧キャンセル・ネガ文脈・感謝返し・不安対応・
//   往復セル・AIX アクションが全部外れた時）にしか採用されない。
//   採用されなかった場合、ブレインの方向は**生成プロンプトに1文字も入らない**
//   （tpoGuidanceNote の「🎯 返信の方向性」だけが唯一の経路）。
//
// 【実測】scripts/audit-brain-generation-gap.ts（直近120日・ブレインの値が残る215件）
//   ・ブレインの方向がそのまま使われた 19.5% ／ **別物に差し替わった 56.3%** ／ ブレインが方向を出していない 24.2%
//   ・差し替わった121件で「スタッフの実送信はどちらに沿ったか」を内容語で比べると
//     ブレイン 37.2% ／ 生成 39.7% ／ どちらとも言えない 23.1% ＝ **ほぼ互角**。
//   ・実物を読むと理由が分かる: 型（生成）は「どう書くか」（開口語・構成・字数・禁止）を持ち、
//     ブレインは「何について書くか」（平野区・別保証会社・社員証の代替）を持っている。
//     実送信は**両方**を持っていた（「かしこまりました！！」＋「平野区も含めまして…ピックアップ」）。
//   → だから置き換えではなく**足し算**にする。型はそのまま、具体を1行足す。
//
// 【添えない場面】新しい提案をしてはいけないと型が言っている場面では添えない
//   （設計知見「同じ事実に『書け』と『書くな』を別の場所から渡さない — LLM はどちらも避けた第三の文を作る」）。
//   内覧キャンセル・断り・否決報告・強推し直後・感謝返し・一時保留・検討中がこれに当たる。

export type BrainSpecificInput = {
  /** ブレインの reply_direction（今回の発言についての判断） */
  brainDirection: string | null | undefined;
  /** 生成が実際に使う方向（型）。ここに既にブレインの方向が入っていれば足さない */
  effectiveDirection: string | null | undefined;
  /** ブレインの判断が今回の発言を見た新しい物か（既存の鮮度ゲートと同じ線。古い判断は足さない） */
  fresh: boolean;
  /** 新しい提案をしてはいけない場面か（内覧キャンセル・断り・強推し直後・感謝返し 等） */
  noNewProposalScene: boolean;
};

/** 方向が長すぎる時の上限（プロンプトを膨らませない。実測の中央値は40字弱） */
export const MAX_SPECIFIC_CHARS = 120;

/**
 * 中身がゼロの方向（足しても情報が増えない）。
 *
 * 2026-09-23 全件監査（scripts/audit-brain-specific-apply.ts）で見つけた:
 *   足す対象80件のうち22件（27.5%）は、実送信と内容語が**1語も重ならなかった**。
 *   その実物を読むと「物件提案を再開する」「新条件で物件提案を再開する」「物件提案を開始する」
 *   「条件に合う物件を提案する」＝**動詞だけの抽象文**で、型が既に言っていることと同じだった。
 *   一方「別保証会社の可否を確認し代替申込に備える」「日本橋1・2丁目エリアの物件を新規ピックアップする」は
 *   型が持っていない中身なので残す。
 * ⚠ だから線は「固有名詞や数値を含むか」ではなく、**この抽象文の形そのもの**にする
 *   （固有名詞で切ると「別保証会社の可否を確認」まで落ちる＝誤削除になる）。
 */
const EMPTY_DIRECTION_RE = /^(?:新条件で|新しい条件で|条件に合う|お客様の|ご希望の)*(?:物件|お部屋)(?:情報)?(?:を|の)?(?:提案|紹介|ご提案|ご紹介|ピックアップ)(?:を)?(?:再開|開始|継続|実施)?(?:する|します|進める)?$/;

/** 2つの方向が同じことを言っているか（粗く見る。二重に渡さないための判定なので甘めでよい） */
export function saysSameThing(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/[。、！!？?\s（）()「」]/g, "");
  const A = norm(a), B = norm(b);
  if (!A || !B) return false;
  if (A.includes(B) || B.includes(A)) return true;
  const grams = (s: string) => new Set(Array.from({ length: Math.max(s.length - 1, 0) }, (_, i) => s.slice(i, i + 2)));
  const ga = grams(A), gb = grams(B);
  if (ga.size === 0 || gb.size === 0) return false;
  let hit = 0; for (const g of ga) if (gb.has(g)) hit++;
  return (2 * hit) / (ga.size + gb.size) >= 0.6;
}

/**
 * 生成プロンプトの「場面と返信方針」に足す1行を作る。足す物が無ければ空文字。
 *
 * ⚠ 返すのは**中身の指定**であって、型（開口語・構成・字数・禁止）の指定ではない。
 *   ぶつかった時は型を優先すると同じ行で宣言する（優先順位を2か所に散らさない）。
 */
export function buildBrainSpecificNote(input: BrainSpecificInput): string {
  // A/B と巻き戻しのため環境変数で切れる（既定 on。止める時は BRAIN_SPECIFIC=off）
  if ((process.env.BRAIN_SPECIFIC ?? "on").trim().toLowerCase() === "off") return "";
  const d = (input.brainDirection ?? "").trim();
  if (!d) return "";
  // 動詞だけの抽象文は足さない（型が既に言っている＝情報が増えない。EMPTY_DIRECTION_RE の説明を見る）
  if (EMPTY_DIRECTION_RE.test(d)) return "";
  // 古い判断は足さない（effectiveReplyDirection 側の鮮度ゲートと同じ線に揃える）
  if (!input.fresh) return "";
  // 型が「新しい提案をしない」と言っている場面では足さない（書けと書くなを同時に渡さない）
  if (input.noNewProposalScene) return "";
  const eff = (input.effectiveDirection ?? "").trim();
  // 既に採用されている／同じことを言っているなら二重に渡さない
  if (eff && saysSameThing(d, eff)) return "";
  const body = d.length > MAX_SPECIFIC_CHARS ? `${d.slice(0, MAX_SPECIFIC_CHARS)}…` : d;
  return `- 🧠 今回ブレインが掴んだ中身: ${body}\n`
    + `  → 上の「返信の方向性」は**型**（開口語・構成・字数・禁止）として守り、この中身を本文で扱う内容にする。`
    + `型とぶつかる場合は型を優先し、この中身は書かない`;
}
